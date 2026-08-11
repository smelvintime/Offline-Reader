# Offline Reader — Device-matrix & memory test protocol (Phases 6–7)

This is the final on-device gate for the Capacitor refactor
(`docs/mobile/PLAN.md` §7) plus the Phase 7 additions
(`docs/mobile/PLAN7.md` §8.7 — scenarios 13–21 below). Phase 2 already did
the first-look emulation/simulator passes; nothing here is a first look. Run
it on real hardware built per `docs/mobile/NATIVE_BUILD.md`, record results
in the tables at the bottom, and treat every unchecked box as a blocker, not
a note.

Contract references: `docs/ARCHITECTURE.md` (§2.2 unified back table +
history sentinel, §2.3 Platform, §2.4 Goals, §2.8–§2.11 the Phase 7
modules), PLAN.md §6.5 (drills), §9 (budget numbers), PLAN7.md §2.11
(navigation) and §8 (gates).

---

## 1. Device matrix

Each device/orientation row runs the full scenario column set of §2. The
split-view widths matter because they produce phone-width viewports on a
tablet — exactly where breakpoint bugs hide.

| # | Device | Configurations | Why this device |
|---|---|---|---|
| D1 | iPhone SE (2nd/3rd gen) | portrait | small screen AND the low-RAM end of supported iPhones (3 GB → `memoryClass()` low) |
| D2 | iPhone Pro Max (14 Pro Max or later) | portrait + landscape | Dynamic Island + home indicator: the safe-area worst case; `high` class |
| D3 | iPad | portrait; landscape; split view at 1/3, 1/2, 2/3 widths (drag the divider through all three, both directions) | breakpoint engage/disengage; novel sheet right-dock at ≥720px; ≥1024px page width |
| D4 | Android phone, mid-range (3–4 GB RAM) | portrait + landscape | `navigator.deviceMemory` mid path; Android back button; `https://localhost/_capacitor_file_/` page URLs |
| D5 | Android tablet | portrait + landscape | tablet layouts on the Android WebView |

Also run once per release, not per device: the plain web build
(`python3 -m http.server` from repo root) — full manual pass, zero console
errors, and all five test pages green: `test/platform.test.html`,
`test/goals.test.html`, `test/novel-reader.test.html`,
`test/importer.test.html`, `test/thoughts.test.html`. Also boot once with
each optional module file removed (`goals.js`, `covers.js`, `thoughts.js`,
`sources.js`, `settings.js`) — zero console errors each time.

## 2. Scenario checklist (every matrix row)

Tick each cell per device. "Pass" means the stated observable, not "seemed
fine".

1. **Boot offline** — radios off, cold launch: boots to home with the bundled
   catalogue (native never falls back to `upload-screen`), offline badge only;
   `#home-version` shows `Platform.appVersion()`.
2. **Catalogue browse** — tabs, search, series screen. A 3000-chapter series
   renders ≤250 rows with a working "Show more"; grids chunk at 200 cards;
   range selects stay empty until the panel opens.
3. **Novel resume mid-sentence** — read to mid-chapter, rotate, change font
   family and size: the same sentence stays anchored through both settles. No
   layout shift on chrome toggle.
4. **600 MB+ image session** — multi-CBZ upload (native: through the picker;
   also once through the `<input>` fallback, which must keep the 600 MB cap).
   Smooth chapter jumps (150 ms defer intact), no OOM/jetsam. Run §3's memory
   capture during this scenario.
5. **Import EPUB / CBZ / TXT** — one of each via the native picker; re-import
   the same file (same name+size) and confirm progress resumes (identity
   preserved). Delete a series: archive file + page dirs gone
   (`Platform.archives.usage()` before/after).
6. **Goals day rollover** — with reading logged today, move the clock past
   midnight (or read across it): yesterday's DayLog closes, today starts at
   zero, streak math honors `goals.schedule` (a weekday-only schedule must
   not break over a weekend).
7. **Timer drills** (all three, per §5.4):
   - background the app mid-countdown 2 min → resume: remaining time is
     wall-clock-correct;
   - let it expire while hidden → resume: chime + haptic fire ONCE;
   - kill mid-countdown → relaunch: a still-running countdown resumes from
     `or.timer`; an expired one is silently discarded.
8. **Back-button paths** (Android rows; on iOS drive the same paths via UI):
   series → home → back minimizes; back from an open **novel** chapter runs
   `NovelReader.close({navigate:true})` — lands on the series screen with NO
   orphaned key handling (Escape/Space/arrows free) and the progress row
   flushed; back from an online image chapter runs the `#close-btn` path
   (progress synced); back from an upload-session reader performs the
   documented `location.reload()` reset.
9. **Deep-link intake** — open `offlinereader://add?url=…` from
   Safari/notes: the importer confirm screen opens prefilled (never a
   headless import). Web build: `?add=` share_target still works.
10. **Eviction drills** (all three of §6.5):
    - **(E1) full IDB wipe** — wipe IndexedDB, relaunch: restore offer
      appears; accepting restores series + progress; chapters re-hydrate from
      surviving native archives / re-download.
    - **(E2) progress-only** — clear only the progress store, keep series,
      relaunch: the partial-eviction offer appears and restores progress.
    - **(E3) backup freshness** — read for a day with zero imports: the daily
      `or:progress`-triggered backup wrote a fresh file (check mtime).
    Plus the Phase 1 localStorage drill: clear localStorage, keep the native
    Preferences mirror, relaunch — prefs, gap, autoscroll AND the
    upload-screen library list are correct **on the FIRST launch** (a
    second-launch pass is a fail).
11. **App-update drill** — bump the build number, install over the existing
    install (TestFlight/Xcode/adb): every imported CBZ chapter still opens —
    page URLs are re-derived this session, images render, nothing stale was
    persisted.
12. **Upload resume** — pick 20 CBZ files, close the app, relaunch: "Resume"
    reopens from disk with no re-picking; a 1.5 GB set indexes via
    `zip.list` only (webview heap flat, §3); reading holds ≤2 chapter
    page-dirs; finishing the set bumps `booksFinished` under `upload:<key>`
    exactly once.

### Phase 7 additions (PLAN7 §8.7; run on the same matrix rows)

13. **History sentinel & iOS edge-swipe** (iOS Safari + installed PWA; also
    desktop browser back on the Web column) — series → browser/edge-swipe
    back lands on home; back at home is consumed at most once, then default
    browser behavior; rapid home↔series flapping never accumulates history
    entries (one back always leaves cleanly — the at-most-one-sentinel
    invariant). **In-reader cancel artifact, expected and cosmetic:** an
    edge-swipe inside the novel or image reader plays iOS's native slide
    against a stale page snapshot and snaps back (§2.11-A — same-document
    history has no way to suppress the OS animation). The row verifies the
    reader neither tears down nor loses its place: same chapter, same
    position, no console errors, progress still flushing. **Native iOS:**
    verify there is NO edge-swipe back anywhere (gestures deliberately off,
    NATIVE_BUILD.md appendix) and the header back/home affordances cover
    every screen.
14. **Android hardware-back tour of the module screens** — from home open
    each of importer, goals, settings, sources, thoughts, series → hardware
    back exits each through its own close path (screen returns to where it
    came from, no orphaned sheets/scrims, settings sheet state not leaked);
    back inside novel/image readers still runs the reader close paths
    (scenario 8); back on the loading screen does nothing (cancel row).
15. **Home buttons in both readers** — series-origin novel and image
    sessions show the diamond-home header button; tapping mid-chapter lands
    on home with progress flushed (Continue rail reflects the position) and
    no orphaned listeners (novel keys freed; image globals cleared).
    Upload-origin image sessions HIDE `#home-btn` (and `#close-btn` reloads,
    as today).
16. **Nested zip-of-CBZs native import (memory)** — import a zip containing
    several CBZs via the native picker: inner archives extract to
    `Cache/pages/import-inner/` and index via `zip.list({cachePath})` with
    **zero archive bytes in the webview** (JS heap flat during import — the
    S3 criterion); the set is resumable after relaunch; deleting it removes
    archive files + page dirs.
17. **Status bar follows the app theme** (native iOS + Android) — switch
    through dark/dim/black/nord/forest (status-bar icons stay light) and
    light/cream/sepia/**tan** (icons flip dark); a custom theme follows its
    background's luminance (`data-applum`); relaunch paints the themed shell
    with no dark flash and the correct status-bar style from first frame;
    the image reader stays pinned dark under every light theme.
18. **Reader presets on device** — tapping a built-in preset changes every
    bundled key in ONE relayout with the anchor held (same sentence
    visible); presets persist per-series; "+ Save current" round-trips (note
    the accepted iOS keyboard-overlap risk: the name input scrolls into
    view); saved-chip delete + undo toast works; a 7th save refuses with the
    cap toast.
19. **Thoughts flows** — finish a novel in chapter/infinite mode → inline
    "Depart your thoughts" CTA under the end marker → composer → save → the
    tappable toast opens the thoughts screen (also with settings.js deleted
    — the toast is the settings-free entrance). Known gap, not a fail: the
    default **paged** mode renders no book-end CTA (PLAN7 completion log).
    Finish an image series → floating chip bottom-LEFT appears once, never
    on the novel screen, auto-dismisses ≤12 s; chapter-cadence prompts only
    when toggled on; edit/delete round-trip; thoughts survive series
    deletion and ride export/import.
20. **Sources shelf & browse** — save a source (relaunch keeps it); browse a
    listing through the gateway → cards render with covers (or generated
    fallbacks) → tapping lands on the importer confirm screen prefilled →
    after commit the item badges "In library"; a 25th save refuses with the
    shelf-full toast; gateway off → honest explainer + external-link cards,
    zero `/list` calls.
21. **Focus, home layout & the tutorial book** — fresh install: focus sheet
    appears once after home renders; "Start with the tour" opens *We Are
    Readers Here*; choosing Comics relaunches to the manga tab with Latest
    directly under Continue; reorder sections in Settings → home reflects
    instantly and after relaunch; All Series can move but never hide;
    "Reset to default" restores the focus-derived order. The tutorial book
    renders correctly in all three reading modes on-device (blocks,
    blockquote/list/rule variety, no images, cover SVG on cards).

## 3. Memory verification protocol

The §9 numbers are pass/fail, not aspirations. Windows (`MEMORY_WINDOW`
etc.) may be tuned if a class misses — the *targets* may not.

**Tools**

- **iOS:** Xcode memory gauge (Debug navigator) for process footprint;
  Safari Web Inspector → Timelines → Memory for webview JS heap.
- **Android:** `chrome://inspect` heap snapshots for the webview;
  `adb shell dumpsys meminfo <appId>` PSS for the process numbers.

**Class selection.** The low-class run uses the manage-view Performance row
(`platform.memoryClass` = Low) on non-low hardware — and, **once, on a real
≤2 GB device** before the low-class window values (12/30) are declared
final; they are provisional until then. Mid/high runs use `auto` on devices
the table classifies accordingly (verify with `Platform.memoryClass()` in
the console first).

**Scripted scenarios and pass/fail numbers (per class, iOS gauge = Android
PSS, same numbers):**

| Scenario | Measure | low | mid | high |
|---|---|---|---|---|
| S1 — steady-state image reading: 30 min continuous scroll through a large CBZ series, both view modes | steady-state webview/decoded-image footprint | ≤ 80 MB | ≤ 150 MB | ≤ 250 MB |
| S2 — steady-state total: S1 plus catalogue browsing and a novel chapter | process footprint (gauge / PSS) | < 150 MB | < 250 MB | < 350 MB |
| S3 — native CBZ import, 300 MB file via picker | webview JS heap during the whole import | within +50 MB of pre-import baseline (all classes — bytes must not cross the bridge) | same | same |
| S4 — web/blob import path (`<input>` fallback) | peak during import | < archive size × 1.2 + 150 MB (the 600 MB cap keeps this survivable) | same | same |
| S5 — upload indexing, 1.5 GB multi-CBZ set via picker | webview heap during indexing | flat (zip.list only; no crash on a 3 GB device) | same | same |
| S6 — novel infinite scroll, 30+ chapters | `NovelReader.state()` | `loaded.size ≤ maxLoadedChapters` (6) at all times | same (10) | same (14) |
| S7 — scroll-mode 1500-page load | DOM wrapper count | ≤ ~600 wrappers | same | same |
| S8 — full scenario set on a 3 GB iPhone | jetsam kills | **zero** | — | — |

Also verify during S1/S2 that the prune triggers actually fire: an
online-only session caching 30+ chapters runs `pruneChapterCache` at least
once, and (native) `prunePageCache` keeps `Cache/pages/` under the class cap.

## 4. Results record

Copy one block per release candidate. Version = `Platform.appVersion()` +
`sw.js` cache name.

**Matrix results** (P = pass, F = fail + issue link, — = n/a):

| Scenario | D1 SE | D2 Pro Max | D3 iPad (incl. split) | D4 Android phone | D5 Android tablet | Web |
|---|---|---|---|---|---|---|
| 1 boot offline | | | | | | |
| 2 catalogue browse | | | | | | |
| 3 novel resume/rotation | | | | | | |
| 4 600 MB image session | | | | | | |
| 5 import E/C/T + delete | | | | | | |
| 6 goals rollover | | | | | | |
| 7 timer drills ×3 | | | | | | |
| 8 back-button paths | | | | | | |
| 9 deep link | | | | | | |
| 10 eviction drills E1–E3 + localStorage | | | | | | |
| 11 app-update drill | | | | | | |
| 12 upload resume / 1.5 GB | | | | | | |
| 13 sentinel / iOS edge-swipe | | | | — | — | |
| 14 hardware-back module tour | — | — | — | | | — |
| 15 reader home buttons | | | | | | |
| 16 nested-zip import (memory) | | | | | | — |
| 17 status bar follows theme | | | | | | — |
| 18 reader presets | | | | | | |
| 19 thoughts flows | | | | | | |
| 20 sources shelf & browse | | | | | | |
| 21 focus / layout / tutorial | | | | | | |

**Memory results** (record the measured number, not just P/F):

| Scenario | device | class | measured | budget | verdict |
|---|---|---|---|---|---|
| S1 | | | | | |
| S2 | | | | | |
| S3 | | | | | |
| S4 | | | | | |
| S5 | | | | | |
| S6 | | | | | |
| S7 | | | | | |
| S8 | | low | | 0 jetsam | |

Low-class windows validated on real ≤2 GB hardware: ☐ yes (device: ______)
— until checked, 12/30 remain provisional.
