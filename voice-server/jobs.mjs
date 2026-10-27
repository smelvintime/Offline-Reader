// The job queue: one book at a time becomes a stream of parts for the render
// pool, and the results go to the library.
//
// This is the piece that moves the work off the phone. Before, the phone held
// the loop and asked for one part per round trip, so it had to stay awake and
// connected for the whole book. Now it posts every part once and this drives
// them, keeping every computer busy and writing each file as it lands. The
// phone can be shut in a drawer; the book is here when it comes back.

import { summary } from './library.mjs';

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
   * Feeds the pool, never more than `width()` parts at once, until the list is
   * done or the run is cancelled. A part that fails is counted and skipped:
   * it has no file, so it is pending again and posting the book again retries
   * it. One bad part must not cost the other nine hundred.
   */
  function drive(run, manifest, pending) {
    return new Promise(function (resolve) {
      let i = 0;
      let active = 0;
      function next() {
        if (run.cancelled) { if (!active) resolve(); return; }
        while (active < width() && i < pending.length) {
          const part = pending[i++];
          const started = Date.now();
          active++;
          pool.render(part.text, manifest.voice)
            .then(function (r) { return library.put(manifest, part, r.wav, r.seconds); })
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
        if (!active && i >= pending.length) resolve();
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
      const existing = runs.get(manifest.book);
      if (existing && existing.running) {
        // Already working on this book. The parts just posted were merged into
        // the manifest; the running job sweeps for them when this pass ends.
        existing.again = true;
        return stateOf(manifest, existing);
      }

      const run = {
        running: true, cancelled: false, again: false,
        startedAt: Date.now(), finishedAt: null,
        rendered: 0, renderMs: 0, failed: 0, lastError: '',
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
