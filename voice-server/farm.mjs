// Several copies of the voice, each in its own process (engine-worker.mjs),
// behind the one function the rest of the server knows: text in, samples out.
//
// The farm's size can change while it works. tuner.mjs uses that to find how
// many copies this particular computer renders fastest with, by trying.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESPAWN_MS = 1500;
const STDERR_KEEP = 1500;       // the tail of a copy's complaints, for the log
const LOAD_TRIES = 3;           // a copy that cannot start this often is given up on

/**
 * createFarm({ script, env, size, log, respawnMs })
 * → { ready, generate(text, voice), capacity(), size(), target(), resize(n),
 *     window(), peek(), threads(), close() }
 *
 * `ready` resolves when the first copy has loaded, and rejects with the
 * reason if it cannot. The first is started alone: on a first run it is the
 * one that downloads the model, and a dozen copies racing to write the same
 * cache would be a dozen downloads.
 */
export function createFarm(options) {
  const o = options || {};
  const log = o.log || function () {};
  const script = typeof o.script === 'string' ? o.script : fileURLToPath(o.script);
  const respawnMs = o.respawnMs === undefined ? RESPAWN_MS : o.respawnMs;
  const copies = [];       // { proc, ready, job, retiring, err }
  const queue = [];        // { id, text, voice, resolve, reject, tries }
  let want = Math.max(1, Math.floor(Number(o.size) || 1));
  let closed = false;
  let nextId = 1;
  let firstLoaded = false;
  let loadFailures = 0;
  let threads = null;      // what the copies report they were given

  // What tuner.mjs measures: audio made, and how busy the copies were making it.
  let mark = Date.now();
  let madeSeconds = 0, madeCount = 0, busyMs = 0;

  let settleReady, failReady;
  const ready = new Promise(function (res, rej) { settleReady = res; failReady = rej; });
  ready.catch(function () {});      // whoever awaits it gets the reason; nothing else must

  // Replacements are started a moment later, not at once: a copy that dies
  // on arrival would otherwise be restarted as fast as it can die.
  const pending = new Set();
  function later(fn) {
    const t = setTimeout(function () { pending.delete(t); fn(); }, respawnMs);
    pending.add(t);
  }

  function live() { return copies.filter(function (c) { return !c.retiring; }); }
  function readyCopies() { return copies.filter(function (c) { return c.ready && !c.retiring; }); }

  function pump() {
    for (const c of copies) {
      if (!queue.length) return;
      if (!c.ready || c.job || c.retiring) continue;
      const job = queue.shift();
      c.job = job;
      job.started = Date.now();
      try { c.proc.send({ type: 'generate', id: job.id, text: job.text, voice: job.voice }); }
      catch (e) { c.job = null; queue.unshift(job); }
    }
  }

  function finished(c, job) {
    c.job = null;
    // Only the part of the work that falls inside the current window counts
    // towards it, or a sentence that began before the window would make the
    // copies look busier than they were.
    busyMs += Date.now() - Math.max(job.started, mark);
    if (c.retiring) { try { c.proc.kill(); } catch (e) {} }
  }

  function topUp() {
    if (closed) return;
    // The first copy loads alone; the rest follow once the model is on disk.
    const room = firstLoaded ? want : Math.min(want, 1);
    while (live().length < room) start();
  }

  function start() {
    const c = { proc: null, ready: false, job: null, retiring: false, err: '' };
    c.proc = fork(script, [], {
      env: Object.assign({}, process.env, o.env || {}),
      serialization: 'advanced',           // so samples cross as bytes, not JSON
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    copies.push(c);
    if (o.onStart) o.onStart(c.proc.pid);
    c.proc.stderr.on('data', function (d) { c.err = (c.err + d).slice(-STDERR_KEEP); });

    c.proc.on('message', function (m) {
      if (!m) return;
      if (m.type === 'ready') {
        c.ready = true;
        loadFailures = 0;
        if (threads === null) threads = m.threads;
        if (!firstLoaded) { firstLoaded = true; settleReady(); }
        topUp();
        pump();
        return;
      }
      if (m.type === 'failed') { c.failed = String(m.message || 'the voice could not load'); return; }
      const job = c.job;
      if (!job || m.id !== job.id) return;
      finished(c, job);
      if (m.type === 'audio') {
        const pcm = m.pcm instanceof Float32Array ? m.pcm : new Float32Array(m.pcm);
        const rate = m.rate || 24000;
        madeSeconds += pcm.length / rate;
        madeCount++;
        job.resolve({ pcm: pcm, rate: rate });
      } else {
        job.reject(new Error(m.message || 'the voice could not render that'));
      }
      pump();
    });

    c.proc.on('error', function (e) { c.failed = c.failed || String((e && e.message) || e); });

    c.proc.on('exit', function (code) {
      const at = copies.indexOf(c);
      if (at !== -1) copies.splice(at, 1);
      const job = c.job;
      c.job = null;
      if (closed) { if (job) job.reject(new Error('the server is shutting down')); return; }
      if (c.retiring) { if (job) { queue.unshift(job); pump(); } return; }

      const why = c.failed || (c.err.trim().split('\n').pop() || '') || ('exit code ' + code);
      if (!c.ready) {
        // Never loaded. The first copy failing is the voice failing; a later
        // one failing is this computer saying it has no room for another.
        loadFailures++;
        if (!firstLoaded) {
          if (loadFailures >= LOAD_TRIES || c.failed) { failReady(new Error(why)); return; }
        } else if (loadFailures >= LOAD_TRIES) {
          want = Math.max(1, live().length);
          log('another copy of the voice would not start (' + why + '); staying at ' + want);
          return;
        }
        later(topUp);
        return;
      }

      log('a copy of the voice stopped (' + why + '); starting another');
      if (job) {
        // Its sentence goes to another copy, once. Twice means the sentence
        // is what kills it, and that must not take the book down with it.
        busyMs += Date.now() - Math.max(job.started, mark);
        if (job.tries++ < 1) queue.unshift(job);
        else job.reject(new Error('the voice stopped while rendering this: ' + why));
      }
      later(topUp);
      pump();
    });
    return c;
  }

  topUp();

  return {
    ready: ready,

    generate: function (text, voice) {
      return new Promise(function (resolve, reject) {
        if (closed) { reject(new Error('the server is shutting down')); return; }
        queue.push({ id: nextId++, text: text, voice: voice, resolve: resolve, reject: reject, tries: 0, started: 0 });
        pump();
      });
    },

    /** How many sentences can render at once right now. Never less than one. */
    capacity: function () { return Math.max(1, readyCopies().length); },

    /** Copies loaded and in service. */
    size: function () { return readyCopies().length; },

    /** Copies wanted, which the farm is working towards. */
    target: function () { return want; },

    threads: function () { return threads; },

    /**
     * Grow or shrink. Growing starts copies; shrinking lets the busy ones
     * finish their sentence first, so nothing rendered is thrown away.
     */
    resize: function (n) {
      want = Math.max(1, Math.floor(n));
      loadFailures = 0;
      const extra = live().length - want;
      if (extra > 0) {
        // The ones still loading first, then idle ones, then busy ones.
        const order = live().sort(function (a, b) {
          const rank = function (c) { return !c.ready ? 0 : c.job ? 2 : 1; };
          return rank(a) - rank(b);
        });
        for (const c of order.slice(0, extra)) {
          c.retiring = true;
          if (!c.job) { try { c.proc.kill(); } catch (e) {} }
        }
      }
      topUp();
    },

    /** What has been made since the last window(), without ending the window. */
    peek: function () {
      return { ms: Date.now() - mark, seconds: madeSeconds, done: madeCount };
    },

    /** What has been made since the last call, and how busy the copies were. */
    window: function () {
      const now = Date.now();
      let busy = busyMs;
      for (const c of copies) if (c.job) busy += now - Math.max(c.job.started, mark);
      const w = { ms: now - mark, seconds: madeSeconds, done: madeCount, busyMs: busy, copies: readyCopies().length };
      mark = now; madeSeconds = 0; madeCount = 0; busyMs = 0;
      return w;
    },

    close: function () {
      closed = true;
      pending.forEach(clearTimeout);
      pending.clear();
      for (const c of copies.slice()) { try { c.proc.kill(); } catch (e) {} }
      while (queue.length) queue.shift().reject(new Error('the server is shutting down'));
    },
  };
}
