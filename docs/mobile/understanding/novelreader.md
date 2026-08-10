# Deep map: `js/novel-reader.js` (window.NovelReader)

File: `/home/user/Offline-Reader/js/novel-reader.js` — 2403 lines, single IIFE, `'use strict'`.
Companion stylesheet (the DOM contract): `/home/user/Offline-Reader/css/novel.css` — 848 lines, everything scoped under `#novel-screen`.
Binding contract: `/home/user/Offline-Reader/docs/ARCHITECTURE.md` §4 (NovelReader API), §3.1 (pref keys), §1.3 (Block model), §7 (security).

This module is the text reader for `lightnovel`/`webnovel` series. It owns `window.NovelReader`, the `#novel-screen` element, and `css/novel.css`. It creates its own DOM at init (`document.body.appendChild`), registers itself via `window.registerScreen`, and never navigates directly — it calls `Catalogue.goBack()` (navigateAway, novel-reader.js:2397-2400).

---

## 1. Design theses (the file's own header, lines 1-44 — read these, they are binding style)

1. **Anchors, not scroll offsets** (lines 9-26). Single source of truth for position: `{ chapterId, blockIdx, charInBlock }` — a semantic cursor into the Block[] content model. Every layout-changing event does capture → mutate → restore. Exactly ONE capture fn (`captureAnchor`, :1327) and ONE restore fn (`restoreAnchor`, :1427), each dispatching on mode. **A fourth reading mode = teach those two functions about it and nothing else** (line 20-21). Character precision via `Range.getClientRects()` + binary search (~10 rect reads).
2. **Pagination is the browser's job** (lines 28-33). Paged mode = CSS multi-column with `column-width == viewport width` and definite height; module clips with `overflow:hidden` and translates the track. Blocks are never split by hand.
3. **textContent only** (lines 35-38). Zero `innerHTML` in the file. Only markup created is author-controlled chrome (static SVG paths in `ICON_PATHS` :394, `RULE_SHAPES` :1091).
4. **The stylesheet is the DOM contract** (lines 40-44). JS writes only attributes (`data-*`) and custom properties on `#novel-screen`; css/novel.css maps those to actual colors/sizes. A settings change is one style write, not a re-render.

---

## 2. Module structure — every function, with line refs

### Constants (:49-136)
- `SCREEN_ID = 'novel-screen'` :53
- Enums: `MODES` (paged/chapter/infinite) :55, `FONTS` :56, `WIDTHS` :57, `THEMES` (10 incl. `custom`) :58, `PARAS` :59, `ALIGNS` :60
- `WEBFONTS` :66-70 — data-font value → CSS family name for the 3 bundled faces (Literata, Atkinson Hyperlegible, OpenDyslexic); only these need `document.fonts` settling.
- `THEME_SWATCHES` :76-86 — `[value, label, bg, fg]`, colors deliberately duplicated from novel.css (a swatch is a preview; comment :74-75 explains why they don't read the real tokens).
- `CUSTOM_DEFAULT` :88; `DEFAULTS` :92-106 (mirror css/novel.css initial values); `PREF_KEY` :108-114 (maps state key → `novel.*` Store pref key).
- Ranges: `FONT_MIN/MAX/STEP` 14-32/1 :116, `LH` 1.3-2.2/0.05 :117, `LS` 0-0.24em/0.01 :120, `WS` 0-0.8em/0.04 :121.
- `WPM = 230` :123 (time-left estimate; deliberately slower than catalogue's 250 — "a promise, not a boast").
- `COL_GAP = 40` :126 px between columns; `WINDOW_RADIUS = 2` :129 (infinite keeps 2 chapters each side live); `MAX_STACK = 12` :130 (hard DOM cap); `PROGRESS_MS = 1000` :131 (§4 throttle); `SWIPE_SLOP = 10` :132; `RUBBER = 0.34` :133; `TURN_MS = 220` :134.
- `BLOCK_TAGS` :136 — t → tag map for simple blocks.

### Small helpers (:139-237)
- `el(tag, className, text)` :142 — **THE DOM factory of the whole codebase**; text goes through `textContent`.
- `clamp` :149, `num` :151, `oneOf` :156, `hexColor` :161 (validates `#rrggbb` strictly — pref reaches a CSS custom property, so it's validated not trusted), `luminance` :167 (WCAG relative luminance, picks accent for custom theme), `fmtNum` :176, `chapterLabel` :182 ("Ch. 12 · Title"), `safeImageUrl` :193 (http(s)/data:image/blob/relative only; mirrors catalogue.js guard because cached ChapterFiles may predate normalization), `prefersReducedMotion` :203, `storeGet`/`storeSet` :209-221 (**per-series prefs via `Store.prefs.getFor/setFor(seriesId, key)`, never throw, tolerate absent Store**), `blockText` :226-232 (**canonical text of a block — must equal DOM textContent char-for-char or anchors drift**), `countWords` :234.

### State (:243-286)
- `state` singleton :243-263: `open, series, chapters[], chIndex, mode, prefs`, `stack[]` (rendered sections in reading order; 1 entry outside infinite), `loaded: Map` (chapterId → {chapter, blocks, wordCount}), `pending: Map` (de-dupes concurrent resolves), `anchor`, `page/pageCount/colW/pct`, `appending`, `suppressSyncUntil`.
- `dom = {}` :265 built once; `disposers = []` :266 (everything close() must undo); module-level flags/timers :267-281 (`built, wired, sheetOpen, dividerIO, tailIO, resizeObs, scrollRaf, turnTimer, toastTimer, progressTimer, progressDirty, lastProgressAt, suppressClickUntil, lastFocus, fontToken`).
- `on(target, type, fn, opts)` :283 — addEventListener + pushes remover into `disposers`.

### DOM construction (:292-428)
- `ensureDom()` :292-390 — builds once: root (`role=region`, NOT `role=application`, comment :299-301 explains why for screen readers) → `.nv-viewport > .nv-stage > .nv-measure > .nv-doc` (`role=document`); `.nv-zones` with 3 zone buttons (paged only, CSS hides elsewhere) :317-326; header (back, titles, settings "Aa" button) :329-338; footer (prevCh, status line `aria-live=polite`, progressbar with ARIA, nextCh) :341-355; scrim + sheet :358-363; toast (`role=status`) :366-369; `dom.tail` :383-386 — a 1px zero-visual marker the infinite tail IntersectionObserver watches instead of scroll math; `registerScreen(root)` exactly once :389 (element outlives close() on purpose — re-registering per chapter would leak into reader.js's screen set).
- `ICON_PATHS` :394-399, `iconBtn(label, kind)` :401-428 — buttons with inline static SVG; the "aa" kind is a text glyph.

### Settings sheet (:436-731) — **this is the design language for the goals UI, see §4 below**
- `sheetSync = []` :438 — array of `fn(prefs)` refreshers; every row builder pushes one; `syncSheet()` :731 runs them all.
- `buildSheet()` :440-591 — `aside.nv-sheet[role=dialog][aria-modal]`, `hidden` + `inert` (comment :443-446: stylesheet keeps [hidden] sheets displayed off-screen for animation, so `inert` is what actually removes them from tab order). Body rows in order: mode segRow :460, themeRow :466, typeface segRow with live specimen previews :468-476, text size stepRow :478, line height stepRow :486, line width segRow :494, alignment segRow :501, paragraph spacing segRow :506, letter spacing stepRow :515 (comment: evidence-backed for dyslexic readers), word spacing stepRow :523, indent toggle row (button + On/Off `nv-pill`) :532-543, actions row ("Reset to defaults" / "Apply to all series") :546-559, keyboard help row (CSS-hidden on touch-only) :562-586.
- `segRow(label, options, get, set, opts)` :595-627 — `.nv-row` > `.nv-row-label` span + `.nv-seg[role=group]` of buttons with `aria-pressed` + `dataset.value`; `opts.preview` renders each font option **in the face it selects** via `data-font` on the button (:607-614). Pushes a sync fn that repaints `aria-pressed` from `get()`.
- `themeRow()` :632-693 — `.nv-themes` grid of `.nv-swatch` buttons painted in their own palette (inline `style.background/color` from `THEME_SWATCHES`), plus a trailing `custom` swatch and two `<input type=color>` pickers (`.nv-pickers`, hidden unless theme==='custom' :687).
- `colorField(label, get, set)` :695-710 — `<label class=nv-picker>` wrapping a color input; `input` event fires continuously during picking = live preview, each event is one cheap style write (comment :699-700).
- `stepRow(label, cfg)` :712-729 — `.nv-step` with −/+ buttons and an `<output aria-live=polite>` formatted by `cfg.fmt`.
- Sheet open/close + a11y: `setBackdropInert(on)` :736-738 (`inert` on viewport/zones/header/footer — makes `aria-modal` actually true), `openSheet()` :740-752 (saves `lastFocus`, focuses first sheet button), `closeSheet()` :754-766 (restores focus).

### Preferences → CSS (:772-902)
- `readPrefs()` :772-791 — reads every key through `storeGet` with `oneOf/clamp/num/hexColor` validation; sets `state.prefs` and `state.mode`.
- `applyPrefs()` :795-821 — **the only place that touches root presentation.** Writes `data-mode/theme/font/width/para/indent` attributes and custom properties `--nv-size` (px), `--nv-lh`, `--nv-align`, `--nv-track` (letter, em), `--nv-word` (em). Custom theme only: sets `--nv-bg`/`--nv-fg` + `data-lum` (dark/light by luminance < 0.4) ; presets get properties *removed* so the last custom pair can't bleed (:812-820).
- `fontReady(family)` :829-842 — `document.fonts.load()` for 400/700/italic; **never rejects** (a failed font is cosmetic; fallback stack is already on screen).
- `setPref(key, value, relayout)` :846-857 — no-op if unchanged; store; if `relayout` (false for purely chromatic changes like theme, comment :844-845): capture anchor → `applyPrefs` → `layout()` → `settleLayout(anchor)`; fontFamily additionally `settleWhenFontLands`.
- `settleWhenFontLands(fontValue)` :863-875 — **font settling**: lays out twice — immediately on fallback metrics (never a frozen screen), then again when the file lands; the anchor carries across both so the sentence being read does not move. `fontToken` (:281, ++ at :866) guards out-of-order settles; also bails if reader closed or font pref changed meanwhile.
- `resetPrefs()` :877-889 — `Store.prefs.clearFor(seriesId)`, re-read, rebuild if mode changed, toast.
- `applyPrefsToAll()` :891-902 — copies current prefs to global keys, clears the series overrides, toast.

### Block rendering (:906-982)
- `renderBlock(b)` :911-965 — **returns an element for EVERY block, including rejected payloads, so `blockEls[i]` always corresponds to `blocks[i]`** (anchors are indices; dropping a block would shift all later anchors — comment :908-910). hr → `<hr>`; img → `<figure.nv-figure>` with `loading = state.mode === 'paged' ? 'eager' : 'lazy'` (:927 — long comment: lazy images in translated/clipped columns never intersect so would never load, and pagination needs intrinsic heights), `decoding=async`, empty `alt` (caption carries the text, avoids double announcement), error → `.nv-img-failed` class (zero-layout dead image), `src` through `window.proxyImageUrl` when present :936; note → `<aside.nv-note>` (not `<p>` — specificity comment :943-945); blockquote/ul/ol; unknown t → `<p>` per §1.3.
- `onImageSettled()` :973-982 — late image loads coalesce (120 ms timer) into ONE capture→layout→settle so twenty plates don't thrash.

### Section building (:988-1186)
- `makeEntry(data)` :988 — `{chapter, blocks, wordCount, section, blockEls, divider, collapsed, height}`.
- `buildSection(entry)` :1001-1030 — `<section.nv-section data-chapter-id>`; infinite mode prepends a `.nv-divider` (visual rule AND the dividerIO target); collapsed entries render as an empty fixed-height box (`.nv-collapsed`, `style.height = entry.height`).
- `fillSection(entry)` :1035-1073 — chapter-mode top nav ornament; skips its own chapter title if blocks[0] duplicates it (:1042-1044); renders all blocks with `node.dataset.b = i`; chapter-mode bottom nav; `.nv-end` "You have reached the end of this series." on the last chapter.
- `emptySection(entry)` :1076-1087 — strips a section back to just its divider.
- `RULE_SHAPES`/`geometricRule()` :1091-1114 — static SVG ornament (diamond + dots + rules), author-controlled.
- `chapterNav(entry, top)` :1120-1158 — top = decoration only; bottom = `< | ◆ | >` nav buttons calling `goChapter(±1, 'start')`.
- `chapterIndexOf(id)` :1160, `entryFor(id)` :1165, `currentEntry()` :1170.
- `renderStack()` :1175-1186 — clears `.nv-doc`, appends all sections; infinite mode appends `dom.tail` + `observeInfinite()`; otherwise `teardownInfiniteObservers()`.

### Layout (:1192-1261)
- `layout()` :1192 — paged → `paginate()`; else clears the multicol styles; then `updateChrome()`.
- `paginate()` :1208-1235 — measures `.nv-measure` clientWidth/Height; sets doc `height/columnWidth/columnGap`; publishes `--nv-colh` (column height minus caption room) so CSS caps illustration height :1219; computes `pageCount` from `scrollWidth` **plus** a second opinion from the last laid-out element's right edge (scrollWidth on overflow:visible multicol is unreliable across engines, :1225-1227); clamps `state.page`; translates.
- `setTranslate(x, animate)` :1245 — `translate3d`, `.nv-animate` class + `TURN_MS` cleanup, honors reduced motion. `gotoPage(p, animate)` :1256 → `syncPosition()`.

### Anchors (:1267-1452) — the heart
- `textLengthOf(el)` :1267 — TreeWalker sum of text nodes.
- `rectAtChar(root, idx)` :1278-1299 — Range around one character → its DOMRect.
- `firstCharMatching(el, test)` :1304-1315 — binary search; legal because rects are monotonic in reading order for both modes.
- `captureAnchor()` :1327 — dispatch: `capturePaged()` :1332-1354 (finds block overlapping current column window — overlap not containment, :1344-1346 — then binary-searches the first char at/after page start) / `captureScroll()` :1356-1389 (first block whose bottom crosses the fold; **if the fold sits inside a collapsed spacer, returns the PREVIOUS anchor** — returning block 0 would overwrite real progress with a "confident lie", comment :1358-1363).
- `currentAnchor()` :1400-1403 — **returns the STORED anchor, not a fresh read** (long comment :1391-1399: chained layout ops would otherwise walk the reader one block backwards per tap; only `syncPosition()` — an actual reader move — may re-capture).
- `stagePadTop()` :1405, `anchorRect(anchor)` :1414-1425, `restoreAnchor(anchor)` :1427-1450 — paged: derive page from char x-offset; scroll: adjust `viewport.scrollTop` by delta with `suppressSync(250)` so the correction doesn't feed back into onScroll.
- `suppressSync(ms)` :1452.

### Character offsets ↔ Progress (:1458-1486)
- `prefixChars` :1458, `totalChars` :1465 (memoized on `entry._chars`), `charOffsetOf` :1474, `anchorFromResume(entry, r)` :1479 — resume `{blockIdx, charOffset}` → anchor, clamped.

### Chrome (:1496-1621)
- `anchorEntry()` :1496 — chapter of the ANCHOR (observer and anchor can disagree for a frame near boundaries; derived values must agree with the persisted record, :1492-1495).
- `scrollPct(entry)` :1518-1551 — scrollbar-style fraction of the chapter's scrollable range (long rationale :1500-1517: the char-offset measure caps a finished chapter at ~88% on a phone because the anchor is the TOP of the viewport; `completed` — which gates advancing on resume — could never fire). Measures against `.nv-stage` padding (the readable band) and the last *prose* block's bottom, not the section box. Returns null when geometry is untrustworthy → caller falls back to char measure.
- `updateChrome()` :1553-1606 — title/subtitle, prev/next disabled state, pct + position string (paged: "Page N / M"; scroll: "NN%"), `N min left` from `wordCount * (1-pct) / WPM`, status line with `.nv-sr-only` out-of-band commas for screen readers, progressbar `--nv-pct` + `aria-valuenow`.
- `toggleChrome(force)` :1610 — `.nv-chrome-hidden` class. `toast(msg, ms)` :1615 — 2.6 s default.

### Position sync + progress persistence (:1630-1689)
- `syncPosition(write)` :1630-1636 — after the reader MOVES: re-capture anchor (screen is now the truth), updateChrome, scheduleProgress.
- `settleLayout(anchor, write)` :1646-1651 — after LAYOUT changes under a stationary reader: restore, chrome, schedule. **Deliberately does not re-capture** (comment :1638-1645).
- **Progress throttling**: `scheduleProgress()` :1653-1658 — sets `progressDirty`; single timer waits `max(0, 1000 − (now − lastProgressAt))` → writes are ≥ 1 s apart. `flushProgress()` :1660-1689 — writes the full denormalized Progress patch via `Store.putProgress` (seriesTitle/type/cover, chapterId/Num/Title/Count, `blockIdx`, `charOffset`, `pct` (round4), `completed: pct >= 0.985` :1683); catch-and-ignore ("progress is best-effort; never break reading over it"). Flush is forced on: `visibilitychange` when hidden :2051, `pagehide` :2052, `goChapter` :1759, `setMode` :1951, `close()` :2350-2351.

### Chapter loading (:1695-1728)
- `chapterData(chapter, blocks, wordCount)` :1695 — computes wordCount from blocks if not given.
- `loadChapter(index)` :1705-1728 — cache-check `state.loaded`, de-dupe via `state.pending`, calls `window.resolveChapterContent(series, ch)` (provided by catalogue.js; cache-first, network-second per §4), stores result in `state.loaded`, returns null on failure with `console.warn('[NovelReader] chapter load failed', err)`.

### Navigation (:1734-1806)
- `nextPage()`/`prevPage()` :1734-1744 — paged: page±1 else chapter±1 (`prevPage` lands at 'end' of previous chapter); scroll modes: `scrollByViewport(dir)` :1746 (viewport-height step, smooth unless reduced motion).
- `goChapter(delta, where)` :1753-1794 — bounds toast; flushProgress; loadChapter; **replaces the stack with one entry**; landing position expressed AS AN ANCHOR not a page number (comment :1769-1775: paging back into a chapter with undecoded illustrations would otherwise land 2 pages short after reflow); renderStack, layout, settleLayout, `applyWindow()` if infinite, `prefetchNeighbours()`.
- `prefetchNeighbours()` :1798-1806 — 400 ms debounce, warms `chIndex + 1` only.

### Infinite mode (:1812-1942) — **memory model, see §5**
- `teardownInfiniteObservers()` :1812.
- `observeInfinite()` :1817-1845 — two IntersectionObservers on `root: dom.viewport`:
  - `dividerIO` :1823-1838, `rootMargin: '-8% 0px -84% 0px'` — a thin band below the header; the divider in it (or that last left upward) names the current chapter → `setCurrentChapter`.
  - `tailIO` :1841-1844, `rootMargin: '0px 0px 150% 0px'` — append-ahead budget of ~1.5 viewports → `appendNext()`.
- `setCurrentChapter(idx)` :1847-1854 — chIndex, `applyWindow`, chrome, scheduleProgress, prefetch.
- `appendNext()` :1856-1883 — guarded by `state.appending`; loads next; race-check `entryFor`; **append-only** `insertBefore(sec, dom.tail)` :1872 ("never prepend (§4)" — append-only keeps scroll anchoring sane); observes new divider; `trimStackFront()`; `applyWindow()`; re-observes tail :1877-1881 (IO only reports threshold *crossings* — a chapter shorter than 1.5 viewports would stall the chain otherwise).
- `trimStackFront()` :1887-1896 — while stack > `MAX_STACK` (12): shift front entry, unobserve divider, `section.remove()`, and **manually correct `viewport.scrollTop` by exactly the removed height**.
- `applyWindow()` :1900-1912 — keeps `±WINDOW_RADIUS` (2) around current chapter live (~5 chapters); outside → `collapseEntry`, inside → `expandEntry`.
- `collapseEntry(entry)` :1914-1925 — freeze `offsetHeight` BEFORE emptying, set fixed height + `.nv-collapsed`, `emptySection` (divider survives as IO target).
- `expandEntry(entry, above)` :1927-1942 — refill; if the entry is above the reader, adjust scrollTop by the height delta with `suppressSync(200)`.

### Mode switching (:1948-1997)
- `setMode(mode)` :1948-1959 — capture anchor, flush, persist pref, applyPrefs, `rebuildForMode(anchor)`, settle.
- `rebuildForMode(anchor)` :1964-1989 — chIndex from anchor's chapter; infinite: keep already-loaded entries within the window (un-collapse them), else `rebuildSingle()` :1991-1997 (one entry from `state.loaded` or the existing stack head).

### Input (:2007-2228)
- `wire()` :2007-2061 — all listeners through `on()` so `unwire()` :2063-2069 can pop `disposers`. Tap zones with `swallowClick()` guard; scroll-mode prose tap toggles chrome unless target is a control or a selection exists :2018-2024; sheet focus trap (Tab wrap) :2033-2040; `document.keydown` :2042; `viewport.scroll` passive :2043; pointer events on zones for drag-to-turn :2046-2049; `visibilitychange`/`pagehide` flush :2051-2052; **ResizeObserver on `.nv-measure`** (fallback: window resize) :2054-2060.
- `onKeyDown(e)` :2071-2119 — Esc (sheet then reader), arrows/PgUp/PgDn/Space(±shift), Home/End, `[`/`]` chapters, `+`/`-` font size, `s` sheet, `h` chrome, `?` sheet. Skips inputs/textareas/contentEditable and modified keys.
- `onScroll()` :2121-2130 — rAF-coalesced; ignored while `suppressSyncUntil`; `trackCurrentChapter()` then `syncPosition()`.
- `trackCurrentChapter()` :2139-2153 — **geometric fallback for fast scrolls** (long comment :2132-2138: a flick can pass the 8% dividerIO band without a threshold crossing, freezing chIndex → applyWindow never runs → collapsed sections never refill → "unbounded blank region". Geometry is the source of truth; the observer is just the cheap fast path).
- `onResize()` :2157-2171 — 120 ms debounce; skips if measure size unchanged; **uses the pre-resize `state.anchor`** ("the geometry on screen right now is already wrong for the new box").
- Drag-to-turn :2177-2228 — pointer capture on zones; activates after `SWIPE_SLOP` and horizontal dominance; `resist()` :2199 applies `RUBBER` (0.34) only at true book boundaries; `onPointerUp` :2207 — threshold `min(96, max(40, colW * 0.18))` px or flick (velocity > 0.5 px/ms && |dx| > 24); `suppressClickUntil = now + 350` so the release doesn't fire a tap-zone click; spring-back otherwise.

### Public API (:2234-2403)
- `resetSession()` :2234-2250 — clears observers, timers, rAF, stack, `loaded`, `pending`, doc contents.
- `api.open({series, chapter, blocks, resume})` :2262-2336 — ensureDom, resetSession, wire; chapters from `series.chapters` else `[chapter]`; **readPrefs/applyPrefs BEFORE first paint** (per-series prefs are synchronous → no flash of previous book's settings, :2280-2281); seeds `state.loaded` with the passed chapter; renderStack; `showScreen(SCREEN_ID)`; layout; syncPosition; prefetch; focus root. Resume: explicit `o.resume` OR `Store.getProgress(series.id)` **only when the stored row is about this chapter** :2324; applied via `settleLayout(anchorFromResume(...), false)` — a layout op, never syncPosition (:2308-2310). Finally `settleWhenFontLands` after resume so the reader's real position carries across the webfont re-layout :2329-2334. Returns a promise that settles once stored progress was consulted; the reader is on screen before it resolves.
- `api.close({navigate})` :2344-2372 — force `progressDirty = true` + flushProgress; closeSheet, resetSession, unwire, clear timers; **root stays in the document (hidden) and stays registered** :2363-2365; `navigateAway()` → `Catalogue.goBack()` per §2.2.
- `api.isOpen()` :2374; `api.state()` :2377-2394 — read-only diagnostics for `test/novel-reader.test.html`.

---

## 3. Patterns and conventions (the codebase's design language)

- **Naming**: `SCREAMING_SNAKE` constants; camelCase functions; a single `state` object + a `dom` bag + a handful of module-level timers/flags. CSS classes all `nv-` prefixed, scoped under `#novel-screen`. Pref keys namespaced `novel.*`. Console messages prefixed `[NovelReader]`.
- **DOM creation**: everything through `el(tag, className, text)`; SVG via `createElementNS` from static author-controlled tables; **no innerHTML anywhere**; content strings only ever reach `textContent`/text nodes. Attributes for enum-ish state (`data-mode`, `data-theme`, `aria-pressed`), custom properties for continuous values.
- **Error handling**: expected failures return null/false and toast; `try { … } catch (e) { /* reason */ }` swallows with a one-line justification comment ("prefs are not worth throwing over", "teardown must not throw", "progress is best-effort"). Promises that can fail get `.catch(function () {})`. `fontReady` never rejects. Feature detection everywhere (`typeof IntersectionObserver === 'function'`, `window.Store &&`, `typeof window.registerScreen === 'function'`) — **this is exactly the progressive-enhancement seam js/platform.js should follow.**
- **Comment voice**: prose paragraphs explaining *why*, not *what*; often narrating the bug the code prevents ("Four taps on 'larger text' would then rewind four blocks"); em-dash heavy; first person plural. New code should match this voice.
- **ES5-ish syntax**: `function () {}` everywhere, no arrow functions, no classes, no async/await (Promise chains), `var`-free (uses const/let). IIFE module exposing one `window.*` global.
- **Listener hygiene**: global/document/window/observer listeners go through `on()` + `disposers`; own-element listeners added directly in builders (harmless to leave, but the wire()/unwire() split has an explicit audit rationale :2003-2006).
- **Accessibility is load-bearing**: aria-pressed on segments, aria-live status, `inert` + focus trap + focus restore for the modal sheet, `role=region` not `application`, sr-only punctuation. Any new UI (goals) is expected to match this bar.

---

## 4. Focus answers

### 4.1 The three reading modes
| mode | DOM | position mechanism | chapter boundaries |
|---|---|---|---|
| `paged` | 1 section in stack; CSS multicol (`column-width == .nv-measure.clientWidth`, definite height), track translated with `translate3d` (:1208-1254) | `state.page`/`pageCount`; anchor→page via char x-offset (:1433-1437) | page past end → `goChapter(1,'start')`; page before start → `goChapter(-1,'end')` (:1734-1744) |
| `chapter` | 1 section; `.nv-viewport` becomes `overflow-y:auto` (novel.css:242-246) | scrollTop; anchor = first block crossing the fold | in-prose `< ◆ >` nav at top/bottom (:1120-1158) + footer buttons |
| `infinite` | up to 12 sections, append-only, windowed (see §5) | scrollTop + dividerIO/geometric chapter tracking | auto-append at tail; `.nv-end` marker on last chapter |

Mode is a pref (`novel.mode`), switchable live via `setMode` :1948; position survives through the anchor. Tap zones/drag-to-turn only in paged; scroll modes use native scrolling with `overscroll-behavior: contain` and `-webkit-overflow-scrolling: touch`.

### 4.2 Settings sheet pattern (→ template for the goals UI)
Bottom sheet: `aside.nv-sheet[role=dialog][aria-modal]`, animated off-screen via CSS while `[hidden]`, made non-interactive via `inert`; scrim behind; backdrop made `inert` while open. Rows are built by three reusable factories — `segRow` (:595, segmented enum control), `stepRow` (:712, −/+ stepper with formatted `<output>`), `themeRow`/`colorField` (:632/:695, swatch grid + native color inputs) — each of which (a) writes a pref via a setter closure and (b) pushes a refresher into `sheetSync[]`; `syncSheet()` re-derives ALL controls from `state.prefs` (state-down, events-up — no control holds its own state). Controls that select an aesthetic render *in* that aesthetic (font specimens, painted swatches). Actions row pattern for buttons ("Reset to defaults" / "Apply to all series") with per-series vs global semantics. **A goals sheet should reuse: `.nv-row`/`.nv-row-label` layout, segRow/stepRow factories, the sync-array idiom, per-series `storeGet/storeSet` with validated reads, toast() for confirmations, and the `hidden+inert+focus-trap` modal discipline.** Note ARCHITECTURE §3.2: opening the sheet pulls ~200 KB of font regulars because specimens render in themselves.

### 4.3 CSS custom property application
One writer: `applyPrefs()` :795. Discrete knobs → `data-*` attributes that novel.css maps to custom properties (e.g. `[data-width='narrow'] { --nv-maxw: 32rem }` novel.css:208-217); continuous knobs → inline custom properties on `#novel-screen` (`--nv-size`, `--nv-lh`, `--nv-align`, `--nv-track`, `--nv-word`). Themes are attribute-selected token sets (novel.css:105-178); custom theme sets only `--nv-bg`/`--nv-fg` + `data-lum`, everything else derived with `color-mix()` in CSS (§3.1). Layout also publishes `--nv-colh` (:1219) and the progressbar gets `--nv-pct` (:1604). Chromatic-only changes skip relayout entirely (`setPref(..., false)`).

### 4.4 Progress throttling
`scheduleProgress` :1653 + `flushProgress` :1660: dirty-flag + single timer, wait = `max(0, 1000 − sinceLast)` → ≥ 1 s between `Store.putProgress` writes; immediate flush on `visibilitychange`(hidden)/`pagehide`/chapter change/mode change/close. `completed: pct >= 0.985`. pct source: paged = page fraction; scroll = geometric `scrollPct` (scrollbar semantics so the bar can reach 100%) with char-offset fallback. **Goals hook: `flushProgress` is the single choke point where "reading happened" becomes durable.**

### 4.5 Font settling
Three bundled faces (`WEBFONTS` :66). `font-display: swap` + system fallbacks mean text is always legible; `settleWhenFontLands` :863 does the double layout (fallback metrics now, real metrics when `document.fonts.load` resolves), carrying the anchor across both; `fontToken` prevents out-of-order settles; guards on `state.open` and current pref. Also invoked at open() (:2333, after resume applies) and in resetPrefs. `fontReady` :829 loads 400/700/italic and never rejects.

### 4.6 Memory behavior in infinite mode — are old chapters ever released?
**DOM: yes, aggressively. JS data: NO — this is the key finding.**
- DOM windowing: `applyWindow` :1900 keeps ±2 chapters live around the current one; outside the window `collapseEntry` :1914 replaces prose with a fixed-height empty spacer (frees block elements, and removed `<img>` elements let decoded bitmaps be reclaimed). Divider element survives as the IO target.
- Hard cap: `MAX_STACK = 12` sections; `trimStackFront` :1887 removes the oldest sections entirely with manual scrollTop compensation. So the DOM never exceeds 12 sections / ~5 live chapters.
- **BUT `state.loaded` (chapterId → {chapter, blocks, wordCount}) is never evicted while the reader is open** (:252, filled at :1718, cleared only in `resetSession` :2242 on open/close). A long infinite-scroll session over hundreds of chapters accumulates every chapter's full Block[] text in JS heap for the whole session. For the mobile "aggressive memory optimization" requirement this is the #1 in-module target: add LRU eviction of `state.loaded` outside the window (re-resolvable cheaply via `resolveChapterContent`, which is cache-first from IndexedDB).
- Also unbounded-ish: `entry._chars` memo lives on entries (fine, entries are windowed), and `state.pending` self-cleans (:1725).

### 4.7 iOS-specific handling
- **Safe areas**: handled in CSS only, via `env(safe-area-inset-*)` baked into the layout tokens — `--nv-pad-top/--nv-pad-bottom` (novel.css:90-91), header padding (:498), footer padding (:504), sheet `padding-bottom` (:578), toast bottom offset (:770). Comment at novel.css:87-89: chrome floats over prose and these paddings are constant so toggling chrome never resizes the text box (which would repaginate). `stagePadTop()` (:1405) reads the resolved value at runtime — "expressed in rem + env() and only the engine knows what that resolves to". **For Capacitor: `viewport-fit=cover` in index.html must be present and the WKWebView must not inset content, or these env() values collapse to 0** — verify; also Android needs an equivalent (env() works in modern Chrome WebView with cutout mode).
- **Viewport height**: the module never uses `100vh/dvh/svh` — `#novel-screen` is `position:fixed; inset:0` (novel.css:96-97) and `.nv-viewport` is `position:absolute; inset:0` (:236-238), which sidesteps the iOS URL-bar viewport dance entirely. In a Capacitor WKWebView this is stable.
- **`window.visualViewport`: not used anywhere in the repo** (grep confirmed). Nothing compensates for the on-screen keyboard; the only text inputs in this screen are the two `<input type=color>` pickers (native picker UI, no keyboard). A goals UI that adds text/number inputs inside the sheet WILL hit the iOS keyboard-overlap problem — plan for visualViewport or Capacitor Keyboard plugin handling.
- **Scroll anchoring**: the module does its OWN anchoring; `overflow-anchor` is never set in CSS. The design leans on append-only insertion (:1872, "never prepend (§4)") so native scroll anchoring has nothing to fight at the tail; but `trimStackFront` (:1894) and `expandEntry` (:1940) mutate content ABOVE the viewport and then manually compensate `scrollTop`. Safari has no native scroll anchoring (safe); **Chrome/Android WebView does — potential double-compensation. Setting `overflow-anchor: none` on `.nv-viewport` is a cheap Android-side hardening.**
- Touch niceties: `-webkit-overflow-scrolling: touch` (novel.css:245, 589), `overscroll-behavior: contain` (:240) — stops pull-to-refresh/rubber-band chaining out of the reader, `-webkit-tap-highlight-color: transparent` (:102, 827), `-webkit-hyphens` (:276), `-webkit-backdrop-filter` for the frosted chrome (:491, 778). Pointer Events (not touch events) for drag-to-turn, with `setPointerCapture` in try/catch (:2181).
- `inert` (used for sheet/backdrop) requires iOS 15.5+/modern WebView — fine for Capacitor targets, but note it.

---

## 5. Extension points for the mobile refactor + goals feature

1. **`window.resolveChapterContent(series, chapter)`** (:1710-1714) — the ONLY content-fetch seam. A native Filesystem-backed cache slots in behind this without touching the reader.
2. **`window.proxyImageUrl`** (:936) — the only image URL rewrite seam; platform bridge can substitute native-served file URLs.
3. **`storeGet`/`storeSet`** (:209-221) — every preference read/write funnels through these two; already null-tolerant. Goals prefs should reuse `Store.prefs` (with its `or:prefs` CustomEvent bus, §3) and the same per-series-override semantics (`getFor/setFor`).
4. **`flushProgress`** (:1660) — single durable-progress choke point. A goals/timer engine can subscribe to reading activity here (chapter, pct, charOffset deltas, wordCount) without touching capture logic. `updateChrome` (:1553) already computes `words * (1-pct)` and WPM-based minutes — the raw material for word-count/time goals.
5. **`open()`/`close()`** (:2262/:2344) — session boundaries for reading timers (plus `visibilitychange` :2051 for pause/resume of a timer — the listener already exists).
6. **Settings-sheet factories** (`segRow` :595, `stepRow` :712, `sheetSync` :438, `openSheet/closeSheet` :740/:754) — the guided-customization design language for the goals UI (see §4.2).
7. **`toast()`** (:1615) — the established notification affordance (goal reached, timer done); a Capacitor haptics call belongs beside it and beside `gotoPage`/`onPointerUp` page turns.
8. **Adding a reading mode** = extend `MODES`, `captureAnchor`, `restoreAnchor` + a segRow option (per header comment :19-21). Nothing else dispatches on mode except layout/chrome cosmetics.
9. **`api.state()`** (:2377) — read-only diagnostics; extend for tests of goals behavior; `test/novel-reader.test.html` exists.
10. **Memory work**: LRU-evict `state.loaded` outside the infinite window (§4.6); optionally drop `blocks` from collapsed entries too (entry keeps `chapter` + `height`; refill via `loadChapter` on expand — expandEntry would need to become async-tolerant).

## 6. Risks / landmines for the refactor

1. **`blockText` ↔ DOM textContent parity** (:226-232): anchors and charOffsets assume the canonical block text equals rendered textContent character-for-character. Any rendering change (inline emphasis, goal markers, search highlights injected into prose) silently breaks anchors and resume.
2. **`renderBlock` index stability** (:908-910): never filter/drop blocks; every block must yield exactly one element at `blockEls[i]`.
3. **`state.loaded` unbounded growth** (§4.6) — the main phone-memory landmine in this module. Secondary: in paged/chapter mode the ENTIRE chapter is laid out at once; a pathological single-chapter book (imported TXT) becomes one giant multicol layout — CSS multicol over huge content is slow on low-end phones.
4. **Timing-window scroll suppression**: `suppressSync(250)` (:1443) and `(200)` (:1939) are wall-clock guesses. iOS momentum scrolling and slow devices can outlive them → a restore gets overwritten by a stale onScroll capture. Fragile under Capacitor if frame timing changes.
5. **Chrome/Android native scroll anchoring** may double-compensate `trimStackFront`/`expandEntry` scrollTop corrections (no `overflow-anchor: none` set) — §4.7.
6. **Safe-area dependence on `viewport-fit=cover`** and WKWebView config — if the wrapper insets the webview instead, chrome heights are wrong and `stagePadTop()` mismeasures (§4.7).
7. **Keyboard overlap**: no visualViewport handling; any new focusable text input (goals: custom targets, timer durations) inside `.nv-sheet` needs keyboard-aware positioning on iOS.
8. **Forced reflows are deliberate and hot**: `paginate()` reads `scrollWidth` + rects (:1223-1231); `rectAtChar` binary search does ~10 Range reads per capture; captures run on every rAF-coalesced scroll tick. On low-end Android this is the perf budget — don't add per-scroll work (e.g. goal-timer UI updates) inside `syncPosition`; hook `flushProgress`/1 Hz instead.
9. **`document.fonts` dependence** for settling (fine in WKWebView/modern WebView) and the fact that the settings sheet triggers ~200 KB of font fetches — in native offline contexts fonts must be bundled (they are, `fonts/`) and the SW route (`sw.js` runtime-caches `/fonts/**.woff2`) replaced/kept by the wrapper's asset serving.
10. **Global keydown on `document`** (:2042) — guarded by `state.open`, but a goals overlay or native UI must not fight the `Escape`/space handlers; follow the existing "target is input/textarea/contentEditable → ignore" rule.
11. **The root element intentionally leaks** (stays in DOM + screen registry, :2363-2365 and :387-389) — a hot-reload or repeated-boot native shell must not call `ensureDom` pathways expecting teardown; `built`/`wired` module flags assume one page lifetime.
12. **`resolveChapterContent` absence tolerance** (:1710): reader degrades to single-chapter mode without the catalogue — keep this seam intact when the platform bridge wraps fetching.
13. **`completed >= 0.985` and scrollPct geometry** (:1500-1551) are tuned to the current chrome padding; changing chrome sizes (e.g., adding a goals ribbon to the footer) changes `.nv-stage` padding and silently shifts what 100% means — keep chrome floating and paddings constant per novel.css:87-89.
14. **IntersectionObserver quirks already worked around**: tail re-observe (:1877-1881) and geometric `trackCurrentChapter` fallback (:2132-2153). Do not "simplify" these away; each guards a real stall/blank-region bug described in its comment.
