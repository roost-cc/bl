// The flow runner (F-139 D8): a story of the uTop flow set from a node to stop or to a failing
// gate, with fake steps, on a committed backlog repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { parse, stringify } from 'yaml';
import { itemLockPath } from '../lib/lock.js';
import { itemDir } from '../store/items.js';
import { createItems, engineBacklog, setGraph } from '../test/helpers/engine-backlog.js';
import { UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { git } from '../test/helpers/git.js';
import { holdLockInChild } from '../test/helpers/hold-lock.js';
import { readRunState } from './run-state.js';
import { FlowCrash, runFlow } from './runner.js';

/**
 * uTop's `defined-steps.yaml` with no step gates and no post-conditions (their conditions call
 * functions that F-139 does not bind), after `edit` changes its `defined_steps`.
 */
function definedSteps(edit = (/** @type {any} */ _steps) => {}) {
  const value = parse(UTOP['defined-steps.yaml']);
  delete value.step_gates;
  for (const step of Object.values(value.defined_steps)) delete step.after;
  edit(value.defined_steps);
  return stringify(value);
}

/** uTop's `story.yaml` after `edit` changes the story flow. */
function storyFlow(edit) {
  const value = parse(UTOP['story.yaml']);
  edit(value.flows.story);
  return stringify(value);
}

/** A backlog with the uTop flow set, `defined-steps.yaml` as `definedSteps()` gives it, and `flows`. */
const backlog = (flows = {}) => engineBacklog({ 'defined-steps.yaml': definedSteps(), ...flows });

/** Make one story with `state`, and give its id. */
const story = async (ctx, state) => (await createItems(ctx, [{ type: 'story', state }]))[0];

/**
 * The uTop test catalogue with fake steps: each records its box in `ran`, and gives the outcome
 * that `plan` names for its box (`success` when none). A plan value is an outcome, a function of
 * the step's context that gives one, or a list of those, used one per run.
 * @param {Record<string, any>} [plan]
 */
function fakeSteps(plan = {}) {
  /** @type {string[]} */
  const ran = [];
  const catalogue = Object.fromEntries(
    Object.entries(UTOP_STEPS).map(([name, step]) => [
      name,
      {
        ...step,
        run: async (/** @type {any} */ ctx) => {
          ran.push(ctx.box);
          const planned = Array.isArray(plan[ctx.box]) ? plan[ctx.box].shift() : plan[ctx.box];
          return typeof planned === 'function' ? planned(ctx) : (planned ?? 'success');
        },
      },
    ]),
  );
  return { catalogue, ran };
}

const itemPath = (ctx, id) => join(ctx.backlogDir, itemDir(ctx, id).path);
const stateOf = (ctx, id) => JSON.parse(readFileSync(join(itemPath(ctx, id), 'state.json'), 'utf8'));
const logOf = (ctx, id) =>
  readFileSync(join(itemPath(ctx, id), 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const head = (ctx) => git(ctx.backlogDir, 'rev-parse', 'HEAD');

/** Each commit after `base`, oldest first: its sha, subject, whole message and `Bl-` trailers. */
function commitsSince(ctx, base) {
  return git(ctx.backlogDir, 'log', '--reverse', '--format=%H%x1f%B%x1e', `${base}..HEAD`)
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [sha, message] = entry.split('\x1f');
      const lines = message.trim().split('\n');
      return { sha, subject: lines[0], message, trailers: lines.filter((line) => /^Bl-[\w-]+: /.test(line)) };
    });
}

/** The run state each commit after `base` stores for the item at `path` (relative to the backlog). */
const storedRuns = (ctx, base, path) =>
  commitsSince(ctx, base).map(({ sha }) => JSON.parse(git(ctx.backlogDir, 'show', `${sha}:${path}/state.json`)).run);

/** The boxes of the run entry, from prepare to stop, for a story in a unit (all steps succeed). */
const RUN_BOXES = [
  'prepare',
  'implement',
  'in_unit',
  'deliver_child/self_check/test_unit',
  'deliver_child/self_check/self_review/self_round',
  'deliver_child/self_check/self_review/self_closing_round',
  'deliver_child/self_check/self_review/self_verify',
  'deliver_child/self_check/self_review/findings_closed',
  'deliver_child/join_child/join',
  'deliver_child/join_child/test_unit',
  'deliver_child/join_child/fast_forward',
];

test("runFlow takes a story from the run entry's start box to stop: one commit for the start and one per box, with trailers, and one flow_start and one flow_end", async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  const start = ctx.flowSet.flows.story.entries.run.start;
  assert.equal(start, 'prepare');

  const result = await runFlow(ctx, { id, start, by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'implemented', outcome: 'success' });
  assert.deepEqual(ran, RUN_BOXES);

  const commits = commitsSince(ctx, base);
  assert.deepEqual(
    commits.map(({ subject }) => subject),
    [`${id}: run started`, ...RUN_BOXES.map((box) => `${id}: ${box} success`)],
  );
  assert.deepEqual(
    commits.map(({ trailers }) => trailers),
    ['prepare', ...RUN_BOXES].map((box) => ['Bl-Flow: story', `Bl-Step: ${box}`, `Bl-Item: ${id}`]),
  );

  const log = logOf(ctx, id);
  assert.deepEqual(
    log.map(({ event }) => event),
    ['created', 'flow_start', 'flow_end'],
  );
  const { at: startAt, ...flowStart } = log[1];
  const { at: endAt, ...flowEnd } = log[2];
  assert.match(startAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(endAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(flowStart, { event: 'flow_start', entry: 'run', status: 'refined', by: 'operator' });
  assert.deepEqual(flowEnd, {
    event: 'flow_end',
    ended: 'stop',
    outcome: 'success',
    status: 'implemented',
    commits: [],
  });
  assert.deepEqual(stateOf(ctx, id), { status: 'implemented', run: 'idle' });
});

test('the stored run state names each step before it runs: active at its box, on this host', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  /** @type {Record<string, unknown>} */
  const seen = {};
  const look = (/** @type {any} */ step) => {
    seen[step.box] = stateOf(ctx, step.id);
    return 'success';
  };
  const { catalogue } = fakeSteps({ prepare: look, implement: look, 'deliver_child/join_child/join': look });
  await runFlow(ctx, { id, start: 'prepare', by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(seen, {
    prepare: { status: 'refined', run: 'active: prepare', host: hostname() },
    implement: { status: 'in_progress', run: 'active: implement', host: hostname() },
    'deliver_child/join_child/join': {
      status: 'in_progress',
      run: 'active: deliver_child/join_child/join',
      host: hostname(),
    },
  });
});

test("a step's staged write lands in its box's commit, and its recorded commit in the flow_end's commits", async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  const usage = { step: 'implement', agent: 'headless', input: 1, output: 2, cache_creation: 3, cache_read: 4 };
  const { catalogue } = fakeSteps({
    implement: (/** @type {any} */ step) => {
      step.stage((/** @type {any} */ w) => w.usage(step.id, { at: '2026-11-27T10:00:00Z', ...usage }));
      step.recordCommit({ repo: 'bl', sha: 'abc123' });
      return 'success';
    },
  });
  await runFlow(ctx, { id, start: 'prepare', by: 'operator', entry: 'run', catalogue });

  const path = itemDir(ctx, id).path;
  const implement = commitsSince(ctx, base).find(({ subject }) => subject === `${id}: implement success`);
  assert.deepEqual(git(ctx.backlogDir, 'show', '--name-only', '--format=', implement.sha).split('\n').sort(), [
    `${path}/state.json`,
    `${path}/usage.jsonl`,
  ]);
  assert.deepEqual(JSON.parse(git(ctx.backlogDir, 'show', `${implement.sha}:${path}/usage.jsonl`)), {
    at: '2026-11-27T10:00:00Z',
    ...usage,
  });
  assert.deepEqual(logOf(ctx, id).at(-1).commits, [{ repo: 'bl', sha: 'abc123' }]);
});

test('a failing status gate keeps the status and ends at gated: <to> with held; the failing entries are only in the note', async () => {
  const ctx = backlog();
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'implemented', run: 'idle' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: id } });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();

  const result = await runFlow(ctx, { id, start: 'close', by: 'operator', entry: 'close', catalogue });
  assert.deepEqual(result, { ended: 'gated: done', status: 'implemented', outcome: 'success' });
  assert.deepEqual(ran, ['close']);
  assert.deepEqual(stateOf(ctx, id), {
    status: 'implemented',
    run: 'gated: done',
    held: { box: 'close', outcome: 'success' },
  });
  const { at, ...flowEnd } = logOf(ctx, id).at(-1);
  assert.deepEqual(flowEnd, {
    event: 'flow_end',
    ended: 'gated: done',
    outcome: 'success',
    status: 'implemented',
    commits: [],
    note: 'the status gate of done failed: children("task").all(c, c.closed)',
  });
  assert.deepEqual(
    commitsSince(ctx, base).map(({ subject }) => subject),
    [`${id}: close started`, `${id}: close success`],
  );
});

test('a failing step gate ends at gated before: <box> without running the step; the failing entries are only in the note', async () => {
  const ctx = backlog({ 'gates.yaml': 'step_gates:\n  close: [\'status == "merged"\']\n' });
  const id = await story(ctx, { status: 'implemented', run: 'idle' });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();

  const result = await runFlow(ctx, { id, start: 'close', by: 'operator', entry: 'close', catalogue });
  assert.deepEqual(result, { ended: 'gated before: close', status: 'implemented' });
  assert.deepEqual(ran, []);
  assert.deepEqual(stateOf(ctx, id), { status: 'implemented', run: 'gated before: close' });
  const { at, ...flowEnd } = logOf(ctx, id).at(-1);
  assert.deepEqual(flowEnd, {
    event: 'flow_end',
    ended: 'gated before: close',
    status: 'implemented',
    commits: [],
    note: 'the step gate of close failed: status == "merged"',
  });
  assert.deepEqual(
    commitsSince(ctx, base).map(({ subject, trailers }) => [subject, trailers[1]]),
    [
      [`${id}: close started`, 'Bl-Step: close'],
      [`${id}: close gated before`, 'Bl-Step: close'],
    ],
  );
});

/** A gate on the subflow self_check: true while the story has no task child. */
const SELF_CHECK_GATE = { 'gates.yaml': 'step_gates:\n  self_check: [\'children("task").size() == 0\']\n' };

/** A fake step that makes a task child of the story in its box's commit, and succeeds. */
const addTask = (/** @type {any} */ step) => {
  step.stage((/** @type {any} */ w) => {
    const task = w.create('task', 'a task', { state: { status: 'draft', run: 'idle' }, by: 'operator' });
    w.graph('containment', (value) => ({ ...value, [task]: { parent: step.id } }));
  });
  return 'success';
};

test("a subflow's gate is checked when the invocation starts at the subflow's first node (Decision A4)", async () => {
  const ctx = backlog(SELF_CHECK_GATE);
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'in_review', run: 'gated before: deliver/self_check/test_unit' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: id } });
  const { catalogue, ran } = fakeSteps();
  const start = 'deliver/self_check/test_unit';
  const result = await runFlow(ctx, { id, start, by: 'operator', resume: true, catalogue });
  assert.deepEqual(result, { ended: `gated before: ${start}`, status: 'in_review' });
  assert.deepEqual(ran, []);
  const { event, resume } = logOf(ctx, id).at(-2);
  assert.deepEqual({ event, resume }, { event: 'flow_start', resume: true });
});

test("a subflow's gate is checked when deliver's fix arrow enters self_check from outside (Decision A4)", async () => {
  const ctx = backlog(SELF_CHECK_GATE);
  const id = await story(ctx, { status: 'in_progress', run: 'idle' });
  const { catalogue, ran } = fakeSteps({
    in_unit: 'failure', // a loose story: deliver
    'deliver/peer_review/findings_closed': 'failure',
    'deliver/fix': addTask,
  });
  const result = await runFlow(ctx, { id, start: 'in_unit', by: 'operator', entry: 'deliver', catalogue });
  assert.deepEqual(result, {
    ended: 'gated before: deliver/self_check/test_unit',
    status: 'in_review',
    outcome: 'success',
  });
  assert.equal(ran.filter((box) => box === 'deliver/self_check/test_unit').length, 1, 'entered once, then gated');
  assert.deepEqual(ran.slice(-3), ['deliver/peer_review/findings_closed', 'deliver/peer_round_cap', 'deliver/fix']);
});

test("a loop inside self_check back to test_unit does not check self_check's gate (Decision A4)", async () => {
  const ctx = backlog(SELF_CHECK_GATE);
  const id = await story(ctx, { status: 'in_progress', run: 'idle' });
  const { catalogue, ran } = fakeSteps({
    in_unit: 'failure',
    'deliver/self_check/test_unit': ['failure', 'success'],
    'deliver/self_check/count_test_fix': addTask, // the gate is false from here on
  });
  const result = await runFlow(ctx, { id, start: 'in_unit', by: 'operator', entry: 'deliver', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'ready_for_merge', outcome: 'success' });
  assert.deepEqual(ran.slice(0, 6), [
    'in_unit',
    'deliver/self_check/test_unit',
    'deliver/self_check/count_test_fix',
    'deliver/self_check/test_cap',
    'deliver/self_check/fix_test_failure',
    'deliver/self_check/test_unit',
  ]);
});

test('a failing post-condition turns success into failure, and the commit message names the failed entries', async () => {
  const ctx = engineBacklog({
    'defined-steps.yaml': definedSteps((steps) => {
      steps.implement.after = ['status == "implemented"', 'status == "in_progress"'];
    }),
  });
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps({ wait_implement: 'failure' });
  const result = await runFlow(ctx, { id, start: 'prepare', by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'in_progress', outcome: 'failure' });
  assert.deepEqual(ran, ['prepare', 'implement', 'notify_implement', 'wait_implement']);
  const implement = commitsSince(ctx, base)[2];
  assert.equal(implement.subject, `${id}: implement failure`);
  assert.match(implement.message, /the post-conditions of implement failed: status == "implemented"\n/);
});

test('an outcome with no arrow commits an outcome entry and throws FlowCrash; the item then reads interrupted', async () => {
  // close runs succeed, which has only a success arrow; a failing post-condition makes it fail.
  const ctx = engineBacklog({
    'defined-steps.yaml': definedSteps((steps) => {
      steps.close.after = ['status == "merged"'];
    }),
  });
  const id = await story(ctx, { status: 'implemented', run: 'idle' });
  const { catalogue } = fakeSteps();
  await assert.rejects(runFlow(ctx, { id, start: 'close', by: 'operator', entry: 'close', catalogue }), {
    name: 'FlowCrash',
    message: 'close: no arrow for the outcome failure in config/flows/story.yaml',
  });
  const { at, ...outcome } = logOf(ctx, id).at(-1);
  assert.deepEqual(outcome, {
    event: 'outcome',
    box: 'close',
    outcome: 'failure',
    note: 'the post-conditions of close failed: status == "merged"',
    by: 'operator',
  });
  const state = stateOf(ctx, id);
  assert.equal(state.run, 'active: close');
  assert.equal(readRunState(ctx, id, state), 'interrupted: close');
});

test('a step that throws is a FlowCrash with no flow_end, and the item then reads interrupted at its box', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const { catalogue } = fakeSteps({
    implement: () => {
      throw new Error('the agent crashed');
    },
  });
  const crash = await runFlow(ctx, { id, start: 'prepare', by: 'operator', entry: 'run', catalogue }).catch((e) => e);
  assert.ok(crash instanceof FlowCrash);
  assert.equal(crash.message, 'implement: the agent crashed');
  assert.deepEqual(
    logOf(ctx, id).map(({ event }) => event),
    ['created', 'flow_start'],
  );
  const state = stateOf(ctx, id);
  assert.deepEqual(state, { status: 'in_progress', run: 'active: implement', host: hostname() });
  assert.equal(readRunState(ctx, id, state), 'interrupted: implement');
  assert.equal(readRunState(ctx, id, { ...state, host: `not-${hostname()}` }), 'active: implement', 'another host');
});

test('the visit limit is a FlowCrash that names the box and the limit, with no flow_end', async () => {
  const ctx = backlog({ 'flow-set.yaml': 'max_box_visits: 2\ngate_recheck_minutes: 15\n' });
  const id = await story(ctx, { status: 'in_progress', run: 'idle' });
  const { catalogue, ran } = fakeSteps({ 'self_check/test_unit': () => 'failure' });
  await assert.rejects(
    runFlow(ctx, { id, start: 'self_check/test_unit', by: 'operator', resume: true, catalogue }),
    (error) => error instanceof FlowCrash && error.message === 'self_check/test_unit started 3 times (max_box_visits)',
  );
  assert.equal(ran.filter((box) => box === 'self_check/test_unit').length, 2);
  assert.equal(logOf(ctx, id).at(-1).event, 'flow_start');
  assert.equal(readRunState(ctx, id, stateOf(ctx, id)), 'interrupted: self_check/test_unit');
});

/** The story flow with a status on both sides of deliver's return (flow-config.md, case 4). */
const BOTH_SIDES = {
  'story.yaml': storyFlow((flow) => {
    flow.steps.deliver.success = { status: 'merged', next: 'stop' };
  }),
};

test('a return node is never active, and a status on the arrow into it and one on the caller arrow are both made (case 4)', async () => {
  const ctx = backlog(BOTH_SIDES);
  const id = await story(ctx, { status: 'in_progress', run: 'idle' });
  const base = head(ctx);
  const { catalogue } = fakeSteps({ in_unit: 'failure' });
  const result = await runFlow(ctx, { id, start: 'in_unit', by: 'operator', entry: 'deliver', catalogue });
  // merged is set only from ready_for_merge, which the arrow into deliver/_return_success sets.
  assert.deepEqual(result, { ended: 'stop', status: 'merged', outcome: 'success' });
  const runs = storedRuns(ctx, base, itemDir(ctx, id).path);
  assert.ok(runs.length > 10);
  assert.deepEqual(
    runs.filter((run) => run.includes('/_return_')),
    [],
  );
});

test("a failing gate on the caller's arrow out of a return node holds the transition at the return node (case 4)", async () => {
  const ctx = backlog(BOTH_SIDES);
  const id = await story(ctx, { status: 'in_progress', run: 'idle' });
  await setGraph(ctx, 'dependency', { [id]: { merged: [{ [id]: 'false' }] } });
  const { catalogue } = fakeSteps({ in_unit: 'failure' });
  const result = await runFlow(ctx, { id, start: 'in_unit', by: 'operator', entry: 'deliver', catalogue });
  assert.deepEqual(result, { ended: 'gated: merged', status: 'ready_for_merge', outcome: 'success' });
  assert.deepEqual(stateOf(ctx, id), {
    status: 'ready_for_merge',
    run: 'gated: merged',
    held: { box: 'deliver/_return_success', outcome: 'success' },
  });
  assert.equal(logOf(ctx, id).at(-1).note, `the status gate of merged failed: ${id}: false`);
});

test('runFlow_second_return_transition_gate_sees_first_transition', async () => {
  // The arrow into deliver/_return_success sets ready_for_merge from in_review; the caller's
  // arrow then sets merged. Each status gate reads the status that the arrow before it reached.
  const gated = (gates) =>
    backlog({
      'story.yaml': storyFlow((flow) => {
        flow.steps.deliver.success = { status: 'merged', next: 'stop' };
        for (const [to, condition] of Object.entries(gates)) flow.statuses[to] = { gate: [condition] };
      }),
    });
  const cases = [
    // [gates, the result]
    [
      { ready_for_merge: 'status == "in_review"', merged: 'status == "ready_for_merge"' },
      { ended: 'stop', status: 'merged', outcome: 'success' },
    ],
    [{ merged: 'status == "in_review"' }, { ended: 'gated: merged', status: 'ready_for_merge', outcome: 'success' }],
    [
      { ready_for_merge: 'status == "ready_for_merge"' },
      { ended: 'gated: ready_for_merge', status: 'in_review', outcome: 'success' },
    ],
  ];
  for (const [gates, expected] of cases) {
    const ctx = gated(gates);
    const id = await story(ctx, { status: 'in_progress', run: 'idle' });
    const { catalogue } = fakeSteps({ in_unit: 'failure' });
    const result = await runFlow(ctx, { id, start: 'in_unit', by: 'operator', entry: 'deliver', catalogue });
    assert.deepEqual(result, expected, JSON.stringify(gates));
  }
});

test('an arrow whose derived from does not hold the status stops the invocation with a note, and keeps the status', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'draft', run: 'idle' });
  const { catalogue } = fakeSteps();
  const result = await runFlow(ctx, { id, start: 'close', by: 'operator', resume: true, catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'draft', outcome: 'success' });
  assert.deepEqual(stateOf(ctx, id), { status: 'draft', run: 'idle' });
  assert.equal(logOf(ctx, id).at(-1).note, 'the success arrow of close sets done only from implemented');
});

test('runFlow is refused, with no commit, while another process holds the item lock, and names its pid', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'idle' });
  const base = head(ctx);
  const child = await holdLockInChild(itemLockPath(ctx.backlogDir, id));
  try {
    const { catalogue, ran } = fakeSteps();
    await assert.rejects(runFlow(ctx, { id, start: 'close', by: 'operator', entry: 'close', catalogue }), {
      message: new RegExp(`^${id}: another process \\(pid ${child.pid}\\) runs its flow`),
    });
    assert.deepEqual(ran, []);
    assert.equal(head(ctx), base);
  } finally {
    await child.kill();
  }
});

test('runFlow refuses a start that is no box of the flow, or a return node, with no commit and no step run', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'idle' });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  for (const start of ['gone', 'deliver/_return_success']) {
    await assert.rejects(runFlow(ctx, { id, start, by: 'operator', resume: true, catalogue }), {
      message: `${id}: '${start}' is no box of the story flow`,
    });
  }
  assert.deepEqual(ran, []);
  assert.equal(head(ctx), base);
  assert.deepEqual(stateOf(ctx, id), { status: 'implemented', run: 'idle' });
});

test('a stored state that the flow no longer has is reset first, in its own commit with a reset entry', async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'waiting: gone', counters: { rounds: { value: 2 } } });
  const base = head(ctx);
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  const { catalogue } = fakeSteps();
  const result = await runFlow(ctx, { id, start: 'close', by: 'operator', entry: 'close', catalogue });
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });

  const note = "no longer in the story flow: the box 'gone'";
  const log = logOf(ctx, id);
  assert.deepEqual(
    log.map(({ event }) => event),
    ['created', 'reset', 'flow_start', 'flow_end'],
  );
  const { at, ...reset } = log[1];
  assert.deepEqual(reset, { event: 'reset', run: 'waiting: gone', status: 'implemented', note });
  assert.deepEqual(printed, [`${id}: reset: ${note}\n`]);
  const commits = commitsSince(ctx, base);
  assert.deepEqual(commits[0].subject, `${id}: reset to the story flow`);
  assert.deepEqual(commits[0].trailers, ['Bl-Flow: story', `Bl-Item: ${id}`]);
  assert.deepEqual(stateOf(ctx, id), { status: 'done', run: 'idle', counters: { rounds: { value: 2 } } });
});
