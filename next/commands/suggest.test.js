/** The closest names for a typo (F-138 D3 step 4). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from './suggest.js';

test('suggest gives the name at the smallest distance when it is 2 or less', () => {
  assert.deepEqual(suggest('lsit', ['item', 'list', 'report']), ['list']);
  assert.deepEqual(suggest('--jsn', ['--help', '--json', '-h']), ['--json']);
});

test('suggest gives none when every name is further than 2', () => {
  assert.deepEqual(suggest('xyz', ['item', 'list', 'report']), []);
  assert.deepEqual(suggest('xyz', []), []);
});

test('suggest gives every name at the smallest distance, in their order', () => {
  assert.deepEqual(suggest('lst', ['last', 'list', 'lost-and-found']), ['last', 'list']);
});
