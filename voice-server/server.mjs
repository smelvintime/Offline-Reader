#!/usr/bin/env node
// voice-server — render prepared-book audio on a computer instead of the phone.
//
// docs/PREPARED_BOOKS_PLAN.md: a book is prepared once and then plays from
// stored audio. Preparing on the phone is the hot, slow part, and a desktop
// chip renders the same model many times faster. So the app can hand the work
// here: it sends one group of text at a time, this renders it with the same
// Kokoro model and voices, and the phone stores the WAV exactly as if it had
// made it itself. Playback on the phone does not change at all.
//
//   cd voice-server && npm install     # once
//   npm start                          # prints the address and code to type in
//
// The phone and this computer must be on the same network. Anyone on that
// network who has the code can use it, and nothing else: there is no file
// access, no book storage and no other endpoint.
//
// The model, voices, trimming and WAV format match js/novel-voice-worker.js
// so a group sounds the same whichever machine rendered it.
//
// More than one computer: start the others as usual with the same --code,
// and this one with --peer for each of them. The phone talks to this one
// only; each part goes to whichever computer is free, so a faster machine
// simply takes more of the book.

import { createServer } from 'node:http';
import { networkInterfaces, cpus } from 'node:os';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLibrary, defaultLibraryRoot, haveFfmpeg } from './library.mjs';
import { createJobs } from './jobs.mjs';
import { writeZip, ZIP_MAX_ENTRIES } from './zip.mjs';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const DEFAULT_PORT = 8787;
const MAX_BODY = 64 * 1024;       // one group is a few hundred characters
const MAX_JOB_BODY = 32 * 1024 * 1024;   // a whole book's text, a few MB at most
const MAX_PARTS = ZIP_MAX_ENTRIES;
const MAX_KEY = 512;
const MAX_TEXT = 4000;
const VOICE_RE = /^[a-z]{2}_[a-z]+$/;
const PEER_TIMEOUT_MS = 120000;
const PEER_REST_MS = 30000;      // a computer that failed is left alone this long

// ── Same as js/novel-voice-worker.js ────────────────────────────────────────

const TRIM_FLOOR = 0.003;    // below this is padding, not speech
const TRIM_KEEP_MS = 20;     // left at each end so nothing is clipped short

export function trimSilence(f32, sampleRate) {
  let a = 0;
  let b = f32.length;
  while (a < b && Math.abs(f32[a]) < TRIM_FLOOR) a++;
  while (b > a && Math.abs(f32[b - 1]) < TRIM_FLOOR) b--;
  if (b <= a) return f32;
  const keep = Math.round((TRIM_KEEP_MS / 1000) * sampleRate);
  a = Math.max(0, a - keep);
  b = Math.min(f32.length, b + keep);
  return (a === 0 && b === f32.length) ? f32 : f32.subarray(a, b);
}

/** Float32 PCM → 16-bit mono WAV bytes. */
export function encodeWav(f32, sampleRate) {
  const n = f32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0, off = 44; i < n; i++, off += 2) {
    let s = f32[i];
    if (s < -1) s = -1; else if (s > 1) s = 1;
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), off);
  }
  return buf;
}

// ── The engine ──────────────────────────────────────────────────────────────

/**
 * Kokoro through kokoro-js on Node's ONNX Runtime (CPU, every core). fp32 by
 * default: on a desktop CPU it is both the faster and the better-sounding
 * file, the same choice native/or-kokoro makes on the phone.
 * → { info, generate(text, voice) → Promise<{ pcm: Float32Array, rate }> }
 */
export async function loadKokoro(opts) {
  const o = opts || {};
  const { KokoroTTS } = await import('kokoro-js');
  const dtype = o.dtype || 'fp32';
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype, device: 'cpu' });
  return {
    info: { model: MODEL_ID, dtype, cores: cpus().length },
    generate: async function (text, voice) {
      const audio = await tts.generate(text, { voice, speed: 1 });
      return { pcm: audio.audio || audio.data, rate: audio.sampling_rate || 24000 };
    },
  };
}

// ── The HTTP surface ────────────────────────────────────────────────────────

function cors(res) {
  // The app calls from capacitor://localhost (or a web origin in development),
  // so any origin; the pairing code is what limits who gets audio.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-voice-code');
  res.setHeader('Access-Control-Expose-Headers', 'x-seconds, x-render-ms, x-parts, x-from, x-next, x-ready');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function sendJson(res, status, body) {
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  const max = limit || MAX_BODY;
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/** Why a posted book cannot be taken, as a sentence, or null if it can. */
function jobProblem(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return 'body must be a JSON object';
  if (typeof job.book !== 'string' || !job.book.trim() || job.book.length > MAX_KEY) return 'book must be an id';
  if (!VOICE_RE.test(String(job.voice || ''))) return 'unknown voice';
  if (job.title !== undefined && typeof job.title !== 'string') return 'title must be text';
  const parts = job.parts === undefined ? [] : job.parts;
  if (!Array.isArray(parts)) return 'parts must be a list';
  if (parts.length > MAX_PARTS) return 'a book may have at most ' + MAX_PARTS + ' parts';
  for (const p of parts) {
    if (!p || typeof p.key !== 'string' || !p.key || p.key.length > MAX_KEY) return 'every part needs a key of 1 to ' + MAX_KEY + ' characters';
    if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > MAX_TEXT) return 'every part needs 1 to ' + MAX_TEXT + ' characters of text';
  }
  return null;
}

// ── Sharing the work ────────────────────────────────────────────────────────

/** "192.168.1.21" → "http://192.168.1.21:8787", as the app reads an address. */
export function peerBase(input) {
  let s = String(input || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  if (!/:\d+$/.test(new URL(s).host)) s += ':' + DEFAULT_PORT;
  return s;
}

/** Another voice-server, asked over HTTP with the same code. */
export function peerWorker(base, code) {
  return {
    name: base,
    peer: true,
    render: async function (text, voice) {
      const res = await fetch(base + '/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voice-code': code },
        body: JSON.stringify({ text: text, voice: voice }),
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('answered ' + res.status + ' ' + (await res.text()).slice(0, 200));
      return {
        wav: Buffer.from(await res.arrayBuffer()),
        seconds: Number(res.headers.get('x-seconds')) || 0,
        ms: Number(res.headers.get('x-render-ms')) || 0,
      };
    },
  };
}

/**
 * Each computer renders one part at a time (ONNX Runtime already spreads one
 * forward pass over every core; two at once would only fight over them), and
 * a waiting part goes to whichever computer frees up first. A peer that fails
 * rests for a while and its part goes to another, in the end to this one, so
 * a peer that is asleep, still loading or gone never stops the book.
 */
export function createPool(workers, log) {
  const queue = [];   // { text, voice, resolve, reject, tried: Set }
  workers.forEach(function (w) { w.busy = false; w.restUntil = 0; w.rendered = 0; });

  function pump() {
    workers.forEach(function (w) {
      if (w.busy || Date.now() < w.restUntil) return;
      const i = queue.findIndex(function (j) { return !j.tried.has(w); });
      if (i < 0) return;
      const job = queue.splice(i, 1)[0];
      w.busy = true;
      w.render(job.text, job.voice).then(function (r) {
        w.rendered++;
        job.resolve(r);
      }, function (e) {
        if (!w.peer) { job.reject(e); return; }
        log(w.name + ' failed, leaving it for ' + PEER_REST_MS / 1000 + ' s: ' + (e && e.message));
        w.restUntil = Date.now() + PEER_REST_MS;
        setTimeout(pump, PEER_REST_MS).unref();
        job.tried.add(w);
        queue.unshift(job);
      }).finally(function () { w.busy = false; pump(); });
    });
  }

  return {
    render: function (text, voice) {
      return new Promise(function (resolve, reject) {
        queue.push({ text: text, voice: voice, resolve: resolve, reject: reject, tried: new Set() });
        pump();
      });
    },
    shares: function () {
      return workers.map(function (w) { return { name: w.name, rendered: w.rendered, resting: Date.now() < w.restUntil }; });
    },
  };
}

/**
 * The server, with its engine passed in so tests can use a fake one.
 * `engine` may be a promise: /status answers "loading" until it resolves.
 */
export function createVoiceServer(options) {
  const code = String(options.code);
  const log = options.log || function () {};
  let engine = null;
  let loadError = null;
  const loaded = Promise.resolve(options.engine).then(
    function (e) { engine = e; log('voice ready'); return e; },
    function (e) { loadError = e; log('voice failed to load: ' + (e && e.message)); throw e; });
  loaded.catch(function () {});   // /status carries the reason; nothing else waits on it

  // This computer plus any peers. A part waits for the model rather than
  // failing, so a book posted a second after startup is simply taken and
  // begins when the voice has loaded.
  const local = {
    name: 'this computer',
    render: async function (text, voice) {
      const eng = engine || await loaded;
      const t0 = Date.now();
      const out = await eng.generate(text, voice);
      const pcm = trimSilence(out.pcm, out.rate);
      return { wav: encodeWav(pcm, out.rate), seconds: pcm.length / out.rate, ms: Date.now() - t0 };
    },
  };
  const peers = (options.peers || []).map(function (p) { return peerWorker(peerBase(p), code); });
  const pool = createPool([local].concat(peers), log);
  let rendered = 0;

  // Keeping books is optional, so the render-only tests and an app that only
  // knows /render carry on unchanged: without a library those routes 404 and
  // nothing is written to disk.
  const library = options.library || null;
  const jobs = library ? createJobs({
    library: library,
    pool: pool,
    log: log,
    // One part in hand per computer and one waiting, so no computer idles on
    // a round trip. This used to be the phone's job; it belongs here.
    width: function () { return 2 + peers.length; },
  }) : null;

  function authorised(req) { return String(req.headers['x-voice-code'] || '') === code; }

  const srv = createServer(async function (req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
    if (!authorised(req)) { sendJson(res, 401, { error: 'wrong code' }); return; }

    if (req.method === 'GET' && url.pathname === '/status') {
      sendJson(res, 200, {
        ok: true, version: 1,
        ready: !!engine, error: loadError ? String(loadError.message || loadError) : null,
        info: engine ? engine.info : null, rendered: rendered,
        workers: 1 + peers.length, shares: pool.shares(),
        library: library ? { root: library.root, compress: library.compress, busy: jobs.running() } : null,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/render') {
      let job;
      try { job = JSON.parse(await readBody(req)); }
      catch (e) { sendJson(res, e.status || 400, { error: e.status ? e.message : 'body must be JSON' }); return; }
      const text = typeof job.text === 'string' ? job.text : '';
      const voice = String(job.voice || '');
      if (!text.trim() || text.length > MAX_TEXT) { sendJson(res, 400, { error: 'text must be 1 to ' + MAX_TEXT + ' characters' }); return; }
      if (!VOICE_RE.test(voice)) { sendJson(res, 400, { error: 'unknown voice' }); return; }
      if (loadError) { sendJson(res, 503, { error: 'the voice failed to load: ' + loadError.message }); return; }
      if (!engine) { sendJson(res, 503, { error: 'the voice is still loading' }); return; }

      try {
        const r = await pool.render(text, voice);
        rendered++;
        cors(res);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': r.wav.length,
          'x-seconds': r.seconds.toFixed(3),
          'x-render-ms': String(r.ms),
        });
        res.end(r.wav);
      } catch (e) {
        sendJson(res, 500, { error: 'render failed: ' + (e && e.message ? e.message : e) });
      }
      return;
    }

    // ── Books this computer prepares and keeps ─────────────────────────────

    const bookRoutes = ['/books', '/job', '/job/stop', '/bundle', '/book', '/manifest'];
    if (bookRoutes.indexOf(url.pathname) !== -1 && !library) {
      sendJson(res, 404, { error: 'this server renders only; it does not keep books' });
      return;
    }
    const asked = url.searchParams.get('book') || '';

    if (req.method === 'GET' && url.pathname === '/books') {
      sendJson(res, 200, { root: library.root, compress: library.compress, books: await library.list() });
      return;
    }

    // Take a whole book at once. The phone sends every part it needs, this
    // answers as soon as they are written down, and the rendering carries on
    // here afterwards: nothing has to stay awake but this computer.
    if (req.method === 'POST' && url.pathname === '/job') {
      let job;
      try { job = JSON.parse(await readBody(req, MAX_JOB_BODY)); }
      catch (e) {
        sendJson(res, e.status || 400, { error: e.status ? 'that book is too large to send in one piece' : 'body must be JSON' });
        return;
      }
      const wrong = jobProblem(job);
      if (wrong) { sendJson(res, 400, { error: wrong }); return; }
      if (loadError) { sendJson(res, 503, { error: 'the voice failed to load: ' + loadError.message }); return; }
      try {
        sendJson(res, 202, await jobs.start(job));
      } catch (e) {
        sendJson(res, 500, { error: 'could not take the book: ' + (e && e.message ? e.message : e) });
      }
      return;
    }

    // Which part holds which key, and how far each got, with no audio. The
    // phone reads this to work out what it is still missing, which it cannot
    // tell from a count alone once parts start landing out of order.
    if (req.method === 'GET' && url.pathname === '/manifest') {
      const m = asked ? await library.find(asked) : null;
      if (!m) { sendJson(res, 404, { error: 'this computer has no such book' }); return; }
      sendJson(res, 200, {
        v: m.v, book: m.book, title: m.title, voice: m.voice, total: m.parts.length,
        parts: m.parts.map(function (p) { return { key: p.key, seq: p.file ? p.seq : 0 }; }),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/job') {
      const state = asked ? await jobs.state(asked) : null;
      if (!state) { sendJson(res, 404, { error: 'this computer has no such book' }); return; }
      sendJson(res, 200, state);
      return;
    }

    // Stops feeding the pool. Parts in flight finish and are kept, so nothing
    // rendered is thrown away and posting the book again carries on.
    if (req.method === 'POST' && url.pathname === '/job/stop') {
      sendJson(res, 200, { stopped: jobs.cancel(asked) });
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/book') {
      jobs.cancel(asked);
      const removed = await library.remove(asked);
      jobs.forget(asked);
      sendJson(res, removed ? 200 : 404, { removed: removed });
      return;
    }

    // Everything ready, as one zip: book.json says which key each file holds,
    // and `from` skips the parts a phone already collected on an earlier pass.
    if (req.method === 'GET' && url.pathname === '/bundle') {
      const m = asked ? await library.find(asked) : null;
      if (!m) { sendJson(res, 404, { error: 'this computer has no such book' }); return; }
      const done = m.parts.filter(function (p) { return p.file; });
      // `from` is the last sequence number the phone already holds, not a
      // position: parts finish out of order, and a position would step over
      // one that landed late.
      const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
      // A whole book is more than a phone wants to hold in memory while it
      // unpacks, so it collects in passes; `limit` is how big a pass it asks for.
      const limit = Math.max(1, Math.min(MAX_PARTS, Number(url.searchParams.get('limit')) || MAX_PARTS));
      const take = done.filter(function (p) { return (p.seq || 0) > from; })
                       .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })
                       .slice(0, limit);
      if (!take.length) {
        sendJson(res, 404, { error: from ? 'nothing new since last time' : 'no part of this book is ready yet' });
        return;
      }
      const next = take[take.length - 1].seq || 0;
      // The text stays here: the phone already has the book it sent.
      const manifest = {
        v: m.v, book: m.book, title: m.title, voice: m.voice, created: m.created,
        from: from, next: next, ready: done.length, total: m.parts.length,
        parts: take.map(function (p) {
          return { key: p.key, file: p.file, seconds: p.seconds, bytes: p.bytes, seq: p.seq };
        }),
      };
      cors(res);
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="' + m.dir + '.zip"',
        'x-parts': String(take.length),
        'x-from': String(from),
        'x-next': String(next),
        'x-ready': String(done.length),
      });
      try {
        await writeZip(res, (async function* () {
          yield { name: 'book.json', body: Buffer.from(JSON.stringify(manifest, null, 1)) };
          for (const p of take) yield { name: 'parts/' + p.file, body: await library.readPart(m, p) };
        })());
      } catch (e) {
        // The headers are long gone, so the only honest signal left is a zip
        // that ends early. The phone sees a short read and asks again.
        log('bundle stopped early: ' + (e && e.message));
      }
      res.end();
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  // So the command line can resume unfinished books, and tests can look.
  srv.library = library;
  srv.jobs = jobs;
  return srv;
}

/** IPv4 addresses the phone could reach this machine on. */
export function lanAddresses() {
  const out = [];
  const nets = networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    });
  });
  return out;
}

// ── Command line ────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Every value of a flag that may repeat: --peer a --peer b, or --peer a,b. */
function args(name) {
  const out = [];
  process.argv.forEach(function (a, i) {
    if (a === '--' + name && process.argv[i + 1]) out.push.apply(out, process.argv[i + 1].split(','));
  });
  return out.map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Says at start whether each peer answers, so a typo shows up at once. */
async function checkPeers(peers, code) {
  for (const p of peers) {
    const base = peerBase(p);
    let line;
    try {
      const r = await fetch(base + '/status', { headers: { 'x-voice-code': code }, signal: AbortSignal.timeout(5000) });
      if (r.status === 401) line = 'answers, but its code differs; start it with --code ' + code;
      else line = (await r.json()).ready ? 'ready' : 'answers, still loading its voice';
    } catch (e) {
      line = 'not reachable yet; this computer covers its share until it is';
    }
    console.log('    Sharing with ' + base + ': ' + line);
  }
}

async function main() {
  const port = Number(arg('port', DEFAULT_PORT));
  const code = arg('code', String(randomInt(0, 1000000)).padStart(6, '0'));
  const dtype = arg('dtype', 'fp32');
  const peers = args('peer');
  const log = function (m) { console.log('voice-server: ' + m); };
  const root = arg('library', defaultLibraryRoot());
  const compress = await haveFfmpeg();
  const library = createLibrary({ root: root, compress: compress, log: log });
  const server = createVoiceServer({
    code: code,
    peers: peers,
    library: library,
    engine: loadKokoro({ dtype: dtype }),
    log: log,
  });
  server.listen(port, '0.0.0.0', function () {
    const addrs = lanAddresses();
    console.log('');
    console.log('  Offline Reader voice server');
    console.log('  In the app: voice sheet → Prepare on my computer, then enter');
    console.log('');
    addrs.forEach(function (a) { console.log('    Address:  ' + a + ':' + port); });
    if (!addrs.length) console.log('    Address:  (no network found; connect this computer to Wi-Fi)');
    console.log('    Code:     ' + code);
    console.log('    Books:    ' + root);
    if (!compress) {
      console.log('              storing WAV, about 170 MB an hour. Install ffmpeg');
      console.log('              (brew install ffmpeg) for 22 MB an hour instead.');
    }
    console.log('');
    checkPeers(peers, code);
    console.log('  Loading the voice (the first run downloads about 330 MB)…');
    console.log('  Leave this window open while the book prepares. Ctrl+C stops it.');
    // Turning this computer on is enough: a book left half done carries on
    // without the phone having to ask again.
    server.jobs.resumeAll().catch(function (e) { log('could not resume: ' + e.message); });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(function (e) { console.error(e); process.exit(1); });
}
