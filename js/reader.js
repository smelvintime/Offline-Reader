// Offline Reader — CBZ/ZIP reader core: state, archive loading, rendering,
// chapter navigation, library persistence, auto-scroll.
// Loaded as a classic script; shares the global lexical scope with online.js,
// which must be loaded after this file.

// --- Service Worker ---
if ('serviceWorker' in navigator) {
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
const MEMORY_WINDOW = 25; // Pages within this distance keep their URL active
const CACHE_WINDOW  = 60; // Pages within this distance keep decoded bitmap (no flash on scroll-back); beyond this src is cleared to free memory
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ARCHIVE_EXT = /\.(cbz|zip)$/i;

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
  };
  library = library.filter(function(e) { return e.key !== key; });
  library.unshift(entry);
  library = library.slice(0, 5);
  try { localStorage.setItem('or.library', JSON.stringify(library)); } catch (e) {}
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
    listEl.appendChild(row);
  });
  listEl.classList.remove('hidden');
}

// ── Proxy config ──────────────────────────────────────────────────────────
// Set this to your deployed Cloudflare Worker URL (no trailing slash).
// Leave empty to load images directly (will fail for hotlink-protected CDNs).

const PROXY_BASE = '';  // e.g. 'https://manga-proxy.yourname.workers.dev'

function proxyImageUrl(url) {
  if (!PROXY_BASE || !url) return url;
  return PROXY_BASE + '?url=' + encodeURIComponent(url);
}

// --- Helpers ---
function naturalSort(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
function basename(path) { return path.replace(/^.*[\\/]/, ''); }

const homeScreen   = document.getElementById('home-screen');
const seriesScreen = document.getElementById('series-screen');

function showScreen(id) {
  [uploadScreen, loadingScreen, readerScreen, homeScreen, seriesScreen].forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = id === 'reader-screen' ? 'block' : 'flex';
}

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

// Populate the slot with ALL chapters (used in scroll mode).
function renderAllChapters() {
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

  chapters.forEach(ch => { ch.wrappers = []; ch.dividerEl = null; });
  visiblePages.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// File Loading
// ─────────────────────────────────────────────────────────────────────────────

// Fully reset shared reader state before loading new content. Used by BOTH the
// offline file-load path and the online chapter loader — any new entry point
// must call this instead of resetting fields by hand, so the paths can never
// drift apart (stale chapterDisplayShift/readerOrigin bugs came from exactly that).
function resetReaderState() {
  pages.forEach(p => { if (p.url && !p.directUrl) URL.revokeObjectURL(p.url); });
  pages = []; chapters = [];
  visiblePages.clear();
  readerPages.innerHTML = ''; // wipe shell + slot
  window.scrollTo(0, 0);
  maxChapterNum = 0;
  baseChapterOffset = 0;
  chapterDisplayShift = 0;
  chapterLabelTotal = 0;
  // Stale resume UI and notices from a previous load.
  const staleResume = document.getElementById('in-reader-resume');
  if (staleResume) staleResume.remove();
  document.getElementById('size-notice').classList.add('hidden');
  document.getElementById('order-notice').classList.add('hidden');
}

let isLoading = false;
fileInput.addEventListener('change', async e => {
  if (isLoading) return;
  isLoading = true;
  const files = Array.from(e.target.files).filter(f => ARCHIVE_EXT.test(f.name));
  fileInput.value = ''; // Reset so the same file can be re-opened without a page reload
  if (!files.length) { isLoading = false; return; }

  showScreen('loading-screen');
  lastLoadedFileNames = files.map(f => f.name).sort();
  readerOrigin = 'upload'; // close button must reload, not return to a stale series screen
  resetReaderState();

  // Pre-sort files by chapter number as a minor optimisation — it causes the loading
  // progress text to read out in chapter order, and means JSZip allocations happen
  // low-to-high. The 600 MB cap is now applied AFTER a global cross-file chapter
  // sort in Phase 2, so this pre-sort is no longer the critical correctness path.
  files.sort((a, b) => {
    const { displayNum: an } = extractChapterInfo(a.name);
    const { displayNum: bn } = extractChapterInfo(b.name);
    if (an === null && bn === null) return naturalSort(a.name, b.name);
    if (an === null) return 1;
    if (bn === null) return -1;
    return an - bn;
  });

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

  // 600 MB soft cap applied after sorting all chapters globally so the cap always
  // trims the highest-numbered chapters, regardless of which zip file they came from
  // or what order the browser handed the files to us.
  //
  // Phase 1 — open every zip and collect chapter groups (no page construction yet).
  // Phase 2 — sort all groups by chapter number across ALL files.
  // Phase 3 — walk the sorted list, apply the cap, then build pages[]/chapters[].
  const SIZE_CAP = 600 * 1024 * 1024; // 600 MB in bytes

  // Collect inner archive names across all files so we can:
  //  (a) fall back to them for the title if outer zip names are bare chapter refs
  //  (b) run a secondary multi-series check against the actual chapter names
  const innerArchiveNames = [];
  const innerSeriesKeys   = new Set();
  const emptyFiles        = []; // files that had no recognisable chapters

  // allGroups: flat list of { group, groupBytes } across every file, unsorted.
  const allGroups = [];

  // ── Phase 1: open all zips, collect groups ────────────────────────────────────
  for (const f of files) {
    loadingText.textContent = `Reading: ${f.name}`;
    try {
      const zip    = await JSZip.loadAsync(await f.arrayBuffer());
      const groups = await extractEntries(zip, f.name);

      if (!groups.length) {
        emptyFiles.push(f.name);
        continue;
      }

      // Collect inner names for title fallback + secondary series check.
      groups.forEach(g => {
        innerArchiveNames.push(g.name);
        const k = seriesKey(g.name);
        if (k) innerSeriesKeys.add(k);
      });

      // Prorate this file's compressed size across its groups by image count.
      const totalImages = groups.reduce((s, g) => s + g.images.length, 0);
      groups.forEach(g => {
        const groupBytes = totalImages > 0
          ? Math.round(f.size * g.images.length / totalImages)
          : Math.round(f.size / groups.length);
        allGroups.push({ group: g, groupBytes });
      });
    } catch (err) {
      console.error("Failed to read archive: " + f.name, err);
    }
  }

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
    if (capReached || bytesLoaded + groupBytes > SIZE_CAP) {
      capReached = true;
      skippedChapters++;
      continue;
    }

    const start = pages.length;
    g.images.forEach(entry => pages.push({
      entry, url: null, loading: false, aspectLocked: false, gen: 0
    }));
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
      ? `${skippedChapters} chapter${skippedChapters > 1 ? 's' : ''} not loaded — 600 MB limit reached`
      : 'Some content not loaded — 600 MB limit reached';
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
      document.getElementById('size-notice-text').textContent = 'No content loaded — files exceed 600 MB limit';
      showNotice(notice);
    }
    isLoading = false;
    return;
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
  isLoading = false;
});

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
        if (nw && nh) { p.wrap.style.aspectRatio = `${nw} / ${nh}`; p.aspectLocked = true; }
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
        // Wider lookahead (-4 behind, +10 ahead) so images are decoded well
        // before the user reaches them, keeping the scroll silky-smooth.
        for (let i = currentPage - 4; i <= currentPage + 10; i++) {
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

document.getElementById('as-mode-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  scrollMode = scrollMode === 'smooth' ? 'jump' : 'smooth';
  const toggleBtn = document.getElementById('as-mode-toggle');
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
  isJumping = false;
  lastTime  = 0;
  updateSpeedLabel();
  resetIdle();
});

document.getElementById('as-playpause').addEventListener('click', () => autoRunning ? stopAutoScroll() : startAutoScroll());

document.getElementById('as-faster').addEventListener('click', (e) => {
  e.stopPropagation();
  if (scrollMode === 'smooth') { if (speedIdx < SPEED_LEVELS.length - 1) speedIdx++; }
  else { if (jumpIntervalIdx < JUMP_LEVELS.length - 1) jumpIntervalIdx++; }
  updateSpeedLabel();
  resetIdle();
});

document.getElementById('as-slower').addEventListener('click', (e) => {
  e.stopPropagation();
  if (scrollMode === 'smooth') { if (speedIdx > 0) speedIdx--; }
  else { if (jumpIntervalIdx > 0) jumpIntervalIdx--; }
  updateSpeedLabel();
  resetIdle();
});

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

// Migrate any pre-library session and populate the home-screen library list.
migrateOldSession();
initLibraryList();
