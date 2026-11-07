/**
 * Unit tests for `commitFmShape` (cleanup.js, S-431): it collapses a
 * `<repo>: <sha>` accumulator into the frontmatter value — string for
 * single-repo, map for multi-repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitFmShape } from '../../src/cleanup.js';

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
