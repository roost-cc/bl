/**
 * The stop op (F-152 D7, Decision A2): SIGTERM to the process that holds the item, on stories of the
 * uTop flow set, held by `flow-child.js` at a running fake step or at a wait box.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'os';
import { readRunState } from '../../engine/run-state.js';
import { itemHolder } from '../../lib/lock.js';
import { readState } from '../../store/item-json.js';
import { itemDir } from '../../store/items.js';
import { createItems, definedSteps, engineBacklog } from '../../test/helpers/engine-backlog.js';
import { startFlowChild } from '../../test/helpers/flow-child-run.js';
import { git } from '../../test/helpers/git.js';
import { waitUntil } from '../../test/helpers/wait-until.js';
import { dispatch } from '../dispatch.js';
import { OPS } from './index.js';

/** A backlog with the uTop flow set, no step gates and a `stop` line. */
const backlog = () =>
  engineBacklog({ 'defined-steps.yaml': definedSteps() }, 'repos: {}\n', undefined, {
    'config/commands.yaml': 'stop: { op: stop, help: end the process that holds an item }\n',
  });

/** Make one story with `state`, and give its id. */
const story = async (ctx, state) => (await createItems(ctx, [{ type: 'story', state }]))[0];

/** Run `bl-next stop <id>` through `dispatch`, and give its records. */
const stop = async (ctx, id) => {
  const run = /** @type {import('../dispatch.js').Run} */ (await dispatch(['stop', id], { ...ctx, ops: OPS }));
  return Array.fromAsync(/** @type {any} */ (run.result));
};

/** Catch stderr for the test, and give the lines printed so far. */
const stderrLines = (t) => {
  /** @type {string[]} */
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(String(text)) > 0);
  return () => printed.join('').split('\n').filter(Boolean);
};

/** The stored state of item `id`, and its run state as `bl` reads it. */
const stateOf = (ctx, id) => {
  const state = /** @type {any} */ (readState(ctx, itemDir(ctx, id)));
  return { status: state.status, run: state.run, reads: readRunState(ctx, id, state) };
};

/** Wait until `child` holds the item lock of `id` and its stderr holds `line`. */
const holding = (ctx, id, { child, stderr }, line) =>
  waitUntil(() => (itemHolder(ctx.backlogDir, id) === child.pid && stderr().includes(line) ? true : undefined), line);

test('bl-next stop of an item that a process holds at a running step sends it SIGTERM and prints that; the item reads interrupted: <box> and keeps its status', async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'active: implement', host: hostname() });
  const run = startFlowChild(t, ctx.backlogDir, id, 'resume', ['hang']);
  await holding(ctx, id, run, 'running implement');
  const lines = stderrLines(t);

  assert.deepEqual(await stop(ctx, id), []);
  assert.deepEqual(lines(), [`${id}: stopped process ${run.child.pid}`]);
  t.mock.restoreAll();
  assert.deepEqual(await run.exited, { code: 143, signal: null });
  assert.equal(itemHolder(ctx.backlogDir, id), null);
  assert.deepEqual(stateOf(ctx, id), {
    status: 'in_progress',
    run: 'active: implement',
    reads: 'interrupted: implement',
  });
});

test('bl-next stop of a suspended process ends it, and the item keeps its waiting run state', async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'in_progress', run: 'waiting: wait_implement' });
  const run = startFlowChild(t, ctx.backlogDir, id, 'resume', ['wake']);
  await holding(ctx, id, run, `${id}: suspended at waiting: wait_implement`);
  stderrLines(t);

  assert.deepEqual(await stop(ctx, id), []);
  t.mock.restoreAll();
  assert.deepEqual(await run.exited, { code: 143, signal: null });
  assert.equal(itemHolder(ctx.backlogDir, id), null);
  const { status, run: stored } = stateOf(ctx, id);
  assert.deepEqual({ status, stored }, { status: 'in_progress', stored: 'waiting: wait_implement' });
});

test('bl-next stop with no holder says so on stderr, gives no records and commits nothing', async (t) => {
  const ctx = backlog();
  const id = await story(ctx, { status: 'draft', run: 'idle' });
  const base = git(ctx.backlogDir, 'rev-parse', 'HEAD');
  const lines = stderrLines(t);
  assert.deepEqual(await stop(ctx, id), []);
  assert.deepEqual(lines(), [`${id}: no process holds the item`]);
  assert.equal(git(ctx.backlogDir, 'rev-parse', 'HEAD'), base);
});

test('bl-next stop of an item that does not exist names it', async () => {
  await assert.rejects(stop(backlog(), 'S-99'), { message: 'there is no item S-99 in the backlog' });
});
