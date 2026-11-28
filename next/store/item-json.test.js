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
    'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos: {}\nid_prefixes:\n  S: story\n',
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

const SESSION = { box: 'implement', profile: 'replay', id: 'a1b2' };

test('state.schema.json accepts host and session with active, next with idle and held with gated (Decision A2)', () => {
  assert.deepEqual(checkState({ status: 'in_progress', run: 'active: deliver/open_pr', host: 'running-man' }), []);
  assert.deepEqual(checkState({ status: 'in_progress', run: 'active: implement', session: SESSION }), []);
  assert.deepEqual(checkState({ status: 'refined', run: 'idle', next: 'implement' }), []);
  const held = { box: 'deliver/open_pr', outcome: 'success' };
  assert.deepEqual(checkState({ status: 'ready_for_review', run: 'gated: in_review', held }), []);
});

test('state.schema.json rejects host, next, held and session with any other run state, and held or session with another key', () => {
  const RUNS = ['idle', 'active: x', 'waiting: x', 'gated: done', 'gated before: x'];
  const FIELDS = {
    host: ['running-man', 'active: x'],
    next: ['implement', 'idle'],
    held: [{ box: 'x', outcome: 'success' }, 'gated: done'],
    session: [SESSION, 'active: x'],
  };
  for (const [name, [value, allowed]] of Object.entries(FIELDS)) {
    for (const run of RUNS.filter((r) => r !== allowed)) {
      const rule = name === 'next' ? 'const' : 'pattern';
      assert.deepEqual(rules(checkState({ status: 'review', run, [name]: value })), [`${rule} /run`], `${name} ${run}`);
    }
  }
  const run = 'gated: done';
  assert.deepEqual(rules(checkState({ status: 'review', run, held: { box: 'x', outcome: 'success', to: 'y' } })), [
    'additionalProperties /held/to',
  ]);
  assert.deepEqual(rules(checkState({ status: 'review', run, held: { box: 'x' } })), ['required /held/outcome']);
  const active = 'active: implement';
  assert.deepEqual(rules(checkState({ status: 'review', run: active, session: { ...SESSION, model: 'x' } })), [
    'additionalProperties /session/model',
  ]);
  assert.deepEqual(rules(checkState({ status: 'review', run: active, session: { ...SESSION, id: '' } })), [
    'minLength /session/id',
  ]);
});

test('state_rejects_session_for_a_different_active_box', () => {
  /** Each row: the run state, the session, and the rules of its faults. */
  const rows = [
    ['active: implement', SESSION, []],
    ['active: deliver/open_pr', { ...SESSION, box: 'deliver/open_pr' }, []],
    ['active: first', { ...SESSION, box: 'second' }, ['session /session/box']],
    ['active: implement', { ...SESSION, box: 'implement/x' }, ['session /session/box']],
    ['active: deliver/open_pr', SESSION, ['session /session/box']],
    ['active: implement', { profile: 'replay', id: 'a1b2' }, ['required /session/box']],
    ['active: implement', { box: 'implement', id: 'a1b2' }, ['required /session/profile']],
    ['active: implement', { box: 'implement', profile: 'replay' }, ['required /session/id']],
    ['active: implement', { ...SESSION, box: '' }, ['minLength /session/box']],
    ['active: implement', { ...SESSION, profile: '' }, ['minLength /session/profile']],
    ['active: implement', { ...SESSION, extra: 1 }, ['additionalProperties /session/extra']],
    ['idle', SESSION, ['pattern /run']],
    ['waiting: implement', SESSION, ['pattern /run']],
    ['gated before: implement', SESSION, ['pattern /run']],
  ];
  for (const [run, session, expected] of rows) {
    const label = `${run} ${JSON.stringify(session)}`;
    assert.deepEqual(rules(checkState({ status: 'in_progress', run, session })), expected, label);
  }
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
  assert.throws(() => readAttributes(ctx, item), { message: /^stories\/S1-one\/attributes\.json: json: / });
  const bare = backlog();
  assert.equal(readState(bare, /** @type {import('./items.js').Item} */ (itemDir(bare, 'S-1'))), null);
});

test('readState_rejects_invalid_schema', () => {
  const STATES = [
    [
      '{}\n',
      /^stories\/S1-one\/state\.json: required at \/status: .*\nstories\/S1-one\/state\.json: required at \/run: /,
    ],
    ['[]\n', /^stories\/S1-one\/state\.json: type: must be object$/],
    [jsonText({ status: 'draft', run: 'interrupted: x' }), /state\.json: pattern at \/run: /],
    [jsonText({ status: 'draft', run: 'idle', owner: 'alice' }), /state\.json: additionalProperties at \/owner: /],
  ];
  for (const [text, message] of STATES) {
    const ctx = backlog({ 'state.json': text });
    assert.throws(
      () => readState(ctx, /** @type {import('./items.js').Item} */ (itemDir(ctx, 'S-1'))),
      { message },
      text,
    );
  }
});

test('readAttributes_rejects_invalid_schema', () => {
  const ATTRIBUTES = [
    ['[]\n', /^stories\/S1-one\/attributes\.json: type: must be object$/],
    ['{}\n', /^stories\/S1-one\/attributes\.json: required at \/category: /],
    [jsonText({ category: 'fix' }), /attributes\.json: enum at \/category: /],
    [jsonText({ category: 'bug', points: -1 }), /attributes\.json: minimum at \/points: /],
    [jsonText({ category: 'bug', owner: 'alice' }), /attributes\.json: additionalProperties at \/owner: /],
  ];
  for (const [text, message] of ATTRIBUTES) {
    const ctx = backlog({ 'attributes.json': text });
    const item = /** @type {import('./items.js').Item} */ (itemDir(ctx, 'S-1'));
    assert.throws(() => readAttributes(ctx, item), { message }, text);
  }
  const ctx = backlog({ 'attributes.json': jsonText({ category: 'bug', points: 3 }) });
  assert.deepEqual(readAttributes(ctx, /** @type {import('./items.js').Item} */ (itemDir(ctx, 'S-1'))), {
    category: 'bug',
    points: 3,
  });
});

/** Attribute schemas that the configuration load accepts and ajv's strict mode does not compile. */
const UNCOMPILED_SCHEMAS = [
  ['an unknown format', '{ type: string, format: date }', /unknown format "date"/],
  ['an unknown keyword', '{ type: string, colour: red }', /unknown keyword: "colour"/],
  ['a keyword with no type', '{ minimum: 1 }', /missing type "number" for keyword "minimum"/],
  ['no valid JSON Schema', '{ type: strin }', /schema is invalid/],
  ['a $ref that resolves only in the attribute schema', '{ $defs: { d: {} }, $ref: "#/$defs/d" }', /can't resolve/],
];

test('checkAttributes_with_unknown_format_gives_a_fault_or_config_load_refuses_it', () => {
  for (const [name, schema, message] of UNCOMPILED_SCHEMAS) {
    const dirs = fixture({
      'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos: {}\nid_prefixes:\n  S: story\n',
      'backlog/config/items/story.yaml': `dir: stories\nattributes:\n  - name: due\n    schema: ${schema}\n`,
      'backlog/stories/S1-one/index.md': '# One\n',
      'backlog/stories/S1-one/attributes.json': '{ "due": "2026-01-01" }\n',
    });
    const ctx = { backlogDir: dirs.backlogDir, config: load(dirs) };
    const faults = checkAttributes({ due: '2026-01-01' }, itemDefinition(ctx, 'story'));
    assert.deepEqual(rules(faults), ['schema '], name);
    assert.match(faults[0].message, message, name);
    const item = /** @type {import('./items.js').Item} */ (itemDir(ctx, 'S-1'));
    assert.throws(() => readAttributes(ctx, item), { message: /^stories\/S1-one\/attributes\.json: schema: / }, name);
  }
});

test('jsonText writes two spaces of indent and one newline; parseJson gives a json fault for other text', () => {
  assert.equal(jsonText({ status: 'draft', run: 'idle' }), '{\n  "status": "draft",\n  "run": "idle"\n}\n');
  assert.deepEqual(parseJson('{"a":1}'), { value: { a: 1 } });
  const parsed = parseJson('{ nope');
  assert.ok('fault' in parsed);
  assert.equal(parsed.fault.rule, 'json');
  assert.equal(parsed.fault.path, '');
});
