#!/usr/bin/env node
// Draws the committed SVG pages for the "Ashfall Courier" sample image series.
//
//   node scraper/fixtures/ashfall/build-pages.mjs
//
// Writes c01-p01.svg … c08-p10.svg beside this file. The pages are plain
// hand-written SVG — shapes, panel borders, speech balloons, no bitmaps and no
// base64 — so the image reader can be demonstrated with no network at all.
// Re-running is safe: it overwrites the same 80 files with the same bytes.
//
// The script is the source of truth for the artwork. The SVGs it writes are
// committed because the scraper copies files, it does not run generators.

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const OUT = dirname(fileURLToPath(import.meta.url));

const W = 800, H = 1200;          // vertical strip page
const M = 26;                     // page margin
const G = 18;                     // gutter between panels

const INK = '#1b1714';
const PAPER = '#efe7dc';
const EMBER = '#e8622a';
const ASH = '#8d8378';
const DEEP = '#2e2723';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r = (n, d = 1) => Number(n.toFixed(d));

// ── deterministic pseudo-random, so re-runs produce identical files ──────────
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ── art primitives ───────────────────────────────────────────────────────────
// Every one draws inside the panel box {x,y,w,h} and returns an SVG fragment.

function ashfall(b, seed, density = 40) {
  const rand = rng(seed);
  const n = Math.round(density * 0.6);
  let out = `<g fill="${ASH}" opacity="0.45">`;
  for (let i = 0; i < n; i++) {
    const cx = Math.round(b.x + rand() * b.w), cy = Math.round(b.y + rand() * b.h);
    const rr = r(0.8 + rand() * 2.2);
    out += `<circle cx="${cx}" cy="${cy}" r="${rr}"/>`;
  }
  return out + '</g>';
}

function skyline(b, seed, base = 0.72) {
  const rand = rng(seed);
  const y0 = b.y + b.h * base;
  let d = `M${r(b.x)} ${r(b.y + b.h)} L${r(b.x)} ${r(y0)}`;
  let x = b.x;
  while (x < b.x + b.w) {
    const w = 24 + rand() * 60;
    const h = (rand() - 0.4) * b.h * 0.22;
    x = Math.min(x + w, b.x + b.w);
    d += ` L${r(x)} ${r(y0 + h)}`;
  }
  d += ` L${r(b.x + b.w)} ${r(b.y + b.h)} Z`;
  return `<path d="${d}" fill="${DEEP}"/>`;
}

function stack(b, cx = 0.5, scale = 1) {
  const px = b.x + b.w * cx;
  const base = b.y + b.h * 0.92;
  const top = base - b.h * 0.62 * scale;
  const half = b.w * 0.30 * scale;
  return `<path d="M${r(px - half)} ${r(base)} L${r(px - half * 0.22)} ${r(top)} L${r(px + half * 0.22)} ${r(top)} L${r(px + half)} ${r(base)} Z" fill="${DEEP}"/>` +
    `<path d="M${r(px - half * 0.22)} ${r(top)} q${r(half * 0.2)} ${r(-b.h * 0.10)} ${r(half * 0.44)} 0" fill="none" stroke="${EMBER}" stroke-width="5" stroke-linecap="round"/>` +
    `<circle cx="${r(px)}" cy="${r(top - b.h * 0.06)}" r="${r(b.w * 0.13 * scale)}" fill="${EMBER}" opacity="0.22"/>`;
}

// A courier: head, scarf streaming, coat, legs. `pose` picks the leg/arm set.
function figure(x, y, s, pose = 'run', flip = false) {
  const f = flip ? -1 : 1;
  const t = `translate(${r(x)} ${r(y)}) scale(${r(s * f, 3)} ${r(s, 3)})`;
  const legs = pose === 'run'
    ? `<path d="M0 46 L-16 84 M0 46 L18 78 L26 86"/>`
    : pose === 'stand'
      ? `<path d="M-5 46 L-7 88 M5 46 L8 88"/>`
      : `<path d="M0 46 L-20 72 L-14 88 M0 46 L16 74"/>`;
  const arms = pose === 'run'
    ? `<path d="M0 16 L-22 34 M0 16 L20 6"/>`
    : pose === 'reach'
      ? `<path d="M0 16 L-18 30 M0 16 L26 -8"/>`
      : `<path d="M0 16 L-14 40 M0 16 L14 40"/>`;
  return `<g transform="${t}" stroke="${INK}" stroke-width="5" stroke-linecap="round" fill="none">` +
    `<circle cx="0" cy="-8" r="11" fill="${PAPER}"/>` +
    `<path d="M0 3 L0 48" />` + arms + legs +
    `</g>` +
    `<g transform="${t}"><path d="M-8 -2 q-26 6 -44 -6 q22 22 44 14 Z" fill="${EMBER}"/>` +
    `<rect x="4" y="20" width="20" height="16" rx="3" fill="${DEEP}"/></g>`;
}

const ART = {
  wide(b, seed) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#cfc6ba"/>` +
      stack(b, 0.66, 1) + skyline(b, seed, 0.80) + ashfall(b, seed + 7, 55) +
      figure(b.x + b.w * 0.22, b.y + b.h * 0.62, 0.7, 'run');
  },
  city(b, seed) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#d8cfc2"/>` +
      skyline(b, seed, 0.42) + skyline(b, seed + 3, 0.66) + ashfall(b, seed + 11, 45);
  },
  run(b, seed) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#e2d9cc"/>` +
      skyline(b, seed, 0.78) + ashfall(b, seed + 5, 30) +
      figure(b.x + b.w * 0.5, b.y + b.h * 0.30, 1.15, 'run') +
      `<path d="M${r(b.x + b.w * 0.10)} ${r(b.y + b.h * 0.86)} L${r(b.x + b.w * 0.90)} ${r(b.y + b.h * 0.86)}" stroke="${INK}" stroke-width="4"/>`;
  },
  face(b, seed) {
    const cx = b.x + b.w * 0.5, cy = b.y + b.h * 0.52, rr = Math.min(b.w, b.h) * 0.30;
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#e7dfd2"/>` +
      ashfall(b, seed + 2, 18) +
      `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rr)}" fill="${PAPER}" stroke="${INK}" stroke-width="5"/>` +
      `<path d="M${r(cx - rr * 0.45)} ${r(cy - rr * 0.15)} h${r(rr * 0.34)} M${r(cx + rr * 0.11)} ${r(cy - rr * 0.15)} h${r(rr * 0.34)}" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>` +
      `<path d="M${r(cx - rr * 0.3)} ${r(cy + rr * 0.38)} q${r(rr * 0.3)} ${r(rr * 0.2)} ${r(rr * 0.6)} 0" stroke="${INK}" stroke-width="5" fill="none" stroke-linecap="round"/>` +
      `<path d="M${r(cx - rr)} ${r(cy + rr * 0.7)} q${r(rr)} ${r(rr * 0.5)} ${r(rr * 2)} 0 l0 ${r(rr * 0.5)} q${r(-rr)} ${r(-rr * 0.3)} ${r(-rr * 2)} 0 Z" fill="${EMBER}"/>`;
  },
  letter(b, seed) {
    const cx = b.x + b.w * 0.5, cy = b.y + b.h * 0.5;
    const lw = b.w * 0.42, lh = lw * 0.62;
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${DEEP}"/>` +
      ashfall(b, seed + 4, 14) +
      `<g transform="rotate(-7 ${r(cx)} ${r(cy)})">` +
      `<rect x="${r(cx - lw / 2)}" y="${r(cy - lh / 2)}" width="${r(lw)}" height="${r(lh)}" fill="${PAPER}" stroke="${INK}" stroke-width="4"/>` +
      `<path d="M${r(cx - lw / 2)} ${r(cy - lh / 2)} L${r(cx)} ${r(cy + lh * 0.08)} L${r(cx + lw / 2)} ${r(cy - lh / 2)}" fill="none" stroke="${INK}" stroke-width="3"/>` +
      `<circle cx="${r(cx)}" cy="${r(cy + lh * 0.18)}" r="${r(lh * 0.17)}" fill="${EMBER}" stroke="${INK}" stroke-width="3"/>` +
      `</g>`;
  },
  crowd(b, seed) {
    let out = `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ded5c8"/>` + skyline(b, seed, 0.5);
    const rand = rng(seed + 9);
    for (let i = 0; i < 6; i++) {
      out += figure(b.x + b.w * (0.12 + i * 0.15), b.y + b.h * (0.34 + rand() * 0.12), 0.55, 'stand', i % 2 === 0);
    }
    return out + ashfall(b, seed + 6, 26);
  },
  stair(b, seed) {
    let out = `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#d4cbbe"/>`;
    for (let i = 0; i < 7; i++) {
      const sx = b.x + b.w * 0.08 * i, sy = b.y + b.h * (0.86 - i * 0.09);
      out += `<rect x="${r(sx)}" y="${r(sy)}" width="${r(b.w * 0.26)}" height="${r(b.h * 0.09)}" fill="${DEEP}" opacity="${r(0.5 + i * 0.06, 2)}"/>`;
    }
    return out + figure(b.x + b.w * 0.62, b.y + b.h * 0.30, 0.8, 'climb') + ashfall(b, seed + 8, 22);
  },
  dark(b, seed) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#17130f"/>` +
      `<circle cx="${r(b.x + b.w * 0.5)}" cy="${r(b.y + b.h * 0.5)}" r="${r(Math.min(b.w, b.h) * 0.34)}" fill="${EMBER}" opacity="0.14"/>` +
      `<circle cx="${r(b.x + b.w * 0.5)}" cy="${r(b.y + b.h * 0.5)}" r="10" fill="${EMBER}"/>` +
      ashfall(b, seed + 12, 20);
  },
  summit(b, seed) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#3b2b23"/>` +
      stack(b, 0.5, 1.25) +
      `<circle cx="${r(b.x + b.w * 0.5)}" cy="${r(b.y + b.h * 0.30)}" r="${r(b.w * 0.20)}" fill="${EMBER}" opacity="0.35"/>` +
      ashfall(b, seed + 13, 60) +
      figure(b.x + b.w * 0.24, b.y + b.h * 0.60, 0.62, 'reach');
  },
  clear(b, seed) {
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#f4efe6"/>` +
      `<circle cx="${r(b.x + b.w * 0.74)}" cy="${r(b.y + b.h * 0.26)}" r="${r(b.h * 0.16)}" fill="${EMBER}" opacity="0.55"/>` +
      skyline(b, seed, 0.74) +
      figure(b.x + b.w * 0.3, b.y + b.h * 0.44, 0.85, 'stand');
  },
};

// ── lettering ────────────────────────────────────────────────────────────────

function wrap(text, per) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > per && line) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function balloon(b, spec) {
  const lines = wrap(spec.t, spec.per || 22);
  const fs = spec.fs || 21;
  const lh = fs * 1.28;
  const bw = Math.min(b.w * 0.62, 40 + Math.max(...lines.map(l => l.length)) * fs * 0.53);
  const bh = lines.length * lh + 26;
  const cx = b.x + b.w * (spec.x ?? 0.5);
  const cy = b.y + b.h * (spec.y ?? 0.2);
  const x = Math.max(b.x + 8, Math.min(cx - bw / 2, b.x + b.w - bw - 8));
  const y = Math.max(b.y + 8, Math.min(cy - bh / 2, b.y + b.h - bh - 8));
  const tailX = x + bw * (spec.tail === 'left' ? 0.24 : 0.72);
  const tail = spec.tail === 'none' ? '' :
    `<path d="M${r(tailX - 13)} ${r(y + bh - 2)} L${r(tailX + 5)} ${r(y + bh + 26)} L${r(tailX + 13)} ${r(y + bh - 2)} Z" fill="${PAPER}" stroke="${INK}" stroke-width="3.5"/>` +
    `<path d="M${r(tailX - 11)} ${r(y + bh - 3)} h22" stroke="${PAPER}" stroke-width="5"/>`;
  const txt = lines.map((l, i) =>
    `<text x="${r(x + bw / 2)}" y="${r(y + 20 + i * lh)}" font-size="${fs}" text-anchor="middle" fill="${INK}" font-family="Verdana, Geneva, sans-serif">${esc(l)}</text>`).join('');
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(bw)}" height="${r(bh)}" rx="${r(bh / 2.6)}" fill="${PAPER}" stroke="${INK}" stroke-width="3.5"/>${tail}${txt}`;
}

function caption(b, text) {
  const lines = wrap(text, 34);
  const fs = 18, lh = fs * 1.32;
  const bw = Math.min(b.w - 20, 30 + Math.max(...lines.map(l => l.length)) * fs * 0.55);
  const bh = lines.length * lh + 16;
  const x = b.x + 10, y = b.y + 10;
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(bw)}" height="${r(bh)}" fill="${DEEP}" opacity="0.92"/>` +
    lines.map((l, i) =>
      `<text x="${r(x + 12)}" y="${r(y + 20 + i * lh)}" font-size="${fs}" fill="${PAPER}" font-family="Georgia, 'Times New Roman', serif">${esc(l)}</text>`).join('');
}

function sfx(b, text) {
  return `<text x="${r(b.x + b.w * 0.72)}" y="${r(b.y + b.h * 0.82)}" font-size="46" fill="${EMBER}" stroke="${INK}" stroke-width="2" font-family="Verdana, Geneva, sans-serif" font-weight="bold" text-anchor="middle" transform="rotate(-8 ${r(b.x + b.w * 0.72)} ${r(b.y + b.h * 0.82)})">${esc(text)}</text>`;
}

// ── page assembly ────────────────────────────────────────────────────────────

function page(chapter, pageNo, panels, seedBase) {
  const usableH = H - M * 2 - 34;          // leave a strip for the page number
  const weights = panels.map(p => p.h || 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const gutters = G * (panels.length - 1);
  let y = M;
  let body = '';

  panels.forEach((p, i) => {
    const h = (usableH - gutters) * (weights[i] / total);
    const b = { x: M, y, w: W - M * 2, h };
    const clip = `p${pageNo}_${i}`;
    const art = (ART[p.art] || ART.city)(b, seedBase + i * 31);
    body += `<clipPath id="${clip}"><rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}"/></clipPath>` +
      `<g clip-path="url(#${clip})">${art}` +
      (p.sfx ? sfx(b, p.sfx) : '') +
      (p.cap ? caption(b, p.cap) : '') +
      (p.bal || []).map(s => balloon(b, s)).join('') +
      `</g>` +
      `<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" fill="none" stroke="${INK}" stroke-width="4"/>`;
    y += h + G;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Ashfall Courier, chapter ${chapter}, page ${pageNo}">
<rect width="${W}" height="${H}" fill="${PAPER}"/>
${body}
<text x="${W - M}" y="${H - 14}" font-size="17" fill="${ASH}" font-family="Verdana, Geneva, sans-serif" text-anchor="end">ASHFALL COURIER — ${chapter}.${String(pageNo).padStart(2, '0')}</text>
</svg>
`;
}

// ── the book ─────────────────────────────────────────────────────────────────
// Each entry is one page: an array of panels, top to bottom.
// art: wide city run face letter crowd stair dark summit clear
// h: relative height. cap: caption. bal: [{t, x, y, tail}]. sfx: sound effect.

const B = (t, o = {}) => Object.assign({ t }, o);

const CHAPTERS = [
  {
    title: 'Chapter 1: Ash Day',
    pages: [
      [{ art: 'wide', h: 1.5, cap: 'VENT. Two hundred and eleven days of ash, and counting.' },
       { art: 'city', h: 1, bal: [B('Nothing flies here. Nothing broadcasts. So we run.', { y: 0.28 })] }],
      [{ art: 'run', h: 1.2, sfx: 'TAK TAK' },
       { art: 'face', h: 1, bal: [B('Amaru! Ridge gate, before the fall thickens!', { x: 0.4, tail: 'left' })] }],
      [{ art: 'city', h: 1, cap: 'The Couriers of the Grey Satchel. Forty-one runners. Eleven left.' },
       { art: 'crowd', h: 1.2, bal: [B('Sesi is sixteen. She has the best lungs in the guild.', { y: 0.24, tail: 'none' })] }],
      [{ art: 'run', h: 1.4, sfx: 'FWSH' },
       { art: 'face', h: 1, bal: [B('Ash on the tongue. Six blocks to the gate.', { x: 0.55 })] }],
      [{ art: 'stair', h: 1.2 },
       { art: 'city', h: 1, bal: [B('Stack is loud today.', { x: 0.35, tail: 'left' }), B('Stack is always loud.', { x: 0.65, y: 0.42 })] }],
      [{ art: 'wide', h: 1.6, cap: 'Nobody in Vent looks up any more. That is the first rule.' }],
      [{ art: 'crowd', h: 1 },
       { art: 'letter', h: 1.3, cap: 'The second rule: a sealed letter is not read.', sfx: 'thmp' }],
      [{ art: 'face', h: 1, bal: [B('Who is it for?', { x: 0.5 })] },
       { art: 'dark', h: 1.2, bal: [B('No name. Only the Stack road.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'run', h: 1.3, sfx: 'GO' },
       { art: 'city', h: 1, cap: 'Six hours of light. Fourteen miles of road.' }],
      [{ art: 'wide', h: 1.4 },
       { art: 'dark', h: 1, bal: [B('Behind her, someone else took the same road.', { x: 0.5, tail: 'none' })] }],
    ],
  },
  {
    title: 'Chapter 2: The Sealed Letter',
    pages: [
      [{ art: 'letter', h: 1.4, cap: 'A seal of red wax. No house mark. No name.' },
       { art: 'face', h: 1, bal: [B('Sealed means sealed, Sesi.', { x: 0.45, tail: 'left' })] }],
      [{ art: 'city', h: 1 }, { art: 'run', h: 1.3, sfx: 'TAK' }],
      [{ art: 'crowd', h: 1.2, bal: [B('Grey market. Everyone here buys what nobody sells.', { y: 0.22, tail: 'none' })] },
       { art: 'face', h: 1, bal: [B('You are carrying for the Stack road.', { x: 0.55 })] }],
      [{ art: 'dark', h: 1.5, bal: [B('How would you know that?', { x: 0.4, y: 0.3, tail: 'left' })] }],
      [{ art: 'face', h: 1 }, { art: 'letter', h: 1.2, sfx: 'grab' }],
      [{ art: 'run', h: 1.6, sfx: 'DASH' }],
      [{ art: 'stair', h: 1.2 }, { art: 'city', h: 1, cap: 'Eleven flights. She counted them going up.' }],
      [{ art: 'face', h: 1, bal: [B('They wanted the letter. Not the satchel. The letter.', { x: 0.5 })] },
       { art: 'letter', h: 1.2 }],
      [{ art: 'wide', h: 1.5, cap: 'A courier who opens a letter is a courier once.' }],
      [{ art: 'dark', h: 1.3, bal: [B('So she did not open it. She copied the seal.', { x: 0.5, tail: 'none' })] },
       { art: 'face', h: 1, sfx: '!' }],
    ],
  },
  {
    title: 'Chapter 3: The Grey Market',
    pages: [
      [{ art: 'crowd', h: 1.4, cap: 'The market under the water pipes. Warm, for once.' }],
      [{ art: 'face', h: 1, bal: [B('That seal is a mine seal. Shaft Four.', { x: 0.55 })] },
       { art: 'letter', h: 1.2 }],
      [{ art: 'city', h: 1 }, { art: 'crowd', h: 1.3, bal: [B('Shaft Four closed eleven years ago.', { x: 0.4, tail: 'left' })] }],
      [{ art: 'dark', h: 1.5, bal: [B('Then who is still sealing letters with it?', { x: 0.5, tail: 'none' })] }],
      [{ art: 'run', h: 1.2, sfx: 'TAK TAK' }, { art: 'face', h: 1 }],
      [{ art: 'stair', h: 1.4, cap: 'Down, this time. Under the market. Under the pipes.' }],
      [{ art: 'dark', h: 1.3, sfx: 'drip' }, { art: 'face', h: 1, bal: [B('Hello?', { x: 0.5 })] }],
      [{ art: 'crowd', h: 1.2, bal: [B('Twenty of them. Living under a market.', { y: 0.2, tail: 'none' })] },
       { art: 'face', h: 1, bal: [B('You are the runner. We have been waiting.', { x: 0.45, tail: 'left' })] }],
      [{ art: 'letter', h: 1.4, cap: 'The letter was not for one person. It was for all of them.' }],
      [{ art: 'wide', h: 1.2 }, { art: 'dark', h: 1, bal: [B('And it has to reach the Stack by the fall.', { x: 0.5, tail: 'none' })] }],
    ],
  },
  {
    title: 'Chapter 4: The Ridge Run',
    pages: [
      [{ art: 'wide', h: 1.5, cap: 'Fourteen miles of ridge. No cover. No stopping.' }],
      [{ art: 'run', h: 1.3, sfx: 'FWSH' }, { art: 'city', h: 1 }],
      [{ art: 'face', h: 1, bal: [B('Breathe through the scarf. Four in, six out.', { x: 0.5 })] },
       { art: 'run', h: 1.2 }],
      [{ art: 'wide', h: 1.6, sfx: 'WHUMP' }],
      [{ art: 'dark', h: 1.2, bal: [B('That was the Stack. That was not thunder.', { x: 0.45, tail: 'left' })] },
       { art: 'face', h: 1 }],
      [{ art: 'run', h: 1.4, sfx: 'RUN' }],
      [{ art: 'stair', h: 1.2, cap: 'The old rail steps. Eleven hundred of them.' }, { art: 'face', h: 1 }],
      [{ art: 'crowd', h: 1, bal: [B('Turn back, girl! Road is gone at the bend!', { x: 0.4, tail: 'left' })] },
       { art: 'run', h: 1.2, sfx: 'no' }],
      [{ art: 'wide', h: 1.5, cap: 'The road was gone at the bend.' }],
      [{ art: 'face', h: 1, sfx: '!' }, { art: 'dark', h: 1.3, bal: [B('So she went along the pipe.', { x: 0.5, tail: 'none' })] }],
    ],
  },
  {
    title: 'Chapter 5: Ashfall',
    pages: [
      [{ art: 'wide', h: 1.6, cap: 'Ashfall proper. Day into night in four minutes.' }],
      [{ art: 'dark', h: 1.4, sfx: 'hsssss' }],
      [{ art: 'face', h: 1, bal: [B('Cannot see the pipe. Cannot see my own hand.', { x: 0.5 })] },
       { art: 'dark', h: 1.2 }],
      [{ art: 'dark', h: 1.5, bal: [B('Count. Just count. Eleven paces to the bracket.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'stair', h: 1.2, sfx: 'clang' }, { art: 'face', h: 1 }],
      [{ art: 'dark', h: 1.3, bal: [B('Someone else is on the pipe.', { x: 0.4, tail: 'left' })] },
       { art: 'face', h: 1, sfx: '!' }],
      [{ art: 'crowd', h: 1.2 }, { art: 'dark', h: 1, bal: [B('Give it here and you walk down.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'letter', h: 1.4, cap: 'She gave them the satchel. The letter was in her boot.' }],
      [{ art: 'run', h: 1.4, sfx: 'GO' }],
      [{ art: 'wide', h: 1.2 }, { art: 'face', h: 1, bal: [B('Three miles. Uphill. In the dark.', { x: 0.5 })] }],
    ],
  },
  {
    title: 'Chapter 6: What the Letter Says',
    pages: [
      [{ art: 'dark', h: 1.5, cap: 'A shelter hut. A stove. Four hours until light.' }],
      [{ art: 'letter', h: 1.3 }, { art: 'face', h: 1, bal: [B('Sealed means sealed.', { x: 0.5 })] }],
      [{ art: 'face', h: 1.4, bal: [B('Unless the seal is a lie.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'letter', h: 1.5, sfx: 'crack' }],
      [{ art: 'dark', h: 1, cap: 'Inside: a map of Shaft Four. And a list of names.' },
       { art: 'crowd', h: 1.2 }],
      [{ art: 'face', h: 1, bal: [B('Twenty names. The people under the market.', { x: 0.5 })] },
       { art: 'letter', h: 1.2 }],
      [{ art: 'dark', h: 1.4, bal: [B('It is not a message. It is a claim of title.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'city', h: 1, cap: 'Shaft Four did not close. Shaft Four was taken.' },
       { art: 'face', h: 1.2, sfx: 'oh' }],
      [{ art: 'wide', h: 1.5 }],
      [{ art: 'run', h: 1.3, sfx: 'UP' }, { art: 'dark', h: 1, bal: [B('The Stack road. Before the registry opens.', { x: 0.5, tail: 'none' })] }],
    ],
  },
  {
    title: 'Chapter 7: The Stack',
    pages: [
      [{ art: 'summit', h: 1.6, cap: 'The Stack. Nobody lives up here. Somebody works up here.' }],
      [{ art: 'stair', h: 1.3, sfx: 'step' }, { art: 'face', h: 1 }],
      [{ art: 'summit', h: 1.4 }, { art: 'crowd', h: 1, bal: [B('You are eleven hours early, runner.', { x: 0.45, tail: 'left' })] }],
      [{ art: 'face', h: 1, bal: [B('I am on time. You are early.', { x: 0.5 })] },
       { art: 'letter', h: 1.2 }],
      [{ art: 'dark', h: 1.5, bal: [B('That seal is broken.', { x: 0.4, tail: 'left' }), B('Yes.', { x: 0.7, y: 0.5 })] }],
      [{ art: 'face', h: 1.4, bal: [B('Then you are not a courier any more.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'summit', h: 1.2, sfx: 'WHUMP' }, { art: 'face', h: 1 }],
      [{ art: 'crowd', h: 1.3, cap: 'And twenty people came up the road behind her.' }],
      [{ art: 'letter', h: 1.4, bal: [B('You cannot register a claim against twenty witnesses.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'summit', h: 1.5, sfx: 'HAAA' }],
    ],
  },
  {
    title: 'Chapter 8: Clear Sky',
    pages: [
      [{ art: 'clear', h: 1.6, cap: 'Two hundred and nineteen days of ash. Then, one morning, none.' }],
      [{ art: 'city', h: 1.2 }, { art: 'crowd', h: 1, bal: [B('People came out and stood in the street and said nothing.', { y: 0.24, tail: 'none' })] }],
      [{ art: 'face', h: 1, bal: [B('It will come back.', { x: 0.4, tail: 'left' }), B('It will. Not today.', { x: 0.66, y: 0.46 })] },
       { art: 'clear', h: 1.2 }],
      [{ art: 'letter', h: 1.3, cap: 'The claim was refused. Shaft Four went back on the roll.' }],
      [{ art: 'crowd', h: 1.4 }],
      [{ art: 'face', h: 1, bal: [B('The guild took her papers. For eleven days.', { x: 0.5, tail: 'none' })] },
       { art: 'city', h: 1.2, bal: [B('Then the guild gave them back, with a mark on them.', { x: 0.5, tail: 'none' })] }],
      [{ art: 'letter', h: 1.2, cap: 'The mark reads: OPENED ONE. Every courier who sees it asks.' },
       { art: 'face', h: 1 }],
      [{ art: 'clear', h: 1.5, bal: [B('Good. Let them ask.', { x: 0.45, y: 0.7 })] }],
      [{ art: 'run', h: 1.3, sfx: 'TAK TAK' }, { art: 'city', h: 1 }],
      [{ art: 'clear', h: 1.6, cap: 'END. Original sample artwork, drawn in plain SVG for this repository.' }],
    ],
  },
];

// ── write ────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
let n = 0, bytes = 0;
CHAPTERS.forEach((ch, ci) => {
  ch.pages.forEach((panels, pi) => {
    const name = `c${String(ci + 1).padStart(2, '0')}-p${String(pi + 1).padStart(2, '0')}.svg`;
    const svg = page(ci + 1, pi + 1, panels, (ci + 1) * 1000 + (pi + 1) * 17);
    writeFileSync(join(OUT, name), svg);
    n++; bytes += Buffer.byteLength(svg);
  });
});
console.log(`ashfall: wrote ${n} SVG pages, ${(bytes / 1024).toFixed(1)} KB total, ${(bytes / n / 1024).toFixed(1)} KB average`);
console.log(CHAPTERS.map((c, i) => `  c${String(i + 1).padStart(2, '0')} ${c.title} (${c.pages.length} pages)`).join('\n'));
