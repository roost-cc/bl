import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { join, sep } from 'path';
import { STEPS } from '../../engine/flow-set.js';
import { holderOf } from '../../lib/kernel-lock.js';
import { itemLockPath } from '../../lib/lock.js';
import { itemDir } from '../../store/items.js';
import { createItems, engineBacklog } from '../../test/helpers/engine-backlog.js';
import { UTOP_STEPS } from '../../test/helpers/flow-fixture.js';
import { git } from '../../test/helpers/git.js';
import { holdLockInChild } from '../../test/helpers/hold-lock.js';
import { recorder } from '../../test/helpers/streams.js';
import { recordingWake, suspending } from '../../test/helpers/suspending.js';
import { waitUntil } from '../../test/helpers/wait-until.js';
import { dispatch } from '../dispatch.js';
import { writeOutput } from '../output.js';
import { OPS } from './index.js';

/** A backlog with the uTop flow set and an `outcome` line in `commands.yaml` that names the op. */
const backlog = () =>
  engineBacklog({}, undefined, undefined, {
    'config/commands.yaml': 'outcome: { op: outcome, help: record the outcome of a box by hand }\n',
  });

/** Make one story with `state`, and give its id. */
const story = async (ctx, state) => (await createItems(ctx, [{ type: 'story', state }]))[0];

/** Run `bl-next outcome <argv>` through `dispatch`. */
const outcome = (ctx, ...argv) => dispatch(['outcome', ...argv], { ...ctx, ops: OPS });

const head = (ctx) => git(ctx.backlogDir, 'rev-parse', 'HEAD');
const logOf = (ctx, id) =>
  readFileSync(join(ctx.backlogDir, itemDir(ctx, id).path, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/** The files in the backlog's `.bl/` outside `.bl/lock/`, which holds the locks of every store write. */
const blFiles = (ctx) =>
  readdirSync(join(ctx.backlogDir, '.bl'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(join(ctx.backlogDir, '.bl', 'lock') + sep));

for (const [run, state] of /** @type {const} */ ([
  ['waiting: wait_implement', { status: 'in_progress', run: 'waiting: wait_implement' }],
  ['active: wait_implement', { status: 'in_progress', run: 'active: wait_implement', host: hostname() }],
  ['interrupted: wait_implement', { status: 'in_progress', run: 'active: wait_implement', host: hostname() }],
])) {
  test(`bl-next outcome <id> success "<note>" on ${run} commits the outcome entry with the trailers of the box, and prints that entry`, async (t) => {
    const ctx = backlog();
    const id = await story(ctx, state);
    if (run.startsWith('active')) {
      // A live process runs the box, so the run state reads active, not interrupted.
      const child = await holdLockInChild(itemLockPath(ctx.backlogDir, id));
      t.after(() => child.kill());
    }
    const base = head(ctx);
    const done = /** @type {import('../dispatch.js').Run} */ (await outcome(ctx, id, 'success', 'checked by hand'));
    const { at, ...entry } = /** @type {any} */ (done.result);
    assert.match(at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(entry, {
      event: 'outcome',
      box: 'wait_implement',
      outcome: 'success',
      note: 'checked by hand',
      by: 'operator',
    });
    assert.deepEqual(logOf(ctx, id).at(-1), done.result, 'the record is the entry in the log');

    assert.equal(git(ctx.backlogDir, 'rev-list', '--count', `${base}..HEAD`), '1');
    assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s'), `${id}: wait_implement success (bl outcome)`);
    const trailers = git(ctx.backlogDir, 'log', '-1', '--format=%(trailers:only,unfold)').trim().split('\n');
    assert.deepEqual(trailers, ['Bl-Flow: story', 'Bl-Step: wait_implement', `Bl-Item: ${id}`]);
    const path = itemDir(ctx, id).path;
    assert.deepEqual(git(ctx.backlogDir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [
      `${path}/log.jsonl`,
    ]);
    assert.deepEqual(blFiles(ctx), [], 'it writes nothing in .bl/ but the locks');

    const { stream, chunks } = recorder();
    const { name, op, args, result } = done;
    await writeOutput({ command: name, op, args, result, config: ctx.config, stdout: stream });
    assert.equal(chunks.join(''), `${JSON.stringify(done.result)}\n`);
  });
}

test('bl-next outcome with no note writes an entry with no note', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'waiting: wait_implement' });
  const done = /** @type {import('../dispatch.js').Run} */ (await outcome(ctx, id, 'failure'));
  const { at, ...entry } = /** @type {any} */ (done.result);
  assert.deepEqual(entry, { event: 'outcome', box: 'wait_implement', outcome: 'failure', by: 'operator' });
});

test('bl-next outcome refuses an outcome other than success and failure, with no commit', async () => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'waiting: wait_implement' });
  const base = head(ctx);
  const refused = /** @type {import('../dispatch.js').Exit} */ (await outcome(ctx, id, 'maybe'));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /argument outcome: invalid choice: 'maybe' \(choose from 'success', 'failure'\)/);
  assert.equal(head(ctx), base);
});

for (const [run, state] of [
  ['idle', { status: 'in_progress', run: 'idle' }],
  ['gated: done', { status: 'implemented', run: 'gated: done', held: { box: 'close', outcome: 'success' } }],
  ['gated before: close', { status: 'implemented', run: 'gated before: close' }],
]) {
  test(`bl-next outcome refuses an item at ${run}, with the reason and no commit`, async () => {
    const ctx = backlog();
    const id = await story(ctx, state);
    const base = head(ctx);
    await assert.rejects(outcome(ctx, id, 'success'), {
      message: `${id}: the run state is ${run}; an outcome is for a box that is active, interrupted or waiting`,
    });
    assert.equal(head(ctx), base);
  });
}

test('bl-next outcome on an item that does not exist names it, with no commit', async () => {
  const ctx = backlog();
  const base = head(ctx);
  await assert.rejects(outcome(ctx, 'S-99', 'success'), { message: 'there is no item S-99 in the backlog' });
  assert.equal(head(ctx), base);
});

test("bl-next outcome on a waiting item wakes its suspended process, which follows the outcome's arrow", async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'waiting: wait_implement' });
  const { runs, wake } = recordingWake();
  // A resume finds the wait box with no outcome, and suspends with the item lock.
  const run = suspending(t, ctx, { id, resume: true, catalogue: { ...UTOP_STEPS, wait: STEPS.wait }, wake });
  await waitUntil(() => (runs.length === 1 ? true : undefined), 'the suspend at the wait box');
  assert.equal(holderOf(itemLockPath(ctx.backlogDir, id)), process.pid);

  // wait_implement's failure arrow goes to stop. The commit of the op wakes the process: no signal.
  await outcome(ctx, id, 'failure', 'done by hand');
  const result = await run.pending;
  t.mock.restoreAll();
  assert.deepEqual(result, { ended: 'stop', status: 'in_progress', outcome: 'failure' });
  assert.deepEqual(runs, ['waiting: wait_implement'], 'it did not suspend again');
  assert.deepEqual(
    logOf(ctx, id)
      .slice(-3)
      .map(({ event }) => event),
    ['outcome', 'flow_start', 'flow_end'],
  );
  assert.ok(
    run.lines().includes(`${id}: suspended at waiting: wait_implement: waiting for bl outcome ${id} success|failure`),
  );
});
