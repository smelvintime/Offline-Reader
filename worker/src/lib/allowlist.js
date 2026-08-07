// allowlist.js — who /image is allowed to fetch from.
//
// ARCHITECTURE.md §7.3: "/image is allowlist-gated; the allowlist grows only
// via /resolve." Two tiers:
//
//   1. STATIC   — compiled in, always on. Covers the sources the bundled
//                 catalogue and the scraper use.
//   2. LEARNED  — hosts observed while successfully resolving a series or
//                 chapter, written to KV with a 30-day TTL.
//
// KV is OPTIONAL. Without the binding we fall back to the static tier only and
// /health reports `kv: false`.

import { normalizeHost } from './security.js';

/** 30 days, in seconds. */
export const LEARNED_TTL = 30 * 24 * 60 * 60;

/**
 * Static allowlist. Entries beginning with `*.` match any subdomain (and the
 * bare apex). Everything else is an exact hostname match.
 */
export const STATIC_ALLOWLIST = [
  // MangaDex
  'uploads.mangadex.org',
  'mangadex.org',
  '*.mangadex.org',
  '*.mangadex.network',
  // Flame Comics (used by scraper/src/sources/flamecomics.js)
  'flamecomics.xyz',
  '*.flamecomics.xyz',
  // Public-domain text sources shipped in the sample catalogue
  'www.gutenberg.org',
  'gutenberg.org',
  '*.gutenberg.org',
  'standardebooks.org',
  '*.standardebooks.org',
  // Generic image hosts that show up as covers
  'i.imgur.com',
  'upload.wikimedia.org',
];

/** Prefix used for KV keys so the namespace can be shared with other state. */
const KV_PREFIX = 'allow:host:';

function matchesPattern(host, pattern) {
  const p = normalizeHost(pattern);
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === p;
}

/**
 * Build the effective static list: compiled-in entries plus anything in the
 * `EXTRA_ALLOWED_HOSTS` var (comma/whitespace separated) so an operator can add
 * hosts without editing code.
 */
export function staticList(env = {}) {
  const extra = String(env.EXTRA_ALLOWED_HOSTS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...STATIC_ALLOWLIST, ...extra];
}

/** Synchronous static-tier check. */
export function isStaticallyAllowed(host, env = {}) {
  const h = normalizeHost(host);
  if (!h) return false;
  return staticList(env).some((p) => matchesPattern(h, p));
}

/** Does this deployment have a KV namespace bound? */
export function hasKv(env = {}) {
  const kv = env.OR_ALLOWLIST;
  return !!(kv && typeof kv.get === 'function' && typeof kv.put === 'function');
}

/**
 * Full check: static tier, then the learned tier in KV.
 * Never throws — a KV outage degrades to "static only".
 */
export async function isAllowedHost(host, env = {}) {
  const h = normalizeHost(host);
  if (!h) return { allowed: false, via: null };
  if (isStaticallyAllowed(h, env)) return { allowed: true, via: 'static' };
  if (!hasKv(env)) return { allowed: false, via: null };
  try {
    const hit = await env.OR_ALLOWLIST.get(KV_PREFIX + h);
    if (hit) return { allowed: true, via: 'learned' };
    // Also honour a learned parent domain written as "*.example.com".
    const labels = h.split('.');
    for (let i = 1; i <= labels.length - 2; i++) {
      const parent = labels.slice(i).join('.');
      // eslint-disable-next-line no-await-in-loop
      const w = await env.OR_ALLOWLIST.get(KV_PREFIX + '*.' + parent);
      if (w) return { allowed: true, via: 'learned-wildcard' };
    }
  } catch {
    /* KV unavailable → static only */
  }
  return { allowed: false, via: null };
}

/**
 * Remember hosts discovered during a successful /resolve or /chapter.
 * No-op without KV. Bounded so a hostile page cannot burn the KV write budget.
 *
 * @param {Iterable<string>} hosts
 * @returns {Promise<string[]>} the hosts actually written
 */
export async function learnHosts(hosts, env = {}, { max = 12 } = {}) {
  if (!hasKv(env)) return [];
  const seen = [];
  for (const raw of hosts) {
    if (seen.length >= max) break;
    const h = normalizeHost(raw);
    if (!h || !h.includes('.') || h.length > 253) continue;
    if (isStaticallyAllowed(h, env)) continue; // already covered
    if (seen.includes(h)) continue;
    seen.push(h);
  }
  if (!seen.length) return [];
  try {
    await Promise.all(
      seen.map((h) =>
        env.OR_ALLOWLIST.put(KV_PREFIX + h, String(Date.now()), { expirationTtl: LEARNED_TTL }),
      ),
    );
  } catch {
    return [];
  }
  return seen;
}

/** Collect the hostnames referenced by a set of absolute URLs. */
export function hostsOf(urls) {
  const out = new Set();
  for (const u of urls || []) {
    try {
      out.add(normalizeHost(new URL(u).hostname));
    } catch {
      /* skip */
    }
  }
  out.delete('');
  return out;
}
