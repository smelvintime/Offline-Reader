// Offline Reader — CBZ/ZIP reader core: state, archive loading, rendering,
// chapter navigation, library persistence, auto-scroll.
// Loaded as a classic script; shares the global lexical scope with catalogue.js,
// which must be loaded after this file.

// --- Service Worker ---
// Skipped inside the native shell: WKWebView's custom scheme has no service
// worker support, and the bundled app files already ARE the offline cache
// there — registering would only log errors. platform.js loads first, so
// Platform.isNative is readable at parse time.
if ('serviceWorker' in navigator && !(window.Platform && window.Platform.isNative)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// --- State ---
let pages = [];    // { entry, url, loading, aspectLocked, gen }
let chapters = []; // { name, displayNum, start, end, wrappers[], dividerEl }
let currentPage = 0;
let currentChIdx = 0;
let chapterMode = true;
let autoRunning = false;
let speedIdx = 3;
let uiHidden = false;
let autoscrollEnabled = false;
let maxChapterNum = 0;
let baseChapterOffset = 0;
let chapterDisplayShift = 0; // +1 when chapter set is 0-indexed (min displayNum === 0)
let chapterLabelTotal = 0;   // highest number shown in the chapter list; footer "y"

// pageObserver is module-level so it can be disconnected before recreation on reload.
let pageObserver = null;

// chapterJumpTimer guards the 150 ms deferred render in jumpToChapter so that
// rapid taps cancel the previous pending render before queueing a new one.
let chapterJumpTimer = null;

// Session persistence — remembers title, chapter, and page across iOS evictions.
let lastLoadedFileNames  = []; // sorted file names from the most recent load
let sessionSaveTimer     = null;
// Page gap — cycles through Off / Small / Large to add breathing room between pages.
const GAP_LEVELS = [0, 16, 40]; // px
let gapLevel = parseInt(localStorage.getItem('or.gap') || '0');
if (!Number.isInteger(gapLevel) || gapLevel < 0 || gapLevel >= GAP_LEVELS.length) gapLevel = 0;

// --- Jump Mode State ---
let scrollMode = 'smooth';
let jumpIntervalIdx = 3;
let isJumping = false;
let jumpStartY = 0;
let jumpTargetY = 0;
let jumpStartTime = 0;
const JUMP_DURATION = 250;
const JUMP_LEVELS = [8, 6, 4, 3, 2, 1.5, 1, 0.75, 0.5];

const SPEED_LEVELS = [1.0, 1.6, 2.5, 4.0, 6.0, 9.0, 13.0, 18.0];

// Autoscroll speed and mode survive relaunches via or.autoscroll — same
// silent-catch localStorage pattern as or.gap. The persisted shape is exactly
// {speedIdx, scrollMode} (contract, docs/ARCHITECTURE.md §3.1); the jump
// interval stays session-local on purpose. Read at parse time so a relaunch
// restores the setting before the reader is ever opened; platform.js mirrors
// the key natively and calls reloadReaderPrefs() after an eviction restore.
function readAutoscrollPref() {
  try {
    const s = JSON.parse(localStorage.getItem('or.autoscroll'));
    if (s && typeof s === 'object') {
      if (Number.isInteger(s.speedIdx) && s.speedIdx >= 0 && s.speedIdx < SPEED_LEVELS.length) speedIdx = s.speedIdx;
      if (s.scrollMode === 'smooth' || s.scrollMode === 'jump') scrollMode = s.scrollMode;
    }
  } catch (e) { /* absent or corrupt — keep the defaults */ }
}
readAutoscrollPref();

function saveAutoscroll() {
  try { localStorage.setItem('or.autoscroll', JSON.stringify({ speedIdx: speedIdx, scrollMode: scrollMode })); } catch (e) {}
}

// Device-classed image windows (docs/mobile/PLAN.md §9). The defaults are the
// mid-class row — the exact constants this file has always used — so a web
// session without Platform behaves bit-identically. applyTuning() re-reads the
// row once per reading session (inside resetReaderState, which BOTH entry
// paths call), never per frame.
let MEMORY_WINDOW = 25; // Pages within this distance keep their URL active
let CACHE_WINDOW  = 60; // Pages within this distance keep decoded bitmap (no flash on scroll-back); beyond this src is cleared to free memory
let LOOK_BEHIND   = 4;  // Lookahead window: pages decoded behind currentPage…
let LOOK_AHEAD    = 10; // …and ahead of it, so scrolling stays silky-smooth.

function applyTuning() {
  if (!(window.Platform && typeof window.Platform.tuning === 'function')) return;
  try {
    const t = window.Platform.tuning();
    if (Number.isInteger(t.memoryWindow) && t.memoryWindow > 0) MEMORY_WINDOW = t.memoryWindow;
    if (Number.isInteger(t.cacheWindow)  && t.cacheWindow  > 0) CACHE_WINDOW  = t.cacheWindow;
    if (Number.isInteger(t.lookBehind)   && t.lookBehind   > 0) LOOK_BEHIND   = t.lookBehind;
    if (Number.isInteger(t.lookAhead)    && t.lookAhead    > 0) LOOK_AHEAD    = t.lookAhead;
  } catch (e) { /* a broken bridge must never break reading — keep mid defaults */ }
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ARCHIVE_EXT = /\.(cbz|zip)$/i;

// Path-dependent size caps (docs/mobile/PLAN.md §6.3 / §8.14). Any set that
// materializes ArrayBuffers in the webview — the web, drag-drop, or the
// <input> fallback on native — keeps the 600 MB heap bound on every platform.
// Only sets that arrive as native picker URIs may use the 2 GB cap: their
// bytes never enter JS, so the cap bounds disk, not heap.
const SIZE_CAP        = 600 * 1024 * 1024;
const NATIVE_SIZE_CAP = 2 * 1024 * 1024 * 1024;

// --- Native (picked-URI) session state ---
// A native set's pages are {archiveKey|archiveUri, entryName} refs; page files
// are extracted per chapter into Cache/pages/<dir>/ and surfaced through the
// existing directUrl mechanism, so zero archive bytes ever sit in the heap.
let sessionArchiveManifest = null; // [{name, size, key}] persisted into or.library so "Resume" can reopen from disk
let nativePageDirs = [];           // rendered chapter page dirs, oldest first — capped at 2 (current + previous)
let nativeExtractInflight = {};    // chIdx → Promise, so one chapter is only ever extracted once at a time
let nativeCacheDirBase = '';       // 'upload-<setKey>' — the parent dir of this session's chapter page dirs

// --- Scroll-mode wrapper windowing ---
// Above SCROLL_WINDOW_THRESHOLD total pages, "∞" mode stops rendering every
// wrapper (thousands of DOM nodes + observer targets on big native sets) and
// keeps only chapters within ±SCROLL_WINDOW_SPAN of the current one in the
// DOM, with fixed-height spacers standing in for the rest. Below the
// threshold, scroll mode behaves exactly as it always has.
const SCROLL_WINDOW_THRESHOLD = 800;
const SCROLL_WINDOW_SPAN = 2;
let scrollWindowCenter = -1; // chapter idx the window is built around; -1 = windowing inactive

const GEOMETRIC_SVG = `
    <svg width="180" height="16" viewBox="0 0 180 16" fill="currentColor">
      <path d="M90 0L98 8L90 16L82 8L90 0Z" opacity="0.9"/>
      <circle cx="60" cy="8" r="2" opacity="0.5"/>
      <circle cx="120" cy="8" r="2" opacity="0.5"/>
      <rect x="10" y="7.5" width="30" height="1" opacity="0.3"/>
      <rect x="140" y="7.5" width="30" height="1" opacity="0.3"/>
    </svg>`;

// --- DOM ---
const uploadScreen   = document.getElementById('upload-screen');
const loadingScreen  = document.getElementById('loading-screen');
const readerScreen   = document.getElementById('reader-screen');
const readerPages    = document.getElementById('reader-pages');
const fileInput      = document.getElementById('file-input');
const loadingText    = document.getElementById('loading-text');
const comicTitle     = document.getElementById('comic-title');
const pageIndicator  = document.getElementById('page-indicator');
const autoscrollBar  = document.getElementById('autoscroll-bar');
const readerHeader   = document.getElementById('reader-header');
const readerFooter   = document.getElementById('reader-footer');
const chapterNav     = document.getElementById('chapter-nav');
const modeToggle     = document.getElementById('mode-toggle');
const chapterLabelBtn = document.getElementById('chapter-label-btn');
const csOverlay      = document.getElementById('cs-overlay');
const csList         = document.getElementById('cs-list');
const csClose        = document.getElementById('cs-close');

// --- Session persistence ---
// ── Reading library: up to 5 most-recently-read series ─────────────────────
function loadLibrary() {
  try { return JSON.parse(localStorage.getItem('or.library')) || []; } catch (e) { return []; }
}

function saveToLibrary() {
  if (!chapters.length || !lastLoadedFileNames.length) return;
  const ch       = chapters[currentChIdx];
  const chDisplay = chapterLabelNum(ch, currentChIdx);
  const title    = comicTitle.textContent;
  const rawTitle = title.trim();
  const key      = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || seriesKey(lastLoadedFileNames[0]);
  let library    = loadLibrary();
  const prev     = library.find(function(e) { return e.key === key; }) || {};

  // High-water mark: only ever advance, never regress.
  // Use ch.end when the last page of the chapter is visible so the homepage
  // bar shows 100% rather than 99% (currentPage is min-visible, not max-visible).
  const effectivePage       = visiblePages.has(ch.end) ? ch.end : currentPage;
  const isNewMax            = chDisplay > (prev.chDisplay != null ? prev.chDisplay : -1);
  const maxPageIdx          = isNewMax ? effectivePage               : prev.maxPageIdx;
  const maxChIdx            = isNewMax ? currentChIdx                : prev.chIdx;
  const maxChDisplay        = isNewMax ? chDisplay                   : prev.chDisplay;
  const maxPageInChapter    = isNewMax ? effectivePage - ch.start + 1 : prev.pageInChapter;
  const maxChapterTotalPages = isNewMax ? ch.end - ch.start + 1     : prev.chapterTotalPages;
  // Only judge "completed" against the CURRENT file set's page count when the
  // position advanced in this session; a stale maxPageIdx from a previous,
  // larger zip set must not mark a smaller subset as completed.
  const completed            = isNewMax ? effectivePage >= pages.length - 1 : !!prev.completed;

  const entry = {
    title, key,
    maxPageIdx, chIdx: maxChIdx, chDisplay: maxChDisplay,
    pageInChapter: maxPageInChapter, chapterTotalPages: maxChapterTotalPages,
    totalPages: pages.length, completed,
    lastRead: new Date().toISOString(),
    // Native archive manifest — lets "Resume" reopen the set from disk with no
    // re-picking. A plain-File session for the same series keeps the previous
    // manifest: the disk copies are still there and still resumable.
    archives: sessionArchiveManifest || prev.archives,
  };
  library = library.filter(function(e) { return e.key !== key; });
  library.unshift(entry);
  // MRU cap: 10 on native (archives persist on disk, so more slots are useful),
  // 5 on the web as always. Falling off the list IS library-row removal — the
  // evicted entry's archive files go with it, or they would leak forever.
  const libCap = (window.Platform && window.Platform.isNative) ? 10 : 5;
  const evicted = library.slice(libCap);
  library = library.slice(0, libCap);
  try { localStorage.setItem('or.library', JSON.stringify(library)); } catch (e) {}
  evicted.forEach(function (e) {
    (e.archives || []).forEach(function (a) {
      try { if (window.Platform) window.Platform.archives.remove(a.key); } catch (err) {}
    });
  });

  // Goals feed (docs/mobile/PLAN.md §6.3): deltas against the PREVIOUS stored
  // entry's high-water marks, so they are ≥ 0 by construction of the
  // only-ever-advance semantics above (Math.max guards the cross-zip-set edge
  // where a stale prev could sit further along than the current set).
  // Upload sessions only: online image sessions also pass through here (they
  // keep an or.library entry too) but their reading already reaches goals via
  // Store.putProgress → or:progress, and counting them twice would double
  // every page.
  if (window.readerOrigin === 'upload') {
    try {
      window.dispatchEvent(new CustomEvent('or:upload-progress', {
        detail: {
          libraryKey: key,
          pagesDelta: Math.max(0, (entry.maxPageIdx || 0) - (prev.maxPageIdx || 0)),
          chaptersDelta: Math.max(0, (entry.chIdx || 0) - (prev.chIdx || 0)),
          completed: !!entry.completed,
        },
      }));
    } catch (e) { /* a listener must never break the save path */ }
  }
}

// Migrate a single or.session entry into the new or.library format (runs once).
function migrateOldSession() {
  if (localStorage.getItem('or.library')) return;
  try {
    const s = JSON.parse(localStorage.getItem('or.session'));
    if (!s || !s.title) return;
    const key = s.files && s.files.length ? seriesKey(s.files[0]) : '';
    const entry = {
      title: s.title, key,
      maxPageIdx: s.pageIdx || 0, chIdx: s.chIdx || 0,
      chDisplay: s.chDisplay, pageInChapter: s.pageInChapter,
      chapterTotalPages: s.chapterTotalPages, totalPages: s.totalPages,
      completed: false, lastRead: new Date().toISOString(),
    };
    localStorage.setItem('or.library', JSON.stringify([entry]));
  } catch (e) {}
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const diffDays = Math.floor((Date.now() - d) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return diffDays + ' days ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Find the chapter index matching a saved entry, preferring displayNum match
// over raw chIdx so resume works correctly when different zip sets are loaded.
function findSavedChapter(saved) {
  if (!saved) return -1;
  if (saved.chDisplay != null) {
    const byNum = chapters.findIndex(function(ch, i) { return chapterLabelNum(ch, i) === saved.chDisplay; });
    if (byNum !== -1) return byNum;
  }
  // Fallback: use raw index (only reliable when same zip set is reloaded)
  if (saved.chIdx != null && saved.chIdx < chapters.length) return saved.chIdx;
  return -1;
}

// Dismisses the in-reader resume button and reveals the logo.
function clearResumeUI() {
  const bigBtn = document.getElementById('in-reader-resume');
  if (bigBtn) bigBtn.remove();
  const logo = document.getElementById('top-decor-logo');
  if (logo) logo.classList.remove('hidden');
}

// Populate the library list on the upload screen (up to 5 recent series).
function initLibraryList() {
  const library = loadLibrary();
  const listEl  = document.getElementById('library-list');
  listEl.innerHTML = '';
  if (!library.length) return;
  library.forEach(function(entry) {
    const row = document.createElement('div');
    row.className = 'library-row';

    const info = document.createElement('div');
    info.className = 'library-info';

    const textSpan = document.createElement('span');
    textSpan.className = 'library-info-text';

    let lbl = entry.title;
    let progressPct = null;
    if (entry.completed) {
      lbl += ' · Ch. ' + entry.chDisplay + ' · Completed';
    } else if (entry.chDisplay != null) {
      lbl += ' · Ch. ' + entry.chDisplay;
      if (entry.chapterTotalPages > 0 && entry.pageInChapter != null)
        progressPct = Math.round(entry.pageInChapter / entry.chapterTotalPages * 100);
    }
    textSpan.textContent = lbl;
    info.appendChild(textSpan);

    // Progress bar is right-aligned within the info section
    if (progressPct !== null) {
      const barWrap = document.createElement('span');
      barWrap.style.cssText = 'flex-shrink:0;display:flex;align-items:center;margin-left:auto;';
      barWrap.innerHTML = buildProgressBar(progressPct, 44);
      info.appendChild(barWrap);
    }

    // Date is a flex sibling of info; gap on .library-row creates spacing from the bar
    const date = document.createElement('span');
    date.className = 'library-date';
    date.textContent = formatDate(entry.lastRead);

    row.appendChild(info);
    row.appendChild(date);

    // Native entries with an archive manifest are resumable from disk — the
    // whole row becomes the "Resume" tap target, no re-picking involved.
    if (window.Platform && window.Platform.isNative
        && entry.archives && entry.archives.length) {
      row.classList.add('library-row-resume');
      row.addEventListener('click', function () { resumeFromLibrary(entry); });
    }

    listEl.appendChild(row);
  });
  listEl.classList.remove('hidden');
}

// ── Proxy config ──────────────────────────────────────────────────────────
// The gateway base URL lives in js/config.js (OR_CONFIG.workerBase). With no
// gateway configured, images load directly — which works for the bundled
// sample catalogue but fails for hotlink-protected CDNs.

function proxyImageUrl(url) {
  if (!url) return url;
  // Already-local and data URLs never need the gateway. Android's WKWebView
  // twin serves extracted pages as https://localhost/_capacitor_file_/… —
  // a local file that only dresses like a remote URL, so it is exempt too.
  if (/^(data:|blob:)/i.test(url) || !/^https?:/i.test(url)) return url;
  if (/^https:\/\/localhost\/_capacitor_file_\//i.test(url)) return url;
  const gw = window.gatewayUrl ? window.gatewayUrl('/image', { url: url }) : null;
  return gw || url;
}

window.proxyImageUrl = proxyImageUrl;

// --- Helpers ---
function naturalSort(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
function basename(path) { return path.replace(/^.*[\\/]/, ''); }

const homeScreen   = document.getElementById('home-screen');
const seriesScreen = document.getElementById('series-screen');

// Screens are registered rather than hard-coded so feature modules can create
// their own root element at init time and stay out of index.html.
// See docs/ARCHITECTURE.md §2.1.
const screens = new Set([uploadScreen, loadingScreen, readerScreen, homeScreen, seriesScreen]);

// Screens that scroll their own content use `block`; the rest are flex-centred.
const BLOCK_SCREENS = new Set(['reader-screen', 'novel-screen']);

function registerScreen(el) {
  if (el) screens.add(el);
  return el;
}

function showScreen(id) {
  screens.forEach(s => { if (s) s.style.display = 'none'; });
  const target = document.getElementById(id);
  if (!target) { console.warn('[showScreen] unknown screen:', id); return; }
  screens.add(target); // tolerate screens that forgot to register
  target.style.display = BLOCK_SCREENS.has(id) ? 'block' : 'flex';
  document.body.dataset.screen = id;
}

window.registerScreen = registerScreen;
window.showScreen     = showScreen;

// Strip chapter/volume numbers from a name and return the series portion.
// Preserves original casing — used for display titles.
function stripChapterRefs(name) {
  let t = name.replace(/\.(cbz|zip)$/i, '').replace(/_/g, ' ');
  t = t.replace(/\s*(?:-?\s*(?:c|ch|vol|chapter|volume)\.?\s*[\d.-]+).*$/i, '').trim();
  t = t.replace(/\s*-\s*ch\.[\d.-]+.*$/i, '').trim();
  return t;
}

// Try outer zip filenames first. If none yield a meaningful title, fall back to
// innerNames (inner CBZ archive names collected during loading). This double-check
// means a renamed outer zip like "ch.51-ch.100.zip" won't produce a bad title as
// long as the inner CBZ names carry the real series name.
function getComicTitle(files, innerNames = []) {
  for (const f of files) {
    const t = stripChapterRefs(f.name);
    if (t.length > 3) return t;
  }
  // Outer names are all bare chapter refs — try inner CBZ names.
  for (const name of innerNames) {
    const t = stripChapterRefs(name);
    if (t.length > 3) return t;
  }
  return files[0]?.name.replace(/\.(cbz|zip)$/i, '').replace(/_/g, ' ').trim() || "Comic";
}

// Returns a comparison key for series detection — lowercase alphanumeric only.
// Strips all hyphens, spaces, and punctuation so that "Star-Embracing Swordmaster",
// "Star Embracing Swordmaster", and "StarEmbracingSwordmaster" all produce the same
// key and are correctly treated as the same series.
// Returns '' if the result has no letters (filters pure-number names like "001").
function seriesKey(filename) {
  const key = stripChapterRefs(filename).toLowerCase().replace(/[^a-z0-9]/g, '');
  return (key.length > 3 && /[a-z]/.test(key)) ? key : '';
}

function extractChapterInfo(filename) {
  let name = basename(filename).replace(/\.(cbz|zip)$/i, '').replace(/_/g, ' ');
  let displayNum = null;
  const numMatch = name.match(/(?:c|ch|chapter|vol|volume)\.?\s*0*(\d+(\.\d+)?)/i);
  if (numMatch) {
    displayNum = parseFloat(numMatch[1]);
  } else {
    const fallbackMatch = name.match(/(?:-\s+|\[)0*(\d+(\.\d+)?)/);
    if (fallbackMatch) displayNum = parseFloat(fallbackMatch[1]);
  }
  const parts = name.split(/\s+-\s+/);
  let cleanName = name;
  if (parts.length > 1) cleanName = parts[parts.length - 1].trim();
  cleanName = cleanName.replace(/^(?:c|ch|chapter|v|vol|volume)\.?\s*0*\d+(\.\d+)?\s+/i, '');
  if (/^(?:c|ch|chapter|v|vol|volume)?\.?\s*0*\d+(\.\d+)?$/i.test(cleanName)) {
    const extracted = cleanName.match(/\d+(\.\d+)?/)[0];
    cleanName = `Chapter ${parseFloat(extracted)}`;
  }
  return { displayNum, cleanName };
}

// The number a human reads for this chapter in the selector list.
// Parses ch.name with the chapter-aware regex (extractChapterInfo), so a
// number in the series title or a range in a filename never wins over the
// actual chapter number. Falls back to the first number in the name, then
// to the array position. The shift is already baked into ch.name when it
// applies (names are rewritten at load), so no shift is added here.
function chapterLabelNum(ch, idx) {
  const parsed = extractChapterInfo(ch.name || '').displayNum;
  if (parsed !== null) return parsed;
  const m = ch.name && ch.name.match(/\d+(\.\d+)?/);
  if (m) return parseFloat(m[0]);
  return idx + 1 + baseChapterOffset;
}

// --- Archive Processing ---
async function extractEntries(zip, fallbackName) {
  const allFiles = Object.values(zip.files).filter(f => !f.dir).sort((a, b) => naturalSort(a.name, b.name));
  const archives = allFiles.filter(f => ARCHIVE_EXT.test(f.name));
  const images   = allFiles.filter(f => IMAGE_EXT.test(f.name));

  if (!archives.length) return images.length ? [{ images, name: fallbackName }] : [];

  const result = [];
  for (const arch of archives) {
    loadingText.textContent = `Opening: ${basename(arch.name)}`;
    try {
      const inner = await JSZip.loadAsync(await arch.async('arraybuffer'));
      const imgs = Object.values(inner.files)
        .filter(f => !f.dir && IMAGE_EXT.test(f.name))
        .sort((a, b) => naturalSort(a.name, b.name));
      if (imgs.length) result.push({ images: imgs, name: basename(arch.name) });
    } catch (e) {}
  }
  if (images.length) result.unshift({ images, name: 'Extras' });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM Lifecycle
//
// In chapter mode the DOM only ever holds one chapter's worth of page wrappers
// at a time (virtual rendering). Switching chapters tears down the old DOM,
// builds the new one, and begins fresh loads — so memory stays bounded.
//
// In scroll mode all chapters are rendered at once (same as before), since the
// user needs to scroll continuously across chapter boundaries.
// ─────────────────────────────────────────────────────────────────────────────

// Build the permanent shell: top decorator, chapter slot, bottom decorator.
// The slot is the only part that changes between chapters.
function renderShell() {
  const frag = document.createDocumentFragment();

  const topDecor = document.createElement('div');
  topDecor.className = 'reader-decor reader-top-decor';
  // Match loaded files to library by series key; show resume button if found.
  const rawTitle = comicTitle.textContent.trim();
  const curKey = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || (lastLoadedFileNames.length ? seriesKey(lastLoadedFileNames[0]) : '');
  const _lib   = loadLibrary();
  const saved  = curKey ? _lib.find(function(e) { return e.key === curKey; }) : null;
  const hasResume      = saved && findSavedChapter(saved) !== -1;
  const chapterMissing = saved && !hasResume;
  if (hasResume) {
    const resumeEl = document.createElement('button');
    resumeEl.id = 'in-reader-resume';
    const resumeLabel = document.createElement('span');
    resumeLabel.className = 'resume-label';
    resumeLabel.textContent = saved.completed ? 'Completed' : 'Resume Reading';
    const resumeBody = document.createElement('span');
    resumeBody.className = 'resume-body';
    let bodyText = saved.title + ' · Ch. ' + saved.chDisplay;
    resumeBody.appendChild(document.createTextNode(bodyText));
    if (!saved.completed && saved.chapterTotalPages > 0 && saved.pageInChapter != null) {
      const pct = Math.round(saved.pageInChapter / saved.chapterTotalPages * 100);
      const barWrap = document.createElement('span');
      barWrap.style.cssText = 'display:inline-block;vertical-align:middle;margin-left:0.5rem;';
      barWrap.innerHTML = buildProgressBar(pct, 44); /* match home-screen bar width */
      resumeBody.appendChild(barWrap);
    }
    resumeEl.appendChild(resumeLabel);
    resumeEl.appendChild(resumeBody);
    resumeEl.addEventListener('click', function(e) {
      e.stopPropagation();
      clearResumeUI();
      // Find chapter by its display number so resuming works across different zip sets.
      // Fall back to saved.chIdx only when displayNums are unavailable.
      const resumeChIdx = findSavedChapter(saved);
      if (resumeChIdx === -1) return;
      const rCh = chapters[resumeChIdx];
      // Compute absolute page index from pageInChapter (1-based) so the position is
      // correct even when the new zip set has different cumulative page totals.
      const targetPage = (saved.pageInChapter != null && saved.pageInChapter > 0)
        ? Math.min(rCh.start + saved.pageInChapter - 1, rCh.end)
        : null;
      jumpToChapter(resumeChIdx, targetPage);
      resetIdle();
    });
    topDecor.appendChild(resumeEl);
  } else if (chapterMissing) {
    const noticeEl = document.createElement('div');
    noticeEl.className = 'resume-missing';
    noticeEl.textContent = 'Last read: Ch. ' + saved.chDisplay + ' — not in this file';
    topDecor.appendChild(noticeEl);
  }

  // Geometric logo — rendered at top-decor; hidden when the big resume button
  // replaces it at the chapter-1 landing position, then revealed on dismiss.
  // Use firstElementChild (not firstChild) — the template literal starts with
  // a newline so firstChild would be a text node, not the SVG element.
  const svgWrap = document.createElement('div');
  svgWrap.innerHTML = GEOMETRIC_SVG;
  const svgEl = svgWrap.firstElementChild;
  svgEl.id = 'top-decor-logo';
  if (hasResume) svgEl.classList.add('hidden');
  topDecor.appendChild(svgEl);

  frag.appendChild(topDecor);

  const slot = document.createElement('div');
  slot.id = 'chapter-slot';
  frag.appendChild(slot);

  const botDecor = document.createElement('div');
  botDecor.id = 'bot-decor';
  botDecor.className = 'reader-decor reader-bottom-decor';
  botDecor.innerHTML = GEOMETRIC_SVG; // updateBottomDecor() will replace in chapter mode
  frag.appendChild(botDecor);

  readerPages.appendChild(frag);
}

// Populate the slot with one chapter's wrappers and begin observing them.
function renderChapter(idx) {
  const slot = document.getElementById('chapter-slot');
  const ch   = chapters[idx];
  const frag = document.createDocumentFragment();

  ch.wrappers   = [];
  ch.dividerEl  = null;

  if (chapters.length > 1) {
    const div = document.createElement('div');
    div.className = 'chapter-divider';
    div.textContent = ch.name;
    ch.dividerEl = div;
    frag.appendChild(div);
  }

  for (let i = ch.start; i <= ch.end; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrapper';
    wrap.dataset.index = i;
    const img = document.createElement('img');
    img.className = 'comic-page placeholder';
    pages[i].el   = img;
    pages[i].wrap = wrap;
    wrap.appendChild(img);
    ch.wrappers.push(wrap);
    frag.appendChild(wrap);
  }

  slot.appendChild(frag);
  ch.wrappers.forEach(w => pageObserver.observe(w));
}

// Populate the slot with ALL chapters (used in scroll mode). Above the
// windowing threshold the full render is replaced by a windowed one — see the
// scroll-window block below; below it, this is byte-for-byte the old behavior.
function renderAllChapters() {
  if (pages.length > SCROLL_WINDOW_THRESHOLD) {
    renderScrollWindow(currentChIdx);
    return;
  }
  scrollWindowCenter = -1;
  const slot = document.getElementById('chapter-slot');
  const frag = document.createDocumentFragment();

  chapters.forEach((ch, idx) => {
    ch.wrappers  = [];
    ch.dividerEl = null;

    if (chapters.length > 1) {
      const div = document.createElement('div');
      div.className = 'chapter-divider';
      div.textContent = ch.name;
      ch.dividerEl = div;
      frag.appendChild(div);
    }

    for (let i = ch.start; i <= ch.end; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrapper';
      wrap.dataset.index = i;
      const img = document.createElement('img');
      img.className = 'comic-page placeholder';
      pages[i].el   = img;
      pages[i].wrap = wrap;
      wrap.appendChild(img);
      ch.wrappers.push(wrap);
      frag.appendChild(wrap);
    }
  });

  slot.appendChild(frag);
  chapters.forEach(ch => ch.wrappers.forEach(w => pageObserver.observe(w)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scroll-mode wrapper windowing (docs/mobile/PLAN.md §4.1)
//
// The novel reader's collapse/expand pattern applied to "∞" mode: chapters
// within ±SCROLL_WINDOW_SPAN of the current one get real wrappers; every
// other chapter is a single fixed-height spacer div. The window moves on
// chapter change with an explicit scroll compensation, so the viewport never
// visibly jumps when estimated spacer heights are swapped for real content.
// ─────────────────────────────────────────────────────────────────────────────

const WIDE_LAYOUT_MQ = window.matchMedia ? window.matchMedia('(min-width: 1024px)') : null;

// Estimated pixel height of a chapter when it collapses to a spacer. Locked
// aspect ratios are exact; unseen pages assume the 2/3 portrait default the
// CSS placeholder uses. Drift is harmless — the compensation in
// updateScrollWindow() re-anchors the viewport on every window move.
function estimateChapterHeight(ch) {
  const maxW = (WIDE_LAYOUT_MQ && WIDE_LAYOUT_MQ.matches) ? 1000 : 800; // .page-wrapper max-width
  const width = Math.min(readerPages.clientWidth || window.innerWidth || 360, maxW);
  let h = 0;
  for (let i = ch.start; i <= ch.end; i++) {
    const a = pages[i] && pages[i].aspect;
    h += (a && isFinite(a) && a > 0) ? width / a : width * 1.5;
  }
  const n = ch.end - ch.start + 1;
  if (chapters.length > 1) h += 42; // the divider the spacer also stands in for
  h += n * GAP_LEVELS[gapLevel];    // flex gaps the removed elements carried
  return h;
}

// Build one chapter's divider + wrappers into a fragment. Same construction
// as renderChapter/renderAllChapters, plus re-applying any locked aspect
// ratio up front so previously-seen pages come back at their true height.
function renderChapterInto(ch, frag) {
  ch.wrappers  = [];
  ch.dividerEl = null;
  ch.spacerEl  = null;

  if (chapters.length > 1) {
    const div = document.createElement('div');
    div.className = 'chapter-divider';
    div.textContent = ch.name;
    ch.dividerEl = div;
    frag.appendChild(div);
  }

  for (let i = ch.start; i <= ch.end; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrapper';
    wrap.dataset.index = i;
    const img = document.createElement('img');
    img.className = 'comic-page placeholder';
    if (pages[i].aspect) {
      wrap.style.aspectRatio = String(pages[i].aspect);
      pages[i].aspectLocked = true;
    }
    pages[i].el   = img;
    pages[i].wrap = wrap;
    wrap.appendChild(img);
    ch.wrappers.push(wrap);
    frag.appendChild(wrap);
  }
}

function appendSpacer(ch, frag) {
  ch.wrappers  = [];
  ch.dividerEl = null;
  const sp = document.createElement('div');
  sp.className = 'chapter-spacer';
  sp.style.height = Math.round(estimateChapterHeight(ch)) + 'px';
  ch.spacerEl = sp;
  frag.appendChild(sp);
}

// Full windowed render of the slot (initial entry into windowed scroll mode).
function renderScrollWindow(centerIdx) {
  const slot = document.getElementById('chapter-slot');
  const frag = document.createDocumentFragment();
  scrollWindowCenter = centerIdx;

  chapters.forEach((ch, idx) => {
    if (Math.abs(idx - centerIdx) <= SCROLL_WINDOW_SPAN) {
      renderChapterInto(ch, frag);
    } else {
      appendSpacer(ch, frag);
    }
  });

  slot.appendChild(frag);
  chapters.forEach(ch => ch.wrappers.forEach(w => pageObserver.observe(w)));
}

// Swap a spacer for the chapter's real content in place.
function expandSpacer(ch) {
  const sp = ch.spacerEl;
  if (!sp) return;
  const frag = document.createDocumentFragment();
  renderChapterInto(ch, frag); // clears spacerEl
  sp.replaceWith(frag);
  ch.wrappers.forEach(w => pageObserver.observe(w));
}

// Collapse a rendered chapter back to a spacer, with the same page-teardown
// discipline as teardownAll (gen bump, revoke, explicit src='' so WebKit can
// release the decoded bitmaps) scoped to this chapter only.
function collapseChapter(ch) {
  for (let i = ch.start; i <= ch.end; i++) {
    const p = pages[i];
    p.gen++;
    if (p.url && !p.directUrl) URL.revokeObjectURL(p.url);
    p.url = null;
    p.loading = false;
    if (p.el) { p.el.src = ''; p.el.onload = null; }
    p.el   = null;
    p.wrap = null;
    visiblePages.delete(i); // unobserve fires no exit callback — drop stale indices ourselves
  }
  const sp = document.createElement('div');
  sp.className = 'chapter-spacer';
  sp.style.height = Math.round(estimateChapterHeight(ch)) + 'px';
  const first = ch.dividerEl || ch.wrappers[0];
  if (first && first.parentNode) first.parentNode.insertBefore(sp, first);
  if (ch.dividerEl) ch.dividerEl.remove();
  ch.wrappers.forEach(w => { pageObserver.unobserve(w); w.remove(); });
  ch.wrappers  = [];
  ch.dividerEl = null;
  ch.spacerEl  = sp;
}

// Move the window so centerIdx sits in the middle, compensating scroll so the
// anchor chapter's top stays put on screen while heights above it change.
function updateScrollWindow(centerIdx) {
  if (chapterMode || scrollWindowCenter === -1 || centerIdx === scrollWindowCenter) return;
  const anchorCh = chapters[centerIdx];
  if (!anchorCh) return;
  const anchorBefore = (anchorCh.wrappers && anchorCh.wrappers[0]) || anchorCh.dividerEl || anchorCh.spacerEl;
  const topBefore = anchorBefore ? anchorBefore.getBoundingClientRect().top : 0;

  chapters.forEach((ch, idx) => {
    const inWindow = Math.abs(idx - centerIdx) <= SCROLL_WINDOW_SPAN;
    if (inWindow && ch.spacerEl) expandSpacer(ch);
    else if (!inWindow && !ch.spacerEl && (ch.dividerEl || (ch.wrappers && ch.wrappers.length))) collapseChapter(ch);
  });
  scrollWindowCenter = centerIdx;

  const anchorAfter = (anchorCh.wrappers && anchorCh.wrappers[0]) || anchorCh.dividerEl || anchorCh.spacerEl;
  if (anchorBefore && anchorAfter) {
    const delta = anchorAfter.getBoundingClientRect().top - topBefore;
    if (delta) window.scrollBy(0, delta);
  }
}

// While the user flings through spacer territory no wrapper intersects, so
// the IntersectionObserver goes quiet and could never re-center the window.
// A debounced scroll fallback finds the chapter under the viewport middle by
// geometry — the novel reader's trackCurrentChapter trick.
function chapterAtViewportCenter() {
  const mid = window.innerHeight / 2;
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const head = ch.spacerEl || ch.dividerEl || (ch.wrappers && ch.wrappers[0]);
    if (!head) continue;
    const tail = ch.spacerEl || (ch.wrappers && ch.wrappers[ch.wrappers.length - 1]) || head;
    if (head.getBoundingClientRect().top <= mid && tail.getBoundingClientRect().bottom >= mid) return i;
  }
  return -1;
}

let windowedScrollTimer = null;
window.addEventListener('scroll', () => {
  if (chapterMode || scrollWindowCenter === -1) return;
  clearTimeout(windowedScrollTimer);
  windowedScrollTimer = setTimeout(() => {
    if (chapterMode || scrollWindowCenter === -1) return;
    if (visiblePages.size > 0) return; // observer path owns it while wrappers are visible
    const idx = chapterAtViewportCenter();
    if (idx !== -1 && idx !== scrollWindowCenter) {
      updateScrollWindow(idx);
      currentPage = chapters[idx].start;
      updateIndicator();
    }
  }, 150);
}, { passive: true });

// Revoke all loaded images, clear the slot, reset chapter DOM refs, and
// invalidate any in-flight blob loads via the generation counter.
function teardownAll() {
  pages.forEach(p => {
    p.gen++; // invalidate any in-flight loadPage calls for this page
    if (p.url && !p.directUrl) {
      URL.revokeObjectURL(p.url); // only revoke blob URLs, not direct CDN URLs
    }
    p.url = null;
    p.loading = false;
    // Explicitly clear src and drop the element reference so the browser can
    // release the decoded bitmap immediately. Without this, disconnected <img>
    // nodes hold their pixel data in memory even after slot.innerHTML='',
    // causing an OOM crash on iPhone when the next chapter starts loading.
    if (p.el) { p.el.src = ''; p.el.onload = null; }
    p.el          = null;
    p.wrap        = null;
    p.aspectLocked = false; // reset so the new wrapper gets the correct ratio on reload
  });

  const slot = document.getElementById('chapter-slot');
  if (slot) slot.innerHTML = '';

  chapters.forEach(ch => { ch.wrappers = []; ch.dividerEl = null; ch.spacerEl = null; });
  visiblePages.clear();
  scrollWindowCenter = -1; // the slot is empty; any window is gone with it
}

// ─────────────────────────────────────────────────────────────────────────────
// File Loading
// ─────────────────────────────────────────────────────────────────────────────

// Fully reset shared reader state before loading new content. Used by BOTH the
// offline file-load path and the online chapter loader — any new entry point
// must call this instead of resetting fields by hand, so the paths can never
// drift apart (stale chapterDisplayShift/readerOrigin bugs came from exactly that).
function resetReaderState() {
  applyTuning(); // both entry paths pass through here, so this IS session start
  pages.forEach(p => { if (p.url && !p.directUrl) URL.revokeObjectURL(p.url); });
  pages = []; chapters = [];
  visiblePages.clear();
  readerPages.innerHTML = ''; // wipe shell + slot
  window.scrollTo(0, 0);
  maxChapterNum = 0;
  baseChapterOffset = 0;
  chapterDisplayShift = 0;
  chapterLabelTotal = 0;
  scrollWindowCenter = -1;
  // Native session leftovers: release the previous set's extracted page dirs
  // (fire-and-forget — a failed delete is reclaimed by the LRU prune later).
  nativePageDirs.forEach(d => {
    try { if (window.Platform) window.Platform.archives.releasePages(d.dirKey); } catch (e) {}
  });
  nativePageDirs = [];
  nativeExtractInflight = {};
  sessionArchiveManifest = null;
  nativeCacheDirBase = '';
  // Stale resume UI and notices from a previous load.
  const staleResume = document.getElementById('in-reader-resume');
  if (staleResume) staleResume.remove();
  document.getElementById('size-notice').classList.add('hidden');
  document.getElementById('order-notice').classList.add('hidden');
}

let isLoading = false;

// Pre-sort files by chapter number as a minor optimisation — it causes the loading
// progress text to read out in chapter order, and means JSZip allocations happen
// low-to-high. The size cap is applied AFTER a global cross-file chapter sort
// in Phase 2, so this pre-sort is no longer the critical correctness path.
// Named so the File path and the native URI path sort identically, always.
function sortFilesByChapter(files) {
  files.sort((a, b) => {
    const { displayNum: an } = extractChapterInfo(a.name);
    const { displayNum: bn } = extractChapterInfo(b.name);
    if (an === null && bn === null) return naturalSort(a.name, b.name);
    if (an === null) return 1;
    if (bn === null) return -1;
    return an - bn;
  });
}

// The offline upload pipeline, extracted from the #file-input change handler so
// the native picker path can reuse it without synthesizing input events
// (docs/mobile/PLAN.md §6.3). Behavior-preserving: Phase 1 opens every zip with
// JSZip exactly as before; phases 2+ live in indexGroups(), shared with the
// native path so the chapter heuristics are literally the same code.
async function loadArchives(files) {
  if (isLoading) return;
  isLoading = true;
  files = Array.from(files || []).filter(f => ARCHIVE_EXT.test(f.name));
  if (!files.length) { isLoading = false; return; }

  showScreen('loading-screen');
  lastLoadedFileNames = files.map(f => f.name).sort();
  readerOrigin = 'upload'; // close button must reload, not return to a stale series screen
  resetReaderState();

  sortFilesByChapter(files);

  // Multi-series check: if the files appear to be from more than one series,
  // warn the user and stay on the upload screen rather than mixing them.
  const outerKeys = new Set(files.map(f => seriesKey(f.name)).filter(k => k));
  if (outerKeys.size > 1) {
    showScreen('upload-screen');
    document.getElementById('order-notice-text').textContent =
      '⚠ Multiple series detected — please load one series at a time';
    showNotice(document.getElementById('order-notice'));
    isLoading = false;
    return;
  }

  // Soft size cap applied after sorting all chapters globally so the cap always
  // trims the highest-numbered chapters, regardless of which zip file they came
  // from or what order the browser handed the files to us. Plain-File sets get
  // the 600 MB heap cap unconditionally — this path materializes every
  // archive's ArrayBuffer (the 2 GB cap belongs to the URI path alone).
  //
  // Phase 1 — open every zip and collect chapter groups (no page construction yet).
  // Phase 2 — sort all groups by chapter number across ALL files.
  // Phase 3 — walk the sorted list, apply the cap, then build pages[]/chapters[].
  const ctx = newIndexCtx(files, outerKeys, SIZE_CAP);

  // ── Phase 1: open all zips, collect groups ────────────────────────────────────
  for (const f of files) {
    loadingText.textContent = `Reading: ${f.name}`;
    try {
      const zip    = await JSZip.loadAsync(await f.arrayBuffer());
      const groups = await extractEntries(zip, f.name);

      if (!groups.length) {
        ctx.emptyFiles.push(f.name);
        continue;
      }

      // Collect inner names for title fallback + secondary series check.
      groups.forEach(g => {
        ctx.innerArchiveNames.push(g.name);
        const k = seriesKey(g.name);
        if (k) ctx.innerSeriesKeys.add(k);
      });

      // Prorate this file's compressed size across its groups by image count.
      const totalImages = groups.reduce((s, g) => s + g.images.length, 0);
      groups.forEach(g => {
        const groupBytes = totalImages > 0
          ? Math.round(f.size * g.images.length / totalImages)
          : Math.round(f.size / groups.length);
        ctx.allGroups.push({ group: g, groupBytes });
      });
    } catch (err) {
      console.error("Failed to read archive: " + f.name, err);
    }
  }

  indexGroups(ctx);
  isLoading = false;
}

// The #file-input change handler is now a thin shim over loadArchives().
fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files);
  fileInput.value = ''; // Reset so the same file can be re-opened without a page reload
  loadArchives(files);
});

// Shared indexing context: everything Phase 1 produces (on either path) and
// phases 2+ consume.
function newIndexCtx(files, outerKeys, sizeCap) {
  return {
    files, outerKeys, sizeCap,
    allGroups: [],          // flat list of { group, groupBytes } across every file, unsorted
    innerArchiveNames: [],  // (a) title fallback when outer names are bare chapter refs
    innerSeriesKeys: new Set(), // (b) secondary multi-series check against real chapter names
    emptyFiles: [],         // files that had no recognisable chapters
  };
}

// Phases 2+ of the upload pipeline: chapter sort, dedupe, size cap, notices,
// numbering, reader boot. ONE body serves both the JSZip File path and the
// native URI path — groups whose archive stayed on disk carry archiveKey /
// archiveUri and produce {entryName} page refs instead of JSZip entries, and
// every heuristic (extractChapterInfo, seriesKey, dedupe, the 0-index shift)
// is the same code by construction, fed the same original name strings.
function indexGroups(ctx) {
  const files = ctx.files;
  const outerKeys = ctx.outerKeys;
  const allGroups = ctx.allGroups;
  const innerArchiveNames = ctx.innerArchiveNames;
  const innerSeriesKeys = ctx.innerSeriesKeys;
  const emptyFiles = ctx.emptyFiles;
  const capLabel = ctx.sizeCap >= NATIVE_SIZE_CAP ? '2 GB' : '600 MB';

  // ── Phase 2: sort ALL groups by chapter number across every file ──────────────
  allGroups.sort((a, b) => {
    const { displayNum: an } = extractChapterInfo(a.group.name);
    const { displayNum: bn } = extractChapterInfo(b.group.name);
    if (an === null && bn === null) return naturalSort(a.group.name, b.group.name);
    if (an === null) return 1;
    if (bn === null) return -1;
    return an - bn;
  });

  // ── Phase 2.5: deduplicate ────────────────────────────────────────────────────
  // After sorting, any group whose chapter number (or normalised name for
  // unnumbered chapters) has already appeared is a duplicate — the user loaded
  // overlapping zips. Keep the first occurrence, drop the rest, warn if any removed.
  const seenNums  = new Set();
  const seenNames = new Set();
  let dupCount = 0;
  const dedupedGroups = allGroups.filter(({ group: g }) => {
    const { displayNum } = extractChapterInfo(g.name);
    if (displayNum !== null) {
      if (seenNums.has(displayNum)) { dupCount++; return false; }
      seenNums.add(displayNum);
    } else {
      const key = g.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key && seenNames.has(key)) { dupCount++; return false; }
      if (key) seenNames.add(key);
    }
    return true;
  });

  // ── Phase 3: apply cap in sorted order, then build pages[]/chapters[] ─────────
  let bytesLoaded    = 0;
  let skippedChapters = 0;
  let capReached     = false;

  for (const { group: g, groupBytes } of dedupedGroups) {
    if (capReached || bytesLoaded + groupBytes > ctx.sizeCap) {
      capReached = true;
      skippedChapters++;
      continue;
    }

    const start = pages.length;
    if (g.archiveKey || g.archiveUri) {
      // Native URI path: pages are {archiveKey, entryName} refs. The bytes stay
      // on disk until the chapter is rendered (ensureChapterExtracted), which is
      // what lets ctx.sizeCap bound disk instead of heap here.
      g.images.forEach(entry => pages.push({
        entry: null, archiveKey: g.archiveKey || null, archiveUri: g.archiveUri || null,
        entryName: entry.name, url: null, loading: false, aspectLocked: false, gen: 0
      }));
    } else {
      g.images.forEach(entry => pages.push({
        entry, url: null, loading: false, aspectLocked: false, gen: 0
      }));
    }
    const { displayNum, cleanName } = extractChapterInfo(g.name);
    chapters.push({ name: cleanName, displayNum, start, end: pages.length - 1 });
    bytesLoaded += groupBytes;
  }

  // Title: set now that inner archive names are available as a fallback,
  // so renamed outer zips (e.g. "ch.51-ch.100.zip") don't produce a wrong title.
  comicTitle.textContent = getComicTitle(files, innerArchiveNames);

  // Secondary multi-series check using inner archive names (more reliable than
  // outer zip names). Uses seriesKey so punctuation/spacing variants of the same
  // name don't produce false positives. Only warns if the keys from BOTH sources
  // (outer filenames AND inner archive names) indicate multiple series — one bad
  // outer name alone (e.g. "ch.51-ch.100.zip") never triggers this.
  if (innerSeriesKeys.size > 1 && outerKeys.size > 1) {
    document.getElementById('order-notice-text').textContent =
      '⚠ Multiple series detected — please load one series at a time';
    showNotice(document.getElementById('order-notice'));
  } else if (dupCount > 0) {
    document.getElementById('order-notice-text').textContent =
      `${dupCount} duplicate chapter${dupCount > 1 ? 's' : ''} removed — overlapping zips detected`;
    showNotice(document.getElementById('order-notice'));
  } else if (emptyFiles.length > 0) {
    const n = emptyFiles.length;
    document.getElementById('order-notice-text').textContent =
      `⚠ ${n} file${n > 1 ? 's' : ''} skipped — no readable chapters found inside`;
    showNotice(document.getElementById('order-notice'));
  }

  if (capReached) {
    const notice = document.getElementById('size-notice');
    document.getElementById('size-notice-text').textContent = skippedChapters > 0
      ? `${skippedChapters} chapter${skippedChapters > 1 ? 's' : ''} not loaded — ${capLabel} limit reached`
      : `Some content not loaded — ${capLabel} limit reached`;
    showNotice(notice);
  }

  // ── Chapter order warning ─────────────────────────────────────────────────────
  // If no chapter contained a recognisable number we had no basis for sorting,
  // so reading order may be wrong — warn the user.
  if (chapters.length > 1 && chapters.every(c => c.displayNum === null)) {
    showNotice(document.getElementById('order-notice'));
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Edge case: nothing loaded at all (e.g. every file was over the cap on its own).
  // Stay on the upload screen and show the notice there instead.
  if (chapters.length === 0) {
    showScreen('upload-screen');
    if (capReached) {
      const notice = document.getElementById('size-notice');
      document.getElementById('size-notice-text').textContent = 'No content loaded — files exceed ' + capLabel + ' limit';
      showNotice(notice);
    }
    return false;
  }

  const validNums = chapters.map(c => c.displayNum).filter(n => n !== null);
  if (validNums.length > 0) {
    const minNum = Math.min(...validNums);
    // If every chapter number is a non-negative integer and the set starts at 0,
    // the files are 0-indexed (e.g. Ch.000–Ch.099). Shift display by +1 so
    // Ch.000 shows as "1", Ch.092 shows as "93", etc.
    chapterDisplayShift = minNum === 0 ? 1 : 0;
    maxChapterNum    = Math.max(...validNums) + chapterDisplayShift;
    baseChapterOffset = minNum - 1 + chapterDisplayShift;
    // If shifted, update ch.name so dividers and the chapter selector also show
    // the corrected number (e.g. "Chapter 0" → "Chapter 1").
    if (chapterDisplayShift !== 0) {
      chapters.forEach(ch => {
        if (ch.displayNum !== null) {
          ch.name = 'Chapter ' + (ch.displayNum + chapterDisplayShift);
        }
      });
    }
  } else {
    maxChapterNum = chapters.length;
    chapterDisplayShift = 0;
  }

  // Footer total ("y") = highest number a user can see in the chapter list,
  // so the footer can never disagree with the list regardless of file naming.
  chapterLabelTotal = chapters.length;
  chapters.forEach((ch, i) => {
    chapterLabelTotal = Math.max(chapterLabelTotal, chapterLabelNum(ch, i));
  });

  renderShell();
  setupObservers(); // must come before any render call that invokes pageObserver.observe
  showScreen('reader-screen');
  uiHidden = false;
  updateUI();
  resetIdle();
  setupUI(); // sets button states; calls renderAllChapters if scroll mode

  if (chapterMode && chapters.length > 0) {
    jumpToChapter(0);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Native URI upload path (docs/mobile/PLAN.md §6.3)
//
// Picked archives never enter the JS heap: indexing is one central-directory
// zip.list per archive, the files themselves are MOVED into Data/archives/,
// and page bytes are extracted natively per chapter at render time. The same
// heuristics run on the same original filenames — only Phase 1 differs.
// ─────────────────────────────────────────────────────────────────────────────

// Upload button: try the native picker first, fall back to the <input>.
// pickFiles resolves null when there IS no native picker (→ the <input> flow)
// and [] when the user cancelled the one that opened (→ do nothing).
async function openArchivePicker() {
  const P = window.Platform;
  if (P && typeof P.pickFiles === 'function') {
    let picked = null;
    try { picked = await P.pickFiles({ accept: '.cbz,.zip', multiple: true }); } catch (e) { picked = null; }
    if (picked !== null) {
      if (picked.length) loadNativeArchives(picked);
      return;
    }
  }
  fileInput.click();
}

// The upload button's inline onclick in index.html clicks the <input>
// directly; assigning .onclick REPLACES that attribute handler, which is the
// point — otherwise the native picker and the <input> would both open.
{
  const uploadBtn = document.getElementById('mobile-upload-btn');
  if (uploadBtn) uploadBtn.onclick = openArchivePicker;
}

// "Resume" from the upload-screen library list: reopen a stored native set
// from disk, no re-picking. The manifest carries the ORIGINAL names/sizes, so
// titles, chapter numbers and the library key come out identical.
function resumeFromLibrary(entry) {
  loadNativeArchives((entry.archives || []).map(a => ({ name: a.name, size: a.size, key: a.key })));
}

// Native Phase 1 for both fresh picks (sources carry .uri) and resumes
// (sources carry .key). Mirrors loadArchives() step for step; phases 2+ are
// the shared indexGroups().
async function loadNativeArchives(sources) {
  if (isLoading) return;
  isLoading = true;
  const files = (sources || []).filter(f => f && f.name && ARCHIVE_EXT.test(f.name));
  if (!files.length) { isLoading = false; return; }

  showScreen('loading-screen');
  lastLoadedFileNames = files.map(f => f.name).sort();
  readerOrigin = 'upload'; // same close-button contract as the File path
  resetReaderState();

  sortFilesByChapter(files);

  const outerKeys = new Set(files.map(f => seriesKey(f.name)).filter(k => k));
  if (outerKeys.size > 1) {
    showScreen('upload-screen');
    document.getElementById('order-notice-text').textContent =
      '⚠ Multiple series detected — please load one series at a time';
    showNotice(document.getElementById('order-notice'));
    isLoading = false;
    return;
  }

  const P = window.Platform;
  const fresh = files.some(f => f.uri); // fresh pick vs resume-from-manifest

  // setKey namespaces this set's archive files and page-cache dirs. Falls back
  // to the raw alnum name when seriesKey() rejects letter-less names, so two
  // number-titled series can't collide on disk.
  const setKey = files[0].key
    ? (String(files[0].key).split(':')[1] || 'set')
    : (seriesKey(files[0].name) || files[0].name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'set');
  nativeCacheDirBase = 'upload-' + setKey;

  // ── Phase 1 (native): central-directory listings only ─────────────────────
  const ctx = newIndexCtx(files, outerKeys, NATIVE_SIZE_CAP);
  const listed = []; // { f, entries }
  let nested = false;
  for (const f of files) {
    loadingText.textContent = `Reading: ${f.name}`;
    let entries = null;
    try { entries = await P.zip.list(f.key ? { key: f.key } : { uri: f.uri }); } catch (e) { entries = null; }
    if (!entries || !entries.length) { ctx.emptyFiles.push(f.name); continue; }
    if (fresh && entries.some(en => ARCHIVE_EXT.test(en.name))) { nested = true; break; }
    listed.push({ f, entries });
  }

  // Zip-of-CBZs: the platform surface can't round-trip an extracted inner
  // archive back into zip.list, so nested sets fall back to materializing the
  // picked files and running the plain-File JSZip pipeline — which also means
  // the honest 600 MB heap cap applies to them (docs/mobile/PLAN.md §6.3
  // deviation, flagged in the completion log).
  if (nested) {
    loadingText.textContent = 'Nested archives — loading directly…';
    const realFiles = [];
    for (const f of files) {
      const rf = await P.readPickedFile(f);
      if (rf) realFiles.push(rf);
    }
    isLoading = false;
    loadArchives(realFiles);
    return;
  }

  // Fresh picks: move each archive out of the picker cache into
  // Data/archives/ (a rename — zero bytes in JS) under a stable per-set key.
  // Stale destinations are removed first so a re-import of the same series
  // never trips over last time's file.
  const manifest = [];
  for (let i = 0; i < listed.length; i++) {
    const src = listed[i];
    if (src.f.key) { manifest.push({ name: src.f.name, size: src.f.size, key: src.f.key }); continue; }
    const key = 'upload:' + setKey + ':' + i;
    let moved = null;
    try {
      await P.archives.remove(key);
      moved = await P.archives.importFromUri(key, src.f.uri);
    } catch (e) { moved = null; }
    if (moved) {
      src.f.key = key;
      manifest.push({ name: src.f.name, size: src.f.size, key: key });
    }
    // A failed move keeps reading from the picker's cache copy this session;
    // it just cannot be resumed after the OS reclaims the cache.
  }

  // Build one group per archive — the native twin of extractEntries' flat-CBZ
  // case, including its innerArchiveNames bookkeeping (a flat CBZ's group name
  // IS the outer filename on the web path too).
  for (const { f, entries } of listed) {
    const images = entries
      .filter(en => IMAGE_EXT.test(en.name))
      .sort((a, b) => naturalSort(a.name, b.name));
    if (!images.length) { ctx.emptyFiles.push(f.name); continue; }
    ctx.innerArchiveNames.push(f.name);
    const k = seriesKey(f.name);
    if (k) ctx.innerSeriesKeys.add(k);
    ctx.allGroups.push({
      group: { images, name: f.name, archiveKey: f.key || null, archiveUri: f.key ? null : f.uri },
      groupBytes: f.size || 0,
    });
  }

  if (indexGroups(ctx)) {
    sessionArchiveManifest = manifest.length ? manifest : null;
    // Same-series re-import: drop disk archives the new manifest no longer
    // references (a shrunken set would otherwise strand files forever).
    if (fresh && manifest.length) {
      const rawTitle = comicTitle.textContent.trim();
      const libKey = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || seriesKey(lastLoadedFileNames[0]);
      const prevEntry = loadLibrary().find(e => e.key === libKey);
      ((prevEntry && prevEntry.archives) || []).forEach(a => {
        if (!manifest.some(m => m.key === a.key)) {
          try { P.archives.remove(a.key); } catch (e) {}
        }
      });
    }
  }
  isLoading = false;
}

// One zip.extract per chapter: materializes the chapter's pages into
// Cache/pages/<base>/ch-N/ and fills each page's directUrl, after which the
// page rides the exact loadPage/unloadDistant machinery online pages use.
function pageChapterIdx(idx) {
  return chapters.findIndex(ch => idx >= ch.start && idx <= ch.end);
}

async function ensureChapterExtracted(chIdx) {
  const ch = chapters[chIdx];
  if (!ch) return;
  if (nativeExtractInflight[chIdx]) return nativeExtractInflight[chIdx];
  const P = window.Platform;
  if (!P) return;
  const job = (async () => {
    try {
      const first = pages[ch.start];
      const src = first.archiveKey ? { key: first.archiveKey } : { uri: first.archiveUri };
      const names = [];
      for (let i = ch.start; i <= ch.end; i++) names.push(pages[i].entryName);
      const dirKey = nativeCacheDirBase + '/ch-' + chIdx;
      const rels = await P.zip.extract(src, names, dirKey);
      if (!rels || rels.length !== names.length) {
        console.warn('[reader] native extract failed for chapter', chIdx);
        return;
      }
      for (let i = 0; i < rels.length; i++) {
        const u = P.pageUrl(rels[i]);
        if (u) pages[ch.start + i].directUrl = u;
      }
      registerNativeDir(chIdx, dirKey);
    } catch (e) {
      // Never let an extraction failure escape into loadPage — the page just
      // stays a placeholder and the next lookahead pass retries.
      console.warn('[reader] native extract failed for chapter', chIdx);
    }
  })();
  nativeExtractInflight[chIdx] = job;
  try { await job; } finally { delete nativeExtractInflight[chIdx]; }
}

// LRU of extracted chapter dirs, capped at 2 (current + previous — the same
// bound the importer's hydrate registry uses). Evicted chapters lose their
// directUrls so a later visit re-extracts instead of pointing at deleted files.
function registerNativeDir(chIdx, dirKey) {
  nativePageDirs = nativePageDirs.filter(d => d.chIdx !== chIdx);
  nativePageDirs.push({ chIdx, dirKey });
  while (nativePageDirs.length > 2) {
    const old = nativePageDirs.shift();
    const ch = chapters[old.chIdx];
    if (ch) {
      for (let i = ch.start; i <= ch.end; i++) {
        const p = pages[i];
        if (!p) continue;
        p.gen++;
        p.directUrl = null;
        p.url = null;
        p.loading = false;
        if (p.el && p.el.src) p.el.src = '';
      }
    }
    try { window.Platform.archives.releasePages(old.dirKey); } catch (e) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadPage(idx) {
  const p = pages[idx];
  if (!p || p.url || p.loading) return;
  // Guard: don't load a page whose wrapper has been removed from the DOM
  // (can happen when a large lookahead window reaches outside the current chapter).
  if (!p.el || !p.el.isConnected) return;
  p.loading = true;
  const gen = p.gen; // capture before the async gap

  // Native URI page whose chapter isn't extracted yet: one zip.extract per
  // chapter fills directUrl for every page in it, then this page rides the
  // ordinary directUrl branch below. A failed extract clears loading so the
  // next lookahead pass retries.
  if (!p.directUrl && p.entryName) {
    await ensureChapterExtracted(pageChapterIdx(idx));
    if (p.gen !== gen) { p.loading = false; return; }
    if (!p.directUrl) { p.loading = false; return; }
    if (!p.el || !p.el.isConnected) { p.loading = false; return; }
  }

  // Online mode: image is a direct CDN/HTTP URL — set src directly, no blob needed.
  if (p.directUrl) {
    if (p.gen !== gen) return;
    p.url = p.directUrl;
    p.el.src = p.directUrl;
    p.el.onload = () => {
      if (p.gen !== gen) return;
      p.el.classList.remove('placeholder');
      if (!p.aspectLocked) {
        const nw = p.el.naturalWidth, nh = p.el.naturalHeight;
        if (nw && nh) { p.wrap.style.aspectRatio = `${nw} / ${nh}`; p.aspectLocked = true; p.aspect = nw / nh; }
      }
    };
    p.el.onerror = () => { p.loading = false; p.url = null; };
    return;
  }

  try {
    const blob = await p.entry.async('blob');
    // If gen changed while we were waiting, this page was unloaded (chapter
    // switch, teardown, etc.). Discard the result rather than assigning a URL
    // to a stale or reassigned DOM element.
    if (p.gen !== gen) return;
    p.url = URL.createObjectURL(blob);
    p.el.src = p.url;
    p.el.onload = () => {
      p.el.classList.remove('placeholder');
      if (!p.aspectLocked) {
        const nw = p.el.naturalWidth;
        const nh = p.el.naturalHeight;
        if (nw && nh) {
          p.wrap.style.aspectRatio = `${nw} / ${nh}`;
          p.aspectLocked = true;
          p.aspect = nw / nh; // numeric copy — spacer height estimates need it after teardown
        }
      }
    };
    p.el.onerror = () => {
      // Corrupt image inside the archive — release the URL and allow a retry
      // on the next lookahead pass instead of leaving a permanent placeholder.
      if (p.url) { URL.revokeObjectURL(p.url); p.url = null; }
      p.loading = false;
    };
  } catch(e) { p.loading = false; }
}

function unloadDistant() {
  pages.forEach((p, i) => {
    const dist = Math.abs(i - currentPage);

    if (p.directUrl) {
      // Online page: just clear src for distant pages (no blob URL to revoke).
      if (dist > CACHE_WINDOW) {
        if (p.el && p.el.src) p.el.src = '';
        p.url = null; p.loading = false; p.gen++;
      }
      return;
    }

    if (dist > CACHE_WINDOW) {
      // Hard window: free the decoded bitmap entirely to cap memory during long
      // scrolling sessions. Pages this far back are unlikely to be scrolled to.
      if (p.url) { URL.revokeObjectURL(p.url); p.url = null; }
      if (p.el && p.el.src) { p.el.src = ''; }
      p.loading = false; p.gen++;
    } else if (dist > MEMORY_WINDOW && p.url) {
      // Soft window: revoke the URL but keep p.el.src so the browser retains
      // the decoded bitmap in its image cache — prevents black-placeholder
      // flashes if the user scrolls back within 60 pages.
      URL.revokeObjectURL(p.url);
      p.url = null; p.loading = false; p.gen++;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IntersectionObserver
// ─────────────────────────────────────────────────────────────────────────────

let visiblePages  = new Set();
let scrollDebounce = null;

function setupObservers() {
  // Disconnect the previous observer before creating a new one.
  // Without this, each archive load leaves an orphaned observer in memory.
  if (pageObserver) pageObserver.disconnect();
  visiblePages.clear();

  pageObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      const idx = parseInt(e.target.dataset.index);
      if (e.isIntersecting) {
        visiblePages.add(idx);
      } else {
        visiblePages.delete(idx);
      }
    });

    if (visiblePages.size > 0) {
      // Use an explicit loop instead of Math.min(...spread) — spreading a large
      // Set into Math.min can overflow the call stack when there are many pages.
      let minVisible = Infinity;
      for (const idx of visiblePages) { if (idx < minVisible) minVisible = idx; }

      if (minVisible !== currentPage) {
        currentPage = minVisible;
        updateIndicator();
      }

      // Debounce image loads: ignore pages the user scrolled past quickly.
      clearTimeout(scrollDebounce);
      scrollDebounce = setTimeout(() => {
        // Wider lookahead (mid class: -4 behind, +10 ahead) so images are
        // decoded well before the user reaches them, keeping the scroll
        // silky-smooth. The window sizes come from Platform.tuning() per §9.
        for (let i = currentPage - LOOK_BEHIND; i <= currentPage + LOOK_AHEAD; i++) {
          if (i >= 0 && i < pages.length) loadPage(i);
        }
        unloadDistant();
      }, 100);
    }
  }, { threshold: 0.05 });
  // Note: individual wrappers are observed inside renderChapter / renderAllChapters.
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Setup
// ─────────────────────────────────────────────────────────────────────────────

function setupUI() {
  const multi = chapters.length > 1;
  chapterNav.classList.toggle('hidden', !multi);
  modeToggle.classList.toggle('hidden', !multi);

  if (chapterMode) {
    modeToggle.textContent = 'Chapter';
    modeToggle.style.fontSize = '0.75rem';
    // Chapter content is rendered by jumpToChapter after setupUI returns.
  } else {
    modeToggle.textContent = '∞';
    modeToggle.style.fontSize = '1.2rem';
    renderAllChapters(); // scroll mode: build all wrappers now
  }

  updateIndicator();
  updateBottomDecor();
}

let _barUid = 0;
// fillColor: optional SVG color string for the filled portion.
// Defaults to indigo (#6366f1) for home-screen library bars.
// Pass 'var(--text)' for the reader-footer bar to render it in off-white.
function buildProgressBar(pct, customW, fillColor) {
  const color = fillColor || '#6366f1';
  const W = (typeof customW === 'number') ? customW : 72;
  const H = 9, barH = 3, barY = 3;
  const fillW = Math.min(Math.round((pct / 100) * W), W);
  const svgW  = W;
  const track = `<rect x="0" y="${barY}" width="${W}" height="${barH}" rx="0.5" fill="currentColor" opacity="0.07"/>`;
  if (fillW === 0) {
    return `<svg width="${svgW}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">${track}</svg>`;
  }
  if (pct >= 100) {
    return `<svg width="${svgW}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">` +
      track +
      `<rect x="0" y="${barY}" width="${W}" height="${barH}" rx="0.5" fill="${color}" opacity="0.88"/>` +
      `</svg>`;
  }
  const uid  = 'pf' + (++_barUid);
  const FADE = 8;
  const g1   = Math.max(0, fillW - FADE);
  return (
    `<svg width="${svgW}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">` +
    `<defs>` +
      `<linearGradient id="${uid}" x1="${g1}" x2="${fillW}" y1="0" y2="0" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0%"   stop-color="${color}" stop-opacity="0.88"/>` +
        `<stop offset="100%" stop-color="${color}" stop-opacity="0.15"/>` +
      `</linearGradient>` +
    `</defs>` +
    track +
    `<rect x="0" y="${barY}" width="${fillW}" height="${barH}" rx="0.5" fill="url(#${uid})"/>` +
    `</svg>`
  );
}

function updateIndicator() {
  const chIdx = chapters.findIndex(ch => currentPage >= ch.start && currentPage <= ch.end);
  if (chIdx !== -1) {
    currentChIdx = chIdx;
    // When currentPage is the last page of chapter N and chapter N+1's first page
    // is already scrolled into view, advance the indicator to avoid an off-by-one feel.
    if (currentPage === chapters[chIdx].end && chIdx + 1 < chapters.length) {
      const nextCh = chapters[chIdx + 1];
      if (nextCh && visiblePages.has(nextCh.start)) currentChIdx = chIdx + 1;
    }
  }
  // Windowed scroll mode: a chapter change moves the wrapper window (no-op
  // when the center is unchanged, so this costs one comparison per call).
  if (!chapterMode && scrollWindowCenter !== -1 && currentChIdx !== scrollWindowCenter) {
    updateScrollWindow(currentChIdx);
  }
  const ch = chapters[currentChIdx];
  const atEnd = ch && visiblePages.has(ch.end);
  const chPct = (ch && ch.end > ch.start)
    ? (atEnd ? 100 : Math.round((currentPage - ch.start + 1) / (ch.end - ch.start + 1) * 100))
    : 100;
  // Reader footer bar uses off-white (--text) instead of the default indigo
  pageIndicator.innerHTML = buildProgressBar(chPct, 44, 'var(--text)'); /* 44px width matches home-screen bar; off-white in reader */
  if (chapters.length > 1) {
    const currentCh = chapters[currentChIdx];
    // Both numbers derive from ch.name — the same string the chapter
    // selector displays — via chapterLabelNum, so the footer always matches
    // the list exactly, in both chapter and scroll mode.
    const chLabel = chapterLabelNum(currentCh, currentChIdx);
    const totalLabel = chapterLabelTotal || Math.max(maxChapterNum, chapters.length);
    chapterLabelBtn.textContent = `${chLabel} / ${totalLabel}`;
    const prevChBtn = document.getElementById('prev-ch');
    const nextChBtn = document.getElementById('next-ch');
    if (prevChBtn) prevChBtn.disabled = currentChIdx === 0;
    if (nextChBtn) nextChBtn.disabled = currentChIdx === chapters.length - 1;
  }
  // Debounce session save — writes position 1.5 s after scrolling settles.
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveToLibrary, 1500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapter Navigation
// ─────────────────────────────────────────────────────────────────────────────

// Refresh the bottom decorator for the current mode and chapter position.
// Chapter mode + multi-chapter → shows  < | — ◆ — | >  prev/next buttons.
// Scroll mode or single chapter  → shows the plain geometric SVG.
function updateBottomDecor() {
  const botDecor = document.getElementById('bot-decor');
  if (!botDecor) return;

  const multi   = chapters.length > 1;
  const hasPrev = multi && currentChIdx > 0;
  const hasNext = multi && currentChIdx < chapters.length - 1;

  if (chapterMode && multi) {
    botDecor.innerHTML = `
      <div class="ch-bottom-nav">
        <button class="ch-bottom-nav-btn" id="bot-prev-ch" ${hasPrev ? '' : 'disabled'}>
          <span>&lt;</span><span class="ch-nav-sep">|</span>
        </button>
        <div class="ch-bottom-nav-center">${GEOMETRIC_SVG}</div>
        <button class="ch-bottom-nav-btn" id="bot-next-ch" ${hasNext ? '' : 'disabled'}>
          <span class="ch-nav-sep">|</span><span>&gt;</span>
        </button>
      </div>`;

    const prevBtn = botDecor.querySelector('#bot-prev-ch');
    const nextBtn = botDecor.querySelector('#bot-next-ch');
    if (prevBtn) prevBtn.addEventListener('click', e => {
      e.stopPropagation();
      jumpToChapter(currentChIdx - 1);
      resetIdle();
    });
    if (nextBtn) nextBtn.addEventListener('click', e => {
      e.stopPropagation();
      jumpToChapter(currentChIdx + 1);
      resetIdle();
    });
  } else {
    botDecor.innerHTML = GEOMETRIC_SVG;
  }
}

function jumpToChapter(idx, targetPageIdx = null) {
  if (idx < 0 || idx >= chapters.length) return;

  // If user navigates away from chapter 1 without tapping the resume button,
  // auto-dismiss it and reveal the logo.
  if (idx > 0) {
    const bigBtn = document.getElementById('in-reader-resume');
    if (bigBtn) bigBtn.remove();
    const logo = document.getElementById('top-decor-logo');
    if (logo) logo.classList.remove('hidden');
  }

  if (chapterMode) {
    // Tear down current chapter: revoke URLs, clear img srcs, wipe DOM slot.
    teardownAll();
    currentChIdx = idx;
    currentPage  = chapters[currentChIdx].start;
    window.scrollTo(0, 0);
    updateIndicator();
    // Defer render by 150 ms after teardownAll() so iOS Safari has a full
    // event-loop idle window to actually free the decoded bitmap memory from
    // the previous chapter. requestAnimationFrame (~16 ms) isn't long enough —
    // WebKit's image-resource cleanup runs during GC, which needs idle time.
    // 150 ms is imperceptible to users but reliably prevents the OOM crash on
    // large chapters.
    // clearTimeout ensures rapid taps cancel the previous pending render so
    // we never queue two renderChapter calls for the same slot.
    clearTimeout(chapterJumpTimer);
    chapterJumpTimer = setTimeout(() => {
      renderChapter(currentChIdx);
      updateBottomDecor(); // refresh prev/next arrow availability
      // When restoring a session, jump to the saved page; otherwise start from top.
      const ch = chapters[currentChIdx];
      const startIdx = (targetPageIdx !== null)
        ? Math.min(Math.max(targetPageIdx, ch.start), ch.end)
        : currentPage;
      for (let i = startIdx; i <= Math.min(startIdx + 5, ch.end); i++) {
        loadPage(i);
      }
      if (targetPageIdx !== null) {
        const wrap = ch.wrappers[startIdx - ch.start];
        if (wrap) wrap.scrollIntoView();
        currentPage = startIdx;
        updateIndicator();
      }
    }, 150);
  } else {
    // Scroll mode: all wrappers already exist; just navigate to the chapter.
    // Under windowing the target may currently be a spacer — move the window
    // first so there is a real wrapper to scroll to.
    if (scrollWindowCenter !== -1) updateScrollWindow(idx);
    currentChIdx = idx;
    const firstWrap = chapters[currentChIdx].wrappers && chapters[currentChIdx].wrappers[0];
    if (firstWrap) firstWrap.scrollIntoView();
    updateIndicator();
  }
}

// --- Chapter Selector Modal ---
function populateChapterSelector() {
  const frag = document.createDocumentFragment();
  chapters.forEach((ch, idx) => {
    const btn = document.createElement('button');
    btn.className = 'cs-item' + (idx === currentChIdx ? ' active' : '');
    btn.textContent = ch.name;
    btn.onclick = (e) => {
      e.stopPropagation();
      jumpToChapter(idx);
      closeChapterSelector();
    };
    frag.appendChild(btn);
  });
  csList.innerHTML = '';
  csList.appendChild(frag); // single reflow instead of one per chapter
}

function openChapterSelector() {
  document.querySelector('.cs-header h3').textContent = comicTitle.textContent;
  populateChapterSelector();
  csOverlay.classList.remove('ui-hidden');
  setTimeout(() => {
    const active = csList.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'center' });
  }, 50);
}

function closeChapterSelector() {
  csOverlay.classList.add('ui-hidden');
  resetIdle();
}

chapterLabelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openChapterSelector();
});

csClose.addEventListener('click', (e) => {
  e.stopPropagation();
  closeChapterSelector();
});

csOverlay.addEventListener('click', (e) => {
  if (e.target === csOverlay) closeChapterSelector();
});

document.getElementById('size-notice-dismiss').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('size-notice').classList.add('hidden');
});

document.getElementById('order-notice-dismiss').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('order-notice').classList.add('hidden');
});

// --- Mode Toggle ---
modeToggle.addEventListener('click', () => {
  chapterMode = !chapterMode;

  if (chapterMode) {
    modeToggle.textContent = 'Chapter';
    modeToggle.style.fontSize = '0.75rem';
    // 150 ms defer: same crash-prevention as jumpToChapter.
    teardownAll();
    window.scrollTo(0, 0);
    clearTimeout(chapterJumpTimer);
    chapterJumpTimer = setTimeout(() => {
      renderChapter(currentChIdx);
      updateBottomDecor();
      const ch = chapters[currentChIdx];
      const startPage = Math.min(Math.max(currentPage, ch.start), ch.end);
      for (let i = startPage; i <= Math.min(startPage + 5, ch.end); i++) {
        loadPage(i);
      }
      // Restore position within the chapter (not just scroll to top).
      if (startPage > ch.start) {
        const wrap = ch.wrappers[startPage - ch.start];
        if (wrap) wrap.scrollIntoView();
        currentPage = startPage;
        updateIndicator();
      }
    }, 150);
  } else {
    modeToggle.textContent = '∞';
    modeToggle.style.fontSize = '1.2rem';
    // When switching to scroll mode, leave any pending resume button as-is —
    // the big button remains visible at the top in both modes.
    teardownAll();
    renderAllChapters();
    updateBottomDecor();
    requestAnimationFrame(() => {
      const ch = chapters[currentChIdx];
      const pageOffset = Math.min(Math.max(currentPage - ch.start, 0), ch.wrappers.length - 1);
      const wrap = ch.wrappers[pageOffset] || ch.wrappers[0];
      if (wrap) wrap.scrollIntoView();
    });
  }
  updateIndicator();
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-scroll
// ─────────────────────────────────────────────────────────────────────────────

function updateUI() {
  readerHeader.classList.toggle('ui-hidden', uiHidden);
  readerFooter.classList.toggle('ui-hidden', uiHidden);
  autoscrollBar.classList.toggle('ui-hidden', uiHidden || !autoscrollEnabled);
}

// SVG rects for each gap level: [top-rect-height, bottom-rect-y, bottom-rect-height]
// The visual gap between them grows to mirror the actual page gap setting.
const GAP_ICON = [
  [8, 11, 8],  // level 0: nearly touching (gap = 1px in 20×20 SVG)
  [6, 12, 6],  // level 1: small gap (gap = 4px)
  [5, 14, 5],  // level 2: large gap (gap = 7px)
];

function applyGap() {
  document.documentElement.style.setProperty('--page-gap', GAP_LEVELS[gapLevel] + 'px');
  const btn = document.getElementById('gap-toggle');
  btn.style.color = gapLevel > 0 ? 'var(--accent)' : '';
  const [th, by, bh] = GAP_ICON[gapLevel];
  btn.querySelector('svg').innerHTML =
    `<rect x="2" y="2" width="16" height="${th}" rx="1"/>` +
    `<rect x="2" y="${by}" width="16" height="${bh}" rx="1"/>`;
  try { localStorage.setItem('or.gap', gapLevel); } catch (e) {}
}

document.getElementById('gap-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  gapLevel = (gapLevel + 1) % GAP_LEVELS.length;
  applyGap();
  resetIdle();
});

// Apply saved gap on load.
applyGap();

document.getElementById('autoscroll-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  autoscrollEnabled = !autoscrollEnabled;
  updateUI();
  resetIdle();
});

let lastTime = 0;
let idleTimer = null;
let scrollAccumulator = 0;
const playIcon  = `<svg style="transform: translateX(1px)" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>`;
const pauseIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
const smoothIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`;
const jumpIcon   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="16"></line><polyline points="16 12 12 16 8 12"></polyline><line x1="6" y1="20" x2="18" y2="20"></line></svg>`;

function resetIdle() {
  clearTimeout(idleTimer);
  if (!uiHidden) {
    idleTimer = setTimeout(() => {
      uiHidden = true;
      updateUI();
    }, 2000);
  }
}

const noticeTimers = {};
function showNotice(el) {
  el.classList.remove('hidden');
  clearTimeout(noticeTimers[el.id]);
  noticeTimers[el.id] = setTimeout(() => el.classList.add('hidden'), 6000);
}

function autoStep(timestamp) {
  if (!autoRunning) return;
  if (!lastTime) lastTime = timestamp;

  if (scrollMode === 'smooth') {
    const dt = timestamp - lastTime;
    lastTime = timestamp;
    const speed = SPEED_LEVELS[speedIdx] / 16.6;
    scrollAccumulator += speed * dt;
    if (scrollAccumulator >= 1) {
      const pixelsToScroll = Math.floor(scrollAccumulator);
      window.scrollBy(0, pixelsToScroll);
      scrollAccumulator -= pixelsToScroll;
    }
  } else {
    if (isJumping) {
      const elapsed  = timestamp - jumpStartTime;
      const progress = Math.min(elapsed / JUMP_DURATION, 1);
      const ease     = 1 - Math.pow(1 - progress, 3);
      window.scrollTo(0, jumpStartY + (jumpTargetY - jumpStartY) * ease);
      if (progress >= 1) {
        isJumping = false;
        lastTime  = timestamp;
      }
    } else {
      const dt = timestamp - lastTime;
      const currentInterval = JUMP_LEVELS[jumpIntervalIdx] * 1000;
      if (dt >= currentInterval) {
        isJumping      = true;
        jumpStartTime  = timestamp;
        jumpStartY     = window.scrollY;
        jumpTargetY    = jumpStartY + (window.innerHeight * 0.70);
      }
    }
  }

  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
    stopAutoScroll();
  } else {
    requestAnimationFrame(autoStep);
  }
}

function startAutoScroll() {
  autoRunning = true; lastTime = 0; scrollAccumulator = 0;
  document.getElementById('as-playpause').innerHTML = pauseIcon;
  uiHidden = true;
  updateUI();
  requestAnimationFrame(autoStep);
}
function stopAutoScroll() {
  autoRunning = false;
  isJumping   = false;
  document.getElementById('as-playpause').innerHTML = playIcon;
  resetIdle();
}

[readerHeader, readerFooter, autoscrollBar].forEach(el => {
  el.addEventListener('touchstart', resetIdle, { passive: true });
  el.addEventListener('click', resetIdle);
});

// Reflect scrollMode onto the mode-toggle button (icon, colors, speed label).
// The values duplicate the CSS defaults for the smooth state, so calling this
// with defaults is a visual no-op — which is what lets the persisted-state
// restore below reuse the exact styling the click handler always applied.
function applyAutoscrollUI() {
  const toggleBtn = document.getElementById('as-mode-toggle');
  if (!toggleBtn) return;
  toggleBtn.innerHTML = scrollMode === 'smooth' ? smoothIcon : jumpIcon;
  if (scrollMode === 'smooth') {
    toggleBtn.style.color       = 'var(--accent)';
    toggleBtn.style.background  = 'rgba(99,102,241,0.15)';
    toggleBtn.style.borderColor = 'rgba(99,102,241,0.3)';
  } else {
    toggleBtn.style.color       = '#10b981';
    toggleBtn.style.background  = 'rgba(16, 185, 129, 0.15)';
    toggleBtn.style.borderColor = 'rgba(16, 185, 129, 0.3)';
  }
  updateSpeedLabel();
}

document.getElementById('as-mode-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  scrollMode = scrollMode === 'smooth' ? 'jump' : 'smooth';
  applyAutoscrollUI();
  isJumping = false;
  lastTime  = 0;
  saveAutoscroll();
  resetIdle();
});

document.getElementById('as-playpause').addEventListener('click', () => autoRunning ? stopAutoScroll() : startAutoScroll());

document.getElementById('as-faster').addEventListener('click', (e) => {
  e.stopPropagation();
  if (scrollMode === 'smooth') { if (speedIdx < SPEED_LEVELS.length - 1) speedIdx++; }
  else { if (jumpIntervalIdx < JUMP_LEVELS.length - 1) jumpIntervalIdx++; }
  updateSpeedLabel();
  saveAutoscroll();
  resetIdle();
});

document.getElementById('as-slower').addEventListener('click', (e) => {
  e.stopPropagation();
  if (scrollMode === 'smooth') { if (speedIdx > 0) speedIdx--; }
  else { if (jumpIntervalIdx > 0) jumpIntervalIdx--; }
  updateSpeedLabel();
  saveAutoscroll();
  resetIdle();
});

// Apply any restored autoscroll state to the bar on load — mirrors applyGap().
applyAutoscrollUI();

function updateSpeedLabel() {
  if (scrollMode === 'smooth') {
    const diff = speedIdx - 3;
    let label = '';
    if (diff === 0) {
      label = '•';
    } else if (diff === 4) {
      label = 'IV';
    } else {
      const isNeg   = diff < 0;
      const count   = Math.abs(diff);
      const spacing = 5;
      const start   = 12 - ((count - 1) * spacing / 2);
      let lines = '';
      for (let i = 0; i < count; i++) {
        const pos = start + (i * spacing);
        if (isNeg) {
          lines += `<line x1="7" y1="${pos}" x2="17" y2="${pos}" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />`;
        } else {
          lines += `<line x1="${pos}" y1="7" x2="${pos}" y2="17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />`;
        }
      }
      label = `<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;">${lines}</svg>`;
    }
    document.getElementById('as-speed-label').innerHTML = label;
  } else {
    document.getElementById('as-speed-label').textContent = JUMP_LEVELS[jumpIntervalIdx] + 's';
  }
}

readerPages.addEventListener('click', () => {
  if (autoRunning) { stopAutoScroll(); uiHidden = false; updateUI(); resetIdle(); return; }
  uiHidden = !uiHidden;
  updateUI();
  if (!uiHidden) resetIdle();
  else clearTimeout(idleTimer);
});

document.getElementById('close-btn').addEventListener('click', () => {
  // If reading an online chapter, go back to the series detail screen
  if (readerOrigin === 'series') {
    pages.forEach(p => { if (p.url && !p.directUrl) URL.revokeObjectURL(p.url); });
    pages = []; chapters = [];
    showScreen('series-screen');
  } else {
    location.reload();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Save immediately — this is the last reliable moment before iOS may evict the page.
    saveToLibrary();
    if (autoRunning) {
      stopAutoScroll();
      uiHidden = false;
      updateUI();
      resetIdle();
    }
  }
});

// --- Navigation ---
document.getElementById('next-ch').addEventListener('click', (e) => {
  e.stopPropagation();
  jumpToChapter(currentChIdx + 1);
  resetIdle();
});

document.getElementById('prev-ch').addEventListener('click', (e) => {
  e.stopPropagation();
  jumpToChapter(currentChIdx - 1);
  resetIdle();
});

// Re-read the reader's raw localStorage keys and re-apply them. platform.js
// calls this (guarded) after restoring the native Preferences mirror on an
// evicted launch: this file consumed or.gap / or.autoscroll / or.library at
// parse time — before that async restore could land — so without this hook
// the FIRST post-eviction launch would show defaults and an empty library
// even though the restore succeeded (docs/mobile/PLAN.md §2.2).
window.reloadReaderPrefs = function () {
  gapLevel = parseInt(localStorage.getItem('or.gap') || '0');
  if (!Number.isInteger(gapLevel) || gapLevel < 0 || gapLevel >= GAP_LEVELS.length) gapLevel = 0;
  applyGap();
  readAutoscrollPref();
  applyAutoscrollUI();
  initLibraryList();
};

// Migrate any pre-library session and populate the home-screen library list.
migrateOldSession();
initLibraryList();
