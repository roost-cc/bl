import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'os';
import { parse } from 'yaml';
import { itemLockPath } from '../lib/lock.js';
import { build, UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { holdLock, holdLockInChild } from '../test/helpers/hold-lock.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { checkAgainstFlow, readRunState } from './run-state.js';

const ID = 'S-7';

test('readRunState: an active of this host with no lock holder reads interrupted, and as stored while a process holds the lock', async () => {
  const ctx = { backlogDir: mkTempDir('bl-run-state-') };
  const active = { status: 'in_progress', run: 'active: deliver/self_check/test_unit', host: hostname() };
  assert.equal(readRunState(ctx, ID, active), 'interrupted: deliver/self_check/test_unit', 'no lock file');
  assert.equal(readRunState(ctx, ID, { ...active, host: undefined }), 'interrupted: deliver/self_check/test_unit');

  const held = holdLock(itemLockPath(ctx.backlogDir, ID));
  try {
    assert.equal(readRunState(ctx, ID, active), active.run, 'the test process holds the lock');
  } finally {
    held.release();
  }
  assert.equal(readRunState(ctx, ID, active), 'interrupted: deliver/self_check/test_unit', 'released');

  const child = await holdLockInChild(itemLockPath(ctx.backlogDir, ID));
  try {
    assert.equal(readRunState(ctx, ID, active), active.run, 'a live invocation');
    await child.kill();
    assert.equal(readRunState(ctx, ID, active), 'interrupted: deliver/self_check/test_unit', 'once it is gone');
  } finally {
    await child.kill();
  }
});

test('readRunState: an active of another host reads active, and the other run states read as stored, with no lock holder', () => {
  const ctx = { backlogDir: mkTempDir('bl-run-state-') };
  const other = { status: 'in_progress', run: 'active: implement', host: `not-${hostname()}` };
  assert.equal(readRunState(ctx, ID, other), 'active: implement');
  for (const run of ['gated: done', 'gated before: triage', 'waiting: wait_implement', 'idle']) {
    assert.equal(readRunState(ctx, ID, { status: 'merged', run }), run, run);
  }
});

/** The uTop flow set with `story.yaml` changed by `edit`, a function of its value. */
function utopWith(edit) {
  const story = parse(UTOP['story.yaml']);
  edit(story.flows.story);
  return build({ ...UTOP, 'story.yaml': story }, UTOP_STEPS);
}

test('checkAgainstFlow gives no reset for a state of each run-state form that the story flow has', () => {
  const set = build(UTOP, UTOP_STEPS);
  const counters = { self_rounds: { value: 1, threshold: 3 } };
  const states = [
    { status: 'draft', run: 'idle' },
    { status: 'refined', run: 'idle', next: 'implement' },
    { status: 'in_progress', run: 'active: deliver/self_check/test_unit', host: 'running-man', counters },
    { status: 'in_review', run: 'waiting: deliver/self_check/wait_fix' },
    { status: 'implemented', run: 'gated: done', held: { box: 'close', outcome: 'success' } },
    {
      status: 'in_review',
      run: 'gated: ready_for_merge',
      held: { box: 'deliver/peer_review/_return_success', outcome: 'success' },
    },
    { status: 'merged', run: 'gated before: triage' },
  ];
  for (const state of states) assert.equal(checkAgainstFlow(set, 'story', state), null, JSON.stringify(state));
});

test('checkAgainstFlow resets an item whose box is gone to idle, and keeps its status and counters', () => {
  const set = utopWith((flow) => {
    delete flow.steps.close;
    delete flow.entries.close;
  });
  const counters = { rounds: { value: 2 } };
  const note = "no longer in the story flow: the box 'close'";
  for (const state of [
    { status: 'implemented', run: 'active: close', host: 'running-man', counters },
    { status: 'implemented', run: 'waiting: close', counters },
    { status: 'implemented', run: 'gated before: close', counters },
  ]) {
    assert.deepEqual(checkAgainstFlow(set, 'story', state), {
      state: { status: 'implemented', run: 'idle', counters },
      entry: { event: 'reset', run: state.run, status: 'implemented', note },
    });
  }
  assert.deepEqual(checkAgainstFlow(set, 'story', { status: 'implemented', run: 'idle', next: 'close' }), {
    state: { status: 'implemented', run: 'idle' },
    entry: { event: 'reset', run: 'idle', status: 'implemented', note },
  });
  const held = { status: 'implemented', run: 'gated: done', held: { box: 'close', outcome: 'success' } };
  assert.deepEqual(checkAgainstFlow(set, 'story', held), {
    state: { status: 'implemented', run: 'idle' },
    entry: {
      event: 'reset',
      run: 'gated: done',
      status: 'implemented',
      note: "no longer in the story flow: the success arrow of the box 'close'",
    },
  });
});

test('checkAgainstFlow resets an item whose status is gone to the initial status, with from_status', () => {
  const story = UTOP['story.yaml'].replaceAll('superseded', 'withdrawn');
  const set = build({ ...UTOP, 'story.yaml': story }, UTOP_STEPS);
  assert.deepEqual(checkAgainstFlow(set, 'story', { status: 'superseded', run: 'idle', counters: {} }), {
    state: { status: 'draft', run: 'idle', counters: {} },
    entry: {
      event: 'reset',
      run: 'idle',
      status: 'draft',
      from_status: 'superseded',
      note: "no longer in the story flow: the status 'superseded'",
    },
  });
  assert.deepEqual(checkAgainstFlow(set, 'story', { status: 'in_progress', run: 'gated: superseded' }), {
    state: { status: 'in_progress', run: 'idle' },
    entry: {
      event: 'reset',
      run: 'gated: superseded',
      status: 'in_progress',
      note: "no longer in the story flow: the status 'superseded'",
    },
  });
});

test('checkAgainstFlow resets an item whose held arrow no longer sets its to status', () => {
  const set = utopWith((flow) => {
    flow.steps.open_pr.success = 'peer_review';
  });
  const state = { status: 'ready_for_review', run: 'gated: in_review', held: { box: 'open_pr', outcome: 'success' } };
  assert.deepEqual(checkAgainstFlow(set, 'story', state), {
    state: { status: 'ready_for_review', run: 'idle' },
    entry: {
      event: 'reset',
      run: 'gated: in_review',
      status: 'ready_for_review',
      note: "no longer in the story flow: the status 'in_review' on the success arrow of the box 'open_pr'",
    },
  });
  assert.equal(checkAgainstFlow(build(UTOP, UTOP_STEPS), 'story', state), null, 'the fixture sets it');
});
