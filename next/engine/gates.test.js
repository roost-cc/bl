// The failing entries of status gates, step gates and post-conditions (F-139 D7, Decision A4), on a
// backlog with the uTop flow set, its items made through storeWrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../store/record.js';
import { storeWrite } from '../store/write.js';
import { createItems, engineBacklog, setGraph } from '../test/helpers/engine-backlog.js';
import { git } from '../test/helpers/git.js';
import { engineRecord } from './conditions.js';
import { postConditions, stepGate, statusGate } from './gates.js';

const IDLE = { run: 'idle' };

/** The record of `id` as conditions read it. */
const recordOf = (ctx, id) => engineRecord(ctx, ctx.flowSet, record(ctx, id));

/** Set the status of each item of `statuses` in one store write. */
const setStatuses = (ctx, statuses) =>
  storeWrite(ctx, { message: 'chore: statuses' }, (w) => {
    for (const [id, status] of Object.entries(statuses)) w.state(id, { status, ...IDLE });
  });

/** The backlog's HEAD and every changed, new or ignored file. */
const snapshot = (ctx) => ({
  head: git(ctx.backlogDir, 'rev-parse', 'HEAD'),
  status: git(ctx.backlogDir, 'status', '--porcelain', '--ignored'),
});

test("the status gate of done fails while a task child is open, with the flow's one entry, and passes when every task is closed", async () => {
  const ctx = engineBacklog();
  await createItems(ctx, [
    { type: 'story', state: { status: 'implemented', ...IDLE } },
    { type: 'task', state: { status: 'draft', ...IDLE } },
    { type: 'task', state: { status: 'done', ...IDLE } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: 'S-1' }, 'T-2': { parent: 'S-1' } });
  const before = snapshot(ctx);
  const condition = 'children("task").all(c, c.closed)';
  assert.deepEqual(await statusGate(ctx, recordOf(ctx, 'S-1'), 'done'), [
    { entry: { condition, class: 'expected' }, text: condition },
  ]);
  assert.deepEqual(await statusGate(ctx, recordOf(ctx, 'S-1'), 'merged'), [], 'merged has no gate');
  assert.deepEqual(snapshot(ctx), before, 'the evaluation commits nothing and changes no file');

  await setStatuses(ctx, { 'T-1': 'superseded' });
  assert.deepEqual(await statusGate(ctx, recordOf(ctx, 'S-1'), 'done'), []);
});

test('a dependency entry under the target status fails while its expression is false over the named item', async () => {
  const ctx = engineBacklog();
  await createItems(ctx, [
    { type: 'story', state: { status: 'ready_for_merge', ...IDLE } },
    { type: 'story', state: { status: 'in_progress', ...IDLE } },
    { type: 'feature', state: { status: 'in_progress', ...IDLE } },
  ]);
  await setGraph(ctx, 'dependency', {
    'S-1': {
      merged: [{ 'S-2': 'status == "done"' }, { 'F-1': 'status == "in_progress"' }, { 'S-1': 'status == "merged"' }],
      done: [{ 'S-2': 'false' }],
    },
  });
  const before = snapshot(ctx);
  // The store writes the entries in canonical order, sorted by item (F-148 D2).
  assert.deepEqual(await statusGate(ctx, recordOf(ctx, 'S-1'), 'merged'), [
    { entry: { item: 'S-1', expression: 'status == "merged"' }, text: 'S-1: status == "merged"' },
    { entry: { item: 'S-2', expression: 'status == "done"' }, text: 'S-2: status == "done"' },
  ]);
  assert.deepEqual(await statusGate(ctx, recordOf(ctx, 'S-2'), 'merged'), [], 'no entry for S-2');
  assert.deepEqual(snapshot(ctx), before, 'the evaluation commits nothing and changes no file');

  await setStatuses(ctx, { 'S-2': 'done' });
  assert.deepEqual(
    (await statusGate(ctx, recordOf(ctx, 'S-1'), 'merged')).map(({ text }) => text),
    ['S-1: status == "merged"'],
  );
});

test("the status gate gives the flow's failing entries, then the dependency entries", async () => {
  const ctx = engineBacklog();
  await createItems(ctx, [
    { type: 'story', state: { status: 'merged', ...IDLE } },
    { type: 'task', state: { status: 'draft', ...IDLE } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: 'S-1' } });
  await setGraph(ctx, 'dependency', { 'S-1': { done: [{ 'T-1': 'status == "done"' }] } });
  assert.deepEqual(
    (await statusGate(ctx, recordOf(ctx, 'S-1'), 'done')).map(({ text }) => text),
    ['children("task").all(c, c.closed)', 'T-1: status == "done"'],
  );
});

/** A flow file with a defined step whose step gate, code step gate and `after` each have failing entries. */
const ORDER = `
flows:
  chore:
    initial: open
    statuses: { open: {}, shut: {} }
    entries: { run: { from: [open], start: checked } }
    steps:
      checked: { success: { status: shut, next: stop }, failure: stop }
defined_steps:
  checked: { use: test, after: ['status == "a"', 'status == "refined"', 'status == "b"'] }
step_gates:
  checked: ['status == "x"', 'status == "refined"', 'status == "y"']
  test: [{ condition: 'status == "z"', class: expected }]
`;

test("a node's step gate and its after entries give their failing entries in order: the defined step's, then the code step's", async () => {
  const ctx = engineBacklog({ 'order.yaml': ORDER });
  await createItems(ctx, [{ type: 'story', state: { status: 'refined', ...IDLE } }]);
  const node = ctx.flowSet.flows.chore.nodes.checked;
  const story = recordOf(ctx, 'S-1');
  const before = snapshot(ctx);
  assert.deepEqual(await stepGate(ctx, story, node), [
    { entry: 'status == "x"', text: 'status == "x"' },
    { entry: 'status == "y"', text: 'status == "y"' },
    { entry: { condition: 'status == "z"', class: 'expected' }, text: 'status == "z"' },
  ]);
  assert.deepEqual(await postConditions(ctx, story, node), [
    { entry: 'status == "a"', text: 'status == "a"' },
    { entry: 'status == "b"', text: 'status == "b"' },
  ]);
  assert.deepEqual(snapshot(ctx), before, 'the evaluation commits nothing and changes no file');
  const passing = ctx.flowSet.flows.story.nodes['deliver/self_check/count_test_fix'];
  assert.deepEqual([await stepGate(ctx, story, passing), await postConditions(ctx, story, passing)], [[], []]);
});

/** Failing step gates on the subflows deliver and self_check and on the defined step test_unit. */
const ENTRY_GATES = `
step_gates:
  deliver: ['status == "deliver"']
  self_check: ['status == "self_check"']
  test_unit: ['status == "test_unit"']
`;

test('stepGate checks the entry gates of the subflows that the flow enters, outermost first, then the node gate (Decision A4)', async () => {
  const ctx = engineBacklog({ 'entry-gates.yaml': ENTRY_GATES });
  await createItems(ctx, [{ type: 'story', state: { status: 'in_progress', ...IDLE } }]);
  const node = ctx.flowSet.flows.story.nodes['deliver/self_check/test_unit'];
  const story = recordOf(ctx, 'S-1');
  const before = snapshot(ctx);
  const texts = async (/** @type {string|null|undefined} */ previous) =>
    (await stepGate(ctx, story, node, previous)).map(({ text }) => text);
  const all = ['status == "deliver"', 'status == "self_check"', 'status == "test_unit"'];
  assert.deepEqual(await texts('in_unit'), all, 'entering both subflows from the story flow');
  assert.deepEqual(await texts(null), all, "the invocation's first node");
  assert.deepEqual(await texts(undefined), all, 'no previous node given');
  assert.deepEqual(await texts('deliver/fix'), all.slice(1), 'entering self_check from inside deliver');
  assert.deepEqual(await texts('deliver/self_check/fix'), all.slice(2), 'a loop inside self_check');
  assert.deepEqual(await texts('deliver_child/self_check/fix'), all, 'another copy of self_check is not inside');
  assert.deepEqual(snapshot(ctx), before, 'the evaluation commits nothing and changes no file');
});

test('a gate entry that throws is an error that names the expression, not a failing entry', async () => {
  const ctx = engineBacklog({ 'throws.yaml': 'step_gates:\n  test_unit: [\'attributes.owner == "bl"\']\n' });
  await createItems(ctx, [{ type: 'story', state: { status: 'in_progress', ...IDLE } }]);
  const node = ctx.flowSet.flows.story.nodes['deliver/self_check/test_unit'];
  await assert.rejects(async () => stepGate(ctx, recordOf(ctx, 'S-1'), node, 'in_unit'), {
    message: 'attributes.owner == "bl": No such key: owner',
  });
  // A status gate has no agent box, so has_capacity() there throws.
  await setGraph(ctx, 'dependency', { 'S-1': { done: [{ 'S-1': 'has_capacity()' }] } });
  await assert.rejects(async () => statusGate(ctx, recordOf(ctx, 'S-1'), 'done'), {
    message: 'has_capacity(): has_capacity() needs an agent box',
  });
});
