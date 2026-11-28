/**
 * The pager (F-138 D8, Decision A9): `$PAGER`, else `less`, else `more`, else
 * stdout, with fake pager scripts that copy their stdin and their `LESS` to
 * files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { withEnv } from '../test/helpers/env.js';
import { fakePager } from '../test/helpers/fake-pager.js';
import { recorder, stderrOf } from '../test/helpers/streams.js';
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

test('pager_counts_template_control_line_breaks: every line break of a table is a line', () => {
  for (const brk of ['\n', '\r\n', '\v', '\f', '\r', '\x85', ' ', ' ']) {
    for (const [text, rows, paged] of [
      [`a${brk}b`, 1, true],
      [`a${brk}b`, 2, false],
      [`a${brk}b${brk}`, 1, true],
      [`a${brk}b${brk}`, 2, false],
    ]) {
      const pager = fakePager('pager');
      const written = withEnv({ PAGER: pager.script }, () => pageOn(text, rows));
      assert.deepEqual([written, pager.input()], paged ? ['', text] : [text, null], JSON.stringify([text, rows]));
    }
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

/** `page` of `TALL` on a 5-row terminal under `env`; give what it wrote to stdout and its status. */
function pageTall(env) {
  const { stream, chunks } = recorder({ terminal: { rows: 5, columns: 80 } });
  const status = withEnv(env, () => page(TALL, stream));
  return { written: chunks.join(''), status };
}

test('page_reports_pager_failure_without_losing_text: only less and more that are not on PATH leave the text on stdout', () => {
  const empty = mkTempDir('bl-pager-none-');
  const notExecutable = join(mkTempDir('bl-pager-noexec-'), 'pager');
  writeFileSync(notExecutable, '#!/bin/sh\n');
  assert.deepEqual(pageTall({ PAGER: undefined, PATH: empty }), { written: TALL, status: 0 });
  // A broken $PAGER fails the command with the shell's status (Decision A10).
  for (const [label, env, status] of [
    ['$PAGER is missing (shell status 127)', { PAGER: 'definitely_missing_f138_pager', PATH: empty }, 127],
    ['$PAGER is not executable (shell status 126)', { PAGER: notExecutable }, 126],
  ]) {
    assert.deepEqual(pageTall(env), { written: '', status }, label);
  }
});

test('pager_does_not_repeat_partial_output_on_failure: a pager that ran and failed gives its status and no text', () => {
  for (const status of [0, 1, 3, 126, 127]) {
    for (const [label, name] of [
      ['$PAGER', 'pager'],
      ['less', 'less'],
      ['more, with less missing', 'more'],
    ]) {
      const pager = fakePager(name, { status });
      const env = name === 'pager' ? { PAGER: pager.script } : { PAGER: undefined, PATH: pager.dir };
      assert.deepEqual(pageTall(env), { written: '', status }, `${label} exits ${status}`);
      // The pager read the whole text, and may have shown part of it.
      assert.equal(pager.input(), TALL, `${label} exits ${status}`);
    }
  }
  const failing = (name) => fakePager(name, { status: 3 });
  // less that exits nonzero does not fall through to more.
  const less = failing('less');
  const more = fakePager('more');
  assert.deepEqual(pageTall({ PAGER: undefined, PATH: `${less.dir}${delimiter}${more.dir}` }), {
    written: '',
    status: 3,
  });
  assert.equal(more.input(), null);
});

test('with PAGER unset and neither less nor more on PATH, the text goes to stdout with no message', () => {
  const empty = mkTempDir('bl-pager-none-');
  const { value, chunks } = stderrOf(() => withEnv({ PAGER: undefined, PATH: empty }, () => pageOn(TALL, 5)));
  assert.equal(value, TALL);
  assert.deepEqual(chunks, []);
});
