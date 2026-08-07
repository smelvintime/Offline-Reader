// Block normalization — the XSS boundary (§1.3). Typed blocks only, never HTML.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseHtml, findFirst, getText, classId } from '../src/lib/html.js';
import {
  blocksFromNode,
  sanitizeBlocks,
  countWords,
  countChars,
  imageSrc,
  ALLOWED_BLOCK_TYPES,
  BLOCK_LIMITS,
} from '../src/lib/blocks.js';
import { fixture } from './helpers.js';

const BASE = 'https://wandering-ink.test/salt-road/chapter-12';

function parseFragment(html) {
  const root = parseHtml(html);
  return findFirst(root, (n) => n.tag === 'div') || root;
}

describe('sanitizeBlocks — vocabulary enforcement', () => {
  test('unknown types degrade to p, never dropped silently', () => {
    const out = sanitizeBlocks([
      { t: 'script', c: 'alert(1)' },
      { t: 'h1', c: 'Big' },
      { t: 'marquee', c: 'hello' },
    ]);
    assert.equal(out.length, 3);
    for (const b of out) assert.equal(b.t, 'p');
    assert.equal(out[0].c, 'alert(1)'); // kept as inert TEXT, not markup
  });

  test('every emitted type is in the allowed set', () => {
    const out = sanitizeBlocks([
      { t: 'p', c: 'a' }, { t: 'h2', c: 'b' }, { t: 'h3', c: 'c' }, { t: 'h4', c: 'd' },
      { t: 'blockquote', c: 'e' }, { t: 'pre', c: 'f' }, { t: 'note', c: 'g' },
      { t: 'ul', items: ['x'] }, { t: 'ol', items: ['y'] },
      { t: 'img', src: 'https://e.test/a.png' },
    ]);
    for (const b of out) assert.ok(ALLOWED_BLOCK_TYPES.has(b.t), `${b.t} not allowed`);
  });

  test('no block ever carries raw HTML through', () => {
    const out = sanitizeBlocks([{ t: 'p', c: '<img src=x onerror=alert(1)>' }]);
    // The string survives as text; it is the renderer's textContent that makes
    // it inert. What matters is that we never emit an `html` field.
    assert.equal(out.length, 1);
    assert.deepEqual(Object.keys(out[0]).sort(), ['c', 't']);
  });

  test('img blocks require an absolute http(s) src', () => {
    const out = sanitizeBlocks([
      { t: 'img', src: 'javascript:alert(1)' },
      { t: 'img', src: 'data:image/png;base64,AAA' },
      { t: 'img', src: '/relative.png' },
      { t: 'img', src: 'https://ok.test/a.png', alt: 'fine' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].src, 'https://ok.test/a.png');
    assert.equal(out[0].alt, 'fine');
  });

  test('consecutive and edge hr blocks are collapsed', () => {
    const out = sanitizeBlocks([
      { t: 'hr' }, { t: 'hr' }, { t: 'p', c: 'mid' }, { t: 'hr' }, { t: 'hr' },
    ]);
    assert.deepEqual(out, [{ t: 'p', c: 'mid' }]);
  });

  test('empty and whitespace-only blocks are dropped', () => {
    const out = sanitizeBlocks([
      { t: 'p', c: '   ' }, { t: 'p', c: '' }, { t: 'p', c: null },
      { t: 'ul', items: [] }, null, 'nonsense', { t: 'p', c: 'real' },
    ]);
    assert.deepEqual(out, [{ t: 'p', c: 'real' }]);
  });

  test('zero-width and control characters are stripped', () => {
    const dirty = 'He​llo﻿ world';
    const out = sanitizeBlocks([{ t: 'p', c: dirty }]);
    assert.equal(out[0].c, 'Hello world');
  });

  test('per-block and list-item caps are enforced', () => {
    const out = sanitizeBlocks([
      { t: 'p', c: 'x'.repeat(BLOCK_LIMITS.maxCharsPerBlock + 500) },
      { t: 'ul', items: new Array(BLOCK_LIMITS.maxItems + 50).fill('i') },
    ]);
    assert.equal(out[0].c.length, BLOCK_LIMITS.maxCharsPerBlock);
    assert.equal(out[1].items.length, BLOCK_LIMITS.maxItems);
  });
});

describe('blocksFromNode — real markup', () => {
  test('a source-wrapped <p> stays ONE paragraph', () => {
    // Regression: pretty-printed HTML must not shred into one block per line.
    const node = parseFragment(
      '<div><p>The flats began where the last of the olive trees\n' +
        '   gave up, and Kestrel walked into them at the hour\n' +
        '   when the light goes flat.</p></div>',
    );
    const blocks = blocksFromNode(node, BASE);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].t, 'p');
    assert.ok(!blocks[0].c.includes('\n'), 'paragraph must not contain newlines');
    assert.match(blocks[0].c, /olive trees gave up/);
  });

  test('<br>-separated lines DO become separate paragraphs', () => {
    const node = parseFragment('<div><div>first line here<br>second line here</div></div>');
    const blocks = blocksFromNode(node, BASE);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].c, 'first line here');
    assert.equal(blocks[1].c, 'second line here');
  });

  test('headings, hr, lists and blockquote map to their block types', () => {
    const node = parseFragment(
      '<div>' +
        '<h1>Title</h1><h3>Sub</h3><h6>Deep</h6>' +
        '<hr>' +
        '<blockquote>Nothing crosses twice.</blockquote>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<ol><li>alpha</li></ol>' +
        '</div>',
    );
    const blocks = blocksFromNode(node, BASE);
    const types = blocks.map((b) => b.t);
    assert.deepEqual(types, ['h2', 'h3', 'h4', 'hr', 'blockquote', 'ul', 'ol']);
    assert.deepEqual(blocks[5].items, ['one', 'two']);
  });

  test('scripts, styles and nav are never emitted', () => {
    const node = parseFragment(
      '<div>' +
        '<script>alert("pwned")</script>' +
        '<style>body{color:red}</style>' +
        '<nav><a href="/">Home</a></nav>' +
        '<div class="adsbygoogle">buy things</div>' +
        '<p>Actual prose that should survive the cull entirely.</p>' +
        '</div>',
    );
    const blocks = blocksFromNode(node, BASE);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0].c, /Actual prose/);
    const all = JSON.stringify(blocks);
    assert.ok(!all.includes('pwned'));
    assert.ok(!all.includes('color:red'));
    assert.ok(!all.includes('buy things'));
  });

  test('relative image srcs are absolutized against the chapter URL', () => {
    const node = parseFragment('<div><img src="/uploads/a.jpg" alt="pic"></div>');
    const blocks = blocksFromNode(node, BASE);
    assert.equal(blocks[0].t, 'img');
    assert.equal(blocks[0].src, 'https://wandering-ink.test/uploads/a.jpg');
  });

  test('translator notes are typed as note', () => {
    const node = parseFragment("<div><p>Translator's note: this is an idiom.</p></div>");
    const blocks = blocksFromNode(node, BASE);
    assert.equal(blocks[0].t, 'note');
  });
});

describe('blocksFromNode — novel-chapter fixture', () => {
  const root = parseHtml(fixture('novel-chapter.html'));
  const content = findFirst(root, (n) => /entry-content/.test(classId(n)));
  const blocks = blocksFromNode(content, BASE);

  test('finds the content container', () => {
    assert.ok(content, 'entry-content should exist in the fixture');
  });

  test('produces a sensible mix of typed blocks', () => {
    const types = new Set(blocks.map((b) => b.t));
    assert.ok(types.has('p'), 'expected paragraphs');
    assert.ok(types.has('h2'), 'expected the "II" heading');
    assert.ok(types.has('hr'), 'expected the scene break');
    assert.ok(types.has('blockquote'), 'expected the epigraph');
    assert.ok(types.has('img'), 'expected the illustration');
    assert.ok(types.has('note'), 'expected the translator note / caption');
  });

  test('paragraphs are whole, not per-source-line fragments', () => {
    const paras = blocks.filter((b) => b.t === 'p');
    assert.ok(paras.length >= 7, `expected >=7 paragraphs, got ${paras.length}`);
    // Every real paragraph in this fixture is a full sentence or more.
    const tiny = paras.filter((p) => p.c.length < 60);
    assert.equal(tiny.length, 0, `unexpectedly short paragraphs: ${JSON.stringify(tiny)}`);
    assert.match(paras[0].c, /The flats began where the last of the olive trees gave up/);
  });

  test('the illustration keeps an absolute src', () => {
    const img = blocks.find((b) => b.t === 'img');
    assert.equal(img.src, 'https://wandering-ink.test/wp-content/uploads/2026/03/salt-flats-illustration.jpg');
  });

  test('no comment, sidebar or share text leaks in', () => {
    const all = JSON.stringify(blocks);
    assert.ok(!all.includes('goes so hard'));
    assert.ok(!all.includes('Share on Twitter'));
    assert.ok(!all.includes('Recent chapters'));
  });

  test('every block validates against the §1.3 vocabulary', () => {
    for (const b of blocks) {
      assert.ok(ALLOWED_BLOCK_TYPES.has(b.t), `bad type ${b.t}`);
      if (b.t === 'hr') continue;
      if (b.t === 'img') assert.match(b.src, /^https?:\/\//);
      else if (b.t === 'ul' || b.t === 'ol') assert.ok(Array.isArray(b.items));
      else assert.equal(typeof b.c, 'string');
    }
  });
});

describe('counting helpers', () => {
  test('countWords handles latin prose', () => {
    assert.equal(countWords([{ t: 'p', c: 'one two three four' }]), 4);
  });

  test('countWords counts CJK by character', () => {
    assert.equal(countWords([{ t: 'p', c: '日本語' }]), 3);
  });

  test('countWords includes list items', () => {
    assert.equal(countWords([{ t: 'ul', items: ['a b', 'c'] }]), 3);
  });

  test('countChars sums prose length', () => {
    assert.equal(countChars([{ t: 'p', c: 'abc' }, { t: 'p', c: 'de' }]), 5);
  });
});

describe('imageSrc — lazy-loading attributes', () => {
  test('prefers data-src over a placeholder src', () => {
    const node = parseFragment(
      '<div><img src="data:image/gif;base64,AAA" data-src="https://cdn.test/real.webp"></div>',
    );
    const img = findFirst(node, (n) => n.tag === 'img');
    assert.equal(imageSrc(img), 'https://cdn.test/real.webp');
  });

  test('falls back to the largest srcset candidate', () => {
    const node = parseFragment(
      '<div><img srcset="https://cdn.test/s.webp 480w, https://cdn.test/l.webp 1200w"></div>',
    );
    const img = findFirst(node, (n) => n.tag === 'img');
    assert.equal(imageSrc(img), 'https://cdn.test/l.webp');
  });

  test('getText decodes entities', () => {
    const node = parseFragment('<div><p>caf&eacute; &amp; cr&egrave;me &#8212; ok</p></div>');
    assert.equal(getText(node, { breaks: true }), 'café & crème — ok');
  });
});
