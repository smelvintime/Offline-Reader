# Offline Reader — content gateway

A single Cloudflare Worker. It is the **only** server-side component of the
Offline Reader PWA, and it exists because a static page in a browser cannot do
two things:

1. **Fetch a third-party reader site.** Cross-origin `fetch()` is blocked by CORS,
   and reader sites do not send `Access-Control-Allow-Origin`.
2. **Load hotlink-protected images.** Manga CDNs check `Referer`/`Origin` and
   return 403 for requests that did not come from their own site.

So the worker fetches on the user's behalf, normalizes HTML into the typed JSON
the app understands, and re-serves it with permissive CORS.

**It stores nothing.** Bytes stream through it. The only persistence is an
optional KV list of image hostnames (see [Allowlist](#the-image-allowlist)) and
Cloudflare's edge cache. No chapters, no images, no user data, no logs of what
anyone read.

Contract: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §1 (content model),
§6 (this API), §7 (security rules).

---

## Quick start

```bash
cd worker
npm install
npm test                 # 197 tests, no network required
npx wrangler deploy      # needs a Cloudflare account
```

Then put the deployed URL in [`js/config.js`](../js/config.js):

```js
window.OR_CONFIG = {
  workerBase: 'https://offline-reader-gateway.YOUR-SUBDOMAIN.workers.dev',
  // …
};
```

`workerBase` takes **no trailing slash**. Leaving it as `''` disables every
gateway feature gracefully — the app still browses the bundled catalogue and
opens local EPUB/CBZ files, but "add by link" and hotlink-protected images will
not work.

Verify with:

```bash
curl https://offline-reader-gateway.YOUR-SUBDOMAIN.workers.dev/health
```

---

## Endpoints

All responses are JSON with `Access-Control-Allow-Origin: *`, except `/image`,
which streams raw bytes (also with CORS). Only `GET`, `HEAD` and `OPTIONS` are
accepted.

### `GET /health`

```bash
curl https://gw.example.workers.dev/health
```

```jsonc
{
  "ok": true,
  "version": "2.0.0",
  "adapters": ["mangadex", "generic-manga", "generic-novel"],
  "adapterDetail": [
    { "id": "mangadex",      "label": "MangaDex",                         "priority": 10 },
    { "id": "generic-manga", "label": "Generic manga / manhwa site",      "priority": 90 },
    { "id": "generic-novel", "label": "Generic novel / web-fiction site", "priority": 100 }
  ],
  "kv": false,                                     // is a KV namespace bound?
  "allowlist": { "mode": "static-only", "staticEntries": 13 },
  "dnsGuard": "lenient",
  "allowPrivateTargets": false,                    // must be false in production
  "limits": { "imageBytes": 20971520, "htmlBytes": 5242880, "timeoutMs": 15000, "maxRedirects": 3 }
}
```

Use this to confirm a deploy, and to check whether KV actually got bound —
`"kv": false` means `/image` is running on the compiled-in static allowlist only.

### `GET /image?url=<encoded>`

Streams the image with a plausible `Referer`/`Origin` for the target host.
Also served at **`GET /?url=…`** for backward compatibility with catalogues
already deployed against the old worker.

```bash
curl -i "https://gw.example.workers.dev/image?url=https%3A%2F%2Fuploads.mangadex.org%2Fcovers%2Fx.jpg"
```

```
HTTP/1.1 200 OK
Content-Type: image/jpeg
Access-Control-Allow-Origin: *
Cache-Control: public, max-age=86400, s-maxage=604800
X-Or-Cache: miss
<binary>
```

- The host must be **allowlisted** (see below).
- The response is rejected unless its `Content-Type` is `image/*`.
- Body capped at 20 MB, enforced *while streaming* — nothing is buffered.
- Cached in the Cloudflare edge cache; `/image?url=X` and `/?url=X` share one
  cache entry.

### `GET /resolve?url=<encoded series page>`

Parses a series page into a normalized `Series` (§1.1).

```bash
curl "https://gw.example.workers.dev/resolve?url=https%3A%2F%2Fexample.org%2Fsalt-road%2F"
```

```jsonc
{
  "ok": true,
  "adapter": "generic-novel",
  "confidence": "high",
  "series": {
    "id": "user:e375afcd25",
    "type": "webnovel",
    "title": "The Salt Road",
    "author": "P. Navarre",
    "status": "ongoing",
    "genres": ["Fantasy", "Adventure"],
    "cover": "https://img.example.org/covers/salt-road.jpg",
    "language": "en",
    "source": "generic-novel",
    "sourceUrl": "https://example.org/salt-road/",
    "chapterCount": 15,
    "confidence": "high",
    "chapters": [
      {
        "id": "c-0001",
        "num": 1,
        "volume": null,
        "title": "Four Days",
        "lang": "en",
        "src": "https://gw.example.workers.dev/chapter?url=https%3A%2F%2Fexample.org%2Fsalt-road%2Fchapter-1&kind=text",
        "sourceUrl": "https://example.org/salt-road/chapter-1"
      }
      // …
    ]
  }
}
```

Every chapter carries `src` pointing back at this worker's `/chapter`. Image
hosts discovered while resolving are written into the KV allowlist so `/image`
will serve them later.

Also sends `X-Or-Adapter` and `X-Or-Confidence` response headers.

### `GET /chapter?url=<encoded>&kind=text|image`

Parses one chapter into a `ChapterFile` (§1.2).

`kind` is a **hint, not an instruction**. A page with thirty sequential images
and two sentences of text is an image chapter no matter what you asked for, and
vice versa. The adapter decides from the content and reports what it chose.

Text chapters reduce to the `Block[]` primitive of §1.3 — typed blocks only.
There is **no HTML passthrough, ever**:

```jsonc
{
  "ok": true,
  "adapter": "generic-novel",
  "confidence": "high",
  "chapter": {
    "id": "c-0012",
    "num": 12,
    "title": "The Salt Road",
    "kind": "text",
    "wordCount": 323,
    "sourceUrl": "https://example.org/salt-road/chapter-12",
    "confidence": "high",
    "blocks": [
      { "t": "p", "c": "The flats began where the last of the olive trees gave up…" },
      { "t": "blockquote", "c": "Nothing crosses the flats twice.\nNot water. Not birds. Not debts." },
      { "t": "img", "src": "https://example.org/uploads/salt-flats.jpg", "alt": "A figure crossing white flats" },
      { "t": "note", "c": "Illustration by M. Oduya" },
      { "t": "hr" },
      { "t": "h2", "c": "II" }
    ]
  }
}
```

Image chapters:

```jsonc
{
  "ok": true,
  "adapter": "generic-manga",
  "confidence": "high",
  "chapter": {
    "id": "c-0042",
    "num": 42,
    "kind": "image",
    "pages": [
      "https://cdn.example.org/uploads/tin-quarter/42/001.webp",
      "https://cdn.example.org/uploads/tin-quarter/42/002.webp"
    ]
  }
}
```

Page URLs are the **upstream** URLs. The client wraps them in `/image?url=…`
itself (`js/reader.js` already does this via `window.gatewayUrl`).

### Errors

Every failure is the same envelope with a real non-2xx status and CORS headers:

```jsonc
{ "ok": false, "error": "blocked_host", "message": "IP-literal hosts are not allowed" }
```

| code                | status | meaning                                                   |
| ------------------- | ------ | --------------------------------------------------------- |
| `bad_url`           | 400    | missing/malformed `?url=`, bad scheme, embedded credentials |
| `bad_method`        | 405    | anything other than GET/HEAD/OPTIONS                       |
| `blocked_host`      | 403    | SSRF rule hit, **or** host not in the `/image` allowlist    |
| `not_found`         | 404    | unknown endpoint                                           |
| `no_adapter`        | 422    | no adapter claimed the URL                                 |
| `parse_failed`      | 422    | adapter ran but could not make sense of the page           |
| `bad_content_type`  | 415    | `/image` got a response that was not `image/*`             |
| `too_large`         | 413    | body exceeded the size cap                                 |
| `rate_limited`      | 429    | per-client budget exhausted (sends `Retry-After`)          |
| `timeout`           | 504    | upstream did not answer within 15 s                        |
| `upstream_error`    | 502*   | upstream failed (*or the upstream's own 4xx status)        |
| `internal_error`    | 500    | a bug — never leaks a stack trace                          |

---

## Security

Implemented in [`src/lib/security.js`](src/lib/security.js) and exercised by
`test/security.test.js` (61 assertions).

### SSRF

The worker runs inside Cloudflare's network and can reach things your browser
cannot. Every user-supplied URL is validated **before** the first fetch and
**again after every redirect**:

- `http:` and `https:` only. Everything else (`file:`, `ftp:`, `javascript:`,
  `data:`, `gopher:`, `blob:`) is rejected.
- URLs with embedded credentials (`https://user:pass@host/`) are rejected.
- **IP-literal hosts are rejected outright** — including decimal (`2130706433`)
  and hex (`0x7f000001`) forms, and bracketed IPv6.
- Blocked names: `localhost`, `metadata.google.internal`, `instance-data`,
  `kubernetes*`, and any single-label host.
- Blocked suffixes: `.local`, `.localhost`, `.internal`, `.intranet`, `.private`,
  `.corp`, `.home`, `.lan`, `.test`, `.example`, `.invalid`, `.onion`,
  `.cluster.local`, and friends.
- Blocked address ranges (also applied to DNS answers): `0.0.0.0/8`, `10/8`,
  `100.64/10` (CGNAT), `127/8`, `169.254/16` (link-local, incl. cloud metadata),
  `172.16/12`, `192.168/16`, `192.0.0/24`, TEST-NETs, `198.18/15`, multicast,
  reserved; and `::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`,
  IPv4-mapped `::ffff:a.b.c.d`, 6to4 `2002::/16`, NAT64 `64:ff9b::/96`.
- Blocked ports: SSH, SMTP, Redis, Postgres, MySQL, Elasticsearch, Docker,
  Kubelet, memcached and ~40 other classic pivot ports.
- **Redirects are followed manually** (`redirect: 'manual'`), capped at **3**,
  and the full validation runs again on every hop. A page that 302s to
  `169.254.169.254` is rejected at the redirect, not followed.
- Every outbound request carries `AbortSignal.timeout(15_000)`.

**DNS guard.** Workers have no DNS API, so hostnames are additionally resolved
over Cloudflare DoH and rejected if they answer with a private address. Set with
the `DNS_GUARD` var:

| value              | behaviour when the lookup fails |
| ------------------ | ------------------------------- |
| `lenient` (default)| allow (fail open)               |
| `strict`           | reject (fail closed)            |
| `off`              | skip the lookup entirely        |

This is **best-effort and cannot close the DNS-rebinding race**: we resolve the
name, then `fetch()` resolves it again independently, and a hostile authoritative
server can answer differently the second time. The IP-literal ban and the
allowlist are the controls that actually hold; treat the DNS guard as
defence-in-depth, not a boundary.

### No credential forwarding

Nothing from the client request is ever copied upstream. `upstreamHeaders()`
builds the **complete** outbound header set from scratch — `User-Agent`,
`Accept`, `Accept-Language`, `Accept-Encoding`, and a synthesised
`Referer`/`Origin`. There is no code path that reads a client header and sends
it on, so `Cookie`, `Authorization`, `X-Forwarded-For` and everything else stay
on our side of the wire. (Tested.)

### Size and time caps

| resource | cap    | enforcement                                       |
| -------- | ------ | ------------------------------------------------- |
| images   | 20 MB  | streaming `TransformStream`; nothing is buffered   |
| HTML     | 5 MB   | checked against `Content-Length`, then while reading |
| JSON     | 8 MB   | same                                              |
| any fetch| 15 s   | `AbortSignal.timeout`                             |

A lying `Content-Length` does not help — the streaming counter aborts anyway.

### The image allowlist

`/image` is allowlist-gated so it cannot be used as an open image proxy for the
whole internet. Two tiers:

1. **Static** — compiled into [`src/lib/allowlist.js`](src/lib/allowlist.js):
   MangaDex (`uploads.mangadex.org`, `*.mangadex.network`), Flame Comics,
   Project Gutenberg, Standard Ebooks, and a couple of common cover hosts.
   Extend without editing code via the `EXTRA_ALLOWED_HOSTS` var
   (comma/whitespace separated, supports `*.host`).
2. **Learned** — hostnames observed during a *successful* `/resolve` or
   `/chapter`, written to KV with a **30-day TTL**, max 12 per request.

**KV is optional.** With no namespace bound the worker still runs: tier 2 is
skipped, `/image` serves the static list only, and `/health` reports
`"kv": false`. A KV outage degrades the same way — it never fails open.

Wildcard-style lookalikes do not slip through: `mangadex.org.evil.example.org`
is not allowlisted by the `mangadex.org` entry.

### Rate limiting — and why it is weak

`src/lib/ratelimit.js` is an **in-memory fixed-window counter scoped to one
Workers isolate**. Defaults per client IP per 60 s: 300 for `/image`, 30 for
`/resolve` and `/chapter`, 120 for `/health`.

Be honest about what that is worth:

- Cloudflare runs **many isolates across many colos**. A distributed client sees
  roughly `limit × isolates`, not `limit`. There is no shared counter.
- Isolates are recycled freely, which resets counters at arbitrary times.
- The client key is `CF-Connecting-IP`. That header is trustworthy at the
  Cloudflare edge, but everyone behind one CGNAT or campus NAT shares a bucket,
  and IPv6 clients can rotate addresses at will.

It exists to stop one runaway browser tab and to blunt casual abuse. **It is not
a security boundary.** If you need a real limit, use Cloudflare's Rate Limiting
rules (dashboard, in front of the worker) or a Durable Object. KV is unsuitable:
the free tier allows only 1,000 writes/day.

---

## Adapters

```
src/adapters/<id>.js  →  { id, label, priority, matches(url, ctx),
                           resolveSeries(url, ctx), resolveChapter(url, ctx) }
```

Registered in [`src/adapters/index.js`](src/adapters/index.js). Every adapter
whose `matches()` returns true is a candidate; **the lowest `priority` wins.**

| priority | id              | matches                                                   |
| -------- | --------------- | --------------------------------------------------------- |
| 10       | `mangadex`      | `mangadex.org/title/<uuid>` or `/chapter/<uuid>`           |
| 90       | `generic-manga` | comic-shaped host/path, or an explicit `kind=image`        |
| 100      | `generic-novel` | everything (the last resort)                               |

`ctx` provides `fetchHtml(url)`, `fetchJson(url)`, `absolutize(href, base)`,
`chapterSrc(url, kind)`, `imageSrc(url)` and `env`.

### `mangadex`

JSON API only (`api.mangadex.org`) — **no HTML scraping**. mangadex.org is a
client-rendered SPA with no chapter list in the served markup, and MangaDex
publishes an API for exactly this use. Series come from `/manga/<uuid>` plus a
paginated `/manga/<uuid>/feed`; pages come from `/at-home/server/<uuid>`.
Reading direction is inferred from `originalLanguage` (ja/zh → `rtl`, ko →
`vertical`). Capped at 1,200 chapters per series.

### The HTML-parsing approach, and why

`src/lib/html.js` is a ~450-line tolerant tokenizer and tree builder written for
this project. Two alternatives were rejected:

- **`HTMLRewriter`** (the built-in Workers API) is streaming-only. You cannot ask
  "which container has the densest prose?" without a tree, and it only exists
  inside workerd — adapters written against it cannot be unit-tested in plain
  Node, which the test suite requires.
- **`linkedom` / `cheerio`** drag a full spec DOM and a CSS selector engine into
  a repo that is otherwise zero-dependency with no build step. We need tags,
  attributes and text density, nothing more.

It is deliberately *not* spec-compliant. It handles what real reader sites
actually emit — unclosed `<p>`/`<li>`, raw `<script>`, lazy-loaded `<img>`,
comments, entities — and is happy to be approximately right, because every
consumer treats the result as a heuristic input and never as trusted markup.

Shared heuristics live in `src/lib/extract.js`:

- **Prose container** — readability-style scoring. Paragraphs score on length
  (in 100-char steps) and comma count; the score is credited to the parent chain
  with decay, then scaled by `(1 − linkDensity)` and nudged by class/id and tag
  semantics. Runs after an aggressive junk prune (nav, ads, sidebars, comments).
- **TOC cluster** — the largest group of *same-shaped* links whose text looks
  chapter-ish. Grouping is attempted at three ancestor depths because layouts
  differ (`ul>li>a` vs `div>div>span>a`), and scoring rewards count, chapter-ish
  text, href prefix similarity and parseable numbering while penalising
  nav-word links and pagination rows. Runs after only a *light* prune — a full
  prune would delete the chapter list, which often sits in a `class="toc"` or
  `nav` element. Plus capped `rel="next"` pagination (4 extra pages).
- **Image run** — the largest run of sequential images in one container, with
  icons/avatars/ads filtered by dimension attributes (`width`/`height` under
  200px) and URL shape (`logo`, `avatar`, `banner`, `sprite`, `thumb`, …), and
  lazy-loading attributes (`data-src`, `srcset`, …) resolved past base64
  placeholders.

Metadata always comes from **Open Graph / JSON-LD / `<meta>` first**
(`src/lib/meta.js`), with label/value sniffing ("Author: X", "Status: Y") and
DOM heuristics only as fallback.

**Degrading honestly.** Both generic adapters return what they found even when
they are not confident, marked `confidence: "high" | "medium" | "low"` on the
payload and in the `X-Or-Confidence` header. A container that scored well but
yielded 200 characters is reported as `low`, not as a success and not as a
failure. Show low-confidence results to the user and let them judge.

### Blocks are the XSS boundary

`src/lib/blocks.js` reduces prose to the §1.3 vocabulary —
`p h2 h3 h4 hr blockquote pre ul ol img note` — and nothing else. Unknown types
become `p` (never dropped silently, never trusted). `img` blocks require an
absolute `http(s)` src. Control and zero-width characters are stripped. The
reader sets `textContent`, never `innerHTML`, so a hostile source site cannot
inject script into the app. There is no `html` field in the schema and no code
path that emits one.

---

## Configuration

All optional. Set in `wrangler.toml` under `[vars]`, or with
`npx wrangler dev --var NAME:value`.

| var                     | default   | purpose                                              |
| ----------------------- | --------- | ---------------------------------------------------- |
| `EXTRA_ALLOWED_HOSTS`   | `""`      | extra `/image` hosts, comma/space separated, `*.` ok  |
| `DNS_GUARD`             | `lenient` | `lenient` \| `strict` \| `off`                        |
| `PUBLIC_BASE`           | inferred  | override the origin used to build `src` URLs          |
| `RATE_LIMIT_IMAGE`      | `300`     | requests/60 s/IP/isolate                              |
| `RATE_LIMIT_PARSE`      | `30`      | requests/60 s/IP/isolate                              |
| `DISABLE_RATE_LIMIT`    | unset     | `"true"` turns it off (load testing)                  |
| `ALLOW_PRIVATE_TARGETS` | unset     | **DEV ONLY** — disables SSRF checks *and* the allowlist |

> `ALLOW_PRIVATE_TARGETS=true` exists so you can point the worker at a localhost
> fixture server. It disables the private-network blocks **and** the `/image`
> allowlist gate. Never set it on a public deployment. `/health` reports it as
> `"allowPrivateTargets": true` so you can spot it.

### Creating the KV namespace

Optional but recommended — without it, "add by link" will resolve series fine
but their images will not load unless the host happens to be on the static list.

```bash
cd worker
npx wrangler kv namespace create OR_ALLOWLIST
npx wrangler kv namespace create OR_ALLOWLIST --preview
```

Each command prints an id. Uncomment the block in `wrangler.toml` and paste them
in:

```toml
[[kv_namespaces]]
binding = "OR_ALLOWLIST"
id = "<the id from the first command>"
preview_id = "<the id from the second command>"
```

Redeploy, then confirm with `curl .../health` that `"kv": true`.

### Deploying

```bash
cd worker
npx wrangler login       # once
npx wrangler deploy
```

Change `name` in `wrangler.toml` to pick your subdomain
(`https://<name>.<your-subdomain>.workers.dev`).

`compatibility_date` is set to a current date. **Wrangler v3 does not know it**
and will warn `The latest compatibility date supported by the installed
Cloudflare Workers Runtime is "2025-07-18"` before falling back. Either use
wrangler v4 (`npm i -D wrangler@^4`) or lower the date to one your wrangler
recognises — the worker uses no date-gated features either way.

---

## Cost

As of writing — **verify against Cloudflare's current pricing page**, these
change.

**Workers Free**
- 100,000 requests/day, resetting at UTC midnight.
- **10 ms CPU time per invocation.**
- Responses served from the edge cache still count as requests.

**Workers Paid** — $5/month, includes 10 million requests, then $0.30/million.
CPU limit rises to 30 s.

**KV Free** — 100,000 reads/day, **1,000 writes/day**, 1 GB storage.

What this means in practice:

- `/image` is cheap. It streams, does almost no CPU work, and the edge cache
  absorbs repeats. A reading session of 200 pages is ~200 requests, most of
  which will be cache hits after the first reader.
- **`/resolve` and `/chapter` parse HTML and are the CPU risk.** A large series
  page can approach or exceed the free plan's 10 ms CPU budget, which surfaces
  as a 1102 "Worker exceeded resource limits" error. The 5 MB HTML cap, the
  single-pass measurement in `extract.js`, the 4-page pagination cap and the
  2,000-chapter cap all exist to bound this, but a genuinely huge page on the
  free plan may still fail. If you hit it, the $5 plan removes the problem.
- The **1,000 KV writes/day** free limit is the real ceiling on the learned
  allowlist. Learning is capped at 12 hosts per resolve and entries live 30 days,
  so a normal personal deployment will not come close — but a busy public one
  will, and writes simply start failing (degrading to static-only, not erroring).

A personal deployment for one household reads comfortably inside every free tier.

---

## Testing

```bash
cd worker
npm test          # node --test test/
```

197 tests, **no live network** — every upstream response is a saved HTML fixture
in `test/fixtures/` or an inline string, and `globalThis.fetch` is stubbed.

| file                  | covers                                                        |
| --------------------- | ------------------------------------------------------------- |
| `security.test.js`    | URL validation, SSRF rejection, redirect re-validation, header non-forwarding, size caps |
| `blocks.test.js`      | block vocabulary, unknown-type degradation, paragraph integrity, XSS boundary |
| `extract.test.js`     | prose container, TOC cluster, image run, metadata preference   |
| `adapters.test.js`    | registry shape, selection by priority, all three adapters against fixtures |
| `allowlist.test.js`   | static tier, learned tier, TTL, KV-optional and KV-outage paths |
| `endpoints.test.js`   | every route end-to-end through the default export              |

To exercise it against a real HTTP server:

```bash
# terminal 1 — serve the fixtures
cd worker/test/fixtures && python3 -m http.server 8099

# terminal 2 — run the worker, permitted to reach localhost
cd worker && npx wrangler dev --local --var ALLOW_PRIVATE_TARGETS:true --var DNS_GUARD:off

# terminal 3
curl "http://127.0.0.1:8787/health"
curl "http://127.0.0.1:8787/chapter?kind=text&url=http%3A%2F%2F127.0.0.1%3A8099%2Fnovel-chapter.html"
```

(`python3 -m http.server` ignores query strings, so the `?page=2` pagination
fixture needs a slightly smarter server to exercise end-to-end.)

---

## What this does and does not do

**It does:**

- Fetch a page you asked for, on your behalf, and hand you the result.
- Add the `Referer`/`Origin` a CDN expects so hotlink-protected images load.
- Turn third-party HTML into typed JSON so the app never renders foreign markup.
- Cache image bytes at Cloudflare's edge, exactly as your browser would.
- Refuse private-network targets, non-`http(s)` schemes and non-image responses.

**It does not:**

- **Store any content.** No database, no R2, no bucket. Bytes stream through and
  are held only in Cloudflare's ordinary HTTP cache. The single piece of
  persisted state is a list of *hostnames* in KV.
- **Log what anyone reads.** No analytics, no request logging beyond whatever
  Cloudflare does at the platform level.
- **Bypass paywalls or DRM.** It sends a browser-shaped `User-Agent` and a
  plausible `Referer`; it does not log in, solve challenges, or defeat access
  control. Pages behind a login return whatever an anonymous visitor gets.
- **Work on every site.** Client-rendered SPAs return an empty shell to any
  server-side fetcher — there is no chapter list in the HTML to find. Sites
  behind Cloudflare's own bot protection, or serving a JS challenge, will fail.
  Aggressive per-site anti-scraping will fail.
- **Parse correctly every time.** The generic adapters are heuristics. They pick
  the wrong container sometimes, miss chapters when a TOC is unusual, and include
  a stray "Next chapter" link now and then. This is why every response carries a
  `confidence` field — use it.
- **Rate-limit meaningfully.** See the honest assessment above.
- **Guarantee ordering for image chapters.** Page order follows document order
  and filename numbering. A site that shuffles pages in JavaScript will come out
  wrong.

### Legal posture

This worker is a **user-agent proxy, not a host**. It fetches a URL that a
specific user supplied, at the moment that user asked, and streams the response
back to that user's browser. It does not crawl, does not build a library of
other people's work, and does not serve content to anyone who did not ask for
that exact URL. The bytes live in an HTTP cache for a day, which is what your
browser does too.

The bundled sample catalogue ships **public-domain text only** (Project
Gutenberg / Standard Ebooks). Anything a user brings in via a link stays on that
user's device in IndexedDB — it is never uploaded, never added to the repo, and
never shared between users.

That said: **you are responsible for what you point this at.** Proxying
copyrighted material still puts you in the request path, and "the user asked for
it" is a posture, not a legal opinion. The `/image` allowlist deliberately keeps
this from becoming a general-purpose open proxy. Do not deploy it as a public
service for other people's use, do not remove the allowlist, and respect the
`robots.txt`, terms and rate limits of any site you add. If a site asks you to
stop, stop.
