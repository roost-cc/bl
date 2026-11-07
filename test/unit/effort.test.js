import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, checkEffort, effortLabel, sessionEffort } from '../../src/effort.js';

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

test("effortLabel shows a story's effort, or effort.default marked (default) when unset", () => {
  const config = { effort: { refine: 'high', review: 'high', default: 'medium' } };
  assert.equal(effortLabel({ effort: 'low' }, config), 'low');
  assert.equal(effortLabel({ effort: null }, config), 'medium (default)');
});

test('sessionEffort follows D4: refine, review, then the highest story level', () => {
  const config = { effort: { refine: 'xhigh', review: 'medium', default: 'high' } };
  const low = { effort: 'low' };
  const medium = { effort: 'medium' };
  const unset = { effort: null };
  assert.equal(sessionEffort(config, { mode: 'refine', stories: [low] }), 'xhigh');
  assert.equal(sessionEffort(config, { mode: 'review', stories: [low] }), 'medium');
  assert.equal(sessionEffort(config, { mode: 'implement', stories: [low] }), 'low');
  assert.equal(sessionEffort(config, { mode: 'implement', stories: [low, medium] }), 'medium');
  assert.equal(sessionEffort(config, { mode: 'implement', stories: [unset] }), 'high');
  assert.equal(sessionEffort(config, { mode: 'implement', stories: [low, medium, unset] }), 'high');
  assert.equal(sessionEffort(config, { mode: 'implement', stories: [unset, { effort: 'max' }] }), 'max');
});
