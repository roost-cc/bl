// `bl stop <id>` (S-1335, F-87 D7a): a run state that is not `running` is
// refused. For a `running` one, the run lock's holder decides what it does.
// No holder: the state is marked stopped. A live holder gets the stop
// request, and `bl stop` waits for the lock to go. It takes no work unit lock
// (F-122 D2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { loadConfig } from '../../src/config.js';
import { loadRunState, newRunState, saveRunState, markStopped } from '../../src/feature-run.js';
import { runLockPath, stopRequestPath } from '../../src/run-lock.js';
import { unitLockPath } from '../../src/unit-lock.js';
import { stopRun } from '../../src/stop.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { holdLock, holdLockInChild } from '../helpers/hold-lock.js';
import { BL_BIN, personEnv } from '../helpers/run-bl.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { spawnToFiles } from '../helpers/spawn-files.js';

function fixture() {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'in_progress' }],
  });
  return { dir, cleanup, config: loadConfig({ backlogRoot: dir }) };
}

/** A run state of F-1 at `step` with `status`, saved. */
function saveState(config, status, step = 'implement') {
  const state = newRunState({ id: 'F-1' }, { branch: 'f1-feat', worktreePath: '/wt', maxRounds: 2 });
  Object.assign(state, { status, step, story: 'S-1' });
  saveRunState(config, state);
  return state;
}

/** Run `stopRun` with its lines collected. */
async function stop(config, opts = {}) {
  const lines = [];
  const code = await stopRun({ config, id: 'F-1', err: (l) => lines.push(l), pollMs: 20, ...opts });
  return { code, lines };
}

/** Resolve once `path` exists. */
async function until(path) {
  while (!existsSync(path)) await delay(10);
}

test('stop_dead_holder: no live holder and a running run state: bl stop marks it stopped and exits 0', async () => {
  const { cleanup, config } = fixture();
  try {
    saveState(config, 'running', 'test');
    const { code, lines } = await stop(config);
    assert.equal(code, 0);
    assert.deepEqual(lines, ['stopped F-1 at test (no live bl held the run); resume: bl run F-1 --resume']);
    const state = loadRunState(config, 'F-1');
    assert.equal(state.status, 'stopped');
    assert.equal(state.step, 'test');
    assert.ok(Number.isFinite(Date.parse(state.stoppedAt)));
    assert.equal(state.history.at(-1).step, 'stopped');
    assert.equal(existsSync(stopRequestPath(config, 'F-1')), false, 'no request: nobody would read it');
  } finally {
    cleanup();
  }
});

test('stop_nothing_running: no run state, or one that is not running, with no holder: exit 1', async () => {
  const { cleanup, config } = fixture();
  try {
    assert.deepEqual(await stop(config), { code: 1, lines: ['no running run for F-1'] });
    for (const status of ['escalated', 'clean', 'stopped']) {
      saveState(config, status);
      assert.deepEqual(await stop(config), { code: 1, lines: ['no running run for F-1'] }, status);
      assert.equal(loadRunState(config, 'F-1').status, status, 'left as it is');
    }
  } finally {
    cleanup();
  }
});

test('stop_not_a_run: a live holder whose run state is not running (bl review, bl merge): exit 1, no request', async () => {
  const { cleanup, config } = fixture();
  const holder = await holdLockInChild(runLockPath(config, 'F-1'));
  try {
    saveState(config, 'reviewed', 'review');
    assert.deepEqual(await stop(config), { code: 1, lines: ['no running run for F-1'] });
    assert.equal(existsSync(stopRequestPath(config, 'F-1')), false, 'the review gets no stop request');
    assert.equal(loadRunState(config, 'F-1').status, 'reviewed', 'left as it is');
  } finally {
    await holder.kill();
    cleanup();
  }
});

test('stop_live_holder: bl stop writes the request and waits; the run stops and frees its lock: exit 0', async () => {
  const { cleanup, config } = fixture();
  const holder = await holdLockInChild(runLockPath(config, 'F-1'));
  try {
    const state = saveState(config, 'running');
    const request = stopRequestPath(config, 'F-1');
    const stopping = stop(config);
    await until(request);
    const written = JSON.parse(readFileSync(request, 'utf8'));
    assert.equal(written.pid, process.pid, "the request names bl stop's own pid");
    assert.ok(Number.isFinite(Date.parse(written.at)));
    // What the loop does at its check: mark stopped, save, delete the request, exit.
    markStopped(state, 'stopped by bl stop at implement');
    saveRunState(config, state);
    await holder.kill();
    assert.deepEqual(await stopping, { code: 0, lines: ['stopped F-1 at implement; resume: bl run F-1 --resume'] });
  } finally {
    await holder.kill();
    cleanup();
  }
});

test('stop_timeout: a run that still holds its lock after the wait: exit 1, the request stays, no signal', async () => {
  const { cleanup, config } = fixture();
  const holder = await holdLockInChild(runLockPath(config, 'F-1'));
  try {
    saveState(config, 'running');
    const { code, lines } = await stop(config, { waitMs: 200 });
    assert.equal(code, 1);
    assert.deepEqual(lines, [`stop requested: F-1 (pid ${holder.pid}) stops at its next check`]);
    assert.ok(existsSync(stopRequestPath(config, 'F-1')), 'the request stays');
    process.kill(holder.pid, 0); // still alive: bl stop sent it no signal
  } finally {
    await holder.kill();
    cleanup();
  }
});

test('stop_unknown_holder: a lock file that names no pid yet says pid unknown', async () => {
  const { cleanup, config } = fixture();
  const lock = runLockPath(config, 'F-1');
  const held = holdLock(lock);
  try {
    writeFileSync(lock, '');
    saveState(config, 'running');
    const { code, lines } = await stop(config, { waitMs: 100 });
    assert.equal(code, 1);
    assert.deepEqual(lines, ['stop requested: F-1 (pid unknown) stops at its next check']);
  } finally {
    held.release();
    cleanup();
  }
});

test('stop_ended_on_its_own: a run that ends before it reads the request: exit 0, the line says so, the request goes', async () => {
  const { cleanup, config } = fixture();
  const holder = await holdLockInChild(runLockPath(config, 'F-1'));
  try {
    const state = saveState(config, 'running', 'pr');
    const request = stopRequestPath(config, 'F-1');
    const stopping = stop(config);
    await until(request);
    state.status = 'escalated';
    saveRunState(config, state);
    await holder.kill();
    assert.deepEqual(await stopping, {
      code: 0,
      lines: ['F-1 ended escalated at pr before it read the stop request'],
    });
    assert.equal(existsSync(request), false);
  } finally {
    await holder.kill();
    cleanup();
  }
});

test('stop_short_command: bl stop goes ahead while another process holds the work unit lock and the run lock', async () => {
  const { dir, cleanup, config } = fixture();
  const unitLock = holdLock(unitLockPath(dir, join(dir, 'features', 'F1-feat')));
  const holder = await holdLockInChild(runLockPath(config, 'F-1'));
  try {
    const state = saveState(config, 'running');
    const request = stopRequestPath(config, 'F-1');
    const env = withNoAgent({ ...personEnv(), BL_BACKLOG_DIR: dir });
    const run = spawnToFiles(BL_BIN, ['stop', 'F-1'], { cwd: dir, env });
    await Promise.race([until(request), run.closed]);
    assert.ok(existsSync(request), `the request is written: ${run.read().stderr}`);
    markStopped(state, 'stopped by bl stop at implement');
    saveRunState(config, state);
    await holder.kill();
    const r = await run.closed;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'stopped F-1 at implement; resume: bl run F-1 --resume\n');
  } finally {
    await holder.kill();
    unitLock.release();
    cleanup();
  }
});
