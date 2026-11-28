/**
 * The `flows` configuration kind (F-139 D3): the uTop flow set loads through
 * `loadConfiguration`, and each shape fault and CEL fault of a flow file names
 * the file and the path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { faultLines, fixture, load } from '../test/helpers/config-fixture.js';

const FLOWS = fileURLToPath(new URL('../test/fixtures/flows/', import.meta.url));
const BACKLOG = 'color_scheme: mocha\nlanguage: en\nrepos: {}\nid_prefixes:\n  S: story\n';

/** The uTop flow set: file name → text. */
const UTOP = Object.fromEntries(
  readdirSync(FLOWS)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => [name, readFileSync(FLOWS + name, 'utf8')]),
);

/**
 * A fixture backlog with the uTop flow set, its file `name` changed by `edit`.
 * @param {string} [name]
 * @param {(text: string) => string} [edit]
 */
function flowSet(name, edit) {
  const files = { 'backlog/backlog.yaml': BACKLOG };
  for (const [file, text] of Object.entries(UTOP)) {
    const changed = file === name ? edit(text) : text;
    if (file === name) assert.notEqual(changed, text, `the edit changes ${name}`);
    files[`backlog/config/flows/${file}`] = changed;
  }
  return fixture(files);
}

/** The `<file>: <path>` of each fault line. */
const where = (lines) => [...new Set(lines.map((line) => line.split(': ').slice(0, 2).join(': ')))];

test('the uTop flow set loads with no fault, and file(flows, story.yaml) gives the story flow', () => {
  assert.equal(Object.keys(UTOP).length, 15);
  const config = load(flowSet());
  const story = config.file('flows', 'story.yaml');
  assert.deepEqual(Object.keys(story), ['flows']);
  assert.equal(story.flows.story.initial, 'draft');
  assert.deepEqual(story.flows.story.steps.refine, {
    success: { status: 'refined', next: 'stop' },
    failure: { status: 'draft', next: 'stop' },
  });
  assert.deepEqual(config.file('flows', 'flow-set.yaml'), { max_box_visits: 20, gate_recheck_minutes: 15 });
  for (const name of Object.keys(UTOP)) assert.notEqual(config.file('flows', name), undefined, name);
});

test('each bad shape in a flow file gives a fault at one path, with the file', () => {
  const cases = [
    // [what, file, edit, the `<file>: <path>` of the fault, its rule]
    [
      'an arrow with next and return',
      'deliver.yaml',
      (t) => t.replace('{ status: ready_for_merge, return: success }', '{ next: stop, return: success }'),
      '/subflows/deliver/steps/peer_review/success',
      'oneOf',
    ],
    [
      'an arrow key other than next, return and status',
      'story.yaml',
      (t) => t.replace('{ status: refined, next: stop }', '{ status: refined, next: stop, action: x }'),
      '/flows/story/steps/refine/success/action',
      'additionalProperties',
    ],
    [
      'a gate entry object with a key other than condition and class',
      'defined-steps.yaml',
      (t) => t.replace("'has_capacity()', class: expected }", "'has_capacity()', class: expected, note: x }"),
      '/step_gates/agent/0/note',
      'additionalProperties',
    ],
    [
      'a property named closed',
      'story.yaml',
      (t) => t.replace('    properties:\n', '    properties:\n      closed: \'status == "done"\'\n'),
      '/flows/story/properties/closed',
      'additionalProperties',
    ],
    [
      'a name that starts with _',
      'story.yaml',
      (t) =>
        t.replace('      close:\n        success: { status: done', '      _close:\n        success: { status: done'),
      '/flows/story/steps/_close',
      'pattern',
    ],
    [
      'a name that holds /',
      'feature.yaml',
      (t) => t.replace('      superseded: {}', '      super/seded: {}'),
      '/flows/feature/statuses/super~1seded',
      'pattern',
    ],
    ['an unknown top-level key', 'flow-set.yaml', (t) => `${t}max_visits: 3\n`, '/max_visits', 'additionalProperties'],
  ];
  for (const [what, file, edit, path, rule] of cases) {
    const lines = faultLines(flowSet(file, edit));
    // A key that `propertyNames` refuses also gives ajv's `propertyNames` fault, at the same path.
    assert.deepEqual(where(lines), [`config/flows/${file}: ${path}`], what);
    assert.ok(
      lines.some((line) => line.split(': ')[2] === rule),
      `${what}: ${lines.join('\n')}`,
    );
  }
});

test('a gate condition, an after entry or a property that does not compile is a cel fault with the file and path', () => {
  const cases = [
    [
      'a status gate condition',
      'feature.yaml',
      (t) => t.replace(`condition: 'children("task").all(c, c.closed)'`, `condition: 'children("task").all(c, '`),
      '/flows/feature/statuses/done/gate/0/condition',
    ],
    [
      'a step gate as a string',
      'defined-steps.yaml',
      (t) => t.replace("{ condition: 'has_capacity()', class: expected }", "'no_such_function()'"),
      '/step_gates/agent/0',
    ],
    [
      'a step gate condition',
      'defined-steps.yaml',
      (t) => t.replace("condition: 'has_capacity()'", "condition: 'no_such_function()'"),
      '/step_gates/agent/0/condition',
    ],
    [
      'an after entry',
      'defined-steps.yaml',
      (t) => t.replace("after: ['item_valid()']", "after: ['item_valid( ']"),
      '/defined_steps/refine/after/0',
    ],
    [
      'a property that is not bool',
      'story.yaml',
      (t) => t.replace(`in_scope: 'status != "superseded"'`, `in_scope: 'status'`),
      '/flows/story/properties/in_scope',
    ],
  ];
  for (const [what, file, edit, path] of cases) {
    const lines = faultLines(flowSet(file, edit));
    assert.equal(lines.length, 1, `${what}: ${lines.join('\n')}`);
    assert.ok(lines[0].startsWith(`config/flows/${file}: ${path}: cel: `), `${what}: ${lines[0]}`);
  }
});
