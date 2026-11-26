import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { checkAttributes, checkState, jsonText, parseJson, readAttributes, readState } from './item-json.js';
import { itemDefinition, itemDir } from './items.js';

const STORY = [
  'dir: stories',
  'attributes:',
  '  - name: category',
  '    schema: { enum: [feature, bug, chore] }',
  '    required: true',
  '  - name: points',
  '    schema: { type: integer, minimum: 0 }',
  '',
].join('\n');

/**
 * A backlog with the type story and the item S-1, which holds `files`.
 * @param {Record<string, string>} [files]  file name in S-1's directory → text
 */
function backlog(files = {}) {
  const dirs = fixture({
    'backlog/backlog.yaml': 'repos: {}\nid_prefixes:\n  S: story\n',
    'backlog/config/items/story.yaml': STORY,
    'backlog/stories/S1-one/index.md': '# One\n',
    ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`backlog/stories/S1-one/${name}`, text])),
  });
  return { backlogDir: dirs.backlogDir, config: load(dirs) };
}

/** The rule and path of each fault. */
const rules = (faults) => faults.map(({ rule, path }) => `${rule} ${path}`);

test('state.schema.json accepts status, run in each of the five stored forms, and counters', () => {
  for (const run of ['idle', 'active: deliver/test', 'waiting: review', 'gated: done', 'gated before: merge']) {
    assert.deepEqual(checkState({ status: 'in_progress', run }), [], run);
  }
  const counters = { self_rounds: { value: 0, threshold: 3 }, test_fixes: { value: 2 }, fresh: {} };
  assert.deepEqual(checkState({ status: 'review', run: 'idle', counters }), []);
});

test('state.schema.json rejects a missing status or run, interrupted, a counter below 0, and any other property', () => {
  assert.deepEqual(rules(checkState({ run: 'idle' })), ['required /status']);
  assert.deepEqual(rules(checkState({ status: 'review' })), ['required /run']);
  assert.deepEqual(rules(checkState({ status: 'review', run: 'interrupted: x' })), ['pattern /run']);
  for (const run of ['active:', 'active: ', 'busy: x', 'idle: x', ' idle']) {
    assert.deepEqual(rules(checkState({ status: 'review', run })), ['pattern /run'], run);
  }
  assert.deepEqual(
    rules(checkState({ status: 'review', run: 'idle', counters: { a: { value: -1, threshold: -2 } } })),
    ['minimum /counters/a/value', 'minimum /counters/a/threshold'],
  );
  assert.deepEqual(rules(checkState({ status: 'review', run: 'idle', counters: { a: { value: 1, cap: 2 } } })), [
    'additionalProperties /counters/a/cap',
  ]);
  assert.deepEqual(rules(checkState({ status: 'review', run: 'idle', status_since: '2026-01-01T00:00:00Z' })), [
    'additionalProperties /status_since',
  ]);
});

test('attributes.json: an undeclared key, a value that fails its schema and a missing required attribute are one finding each', () => {
  const ctx = backlog();
  const definition = itemDefinition(ctx, 'story');
  assert.deepEqual(checkAttributes({ category: 'bug', points: 3 }, definition), []);
  assert.deepEqual(checkAttributes({ category: 'chore' }, definition), []);
  assert.deepEqual(rules(checkAttributes({ category: 'bug', effort: 'low' }, definition)), [
    'additionalProperties /effort',
  ]);
  assert.deepEqual(rules(checkAttributes({ category: 'fix' }, definition)), ['enum /category']);
  assert.deepEqual(rules(checkAttributes({ points: 1 }, definition)), ['required /category']);
  assert.deepEqual(rules(checkAttributes({ points: -1, effort: 'low' }, definition)), [
    'required /category',
    'additionalProperties /effort',
    'minimum /points',
  ]);
  assert.deepEqual(rules(checkAttributes([], definition)), ['type ']);
});

test('a type that declares no attributes accepts only an empty attributes.json', () => {
  const definition = { dir: 'tasks' };
  assert.deepEqual(checkAttributes({}, definition), []);
  assert.deepEqual(rules(checkAttributes({ owner: 'x' }, definition)), ['additionalProperties /owner']);
});

test('readState and readAttributes give the value, null for a missing file, and an error for a file that is not JSON', () => {
  const ctx = backlog({ 'state.json': jsonText({ status: 'draft', run: 'idle' }), 'attributes.json': '{ nope' });
  const item = /** @type {import('./items.js').Item} */ (itemDir(ctx, 'S-1'));
  assert.deepEqual(readState(ctx, item), { status: 'draft', run: 'idle' });
  assert.throws(() => readAttributes(ctx, item), { message: /^stories\/S1-one\/attributes\.json is not JSON: / });
  const bare = backlog();
  assert.equal(readState(bare, /** @type {import('./items.js').Item} */ (itemDir(bare, 'S-1'))), null);
});

test('jsonText writes two spaces of indent and one newline; parseJson gives a json fault for other text', () => {
  assert.equal(jsonText({ status: 'draft', run: 'idle' }), '{\n  "status": "draft",\n  "run": "idle"\n}\n');
  assert.deepEqual(parseJson('{"a":1}'), { value: { a: 1 } });
  const parsed = parseJson('{ nope');
  assert.ok('fault' in parsed);
  assert.equal(parsed.fault.rule, 'json');
  assert.equal(parsed.fault.path, '');
});
