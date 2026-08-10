# Slice map: file import pipeline (js/importer.js + adjacent seams)

Scope: the EPUB/TXT/CBZ/ZIP import pipeline end to end — file picking, JSZip
parsing, blob persistence, size limits, memory behavior, and exactly where a
native (Capacitor) file picker + filesystem can substitute for the browser
path. Also covers extension points for the mobile refactor and the book-goals
feature, and refactor landmines.

All line refs are against the current tree. Primary file:
`/home/user/Offline-Reader/js/importer.js` (2903 lines). Adjacent files read
for this slice: `docs/ARCHITECTURE.md` (binding contract), `js/store.js`,
`js/reader.js` (legacy CBZ upload path), `js/catalogue.js` (chapter resolver),
`index.html`.

---

## 0. TL;DR for planners

- There are **two separate CBZ ingestion paths**: the legacy, non-persistent
  reader upload screen (`index.html:55` + `reader.js:583`) with the 600 MB soft
  cap, and the importer's persistent "Add a series" flow (`importer.js:1438`)
  with **no** size cap but full IndexedDB persistence. The native refactor must
  decide which one the native picker feeds (probably both, via one platform
  seam).
- Blob persistence has exactly **one write point** (`commitDraft`,
  importer.js:1579–1581 → `Store.putBlob`, store.js:270–274) and exactly **one
  read point** (`rehydrateArchive`, importer.js:1513 → `Store.getBlob`). That
  pair is the surgical seam for swapping IndexedDB blobs for native Filesystem
  storage.
- The single worst memory behavior on phones is `rehydrateArchive`
  (importer.js:1508–1540): on **every app boot** it decompresses **every page
  of every stored CBZ** into in-memory Blobs + object URLs. Second worst: EPUB
  images are stored as **base64 data URLs inside chapter JSON** in IndexedDB.
- `prepareFile(file)` (importer.js:1622) accepts anything File-shaped
  (`name`, `size`, `.text()`, and Blob compatibility for JSZip); a native
  picker only has to produce a File/Blob with a real `name` to reuse 100% of
  the parsing pipeline unchanged.

---

## 1. Module structure — importer.js function map

The whole module is a single IIFE (`(function () { 'use strict'; … })()`,
lines 24–2903) exporting `window.Importer` at line 2821. Internal layout, in
file order:

### 1.1 Constants (27–62)
| Name | Line | Value | Meaning |
|---|---|---|---|
| `SCREEN_ID` | 29 | `'import-screen'` | registered with `window.registerScreen` |
| `TYPES` / `TYPE_IDS` / `TEXT_TYPES` | 31–38 | manga/manhwa/lightnovel/webnovel | content-type radio group |
| `TRACKING_PARAMS` | 43–47 | fbclid, gclid, … | stripped before URL hashing |
| `COVER_MAX_EDGE` | 51 | 640 px | cover re-encode target |
| `COVER_RAW_LIMIT` | 52 | 900 KB | max cover inlined un-re-encoded |
| `EPUB_IMG_MAX_BYTES` | 54 | 1.5 MB | per-illustration cap (silently dropped above) |
| `EPUB_IMG_DOC_BUDGET` | 55 | 8 MB | per-chapter image budget (silently dropped above) |
| `KEEP_SOURCE_FILE_MAX` | 56 | 64 MB | EPUB/TXT source blob kept in Store only below this |
| `MIME_BY_EXT` | 58–62 | jpg/png/gif/webp/avif/bmp/svg | image extension → MIME table |

### 1.2 Helpers (64–203)
- `el(tag, className, text)` — 66–71. **The** DOM constructor; text goes in via
  `textContent` only.
- `ICONS` table + `icon(name, size)` — 74–100. Static author-controlled SVG;
  the only `innerHTML` in the module (line 98) and it is fed exclusively from
  the static table.
- `fmtBytes` 102, `collapse` 110 (whitespace normalizer), `countWords` 114,
  `blocksWordCount` 119–126, `pad4` 128, `nowIso` 130.
- `store()` 132 / `safeStore(method, args, fallback)` 136–141 — every Store
  call goes through this; failures are `console.warn`-ed and swallowed, never
  thrown ("a failed write is reported, not thrown into the middle of a
  300-chapter loop").
- `gatewayBase/gatewayEnabled/gatewayUrl` 143–158 — worker config from
  `window.OR_CONFIG.workerBase` (js/config.js).
- `safeImageUrl` 161–168 (http(s) | data:image | blob: only), `safeFetchUrl`
  173–179 (http(s) or relative only), `displayImageUrl` 181–189 (routes
  hotlink-protected covers through `window.proxyImageUrl`).

### 1.3 Errors (191–203)
- `impErr(code, message, extra)` 193–199 — every failure is an `Error` with
  `name='ImportError'`, machine `code`, human `message`, optional
  `retryable/retryAfter/detail/status`.
- `isAbort(e)` 201.

### 1.4 URL identity (205–320)
- `normalizeUrl(raw)` 218–253 — scheme pinning, credential/fragment strip,
  tracking-param strip, param sort, trailing-slash strip. The normalized string
  is the only thing hashed.
- `fallbackHash` 260–269 (double FNV-1a, for no-`crypto.subtle` contexts —
  explicitly called out for "some webviews": relevant to Capacitor),
  `hashSeed` 271–283 (SHA-256 first 8 bytes when available).
- `seriesIdForUrl` 285–287 → `'user:'+hash`.
- **`seriesIdForFile(file)` 291–294** → `'user:' + hash('file:'+name.toLowerCase()+':'+size)`.
  File identity = **name + size only**. Load-bearing: re-import of the same
  file resumes progress instead of duplicating.
- `extractUrl` 298–302 (first http(s) URL in pasted prose — Android share
  sheets), `guessTypeFromUrl` 305–315, `typeLabel` 317–320.

### 1.5 Gateway client (322–444)
- `GATEWAY_ERRORS` 328–395 — per-code human sentences with `retry` flags.
- `gatewayErrorInfo` 397, `gatewayResolve(url, {signal})` 405–444 — `fetch`
  with `credentials:'omit'`, Retry-After parsing at 427–431.

### 1.6 Draft construction (446–599)
A draft = `{ series, files, blobs, meta }` (`emptyDraft` 453–455):
`files` = `[chapterId, ChapterFile][]` written by commit; `blobs` =
`[key, Blob][]` for `Store.putBlob`; `meta` drives the confirm screen.
- `normalizeIncomingChapters` 457–498 — sanitizes third-party chapter rows;
  exactly one payload strategy survives per §1.1 of the contract (src → pages →
  text → mdChapterId → url), schemes pinned at 485–491; sorted ascending by num
  at 496.
- `baseSeries(id, patch)` 500–521 — full Series-shape defaults.
- `prepareUrl(rawUrl, opts)` 525–581 — URL → draft. Progress phases:
  `validating → resolving → parsing → found`.
- `hostOf` 583, `titleFromUrl` 590–599 (de-slugged last path segment).

### 1.7 Zip helpers (601–706)
- `jszip()` 603–608 — asserts `window.JSZip` (loaded as a plain script,
  `jszip.min.js`, before all feature modules per index.html / contract §2).
- `openZip(file)` 610–616 — **`JSZip.loadAsync(file)` is passed the File/Blob
  directly** (no explicit ArrayBuffer materialization here, unlike reader.js).
  Failure → friendly `bad_archive` message including the CBR/RAR warning.
- `resolveZipPath(baseDir, href)` 621–634 — `.`/`..` collapse so a malformed
  EPUB cannot address outside the archive.
- `dirOf` 636, `extOf` 641, `zipEntry` 648–656 (case-insensitive fallback
  scan — note: `zip.file(/.*/)` enumerates the whole archive), `zipText` 658.
- `mimeForPath` 665, `entryToDataUrl` 667–670 (**base64 data URL**),
  `shrinkToDataUrl(blob, maxEdge)` 675–696 (createImageBitmap + canvas →
  JPEG q0.82; returns null on any failure), `coverDataUrlFromEntry` 698–706
  (shrink, else inline if ≤ 900 KB, else give up).

### 1.8 XHTML → Block[] — the XSS boundary (708–952)
Detached `DOMParser` document, never attached to the live DOM; only
`src`/`xlink:href`/`alt` attributes are ever read; `<script>`/`<style>`/forms/
media subtrees dropped via `XHTML_SKIP` (717–722).
- `HEADING_MAP` 724 (h1→h2 … h6→h4), `BLOCKISH` 728, `localNameOf` 732,
  `hasBlockDescendant` 736, `textOf` 742–757, `pushHr` 759.
- `imageBlockFor(node, ctx)` 764–801 — ctx `{zip, baseDir, budget:{used}, cache}`;
  absolute http(s) refs pass through verbatim (777–780); zip-internal images:
  MIME check 791, ≤1.5 MB check 794, 8 MB/chapter budget check 795, then
  **`entryToDataUrl` → data URL cached per-archive** (798–800).
- `collectImages` 803–811, `isNoteElement` 813–816 (epub:type/role footnote →
  `note` block), `walkXhtml` 818–918 (the recursive walker; tables flattened to
  `p` rows 894–905), `parseMarkup` 920–929 (XML → parsererror check),
  `xhtmlToBlocks(text, ctx)` 931–952 (XHTML parse, HTML fallback, edge-`hr`
  trim).

### 1.9 EPUB (954–1204)
- `xmlAll`/`xmlFirstText` 956–973 (namespace-agnostic tag scan).
- `findOpfPath` 977–992 — META-INF/container.xml, fallback to shortest `.opf`.
- `readToc` 997–1036 — EPUB3 nav doc, fallback EPUB2 NCX → Map(path → title).
- `pickCoverItem` 1038–1057 — properties="cover-image" → meta name="cover" →
  filename heuristic → first image.
- **`prepareEpub(file, opts)` 1059–1204** — the EPUB driver:
  - openZip 1066, OPF parse 1070–1074, manifest 1077–1085, spine 1089–1098
    (linear="no" skipped), metadata 1101–1105, ToC 1107, id 1110,
    cover 1114–1119.
  - Chapter loop 1128–1164: per spine item → `xhtmlToBlocks` with a fresh 8 MB
    budget and a **shared image cache across chapters** (1123, keyed by zip
    path — repeated illustrations pay once). wordCount per chapter (1146),
    ChapterFile `{kind:'text', blocks, wordCount}` pushed at 1160–1163.
  - DRM detection is implicit: zero chapters → `bad_epub` with an Adobe-DRM
    explanation (1166–1168).
  - Manga-EPUB heuristic 1172 (`totalWords < 250 && totalImages >= max(3, chapters)`).
  - Source blob kept only if `file.size <= 64 MB` (1198–1201); sets
    `series.archiveKey = 'file:'+id`.
- Progress phases: `reading → parsing → chapters (done/total) → found`.

### 1.10 TXT (1206–1391)
- Heading regexes 1217–1231 (`TXT_HEADING_LATIN` requires a real number;
  `TXT_HEADING_NAMED` prologue/epilogue/…; `TXT_HEADING_CJK` 第N章 etc.),
  `looksLikeHeading` 1232, `splitByHeadings` 1239–1256 (preface prepended, not
  dropped), `splitByBlankRuns` 1258–1270 (3+ blank lines).
- `textToBlocks` 1272–1288 (paragraph split; rule-character lines → `hr`).
- `buildTxtStrategies(raw)` 1290–1308 — all three strategies computed up front:
  `headings`, `blanks`, `single`.
- `txtDraftFrom(strategy, id, file, existing)` 1310–1354.
- `prepareTxt(file, opts)` 1356–1391 — **`await file.text()`** (whole file as
  one JS string, held alive by the `rebuild` closure at 1374–1384 which lets
  the confirm screen re-split live). Source blob kept if ≤ 64 MB (1385–1388).

### 1.11 CBZ / ZIP (1393–1550)
- Design comment 1393–1399: **the archive itself is the payload**; page URLs
  are *not* baked in ("inlining 40 MB of base64 would double the storage cost");
  each session rehydrates `blob:` URLs from the stored archive.
- `naturalCompare` 1401, `imageEntries(zip)` 1405–1419 (skips dirs, dotfiles,
  `__MACOSX/`, svg), `groupPages` 1423–1436 (one folder per chapter; flat
  archive = single chapter).
- **`prepareArchive(file, opts)` 1438–1502** — chapters get ChapterFiles of
  shape `{kind:'image', pages: [], entries: [zip member names], archiveKey}`
  (1469–1472); the **whole original File goes into `draft.blobs`
  unconditionally** (1491) — no size cap on this path. Series row carries
  `archiveKey`, `fileName`, `fileSize`, `importKind:'cbz'`,
  `readingDirection:'rtl'`.
- **`rehydrateArchive(series)` 1508–1540** — guarded by the module-level
  `rehydrated` Set (1506, once per page load per series):
  1. `Store.getBlob(archiveKey)` 1513,
  2. `JSZip.loadAsync(blob)` 1517 (whole archive resident),
  3. for every chapter with cached `entries`: decompress **every page** to a
     Blob and `URL.createObjectURL` it (1528–1534),
  4. `Store.putChapter` the chapter back **with blob: URLs persisted into
     IndexedDB** (1536). They are dead next session (skip-check at 1526 only
     skips when pages exist AND are not blob:), which is why this runs every
     boot.
- `rehydrateAll()` 1542–1550 — loops all user series; called from `boot()`
  (2887) and after library import (1747).

### 1.12 Commit (1552–1609)
- **`commitDraft(draft, edits, opts)` 1557–1609** — ordering invariant stated
  at 1552–1555: *blobs first (1579–1581), then chapters (1584–1595), Series row
  last (1597)* so a half-written import never shows in the library pointing at
  nothing. Applies user edits (title/author/description/type/readingDirection),
  forces `source:'user'` (1569), re-rehydrates CBZ immediately (1598–1601),
  fires `or:library-changed` CustomEvent (1604).

### 1.13 File dispatch (1611–1631)
- `kindOfFile(file)` 1613–1620 — extension first, MIME fallback:
  `.epub`/`application/epub+zip` → epub; `.txt|.text|.md|.markdown`/`text/*` →
  txt; `.cbz|.zip`/`application/zip|application/x-cbz` → cbz.
- **`prepareFile(file, opts)` 1622–1631** — the one dispatch; unsupported →
  `unsupported_file` with the PDF/CBR explanation.

### 1.14 Refresh / export / import (1633–1749)
- `refreshSeries(seriesId, opts)` 1635–1681 — URL series: re-resolve and merge
  by id then num (renumbering sites must not orphan downloads, 1657–1668);
  file series: rehydrate + honest "nothing to fetch" note (1643–1648).
- `exportLibrary({includeChapters})` 1691–1718 — one JSON of series + progress
  + cached chapters; **blob: page URLs filtered out** (1712–1714); source
  blobs deliberately excluded (comment 1685–1688).
- `importLibrary(json)` 1720–1749 — format check `offline-reader-library`,
  bulk puts, `rehydrateAll` at the end.

### 1.15 UI (1751–2805)
State: `ui` handle bag 1755, `currentDraft` 1757, `activeAbort` 1758,
`returnScreen` 1760.
- `button` 1762 / `labelledField` 1770 / `buildUi` 1778–1823 (creates the whole
  screen via `document.body.appendChild` at init — module-owns-its-DOM;
  `registerScreen` at 1821).
- Add view `buildAddView` 1827–1976: link card (1832–1894) with paste-URL
  extraction 1858–1867; gateway-off explainer card 1897–1907; **file card with
  hidden `input[type=file]` 1924–1934** (`accept=".epub,.txt,.text,.md,.cbz,.zip,application/epub+zip,text/plain,application/zip"`,
  value reset at 1932 so re-picking the same file fires `change`), drop zone
  with click/keyboard/drag-drop at 1918–1953.
- `updateUrlPreview` 1978–2000, `setStatus`/`clearStatus` 2004–2058
  (aria-live status boxes with spinner/progressbar/cancel/retry).
- Confirm view `buildConfirmView` 2065–2190; `setDraftType` 2192–2200 (type →
  readingDirection defaults), `applySplitStrategy` 2214–2231 (TXT re-split,
  carrying user edits), `renderConfirm` 2240–2350 (facts, confidence banner,
  duplicate banner, split selector, 6-chapter preview), `coverFallback` 2352,
  `saveDraft` 2359–2386 → `commitDraft` → `handoff` 2390–2400 (routes via
  `Catalogue.openSeries`, never `showScreen` directly — contract §2.2).
- Manage view `buildManageView` 2404–2475 (usage summary via
  `Store.estimateUsage`, export/import JSON with its own hidden file input
  2441–2449), `renderManage` 2477–2509, `manageRow` 2511–2568,
  `confirmDelete` 2572–2598 (also deletes the blob by `archiveKey` at 2588),
  `measureSeries` 2600–2621 (size ≈ `JSON.stringify(chapterFile).length` per
  chapter + blob size), `doExport` 2623–2642 (Blob + object URL + `a.download`
  click), `doImport` 2644–2655.
- `showView` 2659–2673, `syncGatewayVisibility` 2675–2679.
- Flow drivers: `cancelActive` 2683, `startUrlImport` 2688–2726 (AbortController
  guarded for old engines 2702), `showImportError` 2728–2739,
  **`startFileImport(file)` 2741–2767** — the funnel every picked/dropped file
  goes through: prepareFile → currentDraft → confirm view.
- Lifecycle: `openDialog(opts)` 2771–2796 (accepts `{view:'manage'}` and
  `{url}` prefill; **focus is deliberately not stolen on touch devices**,
  2790–2794 — `matchMedia('(hover: hover)')`), `close` 2798–2805 (delegates to
  `Catalogue.goBack`).

### 1.16 Public API + boot (2807–2903)
- `importUrl(url, opts)` 2809–2813 and `importFile(file, opts)` 2815–2819 —
  **headless: prepare + commit immediately, no confirmation** (documented at
  15–16; `opts.edits` supported).
- `window.Importer` 2821–2850: `openDialog, close, importUrl, importFile,
  refreshSeries, exportLibrary, importLibrary, isGatewayEnabled`, plus
  `_internals` (normalizeUrl, seriesIdForUrl/File, extractUrl,
  guessTypeFromUrl, xhtmlToBlocks, buildTxtStrategies, prepareFile, prepareUrl,
  commitDraft, rehydrateAll, getDraft, ui) exposed for the test page.
- Share-target deep link: `deepLinkUrl` 2858–2873 reads `?add=`/`?url=`/`?text=`
  (manifest.json share_target), `stripDeepLinkParams` 2875–2882
  (history.replaceState so refresh doesn't re-trigger), `boot` 2884–2899
  (buildUi, `rehydrateAll()` fire-and-forget, deferred `openDialog` +
  `startUrlImport` by one task so the catalogue's own boot wins the
  showScreen race), DOMContentLoaded wiring 2901–2902.

---

## 2. Patterns & conventions the codebase follows

Any new code (platform.js, goals module) must match these:

1. **Module shape**: IIFE + `'use strict'`, one global (`window.Importer`,
   `window.Store`, …), ES5-flavored `function () {}` expressions in
   importer/store/catalogue (reader.js, being older, uses arrows — new modules
   should follow the importer style). No imports, no build step, plain
   `<script>` tags in a load order that is itself part of the contract
   (ARCHITECTURE §2, index.html).
2. **Module owns its DOM**: created at init with `document.body.appendChild`
   (`buildUi` 1778), never markup in index.html; registered via
   `window.registerScreen`; navigation only through `Catalogue.openSeries /
   openChapter / goBack / goHome` (contract §2.2; `handoff` 2390, `close` 2798).
3. **XSS boundary**: `textContent` in, never `innerHTML` with third-party
   strings. The single `innerHTML` (icon(), line 98) reads a static table and
   is commented as such. Third-party markup → detached DOMParser → typed
   Blocks. URL schemes pinned at every trust boundary (`safeImageUrl`,
   `safeFetchUrl`, 485–491).
4. **Error style**: typed `ImportError` with machine `code` + a human message
   that tells the user what to *do* (the GATEWAY_ERRORS table 328–395 is the
   house voice: full sentences, no "Something went wrong"). Retryability is
   data (`retryable`, `retryAfter`).
5. **Store discipline**: all persistence through `safeStore` — expected
   failures resolve to fallbacks, are `console.warn('[Importer] …')`-tagged,
   and never abort a loop. Store itself never rejects for expected conditions
   (store.js:7–11).
6. **Progress reporting**: `onProgress({phase, message, done?, total?, count?})`
   at every real state change ("an opaque spinner on a 20-second fetch is
   indistinguishable from a hang", 523–524).
7. **Comment voice**: comments justify decisions and name the failure they
   prevent ("losing a translator's preface because it had no heading is
   unacceptable", 1247; "Reset first: picking the same file twice must still
   fire change", 1931). Section banners with `── name ───` rules; `§` refs to
   ARCHITECTURE.md.
8. **Events**: cross-module signals via `window.dispatchEvent(new CustomEvent(
   'or:…'))` wrapped in try/catch (`or:library-changed` 1604, 1677, 1746, 2590;
   `or:prefs` in store.js:317).
9. **A11y**: aria-live status regions, role=radiogroup/radio for segmented
   controls, aria-labels on icon buttons, keyboard handling on the drop zone.
10. **Naming**: `imp-*` CSS classes/ids for this module; `prepareX` (parse, no
    writes) vs `commitDraft` (writes); `safeX` for trust-boundary validators.

---

## 3. Focus answers

### 3.1 How files are picked (browser path today)

Three `input[type=file]` entry points:

1. **Importer "Open a file"** — hidden input built at importer.js:1924–1934,
   `accept=".epub,.txt,.text,.md,.cbz,.zip,application/epub+zip,text/plain,application/zip"`,
   single file, triggered by the drop-zone button (1939) or Enter/Space
   (1940–1942); drag-drop at 1949–1951. Both call `startFileImport(file)`
   (2741).
2. **Importer "Import library" JSON** — hidden input at 2441–2449
   (`accept=".json,application/json"`) → `doImport` (2644).
3. **Legacy reader upload screen** — `index.html:55`
   `<input type="file" id="file-input" accept=".cbz,.zip" multiple>` with a
   mobile-only proxy button at `index.html:41`; handled by the big `change`
   listener at reader.js:583–~830. This path is **ephemeral** (nothing
   persisted; state lives in `pages[]`/`chapters[]` in RAM) and is where the
   600 MB cap lives.

Ancillary intake: the PWA **share target** (manifest.json → `?add=`/`?text=`,
importer.js:2858–2899) and paste-with-prose URL extraction (1858–1867).

### 3.2 How files are parsed (JSZip)

- JSZip is the global `window.JSZip` from the vendored `jszip.min.js`, loaded
  before all feature modules (ARCHITECTURE §2 load order). Availability is
  asserted per-use via `jszip()` (importer.js:603).
- **Importer path**: `openZip(file)` (610) → `JSZip.loadAsync(file)` with the
  File object directly. JSZip still keeps the compressed archive fully in
  memory, but avoids the caller-side extra ArrayBuffer copy.
- **Reader path**: reader.js:643 `JSZip.loadAsync(await f.arrayBuffer())` —
  materializes the **whole file as an ArrayBuffer first**, then JSZip's copy on
  top (~2× compressed size transiently, per file). Nested zip-of-zips does it
  again per inner archive: reader.js:356
  `JSZip.loadAsync(await arch.async('arraybuffer'))`.
- EPUB: entries read as `'string'` (zipText 658) for XHTML/OPF/NCX, `'blob'`
  then `'base64'` for images (701–704, 793–798).
- CBZ (importer): entries only *listed* at import time (`imageEntries` 1405);
  decompression is deferred to `rehydrateArchive` (per boot) and, on the reader
  path, to per-page `p.entry.async('blob')` lazy loads (reader.js:850–856 with
  generation-counter invalidation).

### 3.3 Where blobs are stored

- API: `Store.putBlob(key, blob)` / `getBlob` / `deleteBlob`
  (store.js:270–285), backed by the IndexedDB `blobs` object store created
  **without a keyPath** (out-of-line keys, store.js:66–68) in database
  `offline-reader` v1. In-memory Map fallback when IDB is unavailable
  (store.js:29–35 — "works until you close the tab").
- Keys are `'file:' + seriesId` (e.g. `file:user:ab12…`), also stored on the
  series row as `series.archiveKey` (1199, 1387, 1482).
- What gets stored: CBZ/ZIP **always** (1491); EPUB and TXT sources only if
  ≤ `KEEP_SOURCE_FILE_MAX` = 64 MB (1198–1201, 1379–1388) — rationale: "a
  future parser improvement can re-derive the chapters without asking the user
  to find the file again" (1196–1197).
- Written during `commitDraft` **before** chapters and the series row
  (1579–1581). Deleted on series delete (2588 in `confirmDelete`; note
  `Store.deleteUserSeries` itself does *not* delete blobs — the UI does).

### 3.4 Size limits (the 600 MB hint and the others)

- **600 MB soft cap — reader.js upload path only**: `SIZE_CAP = 600 * 1024 *
  1024` (reader.js:627). Applied *after* a global cross-file chapter sort and
  dedupe (Phases 1–3, reader.js:624–720) so the *highest-numbered* chapters
  are trimmed; per-group bytes are the compressed file size prorated by image
  count (658–664). User notices at 746–752 and the nothing-loaded case at
  764–771 ("No content loaded — files exceed 600 MB limit"). Dismissable
  notice wiring at 1197–1199.
- **Importer has no total-size cap.** Its limits are qualitative:
  - per-EPUB-image 1.5 MB (54, enforced 794),
  - per-chapter image budget 8 MB (55, enforced 795),
  - cover re-encode to 640 px JPEG / 900 KB raw fallback (51–52, 675–706),
  - source-blob retention cutoff 64 MB for EPUB/TXT (56),
  - text truncations: title 300, chapter title 200, description 4000 chars.
- Storage pressure is surfaced, not enforced: `Store.estimateUsage`
  (store.js:226–234) shown in the manage view (2484–2495).

### 3.5 Memory hotspots (ranked for phones)

1. **CBZ rehydration at every boot** (importer.js:1508–1540 via `boot` 2887):
   reopen archive blob → JSZip holds compressed archive in RAM → decompress
   *every page of every cached chapter* into Blobs → object URLs. For a 300 MB
   CBZ library that is ~300 MB compressed + every decompressed page resident
   as Blobs for the life of the document, *before the user reads anything*.
   The blob: URLs are also written back into IndexedDB chapters (1536), which
   is pure churn (they are invalid next session; skip-check 1526).
2. **EPUB images as base64 data URLs inside chapter JSON** (798, block
   `{t:'img', src:'data:…'}`): +33% base64 inflation, stored in the `chapters`
   IDB store, fully materialized in RAM on every chapter open, and
   re-`JSON.stringify`'d by `measureSeries` (2609) on every manage render.
   Covers as data URLs sit inside the Series row and travel with every
   library list (rationale comment 49–51).
3. **Reader upload path double-buffering**: `f.arrayBuffer()` (reader.js:643)
   + JSZip copy per file, and again per nested archive (356). The 600 MB cap
   bounds *chapters built*, not *bytes buffered during Phase 1*.
4. **`prepareTxt` whole-file string** (1361) held alive by the `rebuild`
   closure (1374) until the draft is discarded.
5. **`exportLibrary`/`doExport`** builds the entire library (including data-URL
   images in chapters) as one in-memory object + one JSON string + one Blob
   (1691–1718, 2627–2628).
6. Evidence memory is already at the edge: reader.js:540–544 explicitly clears
   `img.src` and drops element refs because disconnected `<img>` nodes
   "caus[ed] an OOM crash on iPhone when the next chapter starts loading".

### 3.6 Exactly where a native file picker + native filesystem substitutes

The seams, from narrowest to broadest:

- **Picker seam (UI)**: the click handlers at importer.js:1939 (`drop` →
  `fileInput.click()`) and 2450 (`importBtn` → `importInput.click()`), plus
  reader.js's `#file-input` (index.html:55). A `js/platform.js` bridge can
  intercept "pick a file" and, under Capacitor, call a native picker
  (e.g. `@capawesome/capacitor-file-picker`), then hand the result to the
  existing funnels — `startFileImport(file)` for the interactive flow (2741;
  *not currently exported* — either export it on `window.Importer` or go
  through `Importer.openDialog()` + `_internals`, or add a small public
  `Importer.importPickedFile(file)`), or headless `Importer.importFile(file)`
  (2815) which skips confirmation.
- **File-shape contract**: everything downstream needs only
  `{ name, size, type?, text(), arrayBuffer()/Blob-ness }`. `kindOfFile`
  (1613) dispatches on **`file.name` extension** first, so the native picker
  must preserve real filenames (Capacitor pickers do; if reading via
  `Filesystem.readFile` you get base64 — prefer
  `fetch(Capacitor.convertFileSrc(uri)).then(r => r.blob())` and wrap in
  `new File([blob], name)` to avoid a base64 detour).
- **Storage seam (the critical one)**: exactly two call sites —
  `safeStore('putBlob', …)` in `commitDraft` (1580) and
  `safeStore('getBlob', …)` in `rehydrateArchive` (1513) / `measureSeries`
  (2612). Under Capacitor, `putBlob` can copy the archive into the app's
  native sandbox (`Filesystem`, Directory.Data / on iOS Library/Application
  Support so it's backed up but not user-visible) and store a **URI string**
  instead of a Blob; `getBlob` reads it back (or better, is bypassed
  entirely — see next point). `series.archiveKey` is the stable pointer either
  way; a native variant could be `series.nativePath`. Also delete seam:
  `deleteBlob` at 2588.
- **Rehydration seam (the big win)**: with native files, replace
  `rehydrateArchive`'s eager decompress-everything with either
  (a) on-demand page extraction (keep `entries` in the ChapterFile — they are
  already the source of truth, 1469–1472 — and extract pages lazily like
  reader.js:850 does), or (b) native unzip once to a cache dir and rewrite
  `pages` as `capacitor://` / `convertFileSrc` URLs, which are stable across
  sessions — eliminating the per-boot pass entirely. The ChapterFile shape
  (`pages` array of strings) already tolerates any URL scheme the reader's
  `safeImageUrl` accepts; `blob:` is allowed at importer.js:166 and
  catalogue.js:122 — a native scheme must be added to those validators.
- **600 MB cap seam**: reader.js:627. In the native wrapper, the cap can be
  raised or removed when files stay on disk and pages stream, but only after
  the ArrayBuffer double-buffering (643) is replaced.
- **Share-target seam**: the `?add=/?text=` deep link (2858–2899) is where
  Capacitor App URL-open events / iOS share extensions should land.
- **Boot seam**: `boot()` (2884) — platform.js must load *before* feature
  modules (insert into the index.html script order, which is contract) so
  `store()`/pickers can be progressively enhanced by the time `boot` runs.

---

## 4. Extension points relevant to the refactor and the goals feature

- **`window.Importer._internals`** (2835–2849) already exposes the pure
  pipeline (`prepareFile`, `commitDraft`, `xhtmlToBlocks`,
  `buildTxtStrategies`, `seriesIdForFile`…) — platform code and tests can
  drive imports without the UI.
- **`or:library-changed` CustomEvent** (1604/1677/1746/2590) — the goals
  feature can listen to know when books arrive/leave.
- **Word counts are already computed and persisted**: per chapter
  (`ch.wordCount`, 1146–1158; TXT 1322–1330) and per series
  (`series.wordCount`, 1187, 1343) — exactly what page/word-based reading
  goals need. Progress rows (contract §3) carry `pct`, `completed`,
  `updatedAt`, `pageIdx/pageCount`, `charOffset` — enough to derive
  words-read-per-session for goal timers without touching the importer.
- **`Store.prefs`** (store.js:320–356) with per-series overrides
  (`getFor/setFor`) and a change event stream (`prefs.on`, `or:prefs`) is the
  contract-sanctioned home for goal settings (`goals.dailyMinutes`,
  per-series targets, timer preferences) — synchronous, survives offline,
  already cross-tab coherent (storage listener 359–362).
- **New-module recipe** (for `js/goals.js` and `js/platform.js`): IIFE, own
  CSS file, build DOM at init, `registerScreen` if it's a screen, navigate via
  `Catalogue`, persist via `Store`, announce via `or:*` events, add to the
  index.html script order (contract change — must be stated explicitly per
  ARCHITECTURE.md's preamble).
- **`Store.estimateUsage`** (store.js:226) + manage view (2477) is where a
  native storage report (real free disk via Filesystem) can be swapped in.
- **`safeStore` indirection** (136) means a platform-enhanced Store (e.g.
  Preferences-backed prefs, Filesystem-backed blobs) can be substituted
  wholesale as long as `window.Store` keeps the §3 contract — the importer
  never touches IndexedDB directly.

---

## 5. Risks and landmines for the mobile refactor

1. **File identity is name+size** (`seriesIdForFile`, 291–294). A native
   pipeline that renames files (share extensions often do: `document.epub` →
   `document-1.epub`) or reads via a temp copy will silently **fork the
   series id and orphan reading progress**. Preserve original filenames, or
   introduce a content-hash identity carefully (it would change ids for
   existing users — a migration concern).
2. **Persisted `blob:` URLs in IndexedDB chapters** (1536). Any new consumer
   of ChapterFiles must treat `pages` starting with `blob:` as *possibly
   dead*; only `entries` + the archive are the truth for CBZ. Export already
   knows this (1712–1714); a native reader path must too. If the native path
   stops running `rehydrateArchive`, stale blob: pages from earlier web
   sessions will sit in the DB — they must be rewritten or ignored.
3. **`rehydrated` Set memoization** (1506): rehydration runs once per page
   load per series; `commitDraft` manually busts it (1599). If platform code
   swaps page URLs it must respect/bust this cache the same way.
4. **`safeStore` swallows quota failures.** On the web path, a failed
   `putBlob` (big CBZ over IDB quota, common on iOS Safari's ~1 GB-ish caps)
   is only a console.warn; the series still commits, and next boot
   `rehydrateArchive` finds no blob → chapters have `pages: []` and the book
   silently won't open. The native path removes the quota but the
   swallow-and-continue pattern will equally hide native FS write failures —
   surface them in `commitDraft`'s onProgress instead.
5. **Two CBZ paths with different semantics.** The reader upload screen
   (multi-file, 600 MB cap, ephemeral, chapter-number heuristics, dedupe) vs
   the importer (single file, no cap, persistent, folder-per-chapter
   grouping). Users will expect the native picker to behave like *both*.
   Unifying them is tempting but each has load-bearing heuristics
   (`extractChapterInfo`/`seriesKey` in reader.js vs `groupPages` in
   importer.js); the safe move is one platform picker seam feeding whichever
   flow the user is in.
6. **`URL.revokeObjectURL` is never called on importer-created page URLs**
   (1533) — they live for the document lifetime by design (comment
   1504–1505). Fine for a browser tab; in a long-lived native webview this is
   an unbounded leak across many library boots/imports in one session
   (re-import busts `rehydrated` and mints a fresh URL set without revoking
   the old one at 1599–1600).
7. **Scheme validators must learn any native scheme.** `safeImageUrl`
   (161–168) and catalogue.js's equivalent (~line 115–122) allow only
   http(s)/data:image/blob:. `capacitor://localhost` or
   `convertFileSrc()` output must be added *in both places* or native-path
   covers/pages will be silently blanked.
8. **XSS boundary is non-negotiable** (contract §7): native file access does
   not change trust. EPUB XHTML from disk is still third-party — it must keep
   flowing through `xhtmlToBlocks`; never render archive HTML in the webview.
9. **`importFile`/`importUrl` commit without confirmation** (2809–2819).
   Wiring a native share extension straight to `importFile` skips the
   type/title correction the module's own header (8–16) says heuristics need;
   prefer `openDialog({url})`-style flows that end in the confirm screen.
10. **index.html script order is contract** (ARCHITECTURE §2). platform.js
    must slot in before store.js consumers if it patches Store, and the
    change must be declared in ARCHITECTURE.md ("If you change a shape here,
    you change it for everyone — say so explicitly").
11. **`crypto.subtle` absence fallback** (256–283) exists precisely for
    "some webviews". Capacitor serves from `capacitor://localhost` /
    `https://localhost` (secure context, subtle available) — but if the
    scheme config changes, series ids silently switch from SHA-256 to FNV
    (`FALLBACK_MARK 'x'` prefix, 258) and stop matching ids minted on the
    web origin. Cross-device/library-export compatibility of ids depends on
    both sides having subtle.
12. **`file.text()`/JSZip on huge files** will still spike on low-RAM phones
    even with a native picker, because parsing is in-webview. For the
    "memory-friendly" requirement, cap or stream: EPUB/TXT are fine (≤64 MB
    retention hints at expected sizes), CBZ needs the lazy/native-unzip
    strategy from §3.6 before lifting the 600 MB cap.
13. **`measureSeries` cost** (2600–2621): JSON.stringify of every chapter
    (including base64 images) per manage-screen render; on a big native
    library this becomes seconds of jank — replace with native file sizes.
14. **Deep-link race** (2893–2898): importer defers one task so the
    catalogue's boot showScreen wins. Capacitor `appUrlOpen` events arrive on
    a different timeline than `DOMContentLoaded` query params — reuse
    `openDialog({url})` + `startUrlImport()` but do not assume the timing
    trick; check `uiReady`.
15. **Delete does not clean native copies.** `confirmDelete` (2588) deletes
    the IDB blob explicitly because `Store.deleteUserSeries` doesn't; a
    native-file-backed archive needs its own delete hook at the same spot.
16. **Store `blobs` object store uses out-of-line keys** (store.js:66–68,
    `idbPut(store, blob, key)` 270–274) — any Store reimplementation must
    keep `putBlob(key, blob)` argument order and out-of-line semantics or
    every archive silently fails to round-trip.
