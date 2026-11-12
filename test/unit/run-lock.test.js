import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { dirname, join } from 'path';
import { REPO_ROOT } from '../helpers/run-bl.js';
import { holdLock } from '../helpers/hold-lock.js';
import { mkTempDir } from '../helpers/tempdir.js';
import * as runLock from '../../src/run-lock.js';
import * as backlogCommit from '../../src/backlog-commit.js';
import * as featureRun from '../../src/feature-run.js';
import * as updates from '../../src/updates.js';
import { holderOf } from '../../src/kernel-lock.js';

const realRead = fs.readFileSync;

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

test('run_holder_reads_one_holder: the pid and the info line come from one read, never from two holders', () => {
  const review = `${process.pid}\n2026-11-11T00:00:00Z\nbl review F-1\n`;
  const run = '999999\n2026-11-11T00:00:01Z\nbl run F-1\n';
  const cases = [
    { first: review, then: run, want: { pid: process.pid, run: false } },
    { first: run, then: review, want: { pid: 999999, run: true } },
    { first: run, then: '', want: { pid: 999999, run: true } },
    { first: '', then: run, want: { pid: 'unknown', run: false } },
  ];
  for (const own of [false, true]) {
    for (const { first, then, want } of cases) {
      const config = backlog();
      runLock.ensureRunDir(config);
      const path = runLock.runLockPath(config, 'F-1');
      const lock = own ? runLock.acquireRunLock(config, 'F-1') : null;
      const other = own ? null : holdLock(path);
      writeFileSync(path, first);
      let reads = 0;
      fs.readFileSync = (name, ...args) => {
        const value = realRead(name, ...args);
        // Another holder writes its own lines just after the first read.
        if (name === path && ++reads === 1) writeFileSync(path, then);
        return value;
      };
      syncBuiltinESMExports();
      try {
        const got = runLock.runHolder(config, 'F-1');
        const label = `${own ? 'own' : 'other'} ${JSON.stringify(first)} then ${JSON.stringify(then)}`;
        assert.deepEqual(got, own ? { ...want, pid: process.pid } : want, label);
        assert.equal(reads, 1, `${label}: one read`);
      } finally {
        fs.readFileSync = realRead;
        syncBuiltinESMExports();
        if (lock) runLock.releaseRunLock(lock.taken);
        other?.release();
      }
    }
  }
});

test('updatesLockRefusal names the holder and the updates lock', () => {
  const config = { backlogRoot: '/b' };
  assert.equal(
    runLock.updatesLockRefusal(config, 42),
    `another bl updates command (pid 42) holds ${join('/b', '.bl', 'run', 'updates.lock')}; try again when it ends`,
  );
});
