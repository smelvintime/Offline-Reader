# Offline Reader — Architecture Contract

This document is the **binding contract** between the modules of this app. Every
module is written against it. If you change a shape here, you change it for
everyone — say so explicitly.

The app is a **static PWA**. No build step, no framework, no bundler. Vanilla
ES2020, plain `<script>` tags, served from GitHub Pages. The only server-side
component is a single Cloudflare Worker that acts as a **content gateway**
(CORS/referer bypass + HTML→JSON normalization). We do not host content.

The same tree also ships as an **iOS/Android app via a Capacitor wrapper**
(see `docs/mobile/PLAN.md` and `docs/mobile/NATIVE_BUILD.md`). Native is a
progressive enhancement behind exactly one module, `js/platform.js` (§2.3):
no other file may reference a Capacitor API, and the plain-web build keeps
working, zero-build, with `Platform.isNative === false` and every native
method degrading to a web fallback. The generated `ios/`/`android/`/`www/`
projects are never committed; the one committed piece of native code is the
local plugin `native/or-zip/` (§2.3).

---

## 1. Content model

The app handles two fundamentally different kinds of chapter:

| kind    | series `type`                | chapter payload         |
| ------- | ---------------------------- | ----------------------- |
| image   | `manga`, `manhwa`            | ordered list of image URLs |
| text    | `lightnovel`, `webnovel`     | ordered list of typed blocks |

Everything else (catalogue browsing, library, progress, import) is shared.

### 1.1 `catalog.json` (schema v2)

```jsonc
{
  "version": 2,
  "generatedAt": "2026-08-07T00:00:00.000Z",
  "series": [ /* Series */ ]
}
```

`Series`:

```jsonc
{
  "id":        "md:32d76d19-…",      // REQUIRED, globally unique, stable across rebuilds
  "type":      "manga",              // REQUIRED: manga | manhwa | lightnovel | webnovel
  "title":     "Jujutsu Kaisen",     // REQUIRED
  "altTitles": ["呪術廻戦"],
  "cover":     "https://…/cover.jpg",// absolute URL, or "covers/<id>.jpg" relative to app root
  "description": "…",
  "author":    "Gege Akutami",
  "artist":    null,
  "status":    "ongoing",            // ongoing | completed | hiatus | cancelled | unknown
  "genres":    ["Action", "Supernatural"],
  "tags":      [],
  "language":  "en",
  "source":    "generic-manga",      // adapter id, or "user" for imported series
  "sourceUrl": "https://example.org/title/…",
  "readingDirection": "ltr",         // ltr | rtl | vertical  (image types only)
  "updatedAt": "2026-08-01T…",
  "chapterCount": 271,
  "chapters":  [ /* Chapter */ ]     // ascending by num
}
```

`Chapter`:

```jsonc
{
  "id":    "c-0271",                 // REQUIRED, unique within the series, stable
  "num":   271.5,                    // number | null   (decimals allowed)
  "volume": 30,                      // number | null
  "title": "The Decisive Battle",    // string | null
  "updatedAt": "2026-08-01T…",
  "lang":  "en",
  "wordCount": 3210,                 // text chapters only, approximate

  // Payload — EXACTLY ONE of the following three resolution strategies:
  "pages": ["https://…/1.webp", …],  // image: inline URLs
  "text":  "para one\n\npara two",   // text: inline plain text (small chapters only)
  "src":   "chapters/xxx/c-0271.json"  // either kind: fetch a ChapterFile (see 1.2)
}
```

`mdChapterId` is a **retired** fourth strategy. v1 rows may still carry the
field and the validator still type-checks it, but nothing resolves it: the
code that did called one specific site's API from the browser, which §8 does
not allow. Such a row resolves through the gateway if it has a URL, and
otherwise fails as `no-payload`.

**Rule:** if `wordCount` or `type` says text but the payload is `pages`, the
payload wins. Renderers dispatch on payload shape, then fall back to
`series.type`.

### 1.2 `ChapterFile` — `chapters/**/*.json`

Large payloads (novel prose, long page lists) live in their own file so
`catalog.json` stays small and the service worker can cache chapters on demand.

```jsonc
{
  "seriesId": "gutenberg:84",
  "id":       "c-0003",
  "num":      3,
  "title":    "Chapter III",
  "kind":     "text",                // "text" | "image"

  // kind === "image"
  "pages":    ["https://…/1.webp"],

  // kind === "text"
  "blocks":   [ /* Block */ ],
  "wordCount": 3210,

  // kind === "image", imported-archive rows only (both OPTIONAL):
  "entries":    ["001.jpg", "002.jpg"], // this chapter's member names inside the archive
  "archiveKey": "user:ab12…"            // Store blob key / native archive file name
}
```

For an imported CBZ chapter, `entries` + `archiveKey` are the durable truth
and the **stored** row keeps `pages: []`. Live page URLs are minted per
session by `Importer.hydrateChapter` (§5): object URLs on the web, Capacitor
file URLs on native. **`pages` may carry `blob:`, `capacitor://` or
`…/_capacitor_file_/…` URLs at runtime only — they are NEVER persisted.**
Object URLs die with the session, and the iOS app container path embeds a
UUID that rotates on every app update, so a persisted native URL is a dead
link by the next build. The catalogue resolver treats any persisted
session-local URL as stale and re-hydrates instead of rendering it.

### 1.3 `Block` — the text content primitive

**We never render third-party HTML.** All prose is normalized to a flat list of
typed blocks, and renderers set `textContent`, never `innerHTML`. This is the
XSS boundary: a hostile source site cannot inject script into the reader.

```jsonc
{ "t": "p",  "c": "It was a bright cold day in April…" }
{ "t": "h2", "c": "Chapter Three" }
{ "t": "h3", "c": "Part One" }
{ "t": "hr" }
{ "t": "blockquote", "c": "…" }
{ "t": "pre", "c": "…" }
{ "t": "ul", "items": ["one", "two"] }
{ "t": "ol", "items": ["one", "two"] }
{ "t": "img", "src": "https://…", "alt": "Illustration" }
{ "t": "note", "c": "Translator's note: …" }
```

Allowed `t` values: `p h2 h3 h4 hr blockquote pre ul ol img note`.
Unknown types MUST be rendered as `p` (never dropped silently, never trusted).

Inline emphasis is intentionally not supported in v2 — prose reads fine without
it and it keeps the XSS boundary trivially auditable.

---

## 2. Module map

Load order in `index.html` (this order is part of the contract):

```
js/config.js        window.OR_CONFIG                          — owned by integrator
js/platform.js      window.Platform  (the ONLY Capacitor module) — agent: platform
js/store.js         window.Store                              — owned by integrator
js/covers.js        window.Covers    (pure SVG cover generator, no screen) — agent: catalogue
jszip.min.js
js/reader.js        image reader (CBZ + online image chapters) — pre-existing
js/novel-reader.js  window.NovelReader                        — agent: novel-reader
js/importer.js      window.Importer                           — agent: importer
js/goals.js         window.Goals  (optional — app must run without it) — agent: goals
js/thoughts.js      window.Thoughts  (thoughts-screen + end-of-book UI) — agent: thoughts
js/sources.js       window.Sources   (sources-screen + home shelf)      — agent: sources
js/settings.js      window.AppSettings (settings-screen + theme engine + focus sheet) — agent: settings
js/catalogue.js     window.Catalogue  (boots the app)         — agent: catalogue
```

`platform.js` sits before `store.js` because it is the only module with no
dependencies and everything after it may consult `Platform.isNative`.
`covers.js` is dependency-free and loads before reader.js (it registers no
screen). `thoughts.js` / `sources.js` / `settings.js` load after reader.js
(they register screens) and before catalogue.js (which boots). `settings.js`
applies the app theme **at parse time** (documentElement attribute + custom
properties read synchronously from prefs) so the first paint is already
themed (§2.10).

**Deletability rule.** `goals.js`, `covers.js`, `thoughts.js`, `sources.js`
and `settings.js` are each individually **deletable**: with any one file
absent the app boots and runs exactly as without that feature — every
cross-module reference is guarded
(`window.X && typeof window.X.y === 'function'`), every slot stays empty,
every button is simply not rendered, every event goes unheard.

Each feature module **creates its own DOM at init time** (`document.body.append`)
rather than relying on markup in `index.html`. This keeps `index.html` free of
merge conflicts. Each module owns exactly its own JS file and CSS file; do not
edit another module's files. The Phase 7 CSS files are `css/thoughts.css`
(class prefix `tho-`), `css/sources.css` (`src-`) and `css/settings.css`
(`set-`), linked in the head after `css/goals.css`; `covers.js` has no
stylesheet — consumers style the `<svg>` in their own sheets.

The service-worker cache is **`cbz-reader-v5.08`** and `SHELL_ASSETS`
precaches the full module list above plus all seven CSS files — the four new
JS modules (`covers`, `thoughts`, `sources`, `settings`) and three new
stylesheets are in the shell.

### 2.1 Screens

`window.showScreen(id)` (in `reader.js`) hides every registered screen and shows
one. New screens register themselves:

```js
window.registerScreen(element);   // adds to the hide-all set; call at init
window.showScreen('novel-screen');
```

Screen ids in use: `upload-screen`, `loading-screen`, `reader-screen`,
`home-screen`, `series-screen`, `novel-screen`, `import-screen`,
`goals-screen`, `thoughts-screen`, `sources-screen`, `settings-screen`.

### 2.2 Navigation contract

`window.Catalogue` owns routing. Other modules never call `showScreen` to go
"back" — they call:

```js
Catalogue.openSeries(series)      // show the series detail screen for a Series object
Catalogue.openChapter(series, chapter)  // dispatch to the right reader
Catalogue.goBack()                // return to wherever the user came from
Catalogue.goHome()
```

`Catalogue.openChapter` decides: image payload → `reader.js`
(`loadOnlineChapter`), text payload → `NovelReader.open(...)`.

**Platform-aware boot.** `Catalogue.boot()` awaits
`window.Platform ? Platform.ready : Promise.resolve()` before `ensureDom()`,
so a native launch paints with mirror-restored prefs (§2.3). On the web
`ready` is pre-resolved — one microtask, no perceptible delay. When
`Platform.isNative`, `initMode()` always takes the online branch (the bundled
catalogue is local; `navigator.onLine` is not a boot gate on native) and the
window `offline` handler badges instead of forcing `upload-screen`.
`confirmDelete` awaits `Platform.confirm({...})`, and the version badge in
`#home-version` shows `Platform.appVersion()` on native (the SW cache name on
web).

**The unified back table.** Two dispatchers route "back" on
`document.body.dataset.screen` — platform.js's Android hardware-back
listener and catalogue.js's history-sentinel `popstate` handler (below).
They are the same semantic table, carried once here; every branch is
guarded, so a deleted optional module's row falls through to
`Catalogue.goBack()` harmlessly:

| screen | action |
| --- | --- |
| `novel-screen` | Android: `NovelReader.close({ navigate: true })` — the module's own exit path (final flush, keydown unwire). Popstate: **cancel** — re-arm the sentinel and do nothing; a swipe never exits a reader |
| `reader-screen` | Android: `#close-btn.click()` — runs BOTH registered close listeners (catalogue's progress sync + reader's teardown). Popstate: **cancel**, as above |
| `loading-screen` | **cancel** (do nothing / re-arm) — a transitional screen; it resolves to a reader on its own, and tearing it down mid-fetch from a gesture helps nobody |
| `import-screen` | `Importer.close()` |
| `goals-screen` | `Goals.close()` |
| `settings-screen` | `AppSettings.close()` |
| `sources-screen` | `Sources.close()` |
| `thoughts-screen` | `Thoughts.close()` |
| `series-screen` | `Catalogue.goBack()` |
| `home-screen` / `upload-screen` | Android: minimize the app. Popstate: root — mark unarmed, do nothing |
| anything else | `Catalogue.goBack()` (defensive fall-through) |

The two reader screens must exit through their own close paths — a raw
`goBack()` would only switch screens, leaving orphaned key handlers, a live
progress timer, and no final progress flush. The sentinel's in-reader
*cancel* honors the same rule by never exiting them at all.

**The history sentinel** (catalogue-owned, PLAN7 §2.11-A): a **one-entry**
sentinel, not a mirrored stack — one back gesture = one route through the
table above. Boot runs `history.replaceState({ or: 'root' }, '')`; a
`MutationObserver` on `body[data-screen]` arms it (`pushState({ or:
'sentinel' })`) on entering any non-root screen and disarms it
(`history.back()`, whose popstate is swallowed) on returning to
`home-screen`/`upload-screen`. Two booleans, `armed` and `disarming`, gate
every push; because `history.back()` is async, arming while a disarm is in
flight is **queued through the swallowed popstate** — when it lands, the
handler clears the flags and re-checks the live screen, arming then if the
user already re-entered a non-root screen. At most one sentinel entry can
ever exist, and the layer is self-healing: every popstate routes against the
LIVE `data-screen`, so a transient mismatch resolves on the next event.
Forward gestures are inert (there is never a forward entry) — a documented
limitation, not a bug. No URL changes, no hash routing.

What this buys: browser/PWA back and iOS Safari/PWA edge-swipe navigate one
screen back everywhere except inside readers, where they are cancelled.
**Cancelled, not invisible**: iOS plays its native swipe transition against
a stale page snapshot before `popstate` fires, so an in-reader edge-swipe
shows a slide-and-snap-back flicker. That artifact is cosmetic (no teardown,
no state change) and is the honest price of same-document history on iOS —
it has its own on-device row in `docs/mobile/TESTING.md`. On **native iOS**
the WKWebView back gesture stays at its default — **off** — so the native
app has no edge-swipe anywhere; back is the header affordances (the
deliberate trade-off documented in NATIVE_BUILD.md's "Back gestures"
appendix, §2.3). Android hardware back never touches the sentinel — it goes
through platform.js's native dispatch.

**Home affordances in both readers.** The novel reader's header carries a
Home icon button after the back chevron: full teardown + final flush
(`api.close({ navigate: false })`) then `Catalogue.goHome()` (guarded, with
a `showScreen('home-screen')` fallback for stripped builds). The image
reader has `#home-btn` in `index.html` next to `#close-btn`; reader.js wires
the teardown (revoke, clear session state, `el.src=''` discipline — without
`location.reload()`) then `Catalogue.goHome()`, and **hides the button
outside series-origin sessions** (`readerOrigin !== 'series'` — mirroring
the `#close-btn` upload-origin special case, where `goHome()` would land on
a worse screen than the upload screen the session came from).
**`#home-btn` is a two-listener contract** like `#close-btn`: reader.js owns
teardown + navigation, catalogue owns the progress flush
(`syncImageProgress(true)` + `refreshSeriesProgress`). Because reader.js
registers its listener at parse time (before catalogue runs), catalogue's
flush is a **document-level capture-phase click listener** filtered to the
button — the capture phase is what guarantees the flush runs before
teardown clears the session state (a same-node bubble listener would always
fire second and flush nothing).

### 2.3 `window.Platform` — the native bridge

`js/platform.js` is the **only** app file allowed to reference a Capacitor
API (the committed plugin's own native sources are the one other place).
IIFE, `'use strict'`, loadable standalone and on pages with no Capacitor: it
detects the native runtime via `window.Capacitor` and reaches plugins through
`window.Capacitor.Plugins.*` at call time. **Every method has a web fallback
and never rejects for expected conditions** — a missing plugin, a cancelled
picker, or a missing file resolves to `null` / `[]` / a no-op, never a
rejection.

```js
window.Platform = {
  isNative,   // boolean — true iff window.Capacitor reports a native platform
  os,         // 'web' | 'ios' | 'android'
  ready,      // Promise — ALWAYS present, never rejects. Resolves after native
              //   init + pref-mirror restore; resolves in the same microtask
              //   on web. Catalogue.boot() awaits it unconditionally.

  appVersion(),   // → Promise<string | null>   (App.getInfo; null on web)
  confirm({ title, message, okLabel, cancelLabel }),
                  // → Promise<boolean>. Dialog plugin; window.confirm fallback.
  haptic(kind),   // 'light' | 'medium' | 'success' | 'warning' → void. No-op on web.
  memoryClass(),  // → 'low' | 'mid' | 'high' — SYNCHRONOUS. Resolution order:
                  //   (1) pref platform.memoryClass when 'low'|'mid'|'high';
                  //   (2) Android: navigator.deviceMemory (≤2 low, ≥6 high);
                  //   (3) iOS: Device.getInfo() machine identifier through a
                  //       static generation table (resolved once during init);
                  //   (4) default 'mid'.
  tuning(),       // → { memoryWindow, cacheWindow, lookBehind, lookAhead,
                  //     maxLoadedChapters, chapterCacheMB, pageCacheMB }
                  //   — the PLAN.md §9 budget row for the current class
                  //   (a copy; consumers re-read at session start, not per frame).

  notify: {       // reminders-ready seam — permanently "off" this cycle; a
                  //   later @capacitor/local-notifications install lights it
                  //   up without any goals change.
    canNotify(),      // → false
    scheduleDaily(),  // → Promise<false>
    cancelDaily(),    // → Promise<void>
  },

  pickFiles({ accept, multiple }),
      // → Promise<PickedFile[] | null>;  PickedFile = { name, size, uri }
      //   null  = no native picker (web / plugin missing) → caller falls back
      //           to its hidden <input>.
      //   []    = the picker opened and the user cancelled (or it errored) —
      //           the caller does NOTHING. This is a deliberate refinement of
      //           the plan's null-only contract: falling back to the <input>
      //           here would open a second dialog on top of the one the user
      //           just dismissed.
      //   The picker copies into the app cache, so `uri` is directly readable;
      //   `name`/`size` are the ORIGINALS — file identity (§5) depends on them.
  readPickedFile(picked),
      // → Promise<File | null> — materializes a picked file into the webview
      //   (fetch(convertFileSrc) → blob → new File) with the ORIGINAL name
      //   stamped back on. For files that must be parsed in JS: EPUB/TXT, and
      //   CBZ only on the fallback path. Never called for large archives.

  zip: {   // backed by the committed native/or-zip plugin; null on web
    list(src),
      // src = { key } (archive under Data/archives/), { uri } (picked file),
      //   or { cachePath } — a RELATIVE path under the app cache dir (the
      //   pageUrl root), '..'-rejected in JS and resolved to an absolute
      //   container path before it reaches the plugin (whose own
      //   outside-container rejection still applies; no plugin API change).
      //   This is what lets a zip-of-CBZs extract its inner archives to
      //   Cache/pages/ and index them natively (§2.6).
      // → Promise<{ name, size }[] | null> — central-directory read only;
      //   zero entry bytes enter the webview.
    extract(src, entryNames, cacheDirKey),  // same three src forms
      // → Promise<string[] | null> — streams just those entries natively to
      //   Cache/pages/<cacheDirKey>/ and returns RELATIVE paths
      //   ('pages/<cacheDirKey>/<file>'), one per entry, in order. Never
      //   returns absolute URLs (see pageUrl).
  },
  pageUrl(relPath),
      // → string | null — SYNCHRONOUS. Converts a relative cache path to a
      //   webview-loadable URL for THIS session (convertFileSrc over a cache
      //   root resolved once at init). Session-local BY DESIGN: the iOS
      //   container path rotates on app update, so output is never persisted.
      //   Rejects paths containing a '..' segment.

  archives: {
    importFromUri(key, uri),  // → Promise<{ size } | null> — native MOVE
                              //   (rename; copy+delete fallback) of the picked
                              //   cache file to Data/archives/<key>. Zero bytes
                              //   in JS. THE archive-save path.
    save(key, blob),          // → Promise<{ size } | null> — bridge write for
                              //   SMALL source blobs only; refuses > 64 MB
                              //   (console.warn + null).
    read(key),                // → Promise<Blob | null> — same 64 MB guard;
                              //   missing file resolves null (the expected miss).
    remove(key),              // → Promise<void>
    releasePages(cacheDirKey),// → Promise<void> — delete one chapter's page dir
    prunePageCache(maxBytes), // → Promise<{ removedDirs, bytes }> — LRU by
                              //   leaf-dir mtime under Cache/pages/
    usage(),                  // → Promise<{ archiveBytes, pageCacheBytes } | null>
    migrateBlob(key, blob, onProgress),
                              // → Promise<{ size } | null> — DELEGATION
                              //   ADDENDUM (assignments.md, not in PLAN §6.1):
                              //   the manage-view "Move library to device
                              //   storage" writer. Chunked Filesystem
                              //   writeFile/appendFile in 8 MB slices,
                              //   idempotent per archive (destination with
                              //   matching size is skipped), onProgress(0..1)
                              //   after each slice. Native-only; null on web.
  },

  onAppUrlOpen(fn),           // register fn(url) for custom-scheme deep links
                              //   (offlinereader://add?url=…) via App
                              //   'appUrlOpen'. NOT the iOS share sheet.

  backup: {                   // eviction insurance for IndexedDB
    write(json),              // → Promise<boolean> —
                              //   Documents/backup/library-<date>.json, keep 3
    readLatest(),             // → Promise<string | null>
  },
}
```

Internal behaviors (not API, but contract):

- **Pref durability.** iOS can evict WKWebView localStorage; native
  Preferences survive. Mirrored keys: `or.prefs`, `or.prefs.series`,
  `or.library`, `or.gap`, `or.autoscroll` (**`or.timer` deliberately not** —
  resurrecting an expired countdown after an eviction would chime for a timer
  the user never saw survive). On `ready`, keys **missing** from localStorage
  are restored from the mirror — a key that exists locally always wins — then
  `Store.prefs.reload()` and guarded `window.reloadReaderPrefs()` run so the
  FIRST post-eviction launch is correct, not the second. Ongoing mirroring:
  the two pref blobs are copied on `or:prefs` (debounced 2 s); ALL mirrored
  keys are copied on `visibilitychange`→hidden and `pagehide`. Those copy
  listeners are registered inside `DOMContentLoaded` — deliberately AFTER
  reader.js's parse-time `visibilitychange` handler, so same-target FIFO
  dispatch lets reader.js save `or.library` first and the mirror snapshot a
  current value instead of being one save behind at kill time.
- **Hardware back** dispatch per the §2.2 unified table. **Status bar
  follows `app.theme`**: platform.js listens to `or:prefs` for `app.*`/null
  keys (debounced past settings.js's re-apply) and sets StatusBar style by
  the theme's luminance — dark set `dark`/`dim`/`black`/`nord`/`forest`,
  light set `light`/`cream`/`sepia`/`tan`; `custom` defers to the
  `data-applum` attribute settings.js stamps. Overlay mode on Android only
  (iOS relies on the existing `black-translucent` meta +
  `viewport-fit=cover`).
- **Back gestures posture (native iOS).**
  `allowsBackForwardNavigationGestures` stays at its WKWebView default —
  **off** — deliberately: readers are protected by construction and no
  screen animates against stale same-document snapshots, at the cost of no
  edge-swipe back anywhere in the native app (header affordances instead).
  `docs/mobile/NATIVE_BUILD.md`'s "Back gestures" appendix carries the full
  trade-off; the default is load-bearing, do not flip it casually.
- **No service-worker management.** platform.js never registers or
  unregisters SWs; reader.js gates its own registration on `isNative`.
- **Origin-gate contingency seam.** A CapacitorHttp-backed
  `window.proxyImageUrl` override ships as a commented, DISABLED branch in
  platform.js, to be enabled only if the on-device origin gate (remote images
  from the Capacitor origin) fails.

**`native/or-zip/`** is the ONLY committed native code in the repo: a local
Capacitor plugin (referenced as `"or-zip": "file:native/or-zip"`) exposing
exactly `list({path}) → {entries:[{name,size}]}` and
`extract({path, entryNames, destDir}) → {paths}` — iOS via ZIPFoundation,
Android via `java.util.zip.ZipFile`. It reads central directories only,
streams extraction natively, never returns entry bytes to JS, and **rejects
any entry that would resolve outside `destDir` (zip-slip) and any path
outside the app container**. The generated `ios/`/`android/` app projects
stay uncommitted (`docs/mobile/NATIVE_BUILD.md` rebuilds them).

### 2.4 `window.Goals` — goals & timers (optional module)

`js/goals.js` + `css/goals.css`. The engine **observes** the app rather than
invading it: reading time comes from watching `body[data-screen]` +
visibility (active = `reader-screen` or `novel-screen` while visible, with an
idle cutoff), metric folds come from the `or:progress` and
`or:upload-progress` events (§2.5), and nothing in reader.js,
novel-reader.js or catalogue.js is ever called for tracking.

```js
window.Goals = {
  openScreen(),          // record the return screen, showScreen('goals-screen')
  close(),               // return via Catalogue.goBack() (the importer precedent)
  startTimer(minutes),   // begin/replace the wall-clock countdown.
                         //   minutes optional → pref goals.timer.minutes.
                         //   NOTE: the argument is only sanity-bounded
                         //   (0 < m ≤ 1440) — app-internal callers may pass
                         //   short test countdowns; the PREF path is what is
                         //   validated to 5..180.
  stopTimer(),
  state(),               // read-only diagnostics:
                         //   { today, streak, timer, session } — today is the
                         //   current DayLog snapshot (or null), timer carries
                         //   { deadline, minutes, remainingMs } or null.
}
```

Contract points:

- **Single writer of `dayLogs`** (§3): goals reads, merges its own arrays in
  memory, and hands `Store.putDayLog` a complete patch.
- **Single writer of `goals.lifetime`** (§3.1) — the all-time ledger, same
  single-writer discipline as dayLogs. Every fold delta goals already
  computes (session seconds, fractional `pctDelta × wc` words, page deltas,
  upload deltas, chapter completions, book finishes) is additionally
  accumulated in memory and persisted at the `persistDay` cadence. Seeded
  **once** from dayLogs when the pref is absent or malformed (a re-seed is a
  floor, not an exact replay — dayLogs suppress same-period re-finish rows);
  a pref that parses clean — **including with fractional numbers** — is
  never re-seeded. **Survives `clearDayLogs`** ("Reset goal history" keeps
  it; a separate "Reset lifetime totals" action zeroes it and sets `since`
  to today). Books semantics: one increment per book per **local day**
  (goals' own per-day dedup set, cleared on rollover) — deliberately
  decoupled from the mutable goal-period dedupe, so a later-day re-finish
  inside one period is lifetime +1 while the period stat stays flat.
  `Goals.state()` exposes a `lifetime` snapshot copy.
- **Folding rules** (the edge cases are the spec — PLAN.md §5.1): per-series
  baseline resets on chapterId change (fold nothing positional for that
  event); deltas clamp at zero; `words += pctDelta × wordCount` only for a
  positive finite wordCount; `chaptersCompleted` on `completed` flipping
  false→true per chapterId per day; **book finished = `row.completed` AND
  `row.chapterId` equals the series' LAST chapter's id** (via
  `Catalogue.getSeries`, guarded; `chapterNum === chapterCount` only as a
  last resort — never `num` arithmetic alone, decimal finales are legal);
  `booksFinished` deduped across the whole books period. Uploads fold from
  `or:upload-progress` under the identity `'upload:' + libraryKey`.
- **Countdown timer** is wall-clock-based: `{ deadline, minutes }` mirrored
  to localStorage `or.timer` (silent-catch; never in the native mirror). The
  1 Hz tick renders `deadline − Date.now()`; a deadline that passed while
  hidden chimes ONCE on resume; cold boot resumes a future deadline and
  silently discards a past one.
- **Mount points**: catalogue's `ensureDom` builds an EMPTY
  `<div id="goals-home-slot">` as a home-registry section (`goals` — pref
  order per §2.11; default: between the Continue rail and Latest updates),
  and a toolbar "Goals" button rendered only when `window.Goals` exists. The
  slot's CONTENTS are goals-owned; catalogue never populates it. The floating
  in-reader pill is solid (no backdrop-filter), appended to `document.body`,
  and docked bottom-RIGHT — bottom-center belongs to the autoscroll bar.
- Per-series exclusion via pref `goals.include` (§3.1), read at fold time;
  an excluded series skips events AND session time.
- Reminder rows render only when `Platform.notify.canNotify()` (never, this
  cycle).

### 2.5 Events registry

Window `CustomEvent`s are the only cross-module signaling besides direct
calls. **Every dispatch is wrapped in try/catch** (a throwing listener must
never fail the write it watched) and **every listener must tolerate the
dispatcher being absent** — these events are broadcast, not RPC.

| event | dispatched by | `detail` |
| --- | --- | --- |
| `or:prefs` | `Store.prefs` (every write, `reload()`, cross-tab storage) | `{ key, value, seriesId }` — a `null` key means "anything may have changed, re-read what you care about" |
| `or:library-changed` | importer.js after commit / delete / bulk import | `{ id }` \| `{ imported }` \| `{ deleted }` |
| `or:progress` | `Store.putProgress` after every successful merge | `{ seriesId, patch, row }` — `row` is the merged Progress |
| `or:goals-changed` | goals.js after any dayLog write or goal-pref change | none |
| `or:upload-progress` | reader.js `saveToLibrary()`, **upload sessions only** (`window.readerOrigin === 'upload'` — online image sessions also pass through `saveToLibrary` but already reach goals via `or:progress`; dispatching for them would double-count every page) | `{ libraryKey, pagesDelta, chaptersDelta, completed }` — deltas against the previous entry's high-water marks, ≥ 0 by construction |
| `or:thoughts-changed` | thoughts.js after any put/delete | `{ id }` \| `{ deleted: id }` |

Theme, focus, home-layout and preset changes all ride the existing
`or:prefs` event; sources rides `or:prefs` (`sources.saved`) and
`or:library-changed`. Note that `or:prefs` now also fires at `persistDay`
cadence for `goals.lifetime` — listeners doing expensive work on it must
key-gate (settings re-applies the theme only for `app.*`/null keys; goals
itself short-circuits `goals.lifetime` to a cheap adopt).

### 2.6 reader.js — image reader amendments

reader.js keeps its historical shape (classic script, NO IIFE, NO
`'use strict'`; its file-scope globals are the API catalogue.js pokes) — the
mobile refactor only added seams:

- **SW registration is gated**: registered only when
  `!(window.Platform && window.Platform.isNative)`.
- **`window.reloadReaderPrefs()`** — re-reads `or.gap` and `or.autoscroll`
  and re-runs `initLibraryList()`. Called (guarded) by platform.js after an
  eviction restore; without it the first post-eviction launch would show
  defaults and an empty library because reader.js consumed those keys at
  parse time.
- **Device-classed windows**: `MEMORY_WINDOW` / `CACHE_WINDOW` /
  `LOOK_BEHIND` / `LOOK_AHEAD` are `let`s seeded with the historical mid
  values and re-read from `Platform.tuning()` at session start. Scroll-mode
  ("∞") windowing: above 800 total pages only chapters within ±2 of current
  render; the rest collapse to fixed-height spacer divs with scrollTop
  compensation.
- **`loadArchives(files)`** is the named upload entry point (the former
  anonymous `#file-input` handler; the input's change handler is now a thin
  shim over it). Upload buttons try
  `Platform.pickFiles({accept: '.cbz,.zip', multiple: true})` first, hidden
  `<input>` fallback.
- **Path-dependent `SIZE_CAP`**: 600 MB for ANY plain-File path on every
  platform (those materialize ArrayBuffers); 2 GB only for sets that arrived
  as `pickFiles` URIs (indexed via `Platform.zip.list`, pages extracted
  per-chapter natively — zero archive bytes in JS, so the cap bounds disk,
  not heap).
- **`or.library` manifest**: native uploads store `{name, size, key}` per
  archive in the entry so "Resume" reopens from disk without re-picking. MRU
  cap 10 on native, 5 on web; a row falling off the list deletes its archive
  files.
- **`window.proxyImageUrl`** exempts `https://localhost/_capacitor_file_/…`
  (Android serves extracted local pages under that origin — a local file that
  only dresses like a remote URL must not be routed through the gateway).
- **Nested zip-of-CBZs on native use zero JS archive bytes** (PLAN.md §13
  deviation 7 closed): a picked outer zip's inner archives are extracted
  natively to `Cache/pages/import-inner/…` and indexed via
  `Platform.zip.list({ cachePath })` (§2.3) — the 600 MB-blob fallback path
  for nested zips is gone. The unified pipeline also moves nested sets into
  `Data/archives/` and writes a resume manifest, so nested sets are now
  resumable (previously they never reached the manifest phase). Web behavior
  unchanged (`cachePath` resolves null on web).
- **`#reader-screen` is pinned dark** (`#0a0a0a` literals, plus a
  higher-specificity `body[data-screen='reader-screen']` background so iOS
  rubber-banding cannot reveal a light themed body) — a light app theme
  (§2.10) never bleaches the comic surround. Reading surfaces are
  reader-themed; the shell is app-themed.

### 2.7 `window.Covers` — generated default covers

`js/covers.js` (owned by the catalogue agent). IIFE, no screen, no CSS file:

```js
window.Covers = {
  element(seriesOrId, opts),  // → SVGSVGElement — a complete generated cover.
                              //   opts: { className } applied to the root svg.
                              //   Accepts a Series or a bare id string.
  designIndex(id),            // → 0..6 (exposed for tests/determinism checks)
}
```

Seven designs in the diamond-logo family (sapling, orchard row, conifer,
fern, seed & sprout, grove at night, the reader silhouette — the last, in
indigo/amber, is also the hand-committed tutorial-book cover).
**Deterministic**: FNV-1a over the series id → `design = h % 7`,
`hue = ((h >>> 3) % 12) * 30`; a series keeps its cover forever. **No text
inside the SVG** and zero content-string interpolation — `createElementNS`
with numeric/enum attributes only; trivially XSS-safe, works offline, ~1–2 KB
of DOM per card. **The palette is self-contained and theme-independent by
design**: a generated cover is content artwork, like a real cover image —
real covers do not repaint when the shell theme changes, and neither do
generated ones.

Adoption (each consumer guards `window.Covers`, falling back to the gradient
placeholder, which stays in the code): catalogue's `placeholder()`,
`spineFallback()`, `heroPlaceholder()` and rail `onerror` handlers
(`cat-cover-svg`); importer's confirm-view cover fallback (`imp-cover-svg`);
sources' browse-card `onerror`. The image-reader upload library rows are
deliberately not adopted (no series id).

### 2.8 `window.Thoughts` — depart your thoughts (optional module)

`js/thoughts.js` + `css/thoughts.css` (`tho-`), screen `thoughts-screen`.
Not "notes" — the UI says "Depart your thoughts" / "Leave a thought".

```js
window.Thoughts = {
  openScreen(),   // the reading surface (record return screen, showScreen)
  close(),        // Catalogue.goBack() (importer precedent)
  open({ seriesId, seriesTitle, chapterId, chapterTitle, kind }),
                  // open the composer sheet prefilled; kind: 'book' | 'chapter'
}
```

- **Cadence**: always offered at book end; per-chapter prompting exists but
  is off by default behind `thoughts.chapterPrompt` (§3.1; the toggle lives
  on thoughts-screen).
- **Book-end triggers, two surfaces**: (1) the novel reader appends a
  guarded `.nv-thoughts-cta` button after `.nv-end` on the last chapter
  (`--nv-*` tokens only, appended AFTER the block list — anchor indices are
  sacred; a smaller variant follows non-final chapter navs when the chapter
  toggle is on). Note `.nv-end` and this CTA render in `chapter`/`infinite`
  modes — the default `paged` mode currently has no book-end marker
  (recorded plan-level gap, PLAN7 completion log). (2) thoughts.js listens
  to `or:progress` for a `completed` flip on the series' last chapter and —
  only when `document.body.dataset.screen === 'reader-screen'` **exactly**
  (novel completion also rides `or:progress`; a looser test would stack the
  chip on the novel surface's own CTA) — shows a floating "Depart your
  thoughts" chip docked bottom-LEFT (solid, no blur; the autoscroll bar owns
  bottom-center, the goals pill bottom-right), auto-dismissing on screen
  change or after 12 s, deduped per series per session, created lazily.
- **Composer**: house bottom sheet, one textarea (maxlength 4000),
  Save/Discard; saving writes `Store.putThought` and dispatches
  `or:thoughts-changed`; a **tappable** toast ("Kept. Tap to read your
  thoughts.", rendered as a `<button>`) opens the reading surface — the
  settings-free entrance, so saved thoughts stay reachable with settings.js
  deleted.
- **Reading surface**: thoughts newest-first grouped by series, each row
  date + kind chip + text (`textContent`, `pre-wrap`), Edit/Delete, chunked
  at 100 rows. A thought's text is the reader's own writing and is
  **third-party at render time** (§7.1).
- Thoughts ride the importer backup (§5) and are storage-contracted in §3.

### 2.9 `window.Sources` — saved sources & browse (optional module)

`js/sources.js` + `css/sources.css` (`src-`), screen `sources-screen`.

```js
window.Sources = {
  openScreen(),   // record return screen, showScreen('sources-screen')
  close(),        // Catalogue.goBack()
}
```

- **Saved sources** live in pref `sources.saved` (§3.1) — bookmarks with
  superpowers; saving never hits the network. The cap (24) **refuses, never
  evicts** (toast on the 25th). URL normalization is **shared, not
  twinned**: sources calls the public `Importer.normalizeUrl` (§5), guarded;
  with Importer absent a minimal local fallback (http(s) check + lowercase
  host + strip hash/credentials) serves save-and-bookmark mode only — it
  deliberately does NOT strip tracking params or sort/trim like the real
  one, and browse/badges are off without Importer anyway, so dedupe merely
  degrades.
- **Home shelf**: catalogue's `ensureDom` builds an EMPTY
  `<div id="sources-home-slot">` (the goals-slot pattern — the slot is a
  fixture, contents are sources-owned). sources.js fills it from its own
  `data-screen` MutationObserver (fill on entering `home-screen` — the
  guaranteed first fill, since catalogue's boot ends in
  `showScreen('home-screen')` after `ensureDom`), plus re-render on
  `or:prefs` (`sources.saved`/null) and `or:library-changed`. Module absent
  → slot stays empty (invisible).
- **Browse**: a source card runs `GET /list` (§6.6); results render as a
  card grid — covers via the `/image` proxy with sources' own local
  `safeImageUrl`/`imgUrl` twins (§7.6 keep-in-sync list), `Covers.element`
  fallback; tapping an item deep-links `Importer.openDialog({ url })`; items
  already in the library (compared via `Importer.normalizeUrl` against
  stored `sourceUrl`s — never re-implemented id hashing) badge "In library"
  and open via `Catalogue.openSeries`. `nextUrl` renders a "More" row.
- **Capability + failure honesty**: first use per session probes `/health`
  and caches `canList`; `not_found`/probe failure flips it off. When listing
  is unavailable (422 `no_adapter`, `list_failed`, `canList` false) the
  browse view shows the honest card ("Open the site … use Add by link") with
  `safeHttpUrl`-checked "Open site" + "Add by link" buttons. **Gateway off**:
  the empty shelf renders nothing; saved sources render as plain
  external-link cards behind the muted gateway-off explainer naming
  `OR_CONFIG.workerBase`. Nothing pretends to work.

### 2.10 `window.AppSettings` — settings, app themes, focus (optional module)

`js/settings.js` + `css/settings.css` (`set-`), screen `settings-screen`.

```js
window.AppSettings = {
  openScreen(), close(),
  maybeOfferFocus(),   // the one-time focus sheet; catalogue calls it guarded
                       //   once, after the first successful renderHome()
}
```

**The app-wide theme engine.** The shell (home, series, upload, importer,
goals, settings, sources, thoughts screens) is themed with the novel
reader's own model, and the image reader stays pinned dark (§2.6).

**`app.theme` is the baseline; `novel.theme` is the override (binding).**
The two are no longer independent:

- **Asked once, up front.** The first-run focus sheet (§2.1) carries a
  second question — the nine **named** palettes as a swatch grid, writing
  `app.theme` on tap and repainting live through the ordinary
  `Store.prefs.on` path, so the choice shows its own result. `custom` is
  deliberately absent there: two colour pickers do not belong in the first
  thirty seconds. It stays in Settings.
- **The reader inherits it.** `readPrefs` defaults `theme` to `app.theme`
  (and `customBg`/`customFg` to `app.customBg`/`app.customFg`), so a reader
  who chose sepia opens their first book in sepia. A series with its own
  stored `novel.theme` still wins — inheritance is the DEFAULT, never an
  override, which is what keeps per-book looks working.
- **`novel.themeScope` decides where a pick lands.** `app` (default) writes
  the per-series theme *and* pushes `app.theme`, re-theming the shell;
  `series` writes the per-series theme only, leaving the shell alone. The
  scope is global, not per-series — it describes how the picker behaves,
  not how one book looks. Switching *to* `app` also pushes the book's
  current theme immediately, since asking to match is itself the request.
  Custom colours follow the same scope, and carry `app.theme: custom` with
  them (a colour the shell is not wearing would be ignored).
- The scope control renders under the swatch grid with a line of prose,
  because a reader has no way to guess a per-book look is on offer.

- At **parse time** settings.js reads `app.theme` (+ custom colors) via
  `Store.prefs`, sets `document.documentElement.dataset.apptheme` and, for
  `custom`, inline `--bg`/`--text` + `data-applum` (luminance rule copied
  from the novel custom theme) — the first paint is already themed, no dark
  flash. It also updates `<meta name="theme-color">` to the theme's bg at
  apply time (only when the applied theme actually changed);
  `manifest.json` colors stay `#0a0a0a` (splash is boot-time; accepted).
- Live re-apply subscribes `Store.prefs.on`, **key-gated** to `app.*`/null
  keys only (`or:prefs` also fires at `goals.lifetime` flush cadence —
  re-theming must not ride every goals flush).
- `css/settings.css` defines, under `html[data-apptheme]` (any value), the
  **derived layer**: `--muted` (58% text/bg `color-mix`), `--surf-1`/
  `--surf`/`--surf-2` (4/8/13% text over transparent), `--border`/
  `--border-soft` (14/8%) — the app-wide equivalent of the novel
  custom-theme derivation. Per named theme it defines the base triple +
  semantic anchors: `--bg`, `--text`, `--accent`, `--accent-ink`, `--prose`
  (the amber family's anchor), `--ok`, `--warn`, `--danger`. The **nine**
  named palettes reuse the novel themes' bg/fg/accent values — `dark`,
  `dim`, `black`, `light`, `cream`, `sepia`, `tan`, `nord`, `forest` — and
  the light themes darken the semantic anchors for contrast; `--prose` is
  always a different color than `--accent` (the amber/indigo split never
  collapses). `custom` supplies only `--bg`/`--text` from JS; accent by
  `data-applum`.
- **Module token re-pointing**: every shell sheet re-points its hard-coded
  white-alpha/status literals at the derived tokens **with the current
  literal as the fallback** — `--cat-surf-1: var(--surf-1,
  rgba(255,255,255,0.04))` and so on across catalogue.css, importer.css,
  goals.css, styles.css; the new sheets consume the tokens from birth.
  Deliberate exceptions, pinned to dark literals: floating chrome that sits
  on fixed dark capsules over reader surfaces (goals pill/toast, importer
  restore toast, thoughts chip) and reader notice banners — following a
  light theme's ink there would be illegible or would repaint the pinned
  reader.
- **No attribute set → today's app**: `styles.css`'s `:root` block remains
  the dark default; the derived layer exists only under `[data-apptheme]`.
  settings.js absent → attribute never set → permanent dark. (Note: an
  *explicitly applied* `dark` theme stamps the attribute and renders the
  novel dark triple — text `#e9e9ec` — rather than styles.css's `#f0f0f0`
  literal; the byte-for-byte-today path is the unset/absent case.)
- UI: "App theme" swatch grid (all nine named swatches + custom + two color
  inputs when custom), the 3-way Focus segmented control, the home-layout
  editor (§2.11), and a guarded "Your thoughts" entry row.

**The focus sheet.** `maybeOfferFocus()` shows a bottom sheet once when
`app.focus` is unset — Books / Comics / Both cards plus a "Start with the
tour" button that opens the tutorial book (rendered only when
`Catalogue.getSeries('fixture:welcome')` returns a row; it settles the pref
to `both` before opening, since every exit writes). Dismissing writes
`both` — it never re-prompts. Never offered when boot lands on
`upload-screen`.

**The home-layout editor** writes `home.sections` (§3.1): one row per
section with visibility pill + ▲/▼ move buttons; the All Series row shows
move buttons but no toggle ("always shown"); absent-module sections still
list with "(not installed)"; "Reset to default" **clears** the pref (writes
the key away) so the focus-derived default applies again.

### 2.11 Catalogue amendments — home registry, focus defaults, boot hook

- **Home section registry.** `ensureDom` builds home as a fixed frame
  (`#home-state` → `#cat-tabs`) plus five registry sections in pref order:
  `continue` (`#cat-continue-section`), `goals` (`#goals-home-slot`),
  `sources` (`#sources-home-slot`), `latest` (`#latest-section` — the one
  index.html-native section: *moved* into position, never rebuilt), and
  `series` (`#series-section` — REORDERABLE, never hideable; its internals
  are a sealed unit). The tabs bar stays fixed above everything because it
  filters the whole home, not just the grid. Order/visibility come from
  `home.sections` read through a validating getter (§3.1); `on: false` sets
  `display: none` and short-circuits the section's render work. Live
  reorder: on `or:prefs` `home.sections`/null, re-append the five singleton
  elements in the new order and `renderHome()`. Settings.js mirrors the
  same validation in its editor — the two implementations are a named
  keep-in-lock-step pair.
- **Focus-derived defaults** (`app.focus`, read by catalogue directly — no
  settings.js dependency; focus shapes *defaults while the reader has not
  chosen*, an explicit choice persists and focus never overrides it):
  1. `currentTab()`'s fallback while `catalogue.tab` is unset: `books` →
     `lightnovel`, `comics` → `manga`, `both` → `all`.
  2. `home.sections` default while unset: `comics` promotes Latest to
     directly under Continue; `books`/`both` keep today's order.
  3. Card-style bias **for untyped series only**: under `books` focus a
     series whose declared type was not recognized renders as a spine
     (`novelCard`) instead of the manga-card default. Because `inferType`
     canonicalizes every series, `normalizeSeries` carries an in-memory
     `untyped` flag (never persisted) capturing the raw fact. Typed series
     never change style under any focus.
  4. Empty-state copy: comics-flavored on `manga`/`manhwa` tabs,
     books-flavored (EPUB import + tutorial) on `lightnovel`/`library`,
     with guarded buttons to `Sources.openScreen()`/`Importer.openDialog()`.
- **Boot hook**: exactly once, after the first successful `renderHome()`,
  catalogue calls `AppSettings.maybeOfferFocus()` guarded. Never on
  `upload-screen` boots.
- **Toolbar**: a Settings button rendered only when `window.AppSettings`
  exists (the Goals-button pattern).

---

## 3. `window.Store` — persistence API

Backed by IndexedDB (`offline-reader` database, **`DB_VERSION` 3** — v2
added the `dayLogs` store, v3 adds the `thoughts` store (`keyPath: 'id'`,
index `seriesId`); the upgrade handler only creates what is missing) with
an in-memory fallback if IndexedDB is unavailable (private browsing, some iOS
webviews). **The fallback implements every method here** — including the
dayLog and thought methods — as session-scoped Map tables. Every method
returns a Promise and **never rejects for expected conditions** — missing
rows resolve to `null` / `[]`. Only programmer errors throw.

```js
// ── Imported series ("My Library") ────────────────────────────────────────
await Store.listUserSeries()               // → Series[]  (newest addedAt first)
await Store.getUserSeries(id)              // → Series | null
await Store.putUserSeries(series)          // upsert; stamps addedAt/updatedAt; → Series
await Store.deleteUserSeries(id)           // also deletes its cached chapters + progress

// ── Cached chapter content ────────────────────────────────────────────────
await Store.getChapter(seriesId, chapterId)      // → ChapterFile | null
await Store.putChapter(seriesId, chapterId, file)// → ChapterFile; stamps cachedAt (ISO)
                                                 //   + sizeEstimate (JSON string length,
                                                 //   computed once at write)
await Store.deleteChapter(seriesId, chapterId)
await Store.listCachedChapterIds(seriesId)       // → string[]
await Store.clearChapters(seriesId)              // omit seriesId to clear all
await Store.pruneChapterCache({ maxBytes, protectSeriesIds })
                                                 // → { removed, bytes } — see below
await Store.estimateUsage()                      // → { usage, quota } bytes (may be nulls);
                                                 //   folds in Platform.archives.usage()
                                                 //   when native

// ── Reading progress (one row per series) ─────────────────────────────────
await Store.getProgress(seriesId)          // → Progress | null
await Store.putProgress(seriesId, patch)   // shallow-merges patch, stamps updatedAt;
                                           //   dispatches 'or:progress' (§2.5) after
                                           //   a successful merge, in try/catch
await Store.listProgress({ limit })        // → Progress[] desc by updatedAt — "Continue reading"
await Store.deleteProgress(seriesId)

// ── Day logs (goals — one row per local calendar day) ─────────────────────
await Store.getDayLog(day)                 // → DayLog | null   (day = "YYYY-MM-DD")
await Store.putDayLog(day, patch)          // shallow-merge, stamps updatedAt; → DayLog
await Store.listDayLogs({ since, until, limit })
                                           // → DayLog[] desc by day; bounds inclusive
await Store.clearDayLogs()                 // wipe (goals "reset history")

// ── Thoughts (the reader's own reflections — see §2.8) ────────────────────
await Store.listThoughts({ seriesId, limit })
                                           // → Thought[] desc by createdAt.
                                           //   Both filters optional; {} lists all.
await Store.putThought(thought)            // → Thought. Stamps id ('t-' +
                                           //   Date.now().toString(36) + '-' + 4 rand
                                           //   chars) when absent, createdAt when
                                           //   absent, updatedAt always. Upsert by id.
await Store.deleteThought(id)              // → resolves undefined; missing id is a no-op

// ── Preferences (synchronous, localStorage-backed) ────────────────────────
Store.prefs.get(key, fallback)
Store.prefs.set(key, value)                // fires 'or:prefs' CustomEvent {key, value}
Store.prefs.all()                          // → plain object
Store.prefs.getFor(seriesId, key, fallback)// per-series override, falls back to global
Store.prefs.setFor(seriesId, key, value)
Store.prefs.clearFor(seriesId)
Store.prefs.on(fn)                         // fn({key, value, seriesId}) → unsubscribe fn
Store.prefs.reload()                       // re-read both pref blobs from localStorage
                                           //   into the module snapshots and emit
                                           //   {key:null, value:null, seriesId:null} —
                                           //   the platform mirror-restore hook.
                                           //   Synchronous, like everything here.

// ── Blobs (uploaded EPUB/CBZ kept for re-open) ────────────────────────────
await Store.putBlob(key, blob)             // putBlob(key, blob) argument order and
                                           //   out-of-line-key semantics are contract
await Store.getBlob(key)                   // → Blob | null
await Store.deleteBlob(key)
```

**`pruneChapterCache`** deletes cached chapters oldest-`cachedAt`-first until
under `maxBytes`, never touching `protectSeriesIds` (imported series'
chapters are primary data, not cache). Legacy rows without `sizeEstimate` are
stamped during the prune cursor pass, capped at **50 rewrites per call**; an
unstamped row counts 0 bytes and is **never deleted** — nothing leaves that
was never weighed. An absent or nonsense `maxBytes` prunes nothing. Callers
convert MB caps to bytes (`Platform.tuning().chapterCacheMB × 1024²` — the
catalogue's `runCachePrune` is the single call site and owns that
conversion). Prune triggers (catalogue-owned): once per boot deferred to
idle, after every 25 resolver `putChapter`s debounced 10 s, and after
`downloadRange` batches.

**Blobs under Capacitor.** When `Platform.isNative`, `putBlob` delegates
blobs ≤ 64 MB to `Platform.archives.save` (the filesystem survives WebKit
storage pressure; IndexedDB may not); `getBlob` checks the filesystem first,
then IndexedDB, so web-era rows keep working; `deleteBlob` removes from both
backends. There is deliberately **no boot-time bulk migration** — pushing a
web-era 300 MB archive through the bridge as base64 is the OOM this design
avoids; the importer's manage view offers a chunked, user-initiated "Move
library to device storage" instead (`Platform.archives.migrateBlob`, §2.3).
Large CBZ archives never pass through blob methods on native at all — they
arrive as files via `Platform.archives.importFromUri`. IndexedDB remains the
web backend; API shape and promise semantics are unchanged.

`DayLog` (single writer: js/goals.js — it read-modify-writes and merges its
own arrays; the store just replaces fields):

```jsonc
{
  "day": "2026-08-10",            // local-date key YYYY-MM-DD
  "seconds": 1260,                 // active reading time
  "words": 5400,                   // text: clamped pct-delta × chapter wordCount
  "pages": 34,                     // image: clamped pageIdx advances
  "chaptersCompleted": 2,
  "booksFinished": ["user:ab12"],  // seriesIds (or "upload:<key>"), deduped
  "seriesTouched": ["gutenberg:84"],
  "updatedAt": "2026-08-10T12:00:00.000Z"
}
```

`Progress`:

```jsonc
{
  "seriesId":   "user:ab12…",
  "seriesTitle": "…",           // denormalized so "Continue reading" needs one read
  "seriesType": "lightnovel",
  "cover":      "https://…",
  "chapterId":  "c-0012",
  "chapterNum": 12,
  "chapterTitle": "…",
  "chapterCount": 240,
  "pageIdx":    3,              // image reader: page index within the chapter
  "pageCount":  18,
  "blockIdx":   42,             // novel reader: index of the topmost visible block
  "charOffset": 1180,           // novel reader: approx characters into the chapter
  "pct":        0.63,           // 0..1 progress within the chapter
  "completed":  false,
  "updatedAt":  "2026-08-07T…"
}
```

Progress keys are `series.id`. Imported series get ids of the form
`user:<sha1-ish hash of sourceUrl>` so re-importing the same URL resumes.

`Thought` (single writer: js/thoughts.js):

```jsonc
{
  "id": "t-…",                 // REQUIRED once stored
  "seriesId": "user:ab12…",    // REQUIRED
  "seriesTitle": "…",          // denormalized — thoughts outlive series deletion
  "chapterId": "c-0009",       // string | null (null = book-level)
  "chapterTitle": null,        // string | null
  "kind": "book",              // "book" | "chapter"
  "text": "…",                 // the reader's words — third-party at render time
  "createdAt": "2026-08-10T…",
  "updatedAt": "2026-08-10T…"
}
```

**`Store.deleteUserSeries` does NOT cascade to thoughts** — a thought is the
reader's writing, not series data; `seriesTitle` is denormalized so it still
renders after the series is gone. A deliberate non-cascade.

### 3.1 Preference keys (global unless noted)

| key                   | values                                        | used by      |
| --------------------- | --------------------------------------------- | ------------ |
| `novel.mode`          | `paged` \| `chapter` \| `infinite`             | novel-reader |
| `novel.fontFamily`    | `serif` \| `sans` \| `mono` \| `literata` \| `atkinson` \| `dyslexic` | novel-reader |
| `novel.fontSize`      | px number, 14–32                               | novel-reader |
| `novel.lineHeight`    | number, 1.3–2.2                                | novel-reader |
| `novel.width`         | `narrow` \| `normal` \| `wide` \| `full`       | novel-reader |
| `novel.align`         | `left` \| `justify`                            | novel-reader |
| `novel.theme`         | `dark` \| `dim` \| `black` \| `light` \| `cream` \| `sepia` \| `tan` \| `nord` \| `forest` \| `custom`. **Defaults to `app.theme`** (§2.10) rather than a fixed value — unset means "wear what the shell wears"; a stored per-series value still wins | novel-reader |
| `novel.themeScope`    | `app` \| `series` (default `app`). **Global, never per-series.** `app` = a theme picked in the reader also writes `app.theme`; `series` = the pick stays with that book. Switching to `app` pushes the book's current theme out at once | novel-reader |
| `novel.paraSpacing`   | `tight` \| `normal` \| `loose`                 | novel-reader |
| `novel.indent`        | boolean                                        | novel-reader |
| `novel.letterSpacing` | em number, 0–0.24                              | novel-reader |
| `novel.wordSpacing`   | em number, 0–0.8                               | novel-reader |
| `novel.customBg`      | `#rrggbb` — only read when theme is `custom`   | novel-reader |
| `novel.customFg`      | `#rrggbb` — only read when theme is `custom`   | novel-reader |
| `catalogue.tab`       | `all` \| `manga` \| `manhwa` \| `lightnovel` \| `library` | catalogue |
| `catalogue.layout`    | `grid` \| `list`                               | catalogue    |
| `platform.memoryClass` | `auto` \| `low` \| `mid` \| `high` (default `auto`; UI: importer manage view "Performance" row) | platform |
| `goals.enabled`       | boolean (default `true`) — master switch       | goals        |
| `goals.timeTarget`    | int minutes, `0` or `5..480` (default `20`; 0 = off) | goals  |
| `goals.schedule`      | `everyday` \| `weekdays` \| `custom` (default `everyday`) | goals |
| `goals.scheduleDays`  | string `/^[01]{7}$/`, Mon..Sun (default `1111111`; read when schedule=`custom`) | goals |
| `goals.booksTarget`   | int `0..999` (default `0`; 0 = off)            | goals        |
| `goals.booksPeriod`   | `month` \| `year` (default `month`)            | goals        |
| `goals.chaptersTarget` | int `0..999` (default `0`; 0 = off)           | goals        |
| `goals.chaptersPeriod` | `day` \| `week` (default `week`)              | goals        |
| `goals.streakRule`    | `target` \| `any` (default `target`)           | goals        |
| `goals.timer.minutes` | int `5..180` (default `20`)                    | goals        |
| `goals.timer.autostart` | boolean (default `false`)                    | goals        |
| `goals.timer.chime`   | boolean (default `true`)                       | goals        |
| `goals.pill`          | `auto` \| `off` (default **`off`**). `auto` means **with the reader's chrome**, not "always up": the pill shows only while the host reader is showing its own header (`#novel-screen` without `nv-chrome-hidden`, or `#reader-header` without `ui-hidden`), watched with a `MutationObserver` so a tap lands in the same frame. A missing chrome node reads as "no chrome" and keeps the pill down | goals |
| `goals.idleCutoff`    | int minutes `1..30` (default `5`)              | goals        |
| `goals.reminder.enabled` | boolean (default `false`; UI only when `Platform.notify.canNotify()`) | goals |
| `goals.reminder.time` | string `/^([01]\d\|2[0-3]):[0-5]\d$/` (default `20:00`) | goals |
| `app.focus` | `books` \| `comics` \| `both` (default `both`; unset = never chosen → the focus sheet offers once) | settings writes; catalogue reads |
| `app.theme` | `dark` \| `dim` \| `black` \| `light` \| `cream` \| `sepia` \| `tan` \| `nord` \| `forest` \| `custom` (default `dark`) | settings writes+applies; platform reads (status bar) |
| `app.customBg` / `app.customFg` | `#rrggbb` (`/^#[0-9a-fA-F]{6}$/`; defaults `#0a0a0a` / `#f0f0f0`) | settings |
| `home.sections` | JSON array of `{id, on}` over ids `continue`, `goals`, `sources`, `latest`, `series` (order = render order; unknown/duplicate ids dropped on read, missing ids inserted at their default position, missing `on` leans visible (`e.on !== false`); **`series` is reorderable but never hideable — its `on` is coerced `true` on read**). Unset → **focus-derived** default (§2.11); once written, the stored array wins and focus never touches it again | settings writes; catalogue reads |
| `novel.presets` | JSON array ≤ 6 of `{ name: string ≤ 40, prefs: object of novel.* values }` (each value re-validated through the `readPrefs` validators at apply time; invalid entries dropped on read; **cap 6 refuses, never evicts**) | novel-reader |
| `thoughts.chapterPrompt` | boolean (default `false`) | thoughts writes; novel-reader reads (guarded) |
| `goals.lifetime` | JSON `{ seconds, words, pages, chapters, books: finite Numbers ≥ 0, since: "YYYY-MM-DD" }`. **Fractions are valid** — `words` accumulates and persists as a float; rounding happens only at display; a pref that parses with non-integer numbers is VALID and must never re-seed. Malformed = missing key, non-finite/negative number, wrong type, or bad `since` — only then re-seed from dayLogs (unknown extra keys ignored, never malformed) | goals only (single writer, §2.4) |
| `sources.saved` | JSON array ≤ 24 of `{ url: http(s), title ≤ 80, host, addedAt: ISO }`; invalid entries dropped on read. **Cap 24 refuses, never evicts** — the 25th save gets the "Shelf is full" toast | sources |

All ride the existing `or.prefs` blob, so they are natively mirrored for
free (§2.3) — deliberate for `goals.lifetime` and `sources.saved` (goals
live-adopts a valid mirror-restored ledger on `goals.lifetime`/null-key
events rather than clobbering it on the next flush).

Per-series overrides use the same keys via `prefs.getFor(seriesId, key)`.
The per-series key `goals.include` (boolean, default `true`) excludes a
series from all goal counting — read at fold time; only an explicit `false`
excludes. Every `goals.*` key is validated on read like `novel.*`; streak
semantics: `goals.schedule`/`scheduleDays` define which days can BREAK a
streak (off-schedule days are skipped, never breaking) — there is no
grace/forgiveness rule.

`novel.customBg` / `novel.customFg` reach a CSS custom property, so they are
validated against `/^#[0-9a-fA-F]{6}$/` on read and any other value falls back
to the default. Every other palette token for the custom theme is derived from
those two with `color-mix()` in `css/novel.css` — nothing else is stored.

### 3.2 Bundled typefaces

`fonts/` holds three SIL OFL faces — OpenDyslexic, Atkinson Hyperlegible and
Literata (see `fonts/LICENSE.md`). Three rules govern them:

1. **They are not in `SHELL_ASSETS`.** Precaching ~550 KB of type that most
   readers never select is waste. `sw.js` matches `/fonts/**.woff2` and caches
   each file the first time it is actually requested.
2. **Every stack falls back to system fonts** and uses `font-display: swap`, so
   the reader is legible before — and without — the file.
3. **Selecting one re-settles the layout.** A face that has not arrived lays out
   on fallback metrics, so `settleWhenFontLands()` waits on `document.fonts` and
   settles again against the real metrics, carrying the anchor across both
   passes. Opening the settings sheet pulls the three regulars (~200 KB) because
   each option is rendered as a specimen of itself; bold and italic wait until a
   face is chosen.

### 3.3 Raw reader localStorage keys (`or.*`)

reader.js predates Store and keeps its own raw localStorage keys (all
silent-catch reads/writes). They are now part of the durability story:
platform.js mirrors them to native Preferences (§2.3) with the
DOMContentLoaded registration-order rule, and localStorage remains the
synchronous source of truth.

| key | shape | mirrored |
| --- | --- | --- |
| `or.prefs`, `or.prefs.series` | the Store pref blobs (§3.1) | yes — also copied on `or:prefs`, debounced 2 s |
| `or.library` | MRU list of upload/reading sessions; on native each entry additionally carries an archive manifest `[{name, size, key}]` so "Resume" reopens from disk. Cap 10 native / 5 web; progress fields only ever advance (high-water marks). | yes — hide-time copy only |
| `or.gap` | page-gap level index | yes — hide-time copy only |
| `or.autoscroll` | JSON `{ speedIdx, scrollMode }` | yes — hide-time copy only |
| `or.timer` | goals countdown `{ deadline, minutes }` | **no — deliberately.** Losing a running countdown to a WebKit eviction is accepted; resurrecting an expired one would chime for a timer the user never saw survive. |

---

## 4. `window.NovelReader` — text reader API

```js
NovelReader.open({ series, chapter, blocks, resume })
// series  : Series
// chapter : Chapter
// blocks  : Block[]  (already resolved — the caller does the fetching)
// resume  : { blockIdx, charOffset, pct } | null
```

Requirements:

- **Three reading modes**, switchable live without losing position:
  - `paged` — page-by-page flip. CSS multi-column pagination; swipe/tap/arrow
    keys; page N of M within the chapter.
  - `chapter` — vertical scroll of one chapter, with prev/next chapter controls
    at the boundaries.
  - `infinite` — continuous scroll that appends the next chapter as the reader
    nears the end, and prepends nothing (append-only keeps scroll anchoring sane).
- Typography controls per §3.1, applied live via CSS custom properties.
- **Presets** (settings-sheet chip rail): one-tap bundles over the EXISTING
  `novel.*` keys — five built-ins plus user-saved snapshots in
  `novel.presets` (§3.1). Applying one writes every key through the normal
  per-series path in ONE relayout batch with the anchor held (the `setMode`
  pattern); presets are starting points — no "active preset" state is
  stored. Preset names are third-party strings (`textContent`, clamped 40).
  The image reader deliberately has no presets (its two knobs stay
  global-and-persistent).
- Progress written to `Store.putProgress` (throttled, ≥1 s apart, and on
  `visibilitychange`/`pagehide`).
- Must work offline for chapters already in `Store`.
- **`state.loaded` is LRU-capped** at `Platform.tuning().maxLoadedChapters`
  (read once per `open()`; default 10 when Platform is absent). Eviction
  removes the Map entry only — the DOM is already windowed — and
  `expandEntry` tolerates a missing entry by refilling through `loadChapter`
  with the scrollTop compensation kept. `api.state()` exposes the cap and
  `loaded.size` for the test page.

To fetch adjacent chapters in `infinite`/`chapter` mode, call the resolver the
catalogue provides:

```js
window.resolveChapterContent(series, chapter)  // → Promise<ChapterFile>
```

It handles: `blocks`/`pages` inline → `text` → `src` fetch → worker `/chapter`
→ `Store` cache. Implemented in `catalogue.js`; **cache-first, network-second**.

**Staleness rule for imported-archive rows:** after the Store-cache read, a
row with `archiveKey` + `entries` whose `pages` are empty **or contain any
session-local URL** (`blob:`, `capacitor://`, or a `_capacitor_file_` path —
all dead links outside the session that minted them) is re-hydrated through
`window.Importer.hydrateChapter(series.id, chapter.id)` (guarded on the
function existing) and the result is returned **without writing it back to
Store** — session-local URLs are never persisted. This is also what heals
every imported chapter after an iOS app update rotates the container UUID.

DOM ceilings, enforced here: chapter lists render 250 rows before an inline
"Show more (N remaining)" row; card grids chunk at 200 cards the same way
(covers stay `loading="lazy"`); range selects populate lazily on first open
of the range panel.

---

## 5. `window.Importer` — bring-your-own-series API

```js
Importer.openDialog({ url })               // show the "Add a series" screen; the
                                           //   optional url prefills the confirm flow
                                           //   (deep links, sources browse)
Importer.normalizeUrl(raw)                 // → canonical URL string (scheme check,
                                           //   lowercased host, credentials/fragment
                                           //   dropped, tracking params stripped,
                                           //   params sorted, trailing slashes
                                           //   trimmed). THE one URL normalizer —
                                           //   sources.js calls it guarded so saving,
                                           //   the "In library" badge and the ids the
                                           //   importer mints can never drift.
await Importer.importUrl(url, { onProgress })  // → Series (already saved to Store)
await Importer.importFile(file)            // EPUB / TXT / CBZ → Series
await Importer.hydrateChapter(seriesId, chapterId)
                                           // → ChapterFile | null — live pages for one
                                           //   chapter of an imported archive.
                                           //   SESSION-LOCAL: never persist the result.
await Importer.exportLibrary({ includeChapters })  // → backup JSON (no source blobs)
await Importer.importLibrary(json)         // bulk upserts — idempotent over intact rows
```

The URL flow calls the worker's `/resolve` endpoint (§6.2), normalizes the
response into a `Series` with `source: "user"`, and persists it via
`Store.putUserSeries`. Chapters come back with `src` pointing at the worker's
`/chapter?url=…` endpoint; the resolver in §4 caches them on first read.

**Lazy hydration (no decompression at boot).** `hydrateChapter` opens the
series archive and extracts ONLY that chapter's `entries`: natively via
`Platform.zip.extract({key: archiveKey}, entries, seriesId + '/' + chapterId)`
→ `Platform.pageUrl` per page; on the web via one shared JSZip over
`Store.getBlob(archiveKey)` → object URLs. Two hard residency bounds (PLAN.md
§9): at most **one** JSZip instance app-wide, and at most **two** hydrated
chapters per archive (current + previous) — eviction revokes the object URLs
(web) or releases the page dir (native); a pruned dir simply re-extracts.
`rehydrateAll()` is a **migration shim**: it decompresses nothing and scrubs
any persisted session-local page URLs back to `pages: []` (`entries` +
`archiveKey` are the truth). `commitDraft` never writes page URLs for CBZ
chapters.

**Native import (URI path).** `prepareArchive` accepts a `PickedFile`; the
entry list comes from `Platform.zip.list({uri})` (names + sizes only — no
bytes in JS); the cover is extracted alone to `pages/import-tmp/` and
released after `shrinkToDataUrl`; `commitDraft`'s native branch calls
`Platform.archives.importFromUri(archiveKey, nativeUri)` FIRST — the commit
ordering invariant (payload → chapters → series row last) holds with the
file move as the payload step. EPUB/TXT picked natively go through
`readPickedFile` into the unchanged `prepareEpub`/`prepareTxt` (disk is not
trusted: EPUB XHTML still crosses `xhtmlToBlocks`). File identity stays
`hash(name.toLowerCase() + ':' + size)` with the ORIGINAL name/size on every
path. Deleting a series also removes its native archive file and page dirs.

**Manage view** additionally owns the "Performance" row (segmented
Auto/Low/Mid/High writing `platform.memoryClass`) and the "Move library to
device storage" action (chunked `Platform.archives.migrateBlob`, one archive
at a time, user-initiated — the delegation addendum, §2.3).

**Deep links & backup.** `Platform.onAppUrlOpen` feeds
`offlinereader://add?url=…` into the confirm-screen flow (`openDialog({url})`
— never headless `importFile`); the web `?add=` share_target keeps working.
Backups write `exportLibrary({includeChapters:false})` to
`Platform.backup.write` on debounced triggers (after commits/deletes and
`or:thoughts-changed`, 1 min; on the first `or:progress` of each local day,
5 min). At boot a **restore offer** (toast, explicit tap, never silent)
appears when the library is empty but a backup has series, OR series exist
but progress is empty while the backup has progress rows; restore goes
through `importLibrary`.

**Thoughts ride the backup** (additive; format `version` stays 1, old
builds ignore the field): `exportLibrary` includes a `thoughts` array
(`Store.listThoughts({})`, all rows, both `includeChapters` modes — thoughts
are tiny text); `importLibrary` upserts them idempotently by id when the
array is present, and its return value carries an additive `thoughts` count
(`{ series, chapters, progress, thoughts }`).

**Purchased books (DRM posture in §8).** The add view's "Books you've
bought" card is informational: a DRM-free EPUB/CBZ opens like any other
file, with a per-store "Where is my file?" disclosure list (app-authored
data rendered via `el()`/`textContent`). No ACSM handling of any kind: an
`.acsm` pick gets the honest toast ("That is a DRM license file, not a
book.") from an extension check in `importFile`'s type sniff, before any
parse attempt.

---

## 6. Cloudflare Worker — content gateway

Base URL configured once in `js/config.js` as `OR_CONFIG.workerBase`
(e.g. `https://manga-proxy.example.workers.dev`). Empty string disables all
gateway features gracefully — the app must still browse the bundled catalogue
and read local files.

All responses are JSON with `Access-Control-Allow-Origin: *` except `/image`,
which streams bytes. Errors: `{ ok: false, error: "code", message: "…" }` with a
non-2xx status.

### 6.1 `GET /image?url=<encoded>`

Streams the image with a plausible `Referer`/`Origin` derived from the target
host. Also served at `/?url=…` for backward compatibility with catalogues
already in the wild.

- Host must be in the allowlist: static entries **or** a host learned from a
  previous successful `/resolve`, `/chapter` or `/list` parse (stored in KV,
  30-day TTL). This keeps it from becoming an open proxy while still
  supporting user-brought sites.
- Rejects non-`http(s)` schemes, IP-literal hosts, and private/loopback/
  link-local targets (SSRF).
- Rejects responses whose `Content-Type` is not `image/*`.
- Caps body size and request timeout; caches in the Cloudflare edge cache.

### 6.2 `GET /resolve?url=<encoded series page URL>`

Fetches and parses a series page, returns a normalized `Series`:

```jsonc
{ "ok": true, "adapter": "generic-novel", "series": { /* Series, §1.1 */ } }
```

Each chapter in the response carries `src: "<workerBase>/chapter?url=…"`.
Any image hosts discovered are written into the KV allowlist.

### 6.3 `GET /chapter?url=<encoded chapter URL>&kind=text|image`

Fetches and parses one chapter, returns a normalized `ChapterFile` (§1.2):

```jsonc
{ "ok": true, "adapter": "generic-novel", "chapter": { /* ChapterFile */ } }
```

`kind` is a hint; the adapter may override it based on what it finds.

### 6.4 `GET /health`

`{ ok: true, version: "…", adapters: [...], adapterDetail: [...], … }` —
`adapterDetail` rows carry `canList: boolean` (the optional `/list`
capability, §6.5/§6.6), which is how the client decides whether browsing a
source can work at all.

### 6.5 Adapters

`worker/src/adapters/<id>.js` exporting:

```js
export const id = "generic-novel";
export const label = "Generic novel site";
export function matches(url) { return true; }        // lower priority = generic
export const priority = 100;                          // lower runs first
export async function resolveSeries(url, ctx) { … }   // → Series
export async function resolveChapter(url, ctx) { … }  // → ChapterFile

// OPTIONAL listing capability (§6.6). isValid keeps requiring exactly the
// five members above; an optional member of the wrong type IS a boot error.
export async function listSeries(url, ctx) { … }
// → { source: { title, url }, items: [ { title, url, cover?, type? } ], nextUrl? }
//   items.url: absolute http(s) — the value the client feeds back into /resolve.
//   The listing NEVER mints series ids (the client and /resolve own id hashing).
//   type (optional): manga | manhwa | lightnovel | webnovel — a hint, never trusted.
export function listMatches(url) { … }   // optional; when absent, matches() gates listing
```

`ctx` provides `{ fetchHtml(url), fetchJson(url), absolutize(href, base), env }`.
The generic adapters must degrade gracefully: a readability-style extraction for
prose, and a "largest run of sequential images in one container" heuristic for
image chapters.

### 6.6 `GET /list?url=<encoded catalogue/listing page URL>`

```jsonc
{ "ok": true, "adapter": "generic-novel", "source": { "title", "url" },
  "items": [ { "title", "url", "cover?", "type?" } ], "nextUrl": "…?" }
```

Turns a browse/catalogue page into series candidates for the sources module
(§2.9). Contract points:

- Rides the **parse** rate bucket (same fetch-and-parse work class as
  `/resolve`; no new bucket) and the same handler-level `assertSafeTarget`
  SSRF gate. Adapter selection: first adapter in priority order with a
  `listSeries` function whose `listMatches(url)` — or `matches(url)` when
  `listMatches` is absent — accepts the URL; debug `?adapter=` force param
  as on `/resolve`. None → `no_adapter` 422.
- Caps: items sliced at 60, titles clamped at 200 chars; the HTML fetch
  reuses the shared byte/timeout caps. Response envelope carries
  `cacheSeconds: 300` + `X-Or-Adapter`.
- Errors use the existing codes/envelope (`bad_url` 400, `blocked_host`
  403, `upstream_error` 502, `timeout` 504, `rate_limited` 429); the one
  NEW code is **`list_failed` 422** (adapter ran but found no usable
  listing), with its own `ERR` entry in `worker/src/lib/respond.js`.
- **Cover-host learning, capped and memoized.** `/list` learns cover hosts
  into the KV allowlist capped at **4 hosts per request**, fronted by an
  in-isolate seen-host memo (module-scope map in `worker/src/lib/gateway.js`
  — the entry-owned-state home — skipping hosts put within ~6 h) because
  `learnHosts` only skips *statically* allowed hosts and a browse loop
  would otherwise re-put the same hosts at up to ~120 KV writes/min,
  burning the free tier's 1,000 writes/day from one client. Repeat browsing
  from a warm isolate writes nothing; the residual is one put-batch per
  cold isolate per host (arithmetic in `worker/README.md`). `/resolve` and
  `/chapter` keep their unmemoized calls (single-shot flows).
- Registered in `route()` and the `/` service-descriptor `endpoints` array;
  the `/health` `version` constant (`VERSION`, `worker/src/lib/gateway.js`)
  was bumped to 2.1.0 with it.

---

## 7. Security rules (non-negotiable)

1. Never `innerHTML` third-party strings. Blocks in, `textContent` out.
   **Native file access does not change trust**: a chapter name, filename, or
   EPUB XHTML string coming off the device disk is exactly as third-party as
   one coming off the network — same boundary, same `textContent`/
   `xhtmlToBlocks` path, no exceptions for "local" content. The boundary
   also covers source-site listing strings (§6.6), preset names, and **the
   reader's own saved thoughts** — a thought renders via `textContent` like
   any other prose. Generated covers (§2.7) interpolate zero content
   strings (`createElementNS` + numeric/enum attributes only).
2. Worker rejects private-network targets and non-http(s) schemes.
3. `/image` is allowlist-gated; the allowlist grows only via a successful
   `/resolve`, `/chapter`, or `/list` parse — never via `/image` itself
   (`/list` capped at 4 hosts/request and memoized per isolate, §6.6).
4. No credentials, cookies, or auth headers are ever forwarded upstream.
5. Imported series are user data — they live in IndexedDB (or the app's own
   container on native), never in the repo.
6. **URL-scheme validators are prefix-exact.** Every `safeImageUrl`
   (catalogue.js, importer.js, novel-reader.js, and the sources.js twin —
   the keep-in-sync list) admits the Capacitor local origins only as exact
   prefixes — `capacitor://localhost/…` and
   `https://localhost/_capacitor_file_/…` — never substring matches, so
   `capacitor://localhost.evil` or a `capacitor-evil:` scheme still falls
   through to the drop rule.
7. **The or-zip plugin contains zip-slip.** `extract` rejects any entry name
   that would resolve outside `destDir` (canonical-path check on both
   platforms) and any archive path outside the app container; it returns
   names/sizes/paths, never entry bytes.
8. **Session-local page URLs are never persisted** (`blob:`,
   `capacitor://…`, `…/_capacitor_file_/…`) — see §1.2. A persisted one is
   treated as stale, never rendered.

## 8. Legal posture

The bundled catalogue is **the tutorial book plus public-domain classics**:
one original tutorial series written for this repository (*We Are Readers
Here*, `fixture:welcome`) and six Project Gutenberg texts — all text, all
fully readable offline. We do not redistribute copyrighted chapters, and we
do not re-host images — the worker proxies bytes on demand and caches them
at the edge, exactly as the user's own browser would. Everything a user
brings in via a link stays on that user's device.

The reader-facing statement of all this, including how to report a problem,
is `COPYRIGHT.md`. The code is AGPL-3.0-or-later (`LICENSE`); §13 of that
licence is why both home screens carry a source link in `.colophon`.

**Public-domain-only is enforced, not promised (binding).** `validate.js`
fails any catalogue carrying a series whose `source` is outside
`fixture | gutenberg | standardebooks`. The rule used to live in prose,
which left one entry in `series.json` able to turn a reader into a mirror:
`.github/workflows/scrape.yml` runs every six hours with `contents: write`
and commits whatever the builder produces. Now CI refuses it. The builder's
`SOURCES` registry is public-domain-only for the same reason, so adding a
module is not by itself enough to smuggle a source in.

**Nothing names a particular site (binding).** The worker ships two
general-purpose adapters, `generic-manga` and `generic-novel`; the compiled-in
`/image` allowlist covers only the public-domain hosts the bundled catalogue
uses; and `refererFor()` derives a Referer from the target host with no
per-site table. A shipped list of reader sites — an adapter written for one, a
hostname compiled into the allowlist, a hand-mapped Referer that defeats one
site's hotlink check — is a statement about what this software is *for*, and
this software is for whatever its reader points it at. Other hosts reach the
allowlist the honest way: the learned tier, written only after a reader
resolves a URL they supplied, or an operator's `EXTRA_ALLOWED_HOSTS`.
`adapters.test.js` and `allowlist.test.js` assert both.

**The Gutenberg trademark does not ship in harvested prose.** The texts are
public domain; the name is not ours to redistribute. `sources/gutenberg.js`
strips the licence boilerplate, the production credits and a leading
transcriber's note, and `validate.js` errors if "Project Gutenberg" survives
into any `gutenberg:*` chapter — which is how a transcriber's note that had
reached chapter one of Moby-Dick was found. Our own writing may name them
factually; the tutorial does, and the check is scoped so it stays legal.

**The tutorial book is the offline floor.** `scraper/src/validate.js` fails
(CI exit 1) a catalogue that is empty, one that ships zero bundled chapter
files, **or one whose enabled `fixture:welcome` ships no chapter file** —
the focus sheet's "Start with the tour" button depends on it (and is
render-guarded besides). Its content shape (9 chapters, `h2` openers,
400–800 words each, the block-variety floor, no `img` blocks) is enforced by
`scraper/src/check-welcome.js`, which rides `npm run validate`. (The
chapter-file guards run in the validator's checkFiles mode — standalone
`npm run validate` and real scrape runs; `--dry-run` writes nothing to
check, so only the empty-catalogue guard applies there.)

**DRM posture (binding conduct).** No DRM circumvention, ever: the app will
not strip, bypass, decode, or link to tools that do — no ACSM/Adobe flows,
no key handling, no "search for how" hints. Importable means files a store
itself hands the user DRM-free; an `.acsm` pick gets an honest refusal
toast, never a parse attempt (§5). UI copy about locked ecosystems is
factual and unresentful — we state what opens here, one sentence per store.
