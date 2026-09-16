// Offline Reader — the natural-voice worker. See docs/ARCHITECTURE.md §2.14
// and js/novel-voice.js ("Neural engine").
//
// This worker owns the Kokoro model so synthesis never blocks the reader's
// main thread — pagination, scrolling and the highlight all keep their frame
// budget while a sentence renders. It is spawned only when a reader enables
// the Natural voice, and terminated when the reader closes, because a loaded
// model holds hundreds of megabytes of working memory that a person browsing
// their library should not be paying for.
//
// Protocol (all messages are plain objects with a `type`):
//   in:  { type:'init', model, device:'wasm'|'webgpu', dtype, voices:string[],
//                        heapPages:number[], native:boolean }
//   in:  { type:'generate', id, text, voice }
//   in:  { type:'cancel', preserveId? }     — drop everything else not yet started
//   out: { type:'source', local:boolean }   — bundled weights, or a download
//   out: { type:'stage', stage:string }     — where init has got to
//   out: { type:'note', stage, message }    — something escaped; NOT a verdict
//   out: { type:'progress', file, loaded, total }   — model download
//   out: { type:'ready', heapPages, native } | { type:'init-error', message }
//   out: { type:'infer', id, ids, style, speed }   — native forward pass
//   in:  { type:'infer-result', id, pcm } | { type:'infer-error', id, message }
//   out: { type:'audio', id, wav:ArrayBuffer, seconds, ms, chars }  (wav transferred)
//   out: { type:'error', id, message }
//
// Generation is strictly one at a time: the model is not reentrant, and a
// serial queue is what lets 'cancel' actually mean something.

'use strict';

let tts = null;
let queue = [];
let running = false;

// The vendored engine (see vendor/tts/README.md). Imported lazily inside
// init so a worker that fails to spawn costs nothing, and so the 2 MB parse
// happens after we have told the main thread we exist.
function loadEngine() {
  return import(new URL('../vendor/tts/kokoro.web.js', self.location.href).href);
}

// ── Cap the engine's address-space reservation ───────────────────────────────
//
// emscripten's glue creates the heap with a hardcoded
// `new WebAssembly.Memory({initial: 256, maximum: 65536, shared: true})`:
// 16 MB of real pages behind a 4 GB reservation. A shared memory can never be
// relocated, so that maximum is reserved as contiguous address space the
// moment it is created, and iOS refuses it. The throw happens inside the
// engine's init, where nothing is reported and nothing is retried, which is
// how a tap on Listen turned into "Preparing the narrator" forever.
//
// A smaller maximum links against the same binary: the import asks for at
// least 256 pages and at most 65536, so any maximum inside that range is a
// valid link. Kokoro at q8 never comes close to a gigabyte.
//
// So the constructor is wrapped rather than vendor/ being edited, because
// vendored code is not ours to edit and this is our decision to make. Only
// the engine's own oversized shared request is touched; everything else is
// passed straight through untouched.
// ── Async-iterate a ReadableStream, where the engine assumes it can ──────────
//
// kokoro-js unpacks the eSpeak phonemiser's dictionary like this:
//
//   A = new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip"));
//   for await (const e of A) t.push(e);
//
// `for await … of` needs Symbol.asyncIterator on ReadableStream. Where WebKit
// does not define it, the loop calls an undefined iterator method, which
// JavaScriptCore reports as "undefined is not a function (near '...e of A...')"
// — a message a reader of this app sent in from an iPhone.
//
// The cost is not one failed decompression. That loop sits inside an async IIFE
// whose only job is to resolve the promise every generate() waits on for its
// phonemes, so a throw there leaves that promise pending for the life of the
// worker: no error, no rejection, just a voice that never says anything.
//
// Installed only when missing, and only ever additive: a reader-and-adapter
// over the stream's own reader, which is what the specified behaviour is.
function polyfillStreamAsyncIterator() {
  if (typeof ReadableStream === 'undefined') return false;
  if (ReadableStream.prototype[Symbol.asyncIterator]) return false;
  ReadableStream.prototype[Symbol.asyncIterator] = function () {
    const reader = this.getReader();
    return {
      next: function () { return reader.read(); },
      return: function (value) {
        reader.releaseLock();
        return Promise.resolve({ value: value, done: true });
      },
      throw: function (e) {
        reader.releaseLock();
        return Promise.reject(e);
      },
      [Symbol.asyncIterator]: function () { return this; },
    };
  };
  return true;
}

function capWasmMemory(pages) {
  const Native = WebAssembly.Memory;
  if (Native.__orCapped) return;              // a second init must not re-wrap
  let granted = 0;

  function Capped(desc) {
    const d = desc || {};
    // Not the engine's heap: hand it to the real constructor unchanged.
    if (!d.shared || !(d.maximum > pages[pages.length - 1])) return new Native(d);
    let lastErr = null;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i] > d.maximum) continue;      // never widen what was asked for
      try {
        const mem = new Native({ initial: d.initial, maximum: pages[i], shared: true });
        granted = pages[i];
        return mem;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new RangeError('no shared WebAssembly memory could be reserved');
  }

  Capped.prototype = Native.prototype;        // instanceof keeps working
  Capped.__orCapped = true;
  WebAssembly.Memory = Capped;
  return function () { return granted; };
}

function post(msg, transfer) {
  try { self.postMessage(msg, transfer || []); } catch (e) { /* worker torn down */ }
}

// ── Where did it get to? ─────────────────────────────────────────────────────
//
// Two rounds of this bug were spent inferring a mechanism from a screenshot of
// a progress label, and both inferences were wrong. A hang that cannot say
// where it hung costs a rebuild per guess.
//
// So every step of init announces itself. If the engine stops, the last stage
// posted is the step it stopped ON, and that is a location rather than a
// theory. The main thread shows it verbatim.
let stage = 'spawned';
function mark(name) {
  stage = name;
  post({ type: 'stage', stage: name });
}

// Announced at top-level evaluation, before anything can go wrong. Its absence
// is itself the finding: a module worker that never evaluates (the constructor
// resolved, the module did not load) is a different bug from one that hangs
// inside init, and without this they look identical from the main thread.
mark('worker alive');

// An exception that escapes init's try/catch — thrown from a wasm callback, an
// unawaited promise, an emscripten abort handler — used to leave the UI on
// "Preparing the narrator" with nothing said. These two make it speak.
//
// They report and they do NOT decide. An earlier version posted 'init-error'
// from here, which the main thread treats as fatal, and that killed sessions
// whose engine was working: the vendored bundle rejects a promise or two in
// the background that it handles perfectly well itself, and a listener has no
// way to tell those from a real failure. It also mislabelled them, because
// `stage` is wherever init happens to have got to when an unrelated background
// rejection surfaces — "at looking for bundled weights: undefined is not a
// function" came from a step whose only fetch is inside a try/catch that
// cannot throw.
//
// Init's own try/catch is what fails a load, because it is the only thing here
// that knows the load actually failed. These leave a note.
function note(what) {
  post({ type: 'note', stage: stage, message: String(what).slice(0, 160) });
}
self.addEventListener('error', function (e) {
  note((e && (e.message || (e.error && e.error.message))) || 'worker error');
});
self.addEventListener('unhandledrejection', function (e) {
  const r = e && e.reason;
  note((r && (r.message || r)) || 'unhandled rejection');
});

// Where bundled weights live, if the build has them (scripts/fetch-voice-model.mjs).
// transformers.js resolves a local file as localModelPath + model_id + filename,
// so the tree under here mirrors the Hugging Face repo layout exactly.
function localModelsBase() {
  return new URL('../vendor/tts/models/', self.location.href).href;
}

// kokoro-js hardcodes its voice URL — there is no env hook for it — but it
// checks the Cache API first. So the bundled .bin files are written INTO that
// cache under the URL it will ask for, and the unmodified vendor bundle then
// finds them without ever reaching the network. Patching vendor/ would have
// been the other way to do this, and vendored code is not ours to edit.
const VOICE_CACHE = 'kokoro-voices';
function voiceUrlFor(model, voice) {
  return 'https://huggingface.co/' + model + '/resolve/main/voices/' + voice + '.bin';
}

async function seedVoices(model, voices) {
  if (typeof caches === 'undefined' || !Array.isArray(voices) || !voices.length) return;
  let cache;
  try { cache = await caches.open(VOICE_CACHE); } catch (e) { return; }
  const base = new URL('../vendor/tts/voices/', self.location.href).href;
  for (const voice of voices) {
    const url = voiceUrlFor(model, voice);
    try {
      if (await cache.match(url)) continue;             // already there
      const res = await fetch(base + voice + '.bin');
      if (!res.ok) continue;                            // not bundled: the
      const buf = await res.arrayBuffer();              //   download path stands
      await cache.put(url, new Response(buf));
    } catch (e) { /* one voice failing is not the session failing */ }
  }
}

// Are the weights in the app, or is this going to be a download? Asked before
// init so the UI can label the progress that follows, and so "Download voice
// (~90 MB)" never appears on a build that already has them.
//
// GET of the 44-byte config.json, not HEAD of the 88 MB model: the native app
// is served by a custom URL scheme handler, and such a handler only answers
// the request types it chose to implement. GET is the one they all implement.
async function haveLocalWeights(model) {
  try {
    const res = await fetch(localModelsBase() + model + '/config.json');
    return res.ok;
  } catch (e) { return false; }
}

// ── Native inference, when the app can do it ─────────────────────────────────
//
// A worker cannot reach a Capacitor plugin, so the call goes out to the main
// thread and comes back. That round trip costs a millisecond against an
// inference measured in seconds, which is the whole reason this is worth doing.
let nativeSeq = 0;
const nativePending = new Map();

function nativeInfer(ids, style, speed) {
  return new Promise(function (resolve, reject) {
    const id = ++nativeSeq;
    nativePending.set(id, { resolve: resolve, reject: reject });
    post({ type: 'infer', id: id, ids: ids, style: style, speed: speed });
  });
}

function settleNative(msg) {
  const p = nativePending.get(msg.id);
  if (!p) return;
  nativePending.delete(msg.id);
  if (msg.type === 'infer-result') p.resolve(msg);
  else p.reject(new Error(msg.message || 'native inference failed'));
}

/** base64 little-endian Int16 → Float32Array in [-1, 1]. */
function pcmFromBase64(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    let v = (hi << 8) | lo;
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}

/**
 * Point the engine's forward pass at the native plugin.
 *
 * `tts.model` is a plain property the engine calls as
 * `const { waveform } = await this.model({ input_ids, style, speed })`, which
 * makes it the one seam worth taking: everything before it — phonemisation,
 * tokenisation, the voice style slice, the text splitter — stays exactly as the
 * vendored code wrote it, and only the tensor maths moves.
 *
 * Returns false when nothing was swapped, so the caller can say plainly that
 * this session is running the slow path.
 */
function useNativeModel(tts) {
  if (!tts || typeof tts.model !== 'function') return false;
  // from_pretrained has already built an ONNX Runtime *wasm* session by the
  // time we get here, and once the forward pass goes native that session is
  // several hundred megabytes of resident memory doing nothing. Holding it
  // alongside the native one is how a phone gets its web content process
  // killed mid-chapter. transformers.js models are Callables with a dispose(),
  // so the old one can be released the moment the new one is in place.
  const superseded = tts.model;
  tts.model = async function (inputs) {
    // input_ids arrives as int64, so its data is a BigInt64Array; the bridge
    // carries numbers. Phoneme ids are small — nothing is lost narrowing them.
    const ids = Array.prototype.map.call(inputs.input_ids.data, Number);
    const style = Array.prototype.slice.call(inputs.style.data);
    const speed = Number(inputs.speed.data[0]) || 1;
    const res = await nativeInfer(ids, style, speed);
    return { waveform: { data: pcmFromBase64(res.pcm) } };
  };
  try {
    if (superseded && typeof superseded.dispose === 'function') superseded.dispose();
  } catch (e) {
    note('could not release the superseded wasm session: ' + (e && e.message));
  }
  return true;
}

async function init(msg) {
  try {
    const heapGranted = capWasmMemory(
      Array.isArray(msg.heapPages) && msg.heapPages.length
        ? msg.heapPages : [65536, 16384, 8192, 4096],
    );
    if (polyfillStreamAsyncIterator()) note('polyfilled ReadableStream async iteration');
    mark('loading engine');
    const mod = await loadEngine();
    // ONNX Runtime would otherwise fetch its wasm from a CDN; everything this
    // app runs is self-hosted, so point it at vendor/tts/ next to the bundle.
    mod.env.wasmPaths = new URL('../vendor/tts/', self.location.href).href;
    // Local first, remote as the fallback — that is transformers.js's own
    // order, so one code path serves both builds: the native app finds the
    // bundled weights and never touches the network, and a web build with no
    // weights bundled 404s locally and downloads exactly as before.
    mod.env.localModelPath = localModelsBase();
    mod.env.allowLocalModels = true;

    mark('looking for bundled weights');
    const local = await haveLocalWeights(msg.model);
    post({ type: 'source', local: local });
    mark('seeding voices');
    await seedVoices(msg.model, msg.voices);

    mark(local ? 'reading weights from the app' : 'downloading weights');
    tts = await mod.KokoroTTS.from_pretrained(msg.model, {
      dtype: msg.dtype,
      device: msg.device,
      progress_callback: function (p) {
        // Forward per-file 'progress' AND 'done': the main thread uses the
        // model file's 'done' to switch the UI from the byte bar to the
        // "preparing on this device" phase (the session compile), which
        // otherwise looks like a silent hang.
        if (p && (p.status === 'progress' || p.status === 'done')) {
          post({ type: 'progress', status: p.status, file: p.file || '', loaded: p.loaded || 0, total: p.total || 0 });
          // The weights are in hand; everything after this is ONNX Runtime
          // building the session, which is the step that has no progress of
          // its own and so looks identical to a hang.
          if (p.status === 'done' && /\.onnx$/.test(String(p.file || ''))) {
            mark('building the inference session');
          }
        }
      },
    });
    // Says which rung the reservation actually landed on, so the reader-facing
    // engine line reports what the engine got rather than what it asked for.
    // Native inference if the app offers it, wasm if it does not. Announced
    // either way: "which engine am I actually hearing" is the first question
    // when a voice is too slow, and it should never need a rebuild to answer.
    const native = msg.native ? useNativeModel(tts) : false;
    mark(native ? 'ready (native inference)' : 'ready (wasm inference)');
    post({ type: 'ready', heapPages: heapGranted ? heapGranted() : 0, native: native });
    pump();
  } catch (e) {
    // Name the step. "init failed" sends someone back to the logs; "at
    // building the inference session: ..." sends them to the line that did it.
    post({ type: 'init-error',
           message: 'at ' + stage + ': '
             + ((e && (e.message || e.name)) ? String(e.message || e.name) : 'init failed') });
  }
}

// Kokoro pads. Every clip comes back with a stretch of near-silence at each
// end — inaudible by itself, and the reason a group boundary sounds like a
// breath rather than a join: two clips played back to back is two paddings
// nose to tail, on top of whatever the element swap costs. At a group every
// few seconds that is the most audible seam in the whole chapter, and no
// amount of buffering touches it, because the silence IS the audio.
//
// Trimmed here rather than at playback so that the cache, the duration the
// lookahead plans with and the sound all agree on how long a clip is.
const TRIM_FLOOR = 0.003;    // below this is padding, not speech
const TRIM_KEEP_MS = 20;     // left at each end so nothing is clipped short

function trimSilence(f32, sampleRate) {
  let a = 0;
  let b = f32.length;
  while (a < b && Math.abs(f32[a]) < TRIM_FLOOR) a++;
  while (b > a && Math.abs(f32[b - 1]) < TRIM_FLOOR) b--;
  if (b <= a) return f32;    // all padding: not ours to second-guess
  const keep = Math.round((TRIM_KEEP_MS / 1000) * sampleRate);
  a = Math.max(0, a - keep);
  b = Math.min(f32.length, b + keep);
  return (a === 0 && b === f32.length) ? f32 : f32.subarray(a, b);
}

// Float32 PCM → 16-bit WAV. Same encoder as the main thread's, duplicated
// because a worker cannot import a classic script and 30 lines is cheaper
// than restructuring the module for sharing.
function encodeWav(f32, sampleRate) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = function (off, s) { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++, off += 2) {
    let s = f32[i];
    if (s < -1) s = -1; else if (s > 1) s = 1;
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

async function pump() {
  if (running || !tts) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    // The main thread keeps this one promise across pause/resume. ONNX cannot
    // abort a forward pass once entered, but queued work can still be dropped.
    post({ type: 'generating', id: job.id });
    // How long a group takes, against how much audio it produced. This ratio
    // is the difference between an engine that is broken and one that is
    // merely slower than the reader, and those want opposite fixes: the first
    // is a bug, the second is smaller groups or a lighter model. Without it,
    // both look identical from the outside -- a voice that says one sentence
    // and then goes quiet.
    const t0 = (self.performance || Date).now();
    try {
      const audio = await tts.generate(job.text, { voice: job.voice, speed: 1 });
      const rate = audio.sampling_rate || 24000;
      const pcm = trimSilence(audio.audio || audio.data, rate);
      const wav = encodeWav(pcm, rate);
      post({ type: 'audio', id: job.id, wav: wav, seconds: pcm.length / rate,
             ms: Math.round((self.performance || Date).now() - t0),
             chars: job.text.length }, [wav]);
    } catch (e) {
      post({ type: 'error', id: job.id,
             ms: Math.round((self.performance || Date).now() - t0),
             message: e && e.message ? String(e.message) : 'generation failed' });
    }
  }
  running = false;
}

self.onmessage = function (ev) {
  const msg = ev.data || {};
  if (msg.type === 'init') { init(msg); return; }
  if (msg.type === 'generate') {
    if (typeof msg.text !== 'string' || !msg.text.trim()) {
      post({ type: 'error', id: msg.id, message: 'empty text' });
      return;
    }
    queue.push({ id: msg.id, text: msg.text, voice: String(msg.voice || 'af_heart') });
    pump();
    return;
  }
  if (msg.type === 'infer-result' || msg.type === 'infer-error') { settleNative(msg); return; }
  if (msg.type === 'cancel') {
    // The job mid-generate cannot be aborted (ONNX Runtime runs to
    // completion). A just-posted cursor job can be kept across the tiny race
    // before its `generating` message reaches the main thread; everything else
    // behind the active job can and should be dropped.
    const preserveId = Number(msg.preserveId) || 0;
    const dropped = preserveId ? queue.filter(function (job) { return job.id !== preserveId; }) : queue;
    queue = preserveId ? queue.filter(function (job) { return job.id === preserveId; }) : [];
    for (let i = 0; i < dropped.length; i++) post({ type: 'error', id: dropped[i].id, message: 'cancelled' });
  }
};
