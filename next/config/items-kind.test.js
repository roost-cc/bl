/**
 * The `items` configuration kind and `id_prefixes` (F-137 D9 item 1): the
 * item definitions and the prefix-to-type map through the frozen
 * configuration, and the faults of their schemas.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faultLines, fixture, load } from '../test/helpers/config-fixture.js';

const BACKLOG = 'color_scheme: mocha\nrepos: {}\nid_prefixes:\n  S: story\n  F: feature\n';

const STORY = `type: story
dir: stories
sections:
  - name: Summary
    purpose: |
      One paragraph: what this story delivers.
    required: true
  - name: Notes
    initial: 'None.'
attributes:
  - name: category
    schema: { enum: [feature, bug, chore] }
    required: true
`;

const FEATURE = 'dir: features\nsections:\n  - name: Goal\n    required: true\n';

test('the item definitions come through file(items, <name>.yaml), id_prefixes through scope(null)', () => {
  const config = load(
    fixture({
      'backlog/backlog.yaml': BACKLOG,
      'backlog/config/items/story.yaml': STORY,
      'backlog/config/items/feature.yaml': FEATURE,
    }),
  );
  assert.deepEqual(config.file('items', 'story.yaml'), {
    type: 'story',
    dir: 'stories',
    sections: [
      { name: 'Summary', purpose: 'One paragraph: what this story delivers.\n', required: true },
      { name: 'Notes', initial: 'None.' },
    ],
    attributes: [{ name: 'category', schema: { enum: ['feature', 'bug', 'chore'] }, required: true }],
  });
  assert.deepEqual(config.file('items', 'feature.yaml'), {
    dir: 'features',
    sections: [{ name: 'Goal', required: true }],
  });
  assert.equal(config.file('items', 'task.yaml'), undefined);
  assert.deepEqual(config.scope(null).id_prefixes, { S: 'story', F: 'feature' });
});

test('an item definition with no dir is a fault that names its file, /dir and required', () => {
  const dirs = fixture({ 'backlog/backlog.yaml': BACKLOG, 'backlog/config/items/story.yaml': 'type: story\n' });
  assert.deepEqual(faultLines(dirs), ["config/items/story.yaml: /dir: required: must have required property 'dir'"]);
});

test('item_definition_rejects_invalid_dir_paths', () => {
  const bad = [
    '',
    '.',
    '..',
    '../outside',
    'stories/../../outside',
    'stories/..',
    './stories',
    'a/./b',
    '/tmp/outside',
  ];
  const more = ['stories/', 'a//b', 'a\\\\b'];
  for (const dir of [...bad, ...more]) {
    const dirs = fixture({
      'backlog/backlog.yaml': BACKLOG,
      'backlog/config/items/story.yaml': `dir: ${JSON.stringify(dir)}\n`,
    });
    assert.deepEqual(
      faultLines(dirs).map((line) => line.split(': must match')[0]),
      ['config/items/story.yaml: /dir: pattern'],
      dir,
    );
  }
  for (const dir of ['stories', 'work/items', '.items', 'a..b']) {
    const dirs = fixture({
      'backlog/backlog.yaml': BACKLOG,
      'backlog/config/items/story.yaml': `dir: ${JSON.stringify(dir)}\n`,
    });
    assert.equal(load(dirs).file('items', 'story.yaml').dir, dir);
  }
});

test('an unknown key in an item, a section or an attribute definition is an additionalProperties fault', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': BACKLOG,
    'backlog/config/items/story.yaml': `dir: stories
children: [task]
sections:
  - name: Summary
    purpose: x
    shape: checklist
attributes:
  - name: category
    schema: {}
    default: chore
`,
  });
  const extra = (path) => `config/items/story.yaml: ${path}: additionalProperties: must NOT have additional properties`;
  assert.deepEqual(faultLines(dirs), [extra('/attributes/0/default'), extra('/children'), extra('/sections/0/shape')]);
});

test('parents and child_limits (F-148 D1) load; a slot without min is a fault that names /parents/<n>/min', () => {
  const story = `dir: stories
parents:
  - name: component
    types: [component]
    min: 0
    max: 1
  - name: unit
    types: [feature, batch]
    min: 1
    max: 1
`;
  const feature = 'dir: features\nchild_limits:\n  - types: [story]\n    max: 12\n';
  const config = load(
    fixture({
      'backlog/backlog.yaml': BACKLOG,
      'backlog/config/items/story.yaml': story,
      'backlog/config/items/feature.yaml': feature,
    }),
  );
  assert.deepEqual(config.file('items', 'story.yaml').parents, [
    { name: 'component', types: ['component'], min: 0, max: 1 },
    { name: 'unit', types: ['feature', 'batch'], min: 1, max: 1 },
  ]);
  assert.deepEqual(config.file('items', 'feature.yaml').child_limits, [{ types: ['story'], max: 12 }]);
  const dirs = fixture({
    'backlog/backlog.yaml': BACKLOG,
    'backlog/config/items/story.yaml': 'dir: stories\nparents:\n  - name: unit\n    types: [feature]\n    max: 1\n',
  });
  assert.deepEqual(faultLines(dirs), [
    "config/items/story.yaml: /parents/0/min: required: must have required property 'min'",
  ]);
});

test('a slot or child limit with a negative count, or a child limit without max, is a fault', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': BACKLOG,
    'backlog/config/items/story.yaml':
      'dir: stories\nparents:\n  - { name: unit, types: [feature], min: -1, max: 1.5 }\n',
    'backlog/config/items/feature.yaml': 'dir: features\nchild_limits:\n  - { types: [story] }\n',
  });
  assert.deepEqual(
    faultLines(dirs).map((line) => line.split(': must')[0]),
    [
      'config/items/feature.yaml: /child_limits/0/max: required',
      'config/items/story.yaml: /parents/0/max: type',
      'config/items/story.yaml: /parents/0/min: minimum',
    ],
  );
});

test('a section definition with only a name is accepted', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': BACKLOG,
    'backlog/config/items/batch.yaml': 'dir: batches\nsections:\n  - name: Notes\n',
  });
  assert.deepEqual(load(dirs).file('items', 'batch.yaml').sections, [{ name: 'Notes' }]);
});

test('an id_prefixes value that is not a string is a fault that names backlog.yaml', () => {
  const dirs = fixture({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\nid_prefixes:\n  S: story\n  F: [feature]\n',
  });
  assert.deepEqual(faultLines(dirs), ['backlog.yaml: /id_prefixes/F: type: must be string']);
});
