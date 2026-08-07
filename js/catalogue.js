// Offline Reader — catalogue, routing and the shared chapter resolver.
// Replaces the old js/online.js. See docs/ARCHITECTURE.md §1, §2.2, §4.
//
// This module owns navigation for the whole app: every other module asks
// `Catalogue` to move the user somewhere rather than calling `showScreen`
// itself, so there is exactly one place that knows what "back" means.
//
// It also owns `window.resolveChapterContent`, the single funnel through which
// any chapter payload — inline, external file, MangaDex, worker gateway — turns
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

  function currentTab()    { const t = prefGet('catalogue.tab', 'all');    return TABS.some(x => x.id === t) ? t : 'all'; }
  function currentLayout() { const l = prefGet('catalogue.layout', 'grid'); return l === 'list' ? 'list' : 'grid'; }

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
  function safeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
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
    // v1 MangaDex entries carry only `mdChapterId`; Store keys need a stable id.
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

  async function mangadexPages(mdChapterId) {
    const json = await fetchJson('https://api.mangadex.org/at-home/server/' + encodeURIComponent(mdChapterId));
    const base = json && json.baseUrl;
    const ch = json && json.chapter;
    if (!base || !ch || !Array.isArray(ch.data)) throw catErr('parse', 'Unexpected at-home response');
    return ch.data.map(function (f) { return base + '/data/' + ch.hash + '/' + f; });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // window.resolveChapterContent — the one funnel (ARCHITECTURE §4)
  //
  // Order, cache-first:
  //   1. Store.getChapter
  //   2. inline blocks / pages / text on the Chapter
  //   3. chapter.src        (relative to app root, or absolute)
  //   4. chapter.mdChapterId via the MangaDex at-home API
  //   5. worker /chapter?url=…   (only when OR_CONFIG.workerBase is set)
  // Whatever wins is normalized to a ChapterFile, written to Store, returned.
  // ─────────────────────────────────────────────────────────────────────────

  const inflight = new Map(); // de-dupe concurrent resolves of the same chapter

  async function resolveChapterContent(series, chapter) {
    if (!series || !series.id) throw catErr('no-payload', 'resolveChapterContent: series.id is required');
    if (!chapter || !chapter.id) throw catErr('no-payload', 'resolveChapterContent: chapter.id is required');

    const key = series.id + ' ' + chapter.id;
    if (inflight.has(key)) return inflight.get(key);

    const job = (async function () {
      // 1 ── cache
      const cached = await safeCall('getChapter', [series.id, chapter.id], null);
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

      // 4 ── MangaDex at-home (URLs expire, so they are never cached in catalog.json)
      if (!file && chapter.mdChapterId) {
        const pages = await mangadexPages(chapter.mdChapterId);
        file = normalizeChapterFile({ pages: pages }, series, chapter);
      }

      // 5 ── worker gateway
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

      // MangaDex page URLs are signed and short-lived; caching them would hand
      // the reader dead links tomorrow. Everything else is safe to persist.
      if (!(chapter.mdChapterId && !chapter.pages)) {
        await safeCall('putChapter', [series.id, chapter.id, file], file);
      }
      return file;
    })();

    inflight.set(key, job);
    try { return await job; }
    finally { inflight.delete(key); }
  }

  window.resolveChapterContent = resolveChapterContent;

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
    buildGridToolbar();
    buildEmptyState();
    buildSeriesExtras();
    buildToast();

    domReady = true;
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
    dom.homeBody.insertBefore(section, dom.latestSection || null);
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
    bar.appendChild(addBtn);
    bar.appendChild(group);

    dom.gridToolbar = bar;
    dom.count = count;
    dom.addBtn = addBtn;
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

    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(action);

    dom.empty = box;
    dom.emptyTitle = title;
    dom.emptyBody = body;
    dom.emptyAction = action;

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
      .join('   ').toLowerCase();
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

    const tab = currentTab();
    const list = visibleSeries();

    if (dom.homeState) dom.homeState.style.display = 'none';
    if (dom.tabs) dom.tabs.style.display = 'flex';

    syncTabs(tab);
    syncLayout();
    renderContinue();

    // Latest updates is a "what's new" rail — it makes no sense while the user
    // is searching, and My Library has its own ordering (newest added first).
    const showLatest = !searchQuery && tab !== 'library' && list.length > 0;
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
    if (dom.count) dom.count.textContent = list.length ? list.length + (list.length === 1 ? ' series' : ' series') : '';
    if (dom.chapterToolbar) dom.chapterToolbar.style.display = 'flex';

    renderGrid(list, tab);
    renderEmpty(list, tab);
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
    renderHome();
  }

  function setLayout(id) {
    prefSet('catalogue.layout', id);
    renderHome();
  }

  // ── Continue reading rail ────────────────────────────────────────────────

  function renderContinue() {
    if (!dom.continueRail) return;
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

  async function resumeProgress(p) {
    const series = findSeries(p.seriesId);
    if (!series) { toast('That series is no longer in your library.'); return; }
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

  function placeholder(series, cls) {
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

    list.forEach(function (s) {
      grid.appendChild(isTextSeries(s) ? novelCard(s, tab) : mangaCard(s, tab));
    });
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
    const ph = el('div', 'cat-spine-ph');
    ph.appendChild(el('span', 'cat-spine-title', s.title));
    if (s.author) ph.appendChild(el('span', 'cat-spine-author', s.author));
    return ph;
  }

  async function confirmDelete(s) {
    if (!window.confirm('Remove “' + s.title + '” from your library?\n\nCached chapters and reading progress for it will also be deleted.')) return;
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

    if (catalogError && !allSeries.length) {
      dom.emptyTitle.textContent = 'Library unavailable';
      dom.emptyBody.textContent = 'Could not load the catalogue. Check your connection, or add a series you already read.';
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
    if (tab === 'library') {
      dom.emptyTitle.textContent = 'Your library is empty';
      dom.emptyBody.textContent = 'No series yet — paste a link to one you already read, or open an EPUB, TXT or CBZ from this device.';
      dom.emptyAction.textContent = 'Add a series';
      dom.emptyAction.style.display = 'inline-flex';
      dom.emptyAction.onclick = openImporter;
      return;
    }
    if (tab === 'lightnovel') {
      dom.emptyTitle.textContent = 'No light novels yet';
      dom.emptyBody.textContent = 'The bundled catalogue has none. Paste a link to a novel you already read and it will show up here.';
      dom.emptyAction.textContent = 'Add a series';
      dom.emptyAction.style.display = 'inline-flex';
      dom.emptyAction.onclick = openImporter;
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

  function chapterState(ch, orderedIdx) {
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

    rows.forEach(function (r) {
      list.appendChild(chapterRow(s, r.ch, r.idx));
    });
  }

  function chapterRow(s, ch, orderedIdx) {
    const state = chapterState(ch, orderedIdx);
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

  function populateRangeSelects(s) {
    if (!dom.rangeFrom) return;
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
    dom.rangeStatus.textContent = '';
    dom.rangePanel.style.display = 'none';
    if (dom.rangeBtn) dom.rangeBtn.setAttribute('aria-expanded', 'false');
    dom.actions.style.display = ordered.length ? 'flex' : 'none';
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
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dispatch — the one place that decides which reader gets a chapter
  // ─────────────────────────────────────────────────────────────────────────

  async function openChapter(series, chapter, opts) {
    if (!series || !chapter) return;
    const resume = (opts && opts.resume) || null;
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

    // MangaDex at-home URLs expire — fetch fresh at read time.
    if ((!pageUrls || !pageUrls.length) && chData.mdChapterId) {
      try {
        if (lt) lt.textContent = 'Fetching chapter…';
        pageUrls = await mangadexPages(chData.mdChapterId);
      } catch (err) {
        window.showScreen('series-screen');
        toast(errorText(err));
        return;
      }
    }

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
  }

  function goBack() {
    navStack.pop();
    const prev = navStack[navStack.length - 1];
    if (prev === 'series-screen' && currentSeries) { window.showScreen('series-screen'); return; }
    goHome();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wiring
  // ─────────────────────────────────────────────────────────────────────────

  function wireEvents() {
    const search = document.getElementById('home-search');
    if (search) {
      search.addEventListener('input', debounce(function () {
        searchQuery = search.value.trim().toLowerCase();
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
      setTimeout(function () {
        if (!currentSeries) return;
        safeCall('getProgress', [currentSeries.id], null).then(function (p) {
          seriesProgress = p;
          renderPrimaryAction(currentSeries);
          renderChapterList();
        });
      }, 0);
    });

    // Connectivity. Losing the network while browsing drops to the CBZ reader,
    // which is the only thing guaranteed to work without a connection.
    window.addEventListener('offline', function () {
      const screen = document.body.dataset.screen;
      if (screen === 'home-screen' || screen === 'series-screen') {
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
    if (navigator.onLine) {
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
    ensureDom();
    wireEvents();
    wireServiceWorkerBadge();
    await initMode();
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
