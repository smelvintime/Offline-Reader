// Project Gutenberg — public-domain text only (docs/ARCHITECTURE.md §8).
//
// We fetch the work's own plain-text transcription (preferring `.txt.utf-8`),
// strip the licence boilerplate, split it on the headings the book itself uses,
// and convert each chapter to Block[] (§1.3). Nothing but public-domain prose
// ever lands in the repository, and no chapter text is inlined into
// catalog.json — every chapter gets its own ChapterFile (§1.2).

import { getTextFromFirst, firstWorkingImage } from '../lib/http.js';
import { normalizeText, textToBlocks, textChapterFile, countWords } from '../lib/blocks.js';
import { chapterId, chapterSrc, tidy, firstOf } from '../lib/util.js';

export const id = 'gutenberg';
export const label = 'Project Gutenberg';

/** Stable, globally unique series id for a config entry. */
export function entryId(entry) {
  return `gutenberg:${String(entry.id)}`;
}

// ── URLs ─────────────────────────────────────────────────────────────────────
// Preference order: the canonical UTF-8 plain text first, then the older
// per-file layouts some works still use. We never construct a URL we have not
// confirmed works — covers go through probeImage(), text through the
// try-each-candidate helper.

const textCandidates = gid => [
  `https://www.gutenberg.org/cache/epub/${gid}/pg${gid}.txt.utf-8`,
  `https://www.gutenberg.org/ebooks/${gid}.txt.utf-8`,
  `https://www.gutenberg.org/files/${gid}/${gid}-0.txt`,
  `https://www.gutenberg.org/files/${gid}/${gid}.txt`,
];

const coverCandidates = gid => [
  `https://www.gutenberg.org/cache/epub/${gid}/pg${gid}.cover.medium.jpg`,
  `https://www.gutenberg.org/cache/epub/${gid}/pg${gid}.cover.small.jpg`,
];

// ── Licence boilerplate ──────────────────────────────────────────────────────

const START_RE = /^\*\*\*\s*START OF (?:TH(?:E|IS)\s+)?PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*$/im;
const END_RE = /^\*\*\*\s*END OF (?:TH(?:E|IS)\s+)?PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*$/im;
// Pre-2006 files used a "small print" block instead of the *** markers.
const LEGACY_START_RE = /^\*END\*THE SMALL PRINT![^\n]*$/im;
const LEGACY_END_RE = /^End of (?:the )?(?:Project Gutenberg|PROJECT GUTENBERG)[^\n]*$/im;

/**
 * Split a raw Gutenberg download into { header, body }.
 * `header` is the bibliographic front page, `body` is the work itself with all
 * licence boilerplate removed. Throws when the markers are missing entirely and
 * the file does not look like a Gutenberg text at all.
 */
export function stripBoilerplate(raw) {
  const text = normalizeText(raw);

  let header = '';
  let body = text;

  const start = START_RE.exec(text) || LEGACY_START_RE.exec(text);
  if (start) {
    header = text.slice(0, start.index);
    body = text.slice(start.index + start[0].length);
  }

  const end = END_RE.exec(body);
  if (end) {
    body = body.slice(0, end.index);
  } else {
    const legacy = LEGACY_END_RE.exec(body);
    if (legacy) body = body.slice(0, legacy.index);
  }

  // Some files repeat the production credits under the START marker.
  body = body.replace(/^\s*(?:Produced by|E-?text prepared by|Transcribed from)[^\n]*(?:\n[ \t]+[^\n]*)*\n/i, '');

  if (!start && !/project gutenberg/i.test(text.slice(0, 4000))) {
    throw new Error('does not look like a Project Gutenberg text (no START marker, no header)');
  }
  return { header: header.trim(), body: body.trim() };
}

/** Pull `Title:` / `Author:` / `Language:` out of the Gutenberg header block. */
export function parseHeader(header) {
  const out = {};
  const re = /^(Title|Author|Language|Release date|Translator|Editor|Illustrator|Credits)[ \t]*:[ \t]*([^\n]*(?:\n[ \t]+[^\n]+)*)/gim;
  let m;
  while ((m = re.exec(header))) {
    const key = m[1].toLowerCase().replace(/\s+/g, '');
    if (!(key in out)) out[key] = tidy(m[2]);
  }
  return out;
}

// ── Heading detection ────────────────────────────────────────────────────────

const ROMAN = 'ivxlcdm';
const KEYWORDS = 'chapter|letter|part|book|canto|act|scene|volume|section|story|stave|epoch|epilogue|prologue|preface|introduction|conclusion|foreword|postscript|finale';
const KEYWORD_RE = new RegExp(
  `^(${KEYWORDS})\\b[ \\t]*` +                        // 1: keyword
  `((?:the[ \\t]+)?[0-9]+(?:st|nd|rd|th)?|[${ROMAN}]+|[a-z\\-]+)?` + // 2: numeral / spelled number
  `[ \\t]*[.:—–-]?[ \\t]*` +
  `(.*)$`,                                            // 3: inline title
  'i');
// A line that is nothing but a numeral: "I.", "XVII", "42."
const BARE_NUM_RE = new RegExp(`^([0-9]{1,3}|[${ROMAN.toUpperCase()}]{1,7})\\.?$`);

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, first: 1, second: 2, third: 3,
};

/** Roman numeral → number, or null. Deliberately forgiving. */
export function romanToNumber(s) {
  const t = String(s || '').toUpperCase();
  if (!/^[IVXLCDM]+$/.test(t)) return null;
  const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = v[t[i]], next = v[t[i + 1]] || 0;
    n += cur < next ? -cur : cur;
  }
  return n || null;
}

function numeralValue(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/^the[ \t]+/, '');
  if (/^\d+/.test(s)) return parseInt(s, 10);
  if (WORD_NUMBERS[s] != null) return WORD_NUMBERS[s];
  return romanToNumber(s);
}

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** "TWO" -> "Two", "ii" -> "II", "12" -> "12". */
function printNumeral(numeral) {
  const s = String(numeral).replace(/^the[ \t]+/i, '').trim();
  if (/^\d/.test(s)) return s;
  if (WORD_NUMBERS[s.toLowerCase()] != null) return titleCase(s);
  return s.toUpperCase();
}

const STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'in', 'on', 'to', 'with',
  'for', 'from', 'at', 'by', 'into', 'over', 'under', 'after', 'before', 'that', 'his', 'her']);

/** Are the significant words capitalised? Distinguishes a title from a sentence. */
function titleish(text) {
  const words = text.replace(/[.!?]$/, '').split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));
  if (!words.length) return false;
  const caps = words.filter(w => /^[A-Z]/.test(w)).length;
  return caps / words.length >= 0.8;
}

/**
 * Is this line a chapter heading? Returns a descriptor or null.
 * Requires the line to stand alone (blank line before) so that tables of
 * contents and mid-paragraph sentences are not mistaken for headings.
 */
function headingAt(lines, i) {
  const raw = lines[i];
  const line = raw.trim();
  if (!line || line.length > 72) return null;
  if (i > 0 && lines[i - 1].trim()) return null;               // must follow a blank line

  const kw = KEYWORD_RE.exec(line);
  if (kw) {
    const keyword = kw[1].toLowerCase();
    const numeral = kw[2] || null;
    let inline = tidy(kw[3] || '');
    // "Chapter" with neither a number nor a title is not a heading, it is prose.
    const standalone = /^(epilogue|prologue|preface|introduction|conclusion|foreword|postscript|finale)$/.test(keyword);
    if (!numeral && !standalone && !inline) return null;
    if (numeral && numeralValue(numeral) == null && !standalone) {
      // "Chapter of accidents" — a sentence, not a heading.
      if (!/^[0-9]/.test(numeral)) return null;
    }
    inline = inline.replace(/^[.:—–-]+[ \t]*/, '').trim();
    const printedNum = numeral ? printNumeral(numeral) : null;
    const labelBits = [titleCase(keyword)];
    if (printedNum) labelBits.push(printedNum);
    return {
      keyword,
      num: numeralValue(numeral),
      label: labelBits.join(' '),
      title: inline || null,
      isGroup: /^(part|book|volume|epoch)$/.test(keyword),
    };
  }

  const bare = BARE_NUM_RE.exec(line);
  if (bare) {
    // Only trust a bare numeral if the line after it is blank too — otherwise it
    // is a footnote marker or a list item.
    if (lines[i + 1] != null && lines[i + 1].trim()) return null;
    const printed = bare[1].replace(/\.$/, '');
    return {
      keyword: 'chapter',
      num: numeralValue(printed),
      label: printed,
      title: null,
      isGroup: false,
    };
  }
  return null;
}

/**
 * A short standalone line that is a chapter subtitle rather than the first
 * sentence of the chapter — "CHAPTER I." on one line, "Down the Rabbit-Hole."
 * on the next. Conservative on purpose: when in doubt it stays prose.
 */
function looksLikeSubtitle(text) {
  const t = text.trim();
  if (!t || t.length > 70 || t.includes('\n')) return false;
  if (/[;,:]$/.test(t)) return false;
  if (/[.!?]["')]?\s/.test(t)) return false;              // more than one sentence
  if (!/^[A-Z0-9"'(]/.test(t)) return false;
  if (/[.!?]$/.test(t)) return t === t.toUpperCase() || titleish(t);
  return true;
}

/**
 * Split a de-boilerplated body into sections on the work's own headings.
 * Returns [{ label, title, num, volume, body }] in reading order.
 */
export function splitChapters(body) {
  const lines = body.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines, i);
    if (h) marks.push({ ...h, line: i });
  }

  if (!marks.length) return [];

  const sections = [];
  const front = lines.slice(0, marks[0].line).join('\n').trim();
  if (countWords(front) >= 400) {
    sections.push({ label: 'Front Matter', title: null, num: null, volume: null, body: front });
  }

  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    const from = m.line + 1;
    const to = k + 1 < marks.length ? marks[k + 1].line : lines.length;
    let text = lines.slice(from, to).join('\n').trim();
    let title = m.title;

    // "CHAPTER I." on one line, "The Boy Who Lived" on the next.
    if (!title) {
      const firstPara = text.split(/\n[ \t]*\n/, 1)[0] || '';
      if (looksLikeSubtitle(firstPara)) {
        title = tidy(firstPara);
        text = text.slice(firstPara.length).trim();
      }
    }
    sections.push({
      label: m.label,
      title,
      num: m.num,
      isGroup: m.isGroup,
      words: countWords(text),
      body: text,
    });
  }

  // Tables of contents: an entry whose heading repeats later with a real body.
  const laterBodies = new Map();
  for (const s of sections) {
    const key = `${s.label}|${s.title || ''}`;
    laterBodies.set(key, (laterBodies.get(key) || 0) + (s.words >= 60 ? 1 : 0));
  }
  const kept = sections.filter(s => {
    if (s.label === 'Front Matter') return true;
    const key = `${s.label}|${s.title || ''}`;
    return !(s.words < 60 && laterBodies.get(key) > 0);
  });

  // "BOOK ONE" style group headings carry no prose — fold them into the titles
  // of the chapters that follow, and record the group number as `volume`.
  const out = [];
  let group = null;
  let groupNum = null;
  for (const s of kept) {
    if (s.isGroup && s.words < 60) {
      group = [s.label, s.title].filter(Boolean).join(': ');
      groupNum = s.num;
      continue;
    }
    if (!s.body || s.words < 5) continue;
    const own = [s.label, s.title].filter(Boolean).join(': ');
    out.push({
      label: group ? `${group} · ${own}` : own,
      volume: groupNum,
      body: s.body,
    });
  }
  return out;
}

/** No headings at all: chop the text into readable parts on paragraph limits. */
export function chunkChapters(body, targetWords = 2500) {
  const paras = body.split(/\n[ \t]*\n+/).filter(p => p.trim());
  const out = [];
  let buf = [];
  let words = 0;
  for (const p of paras) {
    buf.push(p);
    words += countWords(p);
    if (words >= targetWords) {
      out.push({ label: `Part ${out.length + 1}`, volume: null, body: buf.join('\n\n') });
      buf = [];
      words = 0;
    }
  }
  if (buf.length) out.push({ label: `Part ${out.length + 1}`, volume: null, body: buf.join('\n\n') });
  return out;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export async function build(entry, ctx) {
  const gid = String(entry.id);
  const sid = entryId(entry);
  const log = ctx.log;
  const maxChapters = entry.maxChapters ?? ctx.defaults?.maxChapters ?? 40;

  const { url, text } = await getTextFromFirst(textCandidates(gid), { log, timeout: 90000 });
  log.debug(`    text from ${url} (${text.length} bytes)`);

  const { header, body } = stripBoilerplate(text);
  const meta = parseHeader(header);

  let sections = splitChapters(body);
  if (sections.length < 2) {
    log.debug(`    no usable headings — falling back to fixed-size parts`);
    sections = chunkChapters(body);
  }
  const total = sections.length;
  if (!total) throw new Error('no chapters could be extracted from the text');

  const truncated = total > maxChapters;
  if (truncated) sections = sections.slice(0, maxChapters);

  const rawTitle = firstOf(entry.title, meta.title, `Project Gutenberg #${gid}`);
  // "Frankenstein; Or, The Modern Prometheus" reads better split in two.
  const split = /^([^;]{3,60});\s*(?:or,?\s*)?(.+)$/i.exec(rawTitle);
  const title = split ? tidy(split[1]) : tidy(rawTitle);
  const altTitles = [];
  if (split) altTitles.push(tidy(rawTitle));
  if (meta.title && meta.title !== rawTitle) altTitles.push(tidy(meta.title));

  const cover = await firstWorkingImage(coverCandidates(gid), { log });
  if (!cover) log.debug(`    no cover found for #${gid} — leaving it null`);

  const files = [];
  const chapters = sections.map((sec, i) => {
    const cid = chapterId(i + 1);
    const blocks = textToBlocks(sec.body, { heading: sec.label });
    const file = textChapterFile({
      seriesId: sid,
      id: cid,
      num: i + 1,
      title: sec.label,
      blocks,
    });
    files.push(file);
    return {
      id: cid,
      num: i + 1,
      volume: sec.volume ?? null,
      title: sec.label,
      updatedAt: null,
      lang: entry.language || ctx.language || 'en',
      wordCount: file.wordCount,
      src: chapterSrc(sid, cid),
    };
  });

  const words = files.reduce((n, f) => n + f.wordCount, 0);
  const descBits = [];
  if (entry.description) descBits.push(entry.description);
  else descBits.push(`${title}${meta.author ? ` by ${meta.author}` : ''}. Public-domain text from Project Gutenberg.`);
  if (truncated) {
    descBits.push(`This sample ships the first ${sections.length} of ${total} chapters to keep the bundled catalogue small; the full text is at gutenberg.org.`);
  }

  const series = {
    id: sid,
    type: entry.type,
    title,
    altTitles: [...new Set(altTitles)],
    cover,
    description: descBits.join(' '),
    author: firstOf(entry.author, meta.author),
    artist: null,
    status: 'completed',
    genres: entry.genres || [],
    tags: ['public-domain', 'project-gutenberg'],
    language: entry.language || ctx.language || 'en',
    source: 'gutenberg',
    sourceUrl: `https://www.gutenberg.org/ebooks/${gid}`,
    readingDirection: null,
    updatedAt: null,
    chapterCount: chapters.length,
    chapters,
  };

  return { series, files, stats: { words, truncatedFrom: truncated ? total : null } };
}
