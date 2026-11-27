// The record builder (F-148 D7, Decision A1): the record of each item of a fixture backlog, checked
// against record.schema.json with checkValue (F-136 A2).
import assert from 'node:assert/strict';
import { join } from 'path';
import { test } from 'node:test';
import { checkValue } from '../config/check.js';
import RECORD_SCHEMA from '../config/schemas/record.schema.json' with { type: 'json' };
import { fixture, load } from '../test/helpers/config-fixture.js';
import { record, recordReader } from './record.js';

const IDLE = '{ "status": "draft", "run": "idle" }\n';

/** The backlog's files: a feature in an epic, a story in the feature, a loose ranked story, an epic. */
const FILES = {
  'backlog.yaml': [
    'color_scheme: mocha',
    'language: en',
    'repos: {}',
    'id_prefixes: { F: feature, S: story, E: epic }',
    'work_types: [feature, story]',
    'graphs:',
    '  - { name: containment, engine: containment, nodes: [story, feature, epic] }',
    '  - { name: rank, engine: rank, nodes: [feature, story] }',
    '',
  ].join('\n'),
  'config/items/feature.yaml': 'dir: features\nparents:\n  - { name: epics, types: [epic], min: 0, max: 2 }\n',
  'config/items/story.yaml': [
    'dir: stories',
    'parents:',
    '  - { name: unit, types: [feature], min: 0, max: 1 }',
    'attributes:',
    '  - { name: points, schema: { type: integer } }',
    '  - { name: owner, schema: { type: string } }',
    '  - { name: category, schema: { type: string } }',
    '',
  ].join('\n'),
  'config/items/epic.yaml': 'dir: epics\n',
  'graphs/containment.json': '{ "F-1": { "epics": ["E-1"] }, "S-1": { "unit": "F-1" } }\n',
  'graphs/rank.json': '["F-1", "S-2"]\n',
  'features/F1-a-feature/index.md': '# A feature\n\n## Summary\n\nThe feature.\n',
  'features/F1-a-feature/state.json': IDLE,
  'features/F1-a-feature/attributes.json': '{}\n',
  'features/F1-a-feature/change.md': '# Change\n\nThe change of F-1.\n',
  'stories/S1-in-the-feature/index.md':
    '# In the feature\n\n## Summary\n\nA story.\n\n## Acceptance Criteria\n\n- [x] one\n- [ ] two **bold**\n',
  'stories/S1-in-the-feature/state.json': JSON.stringify({
    status: 'in_progress',
    run: 'active: implement',
    counters: { rounds: { value: 2 }, retries: { threshold: 3 } },
  }),
  'stories/S1-in-the-feature/attributes.json': '{ "owner": "ann", "points": 3 }\n',
  'stories/S1-in-the-feature/change.md': 'not the work unit, so not read\n',
  'stories/S2-loose/index.md': '# Loose\n',
  'stories/S2-loose/state.json': IDLE,
  'stories/S2-loose/attributes.json': '{}\n',
  'epics/E1-an-epic/index.md': '# An epic\n',
  'epics/E1-an-epic/state.json': IDLE,
  'epics/E1-an-epic/attributes.json': '{}\n',
};

/** A store context on the fixture backlog with `files` over `FILES`. */
function context(files = {}) {
  const all = { ...FILES, ...files };
  const dirs = fixture(Object.fromEntries(Object.entries(all).map(([path, text]) => [`backlog/${path}`, text])));
  return { backlogDir: dirs.backlogDir, config: load(dirs) };
}

/** The fields of Decision A1, in D7's order. */
const FIELDS = [
  'item_id',
  'type',
  'title',
  'id_prefix',
  'id_number',
  'status',
  'run',
  'counters',
  'attributes',
  'attribute_list',
  'sections',
  'body',
  'checkboxes',
  'path',
  'dir',
  'parents',
  'unit',
  'change',
  'rank',
];

test('the record of each item passes record.schema.json and holds the fields of Decision A1', () => {
  const ctx = context();
  const read = recordReader(ctx);
  for (const id of ['F-1', 'S-1', 'S-2', 'E-1']) {
    const r = read(id);
    assert.deepEqual(checkValue(RECORD_SCHEMA, r), [], id);
    assert.deepEqual(Object.keys(r).sort(), [...FIELDS].sort(), id);
  }
});

test("a story in a feature: its unit is the feature, it has no rank, and change is the feature's change.md", () => {
  const ctx = context();
  const dir = join(ctx.backlogDir, 'stories/S1-in-the-feature');
  assert.deepEqual(record(ctx, 's1'), {
    item_id: 'S-1',
    type: 'story',
    title: 'In the feature',
    id_prefix: 'S',
    id_number: 1,
    status: 'in_progress',
    run: 'active: implement',
    counters: { rounds: { value: 2 }, retries: { value: 0, threshold: 3 } },
    attributes: { owner: 'ann', points: 3 },
    attribute_list: [
      { name: 'points', value: 3 },
      { name: 'owner', value: 'ann' },
    ],
    sections: { Summary: 'A story.', 'Acceptance Criteria': '- [x] one\n- [ ] two **bold**' },
    body: FILES['stories/S1-in-the-feature/index.md'],
    checkboxes: {
      Summary: [],
      'Acceptance Criteria': [
        { checked: true, text: 'one' },
        { checked: false, text: 'two **bold**' },
      ],
    },
    path: join(dir, 'index.md'),
    dir,
    parents: { unit: 'F-1' },
    unit: 'F-1',
    change: '# Change\n\nThe change of F-1.\n',
    rank: null,
  });
});

test('a feature is its own work unit, with its place in the rank chain and a list slot in parents', () => {
  const r = record(context(), 'F-1');
  assert.deepEqual(
    { parents: r.parents, unit: r.unit, rank: r.rank, change: r.change, counters: r.counters },
    { parents: { epics: ['E-1'] }, unit: 'F-1', rank: 1, change: '# Change\n\nThe change of F-1.\n', counters: {} },
  );
});

test('a loose ranked story is its own work unit, with its place as rank and no change.md', () => {
  const r = record(context(), 'S-2');
  assert.deepEqual(
    { parents: r.parents, unit: r.unit, rank: r.rank, change: r.change, attribute_list: r.attribute_list },
    { parents: {}, unit: 'S-2', rank: 2, change: '', attribute_list: [] },
  );
});

test('an epic is of no work type: its unit is null, its rank null and its change empty', () => {
  const r = record(context(), 'E-1');
  assert.deepEqual({ unit: r.unit, rank: r.rank, change: r.change }, { unit: null, rank: null, change: '' });
});

test('with empty graphs, each item of a work type has no parents, is its own work unit and has no rank', () => {
  const ctx = context({ 'graphs/containment.json': '{}\n', 'graphs/rank.json': '[]\n' });
  assert.deepEqual(
    ['F-1', 'S-1'].map((id) => {
      const { parents, unit, rank, change } = record(ctx, id);
      return { parents, unit, rank, change };
    }),
    [
      { parents: {}, unit: 'F-1', rank: null, change: '# Change\n\nThe change of F-1.\n' },
      { parents: {}, unit: 'S-1', rank: null, change: 'not the work unit, so not read\n' },
    ],
  );
});

test('an unknown id or a missing item file is an error that names it', () => {
  const ctx = context({ 'epics/E2-bare/index.md': '# Bare\n' });
  assert.throws(() => record(ctx, 'S-9'), { message: 'there is no item S-9 in the backlog' });
  assert.throws(() => record(ctx, 'E-2'), {
    message: 'epics/E2-bare/state.json is not there; every item directory holds it',
  });
});
