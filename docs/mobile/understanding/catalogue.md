# Slice map: js/catalogue.js + js/config.js — routing, boot, resolver, catalogue UI

Deep-read of `/home/user/Offline-Reader/js/catalogue.js` (2052 lines) and
`/home/user/Offline-Reader/js/config.js` (24 lines), against the binding contract
`/home/user/Offline-Reader/docs/ARCHITECTURE.md`. Cross-checked against
`/home/user/Offline-Reader/index.html` (script order) and
`/home/user/Offline-Reader/js/reader.js` (screen registry, SW registration).

Written for the Capacitor mobile refactor (iOS priority, memory-friendly, native
storage for library uploads) and the new **book goals + timers** feature.

---

## 1. Files and their roles

### js/config.js (whole file, 24 lines)

- `window.OR_CONFIG` (config.js:4-16) — the ONLY deployment configuration object:
  - `workerBase: ''` (config.js:9) — Cloudflare Worker gateway base. **Currently empty** → all gateway features (add-by-link, `/chapter`, `/image` proxy) are disabled and must degrade gracefully.
  - `chapterBase: './chapters/'` (config.js:12) — where bundled ChapterFiles live, relative to app root.
  - `catalogUrl: './catalog.json'` (config.js:15) — catalogue fetched at boot.
- `window.gatewayUrl(path, params)` (config.js:19-24) — builds `<workerBase><path>?<qs>` or returns `null` when workerBase is empty. Callers must handle `null`.
- Load-order contract (ARCHITECTURE §2, index.html:213-222): `config.js` loads **first**, before store/reader/novel-reader/importer/catalogue. This makes config.js (or a script inserted right after it, e.g. the planned `js/platform.js`) the natural place to rewrite `catalogUrl`/`chapterBase`/`workerBase` for the native build **before any consumer reads them**. Note both `chapterBase` and `catalogUrl` are read lazily at use time (catalogue.js:411, catalogue.js:849), not captured at load, so even an async platform bridge can patch them before first fetch if it runs before `Catalogue.boot()`'s network calls.

### js/catalogue.js — module layout (IIFE, classic script, `'use strict'`)

Section banners in the file (box-drawing `─` headers) and their contents:

| Section | Lines | Contents |
|---|---|---|
| State | 25-53 | `TABS`, `TEXT_TYPES`, `BLOCK_TYPES`, `WPM=250`, `MAX_RANGE_DOWNLOAD=100`, module state vars |
| Small utilities | 59-180 | `prefGet/prefSet` 59-65, `currentTab` 67, `currentLayout` 68, `debounce` 70, `el` 79, `ICONS`/`icon()` 87-113, `safeImageUrl` 117, `imgUrl` 127, `safeHttpUrl` 133, `fmtDate` 137, `fmtWords` 148, `readingTime` 155, `countWords` 163, `isTextSeries` 169, `chapterLabel` 171, `chapterName` 176 |
| Tagged errors | 182-208 | `catErr` 190, `ERROR_TEXT` 198, `errorText` 206 |
| Store wrappers | 210-221 | `store()` 214, `safeCall(method, args, fallback)` 216 |
| Catalogue normalization v1→v2 | 223-295 | `slugify` 227, `inferType` 231, `normalizeChapter` 245, `normalizeSeries` 260, `migrateCatalog` 288 |
| Block normalization (XSS boundary) | 297-389 | `normalizeBlocks` 301, `textToBlocks` 330, `blocksWordCount` 341, `fileHasPayload` 349, `normalizeChapterFile` 355 |
| Fetch helpers | 391-424 | `fetchJson` 395, `resolveSrcUrl` 408, `mangadexPages` 418 |
| resolveChapterContent | 426-504 | `inflight` map 438, `resolveChapterContent` 440-502, exported at 504 |
| DOM construction | 506-842 | `dom` bag 514, `ensureDom` 516, `buildTabs` 547, `onTabKeydown` 576, `buildContinue` 589, `buildGridToolbar` 606, `buildEmptyState` 661, `buildSeriesExtras` 684, `updateSortButton` 817, `buildToast` 826, `toast` 836 |
| Data loading | 844-888 | `loadCatalog` 848, `loadUserSeries` 864, `loadProgress` 869, `mergeSeries` 873, `findSeries` 882, `isUserSeries` 886 |
| Home screen | 890-1297 | `matchesTab` 894, `matchesQuery` 901, `visibleSeries` 908, `renderHome` 914, `syncTabs` 954, `syncLayout` 965, `setTab` 981, `setLayout` 986, `renderContinue` 993, `resumeProgress` 1041, `latestChapter` 1060, `latestDate` 1069, `placeholder` 1074, `kindBadge` 1085, `renderLatest` 1098, `renderGrid` 1147, `cardShell` 1158, `mangaCard` 1179, `novelCard` 1206, `spineFallback` 1232, `confirmDelete` 1239, `openImporter` 1246, `renderEmpty` 1256 |
| Series detail screen | 1299-1646 | `openSeries` 1303, `renderHero` 1344, `heroPlaceholder` 1402, `renderStats` 1414, `orderedChapters` 1444, `resumeTarget` 1453, `renderPrimaryAction` 1466, `chapterState` 1489, `renderChapterList` 1497, `chapterRow` 1527, `downloadChapter` 1581, `populateRangeSelects` 1601, `downloadRange` 1621 |
| Dispatch | 1648-1739 | `openChapter` 1652, `writeOpenProgress` 1718 |
| Image reader hand-off | 1741-1851 | `activeImageSession` 1749, `loadOnlineChapter` 1751 (exported window.loadOnlineChapter 1826), `syncImageProgress` 1832 |
| Routing | 1853-1902 | `pushScreen` 1857, `goHome` 1862, `refreshSeriesProgress` 1880, `goBack` 1891 |
| Wiring | 1904-1987 | `wireEvents` 1908, `wireServiceWorkerBadge` 1973 |
| Boot | 1989-2052 | `refresh` 1993, `initMode` 2006, `boot` 2024, `window.Catalogue` export 2034-2045, DOMContentLoaded hook 2047-2051 |

Module-level state (catalogue.js:38-53): `bundledSeries`, `userSeries`, `allSeries` (merged, user wins on id collision), `catalogError`, `currentSeries`, `chapterSortAsc`, `chapterQuery`, `cachedIds` (Set of cached chapter ids for currentSeries), `seriesProgress` (Progress row for currentSeries), `searchQuery`, `progressRows`, `navStack` (screen-id array), `domReady`, `booted`.

---

## 2. Patterns & conventions (follow these in any new module)

1. **IIFE + classic script, no modules, no build step.** `(function () { 'use strict'; … })()` (catalogue.js:18-19, 2052). Public surface exported by assigning to `window` (`window.Catalogue` 2034, `window.resolveChapterContent` 504, `window.loadOnlineChapter` 1826). ES5-style `function` expressions inside; `const`/`let` fine (ES2020 allowed per ARCHITECTURE).
2. **Module-owns-its-DOM.** All new UI built in JS at init and appended (`ensureDom` 516-545; `buildToast` appends to `document.body` 831). index.html only guarantees pre-existing containers by id (`#home-body`, `#series-hero`, etc., fetched at 519-533). Missing `#home-body` → `console.error('[Catalogue] #home-body missing — index.html is out of date')` and bail (535).
3. **DOM creation style:** `el(tag, className, text)` helper (79-84) that sets `textContent` only. `document.createElement` + `appendChild`, never HTML strings, except `icon()` (102-113) which uses `innerHTML` only on the static author-controlled `ICONS` table (87-100) — comment explicitly marks the exception.
4. **XSS boundary:** third-party strings only ever reach `textContent`; block lists go through `normalizeBlocks` (301-325) where unknown `t` degrades to `p` (308, "never dropped silently, never trusted"); image URLs through `safeImageUrl` (117-125, allows http(s)/data:image/blob/relative, drops any other scheme).
5. **Error handling:** tagged errors via `catErr(code, message, cause)` with `e.name='ChapterError'`, `e.code` (190-196); user-facing copy in `ERROR_TEXT` map (198-205: `offline`, `network`, `parse`, `empty`, `no-payload`, `gateway-disabled`); UI shows `toast(errorText(err))`. Store access always through `safeCall` (216-221) which returns a fallback and `console.warn('[Catalogue] Store.<method> failed')` — **the catalogue must render even if persistence is broken** (211). Prefs likewise wrapped (`prefGet`/`prefSet` 59-65).
6. **Console prefix:** `[Catalogue]` on every warn/error. `[showScreen]` in reader.js.
7. **Comment voice:** prose "why" comments, em-dashes, section banners of `─` characters; comments often record past bugs (e.g. 944-948 toolbar display leak, 1682-1686 navStack fix, 1043-1047 stale-anchor rationale). Keep this voice.
8. **Naming:** DOM ids/classes prefixed `cat-` (legacy classes `series-*`, `ch-*`, `update-*` reused for CSS continuity). Functions are `camelCase` verbs (`renderX`, `buildX`, `loadX`, `openX`, `syncX`, `wireX`). Constants SCREAMING_CASE at top.
9. **Accessibility is habitual:** `role=tablist/tab/tabpanel` + arrow-key handling (547-587), `aria-live` regions (612, 765, 829), `aria-label` on every icon button, `aria-expanded`, progressbar roles (1028-1031). New UI must match.
10. **Renders are full rebuilds:** every `renderX` starts with `container.textContent = ''` then rebuilds (e.g. 995, 1101, 1150, 1501). No virtual DOM, no diffing, no virtualization.
11. **Prefs pattern:** read through validating getters (`currentTab` 67 validates against TABS; `currentLayout` 68 whitelists), write via `prefSet`, then re-render (`setTab` 981-984, `setLayout` 986-989). Persisted keys: `catalogue.tab`, `catalogue.layout` (ARCHITECTURE §3.1).

---

## 3. Focus answers

### 3.1 Boot flow

Script order is contractual (index.html:213-222): `config.js → store.js → jszip → reader.js → novel-reader.js → importer.js → catalogue.js`. reader.js self-registers the service worker at top of file (`reader.js:7-8`: `navigator.serviceWorker.register('./sw.js').catch(() => {})`).

Catalogue boots itself (2047-2051): on `DOMContentLoaded` (or immediately if already parsed) → `boot()` (2024-2032):

1. `booted` guard (2025-2026, idempotent).
2. seeds `window.readerOrigin = 'upload'` if unset (2027) — a bare global reader.js reads to decide where its close button goes.
3. `ensureDom()` (2028) — grabs index.html containers, builds tabs/continue-rail/toolbar/empty-state/series-extras/toast once (516-545).
4. `wireEvents()` (2029) — home search input (1909-1915), series back button → `goBack` (1917-1921), `#go-online-btn` → home + refresh (1923-1930), `#go-offline-btn` → upload-screen (1932-1933), image-progress sampling listeners (`scroll`/`visibilitychange`/`pagehide` 1936-1938), `#close-btn` → force progress sync + `refreshSeriesProgress` (1939-1945), `offline`/`online` connectivity handlers (1949-1967), `or:library-changed` → `refresh()` (1970).
5. `wireServiceWorkerBadge()` (2030, defined 1973-1987) — `navigator.serviceWorker.ready` → postMessage `GET_VERSION` → writes version into `#home-version`. Guarded by `'serviceWorker' in navigator` and a swallow-all catch, so it is safe where SW is unavailable (comment at 1986: "no SW in this context — the badge just stays blank").
6. `initMode()` (2006-2022): **branches on `navigator.onLine`**. Online → `showScreen('home-screen')`, `navStack = ['home-screen']`, `refresh()`. Offline → `showScreen('upload-screen')` + offline badges, but still `refresh()` because the catalogue may be in the SW cache (2013-2020).

`refresh()` (1993-2004): `Promise.all([loadCatalog(), loadUserSeries()])` → `mergeSeries()` → `loadProgress()` → `renderHome()` → if a series screen is open, silently re-run `openSeries(fresh, {show:false})` to keep it in sync.

- `loadCatalog` (848-862): `fetch(OR_CONFIG.catalogUrl, { cache: 'no-cache' })` → `migrateCatalog`. Failure is survivable: `bundledSeries=[]`, `catalogError=e`, drives the "Library unavailable / Retry" empty state (1265-1272).
- `loadUserSeries` (864-867): `Store.listUserSeries()` → each row re-normalized via `normalizeSeries`.
- `loadProgress` (869-871): `Store.listProgress({limit:12})` — feeds the Continue rail.
- `mergeSeries` (873-880): Map keyed by id, bundled inserted first, user second → **user's copy wins on id collision** (comment 875-876).

### 3.2 Screen registry & routing

- Registry lives in reader.js: `registerScreen(el)` adds to a `screens` Set (reader.js:256-259); `showScreen(id)` hides every registered screen, `display:'flex'` (or `'block'` for `reader-screen`/`novel-screen` per `BLOCK_SCREENS`, reader.js:254), tolerates unregistered screens by adding them on demand (reader.js:265), and stamps `document.body.dataset.screen = id` (reader.js:267). Screen ids in use: `upload-screen, loading-screen, reader-screen, home-screen, series-screen, novel-screen, import-screen` (ARCHITECTURE §2.1). **A goals screen registers exactly like this** — build DOM, `window.registerScreen(elem)`, navigate with `showScreen('goals-screen')`.
- Catalogue owns navigation (ARCHITECTURE §2.2): other modules call `Catalogue.openSeries / openChapter / goBack / goHome`, never `showScreen` to go back.
- `navStack` (51) is a plain in-memory array of screen ids. `pushScreen(id)` dedupes consecutive ids and caps at 20 (1857-1860). `openSeries` pushes `series-screen` (1337); `openChapter` pushes the origin then `'reader'` (1686-1687 — pushing the reader itself so `goBack()` pops it and lands underneath; the comment records the bug this fixed).
- `goBack()` (1891-1902): pop; if the new top is `series-screen` and `currentSeries` exists → show series screen + `refreshSeriesProgress()` (re-reads Progress so resume button and read-marks reflect the session just finished, 1880-1889); **anything else falls through to `goHome()`**.
- `goHome()` (1862-1873): resets `navStack`, clears `activeImageSession`, resets `window.readerOrigin='upload'`, shows home, re-renders, then re-reads progress asynchronously to refresh the Continue rail (comment 1869-1872).
- **No History API / popstate anywhere.** Navigation is invisible to the browser/OS. See risks.

### 3.3 `window.resolveChapterContent(series, chapter)` — the one funnel (426-504)

Resolution order, **cache-first, network-second**:

1. `Store.getChapter(series.id, chapter.id)` via `safeCall`; returned as-is if `fileHasPayload` (449-450).
2. Inline payloads on the Chapter: `blocks` → `pages` → `text` (455-461), each through `normalizeChapterFile`.
3. `chapter.src` → `fetchJson(resolveSrcUrl(src))` (464-466). `resolveSrcUrl` (408-416): absolute http(s) and root-absolute pass through; paths containing `/` or starting `./` used as-is; bare filenames get `OR_CONFIG.chapterBase` prepended.
4. `chapter.mdChapterId` → MangaDex at-home API (`https://api.mangadex.org/at-home/server/<id>`, 418-424, 470-473).
5. Worker gateway: `chapter.url || chapter.sourceUrl || chapter.href` (http(s) only via `safeHttpUrl`) → `gatewayUrl('/chapter', {url, kind})`; **throws `gateway-disabled` if workerBase unset** (476-487).

Post-resolution: no file → `no-payload` (489). Cache write: `Store.putChapter` **except** pure-MangaDex chapters (`chapter.mdChapterId && !chapter.pages`) because at-home URLs are signed and expire (491-495). Concurrency: `inflight` Map keyed `seriesId + ' ' + chapterId` de-dupes concurrent resolves; entry removed in `finally` (438, 444-445, 499-501).

`normalizeChapterFile` (355-389): unwraps the worker `{ok, chapter}` envelope; builds blocks from `blocks` (via `normalizeBlocks`) or `text` (via `textToBlocks`); normalizes `pages` (strings or `{url}` objects); when a file carries both blocks AND pages, `series.type` breaks the tie (367-373); computes `wordCount` if absent. Errors: `parse` (non-object), `empty` (no payload).

`fetchJson` (395-405): `fetch(url, {credentials:'omit'})`; a thrown fetch becomes `offline` when `!navigator.onLine`, else `network`; non-2xx → `network`; bad JSON → `parse`.

Consumers: `downloadChapter` (1585), `downloadRange` (1637), `openChapter` (1672), and NovelReader for adjacent chapters in infinite/chapter modes (ARCHITECTURE §4).

### 3.4 Catalogue tabs & layouts

- `TABS` (25-31): `all / manga / manhwa / lightnovel / library`. **Const inside the IIFE — not extensible from outside.** Adding a tab (e.g. Goals) means editing catalogue.js.
- Active tab persisted as pref `catalogue.tab`, validated in `currentTab()` (67); layout `catalogue.layout` (`grid`|`list`) in `currentLayout()` (68). `setTab`/`setLayout` (981-989) write the pref and re-render — the pref IS the state, there is no separate tab variable.
- `matchesTab` (894-899): `all` → everything; `library` → `isUserSeries(s)`; `lightnovel` → `TEXT_TYPES` (lightnovel+webnovel); else strict `s.type === tab`.
- Search: `matchesQuery` (901-906) over title + altTitles + author + genres + tags, lowercase substring; input debounced 180 ms (1911-1915).
- `renderHome` (914-952): hides `#home-state`, syncs tabs/layout, renders Continue rail, "Latest updates" rail (hidden while searching / on library tab, 929-932), section label, count, Add-series button (**library tab only**, 941), grid, empty states. Comment at 944-948 warns about the past inline-display leak between the home toolbar and the chapter toolbar.
- Layout is pure CSS class toggling on `#series-grid` (`cat-layout-list`/`cat-layout-grid`, 965-970); cards are rebuilt either way. Card factories: `mangaCard` (poster, 1179) vs `novelCard` (book spine + author, 1206); shared `cardShell` (1158-1177) adds the library-only delete button as an overlay **sibling** (nested `<button>` would be invalid markup, 1166-1175).

### 3.5 Library tab ("My Library")

- Contents: `isUserSeries` (886-888) = `source === 'user'` OR present in `userSeries` (from `Store.listUserSeries()`).
- Add flow: `openImporter` (1246-1252) delegates to `window.Importer.openDialog()`, toasts if the importer module is absent. Add button and library empty-state both route there (620-622, 1278-1284).
- Delete flow: `confirmDelete` (1239-1244) uses **`window.confirm`**, then `Store.deleteUserSeries(id)` (which cascades to cached chapters + progress per Store contract), toast, `refresh()`.
- Update signal: importer dispatches `or:library-changed` on window; catalogue listens and refreshes (1970). **This is the model event for cross-module signalling** — a goals module should follow it (e.g. `or:goals-changed`).
- Ordering: `Store.listUserSeries()` returns newest `addedAt` first; "Latest updates" rail deliberately hidden on library tab (930).
- Uploaded EPUB/CBZ blobs go to `Store.putBlob` (Store contract §3) — **this is the seam where native Filesystem storage replaces IndexedDB blobs** under Capacitor; catalogue.js itself never touches blobs, so the swap is invisible to this module as long as the Store API shape is preserved.

### 3.6 "Continue reading"

Two layers:

**Home rail** — `loadProgress()` pulls up to 12 Progress rows desc by `updatedAt` (869-871). `renderContinue` (993-1039) filters to rows whose series still exists in `allSeries` (997 — orphan progress is silently hidden, not deleted), builds a card per row (cover, title, chapter label, progressbar from `pct` clamped 0..1). Click → `resumeProgress(row)` (1041-1056): **re-reads `Store.getProgress` rather than trusting the rendered row** (comment 1044-1047: a stale anchor would be written back by the reader and destroy the real position); finds the chapter by `chapterId` (fallback: first chapter); renders the series screen without showing it (`openSeries(series, {show:false})`, 1054) so the reader's close button has somewhere to land; then `openChapter(series, chapter, {resume: p})`.

**Series-screen primary button** — `resumeTarget` (1453-1464): no progress → first chapter (`fresh:true`); progress chapter missing → first chapter; `completed && next exists` → next chapter fresh; else resume in place. `renderPrimaryAction` (1466-1487) labels it "Start reading" / "Start at Ch. N" / "Continue from Ch. N".

**Progress write path** — `openChapter` re-validates the resume row against the store (1658-1663), then `writeOpenProgress` (1718-1739) stamps series/chapter metadata and **zeroes positional fields unless genuinely resuming the same chapter** (1729-1735). During image reading, `syncImageProgress` (1832-1851) samples reader.js's `currentPage`/`pages` globals, throttled ≥1.5 s, forced on `visibilitychange`/`pagehide`/close; only runs while `document.body.dataset.screen === 'reader-screen'` and `activeImageSession` is set. `pct = idx/(total-1)`, `completed = idx >= total-1`. NovelReader writes its own progress (throttled ≥1 s, per ARCHITECTURE §4). Per-chapter read/unread marks come from `chapterState` (1489-1495): num-comparison against the single Progress row — **there is no per-chapter read history, only one row per series**.

### 3.7 Chapter dispatch

`openChapter(series, chapter, opts)` (1652-1714): re-read progress → `loading-screen` → `resolveChapterContent` (failure: back to origin screen + toast, 1673-1678) → `writeOpenProgress` → push navStack → dispatch on `file.kind`:
- image → `loadOnlineChapter(series.title, {…chapter, pages:file.pages}, {series, chapter, resumePageIdx})` (1689-1695).
- text → `NovelReader.open({series, chapter, blocks, resume:{blockIdx, charOffset, pct}})` (1698-1708); missing NovelReader degrades with a toast (1711-1713).

`loadOnlineChapter` (1751-1824) is also a direct entry point (exported at 1826, used by legacy paths): it can itself resolve `mdChapterId` (1760-1769) and `src` (1772-1783) — **note: those direct paths bypass the Store cache entirely**. It then pokes reader.js internals: `resetReaderState()`, pushes into `pages[]` with `directUrl: imgUrl(url)` (1793-1795), `chapters[]`, sets `maxChapterNum`, `baseChapterOffset`, `comicTitle.textContent`, `lastLoadedFileNames`, `window.readerOrigin='series'`, then `renderShell(); setupObservers(); showScreen('reader-screen'); updateUI(); resetIdle(); setupUI(); jumpToChapter(0, target)` (1791-1823). The header comment (1741-1747) declares this global-poking **is the contract**: reader.js has no module API. **Any change to script loading (bundler, ES modules, defer reordering) breaks these implicit global lexical bindings.**

---

## 4. Extension points for the mobile refactor and the goals feature

1. **config.js first-loader slot** (index.html:213): insert `js/platform.js` immediately after `config.js` (or before it) to detect Capacitor and override `OR_CONFIG` values and provide `window.proxyImageUrl`. Both `catalogUrl` (849) and `chapterBase` (411) are read lazily, at fetch time.
2. **`window.proxyImageUrl` hook** (127-131): every cover/page URL flows through `imgUrl` → `window.proxyImageUrl(safe)` if defined. A platform bridge can install this to route images through a native fetch/cache layer with zero catalogue changes.
3. **`window.gatewayUrl`** (config.js:19) is a plain window function — replaceable by a native-HTTP implementation.
4. **Screen registry**: `window.registerScreen(el)` + `window.showScreen(id)` (reader.js:256-271) — a goals screen is a first-class citizen this way. `document.body.dataset.screen` is a readable "current screen" signal (used by syncImageProgress at 1834) that a goals timer can watch to know when reading is active.
5. **`window.Catalogue` public API** (2034-2045): `boot, openSeries, openChapter, goBack, goHome, refresh, getSeries(id), listSeries()`. `listSeries()` returns a copy — safe for a goals module to enumerate series/wordCounts. `openChapter` is the single user-visible "started reading" event; a goals module can **wrap** `Catalogue.openChapter` (and `goBack`/`goHome` for "stopped reading") to run session timers without touching catalogue.js.
6. **Progress as the metric source**: all reading progress lands in `Store.putProgress` (writeOpenProgress 1737, syncImageProgress 1843, NovelReader's own writes). There is **no progress event today** — goals either poll `Store.listProgress`, wrap `Store.putProgress`, or (cleanest, needs a small Store change) add an `or:progress` CustomEvent alongside the existing `or:prefs` event pattern.
7. **`Store.prefs` event bus**: `prefs.set` fires `or:prefs` CustomEvent and `prefs.on(fn)` subscribes (Store contract §3). Goals settings should be prefs (`goals.*` keys), getting persistence + change notification + per-series overrides (`prefs.getFor(seriesId, …)`) for free — matching requirement "per-series preferences".
8. **`or:library-changed` window event** (1970) — the established cross-module refresh signal; mirror it for goals.
9. **Reading-time vocabulary already exists**: `WPM = 250` (35), `readingTime(words)` (155-161), `fmtWords` (148), `countWords` (163), `blocksWordCount` (341), per-series `s.wordCount` computed in `normalizeSeries` (284). Not exported — goals must duplicate or catalogue must export them.
10. **Home-screen insertion pattern**: `buildContinue` (589-604) shows how to add a home section (label + rail inserted into `#home-body` before `#latest-section`). A "Goals" card/section can be added identically — but `#home-body` internals are catalogue-owned, so per the "module owns its files" rule the section either goes into catalogue.js or catalogue must expose a mount point.
11. **`TABS` (25-31) is closed** — a goals tab requires editing catalogue.js (small, but it is an edit, not a hook).
12. **Store swap seam**: catalogue touches persistence only through `safeCall` → `window.Store` (216-221). Re-backing Store with Capacitor Filesystem/Preferences/SQLite keeps this module untouched as long as method names, promise semantics ("never rejects for expected conditions") and shapes hold.
13. **Connectivity handlers** (1949-1967) are addEventListener-based on `window` `online`/`offline` — the platform bridge can dispatch synthetic events or, better, these handlers need a platform-aware rewrite (see risks).
14. **`wireServiceWorkerBadge`** (1973-1987) and reader.js:7-8 registration are both already guarded — they no-op harmlessly where SW is unavailable.

---

## 5. Risks / landmines for the Capacitor refactor

1. **`navigator.onLine` boot gate** (initMode 2008): in a Capacitor app, `navigator.onLine` can be false/unreliable at WebView start; boot would land on `upload-screen` even though catalog.json and chapters are **bundled local files that always work**. The whole online/offline dichotomy inverts under native packaging.
2. **`offline` event drops the user to the CBZ upload screen** (1949-1958) while browsing home/series. Correct for a hosted PWA; wrong in the native app where the bundled catalogue is local. Must be platform-gated. Same for `fetchJson`'s `navigator.onLine`-based `offline` error code (400) — local fetches should never be classified "offline".
3. **`fetch('./catalog.json')` under a `file://` origin fails** (XHR/fetch of file URLs is blocked in WebViews). Under Capacitor defaults (`capacitor://localhost` on iOS, `https://localhost` on Android) relative fetch works — but **`cache:'no-cache'` (851) and SW-cache assumptions become meaningless**, and any config that opts into raw `file://` serving breaks catalogue + chapter `src` fetches (465, 1775) outright. Keep Capacitor's local-server scheme; do not serve from file://.
4. **Service worker**: `navigator.serviceWorker.register('./sw.js')` (reader.js:7-8). SW is unsupported on `capacitor://` (iOS WKWebView custom schemes) — registration rejects and is swallowed, fine; but **everything the SW provided (shell precache, on-demand font caching per ARCHITECTURE §3.2, chapter caching) silently disappears**. Native bundle covers the shell; fonts are bundled files so they load directly; but remote images/chapters lose their SW cache layer — the Store/IndexedDB cache in `resolveChapterContent` becomes the only offline layer. `wireServiceWorkerBadge`'s `navigator.serviceWorker.ready` **never resolves** when registration failed — harmless here (promise just hangs) but don't copy the pattern.
5. **No History API / hardware back button**: `navStack` is memory-only; nothing listens to `popstate`. On Android, the system back button will background/exit the app instead of calling `Catalogue.goBack()`. The Capacitor `App` plugin's `backButton` event must be bridged to `Catalogue.goBack()`; iOS edge-swipe similarly does nothing today.
6. **reader.js implicit-global coupling** (1741-1747, 1791-1823, 1839-1841): catalogue reads/writes `pages`, `chapters`, `maxChapterNum`, `baseChapterOffset`, `comicTitle`, `lastLoadedFileNames`, `currentPage`, `chapterMode`, `uiHidden`, and calls `resetReaderState/renderShell/setupObservers/updateUI/resetIdle/setupUI/jumpToChapter` as bare globals, plus `window.readerOrigin`. **Any move to ES modules, bundling, or `defer`-reordering breaks this silently.** Keep classic scripts in the exact index.html order inside the native web bundle.
7. **MangaDex direct API + at-home image hosts** (418-424): cross-origin fetches from a `capacitor://` origin depend on the remote's CORS headers (MangaDex API sends `*`; at-home image servers serve `<img>` so no CORS needed). If anything breaks, route via a native-HTTP `proxyImageUrl`/`gatewayUrl`. Also note the deliberate no-cache rule for MD pages (491-494) — do not "optimize" it away; the URLs expire.
8. **Memory hazards for low-end phones (first-class requirement):**
   - `allSeries` keeps every series **with full chapter arrays** in memory (38-40; `normalizeSeries` copies every chapter at 280-282). A large catalog.json is duplicated (raw parse + normalized copies) during `loadCatalog`.
   - `renderGrid` (1147-1156) and `renderChapterList` (1497-1525) build a DOM node per item with **no virtualization or pagination** — a 3000-chapter series creates 3000 rows (each with 2 buttons + SVG icons). `populateRangeSelects` adds 2×N `<option>`s (1601-1619). On a phone this is the biggest DOM-memory lever.
   - Full-rebuild renders (`textContent=''`) churn nodes on every tab/search keystroke (debounced, but still O(list)).
   - Mitigations already present: `loading='lazy'` on all card/rail images (1012, 1120, 1187, 1214), `inflight` de-dupe, chapters cached in IndexedDB not memory, `MAX_RANGE_DOWNLOAD=100` cap (36), progress rail capped at 12 (870).
9. **`window.confirm` for library delete** (1240): works in WebViews but shows a browser-styled dialog with the origin string on some platforms; the platform bridge should offer a native dialog replacement (extension point: replace `confirmDelete`'s confirm call).
10. **localStorage-backed prefs** (Store.prefs, contract §3): iOS can evict WKWebView website data under storage pressure. Under Capacitor, prefs (`catalogue.tab`, all `novel.*`, future `goals.*`) should be re-backed by the Preferences plugin behind the same synchronous `Store.prefs` facade — note the facade is **synchronous by contract** (currentTab 67 is called mid-render), so a native async backend needs a warm in-memory mirror hydrated before `Catalogue.boot()`.
11. **IndexedDB eviction on iOS**: cached chapters + user library + progress all live in IDB; WKWebView data can be purged. This is the core motivation for requirement #3 (native storage) — the swap must happen inside store.js, not here, but catalogue's `safeCall` fallbacks mean a broken Store degrades to an empty library **silently** (216-221). Test that path.
12. **Single Progress row per series** (chapterState 1489-1495): "read" marks are inferred from `chapterNum` ordering, not recorded per chapter. Goals features like "chapters read this week" cannot be derived from existing data — they need their own event log (new Store store), written at the putProgress choke points listed in §4.6.
13. **`resumeProgress`/`openChapter` stale-anchor discipline** (1044-1056, 1655-1663): any new code path that opens a reader MUST re-read progress from the store first, or it will clobber the real position. Comments document the bug class twice; do not regress it.
14. **`loadOnlineChapter`'s direct `src`/`mdChapterId` paths bypass the Store cache** (1760-1783) — legacy but live. If goals count "chapters read", instrument `openChapter`/progress writes, not `resolveChapterContent`, or these paths go uncounted.
15. **Toolbar/inline-style state leaks between screens**: several elements are shown/hidden with inline `style.display` shared across renders (rangePanel 1616, actions 1618, gridToolbar 948, latestSection 931). The 944-948 comment records one past leak. New screens toggling shared elements must reset them.
16. **Safe areas / notches**: nothing in this module handles `env(safe-area-inset-*)`; the tabs bar (`buildTabs` 547) and toast (`buildToast` 826, appended to body) will sit under the iPhone home indicator/notch without CSS work in the platform layer.
17. **`catalog.json` fetch failure UX** (856-861, 1265-1272) assumes "check your connection" — in the native app a missing bundled catalogue is a packaging bug, not a connectivity issue; copy should be platform-aware.
