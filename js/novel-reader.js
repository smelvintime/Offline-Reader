// Offline Reader — light-novel / web-novel text reader.  See docs/ARCHITECTURE.md §4.
//
// Owns:  window.NovelReader, #novel-screen, css/novel.css
//
// ─────────────────────────────────────────────────────────────────────────────
// Why this file is shaped the way it is
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. ANCHORS, NOT SCROLL OFFSETS.
//    Three reading modes, nine typography knobs and an arbitrary viewport all
//    change where a given sentence lands. A pixel offset survives none of them.
//    So the single source of truth for "where the reader is" is
//
//        { chapterId, blockIdx, charInBlock }
//
//    — a semantic cursor into the content model. Every layout-changing event
//    (mode switch, font change, resize, chapter load) follows the same three
//    steps: capture the anchor, mutate the layout, re-derive a position from
//    the anchor. There is exactly one capture function and one restore
//    function; each dispatches on mode. Adding a fourth mode means teaching
//    those two functions about it and nothing else.
//
//    Character precision comes from Range.getClientRects(): a Range around one
//    character reports exactly which column or scroll offset that character
//    landed in. Binary search over a block's characters turns "which character
//    is at the top of the page" into ~10 rect reads.
//
// 2. PAGINATION IS THE BROWSER'S JOB.
//    Paged mode is CSS multi-column with column-width == viewport width and a
//    definite height, which makes the browser lay the chapter out into N
//    columns that overflow horizontally; we clip with overflow:hidden and
//    translate the track. We never split blocks ourselves — hand-splitting
//    prose is how readers end up with orphaned punctuation and broken hyphens.
//
// 3. TEXTCONTENT ONLY.
//    Blocks are third-party data (§1.3, §7.1). Every content string reaches the
//    DOM through textContent or a text node. There is not one innerHTML
//    assignment in this file, and the only markup we build is our own chrome.
//
// 4. THE STYLESHEET IS THE DOM CONTRACT.
//    css/novel.css defines the class names, the theme tokens and the custom
//    properties. This file writes attributes and custom properties on the root;
//    it does not write colours, sizes or spacing. Settings changes are one
//    style write, not a re-render.

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────────

  const SCREEN_ID = 'novel-screen';

  const MODES  = ['paged', 'chapter', 'infinite'];
  const FONTS  = ['serif', 'sans', 'mono', 'literata', 'atkinson', 'dyslexic'];
  const WIDTHS = ['narrow', 'normal', 'wide', 'full'];
  const THEMES = ['dark', 'dim', 'black', 'light', 'cream', 'sepia', 'tan', 'nord', 'forest', 'custom'];
  const PARAS  = ['tight', 'normal', 'loose'];
  const ALIGNS = ['left', 'justify'];

  // Which typefaces need a file fetched before the layout they produce is
  // final. Selecting one has to wait for document.fonts before re-settling, or
  // the anchor is restored against fallback metrics and then the real face
  // arrives and moves it. Keyed by data-font value → CSS family name.
  const WEBFONTS = {
    literata: 'Literata',
    atkinson: 'Atkinson Hyperlegible',
    dyslexic: 'OpenDyslexic',
  };

  // Swatches for the theme grid: [value, label, background, text]. The colours
  // are duplicated from css/novel.css on purpose — a swatch is a *preview*, and
  // reading the real tokens back would mean mounting ten hidden elements to
  // resolve ten sets of custom properties.
  const THEME_SWATCHES = [
    ['dark',   'Dark',   '#0a0a0a', '#e9e9ec'],
    ['dim',    'Dim',    '#1a1b1e', '#dcdce1'],
    ['black',  'Black',  '#000000', '#d6d6da'],
    ['nord',   'Nord',   '#2e3440', '#e0e4ec'],
    ['forest', 'Forest', '#1a2420', '#dbe4de'],
    ['light',  'Light',  '#fbfaf8', '#1c1c1f'],
    ['cream',  'Cream',  '#faf3e3', '#33302a'],
    ['sepia',  'Sepia',  '#f4ecd8', '#43341f'],
    ['tan',    'Tan',    '#e3d2b0', '#3a2c17'],
  ];

  const CUSTOM_DEFAULT = { bg: '#f4ecd8', fg: '#43341f' };

  // Defaults mirror the initial values in css/novel.css so the first paint and
  // the settings sheet agree before anything is persisted.
  const DEFAULTS = {
    mode:       'paged',
    fontFamily: 'serif',
    fontSize:   19,
    lineHeight: 1.65,
    width:      'normal',
    align:      'left',
    theme:      'dark',
    paraSpacing:'normal',
    indent:     false,
    letterSpacing: 0,
    wordSpacing:   0,
    customBg:   CUSTOM_DEFAULT.bg,
    customFg:   CUSTOM_DEFAULT.fg,
  };

  const PREF_KEY = {
    mode: 'novel.mode', fontFamily: 'novel.fontFamily', fontSize: 'novel.fontSize',
    lineHeight: 'novel.lineHeight', width: 'novel.width', align: 'novel.align',
    theme: 'novel.theme', paraSpacing: 'novel.paraSpacing', indent: 'novel.indent',
    letterSpacing: 'novel.letterSpacing', wordSpacing: 'novel.wordSpacing',
    customBg: 'novel.customBg', customFg: 'novel.customFg',
  };

  const FONT_MIN = 14, FONT_MAX = 32, FONT_STEP = 1;
  const LH_MIN = 1.3,  LH_MAX = 2.2,  LH_STEP = 0.05;
  // Letter and word spacing are in em, so they hold their proportion when the
  // text size changes. The ceilings are where prose stops reading as prose.
  const LS_MIN = 0, LS_MAX = 0.24, LS_STEP = 0.01;
  const WS_MIN = 0, WS_MAX = 0.8,  WS_STEP = 0.04;

  const WPM = 230;                 // "N min left" — deliberately slower than the
                                   // catalogue's 250, because that number is a
                                   // promise to the reader, not a boast.
  const COL_GAP = 40;              // px between paginated columns. Non-zero so a
                                   // clipped column cannot bleed a pixel of the
                                   // next page's ink into this one.
  const WINDOW_RADIUS = 2;         // infinite mode keeps 2 chapters either side
  const MAX_STACK     = 12;        // …and at most this many sections in the DOM
  const PROGRESS_MS   = 1000;      // §4: progress writes ≥1 s apart
  const SWIPE_SLOP    = 10;        // px before a touch counts as a drag
  const RUBBER        = 0.34;      // end-of-book drag resistance
  const TURN_MS       = 220;       // upper bound on the flip animation

  const BLOCK_TAGS = { p: 'p', h2: 'h2', h3: 'h3', h4: 'h4', pre: 'pre', ul: 'ul', ol: 'ol' };

  // ─────────────────────────────────────────────────────────────────────────
  // Small helpers
  // ─────────────────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function num(v, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function oneOf(v, list, fallback) { return list.indexOf(v) === -1 ? fallback : v; }

  // Custom-theme colours end up in a CSS custom property, so they are validated
  // to a literal #rrggbb rather than trusted. Anything else — including the
  // shorthand and named colours — is rejected in favour of the default.
  function hexColor(v, fallback) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
  }

  // Perceived lightness of a #rrggbb colour, 0–1. Used only to decide which of
  // two accent colours reads against a custom background.
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function fmtNum(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    const x = Number(n);
    return Number.isInteger(x) ? String(x) : String(x);
  }

  function chapterLabel(ch) {
    if (!ch) return 'Chapter';
    const n = ch.num != null ? 'Ch. ' + fmtNum(ch.num) : '';
    const t = ch.title ? String(ch.title) : '';
    if (n && t) return n + ' · ' + t;
    return n || t || 'Chapter';
  }

  // Only http(s)/data:image/blob/relative may reach an <img src>. Mirrors the
  // same guard in catalogue.js: blocks may arrive from a cached ChapterFile that
  // predates that normalization, so the reader re-checks rather than trusting.
  function safeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
    if (/^https?:/i.test(u)) return u;
    if (/^data:image\//i.test(u)) return u;
    if (/^blob:/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return '';   // some other scheme — drop it
    return u;                                          // relative path
  }

  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  // Store may be absent in a stripped build or a test page; never throw for it.
  function storeGet(key, fallback) {
    try {
      if (!window.Store) return fallback;
      return window.Store.prefs.getFor(state.series && state.series.id, key, fallback);
    } catch (e) { return fallback; }
  }
  function storeSet(key, value) {
    try {
      if (!window.Store) return;
      if (state.series && state.series.id) window.Store.prefs.setFor(state.series.id, key, value);
      else window.Store.prefs.set(key, value);
    } catch (e) { /* prefs are not worth throwing over */ }
  }

  // The canonical text of a block. Used for both character offsets and word
  // counts, and it must equal the element's DOM textContent character-for-
  // character or anchors drift — see the render functions below.
  function blockText(b) {
    if (!b || typeof b !== 'object') return '';
    if (b.t === 'hr') return '';
    if (b.t === 'img') return typeof b.alt === 'string' ? b.alt : '';
    if (Array.isArray(b.items)) return b.items.join('');
    return b.c != null ? String(b.c) : '';
  }

  function countWords(s) {
    const m = String(s || '').trim();
    return m ? m.split(/\s+/).length : 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────

  const state = {
    open: false,
    series: null,
    chapters: [],          // series.chapters, ascending
    chIndex: 0,            // index of the chapter the reader is *in*
    mode: DEFAULTS.mode,
    prefs: Object.assign({}, DEFAULTS),

    stack: [],             // rendered sections, reading order. 1 entry outside infinite.
    loaded: new Map(),     // chapterId → { chapter, blocks, wordCount }
    pending: new Map(),    // chapterId → Promise, de-dupes concurrent resolves

    anchor: { chapterId: null, blockIdx: 0, charInBlock: 0 },
    page: 0,
    pageCount: 1,
    colW: 0,
    pct: 0,

    appending: false,
    suppressSyncUntil: 0,
  };

  const dom = {};          // built once in ensureDom()
  const disposers = [];    // everything close() has to undo
  let built = false;
  let wired = false;
  let sheetOpen = false;
  let dividerIO = null;
  let tailIO = null;
  let resizeObs = null;
  let scrollRaf = 0;
  let turnTimer = 0;
  let toastTimer = 0;
  let progressTimer = 0;
  let progressDirty = false;
  let lastProgressAt = 0;
  let suppressClickUntil = 0;
  let lastFocus = null;
  let fontToken = 0;              // guards out-of-order webfont settle passes

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    disposers.push(function () { target.removeEventListener(type, fn, opts); });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOM construction — every class name here comes from css/novel.css
  // ─────────────────────────────────────────────────────────────────────────

  function ensureDom() {
    if (built) return;
    built = true;

    const root = el('div');
    root.id = SCREEN_ID;
    root.tabIndex = -1;
    // Deliberately NOT role="application": that switches assistive tech out of
    // browse mode, which is the one mode in which a screen-reader user can
    // actually read a novel.
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Novel reader');

    // ── Viewport / stage / measure / doc ──────────────────────────────────
    const viewport = el('div', 'nv-viewport');
    const stage    = el('div', 'nv-stage');
    const measure  = el('div', 'nv-measure');
    const doc      = el('div', 'nv-doc');
    doc.setAttribute('role', 'document');
    measure.appendChild(doc);
    stage.appendChild(measure);
    viewport.appendChild(stage);
    root.appendChild(viewport);

    // ── Tap zones (paged mode only; CSS hides them elsewhere) ─────────────
    const zones = el('div', 'nv-zones');
    const zPrev = el('button', 'nv-zone nv-zone-prev');
    const zMid  = el('button', 'nv-zone nv-zone-mid');
    const zNext = el('button', 'nv-zone nv-zone-next');
    zPrev.type = zMid.type = zNext.type = 'button';
    zPrev.setAttribute('aria-label', 'Previous page');
    zMid.setAttribute('aria-label', 'Show or hide reader controls');
    zNext.setAttribute('aria-label', 'Next page');
    zones.append(zPrev, zMid, zNext);
    root.appendChild(zones);

    // ── Header ────────────────────────────────────────────────────────────
    const header = el('header', 'nv-header');
    const back = iconBtn('Close reader', 'back');
    const titles = el('div', 'nv-titles');
    const title = el('span', 'nv-title');
    const subtitle = el('span', 'nv-subtitle');
    titles.append(title, subtitle);
    const settingsBtn = iconBtn('Reading settings', 'aa');
    settingsBtn.setAttribute('aria-expanded', 'false');
    header.append(back, titles, settingsBtn);
    root.appendChild(header);

    // ── Footer ────────────────────────────────────────────────────────────
    const footer = el('footer', 'nv-footer');
    const prevCh = iconBtn('Previous chapter', 'prev');
    const nextCh = iconBtn('Next chapter', 'next');
    const status = el('div', 'nv-status');
    const statusLine = el('div', 'nv-status-line');
    statusLine.setAttribute('aria-live', 'polite');
    const bar = el('div', 'nv-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Progress through this chapter');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.appendChild(el('i'));
    status.append(statusLine, bar);
    footer.append(prevCh, status, nextCh);
    root.appendChild(footer);

    // ── Scrim + settings sheet ────────────────────────────────────────────
    const scrim = el('div', 'nv-scrim');
    scrim.hidden = true;
    root.appendChild(scrim);

    const sheet = buildSheet();
    root.appendChild(sheet);

    // ── Toast ─────────────────────────────────────────────────────────────
    const toast = el('div', 'nv-toast');
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    root.appendChild(toast);

    document.body.appendChild(root);

    Object.assign(dom, {
      root, viewport, stage, measure, doc,
      zones, zPrev, zMid, zNext,
      header, back, title, subtitle, settingsBtn,
      footer, prevCh, nextCh, statusLine, bar,
      scrim, sheet, toast,
    });

    // A zero-height marker pinned to the end of the document. Infinite mode
    // watches it with an IntersectionObserver instead of doing scroll maths.
    dom.tail = el('div');
    dom.tail.style.cssText = 'height:1px;width:100%;pointer-events:none;';
    dom.tail.setAttribute('aria-hidden', 'true');

    // Registered exactly once. The element outlives close() on purpose: a
    // detached node left in reader.js's screen set would leak one per chapter.
    if (typeof window.registerScreen === 'function') window.registerScreen(root);
  }

  // Static, author-controlled SVG. Never called with catalogue data — the
  // paths below are the only markup this module creates.
  const ICON_PATHS = {
    back: 'M15 18 L9 12 L15 6',
    prev: 'M15 18 L9 12 L15 6',
    next: 'M9 18 L15 12 L9 6',
    close:'M18 6 L6 18 M6 6 L18 18',
  };

  function iconBtn(label, kind) {
    const b = el('button', 'nv-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    if (kind === 'aa') {
      // The universal "typography" affordance reads better as glyphs than as a
      // line-art icon, and it needs no <path> at all.
      const s = el('span', null, 'Aa');
      s.setAttribute('aria-hidden', 'true');
      s.style.fontSize = '0.95rem';
      s.style.fontWeight = '700';
      b.appendChild(s);
      return b;
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[kind] || ICON_PATHS.next);
    svg.appendChild(path);
    b.appendChild(svg);
    return b;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Settings sheet
  //
  // Every control writes a pref and then calls applyPrefs(), which sets an
  // attribute or a custom property on the root element. Nothing here re-renders
  // the prose; the only follow-up work is re-deriving the reading position.
  // ─────────────────────────────────────────────────────────────────────────

  const sheetSync = [];   // fn(prefs) → refresh a control from state

  function buildSheet() {
    const sheet = el('aside', 'nv-sheet');
    sheet.hidden = true;
    // The stylesheet keeps [hidden] sheets displayed (translated off-screen) so
    // they can animate, which means `hidden` alone does not remove them from the
    // tab order. `inert` does.
    sheet.inert = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Reading settings');

    const head = el('div', 'nv-sheet-head');
    head.appendChild(el('h2', null, 'Reading settings'));
    const closeBtn = iconBtn('Close settings', 'close');
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    const body = el('div', 'nv-sheet-body');
    sheet.appendChild(body);

    body.appendChild(segRow('Reading mode', [
      { value: 'paged',    label: 'Paged' },
      { value: 'chapter',  label: 'Scroll' },
      { value: 'infinite', label: 'Endless' },
    ], function () { return state.mode; }, function (v) { setMode(v); }));

    body.appendChild(themeRow());

    body.appendChild(segRow('Typeface', [
      { value: 'serif',    label: 'Serif',    note: 'System' },
      { value: 'sans',     label: 'Sans',     note: 'System' },
      { value: 'mono',     label: 'Mono',     note: 'System' },
      { value: 'literata', label: 'Literata', note: 'For long reading' },
      { value: 'atkinson', label: 'Atkinson', note: 'High legibility' },
      { value: 'dyslexic', label: 'OpenDyslexic', note: 'Dyslexia-friendly' },
    ], function () { return state.prefs.fontFamily; }, function (v) { setPref('fontFamily', v, true); },
       { className: 'nv-seg-fonts', preview: true }));

    body.appendChild(stepRow('Text size', {
      get:  function () { return state.prefs.fontSize; },
      fmt:  function (v) { return v + ' px'; },
      dec:  function () { setPref('fontSize', clamp(state.prefs.fontSize - FONT_STEP, FONT_MIN, FONT_MAX), true); },
      inc:  function () { setPref('fontSize', clamp(state.prefs.fontSize + FONT_STEP, FONT_MIN, FONT_MAX), true); },
      label: 'Text size',
    }));

    body.appendChild(stepRow('Line height', {
      get:  function () { return state.prefs.lineHeight; },
      fmt:  function (v) { return v.toFixed(2); },
      dec:  function () { setPref('lineHeight', round2(clamp(state.prefs.lineHeight - LH_STEP, LH_MIN, LH_MAX)), true); },
      inc:  function () { setPref('lineHeight', round2(clamp(state.prefs.lineHeight + LH_STEP, LH_MIN, LH_MAX)), true); },
      label: 'Line height',
    }));

    body.appendChild(segRow('Line width', [
      { value: 'narrow', label: 'Narrow' },
      { value: 'normal', label: 'Normal' },
      { value: 'wide',   label: 'Wide' },
      { value: 'full',   label: 'Full' },
    ], function () { return state.prefs.width; }, function (v) { setPref('width', v, true); }));

    body.appendChild(segRow('Alignment', [
      { value: 'left',    label: 'Ragged' },
      { value: 'justify', label: 'Justified' },
    ], function () { return state.prefs.align; }, function (v) { setPref('align', v, true); }));

    body.appendChild(segRow('Paragraph spacing', [
      { value: 'tight',  label: 'Tight' },
      { value: 'normal', label: 'Normal' },
      { value: 'loose',  label: 'Loose' },
    ], function () { return state.prefs.paraSpacing; }, function (v) { setPref('paraSpacing', v, true); }));

    // Loosening letters and words is one of the few typographic changes with
    // evidence behind it for dyslexic readers, and it helps crowded scripts at
    // small sizes generally. Both are in em so they scale with the text size.
    body.appendChild(stepRow('Letter spacing', {
      get:  function () { return state.prefs.letterSpacing; },
      fmt:  function (v) { return v > 0 ? '+' + v.toFixed(2) + ' em' : 'Normal'; },
      dec:  function () { setPref('letterSpacing', round2(clamp(state.prefs.letterSpacing - LS_STEP, LS_MIN, LS_MAX)), true); },
      inc:  function () { setPref('letterSpacing', round2(clamp(state.prefs.letterSpacing + LS_STEP, LS_MIN, LS_MAX)), true); },
      label: 'Letter spacing',
    }));

    body.appendChild(stepRow('Word spacing', {
      get:  function () { return state.prefs.wordSpacing; },
      fmt:  function (v) { return v > 0 ? '+' + v.toFixed(2) + ' em' : 'Normal'; },
      dec:  function () { setPref('wordSpacing', round2(clamp(state.prefs.wordSpacing - WS_STEP, WS_MIN, WS_MAX)), true); },
      inc:  function () { setPref('wordSpacing', round2(clamp(state.prefs.wordSpacing + WS_STEP, WS_MIN, WS_MAX)), true); },
      label: 'Word spacing',
    }));

    // Indent row
    const indentRow = el('div', 'nv-row');
    indentRow.appendChild(el('span', 'nv-row-label', 'Paragraph style'));
    const toggle = el('button', 'nv-toggle');
    toggle.type = 'button';
    toggle.append(el('span', null, 'First-line indent'), el('span', 'nv-pill', 'Off'));
    toggle.addEventListener('click', function () { setPref('indent', !state.prefs.indent, true); });
    indentRow.appendChild(toggle);
    body.appendChild(indentRow);
    sheetSync.push(function (p) {
      toggle.setAttribute('aria-pressed', String(!!p.indent));
      toggle.lastChild.textContent = p.indent ? 'On' : 'Off';
    });

    // Actions
    const actionRow = el('div', 'nv-row');
    actionRow.appendChild(el('span', 'nv-row-label', 'This series'));
    const actions = el('div', 'nv-actions');
    const resetBtn = el('button', null, 'Reset to defaults');
    resetBtn.type = 'button';
    resetBtn.title = 'Forget this series’ overrides and use your defaults';
    resetBtn.addEventListener('click', resetPrefs);
    const applyAllBtn = el('button', null, 'Apply to all series');
    applyAllBtn.type = 'button';
    applyAllBtn.title = 'Make these settings the default for every series';
    applyAllBtn.addEventListener('click', applyPrefsToAll);
    actions.append(resetBtn, applyAllBtn);
    actionRow.appendChild(actions);
    body.appendChild(actionRow);

    // Keyboard help — css hides this whole row on touch-only devices.
    const keyRow = el('div', 'nv-row nv-keys-wrap');
    keyRow.appendChild(el('span', 'nv-row-label', 'Keyboard'));
    const keys = el('div', 'nv-keys');
    [
      ['Next page / scroll down', ['→', 'PgDn', 'Space']],
      ['Previous page / scroll up', ['←', 'PgUp', '⇧ Space']],
      ['Previous / next chapter', ['[', ']']],
      ['Smaller / larger text', ['−', '+']],
      ['Reading settings', ['S']],
      ['Show / hide controls', ['H']],
      ['Close the reader', ['Esc']],
    ].forEach(function (pair) {
      const row = el('div');
      row.appendChild(el('span', null, pair[0]));
      const kbds = el('span');
      pair[1].forEach(function (k, i) {
        if (i) kbds.appendChild(document.createTextNode(' '));
        kbds.appendChild(el('kbd', null, k));
      });
      row.appendChild(kbds);
      keys.appendChild(row);
    });
    keyRow.appendChild(keys);
    keyRow.appendChild(el('p', 'nv-keys-note', 'Shortcuts work whenever the reader has focus.'));
    body.appendChild(keyRow);

    closeBtn.addEventListener('click', function () { closeSheet(); });

    return sheet;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function segRow(label, options, get, set, opts) {
    const o2 = opts || {};
    const row = el('div', 'nv-row');
    row.appendChild(el('span', 'nv-row-label', label));
    const seg = el('div', 'nv-seg' + (o2.className ? ' ' + o2.className : ''));
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    const buttons = options.map(function (o) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.dataset.value = o.value;
      if (o2.preview) {
        // Each option renders in the face it selects — the only honest way to
        // choose a typeface is to look at it. data-font on the button picks up
        // the same --nv-font rules the prose uses.
        b.dataset.font = o.value;
        b.appendChild(el('span', 'nv-font-name', o.label));
        if (o.note) b.appendChild(el('span', 'nv-font-note', o.note));
      } else {
        b.textContent = o.label;
      }
      b.addEventListener('click', function () { set(o.value); });
      seg.appendChild(b);
      return b;
    });
    row.appendChild(seg);
    sheetSync.push(function () {
      const cur = String(get());
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.value === cur)); });
    });
    return row;
  }

  // Themes are colours, so they are chosen by looking at colours. Each swatch
  // paints itself in the palette it selects; the trailing one opens two colour
  // inputs instead.
  function themeRow() {
    const row = el('div', 'nv-row');
    row.appendChild(el('span', 'nv-row-label', 'Theme'));

    const grid = el('div', 'nv-themes');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Theme');

    const buttons = THEME_SWATCHES.map(function (t) {
      const b = el('button', 'nv-swatch');
      b.type = 'button';
      b.dataset.value = t[0];
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', t[1]);
      b.title = t[1];
      b.style.background = t[2];
      b.style.color = t[3];
      b.appendChild(el('span', 'nv-swatch-aa', 'Aa'));
      b.appendChild(el('span', 'nv-swatch-name', t[1]));
      b.addEventListener('click', function () { setPref('theme', t[0], false); });
      grid.appendChild(b);
      return b;
    });

    // Custom sits in the same grid so it reads as one more choice.
    const custom = el('button', 'nv-swatch nv-swatch-custom');
    custom.type = 'button';
    custom.dataset.value = 'custom';
    custom.setAttribute('aria-pressed', 'false');
    custom.setAttribute('aria-label', 'Custom colours');
    custom.title = 'Custom colours';
    custom.appendChild(el('span', 'nv-swatch-aa', 'Aa'));
    custom.appendChild(el('span', 'nv-swatch-name', 'Custom'));
    custom.addEventListener('click', function () { setPref('theme', 'custom', false); });
    grid.appendChild(custom);
    buttons.push(custom);

    row.appendChild(grid);

    // The two pickers. Hidden unless the custom theme is the active one —
    // there is nothing for them to change otherwise.
    const pickers = el('div', 'nv-pickers');
    const bgField = colorField('Background', function () { return state.prefs.customBg; },
      function (v) { setPref('customBg', v, false); });
    const fgField = colorField('Text', function () { return state.prefs.customFg; },
      function (v) { setPref('customFg', v, false); });
    pickers.append(bgField.el, fgField.el);
    row.appendChild(pickers);

    sheetSync.push(function (p) {
      buttons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.value === p.theme));
      });
      custom.style.background = p.customBg;
      custom.style.color = p.customFg;
      pickers.hidden = p.theme !== 'custom';
      bgField.sync();
      fgField.sync();
    });

    return row;
  }

  function colorField(label, get, set) {
    const wrap = el('label', 'nv-picker');
    const input = document.createElement('input');
    input.type = 'color';
    // Safari and Firefox fire `input` continuously while the picker is open,
    // which is what makes the preview live; each one is a cheap style write.
    input.addEventListener('input', function () { set(hexColor(input.value, get())); });
    wrap.append(input, el('span', null, label));
    return {
      el: wrap,
      sync: function () {
        const v = get();
        if (input.value !== v) input.value = v;
      },
    };
  }

  function stepRow(label, cfg) {
    const row = el('div', 'nv-row');
    row.appendChild(el('span', 'nv-row-label', label));
    const step = el('div', 'nv-step');
    const minus = el('button', null, '−');
    const plus  = el('button', null, '+');
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', 'Decrease ' + cfg.label.toLowerCase());
    plus.setAttribute('aria-label', 'Increase ' + cfg.label.toLowerCase());
    const out = el('output');
    out.setAttribute('aria-live', 'polite');
    minus.addEventListener('click', cfg.dec);
    plus.addEventListener('click', cfg.inc);
    step.append(minus, out, plus);
    row.appendChild(step);
    sheetSync.push(function () { out.textContent = cfg.fmt(cfg.get()); });
    return row;
  }

  function syncSheet() { sheetSync.forEach(function (fn) { fn(state.prefs); }); }

  // aria-modal only claims the rest of the screen is unavailable; `inert` makes
  // it true, so Tab and the virtual cursor cannot wander into the prose behind
  // an open sheet.
  function setBackdropInert(on) {
    [dom.viewport, dom.zones, dom.header, dom.footer].forEach(function (n) { if (n) n.inert = !!on; });
  }

  function openSheet() {
    if (sheetOpen) return;
    sheetOpen = true;
    lastFocus = document.activeElement;
    dom.scrim.hidden = false;
    dom.sheet.hidden = false;
    dom.sheet.inert = false;
    setBackdropInert(true);
    dom.settingsBtn.setAttribute('aria-expanded', 'true');
    syncSheet();
    const first = dom.sheet.querySelector('.nv-sheet-head .nv-btn');
    if (first) first.focus();
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    dom.scrim.hidden = true;
    dom.sheet.hidden = true;
    // The sheet stays displayed (the stylesheet translates it off-screen for
    // the animation), so it has to be explicitly removed from the tab order.
    dom.sheet.inert = true;
    setBackdropInert(false);
    dom.settingsBtn.setAttribute('aria-expanded', 'false');
    if (lastFocus && document.contains(lastFocus)) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Preferences → CSS
  // ─────────────────────────────────────────────────────────────────────────

  function readPrefs() {
    const p = {
      mode:        oneOf(storeGet(PREF_KEY.mode, DEFAULTS.mode), MODES, DEFAULTS.mode),
      fontFamily:  oneOf(storeGet(PREF_KEY.fontFamily, DEFAULTS.fontFamily), FONTS, DEFAULTS.fontFamily),
      fontSize:    clamp(Math.round(num(storeGet(PREF_KEY.fontSize, DEFAULTS.fontSize), DEFAULTS.fontSize)), FONT_MIN, FONT_MAX),
      lineHeight:  round2(clamp(num(storeGet(PREF_KEY.lineHeight, DEFAULTS.lineHeight), DEFAULTS.lineHeight), LH_MIN, LH_MAX)),
      width:       oneOf(storeGet(PREF_KEY.width, DEFAULTS.width), WIDTHS, DEFAULTS.width),
      align:       oneOf(storeGet(PREF_KEY.align, DEFAULTS.align), ALIGNS, DEFAULTS.align),
      theme:       oneOf(storeGet(PREF_KEY.theme, DEFAULTS.theme), THEMES, DEFAULTS.theme),
      paraSpacing: oneOf(storeGet(PREF_KEY.paraSpacing, DEFAULTS.paraSpacing), PARAS, DEFAULTS.paraSpacing),
      indent:      !!storeGet(PREF_KEY.indent, DEFAULTS.indent),
      letterSpacing: round2(clamp(num(storeGet(PREF_KEY.letterSpacing, DEFAULTS.letterSpacing), DEFAULTS.letterSpacing), LS_MIN, LS_MAX)),
      wordSpacing:   round2(clamp(num(storeGet(PREF_KEY.wordSpacing, DEFAULTS.wordSpacing), DEFAULTS.wordSpacing), WS_MIN, WS_MAX)),
      customBg:    hexColor(storeGet(PREF_KEY.customBg, DEFAULTS.customBg), DEFAULTS.customBg),
      customFg:    hexColor(storeGet(PREF_KEY.customFg, DEFAULTS.customFg), DEFAULTS.customFg),
    };
    state.prefs = p;
    state.mode = p.mode;
    return p;
  }

  // The only place that touches the root element's presentation. One attribute
  // or custom-property write per knob; the stylesheet does the rest.
  function applyPrefs() {
    const p = state.prefs, r = dom.root;
    r.dataset.mode   = state.mode;
    r.dataset.theme  = p.theme;
    r.dataset.font   = p.fontFamily;
    r.dataset.width  = p.width;
    r.dataset.para   = p.paraSpacing;
    r.dataset.indent = String(!!p.indent);
    r.style.setProperty('--nv-size', p.fontSize + 'px');
    r.style.setProperty('--nv-lh', String(p.lineHeight));
    r.style.setProperty('--nv-align', p.align);
    r.style.setProperty('--nv-track', p.letterSpacing + 'em');
    r.style.setProperty('--nv-word', p.wordSpacing + 'em');

    // Only the custom theme writes colours; the presets own theirs in the
    // stylesheet, and leaving these set would bleed the last custom pair into
    // whichever preset the reader switched to.
    if (p.theme === 'custom') {
      r.style.setProperty('--nv-bg', p.customBg);
      r.style.setProperty('--nv-fg', p.customFg);
      r.dataset.lum = luminance(p.customBg) < 0.4 ? 'dark' : 'light';
    } else {
      r.style.removeProperty('--nv-bg');
      r.style.removeProperty('--nv-fg');
      delete r.dataset.lum;
    }
  }

  // A face that has not downloaded yet lays out with fallback metrics, so a
  // layout computed now is provisional. Resolve once the real file is in, and
  // let the caller re-settle against it.
  //
  // Never rejects: a font that fails to load is a cosmetic problem, and the
  // fallback stack is already on screen.
  function fontReady(family) {
    if (!family || !document.fonts || typeof document.fonts.load !== 'function') {
      return Promise.resolve(false);
    }
    try {
      // The size is arbitrary but required by the shorthand grammar; `load`
      // matches on family and returns the faces it fetched.
      return Promise.all([
        document.fonts.load('400 1em "' + family + '"'),
        document.fonts.load('700 1em "' + family + '"'),
        document.fonts.load('italic 400 1em "' + family + '"'),
      ]).then(function () { return true; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  // `relayout` is false for purely chromatic changes (theme), which cannot move
  // a single glyph and therefore must not pay for a repagination.
  function setPref(key, value, relayout) {
    if (state.prefs[key] === value) return;
    state.prefs[key] = value;
    storeSet(PREF_KEY[key], value);
    const anchor = relayout ? currentAnchor() : null;
    applyPrefs();
    syncSheet();
    if (!relayout) return;
    layout();
    settleLayout(anchor);
    if (key === 'fontFamily') settleWhenFontLands(value);
  }

  // Picking a bundled face lays out twice: once immediately against the
  // fallback, so the reader is never watching a frozen screen while a font
  // downloads, and once when the file lands and the metrics are real. The
  // anchor carries across both, so the sentence being read does not move.
  function settleWhenFontLands(fontValue) {
    const family = WEBFONTS[fontValue];
    if (!family) return;
    const token = ++fontToken;
    fontReady(family).then(function (loaded) {
      // A later change owns the layout now, or the reader has moved on.
      if (!loaded || !state.open || token !== fontToken) return;
      if (state.prefs.fontFamily !== fontValue) return;
      const a = currentAnchor();
      layout();
      settleLayout(a);
    });
  }

  function resetPrefs() {
    try { if (window.Store && state.series) window.Store.prefs.clearFor(state.series.id); } catch (e) {}
    const anchor = currentAnchor();
    const wasMode = state.mode;
    readPrefs();
    applyPrefs();
    syncSheet();
    if (state.mode !== wasMode) rebuildForMode(anchor);
    else layout();
    settleLayout(anchor);
    settleWhenFontLands(state.prefs.fontFamily);
    toast('Reset to your defaults');
  }

  function applyPrefsToAll() {
    try {
      if (!window.Store) return;
      const p = state.prefs;
      window.Store.prefs.set(PREF_KEY.mode, state.mode);
      Object.keys(PREF_KEY).forEach(function (k) {
        if (k !== 'mode') window.Store.prefs.set(PREF_KEY[k], p[k]);
      });
      if (state.series) window.Store.prefs.clearFor(state.series.id);
    } catch (e) { /* ignore */ }
    toast('Applied to all series');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Block rendering — textContent only, always (§1.3, §7.1)
  // ─────────────────────────────────────────────────────────────────────────

  // Returns an element for every block, including ones whose payload we reject,
  // so that blockEls[i] always corresponds to blocks[i]. Anchors are indices;
  // silently dropping a block would shift every anchor after it.
  function renderBlock(b) {
    const t = b && typeof b === 'object' ? b.t : 'p';

    if (t === 'hr') return el('hr');

    if (t === 'img') {
      const fig = el('figure', 'nv-figure');
      const src = safeImageUrl(b.src);
      if (!src) { fig.classList.add('nv-img-failed'); return fig; }
      const img = el('img');
      // Lazy in the scrolling modes, where "near the viewport" means something
      // and deferring is a straight win. Eager in paged mode, where it is not:
      // an illustration on page 7 sits in a column translated far off-screen and
      // clipped, so it never intersects and a lazy image there would simply
      // never load. Pagination also needs the intrinsic height to place the
      // page break correctly, and guessing means repaginating on every arrival.
      img.loading = state.mode === 'paged' ? 'eager' : 'lazy';
      img.decoding = 'async';
      // The alt text becomes a visible caption when there is one, so the image
      // itself is left unlabelled — otherwise a screen reader announces the
      // same sentence twice, once for the img and once for the figcaption.
      img.alt = '';
      // A dead illustration should cost zero layout, not a broken-image glyph.
      img.addEventListener('error', function () { fig.classList.add('nv-img-failed'); onImageSettled(); }, { once: true });
      img.addEventListener('load', onImageSettled, { once: true });
      img.src = window.proxyImageUrl ? window.proxyImageUrl(src) : src;
      fig.appendChild(img);
      if (b.alt) fig.appendChild(el('figcaption', null, b.alt));
      return fig;
    }

    if (t === 'note') {
      // Deliberately not a <p>: `.nv-doc p` out-specifies `.nv-note` on
      // text-indent, so a note rendered as a paragraph would inherit the
      // first-line indent the stylesheet explicitly zeroes out.
      return el('aside', 'nv-note', blockTextOf(b));
    }

    if (t === 'blockquote') {
      const q = el('blockquote');
      q.appendChild(el('p', null, blockTextOf(b)));
      return q;
    }

    if (t === 'ul' || t === 'ol') {
      const list = el(t);
      const items = Array.isArray(b.items) ? b.items : [];
      items.forEach(function (i) { list.appendChild(el('li', null, String(i))); });
      return list;
    }

    // Everything else — including unknown types, per §1.3 — is a paragraph.
    const tag = BLOCK_TAGS[t] || 'p';
    return el(tag, null, blockTextOf(b));
  }

  function blockTextOf(b) { return b && b.c != null ? String(b.c) : ''; }

  // Late-loading images repaginate paged mode and shift scroll modes. Coalesce
  // them into one re-layout so a chapter of twenty plates does not thrash.
  let imgSettleTimer = 0;
  let prefetchTimer = 0;
  function onImageSettled() {
    if (!state.open) return;
    clearTimeout(imgSettleTimer);
    imgSettleTimer = setTimeout(function () {
      if (!state.open) return;
      const anchor = currentAnchor();
      layout();
      settleLayout(anchor);
    }, 120);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Section building
  // ─────────────────────────────────────────────────────────────────────────

  function makeEntry(data) {
    return {
      chapter: data.chapter,
      blocks: data.blocks,
      wordCount: data.wordCount,
      section: null,
      blockEls: [],
      divider: null,
      collapsed: false,
      height: 0,
    };
  }

  function buildSection(entry, indexInStack) {
    const sec = el('section', 'nv-section');
    sec.dataset.chapterId = entry.chapter.id;
    sec.setAttribute('aria-label', chapterLabel(entry.chapter));

    // Infinite mode divides chapters with a rule; it is also the element the
    // IntersectionObserver watches to decide which chapter the reader is in.
    if (state.mode === 'infinite') {
      const div = el('div', 'nv-divider');
      div.appendChild(el('span', null, chapterLabel(entry.chapter)));
      div.dataset.chapterId = entry.chapter.id;
      sec.appendChild(div);
      entry.divider = div;
    } else {
      entry.divider = null;
    }

    entry.section = sec;

    if (entry.collapsed) {
      // Windowed out: an empty box of exactly the height the prose occupied.
      sec.classList.add('nv-collapsed');
      sec.style.height = entry.height + 'px';
      entry.blockEls = [];
      return sec;
    }

    fillSection(entry);
    return sec;
  }

  // Everything inside a section except the divider, which the caller owns
  // because it doubles as the IntersectionObserver target and must survive
  // collapse/expand cycles.
  function fillSection(entry) {
    const sec = entry.section;

    if (state.mode === 'chapter') sec.appendChild(chapterNav(entry, true));

    // Skip our own title when the prose already opens with the same heading —
    // otherwise every chapter starts by saying its name twice.
    const first = entry.blocks[0];
    const dupTitle = first && (first.t === 'h2' || first.t === 'h3') && entry.chapter.title &&
      blockTextOf(first).trim().toLowerCase() === String(entry.chapter.title).trim().toLowerCase();
    if (!dupTitle) {
      const h = el('div', 'nv-chapter-title', chapterLabel(entry.chapter));
      h.setAttribute('role', 'heading');
      h.setAttribute('aria-level', '2');
      sec.appendChild(h);
    }

    entry.blockEls = new Array(entry.blocks.length);
    if (!entry.blocks.length) {
      sec.appendChild(el('p', 'nv-empty', 'This chapter has no text.'));
    } else {
      for (let i = 0; i < entry.blocks.length; i++) {
        const node = renderBlock(entry.blocks[i]);
        node.dataset.b = String(i);
        entry.blockEls[i] = node;
        sec.appendChild(node);
      }
    }

    const idx = chapterIndexOf(entry.chapter.id);
    const isLast = idx >= 0 && idx === state.chapters.length - 1;

    if (state.mode === 'chapter') {
      sec.appendChild(chapterNav(entry, false));
      if (isLast) sec.appendChild(el('div', 'nv-end', 'You have reached the end of this series.'));
    } else if (state.mode === 'infinite' && isLast) {
      sec.appendChild(el('div', 'nv-end', 'You have reached the end of this series.'));
    }
  }

  // Strip a section back to just its divider (if any).
  function emptySection(entry) {
    const sec = entry.section;
    if (!sec) return;
    const keep = entry.divider;
    let node = sec.lastChild;
    while (node) {
      const prev = node.previousSibling;
      if (node !== keep) sec.removeChild(node);
      node = prev;
    }
    entry.blockEls = [];
  }

  // The offline reader's section ornament, rebuilt as DOM. Static and
  // author-controlled — no catalogue data reaches these attributes.
  const RULE_SHAPES = [
    ['path',   { d: 'M90 0L98 8L90 16L82 8L90 0Z', opacity: '0.9' }],
    ['circle', { cx: '60',  cy: '8', r: '2', opacity: '0.5' }],
    ['circle', { cx: '120', cy: '8', r: '2', opacity: '0.5' }],
    ['rect',   { x: '10',  y: '7.5', width: '30', height: '1', opacity: '0.3' }],
    ['rect',   { x: '140', y: '7.5', width: '30', height: '1', opacity: '0.3' }],
  ];

  function geometricRule() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '180');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 180 16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < RULE_SHAPES.length; i++) {
      const tag = RULE_SHAPES[i][0], attrs = RULE_SHAPES[i][1];
      const node = document.createElementNS(NS, tag);
      for (const k in attrs) node.setAttribute(k, attrs[k]);
      svg.appendChild(node);
    }
    return svg;
  }

  // Matches the offline reader's bottom chapter nav —  < | ◆ | >  — rather than
  // a pair of filled buttons. Same glyphs, same monospace, same equal-width
  // columns (which is what keeps the diamond centred), but drawn from the novel
  // reader's own tokens so it follows the sepia/light/black themes.
  function chapterNav(entry, top) {
    const idx = chapterIndexOf(entry.chapter.id);

    // At the head of a chapter the ornament is decoration, not navigation: the
    // reader has just arrived, and the footer already carries prev/next.
    if (top) {
      const rule = el('div', 'nv-rule nv-rule-top');
      rule.setAttribute('aria-hidden', 'true');
      rule.appendChild(geometricRule());
      return rule;
    }

    const nav = el('nav', 'nv-chnav');
    nav.setAttribute('aria-label', 'Chapter navigation');

    const prev = el('button', 'nv-chnav-btn');
    prev.append(el('span', null, '<'), el('span', 'nv-chnav-sep', '|'));
    const mid = el('div', 'nv-chnav-mid');
    mid.setAttribute('aria-hidden', 'true');
    mid.appendChild(geometricRule());
    const next = el('button', 'nv-chnav-btn');
    next.append(el('span', 'nv-chnav-sep', '|'), el('span', null, '>'));

    prev.type = next.type = 'button';
    prev.setAttribute('aria-label', 'Previous chapter');
    next.setAttribute('aria-label', 'Next chapter');
    prev.title = 'Previous chapter';
    next.title = 'Next chapter';
    prev.disabled = idx <= 0;
    next.disabled = idx < 0 || idx >= state.chapters.length - 1;

    // An explicit "previous chapter" lands at its beginning; only *paging*
    // backwards off the first page lands at the previous chapter's end.
    prev.addEventListener('click', function () { goChapter(-1, 'start'); });
    next.addEventListener('click', function () { goChapter(1, 'start'); });

    nav.append(prev, mid, next);
    return nav;
  }

  function chapterIndexOf(id) {
    for (let i = 0; i < state.chapters.length; i++) if (state.chapters[i].id === id) return i;
    return -1;
  }

  function entryFor(id) {
    for (let i = 0; i < state.stack.length; i++) if (state.stack[i].chapter.id === id) return state.stack[i];
    return null;
  }

  function currentEntry() {
    const ch = state.chapters[state.chIndex];
    return (ch && entryFor(ch.id)) || state.stack[0] || null;
  }

  function renderStack() {
    dom.doc.textContent = '';
    for (let i = 0; i < state.stack.length; i++) {
      dom.doc.appendChild(buildSection(state.stack[i], i));
    }
    if (state.mode === 'infinite') {
      dom.doc.appendChild(dom.tail);
      observeInfinite();
    } else {
      teardownInfiniteObservers();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Layout
  // ─────────────────────────────────────────────────────────────────────────

  function layout() {
    if (!state.open) return;
    if (state.mode === 'paged') paginate();
    else {
      const d = dom.doc.style;
      d.height = ''; d.columnWidth = ''; d.columnGap = ''; d.transform = '';
      state.pageCount = 1;
      state.page = 0;
    }
    updateChrome();
  }

  // CSS multi-column pagination. column-width == the measured column box makes
  // the browser lay out exactly one visible column; the rest of the chapter
  // overflows to the right, is clipped by .nv-measure, and we translate the
  // track to bring a given page into view.
  function paginate() {
    const w = Math.max(1, dom.measure.clientWidth);
    const h = Math.max(1, dom.measure.clientHeight);
    state.colW = w;

    const d = dom.doc.style;
    d.height = h + 'px';
    d.columnWidth = w + 'px';
    d.columnGap = COL_GAP + 'px';
    // Hand the column height to the stylesheet so an illustration can never be
    // taller than the page it has to fit on. Leave room for a caption.
    dom.root.style.setProperty('--nv-colh', Math.max(120, h - 28) + 'px');

    const step = w + COL_GAP;
    // Reading scrollWidth forces the reflow we need before measuring.
    let total = dom.doc.scrollWidth;
    // scrollWidth on an overflow:visible multicol has been unreliable across
    // engines; the far edge of the last laid-out box is a second opinion that
    // costs one rect read.
    const lastEl = lastLaidOutElement();
    if (lastEl) {
      const docRect = dom.doc.getBoundingClientRect();
      total = Math.max(total, lastEl.getBoundingClientRect().right - docRect.left);
    }
    state.pageCount = Math.max(1, Math.ceil((total - 1) / step));
    state.page = clamp(state.page, 0, state.pageCount - 1);
    setTranslate(-state.page * step, false);
  }

  function lastLaidOutElement() {
    const sec = dom.doc.lastElementChild;
    if (!sec) return null;
    return sec.lastElementChild || sec;
  }

  function pageStep() { return state.colW + COL_GAP; }

  function setTranslate(x, animate) {
    if (animate && !prefersReducedMotion()) {
      dom.doc.classList.add('nv-animate');
      clearTimeout(turnTimer);
      turnTimer = setTimeout(function () { dom.doc.classList.remove('nv-animate'); }, TURN_MS);
    } else {
      dom.doc.classList.remove('nv-animate');
    }
    dom.doc.style.transform = 'translate3d(' + x + 'px, 0, 0)';
  }

  function gotoPage(p, animate) {
    const next = clamp(p, 0, state.pageCount - 1);
    state.page = next;
    setTranslate(-next * pageStep(), animate !== false);
    syncPosition();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Anchors — the heart of position preservation
  // ─────────────────────────────────────────────────────────────────────────

  function textLengthOf(el) {
    let n = 0;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = w.nextNode())) n += node.nodeValue.length;
    return n;
  }

  // A DOMRect for one character inside an element, or null if it has no box
  // (collapsed whitespace, a hidden node). Ranges are the only way to ask the
  // engine "where did this character actually end up".
  function rectAtChar(root, idx) {
    if (!root) return null;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let seen = 0, node;
    while ((node = w.nextNode())) {
      const len = node.nodeValue.length;
      if (seen + len > idx) {
        const off = clamp(idx - seen, 0, Math.max(0, len - 1));
        const r = document.createRange();
        try {
          r.setStart(node, off);
          r.setEnd(node, Math.min(len, off + 1));
        } catch (e) { return null; }
        const rects = r.getClientRects();
        if (rects.length) return rects[0];
        const b = r.getBoundingClientRect();
        return (b.width || b.height) ? b : null;
      }
      seen += len;
    }
    return null;
  }

  // Binary search for the first character whose rect satisfies `test`. The test
  // is monotonic in reading order for both modes (columns increase to the
  // right, lines increase downward), which is what makes this legal.
  function firstCharMatching(el, test) {
    const total = textLengthOf(el);
    if (total <= 1) return 0;
    let lo = 0, hi = total - 1, best = 0, found = false;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = rectAtChar(el, mid);
      if (r && test(r)) { best = mid; found = true; hi = mid - 1; }
      else lo = mid + 1;
    }
    return found ? best : 0;
  }

  function anchorOf(entry, blockIdx, charInBlock) {
    return {
      chapterId: entry ? entry.chapter.id : state.anchor.chapterId,
      blockIdx: blockIdx | 0,
      charInBlock: charInBlock | 0,
    };
  }

  // Where is the reader right now? Dispatches on mode; both branches answer in
  // the same content-model coordinates.
  function captureAnchor() {
    if (!state.open || !state.stack.length) return null;
    return state.mode === 'paged' ? capturePaged() : captureScroll();
  }

  function capturePaged() {
    const docRect = dom.doc.getBoundingClientRect();
    const start = state.page * pageStep();
    const end = start + state.colW;
    const entry = state.stack[0];
    if (!entry) return null;
    for (let i = 0; i < entry.blockEls.length; i++) {
      const node = entry.blockEls[i];
      if (!node) continue;
      const r = node.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const x0 = r.left - docRect.left, x1 = r.right - docRect.left;
      // A block that spans several columns reports one rect covering all of
      // them, so overlap — not containment — is the right test.
      if (x1 > start + 1 && x0 < end - 1) {
        const ch = firstCharMatching(node, function (cr) {
          return (cr.left - docRect.left) >= start - 1;
        });
        return anchorOf(entry, i, ch);
      }
    }
    return anchorOf(entry, 0, 0);
  }

  function captureScroll() {
    const top = dom.viewport.getBoundingClientRect().top + stagePadTop();
    // If the fold sits inside a collapsed spacer we genuinely cannot say where
    // the reader is — the text is not in the DOM. Returning the first live
    // entry's opening block would be a confident lie, and because the caller
    // persists what we return, it would overwrite a real furthest-read position
    // with block 0. Keep the previous anchor instead; the next scroll into live
    // content re-establishes it honestly.
    for (let s = 0; s < state.stack.length; s++) {
      const e = state.stack[s];
      if (!e.collapsed || !e.section) continue;
      const r = e.section.getBoundingClientRect();
      if (r.top <= top + 1 && r.bottom > top + 1) return state.anchor;
    }
    for (let s = 0; s < state.stack.length; s++) {
      const entry = state.stack[s];
      if (entry.collapsed || !entry.section) continue;
      const sr = entry.section.getBoundingClientRect();
      if (sr.bottom <= top + 1) continue;        // entirely above the fold
      for (let i = 0; i < entry.blockEls.length; i++) {
        const node = entry.blockEls[i];
        if (!node) continue;
        const r = node.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (r.bottom > top + 1) {
          const ch = firstCharMatching(node, function (cr) { return cr.bottom > top + 1; });
          return anchorOf(entry, i, ch);
        }
      }
      return anchorOf(entry, 0, 0);
    }
    const last = state.stack[state.stack.length - 1];
    return last ? anchorOf(last, Math.max(0, last.blockEls.length - 1), 0) : null;
  }

  // The reader's cursor, for code that is about to change the layout under it.
  //
  // Deliberately the *stored* anchor rather than a fresh geometric read. Layout
  // operations chain — four taps on "larger text" is four of them — and a
  // capture between each one re-reads the anchor off the page it was just
  // restored onto. Since restore only guarantees the character is *on* the
  // page, not at its top, that capture keeps snapping back to whichever block
  // owns the top, and the reader drifts a block backwards per tap. Only
  // syncPosition(), which runs when the reader actually moves, may re-capture.
  function currentAnchor() {
    if (state.anchor && state.anchor.chapterId) return state.anchor;
    return captureAnchor() || state.anchor;
  }

  function stagePadTop() {
    // The chrome floats over the prose, so this padding is constant — but it is
    // expressed in rem + env() and only the engine knows what that resolves to.
    const v = parseFloat(getComputedStyle(dom.stage).paddingTop);
    return Number.isFinite(v) ? v : 0;
  }

  // The viewport-space rect the anchor points at, or null when the anchor's
  // chapter is not currently rendered.
  function anchorRect(anchor) {
    if (!anchor) return null;
    const entry = entryFor(anchor.chapterId) || state.stack[0];
    if (!entry || entry.collapsed) return entry && entry.section ? entry.section.getBoundingClientRect() : null;
    const node = entry.blockEls[clamp(anchor.blockIdx, 0, Math.max(0, entry.blockEls.length - 1))];
    if (!node) return entry.section ? entry.section.getBoundingClientRect() : null;
    if (anchor.charInBlock > 0) {
      const r = rectAtChar(node, anchor.charInBlock);
      if (r) return r;
    }
    return node.getBoundingClientRect();
  }

  function restoreAnchor(anchor) {
    if (!anchor || !state.open) return;
    state.anchor = anchor;
    const rect = anchorRect(anchor);
    if (!rect) return;

    if (state.mode === 'paged') {
      const docRect = dom.doc.getBoundingClientRect();
      const x = rect.left - docRect.left;
      state.page = clamp(Math.floor((x + 1) / pageStep()), 0, state.pageCount - 1);
      setTranslate(-state.page * pageStep(), false);
    } else {
      const want = dom.viewport.getBoundingClientRect().top + stagePadTop();
      const delta = rect.top - want;
      if (Math.abs(delta) > 0.5) {
        suppressSync(250);
        dom.viewport.scrollTop = clamp(
          dom.viewport.scrollTop + delta,
          0,
          Math.max(0, dom.viewport.scrollHeight - dom.viewport.clientHeight)
        );
      }
    }
  }

  function suppressSync(ms) { state.suppressSyncUntil = Date.now() + ms; }

  // ─────────────────────────────────────────────────────────────────────────
  // Character offsets ↔ Progress
  // ─────────────────────────────────────────────────────────────────────────

  function prefixChars(entry, blockIdx) {
    let n = 0;
    const lim = Math.min(blockIdx, entry.blocks.length);
    for (let i = 0; i < lim; i++) n += blockText(entry.blocks[i]).length + 1;
    return n;
  }

  function totalChars(entry) {
    if (entry._chars == null) {
      let n = 0;
      for (let i = 0; i < entry.blocks.length; i++) n += blockText(entry.blocks[i]).length + 1;
      entry._chars = Math.max(1, n);
    }
    return entry._chars;
  }

  function charOffsetOf(entry, anchor) {
    if (!entry) return 0;
    return prefixChars(entry, anchor.blockIdx) + Math.max(0, anchor.charInBlock);
  }

  function anchorFromResume(entry, r) {
    const bi = clamp(num(r && r.blockIdx, 0) | 0, 0, Math.max(0, entry.blocks.length - 1));
    const want = num(r && r.charOffset, 0);
    let ch = want - prefixChars(entry, bi);
    if (!(ch >= 0)) ch = 0;
    ch = Math.min(ch, blockText(entry.blocks[bi] || null).length);
    return { chapterId: entry.chapter.id, blockIdx: bi, charInBlock: ch | 0 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chrome
  // ─────────────────────────────────────────────────────────────────────────

  // The chapter the *anchor* lives in. In endless mode the IntersectionObserver
  // and the anchor can disagree for a frame around a boundary; anything derived
  // from the anchor (offsets, percentages) has to use the anchor's own chapter
  // or the persisted record contradicts itself.
  function anchorEntry() {
    return entryFor(state.anchor.chapterId) || currentEntry();
  }

  // How far through the chapter the reader is, as a fraction.
  //
  // The obvious measure — the character offset of the anchor — is wrong at the
  // end, and visibly so: the anchor is the character at the *top* of the
  // viewport, so when the chapter's last line is on screen the anchor is still
  // a full screenful short of the end. On a phone that caps a finished chapter
  // at ~88%. The bar could never fill, and `completed` (which gates advancing
  // to the next chapter on resume) could never fire.
  //
  // So measure the scroll position within the chapter's scrollable range, the
  // way a scrollbar does: 0 when the chapter's first line is at the top of the
  // viewport, 1 when its last line is at the bottom. The end mark is the last
  // *prose* block rather than the section box, so 100% means "you can see the
  // last line", not "you can see the next-chapter buttons".
  //
  // Returns null when the geometry cannot be trusted (not laid out yet, or the
  // chapter is a collapsed spacer); the caller falls back to the character
  // measure, which is a fine approximation everywhere except the last screen.
  function scrollPct(entry) {
    if (!entry || entry.collapsed || !entry.section || !dom.viewport || !dom.stage) return null;
    const vh = dom.viewport.clientHeight;
    if (!(vh > 0)) return null;

    const secRect = entry.section.getBoundingClientRect();
    if (!secRect.height) return null;

    // The readable band is the viewport minus the chrome insets. .nv-stage
    // carries exactly that padding, so at maximum scroll the last line comes to
    // rest on readBottom — measuring against the raw viewport edge instead would
    // leave the bar a footer's height short of full on every chapter.
    const cs = getComputedStyle(dom.stage);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const readH = vh - padTop - padBottom;
    if (!(readH > 0)) return null;

    // The end of the prose, not the end of the section box.
    let endBottom = secRect.bottom;
    const els = entry.blockEls;
    if (els && els.length) {
      for (let i = els.length - 1; i >= 0; i--) {
        if (els[i]) { endBottom = els[i].getBoundingClientRect().bottom; break; }
      }
    }

    const span = (endBottom - secRect.top) - readH;
    // The whole chapter fits in one screen: there is nothing left to read.
    if (!(span > 0)) return 1;

    const readTop = dom.viewport.getBoundingClientRect().top + padTop;
    return clamp((readTop - secRect.top) / span, 0, 1);
  }

  function updateChrome() {
    if (!state.open) return;
    const entry = anchorEntry();
    const ch = entry ? entry.chapter : state.chapters[state.chIndex];

    dom.title.textContent = (state.series && state.series.title) || 'Reading';
    dom.subtitle.textContent = chapterLabel(ch);

    const idx = ch ? chapterIndexOf(ch.id) : -1;
    dom.prevCh.disabled = idx <= 0;
    dom.nextCh.disabled = idx < 0 || idx >= state.chapters.length - 1;

    // Progress within the current chapter. Paged mode counts pages because that
    // is the unit the reader can see; the scroll modes count characters.
    let pct, position;
    if (state.mode === 'paged') {
      pct = state.pageCount > 0 ? (state.page + 1) / state.pageCount : 0;
      position = 'Page ' + (state.page + 1) + ' / ' + state.pageCount;
    } else {
      const geo = scrollPct(entry);
      if (geo != null) {
        pct = geo;
      } else {
        const t = entry ? totalChars(entry) : 1;
        pct = entry ? clamp(charOffsetOf(entry, state.anchor) / t, 0, 1) : 0;
      }
      position = Math.round(pct * 100) + '%';
    }
    state.pct = pct;

    const words = entry ? entry.wordCount : 0;
    const left = Math.max(0, Math.round(words * (1 - pct)));
    const mins = left > 0 ? Math.max(1, Math.round(left / WPM)) : 0;

    // Visually three columns separated by flex gap; for a screen reader that is
    // one run-on string, so the labels and commas are supplied out-of-band.
    // .nv-sr-only is absolutely positioned, so it costs no flex gap.
    dom.statusLine.textContent = '';
    if (idx >= 0) {
      dom.statusLine.append(
        el('span', 'nv-sr-only', 'Chapter '),
        el('span', null, (idx + 1) + ' / ' + state.chapters.length),
        el('span', 'nv-sr-only', ', ')
      );
    }
    dom.statusLine.append(
      el('b', null, position),
      el('span', 'nv-sr-only', ', '),
      el('span', null, mins > 0 ? mins + ' min left' : 'Finished')
    );

    dom.bar.style.setProperty('--nv-pct', String(round4(pct)));
    dom.bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
  }

  function round4(n) { return Math.round(n * 10000) / 10000; }

  function toggleChrome(force) {
    const hide = force === undefined ? !dom.root.classList.contains('nv-chrome-hidden') : !!force;
    dom.root.classList.toggle('nv-chrome-hidden', hide);
  }

  function toast(msg, ms) {
    if (!dom.toast) return;
    dom.toast.textContent = String(msg);
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.hidden = true; }, ms || 2600);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Position sync + progress persistence
  // ─────────────────────────────────────────────────────────────────────────

  // Called after the reader *moves*: turn a page, scroll, change chapter. The
  // anchor is re-derived from what is on screen, because what is on screen is
  // now the truth.
  function syncPosition(write) {
    if (!state.open) return;
    const a = captureAnchor();
    if (a) state.anchor = a;
    updateChrome();
    if (write !== false) scheduleProgress();
  }

  // Called after the *layout* changes underneath a stationary reader: font
  // size, mode, viewport, a late image. Deliberately does NOT re-capture.
  //
  // Re-deriving the anchor here would walk the reader backwards. Restoring puts
  // the anchored character somewhere *on* the new page, not exactly at its top,
  // so a fresh capture returns whatever block owns the top of that page —
  // usually the previous one. Four taps on "larger text" would then rewind four
  // blocks. The anchor is the reader's cursor; only the reader gets to move it.
  function settleLayout(anchor, write) {
    if (!state.open) return;
    restoreAnchor(anchor);
    updateChrome();
    if (write !== false) scheduleProgress();
  }

  function scheduleProgress() {
    progressDirty = true;
    if (progressTimer) return;
    const wait = Math.max(0, PROGRESS_MS - (Date.now() - lastProgressAt));
    progressTimer = setTimeout(function () { progressTimer = 0; flushProgress(); }, wait);
  }

  function flushProgress() {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = 0; }
    if (!progressDirty || !state.open || !state.series || !window.Store) return;
    progressDirty = false;
    lastProgressAt = Date.now();

    const entry = anchorEntry();
    if (!entry) return;
    const ch = entry.chapter;
    const pct = clamp(state.pct, 0, 1);

    // Denormalized fields so "Continue reading" needs exactly one read (§3).
    const patch = {
      seriesTitle:  state.series.title || null,
      seriesType:   state.series.type || null,
      cover:        state.series.cover || null,
      chapterId:    ch.id,
      chapterNum:   ch.num != null ? ch.num : null,
      chapterTitle: ch.title || null,
      chapterCount: state.chapters.length,
      blockIdx:     state.anchor.blockIdx | 0,
      charOffset:   charOffsetOf(entry, state.anchor),
      pct:          round4(pct),
      completed:    pct >= 0.985,
    };
    try {
      const p = window.Store.putProgress(state.series.id, patch);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* progress is best-effort; never break reading over it */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chapter loading
  // ─────────────────────────────────────────────────────────────────────────

  function chapterData(chapter, blocks, wordCount) {
    const list = Array.isArray(blocks) ? blocks : [];
    return {
      chapter: chapter,
      blocks: list,
      wordCount: Number.isFinite(wordCount) ? wordCount
        : list.reduce(function (n, b) { return n + countWords(blockText(b)); }, 0),
    };
  }

  function loadChapter(index) {
    const ch = state.chapters[index];
    if (!ch) return Promise.resolve(null);
    if (state.loaded.has(ch.id)) return Promise.resolve(state.loaded.get(ch.id));
    if (state.pending.has(ch.id)) return state.pending.get(ch.id);
    if (typeof window.resolveChapterContent !== 'function') {
      return Promise.resolve(null);
    }
    const job = Promise.resolve()
      .then(function () { return window.resolveChapterContent(state.series, ch); })
      .then(function (file) {
        if (!file || !Array.isArray(file.blocks) || !file.blocks.length) return null;
        const data = chapterData(ch, file.blocks, file.wordCount);
        state.loaded.set(ch.id, data);
        return data;
      })
      .catch(function (err) {
        console.warn('[NovelReader] chapter load failed', err);
        return null;
      })
      .then(function (r) { state.pending.delete(ch.id); return r; });
    state.pending.set(ch.id, job);
    return job;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  function nextPage() {
    if (state.mode !== 'paged') { scrollByViewport(1); return; }
    if (state.page < state.pageCount - 1) { gotoPage(state.page + 1, true); return; }
    goChapter(1, 'start');
  }

  function prevPage() {
    if (state.mode !== 'paged') { scrollByViewport(-1); return; }
    if (state.page > 0) { gotoPage(state.page - 1, true); return; }
    goChapter(-1, 'end');
  }

  function scrollByViewport(dir) {
    const v = dom.viewport;
    const step = Math.max(120, v.clientHeight - stagePadTop() - 24);
    v.scrollTo({ top: v.scrollTop + dir * step, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  // `where` is 'start' | 'end' — which end of the new chapter to land on.
  function goChapter(delta, where) {
    const idx = state.chIndex + delta;
    if (idx < 0 || idx >= state.chapters.length) {
      toast(delta > 0 ? 'This is the last chapter.' : 'This is the first chapter.');
      return Promise.resolve(false);
    }
    flushProgress();
    return loadChapter(idx).then(function (data) {
      if (!data) {
        toast('Could not load that chapter.');
        return false;
      }
      state.chIndex = idx;
      const entry = makeEntry(data);
      state.stack = [entry];

      // Which end of the new chapter we land on is expressed as an anchor, not
      // as a page number or a scroll offset. That matters: paging backwards
      // into a chapter whose illustrations have not decoded yet would otherwise
      // pin us to "page 8 of 8", and then the reflow when they arrive — now
      // page 8 of 10 — would silently drop the reader two pages short of where
      // they asked to be. Anchored on the last block, the reflow keeps them
      // exactly where they meant to be.
      const lastIdx = Math.max(0, entry.blocks.length - 1);
      state.anchor = (where === 'end')
        ? {
            chapterId: entry.chapter.id,
            blockIdx: lastIdx,
            charInBlock: Math.max(0, blockText(entry.blocks[lastIdx] || null).length - 1),
          }
        : { chapterId: entry.chapter.id, blockIdx: 0, charInBlock: 0 };

      renderStack();
      state.page = 0;
      dom.viewport.scrollTop = 0;
      layout();
      settleLayout(state.anchor);
      if (state.mode === 'infinite') applyWindow();
      prefetchNeighbours();
      return true;
    });
  }

  // Reading forward is the common case, so the next chapter is warmed as soon
  // as the current one is on screen; going backwards is rarer but cheap.
  function prefetchNeighbours() {
    if (typeof window.resolveChapterContent !== 'function') return;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(function () {
      prefetchTimer = 0;
      if (!state.open) return;
      loadChapter(state.chIndex + 1);
    }, 400);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Infinite mode
  // ─────────────────────────────────────────────────────────────────────────

  function teardownInfiniteObservers() {
    if (dividerIO) { dividerIO.disconnect(); dividerIO = null; }
    if (tailIO) { tailIO.disconnect(); tailIO = null; }
  }

  function observeInfinite() {
    teardownInfiniteObservers();
    if (typeof IntersectionObserver !== 'function') return;

    // Which chapter am I in? A thin band just below the header; whichever
    // divider is in it (or last left it upward) names the current chapter.
    dividerIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        const id = e.target.dataset.chapterId;
        const idx = chapterIndexOf(id);
        if (idx < 0) return;
        if (e.isIntersecting) { setCurrentChapter(idx); return; }
        const rb = e.rootBounds;
        if (!rb) return;
        // Left the band upwards → we are inside that chapter.
        // Left it downwards → we scrolled back above its start.
        if (e.boundingClientRect.top < rb.top) setCurrentChapter(idx);
        else if (idx > 0) setCurrentChapter(idx - 1);
      });
    }, { root: dom.viewport, rootMargin: '-8% 0px -84% 0px', threshold: 0 });

    state.stack.forEach(function (entry) { if (entry.divider) dividerIO.observe(entry.divider); });

    // Append-ahead. The 150% bottom margin is the "~1.5 viewports" budget.
    tailIO = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) appendNext();
    }, { root: dom.viewport, rootMargin: '0px 0px 150% 0px', threshold: 0 });
    tailIO.observe(dom.tail);
  }

  function setCurrentChapter(idx) {
    if (idx === state.chIndex) return;
    state.chIndex = idx;
    applyWindow();
    updateChrome();
    scheduleProgress();
    prefetchNeighbours();
  }

  function appendNext() {
    if (state.mode !== 'infinite' || state.appending || !state.open) return;
    const lastEntry = state.stack[state.stack.length - 1];
    if (!lastEntry) return;
    const lastIdx = chapterIndexOf(lastEntry.chapter.id);
    const nextIdx = lastIdx + 1;
    if (lastIdx < 0 || nextIdx >= state.chapters.length) return;

    state.appending = true;
    loadChapter(nextIdx).then(function (data) {
      state.appending = false;
      if (!data || state.mode !== 'infinite' || !state.open) return;
      if (entryFor(data.chapter.id)) return;             // raced with another append
      const entry = makeEntry(data);
      state.stack.push(entry);
      const sec = buildSection(entry, state.stack.length - 1);
      dom.doc.insertBefore(sec, dom.tail);               // never prepend (§4)
      if (dividerIO && entry.divider) dividerIO.observe(entry.divider);
      trimStackFront();
      applyWindow();
      updateChrome();
      // An IntersectionObserver only reports threshold *crossings*: moving the
      // tail further down while it stays inside the margin is silent. Re-observe
      // to force a fresh reading, so a chapter shorter than 1.5 viewports keeps
      // the chain going instead of stalling until the reader scrolls.
      if (tailIO) { tailIO.unobserve(dom.tail); tailIO.observe(dom.tail); }
    });
  }

  // Hard cap on DOM size. Dropping a section outright changes everything below
  // it, so the scroll position is corrected by exactly the height removed.
  function trimStackFront() {
    while (state.stack.length > MAX_STACK) {
      const gone = state.stack.shift();
      if (!gone || !gone.section) continue;
      const h = gone.section.offsetHeight;
      if (gone.divider && dividerIO) dividerIO.unobserve(gone.divider);
      gone.section.remove();
      dom.viewport.scrollTop = Math.max(0, dom.viewport.scrollTop - h);
    }
  }

  // Keep ~5 chapters live around the current one. Dropped ones become
  // fixed-height spacers so neither the scrollbar nor the reader's place moves.
  function applyWindow() {
    if (state.mode !== 'infinite') return;
    const cur = state.stack.findIndex(function (e) { return chapterIndexOf(e.chapter.id) === state.chIndex; });
    if (cur < 0) return;
    const lo = Math.max(0, cur - WINDOW_RADIUS);
    const hi = Math.min(state.stack.length - 1, cur + WINDOW_RADIUS);
    for (let i = 0; i < state.stack.length; i++) {
      const e = state.stack[i];
      const live = i >= lo && i <= hi;
      if (live && e.collapsed) expandEntry(e, i < cur);
      else if (!live && !e.collapsed) collapseEntry(e);
    }
  }

  function collapseEntry(entry) {
    if (entry.collapsed || !entry.section) return;
    // Freeze the height *before* emptying, so the page below does not lurch.
    const h = entry.section.offsetHeight;
    entry.height = h;
    entry.collapsed = true;
    entry.section.style.height = h + 'px';
    entry.section.classList.add('nv-collapsed');
    // The divider stays: it is both the visual marker and the observer target
    // that lets us notice the reader scrolling back into this chapter.
    emptySection(entry);
  }

  function expandEntry(entry, above) {
    if (!entry.collapsed || !entry.section) return;
    const sec = entry.section;
    const before = sec.offsetHeight;
    entry.collapsed = false;
    emptySection(entry);
    fillSection(entry);
    sec.classList.remove('nv-collapsed');
    sec.style.height = '';
    const after = sec.offsetHeight;
    // Content that grows above the fold pushes the reader down; undo that.
    if (above && after !== before) {
      suppressSync(200);
      dom.viewport.scrollTop = Math.max(0, dom.viewport.scrollTop + (after - before));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mode switching
  // ─────────────────────────────────────────────────────────────────────────

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1 || mode === state.mode) return;
    const anchor = currentAnchor();
    flushProgress();
    state.mode = mode;
    state.prefs.mode = mode;
    storeSet(PREF_KEY.mode, mode);
    applyPrefs();
    syncSheet();
    rebuildForMode(anchor);
    settleLayout(anchor);
  }

  // Re-materialise the section stack for the new mode, then put the reader back
  // on the same sentence. Paged and single-chapter scroll hold exactly one
  // chapter; endless keeps a window centred on where the reader actually is.
  function rebuildForMode(anchor) {
    const anchorId = anchor && anchor.chapterId;
    const anchorIdx = anchorId != null ? chapterIndexOf(anchorId) : -1;
    if (anchorIdx >= 0) state.chIndex = anchorIdx;

    if (state.mode === 'infinite') {
      // Keep whatever we already have around the anchor; anything outside the
      // window is dropped rather than turned into a stale spacer, because we
      // are about to re-establish scroll position from the anchor anyway.
      const keep = state.stack.filter(function (e) {
        const i = chapterIndexOf(e.chapter.id);
        return i >= 0 && Math.abs(i - state.chIndex) <= WINDOW_RADIUS;
      });
      keep.forEach(function (e) { e.collapsed = false; e.height = 0; });
      state.stack = keep.length ? keep : rebuildSingle();
    } else {
      state.stack = rebuildSingle();
    }

    dom.viewport.scrollTop = 0;
    state.page = 0;
    renderStack();
    layout();
    restoreAnchor(anchor);
    if (state.mode === 'infinite') applyWindow();
  }

  function rebuildSingle() {
    const ch = state.chapters[state.chIndex];
    const data = ch && state.loaded.get(ch.id);
    if (data) return [makeEntry(data)];
    const existing = state.stack[0];
    return existing ? [makeEntry({ chapter: existing.chapter, blocks: existing.blocks, wordCount: existing.wordCount })] : [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Input
  // ─────────────────────────────────────────────────────────────────────────

  // Split deliberately: everything below lives on `document`, `window` or an
  // observer, so it has to come back off in close(). Listeners on our own
  // elements would be harmless to leave, but keeping them here means there is
  // one list to audit rather than two.
  function wire() {
    if (wired) return;
    wired = true;

    // Tap zones (paged). The zones sit above the prose only in paged mode.
    on(dom.zPrev, 'click', function () { if (!swallowClick()) prevPage(); });
    on(dom.zNext, 'click', function () { if (!swallowClick()) nextPage(); });
    on(dom.zMid,  'click', function () { if (!swallowClick()) toggleChrome(); });

    // Tapping the prose in the scroll modes toggles chrome, but only when it is
    // really a tap: not a text selection, not a control, not a link.
    on(dom.viewport, 'click', function (e) {
      if (state.mode === 'paged') return;
      if (e.target.closest('button, a, input, select, textarea')) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length > 0) return;
      toggleChrome();
    });

    on(dom.back, 'click', function () { api.close(); });
    on(dom.settingsBtn, 'click', function () { sheetOpen ? closeSheet() : openSheet(); });
    on(dom.scrim, 'click', function () { closeSheet(); });
    on(dom.prevCh, 'click', function () { goChapter(-1, 'start'); });
    on(dom.nextCh, 'click', function () { goChapter(1, 'start'); });

    // Keep focus inside the sheet while it is modal.
    on(dom.sheet, 'keydown', function (e) {
      if (e.key !== 'Tab') return;
      const focusable = dom.sheet.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    on(document, 'keydown', onKeyDown);
    on(dom.viewport, 'scroll', onScroll, { passive: true });

    // Swipe / drag-to-turn.
    on(dom.zones, 'pointerdown', onPointerDown);
    on(dom.zones, 'pointermove', onPointerMove);
    on(dom.zones, 'pointerup', onPointerUp);
    on(dom.zones, 'pointercancel', onPointerUp);

    on(document, 'visibilitychange', function () { if (document.hidden) flushProgress(); });
    on(window, 'pagehide', function () { flushProgress(); });

    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(onResize);
      resizeObs.observe(dom.measure);
      disposers.push(function () { if (resizeObs) { resizeObs.disconnect(); resizeObs = null; } });
    } else {
      on(window, 'resize', onResize);
    }
  }

  function unwire() {
    while (disposers.length) {
      const d = disposers.pop();
      try { d(); } catch (e) { /* teardown must not throw */ }
    }
    wired = false;
  }

  function onKeyDown(e) {
    if (!state.open) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typeof e.key !== 'string') return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        if (sheetOpen) closeSheet(); else api.close();
        return;
      case 'ArrowRight': case 'PageDown':
        e.preventDefault(); nextPage(); return;
      case 'ArrowLeft': case 'PageUp':
        e.preventDefault(); prevPage(); return;
      case ' ': case 'Spacebar':
        e.preventDefault(); e.shiftKey ? prevPage() : nextPage(); return;
      case 'ArrowDown':
        if (state.mode === 'paged') { e.preventDefault(); nextPage(); }
        return;
      case 'ArrowUp':
        if (state.mode === 'paged') { e.preventDefault(); prevPage(); }
        return;
      case 'Home':
        e.preventDefault();
        if (state.mode === 'paged') gotoPage(0, false); else dom.viewport.scrollTop = 0;
        return;
      case 'End':
        e.preventDefault();
        if (state.mode === 'paged') gotoPage(state.pageCount - 1, false);
        else dom.viewport.scrollTop = dom.viewport.scrollHeight;
        return;
    }

    switch (e.key.toLowerCase()) {
      case '[': goChapter(-1, 'start'); e.preventDefault(); return;
      case ']': goChapter(1, 'start'); e.preventDefault(); return;
      case '+': case '=':
        setPref('fontSize', clamp(state.prefs.fontSize + FONT_STEP, FONT_MIN, FONT_MAX), true);
        e.preventDefault(); return;
      case '-': case '_':
        setPref('fontSize', clamp(state.prefs.fontSize - FONT_STEP, FONT_MIN, FONT_MAX), true);
        e.preventDefault(); return;
      case 's': sheetOpen ? closeSheet() : openSheet(); e.preventDefault(); return;
      case 'h': toggleChrome(); e.preventDefault(); return;
      case '?': openSheet(); e.preventDefault(); return;
    }
  }

  function onScroll() {
    if (state.mode === 'paged') return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      if (Date.now() < state.suppressSyncUntil) return;
      trackCurrentChapter();
      syncPosition();
    });
  }

  // dividerIO reports threshold *crossings* through a band 8% of the viewport
  // tall. Scroll faster than that band is deep — a flick, a scrollbar drag —
  // and the divider passes it without ever flipping isIntersecting, so the
  // observer stays silent and state.chIndex freezes. That is not cosmetic:
  // applyWindow() then never runs, so sections collapsed behind the reader are
  // never re-filled, and scrolling back lands in an unbounded blank region.
  // Geometry is the source of truth; the observer is just the cheap fast path.
  function trackCurrentChapter() {
    if (state.mode !== 'infinite' || !state.stack.length) return;
    const rootTop = dom.viewport.getBoundingClientRect().top;
    const band = rootTop + dom.viewport.clientHeight * 0.08;
    let best = -1;
    for (let i = 0; i < state.stack.length; i++) {
      const sec = state.stack[i].section;
      if (!sec) continue;
      // The last section whose top is at or above the band is the one being read.
      if (sec.getBoundingClientRect().top <= band) best = i; else break;
    }
    if (best < 0) best = 0;
    const idx = chapterIndexOf(state.stack[best].chapter.id);
    if (idx >= 0) setCurrentChapter(idx);
  }

  let resizeTimer = 0;
  let lastSize = '';
  function onResize() {
    if (!state.open) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!state.open) return;
      const size = dom.measure.clientWidth + 'x' + dom.measure.clientHeight;
      if (size === lastSize) return;
      lastSize = size;
      // The anchor recorded before the resize is the honest one: the geometry
      // on screen right now is already wrong for the new box.
      const anchor = state.anchor;
      layout();
      settleLayout(anchor);
    }, 120);
  }

  // ── Drag-to-turn ────────────────────────────────────────────────────────

  let drag = null;

  function onPointerDown(e) {
    if (state.mode !== 'paged' || !state.open) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, t0: (performance || Date).now(), active: false };
    try { dom.zones.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) < SWIPE_SLOP || Math.abs(dx) <= Math.abs(dy)) return;
      drag.active = true;
      dom.doc.classList.remove('nv-animate');
    }
    drag.dx = resist(dx);
    dom.doc.style.transform = 'translate3d(' + (-state.page * pageStep() + drag.dx) + 'px, 0, 0)';
  }

  // Dragging past the first or last page of the chapter still moves — it just
  // moves reluctantly, which is how a reader learns there is nothing there.
  function resist(dx) {
    const atStart = state.page === 0 && dx > 0;
    const atEnd = state.page >= state.pageCount - 1 && dx < 0;
    const boundary = atStart ? state.chIndex === 0 : (atEnd ? state.chIndex === state.chapters.length - 1 : false);
    if ((atStart || atEnd) && boundary) return dx * RUBBER;
    return dx;
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    try { dom.zones.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!d.active) return;

    suppressClickUntil = Date.now() + 350;
    const dt = Math.max(1, (performance || Date).now() - d.t0);
    const velocity = Math.abs(d.dx) / dt;                       // px/ms
    const threshold = Math.min(96, Math.max(40, state.colW * 0.18));
    const flick = velocity > 0.5 && Math.abs(d.dx) > 24;

    if (d.dx < 0 && (Math.abs(d.dx) > threshold || flick)) nextPage();
    else if (d.dx > 0 && (Math.abs(d.dx) > threshold || flick)) prevPage();
    else setTranslate(-state.page * pageStep(), true);          // spring back
  }

  function swallowClick() {
    if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return true; }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — docs/ARCHITECTURE.md §4
  // ─────────────────────────────────────────────────────────────────────────

  function resetSession() {
    teardownInfiniteObservers();
    clearTimeout(imgSettleTimer);
    clearTimeout(resizeTimer);
    clearTimeout(prefetchTimer); prefetchTimer = 0;
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    state.stack = [];
    state.loaded.clear();
    state.pending.clear();
    state.page = 0;
    state.pageCount = 1;
    state.pct = 0;
    state.appending = false;
    lastSize = '';
    drag = null;
    if (dom.doc) dom.doc.textContent = '';
  }

  const api = {
    /**
     * open({ series, chapter, blocks, resume })
     *   series  : Series   (§1.1)
     *   chapter : Chapter  (§1.1)
     *   blocks  : Block[]  (§1.3) — already resolved by the caller
     *   resume  : { blockIdx, charOffset, pct } | null
     * Returns a Promise that settles once any stored progress has been
     * consulted; the reader is on screen well before it resolves.
     */
    open: function (opts) {
      const o = opts || {};
      if (!o.series || !o.chapter) {
        console.warn('[NovelReader] open() needs a series and a chapter');
        return Promise.resolve(false);
      }
      ensureDom();
      resetSession();
      wire();

      state.open = true;
      state.series = o.series;
      state.chapters = Array.isArray(o.series.chapters) && o.series.chapters.length
        ? o.series.chapters : [o.chapter];
      const idx = chapterIndexOf(o.chapter.id);
      state.chIndex = idx >= 0 ? idx : 0;
      if (idx < 0) state.chapters = [o.chapter];

      // Prefs are per-series and synchronous, so the first paint is already in
      // the right typeface — no flash of the previous book's settings.
      readPrefs();
      applyPrefs();
      closeSheet();
      toggleChrome(false);

      const data = chapterData(o.chapter, o.blocks, o.chapter.wordCount);
      state.loaded.set(o.chapter.id, data);
      const entry = makeEntry(data);
      state.stack = [entry];
      state.anchor = { chapterId: entry.chapter.id, blockIdx: 0, charInBlock: 0 };

      renderStack();
      if (typeof window.showScreen === 'function') window.showScreen(SCREEN_ID);
      else dom.root.style.display = 'block';

      layout();
      dom.viewport.scrollTop = 0;
      lastSize = dom.measure.clientWidth + 'x' + dom.measure.clientHeight;

      // Establish the top-of-chapter position and paint the chrome first, so a
      // reader with no stored progress sees a finished screen immediately.
      syncPosition();
      prefetchNeighbours();
      try { dom.root.focus({ preventScroll: true }); } catch (e) {}

      // Resume is a layout operation, not a reader move: settleLayout, never
      // syncPosition, or the restored cursor is immediately overwritten by
      // whatever block happens to own the top of the page it landed on.
      const applyResume = function (r) {
        if (!state.open || !r) return;
        const cur = entryFor(entry.chapter.id);
        if (!cur) return;
        if (state.mode === 'infinite') applyWindow();
        settleLayout(anchorFromResume(cur, r), false);
      };

      let settled;
      if (o.resume) { applyResume(o.resume); settled = Promise.resolve(); }
      else if (window.Store) {
        settled = Promise.resolve(window.Store.getProgress(o.series.id))
          .then(function (p) {
            // Only resume when the stored row is about *this* chapter.
            if (p && p.chapterId === o.chapter.id) applyResume(p);
          })
          .catch(function () {});
      } else settled = Promise.resolve();

      // Opening with a bundled face persisted means the first layout above ran
      // on fallback metrics. Re-settle once the file is in — after the resume
      // has landed, so it is the reader's real position that gets carried.
      return settled.then(function () {
        settleWhenFontLands(state.prefs.fontFamily);
        return true;
      });
    },

    /**
     * close({ navigate })
     * Tears down every observer, timer and listener this module installed and
     * flushes progress. `navigate` defaults to true, which hands control back
     * to Catalogue (§2.2 — feature modules never call showScreen to go back).
     */
    close: function (opts) {
      const navigate = !opts || opts.navigate !== false;
      if (!state.open) {
        if (navigate) navigateAway();
        return;
      }
      progressDirty = true;
      flushProgress();
      state.open = false;

      closeSheet();
      resetSession();
      unwire();

      clearTimeout(toastTimer);
      clearTimeout(turnTimer);
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = 0; }
      progressDirty = false;

      // The root element stays in the document (hidden) and stays registered:
      // it is one node, and re-registering a fresh one on every chapter would
      // grow reader.js's screen set without bound.
      if (dom.toast) dom.toast.hidden = true;
      if (dom.root) dom.root.style.display = 'none';
      state.series = null;
      state.chapters = [];

      if (navigate) navigateAway();
    },

    isOpen: function () { return !!state.open; },

    /** Read-only diagnostics. Used by test/novel-reader.test.html. */
    state: function () {
      return {
        open: state.open,
        mode: state.mode,
        page: state.page,
        pageCount: state.pageCount,
        pct: state.pct,
        seriesId: state.series ? state.series.id : null,
        chapterIndex: state.chIndex,
        chapterId: state.chapters[state.chIndex] ? state.chapters[state.chIndex].id : null,
        anchor: { chapterId: state.anchor.chapterId, blockIdx: state.anchor.blockIdx, charInBlock: state.anchor.charInBlock },
        sections: state.stack.map(function (e) { return e.chapter.id; }),
        collapsed: state.stack.filter(function (e) { return e.collapsed; }).map(function (e) { return e.chapter.id; }),
        chromeHidden: !!(dom.root && dom.root.classList.contains('nv-chrome-hidden')),
        sheetOpen: sheetOpen,
        prefs: Object.assign({}, state.prefs),
      };
    },
  };

  function navigateAway() {
    if (window.Catalogue && typeof window.Catalogue.goBack === 'function') window.Catalogue.goBack();
    else if (typeof window.showScreen === 'function') window.showScreen('home-screen');
  }

  window.NovelReader = api;
})();
