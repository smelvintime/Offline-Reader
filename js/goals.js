// Offline Reader — goals & timers. See docs/mobile/PLAN.md §5 and
// docs/ARCHITECTURE.md.
//
// Reading goals (daily minutes, chapters and books per period, streaks), a
// quick wall-clock countdown timer, a floating in-reader pill, and the goals
// screen with its customize sheet. The engine OBSERVES the app rather than
// invading it: reading time comes from watching body[data-screen] +
// visibility, metric folds come from the `or:progress` and
// `or:upload-progress` window events, and nothing in reader.js,
// novel-reader.js or catalogue.js is ever called for tracking. Delete this
// file and the app runs exactly as before — the home slot stays empty, the
// toolbar button is never rendered, and the events go unheard.
//
// This module is the ONLY writer of the Store dayLogs table (contract §3):
// it reads, merges its own arrays in memory, and hands putDayLog a complete
// patch — the store just replaces fields.
//
// It is likewise the only writer of the `goals.lifetime` pref (PLAN7 §2.3):
// an all-time ledger fed by the very same fold deltas as the day log, seeded
// once from dayLogs, and deliberately KEPT when "Reset goal history" clears
// them. Its numbers follow the PLAN7 §1.2 rule — finite ≥ 0, fractions
// VALID: words accumulate as floats and persist unrounded, rounding is
// display-only — so the validator must never demand integers, or it would
// re-seed on every read and destroy the ledger it exists to keep.
//
// The folding edge cases of PLAN.md §5.1 are the spec, not decoration:
// baselines reset on chapter change (open zeroes positional fields, which
// would otherwise read as huge deltas), deltas clamp at zero, words need a
// positive finite wordCount, book-finish is chapterId equality against the
// series' LAST chapter (never num arithmetic alone — decimal finales), and
// booksFinished dedupes across the whole books period.

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const SCREEN_ID = 'goals-screen';
  const READER_SCREENS = { 'reader-screen': true, 'novel-screen': true };

  const TICK_MS = 1000;         // the 1 Hz pill/timer/idle tick — the ceiling for periodic work (§5.5)
  const FLUSH_MS = 30 * 1000;   // session seconds reach the DayLog at most this stale
  const TOAST_MS = 4000;

  // A tick gap this long means the webview was frozen, not that the reader
  // stared at a page for a minute — frozen spans must not mint reading time.
  // The visibilitychange→hidden handler normally pauses first; this is the
  // belt for the times iOS suspends without delivering it.
  const STALE_SPAN_MS = 5000;

  // How far back the streak walk and the aggregate reads go. DayLogs are one
  // row per day, so 400 rows is over a year of history — plenty for streaks,
  // and it bounds the recompute read even for multi-year libraries.
  const STREAK_SCAN_LIMIT = 400;

  const TIMER_KEY = 'or.timer'; // localStorage mirror; deliberately NOT in the native Preferences mirror (§5.1)

  const LIFETIME_KEY = 'goals.lifetime'; // the all-time ledger (PLAN7 §2.3); rides or.prefs → natively mirrored for free
  const LIFETIME_SEED_LIMIT = 4000;      // dayLog rows the one-time seed may read — over a decade of daily rows

  // ── DOM helpers ───────────────────────────────────────────────────────────

  // textContent-only element factory — every third-party string in this
  // module (series titles, mostly) flows through here or a direct
  // .textContent write. There is no innerHTML anywhere in this file, not
  // even for our own markup.
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Inline static icons, built programmatically for the same reason: the XSS
  // boundary stays absolute with zero innerHTML exceptions to reason about.
  // Shapes are ['p', pathData] or ['c', cx, cy, r]; opts.fill switches from
  // the stroked outline style to solid glyphs (play/pause/stop).
  function svgIcon(shapes, size, opts) {
    const o = opts || {};
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (o.fill) {
      svg.setAttribute('fill', 'currentColor');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', String(o.strokeWidth || 2.2));
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    shapes.forEach(function (s) {
      if (s[0] === 'c') {
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', String(s[1]));
        c.setAttribute('cy', String(s[2]));
        c.setAttribute('r', String(s[3]));
        svg.appendChild(c);
      } else {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', s[1]);
        svg.appendChild(p);
      }
    });
    return svg;
  }

  const ICONS = {
    back:    [['p', 'M15 18 L9 12 L15 6']],
    close:   [['p', 'M18 6 L6 18'], ['p', 'M6 6 L18 18']],
    sliders: [['p', 'M4 21v-7'], ['p', 'M4 10V3'], ['p', 'M12 21v-9'], ['p', 'M12 8V3'],
              ['p', 'M20 21v-5'], ['p', 'M20 12V3'], ['p', 'M2 14h4'], ['p', 'M10 12h4'], ['p', 'M18 16h4']],
    clock:   [['c', 12, 12, 9], ['p', 'M12 7v5l3 2']],
    chevron: [['p', 'M9 18 L15 12 L9 6']],
    play:    [['p', 'M6 4l14 8-14 8V4z']],
    pause:   [['p', 'M6 4h4v16H6z'], ['p', 'M14 4h4v16h-4z']],
    stop:    [['p', 'M6 6h12v12H6z']],
  };

  // ── Numeric / date helpers ────────────────────────────────────────────────

  function numOr0(v)  { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function intOr0(v)  { return (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function pad2(n)    { return String(n).padStart(2, '0'); }

  // DayLogs are keyed by LOCAL calendar day — reading at 23:50 belongs to the
  // day the reader experienced, not to UTC's opinion of it.
  function localDay(ms) {
    const d = ms != null ? new Date(ms) : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseDay(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return null;
    // Noon, not midnight: day arithmetic through a DST change must never
    // land on the wrong calendar date.
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0, 0);
  }

  function addDays(day, n) {
    const d = parseDay(day);
    if (!d) return day;
    return localDay(d.getTime() + n * 86400000);
  }

  // Monday-first weekday index, 0..6 — the axis goals.scheduleDays is written
  // on (`/^[01]{7}$/`, Mon..Sun).
  function mondayDow(day) {
    const d = parseDay(day);
    if (!d) return 0;
    return (d.getDay() + 6) % 7;
  }

  function weekStartOf(day)  { return addDays(day, -mondayDow(day)); }

  function periodStartOf(day, period) {
    const s = String(day || '');
    return period === 'year' ? s.slice(0, 4) + '-01-01' : s.slice(0, 7) + '-01';
  }

  // Epoch of the next local midnight after `day` — the tick compares against
  // this instead of formatting a date string every second.
  function dayEndEpoch(day) {
    const d = parseDay(day);
    if (!d) return Infinity;
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
    return end.getTime();
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  // The "since" line under the all-time tiles — a local date in the reader's
  // locale; the raw key is the fallback if formatting ever fails.
  function fmtSinceDay(dayStr) {
    const d = parseDay(dayStr);
    if (!d) return String(dayStr);
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return String(dayStr); }
  }

  // ── Guarded cross-module access ───────────────────────────────────────────

  function storeReady() {
    return !!(window.Store && typeof window.Store.getDayLog === 'function');
  }

  function prefGet(key, fallback) {
    try {
      if (window.Store && window.Store.prefs) return window.Store.prefs.get(key, fallback);
    } catch (e) { /* prefs down — defaults carry the feature */ }
    return fallback;
  }

  function prefGetFor(seriesId, key, fallback) {
    try {
      if (window.Store && window.Store.prefs) return window.Store.prefs.getFor(seriesId, key, fallback);
    } catch (e) {}
    return fallback;
  }

  function dispatchGoalsChanged() {
    try {
      window.dispatchEvent(new CustomEvent('or:goals-changed'));
    } catch (e) { /* a listener must never break the write it watched */ }
  }

  // Pref writes funnel through these two so every goal-pref change also emits
  // or:goals-changed (§5.2). The or:prefs event Store fires synchronously
  // does the re-render work — see the listener in wireEvents.
  function setGoalPref(key, value) {
    try {
      if (window.Store && window.Store.prefs) window.Store.prefs.set(key, value);
    } catch (e) {}
    dispatchGoalsChanged();
  }

  function setSeriesGoalPref(seriesId, key, value) {
    try {
      if (window.Store && window.Store.prefs) window.Store.prefs.setFor(seriesId, key, value);
    } catch (e) {}
    dispatchGoalsChanged();
  }

  function hapticSuccess() {
    try {
      if (window.Platform && typeof window.Platform.haptic === 'function') window.Platform.haptic('success');
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

  // ── Preferences (§5.1 table — every key validated on read, like novel.*) ──

  function readBool(key, dflt) {
    const v = prefGet(key, dflt);
    return typeof v === 'boolean' ? v : dflt;
  }

  function readEnum(key, values, dflt) {
    const v = prefGet(key, dflt);
    return values.indexOf(v) !== -1 ? v : dflt;
  }

  function readInt(key, dflt, lo, hi) {
    const v = prefGet(key, dflt);
    if (typeof v !== 'number' || !isFinite(v)) return dflt;
    return clamp(Math.round(v), lo, hi);
  }

  // timeTarget is `0 or 5..480`: zero is the off switch, anything else clamps
  // into the real range so a stray 3 becomes 5, not a nonsense goal.
  function readTimeTarget() {
    const v = prefGet('goals.timeTarget', 20);
    if (typeof v !== 'number' || !isFinite(v)) return 20;
    const n = Math.round(v);
    if (n <= 0) return 0;
    return clamp(n, 5, 480);
  }

  function readPattern(key, re, dflt) {
    const v = prefGet(key, dflt);
    return (typeof v === 'string' && re.test(v)) ? v : dflt;
  }

  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DAYS_RE = /^[01]{7}$/;

  function cfg() {
    return {
      enabled:        readBool('goals.enabled', true),
      timeTarget:     readTimeTarget(),
      schedule:       readEnum('goals.schedule', ['everyday', 'weekdays', 'custom'], 'everyday'),
      scheduleDays:   readPattern('goals.scheduleDays', DAYS_RE, '1111111'),
      booksTarget:    readInt('goals.booksTarget', 0, 0, 999),
      booksPeriod:    readEnum('goals.booksPeriod', ['month', 'year'], 'month'),
      chaptersTarget: readInt('goals.chaptersTarget', 0, 0, 999),
      chaptersPeriod: readEnum('goals.chaptersPeriod', ['day', 'week'], 'week'),
      streakRule:     readEnum('goals.streakRule', ['target', 'any'], 'target'),
      timerMinutes:   readInt('goals.timer.minutes', 20, 5, 180),
      timerAutostart: readBool('goals.timer.autostart', false),
      timerChime:     readBool('goals.timer.chime', true),
      pill:           readEnum('goals.pill', ['auto', 'off'], 'auto'),
      idleCutoff:     readInt('goals.idleCutoff', 5, 1, 30),
      reminderOn:     readBool('goals.reminder.enabled', false),
      reminderTime:   readPattern('goals.reminder.time', TIME_RE, '20:00'),
    };
  }

  function trackingOn() { return readBool('goals.enabled', true); }

  function includeSeries(seriesId) {
    // Per-series override, read at fold time (§5.1). Only an explicit false
    // excludes; any other value means the default: included.
    return prefGetFor(seriesId, 'goals.include', true) !== false;
  }

  // ── Module state ──────────────────────────────────────────────────────────

  function emptyDay() {
    return { seconds: 0, words: 0, pages: 0, chaptersCompleted: 0, booksFinished: [], seriesTouched: [] };
  }

  const day = {
    key: null,        // 'YYYY-MM-DD' the counters below belong to
    endsAt: Infinity, // epoch of the next local midnight — the rollover fast path
    data: emptyDay(),
    counted: new Set(), // seriesId\nchapterId completed today — chaptersCompleted counts each once per day
    loaded: false,      // stored row folded in; flushes are gated on this so a
                        // half-loaded day can never overwrite history
    dirty: false,
  };

  const baselines = new Map();       // seriesId → {chapterId, pct, pageIdx, completed}
  const uploadCompleted = new Map(); // 'upload:<key>' → last seen completed flag
  let finishedThisPeriod = new Set();// ids finished anywhere in the current books period
  let lastSeriesId = null;           // series behind the current reader session (time attribution)

  const session = {
    activeSince: null, // accrual cursor — epoch ms; null = clock paused
    lastActivity: 0,
    idle: false,
    paused: false,     // the pill's manual pause
  };

  let timer = null;          // { deadline: epochMs, minutes }
  let chimedDeadline = 0;    // the deadline we already chimed for — never twice

  const agg = { streak: 0, weekRows: [], chaptersPeriod: 0, booksPeriod: 0 };

  // The all-time ledger (PLAN7 §2.3). `data` accrues live deltas from init
  // onward, even before `loaded` — the loadDay idiom: whatever folds in early
  // sits on top of whatever the pref read / dayLog seed lands later.
  // `finishedToday` is the per-day book dedupe set: lifetime counts finish
  // EVENTS, once per book per local day, deliberately decoupled from the
  // mutable books-period setting (see foldLifetimeBookFinish).
  const lifetime = {
    data: { seconds: 0, words: 0, pages: 0, chapters: 0, books: 0 },
    since: null,              // 'YYYY-MM-DD' the totals count from
    finishedToday: new Set(), // cleared on day rollover, like day.counted
    loaded: false,            // pref read or seed finished; flushes gate on this
    seeding: false,           // a dayLog seed is in flight (abandoned if a valid pref arrives first)
    dirty: false,
  };

  let lastScreen = '';
  let lastFlushAt = 0;
  let recomputeGen = 0;
  let returnScreen = 'home-screen';
  let initialized = false;

  const ui = {};             // screen element handles
  const pillUi = {};         // pill element handles
  let slotUi = null;         // home-slot strip handles
  let toastEl = null;
  let toastTimer = 0;
  let sheetOpen = false;
  let lastFocus = null;
  const sheetSync = [];      // fn(cfg) refreshers — every sheet row pushes one

  function bodyScreen() {
    return (document.body && document.body.dataset && document.body.dataset.screen) || '';
  }

  // ── Day log plumbing (single writer, read-modify-write) ───────────────────

  async function loadDay() {
    const key = day.key;
    if (!storeReady()) { day.loaded = true; renderAll(); return; }
    let stored = null;
    try { stored = await window.Store.getDayLog(key); } catch (e) {}
    if (key !== day.key) return; // rolled over mid-read; the new day loads itself
    if (stored) {
      // The stored row is the base; whatever folded in before this read
      // landed sits on top. Arrays union, stored order first.
      day.data.seconds += numOr0(stored.seconds);
      day.data.words += numOr0(stored.words);
      day.data.pages += intOr0(stored.pages);
      day.data.chaptersCompleted += intOr0(stored.chaptersCompleted);
      day.data.booksFinished = unionIds(stored.booksFinished, day.data.booksFinished);
      day.data.seriesTouched = unionIds(stored.seriesTouched, day.data.seriesTouched);
    }
    day.loaded = true;
    renderAll();
  }

  function unionIds(a, b) {
    const out = [];
    const seen = new Set();
    [a, b].forEach(function (arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(function (id) {
        if (id == null) return;
        const s = String(id);
        if (!seen.has(s)) { seen.add(s); out.push(s); }
      });
    });
    return out;
  }

  async function persistDay(key, data) {
    if (!storeReady()) return;
    try {
      await window.Store.putDayLog(key, {
        seconds: Math.round(data.seconds),
        words: Math.round(data.words),
        pages: data.pages,
        chaptersCompleted: data.chaptersCompleted,
        booksFinished: data.booksFinished.slice(),
        seriesTouched: data.seriesTouched.slice(),
      });
    } catch (e) {
      console.warn('[Goals] dayLog write failed');
    }
    dispatchGoalsChanged();
    recompute();
  }

  function flushDay() {
    flushLifetime(); // the ledger rides every day-flush moment (§2.3 cadence)
    if (!day.dirty || !day.loaded) return;
    day.dirty = false;
    lastFlushAt = Date.now();
    persistDay(day.key, day.data);
  }

  function setDayKey(key) {
    day.key = key;
    day.endsAt = dayEndEpoch(key);
  }

  function rolloverIfNeeded(now) {
    if (now < day.endsAt) return false;
    const today = localDay(now);
    if (today === day.key) return false;
    // Whatever the session clock accrued up to this instant belongs to the
    // finishing day; the seconds that straddle midnight land on the old side,
    // bounded by the flush cadence.
    collectSession(now);
    if (day.loaded && day.dirty) {
      day.dirty = false;
      persistDay(day.key, day.data);
    }
    flushLifetime(); // bank the straddling seconds on the ledger too
    setDayKey(today);
    day.data = emptyDay();
    day.counted.clear(); // the per-day chapter dedupe set is exactly per-day
    lifetime.finishedToday.clear(); // the lifetime book dedupe is per-day too (§2.3)
    day.loaded = false;
    day.dirty = false;
    lastFlushAt = now;
    loadDay();
    recompute();
    return true;
  }

  function touchSeries(id) {
    if (day.data.seriesTouched.indexOf(id) === -1) {
      day.data.seriesTouched.push(id);
      day.dirty = true;
    }
  }

  // ── Lifetime ledger (PLAN7 §2.3 — single writer, like dayLogs) ────────────

  // Validated on read, like every pref. Malformed = missing key, wrong type,
  // non-finite or negative number, or a bad `since` — and NOTHING else:
  // fractional numbers are VALID (words persist as floats), and unknown
  // extra keys are ignored, never malformed, so an additive future field
  // cannot nuke the totals. Only a malformed read re-seeds (§1.2).
  function readLifetimePref() {
    let raw = prefGet(LIFETIME_KEY, null);
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return null; } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = { seconds: 0, words: 0, pages: 0, chapters: 0, books: 0, since: null };
    const keys = ['seconds', 'words', 'pages', 'chapters', 'books'];
    for (let i = 0; i < keys.length; i++) {
      const v = raw[keys[i]];
      if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
      out[keys[i]] = v; // fractions kept as-is — never floored, never a reason to re-seed
    }
    if (typeof raw.since !== 'string' || !parseDay(raw.since)) return null;
    out.since = raw.since;
    return out;
  }

  // Synchronous and cheap (prefs are localStorage), so it can piggyback every
  // day-flush moment. Persists a fresh copy, never the live object, and
  // stores words UNROUNDED — persistDay's Math.round is for dayLogs only.
  function persistLifetime() {
    try {
      if (window.Store && window.Store.prefs) {
        window.Store.prefs.set(LIFETIME_KEY, {
          seconds: lifetime.data.seconds,
          words: lifetime.data.words,
          pages: lifetime.data.pages,
          chapters: lifetime.data.chapters,
          books: lifetime.data.books,
          since: lifetime.since,
        });
      }
    } catch (e) { /* quota — the in-memory ledger still runs this session */ }
  }

  function flushLifetime() {
    if (!lifetime.dirty || !lifetime.loaded) return;
    lifetime.dirty = false;
    persistLifetime();
  }

  function bumpLifetime(key, delta) {
    if (!(delta > 0)) return;
    lifetime.data[key] += delta;
    lifetime.dirty = true;
  }

  // Lifetime measures finish EVENTS: one increment per book per local day,
  // decoupled from the goal period — an all-time ledger must not depend on
  // the current (mutable) books-period setting. Dedupe is this per-day set
  // PLUS today's day-log array, which covers a mid-day reload where the
  // earlier finish only exists in the stored row loadDay merged in. Runs
  // BEFORE foldBookFinish at both call sites — the entry that call pushes
  // must not mask a legitimate first count — and a later-day re-finish
  // inside one goal period still counts here while foldBookFinish dedupes
  // it away. Re-reading a book on a later day counts again, by design.
  function foldLifetimeBookFinish(id) {
    if (lifetime.finishedToday.has(id)) return;
    if (day.data.booksFinished.indexOf(id) !== -1) return;
    lifetime.finishedToday.add(id);
    bumpLifetime('books', 1);
    flushLifetime(); // a finished book is worth an immediate write (the foldBookFinish rule)
  }

  // At init: a pref that parses clean is adopted VERBATIM and never
  // re-seeded — resets are the reader's, not the app's. Absent or malformed
  // → reconstruct from dayLogs.
  function initLifetime() {
    const p = readLifetimePref();
    if (p) {
      lifetime.data = { seconds: p.seconds, words: p.words, pages: p.pages, chapters: p.chapters, books: p.books };
      lifetime.since = p.since;
      lifetime.loaded = true;
      return;
    }
    lifetime.seeding = true;
    seedLifetime();
  }

  // One-time reconstruction. Books = the sum of booksFinished lengths across
  // days (consistent with the per-day increment rule); since = the earliest
  // day found (today when none). Honest caveat: a re-seed is a FLOOR, not an
  // exact replay — the engine suppresses same-period re-finish rows in later
  // day logs, and dayLog words were rounded at write. The sums land ON TOP
  // of whatever folded in while the read was in flight (the loadDay idiom);
  // the sliver of double-count risk in that window is the same class the day
  // loader accepts, and the seed can fire at most once per install.
  async function seedLifetime() {
    let rows = [];
    if (storeReady()) {
      try { rows = (await window.Store.listDayLogs({ limit: LIFETIME_SEED_LIMIT })) || []; } catch (e) { rows = []; }
    }
    if (!lifetime.seeding) return; // a valid pref arrived mid-read (bulk reload / reset) — it wins
    lifetime.seeding = false;
    let earliest = null;
    rows.forEach(function (r) {
      if (!r) return;
      lifetime.data.seconds  += Math.max(0, numOr0(r.seconds));
      lifetime.data.words    += Math.max(0, numOr0(r.words));
      lifetime.data.pages    += Math.max(0, numOr0(r.pages));
      lifetime.data.chapters += Math.max(0, numOr0(r.chaptersCompleted));
      if (Array.isArray(r.booksFinished)) lifetime.data.books += r.booksFinished.length;
      const k = r.day != null ? String(r.day) : '';
      if (parseDay(k) && (earliest == null || k < earliest)) earliest = k;
    });
    lifetime.since = earliest || day.key || localDay();
    lifetime.loaded = true;
    lifetime.dirty = false;
    persistLifetime();
    renderScreen();
  }

  // Live re-adoption: the pref blob can be rewritten under us — the platform
  // mirror restore after a WebKit eviction, or a sibling tab — and both
  // surface as or:prefs events. A valid incoming ledger replaces the
  // in-memory one so the next flush cannot clobber restored history; an
  // invalid one changes nothing (re-seeding is init-only). Our own flushes
  // re-read as identical values, so adoption is idempotent.
  function adoptLifetimeFromPref() {
    const p = readLifetimePref();
    if (!p) return;
    lifetime.data = { seconds: p.seconds, words: p.words, pages: p.pages, chapters: p.chapters, books: p.books };
    lifetime.since = p.since;
    lifetime.loaded = true;
    lifetime.seeding = false;
    lifetime.dirty = false;
    renderScreen();
  }

  // ── Aggregates: streak, week chart, period counts ─────────────────────────

  function anyReading(log) {
    return !!log && (numOr0(log.seconds) > 0 || numOr0(log.words) > 0 || numOr0(log.pages) > 0
      || intOr0(log.chaptersCompleted) > 0
      || (Array.isArray(log.booksFinished) && log.booksFinished.length > 0));
  }

  function dayMet(log, c) {
    if (c.streakRule === 'target' && c.timeTarget > 0) {
      return !!log && numOr0(log.seconds) >= c.timeTarget * 60;
    }
    // Rule 'any' — or a target rule with the time goal switched off, where
    // "met the goal" has nothing to measure against.
    return anyReading(log);
  }

  function onSchedule(dayStr, c) {
    const dow = mondayDow(dayStr);
    if (c.schedule === 'weekdays') return dow < 5;
    if (c.schedule === 'custom') return c.scheduleDays.charAt(dow) === '1';
    return true;
  }

  // Walk backward from today. A met day extends the streak wherever it falls;
  // an unmet off-schedule day is skipped (rest days never break — §5.1, and
  // there is deliberately NO extra forgiveness rule, §11.10); an unmet
  // on-schedule day breaks — except today, which is still in progress.
  function computeStreak(byDay, oldestDay, todayKey, c) {
    let streak = 0;
    let cursor = todayKey;
    for (let i = 0; i < STREAK_SCAN_LIMIT; i++) {
      if (dayMet(byDay[cursor], c)) streak += 1;
      else if (!onSchedule(cursor, c)) { /* skipped */ }
      else if (cursor === todayKey) { /* the day is not over yet */ }
      else break;
      if (oldestDay == null || cursor <= oldestDay) break;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  async function recompute() {
    const gen = ++recomputeGen;
    const c = cfg();
    const todayKey = day.key || localDay();
    let rows = [];
    if (storeReady()) {
      try { rows = (await window.Store.listDayLogs({ until: todayKey, limit: STREAK_SCAN_LIMIT })) || []; } catch (e) { rows = []; }
    }
    if (gen !== recomputeGen) return; // a newer pass owns the caches now

    const byDay = {};
    let oldest = todayKey;
    rows.forEach(function (r) {
      if (!r || !r.day) return;
      const k = String(r.day);
      byDay[k] = r;
      if (k < oldest) oldest = k;
    });
    byDay[todayKey] = day.data; // live counters beat the stored row

    agg.streak = computeStreak(byDay, oldest, todayKey, c);

    const weekRows = [];
    for (let i = 6; i >= 0; i--) {
      const k = addDays(todayKey, -i);
      const log = byDay[k];
      weekRows.push({
        day: k,
        seconds: log ? numOr0(log.seconds) : 0,
        met: dayMet(log, c),
        today: k === todayKey,
      });
    }
    agg.weekRows = weekRows;

    if (c.chaptersPeriod === 'day') {
      agg.chaptersPeriod = intOr0(day.data.chaptersCompleted);
    } else {
      const start = weekStartOf(todayKey);
      let n = 0;
      Object.keys(byDay).forEach(function (k) {
        if (k >= start && k <= todayKey) n += intOr0(byDay[k].chaptersCompleted);
      });
      agg.chaptersPeriod = n;
    }

    // Books this period — and the set the fold-time dedupe checks, so a
    // series finished on the 3rd cannot be re-counted on the 14th (§5.1).
    const pStart = periodStartOf(todayKey, c.booksPeriod);
    const finished = new Set();
    Object.keys(byDay).forEach(function (k) {
      if (k < pStart || k > todayKey) return;
      const arr = byDay[k].booksFinished;
      if (Array.isArray(arr)) arr.forEach(function (id) { if (id != null) finished.add(String(id)); });
    });
    finishedThisPeriod = finished;
    agg.booksPeriod = finished.size;

    renderAll();
  }

  // ── Folding: or:progress ──────────────────────────────────────────────────

  function chapterWordCount(seriesId, chapterId) {
    try {
      const C = window.Catalogue;
      if (!C || typeof C.getSeries !== 'function') return null;
      const s = C.getSeries(seriesId);
      const chs = s && Array.isArray(s.chapters) ? s.chapters : null;
      if (!chs) return null;
      for (let i = 0; i < chs.length; i++) {
        if (chs[i] && String(chs[i].id) === chapterId) return chs[i].wordCount;
      }
    } catch (e) {}
    return null;
  }

  // The finale's id, by ascending num — the catalogue's own reading-order
  // rule (orderedChapters). A decimal finale (num 271.5 over chapterCount
  // 271) sorts last here and is caught by ID equality where num arithmetic
  // never would be.
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
    // Last resort only — no series object reachable. Plain equality; `num`
    // may be null and decimal finales will not match, which is the accepted
    // cost of the fallback (§5.1).
    return typeof row.chapterNum === 'number' && typeof row.chapterCount === 'number'
      && row.chapterCount > 0 && row.chapterNum === row.chapterCount;
  }

  function foldBookFinish(id) {
    if (day.data.booksFinished.indexOf(id) !== -1) return;
    if (finishedThisPeriod.has(id)) return;
    day.data.booksFinished.push(id);
    finishedThisPeriod.add(id);
    day.dirty = true;
    flushDay(); // a finished book is worth an immediate write
  }

  function onProgress(ev) {
    const d = ev && ev.detail;
    if (!d || !d.seriesId || !d.row || typeof d.row !== 'object') return;
    lastSeriesId = String(d.seriesId);
    const now = Date.now();
    if (!trackingOn()) { recomputeActive(now); return; }
    const included = includeSeries(lastSeriesId);
    recomputeActive(now); // an excluded series pauses the session clock from this row on
    if (!included) return;
    rolloverIfNeeded(now);

    const row = d.row;
    const chapterId = row.chapterId != null ? String(row.chapterId) : '';
    let b = baselines.get(lastSeriesId);

    if (!b || b.chapterId !== chapterId) {
      // Chapter changed (or first sight of this series): writeOpenProgress
      // zeroes positional fields on open, so folding THIS event would read as
      // a large clamped-away backward jump or a spurious forward one. Reset
      // the baseline and fold nothing positional (§5.1).
      b = {
        chapterId: chapterId,
        pct: clamp01(numOr0(row.pct)),
        pageIdx: Math.max(0, intOr0(row.pageIdx)),
        completed: !!row.completed,
      };
      baselines.set(lastSeriesId, b);
    } else {
      const pct = clamp01(numOr0(row.pct));
      const pctDelta = Math.max(0, pct - b.pct); // backward jumps and re-reads contribute 0, never negative
      if (pctDelta > 0) {
        const wc = chapterWordCount(lastSeriesId, chapterId);
        if (typeof wc === 'number' && isFinite(wc) && wc > 0) {
          day.data.words += pctDelta * wc;
          bumpLifetime('words', pctDelta * wc); // the same fractional delta, unrounded (§1.2)
          day.dirty = true;
        }
        // Unknown wordCount → 0 words; the session clock still counts the time.
      }
      b.pct = pct;

      if (typeof row.pageIdx === 'number' && isFinite(row.pageIdx)) {
        const pageIdx = Math.max(0, Math.floor(row.pageIdx));
        const pageDelta = Math.max(0, pageIdx - b.pageIdx);
        if (pageDelta > 0) {
          day.data.pages += pageDelta;
          bumpLifetime('pages', pageDelta);
          day.dirty = true;
        }
        b.pageIdx = pageIdx;
      }

      if (!b.completed && row.completed) {
        // completed flipped false → true — count the chapter once per day.
        const ck = lastSeriesId + '\n' + chapterId;
        if (!day.counted.has(ck)) {
          day.counted.add(ck);
          day.data.chaptersCompleted += 1;
          bumpLifetime('chapters', 1);
          day.dirty = true;
        }
      }
      b.completed = !!row.completed;
    }

    touchSeries(lastSeriesId);
    if (isBookFinish(lastSeriesId, row)) {
      foldLifetimeBookFinish(lastSeriesId); // before foldBookFinish — the order is load-bearing (see the fn)
      foldBookFinish(lastSeriesId);
    }
  }

  // ── Folding: or:upload-progress (§6.3) ────────────────────────────────────

  function onUploadProgress(ev) {
    const d = ev && ev.detail;
    if (!d || !d.libraryKey) return;
    if (!trackingOn()) return;
    rolloverIfNeeded(Date.now());
    // Uploads count under the 'upload:' identity. There is no exclusion UI
    // for them until Store unification (§11.6) — they always count, on
    // purpose. The deltas arrive ≥0 by the reader's high-water construction;
    // the clamps here are belt over that contract.
    const id = 'upload:' + String(d.libraryKey);
    const pages = Math.max(0, intOr0(d.pagesDelta));
    const chapters = Math.max(0, intOr0(d.chaptersDelta));
    if (pages > 0) { day.data.pages += pages; bumpLifetime('pages', pages); day.dirty = true; }
    if (chapters > 0) { day.data.chaptersCompleted += chapters; bumpLifetime('chapters', chapters); day.dirty = true; }
    touchSeries(id);
    const prev = uploadCompleted.get(id) === true;
    if (d.completed && !prev) {
      foldLifetimeBookFinish(id); // before foldBookFinish, same as the reader path
      foldBookFinish(id);
    }
    uploadCompleted.set(id, !!d.completed);
  }

  // ── Session / time engine ─────────────────────────────────────────────────

  function currentSeriesExcluded() {
    return !!(lastSeriesId && !includeSeries(lastSeriesId));
  }

  // Slide the accrual cursor to `now`, banking the span it covered. Called
  // from the 1 Hz tick and from every pause path, so a single span is ~1 s;
  // anything past STALE_SPAN_MS is a frozen webview, not reading.
  function collectSession(now) {
    if (!session.activeSince) return;
    const span = now - session.activeSince;
    if (span > 0 && span <= STALE_SPAN_MS) {
      day.data.seconds += span / 1000;
      bumpLifetime('seconds', span / 1000); // the same clamped span feeds the ledger (§2.3 session fold)
      day.dirty = true;
    }
    session.activeSince = now;
  }

  function recomputeActive(now) {
    const run = trackingOn()
      && READER_SCREENS[bodyScreen()] === true
      && document.visibilityState !== 'hidden'
      && !session.paused
      && !session.idle
      && !currentSeriesExcluded();
    if (run && !session.activeSince) {
      session.activeSince = now;
    } else if (!run && session.activeSince) {
      collectSession(now);
      session.activeSince = null;
      flushDay(); // pause is one of the named flush moments (§5.1)
    }
  }

  function onActivity() {
    // Deliberately nothing but a timestamp — this runs on capture-phase
    // scroll and must never do rendering work (§5.5).
    session.lastActivity = Date.now();
    if (session.idle) {
      session.idle = false;
      recomputeActive(session.lastActivity);
    }
  }

  function onVisibility() {
    const now = Date.now();
    if (document.visibilityState === 'hidden') {
      collectSession(now);
      session.activeSince = null;
      flushDay();
      return;
    }
    // Back to the foreground: recompute the countdown from the wall clock —
    // a deadline that passed while hidden chimes exactly once, here.
    session.lastActivity = now;
    session.idle = false;
    checkTimerExpiry(now);
    rolloverIfNeeded(now);
    recomputeActive(now);
    renderPillTick(now);
  }

  function onPageHide() {
    const now = Date.now();
    collectSession(now);
    session.activeSince = null;
    flushDay();
  }

  function onScreenMaybeChanged() {
    const s = bodyScreen();
    if (s === lastScreen) return;
    const wasReader = READER_SCREENS[lastScreen] === true;
    const isReader = READER_SCREENS[s] === true;
    lastScreen = s;
    const now = Date.now();
    if (wasReader && !isReader) {
      collectSession(now);
      session.activeSince = null;
      flushDay();
      lastSeriesId = null; // exclusion attribution must not leak into the next session
      session.paused = false;
      session.idle = false;
    }
    if (isReader && !wasReader) {
      session.paused = false;
      session.idle = false;
      session.lastActivity = now;
      if (cfg().timerAutostart && !timer) startTimer();
    }
    recomputeActive(now);
    updatePillVisibility();
    renderPillTick(now);
    if (s === 'home-screen') renderSlot();
    if (s === SCREEN_ID) renderScreen();
  }

  // ── The 1 Hz tick ─────────────────────────────────────────────────────────

  function tick() {
    const now = Date.now();
    rolloverIfNeeded(now);
    if (session.activeSince) {
      collectSession(now);
      if (now - session.lastActivity > cfg().idleCutoff * 60000) {
        session.idle = true;
        recomputeActive(now); // pauses and flushes
      }
    }
    checkTimerExpiry(now);
    if (day.dirty && day.loaded && now - lastFlushAt >= FLUSH_MS) flushDay();
    renderPillTick(now);
  }

  // ── Countdown timer (wall-clock — iOS freezes background JS, §5.1) ────────

  function restoreTimer() {
    let raw = null;
    try { raw = localStorage.getItem(TIMER_KEY); } catch (e) {}
    if (!raw) return;
    let s = null;
    try { s = JSON.parse(raw); } catch (e) {}
    const now = Date.now();
    if (s && typeof s.deadline === 'number' && isFinite(s.deadline) && s.deadline > now) {
      timer = {
        deadline: s.deadline,
        minutes: (typeof s.minutes === 'number' && isFinite(s.minutes) && s.minutes > 0) ? s.minutes : cfg().timerMinutes,
      };
    } else {
      // Expired while the app was gone (or killed): chiming now, minutes or
      // days after the fact, would be noise — discard silently (§5.1).
      try { localStorage.removeItem(TIMER_KEY); } catch (e) {}
    }
  }

  function writeTimerMirror() {
    try {
      if (timer) localStorage.setItem(TIMER_KEY, JSON.stringify({ deadline: timer.deadline, minutes: timer.minutes }));
      else localStorage.removeItem(TIMER_KEY);
    } catch (e) { /* quota — the in-memory countdown still runs this session */ }
  }

  function startTimer(minutes) {
    // The pref path is validated (5..180); an explicit argument is app
    // internal and only sanity-bounded, so short test countdowns work.
    const m = (typeof minutes === 'number' && isFinite(minutes) && minutes > 0 && minutes <= 1440)
      ? minutes : cfg().timerMinutes;
    timer = { deadline: Date.now() + m * 60000, minutes: m };
    chimedDeadline = 0;
    writeTimerMirror();
    renderPillTick(Date.now());
    renderScreen();
  }

  function stopTimer() {
    if (!timer) return;
    timer = null;
    writeTimerMirror();
    renderPillTick(Date.now());
    renderScreen();
  }

  function checkTimerExpiry(now) {
    if (!timer || now < timer.deadline) return;
    const deadline = timer.deadline;
    timer = null;
    writeTimerMirror();
    if (chimedDeadline !== deadline) {
      chimedDeadline = deadline;
      if (cfg().timerChime) {
        toast('Reading timer done');
        hapticSuccess();
      }
    }
    renderPillTick(now);
    renderScreen();
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  function buildToast() {
    toastEl = el('div', 'gl-toast');
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('visible'); }, TOAST_MS);
  }

  // ── Floating pill (the #autoscroll-bar template — solid, no blur) ─────────

  function buildPill() {
    const root = el('div');
    root.id = 'gl-pill';
    root.className = 'gl-hidden';

    const main = el('button', 'gl-pill-main');
    main.type = 'button';
    main.setAttribute('aria-label', 'Reading goals');
    main.setAttribute('aria-expanded', 'false');
    main.appendChild(svgIcon(ICONS.clock, 16));
    const label = el('span', 'gl-pill-label', '0m');
    main.appendChild(label);
    root.appendChild(main);

    const more = el('div', 'gl-pill-more');
    more.hidden = true;
    more.appendChild(el('div', 'gl-pill-divider'));
    const today = el('span', 'gl-pill-today', '');
    more.appendChild(today);

    const pauseBtn = el('button', 'gl-pill-btn');
    pauseBtn.type = 'button';
    pauseBtn.setAttribute('aria-label', 'Pause goal tracking');
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.appendChild(svgIcon(ICONS.pause, 14, { fill: true }));
    more.appendChild(pauseBtn);

    const timerBtn = el('button', 'gl-pill-btn');
    timerBtn.type = 'button';
    timerBtn.setAttribute('aria-label', 'Start reading timer');
    const playIcon = svgIcon(ICONS.play, 14, { fill: true });
    const stopIcon = svgIcon(ICONS.stop, 14, { fill: true });
    stopIcon.style.display = 'none';
    timerBtn.appendChild(playIcon);
    timerBtn.appendChild(stopIcon);
    more.appendChild(timerBtn);

    root.appendChild(more);

    main.addEventListener('click', function () {
      const expand = more.hidden;
      more.hidden = !expand;
      main.setAttribute('aria-expanded', String(expand));
      renderPillTick(Date.now());
    });
    pauseBtn.addEventListener('click', function () {
      session.paused = !session.paused;
      session.lastActivity = Date.now();
      session.idle = false;
      recomputeActive(Date.now());
      renderPillTick(Date.now());
    });
    timerBtn.addEventListener('click', function () {
      if (timer) stopTimer(); else startTimer();
    });

    pillUi.root = root;
    pillUi.main = main;
    pillUi.label = label;
    pillUi.more = more;
    pillUi.today = today;
    pillUi.pauseBtn = pauseBtn;
    pillUi.timerBtn = timerBtn;
    pillUi.playIcon = playIcon;
    pillUi.stopIcon = stopIcon;
    document.body.appendChild(root);
  }

  function pillVisible() {
    return !!(pillUi.root && !pillUi.root.classList.contains('gl-hidden'));
  }

  // Visibility is managed on data-screen changes only (§5.2) — the pill does
  // not chase the readers' chrome auto-hide.
  function updatePillVisibility() {
    if (!pillUi.root) return;
    const show = trackingOn() && cfg().pill !== 'off' && READER_SCREENS[bodyScreen()] === true;
    pillUi.root.classList.toggle('gl-hidden', !show);
    if (!show && pillUi.more && !pillUi.more.hidden) {
      pillUi.more.hidden = true;
      pillUi.main.setAttribute('aria-expanded', 'false');
    }
  }

  function setText(node, text) {
    // 1 Hz updates skip identical writes so the pill never causes layout work
    // while nothing changed.
    if (node && node.textContent !== text) node.textContent = text;
  }

  function renderPillTick(now) {
    if (!pillVisible()) return;
    const c = cfg();
    const running = !!timer;
    if (pillUi.root.dataset.timer !== String(running)) pillUi.root.dataset.timer = String(running);
    // The countdown renders deadline − now, never accumulated ticks — a
    // frozen interval cannot drift it (§5.1).
    setText(pillUi.label, running ? fmtClock(timer.deadline - now) : Math.floor(day.data.seconds / 60) + 'm');
    if (!pillUi.more.hidden) {
      const mins = Math.floor(day.data.seconds / 60);
      setText(pillUi.today, c.timeTarget > 0 ? mins + ' / ' + c.timeTarget + ' min today' : mins + ' min today');
      const pausedNow = session.paused;
      if (pillUi.pauseBtn.getAttribute('aria-pressed') !== String(pausedNow)) {
        pillUi.pauseBtn.setAttribute('aria-pressed', String(pausedNow));
        pillUi.pauseBtn.setAttribute('aria-label', pausedNow ? 'Resume goal tracking' : 'Pause goal tracking');
      }
      const wantStop = running;
      if ((pillUi.stopIcon.style.display === 'none') === wantStop) {
        pillUi.stopIcon.style.display = wantStop ? '' : 'none';
        pillUi.playIcon.style.display = wantStop ? 'none' : '';
        pillUi.timerBtn.setAttribute('aria-label', wantStop ? 'Stop reading timer' : 'Start reading timer');
      }
    }
  }

  // ── Goals screen ──────────────────────────────────────────────────────────

  function iconBtn(label, iconShapes) {
    const b = el('button', 'gl-icon-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.appendChild(svgIcon(iconShapes, 20));
    return b;
  }

  function statTile(label) {
    const tile = el('div', 'gl-stat');
    const value = el('div', 'gl-stat-value', '0');
    tile.appendChild(value);
    tile.appendChild(el('div', 'gl-stat-label', label));
    return { tile: tile, value: value, label: tile.lastChild };
  }

  function goalCard(label) {
    const card = el('div', 'gl-card');
    card.appendChild(el('div', 'gl-card-label', label));
    const line = el('div', 'gl-card-line');
    const value = el('span', 'gl-card-value', '');
    const sub = el('span', 'gl-card-sub', '');
    line.appendChild(value);
    line.appendChild(sub);
    card.appendChild(line);
    const track = el('div', 'gl-bar-track');
    const bar = el('div', 'gl-bar');
    track.appendChild(bar);
    card.appendChild(track);
    return { card: card, labelEl: card.firstChild, value: value, sub: sub, bar: bar };
  }

  function buildScreen() {
    const root = el('div');
    root.id = SCREEN_ID;

    const header = el('div', 'gl-header');
    const backBtn = iconBtn('Back', ICONS.back);
    backBtn.addEventListener('click', function () { close(); });
    header.appendChild(backBtn);
    header.appendChild(el('div', 'gl-title', 'Goals'));
    const customizeBtn = iconBtn('Customize goals', ICONS.sliders);
    customizeBtn.setAttribute('aria-expanded', 'false');
    customizeBtn.addEventListener('click', function () { openSheet(); });
    header.appendChild(customizeBtn);
    root.appendChild(header);

    const body = el('div', 'gl-body');
    const view = el('div', 'gl-view');
    body.appendChild(view);
    root.appendChild(body);

    // Stats strip — the .cat-stats tile pattern.
    const stats = el('div', 'gl-stats');
    ui.statStreak = statTile('day streak');
    ui.statMinutes = statTile('min today');
    ui.statPagesChapters = statTile('pages / chapters');
    ui.statBooks = statTile('books this month');
    stats.appendChild(ui.statStreak.tile);
    stats.appendChild(ui.statMinutes.tile);
    stats.appendChild(ui.statPagesChapters.tile);
    stats.appendChild(ui.statBooks.tile);
    view.appendChild(stats);

    // All-time ledger — directly under the period stats, same tile grammar
    // (§2.3). Always rendered, zeros included: history that survives a reset
    // should look like a fixture, not a reward.
    const lifetimeSection = el('section', 'gl-lifetime');
    lifetimeSection.appendChild(el('div', 'gl-card-label', 'All time'));
    const ltStats = el('div', 'gl-stats');
    ui.ltHours = statTile('hours read');
    ui.ltWords = statTile('words');
    ui.ltPages = statTile('pages');
    ui.ltChapters = statTile('chapters');
    ui.ltBooks = statTile('books');
    ltStats.appendChild(ui.ltHours.tile);
    ltStats.appendChild(ui.ltWords.tile);
    ltStats.appendChild(ui.ltPages.tile);
    ltStats.appendChild(ui.ltChapters.tile);
    ltStats.appendChild(ui.ltBooks.tile);
    lifetimeSection.appendChild(ltStats);
    ui.ltSince = el('div', 'gl-lifetime-since', '');
    lifetimeSection.appendChild(ui.ltSince);
    view.appendChild(lifetimeSection);

    ui.offNote = el('div', 'gl-card');
    ui.offNote.hidden = true;
    ui.offNote.appendChild(el('div', 'gl-off-note',
      'Goal tracking is off. Nothing is being counted — turn it back on under Customize.'));
    view.appendChild(ui.offNote);

    ui.timeCard = goalCard('Daily reading time');
    view.appendChild(ui.timeCard.card);
    ui.chaptersCard = goalCard('Chapters this week');
    view.appendChild(ui.chaptersCard.card);
    ui.booksCard = goalCard('Books this month');
    view.appendChild(ui.booksCard.card);

    // 7-day chart — plain divs with height percentages, textContent labels.
    const chartCard = el('div', 'gl-card');
    chartCard.appendChild(el('div', 'gl-card-label', 'Last 7 days'));
    const chart = el('div', 'gl-chart');
    ui.chartCols = [];
    for (let i = 0; i < 7; i++) {
      const col = el('div', 'gl-chart-col');
      const val = el('div', 'gl-chart-val', '');
      const well = el('div', 'gl-chart-well');
      const bar = el('div', 'gl-chart-bar');
      well.appendChild(bar);
      const dayLabel = el('div', 'gl-chart-day', '');
      col.appendChild(val);
      col.appendChild(well);
      col.appendChild(dayLabel);
      chart.appendChild(col);
      ui.chartCols.push({ col: col, val: val, bar: bar, day: dayLabel });
    }
    chartCard.appendChild(chart);
    view.appendChild(chartCard);

    // Quick timer.
    const timerCard = el('div', 'gl-card');
    timerCard.appendChild(el('div', 'gl-card-label', 'Quick timer'));
    const timerRow = el('div', 'gl-timer-row');
    ui.timerRemaining = el('span', 'gl-timer-remaining', '');
    timerRow.appendChild(ui.timerRemaining);
    ui.timerBtn = el('button', 'gl-btn', 'Start');
    ui.timerBtn.type = 'button';
    ui.timerBtn.addEventListener('click', function () {
      if (timer) stopTimer(); else startTimer();
    });
    timerRow.appendChild(ui.timerBtn);
    timerCard.appendChild(timerRow);
    view.appendChild(timerCard);

    ui.customize = el('button', 'gl-primary', 'Customize');
    ui.customize.type = 'button';
    ui.customize.setAttribute('aria-expanded', 'false');
    ui.customize.addEventListener('click', function () { openSheet(); });
    view.appendChild(ui.customize);

    buildSheet(root);

    ui.root = root;
    ui.header = header;
    ui.body = body;
    ui.customizeBtn = customizeBtn;
    document.body.appendChild(root);
    if (typeof window.registerScreen === 'function') window.registerScreen(root);
  }

  function fmtPct(part, whole) {
    if (!(whole > 0)) return 0;
    return clamp(Math.round((part / whole) * 100), 0, 100);
  }

  function renderScreen() {
    if (!ui.root) return;
    const c = cfg();
    const mins = Math.floor(day.data.seconds / 60);
    const timeMet = c.timeTarget > 0 && day.data.seconds >= c.timeTarget * 60;

    ui.offNote.hidden = c.enabled;

    setText(ui.statStreak.value, String(agg.streak));
    setText(ui.statMinutes.value, String(mins));
    ui.statMinutes.tile.dataset.met = String(timeMet);
    setText(ui.statPagesChapters.value, day.data.pages + ' / ' + day.data.chaptersCompleted);
    setText(ui.statBooks.value, String(agg.booksPeriod));
    setText(ui.statBooks.label, c.booksPeriod === 'year' ? 'books this year' : 'books this month');

    // All-time ledger — rounding happens HERE and only here (§1.2): storage
    // keeps the floats. Hours show one decimal under 100.
    const lt = lifetime.data;
    const hours = lt.seconds / 3600;
    setText(ui.ltHours.value, hours < 100 ? hours.toFixed(1) : Math.round(hours).toLocaleString());
    setText(ui.ltWords.value, Math.round(lt.words).toLocaleString());
    setText(ui.ltPages.value, Math.round(lt.pages).toLocaleString());
    setText(ui.ltChapters.value, Math.round(lt.chapters).toLocaleString());
    setText(ui.ltBooks.value, Math.round(lt.books).toLocaleString());
    setText(ui.ltSince, lifetime.since ? 'since ' + fmtSinceDay(lifetime.since) : '');

    // Time goal card.
    ui.timeCard.card.hidden = !(c.enabled && c.timeTarget > 0);
    if (!ui.timeCard.card.hidden) {
      setText(ui.timeCard.value, mins + ' / ' + c.timeTarget + ' min');
      setText(ui.timeCard.sub, c.schedule === 'weekdays' ? 'weekdays'
        : (c.schedule === 'custom' ? 'custom days' : 'every day'));
      ui.timeCard.bar.style.width = fmtPct(day.data.seconds, c.timeTarget * 60) + '%';
      ui.timeCard.card.dataset.met = String(timeMet);
    }

    // Chapters goal card.
    ui.chaptersCard.card.hidden = !(c.enabled && c.chaptersTarget > 0);
    if (!ui.chaptersCard.card.hidden) {
      setText(ui.chaptersCard.labelEl, c.chaptersPeriod === 'day' ? 'Chapters today' : 'Chapters this week');
      setText(ui.chaptersCard.value, agg.chaptersPeriod + ' / ' + c.chaptersTarget);
      setText(ui.chaptersCard.sub, '');
      ui.chaptersCard.bar.style.width = fmtPct(agg.chaptersPeriod, c.chaptersTarget) + '%';
      ui.chaptersCard.card.dataset.met = String(agg.chaptersPeriod >= c.chaptersTarget);
    }

    // Books goal card.
    ui.booksCard.card.hidden = !(c.enabled && c.booksTarget > 0);
    if (!ui.booksCard.card.hidden) {
      setText(ui.booksCard.labelEl, c.booksPeriod === 'year' ? 'Books this year' : 'Books this month');
      setText(ui.booksCard.value, agg.booksPeriod + ' / ' + c.booksTarget);
      setText(ui.booksCard.sub, '');
      ui.booksCard.bar.style.width = fmtPct(agg.booksPeriod, c.booksTarget) + '%';
      ui.booksCard.card.dataset.met = String(agg.booksPeriod >= c.booksTarget);
    }

    // Chart — bars scale against the best day of the window (or the target,
    // so a met goal always shows as a full-height bar when it is the max).
    const rows = agg.weekRows;
    let maxSec = c.timeTarget > 0 ? c.timeTarget * 60 : 0;
    rows.forEach(function (r) { if (r.seconds > maxSec) maxSec = r.seconds; });
    const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    for (let i = 0; i < ui.chartCols.length; i++) {
      const colUi = ui.chartCols[i];
      const r = rows[i];
      if (!r) { setText(colUi.val, ''); continue; }
      const m = Math.floor(r.seconds / 60);
      setText(colUi.val, m > 0 ? String(m) : '');
      colUi.bar.style.height = (maxSec > 0 ? Math.max(2, Math.round((r.seconds / maxSec) * 100)) : 2) + '%';
      setText(colUi.day, letters[mondayDow(r.day)]);
      colUi.col.dataset.met = String(!!r.met);
      colUi.col.dataset.today = String(!!r.today);
    }

    // Timer card.
    if (timer) {
      setText(ui.timerRemaining, fmtClock(timer.deadline - Date.now()));
      setText(ui.timerBtn, 'Stop');
    } else {
      setText(ui.timerRemaining, c.timerMinutes + ':00');
      setText(ui.timerBtn, 'Start');
    }
  }

  // ── Customize sheet (goals-owned copies of the novel sheet factories) ─────
  //
  // segRow / stepRow / toggleRow and the sheetSync[] idiom are duplicated
  // from the novel reader's private factories on purpose — same design
  // language, no reaching into another module's internals. State-down,
  // events-up: no control holds its own state; syncSheet() re-derives every
  // control from the prefs.

  function segRow(label, options, get, set) {
    const row = el('div', 'gl-row');
    row.appendChild(el('span', 'gl-row-label', label));
    const seg = el('div', 'gl-seg');
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
    sheetSync.push(function (c) {
      const cur = String(get(c));
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.value === cur)); });
    });
    return row;
  }

  function stepRow(label, opts) {
    const row = el('div', 'gl-row');
    row.appendChild(el('span', 'gl-row-label', label));
    const step = el('div', 'gl-step');
    const minus = el('button', null, '−');
    const plus = el('button', null, '+');
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', 'Decrease ' + label.toLowerCase());
    plus.setAttribute('aria-label', 'Increase ' + label.toLowerCase());
    const out = el('output');
    out.setAttribute('aria-live', 'polite');
    minus.addEventListener('click', opts.dec);
    plus.addEventListener('click', opts.inc);
    step.appendChild(minus);
    step.appendChild(out);
    step.appendChild(plus);
    row.appendChild(step);
    sheetSync.push(function (c) { out.textContent = opts.fmt(opts.get(c)); });
    return row;
  }

  function toggleRow(label, text, get, set) {
    const row = el('div', 'gl-row');
    row.appendChild(el('span', 'gl-row-label', label));
    const toggle = el('button', 'gl-toggle');
    toggle.type = 'button';
    toggle.appendChild(el('span', null, text));
    toggle.appendChild(el('span', 'gl-chip', 'Off'));
    toggle.addEventListener('click', function () { set(!get(cfg())); });
    row.appendChild(toggle);
    sheetSync.push(function (c) {
      const on = !!get(c);
      toggle.setAttribute('aria-pressed', String(on));
      toggle.lastChild.textContent = on ? 'On' : 'Off';
    });
    return row;
  }

  // Stepping a target through zero turns the goal off; the label says so
  // instead of showing a meaningless "0".
  function targetStep(key, get, step, lo, hi, offBelow, unit) {
    return {
      get: get,
      fmt: function (v) { return v > 0 ? v + ' ' + unit : 'Off'; },
      dec: function () {
        const v = get(cfg());
        const next = v - step < offBelow ? 0 : v - step;
        setGoalPref(key, clamp(next, lo, hi));
      },
      inc: function () {
        const v = get(cfg());
        const next = v === 0 ? offBelow : v + step;
        setGoalPref(key, clamp(next, lo, hi));
      },
    };
  }

  function daysRow() {
    const row = el('div', 'gl-row');
    row.appendChild(el('span', 'gl-row-label', 'Days'));
    const wrap = el('div', 'gl-days');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Days of the week');
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    const buttons = [];
    for (let i = 0; i < 7; i++) {
      (function (idx) {
        const b = el('button', null, letters[idx]);
        b.type = 'button';
        b.setAttribute('aria-label', names[idx]);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () {
          const days = cfg().scheduleDays.split('');
          days[idx] = days[idx] === '1' ? '0' : '1';
          setGoalPref('goals.scheduleDays', days.join(''));
        });
        wrap.appendChild(b);
        buttons.push(b);
      })(i);
    }
    row.appendChild(wrap);
    sheetSync.push(function (c) {
      row.hidden = c.schedule !== 'custom';
      for (let i = 0; i < 7; i++) buttons[i].setAttribute('aria-pressed', String(c.scheduleDays.charAt(i) === '1'));
    });
    return row;
  }

  function excludedRow() {
    const row = el('div', 'gl-row');
    row.appendChild(el('span', 'gl-row-label', 'Excluded series'));
    const btn = el('button', 'gl-btn', 'Manage series');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    const list = el('div', 'gl-series-list');
    list.hidden = true;
    btn.addEventListener('click', function () {
      const open = list.hidden;
      list.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) buildSeriesList(list);
    });
    row.appendChild(btn);
    row.appendChild(list);
    return row;
  }

  async function buildSeriesList(list) {
    list.textContent = '';
    list.appendChild(el('div', 'gl-series-empty', 'Loading…'));
    let rows = [];
    try {
      if (window.Store && typeof window.Store.listProgress === 'function') {
        rows = (await window.Store.listProgress({ limit: 40 })) || [];
      }
    } catch (e) { rows = []; }

    // Titles preferred from the catalogue (it holds the freshest metadata);
    // the denormalized progress title is the fallback. Both are third-party
    // strings and reach the DOM as textContent only.
    const titles = {};
    try {
      const C = window.Catalogue;
      if (C && typeof C.listSeries === 'function') {
        (C.listSeries() || []).forEach(function (s) {
          if (s && s.id != null) titles[String(s.id)] = s.title;
        });
      }
    } catch (e) {}

    list.textContent = '';
    if (!rows.length) {
      list.appendChild(el('div', 'gl-series-empty', 'Nothing read yet — series appear here once you read them.'));
      return;
    }
    rows.forEach(function (p) {
      if (!p || !p.seriesId) return;
      const id = String(p.seriesId);
      const rowEl = el('div', 'gl-series-row');
      rowEl.appendChild(el('span', 'gl-series-title', titles[id] || p.seriesTitle || id));
      const toggle = el('button', 'gl-toggle');
      toggle.type = 'button';
      toggle.appendChild(el('span', 'gl-chip', ''));
      function syncRow() {
        const inc = includeSeries(id);
        toggle.setAttribute('aria-pressed', String(inc));
        toggle.firstChild.textContent = inc ? 'Counted' : 'Excluded';
        toggle.setAttribute('aria-label', (inc ? 'Exclude ' : 'Include ') + (titles[id] || p.seriesTitle || 'series'));
      }
      toggle.addEventListener('click', function () {
        setSeriesGoalPref(id, 'goals.include', !includeSeries(id));
        syncRow();
      });
      syncRow();
      rowEl.appendChild(toggle);
      list.appendChild(rowEl);
    });
    // Ephemeral uploads count under 'upload:<key>' and have no per-series
    // switch until Store unification (§11.6) — a stated limitation.
    list.appendChild(el('div', 'gl-series-empty', 'Local uploads always count.'));
  }

  function buildSheet(root) {
    const scrim = el('div', 'gl-scrim');
    scrim.hidden = true;
    scrim.addEventListener('click', function () { closeSheet(); });
    root.appendChild(scrim);

    const sheet = el('aside', 'gl-sheet');
    sheet.hidden = true;
    // The stylesheet keeps [hidden] sheets displayed (translated off-screen)
    // so the hide can animate — `inert` is what actually removes an unopened
    // sheet from the tab order.
    sheet.inert = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Goal settings');

    const head = el('div', 'gl-sheet-head');
    head.appendChild(el('h2', null, 'Goal settings'));
    const closeBtn = iconBtn('Close goal settings', ICONS.close);
    closeBtn.addEventListener('click', function () { closeSheet(); });
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    const body = el('div', 'gl-sheet-body');
    sheet.appendChild(body);

    body.appendChild(toggleRow('Tracking', 'Track reading goals',
      function (c) { return c.enabled; },
      function (v) { setGoalPref('goals.enabled', v); }));

    body.appendChild(stepRow('Daily reading time',
      targetStep('goals.timeTarget', function (c) { return c.timeTarget; }, 5, 0, 480, 5, 'min')));

    body.appendChild(segRow('Schedule', [
      { value: 'everyday', label: 'Every day' },
      { value: 'weekdays', label: 'Weekdays' },
      { value: 'custom',   label: 'Custom' },
    ], function (c) { return c.schedule; }, function (v) { setGoalPref('goals.schedule', v); }));

    body.appendChild(daysRow());

    body.appendChild(segRow('Streak counts when', [
      { value: 'target', label: 'Goal met' },
      { value: 'any',    label: 'Any reading' },
    ], function (c) { return c.streakRule; }, function (v) { setGoalPref('goals.streakRule', v); }));

    body.appendChild(stepRow('Chapters goal',
      targetStep('goals.chaptersTarget', function (c) { return c.chaptersTarget; }, 1, 0, 999, 1, 'chapters')));

    body.appendChild(segRow('Chapters period', [
      { value: 'day',  label: 'Per day' },
      { value: 'week', label: 'Per week' },
    ], function (c) { return c.chaptersPeriod; }, function (v) { setGoalPref('goals.chaptersPeriod', v); }));

    body.appendChild(stepRow('Books goal',
      targetStep('goals.booksTarget', function (c) { return c.booksTarget; }, 1, 0, 999, 1, 'books')));

    body.appendChild(segRow('Books period', [
      { value: 'month', label: 'Per month' },
      { value: 'year',  label: 'Per year' },
    ], function (c) { return c.booksPeriod; }, function (v) { setGoalPref('goals.booksPeriod', v); }));

    body.appendChild(stepRow('Timer length', {
      get: function (c) { return c.timerMinutes; },
      fmt: function (v) { return v + ' min'; },
      dec: function () { setGoalPref('goals.timer.minutes', clamp(cfg().timerMinutes - 5, 5, 180)); },
      inc: function () { setGoalPref('goals.timer.minutes', clamp(cfg().timerMinutes + 5, 5, 180)); },
    }));

    body.appendChild(toggleRow('Timer', 'Start when a reader opens',
      function (c) { return c.timerAutostart; },
      function (v) { setGoalPref('goals.timer.autostart', v); }));

    body.appendChild(toggleRow('Chime', 'Toast and haptic at zero',
      function (c) { return c.timerChime; },
      function (v) { setGoalPref('goals.timer.chime', v); }));

    body.appendChild(segRow('In-reader pill', [
      { value: 'auto', label: 'Auto' },
      { value: 'off',  label: 'Off' },
    ], function (c) { return c.pill; }, function (v) { setGoalPref('goals.pill', v); }));

    body.appendChild(stepRow('Idle cutoff', {
      get: function (c) { return c.idleCutoff; },
      fmt: function (v) { return v + ' min'; },
      dec: function () { setGoalPref('goals.idleCutoff', clamp(cfg().idleCutoff - 1, 1, 30)); },
      inc: function () { setGoalPref('goals.idleCutoff', clamp(cfg().idleCutoff + 1, 1, 30)); },
    }));

    // Reminder rows exist only where notifications can actually fire —
    // Platform.notify is the reminders-ready seam and answers false
    // everywhere this cycle (§5.2). A later local-notifications install
    // lights these up with no change here beyond the canNotify() answer.
    let canNotify = false;
    try {
      const P = window.Platform;
      canNotify = !!(P && P.notify && typeof P.notify.canNotify === 'function' && P.notify.canNotify());
    } catch (e) {}
    if (canNotify) {
      body.appendChild(toggleRow('Reminder', 'Daily reading reminder',
        function (c) { return c.reminderOn; },
        function (v) { setGoalPref('goals.reminder.enabled', v); }));
      body.appendChild(stepRow('Reminder time', {
        get: function (c) { return c.reminderTime; },
        fmt: function (v) { return v; },
        dec: function () { setGoalPref('goals.reminder.time', shiftReminder(-30)); },
        inc: function () { setGoalPref('goals.reminder.time', shiftReminder(30)); },
      }));
    }

    body.appendChild(excludedRow());

    const actionRow = el('div', 'gl-row');
    actionRow.appendChild(el('span', 'gl-row-label', 'History'));
    const actions = el('div', 'gl-actions');
    const resetBtn = el('button', 'gl-btn gl-btn-danger', 'Reset history');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', function () { confirmResetHistory(); });
    actions.appendChild(resetBtn);
    actionRow.appendChild(actions);
    body.appendChild(actionRow);

    // The ledger's own reset — separate action, separate confirm (§2.3).
    const lifetimeRow = el('div', 'gl-row');
    lifetimeRow.appendChild(el('span', 'gl-row-label', 'Lifetime'));
    const lifetimeActions = el('div', 'gl-actions');
    const resetLifetimeBtn = el('button', 'gl-btn gl-btn-danger', 'Reset lifetime totals');
    resetLifetimeBtn.type = 'button';
    resetLifetimeBtn.addEventListener('click', function () { confirmResetLifetime(); });
    lifetimeActions.appendChild(resetLifetimeBtn);
    lifetimeRow.appendChild(lifetimeActions);
    body.appendChild(lifetimeRow);

    root.appendChild(sheet);
    ui.scrim = scrim;
    ui.sheet = sheet;
    ui.sheetClose = closeBtn;
  }

  function shiftReminder(deltaMinutes) {
    const t = cfg().reminderTime.split(':');
    let total = parseInt(t[0], 10) * 60 + parseInt(t[1], 10) + deltaMinutes;
    total = ((total % 1440) + 1440) % 1440;
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  async function confirmResetHistory() {
    const ok = await askConfirm({
      title: 'Reset goal history',
      message: 'Delete all goal history? Your goal settings are kept. Lifetime totals are kept.',
      okLabel: 'Reset',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    try {
      if (window.Store && typeof window.Store.clearDayLogs === 'function') await window.Store.clearDayLogs();
    } catch (e) {}
    day.data = emptyDay();
    day.counted.clear();
    day.dirty = false;
    finishedThisPeriod = new Set();
    baselines.clear();
    uploadCompleted.clear();
    // The lifetime ledger deliberately survives — that is the point of the
    // separate accumulator (§2.3); its pref parses clean, so no re-seed can
    // resurrect anything either.
    dispatchGoalsChanged();
    recompute();
    toast('Goal history reset');
  }

  // "Reset goal history" keeps the ledger; this is the ledger's own reset —
  // a fresh zero with a fresh since-date, persisted immediately so the next
  // boot reads a VALID pref and cannot seed the cleared totals back in.
  async function confirmResetLifetime() {
    const ok = await askConfirm({
      title: 'Reset lifetime totals',
      message: 'Zero the all-time reading totals? Goal history and settings are kept.',
      okLabel: 'Reset',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    lifetime.data = { seconds: 0, words: 0, pages: 0, chapters: 0, books: 0 };
    lifetime.since = localDay();
    lifetime.loaded = true;
    lifetime.seeding = false; // a seed in flight would resurrect what the reader just zeroed
    lifetime.dirty = false;
    persistLifetime();
    dispatchGoalsChanged();
    renderScreen();
    toast('Lifetime totals reset');
  }

  function syncSheet() {
    const c = cfg();
    sheetSync.forEach(function (fn) {
      try { fn(c); } catch (e) {}
    });
  }

  // aria-modal only claims the rest of the screen is unavailable; making the
  // backdrop `inert` is what turns the claim true, so Tab cannot wander out
  // of an open sheet (the novel reader's discipline, copied).
  function setBackdropInert(on) {
    [ui.header, ui.body].forEach(function (n) { if (n) n.inert = !!on; });
  }

  function openSheet() {
    if (sheetOpen || !ui.sheet) return;
    sheetOpen = true;
    lastFocus = document.activeElement;
    syncSheet();
    ui.scrim.hidden = false;
    ui.sheet.hidden = false;
    ui.sheet.inert = false;
    setBackdropInert(true);
    if (ui.customizeBtn) ui.customizeBtn.setAttribute('aria-expanded', 'true');
    if (ui.customize) ui.customize.setAttribute('aria-expanded', 'true');
    if (ui.sheetClose) ui.sheetClose.focus();
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    ui.scrim.hidden = true;
    ui.sheet.hidden = true;
    ui.sheet.inert = true;
    setBackdropInert(false);
    if (ui.customizeBtn) ui.customizeBtn.setAttribute('aria-expanded', 'false');
    if (ui.customize) ui.customize.setAttribute('aria-expanded', 'false');
    if (lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) {}
    }
    lastFocus = null;
  }

  // ── Home slot (contents goals-owned; the slot itself is catalogue's) ──────

  function renderSlot() {
    const slot = document.getElementById('goals-home-slot');
    if (!slot) return; // catalogue builds it at boot; absent on test pages and old shells
    if (!trackingOn()) {
      if (slot.firstChild) { slot.textContent = ''; slotUi = null; }
      return;
    }
    if (!slotUi || !slot.contains(slotUi.root)) {
      slot.textContent = '';
      const strip = el('button', 'gl-home-strip');
      strip.type = 'button';
      strip.setAttribute('aria-label', 'Reading goals');
      const main = el('div', 'gl-home-main');
      const line = el('div', 'gl-home-line');
      const mins = el('span', 'gl-home-mins', '');
      const streak = el('span', 'gl-home-streak', '');
      line.appendChild(mins);
      line.appendChild(streak);
      main.appendChild(line);
      const track = el('div', 'gl-home-track');
      const bar = el('div', 'gl-home-bar');
      track.appendChild(bar);
      main.appendChild(track);
      strip.appendChild(main);
      const chev = el('span', 'gl-home-chev');
      chev.appendChild(svgIcon(ICONS.chevron, 16));
      strip.appendChild(chev);
      strip.addEventListener('click', function () { openScreen(); });
      slot.appendChild(strip);
      slotUi = { root: strip, mins: mins, streak: streak, bar: bar };
    }
    const c = cfg();
    const minutes = Math.floor(day.data.seconds / 60);
    setText(slotUi.mins, c.timeTarget > 0 ? minutes + ' of ' + c.timeTarget + ' min today' : minutes + ' min read today');
    setText(slotUi.streak, agg.streak > 0 ? agg.streak + '-day streak' : 'No streak yet');
    slotUi.bar.style.width = (c.timeTarget > 0 ? fmtPct(day.data.seconds, c.timeTarget * 60) : 0) + '%';
    slotUi.root.dataset.met = String(c.timeTarget > 0 && day.data.seconds >= c.timeTarget * 60);
  }

  function renderAll() {
    renderScreen();
    renderSlot();
    updatePillVisibility();
    renderPillTick(Date.now());
  }

  // ── Navigation (the importer precedent) ───────────────────────────────────

  function openScreen() {
    init();
    const from = bodyScreen();
    if (from && from !== SCREEN_ID) returnScreen = from;
    renderScreen();
    recompute(); // fresh streak and chart on entry
    if (typeof window.showScreen === 'function') {
      window.showScreen(SCREEN_ID);
    } else if (ui.root) {
      // Standalone (test harness): no screen registry to delegate to.
      ui.root.style.display = 'flex';
      if (document.body && document.body.dataset) document.body.dataset.screen = SCREEN_ID;
    }
  }

  function close() {
    if (sheetOpen) closeSheet();
    const C = window.Catalogue;
    if (C && typeof C.goBack === 'function') { C.goBack(); return; }
    if (typeof window.showScreen === 'function') { window.showScreen(returnScreen || 'home-screen'); return; }
    if (ui.root) ui.root.style.display = 'none';
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  function state() {
    const now = Date.now();
    return {
      today: day.key ? {
        day: day.key,
        loaded: !!day.loaded,
        seconds: Math.round(day.data.seconds),
        words: Math.round(day.data.words),
        pages: day.data.pages,
        chaptersCompleted: day.data.chaptersCompleted,
        booksFinished: day.data.booksFinished.slice(),
        seriesTouched: day.data.seriesTouched.slice(),
      } : null,
      streak: agg.streak,
      lifetime: {
        loaded: !!lifetime.loaded,
        // raw and unrounded — diagnostics see what storage sees (§1.2)
        seconds: lifetime.data.seconds,
        words: lifetime.data.words,
        pages: lifetime.data.pages,
        chapters: lifetime.data.chapters,
        books: lifetime.data.books,
        since: lifetime.since,
      },
      timer: timer ? {
        deadline: timer.deadline,
        minutes: timer.minutes,
        remainingMs: Math.max(0, timer.deadline - now),
      } : null,
      session: {
        screen: bodyScreen(),
        reading: !!session.activeSince,
        idle: !!session.idle,
        paused: !!session.paused,
        seriesId: lastSeriesId,
      },
    };
  }

  // ── Wiring + init ─────────────────────────────────────────────────────────

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (bodyScreen() !== SCREEN_ID) return;
    if (sheetOpen) closeSheet();
    else close();
  }

  function wireEvents() {
    window.addEventListener('or:progress', onProgress);
    window.addEventListener('or:upload-progress', onUploadProgress);

    // Goal-pref changes re-render everything cheap and re-derive the
    // aggregates; Store fires this synchronously for our own writes too.
    window.addEventListener('or:prefs', function (ev) {
      const d = ev && ev.detail;
      const key = d ? d.key : null;
      // The ledger's own flushes also ride or:prefs now, at persistDay
      // cadence (§2.3). That is a data write, not a settings change: adopt
      // (idempotent for our own writes) and skip the machinery below, or
      // every 30 s flush would trigger a full dayLog recompute.
      if (key === LIFETIME_KEY) { adoptLifetimeFromPref(); return; }
      if (key != null && String(key).indexOf('goals.') !== 0) return; // null key = bulk reload — re-read everything
      if (key == null) adoptLifetimeFromPref(); // a bulk reload may carry a restored ledger (native mirror)
      updatePillVisibility();
      recomputeActive(Date.now());
      if (sheetOpen) syncSheet();
      recompute();
    });

    // The slot refreshers: our own signal, and the library signal (deleted
    // series should stop showing stale numbers promptly).
    window.addEventListener('or:goals-changed', function () { renderSlot(); });
    window.addEventListener('or:library-changed', function () { renderSlot(); });

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    // Reading activity — capture reaches the novel reader's inner scroller.
    // These handlers only stamp a timestamp (§5.5).
    document.addEventListener('scroll', onActivity, { capture: true, passive: true });
    document.addEventListener('pointerdown', onActivity, { capture: true, passive: true });
    document.addEventListener('keydown', onActivity, { capture: true, passive: true });

    document.addEventListener('keydown', onKeydown);

    if (document.body) {
      const mo = new MutationObserver(function () { onScreenMaybeChanged(); });
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;

    setDayKey(localDay());
    day.data = emptyDay();
    session.lastActivity = Date.now();
    lastFlushAt = Date.now();
    lastScreen = bodyScreen();

    buildToast();
    buildPill();
    buildScreen();
    restoreTimer();
    wireEvents();

    initLifetime();
    loadDay();
    recompute();
    recomputeActive(Date.now());
    updatePillVisibility();

    setInterval(tick, TICK_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  // ── Public API (§5.2 — exactly this surface) ──────────────────────────────

  window.Goals = {
    openScreen: openScreen,
    close: close,
    startTimer: startTimer,
    stopTimer: stopTimer,
    state: state,
  };
})();
