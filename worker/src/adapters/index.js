// adapters/index.js — the registry.
//
// Selection rule (ARCHITECTURE.md §6.5): every adapter whose `matches(url)`
// returns true is a candidate; the one with the LOWEST `priority` wins.
//
// Current ladder:
//   10  mangadex       — exact host+path match, real JSON API
//   90  generic-manga  — comic-ish URL, or an explicit kind=image request
//  100  generic-novel  — matches everything; the last resort
//
// Adding an adapter is: write the module, import it here, put it in ADAPTERS.

import * as mangadex from './mangadex.js';
import * as genericManga from './generic-manga.js';
import * as genericNovel from './generic-novel.js';

/** Registered adapters, sorted so the first match is always the winner. */
export const ADAPTERS = [mangadex, genericManga, genericNovel].sort(
  (a, b) => a.priority - b.priority,
);

/** Shape check — catches a half-written adapter at boot instead of at runtime. */
function isValid(a) {
  return (
    a &&
    typeof a.id === 'string' &&
    typeof a.matches === 'function' &&
    typeof a.priority === 'number' &&
    typeof a.resolveSeries === 'function' &&
    typeof a.resolveChapter === 'function'
  );
}

for (const a of ADAPTERS) {
  if (!isValid(a)) {
    throw new Error(`Invalid adapter registered: ${(a && a.id) || '<unknown>'}`);
  }
}

/** `[{ id, label, priority }]` — the payload /health reports. */
export function listAdapters() {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label || a.id, priority: a.priority }));
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
