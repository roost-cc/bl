/**
 * The entry commands (F-152 D6): `runEntry` on a story of the uTop flow set with fake steps, the
 * entry record schema, and the record stream `flowRecords`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue } from '../config/check.js';
import { STEPS } from '../engine/flow-set.js';
import { now, storeWrite } from '../store/write.js';
import { createItems, definedSteps, engineBacklog } from '../test/helpers/engine-backlog.js';
import { UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { ENTRY_RECORD_SCHEMA, entryOp, flowRecords, runEntry } from './entry.js';

/**
 * The uTop catalogue of fake steps, whose `agent` step records each box it runs and the `agents`
 * list of its `with` in `seen`.
 */
function recordingAgents() {
  /** @type {Array<[string, unknown]>} */
  const seen = [];
  const agent = {
    ...UTOP_STEPS.agent,
    run: async (/** @type {any} */ step, /** @type {any} */ args) => (seen.push([step.box, args.agents]), 'success'),
  };
  return { catalogue: Object.freeze({ ...UTOP_STEPS, agent }), seen };
}

/** A backlog with the uTop flow set and no step gates, and its op context with `catalogue`. */
const backlog = (/** @type {Readonly<Record<string, any>>} */ catalogue) => ({
  ...engineBacklog({ 'defined-steps.yaml': definedSteps() }, 'repos: {}\n', catalogue),
  catalogue,
});

test('--agent <profile> on fix reaches the boxes of the defined step fix as an override, and the other agent boxes keep their lists', async () => {
  const { catalogue, seen } = recordingAgents();
  const ctx = backlog(catalogue);
  const [id] = await createItems(ctx, [{ type: 'story', state: { status: 'changes_requested', run: 'idle' } }]);
  const records = await Array.fromAsync(
    runEntry('fix', { id, agent: ['claude'], json: true }, /** @type {any} */ (ctx)),
  );
  const { nodes } = ctx.flowSet.flows.story;
  const fixes = seen.filter(([box]) => nodes[box].defined === 'fix');
  assert.ok(fixes.length > 0, 'a fix box ran');
  assert.deepEqual(
    fixes.map(([, agents]) => agents),
    fixes.map(() => ['claude']),
  );
  const others = seen.filter(([box]) => nodes[box].defined !== 'fix');
  assert.ok(others.length > 0, 'another agent box ran');
  assert.ok(
    others.every(([, agents]) => JSON.stringify(agents) !== '["claude"]'),
    JSON.stringify(others),
  );
  const { item_id, event, entry } = records[0];
  assert.deepEqual({ item_id, event, entry }, { item_id: id, event: 'flow_start', entry: 'fix' });
});

test('without --agent, fix runs each box with its own list', async () => {
  const { catalogue, seen } = recordingAgents();
  const ctx = backlog(catalogue);
  const [id] = await createItems(ctx, [{ type: 'story', state: { status: 'changes_requested', run: 'idle' } }]);
  await Array.fromAsync(runEntry('fix', { id, agent: null, json: false }, /** @type {any} */ (ctx)));
  assert.ok(
    seen.every(([, agents]) => JSON.stringify(agents) !== '["claude"]'),
    JSON.stringify(seen),
  );
});

test('an entry that the type of the item has no flow entry for is refused, naming the types whose flows have it', async () => {
  const ctx = backlog(UTOP_STEPS);
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle' } }]);
  assert.throws(() => runEntry('implement', { id }, /** @type {any} */ (ctx)), {
    message: `${id}: the task flow has no entry 'implement'; the flows of story have it`,
  });
  assert.throws(() => runEntry('nope', { id }, /** @type {any} */ (ctx)), {
    message: `${id}: the task flow has no entry 'nope'; no flow has it`,
  });
  assert.throws(() => runEntry('run', { id: 'T-9' }, /** @type {any} */ (ctx)), {
    message: 'there is no item T-9 in the backlog',
  });
});

test("entryOp gives the positional id and the options of every flow's entry of that name, each once, and the entry record schema", () => {
  const ctx = backlog(UTOP_STEPS);
  const op = entryOp('fix', ctx.flowSet);
  // The story, feature and batch flows each declare fix's --agent alike (D-424).
  assert.deepEqual(Object.keys(op.args), ['id', '--agent']);
  assert.equal(op.schema, ENTRY_RECORD_SCHEMA);
  assert.deepEqual(Object.keys(entryOp('run', ctx.flowSet).args), ['id']);
});

test("each record of an entry's run holds to the entry record schema, and a record without item_id or with a field its entry lacks does not", async () => {
  const ctx = backlog(UTOP_STEPS);
  const [id] = await createItems(ctx, [{ type: 'story', state: { status: 'refined', run: 'idle' } }]);
  const records = await Array.fromAsync(runEntry('run', { id }, /** @type {any} */ (ctx)));
  assert.deepEqual(
    records.map(({ event }) => event),
    ['flow_start', 'flow_end'],
  );
  for (const record of records) assert.deepEqual(checkValue(ENTRY_RECORD_SCHEMA, record), [], JSON.stringify(record));
  const usage = { item_id: id, at: '2026-11-28T10:00:00Z', step: 'implement', agent: 'replay' };
  const tokens = { input: 1, output: 2, cache_creation: 0, cache_read: 0 };
  assert.deepEqual(checkValue(ENTRY_RECORD_SCHEMA, { ...usage, ...tokens }), []);
  const { item_id: _, ...start } = records[0];
  const rules = (/** @type {unknown} */ record) => checkValue(ENTRY_RECORD_SCHEMA, record).map(({ rule }) => rule);
  assert.ok(rules(start).includes('required'), 'no item_id');
  assert.ok(rules({ ...records[0], extra: 1 }).includes('additionalProperties'), 'a field that flow_start lacks');
  assert.ok(rules({ ...usage, input: 1 }).includes('required'), 'a usage entry without its tokens');
});

test('flowRecords keeps the records that come before the reader, then ends, or gives the error after the records', async () => {
  const done = flowRecords(async (emit) => {
    emit({ n: 1 });
    emit({ n: 2 });
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await Array.fromAsync(done), [{ n: 1 }, { n: 2 }]);

  const failed = flowRecords(async (emit) => {
    emit({ n: 1 });
    throw new Error('refused');
  });
  /** @type {unknown[]} */
  const read = [];
  await assert.rejects(async () => {
    for await (const record of failed) read.push(record);
  }, /refused/);
  assert.deepEqual(read, [{ n: 1 }]);
});

test('an entry that reaches a wait box streams its records, suspends with waitForWake, and goes on in the same call after an outcome entry for the box', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  // fix fails, so fix_round goes to notify_fix and then waits at wait_fix.
  const agent = { ...UTOP_STEPS.agent, run: async () => 'failure' };
  const ctx = backlog(Object.freeze({ ...UTOP_STEPS, agent, wait: STEPS.wait }));
  const [id] = await createItems(ctx, [{ type: 'story', state: { status: 'changes_requested', run: 'idle' } }]);
  const records = runEntry('fix', { id }, /** @type {any} */ (ctx))[Symbol.asyncIterator]();
  const first = [(await records.next()).value, (await records.next()).value];
  assert.deepEqual(
    first.map(({ event, ended }) => [event, ended]),
    [
      ['flow_start', undefined],
      ['flow_end', 'waiting: fix_round/wait_fix'],
    ],
  );
  const outcome = { at: now(), event: 'outcome', box: 'fix_round/wait_fix', outcome: 'failure', by: 'operator' };
  await storeWrite(ctx, { message: `${id}: outcome` }, (w) => w.log(id, outcome));
  const rest = [];
  for (let next = await records.next(); !next.done; next = await records.next()) rest.push(next.value);
  assert.deepEqual(
    rest.map(({ event, resume }) => [event, resume]),
    [
      ['flow_start', true],
      ['flow_end', undefined],
    ],
  );
});
