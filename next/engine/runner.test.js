// The flow runner (F-139 D8): a story of the uTop flow set from a node to stop or to a failing
// gate, with fake steps, on a committed backlog repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { parse, stringify } from 'yaml';
import { holderOf } from '../lib/kernel-lock.js';
import { itemLockPath } from '../lib/lock.js';
import { itemDir } from '../store/items.js';
import { STEPS } from '../steps/index.js';
import { storeWrite } from '../store/write.js';
import { createItems, definedSteps, engineBacklog, setGraph } from '../test/helpers/engine-backlog.js';
import { startFlowChild } from '../test/helpers/flow-child-run.js';
import { UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { git, tempRepo } from '../test/helpers/git.js';
import { holdLockInChild } from '../test/helpers/hold-lock.js';
import { channel, delivered, notifyBacklog } from '../test/helpers/notify-backlog.js';
import { sendUsr2 } from '../test/helpers/sigusr2.js';
import { recordingWake, suspending } from '../test/helpers/suspending.js';
import { waitUntil } from '../test/helpers/wait-until.js';
import { readRunState } from './run-state.js';
import { FlowCrash, runFlow } from './runner.js';
import { BURST_MS, waitForWake } from './wake.js';

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

  const result = await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
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
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
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

test('ctx.from is the path of the previous node, and absent at the first node (F-140 D9)', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  /** @type {Record<string, unknown>} */
  const from = {};
  const look = (/** @type {any} */ step) => {
    from[step.box] = 'from' in step ? step.from : '(absent)';
    return 'success';
  };
  const boxes = ['prepare', 'implement', 'in_unit', 'deliver_child/self_check/test_unit'];
  const { catalogue } = fakeSteps(Object.fromEntries(boxes.map((box) => [box, look])));
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(from, {
    prepare: '(absent)',
    implement: 'prepare',
    in_unit: 'implement',
    'deliver_child/self_check/test_unit': 'in_unit',
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
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });

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

/** A fake step that stages a state.json of its own: a counter, and a status and run state that are wrong. */
const stageState = (/** @type {any} */ step) => {
  step.stage((/** @type {any} */ w) =>
    w.state(step.id, { status: 'draft', run: 'active: prepare', counters: { attempts: { value: 1 } } }),
  );
  return 'success';
};
const ATTEMPTS = { attempts: { value: 1 } };

test('runFlow_preserves_next_box_when_step_stages_state', async () => {
  const cases = [
    // [what, flows, status, start, the boxes that stage state, the state at the end, the last log event]
    [
      'a box the flow goes on from (prepare), then a step that crashes',
      {},
      'refined',
      'prepare',
      { prepare: stageState, implement: () => Promise.reject(new Error('the agent crashed')) },
      { status: 'in_progress', run: 'active: implement', host: hostname(), counters: ATTEMPTS },
      'flow_start',
    ],
    [
      'a box that ends the flow at stop (close)',
      {},
      'implemented',
      'close',
      { close: stageState },
      { status: 'done', run: 'idle', counters: ATTEMPTS },
      'flow_end',
    ],
    [
      'a box whose outcome has no arrow (close, failing its post-condition)',
      { 'defined-steps.yaml': definedSteps((steps) => (steps.close.after = ['false'])) },
      'implemented',
      'close',
      { close: stageState },
      { status: 'implemented', run: 'active: close', host: hostname(), counters: ATTEMPTS },
      'outcome',
    ],
  ];
  for (const [what, flows, status, start, plan, state, event] of cases) {
    const ctx = backlog(flows);
    const id = await story(ctx, { status, run: 'idle', next: start });
    const { catalogue } = fakeSteps(plan);
    await runFlow(ctx, { id, by: 'operator', resume: true, catalogue }).catch((e) => e);
    assert.deepEqual(stateOf(ctx, id), state, what);
    assert.equal(logOf(ctx, id).at(-1).event, event, what);
  }
});

test('runFlow_keeps_counters_when_staged_state_omits_them', async () => {
  const COMMITTED = { attempts: { value: 3 } };
  const STAGED = { attempts: { value: 4 } };
  const OTHER = { status: 'draft', run: 'idle' };
  const paths = [
    // [the commit path, flows, status, start, the step plan for the staging step, the state at the end]
    [
      'a box the flow goes on from',
      {},
      'refined',
      'prepare',
      (stage) => ({ prepare: stage, implement: () => Promise.reject(new Error('the agent crashed')) }),
      { status: 'in_progress', run: 'active: implement', host: hostname() },
    ],
    [
      'a box that ends at stop',
      {},
      'implemented',
      'close',
      (stage) => ({ close: stage }),
      { status: 'done', run: 'idle' },
    ],
    [
      'a box whose outcome has no arrow',
      { 'defined-steps.yaml': definedSteps((steps) => (steps.close.after = ['false'])) },
      'implemented',
      'close',
      (stage) => ({ close: stage }),
      { status: 'implemented', run: 'active: close', host: hostname() },
    ],
  ];
  const writes = [
    // [what, the item's staged states in order, the counters at the end]
    ['one write without counters', [{}], COMMITTED],
    ['a write with counters, then one without', [{ counters: STAGED }, {}], STAGED],
    ['a write without counters, then one with', [{}, { counters: STAGED }], STAGED],
    ['only a write to another item', [], COMMITTED],
  ];
  for (const [path, flows, status, start, plan, state] of paths) {
    for (const [what, staged, counters] of writes) {
      const ctx = backlog(flows);
      const [id, other] = await createItems(ctx, [
        { type: 'story', state: { status, run: 'idle', next: start, counters: COMMITTED } },
        { type: 'story', state: { status: 'refined', run: 'idle' } },
      ]);
      const stage = (/** @type {any} */ step) => {
        for (const extra of staged) {
          step.stage((/** @type {any} */ w) => w.state(id, { status: 'draft', run: 'idle', ...extra }));
        }
        step.stage((/** @type {any} */ w) => w.state(other, OTHER));
        return 'success';
      };
      const { catalogue } = fakeSteps(plan(stage));
      await runFlow(ctx, { id, by: 'operator', resume: true, catalogue }).catch((e) => e);
      assert.deepEqual(stateOf(ctx, id), { ...state, counters }, `${path}: ${what}`);
      assert.deepEqual(stateOf(ctx, other), OTHER, `${path}: ${what}: the other item`);
    }
  }
});

test('runFlow_commits_staged_counter_with_box', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  const { catalogue } = fakeSteps({ prepare: stageState });
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
  const path = itemDir(ctx, id).path;
  const prepare = commitsSince(ctx, base).find(({ subject }) => subject === `${id}: prepare success`);
  assert.deepEqual(JSON.parse(git(ctx.backlogDir, 'show', `${prepare.sha}:${path}/state.json`)), {
    status: 'in_progress',
    run: 'active: implement',
    host: hostname(),
    counters: ATTEMPTS,
  });
  // The counter stays in each later commit.
  assert.deepEqual(stateOf(ctx, id), { status: 'implemented', run: 'idle', counters: ATTEMPTS });
});

test('a failing status gate keeps the status and ends at gated: <to> with held; the failing entries are only in the note', async () => {
  const ctx = backlog();
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'implemented', run: 'idle', next: 'close' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: id } });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();

  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
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
    [`${id}: resumed at close`, `${id}: close success`],
  );
});

test('a failing step gate ends at gated before: <box> without running the step; the failing entries are only in the note', async () => {
  const ctx = backlog({ 'gates.yaml': 'step_gates:\n  close: [\'status == "merged"\']\n' });
  const id = await story(ctx, { status: 'implemented', run: 'idle', next: 'close' });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();

  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
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
      [`${id}: resumed at close`, 'Bl-Step: close'],
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

test("a subflow's gate is checked when a resume starts at the subflow's first node (Decision A4)", async () => {
  const ctx = backlog(SELF_CHECK_GATE);
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'in_review', run: 'gated before: deliver/self_check/test_unit' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: id } });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
  const gate = 'children("task").size() == 0';
  assert.deepEqual(result, { held: [{ entry: gate, text: gate }] });
  assert.deepEqual(ran, []);
  assert.equal(head(ctx), base, 'no commit');
});

test("a subflow's gate is checked when deliver's fix arrow enters self_check from outside (Decision A4)", async () => {
  const ctx = backlog(SELF_CHECK_GATE);
  const id = await story(ctx, { status: 'in_progress', run: 'idle' });
  const { catalogue, ran } = fakeSteps({
    in_unit: 'failure', // a loose story: deliver
    'deliver/peer_review/findings_closed': 'failure',
    'deliver/fix': addTask,
  });
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'deliver', catalogue });
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
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'deliver', catalogue });
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
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'in_progress', outcome: 'failure' });
  assert.deepEqual(ran, ['prepare', 'implement', 'notify_implement', 'wait_implement']);
  const implement = commitsSince(ctx, base)[2];
  assert.equal(implement.subject, `${id}: implement failure`);
  assert.match(implement.message, /the post-conditions of implement failed: status == "implemented"\n/);
});

// ---- repo contexts and the worktree snapshot (F-141 D6) ----

/** Two repo contexts of fresh repos, and a `repoContexts` that gives them. */
function twoRepos() {
  const repos = [tempRepo('a'), tempRepo('b')];
  return { repos, repoContexts: () => repos };
}

/** A backlog whose implement box has the post-conditions `after`. */
const withAfter = (/** @type {string[]} */ after) =>
  engineBacklog({
    'defined-steps.yaml': definedSteps((steps) => {
      steps.implement.after = after;
    }),
  });

/** The outcome of the implement box of a run from prepare, from its commit's subject. */
const implementOutcome = (ctx, base) => commitsSince(ctx, base)[2].subject.split(' ').at(-1);

/** Write the file `new` in `dir`. */
const addFile = (/** @type {string} */ dir) => writeFileSync(join(dir, 'new'), '');

/** Write the file `new` in `dir` and commit it. */
function commitFile(/** @type {string} */ dir) {
  addFile(dir);
  git(dir, 'add', 'new');
  git(dir, 'commit', '-q', '-m', 'new');
}

/**
 * Run a story from prepare to wait_implement, with `implement` as the implement step and the repo
 * contexts of `twoRepos`, and give the implement box's outcome.
 * @param {string[]} after  the post-conditions of implement
 * @param {(dir: string) => void} implement  changes the worktree of the second repo
 */
async function implementWith(after, implement) {
  const ctx = withAfter(after);
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  const { repos, repoContexts } = twoRepos();
  const { catalogue } = fakeSteps({
    implement: () => {
      implement(repos[1].worktree_path);
      return 'success';
    },
    wait_implement: 'failure',
  });
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue, repoContexts });
  return implementOutcome(ctx, base);
}

test("each step gets the repo contexts as ctx.repos, and each repo's HEAD and status before the step as ctx.snapshot", async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const { repos, repoContexts } = twoRepos();
  /** @type {unknown[]} */
  const seen = [];
  // The content hash is tested in steps/worktrees.test.js.
  const record = (/** @type {any} */ step) =>
    seen.push({ repos: step.repos, snapshot: step.snapshot.map(({ content, ...rest }) => rest) });
  const { catalogue } = fakeSteps({
    prepare: (/** @type {any} */ step) => {
      record(step);
      addFile(repos[1].worktree_path);
      return 'success';
    },
    implement: (/** @type {any} */ step) => {
      record(step);
      return 'success';
    },
    wait_implement: 'failure',
  });
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue, repoContexts });
  const [a, b] = repos.map((repo) => git(repo.worktree_path, 'rev-parse', 'HEAD'));
  assert.deepEqual(seen.slice(0, 2), [
    {
      repos,
      snapshot: [
        { repo: 'a', head: a, status: '' },
        { repo: 'b', head: b, status: '' },
      ],
    },
    {
      repos,
      snapshot: [
        { repo: 'a', head: a, status: '' },
        { repo: 'b', head: b, status: '?? new' },
      ],
    },
  ]);
});

test('worktree_unchanged() as a post-condition is false after a step commits in one repo or leaves an uncommitted file, and true after a step that changes nothing', async () => {
  assert.equal(await implementWith(['worktree_unchanged()'], commitFile), 'failure', 'a commit');
  assert.equal(await implementWith(['worktree_unchanged()'], addFile), 'failure', 'an uncommitted file');
  assert.equal(await implementWith(['worktree_unchanged()'], () => {}), 'success', 'no change');
});

test('worktree_clean() as a post-condition is false while one repo has an uncommitted change, and true after the change is committed', async () => {
  assert.equal(await implementWith(['worktree_clean()'], addFile), 'failure', 'an uncommitted change');
  assert.equal(await implementWith(['worktree_clean()'], commitFile), 'success', 'the change committed');
});

test('worktree_unchanged() in a step gate is a FlowCrash: it is a post-condition', async () => {
  const ctx = backlog({ 'gates.yaml': "step_gates:\n  close: ['worktree_unchanged()']\n" });
  const id = await story(ctx, { status: 'implemented', run: 'idle', next: 'close' });
  const { catalogue, ran } = fakeSteps();
  const crash = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue }).catch((e) => e);
  assert.ok(crash instanceof FlowCrash);
  assert.equal(crash.message, 'close: worktree_unchanged(): worktree_unchanged() is a post-condition');
  assert.deepEqual(ran, []);
});

test("each step gets the op context's {{#bl}} runner as ctx.bl", async () => {
  const lines = [];
  const ctx = { ...backlog(), bl: async (/** @type {string} */ line) => (lines.push(line), `ran ${line}`) };
  const id = await story(ctx, { status: 'implemented', run: 'idle' });
  /** @type {string[]} */
  const texts = [];
  const { catalogue } = fakeSteps({
    close: async (/** @type {any} */ step) => (texts.push(await step.bl(`show ${step.id}`)), 'success'),
  });
  await runFlow(ctx, { id, by: 'operator', entry: 'close', catalogue });
  assert.deepEqual(lines, [`show ${id}`]);
  assert.deepEqual(texts, [`ran show ${id}`]);
});

test('with the default repoContexts, ctx.repos is empty, and worktree_clean() and worktree_unchanged() are true', async () => {
  const ctx = withAfter(['worktree_clean()', 'worktree_unchanged()']);
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  /** @type {unknown[]} */
  const seen = [];
  const { catalogue } = fakeSteps({
    implement: (/** @type {any} */ step) => {
      seen.push(step.repos, step.snapshot);
      return 'success';
    },
    wait_implement: 'failure',
  });
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(seen, [[], []]);
  assert.equal(implementOutcome(ctx, base), 'success');
});

test("runFlow_prints_and_logs_step_note: a step's note is printed with its box path, and is the flow_end note when its arrow is stop", async (t) => {
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'idle', next: 'wait_implement' });
  const { catalogue } = fakeSteps({ wait_implement: () => ({ outcome: 'failure', note: 'why' }) });
  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'stop', status: 'in_progress', outcome: 'failure' });
  assert.deepEqual(printed, ['wait_implement: why\n']);
  const { at, ...flowEnd } = logOf(ctx, id).at(-1);
  assert.deepEqual(flowEnd, {
    event: 'flow_end',
    ended: 'stop',
    outcome: 'failure',
    status: 'in_progress',
    commits: [],
    note: 'why',
  });
});

test('runFlow_step_note_comes_before_post_condition_notes, and a note of a box the flow goes on from is printed only', async (t) => {
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  const ctx = engineBacklog({
    'defined-steps.yaml': definedSteps((steps) => {
      steps.implement.after = ['status == "implemented"'];
    }),
  });
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const { catalogue } = fakeSteps({
    prepare: () => ({ outcome: 'success', note: 'prepared' }),
    implement: () => ({ outcome: 'success', note: 'one' }),
    wait_implement: () => ({ outcome: 'failure', note: 'gave up' }),
  });
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
  t.mock.restoreAll();
  assert.deepEqual(printed, ['prepare: prepared\n', 'implement: one\n', 'wait_implement: gave up\n']);
  // implement's note is in its own commit message, beside its post-condition note.
  const implement = git(ctx.backlogDir, 'log', '--format=%B', '--grep', `${id}: implement failure`);
  assert.match(implement, /one; the post-conditions of implement failed: status == "implemented"/);
  assert.equal(logOf(ctx, id).at(-1).note, 'gave up');
});

test("runFlow_gives_step_evaluate: ctx.evaluate evaluates over the box's record as the gates do, and names the expression when it throws", async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle', counters: { r: { value: 2, threshold: 3 } } });
  /** @type {unknown[]} */
  const seen = [];
  const { catalogue } = fakeSteps({
    prepare: async (/** @type {any} */ step) => {
      seen.push(await step.evaluate('status == "refined" && counters.r.value < counters.r.threshold'));
      seen.push(await step.evaluate(`item("${id}").status`));
      return 'success';
    },
    implement: (/** @type {any} */ step) => step.evaluate('conflict_free()'),
  });
  const crash = await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue }).catch((e) => e);
  // item() of the running item reads the status the invocation reached, as a gate's does.
  assert.deepEqual(seen, [true, 'refined']);
  assert.ok(crash instanceof FlowCrash);
  assert.equal(crash.message, 'implement: conflict_free(): not bound: conflict_free');
});

test('a shop predicate in a status gate passes or fails the gate by its exit status, and exit 127 is a FlowCrash that names the expression', async () => {
  const shop = [
    'repos: {}',
    'plugin_registry:',
    '  predicates:',
    `    readme_mentions: 'grep -q {{args.0}} README.md'`,
    `    missing: 'exit 127'`,
    '',
  ].join('\n');
  /** The result of closing an implemented story whose gate of done is `gate`. */
  const close = async (gate) => {
    const flows = { 'story.yaml': storyFlow((flow) => (flow.statuses.done = { gate: [gate] })) };
    const ctx = engineBacklog({ 'defined-steps.yaml': definedSteps(), ...flows }, shop);
    writeFileSync(join(ctx.backlogDir, 'README.md'), 'a widget\n');
    const id = await story(ctx, { status: 'implemented', run: 'idle', next: 'close' });
    const { catalogue } = fakeSteps();
    return runFlow(ctx, { id, by: 'operator', resume: true, catalogue }).catch((e) => e);
  };
  assert.deepEqual(await close('predicates.readme_mentions("widget")'), {
    ended: 'stop',
    status: 'done',
    outcome: 'success',
  });
  assert.deepEqual(await close('predicates.readme_mentions("gadget")'), {
    ended: 'gated: done',
    status: 'implemented',
    outcome: 'success',
  });
  const crash = await close('predicates.missing()');
  assert.ok(crash instanceof FlowCrash);
  assert.match(crash.message, /predicates\.missing\(\): plugin `exit 127` exited 127 \(exit 127\)/);
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
  await assert.rejects(runFlow(ctx, { id, by: 'operator', entry: 'close', catalogue }), {
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
  const crash = await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue }).catch((e) => e);
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
  const id = await story(ctx, { status: 'in_progress', run: 'idle', next: 'self_check/test_unit' });
  const { catalogue, ran } = fakeSteps({ 'self_check/test_unit': () => 'failure' });
  await assert.rejects(
    runFlow(ctx, { id, by: 'operator', resume: true, catalogue }),
    (error) => error instanceof FlowCrash && error.message === 'self_check/test_unit started 3 times (max_box_visits)',
  );
  assert.equal(ran.filter((box) => box === 'self_check/test_unit').length, 2);
  assert.equal(logOf(ctx, id).at(-1).event, 'flow_start');
  assert.equal(readRunState(ctx, id, stateOf(ctx, id)), 'interrupted: self_check/test_unit');
});

// ---- alerts (F-140 D10, Decision A3) ----

/** Routes where a class has a channel of its own, and the ended alerts reach `terminal`. */
const ROUTES = 'gated: [terminal]\ngated.needs_operator_action: [bell]\nended: [terminal]\nnotify: []\n';

/**
 * A backlog as `backlog(flows)` gives it, with the channels `terminal` and
 * `bell` (exit `codes`), `alerts` as config/alerts.yaml (by default uTop's)
 * and the uTop English texts.
 * @param {Record<string, string>} [flows]
 * @param {string} [alerts]
 * @param {Record<string, number>} [codes]
 */
function alerting(flows = {}, alerts = undefined, codes = { terminal: 0, bell: 0 }) {
  const channels = Object.fromEntries(Object.entries(codes).map(([name, code]) => [name, channel(name, code)]));
  return notifyBacklog({ flows: { 'defined-steps.yaml': definedSteps(), ...flows }, channels, alerts });
}

test('a failing step gate sends one gated alert to the channels of its classes and of gated, joined, and no ended alert', async () => {
  const gate = `step_gates:\n  close: [{ condition: 'false', class: needs_operator_action }, 'status == "merged"']\n`;
  const ctx = alerting({ 'gates.yaml': gate }, ROUTES);
  const id = await story(ctx, { status: 'implemented', run: 'idle', next: 'close' });
  const { catalogue } = fakeSteps();
  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
  assert.deepEqual(result, { ended: 'gated before: close', status: 'implemented' });
  const text = `${id} is held before close: false [needs_operator_action]\n`;
  assert.equal(delivered(ctx, 'bell'), text);
  assert.equal(delivered(ctx, 'terminal'), text, 'one alert, and no ended alert after it');
});

test('a failing status gate sends one gated alert with no box, and a dependency entry routes by gated with its item first', async () => {
  const ctx = alerting({}, ROUTES);
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'implemented', run: 'idle', next: 'close' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: id } });
  const { catalogue } = fakeSteps();
  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
  assert.deepEqual(result, { ended: 'gated: done', status: 'implemented', outcome: 'success' });
  // uTop's gate of done gives this entry the class expected, which ROUTES sends by gated.
  assert.equal(delivered(ctx, 'terminal'), `${id} is held: children("task").all(c, c.closed) [expected]\n`);
  assert.equal(delivered(ctx, 'bell'), null);

  const other = alerting({}, ROUTES);
  const [s1, s2] = await createItems(other, [
    { type: 'story', state: { status: 'implemented', run: 'idle', next: 'close' } },
    { type: 'story', state: { status: 'refined', run: 'idle' } },
  ]);
  await setGraph(other, 'dependency', { [s1]: { done: [{ [s2]: 'status == "done"' }] } });
  await runFlow(other, { id: s1, by: 'operator', resume: true, catalogue });
  assert.equal(delivered(other, 'terminal'), `${s1} is held: ${s2}: status == "done"\n`);
  assert.equal(delivered(other, 'bell'), null);
});

test("a gated alert's condition longer than 120 characters is cut at 120 with …", async () => {
  const condition = `status == "${'x'.repeat(130)}"`;
  const ctx = alerting({ 'gates.yaml': `step_gates:\n  close: ['${condition}']\n` }, ROUTES);
  const id = await story(ctx, { status: 'implemented', run: 'idle', next: 'close' });
  const { catalogue } = fakeSteps();
  await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
  assert.equal(delivered(ctx, 'terminal'), `${id} is held before close: ${condition.slice(0, 120)}…\n`);
});

test('a flow_end at stop sends one ended.normal alert, which uTop routes to [], so no channel runs', async () => {
  const utop = alerting();
  const id = await story(utop, { status: 'implemented', run: 'idle' });
  const { catalogue } = fakeSteps();
  const result = await runFlow(utop, { id, by: 'operator', entry: 'close', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.equal(delivered(utop, 'terminal'), null);
  assert.equal(delivered(utop, 'bell'), null);

  const routed = alerting({}, ROUTES);
  const other = await story(routed, { status: 'implemented', run: 'idle' });
  await runFlow(routed, { id: other, by: 'operator', entry: 'close', catalogue });
  assert.equal(delivered(routed, 'terminal'), `${other}: bl ended (normal)\n`);
});

test("a step that throws sends one ended.crash alert with the box's path and the error, and runFlow still throws FlowCrash", async () => {
  const ctx = alerting();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const { catalogue } = fakeSteps({
    implement: () => {
      throw new Error('the agent crashed');
    },
  });
  const crash = await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue }).catch((e) => e);
  assert.ok(crash instanceof FlowCrash);
  assert.equal(crash.message, 'implement: the agent crashed');
  const text = `${id} crashed at implement: implement: the agent crashed\n`;
  assert.equal(delivered(ctx, 'terminal'), text);
  assert.equal(delivered(ctx, 'bell'), text);
});

test('an ended.crash alert that throws prints one line, and runFlow throws the FlowCrash it is about', async (t) => {
  // With no language file, the alert's text read throws.
  const flows = { 'defined-steps.yaml': definedSteps() };
  const ctx = notifyBacklog({ flows, channels: { terminal: channel('terminal'), bell: channel('bell') }, texts: null });
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const { catalogue } = fakeSteps({
    implement: () => {
      throw new Error('the agent crashed');
    },
  });
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  const crash = await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue }).catch((e) => e);
  t.mock.restoreAll();
  assert.ok(crash instanceof FlowCrash);
  assert.equal(crash.message, 'implement: the agent crashed');
  assert.deepEqual(printed, [
    `${id}: the ended.crash alert failed: the language 'en' has no template file templates/en.yaml\n`,
  ]);
});

test('runFlow_alert_failure_keeps_committed_result', async (t) => {
  // Each end commits first; then its alert's text is missing, and the result stands with no ended.crash alert.
  const texts = 'ended.crash: "{{item_id}} crash: {{error}}"\n';
  const alerts = 'gated: [terminal]\nended: [terminal]\nended.crash: [bell]\nnotify: []\n';
  const cases = [
    // [what, gates.yaml, the result, the alert, the missing names, the run state]
    [
      'step gate',
      "step_gates:\n  close: ['false']\n",
      { ended: 'gated before: close', status: 'implemented' },
      'gated',
      "'gated'",
      'gated before: close',
    ],
    [
      'status gate',
      undefined,
      { ended: 'gated: done', status: 'implemented', outcome: 'success' },
      'gated',
      "'gated.expected' or 'gated'",
      'gated: done',
    ],
    [
      'normal end',
      undefined,
      { ended: 'stop', status: 'done', outcome: 'success' },
      'ended.normal',
      "'ended.normal' or 'ended'",
      'idle',
    ],
  ];
  for (const [what, gates, want, alert, names, run] of cases) {
    const flows = { 'defined-steps.yaml': definedSteps(), ...(gates === undefined ? {} : { 'gates.yaml': gates }) };
    const ctx = notifyBacklog({
      flows,
      channels: { terminal: channel('terminal'), bell: channel('bell') },
      alerts,
      texts,
    });
    const state = { status: 'implemented', run: 'idle', next: 'close' };
    const [id] = await createItems(ctx, [{ type: 'story', state }]);
    // The status gate of done needs the story's task closed.
    if (what === 'status gate') {
      await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle' } }]);
      await setGraph(ctx, 'containment', { 'T-1': { parent: id } });
    }
    const { catalogue } = fakeSteps();
    const printed = [];
    t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
    const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue }).catch((e) => e);
    t.mock.restoreAll();
    assert.deepEqual(result, want, what);
    assert.equal(stateOf(ctx, id).run, run, what);
    assert.equal(logOf(ctx, id).filter(({ event }) => event === 'flow_end').length, 1, what);
    assert.equal(delivered(ctx, 'bell'), null, `${what}: no ended.crash alert`);
    assert.deepEqual(
      printed.filter((line) => line.includes('alert failed')),
      [`${id}: the ${alert} alert failed: templates/en.yaml has no template named ${names}\n`],
      what,
    );
  }
});

test("the visit limit's ended.crash text holds started 21 times (max_box_visits) when the limit is 20", async () => {
  const ctx = alerting({ 'flow-set.yaml': 'max_box_visits: 20\ngate_recheck_minutes: 15\n' });
  const start = 'self_check/test_unit';
  const id = await story(ctx, { status: 'in_progress', run: 'idle', next: start });
  const { catalogue } = fakeSteps({ 'self_check/test_unit': () => 'failure' });
  const crash = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue }).catch((e) => e);
  assert.ok(crash instanceof FlowCrash);
  assert.equal(delivered(ctx, 'terminal'), `${id} crashed at ${start}: ${start} started 21 times (max_box_visits)\n`);
});

test('an alert whose channels all fail prints one line that names it, after the lines of send, and the invocation ends as it would', async (t) => {
  const gate = `step_gates:\n  close: [{ condition: 'false', class: needs_operator_action }]\n`;
  // bell exits 127, a crash code of a plugin, which send prints as a line of its own (D-101).
  const ctx = alerting({ 'gates.yaml': gate }, undefined, { terminal: 1, bell: 127 });
  const id = await story(ctx, { status: 'implemented', run: 'idle', next: 'close' });
  const { catalogue } = fakeSteps();
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'gated before: close', status: 'implemented' });
  assert.deepEqual(stateOf(ctx, id), { status: 'implemented', run: 'gated before: close' });
  const lines = printed.join('').split('\n').filter(Boolean);
  assert.match(lines[0], /^bl\.notify bell: .*exited 127/);
  assert.deepEqual(lines.slice(1), [`${id}: the gated.needs_operator_action alert reached no channel`]);
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
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'deliver', catalogue });
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
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'deliver', catalogue });
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
    const result = await runFlow(ctx, { id, by: 'operator', entry: 'deliver', catalogue });
    assert.deepEqual(result, expected, JSON.stringify(gates));
  }
});

test('runFlow_second_return_transition_gate_sees_self_item_status', async () => {
  // As above, but each condition looks the item up by its id: the gate of merged must read
  // ready_for_merge, the status the arrow into deliver/_return_success reached, not in_progress.
  const REACHED = (/** @type {string} */ id) => `item("${id}").status == "ready_for_merge" && !item("${id}").closed`;
  const cases = [
    // [what, the merged gate, the dependency entries under merged (keys: self, other)]
    ['the flow gate', REACHED, null],
    ['a dependency entry that names the item itself', null, (id) => ({ self: REACHED(id) })],
    ['a dependency entry of another item that looks the item up', null, (id) => ({ other: REACHED(id) })],
  ];
  for (const [what, gate, dependency] of cases) {
    const ctx = backlog({
      'story.yaml': storyFlow((flow) => {
        flow.steps.deliver.success = { status: 'merged', next: 'stop' };
        if (gate !== null) flow.statuses.merged = { gate: [gate('S-1')] };
      }),
    });
    const [id, other] = await createItems(ctx, [
      { type: 'story', state: { status: 'in_progress', run: 'idle' } },
      { type: 'story', state: { status: 'draft', run: 'idle' } },
    ]);
    assert.equal(id, 'S-1');
    if (dependency !== null) {
      const named = { self: id, other };
      const entries = Object.entries(dependency(id)).map(([key, expr]) => ({ [named[key]]: expr }));
      await setGraph(ctx, 'dependency', { [id]: { merged: entries } });
    }
    const { catalogue } = fakeSteps({ in_unit: 'failure' });
    const result = await runFlow(ctx, { id, by: 'operator', entry: 'deliver', catalogue });
    assert.deepEqual(result, { ended: 'stop', status: 'merged', outcome: 'success' }, what);
  }
});

test('an arrow whose derived from does not hold the status stops the invocation with a note, and keeps the status', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'draft', run: 'idle', next: 'close' });
  const { catalogue } = fakeSteps();
  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
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
    await assert.rejects(runFlow(ctx, { id, by: 'operator', entry: 'close', catalogue }), {
      message: new RegExp(`^${id}: another process \\(pid ${child.pid}\\) runs its flow`),
    });
    assert.deepEqual(ran, []);
    assert.equal(head(ctx), base);
  } finally {
    await child.kill();
  }
});

// ---- the agent session in state.json (F-141 D8) ----

const SESSION = { box: 'implement', profile: 'replay', id: 's-1' };

test("ctx.session commits state.json with the box's session at once, and the box's commit drops it", async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  /** @type {unknown} */
  let seen;
  const { catalogue } = fakeSteps({
    implement: async (/** @type {any} */ step) => {
      await step.session({ profile: 'replay', id: 's-1' });
      seen = stateOf(ctx, id);
      return 'success';
    },
  });
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(seen, { status: 'in_progress', run: 'active: implement', host: hostname(), session: SESSION });
  const commits = commitsSince(ctx, base);
  const at = commits.findIndex(({ subject }) => subject === `${id}: implement session s-1`);
  assert.deepEqual(commits[at].trailers, ['Bl-Flow: story', 'Bl-Step: implement', `Bl-Item: ${id}`]);
  assert.equal(commits[at + 1].subject, `${id}: implement success`);
  const path = itemDir(ctx, id).path;
  assert.equal(JSON.parse(git(ctx.backlogDir, 'show', `${commits[at + 1].sha}:${path}/state.json`)).session, undefined);
});

test('a resumed invocation keeps the session in its flow_start commit, and an entry at the box does not', async () => {
  // A stored session names the active box (checkState), and a resume of it starts there.
  const cases = [
    // [what, start, resume, the session the step sees]
    ['resumed at the box', 'implement', true, SESSION],
    ['started by an entry at the box', 'implement', false, undefined],
  ];
  for (const [what, start, resume, want] of cases) {
    // An entry `again` that starts at the box on an interrupted item.
    const again = { from: ['in_progress'], run_states: ['interrupted'], start };
    const ctx = backlog({ 'story.yaml': storyFlow((flow) => (flow.entries.again = again)) });
    const state = { status: 'in_progress', run: 'active: implement', host: hostname(), session: SESSION };
    const id = await story(ctx, state);
    /** @type {unknown[]} */
    const seen = [];
    const look = (/** @type {any} */ step) => {
      seen.push(stateOf(ctx, step.id).session);
      return 'success';
    };
    const { catalogue } = fakeSteps({ [start]: look });
    const how = resume ? { resume: true } : { entry: 'again' };
    await runFlow(ctx, { id, by: 'operator', ...how, catalogue });
    // The first run of the box; a later one comes after a box's commit, which holds no session.
    assert.deepEqual(seen[0], want, what);
  }
});

// ---- an interactive step with no terminal (F-141 D9, D-29) ----

test('an interactive step with no terminal does not start: the invocation ends idle with that box next', async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const { catalogue, ran } = fakeSteps();
  const interactive = { ...catalogue, agent: { ...catalogue.agent, interactive: () => true } };
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  const result = await runFlow(ctx, {
    id,
    by: 'operator',
    entry: 'run',
    catalogue: interactive,
    tty: '/nonexistent/tty',
  });
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'stop', status: 'in_progress', outcome: 'success' });
  assert.deepEqual(ran, ['prepare']);
  assert.deepEqual(stateOf(ctx, id), { status: 'in_progress', run: 'idle', next: 'implement' });
  const { at, ...end } = logOf(ctx, id).at(-1);
  assert.deepEqual(end, {
    event: 'flow_end',
    ended: 'stop',
    outcome: 'success',
    status: 'in_progress',
    commits: [],
    note: 'no terminal for the interactive step implement',
  });
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s'), `${id}: implement no terminal`);
  assert.deepEqual(printed, [
    'implement: no terminal for the interactive step implement\n',
    `run \`bl resume ${id}\` to continue\n`,
  ]);

  // With a terminal it opens, the step runs.
  const other = await story(ctx, { status: 'refined', run: 'idle' });
  const { catalogue: steps, ran: runs } = fakeSteps();
  const withTerminal = { ...steps, agent: { ...steps.agent, interactive: () => true } };
  await runFlow(ctx, {
    id: other,
    by: 'operator',
    entry: 'run',
    catalogue: withTerminal,
    tty: '/dev/null',
  });
  assert.ok(runs.includes('implement'));
});

test('a stored state that the flow no longer has is reset first, in its own commit with a reset entry', async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'waiting: gone', counters: { rounds: { value: 2 } } });
  const base = head(ctx);
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
  const { catalogue } = fakeSteps();
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'close', catalogue });
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

// ---- resume from the stored run state (F-152 D2) ----

const AT = '2026-11-28T10:00:00Z';

/** Append `entries` to the item's log in one store write. */
const appendLog = (ctx, id, ...entries) =>
  storeWrite(ctx, { message: 'chore: log' }, (w) => entries.forEach((entry) => w.log(id, { at: AT, ...entry })));

/** An `outcome` entry for `box`, as `bl outcome` writes it. */
const outcomeEntry = (box, outcome = 'success') => ({ event: 'outcome', box, outcome, by: 'operator' });

/** Resume the item `id` with the fake steps `catalogue`. */
const resume = (ctx, id, catalogue) => runFlow(ctx, { id, by: 'operator', resume: true, catalogue });

/** The log events after the `created` entry. */
const eventsOf = (ctx, id) =>
  logOf(ctx, id)
    .slice(1)
    .map(({ event }) => event);

test('resume on interrupted: <box> runs the box again', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'active: close', host: hostname() });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  assert.deepEqual(await resume(ctx, id, catalogue), { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(ran, ['close']);
  assert.deepEqual(
    commitsSince(ctx, base).map(({ subject }) => subject),
    [`${id}: resumed at close`, `${id}: close success`],
  );
  const { event, resume: resumed } = logOf(ctx, id).at(-2);
  assert.deepEqual({ event, resumed }, { event: 'flow_start', resumed: true });
});

test('resume on interrupted: <box> with a last outcome entry for the box follows its arrow, and runs no step (D-51)', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'active: close', host: hostname() });
  await appendLog(ctx, id, outcomeEntry('close'));
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  assert.deepEqual(await resume(ctx, id, catalogue), { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(ran, [], 'no step runs');
  // No step started, so the flow_start shares the commit of the outcome's arrow.
  const commits = commitsSince(ctx, base);
  assert.deepEqual(
    commits.map(({ subject, trailers }) => [subject, trailers]),
    [[`${id}: close success`, ['Bl-Flow: story', 'Bl-Step: close', `Bl-Item: ${id}`]]],
  );
  const path = itemDir(ctx, id).path;
  assert.deepEqual(git(ctx.backlogDir, 'show', '--name-only', '--format=', commits[0].sha).split('\n').sort(), [
    `${path}/log.jsonl`,
    `${path}/state.json`,
  ]);
  assert.deepEqual(eventsOf(ctx, id), ['outcome', 'flow_start', 'flow_end']);
  const { at, ...start } = logOf(ctx, id).at(-2);
  assert.deepEqual(start, { event: 'flow_start', resume: true, status: 'implemented', by: 'operator' });
  assert.deepEqual(stateOf(ctx, id), { status: 'done', run: 'idle' });
});

test('resume on gated: <to> whose gate now passes makes the held transition with no step, and goes on', async () => {
  const ctx = backlog();
  const id = await story(ctx, {
    status: 'refined',
    run: 'gated: in_progress',
    held: { box: 'prepare', outcome: 'success' },
  });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  assert.deepEqual(await resume(ctx, id, catalogue), { ended: 'stop', status: 'implemented', outcome: 'success' });
  assert.deepEqual(ran, RUN_BOXES.slice(1), 'prepare does not run again');
  const [first] = commitsSince(ctx, base);
  assert.equal(first.subject, `${id}: prepare success`);
  const path = itemDir(ctx, id).path;
  assert.deepEqual(JSON.parse(git(ctx.backlogDir, 'show', `${first.sha}:${path}/state.json`)), {
    status: 'in_progress',
    run: 'active: implement',
    host: hostname(),
  });
  assert.deepEqual(eventsOf(ctx, id), ['flow_start', 'flow_end']);
});

test('resume on gated: <to> held at a return node makes the held transition, and no return node is ever active', async () => {
  const ctx = backlog(BOTH_SIDES);
  const id = await story(ctx, {
    status: 'ready_for_merge',
    run: 'gated: merged',
    held: { box: 'deliver/_return_success', outcome: 'success' },
  });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  assert.deepEqual(await resume(ctx, id, catalogue), { ended: 'stop', status: 'merged', outcome: 'success' });
  assert.deepEqual(ran, []);
  assert.deepEqual(storedRuns(ctx, base, itemDir(ctx, id).path), ['idle']);
});

test('resume on gated: <to> whose status left the arrow from writes idle and a flow_end that says so (D-19)', async () => {
  const ctx = backlog();
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'draft', run: 'gated: done', held: { box: 'close', outcome: 'success' } } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: id } }); // the gate of done fails too
  const { catalogue, ran } = fakeSteps();
  assert.deepEqual(await resume(ctx, id, catalogue), { ended: 'stop', status: 'draft', outcome: 'success' });
  assert.deepEqual(ran, []);
  assert.deepEqual(stateOf(ctx, id), { status: 'draft', run: 'idle' });
  const { at, ...end } = logOf(ctx, id).at(-1);
  assert.deepEqual(end, {
    event: 'flow_end',
    ended: 'stop',
    outcome: 'success',
    status: 'draft',
    commits: [],
    note: 'the success arrow of close sets done only from implemented',
  });
});

test('resume on gated before: <box> whose step gate now passes starts the step, and on idle with next starts at next', async () => {
  const ctx = backlog({ 'gates.yaml': 'step_gates:\n  close: [\'status == "implemented"\']\n' });
  const gated = await story(ctx, { status: 'implemented', run: 'gated before: close' });
  const { catalogue, ran } = fakeSteps();
  assert.deepEqual(await resume(ctx, gated, catalogue), { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(ran, ['close']);

  const next = await story(ctx, { status: 'in_progress', run: 'idle', next: 'wait_implement' });
  const { catalogue: steps, ran: runs } = fakeSteps({ wait_implement: 'failure' });
  assert.deepEqual(await resume(ctx, next, steps), { ended: 'stop', status: 'in_progress', outcome: 'failure' });
  assert.deepEqual(runs, ['wait_implement']);
  assert.equal(git(ctx.backlogDir, 'log', '-2', '--format=%s').split('\n')[1], `${next}: resumed at wait_implement`);
});

test('resume commits nothing while a gate still fails, at waiting: <box> with no outcome, and on idle with no next', async () => {
  const ctx = backlog({ 'gates.yaml': 'step_gates:\n  close: [\'status == "merged"\']\n' });
  const [gated, before, waiting, idle] = await createItems(ctx, [
    { type: 'story', state: { status: 'implemented', run: 'gated: done', held: { box: 'close', outcome: 'success' } } },
    { type: 'story', state: { status: 'implemented', run: 'gated before: close' } },
    { type: 'story', state: { status: 'in_progress', run: 'waiting: wait_implement' } },
    { type: 'story', state: { status: 'refined', run: 'idle' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { 'T-1': { parent: gated } });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  const done = 'children("task").all(c, c.closed)';
  assert.deepEqual(await resume(ctx, gated, catalogue), {
    held: [{ entry: { condition: done, class: 'expected' }, text: done }],
  });
  const merged = 'status == "merged"';
  assert.deepEqual(await resume(ctx, before, catalogue), { held: [{ entry: merged, text: merged }] });
  assert.deepEqual(await resume(ctx, waiting, catalogue), { held: [] });
  assert.deepEqual(await resume(ctx, idle, catalogue), { entries: ['refine', 'run', 'implement', 'supersede'] });
  assert.deepEqual(ran, []);
  assert.equal(head(ctx), base, 'no commit');
});

test('resume on active of another host is refused with no commit, and names that host (D-4)', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'active: close', host: 'elsewhere' });
  const base = head(ctx);
  const { catalogue, ran } = fakeSteps();
  await assert.rejects(resume(ctx, id, catalogue), {
    message: new RegExp(`^${id}: active at close on the host elsewhere;`),
  });
  assert.deepEqual(ran, []);
  assert.equal(head(ctx), base);
});

test('a force entry after an outcome entry makes the outcome unused: resume runs the box again (D-613)', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'active: close', host: hostname() });
  const force = { event: 'force', path: '/status', from: 'implemented', to: 'implemented', status: 'implemented' };
  await appendLog(ctx, id, outcomeEntry('close', 'failure'), { ...force, by: 'operator', note: 'retry' });
  const { catalogue, ran } = fakeSteps();
  assert.deepEqual(await resume(ctx, id, catalogue), { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(ran, ['close']);
});

// ---- suspend and wake (F-152 D3, Decision A1) ----

/** Wait until `check` is true. */
const until = (/** @type {string} */ what, /** @type {() => boolean} */ check) =>
  waitUntil(() => (check() ? true : undefined), what);

/** Close the task `task` in a commit, as its own flow would. */
const closeTask = (/** @type {any} */ ctx, /** @type {string} */ task) =>
  storeWrite(ctx, { message: `chore: close ${task}` }, (w) => w.state(task, { status: 'done', run: 'idle' }));

/** Close the task `task` in the working tree, with no commit, so only a signal or the timer sees it. */
const closeTaskUncommitted = (/** @type {any} */ ctx, /** @type {string} */ task) =>
  writeFileSync(join(itemPath(ctx, task), 'state.json'), `${JSON.stringify({ status: 'done', run: 'idle' })}\n`);

/**
 * A story at implemented with close next and one draft task child, so the status gate of done
 * fails: a resume runs close, where an entry is refused (D-48).
 */
async function storyWithTask(/** @type {any} */ ctx) {
  const [id, task] = await createItems(ctx, [
    { type: 'story', state: { status: 'implemented', run: 'idle', next: 'close' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  await setGraph(ctx, 'containment', { [task]: { parent: id } });
  return { id, task };
}

const DONE_GATE = 'children("task").all(c, c.closed)';

test('with waitForWake, a failing status gate commits gated: <to> and a flow_end and keeps the item lock; a commit that opens the gate wakes it within 2 seconds, and the same process resumes with the first by and goes on to stop', async (t) => {
  const ctx = backlog();
  const { id, task } = await storyWithTask(ctx);
  const { catalogue, ran } = fakeSteps();
  const run = suspending(t, ctx, { id, resume: true, by: 'F-1', catalogue });
  await until('the suspend', () => run.lines().includes(`${id}: suspended at gated: done: ${DONE_GATE}`));
  assert.deepEqual(stateOf(ctx, id), {
    status: 'implemented',
    run: 'gated: done',
    held: { box: 'close', outcome: 'success' },
  });
  assert.deepEqual(eventsOf(ctx, id), ['flow_start', 'flow_end'], 'the flow_end is written at the suspend');
  await assert.rejects(resume(ctx, id, catalogue), {
    message: new RegExp(`^${id}: another process \\(pid ${process.pid}\\)`),
  });

  await closeTask(ctx, task);
  const at = Date.now();
  const result = await run.pending;
  const ms = Date.now() - at;
  t.mock.restoreAll();
  assert.ok(ms < 2000, `woke after ${ms} ms`);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(ran, ['close'], 'close does not run again');
  assert.deepEqual(eventsOf(ctx, id), ['flow_start', 'flow_end', 'flow_start', 'flow_end']);
  const { at: _, ...resumed } = logOf(ctx, id).at(-2);
  assert.deepEqual(resumed, { event: 'flow_start', resume: true, status: 'implemented', by: 'F-1' });
  assert.deepEqual(stateOf(ctx, id), { status: 'done', run: 'idle' });
  assert.equal(holderOf(itemLockPath(ctx.backlogDir, id)), null, 'the lock is released');
});

test('a failing step gate suspends at gated before: <box>; a burst of commits gives one gate check, and a wake that still fails prints the failing entries again only when they changed', async (t) => {
  const ctx = backlog({ 'gates.yaml': 'step_gates:\n  close: [\'item("T-1").closed\', \'item("T-2").closed\']\n' });
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'implemented', run: 'idle', next: 'close' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  const { catalogue, ran } = fakeSteps();
  /** @type {string[][]} the failing entries of each wait */
  const waits = [];
  const wake = async (/** @type {any} */ c, /** @type {any} */ suspend) => {
    waits.push(suspend.failing.map((/** @type {any} */ { text }) => text));
    return waitForWake(c, suspend);
  };
  const run = suspending(t, ctx, { id, resume: true, catalogue, wake });
  await until('the first wait', () => waits.length === 1);
  assert.deepEqual(stateOf(ctx, id), { status: 'implemented', run: 'gated before: close' });

  await closeTask(ctx, 'T-1');
  await until('the second wait', () => waits.length === 2);
  for (let i = 0; i < 3; i++) git(ctx.backlogDir, 'commit', '-q', '--allow-empty', '-m', `burst ${i}`);
  await until('the third wait', () => waits.length === 3);
  await new Promise((done) => setTimeout(done, BURST_MS * 2));
  assert.equal(waits.length, 3, 'the burst gave one gate check');

  await closeTask(ctx, 'T-2');
  const result = await run.pending;
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(ran, ['close']);
  assert.deepEqual(waits, [
    ['item("T-1").closed', 'item("T-2").closed'],
    ['item("T-2").closed'],
    ['item("T-2").closed'],
  ]);
  assert.deepEqual(
    run.lines().filter((line) => line.includes('suspended')),
    [
      `${id}: suspended at gated before: close: item("T-1").closed, item("T-2").closed`,
      `${id}: suspended at gated before: close: item("T-2").closed`,
    ],
  );
  assert.equal(git(ctx.backlogDir, 'log', '-2', '--format=%s').split('\n')[1], `${id}: resumed at close`);
});

test('SIGUSR2 to a process whose step is running does not end it', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'implemented', run: 'idle' });
  const { catalogue } = fakeSteps({
    close: async () => {
      sendUsr2();
      await new Promise((done) => setTimeout(done, 100));
      return 'success';
    },
  });
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'close', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.equal(process.listenerCount('SIGUSR2'), 0, 'the listener goes with the lock');
});

test('SIGUSR2 wakes a suspended process, and so does gate_recheck_minutes, with no commit and no signal', async (t) => {
  for (const [how, minutes, poke] of [
    ['SIGUSR2', 15, sendUsr2],
    ['the timer', 0.005, () => {}],
  ]) {
    const base = backlog();
    const ctx = { ...base, flowSet: { ...base.flowSet, gateRecheckMinutes: minutes } };
    const { id, task } = await storyWithTask(ctx);
    const { catalogue } = fakeSteps();
    const run = suspending(t, ctx, { id, resume: true, catalogue });
    await until('the suspend', () => run.lines().some((line) => line.startsWith(`${id}: suspended`)));
    closeTaskUncommitted(ctx, task);
    const at = Date.now();
    /** @type {() => void} */ (poke)();
    const result = await run.pending;
    const ms = Date.now() - at;
    t.mock.restoreAll();
    assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' }, how);
    assert.ok(ms < BURST_MS, `${how}: woke after ${ms} ms`);
  }
});

test('a bl force of /run while suspended makes the process print that the run state changed, release the lock and return', async (t) => {
  const ctx = backlog();
  const { id } = await storyWithTask(ctx);
  const { catalogue } = fakeSteps();
  const run = suspending(t, ctx, { id, resume: true, catalogue });
  await until('the suspend', () => run.lines().some((line) => line.startsWith(`${id}: suspended`)));
  await storeWrite(ctx, { message: `${id}: force /run` }, (w) => {
    w.state(id, { status: 'implemented', run: 'idle', next: 'close' });
    const force = { event: 'force', path: '/run', from: 'gated: done', to: 'idle', status: 'implemented' };
    w.log(id, { at: AT, ...force, by: 'operator', note: 'by hand' });
  });
  const result = await run.pending;
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'gated: done', status: 'implemented', outcome: 'success' });
  assert.equal(run.lines().at(-1), `${id}: the run state changed to idle; this process ends`);
  assert.equal(holderOf(itemLockPath(ctx.backlogDir, id)), null);
  assert.deepEqual(eventsOf(ctx, id), ['flow_start', 'flow_end', 'force']);
});

test('runFlow_observes_change_before_watcher_start', async (t) => {
  /** Commit the working tree at once, before the wake's watchers start. */
  const commitNow = (/** @type {any} */ ctx) => {
    git(ctx.backlogDir, 'add', '-A');
    git(ctx.backlogDir, 'commit', '-q', '-m', 'a change before the watchers');
  };
  const gatedBefore = { 'gates.yaml': 'step_gates:\n  close: [\'item("T-1").closed\']\n' };
  const stop = { ended: 'stop', status: 'done', outcome: 'success' };
  for (const [name, flows, ended, change, expected] of /** @type {const} */ ([
    [
      'an outcome at waiting',
      {},
      'waiting: wait_implement',
      (/** @type {any} */ ctx, /** @type {string} */ id) => {
        const entry = { at: AT, ...outcomeEntry('wait_implement', 'failure') };
        writeFileSync(join(itemPath(ctx, id), 'log.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a' });
        commitNow(ctx);
      },
      { ended: 'stop', status: 'in_progress', outcome: 'failure' },
    ],
    [
      'a commit that opens gated',
      {},
      'gated: done',
      (/** @type {any} */ ctx, /** @type {string} */ _id, /** @type {string} */ task) => {
        closeTaskUncommitted(ctx, task);
        commitNow(ctx);
      },
      stop,
    ],
    [
      'a commit that opens gated before',
      gatedBefore,
      'gated before: close',
      (/** @type {any} */ ctx, /** @type {string} */ _id, /** @type {string} */ task) => {
        closeTaskUncommitted(ctx, task);
        commitNow(ctx);
      },
      stop,
    ],
    [
      'SIGUSR2 between invocations',
      {},
      'gated: done',
      (/** @type {any} */ ctx, /** @type {string} */ _id, /** @type {string} */ task) => {
        closeTaskUncommitted(ctx, task);
        sendUsr2();
      },
      stop,
    ],
  ])) {
    const ctx = backlog(flows);
    const { id, task } =
      ended === 'waiting: wait_implement'
        ? { id: await story(ctx, { status: 'in_progress', run: 'idle', next: 'wait_implement' }), task: '' }
        : await storyWithTask(ctx);
    const { catalogue } = waitingSteps();
    let changed = false;
    const emit = (/** @type {any} */ record) => {
      if (changed || record.event !== 'flow_end' || record.ended !== ended) return;
      changed = true;
      change(ctx, id, task);
    };
    // gate_recheck_minutes is 15, so only the change can wake the process within the time below.
    const run = suspending(t, ctx, { id, resume: true, catalogue, emit });
    const timeout = new Promise((done) => setTimeout(() => done('still suspended'), 3000).unref());
    const result = await Promise.race([run.pending, timeout]);
    t.mock.restoreAll();
    assert.ok(changed, `${name}: the change was made`);
    assert.deepEqual(result, expected, name);
  }
});

test('SIGTERM to a suspended process ends it; the item keeps gated: <to>, and the log ends with that flow_end', async (t) => {
  const ctx = backlog();
  const { id } = await storyWithTask(ctx);
  const { child, exited, stderr } = startFlowChild(t, ctx.backlogDir, id, 'resume', ['wake']);
  const suspended = `${id}: suspended at gated: done`;
  await until('the suspend', () => stderr().includes(suspended));
  const lock = itemLockPath(ctx.backlogDir, id);
  assert.equal(holderOf(lock), child.pid);

  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.equal(holderOf(lock), null, 'the kernel freed the lock');
  assert.deepEqual(stateOf(ctx, id), {
    status: 'implemented',
    run: 'gated: done',
    held: { box: 'close', outcome: 'success' },
  });
  const { event, ended } = logOf(ctx, id).at(-1);
  assert.deepEqual({ event, ended }, { event: 'flow_end', ended: 'gated: done' });
  assert.equal(git(ctx.backlogDir, 'status', '--porcelain'), '', 'nothing is left to write');
});

// ---- wait boxes (F-152 D5) ----

/** `fakeSteps(plan)` with the real `wait` step, which runs no step and so never shows in `ran`. */
function waitingSteps(/** @type {Record<string, any>} */ plan = {}) {
  const { catalogue, ran } = fakeSteps(plan);
  return { catalogue: { ...catalogue, wait: STEPS.wait }, ran };
}

const WAIT_FIX = 'deliver/self_check/wait_fix';

test("a flow that reaches self_check's wait_fix commits waiting: <box> and its flow_end and suspends; a commit that is no outcome for the box wakes it with no commit; an outcome entry success follows the success arrow, and failure the failure arrow, each after a flow_start with resume", async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'idle' });
  // A loose story: in_unit fails, so the deliver subflow runs, and open findings after the
  // self-review with the round cap reached go to notify_fix, then to wait_fix.
  const { catalogue, ran } = waitingSteps({
    in_unit: 'failure',
    'deliver/self_check/self_review/findings_closed': 'failure',
    'deliver/self_check/self_round_cap': 'failure',
    'deliver/self_check/fix': 'failure',
  });
  const { runs, wake } = recordingWake();
  const run = suspending(t, ctx, { id, entry: 'deliver', catalogue, wake });
  const suspended = `${id}: suspended at waiting: ${WAIT_FIX}: waiting for bl outcome ${id} success|failure`;
  await until('the wait', () => runs.length === 1);
  assert.deepEqual(stateOf(ctx, id), { status: 'in_progress', run: `waiting: ${WAIT_FIX}` });
  const { at, ...end } = logOf(ctx, id).at(-1);
  assert.deepEqual(end, {
    event: 'flow_end',
    ended: `waiting: ${WAIT_FIX}`,
    outcome: 'success',
    status: 'in_progress',
    commits: [],
  });
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s'), `${id}: ${WAIT_FIX} waiting`);
  assert.equal(ran.at(-1), 'deliver/self_check/notify_fix', 'the wait box runs no step');
  assert.ok(run.lines().includes(suspended), run.lines().join('\n'));

  // A commit that is no outcome for the box: a wake, and no commit.
  git(ctx.backlogDir, 'commit', '-q', '--allow-empty', '-m', 'another item');
  const other = head(ctx);
  await until('the wake on another commit', () => runs.length === 2);
  assert.equal(head(ctx), other, 'no commit');
  assert.deepEqual(stateOf(ctx, id), { status: 'in_progress', run: `waiting: ${WAIT_FIX}` });

  // success: the success arrow runs fix, which fails, and the flow waits at wait_fix again.
  const before = ran.length;
  await appendLog(ctx, id, outcomeEntry(WAIT_FIX, 'success'));
  await until('the second wait at wait_fix', () => runs.length === 3 && ran.length > before);
  assert.deepEqual(ran.slice(before), ['deliver/self_check/fix', 'deliver/self_check/notify_fix']);
  assert.deepEqual(eventsOf(ctx, id).slice(-3), ['outcome', 'flow_start', 'flow_end']);
  const { at: startAt, ...resumed } = logOf(ctx, id).at(-2);
  assert.deepEqual(resumed, { event: 'flow_start', resume: true, status: 'in_progress', by: 'operator' });
  assert.deepEqual(stateOf(ctx, id), { status: 'in_progress', run: `waiting: ${WAIT_FIX}` });

  // failure: the failure arrow returns failure out of self_check and deliver, to the story's
  // deliver failure arrow.
  await appendLog(ctx, id, outcomeEntry(WAIT_FIX, 'failure'));
  const result = await run.pending;
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'stop', status: 'changes_requested', outcome: 'failure' });
  assert.equal(ran.length, before + 2, 'no step runs for the failure outcome');
  assert.deepEqual(eventsOf(ctx, id).slice(-3), ['outcome', 'flow_start', 'flow_end']);
  assert.deepEqual(stateOf(ctx, id), { status: 'changes_requested', run: 'idle' });
  assert.deepEqual(
    run.lines().filter((line) => line.includes('suspended')),
    [suspended],
    'the line is printed again only when it changed',
  );
});

test('the step gate of a wait box is checked before the box: a failing one ends at gated before: <box>, and once it passes the box waits', async (t) => {
  const ctx = backlog({ 'gates.yaml': 'step_gates:\n  wait: [\'item("T-1").closed\']\n' });
  const [id] = await createItems(ctx, [
    { type: 'story', state: { status: 'in_progress', run: 'idle', next: 'wait_implement' } },
    { type: 'task', state: { status: 'draft', run: 'idle' } },
  ]);
  const { catalogue, ran } = waitingSteps();
  const { runs, wake } = recordingWake();
  const run = suspending(t, ctx, { id, resume: true, catalogue, wake });
  await until('the gated wait', () => runs.length === 1);
  assert.deepEqual(runs, ['gated before: wait_implement']);
  assert.deepEqual(stateOf(ctx, id), { status: 'in_progress', run: 'gated before: wait_implement' });

  await closeTask(ctx, 'T-1');
  await until('the wait', () => runs.length === 2);
  assert.deepEqual(runs, ['gated before: wait_implement', 'waiting: wait_implement']);
  assert.deepEqual(stateOf(ctx, id), { status: 'in_progress', run: 'waiting: wait_implement' });

  await appendLog(ctx, id, outcomeEntry('wait_implement', 'failure'));
  const result = await run.pending;
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'stop', status: 'in_progress', outcome: 'failure' });
  assert.deepEqual(ran, []);
  assert.deepEqual(eventsOf(ctx, id), [
    'flow_start',
    'flow_end',
    'flow_start',
    'flow_end',
    'outcome',
    'flow_start',
    'flow_end',
  ]);
});

test('without wake, an invocation that reaches a wait box returns at waiting: <box>', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'idle', next: 'wait_implement' });
  const { catalogue } = waitingSteps();
  const result = await runFlow(ctx, { id, by: 'operator', resume: true, catalogue });
  assert.deepEqual(result, { ended: 'waiting: wait_implement', status: 'in_progress' });
  assert.equal(holderOf(itemLockPath(ctx.backlogDir, id)), null);
});

// ---- an outcome logged while a step runs (F-152 D7, D-9) ----

test("an outcome entry for the box that another writer commits while the step runs wins over the step's outcome: the runner follows its arrow, and the box's commit logs a flow_start with resume after it", async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  // implement's failure arrow goes to notify_implement; the logged success goes on to in_unit.
  const { catalogue, ran } = fakeSteps({
    implement: async (/** @type {any} */ step) => {
      await appendLog(ctx, step.id, outcomeEntry('implement', 'success'));
      return 'failure';
    },
  });
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'implemented', outcome: 'success' });
  assert.deepEqual(ran, RUN_BOXES, 'the success arrow of implement is followed');
  assert.deepEqual(eventsOf(ctx, id), ['flow_start', 'outcome', 'flow_start', 'flow_end']);
  const { at, ...resumed } = logOf(ctx, id).at(-2);
  assert.deepEqual(resumed, { event: 'flow_start', resume: true, status: 'in_progress', by: 'operator' });
  const commit = commitsSince(ctx, base).find(({ subject }) => subject === `${id}: implement success`);
  assert.ok(commit !== undefined, 'the commit of implement names the logged outcome');
  const path = itemDir(ctx, id).path;
  assert.deepEqual(git(ctx.backlogDir, 'show', '--name-only', '--format=', commit.sha).split('\n').sort(), [
    `${path}/log.jsonl`,
    `${path}/state.json`,
  ]);
  assert.deepEqual(stateOf(ctx, id), { status: 'implemented', run: 'idle' });
});

// ---- the checks of an entry (F-152 D6, D-48) ----

test('runFlow refuses an entry, with the reason and no commit, when the flow has no such entry, the run state or the status does not allow it, or a start gate fails', async () => {
  // [what, flows, the story's state, the entry, a task child, the reason]
  const cases = [
    ['no such entry', {}, { status: 'refined', run: 'idle' }, 'nope', false, "the story flow has no entry 'nope'"],
    [
      'a run state not in run_states',
      {},
      { status: 'refined', run: 'gated before: implement' },
      'run',
      false,
      'the entry run is refused: the run state is gated before: implement; it starts only from idle',
    ],
    [
      'active on another host',
      {},
      { status: 'refined', run: 'active: prepare', host: `not-${hostname()}` },
      'supersede',
      false,
      'the entry supersede is refused: the run state is active: prepare; it starts only from idle, waiting, gated, interrupted',
    ],
    [
      'a status not in from',
      {},
      { status: 'draft', run: 'idle' },
      'run',
      false,
      'the entry run is refused: the status is draft; it starts only from refined',
    ],
    [
      'a failing start step gate',
      { 'gates.yaml': 'step_gates:\n  close: [\'status == "merged"\']\n' },
      { status: 'implemented', run: 'idle' },
      'close',
      false,
      'the entry close is refused: the step gate of close fails: status == "merged"',
    ],
    [
      "a failing gate of the status that the start box's success arrow sets",
      {},
      { status: 'implemented', run: 'idle' },
      'close',
      true,
      `the entry close is refused: the status gate of done, which the success arrow of close sets, fails: ${DONE_GATE}`,
    ],
  ];
  for (const [what, flows, state, entry, withTask, reason] of cases) {
    const ctx = backlog(flows);
    const [id, task] = await createItems(ctx, [
      { type: 'story', state },
      ...(withTask ? [{ type: 'task', state: { status: 'draft', run: 'idle' } }] : []),
    ]);
    if (withTask) await setGraph(ctx, 'containment', { [task]: { parent: id } });
    const base = head(ctx);
    const { catalogue, ran } = fakeSteps();
    await assert.rejects(runFlow(ctx, { id, by: 'operator', entry, catalogue }), { message: `${id}: ${reason}` }, what);
    assert.deepEqual(ran, [], what);
    assert.equal(head(ctx), base, `${what}: no commit`);
    assert.deepEqual(stateOf(ctx, id), state, what);
  }
});

test('an entry with run_states [idle, waiting] starts on a waiting item, and its flow_start has replaced: waiting: <box>', async () => {
  const ctx = backlog();
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'waiting: wait_run_task' } }]);
  const { catalogue, ran } = fakeSteps();
  const result = await runFlow(ctx, { id, by: 'operator', entry: 'close', catalogue });
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(ran, ['close']);
  const { at, ...flowStart } = logOf(ctx, id).at(-2);
  assert.deepEqual(flowStart, {
    event: 'flow_start',
    entry: 'close',
    status: 'draft',
    replaced: 'waiting: wait_run_task',
    by: 'operator',
  });
  assert.deepEqual(stateOf(ctx, id), { status: 'done', run: 'idle' });
});

test('an entry on a gated item drops the held transition, and one on an interrupted item names the stored active in replaced', async () => {
  for (const [what, state, replaced] of [
    ['gated', { status: 'draft', run: 'gated: done', held: { box: 'run_task', outcome: 'success' } }, 'gated: done'],
    ['interrupted', { status: 'draft', run: 'active: run_task', host: hostname() }, 'active: run_task'],
  ]) {
    const ctx = backlog();
    const [id] = await createItems(ctx, [{ type: 'task', state }]);
    const base = head(ctx);
    const { catalogue } = fakeSteps();
    await runFlow(ctx, { id, by: 'operator', entry: 'supersede', catalogue });
    assert.equal(logOf(ctx, id).at(-2).replaced, replaced, what);
    const first = commitsSince(ctx, base)[0];
    assert.deepEqual(
      JSON.parse(git(ctx.backlogDir, 'show', `${first.sha}:${itemDir(ctx, id).path}/state.json`)),
      { status: 'draft', run: 'active: supersede', host: hostname() },
      `${what}: the start drops held`,
    );
  }
});

test('emit gets each log entry and each usage entry of the item that a commit wrote, with item_id, after the commit', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const usage = { at: AT, step: 'implement', agent: 'replay', input: 1, output: 2, cache_creation: 0, cache_read: 0 };
  const { catalogue } = fakeSteps({
    implement: (/** @type {any} */ step) => {
      step.stage((/** @type {any} */ w) => w.usage(step.id, usage));
      return 'success';
    },
  });
  /** @type {Array<{ record: Record<string, unknown>, head: string }>} each record, and HEAD when it came */
  const emitted = [];
  const emit = (/** @type {Record<string, unknown>} */ record) => emitted.push({ record, head: head(ctx) });
  await runFlow(ctx, { id, by: 'operator', entry: 'run', catalogue, emit });
  assert.ok(emitted.every(({ record }) => record.item_id === id));
  const entries = emitted.map(({ record: { item_id, ...entry } }) => entry);
  assert.deepEqual(
    entries.filter((entry) => 'event' in entry),
    logOf(ctx, id).slice(1),
    'every log entry after created, as the file holds it',
  );
  assert.deepEqual(
    entries.filter((entry) => !('event' in entry)),
    [usage],
  );
  // Each record comes after its commit: the flow_start's commit is not the one of the usage entry.
  const [start, used] = emitted;
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s', start.head), `${id}: run started`);
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s', used.head), `${id}: implement success`);
});
