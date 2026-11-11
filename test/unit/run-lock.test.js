import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { REPO_ROOT } from '../helpers/run-bl.js';
import { holdLock } from '../helpers/hold-lock.js';
import { mkTempDir } from '../helpers/tempdir.js';
import * as runLock from '../../src/run-lock.js';
import * as backlogCommit from '../../src/backlog-commit.js';
import * as featureRun from '../../src/feature-run.js';
import * as updates from '../../src/updates.js';
import { holderOf } from '../../src/kernel-lock.js';

/** A backlog root of its own for one test. */
const backlog = () => ({ backlogRoot: mkTempDir('bl-run-lock-') });

test('regeneration_marker_uses_RUN_DIR: the marker and every other run path derive from run-lock.js', () => {
  assert.equal(dirname(backlogCommit.PULL_REGEN_PENDING), runLock.RUN_DIR);
  const dir = join(REPO_ROOT, 'src');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    if (file === 'run-lock.js') continue;
    const src = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(src, /['"]\.bl['"],\s*['"]run['"]|['"]\.bl\/run\b/, `${file} restates the run directory`);
  }
});

test('updates_lock_path_contract: the loop and bl updates use run-lock.js’s one definition', () => {
  assert.equal(featureRun.RUN_DIR, runLock.RUN_DIR);
  assert.equal(featureRun.runLockPath, runLock.runLockPath);
  assert.equal(featureRun.ensureRunDir, runLock.ensureRunDir);
  assert.equal(featureRun.acquireRunLock, runLock.acquireRunLock);
  assert.equal(featureRun.releaseRunLock, runLock.releaseRunLock);
  assert.equal(updates.RUN_LOCK_ID, runLock.RUN_LOCK_ID);
  assert.equal(
    runLock.runLockPath({ backlogRoot: '/b' }, runLock.RUN_LOCK_ID),
    join('/b', '.bl', 'run', 'updates.lock'),
  );
});

test('acquireRunLock refuses a run lock this process already holds, naming process.pid', () => {
  const config = backlog();
  const lock = runLock.acquireRunLock(config, 'F-1');
  assert.ok(lock.taken, 'the first take holds the lock');
  try {
    assert.deepEqual(runLock.acquireRunLock(config, 'F-1'), { holder: process.pid });
    assert.equal(holderOf(runLock.runLockPath(config, 'F-1')), process.pid, 'the refusal leaves the lock held');
  } finally {
    runLock.releaseRunLock(lock.taken);
  }
});

test('acquireRunLock refuses a run lock another holder has, naming its PID', () => {
  const config = backlog();
  runLock.ensureRunDir(config);
  const other = holdLock(runLock.runLockPath(config, 'F-1'));
  try {
    assert.deepEqual(runLock.acquireRunLock(config, 'F-1'), { holder: process.pid });
  } finally {
    other.release();
  }
  const lock = runLock.acquireRunLock(config, 'F-1');
  assert.ok(lock.taken, 'a released lock is taken at once');
  runLock.releaseRunLock(lock.taken);
});

test('releaseRunLock frees the run lock and keeps its file (F-104 D3)', () => {
  const config = backlog();
  const path = runLock.runLockPath(config, 'F-1');
  const lock = runLock.acquireRunLock(config, 'F-1');
  assert.match(readFileSync(path, 'utf8'), new RegExp(`^${process.pid}\\n.*\\nbl run F-1\\n$`));
  runLock.releaseRunLock(lock.taken);
  assert.equal(holderOf(path), null);
  assert.ok(existsSync(path), 'the lock file stays');
});

test('updatesLockRefusal names the holder and the updates lock', () => {
  const config = { backlogRoot: '/b' };
  assert.equal(
    runLock.updatesLockRefusal(config, 42),
    `another bl updates command (pid 42) holds ${join('/b', '.bl', 'run', 'updates.lock')}; try again when it ends`,
  );
});
