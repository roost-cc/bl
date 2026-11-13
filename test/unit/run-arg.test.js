import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runArgs } from '../../src/run-arg.js';

test('runArgs takes the id of each kind bl run runs: a feature, a story batch or a story (F-125 D1)', () => {
  for (const [raw, id] of [
    ['F-3', 'F-3'],
    ['B-2', 'B-2'],
    ['b2', 'B-2'],
    ['S-34', 'S-34'],
  ]) {
    assert.equal(runArgs('stop', [raw], { help: '' }).id, id, raw);
  }
});
