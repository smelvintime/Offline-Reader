// Offline Reader — platform bridge. See docs/ARCHITECTURE.md §2.3 and
// docs/mobile/PLAN.md §2.2 / §5.2 / §6.1.
//
// The ONE module allowed to talk to Capacitor. Everything native — dialogs,
// haptics, the status bar, the Preferences mirror, the filesystem, the or-zip
// plugin — is reached through window.Capacitor.Plugins.* behind feature checks,
// never imported (no bundler, no build step; the native runtime injects the
// global, the web build never has it). On the plain web every method degrades
// to a web fallback or a resolved no-op, `isNative` is false, and `ready`
// resolves in the same microtask so Catalogue.boot() is not delayed.
//
// Nothing here registers or unregisters service workers — reader.js gates its
// own registration on Platform.isNative and that is the whole story.

(function () {
  'use strict';

  const Cap = window.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const os = !isNative ? 'web'
    : (Cap.getPlatform() === 'ios' ? 'ios'
    : (Cap.getPlatform() === 'android' ? 'android' : 'web'));

  // Plugins are looked up at call time, not captured at parse time: a plugin
  // that failed to load (or a test page that stubs one in later) should change
  // behavior without a reload. Missing plugin → null → the web fallback runs.
  function plugin(name) {
    return (isNative && Cap.Plugins && Cap.Plugins[name]) || null;
  }

  // Bridge writes for source blobs are capped: anything bigger must arrive by
  // native file move (archives.importFromUri) so archive bytes never cross the
  // bridge as base64. 64 MB is the EPUB/TXT retention bound from PLAN.md §6.1.
  const MAX_SOURCE_BLOB = 64 * 1024 * 1024;

  // Chunk size for the user-initiated IDB→filesystem migration. 8 MB of blob
  // becomes ~11 MB of transient base64 per slice — bounded, per the delegation
  // addendum in docs/mobile/tasks/assignments.md.
  const MIGRATE_SLICE = 8 * 1024 * 1024;

  // ── Small helpers ─────────────────────────────────────────────────────────

  // DOMContentLoaded as a promise. Native init waits on it before touching
  // Store or reader.js exports: classic-script microtasks can interleave
  // between <script> tasks, and platform.js loads FIRST in the contract order,
  // so "after DOMContentLoaded" is the only moment every consumer is
  // guaranteed parsed.
  const domReady = new Promise(function (resolve) {
    if (document.readyState !== 'loading') { resolve(); return; }
    document.addEventListener('DOMContentLoaded', function () { resolve(); });
  });

  // Filesystem.getUri hands back file:// URIs with percent-encoding; the
  // or-zip plugin and the Filesystem path fields want raw absolute paths.
  function toPath(uri) {
    let p = String(uri || '');
    if (p.indexOf('file://') === 0) p = p.slice('file://'.length);
    try { return decodeURIComponent(p); } catch (e) { return p; }
  }

  function basename(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i === -1 ? s : s.slice(i + 1);
  }

  function localDateStr() {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Blob → base64 without the data: prefix, for Filesystem write/append.
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () {
        const s = String(r.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      r.onerror = function () { reject(r.error || new Error('read failed')); };
      r.readAsDataURL(blob);
    });
  }

  // base64 → Blob for archives.read. Decoded in one pass; the ≤64 MB guard
  // keeps the peak bounded.
  function base64ToBlob(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes]);
  }

  // ── Preference durability (PLAN.md §2.2) ──────────────────────────────────
  //
  // iOS can evict WKWebView localStorage under storage pressure. The native
  // Preferences plugin survives that, so we keep a mirror of the keys that
  // matter and restore them on launch — ONLY the ones localStorage lost. A key
  // that exists locally always wins: the mirror is eviction insurance, never a
  // second source of truth.
  //
  // `or.timer` is deliberately NOT in this list: resurrecting a countdown that
  // "expired" during an eviction would chime at the user minutes later for a
  // timer they never saw survive. Losing it is the accepted cost (PLAN.md §5.1).
  const MIRRORED_KEYS = ['or.prefs', 'or.prefs.series', 'or.library', 'or.gap', 'or.autoscroll'];

  // The two Store pref blobs are also copied whenever prefs change (or:prefs
  // fires for every Store.prefs write). The raw reader keys (or.library,
  // or.gap, or.autoscroll) never emit events — their only mirror moment is the
  // hide-time copy below, which bounds loss to "changes since the last hide"
  // on a hard crash. Same bound the web app already lives with.
  const PREF_BLOB_KEYS = ['or.prefs', 'or.prefs.series'];

  function copyKeysToMirror(keys) {
    const Preferences = plugin('Preferences');
    if (!Preferences) return;
    keys.forEach(function (key) {
      let value = null;
      try { value = localStorage.getItem(key); } catch (e) { /* storage gone — nothing to copy */ }
      if (value === null) return; // never erase the mirror; an absent key may be the eviction we insure against
      Preferences.set({ key: key, value: value }).catch(function () { /* mirror write is best-effort */ });
    });
  }

  async function restoreMirror() {
    const Preferences = plugin('Preferences');
    if (!Preferences) return 0;
    let restored = 0;
    for (const key of MIRRORED_KEYS) {
      try {
        let live = null;
        try { live = localStorage.getItem(key); } catch (e) {}
        if (live !== null) continue; // live data wins, always
        const r = await Preferences.get({ key: key });
        if (r && typeof r.value === 'string' && r.value !== '') {
          try { localStorage.setItem(key, r.value); restored++; } catch (e) { /* quota — degraded but not fatal */ }
        }
      } catch (e) { /* one bad key must not block the rest */ }
    }
    return restored;
  }

  let prefsCopyTimer = null;
  function wireMirrorListeners() {
    // Store pref writes → debounced blob copy. 2 s means a settings-sheet
    // drag session costs one bridge trip, not fifty.
    window.addEventListener('or:prefs', function () {
      clearTimeout(prefsCopyTimer);
      prefsCopyTimer = setTimeout(function () { copyKeysToMirror(PREF_BLOB_KEYS); }, 2000);
    });

    // Hide-time copy of EVERY mirrored key. Registration order is load-bearing
    // (PLAN.md §2.2): reader.js attaches its own visibilitychange handler at
    // parse time and performs the final saveToLibrary() into or.library there.
    // Registering ours inside DOMContentLoaded — which fires after every
    // classic script has executed — puts it behind reader's in the same-target
    // FIFO dispatch, so the mirror snapshots a CURRENT or.library instead of
    // being one save behind at kill time.
    domReady.then(function () {
      const copyAll = function () {
        clearTimeout(prefsCopyTimer); // a pending debounce is superseded by the full copy
        copyKeysToMirror(MIRRORED_KEYS);
      };
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) copyAll();
      });
      window.addEventListener('pagehide', copyAll);
    });
  }

  // ── Device memory class (PLAN.md §2.2 / §9) ───────────────────────────────

  // Resolved once during native init and cached: memoryClass() is synchronous
  // by contract (consumers read it mid-boot), while Device.getInfo() is not.
  let iosModelClass = null;

  // iOS ships no navigator.deviceMemory, so the machine identifier is the
  // signal. Models with ≤3 GB RAM → 'low', ≥6 GB → 'high', anything unknown or
  // in between → 'mid'. The table is deliberately coarse — generations, not an
  // exhaustive model list — because the pref override (platform.memoryClass,
  // visible UI in the importer manage view) is the escape hatch for anything
  // it misjudges.
  function classifyIosModel(model) {
    const m = /^(iPhone|iPad|iPod)(\d+),(\d+)$/.exec(String(model || ''));
    if (!m) return 'mid';
    const family = m[1];
    const major = parseInt(m[2], 10);
    const minor = parseInt(m[3], 10);

    if (family === 'iPod') return 'low'; // every iPod touch topped out at 2 GB

    if (family === 'iPhone') {
      if (major <= 10) return 'low';                       // through iPhone 8/X: 1–3 GB
      if (major === 11) return minor === 8 ? 'low' : 'mid'; // XR (11,8) is 3 GB; XS/Max 4 GB
      if (major === 12) return minor === 8 ? 'low' : 'mid'; // SE 2nd gen (12,8) is 3 GB; 11s 4 GB
      if (major === 13) return minor >= 3 ? 'high' : 'mid'; // 12 Pro/Max 6 GB; 12/mini 4 GB
      if (major === 14) return (minor === 2 || minor === 3) ? 'high' : 'mid'; // 13 Pro/Max 6 GB; 13/mini/SE3 4 GB
      return 'high';                                        // iPhone 14 generation onward: 6–8 GB
    }

    // iPads: non-Pro models lagged phones by years on RAM.
    if (major <= 7) return 'low';                           // through 2017 iPads: 2–3 GB (Pro 10.5 excepted — coarse on purpose)
    if (major === 11) return 'low';                         // Air 3 / mini 5: 3 GB
    if (major === 12) return 'low';                         // iPad 9th gen: 3 GB
    if (major === 13) return (minor >= 4 && minor <= 11) ? 'high' : 'mid'; // M1 Pros 8–16 GB; Air 4 / 10th gen 4 GB
    if (major >= 14) return (minor >= 3) ? 'high' : 'mid';  // M2 Pro / M2 Air 8 GB; mini 6 4 GB
    return 'mid';
  }

  function memoryClass() {
    // (1) Explicit user override — validated on read like every pref.
    let pref = null;
    try {
      if (window.Store && window.Store.prefs) pref = window.Store.prefs.get('platform.memoryClass', null);
    } catch (e) {}
    if (pref === 'low' || pref === 'mid' || pref === 'high') return pref;

    // (2) Android: Chromium exposes navigator.deviceMemory (GB, quantized).
    if (os === 'android') {
      const dm = navigator.deviceMemory;
      if (typeof dm === 'number' && isFinite(dm)) {
        if (dm <= 2) return 'low';
        if (dm >= 6) return 'high';
        return 'mid';
      }
    }

    // (3) iOS: the model table, resolved during init.
    if (os === 'ios' && iosModelClass) return iosModelClass;

    // (4) Inconclusive → mid.
    return 'mid';
  }

  // The §9 memory-budget table, copied exactly. Consumers re-read at session
  // start, not per frame; a copy is returned so nobody can mutate the rows.
  const TUNING = {
    low:  { memoryWindow: 12, cacheWindow: 30, lookBehind: 2, lookAhead: 6,  maxLoadedChapters: 6,  chapterCacheMB: 100, pageCacheMB: 200 },
    mid:  { memoryWindow: 25, cacheWindow: 60, lookBehind: 4, lookAhead: 10, maxLoadedChapters: 10, chapterCacheMB: 200, pageCacheMB: 400 },
    high: { memoryWindow: 35, cacheWindow: 80, lookBehind: 6, lookAhead: 12, maxLoadedChapters: 14, chapterCacheMB: 300, pageCacheMB: 600 },
  };

  function tuning() {
    return Object.assign({}, TUNING[memoryClass()] || TUNING.mid);
  }

  // ── Core API (PLAN.md §2.2) ───────────────────────────────────────────────

  async function appVersion() {
    const App = plugin('App');
    if (!App) return null;
    try {
      const info = await App.getInfo();
      return (info && info.version) || null;
    } catch (e) { return null; }
  }

  async function confirm(opts) {
    const o = opts || {};
    const Dialog = plugin('Dialog');
    if (Dialog) {
      try {
        const r = await Dialog.confirm({
          title: o.title || '',
          message: o.message || '',
          okButtonTitle: o.okLabel || 'OK',
          cancelButtonTitle: o.cancelLabel || 'Cancel',
        });
        return !!(r && r.value);
      } catch (e) { /* fall through to the browser dialog */ }
    }
    try { return window.confirm(o.message || ''); } catch (e) { return false; }
  }

  function haptic(kind) {
    const Haptics = plugin('Haptics');
    if (!Haptics) return; // no-op on web
    try {
      if (kind === 'light')        Haptics.impact({ style: 'LIGHT' }).catch(function () {});
      else if (kind === 'medium')  Haptics.impact({ style: 'MEDIUM' }).catch(function () {});
      else if (kind === 'success') Haptics.notification({ type: 'SUCCESS' }).catch(function () {});
      else if (kind === 'warning') Haptics.notification({ type: 'WARNING' }).catch(function () {});
    } catch (e) { /* haptics are decoration; never let them throw */ }
  }

  // ── Reminders-ready seam (PLAN.md §5.2) ───────────────────────────────────
  //
  // Goals renders its reminder rows only when canNotify() is true. It never
  // is, in this cycle: a later opt-in @capacitor/local-notifications install
  // lights this up without any goals change (the user decision is §11.4).
  const notify = {
    canNotify: function () { return false; },
    scheduleDaily: function () { return Promise.resolve(false); },
    cancelDaily: function () { return Promise.resolve(); },
  };

  // ── Native file picking (PLAN.md §6.1) ────────────────────────────────────

  // The picker dependency is chosen (capacitor-scaffold) for two properties
  // this app cannot live without: files are copied into the app cache so the
  // returned path is directly readable (no content:// handling in JS), and
  // `name`/`size` are the ORIGINALS — file identity is
  // hash(name.toLowerCase() + ':' + size) and renaming would fork every id.
  const ACCEPT_MIME = {
    '.cbz':  ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
    '.zip':  ['application/zip', 'application/x-zip-compressed'],
    '.epub': ['application/epub+zip'],
    '.txt':  ['text/plain'],
  };

  function acceptToTypes(accept) {
    if (!accept) return null;
    const out = [];
    const parts = String(accept).split(',');
    for (const part of parts) {
      const ext = part.trim().toLowerCase();
      const mimes = ACCEPT_MIME[ext];
      if (!mimes) return null; // unknown extension → no type filter; the caller's kindOfFile dispatch sorts it out
      mimes.forEach(function (mm) { if (out.indexOf(mm) === -1) out.push(mm); });
    }
    return out.length ? out : null;
  }

  async function pickFiles(opts) {
    const o = opts || {};
    const FilePicker = plugin('FilePicker');
    if (!FilePicker) return null; // null = no native picker; caller falls back to its <input>
    try {
      const req = { readData: false, limit: o.multiple ? 0 : 1 };
      const types = acceptToTypes(o.accept);
      if (types) req.types = types;
      const r = await FilePicker.pickFiles(req);
      const files = (r && r.files) || [];
      const out = [];
      for (const f of files) {
        if (!f || !f.path) continue; // no readable path → unusable; skip rather than fail the batch
        out.push({ name: f.name, size: f.size, uri: f.path });
      }
      return out;
    } catch (e) {
      // Cancel is the expected outcome of most picker opens. An empty list —
      // not null — so the caller does nothing instead of opening the <input>
      // on top of a dialog the user just dismissed.
      return [];
    }
  }

  async function readPickedFile(picked) {
    if (!isNative || !picked || !picked.uri || !Cap || typeof Cap.convertFileSrc !== 'function') return null;
    try {
      const res = await fetch(Cap.convertFileSrc(picked.uri));
      if (!res.ok) return null;
      const blob = await res.blob();
      // The ORIGINAL name is stamped back on. kindOfFile dispatches on the
      // extension and file identity hashes the name — a cache-copy filename
      // here would silently fork both.
      return new File([blob], picked.name, { type: blob.type || '' });
    } catch (e) {
      console.warn('[Platform] readPickedFile failed');
      return null;
    }
  }

  // ── Filesystem paths ──────────────────────────────────────────────────────

  // Resolved once during init: pageUrl() is synchronous by contract, so the
  // async getUri round-trip cannot live inside it. The iOS container path
  // embeds a UUID that changes on every app update — which is exactly why
  // pageUrl output is session-local BY DESIGN and must never be persisted
  // (PLAN.md §6.1; the resolver treats any stored capacitor URL as stale).
  let cacheRootPath = null;   // absolute path of the CACHE directory
  let archivesReady = null;   // memoized mkdir of Data/archives

  async function resolveCacheRoot() {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return;
    try {
      try { await Filesystem.mkdir({ path: 'pages', directory: 'CACHE', recursive: true }); } catch (e) { /* exists */ }
      const r = await Filesystem.getUri({ path: 'pages', directory: 'CACHE' });
      const p = toPath(r && r.uri);
      // Strip the trailing '/pages' so any relative cache path joins cleanly.
      cacheRootPath = p.replace(/\/pages\/?$/, '');
    } catch (e) {
      console.warn('[Platform] cache root unavailable');
    }
  }

  function ensureArchivesDir() {
    if (archivesReady) return archivesReady;
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return Promise.resolve();
    archivesReady = Filesystem.mkdir({ path: 'archives', directory: 'DATA', recursive: true })
      .catch(function () { /* already exists */ });
    return archivesReady;
  }

  async function archiveAbsPath(key) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return null;
    try {
      const r = await Filesystem.getUri({ path: 'archives/' + key, directory: 'DATA' });
      return toPath(r && r.uri);
    } catch (e) { return null; }
  }

  function pageUrl(relPath) {
    if (!isNative || !cacheRootPath || !Cap || typeof Cap.convertFileSrc !== 'function') return null;
    const rel = String(relPath || '');
    // A '..' segment could walk the URL out of the cache dir. Nothing
    // legitimate ever produces one — zip.extract returns clean
    // 'pages/<dir>/<file>' strings — so reject rather than resolve.
    if (!rel || rel.split('/').indexOf('..') !== -1) return null;
    return Cap.convertFileSrc(cacheRootPath + '/' + rel);
  }

  // ── or-zip bridge (PLAN.md §6.1; pinned interface in assignments.md) ──────
  //
  // The plugin is central-directory-listing + streamed selective extraction,
  // nothing else. Entry bytes NEVER enter the webview: list returns
  // names+sizes, extract writes to Cache/pages/ and returns paths.
  //
  // Three source forms (PLAN7 §2.11-B):
  //   { uri }       — absolute path or file:// URI (a freshly picked file)
  //   { key }       — an archive stored under Data/archives
  //   { cachePath } — a RELATIVE path under the cache root (the pageUrl
  //                   root), e.g. 'pages/import-inner/<key>/<inner>.cbz' as
  //                   returned by a prior zip.extract — the nested-zip path:
  //                   the inner CBZ is extracted to disk once and then
  //                   indexed/read in place, so its bytes never fall back to
  //                   the JS blob path.

  async function zipSrcPath(src) {
    if (!src) return null;
    if (src.uri) return toPath(src.uri);
    if (src.key) {
      await ensureArchivesDir();
      return await archiveAbsPath(src.key);
    }
    if (typeof src.cachePath === 'string') {
      // Same containment rule as pageUrl(): relative only, no '..' segments.
      // The joined absolute path still faces or-zip's own outside-container
      // rejection — this check is the polite refusal, that one is the wall.
      if (!cacheRootPath) return null; // web, or cache root unresolved
      const rel = src.cachePath;
      if (!rel || rel.charAt(0) === '/' || rel.split('/').indexOf('..') !== -1) return null;
      return cacheRootPath + '/' + rel;
    }
    return null;
  }

  async function zipList(src) {
    const OrZip = plugin('OrZip');
    if (!OrZip) return null;
    try {
      const path = await zipSrcPath(src);
      if (!path) return null;
      const r = await OrZip.list({ path: path });
      return (r && r.entries) || null;
    } catch (e) {
      console.warn('[Platform] zip.list failed');
      return null;
    }
  }

  async function zipExtract(src, entryNames, cacheDirKey) {
    const OrZip = plugin('OrZip');
    const Filesystem = plugin('Filesystem');
    if (!OrZip || !Filesystem) return null;
    try {
      const path = await zipSrcPath(src);
      if (!path) return null;
      const relDir = 'pages/' + cacheDirKey;
      try { await Filesystem.mkdir({ path: relDir, directory: 'CACHE', recursive: true }); } catch (e) { /* exists */ }
      const u = await Filesystem.getUri({ path: relDir, directory: 'CACHE' });
      const destDir = toPath(u && u.uri);
      const r = await OrZip.extract({ path: path, entryNames: entryNames, destDir: destDir });
      const abs = (r && r.paths) || null;
      if (!abs) return null;
      // Relative paths out — 'pages/<cacheDirKey>/<file>', in entry order.
      // Absolute URLs are never returned from here; pageUrl() converts per
      // session (see the container-UUID note above).
      return abs.map(function (p) { return relDir + '/' + basename(p); });
    } catch (e) {
      console.warn('[Platform] zip.extract failed');
      return null;
    }
  }

  // ── Archive storage (PLAN.md §6.1) ────────────────────────────────────────

  async function importFromUri(key, uri) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return null;
    try {
      await ensureArchivesDir();
      const from = toPath(uri);
      const to = 'archives/' + key;
      try {
        // MOVE, not copy: the picked file is already a cache copy, and a
        // rename is instant regardless of size. Zero bytes touch JS.
        await Filesystem.rename({ from: from, to: to, toDirectory: 'DATA' });
      } catch (e) {
        // Cross-volume or plugin quirk — copy+delete does the same job slower.
        await Filesystem.copy({ from: from, to: to, toDirectory: 'DATA' });
        try { await Filesystem.deleteFile({ path: from }); } catch (e2) { /* stray cache copy; the OS reclaims it */ }
      }
      const st = await Filesystem.stat({ path: to, directory: 'DATA' });
      return { size: (st && st.size) || 0 };
    } catch (e) {
      console.warn('[Platform] archives.importFromUri failed');
      return null;
    }
  }

  async function archiveSave(key, blob) {
    // The guard applies everywhere so callers hit the same wall on every
    // platform: large archives must go through importFromUri.
    if (blob && blob.size > MAX_SOURCE_BLOB) {
      console.warn('[Platform] archives.save refused: ' + blob.size + ' bytes exceeds the 64 MB source-blob bound');
      return null;
    }
    const Filesystem = plugin('Filesystem');
    if (!Filesystem || !blob) return null;
    try {
      await ensureArchivesDir();
      const data = await blobToBase64(blob);
      await Filesystem.writeFile({ path: 'archives/' + key, directory: 'DATA', data: data, recursive: true });
      return { size: blob.size };
    } catch (e) {
      console.warn('[Platform] archives.save failed');
      return null;
    }
  }

  async function archiveRead(key) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return null;
    try {
      const path = 'archives/' + key;
      const st = await Filesystem.stat({ path: path, directory: 'DATA' });
      if (st && st.size > MAX_SOURCE_BLOB) {
        // A CBZ this size is read through Platform.zip, never into JS.
        console.warn('[Platform] archives.read refused: ' + st.size + ' bytes exceeds the 64 MB source-blob bound');
        return null;
      }
      const r = await Filesystem.readFile({ path: path, directory: 'DATA' });
      if (!r || typeof r.data !== 'string') return null;
      return base64ToBlob(r.data);
    } catch (e) {
      return null; // missing file is the expected miss, not an error
    }
  }

  async function archiveRemove(key) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return;
    try { await Filesystem.deleteFile({ path: 'archives/' + key, directory: 'DATA' }); } catch (e) { /* already gone */ }
  }

  async function releasePages(cacheDirKey) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return;
    try { await Filesystem.rmdir({ path: 'pages/' + cacheDirKey, directory: 'CACHE', recursive: true }); } catch (e) { /* already gone */ }
  }

  // Walk Cache/pages/ and collect the LEAF directories — the per-chapter page
  // dirs (cacheDirKeys may contain '/', e.g. seriesId/chapterId, so the tree
  // can be two levels deep). Each leaf gets a size and an mtime for the LRU.
  async function listPageDirs() {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return [];
    const leaves = [];
    async function walk(rel, depth) {
      if (depth > 4) return; // nothing legitimate nests deeper; don't chase cycles
      let listing;
      try { listing = await Filesystem.readdir({ path: rel, directory: 'CACHE' }); } catch (e) { return; }
      const files = (listing && listing.files) || [];
      const subdirs = files.filter(function (f) { return f.type === 'directory'; });
      const plain = files.filter(function (f) { return f.type !== 'directory'; });
      if (subdirs.length === 0) {
        if (rel === 'pages') return; // an empty root is not a leaf
        let bytes = 0, mtime = 0;
        plain.forEach(function (f) {
          bytes += f.size || 0;
          if (f.mtime && f.mtime > mtime) mtime = f.mtime;
        });
        leaves.push({ rel: rel, bytes: bytes, mtime: mtime });
        return;
      }
      for (const d of subdirs) await walk(rel + '/' + d.name, depth + 1);
    }
    await walk('pages', 0);
    return leaves;
  }

  async function prunePageCache(maxBytes) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return { removedDirs: 0, bytes: 0 };
    try {
      const dirs = await listPageDirs();
      let total = 0;
      dirs.forEach(function (d) { total += d.bytes; });
      if (total <= maxBytes) return { removedDirs: 0, bytes: 0 };
      // Oldest directory mtime first — extraction touches the dir, so mtime is
      // a serviceable "last used" signal without bookkeeping of our own.
      dirs.sort(function (a, b) { return a.mtime - b.mtime; });
      let removedDirs = 0, bytes = 0;
      for (const d of dirs) {
        if (total <= maxBytes) break;
        try {
          await Filesystem.rmdir({ path: d.rel, directory: 'CACHE', recursive: true });
          removedDirs++;
          bytes += d.bytes;
          total -= d.bytes;
        } catch (e) { /* skip what will not delete; the loop still converges */ }
      }
      return { removedDirs: removedDirs, bytes: bytes };
    } catch (e) {
      console.warn('[Platform] archives.prunePageCache failed');
      return { removedDirs: 0, bytes: 0 };
    }
  }

  async function archivesUsage() {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return null;
    try {
      let archiveBytes = 0;
      try {
        const listing = await Filesystem.readdir({ path: 'archives', directory: 'DATA' });
        ((listing && listing.files) || []).forEach(function (f) { archiveBytes += f.size || 0; });
      } catch (e) { /* no archives yet */ }
      let pageCacheBytes = 0;
      (await listPageDirs()).forEach(function (d) { pageCacheBytes += d.bytes; });
      return { archiveBytes: archiveBytes, pageCacheBytes: pageCacheBytes };
    } catch (e) { return null; }
  }

  // Delegation addendum (assignments.md header): the manage-view "Move library
  // to device storage" migration. Web-era archives live in IndexedDB; pushing
  // one through the bridge whole would be the exact OOM Phase 5 eliminates, so
  // the blob crosses in 8 MB slices. Idempotent per archive: a destination
  // already present with the right size is skipped, so a retry resumes the
  // batch instead of rewriting finished files. onProgress (optional) receives
  // a 0..1 fraction after each slice.
  async function migrateBlob(key, blob, onProgress) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem || !blob) return null;
    const report = typeof onProgress === 'function'
      ? function (f) { try { onProgress(f); } catch (e) {} }
      : function () {};
    try {
      await ensureArchivesDir();
      const path = 'archives/' + key;
      try {
        const st = await Filesystem.stat({ path: path, directory: 'DATA' });
        if (st && st.size === blob.size) { report(1); return { size: blob.size }; }
        // Wrong size = an interrupted earlier run; start clean.
        await Filesystem.deleteFile({ path: path, directory: 'DATA' });
      } catch (e) { /* no destination yet — the normal case */ }

      let written = 0;
      while (written < blob.size) {
        const slice = blob.slice(written, Math.min(written + MIGRATE_SLICE, blob.size));
        const data = await blobToBase64(slice);
        if (written === 0) {
          await Filesystem.writeFile({ path: path, directory: 'DATA', data: data, recursive: true });
        } else {
          await Filesystem.appendFile({ path: path, directory: 'DATA', data: data });
        }
        written += slice.size;
        report(blob.size ? written / blob.size : 1);
      }
      return { size: blob.size };
    } catch (e) {
      console.warn('[Platform] archives.migrateBlob failed');
      return null; // a partial file has the wrong size, so the next run rewrites it
    }
  }

  // ── Deep links (PLAN.md §6.1/§6.2) ────────────────────────────────────────
  //
  // Custom-scheme links only (offlinereader://add?url=…) — what appUrlOpen
  // genuinely delivers once NATIVE_BUILD.md's Info.plist / intent-filter steps
  // are applied. Share-sheet intake is an explicit open question (§11.8), not
  // wired here.
  const urlOpenFns = new Set();
  function onAppUrlOpen(fn) {
    if (typeof fn === 'function') urlOpenFns.add(fn);
  }

  // ── Library backup (PLAN.md §6.1) ─────────────────────────────────────────

  const BACKUP_RE = /^library-\d{4}-\d{2}-\d{2}\.json$/;
  const BACKUP_KEEP = 3;

  async function listBackups(Filesystem) {
    try {
      const listing = await Filesystem.readdir({ path: 'backup', directory: 'DOCUMENTS' });
      return ((listing && listing.files) || [])
        .map(function (f) { return f.name; })
        .filter(function (n) { return BACKUP_RE.test(n); })
        .sort()
        .reverse(); // the date is the filename, so a name sort IS a date sort
    } catch (e) { return []; }
  }

  async function backupWrite(json) {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return false;
    try {
      const text = typeof json === 'string' ? json : JSON.stringify(json);
      await Filesystem.writeFile({
        path: 'backup/library-' + localDateStr() + '.json',
        directory: 'DOCUMENTS', // Documents survives cache purges; it is the point
        data: text,
        encoding: 'utf8',
        recursive: true,
      });
      const names = await listBackups(Filesystem);
      for (let i = BACKUP_KEEP; i < names.length; i++) {
        try { await Filesystem.deleteFile({ path: 'backup/' + names[i], directory: 'DOCUMENTS' }); } catch (e) {}
      }
      return true;
    } catch (e) {
      console.warn('[Platform] backup.write failed');
      return false;
    }
  }

  async function backupReadLatest() {
    const Filesystem = plugin('Filesystem');
    if (!Filesystem) return null;
    try {
      const names = await listBackups(Filesystem);
      if (!names.length) return null;
      const r = await Filesystem.readFile({ path: 'backup/' + names[0], directory: 'DOCUMENTS', encoding: 'utf8' });
      return (r && typeof r.data === 'string') ? r.data : null;
    } catch (e) { return null; }
  }

  // ── Status bar follows the app theme (PLAN7 §2.9) ─────────────────────────
  //
  // The shell theme (`app.theme`, written and applied by settings.js) decides
  // whether the OS status bar draws light-on-dark or dark-on-light text. The
  // background luminance of the nine named palettes is known, so the two sets
  // are static data here; `custom` defers to the data-applum attribute
  // settings.js stamps on <html> from the custom background at apply time.
  // settings.js absent → the pref is never written → 'dark', which is exactly
  // the app's permanent-dark fallback (PLAN7 §0.5).
  const LIGHT_APP_THEMES = ['light', 'cream', 'sepia', 'tan'];
  const DARK_APP_THEMES = ['dark', 'dim', 'black', 'nord', 'forest'];

  function appTheme() {
    let v = null;
    try {
      if (window.Store && window.Store.prefs) v = window.Store.prefs.get('app.theme', null);
    } catch (e) {}
    // Validated on read like every pref: anything unknown is the dark default.
    if (v === 'custom' || LIGHT_APP_THEMES.indexOf(v) !== -1 || DARK_APP_THEMES.indexOf(v) !== -1) return v;
    return 'dark';
  }

  // Capacitor style names are about the BAR, not the text: 'DARK' = dark bar,
  // light text; 'LIGHT' = light bar, dark text.
  function statusBarStyle() {
    const theme = appTheme();
    if (theme === 'custom') {
      // settings.js computes data-applum ('dark' | 'light') from the custom
      // bg's luminance — reuse its judgment instead of re-deriving it here.
      return document.documentElement.dataset.applum === 'light' ? 'LIGHT' : 'DARK';
    }
    return LIGHT_APP_THEMES.indexOf(theme) !== -1 ? 'LIGHT' : 'DARK';
  }

  function applyStatusBarStyle() {
    const StatusBar = plugin('StatusBar');
    if (!StatusBar) return;
    try { StatusBar.setStyle({ style: statusBarStyle() }).catch(function () {}); } catch (e) {}
  }

  let statusBarTimer = null;
  function wireStatusBarTheme() {
    // Key-gated exactly like settings.js's own live re-apply: only app.*
    // writes and bulk reloads (key null) matter — or:prefs also fires at
    // persistDay cadence for goals.lifetime (PLAN7 §2.3), and that must not
    // cost bridge trips.
    window.addEventListener('or:prefs', function (ev) {
      const key = ev && ev.detail ? ev.detail.key : undefined;
      if (key !== null && !(typeof key === 'string' && key.indexOf('app.') === 0)) return;
      // One task later, debounced: settings.js's listener on this same event
      // re-applies the theme (and re-stamps data-applum for custom) during
      // this dispatch, and listener order is not guaranteed — the timeout
      // reads the settled attribute and coalesces a burst of app.* writes
      // into one bridge call.
      clearTimeout(statusBarTimer);
      statusBarTimer = setTimeout(applyStatusBarStyle, 50);
    });
  }

  // ── Native boot ───────────────────────────────────────────────────────────

  async function nativeInit() {
    // iOS memory-class signal — resolved before ready so memoryClass() can
    // stay synchronous.
    if (os === 'ios') {
      const Device = plugin('Device');
      if (Device) {
        try {
          const info = await Device.getInfo();
          iosModelClass = classifyIosModel(info && info.model);
        } catch (e) { /* unknown → mid */ }
      }
    }

    await resolveCacheRoot();

    // Store and reader.js must be parsed before we can hand restored keys to
    // them; DOMContentLoaded is the first moment that is guaranteed.
    await domReady;

    const restored = await restoreMirror();
    if (restored > 0) {
      // The consumers already read their keys at parse time — before this
      // async restore could land. Re-point them at the restored values so the
      // FIRST post-eviction launch is correct, not the second.
      try {
        if (window.Store && window.Store.prefs && typeof window.Store.prefs.reload === 'function') {
          window.Store.prefs.reload();
        }
      } catch (e) { console.warn('[Platform] Store.prefs.reload failed'); }
      try {
        if (typeof window.reloadReaderPrefs === 'function') window.reloadReaderPrefs();
      } catch (e) { console.warn('[Platform] reloadReaderPrefs failed'); }
    }

    const StatusBar = plugin('StatusBar');
    if (StatusBar) {
      // Style follows app.theme (PLAN7 §2.9): settings.js applied the theme
      // at parse time and domReady has passed, so a custom theme's
      // data-applum is already stamped when this reads it.
      try { await StatusBar.setStyle({ style: statusBarStyle() }); } catch (e) {}
      if (os === 'android') {
        // Android-side option only: iOS WKWebView always draws under the
        // status bar; there the existing black-translucent meta +
        // viewport-fit=cover keep env(safe-area-inset-*) resolving.
        try { await StatusBar.setOverlaysWebView({ overlay: true }); } catch (e) {}
      }
    }
    // Live re-style on theme change — wired regardless of the lookup above
    // (plugins are looked up at call time by design, see plugin()).
    wireStatusBarTheme();

    const App = plugin('App');
    if (App) {
      try {
        // Android hardware back. Dispatch on the current screen; the two
        // reader screens exit through their OWN close paths — a raw goBack()
        // would only switch screens, leaving orphaned key handlers, a live
        // progress timer, and no final flush (PLAN.md §2.2). This table and
        // catalogue.js's popstate table are the same semantic table
        // (ARCHITECTURE §2.2 carries it once); every branch is guarded, so a
        // deleted optional module's row falls through to goBack() harmlessly
        // (PLAN7 §0.5).
        App.addListener('backButton', function () {
          try {
            const screen = (document.body && document.body.dataset.screen) || '';
            if (screen === 'novel-screen'
                && window.NovelReader && typeof window.NovelReader.close === 'function') {
              window.NovelReader.close({ navigate: true });
              return;
            }
            if (screen === 'reader-screen') {
              const btn = document.getElementById('close-btn');
              // The click runs BOTH registered close listeners: catalogue's
              // progress sync and reader.js's teardown/navigation.
              if (btn) { btn.click(); return; }
            }
            if (screen === 'home-screen' || screen === 'upload-screen') {
              if (typeof App.minimizeApp === 'function') App.minimizeApp().catch(function () {});
              return;
            }
            if (screen === 'loading-screen') {
              // Cancel: a transitional screen — catalogue shows it between
              // series and reader and it resolves to a reader on its own;
              // tearing it down mid-fetch from a gesture helps nobody.
              return;
            }
            if (screen === 'import-screen'
                && window.Importer && typeof window.Importer.close === 'function') {
              window.Importer.close();
              return;
            }
            if (screen === 'goals-screen'
                && window.Goals && typeof window.Goals.close === 'function') {
              window.Goals.close();
              return;
            }
            if (screen === 'settings-screen'
                && window.AppSettings && typeof window.AppSettings.close === 'function') {
              window.AppSettings.close();
              return;
            }
            if (screen === 'sources-screen'
                && window.Sources && typeof window.Sources.close === 'function') {
              window.Sources.close();
              return;
            }
            if (screen === 'thoughts-screen'
                && window.Thoughts && typeof window.Thoughts.close === 'function') {
              window.Thoughts.close();
              return;
            }
            // series-screen (explicit row) — and the fall-through for any
            // module screen whose module is absent.
            if (window.Catalogue && typeof window.Catalogue.goBack === 'function') {
              window.Catalogue.goBack();
            }
          } catch (e) { console.warn('[Platform] backButton dispatch failed'); }
        });
      } catch (e) {}
      try {
        App.addListener('appUrlOpen', function (ev) {
          const url = ev && ev.url;
          if (!url) return;
          urlOpenFns.forEach(function (fn) {
            try { fn(url); } catch (e) { console.warn('[Platform] appUrlOpen listener failed'); }
          });
        });
      } catch (e) {}
    }
  }

  // ready NEVER rejects, and on the web it resolves in the same microtask —
  // Catalogue.boot() awaits it unconditionally and web boot must not slow by
  // a frame.
  const ready = isNative
    ? nativeInit().catch(function (e) { console.warn('[Platform] native init failed', e); })
    : Promise.resolve();

  if (isNative) wireMirrorListeners();

  // Phase 1 contingency seam (PLAN.md §2.4, §11.5) — shipped DISABLED. If the
  // on-device origin gate fails (MangaDex / worker-proxied images refusing to
  // render from capacitor://localhost), remote images can be routed through
  // CapacitorHttp instead of the Cloudflare worker: reader.js already funnels
  // every online page URL through window.proxyImageUrl (reader.js:231-239), so
  // lighting this up needs zero reader changes. Left as a comment because the
  // gate is expected to pass (MangaDex sends ACAO:* and at-home pages load as
  // plain <img>); enable only if the Phase 1 device check says otherwise.
  //
  // if (isNative && !window.__platformProxyInstalled) {
  //   const httpBlobUrls = [];
  //   window.proxyImageUrl = function (url) {
  //     if (!/^https?:/i.test(url)) return url;
  //     // CapacitorHttp.get({ url, responseType: 'blob' }) → base64 → blob URL,
  //     // revoked by the reader's existing unloadDistant()/teardown discipline.
  //     return url; // placeholder — see PLAN.md §2.4 before enabling
  //   };
  // }

  // ── Public surface ────────────────────────────────────────────────────────

  window.Platform = {
    isNative: isNative,
    os: os,
    ready: ready,

    appVersion: appVersion,
    confirm: confirm,
    haptic: haptic,
    memoryClass: memoryClass,
    tuning: tuning,

    notify: notify,

    pickFiles: pickFiles,
    readPickedFile: readPickedFile,

    zip: {
      list: zipList,
      extract: zipExtract,
    },

    pageUrl: pageUrl,

    archives: {
      importFromUri: importFromUri,
      save: archiveSave,
      read: archiveRead,
      remove: archiveRemove,
      releasePages: releasePages,
      prunePageCache: prunePageCache,
      usage: archivesUsage,
      migrateBlob: migrateBlob,
    },

    onAppUrlOpen: onAppUrlOpen,

    backup: {
      write: backupWrite,
      readLatest: backupReadLatest,
    },
  };
})();
