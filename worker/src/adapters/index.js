// adapters/index.js — the registry.
//
// Selection rule (ARCHITECTURE.md §6.5): every adapter whose `matches(url)`
// returns true is a candidate; the one with the LOWEST `priority` wins.
//
// Current ladder:
//   90  generic-manga  — comic-ish URL, or an explicit kind=image request
//  100  generic-novel  — matches everything; the last resort
//
// Both are general-purpose: they parse whatever URL the reader hands them and
// name no particular site. That is deliberate (docs/ARCHITECTURE.md §8) — the
// gateway is a user-agent, and a user-agent does not ship a list of the sites
// it was built for. Adding a site-specific adapter would undo it.
//
// Adding an adapter is: write the module, import it here, put it in ADAPTERS.
//
// Listing (§6.6) is an OPTIONAL capability: adapters may export
// `listSeries(url, ctx)` and, to gate it separately from resolving,
// `listMatches(url)`. `selectListAdapter` routes /list; `listAdapters` reports
// `canList` so /health tells clients whether browsing works at all.

import * as genericManga from './generic-manga.js';
import * as genericNovel from './generic-novel.js';

/** Registered adapters, sorted so the first match is always the winner. */
export const ADAPTERS = [genericManga, genericNovel].sort((a, b) => a.priority - b.priority);

/**
 * Shape check — catches a half-written adapter at boot instead of at runtime.
 * The five §6.5 members stay required; `listSeries`/`listMatches` are OPTIONAL,
 * but a present member of the wrong type IS a boot error (exported for tests).
 */
export function isValidAdapter(a) {
  return (
    a &&
    typeof a.id === 'string' &&
    typeof a.matches === 'function' &&
    typeof a.priority === 'number' &&
    typeof a.resolveSeries === 'function' &&
    typeof a.resolveChapter === 'function' &&
    (a.listSeries === undefined || typeof a.listSeries === 'function') &&
    (a.listMatches === undefined || typeof a.listMatches === 'function')
  );
}

for (const a of ADAPTERS) {
  if (!isValidAdapter(a)) {
    throw new Error(`Invalid adapter registered: ${(a && a.id) || '<unknown>'}`);
  }
}

/** `[{ id, label, priority, canList }]` — the payload /health reports. */
export function listAdapters() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label || a.id,
    priority: a.priority,
    canList: typeof a.listSeries === 'function',
  }));
}

export function adapterIds() {
  return ADAPTERS.map((a) => a.id);
}

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * Pick the adapter for a URL.
 *
 * @param {string} url
 * @param {{kind?:string, force?:string}} [ctx] `kind` is visible to `matches()`
 *        so generic-manga can claim an explicit image request; `force` pins a
 *        specific adapter by id (used by tests and the `?adapter=` debug param).
 * @returns {object|null}
 */
export function selectAdapter(url, ctx = {}) {
  if (ctx.force) {
    const pinned = getAdapter(ctx.force);
    return pinned || null;
  }
  for (const a of ADAPTERS) {
    let ok = false;
    try {
      ok = !!a.matches(url, ctx);
    } catch {
      ok = false;
    }
    if (ok) return a;
  }
  return null;
}

/**
 * Pick the adapter for a /list URL (§6.6): first adapter in priority order
 * that implements `listSeries` AND whose `listMatches(url)` — or, when that
 * optional gate is absent, `matches(url)` — claims the URL. `force` pins by id
 * (the `?adapter=` debug param), but never onto an adapter that cannot list.
 *
 * @param {string} url
 * @param {{force?:string}} [ctx]
 * @returns {object|null}
 */
export function selectListAdapter(url, ctx = {}) {
  if (ctx.force) {
    const pinned = getAdapter(ctx.force);
    return pinned && typeof pinned.listSeries === 'function' ? pinned : null;
  }
  for (const a of ADAPTERS) {
    if (typeof a.listSeries !== 'function') continue;
    let ok = false;
    try {
      ok = typeof a.listMatches === 'function' ? !!a.listMatches(url) : !!a.matches(url, ctx);
    } catch {
      ok = false;
    }
    if (ok) return a;
  }
  return null;
}
