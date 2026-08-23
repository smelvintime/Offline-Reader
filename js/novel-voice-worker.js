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
//   in:  { type:'init', model, device:'wasm'|'webgpu', dtype }
//   in:  { type:'generate', id, text, voice }
//   in:  { type:'cancel' }                  — drop everything not yet started
//   out: { type:'progress', file, loaded, total }   — model download
//   out: { type:'ready' } | { type:'init-error', message }
//   out: { type:'audio', id, wav:ArrayBuffer, seconds }  (wav transferred)
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

function post(msg, transfer) {
  try { self.postMessage(msg, transfer || []); } catch (e) { /* worker torn down */ }
}

async function init(msg) {
  try {
    const mod = await loadEngine();
    // ONNX Runtime would otherwise fetch its wasm from a CDN; everything this
    // app runs is self-hosted, so point it at vendor/tts/ next to the bundle.
    mod.env.wasmPaths = new URL('../vendor/tts/', self.location.href).href;
    tts = await mod.KokoroTTS.from_pretrained(msg.model, {
      dtype: msg.dtype,
      device: msg.device,
      progress_callback: function (p) {
        if (p && p.status === 'progress') {
          post({ type: 'progress', file: p.file || '', loaded: p.loaded || 0, total: p.total || 0 });
        }
      },
    });
    post({ type: 'ready' });
    pump();
  } catch (e) {
    post({ type: 'init-error', message: e && e.message ? String(e.message) : 'init failed' });
  }
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
    try {
      const audio = await tts.generate(job.text, { voice: job.voice, speed: 1 });
      const pcm = audio.audio || audio.data;
      const rate = audio.sampling_rate || 24000;
      const wav = encodeWav(pcm, rate);
      post({ type: 'audio', id: job.id, wav: wav, seconds: pcm.length / rate }, [wav]);
    } catch (e) {
      post({ type: 'error', id: job.id, message: e && e.message ? String(e.message) : 'generation failed' });
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
  if (msg.type === 'cancel') {
    // The job mid-generate cannot be aborted (ONNX Runtime runs to
    // completion); its result is discarded by id on the main thread.
    const dropped = queue;
    queue = [];
    for (let i = 0; i < dropped.length; i++) post({ type: 'error', id: dropped[i].id, message: 'cancelled' });
  }
};
