// Offline Reader — generated default covers. See docs/mobile/PLAN7.md §2.8.
//
// One pure function: a series id in, a complete cover out — an inline
// <svg> in the diamond logo's geometric language (rotated squares, thin
// rules, small dots, flat fills). Seven designs, one family; FNV-1a over the
// id picks the design and the hue, so a series keeps its cover forever and
// two ids almost never dress alike.
//
// Deliberately dependency-free and screenless: no Store, no registerScreen,
// no stylesheet — consumers size the returned <svg> in their own sheets
// (catalogue.css owns `.cat-cover-svg`, importer.css owns `.imp-cover-svg`).
// It loads before reader.js and every consumer guards `window.Covers`, so
// deleting this file simply brings the old gradient placeholders back
// (PLAN7 §0.5).
//
// The XSS boundary is trivially honored: everything is built with
// createElementNS and the only attribute values are numbers and enum
// strings computed here — zero content strings ever enter the SVG. There is
// deliberately no text inside a cover (titles and authors already render
// beside every card), which is also what keeps a cover ~1–2 KB of DOM.
//
// The dark-leaning palette is intended, not an oversight (PLAN7 §2.8): a
// generated cover is content artwork, like a real cover image — real covers
// do not repaint when the shell theme changes, and neither do these.

(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  // Canvas: 120 × 180 — the 2:3 cover ratio every card slot already assumes.
  const W = 120;
  const H = 180;

  // ── Hash → identity ───────────────────────────────────────────────────────

  // FNV-1a, 32-bit. Math.imul keeps the multiply in uint32 land.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function idOf(seriesOrId) {
    if (typeof seriesOrId === 'string') return seriesOrId;
    if (seriesOrId && typeof seriesOrId === 'object' && seriesOrId.id != null) {
      return String(seriesOrId.id);
    }
    return '';
  }

  // Self-contained per-cover palette (§2.8): bg, a quieter field, the figure
  // ink, and one hue-shifted accent. Unaffected by the app theme by design.
  function palette(h) {
    const hue = ((h >>> 3) % 12) * 30;
    return {
      bg:     'hsl(' + hue + ' 32% 15%)',
      field:  'hsl(' + hue + ' 28% 22%)',
      figure: 'hsl(' + hue + ' 45% 70%)',
      accent: 'hsl(' + ((hue + 40) % 360) + ' 50% 55%)',
    };
  }

  // ── SVG primitives ────────────────────────────────────────────────────────

  function node(svg, tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        n.setAttribute(k, String(attrs[k]));
      }
    }
    svg.appendChild(n);
    return n;
  }

  function rect(svg, x, y, w, h, fill, opacity) {
    const a = { x: x, y: y, width: w, height: h, fill: fill };
    if (opacity != null) a['fill-opacity'] = opacity;
    return node(svg, 'rect', a);
  }

  function dot(svg, cx, cy, r, fill, opacity) {
    const a = { cx: cx, cy: cy, r: r, fill: fill };
    if (opacity != null) a['fill-opacity'] = opacity;
    return node(svg, 'circle', a);
  }

  // A rotated square — the family's one letter. rx/ry give the tall, thin
  // and squat variants without ever leaving the diamond.
  function diamond(svg, cx, cy, rx, ry, fill, opacity) {
    const d = 'M' + cx + ' ' + (cy - ry) +
              ' L' + (cx + rx) + ' ' + cy +
              ' L' + cx + ' ' + (cy + ry) +
              ' L' + (cx - rx) + ' ' + cy + ' Z';
    const a = { d: d, fill: fill };
    if (opacity != null) a['fill-opacity'] = opacity;
    return node(svg, 'path', a);
  }

  function poly(svg, points, fill, opacity) {
    // points: flat [x0, y0, x1, y1, …] — numbers only.
    let d = 'M' + points[0] + ' ' + points[1];
    for (let i = 2; i < points.length; i += 2) {
      d += ' L' + points[i] + ' ' + points[i + 1];
    }
    d += ' Z';
    const a = { d: d, fill: fill };
    if (opacity != null) a['fill-opacity'] = opacity;
    return node(svg, 'path', a);
  }

  // Thin horizontal rule — drawn as a rect so everything stays a fill.
  function rule(svg, x, y, w, fill, opacity) {
    return rect(svg, x, y, w, 1.5, fill, opacity == null ? 0.5 : opacity);
  }

  // ── The seven designs ─────────────────────────────────────────────────────
  // Each takes (svg, P) with the bg already painted.

  // 1 · Sapling — one stem, three diamond leaves.
  function drawSapling(svg, P) {
    rule(svg, 18, 140, 84, P.figure);
    rect(svg, 59, 96, 2, 44, P.figure);
    diamond(svg, 60, 78, 14, 19, P.figure);
    diamond(svg, 44, 106, 8, 11, P.accent);
    diamond(svg, 76, 110, 8, 11, P.figure);
    dot(svg, 60, 152, 2, P.accent, 0.7);
  }

  // 2 · Orchard row — three diamond-crown trees on a ground rule.
  function drawOrchard(svg, P) {
    rule(svg, 10, 140, 100, P.figure);
    rect(svg, 31, 124, 2, 16, P.figure);
    rect(svg, 59, 120, 2, 20, P.figure);
    rect(svg, 87, 124, 2, 16, P.figure);
    diamond(svg, 32, 113, 9, 12, P.figure);
    diamond(svg, 60, 106, 11, 15, P.accent);
    diamond(svg, 88, 113, 9, 12, P.figure);
    dot(svg, 46, 152, 1.5, P.figure, 0.5);
    dot(svg, 74, 152, 1.5, P.figure, 0.5);
  }

  // 3 · Conifer — five stacked, tapering diamonds.
  function drawConifer(svg, P) {
    diamond(svg, 60, 40, 8, 12, P.accent);
    diamond(svg, 60, 66, 12, 15, P.figure);
    diamond(svg, 60, 94, 16, 18, P.figure);
    diamond(svg, 60, 122, 20, 20, P.figure);
    diamond(svg, 60, 150, 24, 21, P.field);
    rule(svg, 22, 172, 76, P.figure, 0.4);
  }

  // 4 · Fern — an arc of small diamonds along a curved stem.
  function drawFern(svg, P) {
    // The stem: one quadratic, stroked thin.
    node(svg, 'path', {
      d: 'M36 158 Q46 96 88 34',
      fill: 'none',
      stroke: P.figure,
      'stroke-width': 2,
      'stroke-linecap': 'round',
    });
    // Leaflets ride the same curve: B(t) over P0(36,158) P1(46,96) P2(88,34),
    // alternating sides, shrinking toward the tip.
    for (let i = 0; i < 6; i++) {
      const t = 0.16 + i * 0.15;
      const mt = 1 - t;
      const x = mt * mt * 36 + 2 * mt * t * 46 + t * t * 88;
      const y = mt * mt * 158 + 2 * mt * t * 96 + t * t * 34;
      const side = (i % 2 === 0) ? -1 : 1;
      const r = 7 - i * 0.7;
      diamond(svg,
        Math.round(x + side * 11), Math.round(y - 3),
        Math.round(r * 10) / 10, Math.round(r * 13) / 10,
        (i % 2 === 0) ? P.figure : P.accent);
    }
    dot(svg, 92, 24, 2, P.accent, 0.7);
  }

  // 5 · Seed & sprout — a diamond seed below a horizon rule, a sprout above.
  function drawSeed(svg, P) {
    rule(svg, 12, 110, 96, P.figure);
    diamond(svg, 60, 141, 17, 20, P.field);
    diamond(svg, 60, 141, 9, 11, P.accent);
    rect(svg, 59, 86, 2, 24, P.figure);
    diamond(svg, 50, 88, 7, 9, P.figure);
    diamond(svg, 70, 81, 7, 9, P.accent);
  }

  // 6 · Grove at night — two tall thin trees, a scatter of dot stars.
  function drawGrove(svg, P) {
    dot(svg, 20, 26, 1.4, P.figure, 0.8);
    dot(svg, 40, 44, 1.2, P.figure, 0.55);
    dot(svg, 58, 18, 1.6, P.accent, 0.85);
    dot(svg, 76, 34, 1.2, P.figure, 0.6);
    dot(svg, 97, 22, 1.4, P.figure, 0.75);
    dot(svg, 28, 62, 1.2, P.figure, 0.45);
    dot(svg, 90, 56, 1.3, P.accent, 0.6);
    dot(svg, 64, 50, 1.1, P.figure, 0.4);
    diamond(svg, 44, 116, 9, 46, P.figure);
    diamond(svg, 82, 128, 7, 38, P.field);
    rule(svg, 14, 168, 92, P.figure, 0.4);
  }

  // 7 · The reader — a seated side-on figure with an open book, on a
  // diamond-motif ground. (This design, in indigo/amber, is the family's
  // origin: the hand-committed tutorial-book cover.)
  function drawReader(svg, P) {
    // Ground block and its rule.
    rect(svg, 0, 140, 120, 40, P.field);
    rule(svg, 0, 138.5, 120, P.figure, 0.35);
    // Diamond motif along the ground band.
    diamond(svg, 36, 160, 7, 7, P.figure, 0.35);
    diamond(svg, 60, 160, 8, 8, P.accent);
    diamond(svg, 84, 160, 7, 7, P.figure, 0.35);
    // The figure: circle head, angular torso, thigh and shin blocks.
    dot(svg, 58, 52, 9, P.figure);
    poly(svg, [50, 60, 64, 63, 66, 94, 48, 98], P.figure);        // torso
    poly(svg, [48, 94, 84, 98, 84, 108, 48, 106], P.figure);      // thighs
    poly(svg, [76, 108, 84, 108, 84, 128, 76, 128], P.figure);    // shin
    poly(svg, [58, 72, 76, 80, 74, 88, 56, 82], P.figure);        // arm
    // The open-V book, held at the knees.
    poly(svg, [86, 82, 72, 74, 72, 82, 86, 90], P.accent);
    poly(svg, [86, 82, 100, 74, 100, 82, 86, 90], P.accent);
    rect(svg, 85.25, 82, 1.5, 8, P.bg);                           // spine
    rule(svg, 14, 128, 92, P.figure, 0.5);
  }

  const DESIGNS = [
    drawSapling,  // 0
    drawOrchard,  // 1
    drawConifer,  // 2
    drawFern,     // 3
    drawSeed,     // 4
    drawGrove,    // 5
    drawReader,   // 6
  ];

  // ── Public API (PLAN7 §2.8 — exact signatures) ────────────────────────────

  // → SVGSVGElement, a complete generated cover. Accepts a Series or a bare
  //   id string; opts: { className } applied to the root svg.
  function element(seriesOrId, opts) {
    const h = fnv1a(idOf(seriesOrId));
    const P = palette(h);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    // Fill whatever box the consumer sizes, cropping like object-fit: cover —
    // the same behaviour a real cover <img> has in these slots.
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (opts && typeof opts.className === 'string' && opts.className) {
      svg.setAttribute('class', opts.className);
    }

    rect(svg, 0, 0, W, H, P.bg);
    DESIGNS[h % DESIGNS.length](svg, P);
    return svg;
  }

  // → 0..6 — exposed for tests and determinism checks.
  function designIndex(id) {
    return fnv1a(idOf(id)) % DESIGNS.length;
  }

  window.Covers = {
    element: element,
    designIndex: designIndex,
  };
})();
