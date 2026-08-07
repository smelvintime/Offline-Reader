# Do we need to host images? — the short answer: no.

You asked whether we need to host images somewhere, and whether to spin up
servers for it. Here is the actual assessment, with what we built instead.

## The problem that *looks* like a hosting problem

Two things break when a static site tries to show manga pages from a third-party
reader site:

1. **CORS.** A browser on `yoursite.github.io` cannot `fetch()` a chapter page
   from `somereadersite.com` to find out what images it contains. The request is
   blocked before it starts.
2. **Hotlink protection.** Manga CDNs check the `Referer` header. An `<img>` tag
   on your domain sends *your* domain as the referer, so the CDN returns 403.

The obvious fix is "download everything to a server we control and serve it from
there." That is the expensive, slow, and legally worst option.

## What we did instead: a gateway, not a host

`worker/` is a single Cloudflare Worker that sits between the app and the
internet. It does three things:

- `/resolve?url=` — fetches a series page server-side (no CORS in a Worker),
  parses it, and returns normalized JSON.
- `/chapter?url=` — same for one chapter: image URLs, or prose reduced to typed
  text blocks.
- `/image?url=` — streams one image with the correct `Referer`, so the CDN
  serves it, and caches the response at the Cloudflare edge.

**Nothing is stored.** Bytes stream through and land in Cloudflare's edge cache
for a day. The next reader in the same region gets a cache hit. We are doing on
the user's behalf exactly what the user's browser would do if it visited the
source site directly.

### Why this is the right call

| | Gateway (what we built) | Re-hosting images |
| --- | --- | --- |
| Storage cost | $0 | Grows forever; a single long series is 5–20 GB |
| Bandwidth cost | $0 on the free tier (see below) | Egress billed per GB |
| Ops | One `wrangler deploy`, no server to patch | A server, a bucket, a CDN, backups, monitoring |
| Freshness | Always current | Needs a re-scrape pipeline |
| Legal exposure | Proxying on the reader's behalf | Redistributing someone else's work |

The last row is the one that actually decides it. Copying chapters onto storage
we control turns "a reader tool" into "a pirate mirror," and it is the single
thing most likely to get the project taken down. The gateway keeps us a client.

### Cost on the Cloudflare free tier

- Workers free plan: 100,000 requests/day.
- Edge cache reads do not count against Workers CPU time in any meaningful way.
- A 200-page binge ≈ 200 image requests. That is ~500 full chapter reads per day
  before you hit the free ceiling — comfortably past personal and small-group use.
- Workers KV free tier (100k reads/day, 1k writes/day) covers the learned image
  host allowlist, which writes only when someone imports a new series.

If you outgrow it, the paid Workers plan is $5/month for 10M requests. There is
still no storage bill, because there is still no storage.

## When you *would* need real hosting

Three cases, none of which apply yet:

1. **You want a shared, always-on library that survives the source site.**
   That is a mirror. Different product, different legal posture. Not this.
2. **You want covers to be fast and stable.** Cover images are small and hot.
   If cover loading ever feels slow, the cheap fix is an R2 bucket holding only
   the covers of the bundled sample catalogue (a few MB), not chapters. Say the
   word and this is a one-hour job.
3. **You want cross-device sync of a user's library.** Today everything lives in
   the browser's IndexedDB, and the library exports to a JSON file you can move
   yourself. Real sync needs an account system and a database — that is a
   product decision, not an infrastructure one, and it is the thing I would
   actually recommend building next if you want this to feel personal across
   phone and desktop.

## What the user has to do

1. `cd worker && npx wrangler deploy` (free Cloudflare account, ~2 minutes).
2. Paste the resulting URL into `js/config.js` as `OR_CONFIG.workerBase`.

Everything else — the bundled catalogue, reading local CBZ and EPUB files,
all three light novel reading modes, progress, personalization — works with no
gateway at all. The gateway is only needed to add series by link and to load
hotlink-protected images. See `worker/README.md` for the deploy walkthrough.
