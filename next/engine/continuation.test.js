// wayOn (F-152 D2): where an invocation goes on from a stored run state, on the uTop story flow,
// one test per row of D2's table and one for the refusal of another host's active item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'os';
import { release, tryLockOnce } from '../lib/kernel-lock.js';
import { ensureLockDir, itemLockPath } from '../lib/lock.js';
import { itemDir } from '../store/items.js';
import { createItems, engineBacklog, setGraph } from '../test/helpers/engine-backlog.js';
import { git } from '../test/helpers/git.js';
import { wayOn } from './continuation.js';

/** An `outcome` log entry for `box`. */
const outcome = (box, value = 'success') => ({ event: 'outcome', box, outcome: value });

/** A story with `state`, its item, and wayOn of it after the last log entry `last`. */
async function way(ctx, state, last = undefined) {
  const [id] = await createItems(ctx, [{ type: 'story', state }]);
  return wayOn(ctx, itemDir(ctx, id), state, last);
}

test('interrupted: <box> starts at the box, and a last outcome entry for the box is followed there (D-51)', async () => {
  const ctx = engineBacklog();
  const state = { status: 'implemented', run: 'active: close', host: hostname() };
  assert.deepEqual(await way(ctx, state), { start: 'close' });
  assert.deepEqual(await way(ctx, state, outcome('close')), { start: 'close', outcome: 'success' });
  assert.deepEqual(await way(ctx, state, outcome('implement')), { start: 'close' }, 'an outcome of another box');
  assert.deepEqual(await way(ctx, { ...state, host: undefined }), { start: 'close' }, 'an active with no host');
});

test('a stored active of this host reads interrupted while the caller holds the item lock', async () => {
  const ctx = engineBacklog();
  const state = { status: 'implemented', run: 'active: close', host: hostname() };
  const [id] = await createItems(ctx, [{ type: 'story', state }]);
  ensureLockDir(ctx.backlogDir);
  const lock = tryLockOnce(itemLockPath(ctx.backlogDir, id), 'the test');
  assert.ok('taken' in lock);
  try {
    assert.deepEqual(await wayOn(ctx, itemDir(ctx, id), state, undefined), { start: 'close' });
  } finally {
    release(lock.taken);
  }
});

test('waiting: <box> follows a last outcome entry for the box, and with none is held with no failing entry', async () => {
  const ctx = engineBacklog();
  const state = { status: 'in_progress', run: 'waiting: wait_implement' };
  assert.deepEqual(await way(ctx, state, outcome('wait_implement', 'failure')), {
    start: 'wait_implement',
    outcome: 'failure',
  });
  assert.deepEqual(await way(ctx, state), { held: [] });
  assert.deepEqual(await way(ctx, state, outcome('implement')), { held: [] }, 'an outcome of another box');
});

test('gated: <to> follows the held arrow when the gate of to passes or the status left its from, and else is held', async () => {
  const gated = { run: 'gated: done', held: { box: 'close', outcome: 'success' } };
  /** wayOn of a story with `status`, gated at done, with an open task child when `task`. */
  const gatedWay = async (status, task) => {
    const ctx = engineBacklog();
    const [id] = await createItems(ctx, [
      { type: 'story', state: { status, ...gated } },
      { type: 'task', state: { status: 'draft', run: 'idle' } },
    ]);
    if (task) await setGraph(ctx, 'containment', { 'T-1': { parent: id } });
    return wayOn(ctx, itemDir(ctx, id), { status, ...gated }, undefined);
  };
  const held = { start: 'close', outcome: 'success' };
  assert.deepEqual(await gatedWay('implemented', false), held, 'the gate passes');
  const gate = 'children("task").all(c, c.closed)';
  assert.deepEqual(await gatedWay('implemented', true), {
    held: [{ entry: { condition: gate, class: 'expected' }, text: gate }],
  });
  // close's success arrow sets done only from implemented: the runner drops the held transition.
  assert.deepEqual(await gatedWay('draft', true), held, 'the status left the arrow from');
});

test('gated before: <box> starts the box when its step gate passes, with every entry gate, and else is held', async () => {
  const gates = (condition) => engineBacklog({ 'gates.yaml': `step_gates:\n  close: ['${condition}']\n` });
  const state = { status: 'implemented', run: 'gated before: close' };
  assert.deepEqual(await way(gates('status == "implemented"'), state), { start: 'close' });
  const gate = 'status == "merged"';
  assert.deepEqual(await way(gates(gate), state), { held: [{ entry: gate, text: gate }] });

  // A subflow's entry gate counts at its first node: previous is null (F-139 Decision A4).
  const entry = engineBacklog({ 'gates.yaml': "step_gates:\n  self_check: ['false']\n" });
  assert.deepEqual(await way(entry, { status: 'in_review', run: 'gated before: deliver/self_check/test_unit' }), {
    held: [{ entry: 'false', text: 'false' }],
  });
});

test('idle starts at next, and with no next gives the entries whose from holds the status', async () => {
  const ctx = engineBacklog();
  assert.deepEqual(await way(ctx, { status: 'in_progress', run: 'idle', next: 'implement' }), { start: 'implement' });
  assert.deepEqual(await way(ctx, { status: 'refined', run: 'idle' }), {
    entries: ['refine', 'run', 'implement', 'supersede'],
  });
  assert.deepEqual(await way(ctx, { status: 'done', run: 'idle' }), { entries: [] });
});

test('active on another host is refused, names that host, and writes nothing (D-4)', async () => {
  const ctx = engineBacklog();
  const state = { status: 'implemented', run: 'active: close', host: 'elsewhere' };
  const [id] = await createItems(ctx, [{ type: 'story', state }]);
  const base = git(ctx.backlogDir, 'rev-parse', 'HEAD');
  await assert.rejects(wayOn(ctx, itemDir(ctx, id), state, outcome('close')), {
    message: `${id}: active at close on the host elsewhere; only bl on that host can resume it, and if that host is gone for good, move the item with bl force`,
  });
  assert.equal(git(ctx.backlogDir, 'rev-parse', 'HEAD'), base);
});

test('a force entry after an outcome entry makes the outcome unused (D-613)', async () => {
  const ctx = engineBacklog();
  const state = { status: 'implemented', run: 'active: close', host: hostname() };
  const force = { event: 'force', path: '/counters/rounds/threshold', from: 3, to: 6, status: 'implemented' };
  assert.deepEqual(await way(ctx, state, force), { start: 'close' });
});
