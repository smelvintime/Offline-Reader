// ratelimit.js — deliberately simple per-client throttle.
//
// HONEST WEAKNESS (documented in README): this is an in-memory fixed-window
// counter scoped to ONE Workers isolate. Cloudflare runs many isolates across
// many colos, so a distributed client sees roughly `limit × isolates` in
// practice. It exists to stop a single browser tab from hammering us and to
// blunt casual abuse — it is NOT a security boundary. A real limit needs
// Durable Objects or Cloudflare's Rate Limiting rules; KV is unsuitable because
// the free tier only allows 1,000 writes/day.

const buckets = new Map(); // key -> { windowStart, count }
const MAX_KEYS = 5000;

/** Per-endpoint budgets, requests per window. */
export const BUDGETS = {
  // Cheap, cacheable, and the hot path for a reading session.
  image: { limit: 300, windowMs: 60_000 },
  // Expensive: fetches + parses third-party HTML.
  parse: { limit: 30, windowMs: 60_000 },
  // Trivial.
  meta: { limit: 120, windowMs: 60_000 },
};

/** Identify the caller. CF-Connecting-IP is set by the edge and unspoofable there. */
export function clientKey(request) {
  const h = request.headers;
  return (
    h.get('cf-connecting-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0].trim() ||
    h.get('x-real-ip') ||
    'anonymous'
  );
}

/**
 * @returns {{ok:true}|{ok:false,retryAfter:number}}
 */
export function checkRateLimit(request, bucket = 'meta', env = {}) {
  if (String(env.DISABLE_RATE_LIMIT || '') === 'true') return { ok: true };
  const budget = BUDGETS[bucket] || BUDGETS.meta;
  const limit = Number(env[`RATE_LIMIT_${bucket.toUpperCase()}`] || budget.limit);
  const key = `${bucket}:${clientKey(request)}`;
  const now = Date.now();

  if (buckets.size > MAX_KEYS) buckets.clear(); // crude eviction; isolates are short-lived

  let b = buckets.get(key);
  if (!b || now - b.windowStart >= budget.windowMs) {
    b = { windowStart: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.ceil((b.windowStart + budget.windowMs - now) / 1000) };
  }
  return { ok: true };
}

/** Test hook. */
export function _resetRateLimit() {
  buckets.clear();
}
