// The library: this computer holds the books, and the job queue that fills
// them. The phone's part in preparing a book is one upload and, later, one
// download; everything between the two happens here.
//
// On disk, under --library (default ~/OfflineReaderBooks):
//
//   the-blade-itself-9f2a1c0d/
//     book.json          what the book is, and every part with its file
//     parts/4f3a….m4a    one part of narration, AAC where ffmpeg is here
//
// book.json holds each part's text as well as its audio, so the work belongs
// to this computer and not to the phone that asked for it: close the app,
// restart the server, and the book carries on from the parts already on disk.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const LIBRARY_VERSION = 1;
const SAVE_DEBOUNCE_MS = 2000;
const SAVE_DEBOUNCE_MAX_MS = 30000;

/**
 * How often book.json may be rewritten. A short book's manifest is a few
 * kilobytes and can be written every couple of seconds; a thousand-chapter
 * serial runs to tens of megabytes, and rewriting that every two seconds
 * would be most of what the disk does all night. Waiting longer costs
 * nothing, because reconcile() claims any audio the manifest has not caught
 * up with rather than rendering it again.
 */
function saveEvery(parts) {
  return Math.min(SAVE_DEBOUNCE_MAX_MS, SAVE_DEBOUNCE_MS + parts * 0.1);
}

// manifest → Map(key → part). Outside the manifest so it is never serialized,
// and so merging chunk 150 of a book costs no more than merging chunk 1.
const indexes = new WeakMap();

export function defaultLibraryRoot() {
  return process.env.OFFLINE_READER_LIBRARY || join(homedir(), 'OfflineReaderBooks');
}

/** A folder name a person can recognise in Finder, with the id's hash to keep it unique. */
export function bookDir(book, title) {
  const slug = String(title || book || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const id = createHash('sha1').update(String(book)).digest('hex').slice(0, 8);
  return (slug || 'book') + '-' + id;
}

/** A part's file name. Keys carry book text and separators, so never a path. */
export function partName(key, ext) {
  return createHash('sha1').update(String(key)).digest('hex').slice(0, 16) + '.' + ext;
}

// ── Compression ─────────────────────────────────────────────────────────────

/** Whether ffmpeg is on the PATH. Without it books are stored as WAV, 8× larger. */
export function haveFfmpeg() {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', function () { finish(false); });
      p.on('close', function (code) { finish(code === 0); });
      setTimeout(function () { try { p.kill(); } catch (e) {} finish(false); }, 5000).unref();
    } catch (e) { finish(false); }
  });
}

/**
 * WAV bytes in, an AAC file at `out`. ffmpeg writes the file itself rather
 * than piping it back, because an MP4 container has to seek to finish.
 * 48 kbps mono is about 22 MB an hour against 170 MB for the WAV.
 */
export function encodeAac(wav, out) {
  return new Promise(function (resolve, reject) {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'wav', '-i', 'pipe:0',
      '-c:a', 'aac', '-b:a', '48k', '-ac', '1',
      out,
    ]);
    let err = '';
    p.stderr.on('data', function (c) { err += c; });
    p.on('error', reject);
    p.on('close', function (code) {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited ' + code + (err ? ': ' + err.trim().slice(0, 200) : '')));
    });
    p.stdin.on('error', function () {});   // ffmpeg may close early on a bad input
    p.stdin.end(wav);
  });
}

// ── The library ─────────────────────────────────────────────────────────────

/** What a book looks like from outside: no part text, no file paths. */
export function summary(m) {
  let done = 0, bytes = 0, seconds = 0;
  for (const p of m.parts) {
    if (!p.file) continue;
    done++;
    bytes += p.bytes || 0;
    seconds += p.seconds || 0;
  }
  return {
    book: m.book, title: m.title, voice: m.voice, dir: m.dir, created: m.created,
    total: m.parts.length, done: done, bytes: bytes, seconds: Math.round(seconds),
    ready: m.parts.length > 0 && done === m.parts.length,
  };
}

/**
 * `createLibrary({ root, compress, log })`
 * `compress` false stores WAV, which is what happens when ffmpeg is missing.
 */
export function createLibrary(options) {
  const o = options || {};
  const root = o.root || defaultLibraryRoot();
  const compress = o.compress !== false;
  const log = o.log || function () {};
  const ext = compress ? 'm4a' : 'wav';
  const open = new Map();   // book → manifest, while a job holds it

  function dirOf(m) { return join(root, m.dir); }
  function manifestPath(m) { return join(dirOf(m), 'book.json'); }

  async function save(m) {
    const tmp = manifestPath(m) + '.tmp';
    await writeFile(tmp, JSON.stringify(m, null, 1));
    await rename(tmp, manifestPath(m));      // never a half-written manifest
  }

  /**
   * Written at most this often while a book renders: the file grows to a few
   * hundred kilobytes and rewriting it per part would be most of the disk
   * traffic. Nothing is lost if it is stale, because `reconcile` believes the
   * parts folder over the manifest.
   */
  function saveSoon(m) {
    if (m.saveTimer) return;
    m.saveTimer = setTimeout(function () {
      m.saveTimer = null;
      save(m).catch(function (e) { log('could not write book.json: ' + e.message); });
    }, saveEvery(m.parts.length));
    m.saveTimer.unref();
  }

  function indexOf(m) {
    let i = indexes.get(m);
    if (!i) {
      i = new Map(m.parts.map(function (p) { return [p.key, p]; }));
      indexes.set(m, i);
    }
    return i;
  }

  async function flush(m) {
    if (m.saveTimer) { clearTimeout(m.saveTimer); m.saveTimer = null; }
    await save(m);
  }

  /**
   * The parts folder is the truth, in both directions. A part whose file has
   * gone is wanted again, and a part whose file is there but which book.json
   * never recorded is claimed instead of rendered a second time.
   *
   * The second half is what a kill leaves behind: book.json is written at
   * most every couple of seconds, so a server stopped mid-book has audio on
   * disk that its own manifest does not mention. Its length is not in the
   * file, so a claimed part counts zero seconds towards the summary.
   */
  async function reconcile(m) {
    let have = new Set();
    try { have = new Set(await readdir(join(dirOf(m), 'parts'))); } catch (e) {}
    const claimed = [];
    let top = 0;
    for (const p of m.parts) {
      const name = partName(p.key, ext);
      if (p.file && !have.has(p.file)) { p.file = null; p.bytes = 0; p.seconds = 0; p.seq = 0; }
      else if (!p.file && have.has(name)) { p.file = name; claimed.push(p); }
      if (p.seq > top) top = p.seq;
    }
    m.seq = Math.max(m.seq || 0, top);
    for (const p of claimed) {
      p.seq = ++m.seq;
      try { p.bytes = (await stat(join(dirOf(m), 'parts', p.file))).size; } catch (e) { p.bytes = 0; }
    }
    return m;
  }

  async function read(dir) {
    const m = JSON.parse(await readFile(join(root, dir, 'book.json'), 'utf8'));
    if (m.v !== LIBRARY_VERSION) throw new Error('book.json is version ' + m.v);
    m.dir = dir;
    return m;
  }

  const lib = {
    root: root,
    compress: compress,
    summary: summary,
    dirOf: dirOf,
    flush: flush,

    /** Every book on disk, newest first. Summaries only, never the text. */
    list: async function () {
      let dirs = [];
      try { dirs = await readdir(root, { withFileTypes: true }); } catch (e) { return []; }
      const out = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const held = Array.from(open.values()).find(function (m) { return m.dir === d.name; });
        if (held) { out.push(summary(held)); continue; }
        try { out.push(summary(await read(d.name))); }
        catch (e) { /* not one of ours, or half-written: skip it */ }
      }
      return out.sort(function (a, b) { return b.created - a.created; });
    },

    /** The manifest for a book id, from memory if a job holds it. → m | null */
    find: async function (book) {
      const held = open.get(book);
      if (held) return held;
      let dirs = [];
      try { dirs = await readdir(root, { withFileTypes: true }); } catch (e) { return null; }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        try {
          const m = await read(d.name);
          if (m.book === book) return reconcile(m);
        } catch (e) {}
      }
      return null;
    },

    /**
     * Take a posted job. New parts are added, parts already rendered are kept,
     * and posting the same book again is how a stopped book is resumed.
     * → { manifest, pending }
     */
    accept: async function (job) {
      // A book arrives in chunks, so this runs many times for one book.
      // `find` reconciles against the parts folder only when it has to read
      // the manifest from disk; while the book is held open here, this
      // process is the only writer and that scan would be wasted work on a
      // folder holding hundreds of thousands of files.
      const held = open.has(job.book);
      let m = await lib.find(job.book);
      if (!m) {
        m = {
          v: LIBRARY_VERSION,
          book: job.book,
          title: job.title || '',
          voice: job.voice,
          dir: bookDir(job.book, job.title),
          created: Date.now(),
          // Counts parts as they are stored, so a phone collecting a book in
          // several passes can say what it already has. A position in the
          // list would not do: parts finish out of order, so a part that
          // lands late would sit behind a mark the phone had already passed.
          seq: 0,
          parts: [],
        };
      }
      // A different voice is a different book's worth of audio. Start over
      // rather than let one bundle hold two voices.
      if (job.voice && m.voice !== job.voice) {
        m.voice = job.voice;
        m.parts = [];
        indexes.delete(m);
        await rm(join(dirOf(m), 'parts'), { recursive: true, force: true });
      }
      if (job.title && !m.title) m.title = job.title;

      const known = indexOf(m);
      const added = [];
      for (const p of (job.parts || [])) {
        const had = known.get(p.key);
        if (had) { if (!had.text) had.text = p.text; continue; }
        const rec = { key: p.key, text: p.text, file: null, seconds: 0, bytes: 0, seq: 0 };
        known.set(p.key, rec);
        m.parts.push(rec);
        added.push(rec);
      }

      await mkdir(join(dirOf(m), 'parts'), { recursive: true });
      open.set(m.book, m);
      // The first sight of a book writes its manifest at once so it exists on
      // disk; later chunks ride the debounce, because rewriting the whole
      // thing per chunk is what makes a long serial crawl.
      if (held) saveSoon(m); else await save(m);
      // A chunk of a book already in hand reports only what it brought, so
      // taking a book does not cost a scan of every part per chunk; the run
      // sweeps for anything left over when it finishes a pass. The first
      // sight of a book reports everything outstanding, which is what makes
      // resuming one off the disk work.
      const outstanding = held ? added : m.parts;
      return { manifest: m, pending: outstanding.filter(function (p) { return !p.file && p.text; }) };
    },

    /** One rendered part: compressed where it can be, written, counted. */
    put: async function (m, part, wav, seconds) {
      const name = partName(part.key, ext);
      const path = join(dirOf(m), 'parts', name);
      if (compress) await encodeAac(wav, path);
      else await writeFile(path, wav);
      const s = await stat(path);
      part.file = name;
      part.bytes = s.size;
      part.seconds = seconds || 0;
      part.seq = ++m.seq;
      saveSoon(m);
      return part;
    },

    /** One part's bytes, for the bundle. */
    readPart: function (m, part) {
      return readFile(join(dirOf(m), 'parts', part.file));
    },

    release: async function (m) {
      await flush(m);
      open.delete(m.book);
    },

    remove: async function (book) {
      const m = await lib.find(book);
      if (!m) return false;
      if (m.saveTimer) { clearTimeout(m.saveTimer); m.saveTimer = null; }
      open.delete(book);
      await rm(dirOf(m), { recursive: true, force: true });
      return true;
    },
  };

  return lib;
}
