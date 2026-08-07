// Plain text -> Block[] (docs/ARCHITECTURE.md §1.3).
//
// Blocks are the only prose primitive the app understands. We never emit HTML:
// the reader sets textContent, never innerHTML, and that is the XSS boundary.
// Everything here therefore produces plain strings.

/** Block types the contract allows. Anything else must not be emitted. */
export const BLOCK_TYPES = new Set(['p', 'h2', 'h3', 'h4', 'hr', 'blockquote', 'pre', 'ul', 'ol', 'img', 'note']);

/** A line that is a scene break: `* * *`, `-----`, `~~~`, `***`, etc. */
const SCENE_BREAK = /^[ \t]*(?:[*∗][ \t]*){3,}[ \t]*$|^[ \t]*[-_=~—–]{3,}[ \t]*$/;

/** Lines that are page-scan artefacts in some Gutenberg transcriptions. */
const NOISE = /^[ \t]*\[?(?:illustration|blank page|transcriber'?s? note)\b/i;

/**
 * Normalize line endings, strip the UTF-8 BOM, and expand tabs.
 * Gutenberg plain-text files are CRLF with a BOM.
 */
export function normalizeText(raw) {
  return String(raw)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[ \t]+$/gm, '');
}

/** Words, roughly. Used for Chapter.wordCount / ChapterFile.wordCount. */
export function countWords(text) {
  const m = String(text).match(/[^\s]+/g);
  return m ? m.length : 0;
}

/** Sum the word count of a Block[]. */
export function blocksWordCount(blocks) {
  let n = 0;
  for (const b of blocks) {
    if (typeof b.c === 'string') n += countWords(b.c);
    if (Array.isArray(b.items)) for (const it of b.items) n += countWords(it);
  }
  return n;
}

/** Split a chunk of text into paragraph groups on blank lines. */
function paragraphs(text) {
  return text.split(/\n[ \t]*\n+/);
}

/** Leading-space count of the least-indented non-empty line. */
function minIndent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, l.length - l.replace(/^ +/, '').length);
  }
  return min === Infinity ? 0 : min;
}

/**
 * Does this paragraph look like verse? Short, consistently-broken lines.
 * Verse keeps its line breaks, so it becomes a `pre` block; indented prose
 * becomes a `blockquote` with the lines re-flowed.
 */
function looksLikeVerse(lines) {
  if (lines.length < 2) return false;
  const lens = lines.map(l => l.trim().length).filter(Boolean);
  if (!lens.length) return false;
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const shortEnough = lens.filter(l => l < 62).length / lens.length;
  return avg < 60 && shortEnough > 0.8;
}

/**
 * Convert a run of plain text into Block[].
 *
 * Options:
 *   heading      — optional string emitted as the leading `h2`
 *   headingType  — 'h2' (default) | 'h3' | 'h4'
 *   quoteIndent  — columns of extra indentation that mark a quotation
 *                  (default 4; set to Infinity to disable the heuristic)
 *   lead         — extra Block[] inserted directly after the heading
 */
export function textToBlocks(text, opts = {}) {
  const { heading = null, headingType = 'h2', quoteIndent = 4, lead = [] } = opts;
  const blocks = [];

  if (heading) blocks.push({ t: headingType, c: collapse(heading) });
  for (const b of lead) blocks.push(b);

  const body = normalizeText(text);
  const base = minIndent(body.split('\n'));

  for (const para of paragraphs(body)) {
    if (!para.trim()) continue;

    const lines = para.split('\n').filter(l => l.trim().length || false);
    if (!lines.length) continue;

    // Scene break: a paragraph made only of rule-ish lines.
    if (lines.every(l => SCENE_BREAK.test(l))) {
      if (blocks.length && blocks[blocks.length - 1].t !== 'hr') blocks.push({ t: 'hr' });
      continue;
    }

    // A scene break glued to the top or bottom of a paragraph.
    while (lines.length && SCENE_BREAK.test(lines[0])) {
      lines.shift();
      if (blocks.length && blocks[blocks.length - 1].t !== 'hr') blocks.push({ t: 'hr' });
    }
    let trailingRule = false;
    while (lines.length && SCENE_BREAK.test(lines[lines.length - 1])) {
      lines.pop();
      trailingRule = true;
    }
    if (!lines.length) {
      if (trailingRule && blocks.length && blocks[blocks.length - 1].t !== 'hr') blocks.push({ t: 'hr' });
      continue;
    }

    if (NOISE.test(lines[0]) && lines.length === 1) {
      if (trailingRule) blocks.push({ t: 'hr' });
      continue;
    }

    const indent = minIndent(lines) - base;
    if (indent >= quoteIndent) {
      if (looksLikeVerse(lines)) {
        blocks.push({ t: 'pre', c: lines.map(l => l.trim()).join('\n') });
      } else {
        blocks.push({ t: 'blockquote', c: collapse(lines.join(' ')) });
      }
    } else {
      blocks.push({ t: 'p', c: collapse(lines.join(' ')) });
    }

    if (trailingRule) blocks.push({ t: 'hr' });
  }

  // Never end a chapter on a rule.
  while (blocks.length && blocks[blocks.length - 1].t === 'hr') blocks.pop();

  return blocks;
}

function collapse(s) {
  return String(s).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}

/** Build a ChapterFile (§1.2) for text content. */
export function textChapterFile({ seriesId, id, num, title, blocks }) {
  return {
    seriesId,
    id,
    num: num ?? null,
    title: title ?? null,
    kind: 'text',
    blocks,
    wordCount: blocksWordCount(blocks),
  };
}

/** Build a ChapterFile (§1.2) for image content. */
export function imageChapterFile({ seriesId, id, num, title, pages }) {
  return {
    seriesId,
    id,
    num: num ?? null,
    title: title ?? null,
    kind: 'image',
    pages,
  };
}
