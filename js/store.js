// Offline Reader — persistence layer. See docs/ARCHITECTURE.md §3.
//
// IndexedDB for anything that can get large (imported series, cached chapter
// content, reading progress, day logs, uploaded blobs); localStorage for
// preferences, which must be readable synchronously during first paint. Under
// Capacitor, small source blobs are additionally delegated to the device
// filesystem through window.Platform — see the Blobs section.
//
// Every async method resolves rather than rejects for expected conditions:
// a missing row is `null`, a missing collection is `[]`. If IndexedDB is
// unavailable (private browsing, locked-down webviews) an in-memory shim takes
// over so the app degrades to "works until you close the tab" instead of
// throwing on boot.

(function () {
  'use strict';

  const DB_NAME    = 'offline-reader';
  // v2 adds the dayLogs store (goals); v3 adds the thoughts store. The upgrade
  // handler only creates what is missing, so a fresh install and any older
  // version converge on the same shape.
  const DB_VERSION = 3;

  const STORE_SERIES   = 'userSeries';
  const STORE_CHAPTERS = 'chapters';
  const STORE_PROGRESS = 'progress';
  const STORE_BLOBS    = 'blobs';
  const STORE_DAYLOGS  = 'dayLogs';
  const STORE_THOUGHTS = 'thoughts';

  // ── IndexedDB plumbing ────────────────────────────────────────────────────

  let dbPromise = null;
  let memoryMode = false;

  // Fallback tables, used only when IndexedDB cannot be opened.
  const mem = {
    [STORE_SERIES]:   new Map(),
    [STORE_CHAPTERS]: new Map(),
    [STORE_PROGRESS]: new Map(),
    [STORE_BLOBS]:    new Map(),
    [STORE_DAYLOGS]:  new Map(),
    [STORE_THOUGHTS]: new Map(),
  };

  function memKey(k) { return Array.isArray(k) ? k.join('\x00') : String(k); }

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve) {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        memoryMode = true;
        resolve(null);
        return;
      }

      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SERIES)) {
          const s = db.createObjectStore(STORE_SERIES, { keyPath: 'id' });
          s.createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
          const c = db.createObjectStore(STORE_CHAPTERS, { keyPath: ['seriesId', 'id'] });
          c.createIndex('seriesId', 'seriesId');
        }
        if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
          const p = db.createObjectStore(STORE_PROGRESS, { keyPath: 'seriesId' });
          p.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS);
        }
        if (!db.objectStoreNames.contains(STORE_DAYLOGS)) {
          const d = db.createObjectStore(STORE_DAYLOGS, { keyPath: 'day' });
          d.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains(STORE_THOUGHTS)) {
          const t = db.createObjectStore(STORE_THOUGHTS, { keyPath: 'id' });
          t.createIndex('seriesId', 'seriesId');
        }
      };

      req.onsuccess = function () {
        const db = req.result;
        // A version change from another tab invalidates this handle; drop it so
        // the next call reopens instead of failing on a closing connection.
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };

      req.onerror = function () { memoryMode = true; resolve(null); };
      req.onblocked = function () { memoryMode = true; resolve(null); };
    });

    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDb().then(function (db) {
      if (!db) return fn(null);           // memory mode
      return new Promise(function (resolve) {
        let request;
        try {
          const t = db.transaction(storeName, mode);
          request = fn(t.objectStore(storeName));
          t.onabort = function () { resolve(undefined); };
        } catch (e) {
          resolve(undefined);
          return;
        }
        if (!request) { resolve(undefined); return; }
        request.onsuccess = function () { resolve(request.result); };
        request.onerror   = function () { resolve(undefined); };
      });
    });
  }

  function idbGet(storeName, key) {
    if (memoryMode) return Promise.resolve(mem[storeName].get(memKey(key)));
    return tx(storeName, 'readonly', function (store) {
      return store ? store.get(key) : (mem[storeName].get(memKey(key)), null);
    }).then(function (r) {
      return r === undefined && memoryMode ? mem[storeName].get(memKey(key)) : r;
    });
  }

  function idbPut(storeName, value, key) {
    if (memoryMode) {
      mem[storeName].set(memKey(key !== undefined ? key : derivedKey(storeName, value)), value);
      return Promise.resolve(value);
    }
    return tx(storeName, 'readwrite', function (store) {
      if (!store) {
        mem[storeName].set(memKey(key !== undefined ? key : derivedKey(storeName, value)), value);
        return null;
      }
      return key !== undefined ? store.put(value, key) : store.put(value);
    }).then(function () { return value; });
  }

  function idbDelete(storeName, key) {
    if (memoryMode) { mem[storeName].delete(memKey(key)); return Promise.resolve(); }
    return tx(storeName, 'readwrite', function (store) {
      if (!store) { mem[storeName].delete(memKey(key)); return null; }
      return store.delete(key);
    }).then(function () {});
  }

  function idbGetAll(storeName, query) {
    if (memoryMode) return Promise.resolve(Array.from(mem[storeName].values()));
    return tx(storeName, 'readonly', function (store) {
      if (!store) return null;
      return store.getAll(query);
    }).then(function (r) {
      if (r) return r;
      return memoryMode ? Array.from(mem[storeName].values()) : [];
    });
  }

  function derivedKey(storeName, value) {
    if (storeName === STORE_SERIES)   return value.id;
    if (storeName === STORE_PROGRESS) return value.seriesId;
    if (storeName === STORE_CHAPTERS) return [value.seriesId, value.id];
    if (storeName === STORE_DAYLOGS)  return value.day;
    if (storeName === STORE_THOUGHTS) return value.id;
    return value;
  }

  function now() { return new Date().toISOString(); }

  // ── Imported series ───────────────────────────────────────────────────────

  async function listUserSeries() {
    const rows = (await idbGetAll(STORE_SERIES)) || [];
    return rows.sort(function (a, b) {
      return String(b.addedAt || '').localeCompare(String(a.addedAt || ''));
    });
  }

  async function getUserSeries(id) {
    if (!id) return null;
    const row = await idbGet(STORE_SERIES, id);
    return row || null;
  }

  async function putUserSeries(series) {
    if (!series || !series.id) throw new Error('Store.putUserSeries: series.id is required');
    const existing = await getUserSeries(series.id);
    const record = Object.assign({}, existing, series, {
      addedAt:   (existing && existing.addedAt) || series.addedAt || now(),
      updatedAt: now(),
    });
    await idbPut(STORE_SERIES, record);
    return record;
  }

  async function deleteUserSeries(id) {
    if (!id) return;
    await idbDelete(STORE_SERIES, id);
    await clearChapters(id);
    await deleteProgress(id);
    // Deliberately NO cascade to thoughts: a thought is the reader's own
    // writing, not series data — seriesTitle is denormalized on each row so
    // it still renders after the series is gone.
  }

  // ── Cached chapter content ────────────────────────────────────────────────

  async function getChapter(seriesId, chapterId) {
    if (!seriesId || !chapterId) return null;
    const row = await idbGet(STORE_CHAPTERS, [seriesId, chapterId]);
    return row || null;
  }

  async function putChapter(seriesId, chapterId, file) {
    if (!seriesId || !chapterId) throw new Error('Store.putChapter: seriesId and chapterId are required');
    const record = Object.assign({}, file, {
      seriesId: seriesId,
      id: chapterId,
      cachedAt: now(),
    });
    // Prune accounting, paid once at write time — measuring on the read side
    // would stringify every row on every prune pass. A row this cannot
    // measure stays unstamped, counts 0 in pruneChapterCache, and is never
    // evicted (conservative: nothing leaves that was never weighed).
    try { record.sizeEstimate = JSON.stringify(record).length; } catch (e) { /* unstamped */ }
    await idbPut(STORE_CHAPTERS, record);
    return record;
  }

  async function deleteChapter(seriesId, chapterId) {
    if (!seriesId || !chapterId) return;
    await idbDelete(STORE_CHAPTERS, [seriesId, chapterId]);
  }

  async function listCachedChapterIds(seriesId) {
    const all = (await idbGetAll(STORE_CHAPTERS)) || [];
    return all.filter(function (c) { return c.seriesId === seriesId; })
              .map(function (c) { return c.id; });
  }

  async function clearChapters(seriesId) {
    const all = (await idbGetAll(STORE_CHAPTERS)) || [];
    const doomed = seriesId ? all.filter(function (c) { return c.seriesId === seriesId; }) : all;
    for (const c of doomed) await idbDelete(STORE_CHAPTERS, [c.seriesId, c.id]);
  }

  // How many missing sizeEstimate stamps a single prune call may backfill.
  // The cursor reads every row anyway, but rewriting a whole pre-migration
  // library in one pass would turn housekeeping into a write storm — capped,
  // the cache converges to fully-counted over a few prunes instead.
  const PRUNE_BACKFILL_MAX = 50;

  // Decide which rows leave: only unprotected, only measured, oldest first.
  // Protected series' chapters are primary data, not cache — they neither
  // count against the cap nor are ever deleted.
  function planEvictions(rows, maxBytes, protect) {
    let total = 0;
    const candidates = [];
    for (const rec of rows) {
      if (protect.has(rec.seriesId)) continue;
      total += rec.size;
      if (rec.size > 0) candidates.push(rec);
    }
    candidates.sort(function (a, b) { return a.cachedAt.localeCompare(b.cachedAt); });
    const doomed = [];
    let bytes = 0;
    for (const rec of candidates) {
      if (total <= maxBytes) break;
      doomed.push(rec);
      total -= rec.size;
      bytes += rec.size;
    }
    return { doomed: doomed, bytes: bytes };
  }

  async function pruneChapterCache(opts) {
    const empty = { removed: 0, bytes: 0 };
    const maxBytes = opts ? opts.maxBytes : undefined;
    // An absent or nonsense cap prunes nothing — never evict against a budget
    // nobody actually set.
    if (typeof maxBytes !== 'number' || !isFinite(maxBytes) || maxBytes < 0) return empty;
    const protect = new Set((opts && opts.protectSeriesIds) || []);

    const db = await openDb();
    if (!db) {
      // Memory mode mirrors the IDB pass: stamp what fits the cap, measure,
      // evict oldest until under budget.
      let stamped = 0;
      const rows = [];
      mem[STORE_CHAPTERS].forEach(function (row, key) {
        let size = (typeof row.sizeEstimate === 'number' && isFinite(row.sizeEstimate)) ? row.sizeEstimate : 0;
        if (!size && stamped < PRUNE_BACKFILL_MAX) {
          try {
            const est = JSON.stringify(row).length;
            if (est > 0) { row.sizeEstimate = est; size = est; stamped++; }
          } catch (e) { /* counts 0, never evicted */ }
        }
        rows.push({ key: key, seriesId: row.seriesId, cachedAt: String(row.cachedAt || ''), size: size });
      });
      const plan = planEvictions(rows, maxBytes, protect);
      plan.doomed.forEach(function (rec) { mem[STORE_CHAPTERS].delete(rec.key); });
      return { removed: plan.doomed.length, bytes: plan.bytes };
    }

    return new Promise(function (resolve) {
      let t;
      try { t = db.transaction(STORE_CHAPTERS, 'readwrite'); } catch (e) { resolve(empty); return; }
      const store = t.objectStore(STORE_CHAPTERS);
      const rows = [];
      let stamped = 0;
      let removed = 0, freed = 0;
      let settled = false;
      function done(result) { if (!settled) { settled = true; resolve(result); } }
      t.oncomplete = function () { done({ removed: removed, bytes: freed }); };
      // An aborted transaction rolled its deletes back — report nothing gone.
      t.onabort = function () { done(empty); };

      let cur;
      try { cur = store.openCursor(); } catch (e) { done(empty); return; }
      cur.onerror = function (e) { e.preventDefault(); done(empty); };
      cur.onsuccess = function () {
        const c = cur.result;
        if (c) {
          const row = c.value || {};
          const rec = {
            key: c.primaryKey,
            seriesId: row.seriesId,
            cachedAt: String(row.cachedAt || ''),
            size: (typeof row.sizeEstimate === 'number' && isFinite(row.sizeEstimate)) ? row.sizeEstimate : 0,
          };
          if (!rec.size && stamped < PRUNE_BACKFILL_MAX) {
            // Legacy row from before the stamp existed: measure it now so this
            // and future passes can count it. A failed rewrite (quota) must
            // not abort the whole prune — preventDefault keeps the
            // transaction alive and the row reverts to unmeasured, therefore
            // untouchable.
            try {
              const est = JSON.stringify(row).length;
              if (est > 0) {
                row.sizeEstimate = est;
                const upd = c.update(row);
                rec.size = est;
                stamped++;
                upd.onerror = function (e) { e.preventDefault(); rec.size = 0; };
              }
            } catch (e) { /* unmeasurable row: counts 0 forever */ }
          }
          rows.push(rec);
          c.continue();
          return;
        }
        // Cursor exhausted. Requests in one transaction complete in order, so
        // every update outcome above has already settled into its rec.size.
        // Evictions run inside the same transaction.
        planEvictions(rows, maxBytes, protect).doomed.forEach(function (rec) {
          let del;
          try { del = store.delete(rec.key); } catch (e) { return; }
          del.onsuccess = function () { removed += 1; freed += rec.size; };
          del.onerror = function (e) { e.preventDefault(); };
        });
      };
    });
  }

  async function estimateUsage() {
    let usage = null, quota = null;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        usage = e.usage != null ? e.usage : null;
        quota = e.quota != null ? e.quota : null;
      } catch (e) { /* fall through */ }
    }
    // Native archives and page caches live outside the webview's storage
    // accounting; fold them in so the manage view tells the truth on device.
    const fs = nativeArchives();
    if (fs && typeof fs.usage === 'function') {
      try {
        const u = await fs.usage();
        const extra = u ? (u.archiveBytes || 0) + (u.pageCacheBytes || 0) : 0;
        if (extra > 0) usage = (usage || 0) + extra;
      } catch (e) { /* the web numbers stand on their own */ }
    }
    return { usage: usage, quota: quota };
  }

  // ── Reading progress ──────────────────────────────────────────────────────

  async function getProgress(seriesId) {
    if (!seriesId) return null;
    const row = await idbGet(STORE_PROGRESS, seriesId);
    return row || null;
  }

  async function putProgress(seriesId, patch) {
    if (!seriesId) throw new Error('Store.putProgress: seriesId is required');
    const existing = await getProgress(seriesId);
    const record = Object.assign({}, existing, patch, {
      seriesId: seriesId,
      updatedAt: now(),
    });
    await idbPut(STORE_PROGRESS, record);
    // Every progress writer already funnels through here, which makes this
    // the one choke point goals can observe instead of instrumenting three
    // readers. A throwing listener must not fail the write it watched.
    try {
      window.dispatchEvent(new CustomEvent('or:progress', {
        detail: { seriesId: seriesId, patch: patch, row: record },
      }));
    } catch (e) { /* dispatch is best-effort */ }
    return record;
  }

  async function listProgress(opts) {
    const limit = (opts && opts.limit) || Infinity;
    const rows = (await idbGetAll(STORE_PROGRESS)) || [];
    return rows.sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    }).slice(0, limit);
  }

  async function deleteProgress(seriesId) {
    if (!seriesId) return;
    await idbDelete(STORE_PROGRESS, seriesId);
  }

  // ── Day logs (goals) ──────────────────────────────────────────────────────
  //
  // One row per local calendar day, keyed "YYYY-MM-DD". Progress says where
  // you are in a series; a DayLog says how much reading a day held. Single
  // writer by contract: js/goals.js reads, merges its own arrays, and calls
  // putDayLog — the store just replaces fields, it does not deep-merge.

  async function getDayLog(day) {
    if (!day) return null;
    const row = await idbGet(STORE_DAYLOGS, day);
    return row || null;
  }

  async function putDayLog(day, patch) {
    if (!day) throw new Error('Store.putDayLog: day is required');
    const existing = await getDayLog(day);
    const record = Object.assign({}, existing, patch, {
      day: day,
      updatedAt: now(),
    });
    await idbPut(STORE_DAYLOGS, record);
    return record;
  }

  async function listDayLogs(opts) {
    const since = opts && opts.since;
    const until = opts && opts.until;
    const limit = (opts && opts.limit) || Infinity;
    const rows = (await idbGetAll(STORE_DAYLOGS)) || [];
    // YYYY-MM-DD keys make lexicographic order calendar order; both bounds
    // are inclusive so "this week" is since=Monday, until=Sunday.
    return rows.filter(function (r) {
      if (since && String(r.day) < String(since)) return false;
      if (until && String(r.day) > String(until)) return false;
      return true;
    }).sort(function (a, b) {
      return String(b.day || '').localeCompare(String(a.day || ''));
    }).slice(0, limit);
  }

  async function clearDayLogs() {
    if (memoryMode) { mem[STORE_DAYLOGS].clear(); return; }
    await tx(STORE_DAYLOGS, 'readwrite', function (store) {
      if (!store) { mem[STORE_DAYLOGS].clear(); return null; }
      return store.clear();
    });
  }

  // ── Thoughts ──────────────────────────────────────────────────────────────
  //
  // The reader's own reflections, left when closing a book (or, opted in, a
  // chapter). One row per thought, keyed by a store-minted id; `seriesTitle`
  // is denormalized so a thought outlives its series (deleteUserSeries does
  // not cascade here — see the note there). Single writer by contract:
  // js/thoughts.js. The text is third-party prose at render time.

  function mintThoughtId() {
    let rand = '';
    while (rand.length < 4) rand += Math.random().toString(36).slice(2);
    return 't-' + Date.now().toString(36) + '-' + rand.slice(0, 4);
  }

  async function listThoughts(opts) {
    const seriesId = opts && opts.seriesId;
    const limit = (opts && opts.limit) || Infinity;
    const rows = (await idbGetAll(STORE_THOUGHTS)) || [];
    return rows.filter(function (r) {
      return !seriesId || r.seriesId === seriesId;
    }).sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    }).slice(0, limit);
  }

  async function putThought(thought) {
    if (!thought) throw new Error('Store.putThought: thought is required');
    const record = Object.assign({}, thought, {
      id: thought.id || mintThoughtId(),
      createdAt: thought.createdAt || now(),
      updatedAt: now(),
    });
    await idbPut(STORE_THOUGHTS, record);
    return record;
  }

  async function deleteThought(id) {
    if (!id) return;                       // missing id is a no-op
    await idbDelete(STORE_THOUGHTS, id);
  }

  // ── Blobs ─────────────────────────────────────────────────────────────────
  //
  // On the web these live in the IndexedDB `blobs` store (out-of-line keys —
  // putBlob(key, blob) argument order is contract). Under Capacitor, small
  // source blobs (EPUB/TXT sources, ≤ 64 MB) are delegated to the device
  // filesystem via Platform.archives: WKWebView can evict IndexedDB under
  // storage pressure, the app container it cannot. Reads check the filesystem
  // first and fall back to IndexedDB so web-era rows keep working. There is
  // deliberately no boot-time bulk migration — pushing a 300 MB web-era
  // archive through the bridge as base64 is the OOM this design exists to
  // avoid; the importer's manage view offers a chunked, user-initiated move
  // instead. Large archives never pass through here on native at all: they
  // arrive as files via Platform.archives.importFromUri.

  const NATIVE_BLOB_MAX = 64 * 1024 * 1024;

  function nativeArchives() {
    const p = window.Platform;
    return (p && p.isNative && p.archives) ? p.archives : null;
  }

  async function putBlob(key, blob) {
    if (!key) throw new Error('Store.putBlob: key is required');
    const fs = nativeArchives();
    if (fs && typeof fs.save === 'function' &&
        blob && typeof blob.size === 'number' && blob.size <= NATIVE_BLOB_MAX) {
      try {
        const saved = await fs.save(key, blob);
        if (saved) return blob;   // the filesystem holds it; no IDB copy
      } catch (e) { /* fall through to IndexedDB */ }
    }
    await idbPut(STORE_BLOBS, blob, key);
    return blob;
  }

  async function getBlob(key) {
    if (!key) return null;
    const fs = nativeArchives();
    if (fs && typeof fs.read === 'function') {
      try {
        const b = await fs.read(key);
        if (b) return b;
      } catch (e) { /* fall through to IndexedDB */ }
    }
    const b = await idbGet(STORE_BLOBS, key);
    return b || null;
  }

  async function deleteBlob(key) {
    if (!key) return;
    // A key can live in either backend (web-era row, or a migrated file) —
    // remove from both; each side treats a missing entry as a no-op.
    const fs = nativeArchives();
    if (fs && typeof fs.remove === 'function') {
      try { await fs.remove(key); } catch (e) { /* IDB delete still runs */ }
    }
    await idbDelete(STORE_BLOBS, key);
  }

  // ── Preferences ───────────────────────────────────────────────────────────
  //
  // Synchronous by design: the novel reader needs font size and theme before
  // it paints its first frame, and a Promise there means a flash of the wrong
  // typography on every open.

  const PREF_KEY     = 'or.prefs';
  const PREF_PER_KEY = 'or.prefs.series';

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) { return fallback; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota — prefs are not worth throwing over */ }
  }

  let globalPrefs = readJson(PREF_KEY, {});
  let seriesPrefs = readJson(PREF_PER_KEY, {});
  const prefListeners = new Set();

  function emit(detail) {
    prefListeners.forEach(function (fn) {
      try { fn(detail); } catch (e) { console.error('[Store.prefs] listener failed', e); }
    });
    try { window.dispatchEvent(new CustomEvent('or:prefs', { detail: detail })); } catch (e) {}
  }

  const prefs = {
    get: function (key, fallback) {
      return Object.prototype.hasOwnProperty.call(globalPrefs, key) ? globalPrefs[key] : fallback;
    },
    set: function (key, value) {
      globalPrefs[key] = value;
      writeJson(PREF_KEY, globalPrefs);
      emit({ key: key, value: value, seriesId: null });
      return value;
    },
    all: function () { return Object.assign({}, globalPrefs); },

    getFor: function (seriesId, key, fallback) {
      const bag = seriesId && seriesPrefs[seriesId];
      if (bag && Object.prototype.hasOwnProperty.call(bag, key)) return bag[key];
      return prefs.get(key, fallback);
    },
    setFor: function (seriesId, key, value) {
      if (!seriesId) return prefs.set(key, value);
      if (!seriesPrefs[seriesId]) seriesPrefs[seriesId] = {};
      seriesPrefs[seriesId][key] = value;
      writeJson(PREF_PER_KEY, seriesPrefs);
      emit({ key: key, value: value, seriesId: seriesId });
      return value;
    },
    clearFor: function (seriesId) {
      if (!seriesId || !seriesPrefs[seriesId]) return;
      delete seriesPrefs[seriesId];
      writeJson(PREF_PER_KEY, seriesPrefs);
      emit({ key: null, value: null, seriesId: seriesId });
    },

    on: function (fn) {
      prefListeners.add(fn);
      return function () { prefListeners.delete(fn); };
    },

    // Re-read both pref blobs after someone rewrote localStorage out of band —
    // the platform layer's mirror restore on the first launch after a WebKit
    // eviction. Synchronous, like everything else here; broadcasts the same
    // shape as the cross-tab storage handler below: a null key means
    // "anything may have changed, re-read what you care about".
    reload: function () {
      globalPrefs = readJson(PREF_KEY, {});
      seriesPrefs = readJson(PREF_PER_KEY, {});
      emit({ key: null, value: null, seriesId: null });
    },
  };

  // Keep prefs coherent across tabs of the same PWA.
  window.addEventListener('storage', function (e) {
    if (e.key === PREF_KEY)     { globalPrefs = readJson(PREF_KEY, {});     emit({ key: null, value: null, seriesId: null }); }
    if (e.key === PREF_PER_KEY) { seriesPrefs = readJson(PREF_PER_KEY, {}); emit({ key: null, value: null, seriesId: null }); }
  });

  // ── Public API ────────────────────────────────────────────────────────────

  window.Store = {
    listUserSeries, getUserSeries, putUserSeries, deleteUserSeries,
    getChapter, putChapter, deleteChapter, listCachedChapterIds, clearChapters,
    pruneChapterCache, estimateUsage,
    getProgress, putProgress, listProgress, deleteProgress,
    getDayLog, putDayLog, listDayLogs, clearDayLogs,
    listThoughts, putThought, deleteThought,
    putBlob, getBlob, deleteBlob,
    prefs: prefs,
    // Diagnostics — true when IndexedDB was unavailable and we fell back to RAM.
    isMemoryOnly: function () { return memoryMode; },
  };

  // Warm the connection so the first real call is fast and memoryMode is known.
  openDb();
})();
