// Offline Reader — catalogue, routing and the shared chapter resolver.
// Replaces the old js/online.js. See docs/ARCHITECTURE.md §1, §2.2, §4.
//
// This module owns navigation for the whole app: every other module asks
// `Catalogue` to move the user somewhere rather than calling `showScreen`
// itself, so there is exactly one place that knows what "back" means.
//
// It also owns `window.resolveChapterContent`, the single funnel through which
// any chapter payload — inline, external file, worker gateway — turns
// into a normalized ChapterFile. Putting it here (rather than in each reader)
// means the cache-first policy and the block normalization that forms our XSS
// boundary are written once and cannot drift between readers.
//
// Loaded as a classic script AFTER reader.js: it deliberately reads and writes
// reader.js's global lexical bindings (`pages`, `chapters`, `maxChapterNum`, …)
// because the image reader has no module API to hand off to.

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────

  const TABS = [
    { id: 'all',        label: 'All' },
    { id: 'manga',      label: 'Manga' },
    { id: 'manhwa',     label: 'Manhwa' },
    { id: 'lightnovel', label: 'Light Novels' },
    { id: 'library',    label: 'My Library' },
  ];

  const TEXT_TYPES  = new Set(['lightnovel', 'webnovel']);
  const BLOCK_TYPES = new Set(['p', 'h2', 'h3', 'h4', 'hr', 'blockquote', 'pre', 'ul', 'ol', 'img', 'note']);
  const WPM = 250;                 // average adult prose reading speed
  const MAX_RANGE_DOWNLOAD = 100;  // guard against a 3000-chapter "download all"

  // DOM is the scarcest resource on a phone. Chapter lists and card grids
  // render in chunks behind a "Show more" row instead of flooding thousands of
  // nodes at once — the full-rebuild philosophy stays, the build just stops
  // early (§9 budget: ≤250 rows, ≤200 cards before the seam).
  const CHAPTER_CHUNK = 250;
  const GRID_CHUNK    = 200;
  // Resolver cache writes between steady-state prunes. Ordinary online reading
  // is the biggest cache-growth path; waiting for a range download to prune
  // would let it balloon unbounded.
  const PRUNE_EVERY_WRITES = 25;

  let bundledSeries = [];   // from catalog.json (already migrated to v2 shape)
  let userSeries    = [];   // from Store.listUserSeries()
  let allSeries     = [];   // merged, user entries win on id collision
  let catalogError  = null; // truthy when the fetch failed — drives the error state

  let currentSeries  = null;
  let chapterSortAsc = false;
  let chapterQuery   = '';
  let cachedIds      = new Set(); // cached chapter ids for currentSeries
  let seriesProgress = null;      // Progress row for currentSeries

  let searchQuery  = '';
  let progressRows = [];
  let navStack     = [];          // screen ids, for goBack()
  let domReady     = false;
  let booted       = false;
  let focusHookFired = false;     // AppSettings.maybeOfferFocus fires once per boot (§2.1)

  let chapterRowLimit = CHAPTER_CHUNK; // rows before "Show more"; reset per series open
  let gridCardLimit   = GRID_CHUNK;   // cards before "Show more"; reset on tab/search change
  let rangeSelectsFor = null;         // series id the range <option>s were built for (lazy)

  // ─────────────────────────────────────────────────────────────────────────
  // Small utilities
  // ─────────────────────────────────────────────────────────────────────────

  function prefGet(key, fallback) {
    try { return window.Store ? window.Store.prefs.get(key, fallback) : fallback; }
    catch (e) { return fallback; }
  }
  function prefSet(key, value) {
    try { if (window.Store) window.Store.prefs.set(key, value); } catch (e) { /* prefs are not worth throwing over */ }
  }

  // ── Focus (PLAN7 §2.1) ───────────────────────────────────────────────────
  // The pref is settings-owned but read HERE, directly: with js/settings.js
  // deleted, a previously-written app.focus still steers every default below
  // — that is the intended read-time design. Focus shapes defaults while the
  // reader has not chosen; an explicit choice persists and focus never
  // overrides it.

  const FOCUS_VALUES = ['books', 'comics', 'both'];

  function readFocus() {
    const v = prefGet('app.focus', 'both');
    return FOCUS_VALUES.indexOf(v) !== -1 ? v : 'both';
  }

  // §2.1 effect 1: the fallback tab is focus-derived, and used only while
  // `catalogue.tab` is unset (or invalid). The moment the user taps a tab,
  // the stored pref wins and focus no longer influences it.
  function defaultTab() {
    const f = readFocus();
    if (f === 'books')  return 'lightnovel';
    if (f === 'comics') return 'manga';
    return 'all';
  }

  function currentTab()    { const t = prefGet('catalogue.tab', null);     return TABS.some(x => x.id === t) ? t : defaultTab(); }
  function currentLayout() { const l = prefGet('catalogue.layout', 'grid'); return l === 'list' ? 'list' : 'grid'; }

  // ── Home section registry (PLAN7 §2.12 / §1.2) ───────────────────────────
  // Five sections, ordered and toggled by `home.sections`. This getter is the
  // canonical read for RENDERING; settings.js mirrors the same validation in
  // its editor, so the editor always edits what the home screen actually
  // shows: unknown ids dropped, duplicates dropped, missing ids inserted at
  // their default position, `on` coerced boolean with missing leaning visible
  // (`e.on !== false` — hiding content is the worse failure), and `series`
  // coerced always-on. Keep the two implementations in lock-step.

  const SECTION_IDS = ['continue', 'goals', 'sources', 'latest', 'series'];

  // §2.1 effect 2: while the pref is UNSET the default order is focus-derived
  // — comics promotes Latest updates to directly under Continue (serialized
  // comics reading is release-driven); books/both keep today's order. Once
  // home.sections is written the stored array wins and focus never touches
  // it again.
  function defaultSections() {
    const order = readFocus() === 'comics'
      ? ['continue', 'latest', 'goals', 'sources', 'series']
      : ['continue', 'goals', 'sources', 'latest', 'series'];
    return order.map(function (id) { return { id: id, on: true }; });
  }

  function readHomeSections() {
    const dflt = defaultSections();
    const raw = prefGet('home.sections', null);
    if (!Array.isArray(raw)) return dflt;
    const seen = new Set();
    const out = [];
    raw.forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      const id = e.id;
      if (SECTION_IDS.indexOf(id) === -1 || seen.has(id)) return;
      seen.add(id);
      out.push({ id: id, on: id === 'series' ? true : e.on !== false });
    });
    dflt.forEach(function (d, i) {
      if (seen.has(d.id)) return;
      out.splice(Math.min(i, out.length), 0, { id: d.id, on: true });
      seen.add(d.id);
    });
    return out;
  }

  function sectionVisible(id) {
    const entry = readHomeSections().find(function (e) { return e.id === id; });
    return !entry || entry.on !== false;
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // Static, author-controlled SVG only. Never called with catalogue data.
  const ICONS = {
    grid:   '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    list:   '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    book:   '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    image:  '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    down:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    check:  '<polyline points="20 6 9 17 4 12"/>',
    play:   '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>',
    plus:   '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    trash:  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    sortD:  '<line x1="4" y1="6" x2="16" y2="6"/><line x1="4" y1="12" x2="12" y2="12"/><line x1="4" y1="18" x2="8" y2="18"/>',
    sortA:  '<line x1="4" y1="6" x2="8" y2="6"/><line x1="4" y1="12" x2="12" y2="12"/><line x1="4" y1="18" x2="16" y2="18"/>',
    chev:   '<polyline points="9 18 15 12 9 6"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    gear:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  };

  function icon(name, size) {
    const s = size || 14;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || ''; // static markup from the table above only
    return svg;
  }

  // Only http(s)/data:image/blob/relative may reach an <img src>. A catalogue is
  // third-party data; refusing exotic schemes here keeps that boundary explicit.
  //
  // Capacitor's local-file origins are the one addition: iOS serves extracted
  // pages from capacitor://localhost, Android re-serves them under
  // https://localhost with a /_capacitor_file_/ path. Both are pinned as EXACT
  // prefixes — origin plus path start, never a substring — so a lookalike
  // (capacitor://localhost.evil, some capacitor-evil scheme) still falls
  // through to the drop-everything-else rule below.
  function safeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
    if (/^capacitor:\/\/localhost\//i.test(u)) return u;
    if (/^https:\/\/localhost\/_capacitor_file_\//i.test(u)) return u;
    if (/^(https?:)/i.test(u)) return u;
    if (/^data:image\//i.test(u)) return u;
    if (/^blob:/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return ''; // some other scheme — drop it
    return u;                                        // relative path
  }

  function imgUrl(url) {
    const safe = safeImageUrl(url);
    if (!safe) return '';
    return window.proxyImageUrl ? window.proxyImageUrl(safe) : safe;
  }

  function safeHttpUrl(url) {
    return (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) ? url.trim() : '';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const diff = Math.floor((Date.now() - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff > 0 && diff < 7) return diff + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fmtWords(n) {
    if (!n) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M words';
    if (n >= 1000)    return Math.round(n / 1000) + 'k words';
    return n + ' words';
  }

  function readingTime(words) {
    if (!words) return '';
    const m = Math.max(1, Math.round(words / WPM));
    if (m < 60) return m + ' min read';
    const h = Math.floor(m / 60), r = m % 60;
    return h + 'h' + (r ? ' ' + r + 'm' : '') + ' read';
  }

  function countWords(str) {
    if (!str) return 0;
    const m = String(str).trim().match(/\S+/g);
    return m ? m.length : 0;
  }

  function isTextSeries(s) { return !!s && TEXT_TYPES.has(s.type); }

  function chapterLabel(ch) {
    if (ch.num != null) return 'Ch. ' + ch.num;
    return ch.title ? '' : '—';
  }

  function chapterName(ch) {
    if (ch.title) return ch.title;
    if (ch.num != null) return 'Chapter ' + ch.num;
    return 'Chapter';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tagged errors
  //
  // The resolver never lets a raw network failure escape: callers need to tell
  // "you are offline" apart from "this chapter has no payload" so they can show
  // something better than a spinner that never stops.
  // ─────────────────────────────────────────────────────────────────────────

  function catErr(code, message, cause) {
    const e = new Error(message || code);
    e.name = 'ChapterError';
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  const ERROR_TEXT = {
    'offline':          'You are offline — this chapter is not saved on this device yet.',
    'network':          'Could not reach the chapter. Check your connection and try again.',
    'parse':            'That chapter file could not be read.',
    'empty':            'That chapter came back empty.',
    'no-payload':       'This chapter has no readable content.',
    'gateway-disabled': 'This chapter needs the content gateway, which is not configured.',
  };
  function errorText(err) {
    return (err && ERROR_TEXT[err.code]) || 'Something went wrong loading that chapter.';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Store wrappers — the catalogue must render even if persistence is broken.
  // ─────────────────────────────────────────────────────────────────────────

  function store() { return window.Store || null; }

  async function safeCall(method, args, fallback) {
    const S = store();
    if (!S || typeof S[method] !== 'function') return fallback;
    try { return await S[method].apply(S, args || []); }
    catch (e) { console.warn('[Catalogue] Store.' + method + ' failed', e); return fallback; }
  }

  // Same absence tolerance for the platform bridge: the catalogue must behave
  // like the plain web app when js/platform.js is missing (test harnesses load
  // this file standalone).
  function platform() { return window.Platform || null; }
  function isNativeApp() { const P = platform(); return !!(P && P.isNative); }

  // ─────────────────────────────────────────────────────────────────────────
  // Catalogue normalization (schema v1 → v2)
  // ─────────────────────────────────────────────────────────────────────────

  function slugify(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  function inferType(raw) {
    const t = String(raw.type || '').toLowerCase();
    if (t === 'manga' || t === 'manhwa' || t === 'lightnovel' || t === 'webnovel') return t;
    if (t === 'novel' || t === 'ln') return 'lightnovel';
    // No declared type: let the payload speak. §1.1 says payload wins over type,
    // so a chapter carrying prose makes this a text series no matter what.
    const chs = Array.isArray(raw.chapters) ? raw.chapters : [];
    const textish = chs.some(function (c) {
      return c && (typeof c.text === 'string' || Array.isArray(c.blocks) || c.wordCount != null);
    });
    if (textish) return 'lightnovel';
    return 'manga';
  }

  function normalizeChapter(raw, idx, seriesId) {
    const ch = Object.assign({}, raw);
    // Some v1 rows carry no id of their own. Store keys need a stable one, so
    // fall back to whatever identifier the row does have before minting.
    if (!ch.id) {
      ch.id = raw.mdChapterId ||
              (raw.num != null ? 'c-' + String(raw.num).replace(/[^0-9.]/g, '') : '') ||
              ('c-' + idx);
    }
    ch.id = String(ch.id);
    ch.num = (raw.num != null && raw.num !== '' && isFinite(Number(raw.num))) ? Number(raw.num) : null;
    ch.title = typeof raw.title === 'string' ? raw.title : null;
    ch.seriesId = seriesId;
    return ch;
  }

  function normalizeSeries(raw, fallbackIdx) {
    if (!raw || typeof raw !== 'object') return null;
    const s = Object.assign({}, raw);

    s.type = inferType(raw);
    // §2.1 effect 3 needs to know whether the type was DECLARED or guessed:
    // after inference `type` is always canonical, so the "genuinely untyped"
    // fact must be captured here or it is lost. Recognized declarations are
    // exactly the strings inferType accepts without falling back to payload.
    const declared = String(raw.type || '').toLowerCase();
    s.untyped = ['manga', 'manhwa', 'lightnovel', 'webnovel', 'novel', 'ln'].indexOf(declared) === -1;
    s.title = typeof raw.title === 'string' && raw.title ? raw.title : 'Untitled';
    // v1 entries were keyed by `source` + `slug`/`mdId`; synthesize the same id
    // the v2 scraper would emit so progress written under v1 keeps resolving.
    if (!s.id) {
      const src = raw.source || 'cat';
      const key = raw.slug || raw.mdId || slugify(s.title) || String(fallbackIdx);
      s.id = src + ':' + key;
    }
    s.id = String(s.id);
    s.altTitles = Array.isArray(raw.altTitles) ? raw.altTitles.filter(function (t) { return typeof t === 'string'; }) : [];
    s.genres    = Array.isArray(raw.genres) ? raw.genres.filter(function (t) { return typeof t === 'string'; }) : [];
    s.tags      = Array.isArray(raw.tags) ? raw.tags.filter(function (t) { return typeof t === 'string'; }) : [];
    s.author    = typeof raw.author === 'string' ? raw.author : (typeof raw.artist === 'string' ? raw.artist : '');
    s.status    = typeof raw.status === 'string' ? raw.status : '';
    s.description = typeof raw.description === 'string' ? raw.description : '';
    s.chapters  = (Array.isArray(raw.chapters) ? raw.chapters : []).map(function (c, i) {
      return normalizeChapter(c, i, s.id);
    });
    s.chapterCount = typeof raw.chapterCount === 'number' ? raw.chapterCount : s.chapters.length;
    s.wordCount = s.chapters.reduce(function (n, c) { return n + (typeof c.wordCount === 'number' ? c.wordCount : 0); }, 0);
    return s;
  }

  function migrateCatalog(data) {
    if (!data || typeof data !== 'object') return [];
    const list = Array.isArray(data.series) ? data.series : (Array.isArray(data) ? data : []);
    // v1 had no `version` key. The only structural difference that matters to us
    // is the missing `type`/`id`, and normalizeSeries synthesizes both, so one
    // code path handles both schemas.
    return list.map(normalizeSeries).filter(Boolean);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Block normalization — the XSS boundary (ARCHITECTURE §1.3, §7.1)
  // ─────────────────────────────────────────────────────────────────────────

  function normalizeBlocks(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const b of raw) {
      if (b == null) continue;
      if (typeof b === 'string') { if (b.trim()) out.push({ t: 'p', c: b }); continue; }
      if (typeof b !== 'object') continue;
      const t = BLOCK_TYPES.has(b.t) ? b.t : 'p'; // unknown types degrade to p, never dropped
      if (t === 'hr') { out.push({ t: 'hr' }); continue; }
      if (t === 'img') {
        const src = safeImageUrl(b.src);
        if (!src) continue;
        out.push({ t: 'img', src: src, alt: typeof b.alt === 'string' ? b.alt : '' });
        continue;
      }
      if (t === 'ul' || t === 'ol') {
        const items = (Array.isArray(b.items) ? b.items : []).map(String).filter(function (x) { return x.trim(); });
        if (items.length) out.push({ t: t, items: items });
        continue;
      }
      const c = b.c != null ? String(b.c) : (b.text != null ? String(b.text) : '');
      if (c.trim()) out.push({ t: t, c: c });
    }
    return out;
  }

  // Inline `text` is plain prose. Blank lines are paragraph breaks; if the
  // source used single newlines only, fall back to those rather than emitting
  // one wall-of-text block.
  function textToBlocks(text) {
    const raw = String(text).replace(/\r\n?/g, '\n').trim();
    if (!raw) return [];
    let parts = raw.split(/\n[ \t]*\n+/);
    if (parts.length === 1 && raw.indexOf('\n') !== -1) parts = raw.split(/\n+/);
    return parts
      .map(function (p) { return p.replace(/\s*\n\s*/g, ' ').trim(); })
      .filter(Boolean)
      .map(function (p) { return { t: 'p', c: p }; });
  }

  function blocksWordCount(blocks) {
    return blocks.reduce(function (n, b) {
      if (b.c) return n + countWords(b.c);
      if (b.items) return n + b.items.reduce(function (m, i) { return m + countWords(i); }, 0);
      return n;
    }, 0);
  }

  function fileHasPayload(f) {
    return !!f && ((Array.isArray(f.blocks) && f.blocks.length) || (Array.isArray(f.pages) && f.pages.length));
  }

  // Build a ChapterFile from whatever a fetch returned: the bare file, or the
  // worker's `{ ok, chapter }` envelope.
  function normalizeChapterFile(raw, series, chapter) {
    const src = (raw && typeof raw === 'object' && raw.chapter && typeof raw.chapter === 'object') ? raw.chapter : raw;
    if (!src || typeof src !== 'object') throw catErr('parse', 'Chapter file was not an object');

    let blocks = null;
    if (Array.isArray(src.blocks) && src.blocks.length) blocks = normalizeBlocks(src.blocks);
    else if (typeof src.text === 'string' && src.text.trim()) blocks = textToBlocks(src.text);

    const pages = (Array.isArray(src.pages) ? src.pages : [])
      .map(function (p) { return typeof p === 'string' ? p : (p && typeof p.url === 'string' ? p.url : ''); })
      .filter(Boolean);

    // §1.1: renderers dispatch on payload shape. When a file somehow carries
    // both, series.type breaks the tie — an explicit author choice beats a guess.
    let kind;
    if (blocks && blocks.length && pages.length) kind = isTextSeries(series) ? 'text' : 'image';
    else if (blocks && blocks.length) kind = 'text';
    else if (pages.length) kind = 'image';
    else throw catErr('empty', 'Chapter file had neither blocks nor pages');

    const file = {
      seriesId: series.id,
      id: chapter.id,
      num: chapter.num != null ? chapter.num : (src.num != null ? src.num : null),
      title: chapter.title || src.title || null,
      kind: kind,
    };
    if (kind === 'text') {
      file.blocks = blocks;
      file.wordCount = typeof src.wordCount === 'number' ? src.wordCount : blocksWordCount(blocks);
    } else {
      file.pages = pages;
    }
    return file;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fetch helpers
  // ─────────────────────────────────────────────────────────────────────────

  async function fetchJson(url, errCode) {
    let res;
    try {
      res = await fetch(url, { credentials: 'omit' });
    } catch (e) {
      throw catErr(navigator.onLine ? (errCode || 'network') : 'offline', 'Fetch failed: ' + url, e);
    }
    if (!res.ok) throw catErr(errCode || 'network', 'HTTP ' + res.status + ' for ' + url);
    try { return await res.json(); }
    catch (e) { throw catErr('parse', 'Response was not JSON: ' + url, e); }
  }

  // `src` is relative to the app root unless it is already absolute.
  function resolveSrcUrl(src) {
    if (/^https?:\/\//i.test(src)) return src;
    if (src.charAt(0) === '/') return src;
    const base = (window.OR_CONFIG && window.OR_CONFIG.chapterBase) || './';
    // Paths that already name a directory are used as-is; bare filenames get
    // the configured chapter base prepended.
    if (src.indexOf('/') !== -1 || src.indexOf('./') === 0) return src.indexOf('./') === 0 ? src : './' + src;
    return base.replace(/\/*$/, '/') + src;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // window.resolveChapterContent — the one funnel (ARCHITECTURE §4)
  //
  // Order, cache-first:
  //   1. Store.getChapter
  //   2. inline blocks / pages / text on the Chapter
  //   3. chapter.src        (relative to app root, or absolute)
  //   4. worker /chapter?url=…   (only when OR_CONFIG.workerBase is set)
  // Whatever wins is normalized to a ChapterFile, written to Store, returned.
  //
  // There used to be a step between 3 and 4 that called one specific site's
  // API from the browser to expand a `mdChapterId` into page URLs. It was the
  // last place the app itself named a site, so it is gone (§8). A legacy v1
  // row carrying only that field now resolves through the gateway if it has a
  // URL, and otherwise fails honestly as `no-payload`.
  // ─────────────────────────────────────────────────────────────────────────

  const inflight = new Map(); // de-dupe concurrent resolves of the same chapter

  // blob: object URLs die with their session; Capacitor page URLs die with the
  // next app update (the iOS container path embeds a UUID that rotates on
  // every build). Finding one in a PERSISTED row means it leaked from an
  // earlier session and is a dead link — the row must re-hydrate, never render.
  function isSessionLocalPageUrl(u) {
    return typeof u === 'string' && (
      /^blob:/i.test(u) ||
      /^capacitor:\/\//i.test(u) ||
      u.indexOf('_capacitor_file_') !== -1
    );
  }

  async function resolveChapterContent(series, chapter) {
    if (!series || !series.id) throw catErr('no-payload', 'resolveChapterContent: series.id is required');
    if (!chapter || !chapter.id) throw catErr('no-payload', 'resolveChapterContent: chapter.id is required');

    const key = series.id + '\x00' + chapter.id;
    if (inflight.has(key)) return inflight.get(key);

    const job = (async function () {
      // 1 ── cache. Imported CBZ rows persist `entries` + `archiveKey` as the
      // durable truth; their `pages` are either empty (the modern shape) or
      // stale session-local URLs left behind by an earlier build. Either way
      // the archive re-yields live pages on demand. The hydrated file is
      // returned as-is and NEVER written back to Store — its page URLs are
      // session-local by design.
      let cached = await safeCall('getChapter', [series.id, chapter.id], null);
      if (cached && cached.archiveKey && Array.isArray(cached.entries) && cached.entries.length) {
        const pages = Array.isArray(cached.pages) ? cached.pages : [];
        if (!pages.length || pages.some(isSessionLocalPageUrl)) {
          if (window.Importer && typeof window.Importer.hydrateChapter === 'function') {
            let live = null;
            try { live = await window.Importer.hydrateChapter(series.id, chapter.id); }
            catch (e) { console.warn('[Catalogue] hydrateChapter failed', e); }
            if (fileHasPayload(live)) return live;
          }
          // No hydrator, or the archive is gone: treat the row as a cache
          // miss rather than hand a reader page URLs that cannot render.
          cached = null;
        }
      }
      if (fileHasPayload(cached)) return cached;

      let file = null;

      // 2 ── inline payloads
      if (Array.isArray(chapter.blocks) && chapter.blocks.length) {
        file = normalizeChapterFile({ blocks: chapter.blocks, wordCount: chapter.wordCount }, series, chapter);
      } else if (Array.isArray(chapter.pages) && chapter.pages.length) {
        file = normalizeChapterFile({ pages: chapter.pages }, series, chapter);
      } else if (typeof chapter.text === 'string' && chapter.text.trim()) {
        file = normalizeChapterFile({ text: chapter.text, wordCount: chapter.wordCount }, series, chapter);
      }

      // 3 ── external ChapterFile
      if (!file && chapter.src) {
        const json = await fetchJson(resolveSrcUrl(String(chapter.src)));
        file = normalizeChapterFile(json, series, chapter);
      }

      // 4 ── worker gateway
      if (!file) {
        const target = safeHttpUrl(chapter.url || chapter.sourceUrl || chapter.href);
        if (target) {
          const gw = window.gatewayUrl
            ? window.gatewayUrl('/chapter', { url: target, kind: isTextSeries(series) ? 'text' : 'image' })
            : null;
          if (!gw) throw catErr('gateway-disabled', 'No workerBase configured');
          const json = await fetchJson(gw);
          if (json && json.ok === false) throw catErr('network', json.message || json.error || 'Gateway error');
          file = normalizeChapterFile(json, series, chapter);
        }
      }

      if (!file) throw catErr('no-payload', 'Chapter ' + chapter.id + ' has no resolvable payload');

      await safeCall('putChapter', [series.id, chapter.id, file], file);
      noteChapterCacheWrite();
      return file;
    })();

    inflight.set(key, job);
    try { return await job; }
    finally { inflight.delete(key); }
  }

  window.resolveChapterContent = resolveChapterContent;

  // ─────────────────────────────────────────────────────────────────────────
  // Cache housekeeping (three triggers, one prune)
  //
  // The chapter cache used to be pruned only after range downloads, but the
  // most common growth path is ordinary online reading, which never touches
  // range download. So the same prune now fires: once per boot at idle, after
  // every 25 resolver cache writes (debounced), and after a range batch.
  // ─────────────────────────────────────────────────────────────────────────

  let cacheWriteCount = 0;
  let pruneDebounce   = null;

  function userSeriesIds() {
    return userSeries.map(function (s) { return s.id; });
  }

  async function runCachePrune() {
    const P = platform();
    if (!P || typeof P.tuning !== 'function') return;
    let t = null;
    try { t = P.tuning(); } catch (e) { /* no tuning row — nothing to size against */ }
    if (!t) return;

    // tuning() speaks in MB; the Store cap is bytes. Passing the raw MB count
    // through would set a ~200-byte budget and evict the entire cache — and a
    // missing row must not read as a zero-byte budget, which would do the
    // same, so anything non-positive prunes nothing.
    const chapterMB = t.chapterCacheMB;
    if (typeof chapterMB === 'number' && isFinite(chapterMB) && chapterMB > 0) {
      // Imported series' chapters are primary data, not cache — never evicted.
      await safeCall('pruneChapterCache', [{
        maxBytes: chapterMB * 1024 * 1024,
        protectSeriesIds: userSeriesIds(),
      }], null);
    }

    const pageMB = t.pageCacheMB;
    if (P.isNative && P.archives && typeof P.archives.prunePageCache === 'function'
        && typeof pageMB === 'number' && isFinite(pageMB) && pageMB > 0) {
      try { await P.archives.prunePageCache(pageMB * 1024 * 1024); }
      catch (e) { console.warn('[Catalogue] prunePageCache failed'); }
    }
  }

  // Steady-state trigger, counted at the resolver's putChapter site. The
  // debounce means a burst of writes (a range download also lands here)
  // schedules one prune after the dust settles, not one per threshold cross.
  function noteChapterCacheWrite() {
    cacheWriteCount++;
    if (cacheWriteCount < PRUNE_EVERY_WRITES) return;
    cacheWriteCount = 0;
    clearTimeout(pruneDebounce);
    pruneDebounce = setTimeout(function () { runCachePrune(); }, 10000);
  }

  // Boot trigger helper. Safari ships no requestIdleCallback, so a plain
  // timeout stands in — late enough that first paint and the boot fetches own
  // the frame budget, early enough that the prune still happens this session.
  function deferToIdle(fn) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: 10000 });
    } else {
      setTimeout(fn, 2000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOM construction
  //
  // index.html is owned by the integrator and only guarantees the containers
  // that already existed. Everything new is built here at init time and
  // appended, so index.html never has to change again for this module.
  // ─────────────────────────────────────────────────────────────────────────

  const dom = {};

  function ensureDom() {
    if (domReady) return;

    dom.homeBody      = document.getElementById('home-body');
    dom.homeState     = document.getElementById('home-state');
    dom.latestSection = document.getElementById('latest-section');
    dom.latestList    = document.getElementById('latest-updates-list');
    dom.seriesSection = document.getElementById('series-section');
    dom.seriesGrid    = document.getElementById('series-grid');
    dom.homeSearch    = document.getElementById('home-search');
    dom.seriesBody    = document.getElementById('series-body');
    dom.seriesHero    = document.getElementById('series-hero');
    dom.heroInfo      = document.getElementById('series-hero-info');
    dom.heroTitle     = document.getElementById('series-hero-title');
    dom.heroDesc      = document.getElementById('series-hero-desc');
    dom.heroMeta      = document.getElementById('series-hero-meta');
    dom.chapterList   = document.getElementById('series-chapter-list');
    dom.headerTitle   = document.getElementById('series-header-title');

    if (!dom.homeBody) { console.error('[Catalogue] #home-body missing — index.html is out of date'); return; }

    buildTabs();
    buildContinue();
    buildGoalsSlot();
    buildSourcesSlot();
    buildGridToolbar();
    buildEmptyState();
    buildSeriesExtras();
    buildToast();

    domReady = true;

    // First placement of the five registry sections (§2.12). After this the
    // fixed frame is #home-state → #cat-tabs → the sections in pref order.
    applySectionOrder();
  }

  // ── Section registry placement (PLAN7 §2.12) ─────────────────────────────
  // The five customizable sections, by registry id. #cat-tabs stays fixed
  // above everything customizable because the tab bar filters the whole home
  // (Latest and the grid alike), not just the grid. #latest-section and
  // #series-section are index.html-native: they are MOVED into position
  // (appendChild re-parents), never rebuilt — #series-section's internals
  // (toolbar, grid, chunking, empty state) travel with it as a sealed unit.

  function sectionNode(id) {
    if (id === 'continue') return dom.continueSection || null;
    if (id === 'goals')    return dom.goalsSlot || null;
    if (id === 'sources')  return dom.sourcesSlot || null;
    if (id === 'latest')   return dom.latestSection || null;
    if (id === 'series')   return dom.seriesSection || null;
    return null;
  }

  function applySectionOrder() {
    if (!domReady || !dom.homeBody) return;
    const entries = readHomeSections();
    const want = [];
    entries.forEach(function (entry) {
      const node = sectionNode(entry.id);
      if (!node) return;
      want.push(node);
      // Visibility: hidden sections are display:none at the root and their
      // render calls short-circuit (renderHome/renderContinue consult
      // sectionVisible before doing any work). The two slots have no other
      // display writer, so this is also where they are re-shown; Continue and
      // Latest own their visible-state display in their render paths, and
      // `series` is never hidden (`on` is coerced true on read).
      if (entry.id === 'goals' || entry.id === 'sources') {
        node.style.display = entry.on ? '' : 'none';
      } else if (!entry.on) {
        node.style.display = 'none';
      }
    });
    // Only touch the DOM when the live order differs — renderHome passes
    // through here on every render, and re-parenting five nodes for nothing
    // would churn layout (and drop focus) on every tab switch.
    const live = Array.prototype.filter.call(dom.homeBody.children, function (n) {
      return want.indexOf(n) !== -1;
    });
    const same = live.length === want.length && live.every(function (n, i) { return n === want[i]; });
    if (!same) {
      want.forEach(function (n) { dom.homeBody.appendChild(n); });
    }
    // The colophon (the AGPL §13 source offer) is index.html-native and sits
    // last in the markup, but the re-parenting above appends the five sections
    // AFTER it — which floated it up under the tab strip. It is a footer, so it
    // is re-appended here to stay the final child whatever order the sections
    // take. Cheap and idempotent: appendChild on a node already last is a no-op
    // move, and the guard keeps it out of the common path entirely.
    const colophon = dom.homeBody.querySelector(':scope > .colophon');
    if (colophon && dom.homeBody.lastElementChild !== colophon) {
      dom.homeBody.appendChild(colophon);
    }
  }

  function buildTabs() {
    const bar = el('div', 'cat-tabs');
    bar.id = 'cat-tabs';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Filter library by type');

    dom.tabButtons = {};
    TABS.forEach(function (t) {
      const b = el('button', 'cat-tab', t.label);
      b.id = 'cat-tab-' + t.id;
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'series-section');
      b.dataset.tab = t.id;
      b.addEventListener('click', function () { setTab(t.id); });
      b.addEventListener('keydown', onTabKeydown);
      dom.tabButtons[t.id] = b;
      bar.appendChild(b);
    });

    dom.tabs = bar;
    dom.homeBody.insertBefore(bar, dom.homeState ? dom.homeState.nextSibling : dom.homeBody.firstChild);

    if (dom.seriesSection) {
      dom.seriesSection.setAttribute('role', 'tabpanel');
      dom.seriesSection.setAttribute('tabindex', '-1');
    }
  }

  function onTabKeydown(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const ids = TABS.map(function (t) { return t.id; });
    let i = ids.indexOf(e.currentTarget.dataset.tab);
    if (e.key === 'ArrowRight') i = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') i = 0;
    else i = ids.length - 1;
    setTab(ids[i]);
    dom.tabButtons[ids[i]].focus();
  }

  function buildContinue() {
    const section = el('section', 'cat-section');
    section.id = 'cat-continue-section';
    section.style.display = 'none';

    const label = el('div', 'home-section-label', 'Continue reading');
    const rail  = el('div', 'cat-rail');
    rail.id = 'cat-continue-rail';

    section.appendChild(label);
    section.appendChild(rail);

    dom.continueSection = section;
    dom.continueRail = rail;
    // Placement is applySectionOrder's job (§2.12) — built detached here.
  }

  // A fixture, not a feature: goals owns everything INSIDE this slot (PLAN
  // §5.2), so it ships empty and stays empty from here. With js/goals.js
  // absent the home screen must render exactly as it did before the slot
  // existed — an empty div costs no layout. Placed by applySectionOrder.
  function buildGoalsSlot() {
    const slot = el('div');
    slot.id = 'goals-home-slot';
    dom.goalsSlot = slot;
  }

  // Same fixture pattern for sources (PLAN7 §2.2): the slot is catalogue's,
  // the contents are sources.js's — it fills the rail from its own
  // data-screen MutationObserver on entering home-screen, exactly like
  // goals' renderSlot. Module absent → the slot stays empty (invisible).
  function buildSourcesSlot() {
    const slot = el('div');
    slot.id = 'sources-home-slot';
    dom.sourcesSlot = slot;
  }

  function buildGridToolbar() {
    const bar = el('div', 'cat-toolbar');
    bar.id = 'cat-grid-toolbar';

    const count = el('span', 'cat-count');
    count.id = 'cat-count';
    count.setAttribute('aria-live', 'polite');

    const spacer = el('span', 'cat-spacer');

    const addBtn = el('button', 'cat-btn cat-btn--accent');
    addBtn.id = 'cat-add-series';
    addBtn.type = 'button';
    addBtn.setAttribute('aria-label', 'Add a series by link or file');
    addBtn.appendChild(icon('plus', 14));
    addBtn.appendChild(el('span', null, 'Add series'));
    addBtn.addEventListener('click', openImporter);

    // Optional module, guarded like every cross-module call: no window.Goals,
    // no button — the toolbar must look exactly as it did before the feature
    // existed (goals absence tolerance, PLAN §5.4).
    let goalsBtn = null;
    if (window.Goals && typeof window.Goals.openScreen === 'function') {
      goalsBtn = el('button', 'cat-btn');
      goalsBtn.id = 'cat-goals-btn';
      goalsBtn.type = 'button';
      goalsBtn.setAttribute('aria-label', 'Reading goals');
      goalsBtn.appendChild(icon('target', 14));
      goalsBtn.appendChild(el('span', null, 'Goals'));
      goalsBtn.addEventListener('click', function () {
        if (window.Goals && typeof window.Goals.openScreen === 'function') window.Goals.openScreen();
      });
    }

    // Settings, the same guarded pattern (PLAN7 §2.1): no window.AppSettings,
    // no button — with js/settings.js deleted the toolbar looks exactly as it
    // did before the feature existed.
    let settingsBtn = null;
    if (window.AppSettings && typeof window.AppSettings.openScreen === 'function') {
      settingsBtn = el('button', 'cat-btn');
      settingsBtn.id = 'cat-settings-btn';
      settingsBtn.type = 'button';
      settingsBtn.setAttribute('aria-label', 'App settings');
      settingsBtn.appendChild(icon('gear', 14));
      settingsBtn.appendChild(el('span', null, 'Settings'));
      settingsBtn.addEventListener('click', function () {
        if (window.AppSettings && typeof window.AppSettings.openScreen === 'function') window.AppSettings.openScreen();
      });
    }

    const group = el('div', 'cat-segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Layout');

    const gridBtn = el('button', 'cat-seg');
    gridBtn.id = 'cat-layout-grid';
    gridBtn.type = 'button';
    gridBtn.setAttribute('aria-label', 'Grid layout');
    gridBtn.appendChild(icon('grid', 14));
    gridBtn.addEventListener('click', function () { setLayout('grid'); });

    const listBtn = el('button', 'cat-seg');
    listBtn.id = 'cat-layout-list';
    listBtn.type = 'button';
    listBtn.setAttribute('aria-label', 'List layout');
    listBtn.appendChild(icon('list', 14));
    listBtn.addEventListener('click', function () { setLayout('list'); });

    group.appendChild(gridBtn);
    group.appendChild(listBtn);

    bar.appendChild(count);
    bar.appendChild(spacer);
    if (goalsBtn) bar.appendChild(goalsBtn);
    if (settingsBtn) bar.appendChild(settingsBtn);
    bar.appendChild(addBtn);
    bar.appendChild(group);

    dom.gridToolbar = bar;
    dom.count = count;
    dom.addBtn = addBtn;
    dom.goalsBtn = goalsBtn;
    dom.settingsBtn = settingsBtn;
    dom.layoutGrid = gridBtn;
    dom.layoutList = listBtn;

    // Slot it between the "All Series" label and the grid itself.
    dom.sectionLabel = dom.seriesSection ? dom.seriesSection.querySelector('.home-section-label') : null;
    if (dom.seriesSection && dom.seriesGrid) dom.seriesSection.insertBefore(bar, dom.seriesGrid);
  }

  function buildEmptyState() {
    const box = el('div', 'cat-empty');
    box.id = 'cat-empty';
    box.style.display = 'none';

    const title = el('div', 'cat-empty-title');
    const body  = el('div', 'cat-empty-body');
    const action = el('button', 'cat-btn cat-btn--accent');
    action.type = 'button';
    action.style.display = 'none';

    // Second, quieter action — the comics empty state offers two doors
    // (sources and the importer, §2.1 effect 4).
    const action2 = el('button', 'cat-btn');
    action2.type = 'button';
    action2.style.display = 'none';

    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(action);
    box.appendChild(action2);

    dom.empty = box;
    dom.emptyTitle = title;
    dom.emptyBody = body;
    dom.emptyAction = action;
    dom.emptyAction2 = action2;

    if (dom.seriesSection) dom.seriesSection.appendChild(box);
  }

  function buildSeriesExtras() {
    if (!dom.seriesBody || !dom.seriesHero || !dom.heroTitle || !dom.heroDesc) return;

    // Author / status line, above the genre chips.
    const sub = el('div', 'cat-series-sub');
    sub.id = 'cat-series-sub';
    if (dom.heroTitle && dom.heroTitle.parentNode) {
      dom.heroTitle.parentNode.insertBefore(sub, dom.heroTitle.nextSibling);
    }
    dom.seriesSub = sub;

    // Description "more" toggle, right under the clamped description.
    const more = el('button', 'cat-more', 'more');
    more.id = 'cat-desc-toggle';
    more.type = 'button';
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', function () {
      const open = dom.heroDesc.classList.toggle('cat-desc-open');
      more.textContent = open ? 'less' : 'more';
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (dom.heroDesc && dom.heroDesc.parentNode) {
      dom.heroDesc.parentNode.insertBefore(more, dom.heroDesc.nextSibling);
    }
    dom.descToggle = more;

    // Stats strip (novels: words + reading time; images: chapter count).
    const stats = el('div', 'cat-stats');
    stats.id = 'cat-series-stats';
    if (dom.seriesHero) dom.seriesHero.parentNode.insertBefore(stats, dom.seriesHero.nextSibling);
    dom.stats = stats;

    // Primary action row.
    const actions = el('div', 'cat-actions');
    actions.id = 'cat-series-actions';

    const primary = el('button', 'cat-primary');
    primary.id = 'cat-primary-read';
    primary.type = 'button';
    dom.primaryBtn = primary;

    const rangeBtn = el('button', 'cat-btn');
    rangeBtn.id = 'cat-download-range';
    rangeBtn.type = 'button';
    rangeBtn.setAttribute('aria-expanded', 'false');
    rangeBtn.appendChild(icon('down', 14));
    rangeBtn.appendChild(el('span', null, 'Download range'));
    rangeBtn.addEventListener('click', function () {
      const open = dom.rangePanel.style.display === 'none';
      // The 2×N <option>s exist only once someone actually asks for them.
      if (open) buildRangeSelects();
      dom.rangePanel.style.display = open ? 'flex' : 'none';
      rangeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    actions.appendChild(primary);
    actions.appendChild(rangeBtn);
    stats.parentNode.insertBefore(actions, stats.nextSibling);
    dom.actions = actions;
    dom.rangeBtn = rangeBtn;

    // Range panel: two selects and a go button.
    const panel = el('div', 'cat-range');
    panel.id = 'cat-range-panel';
    panel.style.display = 'none';

    const from = document.createElement('select');
    from.id = 'cat-range-from';
    from.className = 'cat-select';
    from.setAttribute('aria-label', 'Download from chapter');

    const to = document.createElement('select');
    to.id = 'cat-range-to';
    to.className = 'cat-select';
    to.setAttribute('aria-label', 'Download to chapter');

    const go = el('button', 'cat-btn cat-btn--accent', 'Download');
    go.id = 'cat-range-go';
    go.type = 'button';
    go.addEventListener('click', downloadRange);

    const status = el('span', 'cat-range-status');
    status.id = 'cat-range-status';
    status.setAttribute('aria-live', 'polite');

    panel.appendChild(el('span', 'cat-range-label', 'From'));
    panel.appendChild(from);
    panel.appendChild(el('span', 'cat-range-label', 'to'));
    panel.appendChild(to);
    panel.appendChild(go);
    panel.appendChild(status);

    actions.parentNode.insertBefore(panel, actions.nextSibling);
    dom.rangePanel = panel;
    dom.rangeFrom = from;
    dom.rangeTo = to;
    dom.rangeStatus = status;

    // Chapter toolbar: jump box + sort direction.
    const chBar = el('div', 'cat-toolbar cat-toolbar--chapters');
    chBar.id = 'cat-chapter-toolbar';

    const jump = document.createElement('input');
    jump.type = 'search';
    jump.id = 'cat-chapter-search';
    jump.className = 'cat-input';
    jump.placeholder = 'Jump to chapter…';
    jump.autocomplete = 'off';
    jump.setAttribute('aria-label', 'Filter chapters by number or title');
    jump.addEventListener('input', debounce(function () {
      chapterQuery = jump.value.trim().toLowerCase();
      renderChapterList();
    }, 150));

    const sort = el('button', 'cat-btn');
    sort.id = 'cat-sort-toggle';
    sort.type = 'button';
    sort.addEventListener('click', function () {
      chapterSortAsc = !chapterSortAsc;
      updateSortButton();
      renderChapterList();
    });

    chBar.appendChild(jump);
    chBar.appendChild(sort);
    dom.chapterToolbar = chBar;
    dom.chapterSearch = jump;
    dom.sortBtn = sort;

    // The "Chapters" label sits directly above the chapter list.
    if (dom.chapterList && dom.chapterList.parentNode) {
      dom.chapterList.parentNode.insertBefore(chBar, dom.chapterList);
    }
  }

  function updateSortButton() {
    const b = dom.sortBtn;
    if (!b) return;
    b.textContent = '';
    b.appendChild(icon(chapterSortAsc ? 'sortA' : 'sortD', 14));
    b.appendChild(el('span', null, chapterSortAsc ? 'Oldest' : 'Newest'));
    b.setAttribute('aria-label', 'Sort chapters, currently ' + (chapterSortAsc ? 'oldest first' : 'newest first'));
  }

  function buildToast() {
    const t = el('div', 'cat-toast');
    t.id = 'cat-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
    dom.toast = t;
  }

  // The chunk seam for lists and grids: a real button carrying the remaining
  // count in its text and accessible name. Each rebuild replaces it, so the
  // click handler is responsible for putting focus somewhere sensible in the
  // fresh DOM — keyboard users must not be dropped back to <body>.
  function showMoreRow(remaining, noun, onClick) {
    const b = el('button', 'cat-btn cat-show-more', 'Show more (' + remaining + ' remaining)');
    b.type = 'button';
    b.setAttribute('aria-label', 'Show more ' + noun + ', ' + remaining + ' remaining');
    b.setAttribute('aria-live', 'polite');
    b.addEventListener('click', onClick);
    return b;
  }

  let toastTimer = null;
  function toast(msg) {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.classList.remove('visible'); }, 3200);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Data loading
  // ─────────────────────────────────────────────────────────────────────────

  async function loadCatalog() {
    const url = (window.OR_CONFIG && window.OR_CONFIG.catalogUrl) || './catalog.json';
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      bundledSeries = migrateCatalog(data);
      catalogError = null;
    } catch (e) {
      // A missing bundled catalogue is survivable: the user's own library and
      // the offline CBZ reader still work, so we degrade instead of blanking.
      bundledSeries = [];
      catalogError = e;
    }
  }

  async function loadUserSeries() {
    const rows = await safeCall('listUserSeries', [], []);
    userSeries = (rows || []).map(normalizeSeries).filter(Boolean);
  }

  async function loadProgress() {
    progressRows = (await safeCall('listProgress', [{ limit: 12 }], [])) || [];
  }

  function mergeSeries() {
    const byId = new Map();
    // Bundled first, user second: a user's own copy of a series should win, and
    // "My Library" must keep showing their edits after a catalogue rebuild.
    bundledSeries.forEach(function (s) { byId.set(s.id, s); });
    userSeries.forEach(function (s) { byId.set(s.id, s); });
    allSeries = Array.from(byId.values());
  }

  function findSeries(id) {
    return allSeries.find(function (s) { return s.id === id; }) || null;
  }

  function isUserSeries(s) {
    return !!s && (s.source === 'user' || userSeries.some(function (u) { return u.id === s.id; }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Home screen
  // ─────────────────────────────────────────────────────────────────────────

  function matchesTab(s, tab) {
    if (tab === 'all') return true;
    if (tab === 'library') return isUserSeries(s);
    if (tab === 'lightnovel') return TEXT_TYPES.has(s.type);
    return s.type === tab;
  }

  function matchesQuery(s, q) {
    if (!q) return true;
    const hay = [s.title].concat(s.altTitles || [], [s.author || ''], s.genres || [], s.tags || [])
      .join(' \x00 ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function visibleSeries() {
    const tab = currentTab();
    const q = searchQuery;
    return allSeries.filter(function (s) { return matchesTab(s, tab) && matchesQuery(s, q); });
  }

  function renderHome() {
    ensureDom();
    if (!dom.homeBody) return;

    // Order + visibility first (§2.12): a no-op when nothing changed, a five-
    // node re-append when the pref (or the focus-derived default) moved.
    applySectionOrder();

    const tab = currentTab();
    const list = visibleSeries();

    if (dom.homeState) dom.homeState.style.display = 'none';
    if (dom.tabs) dom.tabs.style.display = 'flex';

    syncTabs(tab);
    syncLayout();
    renderContinue();

    // Latest updates is a "what's new" rail — it makes no sense while the user
    // is searching, and My Library has its own ordering (newest added first).
    // A section hidden via home.sections does no work at all (§2.12).
    const showLatest = sectionVisible('latest') && !searchQuery && tab !== 'library' && list.length > 0;
    if (dom.latestSection) dom.latestSection.style.display = showLatest ? 'block' : 'none';
    if (showLatest) renderLatest(list);

    if (dom.seriesSection) dom.seriesSection.style.display = 'block';
    if (dom.sectionLabel) {
      dom.sectionLabel.textContent =
        tab === 'library' ? 'My Library' :
        tab === 'all'     ? 'All Series' :
        (TABS.find(function (t) { return t.id === tab; }) || {}).label || 'Series';
    }
    if (dom.addBtn) dom.addBtn.style.display = (tab === 'library') ? 'inline-flex' : 'none';
    // "series" is its own plural, so there is no singular/plural branch here.
    // The count is an aria-live region; when the grid is chunked it carries
    // the shown-of-total tally, so expanding announces the new count.
    if (dom.count) {
      dom.count.textContent = !list.length ? ''
        : (list.length > gridCardLimit
          ? 'Showing ' + gridCardLimit + ' of ' + list.length + ' series'
          : list.length + ' series');
    }
    // The home grid's toolbar — not the series-detail chapter toolbar, which
    // belongs to a different screen and hides itself when a series has no
    // chapters. Setting that one here left an inline display:flex behind that
    // outlived the screen and showed a chapter jump box over an empty list.
    if (dom.gridToolbar) dom.gridToolbar.style.display = 'flex';

    renderGrid(list, tab);
    renderEmpty(list, tab);

    // The focus first-run hook (PLAN7 §2.1): called exactly once, after the
    // first successful home render, guarded — settings.js owns the sheet and
    // itself declines on the upload-screen boot path and once a focus has
    // ever been chosen. With js/settings.js deleted nothing happens at all.
    if (!focusHookFired) {
      focusHookFired = true;
      if (window.AppSettings && typeof window.AppSettings.maybeOfferFocus === 'function') {
        try { window.AppSettings.maybeOfferFocus(); }
        catch (e) { console.warn('[Catalogue] maybeOfferFocus failed', e); }
      }
    }
  }

  function syncTabs(tab) {
    TABS.forEach(function (t) {
      const b = dom.tabButtons[t.id];
      if (!b) return;
      const active = t.id === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
    });
  }

  function syncLayout() {
    const layout = currentLayout();
    if (dom.seriesGrid) {
      dom.seriesGrid.classList.toggle('cat-layout-list', layout === 'list');
      dom.seriesGrid.classList.toggle('cat-layout-grid', layout === 'grid');
    }
    if (dom.layoutGrid) {
      dom.layoutGrid.classList.toggle('active', layout === 'grid');
      dom.layoutGrid.setAttribute('aria-pressed', layout === 'grid' ? 'true' : 'false');
    }
    if (dom.layoutList) {
      dom.layoutList.classList.toggle('active', layout === 'list');
      dom.layoutList.setAttribute('aria-pressed', layout === 'list' ? 'true' : 'false');
    }
  }

  function setTab(id) {
    prefSet('catalogue.tab', id);
    gridCardLimit = GRID_CHUNK; // a new tab is a new list; expansion does not carry over
    renderHome();
  }

  function setLayout(id) {
    prefSet('catalogue.layout', id);
    renderHome();
  }

  // ── Continue reading rail ────────────────────────────────────────────────

  function renderContinue() {
    if (!dom.continueRail) return;
    // Hidden via home.sections (§2.12): stay hidden and do no work — the
    // pref's show/hide must win over this function's own display writers.
    if (!sectionVisible('continue')) {
      if (dom.continueSection) dom.continueSection.style.display = 'none';
      return;
    }
    dom.continueRail.textContent = '';

    const rows = (progressRows || []).filter(function (p) { return p && p.seriesId && findSeries(p.seriesId); });
    if (!rows.length) { dom.continueSection.style.display = 'none'; return; }
    dom.continueSection.style.display = 'block';

    rows.forEach(function (p) {
      const series = findSeries(p.seriesId);
      const card = el('button', 'cat-cont');
      card.type = 'button';
      const chLabel = p.chapterNum != null ? 'Chapter ' + p.chapterNum : (p.chapterTitle || 'Chapter');
      card.setAttribute('aria-label', 'Resume ' + series.title + ', ' + chLabel);

      const shot = el('div', 'cat-cont-cover');
      const src = imgUrl(p.cover || series.cover);
      if (src) {
        const img = document.createElement('img');
        img.src = src; img.alt = ''; img.loading = 'lazy';
        img.addEventListener('error', function () { img.replaceWith(placeholder(series, 'cat-cont-ph')); });
        shot.appendChild(img);
      } else {
        shot.appendChild(placeholder(series, 'cat-cont-ph'));
      }

      const meta = el('div', 'cat-cont-meta');
      meta.appendChild(el('div', 'cat-cont-title', series.title));
      meta.appendChild(el('div', 'cat-cont-ch', chLabel));

      const bar = el('div', 'cat-bar');
      const fill = el('div', 'cat-bar-fill');
      const pct = Math.max(0, Math.min(1, typeof p.pct === 'number' ? p.pct : 0));
      fill.style.width = (pct * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', Math.round(pct * 100));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      meta.appendChild(bar);

      card.appendChild(shot);
      card.appendChild(meta);
      card.addEventListener('click', function () { resumeProgress(p); });
      dom.continueRail.appendChild(card);
    });
  }

  async function resumeProgress(row) {
    const series = findSeries(row.seriesId);
    if (!series) { toast('That series is no longer in your library.'); return; }
    // Re-read rather than trusting the row the rail was rendered from: that row
    // can be a boot-time snapshot, and handing a stale anchor to the reader
    // does not merely start in the wrong place — the reader writes that anchor
    // straight back, destroying the real furthest-read position.
    const p = (await safeCall('getProgress', [row.seriesId], null)) || row;
    const chapter = (series.chapters || []).find(function (c) { return c.id === p.chapterId; }) ||
                    (series.chapters || [])[0];
    if (!chapter) { toast('No chapters available for ' + series.title + '.'); return; }
    // Render the detail screen first (without showing it) so the reader's close
    // button has somewhere coherent to return to.
    await openSeries(series, { show: false });
    await openChapter(series, chapter, { resume: p });
  }

  // ── Latest updates ───────────────────────────────────────────────────────

  function latestChapter(s) {
    const chs = s.chapters || [];
    if (!chs.length) return null;
    return chs.reduce(function (best, ch) {
      if (!best) return ch;
      return (ch.num != null ? ch.num : 0) > (best.num != null ? best.num : 0) ? ch : best;
    }, null);
  }

  function latestDate(s) {
    const lc = latestChapter(s);
    return (lc && lc.updatedAt) || s.updatedAt || null;
  }

  // Generated cover (PLAN7 §2.8), guarded: with js/covers.js present every
  // placeholder slot gets the deterministic SVG cover instead of the gradient
  // div; with it deleted (or throwing) the gradient code below still carries
  // the feature exactly as before — it is the guard fallback, never deleted.
  function generatedCover(series, cls) {
    if (!(window.Covers && typeof window.Covers.element === 'function')) return null;
    try {
      const svg = window.Covers.element(series, { className: 'cat-cover-svg' });
      if (svg && cls) svg.classList.add(cls);
      return svg || null;
    } catch (e) {
      console.warn('[Catalogue] Covers.element failed', e);
      return null;
    }
  }

  function placeholder(series, cls) {
    // The context class carries the slot's box sizing (the rail thumbs size
    // the element itself); the artwork ignores the gradient rules behind it.
    const generated = generatedCover(series, cls || 'series-cover-ph');
    if (generated) return generated;
    const ph = el('div', cls || 'series-cover-ph');
    if (isTextSeries(series)) {
      ph.classList.add('cat-ph-novel');
      ph.appendChild(el('span', 'cat-ph-spine-title', series.title));
    } else {
      ph.appendChild(icon('image', 22));
    }
    return ph;
  }

  function kindBadge(series) {
    const b = el('span', 'cat-kind');
    if (isTextSeries(series)) {
      b.classList.add('cat-kind--novel');
      b.appendChild(icon('book', 11));
      b.appendChild(el('span', null, series.type === 'webnovel' ? 'Web novel' : 'Novel'));
    } else {
      b.appendChild(icon('image', 11));
      b.appendChild(el('span', null, series.type === 'manhwa' ? 'Manhwa' : 'Manga'));
    }
    return b;
  }

  function renderLatest(list) {
    const container = dom.latestList;
    if (!container) return;
    container.textContent = '';

    const sorted = list.slice().sort(function (a, b) {
      const ad = latestDate(a), bd = latestDate(b);
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return new Date(bd) - new Date(ad);
    }).slice(0, 15);

    sorted.forEach(function (s) {
      const lc = latestChapter(s);
      const row = el('button', 'update-row');
      row.type = 'button';
      row.setAttribute('aria-label', 'Open ' + s.title);

      const src = imgUrl(s.cover);
      if (src) {
        const img = document.createElement('img');
        img.className = 'update-thumb'; img.src = src; img.alt = ''; img.loading = 'lazy';
        img.addEventListener('error', function () {
          const ph = placeholder(s, 'update-thumb-ph');
          img.replaceWith(ph);
        });
        row.appendChild(img);
      } else {
        row.appendChild(placeholder(s, 'update-thumb-ph'));
      }

      const info = el('div', 'update-info');
      info.appendChild(el('div', 'update-title', s.title));
      const meta = el('div', 'update-meta');
      meta.appendChild(kindBadge(s));
      meta.appendChild(el('span', 'cat-dot', '·'));
      meta.appendChild(el('span', null, lc ? (lc.num != null ? 'Ch. ' + lc.num : chapterName(lc)) : 'No chapters'));
      info.appendChild(meta);
      row.appendChild(info);

      row.appendChild(el('div', 'update-date', fmtDate(latestDate(s))));
      row.addEventListener('click', function () { openSeries(s); });
      container.appendChild(row);
    });
  }

  // ── Series grid ──────────────────────────────────────────────────────────

  function renderGrid(list, tab) {
    const grid = dom.seriesGrid;
    if (!grid) return;
    grid.textContent = '';
    grid.setAttribute('aria-labelledby', 'cat-tab-' + tab);

    // Chunked, not virtualized: the full-rebuild philosophy stays, the build
    // just stops at 200 cards until asked for more. The bundled catalogue plus
    // a normal library never crosses the threshold, so this only engages for
    // grown libraries. Covers keep loading="lazy" either way.
    const shown = list.slice(0, gridCardLimit);
    // §2.1 effect 3 — the renderer bias, for UNTYPED series only: under books
    // focus a series that never declared a type reads as a spine, not a
    // poster. Typed series NEVER change card style under any focus, comics/
    // both keep today's default, and rails are uniform rows and unaffected.
    // Grid renderer only.
    const booksBias = readFocus() === 'books';
    shown.forEach(function (s) {
      const asNovel = isTextSeries(s) || (booksBias && s.untyped === true);
      grid.appendChild(asNovel ? novelCard(s, tab) : mangaCard(s, tab));
    });

    if (list.length > shown.length) {
      const before = shown.length;
      grid.appendChild(showMoreRow(list.length - shown.length, 'series', function () {
        gridCardLimit += GRID_CHUNK;
        renderHome();
        const next = grid.querySelector('.cat-show-more');
        if (next) { next.focus(); return; }
        const cards = grid.querySelectorAll('.series-card');
        if (cards[before]) cards[before].focus();
      }));
    }
  }

  function cardShell(s, tab, extraClass) {
    const wrap = el('div', 'cat-card-wrap');
    const card = el('button', 'series-card ' + extraClass);
    card.type = 'button';
    card.setAttribute('aria-label', 'Open ' + s.title);
    card.addEventListener('click', function () { openSeries(s); });
    wrap.appendChild(card);

    // My Library rows carry a delete affordance; a nested <button> would be
    // invalid markup, so it is a sibling positioned over the card.
    if (tab === 'library' && isUserSeries(s)) {
      const del = el('button', 'cat-del');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove ' + s.title + ' from your library');
      del.appendChild(icon('trash', 13));
      del.addEventListener('click', function (e) { e.stopPropagation(); confirmDelete(s); });
      wrap.appendChild(del);
    }
    return { wrap: wrap, card: card };
  }

  function mangaCard(s, tab) {
    const built = cardShell(s, tab, 'cat-card cat-card--image');
    const card = built.card;

    const coverWrap = el('div', 'series-cover-wrap');
    const src = imgUrl(s.cover);
    if (src) {
      const img = document.createElement('img');
      img.className = 'series-cover'; img.src = src; img.alt = ''; img.loading = 'lazy';
      img.addEventListener('error', function () { img.replaceWith(placeholder(s, 'series-cover-ph')); });
      coverWrap.appendChild(img);
    } else {
      coverWrap.appendChild(placeholder(s, 'series-cover-ph'));
    }
    card.appendChild(coverWrap);

    const body = el('div', 'cat-card-body');
    body.appendChild(el('div', 'series-card-title', s.title));
    const lc = latestChapter(s);
    body.appendChild(el('div', 'series-card-meta',
      lc && lc.num != null ? 'Ch. ' + lc.num : (s.chapters.length + ' ch')));
    card.appendChild(body);
    return built.wrap;
  }

  // Novels get a spine, not a poster: a bound-book edge, the author, and a
  // chapter count. Page counts are meaningless for prose.
  function novelCard(s, tab) {
    const built = cardShell(s, tab, 'cat-card cat-card--novel');
    const card = built.card;

    const spine = el('div', 'cat-spine');
    const src = imgUrl(s.cover);
    if (src) {
      const img = document.createElement('img');
      img.className = 'cat-spine-img'; img.src = src; img.alt = ''; img.loading = 'lazy';
      img.addEventListener('error', function () { img.replaceWith(spineFallback(s)); });
      spine.appendChild(img);
    } else {
      spine.appendChild(spineFallback(s));
    }
    spine.appendChild(el('span', 'cat-spine-edge'));
    card.appendChild(spine);

    const body = el('div', 'cat-card-body');
    body.appendChild(el('div', 'series-card-title', s.title));
    if (s.author) body.appendChild(el('div', 'cat-card-author', s.author));
    body.appendChild(el('div', 'series-card-meta',
      s.chapters.length + (s.chapters.length === 1 ? ' chapter' : ' chapters')));
    card.appendChild(body);
    return built.wrap;
  }

  function spineFallback(s) {
    // No context class here: .cat-spine is the sized (and clipped) box, and
    // .cat-spine-ph's padding would inset the artwork.
    const generated = generatedCover(s, null);
    if (generated) return generated;
    const ph = el('div', 'cat-spine-ph');
    ph.appendChild(el('span', 'cat-spine-title', s.title));
    if (s.author) ph.appendChild(el('span', 'cat-spine-author', s.author));
    return ph;
  }

  async function confirmDelete(s) {
    const msg = 'Remove “' + s.title + '” from your library?\n\nCached chapters and reading progress for it will also be deleted.';
    // Platform.confirm is a native dialog under Capacitor (window.confirm in a
    // WebView paints a browser-styled box with the origin string in it) and
    // falls back to window.confirm itself on the web, so one call serves both.
    const P = platform();
    const ok = (P && typeof P.confirm === 'function')
      ? await P.confirm({ title: 'Remove series', message: msg, okLabel: 'Remove', cancelLabel: 'Cancel' })
      : window.confirm(msg);
    if (!ok) return;
    await safeCall('deleteUserSeries', [s.id], null);
    toast('Removed “' + s.title + '”.');
    await refresh();
  }

  function openImporter() {
    if (window.Importer && typeof window.Importer.openDialog === 'function') {
      window.Importer.openDialog();
    } else {
      toast('Adding your own series is not available in this build yet.');
    }
  }

  // ── Empty states ─────────────────────────────────────────────────────────

  function renderEmpty(list, tab) {
    const box = dom.empty;
    if (!box) return;
    if (list.length) { box.style.display = 'none'; return; }
    box.style.display = 'flex';

    dom.emptyAction.style.display = 'none';
    dom.emptyAction.onclick = null;
    if (dom.emptyAction2) {
      dom.emptyAction2.style.display = 'none';
      dom.emptyAction2.onclick = null;
    }

    if (catalogError && !allSeries.length) {
      dom.emptyTitle.textContent = 'Library unavailable';
      // On the web this is a connectivity story. On native the catalogue is a
      // file inside the app bundle — a missing one is a broken install, and
      // telling the user to check their connection would send them chasing
      // the wrong problem.
      dom.emptyBody.textContent = isNativeApp()
        ? 'Could not load the bundled catalogue — reinstalling the app should repair it. Your imported series and reading progress are kept.'
        : 'Could not load the catalogue. Check your connection, or add a series you already read.';
      dom.emptyAction.textContent = 'Retry';
      dom.emptyAction.style.display = 'inline-flex';
      dom.emptyAction.onclick = function () { refresh(); };
      return;
    }
    if (searchQuery) {
      dom.emptyTitle.textContent = 'Nothing matched';
      dom.emptyBody.textContent = 'No series match “' + searchQuery + '”. Try a shorter search, or check another tab.';
      return;
    }
    // Focus-flavored guidance (§2.1 effect 4). All copy is app-authored and
    // lands as textContent; every module call is guarded — with sources.js
    // absent the comics state simply offers one door instead of two.
    if (tab === 'library') {
      dom.emptyTitle.textContent = 'Your library is empty';
      dom.emptyBody.textContent = 'No series yet — open an EPUB, TXT or CBZ from this device, or paste a link to one you already read. The tutorial book on the All tab shows the ropes.';
      dom.emptyAction.textContent = 'Add a series';
      dom.emptyAction.style.display = 'inline-flex';
      dom.emptyAction.onclick = openImporter;
      return;
    }
    if (tab === 'lightnovel') {
      dom.emptyTitle.textContent = 'No books yet';
      dom.emptyBody.textContent = 'No books here yet. Import an EPUB or TXT from this device, or start with the tutorial book, “We Are Readers Here”.';
      dom.emptyAction.textContent = 'Add a series';
      dom.emptyAction.style.display = 'inline-flex';
      dom.emptyAction.onclick = openImporter;
      return;
    }
    if (tab === 'manga' || tab === 'manhwa') {
      dom.emptyTitle.textContent = 'No comics yet';
      dom.emptyBody.textContent = 'No comics here yet. Bring your own — add a source you like, or import CBZ files.';
      const hasSources = !!(window.Sources && typeof window.Sources.openScreen === 'function');
      if (hasSources) {
        dom.emptyAction.textContent = 'Add a source';
        dom.emptyAction.style.display = 'inline-flex';
        dom.emptyAction.onclick = function () {
          if (window.Sources && typeof window.Sources.openScreen === 'function') window.Sources.openScreen();
        };
        if (dom.emptyAction2) {
          dom.emptyAction2.textContent = 'Import CBZ files';
          dom.emptyAction2.style.display = 'inline-flex';
          dom.emptyAction2.onclick = openImporter;
        }
      } else {
        dom.emptyAction.textContent = 'Import CBZ files';
        dom.emptyAction.style.display = 'inline-flex';
        dom.emptyAction.onclick = openImporter;
      }
      return;
    }
    const label = (TABS.find(function (t) { return t.id === tab; }) || {}).label || 'series';
    dom.emptyTitle.textContent = 'Nothing here yet';
    dom.emptyBody.textContent = 'No ' + label.toLowerCase() + ' in this catalogue. Try the All tab, or add a series of your own.';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Series detail screen
  // ─────────────────────────────────────────────────────────────────────────

  async function openSeries(series, opts) {
    ensureDom();
    const show = !opts || opts.show !== false;
    if (!series) return;

    // Accept an id as well as a Series — importer callbacks often only have one.
    if (typeof series === 'string') series = findSeries(series);
    if (!series) return;

    currentSeries = series;
    chapterQuery = '';
    chapterSortAsc = false;
    chapterRowLimit = CHAPTER_CHUNK; // fresh view, fresh chunk — like the query/sort resets above
    if (dom.chapterSearch) dom.chapterSearch.value = '';
    updateSortButton();

    if (dom.headerTitle) dom.headerTitle.textContent = series.title;

    renderHero(series);

    // Cached ids and progress drive per-chapter state; fetch before first paint
    // so rows don't visibly flip from "not saved" to "saved".
    const [ids, prog] = await Promise.all([
      safeCall('listCachedChapterIds', [series.id], []),
      safeCall('getProgress', [series.id], null),
    ]);
    cachedIds = new Set(ids || []);
    seriesProgress = prog;

    renderStats(series);
    renderPrimaryAction(series);
    populateRangeSelects(series);
    renderChapterList();

    if (show) {
      pushScreen('series-screen');
      window.showScreen('series-screen');
      if (dom.seriesBody) dom.seriesBody.scrollTop = 0;
      window.scrollTo(0, 0);
    }
  }

  function renderHero(s) {
    const hero = dom.seriesHero;
    if (!hero) return;

    const old = hero.querySelector('#series-hero-cover, #series-hero-cover-ph');
    if (old) old.remove();

    const src = imgUrl(s.cover);
    if (src) {
      const img = document.createElement('img');
      img.id = 'series-hero-cover'; img.src = src; img.alt = '';
      img.addEventListener('error', function () { img.replaceWith(heroPlaceholder(s)); });
      hero.prepend(img);
    } else {
      hero.prepend(heroPlaceholder(s));
    }
    hero.classList.toggle('cat-hero--novel', isTextSeries(s));

    dom.heroTitle.textContent = s.title;
    dom.heroDesc.textContent = s.description || 'No description available.';
    dom.heroDesc.classList.remove('cat-desc-open');
    if (dom.descToggle) {
      dom.descToggle.textContent = 'more';
      dom.descToggle.setAttribute('aria-expanded', 'false');
      // Only offer the toggle when there is genuinely more to reveal.
      dom.descToggle.style.display = (s.description && s.description.length > 220) ? 'inline' : 'none';
    }

    // Author / alt title line.
    const sub = dom.seriesSub;
    if (sub) {
      sub.textContent = '';
      const bits = [];
      if (s.author) bits.push(s.author);
      if (s.altTitles && s.altTitles.length) bits.push(s.altTitles[0]);
      bits.forEach(function (b, i) {
        if (i) sub.appendChild(el('span', 'cat-dot', '·'));
        sub.appendChild(el('span', null, b));
      });
      sub.style.display = bits.length ? 'flex' : 'none';
    }

    const meta = dom.heroMeta;
    meta.textContent = '';
    meta.appendChild(kindBadge(s));
    if (s.status) meta.appendChild(el('span', 'series-tag', s.status));
    (s.genres || []).slice(0, 8).forEach(function (g) { meta.appendChild(el('span', 'series-tag', g)); });

    const link = safeHttpUrl(s.sourceUrl);
    if (link) {
      const a = document.createElement('a');
      a.className = 'series-tag cat-tag-link';
      a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      a.textContent = 'Source';
      meta.appendChild(a);
    }
  }

  function heroPlaceholder(s) {
    // The id carries the hero slot's sizing (and lets renderHero find and
    // replace it), for the SVG exactly as for the div.
    const generated = generatedCover(s, null);
    if (generated) { generated.id = 'series-hero-cover-ph'; return generated; }
    const ph = el('div');
    ph.id = 'series-hero-cover-ph';
    if (isTextSeries(s)) {
      ph.classList.add('cat-ph-novel');
      ph.appendChild(el('span', 'cat-ph-spine-title', s.title));
    } else {
      ph.appendChild(icon('image', 30));
    }
    return ph;
  }

  function renderStats(s) {
    const box = dom.stats;
    if (!box) return;
    box.textContent = '';

    const add = function (value, label) {
      const cell = el('div', 'cat-stat');
      cell.appendChild(el('div', 'cat-stat-value', value));
      cell.appendChild(el('div', 'cat-stat-label', label));
      box.appendChild(cell);
    };

    const n = s.chapters.length;
    add(String(n), n === 1 ? 'chapter' : 'chapters');

    if (isTextSeries(s)) {
      // Prose is measured in words and minutes, not pages.
      if (s.wordCount) {
        add(fmtWords(s.wordCount).replace(' words', ''), 'words');
        add(readingTime(s.wordCount).replace(' read', ''), 'to read');
      }
    } else {
      const withPages = s.chapters.filter(function (c) { return Array.isArray(c.pages); });
      const totalPages = withPages.reduce(function (t, c) { return t + c.pages.length; }, 0);
      if (totalPages) add(String(totalPages), 'pages');
    }

    if (cachedIds.size) add(String(cachedIds.size), 'saved offline');
  }

  function orderedChapters(s) {
    // The catalogue stores chapters ascending by num (§1.1); reading order is
    // that order, so "next" is always index + 1 regardless of display sort.
    return (s.chapters || []).slice().sort(function (a, b) {
      const an = a.num != null ? a.num : 0, bn = b.num != null ? b.num : 0;
      return an - bn;
    });
  }

  function resumeTarget(s) {
    const ordered = orderedChapters(s);
    if (!ordered.length) return null;
    if (!seriesProgress || !seriesProgress.chapterId) return { chapter: ordered[0], fresh: true };
    const idx = ordered.findIndex(function (c) { return c.id === seriesProgress.chapterId; });
    if (idx === -1) return { chapter: ordered[0], fresh: true };
    // Finished that chapter? Point at the next one; otherwise resume in place.
    if (seriesProgress.completed && idx + 1 < ordered.length) {
      return { chapter: ordered[idx + 1], fresh: true };
    }
    return { chapter: ordered[idx], fresh: false };
  }

  function renderPrimaryAction(s) {
    const btn = dom.primaryBtn;
    if (!btn) return;
    const target = resumeTarget(s);
    btn.textContent = '';

    if (!target) {
      btn.disabled = true;
      btn.appendChild(el('span', null, 'No chapters yet'));
      return;
    }
    btn.disabled = false;
    btn.appendChild(icon('play', 15));
    const label = target.fresh
      ? (target.chapter.num != null && target.chapter.num > 1 ? 'Start at Ch. ' + target.chapter.num : 'Start reading')
      : 'Continue from Ch. ' + (target.chapter.num != null ? target.chapter.num : chapterName(target.chapter));
    btn.appendChild(el('span', null, label));
    btn.setAttribute('aria-label', label + ' — ' + s.title);
    btn.onclick = function () {
      openChapter(s, target.chapter, { resume: target.fresh ? null : seriesProgress });
    };
  }

  function chapterState(ch) {
    if (!seriesProgress || !seriesProgress.chapterId) return 'unread';
    if (ch.id === seriesProgress.chapterId) return seriesProgress.completed ? 'read' : 'reading';
    const cur = seriesProgress.chapterNum;
    if (cur != null && ch.num != null) return ch.num < cur ? 'read' : 'unread';
    return 'unread';
  }

  function renderChapterList() {
    const s = currentSeries;
    const list = dom.chapterList;
    if (!s || !list) return;
    list.textContent = '';

    const ordered = orderedChapters(s);
    let rows = ordered.map(function (c, i) { return { ch: c, idx: i }; });

    if (chapterQuery) {
      rows = rows.filter(function (r) {
        const num = r.ch.num != null ? String(r.ch.num) : '';
        return num.indexOf(chapterQuery) === 0 ||
               (r.ch.title || '').toLowerCase().indexOf(chapterQuery) !== -1 ||
               num.indexOf(chapterQuery) !== -1;
      });
    }
    if (!chapterSortAsc) rows = rows.slice().reverse();

    if (!rows.length) {
      list.appendChild(el('div', 'no-results',
        chapterQuery ? 'No chapter matches “' + chapterQuery + '”.' : 'No chapters available'));
      return;
    }

    // A 3000-chapter series must not become 3000 rows of DOM (§9): render a
    // chunk, park the rest behind "Show more". refreshSeriesProgress re-renders
    // through here without resetting the limit, so an expanded list — and the
    // scroll position within it — survives a read-and-return round trip.
    const shown = rows.slice(0, chapterRowLimit);
    shown.forEach(function (r) {
      list.appendChild(chapterRow(s, r.ch));
    });

    if (rows.length > shown.length) {
      const before = shown.length;
      list.appendChild(showMoreRow(rows.length - shown.length, 'chapters', function () {
        chapterRowLimit += CHAPTER_CHUNK;
        renderChapterList();
        const next = list.querySelector('.cat-show-more');
        if (next) { next.focus(); return; }
        const mains = list.querySelectorAll('.cat-ch-main');
        if (mains[before]) mains[before].focus();
      }));
    }
  }

  function chapterRow(s, ch) {
    const state = chapterState(ch);
    const row = el('div', 'ch-item cat-ch-row cat-ch--' + state);

    const main = el('button', 'cat-ch-main');
    main.type = 'button';
    main.setAttribute('aria-label', 'Read ' + chapterName(ch) + ' of ' + s.title);

    const num = el('span', 'ch-num', chapterLabel(ch));
    const name = el('span', 'ch-name', chapterName(ch));

    const tail = el('span', 'cat-ch-tail');
    if (isTextSeries(s) && ch.wordCount) {
      tail.appendChild(el('span', 'ch-date', fmtWords(ch.wordCount)));
    } else if (Array.isArray(ch.pages) && ch.pages.length) {
      tail.appendChild(el('span', 'ch-date', ch.pages.length + 'p'));
    }
    const d = fmtDate(ch.updatedAt);
    if (d) tail.appendChild(el('span', 'ch-date', d));

    main.appendChild(num);
    main.appendChild(name);
    if (state === 'reading') {
      const dot = el('span', 'cat-ch-here');
      dot.setAttribute('aria-label', 'You are here');
      dot.title = 'You are here';
      main.appendChild(dot);
    }
    main.appendChild(tail);
    const arrow = el('span', 'ch-arrow');
    arrow.appendChild(icon('chev', 14));
    main.appendChild(arrow);
    main.addEventListener('click', function () {
      openChapter(s, ch, { resume: (seriesProgress && seriesProgress.chapterId === ch.id) ? seriesProgress : null });
    });

    const dl = el('button', 'cat-ch-dl');
    dl.type = 'button';
    const cached = cachedIds.has(ch.id);
    dl.classList.toggle('cached', cached);
    dl.setAttribute('aria-label', (cached ? 'Saved offline: ' : 'Download for offline: ') + chapterName(ch));
    dl.appendChild(icon(cached ? 'check' : 'down', 14));
    dl.addEventListener('click', function (e) {
      e.stopPropagation();
      downloadChapter(s, ch, dl);
    });

    row.appendChild(main);
    row.appendChild(dl);
    return row;
  }

  // ── Offline download ─────────────────────────────────────────────────────

  async function downloadChapter(s, ch, btn) {
    if (cachedIds.has(ch.id)) { toast(chapterName(ch) + ' is already saved.'); return; }
    if (btn) { btn.classList.add('busy'); btn.disabled = true; }
    try {
      await resolveChapterContent(s, ch);
      cachedIds.add(ch.id);
      if (btn) {
        btn.textContent = '';
        btn.appendChild(icon('check', 14));
        btn.classList.add('cached');
        btn.setAttribute('aria-label', 'Saved offline: ' + chapterName(ch));
      }
      renderStats(s);
    } catch (err) {
      toast(errorText(err));
    } finally {
      if (btn) { btn.classList.remove('busy'); btn.disabled = false; }
    }
  }

  // Split in two on purpose: opening a series only RESETS the panel, it no
  // longer builds it. A 3000-chapter series was paying for 6000 <option>
  // nodes on every visit to its detail screen, when most visits never touch
  // range download — the build now waits for the panel's first open.
  function populateRangeSelects(s) {
    if (!dom.rangeFrom) return;
    rangeSelectsFor = null;
    dom.rangeFrom.textContent = '';
    dom.rangeTo.textContent = '';
    dom.rangeStatus.textContent = '';
    dom.rangePanel.style.display = 'none';
    if (dom.rangeBtn) dom.rangeBtn.setAttribute('aria-expanded', 'false');
    dom.actions.style.display = orderedChapters(s).length ? 'flex' : 'none';
  }

  function buildRangeSelects() {
    const s = currentSeries;
    if (!s || !dom.rangeFrom || rangeSelectsFor === s.id) return;
    rangeSelectsFor = s.id;
    const ordered = orderedChapters(s);
    [dom.rangeFrom, dom.rangeTo].forEach(function (sel) {
      sel.textContent = '';
      ordered.forEach(function (c, i) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = c.num != null ? 'Ch. ' + c.num : chapterName(c);
        sel.appendChild(o);
      });
    });
    dom.rangeFrom.value = '0';
    dom.rangeTo.value = String(Math.min(ordered.length - 1, 9));
  }

  async function downloadRange() {
    const s = currentSeries;
    if (!s) return;
    const ordered = orderedChapters(s);
    let a = parseInt(dom.rangeFrom.value, 10) || 0;
    let b = parseInt(dom.rangeTo.value, 10) || 0;
    if (a > b) { const t = a; a = b; b = t; }
    const slice = ordered.slice(a, b + 1).slice(0, MAX_RANGE_DOWNLOAD);
    if (!slice.length) return;

    const go = document.getElementById('cat-range-go');
    if (go) go.disabled = true;
    let done = 0, failed = 0;
    for (const ch of slice) {
      dom.rangeStatus.textContent = 'Saving ' + (done + failed + 1) + ' of ' + slice.length + '…';
      if (cachedIds.has(ch.id)) { done++; continue; }
      try { await resolveChapterContent(s, ch); cachedIds.add(ch.id); done++; }
      catch (e) { failed++; }
    }
    dom.rangeStatus.textContent = failed
      ? done + ' saved, ' + failed + ' failed'
      : done + ' chapter' + (done === 1 ? '' : 's') + ' saved offline';
    if (go) go.disabled = false;
    renderStats(s);
    renderChapterList();
    // A batch just landed up to 100 rows in one go — settle the cache now
    // rather than waiting for the next steady-state threshold.
    runCachePrune();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dispatch — the one place that decides which reader gets a chapter
  // ─────────────────────────────────────────────────────────────────────────

  async function openChapter(series, chapter, opts) {
    if (!series || !chapter) return;
    // Callers pass whatever progress row they were rendered from, which may be
    // stale (the Continue rail, the cached seriesProgress behind the chapter
    // list). A stale anchor is not a cosmetic problem: the reader adopts it and
    // then writes it back, erasing the real position. The store is the truth.
    let resume = (opts && opts.resume) || null;
    if (resume) {
      const fresh = await safeCall('getProgress', [series.id], null);
      if (fresh && fresh.chapterId === chapter.id) resume = fresh;
      else if (fresh && resume.chapterId !== chapter.id) resume = null;
    }
    const backTo = currentSeries && currentSeries.id === series.id ? 'series-screen' : 'home-screen';

    window.showScreen('loading-screen');
    const lt = document.getElementById('loading-text');
    if (lt) lt.textContent = 'Loading chapter…';

    let file;
    try {
      file = await resolveChapterContent(series, chapter);
    } catch (err) {
      console.warn('[Catalogue] chapter resolve failed', err);
      window.showScreen(backTo);
      toast(errorText(err));
      return;
    }

    await writeOpenProgress(series, chapter, file, resume);

    // Push the reader itself, so goBack() pops the reader and lands on the
    // screen underneath. Without this it popped 'series-screen' — the entry
    // for the screen the reader was opened *from* — and every close went home,
    // losing the chapter list and its scroll position.
    pushScreen(backTo === 'series-screen' ? 'series-screen' : 'home-screen');
    pushScreen('reader');

    if (file.kind === 'image' || (Array.isArray(file.pages) && file.pages.length)) {
      const resumePage = (resume && resume.chapterId === chapter.id && typeof resume.pageIdx === 'number')
        ? resume.pageIdx : null;
      loadOnlineChapter(series.title, Object.assign({}, chapter, { pages: file.pages }), {
        series: series, chapter: chapter, resumePageIdx: resumePage,
      });
      return;
    }

    if (window.NovelReader && typeof window.NovelReader.open === 'function') {
      activeImageSession = null;
      window.NovelReader.open({
        series: series,
        chapter: chapter,
        blocks: file.blocks || [],
        resume: (resume && resume.chapterId === chapter.id)
          ? { blockIdx: resume.blockIdx || 0, charOffset: resume.charOffset || 0, pct: resume.pct || 0 }
          : null,
      });
      return;
    }

    // The novel reader is optional at load time (it ships as its own module).
    window.showScreen(backTo);
    toast('The novel reader is not available in this build.');
  }

  // Reading a new chapter must not inherit the previous chapter's scroll
  // position, so positional fields are reset unless we are genuinely resuming.
  async function writeOpenProgress(series, chapter, file, resume) {
    const resuming = !!(resume && resume.chapterId === chapter.id);
    const patch = {
      seriesTitle: series.title,
      seriesType: series.type,
      cover: series.cover || null,
      chapterId: chapter.id,
      chapterNum: chapter.num,
      chapterTitle: chapter.title || null,
      chapterCount: (series.chapters || []).length,
    };
    if (!resuming) {
      patch.pageIdx = 0;
      patch.blockIdx = 0;
      patch.charOffset = 0;
      patch.pct = 0;
      patch.completed = false;
    }
    if (file.kind === 'image') patch.pageCount = (file.pages || []).length;
    await safeCall('putProgress', [series.id, patch], null);
    seriesProgress = await safeCall('getProgress', [series.id], seriesProgress);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Image reader hand-off — ported from js/online.js, behaviour preserved.
  //
  // reader.js has no module API: it reads and writes a set of file-scope
  // globals. Poking them from here is the contract, not an accident — see the
  // list in resetReaderState().
  // ─────────────────────────────────────────────────────────────────────────

  let activeImageSession = null; // { series, chapter } while an online image chapter is open

  async function loadOnlineChapter(seriesTitle, chData, opts) {
    const options = opts || {};
    window.showScreen('loading-screen');
    const lt = document.getElementById('loading-text');
    if (lt) lt.textContent = 'Loading chapter…';

    let pageUrls = chData.pages;

    // External chapter JSON (pages not inlined in catalog.json).
    if ((!pageUrls || !pageUrls.length) && chData.src) {
      try {
        if (lt) lt.textContent = 'Fetching chapter…';
        const json = await fetchJson(resolveSrcUrl(String(chData.src)));
        const body = (json && json.chapter) ? json.chapter : json;
        pageUrls = body && body.pages;
      } catch (err) {
        window.showScreen('series-screen');
        toast(errorText(err));
        return;
      }
    }

    if (!pageUrls || !pageUrls.length) {
      window.showScreen('series-screen');
      toast('That chapter has no pages.');
      return;
    }

    resetReaderState();

    pageUrls.forEach(function (url) {
      pages.push({ entry: null, directUrl: imgUrl(url), url: null, loading: false, aspectLocked: false, gen: 0 });
    });

    const chNum  = chData.num != null ? chData.num : null;
    const chName = chData.title || (chNum != null ? 'Chapter ' + chNum : 'Chapter');
    chapters.push({ name: chName, displayNum: chNum, start: 0, end: pages.length - 1, wrappers: [], dividerEl: null });

    maxChapterNum     = chNum != null ? chNum : 1;
    baseChapterOffset = chNum != null ? chNum - 1 : 0;
    comicTitle.textContent = seriesTitle;
    lastLoadedFileNames    = [seriesTitle];
    // Keeps reader.js's close button returning to the series screen rather than
    // reloading the app. reader.js reads this as a bare global.
    window.readerOrigin    = 'series';

    activeImageSession = (options.series && options.chapter)
      ? { series: options.series, chapter: options.chapter }
      : null;

    renderShell();
    setupObservers();
    window.showScreen('reader-screen');
    uiHidden = false;
    updateUI(); resetIdle(); setupUI();
    if (chapterMode && chapters.length > 0) {
      const target = (typeof options.resumePageIdx === 'number' && options.resumePageIdx > 0)
        ? Math.min(options.resumePageIdx, pages.length - 1)
        : null;
      jumpToChapter(0, target);
    }
  }

  window.loadOnlineChapter = loadOnlineChapter;

  // reader.js owns page tracking but knows nothing about Store, so the
  // catalogue samples its `currentPage` global and writes progress. Throttled,
  // plus a final write when the tab is hidden or the page is going away.
  let lastImageSave = 0;
  function syncImageProgress(force) {
    if (!activeImageSession) return;
    if (document.body.dataset.screen !== 'reader-screen') return;
    const now = Date.now();
    if (!force && now - lastImageSave < 1500) return;
    lastImageSave = now;

    const total = (typeof pages !== 'undefined' && pages) ? pages.length : 0;
    if (!total) return;
    const idx = Math.max(0, Math.min(total - 1, typeof currentPage === 'number' ? currentPage : 0));
    const s = activeImageSession.series, ch = activeImageSession.chapter;
    safeCall('putProgress', [s.id, {
      seriesTitle: s.title, seriesType: s.type, cover: s.cover || null,
      chapterId: ch.id, chapterNum: ch.num, chapterTitle: ch.title || null,
      chapterCount: (s.chapters || []).length,
      pageIdx: idx, pageCount: total,
      pct: total > 1 ? (idx / (total - 1)) : 1,
      completed: idx >= total - 1,
    }], null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Routing
  // ─────────────────────────────────────────────────────────────────────────

  function pushScreen(id) {
    if (navStack[navStack.length - 1] !== id) navStack.push(id);
    if (navStack.length > 20) navStack.shift();
  }

  function goHome() {
    ensureDom();
    navStack = ['home-screen'];
    activeImageSession = null;
    window.readerOrigin = 'upload';
    window.showScreen('home-screen');
    renderHome();
    // Progress was last read at boot, so the Continue rail would otherwise show
    // a snapshot from before anything in this session was read. Re-read and
    // re-render; the screen is already up, so this only refreshes the rail.
    loadProgress().then(function () { renderContinue(); }).catch(function () {});
  }

  // Re-read the progress row the series screen was rendered from. Everything on
  // that screen that says "where you are" — the resume button, the per-chapter
  // read/reading marks — is drawn from `seriesProgress`, which a reading session
  // invalidates without telling anyone: the reader writes to the store, not to
  // this cache.
  function refreshSeriesProgress() {
    const s = currentSeries;
    if (!s) return;
    Promise.resolve(safeCall('getProgress', [s.id], null)).then(function (p) {
      if (currentSeries !== s) return;   // navigated on while we were waiting
      seriesProgress = p;
      renderPrimaryAction(s);
      renderChapterList();
    }).catch(function () {});
  }

  function goBack() {
    navStack.pop();
    const prev = navStack[navStack.length - 1];
    if (prev === 'series-screen' && currentSeries) {
      window.showScreen('series-screen');
      // This is the path back out of the novel reader, and the one the hardware
      // back button takes out of either reader.
      refreshSeriesProgress();
      return;
    }
    goHome();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // History sentinel (PLAN7 §2.11-A)
  //
  // A ONE-ENTRY sentinel, not a mirrored stack: one back gesture = one
  // goBack(). Every pushState is gated on the `armed` bit, so at most one
  // sentinel entry can ever exist; the one async hole (history.back() is
  // async — its popstate lands a tick later) is closed by queueing arming
  // through the `disarming` bit. The layer is self-healing: every popstate
  // routes against the LIVE data-screen, so a transient mismatch resolves on
  // the next event instead of accumulating. Forward gestures stay inert
  // (there is never a forward entry we honor) — a documented limitation, not
  // a bug. No URL changes, no hash routing, no deep links via history.
  //
  // What this buys: browser/PWA back and iOS Safari/PWA edge-swipe navigate
  // one screen back everywhere except inside readers, where they are
  // CANCELLED — on iOS the OS plays its native swipe animation against a
  // stale snapshot before popstate fires, so an in-reader swipe shows a
  // slide-and-snap-back flicker. Cosmetic (no teardown, no state change);
  // the honest price of same-document history (§2.11-A). Android hardware
  // back never touches this layer — platform.js's dispatch table (the same
  // semantic table, ARCHITECTURE §2.2) handles it natively.
  // ─────────────────────────────────────────────────────────────────────────

  const ROOT_SCREENS = { 'home-screen': true, 'upload-screen': true };
  let sentinelArmed     = false;
  let sentinelDisarming = false;

  function sentinelPush() {
    // Safari rate-limits pushState; a refused push just means the next back
    // gesture leaves the app, which is the pre-sentinel behaviour.
    try { history.pushState({ or: 'sentinel' }, ''); sentinelArmed = true; }
    catch (e) { /* history unavailable — gestures fall back to the browser */ }
  }

  // Module screens close through their own close() so their teardown runs;
  // an absent optional module's row falls through to goBack() harmlessly
  // (§0.5) — the same guarded dispatch as platform.js's hardware-back table.
  function closeVia(name) {
    const M = window[name];
    if (M && typeof M.close === 'function') {
      try { M.close(); return; } catch (e) { console.warn('[Catalogue] ' + name + '.close failed', e); }
    }
    goBack();
  }

  function wireHistorySentinel() {
    if (!window.history || typeof history.pushState !== 'function') return;
    try { history.replaceState({ or: 'root' }, ''); } catch (e) { /* same tolerance as sentinelPush */ }

    // The app's one navigation signal: showScreen stamps body[data-screen].
    // Entering any non-root screen arms; returning to a root screen disarms
    // by consuming our own entry with history.back(), whose popstate is
    // swallowed below. While `disarming` is true nothing may push — arming
    // is QUEUED through the swallowed popstate, never doubled.
    const mo = new MutationObserver(function () {
      const s = (document.body && document.body.dataset.screen) || '';
      if (!s) return;
      if (!ROOT_SCREENS[s]) {
        if (!sentinelArmed && !sentinelDisarming) sentinelPush();
      } else if (sentinelArmed && !sentinelDisarming) {
        sentinelDisarming = true;
        try { history.back(); }
        catch (e) { sentinelDisarming = false; sentinelArmed = false; }
      }
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });

    window.addEventListener('popstate', function () {
      // The swallowed popstate from our own disarming history.back(). If the
      // user already re-entered a non-root screen while the back was in
      // flight, arm NOW (a single pushState) — the disarm-queue rule.
      if (sentinelDisarming) {
        sentinelDisarming = false;
        sentinelArmed = false;
        const live = (document.body && document.body.dataset.screen) || '';
        if (live && !ROOT_SCREENS[live]) sentinelPush();
        return;
      }

      // A real gesture consumed the sentinel entry; route on the LIVE screen.
      sentinelArmed = false;
      const s = (document.body && document.body.dataset.screen) || '';

      if (s === 'novel-screen' || s === 'reader-screen') {
        // Cancel: a swipe never exits a reader (§2.2 — readers leave only
        // through their own close paths). Re-arm and do nothing.
        sentinelPush();
        return;
      }
      if (s === 'loading-screen') {
        // Cancel: a transitional screen — it resolves to a reader on its
        // own, and tearing it down mid-fetch from a gesture helps nobody.
        sentinelPush();
        return;
      }
      if (!s || ROOT_SCREENS[s]) return;     // at root: unarmed, nothing to unwind

      if (s === 'import-screen')   { closeVia('Importer');    return; }
      if (s === 'goals-screen')    { closeVia('Goals');       return; }
      if (s === 'settings-screen') { closeVia('AppSettings'); return; }
      if (s === 'sources-screen')  { closeVia('Sources');     return; }
      if (s === 'thoughts-screen') { closeVia('Thoughts');    return; }
      // series-screen — and any screen a future module registers — unwinds
      // through the catalogue's own back. The MutationObserver re-arms or
      // disarms off whatever screen the route lands on.
      goBack();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wiring
  // ─────────────────────────────────────────────────────────────────────────

  function wireEvents() {
    const search = document.getElementById('home-search');
    if (search) {
      search.addEventListener('input', debounce(function () {
        searchQuery = search.value.trim().toLowerCase();
        gridCardLimit = GRID_CHUNK; // a new query is a new list, like a tab switch
        renderHome();
      }, 180));
    }

    const back = document.getElementById('series-back-btn');
    if (back) {
      back.setAttribute('aria-label', 'Back to library');
      back.addEventListener('click', function () { goBack(); });
    }

    const online = document.getElementById('go-online-btn');
    if (online) {
      online.addEventListener('click', async function () {
        window.showScreen('home-screen');
        navStack = ['home-screen'];
        await refresh();
      });
    }

    const offline = document.getElementById('go-offline-btn');
    if (offline) offline.addEventListener('click', function () { window.showScreen('upload-screen'); });

    // Progress sampling for the image reader.
    window.addEventListener('scroll', function () { syncImageProgress(false); }, { passive: true });
    document.addEventListener('visibilitychange', function () { if (document.hidden) syncImageProgress(true); });
    window.addEventListener('pagehide', function () { syncImageProgress(true); });
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) closeBtn.addEventListener('click', function () {
      syncImageProgress(true);
      // The close handler in reader.js shows the series screen; refresh the
      // chapter list so read-state and the resume button reflect this session.
      setTimeout(refreshSeriesProgress, 0);
    });

    // #home-btn — the flush half of the two-listener contract (PLAN7
    // §2.11-C). reader.js wired its teardown+goHome listener at PARSE time,
    // before this module ever runs, and same-node listeners fire in
    // registration order — a plain listener here would run AFTER the
    // teardown, when pages and activeImageSession are already gone and there
    // is nothing left to flush. Capturing on document is what makes "flush
    // image progress first" true: the capture phase visits document before
    // any listener on the button itself fires.
    const homeBtn = document.getElementById('home-btn');
    if (homeBtn) {
      document.addEventListener('click', function (e) {
        const t = e.target;
        if (!t || !(t === homeBtn || (homeBtn.contains && homeBtn.contains(t)))) return;
        syncImageProgress(true);
        // reader.js's own listener tears the session down and hands off to
        // goHome(); refresh the series screen's cached progress after that
        // hand-off has run (the #close-btn pattern above).
        setTimeout(refreshSeriesProgress, 0);
      }, true);
    }

    // Live home-layout changes (§2.12): re-place the five registry sections
    // and re-render when home.sections is written (settings' editor) or the
    // pref blob reloads wholesale (key null — mirror restore, storage event).
    // renderHome runs applySectionOrder itself, so one call covers both.
    window.addEventListener('or:prefs', function (ev) {
      if (!domReady) return;
      const d = ev && ev.detail;
      const key = d ? d.key : undefined;
      if (key !== null && key !== 'home.sections') return;
      renderHome();
    });

    // Connectivity. On the WEB, losing the network while browsing drops to the
    // CBZ reader — the only thing guaranteed to work without a connection. On
    // native that logic inverts: the catalogue is a bundled local file that
    // always works, so the user keeps browsing and only the badge changes.
    window.addEventListener('offline', function () {
      const screen = document.body.dataset.screen;
      if (!isNativeApp() && (screen === 'home-screen' || screen === 'series-screen')) {
        window.showScreen('upload-screen');
        const b = document.getElementById('offline-reader-badge');
        if (b) b.classList.add('visible');
      }
      const badge = document.getElementById('offline-badge');
      if (badge) badge.classList.add('visible');
    });

    window.addEventListener('online', function () {
      const badge = document.getElementById('offline-badge');
      if (badge) badge.classList.remove('visible');
      const rb = document.getElementById('offline-reader-badge');
      if (rb) rb.classList.remove('visible');
      const up = document.getElementById('upload-screen');
      if (up && up.style.display !== 'none') initMode();
    });

    // Imported series land in the store asynchronously; refresh when told.
    window.addEventListener('or:library-changed', function () { refresh(); });
  }

  function wireServiceWorkerBadge() {
    // Native builds run without a service worker (reader.js gates its own
    // registration on Platform.isNative), so the version stamp comes from the
    // app binary instead of the SW cache name.
    const P = platform();
    if (P && P.isNative && typeof P.appVersion === 'function') {
      P.appVersion().then(function (v) {
        const stamp = document.getElementById('home-version');
        if (stamp && v) stamp.textContent = 'v' + String(v);
      }).catch(function () { /* no version info — the badge just stays blank */ });
      return;
    }
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      const sw = reg.active;
      if (!sw) return;
      navigator.serviceWorker.addEventListener('message', function handler(e) {
        if (e.data && e.data.type === 'VERSION') {
          const stamp = document.getElementById('home-version');
          if (stamp) stamp.textContent = String(e.data.version || '').replace('cbz-reader-', '');
          navigator.serviceWorker.removeEventListener('message', handler);
        }
      });
      sw.postMessage('GET_VERSION');
    }).catch(function () { /* no SW in this context — the badge just stays blank */ });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────

  async function refresh() {
    ensureDom();
    await Promise.all([loadCatalog(), loadUserSeries()]);
    mergeSeries();
    await loadProgress();
    renderHome();
    // Keep an open series detail screen in sync with the reloaded data.
    if (currentSeries) {
      const fresh = findSeries(currentSeries.id);
      if (fresh) await openSeries(fresh, { show: false });
    }
  }

  async function initMode() {
    ensureDom();
    // navigator.onLine is not a boot gate on native: the WebView can report
    // false at cold start, and the "online" branch's catalogue is a bundled
    // local file that loads with the radios off. Native always boots to home;
    // real connectivity loss shows as badge state, never as a screen swap.
    if (isNativeApp() || navigator.onLine) {
      window.showScreen('home-screen');
      navStack = ['home-screen'];
      await refresh();
    } else {
      // No connection: the bundled catalogue may still be in the SW cache, so
      // load it anyway — but land the user on the reader that always works.
      window.showScreen('upload-screen');
      const b = document.getElementById('offline-reader-badge');
      if (b) b.classList.add('visible');
      const badge = document.getElementById('offline-badge');
      if (badge) badge.classList.add('visible');
      await refresh();
    }
  }

  async function boot() {
    if (booted) return;
    booted = true;
    if (typeof window.readerOrigin === 'undefined') window.readerOrigin = 'upload';
    // Native init restores mirror-evicted prefs before anything renders, so
    // the first post-eviction launch paints with the user's real settings. On
    // the web ready is a pre-resolved promise — one microtask, no delay.
    await (window.Platform ? Platform.ready : Promise.resolve());
    ensureDom();
    wireEvents();
    wireHistorySentinel();
    wireServiceWorkerBadge();
    await initMode();
    // Cache-prune trigger 1: once per boot, off the critical path — the first
    // render owns the frame budget, housekeeping waits for idle.
    deferToIdle(function () { runCachePrune(); });
  }

  window.Catalogue = {
    boot: boot,
    openSeries: openSeries,
    openChapter: openChapter,
    goBack: goBack,
    goHome: goHome,
    refresh: refresh,
    // Read-only accessors other modules occasionally need (novel reader wants
    // the neighbouring chapters; importer wants to jump to what it just added).
    getSeries: findSeries,
    listSeries: function () { return allSeries.slice(); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
