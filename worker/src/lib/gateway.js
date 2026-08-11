// gateway.js — constants and helpers that belong to the worker entrypoint but
// cannot live in it.
//
// WHY THIS FILE EXISTS: workerd validates every named export of the entry
// module and accepts only functions or ExportedHandlers. A plain
// `export const VERSION = '2.0.0'` in src/index.js makes the runtime refuse to
// start with:
//
//   Uncaught TypeError: Incorrect type for map entry 'VERSION':
//   the provided value is not of type 'function or ExportedHandler'.
//
// So src/index.js exports its default handler and nothing else; anything else
// the tests or other modules need lives here.

import { normalizeHost } from './security.js';

export const VERSION = '2.1.0';

// ── /list caps (§6.6) ────────────────────────────────────────────────────────

/** Response caps for /list: items sliced, titles clamped, in the handler. */
export const LIST_LIMITS = { maxItems: 60, maxTitleChars: 200 };

/** Cover hosts learned into the KV allowlist per /list request. */
export const MAX_LIST_LEARN = 4;

// ── /list cover-host learning memo ───────────────────────────────────────────
// /list is a browse loop (pagination, repeated visits) on the parse bucket;
// `learnHosts` re-puts every already-learned host, so without a memo one
// active user re-browsing a source re-writes the same 1–4 cover hosts on every
// page — 30 req/min × up to 4 puts ≈ 120 KV writes/min, burning the free
// tier's 1,000 writes/day from one client. This module-scope Map of
// host → last-put timestamp (the ratelimit.js `buckets` idiom, including the
// crude size-cap eviction) skips hosts put within the last ~6 h. Repeat
// browsing from a warm isolate then writes nothing; the residual cost is one
// put-batch per cold isolate per host, bounded by isolate churn.
//
// Lives here rather than in src/index.js because the entry module may export
// only its default handler (see the file header), and tests need the reset
// hook. /resolve and /chapter keep their unmemoized calls — single-shot
// flows, not loops.

const LIST_LEARN_TTL_MS = 6 * 60 * 60 * 1000; // ~6 h
const MAX_MEMO_HOSTS = 5000;
const learnedAt = new Map(); // host -> last successful KV put (ms)

/** The subset of `hosts` not KV-put from this isolate within the memo TTL. */
export function filterUnlearnedHosts(hosts, now = Date.now()) {
  if (learnedAt.size > MAX_MEMO_HOSTS) learnedAt.clear(); // crude eviction; isolates are short-lived
  const out = [];
  for (const h of hosts) {
    const last = learnedAt.get(h);
    if (last !== undefined && now - last < LIST_LEARN_TTL_MS) continue;
    out.push(h);
  }
  return out;
}

/** Record hosts actually written to KV so warm-isolate repeats skip them. */
export function markHostsLearned(hosts, now = Date.now()) {
  for (const h of hosts) learnedAt.set(h, now);
}

/** Test hook. */
export function _resetListLearnMemo() {
  learnedAt.clear();
}

// ── Referer spoofing ─────────────────────────────────────────────────────────
// Hotlink protection checks Referer/Origin. The value a CDN expects is the
// *site* that would normally embed the image, not the CDN host itself.

const KNOWN_REFERERS = new Map([
  ['uploads.mangadex.org', 'https://mangadex.org/'],
  ['cdn.flamecomics.xyz', 'https://flamecomics.xyz/'],
]);

/** Two-part public suffixes, handled crudely but adequately. */
const TWO_PART_SUFFIX = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/;

/**
 * A plausible Referer for a target host. Falls back to the registrable-ish
 * parent domain: `cdn.example.com` → `https://example.com/`.
 */
export function refererFor(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  if (KNOWN_REFERERS.has(host)) return KNOWN_REFERERS.get(host);
  if (host.endsWith('.mangadex.network') || host.endsWith('.mangadex.org')) {
    return 'https://mangadex.org/';
  }
  const labels = host.split('.');
  if (labels.length <= 2) return `https://${host}/`;
  const tail2 = labels.slice(-2).join('.');
  const base = TWO_PART_SUFFIX.test(tail2) ? labels.slice(-3).join('.') : tail2;
  return `https://${base}/`;
}
