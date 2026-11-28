// The code steps succeed, assert and increment (F-140 D5), shop steps (D6), rank (D8) and notify (D9), on a fixture task flow beside the uTop
// flow set, run by F-139's runner with the real step catalogue. They are here, not in steps/,
// because only engine/ may import the runner (the layer rule, F-135 D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { STEPS } from '../steps/index.js';
import { shopSteps } from '../steps/shop.js';
import { checkState } from '../store/item-json.js';
import { itemDir } from '../store/items.js';
import { createItems, engineBacklog, setGraph } from '../test/helpers/engine-backlog.js';
import { UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { git } from '../test/helpers/git.js';
import { channel, delivered, notifyBacklog } from '../test/helpers/notify-backlog.js';
import { stderrOfAsync } from '../test/helpers/streams.js';
import { runFlow } from './runner.js';

const CATALOGUE = { ...UTOP_STEPS, ...STEPS };

/** A flow of `type`, by default the task's, whose `run` entry starts at the box `first`, written as `box`. */
const taskFlow = (/** @type {string} */ box, type = 'task') =>
  [
    'flows:',
    `  ${type}:`,
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

test('assert_calls_a_shop_predicate, and a call with the wrong number of arguments is a fault at load', async () => {
  const predicates = "repos: {}\nplugin_registry:\n  predicates:\n    is: 'test {{args.0}} = {{args.1}}'\n";
  const box = (/** @type {string} */ call) => `{ use: assert, with: ['${call}'], ${ARROWS} }`;
  const ctx = engineBacklog({ 'task.yaml': taskFlow(box("predicates.is(item_id, ''T-1'')")) }, predicates, CATALOGUE);
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle' } }]);
  assert.deepEqual(await run(ctx, id), { ended: 'stop', status: 'done', outcome: 'success' });
  assert.throws(
    () => engineBacklog({ 'task.yaml': taskFlow(box('predicates.is(item_id)')) }, predicates, CATALOGUE),
    (/** @type {Error} */ error) =>
      error.name === 'ConfigurationFaults' &&
      /^config\/flows\/task\.yaml: \/flows\/task\/steps\/first\/with\/0: cel: /m.test(error.message),
  );
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

test('increment_rejects_or_advances_counters_at_integer_limit', async () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // A counter below the limit advances by one, up to the limit.
  const below = await task(INCREMENT, { counters: { r: { value: MAX - 1, threshold: MAX } } });
  assert.deepEqual((await committed(below.ctx, below.id)).state.counters, { r: { value: MAX, threshold: MAX } });
  // A counter at the limit is a crash, and the box commits no counter.
  const at = await task(INCREMENT, { counters: { r: { value: MAX, threshold: 3 } } });
  const crash = await run(at.ctx, at.id);
  assert.equal(crash.name, 'FlowCrash');
  assert.equal(crash.message, `first: ${at.id}: the counter 'r' is at ${MAX}, the largest value it can hold`);
  const state = JSON.parse(readFileSync(join(at.ctx.backlogDir, itemDir(at.ctx, at.id).path, 'state.json'), 'utf8'));
  assert.deepEqual(state.counters, { r: { value: MAX, threshold: 3 } });
  // A stored value or threshold above the limit is a fault of state.json, and so is a threshold argument above it.
  for (const counter of [{ value: MAX + 1 }, { threshold: MAX + 1 }]) {
    assert.match(
      checkState({ status: 'draft', run: 'idle', counters: { r: counter } })[0]?.message ?? '',
      /<= 9007199254740991/,
    );
  }
  const box = INCREMENT.replace('threshold: 3', `threshold: ${MAX + 1}`);
  assert.throws(() => engineBacklog({ 'task.yaml': taskFlow(box) }, undefined, CATALOGUE), /first\/with/);
  assert.doesNotThrow(() =>
    engineBacklog(
      { 'task.yaml': taskFlow(INCREMENT.replace('threshold: 3', `threshold: ${MAX}`)) },
      undefined,
      CATALOGUE,
    ),
  );
});

// ---- shop steps (F-140 D6) ----

const SHOP = [
  'repos: {}',
  'plugin_registry:',
  '  steps:',
  `    tag_release: { command: 'exit {{with.code}}', exit_codes: { 1: success } }`,
  // Where it runs, and what {{repo}} gives, go to .bl/, which git ignores; the last stderr line is the note.
  `    where: "mkdir -p .bl && pwd >> .bl/where && printf '<%s>\\\\n' {{repo}} >> .bl/where && echo first >&2 && echo 'the last line' >&2"`,
  '',
].join('\n');

/** One task of the task flow of `box` on the shop backlog, run once; its result and context. */
async function runShopTask(/** @type {string} */ box) {
  const ctx = engineBacklog({ 'task.yaml': taskFlow(box) }, SHOP, (config) => ({ ...CATALOGUE, ...shopSteps(config) }));
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle' } }]);
  const catalogue = { ...CATALOGUE, ...shopSteps(ctx.config) };
  const result = await runFlow(ctx, { id, start: 'first', by: 'operator', entry: 'run', catalogue }).catch((e) => e);
  return { ctx, id, result };
}

test('a shop step goes to the arrow of its exit status, by its exit_codes', async () => {
  const cases = [
    // [code, the status at the end, the outcome]
    [1, 'done', 'success'],
    [2, 'superseded', 'failure'],
  ];
  for (const [code, status, outcome] of cases) {
    const { result } = await runShopTask(`{ use: steps.tag_release, with: { code: ${code} }, ${ARROWS} }`);
    assert.deepEqual(result, { ended: 'stop', status, outcome }, `code ${code}`);
  }
});

test('a shop step runs once in the backlog root, {{repo}} renders as nothing, and its last stderr line is the note', async () => {
  const { ctx, id, result } = await runShopTask(`{ use: steps.where, ${ARROWS} }`);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.equal(readFileSync(join(ctx.backlogDir, '.bl/where'), 'utf8'), `${realpathSync(ctx.backlogDir)}\n<>\n`);
  assert.match(
    git(ctx.backlogDir, 'log', '-1', '--format=%B'),
    new RegExp(`^${id}: first success\\n\\nthe last line\\n`),
  );
});

// ---- rank (F-140 D8) ----

/** The rank graph, under a name other than its engine's (Decision A4); it continues the graphs list. */
const ORDER = '  - { name: order, engine: rank, nodes: [feature, story] }\nrepos: {}\n';
const RANK_LAST = '{ use: rank, with: { at: last }, success: { status: done, next: stop } }';

/**
 * A backlog whose feature, story and task flows each run `box`, with the rank
 * graph `order` holding `chain`, and a feature F, its story S and a task T,
 * each a draft. `chain` names the items by key: `F`, `S` or `X`, an item outside the flows.
 */
async function rankBacklog(/** @type {string} */ box, /** @type {string[]} */ chain = []) {
  const flows = Object.fromEntries(['feature', 'story', 'task'].map((type) => [`${type}.yaml`, taskFlow(box, type)]));
  const ctx = engineBacklog(flows, ORDER, CATALOGUE);
  const draft = { status: 'draft', run: 'idle' };
  const [F, S, X, T] = await createItems(
    ctx,
    ['feature', 'story', 'feature', 'task'].map((type) => ({ type, state: draft })),
  );
  const ids = { F, S, X, T };
  await setGraph(ctx, 'containment', { [S]: { unit: F } });
  if (chain.length > 0)
    await setGraph(
      ctx,
      'order',
      chain.map((key) => ids[key]),
    );
  return { ctx, ...ids };
}

/** The rank chain at HEAD. */
const chainAtHead = (/** @type {any} */ ctx) => JSON.parse(git(ctx.backlogDir, 'show', 'HEAD:graphs/order.json'));

test('rank at: last commits the unit last in the chain, in the box commit, with its Bl-Item trailer and note', async () => {
  const { ctx, F, X } = await rankBacklog(RANK_LAST, ['X']);
  assert.deepEqual(await run(ctx, F), { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(chainAtHead(ctx), [X, F]);
  const message = git(ctx.backlogDir, 'log', '-1', '--format=%B');
  assert.match(message, new RegExp(`^${F}: first success\\n\\n${F} placed last\\n`));
  assert.match(message, new RegExp(`^Bl-Item: ${F}$`, 'm'));
  // The run state of the box's end is in the same commit.
  assert.equal(JSON.parse(git(ctx.backlogDir, 'show', `HEAD:${itemDir(ctx, F).path}/state.json`)).status, 'done');
  // at: first puts it before the others.
  const first = await rankBacklog(RANK_LAST.replace('last', 'first'), ['X']);
  await run(first.ctx, first.F);
  assert.deepEqual(chainAtHead(first.ctx), [first.F, first.X]);
});

test('rank on a unit that the chain holds changes no chain, and its note names the unit and its place', async () => {
  const { ctx, F, X } = await rankBacklog(RANK_LAST, ['F', 'X']);
  const before = git(ctx.backlogDir, 'rev-parse', 'HEAD:graphs/order.json');
  assert.equal((await run(ctx, F)).outcome, 'success');
  assert.equal(git(ctx.backlogDir, 'rev-parse', 'HEAD:graphs/order.json'), before);
  assert.deepEqual(chainAtHead(ctx), [F, X]);
  assert.match(git(ctx.backlogDir, 'log', '-1', '--format=%B'), new RegExp(`\\n\\n${F} kept its place 1\\n`));
});

test("rank on a story places the story's feature, and its note names the feature", async () => {
  const { ctx, F, S } = await rankBacklog(RANK_LAST);
  assert.equal((await run(ctx, S)).outcome, 'success');
  assert.deepEqual(chainAtHead(ctx), [F]);
  assert.match(
    git(ctx.backlogDir, 'log', '-1', '--format=%B'),
    new RegExp(`^${S}: first success\\n\\n${F} placed last\\n`),
  );
});

test('rank_note_matches_committed_graph_write', async (t) => {
  // Another writer sets the chain after the rank step read it and before the box commits:
  // [what, the box, the chain before, the other writer's chain, the chain at the end, the note or null for a crash]
  const cases = [
    ['placed, and the other writer placed it first', RANK_LAST, ['X'], ['F', 'X'], ['F', 'X'], null],
    ['held, and the other writer moved it', RANK_LAST, ['F', 'X'], ['X', 'F'], ['X', 'F'], null],
    ['placed, and the other writer added another unit', RANK_LAST, [], ['X'], ['X', 'F'], 'F placed last'],
    ['held, and the other writer added after it', RANK_LAST, ['F'], ['F', 'X'], ['F', 'X'], 'F kept its place 1'],
  ];
  for (const [what, box, before, other, after, note] of cases) {
    const { ctx, F, X } = await rankBacklog(box, before);
    const ids = { F, X };
    const rank = {
      ...STEPS.rank,
      run: async (/** @type {any} */ step, /** @type {any} */ args) => {
        const result = await STEPS.rank.run(step, args);
        await setGraph(
          ctx,
          'order',
          other.map((key) => ids[key]),
        );
        return result;
      },
    };
    const printed = [];
    t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(text));
    const result = await runFlow(ctx, {
      id: F,
      start: 'first',
      by: 'operator',
      entry: 'run',
      catalogue: { ...CATALOGUE, rank },
    }).catch((e) => e);
    t.mock.restoreAll();
    assert.deepEqual(
      chainAtHead(ctx),
      after.map((key) => ids[key]),
      what,
    );
    const named = (text) => text.replace(/\bF\b/g, F);
    if (note === null) {
      assert.equal(result.name, 'FlowCrash', what);
      assert.equal(
        result.message,
        `first: ${F}: another writer changed its place in the order graph while the rank step ran`,
        what,
      );
      // The note is printed only after the box's writes commit, so a failed write prints none.
      assert.ok(!printed.some((line) => line.startsWith('first: ')), what);
    } else {
      assert.equal(result.outcome, 'success', what);
      assert.match(git(ctx.backlogDir, 'log', '-1', '--format=%B'), new RegExp(`\\n\\n${named(note)}\\n`), what);
      assert.ok(printed.includes(`first: ${named(note)}\n`), what);
    }
  }
});

test('rank on an item with no work unit is a crash that names the item and its type', async () => {
  const { ctx, T } = await rankBacklog(RANK_LAST);
  const crash = await run(ctx, T);
  assert.equal(crash.name, 'FlowCrash');
  assert.match(crash.message, new RegExp(`^first: ${T} is a task, which is no work type`));
});

test('a rank box with no at, or an at other than first or last, is a fault of the flow set', () => {
  for (const args of ['{}', '{ at: middle }']) {
    const box = RANK_LAST.replace('{ at: last }', args);
    assert.throws(() => engineBacklog({ 'task.yaml': taskFlow(box) }, ORDER, CATALOGUE), /first\/with/, args);
  }
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

// ---- notify (F-140 D9) ----

/**
 * A task flow that comes to `box` from uTop's defined step `self_round_cap` at its cap, as
 * `self_check.yaml` does, so `box.name` is `self_round_cap`.
 */
const notifyFlow = (/** @type {string} */ box) =>
  [
    'flows:',
    '  task:',
    '    initial: draft',
    '    statuses: { draft: {}, done: {}, superseded: {} }',
    '    entries:',
    '      run: { from: [draft], start: self_round_cap }',
    '    steps:',
    '      self_round_cap: { success: tell, failure: tell }',
    `      tell: ${box}`,
    '',
  ].join('\n');

/**
 * One task of the notify flow of `box`, run once, with `channels` as the
 * top-level bl.notify (name → command YAML) and `alerts` as config/alerts.yaml;
 * the uTop English texts. Its result, its id, its context and what bl wrote on stderr.
 */
async function runNotifyTask(
  /** @type {string} */ box,
  /** @type {Record<string, string>} */ channels,
  /** @type {string|undefined} */ alerts = undefined,
) {
  const ctx = notifyBacklog({ flows: { 'task.yaml': notifyFlow(box) }, channels, alerts, catalogue: CATALOGUE });
  const counters = { self_rounds: { value: 3, threshold: 3 } };
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle', counters } }]);
  const start = 'self_round_cap';
  const { value: result, chunks } = await stderrOfAsync(() =>
    runFlow(ctx, { id, start, by: 'operator', entry: 'run', catalogue: CATALOGUE }).catch((e) => e),
  );
  return { ctx, id, result, stderr: chunks.join('') };
}

const ESCALATION = `{ use: notify, with: { template: escalation_waiting, topic: escalation }, ${ARROWS} }`;

test('a notify box runs each routed channel with the rendered text as {{message}}, box.name the box it came from', async () => {
  const { ctx, id, result } = await runNotifyTask(ESCALATION, { terminal: channel('terminal'), bell: channel('bell') });
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  // escalation_waiting: '{{item_id}}{{#parents.unit}} (in {{parents.unit}}){{/parents.unit}} needs you after {{box.name}}: {{title}}'
  const text = `${id} needs you after self_round_cap: task 1\n`;
  assert.equal(delivered(ctx, 'terminal'), text);
  assert.equal(delivered(ctx, 'bell'), text);
});

test('a notify box succeeds when one channel delivers, and fails, with the invocation going on, when none does', async () => {
  const one = await runNotifyTask(ESCALATION, { terminal: channel('terminal', 1), bell: channel('bell') });
  assert.deepEqual(one.result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.notEqual(delivered(one.ctx, 'terminal'), null);

  // 127: the command is not installed, which is a crash code of a plugin but not here (D-101).
  const none = await runNotifyTask(ESCALATION, {
    terminal: channel('terminal', 1),
    bell: 'no-such-notifier-cmd {{message}}',
  });
  assert.deepEqual(none.result, { ended: 'stop', status: 'superseded', outcome: 'failure' });
  assert.match(none.stderr, /^bl\.notify bell: plugin `no-such-notifier-cmd \{\{message\}\}` exited 127 \(exit 127\)/m);
});

test('a notify box whose topic routes to [] runs no channel and succeeds', async () => {
  const alerts = 'gated: []\nended: []\nnotify: [terminal]\nnotify.quiet: []\n';
  const box = `{ use: notify, with: { template: escalation_waiting, topic: quiet }, ${ARROWS} }`;
  const { ctx, result } = await runNotifyTask(box, { terminal: channel('terminal') }, alerts);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.equal(delivered(ctx, 'terminal'), null);
});

test('a notify box with no template or no topic, or another key, is a fault of the flow set', () => {
  for (const args of ['{ template: x }', '{ topic: x }', '{ template: x, topic: y, z: 1 }']) {
    const box = ESCALATION.replace('{ template: escalation_waiting, topic: escalation }', args);
    assert.throws(() => engineBacklog({ 'task.yaml': notifyFlow(box) }, undefined, CATALOGUE), /tell\/with/, args);
  }
});
