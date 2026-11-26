/**
 * The pager (F-138 D8, Decision A9): `$PAGER`, else `less`, else `more`, else
 * stdout, with fake pager scripts that copy their stdin and their `LESS` to
 * files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter } from 'path';
import { withEnv } from '../test/helpers/env.js';
import { fakePager } from '../test/helpers/fake-pager.js';
import { recorder } from '../test/helpers/streams.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { page } from './pager.js';

/** A text of `n` lines. */
const linesOf = (n) => Array.from({ length: n }, (_v, i) => `line ${i + 1}\n`).join('');
const TALL = linesOf(10);

/** `page` on a fake terminal of `rows` rows (or off a terminal); resolve with what it wrote to stdout. */
function pageOn(text, rows) {
  const { stream, chunks } = rows === null ? recorder() : recorder({ terminal: { rows, columns: 80 } });
  page(text, stream);
  return chunks.join('');
}

test('a 10-line text on a 5-row terminal goes to $PAGER on its stdin, with LESS=FRX when LESS is unset', () => {
  const pager = fakePager('pager');
  const written = withEnv({ PAGER: pager.script, LESS: undefined }, () => pageOn(TALL, 5));
  assert.equal(written, '');
  assert.equal(pager.input(), TALL);
  assert.equal(pager.less(), 'FRX');
});

test("an operator's LESS is kept, and $PAGER runs through a shell", () => {
  const pager = fakePager('pager');
  withEnv({ PAGER: `${pager.script} --some-flag`, LESS: 'R' }, () => pageOn(TALL, 5));
  assert.equal(pager.input(), TALL);
  assert.equal(pager.less(), 'R');
});

test('a 3-line text, a text that fits, or stdout off a terminal runs no pager', () => {
  const pager = fakePager('pager');
  withEnv({ PAGER: pager.script }, () => {
    assert.equal(pageOn(linesOf(3), 5), linesOf(3));
    assert.equal(pageOn(linesOf(5), 5), linesOf(5));
    assert.equal(pageOn(TALL, null), TALL);
  });
  assert.equal(pager.input(), null);
});

test('pager_counts_final_line_without_newline: a last line with no newline is a line', () => {
  for (const [text, rows, paged] of [
    ['first\nsecond', 1, true],
    ['first\nsecond', 2, false],
    ['first\nsecond\n', 1, true],
    ['first\nsecond\n', 2, false],
    ['only', 1, false],
    ['', 0, false],
    [`${linesOf(4)}last`, 4, true],
    [`${linesOf(4)}last`, 5, false],
  ]) {
    const pager = fakePager('pager');
    const written = withEnv({ PAGER: pager.script }, () => pageOn(text, rows));
    assert.deepEqual([written, pager.input()], paged ? ['', text] : [text, null], JSON.stringify([text, rows]));
  }
});

test('with PAGER unset or empty and only more on PATH, more gets the text on its stdin', () => {
  for (const PAGER of [undefined, '', '  ']) {
    const more = fakePager('more');
    const written = withEnv({ PAGER, LESS: undefined, PATH: more.dir }, () => pageOn(TALL, 5));
    assert.equal(written, '');
    assert.equal(more.input(), TALL);
    assert.equal(more.less(), 'FRX');
  }
});

test('with PAGER unset and less on PATH, less gets the text, and more does not run', () => {
  const less = fakePager('less');
  const more = fakePager('more');
  withEnv({ PAGER: undefined, PATH: `${less.dir}${delimiter}${more.dir}` }, () => pageOn(TALL, 5));
  assert.equal(less.input(), TALL);
  assert.equal(more.input(), null);
});

test('with PAGER unset and neither less nor more on PATH, the text goes to stdout with no message', () => {
  const empty = mkTempDir('bl-pager-none-');
  const errors = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => errors.push(String(chunk)) > 0;
  try {
    assert.equal(
      withEnv({ PAGER: undefined, PATH: empty }, () => pageOn(TALL, 5)),
      TALL,
    );
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(errors, []);
});
