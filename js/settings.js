// Offline Reader — app settings: shell theme engine, focus, home layout.
// See docs/mobile/PLAN7.md §2.1, §2.9, §2.12 and docs/ARCHITECTURE.md.
//
// Three jobs live here, all of them "defaults the reader can change":
//
//   1. THE THEME ENGINE. The shell (home, series, importer, goals, sources,
//      thoughts and this screen) follows `app.theme` — nine named palettes
//      reusing the novel reader's exact bg/fg/accent triples, plus a
//      two-colour custom theme whose surfaces css/settings.css derives with
//      color-mix(). The theme is applied AT PARSE TIME, before the first
//      paint, by stamping data-apptheme on <html> (and, for custom, inline
//      --bg/--text plus data-applum from the background's luminance — the
//      novel custom-theme rule, copied). Live changes ride Store.prefs.on,
//      key-gated to `app.*`/null: or:prefs also fires at goals' persistDay
//      cadence for goals.lifetime, and re-theming plus the meta theme-color
//      mutation must not run on every flush. The readers are exempt on
//      purpose: #novel-screen self-themes via --nv-*, #reader-screen is
//      pinned dark in styles.css — reading surfaces are reader-themed, the
//      shell is app-themed.
//
//   2. THE SETTINGS SCREEN (#settings-screen): the focus segmented control,
//      the app-theme swatch grid, the home-layout editor over `home.sections`
//      (order + visibility; All Series is reorderable but never hideable),
//      and the guarded "Your thoughts" entry row.
//
//   3. THE FOCUS SHEET. `AppSettings.maybeOfferFocus()` — called by the
//      catalogue exactly once after the first successful home render — offers
//      Books / Comics / Both while `app.focus` has never been chosen. Any way
//      out of the sheet settles the pref (dismissal writes 'both'), so it
//      never re-prompts. Focus shapes defaults, never overrides a choice, and
//      hides nothing — the effects themselves are read-time and live in the
//      catalogue.
//
// Delete this file and the app runs exactly as before (PLAN7 §0.5): the
// attribute is never set (permanent dark), the screen never registers, the
// sheet never offers — and a previously-written app.focus still steers the
// catalogue's defaults, because the catalogue reads that pref directly.
//
// Everything here is app-authored copy, but the textContent-only discipline
// holds anyway: every node is built with createElement/createElementNS and
// text lands as textContent — never as markup strings.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const SCREEN_ID = 'settings-screen';

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Inline static icons, built programmatically — the goals.js pattern: the
  // XSS boundary stays absolute with zero markup-string exceptions to reason
  // about. Shapes are ['p', pathData, filled?], ['r', x, y, w, h, rx] or
  // ['c', cx, cy, r]; unfilled shapes stroke in currentColor.
  function svgIcon(shapes, size, opts) {
    const o = opts || {};
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(o.strokeWidth || 2));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    shapes.forEach(function (s) {
      let node;
      if (s[0] === 'c') {
        node = document.createElementNS(SVG_NS, 'circle');
        node.setAttribute('cx', String(s[1]));
        node.setAttribute('cy', String(s[2]));
        node.setAttribute('r', String(s[3]));
      } else if (s[0] === 'r') {
        node = document.createElementNS(SVG_NS, 'rect');
        node.setAttribute('x', String(s[1]));
        node.setAttribute('y', String(s[2]));
        node.setAttribute('width', String(s[3]));
        node.setAttribute('height', String(s[4]));
        if (s[5] != null) node.setAttribute('rx', String(s[5]));
      } else {
        node = document.createElementNS(SVG_NS, 'path');
        node.setAttribute('d', s[1]);
        if (s[2]) { node.setAttribute('fill', 'currentColor'); node.setAttribute('stroke', 'none'); }
      }
      svg.appendChild(node);
    });
    return svg;
  }

  const ICONS = {
    back:    [['p', 'M15 18 L9 12 L15 6']],
    close:   [['p', 'M18 6 L6 18'], ['p', 'M6 6 L18 18']],
    up:      [['p', 'M6 15 L12 9 L18 15']],
    down:    [['p', 'M6 9 L12 15 L18 9']],
    chevron: [['p', 'M9 18 L15 12 L9 6']],
  };

  // The three focus glyphs — the diamond family (PLAN7 §2.1): an amber book
  // spine, an indigo panel grid, and the diamond logo for Both. Colour comes
  // from CSS via currentColor; the shapes carry zero content strings.
  const FOCUS_GLYPHS = {
    books: [
      ['r', 8.5, 3, 7, 17.5, 1],
      ['p', 'M12 8.4 L14.4 10.8 L12 13.2 L9.6 10.8 Z', true],
      ['p', 'M5 21 L19 21'],
    ],
    comics: [
      ['r', 3.5, 3.5, 7.5, 7.5, 1],
      ['r', 13, 3.5, 7.5, 7.5, 1],
      ['r', 3.5, 13, 7.5, 7.5, 1],
      ['p', 'M16.75 12.8 L20.7 16.75 L16.75 20.7 L12.8 16.75 Z', true],
    ],
    both: [
      ['p', 'M12 2.8 L21.2 12 L12 21.2 L2.8 12 Z'],
      ['p', 'M12 7.6 L16.4 12 L12 16.4 L7.6 12 Z', true],
    ],
  };

  function iconBtn(label, shapes) {
    const b = el('button', 'set-icon-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.appendChild(svgIcon(shapes, 20, { strokeWidth: 2.2 }));
    return b;
  }

  function bodyScreen() {
    return (document.body && document.body.dataset && document.body.dataset.screen) || '';
  }

  // ── Guarded pref access ───────────────────────────────────────────────────

  function prefGet(key, fallback) {
    try {
      if (window.Store && window.Store.prefs) return window.Store.prefs.get(key, fallback);
    } catch (e) { /* prefs down — defaults carry the feature */ }
    return fallback;
  }

  function prefSet(key, value) {
    try {
      if (window.Store && window.Store.prefs) window.Store.prefs.set(key, value);
    } catch (e) { /* prefs are not worth throwing over */ }
  }

  // ── Theme engine (PLAN7 §2.9) ─────────────────────────────────────────────
  //
  // Nine named palettes + custom. The named triples reuse the novel themes'
  // exact bg/fg/accent values (novel-reader.js THEMES / css/novel.css) — the
  // full set, tan included; css/settings.css holds the per-theme anchors and
  // the color-mix derived layer. This module only stamps attributes and, for
  // custom, two inline properties: the stylesheet is the DOM contract.

  const APP_THEMES = ['dark', 'dim', 'black', 'light', 'cream', 'sepia', 'tan', 'nord', 'forest', 'custom'];

  // [value, label, bg, fg] — swatches are previews, duplicated from the
  // stylesheet on purpose (the novel THEME_SWATCHES rationale). bg doubles as
  // the meta theme-color value for the applied theme.
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

  const THEME_BG = {};
  THEME_SWATCHES.forEach(function (t) { THEME_BG[t[0]] = t[2]; });

  // §1.2 defaults for the custom pair.
  const CUSTOM_BG = '#0a0a0a';
  const CUSTOM_FG = '#f0f0f0';

  // Custom colours end up in CSS custom properties, so they are validated to
  // a literal #rrggbb rather than trusted (the novel.customBg rule).
  function hexColor(v, fallback) {
    return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
  }

  // Perceived lightness of a #rrggbb colour, 0–1 — copied from the novel
  // reader's custom-theme rule so data-applum and data-lum always agree on
  // what counts as a dark background.
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function readTheme() {
    const v = prefGet('app.theme', 'dark');
    return {
      theme:    APP_THEMES.indexOf(v) !== -1 ? v : 'dark',
      customBg: hexColor(prefGet('app.customBg', CUSTOM_BG), CUSTOM_BG),
      customFg: hexColor(prefGet('app.customFg', CUSTOM_FG), CUSTOM_FG),
    };
  }

  let appliedSig = null;

  function applyTheme() {
    const t = readTheme();
    const sig = t.theme + (t.theme === 'custom' ? '|' + t.customBg + '|' + t.customFg : '');
    if (sig === appliedSig) return;    // nothing changed — no DOM writes, no meta mutation
    appliedSig = sig;

    const root = document.documentElement;
    root.dataset.apptheme = t.theme;
    if (t.theme === 'custom') {
      root.style.setProperty('--bg', t.customBg);
      root.style.setProperty('--text', t.customFg);
      root.dataset.applum = luminance(t.customBg) < 0.4 ? 'dark' : 'light';
    } else {
      root.style.removeProperty('--bg');
      root.style.removeProperty('--text');
      delete root.dataset.applum;
    }

    // Browser/PWA chrome follows the shell background. Native status-bar
    // style is platform.js's job (it reads the same pref and, for custom,
    // the data-applum stamped above).
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t.theme === 'custom' ? t.customBg : THEME_BG[t.theme]);
    } catch (e) { /* chrome hint only */ }
  }

  // Parse-time application — this script runs before the first paint settles,
  // so a relaunch under a light theme never flashes dark. Function
  // declarations hoist; everything applyTheme needs is defined above.
  applyTheme();

  // Live re-apply, key-gated to app.* writes and bulk reloads (key null) —
  // see the header for why the gate matters.
  try {
    if (window.Store && window.Store.prefs && typeof window.Store.prefs.on === 'function') {
      window.Store.prefs.on(function (d) {
        const key = d ? d.key : undefined;
        if (key !== null && !(typeof key === 'string' && key.indexOf('app.') === 0)) return;
        applyTheme();
      });
    }
  } catch (e) { /* Store absent — permanent dark, as designed */ }

  // ── Focus pref (PLAN7 §2.1) ───────────────────────────────────────────────

  const FOCUS_VALUES = ['books', 'comics', 'both'];

  function focusChosen() {
    return FOCUS_VALUES.indexOf(prefGet('app.focus', null)) !== -1;
  }

  function readFocus() {
    const v = prefGet('app.focus', 'both');
    return FOCUS_VALUES.indexOf(v) !== -1 ? v : 'both';
  }

  // ── Home sections pref (PLAN7 §2.12 / §1.2) ───────────────────────────────
  //
  // The catalogue owns the rendering read; this module owns the writes and
  // mirrors the same validation so the editor always edits what the home
  // screen actually shows: unknown ids dropped, missing ids inserted at their
  // default position, `on` coerced boolean (missing leans visible — hiding
  // content is the worse failure), and `series` coerced always-on.

  const SECTION_IDS = ['continue', 'goals', 'sources', 'latest', 'series'];
  const SECTION_LABELS = {
    continue: 'Continue reading',
    goals:    'Goals',
    sources:  'Sources',
    latest:   'Latest updates',
    series:   'All Series',
  };

  // Which sections have their module present. continue/latest/series are
  // catalogue-native; goals and sources are optional modules (§0.5) whose
  // slots simply stay empty when the file is deleted.
  function sectionInstalled(id) {
    if (id === 'goals')   return !!window.Goals;
    if (id === 'sources') return !!window.Sources;
    return true;
  }

  // Focus-derived default while the pref is unset (§2.1 effect 2): comics
  // promotes Latest updates to directly under Continue; books/both keep
  // today's order. Once home.sections is written the stored array wins and
  // focus never touches it again.
  function defaultSections() {
    const order = readFocus() === 'comics'
      ? ['continue', 'latest', 'goals', 'sources', 'series']
      : ['continue', 'goals', 'sources', 'latest', 'series'];
    return order.map(function (id) { return { id: id, on: true }; });
  }

  function readSections() {
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

  function writeSections(arr) {
    prefSet('home.sections', arr.map(function (e) {
      return { id: e.id, on: e.id === 'series' ? true : !!e.on };
    }));
  }

  // ── Settings screen ───────────────────────────────────────────────────────

  const ui = {};
  const uiSync = [];        // fn() refreshers — every control pushes one
  let initialized = false;
  let returnScreen = 'home-screen';

  function segRow(label, note, options, get, set) {
    const row = el('div', 'set-row');
    row.appendChild(el('span', 'set-row-label', label));
    const seg = el('div', 'set-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    const buttons = options.map(function (o) {
      const b = el('button', null, o.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.dataset.value = o.value;
      b.addEventListener('click', function () { set(o.value); });
      seg.appendChild(b);
      return b;
    });
    row.appendChild(seg);
    if (note) row.appendChild(el('p', 'set-note', note));
    uiSync.push(function () {
      const cur = String(get());
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.value === cur)); });
    });
    return row;
  }

  // The novel themeRow design (§2.9 UI): swatches painted in their own
  // palette so themes are chosen by looking at colours, custom as one more
  // choice in the grid, colour inputs only while custom is active.
  function themeRow() {
    const row = el('div', 'set-row');
    row.appendChild(el('span', 'set-row-label', 'App theme'));

    const grid = el('div', 'set-themes');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'App theme');

    const buttons = THEME_SWATCHES.map(function (t) {
      const b = el('button', 'set-swatch');
      b.type = 'button';
      b.dataset.value = t[0];
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', t[1]);
      b.title = t[1];
      b.style.background = t[2];
      b.style.color = t[3];
      b.appendChild(el('span', 'set-swatch-aa', 'Aa'));
      b.appendChild(el('span', 'set-swatch-name', t[1]));
      b.addEventListener('click', function () { prefSet('app.theme', t[0]); });
      grid.appendChild(b);
      return b;
    });

    const custom = el('button', 'set-swatch set-swatch-custom');
    custom.type = 'button';
    custom.dataset.value = 'custom';
    custom.setAttribute('aria-pressed', 'false');
    custom.setAttribute('aria-label', 'Custom colours');
    custom.title = 'Custom colours';
    custom.appendChild(el('span', 'set-swatch-aa', 'Aa'));
    custom.appendChild(el('span', 'set-swatch-name', 'Custom'));
    custom.addEventListener('click', function () { prefSet('app.theme', 'custom'); });
    grid.appendChild(custom);
    buttons.push(custom);

    row.appendChild(grid);

    const pickers = el('div', 'set-pickers');
    const bgField = colorField('Background', function () { return readTheme().customBg; },
      function (v) { prefSet('app.customBg', v); });
    const fgField = colorField('Text', function () { return readTheme().customFg; },
      function (v) { prefSet('app.customFg', v); });
    pickers.appendChild(bgField.el);
    pickers.appendChild(fgField.el);
    row.appendChild(pickers);

    row.appendChild(el('p', 'set-note', 'The reader has its own themes, inside the book.'));

    uiSync.push(function () {
      const t = readTheme();
      buttons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.value === t.theme));
      });
      custom.style.background = t.customBg;
      custom.style.color = t.customFg;
      pickers.hidden = t.theme !== 'custom';
      bgField.sync();
      fgField.sync();
    });

    return row;
  }

  function colorField(label, get, set) {
    const wrap = el('label', 'set-picker');
    const input = document.createElement('input');
    input.type = 'color';
    // Fires continuously while the picker is open — each event is one pref
    // write and one cheap attribute-level re-apply, so the preview is live.
    input.addEventListener('input', function () { set(hexColor(input.value, get())); });
    wrap.appendChild(input);
    wrap.appendChild(el('span', null, label));
    return {
      el: wrap,
      sync: function () {
        const v = get();
        if (input.value !== v) input.value = v;
      },
    };
  }

  // ── Home layout editor (PLAN7 §2.12) ──────────────────────────────────────

  function moveSection(id, delta) {
    const arr = readSections();
    const i = arr.findIndex(function (e) { return e.id === id; });
    const j = i + delta;
    if (i === -1 || j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    writeSections(arr);
    // The pref emit re-rendered the rows synchronously — put the keyboard
    // back on the control the reader was using (or its counterpart at an
    // edge, where the same-direction button just went disabled).
    const refs = ui.layoutRefs && ui.layoutRefs[id];
    if (!refs) return;
    const primary = delta < 0 ? refs.up : refs.down;
    const alt = delta < 0 ? refs.down : refs.up;
    try { (primary && !primary.disabled ? primary : alt).focus(); } catch (e) {}
  }

  function toggleSection(id) {
    if (id === 'series') return; // never hideable — the editor refuses the absurdity
    const arr = readSections();
    const entry = arr.find(function (e) { return e.id === id; });
    if (!entry) return;
    entry.on = !entry.on;
    writeSections(arr);
    const refs = ui.layoutRefs && ui.layoutRefs[id];
    if (refs && refs.vis) { try { refs.vis.focus(); } catch (e) {} }
  }

  function renderLayoutRows() {
    const list = ui.layoutList;
    if (!list) return;
    list.textContent = '';
    ui.layoutRefs = {};
    const arr = readSections();

    arr.forEach(function (entry, i) {
      const id = entry.id;
      const label = SECTION_LABELS[id] || id;
      const row = el('div', 'set-sec-row');

      const info = el('div', 'set-sec-info');
      info.appendChild(el('span', 'set-sec-name', label));
      if (!sectionInstalled(id)) {
        // The pref is data; an absent module just means an empty slot. The
        // row still lists so the stored order stays editable.
        info.appendChild(el('span', 'set-sec-note', '(not installed)'));
      }
      row.appendChild(info);

      const controls = el('div', 'set-sec-controls');

      const up = iconBtn('Move ' + label + ' up', ICONS.up);
      up.classList.add('set-move');
      up.disabled = i === 0;
      up.addEventListener('click', function () { moveSection(id, -1); });
      controls.appendChild(up);

      const down = iconBtn('Move ' + label + ' down', ICONS.down);
      down.classList.add('set-move');
      down.disabled = i === arr.length - 1;
      down.addEventListener('click', function () { moveSection(id, +1); });
      controls.appendChild(down);

      let vis = null;
      if (id === 'series') {
        // The library is the home screen's reason to exist — reorderable,
        // never hideable (§1.2: `on` is coerced true on read).
        controls.appendChild(el('span', 'set-sec-always', 'always shown'));
      } else {
        vis = el('button', 'set-vis', entry.on ? 'Shown' : 'Hidden');
        vis.type = 'button';
        vis.setAttribute('aria-pressed', String(!!entry.on));
        vis.setAttribute('aria-label', (entry.on ? 'Hide ' : 'Show ') + label);
        vis.addEventListener('click', function () { toggleSection(id); });
        controls.appendChild(vis);
      }

      row.appendChild(controls);
      list.appendChild(row);
      ui.layoutRefs[id] = { up: up, down: down, vis: vis };
    });
  }

  function layoutSection() {
    const row = el('div', 'set-row');
    row.appendChild(el('span', 'set-row-label', 'Home layout'));
    ui.layoutList = el('div', 'set-sec-list');
    row.appendChild(ui.layoutList);

    const reset = el('button', 'set-text-btn', 'Reset to default');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      // Clear the pref rather than writing a layout: the §2.1 focus-derived
      // default applies again, now and after every future focus change.
      // (prefs has no remove — an `undefined` value is dropped by the JSON
      // serializer, so the key is genuinely gone on the next read-through.)
      prefSet('home.sections', undefined);
    });
    row.appendChild(reset);
    row.appendChild(el('p', 'set-note', 'Order and visibility of the home screen sections. All Series always shows.'));
    return row;
  }

  // ── Screen assembly ───────────────────────────────────────────────────────

  function buildScreen() {
    const root = el('div');
    root.id = SCREEN_ID;

    const header = el('div', 'set-header');
    const backBtn = iconBtn('Back', ICONS.back);
    backBtn.addEventListener('click', function () { close(); });
    header.appendChild(backBtn);
    header.appendChild(el('div', 'set-title', 'Settings'));
    root.appendChild(header);

    const body = el('div', 'set-body');
    const view = el('div', 'set-view');
    body.appendChild(view);
    root.appendChild(body);

    // Focus first (§2.1: the settings screen's first row).
    view.appendChild(segRow('Focus',
      'Shapes the default tab and home order. Nothing is hidden or locked away.', [
        { value: 'books',  label: 'Books' },
        { value: 'comics', label: 'Comics' },
        { value: 'both',   label: 'Both' },
      ],
      function () { return readFocus(); },
      function (v) { prefSet('app.focus', v); }));

    view.appendChild(themeRow());
    view.appendChild(layoutSection());

    // "Your thoughts" — guarded both directions (§2.7): without thoughts.js
    // this row is simply not rendered; without settings.js, thoughts' own
    // post-save toast is the door.
    if (window.Thoughts && typeof window.Thoughts.openScreen === 'function') {
      const row = el('div', 'set-row');
      row.appendChild(el('span', 'set-row-label', 'Thoughts'));
      const btn = el('button', 'set-nav-btn');
      btn.type = 'button';
      btn.appendChild(el('span', null, 'Your thoughts'));
      const chev = el('span', 'set-nav-chev');
      chev.appendChild(svgIcon(ICONS.chevron, 16, { strokeWidth: 2.2 }));
      btn.appendChild(chev);
      btn.addEventListener('click', function () {
        try { window.Thoughts.openScreen(); } catch (e) {}
      });
      row.appendChild(btn);
      view.appendChild(row);
    }

    ui.root = root;
    document.body.appendChild(root);
    if (typeof window.registerScreen === 'function') window.registerScreen(root);
  }

  function syncUI() {
    if (!ui.root) return;
    renderLayoutRows();
    uiSync.forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  }

  // ── Navigation (the importer/goals precedent) ─────────────────────────────

  function openScreen() {
    init();
    const from = bodyScreen();
    if (from && from !== SCREEN_ID) returnScreen = from;
    syncUI();
    if (typeof window.showScreen === 'function') {
      window.showScreen(SCREEN_ID);
    } else if (ui.root) {
      // Standalone (test harness): no screen registry to delegate to.
      ui.root.style.display = 'flex';
      if (document.body && document.body.dataset) document.body.dataset.screen = SCREEN_ID;
    }
  }

  function close() {
    const C = window.Catalogue;
    if (C && typeof C.goBack === 'function') { C.goBack(); return; }
    if (typeof window.showScreen === 'function') { window.showScreen(returnScreen || 'home-screen'); return; }
    if (ui.root) ui.root.style.display = 'none';
  }

  // ── Focus sheet (PLAN7 §2.1) ──────────────────────────────────────────────

  const focusUi = {};
  let focusOpen = false;
  let focusOffered = false;   // once per session, belt over the pref check
  let focusLastFocus = null;
  let inerted = [];           // body children we made inert — restored on close

  function focusCard(value, title, copy) {
    const b = el('button', 'set-card set-card-' + value);
    b.type = 'button';
    const glyph = el('span', 'set-card-glyph');
    glyph.appendChild(svgIcon(FOCUS_GLYPHS[value], 34, { strokeWidth: 1.6 }));
    b.appendChild(glyph);
    const text = el('span', 'set-card-text');
    text.appendChild(el('span', 'set-card-title', title));
    text.appendChild(el('span', 'set-card-copy', copy));
    b.appendChild(text);
    b.addEventListener('click', function () { settleFocus(value); });
    return b;
  }

  function buildFocusSheet() {
    if (focusUi.sheet) return;

    const scrim = el('div', 'set-scrim');
    scrim.hidden = true;
    scrim.addEventListener('click', function () { settleFocus('both'); });
    document.body.appendChild(scrim);

    const sheet = el('aside', 'set-focus-sheet');
    sheet.hidden = true;
    // The stylesheet keeps [hidden] sheets displayed (translated off-screen)
    // so the hide can animate; `inert` is what removes it from the tab order.
    sheet.inert = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'What do you read?');

    const head = el('div', 'set-sheet-head');
    head.appendChild(el('h2', null, 'What do you read?'));
    const closeBtn = iconBtn('Close', ICONS.close);
    closeBtn.addEventListener('click', function () { settleFocus('both'); });
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    const bodyEl = el('div', 'set-sheet-body');
    const cards = el('div', 'set-cards');
    const first = focusCard('books', 'Books', 'Novels and long reads — prose first.');
    cards.appendChild(first);
    cards.appendChild(focusCard('comics', 'Comics', 'Manga and manhwa — panels first.'));
    cards.appendChild(focusCard('both', 'Both', 'The whole shelf, side by side.'));
    bodyEl.appendChild(cards);

    // Second question: the look. Asked here because the theme a reader wants
    // is the first thing they notice and the last thing they think to go
    // hunting for in Settings. It also becomes the baseline the novel reader
    // inherits, so choosing once dresses the shell AND the books.
    bodyEl.appendChild(focusThemeBlock());

    // The tour button renders only when the tutorial actually exists — a
    // catalogue that lost fixture:welcome shows the sheet without a dangling
    // door (§2.1; the validate.js floor guard is the other half).
    let welcome = null;
    try {
      const C = window.Catalogue;
      if (C && typeof C.getSeries === 'function') welcome = C.getSeries('fixture:welcome');
    } catch (e) { welcome = null; }
    if (welcome) {
      const tour = el('button', 'set-tour-btn', 'Start with the tour');
      tour.type = 'button';
      tour.addEventListener('click', function () {
        // Leaving through the tour settles the pref like any dismissal —
        // the sheet never re-prompts — then opens the tutorial book.
        settleFocus('both');
        try {
          const C = window.Catalogue;
          if (C && typeof C.getSeries === 'function' && typeof C.openSeries === 'function') {
            const s = C.getSeries('fixture:welcome');
            if (s) C.openSeries(s);
          }
        } catch (e) {}
      });
      bodyEl.appendChild(tour);
    }

    bodyEl.appendChild(el('p', 'set-sheet-note', 'You can change this any time in Settings.'));
    sheet.appendChild(bodyEl);
    document.body.appendChild(sheet);

    focusUi.scrim = scrim;
    focusUi.sheet = sheet;
    focusUi.firstCard = first;
  }

  /**
   * The first-run theme grid.
   *
   * Named palettes only — `custom` needs two colour pickers and a reason to
   * care, neither of which belongs in the thirty seconds before someone has
   * read anything. It stays available in Settings.
   *
   * Writes `app.theme` on tap and lets the ordinary Store.prefs.on path
   * repaint, so the sheet re-themes under the reader's finger: the choice
   * shows its own result, which is the whole argument for asking here.
   */
  function focusThemeBlock() {
    const block = el('div', 'set-theme-block');
    block.appendChild(el('span', 'set-theme-label', 'And how should it look?'));

    const grid = el('div', 'set-themes');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'App theme');

    const buttons = THEME_SWATCHES.map(function (t) {
      const b = el('button', 'set-swatch');
      b.type = 'button';
      b.dataset.value = t[0];
      b.setAttribute('aria-label', t[1]);
      b.title = t[1];
      b.style.background = t[2];
      b.style.color = t[3];
      b.appendChild(el('span', 'set-swatch-aa', 'Aa'));
      b.appendChild(el('span', 'set-swatch-name', t[1]));
      b.addEventListener('click', function () {
        prefSet('app.theme', t[0]);
        sync();
      });
      grid.appendChild(b);
      return b;
    });

    function sync() {
      const active = readTheme().theme;
      buttons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.value === active));
      });
    }
    sync();

    block.appendChild(grid);
    return block;
  }

  // aria-modal only claims the rest of the page is unavailable; making the
  // backdrop inert is what turns the claim true. The sheet parks on <body>,
  // so the backdrop is every other body child.
  function setPageInert(on) {
    if (on) {
      inerted = [];
      Array.prototype.forEach.call(document.body.children, function (n) {
        if (n === focusUi.scrim || n === focusUi.sheet) return;
        if (n.tagName === 'SCRIPT') return;
        if (!n.inert) { n.inert = true; inerted.push(n); }
      });
    } else {
      inerted.forEach(function (n) { n.inert = false; });
      inerted = [];
    }
  }

  function openFocusSheet() {
    buildFocusSheet();
    if (focusOpen) return;
    focusOpen = true;
    focusLastFocus = document.activeElement;
    focusUi.scrim.hidden = false;
    focusUi.sheet.hidden = false;
    focusUi.sheet.inert = false;
    setPageInert(true);
    try { focusUi.firstCard.focus(); } catch (e) {}
  }

  // Every way out lands here: a chosen card writes its value, every dismissal
  // (scrim, close, Escape, the tour) writes 'both'. Writing is what makes the
  // offer once-ever — maybeOfferFocus checks the pref, not a flag.
  function settleFocus(value) {
    if (!focusOpen) return;
    prefSet('app.focus', value);
    focusOpen = false;
    setPageInert(false);
    focusUi.scrim.hidden = true;
    focusUi.sheet.hidden = true;
    focusUi.sheet.inert = true;
    if (focusLastFocus && document.contains(focusLastFocus)) {
      try { focusLastFocus.focus(); } catch (e) {}
    }
    focusLastFocus = null;
    // The sheet can never show again this profile — let the DOM go once the
    // hide transition has played out.
    setTimeout(function () {
      if (focusOpen) return;
      if (focusUi.scrim && focusUi.scrim.parentNode) focusUi.scrim.parentNode.removeChild(focusUi.scrim);
      if (focusUi.sheet && focusUi.sheet.parentNode) focusUi.sheet.parentNode.removeChild(focusUi.sheet);
      focusUi.scrim = focusUi.sheet = focusUi.firstCard = null;
    }, 400);
  }

  function maybeOfferFocus() {
    init();
    if (focusOffered || focusOpen) return;
    if (focusChosen()) return;                    // chosen once — never re-prompt
    if (bodyScreen() === 'upload-screen') return; // never offered on the offline boot path
    focusOffered = true;
    openFocusSheet();
  }

  // ── Wiring + init ─────────────────────────────────────────────────────────

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (focusOpen) { settleFocus('both'); return; }
    if (bodyScreen() === SCREEN_ID) close();
  }

  function wireEvents() {
    // Screen refreshers. The theme ENGINE has its own parse-time Store.prefs
    // subscription above; this one only keeps the visible controls honest.
    // The layout rows only rebuild when their inputs could have moved — a
    // custom-colour drag emits app.* continuously and must stay cheap.
    window.addEventListener('or:prefs', function (ev) {
      if (!initialized) return;
      const d = ev && ev.detail;
      const key = d ? d.key : undefined;
      const isApp = typeof key === 'string' && key.indexOf('app.') === 0;
      if (key !== null && key !== 'home.sections' && !isApp) return;
      if (key === null || key === 'home.sections' || key === 'app.focus') renderLayoutRows();
      uiSync.forEach(function (fn) {
        try { fn(); } catch (e) {}
      });
    });
    document.addEventListener('keydown', onKeydown);
  }

  function init() {
    if (initialized) return;
    initialized = true;
    buildScreen();
    wireEvents();
    syncUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  // ── Public API (PLAN7 §1.1 / §2.11) ───────────────────────────────────────

  window.AppSettings = {
    openScreen: openScreen,
    close: close,
    maybeOfferFocus: maybeOfferFocus,
  };
})();
