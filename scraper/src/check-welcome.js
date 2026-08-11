#!/usr/bin/env node
// The tutorial content gate (Phase 7 §4.4b). Checks that the tutorial book,
// scraper/fixtures/welcome.json, still has the shape §5 of the plan binds:
//
//   - exactly 9 chapters
//   - every chapter opens with an h2 block
//   - 400-800 words per chapter (whitespace-split tokens across all block text)
//   - across the book: at least one blockquote, one ul or ol, one hr, one note
//   - zero img blocks (the committed cover is the book's only art)
//
// Runs as the second half of `npm run validate`. The prose is the writer's;
// the shape is CI's. Without this gate a 4-chapter, 200-word book would pass
// every other check and quietly hollow out the offline floor.
//
// Exit code 0 = valid, 1 = at least one violation (all of them reported).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { SCRAPER_ROOT } from './lib/util.js';
import { blocksWordCount } from './lib/blocks.js';

const WELCOME_PATH = join(SCRAPER_ROOT, 'fixtures', 'welcome.json');
const CHAPTER_COUNT = 9;
const MIN_WORDS = 400;
const MAX_WORDS = 800;

function main() {
  if (!existsSync(WELCOME_PATH)) {
    console.error(`check-welcome: ${WELCOME_PATH} does not exist — the tutorial book is gone.`);
    process.exit(1);
  }

  let book;
  try {
    book = JSON.parse(readFileSync(WELCOME_PATH, 'utf8'));
  } catch (e) {
    console.error(`check-welcome: welcome.json is not valid JSON — ${e.message}`);
    process.exit(1);
  }

  const violations = [];
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  if (!Array.isArray(book.chapters)) {
    violations.push('welcome.json: chapters must be an array');
  }
  if (chapters.length !== CHAPTER_COUNT) {
    violations.push(`welcome.json: expected exactly ${CHAPTER_COUNT} chapters, found ${chapters.length}`);
  }

  // Book-wide block-variety floor. The tutorial exists to demonstrate the
  // reader, so it must exercise the block types it talks about — and it must
  // ship no img blocks: nothing external, the committed cover is the only art.
  const counts = { blockquote: 0, ul: 0, ol: 0, hr: 0, note: 0, img: 0 };

  chapters.forEach((ch, i) => {
    const where = `chapter ${i + 1}${ch?.title ? ` ("${ch.title}")` : ''}`;
    const blocks = Array.isArray(ch?.blocks) ? ch.blocks : [];
    if (!blocks.length) {
      violations.push(`${where}: has no blocks`);
      return;
    }
    if (blocks[0]?.t !== 'h2') {
      violations.push(`${where}: must open with an h2 block (opens with "${blocks[0]?.t}")`);
    }
    for (const b of blocks) {
      if (b && b.t in counts) counts[b.t]++;
    }
    const words = blocksWordCount(blocks);
    if (words < MIN_WORDS || words > MAX_WORDS) {
      violations.push(`${where}: ${words} words — must be within ${MIN_WORDS}-${MAX_WORDS}`);
    }
  });

  if (counts.blockquote < 1) violations.push('welcome.json: the book needs at least one blockquote block');
  if (counts.ul + counts.ol < 1) violations.push('welcome.json: the book needs at least one ul or ol block');
  if (counts.hr < 1) violations.push('welcome.json: the book needs at least one hr block');
  if (counts.note < 1) violations.push('welcome.json: the book needs at least one note block');
  if (counts.img > 0) violations.push(`welcome.json: img blocks are not allowed (found ${counts.img}) — the committed cover is the book's only art`);

  if (violations.length) {
    for (const v of violations) console.error(`  ERROR ${v}`);
    console.error(`check-welcome: FAILED — ${violations.length} violation(s)`);
    process.exit(1);
  }

  const totalWords = chapters.reduce((n, ch) => n + blocksWordCount(ch.blocks), 0);
  console.log(`check-welcome: OK — ${chapters.length} chapters, ${totalWords.toLocaleString('en-US')} words, block floor met, no img blocks`);
  process.exit(0);
}

main();
