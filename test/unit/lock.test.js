import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { acquireLock, LOCK_FILE, releaseLock, withLock } from '../../src/lock.js';
import { mkTempDir } from '../helpers/tempdir.js';

function mkBacklogRoot() {
  const dir = mkTempDir('bl-lock-');
  return {
    dir,
    lockPath: join(dir, LOCK_FILE),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('acquireLock creates a lock for the current process and releaseLock removes it', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    const now = () => new Date('2026-01-01T00:00:00.000Z');

    await acquireLock(dir, { now });

    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-01T00:00:00.000Z\n`);

    releaseLock(dir);
    assert.equal(existsSync(lockPath), false);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock removes a stale lock and reacquires it', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    writeFileSync(lockPath, '999999\n2026-01-01T00:00:00.000Z\n');
    const killCalls = [];
    const kill = (pid, signal) => {
      killCalls.push([pid, signal]);
      const err = new Error('No such process');
      err.code = 'ESRCH';
      throw err;
    };

    await acquireLock(dir, {
      kill,
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      error: (message) => {
        throw new Error(`reclaiming a stale lock is silent: ${message}`);
      },
    });

    assert.deepEqual(killCalls, [[999999, 0]]);
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-02T00:00:00.000Z\n`);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock keeps a live lock and exits after the configured timeout', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    const originalContent = '4242\n2026-01-01T00:00:00.000Z\n';
    writeFileSync(lockPath, originalContent);
    const sleeps = [];
    const errors = [];
    const times = [0, 5, 5, 11, 11];

    await assert.rejects(
      acquireLock(dir, {
        kill: () => {},
        now: () => new Date(times.shift() ?? 11),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        timeoutMs: 10,
        pollMs: 2,
        error: (message) => errors.push(message),
        exit: (code) => {
          throw Object.assign(new Error(`exit ${code}`), { code });
        },
      }),
      /exit 1/,
    );

    assert.deepEqual(sleeps, [2]);
    assert.equal(readFileSync(lockPath, 'utf8'), originalContent);
    // The wait is announced once (two polls, one line), then the timeout.
    assert.equal(errors.length, 3, errors.join('\n'));
    assert.match(errors[0], /^Waiting for lock \(\.bl-new\.lock\) held by pid 4242…$/);
    assert.match(errors[1], /Timed out waiting for lock/);
    assert.match(errors[1], /Another bl process may be stuck/);
    assert.match(errors[2], /Remove manually:/);
  } finally {
    cleanup();
  }
});

test('acquireLock is re-entrant: only the outermost release removes the lock', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    await acquireLock(dir);
    // A second acquire by the same process returns at once instead of
    // waiting on its own live PID.
    await acquireLock(dir, {
      sleep: async () => {
        throw new Error('re-entrant acquire must not poll');
      },
    });
    releaseLock(dir);
    assert.equal(existsSync(lockPath), true, 'inner release kept the lock');
    releaseLock(dir);
    assert.equal(existsSync(lockPath), false);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('withLock releases the lock when the callback throws', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    await assert.rejects(
      withLock(dir, async () => {
        assert.equal(existsSync(lockPath), true);
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    cleanup();
  }
});

test('acquireLock treats malformed lock content as reclaimable', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    writeFileSync(lockPath, 'not-a-pid\n2026-01-01T00:00:00.000Z\n');

    await acquireLock(dir, {
      kill: () => {
        throw new Error('kill should not be called for malformed content');
      },
      now: () => new Date('2026-01-03T00:00:00.000Z'),
    });

    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-03T00:00:00.000Z\n`);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});
