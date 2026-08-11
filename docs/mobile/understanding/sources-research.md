# Sources feature — feasibility research (worker, importer, catalogue, scraper, navigation)

Produced by a read-only research pass ahead of Phase 7 planning. Line references were verified against the tree at research time.

# Research report: "Sources: add any online library"

---

## 1. `worker/src` — endpoints, adapter capabilities, and what a "list series" endpoint would take

### 1.1 Endpoints that exist

All routing is in one function, `route()` at `/home/user/Offline-Reader/worker/src/index.js:370-410`:

| Path | Handler | Notes |
|---|---|---|
| `GET /health` | `handleHealth` — `index.js:137-164` | Not rate-limited (despite README claiming a 120/min "meta" budget — `checkRateLimit` is never called on this path). Reports `adapters`, `adapterDetail`, `kv`, `allowlist.mode`, `dnsGuard`, `allowPrivateTargets`, `limits`. |
| `GET /image?url=` | `handleImage` — `index.js:168-281` | Rate bucket `image` (300/60s). Allowlist-gated, `image/*`-only, 20 MB streaming cap, edge-cached. |
| `GET /?url=` | `index.js:389-397` | Legacy alias for `/image`; bare `/` returns a service descriptor listing the four endpoints (`index.js:391-396`) — **this list is the thing a new endpoint must be added to for discoverability**. |
| `GET /resolve?url=` | `handleResolve` — `index.js:285-320` | Rate bucket `parse` (30/60s). One URL → one `Series`. Supports a debug `?adapter=` force param (`index.js:296`). Learns image hosts into KV (`index.js:304-310`). Returns `X-Or-Adapter` / `X-Or-Confidence`, `cacheSeconds: 300`. |
| `GET /chapter?url=&kind=` | `handleChapter` — `index.js:324-364` | Same bucket/learning/caching as `/resolve`. |
| anything else | `index.js:409` | `not_found`. |

Only `GET`/`HEAD`/`OPTIONS` are accepted (`index.js:371-374`).

### 1.2 What the adapters can actually parse — **no adapter can list multiple series**

The adapter interface is exactly two resolvers, enforced at boot by a shape check that will reject a malformed adapter but knows nothing about listing: `isValid()` requires `id`, `matches`, `priority`, `resolveSeries`, `resolveChapter` — `/home/user/Offline-Reader/worker/src/adapters/index.js:23-38`. The contract is restated in `docs/ARCHITECTURE.md` §6.5 and `worker/README.md:358-361`.

Per adapter:

- **`mangadex`** (`worker/src/adapters/mangadex.js`) — `matches()` only accepts `mangadex.org|api.mangadex.org` **with** `/title/<uuid>` or `/chapter/<uuid>` in the path (`mangadex.js:28-37`). A MangaDex *search/browse* URL is explicitly rejected by that regex test, and there is no code path touching `GET /manga?title=…` (only `/manga/<uuid>`, `/manga/<uuid>/feed`, `/chapter/<uuid>`, `/at-home/server/<uuid>` — `mangadex.js:8-11`). So even the one adapter backed by a real search-capable API cannot list.
- **`generic-manga`** (`generic-manga.js`) and **`generic-novel`** (`generic-novel.js`) both delegate to `genericResolveSeries` / `genericResolveChapter` in `worker/src/adapters/_generic.js:44` and `:195`. `genericResolveSeries` fetches ONE page, extracts OG/JSON-LD metadata, then finds **one** TOC cluster and turns its links into *chapters* — `_generic.js:57-94`. There is no concept of "these links are other series".

**The machinery is one function away, though.** `findTocCluster(root, baseUrl, opts)` (`worker/src/lib/extract.js:281`) is a generic "largest group of same-shaped links, scored" routine — it groups anchors by container/shape at 3 ancestor depths, dedupes by href, and scores on count, chapter-ish text, href prefix similarity and nav-word penalty. A catalog listing page is structurally the same problem with a different text prior: it currently *penalises* the cluster via `CHAPTER_TEXT`/`BARE_NUMBER` chapter-ish scoring and the `NAV_TEXT` penalty (`extract.js:281-340`), so a listing page would score low but would still be found. A `findLinkCluster`-style refactor (chapter-ish scoring becomes a pluggable prior) is the natural shared core.

### 1.3 What a site-level "list series" endpoint would need

Concretely, four pieces:

1. **A new optional adapter method**, e.g. `listSeries(url, ctx)`. It must be *optional*: `isValid()` at `adapters/index.js:23-32` currently hard-requires the two resolvers, so add a capability probe (`typeof a.listSeries === 'function'`) rather than extending the required set, or every existing adapter breaks at boot (`adapters/index.js:34-38` throws). `listAdapters()` (`adapters/index.js:41-43`) should then report the capability so the client can gate its UI off `/health` instead of guessing.
2. **A route** in `route()` (`index.js:399-407` is the pattern to copy) plus adding it to the `/` descriptor list (`index.js:395`). It must use the **`parse`** rate bucket (`ratelimit.js:15-22` — 30/60s), because it does the same fetch-and-parse work: `handleResolve`'s first eight lines (`index.js:286-294`) are the template.
3. **Adapter selection** — reuse `selectAdapter(url, {force})` (`adapters/index.js:62-77`); if no adapter advertises `listSeries`, return `no_adapter` (422) rather than falling through to `generic-novel`, whose `matches()` returns `true` for everything (`generic-novel.js:18-20`).
4. **The response shape.** Each listed item needs at minimum `{ title, url, cover? }` where `url` is what the client then feeds back into `/resolve`. Note the asymmetry: `/resolve` produces the stable id via `hashId(sourceUrl)` (`_generic.js:100`), so a listing entry should carry the raw URL and let `/resolve` mint the id — the client already mints its own id independently from the normalized URL (`js/importer.js:612`), so the listing must not invent ids.

### 1.4 How the guards constrain it

**SSRF (constrains *which* sites can be listed):** every user URL goes through `assertSafeTarget` (`worker/src/lib/security.js:361-369`) → `validateTargetUrl` (`security.js:215-266`) + `assertPublicDns` (`security.js:316-358`). A new endpoint MUST call it (all three current handlers do: `index.js:177, 294, 333`) — it is not applied in the router. Blocked: non-http(s), embedded credentials, IP literals incl. decimal/hex/IPv6, `localhost`/`metadata.*`/`kubernetes*`, ~14 suffixes (`.local`, `.internal`, `.onion`, `.test`, …), single-label hosts, ~50 ports. Redirects are re-validated per hop, capped at 3 (`security.js:415-467`).

**The KV allowlist (constrains *covers*, not listing):** `/image` is the only allowlist-gated endpoint (`index.js:180-189`), and the allowlist grows **only** as a side effect of a successful `/resolve`/`/chapter` via `learnHosts` (`lib/allowlist.js:114-136`, called at `index.js:307/352`). This is the sharp edge for this feature: **a listing page's cover thumbnails will 403 through `/image` until the user actually resolves a series from that host**, because a listing response would not (today) learn hosts. Either (a) have the listing handler call `learnHosts` on the covers it found — same pattern as `index.js:304-310`, bounded at 12 hosts/request and 30-day TTL (`allowlist.js:17, 114`) — or (b) accept broken thumbnails on first visit. Option (a) weakens the "allowlist grows only via a real resolve" invariant stated in `allowlist.js:1-11` and `worker/README.md:314-332`, and burns KV writes against the free tier's 1,000/day (README:518, 530-534). Also note `hasKv()` (`allowlist.js:76-79`): with no KV bound, learning is a silent no-op and only the 13 static hosts work (`allowlist.js:23-41`).

**CPU:** `/resolve` and `/chapter` are already called out as the CPU risk against the free plan's 10 ms budget (`worker/README.md:524-530`). A listing page with 100 entries parsed through `measure()`/`findTocCluster` is in the same class — it will need the same kind of caps as `GENERIC_LIMITS` (`_generic.js:31-35`).

**Testing:** a new endpoint touches `worker/test/endpoints.test.js` (route-level, describe blocks at `:62, 93, 130, 226, 311, 363`) and `worker/test/adapters.test.js` (`:56` "every adapter satisfies the §6.5 interface" will need updating if the interface grows).

---

## 2. `js/importer.js` — the `importUrl` flow, and whether any "source" is recorded

### 2.1 The screens

One registered screen `import-screen` (`js/importer.js:41`), built once by `buildUi()` (`:2351-2396`), containing **three mutually exclusive views** toggled by `showView(name)` (`:3427-3441`):

- **`imp-view-add`** — `buildAddView` (`:2400-2549`). Two cards: "Add by link" (`#imp-link-card`, url input `#imp-url` + "Look up" `#imp-go`, a live preview chip row `#imp-url-preview` showing host + guessed type at `:2551-2573`, and a status region `#imp-status`), and "Open a file" (drop zone + `<input type=file>`). Plus a hidden third card `#imp-gateway-off` (`:2470-2480`) — see §3.
- **`imp-view-confirm`** — `buildConfirmView` (`:2645-2770`), rendered by `renderConfirm()` (`:2820-2930`). Cover, a facts block, editable Title/Author/Description, a 4-way type segmented control, a TXT-only split selector, first-6-chapter preview, and Cancel / "Add to library".
- **`imp-view-manage`** — `buildManageView` (`:2995) / renderManage()` (`:3224`) / `manageRow()` (`:3258-3315`). Per-series: type chip, chapter count, **host** (`:3269`), size on disk, "Check for new chapters" → `refreshSeries`, Delete.

Entry points: `openDialog({url, view})` (`:3559-3584`), which remembers `returnScreen` from `document.body.dataset.screen`; `close()` (`:3586-3593`) delegates to `Catalogue.goBack()`.

### 2.2 The URL flow, end to end

`startUrlImport()` (`:3456-3494`) → `prepareUrl()` (`:603-659`) → `showView('confirm')` → user edits → `saveDraft()` (`:2939-2977`) → `commitDraft()` (`:1921-2011`) → `handoff()` (`:2981-2991`).

`prepareUrl` in order: `normalizeUrl` (strips 20 tracking params, `:55-59`), gateway check, **id = `seriesIdForUrl(normalized)`** (`:612` — a hash of the normalized URL, so the id is stable across re-imports), duplicate probe via `Store.getUserSeries`, `gatewayResolve()` (`:483-522` — full per-code error table at `:406-473`), `normalizeIncomingChapters` (`:535-576` — pins `src` and `pages` schemes), then `baseSeries()` (`:578-599`).

Confirmation is *mandatory* for the interactive path and *skipped* for the programmatic one: `importUrl()` (`:3597-3601`) calls `prepareUrl` + `commitDraft` directly. Even deep links (share target `?add=`, and `offlinereader://add?url=`) land on the confirm screen deliberately — `:3677-3681` explains why.

### 2.3 Does anything store the origin site? **Yes — three fields, per series, and that is the whole "source record" today**

Set in `prepareUrl` (`js/importer.js:639-641`) and persisted by `commitDraft`:

- `sourceUrl` — the **normalized series-page URL** (not the site root).
- `adapter` — which worker adapter parsed it (`'mangadex'`, `'generic-novel'`, …).
- `importKind: 'url'` — distinguishes gateway series from file imports.

Note `commitDraft` **overwrites `series.source = 'user'`** unconditionally (`:1933`), so the gateway's `source: <adapterId>` (`_generic.js:112`) does not survive into the library — `adapter` is the surviving provenance field. There is **no site-level record**: nothing stores an origin/host row, no list of visited sites, no per-site settings. The only place a host is derived is at render time via `hostOf(s.sourceUrl)` (`:661-664`), used in the confirm facts (`:2845`), the manage row (`:3269`), and the refresh progress line (`:2066`).

`refreshSeries()` (`:2051-2096`) is the closest existing "re-visit the source" behaviour: it re-`/resolve`s `current.sourceUrl` and merges chapters by id-then-num. A per-source "check all series from this site" would be a loop over this.

### 2.4 How a "saved sources" shelf would reuse this

- **Storage**: `Store` has five object stores (`js/store.js:23-27`), keyed schemas created in `onupgradeneeded` (`:59-78`, `DB_VERSION = 2` at `:21`). A `sources` store means a v3 bump. Cheaper alternative for v1 of the feature: `Store.prefs` (localStorage-backed, synchronous, `js/store.js:562-608`) with a `sources.saved` array — that is what `catalogue.tab`/`catalogue.layout` already use (`js/catalogue.js:82-83`). Or derive the shelf entirely with zero new storage: `new Set(userSeries.filter(s => s.importKind === 'url').map(s => hostOf(s.sourceUrl)))`.
- **The flow to reuse**: a source card's "browse" action calls the new listing endpoint, and each result's link feeds `openDialog({url})` + `startUrlImport()` — exactly the deep-link path at `:3709-3714`. Nothing else in the confirm/commit pipeline needs to change.
- **Signals to hook**: commit dispatches `or:library-changed` (`:2003`), which `catalogue.js:2220` already listens for. A source shelf can ride the same event.
- **`ui` internals** are exposed for tests at `:3628-3642` (`_internals.ui`, `getDraft`, `prepareUrl`, `commitDraft`) — useful for wiring tests to a new view.

---

## 3. `js/catalogue.js` + `js/config.js` — catalog loading, where a third category slots in, gateway gating

### 3.1 Loading and merging

`loadCatalog()` (`js/catalogue.js:1022-1036`) fetches `OR_CONFIG.catalogUrl` (default `./catalog.json`, `js/config.js:15`) with `cache: 'no-cache'`, runs `migrateCatalog`, and on failure sets `bundledSeries = []` + `catalogError` rather than throwing.

`loadUserSeries()` (`:1038-1041`) reads `Store.listUserSeries()`. `mergeSeries()` (`:1047-1054`) puts bundled into a Map first and user second, so **user entries win on id collision** (comment at `:1049-1050`). `isUserSeries(s)` (`:1060-1062`) = `source === 'user'` OR present in `userSeries`.

`refresh()` (`:2254-2265`) is the reload-everything entry point; `boot()` (`:2289-2304`) awaits `Platform.ready`, wires events, and calls `initMode()`.

### 3.2 Where a third category slots in

**Tabs** are a single const: `TABS` at `js/catalogue.js:25-31` (`all`, `manga`, `manhwa`, `lightnovel`, `library`). Adding one is genuinely three edits:

1. Push an entry into `TABS` (`:25`).
2. Add a branch to `matchesTab(s, tab)` (`:1068-1073`) — e.g. `if (tab === 'sources') return s.importKind === 'url'` (note: `importKind` survives into the stored Series, `js/importer.js:641`, but `normalizeSeries` at `catalogue.js:291` should be checked to confirm it is not stripped).
3. Optionally add an empty-state branch to `renderEmpty(list, tab)` (`:1463-1510`) — it already has bespoke copy for `library` (`:1491`) and `lightnovel` (`:1499`) and a generic fallback (`:1507-1509`).

`buildTabs()` (`:677-704`) renders from `TABS` generically, `syncTabs` (`:1135-1144`) and `onTabKeydown` (`:706-717`) are index-driven, `setTab` (`:1162-1166`) persists to `prefGet/prefSet('catalogue.tab')` (`:82`). The section heading text is a small switch at `:1109-1114`, and `dom.addBtn` visibility is currently hardcoded to `tab === 'library'` (`:1115`).

**Home sections** (a separate rail rather than a tab) — see §5 for the exact insertion mechanics.

### 3.3 What the user sees today when `workerBase` is empty

`js/config.js:9` ships `workerBase: ''`, and `window.gatewayUrl()` (`js/config.js:19-24`) **returns `null`** when unset. Every consumer must handle null; they do, in three different ways:

| Surface | Behaviour when unconfigured |
|---|---|
| **Importer add view** | `syncGatewayVisibility()` (`js/importer.js:3443-3447`) hides `#imp-link-card` entirely and shows `#imp-gateway-off` — a muted card headed "Adding by link is switched off here" with a three-sentence explainer naming `OR_CONFIG.workerBase` and pointing at `worker/README.md` (`:2470-2480`). The design intent is stated at `:2478`: "the link box is hidden rather than shown as a button that cannot work." Focus is also not stolen (`:3580`). |
| **Importer programmatic path** | `prepareUrl` throws `gateway_disabled` (`:610`); `refreshSeries` throws the same (`:2064`). Message at `:461-464`. |
| **Chapter resolution** | `resolveChapterContent` step 5 throws `catErr('gateway-disabled')` (`js/catalogue.js:544`), surfaced as the toast "This chapter needs the content gateway, which is not configured." (`ERROR_TEXT` at `:229`, via `errorText` `:231`). |
| **Images** | `proxyImageUrl` (`js/reader.js:347-357`) silently returns the raw URL — hotlink-protected covers/pages just fail to load; `<img>` error handlers swap in placeholders (`catalogue.js:1195, 1303, 1387`). |

`Importer.isGatewayEnabled` is exported (`js/importer.js:3624`) and is the cleanest hook for gating a new "Sources" surface. Note the catalogue itself has **no** gateway gating on any home-screen affordance today — the "Add series" button is always shown.

---

## 4. `scraper/` — how the bundle is built, cost of removing the 5 samples, test impact

### 4.1 How the bundled catalogue is built

`scraper/src/index.js` reads `scraper/series.json` via `loadConfig()` (`:64-88`), which skips `enabled:false` entries and validates `source`/`id|slug`/`type`. Four source modules registered at `index.js:31`: `fixture`, `gutenberg`, `mangadex`, `flamecomics`.

Per entry: `src.build(entry, ctx)` inside `safe()` (`index.js:200`); `writeSeriesFiles` (`:100-118`) writes `chapters/<idToDir(seriesId)>/<c-NNNN>.json` plus copied assets, then prunes stale siblings. `idToDir` (`scraper/src/lib/util.js:23-25`) is what turns `fixture:ashfall` into `fixture_ashfall`. Finally `catalog.json` is rewritten wholesale (`index.js:236`) and `pruneOrphanDirs()` (`:120-143`) **deletes any `chapters/*` directory not referenced by a `src` or `cover` path in the finished catalogue**.

Failure policy (`index.js:1-16, 206-218`): a failed fetch carries the *previous* `catalog.json` entry over unchanged. CI runs this every 6 hours and commits (`.github/workflows/scrape.yml`), gated by `npm run validate` (`scraper/src/validate.js:270-301`, exits non-zero on any schema error).

Current bundled state: 15 series — 5 `fixture:*`, 6 `gutenberg:*`, 4 `md:*` (three of which currently have **0 chapters**); the 5 `flamecomics` entries produced nothing.

### 4.2 Removing the 5 sample series

The "5 sample series" are the fixtures: `fixture:lamplighter`, `fixture:ninth-bell`, `fixture:floor-zero`, `fixture:still-water`, `fixture:ashfall` (`scraper/series.json`, the five `"source": "fixture"` blocks; README:29-30 calls them "Five sample series"). Files involved:

1. **`scraper/series.json`** — delete the five entries (or flip `enabled` to `false`; `loadConfig` at `scraper/src/index.js:78` skips them, which is the reversible option).
2. **`catalog.json`** — the five `fixture:*` objects. Regenerated automatically by a scrape run; hand-editing is explicitly discouraged (`docs/CATALOGUE.md:22`).
3. **`chapters/fixture_*`** — 5 directories, ~984 KB total (`fixture_ashfall` 444 K incl. 80 committed SVG pages + cover, `fixture_ninth-bell` 200 K, `fixture_floor-zero` 168 K, `fixture_still-water` 148 K, `fixture_lamplighter` 24 K). A full (non-`--only`) scrape run deletes these automatically via `pruneOrphanDirs`.
4. **`scraper/fixtures/`** — the source-of-truth files that would otherwise be dead weight: `lamplighter.json`, `ninth-bell.json`, `floor-zero.json`, `still-water.json`, `ashfall.json`, five `*.cover.svg`, and the `ashfall/` directory (`build-pages.mjs` + `c01-p01.svg`…). These are *not* auto-pruned — nothing references them once the series.json entries are gone.
5. **Non-code follow-ups**: `README.md:29-30` ("Five sample series ship with the repo, so there is something to read immediately"); `docs/CATALOGUE.md:135-136, 305-306, 324, 339-340` uses `lamplighter` and `ashfall` as its worked examples; `worker/src/lib/allowlist.js:32-37` justifies the Gutenberg/Standard Ebooks static entries as "shipped in the sample catalogue".

**Risk to flag:** the fixture source exists precisely as the offline floor — "If every network source is down, the app still has something to open" (`scraper/src/sources/fixture.js:1-6`). With the fixtures gone and MangaDex/Flame Comics currently yielding 0-chapter or missing entries, a bad scrape leaves the app with only Gutenberg. Note also that `validate.js` does **not** fail on an empty catalogue (it only counts and reports, `:284-296`) despite the workflow header claiming it does (`.github/workflows/scrape.yml:8`), so an empty catalogue would pass CI and reach users as the `catalogError` empty state (`js/catalogue.js:1472-1484`).

### 4.3 Do the tests depend on the bundled series? **No — nothing breaks.**

- The four browser harnesses (`test/importer.test.html`, `novel-reader.test.html`, `goals.test.html`, `platform.test.html`) load only `js/config.js`, `js/store.js`, `jszip.min.js` and the module under test — **`catalogue.js` is never loaded**, `catalog.json` is never fetched, and no `fixture:*`/`gutenberg:*` id appears in any of them. The catalogue is stubbed (`test/goals.test.html:161`, `test/novel-reader.test.html:184`).
- `test/fixtures/catalog.json` uses entirely **synthetic** ids (`md:fixture-manga-1`, `fc:fixture-manhwa-1`, `gutenberg:fixture-ln-1`, `user:fixture-ln-2`, `wn:fixture-wn-1`, plus a deliberate no-id/no-type legacy row) — none overlap the bundled ids. It also appears to be **orphaned**: a repo-wide search finds no consumer, and it has one commit (`dfa73a6`).
- `worker/test/fixtures/*` are hand-written HTML pages for adapter tests; no relationship to the bundled catalogue.
- The only true coupling is `sw.js:59` (`/catalog.json` and `/chapters/` are the network-first "data" class) — path-based, so unaffected.

---

## 5. Home screen structure — exact sections and rendering

### 5.1 Static markup (`index.html`)

`#home-screen` (`:71`) = `#home-header` (`:72-98`: logo, `#home-search`, `#offline-badge`, `#go-offline-btn`) + `#home-body` (`:99-112`), which ships with only three children:

1. `#home-state` — spinner + "Loading library…" (`:100-103`)
2. `#latest-section` (`display:none`) — `.home-section-label` "Latest Updates" + `#latest-updates-list` (`:104-107`)
3. `#series-section` (`display:none`) — `.home-section-label` "All Series" + `#series-grid` (`:108-111`)

The comment at `js/catalogue.js:637-641` is the governing rule: index.html only guarantees pre-existing containers; **everything else is built by `ensureDom()` and inserted**.

### 5.2 Runtime DOM order inside `#home-body`

`ensureDom()` (`js/catalogue.js:645-675`) calls, in order, `buildTabs`, `buildContinue`, `buildGoalsSlot`, `buildGridToolbar`, `buildEmptyState`, `buildSeriesExtras`, `buildToast`. Resulting child order:

| # | Node | Built at | Insertion |
|---|---|---|---|
| 1 | `#home-state` | index.html | — |
| 2 | `#cat-tabs` (role=tablist, 5 buttons from `TABS`) | `:677-704` | `insertBefore(bar, homeState.nextSibling)` — `:698` |
| 3 | `#cat-continue-section` (`.home-section-label` "Continue reading" + `#cat-continue-rail`) | `:719-734` | `insertBefore(section, latestSection)` — `:733` |
| 4 | `#goals-home-slot` (empty div; goals owns its contents) | `:740-745` | `insertBefore(slot, latestSection)` — `:744` |
| 5 | `#latest-section` | index.html | — |
| 6 | `#series-section` → label, `#cat-grid-toolbar`, `#series-grid`, `#cat-empty` | toolbar `:747-818` (`insertBefore(bar, seriesGrid)` `:817`), empty `:820-841` (appended `:840`) | — |

The goals slot is documented as "a fixture, not a feature" (`:736-739`) — `js/goals.js:1608-1638` fills it and tolerates its absence.

### 5.3 How rendering is driven

`renderHome()` (`:1088-1133`) is the single render pass and does everything imperatively with `style.display`:

- `#home-state` → `none`; `#cat-tabs` → `flex` (`:1095-1096`)
- `syncTabs(tab)` (`:1135`), `syncLayout()` (`:1146` — toggles `.cat-layout-grid`/`.cat-layout-list` on the grid)
- `renderContinue()` (`:1175-1221`) — **always called**; hides its own section when `progressRows` (max 12, `:1044`) has no row whose `seriesId` resolves (`:1179-1181`).
- **Latest** is conditional: `showLatest = !searchQuery && tab !== 'library' && list.length > 0` (`:1104`); `renderLatest(list)` (`:1280-1325`) sorts by `latestDate` and slices to **15**.
- Section label text switch (`:1109-1114`), `#cat-add-series` shown only on `library` (`:1115`), count text incl. chunk tally (`:1119-1124`), toolbar forced `flex` (`:1129`).
- `renderGrid(list, tab)` (`:1329-1355`) — chunked at `GRID_CHUNK = 200` (`:43`) with a "Show more" row; each card is `novelCard` (`:1405`) or `mangaCard` (`:1378`) via `isTextSeries` (`:194`).
- `renderEmpty(list, tab)` (`:1463-1510`).

### 5.4 Implications for the two planned features

**Reorder/hide sections** — there is no ordering abstraction today; order is baked into the `insertBefore` calls in `ensureDom`. Two clean options: (a) give `#home-body` `display:flex; flex-direction:column` and drive CSS `order` from a pref, leaving DOM insertion untouched; (b) replace the six `insertBefore` calls with a declarative section registry keyed by id, and have `ensureDom` append in pref order. Either way visibility is already per-section (`continueSection.style.display` `:1180-1181`, `latestSection` `:1105`, `seriesSection` `:1108`) so hiding is a one-line guard per section in `renderHome`. Store the layout in `prefs` next to `catalogue.tab`/`catalogue.layout` (`:82-83`, backed by `js/store.js:562-573`).

**Focus selector (books vs comics)** — the type split already exists in two forms: `TEXT_TYPES = new Set(['lightnovel','webnovel'])` (`:33`) with `isTextSeries()` (`:194`), and the `TABS` list. A focus pref would most naturally (i) reorder/relabel `TABS` (`:25-31`), (ii) change the *default* tab returned by `currentTab()` (`:82`), (iii) bias `renderLatest`'s sort/slice (`:1285-1291`), and (iv) possibly swap the card renderer default at `:1341`. Note `matchesTab` folds `webnovel` into the `lightnovel` tab (`:1071`) — a books-focus mode wants that same union, so the predicate already exists.

---

## 6. Reader back-navigation, and where an edge-swipe-suppression change lands

### 6.1 Two readers, two close paths, one router

**Router**: `Catalogue` owns navigation (`js/catalogue.js:4-6`). `navStack` (`:62`), `pushScreen` (`:2104-2107`), `goBack` (`:2138-2149`) — pops, and returns to `series-screen` if that is now on top (also re-reading progress via `refreshSeriesProgress`, `:2127-2136`), else `goHome()` (`:2109-2120`). `openChapter` pushes *two* entries — the underlying screen, then `'reader'` (`:1933-1934`), with the reason documented at `:1929-1932`. Screen visibility itself is `showScreen(id)` in `js/reader.js:380-388` (sets `document.body.dataset.screen`, which every back handler reads).

**Image reader (`#reader-screen`)**:
- Visible affordance: `#close-btn` in the header — `index.html:144-150` (a small diamond/arrows glyph, not a conventional back chevron).
- Two independent listeners fire on that click: `js/reader.js:2096-2105` (revokes object URLs, clears `pages`/`chapters`, `showScreen('series-screen')` when `readerOrigin === 'series'`, else **`location.reload()`**), and `js/catalogue.js:2187-2193` (flushes progress, then `refreshSeriesProgress`). `readerOrigin` is set to `'series'` at `catalogue.js:2054`.
- Note this path calls `showScreen` directly rather than `goBack()`, so `navStack` is not popped by an image-reader close.

**Novel reader (`#novel-screen`)**:
- Visible affordance: the header back button built at `js/novel-reader.js:343` (`iconBtn('Close reader','back')`, chevron glyph at `:408`), wired at `:2133` → `api.close()`.
- `close({navigate})` (`:2454-2482`) flushes progress, tears down observers/timers/listeners, hides the root (kept registered, `:2474-2476`), then `navigateAway()` (`:2510-2513`) → `Catalogue.goBack()`.

**Android hardware back** — the dispatch table is `App.addListener('backButton', …)` in `js/platform.js:778-800`, keyed on `document.body.dataset.screen`:

| screen | action |
|---|---|
| `novel-screen` | `NovelReader.close({navigate:true})` — `:781-785` |
| `reader-screen` | synthesises `#close-btn.click()` so **both** listeners run — `:786-791` |
| `home-screen` / `upload-screen` | `App.minimizeApp()` — `:792-795` |
| anything else | `Catalogue.goBack()` — `:796-798` |

The rationale (readers must exit through their own close paths, not a raw `goBack`) is at `platform.js:774-777`. Screens **not** in the table — `series-screen`, `import-screen`, the goals screen — all fall to the default branch.

### 6.2 iOS edge-swipe and touch CSS today

**There is no edge-swipe handling of any kind, and no History API integration anywhere.** Confirmed by search: zero `popstate`, zero `history.pushState`, zero `allowsBackForwardNavigationGestures` in `js/`, `index.html`, `capacitor.config.json` or `native/`. This is a known, documented gap: `docs/mobile/understanding/catalogue.md:98` ("No History API / popstate anywhere. Navigation is invisible to the browser/OS") and `:181` ("…iOS edge-swipe similarly does nothing today"). `capacitor.config.json` sets only StatusBar/SplashScreen/Keyboard.

Existing touch/overscroll CSS — the complete set:

| Rule | Location |
|---|---|
| `html, body { overscroll-behavior: none }` | `styles.css:17` |
| `.cat-tabs, .cat-rail { overscroll-behavior-x: contain }` (+ `-webkit-overflow-scrolling: touch`) | `css/catalogue.css:110-119` |
| `.nv-viewport { overscroll-behavior: contain }` (+ deliberate `overflow-anchor` opt-out) | `css/novel.css:245-250` |
| `#novel-screen[data-mode='paged'] .nv-zones { touch-action: none }` | `css/novel.css:858`, rationale at `:843-847` |
| `-webkit-tap-highlight-color: transparent` on `#home-screen/#series-screen` and `.nv-zone` | `css/catalogue.css:67-69`, `css/novel.css:855` |

**`touch-action` appears exactly once** — on the novel reader's paged tap-zone overlay, and only in paged mode. Scroll and endless mode leave the gesture to the browser. The novel reader's own horizontal swipe is a `pointerdown`/`move`/`up` drag with `setPointerCapture` (`js/novel-reader.js:2153, 2284-2331`), slop/velocity thresholds and a `suppressClickUntil` guard (`:2320`). The image reader has essentially no touch handling — one `touchstart` for idle reset (`js/reader.js:2001`) and a passive scroll listener (`:838`).

### 6.3 Where a "suppress edge-swipe-back inside reader + easy home affordance" change lands

**Suppressing the swipe.** On iOS/WKWebView the edge-swipe is a *native* gesture; CSS `touch-action` will not reliably stop it, so this is genuinely two changes:

- *Web/PWA side*: extend the `touch-action` pattern from `css/novel.css:858` to the reader roots — i.e. `#novel-screen`/`#reader-screen` (or at least their left/right edge strips) get `touch-action: pan-y` — and consider promoting `overscroll-behavior: none` (currently only on `html, body`, `styles.css:17`) to `overscroll-behavior-x: none` on the reader containers. The novel reader's horizontal drag (`novel-reader.js:2291-2301`) is the thing this protects; today it competes with the OS gesture in paged mode.
- *Native side*: the real fix is `webView.allowsBackForwardNavigationGestures = false` on the iOS `WKWebView`. There is no code owning this today (`native/` holds only the `or-zip` plugin; the iOS project is generated locally per `package.json`/`docs/mobile/NATIVE_BUILD.md`), so it needs either a documented step in the native build guide or a tiny plugin. Worth noting: with `allowsBackForwardNavigationGestures` off, the gesture disappears app-wide, not just in the reader — a per-screen toggle would need a bridge method alongside the existing `Platform` surface (`js/platform.js:844-864`).

**The "easy home affordance".** The natural landing spots, in order of least surprise:

- **Novel reader** — add a second header button beside the existing back chevron in `js/novel-reader.js:343-350` (the `header.append(back, titles, settingsBtn)` line), wired like `:2133` but calling `Catalogue.goHome()` (`js/catalogue.js:2109`, exported at `:2311`) after `api.close({navigate:false})` so teardown still runs.
- **Image reader** — `index.html:144-150` is the `#close-btn`; a sibling button in `#reader-header` is the symmetric change. Careful: image-reader close currently bypasses `goBack()` entirely (`js/reader.js:2098-2104`) and `location.reload()`s when `readerOrigin !== 'series'` (`:2103`), so a "home" button must not reuse that handler — it should call `Catalogue.goHome()`, which already resets `navStack` and `window.readerOrigin` (`catalogue.js:2111-2113`).
- **Hardware-back parity** — whatever new exit is added should be reflected in the `platform.js:778-800` dispatch table so Android back and the on-screen affordance agree. Also worth filling the table's gaps (`series-screen`, `import-screen`) while touching it.
- **A History-API layer** (making `navStack` visible to the OS so edge-swipe *works* rather than being suppressed) is the larger alternative; it is flagged as the underlying design gap at `docs/mobile/understanding/catalogue.md:181`, and would touch `pushScreen`/`goBack` (`js/catalogue.js:2104-2149`) plus every direct `showScreen` caller.
