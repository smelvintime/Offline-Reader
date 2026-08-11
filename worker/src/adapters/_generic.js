// _generic.js — the shared body of `generic-novel` and `generic-manga`.
//
// NOT an adapter itself (leading underscore, never registered). The two generic
// adapters differ only in defaults and in which content kind they bias toward,
// so the actual work lives here once.
//
// Design note — kind detection: a chapter URL does not reliably tell you whether
// it holds prose or page images. Both adapters therefore extract BOTH and let
// the page decide, with the caller's `kind` hint (and the adapter's own bias)
// used only to break ties. This is why `/chapter?kind=` is documented as a hint
// the adapter may override (ARCHITECTURE.md §6.3).

import { extractMeta, sniffInfoPairs, absolutize, normalizeStatus } from '../lib/meta.js';
import { blocksFromNode, countWords, countChars } from '../lib/blocks.js';
import {
  prune,
  measure,
  pickProseContainer,
  findTocCluster,
  findListingCluster,
  findImageRun,
  findNextLink,
  parseChapterNum,
  cleanChapterTitle,
  hashId,
  headingText,
  worstConfidence,
  textOf,
} from '../lib/extract.js';

/** Hard caps so one hostile or enormous site cannot burn the CPU budget. */
export const GENERIC_LIMITS = {
  maxChapters: 2000,
  maxTocPages: 4, // extra rel=next pages beyond the first
  maxPages: 400, // images in one chapter
};

// ── Series ───────────────────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {object} ctx  { fetchHtml, chapterSrc, env, … }
 * @param {{adapterId:string, type:string, readingDirection?:string}} opts
 */
export async function genericResolveSeries(url, ctx, opts) {
  const first = await ctx.fetchHtml(url);
  const baseUrl = first.finalUrl || url;

  // Metadata comes from OG/JSON-LD/<meta> before any heuristic (brief + §6.5).
  const meta = extractMeta(first.root, baseUrl);
  const info = sniffInfoPairs(first.root);

  // TOC detection runs on a lightly pruned tree — a full prune would delete the
  // chapter list, which very often lives in a `class="toc"`/`nav` element.
  const tocRoot = first.root;
  prune(tocRoot, 'light');

  let cluster = findTocCluster(tocRoot, baseUrl);
  const links = cluster ? cluster.links.slice() : [];
  const seen = new Set(links.map((l) => l.href));

  // Capped rel="next" pagination.
  let nextUrl = findNextLink(tocRoot, baseUrl, baseUrl);
  let pagesFetched = 0;
  const visited = new Set([baseUrl]);
  while (nextUrl && pagesFetched < GENERIC_LIMITS.maxTocPages && links.length < GENERIC_LIMITS.maxChapters) {
    if (visited.has(nextUrl)) break;
    visited.add(nextUrl);
    let page;
    try {
      // eslint-disable-next-line no-await-in-loop
      page = await ctx.fetchHtml(nextUrl);
    } catch {
      break; // pagination is best-effort; a dead page must not fail the resolve
    }
    pagesFetched++;
    const pageBase = page.finalUrl || nextUrl;
    prune(page.root, 'light');
    const more = findTocCluster(page.root, pageBase);
    if (more) {
      for (const l of more.links) {
        if (seen.has(l.href)) continue;
        seen.add(l.href);
        links.push(l);
      }
      if (!cluster) cluster = more;
    }
    nextUrl = findNextLink(page.root, pageBase, pageBase);
  }

  // Most TOCs list newest-first. If the parsed numbers trend downward, flip.
  const nums = links.map((l) => l.num).filter((n) => n !== null);
  if (nums.length >= 3 && descending(nums)) links.reverse();

  const chapters = buildChapters(links, ctx, opts);

  const sourceUrl = meta.canonical || baseUrl;
  const confidence = cluster ? cluster.confidence : 'low';

  const series = {
    id: 'user:' + hashId(sourceUrl),
    type: opts.type,
    title: meta.title || textOf(first.root).slice(0, 80).trim() || hostOf(baseUrl),
    altTitles: [],
    cover: meta.cover || '',
    description: (meta.description || '').slice(0, 4000),
    author: meta.author || info.author || '',
    artist: meta.artist || info.artist || '',
    status: info.status && info.status !== 'unknown' ? info.status : normalizeStatus(meta.status),
    genres: (meta.genres && meta.genres.length ? meta.genres : info.genres || []).slice(0, 15),
    tags: [],
    language: (meta.lang || 'en').split('-')[0] || 'en',
    source: opts.adapterId,
    sourceUrl,
    updatedAt: meta.modified || new Date().toISOString(),
    chapterCount: chapters.length,
    chapters,
    confidence,
  };
  if (opts.readingDirection) series.readingDirection = opts.readingDirection;

  // Hosts we may need to proxy images from later (§6.2: "Any image hosts
  // discovered are written into the KV allowlist").
  const hosts = new Set();
  if (series.cover) addHost(hosts, series.cover);
  addHost(hosts, baseUrl);

  return { series, hosts, confidence };
}

function buildChapters(links, ctx, opts) {
  const out = [];
  const usedIds = new Set();
  const capped = links.slice(0, GENERIC_LIMITS.maxChapters);
  capped.forEach((l, i) => {
    const num = l.num !== null && l.num !== undefined ? l.num : null;
    let base = num !== null ? 'c-' + padNum(num) : 'c-' + String(i + 1).padStart(4, '0');
    let id = base;
    let dup = 2;
    while (usedIds.has(id)) id = `${base}-${dup++}`;
    usedIds.add(id);

    const title = cleanChapterTitle(l.text) || null;
    out.push({
      id,
      num,
      volume: null,
      title,
      lang: opts.lang || 'en',
      // §6.2: every chapter resolves through the worker.
      src: ctx.chapterSrc(l.href, opts.kind || (opts.type === 'manga' ? 'image' : 'text')),
      sourceUrl: l.href,
    });
  });
  return out;
}

function padNum(n) {
  const int = Math.floor(Math.abs(n));
  const frac = Math.abs(n) - int;
  const head = String(int).padStart(4, '0');
  return frac ? head + '.' + String(Math.round(frac * 1000)).replace(/0+$/, '') : head;
}

function descending(nums) {
  let down = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] < nums[i - 1]) down++;
  }
  return down > (nums.length - 1) / 2;
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return 'unknown';
  }
}

function addHost(set, u) {
  try {
    set.add(new URL(u).hostname);
  } catch {
    /* ignore */
  }
}

// ── Listing (§6.6 — /list) ───────────────────────────────────────────────────

/**
 * Extract a series listing (a browse/catalogue page) as `{ source, items,
 * nextUrl? }`. One page fetch only — pagination is client-driven via `nextUrl`
 * (the /list response contract), never walked server-side.
 *
 * Items carry the raw absolute URL the client feeds back into /resolve; the
 * listing NEVER mints series ids — the client and /resolve own id hashing.
 *
 * Returns null when the page yields no usable listing (the handler turns that
 * into `list_failed`).
 *
 * @param {string} url
 * @param {object} ctx  { fetchHtml, … }
 * @param {{adapterId:string, type?:string}} opts  `type` is a hint, never trusted.
 */
export async function genericListSeries(url, ctx, opts) {
  const page = await ctx.fetchHtml(url);
  const baseUrl = page.finalUrl || url;
  const meta = extractMeta(page.root, baseUrl);

  // Same light prune as the TOC path — a full prune would delete listings that
  // live in `class="nav"`-ish containers.
  prune(page.root, 'light');

  const cluster = findListingCluster(page.root, baseUrl);
  if (!cluster || !cluster.items.length) return null;

  const items = cluster.items.map((it) => {
    const out = { title: it.title, url: it.url };
    if (it.cover) out.cover = it.cover;
    if (opts.type) out.type = opts.type;
    return out;
  });

  const out = {
    source: {
      title: (meta.siteName || meta.title || hostOf(baseUrl)).slice(0, 200),
      url: baseUrl,
    },
    items,
  };
  const nextUrl = findNextLink(page.root, baseUrl, baseUrl);
  if (nextUrl) out.nextUrl = nextUrl;
  return out;
}

// ── Chapter ──────────────────────────────────────────────────────────────────

/**
 * Extract one chapter, deciding text-vs-image from what the page actually holds.
 *
 * @param {{bias:'text'|'image', adapterId:string}} opts
 */
export async function genericResolveChapter(url, ctx, opts) {
  const page = await ctx.fetchHtml(url);
  const baseUrl = page.finalUrl || url;
  const meta = extractMeta(page.root, baseUrl);

  // Image detection first, on a lightly pruned tree (chrome images are filtered
  // by URL/dimension shape inside findImageRun, not by class pruning).
  const imageRun = findImageRun(page.root, baseUrl, { minImages: 2 });

  // Prose detection needs the aggressive prune so a sidebar cannot win.
  prune(page.root, 'full');
  const memo = measure(page.root);
  const prose = pickProseContainer(page.root, { memo });

  const proseChars = prose ? prose.textLen : 0;
  const imageCount = imageRun ? imageRun.urls.length : 0;

  const hint = opts.kind || ctx.kind || opts.bias;
  const kind = decideKind({ hint, bias: opts.bias, proseChars, imageCount, imageRun });

  const title =
    cleanChapterTitle(headingText(page.root)) ||
    cleanChapterTitle(meta.title) ||
    meta.title ||
    null;
  const num = parseChapterNum(meta.title || '', baseUrl);

  const hosts = new Set();

  if (kind === 'image') {
    const pages = imageRun ? imageRun.urls.slice(0, GENERIC_LIMITS.maxPages) : [];
    for (const p of pages) addHost(hosts, p);
    return {
      chapter: {
        id: 'c-' + (num !== null ? padNum(num) : hashId(baseUrl)),
        num,
        title,
        kind: 'image',
        pages,
        sourceUrl: baseUrl,
        confidence: imageRun ? imageRun.confidence : 'low',
      },
      hosts,
      confidence: imageRun ? imageRun.confidence : 'low',
    };
  }

  const blocks = prose ? blocksFromNode(prose.node, baseUrl) : [];
  for (const b of blocks) if (b.t === 'img' && b.src) addHost(hosts, b.src);

  // Honest confidence: a container that scored well but yielded almost no text
  // is a low-confidence result, not a success.
  let confidence = prose ? prose.confidence : 'low';
  const chars = countChars(blocks);
  if (chars < 400) confidence = 'low';
  else confidence = worstConfidence(confidence, chars >= 1500 ? 'high' : 'medium');

  return {
    chapter: {
      id: 'c-' + (num !== null ? padNum(num) : hashId(baseUrl)),
      num,
      title,
      kind: 'text',
      blocks,
      wordCount: countWords(blocks),
      sourceUrl: baseUrl,
      confidence,
    },
    hosts,
    confidence,
  };
}

/**
 * text-vs-image decision. The `kind` query param is a hint, not an instruction:
 * a page with 30 sequential images and 200 characters of prose is an image
 * chapter no matter what the caller asked for.
 */
export function decideKind({ hint, bias, proseChars, imageCount, imageRun }) {
  const strongImages = imageCount >= 3 && (!imageRun || imageRun.confidence !== 'low');
  const strongProse = proseChars >= 1200;

  if (strongImages && !strongProse) return 'image';
  if (strongProse && imageCount < 3) return 'text';
  if (strongImages && strongProse) {
    // Both present: an illustrated novel has prose >> images.
    return proseChars > imageCount * 400 ? 'text' : 'image';
  }
  // Nothing is convincing — fall back to the caller's hint, then our bias.
  if (hint === 'image' || hint === 'text') return hint;
  return bias || 'text';
}
