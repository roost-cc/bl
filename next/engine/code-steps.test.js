// The code steps succeed, assert and increment (F-140 D5) on a fixture task flow beside the uTop
// flow set, run by F-139's runner with the real step catalogue. They are here, not in steps/,
// because only engine/ may import the runner (the layer rule, F-135 D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS } from '../steps/index.js';
import { itemDir } from '../store/items.js';
import { createItems, engineBacklog } from '../test/helpers/engine-backlog.js';
import { UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { git } from '../test/helpers/git.js';
import { runFlow } from './runner.js';

const CATALOGUE = { ...UTOP_STEPS, ...STEPS };

/** A task flow whose `run` entry starts at the box `first`, written as `box`. */
const taskFlow = (/** @type {string} */ box) =>
  [
    'flows:',
    '  task:',
    '    initial: draft',
    '    statuses: { draft: {}, done: {}, superseded: {} }',
    '    entries:',
    '      run: { from: [draft], start: first }',
    '    steps:',
    `      first: ${box}`,
    '',
  ].join('\n');

/** A backlog with the task flow of `box`, and one task with `state`. */
async function task(/** @type {string} */ box, /** @type {Record<string, unknown>} */ state = {}) {
  const ctx = engineBacklog({ 'task.yaml': taskFlow(box) }, undefined, CATALOGUE);
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle', ...state } }]);
  return { ctx, id };
}

/** Run the `run` entry of the task once, and give its result or its crash. */
const run = (/** @type {any} */ ctx, /** @type {string} */ id) =>
  runFlow(ctx, { id, start: 'first', by: 'operator', entry: 'run', catalogue: CATALOGUE }).catch((e) => e);

/** One task of the task flow of `box` with `state`, run once. */
const runTask = async (/** @type {string} */ box, /** @type {Record<string, unknown>} */ state = {}) => {
  const { ctx, id } = await task(box, state);
  return run(ctx, id);
};

const ARROWS = 'success: { status: done, next: stop }, failure: { status: superseded, next: stop }';
const ASSERT = `{ use: assert, with: ['counters.r.value < counters.r.threshold'], ${ARROWS} }`;
const INCREMENT = '{ use: increment, with: { counter: r, threshold: 3 }, success: stop }';

test('succeed_goes_to_its_success_arrow', async () => {
  assert.deepEqual(await runTask('{ use: succeed, success: { status: done, next: stop } }'), {
    ended: 'stop',
    status: 'done',
    outcome: 'success',
  });
});

test('assert_gives_success_when_every_entry_holds_and_failure_when_one_does_not', async () => {
  const cases = [
    // [what, counters, the status at the end, the outcome]
    ['value 1 of threshold 3', { r: { value: 1, threshold: 3 } }, 'done', 'success'],
    ['value 3 of threshold 3', { r: { value: 3, threshold: 3 } }, 'superseded', 'failure'],
  ];
  for (const [what, counters, status, outcome] of cases) {
    assert.deepEqual(await runTask(ASSERT, { counters }), { ended: 'stop', status, outcome }, what);
  }
  const two = `{ use: assert, with: ['status == "draft"', 'counters.r.value > 5'], ${ARROWS} }`;
  assert.equal((await runTask(two, { counters: { r: { value: 1, threshold: 3 } } })).outcome, 'failure');
});

test('assert_entry_that_throws_is_a_crash_that_names_the_expression', async () => {
  // A counter that the item does not have is an absent key, which never counts as false (D-496).
  const crash = await runTask(ASSERT);
  assert.equal(crash.name, 'FlowCrash');
  assert.match(crash.message, /^first: counters\.r\.value < counters\.r\.threshold: /);
  // An entry after a false one is still evaluated.
  const late = await runTask(`{ use: assert, with: ['false', 'counters.r.value > 0'], ${ARROWS} }`);
  assert.equal(late.name, 'FlowCrash');
  assert.match(late.message, /^first: counters\.r\.value > 0: /);
});

/** Run the task once, and give the subject of HEAD and the item's state.json in it. */
async function committed(/** @type {any} */ ctx, /** @type {string} */ id) {
  await run(ctx, id);
  return {
    subject: git(ctx.backlogDir, 'log', '-1', '--format=%s'),
    state: JSON.parse(git(ctx.backlogDir, 'show', `HEAD:${itemDir(ctx, id).path}/state.json`)),
  };
}

test('increment_commits_counter_with_box_run_state', async () => {
  const { ctx, id } = await task(INCREMENT);
  // The box's own commit holds the counter beside the run state it ends with.
  assert.deepEqual(await committed(ctx, id), {
    subject: `${id}: first success`,
    state: { status: 'draft', run: 'idle', counters: { r: { value: 1, threshold: 3 } } },
  });
  assert.deepEqual((await committed(ctx, id)).state.counters, { r: { value: 2, threshold: 3 } });
});

test('increment_keeps_stored_threshold_and_other_counters', async () => {
  const stored = await task(INCREMENT, { counters: { r: { value: 4, threshold: 6 }, other: { threshold: 2 } } });
  assert.deepEqual((await committed(stored.ctx, stored.id)).state.counters, {
    r: { value: 5, threshold: 6 },
    other: { threshold: 2 },
  });
  // A stored counter with no value counts from 0, and keeps the threshold it has.
  const novalue = await task(INCREMENT, { counters: { r: { threshold: 5 } } });
  assert.deepEqual((await committed(novalue.ctx, novalue.id)).state.counters, { r: { value: 1, threshold: 5 } });
});

test('increment_with_needs_counter_and_threshold_of_1_or_more', () => {
  const bad = [
    {},
    { counter: 'r' },
    { threshold: 3 },
    { counter: 'r', threshold: 0 },
    { counter: 'r', threshold: 1.5 },
    { counter: '', threshold: 3 },
    { counter: 'r', threshold: 3, extra: 1 },
  ];
  for (const value of bad) {
    const box = INCREMENT.replace('{ counter: r, threshold: 3 }', JSON.stringify(value));
    assert.throws(
      () => engineBacklog({ 'task.yaml': taskFlow(box) }, undefined, CATALOGUE),
      /first\/with/,
      JSON.stringify(value),
    );
  }
});
