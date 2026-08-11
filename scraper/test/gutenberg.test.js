// Boilerplate stripping for Project Gutenberg sources.
//
// The rules here decide what of a Gutenberg download we actually redistribute.
// Everything the stripper leaves behind ships in `chapters/`, so a rule that
// under-strips puts licence apparatus — and the Project Gutenberg trademark —
// into text this repository presents as plain public domain
// (docs/ARCHITECTURE.md §8, COPYRIGHT.md).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stripBoilerplate } from '../src/sources/gutenberg.js';

/** Wrap a body in the START/END markers a real download carries. */
const wrap = (body) =>
  `Title: Test\nAuthor: Someone\n\n` +
  `*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n\n` +
  `${body}\n\n` +
  `*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\n`;

const bodyOf = (raw) => stripBoilerplate(wrap(raw)).body;

describe('stripBoilerplate — licence markers', () => {
  test('keeps the work and drops everything outside the markers', () => {
    const body = bodyOf('CHAPTER I.\n\nCall me Ishmael.');
    assert.match(body, /Call me Ishmael\./);
    assert.doesNotMatch(body, /START OF/);
    assert.doesNotMatch(body, /END OF/);
  });

  test('the header is returned separately, not in the body', () => {
    const { header, body } = stripBoilerplate(wrap('CHAPTER I.\n\nReal text.'));
    assert.match(header, /Title: Test/);
    assert.doesNotMatch(body, /Title: Test/);
  });

  test('a file that is not a Gutenberg text at all throws', () => {
    assert.throws(() => stripBoilerplate('Just some prose with no markers anywhere.'));
  });
});

describe('stripBoilerplate — production credits', () => {
  test('drops a "Produced by" credit repeated under the START marker', () => {
    const body = bodyOf('Produced by Some Volunteer and the Online\n  Distributed Proofreaders\n\nCHAPTER I.\n\nReal text.');
    assert.doesNotMatch(body, /Produced by/);
    assert.match(body, /Real text\./);
  });
});

describe("stripBoilerplate — transcriber's notes", () => {
  // The Moby-Dick (gutenberg:2701) case: the note survived into chapter one of
  // the committed catalogue, carrying the trademark with it.
  test('drops the note heading and the paragraph under it', () => {
    const body = bodyOf(
      'Original Transcriber’s Notes:\n\n' +
        'This text is a combination of etexts, one from the now-defunct ERIS\n' +
        'project at Virginia Tech and one from Project Gutenberg’s archives.\n\n' +
        'ETYMOLOGY.\n\nCall me Ishmael.',
    );
    assert.doesNotMatch(body, /Transcriber/i);
    assert.doesNotMatch(body, /Project Gutenberg/i);
    assert.match(body, /ETYMOLOGY\./);
    assert.match(body, /Call me Ishmael\./);
  });

  test("handles a straight apostrophe and the singular 'Note'", () => {
    const body = bodyOf("Transcriber's Note:\n\nSome apparatus here.\n\nCHAPTER I.\n\nReal text.");
    assert.doesNotMatch(body, /apparatus/);
    assert.match(body, /Real text\./);
  });

  // The rule is deliberately narrow: it may only remove a paragraph sitting
  // directly beneath an explicit note heading, never prose that happens to
  // mention a transcriber.
  test('leaves prose that merely mentions a transcriber alone', () => {
    const body = bodyOf(
      'CHAPTER I.\n\nThe transcriber notes in his diary that the day was cold.\n\nHe went on regardless.',
    );
    assert.match(body, /The transcriber notes in his diary/);
    assert.match(body, /He went on regardless\./);
  });

  test('leaves a body with no note untouched', () => {
    const body = bodyOf('CHAPTER I.\n\nIt is a truth universally acknowledged.\n\nCHAPTER II.\n\nMore.');
    assert.match(body, /It is a truth universally acknowledged\./);
    assert.match(body, /CHAPTER II\./);
  });
});
