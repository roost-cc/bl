import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue } from '../../config/check.js';
import { canonical, changed, empty, schema } from './rank.js';

test('the schema takes a list of ids, and refuses other shapes', () => {
  assert.deepEqual(checkValue(schema, ['F-1', 'S-2']), []);
  assert.deepEqual(checkValue(schema, empty), []);
  for (const bad of [{}, ['F-1', 3], ['']]) assert.notDeepEqual(checkValue(schema, bad), [], JSON.stringify(bad));
});

test('the canonical form keeps the order, and keeps a repeat for the check to refuse', () => {
  assert.deepEqual(canonical(['S-2', 'F-1', 'S-2']), ['S-2', 'F-1', 'S-2']);
});

test('changed gives each node added, removed or with another predecessor', () => {
  assert.deepEqual(changed(['A', 'B', 'C', 'D'], ['A', 'C', 'D', 'E']).sort(), ['B', 'C', 'E']);
  assert.deepEqual(changed(['A', 'B'], ['B', 'A']).sort(), ['A', 'B']);
  assert.deepEqual(changed(['A', 'B'], ['A', 'B']), []);
});
