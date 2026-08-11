// Offline Reader — depart your thoughts. See docs/mobile/PLAN7.md §2.7 and
// docs/ARCHITECTURE.md.
//
// A quiet space to leave reflections when closing a book. Not "notes" — the
// UI says "Depart your thoughts" / "Leave a thought". The module owns three
// surfaces: the reading screen (thoughts-screen — the list of everything the
// reader has left behind), the composer (a bottom sheet that floats over
// whichever screen asked for it), and the image-reader chip (a floating
// bottom-left button that appears once when a comic's last chapter completes).
//
// Like goals.js, this module OBSERVES the app rather than invading it: the
// image-reader trigger is the `or:progress` window event (store.js fires it
// from putProgress, the one choke point every progress writer already funnels
// through), and the novel reader's inline CTA lives in novel-reader.js behind
// a `window.Thoughts` guard. Delete this file and the app runs exactly as
// before — no CTA renders, no chip appears, the settings row is never built,
// and the events go unheard (§0.5).
//
// Persistence is the Store `thoughts` table (§1.3) — this module is its ONLY
// writer. `seriesTitle` is denormalized onto every row because thoughts
// OUTLIVE series deletion (deleteUserSeries deliberately does not cascade
// here): a reflection is the reader's own writing, not series data.
//
// Cadence (decided, §2.7): always offered at book end; per-chapter prompting
// exists but is OFF by default behind `thoughts.chapterPrompt` — the toggle
// lives on this screen, and novel-reader.js reads the pref guarded.
//
// The chip's gate is `document.body.dataset.screen === 'reader-screen'`
// EXACTLY — never a broader "is a reader screen" test: novel completion also
// flows through putProgress → or:progress with completed true, and a loose
// condition would stack this chip on top of the novel surface's own inline
// CTA, a duplicate affordance.
//
// The XSS boundary is absolute here twice over: a saved thought is the
// reader's own words, but at render time it is third-party prose like any
// chapter — textContent only; this file never assigns markup strings to the
// DOM (the §8.6 grep gate holds it to zero exceptions).

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const SCREEN_ID = 'thoughts-screen';
  const PROMPT_KEY = 'thoughts.chapterPrompt'; // §1.2 — boolean, default false

  const CHIP_MS = 12000;   // the floating chip self-dismisses after this
  const TOAST_MS = 4000;   // auto-dismiss unchanged from the goals toast
  const PAGE_SIZE = 100;   // list rows per chunk — the DOM ceiling discipline
  const MAX_LEN = 4000;    // composer textarea cap (belt: also clamped on save)

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
    const b = el('button', 'tho-icon-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.appendChild(svgIcon(iconShapes, 20));
    return b;
  }

  // ── Guarded cross-module access ───────────────────────────────────────────

  function bodyScreen() {
    return (document.body && document.body.dataset && document.body.dataset.screen) || '';
  }

  function storeReady() {
    return !!(window.Store && typeof window.Store.listThoughts === 'function');
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

  // thoughts.chapterPrompt is validated on read like every pref (§0.8): only
  // a real boolean counts, anything else is the default (off).
  function readPrompt() {
    const v = prefGet(PROMPT_KEY, false);
    return typeof v === 'boolean' ? v : false;
  }

  function dispatchThoughtsChanged(detail) {
    // §1.4 rules: dispatch in try/catch, listeners tolerate absent dispatchers.
    try {
      window.dispatchEvent(new CustomEvent('or:thoughts-changed', { detail: detail }));
    } catch (e) { /* a listener must never break the write it watched */ }
  }

  async function askConfirm(opts) {
    try {
      if (window.Platform && typeof window.Platform.confirm === 'function') {
        return !!(await window.Platform.confirm(opts));
      }
    } catch (e) {}
    try { return window.confirm(opts.message || ''); } catch (e) { return false; }
  }

  function fmtDate(iso) {
    try {
      const d = new Date(String(iso));
      if (isNaN(d.getTime())) return String(iso || '');
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return String(iso || ''); }
  }

  // ── Module state ──────────────────────────────────────────────────────────

  const ui = {};              // screen element handles
  const comp = {};            // composer element handles
  let compOpen = false;
  let compCtx = null;         // the thought being written/edited
  let compLastFocus = null;
  let inerted = [];           // body children made inert behind the composer

  let toastEl = null;
  let toastTimer = 0;

  let chipEl = null;          // built lazily — no DOM cost until a book ends
  let chipCtx = null;
  let chipTimer = 0;
  const chipShown = new Set();// seriesIds offered this session — once per series

  let rows = [];              // last fetched thought list (screen)
  let visibleCount = PAGE_SIZE;
  let listGen = 0;

  let lastScreen = '';
  let returnScreen = 'home-screen';
  let initialized = false;

  // ── Store plumbing (guarded; Store never rejects for expected conditions) ─

  async function listAll() {
    if (!storeReady()) return [];
    try { return (await window.Store.listThoughts({})) || []; } catch (e) { return []; }
  }

  async function saveThought(record) {
    if (!storeReady()) return null;
    try { return await window.Store.putThought(record); } catch (e) { return null; }
  }

  async function removeThought(id) {
    if (!storeReady()) return false;
    try { await window.Store.deleteThought(id); return true; } catch (e) { return false; }
  }

  // ── Book-finish detection (the goals §5.1 rule, verbatim) ─────────────────
  //
  // The finale's id by ascending num — the catalogue's own reading-order rule.
  // A decimal finale (num 271.5 over chapterCount 271) sorts last here and is
  // caught by ID equality where num arithmetic never would be;
  // chapterNum === chapterCount is the last resort only.

  function lastChapterIdOf(seriesId) {
    try {
      const C = window.Catalogue;
      if (!C || typeof C.getSeries !== 'function') return null;
      const s = C.getSeries(seriesId);
      const chs = s && Array.isArray(s.chapters) ? s.chapters : null;
      if (!chs || !chs.length) return null;
      let last = chs[0];
      let lastNum = last && last.num != null ? last.num : 0;
      for (let i = 1; i < chs.length; i++) {
        const n = chs[i] && chs[i].num != null ? chs[i].num : 0;
        if (n >= lastNum) { last = chs[i]; lastNum = n; }
      }
      return last && last.id != null ? String(last.id) : null;
    } catch (e) { return null; }
  }

  function isBookFinish(seriesId, row) {
    if (!row || !row.completed) return false;
    const lastId = lastChapterIdOf(seriesId);
    if (lastId != null) return row.chapterId != null && String(row.chapterId) === lastId;
    return typeof row.chapterNum === 'number' && typeof row.chapterCount === 'number'
      && row.chapterCount > 0 && row.chapterNum === row.chapterCount;
  }

  // ── Image-reader chip (event-driven — zero reader edits, §2.7) ────────────

  function ensureChip() {
    if (chipEl) return;
    chipEl = el('button', 'tho-chip tho-chip-hidden', 'Depart your thoughts');
    chipEl.type = 'button';
    chipEl.addEventListener('click', function () {
      const ctx = chipCtx;
      dismissChip();
      if (ctx) openComposer(ctx);
    });
    document.body.appendChild(chipEl);
  }

  function showChip(ctx) {
    ensureChip();
    chipCtx = ctx;
    chipEl.classList.remove('tho-chip-hidden');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(dismissChip, CHIP_MS);
  }

  function dismissChip() {
    clearTimeout(chipTimer);
    chipTimer = 0;
    chipCtx = null;
    if (chipEl) chipEl.classList.add('tho-chip-hidden');
  }

  function onProgress(ev) {
    const d = ev && ev.detail;
    if (!d || !d.seriesId || !d.row || typeof d.row !== 'object') return;
    // EXACT screen equality (§2.7): novel completion also rides putProgress →
    // or:progress with completed true, and the novel surface already renders
    // its own inline .nv-thoughts-cta — a broader "is a reader" test would
    // stack this chip on top of it.
    if (bodyScreen() !== 'reader-screen') return;
    const id = String(d.seriesId);
    if (chipShown.has(id)) return;             // once per series per session
    if (!isBookFinish(id, d.row)) return;
    chipShown.add(id);
    // Freshest title from the catalogue; the denormalized progress-row title
    // is the fallback (the goals buildSeriesList precedent).
    let title = null;
    try {
      const C = window.Catalogue;
      const s = C && typeof C.getSeries === 'function' ? C.getSeries(id) : null;
      if (s && s.title != null) title = String(s.title);
    } catch (e) {}
    if (title == null && d.row.seriesTitle != null) title = String(d.row.seriesTitle);
    showChip({
      id: null,
      seriesId: id,
      seriesTitle: title,
      chapterId: null,
      chapterTitle: null,
      kind: 'book',
      createdAt: null,
      text: '',
    });
  }

  // ── Toast (tappable — the goals buildToast pattern, rendered as a button) ─
  //
  // The tap is a real entrance: with js/settings.js deleted, this toast is
  // the only door to thoughts-screen after a save, which is why it navigates
  // instead of merely confirming (§2.7 entry points).

  function buildToast() {
    toastEl = el('button', 'tho-toast');
    toastEl.type = 'button';
    toastEl.setAttribute('aria-live', 'polite');
    toastEl.addEventListener('click', function () {
      hideToast();
      openScreen();
    });
    document.body.appendChild(toastEl);
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.remove('visible');
  }

  // ── Composer (bottom sheet, parked on <body> so it floats over whichever
  //    screen asked — novel end, image chip, or a list row's Edit) ───────────

  function buildComposer() {
    if (comp.sheet) return;

    const scrim = el('div', 'tho-scrim');
    scrim.hidden = true;
    scrim.addEventListener('click', function () { closeComposer(); });
    document.body.appendChild(scrim);

    const sheet = el('aside', 'tho-sheet');
    sheet.hidden = true;
    // The stylesheet keeps [hidden] sheets displayed (translated off-screen)
    // so the hide can animate; `inert` is what removes it from the tab order.
    sheet.inert = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Depart your thoughts');

    const head = el('div', 'tho-sheet-head');
    const title = el('h2', 'tho-sheet-title', '');  // series title — third-party, textContent
    head.appendChild(title);
    const closeBtn = iconBtn('Close without saving', ICONS.close);
    closeBtn.addEventListener('click', function () { closeComposer(); });
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    const body = el('div', 'tho-sheet-body');
    const date = el('div', 'tho-sheet-date', '');
    body.appendChild(date);

    const ta = document.createElement('textarea');
    ta.className = 'tho-ta';
    ta.setAttribute('maxlength', String(MAX_LEN));
    ta.setAttribute('rows', '4');
    ta.setAttribute('aria-label', 'Your thought');
    ta.placeholder = 'What did it leave behind?';
    ta.addEventListener('input', autoGrow);
    // Keyboard overlap: scrollIntoView on focus — the accepted iOS risk noted
    // in §2.7 (at ≥720px the sheet is a side panel and unaffected).
    ta.addEventListener('focus', function () {
      try { ta.scrollIntoView({ block: 'center' }); } catch (e) {}
    });
    body.appendChild(ta);

    const actions = el('div', 'tho-sheet-actions');
    const save = el('button', 'tho-save', 'Save');
    save.type = 'button';
    save.addEventListener('click', function () { saveFromComposer(); });
    const discard = el('button', 'tho-discard', 'Discard');
    discard.type = 'button';
    discard.addEventListener('click', function () { closeComposer(); });
    actions.appendChild(save);
    actions.appendChild(discard);
    body.appendChild(actions);
    sheet.appendChild(body);
    document.body.appendChild(sheet);

    comp.scrim = scrim;
    comp.sheet = sheet;
    comp.title = title;
    comp.date = date;
    comp.ta = ta;
  }

  function autoGrow() {
    const ta = comp.ta;
    if (!ta) return;
    // The CSS max-height caps this; below the cap the box tracks the text.
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  // aria-modal only claims the rest of the page is unavailable; making the
  // backdrop inert is what turns the claim true. The sheet parks on <body>,
  // so the backdrop is every other body child (the settings focus-sheet
  // discipline, copied).
  function setPageInert(on) {
    if (on) {
      inerted = [];
      Array.prototype.forEach.call(document.body.children, function (n) {
        if (n === comp.scrim || n === comp.sheet) return;
        if (n.tagName === 'SCRIPT') return;
        if (!n.inert) { n.inert = true; inerted.push(n); }
      });
    } else {
      inerted.forEach(function (n) { n.inert = false; });
      inerted = [];
    }
  }

  function composeDateLine(ctx) {
    const parts = [];
    if (ctx.kind === 'chapter' && ctx.chapterTitle) parts.push(String(ctx.chapterTitle));
    parts.push(fmtDate(ctx.createdAt || new Date().toISOString()));
    return parts.join(' · ');
  }

  function openComposer(ctx) {
    if (compOpen || !ctx || ctx.seriesId == null) return;
    init();
    buildComposer();
    compOpen = true;
    compCtx = ctx;
    compLastFocus = document.activeElement;
    comp.title.textContent = ctx.seriesTitle != null ? String(ctx.seriesTitle) : String(ctx.seriesId);
    comp.date.textContent = composeDateLine(ctx);
    comp.ta.value = ctx.text != null ? String(ctx.text) : '';
    comp.scrim.hidden = false;
    comp.sheet.hidden = false;
    comp.sheet.inert = false;
    setPageInert(true);
    autoGrow();
    try { comp.ta.focus(); } catch (e) {}
  }

  function closeComposer() {
    if (!compOpen) return;
    compOpen = false;
    compCtx = null;
    comp.scrim.hidden = true;
    comp.sheet.hidden = true;
    comp.sheet.inert = true;
    setPageInert(false);
    if (compLastFocus && document.contains(compLastFocus)) {
      try { compLastFocus.focus(); } catch (e) {}
    }
    compLastFocus = null;
  }

  async function saveFromComposer() {
    if (!compOpen || !compCtx) return;
    const ctx = compCtx;
    const text = String(comp.ta.value || '').slice(0, MAX_LEN);
    // An empty thought is not a thought — treat Save-on-empty as Discard.
    if (!text.trim()) { closeComposer(); return; }

    const record = {
      seriesId: String(ctx.seriesId),
      seriesTitle: ctx.seriesTitle != null ? String(ctx.seriesTitle) : null,
      chapterId: ctx.kind === 'chapter' && ctx.chapterId != null ? String(ctx.chapterId) : null,
      chapterTitle: ctx.kind === 'chapter' && ctx.chapterTitle != null ? String(ctx.chapterTitle) : null,
      kind: ctx.kind === 'chapter' ? 'chapter' : 'book',
      text: text,
    };
    // Late title fill: the denormalization is what lets a thought outlive its
    // series, so grab the freshest title if the caller had none.
    if (record.seriesTitle == null) {
      try {
        const C = window.Catalogue;
        const s = C && typeof C.getSeries === 'function' ? C.getSeries(record.seriesId) : null;
        if (s && s.title != null) record.seriesTitle = String(s.title);
      } catch (e) {}
    }
    // Editing: keep the identity — putThought upserts by id and REPLACES the
    // record, so the original createdAt rides along explicitly.
    if (ctx.id) {
      record.id = ctx.id;
      if (ctx.createdAt) record.createdAt = ctx.createdAt;
    }

    closeComposer();
    const saved = await saveThought(record);
    if (!saved) { toast('Could not save your thought.'); return; }
    dispatchThoughtsChanged({ id: saved.id });
    toast('Kept. Tap to read your thoughts.');
  }

  // ── Reading surface (thoughts-screen) ─────────────────────────────────────

  function buildScreen() {
    const root = el('div');
    root.id = SCREEN_ID;

    const header = el('div', 'tho-header');
    const backBtn = iconBtn('Back', ICONS.back);
    backBtn.addEventListener('click', function () { close(); });
    header.appendChild(backBtn);
    header.appendChild(el('div', 'tho-title', 'Your thoughts'));
    root.appendChild(header);

    const body = el('div', 'tho-body');
    const view = el('div', 'tho-view');
    body.appendChild(view);
    root.appendChild(body);

    // Chapter cadence toggle (§2.7): book-end is always offered; every
    // chapter is opt-in — the reader's own instinct is the default.
    const row = el('div', 'tho-row');
    row.appendChild(el('span', 'tho-row-label', 'Chapter prompts'));
    const toggle = el('button', 'tho-toggle');
    toggle.type = 'button';
    toggle.appendChild(el('span', null, 'Also ask at the end of every chapter'));
    toggle.appendChild(el('span', 'tho-state', 'Off'));
    toggle.addEventListener('click', function () {
      prefSet(PROMPT_KEY, !readPrompt());
      syncPromptToggle();
    });
    row.appendChild(toggle);
    view.appendChild(row);

    const list = el('div', 'tho-list');
    view.appendChild(list);

    ui.root = root;
    ui.header = header;
    ui.body = body;
    ui.list = list;
    ui.promptToggle = toggle;
    document.body.appendChild(root);
    if (typeof window.registerScreen === 'function') window.registerScreen(root);
  }

  function syncPromptToggle() {
    if (!ui.promptToggle) return;
    const on = readPrompt();
    ui.promptToggle.setAttribute('aria-pressed', String(on));
    ui.promptToggle.lastChild.textContent = on ? 'On' : 'Off';
  }

  async function refreshList() {
    const gen = ++listGen;
    const all = await listAll();
    if (gen !== listGen) return; // a newer fetch owns the render now
    rows = all;
    renderList();
  }

  function thoughtRow(r) {
    const item = el('article', 'tho-item');

    const meta = el('div', 'tho-item-meta');
    meta.appendChild(el('span', 'tho-kind', r.kind === 'chapter' ? 'Chapter' : 'Book'));
    if (r.kind === 'chapter' && r.chapterTitle) {
      meta.appendChild(el('span', 'tho-item-chapter', String(r.chapterTitle)));
    }
    meta.appendChild(el('span', 'tho-item-date', fmtDate(r.createdAt)));
    item.appendChild(meta);

    // The reader's words — third-party prose at render time. textContent
    // plus white-space: pre-wrap in the stylesheet; nothing here can ever
    // become markup.
    item.appendChild(el('div', 'tho-item-text', r.text != null ? String(r.text) : ''));

    const actions = el('div', 'tho-item-actions');
    const editBtn = el('button', 'tho-btn', 'Edit');
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', 'Edit thought');
    editBtn.addEventListener('click', function () {
      openComposer({
        id: r.id,
        seriesId: r.seriesId,
        seriesTitle: r.seriesTitle != null ? r.seriesTitle : null,
        chapterId: r.chapterId != null ? r.chapterId : null,
        chapterTitle: r.chapterTitle != null ? r.chapterTitle : null,
        kind: r.kind === 'chapter' ? 'chapter' : 'book',
        createdAt: r.createdAt || null,
        text: r.text != null ? String(r.text) : '',
      });
    });
    actions.appendChild(editBtn);
    const delBtn = el('button', 'tho-btn tho-btn-danger', 'Delete');
    delBtn.type = 'button';
    delBtn.setAttribute('aria-label', 'Delete thought');
    delBtn.addEventListener('click', function () { confirmDelete(r); });
    actions.appendChild(delBtn);
    item.appendChild(actions);

    return item;
  }

  async function confirmDelete(r) {
    const ok = await askConfirm({
      title: 'Delete thought',
      message: 'Delete this thought? It cannot be brought back.',
      okLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    const done = await removeThought(r.id);
    if (!done) return;
    dispatchThoughtsChanged({ deleted: r.id });
    toast('Thought removed.');
  }

  function renderList() {
    const list = ui.list;
    if (!list) return;
    list.textContent = '';

    if (!rows.length) {
      list.appendChild(el('div', 'tho-empty',
        'When you finish a book, we will ask what it left behind. Nothing yet.'));
      return;
    }

    // Newest-first, grouped by series: rows arrive desc by createdAt from the
    // store, so groups order by their freshest thought and rows inside a
    // group stay newest-first. The group title is the newest denormalized
    // seriesTitle — thoughts outlive series deletion, so the row data is the
    // only source of truth.
    const groups = [];
    const byId = new Map();
    rows.forEach(function (r) {
      if (!r || r.id == null) return;
      const sid = r.seriesId != null ? String(r.seriesId) : '';
      let g = byId.get(sid);
      if (!g) {
        g = { seriesId: sid, title: null, rows: [] };
        byId.set(sid, g);
        groups.push(g);
      }
      if (g.title == null && r.seriesTitle != null) g.title = String(r.seriesTitle);
      g.rows.push(r);
    });

    // Chunked at PAGE_SIZE rows across all groups (the DOM ceiling
    // discipline); "Show more" reveals the next chunk without a refetch.
    let rendered = 0;
    let truncated = false;
    for (let gi = 0; gi < groups.length; gi++) {
      if (rendered >= visibleCount) { truncated = true; break; }
      const g = groups[gi];
      const head = el('div', 'tho-group-head');
      head.appendChild(el('span', 'tho-group-title', g.title != null ? g.title : (g.seriesId || 'Untitled')));
      head.appendChild(el('span', 'tho-group-count', String(g.rows.length)));
      list.appendChild(head);
      for (let ri = 0; ri < g.rows.length; ri++) {
        if (rendered >= visibleCount) { truncated = true; break; }
        list.appendChild(thoughtRow(g.rows[ri]));
        rendered++;
      }
    }

    if (truncated) {
      const more = el('button', 'tho-more', 'Show more');
      more.type = 'button';
      more.addEventListener('click', function () {
        visibleCount += PAGE_SIZE;
        renderList();
      });
      list.appendChild(more);
    }
  }

  // ── Navigation (the importer/goals precedent) ─────────────────────────────

  function openScreen() {
    init();
    const from = bodyScreen();
    if (from && from !== SCREEN_ID) returnScreen = from;
    visibleCount = PAGE_SIZE;
    syncPromptToggle();
    refreshList();
    if (typeof window.showScreen === 'function') {
      window.showScreen(SCREEN_ID);
    } else if (ui.root) {
      // Standalone (test harness): no screen registry to delegate to.
      ui.root.style.display = 'flex';
      if (document.body && document.body.dataset) document.body.dataset.screen = SCREEN_ID;
    }
  }

  function close() {
    if (compOpen) closeComposer();
    const C = window.Catalogue;
    if (C && typeof C.goBack === 'function') { C.goBack(); return; }
    if (typeof window.showScreen === 'function') { window.showScreen(returnScreen || 'home-screen'); return; }
    if (ui.root) ui.root.style.display = 'none';
  }

  // The public composer door (§2.7 API): novel-reader's inline CTAs call this
  // with full context; kind is validated, book-level thoughts carry no
  // chapter fields regardless of what the caller sent.
  function open(opts) {
    if (!opts || opts.seriesId == null) return;
    const kind = opts.kind === 'chapter' ? 'chapter' : 'book';
    openComposer({
      id: null,
      seriesId: String(opts.seriesId),
      seriesTitle: opts.seriesTitle != null ? String(opts.seriesTitle) : null,
      chapterId: kind === 'chapter' && opts.chapterId != null ? String(opts.chapterId) : null,
      chapterTitle: kind === 'chapter' && opts.chapterTitle != null ? String(opts.chapterTitle) : null,
      kind: kind,
      createdAt: null,
      text: '',
    });
  }

  // ── Wiring + init ─────────────────────────────────────────────────────────

  function onScreenMaybeChanged() {
    const s = bodyScreen();
    if (s === lastScreen) return;
    lastScreen = s;
    // The chip lives on reader-screen only; any navigation dismisses it
    // (§2.7 — auto-dismiss on screen change).
    dismissChip();
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (compOpen) { closeComposer(); return; }
    if (bodyScreen() === SCREEN_ID) close();
  }

  function wireEvents() {
    window.addEventListener('or:progress', onProgress);

    // Re-render on any thought change while the screen is up — our own
    // writes and anyone else's (the importer's restore path upserts rows).
    window.addEventListener('or:thoughts-changed', function () {
      if (bodyScreen() === SCREEN_ID) refreshList();
    });

    // The toggle mirrors the pref, wherever the write came from (a bulk
    // reload after a native mirror restore surfaces as key === null).
    window.addEventListener('or:prefs', function (ev) {
      const d = ev && ev.detail;
      const key = d ? d.key : null;
      if (key == null || key === PROMPT_KEY) syncPromptToggle();
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
    syncPromptToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  // ── Public API (§2.7 — exactly this surface) ──────────────────────────────

  window.Thoughts = {
    openScreen: openScreen,
    close: close,
    open: open,
  };
})();
