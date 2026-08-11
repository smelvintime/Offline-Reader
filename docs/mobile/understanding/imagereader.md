# Image Reader Slice — js/reader.js, sw.js, index.html

> **Superseded in part (Phase 8).** This document describes the tree as it was
> when it was written. Phase 8 removed the two site-specific builder sources and
> the site-specific worker adapter, and retired the `mdChapterId` resolution
> step that called one site's API from the browser. Nothing in the codebase now
> names a particular website. Where this document describes any of that, read it
> as history — `docs/ARCHITECTURE.md` §8 and `COPYRIGHT.md` are current.


Deep-read map of the image-reader slice (CBZ/ZIP + online image chapters), the
service worker, and the HTML shell. All line refs are exact against the current
tree. Binding contract: `/home/user/Offline-Reader/docs/ARCHITECTURE.md`.

Files covered completely:

- `/home/user/Offline-Reader/js/reader.js` (1500 lines, classic script, NO IIFE — file-scope globals shared with catalogue.js)
- `/home/user/Offline-Reader/sw.js` (118 lines)
- `/home/user/Offline-Reader/index.html` (224 lines)
- Plus the reader hand-off section of `js/catalogue.js` (1741–1851) and `js/config.js` (24 lines), because they poke reader.js globals directly.

---

## 1. Big picture

`reader.js` is the **oldest module** in the app and the only one that predates
the module conventions in ARCHITECTURE.md §2. It is loaded as a classic script
with **no IIFE and no 'use strict'** (reader.js:1–4 header comment says so
explicitly: "shares the global lexical scope with catalogue.js, which must be
loaded after this file"). Every `let`/`const` at top level is a de-facto global.
catalogue.js deliberately reads/writes these globals (catalogue.js:1741–1747:
"Poking them from here is the contract, not an accident").

It serves TWO entry points that share all state:

1. **Offline CBZ/ZIP upload** — `fileInput` change handler (reader.js:583–817). Pages are JSZip entries decoded to **blob URLs** on demand.
2. **Online image chapters** — `window.loadOnlineChapter` (catalogue.js:1751–1826) resets the same state and pushes `directUrl` pages (plain `https:` CDN URLs, optionally routed through the gateway via `imgUrl`/`proxyImageUrl`).

It also owns the app-wide **screen switching primitives** `showScreen` /
`registerScreen` (reader.js:256–271) that every other module depends on.

---

## 2. Module structure (functions + line refs)

### 2.1 State (all file-scope globals, reader.js:11–55)

| Global | Line | Meaning |
|---|---|---|
| `pages` | 12 | `[{ entry, url, loading, aspectLocked, gen, el?, wrap?, directUrl? }]` — one per page image. `entry` = JSZip file entry (offline) or `null` (online); `directUrl` set only for online pages. |
| `chapters` | 13 | `[{ name, displayNum, start, end, wrappers[], dividerEl }]` — `start`/`end` are inclusive indices into `pages`. |
| `currentPage` | 14 | min-visible page index (set by IntersectionObserver). |
| `currentChIdx` | 15 | current chapter index. |
| `chapterMode` | 16 | `true` = one chapter in DOM (virtualized); `false` = "∞" scroll mode, ALL chapters in DOM. Defaults to `true`. Not persisted. |
| `autoRunning`, `speedIdx`, `uiHidden`, `autoscrollEnabled` | 17–20 | autoscroll + chrome-visibility state. |
| `maxChapterNum`, `baseChapterOffset`, `chapterDisplayShift`, `chapterLabelTotal` | 21–24 | chapter numbering/display bookkeeping (0-indexed sets get +1 shift, line 781). |
| `pageObserver` | 27 | module-level IntersectionObserver, disconnected before recreation (setupObservers:916). |
| `chapterJumpTimer` | 31 | guards the 150 ms deferred render in jumpToChapter (rapid taps cancel pending render). |
| `lastLoadedFileNames`, `sessionSaveTimer` | 34–35 | session persistence across iOS evictions. |
| `GAP_LEVELS`/`gapLevel` | 37–39 | page-gap Off/Small/Large (0/16/40 px), persisted in `localStorage['or.gap']`. |
| Jump-mode state | 42–49 | `scrollMode` ('smooth'\|'jump'), `jumpIntervalIdx`, `isJumping`, `jumpStartY/TargetY/StartTime`, `JUMP_DURATION=250`, `JUMP_LEVELS=[8..0.5]s`. |
| `SPEED_LEVELS` | 51 | autoscroll px/frame multipliers `[1.0 … 18.0]`. |
| **`MEMORY_WINDOW = 25`** | 52 | pages within 25 of `currentPage` keep an active URL. |
| **`CACHE_WINDOW = 60`** | 53 | within 60: decoded bitmap kept (src retained); beyond: src cleared to free memory. |
| `IMAGE_EXT`, `ARCHIVE_EXT` | 54–55 | `/\.(jpe?g|png|webp|gif|bmp|avif)$/i`, `/\.(cbz|zip)$/i`. |
| `visiblePages`, `scrollDebounce` | 910–911 | Set of intersecting page indices; 100 ms load debounce. |
| `isLoading` | 582 | re-entrancy guard for the file input. |
| `readerOrigin` | (bare global) | assigned `'upload'` at 592; catalogue.js:1807 sets `window.readerOrigin='series'`; read at 1463 by the close button. **Never declared with let/const** — implicit global, catalogue.js seeds it (catalogue.js:2027 per that module's map). |

DOM refs are grabbed once at load (reader.js:67–83): `uploadScreen, loadingScreen, readerScreen, readerPages, fileInput, loadingText, comicTitle, pageIndicator, autoscrollBar, readerHeader, readerFooter, chapterNav, modeToggle, chapterLabelBtn, csOverlay, csList, csClose`; plus `homeScreen, seriesScreen` at 245–246.

### 2.2 Function inventory

**Library persistence (localStorage, NOT Store!)**
- `loadLibrary()` 87–89 — parses `localStorage['or.library']`, `[]` on any error.
- `saveToLibrary()` 91–127 — writes the top-5 MRU library. High-water-mark semantics ("only ever advance, never regress", 101–114): keyed by normalized title (`key`, line 97), stores `maxPageIdx, chIdx, chDisplay, pageInChapter, chapterTotalPages, totalPages, completed, lastRead`. Uses `visiblePages.has(ch.end)` so the last page counts as 100% (104).
- `migrateOldSession()` 130–145 — one-shot migration `or.session` → `or.library`.
- `formatDate(isoStr)` 147–155 — "Today"/"Yesterday"/"n days ago".
- `findSavedChapter(saved)` 159–168 — resolve saved entry to chapter idx, preferring `chDisplay` match over raw `chIdx` (works across different zip sets).
- `clearResumeUI()` 171–176 — removes `#in-reader-resume`, reveals `#top-decor-logo`.
- `initLibraryList()` 179–224 — populates `#library-list` on the upload screen (runs at load, line 1500).

**Gateway/proxy**
- `proxyImageUrl(url)` 231–237, exported `window.proxyImageUrl` 239 — routes `https:` URLs through `gatewayUrl('/image', {url})` when configured; passes through `data:`/`blob:`/non-http untouched.

**Helpers**
- `naturalSort` 242, `basename` 243.
- `stripChapterRefs(name)` 275–280, `getComicTitle(files, innerNames)` 286–297 (falls back to inner CBZ names), `seriesKey(filename)` 304–307 (lowercase alnum key, '' if no letters), `extractChapterInfo(filename)` 309–328 (`{displayNum, cleanName}` via `ch|chapter|vol` regex), `chapterLabelNum(ch, idx)` 336–342.

**Screen registry (app-wide primitive)**
- `screens` Set 251 seeded with the five index.html screens; `BLOCK_SCREENS` 254 = `{'reader-screen','novel-screen'}` (display:block; the rest are flex-centred).
- `registerScreen(el)` 256–259; `showScreen(id)` 261–268 — hides all registered screens (`style.display='none'`), shows target (`block` or `flex`), tolerates unregistered screens by adding them (265), sets `document.body.dataset.screen = id` (267 — catalogue.js:1834 gates progress writes on this). Exported at 270–271.

**Archive processing**
- `extractEntries(zip, fallbackName)` 345–365 — handles zip-of-CBZs: outer zip's inner `.cbz/.zip` entries are each opened via `JSZip.loadAsync(await arch.async('arraybuffer'))`; loose images become an "Extras" group (363). Returns `[{ images: JSZipEntry[], name }]`.

**DOM lifecycle (the virtualization core, 367–555)**
- `renderShell()` 380–459 — builds permanent shell into `#reader-pages`: top decor (with resume button/notice logic 386–433 + geometric SVG logo 439–444), `#chapter-slot` (448–450, the ONLY part swapped per chapter), bottom decor `#bot-decor` (452–456).
- `renderChapter(idx)` 462–493 — fills the slot with ONE chapter: optional `.chapter-divider` (textContent), then per page a `.page-wrapper` div (`dataset.index = i`) containing `<img class="comic-page placeholder">` with NO src. Stores `pages[i].el/wrap`, observes every wrapper (492).
- `renderAllChapters()` 496–528 — same, but for ALL chapters at once (scroll mode).
- `teardownAll()` 532–555 — the memory-critical teardown: bumps `p.gen++` to invalidate in-flight loads, revokes blob URLs (`!p.directUrl` guard 535), **explicitly sets `p.el.src=''` and drops `el`/`wrap` references** (541–547; comment: disconnected `<img>` nodes otherwise hold pixel data → "OOM crash on iPhone"), clears the slot innerHTML, resets `aspectLocked`, clears `visiblePages`.

**File loading**
- `resetReaderState()` 565–580 — shared full reset used by BOTH entry paths ("any new entry point must call this", 561–564): revokes URLs, empties `pages`/`chapters`/`visiblePages`, wipes `#reader-pages`, scrolls to 0, zeroes numbering globals, removes stale resume UI + notices.
- File input change handler 583–817 (the offline pipeline):
  - guard + filter + `fileInput.value=''` reset (584–588), `readerOrigin='upload'` 592, `resetReaderState()` 593.
  - Pre-sort files by parsed chapter number (599–606).
  - Multi-series check on outer names → abort with notice (610–618).
  - **Phase 1** (640–669): open each zip (`JSZip.loadAsync(await f.arrayBuffer())`), collect groups + inner names; prorate compressed size per group by image count.
  - **Phase 2** (672–679): global sort of all groups by chapter number.
  - **Phase 2.5** (682–699): dedupe by displayNum / normalized name, count dupes.
  - **Phase 3** (702–720): apply **600 MB soft cap** (`SIZE_CAP` 627) in sorted order — trims highest chapters; builds `pages[]` (`{entry, url:null, loading:false, aspectLocked:false, gen:0}` 714–715) and `chapters[]`.
  - Title (724), secondary multi-series / dupe / empty-file notices (731–744), cap notice (746–752), unordered-chapter warning (757–759), zero-chapters bailout (764–773).
  - 0-indexed shift `chapterDisplayShift` (775–796): min displayNum 0 → +1 shift, rewrites `ch.name` (786–791). `chapterLabelTotal` 800–803.
  - Boot: `renderShell(); setupObservers(); showScreen('reader-screen'); updateUI(); resetIdle(); setupUI();` then `jumpToChapter(0)` if chapterMode (805–816). Note 806: observers MUST be set up before any render that calls `pageObserver.observe`.

**Image loading / unloading (the memory engine)**
- `loadPage(idx)` 823–875 — no-op if already `url`/`loading`, or if `p.el` missing/`!isConnected` (827–828: lookahead can reach outside current chapter). Captures `gen` before every async gap (830).
  - **Online branch** (833–847): `p.el.src = p.directUrl` directly — no blob, no revoke. onload removes `.placeholder` and locks `wrap.style.aspectRatio` from naturalWidth/Height (839–843). onerror clears state for retry (845).
  - **Offline branch** (849–874): `const blob = await p.entry.async('blob')` → gen check (854) → `p.url = URL.createObjectURL(blob)` → `p.el.src = p.url`. Same onload aspect-lock; onerror **revokes the URL and allows retry** on next lookahead pass (868–873).
- `unloadDistant()` 877–904 — walks ALL pages by `dist = |i - currentPage|`:
  - `directUrl` pages: `dist > CACHE_WINDOW` → `src=''`, `url=null`, `gen++` (881–888).
  - Blob pages, `dist > CACHE_WINDOW` (60): revoke URL AND clear `src` — frees decoded bitmap ("hard window", 890–895).
  - Blob pages, `dist > MEMORY_WINDOW` (25): revoke URL but **keep `p.el.src`** so the browser's image cache retains the decoded bitmap — prevents black-placeholder flash on scroll-back ("soft window", 896–902). NB: after this, `p.url===null` while `el.src` is a dead blob URL; scrolling back within 60 pages shows the cached bitmap, beyond triggers reload via `loadPage` (since `p.url` is null and `loading` false).

**IntersectionObserver**
- `setupObservers()` 913–953 — disconnects previous observer (916, avoids orphan per load), threshold 0.05. On intersect: maintain `visiblePages`, compute min-visible with explicit loop (932–933: `Math.min(...spread)` can overflow the stack on large sets), update `currentPage` + indicator, then 100 ms debounced lookahead: `loadPage(i)` for `currentPage-4 … currentPage+10` (945–948) then `unloadDistant()` (948).

**UI**
- `setupUI()` 959–976 — toggles chapter nav + mode toggle visibility (`multi`), sets mode button text ('Chapter' vs '∞'), calls `renderAllChapters()` when in scroll mode, `updateIndicator()`, `updateBottomDecor()`.
- `buildProgressBar(pct, customW, fillColor)` 982–1013 — SVG-string progress bar with gradient fade tip; unique `linearGradient` id via `_barUid` (978). Used by library rows, resume button, and footer indicator. **Built with template-literal `innerHTML`** — safe only because inputs are numeric/app-controlled.
- `updateIndicator()` 1015–1049 — derives `currentChIdx` from `currentPage` (with end-of-chapter lookahead tweak 1021–1024), renders per-chapter pct bar into `#page-indicator` (1032, 44 px, `var(--text)` fill), sets `chapterLabelBtn` "x / y" via `chapterLabelNum`/`chapterLabelTotal` (1038–1040), disables prev/next at bounds (1043–1044), and **debounces `saveToLibrary` 1.5 s** (1047–1048).

**Chapter navigation**
- `updateBottomDecor()` 1058–1093 — chapter mode + multi → injects `< | — ◆ — | >` prev/next buttons (innerHTML template 1067–1076) wired to `jumpToChapter(±1)`; else plain SVG.
- `jumpToChapter(idx, targetPageIdx=null)` 1095–1148 — bounds check; auto-dismiss resume UI when leaving ch.1 (1100–1105). Chapter mode: `teardownAll()` → set indices → `scrollTo(0,0)` → **150 ms deferred** `renderChapter` (comment 1113–1121: rAF ~16 ms is NOT enough for WebKit to free bitmap memory — its image-resource cleanup runs during GC and needs idle time; 150 ms "reliably prevents the OOM crash"; `clearTimeout(chapterJumpTimer)` 1122 cancels rapid-tap double renders). Then eager-loads `startIdx … startIdx+5` (1131–1133) and `scrollIntoView` for resume targets (1134–1139). Scroll mode: just `scrollIntoView` the chapter's first wrapper (1142–1147).
- Chapter selector modal: `populateChapterSelector()` 1151–1166 (buttons via createElement + textContent, single-fragment append "single reflow" 1165), `openChapterSelector()` 1168–1176 (centers active item after 50 ms), `closeChapterSelector()` 1178–1181; wiring 1183–1195 (`chapterLabelBtn` click opens; overlay backdrop click closes).
- Notice dismiss buttons 1197–1205.
- Mode toggle handler 1208–1250 — flips `chapterMode`; → chapter: teardown + same 150 ms deferred render + position restore within chapter (1211–1233); → scroll: teardown + `renderAllChapters()` + rAF `scrollIntoView` to preserve position (1234–1248).

**Autoscroll (1252–1459)**
- `updateUI()` 1256–1260 — applies `ui-hidden` to header/footer/autoscroll bar.
- Gap toggle: `GAP_ICON` 1264–1268, `applyGap()` 1270–1279 (sets CSS var `--page-gap` on `documentElement`, persists `or.gap`), click handler 1281–1286, applied at load 1289.
- Autoscroll enable toggle 1291–1296.
- `resetIdle()` 1306–1314 — 2 s idle → hide chrome.
- `showNotice(el)` 1316–1321 — 6 s auto-hide per notice id.
- `autoStep(timestamp)` 1323–1364 — rAF loop. Smooth mode: accumulates fractional px (`SPEED_LEVELS[speedIdx]/16.6 * dt`) and `window.scrollBy` whole pixels (1327–1336). Jump mode: waits `JUMP_LEVELS[jumpIntervalIdx]` seconds, then eased (cubic-out) 250 ms scroll of 70% viewport height (1338–1356). Stops at document bottom (1359–1360).
- `startAutoScroll()` 1366–1372 / `stopAutoScroll()` 1373–1378 — hide/show chrome, play/pause icon swap.
- Idle-reset listeners on header/footer/bar (touchstart passive + click) 1380–1383.
- Mode toggle smooth↔jump 1385–1403 (inline style color swap indigo/emerald), play/pause 1405, faster/slower 1407–1421, `updateSpeedLabel()` 1423–1451 (renders tally-mark SVG for speed offsets).
- Tap-to-toggle chrome on `readerPages` 1453–1459 (tap while autoscrolling = stop + show chrome).

**Exit / lifecycle**
- Close button 1461–1470 — `readerOrigin === 'series'` → revoke blob URLs, clear `pages`/`chapters`, `showScreen('series-screen')`; else **`location.reload()`** (the upload flow's "reset" is a full page reload).
- `visibilitychange` 1472–1483 — on hidden: immediate `saveToLibrary()` ("last reliable moment before iOS may evict the page") + stop autoscroll.
- Footer prev/next chapter buttons 1486–1496.
- Boot: `migrateOldSession(); initLibraryList();` 1499–1500.

**SW registration** — reader.js:7–9: `navigator.serviceWorker.register('./sw.js').catch(() => {})`.

### 2.3 catalogue.js hand-off (context for this slice)

- `loadOnlineChapter(seriesTitle, chData, opts)` catalogue.js:1751–1824, exported `window.loadOnlineChapter` 1826. Resolves `pages` inline → `mdChapterId` (MangaDex at-home, expiring URLs, 1760–1769) → `src` JSON fetch (1772–1783). Then `resetReaderState()` (1791), pushes `{entry:null, directUrl: imgUrl(url), url:null, loading:false, aspectLocked:false, gen:0}` per page (1793–1795), builds a single-chapter `chapters[0]` (1799), sets `comicTitle`, `lastLoadedFileNames=[seriesTitle]`, `window.readerOrigin='series'` (1807), then the same boot sequence as the file path (1813–1823) with `resumePageIdx` support.
- `syncImageProgress(force)` catalogue.js:1832–1851 — samples reader globals (`pages.length`, `currentPage`) and writes `Store.putProgress` throttled ≥1.5 s, only while `document.body.dataset.screen === 'reader-screen'` and an `activeImageSession` exists. **Local uploads never touch Store** — they persist only via `or.library` in localStorage.

### 2.4 config.js

`window.OR_CONFIG` (config.js:4–16): `workerBase` ('' = gateway disabled), `chapterBase: './chapters/'`, `catalogUrl: './catalog.json'`. `window.gatewayUrl(path, params)` (19–24) returns `null` when unconfigured — every caller must handle null (proxyImageUrl does, 235–236).

---

## 3. Focus answers

### 3.1 How pages become `<img>` elements

- **Offline (CBZ/ZIP):** JSZip entry → `entry.async('blob')` → `URL.createObjectURL(blob)` → `img.src` (loadPage 850–856). **Blob URLs, not data URLs.** The full zip bytes, however, ARE resident: Phase 1 loads every archive with `await f.arrayBuffer()` (643) and inner CBZs with `arch.async('arraybuffer')` (356) — so up to 600 MB of compressed archive data lives in JS heap for the whole session, in addition to decoded bitmaps. The `pages[i].entry` JSZip handles keep the whole zip structure alive.
- **Online:** direct URL assigned to `img.src` (836), optionally rewritten through the Cloudflare gateway by `imgUrl`→`proxyImageUrl` (231–237). No blobs at all.
- **Revocation: yes, rigorously.** Three sites revoke: `unloadDistant` (893, 900), `teardownAll` (536), `resetReaderState` (566), close button (1464). The `!p.directUrl` guard prevents revoking CDN URLs. The `gen` counter (830, 854) prevents a stale async decode from attaching to a reused element.
- Placeholder pattern: `<img class="comic-page placeholder">` with no src; `.placeholder` removed onload; `wrap.style.aspectRatio` locked from natural dimensions once (`aspectLocked`) so unloaded pages keep their height → no scroll jumps (styles.css:183–201).

### 3.2 Are all pages in the DOM at once? (virtualization)

**Two modes** (comment block 367–376):

- **Chapter mode (default):** the DOM holds ONE chapter's wrappers at a time. Switching chapters is teardown → 150 ms idle wait → rebuild (`jumpToChapter` 1107–1140). This is real DOM virtualization at chapter granularity.
- **Scroll mode ("∞"):** `renderAllChapters()` puts EVERY page wrapper of EVERY chapter in the DOM simultaneously (496–528). Wrappers are cheap (empty `<img>` + aspect-ratio box), and the load/unload windows still bound decoded-image memory — but for a 600 MB / thousands-of-pages load, that is thousands of DOM nodes. No windowing of the wrapper elements themselves in either mode.
- Within the rendered DOM, image DATA is windowed by `MEMORY_WINDOW`/`CACHE_WINDOW` + the −4/+10 lookahead. So memory ≈ (≤60 decoded bitmaps) + (all zip ArrayBuffers) + (all wrappers in scroll mode).

### 3.3 Autoscroll

rAF-driven (`autoStep` 1323–1364), two sub-modes: smooth (fractional px accumulator, 8 speed levels 1.0–18.0 px/frame-at-60fps) and jump (periodic eased 70%-viewport hops every 0.5–8 s). Auto-stops at document end and on `visibilitychange`. Chrome auto-hides while running; any tap stops it. All state is in-memory only (speed/mode not persisted).

### 3.4 Chapter nav

Three surfaces, all funneling into `jumpToChapter`: footer `#prev-ch`/`#next-ch` (1486–1496), bottom-decor `< | ◆ | >` buttons (1078–1089, chapter mode only), and the chapter-selector modal (`#cs-overlay`, 1151–1195) opened from the `x / y` label button. Chapter numbering is display-oriented: parsed from filenames (`extractChapterInfo`), 0-indexed sets shifted +1 (781), footer total = max label visible in the list (800–803).

### 3.5 showScreen / registerScreen

reader.js:251–271. A `Set` of screen elements; `showScreen(id)` hides all via inline `style.display='none'`, shows the target as `block` (reader/novel screens, which scroll) or `flex` (everything else), stamps `document.body.dataset.screen`. Unknown ids warn (264). Unregistered-but-existing elements are tolerated and auto-added (265). Modules created at runtime call `window.registerScreen(el)` once at init. `body[data-screen]` is load-bearing: catalogue.js gates image-progress writes on it (1834), and CSS may key off it.

### 3.6 Service worker caching strategy (sw.js)

- Cache name `cbz-reader-v5.03` (sw.js:1) — **manual version bump is the update mechanism**.
- **Install** (22–34): precache 15 shell assets, each `cache.add` individually with catch (comment 25–27: `addAll` is all-or-nothing; a 404 mid-deploy would leave no cache). `skipWaiting()`.
- **Activate** (36–44): delete all other cache keys, `clients.claim()`.
- **Message** (46–50): `'GET_VERSION'` → posts `{type:'VERSION', version}` (used by `#home-version` display).
- **Fetch** (67–118): GET-only; **same-origin only** (73: `url.origin !== self.location.origin` → return — gateway/CDN images are NEVER SW-cached).
  - `isData` (55–57: `/catalog.json` or path containing `/chapters/`) → **network-first**, cache successful responses, offline fallback to cache else `503 {"error":"offline"}` (75–92).
  - `isFont` (63–65: `/fonts/*.woff2`) → **cache-first, cache-on-first-use** (fonts deliberately not precached, 59–62); failure returns empty 503 (cosmetic, system-font fallback).
  - Everything else → **cache-first** with network fallback, 503 text on total miss (111–117).

### 3.7 index.html anatomy

- Head (1–18): `viewport-fit=cover` (safe-area insets in use throughout styles.css: 114, 130, 165, 264, 343, 442…), `theme-color #0a0a0a`, `apple-mobile-web-app-capable`, `black-translucent` status bar, manifest + SVG icons.
- Static screens (only these live in index.html; other modules build their own): `#upload-screen` (21–67, includes `#file-input` accept=".cbz,.zip" multiple at 55, `#library-list`, offline badge, `#go-online-btn`, `#home-version`), `#home-screen` (70–112), `#series-screen` (115–134), `#loading-screen` (136–139), `#reader-screen` (141–197: header w/ `#close-btn`/`#comic-title`/`#mode-toggle`; empty `#reader-pages` at 154; footer w/ indicator, chapter nav, gap toggle, autoscroll toggle; `#autoscroll-bar`; `#cs-overlay` modal).
- Notices `#size-notice`/`#order-notice` live OUTSIDE all screens (199–208) so they show regardless of active screen.
- Script load order (210–222) is contractual: config → store → jszip → reader → novel-reader → importer → catalogue (boots app).

---

## 4. Patterns & conventions (follow these in new code)

1. **Classic scripts, no modules, no build step.** reader.js is bare top-level code; newer modules are IIFEs exporting onto `window`. New platform code (js/platform.js) should be an IIFE exporting `window.Platform`, loaded early in the contract order.
2. **DOM creation style:** `document.createElement` + `textContent` for anything touching user/content strings (library rows 185–222, chapter divider 474, selector buttons 1155–1156). `innerHTML` is used ONLY for app-authored SVG/markup templates (GEOMETRIC_SVG 440, buildProgressBar, bottom nav 1067, icons). This is the XSS boundary — keep it.
3. **DocumentFragment batching** for lists ("single reflow", 1165; renderChapter/renderAllChapters/renderShell all build frags).
4. **Error handling:** silent-catch with graceful degradation for storage (`try{localStorage…}catch(e){}` 126, 1278), `console.warn`/`console.error` + user-facing notice for content errors (667, 264), never throw to the user. SW registration failure swallowed (8).
5. **Comment voice:** long explanatory comments stating WHY, often naming the exact platform bug ("OOM crash on iPhone" 543, "WebKit's image-resource cleanup runs during GC" 1117, "spreading a large Set into Math.min can overflow the call stack" 931). Section banners with `─` box-drawing lines (367, 557, 819…).
6. **Persistence split:** the image reader itself uses raw localStorage (`or.library`, `or.gap`, `or.session` legacy) — it predates `Store`. Online-chapter progress goes through `Store.putProgress`, but only via catalogue.js's `syncImageProgress`. Debounce/throttle every persistence write (1.5 s: 1047, catalogue.js:1836) + flush on `visibilitychange` (1472–1475).
7. **Generation counters + explicit teardown** for every async-vs-DOM race (`gen` per page, `chapterJumpTimer`, `isLoading` guard, observer disconnect before recreate 916).
8. **Naming:** camelCase functions/vars, SCREAMING_SNAKE consts, `or.*` localStorage keys, kebab-case DOM ids, CSS state classes `.hidden` / `.ui-hidden` / `.placeholder`.
9. **Event hygiene:** `e.stopPropagation()` on every control inside tap-to-toggle surfaces; `resetIdle()` after every interaction; `{passive:true}` on touchstart (1381).

---

## 5. Extension points for the mobile refactor

### 5.1 Capacitor wrapper — what must change and where

- **Service worker inside Capacitor iOS: assume it does NOT work.** Capacitor iOS serves from `capacitor://localhost` via `WKURLSchemeHandler`; Service Workers are not supported for custom schemes in WKWebView (SW support exists only for app-bound domains over https with special entitlements, and Capacitor's default scheme handler doesn't provide it). Android (`https://localhost` via WebViewAssetLoader) also has no SW guarantee. **BUT: the app barely needs it in Capacitor** — the shell assets are local app-bundle files (instant, "cached" by definition), and content offline-ness comes from IndexedDB (`Store`) + the planned native Filesystem, not the SW. Plan: registration at reader.js:7–9 must become conditional (`if (!window.Capacitor)` or via `Platform.isNative`), and the two things SW currently adds that need substitutes are: (a) network-first freshness for `catalog.json`/`chapters/**` — plain fetch already does that natively since files are bundled; (b) font cache-on-use — irrelevant when fonts ship in the bundle.
- **`sw.js` relative paths** (`'./'` scoped) and same-origin check (sw.js:73) are scheme-agnostic — nothing hardcodes https or a host. Good.
- **`location.reload()` as upload-flow reset** (1469) works under `capacitor://` but reloads the whole webview (loses splash-state, replays boot). Acceptable initially; longer-term replace with an in-app reset that calls `resetReaderState()` + `showScreen('upload-screen')`.
- **`window.scrollTo/scrollBy/scrollY` + `document.documentElement.scrollHeight`** (1110, 1334, 1342, 1353–1354, 1359): the reader scrolls the WINDOW, not an inner container. In Capacitor this still works, but iOS webview behaviors (rubber-banding, keyboard resize) apply to the whole page. If a refactor ever moves reading into an inner scroll container, every one of these sites plus the IntersectionObserver root (currently viewport, 919–951) must change together.
- **File input → native picker:** `#file-input` (index.html:55) + change handler (583) take `File` objects and call `f.arrayBuffer()`. The platform bridge should feed the same pipeline: extract the handler body into a callable `loadArchives(files)` (currently anonymous — **needs extraction**, see risks) so `Platform.pickFiles()` (native document picker returning File/Blob-likes or Filesystem paths) can invoke it without synthesizing input events.
- **Native filesystem for the library (requirement 3):** today uploaded archives are NOT persisted at all — close/reload and the user must re-pick files ("Resume" only restores position after re-upload; `Store.putBlob` exists but reader.js never uses it). Under Capacitor, copy picked archives into the app's Documents/Data dir via Filesystem API, keep a manifest (Store or Preferences), and reopen from disk. Extension point: replace `f.arrayBuffer()` (643) with a `Platform.readFile(path)` that returns ArrayBuffer, and better, stream per-chapter instead of loading all zips up front.
- **Safe areas:** already handled via `env(safe-area-inset-*)` throughout styles.css (114, 130, 165, 264, …) + `viewport-fit=cover` (index.html:5). Capacitor needs the same viewport meta; verify insets are non-zero under `capacitor://` (they are, with viewport-fit=cover).
- **iOS eviction resilience already exists** (visibilitychange save 1472–1483, `or.library` high-water marks) — keep it; native Preferences via the bridge can mirror `or.library`/`or.gap` for durability beyond WKWebView localStorage purges (ITP 7-day purge does NOT apply inside Capacitor, but OS storage pressure can still clear WKWebView data — mirroring to Capacitor Preferences/Filesystem is the fix).
- **`window.gatewayUrl` / worker proxy:** in native, CORS does not bind native HTTP plugins — but the webview fetch/img loads are still CORS/referer-bound. Hotlink-protected images could route through `CapacitorHttp` instead of the Cloudflare worker; `proxyImageUrl` (231–239) is the single choke point to swap.

### 5.2 Memory optimization opportunities (requirement 2)

Current ceiling ≈ 600 MB of zip ArrayBuffers + ≤60 decoded bitmaps + all-wrappers DOM in scroll mode. Concrete levers, in impact order:

1. **Stop holding every archive's ArrayBuffer.** Phase 1 (643) loads all zips into memory for the session. With native Filesystem, read + index archives once, then re-open the needed chapter's bytes on demand (or pre-extract images to disk and feed `capacitor://` file URLs / `Filesystem.readFile` blobs to `loadPage`). This alone could cut resident memory by an order of magnitude and lets the 600 MB cap (627) be raised or removed.
2. **Tune windows per device:** `MEMORY_WINDOW`/`CACHE_WINDOW` (52–53) and lookahead (−4/+10, 945) are constants; make them `Platform`-informed (device RAM class, `navigator.deviceMemory` is unavailable on iOS — use heuristics or plugin).
3. **Scroll-mode wrapper count:** thousands of `.page-wrapper` divs (496–528). If scroll mode matters on low-end devices, chunk it (render N chapters around current) — but note append-only/anchoring concerns.
4. Keep the 150 ms GC-idle defer (1114–1121) and the `el.src=''` teardown discipline (541–544) — they encode hard-won WebKit knowledge; do not "simplify" them away.
5. `content-visibility: auto` on `.page-wrapper` could let WebKit skip offscreen rendering work — check styles.css before adding (not currently used).

### 5.3 Goals + timers feature (requirement 5) — hooks in this slice

- **Reading-time signal:** the reader has no clock today. Natural hook points: `showScreen('reader-screen')` / `document.body.dataset.screen` transitions (267) for session start/stop; `visibilitychange` (1472) for pause; `updateIndicator` (1015) fires on every page change → pages-read counter; `saveToLibrary` (91) already computes chapter/page deltas with high-water marks — goals can subscribe to the same debounced moment (1047–1048).
- **Chapters/pages-read events:** cleanest is a tiny event emitter: dispatch a `CustomEvent('or:reading-progress', {page, chapter, seriesKey, mode:'image'})` from `updateIndicator` and let the goals module (its own file per module-owns-its-DOM) listen. Mirror in novel-reader. Do NOT instrument `resolveChapterContent` — the `loadOnlineChapter` direct `src`/`mdChapterId` paths bypass it (catalogue.js:1760–1783).
- **Timer UI:** goals module registers its own screen/overlay via `registerScreen` + builds DOM at init (contract §2). Autoscroll's idle-hide (`resetIdle` 1306) will hide any chrome injected into header/footer — an in-reader timer chip should live outside `#reader-header`/`#reader-footer` or opt into `ui-hidden` deliberately.
- **Per-series customization:** use `Store.prefs.getFor/setFor(seriesId, 'goals.*')` — but note local CBZ uploads have no `series.id`; their identity is the `or.library` `key` (line 97). A goals feature spanning both worlds needs a unified series key (extension point: expose `seriesKey`/library key from reader.js, or migrate `or.library` into Store).

---

## 6. Risks & landmines

1. **reader.js has NO module boundary.** ~40 file-scope globals (`pages`, `chapters`, `currentPage`, `chapterMode`, `uiHidden`, …) are the API; catalogue.js mutates them directly (catalogue.js:1744–1746, 1791–1822). Any wrapping of reader.js in an IIFE, renaming, or `'use strict'` addition **breaks catalogue.js silently** (and `readerOrigin = 'upload'` at 592 relies on non-strict implicit-global assignment — strict mode would throw). If the refactor touches reader.js structure, catalogue.js's hand-off must move in the same change.
2. **The upload pipeline is one 234-line anonymous event handler** (583–817). Native file picking cannot reuse it without either synthesizing a change event or extracting the body. Extract to `loadArchives(files: File[])` and have both the input handler and `Platform.pickFiles` call it — behavior-preserving, contract-safe.
3. **Two divergent persistence worlds:** local uploads → `localStorage['or.library']` (max 5 entries, title-keyed, 91–127); online chapters → `Store.putProgress` (series-id-keyed). The catalogue "Continue reading" rail only sees Store. Requirement 3 (native library) will force unification — plan the migration (`migrateOldSession` 130–145 is the precedent for one-shot migrations).
4. **SW absence in Capacitor changes update semantics.** On the web, `cbz-reader-v5.03` bump + SW controls what users run; in Capacitor the bundle IS the version. `#home-version` reads the SW version via postMessage (sw.js:46–50) — will show nothing natively unless `Platform` supplies the app version. Also the "Offline mode" badges (index.html:58–61, 88–91) key off connectivity/SW assumptions owned by catalogue.js — verify their logic under native.
5. **WebKit memory hacks are load-bearing:** the 150 ms defer (1114–1121), `el.src=''` before dropping refs (541–544), the soft/hard window split with dead-blob-URL srcs (896–902), and the min-visible explicit loop (931–933). A well-meaning cleanup that revokes URLs "properly" in the soft window or switches the defer to rAF will reintroduce iPhone OOM crashes / flashes. Preserve verbatim; add comments pointing at any new native paths.
6. **Dead blob URL in `img.src` after soft-window revoke** (896–902): the element's src is a revoked blob URL. If Capacitor's scheme handler or a webview reload re-requests that src (e.g., on memory-pressure image dump + repaint), it 404s → error → but `onerror` was set by loadPage and will clear state for retry only if still wired. Test scroll-back behavior under memory pressure on device.
7. **600 MB cap + `f.arrayBuffer()` all-up-front** (627, 643): on a 3 GB-RAM iPhone the practical crash ceiling is well below 600 MB once decode overhead is added. Native filesystem streaming (risk-free chapters on disk) should land BEFORE raising any limits.
8. **`fileInput.value=''` + `location.reload()` coupling:** the close button in upload mode reloads the page (1468–1469) — that is how ALL reader state is guaranteed clean for the offline path. If reload is replaced (e.g., to keep a native session alive), audit that `resetReaderState()` covers everything reload was doing (it resets most but not `chapterMode`, `gapLevel`, autoscroll state, `uiHidden` — some intentionally persistent).
9. **Scroll mode renders all wrappers** (496–528) — with the cap removed via native storage, a 2000-page series means 2000 wrappers + observer entries. IntersectionObserver with thousands of targets is fine-ish, but budget it; consider chapter-window rendering in scroll mode as part of the memory work.
10. **`showScreen` uses inline `style.display`** (262–266) — any CSS that tries to control screen visibility (e.g., animated transitions for native feel) will fight the inline style. New transition work must go through/extend `showScreen`, which is also the natural hook for haptics/status-bar color per screen (`document.body.dataset.screen` already distinguishes them).
11. **`buildProgressBar` / decor / bottom-nav use innerHTML string templates** with interpolated values (982–1013, 1067–1076). All inputs are currently app-controlled numbers/constants — keep it that way; never interpolate content strings (titles, chapter names) into these templates. Chapter names correctly go through `textContent` today (474, 1156).
12. **Chapter-number heuristics are fragile by design** (`extractChapterInfo` 309–328, 0-index shift 775–796, dedupe 682–699): they encode many filename edge cases. Native file import must feed the SAME name strings through this pipeline (pass original filenames, not native URIs/paths — `basename` at 243 handles separators, but percent-encoded native paths would break parsing).
13. **Same-origin SW check** (sw.js:73) means gateway-proxied images were never SW-cached — image offline-ness for online series does not exist today (only progress is saved). If the mobile app promises "download chapter for offline", that's NEW capability (native Filesystem + `Store.putChapter` pages), not a port of existing behavior.
