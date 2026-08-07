# Offline Reader — Architecture Contract

This document is the **binding contract** between the modules of this app. Every
module is written against it. If you change a shape here, you change it for
everyone — say so explicitly.

The app is a **static PWA**. No build step, no framework, no bundler. Vanilla
ES2020, plain `<script>` tags, served from GitHub Pages. The only server-side
component is a single Cloudflare Worker that acts as a **content gateway**
(CORS/referer bypass + HTML→JSON normalization). We do not host content.

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
  "wordCount": 3210
}
```

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
js/store.js         window.Store                              — owned by integrator
jszip.min.js
js/reader.js        image reader (CBZ + online image chapters) — pre-existing
js/novel-reader.js  window.NovelReader                        — agent: novel-reader
js/importer.js      window.Importer                           — agent: importer
js/catalogue.js     window.Catalogue  (boots the app)         — agent: catalogue
```

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
`home-screen`, `series-screen`, `novel-screen`, `import-screen`.

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

---

## 3. `window.Store` — persistence API

Backed by IndexedDB (`offline-reader` database) with an in-memory fallback if
IndexedDB is unavailable (private browsing, some iOS webviews). Every method
returns a Promise and **never rejects for expected conditions** — missing rows
resolve to `null` / `[]`. Only programmer errors throw.

```js
// ── Imported series ("My Library") ────────────────────────────────────────
await Store.listUserSeries()               // → Series[]  (newest addedAt first)
await Store.getUserSeries(id)              // → Series | null
await Store.putUserSeries(series)          // upsert; stamps addedAt/updatedAt; → Series
await Store.deleteUserSeries(id)           // also deletes its cached chapters + progress

// ── Cached chapter content ────────────────────────────────────────────────
await Store.getChapter(seriesId, chapterId)      // → ChapterFile | null
await Store.putChapter(seriesId, chapterId, file)// → ChapterFile
await Store.deleteChapter(seriesId, chapterId)
await Store.listCachedChapterIds(seriesId)       // → string[]
await Store.clearChapters(seriesId)              // omit seriesId to clear all
await Store.estimateUsage()                      // → { usage, quota } bytes (may be nulls)

// ── Reading progress (one row per series) ─────────────────────────────────
await Store.getProgress(seriesId)          // → Progress | null
await Store.putProgress(seriesId, patch)   // shallow-merges patch, stamps updatedAt
await Store.listProgress({ limit })        // → Progress[] desc by updatedAt — "Continue reading"
await Store.deleteProgress(seriesId)

// ── Preferences (synchronous, localStorage-backed) ────────────────────────
Store.prefs.get(key, fallback)
Store.prefs.set(key, value)                // fires 'or:prefs' CustomEvent {key, value}
Store.prefs.all()                          // → plain object
Store.prefs.getFor(seriesId, key, fallback)// per-series override, falls back to global
Store.prefs.setFor(seriesId, key, value)
Store.prefs.clearFor(seriesId)
Store.prefs.on(fn)                         // fn({key, value, seriesId}) → unsubscribe fn

// ── Blobs (uploaded EPUB/CBZ kept for re-open) ────────────────────────────
await Store.putBlob(key, blob)
await Store.getBlob(key)                   // → Blob | null
await Store.deleteBlob(key)
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

| key                  | values                                        | used by      |
| -------------------- | --------------------------------------------- | ------------ |
| `novel.mode`         | `paged` \| `chapter` \| `infinite`             | novel-reader |
| `novel.fontFamily`   | `serif` \| `sans` \| `mono` \| `dyslexic`      | novel-reader |
| `novel.fontSize`     | px number, 14–32                               | novel-reader |
| `novel.lineHeight`   | number, 1.3–2.2                                | novel-reader |
| `novel.width`        | `narrow` \| `normal` \| `wide` \| `full`       | novel-reader |
| `novel.align`        | `left` \| `justify`                            | novel-reader |
| `novel.theme`        | `dark` \| `light` \| `sepia` \| `black`        | novel-reader |
| `novel.paraSpacing`  | `tight` \| `normal` \| `loose`                 | novel-reader |
| `novel.indent`       | boolean                                        | novel-reader |
| `catalogue.tab`      | `all` \| `manga` \| `manhwa` \| `lightnovel` \| `library` | catalogue |
| `catalogue.layout`   | `grid` \| `list`                               | catalogue    |

Per-series overrides use the same keys via `prefs.getFor(seriesId, key)`.

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

To fetch adjacent chapters in `infinite`/`chapter` mode, call the resolver the
catalogue provides:

```js
window.resolveChapterContent(series, chapter)  // → Promise<ChapterFile>
```

It handles: `blocks`/`pages` inline → `text` → `src` fetch → worker `/chapter`
→ `Store` cache. Implemented in `catalogue.js`; **cache-first, network-second**.

---

## 5. `window.Importer` — bring-your-own-series API

```js
Importer.openDialog()                      // show the "Add a series" screen
await Importer.importUrl(url, { onProgress })  // → Series (already saved to Store)
await Importer.importFile(file)            // EPUB / TXT / CBZ → Series
```

The URL flow calls the worker's `/resolve` endpoint (§6.2), normalizes the
response into a `Series` with `source: "user"`, and persists it via
`Store.putUserSeries`. Chapters come back with `src` pointing at the worker's
`/chapter?url=…` endpoint; the resolver in §4 caches them on first read.

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
2. Worker rejects private-network targets and non-http(s) schemes.
3. `/image` is allowlist-gated; the allowlist grows only via `/resolve`.
4. No credentials, cookies, or auth headers are ever forwarded upstream.
5. Imported series are user data — they live in IndexedDB, never in the repo.

## 8. Legal posture

The bundled sample catalogue ships **public-domain text only** (Project
Gutenberg / Standard Ebooks). We do not redistribute copyrighted chapters, and
we do not re-host images — the worker proxies bytes on demand and caches them at
the edge, exactly as the user's own browser would. Everything a user brings in
via a link stays on that user's device.
