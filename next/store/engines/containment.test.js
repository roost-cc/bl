import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue } from '../../config/check.js';
import { canonical, changed, empty, schema } from './containment.js';

test('the schema takes a child with id slots and list slots, and refuses other shapes', () => {
  assert.deepEqual(checkValue(schema, { 'S-1': { component: 'C-1', unit: ['F-1', 'F-2'] } }), []);
  assert.deepEqual(checkValue(schema, empty), []);
  for (const bad of [[], { 'S-1': 'C-1' }, { 'S-1': { unit: 5 } }, { 'S-1': { unit: [5] } }, { 'S-1': { unit: '' } }]) {
    assert.notDeepEqual(checkValue(schema, bad), [], JSON.stringify(bad));
  }
});

test('the canonical form sorts children, slots and list slots, drops repeats and empty slots and children', () => {
  const value = {
    'S-2': { unit: 'F-1', component: 'C-1' },
    'S-10': { epics: ['E-3', 'E-1', 'E-3'] },
    'S-1': { epics: [] },
  };
  const result = canonical(value);
  assert.deepEqual(result, { 'S-10': { epics: ['E-1', 'E-3'] }, 'S-2': { component: 'C-1', unit: 'F-1' } });
  assert.equal(JSON.stringify(result), '{"S-10":{"epics":["E-1","E-3"]},"S-2":{"component":"C-1","unit":"F-1"}}');
  assert.deepEqual(canonical(result), result);
});

test('changed gives each child whose slots differ, and no child whose entry only reads in another order', () => {
  const before = { 'S-1': { unit: 'F-1' }, 'S-2': { epics: ['E-1', 'E-2'] }, 'S-3': { unit: 'F-1' } };
  const after = { 'S-1': { unit: 'F-2' }, 'S-2': { epics: ['E-2', 'E-1'] }, 'S-4': { unit: 'F-1' } };
  assert.deepEqual(changed(before, after).sort(), ['S-1', 'S-3', 'S-4']);
  assert.deepEqual(changed(empty, empty), []);
});
