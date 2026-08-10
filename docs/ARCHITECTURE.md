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
  "source":    "mangadex",           // adapter id, or "user" for imported series
  "sourceUrl": "https://mangadex.org/title/…",
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

  // Payload — EXACTLY ONE of the following four resolution strategies:
  "pages": ["https://…/1.webp", …],  // image: inline URLs
  "mdChapterId": "uuid",             // image: resolve via MangaDex at-home at read time
  "text":  "para one\n\npara two",   // text: inline plain text (small chapters only)
  "src":   "chapters/md_xxx/c-0271.json"  // either kind: fetch a ChapterFile (see 1.2)
}
```

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
jszip.min.js
js/reader.js        image reader (CBZ + online image chapters) — pre-existing
js/novel-reader.js  window.NovelReader                        — agent: novel-reader
js/importer.js      window.Importer                           — agent: importer
js/goals.js         window.Goals  (optional — app must run without it) — agent: goals
js/catalogue.js     window.Catalogue  (boots the app)         — agent: catalogue
```

`platform.js` sits before `store.js` because it is the only module with no
dependencies and everything after it may consult `Platform.isNative`.
`goals.js` sits between `importer.js` and `catalogue.js`; it is **deletable**:
with the file absent the home slot stays empty, the toolbar button is never
rendered, and its events go unheard — the app runs exactly as before.

Each feature module **creates its own DOM at init time** (`document.body.append`)
rather than relying on markup in `index.html`. This keeps `index.html` free of
merge conflicts. Each module owns exactly its own JS file and CSS file; do not
edit another module's files.

### 2.1 Screens

`window.showScreen(id)` (in `reader.js`) hides every registered screen and shows
one. New screens register themselves:

```js
window.registerScreen(element);   // adds to the hide-all set; call at init
window.showScreen('novel-screen');
```

Screen ids in use: `upload-screen`, `loading-screen`, `reader-screen`,
`home-screen`, `series-screen`, `novel-screen`, `import-screen`,
`goals-screen`.

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

**Android hardware back** (dispatched by platform.js on
`document.body.dataset.screen`; every branch guarded):

| screen | action |
| --- | --- |
| `novel-screen` | `NovelReader.close({ navigate: true })` — the module's own exit path (final flush, keydown unwire) |
| `reader-screen` | `#close-btn.click()` — runs BOTH registered close listeners (catalogue's progress sync + reader's teardown) |
| `home-screen` / `upload-screen` | minimize the app |
| anything else | `Catalogue.goBack()` |

The two reader screens must exit through their own close paths — a raw
`goBack()` would only switch screens, leaving orphaned key handlers, a live
progress timer, and no final progress flush.

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
      // src = { key } (archive under Data/archives/) or { uri } (picked file)
      // → Promise<{ name, size }[] | null> — central-directory read only;
      //   zero entry bytes enter the webview.
    extract(src, entryNames, cacheDirKey),
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
- **Hardware back** dispatch per the §2.2 table. **Status bar**: dark style
  on ready; overlay mode on Android only (iOS relies on the existing
  `black-translucent` meta + `viewport-fit=cover`).
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
  `<div id="goals-home-slot">` between the Continue rail and Latest updates,
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

---

## 3. `window.Store` — persistence API

Backed by IndexedDB (`offline-reader` database, **`DB_VERSION` 2** — v2 adds
the `dayLogs` store; the upgrade handler only creates what is missing) with
an in-memory fallback if IndexedDB is unavailable (private browsing, some iOS
webviews). **The fallback implements every method here** — including the
dayLog methods — as session-scoped Map tables. Every method returns a Promise
and **never rejects for expected conditions** — missing rows resolve to
`null` / `[]`. Only programmer errors throw.

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

### 3.1 Preference keys (global unless noted)

| key                   | values                                        | used by      |
| --------------------- | --------------------------------------------- | ------------ |
| `novel.mode`          | `paged` \| `chapter` \| `infinite`             | novel-reader |
| `novel.fontFamily`    | `serif` \| `sans` \| `mono` \| `literata` \| `atkinson` \| `dyslexic` | novel-reader |
| `novel.fontSize`      | px number, 14–32                               | novel-reader |
| `novel.lineHeight`    | number, 1.3–2.2                                | novel-reader |
| `novel.width`         | `narrow` \| `normal` \| `wide` \| `full`       | novel-reader |
| `novel.align`         | `left` \| `justify`                            | novel-reader |
| `novel.theme`         | `dark` \| `dim` \| `black` \| `light` \| `cream` \| `sepia` \| `tan` \| `nord` \| `forest` \| `custom` | novel-reader |
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
| `goals.pill`          | `auto` \| `off` (default `auto`)               | goals        |
| `goals.idleCutoff`    | int minutes `1..30` (default `5`)              | goals        |
| `goals.reminder.enabled` | boolean (default `false`; UI only when `Platform.notify.canNotify()`) | goals |
| `goals.reminder.time` | string `/^([01]\d\|2[0-3]):[0-5]\d$/` (default `20:00`) | goals |

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
Store** — the same rule as MangaDex signed URLs. This is also what heals
every imported chapter after an iOS app update rotates the container UUID.

DOM ceilings, enforced here: chapter lists render 250 rows before an inline
"Show more (N remaining)" row; card grids chunk at 200 cards the same way
(covers stay `loading="lazy"`); range selects populate lazily on first open
of the range panel.

---

## 5. `window.Importer` — bring-your-own-series API

```js
Importer.openDialog()                      // show the "Add a series" screen
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
`Platform.backup.write` on two debounced triggers (after commits/deletes,
1 min; on the first `or:progress` of each local day, 5 min). At boot a
**restore offer** (toast, explicit tap, never silent) appears when the
library is empty but a backup has series, OR series exist but progress is
empty while the backup has progress rows; restore goes through
`importLibrary`.

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
  previous `/resolve` (stored in KV, 30-day TTL). This keeps it from becoming an
  open proxy while still supporting user-brought sites.
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

`{ ok: true, version: "…", adapters: ["mangadex", "generic-novel", …] }`

### 6.5 Adapters

`worker/src/adapters/<id>.js` exporting:

```js
export const id = "generic-novel";
export const label = "Generic novel site";
export function matches(url) { return true; }        // lower priority = generic
export const priority = 100;                          // lower runs first
export async function resolveSeries(url, ctx) { … }   // → Series
export async function resolveChapter(url, ctx) { … }  // → ChapterFile
```

`ctx` provides `{ fetchHtml(url), fetchJson(url), absolutize(href, base), env }`.
The generic adapters must degrade gracefully: a readability-style extraction for
prose, and a "largest run of sequential images in one container" heuristic for
image chapters.

---

## 7. Security rules (non-negotiable)

1. Never `innerHTML` third-party strings. Blocks in, `textContent` out.
   **Native file access does not change trust**: a chapter name, filename, or
   EPUB XHTML string coming off the device disk is exactly as third-party as
   one coming off the network — same boundary, same `textContent`/
   `xhtmlToBlocks` path, no exceptions for "local" content.
2. Worker rejects private-network targets and non-http(s) schemes.
3. `/image` is allowlist-gated; the allowlist grows only via `/resolve`.
4. No credentials, cookies, or auth headers are ever forwarded upstream.
5. Imported series are user data — they live in IndexedDB (or the app's own
   container on native), never in the repo.
6. **URL-scheme validators are prefix-exact.** Every `safeImageUrl`
   (catalogue.js, importer.js, novel-reader.js) admits the Capacitor local
   origins only as exact prefixes — `capacitor://localhost/…` and
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

The bundled sample catalogue ships **public-domain text only** (Project
Gutenberg / Standard Ebooks). We do not redistribute copyrighted chapters, and
we do not re-host images — the worker proxies bytes on demand and caches them at
the edge, exactly as the user's own browser would. Everything a user brings in
via a link stays on that user's device.
