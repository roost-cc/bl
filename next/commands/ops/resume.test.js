/**
 * The resume op (F-152 D7): the SIGUSR2 to the lock holder, and the continuation of an item with no
 * holder, on stories of the uTop flow set with fake steps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'os';
import { checkValue } from '../../config/check.js';
import { STEPS } from '../../engine/flow-set.js';
import { holderOf } from '../../lib/kernel-lock.js';
import { itemLockPath } from '../../lib/lock.js';
import { now, storeWrite } from '../../store/write.js';
import { createItems, definedSteps, engineBacklog } from '../../test/helpers/engine-backlog.js';
import { UTOP_STEPS } from '../../test/helpers/flow-fixture.js';
import { git } from '../../test/helpers/git.js';
import { recordingWake, suspending } from '../../test/helpers/suspending.js';
import { waitUntil } from '../../test/helpers/wait-until.js';
import { dispatch } from '../dispatch.js';
import { ENTRY_RECORD_SCHEMA } from '../entry.js';
import { OPS } from './index.js';

/** The uTop catalogue of fake steps with the wait step, whose `agent` step records each box it runs and its `agents`. */
function recordingAgents() {
  /** @type {Array<[string, unknown]>} */
  const seen = [];
  const agent = {
    ...UTOP_STEPS.agent,
    run: async (/** @type {any} */ step, /** @type {any} */ args) => (seen.push([step.box, args.agents]), 'success'),
  };
  return { catalogue: Object.freeze({ ...UTOP_STEPS, agent, wait: STEPS.wait }), seen };
}

/** A backlog with the uTop flow set, no step gates and a `resume` line, and its op context with `catalogue`. */
const backlog = (/** @type {Readonly<Record<string, any>>} */ catalogue) => ({
  ...engineBacklog({ 'defined-steps.yaml': definedSteps() }, 'repos: {}\n', catalogue, {
    'config/commands.yaml': 'resume: { op: resume, help: continue an item }\n',
  }),
  catalogue,
});

/** Make one story with `state`, and give its id. */
const story = async (ctx, state) => (await createItems(ctx, [{ type: 'story', state }]))[0];

/** Run `bl-next resume <argv>` through `dispatch`, and give its records. */
const resume = async (ctx, ...argv) => {
  const run = /** @type {import('../dispatch.js').Run} */ (await dispatch(['resume', ...argv], { ...ctx, ops: OPS }));
  return Array.fromAsync(/** @type {any} */ (run.result));
};

const head = (ctx) => git(ctx.backlogDir, 'rev-parse', 'HEAD');

/** Catch stderr for the test, and give the lines printed so far. */
const stderrLines = (t) => {
  /** @type {string[]} */
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(String(text)) > 0);
  return () => printed.join('').split('\n').filter(Boolean);
};

test('bl-next resume of an item that a suspended process holds sends it SIGUSR2, prints that, gives no records, and the process checks its gate again', async (t) => {
  const { catalogue } = recordingAgents();
  const ctx = backlog(catalogue);
  const id = await story(ctx, { status: 'in_progress', run: 'waiting: wait_implement' });
  const { runs, wake } = recordingWake();
  const run = suspending(t, ctx, { id, resume: true, catalogue, wake });
  await waitUntil(() => (runs.length === 1 ? true : undefined), 'the suspend at the wait box');
  const base = head(ctx);

  assert.deepEqual(await resume(ctx, id), []);
  assert.ok(run.lines().includes(`${id}: woke process ${process.pid}`), run.lines().join('\n'));
  // The wake reads the run state again, finds no outcome for the wait box, and suspends again.
  await waitUntil(() => (runs.length === 2 ? true : undefined), 'the check after the wake');
  assert.equal(head(ctx), base);
  assert.equal(holderOf(itemLockPath(ctx.backlogDir, id)), process.pid);

  const outcome = { at: now(), event: 'outcome', box: 'wait_implement', outcome: 'failure', by: 'operator' };
  await storeWrite(ctx, { message: `${id}: outcome` }, (w) => w.log(id, outcome));
  await run.pending;
});

test('bl-next resume with no holder continues an interrupted item at its box and streams its log entries with item_id', async (t) => {
  stderrLines(t);
  const { catalogue, seen } = recordingAgents();
  const ctx = backlog(catalogue);
  const id = await story(ctx, { status: 'in_progress', run: 'active: implement', host: hostname() });
  const records = await resume(ctx, id);
  assert.equal(seen[0][0], 'implement', 'the interrupted box runs first');
  const { item_id, event, resume: resumed } = records[0];
  assert.deepEqual({ item_id, event, resumed }, { item_id: id, event: 'flow_start', resumed: true });
  assert.equal(records.at(-1).event, 'flow_end');
  for (const record of records) assert.deepEqual(checkValue(ENTRY_RECORD_SCHEMA, record), [], JSON.stringify(record));
});

test('bl-next resume of an idle item with no next prints the entries from its status, gives no records and commits nothing', async (t) => {
  const lines = stderrLines(t);
  const ctx = backlog(UTOP_STEPS);
  const id = await story(ctx, { status: 'refined', run: 'idle' });
  const base = head(ctx);
  assert.deepEqual(await resume(ctx, id), []);
  assert.deepEqual(lines(), [`${id}: nothing to continue; entries from refined: refine, run, implement, supersede`]);
  assert.equal(head(ctx), base);
});

test('bl-next resume --agent <profile> replaces the agents of the defined step of the start box only', async (t) => {
  stderrLines(t);
  const { catalogue, seen } = recordingAgents();
  const ctx = backlog(catalogue);
  const id = await story(ctx, { status: 'in_progress', run: 'active: implement', host: hostname() });
  await resume(ctx, id, '--agent', 'claude');
  const { nodes } = ctx.flowSet.flows.story;
  const implement = seen.filter(([box]) => nodes[box].defined === 'implement');
  assert.deepEqual(
    implement.map(([, agents]) => agents),
    implement.map(() => ['claude']),
  );
  const others = seen.filter(([box]) => nodes[box].defined !== 'implement');
  assert.ok(others.length > 0, 'another agent box ran');
  assert.ok(
    others.every(([, agents]) => JSON.stringify(agents) !== '["claude"]'),
    JSON.stringify(others),
  );
});

test('bl-next resume --agent refuses a start box that runs no defined step, with no commit', async () => {
  const ctx = backlog(UTOP_STEPS);
  const id = await story(ctx, { status: 'in_progress', run: 'idle', next: 'child_check' });
  const base = head(ctx);
  await assert.rejects(resume(ctx, id, '--agent', 'claude'), {
    message: `${id}: --agent needs a start box that runs a defined step, and child_check runs none`,
  });
  assert.equal(head(ctx), base);
});

test('bl-next resume of an item that does not exist names it', async () => {
  const ctx = backlog(UTOP_STEPS);
  await assert.rejects(resume(ctx, 'S-99'), { message: 'there is no item S-99 in the backlog' });
});
