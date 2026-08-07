// blocks.js — DOM subtree → Block[] (ARCHITECTURE.md §1.3).
//
// This is the XSS boundary. Nothing that comes out of here is markup: every
// block carries plain strings that the reader sets with `textContent`. There is
// no HTML passthrough, ever — not even "safe" tags.
//
// Allowed t values: p h2 h3 h4 hr blockquote pre ul ol img note

import { getText, isElement, attr, classId } from './html.js';
import { absolutize } from './meta.js';

export const ALLOWED_BLOCK_TYPES = new Set([
  'p', 'h2', 'h3', 'h4', 'hr', 'blockquote', 'pre', 'ul', 'ol', 'img', 'note',
]);

/** Hard caps so one hostile/huge page cannot blow up a client. */
export const BLOCK_LIMITS = {
  maxBlocks: 4000,
  maxCharsPerBlock: 20000,
  maxTotalChars: 900_000,
  maxItems: 200,
};

// Structural chrome that is never prose.
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg',
  'canvas', 'form', 'input', 'button', 'select', 'textarea', 'label', 'nav',
  'header', 'footer', 'aside', 'audio', 'video', 'map', 'ins', 'link', 'meta',
]);

// class/id substrings that mark non-prose furniture.
const DROP_PATTERN =
  /(^|[\s_-])(ad|ads|adsbygoogle|advert|banner|sponsor|promo|popup|modal|share|social|related|recommend|comment|disqus|respond|nav|navigation|menu|breadcrumb|pagination|paging|pager|sidebar|widget|footer|header|toolbar|subscribe|newsletter|donate|patreon|rating|vote|tags?|meta|byline|author-box|toc|table-of-contents|cookie|consent|skip-link|screen-reader|sr-only|hidden|visually-hidden)([\s_-]|$)/i;

const NOTE_PATTERN =
  /^\s*(translator'?s? note|tl note|t\/n|author'?s? note|a\/n|editor'?s? note|note from)/i;

/** Should this element be pruned before scoring/extraction? */
export function isJunkElement(node) {
  if (!isElement(node)) return false;
  if (DROP_TAGS.has(node.tag)) return true;
  const ci = classId(node);
  if (ci && DROP_PATTERN.test(ci)) return true;
  const style = (node.attrs.style || '').toLowerCase();
  if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) return true;
  if ('hidden' in node.attrs) return true;
  if ((node.attrs['aria-hidden'] || '') === 'true') return true;
  return false;
}

const HEADING_MAP = { h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4' };

function pushText(out, t, text, extra) {
  const c = String(text || '')
    .replace(/[ \t\u00a0\u200b\ufeff]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  if (!c) return;
  out.push({ t, c: c.slice(0, BLOCK_LIMITS.maxCharsPerBlock), ...(extra || {}) });
}

/**
 * Convert a container element into Block[].
 *
 * @param {object} container parsed element
 * @param {string} baseUrl   for absolutizing <img src>
 * @param {{keepImages?: boolean}} [opts]
 * @returns {Array<object>} Block[]
 */
export function blocksFromNode(container, baseUrl, opts = {}) {
  const keepImages = opts.keepImages !== false;
  const out = [];

  const emitParagraphs = (raw) => {
    // A <div> full of <br>s is one visual paragraph per line.
    for (const part of String(raw).split(/\n{1,}/)) {
      if (out.length >= BLOCK_LIMITS.maxBlocks) return;
      const trimmed = part.trim();
      if (!trimmed) continue;
      pushText(out, NOTE_PATTERN.test(trimmed) ? 'note' : 'p', trimmed);
    }
  };

  const visit = (node) => {
    if (out.length >= BLOCK_LIMITS.maxBlocks) return;

    if (node.type === 'text') {
      // Loose text directly inside the container.
      const t = getText(node, { collapse: false });
      if (t && t.trim()) emitParagraphs(t);
      return;
    }
    if (!isElement(node)) return;
    if (isJunkElement(node)) return;

    const tag = node.tag;

    if (tag === 'hr') {
      if (out.length && out[out.length - 1].t !== 'hr') out.push({ t: 'hr' });
      return;
    }

    if (HEADING_MAP[tag]) {
      pushText(out, HEADING_MAP[tag], getText(node));
      return;
    }

    if (tag === 'blockquote') {
      pushText(out, 'blockquote', getText(node, { collapse: false }));
      return;
    }

    if (tag === 'pre') {
      const c = getText(node, { collapse: false }).replace(/^\n+|\n+$/g, '');
      if (c.trim()) out.push({ t: 'pre', c: c.slice(0, BLOCK_LIMITS.maxCharsPerBlock) });
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = [];
      for (const li of node.children) {
        if (!isElement(li) || li.tag !== 'li' || isJunkElement(li)) continue;
        const c = getText(li).replace(/\s+/g, ' ').trim();
        if (c) items.push(c.slice(0, 2000));
        if (items.length >= BLOCK_LIMITS.maxItems) break;
      }
      if (items.length) out.push({ t: tag, items });
      return;
    }

    if (tag === 'img' || tag === 'image') {
      if (!keepImages) return;
      const src = absolutize(imageSrc(node), baseUrl);
      if (!src) return;
      out.push({ t: 'img', src, alt: (attr(node, 'alt') || '').slice(0, 300) });
      return;
    }

    if (tag === 'figure') {
      for (const c of node.children) visit(c);
      return;
    }

    if (tag === 'figcaption') {
      pushText(out, 'note', getText(node));
      return;
    }

    if (tag === 'br') return; // handled by the collapse in getText

    if (tag === 'table') {
      // Tables are not part of the block vocabulary; flatten rows to paragraphs.
      const text = getText(node, { collapse: false });
      emitParagraphs(text);
      return;
    }

    if (tag === 'p') {
      // A <p> can still contain an inline <img> (illustration + caption).
      const imgs = keepImages ? node.children.filter((c) => isElement(c) && c.tag === 'img') : [];
      const text = getText(node, { collapse: false });
      if (text.trim()) emitParagraphs(text);
      for (const im of imgs) visit(im);
      return;
    }

    // Container-ish element: recurse if it holds block children, otherwise treat
    // its text as one paragraph.
    const hasBlockChild = node.children.some(
      (c) =>
        isElement(c) &&
        ['p', 'div', 'section', 'article', 'ul', 'ol', 'blockquote', 'pre', 'figure', 'table',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'center'].includes(c.tag),
    );
    if (hasBlockChild) {
      for (const c of node.children) visit(c);
    } else {
      const text = getText(node, { collapse: false });
      if (text.trim()) emitParagraphs(text);
      if (keepImages) {
        for (const c of node.children) if (isElement(c) && c.tag === 'img') visit(c);
      }
    }
  };

  for (const c of container.children || []) visit(c);
  return sanitizeBlocks(out);
}

/** All the places lazy-loading libraries stash the real image URL. */
export function imageSrc(node) {
  const cands = [
    node.attrs['data-src'],
    node.attrs['data-lazy-src'],
    node.attrs['data-original'],
    node.attrs['data-url'],
    node.attrs['data-image'],
    node.attrs['data-echo'],
    node.attrs['data-cfsrc'],
    node.attrs.src,
  ];
  for (const c of cands) {
    if (c && !/^data:/i.test(c) && c.trim()) return c.trim();
  }
  const srcset = node.attrs.srcset || node.attrs['data-srcset'];
  if (srcset) {
    // Take the last (usually largest) candidate.
    const parts = srcset
      .split(',')
      .map((s) => s.trim().split(/\s+/)[0])
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return '';
}

/**
 * Final gate: enforce the §1.3 vocabulary, trim, drop empties, cap size.
 * Anything with an unknown `t` becomes a `p` — never dropped silently.
 */
export function sanitizeBlocks(blocks) {
  const out = [];
  let totalChars = 0;
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (out.length >= BLOCK_LIMITS.maxBlocks) break;

    let t = typeof b.t === 'string' ? b.t.toLowerCase() : 'p';
    if (!ALLOWED_BLOCK_TYPES.has(t)) t = 'p';

    if (t === 'hr') {
      if (out.length && out[out.length - 1].t !== 'hr') out.push({ t: 'hr' });
      continue;
    }
    if (t === 'img') {
      const src = typeof b.src === 'string' ? b.src.trim() : '';
      if (!/^https?:\/\//i.test(src)) continue;
      out.push({ t: 'img', src, ...(b.alt ? { alt: String(b.alt).slice(0, 300) } : {}) });
      continue;
    }
    if (t === 'ul' || t === 'ol') {
      const items = (Array.isArray(b.items) ? b.items : [])
        .map((i) => String(i == null ? '' : i).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, BLOCK_LIMITS.maxItems);
      if (!items.length) continue;
      totalChars += items.join(' ').length;
      out.push({ t, items });
      continue;
    }
    let c = typeof b.c === 'string' ? b.c : b.c == null ? '' : String(b.c);
    c = c.replace(/ /g, '').trim();
    if (!c) continue;
    if (c.length > BLOCK_LIMITS.maxCharsPerBlock) c = c.slice(0, BLOCK_LIMITS.maxCharsPerBlock);
    totalChars += c.length;
    if (totalChars > BLOCK_LIMITS.maxTotalChars) break;
    out.push({ t, c });
  }
  // Trailing/leading separators are noise.
  while (out.length && out[0].t === 'hr') out.shift();
  while (out.length && out[out.length - 1].t === 'hr') out.pop();
  return out;
}

/** Approximate word count over a Block[] — CJK counts characters. */
export function countWords(blocks) {
  let words = 0;
  for (const b of blocks || []) {
    const text = b.items ? b.items.join(' ') : b.c || '';
    if (!text) continue;
    const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
    const latin = text
      .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g, ' ')
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    words += cjk + latin;
  }
  return words;
}

/** Total prose characters — used for confidence scoring. */
export function countChars(blocks) {
  let n = 0;
  for (const b of blocks || []) n += (b.items ? b.items.join(' ') : b.c || '').length;
  return n;
}
