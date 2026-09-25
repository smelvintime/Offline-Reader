# Desktop plan

The mobile performance plan (`docs/mobile/PERFORMANCE_PLAN.md`) exists because a
phone runs out of heat and battery before it runs out of work. A computer has
neither problem and a different set of them: a mouse, a keyboard, a window that
is not 390 pixels wide, and ten times the memory sitting unused. Every tuning
decision in the mobile plan reduces work. Several of them should not apply to a
desktop at all, and today they do, because nothing in the app knows the
difference.

This plan is deliberately small. Each item below was verified against the tree
before it was written, and the verification is quoted with it. Anything that
would need a profile, a device, or a guess about what desktop readers want is in
§6 (not doing) rather than dressed up as a task.

## Status ledger

| ID | Task | Status |
| --- | --- | --- |
| D01 | A desktop device class | IMPLEMENTED |
| D02 | Desktop coverage in the test harness | IMPLEMENTED |
| D03 | Keyboard and mouse in the image reader | NOT STARTED |
| D04 | Measure the voice path on a desktop before tuning it | MEASURED, GPU path added |
| D05 | Window-width layout audit | NOT STARTED |
| D06 | Immersive chrome in the novel reader | IMPLEMENTED |

## D01: A desktop device class

**Verified.** `memoryClass()` in `js/platform.js` resolves in four steps: an
explicit user override, `navigator.deviceMemory` **only when `os === 'android'`**,
the iOS model table **only when `os === 'ios'`**, then "inconclusive → mid". A
desktop browser matches neither branch, so every desktop falls through to `mid`
and reads the mid row of `TUNING`: 25 / 60 page windows, a 4/10 lookahead, and
(as of P07) a 192 MB decoded-bitmap budget. A workstation with 32 GB gets a
mid-tier phone's reading window.

1. Give `memoryClass()` a desktop branch. `navigator.deviceMemory` is available
   in Chromium on desktop too and is already parsed for Android; the existing
   thresholds (≤2 low, ≥6 high) are reasonable there. Safari and Firefox expose
   nothing, so those stay inconclusive, and inconclusive must keep meaning
   "mid", never "high".
2. Add a `desktop` row to `TUNING` rather than reusing `high`. The iPhone rows
   are bounded by what a phone can hold without being killed; a desktop tab is
   bounded by how much of the machine it is polite to take. Start from `high`
   and raise only the two that matter for the image reader, `cacheWindow` and
   `decodedMB`, leaving the disk budgets alone.
3. `test/platform.test.html` pins the tuning rows exactly (this is how P07's new
   key was caught), so the new row goes into that contract in the same change.
4. The pref override (`platform.memoryClass`) stays the escape hatch and must
   keep winning over any detection.

**Acceptance.** A desktop browser reports a class that is not silently `mid`, a
browser that exposes nothing still reports `mid`, and the tuning contract test
covers the new row.

**Done, with one deviation from the sketch above.** `memoryClass()` still
returns only `low | mid | high`: `js/novel-voice.js` validates against exactly
those three and silently falls back to `mid` on anything else, so a fourth value
would have quietly downgraded its idle-release policy from 120 s to 30 s on
every desktop. A detected desktop therefore reports `high`, and the widening
lives in `tuning()` as an overlay on the high row (`DESKTOP_TUNING`) rather than
a fourth row. Detection is `(pointer: fine)` and `(hover: hover)` rather than
`navigator.deviceMemory`, because the media queries answer in every engine while
`deviceMemory` is Chromium-only; `deviceMemory` is still believed when it reports
2 GB or less, so a small Chromebook stays `low`. The overlay carries only the
in-memory windows, so `chapterCacheMB` and `pageCacheMB` keep the phone values by
construction.

## D02: Desktop coverage in the test harness

**Verified.** `scripts/test-browser.mjs` creates every context with
`viewport: { width: 390, height: 844 }`. Every suite, including the three new
reader suites, has only ever run at phone width. There is responsive CSS to test
(8 `min-width` queries in `styles.css`, 16 in `css/catalogue.css`, and a
`max-width: 800px` reading column), and none of it is exercised.

1. Let a suite declare a viewport instead of hardcoding one for all of them.
   Keep 390x844 as the default so nothing existing changes.
2. Run at least the catalogue and both readers at a desktop width as well. A
   second pass at 1440x900 costs one more context per suite, not a second
   harness.
3. Assert layout facts that break loudly and cheaply: the reading column is
   capped rather than full-bleed, chrome is reachable, nothing overflows the
   window horizontally.

**Acceptance.** CI runs at both widths, and a regression that only appears on a
wide window fails the suite.

**Done, 2026-09-22.** `scripts/test-browser.mjs` now lets each suite declare
its viewport matrix. The catalogue, image reader and novel reader run at the
existing 390x844 phone size and at 1440x900. Their wide pass asserts that the
reading or catalogue column remains capped, fixed chrome stays inside the
viewport, and the document has no horizontal overflow. The novel-reader wide
pass also sends a real Playwright mouse click through the page-turn zone, which
covers the pointer-capture regression recorded under D06. Other suites retain
the phone-sized default, so this adds desktop coverage without multiplying
every browser test or changing mobile behavior.

## D03: Keyboard and mouse in the image reader

**Verified.** Eight modules attach `keydown` handlers; `js/reader.js` is not one
of them. The novel reader has a key map (arrows, `s`, `h`, `?`); the image reader
has none, so on a computer it can only be driven by clicking and scrolling. No
file in `js/` listens for `wheel`, so `js/image-zoom.js` offers pinch and
double-tap and nothing a mouse can do.

1. Give the image reader the key map the novel reader already has, and follow
   its shape rather than inventing a second convention: arrows and page keys for
   pages, brackets or similar for chapters, space for autoscroll, `h` for
   chrome, `?` for the sheet.
2. Ctrl or Cmd plus wheel to zoom, matching what every image viewer does, with
   plain wheel left as scrolling. Drag to pan while zoomed.
3. Keyboard focus has to be visible, and the shortcuts must not fire while a text
   field or the chapter selector has focus. The novel reader's handler already
   solves this; copy it.

**Acceptance.** The image reader is fully usable from the keyboard on a desktop,
the shortcuts match the novel reader's where they overlap, and nothing changes
on touch.

## D04: Measure the voice path on a desktop before tuning it

**Verified, and deliberately left as measurement.** The scheduler in
`js/novel-voice.js` already treats a desktop differently in two places worth
knowing about: prewarming is gated off for native only, so a desktop already
prewarms, and `lookaheadSeconds()` gives a fast engine a *smaller* cushion
(`NEURAL_LOOKAHEAD_SEC / 2` above a 1.5 margin) because a generator that runs
ahead does not need one. Both are defensible as written.

The thermal and Low Power inputs are native-only, so on a desktop `resources`
stays `{ thermal: 'unknown', lowPower: false }` and none of the mobile throttles
engage. That is correct, not a bug.

So the desktop voice question is not "raise the buffers". It is one measurement:
on a desktop, does synthesis outrun playback comfortably enough that the current
policy already idles? P01's diagnostics panel reports the margin. Read it on a
desktop before changing a constant.

**Separately worth investigating, not committing to:** the app is served without
cross-origin isolation, so `SharedArrayBuffer` is unavailable and the wasm voice
runs single-threaded. On desktop hosting, COOP/COEP headers could enable threads.
That is a hosting change with its own blast radius (cross-origin images, embeds),
so it is an experiment with a measured before and after, not a task.
*Done since, for phones as well:* `sw.js` now adds the headers itself (§2.14 of
docs/ARCHITECTURE.md). On a 4-core machine the vendored ORT binary ran a
synthetic conv stack at 617 ms on one thread and 167 ms on four.

**Acceptance.** A recorded desktop margin, and either a justified constant change
or a written no-change decision.

**One thing did not wait for the measurement, 2026-09-17.** A device report:
on a desktop the narrator said "preparing" before every sentence. The cause was
not a constant, it was a rule that does not apply here. `lookaheadSeconds()`
returns zero below break-even, so the pump queues exactly one group, and on a
phone that is right: a deeper queue cannot make a slow device catch up, it only
pins inference at full load and turns the battery into heat. A desktop has no
battery to spend and no thermal ceiling to back away from, and its wasm engine
is usually SLOWER than playback, so that same rule produced a wait before every
sentence. Below break-even a desktop now keeps generating (still capped at four
pending jobs). Mobile is untouched, and the test asserts both halves.

The margin measurement above is still worth taking. It answers the remaining
question, which is whether the desktop should also bank a bigger startup
prebuffer than the phone's thermal-bounded fifteen seconds.

**Measured, 2026-09-17, and it changed the answer.** Chrome on the reporting
desktop: `neuralMargin()` **0.23**, `lookaheadSeconds()` 40, `backend` wasm. The
machine produces 0.23 seconds of audio per second of compute, four times slower
than speech. That kills both remaining scheduling ideas: a deficit that
compounds cannot be absorbed by queue depth, and the prebuffer that would cover
a 30-minute chapter would itself take over 30 minutes to generate.

The cause is the engine, not the schedule. `NEURAL_DEVICE` was hardcoded to
`wasm`, wasm threads need cross-origin isolation (false on this deploy) so ORT
ran on one core, and four cores would still land under 1x. The bundle already
ships `ort-wasm-simd-threaded.jsep.wasm`, the WebGPU-capable runtime, so the GPU
path costs no new asset.

So the GPU path is back, **desktop only and opt-in only**: `navigator.gpu` plus
the `desktop` tuning flag, a toggle in voice settings that names the ~330 MB
fp32 download, and a fallback to wasm (once per session) if the GPU init fails.
The comment that deleted it is preserved, because every word of it was a phone
argument and phones still take the wasm path.

Still open: whether a desktop on the GPU wants a bigger prebuffer. Re-measure
`neuralMargin()` with the GPU on before touching that constant.

## D05: Window-width layout audit

**Verified only as "there is something to audit".** The responsive CSS exists but
was written phone-first, and `index.html` carries `viewport-fit=cover` with a
`max-width: 400px` on several shells. Whether a 1440-wide window reads well is a
judgement call that needs eyes, not a grep.

Once D02 can render at desktop width, walk the screens at 1440x900 and note what
is actually wrong: stretched rows, a reading column that is too narrow or too
wide, touch-sized hit targets that look odd under a cursor, chrome that hides
because it expects a tap. Fix what the list actually contains. Do not
pre-emptively redesign.

**Acceptance.** A written list of real defects with screenshots, then fixes for
the ones worth fixing.

## D06: Immersive chrome in the novel reader

**Reported from a desktop, 2026-09-17:** the reading UI never goes away, so the
voice transport sits over the prose for the whole book. Two separate causes,
both verified in a real Chromium at 1440x900 before anything was written.

**The tap zones were dead under a mouse.** `onPointerDown` in
`js/novel-reader.js` called `dom.zones.setPointerCapture(e.pointerId)` on every
pointerdown. For a mouse, the compatibility `click` is then retargeted to the
capture element, so it was delivered to `.nv-zones` rather than the
`.nv-zone-*` child that owns the listener. Measured: a real click on
`.nv-zone-next` did not turn the page and the click's target read `nv-zones`.
So on a desktop, clicking the middle to hide the chrome did nothing, clicking
to turn a page did nothing, and `h` was the only way in — undiscoverable.
Capture now happens when a drag is *recognised*, in `onPointerMove`, which is
the only moment it is needed. Touch is unaffected either way: the browser sets
implicit capture for direct-manipulation pointers itself.

This half is **not** covered by the in-page suite, and honestly so: the
retargeting is a property of real input, and a synthesised `click` is delivered
to whatever element it is dispatched on whether the bug is present or not. It
was verified by driving the app with Playwright's mouse and touchscreen — zone
click turns the page, middle zone toggles the chrome, drag-to-turn still turns —
at 1440x900 and at 390x844. A standing regression test for it needs the harness
to deliver real input at a desktop viewport, which is D02's job.

**Nothing hid the chrome on its own.** Hiding is a tap gesture, and a tap is
something a phone reader makes every few pages anyway. A mouse makes none — the
pointer sits still for a whole chapter — so the design simply never fired on a
computer. On a desktop (`Platform.tuning().desktop`, the D01 flag, read once
per `open()`) the chrome now hides itself after 2.6 s of a still pointer and
returns when the pointer enters the reveal band at the top or the bottom. See
§4 of ARCHITECTURE.md for the contract, including what holds the chrome up.

Deliberately not part of this: any new preference (the behaviour is keyed off
detection that already exists), any change to the image reader, and hiding the
cursor. `nv-chrome-hidden` already carries the voice transport and the goals
pill with it, so neither module changed.

**Acceptance.** A desktop reader sees prose and nothing else while the pointer
is still; the chrome is one mouse-move to the edge away; a phone behaves
exactly as before. The auto-hide half is covered by `T.testDesktopImmersive()`
in `test/novel-reader.test.html` (15 assertions, both branches of the gate);
the capture half is covered as described above.

## 6. Not doing

Named so they are decisions rather than oversights.

- **A separate desktop layout, or a second reader.** The responsive CSS is
  there; widen what exists.
- **Multi-column or two-page spreads in the image reader.** Plausible on a wide
  window, but nobody has asked for it, and it interacts with the scroll
  windowing, the anchor and progress. A feature request, not desktop parity.
- **Window management, tabs, or a desktop wrapper (Electron, Tauri).** The web
  app in a browser is the desktop story.
- **Raising any mobile budget "because desktops are fast".** The budgets are
  per-class. Add a class (D01); do not loosen the phone rows.
- **Removing touch-first behavior.** Desktop browsers deliver touch events too,
  and the same build serves tablets.

## Order

D01 first: it is one function and one tuning row, and it is the only item whose
absence silently degrades a desktop today. D02 second, because D03 and D05 both
want a way to see a desktop window in CI. Then D03. D04 and D05 need a person at
a desktop, so they run whenever that person is available.
