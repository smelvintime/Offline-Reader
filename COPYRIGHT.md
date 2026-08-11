# Copyright, content, and takedown requests

This document explains what this repository contains, what the app does with
other people's work, and how to reach us if you believe something here
infringes your rights. If you are a rightsholder, skip to
[Reporting a problem](#reporting-a-problem).

## What ships in this repository

**Text: public domain only.** The bundled catalogue is one original work
written for this project — the tutorial book *We Are Readers Here* — plus six
Project Gutenberg transcriptions of novels published between 1813 and 1892.
Every author has been dead for over a century; the works are public domain in
the United States and in every life+70 jurisdiction.

This is enforced, not merely promised. `scraper/src/validate.js` fails the
build (exit 1) if any series in `catalog.json` comes from a source outside
`fixture | gutenberg | standardebooks`, and validation runs on every scrape and
in CI. A copyrighted series cannot be committed here by accident.

**Images: none.** No chapter images, page scans, or artwork are stored in this
repository at any time.

**Code and assets.** The application code is ours, under AGPL-3.0-or-later (see
`LICENSE`). Third-party components keep their own licences: JSZip (MIT/GPLv3
dual, `jszip.min.js`), the three bundled typefaces (SIL Open Font License 1.1,
see `fonts/LICENSE.md`), and the Capacitor packages listed in `package.json`.

## What the application does

The reader runs on the reader's own device. Everything it holds — imported
series, reading positions, settings, notes — lives in that device's IndexedDB.
Nothing is uploaded, nothing is shared between users, and there are no
accounts and no server-side database.

When a reader pastes a link to a page they want to read, the app fetches that
page **at that moment, for that reader**. The optional Cloudflare Worker in
`worker/` exists because a browser cannot fetch cross-origin pages directly;
it acts as the reader's user-agent, streams the response back, and stores
nothing beyond Cloudflare's ordinary edge cache. It does not crawl, does not
index, does not build a library, and does not serve content to anyone who did
not ask for that exact URL.

The gateway is **off by default** (`OR_CONFIG.workerBase` is an empty string).
A deployment only proxies anything if its operator explicitly deploys a worker
and configures it.

Nothing in this project is written for any particular website. The worker's
adapters are general-purpose parsers — `generic-manga` and `generic-novel` —
and the compiled-in image allowlist covers only the public-domain sources the
bundled catalogue uses. Any other host reaches the allowlist by being resolved
from a link a reader supplied, or by an operator setting `EXTRA_ALLOWED_HOSTS`.

## What this project will not do

- **No DRM circumvention, ever.** The app does not strip, bypass, decode, or
  link to tools that circumvent access controls or rights management. An
  `.acsm` file gets an honest refusal, never a parse attempt. This is a
  standing rule of the codebase, recorded in `docs/ARCHITECTURE.md` §8.
- **No mirroring.** Chapter bytes are never copied onto storage this project
  controls. This is an architectural decision, documented in
  `docs/HOSTING.md`, not a policy that could be relaxed by configuration.
- **No site-specific support for infringing sources.** Adapters and allowlists
  stay general-purpose.

## If you operate a site

If you would rather this software not fetch from your site, say so and we will
respect it. Operators are also directed, in `worker/README.md`, to honour the
`robots.txt`, terms and rate limits of anything they point a gateway at, and
to stop if asked.

## Reporting a problem

If you believe material in this repository or in a deployment of it infringes
your copyright, please tell us and we will act on it promptly. You do not need
a lawyer or a formal notice to get our attention — a clear description is
enough.

Helpful to include:

- What the work is, and enough detail to identify it.
- Where exactly it appears: a file path in this repository, or a URL.
- How to reach you.
- Your relationship to the work (rightsholder, agent, or otherwise).

**How to reach us**

- Open an issue at
  <https://github.com/smelvintime/Offline-Reader/issues>. Please do not include
  anything you would rather not have public.
- For anything sensitive, contact the repository owner through their GitHub
  profile: <https://github.com/smelvintime>.

<!-- Repository owner: if you want a direct address on record, add it here.
     A monitored email is the fastest route for a rightsholder and avoids
     escalation straight to the host. -->

**Formal notices.** You may of course also go to the hosts directly, and they
have their own established processes:

- This repository is hosted by GitHub — <https://github.com/contact/dmca>.
- The web deployment is hosted by Vercel — <https://vercel.com/legal/dmca-policy>.
- A gateway, if one is deployed, runs on Cloudflare Workers —
  <https://www.cloudflare.com/trust-hub/reporting-abuse/>.

We would rather hear from you first and fix it ourselves.

## Note on Project Gutenberg

The six classics are built from Project Gutenberg transcriptions with the
Project Gutenberg licence boilerplate stripped, which leaves the underlying
public-domain text. The name "Project Gutenberg" is a trademark of the Project
Gutenberg Literary Archive Foundation; this project is not affiliated with or
endorsed by them. Where the name appears here it is a factual statement of
where a text came from.
