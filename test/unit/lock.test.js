import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
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
    const deadPid = spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;
    writeFileSync(lockPath, `${deadPid}\n2026-01-01T00:00:00.000Z\n`);

    await acquireLock(dir, {
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      error: (message) => {
        throw new Error(`reclaiming a stale lock is silent: ${message}`);
      },
    });

    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-02T00:00:00.000Z\n`);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock keeps a live lock and exits after the configured timeout', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    // This test process is alive and holds no lock in this module, so it
    // stands in for another live bl process.
    const originalContent = `${process.pid}\n2026-01-01T00:00:00.000Z\n`;
    writeFileSync(lockPath, originalContent);
    const sleeps = [];
    const errors = [];
    const times = [0, 5, 5, 11, 11];

    await assert.rejects(
      acquireLock(dir, {
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
    assert.equal(errors[0], `Waiting for lock (.bl-new.lock) held by pid ${process.pid}…`);
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

test('releaseLock leaves a lock that another process took meanwhile', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    await acquireLock(dir, { now: () => new Date('2026-01-06T00:00:00.000Z') });
    // Another process reclaimed the lock (as if this one had looked dead).
    const other = `${process.ppid}\n2026-01-07T00:00:00.000Z\n`;
    writeFileSync(lockPath, other);

    releaseLock(dir);

    assert.equal(readFileSync(lockPath, 'utf8'), other);
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

    await acquireLock(dir, { now: () => new Date('2026-01-03T00:00:00.000Z') });

    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-03T00:00:00.000Z\n`);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock reclaims an empty lock file', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    // An old bl that died between its create and its pid write leaves this.
    writeFileSync(lockPath, '');

    await acquireLock(dir, { now: () => new Date('2026-01-05T00:00:00.000Z') });

    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-05T00:00:00.000Z\n`);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock never writes the lock name in place', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  // A write to the lock name itself leaves the file empty for a moment, and a
  // second process that reads it then reclaims it as stale (S-1397).
  const write = fs.writeFileSync;
  fs.writeFileSync = (path, ...rest) => {
    if (path === lockPath) throw new Error(`wrote ${LOCK_FILE} in place`);
    return write(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await acquireLock(dir, {
      now: () => new Date('2026-01-04T00:00:00.000Z'),
      timeoutMs: 50,
      pollMs: 1,
      // Today's code would otherwise poll forever: the fixed clock never
      // reaches the timeout.
      sleep: async () => {
        throw new Error('acquiring a free lock must not wait');
      },
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    });

    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-04T00:00:00.000Z\n`);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
    releaseLock(dir);
    cleanup();
  }
});

test('a waiter that polls a live lock leaves no untracked file in the backlog root', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  const git = (...args) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  writeFileSync(join(dir, '.git', 'info', 'exclude'), `${LOCK_FILE}\n`);
  // This live test process stands in for the holder.
  writeFileSync(lockPath, `${process.pid}\n2026-01-01T00:00:00.000Z\n`);
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
  } finally {
    cleanup();
  }
});

test('a poll whose temp file vanished retries and does not throw', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  // A `git clean` in the backlog root removes the temp file between its
  // write and its link.
  const link = fs.linkSync;
  let vanished = 0;
  fs.linkSync = (from, to) => {
    if (to === lockPath && vanished === 0) {
      vanished += 1;
      rmSync(from);
    }
    return link(from, to);
  };
  syncBuiltinESMExports();
  try {
    await acquireLock(dir, {
      now: () => new Date('2026-01-08T00:00:00.000Z'),
      sleep: async () => {
        throw new Error('acquiring a free lock must not wait');
      },
    });

    assert.equal(vanished, 1);
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-08T00:00:00.000Z\n`);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock names an unknown holder and keeps polling', async () => {
  const { dir, lockPath, cleanup } = mkBacklogRoot();
  try {
    const deadPid = spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;
    writeFileSync(lockPath, `${deadPid}\n2026-01-01T00:00:00.000Z\n`);
    // A live reclaimer (this process) holds the reclaim mutex, so no attempt
    // reclaims the stale lock and acquirePidLock gives up with no live holder.
    writeFileSync(`${lockPath}.reclaim`, `${process.pid}\n`);
    const errors = [];
    let polls = 0;

    await acquireLock(dir, {
      now: () => new Date('2026-01-09T00:00:00.000Z'),
      pollMs: 1,
      error: (message) => errors.push(message),
      sleep: async () => {
        polls += 1;
        rmSync(`${lockPath}.reclaim`);
      },
    });

    assert.deepEqual(errors, ['Waiting for lock (.bl-new.lock) held by pid unknown…']);
    assert.equal(polls, 1);
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n2026-01-09T00:00:00.000Z\n`);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('acquireLock throws the create error and holds no lock', async () => {
  const link = fs.linkSync;
  const cases = [
    {
      name: 'missing backlog root',
      error: /ENOENT/,
      fault: (dir) => rmSync(dir, { recursive: true }),
      undo: (dir) => mkdirSync(dir),
    },
    {
      name: 'EPERM from linkSync',
      error: /EPERM/,
      fault: () => {
        fs.linkSync = () => {
          throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
        };
        syncBuiltinESMExports();
      },
      undo: () => {
        fs.linkSync = link;
        syncBuiltinESMExports();
      },
    },
  ];
  for (const { name, error, fault, undo } of cases) {
    const { dir, lockPath, cleanup } = mkBacklogRoot();
    const noWait = {
      sleep: async () => {
        throw new Error(`${name}: the create error must throw, not poll`);
      },
    };
    try {
      fault(dir);
      try {
        await assert.rejects(acquireLock(dir, noWait), error, name);
      } finally {
        undo(dir);
      }

      assert.deepEqual(readdirSync(dir), [], `${name}: no lock and no temp file left`);
      releaseLock(dir);
      // A held entry would make this acquire a re-entrant one that creates no file.
      await acquireLock(dir, noWait);
      assert.equal(existsSync(lockPath), true, `${name}: the next acquire creates the lock`);
    } finally {
      releaseLock(dir);
      cleanup();
    }
  }
});
