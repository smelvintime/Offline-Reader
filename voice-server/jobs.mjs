// The job queue: one book at a time becomes a stream of parts for the render
// pool, and the results go to the library.
//
// This is the piece that moves the work off the phone. Before, the phone held
// the loop and asked for one part per round trip, so it had to stay awake and
// connected for the whole book. Now it posts every part once and this drives
// them, keeping every computer busy and writing each file as it lands. The
// phone can be shut in a drawer; the book is here when it comes back.

import { summary } from './library.mjs';
import { unitsOf, joinWavs, gapAfterMs } from './join.mjs';

export function createJobs(options) {
  const library = options.library;
  const pool = options.pool;
  const log = options.log || function () {};
  // One part in hand per computer plus one waiting, so none of them sits idle
  // between finishing a part and being handed the next.
  const width = options.width || function () { return 2; };
  const runs = new Map();   // book → run

  function stateOf(m, run) {
    const s = summary(m);
    s.running = !!(run && run.running);
    s.startedAt = run ? run.startedAt : null;
    s.finishedAt = run ? run.finishedAt : null;
    s.rendered = run ? run.rendered : 0;
    s.failed = run ? run.failed : 0;
    s.lastError = run ? run.lastError : '';
    // Measured here, not guessed: what the app's time-left estimate runs on.
    s.msPerPart = run && run.rendered ? Math.round(run.renderMs / run.rendered) : 0;
    return s;
  }

  /**
   * One part's audio. A part that says where its sentences begin is rendered
   * a sentence at a time and joined here, which is the only way to know to
   * the sample when each one starts: the model reports no timing. The
   * sentences go to the pool separately, so a graphics card or a second
   * computer takes them side by side.
   * → { wav, seconds, marks } with marks null for a part that named no cuts.
   */
  async function renderPart(part, voice) {
    const units = unitsOf(part.text, part.cuts);
    if (units.length < 2) {
      const r = await pool.render(part.text, voice);
      return { wav: r.wav, seconds: r.seconds, marks: Array.isArray(part.cuts) ? [0] : null };
    }
    const rendered = await Promise.all(units.map(function (u) { return pool.render(u, voice); }));
    return joinWavs(rendered.map(function (r) { return r.wav; }), units.map(gapAfterMs));
  }

  /**
   * Feeds the pool, never more than `width()` parts at once, until the list is
   * done or the run is cancelled. A part that fails is counted and skipped:
   * it has no file, so it is pending again and posting the book again retries
   * it. One bad part must not cost the other nine hundred.
   *
   * `run.urgent` jumps the queue: the parts someone is waiting to hear, because
   * they opened the book at chapter five hundred while this was on chapter
   * three.
   */
  function drive(run, manifest, pending) {
    return new Promise(function (resolve) {
      let i = 0;
      let active = 0;
      function take() {
        while (run.urgent.length) {
          const p = run.urgent.shift();
          if (!p.file && p.text && !run.taken.has(p)) return p;
        }
        while (i < pending.length) {
          const p = pending[i++];
          if (!p.file && !run.taken.has(p)) return p;
        }
        return null;
      }
      function next() {
        if (run.cancelled) { if (!active) resolve(); return; }
        while (active < width()) {
          const part = take();
          if (!part) break;
          const started = Date.now();
          active++;
          run.taken.add(part);
          renderPart(part, manifest.voice)
            .then(function (r) { return library.put(manifest, part, r.wav, r.seconds, r.marks); })
            .then(function () {
              run.rendered++;
              run.renderMs += Date.now() - started;
            }, function (e) {
              run.failed++;
              run.lastError = String((e && e.message) || e);
              log('part failed: ' + run.lastError);
            })
            .then(function () { active--; next(); });
        }
        if (!active && i >= pending.length && !run.urgent.length) resolve();
      }
      next();
    });
  }

  const jobs = {
    /**
     * Accept a posted book and start rendering what it still needs. Returns as
     * soon as the parts are on disk in book.json, so the phone's upload
     * finishes in a moment and the rendering outlives the request.
     */
    start: async function (job) {
      const accepted = await library.accept(job);
      const manifest = accepted.manifest;
      // `first` says these parts are the ones being waited for: render them
      // before anything else in the book, whatever was queued ahead of them.
      const wanted = job.first
        ? library.partsFor(manifest, (job.parts || []).map(function (p) { return p.key; }))
            .filter(function (p) { return !p.file && p.text; })
        : [];
      const existing = runs.get(manifest.book);
      if (existing && existing.running) {
        // Already working on this book. The parts just posted were merged into
        // the manifest; the running job sweeps for them when this pass ends.
        existing.again = true;
        // The latest request goes to the very front: it is where the reader
        // is now, and an earlier one is where they no longer are.
        if (wanted.length) existing.urgent = wanted.concat(existing.urgent);
        return stateOf(manifest, existing);
      }

      const run = {
        running: true, cancelled: false, again: false,
        startedAt: Date.now(), finishedAt: null,
        rendered: 0, renderMs: 0, failed: 0, lastError: '',
        urgent: wanted,
        taken: new Set(),   // handed to the pool this pass, so never twice
      };
      runs.set(manifest.book, run);

      (async function () {
        try {
          let pending = accepted.pending;
          while (pending.length && !run.cancelled) {
            await drive(run, manifest, pending);
            // A second post while this one ran may have added parts.
            if (!run.again) break;
            run.again = false;
            // Nothing is in flight between passes, so a part that failed is
            // free to be tried again.
            run.taken.clear();
            pending = manifest.parts.filter(function (p) { return !p.file && p.text; });
          }
        } catch (e) {
          run.lastError = String((e && e.message) || e);
          log('job stopped: ' + run.lastError);
        } finally {
          // Write book.json before saying it stopped. Anything that then
          // reads the library from disk, a restart of this server included,
          // must already see every part that was rendered.
          try { await library.release(manifest); } catch (e) { log('could not save book.json: ' + e.message); }
          run.running = false;
          run.finishedAt = Date.now();
          log('book "' + (manifest.title || manifest.book) + '": ' +
              summary(manifest).done + ' of ' + manifest.parts.length + ' parts ready');
        }
      })();

      return stateOf(manifest, run);
    },

    /** → state | null */
    state: async function (book) {
      const m = await library.find(book);
      if (!m) return null;
      return stateOf(m, runs.get(book) || null);
    },

    /**
     * Stop feeding the pool. Parts already in flight finish and are kept, so
     * stopping never throws away work; the book resumes on the next post.
     */
    cancel: function (book) {
      const run = runs.get(book);
      if (!run || !run.running) return false;
      run.cancelled = true;
      return true;
    },

    running: function () {
      let n = 0;
      runs.forEach(function (r) { if (r.running) n++; });
      return n;
    },

    forget: function (book) { runs.delete(book); },

    /**
     * On startup, carry on with every book that is not finished. This is what
     * makes the computer the owner of the work: turning it on is enough, and
     * the phone does not have to ask again.
     */
    resumeAll: async function () {
      const books = await library.list();
      const unfinished = books.filter(function (b) { return b.total && b.done < b.total; });
      let started = 0;
      for (const b of unfinished) {
        const m = await library.find(b.book);
        if (!m || !m.parts.some(function (p) { return !p.file && p.text; })) continue;
        log('carrying on with "' + (m.title || m.book) + '": ' + (m.parts.length - b.done) + ' parts left');
        await jobs.start({ book: m.book, voice: m.voice, title: m.title, parts: [] });
        started++;
      }
      return started;
    },
  };

  return jobs;
}
