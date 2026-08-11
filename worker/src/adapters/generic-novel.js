// generic-novel.js — readability-style extraction for arbitrary novel sites.
//
// The universal fallback: `matches()` returns true for every http(s) URL, and
// `priority` is the highest number in the registry so every more specific
// adapter wins first (ARCHITECTURE.md §6.5: "lower runs first").
//
// Degrades honestly. If the densest prose container yields 200 characters we
// still return those 200 characters with `confidence: "low"` rather than
// throwing parse_failed — the user can see what we got and judge for themselves.

import { genericResolveSeries, genericResolveChapter, genericListSeries } from './_generic.js';

export const id = 'generic-novel';
export const label = 'Generic novel / web-fiction site';
export const priority = 100;

/** The last-resort adapter: anything http(s) is fair game. */
export function matches(/* url */) {
  return true;
}

// §6.5 optional listing capability. No `listMatches` — `matches()` gates it,
// so this adapter lists everything (the last resort, same as resolving).
export async function listSeries(url, ctx) {
  return genericListSeries(url, ctx, { adapterId: id, type: 'webnovel' });
}

export async function resolveSeries(url, ctx) {
  return genericResolveSeries(url, ctx, {
    adapterId: id,
    type: 'webnovel',
    kind: 'text',
  });
}

export async function resolveChapter(url, ctx) {
  return genericResolveChapter(url, ctx, {
    adapterId: id,
    bias: 'text',
    kind: ctx && ctx.kind,
  });
}
