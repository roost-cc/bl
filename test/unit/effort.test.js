import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, checkEffort } from '../../src/effort.js';

test('EFFORT_LEVELS lists the five levels, lowest first (F-85 D1)', () => {
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('checkEffort returns a level and throws, naming the label, for anything else', () => {
  for (const level of EFFORT_LEVELS) assert.equal(checkEffort(level, 'x'), level);
  assert.throws(
    () => checkEffort('huge', 'story "effort"'),
    /^Error: story "effort" must be one of low, medium, high, xhigh, max, not "huge"$/,
  );
  assert.throws(() => checkEffort('High', 'e'), /^Error: e must be one of/);
  assert.throws(() => checkEffort(3, 'e'), /^Error: e must be one of .*, not 3$/);
  assert.throws(() => checkEffort(null, 'e'), /, not null$/);
});
