/**
 * Styles (F-138 D8): a style name to its formats, a cell's column and row
 * styles, and match highlighting, on a fake terminal whose color comes from
 * the environment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from '../test/helpers/env.js';
import { ESCAPE, recorder } from '../test/helpers/streams.js';
import { highlight, refusedFormats, styleCell, styleFormats } from './style.js';

const SCHEME = Object.freeze({ match: ['bold', 'yellow'], done: ['green'], blocked: ['red', 'underline'] });
const COLOR = { FORCE_COLOR: '1', NO_COLOR: undefined };
const NO_COLOR = { FORCE_COLOR: undefined, NO_COLOR: '1' };
const terminal = () => recorder({ terminal: { rows: 24, columns: 80 } }).stream;

test('a style name gives its formats; a name the scheme does not hold, or a failed style, gives none', () => {
  assert.deepEqual(styleFormats(SCHEME, 'done'), ['green']);
  assert.deepEqual(styleFormats(SCHEME, 'nope'), []);
  assert.deepEqual(styleFormats(SCHEME, undefined), []);
  assert.deepEqual(styleFormats(SCHEME, 3n), []);
  assert.deepEqual(styleFormats(SCHEME, 'toString'), []);
});

test("with FORCE_COLOR=1, a cell gets its column style's codes, then its row style's", () => {
  withEnv(COLOR, () => {
    const out = styleCell('S-1', SCHEME.done, SCHEME.blocked, terminal());
    // green, then red and underline: the row's red comes after the column's green, so it wins.
    assert.equal(out, '\u001b[32m\u001b[31m\u001b[4mS-1\u001b[24m\u001b[39m\u001b[39m');
    assert.ok(out.indexOf('\u001b[32m') < out.indexOf('\u001b[31m'));
    assert.equal(styleCell('S-1', [], [], terminal()), 'S-1');
  });
});

test('with NO_COLOR=1 on a terminal, a styled cell has no escape codes', () => {
  withEnv(NO_COLOR, () => {
    assert.equal(styleCell('S-1', SCHEME.done, SCHEME.blocked, terminal()), 'S-1');
  });
});

test('with FORCE_COLOR=1, each match gets the match style; with NO_COLOR=1, the text stays plain', () => {
  const text = 'a story about stories';
  withEnv(COLOR, () => {
    assert.equal(
      highlight(text, /stor/g, SCHEME, terminal()),
      'a \u001b[1m\u001b[33mstor\u001b[39m\u001b[22my about \u001b[1m\u001b[33mstor\u001b[39m\u001b[22mies',
    );
  });
  withEnv(NO_COLOR, () => {
    assert.doesNotMatch(highlight(text, /stor/g, SCHEME, terminal()), ESCAPE);
  });
});

test('refusedFormats gives the path of each format that util.styleText refuses', () => {
  assert.deepEqual(refusedFormats(SCHEME), []);
  assert.deepEqual(refusedFormats({ match: ['bold', 'blod'], 'a/b': ['#f9e2af', 'nope'] }), [
    { path: '/match/1', format: 'blod' },
    { path: '/a~1b/1', format: 'nope' },
  ]);
});
