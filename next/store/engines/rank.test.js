import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue } from '../../config/check.js';
import { canonical, changed, check, empty, kind, merge, names, placeInRank, schema } from './rank.js';

test('placeInRank puts a node that the chain does not hold first or last, and keeps one that it holds', () => {
  assert.deepEqual(placeInRank(['A', 'B'], 'C', 'first'), { chain: ['C', 'A', 'B'], placed: true });
  assert.deepEqual(placeInRank(['A', 'B'], 'C', 'last'), { chain: ['A', 'B', 'C'], placed: true });
  assert.deepEqual(placeInRank(['A', 'B'], 'B', 'first'), { chain: ['A', 'B'], placed: false });
  assert.deepEqual(placeInRank([], 'C', 'last'), { chain: ['C'], placed: true });
});

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

/**
 * The merge of three chains written as words of one-letter nodes.
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 */
const merged = (base, ours, theirs) => {
  const chain = (/** @type {string} */ text) => text.split(' ').filter(Boolean);
  return merge(chain(base), chain(ours), chain(theirs))?.join(' ') ?? null;
};

test("merge gives the results of Decision A3's examples", () => {
  assert.equal(merged('A B C', 'A B C Y', 'A B C Z'), 'A B C Y Z');
  assert.equal(merged('A B C', 'A Y B C', 'A Z B C'), 'A Y Z B C');
  assert.equal(merged('A B C', 'A C', 'A B Y C'), 'A Y C');
  assert.equal(merged('A B C', 'B A C', 'A C B'), null);
  assert.equal(merged('A B C', 'C A B', 'A B'), null);
});

test('merge puts a node that both sides moved to one place in once, and keeps the other changes', () => {
  assert.equal(merged('A B C D', 'D A B C Y', 'D A B C Z'), 'D A B C Y Z');
  assert.equal(merged('A B C', 'A C B', 'A C B'), 'A C B');
  assert.equal(merged('A B C', 'A B C X', 'A B C X'), 'A B C X');
});

test('merge keeps the side that changed when the other left the base as it was', () => {
  assert.equal(merged('A B C D', 'D B A C', 'A B C D'), 'D B A C');
  assert.equal(merged('A B C D', 'A B C D', 'C A D'), 'C A D');
  assert.equal(merged('', 'A B', ''), 'A B');
});

test('merge keeps a move on one side and a remove on the other of two nodes', () => {
  assert.equal(merged('A B C D', 'A C B D', 'A B C'), 'A C B');
  assert.equal(merged('A B C D', 'B C D', 'A C B D'), 'C B D');
});

test('merge gives null for a node that both sides added or moved after other predecessors', () => {
  assert.equal(merged('A B', 'A B X', 'X A B'), null);
  assert.equal(merged('A B C D', 'A D B C', 'A B D C'), null);
});

test('merge gives null for a chain that holds a node twice', () => {
  assert.equal(merged('A B A', 'A B A', 'A B A C'), null);
  assert.equal(merged('A B', 'A B A', 'A B'), null);
});
