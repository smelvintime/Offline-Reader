// generic-manga.js — image-chapter extraction for arbitrary manga/manhwa sites.
//
// Sits between `mangadex` and `generic-novel` in priority. Unlike the novel
// adapter it does NOT match everything: matching every URL would make it beat
// generic-novel on every novel site, since selection is "lowest priority among
// matches". It matches when the URL looks comic-ish, or when the caller
// explicitly asked for `kind=image`.
//
// Chapter extraction is "largest run of sequential images in one container"
// (lib/extract.js findImageRun), with icons/avatars/ads filtered by dimension
// attributes and URL shape.

import { genericResolveSeries, genericResolveChapter } from './_generic.js';

export const id = 'generic-manga';
export const label = 'Generic manga / manhwa site';
export const priority = 90;

/** Host or path hints that a site serves comics rather than prose. */
const COMIC_HINT =
  /(manga|manhwa|manhua|webtoon|toon|comic|comik|komik|scan|scans|chapter-\d|read\/)/i;

export function matches(url, ctx) {
  if (ctx && ctx.kind === 'image') return true;
  try {
    const u = new URL(url);
    return COMIC_HINT.test(u.hostname) || COMIC_HINT.test(u.pathname);
  } catch {
    return false;
  }
}

export async function resolveSeries(url, ctx) {
  return genericResolveSeries(url, ctx, {
    adapterId: id,
    type: 'manga',
    readingDirection: 'ltr',
    kind: 'image',
  });
}

export async function resolveChapter(url, ctx) {
  return genericResolveChapter(url, ctx, {
    adapterId: id,
    bias: 'image',
    kind: ctx && ctx.kind,
  });
}
