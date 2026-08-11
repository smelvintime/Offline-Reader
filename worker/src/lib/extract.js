// extract.js — the site-agnostic heuristics both generic adapters share.
//
// Four jobs, each a separate exported entry point:
//
//   1. pickProseContainer  — readability-style "which element holds the prose?"
//   2. findTocCluster      — "which group of same-shaped links is the chapter list?"
//   3. findImageRun        — "which container holds the longest run of page images?"
//   4. findListingCluster  — "which group of same-shaped links is a series listing?"
//
// 2 and 4 are the same structural problem — the largest group of same-shaped
// links — with a different *text prior*, so both are thin wrappers over the
// shared `findLinkCluster` core (the prior is pluggable; chapter-ish scoring
// for the TOC, cover-presence scoring for listings).
//
// Everything here is a *guess*. Each function returns a `confidence` of
// high/medium/low alongside whatever it found, and callers are expected to
// return low-confidence results to the user rather than pretending they failed
// (ARCHITECTURE.md §6.5: "the generic adapters must degrade gracefully").
//
// Pure functions over the html.js tree — no fetch, no network, unit-testable.

import { attr, byTag, classId, decodeEntities, findAll, isElement } from './html.js';
import { isJunkElement, imageSrc } from './blocks.js';
import { absolutize } from './meta.js';

// ── Cheap bottom-up measurement ──────────────────────────────────────────────
// Naively calling getText() on every candidate is O(n^2) over the document and
// blows the Workers CPU budget on a big page. One post-order pass gives every
// node its text length, link-text length and comma count instead.

const SKIP_TEXT = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'canvas',
]);

const ZERO = Object.freeze({ text: 0, link: 0, commas: 0 });

/** @returns {Map<object,{text:number,link:number,commas:number}>} */
export function measure(root) {
  const memo = new Map();
  (function rec(n) {
    if (!n) return ZERO;
    if (n.type === 'text') {
      const s = decodeEntities(n.raw).replace(/\s+/g, ' ');
      const r = { text: s.trim().length, link: 0, commas: (s.match(/[,，、]/g) || []).length };
      memo.set(n, r);
      return r;
    }
    if (!isElement(n)) return ZERO;
    if (SKIP_TEXT.has(n.tag)) {
      const r = { text: 0, link: 0, commas: 0 };
      memo.set(n, r);
      return r;
    }
    let text = 0;
    let link = 0;
    let commas = 0;
    for (const c of n.children) {
      const r = rec(c);
      text += r.text;
      link += r.link;
      commas += r.commas;
    }
    // Everything inside an <a> counts as link text; parents sum it naturally.
    if (n.tag === 'a') link = text;
    const r = { text, link, commas };
    memo.set(n, r);
    return r;
  })(root);
  return memo;
}

export function densityOf(memo, node) {
  const m = memo.get(node);
  if (!m || !m.text) return 1;
  return Math.min(1, m.link / m.text);
}

// ── 1. Prose container (readability-ish) ─────────────────────────────────────

const BLOCKISH = new Set([
  'div', 'p', 'section', 'article', 'ul', 'ol', 'table', 'figure', 'blockquote',
  'pre', 'header', 'footer', 'nav', 'aside', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

const CANDIDATE_TAGS = new Set([
  'div', 'article', 'section', 'main', 'td', 'body', 'center', '#root',
]);

const POSITIVE_CLASS =
  /(article|body|content|entry|hentry|main|page|post|text|blog|story|chapter|novel|read(er|ing)?|prose|epcontent|maintext)/i;

/** A <p>, or a <div> that is used *as* a paragraph (no block children). */
function isParagraphish(n) {
  if (n.tag === 'p' || n.tag === 'pre' || n.tag === 'blockquote') return true;
  if (n.tag === 'div' || n.tag === 'section') {
    return !n.children.some((c) => isElement(c) && BLOCKISH.has(c.tag));
  }
  return false;
}

/**
 * Remove obvious non-content before scoring. Two strengths:
 *  - 'light' strips only things that are never content anywhere (script/style/…).
 *  - 'full'  additionally applies blocks.js `isJunkElement` (nav/ads/sidebars).
 *
 * TOC detection MUST use 'light': the chapter list very often lives in a element
 * whose class contains "toc" or "nav", which `isJunkElement` would delete.
 * Prose extraction uses 'full'.
 *
 * Mutates the tree; callers parse a fresh tree per use.
 */
export function prune(root, strength = 'full') {
  const LIGHT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head']);
  return removeWhere(root, (n) => {
    if (LIGHT.has(n.tag)) return true;
    if (strength === 'full' && isJunkElement(n)) return true;
    return false;
  });
}

function removeWhere(root, pred) {
  let removed = 0;
  (function rec(n) {
    if (!isElement(n)) return;
    n.children = n.children.filter((c) => {
      if (isElement(c) && pred(c)) {
        removed++;
        return false;
      }
      return true;
    });
    for (const c of n.children) rec(c);
  })(root);
  return removed;
}

/**
 * Find the element most likely to hold the chapter prose.
 * @returns {{node,score,textLen,linkDensity,confidence}|null}
 */
export function pickProseContainer(root, opts = {}) {
  const memo = opts.memo || measure(root);
  const raw = new Map();
  const bump = (node, v) => {
    if (!node || !isElement(node)) return;
    raw.set(node, (raw.get(node) || 0) + v);
  };

  const paras = findAll(root, isParagraphish);
  for (const p of paras) {
    const m = memo.get(p);
    if (!m || m.text < 25) continue;
    // Classic readability weighting: length in 100-char steps, plus commas as a
    // proxy for "real sentences", credited to the parent chain with decay.
    const s = 1 + Math.min(Math.floor(m.text / 100), 3) + Math.min(m.commas, 3);
    bump(p.parent, s);
    bump(p.parent && p.parent.parent, s / 2);
    bump(p.parent && p.parent.parent && p.parent.parent.parent, s / 4);
  }

  let best = null;
  const adjusted = new Map();
  for (const [node, score] of raw) {
    if (!CANDIDATE_TAGS.has(node.tag)) continue;
    const m = memo.get(node) || ZERO;
    let final = score * (1 - densityOf(memo, node));
    const ci = classId(node);
    if (POSITIVE_CLASS.test(ci)) final *= 1.25;
    if (node.tag === 'article' || node.tag === 'main') final *= 1.3;
    if (node.tag === 'body' || node.tag === '#root') final *= 0.5;
    adjusted.set(node, final);
    if (!best || final > adjusted.get(best)) best = node;
  }

  if (!best) return null;

  // Climb while the parent scores at least as well — catches prose split across
  // sibling wrappers. Stops immediately in the common single-container case.
  for (;;) {
    const p = best.parent;
    if (!p || !isElement(p) || !adjusted.has(p)) break;
    if (adjusted.get(p) <= adjusted.get(best)) break;
    best = p;
  }

  const m = memo.get(best) || ZERO;
  const ld = densityOf(memo, best);
  const score = adjusted.get(best) || 0;
  let confidence = 'low';
  if (m.text >= 1500 && ld < 0.2 && score >= 15) confidence = 'high';
  else if (m.text >= 500 && ld < 0.4 && score >= 6) confidence = 'medium';

  return { node: best, score, textLen: m.text, linkDensity: ld, confidence };
}

// ── 2. Table-of-contents cluster ─────────────────────────────────────────────

/** Text that reads like a chapter entry. */
const CHAPTER_TEXT =
  /(?:^|[\s\W])(?:chapter|chap|ch|episode|epis|ep|part|vol|volume|book|side\s*story|第|话|話|章|권|화)\s*\.?\s*#?\s*\d/i;

const BARE_NUMBER = /^\s*[#-]?\s*\d{1,5}(?:[.-]\d{1,3})?\s*$/;

/** Link labels that are site chrome, never chapters. */
const NAV_TEXT =
  /^\s*(home|index|next|prev(ious)?|back|forward|first|last|top|menu|search|login|log\s?in|sign\s?(in|up)|register|logout|profile|account|bookmark(s)?|favorite(s)?|follow|report|download|comment(s)?|share|more|all|view all|about|contact|privacy|terms|dmca|advertis\w*|donate|patreon|discord|telegram|twitter|facebook|rss|tags?|genres?|browse|random|latest|popular|new|updates?)\s*$/i;

/** Containers whose links are pagination, not chapters. */
const PAGINATION_CLASS = /(pagination|pager|paging|page-nav|page-numbers|nav-links|breadcrumb)/i;

/**
 * Pull a chapter number out of a link's text, falling back to its href.
 * @returns {number|null}
 */
export function parseChapterNum(text, href) {
  const t = String(text || '');
  let m =
    /(?:chapter|chap|ch|episode|ep|part|第)\s*\.?\s*#?\s*(\d{1,5}(?:\.\d{1,3})?)/i.exec(t) ||
    /^\s*[#-]?\s*(\d{1,5}(?:\.\d{1,3})?)/.exec(t);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  const h = String(href || '');
  try {
    const path = h.includes('://') ? new URL(h).pathname : h;
    m =
      /(?:chapter|chap|ch|episode|ep|c)[-_/]?(\d{1,5}(?:[-.]\d{1,3})?)/i.exec(path) ||
      /(\d{1,5}(?:\.\d{1,3})?)(?:[^\d]*)$/.exec(path);
    if (m) {
      const n = Number(String(m[1]).replace('-', '.'));
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* not a URL — fine */
  }
  return null;
}

/** Trim "Chapter 12 - " style prefixes down to the actual title, if any. */
export function cleanChapterTitle(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:chapter|chap|ch|episode|ep)\s*\.?\s*#?\s*\d+(?:\.\d+)?\s*[-–—:.]?\s*/i, '');
  return t.trim();
}

function shapeOf(a, levels) {
  const parts = [];
  let n = a;
  for (let i = 0; i < levels && n; i++) {
    const cls = n.attrs && n.attrs.class ? String(n.attrs.class).trim().split(/\s+/)[0] : '';
    parts.push(n.tag + (cls ? '.' + cls : ''));
    n = n.parent;
  }
  return parts.join('<');
}

function ancestorAt(a, levels) {
  let n = a;
  for (let i = 0; i < levels && n.parent; i++) n = n.parent;
  return n;
}

function commonPrefixRatio(hrefs) {
  if (hrefs.length < 2) return 0;
  let prefix = hrefs[0];
  for (const h of hrefs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < h.length && prefix[i] === h[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  const avg = hrefs.reduce((s, h) => s + h.length, 0) / hrefs.length;
  return avg ? Math.min(1, prefix.length / avg) : 0;
}

/**
 * The chapter-flavoured text prior — the classic TOC scoring, unchanged.
 * `pre` multiplies the score before the nav/pagination penalties, `post` after,
 * preserving the exact multiplication order of the pre-refactor code so
 * existing fixtures score bit-identically.
 */
function tocPrior(uniq) {
  const chapterish =
    uniq.filter((e) => CHAPTER_TEXT.test(e.text) || BARE_NUMBER.test(e.text)).length / uniq.length;
  const numbered =
    uniq.filter((e) => parseChapterNum(e.text, e.href) !== null).length / uniq.length;
  return {
    pre: 0.35 + 0.65 * chapterish,
    post: 0.5 + 0.5 * numbered,
    stats: { chapterish, numbered },
  };
}

/**
 * Per-entry "card" detection: each entry's card is the highest ancestor (below
 * the cluster container) that holds no OTHER entry — the per-item unit of a
 * listing grid. `ancestorAt(levels - 1)` is NOT that: at deeper grouping
 * levels it resolves to the shared grid, which would hand every item the same
 * first cover.
 */
function cardsFor(entries, container) {
  const counts = new Map(); // ancestor node -> how many entries it contains
  for (const e of entries) {
    for (let n = e.node; n && n !== container; n = n.parent) {
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  return entries.map((e) => {
    let card = e.node;
    for (let n = e.node; n && n !== container; n = n.parent) {
      if ((counts.get(n) || 0) > 1) break;
      card = n;
    }
    return card;
  });
}

/** Memoized "does this subtree contain an <img>?" — keeps the prior O(n). */
function subtreeHasImage(node, memo) {
  if (!isElement(node)) return false;
  const hit = memo.get(node);
  if (hit !== undefined) return hit;
  let r = node.tag === 'img' || node.tag === 'image';
  if (!r) {
    for (const c of node.children) {
      if (subtreeHasImage(c, memo)) {
        r = true;
        break;
      }
    }
  }
  memo.set(node, r);
  return r;
}

/**
 * The listing-flavoured text prior: reward a cover image inside each link's
 * card; no chapter-text reward. (Count and href-prefix similarity are
 * rewarded by the shared core; the nav-word penalty is kept.)
 */
function listingPrior(uniq, { container }, memo) {
  const cards = cardsFor(uniq, container);
  const coverish = cards.filter((card) => subtreeHasImage(card, memo)).length / uniq.length;
  return { pre: 0.55 + 0.45 * coverish, post: 1, stats: { coverish } };
}

/**
 * Shared core: find the best-scoring group of same-shaped links.
 *
 * We try grouping at three ancestor depths because layouts differ:
 *   <ul><li><a>            → the list is 2 levels up
 *   <div><div><span><a>    → the list is 3 levels up
 * and take the best-scoring group across all of them.
 *
 * The text-based part of the score is the pluggable `textPrior(uniq, info)` —
 * chapter-ish scoring for TOCs (the default), cover-presence for listings.
 * Structural scoring (count, href-prefix similarity, the nav-word penalty and
 * the pagination penalty) is shared.
 *
 * @param {object} root
 * @param {string} baseUrl
 * @param {{minLinks?:number, textPrior?:Function, navPenalty?:boolean}} [opts]
 * @returns {{entries:Array<{node,href,text}>,container,levels:number,score,stats:object}|null}
 */
export function findLinkCluster(root, baseUrl, opts = {}) {
  const minLinks = opts.minLinks || 3;
  const textPrior = opts.textPrior || tocPrior;
  const navPenalty = opts.navPenalty !== false;
  const anchors = byTag(root, 'a');
  if (anchors.length < minLinks) return null;

  const info = [];
  for (const a of anchors) {
    const href = absolutize(attr(a, 'href'), baseUrl);
    if (!href) continue;
    const text = textOf(a).trim();
    if (!text && !CHAPTER_TEXT.test(href)) continue;
    if (text.length > 200) continue;
    info.push({ node: a, href, text });
  }
  if (info.length < minLinks) return null;

  let best = null;
  for (const levels of [2, 3, 4]) {
    const groups = new Map(); // container node -> Map(shape -> entries)
    for (const it of info) {
      const container = ancestorAt(it.node, levels);
      const shape = shapeOf(it.node, levels);
      let byShape = groups.get(container);
      if (!byShape) groups.set(container, (byShape = new Map()));
      const arr = byShape.get(shape) || [];
      arr.push(it);
      byShape.set(shape, arr);
    }
    for (const [container, byShape] of groups) {
      for (const [shape, entries] of byShape) {
        // Dedupe by href — sites repeat the same chapter link (cover + title).
        const uniq = [];
        const seen = new Set();
        for (const e of entries) {
          if (seen.has(e.href)) continue;
          seen.add(e.href);
          uniq.push(e);
        }
        if (uniq.length < minLinks) continue;

        const navish = uniq.filter((e) => NAV_TEXT.test(e.text)).length / uniq.length;
        const prefix = commonPrefixRatio(uniq.map((e) => e.href));
        const prior = textPrior(uniq, { levels, container, shape, baseUrl });

        let score = uniq.length * prior.pre * (0.55 + 0.45 * prefix);
        if (navPenalty) score *= 1 - Math.min(0.9, navish); // a menu is mostly nav words
        // Pagination rows also look like "same-shaped links with numbers", so
        // check the whole ancestor path, not just the grouping container.
        if (PAGINATION_CLASS.test(shape) || PAGINATION_CLASS.test(classId(container))) {
          score *= 0.15;
        }
        score *= prior.post;

        if (!best || score > best.score) {
          best = { entries: uniq, container, levels, score, stats: prior.stats || {} };
        }
      }
    }
  }

  return best;
}

/**
 * Find the largest group of same-shaped links whose text looks chapter-ish.
 * Thin wrapper over `findLinkCluster` with the chapter prior.
 *
 * @returns {{links:Array<{href,text,num,node}>,container,score,confidence}|null}
 */
export function findTocCluster(root, baseUrl, opts = {}) {
  const best = findLinkCluster(root, baseUrl, { minLinks: opts.minLinks, textPrior: tocPrior });
  if (!best) return null;

  const links = best.entries.map((e) => ({
    href: e.href,
    text: e.text,
    num: parseChapterNum(e.text, e.href),
    node: e.node,
  }));

  const { chapterish, numbered } = best.stats;
  let confidence = 'low';
  if (links.length >= 5 && chapterish >= 0.6 && numbered >= 0.6) confidence = 'high';
  else if (links.length >= 3 && (chapterish >= 0.3 || numbered >= 0.5)) confidence = 'medium';

  return { links, container: best.container, score: best.score, confidence };
}

/**
 * Find the group of same-shaped links most likely to be a series listing
 * (a browse/catalogue page). Thin wrapper over `findLinkCluster` with the
 * listing prior. Covers come from the first usable `<img>` in each link's
 * card (lazy-load attributes resolved by blocks.js `imageSrc`); titles from
 * the link text, trimmed and length-capped.
 *
 * @returns {{items:Array<{title,url,cover}>,container,score,confidence}|null}
 */
export function findListingCluster(root, baseUrl, opts = {}) {
  const imgMemo = new Map();
  const best = findLinkCluster(root, baseUrl, {
    minLinks: opts.minLinks,
    textPrior: (uniq, info) => listingPrior(uniq, info, imgMemo),
  });
  if (!best) return null;

  const cards = cardsFor(best.entries, best.container);
  const items = [];
  best.entries.forEach((e, i) => {
    const title = e.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) return; // a listing item without a name is unusable
    items.push({ title, url: e.href, cover: cardCover(cards[i], baseUrl) });
  });
  if (!items.length) return null;

  const coverish = best.stats.coverish || 0;
  let confidence = 'low';
  if (items.length >= 8 && coverish >= 0.5) confidence = 'high';
  else if (items.length >= 4) confidence = 'medium';

  return { items, container: best.container, score: best.score, confidence };
}

/** First usable image URL inside the entry's card, absolutized; '' when none. */
function cardCover(card, baseUrl) {
  for (const img of findAll(card, (n) => n.tag === 'img' || n.tag === 'image')) {
    const src = absolutize(imageSrc(img), baseUrl);
    if (src) return src;
  }
  return '';
}

/** Small local text getter that avoids importing getText's options everywhere. */
function textOf(node) {
  const parts = [];
  (function rec(n) {
    if (!n) return;
    if (n.type === 'text') {
      parts.push(decodeEntities(n.raw).replace(/\s+/g, ' '));
      return;
    }
    if (!isElement(n) || SKIP_TEXT.has(n.tag)) return;
    for (const c of n.children) rec(c);
  })(node);
  return parts.join('').replace(/\s+/g, ' ');
}

/** `<link rel=next>` / `<a rel=next>` / a "Next »" link — for capped pagination. */
export function findNextLink(root, baseUrl, currentUrl) {
  const cur = absolutize(currentUrl || '', baseUrl);
  const consider = (href) => {
    const abs = absolutize(href, baseUrl);
    if (!abs || abs === cur) return null;
    return abs;
  };
  for (const el of findAll(root, (n) => n.tag === 'link' || n.tag === 'a')) {
    const rel = (attr(el, 'rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('next')) {
      const hit = consider(attr(el, 'href'));
      if (hit) return hit;
    }
  }
  for (const a of byTag(root, 'a')) {
    const t = textOf(a).trim();
    if (!/^(next|next\s*(page|chapter)?|»|›|>>|older)\s*$/i.test(t)) continue;
    const hit = consider(attr(a, 'href'));
    if (hit) return hit;
  }
  return null;
}

// ── 3. Image run ─────────────────────────────────────────────────────────────

/** URL shapes that are chrome, not page art. */
const BAD_IMAGE_URL =
  /(^|[\W_])(logo|icon|avatar|banner|ads?|advert|sprite|placeholder|loading|lazy|blank|spacer|button|btn|profile|emoji|flag|badge|star|rating|share|social|favicon|pixel|1x1|donate|patreon|discord|thumb|thumbnail|cover|poster|header|footer|watermark)([\W_]|$)/i;

const BAD_IMAGE_EXT = /\.(svg|ico)(\?|$)/i;

/** Containers that never hold the page images. */
const CHROME_TAGS = new Set(['header', 'footer', 'nav', 'aside']);

function isChromeImage(img, src) {
  if (BAD_IMAGE_EXT.test(src)) return true;
  let path = src;
  try {
    path = new URL(src).pathname;
  } catch {
    /* keep raw */
  }
  if (BAD_IMAGE_URL.test(path)) return true;
  if (BAD_IMAGE_URL.test(classId(img))) return true;
  if (BAD_IMAGE_URL.test(attr(img, 'alt'))) return true;

  // Dimension attributes, when present and small, are a reliable icon signal.
  const w = Number(attr(img, 'width'));
  const h = Number(attr(img, 'height'));
  if (Number.isFinite(w) && w > 0 && w < 200) return true;
  if (Number.isFinite(h) && h > 0 && h < 200) return true;

  for (let p = img.parent; p; p = p.parent) {
    if (isElement(p) && CHROME_TAGS.has(p.tag)) return true;
  }
  return false;
}

/** Trailing integer in a filename — manga pages are almost always numbered. */
function trailingNum(src) {
  let path = src;
  try {
    path = new URL(src).pathname;
  } catch {
    /* keep raw */
  }
  const m = /(\d{1,4})(?:\.[a-z0-9]+)?$/i.exec(path);
  return m ? Number(m[1]) : null;
}

/** How much of a list looks like a monotonically increasing page sequence. */
function sequentialRatio(srcs) {
  const nums = srcs.map(trailingNum);
  let ok = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== null && nums[i - 1] !== null && nums[i] > nums[i - 1]) ok++;
  }
  return nums.length > 1 ? ok / (nums.length - 1) : 0;
}

/**
 * "Largest run of sequential images in one container."
 *
 * Same multi-depth grouping trick as the TOC finder, because readers are split
 * between `<div id=reader><img>…` (flat) and `<div id=reader><div><img></div>…`
 * (one wrapper per page).
 *
 * @returns {{urls:string[],container,confidence,sequential:number}|null}
 */
export function findImageRun(root, baseUrl, opts = {}) {
  const minImages = opts.minImages || 2;
  const imgs = findAll(root, (n) => n.tag === 'img' || n.tag === 'image');
  if (!imgs.length) return null;

  const kept = [];
  for (const img of imgs) {
    const src = absolutize(imageSrc(img), baseUrl);
    if (!src || /^data:/i.test(src)) continue;
    if (isChromeImage(img, src)) continue;
    kept.push({ node: img, src });
  }
  if (kept.length < minImages) return null;

  let best = null;
  for (const levels of [1, 2, 3]) {
    const groups = new Map();
    for (const it of kept) {
      const container = ancestorAt(it.node, levels);
      const arr = groups.get(container) || [];
      arr.push(it);
      groups.set(container, arr);
    }
    for (const [container, entries] of groups) {
      const seen = new Set();
      const uniq = [];
      for (const e of entries) {
        if (seen.has(e.src)) continue;
        seen.add(e.src);
        uniq.push(e);
      }
      if (uniq.length < minImages) continue;
      const srcs = uniq.map((e) => e.src);
      const seq = sequentialRatio(srcs);
      // Count dominates (it *is* "largest run"); sequence numbering breaks ties.
      const score = uniq.length * (1 + 0.5 * seq);
      if (!best || score > best.score) best = { container, srcs, seq, score };
    }
  }
  if (!best) return null;

  let confidence = 'low';
  if (best.srcs.length >= 5 && best.seq >= 0.7) confidence = 'high';
  else if (best.srcs.length >= 3) confidence = 'medium';

  return {
    urls: best.srcs,
    container: best.container,
    sequential: best.seq,
    confidence,
  };
}

// ── Misc ─────────────────────────────────────────────────────────────────────

/**
 * Stable, dependency-free id hash (FNV-1a 32-bit + length salt). Used to derive
 * `user:<hash>` series ids from a source URL so re-importing the same link
 * resumes the same progress row (ARCHITECTURE.md §3).
 */
export function hashId(input) {
  const s = String(input || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0') + (s.length % 4096).toString(16);
}

/** Lowest of three confidences. */
export function worstConfidence(...vals) {
  const rank = { high: 3, medium: 2, low: 1 };
  let worst = 'high';
  for (const v of vals) {
    if (!v) continue;
    if ((rank[v] || 1) < (rank[worst] || 3)) worst = v;
  }
  return worst;
}

/** First heading inside a container, for chapter titles. */
export function headingText(root) {
  for (const h of findAll(root, (n) => /^h[1-3]$/.test(n.tag))) {
    const t = textOf(h).trim();
    if (t && t.length <= 200) return t;
  }
  return '';
}

export { textOf };
