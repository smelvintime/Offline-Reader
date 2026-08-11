# The bundled catalogue

This is the guide to `catalog.json` — the list of series the app shows on its
home screen — and to the small program that builds it. **You do not need to
know how to program to use any of this.** Everything you edit is a plain text
file, and there is a checker that tells you when you have made a mistake.

Contents:

1. [What's in the catalogue today](#1-whats-in-the-catalogue-today)
2. [Adding a series](#2-adding-a-series)
3. [Where ids and slugs come from](#3-where-ids-and-slugs-come-from)
4. [Running the builder on your own computer](#4-running-the-builder-on-your-own-computer)
5. [What the files look like](#5-what-the-files-look-like)
6. [Writing a series by hand, with no builder at all](#6-writing-a-series-by-hand-with-no-builder-at-all)
7. [Rules we do not break](#7-rules-we-do-not-break)

---

## 1. What's in the catalogue today

`catalog.json` at the root of the repository is **generated**. Do not edit it by
hand if you plan to run the builder again — your edits will be overwritten. Edit
`scraper/series.json` instead and rebuild.

The bundled catalogue is deliberately small: **one tutorial book plus six
public-domain classics**, all prose, all fully readable offline.

The tutorial — ***We Are Readers Here*** (`fixture:welcome`) — is a **fixture**:
original prose written for this repository and committed alongside it, never
fetched from anywhere. It is the owner's tour of the app, written as a book
(nine short chapters; each one teaches a feature in the place where it lives),
and it is the catalogue's **offline floor**: if every website is unreachable,
the app still has something real to open. The six classics come from Project
Gutenberg (Frankenstein, Pride and Prejudice, Moby Dick, The Adventures of
Sherlock Holmes, Alice's Adventures in Wonderland, War and Peace), and their
chapter files are committed too, so they read offline as well.

The floor is enforced, not hoped for. `npm run validate` **fails** a catalogue
that is empty, one that ships no bundled chapter files, or one whose enabled
`fixture:welcome` ships none — and `scraper/src/check-welcome.js` (the second
half of the validate script) holds the tutorial itself to its contract: exactly
nine chapters, each opening with an `h2`, 400–800 words per chapter, at least
one `blockquote` / `ul`-or-`ol` / `hr` / `note` across the book, and no `img`
blocks. You can rewrite the tutorial's prose freely; the shape is CI's.

The five earlier sample fixtures (the Lamplighter, Ninth Bell, Floor Zero,
Still Water and Ashfall series) and the MangaDex / Flame Comics entries were
retired in Phase 7 — a fresh install now leads with the book that teaches, not
with an auto-populated shelf. The `mangadex` and `flamecomics` sources are still
in the builder; re-adding an entry to `series.json` is all it takes to use them.

> **Note on the version committed here:** the machine that produced the current
> `catalog.json` had no network access to `gutenberg.org` — the egress policy
> answered `HTTP 403` to every request — so the six Gutenberg entries were
> **carried over** from the previously committed catalogue (the builder's normal
> failure policy, §4). Their chapter files were already committed, so nothing is
> missing from the app; a rebuild from a machine that can reach `gutenberg.org`
> simply refreshes them. Nothing was invented to paper over the gap.

---

## 2. Adding a series

Open **`scraper/series.json`** in any text editor. You will find a list called
`"series"`. Copy one of the blocks, paste it, change the values, save.

A minimal entry looks like this:

```json
{
  "source": "gutenberg",
  "id": "1342",
  "type": "lightnovel",
  "enabled": true
}
```

Four things are required:

| field     | what to put                                                                |
| --------- | -------------------------------------------------------------------------- |
| `source`  | where to fetch from: `gutenberg`, `mangadex`, `flamecomics`, or `fixture`   |
| `id`      | the number / code that identifies the work at that source (§3). Flame Comics uses `slug` instead |
| `type`    | `lightnovel`, `webnovel`, `manga`, or `manhwa`                              |
| `enabled` | `true` to include it, `false` to park it without deleting it                |

**`type` is always written by you, never guessed.** The app uses it to pick a
reader (pictures or prose) and to fill the tabs on the home screen, so a wrong
`type` is a visibly broken series. If a Korean webtoon should read as `manhwa`,
write `manhwa`.

Everything else is optional. Anything you write here wins over whatever the
website says:

| optional field     | effect                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| `title`            | override the title                                                     |
| `description`      | override the blurb                                                     |
| `author`, `artist` | override the credits                                                   |
| `genres`           | a list of strings, e.g. `["Romance", "Classic"]`                       |
| `maxChapters`      | keep only the first N chapters (see the size warning below)            |
| `readingDirection` | `ltr`, `rtl`, or `vertical` — picture series only                      |
| `language`         | two-letter language code, defaults to `en`                             |
| `_note`            | a comment for yourself; the builder ignores any field starting with `_` |

Defaults that apply to a whole source live at the top of the file under
`"defaults"`. For example `"gutenberg": { "maxChapters": 40 }` means "unless an
entry says otherwise, keep the first 40 chapters of a Gutenberg book".

### Three things that break the file

JSON is picky. If the builder says *"series.json is not valid JSON"*, it is
almost always one of these:

1. A **trailing comma** after the last item in a list or block. Not allowed.
2. A **missing comma** between two entries. Required.
3. **Single quotes** instead of `"double quotes"`. Only double quotes work.

Paste the file into any online JSON checker if you cannot spot it.

### A note about size

Everything the builder downloads is committed into this repository, so the whole
catalogue is available offline. Keep the total under roughly **8 MB**. A full
novel is somewhere between 300 KB and 1.5 MB, so about six books is the ceiling.
Use `maxChapters` on the long ones — the builder automatically adds a sentence
to the description saying how many chapters of how many are included, so readers
are not left wondering where the rest went.

---

## 3. Where ids and slugs come from

**Project Gutenberg** — the number in the book's web address.
`https://www.gutenberg.org/ebooks/1342` → `"id": "1342"`.

**MangaDex** — the long code in the title's web address.
`https://mangadex.org/title/32d76d19-8a05-4db0-9fc2-e0b0648fe9d0/jujutsu-kaisen`
→ `"id": "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0"`.

**Flame Comics** — the last part of the series address, using `slug`, not `id`.
`https://flamecomics.xyz/manga/volcanic-age` → `"slug": "volcanic-age"`.

**Fixture** — the name of a file in `scraper/fixtures/`, without the `.json`.
`scraper/fixtures/welcome.json` → `"id": "welcome"`.

---

## 4. Running the builder on your own computer

You need [Node.js](https://nodejs.org/) version 20 or newer. Open a terminal in
the repository folder and run:

```sh
cd scraper
npm install          # once, to fetch the two libraries it uses
npm run scrape       # build catalog.json + chapters/
```

Useful variations:

```sh
npm run dry-run                     # fetch and check everything, write nothing
node src/index.js --only=gutenberg  # rebuild just the books
node src/index.js --only=mangadex,flamecomics
node src/index.js --verbose         # show every request
npm run validate                    # check the committed files against the contract
```

The run ends with a summary that looks like this:

```
── Run summary ──────────────────────────────────────────────────
source     entries  ok  failed  skipped  carried  chapters  words
fixture          1   1       0        0        0         9  4,197
gutenberg        6   0       6        0        6         0      0

Failed (6): gutenberg:84, gutenberg:1342, …
Carried over from the previous catalog.json (6):
  · gutenberg:84 (fetch failed, kept 28 chapters from the previous catalogue)
  …
Catalogue: 7 series, 218 chapters
Sizes: catalog.json 65.6 KB, chapters/ 2.92 MB

── Validation ───────────────────────────────────────────────────
validate: OK — 7 series, 218 chapters, 218 chapter files checked, 0 warning(s)
```

Things worth knowing about how it behaves:

- **A failing website never empties your catalogue.** If a site is down, the
  builder keeps that series exactly as it was in the existing `catalog.json` and
  reports it under *"Carried over"*. Same for series you excluded with `--only`.
- **The check at the end is not optional.** Every run finishes by validating the
  files it just wrote against the contract in `docs/ARCHITECTURE.md` §1. If
  something is wrong the run exits with an error and tells you which file and
  which field. The same check enforces the offline floor: an empty catalogue, a
  catalogue with no bundled chapter files, or a catalogue missing the tutorial
  book (`fixture:welcome`) is an error, not a warning. `npm run validate`
  additionally runs `src/check-welcome.js`, which holds the tutorial's content
  to its shape (§1).
- **Removed series clean up after themselves.** Setting `"enabled": false` and
  rebuilding drops the series from `catalog.json` and deletes its chapter folder.
- The same thing runs automatically every six hours on GitHub
  (`.github/workflows/scrape.yml`) and commits the result.

---

## 5. What the files look like

Two kinds of file are produced. `catalog.json` is the index — it holds titles,
covers, descriptions and the chapter list, but **never the text of a chapter**.
Each chapter's content lives in its own file under `chapters/`, so that the app
downloads a chapter only when someone opens it.

### `catalog.json`, annotated

```jsonc
{
  "version": 2,                       // schema version — always 2
  "generatedAt": "2026-08-07T17:08:03.446Z",
  "series": [
    {
      "id": "gutenberg:1342",         // unique, and never changes between builds
      "type": "lightnovel",           // manga | manhwa | lightnovel | webnovel
      "title": "Pride and Prejudice",
      "altTitles": ["Erste Eindrücke"],
      "cover": "https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg",
                                      // a real URL, or a path inside this repo, or null.
                                      // Never a guess: the builder checks the URL loads.
      "description": "Sixty-one short chapters…",
      "author": "Jane Austen",
      "artist": null,
      "status": "completed",          // ongoing | completed | hiatus | cancelled | unknown
      "genres": ["Romance", "Classic"],
      "tags": ["public-domain", "project-gutenberg"],
      "language": "en",
      "source": "gutenberg",          // which adapter produced this
      "sourceUrl": "https://www.gutenberg.org/ebooks/1342",
      "readingDirection": null,       // ltr | rtl | vertical for pictures; null for prose
      "updatedAt": null,
      "chapterCount": 61,             // must equal the length of the list below
      "chapters": [
        {
          "id": "c-0001",             // unique inside this series, stable
          "num": 1,                   // reading order; decimals allowed (2.5)
          "volume": null,
          "title": "Chapter I",
          "updatedAt": null,
          "lang": "en",
          "wordCount": 1103,          // prose only, approximate
          "src": "chapters/gutenberg_1342/c-0001.json"
        }
      ]
    }
  ]
}
```

Each chapter carries **exactly one** way of getting its content:

| field         | means                                                              |
| ------------- | ------------------------------------------------------------------ |
| `src`         | fetch this file (what the builder uses for books and picture chapters) |
| `mdChapterId` | ask MangaDex for the images when the reader opens it                |
| `pages`       | the image URLs, written straight into the catalogue                 |
| `text`        | the prose, written straight into the catalogue (tiny chapters only) |

Two of them at once is an error; the checker will say so.

### A chapter file, `chapters/fixture_welcome/c-0001.json`

Prose is stored as a list of **blocks** — one per paragraph, heading, scene
break or quotation. There is no HTML anywhere: the reader puts blocks on screen
as plain text, which is what makes it impossible for a hostile website to smuggle
code into the app.

```jsonc
{
  "seriesId": "fixture:welcome",
  "id": "c-0001",
  "num": 1,
  "title": "The Book That Reads You Back",
  "kind": "text",                     // "text" or "image"
  "blocks": [
    { "t": "h2", "c": "The Book That Reads You Back" },
    { "t": "p",  "c": "Most apps introduce themselves with a slideshow…" },
    { "t": "hr" },
    { "t": "blockquote", "c": "A reader's attention is a loan, not a gift…" },
    { "t": "note", "c": "This is the owner's tour of the Offline Reader…" }
  ],
  "wordCount": 513
}
```

The complete list of block types:

| block                                    | renders as                       |
| ---------------------------------------- | -------------------------------- |
| `{ "t": "p", "c": "…" }`                 | a paragraph                      |
| `{ "t": "h2" \| "h3" \| "h4", "c": "…" }`| a heading                        |
| `{ "t": "hr" }`                          | a scene break                    |
| `{ "t": "blockquote", "c": "…" }`        | an indented quotation            |
| `{ "t": "pre", "c": "line\nline" }`      | verse — keeps its line breaks    |
| `{ "t": "ul", "items": ["a", "b"] }`     | a bulleted list                  |
| `{ "t": "ol", "items": ["a", "b"] }`     | a numbered list                  |
| `{ "t": "img", "src": "https://…", "alt": "…" }` | an illustration          |
| `{ "t": "note", "c": "…" }`              | a translator's / editor's note   |

A picture chapter is the same file with `"kind": "image"` and a `"pages"` list of
image URLs instead of `blocks`.

---

## 6. Writing a series by hand, with no builder at all

You have two ways to do this. The first is easier and survives rebuilds.

### Option A — a fixture (recommended)

1. Copy `scraper/fixtures/welcome.json` to
   `scraper/fixtures/my-story.json`. (Delete its `_readme` — the shape rules it
   describes are enforced only for the tutorial itself, not for your series.)
2. Edit the title, author, description and chapters. Each chapter is
   `{ "title": "…", "blocks": [ … ] }` using the block types in the table above.
   Chapter numbers and ids are filled in for you, in the order you write them.
3. Optionally drop a cover image next to it — any `.svg`, `.jpg` or `.png` — and
   point `"cover"` at its file name. It gets copied in beside the chapters.
4. Add four lines to `scraper/series.json`:

   ```json
   { "source": "fixture", "id": "my-story", "type": "lightnovel", "enabled": true }
   ```

5. Run `npm run scrape`. Your series is now in the catalogue with a chapter file
   per chapter, and it will still be there after every future rebuild.

#### A picture fixture (manga / manhwa)

A fixture chapter that carries `"pages"` instead of `"blocks"` becomes an image
chapter. The paths are relative to `scraper/fixtures/`, and the files are copied
in beside the chapters exactly like the cover:

```json
{
  "title": "Ashfall Courier",
  "type": "manhwa",
  "readingDirection": "vertical",
  "chapters": [
    { "title": "Two Hundred and Eleven Days",
      "pages": ["ashfall/c-0001-p01.svg", "ashfall/c-0001-p02.svg"] }
  ]
}
```

(The bundled sample image fixture, `Ashfall Courier`, was retired in Phase 7,
so there is no committed worked example any more — but the mechanism above is
unchanged and this snippet is the whole of it. Any image format works; SVG was
used there only because it stays small and readable in a git diff.)

### Option B — writing catalog.json yourself

If you never intend to run the builder, you can write the two kinds of file by
hand. Keep them consistent with each other:

1. Create `chapters/my-story/c-0001.json` with the chapter-file shape from §5.
   `seriesId` and `id` must match exactly what you write in the catalogue.
2. Add a series block to the `"series"` list in `catalog.json`, filling in every
   field shown in §5 — they are all required, `null` where you have nothing.
3. Point each chapter's `"src"` at the file you created.
4. Check your work:

   ```sh
   cd scraper && npm run validate
   ```

   It prints the exact file and field of anything that is off, for example:

   ```
   ERROR series[1] (my-story) chapters[0] (c-0001): src file is missing on disk
   ERROR series[1] (my-story): chapterCount 3 does not match chapters.length 1
   ```

Remember that `npm run scrape` regenerates `catalog.json` from
`scraper/series.json`, so a series added this way disappears on the next build.
Use Option A if you want it to last.

---

## 7. Rules we do not break

These are not style preferences — the whole project depends on them.

- **Public-domain text only.** The bundled catalogue ships text from Project
  Gutenberg and Standard Ebooks and nothing else. We do not put copyrighted
  chapters in this repository. Picture series are references to somebody else's
  URLs; we never copy the image files here. (`docs/ARCHITECTURE.md` §8.)
- **Never invent a URL.** If a cover cannot be confirmed to load, the builder
  writes `cover: null` and the app shows a placeholder. A made-up URL is worse
  than no URL.
- **No HTML in blocks.** Prose is plain strings in typed blocks. That is the
  boundary that stops a hostile source site from injecting anything into the
  reader (`docs/ARCHITECTURE.md` §1.3, §7).
- **Chapter text never goes into `catalog.json`.** It lives in `chapters/`, one
  file per chapter, so the app loads a chapter only when it is opened.
- **Ids are stable.** `series.id` and `chapter.id` must mean the same thing after
  a rebuild — readers' bookmarks and reading progress are keyed on them.
