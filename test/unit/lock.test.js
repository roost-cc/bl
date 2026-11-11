import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs, { existsSync, openSync, closeSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { join } from 'path';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { holderOf } from '../../src/kernel-lock.js';
import { acquireLock, LOCK_FD_ENV, LOCK_FILE, releaseLock, withLock } from '../../src/lock.js';
import { holdLock } from '../helpers/hold-lock.js';
import { mkTempDir } from '../helpers/tempdir.js';

function mkBacklogRoot() {
  const dir = mkTempDir('bl-lock-');
  return {
    dir,
    lockPath: join(dir, LOCK_FILE),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** The lock file's lines, checked to name this process and a time (D4). */
function assertOurs(lockPath) {
  const [pid, at, end] = readFileSync(lockPath, 'utf8').split('\n');
  assert.equal(Number(pid), process.pid);
  assert.match(at, STAMP);
  assert.equal(end, '');
}

test('acquireLock takes the lock for this process, and releaseLock frees it and keeps the file', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    const handle = await acquireLock(dir);
    assert.equal(handle.path, lockPath);
    assertOurs(lockPath);
    assert.equal(holderOf(lockPath), process.pid);

    releaseLock(dir);
    assert.equal(holderOf(lockPath), null);
    assert.equal(existsSync(lockPath), true, 'the lock file stays (D3)');
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock takes at once, and silently, a lock file that nobody holds, whatever it holds', async () => {
  const deadPid = spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;
  for (const [name, content] of [
    ['a dead holder’s PID', `${deadPid}\n2026-01-01T00:00:00.000Z\n`],
    ['a live process’s PID', `${process.ppid}\n2026-01-01T00:00:00.000Z\n`],
    ['malformed content', 'not-a-pid\n2026-01-01T00:00:00.000Z\n'],
    ['an empty file', ''],
  ]) {
    const { dir, lockPath, cleanup } = mkBacklogRoot();
    try {
      writeFileSync(lockPath, content);
      await acquireLock(dir, {
        error: (message) => {
          throw new Error(`${name}: taking a free lock is silent: ${message}`);
        },
        sleep: async () => {
          throw new Error(`${name}: taking a free lock must not wait`);
        },
      });
      assertOurs(lockPath);
    } finally {
      releaseLock(dir);
      cleanup();
    }
  }
});

test('acquireLock keeps a held lock and exits after the configured timeout', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  // This test process holds the lock on a descriptor of its own, so it
  // stands in for another live bl process.
  const holder = holdLock(lockPath);
  try {
    const sleeps = [];
    const errors = [];

    await assert.rejects(
      acquireLock(dir, {
        // A real wait past the timeout, so the second poll is the last.
        sleep: async (ms) => {
          sleeps.push(ms);
          await new Promise((resolve) => setTimeout(resolve, 80));
        },
        timeoutMs: 50,
        pollMs: 2,
        error: (message) => errors.push(message),
        exit: (code) => {
          throw Object.assign(new Error(`exit ${code}`), { code });
        },
      }),
      /exit 1/,
    );

    assert.deepEqual(sleeps, [2]);
    assert.equal(readFileSync(lockPath, 'utf8'), holder.content);
    // The wait is announced once (two polls, one line), then the timeout,
    // which names the holder and never tells anyone to remove the file.
    assert.deepEqual(errors, [
      `Waiting for lock (.bl-new.lock) held by pid ${process.pid}…`,
      `Timed out after 50 ms waiting for lock (.bl-new.lock) held by pid ${process.pid}.`,
    ]);
  } finally {
    holder.release();
    cleanup();
  }
});

test('acquireLock is re-entrant: only the outermost release frees the lock', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    const outer = await acquireLock(dir);
    // A second acquire by the same process returns at once instead of
    // waiting for itself.
    const inner = await acquireLock(dir, {
      sleep: async () => {
        throw new Error('re-entrant acquire must not poll');
      },
    });
    assert.equal(inner, outer);
    releaseLock(dir);
    assert.equal(holderOf(lockPath), process.pid, 'inner release kept the lock');
    releaseLock(dir);
    assert.equal(holderOf(lockPath), null);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('withLock passes the handle and releases the lock when the callback throws', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    await assert.rejects(
      withLock(dir, async (handle) => {
        assert.equal(handle.path, lockPath);
        assert.equal(holderOf(lockPath), process.pid);
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(holderOf(lockPath), null);
  } finally {
    cleanup();
  }
});

test('a waiter that polls a held lock writes nothing in the backlog root', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  const git = (...args) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  writeFileSync(join(dir, '.git', 'info', 'exclude'), `${LOCK_FILE}\n`);
  const holder = holdLock(lockPath);
  // A file the waiter writes in the backlog root, even for a moment, is one
  // that the holder's `git status` (migration-txn.js) lists or its `git clean`
  // removes under the waiter.
  const write = fs.writeFileSync;
  const writes = [];
  fs.writeFileSync = (path, ...rest) => {
    if (String(path).startsWith(dir)) writes.push(String(path));
    return write(path, ...rest);
  };
  syncBuiltinESMExports();
  const statuses = [];
  try {
    await assert.rejects(
      acquireLock(dir, {
        pollMs: 1,
        error: () => {},
        sleep: async () => {
          statuses.push(git('status', '--porcelain', '--untracked-files=all').stdout);
          if (statuses.length === 5) throw new Error('stop polling');
        },
      }),
      /stop polling/,
    );
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
  try {
    assert.deepEqual(writes, []);
    assert.deepEqual(statuses, ['', '', '', '', '']);
    assert.deepEqual(readdirSync(dir).sort(), ['.bl-new.lock', '.git']);
    assert.equal(readFileSync(lockPath, 'utf8'), holder.content, 'the waiter never truncated it');
  } finally {
    holder.release();
    cleanup();
  }
});

test('acquireLock names a holder that has not written its PID yet as unknown, and keeps polling', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  const holder = holdLock(lockPath);
  writeFileSync(lockPath, '');
  try {
    const errors = [];
    let polls = 0;

    await acquireLock(dir, {
      pollMs: 1,
      error: (message) => errors.push(message),
      sleep: async () => {
        polls += 1;
        holder.release();
      },
    });

    assert.deepEqual(errors, ['Waiting for lock (.bl-new.lock) held by pid unknown…']);
    assert.equal(polls, 1);
    assertOurs(lockPath);
  } finally {
    holder.release();
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock throws the open error for a missing backlog root and holds no lock', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  const noWait = {
    sleep: async () => {
      throw new Error('the open error must throw, not poll');
    },
  };
  try {
    rmSync(dir, { recursive: true });
    await assert.rejects(acquireLock(dir, noWait), /ENOENT/);
    fs.mkdirSync(dir);
    assert.deepEqual(readdirSync(dir), [], 'nothing left');
    await acquireLock(dir, noWait);
    assert.equal(holderOf(lockPath), process.pid, 'the next acquire takes the lock');
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('lock.js registers no exit or signal handler (D3)', () => {
  const r = spawnSyncFiles(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const before = ['exit', 'SIGINT', 'SIGTERM'].map((e) => process.listenerCount(e));
       await import(${JSON.stringify(new URL('../../src/lock.js', import.meta.url).href)});
       const after = ['exit', 'SIGINT', 'SIGTERM'].map((e) => process.listenerCount(e));
       process.stdout.write(JSON.stringify({ before, after }));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const { before, after } = JSON.parse(r.stdout);
  assert.deepEqual(after, before);
});

test(`a bl child given the parent's locked descriptor in ${LOCK_FD_ENV} takes the lock at once (D5)`, async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    const parent = await acquireLock(dir);
    const child = (env, stdio) =>
      spawnSyncFiles(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { acquireLock, releaseLock } from ${JSON.stringify(new URL('../../src/lock.js', import.meta.url).href)};
           const said = [];
           const opts = { timeoutMs: 0, error: (l) => said.push(l), exit: (c) => said.push('exit ' + c) };
           await acquireLock(process.argv[1], opts);
           await acquireLock(process.argv[1], opts);
           releaseLock(process.argv[1]);
           releaseLock(process.argv[1]);
           process.stdout.write(JSON.stringify(said));`,
          dir,
        ],
        { encoding: 'utf8', env: { ...process.env, ...env }, stdio },
      );

    const inherited = child({ [LOCK_FD_ENV]: '3' }, ['ignore', 'pipe', 'pipe', parent.fd]);
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.deepEqual(JSON.parse(inherited.stdout), [], 'no wait and no timeout');
    assert.equal(holderOf(lockPath), process.pid, "the child's releases leave the parent's lock held");

    // Without the descriptor the child is just another process, and waits.
    const other = openSync(join(dir, 'unrelated'), 'w');
    try {
      const refused = child({ [LOCK_FD_ENV]: '3' }, ['ignore', 'pipe', 'pipe', other]);
      assert.equal(refused.status, 0, refused.stderr);
      const timedOut = [
        `Waiting for lock (.bl-new.lock) held by pid ${process.pid}…`,
        `Timed out after 0 ms waiting for lock (.bl-new.lock) held by pid ${process.pid}.`,
        'exit 1',
      ];
      // Each of its two acquires times out.
      assert.deepEqual(JSON.parse(refused.stdout), [...timedOut, ...timedOut]);
      // A descriptor open on the lock file but not holding its lock is not the lock.
      const unlocked = openSync(lockPath, 'r+');
      try {
        const waited = child({ [LOCK_FD_ENV]: '3' }, ['ignore', 'pipe', 'pipe', unlocked]);
        assert.equal(waited.status, 0, waited.stderr);
        assert.deepEqual(JSON.parse(waited.stdout), [...timedOut, ...timedOut], 'an unlocked descriptor');
      } finally {
        closeSync(unlocked);
      }
    } finally {
      closeSync(other);
    }
  } finally {
    releaseLock(dir);
    cleanup();
  }
});
