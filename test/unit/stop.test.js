// `bl stop <id>` (S-1335, F-87 D7a): a run state that is not `running` is
// refused. For a `running` one, the run lock's holder decides what it does.
// No holder: the state is marked stopped. A live holder gets the stop
// request, and `bl stop` waits for the lock to go. It takes no work unit lock
// (F-122 D2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { basename, dirname, join } from 'path';
import { setTimeout as delay } from 'timers/promises';
import { loadConfig } from '../../src/config.js';
import { loadRunState, newRunState, saveRunState, markStopped } from '../../src/feature-run.js';
import { runLockPath, stopRequestDir, stopRequests, writeStopRequest } from '../../src/run-lock.js';
import { holderOf } from '../../src/kernel-lock.js';
import { unitLockPath } from '../../src/unit-lock.js';
import { markDead, stopRun } from '../../src/stop.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { holdLock, holdLockInChild } from '../helpers/hold-lock.js';
import { BL_BIN, personEnv } from '../helpers/run-bl.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { spawnToFiles } from '../helpers/spawn-files.js';

/** The info line a `bl run F-1` writes in its run lock (`takeRunLocks`). */
const RUN = { info: 'bl run F-1' };

const realWrite = fs.writeFileSync;

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

/** F-1's whole stop requests: `[{ path, request }]`. */
const requests = (config) => stopRequests(config, 'F-1');

/** Resolve with F-1's stop requests once there are `n`. */
async function untilRequests(config, n = 1) {
  while (requests(config).length < n) await delay(10);
  return requests(config);
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
    assert.deepEqual(state.stoppedBy, [process.pid], 'this bl stop stopped it');
    assert.deepEqual(requests(config), [], 'no request: nobody would read it');
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
  const holder = await holdLockInChild(runLockPath(config, 'F-1'), RUN);
  try {
    saveState(config, 'reviewed', 'review');
    assert.deepEqual(await stop(config), { code: 1, lines: ['no running run for F-1'] });
    assert.deepEqual(requests(config), [], 'the review gets no stop request');
    assert.equal(loadRunState(config, 'F-1').status, 'reviewed', 'left as it is');
  } finally {
    await holder.kill();
    cleanup();
  }
});

test('stop_live_holder: bl stop writes the request and waits; the run stops and frees its lock: exit 0', async () => {
  const { cleanup, config } = fixture();
  const holder = await holdLockInChild(runLockPath(config, 'F-1'), RUN);
  try {
    const state = saveState(config, 'running');
    const stopping = stop(config);
    const [{ path, request: written }] = await untilRequests(config);
    assert.equal(dirname(path), stopRequestDir(config, 'F-1'), 'a file of its own in the request directory');
    assert.equal(written.pid, process.pid, "the request names bl stop's own pid");
    assert.equal(written.holder, holder.pid, 'and the run it stops');
    assert.ok(Number.isFinite(Date.parse(written.at)));
    // What the loop does at its check: mark stopped, save, delete the request, exit.
    markStopped(state, 'stopped by bl stop at implement', [process.pid]);
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
  const holder = await holdLockInChild(runLockPath(config, 'F-1'), RUN);
  try {
    saveState(config, 'running');
    const { code, lines } = await stop(config, { waitMs: 200 });
    assert.equal(code, 1);
    assert.deepEqual(lines, [`stop requested: F-1 (pid ${holder.pid}) stops at its next check`]);
    assert.equal(requests(config).length, 1, 'the request stays');
    process.kill(holder.pid, 0); // still alive: bl stop sent it no signal
  } finally {
    await holder.kill();
    cleanup();
  }
});

test('stop_unknown_holder: a lock file that names no pid yet gets no request: exit 1, try again', async () => {
  const { cleanup, config } = fixture();
  const lock = runLockPath(config, 'F-1');
  const held = holdLock(lock);
  try {
    writeFileSync(lock, '');
    saveState(config, 'running');
    const { code, lines } = await stop(config, { waitMs: 100 });
    assert.equal(code, 1);
    assert.deepEqual(lines, ['bl stop: the bl that holds F-1 has not written its pid yet; try again']);
    assert.deepEqual(requests(config), []);
  } finally {
    held.release();
    cleanup();
  }
});

test('stop_ended_on_its_own: a run that ends before it reads the request: exit 0, the line says so, the request goes', async () => {
  const { cleanup, config } = fixture();
  const holder = await holdLockInChild(runLockPath(config, 'F-1'), RUN);
  try {
    const state = saveState(config, 'running', 'pr');
    const stopping = stop(config);
    await untilRequests(config);
    state.status = 'escalated';
    saveRunState(config, state);
    await holder.kill();
    assert.deepEqual(await stopping, {
      code: 0,
      lines: ['F-1 ended escalated at pr before it read the stop request'],
    });
    assert.deepEqual(requests(config), []);
  } finally {
    await holder.kill();
    cleanup();
  }
});

test('stop_short_command: bl stop goes ahead while another process holds the work unit lock and the run lock', async () => {
  const { dir, cleanup, config } = fixture();
  const unitLock = holdLock(unitLockPath(dir, join(dir, 'features', 'F1-feat')));
  const holder = await holdLockInChild(runLockPath(config, 'F-1'), RUN);
  try {
    const state = saveState(config, 'running');
    const env = withNoAgent({ ...personEnv(), BL_BACKLOG_DIR: dir });
    const run = spawnToFiles(BL_BIN, ['stop', 'F-1'], { cwd: dir, env });
    await Promise.race([untilRequests(config), run.closed]);
    assert.equal(requests(config).length, 1, `the request is written: ${run.read().stderr}`);
    markStopped(state, 'stopped by bl stop at implement', [process.pid]);
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

test('stop_targets_the_observed_run_and_rechecks_before_stale_mark', async () => {
  // A live holder that is not a bl run, of a state a dead bl left running: no request, nothing marked.
  for (const info of ['bl review F-1', 'bl merge F-1', 'held by a test child']) {
    const { cleanup, config } = fixture();
    const holder = await holdLockInChild(runLockPath(config, 'F-1'), { info });
    try {
      saveState(config, 'running', 'review');
      assert.deepEqual(
        await stop(config, { waitMs: 100 }),
        { code: 1, lines: [`no running run for F-1: another bl (pid ${holder.pid}) holds it, not a bl run`] },
        info,
      );
      assert.deepEqual(requests(config), [], `${info}: no request`);
      assert.equal(loadRunState(config, 'F-1').status, 'running', `${info}: left as it is`);
    } finally {
      await holder.kill();
      cleanup();
    }
  }

  // The dead-holder mark takes the run lock first: a bl run that took the run after the check is not marked.
  {
    const { cleanup, config } = fixture();
    const holder = await holdLockInChild(runLockPath(config, 'F-1'), RUN);
    try {
      saveState(config, 'running');
      const lines = [];
      assert.equal(
        markDead(config, 'F-1', (l) => lines.push(l)),
        1,
      );
      assert.deepEqual(lines, [`bl stop: another bl (pid ${holder.pid}) took F-1 just now; nothing stopped`]);
      assert.equal(loadRunState(config, 'F-1').status, 'running');
    } finally {
      await holder.kill();
      cleanup();
    }
  }

  // Under the lock it reads the state again: one that ended after the check is left as it is.
  {
    const { cleanup, config } = fixture();
    try {
      saveState(config, 'clean');
      const lines = [];
      assert.equal(
        markDead(config, 'F-1', (l) => lines.push(l)),
        1,
      );
      assert.deepEqual(lines, ['no running run for F-1']);
      assert.equal(loadRunState(config, 'F-1').status, 'clean');
      assert.equal(holderOf(runLockPath(config, 'F-1')), null, 'the run lock is free again');
    } finally {
      cleanup();
    }
  }
});

test('stop_cleanup_preserves_newer_request: a bl stop whose run ended on its own deletes only its own request', async () => {
  // Another bl stop's request, for a later holder or for the same one.
  for (const otherHolder of [2, process.pid]) {
    const { cleanup, config } = fixture();
    const held = holdLock(runLockPath(config, 'F-1'), RUN.info);
    try {
      const state = saveState(config, 'running', 'pr');
      const stopping = stop(config);
      const [mine] = await untilRequests(config);
      const other = writeStopRequest(config, 'F-1', otherHolder);
      state.status = 'escalated';
      saveRunState(config, state);
      held.release();
      assert.equal((await stopping).code, 0);
      assert.equal(existsSync(mine.path), false, `${otherHolder}: its own request goes`);
      assert.deepEqual(
        requests(config).map((r) => r.path),
        [other],
        `${otherHolder}: the other stays`,
      );
    } finally {
      held.release();
      cleanup();
    }
  }
});

test('stop_concurrent_failed_write_preserves_request: a bl stop whose write fails leaves every other request whole', async () => {
  const { cleanup, config } = fixture();
  const held = holdLock(runLockPath(config, 'F-1'), RUN.info);
  const dir = stopRequestDir(config, 'F-1');
  try {
    const state = saveState(config, 'running');
    const first = stop(config);
    const [before] = await untilRequests(config);
    const kept = readFileSync(before.path, 'utf8');
    // The second bl stop's write fails half way.
    fs.writeFileSync = (path, data, ...rest) => {
      if (dirname(String(path)) !== dir) return realWrite(path, data, ...rest);
      realWrite(path, String(data).slice(0, 7), ...rest);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    syncBuiltinESMExports();
    let second;
    try {
      second = await stop(config, { waitMs: 100 });
    } finally {
      fs.writeFileSync = realWrite;
      syncBuiltinESMExports();
    }
    assert.deepEqual(second, {
      code: 1,
      lines: ['bl stop: cannot write the stop request: ENOSPC: no space left on device; nothing stopped'],
    });
    assert.deepEqual(readdirSync(dir), [basename(before.path)], 'no half-written file of the second');
    assert.equal(readFileSync(before.path, 'utf8'), kept, 'the first request is whole');
    markStopped(state, 'stopped by bl stop at implement', [process.pid]);
    saveRunState(config, state);
    held.release();
    assert.deepEqual(await first, { code: 0, lines: ['stopped F-1 at implement; resume: bl run F-1 --resume'] });
  } finally {
    held.release();
    cleanup();
  }
});
