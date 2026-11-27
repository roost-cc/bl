import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue } from '../../config/check.js';
import { canonical, changed, empty, schema } from './dependency.js';

const DONE = 'status == "done"';

test('the schema takes gated items, statuses and one-item entries, and refuses other shapes', () => {
  assert.deepEqual(checkValue(schema, { 'S-12': { in_progress: [{ 'S-44': DONE }, { 'S-45': DONE }] } }), []);
  assert.deepEqual(checkValue(schema, empty), []);
  for (const bad of [
    [],
    { 'S-12': [] },
    { 'S-12': { in_progress: {} } },
    { 'S-12': { in_progress: [{}] } },
    { 'S-12': { in_progress: [{ 'S-44': DONE, 'S-45': DONE }] } },
    { 'S-12': { in_progress: [{ 'S-44': true }] } },
    { 'S-12': { in_progress: [{ '': DONE }] } },
  ]) {
    assert.notDeepEqual(checkValue(schema, bad), [], JSON.stringify(bad));
  }
});

test('the canonical form sorts items, statuses and entries, drops repeats and empty statuses and items', () => {
  const value = {
    'S-9': { refined: [] },
    'S-12': {
      refined: [{ 'S-12': 'now > timestamp("2026-12-24T00:00:00Z")' }],
      in_progress: [{ 'S-45': DONE }, { 'S-44': 'true' }, { 'S-44': DONE }, { 'S-45': DONE }],
    },
  };
  const result = canonical(value);
  assert.deepEqual(result, {
    'S-12': {
      in_progress: [{ 'S-44': DONE }, { 'S-44': 'true' }, { 'S-45': DONE }],
      refined: [{ 'S-12': 'now > timestamp("2026-12-24T00:00:00Z")' }],
    },
  });
  assert.deepEqual(Object.keys(result['S-12']), ['in_progress', 'refined']);
  assert.deepEqual(canonical(result), result);
});

test('changed gives each gated item whose entries differ, and none whose entries only read in another order', () => {
  const before = { 'S-1': { done: [{ 'S-2': DONE }, { 'S-3': DONE }] }, 'S-4': { done: [{ 'S-2': DONE }] } };
  const after = { 'S-1': { done: [{ 'S-3': DONE }, { 'S-2': DONE }] }, 'S-4': { done: [{ 'S-2': 'true' }] } };
  assert.deepEqual(changed(before, after), ['S-4']);
});
