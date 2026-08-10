# Implementation assignments — Capacitor mobile refactor + goals

**Source of truth:** `docs/ARCHITECTURE.md` (binding contract) and `docs/mobile/PLAN.md`
(final revision 2). This document converts the plan into concrete subagent assignments.
Every agent MUST read, before writing a line: `docs/ARCHITECTURE.md`, the PLAN.md
sections named in its brief, and the `docs/mobile/understanding/` map(s) named in its
brief (the plan's own rule: read the map for any file you touch).

**Structure: 3 sequential rounds, 9 implementation agents.** Within a round every agent
owns a strictly disjoint file set; two agents never touch the same file in the same
round — and in this schedule, no file is ever owned by more than one agent across ALL
rounds. The four shared/contract files are handled per the collision rule:
`index.html`, `js/store.js`, `sw.js` → single owner in the foundation round
(integrator-core); `docs/ARCHITECTURE.md` → exactly one agent (docs-contract, Round 3,
so the contract documents what actually landed, verified against the code).

The plan's §10 table implies 7 owner agents; this delegation designates 9: the
"platform" row is split into a JS-bridge agent and a native/scaffolding agent (different
skill profiles, zero file overlap), and a dedicated docs agent closes the contract loop
in Round 3. Round 2's five agents run fully in parallel.

**Cross-round conventions (binding for every agent):**

- Implement new public surface (Platform API, Store methods, pref keys, events)
  **character-for-character** against the signatures in PLAN.md §2.2 / §5.1 / §5.2 /
  §6.1 / §8. Round 2 agents code against those signatures, not against each other.
- Every cross-module call is guarded (`typeof`/existence checks) — the plan requires
  absence tolerance in both directions (e.g. the app must run with `js/goals.js`
  deleted; `Platform.zip.*` returns null on web).
- Capacitor APIs are referenced ONLY inside `js/platform.js` and the committed plugin's
  own native sources. No `import` statements anywhere in app JS. No build step.
- XSS boundary is absolute: third-party strings reach `textContent` only, on every new
  path including native-disk files.
- sw.js cache: ONE final bump to `cbz-reader-v5.06` (integrator-core). The per-phase
  intermediate bumps (v5.04, v5.05) collapse because all phases ship in one delivery;
  docs-contract records this as a noted deviation in the PLAN.md completion log.
- **Delegation addendum (flagged for plan-compliance checkers as intentional):** the
  §6.2 manage-view "Move library to device storage" migration needs a Capacitor-side
  chunked writer, which §6.1 does not name. It is specified here as
  `Platform.archives.migrateBlob(key, blob, onProgress) → Promise<{size}|null>` —
  native-only, chunked `Filesystem.appendFile` in 8 MB slices, idempotent per archive
  (skips when destination exists with matching size), progress-reported, `null` on web.
  Owner: platform-bridge (implementation) + importer (caller) + docs-contract
  (ARCHITECTURE.md entry, marked as a delegation addition).
- **or-zip JS/native interface (pinned so Round 1's two agents match):** the plugin is
  reachable as `window.Capacitor.Plugins.OrZip` with exactly two methods:
  `list({ path }) → { entries: [{ name, size }] }` (central-directory read only) and
  `extract({ path, entryNames, destDir }) → { paths: [absolute paths, in entryNames
  order] }` (streamed native extraction). `path`/`destDir` are absolute paths inside
  the app container; `js/platform.js` resolves `{key}` sources to
  `Data/archives/<key>` via `Filesystem.getUri`, creates/derives
  `Cache/pages/<cacheDirKey>/` dirs, and converts results to the relative
  `'pages/<cacheDirKey>/…'` strings the §6.1 API returns. The plugin rejects any entry
  that would resolve outside `destDir` (zip-slip) and never returns entry bytes to JS.

---

## Round 1 — Foundation: contracts in real code + native scaffolding

Everything Round 2 builds on: the full Platform bridge, the full Store surface, the
shell wiring, and the Capacitor/native project scaffolding. All three agents run in
parallel; file sets are disjoint.

### Agent 1: `platform-bridge` — role: logic-implementation

**Owns/creates:** `js/platform.js` (new), `test/platform.test.html` (new).

**Required reading:** PLAN.md §0, §2, §3.1 (platform row), §5.2 (notify), §6.1, §8, §9;
understanding/imagereader.md (reader globals, `or.*` keys, §2.2/§3.5),
understanding/catalogue.md (boot, §5.1/§5.10-11), understanding/novelreader.md
(close path), understanding/design.md §7 (safe areas).

**Brief.** Build `window.Platform` — the ONLY module that touches Capacitor — as an
IIFE classic script, `'use strict'`, loadable standalone and on pages with no
Capacitor. Detect native via `window.Capacitor` and reach plugins through
`window.Capacitor.Plugins.*` (the documented no-bundler pattern). Implement the FULL
API across all phases in one pass:

1. **Phase 1 core (§2.2, char-for-char):** `isNative`, `os`, `ready` (always present,
   resolves after native init + pref hydration; resolves in the same microtask on web;
   never rejects), `appVersion()`, `confirm({title, message, okLabel, cancelLabel})`
   (Dialog plugin / `window.confirm` fallback), `haptic(kind)`,
   `memoryClass()` with the exact resolution order — pref `platform.memoryClass`
   override → Android `navigator.deviceMemory` (≤2 low, ≥6 high) → iOS
   `Device.getInfo()` machine-identifier static table (≤3 GB → low, ≥6 GB → high,
   unknown → mid) → default mid — and `tuning()` returning the §9 row for the class
   (numbers copied exactly from the §9 table, all seven keys:
   `memoryWindow, cacheWindow, lookBehind, lookAhead, maxLoadedChapters,
   chapterCacheMB, pageCacheMB`).
2. **Phase 1 internal behaviors (§2.2):** pref durability — on `ready`, restore the
   native-Preferences mirror for `or.prefs`, `or.prefs.series`, `or.library`, `or.gap`
   (+ `or.autoscroll` from P2) ONLY for keys missing from localStorage (live data
   always wins), then call `Store.prefs.reload()` and guarded
   `window.reloadReaderPrefs()` so the FIRST post-eviction launch is correct. Ongoing
   mirroring: `or:prefs` listener copies the two pref blobs debounced 2 s; hide-time
   copy of ALL mirrored keys on `visibilitychange`→hidden and `pagehide`, with the
   copy listeners registered inside a `DOMContentLoaded` handler (load-bearing FIFO
   ordering after reader.js's parse-time save — §2.2). `or.timer` is deliberately NOT
   mirrored. Android hardware back (`App.addListener('backButton')`) dispatches on
   `document.body.dataset.screen` exactly per §2.2: `novel-screen` →
   `window.NovelReader.close({navigate:true})`; `reader-screen` →
   `document.getElementById('close-btn').click()`; `home-screen`/`upload-screen` →
   minimize; else `window.Catalogue.goBack()` — all guarded. Status bar dark on ready,
   overlay mode on Android only. Never registers or unregisters service workers.
3. **Phase 4 (§5.2):** `Platform.notify = { canNotify() → false, scheduleDaily() →
   Promise<false>, cancelDaily() → Promise<void> }` — the reminders-ready stub.
4. **Phase 5 (§6.1, char-for-char):** `pickFiles({accept, multiple})` → `PickedFile[]
   |null` (null on web; picker configured copy-to-cache; `name`/`size` are the
   ORIGINALS — file identity depends on them); `readPickedFile(picked)` →
   `File|null` (fetch(convertFileSrc) → blob → `new File([blob], picked.name)`);
   `Platform.zip.list/extract` per the pinned OrZip interface above (null on web);
   `Platform.pageUrl(relPath)` (Filesystem.getUri + convertFileSrc, session-local BY
   DESIGN, null on web); `Platform.archives.importFromUri` (native MOVE, rename with
   copy+delete fallback, zero bytes in JS), `save`/`read` (≤64 MB guard,
   console.warn + null above it), `remove`, `releasePages`, `prunePageCache` (LRU by
   dir mtime), `usage`; `Platform.onAppUrlOpen(fn)` wrapping App `appUrlOpen`;
   `Platform.backup.write(json)` (Documents/backup/library-<date>.json, keep 3) /
   `readLatest()`. Plus the delegation addendum `archives.migrateBlob` (header note).
   Every method: web fallback or resolved no-op; never rejects for expected
   conditions.
5. **`test/platform.test.html` (Phase 6 item, built now):** headless assertions that on
   plain web every method degrades correctly — `isNative===false`, `ready` resolves,
   `zip.*`/`pageUrl`/`pickFiles`/`readPickedFile` return null, `archives.save` refuses
   >64 MB, `notify.canNotify()===false`, `tuning()` returns the mid row by default and
   honors the `platform.memoryClass` pref override.

**Satisfies:** Phase 1 §2.4 (bridge criteria, eviction-restore first-launch test,
mirror-not-one-save-behind test, origin-gate contingency seam `proxyImageUrl` noted in
a comment), Phase 4 §5.4 (notify stub), Phase 5 §6.5 (platform-side criteria), Phase 6
(`test/platform.test.html`).

**Must NOT touch:** any other file. Must not overwrite localStorage keys that exist.
No SW registration. No Capacitor references outside this file (and it must be the only
app file with them). The named Phase 1 contingency (CapacitorHttp-backed
`window.proxyImageUrl`) is implemented ONLY if the on-device origin gate fails — ship
the seam as a commented, disabled branch, not active code.

**Checker fleet:**
- plan-compliance: diff the exported API against §2.2 + §5.2 + §6.1 signature-for-
  signature; `tuning()` numbers equal the §9 table; mirror restore is
  missing-keys-only; copy listeners registered in DOMContentLoaded; back-button table
  matches §2.2 including the two module-close paths (never raw `goBack` for open
  readers); `or.timer` absent from the mirror list; ready resolves same-microtask on
  web (no await of anything async before resolve when not native).
- design-consistency: IIFE + `'use strict'` + single `window.Platform` global; no
  `import`/`export`; `[Platform]` console prefix; prose "why" comment voice; guarded
  `typeof` checks for every cross-module reference.
- security: no `innerHTML`; no credentials/headers forwarded; `readPickedFile` stamps
  the ORIGINAL name; backup files written only under the app's own Documents dir; no
  eval/Function/dynamic script injection; mirror never logs pref contents.

### Agent 2: `capacitor-scaffold` — role: scaffolding

**Owns/creates:** `package.json` (new, repo root), `package-lock.json` (new, if
generatable in-environment), `capacitor.config.json` (new), `scripts/sync-www.sh`
(new), `.gitignore` (edit), `native/or-zip/**` (new committed plugin: its own
`package.json`, iOS Swift sources, Android Kotlin/Java sources, minimal README),
`assets/icon-1024.png` (new master), `icons/icon-192.png`, `icons/icon-512.png`,
`icons/maskable-512.png` (new), `docs/mobile/NATIVE_BUILD.md` (new).

**Required reading:** PLAN.md §0 (non-negotiable 1 incl. the native/ amendment), §2.1,
§6.1, §6.4, §11.1-2, §11.8; understanding/design.md §8 (manifest/icons),
understanding/imagereader.md §3.6-3.7.

**Brief.** All native packaging scaffolding; no app-JS changes.

1. **`package.json`** with exactly the §2.1 + §6.4 dependency set: `@capacitor/core`,
   `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`, `@capacitor/app`,
   `@capacitor/preferences`, `@capacitor/haptics`, `@capacitor/status-bar`,
   `@capacitor/splash-screen`, `@capacitor/dialog`, `@capacitor/keyboard`,
   `@capacitor/device`, `@capacitor/filesystem`, `@capawesome/capacitor-file-picker`
   (or an equivalent picker documented as preserving original name+size with
   copy-to-cache), and `"or-zip": "file:native/or-zip"`. Scripts: `sync` (run
   `scripts/sync-www.sh` then `cap sync`), `ios`, `android`. NO web build/bundle
   scripts. Attempt `npm install --package-lock-only` for the committed lockfile; if
   the registry is unreachable, state in NATIVE_BUILD.md that the lockfile is generated
   on first `npm install` on the Mac and must be committed then.
2. **`capacitor.config.json`** per §2.1: `appId` `com.offlinereader.app` (placeholder,
   §11.1), `appName` "Offline Reader", `webDir` "www", iOS default scheme; StatusBar
   `style: "DARK"`, background `#0a0a0a`, `overlaysWebView: true` (Android-side
   option); SplashScreen `#0a0a0a`, no spinner; Keyboard `resize: native`.
3. **`scripts/sync-www.sh`**: plain `cp`/`rsync` of `index.html, styles.css, css/,
   js/, fonts/, chapters/, catalog.json, manifest.json, icon.svg, icons/, jszip.min.js,
   sw.js` into `www/`. Executable, `set -euo pipefail`, house comment voice.
4. **`.gitignore`**: add `node_modules/`, `www/`, `ios/`, `android/`. `native/` is NOT
   ignored; `package-lock.json` IS committed.
5. **`native/or-zip/`** — the ONLY committed native code (§0 amendment, §6.1): a
   self-contained Capacitor plugin package registering as `OrZip` with exactly the two
   methods of the pinned interface (header of this document). iOS: Swift via
   **ZIPFoundation** (SPM dependency declared in the plugin's Package.swift/podspec);
   Android: **`java.util.zip.ZipFile`** (platform API). `list` reads the central
   directory only; `extract` streams entries to `destDir` and MUST reject any entry
   name resolving outside `destDir` (zip-slip) and any `path` outside the app
   container. ~100 lines per platform; no other capabilities.
6. **Icons:** export `assets/icon-1024.png` master from `icon.svg`, then 192/512 `any`
   + 512 maskable PNGs into `icons/` on the `#0a0a0a` shell background (Phase 6 "the
   web PWA also stops being SVG-only"; integrator-core references these paths in
   manifest.json). Valid PNGs are mandatory — use whatever rasterizer the environment
   provides.
7. **`docs/mobile/NATIVE_BUILD.md`** per §2.1 + §6.4: the complete Mac walkthrough
   (`npm install`, `npm run sync`, `npx cap add ios`, `@capacitor/assets` icon/splash
   generation from the 1024px master, free-Apple-ID signing, `npx cap open ios`;
   Android equivalent), the or-zip plugin build notes, and the explicit
   re-apply-after-regeneration manual steps: Info.plist `CFBundleURLTypes` for the
   `offlinereader://` scheme and the Android `VIEW` intent-filter (§6.2 link intake).
   States that `ios/`/`android/`/`www/` are generated, never committed, and must be
   reconstructable from this doc alone.

**Satisfies:** Phase 1 §2.4 (`git status` clean of generated dirs; scaffolding rows of
§2.1), Phase 5 §6.4 (plugin + picker deps, NATIVE_BUILD.md additions), Phase 6 (PNG
icon set, NATIVE_BUILD re-verifiability).

**Must NOT touch:** `index.html`, `manifest.json`, `sw.js`, any `js/*.js`, any
`css/*`, `docs/ARCHITECTURE.md`. No web build step of any kind. No native code outside
`native/`.

**Checker fleet:**
- plan-compliance: dependency list matches §2.1+§6.4 exactly (incl. `@capacitor/device`
  — the iOS memory signal); `webDir: "www"`; gitignore entries + lockfile policy;
  NATIVE_BUILD.md contains the URL-scheme/intent-filter manual steps flagged as
  re-apply-on-regeneration; or-zip = exactly `list`/`extract`, ZIPFoundation on iOS,
  `java.util.zip.ZipFile` on Android.
- design-consistency: sync script is plain copy (no transform); comment voice; icons
  render the existing mark on `#0a0a0a` (no new branding).
- security: zip-slip containment in `extract` on BOTH platforms (canonical-path check
  against destDir); `path`/`destDir` accepted only inside the app container; plugin
  returns names/sizes/paths, never entry bytes; no network permissions added by the
  plugin.

### Agent 3: `integrator-core` — role: logic-implementation

**Owns/creates:** `index.html`, `js/store.js`, `sw.js`, `manifest.json`, `README.md`.

**Required reading:** PLAN.md §2.3, §3.1 (integrator rows), §4.1 (store), §5.1
(store), §5.3, §6.2 (store), §8 amendments 1, 3, 7, 8, 9, 12; ARCHITECTURE.md §3;
understanding/catalogue.md §2/§5, understanding/importer.md §3.3/§5.16,
understanding/design.md §8.

**Brief.** All shared-file work for every phase, landed once.

1. **`index.html` (P1 + P4):** insert `<script src="./js/platform.js"></script>`
   between config.js and store.js; add `<link rel="stylesheet" href="./css/goals.css">`
   after importer.css and `<script src="./js/goals.js"></script>` between importer.js
   and catalogue.js; update the load-order comment to the final contract order
   `config → platform → store → jszip → reader → novel-reader → importer → goals →
   catalogue` (§8.1). goals files are created in Round 2 — do NOT create placeholder
   files; the final assembled tree is what ships. Verify `viewport-fit=cover` present;
   no other head changes.
2. **`js/store.js`:**
   - P1: `Store.prefs.reload()` — re-read `or.prefs`/`or.prefs.series` into the module
     snapshots, emit `{key:null, value:null, seriesId:null}` (same shape as the
     cross-tab storage handler). Prefs stay synchronous.
   - P3: `putChapter` stamps `cachedAt` (ISO) + `sizeEstimate` (JSON string length,
     computed once at write). New `Store.pruneChapterCache({maxBytes,
     protectSeriesIds}) → Promise<{removed, bytes}>` — oldest-`cachedAt`-first until
     under `maxBytes`, never touching `protectSeriesIds`; legacy rows without
     `sizeEstimate` get stamped during the prune cursor pass, capped at 50 rewrites
     per call; unstamped rows count 0 and are never deleted.
   - P4: `putProgress` dispatches window CustomEvent `or:progress` after a successful
     merge, `detail = {seriesId, patch, row}`, wrapped in try/catch. `DB_VERSION`
     1 → 2 with object store `dayLogs` (keyPath `day`, index `updatedAt`); methods
     `getDayLog(day)`, `putDayLog(day, patch)` (shallow-merge, stamps updatedAt),
     `listDayLogs({since, until, limit})` (desc by day), `clearDayLogs()` — ALL
     implemented in the in-memory fallback too (session-scoped Map table).
   - P5: `putBlob`/`getBlob`/`deleteBlob` delegate to
     `Platform.archives.save/read/remove` when `Platform.isNative` for blobs within
     the 64 MB bound; reads check filesystem first, then IDB; `putBlob(key, blob)`
     argument order, promise semantics, and out-of-line-key IDB behavior unchanged;
     NO boot-time bulk migration; `estimateUsage` folds in
     `Platform.archives.usage()` when native. Store still never rejects for expected
     conditions.
3. **`sw.js`:** add `js/platform.js`, `js/goals.js`, `css/goals.css` to
   `SHELL_ASSETS`; bump the cache name `cbz-reader-v5.03` → `cbz-reader-v5.06` (single
   final bump — see header convention).
4. **`manifest.json` (P2 + P6):** `theme_color` and `background_color` `#1a1a1a` →
   `#0a0a0a`; icons array gains `icons/icon-192.png`, `icons/icon-512.png` (purpose
   any) and `icons/maskable-512.png` (purpose maskable) alongside the existing SVG
   (files created by capacitor-scaffold this round). `share_target` stays (web build
   keeps `?add=`).
5. **`README.md` (P6):** add an "Install as an app" section (web PWA install + pointer
   to `docs/mobile/NATIVE_BUILD.md` for the native builds).

**Satisfies:** Phase 1 §2.4 (load order, prefs.reload), Phase 2 §3.2 (splash/status
`#0a0a0a`), Phase 3 §4.2 (prune + backfill mechanics), Phase 4 §5.4 (store-side:
events, dayLogs incl. broken-IDB run), Phase 5 §6.5 (blob delegation, no bulk
migration), Phase 6 (README, icon references, final cache bump).

**Must NOT touch:** `docs/ARCHITECTURE.md` (Round 3 owns it), `js/config.js`, any
feature module, `css/*`. Must not make `Store.prefs` async, must not change the
Progress shape or its writers, must not alter the `or:prefs` event shape, must not
add a `dayLogs` writer (js/goals.js is the single writer).

**Checker fleet:**
- plan-compliance: script/link order matches §8.1 exactly; every §5.1 Store signature
  matches char-for-char; in-memory fallback implements all four dayLog methods; prune
  backfill cap = 50 and unstamped rows are never evicted; blob delegation preserves
  argument order and the ≤64 MB bound; SHELL_ASSETS additions + cache name changed
  from v5.03; manifest colors `#0a0a0a`.
- design-consistency: store stays an IIFE exporting `window.Store`; no framework, no
  modules; house comment voice; `[Store]`-style warn tags preserved.
- security: `or:progress` dispatch in try/catch; no innerHTML; delegation logs no blob
  contents; IndexedDB remains the web backend (no silent backend swap on web).

---

## Round 2 — Feature modules (five agents, fully parallel, disjoint files)

All contracts from Round 1 exist in real code. Cross-module calls in this round target
Round-1 surfaces or same-round surfaces whose signatures the plan fixes; every one is
guarded for absence.

### Agent 4: `reader-image` — role: logic-implementation

**Owns/creates:** `js/reader.js`, `styles.css`.

**Required reading:** PLAN.md §2.3 (reader row), §2.5, §3.1 (styles/reader rows),
§3.3, §4.1 (reader), §4.3, §6.3, §6.6, §9; understanding/imagereader.md (mandatory,
whole file), understanding/design.md §7/§10.

**Brief.** The careful one. reader.js is a classic script with NO IIFE and NO
`'use strict'` whose file-scope globals ARE the API catalogue.js pokes — every edit is
additive and surgical.

1. **P1 (§2.3):** gate SW registration: register only when
   `!(window.Platform && window.Platform.isNative)`. Export
   `window.reloadReaderPrefs = function () {…}` — re-reads `or.gap` into `gapLevel`,
   re-applies via `applyGap()`, re-runs `initLibraryList()` (P2 extends it to
   `or.autoscroll`).
2. **P2 (§3.1):** `styles.css`: safe-area left/right (`calc(base +
   env(safe-area-inset-left/right, 0px))`, importer.css:54-55 is the model) on reader
   header/footer, autoscroll bar, notices, upload/home/series screen padding; replace
   the five `min-height: 100vh` sites with `100dvh` behind
   `@supports (min-height: 100dvh)` keeping `100vh` first as fallback; at
   `@media (min-width: 1024px)` widen `.page-wrapper` max-width to
   `min(100%, 1000px)` centered; NO new `backdrop-filter` layers. `js/reader.js`:
   persist autoscroll as `or.autoscroll` (JSON `{speedIdx, scrollMode}`, silent-catch
   localStorage like `or.gap`), read at parse time, written on every speed/mode
   change; extend `reloadReaderPrefs` to re-read it.
3. **P3 (§4.1):** at session start (BOTH entry paths) read `Platform.tuning()` into
   `MEMORY_WINDOW`/`CACHE_WINDOW`/lookahead variables (consts become let; defaults =
   current values so mid-class web behavior is bit-identical). Scroll-mode ("∞")
   windowing: when total pages > 800, `renderAllChapters` renders only chapters within
   ±2 of current plus fixed-height spacer divs (heights from locked aspect ratios
   where known), re-rendered on chapter change with explicit scrollTop compensation;
   below the threshold behavior is exactly today's.
4. **P5 (§6.3):** extract the 234-line anonymous `#file-input` change handler into a
   named `loadArchives(files)` — behavior-preserving, the change handler calls it.
   Upload buttons try `Platform.pickFiles({accept: '.cbz,.zip', multiple: true})`
   first, `<input>` fallback. Native URI path: archives moved via
   `Platform.archives.importFromUri('upload:' + seriesKey + ':' + i, picked.uri)`;
   manifest `{name, size, key}` stored in the `or.library` entry; `or.library` cap
   5 → 10 on native; library-row removal deletes its archive files; "Resume" reopens
   from disk with no re-picking. Indexing via sequential `Platform.zip.list({key})` —
   the SAME original name strings feed `extractChapterInfo`/`seriesKey`/dedupe/0-index
   shift; pages become `{archiveKey, entryName}` refs; zip-of-CBZs handled per §6.3
   (extract inner archive to Cache, `list({uri})`, release after indexing). On chapter
   render: one `Platform.zip.extract(archiveKey, chapterEntryNames, cacheDirKey)`
   feeds `Platform.pageUrl` URLs into the EXISTING `directUrl` page mechanism; leaving
   a chapter releases its page dir; keep ≤2 chapter page-dirs per session. Steady
   state on the URI path: ZERO JSZip instances and zero archive buffers in JS.
   `SIZE_CAP` becomes 2 GB ONLY for sets that arrived via `pickFiles` URIs; any
   plain-File set keeps 600 MB on every platform. Inside `saveToLibrary()` dispatch
   window CustomEvent `or:upload-progress`, `detail = {libraryKey, pagesDelta,
   chaptersDelta, completed}`, deltas computed against the previous stored entry's
   high-water marks (≥0 by construction), try/catch-wrapped.

**Satisfies:** Phase 1 §2.4 (SW gate; eviction test's library-list half), Phase 2 §3.2
(safe areas, dvh, iPad width, autoscroll persistence + eviction survival), Phase 3
§4.2 (wrapper count ≤ ~600 at 1500 pages, no scroll jumps, no 600 MB-upload OOM
regression), Phase 5 §6.5 (20-file resume, 1.5 GB zip.list-only indexing, ≤2 page
dirs, `<input>` fallback keeps 600 MB cap, upload DayLog feed).

**Must NOT (§2.5, §4.3, §6.6, §9):** no IIFE, no `'use strict'`, no global
renames/reordering, no ES-module conversion; the WebKit hacks stay verbatim (150 ms
teardown defer, `el.src=''` discipline, soft-window kept-src, explicit min loop);
chapter-number heuristics, dedupe, sort, and notices logic unchanged; original
filenames (never native URIs) flow to `extractChapterInfo`/`seriesKey`; web JSZip path
untouched; `or.library` high-water "only ever advance" semantics kept; no direct
Capacitor calls; do not touch `#novel-screen` styling or any css/ file.

**Checker fleet:**
- plan-compliance: SIZE_CAP is path-dependent exactly as §6.3/§8.14; `loadArchives`
  extraction is behavior-preserving (diff review of the moved block); tuning read at
  session start only (not per frame); windowing threshold 800 / ±2; upload-progress
  deltas provably ≥0; mirror keys list gained `or.autoscroll` on the platform side
  (cross-check).
- design-consistency: styles.css keeps the blur budget (zero new backdrop-filter);
  safe-area pattern `calc(base + env(…, 0px))`; 100vh-first fallback ordering; house
  comment voice for every new block, naming the platform bug it prevents.
- security: `or:upload-progress` dispatch try/catch; filenames/chapter names still
  reach only `textContent`; `buildProgressBar`-style innerHTML templates keep
  numeric/app-controlled inputs only; no URI strings rendered as HTML.

### Agent 5: `catalogue` — role: logic-implementation

**Owns/creates:** `js/catalogue.js`, `css/catalogue.css`.

**Required reading:** PLAN.md §2.3 (catalogue row), §2.5, §3.1 (catalogue row), §4.1
(catalogue), §4.3, §5.2 (entry points), §6.2 (catalogue), §8.4/8.7/8.11/8.13;
understanding/catalogue.md (mandatory, whole file), understanding/design.md.

**Brief.**

1. **P1 (§2.3, four edits):** `boot()` awaits `window.Platform ? Platform.ready :
   Promise.resolve()` before `ensureDom()`; `initMode()` — when `Platform.isNative`
   always take the online branch (bundled catalogue is local; `navigator.onLine` is
   not a boot gate on native); the window `offline` handler — when native, do NOT
   force `upload-screen`, badge state only; `confirmDelete` awaits
   `Platform.confirm({...})` instead of `window.confirm`; `wireServiceWorkerBadge`
   gains a native branch writing `Platform.appVersion()` into `#home-version`.
2. **P2 (§3.1):** `css/catalogue.css` safe-area left/right on `.cat-toast`, tab bar,
   home/series body padding; optional iPad-portrait grid tweak; keep rem breakpoints.
3. **P3 (§4.1):** `resolveChapterContent` — after the Store-cache read, if the file
   has `archiveKey` + `entries` and `pages` is empty or STALE (stale = any `blob:`
   page URL, or any URL containing `_capacitor_file_` or a `capacitor://` scheme),
   call `window.Importer.hydrateChapter(series.id, chapter.id)` (guarded on the
   function existing) and return its result WITHOUT writing it back to Store.
   `renderChapterList` chunks at 250 rows + inline "Show more (N remaining)" row;
   `renderGrid` chunks at 200 cards with the same pattern (cover `loading="lazy"`
   kept); `populateRangeSelects` lazy on first open of the range panel. Prune
   triggers: (1) once per boot, deferred to idle after first render,
   `Store.pruneChapterCache({maxBytes: Platform.tuning().chapterCacheMB,
   protectSeriesIds: userSeriesIds})` plus guarded
   `Platform.archives.prunePageCache(Platform.tuning().pageCacheMB)` when native;
   (2) after every 25 resolver `putChapter`s, same prune debounced 10 s; (3) after
   `downloadRange` batches. All Store/Platform calls guarded per house `safeCall`
   style.
4. **P4 (§5.2):** `ensureDom` creates an EMPTY `<div id="goals-home-slot">` in
   `#home-body` between the Continue rail and Latest updates, and a toolbar icon
   button "Goals" rendered ONLY when `window.Goals` exists (clicking calls
   `Goals.openScreen()`). Slot CONTENTS are goals-owned — leave it empty.
5. **P5 (§6.2):** `safeImageUrl` accepts the Capacitor local schemes
   (`capacitor://localhost/…` and the `https://localhost/…_capacitor_file_…` form —
   exact-prefix pinning, not substring); catalogue fetch-failure copy becomes
   platform-aware ("reinstall the app" vs "check your connection").

**Satisfies:** Phase 1 §2.4 (native boot-to-home with radios off, native dialog,
version badge), Phase 2 §3.2 (toast/tab insets), Phase 3 §4.2 (<300 rows initial,
lazy selects, 200-card grids, steady-state prune firing), Phase 4 §5.4 (slot + guarded
button; app unchanged when goals absent), Phase 5 §6.5 (native-scheme covers render,
stale native URLs re-hydrate — the app-update drill's client half).

**Must NOT (§2.5, §4.3, §5.5):** `navStack` behavior and `goBack()` fall-through
unchanged; `TABS` unchanged (goals is NOT a tab); stale-anchor discipline
(`resumeProgress`/`openChapter` re-read `Store.getProgress`) untouched; MangaDex
no-cache rule and `inflight` map semantics untouched; hydrated/native page URLs never
persisted; must not populate the goals slot; no direct Capacitor calls; the boot await
must not delay web boot perceptibly.

**Checker fleet:**
- plan-compliance: staleness rule covers `blob:` AND `_capacitor_file_`/`capacitor://`;
  hydrate results never `putChapter`ed; chunk thresholds exactly 250/200; all THREE
  prune triggers present with the stated debounces; Goals button guarded; slot
  position between Continue and Latest.
- design-consistency: "Show more" rows use house button styling + `aria-live` count
  semantics; full-rebuild render philosophy kept (chunked, not virtualized); rem
  breakpoints; `[Catalogue]` warn prefix; comment voice records the why.
- security: `safeImageUrl` scheme pinning is prefix-exact (a `capacitor-evil.example`
  or `https://localhost.evil.tld` URL must NOT pass); platform-aware copy built with
  `textContent`; no innerHTML on new paths.

### Agent 6: `importer` — role: logic-implementation

**Owns/creates:** `js/importer.js`, `css/importer.css`.

**Required reading:** PLAN.md §3.1 (importer row), §4.1 (importer), §4.3, §6.1, §6.2
(importer), §6.5, §6.6, §11.8; understanding/importer.md (mandatory, whole file),
understanding/design.md.

**Brief.**

1. **P3 (§4.1):** replace eager boot-time `rehydrateAll()` with lazy hydration. New
   public API `Importer.hydrateChapter(seriesId, chapterId) →
   Promise<ChapterFile|null>`: opens the series archive from
   `Store.getBlob(archiveKey)`, extracts ONLY that chapter's `entries` to object URLs,
   returns the ChapterFile with live `pages`. Internals: at most ONE JSZip instance
   app-wide (LRU of 1 archive); per-chapter URL registry with revocation when a
   chapter leaves it (cap: 2 hydrated chapters per archive — current + previous).
   `rehydrateAll()` becomes a migration shim: no decompression; on first run rewrites
   any stored ChapterFile whose `pages` are `blob:` URLs to `pages: []`. `commitDraft`
   stops writing page URLs for CBZ chapters (`pages: []`, `entries` + `archiveKey`
   only). Failed `putBlob` during commit surfaces to `onProgress`/the confirm screen
   as a warning. Manage view gains a "Performance" row — segRow-style segmented
   control Auto / Low / Mid / High writing pref `platform.memoryClass` (validated on
   read).
2. **P2 (§3.1):** `css/importer.css` — verify existing left/right insets;
   keyboard-safe bottom padding for the URL field.
3. **P5 (§6.2):** `hydrateChapter` native branch: `Platform.zip.extract({key:
   archiveKey}, entries, seriesId + '/' + chapterId)` → relative paths →
   `Platform.pageUrl(rel)` per page → live ChapterFile; native page URLs are
   session-local exactly like `blob:` — NEVER written back via `Store.putChapter`;
   pruned dirs simply re-extract. Native CBZ import (URI path): `prepareArchive`
   accepts a `PickedFile`; entry list via `Platform.zip.list({uri})` (names+sizes
   only); `groupPages`/ChapterFile construction unchanged; cover via
   `Platform.zip.extract` of the single chosen entry to `pages/import-tmp/` →
   `fetch(pageUrl)` → blob → existing `shrinkToDataUrl` →
   `releasePages('import-tmp')`; draft carries `{archiveKey, nativeUri}` instead of
   the File; `commitDraft` native branch calls
   `Platform.archives.importFromUri(archiveKey, nativeUri)` FIRST (the ordering
   invariant holds with the move as the "blob" step). EPUB/TXT picked natively:
   `readPickedFile` → existing `prepareEpub`/`prepareTxt` unchanged. `safeImageUrl`
   accepts the Capacitor local schemes (same pinning rule as catalogue). Both file
   inputs try `Platform.pickFiles` first with `<input>` fallback. `confirmDelete`
   additionally calls `Platform.archives.releasePages` for the series' chapters;
   `measureSeries` uses native sizes when available. Manage view gains "Move library
   to device storage": migrates old IDB archives one at a time via
   `Platform.archives.migrateBlob(key, blob, onProgress)` (delegation addendum —
   bounded, user-initiated, progress-reported, idempotent per archive). Link intake:
   register `Platform.onAppUrlOpen` → parse like `deepLinkUrl` → `openDialog({url})`
   (the confirm-screen flow, NEVER headless `importFile`); the web `?add=`
   share_target keeps working. Backup: both triggers write
   `Importer.exportLibrary({includeChapters:false})` → `Platform.backup.write` —
   (1) after every `commitDraft`/delete, debounced 1 min; (2) on the FIRST
   `or:progress` event of each local day, debounced 5 min. At boot, the restore offer
   (toast, explicit tap, never silent) for BOTH detections: empty
   `listUserSeries` + backup has series; OR series exist but `listProgress({limit:1})`
   empty while the latest backup has progress rows. Restore goes through the existing
   `importLibrary`.

**Satisfies:** Phase 3 §4.2 (no boot decompression; registry cap; no dead blob: URLs
persisted; Performance row changes `tuning()` next session), Phase 5 §6.5 (300 MB
native import with flat webview heap; app-update drill heals via re-hydration;
same-name+size re-import resumes; delete removes archive + page dirs; deep link opens
prefilled confirm; all three eviction drills' importer half; `<input>` fallback keeps
600 MB expectations; web build zero regressions).

**Must NOT (§6.6):** file identity stays `hash(name.toLowerCase() + ':' + size)` —
every native path carries the ORIGINAL name/size; `kindOfFile` keeps dispatching on
`file.name` extension; the commit ordering invariant (payload → chapters → series row
last); EPUB XHTML always flows through `xhtmlToBlocks` regardless of origin — disk is
not trusted; `putBlob(key, blob)` argument order; web-path JSZip behavior unchanged;
never persist `blob:`/`capacitor://`/`_capacitor_file_` URLs; no direct Capacitor
calls; do not edit reader.js's upload path (that is reader-image's).

**Checker fleet:**
- plan-compliance: hydrate caps (1 archive / 2 chapters) enforced; migration shim
  rewrites-not-decompresses; both backup triggers with stated debounces; both restore
  detections; deep link lands on the confirm screen, never headless import;
  `importFromUri` ordering before chapters/series row; Performance row writes
  `platform.memoryClass`.
- design-consistency: Performance row and migration action follow the manage-view row
  patterns (`imp-` prefix, segmented control with selected-state per house convention,
  44px floor, aria-labels); progress phases reported per the `onProgress` house
  contract; error copy in the GATEWAY_ERRORS full-sentence voice.
- security: EPUB/TXT from native disk still crosses the DOMParser/`xhtmlToBlocks`
  boundary; `safeImageUrl` pinning prefix-exact; restore offer requires explicit tap;
  deep-link URLs go through the existing `normalizeUrl`/`safeFetchUrl` validation; no
  innerHTML; backup JSON never includes source blobs.

### Agent 7: `novel-reader` — role: logic-implementation

**Owns/creates:** `js/novel-reader.js`, `css/novel.css`,
`test/novel-reader.test.html`.

**Required reading:** PLAN.md §3.1 (novel row), §3.3, §4.1 (novel-reader), §4.3, §6.2
(novel-reader), §9; understanding/novelreader.md (mandatory, whole file),
understanding/design.md §4/§10.

**Brief.** Three tightly-scoped changes to the most invariant-dense module:

1. **P2 (§3.1):** `css/novel.css` — fold safe-area left/right into the `--nv-pad-*`
   tokens and the sheet/toast; add `overflow-anchor: none` on `.nv-viewport` (Android
   WebView native scroll anchoring would double-compensate the manual scrollTop
   corrections in `trimStackFront`/`expandEntry`); NOTHING that resizes the readable
   band — chrome paddings stay constant (repagination invariant, novel.css:87-91).
2. **P3 (§4.1):** LRU-evict `state.loaded` outside the infinite window: cap at
   `Platform.tuning().maxLoadedChapters` (guarded; default 10 when Platform absent),
   read ONCE per `open()`. Eviction removes the Map entry only (DOM is already
   windowed by `applyWindow`); `expandEntry` must tolerate a missing entry by
   refilling through `loadChapter` (async refill of a collapsed section, keeping the
   scrollTop compensation). Extend `api.state()` diagnostics so the test page can
   assert `loaded.size <= maxLoadedChapters`.
3. **P5 (§6.2):** `safeImageUrl` (:193) learns the Capacitor local schemes — one
   edit, same prefix-exact pinning as catalogue/importer.
4. **`test/novel-reader.test.html`:** add assertions for the LRU cap and the
   evicted-entry refill path (scroll back re-loads without position jump, per §4.2).

**Satisfies:** Phase 2 §3.2 (landscape insets; rotation keeps the sentence —
regression check; no layout shift on chrome toggle), Phase 3 §4.2
(`loaded.size <= maxLoadedChapters` at all times; scroll-back refills without visible
jumps), Phase 5 §6.5 (native-scheme illustrations render).

**Must NOT (§4.3, §9, novelreader.md §6):** `blockText` ↔ DOM textContent parity;
`renderBlock` one-element-per-block index stability; append-only insertion + manual
scrollTop compensation; tail re-observe and geometric `trackCurrentChapter` fallbacks;
`suppressSync` timings; `completed >= 0.985` and `scrollPct` geometry; the
capture/restore anchor pair untouched beyond the refill tolerance; no per-scroll work
added; no direct Capacitor calls.

**Checker fleet:**
- plan-compliance: eviction is Map-entry-only; tuning read once per open; cap honored
  in the test; `overflow-anchor: none` present on `.nv-viewport` only.
- design-consistency: `--nv-pad-*` tokens keep the `calc(… + env(…, 0px))` pattern;
  no readable-band size change (diff the padding constants); reduced-motion block
  intact; comment voice.
- security: `safeImageUrl` pinning prefix-exact; zero innerHTML (module invariant).

### Agent 8: `goals` — role: logic-implementation

**Owns/creates:** `js/goals.js` (new), `css/goals.css` (new), `test/goals.test.html`
(new).

**Required reading:** PLAN.md §5 (entire), §6.3 (the `or:upload-progress` fold), §8
amendments 8-11, §9 (dayLogs note), §11.10; understanding/design.md (mandatory —
§9 is the binding style guide), understanding/novelreader.md §4.2 (sheet factories),
understanding/catalogue.md §4, understanding/imagereader.md §5.3.

**Brief.** The whole goals + timers feature, engine and UI, observing-not-invading
(zero edits to any other file — store/catalogue/platform/index wiring landed in
Rounds 1-2).

1. **Folding engine (§5.1 binding rules — the edge cases ARE the spec):** listen to
   `or:progress`; per-series in-memory baseline `{chapterId, pct, pageIdx}`; on a
   chapterId change, reset the baseline and fold NOTHING positional for that event;
   deltas clamp at zero (`max(0, …)`); `words += pctDelta × wordCount` only for
   positive finite wordCount; `chaptersCompleted` on completed false→true per
   chapterId per day; book finished = `row.completed` AND `row.chapterId` equals the
   LAST chapter's id via `Catalogue.getSeries` (guarded; `chapterNum ===
   chapterCount` only as last resort) — never `num` arithmetic alone; `booksFinished`
   deduped within the period across days. Single writer of `dayLogs` via
   `Store.putDayLog` (read-modify-write; goals merges arrays). Per-series
   `goals.include` (via `prefs.getFor`) read at fold time; excluded series skip
   events AND session time.
2. **Session/time engine (§5.1):** active = `document.body.dataset.screen` in
   {`reader-screen`, `novel-screen`} AND document visible; MutationObserver on
   `document.body` (`attributeFilter: ['data-screen']`) + `visibilitychange` +
   `pagehide`; idle guard via capture-phase `scroll` + `pointerdown`/`keydown`, pause
   after `goals.idleCutoff` minutes; accumulate in memory, flush to the DayLog every
   30 s and on pause/hide/close. No per-scroll rendering work; folding on
   `or:progress` and a 1 Hz pill tick at most.
3. **Countdown timer (§5.1):** wall-clock deadline `{deadline, minutes}` mirrored to
   localStorage `or.timer` (silent-catch); the 1 Hz pill renders `deadline −
   Date.now()`, never accumulated ticks; on visible, recompute; a deadline that
   passed while hidden fires the chime + `Platform.haptic('success')` ONCE on resume;
   cold boot resumes a future deadline, silently discards a past one.
4. **P5 fold (§6.3):** listen to `or:upload-progress`; fold `pagesDelta`,
   `chaptersDelta`, `seriesTouched`/`booksFinished` (on completed flipping true)
   under the identity `'upload:' + libraryKey`.
5. **Prefs (§5.1 table):** implement every `goals.*` key with the exact values,
   ranges, validation regexes, and defaults of the table; all validated on read like
   `novel.*`. Streak semantics: `goals.schedule`/`scheduleDays` gate which days can
   break a streak; NO grace/forgiveness rule (§11.10 is a user decision).
6. **UI (§5.2 + design.md §9, binding):** `#goals-screen` built at init, registered
   via `window.registerScreen`; `gl-` prefix; tokens defer
   (`--gl-bg: var(--bg, #0a0a0a)` etc.); stats-tile strip (`.cat-stats` pattern:
   streak, minutes today, pages/chapters today, books this period); 3-4px progress
   bars; 7-day bar chart from plain divs with height percentages and textContent
   labels (no canvas); goal cards; "Customize" bottom sheet (24px top radius, scrim,
   translateY hide, right-docked panel ≥720px) rebuilt from goals-OWNED copies of the
   segRow/stepRow/toggle factories and the `sheetSync[]` idiom (novel-reader's are
   private — duplicate, do not export); steppers and segmented controls, no free
   text inputs; `hidden` + `inert` + focus trap + focus restore. Excluded-series
   list from `Store.listProgress` + `Catalogue.listSeries()` (guarded) writing
   `prefs.setFor(seriesId, 'goals.include', …)`; uploads have no exclusion UI
   (stated limitation). Floating pill cloned from the autoscroll-bar template: solid
   `rgba(18,18,18,.92)`, radius 100px, NO backdrop-filter, fixed above the footer
   safe-area, appended to `document.body` (app tokens, never `--nv-*`; floats, never
   takes layout space); shows countdown or session minutes; tap expands; hidden when
   `goals.pill === 'off'` and on non-reader screens (visibility managed on
   `data-screen` changes only). Fill `#goals-home-slot` (guard its absence — render
   nothing if the slot is missing) with the compact today strip clicking through to
   `Goals.openScreen()`; refresh on `or:library-changed`, `or:goals-changed`, and
   own data changes. Reminder rows shown only when `Platform.notify.canNotify()`.
7. **API + navigation (§5.2):** `window.Goals = { openScreen, close, startTimer,
   stopTimer, state }` exactly; `openScreen()` records the return screen and calls
   `showScreen('goals-screen')`; `close()` delegates to `Catalogue.goBack()` (the
   importer precedent). Dispatch `or:goals-changed` (try/catch) after any dayLog
   write or goal-pref change.
8. **`test/goals.test.html` (§5.3):** headless assertions — day rollover; streak math
   incl. schedule rules; pct-delta folding with negative-delta clamping and
   chapter-switch baseline reset; decimal-finale book-finish (num 271.5 /
   chapterCount 271 via chapterId equality); missing-wordCount folding; timer state
   machine incl. wall-clock recompute and expired-while-hidden chime-on-resume.

**Satisfies:** Phase 4 §5.4 in full (time accrual/idle/resume; once-ever book finish
incl. decimal finales; no negative contributions; schedule-aware streaks; timer
background/expiry/kill drills; per-series exclusion; the design checklist; absence
tolerance — app identical with goals deleted; web-only and broken-IDB runs), Phase 5
§6.5 (upload DayLog feed; `upload:<key>` booksFinished exactly once).

**Must NOT (§5.5):** edit ANY other file; no edits to reader.js/novel-reader.js (the
engine observes); no per-scroll work; Progress rows/shapes/writers untouched; `TABS`
untouched; `or.timer` never mirrored natively; no new blur layers; no layout impact
on either reader; all strings via `textContent`.

**Checker fleet:**
- plan-compliance: every folding edge case of §5.1 implemented and tested; pref
  keys/values/ranges/defaults match the §5.1 table exactly; API surface exact;
  `or:upload-progress` fold under the `upload:` identity; app runs identically with
  js/goals.js deleted (slot empty, button absent, events unheard).
- design-consistency: full §5.4 checklist — tokens defer with fallback literals,
  `tabular-nums` on every numeral, 44px floor, `aria-pressed` segments, focus trap +
  restore, `prefers-reduced-motion` block, radius scale (10/8/14/24-sheet-top), met
  green `#34d399` family / amber warning / danger red per house semantics, pill solid
  with no backdrop-filter, hover only inside `(hover:hover) and (pointer:fine)`.
- security: zero innerHTML; `goals.scheduleDays` and `goals.reminder.time` regexes
  enforced on read; all `or:*` dispatches try/catch; series titles from
  `Catalogue.listSeries` reach only `textContent`.

---

## Round 3 — Contract closure, testing collateral, completion log

Runs after Rounds 1-2 land, so the contract documents what actually exists.

### Agent 9: `docs-contract` — role: docs

**Owns/creates:** `docs/ARCHITECTURE.md` (edit), `docs/mobile/TESTING.md` (new),
`docs/mobile/PLAN.md` (append completion log only).

**Required reading:** PLAN.md §7, §8 (all 16 amendments), §9, §12; ALL FIVE
understanding maps; the landed code for every signature it documents (js/platform.js,
js/store.js, js/goals.js, js/reader.js, js/importer.js, js/catalogue.js, index.html,
sw.js).

**Brief.**

1. **`docs/ARCHITECTURE.md`:** apply ALL 16 §8 amendments, each verified against the
   code as actually landed (read the real signatures — do not copy blind from the
   plan): the new load order incl. goals; new §2.3 `window.Platform` (full surface
   incl. `notify`, `pickFiles`, `readPickedFile`, `zip`, `pageUrl`, `archives` — with
   `migrateBlob` marked as a delegation addendum — `onAppUrlOpen`, `backup`, and the
   "Capacitor only inside platform.js, every method web-fallbacks and never rejects"
   rule); `Store.prefs.reload()` + `window.reloadReaderPrefs()`; boot-await +
   platform-aware online gating + hardware-back dispatch; the `or.*` reader
   localStorage keys and their native mirroring (P4 note: `or.timer` deliberately
   unmirrored); `Importer.hydrateChapter` + §1.2 gaining optional `entries`/
   `archiveKey` + the never-persist rule for `blob:`/`capacitor://`/
   `_capacitor_file_` page URLs; `putChapter` stamps + `pruneChapterCache` + the
   three prune triggers; `or:progress`; DB_VERSION 2 + `dayLogs`/`DayLog` shape +
   the four methods + in-memory fallback + single-writer + folding rules; the full
   `goals.*` pref table + `platform.memoryClass` + per-series `goals.include` in
   §3.1; `window.Goals` API + `goals-screen` in §2.1 + `or:goals-changed` +
   `#goals-home-slot`; filesystem-backed blobs (≤64 MB) + user-initiated migration +
   `estimateUsage`; URL-scheme validators; the reader upload-path amendments
   (`loadArchives`, `or.library` manifest, path-dependent `SIZE_CAP`,
   `or:upload-progress`); the new Events registry section (`or:prefs`,
   `or:library-changed`, `or:progress`, `or:goals-changed`, `or:upload-progress` —
   try/catch dispatch, absence-tolerant listeners); the committed `native/or-zip/`
   note (the ONLY committed native code; generated projects stay uncommitted).
   Restate the §7 security rules where amended: native file access does not change
   trust; the or-zip zip-slip containment.
2. **`docs/mobile/TESTING.md` (Phase 6):** the device-matrix checklist — iPhone SE,
   iPhone Pro Max (Dynamic Island), iPad portrait + landscape + split view at 1/3,
   1/2, 2/3, one mid-range Android phone, one Android tablet — each running: boot
   offline, catalogue browse, novel resume mid-sentence across rotation + font
   change, 600 MB+ image session, EPUB/CBZ/TXT import, goals day rollover, timer
   drills (background / expire-hidden / kill-relaunch), back-button paths incl. the
   novel-close drill, deep-link intake, all three §6.5 eviction drills, and the
   app-update drill. Plus the memory verification protocol: Xcode memory gauge +
   Safari Web Inspector on iOS, `chrome://inspect` heap + `adb shell dumpsys meminfo`
   PSS on Android; scripted scenarios with the §9 pass/fail numbers per class and
   platform; the low-class run uses the `platform.memoryClass` override on non-low
   hardware and once on a real ≤2 GB device before the low-class window values are
   final; a results-recording table.
3. **`docs/mobile/PLAN.md`:** append a completion log — phases checked off, and
   deviations noted explicitly: the single `cbz-reader-v5.06` cache bump replacing
   the per-phase bumps, the `Platform.archives.migrateBlob` addendum, plus anything
   Round 1-2 agents flagged in their code comments as a deviation. Touch nothing
   else in the plan; never edit `docs/mobile/understanding/`.

**Satisfies:** Phase 6 (ARCHITECTURE audited against §8 with every amendment present
and accurate; TESTING.md committed; PLAN.md completion log; "a new agent can build the
app from docs alone").

**Must NOT:** edit any code file; weaken or paraphrase-away any §8 signature;
re-litigate any §11/§12 decision; touch the understanding maps.

**Checker fleet:**
- plan-compliance: all 16 amendments present; five documented signatures spot-checked
  against the landed code (Platform, pruneChapterCache, dayLog methods, Goals API,
  hydrateChapter) — doc must match code, not just the plan; TESTING.md contains every
  §6.5 drill, the app-update drill, and the §9 numbers for all three classes on both
  platforms.
- design-consistency: amendments written in the contract's existing voice and table
  formats; §3.1 pref table extended in place, same columns.
- security: §7 remains marked non-negotiable; the amended text nowhere licenses
  innerHTML for native-origin content; zip-slip and never-persist-native-URLs rules
  stated.

---

## Dispatch notes for the orchestrator

- Execute rounds strictly in order; within a round, launch all agents in parallel —
  file sets are disjoint by construction.
- Between Round 1 and Round 2 the tree intentionally references `js/goals.js` /
  `css/goals.css` before they exist (index.html/sw.js are single-owner files). This
  window closes when Round 2 lands; run the full checker fleet on the assembled tree
  after each round, but treat missing-goals-file 404s as expected only in the
  inter-round state.
- The checker fleet (plan-compliance, design-consistency, security) runs the per-agent
  checks listed above, plus two global sweeps on the final tree: (1)
  `python3 -m http.server` boot with zero console errors, imports and reading intact
  (Phase 1/6 web-regression gate, all three `test/*.html` pages green); (2) grep-level
  invariants — no `import `/`export ` statements in app JS, `Capacitor` referenced
  only in js/platform.js, no new `backdrop-filter`, no `innerHTML` fed by non-static
  strings, every new pref validated on read.
- On-device gates (Phase 1 origin gates, Phase 6 matrix) need the user's Mac/iPhone;
  the agents ship the code, NATIVE_BUILD.md, and TESTING.md so the user can run them.
  The Phase 1 contingency (`proxyImageUrl` via CapacitorHttp) ships as a documented,
  disabled seam in platform.js unless the gate is known-failed.
