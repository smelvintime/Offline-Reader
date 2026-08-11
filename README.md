# Offline Reader

Read manga, manhwa and light novels in one place, in a reader you control.

Bring your own series: paste a link to wherever you already read something, and
the app builds its own catalogue entry for it — your typography, your reading
mode, your progress, kept on your device. Or open a CBZ or EPUB straight from
your phone with no network at all.

It is a static progressive web app. No framework, no build step, no accounts, no
database. Everything you read is stored in your browser.

---

## Try it

```bash
git clone https://github.com/smelvintime/Offline-Reader
cd Offline-Reader
python3 -m http.server 8000
```

Open `http://localhost:8000`. A short tutorial book — *We Are Readers Here* —
plus six public-domain classics ship with the repo, so there is something to
read immediately.

## Install as an app

Two ways, depending on how native you want to go:

- **Web app (PWA).** Open the served page and use the browser's install
  option — "Add to Home Screen" in iOS Safari, "Install app" in Chrome or
  Edge. The shell is precached by the service worker, so the installed app
  opens with no network at all.
- **Native app (iOS / Android).** The same files double as the web layer of a
  Capacitor app — no build step, no separate codebase; the native projects
  are generated locally and never committed. The full walkthrough (Xcode,
  signing, icons, the committed unzip plugin) is in
  [docs/mobile/NATIVE_BUILD.md](docs/mobile/NATIVE_BUILD.md).

## What it does

**Three light novel reading modes**, switchable mid-sentence without losing your
place:

| Mode | What it feels like |
| --- | --- |
| **Paged** | Page-by-page flip. Swipe, tap the edges, or use the arrow keys. |
| **Scroll** | One chapter at a time, scrolled vertically. |
| **Endless** | Continuous scroll that pulls in the next chapter as you reach it. |

Switching modes keeps you on the same sentence. So does changing the font size,
rotating the phone, or resizing the window — position is tracked as a place in
the text, not a pixel offset.

**Typography that is actually yours.** Nine themes — dark, dim, OLED black,
nord, forest, light, cream, sepia, tan — plus a **custom** one where you pick
the background and text colours and the rest of the palette is mixed to match.

Six typefaces, three of which ship with the app rather than hoping your device
has something suitable:

| Typeface | Why it is there |
| --- | --- |
| **OpenDyslexic** | Weighted letter bottoms make rotation and mirroring harder to confuse. The real font, not a Comic Sans fallback. |
| **Atkinson Hyperlegible** | Drawn by the Braille Institute to pull apart the characters most easily mistaken for each other — `I l 1`, `O 0`, `b d p q`. |
| **Literata** | A serif designed for long-form screen reading, and a real upgrade over the default system serif on Android. |
| Serif · Sans · Mono | System stacks. They download nothing. |

Bundled fonts are cached the first time you pick one, so the choice survives
going offline. They are not precached — nobody pays for a face they never chose.

Then text size, line height, line width, alignment, paragraph spacing,
first-line indent, and **letter and word spacing** (both evidence-based reading
aids, and useful to anyone at small sizes). Every setting is remembered **per
series**, because the way you want to read a dense translated novel is not the
way you want to read a breezy web serial.

**Manga and manhwa** keep the existing image reader: continuous vertical scroll,
chapter navigation, auto-scroll with speed control, and adjustable page gaps.

**Reading goals, streaks and a timer.** Optional daily minutes, chapters and
books-per-period goals with schedule-aware streaks, a floating session pill,
a wall-clock countdown timer, and a lifetime ledger of everything you have
read — all local, all off by default beyond the basics, and the app runs
identically if you never open them.

**Make it yours.** Pick a focus — books, comics, or both — and the defaults
follow; theme the whole app with the reader's nine palettes (or your own two
colours); reorder the home screen's sections; bundle your typography into
one-tap reader presets; keep a shelf of sources you like and browse them
from home; and when you finish a book, a quiet space asks what it left
behind. Every one of these is an optional module the app runs without.

**Offline first.** The app shell is precached, chapters you have opened are kept
in IndexedDB, and reading progress never needs a network. Open a CBZ or EPUB
from your device and it works with no server involved at all.

## Bringing in your own series

Three ways, in order of how much setup they need:

1. **Paste a link.** Add → paste a series URL → confirm what we found → it is in
   your library. Needs the gateway (below).
2. **Open a file.** EPUB, TXT, CBZ or ZIP, straight from your device. Needs
   nothing.
3. **Edit the bundled catalogue.** Add an entry to `scraper/series.json` and run
   the builder. See [docs/CATALOGUE.md](docs/CATALOGUE.md) — written for people
   who do not write code.

### The gateway

A browser cannot fetch a third-party reader site (CORS blocks it) or load
hotlink-protected images (the CDN checks the `Referer`). One small Cloudflare
Worker solves both by fetching on your behalf and normalizing what it finds.

```bash
cd worker
npx wrangler deploy
# then put the URL it prints into js/config.js as OR_CONFIG.workerBase
```

Free tier, about two minutes. See [worker/README.md](worker/README.md).

**We do not host content.** The gateway streams bytes through and lets
Cloudflare's edge cache do the rest — no storage bill, and no mirror of anyone
else's work. [docs/HOSTING.md](docs/HOSTING.md) explains why that was the right
call and when it would stop being.

Everything except adding series by link works with no gateway configured.

## Bundled content

The bundled catalogue is one book written for this repository plus six
public-domain classics — all text, all fully readable offline, and nothing
ships that is not ours (or everyone's) to ship:

| Series | What it is |
| --- | --- |
| **We Are Readers Here** | The owner's tour of the app, written as a book — because around here, the book is the interface. Nine short chapters; each one teaches a feature in place. |
| Frankenstein · Pride and Prejudice · Moby Dick · The Adventures of Sherlock Holmes · Alice's Adventures in Wonderland · War and Peace | Project Gutenberg classics, so there is something real to read tonight. |

The tutorial book is also the app's **offline floor**: the catalogue builder
refuses to ship a catalogue without it (`npm run validate` fails), and the
first-run focus sheet's "Start with the tour" button opens it.

**Public-domain only is a check, not a promise.** `npm run validate` fails any
catalogue carrying a series from a source outside `fixture | gutenberg |
standardebooks`, so the six-hourly rebuild workflow cannot commit anything else
— by accident or otherwise. Nothing in the codebase is written for a particular
website either: the gateway ships two general-purpose parsers, its compiled-in
image allowlist covers only the public-domain sources above, and it derives the
`Referer` it sends rather than consulting a table of sites. Series you add by
link live on your device and never touch this repository.

See [COPYRIGHT.md](COPYRIGHT.md) for the full picture, including how to reach
us if you think something here infringes your rights.

## Security

Third-party content is never rendered as HTML. Prose from any source — a scraped
page, an imported EPUB — is normalized into a flat list of typed blocks and
rendered with `textContent`. A hostile source site cannot put script into the
reader, and the boundary is one small auditable function rather than a sanitizer
you have to trust.

The gateway refuses private-network targets, rejects IP-literal hosts,
re-validates after every redirect, forwards no cookies or client headers, and
gates image proxying behind an allowlist that only grows when a series page,
chapter, or source listing successfully parses through the gateway.

## Documentation

| | |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The contract every module is built against — data model, module boundaries, APIs |
| [docs/CATALOGUE.md](docs/CATALOGUE.md) | Adding your own series to the bundled catalogue, for non-programmers |
| [docs/HOSTING.md](docs/HOSTING.md) | Why there is no image hosting, and what would change that |
| [docs/mobile/NATIVE_BUILD.md](docs/mobile/NATIVE_BUILD.md) | Building the iOS/Android apps from a clean checkout |
| [docs/mobile/TESTING.md](docs/mobile/TESTING.md) | On-device test matrix and the memory verification protocol |
| [worker/README.md](worker/README.md) | Gateway endpoints, deployment, cost, and limits |
| [COPYRIGHT.md](COPYRIGHT.md) | What ships here, what the app does with other people's work, and how to report a problem |

## Layout

```
index.html          app shell
js/config.js        deployment settings — the one file you edit to point at a gateway
js/platform.js      native bridge — the only module that talks to Capacitor
js/store.js         IndexedDB: imported series, cached chapters, progress, day logs, thoughts, preferences
js/covers.js        generated SVG covers for coverless series (optional module)
js/reader.js        image reader (CBZ, manga, manhwa)
js/novel-reader.js  text reader — the three reading modes, presets
js/importer.js      add by link, and EPUB/TXT/CBZ import
js/goals.js         reading goals, streaks, lifetime totals and the countdown timer (optional module)
js/thoughts.js      "depart your thoughts" — end-of-book reflections (optional module)
js/sources.js       saved sources shelf + browse (optional module)
js/settings.js      settings screen, app-wide themes, focus, home layout (optional module)
js/catalogue.js     browsing, routing, chapter resolution
native/or-zip/      committed Capacitor unzip plugin (the only native code in the repo)
fonts/              bundled reading faces (SIL OFL — see fonts/LICENSE.md)
worker/             Cloudflare Worker content gateway
scraper/            catalogue builder
```

## Licence

[AGPL-3.0-or-later](LICENSE). If you deploy a modified copy where other people
can reach it, §13 of that licence requires you to offer them its source — which
is why both home screens carry a source link. Bundled fonts keep the SIL Open
Font License 1.1 (`fonts/LICENSE.md`) and JSZip its MIT/GPLv3 dual licence.
