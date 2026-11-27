import { test } from 'node:test';
import assert from 'node:assert/strict';
import { celEnvironment } from '../../config/cel.js';
import { checkValue } from '../../config/check.js';
import { canonical, changed, check, empty, kind, merge, names, schema } from './dependency.js';

const DONE = 'status == "done"';

/** The part of a store context that the dependency check reads: the CEL inputs of a load. */
const CTX = { config: { celInputs: { predicates: {} } } };

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

test('names gives the gated item and the item of each of its entries, or none for an item with no entry', () => {
  const value = { 'S-1': { done: [{ 'S-2': DONE }, { 'S-1': 'true' }], refined: [{ 'F-3': DONE }] } };
  assert.deepEqual(names(value, 'S-1'), ['S-1', 'S-2', 'S-1', 'F-3']);
  assert.deepEqual(names(value, 'S-2'), []);
});

test('kind gives one cycle fault for each cycle, and counts no self-entry as an edge', () => {
  assert.deepEqual(kind({ 'S-12': { refined: [{ 'S-12': 'now > timestamp("2026-12-24T00:00:00Z")' }] } }), []);
  assert.deepEqual(kind({ 'S-1': { done: [{ 'S-2': DONE }] }, 'S-2': { refined: [{ 'S-3': DONE }] } }), []);
  assert.deepEqual(kind(empty), []);
  assert.deepEqual(
    kind({
      'S-1': { in_progress: [{ 'S-2': DONE }, { 'S-1': 'true' }] },
      'S-2': { done: [{ 'S-3': DONE }], refined: [{ 'S-1': DONE }] },
      'S-3': { done: [{ 'S-3': DONE }] },
      'F-1': { done: [{ 'F-2': DONE }] },
      'F-2': { done: [{ 'F-1': DONE }] },
    }),
    [
      { item: 'F-1', rule: 'cycle', path: '/F-1', message: 'F-1 → F-2 → F-1 is a cycle' },
      { item: 'S-1', rule: 'cycle', path: '/S-1', message: 'S-1 → S-2 → S-1 is a cycle' },
    ],
  );
});

test("check gives a cel fault with the compiler's message for an expression that does not compile or is not bool", () => {
  const BROKEN = 'status ==';
  const compiler = String(celEnvironment(CTX.config.celInputs).check(BROKEN).error?.message).split('\n')[0];
  assert.ok(compiler.length > 0);
  const value = {
    'S-1': { in_progress: [{ 'S-2': DONE }, { 'S-3': BROKEN }], done: [{ 'S-4': 'title' }] },
    'S-5': { done: [{ 'S-6': BROKEN }] },
  };
  assert.deepEqual(check(value, ['S-1'], CTX), [
    { item: 'S-1', rule: 'cel', path: '/S-1/in_progress/1/S-3', message: compiler },
    { item: 'S-1', rule: 'cel', path: '/S-1/done/0/S-4', message: 'the type is string, not bool' },
  ]);
  assert.deepEqual(check(value, ['S-6', 'S-2'], CTX), []);
  assert.deepEqual(
    check({ 'S-1': { done: [{ 'S-2': DONE }, { 'S-1': 'now > timestamp("2026-12-24T00:00:00Z")' }] } }, ['S-1'], CTX),
    [],
  );
});

test('merge keeps each entry as the side that added or removed it left it', () => {
  const base = { 'S-1': { done: [{ 'S-2': DONE }, { 'S-3': DONE }] }, 'S-4': { done: [{ 'S-2': DONE }] } };
  const ours = {
    'S-1': { done: [{ 'S-3': DONE }, { 'S-5': DONE }] },
    'S-4': { done: [{ 'S-2': DONE }] },
    'S-6': { refined: [{ 'S-1': DONE }] },
  };
  const theirs = {
    'S-1': { done: [{ 'S-2': DONE }, { 'S-3': DONE }, { 'S-5': 'true' }], refined: [{ 'S-7': DONE }] },
  };
  assert.deepEqual(merge(base, ours, theirs), {
    'S-1': { done: [{ 'S-3': DONE }, { 'S-5': DONE }, { 'S-5': 'true' }], refined: [{ 'S-7': DONE }] },
    'S-6': { refined: [{ 'S-1': DONE }] },
  });
});

test('merge keeps an entry that both sides added once, and drops one that both removed', () => {
  const base = { 'S-1': { done: [{ 'S-2': DONE }] } };
  const both = { 'S-1': { done: [{ 'S-3': DONE }] } };
  assert.deepEqual(merge(base, both, both), both);
  assert.deepEqual(merge(base, empty, empty), empty);
});
