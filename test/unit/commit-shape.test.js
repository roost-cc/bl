/**
 * Unit tests for the dual-shape `commit:` helpers introduced in S-431:
 *   - `commitFmShape` (cleanup.js): collapses a `<repo>: <sha>` accumulator
 *     into the frontmatter value — string for single-repo, map for multi-repo.
 *   - `flattenCommit` (sync.js): the reverse direction for sync's internal
 *     story map — always emits a single string, on-disk frontmatter is
 *     untouched elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitFmShape } from '../../src/cleanup.js';
import { flattenCommit } from '../../src/sync.js';

test('commitFmShape returns null for an empty map (caller skips writing the field)', () => {
  assert.equal(commitFmShape({}), null);
  assert.equal(commitFmShape(undefined), null);
});

test('commitFmShape returns the bare SHA string when only one repo was cleaned', () => {
  assert.equal(commitFmShape({ bl: 'abc1234' }), 'abc1234');
});

test('commitFmShape returns a copy of the map (not the original) for multi-repo cleanups', () => {
  const input = { bl: 'abc1234', containers: 'def5678' };
  const out = commitFmShape(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input, 'must not return the same reference');
});

test('flattenCommit passes through a plain string commit', () => {
  assert.equal(flattenCommit('abc1234', 'bl'), 'abc1234');
});

test("flattenCommit prefers the primary repo's SHA in a map", () => {
  assert.equal(flattenCommit({ bl: 'abc1234', containers: 'def5678' }, 'bl'), 'abc1234');
  assert.equal(flattenCommit({ bl: 'abc1234', containers: 'def5678' }, 'containers'), 'def5678');
});

test('flattenCommit falls back to the first map value when primary_repo is unset or absent', () => {
  assert.equal(flattenCommit({ bl: 'abc1234', containers: 'def5678' }, null), 'abc1234');
  assert.equal(flattenCommit({ bl: 'abc1234', containers: 'def5678' }, 'nope'), 'abc1234');
});

test("a feature's commit map, with no repo named, flattens to its bl entry, else its first (F-52 D3)", () => {
  assert.equal(flattenCommit({ containers: 'def5678', bl: 'abc1234' }), 'abc1234');
  assert.equal(flattenCommit({ containers: 'def5678', app: '0123456' }), 'def5678');
  assert.equal(flattenCommit('abc1234'), 'abc1234');
});

test('flattenCommit returns empty string for empty / nullish input', () => {
  assert.equal(flattenCommit(undefined, 'bl'), '');
  assert.equal(flattenCommit(null, 'bl'), '');
  assert.equal(flattenCommit('', 'bl'), '');
  assert.equal(flattenCommit({}, 'bl'), '');
});
