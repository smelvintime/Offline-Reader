// Offline Reader — "bring your own series" importer. See docs/ARCHITECTURE.md §5.
//
// Two entirely separate paths land in the same place:
//
//   URL  → worker /resolve → Series with chapters that carry `src` (§6.2)
//   FILE → EPUB / TXT / CBZ parsed here, in the browser, with no server at all
//
// Both funnel through a *draft*: a Series plus (for file imports) the chapter
// content we already extracted, held in memory and NOT yet persisted. The UI
// shows the draft for confirmation and lets the user fix the title and the
// content type before anything is written. Heuristics get those two wrong often
// enough that a two-second correction beats a permanently wrong library entry,
// and once a Series id exists it is load-bearing (progress is keyed by it).
//
// The public API commits immediately (importUrl/importFile are documented as
// returning a persisted Series); only the interactive flow stops to confirm.
//
// Security: EPUB XHTML is third-party content. It is parsed with DOMParser into
// a detached document that is never attached to the live DOM, and walked to
// emit typed Blocks (§1.3). We never call innerHTML with it, never copy an
// event-handler attribute, and never let a non-http(s)/data:image URL reach an
// <img src>. `<script>`/`<style>` subtrees are dropped outright. Files opened
// from native disk get the exact same treatment — native access changes where
// bytes live, never how much we trust them.
//
// Under Capacitor the same pipelines run with native plumbing behind
// window.Platform: archives are picked by URI and moved into app storage
// without their bytes ever entering JS, pages are extracted natively on
// demand, and a small JSON backup of the library rides in Documents/ as
// eviction insurance. Every Platform call is guarded — on the plain web this
// file behaves exactly as it always has. CBZ chapters are no longer
// decompressed at boot: stored rows keep `entries` + `archiveKey` as the
// durable truth with `pages: []`, and `hydrateChapter` below yields live,
// session-local page URLs one chapter at a time.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const SCREEN_ID = 'import-screen';

  const TYPES = [
    { id: 'manga',      label: 'Manga' },
    { id: 'manhwa',     label: 'Manhwa / Webtoon' },
    { id: 'lightnovel', label: 'Light novel' },
    { id: 'webnovel',   label: 'Web novel' },
  ];
  const TYPE_IDS = new Set(TYPES.map(function (t) { return t.id; }));
  const TEXT_TYPES = new Set(['lightnovel', 'webnovel']);

  // Query parameters that identify the *referrer*, not the content. Stripping
  // them is what makes "the link I copied from Twitter" and "the link I typed"
  // hash to the same series id.
  const TRACKING_PARAMS = new Set([
    'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid',
    'ref', 'ref_src', 'ref_url', 'referrer', 'source', 'spm', '_ga', '_gl',
    'igsh', 'si', 'feature', 'share_id', 'share',
  ]);

  // Covers are shrunk before they go in the Series row: a 1.5 MB JPEG as a data
  // URL would be re-read on every catalogue render for a 120×170 thumbnail.
  const COVER_MAX_EDGE  = 640;
  const COVER_RAW_LIMIT = 900 * 1024;   // fallback path: refuse to inline more

  const EPUB_IMG_MAX_BYTES   = 1.5 * 1024 * 1024;  // per illustration
  const EPUB_IMG_DOC_BUDGET  = 8 * 1024 * 1024;    // per chapter
  const KEEP_SOURCE_FILE_MAX = 64 * 1024 * 1024;   // keep EPUB/TXT blob below this

  const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  };

  // ── Small DOM/util helpers ────────────────────────────────────────────────

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // Static, author-controlled SVG only — never called with imported data.
  const ICONS = {
    back:   '<polyline points="15 18 9 12 15 6"/>',
    link:   '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    file:   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    check:  '<polyline points="20 6 9 17 4 12"/>',
    warn:   '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    gear:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    trash:  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    refresh:'<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    down:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    up:     '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    book:   '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    image:  '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    chev:   '<polyline points="6 9 12 15 18 9"/>',
  };

  function icon(name, size) {
    const s = size || 15;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';   // static markup from the table above only
    return svg;
  }

  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function collapse(s) {
    return String(s == null ? '' : s).replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function countWords(s) {
    const m = String(s || '').match(/\S+/g);
    return m ? m.length : 0;
  }

  function blocksWordCount(blocks) {
    let n = 0;
    for (const b of blocks) {
      if (typeof b.c === 'string') n += countWords(b.c);
      if (Array.isArray(b.items)) for (const it of b.items) n += countWords(it);
    }
    return n;
  }

  function pad4(n) { return ('000' + n).slice(-4); }

  function nowIso() { return new Date().toISOString(); }

  function store() { return window.Store || null; }

  // Persistence must never take the import down with it: a failed write is
  // reported, not thrown into the middle of a 300-chapter loop.
  async function safeStore(method, args, fallback) {
    const S = store();
    if (!S || typeof S[method] !== 'function') return fallback;
    try { return await S[method].apply(S, args || []); }
    catch (e) { console.warn('[Importer] Store.' + method + ' failed', e); return fallback; }
  }

  function gatewayBase() {
    const cfg = window.OR_CONFIG || {};
    return String(cfg.workerBase || '').replace(/\/+$/, '');
  }
  function gatewayEnabled() { return !!gatewayBase(); }

  function gatewayUrl(path, params) {
    const base = gatewayBase();
    if (!base) return null;
    if (typeof window.gatewayUrl === 'function') {
      const u = window.gatewayUrl(path, params);
      if (u) return u;
    }
    const qs = new URLSearchParams(params || {}).toString();
    return base + path + (qs ? '?' + qs : '');
  }

  // Mirrors the catalogue's rule: only these schemes may reach an <img src>.
  //
  // Capacitor's local-file origins are the one addition: iOS serves extracted
  // pages from capacitor://localhost, Android re-serves them under
  // https://localhost with a /_capacitor_file_/ path. Both are pinned as
  // EXACT prefixes — origin plus path start, never a substring — so a
  // lookalike (capacitor://localhost.evil, some capacitor-evil scheme) still
  // falls through to the refusal at the bottom.
  function safeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
    if (/^capacitor:\/\/localhost\//i.test(u)) return u;
    if (/^https:\/\/localhost\/_capacitor_file_\//i.test(u)) return u;
    if (/^https?:/i.test(u)) return u;
    if (/^data:image\//i.test(u)) return u;
    if (/^blob:/i.test(u)) return u;
    return '';   // relative paths are meaningless once the source page is gone
  }

  // A chapter `src` is fetched, never navigated to, but pinning the scheme
  // keeps a compromised or buggy gateway from parking `javascript:` in the
  // user's library where some future code path might dereference it.
  function safeFetchUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '';   // any other scheme — drop it
    return u;                                        // relative to the app root
  }

  // Only real web URLs may become hrefs — the catalogue's rule, applied to the
  // one external link this screen renders (the Gutenberg card, §2.10). KEEP IN
  // SYNC: catalogue.js and sources.js carry the same twin (PLAN.md §8
  // amendment 13's keep-in-sync list).
  function safeHttpUrl(url) {
    return (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) ? url.trim() : '';
  }

  function displayImageUrl(url) {
    const safe = safeImageUrl(url);
    if (!safe) return '';
    // Hotlink-protected covers need the gateway; data/blob URLs never do —
    // and neither does Android's https://localhost local-file form, which
    // only dresses like a remote URL.
    if (/^https?:/i.test(safe) && !/^https:\/\/localhost\/_capacitor_file_\//i.test(safe)
        && typeof window.proxyImageUrl === 'function') {
      try { return window.proxyImageUrl(safe); } catch (e) { return safe; }
    }
    return safe;
  }

  // ── Platform seam (Capacitor, always via window.Platform) ─────────────────
  //
  // The bridge is the only module allowed to touch Capacitor; this module only
  // ever asks it. Every helper here is guarded for absence so the plain web
  // build runs exactly as it did before the bridge existed.

  function platform() { return window.Platform || null; }

  // A PickedFile ({name, size, uri}) from Platform.pickFiles. It carries the
  // ORIGINAL name and size — file identity hashes them — but no bytes, and a
  // real File never has a uri.
  function isPickedUri(file) {
    return !!(file && typeof file.uri === 'string' && file.uri && typeof file.arrayBuffer !== 'function');
  }

  // Materialize a picked file into a real File; the bridge stamps the ORIGINAL
  // name back on. For EPUB/TXT sources and library JSON only — large archives
  // stay on disk and are read by URI, never through this.
  async function readPicked(picked) {
    const P = platform();
    if (!P || typeof P.readPickedFile !== 'function') return null;
    try { return await P.readPickedFile(picked); } catch (e) { return null; }
  }

  // Platform.pickFiles contract: null = no native picker exists (fall back to
  // the hidden <input>); [] = the user cancelled the native sheet (do nothing
  // — opening the <input> over a dialog they just dismissed would be hostile).
  async function nativePick(accept, multiple) {
    const P = platform();
    if (!P || typeof P.pickFiles !== 'function') return null;
    try { return await P.pickFiles({ accept: accept, multiple: !!multiple }); }
    catch (e) { return null; }
  }

  // blob: object URLs die with the document; Capacitor page URLs die with the
  // next app update (the iOS container path embeds a per-build UUID). Neither
  // may ever be persisted — finding one in a stored row means an earlier build
  // wrote it, and the row must be scrubbed back to entries-only.
  function isSessionLocalPageUrl(u) {
    return typeof u === 'string' && (
      /^blob:/i.test(u) ||
      /^capacitor:\/\//i.test(u) ||
      u.indexOf('_capacitor_file_') !== -1
    );
  }

  // Local calendar date, because backups and day logs follow the reader's
  // clock, not UTC's.
  function localDayStr() {
    const d = new Date();
    const pad = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ── Errors ────────────────────────────────────────────────────────────────

  function impErr(code, message, extra) {
    const e = new Error(message || code);
    e.name = 'ImportError';
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
  }

  function isAbort(e) {
    return !!e && (e.code === 'aborted' || e.name === 'AbortError');
  }

  // ── URL normalization and the stable series id ────────────────────────────
  //
  // The id has to survive the user pasting a slightly different spelling of the
  // same page, otherwise "re-import to resume" silently becomes "duplicate".
  // Rules, in order:
  //   1. scheme must be http(s); anything else is refused outright
  //   2. host lowercased, `www.` kept (some sites genuinely differ), default
  //      port dropped, embedded credentials dropped
  //   3. fragment dropped  (#chapter-3 is a position, not an identity)
  //   4. utm_* and the tracking parameters above dropped, survivors sorted
  //   5. trailing slashes stripped from the path
  // The result is the *only* thing hashed.

  function normalizeUrl(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) throw impErr('bad_input', 'Enter a link first.');

    let u;
    try { u = new URL(text); }
    catch (e) { throw impErr('bad_input', 'That does not look like a complete web address.'); }

    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw impErr('bad_scheme', 'Only http:// and https:// links can be imported.');
    }
    if (!u.hostname || u.hostname.indexOf('.') === -1) {
      throw impErr('bad_host', 'That link has no site name in it.');
    }

    u.username = '';
    u.password = '';
    u.hash = '';

    const keep = [];
    u.searchParams.forEach(function (value, key) {
      const k = key.toLowerCase();
      if (k.indexOf('utm_') === 0) return;
      if (TRACKING_PARAMS.has(k)) return;
      keep.push([key, value]);
    });
    keep.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1); });
    const qs = keep.map(function (p) {
      return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
    }).join('&');

    const host = u.hostname.toLowerCase() + (u.port ? ':' + u.port : '');
    let path = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');

    return u.protocol + '//' + host + path + (qs ? '?' + qs : '');
  }

  // SHA-256 where it exists. `crypto.subtle` is undefined on insecure origins
  // (plain http, some webviews), so a small synchronous hash stands in — ids
  // stay stable *within* an origin, which is all "re-import resumes" needs.
  const FALLBACK_MARK = 'x';

  function fallbackHash(str) {
    // Two FNV-1a passes with different offset bases → 64 bits of key space.
    let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 ^= (c * 31 + i) & 0xffff; h2 = (h2 + ((h2 << 1) + (h2 << 5) + (h2 << 13))) >>> 0;
    }
    return FALLBACK_MARK + ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  async function hashSeed(seed) {
    const subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) ? crypto.subtle : null;
    if (subtle && typeof TextEncoder !== 'undefined') {
      try {
        const buf = await subtle.digest('SHA-256', new TextEncoder().encode(seed));
        const bytes = new Uint8Array(buf);
        let hex = '';
        for (let i = 0; i < 8; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
        return hex;   // 64 bits is ample for a per-device library
      } catch (e) { /* fall through to the synchronous hash */ }
    }
    return fallbackHash(seed);
  }

  async function seriesIdForUrl(url) {
    return 'user:' + (await hashSeed(normalizeUrl(url)));
  }

  // Files have no URL, but "the same file" should still resume rather than
  // duplicate, so name + size stands in for identity.
  async function seriesIdForFile(file) {
    const seed = 'file:' + String(file.name || 'untitled').toLowerCase() + ':' + (file.size || 0);
    return 'user:' + (await hashSeed(seed));
  }

  // Pull the first http(s) URL out of arbitrary pasted text — share sheets on
  // Android hand over "Great chapter! https://site/… " as one string.
  function extractUrl(text) {
    if (!text) return '';
    const m = String(text).match(/https?:\/\/[^\s<>"')\]]+/i);
    return m ? m[0].replace(/[.,;:!?]+$/, '') : '';
  }

  // What we think it is *before* fetching anything, from the path alone.
  function guessTypeFromUrl(url) {
    let s = '';
    try { s = (new URL(url).hostname + new URL(url).pathname).toLowerCase(); }
    catch (e) { s = String(url).toLowerCase(); }
    if (/manhwa|webtoon|toon|manhua/.test(s)) return 'manhwa';
    if (/light-?novel|ranobe|ln\b|novelupdates|wuxia|xianxia/.test(s)) return 'lightnovel';
    if (/royalroad|scribblehub|webnovel|web-?novel|fiction|story|stories/.test(s)) return 'webnovel';
    if (/novel|book|read-?novel/.test(s)) return 'lightnovel';
    if (/manga|comic|chapter|mangadex/.test(s)) return 'manga';
    return 'manga';
  }

  function typeLabel(id) {
    const t = TYPES.find(function (x) { return x.id === id; });
    return t ? t.label : id;
  }

  // ── Gateway (§6.2) ────────────────────────────────────────────────────────
  //
  // Every documented error code gets its own sentence explaining what the user
  // can actually do about it. "Something went wrong" is how a feature like this
  // gets abandoned: half of these are fixable by the person reading them.

  const GATEWAY_ERRORS = {
    bad_url: {
      text: 'The gateway rejected that address. It needs a complete http:// or https:// link to a page — not a search result, a file path, or a link with a username and password in it.',
      retry: false,
    },
    blocked_host: {
      text: 'That host is not allowed. The gateway refuses raw IP addresses, private and local networks, and unusual ports, because an open proxy is a liability. If this is a normal public site, its address may be typed wrong.',
      retry: false,
    },
    not_allowlisted: {
      text: 'That host is not on the gateway allowlist yet. Import the series page first — the gateway learns image hosts from a successful lookup.',
      retry: false,
    },
    upstream_error: {
      text: 'The site did not answer properly — it may be down, blocking the gateway, or behind a bot check. Waiting a moment and trying again often works.',
      retry: true,
    },
    timeout: {
      text: 'The site took too long to answer. It is probably slow rather than broken, so trying again is worth it.',
      retry: true,
    },
    no_adapter: {
      text: 'We do not know how to read that site yet. There is no adapter for it and the generic reader could not make sense of the page. A different page on the same site (the series index rather than a chapter) sometimes works — otherwise download the chapters as EPUB or CBZ and import the file instead.',
      retry: false,
    },
    parse_failed: {
      text: 'We reached the page but could not find a chapter list on it. Link the series’ main page or table of contents rather than a single chapter, and make sure the list is not hidden behind a login.',
      retry: true,
    },
    too_large: {
      text: 'That page is far bigger than the gateway will download. Series with thousands of chapters sometimes paginate their list — try a page that shows part of it.',
      retry: false,
    },
    rate_limited: {
      text: 'Too many lookups in a short window. The gateway is a shared free service, so it throttles. Wait a minute and try again.',
      retry: true,
    },
    bad_content_type: {
      text: 'That link is a file, not a page. Download it and use “Open a file” below instead.',
      retry: false,
    },
    not_found: {
      text: 'The site returned “not found” for that address. The series may have moved or been taken down.',
      retry: false,
    },
    bad_request: { text: 'The gateway could not understand that request.', retry: false },
    bad_method:  { text: 'The gateway rejected that request.', retry: false },
    internal_error: {
      text: 'The gateway hit an unexpected error. This one is on us — trying again is reasonable, and if it keeps happening the worker log will say why.',
      retry: true,
    },
    gateway_unreachable: {
      text: 'Could not reach the content gateway at all. Check your connection, and check that OR_CONFIG.workerBase in js/config.js points at a worker that is actually deployed.',
      retry: true,
    },
    gateway_disabled: {
      text: 'Adding by link needs the content gateway, which this copy of the app does not have configured.',
      retry: false,
    },
    bad_response: {
      text: 'The gateway answered with something that is not a series. It may be an old version — redeploy the worker from worker/ and try again.',
      retry: true,
    },
    empty_series: {
      text: 'That page resolved, but it has no chapters on it. Link the series index rather than an author or genre page.',
      retry: true,
    },
  };

  function gatewayErrorInfo(code) {
    return GATEWAY_ERRORS[code] || {
      text: 'The gateway refused that link (' + String(code || 'unknown error') + ').',
      retry: true,
    };
  }

  // GET /resolve?url=… → { ok, adapter, confidence?, series }
  async function gatewayResolve(url, opts) {
    const options = opts || {};
    const signal = options.signal;
    const target = gatewayUrl('/resolve', { url: url });
    if (!target) throw impErr('gateway_disabled', GATEWAY_ERRORS.gateway_disabled.text);

    let res;
    try {
      res = await fetch(target, { credentials: 'omit', signal: signal });
    } catch (e) {
      if (signal && signal.aborted) throw impErr('aborted', 'Import cancelled');
      throw impErr('gateway_unreachable', GATEWAY_ERRORS.gateway_unreachable.text, { cause: e });
    }

    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }

    if (!res.ok || !body || body.ok === false) {
      const code = (body && body.error) || (res.status === 429 ? 'rate_limited' : 'upstream_error');
      const info = gatewayErrorInfo(code);
      // Retry-After is advisory but it is the difference between "try again"
      // and "try again in 43 seconds", which is a much less annoying message.
      let retryAfter = null;
      try {
        const h = res.headers && res.headers.get('Retry-After');
        if (h && /^\d+$/.test(h.trim())) retryAfter = parseInt(h.trim(), 10);
      } catch (e) { /* headers unavailable in some test doubles */ }
      throw impErr(code, info.text, {
        retryable: info.retry,
        retryAfter: retryAfter,
        detail: (body && body.message) || null,
        status: res.status,
      });
    }

    if (!body.series || typeof body.series !== 'object') {
      throw impErr('bad_response', GATEWAY_ERRORS.bad_response.text, { retryable: true });
    }
    return body;
  }

  // ── Draft construction ────────────────────────────────────────────────────
  //
  // A draft is { series, files, blobs, meta }. `files` is a list of
  // [chapterId, ChapterFile] that commit() writes with Store.putChapter;
  // URL drafts have none, because their chapters resolve lazily through the
  // catalogue's resolver on first read.

  function emptyDraft(series) {
    return { series: series, files: [], blobs: [], meta: {} };
  }

  function normalizeIncomingChapters(rawChapters, seriesId) {
    const out = [];
    const seen = new Set();
    (Array.isArray(rawChapters) ? rawChapters : []).forEach(function (raw, i) {
      if (!raw || typeof raw !== 'object') return;
      let id = raw.id != null ? String(raw.id) : '';
      if (!id) id = raw.num != null ? 'c-' + String(raw.num).replace(/[^0-9.]/g, '') : 'c-' + pad4(i + 1);
      while (seen.has(id)) id = id + '-' + (i + 1);   // ids must be unique within a series
      seen.add(id);

      const ch = {
        id: id,
        num: (raw.num != null && raw.num !== '' && isFinite(Number(raw.num))) ? Number(raw.num) : (i + 1),
        volume: (raw.volume != null && isFinite(Number(raw.volume))) ? Number(raw.volume) : null,
        title: typeof raw.title === 'string' && raw.title.trim() ? collapse(raw.title) : null,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
        lang: typeof raw.lang === 'string' ? raw.lang : null,
        seriesId: seriesId,
      };
      if (typeof raw.wordCount === 'number') ch.wordCount = raw.wordCount;

      // Exactly one payload strategy survives (§1.1). `src` is what /resolve
      // hands back; the rest are accepted so a hand-rolled gateway still works.
      //
      // The gateway response is third-party data even though we chose the
      // gateway: these two fields end up in a fetch() and in an <img src>
      // respectively, so their schemes are pinned here rather than trusted to
      // stay well-formed all the way down to the reader.
      if (typeof raw.src === 'string' && safeFetchUrl(raw.src)) ch.src = raw.src.trim();
      else if (Array.isArray(raw.pages) && raw.pages.length) {
        const pages = raw.pages.filter(function (p) { return typeof p === 'string' && safeImageUrl(p); });
        if (pages.length) ch.pages = pages;
      } else if (typeof raw.text === 'string' && raw.text.trim()) ch.text = raw.text;
      else if (typeof raw.mdChapterId === 'string') ch.mdChapterId = raw.mdChapterId;
      else if (typeof raw.url === 'string' && /^https?:/i.test(raw.url)) ch.url = raw.url;

      out.push(ch);
    });
    // §1.1: chapters are stored ascending by num.
    out.sort(function (a, b) { return (a.num || 0) - (b.num || 0); });
    return out;
  }

  function baseSeries(id, patch) {
    return Object.assign({
      id: id,
      type: 'manga',
      title: 'Untitled',
      altTitles: [],
      cover: '',
      description: '',
      author: '',
      artist: null,
      status: 'unknown',
      genres: [],
      tags: [],
      language: 'en',
      source: 'user',
      sourceUrl: null,
      readingDirection: 'ltr',
      updatedAt: nowIso(),
      chapterCount: 0,
      chapters: [],
    }, patch || {});
  }

  // URL → draft. Progress is reported at every real state change, because an
  // opaque spinner on a 20-second fetch is indistinguishable from a hang.
  async function prepareUrl(rawUrl, opts) {
    const options = opts || {};
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    const signal = options.signal;

    onProgress({ phase: 'validating', message: 'Checking the link…' });
    const normalized = normalizeUrl(rawUrl);      // throws bad_input/bad_scheme/bad_host
    if (!gatewayEnabled()) throw impErr('gateway_disabled', GATEWAY_ERRORS.gateway_disabled.text);

    const id = await seriesIdForUrl(normalized);
    const existing = await safeStore('getUserSeries', [id], null);

    onProgress({ phase: 'resolving', message: 'Reading ' + hostOf(normalized) + '…' });
    const body = await gatewayResolve(normalized, { signal: signal });
    if (signal && signal.aborted) throw impErr('aborted', 'Import cancelled');

    onProgress({ phase: 'parsing', message: 'Sorting out the chapter list…' });
    const raw = body.series || {};
    const chapters = normalizeIncomingChapters(raw.chapters, id);

    const confidence = body.confidence || raw.confidence || null;
    const type = TYPE_IDS.has(raw.type) ? raw.type : guessTypeFromUrl(normalized);

    const series = baseSeries(id, {
      type: type,
      title: collapse(raw.title) || titleFromUrl(normalized),
      altTitles: Array.isArray(raw.altTitles) ? raw.altTitles.filter(function (t) { return typeof t === 'string'; }) : [],
      cover: safeImageUrl(raw.cover) || '',
      description: typeof raw.description === 'string' ? raw.description.slice(0, 4000) : '',
      author: typeof raw.author === 'string' ? collapse(raw.author) : '',
      artist: typeof raw.artist === 'string' ? collapse(raw.artist) : null,
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      genres: Array.isArray(raw.genres) ? raw.genres.filter(function (t) { return typeof t === 'string'; }).slice(0, 20) : [],
      tags: Array.isArray(raw.tags) ? raw.tags.filter(function (t) { return typeof t === 'string'; }).slice(0, 20) : [],
      language: typeof raw.language === 'string' ? raw.language : 'en',
      readingDirection: raw.readingDirection === 'rtl' || raw.readingDirection === 'vertical' ? raw.readingDirection : (type === 'manga' ? 'rtl' : 'ltr'),
      sourceUrl: normalized,
      adapter: typeof body.adapter === 'string' ? body.adapter : null,
      importKind: 'url',
      chapters: chapters,
      chapterCount: chapters.length,
    });

    onProgress({ phase: 'found', message: chapters.length + (chapters.length === 1 ? ' chapter found' : ' chapters found'), count: chapters.length });

    const draft = emptyDraft(series);
    draft.meta = {
      kind: 'url',
      confidence: confidence,
      adapter: series.adapter,
      existing: !!existing,
      sourceUrl: normalized,
      chapterCount: chapters.length,
    };
    if (!chapters.length) draft.meta.warning = GATEWAY_ERRORS.empty_series.text;
    return draft;
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return 'that site'; }
  }

  // Last-resort title: the final path segment, de-slugged. Better than
  // "Untitled" when a gateway returns a series with no <title>.
  function titleFromUrl(url) {
    let seg = '';
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      seg = parts.length ? parts[parts.length - 1] : new URL(url).hostname;
    } catch (e) { return 'Untitled'; }
    seg = decodeURIComponent(seg).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+]+/g, ' ');
    seg = collapse(seg).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    return seg || 'Untitled';
  }

  // ── Zip helpers ───────────────────────────────────────────────────────────

  function jszip() {
    if (typeof window.JSZip === 'undefined') {
      throw impErr('no_jszip', 'The zip library did not load, so archives cannot be opened.');
    }
    return window.JSZip;
  }

  async function openZip(file) {
    try {
      return await jszip().loadAsync(file);
    } catch (e) {
      throw impErr('bad_archive', 'That file is not a readable zip archive. If it is a .cbr (RAR) rename will not help — convert it to .cbz first.', { cause: e });
    }
  }

  // Zip paths are always forward-slashed and relative to the archive root. This
  // resolves an href from a document at `baseDir`, collapsing . and .. so a
  // malformed EPUB cannot address anything outside the archive.
  function resolveZipPath(baseDir, href) {
    let raw = String(href || '').split('#')[0].split('?')[0];
    if (!raw) return '';
    try { raw = decodeURIComponent(raw); } catch (e) { /* keep the raw form */ }
    if (raw.charAt(0) === '/') { baseDir = ''; raw = raw.replace(/^\/+/, ''); }
    const parts = (baseDir ? baseDir.split('/') : []).concat(raw.split('/'));
    const out = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') { out.pop(); continue; }
      out.push(p);
    }
    return out.join('/');
  }

  function dirOf(path) {
    const i = String(path).lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
  }

  function extOf(path) {
    const m = String(path).match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  // Zip entry lookup is case-sensitive but real EPUBs are not always internally
  // consistent, so fall back to a case-insensitive scan before giving up.
  function zipEntry(zip, path) {
    if (!path) return null;
    const direct = zip.file(path);
    if (direct) return direct;
    const lower = path.toLowerCase();
    const all = zip.file(/.*/) || [];
    for (const f of all) if (f.name.toLowerCase() === lower) return f;
    return null;
  }

  async function zipText(zip, path) {
    const e = zipEntry(zip, path);
    return e ? await e.async('string') : null;
  }

  // ── Images from a zip entry ───────────────────────────────────────────────

  function mimeForPath(path) { return MIME_BY_EXT[extOf(path)] || 'application/octet-stream'; }

  async function entryToDataUrl(entry, path) {
    const b64 = await entry.async('base64');
    return 'data:' + mimeForPath(path) + ';base64,' + b64;
  }

  // FileReader route for blobs that did not come from a zip entry — native
  // cover extraction hands us a fetch()ed Blob. Re-wrapping fixes a missing
  // MIME before encoding so the data URL is well-formed.
  function blobToDataUrl(blob, fallbackMime) {
    const typed = blob.type ? blob : new Blob([blob], { type: fallbackMime || 'application/octet-stream' });
    return new Promise(function (resolve) {
      try {
        const r = new FileReader();
        r.onload = function () { resolve(String(r.result || '')); };
        r.onerror = function () { resolve(''); };
        r.readAsDataURL(typed);
      } catch (e) { resolve(''); }
    });
  }

  // Covers get re-encoded down to a thumbnail. Failing that (no canvas, exotic
  // format, decode error) we inline the original if it is small enough, and
  // otherwise give up on the cover rather than bloat every catalogue render.
  async function shrinkToDataUrl(blob, maxEdge) {
    try {
      if (typeof createImageBitmap !== 'function' || typeof document.createElement('canvas').getContext !== 'function') {
        throw new Error('no canvas');
      }
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bmp, 0, 0, w, h);
      if (typeof bmp.close === 'function') bmp.close();
      const out = canvas.toDataURL('image/jpeg', 0.82);
      if (out && out.length > 32) return out;
      throw new Error('empty encode');
    } catch (e) {
      return null;
    }
  }

  async function coverDataUrlFromEntry(zip, path) {
    const entry = zipEntry(zip, path);
    if (!entry) return '';
    const blob = await entry.async('blob');
    const shrunk = await shrinkToDataUrl(blob, COVER_MAX_EDGE);
    if (shrunk) return shrunk;
    if (blob.size <= COVER_RAW_LIMIT) return await entryToDataUrl(entry, path);
    return '';
  }

  // ── XHTML → Block[] (§1.3) ────────────────────────────────────────────────
  //
  // THE XSS BOUNDARY. Everything below reads a *detached* document: DOMParser
  // does not execute script, does not load subresources, and nothing here is
  // ever inserted into the live page. We copy text (via nodeValue/textContent)
  // and exactly three attributes — src, xlink:href, alt — and the two URL ones
  // are re-validated before they can become a block. Event-handler attributes,
  // style, class, id, data-* and everything else are simply never read.

  const XHTML_SKIP = new Set([
    'script', 'style', 'head', 'noscript', 'template', 'iframe', 'object', 'embed',
    'link', 'meta', 'title', 'base', 'form', 'input', 'button', 'select', 'option',
    'textarea', 'audio', 'video', 'canvas', 'map', 'area', 'param', 'source',
    'track', 'applet', 'frame', 'frameset', 'math', 'annotation', 'annotation-xml',
  ]);

  const HEADING_MAP = { h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4' };

  // Any of these inside an element means "this is a wrapper, recurse into it"
  // rather than "this is a paragraph, take its text".
  const BLOCKISH = 'p,div,section,article,h1,h2,h3,h4,h5,h6,ul,ol,li,pre,blockquote,hr,table,figure,img,image,aside';

  const XLINK_NS = 'http://www.w3.org/1999/xlink';

  function localNameOf(node) {
    return String(node.localName || node.nodeName || '').toLowerCase();
  }

  function hasBlockDescendant(node) {
    try { return !!node.querySelector(BLOCKISH); }
    catch (e) { return false; }   // querySelector can throw on exotic XML docs
  }

  // Text of a subtree, minus the skipped tags, with <br> as a space.
  function textOf(node) {
    let s = '';
    (function rec(n) {
      const kids = n.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c.nodeType === 3) { s += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        const t = localNameOf(c);
        if (XHTML_SKIP.has(t)) continue;
        if (t === 'br') { s += ' '; continue; }
        rec(c);
      }
    })(node);
    return collapse(s);
  }

  function pushHr(out) {
    if (out.length && out[out.length - 1].t !== 'hr') out.push({ t: 'hr' });
  }

  // ctx: { zip, baseDir, budget:{used}, images:[] }
  async function imageBlockFor(node, ctx) {
    let href = node.getAttribute('src');
    if (!href) {
      try { href = node.getAttributeNS(XLINK_NS, 'href'); } catch (e) { href = null; }
    }
    if (!href) href = node.getAttribute('xlink:href') || node.getAttribute('href');
    if (!href) return null;

    const alt = collapse(node.getAttribute('alt') || '');
    href = String(href).trim();

    // Absolute references leave the archive: only http(s) may through, and it
    // is handed on verbatim for the reader to load (or refuse).
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const safe = safeImageUrl(href);
      return safe ? { t: 'img', src: safe, alt: alt } : null;
    }
    if (!ctx || !ctx.zip) return null;

    const path = resolveZipPath(ctx.baseDir, href);
    if (!path) return null;
    if (ctx.cache && ctx.cache.has(path)) {
      const cached = ctx.cache.get(path);
      return cached ? { t: 'img', src: cached, alt: alt } : null;
    }
    const entry = zipEntry(ctx.zip, path);
    if (!entry) return null;
    if (!MIME_BY_EXT[extOf(path)]) return null;      // not a picture we recognise

    const blob = await entry.async('blob');
    if (blob.size > EPUB_IMG_MAX_BYTES) return null;
    if (ctx.budget.used + blob.size > EPUB_IMG_DOC_BUDGET) return null;
    ctx.budget.used += blob.size;

    const dataUrl = await entryToDataUrl(entry, path);
    if (ctx.cache) ctx.cache.set(path, dataUrl);
    return { t: 'img', src: dataUrl, alt: alt };
  }

  async function collectImages(node, out, ctx) {
    let list = [];
    try { list = Array.prototype.slice.call(node.querySelectorAll('img,image')); }
    catch (e) { list = []; }
    for (const n of list) {
      const b = await imageBlockFor(n, ctx);
      if (b) out.push(b);
    }
  }

  function isNoteElement(node) {
    const t = (node.getAttribute('epub:type') || node.getAttribute('role') || '').toLowerCase();
    return /footnote|endnote|note|rearnote/.test(t);
  }

  async function walkXhtml(node, out, ctx) {
    let buf = '';
    const flush = function () {
      const t = collapse(buf);
      buf = '';
      if (t) out.push({ t: 'p', c: t });
    };

    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === 3) { buf += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;

      const tag = localNameOf(child);
      if (XHTML_SKIP.has(tag)) continue;

      if (tag === 'br') { buf += ' '; continue; }

      if (tag === 'img' || tag === 'image') {
        flush();
        const b = await imageBlockFor(child, ctx);
        if (b) out.push(b);
        continue;
      }

      // <svg><image xlink:href="cover.jpg"/></svg> is the standard EPUB cover
      // page. The svg itself is never rendered — we only lift the href out.
      if (tag === 'svg') {
        flush();
        await collectImages(child, out, ctx);
        continue;
      }

      if (HEADING_MAP[tag]) {
        flush();
        const t = textOf(child);
        if (t) out.push({ t: HEADING_MAP[tag], c: t });
        await collectImages(child, out, ctx);
        continue;
      }

      if (tag === 'hr') { flush(); pushHr(out); continue; }

      if (tag === 'p' || tag === 'blockquote') {
        flush();
        const t = textOf(child);
        if (t) out.push({ t: tag === 'blockquote' ? 'blockquote' : 'p', c: t });
        await collectImages(child, out, ctx);
        continue;
      }

      if (tag === 'pre') {
        flush();
        const t = String(child.textContent || '').replace(/\s+$/, '');
        if (t.trim()) out.push({ t: 'pre', c: t });
        continue;
      }

      if (tag === 'ul' || tag === 'ol') {
        flush();
        const items = [];
        const lis = child.childNodes;
        for (let j = 0; j < lis.length; j++) {
          const li = lis[j];
          if (li.nodeType !== 1 || localNameOf(li) !== 'li') continue;
          const t = textOf(li);
          if (t) items.push(t);
        }
        if (items.length) out.push({ t: tag, items: items });
        await collectImages(child, out, ctx);
        continue;
      }

      // Tables are rare in prose and always structural. Flatten each row to a
      // paragraph so nothing is lost, without inventing a block type.
      if (tag === 'table') {
        flush();
        let rows = [];
        try { rows = Array.prototype.slice.call(child.querySelectorAll('tr')); } catch (e) { rows = []; }
        for (const tr of rows) {
          let cells = [];
          try { cells = Array.prototype.slice.call(tr.querySelectorAll('td,th')); } catch (e) { cells = []; }
          const line = cells.map(textOf).filter(Boolean).join(' — ');
          if (line) out.push({ t: 'p', c: line });
        }
        continue;
      }

      if (tag === 'aside' && isNoteElement(child)) {
        flush();
        const t = textOf(child);
        if (t) out.push({ t: 'note', c: t });
        continue;
      }

      if (hasBlockDescendant(child)) { flush(); await walkXhtml(child, out, ctx); }
      else buf += ' ' + (child.textContent || '') + ' ';
    }
    flush();
  }

  function parseMarkup(text, mime) {
    let doc = null;
    try { doc = new DOMParser().parseFromString(text, mime); } catch (e) { doc = null; }
    if (!doc) return null;
    // XML parse errors surface as a <parsererror> element rather than a throw.
    let bad = null;
    try { bad = doc.querySelector('parsererror'); } catch (e) { bad = null; }
    if (bad && mime !== 'text/html') return null;
    return doc;
  }

  async function xhtmlToBlocks(text, ctx) {
    let doc = parseMarkup(text, 'application/xhtml+xml');
    // Plenty of "EPUBs" in the wild are HTML with an .xhtml extension. The HTML
    // parser is forgiving and equally inert, so it is the natural fallback.
    if (!doc) doc = parseMarkup(text, 'text/html');
    if (!doc) return [];

    let root = doc.body;
    if (!root) {
      const bodies = doc.getElementsByTagName('body');
      root = bodies && bodies.length ? bodies[0] : doc.documentElement;
    }
    if (!root) return [];

    const out = [];
    await walkXhtml(root, out, ctx);

    // Trim leading/trailing rules — an <hr> at a document edge is decoration.
    while (out.length && out[0].t === 'hr') out.shift();
    while (out.length && out[out.length - 1].t === 'hr') out.pop();
    return out;
  }

  // ── EPUB ──────────────────────────────────────────────────────────────────

  function xmlAll(doc, localName) {
    const out = [];
    let nodes;
    try { nodes = doc.getElementsByTagName('*'); } catch (e) { return out; }
    for (let i = 0; i < nodes.length; i++) {
      if (localNameOf(nodes[i]) === localName) out.push(nodes[i]);
    }
    return out;
  }

  function xmlFirstText(scope, localName) {
    const hits = xmlAll(scope, localName);
    for (const h of hits) {
      const t = collapse(h.textContent || '');
      if (t) return t;
    }
    return '';
  }

  // container.xml → OPF path. Falls back to any .opf in the archive, because a
  // missing container is a common symptom of a re-zipped EPUB.
  async function findOpfPath(zip) {
    const containerXml = await zipText(zip, 'META-INF/container.xml');
    if (containerXml) {
      const doc = parseMarkup(containerXml, 'application/xml');
      if (doc) {
        const roots = xmlAll(doc, 'rootfile');
        for (const r of roots) {
          const p = r.getAttribute('full-path');
          if (p) return resolveZipPath('', p);
        }
      }
    }
    const candidates = (zip.file(/\.opf$/i) || []).map(function (f) { return f.name; });
    if (candidates.length) return candidates.sort(function (a, b) { return a.length - b.length; })[0];
    throw impErr('bad_epub', 'That EPUB has no package file (META-INF/container.xml is missing or unreadable), so there is nothing to read.');
  }

  // Table of contents → { resolvedPath: title }. Both the EPUB 3 nav document
  // and the EPUB 2 NCX are handled; chapter titles taken from a real ToC beat
  // "the first heading in the file" nearly every time.
  async function readToc(zip, opfDir, manifest, spineDocPaths) {
    const map = new Map();

    const navItem = manifest.find(function (m) { return /\bnav\b/.test(m.properties || ''); });
    if (navItem) {
      const text = await zipText(zip, navItem.path);
      const doc = text ? (parseMarkup(text, 'application/xhtml+xml') || parseMarkup(text, 'text/html')) : null;
      if (doc) {
        const anchors = xmlAll(doc, 'a');
        for (const a of anchors) {
          const href = a.getAttribute('href');
          const label = collapse(a.textContent || '');
          if (!href || !label) continue;
          const p = resolveZipPath(dirOf(navItem.path), href);
          if (p && !map.has(p)) map.set(p, label);
        }
      }
    }

    if (!map.size) {
      const ncxItem = manifest.find(function (m) {
        return (m.mediaType || '').indexOf('dtbncx') !== -1 || /\.ncx$/i.test(m.path);
      });
      if (ncxItem) {
        const text = await zipText(zip, ncxItem.path);
        const doc = text ? parseMarkup(text, 'application/xml') : null;
        if (doc) {
          for (const np of xmlAll(doc, 'navPoint')) {
            const label = xmlFirstText(np, 'text');
            const content = xmlAll(np, 'content')[0];
            const src = content && content.getAttribute('src');
            if (!label || !src) continue;
            const p = resolveZipPath(dirOf(ncxItem.path), src);
            if (p && !map.has(p)) map.set(p, label);
          }
        }
      }
    }
    return map;
  }

  function pickCoverItem(opfDoc, manifest) {
    // 1. EPUB 3: manifest item with properties="cover-image"
    const byProps = manifest.find(function (m) { return /\bcover-image\b/.test(m.properties || ''); });
    if (byProps) return byProps;

    // 2. EPUB 2: <meta name="cover" content="<item id>"/>
    for (const m of xmlAll(opfDoc, 'meta')) {
      if ((m.getAttribute('name') || '').toLowerCase() === 'cover') {
        const id = m.getAttribute('content');
        const hit = manifest.find(function (x) { return x.id === id; });
        if (hit && /^image\//.test(hit.mediaType || '')) return hit;
      }
    }
    // 3. Anything image-ish that calls itself a cover.
    const named = manifest.filter(function (x) {
      return /^image\//.test(x.mediaType || '') && /cover/i.test(x.path + ' ' + (x.id || ''));
    });
    if (named.length) return named[0];
    return manifest.find(function (x) { return /^image\//.test(x.mediaType || ''); }) || null;
  }

  async function prepareEpub(file, opts) {
    const options = opts || {};
    const onProgress = options.onProgress || function () {};
    const signal = options.signal;
    const abortCheck = function () { if (signal && signal.aborted) throw impErr('aborted', 'Import cancelled'); };

    onProgress({ phase: 'reading', message: 'Opening ' + file.name + '…' });
    const zip = await openZip(file);
    abortCheck();

    onProgress({ phase: 'parsing', message: 'Reading the book’s structure…' });
    const opfPath = await findOpfPath(zip);
    const opfText = await zipText(zip, opfPath);
    const opfDoc = opfText ? parseMarkup(opfText, 'application/xml') : null;
    if (!opfDoc) throw impErr('bad_epub', 'That EPUB’s package file could not be parsed. It may be corrupt or DRM-protected.');
    const opfDir = dirOf(opfPath);

    // manifest: id → { path, mediaType, properties }
    const manifest = xmlAll(opfDoc, 'item').map(function (it) {
      return {
        id: it.getAttribute('id') || '',
        path: resolveZipPath(opfDir, it.getAttribute('href') || ''),
        mediaType: it.getAttribute('media-type') || '',
        properties: it.getAttribute('properties') || '',
      };
    }).filter(function (m) { return !!m.path; });
    const byId = new Map(manifest.map(function (m) { return [m.id, m]; }));

    // spine: reading order. linear="no" is for pop-ups and back matter the book
    // itself says is out of line — following that keeps the chapter list clean.
    const spine = [];
    for (const ref of xmlAll(opfDoc, 'itemref')) {
      if ((ref.getAttribute('linear') || '').toLowerCase() === 'no') continue;
      const item = byId.get(ref.getAttribute('idref') || '');
      if (item) spine.push(item);
    }
    if (!spine.length) {
      for (const m of manifest) if (/xhtml|html/.test(m.mediaType)) spine.push(m);
    }
    if (!spine.length) throw impErr('bad_epub', 'That EPUB has no readable documents in it.');

    // metadata
    const metaScope = xmlAll(opfDoc, 'metadata')[0] || opfDoc;
    const title = xmlFirstText(metaScope, 'title') || file.name.replace(/\.epub$/i, '');
    const creator = xmlFirstText(metaScope, 'creator');
    const description = collapse(xmlFirstText(metaScope, 'description')).slice(0, 4000);
    const language = xmlFirstText(metaScope, 'language') || 'en';

    const toc = await readToc(zip, opfDir, manifest, spine);
    abortCheck();

    const id = await seriesIdForFile(file);
    const existing = await safeStore('getUserSeries', [id], null);

    // Cover first: it is the one thing the confirmation screen shows big.
    let cover = '';
    const coverItem = pickCoverItem(opfDoc, manifest);
    if (coverItem) {
      try { cover = await coverDataUrlFromEntry(zip, coverItem.path); }
      catch (e) { cover = ''; }
    }

    const chapters = [];
    const files = [];
    const imageCache = new Map();   // shared across chapters: covers repeat
    let totalWords = 0;
    let totalImages = 0;
    let skipped = 0;

    for (let i = 0; i < spine.length; i++) {
      abortCheck();
      const item = spine[i];
      onProgress({
        phase: 'chapters', message: 'Converting chapter ' + (i + 1) + ' of ' + spine.length + '…',
        done: i, total: spine.length,
      });

      const text = await zipText(zip, item.path);
      if (!text) { skipped++; continue; }

      const ctx = { zip: zip, baseDir: dirOf(item.path), budget: { used: 0 }, cache: imageCache };
      let blocks;
      try { blocks = await xhtmlToBlocks(text, ctx); }
      catch (e) { console.warn('[Importer] chapter parse failed', item.path, e); blocks = []; }

      if (!blocks.length) { skipped++; continue; }

      const words = blocksWordCount(blocks);
      totalWords += words;
      totalImages += blocks.filter(function (b) { return b.t === 'img'; }).length;

      const num = chapters.length + 1;
      const chapterId = 'c-' + pad4(num);
      const tocTitle = toc.get(item.path) || '';
      const headingBlock = blocks.find(function (b) { return b.t === 'h2' || b.t === 'h3'; });
      const chTitle = collapse(tocTitle) || (headingBlock ? headingBlock.c : '') || 'Chapter ' + num;

      chapters.push({
        id: chapterId, num: num, volume: null, title: chTitle.slice(0, 200),
        wordCount: words, lang: language, seriesId: id, updatedAt: null,
      });
      files.push([chapterId, {
        seriesId: id, id: chapterId, num: num, title: chTitle.slice(0, 200),
        kind: 'text', blocks: blocks, wordCount: words,
      }]);
    }

    if (!chapters.length) {
      throw impErr('bad_epub', 'We opened that EPUB but found no text in it. Books protected by Adobe DRM look like this — the reader cannot decrypt them.');
    }

    // A "manga EPUB" is all pictures and almost no prose. Guessing it here
    // saves the user a correction; they can still override on the next screen.
    const type = (totalWords < 250 && totalImages >= Math.max(3, chapters.length)) ? 'manga' : 'lightnovel';

    const series = baseSeries(id, {
      type: type,
      title: collapse(title).slice(0, 300),
      cover: cover,
      description: description,
      author: collapse(creator),
      language: language,
      status: 'completed',           // a file is a finished artefact by definition
      importKind: 'epub',
      fileName: file.name,
      fileSize: file.size,
      chapters: chapters,
      chapterCount: chapters.length,
      wordCount: totalWords,
    });

    const draft = emptyDraft(series);
    draft.files = files;
    draft.meta = {
      kind: 'epub', existing: !!existing, chapterCount: chapters.length,
      words: totalWords, skipped: skipped, fileName: file.name, fileSize: file.size,
    };
    // Keeping the original means a future parser improvement can re-derive the
    // chapters without asking the user to find the file again.
    if (file.size <= KEEP_SOURCE_FILE_MAX) {
      draft.blobs.push(['file:' + id, file]);
      series.archiveKey = 'file:' + id;
    }
    onProgress({ phase: 'found', message: chapters.length + ' chapters, ' + totalWords.toLocaleString() + ' words', count: chapters.length });
    return draft;
  }

  // ── TXT ───────────────────────────────────────────────────────────────────
  //
  // Splitting is a guess, so all three strategies are computed up front and the
  // confirmation screen lets the user pick a different one and see the count
  // change before anything is saved.

  // The number is what makes it a heading. Without that requirement "Chapter
  // two prose." — an ordinary sentence that opens with the word — splits the
  // book, and the failure is silent. So: keyword, then a real number (digits,
  // roman, or a spelled-out one), then either end of line or a separator
  // before the chapter's name.
  const NUM_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|' +
    'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|' +
    'fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|' +
    'seventh|eighth|ninth|tenth)';
  const TXT_HEADING_LATIN = new RegExp(
    '^\\s*(?:chapter|chap|ch|episode|ep|part|volume|vol|book|act|section)\\b[\\s.#]*' +
    '(?:[0-9]+(?:[.\\-][0-9]+)?|[ivxlcdm]{1,7}|' + NUM_WORD + '(?:[-\\s]' + NUM_WORD + ')?)' +
    '\\s*(?:$|[:.)\\]}—–\\-·|]\\s*.{0,70}$)', 'i');

  // Front and back matter carry no number, so they are matched separately and
  // held to a short line.
  const TXT_HEADING_NAMED = /^\s*(?:prologue|epilogue|interlude|afterword|foreword|preface|introduction|extra|side\s+story)\b[\s:.—–-]{0,4}.{0,60}$/i;

  const TXT_HEADING_CJK   = /^\s*(?:第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[章話话回節节卷部篇集]|[序終终]\s*[章話话]).{0,40}$/;

  function looksLikeHeading(line) {
    const t = line.trim();
    if (!t || t.length > 90) return false;
    if (TXT_HEADING_CJK.test(t)) return true;
    return TXT_HEADING_LATIN.test(t) || TXT_HEADING_NAMED.test(t);
  }

  function splitByHeadings(lines) {
    const marks = [];
    for (let i = 0; i < lines.length; i++) if (looksLikeHeading(lines[i])) marks.push(i);
    if (marks.length < 2) return null;

    const parts = [];
    // Front matter before the first heading is prepended rather than dropped —
    // losing a translator's preface because it had no heading is unacceptable.
    const preface = lines.slice(0, marks[0]).join('\n').trim();
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i];
      const end = i + 1 < marks.length ? marks[i + 1] : lines.length;
      let body = lines.slice(start + 1, end).join('\n').trim();
      if (i === 0 && preface) body = preface + '\n\n' + body;
      parts.push({ title: collapse(lines[start]).slice(0, 200), text: body });
    }
    return parts.filter(function (p) { return p.text || p.title; });
  }

  function splitByBlankRuns(raw) {
    const chunks = raw.split(/\n[ \t]*\n[ \t]*\n[ \t]*\n+/);
    if (chunks.length < 2) return null;
    return chunks.map(function (chunk, i) {
      const trimmed = chunk.trim();
      const first = trimmed.split('\n')[0].trim();
      const useFirst = first && first.length <= 80;
      return {
        title: useFirst ? collapse(first).slice(0, 200) : 'Part ' + (i + 1),
        text: useFirst ? trimmed.slice(first.length).trim() : trimmed,
      };
    }).filter(function (p) { return p.text || p.title; });
  }

  function textToBlocks(text) {
    const raw = String(text).replace(/\r\n?/g, '\n').trim();
    if (!raw) return [];
    let parts = raw.split(/\n[ \t]*\n+/);
    if (parts.length === 1 && raw.indexOf('\n') !== -1) parts = raw.split(/\n+/);
    const out = [];
    for (const p of parts) {
      const line = collapse(p.replace(/\s*\n\s*/g, ' '));
      if (!line) continue;
      // A line of nothing but rule characters is a scene break, not a sentence.
      if (/^(?:[*∗·•]\s*){3,}$|^[-_=~—–]{3,}$/.test(line)) { pushHr(out); continue; }
      out.push({ t: 'p', c: line });
    }
    while (out.length && out[0].t === 'hr') out.shift();
    while (out.length && out[out.length - 1].t === 'hr') out.pop();
    return out;
  }

  function buildTxtStrategies(raw) {
    const normalized = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
    const lines = normalized.split('\n');
    const strategies = [];

    const byHeading = splitByHeadings(lines);
    if (byHeading && byHeading.length > 1) {
      strategies.push({ id: 'headings', label: 'Split at chapter headings', parts: byHeading });
    }
    const byBlank = splitByBlankRuns(normalized);
    if (byBlank && byBlank.length > 1) {
      strategies.push({ id: 'blanks', label: 'Split at blank-line breaks', parts: byBlank });
    }
    strategies.push({
      id: 'single', label: 'Keep as one chapter',
      parts: [{ title: '', text: normalized.trim() }],
    });
    return strategies;
  }

  function txtDraftFrom(strategy, id, file, existing) {
    const chapters = [];
    const files = [];
    let totalWords = 0;

    strategy.parts.forEach(function (part, i) {
      const num = i + 1;
      const chapterId = 'c-' + pad4(num);
      const title = collapse(part.title) || 'Chapter ' + num;
      const blocks = textToBlocks(part.text);
      // The heading itself becomes the first block so the reader shows it.
      if (part.title) blocks.unshift({ t: 'h2', c: collapse(part.title).slice(0, 200) });
      const words = blocksWordCount(blocks);
      totalWords += words;
      chapters.push({
        id: chapterId, num: num, volume: null, title: title.slice(0, 200),
        wordCount: words, seriesId: id, updatedAt: null,
      });
      files.push([chapterId, {
        seriesId: id, id: chapterId, num: num, title: title.slice(0, 200),
        kind: 'text', blocks: blocks, wordCount: words,
      }]);
    });

    const series = baseSeries(id, {
      type: 'lightnovel',
      title: collapse(String(file.name || 'Text file').replace(/\.txt$/i, '').replace(/[-_]+/g, ' ')).slice(0, 300),
      status: 'completed',
      importKind: 'txt',
      fileName: file.name,
      fileSize: file.size,
      chapters: chapters,
      chapterCount: chapters.length,
      wordCount: totalWords,
    });

    const draft = emptyDraft(series);
    draft.files = files;
    draft.meta = {
      kind: 'txt', existing: !!existing, chapterCount: chapters.length,
      words: totalWords, fileName: file.name, fileSize: file.size,
      strategy: strategy.id,
    };
    return draft;
  }

  async function prepareTxt(file, opts) {
    const options = opts || {};
    const onProgress = options.onProgress || function () {};
    onProgress({ phase: 'reading', message: 'Reading ' + file.name + '…' });

    const raw = await file.text();
    if (!raw.trim()) throw impErr('empty_file', 'That text file is empty.');

    onProgress({ phase: 'parsing', message: 'Looking for chapter breaks…' });
    const strategies = buildTxtStrategies(raw);
    const id = await seriesIdForFile(file);
    const existing = await safeStore('getUserSeries', [id], null);

    const draft = txtDraftFrom(strategies[0], id, file, existing);
    // The confirmation screen re-splits live, so it needs the raw alternatives.
    draft.meta.strategies = strategies.map(function (s) {
      return { id: s.id, label: s.label, count: s.parts.length };
    });
    draft.rebuild = function (strategyId) {
      const s = strategies.find(function (x) { return x.id === strategyId; }) || strategies[0];
      const next = txtDraftFrom(s, id, file, existing);
      next.meta.strategies = draft.meta.strategies;
      next.rebuild = draft.rebuild;
      if (file.size <= KEEP_SOURCE_FILE_MAX) {
        next.blobs.push(['file:' + id, file]);
        next.series.archiveKey = 'file:' + id;
      }
      return next;
    };
    if (file.size <= KEEP_SOURCE_FILE_MAX) {
      draft.blobs.push(['file:' + id, file]);
      draft.series.archiveKey = 'file:' + id;
    }
    onProgress({ phase: 'found', message: draft.meta.chapterCount + ' chapters detected', count: draft.meta.chapterCount });
    return draft;
  }

  // ── CBZ / ZIP ─────────────────────────────────────────────────────────────
  //
  // The archive itself is the payload: it is kept — as a Store blob on the
  // web, as a native file under Data/archives/ on device — so the series
  // reopens without another file pick (§5). Page URLs are *not* baked in:
  // inlining 40 MB of base64 would double the storage cost of every archive,
  // and live URLs are session-local anyway. Stored chapter rows carry only
  // `entries` + `archiveKey`; `hydrateChapter` further down turns them into
  // pages the moment a chapter is actually opened, and not before.

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function imageEntries(zip) {
    const out = [];
    const files = zip.file(/.*/) || [];
    for (const f of files) {
      if (f.dir) continue;
      const base = f.name.split('/').pop();
      if (!base || base.charAt(0) === '.') continue;      // __MACOSX / dotfiles
      if (f.name.indexOf('__MACOSX/') === 0) continue;
      const ext = extOf(f.name);
      if (!MIME_BY_EXT[ext] || ext === 'svg') continue;
      out.push(f.name);
    }
    out.sort(naturalCompare);
    return out;
  }

  // Same rules as imageEntries, applied to a native central-directory listing
  // ({name, size} rows from Platform.zip.list) — directory rows end in '/',
  // which the empty-basename check already drops. The two filters MUST agree:
  // an archive indexed natively and one indexed by JSZip must yield the same
  // chapter shapes, or re-importing on another platform would fork content.
  function imageNamesFromList(entries) {
    const out = [];
    for (const e of (entries || [])) {
      const name = e && typeof e.name === 'string' ? e.name : '';
      if (!name) continue;
      const base = name.split('/').pop();
      if (!base || base.charAt(0) === '.') continue;
      if (name.indexOf('__MACOSX/') === 0) continue;
      const ext = extOf(name);
      if (!MIME_BY_EXT[ext] || ext === 'svg') continue;
      out.push(name);
    }
    out.sort(naturalCompare);
    return out;
  }

  // One folder per chapter is the usual convention for multi-chapter archives;
  // a flat archive is a single chapter.
  function groupPages(names) {
    const byDir = new Map();
    for (const n of names) {
      const d = dirOf(n);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(n);
    }
    const dirs = Array.from(byDir.keys()).sort(naturalCompare);
    const populated = dirs.filter(function (d) { return byDir.get(d).length > 0; });
    if (populated.length < 2) return [{ title: '', pages: names }];
    return populated.map(function (d) {
      return { title: collapse((d.split('/').pop() || '').replace(/[-_]+/g, ' ')), pages: byDir.get(d) };
    });
  }

  // The confirmation cover on the native path: extract the one chosen entry to
  // a throwaway page dir, fetch it back through the local origin, shrink it,
  // and delete the dir. One image crosses into JS — never the archive.
  async function coverFromNativeEntry(uri, entryName) {
    const P = platform();
    if (!P || !P.zip || typeof P.zip.extract !== 'function' || typeof P.pageUrl !== 'function') return '';
    let out = '';
    try {
      const rels = await P.zip.extract({ uri: uri }, [entryName], 'import-tmp');
      const pageUrl = rels && rels.length ? P.pageUrl(rels[0]) : null;
      if (pageUrl) {
        const res = await fetch(pageUrl);
        if (res.ok) {
          const blob = await res.blob();
          const shrunk = await shrinkToDataUrl(blob, COVER_MAX_EDGE);
          if (shrunk) out = shrunk;
          else if (blob.size <= COVER_RAW_LIMIT) out = await blobToDataUrl(blob, mimeForPath(entryName));
        }
      }
    } catch (e) { out = ''; }
    if (P.archives && typeof P.archives.releasePages === 'function') {
      try { P.archives.releasePages('import-tmp'); } catch (e) { /* the page-cache prune sweeps strays */ }
    }
    return out;
  }

  // Native URI indexing: the central directory is read natively, so a 2 GB
  // archive costs the webview a list of names — no JSZip, no ArrayBuffer.
  // Returns null when the native lister is unavailable (no or-zip plugin);
  // real content problems (no images) throw the same errors as the web path.
  async function prepareArchiveFromUri(picked, opts) {
    const options = opts || {};
    const onProgress = options.onProgress || function () {};
    const P = platform();
    if (!P || !P.zip || typeof P.zip.list !== 'function') return null;

    onProgress({ phase: 'reading', message: 'Opening ' + picked.name + '…' });
    const listed = await P.zip.list({ uri: picked.uri });
    if (!listed) return null;

    onProgress({ phase: 'parsing', message: 'Indexing pages…' });
    const names = imageNamesFromList(listed);
    if (!names.length) {
      throw impErr('empty_archive', 'That archive has no images in it. CBZ files hold one image per page — if this is a book, try the EPUB or TXT version.');
    }

    // Identity comes from the ORIGINAL picker name and size, exactly like the
    // web path — re-importing the same file must resume, not duplicate.
    const id = await seriesIdForFile(picked);
    const existing = await safeStore('getUserSeries', [id], null);
    const groups = groupPages(names);

    let cover = '';
    try { cover = await coverFromNativeEntry(picked.uri, names[0]); } catch (e) { cover = ''; }

    const chapters = [];
    const files = [];
    groups.forEach(function (g, i) {
      const num = i + 1;
      const chapterId = 'c-' + pad4(num);
      const title = g.title || (groups.length === 1 ? collapse(picked.name.replace(/\.(cbz|zip)$/i, '')) : 'Chapter ' + num);
      chapters.push({
        id: chapterId, num: num, volume: null, title: title.slice(0, 200),
        seriesId: id, updatedAt: null, pageCount: g.pages.length,
      });
      files.push([chapterId, {
        seriesId: id, id: chapterId, num: num, title: title.slice(0, 200),
        kind: 'image', pages: [], entries: g.pages, archiveKey: 'file:' + id,
      }]);
    });

    const series = baseSeries(id, {
      type: 'manga',
      title: collapse(picked.name.replace(/\.(cbz|zip)$/i, '').replace(/[-_]+/g, ' ')).slice(0, 300) || 'Archive',
      cover: cover,
      status: 'completed',
      readingDirection: 'rtl',
      importKind: 'cbz',
      archiveKey: 'file:' + id,
      fileName: picked.name,
      fileSize: picked.size,
      chapters: chapters,
      chapterCount: chapters.length,
    });

    const draft = emptyDraft(series);
    draft.files = files;
    // No blob: the payload is the picked file itself, still sitting in the
    // picker cache. commitDraft moves it into Data/archives/ natively.
    draft.nativeArchive = { archiveKey: 'file:' + id, nativeUri: picked.uri };
    draft.meta = {
      kind: 'cbz', existing: !!existing, chapterCount: chapters.length,
      pageCount: names.length, fileName: picked.name, fileSize: picked.size,
    };
    onProgress({
      phase: 'found',
      message: names.length + ' pages in ' + chapters.length + (chapters.length === 1 ? ' chapter' : ' chapters'),
      count: chapters.length,
    });
    return draft;
  }

  async function prepareArchive(file, opts) {
    const options = opts || {};
    const onProgress = options.onProgress || function () {};

    // A picked URI gets the native, bytes-stay-on-disk path. Falling back to
    // JSZip when the lister is missing keeps a plugin-less test build working,
    // at web-cap sizes only — materializing is exactly what the URI path is
    // for avoiding.
    if (isPickedUri(file)) {
      const nativeDraft = await prepareArchiveFromUri(file, options);
      if (nativeDraft) return nativeDraft;
      const materialized = await readPicked(file);
      if (!materialized) {
        throw impErr('bad_archive', 'That archive could not be read from the picker. Try choosing it again, or open it from a different file app.');
      }
      file = materialized;
    }

    onProgress({ phase: 'reading', message: 'Opening ' + file.name + '…' });
    const zip = await openZip(file);

    onProgress({ phase: 'parsing', message: 'Indexing pages…' });
    const names = imageEntries(zip);
    if (!names.length) {
      throw impErr('empty_archive', 'That archive has no images in it. CBZ files hold one image per page — if this is a book, try the EPUB or TXT version.');
    }

    const id = await seriesIdForFile(file);
    const existing = await safeStore('getUserSeries', [id], null);
    const groups = groupPages(names);

    let cover = '';
    try { cover = await coverDataUrlFromEntry(zip, names[0]); } catch (e) { cover = ''; }

    const chapters = [];
    const files = [];
    groups.forEach(function (g, i) {
      const num = i + 1;
      const chapterId = 'c-' + pad4(num);
      const title = g.title || (groups.length === 1 ? collapse(file.name.replace(/\.(cbz|zip)$/i, '')) : 'Chapter ' + num);
      chapters.push({
        id: chapterId, num: num, volume: null, title: title.slice(0, 200),
        seriesId: id, updatedAt: null, pageCount: g.pages.length,
      });
      // `entries` is how hydrateChapter knows which zip members belong here.
      files.push([chapterId, {
        seriesId: id, id: chapterId, num: num, title: title.slice(0, 200),
        kind: 'image', pages: [], entries: g.pages, archiveKey: 'file:' + id,
      }]);
    });

    const series = baseSeries(id, {
      type: 'manga',
      title: collapse(file.name.replace(/\.(cbz|zip)$/i, '').replace(/[-_]+/g, ' ')).slice(0, 300) || 'Archive',
      cover: cover,
      status: 'completed',
      readingDirection: 'rtl',
      importKind: 'cbz',
      archiveKey: 'file:' + id,
      fileName: file.name,
      fileSize: file.size,
      chapters: chapters,
      chapterCount: chapters.length,
    });

    const draft = emptyDraft(series);
    draft.files = files;
    draft.blobs.push(['file:' + id, file]);
    draft.meta = {
      kind: 'cbz', existing: !!existing, chapterCount: chapters.length,
      pageCount: names.length, fileName: file.name, fileSize: file.size,
    };
    onProgress({
      phase: 'found',
      message: names.length + ' pages in ' + chapters.length + (chapters.length === 1 ? ' chapter' : ' chapters'),
      count: chapters.length,
    });
    return draft;
  }

  // ── Lazy hydration (the boot-time decompress-everything replacement) ──────
  //
  // Stored CBZ rows are entries + archiveKey with pages: []. When a chapter is
  // actually opened, hydrateChapter yields live page URLs for JUST that
  // chapter: natively by streaming extraction to the page cache, on the web by
  // decompressing from the stored blob to object URLs. Two hard residency
  // bounds (§9): at most ONE JSZip instance app-wide, and at most TWO hydrated
  // chapters per archive — current + previous. Evicted chapters revoke their
  // object URLs (web) or release their page dir (native); a re-open simply
  // hydrates again. Nothing produced here is ever written back to Store.

  // archiveKey → [{ seriesId, chapterId, urls, dirKey }], oldest first, ≤ 2.
  // dirKey set = native entry (release the dir); null = web (revoke the URLs).
  const hydratedChapters = new Map();

  // The single JSZip slot. The promise is cached, not the instance, so two
  // chapters of one archive hydrating concurrently share one loadAsync instead
  // of holding two copies of the compressed bytes.
  let archiveCache = { key: null, promise: null };

  function releaseHydrated(entry) {
    if (entry.dirKey) {
      const P = platform();
      if (P && P.archives && typeof P.archives.releasePages === 'function') {
        try { P.archives.releasePages(entry.dirKey); } catch (e) { /* dir already gone */ }
      }
    } else {
      (entry.urls || []).forEach(function (u) {
        try { URL.revokeObjectURL(u); } catch (e) { /* already revoked */ }
      });
    }
  }

  function registerHydrated(archiveKey, entry) {
    let list = hydratedChapters.get(archiveKey);
    if (!list) { list = []; hydratedChapters.set(archiveKey, list); }
    const i = list.findIndex(function (e) {
      return e.seriesId === entry.seriesId && e.chapterId === entry.chapterId;
    });
    if (i !== -1) list.splice(i, 1);   // refreshed in place; native URLs are path-stable, web hits return early
    list.push(entry);
    while (list.length > 2) releaseHydrated(list.shift());
  }

  function findHydrated(archiveKey, seriesId, chapterId) {
    const list = hydratedChapters.get(archiveKey);
    if (!list) return null;
    return list.find(function (e) {
      return e.seriesId === seriesId && e.chapterId === chapterId;
    }) || null;
  }

  // Forget everything held for one archive: registry entries (revoking /
  // releasing as we go) and the JSZip slot. Called on delete and on re-import,
  // where cached state would otherwise serve pages from a superseded file.
  function dropArchiveState(archiveKey) {
    if (!archiveKey) return;
    const list = hydratedChapters.get(archiveKey);
    if (list) {
      list.forEach(releaseHydrated);
      hydratedChapters.delete(archiveKey);
    }
    if (archiveCache.key === archiveKey) archiveCache = { key: null, promise: null };
  }

  function openArchiveZip(archiveKey) {
    if (archiveCache.key === archiveKey && archiveCache.promise) return archiveCache.promise;
    const promise = (async function () {
      const blob = await safeStore('getBlob', [archiveKey], null);
      if (!blob) return null;
      try { return await jszip().loadAsync(blob); }
      catch (e) { console.warn('[Importer] could not reopen archive ' + archiveKey, e); return null; }
    })();
    // Claiming the slot IS the LRU-of-1 eviction: the previous archive's zip
    // loses its last reference here and gets collected.
    archiveCache = { key: archiveKey, promise: promise };
    promise.then(function (zip) {
      // A failed open must not stick for the session — clear the slot so the
      // next attempt retries instead of replaying the failure from cache.
      if (!zip && archiveCache.key === archiveKey && archiveCache.promise === promise) {
        archiveCache = { key: null, promise: null };
      }
    });
    return promise;
  }

  // Public API (ARCHITECTURE §5 amendment): live pages for one chapter of an
  // imported archive, or null. The returned ChapterFile is session-local — its
  // pages are object URLs or Capacitor file URLs and MUST NOT be persisted;
  // the catalogue's resolver returns it without a putChapter for exactly that
  // reason.
  async function hydrateChapter(seriesId, chapterId) {
    if (!seriesId || !chapterId) return null;
    const cached = await safeStore('getChapter', [seriesId, chapterId], null);
    if (!cached || !cached.archiveKey) return null;
    const entries = Array.isArray(cached.entries) ? cached.entries : [];
    if (!entries.length) return null;
    const archiveKey = cached.archiveKey;

    // A live web registry entry means these object URLs are still valid — and
    // possibly on screen. Reuse them; minting replacements would decompress
    // again and revoking the old set would blank a visible chapter.
    const held = findHydrated(archiveKey, seriesId, chapterId);
    if (held && !held.dirKey) {
      registerHydrated(archiveKey, held);   // refresh recency
      return Object.assign({}, cached, { pages: held.urls.slice() });
    }

    // Native branch: stream-extract just this chapter to the page cache and
    // convert the relative paths for THIS session. A dir the LRU prune took is
    // no special case — extraction is idempotent, so we just extract again.
    const P = platform();
    if (P && P.isNative && P.zip && typeof P.zip.extract === 'function' && typeof P.pageUrl === 'function') {
      // Ids come from stored rows, and a restored backup can carry arbitrary
      // strings — flatten them before they shape a cache path, so containment
      // never rests on the native side's checks alone.
      const seg = function (s) { return String(s).replace(/[\/\\]/g, '_').replace(/\.{2,}/g, '_'); };
      const dirKey = seg(seriesId) + '/' + seg(chapterId);
      const rels = await P.zip.extract({ key: archiveKey }, entries.slice(), dirKey);
      if (rels && rels.length) {
        const urls = [];
        for (const rel of rels) {
          const u = P.pageUrl(rel);
          if (u) urls.push(u);
        }
        if (urls.length === rels.length) {
          registerHydrated(archiveKey, { seriesId: seriesId, chapterId: chapterId, urls: urls, dirKey: dirKey });
          return Object.assign({}, cached, { pages: urls });
        }
      }
      // No native file for this key (a pre-migration IDB archive) or the
      // plugin is missing — the blob path below still serves it.
    }

    // Web branch: one shared JSZip over the stored blob, object URLs for just
    // this chapter's entries.
    const zip = await openArchiveZip(archiveKey);
    if (!zip) return null;
    const urls = [];
    for (const name of entries) {
      const entry = zipEntry(zip, name);
      if (!entry) continue;
      const b = await entry.async('blob');
      urls.push(URL.createObjectURL(b.type ? b : new Blob([b], { type: mimeForPath(name) })));
    }
    if (!urls.length) return null;
    registerHydrated(archiveKey, { seriesId: seriesId, chapterId: chapterId, urls: urls, dirKey: null });
    return Object.assign({}, cached, { pages: urls });
  }

  // ── Migration shim ────────────────────────────────────────────────────────
  //
  // Earlier builds persisted each session's blob: page URLs back into the
  // chapter rows — dead weight that was rewritten every boot. The shim walks a
  // series' cached rows once per session and resets any session-local pages to
  // [], leaving entries + archiveKey as the truth. No decompression happens
  // here or anywhere else at boot.
  const scrubbed = new Set();

  async function scrubSeriesPages(series) {
    if (!series || series.importKind !== 'cbz' || !series.archiveKey) return 0;
    if (scrubbed.has(series.id)) return 0;
    scrubbed.add(series.id);
    let fixed = 0;
    for (const ch of (series.chapters || [])) {
      const cached = await safeStore('getChapter', [series.id, ch.id], null);
      if (!cached || !Array.isArray(cached.pages) || !cached.pages.length) continue;
      if (!cached.pages.some(isSessionLocalPageUrl)) continue;
      await safeStore('putChapter', [series.id, ch.id, Object.assign({}, cached, { pages: [] })], null);
      fixed++;
    }
    return fixed;
  }

  // Name kept — this is still the boot-time entry point — but it is a
  // rewrite-only migration pass now, not a decompressor.
  async function rehydrateAll() {
    const rows = await safeStore('listUserSeries', [], []);
    for (const s of (rows || [])) {
      try { await scrubSeriesPages(s); }
      catch (e) { console.warn('[Importer] page scrub failed', s && s.id, e); }
    }
  }

  // ── Commit ────────────────────────────────────────────────────────────────
  //
  // Chapter content and blobs go in first; the Series row lands last, so a
  // half-written import never shows up in the library pointing at nothing.

  async function commitDraft(draft, edits, opts) {
    const options = opts || {};
    const onProgress = options.onProgress || function () {};
    const patch = edits || {};

    const series = Object.assign({}, draft.series);
    if (typeof patch.title === 'string' && patch.title.trim()) series.title = collapse(patch.title).slice(0, 300);
    if (typeof patch.author === 'string') series.author = collapse(patch.author).slice(0, 200);
    if (typeof patch.description === 'string') series.description = patch.description.slice(0, 4000);
    if (TYPE_IDS.has(patch.type)) series.type = patch.type;
    if (patch.readingDirection) series.readingDirection = patch.readingDirection;

    series.source = 'user';                 // §5: everything we make is user data
    series.updatedAt = nowIso();
    series.chapterCount = (series.chapters || []).length;

    // A type flip between text and images changes what the payload must be, so
    // keep the stored ChapterFile kinds honest about it where we control them.
    const wantsText = TEXT_TYPES.has(series.type);

    onProgress({ phase: 'saving', message: 'Saving to your library…', done: 0, total: draft.files.length });

    // Payload first, chapters second, series row last — the ordering
    // invariant. On the native URI path the payload step is a file MOVE into
    // Data/archives/, not a blob write: zero archive bytes cross the bridge.
    const warnings = [];

    if (draft.nativeArchive && draft.nativeArchive.nativeUri) {
      const P = platform();
      const A = P && P.archives;
      let moved = null;
      if (A && typeof A.importFromUri === 'function') {
        if (typeof A.remove === 'function') {
          // A re-import of the same name+size lands on the same key, and a
          // native rename refuses to clobber — clear the destination first.
          try { await A.remove(draft.nativeArchive.archiveKey); } catch (e) { /* nothing there */ }
        }
        moved = await A.importFromUri(draft.nativeArchive.archiveKey, draft.nativeArchive.nativeUri);
      }
      if (!moved) {
        warnings.push('The archive could not be stored on this device, so its chapters will not open. Free some space and import the file again.');
      }
    }

    for (const [key, blob] of draft.blobs) {
      await safeStore('putBlob', [key, blob], null);
      // Store.putBlob resolves even when the underlying write silently failed
      // (the iOS quota landmine), so reading the key back is the only honest
      // success check. IndexedDB hands back a lazy file-backed handle, not a
      // byte copy — this costs a lookup, not a materialization.
      const back = await safeStore('getBlob', [key], null);
      if (!back) {
        warnings.push(draft.meta && draft.meta.kind === 'cbz'
          ? 'The archive could not be saved (storage is full or restricted), so its chapters will not open. Free some space and import the file again.'
          : 'The original file could not be kept alongside the chapters (storage is full or restricted). Reading works, but a future re-import will need the file again.');
      }
    }

    let done = 0;
    for (const [chapterId, file] of draft.files) {
      const record = Object.assign({}, file, { seriesId: series.id });
      if (wantsText && record.kind === 'image' && !record.blocks) {
        // Nothing to convert: leave the payload alone rather than fabricate one.
        record.kind = 'image';
      }
      await safeStore('putChapter', [series.id, chapterId, record], null);
      done++;
      if (done % 10 === 0 || done === draft.files.length) {
        onProgress({ phase: 'saving', message: 'Saving chapter ' + done + ' of ' + draft.files.length + '…', done: done, total: draft.files.length });
      }
    }

    const saved = await safeStore('putUserSeries', [series], series);
    if (series.importKind === 'cbz') {
      // No decompression here anymore — chapters hydrate lazily on open. What
      // a re-import MUST do is forget the superseded archive: a cached JSZip
      // or live page set from the old file would serve stale pages.
      dropArchiveState(series.archiveKey);
      scrubbed.delete(series.id);
    }

    // The catalogue listens for this and reloads My Library.
    try { window.dispatchEvent(new CustomEvent('or:library-changed', { detail: { id: series.id } })); }
    catch (e) { /* CustomEvent is unavailable in some very old webviews */ }

    scheduleBackup(BACKUP_CHANGE_DEBOUNCE_MS);   // library shape changed

    if (warnings.length) onProgress({ phase: 'warning', message: warnings.join(' ') });
    onProgress({ phase: 'done', message: 'Added “' + series.title + '”', count: series.chapterCount });
    return saved || series;
  }

  // ── File dispatch ─────────────────────────────────────────────────────────

  function kindOfFile(file) {
    const name = String(file && file.name || '').toLowerCase();
    const type = String(file && file.type || '').toLowerCase();
    if (/\.epub$/.test(name) || type === 'application/epub+zip') return 'epub';
    if (/\.(txt|text|md|markdown)$/.test(name) || type.indexOf('text/') === 0) return 'txt';
    if (/\.(cbz|zip)$/.test(name) || type === 'application/zip' || type === 'application/x-cbz') return 'cbz';
    return '';
  }

  async function prepareFile(file, opts) {
    if (!file) throw impErr('no_file', 'No file was chosen.');
    // §6 conduct: an .acsm is an Adobe DRM *license*, not a book. Refuse it
    // honestly before any parse attempt — no key handling, no workaround
    // hints, ever. Checked here (ahead of materialization and kindOfFile) so
    // every intake path — picker, drop, native URI — gets the same answer.
    if (/\.acsm$/i.test(String(file.name || ''))) {
      throw impErr('drm_file', 'That is a DRM license file, not a book. We can only open DRM-free files.');
    }
    // Native picks: kindOfFile dispatches on the ORIGINAL name either way.
    // EPUB and TXT are parsed in JS by design (both are small, and the format
    // caps are unchanged), so a picked one is materialized into a real File
    // first; a CBZ stays a URI and prepareArchive reads it natively — its
    // bytes never enter the webview. An unsupported pick falls through to the
    // refusal below without materializing anything.
    if (isPickedUri(file)) {
      const kind0 = kindOfFile(file);
      if (kind0 === 'epub' || kind0 === 'txt') {
        const real = await readPicked(file);
        if (!real) throw impErr('bad_file', 'That file could not be read from the picker. Try choosing it again, or open it from a different file app.');
        file = real;
      }
    }
    const kind = kindOfFile(file);
    if (kind === 'epub') return await prepareEpub(file, opts);
    if (kind === 'txt')  return await prepareTxt(file, opts);
    if (kind === 'cbz')  return await prepareArchive(file, opts);
    throw impErr('unsupported_file',
      'We can read EPUB, TXT, CBZ and ZIP. “' + (file.name || 'that file') + '” is none of those. ' +
      'PDF and CBR (RAR) are not supported — convert them first.');
  }

  // ── Refresh (check for new chapters) ──────────────────────────────────────

  async function refreshSeries(seriesId, opts) {
    const options = opts || {};
    const onProgress = options.onProgress || function () {};
    const current = await safeStore('getUserSeries', [seriesId], null);
    if (!current) throw impErr('not_in_library', 'That series is not in your library.');

    // File-backed series have no upstream, and pages hydrate lazily now — the
    // only useful work here is scrubbing any stale session-local page URLs an
    // older build left behind, and being honest about the rest.
    if (current.importKind !== 'url' || !current.sourceUrl) {
      try { await scrubSeriesPages(current); } catch (e) { /* purely cosmetic cleanup */ }
      return { series: current, added: 0, note: 'This series came from a file, so there is nothing new to fetch.' };
    }
    if (!gatewayEnabled()) throw impErr('gateway_disabled', GATEWAY_ERRORS.gateway_disabled.text);

    onProgress({ phase: 'resolving', message: 'Checking ' + hostOf(current.sourceUrl) + ' for new chapters…' });
    const body = await gatewayResolve(current.sourceUrl, { signal: options.signal });
    const fresh = normalizeIncomingChapters((body.series || {}).chapters, current.id);

    // Merge by id, then by number: a site that renumbers must not orphan the
    // chapters the user already downloaded.
    const byId = new Map((current.chapters || []).map(function (c) { return [c.id, c]; }));
    const byNum = new Map((current.chapters || []).filter(function (c) { return c.num != null; })
      .map(function (c) { return [c.num, c]; }));

    let added = 0;
    const merged = (current.chapters || []).slice();
    for (const ch of fresh) {
      const hit = byId.get(ch.id) || (ch.num != null ? byNum.get(ch.num) : null);
      if (hit) { Object.assign(hit, { title: ch.title || hit.title, src: ch.src || hit.src, updatedAt: ch.updatedAt || hit.updatedAt }); continue; }
      merged.push(ch);
      added++;
    }
    merged.sort(function (a, b) { return (a.num || 0) - (b.num || 0); });

    const next = Object.assign({}, current, {
      chapters: merged,
      chapterCount: merged.length,
      updatedAt: nowIso(),
    });
    const saved = await safeStore('putUserSeries', [next], next);
    try { window.dispatchEvent(new CustomEvent('or:library-changed', { detail: { id: seriesId } })); } catch (e) {}
    return { series: saved || next, added: added, note: added
      ? added + ' new chapter' + (added === 1 ? '' : 's') + ' found.'
      : 'No new chapters.' };
  }

  // ── Library export / import ───────────────────────────────────────────────
  //
  // The point is moving to a new device, so progress travels with the series.
  // Blobs (the original EPUB/CBZ) do not: they are the largest thing on disk by
  // an order of magnitude, and the user still has the file.

  const EXPORT_FORMAT = 'offline-reader-library';

  async function exportLibrary(opts) {
    const options = opts || {};
    const includeChapters = options.includeChapters !== false;
    const seriesRows = (await safeStore('listUserSeries', [], [])) || [];
    const out = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: nowIso(),
      series: seriesRows,
      progress: [],
      chapters: [],
      // Additive field (§2.7); `version` stays 1 and old builds ignore it.
      // Thoughts are tiny text and the reader's own writing, so they travel
      // in BOTH includeChapters modes — which also means the automatic native
      // backups (includeChapters: false) carry them with no further change.
      thoughts: (await safeStore('listThoughts', [{}], [])) || [],
    };
    for (const s of seriesRows) {
      const p = await safeStore('getProgress', [s.id], null);
      if (p) out.progress.push(p);
      if (!includeChapters) continue;
      const ids = (await safeStore('listCachedChapterIds', [s.id], [])) || [];
      for (const cid of ids) {
        const f = await safeStore('getChapter', [s.id, cid], null);
        // Session-local page URLs (blob:, Capacitor file URLs) are meaningless
        // on another device or after an app update — drop them and let the
        // archive-backed series rebuild from its own file.
        if (f) out.chapters.push(Object.assign({}, f, {
          pages: Array.isArray(f.pages) ? f.pages.filter(function (u) { return !isSessionLocalPageUrl(u); }) : undefined,
        }));
      }
    }
    return out;
  }

  async function importLibrary(json) {
    let data = json;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); }
      catch (e) { throw impErr('bad_json', 'That file is not valid JSON.'); }
    }
    if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.series)) {
      throw impErr('bad_export', 'That is not an Offline Reader library export. Look for the file you saved with “Export library”.');
    }

    let series = 0, chapters = 0, progress = 0, thoughts = 0;
    for (const s of data.series) {
      if (!s || !s.id) continue;
      await safeStore('putUserSeries', [Object.assign({}, s, { source: 'user' })], null);
      series++;
    }
    for (const c of (Array.isArray(data.chapters) ? data.chapters : [])) {
      if (!c || !c.seriesId || !c.id) continue;
      await safeStore('putChapter', [c.seriesId, c.id, c], null);
      chapters++;
    }
    for (const p of (Array.isArray(data.progress) ? data.progress : [])) {
      if (!p || !p.seriesId) continue;
      await safeStore('putProgress', [p.seriesId, p], null);
      progress++;
    }
    // Thoughts (§2.7): upsert idempotently by id when the (optional, additive)
    // array is present. Rows without an id are skipped rather than written —
    // putThought would mint a fresh id and a re-import would duplicate them.
    for (const t of (Array.isArray(data.thoughts) ? data.thoughts : [])) {
      if (!t || !t.id || !t.seriesId || typeof t.text !== 'string') continue;
      await safeStore('putThought', [t], null);
      thoughts++;
    }
    try { window.dispatchEvent(new CustomEvent('or:library-changed', { detail: { imported: series } })); } catch (e) {}
    await rehydrateAll();   // migration shim: scrub any stale page URLs the export carried
    scheduleBackup(BACKUP_CHANGE_DEBOUNCE_MS);   // a bulk import is a library change like any other
    return { series: series, chapters: chapters, progress: progress, thoughts: thoughts };
  }

  // ── Library backup (PLAN.md §6.2 — eviction insurance) ────────────────────
  //
  // WKWebView may evict IndexedDB wholesale, or just the progress store. A
  // small JSON snapshot (series + progress, never chapter payloads, never
  // source blobs) written to Documents/ makes both survivable. Two triggers:
  // library-shape changes (commit / delete / bulk import, debounced 1 min) and
  // the FIRST or:progress event of each local day (debounced 5 min) so a
  // months-long reading streak with zero imports is still at most ~a day
  // exposed. Restore is offered at boot — a visible toast the user must tap,
  // never a silent write.

  const BACKUP_CHANGE_DEBOUNCE_MS   = 60 * 1000;
  const BACKUP_PROGRESS_DEBOUNCE_MS = 5 * 60 * 1000;

  let backupTimer = null;
  let backupDueAt = 0;
  let progressBackupDay = '';       // last local day that scheduled a progress backup
  let sessionDeleted = false;       // the user emptied the library on purpose this session

  function canBackup() {
    const P = platform();
    return !!(P && P.isNative && P.backup && typeof P.backup.write === 'function');
  }

  // Earliest deadline wins: a sooner pending write already covers this change,
  // and never letting a burst of triggers push the write out keeps the loss
  // window bounded instead of merely coalesced.
  function scheduleBackup(delayMs) {
    if (!canBackup()) return;
    const dueAt = Date.now() + delayMs;
    if (backupTimer && backupDueAt <= dueAt) return;
    clearTimeout(backupTimer);
    backupDueAt = dueAt;
    backupTimer = setTimeout(function () {
      backupTimer = null;
      writeBackup().catch(function () { /* writeBackup reports its own failures */ });
    }, delayMs);
  }

  async function writeBackup() {
    if (!canBackup()) return;
    try {
      const data = await exportLibrary({ includeChapters: false });
      // An empty library the user did not empty is the eviction this file
      // insures against — overwriting a good backup with the wreckage would
      // destroy the insurance at the exact moment it is needed.
      if (!data.series.length && !sessionDeleted) return;
      await platform().backup.write(JSON.stringify(data));
    } catch (e) {
      console.warn('[Importer] backup write failed', e);
    }
  }

  function wireBackupTriggers() {
    if (!canBackup()) return;
    window.addEventListener('or:progress', function () {
      const today = localDayStr();
      if (progressBackupDay === today) return;
      progressBackupDay = today;
      scheduleBackup(BACKUP_PROGRESS_DEBOUNCE_MS);
    });
    // §2.7: thoughts ride the export payload, so a put/delete is a library-
    // shape change like a commit — same 1 min debounce, earliest deadline wins.
    window.addEventListener('or:thoughts-changed', function () {
      scheduleBackup(BACKUP_CHANGE_DEBOUNCE_MS);
    });
  }

  // Boot-time restore offer. Two detections, per the plan: the library is
  // empty but a backup has series (full / series-side eviction), or series
  // survived while the progress store did not (partial eviction). Either way
  // the offer is a toast with an explicit Restore tap — restoring rewrites
  // rows, and rewriting rows without being asked is how trust dies.
  async function offerBackupRestore() {
    const P = platform();
    if (!P || !P.isNative || !P.backup || typeof P.backup.readLatest !== 'function') return;
    try { await P.ready; } catch (e) { /* ready never rejects, but belts and braces */ }

    const seriesRows = (await safeStore('listUserSeries', [], [])) || [];
    const haveSeries = seriesRows.length > 0;
    if (haveSeries) {
      const p = (await safeStore('listProgress', [{ limit: 1 }], [])) || [];
      if (p.length) return;   // series and progress both present — healthy boot
    }

    const raw = await P.backup.readLatest();
    if (!raw) return;
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || data.format !== EXPORT_FORMAT) return;
    const backupSeries   = Array.isArray(data.series)   ? data.series.length   : 0;
    const backupProgress = Array.isArray(data.progress) ? data.progress.length : 0;

    if (!haveSeries && backupSeries > 0) {
      showRestoreToast(
        'Your library looks empty, but a backup on this device has ' + backupSeries +
        ' series' + (backupProgress ? ' and ' + backupProgress + ' reading position' + (backupProgress === 1 ? '' : 's') : '') + '.',
        raw);
    } else if (haveSeries && backupProgress > 0) {
      showRestoreToast(
        'Your reading positions look lost, but a backup on this device has ' +
        backupProgress + ' of them.',
        raw);
    }
  }

  // The offer itself. Parked on <body> (the .cat-toast precedent) because the
  // import screen is hidden at boot; solid background because the blur budget
  // is already spent on the app's fixed chrome.
  function showRestoreToast(message, rawJson) {
    const existing = document.querySelector('.imp-restore');
    if (existing) existing.remove();

    const toastEl = el('div', 'imp-restore');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.appendChild(el('p', 'imp-restore-msg', message + ' Restore it?'));

    const actions = el('div', 'imp-restore-actions');
    const dismiss = el('button', 'imp-restore-btn');
    dismiss.type = 'button';
    dismiss.textContent = 'Not now';
    dismiss.setAttribute('aria-label', 'Dismiss the restore offer');
    dismiss.addEventListener('click', function () { toastEl.remove(); });

    const restore = el('button', 'imp-restore-btn imp-restore-btn--accent');
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', 'Restore the library backup');
    restore.addEventListener('click', async function () {
      restore.disabled = true;
      dismiss.disabled = true;
      restore.textContent = 'Restoring…';
      try {
        const res = await importLibrary(rawJson);
        toastEl.textContent = '';
        toastEl.appendChild(el('p', 'imp-restore-msg',
          'Restored ' + res.series + ' series and ' + res.progress + ' reading position' + (res.progress === 1 ? '' : 's') + '.'));
      } catch (e) {
        console.warn('[Importer] backup restore failed', e);
        toastEl.textContent = '';
        toastEl.appendChild(el('p', 'imp-restore-msg',
          'That backup could not be read. Your library was left untouched.'));
      }
      setTimeout(function () { toastEl.remove(); }, 6000);
    });

    actions.appendChild(dismiss);
    actions.appendChild(restore);
    toastEl.appendChild(actions);
    document.body.appendChild(toastEl);

    // If the user starts reading instead, stop hovering over the reader —
    // the untouched offer simply comes back on the next launch.
    const clear = function () {
      window.removeEventListener('or:progress', clear);
      if (!restore.disabled) toastEl.remove();
    };
    window.addEventListener('or:progress', clear);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UI
  // ══════════════════════════════════════════════════════════════════════════

  const ui = {};            // element handles
  let uiReady = false;
  let currentDraft = null;
  let activeAbort = null;
  let lastAttemptedUrl = '';
  let returnScreen = 'home-screen';

  function button(className, label, ariaLabel) {
    const b = el('button', className);
    b.type = 'button';
    if (label) b.appendChild(el('span', null, label));
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    return b;
  }

  function labelledField(labelText, control, hint) {
    const wrap = el('label', 'imp-field');
    wrap.appendChild(el('span', 'imp-label', labelText));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('span', 'imp-hint', hint));
    return wrap;
  }

  function buildUi() {
    if (uiReady) return;
    if (!document.body) return;

    const root = el('div', 'imp-screen');
    root.id = SCREEN_ID;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Add a series');

    // ── header ──
    const header = el('header', 'imp-header');
    const back = button('imp-icon-btn', null, 'Back');
    back.appendChild(icon('back', 20));
    back.addEventListener('click', function () { close(); });

    const title = el('h2', 'imp-title', 'Add a series');
    title.id = 'imp-heading';

    const manageBtn = button('imp-icon-btn', null, 'Manage imported series');
    manageBtn.appendChild(icon('gear', 18));
    manageBtn.addEventListener('click', function () { showView('manage'); });

    header.appendChild(back);
    header.appendChild(title);
    header.appendChild(manageBtn);

    const body = el('div', 'imp-body');
    body.id = 'imp-body';

    root.appendChild(header);
    root.appendChild(body);
    document.body.appendChild(root);

    ui.root = root;
    ui.header = header;
    ui.heading = title;
    ui.manageBtn = manageBtn;
    ui.body = body;

    buildAddView(body);
    buildConfirmView(body);
    buildManageView(body);

    if (typeof window.registerScreen === 'function') window.registerScreen(root);
    uiReady = true;
  }

  // ── Add view ──────────────────────────────────────────────────────────────

  // §2.10 / §6.2 — the "Where is my file?" list, copy VERBATIM from the plan.
  // App-authored data rendered via el()/textContent; factual, unresentful,
  // one sentence per store. We state what opens here, never how to break locks.
  const DRM_STORES = [
    { store: 'Project Gutenberg / Standard Ebooks',
      copy: 'Free and DRM-free. Download the EPUB and open it here.' },
    { store: 'Humble Bundle',
      copy: 'DRM-free. Library → your purchase → download EPUB (or CBZ for comics).' },
    { store: 'Leanpub / itch.io / Smashwords',
      copy: 'DRM-free. Your library page offers direct EPUB downloads.' },
    { store: 'Kobo',
      copy: 'Some titles are DRM-free — kobo.com → My Books → Download EPUB. Titles that download as ACSM are locked and cannot open here.' },
    { store: 'Google Play Books',
      copy: 'Books → your title → Download EPUB. If the download is an ACSM file, that title is locked and cannot open here.' },
    { store: 'Baen / Tor (publisher stores)',
      copy: 'These publishers sell DRM-free EPUBs. Download and open.' },
    { store: 'Kindle',
      copy: 'Amazon does not offer DRM-free downloads. Kindle books stay in Kindle — we cannot open them, and we will not break locks.' },
    { store: 'Apple Books',
      copy: 'Purchases are locked to Apple Books and cannot open here.' },
    { store: 'Comics (Comixology → Kindle)',
      copy: 'Comixology purchases moved into the Kindle system and are locked. DRM-free comics from Humble or itch.io open here as CBZ.' },
  ];

  const GUTENBERG_URL = 'https://www.gutenberg.org/';

  // The third card under "Open a file" (§2.10): guidance, not a feature —
  // purchased DRM-free files already open through the normal picker, and this
  // card exists to say so plainly. File-based, so it renders with the gateway
  // off too.
  function buildBoughtCard() {
    const card = el('div', 'imp-card imp-card--muted imp-card--bought');
    card.id = 'imp-bought-card';

    const head = el('div', 'imp-card-head');
    head.appendChild(icon('book', 16));
    head.appendChild(el('h3', 'imp-card-title', 'Books you’ve bought'));
    card.appendChild(head);

    card.appendChild(el('p', 'imp-card-sub',
      'Bought a book? If your store lets you download a DRM-free EPUB or CBZ, it opens here like any other file.'));

    // Disclosure row: the store list stays folded until asked for — nine rows
    // of retailer guidance would otherwise dominate the add view.
    const disclose = button('imp-disclose', null, null);
    disclose.id = 'imp-where-btn';
    disclose.setAttribute('aria-expanded', 'false');
    disclose.setAttribute('aria-controls', 'imp-store-list');
    disclose.appendChild(el('span', 'imp-disclose-label', 'Where is my file?'));
    const chev = icon('chev', 14);
    chev.classList.add('imp-disclose-chev');
    disclose.appendChild(chev);

    const storeList = el('ul', 'imp-stores');
    storeList.id = 'imp-store-list';
    storeList.hidden = true;
    DRM_STORES.forEach(function (row) {
      const li = el('li', 'imp-store-row');
      li.appendChild(el('span', 'imp-store-name', row.store));
      li.appendChild(el('span', 'imp-store-copy', row.copy));
      storeList.appendChild(li);
    });

    disclose.addEventListener('click', function () {
      const open = storeList.hidden;
      storeList.hidden = !open;
      disclose.setAttribute('aria-expanded', open ? 'true' : 'false');
      disclose.classList.toggle('open', open);
    });

    card.appendChild(disclose);
    card.appendChild(storeList);

    const actions = el('div', 'imp-actions imp-actions--start');
    const openBtn = button('imp-btn', 'Open a file', 'Open a purchased file');
    openBtn.id = 'imp-bought-open';
    openBtn.addEventListener('click', function () { pickImportFile(); });
    actions.appendChild(openBtn);

    const gutHref = safeHttpUrl(GUTENBERG_URL);
    if (gutHref) {
      const gut = document.createElement('a');
      gut.className = 'imp-btn';
      gut.id = 'imp-gutenberg';
      gut.href = gutHref;
      gut.target = '_blank';
      gut.rel = 'noopener';
      gut.setAttribute('aria-label', 'Project Gutenberg — free classics, no lock');
      gut.appendChild(el('span', null, 'Free classics, no lock'));
      actions.appendChild(gut);
    }
    card.appendChild(actions);

    ui.boughtCard = card;
    ui.storeList = storeList;
    return card;
  }

  function buildAddView(parent) {
    const view = el('section', 'imp-view');
    view.id = 'imp-view-add';

    // — link card —
    const linkCard = el('div', 'imp-card');
    linkCard.id = 'imp-link-card';

    const linkHead = el('div', 'imp-card-head');
    linkHead.appendChild(icon('link', 16));
    linkHead.appendChild(el('h3', 'imp-card-title', 'Add by link'));
    linkCard.appendChild(linkHead);

    linkCard.appendChild(el('p', 'imp-card-sub',
      'Paste a link to the series page on the site where you already read it. We fetch the chapter list and give you our reader over it — nothing is copied to a server.'));

    const inputRow = el('div', 'imp-input-row');
    const input = document.createElement('input');
    input.type = 'url';
    input.id = 'imp-url';
    input.className = 'imp-input';
    input.placeholder = 'https://example.com/series/…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Series page link');
    input.setAttribute('aria-describedby', 'imp-url-preview');
    input.addEventListener('input', updateUrlPreview);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); startUrlImport(); }
    });
    // A share sheet hands over prose with a link inside it; take the link.
    input.addEventListener('paste', function (e) {
      let text = '';
      try { text = (e.clipboardData || window.clipboardData).getData('text'); } catch (err) { text = ''; }
      const found = extractUrl(text);
      if (found && found !== collapse(text)) {
        e.preventDefault();
        input.value = found;
        updateUrlPreview();
      }
    });

    const go = button('imp-btn imp-btn--accent', 'Look up', 'Look up this link');
    go.id = 'imp-go';
    go.addEventListener('click', function () { startUrlImport(); });

    inputRow.appendChild(input);
    inputRow.appendChild(go);
    linkCard.appendChild(inputRow);

    // What we think it is, before spending a network round trip on it.
    const preview = el('div', 'imp-preview');
    preview.id = 'imp-url-preview';
    preview.hidden = true;
    linkCard.appendChild(preview);

    const status = el('div', 'imp-status');
    status.id = 'imp-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    linkCard.appendChild(status);

    ui.linkCard = linkCard;
    ui.urlInput = input;
    ui.goBtn = go;
    ui.preview = preview;
    ui.status = status;

    // — gateway-off explainer, shown instead of the link card —
    const off = el('div', 'imp-card imp-card--muted');
    off.id = 'imp-gateway-off';
    const offHead = el('div', 'imp-card-head');
    offHead.appendChild(icon('warn', 16));
    offHead.appendChild(el('h3', 'imp-card-title', 'Adding by link is switched off here'));
    off.appendChild(offHead);
    off.appendChild(el('p', 'imp-card-sub',
      'Importing a series from a link needs the content gateway — a small Cloudflare Worker that fetches the page for you, because a browser cannot read another site directly. ' +
      'This copy of Offline Reader has none configured (OR_CONFIG.workerBase in js/config.js is empty), so the link box is hidden rather than shown as a button that cannot work. ' +
      'Deploying your own takes a few minutes and costs nothing on Cloudflare’s free plan — the steps are in worker/README.md. Opening a file below works with no gateway at all.'));
    ui.gatewayOff = off;

    // — file card —
    const fileCard = el('div', 'imp-card');
    const fileHead = el('div', 'imp-card-head');
    fileHead.appendChild(icon('file', 16));
    fileHead.appendChild(el('h3', 'imp-card-title', 'Open a file'));
    fileCard.appendChild(fileHead);
    fileCard.appendChild(el('p', 'imp-card-sub',
      'EPUB and TXT become a novel with real chapters. CBZ and ZIP become an image series. Everything is parsed on this device and stays here.'));

    const drop = el('div', 'imp-drop');
    drop.id = 'imp-drop';
    drop.tabIndex = 0;
    drop.setAttribute('role', 'button');
    drop.setAttribute('aria-label', 'Choose a file to import — EPUB, TXT, CBZ or ZIP');

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'imp-file';
    fileInput.className = 'imp-file-input';
    fileInput.accept = '.epub,.txt,.text,.md,.cbz,.zip,application/epub+zip,text/plain,application/zip';
    fileInput.addEventListener('change', function () {
      const f = fileInput.files && fileInput.files[0];
      // Reset first: picking the same file twice must still fire `change`.
      fileInput.value = '';
      if (f) startFileImport(f);
    });

    drop.appendChild(icon('up', 26));
    drop.appendChild(el('div', 'imp-drop-title', 'Choose a file'));
    drop.appendChild(el('div', 'imp-drop-sub', 'EPUB · TXT · CBZ · ZIP'));
    drop.addEventListener('click', function () { pickImportFile(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickImportFile(); }
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) startFileImport(f);
    });

    fileCard.appendChild(drop);
    fileCard.appendChild(fileInput);

    const fileStatus = el('div', 'imp-status');
    fileStatus.id = 'imp-file-status';
    fileStatus.setAttribute('role', 'status');
    fileStatus.setAttribute('aria-live', 'polite');
    fileStatus.hidden = true;
    fileCard.appendChild(fileStatus);
    ui.fileStatus = fileStatus;
    ui.fileInput = fileInput;

    const manageLink = button('imp-linkbtn', 'Manage imported series', 'Manage imported series');
    manageLink.id = 'imp-manage-link';
    manageLink.addEventListener('click', function () { showView('manage'); });

    view.appendChild(linkCard);
    view.appendChild(off);
    view.appendChild(fileCard);
    view.appendChild(buildBoughtCard());
    view.appendChild(manageLink);
    parent.appendChild(view);
    ui.addView = view;
  }

  function updateUrlPreview() {
    const raw = ui.urlInput.value.trim();
    const box = ui.preview;
    box.textContent = '';
    if (!raw) { box.hidden = true; box.classList.remove('bad'); return; }

    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : extractUrl(raw);
    let normalized;
    try { normalized = normalizeUrl(candidate || raw); }
    catch (e) {
      box.hidden = false;
      box.classList.add('bad');
      box.appendChild(icon('warn', 13));
      box.appendChild(el('span', null, e.message));
      return;
    }
    box.hidden = false;
    box.classList.remove('bad');
    const guess = guessTypeFromUrl(normalized);
    box.appendChild(el('span', 'imp-chip', hostOf(normalized)));
    box.appendChild(el('span', 'imp-chip imp-chip--soft', 'looks like ' + typeLabel(guess).toLowerCase()));
    box.appendChild(el('span', 'imp-preview-note', 'You can change the type before it is saved.'));
  }

  // Status lines that never lie: a phase, a real count where one exists, and a
  // cancel button whenever there is something running to cancel.
  function setStatus(target, kind, message, extras) {
    const box = target;
    if (!box) return;
    box.textContent = '';
    box.hidden = false;
    box.className = 'imp-status imp-status--' + kind;

    const row = el('div', 'imp-status-row');
    if (kind === 'busy') {
      const sp = el('span', 'imp-spinner');
      sp.setAttribute('aria-hidden', 'true');
      row.appendChild(sp);
    } else if (kind === 'error') {
      row.appendChild(icon('warn', 15));
    } else if (kind === 'ok') {
      row.appendChild(icon('check', 15));
    }
    row.appendChild(el('span', 'imp-status-text', message));
    box.appendChild(row);

    const opts = extras || {};
    if (opts.detail) box.appendChild(el('div', 'imp-status-detail', opts.detail));

    if (opts.total) {
      const bar = el('div', 'imp-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(opts.total));
      bar.setAttribute('aria-valuenow', String(opts.done || 0));
      const fill = el('div', 'imp-bar-fill');
      fill.style.width = Math.round(((opts.done || 0) / opts.total) * 100) + '%';
      bar.appendChild(fill);
      box.appendChild(bar);
    }

    const actions = el('div', 'imp-status-actions');
    if (opts.cancel) {
      const c = button('imp-btn imp-btn--ghost', 'Cancel', 'Cancel this import');
      c.addEventListener('click', opts.cancel);
      actions.appendChild(c);
    }
    if (opts.retry) {
      const r = button('imp-btn', 'Try again', 'Try that link again');
      r.id = 'imp-retry';
      r.addEventListener('click', opts.retry);
      actions.appendChild(r);
    }
    // A status that ends somewhere (a commit that finished with a warning)
    // gets a way forward, not just a message.
    if (opts.action && typeof opts.action.onClick === 'function') {
      const a = button('imp-btn', opts.action.label || 'Continue', opts.action.label || 'Continue');
      a.addEventListener('click', opts.action.onClick);
      actions.appendChild(a);
    }
    if (actions.childNodes.length) box.appendChild(actions);
  }

  function clearStatus(target) {
    if (!target) return;
    target.textContent = '';
    target.hidden = true;
  }

  // ── Confirm view ──────────────────────────────────────────────────────────
  //
  // The whole point of this screen: the title and the type are guesses, and a
  // wrong one is permanent once progress starts accumulating against the id.

  function buildConfirmView(parent) {
    const view = el('section', 'imp-view');
    view.id = 'imp-view-confirm';
    view.hidden = true;

    const warn = el('div', 'imp-banner');
    warn.id = 'imp-confidence';
    warn.hidden = true;
    view.appendChild(warn);

    const dup = el('div', 'imp-banner imp-banner--info');
    dup.id = 'imp-duplicate';
    dup.hidden = true;
    view.appendChild(dup);

    const top = el('div', 'imp-confirm-top');

    const coverWrap = el('div', 'imp-cover');
    coverWrap.id = 'imp-cover';
    top.appendChild(coverWrap);

    const facts = el('div', 'imp-facts');
    facts.id = 'imp-facts';
    top.appendChild(facts);
    view.appendChild(top);

    const form = el('div', 'imp-form');

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.id = 'imp-edit-title';
    titleInput.className = 'imp-input';
    titleInput.setAttribute('aria-label', 'Series title');
    form.appendChild(labelledField('Title', titleInput));

    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.id = 'imp-edit-author';
    authorInput.className = 'imp-input';
    authorInput.setAttribute('aria-label', 'Author');
    form.appendChild(labelledField('Author', authorInput));

    const typeGroup = el('div', 'imp-segmented');
    typeGroup.id = 'imp-edit-type';
    typeGroup.setAttribute('role', 'radiogroup');
    typeGroup.setAttribute('aria-label', 'Content type');
    ui.typeButtons = {};
    TYPES.forEach(function (t) {
      const b = button('imp-seg', t.label, t.label);
      b.dataset.type = t.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.addEventListener('click', function () { setDraftType(t.id); });
      ui.typeButtons[t.id] = b;
      typeGroup.appendChild(b);
    });
    const typeField = el('div', 'imp-field');
    typeField.appendChild(el('span', 'imp-label', 'Type'));
    typeField.appendChild(typeGroup);
    typeField.appendChild(el('span', 'imp-hint', 'Text types open in the novel reader; image types open in the page reader. We guess from the source, and we are wrong often enough to ask.'));
    form.appendChild(typeField);

    // TXT only: change how the file was cut into chapters, live.
    const splitField = el('div', 'imp-field');
    splitField.id = 'imp-split-field';
    splitField.hidden = true;
    splitField.appendChild(el('span', 'imp-label', 'Chapter split'));
    const splitSel = document.createElement('select');
    splitSel.id = 'imp-split';
    splitSel.className = 'imp-select';
    splitSel.setAttribute('aria-label', 'How to split this file into chapters');
    splitSel.addEventListener('change', function () { applySplitStrategy(splitSel.value); });
    splitField.appendChild(splitSel);
    splitField.appendChild(el('span', 'imp-hint', 'Check the chapter list below before saving.'));
    form.appendChild(splitField);
    ui.splitField = splitField;
    ui.splitSelect = splitSel;

    const descInput = document.createElement('textarea');
    descInput.id = 'imp-edit-desc';
    descInput.className = 'imp-input imp-textarea';
    descInput.rows = 3;
    descInput.setAttribute('aria-label', 'Description');
    form.appendChild(labelledField('Description', descInput));

    view.appendChild(form);

    const listLabel = el('div', 'imp-section-label');
    listLabel.id = 'imp-chapter-label';
    view.appendChild(listLabel);
    const list = el('ol', 'imp-chapters');
    list.id = 'imp-chapter-list';
    view.appendChild(list);

    const confirmStatus = el('div', 'imp-status');
    confirmStatus.id = 'imp-confirm-status';
    confirmStatus.setAttribute('role', 'status');
    confirmStatus.setAttribute('aria-live', 'polite');
    confirmStatus.hidden = true;
    view.appendChild(confirmStatus);

    const actions = el('div', 'imp-actions');
    const cancel = button('imp-btn imp-btn--ghost', 'Cancel', 'Discard this import');
    cancel.id = 'imp-cancel';
    cancel.addEventListener('click', function () { currentDraft = null; showView('add'); });
    const save = button('imp-btn imp-btn--accent', 'Add to library', 'Add this series to your library');
    save.id = 'imp-save';
    save.addEventListener('click', function () { saveDraft(); });
    actions.appendChild(cancel);
    actions.appendChild(save);
    view.appendChild(actions);

    parent.appendChild(view);
    ui.confirmView = view;
    ui.confidenceBanner = warn;
    ui.duplicateBanner = dup;
    ui.coverBox = coverWrap;
    ui.factsBox = facts;
    ui.titleInput = titleInput;
    ui.authorInput = authorInput;
    ui.descInput = descInput;
    ui.chapterLabel = listLabel;
    ui.chapterList = list;
    ui.confirmStatus = confirmStatus;
    ui.saveBtn = save;
  }

  function setDraftType(type) {
    if (!currentDraft || !TYPE_IDS.has(type)) return;
    currentDraft.series.type = type;
    // Image types read right-to-left by default for manga, left-to-right for
    // manhwa (which is vertical/LTR in practice). Prose is always LTR.
    currentDraft.series.readingDirection =
      type === 'manga' ? 'rtl' : (type === 'manhwa' ? 'vertical' : 'ltr');
    syncTypeButtons();
  }

  function syncTypeButtons() {
    const active = currentDraft ? currentDraft.series.type : null;
    TYPES.forEach(function (t) {
      const b = ui.typeButtons[t.id];
      if (!b) return;
      const on = t.id === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  }

  function applySplitStrategy(strategyId) {
    if (!currentDraft || typeof currentDraft.rebuild !== 'function') return;
    // Carry the user's edits across the rebuild — retyping the title because
    // you changed the split would be maddening.
    const edits = {
      title: ui.titleInput.value,
      author: ui.authorInput.value,
      description: ui.descInput.value,
      type: currentDraft.series.type,
    };
    const next = currentDraft.rebuild(strategyId);
    next.series.title = collapse(edits.title) || next.series.title;
    next.series.author = collapse(edits.author);
    next.series.description = edits.description;
    if (TYPE_IDS.has(edits.type)) next.series.type = edits.type;
    currentDraft = next;
    renderConfirm(true);
  }

  function factRow(label, value) {
    const row = el('div', 'imp-fact');
    row.appendChild(el('span', 'imp-fact-label', label));
    row.appendChild(el('span', 'imp-fact-value', value));
    return row;
  }

  function renderConfirm(keepEdits) {
    const draft = currentDraft;
    if (!draft) return;
    const s = draft.series;
    const meta = draft.meta || {};

    ui.heading.textContent = 'Check before adding';

    // cover
    ui.coverBox.textContent = '';
    const src = displayImageUrl(s.cover);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.className = 'imp-cover-img';
      img.addEventListener('error', function () { img.replaceWith(coverFallback(s)); });
      ui.coverBox.appendChild(img);
    } else {
      ui.coverBox.appendChild(coverFallback(s));
    }

    // facts
    ui.factsBox.textContent = '';
    if (meta.kind === 'url') {
      ui.factsBox.appendChild(factRow('From', hostOf(s.sourceUrl || '')));
      if (meta.adapter) ui.factsBox.appendChild(factRow('Read by', meta.adapter));
    } else {
      ui.factsBox.appendChild(factRow('File', meta.fileName || '—'));
      ui.factsBox.appendChild(factRow('Size', fmtBytes(meta.fileSize)));
    }
    ui.factsBox.appendChild(factRow('Chapters', String((s.chapters || []).length)));
    if (meta.words) ui.factsBox.appendChild(factRow('Words', meta.words.toLocaleString()));
    if (meta.pageCount) ui.factsBox.appendChild(factRow('Pages', String(meta.pageCount)));
    if (meta.skipped) ui.factsBox.appendChild(factRow('Skipped', meta.skipped + ' empty document' + (meta.skipped === 1 ? '' : 's')));

    if (!keepEdits) {
      ui.titleInput.value = s.title || '';
      ui.authorInput.value = s.author || '';
      ui.descInput.value = s.description || '';
    }
    syncTypeButtons();

    // low-confidence warning (§ gateway contract)
    if (meta.confidence === 'low') {
      ui.confidenceBanner.hidden = false;
      ui.confidenceBanner.textContent = '';
      ui.confidenceBanner.appendChild(icon('warn', 15));
      ui.confidenceBanner.appendChild(el('span', null,
        'We had to guess at this site’s structure, so the chapter list may be incomplete, out of order, or contain navigation links. ' +
        'Check the first few titles below. You can still add it — fixing a wrong chapter list later means re-importing.'));
    } else {
      ui.confidenceBanner.hidden = true;
    }

    if (meta.existing) {
      ui.duplicateBanner.hidden = false;
      ui.duplicateBanner.textContent = '';
      ui.duplicateBanner.appendChild(icon('check', 15));
      ui.duplicateBanner.appendChild(el('span', null,
        'This is already in your library. Saving updates it in place and keeps your reading position — it will not be added twice.'));
    } else {
      ui.duplicateBanner.hidden = true;
    }

    if (meta.warning) {
      setStatus(ui.confirmStatus, 'error', meta.warning);
    } else {
      clearStatus(ui.confirmStatus);
    }

    // split strategies (TXT)
    if (meta.strategies && meta.strategies.length > 1) {
      ui.splitField.hidden = false;
      ui.splitSelect.textContent = '';
      meta.strategies.forEach(function (st) {
        const o = document.createElement('option');
        o.value = st.id;
        o.textContent = st.label + ' — ' + st.count + (st.count === 1 ? ' chapter' : ' chapters');
        ui.splitSelect.appendChild(o);
      });
      ui.splitSelect.value = meta.strategy || meta.strategies[0].id;
    } else {
      ui.splitField.hidden = true;
    }

    // chapter preview
    const chapters = s.chapters || [];
    ui.chapterLabel.textContent = chapters.length
      ? 'First chapters (' + chapters.length + ' total)'
      : 'No chapters found';
    ui.chapterList.textContent = '';
    chapters.slice(0, 6).forEach(function (c) {
      const li = el('li', 'imp-chapter');
      li.appendChild(el('span', 'imp-chapter-num', c.num != null ? String(c.num) : '—'));
      li.appendChild(el('span', 'imp-chapter-title', c.title || 'Chapter ' + c.num));
      if (typeof c.wordCount === 'number' && c.wordCount) {
        li.appendChild(el('span', 'imp-chapter-meta', c.wordCount.toLocaleString() + ' words'));
      } else if (typeof c.pageCount === 'number') {
        li.appendChild(el('span', 'imp-chapter-meta', c.pageCount + 'p'));
      }
      ui.chapterList.appendChild(li);
    });
    if (chapters.length > 6) {
      const li = el('li', 'imp-chapter imp-chapter--more');
      li.appendChild(el('span', 'imp-chapter-title', '+ ' + (chapters.length - 6) + ' more'));
      ui.chapterList.appendChild(li);
    }

    ui.saveBtn.disabled = !chapters.length;
  }

  function coverFallback(s) {
    // §2.8: a generated cover beats an icon placeholder — guarded, because
    // covers.js is deletable (§0.5) and the icon path below stays as the
    // fallback of the fallback.
    if (window.Covers && typeof window.Covers.element === 'function' && s && s.id) {
      try { return window.Covers.element(s, { className: 'imp-cover-svg' }); }
      catch (e) { /* fall through to the icon placeholder */ }
    }
    const ph = el('div', 'imp-cover-ph');
    ph.appendChild(icon(TEXT_TYPES.has(s.type) ? 'book' : 'image', 22));
    ph.appendChild(el('span', 'imp-cover-ph-title', s.title || ''));
    return ph;
  }

  async function saveDraft() {
    if (!currentDraft) return;
    const draft = currentDraft;
    ui.saveBtn.disabled = true;

    const edits = {
      title: ui.titleInput.value,
      author: ui.authorInput.value,
      description: ui.descInput.value,
      type: draft.series.type,
    };

    try {
      let commitWarning = null;
      const series = await commitDraft(draft, edits, {
        onProgress: function (p) {
          if (p.phase === 'warning') { commitWarning = p.message; return; }
          setStatus(ui.confirmStatus, p.phase === 'done' ? 'ok' : 'busy', p.message, {
            done: p.done, total: p.total,
          });
        },
      });
      currentDraft = null;
      if (commitWarning) {
        // The series committed, but part of the payload did not stick (quota,
        // disk). Navigating away would flash the warning for a frame — hold
        // here and let the user leave deliberately.
        setStatus(ui.confirmStatus, 'error', commitWarning, {
          action: { label: 'Open it anyway', onClick: function () { handoff(series); } },
        });
        return;
      }
      await handoff(series);
    } catch (e) {
      console.error('[Importer] save failed', e);
      setStatus(ui.confirmStatus, 'error', e.message || 'Could not save that series.');
      ui.saveBtn.disabled = false;
    }
  }

  // Hand the user straight into what they just added. The catalogue owns
  // routing (§2.2), so we ask it rather than calling showScreen ourselves.
  async function handoff(series) {
    const C = window.Catalogue;
    if (C && typeof C.refresh === 'function') {
      try { await C.refresh(); } catch (e) { /* the library list can lag safely */ }
    }
    if (C && typeof C.openSeries === 'function') {
      try { C.openSeries(series); return; }
      catch (e) { console.warn('[Importer] openSeries failed', e); }
    }
    close();
  }

  // ── Manage view ───────────────────────────────────────────────────────────

  function buildManageView(parent) {
    const view = el('section', 'imp-view');
    view.id = 'imp-view-manage';
    view.hidden = true;

    const usage = el('div', 'imp-usage');
    usage.id = 'imp-usage';
    view.appendChild(usage);

    const list = el('div', 'imp-manage-list');
    list.id = 'imp-manage-list';
    view.appendChild(list);

    const tools = el('div', 'imp-card');
    const toolsHead = el('div', 'imp-card-head');
    toolsHead.appendChild(icon('down', 16));
    toolsHead.appendChild(el('h3', 'imp-card-title', 'Move to another device'));
    tools.appendChild(toolsHead);
    tools.appendChild(el('p', 'imp-card-sub',
      'Everything you import lives in this browser only — clearing site data deletes it. Export writes one JSON file with your series, your reading positions and, if you want, the chapter text you have downloaded. Original EPUB and CBZ files are not included; keep those yourself.'));

    const incWrap = el('label', 'imp-check');
    const inc = document.createElement('input');
    inc.type = 'checkbox';
    inc.id = 'imp-export-chapters';
    inc.checked = true;
    incWrap.appendChild(inc);
    incWrap.appendChild(el('span', null, 'Include downloaded chapter content'));
    tools.appendChild(incWrap);

    const row = el('div', 'imp-actions imp-actions--start');
    const exportBtn = button('imp-btn', 'Export library', 'Export your library to a JSON file');
    exportBtn.id = 'imp-export';
    exportBtn.addEventListener('click', function () { doExport(inc.checked); });

    const importBtn = button('imp-btn', 'Import library', 'Import a library JSON file');
    importBtn.id = 'imp-import';
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.className = 'imp-file-input';
    importInput.addEventListener('change', function () {
      const f = importInput.files && importInput.files[0];
      importInput.value = '';
      if (f) doImport(f);
    });
    importBtn.addEventListener('click', function () { pickLibraryJson(importInput); });

    row.appendChild(exportBtn);
    row.appendChild(importBtn);
    row.appendChild(importInput);
    tools.appendChild(row);

    const toolStatus = el('div', 'imp-status');
    toolStatus.id = 'imp-tool-status';
    toolStatus.setAttribute('role', 'status');
    toolStatus.setAttribute('aria-live', 'polite');
    toolStatus.hidden = true;
    tools.appendChild(toolStatus);

    view.appendChild(buildPerformanceCard());

    const storageCard = buildStorageCard();
    if (storageCard) view.appendChild(storageCard);

    view.appendChild(tools);

    const backBtn = button('imp-linkbtn', 'Add another series', 'Back to adding a series');
    backBtn.addEventListener('click', function () { showView('add'); });
    view.appendChild(backBtn);

    parent.appendChild(view);
    ui.manageView = view;
    ui.usageBox = usage;
    ui.manageList = list;
    ui.toolStatus = toolStatus;
  }

  // ── Performance row (PLAN.md §4.1 — the memoryClass escape hatch) ─────────
  //
  // Platform.memoryClass() guesses the device tier from hardware signals; this
  // is the visible override for anything it misjudges. The pref is validated
  // on read (here and in platform.js), and tuning() is consumed at session
  // start, so a change takes hold the next time a reader opens.

  const MEMORY_CLASSES = [
    { id: 'auto', label: 'Auto' },
    { id: 'low',  label: 'Low' },
    { id: 'mid',  label: 'Mid' },
    { id: 'high', label: 'High' },
  ];

  function readMemoryClassPref() {
    let v = null;
    try {
      const S = store();
      if (S && S.prefs && typeof S.prefs.get === 'function') v = S.prefs.get('platform.memoryClass', 'auto');
    } catch (e) { v = null; }
    return (v === 'low' || v === 'mid' || v === 'high') ? v : 'auto';
  }

  function buildPerformanceCard() {
    const card = el('div', 'imp-card');
    const head = el('div', 'imp-card-head');
    head.appendChild(icon('gear', 16));
    head.appendChild(el('h3', 'imp-card-title', 'Performance'));
    card.appendChild(head);
    card.appendChild(el('p', 'imp-card-sub',
      'How much the readers keep in memory. Auto sizes the windows to this device; ' +
      'forcing Low helps an older phone the detection misses, and High lets a big tablet keep more pages warm. ' +
      'Takes effect the next time a reader opens.'));

    const seg = el('div', 'imp-segmented imp-perf-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Memory tuning');
    const buttons = {};
    const sync = function () {
      const active = readMemoryClassPref();
      MEMORY_CLASSES.forEach(function (c) {
        const b = buttons[c.id];
        const on = c.id === active;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    };
    MEMORY_CLASSES.forEach(function (c) {
      const b = button('imp-seg', c.label, c.label + ' memory tuning');
      b.dataset.memoryClass = c.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.addEventListener('click', function () {
        try {
          const S = store();
          if (S && S.prefs && typeof S.prefs.set === 'function') S.prefs.set('platform.memoryClass', c.id);
        } catch (e) { console.warn('[Importer] could not save platform.memoryClass'); }
        sync();
      });
      buttons[c.id] = b;
      seg.appendChild(b);
    });
    sync();
    card.appendChild(seg);
    return card;
  }

  // ── Device-storage migration (delegation addendum — manage view) ──────────
  //
  // Web-era archives live in IndexedDB, which iOS may clear under storage
  // pressure. This copies each one into the app's own container — chunked
  // through Platform.archives.migrateBlob, one archive at a time, idempotent —
  // after which chapters also open by native extraction instead of unpacking
  // in the browser. The IndexedDB rows are left in place: Store.deleteBlob
  // removes BOTH backends, so a store-side IDB-only delete is the missing
  // piece for reclaiming that space (flagged in the delivery notes).

  function canMigrate() {
    const P = platform();
    return !!(P && P.isNative && P.archives && typeof P.archives.migrateBlob === 'function');
  }

  function buildStorageCard() {
    if (!canMigrate()) return null;   // web build: the card would be a lie

    const card = el('div', 'imp-card');
    const head = el('div', 'imp-card-head');
    head.appendChild(icon('down', 16));
    head.appendChild(el('h3', 'imp-card-title', 'Device storage'));
    card.appendChild(head);
    card.appendChild(el('p', 'imp-card-sub',
      'Series imported before this version keep their archive in browser storage, which the system can clear under pressure. ' +
      'Moving them into the app’s own storage protects them and lets chapters open without unpacking in the browser.'));

    const status = el('div', 'imp-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    const row = el('div', 'imp-actions imp-actions--start');
    const moveBtn = button('imp-btn', 'Move library to device storage', 'Move imported archives to device storage');
    moveBtn.addEventListener('click', function () { runStorageMigration(moveBtn, status); });
    row.appendChild(moveBtn);
    card.appendChild(row);
    card.appendChild(status);
    return card;
  }

  async function runStorageMigration(btn, status) {
    if (!canMigrate()) return;
    btn.disabled = true;
    setStatus(status, 'busy', 'Checking your archives…');
    try {
      const rows = (await safeStore('listUserSeries', [], [])) || [];
      const withArchives = rows.filter(function (s) { return s && s.archiveKey; });
      let done = 0, moved = 0, failed = 0;
      for (const s of withArchives) {
        done++;
        // getBlob checks the filesystem first, then IndexedDB. Nothing back
        // means the archive is already a native file too large for a bridge
        // read (imported by URI) — exactly the state migration produces, so
        // there is nothing to do for it.
        const blob = await safeStore('getBlob', [s.archiveKey], null);
        if (!blob) continue;
        const label = s.title || s.fileName || 'archive';
        const res = await platform().archives.migrateBlob(s.archiveKey, blob, function (frac) {
          setStatus(status, 'busy',
            'Moving “' + label + '”… (' + done + ' of ' + withArchives.length + ')',
            { done: Math.round(frac * 100), total: 100 });
        });
        if (res) moved++; else failed++;
      }
      if (failed) {
        setStatus(status, 'error',
          failed + ' archive' + (failed === 1 ? '' : 's') + ' could not be moved — the device may be out of space. ' +
          'Moving is safe to retry; finished archives are skipped.');
      } else if (moved) {
        setStatus(status, 'ok', 'Done — ' + moved + ' archive' + (moved === 1 ? '' : 's') + ' now on device storage.');
      } else {
        setStatus(status, 'ok', 'Nothing to move — your archives are already on device storage.');
      }
      renderManage();   // the usage summary shifts once native bytes count
    } catch (e) {
      console.warn('[Importer] storage migration failed', e);
      setStatus(status, 'error', 'The move stopped early. It is safe to try again — finished archives are skipped.');
    } finally {
      btn.disabled = false;
    }
  }

  async function renderManage() {
    ui.heading.textContent = 'Imported series';
    ui.manageList.textContent = '';
    ui.usageBox.textContent = '';
    clearStatus(ui.toolStatus);

    const rows = (await safeStore('listUserSeries', [], [])) || [];
    const est = (await safeStore('estimateUsage', [], { usage: null, quota: null })) || {};

    const summary = el('div', 'imp-usage-row');
    summary.appendChild(el('span', 'imp-usage-main',
      rows.length + (rows.length === 1 ? ' imported series' : ' imported series')));
    if (est.usage != null) {
      const q = est.quota != null ? ' of ' + fmtBytes(est.quota) + ' available' : '';
      summary.appendChild(el('span', 'imp-usage-sub', fmtBytes(est.usage) + ' used on this device' + q));
    } else {
      summary.appendChild(el('span', 'imp-usage-sub', 'This browser does not report a storage estimate.'));
    }
    ui.usageBox.appendChild(summary);

    if (!rows.length) {
      const empty = el('div', 'imp-empty');
      empty.appendChild(el('div', 'imp-empty-title', 'Nothing imported yet'));
      empty.appendChild(el('div', 'imp-empty-body', 'Series you add by link or from a file show up here with what they cost on disk.'));
      ui.manageList.appendChild(empty);
      return;
    }

    for (const s of rows) ui.manageList.appendChild(manageRow(s));
    // Sizes need a read per chapter, so they fill in after first paint rather
    // than holding the whole list hostage.
    rows.forEach(function (s) { measureSeries(s); });
  }

  function manageRow(s) {
    const row = el('div', 'imp-manage-row');
    row.dataset.id = s.id;

    const head = el('div', 'imp-manage-head');
    const titleWrap = el('div', 'imp-manage-titles');
    titleWrap.appendChild(el('div', 'imp-manage-title', s.title || 'Untitled'));

    const sub = el('div', 'imp-manage-sub');
    sub.appendChild(el('span', 'imp-chip imp-chip--soft', typeLabel(s.type)));
    sub.appendChild(el('span', null, (s.chapters || []).length + ' chapters'));
    if (s.importKind === 'url' && s.sourceUrl) sub.appendChild(el('span', null, hostOf(s.sourceUrl)));
    else if (s.fileName) sub.appendChild(el('span', null, s.fileName));
    titleWrap.appendChild(sub);

    const size = el('div', 'imp-manage-size', '…');
    size.id = 'imp-size-' + s.id.replace(/[^a-z0-9]/gi, '');
    size.setAttribute('aria-label', 'Size on disk');

    head.appendChild(titleWrap);
    head.appendChild(size);
    row.appendChild(head);

    const status = el('div', 'imp-status');
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const actions = el('div', 'imp-manage-actions');

    const refresh = button('imp-btn imp-btn--small', 'Check for new chapters', 'Check ' + (s.title || 'this series') + ' for new chapters');
    refresh.appendChild(icon('refresh', 13));
    refresh.addEventListener('click', async function () {
      refresh.disabled = true;
      setStatus(status, 'busy', 'Checking…');
      try {
        const res = await refreshSeries(s.id, {
          onProgress: function (p) { setStatus(status, 'busy', p.message); },
        });
        setStatus(status, 'ok', res.note);
        if (res.added) renderManage();
      } catch (e) {
        setStatus(status, 'error', e.message || 'Could not check for new chapters.');
      } finally {
        refresh.disabled = false;
      }
    });

    const del = button('imp-btn imp-btn--small imp-btn--danger', 'Delete', 'Delete ' + (s.title || 'this series'));
    del.appendChild(icon('trash', 13));
    del.addEventListener('click', function () { confirmDelete(s, row, status); });

    actions.appendChild(refresh);
    actions.appendChild(del);
    row.appendChild(actions);
    row.appendChild(status);
    return row;
  }

  // Deleting takes cached chapters and reading progress with it (Store does
  // that), so the confirmation has to say so rather than just "are you sure".
  function confirmDelete(s, row, status) {
    const existing = row.querySelector('.imp-confirm-delete');
    if (existing) { existing.remove(); return; }

    const box = el('div', 'imp-confirm-delete');
    box.appendChild(el('p', 'imp-confirm-text',
      'Delete “' + (s.title || 'Untitled') + '”? Its downloaded chapters and your reading position go with it. This cannot be undone.'));
    const acts = el('div', 'imp-actions imp-actions--start');
    const no = button('imp-btn imp-btn--ghost imp-btn--small', 'Keep it', 'Keep this series');
    no.addEventListener('click', function () { box.remove(); });
    const yes = button('imp-btn imp-btn--danger imp-btn--small', 'Delete for good', 'Delete this series permanently');
    yes.addEventListener('click', async function () {
      yes.disabled = true;
      box.remove();
      setStatus(status, 'busy', 'Deleting…');
      await safeStore('deleteUserSeries', [s.id], null);
      // Store.deleteBlob removes both backends (IndexedDB row and native
      // archive file); what it cannot know about is this session's hydration
      // state and the extracted page dirs, so those are cleaned here.
      if (s.archiveKey) {
        await safeStore('deleteBlob', [s.archiveKey], null);
        dropArchiveState(s.archiveKey);
      }
      scrubbed.delete(s.id);
      const P = platform();
      if (P && P.archives && typeof P.archives.releasePages === 'function') {
        // Chapter page dirs are laid out as pages/<seriesId>/<chapterId>, so
        // releasing the series id clears every chapter's dir in one call —
        // including dirs left by earlier sessions this registry never saw.
        try { P.archives.releasePages(s.id); } catch (e) { /* already gone */ }
      }
      sessionDeleted = true;   // an empty library after this is intentional, so backups may record it
      try { window.dispatchEvent(new CustomEvent('or:library-changed', { detail: { deleted: s.id } })); } catch (e) {}
      scheduleBackup(BACKUP_CHANGE_DEBOUNCE_MS);   // library shape changed
      renderManage();
    });
    acts.appendChild(no);
    acts.appendChild(yes);
    box.appendChild(acts);
    row.appendChild(box);
    no.focus();
  }

  async function measureSeries(s) {
    const node = document.getElementById('imp-size-' + s.id.replace(/[^a-z0-9]/gi, ''));
    if (!node) return;
    let bytes = 0;
    try {
      const ids = (await safeStore('listCachedChapterIds', [s.id], [])) || [];
      for (const cid of ids) {
        const f = await safeStore('getChapter', [s.id, cid], null);
        // Characters ≈ bytes here: blocks are text and data URLs are ASCII.
        if (f) bytes += JSON.stringify(f).length;
      }
      if (s.archiveKey) {
        const blob = await safeStore('getBlob', [s.archiveKey], null);
        if (blob && typeof blob.size === 'number') bytes += blob.size;
        else if (platform() && platform().isNative && typeof s.fileSize === 'number') {
          // Native archives over 64 MB never come back as blobs (the bridge
          // refuses reads that size); the recorded import size is the honest
          // stand-in. On the web a missing blob really is missing — show it.
          bytes += s.fileSize;
        }
      }
      bytes += JSON.stringify(s).length;
      node.textContent = fmtBytes(bytes);
      node.setAttribute('aria-label', fmtBytes(bytes) + ' on disk');
    } catch (e) {
      node.textContent = '—';
    }
  }

  async function doExport(includeChapters) {
    setStatus(ui.toolStatus, 'busy', 'Collecting your library…');
    try {
      const data = await exportLibrary({ includeChapters: includeChapters });
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'offline-reader-library-' + nowIso().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      setStatus(ui.toolStatus, 'ok',
        'Exported ' + data.series.length + ' series and ' + data.chapters.length + ' cached chapters (' + fmtBytes(json.length) + ').');
    } catch (e) {
      setStatus(ui.toolStatus, 'error', e.message || 'Export failed.');
    }
  }

  async function doImport(file) {
    setStatus(ui.toolStatus, 'busy', 'Reading ' + file.name + '…');
    try {
      const text = await file.text();
      const res = await importLibrary(text);
      setStatus(ui.toolStatus, 'ok',
        'Restored ' + res.series + ' series, ' + res.chapters + ' chapters and ' + res.progress + ' reading positions.');
      renderManage();
    } catch (e) {
      setStatus(ui.toolStatus, 'error', e.message || 'Import failed.');
    }
  }

  // ── View switching ────────────────────────────────────────────────────────

  function showView(name) {
    buildUi();
    ui.addView.hidden = name !== 'add';
    ui.confirmView.hidden = name !== 'confirm';
    ui.manageView.hidden = name !== 'manage';
    ui.manageBtn.hidden = name === 'manage';
    ui.body.scrollTop = 0;

    if (name === 'add') {
      ui.heading.textContent = 'Add a series';
      syncGatewayVisibility();
    }
    if (name === 'confirm') renderConfirm(false);
    if (name === 'manage') renderManage();
  }

  function syncGatewayVisibility() {
    const on = gatewayEnabled();
    ui.linkCard.hidden = !on;
    ui.gatewayOff.hidden = on;
  }

  // ── Interactive flow drivers ──────────────────────────────────────────────

  function cancelActive() {
    if (activeAbort) { try { activeAbort.abort(); } catch (e) {} }
    activeAbort = null;
  }

  async function startUrlImport() {
    buildUi();
    if (!gatewayEnabled()) { syncGatewayVisibility(); return; }

    const raw = ui.urlInput.value.trim();
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : (extractUrl(raw) || raw);
    if (!candidate) {
      setStatus(ui.status, 'error', 'Paste a link first — the address of the series page you read on.');
      ui.urlInput.focus();
      return;
    }
    lastAttemptedUrl = candidate;

    cancelActive();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    activeAbort = ctrl;
    ui.goBtn.disabled = true;

    try {
      const draft = await prepareUrl(candidate, {
        signal: ctrl ? ctrl.signal : undefined,
        onProgress: function (p) {
          setStatus(ui.status, 'busy', p.message, {
            cancel: ctrl ? function () { cancelActive(); } : null,
          });
        },
      });
      activeAbort = null;
      ui.goBtn.disabled = false;
      clearStatus(ui.status);
      currentDraft = draft;
      showView('confirm');
    } catch (e) {
      activeAbort = null;
      ui.goBtn.disabled = false;
      if (isAbort(e)) { setStatus(ui.status, 'info', 'Cancelled.'); return; }
      showImportError(ui.status, e, function () { startUrlImport(); });
    }
  }

  function showImportError(target, e, retryFn) {
    const info = GATEWAY_ERRORS[e.code] || null;
    const retryable = e.retryable != null ? e.retryable : (info ? info.retry : false);
    let detail = e.detail || null;
    if (e.code === 'rate_limited' && e.retryAfter) {
      detail = 'The gateway asked us to wait about ' + e.retryAfter + ' second' + (e.retryAfter === 1 ? '' : 's') + '.';
    }
    setStatus(target, 'error', e.message || 'That import did not work.', {
      detail: detail,
      retry: retryable && typeof retryFn === 'function' ? retryFn : null,
    });
  }

  // Native-first file picking. The <input> stays as the fallback and as the
  // web path; both funnel into startFileImport, so everything downstream is
  // shared. The []-vs-null contract (see nativePick) decides which happens.
  async function pickImportFile() {
    buildUi();
    const picked = await nativePick('.epub,.txt,.text,.md,.cbz,.zip', false);
    if (picked === null) { ui.fileInput.click(); return; }
    if (!picked.length) return;   // cancelled the native sheet — respect it
    startFileImport(picked[0]);
  }

  async function pickLibraryJson(fallbackInput) {
    const picked = await nativePick('.json', false);
    if (picked === null) { fallbackInput.click(); return; }
    if (!picked.length) return;
    const f = await readPicked(picked[0]);
    if (f) { doImport(f); return; }
    setStatus(ui.toolStatus, 'error', 'That file could not be read from the picker. Try choosing it again.');
  }

  async function startFileImport(file) {
    buildUi();
    cancelActive();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    activeAbort = ctrl;

    try {
      const draft = await prepareFile(file, {
        signal: ctrl ? ctrl.signal : undefined,
        onProgress: function (p) {
          setStatus(ui.fileStatus, 'busy', p.message, {
            done: p.done, total: p.total,
            cancel: ctrl ? function () { cancelActive(); } : null,
          });
        },
      });
      activeAbort = null;
      clearStatus(ui.fileStatus);
      currentDraft = draft;
      showView('confirm');
    } catch (e) {
      activeAbort = null;
      if (isAbort(e)) { setStatus(ui.fileStatus, 'info', 'Cancelled.'); return; }
      console.warn('[Importer] file import failed', e);
      setStatus(ui.fileStatus, 'error', e.message || 'That file could not be read.');
    }
  }

  // ── Screen lifecycle ──────────────────────────────────────────────────────

  function openDialog(opts) {
    buildUi();
    const options = opts || {};
    const from = document.body && document.body.dataset ? document.body.dataset.screen : null;
    if (from && from !== SCREEN_ID) returnScreen = from;

    currentDraft = null;
    clearStatus(ui.status);
    clearStatus(ui.fileStatus);
    showView(options.view === 'manage' ? 'manage' : 'add');

    if (typeof options.url === 'string' && options.url) {
      ui.urlInput.value = options.url;
      updateUrlPreview();
    }

    if (typeof window.showScreen === 'function') window.showScreen(SCREEN_ID);
    else ui.root.style.display = 'flex';

    // Focus the thing the user came here to use, but never steal focus on a
    // touch device where it pops the keyboard over the explainer.
    if (gatewayEnabled() && !options.url && window.matchMedia && window.matchMedia('(hover: hover)').matches) {
      try { ui.urlInput.focus(); } catch (e) {}
    }
    return ui.root;
  }

  function close() {
    cancelActive();
    currentDraft = null;
    const C = window.Catalogue;
    if (C && typeof C.goBack === 'function') { C.goBack(); return; }
    if (typeof window.showScreen === 'function') { window.showScreen(returnScreen || 'home-screen'); return; }
    if (ui.root) ui.root.style.display = 'none';
  }

  // ── Public API (ARCHITECTURE §5) ──────────────────────────────────────────

  async function importUrl(url, opts) {
    const options = opts || {};
    const draft = await prepareUrl(url, options);
    return await commitDraft(draft, options.edits || null, options);
  }

  async function importFile(file, opts) {
    const options = opts || {};
    const draft = await prepareFile(file, options);
    return await commitDraft(draft, options.edits || null, options);
  }

  window.Importer = {
    openDialog: openDialog,
    close: close,
    importUrl: importUrl,
    importFile: importFile,
    refreshSeries: refreshSeries,

    // Lazy per-chapter hydration (ARCHITECTURE §5 amendment). The catalogue's
    // resolver calls this for imported-archive rows; the result is
    // session-local and must never be persisted.
    hydrateChapter: hydrateChapter,

    // Extras the manage view uses; useful to an integrator and to tests.
    exportLibrary: exportLibrary,
    importLibrary: importLibrary,
    isGatewayEnabled: gatewayEnabled,

    // §2.2: URL normalization is SHARED, not twinned — sources.js compares
    // this function's output against stored sourceUrl values that this same
    // function produced. It stays in _internals too; promoting it changes no
    // behavior.
    normalizeUrl: normalizeUrl,

    // Pure helpers, exposed so the test page can assert on them directly
    // instead of reverse-engineering ids from the store.
    _internals: {
      normalizeUrl: normalizeUrl,
      seriesIdForUrl: seriesIdForUrl,
      seriesIdForFile: seriesIdForFile,
      extractUrl: extractUrl,
      guessTypeFromUrl: guessTypeFromUrl,
      xhtmlToBlocks: xhtmlToBlocks,
      buildTxtStrategies: buildTxtStrategies,
      prepareFile: prepareFile,
      prepareUrl: prepareUrl,
      commitDraft: commitDraft,
      rehydrateAll: rehydrateAll,
      getDraft: function () { return currentDraft; },
      ui: ui,
    },
  };

  // ── Boot: share-target deep link ──────────────────────────────────────────
  //
  // manifest.json declares a share_target that maps a shared link to ?add= and
  // shared prose to ?text=. Sharing into the PWA should land in this flow, not
  // on the home screen with the link silently dropped.

  function deepLinkUrl() {
    let params;
    try { params = new URLSearchParams(window.location.search); }
    catch (e) { return ''; }
    const direct = params.get('add') || params.get('url') || '';
    if (direct) {
      const found = /^https?:/i.test(direct.trim()) ? direct.trim() : extractUrl(direct);
      if (found) return found;
    }
    const text = params.get('text') || '';
    if (text) {
      const found = extractUrl(text);
      if (found) return found;
    }
    return '';
  }

  function stripDeepLinkParams() {
    // Otherwise a refresh (or the SW replaying start_url) re-triggers the flow.
    try {
      const url = new URL(window.location.href);
      ['add', 'url', 'text', 'title'].forEach(function (k) { url.searchParams.delete(k); });
      window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
    } catch (e) { /* history is unavailable in some embedded contexts */ }
  }

  // Custom-scheme intake (offlinereader://add?url=…) — the native sibling of
  // the ?add= share target above, same parameter names, same rule: land on
  // the confirm screen, never in a headless commit. The heuristics are wrong
  // often enough that skipping the correction screen would salt the library
  // with mistitled series keyed by ids that then cannot change.
  function urlFromDeepLink(raw) {
    let params = null;
    try { params = new URL(String(raw || '')).searchParams; } catch (e) { params = null; }
    if (params) {
      const direct = params.get('url') || params.get('add') || '';
      if (direct) {
        const found = /^https?:/i.test(direct.trim()) ? direct.trim() : extractUrl(direct);
        if (found) return found;
      }
      const text = params.get('text') || '';
      if (text) {
        const found = extractUrl(text);
        if (found) return found;
      }
    }
    // A malformed scheme URL often still carries the target in plain sight.
    return extractUrl(raw);
  }

  function wireAppUrlOpen() {
    const P = platform();
    if (!P || typeof P.onAppUrlOpen !== 'function') return;
    P.onAppUrlOpen(function (rawUrl) {
      const found = urlFromDeepLink(rawUrl);
      if (!found) return;
      // At a cold launch this event can race the catalogue's boot showScreen —
      // one task later, the same trick the web share target uses below.
      setTimeout(function () {
        openDialog({ url: found });
        // The lookup runs normalizeUrl and every gateway validation; the user
        // still confirms before anything is written.
        if (gatewayEnabled()) startUrlImport();
      }, 0);
    });
  }

  function boot() {
    buildUi();
    // Migration shim: strip stale session-local page URLs older builds
    // persisted. Nothing decompresses at boot anymore — chapters hydrate
    // lazily when opened.
    rehydrateAll().catch(function (e) { console.warn('[Importer] page scrub pass failed', e); });

    wireAppUrlOpen();
    wireBackupTriggers();
    offerBackupRestore().catch(function (e) { console.warn('[Importer] backup check failed', e); });

    const shared = deepLinkUrl();
    if (!shared) return;
    stripDeepLinkParams();

    // The catalogue boots on the same DOMContentLoaded and calls showScreen for
    // the home screen; deferring by a task lets it finish, then takes over.
    setTimeout(function () {
      openDialog({ url: shared });
      if (gatewayEnabled()) startUrlImport();
    }, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
