# Offline Reader — Mobile Refactor Plan (Capacitor)

**Status: binding roadmap, revision 2 (post-adversarial-review).** Every implementation
and checker agent is held to this document. It extends — never replaces —
`docs/ARCHITECTURE.md`. Where this plan adds a Store method, a pref key, an event, or a
module API, that addition must be copied into `docs/ARCHITECTURE.md` **in the same phase
that implements it** (the contract's own rule: "if you change a shape here, you change
it for everyone — say so explicitly").

Line references were verified against the current tree at planning time; if a file has
drifted, the named function is the anchor, not the number. The deep-read slice maps that
back this plan live in `docs/mobile/understanding/` (catalogue, design, imagereader,
importer, novelreader) — all five in ONE directory; agents must read the map for any
file they touch.

The review changelog (what changed in revision 2 and why, including rejected findings)
is §12.

---

## 0. Vision & non-negotiables

We are turning the existing static PWA into an installable iOS + Android app by wrapping
it in Capacitor. The web app **is** the app; native is a progressive enhancement layered
behind one new module, `js/platform.js`.

**iOS is the priority platform** (the user's daily device is an iPhone). Every phase is
verified on iPhone first, iPad second, Android third — but nothing may break Android or
the plain web build, and responsive/Android checks happen **in-phase** (Phase 2), not
only at the final device matrix.

Non-negotiables, in force for every phase:

1. **The web app keeps working with zero build step, served statically.** Plain
   `<script>` tags, no bundler, no framework, no transpile. `python3 -m http.server`
   must still produce a working app after every phase. Capacitor project files are
   additive (`package.json`, `capacitor.config.json`, `scripts/`, `docs/mobile/`);
   the **generated app projects** `ios/` / `android/` are created on the user's Mac and
   are **documented, not committed**. One exception, amended after review: the small
   **committed local plugin `native/or-zip/`** (§6.1) — a self-contained Capacitor
   plugin package referenced from `package.json` as a `file:` dependency and copied into
   the generated projects by `cap sync`. Committed native code is allowed ONLY inside
   `native/`; the generated app projects stay uncommitted.
2. **The existing design philosophy is preserved.** IIFE classic scripts exporting one
   `window.*` global; module-owns-its-DOM built at init; navigation only through
   `Catalogue.*`; persistence only through `Store`; the settings-sheet design language;
   per-series preferences via `Store.prefs.getFor`; the dark `#0a0a0a` shell, indigo
   accent, amber-for-prose / indigo-for-images semantic split; 10px radius house style;
   44px tap floor; `tabular-nums` for every numeral; `prefers-reduced-motion` blocks.
3. **The XSS boundary is absolute.** All prose rendering stays `textContent`-only.
   Third-party strings (chapter text, titles, filenames, EPUB XHTML — including files
   opened from native disk) never reach `innerHTML`. Native file access does not change
   trust.
4. **Memory friendliness is a first-class requirement**, not a cleanup pass. Section 9
   is the budget; every phase that touches rendering or content loading must state its
   memory effect and stay inside the budget. **No file bytes cross the Capacitor bridge
   for archives**: large-file paths are URI/path-based end to end (§6).
5. **Script load order is contract** (`index.html`, ARCHITECTURE §2). reader.js and
   catalogue.js share implicit globals by design; no wrapping reader.js in an IIFE, no
   `'use strict'` added to it, no ES-module conversion, no `defer` reshuffling.
6. **Offline-first.** Everything already readable offline stays readable offline, on
   web (service worker + IndexedDB) and native (bundled assets + Store + Filesystem).
7. **`Store` never rejects for expected conditions**; prefs stay synchronous. Any
   native re-backing must preserve those semantics exactly — including the in-memory
   fallback (ARCHITECTURE §3), which must grow every new method this plan adds.
8. **Every phase that changes shipped web assets bumps the `sw.js` cache name**
   (`cbz-reader-vX.XX`) and updates `SHELL_ASSETS` when files are added.

**Approach (decided, do not relitigate):** Capacitor wrapper around the existing PWA.
`js/platform.js` detects Capacitor at runtime via `window.Capacitor` (the native runtime
injects it; the web build never has it) and reaches plugins through
`window.Capacitor.Plugins.*` — the documented no-bundler pattern. On the plain web,
`Platform` still exists with `isNative:false` and every method degrading to a web
fallback or a resolved no-op. No consumer may call a Capacitor API directly; everything
goes through `window.Platform`.

---

## 1. How to read this plan

- **One module per agent.** The file-ownership table in §10 is the collision map:
  within a phase, agents work in parallel but only inside files they own. If a phase
  requires an edit in a file you do not own, it is listed under that file's owner as a
  separate task with an exact, minimal description.
- Phases are sequential; tasks inside a phase are parallel unless marked "after".
- "Acceptance criteria" are what the checker agent verifies. "Must NOT change" items are
  regression tripwires drawn from documented past bugs — treat them as tests.
- New public surface (Store methods, pref keys, events, Platform API) is specified with
  exact signatures here and consolidated in §8. Implementations must match signatures
  character-for-character.

---

## 2. Phase 1 — Foundation: platform bridge + Capacitor scaffolding

**Goal:** the app runs inside Capacitor on iOS and Android with correct boot, back
button, dialogs, status bar, and preference durability — and runs unchanged in a plain
browser. No feature work; this phase is plumbing and scaffolding. Two launch-critical
assumptions (remote images from the `capacitor://` origin; `crypto.subtle` under it)
are **gated here**, not deferred to Phase 6.

### 2.1 New files

| File | Owner | Contents |
|---|---|---|
| `js/platform.js` | platform | The bridge (below). IIFE, `'use strict'`, exports `window.Platform`. Must be loadable standalone (test harness) and on pages with no Capacitor. |
| `package.json` | platform | `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`, plugins: `@capacitor/app`, `@capacitor/preferences`, `@capacitor/haptics`, `@capacitor/status-bar`, `@capacitor/splash-screen`, `@capacitor/dialog`, `@capacitor/keyboard`, **`@capacitor/device`** (the iOS memory-class signal — §2.2). Scripts: `sync` (copy web files to `www/` then `cap sync`), `ios`, `android`. No build/bundle scripts for the web app itself. |
| `capacitor.config.json` | platform | `appId` (placeholder `com.offlinereader.app` until the user picks one — see §11), `appName: "Offline Reader"`, `webDir: "www"`, iOS scheme default (`capacitor://localhost`). StatusBar: `style: "DARK"`, background `#0a0a0a`, and `overlaysWebView: true` — **which is an Android-side option**; iOS WKWebView always draws under the status bar, so on iOS the levers are the style plus the existing `black-translucent` meta and `viewport-fit=cover` (already in index.html) that keep `env(safe-area-inset-*)` resolving. SplashScreen background `#0a0a0a`, no spinner; Keyboard `resize: native`. |
| `scripts/sync-www.sh` | platform | Plain `cp`/`rsync` of the app files (`index.html`, `styles.css`, `css/`, `js/`, `fonts/`, `chapters/`, `catalog.json`, `manifest.json`, `icon.svg`, `jszip.min.js`, `sw.js`) into `www/`. This is native packaging, not a web build step; the web app is still served from the repo root. |
| `.gitignore` | platform | `node_modules/`, `www/`, `ios/`, `android/`; `package-lock.json` kept (lockfile IS committed — reproducible native builds). `native/` is NOT ignored (committed plugin, §6.1). |
| `docs/mobile/NATIVE_BUILD.md` | platform | Mac walkthrough: `npm install`, `npm run sync`, `npx cap add ios`, icon/splash generation via `npx @capacitor/assets generate` from a 1024px PNG master exported from `icon.svg` (iOS rejects SVG icons), Xcode signing with a free Apple ID for device installs, `npx cap open ios`. Android equivalent. States explicitly that `ios/`/`android/` are generated, not committed, and lists the small **manual per-regeneration steps** (custom URL scheme in Info.plist / AndroidManifest intent-filter — §6.2 share intake) so a regenerated project can be reconstructed from the doc alone. |

### 2.2 `window.Platform` API (contract amendment — full surface as of Phase 1)

```js
window.Platform = {
  isNative: false,              // true iff window.Capacitor reports a native platform
  os: 'web' | 'ios' | 'android',
  ready: Promise,               // ALWAYS present. Resolves after native init +
                                //   pref hydration (below). Resolves immediately on web.
                                //   Never rejects.
  appVersion(),                 // → Promise<string|null>  (App.getInfo on native; null web)
  confirm({ title, message, okLabel, cancelLabel }),
                                // → Promise<boolean>. Native Dialog plugin;
                                //   web fallback: window.confirm(message).
  haptic(kind),                 // 'light'|'medium'|'success'|'warning' → void. No-op on web.
  memoryClass(),                // → 'low'|'mid'|'high'. Resolution order:
                                //   (1) pref platform.memoryClass when not 'auto';
                                //   (2) Android: navigator.deviceMemory
                                //       (≤2 → low, ≥6 → high, else mid);
                                //   (3) iOS: Device.getInfo() from @capacitor/device —
                                //       the machine identifier (`model`) mapped through
                                //       a small static table shipped in platform.js
                                //       (models with ≤3 GB RAM → low; ≥6 GB → high;
                                //       unknown / unlisted → mid);
                                //   (4) default 'mid'.
                                //   navigator.deviceMemory does NOT exist in WebKit —
                                //   the Device plugin IS the iOS signal, which is why it
                                //   is a Phase 1 dependency. The pref override gets a
                                //   visible UI in Phase 3 (importer manage view) so a
                                //   low-end device the table misses can still reach
                                //   'low' by hand.
  tuning(),                     // → { memoryWindow, cacheWindow, lookBehind, lookAhead,
                                //     maxLoadedChapters, chapterCacheMB, pageCacheMB }
                                //   — the §9 numbers for the current memoryClass.
                                //   Consumers re-read at session start, not per frame.
}
```

Phase 1 internal behaviors of platform.js (not API, but required):

- **Pref durability.** iOS can evict WKWebView localStorage. On `ready`: read the native
  Preferences mirror; for each of the keys `or.prefs`, `or.prefs.series`, `or.library`,
  `or.gap` that is **missing** from localStorage but present in the mirror, restore it,
  then call `Store.prefs.reload()` (new, §2.3) **and `window.reloadReaderPrefs()`
  (guarded `typeof`, new, §2.3)**. The second call exists because reader.js consumed
  `or.gap` and `or.library` at parse time — before the async native read resolved —
  so without it the first post-eviction launch shows an empty library list and default
  gap even though the restore succeeded. Never overwrite a key that exists in
  localStorage (live data wins; the mirror is eviction insurance only). Ongoing
  mirroring: listen to `or:prefs` (covers all Store pref writes) and copy the two pref
  blobs to native Preferences (debounced 2 s); copy all mirrored keys on
  `visibilitychange` → hidden and `pagehide`.
- **Copy-listener registration order is load-bearing.** platform.js executes before
  reader.js (contract order), but its hide-time copy listeners MUST run **after**
  reader.js's own `visibilitychange` handler (reader.js:1472 performs the final
  `saveToLibrary()` into `or.library` on hide). platform.js therefore registers its
  copy listeners inside a `DOMContentLoaded` handler: DOMContentLoaded fires after
  every classic script has executed, so reader's parse-time listener is already
  attached, and same-target listeners dispatch FIFO — reader saves first, the mirror
  copies second and snapshots a *current* `or.library`. Because `or.library` /
  `or.gap` / `or.autoscroll` are raw localStorage writes that never emit `or:prefs`,
  the hide-time copy is their ONLY mirror moment; the accepted loss bound is "changes
  since the last hide" on a hard crash — the same bound the web app already has.
- **Android hardware back.** `App.addListener('backButton')` dispatches on
  `document.body.dataset.screen`:
  - `novel-screen` → `window.NovelReader.close({ navigate: true })` — the module's own
    exit path: flushes final progress, unwires its document-level keydown handler,
    resets session state. (A raw `Catalogue.goBack()` here would only switch screens,
    leaving `state.open === true`: orphaned Escape/Space/arrow interception, a live
    progress timer, resident `state.loaded` blocks, and no final flush.)
  - `reader-screen` → `document.getElementById('close-btn').click()` — the click runs
    BOTH registered close listeners: catalogue's (forces `syncImageProgress`, refreshes
    series progress) and reader.js's (revokes blob URLs, clears `pages`/`chapters`,
    navigates to the series screen — or `location.reload()` for upload sessions, which
    is that path's documented reset mechanism).
  - `home-screen` or `upload-screen` → minimize the app.
  - anything else → `window.Catalogue.goBack()`.
  Uses only public APIs and an existing DOM button; no catalogue/reader/novel edits.
- **Status bar.** Dark style on `ready`; on Android additionally overlay mode. On iOS
  no further action — the existing `black-translucent` meta + `viewport-fit=cover`
  already keep content under the status bar and `env(safe-area-inset-*)` non-zero.
- **SW absence is expected.** platform.js does not register or unregister service
  workers; it only reports `isNative` so reader.js can skip registration.

### 2.3 Edits to existing files

| File | Owner | Edit |
|---|---|---|
| `index.html` | integrator | Insert `<script src="./js/platform.js"></script>` between `config.js` and `store.js`. Update the load-order comment. New order (contract): `config → platform → store → jszip → reader → novel-reader → importer → catalogue`. |
| `js/store.js` | integrator | Add `Store.prefs.reload()` — re-reads `or.prefs` / `or.prefs.series` from localStorage into the module snapshots and emits `{key:null, value:null, seriesId:null}` (same shape as the cross-tab storage handler at store.js:359-362). Nothing else changes. |
| `js/reader.js` | reader | Two minimal edits: (1) gate SW registration (reader.js:7-8): register only when `!(window.Platform && window.Platform.isNative)`. (2) Export `window.reloadReaderPrefs = function () { … }` — re-reads `or.gap` into `gapLevel` and re-applies via `applyGap()`, then re-runs `initLibraryList()`. (Phase 2 extends it to re-read `or.autoscroll`.) No structural changes; both edits are additive lines. |
| `js/catalogue.js` | catalogue | Four small edits: (1) `boot()` awaits `window.Platform ? Platform.ready : Promise.resolve()` before `ensureDom()` — prefs are hydrated before first render. (2) `initMode()` (catalogue.js:2006): when `Platform.isNative`, always take the online branch (home-screen + refresh) — the bundled catalogue is local and always works; `navigator.onLine` is not a boot gate on native. (3) The window `offline` handler (catalogue.js:1949-1958): when native, do NOT force `upload-screen`; show the offline badge state only. (4) `confirmDelete` (catalogue.js:1240): use `Platform.confirm({...})` (await) instead of `window.confirm`; `wireServiceWorkerBadge` gains a native branch writing `Platform.appVersion()` into `#home-version`. |
| `sw.js` | integrator | Add `js/platform.js` to `SHELL_ASSETS`; bump cache name to `cbz-reader-v5.04`. |
| `docs/ARCHITECTURE.md` | integrator | Apply the §8 amendments for Phase 1 (load order, Platform API, `prefs.reload`, `reloadReaderPrefs`). |

### 2.4 Acceptance criteria

- `python3 -m http.server` from repo root: app boots, reads, imports exactly as before;
  `window.Platform.isNative === false`; `Platform.ready` resolves; zero console errors.
- Load order in index.html matches the contract comment; platform.js loads before
  store.js.
- In a Capacitor shell (verified on the user's Mac per NATIVE_BUILD.md): boots to
  home-screen with the bundled catalogue even with radios off; delete-series shows a
  native dialog; `#home-version` shows the app version; status bar does not cover the
  tab bar (safe-area insets non-zero).
- **Android back-button paths:** series → home → minimizes; hardware back from an open
  novel chapter lands on the series screen with **no orphaned key handling**
  (Escape/Space/arrows no longer intercepted) and the progress row updated (final flush
  ran); hardware back from an online image chapter runs the close path (progress
  synced); hardware back from an upload-session reader performs the documented
  `location.reload()` reset.
- **Origin gates (launch-critical, §11.5):** in the Capacitor shell with network on,
  open one MangaDex chapter (`mdChapterId` path) and one worker-proxied image chapter —
  pages render. `window.isSecureContext === true` and `crypto.subtle` is defined under
  `capacitor://localhost` (series-id continuity depends on it — §6.6). If the image
  gate fails, the named contingency — platform.js installs a CapacitorHttp-backed
  `window.proxyImageUrl` (the seam already exists, reader.js:231-239) — becomes a
  Phase 1 task and the phase does not sign off until pages render.
- Simulated eviction test (clear localStorage, keep native mirror, relaunch): **on the
  FIRST post-eviction launch** prefs come back AND the upload-screen library list is
  populated AND the gap setting is applied — i.e. `Store.prefs.reload()` and
  `window.reloadReaderPrefs()` both exercised. (A test that only passes on the second
  launch is a failure.)
- Kill the app while a reader is open, relaunch: `or.library` reflects the position at
  the moment of the last hide (mirror ordering verified — the mirrored copy is not one
  save behind).
- `git status` clean of `ios/`, `android/`, `www/`, `node_modules/`.

### 2.5 Must NOT change

- reader.js structure: no IIFE, no `'use strict'`, no reordering — only the two
  additive edits named in §2.3.
- `Store.prefs` stays synchronous; `reload()` is additive.
- `navStack` behavior for in-app UI; `goBack()` fall-through to `goHome()`.
- The `boot()` await must not delay web boot perceptibly (Platform.ready resolves in the
  same microtask on web).
- No Capacitor API referenced outside js/platform.js. No `import` statements anywhere.

---

## 3. Phase 2 — Responsive & platform polish

**Goal:** the app feels at home on every iPhone (SE through Pro Max with Dynamic
Island), iPad (portrait, landscape, split view), and Android phones/tablets. Safe areas
complete, viewport units modernized, touch affordances audited, and the image reader's
customization state made durable. Android and iPad-split-view verification happens **in
this phase** (emulation/simulator), so responsive defects cannot surface for the first
time after three more phases have built on the CSS; the Phase 6 on-device matrix is the
final gate, not the first look.

### 3.1 Files touched

| File | Owner | Work |
|---|---|---|
| `styles.css` | reader | (1) Add `env(safe-area-inset-left/right)` to reader header/footer, autoscroll bar, notices, upload/home/series screen padding (importer.css:54-55 is the model) — landscape notch support. (2) Replace `min-height: 100vh` (lines 18, 27, 85, 551, 802) with `100dvh` behind `@supports (min-height: 100dvh)`, keeping the `100vh` declaration first as fallback. (3) iPad/tablet: at `@media (min-width: 1024px)` widen `.page-wrapper` max-width from 800px to `min(100%, 1000px)` and center; no two-page spread (deferred, §11). (4) Keep the blur budget: no new `backdrop-filter` layers. |
| `css/catalogue.css` | catalogue | Safe-area left/right on `.cat-toast`, tab bar, home/series body padding. Optional: one intermediate grid tweak for iPad portrait if the 48rem breakpoint leaves cards oversized. Keep rem breakpoints. |
| `css/novel.css` | novel-reader | (1) Safe-area left/right folded into `--nv-pad-*` tokens and sheet/toast. (2) `overflow-anchor: none` on `.nv-viewport` (Android WebView native scroll anchoring would double-compensate the manual scrollTop corrections in trimStackFront/expandEntry). (3) Nothing that resizes the readable band: chrome paddings stay constant (repagination invariant, novel.css:87-91). |
| `css/importer.css` | importer | Minor: verify existing left/right insets; keyboard-safe bottom padding for the URL field (`env(keyboard-inset-height, 0px)` where supported is optional; Capacitor Keyboard `resize: native` covers the main case). |
| `manifest.json` | integrator | `theme_color` and `background_color` `#1a1a1a` → `#0a0a0a` (matches the real shell and the `<meta theme-color>`; kills the wrong-color splash). |
| `index.html` | integrator | Verify `viewport-fit=cover` (present) — do not remove; no other head changes needed. |
| `js/reader.js` | reader | **Customization durability (firm, not optional):** persist autoscroll speed and mode as `or.autoscroll` (JSON `{speedIdx, scrollMode}`, same silent-catch localStorage pattern as `or.gap`), read at parse time, written on every speed/mode change. Extend `window.reloadReaderPrefs()` (from Phase 1) to re-read it. This — together with the already-persistent `or.gap` and the persisted chapter/∞ view state being deliberately session-local — is the image reader's customization surface; per-series image-reader prefs are an explicit open question (§11.9), not a silent omission. |
| `js/platform.js` | platform | Add `or.autoscroll` to the mirrored-keys list (the hide-time copy now covers `or.prefs`, `or.prefs.series`, `or.library`, `or.gap`, `or.autoscroll`). Keyboard config sanity (no code beyond config unless device testing shows the importer URL field occluded). |
| `sw.js` | integrator | Cache bump `v5.05`. |
| `docs/ARCHITECTURE.md` | integrator | Document `or.*` reader localStorage keys (`or.library`, `or.gap`, `or.autoscroll`) and their native mirroring — they predate Store and are now part of the durability story. |

### 3.2 Acceptance criteria

- iPhone with Dynamic Island, portrait and landscape: no chrome under the island or the
  home indicator; reader header/footer, tab bar, toasts, sheets, autoscroll pill all
  clear the insets; landscape sensor housing does not cover content.
- iPad portrait and landscape: catalogue uses the 48/68rem layouts; image reader pages
  are wider than the phone column at ≥1024px; novel sheet docks right at ≥720px
  (existing behavior verified, not reimplemented).
- **iPad split view (simulator): 1/3, 1/2, and 2/3 widths** — these produce phone-width
  viewports on a tablet, exactly where breakpoint bugs hide. No broken layouts, no
  horizontal scroll, breakpoints engage/disengage cleanly while dragging the divider.
- **Android (devtools emulation or emulator, in-phase): one small phone viewport
  (360×740) and one tablet viewport (800×1280 / 1280×800)** — all screens usable, no
  clipped chrome, safe-area fallbacks (`env(…, 0px)`) hold where insets are zero.
- **Autoscroll persistence: set a non-default speed and jump mode, kill the app,
  relaunch, re-enter a reader — speed and mode are restored** (and survive a simulated
  eviction via the native mirror).
- Rotating mid-chapter in the novel reader keeps the sentence (anchor system, existing —
  regression check only).
- No layout shift when toggling reader chrome (paged-mode repagination invariant holds).
- Splash/status colors are `#0a0a0a` everywhere; no flash of `#1a1a1a`.
- Lighthouse/devtools emulation of a 360px phone: unchanged from today (no regressions
  at the small end).

### 3.3 Must NOT change

- `.nv-stage`/chrome padding constants that define `scrollPct` geometry and the
  `completed >= 0.985` threshold.
- The max-two-concurrent-blur rule; the autoscroll pill stays solid.
- `showScreen`'s inline display mechanism (no CSS screen-transition experiments here).
- Existing breakpoints' meaning; additions only.

---

## 4. Phase 3 — Memory optimization

**Goal:** hit the §9 budget on the web build and prepare the seams Phase 5 swaps to
native storage. The four hotspots, in impact order: (1) importer's boot-time
decompress-everything rehydration, (2) reader upload path's all-archives-in-heap,
(3) novel infinite-mode `state.loaded` growth, (4) unvirtualized DOM (card grids,
3000-row chapter lists, scroll-mode wrappers).

### 4.1 Work items

**importer (js/importer.js):**
- Replace eager `rehydrateAll()` at boot with **lazy per-chapter hydration**. New public
  API (contract amendment):
  `Importer.hydrateChapter(seriesId, chapterId) → Promise<ChapterFile|null>` — opens the
  series archive (from `Store.getBlob(archiveKey)`), extracts only that chapter's
  `entries` to object URLs, returns the ChapterFile with live `pages`. Internally: keep
  at most **one** JSZip instance (LRU of 1 archive); keep a per-chapter URL registry and
  **revoke** object URLs when a chapter leaves the registry (cap: 2 hydrated chapters
  per archive — current + previous). `rehydrateAll()` becomes a migration shim: it no
  longer decompresses; on first run it rewrites any stored ChapterFile whose `pages` are
  `blob:` URLs to `pages: []` (entries + archive are the truth; dead URLs stop being
  persisted — fixes the IDB churn at importer.js:1536).
- `commitDraft` stops writing page URLs for CBZ chapters entirely (`pages: []`,
  `entries` + `archiveKey` only).
- Surface blob-write failures: a failed `putBlob` during commit must reach
  `onProgress`/the confirm screen as a warning, not just console.warn (the silent
  quota-failure landmine).
- **Manage view gains a "Performance" row** (one `segRow`-style segmented control:
  Auto / Low / Mid / High) writing pref `platform.memoryClass` (validated on read).
  This is the visible escape hatch §2.2 promises: a low-end device the model table
  misses can be forced to the low tier by hand, and Phase 6 uses it to run the
  low-class protocol on non-low hardware.

**catalogue (js/catalogue.js):**
- `resolveChapterContent`: after the Store-cache read, if the file has `archiveKey` +
  `entries` and `pages` is empty or stale, call
  `window.Importer.hydrateChapter(series.id, chapter.id)` (guarded on the function
  existing) and return its result. **Stale means:** any `blob:` page URL, and (from
  Phase 5) any page URL containing `_capacitor_file_` or a `capacitor://` scheme —
  native page URLs are session-local exactly like blob: URLs (§6.2) and a persisted one
  from an earlier build must trigger re-hydration, not render a dead image. Hydrated
  results are NOT written back to Store (object URLs and native page URLs are
  session-local — same rule as MangaDex signed URLs at catalogue.js:491-495).
- Chapter list: `renderChapterList` renders at most **250 rows**, then an inline
  "Show more (N remaining)" row that appends the next 250 (full-rebuild philosophy kept;
  just chunked). `populateRangeSelects` builds its `<option>`s lazily, on first open of
  the range panel.
- **Card grids:** `renderGrid` chunks at **200 cards** with the same "Show more" row
  pattern (covers are already `loading="lazy"` on every card/rail image — regression-
  check, do not remove). Below the threshold, behavior is exactly today's; the bundled
  catalogue plus a normal library stays under it, so this only engages for grown
  libraries.
- **Chapter-cache prune triggers (the steady-state path, not just batch downloads):**
  (1) once per boot, deferred to idle after first render, `boot()` calls
  `Store.pruneChapterCache({maxBytes: Platform.tuning().chapterCacheMB, protectSeriesIds:
  userSeriesIds})`; (2) `resolveChapterContent` counts its cache writes and after every
  **25** `putChapter`s schedules the same prune (debounced 10 s); (3) after
  `downloadRange` batches (as before). Ordinary online reading — the most common growth
  path — now prunes without the user ever touching range download.

**novel-reader (js/novel-reader.js):**
- LRU-evict `state.loaded` outside the infinite window: cap at
  `Platform.tuning().maxLoadedChapters` (default 10; low-memory 6). Eviction removes the
  Map entry only (DOM already windowed by `applyWindow`); `expandEntry` must tolerate a
  missing entry by refilling through `loadChapter` (async refill of a collapsed section;
  keep the scrollTop compensation). Re-resolution is cheap: `resolveChapterContent` is
  cache-first from IndexedDB.
- Read `Platform.tuning()` once per `open()`.

**reader (js/reader.js):**
- Device-classed windows: at session start (both entry paths), read
  `Platform.tuning()` into `MEMORY_WINDOW`/`CACHE_WINDOW`/lookahead variables (they stop
  being consts; defaults = current values so web behavior on mid-class is identical).
- Scroll-mode ("∞") wrapper windowing: when total pages > 800, `renderAllChapters`
  renders only chapters within ±2 of current plus fixed-height spacer divs for the rest
  (heights from locked aspect ratios where known, estimate otherwise), re-rendered on
  chapter change with explicit scrollTop compensation — the novel reader's
  collapse/expand pattern. Below the threshold, behavior is exactly today's.
- Keep every documented WebKit hack verbatim (150 ms defer, `el.src=''`, soft-window
  kept-src, explicit min loop).

**store (js/store.js, integrator):**
- `putChapter` stamps `cachedAt` (ISO) and `sizeEstimate` (JSON string length, computed
  once at write) onto stored ChapterFiles.
- New method (contract amendment):
  `Store.pruneChapterCache({ maxBytes, protectSeriesIds }) → Promise<{removed, bytes}>`
  — deletes cached chapters oldest-`cachedAt`-first until under `maxBytes`, never
  touching `protectSeriesIds` (imported series' chapters are primary data, not cache).
  **Legacy-row backfill:** the prune cursor already reads every row; when it encounters
  a row without `sizeEstimate` it stamps one (recomputed JSON length) and rewrites the
  row, capped at **50 rewrites per prune call** to bound the pass. Pre-migration
  libraries therefore converge to fully-counted within a few prunes instead of sitting
  invisibly above the cap forever; until stamped, an unstamped row counts 0 and is
  never deleted (conservative on purpose — never evict what we have not measured).

### 4.2 Acceptance criteria

- Boot with a library containing a 300 MB CBZ series: no decompression happens until a
  chapter is opened (verify via performance profile / instrumented console timing);
  boot-time JS heap for the library path drops by the size of the formerly-resident
  decompressed pages.
- Open chapter N of an imported CBZ, then N+1: chapter N-1's object URLs are revoked
  (registry cap honored); no dead `blob:` URLs are ever written to IndexedDB.
- Novel infinite scroll across 30+ chapters: `NovelReader.state()` shows
  `loaded.size <= maxLoadedChapters` at all times; scrolling back re-loads evicted
  chapters without visible position jumps.
- 3000-chapter series: series screen renders < 300 DOM rows initially; range selects
  are empty until the panel opens.
- **Steady-state prune: an online-only reading session (no range downloads) that caches
  30+ chapters triggers `pruneChapterCache` at least once (instrumented); with the cap
  artificially lowered, oldest non-protected chapters are actually deleted. A seeded
  pre-migration cache (rows without `sizeEstimate`) gains stamps at ≤50 rows per prune
  and stamped rows count toward the cap from then on.**
- **A 300-card grid renders ≤200 cards initially with a working "Show more" row; card
  cover `loading="lazy"` attributes still present.**
- Scroll-mode with a 1500-page load: wrapper count stays ≤ ~600; scroll-back shows no
  position jumps.
- **Manage view shows the Performance row; setting it to Low changes
  `Platform.tuning()` values on next session start.**
- Web regression: 5-series sample catalogue behaves identically; image reader
  chapter-jump still has the 150 ms defer; no iPhone OOM regression on a 600 MB upload.

### 4.3 Must NOT change

- The stale-anchor discipline: any reader-open path re-reads `Store.getProgress` first.
- `blockText` ↔ DOM textContent parity; `renderBlock` one-element-per-block.
- Append-only insertion in infinite mode; the tail re-observe and geometric
  `trackCurrentChapter` fallbacks.
- MangaDex no-cache rule; `inflight` de-dupe map semantics.
- `putBlob(key, blob)` argument order and out-of-line key semantics.
- The 600 MB web upload cap stays (native raise happens in Phase 5).

---

## 5. Phase 4 — Goals & timers (`js/goals.js` + `css/goals.css`)

**Goal:** a reader-controlled goals system: daily reading-time goals with a live session
timer, books-per-period goals, chapter goals, streaks, and a quick countdown timer —
everything customizable through the app's existing settings-sheet design language,
per-series where it makes sense, reminders-ready for a later notifications plugin.

### 5.1 Data design

**Metric source (contract amendments, store.js, integrator):**
- `Store.putProgress` dispatches `window` CustomEvent **`or:progress`** after a
  successful merge: `detail = { seriesId, patch, row }` (`row` = merged Progress).
  Wrapped in try/catch like `or:prefs`. This is the single choke point all three
  progress writers already funnel through (novel `flushProgress`, catalogue
  `writeOpenProgress` + `syncImageProgress`).
- **Ephemeral local uploads** (the reader upload screen) do not write Store progress —
  their identity is the `or.library` key, not a `series.id`. In **this** phase their
  session **time** counts (the screen-based engine below sees `reader-screen`
  regardless of origin). Their **pages/chapters/books** counts join in **Phase 5 via
  the `or:upload-progress` event (§6.3)** — a named work item with an owner and an
  acceptance criterion there, not a loose promise.
- **DB version 1 → 2**: new object store `dayLogs` (keyPath `day`, index `updatedAt`).
  **The in-memory fallback (ARCHITECTURE §3 — private browsing, broken IDB) grows a
  matching Map-backed table**: `getDayLog/putDayLog/listDayLogs/clearDayLogs` must work
  (session-scoped, no persistence) in degraded environments, per the "never rejects for
  expected conditions" rule. `DayLog` shape:

```jsonc
{
  "day": "2026-08-10",            // local-date key YYYY-MM-DD
  "seconds": 1260,                 // active reading time
  "words": 5400,                   // text: clamped pct-delta x chapter wordCount
  "pages": 34,                     // image: clamped pageIdx advances
  "chaptersCompleted": 2,
  "booksFinished": ["user:ab12"],  // seriesIds (or "upload:<key>" from P5), deduped
  "seriesTouched": ["gutenberg:84"],
  "updatedAt": "2026-08-10T12:00:00.000Z"
}
```

- New Store methods (exact signatures):

```js
await Store.getDayLog(day)                    // → DayLog | null
await Store.putDayLog(day, patch)             // shallow-merge, stamps updatedAt; → DayLog
await Store.listDayLogs({ since, until, limit }) // → DayLog[] desc by day
await Store.clearDayLogs()                    // wipe (goals "reset history")
```

Single-writer rule: only js/goals.js writes dayLogs (read-modify-write; arrays are
merged by the goals module before `putDayLog`, the Store just replaces fields).

**Folding rules (binding for js/goals.js — the edge cases are the spec):**
- The engine keeps a per-series in-memory baseline `{chapterId, pct, pageIdx}`. On an
  `or:progress` event whose `row.chapterId` differs from the baseline's, **reset the
  baseline to the new row and fold nothing positional for that event** —
  `writeOpenProgress` zeroes positional fields on chapter open, which would otherwise
  read as a large negative delta.
- **Deltas clamp at zero**: `max(0, pct − prevPct)`, `max(0, pageIdx − prevPageIdx)`.
  Backward jumps and re-reads contribute 0, never negative, to day totals.
- `words += pctDelta × wordCount` only when a positive finite `wordCount` is known for
  the chapter (ARCHITECTURE §1.1 marks it approximate and text-only; worker-resolved
  chapters may omit it). Unknown wordCount contributes 0 words; seconds still accrue.
- `chaptersCompleted` increments when `row.completed` flips false → true for a
  chapterId not already counted today (in-memory per-day set).
- **Book finished** = `row.completed` AND `row.chapterId` equals the id of the LAST
  chapter of the series (via `Catalogue.getSeries(seriesId)`, guarded; fall back to
  `chapterNum === chapterCount` only when no series object is reachable). Never `num`
  arithmetic alone: `num` may be null, and decimal finales (num 271.5 with
  chapterCount 271) are legal per §1.1 and would never satisfy equality. Deduped
  against `booksFinished` forever (across days: a series id already present in any
  DayLog's `booksFinished` within the current period is not re-counted; the writer
  checks the period's logs, which it already reads to render).

**Session/time engine (goals-owned, zero edits to reader modules):**
- Reading is active when `document.body.dataset.screen` is `reader-screen` or
  `novel-screen` AND the document is visible. Watch via a MutationObserver on
  `document.body` (`attributeFilter: ['data-screen']`) + `visibilitychange` +
  `pagehide`.
- Idle guard: a capture-phase `scroll` listener plus `pointerdown`/`keydown` on
  `document` (capture reaches the novel reader's inner scroller); no input for
  `goals.idleCutoff` minutes pauses the clock. Accumulate seconds in memory; flush to
  the current DayLog every 30 s and on pause/hide/close.
- Words/pages/chapters/books: fold `or:progress` per the rules above.

**Countdown-timer lifecycle (explicit, because iOS freezes JS in the background):**
the timer is **wall-clock-based**. State = `{ deadline: epochMs, minutes }` held in
memory and mirrored to localStorage key **`or.timer`** (silent-catch, same pattern as
`or.gap`) on start/stop/change. The 1 Hz pill tick renders `deadline − Date.now()` —
never accumulated ticks, so frozen intervals cannot drift it. On `visibilitychange` →
visible, remaining time is recomputed from the wall clock; **a deadline that passed
while hidden fires the chime + haptic once, on resume**. Cold boot: a future deadline
found in `or.timer` resumes the countdown; a past one is discarded silently (no
retroactive chime minutes after a kill). `or.timer` is deliberately NOT in the native
Preferences mirror — losing a running countdown to a WebKit eviction is accepted.

**Preference keys (contract amendment, §3.1 table; all validated on read like
`novel.*`):**

| key | values (validated) | default | meaning |
|---|---|---|---|
| `goals.enabled` | boolean | `true` | master switch; off = no tracking, no UI |
| `goals.timeTarget` | int minutes, `0` or `5..480` | `20` | daily reading-time goal; 0 = off |
| `goals.schedule` | `everyday` \| `weekdays` \| `custom` | `everyday` | which days the time goal applies |
| `goals.scheduleDays` | string `/^[01]{7}$/` (Mon..Sun) | `1111111` | only read when schedule=custom |
| `goals.booksTarget` | int `0..999` | `0` | books per period; 0 = off |
| `goals.booksPeriod` | `month` \| `year` | `month` | |
| `goals.chaptersTarget` | int `0..999` | `0` | chapters per period; 0 = off |
| `goals.chaptersPeriod` | `day` \| `week` | `week` | |
| `goals.streakRule` | `target` \| `any` | `target` | a day counts toward the streak when the time goal is met, or when any reading happened |
| `goals.timer.minutes` | int `5..180` | `20` | quick countdown duration |
| `goals.timer.autostart` | boolean | `false` | start the countdown when a reader opens |
| `goals.timer.chime` | boolean | `true` | toast + `Platform.haptic('success')` at zero |
| `goals.pill` | `auto` \| `off` | `auto` | floating in-reader pill: countdown when a timer runs, else today's minutes |
| `goals.idleCutoff` | int minutes `1..30` | `5` | inactivity pause threshold |
| `goals.reminder.enabled` | boolean | `false` | reminders-ready; UI shown only when `Platform.notify.canNotify()` |
| `goals.reminder.time` | string `/^([01]\d|2[0-3]):[0-5]\d$/` | `20:00` | |

Streak semantics: `goals.schedule`/`scheduleDays` define which days can break a streak
(off-schedule days are skipped, never breaking). There is **no additional
grace/forgiveness rule in this cycle** — planned rest days are what the schedule is
for; a forgiveness semantic is a real feature decision put to the user in §11.10, not
invented silently here.

Per-series override (via `prefs.getFor(seriesId, ...)`): `goals.include` (boolean,
default `true`) — exclude a series from all goal counting (e.g. reference material).
Read at event-fold time; when a series is excluded, its `or:progress` events AND its
session time are skipped (time attribution uses the currently-open series, known from
the last `openChapter`-written progress row's seriesId in the fold baseline).

### 5.2 UI (house design language, binding per the design map)

- Files `js/goals.js` + `css/goals.css`; prefix `gl-`; screen `#goals-screen` built at
  init, registered via `window.registerScreen`; tokens defer
  (`--gl-bg: var(--bg, #0a0a0a)` etc.); dark shell palette; met-goal green `#34d399`
  family, warning amber, danger red; all numerals `font-variant-numeric: tabular-nums`;
  44px tap floor; `prefers-reduced-motion` block; safe-area padding on all fixed edges
  including left/right.
- **Goals screen:** stats-tile strip (streak, minutes today, pages/chapters today, books
  this period — `.cat-stats` pattern), thin 3-4px progress bars per active goal, a
  7-day bar chart built from plain divs with height percentages (textContent labels, no
  canvas), goal cards, and a "Customize" button opening the sheet.
- **Settings sheet:** bottom sheet (24px top radius, scrim, translateY hide, docked
  right panel at ≥720px) rebuilt from goals-owned copies of the `segRow` / `stepRow` /
  toggle-row factories and the `sheetSync[]` idiom (novel-reader's are private —
  duplicate the ~120 lines following the same design; do NOT export novel internals).
  Steppers and segmented controls instead of free text inputs (sidesteps the iOS
  keyboard-overlap gap). `hidden` + `inert` + focus trap + focus restore.
- **Per-series exclusion UI:** the sheet's last row, "Excluded series", opens a
  goals-owned list (recently-read series from `Store.listProgress` + titles via
  `Catalogue.listSeries()`, guarded) with an include/exclude toggle per row writing
  `prefs.setFor(seriesId, 'goals.include', …)`. Ephemeral uploads (identity
  `upload:<libraryKey>` from Phase 5) count toward goals but get no exclusion UI until
  Store unification (§11.6) — stated limitation, not an accident.
- **Floating pill:** cloned from the autoscroll-bar template (solid `rgba(18,18,18,.92)`,
  radius 100px, **no backdrop-filter** — blur budget), fixed above the footer
  safe-area, appended to `document.body` (outside `#novel-screen`, so app tokens, not
  `--nv-*`; it floats and never takes layout space — repagination invariant). Shows
  countdown or session minutes; tap expands to today-vs-target + pause + start-timer.
  Hidden when `goals.pill === 'off'`, on non-reader screens, and while reader chrome is
  hidden in the image reader is acceptable to keep (pill manages its own visibility on
  `data-screen` changes only).
- **Entry points (catalogue-owned edits):** `ensureDom` creates an empty
  `<div id="goals-home-slot">` in `#home-body` between the Continue rail and Latest
  updates, and a toolbar icon button "Goals" (guarded: rendered only when
  `window.Goals`). The slot's **contents** are goals-owned: a compact today strip
  (minutes vs target + streak) that clicks through to `Goals.openScreen()`. Goals
  listens for `or:library-changed` and its own data changes to refresh it.
- **Navigation:** mirror the importer precedent exactly — `Goals.openScreen()` records
  the return screen and calls `showScreen('goals-screen')`; `Goals.close()` delegates to
  `Catalogue.goBack()`. New screen id `goals-screen` added to the ARCHITECTURE §2.1
  list.

**Public API (contract amendment):**

```js
window.Goals = {
  openScreen(),          // show the goals screen
  close(),               // return via Catalogue.goBack()
  startTimer(minutes),   // begin/replace the countdown (minutes optional → pref)
  stopTimer(),
  state(),               // read-only diagnostics { today, streak, timer, session }
}
```

Cross-module signal: `or:goals-changed` CustomEvent on window after any dayLog write or
goal-pref change (mirrors `or:library-changed`).

**Reminders-ready seam (platform-owned):** `Platform.notify = { canNotify() → boolean,
scheduleDaily({hour, minute, title, body}) → Promise<boolean>, cancelDaily() →
Promise<void> }` — Phase 4 ships it returning `canNotify() === false` everywhere; a
later opt-in `@capacitor/local-notifications` install lights it up without goals
changes.

### 5.3 Files touched

| File | Owner | Work |
|---|---|---|
| `js/goals.js`, `css/goals.css` | goals | NEW — everything in §5.1/5.2 except the store and catalogue edits |
| `js/store.js` | integrator | `or:progress` dispatch; DB v2 `dayLogs` + 4 methods + in-memory-fallback table |
| `js/catalogue.js` | catalogue | `#goals-home-slot` + guarded toolbar button |
| `index.html` | integrator | `<link>` for css/goals.css (after importer.css); `<script>` for js/goals.js between importer.js and catalogue.js; load-order comment update |
| `js/platform.js` | platform | `Platform.notify` stub |
| `sw.js` | integrator | Add goals files to `SHELL_ASSETS`; bump `v5.06` |
| `test/goals.test.html` | goals | NEW — headless assertions: day rollover, streak math (incl. schedule rules), pct-delta folding **with negative-delta clamping and chapter-switch baseline reset**, **decimal-finale book-finish (num 271.5 / chapterCount 271 via chapterId equality)**, missing-wordCount folding, timer state machine **incl. wall-clock recompute and expired-while-hidden chime-on-resume** |
| `docs/ARCHITECTURE.md` | integrator | §8 amendments for Phase 4 |

### 5.4 Acceptance criteria

- Reading a novel for 2 minutes (visible, active) adds ~120 s to today's DayLog; hiding
  the app or 5 idle minutes pauses accumulation; reopening resumes.
- Finishing the last chapter of a series increments `booksFinished` exactly once, ever,
  per series/period — including a series whose finale has a decimal `num`; books-per-
  month bar reflects it.
- Jumping backward within a chapter, re-reading a chapter, and switching chapters
  produce **no negative or spurious** words/pages contributions (clamp + baseline-reset
  rules verified via `test/goals.test.html`).
- Streak math honors `goals.schedule` (a weekday-only schedule does not break the streak
  over a weekend) and `goals.streakRule`.
- Countdown timer: starts from pill or sheet, survives screen switches within the app,
  fires toast (+ haptic on native) at zero. **Background the app mid-countdown for
  2 minutes, resume: remaining time is wall-clock-correct. Let it expire while hidden,
  resume: the chime fires once on resume. Kill the app mid-countdown, relaunch: a
  still-running countdown resumes from `or.timer`; an expired one is silently
  discarded.**
- Per-series `goals.include=false` (set via the Excluded-series UI) stops that series'
  events from counting (time while reading it also excluded).
- All goals UI passes the design checklist: tokens defer to app tokens, tabular-nums,
  44px targets, `aria-pressed` segments, focus trap, reduced-motion block, no new blur
  layers, no layout impact on either reader.
- With `js/goals.js` absent (deleted), the app runs exactly as before — the slot stays
  empty, the button is not rendered (guarded), store events have no listeners.
- Web-only build (no Platform natives): everything works minus haptics/reminders.
- Private-browsing / broken-IDB run: goals UI works for the session (in-memory dayLogs),
  nothing rejects.

### 5.5 Must NOT change

- No edits to js/reader.js or js/novel-reader.js in this phase (the engine observes;
  it does not invade). No per-scroll work added — folding happens on `or:progress`
  (≥1 s throttled) and a 1 Hz pill tick at most.
- Progress rows, their shapes, and their writers.
- `TABS` stays as-is (entry is the toolbar button + home slot, not a tab — tabs are
  series filters).
- The XSS boundary: all goals strings via `textContent`.

---

## 6. Phase 5 — Native import & storage

**Goal:** native file picking feeds the existing import pipelines **by URI — file bytes
never cross the Capacitor bridge for archives**; archives and page caches live on the
device filesystem (eviction-proof, quota-free); browser-era limits are raised where the
URI path makes them genuinely safe; deep links reach the importer; an automatic library
backup makes IndexedDB eviction survivable, including partial eviction and progress-only
loss.

### 6.1 The native unzip mechanism (decided) + Platform additions (contract amendment)

**Mechanism:** a small **committed local Capacitor plugin, `native/or-zip/`** — its own
mini-package (`package.json`, `ios/` Swift sources, `android/` Kotlin/Java sources,
~100 lines per platform) referenced from the root `package.json` as
`"or-zip": "file:native/or-zip"` and wired into the generated projects by `cap sync`.
iOS implementation uses **ZIPFoundation** (SPM dependency, MIT; supports per-entry
random access and streaming extraction); Android uses **`java.util.zip.ZipFile`**
(platform API; per-entry random access is built in). Neither `@capacitor/filesystem`
nor any first-party plugin can unzip — this plugin is the missing mechanism, and §0's
non-negotiable 1 is amended to allow exactly this committed directory. If a vetted,
maintained community plugin with the identical capability set (central-directory
listing + selective streamed extraction, iOS + Android) is found during implementation,
it may substitute behind the same JS API; the plan does not depend on one existing.

```js
Platform.pickFiles({ accept, multiple })
// → Promise<PickedFile[] | null>;  PickedFile = { name, size, uri }
//   null = no native picker (web) → caller falls back to its <input>.
//   The picker is configured to copy into the app cache, so `uri` is a real,
//   app-readable file path on both platforms (no content:// handling in JS).
//   `name` and `size` are the ORIGINAL values — file identity (§6.6) depends on them.
Platform.readPickedFile(picked)
// → Promise<File | null> — materializes a picked file into the webview as a File
//   with the original name (fetch(convertFileSrc(uri)) → blob → new File).
//   For files that must be PARSED in JS: EPUB/TXT (small), and CBZ only on the
//   web-cap-sized fallback path. Never called for large archives on the URI path.
Platform.zip = {   // backed by native/or-zip; every method → null on web
  list(src),       // src = { key } (an archive under archives/) or { uri } (picked file)
                   // → Promise<{ name, size }[] | null>
                   //   Central-directory read only — zero entry bytes enter the webview.
  extract(src, entryNames, cacheDirKey),
                   // → Promise<string[] | null> — extracts just those entries, streamed
                   //   natively, to Cache/pages/<cacheDirKey>/; returns RELATIVE paths
                   //   ('pages/<cacheDirKey>/NNN.ext'), one per entry, in order.
                   //   NEVER returns absolute URLs (see pageUrl).
}
Platform.pageUrl(relPath)
// → string | null — converts a relative cache path to a webview-loadable URL for THIS
//   session (Filesystem.getUri + Capacitor.convertFileSrc). Session-local BY DESIGN:
//   the iOS app container path embeds a UUID that changes on every app update, so an
//   absolute capacitor:// URL persisted today is dead after the next TestFlight build.
//   Relative paths are the only thing that may ever be stored (and we store none —
//   §6.2 re-derives at hydrate time).
Platform.archives = {
  importFromUri(key, uri), // → Promise<{ size } | null> — MOVE (rename; copy+delete as
                           //   fallback) the picked cache file to Data/archives/<key>.
                           //   Native-side; zero bytes in JS. THE archive-save path.
  save(key, blob),         // → Promise<{ size } | null> — bridge write for SMALL blobs
                           //   only (EPUB/TXT sources ≤ 64 MB, which already live in the
                           //   webview from parsing). Refuses blobs > 64 MB (console.warn
                           //   + null): large archives must arrive via importFromUri.
  read(key),               // → Promise<Blob | null> — same 64 MB guard on native; exists
                           //   for source blobs. CBZ archives are never read into JS on
                           //   native (Platform.zip replaces every such read).
  remove(key),             // → Promise<void>
  releasePages(cacheDirKey),   // → Promise<void>  (delete one chapter's page dir)
  prunePageCache(maxBytes),    // → Promise<{removedDirs, bytes}> LRU by dir mtime
  usage(),                 // → Promise<{ archiveBytes, pageCacheBytes } | null>
}
Platform.onAppUrlOpen(fn)     // custom-scheme deep links (offlinereader://add?url=…)
                              // → fn(url); wraps App 'appUrlOpen'. This is NOT the iOS
                              // share sheet — see §6.2 "Link intake" and §11.8.
Platform.backup = {           // eviction insurance for IndexedDB
  write(json),                // → Promise<boolean>  Documents/backup/library-<date>.json, keep 3
  readLatest(),               // → Promise<string | null>
}
```

### 6.2 Storage re-backing

- **store.js (integrator):** `putBlob`/`getBlob`/`deleteBlob` delegate to
  `Platform.archives.save/read/remove` when `Platform.isNative` **for blobs within the
  64 MB source-blob bound** (API shape, promise semantics, and `putBlob(key, blob)`
  argument order unchanged; IndexedDB remains the web backend). There is **no
  boot-time bulk blob migration** — pushing a web-era 300 MB IDB archive through the
  bridge as base64 is exactly the OOM this phase eliminates. Instead: reads check the
  filesystem first, then IDB (web-era archives keep working via the JSZip hydrate
  path), and the **importer manage view gains a "Move library to device storage"
  action** that migrates old IDB archives one at a time via chunked
  `Filesystem.appendFile` writes (8 MB slices ≈ 11 MB base64 transient per slice —
  bounded, user-initiated, progress-reported, idempotent per archive).
  `estimateUsage` folds in `Platform.archives.usage()` when native.
- **importer.js (importer):**
  - `hydrateChapter` gains a native branch: `Platform.zip.extract({key: archiveKey},
    entries, seriesId + '/' + chapterId)` → relative paths → `Platform.pageUrl(rel)`
    per page → ChapterFile with live page URLs. **Native page URLs are session-local
    exactly like `blob:` URLs — they are NEVER written back via `Store.putChapter`**
    (stored ChapterFiles keep `pages: []`; `entries` + `archiveKey` are the truth; the
    resolver's staleness rule in §4.1 treats any persisted `_capacitor_file_` /
    `capacitor://` URL from an earlier build as stale and re-hydrates, which is also
    what heals every chapter after an iOS app update changes the container UUID).
    On cache miss (pruned dir) the same path simply re-extracts.
  - Native CBZ import (URI path): `prepareArchive` accepts a `PickedFile`; entry list
    via `Platform.zip.list({uri})` (names+sizes only — no JSZip, no bytes);
    `groupPages` and ChapterFile construction unchanged. Cover: `Platform.zip.extract`
    of the single chosen image entry to `pages/import-tmp/` → `fetch(pageUrl)` → blob →
    the existing `shrinkToDataUrl` → `releasePages('import-tmp')`. The draft carries
    `{ archiveKey, nativeUri }` instead of the File in `draft.blobs`; `commitDraft`'s
    native branch calls `Platform.archives.importFromUri(archiveKey, nativeUri)` first
    (the ordering invariant — payload before chapters before series row — holds with
    the file move as the "blob" step). EPUB/TXT picked natively: `readPickedFile` →
    the existing `prepareEpub`/`prepareTxt` unchanged (parsing is in-JS by design;
    sizes are bounded by the format's reality and the 64 MB retention rule).
  - `safeImageUrl` (importer.js:161-168) accepts the Capacitor local scheme
    (`capacitor://localhost/`, `https://localhost/` `_capacitor_file_` forms).
  - Both file inputs first try `Platform.pickFiles`; fall back to the hidden `<input>`.
    Files that arrive as plain Files (web, drag-drop, picker unavailable) keep today's
    JSZip path and today's size expectations.
  - `confirmDelete` also calls `Store.deleteBlob(archiveKey)` (as today) which now
    removes the native file; additionally `Platform.archives.releasePages` for its
    chapters. `measureSeries` uses native sizes when available.
  - **Link intake (downgraded to what the plugins can actually do):** register
    `Platform.onAppUrlOpen` → parse like `deepLinkUrl` → `openDialog({url})` (the
    confirm-screen flow, NOT headless `importFile` — heuristics need the correction
    screen). This serves **custom-scheme links** (`offlinereader://add?url=…`), which
    `appUrlOpen` genuinely delivers once NATIVE_BUILD.md's one-time manual steps are
    done (Info.plist `CFBundleURLTypes` on iOS; a `VIEW` intent-filter on Android —
    both documented as re-apply-after-regeneration steps). A true iOS **share-sheet**
    target requires a native Share Extension (extra Xcode target) and Android
    `ACTION_SEND` needs a send-intent plugin — neither fits the declared plugin set or
    the uncommitted-project rule, so share-sheet intake is an explicit user decision in
    §11.8, not a silent promise. The web PWA's `?add=` share_target keeps working on
    the web build.
  - **Backup (loss window bounded):** two triggers, both debounced and both writing
    `Importer.exportLibrary({includeChapters:false})` → `Platform.backup.write`:
    (1) after every `commitDraft`/delete (debounced 1 min) — library shape changes;
    (2) **on the first `or:progress` event of each local day** (debounced 5 min) —
    progress-only sessions. A user who imports once and reads for months is now at most
    ~1 day of progress exposed, instead of unbounded. At boot, a **restore offer**
    (toast, explicit tap — never silent) appears when either: `Store.listUserSeries()`
    is empty AND `Platform.backup.readLatest()` has series (full/series-side eviction),
    OR user series exist but `Store.listProgress({limit:1})` is empty while the latest
    backup contains progress rows (**partial eviction: progress store wiped, series
    intact**). Restore goes through the existing `importLibrary` (bulk upserts —
    idempotent over intact rows).
- **catalogue.js (catalogue):** `safeImageUrl` twin learns the same schemes; catalogue
  fetch-failure copy becomes platform-aware ("reinstall the app" vs "check your
  connection") via `Platform.isNative`. (The resolver staleness rule was already laid
  in Phase 3 — §4.1 — so no further resolver change lands here.)
- **novel-reader.js (novel-reader):** its `safeImageUrl` (:193) learns the same schemes
  (one edit).

### 6.3 Reader upload path (js/reader.js, reader agent — the careful one)

- **Extract, behavior-preserving:** the 234-line anonymous `#file-input` change handler
  (reader.js:583-817) becomes a named `loadArchives(files)`; the change handler calls
  it. No logic changes in the extraction itself — the chapter-number heuristics, dedupe,
  sort, and notices are load-bearing. Original filenames keep flowing (never native
  URIs) so `extractChapterInfo`/`seriesKey` still work.
- Upload buttons try `Platform.pickFiles({accept: '.cbz,.zip', multiple: true})` first.
- **Native persistence (requirement 3, URI path):** picked archives are moved via
  `Platform.archives.importFromUri('upload:' + seriesKey + ':' + i, picked.uri)` and a
  manifest (list of `{name, size, key}`) is stored in the existing `or.library` entry.
  "Resume" on the upload screen reopens the archives from disk with no re-picking. The
  `or.library` cap rises from 5 to 10 entries on native; removal of a library row
  deletes its archive files.
- **Native indexing & page loads (zero archive bytes in JS):** on the URI path,
  Phase-1-style all-at-once `f.arrayBuffer()` is replaced by sequential per-archive
  `Platform.zip.list({key})` — the same name strings feed the SAME heuristics
  (`extractChapterInfo`, `seriesKey`, dedupe, 0-index shift); pages become
  `{archiveKey, entryName}` refs instead of JSZip entries. Zip-of-CBZs nesting: when
  `list()` shows inner `.cbz`/`.zip` entries, extract each inner archive to Cache
  (`zip.extract`, sequential, one at a time), `list({uri})` it, and release it after
  indexing. On chapter render, one `Platform.zip.extract(archiveKey,
  chapterEntryNames, cacheDirKey)` per chapter feeds `Platform.pageUrl` URLs into the
  existing `directUrl` page mechanism (so `loadPage`/`unloadDistant`/teardown logic is
  untouched); leaving a chapter releases its page dir (keep ≤ 2 chapter dirs per
  session, mirroring the importer's hydrate cap). Steady state holds **zero** JSZip
  instances and zero archive buffers in the webview. The web path is untouched.
- **Cap raise (URI path only):** `SIZE_CAP` becomes 2 GB **only for sets that arrived
  through `pickFiles` URIs** (bytes never enter JS, so the cap now bounds disk, not
  heap). Any set that arrives as plain Files — web, or the `<input>` fallback on
  native — keeps the 600 MB cap on every platform, because that path still materializes
  ArrayBuffers.
- **Goals feed (`or:upload-progress`, closes the §5.1 promise):** inside
  `saveToLibrary()` (the existing debounced choke point that already computes
  high-water-mark values), dispatch window CustomEvent **`or:upload-progress`** with
  `detail = { libraryKey, pagesDelta, chaptersDelta, completed }` — deltas computed
  against the previous stored entry's high-water marks (≥ 0 by construction of the
  "only ever advance" semantics; `completed` is the entry's completion flag). Try/catch
  wrapped like every `or:*` dispatch. **goals (js/goals.js, goals owner, same phase):**
  listen and fold — `pages += pagesDelta`, `chaptersCompleted += chaptersDelta`,
  `seriesTouched` / `booksFinished` (on `completed` flipping true) use the identity
  `'upload:' + libraryKey`. Session time for uploads was already counted by the Phase 4
  screen engine. Per-series `goals.include` cannot be *set* for uploads until Store
  unification (§11.6): they always count, and the plan says so out loud.

### 6.4 Files touched

`js/platform.js` (platform) · **`native/or-zip/`** (platform, NEW committed plugin) ·
`js/store.js` (integrator) · `js/importer.js` (importer) · `js/reader.js` (reader) ·
`js/goals.js` (goals — the `or:upload-progress` fold) · `js/catalogue.js` (catalogue) ·
`js/novel-reader.js` (novel-reader, one function) · `package.json` +
`capacitor.config.json` (platform: add `@capawesome/capacitor-file-picker` or an
equivalent picker with copy-to-cache + original-name preservation,
`@capacitor/filesystem`, the `file:native/or-zip` dependency) ·
`docs/mobile/NATIVE_BUILD.md` (platform: plugin build notes, URL-scheme /
intent-filter manual steps) · `sw.js` bump + `docs/ARCHITECTURE.md` amendments
(integrator).

### 6.5 Acceptance criteria

- iPhone: import a 300 MB CBZ via the native picker → series appears, archive file is
  in `Directory.Data/archives/`, IDB holds no blob; **webview JS heap during the whole
  import stays within +50 MB of pre-import baseline** (Safari Web Inspector heap
  timeline — no archive bytes crossed the bridge); kill and relaunch → chapter opens by
  extracting only its own pages natively.
- **App-update drill (the container-UUID kill):** bump the build number, reinstall over
  the existing install (TestFlight/Xcode) → every imported CBZ chapter still opens
  (page URLs re-derived this session; nothing stale persisted; images render, not
  blank).
- Re-importing the same file (same name+size) resumes progress — identity preserved
  through the native picker (original `name`/`size` on `PickedFile`).
- Deleting the series removes the archive file and its page-cache dirs (verified via
  `Platform.archives.usage()`).
- Deep link: opening `offlinereader://add?url=…` from Safari/notes opens the importer
  confirm screen prefilled (custom scheme registered per NATIVE_BUILD.md). (Share-sheet
  intake is §11.8 — explicitly out of this phase.)
- **Eviction drills:** (1) wipe IndexedDB entirely, relaunch → restore offer appears;
  accepting restores series + progress (chapters re-hydrate from surviving native
  archives / re-download). (2) **Progress-only eviction:** clear only the progress
  store, keep series, relaunch → the partial-eviction offer appears and restores
  progress. (3) Read for a day with zero imports → the daily `or:progress`-triggered
  backup wrote a fresh file (verify mtime).
- Upload-screen multi-CBZ on native: pick 20 files, close app, relaunch → "Resume"
  reopens without re-picking; a **1.5 GB set indexes with `zip.list` only** (no crash
  on a 3 GB-RAM device; webview heap flat during indexing); reading pages extracts
  per-chapter and holds ≤ 2 chapter page-dirs.
- Reading an ephemeral upload advances today's DayLog pages/chapters via
  `or:upload-progress` (goals screen reflects it); finishing the set increments
  `booksFinished` under `upload:<key>` exactly once.
- The `<input>` fallback path on native (picker plugin disabled in a test build)
  still imports, still enforces the 600 MB cap.
- Plain web build: pickers fall back to `<input>`; blobs still in IDB; 600 MB cap
  intact; `Platform.zip.*` and `pageUrl` return null and no code path depends on them;
  zero regressions.

### 6.6 Must NOT change

- File identity = `hash(name.toLowerCase() + ':' + size)`; any path that renames or
  copies must carry the original name — `PickedFile.name`/`size` are the originals, and
  `readPickedFile` stamps the original name onto the materialized File.
- `kindOfFile` dispatching on `file.name` extension (PickedFile dispatch uses the same
  `name`).
- The commit ordering invariant (payload — blob or native file move — → chapters →
  series row last).
- EPUB XHTML still flows through `xhtmlToBlocks` regardless of origin — disk is not
  trusted.
- Web-path JSZip behavior and the reader's WebKit hacks.
- `crypto.subtle` availability assumptions: the Capacitor scheme stays a secure context
  (verified as a Phase 1 gate, §2.4); do not switch to schemes that lose `subtle`, or
  ids fork.

---

## 7. Phase 6 — Verification, hardening & docs

**Goal:** prove the budget, close the loop on the contract, and leave the repo in a
state where a new agent can build the app from docs alone.

Work items:

- **Device matrix run** (checklist committed as `docs/mobile/TESTING.md`, platform
  agent): iPhone SE (small + low RAM), iPhone Pro Max (Dynamic Island), iPad portrait +
  landscape + split view, one mid-range Android phone, one Android tablet. Each runs:
  boot offline, catalogue browse, novel resume mid-sentence across rotation + font
  change, image reader 600 MB+ session, import EPUB/CBZ/TXT, goals day rollover, timer
  (incl. background/expire-hidden/kill-relaunch cases), back-button paths (incl. the
  novel-reader close drill), deep-link intake, **all three eviction drills of §6.5**,
  and the **app-update drill**. This matrix is the final gate; Phase 2 already did the
  first-look emulation passes.
- **Memory verification protocol** (in TESTING.md): Xcode memory gauge + Safari Web
  Inspector timelines on iOS; on Android `chrome://inspect` heap snapshots + `adb shell
  dumpsys meminfo` PSS; scripted scenarios with the §9 pass/fail numbers **per class
  and per platform** (the low-class run uses the `platform.memoryClass` override on
  non-low hardware, and once on a real ≤2 GB device before the low-class window values
  are declared final). Results recorded in the doc.
- **Web regression:** full manual pass of the static build; `test/*.html` pages green
  (`test/novel-reader.test.html`, `test/goals.test.html`, plus NEW
  `test/platform.test.html` (platform agent) asserting web-fallback behavior of every
  Platform method — including `zip.*`, `pageUrl`, `readPickedFile` returning null and
  `archives.save` refusing >64 MB).
- **Docs (integrator):** README gains an "Install as an app" section;
  `docs/ARCHITECTURE.md` audited against §8 (every amendment present and accurate);
  `docs/mobile/NATIVE_BUILD.md` re-verified end-to-end on a clean Mac checkout
  (including the or-zip plugin build and the URL-scheme manual steps); this PLAN.md
  updated with a completion log (phases checked off, deviations noted).
- **Final sweeps:** sw.js cache version final bump; `manifest.json` icon set: commit the
  generated PNG icons (192/512 + maskable) so the web PWA also stops being SVG-only;
  console free of errors on all platforms; every new pref validated on read.

Acceptance: the matrix + memory protocol pass; a checker agent following only
ARCHITECTURE.md + this plan finds no undeclared contract drift.

---

## 8. Contract amendments (consolidated — apply to docs/ARCHITECTURE.md in the phase noted)

1. **(P1) §2 load order** becomes: `config.js → platform.js → store.js → jszip →
   reader.js → novel-reader.js → importer.js → goals.js (P4) → catalogue.js`.
2. **(P1) New §2.3 `window.Platform`** — full API of plan §2.2 (including
   `memoryClass` with the Device-plugin iOS heuristic), extended in P4
   (`Platform.notify`) and P5 (`pickFiles`, `readPickedFile`, `zip`, `pageUrl`,
   `archives`, `onAppUrlOpen`, `backup`). Rule: Capacitor APIs are referenced ONLY
   inside js/platform.js (and the committed plugin's own native sources); every method
   has a web fallback and never rejects for expected conditions.
3. **(P1) `Store.prefs.reload()`** — re-read both pref blobs from localStorage, emit
   `{key:null, value:null, seriesId:null}`. **(P1) `window.reloadReaderPrefs()`** —
   reader.js re-reads `or.gap` (P2: + `or.autoscroll`) and re-runs `initLibraryList()`;
   called by platform.js after an eviction restore.
4. **(P1) `Catalogue.boot()` awaits `Platform.ready`** when Platform exists; boot-time
   online/offline gating is platform-aware (native always boots to home). Hardware
   back dispatches per plan §2.2 (novel/reader screens exit through their own close
   paths, never raw `goBack`).
5. **(P2) Reader localStorage keys documented**: `or.library`, `or.gap`,
   `or.autoscroll` (`{speedIdx, scrollMode}`) — mirrored to native Preferences by
   platform.js with the DOMContentLoaded registration-order rule; localStorage remains
   the synchronous source of truth. (P4 adds `or.timer` — deliberately NOT mirrored.)
6. **(P3) `Importer.hydrateChapter(seriesId, chapterId) → Promise<ChapterFile|null>`**;
   `rehydrateAll()` no longer decompresses (migration shim); CBZ ChapterFiles persist
   `entries` + `archiveKey` with `pages: []`; `blob:` URLs are never persisted — and
   from P5, neither are `capacitor://`/`_capacitor_file_` URLs (both are session-local;
   the resolver treats any persisted one as stale). ChapterFile §1.2 formally gains
   optional `entries: string[]` and `archiveKey: string`.
7. **(P3) `Store.putChapter` stamps `cachedAt` + `sizeEstimate`;
   `Store.pruneChapterCache({maxBytes, protectSeriesIds}) → Promise<{removed, bytes}>`**
   — LRU by `cachedAt`, protected series exempt, lazy `sizeEstimate` backfill (≤50
   rows/call). Prune triggers: catalogue boot (idle), every 25 resolver cache writes
   (debounced), after `downloadRange`.
8. **(P4) `or:progress` CustomEvent** dispatched by `Store.putProgress`
   (`detail = {seriesId, patch, row}`).
9. **(P4) DB_VERSION 2**: object store `dayLogs`; `DayLog` shape per plan §5.1;
   methods `getDayLog(day)`, `putDayLog(day, patch)`, `listDayLogs({since, until,
   limit})`, `clearDayLogs()` — implemented in the in-memory fallback too. Single
   writer: js/goals.js; folding rules (clamping, baseline reset, chapterId-based
   book-finish) per plan §5.1.
10. **(P4) §3.1 pref keys**: the `goals.*` table of plan §5.1 (values, ranges,
    defaults), plus `platform.memoryClass` (`auto|low|mid|high`, default `auto`, UI in
    the importer manage view) and the per-series `goals.include`.
11. **(P4) `window.Goals` API** (`openScreen/close/startTimer/stopTimer/state`), screen
    id `goals-screen` added to §2.1, event `or:goals-changed`, and the catalogue-owned
    `#goals-home-slot` mount point (slot contents are goals-owned).
12. **(P5) Store blobs may be filesystem-backed** when native (≤64 MB source blobs;
    archives go through `Platform.archives.importFromUri`, never through blob writes);
    no automatic IDB→FS migration — the manage-view "Move library to device storage"
    action migrates chunked, user-initiated; `estimateUsage` includes native numbers.
13. **(P5) URL-scheme validators** (`safeImageUrl` in importer.js, catalogue.js,
    novel-reader.js) accept Capacitor local-file URLs; §1.2 notes `pages` may carry
    them **at runtime only — never persisted**.
14. **(P5) Reader upload path**: `loadArchives(files)` is the named entry point; native
    persistence manifest inside `or.library`; `SIZE_CAP` is path-dependent (600 MB for
    any blob-materializing path on every platform; 2 GB only for the native URI path);
    `saveToLibrary` dispatches `or:upload-progress`.
15. **(All) Events registry** (new §): `or:prefs`, `or:library-changed`, `or:progress`,
    `or:goals-changed`, `or:upload-progress` — window CustomEvents, dispatch wrapped in
    try/catch, listeners must tolerate absence of the dispatcher.
16. **(P5) Committed native plugin** `native/or-zip/` (owner: platform) providing
    `Platform.zip.list/extract`; iOS via ZIPFoundation, Android via
    `java.util.zip.ZipFile`; the ONLY committed native code in the repo; generated
    `ios/`/`android/` app projects remain uncommitted.

---

## 9. Memory budget (binding process numbers; residency rows are measured targets)

Device classes via `Platform.memoryClass()` — `low` (≤2 GB RAM or unknown old device),
`mid` (3-4 GB, and the default when the signal is inconclusive), `high` (≥6 GB).
Override pref `platform.memoryClass` (visible UI: importer manage view, P3).
`Platform.tuning()` returns the row:

| Knob | low | mid (today's values) | high |
|---|---|---|---|
| Image reader `MEMORY_WINDOW` (soft, keep-src) | 12 | 25 | 35 |
| Image reader `CACHE_WINDOW` (hard, clear-src) | 30 | 60 | 80 |
| Lookahead (behind / ahead) | 2 / 6 | 4 / 10 | 6 / 12 |
| Novel `maxLoadedChapters` (`state.loaded` LRU) | 6 | 10 | 14 |
| IDB chapter-cache cap (`pruneChapterCache`) | 100 MB | 200 MB | 300 MB |
| Native page-cache cap (`prunePageCache`) | 200 MB | 400 MB | 600 MB |

Fixed policies:

- **Decoded-bitmap residency is a measured on-device target, not a knob-derived
  guarantee.** The windows bound how many `<img>`s hold a live src; what stays decoded
  under them is WebKit's internal image-cache policy, which the app does not control
  (60 kept-src pages × ~6.6 MB decoded RGBA for a 1080×1600 page could theoretically
  exceed the targets — in practice WebKit evicts aggressively under pressure).
  Steady-state targets while reading images, verified with the Phase 6 protocol
  (Xcode memory gauge / Android PSS), tuned by adjusting the window rows if missed:
  **≤ 80 MB (low) / ≤ 150 MB (mid) / ≤ 250 MB (high)**. The low-class window values
  (12/30) are provisional until validated on a real ≤2 GB device (Phase 6).
- **JSZip residency:** ≤ 1 open archive instance app-wide for imported series (importer
  LRU); the native URI upload path holds 0 archives in JS at ALL times (indexing is
  `zip.list`, pages are `zip.extract` — §6.3). Web upload path unchanged (bounded by
  the 600 MB cap).
- **Hydrated CBZ chapters:** ≤ 2 chapters per archive (web object URLs, revoked on
  eviction; native page dirs, released on eviction). Native extracted pages live on
  disk, not in heap.
- **Novel blocks:** `state.loaded` capped per table (~≤ 10 MB even at 14 chapters);
  DOM already capped at 12 sections / ±2 live.
- **DOM:** chapter lists render ≤ 250 rows before "Show more"; card grids ≤ 200 cards
  before "Show more" (covers lazy-loaded — existing); scroll-mode page wrappers
  windowed above 800 pages (target ≤ ~600 wrappers); range selects built lazily.
- **EPUB inline images:** existing budgets stay (1.5 MB/image, 8 MB/chapter, covers
  re-encoded to 640px).
- **Eviction policies:** IDB chapter cache LRU by `cachedAt` with the three §4.1
  triggers, imported-series chapters exempt (primary data). Native page cache LRU by
  directory mtime. `dayLogs` are ~1 row/day — no cap needed.
- **Process targets** (verified in Phase 6 on device): steady-state total footprint
  **< 150 MB (low) / < 250 MB (mid) / < 350 MB (high)** — on iOS via Xcode memory
  gauge, on Android the same numbers as PSS via `dumpsys meminfo`. Import peak:
  **native URI path — webview heap within +50 MB of baseline** (no archive bytes cross
  the bridge; disk grows by archive size + current chapter's pages); **web/blob path —
  < archive size × 1.2 + 150 MB**, which the 600 MB cap keeps survivable. Zero jetsam
  kills across the TESTING.md scenario set on a 3 GB iPhone.
- **What must never be "optimized":** the 150 ms teardown defer, `el.src=''`
  discipline, soft-window kept-src trick, explicit min loop (reader.js); append-only +
  manual scrollTop compensation (novel). They ARE the memory optimizations for WebKit.

---

## 10. File-ownership table (collision map for parallel agents)

| File(s) | Owner agent | Phases active |
|---|---|---|
| `js/platform.js`, `native/or-zip/`, `capacitor.config.json`, `package.json`, `scripts/`, `.gitignore`, `docs/mobile/NATIVE_BUILD.md`, `docs/mobile/TESTING.md`, `assets/` (icon/splash masters), `test/platform.test.html` | **platform** | 1, 2, 4, 5, 6 |
| `index.html`, `js/config.js`, `js/store.js`, `sw.js`, `manifest.json`, `docs/ARCHITECTURE.md`, `README.md` | **integrator** | 1, 2, 3, 4, 5, 6 |
| `js/catalogue.js`, `css/catalogue.css` | **catalogue** | 1, 2, 3, 4, 5 |
| `js/reader.js`, `styles.css` | **reader** | 1, 2, 3, 5 |
| `js/novel-reader.js`, `css/novel.css`, `test/novel-reader.test.html` | **novel-reader** | 2, 3, 5 |
| `js/importer.js`, `css/importer.css` | **importer** | 2, 3, 5 |
| `js/goals.js`, `css/goals.css`, `test/goals.test.html` | **goals** | 4, 5, 6 |
| `docs/mobile/PLAN.md`, `docs/mobile/understanding/` | planning (this doc + the read-only slice maps; completion log updated in Phase 6 by integrator) | — |

Rules: an agent never edits outside its rows. Cross-module needs are expressed as the
minimal named edits this plan already lists (e.g. catalogue's resolver hook, store's
event dispatch, reader's `or:upload-progress` dispatch consumed by goals). `worker/`,
`scraper/`, `chapters/`, `catalog.json`, `fonts/` are untouched by this refactor.

---

## 11. Open questions (decisions needed from the user; defaults chosen so work can proceed)

1. **App id / bundle identifier** — placeholder `com.offlinereader.app`; needs the
   user's reverse-DNS choice + Apple Developer account status (free-account 7-day
   signing works for personal installs; App Store needs the paid program). The deep-link
   custom scheme (`offlinereader://`) should be confirmed at the same time.
2. **Minimum OS floors** — proposed iOS 16.0 and Android 10 with WebView ≥ 111
   (`color-mix()`/`:has()` are already in the codebase and set the real floor). Older
   Android WebViews degrade the custom theme; acceptable?
3. **iPad two-page spread** in the image reader — deferred as new feature (Phase 2 only
   widens the column). Wanted in a later cycle?
4. **Reminders** — Phase 4 ships the seam disabled; installing
   `@capacitor/local-notifications` (extra permission prompt) is a user call.
5. **MangaDex from the `capacitor://` origin** — API sends `ACAO:*` and pages load as
   `<img>`, so it should work. This is now a **Phase 1 acceptance gate** (§2.4) with a
   named contingency (CapacitorHttp-backed `proxyImageUrl`), not a deferred hope.
6. **Ephemeral-upload unification** — Phase 5 gives local uploads native persistence
   (`or.library` manifest) **and** goal counting (`or:upload-progress`), but keeps them
   out of Store/`Continue reading`, and per-series `goals.include` cannot be set for
   them. Full unification (local uploads become library series through the importer
   path, gaining Store progress, Continue-reading, and per-series prefs) is a candidate
   Phase 7 — confirm appetite.
7. **Backup restore UX** — proposed explicit toast-offer on empty-library boot AND on
   detected progress-only eviction (never silent). Confirm.
8. **Share-sheet intake (true cost stated)** — appearing in the iOS share sheet
   requires a native Share Extension (an extra Xcode target that must be re-created or
   scripted per project regeneration — in tension with the uncommitted-projects rule);
   Android needs an `ACTION_SEND` intent-filter + a send-intent plugin. Phase 5 ships
   custom-scheme deep links only. Want the share extension as a follow-up work item
   with its maintenance cost, or is deep-link + in-app paste enough?
9. **Per-series image-reader preferences** — the per-series prefs system covers the
   novel reader and goals; the image reader's customization (gap, autoscroll
   speed/mode) is global-and-persistent after Phase 2, because per-series values would
   require reader.js to consult Store per session (crossing the "engine observes, does
   not invade" line for a module that predates Store) and because upload sessions have
   no series id until §11.6 unification. Reading-direction (`rtl` is stored on Series
   but the image reader renders a vertical column regardless) and fit modes are a new
   reader feature, not a pref plumbing task. Confirm this scoping, or promote either
   piece to the Phase 7 candidate list.
10. **Streak forgiveness ("grace days")** — not built; `goals.scheduleDays` covers
    planned rest days. If forgiveness-for-unplanned-misses is wanted (e.g. one free
    miss per week), it needs a semantics decision (per week? per streak? retroactive?)
    — say the word and it becomes a small Phase 6/7 addition to the streak fold.

---

## 12. Review changelog (revision 2 — adversarial review dispositions)

Two independent critic passes produced 2 blockers, 10 majors, 11 minors (overlapping).
Every blocker and major is addressed; minors are addressed except where noted with
rationale. Findings are grouped by root cause.

**Blockers — Phase 5 had no real mechanism (both critics):** accepted in full.
The fictional `extractPages`-on-Filesystem design is replaced by a **committed local
Capacitor plugin `native/or-zip/`** (§6.1: ZIPFoundation on iOS, `java.util.zip` on
Android; §0's "nothing native committed" rule explicitly amended for `native/` only),
and every byte path is now **URI-based**: `pickFiles` returns `{name, size, uri}`,
archives are saved by native move (`importFromUri`), entry listing is a native
central-directory read (`zip.list`), extraction is native and streamed
(`zip.extract`), and `archives.save/read` are restricted to ≤64 MB source blobs. The
2 GB `SIZE_CAP` now applies **only** to the URI path (blob paths keep 600 MB
everywhere), and §6.5/§9 import-peak numbers are re-derived from the mechanism
(webview heap flat within +50 MB during native import).

**Major — persisted `convertFileSrc` URLs die on iOS app update:** accepted. Native
page URLs are now session-local exactly like `blob:` URLs — never persisted
(`pages: []` stays canonical); `zip.extract` returns relative paths, `Platform.pageUrl`
converts per session; the Phase 3 resolver staleness rule treats any persisted
`capacitor://`/`_capacitor_file_` URL as stale; an app-update drill was added to §6.5.

**Major — requirement-3 gap / §5.1 vs Phase 5 contradiction on ephemeral uploads (also
flagged as a minor by the second critic):** accepted. The dangling "join in Phase 5"
promise is now a named Phase 5 work item: `saveToLibrary()` dispatches
`or:upload-progress` (high-water deltas, ≥0 by construction), goals folds it under the
`upload:<libraryKey>` identity, with an acceptance criterion (§6.3, §6.5) and the
`goals.include` limitation stated out loud (§5.2, §11.6).

**Major — `memoryClass()` hand-waved on the priority platform (both critics):**
accepted. `@capacitor/device` added to the Phase 1 dependency list; the iOS heuristic
is specified (machine-identifier table, unknown → mid); the `platform.memoryClass`
override gets a visible UI (importer manage view, Phase 3) so low-end iPhones can
always reach the low tier; Phase 6's low-class protocol uses the override explicitly.

**Major — chapter-cache cap unenforced on the steady-state path:** accepted. Three
prune triggers (boot-idle, every 25 resolver cache writes, after range downloads) and
a lazy `sizeEstimate` backfill inside the prune cursor (≤50 rewrites/call) so
pre-migration rows converge instead of hiding at 0 bytes forever (§4.1, acceptance in
§4.2).

**Major — backup loss window / partial eviction:** accepted. A daily
`or:progress`-triggered backup bounds progress exposure to ~1 day; partial-eviction
detection (series intact, progress store empty vs. a backup containing progress) gets
its own restore offer; both have drills in §6.5 and the Phase 6 matrix.

**Major — no Android/iPad-split-view checks before Phase 6:** accepted. Phase 2
acceptance now includes Android phone + tablet emulation viewports and iPad split view
at 1/3, 1/2, 2/3 in the simulator; Phase 6 remains the final on-device gate.

**Major — reader customization hanging off an "Optional" line:** accepted in part.
`or.autoscroll` persistence is now a firm Phase 2 work item with a kill-and-relaunch
acceptance criterion and mirror coverage. Per-series image-reader prefs and
direction/fit controls are NOT silently decided: they are an explicit user decision
(§11.9) with the engineering rationale (Store coupling into a pre-Store module;
uploads lack a series id until unification) stated for sign-off. Rejected the
implied alternative (building per-series gap now) as scope growth that crosses the
"engine observes, does not invade" boundary mid-refactor.

**Major — Android hardware back leaks reader sessions:** accepted. The backButton
handler now dispatches per screen: `NovelReader.close({navigate:true})` for the novel
reader, the existing `#close-btn` click for the image reader, minimize on home/upload,
`goBack()` otherwise — with a no-orphaned-keydown / final-flush acceptance criterion
(§2.2, §2.4).

**Major — iOS share intake not implementable with declared plugins:** accepted. Phase
5's criterion is downgraded to custom-scheme deep links (which `appUrlOpen` actually
delivers; manual Info.plist/intent-filter steps documented in NATIVE_BUILD.md as
re-apply-on-regeneration); real share-sheet intake moved to §11.8 with its true cost
(Share Extension target / send-intent plugin).

**Major — pref mirror mis-ordered vs reader's final save:** accepted. The copy
listeners are registered in a `DOMContentLoaded` handler (deterministically after
reader.js's parse-time `visibilitychange` handler; same-target FIFO dispatch), the
ordering requirement is stated in §2.2, and §2.4 verifies the mirror is not one save
behind at kill time. The raw-key coverage bound (changes since last hide on a hard
crash) is documented rather than papered over.

**Major — eviction restore lands after reader consumed its keys:** accepted. reader.js
exports `window.reloadReaderPrefs()` (a listed reader-owner edit); platform calls it
after restore; the acceptance test now requires the library list and gap on the FIRST
post-eviction launch.

**Minor — understanding maps split across `undefined/` and `understanding/`:**
accepted and executed during this revision — all five maps now live in
`docs/mobile/understanding/` (owned by planning, §10); the plan header points there.

**Minor — countdown lifecycle across background/kill unspecified:** accepted.
Wall-clock deadline semantics, `or.timer` persistence, resume/chime-on-resume/cold-boot
rules specified (§5.1) with acceptance criteria (§5.4).

**Minor — DayLog folding edge cases + phantom "grace" rule:** accepted. Clamping,
baseline-reset-on-chapter-switch, missing-wordCount, and chapterId-based book-finish
(decimal finales, null nums) are specified (§5.1) and required in the test file.
"Grace" is deleted from the test description rather than invented: `scheduleDays`
already provides planned rest days, and a forgiveness semantic is a product decision —
surfaced as §11.10 instead of being silently designed.

**Minor — MangaDex-origin check not gated:** accepted. Now a Phase 1 acceptance gate
with the CapacitorHttp `proxyImageUrl` contingency named and budgeted (§2.4, §11.5),
alongside the `isSecureContext`/`crypto.subtle` device check (the other config minor).

**Minor — grids unvirtualized / missing high-class + Android numbers:** accepted.
Grid chunking at 200 cards (Phase 3) with the lazy-cover regression check; §9 gains a
high-class footprint target (<350 MB) and Android PSS pass/fail numbers plus the
Android protocol in Phase 6.

**Minor — §9 residency numbers not derivable from knobs:** accepted. Residency rows
are reframed as measured on-device targets (WebKit's decoded-image cache is the true
bound), with the low-class window values marked provisional until validated on real
≤2 GB hardware.

**Minor — Store contract gaps (`sizeEstimate` zero-count; in-memory fallback lacking
dayLogs):** accepted — prune-time backfill (§4.1) and the fallback requirement (§5.1,
§5.4, amendment 9).

**Minor — `overlaysWebView` misdescribed as an iOS lever:** accepted; §2.1/§2.2
corrected (Android-only option; iOS relies on the existing meta + `viewport-fit=cover`).

---

## 13. Completion log (all phases landed; deviations recorded)

**Status: implementation complete.** All six phases shipped in a single
delivery (three implementation rounds per `docs/mobile/tasks/assignments.md`),
verified by the build checker: headless web boot green with zero console
errors, and all test pages green — `test/goals.test.html` (97 checks),
`test/platform.test.html` (65), `test/importer.test.html` (137),
`test/novel-reader.test.html` (LRU cap + evicted-entry refill suites). The
contract closure landed with it: `docs/ARCHITECTURE.md` carries all 16 §8
amendments verified against the landed code, `docs/mobile/TESTING.md` holds
the §7 device matrix + memory protocol, and this log closes the plan.

**Still pending (requires the user's hardware, by design):** the Phase 1
on-device origin gates (§2.4 — the `proxyImageUrl` contingency ships as a
disabled seam in platform.js) and the Phase 6 device-matrix + memory runs.
TESTING.md and NATIVE_BUILD.md are the runbooks for both.

### Phase-by-phase

- **Phase 1 — foundation:** `js/platform.js` (full bridge in one pass: core
  API, pref mirror with the DOMContentLoaded ordering rule, hardware-back
  dispatch, status bar, memory classes + §9 tuning table);
  `Store.prefs.reload()`; `window.reloadReaderPrefs()`; reader SW gate;
  catalogue boot-await / native online gating / `Platform.confirm` /
  version badge; Capacitor scaffolding (`package.json`,
  `capacitor.config.json`, `scripts/sync-www.sh`, `.gitignore`,
  `docs/mobile/NATIVE_BUILD.md`).
- **Phase 2 — responsive polish:** safe-area insets across styles.css /
  catalogue.css / novel.css / importer.css; `100dvh` behind `@supports`;
  ≥1024px page-wrapper widening; `overflow-anchor: none` on `.nv-viewport`;
  `or.autoscroll` persistence + mirror coverage; manifest colors `#0a0a0a`.
- **Phase 3 — memory:** lazy `Importer.hydrateChapter` (1-archive /
  2-chapter caps) with `rehydrateAll()` as a scrub-only migration shim;
  `putChapter` `cachedAt`/`sizeEstimate` stamps; `Store.pruneChapterCache`
  (≤50 backfills/call, unstamped rows never evicted); the three catalogue
  prune triggers; 250-row / 200-card chunking + lazy range selects;
  tuning-driven reader windows + >800-page scroll-mode spacer windowing;
  novel `state.loaded` LRU at `maxLoadedChapters`; the manage-view
  Performance row (`platform.memoryClass`).
- **Phase 4 — goals & timers:** `js/goals.js` + `css/goals.css` complete
  (folding engine with every §5.1 edge case, session/idle engine, wall-clock
  countdown with `or.timer`, goals screen + customize sheet + pill + home
  slot); `or:progress` dispatch in `Store.putProgress`; DB v2 `dayLogs` + the
  four methods incl. the in-memory fallback; `Platform.notify` stub;
  catalogue slot + guarded toolbar button.
- **Phase 5 — native import & storage:** `native/or-zip/` committed plugin
  (list/extract, zip-slip contained); `pickFiles`/`readPickedFile`/`zip`/
  `pageUrl`/`archives`/`onAppUrlOpen`/`backup` in platform.js; store blob
  delegation (≤64 MB, filesystem-first reads, no bulk migration); importer
  native import/hydration/deep-link/backup+restore/"Move library to device
  storage"; reader URI upload path (`loadArchives`, `or.library` manifest,
  cap 10, path-dependent `SIZE_CAP`, `or:upload-progress`); Capacitor-scheme
  `safeImageUrl` pinning in catalogue/importer/novel-reader.
- **Phase 6 — verification & docs:** PNG icon set (192/512/maskable +
  `assets/icon-1024.png` master) referenced from manifest.json; README
  "Install as an app" section; final `sw.js` bump; `test/platform.test.html`;
  ARCHITECTURE.md audit; TESTING.md; this log. On-device matrix execution
  remains with the user (above).

### Deviations from the plan (all intentional, all accepted)

1. **Single sw.js cache bump to `cbz-reader-v5.06`.** The per-phase
   intermediate bumps (v5.04, v5.05) collapsed because all phases shipped in
   one delivery; shipped web assets changed once, so the cache name changed
   once (assignments.md header convention).
2. **`Platform.archives.migrateBlob(key, blob, onProgress) →
   Promise<{size}|null>` — delegation addendum.** The §6.2 "Move library to
   device storage" migration needs a Capacitor-side chunked writer that §6.1
   never named. Specified in assignments.md, implemented in platform.js
   (8 MB slices, idempotent per archive, progress-reported, null on web),
   documented in ARCHITECTURE §2.3 as a delegation addition.
3. **`Platform.pickFiles` returns `[]` (not null) on picker cancel/error.**
   §6.1 specified only "null = no native picker". The empty-array cancel
   return is a deliberate, commented refinement: falling back to the
   `<input>` on cancel would open a second dialog on top of the one the user
   just dismissed. Contract documents both returns (ARCHITECTURE §2.3).
4. **`Goals.startTimer(minutes)` argument is not clamped to 5..180.** The
   API argument is app-internal and only sanity-bounded (0 < m ≤ 1440) so
   short test countdowns work; the PREF path (`goals.timer.minutes`) is what
   validates 5..180. By design.
5. **Streaks: reading on an off-schedule day still counts toward the
   streak.** The schedule only *forgives absence* on off-days; it does not
   ignore reading done on them. Consistent with §5.1's "off-schedule days are
   skipped, never breaking" — the plan never said off-day reading is
   discarded — but recorded here because the checker flagged the asymmetry.
6. **`or:upload-progress` dispatches for upload sessions only**
   (`window.readerOrigin === 'upload'`). Online image sessions also pass
   through `saveToLibrary()` but already reach goals via `or:progress`;
   dispatching for them would double-count every page. A tightening of
   §6.3's letter in service of its intent.
7. **Reader zip-of-CBZs on the native URI path falls back to the plain-File
   JSZip pipeline.** §6.3's inner-archive flow (`zip.extract` the inner
   archive to Cache, `list({uri})` it) needs `Platform.zip.list` to accept a
   cache-relative path, which the current bridge cannot do. Nested zips on
   native therefore take the 600 MB blob path. **Logged as future work**
   (extend `zipSrcPath` with a `{ cachePath }` source form).
8. **Goals pill docks bottom-RIGHT, not bottom-center.** The autoscroll bar
   owns bottom-center in the image reader; co-docking would overlap the two
   fixed elements. Same template, solid background, no blur — position is
   the one change.
9. **`pruneChapterCache` takes bytes; tuning speaks MB.** The MB→bytes
   conversion lives at the single call site (catalogue's `runCachePrune`),
   with guards so a missing tuning row cannot read as a zero-byte budget.
   Documented in ARCHITECTURE §3.
10. **`window.proxyImageUrl` exempts `https://localhost/_capacitor_file_/`**
    (fixed post-verification): Android serves extracted local pages under
    that origin, and routing a local file through the image gateway would
    break page loads. Prefix-exact test, same pinning rule as
    `safeImageUrl`.
11. **Goals `finishedThisPeriod` init race** — a book finished in the
    instant between module init and the first period-log read could
    theoretically double-count; practically unreachable (the read completes
    before any reader can be opened). Accepted as-is.

### Known gaps carried forward

- **iOS web-install icon is still SVG-only**: `index.html` keeps
  `<link rel="apple-touch-icon" href="icon.svg">`, which iOS Safari ignores
  (falls back to a page screenshot). The PNG set exists
  (`icons/icon-192.png` etc., in manifest.json); pointing apple-touch-icon
  at a PNG is a one-line index.html follow-up for the next cache bump.
  Native iOS installs are unaffected (icons come from the asset catalog).
- **Defense-in-depth hardening (not currently reachable):**
  `hydrateChapter` builds its extraction dir as
  `seriesId + '/' + chapterId` and reader.js as
  `nativeCacheDirBase + '/ch-' + chIdx`. Ids are app-generated today, but a
  future id source containing `..` would deserve a sanitizer at the
  `cacheDirKey` seam (or-zip already rejects escapes on the entry side;
  `pageUrl` rejects `..` on the read side).
- Low-class tuning windows (12/30) remain provisional until the TESTING.md
  run on real ≤2 GB hardware.
