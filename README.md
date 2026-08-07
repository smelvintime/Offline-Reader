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

Open `http://localhost:8000`. Five sample series ship with the repo, so there is
something to read immediately.

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

**Typography that is actually yours.** Four themes (dark, light, sepia, OLED
black), four typefaces including a dyslexia-friendly stack, text size, line
height, line width, alignment, paragraph spacing, first-line indent. Every
setting is remembered **per series**, because the way you want to read a dense
translated novel is not the way you want to read a breezy web serial.

**Manga and manhwa** keep the existing image reader: continuous vertical scroll,
chapter navigation, auto-scroll with speed control, and adjustable page gaps.

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

## Sample content

The bundled catalogue is five original series written for this repository —
prose and artwork both — so the app always has something to open and nothing
ships that is not ours to ship:

| Series | Type | Size |
| --- | --- | --- |
| The Ninth Bell of the Meridian Gull | Light novel | 24 chapters |
| Elevator to Floor Zero | Web novel | 40 chapters |
| The Weight of Still Water | Light novel | 6 long chapters |
| Ashfall Courier | Manhwa | 8 chapters, 80 pages |
| The Lamplighter's Almanac | Light novel | 4 chapters |

The manhwa pages are SVG committed to the repo, so the image reader works with
no network and nothing hosted anywhere.

## Security

Third-party content is never rendered as HTML. Prose from any source — a scraped
page, an imported EPUB — is normalized into a flat list of typed blocks and
rendered with `textContent`. A hostile source site cannot put script into the
reader, and the boundary is one small auditable function rather than a sanitizer
you have to trust.

The gateway refuses private-network targets, rejects IP-literal hosts,
re-validates after every redirect, forwards no cookies or client headers, and
gates image proxying behind an allowlist that only grows when you successfully
import a series.

## Documentation

| | |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The contract every module is built against — data model, module boundaries, APIs |
| [docs/CATALOGUE.md](docs/CATALOGUE.md) | Adding your own series to the bundled catalogue, for non-programmers |
| [docs/HOSTING.md](docs/HOSTING.md) | Why there is no image hosting, and what would change that |
| [worker/README.md](worker/README.md) | Gateway endpoints, deployment, cost, and limits |

## Layout

```
index.html          app shell
js/config.js        deployment settings — the one file you edit to point at a gateway
js/store.js         IndexedDB: imported series, cached chapters, progress, preferences
js/reader.js        image reader (CBZ, manga, manhwa)
js/novel-reader.js  text reader — the three reading modes
js/importer.js      add by link, and EPUB/TXT/CBZ import
js/catalogue.js     browsing, routing, chapter resolution
worker/             Cloudflare Worker content gateway
scraper/            catalogue builder
```
