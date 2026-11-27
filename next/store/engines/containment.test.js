import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue } from '../../config/check.js';
import { fixture, load } from '../../test/helpers/config-fixture.js';
import { canonical, changed, check, empty, kind, merge, names, schema } from './containment.js';

/**
 * A store context with the types story, feature and epic. A story has a
 * `unit` slot of one feature and an `epics` slot of up to two epics; a
 * feature holds at most two stories; an epic needs one feature in `within`.
 */
function context() {
  const files = {
    'backlog.yaml': 'color_scheme: mocha\nrepos: {}\nid_prefixes:\n  S: story\n  F: feature\n  E: epic\n',
    'config/items/story.yaml': [
      'dir: stories',
      'parents:',
      '  - { name: unit, types: [feature], min: 0, max: 1 }',
      '  - { name: epics, types: [epic], min: 0, max: 2 }',
      '',
    ].join('\n'),
    'config/items/feature.yaml': 'dir: features\nchild_limits:\n  - { types: [story], max: 2 }\n',
    'config/items/epic.yaml': 'dir: epics\nparents:\n  - { name: within, types: [feature], min: 1, max: 1 }\n',
  };
  const dirs = fixture(Object.fromEntries(Object.entries(files).map(([path, text]) => [`backlog/${path}`, text])));
  return { backlogDir: dirs.backlogDir, config: load(dirs) };
}

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

test('names gives the child and each of its parents, or none for a child with no entry', () => {
  const value = { 'S-1': { unit: 'F-1', epics: ['E-1', 'E-2'] } };
  assert.deepEqual(names(value, 'S-1'), ['S-1', 'F-1', 'E-1', 'E-2']);
  assert.deepEqual(names(value, 'S-2'), []);
  assert.deepEqual(names(value, 'constructor'), []);
});

test('kind gives no fault for a graph with no cycle, and one cycle fault for each cycle', () => {
  assert.deepEqual(
    kind({ 'S-1': { unit: 'F-1', epics: ['E-1'] }, 'F-1': { epic: 'E-1' }, 'S-2': { unit: 'F-1' } }),
    [],
  );
  assert.deepEqual(kind(empty), []);
  assert.deepEqual(kind({ 'S-1': { unit: 'S-1' } }), [
    { item: 'S-1', rule: 'cycle', path: '/S-1', message: 'S-1 → S-1 is a cycle' },
  ]);
  assert.deepEqual(
    kind({
      'S-1': { unit: 'F-1' },
      'F-1': { epic: 'E-1' },
      'E-1': { within: 'F-1' },
      'S-2': { unit: ['S-3'] },
      'S-3': { unit: 'S-2' },
    }),
    [
      { item: 'E-1', rule: 'cycle', path: '/E-1', message: 'E-1 → F-1 → E-1 is a cycle' },
      { item: 'S-2', rule: 'cycle', path: '/S-2', message: 'S-2 → S-3 → S-2 is a cycle' },
    ],
  );
});

test('check gives each per-item rule a fault when the entry breaks it, and none when it keeps it', () => {
  const ctx = context();
  /** [rule, a value that keeps it for the child, one that breaks it, the fault's slot] */
  const CASES = [
    ['slot', { 'S-1': { unit: 'F-1' } }, { 'S-1': { owner: 'F-1' } }, 'owner'],
    ['parent-type', { 'S-1': { epics: ['E-1'] } }, { 'S-1': { epics: ['F-1'] } }, 'epics'],
    ['slot-count', { 'S-1': { epics: ['E-1', 'E-2'] } }, { 'S-1': { epics: ['E-1', 'E-2', 'E-3'] } }, 'epics'],
    [
      'child-limit',
      { 'S-1': { unit: 'F-1' }, 'S-2': { unit: 'F-1' }, 'S-3': { unit: 'F-2' } },
      { 'S-1': { unit: 'F-1' }, 'S-2': { unit: 'F-1' }, 'S-3': { unit: 'F-1' } },
      'unit',
    ],
  ];
  for (const [rule, keeps, breaks, slot] of CASES) {
    assert.deepEqual(check(keeps, ['S-1'], ctx), [], rule);
    assert.deepEqual(
      check(breaks, ['S-1'], ctx).map((fault) => [fault.item, fault.rule, fault.path]),
      [['S-1', rule, `/S-1/${slot}`]],
      rule,
    );
  }
});

test('containment slot shape follows the configured maximum', () => {
  const ctx = context();
  /** [slot, its max, the slot's value, whether it has the right shape] */
  const CASES = [
    ['unit', 1, 'F-1', true],
    ['unit', 1, ['F-1'], false],
    ['epics', 2, ['E-1'], true],
    ['epics', 2, 'E-1', false],
  ];
  for (const [slot, max, parents, right] of CASES) {
    const value = { 'S-1': { [slot]: parents } };
    const label = JSON.stringify(value);
    assert.deepEqual(
      check(value, ['S-1'], ctx).map((fault) => [fault.rule, fault.path]),
      right ? [] : [['slot-shape', `/S-1/${slot}`]],
      label,
    );
    assert.deepEqual(canonical(value), value, `canonical keeps the shape of ${label} (max ${max})`);
    assert.deepEqual(merge(empty, value, empty), value, `merge keeps the shape of ${label}`);
    assert.deepEqual(merge(value, value, value), value, `merge keeps the shape of ${label}`);
  }
});

test('check counts a child with no entry as holding no parent, against each slot min', () => {
  const ctx = context();
  assert.deepEqual(check(empty, ['E-1'], ctx), [
    {
      item: 'E-1',
      rule: 'slot-count',
      path: '/E-1/within',
      message: 'the slot within holds 0 parents; it takes 1 to 1',
    },
  ]);
  assert.deepEqual(check({ 'E-1': { within: 'F-1' } }, ['E-1'], ctx), []);
  assert.deepEqual(check(empty, ['S-1'], ctx), []);
});

test('check gives the rules only to the entries of ids, and leaves a parent that is no printed id to the runner', () => {
  const ctx = context();
  const value = { 'S-1': { unit: 'f1' }, 'S-2': { owner: 'F-1' } };
  assert.deepEqual(check(value, ['S-1'], ctx), []);
  assert.deepEqual(
    check({ 'S-1': { unit: 'F-1' }, 'S-2': { unit: 'F-1' }, 'S-3': { unit: 'F-1' } }, ['S-1'], ctx)[0].message,
    'F-1 holds 3 children of story; it takes 2',
  );
});

test('merge keeps the slots that two sides set on one child, and each side adds and removes', () => {
  const base = { 'S-1': { unit: 'F-1' }, 'S-2': { unit: 'F-1' } };
  const ours = { 'S-1': { unit: 'F-1', epics: ['E-1'] }, 'S-3': { unit: 'F-2' } };
  const theirs = { 'S-1': { unit: 'F-1', within: 'F-9' }, 'S-2': { unit: 'F-1' } };
  const result = merge(base, ours, theirs);
  assert.deepEqual(result, { 'S-1': { epics: ['E-1'], unit: 'F-1', within: 'F-9' }, 'S-3': { unit: 'F-2' } });
  assert.deepEqual(result, canonical(/** @type {any} */ (result)));
});

test('merge keeps one side that sets an id slot, and gives null for two sides that set it to two parents', () => {
  const base = { 'S-1': { unit: 'F-1' } };
  assert.deepEqual(merge(base, { 'S-1': { unit: 'F-2' } }, base), { 'S-1': { unit: 'F-2' } });
  assert.deepEqual(merge(base, { 'S-1': { unit: 'F-2' } }, { 'S-1': { unit: 'F-2' } }), { 'S-1': { unit: 'F-2' } });
  assert.equal(merge(base, { 'S-1': { unit: 'F-2' } }, { 'S-1': { unit: 'F-3' } }), null);
  assert.equal(merge(empty, { 'S-1': { unit: 'F-2' } }, { 'S-1': { unit: 'F-3' } }), null);
  assert.equal(merge(base, { 'S-1': { unit: 'F-2' } }, {}), null);
});

test('merge merges a list slot as a set', () => {
  const base = { 'S-1': { epics: ['E-1', 'E-2'] } };
  assert.deepEqual(
    merge(base, { 'S-1': { epics: ['E-1', 'E-2', 'E-3'] } }, { 'S-1': { epics: ['E-4', 'E-2', 'E-1'] } }),
    {
      'S-1': { epics: ['E-1', 'E-2', 'E-3', 'E-4'] },
    },
  );
  assert.deepEqual(merge(base, { 'S-1': { epics: ['E-2'] } }, { 'S-1': { epics: ['E-1', 'E-2', 'E-3'] } }), {
    'S-1': { epics: ['E-2', 'E-3'] },
  });
  assert.deepEqual(merge(base, { 'S-1': { epics: ['E-2'] } }, { 'S-1': { epics: ['E-1'] } }), empty);
});

test('merge gives null for a slot that it leaves holding an id and a list', () => {
  assert.equal(merge(empty, { 'S-1': { epics: 'E-1' } }, { 'S-1': { epics: ['E-2'] } }), null);
  assert.equal(merge(empty, { 'S-1': { epics: ['E-2'] } }, { 'S-1': { epics: 'E-1' } }), null);
});
