import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue } from '../../config/check.js';
import { canonical, changed, check, empty, kind, names, schema } from './rank.js';

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

test('names gives the node when the chain holds it, else none', () => {
  assert.deepEqual(names(['F-1', 'S-2'], 'S-2'), ['S-2']);
  assert.deepEqual(names(['F-1'], 'S-2'), []);
});

test('kind gives one repeat fault for each node that the chain holds more than once', () => {
  assert.deepEqual(kind(['F-1', 'S-2', 'F-3']), []);
  assert.deepEqual(kind(empty), []);
  assert.deepEqual(kind(['F-1', 'S-2', 'F-1', 'S-3', 'S-2', 'F-1']), [
    { item: 'F-1', rule: 'repeat', path: '/2', message: 'F-1 is at the places 1, 3, 6; it may be in the chain once' },
    { item: 'S-2', rule: 'repeat', path: '/4', message: 'S-2 is at the places 2, 5; it may be in the chain once' },
  ]);
});

test('check gives not-work-unit to each node of ids that is not its own work unit', () => {
  /** S-2 is in the feature F-1; T-1 is of no work type. */
  const units = { 'F-1': 'F-1', 'S-1': 'S-1', 'S-2': 'F-1', 'T-1': null };
  const unitOf = (/** @type {string} */ id) => /** @type {Record<string, string|null>} */ (units)[id];
  const chain = ['F-1', 'S-1', 'S-2', 'T-1'];
  assert.deepEqual(check(chain, ['F-1', 'S-1'], {}, unitOf), []);
  assert.deepEqual(check(chain, ['S-2', 'T-1'], {}, unitOf), [
    { item: 'S-2', rule: 'not-work-unit', path: '/2', message: 'S-2 is no work unit: it belongs to F-1' },
    { item: 'T-1', rule: 'not-work-unit', path: '/3', message: 'T-1 is no work unit and belongs to none' },
  ]);
  assert.deepEqual(check(['F-1'], ['S-2'], {}, unitOf), []);
});
