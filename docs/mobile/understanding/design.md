# Offline Reader — Visual Design System Map (slice: CSS / themes / manifest)

Sources read completely: `docs/ARCHITECTURE.md` (binding contract), `styles.css` (990
lines), `css/catalogue.css` (1062), `css/novel.css` (848), `css/importer.css` (606),
`manifest.json` (35), plus `index.html` head metadata. All paths are relative to
`/home/user/Offline-Reader/`. Purpose: everything a downstream planning agent needs to
make a Capacitor-wrapped mobile build and a new **goals module (with timers)** look
native to this app.

---

## 1. Stylesheet architecture — who owns what

Load order (index.html:14-17, and it matters — later sheets deliberately re-declare
earlier selectors):

| Sheet | Owner module | Scope mechanism | Namespace |
|---|---|---|---|
| `styles.css` | reader.js + shared shell (`index.html` markup) | **unscoped, app-global**, hard-coded dark | id selectors + bare classes |
| `css/catalogue.css` | js/catalogue.js | `--cat-` token prefix (cannot scope by container: `.cat-toast` lives on `<body>`, catalogue.css:12-16, 964-991) | `cat-` |
| `css/novel.css` | js/novel-reader.js | **everything under `#novel-screen`** (novel.css:1-11) | `nv-` |
| `css/importer.css` | js/importer.js | everything under `#import-screen` (importer.css:1-11) | `imp-` |

Contract rules (ARCHITECTURE.md §2, lines 133-155): each module owns exactly its own JS
file and CSS file; modules create their own DOM at init (`document.body.append`);
`index.html` stays markup-light. **A goals module therefore gets `css/goals.css` +
`js/goals.js`, a new screen id (register via `window.registerScreen(el)` /
`showScreen('goals-screen')`, ARCHITECTURE.md:157-164), and a namespace prefix (e.g.
`gl-` or `goal-`).**

Key convention stated verbatim in catalogue.css:6-16 and repeated in every sheet header:

- one namespaced class prefix per module;
- **every colour, radius and duration is a custom property** — "a theme swap is a token
  edit rather than a search-and-replace";
- module tokens **defer to the app-wide token in styles.css with a fallback**, e.g.
  `--cat-bg: var(--bg, #0a0a0a)` (catalogue.css:28), `--imp-bg: var(--bg, #0a0a0a)`
  (importer.css:14) — "this screen has to look right even if it is loaded on a page that
  never defined them (the test harness does that)" (importer.css:6-8).

Comment voice throughout is didactic first-person-plural prose explaining *why*, often
with hardware-specific rationale (e.g. styles.css:259-261: three simultaneous
backdrop-blur layers "stress the GPU on mid-range Android and older iPhones";
styles.css:173-175: flex-column to avoid hairline gaps "especially visible on 3× iPhone
screens"). New CSS should keep that voice.

---

## 2. Global token set (styles.css:3-11) — the app-wide dark-first palette

```css
:root {
  --bg:     #0a0a0a;                     /* near-black, NOT pure black */
  --surf:   rgba(255,255,255,0.08);      /* white-alpha surface */
  --border: rgba(255,255,255,0.1);
  --accent: #6366f1;                     /* indigo-500 — the app's identity colour */
  --text:   #f0f0f0;
  --muted:  #a0a0a0;
  --page-gap: 0px;                       /* comic page gap, JS-toggled */
}
```

There is **no light mode for the app shell** — the shell is permanently dark
(`html, body { background-color: var(--bg) !important }`, styles.css:13-19). Only the
novel reader themes itself (see §4). System font stack everywhere for chrome:
`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` (styles.css:16).
`overscroll-behavior: none` on body (styles.css:17).

Catalogue extends the palette (catalogue.css:27-63):

- surfaces ladder: `--cat-surf-1: rgba(255,255,255,0.04)` → `--surf` 0.08 → `--cat-surf-2: 0.12`
- `--cat-border-soft: rgba(255,255,255,0.06)`
- accent family: `--cat-accent #6366f1`, `--cat-accent-ink #a5b4fc` (readable indigo text
  on dark), `--cat-accent-soft rgba(99,102,241,0.14)` (fills), `--cat-accent-line
  rgba(99,102,241,0.42)` (borders)
- **semantic colour code**: prose/novel = amber `--cat-novel #fbbf24` (+soft/line
  variants, lines 41-42); images/manga = indigo. "they are never the same colour
  anywhere in the app" (catalogue.css:277-278). Success = `--cat-ok #34d399`.
- importer adds status colours: `--imp-danger #f0616d`, `--imp-warn #e8b23a`,
  `--imp-ok #4ade80` (importer.css:21-23).
- accent hover/active darkens to `#4f46e5` (active, catalogue.css:344, 775) or `#5457e8`
  (hover, catalogue.css:998, 1001); importer hover lightens to `#7477f0` (importer.css:225).

**A goals module should declare `--goal-*` tokens deferring to `--bg/--surf/--border/
--accent/--text/--muted` with the same fallback literals, plus any semantic colours it
needs (timer-running could reuse `--cat-ok` green family; overdue could reuse the danger
red family).**

## 3. Radius / spacing / typography / motion scale

**Radius** — "Rounded ~10px cards is the house style … Nothing here goes past 14px
except the scrim-free sheets" (catalogue.css:45-49):

- `--cat-r: 10px` (cards, buttons, inputs; `--imp-radius: 10px` importer.css:24)
- `--cat-r-sm: 8px` (nested/segments), `--cat-r-lg: 14px` (panels/rails)
- 6px: tiny chips, thumbs, focus-ring radius; 12px: toasts/notices; 50%: circular
  icon buttons; **24px top corners for bottom sheets only** (styles.css:337-338,
  novel.css:575). Explicit anti-pill comments: styles.css:50, 236, 299, novel.css:740.

**Tap targets** — `--cat-tap: 44px` floor ("44px is the floor for a finger",
catalogue.css:51-53), relaxed to 38px at `min-width: 48rem` (catalogue.css:1016-1022,
"the only tap-target breakpoint in the file"). Buttons: 40px min-height standard
(`.nv-btn` novel.css:520-526, `.imp-btn` importer.css:204), 48px for primary CTAs
(`.cat-primary` catalogue.css:762, `.cat-actions .cat-btn`:783), 34px small variant
(importer.css:229). Hit-area extension without box growth via `::after` pads
(catalogue.css:675-684, 703-711).

**Type scale (rem, chrome UI)** — no formal scale variable; observed ladder:
0.6/0.62 (micro labels) · 0.65-0.72 (badges, section labels, uppercase+letterspaced
0.06-0.14em, weight 700-800) · 0.75-0.85 (body/meta/buttons) · 0.88-0.95 (row titles) ·
1-1.1rem (headings) · 1.15 (hero title, weight 900) · 1.8rem h1 weight 800
(styles.css:44). Importer uses fractional rem (.8125 = 13px, .6875 = 11px). Numbers get
`font-variant-numeric: tabular-nums` **everywhere** (catalogue.css:272, 314, 737, 821, 911;
novel.css:543, 728; importer.css:492, 560) — timers MUST use this. Weights: 500-600
body, 700 emphasis, 800-900 heavy headings. Uppercase micro-label pattern:
`font-size .7-.75rem; font-weight 700; letter-spacing .06-.08em; text-transform:
uppercase; color: var(--muted)` (novel.css:593-598, importer.css:178-184,
catalogue.css:739-746) — use for goal card labels.

**Section spacing**: `.cat-section { margin-bottom: 1.75rem }`, screen body padding
`1.25rem 1rem`, shell `max-width: 860px` centered (`--cat-shell`), fluid gap
`--cat-gap: clamp(0.7rem, 1.4vw, 1.25rem)`.

**Motion**: `--cat-dur: 150ms`, ease `cubic-bezier(0.4, 0, 0.2, 1)` (`--cat-ease`,
also the sheet/chrome ease at 0.28-0.3s: styles.css:119, 341; novel.css:492, 577);
page-turn `--nv-turn: 190ms` with `cubic-bezier(0.22, 0.61, 0.36, 1)` (novel.css:284-286).
Press feedback = `:active { transform: scale(0.97-0.98) }` + surface bump — **not**
hover-first; hover styles exist only inside `@media (hover: hover) and (pointer: fine)`
(catalogue.css:995-1012). `-webkit-tap-highlight-color: transparent` on all interactive
surfaces. Every module has a `prefers-reduced-motion: reduce` block forcing 1ms durations
and cancelling transforms (catalogue.css:1048-1062, novel.css:805-810, importer.css:350-355
— spinner slowed to 2.4s, not stopped).

**Focus**: `:focus-visible { outline: 2px solid accent; outline-offset: 2px }`, and
`:focus:not(:focus-visible) { outline: none }` (catalogue.css:89-96, novel.css:220-224,
importer.css:39-43). Outline-only "so the ring never changes an element's own shape".

## 4. The 9 themes (novel reader only) — novel.css:62-179

Theme = `data-theme` attribute on `#novel-screen`, set by JS from pref `novel.theme`
(ARCHITECTURE.md:262). Each theme overrides 9 tokens: `--nv-bg --nv-fg --nv-muted
--nv-surf --nv-surf-2 --nv-border --nv-accent --nv-chrome --nv-shadow`.

| theme | bg | fg | accent | character |
|---|---|---|---|---|
| dark (default, :64-103) | #0a0a0a | #e9e9ec | #6366f1 | matches app shell |
| dim (:126-131) | #1a1b1e | #dcdce1 | #818cf8 | "grey rather than void" |
| black (:119-124) | #000 | #d6d6da | #7c7ff5 | OLED |
| light (:105-111) | #fbfaf8 | #1c1c1f | #4f46e5 | |
| cream (:133-139) | #faf3e3 | #33302a | #8a6d1f | "paper, not screen" |
| sepia (:112-118) | #f4ecd8 | #43341f | #9a5b1f | |
| tan (:141-147) | #e3d2b0 | #3a2c17 | #8a4f16 | "aged-paperback" |
| nord (:149-154) | #2e3440 | #e0e4ec | #88c0d0 | cool blue-grey |
| forest (:155-160) | #1a2420 | #dbe4de | #7fc9a0 | |

Plus **custom** (:162-178): user picks only bg+fg (`novel.customBg/customFg` prefs,
validated `/^#[0-9a-fA-F]{6}$/`, ARCHITECTURE.md:274-277); everything else is derived
with `color-mix(in srgb, …)` — muted = fg 58% into bg, surf = fg 8% transparent,
surf-2 = 15%, border = 18%, chrome = bg 74% transparent. Accent is picked by luminance:
`data-lum='dark'` → #8b93ff, `'light'` → #4f46e5 (:177-178). **This two-colour +
color-mix derivation is the app's model for "maximum reader control while guided by
design" — the goals module's customization should copy it rather than exposing 9 knobs.**

Light-theme token pattern (for any goals UI that must render inside a themed reader):
surfaces flip to black-alpha (`rgba(0,0,0,0.05/0.09)`), borders `rgba(0,0,0,0.13)`,
shadows soften (0.5 alpha → 0.18-0.24).

Note: the themes are per-`#novel-screen`, deliberately NOT global (novel.css:3-5,
catalogue.css:12-13). If goals UI appears **inside** the novel reader (e.g. a session
timer chip in `.nv-footer`), it must consume `--nv-*` tokens so it re-skins with the
theme; if it is its own screen it uses the dark app tokens.

Typography tokens (novel.css:76-86, driven by prefs §3.1 of ARCHITECTURE):
`--nv-font/size(19px)/lh(1.65)/maxw(42rem)/align/para/indent/track/word`, mapped from
`data-font/data-width/data-para/data-indent` attributes (:196-217). Settings sheet
"writes properties, never classes and never markup" (novel.css:7-11) — the state lives
in `data-*` attributes + CSS custom properties; JS writes one attribute/property, CSS
does the rest. **This is the house pattern for customizable UI and the goals module
should adopt it (e.g. `#goals-screen[data-density=…]`, `--gl-ring-color`, etc.).**

Bundled fonts: 3 SIL-OFL faces via @font-face (novel.css:26-60), `font-display: swap`,
never preloaded, variable-font Literata 400-700. Face stacks held as named tokens
`--nv-face-*` (:188-195) so the settings sheet specimens reuse them (:633-638).

## 5. Component patterns to reuse

**Bottom sheet** (the modal pattern — there are no centered dialogs anywhere):
- Image-reader chapter sheet: `#cs-overlay` fixed inset-0 scrim `rgba(0,0,0,0.5)`
  z-300 + `#cs-modal` bottom-anchored, `max-height: 65vh`, glass
  `rgba(10,10,10,0.45)` + `backdrop-filter: blur(24px) saturate(150%)`, radius
  `24px 24px 0 0`, slides via `transform: translateY(100%)` on `.ui-hidden`,
  `padding-bottom: env(safe-area-inset-bottom)` (styles.css:323-379).
- Novel settings sheet: `.nv-scrim` + `.nv-sheet` (novel.css:561-598) — same geometry,
  opaque `var(--nv-bg)` instead of glass, `max-height: 86%`, `[hidden]` +
  `display:flex !important; transform: translateY(101%)` for animatable hide.
  **At `min-width: 720px` the sheet becomes a right-docked 24rem side panel**
  (novel.css:788-801). A goals settings sheet should do the same.
- Sheet internals: `.nv-sheet-head` (title + close), scrollable `.nv-sheet-body`,
  `.nv-row` bordered rows with `.nv-row-label` uppercase micro-labels (novel.css:583-598).

**Buttons**:
- Primary CTA: solid accent, white text, radius 10, min-height 48, weight 800
  (`.cat-primary` catalogue.css:756-782; disabled = surf bg + muted text).
- Secondary: `var(--surf)` bg + 1px `var(--border)`, radius 10, weight 600-700
  (`.cat-btn`:318-338, `.imp-btn`:199-218; variants `--accent/--ghost/--danger/--small`
  importer.css:220-229).
- Icon button: transparent, 38-44px square, radius 10, `:active` surface flash
  (`.icon-btn` styles.css:218-224, `.imp-icon-btn` importer.css:73-88).
- Segmented control: 2px-padded track `--cat-surf-1` + border, inner buttons radius 8,
  `.active` = surf-2 + text (catalogue.css:346-370); selected-state alternative uses
  `aria-pressed='true'` + accent-soft bg + accent border (novel.css:612-616,
  importer .imp-seg.active:457-461). **State attribute convention: novel uses
  `aria-pressed`, catalogue uses `.active` class — for a new module prefer
  `aria-pressed` (it's the newer code).**
- Stepper: `.nv-step` 44×40 buttons flanking a `tabular-nums` `<output>`
  (novel.css:718-729) — ready-made for goal target / timer-duration pickers.
- Toggle: `.nv-toggle` full-width row, right-hand `.nv-pill` chip, accent border when
  pressed (novel.css:731-744).
- Color picker chip: `.nv-picker input[type=color]` stripped to a 30px rounded chip
  (novel.css:703-716).

**Progress**: thin bars only — 3px `.nv-bar` with width from `--nv-pct` custom property
(novel.css:546-557), 4px `.cat-bar` / `.imp-bar` with fill transition (catalogue.css:233-245,
importer.css:336-347). Goal progress should reuse this thin-bar language (a big ring
would be foreign); stats display pattern is `.cat-stats` strip of small bordered tiles —
value 1rem/800/tabular + uppercase 0.6rem label (catalogue.css:716-746) — ideal for a
goals dashboard (streak / pages today / minutes).

**Toasts**: fixed bottom-center above safe-area, dark glass, radius 12, max-width
`min(92vw, 30rem)`, fade+rise, z-400 (`.cat-toast` catalogue.css:969-991; `.nv-toast`
novel.css:768-784). Notices: fixed banners, amber/blue 0.92 alpha, radius 12
(styles.css:423-465). Empty state: dashed-border card, centered, title + body + button
(`.cat-empty`:584-608, `.imp-empty`:575-586).

**Cards**: `--cat-surf-1` bg + border + radius 10 rows; novel covers get the
"bound-book" treatment (`.cat-spine`, radius `3px 10px 10px 3px`, gradient spine edge,
catalogue.css:426-480). Placeholder covers: gradient `linear-gradient(135deg,#1a1a2e,#16213e)`
(styles.css:687, 740).

**Glass chrome**: fixed header/footer `rgba(10,10,10,0.45-0.88)` +
`backdrop-filter: blur(24px) saturate(150%)` + 1px white-alpha hairline, slide away with
`.ui-hidden`/`.nv-chrome-hidden` transform (styles.css:106-137, 555-565, novel.css:485-508).
**Performance rule: max ~2 concurrent blur layers; the autoscroll bar deliberately uses
solid `rgba(18,18,18,0.92)` instead because "three simultaneous blur layers … stress the
GPU on mid-range Android and older iPhones" (styles.css:259-277).** A persistent goal/
timer pill must follow the same rule (solid, not blurred, if header+footer already blur).
The autoscroll pill itself (styles.css:263-321) is the exact template for a floating
timer control: pill radius 100px, icon buttons, accent circular play/pause, 1px dividers.

**DOM/JS conventions the CSS assumes** (from comments): rows are real `<button>`s (need
`background:none; font:inherit; text-align:left` resets — catalogue.css:249-259, 78-86);
JS toggles `display` inline for a few containers (noted in comments at catalogue.css:585,
642, 751, 787); hide states are either `.hidden { display:none !important }`
(styles.css:381), `[hidden]` with animatable override, or `.ui-hidden` transforms.

## 6. Media queries & breakpoints — what adapts today, what doesn't

Complete inventory:

| Query | File:line | Effect |
|---|---|---|
| `min-width: 48rem` (768px) | catalogue.css:1016 | tap floor 44→38px, card floor 9.5rem, list grid 2-col |
| `min-width: 68rem` (1088px) | catalogue.css:1026 | shell 860→1180px, pad-x 1.5rem, card floor 11rem, control max-widths |
| `min-width: 720px` | novel.css:788 | settings sheet → docked right panel; `--nv-pad-x` 2rem |
| `min-width: 640px` | importer.css:590 | padding/cover/actions widen |
| `max-width: 380px` | importer.css:603 | segmented picker wraps 2×2 |
| `hover:hover and pointer:fine` | catalogue.css:995 | all hover states |
| `hover: none` | novel.css:764 | hides keyboard-shortcut help |
| `prefers-reduced-motion` | all four sheets | 1ms durations |

Also fluid (no query): `#series-grid` auto-fill `minmax(var(--cat-card-min), 1fr)`
(catalogue.css:383-388 — comment explains why the floor is rem not vw, :374-378);
hero cover `clamp(96px, 27vw, 152px)` (:623-626); continue-card
`clamp(13rem, 66vw, 16.5rem)` (:174); `#series-hero-desc { max-width: 78ch }` (:639);
old `#series-grid` fallback `minmax(110px,1fr)` in styles.css:710-715.

**What adapts well already**: catalogue (360px phone → 1280px+ desktop, tablet-ready via
the two rem breakpoints), importer, novel reader (reading measure is `--nv-maxw`-capped
and mode-aware). Design is explicitly mobile-first: "The narrowest target is a 360px
phone in a standalone PWA window" (importer.css:8-11).

**What does NOT adapt (tablet/desktop gaps for the refactor)**:
- `styles.css` (upload screen, image reader, home/series base rules) has **zero media
  queries** — the image reader is one column max-width 800px (`.page-wrapper`
  styles.css:183-189) at any size; no two-page spread, no landscape handling.
- No `orientation` queries anywhere; manifest allows `"orientation": "any"`.
- Only left/right safe-area consumers are importer header/body (importer.css:54-55,
  98-99) — **landscape-notch is unhandled in styles.css, catalogue.css, novel.css**
  (they only use top/bottom insets). On a Capacitor iPhone in landscape, reader chrome
  and catalogue padding will collide with the sensor housing.
- Breakpoint units are inconsistent (48rem/68rem vs 720px/640px/380px) — harmless but
  a goals module should pick the catalogue's rem convention.

## 7. Safe-area-inset usage (complete list)

Pattern: always `calc(<base> + env(safe-area-inset-*, 0px))`, with `viewport-fit=cover`
set (index.html:5). Top: styles.css:114 (reader header), 165 (top decor), 565 (home
header), 813 (series header); novel.css:90 (`--nv-pad-top`), 498; importer.css:53.
Bottom: styles.css:130 (reader footer), 170, 264 (autoscroll bar), 343 (sheet), 442/450/456
(notices); catalogue.css:72, 76, 973 (toast); novel.css:91 (`--nv-pad-bottom`), 504, 578
(sheet), 770 (toast); importer.css:100. Left/right: importer.css:54-55, 98-99 **only**.
iOS PWA meta: `apple-mobile-web-app-status-bar-style: black-translucent` (index.html:8)
— content draws under the status bar; the Capacitor StatusBar plugin must preserve this
(overlay mode) or every `env()` offset doubles/vanishes.

## 8. manifest.json (complete)

`name`/`short_name` "Offline Reader"; `display: standalone`; `orientation: any`;
`background_color` & `theme_color` **#1a1a1a** — note this **mismatches** the real app
background #0a0a0a and the `<meta name="theme-color" content="#0a0a0a">` (index.html:6);
splash/status-bar flash on launch. `start_url`/`scope` "./"; categories books/
entertainment; **`share_target`** (GET, params title/text/`url→add`) — the app accepts
shared URLs via `?add=` query; the Capacitor wrapper needs a native share-extension
equivalent or this feature silently dies. Icons: single `icon.svg`, `sizes: any`, used
for both `any` and `maskable` — **no PNG icons at all**; iOS App Store / home-screen
icons and Android adaptive icons must be generated for the native build (iOS does not
accept SVG app icons).

## 9. Style guide for the new goals module (concrete, binding)

1. Files: `css/goals.css` + `js/goals.js`; prefix `gl-`; screen `#goals-screen`
   registered via `registerScreen`; navigation only through `Catalogue.goBack()` etc.
   (ARCHITECTURE.md:165-179). Header comment in the house voice explaining scope.
2. Tokens block first: `#goals-screen { --gl-bg: var(--bg, #0a0a0a); … --gl-r: 10px;
   --gl-tap: 44px; --gl-dur: 150ms; --gl-ease: cubic-bezier(0.4,0,0.2,1); }`.
3. Dark UI on #0a0a0a; white-alpha surfaces 0.04/0.08/0.12; indigo #6366f1 accent with
   ink #a5b4fc / soft 0.14 / line 0.42 alphas; green #34d399/#4ade80 for met goals,
   amber #e8b23a for warnings, red #f0616d for danger. Radius 10 (8 nested, 14 panels,
   24 sheet tops only). No pure white text (#f0f0f0 max).
4. Timers/counters: `font-variant-numeric: tabular-nums`, weight 700-800; labels
   uppercase 0.6-0.75rem letterspaced muted. Progress = 3-4px accent bars; stats =
   `.cat-stat`-style tile strip.
5. Customization surface = bottom sheet (radius 24 top, scrim 0.5, translateY hide,
   docked panel ≥720px), rows + segmented `aria-pressed` buttons + `.nv-step` steppers;
   persist via `Store.prefs` keys `goals.*` (with `prefs.getFor(seriesId, …)` for
   per-series goal overrides — the per-series mechanism already exists,
   ARCHITECTURE.md:210-217, 272); state applied as `data-*` attributes + custom
   properties, never rebuilt markup. Derive customization palettes with `color-mix`
   from few stored values, validated on read like `novel.customBg`.
6. Interactions: `:active` scale 0.97 + surface bump; hover only inside
   `(hover:hover) and (pointer:fine)`; 44px tap floor (38px ≥48rem);
   `:focus-visible` 2px accent outline; `-webkit-tap-highlight-color: transparent`;
   `prefers-reduced-motion` block mandatory.
7. Safe areas: pad every fixed edge with `calc(base + env(safe-area-inset-*, 0px))`;
   include **left/right** (importer is the model) since this is going native.
8. Floating timer pill (if any): copy `#autoscroll-bar` (styles.css:263-321) — solid
   0.92 dark, radius 100px, above footer, **no backdrop-filter**.
9. If goal UI is injected into the novel reader (session timer in chrome), consume
   `--nv-*` tokens exclusively so all 9 themes + custom re-skin it for free.
10. All text via `textContent` (XSS boundary, ARCHITECTURE.md:107-111, 419-421);
    SVG icons inline, sized ~11-18px, `flex-shrink: 0`.

## 10. Risks / landmines for the mobile refactor

- **Blur budget**: `backdrop-filter: blur(24px) saturate(150%)` appears on 6+ fixed
  elements; codebase already caps concurrency for GPU reasons (styles.css:259-261).
  In a WKWebView/Android WebView wrapper this is the #1 jank/memory-pressure source —
  don't add more, and consider a low-power fallback (solid 0.92 backgrounds already
  proven in-app).
- **theme_color mismatch** (#1a1a1a manifest vs #0a0a0a app) will show as a wrong-colour
  splash/status bar in the wrapper; also Capacitor StatusBar/SplashScreen config must
  use #0a0a0a and overlay-webview mode or every safe-area calc breaks (§7).
- **SVG-only icons** (manifest.json:21-34) — native builds need generated PNG sets.
- **share_target** (manifest.json:12-20) has no native equivalent for free; needs a
  Capacitor share-extension plugin or the `?add=` entry point goes dead.
- **Landscape safe areas** missing in 3 of 4 sheets; a native iPhone app will be used
  in landscape (reader especially).
- **`orientation: any` + no tablet layout in styles.css**: iPad will render the image
  reader as a phone-width column; acceptable but not "native-feeling"; the 48/68rem
  catalogue breakpoints do carry iPad reasonably.
- **`min-height: 100vh`** used in styles.css (:18, 27, 85, 551, 802) — in native
  webviews with dynamic bars, prefer `100dvh`/`100svh`; the novel reader avoids this
  with `position: fixed; inset: 0` (novel.css:96-98), reader-screen relies on body flow.
- **Paged-mode invariant**: chrome toggling must never resize the text box
  (novel.css:87-91) — a goals timer bar injected into `#novel-screen` must float
  (position absolute over prose), never take layout space, or it silently repaginates.
- **catalogue.css deliberately overrides styles.css selectors** (header comment :18-23);
  load order index.html:14-17 is contract. A goals sheet must load after styles.css.
- **`color-mix()` and `:has()`** (novel.css:167-172, catalogue.css:555) set the browser
  floor at ~Safari 15.4-16.2+ / WebView equivalents — Capacitor's minimum iOS/Android
  targets must respect this; very old Android WebViews will mis-render the custom theme
  and list-layout delete padding.
- **`--cat-` tokens are on `:root`** (catalogue.css:27) global by necessity — a goals
  module must not redeclare `:root` tokens with the same names; scope under its screen id.
- **Scoping discipline**: novel themes must not leak out, and the goals screen must not
  inherit `#novel-screen` styling assumptions; the two "share a stylesheet with
  hard-coded dark colours" warnings (novel.css:3-5, importer.css:4-6) are the reason.
