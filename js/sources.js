// Offline Reader — sources. See docs/mobile/PLAN7.md §2.2 / §3 and
// docs/ARCHITECTURE.md §6.6 (the /list endpoint).
//
// A saved-sources shelf plus a browse view that feeds the EXISTING add-by-link
// confirm flow. This module owns two surfaces: the sources screen
// (sources-screen — add, keep, browse) and the contents of the home shelf slot
// (#sources-home-slot — the slot itself is catalogue's fixture, exactly like
// the goals slot). Sources are just bookmarks with superpowers: saving one
// never hits the network, and every network-facing part degrades honestly —
// gateway off means link cards and a plain explainer, never a button that
// cannot work.
//
// Like goals.js, this module OBSERVES the app rather than invading it: the
// home slot is filled from a data-screen MutationObserver (fill on entering
// home-screen — the goals renderSlot mechanism, copied verbatim) plus
// or:prefs / or:library-changed refreshers. Delete this file and the app runs
// exactly as before — the slot stays empty, catalogue's empty-state button is
// simply not rendered, platform's back row falls through to goBack() (§0.5).
//
// Division of labour with the importer (§2.2, deliberate):
//   - URL normalization is SHARED, not twinned: Importer.normalizeUrl (the
//     public promotion of importer.js's one implementation) produces both the
//     urls we save and the sourceUrl values stored on library rows, so the
//     "In library" badge is an equality check, never a re-implementation of
//     id hashing. With Importer absent a minimal local normalize serves
//     save-and-bookmark mode only — no Importer also means no confirm flow,
//     so browse and the badge are off anyway and dedupe merely degrades.
//   - safeImageUrl/imgUrl ARE twins (catalogue's originals are IIFE-private);
//     twin copies kept in sync are the codebase's established pattern for
//     exactly these helpers — see the keep-in-sync note at the definitions.
//
// Persistence is one pref, `sources.saved` (§1.2): ≤ 24 rows of
// { url, title, host, addedAt }, validated on read, invalid entries dropped.
// The cap REFUSES, never evicts — the 25th save gets a toast and the shelf is
// left untouched (no cap in this app silently destroys user data). Only
// http(s) URLs are ever stored; session-local page URLs (blob:,
// capacitor://…) never come near this module (§10).
//
// The XSS boundary is absolute: listing titles, source titles and saved
// names are third-party prose and render via textContent only — this file
// never assigns markup strings to the DOM (the §8.6 grep gate holds it to
// zero exceptions).

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const SCREEN_ID = 'sources-screen';
  const SAVED_KEY = 'sources.saved';   // §1.2 — array ≤ 24, refuse-not-evict
  const MAX_SAVED = 24;
  const TITLE_MAX = 80;                // saved-source title clamp (§1.2)
  const ITEM_TITLE_MAX = 200;          // /list clamps server-side; belt here
  const PAGE_ITEMS = 60;               // /list cap per response; belt here
  const TOAST_MS = 4000;               // the goals/thoughts toast cadence
  const FETCH_TIMEOUT_MS = 20000;      // the worker itself times out at 15 s

  // ── DOM helpers (the goals.js factories — textContent only) ───────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgIcon(shapes, size, opts) {
    const o = opts || {};
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(o.strokeWidth || 2.2));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    shapes.forEach(function (s) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', s[1]);
      svg.appendChild(p);
    });
    return svg;
  }

  const ICONS = {
    back:  [['p', 'M15 18 L9 12 L15 6']],
    close: [['p', 'M18 6 L6 18'], ['p', 'M6 6 L18 18']],
  };

  function iconBtn(label, iconShapes) {
    const b = el('button', 'src-icon-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.appendChild(svgIcon(iconShapes, 20));
    return b;
  }

  // The small diamond glyph of the house family (the home logo, the readers'
  // home button). createElementNS + numeric attributes only — zero content
  // strings, trivially textContent-safe (§0.3).
  function diamondGlyph(size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'currentColor');
    const outer = document.createElementNS(SVG_NS, 'path');
    outer.setAttribute('d', 'M10 3 L16 9.5 L10 16 L4 9.5 Z');
    outer.setAttribute('opacity', '0.45');
    const inner = document.createElementNS(SVG_NS, 'path');
    inner.setAttribute('d', 'M10 6 L13 9.5 L10 13 L7 9.5 Z');
    svg.appendChild(outer);
    svg.appendChild(inner);
    return svg;
  }

  // ── Guarded cross-module access ───────────────────────────────────────────

  function bodyScreen() {
    return (document.body && document.body.dataset && document.body.dataset.screen) || '';
  }

  function prefGet(key, fallback) {
    try {
      if (window.Store && window.Store.prefs) return window.Store.prefs.get(key, fallback);
    } catch (e) { /* prefs down — defaults carry the feature */ }
    return fallback;
  }

  function prefSet(key, value) {
    try {
      if (window.Store && window.Store.prefs) window.Store.prefs.set(key, value);
    } catch (e) {}
  }

  async function askConfirm(opts) {
    try {
      if (window.Platform && typeof window.Platform.confirm === 'function') {
        return !!(await window.Platform.confirm(opts));
      }
    } catch (e) {}
    try { return window.confirm(opts.message || ''); } catch (e) { return false; }
  }

  // ── URL helpers ───────────────────────────────────────────────────────────

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  // Only real web URLs may become hrefs — the catalogue's rule, same reason.
  function safeHttpUrl(url) {
    return (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) ? url.trim() : '';
  }

  // KEEP IN SYNC — the safeImageUrl/imgUrl twins (PLAN.md §8 amendment 13;
  // PLAN7 §11-A13): catalogue.js owns the originals as IIFE-privates, and
  // importer.js:180 / novel-reader.js:193 carry the same twins. Listing
  // covers are third-party data exactly like catalogue covers; refusing
  // exotic schemes here keeps the boundary explicit. Relative paths are
  // refused (the importer variant): a listing item's cover is meaningless
  // relative to this app's origin.
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

  function imgUrl(url) {
    const safe = safeImageUrl(url);
    if (!safe) return '';
    // The /image proxy path — hotlink-protected CDNs need the gateway's
    // Referer; local and data URLs pass straight through inside the helper.
    return window.proxyImageUrl ? window.proxyImageUrl(safe) : safe;
  }

  // Normalization is shared, not twinned (§2.2): the importer's public
  // normalizeUrl is the one implementation — the same function that produced
  // every sourceUrl stored on library rows, so saving, dedupe and the
  // "In library" badge can never drift apart. Both paths THROW on a bad
  // link, with a message fit to show the reader.
  function normalizeSourceUrl(raw) {
    if (window.Importer && typeof window.Importer.normalizeUrl === 'function') {
      return String(window.Importer.normalizeUrl(raw));
    }
    // Importer absent (§0.5): the minimal local normalize — http(s) check,
    // lowercase host, credentials/fragment dropped. It only ever serves
    // save-and-bookmark mode; no Importer also means no confirm flow, so
    // browse and the badge are off anyway and dedupe merely degrades.
    const text = String(raw == null ? '' : raw).trim();
    if (!text) throw new Error('Enter a link first.');
    let u;
    try { u = new URL(text); }
    catch (e) { throw new Error('That does not look like a complete web address.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('Only http:// and https:// links can be saved.');
    }
    if (!u.hostname || u.hostname.indexOf('.') === -1) {
      throw new Error('That link has no site name in it.');
    }
    u.username = '';
    u.password = '';
    u.hash = '';
    const host = u.hostname.toLowerCase() + (u.port ? ':' + u.port : '');
    return u.protocol + '//' + host + u.pathname + u.search;
  }

  // ── Saved sources (pref-backed; validated on read, §1.2) ──────────────────

  function readSaved() {
    let raw = prefGet(SAVED_KEY, []);
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = []; } }
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (let i = 0; i < raw.length && out.length < MAX_SAVED; i++) {
      const s = raw[i];
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url.trim())) continue;
      const url = s.url.trim();
      const host = (typeof s.host === 'string' && s.host.trim())
        ? s.host.trim().slice(0, TITLE_MAX)
        : hostOf(url);
      const title = (typeof s.title === 'string' && s.title.trim())
        ? s.title.trim().slice(0, TITLE_MAX)
        : (host || url);
      const addedAt = typeof s.addedAt === 'string' ? s.addedAt : '';
      out.push({ url: url, title: title, host: host, addedAt: addedAt });
    }
    return out;
  }

  function writeSaved(list) {
    prefSet(SAVED_KEY, list.slice(0, MAX_SAVED));
  }

  // ── Gateway capability ────────────────────────────────────────────────────

  function gw(path, params) {
    try {
      return typeof window.gatewayUrl === 'function' ? window.gatewayUrl(path, params) : null;
    } catch (e) { return null; }
  }

  // §2.2 gateway-off rule: Importer.isGatewayEnabled when the importer is
  // present; otherwise window.gatewayUrl('/list') null means off.
  function gatewayOn() {
    try {
      if (window.Importer && typeof window.Importer.isGatewayEnabled === 'function') {
        return !!window.Importer.isGatewayEnabled();
      }
    } catch (e) {}
    return !!gw('/list');
  }

  // Browsing additionally needs the importer's confirm flow — the deep-link
  // path every listing card feeds (§2.2). Without it, saved sources are
  // honest external links.
  function canBrowse() {
    return gatewayOn() && !!(window.Importer && typeof window.Importer.openDialog === 'function');
  }

  // ── Fetch plumbing ────────────────────────────────────────────────────────

  async function fetchJson(url) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, FETCH_TIMEOUT_MS) : 0;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON — body stays null */ }
      return { status: res.status, body: body };
    } finally {
      clearTimeout(timer);
    }
  }

  // Capability probe (§2.2): once per session, GET /health and cache whether
  // any adapter can list. A failing probe, or /list answering not_found (an
  // old worker without the endpoint), pins canList false for the session.
  const health = { probed: false, canList: false, probing: null };

  function probeHealth() {
    if (health.probed) return Promise.resolve(health.canList);
    if (health.probing) return health.probing;
    const url = gw('/health');
    if (!url) {
      health.probed = true;
      health.canList = false;
      return Promise.resolve(false);
    }
    health.probing = (async function () {
      try {
        const r = await fetchJson(url);
        const det = r.body && Array.isArray(r.body.adapterDetail) ? r.body.adapterDetail
          : (r.body && Array.isArray(r.body.adapters) ? r.body.adapters : []);
        health.canList = det.some(function (a) { return !!(a && a.canList === true); });
      } catch (e) {
        health.canList = false;
      }
      health.probed = true;
      health.probing = null;
      return health.canList;
    })();
    return health.probing;
  }

  // ── Library index (the "In library" badge, §2.2) ──────────────────────────
  //
  // Never re-implement id hashing: compare Importer.normalizeUrl output
  // against the sourceUrl values on listUserSeries rows — the same function
  // that produced those stored values.

  let libIndex = null;   // Map normalized sourceUrl → series id, or null (stale)

  async function refreshLibraryIndex() {
    const map = new Map();
    try {
      if (window.Store && typeof window.Store.listUserSeries === 'function') {
        const rows = (await window.Store.listUserSeries()) || [];
        rows.forEach(function (row) {
          if (row && row.id != null && typeof row.sourceUrl === 'string' && row.sourceUrl) {
            map.set(row.sourceUrl, String(row.id));
          }
        });
      }
    } catch (e) { /* no library — no badges */ }
    libIndex = map;
    return map;
  }

  function inLibrary(itemUrl) {
    if (!libIndex || !libIndex.size) return null;
    if (!(window.Importer && typeof window.Importer.normalizeUrl === 'function')) return null;
    let n;
    try { n = String(window.Importer.normalizeUrl(itemUrl)); } catch (e) { return null; }
    return libIndex.get(n) || null;
  }

  // ── Module state ──────────────────────────────────────────────────────────

  const ui = {};                    // screen element handles
  let view = 'shelf';               // 'shelf' | 'browse'
  let pendingAdd = null;            // { url, host } awaiting a title
  let browse = null;                // { src, items, nextUrl, gen }
  let browseGen = 0;                // stale-response guard
  let toastEl = null;
  let toastTimer = 0;
  let lastScreen = '';
  let returnScreen = 'home-screen';
  let initialized = false;

  // ── Toast (the goals pattern — a plain announcement, not a door) ──────────

  function buildToast() {
    toastEl = el('div', 'src-toast');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.classList.remove('visible');
    }, TOAST_MS);
  }

  // ── Screen DOM ────────────────────────────────────────────────────────────

  function buildScreen() {
    const root = el('div');
    root.id = SCREEN_ID;

    const header = el('div', 'src-header');
    const backBtn = iconBtn('Back', ICONS.back);
    backBtn.addEventListener('click', function () {
      if (view === 'browse') showShelfView();
      else close();
    });
    header.appendChild(backBtn);
    header.appendChild(el('div', 'src-title', 'Sources'));
    root.appendChild(header);

    const body = el('div', 'src-body');

    // — shelf view: explainer + add card + the saved list —
    const shelf = el('div', 'src-view');

    const notice = el('div', 'src-notice');
    notice.hidden = true;
    shelf.appendChild(notice);

    const addCard = el('div', 'src-add');
    addCard.appendChild(el('div', 'src-add-label', 'Add a source'));
    addCard.appendChild(el('p', 'src-add-sub',
      'Paste a link to a site’s browse or catalogue page. A source is a ' +
      'bookmark with superpowers — saving one never touches the network.'));

    const addRow = el('div', 'src-add-row');
    const input = document.createElement('input');
    input.type = 'url';
    input.id = 'src-url-input';
    input.className = 'src-input';
    input.placeholder = 'https://example.org/browse';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Link to a browse or catalogue page');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); requestAdd(); }
    });
    addRow.appendChild(input);
    const addBtn = el('button', 'src-btn src-btn--accent', 'Add');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () { requestAdd(); });
    addRow.appendChild(addBtn);
    addCard.appendChild(addRow);

    // The title mini-form (the novel-reader "+ Save current" idiom): shown
    // after the URL validates, prefilled with the host, optional by design.
    const titleForm = el('div', 'src-title-form');
    titleForm.hidden = true;
    titleForm.appendChild(el('div', 'src-form-label', 'Name it (optional)'));
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'src-input';
    titleInput.maxLength = TITLE_MAX;
    titleInput.autocomplete = 'off';
    titleInput.setAttribute('aria-label', 'Source name');
    titleInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
    });
    titleForm.appendChild(titleInput);
    const formRow = el('div', 'src-form-row');
    const saveBtn = el('button', 'src-btn src-btn--accent', 'Save source');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', function () { commitAdd(); });
    formRow.appendChild(saveBtn);
    const cancelBtn = el('button', 'src-btn', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', function () { cancelAdd(); });
    formRow.appendChild(cancelBtn);
    titleForm.appendChild(formRow);
    addCard.appendChild(titleForm);
    shelf.appendChild(addCard);

    const listHead = el('div', 'src-list-head');
    listHead.appendChild(el('span', 'src-list-label', 'On your shelf'));
    const count = el('span', 'src-list-count', '');
    listHead.appendChild(count);
    shelf.appendChild(listHead);

    const list = el('div', 'src-list');
    shelf.appendChild(list);
    body.appendChild(shelf);

    // — browse view —
    const browseView = el('div', 'src-browse');
    browseView.hidden = true;
    const browseMeta = el('div', 'src-browse-meta', '');
    browseView.appendChild(browseMeta);
    const browseStatus = el('div', 'src-browse-status');
    browseView.appendChild(browseStatus);
    const grid = el('div', 'src-grid');
    browseView.appendChild(grid);
    const moreWrap = el('div', 'src-more-wrap');
    browseView.appendChild(moreWrap);
    body.appendChild(browseView);

    root.appendChild(body);

    ui.root = root;
    ui.headerTitle = header.querySelector('.src-title');
    ui.notice = notice;
    ui.addRow = addRow;
    ui.urlInput = input;
    ui.titleForm = titleForm;
    ui.titleInput = titleInput;
    ui.list = list;
    ui.count = count;
    ui.shelf = shelf;
    ui.browse = browseView;
    ui.browseMeta = browseMeta;
    ui.browseStatus = browseStatus;
    ui.grid = grid;
    ui.moreWrap = moreWrap;

    document.body.appendChild(root);
    if (typeof window.registerScreen === 'function') window.registerScreen(root);
  }

  // ── Shelf view ────────────────────────────────────────────────────────────

  function showShelfView() {
    view = 'shelf';
    browseGen++;                       // orphan any in-flight page fetch
    if (!ui.root) return;
    ui.headerTitle.textContent = 'Sources';
    ui.browse.hidden = true;
    ui.shelf.hidden = false;
    renderShelf();
  }

  function renderShelf() {
    if (!ui.root) return;
    renderModeNotice();
    renderSavedList();
  }

  // Honest capability messaging (§2.2): with the gateway off, name the switch
  // (OR_CONFIG.workerBase) — the #imp-gateway-off card pattern. Nothing
  // pretends to work.
  function renderModeNotice() {
    const n = ui.notice;
    n.textContent = '';
    if (gatewayOn() && canBrowse()) { n.hidden = true; return; }
    n.hidden = false;
    if (!gatewayOn()) {
      n.appendChild(el('div', 'src-notice-title', 'Browsing is switched off here'));
      n.appendChild(el('p', 'src-notice-body',
        'Browsing sources needs the content gateway, which is switched off here ' +
        '(OR_CONFIG.workerBase in js/config.js is empty). Saved sources open as ' +
        'plain links instead of pretending to browse — saving and keeping them ' +
        'works with no gateway at all. Deploying your own takes a few minutes; ' +
        'the steps are in worker/README.md.'));
    } else {
      // Gateway configured but the importer module is absent (§0.5): the
      // confirm flow every listing card needs does not exist, so browsing is
      // off for a different honest reason.
      n.appendChild(el('div', 'src-notice-title', 'Browsing is unavailable'));
      n.appendChild(el('p', 'src-notice-body',
        'Browsing feeds the importer’s add-by-link flow, and the importer ' +
        'module (js/importer.js) is not loaded here. Saved sources open as plain links.'));
    }
  }

  function renderSavedList() {
    const saved = readSaved();
    ui.count.textContent = saved.length + ' of ' + MAX_SAVED;
    const list = ui.list;
    list.textContent = '';

    if (!saved.length) {
      list.appendChild(el('div', 'src-empty',
        'Nothing saved yet. Add a site you trust and it becomes a shelf you can browse from home.'));
      return;
    }

    const browsable = canBrowse();
    saved.forEach(function (s) {
      const row = el('div', 'src-item');

      let main;
      if (browsable) {
        main = el('button', 'src-item-main');
        main.type = 'button';
        main.addEventListener('click', function () { startBrowse(s); });
      } else {
        // Link mode: a plain external link — the browser owns what happens next.
        main = el('a', 'src-item-main');
        const href = safeHttpUrl(s.url);
        if (href) main.href = href;
        main.target = '_blank';
        main.rel = 'noopener';
      }
      const glyph = el('span', 'src-item-glyph');
      glyph.appendChild(diamondGlyph(18));
      main.appendChild(glyph);
      const text = el('span', 'src-item-text');
      text.appendChild(el('span', 'src-item-title', s.title));
      text.appendChild(el('span', 'src-item-host', s.host || hostOf(s.url)));
      main.appendChild(text);
      row.appendChild(main);

      const rm = iconBtn('Remove source', ICONS.close);
      rm.classList.add('src-remove');
      rm.addEventListener('click', function () { removeSource(s); });
      row.appendChild(rm);

      list.appendChild(row);
    });
  }

  // ── Add flow ──────────────────────────────────────────────────────────────

  function requestAdd() {
    if (!ui.root) return;
    let normalized;
    try { normalized = normalizeSourceUrl(ui.urlInput.value); }
    catch (e) { toast(e && e.message ? e.message : 'That link cannot be saved.'); return; }

    const saved = readSaved();
    if (saved.some(function (s) { return s.url === normalized; })) {
      toast('Already on your shelf.');
      return;
    }
    // §1.2 — cap 24 refuses, never evicts. Checked before the title prompt so
    // the reader is never asked to name something that cannot be kept.
    if (saved.length >= MAX_SAVED) {
      toast('Shelf is full — remove a source first.');
      return;
    }

    pendingAdd = { url: normalized, host: hostOf(normalized) };
    ui.addRow.hidden = true;
    ui.titleForm.hidden = false;
    ui.titleInput.value = pendingAdd.host;   // default = host (§2.2)
    try { ui.titleInput.focus(); ui.titleInput.select(); } catch (e) {}
  }

  function commitAdd() {
    if (!pendingAdd) return;
    const saved = readSaved();
    // Re-check against the live pref — it may have changed while the form
    // was open (another tab, a native mirror restore).
    if (saved.length >= MAX_SAVED) {
      toast('Shelf is full — remove a source first.');
      cancelAdd();
      return;
    }
    if (saved.some(function (s) { return s.url === pendingAdd.url; })) {
      toast('Already on your shelf.');
      cancelAdd();
      return;
    }
    const title = String(ui.titleInput.value || '').trim().slice(0, TITLE_MAX);
    saved.push({
      url: pendingAdd.url,
      title: title || pendingAdd.host || pendingAdd.url,
      host: pendingAdd.host,
      addedAt: new Date().toISOString(),
    });
    writeSaved(saved);   // → or:prefs → the list and the home slot re-render
    pendingAdd = null;
    ui.titleForm.hidden = true;
    ui.addRow.hidden = false;
    ui.urlInput.value = '';
    toast('Saved to your shelf.');
  }

  function cancelAdd() {
    pendingAdd = null;
    if (!ui.root) return;
    ui.titleForm.hidden = true;
    ui.addRow.hidden = false;
  }

  async function removeSource(src) {
    const ok = await askConfirm({
      title: 'Remove source',
      message: 'Remove “' + src.title + '” from your shelf? The site itself is untouched.',
      okLabel: 'Remove',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    writeSaved(readSaved().filter(function (s) { return s.url !== src.url; }));
    toast('Source removed.');
  }

  // ── Browse view ───────────────────────────────────────────────────────────

  function showBrowseView(src) {
    view = 'browse';
    if (!ui.root) return;
    ui.headerTitle.textContent = src.title;
    ui.browseMeta.textContent = src.host || hostOf(src.url);
    ui.shelf.hidden = true;
    ui.browse.hidden = false;
    ui.browseStatus.textContent = '';
    ui.grid.textContent = '';
    ui.moreWrap.textContent = '';
  }

  async function startBrowse(src) {
    if (!canBrowse()) return;
    const gen = ++browseGen;
    browse = { src: src, items: [], nextUrl: '', gen: gen };
    showBrowseView(src);
    renderBrowseLoading('Reading the catalogue…');

    const can = await probeHealth();
    if (gen !== browseGen) return;   // navigated on while probing
    if (!can) { renderListUnavailable(); return; }

    fetchPage(src.url, { first: true, gen: gen });
  }

  async function fetchPage(pageUrl, opts) {
    const o = opts || {};
    const gen = o.gen != null ? o.gen : browseGen;
    const url = gw('/list', { url: pageUrl });
    if (!url) { if (gen === browseGen) renderListUnavailable(); return; }

    let r;
    try {
      r = await fetchJson(url);
    } catch (e) {
      if (gen !== browseGen) return;
      if (o.first) renderBrowseError('network');
      else {
        // Keep the grid and the retry path — a failed next page must not
        // cost the reader what is already on screen.
        browse.nextUrl = pageUrl;
        toast('Could not load more — check your connection.');
        renderMoreRow();
      }
      return;
    }
    if (gen !== browseGen) return;   // a newer browse owns the view now

    const b = r.body;
    if (b && b.ok === true && Array.isArray(b.items)) {
      // Belt on the worker's caps (§3.3): ≤ 60 items, titles clamped, only
      // http(s) urls survive — third-party data is validated at the door.
      const items = [];
      b.items.slice(0, PAGE_ITEMS).forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        const itemUrl = safeHttpUrl(String(it.url || ''));
        const title = String(it.title || '').trim().slice(0, ITEM_TITLE_MAX);
        if (!itemUrl || !title) return;
        const item = { url: itemUrl, title: title };
        if (typeof it.cover === 'string' && it.cover) item.cover = it.cover;
        items.push(item);
      });
      if (o.first && !items.length) { renderListUnavailable(); return; }
      browse.items = browse.items.concat(items);
      browse.nextUrl = typeof b.nextUrl === 'string' ? safeHttpUrl(b.nextUrl) : '';
      if (b.source && typeof b.source === 'object' && b.source.title) {
        // The site's own name for itself — third-party, textContent, clamped.
        ui.browseMeta.textContent = String(b.source.title).slice(0, ITEM_TITLE_MAX)
          + ' · ' + (browse.src.host || hostOf(browse.src.url));
      }
      await refreshLibraryIndex();
      if (gen !== browseGen) return;
      ui.browseStatus.textContent = '';
      appendCards(items);
      renderMoreRow();
      return;
    }

    const code = b && b.error ? String(b.error) : '';
    // An old worker without /list answers not_found — listing is off for the
    // whole session, not just this source (§2.2 capability honesty).
    if (r.status === 404 || code === 'not_found') {
      health.probed = true;
      health.canList = false;
      if (o.first) renderListUnavailable();
      else renderMoreRow();   // nextUrl already cleared — the row just ends
      return;
    }
    // The honest 422s: the adapter ran and found nothing, or none claimed
    // the URL. Not a hard error — on the first page, the empty/failure card
    // with real exits; on a later page, the honest end of the catalogue.
    if (code === 'no_adapter' || code === 'list_failed') {
      if (o.first) renderListUnavailable();
      else { toast('That is everything this site would show us.'); renderMoreRow(); }
      return;
    }
    if (o.first) renderBrowseError(code || ('http_' + r.status));
    else {
      browse.nextUrl = pageUrl;   // keep the retry path alive
      toast(errorCopy(code || ('http_' + r.status)));
      renderMoreRow();
    }
  }

  function renderBrowseLoading(msg) {
    ui.browseStatus.textContent = '';
    ui.grid.textContent = '';
    ui.moreWrap.textContent = '';
    const box = el('div', 'src-loading');
    box.appendChild(el('div', 'spinner'));
    box.appendChild(el('div', 'src-loading-text', msg));
    ui.browseStatus.appendChild(box);
  }

  // The honest card (§2.2, copy binding): listing is unavailable for this
  // source — say so, and offer the two real exits.
  function renderListUnavailable() {
    ui.browseStatus.textContent = '';
    ui.grid.textContent = '';
    ui.moreWrap.textContent = '';
    const card = el('div', 'src-honest');
    card.appendChild(el('p', 'src-honest-body',
      'We could not read this site’s catalogue. Open the site, find a series page, and use Add by link.'));
    const row = el('div', 'src-honest-actions');
    const href = safeHttpUrl(browse && browse.src ? browse.src.url : '');
    if (href) {
      const a = el('a', 'src-btn', 'Open site');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      row.appendChild(a);
    }
    if (window.Importer && typeof window.Importer.openDialog === 'function') {
      const b = el('button', 'src-btn src-btn--accent', 'Add by link');
      b.type = 'button';
      b.addEventListener('click', function () { window.Importer.openDialog(); });
      row.appendChild(b);
    }
    card.appendChild(row);
    ui.browseStatus.appendChild(card);
  }

  function errorCopy(kind) {
    if (kind === 'network') return 'The gateway could not be reached — check your connection.';
    if (kind === 'rate_limited' || kind === 'http_429') return 'The gateway is busy — give it a moment and try again.';
    if (kind === 'timeout' || kind === 'http_504') return 'The site took too long to answer.';
    if (kind === 'upstream_error' || kind === 'http_502') return 'The site could not be reached.';
    if (kind === 'blocked_host' || kind === 'http_403') return 'That address is not one the gateway will fetch.';
    if (kind === 'bad_url' || kind === 'http_400') return 'That does not look like a browseable address.';
    return 'The catalogue could not be loaded.';
  }

  // Hard/unexpected failures (never the 422s — those get the honest card):
  // say what happened, offer a retry and the site itself.
  function renderBrowseError(kind) {
    ui.browseStatus.textContent = '';
    ui.grid.textContent = '';
    ui.moreWrap.textContent = '';
    const card = el('div', 'src-honest');
    card.appendChild(el('p', 'src-honest-body', errorCopy(kind)));
    const row = el('div', 'src-honest-actions');
    const retry = el('button', 'src-btn src-btn--accent', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', function () {
      if (browse && browse.src) startBrowse(browse.src);
    });
    row.appendChild(retry);
    const href = safeHttpUrl(browse && browse.src ? browse.src.url : '');
    if (href) {
      const a = el('a', 'src-btn', 'Open site');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      row.appendChild(a);
    }
    card.appendChild(row);
    ui.browseStatus.appendChild(card);
  }

  function generatedCover(wrap, item) {
    if (window.Covers && typeof window.Covers.element === 'function') {
      try {
        wrap.appendChild(window.Covers.element(item.url, { className: 'src-cover-svg' }));
        return;
      } catch (e) { /* fall through to the gradient */ }
    }
    wrap.appendChild(el('div', 'src-cover-ph'));
  }

  function browseCard(item) {
    const card = el('button', 'src-card');
    card.type = 'button';

    const cover = el('div', 'src-card-cover');
    const src = imgUrl(item.cover || '');
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () {
        // A dead cover keeps its slot: swap in the generated artwork.
        img.remove();
        generatedCover(cover, item);
      });
      img.src = src;
      cover.appendChild(img);
    } else {
      generatedCover(cover, item);
    }
    const sid = inLibrary(item.url);
    if (sid) cover.appendChild(el('span', 'src-badge', 'In library'));
    card.appendChild(cover);

    // Third-party title — textContent, clamped in CSS to two lines.
    card.appendChild(el('div', 'src-card-title', item.title));

    card.addEventListener('click', function () {
      // Fresh check at tap time — a commit may have landed since render.
      const id = inLibrary(item.url);
      if (id && window.Catalogue && typeof window.Catalogue.openSeries === 'function') {
        window.Catalogue.openSeries(id);
        return;
      }
      if (window.Importer && typeof window.Importer.openDialog === 'function') {
        window.Importer.openDialog({ url: item.url });
      }
    });
    return card;
  }

  function appendCards(items) {
    items.forEach(function (item) { ui.grid.appendChild(browseCard(item)); });
  }

  // Full re-render of the grid from state — used when badges may have
  // changed (a commit landed). Bounded by what the reader has paged in.
  function renderGridFromState() {
    if (!browse) return;
    ui.grid.textContent = '';
    appendCards(browse.items);
  }

  function renderMoreRow() {
    ui.moreWrap.textContent = '';
    if (!browse || !browse.nextUrl) return;
    const more = el('button', 'src-more', 'More');
    more.type = 'button';
    more.addEventListener('click', function () {
      const next = browse.nextUrl;
      browse.nextUrl = '';
      more.disabled = true;
      more.textContent = 'Loading…';
      fetchPage(next, { first: false, gen: browseGen });
    });
    ui.moreWrap.appendChild(more);
  }

  // ── Home shelf slot (§2.2 — contents sources-owned; the slot is catalogue's)

  function renderSlot() {
    const slot = document.getElementById('sources-home-slot');
    if (!slot) return;   // catalogue builds it at boot; absent on test pages and old shells
    const saved = readSaved();
    const on = gatewayOn();

    // Gateway off + nothing saved → the slot stays invisible (§2.2).
    if (!saved.length && !on) {
      if (slot.firstChild) slot.textContent = '';
      return;
    }

    slot.textContent = '';

    if (!saved.length) {
      // Empty shelf, gateway on: a SINGLE quiet invitation (§2.2) — no
      // section label, no rail, nothing that claims more than it is.
      const add = el('button', 'src-home-add src-home-add--solo');
      add.type = 'button';
      add.appendChild(el('span', 'src-home-add-plus', '+'));
      add.appendChild(el('span', 'src-home-add-text', 'Add an online source'));
      add.addEventListener('click', function () { openScreenForAdd(); });
      slot.appendChild(add);
      return;
    }

    slot.appendChild(el('div', 'home-section-label src-home-label', 'Sources'));

    const rail = el('div', 'src-rail');
    saved.forEach(function (s) {
      const card = el('button', 'src-home-card');
      card.type = 'button';
      const glyph = el('span', 'src-home-glyph');
      glyph.appendChild(diamondGlyph(16));
      card.appendChild(glyph);
      const text = el('span', 'src-home-text');
      text.appendChild(el('span', 'src-home-title', s.title));
      text.appendChild(el('span', 'src-home-host', s.host || hostOf(s.url)));
      card.appendChild(text);
      card.addEventListener('click', function () {
        // Gateway on: straight into the browse view. Off: the screen in
        // link mode — the explainer plus plain external-link rows (§2.2).
        openScreen();
        if (canBrowse()) startBrowse(s);
      });
      rail.appendChild(card);
    });

    const add = el('button', 'src-home-add');
    add.type = 'button';
    add.appendChild(el('span', 'src-home-add-plus', '+'));
    add.appendChild(el('span', 'src-home-add-text', 'Add a source'));
    add.addEventListener('click', function () { openScreenForAdd(); });
    rail.appendChild(add);

    slot.appendChild(rail);
  }

  // ── Navigation (the importer/goals precedent) ─────────────────────────────

  function openScreen() {
    init();
    const from = bodyScreen();
    if (from && from !== SCREEN_ID) returnScreen = from;
    cancelAdd();
    showShelfView();
    if (typeof window.showScreen === 'function') {
      window.showScreen(SCREEN_ID);
    } else if (ui.root) {
      // Standalone (test harness): no screen registry to delegate to.
      ui.root.style.display = 'flex';
      if (document.body && document.body.dataset) document.body.dataset.screen = SCREEN_ID;
    }
  }

  function openScreenForAdd() {
    openScreen();
    // Focus the input the reader came for — but never on a touch device,
    // where the keyboard would pop over the card (the importer precedent).
    try {
      if (ui.urlInput && window.matchMedia && window.matchMedia('(hover: hover)').matches) {
        ui.urlInput.focus();
      }
    } catch (e) {}
  }

  function close() {
    const C = window.Catalogue;
    if (C && typeof C.goBack === 'function') { C.goBack(); return; }
    if (typeof window.showScreen === 'function') { window.showScreen(returnScreen || 'home-screen'); return; }
    if (ui.root) ui.root.style.display = 'none';
  }

  // ── Wiring + init ─────────────────────────────────────────────────────────

  function onScreenMaybeChanged() {
    const s = bodyScreen();
    if (s === lastScreen) return;
    lastScreen = s;
    // The guaranteed first fill (§2.2): catalogue's boot ends in
    // showScreen('home-screen') after ensureDom built the slots, so entering
    // home is the signal that the slot exists — the goals.js mechanism.
    if (s === 'home-screen') renderSlot();
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (bodyScreen() !== SCREEN_ID) return;
    if (view === 'browse') { showShelfView(); return; }
    if (pendingAdd) { cancelAdd(); return; }
    close();
  }

  function wireEvents() {
    // Pref refreshers: our own writes come back through here too, so save/
    // remove never call renderers directly for the slot or the saved list.
    // key === null is the bulk-reload case (a native mirror restore).
    window.addEventListener('or:prefs', function (ev) {
      const d = ev && ev.detail;
      const key = d ? d.key : null;
      if (key !== null && key !== SAVED_KEY) return;
      renderSlot();
      if (ui.root && bodyScreen() === SCREEN_ID && view === 'shelf') renderSavedList();
    });

    // Library changes flip "In library" badges (a commit while browsing) and
    // may change what the slot should show.
    window.addEventListener('or:library-changed', function () {
      renderSlot();
      libIndex = null;
      if (ui.root && view === 'browse' && browse && browse.items.length) {
        const gen = browseGen;
        refreshLibraryIndex().then(function () {
          if (gen !== browseGen) return;   // the view moved on mid-refresh
          renderGridFromState();
        });
      }
    });

    document.addEventListener('keydown', onKeydown);

    if (document.body) {
      const mo = new MutationObserver(function () { onScreenMaybeChanged(); });
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    lastScreen = bodyScreen();
    buildToast();
    buildScreen();
    wireEvents();
    // Harmless when the slot does not exist yet (early-return) — the
    // data-screen observer owns the guaranteed first fill, same as goals.
    renderSlot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  // ── Public API (§2.2 — exactly this surface) ──────────────────────────────

  window.Sources = {
    openScreen: openScreen,
    close: close,
  };
})();
