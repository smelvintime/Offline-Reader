# Phase 7 — The Reader's App: focus, sources, tutorial, presets, thoughts, themes, navigation

This is the **binding roadmap** for Phase 7. Implementation agents build exactly what a
section specifies; the checker holds the tree to the acceptance criteria; the docs agent
applies §11's contract amendments to `docs/ARCHITECTURE.md` at the end. Everything here
was planned against the landed Phase 1–6 tree (`docs/mobile/PLAN.md` §13) and the
verified feasibility research in `docs/mobile/understanding/sources-research.md` — line
references in that file are the ground truth for features 2, 4, 11 and 12; do not
re-derive them.

Twelve features. None may be dropped. Defaults in this plan are **decisions**, not
suggestions — implement them as written; deviations go to the completion log with
rationale, exactly like PLAN.md §13.

---

## 0. Non-negotiables carried forward (all of PLAN.md §0 stays in force)

1. **Zero-build web app.** Plain `<script>` tags, vanilla ES2020, IIFE classic scripts
   exporting one `window.*` global each, `python3 -m http.server` works after every
   round. No bundler, no framework, no transpile, no ES modules.
2. **Script load order is contract** (`index.html`, ARCHITECTURE §2). reader.js keeps
   its historical shape (no IIFE, no `'use strict'`). Phase 7 extends the order — see
   §1.1 — and that extended order becomes contract.
3. **The XSS boundary is absolute.** All third-party prose — chapter text, titles,
   filenames, source-site listings, **and the reader's own saved thoughts** — renders
   via `textContent` only. New SVG generation (feature 8) uses `createElementNS` with
   zero string interpolation of content.
4. **Module ownership.** Each module owns exactly its JS + CSS (+ test page). Cross-file
   needs are the minimal named edits this plan lists under the owning agent. New
   modules follow the goals.js pattern: own JS + own CSS, `registerScreen` at init,
   DOM built at init, navigation only through `Catalogue.*`, persistence only through
   `Store`.
5. **The goals-absent/app-runs rule extends to every new module.** With any one of
   `js/covers.js`, `js/thoughts.js`, `js/sources.js`, `js/settings.js` deleted, the app
   boots and runs exactly as without that feature: every cross-module reference is
   guarded (`window.X && typeof window.X.y === 'function'`), every slot stays empty,
   every button is simply not rendered. The checker verifies boot with each module
   individually removed.
6. **iOS first**, iPad second, Android third; nothing may break Android or the plain
   web build. On-device gates that need the user's hardware are documented in
   TESTING.md, never silently assumed (the §13 precedent).
7. **Memory budget PLAN.md §9 is still binding.** Every feature below states its memory
   effect. Phase 7 changes no tuning rows, no windows, no caps, and must not touch the
   "never optimize away" list (150 ms defer, `el.src=''`, soft-window kept-src, explicit
   min loop, append-only + scrollTop compensation).
8. **Store never rejects for expected conditions; prefs stay synchronous.** The
   in-memory fallback grows every new Store method (feature 7). New pref keys are
   validated on read like `novel.*`.
9. **One `sw.js` cache bump for the whole phase**: `cbz-reader-v5.07` → **`cbz-reader-v5.08`**,
   with `SHELL_ASSETS` gaining every new shipped file (§1.1). Single delivery, single bump
   (the §13 deviation-1 convention).
10. **Design language.** Dark-first tokens with fallback literals, 10px radius, 44px tap
    floor, `tabular-nums` numerals, bottom sheets (24px top radius, scrim 0.5, docked
    panel ≥720px), `aria-pressed` segments, `:active` scale 0.97, hover only inside
    `(hover:hover)`, `prefers-reduced-motion` blocks, safe-area `env()` padding on every
    fixed edge, ≤2 concurrent backdrop-blur layers, amber-for-prose / indigo-for-images.
    `docs/mobile/understanding/design.md` §9 is the checklist for every new sheet/screen.
11. **Carry-forwards honored where they fit:** `Platform.zip` gains the `{ cachePath }`
    source form so zip-of-CBZs stops falling back to the 600 MB blob path (§2.11-C); the
    disabled CapacitorHttp `proxyImageUrl` seam in platform.js **stays disabled and
    unchanged** this phase.

---

## 1. New surface at a glance

### 1.1 Module map delta (extended load order — becomes ARCHITECTURE §2)

```
js/config.js
js/platform.js
js/store.js
js/covers.js        window.Covers    (pure SVG generator, no screen)   — agent: catalogue
jszip.min.js
js/reader.js
js/novel-reader.js
js/importer.js
js/goals.js
js/thoughts.js      window.Thoughts  (thoughts-screen + end-of-book UI) — agent: thoughts
js/sources.js       window.Sources   (sources-screen + home shelf)      — agent: sources
js/settings.js      window.AppSettings (settings-screen + theme engine + focus sheet) — agent: settings
js/catalogue.js
```

`covers.js` is dependency-free and loads before reader.js (it needs no
`registerScreen`). `thoughts.js` / `sources.js` / `settings.js` load
after reader.js (they register screens) and before catalogue.js (which boots).
`settings.js` applies the app theme **at parse time** (documentElement attribute +
custom properties from prefs) so the first paint is already themed. Every one of the
four is deletable per §0.5.

New screen ids: `thoughts-screen`, `sources-screen`, `settings-screen`.
New CSS files: `css/thoughts.css` (prefix `tho-`), `css/sources.css` (prefix `src-`),
`css/settings.css` (prefix `set-`). `covers.js` has no stylesheet — consumers style the
`<svg>` in their own sheets.

`sw.js` `SHELL_ASSETS` additions: `./js/covers.js`, `./js/thoughts.js`,
`./js/sources.js`, `./js/settings.js`, `./css/thoughts.css`, `./css/sources.css`,
`./css/settings.css`.

`index.html` additions (integrator, R1): the four new `<script src>` tags in the §1.1
order, inserted into the existing end-of-body script block (index.html:219-230
convention — plain tags, no `defer`), **and three `<link rel="stylesheet">` tags in
the head** — `./css/thoughts.css`, `./css/sources.css`, `./css/settings.css` —
appended after the existing `./css/goals.css` link (index.html:16-20 order
convention). Without the links the three new screens ship unstyled and the entire
app-theme engine (which lives in `css/settings.css`) is dead; the §8.5 checker diffs
both lists against §1.1.

### 1.2 New preference keys (consolidated; all validated on read, per-series via the
existing `getFor` only where stated)

| key | values | default | writer / readers |
| --- | --- | --- | --- |
| `app.focus` | `books` \| `comics` \| `both` | `both` (unset = never chosen → offer sheet once) | settings writes; catalogue reads |
| `app.theme` | `dark` \| `dim` \| `black` \| `light` \| `cream` \| `sepia` \| `tan` \| `nord` \| `forest` \| `custom` | `dark` | settings writes+applies; platform reads (status bar) |
| `app.customBg` / `app.customFg` | `#rrggbb` (`/^#[0-9a-fA-F]{6}$/`) | `#0a0a0a` / `#f0f0f0` | settings |
| `home.sections` | JSON array of `{id, on}` over ids `continue`, `goals`, `sources`, `latest`, `series` (order = render order; unknown ids dropped on read, missing ids appended in default position, `on` coerced boolean; **`series` is reorderable but never hideable — its `on` is coerced `true` on read**) | unset → **focus-derived** (§2.1 effect 2): `books`/`both` → `[continue, goals, sources, latest, series]` (today's order); `comics` → `[continue, latest, goals, sources, series]`. Once written, the stored array wins and focus never touches it again | settings writes; catalogue reads (catalogue also reads `app.focus` for the unset default) |
| `novel.presets` | JSON array ≤ 6 of `{ name: string ≤ 40 chars, prefs: object of novel.* values }` (each value re-validated through the existing readPrefs validators at apply time) | `[]` | novel-reader |
| `thoughts.chapterPrompt` | boolean | `false` | thoughts writes (toggle on thoughts-screen); novel-reader reads (guarded) |
| `goals.lifetime` | JSON `{ seconds, words, pages, chapters, books: finite Numbers ≥ 0, since: "YYYY-MM-DD" }`. **Numeric rule (binding): fractions are valid** — `words` is accumulated as a float (`pctDelta × wc`, exactly like dayLog words, goals.js:634-643) and stored unrounded; rounding happens only at display. Malformed = missing key, non-finite or negative number, wrong type, or bad `since` — only then re-seed from dayLogs (unknown extra keys are ignored, never malformed — an additive future field must not nuke totals). **A pref that parses with non-integer numbers is VALID and must never re-seed** (a literal ints-only validator would re-seed on every read, destroying deltas and resurrecting cleared history) | absent until seeded | goals only (single writer, like dayLogs) |
| `sources.saved` | JSON array ≤ 24 of `{ url: http(s) string, title: string ≤ 80, host: string, addedAt: ISO }`; invalid entries dropped on read. **Cap 24 refuses, never evicts**: the 25th save is rejected with the toast "Shelf is full — remove a source first." (the `novel.presets` cap-6 behavior; no cap in this app silently destroys user data) | `[]` | sources |

All ride the existing `or.prefs` blob → they are **natively mirrored for free** (§2.3
pref durability) — deliberate for `goals.lifetime` and `sources.saved`.

### 1.3 New Store API (contract amendment — exact signatures)

`DB_VERSION` **2 → 3**; the upgrade handler additionally creates object store
`thoughts` (`keyPath: 'id'`, index `seriesId`), creating only what is missing, as v2 did.

```js
await Store.listThoughts({ seriesId, limit })  // → Thought[] desc by createdAt.
                                               //   Both filters optional; {} lists all.
await Store.putThought(thought)                // → Thought. Stamps id ('t-' +
                                               //   Date.now().toString(36) + '-' + 4 rand
                                               //   chars) when absent, createdAt when
                                               //   absent, updatedAt always. Upsert by id.
await Store.deleteThought(id)                  // → resolves undefined; missing id is a no-op.
```

`Thought`:

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

The in-memory fallback implements all three methods as a Map table (§0.8).
**`Store.deleteUserSeries` does NOT cascade to thoughts** — a thought is the reader's
writing, not series data; `seriesTitle` is denormalized so it still renders after the
series is gone. Documented as a deliberate non-cascade.

### 1.4 New events (registry amendment)

| event | dispatched by | detail |
| --- | --- | --- |
| `or:thoughts-changed` | thoughts.js after any put/delete | `{ id }` \| `{ deleted: id }` |

Theme, focus, layout and preset changes all ride the existing `or:prefs` event. Sources
rides the existing `or:library-changed`. Same rules as ARCHITECTURE §2.5: dispatch in
try/catch, listeners tolerate absent dispatchers.

---

## 2. Per-feature specifications

Legend per feature: **Build** (what), **Files** (exact touches; owner in §9 table),
**Accept** (checker gates), **No-change** (regression tripwires).

### 2.1 Feature 1 — Focus selector (books / comics / both)

**Build.** Pref `app.focus` (§1.2). Guided defaults, never a lockout — every tab and
feature stays reachable regardless of focus.

- **First-run sheet** (settings-owned): `AppSettings.maybeOfferFocus()` shows a bottom
  sheet once when `app.focus` is unset — three option cards (Books / Comics / Both),
  each a large tappable card with an inline SVG glyph in the diamond family (amber book
  spine / indigo panel grid / the diamond logo for Both), one line of copy each, and a
  footer note "You can change this any time in Settings." Below the cards: a secondary
  button **"Start with the tour"** that closes the sheet and opens the tutorial book
  (`Catalogue.getSeries('fixture:welcome')` → `Catalogue.openSeries`, guarded; the
  button is **rendered only when `getSeries('fixture:welcome')` returns a row** — a
  catalogue that lost the tutorial shows the sheet without a dangling tour button).
  Dismissing the sheet (scrim tap / close) writes `both` — it never re-prompts.
  Catalogue calls the hook exactly once, after the first successful `renderHome()`,
  guarded: `window.AppSettings && typeof AppSettings.maybeOfferFocus === 'function'`.
  Never offered when boot lands on `upload-screen`.
- **Changeable in settings**: the settings screen's first row is a 3-way segmented
  "Focus" control (aria-pressed segments) writing the same pref.
- **Effects (all read-time, catalogue-owned — the user named three: default tab,
  section emphasis, card style; all three ship, plus empty-state copy). The shared
  principle is the `currentTab()` pattern: focus shapes *defaults while the reader has
  not chosen*; an explicit choice persists and focus never overrides it.**
  1. **Default tab**: `currentTab()`'s fallback (used only while `catalogue.tab` is
     unset) becomes focus-derived: `books` → `lightnovel`, `comics` → `manga`,
     `both` → `all`. The moment the user taps a tab, `catalogue.tab` persists and focus
     no longer influences it.
  2. **Section emphasis (default home order)**: while `home.sections` (§1.2, feature
     12) is **unset**, the validating getter returns a focus-derived default order —
     `comics` promotes **Latest updates** to directly under Continue (serialized comics
     reading is release-driven; new chapters earn the higher slot): `[continue,
     latest, goals, sources, series]`. `books`/`both` keep today's order `[continue,
     goals, sources, latest, series]` — the existing order is already books-shaped
     (continuity-first), which is why books does not shift. Catalogue reads `app.focus`
     itself inside the getter (no settings.js dependency); the moment feature 12's
     editor writes the pref, the stored array wins forever. Exact comics ordering is
     tunable — §12.5.
  3. **Card style (default renderer bias)**: the grid's card renderer choice at the
     research's `:1341` site (`isTextSeries(s) ? novelCard : mangaCard`) gains a
     focus bias **for untyped series only**: under `books` focus, a series whose
     `type` is neither in `TEXT_TYPES` nor in `{'manga','manhwa'}` renders as a
     `novelCard` (spine) instead of today's `mangaCard` default. Typed series NEVER
     change card style under any focus; `comics`/`both` keep today's default. This is
     the research §5.4(iv) sketch, scoped to the only genuinely ambiguous case —
     grid renderer only (rails are uniform rows and unaffected).
  4. **Empty-state copy** (`renderEmpty`): comics-flavored guidance on the `manga`/
     `manhwa` tabs ("No comics here yet. Bring your own — add a source you like, or
     import CBZ files."), with buttons wired guarded to `Sources.openScreen()` and
     `Importer.openDialog()`; books-flavored guidance on `lightnovel`/`library`
     mentioning EPUB import and the tutorial. Copy is app-authored, `textContent`.
  - Focus hides no tab and no section; it never reorders a `home.sections` the user
    has written (effect 2 is a *default*, exactly like effect 1).

**Files.** `js/settings.js` + `css/settings.css` (sheet + row); `js/catalogue.js`
(fallback tab, focus-derived `home.sections` default inside the §2.12 getter,
untyped-series card bias, empty-state copy, one guarded hook call).

**Accept.** Fresh profile → sheet appears once after home renders; choosing Comics then
relaunching lands on the `manga` tab **with Latest rendered directly under Continue**;
tapping the `all` tab persists and survives relaunch; writing `home.sections` via the
feature-12 editor then switching focus does NOT reorder home; an untyped series (test
fixture with no `type`) renders as a spine card under `books` focus and a manga card
under `both`; deleting `js/settings.js` **on a fresh profile** → no sheet, no errors,
`all` default and today's home order (a previously-written `app.focus` still steers
the fallback tab and default order — catalogue reads the pref directly; that is the
intended read-time design, stated here so the checker does not misread it); sheet
meets design.md §9 (radius 24 top, scrim, focus trap, reduced-motion block).

**No-change.** `TABS` membership and order; `matchesTab` semantics; `catalogue.tab`
validation list; the upload-screen offline boot path.

### 2.2 Feature 2 — Sources (client half; worker half in §3)

**Build.** A saved-sources shelf + a browse view that feeds the existing add-by-link
confirm flow. Scope and mechanics exactly per `sources-research.md`.

- **`js/sources.js` → `window.Sources`** (IIFE), screen `sources-screen`, CSS
  `css/sources.css` prefix `src-`. Public API:

  ```js
  window.Sources = {
    openScreen(),        // record return screen, showScreen('sources-screen')
    close(),             // Catalogue.goBack() (importer precedent)
  }
  ```

- **Saved sources**: pref `sources.saved` (§1.2). "Add a source" = a URL input row on
  sources-screen; saving normalizes the URL, derives `host`, and prompts for an
  optional short title (default = host). **Normalization is shared, not twinned**:
  the importer agent promotes its `normalizeUrl` (importer.js:296 — scheme check,
  lowercased host, credentials/fragment dropped, tracking params stripped, params
  sorted, trailing slashes trimmed) from `_internals` to a **public `Importer.
  normalizeUrl`** (one named line in the API object at :3633; it stays in `_internals`
  too). sources.js calls it guarded; with `Importer` absent it falls back to a minimal
  local normalize (http(s) check + lowercase host + strip hash/credentials) that only
  ever serves save-and-bookmark mode — Importer absent also means no gateway helpers,
  so browse and the "In library" badge are off anyway and dedupe merely degrades
  gracefully. One implementation ⇒ no drift between saving, the badge, and the ids
  the importer mints. Cap behavior per §1.2: **the 25th save is refused with a toast**,
  nothing is evicted. Sources are just bookmarks with superpowers — saving never hits
  the network.
- **Home shelf**: catalogue's `ensureDom` builds an EMPTY `<div id="sources-home-slot">`
  after the goals slot (exactly the `buildGoalsSlot` pattern, catalogue.js:740-746 —
  the slot is a fixture, contents are sources-owned). sources.js fills it: a horizontal
  rail of source cards (title + host + a small diamond glyph) and a trailing "Add a
  source" card that opens `sources-screen`. Empty `sources.saved` + gateway on → the
  slot shows a single quiet "Add an online source" card. Module absent → slot stays
  empty (invisible).
- **Slot fill trigger (the mechanism, named — mirroring what goals.js actually does):**
  sources.js loads before catalogue boots, so at sources init the slot does not exist
  yet. goals solves this with `renderSlot()` that early-returns when
  `#goals-home-slot` is absent (goals.js:1610-1612), re-invoked from (a) a
  **`MutationObserver` on `document.body`'s `data-screen` attribute** whose handler
  calls `renderSlot()` on every transition **to `home-screen`** (goals.js:763-788 —
  `if (s === 'home-screen') renderSlot()` — observer wired at :1753-1757; catalogue's
  boot ends in `showScreen('home-screen')` *after* `ensureDom` built the slots, so
  this observer is the guaranteed first fill), and (b) `or:goals-changed` /
  `or:library-changed` listeners (goals.js:1739-1740). sources.js copies this
  verbatim: its own `data-screen` MutationObserver (fill on entering `home-screen`),
  plus re-render on `or:prefs` with `key === 'sources.saved'` (and the `key === null`
  bulk-reload case) and on `or:library-changed`; one guarded `renderSlot()` at init is
  harmless (early-return, same as goals). No new events, no polling, no catalogue
  hook.
- **Browse view**: tapping a source card runs `GET <workerBase>/list?url=<saved url>`
  (§3). Results render as a card grid — covers via the `/image` proxy path, for which
  **sources.js carries its own local `safeImageUrl` + `imgUrl` twins**: catalogue's
  originals are IIFE-private, and twin copies kept in sync are the codebase's
  established pattern for exactly these helpers (PLAN.md §8 amendment 13's
  "URL-scheme validators… keep in sync" list; twins already live in importer.js:180
  and novel-reader.js:193 — sources' twin joins that keep-in-sync list, and the
  ARCHITECTURE amendment §11-A13 records it). `onerror` → `Covers.element` fallback, guarded; title
  `textContent`; each card tappable → **`Importer.openDialog({ url: item.url })`** —
  the deep-link path; the existing confirm screen does the rest, unchanged. Items
  already in the library (probe `Store.getUserSeries` by the importer's id rule? No —
  sources must not re-implement id hashing: instead compare `Importer.normalizeUrl`
  output against `sourceUrl` on `Store.listUserSeries()` rows — the same function that
  produced those stored values) render an "In library" badge and open via
  `Catalogue.openSeries`. A `nextUrl` in the response renders a "More" row that
  fetches the next page (append, chunked at 60 cards).
- **Capability + failure honesty**: on first use per session, sources probes
  `GET /health` and caches `canList = adapters.some(a => a.canList)`; `/list` returning
  `not_found` (old worker) or the probe failing sets `canList = false`. When listing is
  unavailable for a source (422 `no_adapter`, `list_failed`, or `canList` false), the
  browse view shows an honest card: "We could not read this site's catalogue. Open the
  site, find a series page, and use Add by link." with two buttons: "Open site"
  (`<a target="_blank" rel="noopener">`, `safeHttpUrl`-checked) and "Add by link"
  (→ `Importer.openDialog()`).
- **Gateway off** (`Importer.isGatewayEnabled` false, or `Importer` absent →
  `window.gatewayUrl('/list')` null): the home slot renders nothing when `sources.saved`
  is empty; with saved sources it renders the rail where each card opens sources-screen
  in **link mode** — the `#imp-gateway-off` card pattern: a muted explainer "Browsing
  sources needs the content gateway, which is switched off here." naming
  `OR_CONFIG.workerBase`, and each saved source rendered as a plain external-link card.
  Nothing pretends to work.

**Files.** `js/sources.js`, `css/sources.css` (new); `js/catalogue.js`
(`buildSourcesSlot` + registry id `sources`); worker files in §3.

**Accept.** Save a source → shelf card appears (and survives relaunch via prefs); a
25th save refuses with the shelf-full toast and leaves `sources.saved` untouched;
browse a listing fixture through a local worker → cards render → tapping one lands on
the importer confirm screen pre-filled; commit → back in browse the item shows "In
library"; gateway off → honest cards, zero network calls to `/list`; delete
`js/sources.js` → empty slot, no errors. All listing strings render via `textContent`
(checker greps for `innerHTML` in sources.js — the only allowed hits are none).

**No-change.** The importer confirm/commit pipeline (`prepareUrl`/`commitDraft`
untouched by this feature — promoting `normalizeUrl` to the public API changes no
behavior); `or:library-changed` semantics; the KV allowlist growth rule except as
amended in §3.4; `Importer.openDialog({url})` signature.

### 2.3 Feature 3 — Lifetime counters

**Build.** All-time totals that survive "Reset goal history", owned end-to-end by
goals.js (it stays the single writer of reading metrics).

- **Accumulator**: pref `goals.lifetime` (§1.2). goals.js adds every fold delta it
  already computes — at the existing sites: seconds (session fold), `pctDelta × wc`
  words, page deltas, upload deltas, `chaptersCompleted` increments, book-finish events
  — into an in-memory `lifetime` object, persisted with the same debounce cadence as
  `persistDay` (piggyback the same call sites; a `prefs.set` is synchronous and cheap).
  **Numbers follow the §1.2 numeric rule**: `words` accumulates and persists as a
  float (the folds are fractional — goals.js:634-643); the validator requires finite
  ≥ 0, never integrality; display rounds (words to whole numbers via
  `toLocaleString`, hours to one decimal under 100).
- **Seeding**: at init, when the pref is absent or malformed (per the §1.2 definition
  of malformed — a parsed pref with fractional numbers is healthy), sum all existing
  dayLogs (`Store.listDayLogs({ limit: 4000 })`) into a fresh accumulator —
  `books` seeded as the **sum of `booksFinished.length`** across days (consistent
  with the per-day increment rule below) — with `since` = the earliest day found
  (today when none) and persist it. A `goals.lifetime` that parses clean is never
  re-seeded — resets are the reader's, not the app's. (Honest caveat, documented in
  the code: a re-seed reconstructs from what dayLogs kept; because the existing
  engine suppresses same-period re-finish rows in later day logs, a re-seed is a
  floor, not an exact replay of live accumulation.)
- **Books semantics (decided): one increment per book per local day, decoupled from
  the goal period.** The existing `foldBookFinish` (goals.js:596-603) dedupes both
  per day (`day.data.booksFinished.indexOf`) and per goal period
  (`finishedThisPeriod.has`, rebuilt from the period window at aggregation,
  goals.js:536-543) — piggybacking lifetime on its success path would make an
  *all-time* ledger depend on the *current goal period length*, which is a mutable
  setting (incoherent for a lifetime total). Instead: at the `foldBookFinish` call
  sites, lifetime keeps its own per-day dedup set (cleared on day rollover, the
  `day.counted` idiom) and adds 1 when `isBookFinish` passes and the id is in neither
  that set nor `day.data.booksFinished`. `foldBookFinish` itself, dayLog contents,
  and the period stat are byte-identical to today. Re-reading a book on a later day
  counts again. Documented as intended: lifetime measures finish events (reading
  done), the period stat measures distinct titles per period.
- **Reset semantics**: "Reset goal history" (existing) clears dayLogs and **keeps
  lifetime** — that is the point of the separate accumulator. A new, separate action
  row "Reset lifetime totals" (own `askConfirm`, danger styling) zeroes the object and
  sets `since` = today.
- **Display**: goals-screen gains an **"All time"** section under the existing period
  stats — the `.cat-stats`-style tile strip (value 1rem/800/tabular-nums + uppercase
  0.6rem label): **Hours read** (`seconds/3600`, one decimal under 100), **Words**,
  **Pages**, **Chapters**, **Books** — plus a muted "since <date>" line. No home-slot
  change (the slot stays today-focused).
- `Goals.state()` gains a `lifetime` snapshot (copy) for the test page.

**Files.** `js/goals.js`, `css/goals.css`, `test/goals.test.html`.

**Accept.** goals.test.html: seed-from-dayLogs (books = sum of lengths),
delta accumulation across a simulated fold, survival across `clearDayLogs`,
malformed-pref re-seed, **fractional-words pref parses as valid and does NOT re-seed**
(the regression the §1.2 numeric rule exists for), same-day double finish → lifetime
+1, later-day re-finish inside one goal period → lifetime +2 while the period stat
stays 1 (per-day semantics), reset-lifetime zeroing. UI: tiles use `tabular-nums`;
section renders (with zeros) when no history.

**No-change.** DayLog shape and single-writer rule; every existing fold edge case
(PLAN.md §5.1) — lifetime observes the same deltas, it must not alter them; the reset-
history confirm copy gains one clarifying clause ("Lifetime totals are kept.") and
nothing else.

### 2.4 Feature 4 — Remove the sample series (one story with feature 5; full story §4)

Summary here for the feature list; the coherent removal+tutorial narrative, file
inventory and validate.js guard are specified in **§4**.

### 2.5 Feature 5 — The tutorial book (content brief in §5)

Summary here; pipeline + brief in **§4–§5**. The book is a normal `fixture` series
(`fixture:welcome`, dir `chapters/fixture_welcome/`) written as blocks JSON in
`scraper/fixtures/welcome.json` with a committed cover `welcome.cover.svg` (the
reader-silhouette design of the feature-8 family, indigo/amber). It is the **new
offline floor**: `validate.js` fails a catalogue that ships no bundled chapter files
— and specifically one whose enabled `fixture:welcome` ships none (§4.4 guard (c));
its content shape is CI-enforced by `check-welcome.js` (§4.4b).

### 2.6 Feature 6 — Reader-mode presets

**Build.** One-tap bundles over the EXISTING `novel.*` pref keys — no new settings
system, no new theme tokens.

- **Presets row** at the top of the novel settings sheet (before the mode segRow): a
  horizontally scrollable chip rail (`.nv-row` + a `.nv-presets` strip;
  `overscroll-behavior-x: contain` like `.cat-rail`). Each chip is a `<button>` painted
  in its preset's theme colors (inline `style.background/color` from the preset's
  values — the `THEME_SWATCHES` idiom) and set in its preset's face via the existing
  `data-font` specimen mechanism. Built-ins, exact values (all inside §3.1 ranges):

  | preset | mode | font | size | lh | width | align | para | indent | track | word | theme |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Classic paperback | paged | literata | 19 | 1.6 | normal | justify | tight | true | 0 | 0 | cream |
  | Night scroll | infinite | sans | 18 | 1.75 | narrow | left | normal | false | 0 | 0 | black |
  | Dyslexia-friendly | chapter | dyslexic | 20 | 1.9 | narrow | left | loose | false | 0.06 | 0.24 | cream |
  | Dense terminal | chapter | mono | 15 | 1.5 | wide | left | tight | false | 0 | 0 | forest |
  | Large print | paged | atkinson | 26 | 1.8 | normal | left | normal | false | 0.02 | 0.08 | light |

  (Custom themes are never part of a built-in; `customBg/customFg` are untouched by
  preset application unless a saved custom preset recorded them.)
- **Application semantics**: `applyPreset(map)` captures the anchor ONCE, writes every
  key through the existing per-series `storeSet` path (presets apply to THIS series,
  like every sheet edit; the existing "Apply to all series" row generalizes), runs one
  `applyPrefs()` + `layout()` + `settleLayout(anchor)` batch (the `setMode` pattern —
  never one relayout per key), rebuilds for mode when the mode changed, then
  `settleWhenFontLands`. A toast names the preset. Presets are **starting points**: no
  "active preset" state is stored; tweaking a knob afterwards is normal and tracked by
  nothing.
- **Save my current setup**: a trailing "+ Save current" chip swaps the row for an
  inline mini-form (text input prefilled "My preset N", Save / Cancel; input
  `scrollIntoView` on focus — the known iOS keyboard-overlap risk is accepted and
  noted; at ≥720px the sheet is a side panel and unaffected). Saving snapshots the
  CURRENT effective prefs (post-`readPrefs`, i.e. what the reader sees) into
  `novel.presets` (§1.2, cap 6 with toast). Custom chips render after built-ins with a
  small `×` delete affordance (44px hit area via the `::after` pad pattern) +
  `askConfirm`-free immediate delete with an undo toast (single-level undo held in
  memory).
- Preset names are third-party strings: `textContent` everywhere, length-clamped 40.
- Image reader: **no presets** — its two knobs (gap, autoscroll) stay global-and-
  persistent per PLAN.md §11.9. Stated, not built.

**Files.** `js/novel-reader.js`, `css/novel.css`, `test/novel-reader.test.html`.

**Accept.** Tapping a preset changes every bundled key in one relayout (test asserts ≤1
`layout()` via a counter in `api.state()` or DOM mutation observation), keeps the
anchor (same block visible), persists per-series; save-current round-trips through the
pref (validated on read; a hand-corrupted `novel.presets` entry is dropped silently);
delete works; `test/novel-reader.test.html` adds suites for apply-batch, save/load
validation, and name-XSS (a `<script>`-looking name renders inert).

**No-change.** The §3.1 key list and ranges (no new `novel.*` keys except
`novel.presets`); `readPrefs` validation; anchor capture/restore discipline; sheet
open/close a11y (`inert`, focus trap); the existing rows' order below the new presets row.

### 2.7 Feature 7 — Depart your thoughts

**Build.** A quiet space to leave reflections when closing a book. Not "notes" — the
UI says **"Depart your thoughts"** / "Leave a thought". Module `js/thoughts.js` →
`window.Thoughts`, screen `thoughts-screen`, CSS `css/thoughts.css` (`tho-`).

```js
window.Thoughts = {
  openScreen(),                      // the reading surface (record return screen, showScreen)
  close(),                           // Catalogue.goBack()
  open({ seriesId, seriesTitle, chapterId, chapterTitle, kind }),
                                     // open the composer sheet prefilled with context.
                                     //   kind: 'book' | 'chapter'
}
```

- **Cadence (decided).** Always offered at **book end**; per-chapter prompting exists
  but is **off by default** behind `thoughts.chapterPrompt` (§1.2; toggle lives on
  thoughts-screen: "Also ask at the end of every chapter"). The user's own instinct —
  every chapter is too often — is the default.
- **Book-end triggers, two surfaces:**
  1. **Novel reader (in-place, the beautiful path):** in `fillSection`, immediately
     after the existing `.nv-end` element on the last chapter, novel-reader appends a
     quiet `.nv-thoughts-cta` button ("Depart your thoughts") — guarded on
     `window.Thoughts`, styled exclusively with `--nv-*` tokens so all ten themes skin
     it, appended AFTER the block list (never inside `blockEls` — anchor indices are
     sacred). Click → `Thoughts.open({ …series/chapter…, kind: 'book' })`. When
     `thoughts.chapterPrompt` is true, a smaller text-button variant also follows the
     bottom `chapterNav` of every non-final chapter (`kind: 'chapter'`).
  2. **Image reader (event-driven, zero reader edits):** thoughts.js listens to
     `or:progress`; when a row flips `completed` true on the series' **last** chapter
     (the goals §5.1 book-finished rule verbatim: `row.completed && row.chapterId ===
     last chapter id` via `Catalogue.getSeries`, guarded; `chapterNum === chapterCount`
     only as last resort), and `document.body.dataset.screen === 'reader-screen'`
     **exactly** (never a broader "is a reader screen" test: `novel-screen` also
     qualifies as one, and novel completion also flows through `store.js`
     `putProgress` → `or:progress` with `completed: true` — store.js:402 — so a loose
     condition would stack this chip on top of the novel surface's own inline
     `.nv-thoughts-cta`, a duplicate affordance), it
     shows its own floating chip "Depart your thoughts" docked **bottom-LEFT** (the
     autoscroll bar owns bottom-center, the goals pill bottom-right — §2.4 precedent:
     solid `rgba(18,18,18,0.92)`, radius 100px, no backdrop-filter, safe-area padded).
     The chip auto-dismisses on screen change or after 12 s, dedupes per series per
     session, and is created lazily (no DOM cost until a book ends).
- **Composer**: a bottom sheet (house pattern: scrim, 24px top radius, `inert`
  backdrop, focus trap, ≥720px side panel) with the series title as header, a muted
  date line, one `<textarea>` (auto-grow, `maxlength` 4000), Save / Discard. Keyboard
  overlap: `scrollIntoView` on focus; accepted risk, same note as feature 6. Saving
  writes `Store.putThought` and dispatches `or:thoughts-changed`; a **tappable** toast
  confirms — "Kept. Tap to read your thoughts." — built by thoughts.js itself (the
  goals `buildToast` pattern, rendered as a `<button>`), tap → `Thoughts.openScreen()`,
  auto-dismiss unchanged.
- **Reading surface** (`thoughts-screen`): header (back, "Your thoughts"), a list of
  thoughts newest-first, grouped by series (group header = seriesTitle + count), each
  row showing date + kind chip + the text (`textContent`, `white-space: pre-wrap`),
  with Edit (reopens composer with the row) and Delete (confirm) actions. Empty state:
  dashed-border card in the house voice ("When you finish a book, we will ask what it
  left behind. Nothing yet."). Chunked at 100 rows with a "Show more" row (DOM ceiling
  discipline).
- **Entry points**: settings-screen row "Your thoughts" (guarded both directions) AND
  the tappable post-save toast above — the toast is thoughts-owned, so **saved
  thoughts stay reachable with `js/settings.js` deleted** (without it, the settings
  row would be the only door and the composer would write into a room with no
  entrance). That is still deliberate quietness — no home section, no toolbar button.
- **Export**: `Importer.exportLibrary` gains an additive `thoughts` array
  (`Store.listThoughts({})`, all rows, both `includeChapters` modes — thoughts are tiny
  text); `importLibrary` upserts them idempotently by id when the array is present.
  Backup format `version` stays 1 (additive optional field; old builds ignore it).
  The automatic native backups (§5 backup triggers) therefore carry thoughts with no
  further change. `or:thoughts-changed` is added to the importer's debounced
  backup-trigger listeners (same 1 min debounce as commits).

**Files.** `js/thoughts.js`, `css/thoughts.css`, `test/thoughts.test.html` (new);
`js/store.js` (§1.3); `js/novel-reader.js` (CTA appends, guarded); `js/importer.js`
(export/import + backup trigger); `js/settings.js` (entry row).

**Accept.** Finish a novel → CTA under the end marker → composer → saved row appears on
thoughts-screen and in `exportLibrary().thoughts`; **no floating chip ever appears on
`novel-screen`** (finishing a novel must not stack chip + inline CTA); finish an image
series → chip appears once; with settings.js deleted, save → tap toast →
thoughts-screen opens; chapter cadence only when toggled on; edit/delete round-trip;
`importLibrary` with a thoughts array restores them; XSS test: a thought of
`<img onerror=…>` renders as text (test page asserts no element creation); Store
fallback passes the same round-trip with IndexedDB unavailable; delete `js/thoughts.js`
→ no CTA, no chip, no settings row, zero errors.

**No-change.** `renderBlock` index stability and `blockText` parity (the CTA lives
outside the block list); `scrollPct` geometry (CTA sits below the last prose block —
the measure targets prose blocks, verify no shift in the completed threshold test);
`or:progress` shape; exportLibrary's existing fields and session-local-URL scrubbing.

### 2.8 Feature 8 — Default covers

**Build.** `js/covers.js` → `window.Covers` (IIFE, no screen, no CSS file):

```js
window.Covers = {
  element(seriesOrId, opts)   // → SVGSVGElement — a complete generated cover.
                              //   opts: { className } applied to the root svg.
                              //   Accepts a Series or a bare id string.
  designIndex(id),            // → 0..6 (exposed for tests/determinism checks)
}
```

- **Seven designs, one family** — the diamond logo's geometric language (rotated
  squares, thin rules, small dots, flat fills, no gradients beyond two-stop):
  1. **Sapling** — one stem, three diamond leaves.
  2. **Orchard row** — three small diamond-crown trees on a ground rule.
  3. **Conifer** — five stacked, tapering diamonds.
  4. **Fern** — an arc of small diamonds along a curved stem.
  5. **Seed & sprout** — a large diamond seed below a horizon rule, a sprout above.
  6. **Grove at night** — two tall thin trees, a scatter of dot stars.
  7. **The reader** — a side-on silhouette of a seated figure with an open book,
     built from geometric primitives (circle head, angular shoulders/knees, an open-V
     book), on a diamond-motif ground. (This design, in indigo/amber, is also the
     hand-committed tutorial-book cover — the family's origin story.)
- **Deterministic**: FNV-1a over the series id → `design = h % 7`,
  `hue = ((h >>> 3) % 12) * 30`. Palette per cover (self-contained; unaffected by app
  theme): bg `hsl(hue 32% 15%)`, field `hsl(hue 28% 22%)`, figure
  `hsl(hue 45% 70%)`, accent `hsl((hue+40)%360 50% 55%)`. A series keeps its cover
  forever (id-stable). **The dark-leaning palette under feature 9's light shell
  themes is intended, not an oversight**: a cover is content artwork, like a real
  cover image — real covers do not repaint when the shell theme changes, and neither
  do generated ones; identity beats blending. They sit inside cards on a light theme
  exactly as a dark real cover would.
- **No text inside the SVG** — titles/authors already render beside/below covers in
  every card; the generator therefore interpolates **zero content strings**
  (`createElementNS` + numeric/enum attributes only; trivially `textContent`-safe),
  works offline, costs ~1–2 KB of DOM per card.
- **Adoption** (each consumer guards `window.Covers`):
  - catalogue: `placeholder()`, `spineFallback()`, `heroPlaceholder()`, and the
    continue/latest rail `onerror` handlers append `Covers.element(series, { className:
    'cat-cover-svg' })` in the `<img>` slot instead of the gradient div; catalogue.css
    sizes `.cat-cover-svg` (`width/height: 100%; display: block;` + the spine radius on
    novel cards). Guard absent → today's gradient placeholder, unchanged.
  - importer confirm view: cover fallback uses `Covers.element` the same way
    (`imp-cover-svg`).
  - image-reader upload library rows: **not adopted** (no series id; out of scope,
    stated).

**Files.** `js/covers.js` (new, catalogue agent), `js/catalogue.js`,
`css/catalogue.css`, `js/importer.js`, `css/importer.css`.

**Accept.** A coverless series shows the same design+hue on home card, continue rail
and series hero, across reloads; two different ids differ (spot check); zero network;
grep: no `innerHTML` in covers.js; delete `js/covers.js` → gradient placeholders
return, zero errors.

**No-change.** Real covers' render path (`safeImageUrl` → `imgUrl` → lazy `<img>`);
card DOM ceilings; the placeholder gradient code stays as the guard fallback (do not
delete it).

### 2.9 Feature 9 — App-wide color themes

**Build.** The shell (home, series, upload, importer, goals, settings, sources,
thoughts screens) becomes themeable with the reader's own model: named palettes + a
two-color custom theme derived via `color-mix()`. The novel reader keeps its
independent `novel.theme`; the image reader deliberately stays dark (§ below).

- **Engine (settings-owned, `css/settings.css` + parse-time JS):**
  - settings.js, at parse time (before DOMContentLoaded): read `app.theme` (+ custom
    colors) via `Store.prefs`, set `document.documentElement.dataset.apptheme` and, for
    `custom`, inline properties `--bg`/`--text` + `data-applum` (luminance rule copied
    from the novel custom theme). Subscribes `Store.prefs.on` for live re-apply,
    **key-gated**: re-apply runs only when the emitted `detail.key` is `null` (bulk
    reload) or starts with `app.` — `or:prefs` now also fires at `persistDay` cadence
    for `goals.lifetime` (§2.3), and theme re-application plus the meta theme-color
    mutation must not run on every goals flush. Also updates `<meta
    name="theme-color">` content to the theme's bg at apply time (only when the
    applied theme actually changed).
  - `css/settings.css` defines, under `html[data-apptheme]` (any value), the **derived
    layer** — the app-wide equivalents of the novel custom-theme derivation:

    ```css
    html[data-apptheme] {
      --muted:       color-mix(in srgb, var(--text) 58%, var(--bg));
      --surf-1:      color-mix(in srgb, var(--text) 4%,  transparent);
      --surf:        color-mix(in srgb, var(--text) 8%,  transparent);
      --surf-2:      color-mix(in srgb, var(--text) 13%, transparent);
      --border:      color-mix(in srgb, var(--text) 14%, transparent);
      --border-soft: color-mix(in srgb, var(--text) 8%,  transparent);
    }
    ```

    and per named theme the base triple + status/semantic anchors:
    `--bg`, `--text`, `--accent`, `--accent-ink`, `--prose` (the amber family's
    anchor), `--ok`, `--warn`, `--danger`. The **nine** named palettes reuse the novel
    themes' exact bg/fg/accent values (design.md §theme table; THEMES list at
    novel-reader.js:58) for `dark`, `dim`, `black`, `light`, `cream`, `sepia`,
    **`tan` (#e3d2b0 / #3a2c17 / #8a4f16 — the aged-paperback palette)**, `nord`,
    `forest` — the full novel set, none dropped, so "reuse the novel themes" is true
    without an asterisk. The light themes (`light`, `cream`, `sepia`, **`tan`**)
    darken the semantic colors for contrast (e.g. `--prose: #8a6d1f`, `--ok:
    #15803d`, `--danger: #b91c1c`). `custom` supplies only `--bg`/`--text` from JS;
    accent by `data-applum` (`dark` → `#8b93ff`, `light` → `#4f46e5`).
  - **No attribute set → today's app, byte-for-byte**: `styles.css`'s `:root` block
    remains the dark default; the derived layer only exists under `[data-apptheme]`.
    settings.js absent → attribute never set → permanent dark, as now (§0.5).
- **Module re-pointing (one-time edits, each owner in their own sheet):** every
  hard-coded white-alpha/status literal that must flip with the theme is re-pointed at
  the derived tokens **with its current literal as the fallback**, e.g. catalogue.css
  `--cat-surf-1: var(--surf-1, rgba(255,255,255,0.04))`, `--cat-accent-ink:
  var(--accent-ink, #a5b4fc)`, `--cat-novel: var(--prose, #fbbf24)`; importer.css
  `--imp-danger: var(--danger, #f0616d)` etc.; goals.css and thoughts/sources/settings
  sheets likewise (the new sheets consume the derived tokens from birth). styles.css
  re-points its shell-scoped colors (home/upload/series surfaces, notices) the same
  way.
- **Readers:**
  - `#reader-screen` (image) is **pinned dark**: reader agent adds explicit literals
    (`#reader-screen { background: #0a0a0a; }` + its chrome colors) so a light app
    theme never bleaches the comic surround. Documented as intended: reading surfaces
    are reader-themed; the shell is app-themed.
  - `#novel-screen` already self-themes via `--nv-*`; untouched.
- **Native chrome**: platform.js listens to `or:prefs` for `app.theme` and sets
  StatusBar style dark/light by theme luminance (bg of the nine named palettes is
  known — dark set: dark/dim/black/nord/forest; light set: light/cream/sepia/tan;
  custom uses `data-applum`). `manifest.json` colors stay `#0a0a0a` (splash is
  boot-time; acceptable, noted).
- **UI**: settings-screen "App theme" section — swatch grid in the novel `themeRow`
  design (buttons painted in their own palette, `aria-pressed`), **all nine named
  swatches incl. tan** + custom swatch + two color inputs shown only when custom. One
  line of copy: "The reader has its own themes, inside the book."

**Files.** `js/settings.js`, `css/settings.css`; re-pointing edits in
`css/catalogue.css` (catalogue), `css/importer.css` (importer), `css/goals.css`
(goals), `styles.css` (reader); `js/platform.js` (status bar); `index.html` meta is
mutated at runtime only.

**Accept.** Switching themes live repaints home/series/importer/goals with no reload
and no layout shift; `light` theme: text contrast ≥ 4.5:1 on surfaces (spot-check
values); image reader stays dark under `light`; novel reader unaffected; relaunch
paints themed with no dark flash (parse-time application); delete settings.js →
permanent dark; `custom` bg/fg validated (`#zzz` falls back).

**No-change.** The amber/indigo semantic split (never the same color anywhere — verify
under every theme); blur-layer budget (theming adds zero blur layers); `novel.theme`
tokens and values; manifest colors; `:root` default token values in styles.css.

### 2.10 Feature 10 — Purchased books (honest import path; posture in §6)

**Build.** Importer-owned guidance + friction removal for DRM-free purchases. **No DRM
circumvention, ever** — §6 is binding copy-and-conduct.

- The add view gains a third card under "Open a file": **"Books you've bought"** — a
  muted informational card: "Bought a book? If your store lets you download a DRM-free
  EPUB or CBZ, it opens here like any other file." with a disclosure row **"Where is my
  file?"** expanding an app-authored, `textContent` store list (per-store copy in §6.2,
  verbatim). Two buttons: "Open a file" (focuses the existing picker flow) and a link
  to Project Gutenberg ("Free classics, no lock") via `safeHttpUrl` +
  `rel="noopener"`.
- File intake already covers the paths: `Platform.pickFiles({ accept:
  '.epub,.txt,.cbz,.zip' })` + hidden input + web `?add=` share target + deep link —
  verify the accept strings on both importer buttons include `.epub` (fix if not; one
  attribute).
- No new prefs, no new endpoints, no ACSM/`.acsm` handling of any kind: an `.acsm`
  file, if picked, produces the honest error toast "That is a DRM license file, not a
  book. We can only open DRM-free files." (extension check in `importFile`'s type
  sniff, before parsing).

**Files.** `js/importer.js`, `css/importer.css`; tutorial chapter 5 cross-references
this card (§5).

**Accept.** Card renders (also when gateway off — it is file-based); disclosure list
matches §6.2 copy; `.acsm` → honest toast, no parse attempt; `.epub` reachable from
both pickers.

**No-change.** EPUB parsing budgets (1.5 MB/image, 8 MB/chapter); `xhtmlToBlocks`
boundary; file identity hash (`name.toLowerCase() + ':' + size`).

### 2.11 Feature 11 — Reader navigation (edge-swipe, back parity, home affordances)

Research base: sources-research.md §6. Three sub-parts, each decisive:

**A. History sentinel layer (catalogue-owned — the honest scope).**
A **one-entry sentinel**, not a mirrored stack — one back gesture = one `goBack()`.
At most one sentinel entry can exist because every `pushState` is gated on an `armed`
bit, and the one async hole is closed by queueing (below); the layer is
**self-healing**: every `popstate` routes against the LIVE `data-screen`, so a
transient mismatch resolves on the next event rather than accumulating.

- Boot: `history.replaceState({ or: 'root' }, '')`.
- State: two booleans, `armed` and `disarming`.
- A `MutationObserver` on `document.body`'s `data-screen` attribute (the app's one
  navigation signal, set by `showScreen`) arms the sentinel: entering any screen other
  than `home-screen`/`upload-screen` with `!armed && !disarming` →
  `history.pushState({ or: 'sentinel' }, '')`, `armed = true`. Returning to
  `home-screen`/`upload-screen` with `armed && !disarming` → `disarming = true` +
  `history.back()` so the resulting `popstate` is swallowed.
- **The disarm race, handled**: `history.back()` is async — its `popstate` arrives a
  tick later. While `disarming` is true the observer must **not** push (the gate
  above); when the swallowed `popstate` lands, the handler clears `disarming`, sets
  `armed = false`, then **re-checks the live screen**: if the user already re-entered
  a non-root screen while the back was in flight, it arms now (single `pushState`).
  Arming is therefore queued through the swallowed popstate, never doubled.
- `popstate` handler (catalogue): first the disarm path above; otherwise dispatch on
  live `document.body.dataset.screen`:

  | screen | action |
  | --- | --- |
  | `novel-screen`, `reader-screen` | **cancel**: re-arm (`pushState`) and do nothing — a swipe never exits a reader |
  | `loading-screen` | **cancel**: re-arm and do nothing — a transitional screen (catalogue shows it between series and reader, catalogue :1913/:2000); it resolves to a reader on its own, and tearing it down mid-fetch from a gesture helps nobody |
  | `import-screen` | `window.Importer && Importer.close()` else `Catalogue.goBack()` |
  | `goals-screen` | `window.Goals && Goals.close()` else `goBack()` |
  | `settings-screen` | `window.AppSettings && AppSettings.close()` else `goBack()` |
  | `sources-screen` | `window.Sources && Sources.close()` else `goBack()` |
  | `thoughts-screen` | `window.Thoughts && Thoughts.close()` else `goBack()` |
  | `series-screen` | `Catalogue.goBack()` |
  | root screens | mark unarmed; do nothing |

  After routing, the MutationObserver re-arms/disarms naturally. Forward gestures stay
  inert (there is never a forward entry) — documented limitation, not a bug. No URL
  changes, no hash routing, no deep links via history (out of scope, stated).
- What this buys, honestly: browser/PWA back button and **iOS Safari/PWA edge-swipe**
  now navigate one screen back everywhere except inside readers, where they are
  cancelled. **Cancelled, not invisible**: on iOS Safari/PWA the OS plays its native
  swipe transition against a page *snapshot* BEFORE `popstate` fires, so an
  edge-swipe inside a reader shows a visible slide of a stale snapshot that then
  snaps back when the cancel path re-arms — a flicker, not a silently swallowed
  gesture. That artifact is the honest price of same-document history on iOS; it is
  cosmetic (no teardown, no state change), it is exactly why B keeps the native
  WKWebView gesture off, and it gets its own on-device TESTING.md row (§8.7).
  Android's hardware back continues through the native dispatch (B) and never touches
  this layer.

**B. Native gesture posture (iOS — a first-class trade-off, decided here, user veto
in §12.2) + Android parity (platform-owned).**
- **iOS native — the two real options, with their real costs.** The user asked for
  edge-swipe "suppressed ONLY inside readers, standard outside"; on the
  first-priority platform the two ways to honor that both compromise somewhere:
  - **Option 1 — gestures ON + sentinel routing**: set
    `allowsBackForwardNavigationGestures = true` and let layer A route. Cost: every
    swipe navigation in the native app animates against WKWebView's stale
    same-document snapshots (the A artifact, now on every screen, on the flagship
    platform); the reader-cancel flicker becomes part of the core feel; behavior is
    device-timing-dependent and only verifiable on hardware.
  - **Option 2 — gestures OFF (WKWebView default) + header affordances (C)**: readers
    are protected *by construction*, no snapshot artifacts anywhere — but **the
    native iOS app then has NO edge-swipe outside readers either**: series, importer,
    goals, settings, sources, and thoughts screens navigate only via their header
    back/close buttons and the C home buttons. This partially inverts the "standard
    outside readers" half of the request on the platform §0.6 ranks first; the
    sentinel layer (A) then only ever serves Safari/PWA.
  - **The decision: Option 2.** A stale-snapshot animation on every navigation is a
    worse everyday feel than reaching for the header, and a device-timing-dependent
    reader-protection dance is the kind of fragility this codebase refuses. This is
    a genuine deviation from the user's words, taken knowingly — it is listed in
    §12.2 for veto, and the Accept below states the native consequence plainly
    rather than hiding it. If the user vetoes, Option 1 is the fallback, gated on
    on-device verification (the §13 precedent), with the artifact documented in
    TESTING.md.
  - `docs/mobile/NATIVE_BUILD.md` gains a short "Back gestures" appendix stating the
    default is deliberate and load-bearing, presenting this same trade-off, with the
    per-screen-toggle plugin sketch parked as future work behind on-device
    verification.
- **Android hardware back** (platform.js dispatch table, §2.2): fill the gaps with
  explicit rows, every branch guarded — `import-screen` → `Importer.close()`;
  `goals-screen` → `Goals.close()`; `settings-screen` → `AppSettings.close()`;
  `sources-screen` → `Sources.close()`; `thoughts-screen` → `Thoughts.close()`;
  `series-screen` → `Catalogue.goBack()` (now explicit). Reader rows and the
  minimize-at-root rows are unchanged. This table and A's popstate table are the same
  semantic table — ARCHITECTURE §2.2 will carry it once, both dispatchers cite it.
- **Carry-forward (platform + reader):** `Platform.zip.list(src)` /
  `Platform.zip.extract(src, …)` accept a third source form `{ cachePath }` — a
  RELATIVE path under the app cache dir (the `pageUrl` root), `..`-rejected, resolved
  natively inside the container (or-zip's existing outside-container rejection
  applies). reader.js's zip-of-CBZs native path then extracts the inner archive to
  `Cache/pages/import-inner/…` and indexes it via `zip.list({ cachePath })`, removing
  the 600 MB-blob fallback for nested zips (§13 deviation 7 closed). Web behavior
  unchanged (null).

**C. Home affordances in both readers (unobtrusive, symmetric).**
- **Novel reader**: a second header icon button after the back chevron —
  `iconBtn('Home', 'home')`, a small diamond-with-baseline glyph in `ICON_PATHS`. Click
  → `api.close({ navigate: false })` (full teardown + final flush) then
  `Catalogue.goHome()` (guarded). 44px target, same `.nv-btn` styling.
- **Image reader**: `index.html` adds `<button class="icon-btn" id="home-btn"
  aria-label="Home">` with the same diamond-home SVG next to `#close-btn` (integrator
  edit, exact snippet); reader.js wires it: run the close-path teardown (revoke, clear
  `pages`/`chapters`, `el.src=''` discipline) **without** `location.reload()`/screen
  choice, then `window.Catalogue && Catalogue.goHome()`; catalogue wires its own
  `#home-btn` listener to flush image progress first (`syncImageProgress(true)` +
  `refreshSeriesProgress`), mirroring its `#close-btn` listener — the two-listener
  pattern is the contract. **Upload-origin sessions: the button is hidden.** reader.js
  sets `#home-btn` display on session start: shown only when `readerOrigin ===
  'series'`, mirroring the `#close-btn` special-case (reader.js:2099-2107 deliberately
  `location.reload()`s when origin is not `series` — in an upload-origin or
  catalogue-error boot, `goHome()` would land on home-screen's error/empty state,
  worse than the upload screen the reader came from). The novel reader needs no
  equivalent rule: novel sessions only open through the catalogue's series screen.
- **Touch/overscroll hardening (CSS, per research §6.3):** styles.css:
  `body[data-screen='reader-screen'] { overscroll-behavior-x: none; }` and
  `#reader-pages { touch-action: pan-y pinch-zoom; }`; novel.css: `.nv-viewport {
  overscroll-behavior-x: contain; touch-action: pan-y; }` for scroll modes (paged mode
  keeps its existing `touch-action: none` zones — verify the drag-to-turn still wins).
  Stated honestly: CSS cannot stop the OS-level Safari edge gesture — that is what A
  handles; this hardening stops in-page horizontal scroll chaining from competing with
  the novel drag and rubber-banding on iOS.

**Files.** `js/catalogue.js` (sentinel + popstate + `#home-btn` flush listener);
`js/platform.js` + `native/or-zip/` (+ NATIVE_BUILD.md) (table gaps, cachePath,
gesture appendix); `js/reader.js` + `styles.css` (home button wiring, CSS, nested-zip
path); `js/novel-reader.js` + `css/novel.css` (home button, CSS); `index.html`
(button markup); `test/platform.test.html` (cachePath form → null on web).

**Accept.** Web: browser back from series → home; back inside novel reader → reader
stays open (sentinel re-armed), no teardown, no console errors; back at home → (first
back after visits is consumed at most once) then default browser behavior; rapid
root↔non-root flapping never leaves two sentinel entries (the disarm-queue rule —
assert via `history.length` delta in a scripted check). **Native iOS: stated plainly —
with the B decision, the native app has NO edge-swipe back anywhere, readers or not;
back is the header affordances.** Both readers show the home glyph in series-origin
sessions; upload-origin image sessions hide `#home-btn` (and `#close-btn` reloads, as
today); tapping home from a mid-chapter session lands on home with progress flushed
(continue rail reflects the position) and no orphaned listeners (novel `api.isOpen()`
false; image reader globals cleared). Android emulator/device: hardware back exits
importer/goals/settings/sources/thoughts through their close paths. Nested-zip native
import on device uses zero JS archive bytes (TESTING.md protocol row added). Delete
any optional module → its popstate/back rows fall through to `goBack()` harmlessly.

**No-change.** The reader close paths' existing behavior (`#close-btn` semantics,
`location.reload()` for upload-origin close stays); `navStack` semantics;
`showScreen`/`registerScreen`; the §2.2 rule that readers exit only through their own
close paths — the sentinel *cancel* honors it by never exiting them at all.

### 2.12 Feature 12 — Home layout customization

**Build.** Reorder/hide home sections via prefs — the **section registry** option from
the research (chosen over CSS `order` because DOM order = focus/reading order; the
codebase's a11y bar is load-bearing).

- **Registry (catalogue):** `ensureDom`'s six `insertBefore` calls are replaced by an
  ordered build: the fixed frame is `#home-state` → `#cat-tabs` → *the five registry
  sections in pref order*. The registry, by id: `continue`
  (`#cat-continue-section`), `goals` (`#goals-home-slot`), `sources`
  (`#sources-home-slot`), `latest` (`#latest-section` — the one index.html-native
  section: it is *moved* (appendChild re-parents) into position, never rebuilt), and
  **`series` (`#series-section` — the user listed All Series among the customizable
  sections, and in an app whose soul is customization it is: REORDERABLE, but never
  hideable — `on` coerced `true` on read per §1.2; its internals — toolbar, grid,
  chunking, empty state — stay a sealed unit, untouched)**. `#cat-tabs` stays fixed
  above everything customizable because the tabs filter the whole home
  (`renderHome` passes the tab-filtered `visibleSeries()` to Latest and the grid
  alike — catalogue.js:1088-1107), not just the grid, so the bar is a page-level
  control, not a grid header. Order and visibility come from `home.sections` (§1.2;
  default focus-derived while unset, §2.1 effect 2) read through a validating getter;
  `on: false` sets `display: none` on the section root and short-circuits its render
  call in `renderHome` (renderContinue/renderLatest skip work when hidden — the
  existing per-section `style.display` writers must not fight the pref: each render
  fn's show/hide branch consults visibility first; `renderHome`'s unconditional
  `seriesSection.style.display = 'block'` writer is untouched — series is never
  hidden).
- **Live reorder:** catalogue listens for `or:prefs` `key === 'home.sections'` (and
  the `null` reload key) → re-appends the five section elements in the new order (they
  are singletons; re-append is O(5)) → `renderHome()`.
- **Editor (settings):** settings-screen "Home layout" section — one row per section
  (label + an eye/visibility toggle pill + ▲/▼ move buttons, all ≥44px,
  `aria-pressed` on the toggle, `aria-label`s "Move Continue reading up"); writes the
  whole pref array per interaction. The **All Series row shows the move buttons but
  no visibility toggle** — in its place a muted "always shown" note (the library is
  the home screen's reason to exist; hiding it is the one absurdity the editor
  refuses). Sections whose module is absent (goals deleted, sources deleted) still
  list, with a muted "(not installed)" note — the pref is data, the slot simply stays
  empty. A "Reset to default" text button restores the default (focus-derived) array
  by **clearing the pref**, not writing one — so the §2.1 effect-2 default applies
  again.
- Customization is the soul, guided: no free-drag, no per-card options — order +
  visibility, in the app's own control language.

**Files.** `js/catalogue.js`, `css/catalogue.css` (any section-margin normalization);
`js/settings.js`, `css/settings.css` (editor).

**Accept.** Reorder in settings → home reflects instantly (no reload) and after
relaunch; **All Series moved above Latest renders in that order, with tabs still
above everything and the grid machinery intact**; a pref attempting `series: false`
reads back as visible; hide Latest → section gone and `renderLatest` does no work (no
DOM churn); hidden Continue with rows present stays hidden; corrupt pref (`"x"`) →
default layout; screen-reader order matches visual order (DOM inspection);
settings.js deleted → default (focus-derived) order forever.

**No-change.** `#series-section` internals — the grid/toolbar/empty-state machinery
moves as one sealed unit, its insides untouched; the goals slot ownership rule (slot
is catalogue's, contents are goals'); the tabs bar (fixed frame); `renderHome`'s
single-pass render contract; the past display-leak tripwires (comment at the toolbar)
stay respected.

---

## 3. Worker changes for Sources (feature 2's gateway half — own section)

All file references per sources-research.md §1 (verified). Worker agent owns all of
`worker/`.

### 3.1 Optional adapter capability (§6.5 amendment)

Two **optional** adapter members — `isValid()` keeps requiring exactly the current
five fields (a malformed optional member of the wrong type IS a boot error):

```js
export async function listSeries(url, ctx) { … }
// → { source: { title, url }, items: [ { title, url, cover?, type? } ], nextUrl? }
//   items.url: absolute http(s) — the value the client feeds back into /resolve.
//   The listing NEVER mints series ids (the client and /resolve own id hashing).
//   type (optional): manga | manhwa | lightnovel | webnovel — a hint, never trusted.

export function listMatches(url) { … }   // optional; when absent, matches() gates listing
```

`listAdapters()` reports the capability; `/health`'s `adapterDetail` rows gain
`canList: boolean`.

**Adapter selection for /list:** iterate registered adapters in priority order; pick
the first where `typeof a.listSeries === 'function'` AND
(`typeof a.listMatches === 'function' ? a.listMatches(url) : a.matches(url)`). If none:
`no_adapter` (422). (In practice `generic-novel` lists everything, so 422 guards only
future registry configurations — per research item 3.)

### 3.2 Implementations

- **`_generic.js`**: `genericListSeries(url, ctx, opts)` shared by `generic-manga` /
  `generic-novel`. It rides a refactor of `worker/src/lib/extract.js`:
  `findTocCluster(root, baseUrl, opts)` becomes a thin wrapper over a new
  `findLinkCluster(root, baseUrl, { textPrior, navPenalty, … })` where the chapter-ish
  scoring is the pluggable prior (research §1.2's "one function away") — **existing
  fixtures must score identically** (extract.test.js locks this). The listing prior:
  reward count, href-prefix similarity, and an image (cover) inside the link container;
  no chapter-text reward; keep the nav-word penalty. Covers come from the first `<img>`
  in each link's container (absolutized; `data-src`/`srcset` first-candidate fallback,
  reusing the existing image-attr helpers in extract/meta). Titles from link text,
  trimmed/tidied, length-capped.
- **`mangadex.js`**: real listing via the API. `listMatches(url)`: host
  `mangadex.org`, path NOT `/title/<uuid>` or `/chapter/<uuid>` (root, `/titles*`,
  `/search*`). `listSeries`: map the URL's `q`/`title` param onto
  `GET https://api.mangadex.org/manga?limit=32&order[followedCount]=desc&availableTranslatedLanguage[]=en&includes[]=cover_art[&title=…]`,
  items → `{ title, url: 'https://mangadex.org/title/<id>', cover:
  'https://uploads.mangadex.org/covers/<id>/<file>.256.jpg', type: 'manga' }`,
  `nextUrl` from offset paging while `total` remains. Existing `matches()` untouched
  (resolve routing unchanged).

### 3.3 Endpoint

```
GET /list?url=<encoded catalogue/listing page URL>
→ 200 { ok: true, adapter: "<id>", source: { title, url }, items: [...], nextUrl? }
```

Handler (`handleList`, patterned on `handleResolve`'s first eight lines):
1. `checkRateLimit(request, 'parse', env)` — the **parse** bucket (30/60 s); listing is
   the same fetch-and-parse work class. No new bucket.
2. `assertSafeTarget(url)` — MANDATORY (handler-level, like all three current
   handlers); redirect re-validation per hop is inherited from the shared fetch path.
3. `selectListAdapter` per §3.1; debug `?adapter=` force param supported (parity with
   /resolve).
4. Caps: `LIST_LIMITS = { maxItems: 60, maxTitleChars: 200 }` — items sliced at 60,
   titles clamped; the HTML fetch reuses the existing generic byte/timeout caps
   (`GENERIC_LIMITS` class — same CPU posture as /resolve, per research §1.4).
5. Cover-host learning: `learnHosts(coverHosts, env, { max: MAX_LIST_LEARN })` with
   **`MAX_LIST_LEARN = 4`** — the real signature is `learnHosts(hosts, env, { max })`
   (allowlist.js:114; existing call sites `learnHosts(hosts, env)` at index.js:307/351)
   — see §3.4 for the write-budget mechanics.
6. Respond with `cacheSeconds: 300` + `X-Or-Adapter` header (the /resolve envelope
   conventions). Errors — using the codes the worker actually has, exactly as
   /resolve emits them from the shared paths: `no_adapter` 422, `list_failed` 422
   (adapter returned nothing/unusable), `bad_url` 400, `blocked_host` 403 (SSRF —
   security.js emits this, never an "unsafe_target"), `upstream_error` 502, `timeout`
   504, `rate_limited` 429 — existing envelope `{ ok:false, error, message }`.
   **`list_failed` is the only NEW code: it gets an `ERR` map entry `list_failed:
   422` in `worker/src/lib/respond.js`** (respond.js:9-24; without the entry,
   `fail()` degrades unknown codes to `internal_error`/500 — respond.js:64-72) plus
   the README error-code sync the ERR comment demands. Every other code above is an
   existing ERR entry; invent none.
7. Route added in `route()` alongside `/resolve`, and to the `/` service-descriptor
   `endpoints` array (research: that list is the discoverability contract). `/health`
   `version` bumped — that constant is **`VERSION` in `worker/src/lib/gateway.js:17`**
   (deliberately not in index.js; the comment at gateway.js:1-16 explains why), so
   gateway.js is a named touch of this feature.

### 3.4 The allowlist/cover decision (position taken)

**`/list` learns cover hosts, capped at 4 hosts per request** (`MAX_LIST_LEARN = 4`;
same KV mechanism, 30-day TTL, `hasKv()` no-op without a binding). Rationale: broken
thumbnails on every first browse mis-sells the whole feature, and listing pages almost
always serve covers from one CDN host.

**The write budget, honestly.** `learnHosts` skips only *statically* allowed hosts
(`isStaticallyAllowed`, allowlist.js:121) — an already-LEARNED host is re-`put` to KV
on every call. `/list` is a browse loop (pagination, repeated visits) on the 30/60 s
parse bucket, so without mitigation one active user re-browsing a source re-writes
the same 1–4 cover hosts on every page: 30 req/min × up to 4 puts ≈ 120 writes/min —
the free-tier 1,000 KV writes/day budget is gone in minutes, from one client, before
any abuse. Therefore `handleList` adds a **cheap in-isolate seen-host memo** in front
of `learnHosts`: a module-scope `Map` of host → last-put timestamp (the exact
`buckets` idiom from ratelimit.js:11, including the crude size-cap eviction), skipping
hosts put within the last ~6 h. Repeat browsing from a warm isolate then writes
nothing; the residual cost is one put-batch per cold isolate per host, bounded by
isolate churn — that residual arithmetic is what the README documents. `/resolve` and
`/chapter` keep their unmemoized calls (single-shot flows, not loops — out of this
feature's scope).

This **relaxes the stated invariant** — the amendment (§11-A8) rewrites it as: *"the
allowlist grows only via a successful `/resolve`, `/chapter`, or `/list` parse —
never via `/image` itself"* — and the `allowlist.js` header comment +
`worker/README.md` §allowlist are updated to match, with the memo and the residual
free-tier arithmetic noted. `/image` remains the only allowlist-GATED endpoint;
nothing else changes about it.

### 3.5 Worker tests

- `worker/test/endpoints.test.js`: new `/list` describe — SSRF rejection
  (private/IP-literal target → `blocked_host` 403, the existing /resolve envelope),
  rate-limit 429 on bucket exhaustion, `no_adapter`
  force-param case, success shape against a new listing-page fixture
  (`worker/test/fixtures/listing-page.html`: ~20 same-shaped series links with covers
  + nav noise), items ≤ 60, cover-host learning capped at 4 (KV mock), **repeat /list
  calls in one isolate do not re-put memoized hosts (KV mock put-count assertion)**,
  no-KV silent no-op, `list_failed` responses carry status 422 (the ERR entry, not
  internal_error/500), `/` descriptor includes `/list`.
- `worker/test/adapters.test.js`: the "§6.5 interface" test learns the two optional
  members (absent OR function — anything else fails); mangadex `listSeries` against a
  mocked API response; generic listSeries against the fixture.
- `worker/test/extract.test.js`: `findLinkCluster` refactor — all existing
  `findTocCluster` fixture expectations unchanged, plus the listing-prior case.

---

## 4. Sample removal + tutorial book — one coherent story

The five fixtures existed as the offline floor ("if every network source is down, the
app still has something to open" — fixture.js:1-6). Phase 7 replaces that floor with
one book that earns its place: the tutorial. The scraper/fixture pipeline is the
delivery vehicle and **stays fully intact** — only the sample content goes.

**Content agent owns:** `scraper/**`, `chapters/**`, `catalog.json`, `docs/CATALOGUE.md`.

1. **Remove from `scraper/series.json`:** the five `"source": "fixture"` entries
   (lamplighter, ninth-bell, floor-zero, still-water, ashfall), the **four `mangadex`
   entries** and the **five `flamecomics` entries** (three md entries ship 0 chapters,
   flame ships nothing — they are exactly the "auto-populated feel" this feature
   removes, and a fresh install fronting licensed manga it cannot honestly serve is the
   wrong first impression). **Keep the six `gutenberg` entries** (public-domain text,
   §8-compliant, genuinely readable offline) — this retention is its own open
   question, §12.6: the user's floor language ("the tutorial as the floor") can be
   read as *only* the tutorial, and either reading is a one-line series.json edit —
   and **add** the `fixture` entry
   `{ "source": "fixture", "id": "welcome", "type": "lightnovel", "enabled": true,
   "_note": "The tutorial book — the offline floor. Every chapter teaches a feature in place." }`.
2. **Delete `scraper/fixtures/`** sample files: the five `*.json`, five `*.cover.svg`,
   and the `ashfall/` directory (`build-pages.mjs` + page SVGs). **Add**
   `scraper/fixtures/welcome.json` + `scraper/fixtures/welcome.cover.svg` (the
   reader-silhouette cover, hand-committed, indigo/amber duotone in the diamond
   family).
3. **Regenerate:** run the scraper (`node scraper/src/index.js`) so `catalog.json` is
   rewritten and `pruneOrphanDirs()` deletes `chapters/fixture_*` while writing
   `chapters/fixture_welcome/`. Commit the regenerated tree (catalog.json +
   chapters/). Gutenberg dirs persist unchanged (failure policy: if the Gutenberg
   fetches fail at build time, their previous entries carry over — run with network).
   Result: bundled catalogue = **the tutorial book + six public-domain classics**, all
   text, all fully offline.
4. **`scraper/src/validate.js` — the offline-floor guards** (closing the research's
   CRITICAL flag that validate only counts): `validateCatalog` gains three ERRORS
   (not warnings): (a) `series` array empty → `"empty catalogue — nothing would
   ship"`; (b) `rep.seenFiles.size === 0` → `"no bundled chapter files"`; (c) **the
   guard that enforces what the floor actually means**: no enabled series with id
   `fixture:welcome` shipping ≥ 1 checked chapter file → `"the tutorial book is
   missing — the offline floor and the focus sheet's tour depend on it"` (tracked
   per-series while chapter files are walked; guard (b) alone is satisfied by the six
   Gutenberg series and would ship green with the tutorial silently gone while
   feature 1's "Start with the tour" dangles — (c) is why the tour button is also
   render-guarded, §2.1). All fail CI (`npm run validate` exits 1), making
   `.github/workflows/scrape.yml`'s header claim true at last. Unit-style assertions
   if a validate test exists; otherwise the report path is exercised by running
   validate in CI as today.
4b. **`scraper/src/check-welcome.js` — the tutorial content gate** (content agent;
   node ≥20, no deps, ESM like the rest of scraper/src): reads
   `scraper/fixtures/welcome.json` and asserts the §5 mechanical facts — exactly 9
   chapters; every chapter opens with an `h2` block; per-chapter word count
   (whitespace-split tokens across all block text) within 400–800; across the book
   ≥ 1 `blockquote`, ≥ 1 `ul` or `ol`, ≥ 1 `hr`, ≥ 1 `note`; zero `img` blocks.
   Exits 1 with a per-violation report. Wired into the validate script:
   `"validate": "node src/validate.js && node src/check-welcome.js"`
   (scraper/package.json — content agent's file). Without this, §5's binding content
   rules have no mechanical teeth: a 4-chapter, 200-word book would pass every other
   gate.
5. **What stays:** `scraper/src/sources/fixture.js` (the tooling and its
   documentation), `mangadex.js`, `flamecomics.js`, `gutenberg.js` (sources remain
   available to any integrator who re-adds entries), all of `scraper/src/lib`, the
   6-hour CI scrape.
6. **Doc follow-ups:** `README.md` line ~29 ("Five sample series…") → "A short
   tutorial book — *We Are Readers Here* — plus six public-domain classics ship with
   the repo, so there is something to read immediately." (docs agent, R3);
   `docs/CATALOGUE.md` worked examples re-based on `welcome` (content agent — the
   lamplighter/ashfall walk-throughs become the welcome walk-through; the image-series
   example keeps its prose with a note that the sample image fixture was retired);
   `worker/src/lib/allowlist.js:32-37`'s comment about Gutenberg/Standard Ebooks
   static hosts remains true and untouched.
7. **Test impact:** none — research §4.3 verified no browser harness or worker test
   references bundled ids. The orphaned `test/fixtures/catalog.json` (synthetic ids)
   is left alone.

**Accept.** `npm run validate` green on the new tree (schema + floor guards +
check-welcome); deliberately emptying `series` in a scratch copy makes it exit 1 with
the floor error; disabling only the `welcome` entry in a scratch copy exits 1 with
the tutorial-missing error (guard (c), not just (b)); a scratch `welcome.json` with 8
chapters or a 300-word chapter makes check-welcome exit 1; fresh boot (web, cleared
storage) shows the tutorial + 6 classics, no fixtures, no md/flame rows; `fixture_*`
dirs gone except `fixture_welcome`; app-side "Latest updates" renders from the
remaining series with no code change.

**No-change.** The scraper failure policy (carry-over on fetch failure); `idToDir`;
ChapterFile schema; `sw.js` data-class caching of `/catalog.json` + `/chapters/`.

---

## 5. Tutorial book — content brief (binding for the writing agent)

**Series facts.** id `fixture:welcome` · type `lightnovel` · title **"We Are Readers
Here"** · author "The Offline Reader" · status `completed` · language `en` · genres
`["Guide", "Slice of Life"]` · tags `["tutorial", "offline"]` · description: "The
owner's tour of this app, written as a book — because around here, the book is the
interface. Nine short chapters; each one teaches by doing."

**Format.** `scraper/fixtures/welcome.json` in the fixture blocks format (allowed `t`:
`p h2 h3 h4 hr blockquote pre ul ol img note` — see lamplighter.json as the model).
Each chapter opens with an `h2` matching its title. 400–800 words per chapter (~5,000
total). Use the block variety naturally: at least one `blockquote`, one `ul`/`ol`, one
`hr` scene break, one `note`; **no `img` blocks** (nothing external; the committed
cover is the book's only art).

**Voice.** Professional with character — a knowledgeable, slightly bookish companion
who takes reading seriously and the reader's time more seriously. First person plural
where it warms ("we are readers here"), second person for instructions. No exclamation
marks, no marketing, no emoji. Short declaratives; the occasional dry aside. Every
chapter teaches its feature *in place* — the text refers to what is on screen right
now, then invites one concrete action, then returns to prose. Never gate reading on
doing.

**Register samples (match this):**

> That quiet bar at the bottom of this page — the one that looks like a design
> flourish — is how you turn pages. Tap the right side and the book obliges. Tap the
> left and it takes you back, no questions asked. Or ignore it entirely and swipe, the
> way you would nudge a real page you were not quite done with.

> We should talk about the letters themselves. Somewhere above this line there is a
> small button marked Aa, and behind it lives every opinion this app has about
> typography — which is to say, none it will not surrender. Make the type larger.
> Loosen the lines. Choose the typeface your eyes trust. The page will hold your place
> while you decide; that is its job, not yours.

> A word before you go. When you close the last page of a book — this one does not
> quite count — the app will offer you a small, quiet space to say what the book left
> behind. Not a review. Not homework. Just a thought, departed on the doorstep, kept
> where only you will find it again.

**Chapter list (titles binding; teaching goals binding; prose is the writer's):**

| # | title | teaches, in place |
| --- | --- | --- |
| 1 | The Book That Reads You Back | what this book is; page-turning (bar, tap zones, swipe); tapping the prose to hide/show the chrome; the diamond home button |
| 2 | Three Ways to Turn a Page | reading modes — paged, one-chapter scroll, endless scroll; the Aa sheet's mode row; your place survives the switch |
| 3 | Set Your Type | typeface (incl. the dyslexia-friendly and hyperlegible faces), size, line height, width, spacing, indent; presets — one tap, then tweak; "Apply to all series" |
| 4 | Reading After Dark | the reader's themes incl. the two-color custom theme; the app-wide theme in Settings ("black might not be your cup of tea — change the whole room, not just the page") |
| 5 | The Shelf Grows | importing your own files — EPUB, TXT, CBZ; the Files app and share sheet; bought books: DRM-free stores open here, locked ones honestly cannot (one calm sentence, no lecture) |
| 6 | Elsewhere, Brought Home | sources — add a library you found by link; save it to your shelf; browse it from here; the honest state when the gateway is off |
| 7 | The Long Read | progress and resume; Continue reading; per-series settings memory; downloading chapters for offline |
| 8 | Minutes That Count | goals, the timer, streaks; the lifetime counters ("the app keeps a ledger of how much you have read — all of it, for you, on your device") |
| 9 | Make It Yours | focus (books/comics/both); home layout reordering; where Settings lives; departing your thoughts — and then the book ends, and the real prompt appears |

Chapter 9's ending is deliberate: the last page teaches the thoughts feature, then the
actual "Depart your thoughts" affordance renders right below the closing line (feature
7's `.nv-end` CTA). The book demonstrates itself to the last pixel.

The mechanical facts above — 9 chapters, h2 openers, 400–800 words each, the block
variety floor, no `img` — are enforced by `scraper/src/check-welcome.js` (§4.4b)
inside `npm run validate`; the prose itself is the writer's, the shape is CI's.

---

## 6. DRM posture (feature 10 — binding copy and conduct)

### 6.1 Conduct

1. **No DRM circumvention, ever.** The app will not strip, bypass, decode, or link to
   tools that do. No ACSM/Adobe flows, no key handling, no "search for how" hints.
2. Importable = **files the store itself hands the user DRM-free**. That is the whole
   feature.
3. UI copy is honest about locked ecosystems — factual, unresentful, one sentence per
   store. We do not editorialize about DRM; we state what opens here.
4. An `.acsm` pick gets the honest toast (§2.10), never a parse attempt.

### 6.2 Store-by-store guidance (the "Where is my file?" list — copy verbatim,
`textContent`, one row each)

| store | copy |
| --- | --- |
| Project Gutenberg / Standard Ebooks | "Free and DRM-free. Download the EPUB and open it here." |
| Humble Bundle | "DRM-free. Library → your purchase → download EPUB (or CBZ for comics)." |
| Leanpub / itch.io / Smashwords | "DRM-free. Your library page offers direct EPUB downloads." |
| Kobo | "Some titles are DRM-free — kobo.com → My Books → Download EPUB. Titles that download as ACSM are locked and cannot open here." |
| Google Play Books | "Books → your title → Download EPUB. If the download is an ACSM file, that title is locked and cannot open here." |
| Baen / Tor (publisher stores) | "These publishers sell DRM-free EPUBs. Download and open." |
| Kindle | "Amazon does not offer DRM-free downloads. Kindle books stay in Kindle — we cannot open them, and we will not break locks." |
| Apple Books | "Purchases are locked to Apple Books and cannot open here." |
| Comics (Comixology → Kindle) | "Comixology purchases moved into the Kindle system and are locked. DRM-free comics from Humble or itch.io open here as CBZ." |

The row set is app-authored data in importer.js (array of `{store, copy}` rendered via
`el()`); the docs agent mirrors the posture paragraph into ARCHITECTURE §8 (§11-A10).

---

## 7. Memory statement (§9 compliance, per feature)

- Sources: one JSON ≤ 60 items per page fetch; cards chunked; covers via existing lazy
  `<img>` path. No archives, no blobs.
- Covers: inline SVGs ~1–2 KB DOM apiece, replacing equal-cost gradient divs inside the
  existing 200-card chunk ceiling.
- Thoughts: text rows; list chunked at 100; composer is one textarea.
- Presets/focus/themes/layout: pref reads + one-batch relayouts; zero content memory.
- Tutorial book: ~5,000-word ChapterFiles — a fraction of the ~984 KB of fixtures it
  replaces.
- History sentinel: one history entry, no listeners beyond one MutationObserver +
  popstate.
- Nested-zip cachePath: **reduces** peak memory (removes a 600 MB-class blob path);
  disk bounded by the existing page-cache prune.
- No changes to tuning rows, windows, caps, or the §9 fixed policies.

---

## 8. Verification (round 3 gates)

1. Headless web boot: zero console errors — with all modules present, and once per
   optional module removed (`covers.js`, `thoughts.js`, `sources.js`, `settings.js`,
   and the existing `goals.js`).
2. Test pages green: `test/goals.test.html` (+lifetime suites),
   `test/novel-reader.test.html` (+presets suites), `test/platform.test.html`
   (+cachePath), `test/importer.test.html` (+thoughts export/import, +.acsm),
   `test/thoughts.test.html` (new: store round-trip incl. fallback, XSS inertness,
   book-finish event gating).
3. `worker/`: `npm test` green including the §3.5 additions.
4. `scraper/`: `npm run validate` green — schema, the three floor guards, AND
   `check-welcome.js` (§4.4/§4.4b); the empty-catalogue and missing-tutorial negative
   checks exercised on scratch copies.
5. `sw.js` bumped to v5.08 exactly once; SHELL_ASSETS complete (checker diffs against
   §1.1) **and index.html carries the three new stylesheet `<link>`s in the head plus
   the four new script tags in the end-of-body block, both in §1.1 order (checker
   diffs both against §1.1 — missing links ship unstyled screens and a dead theme
   engine)**.
6. Grep gates: no `innerHTML` in the four new modules or covers.js; no Capacitor
   references outside platform.js/native; no new `:root` token redefinitions outside
   settings.css's `[data-apptheme]` blocks.
7. On-device rows appended to `docs/mobile/TESTING.md` (user-run, §13 precedent): iOS
   PWA edge-swipe sentinel behavior **including the in-reader cancel artifact — the
   stale-snapshot slide-and-snap-back (§2.11-A) is expected and cosmetic; the row
   verifies the reader neither tears down nor loses its place**; Android
   hardware-back tour of the five module screens; nested-zip native import memory
   check; status-bar style under light themes (incl. tan).

---

## 9. Implementation rounds & file ownership (disjoint within each round)

One delivery, three rounds; later rounds code against the exact signatures in this
plan, not against unfinished trees. Shared-file rule: within a round every file has
exactly one owner below; cross-module needs are the named edits already specified.

### Round 1 — engines, floors, leaf modules (9 agents in parallel)

| agent | files owned this round | work |
| --- | --- | --- |
| **worker** | `worker/**` — all of it, matching §3's preamble (the load-bearing touches by name: `src/index.js`, `src/adapters/*` (index, mangadex, _generic, generic-manga, generic-novel), `src/lib/extract.js`, `src/lib/allowlist.js`, **`src/lib/respond.js` (the `list_failed: 422` ERR entry, §3.3.6)**, **`src/lib/gateway.js` (VERSION bump, §3.3.7)**, `test/*`, `README.md`) | §3 in full |
| **content** | `scraper/series.json`, `scraper/fixtures/*`, `scraper/src/validate.js`, **`scraper/src/check-welcome.js` (new)**, **`scraper/package.json` (validate script chain)**, `chapters/**`, `catalog.json`, `docs/CATALOGUE.md` | §4 + §5 (writes the book) |
| **integrator** | `js/store.js`, `index.html`, `sw.js` | Store v3 + thoughts methods incl. fallback (§1.3); script tags for the four new modules **and the three new stylesheet `<link>`s** in §1.1 order; `#home-btn` markup (§2.11-C); SHELL_ASSETS + bump v5.08 |
| **platform** | `js/platform.js`, `native/or-zip/*`, `docs/mobile/NATIVE_BUILD.md`, `test/platform.test.html` | back-table gap rows; `{cachePath}` zip source; status-bar-follows-theme listener; gestures appendix (§2.11-B, §2.9) |
| **reader** | `js/reader.js`, `styles.css` | home-btn wiring + teardown path; nested-zip cachePath path; touch/overscroll CSS; reader-screen dark pinning; shell color re-pointing in styles.css (§2.9, §2.11) |
| **novel-reader** | `js/novel-reader.js`, `css/novel.css`, `test/novel-reader.test.html` | presets (§2.6); home header button; thoughts CTAs (guarded); viewport touch CSS |
| **goals** | `js/goals.js`, `css/goals.css`, `test/goals.test.html` | lifetime accumulator + seed + UI + resets (§2.3); goals.css token re-pointing |
| **settings** | `js/settings.js`, `css/settings.css` (new) | theme engine + palettes (§2.9); settings screen; focus sheet + `maybeOfferFocus` (§2.1); home-layout editor (§2.12); thoughts row |
| **thoughts** | `js/thoughts.js`, `css/thoughts.css`, `test/thoughts.test.html` (new) | §2.7 module (screen, composer, chip, or:progress listener) |

### Round 2 — integration (3 agents in parallel)

| agent | files owned this round | work |
| --- | --- | --- |
| **catalogue** | `js/catalogue.js`, `css/catalogue.css`, `js/covers.js` (new) | section registry + `home.sections` incl. the reorderable `series` entry (§2.12); sources slot (§2.2); focus defaults — tab, home-order default, card bias — + empty-state copy + `maybeOfferFocus` call (§2.1); settings toolbar button (guarded, the Goals-button pattern); covers module + adoption (§2.8); history sentinel + popstate table + `#home-btn` flush listener (§2.11-A/C) |
| **sources** | `js/sources.js`, `css/sources.css` (new) | §2.2 client module against the §3 endpoint spec |
| **importer** | `js/importer.js`, `css/importer.css`, `test/importer.test.html` | purchased-books card + store list + `.acsm` guard (§2.10); thoughts in export/import + backup trigger (§2.7); confirm-view cover fallback (§2.8); token re-pointing in importer.css (§2.9); promote `normalizeUrl` to the public API (§2.2, one line) |

### Round 3 — verification & docs (2 agents, sequential)

| agent | files owned this round | work |
| --- | --- | --- |
| **checker** | none (reports; fixes route back to round owners) | §8 gates |
| **docs** (integrator hat) | `docs/ARCHITECTURE.md`, `README.md`, `docs/mobile/TESTING.md`, `docs/mobile/PLAN7.md` | §11 amendments; README sample-series rewrite; TESTING rows; completion log |

**Shared-file map for the whole phase** (who may ever touch it): `index.html` —
integrator only (R1). `js/store.js` — integrator only (R1). `sw.js` — integrator only
(R1). `js/catalogue.js` + `css/catalogue.css` + `js/covers.js` — catalogue only (R2).
`js/platform.js` + `native/or-zip/` — platform only (R1). `worker/**` — worker only
(R1). `styles.css` — reader only (R1). `js/config.js`, `manifest.json`, `fonts/` —
untouched this phase. Interim cross-round 404s (script tags land R1, modules land
R1/R2) are acceptable inside the working tree; only the post-R3 tree ships.

---

## 10. What must NOT change (phase-wide tripwires, additive to per-feature lists)

- reader.js stays a classic script — no IIFE, no `'use strict'`; the catalogue global
  hand-off contract is untouched.
- `Store.putBlob(key, blob)` order, promise semantics, prefs synchronicity.
- The §2.5 event dispatch/tolerance rules; `or:upload-progress` upload-only rule.
- The commit-ordering invariant (payload → chapters → series row last).
- Session-local URL rules (§1.2/§7.8): nothing new persists `blob:`/`capacitor://`/
  `_capacitor_file_` URLs — sources/covers/thoughts never touch page URLs at all.
- The disabled CapacitorHttp `proxyImageUrl` branch stays disabled, verbatim.
- `goals.*` keys, folding rules, streak semantics; `or.timer` stays out of the native
  mirror.
- Fonts §3.2 rules; blur budget; safe-area patterns; `prefers-reduced-motion` blocks.

---

## 11. Contract amendments (applied to docs/ARCHITECTURE.md by the docs agent, R3)

- **A1 (§2 module map):** extended load order per §1.1; four new modules + covers with
  owners; the deletability rule now names goals, covers, thoughts, sources, settings.
- **A2 (§2.1):** screen ids += `thoughts-screen`, `sources-screen`, `settings-screen`.
- **A3 (§2.2):** the unified back table (Android hardware back + popstate) with the
  new rows incl. `loading-screen`; the one-entry history sentinel (arming/disarming/
  cancel-in-reader semantics, the disarm-queue rule, self-healing re-sync,
  forward-inert limitation, the iOS stale-snapshot cancel artifact stated); home
  affordances in both readers and their teardown-then-`goHome()` exit paths;
  image-reader `#home-btn` two-listener rule + hidden-on-upload-origin rule.
- **A4 (§2.3):** `Platform.zip.list/extract` accept `{ cachePath }` (relative,
  `..`-rejected, container-checked); status bar follows `app.theme`; NATIVE_BUILD
  "Back gestures" posture (allowsBackForwardNavigationGestures deliberately default-off).
- **A5 (§3):** `DB_VERSION` 3; `thoughts` store; `listThoughts`/`putThought`/
  `deleteThought` signatures + Thought shape; in-memory fallback parity; the
  deliberate no-cascade from `deleteUserSeries`.
- **A6 (§3.1):** the §1.2 pref table rows, with shapes, validation and writers.
- **A7 (§2.5):** `or:thoughts-changed` row.
- **A8 (§6):** `/list` endpoint (§6.6-style section) incl. the `list_failed` ERR
  entry; §6.5 optional `listSeries` / `listMatches` members + capability reporting in
  `/health`; the allowlist invariant rewritten: grows only via successful `/resolve`,
  `/chapter`, or `/list` (list capped at 4 hosts/request, in-isolate memoized per
  §3.4).
- **A9 (§8 + §1):** bundled catalogue = tutorial book + public-domain classics; the
  tutorial book is the offline floor and `scraper/src/validate.js` fails an empty
  catalogue, a catalogue with zero bundled chapter files, **or a catalogue whose
  enabled `fixture:welcome` ships no chapter file** (§4.4 guard (c)); the §4.4b
  content gate rides `npm run validate`.
- **A10 (§8):** the DRM posture paragraph (§6.1 condensed): no circumvention; import
  is DRM-free files only; honest locked-ecosystem copy.
- **A11 (new §, app theming):** `html[data-apptheme]` attribute; the nine named
  palettes (the full novel theme set incl. tan) + custom; base-triple + `color-mix`
  derivation; module token re-pointing rule (`var(--surf-1, <literal>)`); parse-time
  application; key-gated live re-apply (`app.*`/null only); image reader pinned dark;
  generated covers theme-independent by design; meta theme-color runtime update;
  manifest colors unchanged.
- **A12 (§2.4):** goals additionally owns the `goals.lifetime` accumulator (same
  single-writer discipline; survives `clearDayLogs`; seeded once from dayLogs).
- **A13 (§2 catalogue):** home section registry (`continue`/`goals`/`sources`/
  `latest`/`series` via `home.sections`; tabs fixed; `series` reorderable, never
  hideable); the `#sources-home-slot` fixture (goals-slot pattern) and its
  MutationObserver fill mechanism; focus-derived defaults — tab, home order while the
  pref is unset, untyped-series card renderer under books focus; the guarded
  `AppSettings.maybeOfferFocus` boot hook.
- **A14 (§2.6 / §5):** reader nested-zip native path via cachePath (deviation-7
  closed); importer backup format gains additive `thoughts` (version unchanged);
  `or:thoughts-changed` added to backup triggers.
- **A15:** `sw.js` cache `cbz-reader-v5.08`; SHELL_ASSETS additions per §1.1.

---

## 12. Open questions (defaults chosen; work proceeds without answers)

1. **Tutorial book title** — "We Are Readers Here" is set as the working title; the
   user may rename before R1 content lands (id `fixture:welcome` is title-independent).
2. **Native iOS edge-swipe posture — needs the user's sign-off.** §2.11-B presents
   the full trade-off and decides Option 2 (WKWebView gestures stay off), which
   means the native app has NO edge-swipe outside readers either — a knowing
   deviation from "suppressed only inside readers, standard outside" on the
   first-priority platform. Veto → Option 1 (gestures on + sentinel routing, with
   the stale-snapshot artifact on every swipe), gated on on-device testing; the
   per-screen toggle plugin remains the eventual best-of-both follow-up.
3. **MangaDex listing default** (no query → followed-count order, EN-filtered) — tune
   freely at review; the endpoint shape is what is binding.
4. **Removing the MangaDex/Flame bundled entries** (§4.1) is this plan's reading of
   "other auto-populated feel" — if the user wants any kept, it is a one-line
   series.json revert; the floor guard is unaffected.
5. **Comics-focus default home order** (§2.1 effect 2: Latest promoted to second) —
   the *mechanism* (focus-derived default while `home.sections` is unset) is binding;
   the exact comics ordering is tunable at review.
6. **Keeping the six Gutenberg classics** (§4.1) — the retention is this plan's
   decision, not the user's words; "drop the auto-populated feel" could equally mean
   ship ONLY the tutorial. Either way is a one-line series.json edit; guards (a)–(c)
   in §4.4 are satisfied by the tutorial alone, so removal needs no code change. The
   user should confirm which first impression they want: one book that teaches, or
   one book that teaches plus six classics to read tonight.

---

## Appendix A — Review changelog (adversarial review, 2026-08-10)

(Numbered "Appendix" rather than §13: this plan's bare "§13" citations refer to
PLAN.md §13, the completion-log/deviation precedent, and must stay unambiguous.)

Every blocker and major was addressed; minors were adopted except where noted, with
reasons. Findings are keyed by subject.

**Adopted — blockers/majors.**

1. *Focus selector dropped two of the user's three named effects* (blocker): §2.1 now
   ships all three — default tab, section emphasis (focus-derived `home.sections`
   default while the pref is unset), and card style (untyped-series renderer bias per
   research §5.4(iv)) — under the one shared rule "focus shapes defaults, never
   overrides a choice". Comics ordering listed as tunable (§12.5).
2. *`tan` theme silently dropped* (major): restored everywhere — §1.2 enum, §2.9
   palettes (nine named + custom, the full novel set at novel-reader.js:58 /
   design.md tan row), swatch grid, light-theme semantic-anchor list, platform
   status-bar luminance sets.
3. *`goals.lifetime` ints-only validator vs float words = eternal re-seed* (major):
   §1.2 + §2.3 now carry the binding numeric rule — finite ≥ 0, fractions valid,
   words stored as float, rounding at display only; re-seed never fires on a parsed
   pref with non-integer numbers; a test gate pins the regression.
4. *Native iOS gesture posture buried in §12* (major): §2.11-B now presents both
   options with honest costs as a first-class decision (Option 2 chosen), the Accept
   states plainly that native iOS gets no edge-swipe anywhere, and §12.2 is the
   explicit veto hook.
5. *All Series excluded from customization* (major): `series` is now a registry entry
   — reorderable, never hideable (`on` coerced true), internals sealed; tabs stay
   fixed with the real rationale stated (the tab bar filters the whole home, not
   just the grid — catalogue.js:1088-1107).
6. *Missing `<link>` tags for the three new stylesheets* (major): added to §1.1, the
   integrator R1 row, and the §8.5 checker diff.
7. *§3.4 false claim + wrong `learnHosts` signature* (major): signature corrected to
   `learnHosts(hosts, env, { max })` (allowlist.js:114); the "already skips known
   hosts" claim replaced with the truth (only `isStaticallyAllowed` is skipped) plus
   the honest 120-writes/min arithmetic; an in-isolate seen-host memo (the
   ratelimit.js:11 `buckets` idiom) added in front of `/list`'s learning, with a KV
   put-count test.
8. *§2.11-A overclaims (invisible swallow; "drift-impossible"; async disarm race)*
   (major): the stale-snapshot slide-and-snap-back artifact is now stated in "what
   this buys, honestly" and has a §8.7 on-device row; the claim is downgraded to
   at-most-one-entry + self-healing with the disarm-queue rule specified (arming
   deferred until the swallowed popstate lands, then re-checked against the live
   screen).

**Adopted — minors.** Gutenberg retention is its own open question (§12.6);
`sources.saved` cap refuses instead of evicting (§1.2/§2.2); the sources home-slot
fill mechanism is named with line-cited goals precedent (`data-screen`
MutationObserver → fill on entering home, goals.js:763-788/1753-1757, plus or:prefs/
or:library-changed refreshers); lifetime books decoupled from the goal period (one
increment per book per local day, own dedup set, dayLogs untouched; seed =
sum-of-lengths; re-seed documented as a floor); thoughts gained a settings-free
entrance (thoughts-owned tappable post-save toast) and §2.1's deletability acceptance
is scoped to a fresh profile; the tutorial content rules got mechanical teeth
(`check-welcome.js`, §4.4b, wired into `npm run validate`); the image-reader home
button hides in upload-origin sessions (mirroring the `#close-btn` special-case at
reader.js:2099-2107); URL normalization is shared by promoting `Importer.
normalizeUrl` to the public API instead of twinning it (drift class eliminated;
minimal local fallback only for Importer-absent save mode), while `safeImageUrl`/
`imgUrl` follow the established twin pattern and say so; the thoughts chip condition
is pinned to `dataset.screen === 'reader-screen'` exactly (novel completion also
rides store.js:402's or:progress); the §4.4 floor guard now enforces the tutorial
specifically (guard (c)) and the tour button is render-guarded; §9's worker row is
`worker/**` with respond.js (`list_failed: 422` ERR entry) and gateway.js (VERSION,
:17) named; settings' live re-apply is key-gated to `app.*`/null; the popstate table
gained a `loading-screen` row (cancel — transitional screen); "nine named + custom"
counts are consistent throughout. While fixing the ERR finding, the same defect class
was found and fixed in §3.3.6's own error list: the draft named `fetch_failed` and
`unsafe_target`, codes that do not exist in the worker — replaced with the real
shared-path codes (`bad_url` 400, `blocked_host` 403, `upstream_error` 502, `timeout`
504; security.js/index.js), and §3.5's SSRF expectation corrected from 400 to
`blocked_host` 403 to match /resolve's actual envelope.

**Rejected / partially rejected, with reasons.**

- *"foldBookFinish dedupes per DAY; period dedupe happens only at aggregation time;
  same-book finishes on two days in one period would have yielded lifetime +2 under
  the old spec"* — the factual claim is wrong: `foldBookFinish` checks
  `finishedThisPeriod.has(id)` inline (goals.js:598; the set is rebuilt from the
  period window at goals.js:536-543), so under the old piggyback spec a later-day
  re-finish inside one period incremented nothing. The finding's *diagnosis*
  (coupling an all-time ledger to the mutable period setting is incoherent) is
  correct and its remedy — per-day semantics, sum-of-lengths seed — is adopted in
  §2.3; only the code claim is corrected for the record.
- *Light variant for generated covers under light shell themes* — rejected in favor
  of the finding's other offered branch: §2.8 now documents theme-independence as
  intended (a generated cover is content artwork; real cover images do not repaint
  with the shell either; id-stable identity beats blending).
- *Parity fixture test for two URL normalizers* — moot rather than rejected: the
  second implementation was removed entirely (public `Importer.normalizeUrl`), which
  is the finding's preferred branch; no parity test is needed for one function.

---

## Appendix B — Completion log (Phase 7 landed; deviations recorded)

(Appendix-numbered like Appendix A, for the same reason: this plan's bare
"§13" citations must keep meaning PLAN.md §13. This is the §13-style
completion log the plan's preamble promises.)

**Status: implementation complete.** All twelve features shipped in a single
delivery (two implementation rounds per §9, then the round-3 checker + this
docs round). The checker executed every runnable §8 gate for real: worker
tests 234/234; scraper `npm run validate` + `check-welcome` green, with all
three negative floor gates exercised on scratch copies (exit 1 each);
`node --check` clean on all 13 JS files; the five browser test pages green
under headless Chromium — novel-reader 86/0, thoughts 85/0, importer
21 tests / 185 checks / 0, platform 69/0, goals 147/0 after the F1 fix
below; headless boot smoke green with the full module set and with each of
the five optional modules (`goals`, `covers`, `thoughts`, `sources`,
`settings`) individually removed; the sentinel smoke holds the
at-most-one-entry invariant under root↔non-root flapping; every grep/static
gate passes (no `innerHTML` in the new modules or covers.js, reader.js still
a classic script, `proxyImageUrl` seam disabled and verbatim, sw.js
`cbz-reader-v5.08` + complete `SHELL_ASSETS`, §1.1 script/link order exact,
no `:root` token redefinitions outside settings.css's `[data-apptheme]`
blocks, session-URL rules intact); all eight cross-module contract checks
verified, including a 5,090-trial readSections-equivalence fuzz (0
mismatches) and the capture-phase `#home-btn` flush ordering.

**Checker fixes applied (round-owner fixes, re-verified):**

- **F1 (blocker, goals):** the lifetime ledger never accrued live reading
  seconds — no `bumpLifetime('seconds', …)` existed, so the Hours-read tile
  froze at its seeded value (the shipped test failed on exactly this).
  Fixed: one line at the `collectSession` clamp site banks the same clamped
  span into the ledger. goals test 146/1 → 147/0, twice consecutively.
- **F2 (defect, content):** tutorial chapter 9 promised the thoughts
  affordance "just below this line", which the DEFAULT paged mode does not
  render (see F4 under known gaps). The closing prose was softened to
  promise only what every mode delivers; `validate` + `check-welcome` stay
  green (ch. 9 ≈ 527 words, inside the 400–800 gate).

**The contract closure landed with this round:** `docs/ARCHITECTURE.md`
carries all fifteen §11 amendments (A1–A15) verified signature-by-signature
against the landed code; `README.md` reflects the new bundled catalogue;
`docs/mobile/TESTING.md` gained the §8.7 on-device scenarios (13–21: sentinel
/ edge-swipe incl. the in-reader cancel artifact, Android hardware-back
module tour, reader home buttons, nested-zip import memory, status-bar theme
follow incl. tan, presets, thoughts flows, sources browse, focus/layout/
tutorial render); and this log closes the plan. **Still pending (requires
the user's hardware, by design):** the TESTING.md matrix runs, and the §12
sign-offs (§12.2 native-gesture veto, §12.6 Gutenberg retention, §12.1
title) — all landed on this plan's defaults.

### Per-feature status

1. **Focus selector** — shipped (sheet, settings row, all four read-time
   effects, guarded boot hook).
2. **Sources** — shipped (module + shelf + browse + honesty states; worker
   `/list` + optional adapter capability + `list_failed` + capped/memoized
   cover learning).
3. **Lifetime counters** — shipped (ledger + seed + per-day book semantics +
   All-time tiles + separate reset; F1 fixed in-round).
4. **Sample removal** — shipped (five fixtures + md/flame entries gone;
   pipeline intact; Gutenberg six retained per §12.6 default).
5. **Tutorial book** — shipped (*We Are Readers Here*, 9 chapters, committed
   reader-silhouette cover; floor guards (a)–(c) + `check-welcome` gate).
6. **Reader presets** — shipped (five built-ins, one-relayout apply, save/
   delete with cap-6 refusal, XSS-inert names).
7. **Depart your thoughts** — shipped (Store v3 + fallback, module, both
   book-end surfaces, composer, reading surface, export/import ride-along,
   settings-free toast entrance). See F4 for the paged-mode cadence gap.
8. **Default covers** — shipped (seven deterministic designs, zero content
   strings, catalogue + importer + sources adoption, gradient fallback kept).
9. **App themes** — shipped (nine named + custom, parse-time apply,
   key-gated re-apply, token re-pointing with literal fallbacks, pinned-dark
   readers, status-bar follow). See F3 for the muted-contrast polish item.
10. **Purchased books** — shipped (card + §6.2 store list verbatim, `.acsm`
    honest refusal, `.epub` reachable from both pickers).
11. **Reader navigation** — shipped (one-entry sentinel + unified back
    table incl. `loading-screen`, Option-2 native posture + NATIVE_BUILD
    appendix, home buttons in both readers with the upload-origin hide rule,
    `{cachePath}` nested-zip path closing PLAN.md §13 deviation 7,
    touch/overscroll hardening).
12. **Home layout** — shipped (five-section registry with `series`
    reorderable-never-hideable, live reorder, settings editor,
    clear-not-write reset).

### Accepted deviations (from the R1/R2 journals + checker audit — all
judged consistent with plan intent; none needed remediation)

1. **Catalogue — capture-phase `#home-btn` flush.** The §2.11-C two-listener
   contract is implemented as a document-level CAPTURE-phase click listener
   (filtered to the button), not a same-node bubble listener: reader.js
   registers its teardown at parse time, so a bubble listener would always
   run after teardown and flush nothing. Verified working; ARCHITECTURE §2.2
   documents the mechanism. (The checker's F6 records the *pre-existing*
   sibling asymmetry on `#close-btn`, untouched per the no-change list:
   catalogue's bubble listener there runs after the screen switch and its
   flush is a no-op — progress lands via the ≤1.5 s throttled scroll sync.)
2. **Content — Gutenberg carry-over.** The sandbox proxy 403s gutenberg.org,
   so the regeneration ran under the scraper's documented carry-over failure
   policy: the six classics' previously committed entries/chapters shipped
   unchanged (218 chapters validate). Consequence, recorded as F7:
   `gutenberg:1661` ships 3 of its 12 configured chapters. A networked
   rebuild refreshes them; no code change involved.
3. **Content — floor guards (b)/(c) run in checkFiles mode only.**
   `--dry-run` writes no chapter files to check and would otherwise always
   fail; guard (a) applies in every mode, and the Accept-path behavior
   (standalone `npm run validate`, real runs) is exactly as specified.
   Verified by the checker's scratch-copy negative gates.
4. **Platform — Android `loading-screen` cancel row added.** §2.11-B's gap
   list named six rows, but A3's unified table includes the cancel row and
   the two dispatchers are "the same semantic table"; without it Android
   back would tear down the transitional screen via the goBack() catch-all.
5. **Platform — `native/or-zip/` untouched.** The `{cachePath}` form
   resolves to an absolute container path in js/platform.js; the plugin's
   existing containment check applies unchanged — no plugin API change was
   needed.
6. **Worker.** The §3.4 memo (plus `_resetListLearnMemo` test hook) lives in
   `worker/src/lib/gateway.js`, not index.js (workerd rejects named exports
   from the entry module); `VERSION` bumped 2.0.0 → 2.1.0; srcset-only
   covers resolve to the LAST candidate (reusing the existing image-attr
   helper rather than minting a twin); per-item cover containers are
   computed as the highest ancestor not shared with another cluster entry
   (the naive depth reading hands every item the same grid cover); `isValid`
   exported as `isValidAdapter` for the boot-error test; the memoization
   test asserts puts 4→5→5 across three calls (the fixture's 5th host is
   legitimately learned on the second call).
7. **Reader (styles.css).** Notice banners deliberately NOT re-pointed at
   `--warn`/`--danger` (they overlay the pinned-dark reader; light-theme
   anchors would break contrast); glass headers derive via a two-declaration
   `color-mix` fallback pattern (no chrome token exists); an extra
   `body[data-screen='reader-screen']` background pin stops iOS rubber-band
   reveal; `.btn-title`'s re-point shifts unthemed white from `#fff` to
   `#f0f0f0` (imperceptible). Nested zip-of-CBZs sets additionally became
   durable + resumable (they now reach the archive-move + manifest phase);
   the home-button teardown also cancels `chapterJumpTimer` (and stops
   autoscroll) — without it a home tap within 150 ms of a chapter jump would
   throw; `#close-btn`'s latent version of that race left untouched per the
   no-change list.
8. **Novel-reader.** The home button falls back to
   `showScreen('home-screen')` when `Catalogue.goHome` is absent (guarded
   per plan; the fallback matches the file's navigateAway idiom). The
   ≤1-relayout acceptance is asserted via the plan-sanctioned `layoutCount`
   in `api.state()`.
9. **Settings.** An explicitly applied `dark` theme stamps the attribute and
   renders the novel dark triple (text `#e9e9ec`) rather than styles.css's
   `#f0f0f0` literal — byte-for-byte-today remains the unset/absent path;
   "Start with the tour" writes `app.focus='both'` before opening (every
   sheet exit settles the pref, which is what makes "never re-prompts"
   true); reset-to-default clears `home.sections` by writing `undefined`
   through `prefs.set` (prefs has no remove API; JSON serialization drops
   the key); `home.sections` validation leans visible on a missing `on`
   (`e.on !== false`) and inserts missing ids at their default-order index;
   several light-theme anchor values (`--accent-ink`, `--warn`,
   cream/sepia/tan `--prose`) are the agent's picks where §2.9 gave only
   examples — cream's `--prose` darkened a step because the plan's example
   equals cream's `--accent` and the amber/indigo split may never collapse.
10. **Goals.** Its own `or:prefs` listener short-circuits
    `key === 'goals.lifetime'` to a cheap adopt (the §2.9 key-gating
    discipline applied to goals itself — otherwise every 30 s flush would
    trigger a full recompute); a valid mirror-restored ledger is live-adopted
    on `goals.lifetime`/null-key events (required by §1.2's deliberate
    native mirroring; re-seeding stays init-only); the pill/toast tokens are
    pinned to dark literals (they float over reader surfaces on fixed dark
    capsules — the readers-stay-reader-themed doctrine).
11. **Catalogue (other).** Non-enumerated non-root screens fall through to
    `goBack()` in the popstate table (defensive default); `normalizeSeries`
    carries an in-memory `untyped` flag (the §2.1 card-bias condition is
    undetectable post-`inferType`; never persisted); empty-state titles and
    the books-flavored bodies are app-authored where the plan is silent (the
    comics body is the plan's verbatim copy); catalogue.css §2.9 re-pointing
    was done in R2 by catalogue (the §2.9 Files list names it; the §9 R2
    work column simply doesn't repeat it).
12. **Importer.** Error-status ink re-pointed as `var(--danger, #ffd7da)`
    (the prescribed ink→anchor pattern; unthemed rendering unchanged); the
    `.imp-restore` boot toast pinned to dark literals (goals `.gl-toast`
    precedent); `importLibrary` returns an additive `thoughts` count;
    two implied helpers added (a `safeHttpUrl` twin for the Gutenberg link
    — joins the §7.6 keep-in-sync list — and a static `chev` icon).
13. **Sources.** With the gateway configured but Importer deleted, browsing
    is disabled with its own one-line honest notice (distinct from the
    gateway-off copy); the empty-shelf slot renders the solo card without a
    section label ("a single quiet card" read literally); saved-source
    removal uses `askConfirm`; pagination failures keep the grid and restore
    `nextUrl` for retry, and a 422 on a later page is treated as the honest
    end of the catalogue. **F8 (verified divergence record):** the
    Importer-absent fallback normalize deliberately keeps tracking params,
    original param order and trailing slashes where `Importer.normalizeUrl`
    strips/sorts/trims — it only ever serves save-and-bookmark mode (browse
    and badges are off without Importer), so dedupe merely degrades.

### Superseded by Phase 8

This plan is the record of what Phase 7 specified and shipped; it is not
rewritten after the fact. One area has since changed, and where this document
describes it, it is history rather than contract:

- **The site-specific sources and adapter are gone.** Phase 8 removed both
  builder sources (`scraper/src/sources/`) and the site-specific worker adapter
  (`worker/src/adapters/`), stripped the reader hosts from the compiled-in
  `/image` allowlist, dropped the hand-mapped `KNOWN_REFERERS` table in favour
  of the derived Referer alone, and retired the `mdChapterId` step that called
  one site's API from the browser. §3's adapter listing spec, the `listMatches`
  notes and the §4.1 entry-removal rationale all refer to code that no longer
  exists. Browsing is unaffected: both generic adapters implement `listSeries`.
- **Public-domain-only is now enforced.** `validate.js` fails a catalogue whose
  series come from anywhere but `fixture | gutenberg | standardebooks`.

See `docs/ARCHITECTURE.md` §8 and `COPYRIGHT.md` for the current rules.

### Known gaps & deferred items

- **F3 (polish, settings):** the derived `--muted` lands at 3.15–4.16:1 on
  the light themes (worse on surfaces) — below the §2.9 4.5:1 spot-check
  floor for body-size text. The 58% mix is the plan's own formula; fixing it
  properly means per-theme muted overrides or a darker mix on light
  palettes. Deferred to the settings owner as a follow-up.
- **F4 (plan-level gap, novel-reader):** §2.7's "always offered at book end"
  does not hold in the DEFAULT paged mode — `.nv-end` and the inline CTA
  render only in chapter/infinite modes (pre-existing `.nv-end` behavior,
  protected by the no-change list). Needs a plan amendment before any owner
  can fix it; the tutorial's prose no longer over-promises (F2).
- **F5 (pre-existing):** js/catalogue.js contains a literal NUL byte inside
  a string literal (~line 568, a raw NUL used as a key separator; present at
  the pre-phase commit). Syntactically valid JS; makes naive greps treat the
  file as binary. Left as-is; a `\x00` escape is the cosmetic fix.
- **F6 (pre-existing):** the `#close-btn` flush asymmetry described under
  deviation 1.
- **F7:** `gutenberg:1661` ships 3 chapters until a networked rebuild
  (deviation 2).
- **On-device:** TESTING.md scenarios 13–21 (plus the standing Phase 6
  matrix) remain with the user — including the iOS edge-swipe cancel
  artifact verification, the Android module-screen back tour, the
  nested-zip memory check, and status-bar behavior under the light themes.
- **User sign-offs still open (§12):** the native-iOS gesture posture veto
  (§12.2 — Option 2 shipped), Gutenberg retention (§12.6 — six classics
  shipped), and the tutorial title (§12.1 — working title shipped).

### Docs-round deltas (this round's own record)

All fifteen §11 amendments were applied to `docs/ARCHITECTURE.md` after
verifying each claim against the landed code. Where an amendment's wording
no longer matched the tree, the contract now states what the code actually
does, per this plan's own rule: the A3 `#home-btn` flush is documented as
the capture-phase listener (deviation 1); the A3/§2.2 unified table carries
the Android `loading-screen` row (deviation 4); A8's memo is placed in
`gateway.js` with the 2.1.0 version (deviation 6); A11 records the
explicit-dark rendering note and the pinned-dark floating-chrome exceptions
(deviations 7, 9, 10, 12); A6's `home.sections` row documents the lenient
`on` validation (deviation 9); A9 records the checkFiles gating (deviation
3); §7.6's keep-in-sync list gained the sources.js and importer.js twins
(deviations 12–13). README's sample-content section, allowlist sentence,
feature summary and layout listing were re-based on the shipped tree;
TESTING.md's header, test-page list and matrix gained the Phase 7 rows.
