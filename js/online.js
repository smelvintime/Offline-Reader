// Offline Reader — online catalog mode: catalog.json fetch, home/series
// screens, online chapter loading, connectivity switching, boot.
// Must be loaded after reader.js (uses its globals and functions).

// ═══════════════════════════════════════════════════════════════════════════
// ONLINE MODE — fetches /catalog.json automatically, no user input required.
// When online  → shows home-screen (series grid, latest updates, search).
// When offline → shows upload-screen (existing CBZ reader).
// Switches automatically when connectivity changes.
// ═══════════════════════════════════════════════════════════════════════════

let catalog       = null;   // parsed catalog.json
let filteredSeries = [];    // current search results
let currentSeriesIdx = -1;  // index into catalog.series for series-screen
let readerOrigin  = 'upload'; // 'upload' | 'series' — controls close-btn behaviour

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), diff = Math.floor((Date.now() - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7)  return diff + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Catalog fetch ─────────────────────────────────────────────────────────────

async function fetchCatalog() {
  try {
    const r = await fetch('./catalog.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch(e) {
    return null;
  }
}

// ── Render home screen ────────────────────────────────────────────────────────

function renderHome(data) {
  catalog = data;
  filteredSeries = (data.series || []).slice();

  const state   = document.getElementById('home-state');
  const latestS = document.getElementById('latest-section');
  const seriesS = document.getElementById('series-section');
  state.style.display = 'none';
  latestS.style.display = 'block';
  seriesS.style.display = 'block';

  renderLatest(filteredSeries);
  renderSeriesGrid(filteredSeries);
}

function renderLatest(seriesList) {
  const container = document.getElementById('latest-updates-list');
  container.innerHTML = '';

  // Build list: one row per series, sorted by most recently updated chapter
  const sorted = seriesList.slice().sort(function(a, b) {
    const aDate = latestDate(a), bDate = latestDate(b);
    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;
    return new Date(bDate) - new Date(aDate);
  }).slice(0, 15);

  sorted.forEach(function(s, i) {
    const latestCh = latestChapter(s);
    const row = document.createElement('div');
    row.className = 'update-row';

    // Thumbnail
    if (s.cover) {
      const img = document.createElement('img');
      img.className = 'update-thumb';
      img.src = proxyImageUrl(s.cover); img.alt = '';
      img.onerror = function() { img.replaceWith(makePh('update-thumb-ph')); };
      row.appendChild(img);
    } else {
      row.appendChild(makePh('update-thumb-ph'));
    }

    const info = document.createElement('div');
    info.className = 'update-info';
    const titleEl = document.createElement('div');
    titleEl.className = 'update-title';
    titleEl.textContent = s.title || 'Untitled';
    const metaEl = document.createElement('div');
    metaEl.className = 'update-meta';
    metaEl.textContent = latestCh ? 'Ch. ' + latestCh.num : 'No chapters';
    info.appendChild(titleEl);
    info.appendChild(metaEl);
    row.appendChild(info);

    const dateEl = document.createElement('div');
    dateEl.className = 'update-date';
    dateEl.textContent = fmtDate(latestDate(s));
    row.appendChild(dateEl);

    const idx = (catalog.series || []).indexOf(s);
    row.addEventListener('click', function() { openSeries(idx); });
    container.appendChild(row);
  });
}

function renderSeriesGrid(seriesList) {
  const grid = document.getElementById('series-grid');
  grid.innerHTML = '';

  if (!seriesList.length) {
    grid.innerHTML = '<div class="no-results">No series found</div>';
    return;
  }

  seriesList.forEach(function(s) {
    const card = document.createElement('button');
    card.className = 'series-card';

    const coverWrap = document.createElement('div');
    coverWrap.className = 'series-cover-wrap';
    if (s.cover) {
      const img = document.createElement('img');
      img.className = 'series-cover'; img.src = proxyImageUrl(s.cover); img.alt = '';
      img.onerror = function() { img.replaceWith(makePh('series-cover-ph')); };
      coverWrap.appendChild(img);
    } else {
      coverWrap.appendChild(makePh('series-cover-ph'));
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'series-card-title';
    titleEl.textContent = s.title || 'Untitled';

    const latestCh = latestChapter(s);
    const metaEl = document.createElement('div');
    metaEl.className = 'series-card-meta';
    metaEl.textContent = latestCh ? 'Ch. ' + latestCh.num : (s.chapters || []).length + ' ch';

    card.appendChild(coverWrap);
    card.appendChild(titleEl);
    card.appendChild(metaEl);

    const idx = (catalog.series || []).indexOf(s);
    card.addEventListener('click', function() { openSeries(idx); });
    grid.appendChild(card);
  });
}

function makePh(cls) {
  const ph = document.createElement('div');
  ph.className = cls;
  ph.textContent = '📖';
  return ph;
}

function latestChapter(s) {
  const chs = s.chapters || [];
  if (!chs.length) return null;
  return chs.reduce(function(best, ch) {
    if (!best) return ch;
    const bNum = best.num != null ? best.num : 0;
    const cNum = ch.num  != null ? ch.num  : 0;
    return cNum > bNum ? ch : best;
  }, null);
}

function latestDate(s) {
  const lc = latestChapter(s);
  return (lc && lc.updatedAt) || s.updatedAt || null;
}

// ── Series detail screen ──────────────────────────────────────────────────────

function openSeries(idx) {
  if (!catalog || idx < 0) return;
  const s = catalog.series[idx];
  currentSeriesIdx = idx;

  // Header title
  document.getElementById('series-header-title').textContent = s.title || 'Series';

  // Hero: cover
  const heroEl = document.getElementById('series-hero');
  const existingCover = document.getElementById('series-hero-cover');
  if (existingCover) existingCover.remove();
  const existingPh = document.getElementById('series-hero-cover-ph');
  if (existingPh) existingPh.remove();

  if (s.cover) {
    const img = document.createElement('img');
    img.id = 'series-hero-cover';
    img.src = proxyImageUrl(s.cover); img.alt = '';
    img.onerror = function() {
      img.remove();
      const ph = document.createElement('div');
      ph.id = 'series-hero-cover-ph'; ph.textContent = '📖';
      heroEl.prepend(ph);
    };
    heroEl.prepend(img);
  } else {
    const ph = document.createElement('div');
    ph.id = 'series-hero-cover-ph'; ph.textContent = '📖';
    heroEl.prepend(ph);
  }

  // Hero: text
  document.getElementById('series-hero-title').textContent = s.title || 'Untitled';
  document.getElementById('series-hero-desc').textContent  = s.description || '';

  // Tags/genres
  const metaEl = document.getElementById('series-hero-meta');
  metaEl.innerHTML = '';
  if (s.status) {
    const tag = document.createElement('span');
    tag.className = 'series-tag'; tag.textContent = s.status;
    metaEl.appendChild(tag);
  }
  (s.genres || []).forEach(function(g) {
    const tag = document.createElement('span');
    tag.className = 'series-tag'; tag.textContent = g;
    metaEl.appendChild(tag);
  });

  // Chapter list (newest first)
  const chList = document.getElementById('series-chapter-list');
  chList.innerHTML = '';
  const chapters_data = (s.chapters || []).slice().sort(function(a, b) {
    return (b.num != null ? b.num : 0) - (a.num != null ? a.num : 0);
  });

  if (!chapters_data.length) {
    chList.innerHTML = '<div class="no-results">No chapters available</div>';
  } else {
    chapters_data.forEach(function(ch) {
      const item = document.createElement('button');
      item.className = 'ch-item';

      const numEl = document.createElement('span');
      numEl.className = 'ch-num';
      numEl.textContent = ch.num != null ? 'Ch. ' + ch.num : '—';

      const nameEl = document.createElement('span');
      nameEl.className = 'ch-name';
      nameEl.textContent = ch.title || ('Chapter ' + (ch.num != null ? ch.num : ''));

      const dateEl = document.createElement('span');
      dateEl.className = 'ch-date';
      dateEl.textContent = fmtDate(ch.updatedAt);

      const arrow = document.createElement('span');
      arrow.className = 'ch-arrow';
      arrow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

      item.appendChild(numEl);
      item.appendChild(nameEl);
      item.appendChild(dateEl);
      item.appendChild(arrow);

      item.addEventListener('click', function() { loadOnlineChapter(s.title || 'Comic', ch); });
      chList.appendChild(item);
    });
  }

  showScreen('series-screen');
}

// ── Load an online chapter into the reader ────────────────────────────────────

async function loadOnlineChapter(seriesTitle, chData) {
  showScreen('loading-screen');
  loadingText.textContent = 'Loading chapter…';

  let pageUrls = chData.pages;

  // MangaDex: at-home image URLs expire — fetch fresh at read time
  if (!pageUrls && chData.mdChapterId) {
    try {
      loadingText.textContent = 'Fetching chapter…';
      const r = await fetch('https://api.mangadex.org/at-home/server/' + chData.mdChapterId);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      const base = json.baseUrl, ch = json.chapter;
      pageUrls = (ch.data || []).map(f => `${base}/data/${ch.hash}/${f}`);
    } catch(err) {
      showScreen('series-screen');
      return;
    }
  }

  // Support external chapter JSON (pages not inlined in catalog)
  if (!pageUrls && chData.src) {
    try {
      loadingText.textContent = 'Fetching chapter…';
      const r = await fetch(chData.src);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      pageUrls = json.pages;
    } catch(err) {
      showScreen('series-screen');
      return;
    }
  }

  if (!pageUrls || !pageUrls.length) { showScreen('series-screen'); return; }

  resetReaderState();

  pageUrls.forEach(function(url) {
    pages.push({ entry: null, directUrl: proxyImageUrl(url), url: null, loading: false, aspectLocked: false, gen: 0 });
  });

  const chNum  = chData.num != null ? chData.num : null;
  const chName = chData.title || (chNum != null ? 'Chapter ' + chNum : 'Chapter');
  chapters.push({ name: chName, displayNum: chNum, start: 0, end: pages.length - 1, wrappers: [], dividerEl: null });

  maxChapterNum     = chNum != null ? chNum : 1;
  baseChapterOffset = chNum != null ? chNum - 1 : 0;
  comicTitle.textContent = seriesTitle;
  lastLoadedFileNames    = [seriesTitle];
  readerOrigin           = 'series';

  renderShell();
  setupObservers();
  showScreen('reader-screen');
  uiHidden = false;
  updateUI(); resetIdle(); setupUI();
  if (chapterMode && chapters.length > 0) jumpToChapter(0);
}

// ── Search ────────────────────────────────────────────────────────────────────

document.getElementById('home-search').addEventListener('input', function(e) {
  const q = e.target.value.trim().toLowerCase();
  if (!catalog) return;
  filteredSeries = q
    ? (catalog.series || []).filter(function(s) {
        return (s.title || '').toLowerCase().includes(q);
      })
    : (catalog.series || []).slice();
  renderSeriesGrid(filteredSeries);
  // Hide latest when searching
  document.getElementById('latest-section').style.display = q ? 'none' : 'block';
});

// ── Back button — series → home ───────────────────────────────────────────────

document.getElementById('series-back-btn').addEventListener('click', function() {
  showScreen('home-screen');
});

// ── Manual mode toggle ────────────────────────────────────────────────────────

document.getElementById('go-online-btn').addEventListener('click', async function() {
  showScreen('home-screen');
  const data = await fetchCatalog();
  if (data) {
    renderHome(data);
  } else {
    document.getElementById('home-state').innerHTML =
      '<div style="color:var(--muted);font-size:0.9rem">Could not load library.<br>Check your connection.</div>';
    document.getElementById('home-state').style.display = 'flex';
  }
});

document.getElementById('go-offline-btn').addEventListener('click', function() {
  showScreen('upload-screen');
});

// ── Connectivity & startup mode ───────────────────────────────────────────────

async function initMode() {
  if (navigator.onLine) {
    showScreen('home-screen');
    const data = await fetchCatalog();
    if (data) {
      renderHome(data);
    } else {
      // catalog.json missing or unreachable — show error state
      document.getElementById('home-state').innerHTML =
        '<div class="home-state-title">Library unavailable</div>' +
        '<div style="font-size:0.82rem">Could not load catalog.json</div>' +
        '<button id="home-retry-btn">Retry</button>';
      document.getElementById('home-state').style.display = 'flex';
      const retryBtn = document.getElementById('home-retry-btn');
      if (retryBtn) retryBtn.addEventListener('click', initMode);
      document.getElementById('latest-section').style.display = 'none';
      document.getElementById('series-section').style.display = 'none';
    }
  } else {
    // No internet — show offline CBZ reader
    showScreen('upload-screen');
    document.getElementById('offline-reader-badge').classList.add('visible');
  }
}

window.addEventListener('offline', function() {
  // If currently browsing the online library, drop into offline reader
  const visible = [homeScreen, seriesScreen].find(function(s) {
    return s.style.display !== 'none';
  });
  if (visible) {
    showScreen('upload-screen');
    document.getElementById('offline-reader-badge').classList.add('visible');
  }
  document.getElementById('offline-badge').classList.add('visible');
});

window.addEventListener('online', function() {
  document.getElementById('offline-badge').classList.remove('visible');
  document.getElementById('offline-reader-badge').classList.remove('visible');
  // Only auto-navigate back to home if currently on the offline upload screen
  if (uploadScreen.style.display !== 'none') {
    initMode();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(reg => {
    const sw = reg.active;
    if (!sw) return;
    navigator.serviceWorker.addEventListener('message', function handler(e) {
      if (e.data?.type === 'VERSION') {
        document.getElementById('home-version').textContent = e.data.version.replace('cbz-reader-', '');
        navigator.serviceWorker.removeEventListener('message', handler);
      }
    });
    sw.postMessage('GET_VERSION');
  });
}

// Boot
initMode();
