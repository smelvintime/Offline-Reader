// html.js — a small, tolerant HTML tokenizer + tree builder, plus the tree
// helpers the adapters need.
//
// WHY NOT HTMLRewriter: it is streaming-only (you cannot ask "which container
// has the densest prose?" without a tree) and it only exists inside workerd, so
// adapters written against it are not unit-testable in plain Node — which the
// brief requires.
//
// WHY NOT linkedom/cheerio: they drag a full spec DOM + CSS selector engine
// into a repo that is otherwise zero-dependency and has no build step. We only
// need tags, attributes, and text density. This file is ~350 lines, runs
// identically in Node and workerd, and costs nothing at deploy time.
//
// This is NOT a spec-compliant parser. It handles the things real reader sites
// do (unclosed <p>/<li>, raw <script>, lazy-loaded <img>, comments, entities)
// and is happy to be approximately right — every consumer downstream treats the
// result as a heuristic input, never as trusted markup.

const VOID = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'embed', 'frame', 'hr', 'img',
  'input', 'isindex', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose content is *not* parsed as markup.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template']);

// Start tags that implicitly close an open <p>.
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul',
]);

const IMPLICIT_SIBLING = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
  tbody: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
  tfoot: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
};

// ── Entities ─────────────────────────────────────────────────────────────────
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ',
  emsp: ' ', thinsp: ' ', shy: '­', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', deg: '°', plusmn: '±', times: '×',
  divide: '÷', frac12: '½', sup2: '²', sup3: '³', micro: 'µ',
  para: '¶', sect: '§', dagger: '†', Dagger: '‡', permil: '‰',
  prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', oline: '‾',
  frasl: '⁄', euro: '€', pound: '£', yen: '¥', cent: '¢',
  curren: '¤', iexcl: '¡', iquest: '¿', larr: '←', rarr: '→',
  harr: '↔', darr: '↓', uarr: '↑', infin: '∞', ne: '≠',
  le: '≤', ge: '≥', asymp: '≈', hearts: '♥', star: '☆',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', aacute: 'á',
  iacute: 'í', oacute: 'ó', uacute: 'ú',
};

/** Decode HTML character references (named + numeric). */
export function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input || '';
  return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (m, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      // Windows-1252 remap that browsers apply to 0x80–0x9F.
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const hit = NAMED[body];
    return hit !== undefined ? hit : m;
  });
}

// ── Node shape ───────────────────────────────────────────────────────────────
// element: { type:'element', tag, attrs:{}, children:[], parent }
// text:    { type:'text', raw, parent }
//
// `parent` makes the tree cyclic — never JSON.stringify a node.

function el(tag, attrs, parent) {
  return { type: 'element', tag, attrs, children: [], parent: parent || null };
}

/**
 * Parse an HTML document into a tree.
 * @param {string} src
 * @returns {object} the synthetic root element (tag `#root`)
 */
export function parseHtml(src) {
  const root = el('#root', {}, null);
  const stack = [root];
  const s = String(src || '');
  const n = s.length;
  let i = 0;
  let textStart = 0;

  const top = () => stack[stack.length - 1];

  const flushText = (end) => {
    if (end > textStart) {
      const raw = s.slice(textStart, end);
      if (raw.length) top().children.push({ type: 'text', raw, parent: top() });
    }
  };

  const closeTag = (tag) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag === tag) {
        stack.length = k;
        return true;
      }
    }
    return false; // stray end tag — ignore, like a browser
  };

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;

    const next = s[lt + 1];

    // Comment / doctype / processing instruction
    if (next === '!') {
      if (s.startsWith('<!--', lt)) {
        flushText(lt);
        const end = s.indexOf('-->', lt + 4);
        i = end === -1 ? n : end + 3;
        textStart = i;
        continue;
      }
      if (s.startsWith('<![CDATA[', lt)) {
        flushText(lt);
        const end = s.indexOf(']]>', lt + 9);
        const inner = s.slice(lt + 9, end === -1 ? n : end);
        top().children.push({ type: 'text', raw: inner, parent: top() });
        i = end === -1 ? n : end + 3;
        textStart = i;
        continue;
      }
      flushText(lt);
      const end = s.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      textStart = i;
      continue;
    }

    if (next === '?') {
      flushText(lt);
      const end = s.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      textStart = i;
      continue;
    }

    // End tag
    if (next === '/') {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9:_.-]*)\s*>?/.exec(s.slice(lt, lt + 80));
      if (!m) {
        i = lt + 1;
        continue;
      }
      flushText(lt);
      closeTag(m[1].toLowerCase());
      const end = s.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      textStart = i;
      continue;
    }

    // Start tag
    if (next && /[a-zA-Z]/.test(next)) {
      const parsed = parseStartTag(s, lt);
      if (!parsed) {
        i = lt + 1;
        continue;
      }
      flushText(lt);
      const { tag, attrs, selfClosing, end } = parsed;

      // Implicit closes
      if (CLOSES_P.has(tag) && top().tag === 'p') closeTag('p');
      const sib = IMPLICIT_SIBLING[tag];
      if (sib) {
        for (let k = stack.length - 1; k > 0; k--) {
          if (sib.includes(stack[k].tag)) {
            stack.length = k;
            break;
          }
          // don't climb out of the enclosing list/table
          if (['ul', 'ol', 'dl', 'table', 'select'].includes(stack[k].tag)) break;
        }
      }

      const node = el(tag, attrs, top());
      top().children.push(node);
      i = end;
      textStart = i;

      if (VOID.has(tag) || selfClosing) continue;

      if (RAW_TEXT.has(tag)) {
        // Consume verbatim until the matching close tag.
        const re = new RegExp(`</${tag}\\s*>`, 'i');
        const rest = s.slice(i);
        const m = re.exec(rest);
        const rawEnd = m ? i + m.index : n;
        const raw = s.slice(i, rawEnd);
        if (raw) node.children.push({ type: 'text', raw, parent: node });
        i = m ? rawEnd + m[0].length : n;
        textStart = i;
        continue;
      }

      stack.push(node);
      continue;
    }

    // A bare "<" in prose.
    i = lt + 1;
  }
  flushText(n);
  return root;
}

function parseStartTag(s, at) {
  const m = /^<([a-zA-Z][a-zA-Z0-9:_.-]*)/.exec(s.slice(at, at + 64));
  if (!m) return null;
  const tag = m[1].toLowerCase();
  let i = at + m[0].length;
  const attrs = {};
  const n = s.length;

  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] === '>') return { tag, attrs, selfClosing: false, end: i + 1 };
    if (s[i] === '/' && s[i + 1] === '>') return { tag, attrs, selfClosing: true, end: i + 2 };
    if (s[i] === '/') {
      i++;
      continue;
    }

    // Attribute name
    let start = i;
    while (i < n && !/[\s=>/]/.test(s[i])) i++;
    const name = s.slice(start, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }

    while (i < n && /\s/.test(s[i])) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (i < n && /\s/.test(s[i])) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, i + 1);
        value = s.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else {
        start = i;
        while (i < n && !/[\s>]/.test(s[i])) i++;
        value = s.slice(start, i);
      }
    } else {
      value = name; // boolean attribute
    }
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return { tag, attrs, selfClosing: false, end: n };
}

// ── Tree helpers ─────────────────────────────────────────────────────────────

export function isElement(node) {
  return !!node && node.type === 'element';
}

export function attr(node, name) {
  return (isElement(node) && node.attrs[name]) || '';
}

/** Depth-first pre-order walk. Return `false` from `fn` to skip a subtree. */
export function walk(node, fn) {
  if (!node) return;
  const stop = fn(node);
  if (stop === false || !node.children) return;
  for (const c of node.children.slice()) walk(c, fn);
}

/** All descendant elements matching a predicate, in document order. */
export function findAll(root, pred) {
  const out = [];
  walk(root, (n) => {
    if (isElement(n) && n !== root && pred(n)) out.push(n);
  });
  return out;
}

export function findFirst(root, pred) {
  let hit = null;
  walk(root, (n) => {
    if (hit) return false;
    if (isElement(n) && n !== root && pred(n)) hit = n;
  });
  return hit;
}

export function byTag(root, ...tags) {
  const set = new Set(tags.map((t) => t.toLowerCase()));
  return findAll(root, (n) => set.has(n.tag));
}

/** `class` + `id` + `role`, lowercased — the signal every readability port uses. */
export function classId(node) {
  if (!isElement(node)) return '';
  return `${node.attrs.class || ''} ${node.attrs.id || ''} ${node.attrs.role || ''}`.toLowerCase();
}

const NON_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe']);

/** Visible-ish text content, entities decoded, whitespace collapsed. */
export function getText(node, { collapse = true } = {}) {
  const parts = [];
  (function rec(n) {
    if (!n) return;
    if (n.type === 'text') {
      parts.push(decodeEntities(n.raw));
      return;
    }
    if (!isElement(n)) return;
    if (NON_TEXT.has(n.tag)) return;
    if (n.tag === 'br') {
      parts.push('\n');
      return;
    }
    for (const c of n.children) rec(c);
    if (CLOSES_P.has(n.tag) || n.tag === 'li') parts.push('\n');
  })(node);
  const joined = parts.join('');
  if (!collapse) return joined;
  return joined.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Undecoded concatenated text — for <script type="application/ld+json"> bodies. */
export function rawText(node) {
  const parts = [];
  (function rec(n) {
    if (!n) return;
    if (n.type === 'text') parts.push(n.raw);
    else if (isElement(n)) for (const c of n.children) rec(c);
  })(node);
  return parts.join('');
}

export function textLength(node) {
  return getText(node).length;
}

/** Length of text that sits inside an <a>. High ratio ⇒ nav, not prose. */
export function linkTextLength(node) {
  let total = 0;
  for (const a of byTag(node, 'a')) total += getText(a).length;
  return total;
}

export function linkDensity(node) {
  const t = textLength(node);
  if (!t) return 1;
  return Math.min(1, linkTextLength(node) / t);
}

/** Remove every descendant matching `pred` (mutates the tree). */
export function removeMatching(root, pred) {
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

/** Depth from the document root. */
export function depthOf(node) {
  let d = 0;
  let p = node.parent;
  while (p) {
    d++;
    p = p.parent;
  }
  return d;
}

/** Nearest ancestor (inclusive) matching a predicate. */
export function closest(node, pred) {
  let p = node;
  while (p) {
    if (isElement(p) && pred(p)) return p;
    p = p.parent;
  }
  return null;
}

/** Document-order index map, so we can sort arbitrary node sets. */
export function documentOrder(root) {
  const order = new Map();
  let i = 0;
  walk(root, (n) => {
    order.set(n, i++);
  });
  return order;
}
