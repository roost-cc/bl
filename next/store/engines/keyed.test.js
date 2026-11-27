import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeByKey } from './keyed.js';

/**
 * A map of key → value from an object.
 * @param {Record<string, unknown>} object
 */
const map = (object) => new Map(Object.entries(object));

test('mergeByKey keeps a key that one side added, and one that both sides added alike', () => {
  const base = map({ a: 1 });
  assert.deepEqual(mergeByKey(base, map({ a: 1, b: 2 }), map({ a: 1, c: 3 })), map({ a: 1, b: 2, c: 3 }));
  assert.deepEqual(mergeByKey(base, map({ a: 1, b: 2 }), map({ a: 1, b: 2 })), map({ a: 1, b: 2 }));
});

test('mergeByKey drops a key that one side removed and the other left alone', () => {
  const base = map({ a: 1, b: 2 });
  assert.deepEqual(mergeByKey(base, map({ b: 2 }), map({ a: 1, b: 2 })), map({ b: 2 }));
  assert.deepEqual(mergeByKey(base, map({ a: 1, b: 2 }), map({ a: 1 })), map({ a: 1 }));
  assert.deepEqual(mergeByKey(base, map({ b: 2 }), map({ b: 2 })), map({ b: 2 }));
});

test('mergeByKey keeps a key that one side changed, compared by JSON text', () => {
  const base = map({ a: [1] });
  assert.deepEqual(mergeByKey(base, map({ a: [2] }), map({ a: [1] })), map({ a: [2] }));
  assert.deepEqual(mergeByKey(base, map({ a: [1] }), map({ a: [3] })), map({ a: [3] }));
});

test('mergeByKey gives null for a key that the two sides changed two ways', () => {
  assert.equal(mergeByKey(map({ a: 1 }), map({ a: 2 }), map({ a: 3 })), null);
  assert.equal(mergeByKey(map({ a: 1 }), map({ a: 2 }), map({})), null);
  assert.equal(mergeByKey(map({}), map({ a: 2 }), map({ a: 3 })), null);
});
