import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { awaitLock, LockWaitTimeout, waitingForLock } from '../../src/lock-wait.js';
import { acquireLock, LOCK_FILE } from '../../src/lock.js';
import { mainSyncLockPath, withMainSyncLock } from '../../src/main-sync.js';
import { SpecLockError, specLockPath, withSpecLock } from '../../src/spec-file.js';
import { mkTempDir } from '../helpers/tempdir.js';

/** A `take` that finds `holders` in turn (one per try), then takes the lock as `value`. */
function takeAfter(holders, value = 'mine') {
  const left = [...holders];
  const tries = { count: 0 };
  const take = () => {
    tries.count += 1;
    return left.length > 0 ? { holder: left.shift() } : { taken: value };
  };
  return { take, tries };
}

const noSleep = async () => {
  throw new Error('a free lock must not wait');
};

test('awaitLock takes a free lock at once, with no announcement and no sleep', async () => {
  const { take, tries } = takeAfter([]);
  const said = [];
  const got = await awaitLock('x.lock', take, {
    deadlineMs: 1000,
    pollMs: 5,
    announce: (l) => said.push(l),
    sleep: noSleep,
  });
  assert.equal(got, 'mine');
  assert.equal(tries.count, 1);
  assert.deepEqual(said, []);
});

test('awaitLock takes the lock after its holder ends, announcing the wait once', async () => {
  const { take, tries } = takeAfter([41, 41, 41]);
  const said = [];
  const sleeps = [];
  const got = await awaitLock('x.lock', take, {
    deadlineMs: 60_000,
    pollMs: 7,
    announce: (l) => said.push(l),
    sleep: async (ms) => void sleeps.push(ms),
  });
  assert.equal(got, 'mine');
  assert.equal(tries.count, 4);
  assert.deepEqual(sleeps, [7, 7, 7]);
  assert.deepEqual(said, [waitingForLock('x.lock', 41)]);
  assert.equal(said[0], 'Waiting for lock (x.lock) held by pid 41…');
});

test('awaitLock rejects with a LockWaitTimeout naming the lock and the holder', async () => {
  const { take } = takeAfter(Array(100).fill(42));
  const said = [];
  const sleeps = [];
  const err = await awaitLock('x.lock', take, {
    deadlineMs: 50,
    pollMs: 3,
    announce: (l) => said.push(l),
    // A real wait past the deadline, so the second try is the last.
    sleep: async (ms) => {
      sleeps.push(ms);
      await delay(80);
    },
  }).catch((e) => e);
  assert.ok(err instanceof LockWaitTimeout, String(err));
  assert.equal(err.lock, 'x.lock');
  assert.equal(err.holder, 42);
  assert.match(err.message, /x\.lock/);
  assert.match(err.message, /pid 42/);
  assert.doesNotMatch(err.message, /\brm\b|remove/i, 'the message never tells anyone to remove the file');
  assert.deepEqual(sleeps, [3]);
  assert.equal(said.length, 1);
});

test('awaitLock sleeps at most the time left to the deadline', async () => {
  for (const { deadlineMs, pollMs } of [
    { deadlineMs: 100, pollMs: 2000 },
    { deadlineMs: 100, pollMs: 60 },
    { deadlineMs: 30, pollMs: 31 },
  ]) {
    const sleeps = [];
    const start = Date.now();
    const err = await awaitLock('x.lock', () => ({ holder: 42 }), {
      deadlineMs,
      pollMs,
      announce: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
        await delay(ms);
      },
    }).catch((e) => e);
    const label = `deadline ${deadlineMs}, poll ${pollMs}`;
    assert.ok(err instanceof LockWaitTimeout, `${label}: ${err}`);
    assert.ok(sleeps.length > 0, `${label}: it slept`);
    for (const ms of sleeps) assert.ok(ms > 0 && ms <= Math.min(pollMs, deadlineMs), `${label}: slept ${ms} ms`);
    assert.ok(Date.now() - start < deadlineMs + 500, `${label}: took ${Date.now() - start} ms`);
  }
});

test('every lock wait with a live holder gives up near its deadline, not after a full poll', async () => {
  const repo = mkTempDir('bl-lock-wait-');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const holderContent = `${process.pid}\n${new Date().toISOString()}\nheld by the test\n`;
  const spec = join(repo, 'index.md');
  writeFileSync(spec, '---\na: 1\n---\nbody\n');
  const cases = [
    {
      name: 'backlog lock (acquireLock)',
      lockPath: join(repo, LOCK_FILE),
      wait: async () => {
        const exits = [];
        await acquireLock(repo, { timeoutMs: 100, pollMs: 2000, exit: (c) => exits.push(c), error: () => {} });
        return exits[0] === 1;
      },
    },
    {
      name: 'main-sync lock (withMainSyncLock)',
      lockPath: mainSyncLockPath(repo),
      wait: async () =>
        (await withMainSyncLock(repo, () => 'ran', { lockTimeoutMs: 100, pollMs: 2000 })).state === 'lock-timeout',
    },
    {
      name: 'spec lock (withSpecLock, fixed 10 ms poll)',
      lockPath: specLockPath(spec),
      wait: async () =>
        (await withSpecLock(spec, () => 'ran', { waitMs: 100 }).catch((e) => e)) instanceof SpecLockError,
    },
  ];
  for (const c of cases) {
    writeFileSync(c.lockPath, holderContent);
    try {
      const start = Date.now();
      assert.ok(await c.wait(), `${c.name}: timed out`);
      const ms = Date.now() - start;
      assert.ok(ms < 1000, `${c.name}: took ${ms} ms`);
    } finally {
      rmSync(c.lockPath, { force: true });
    }
  }
});

test('awaitLock with a deadline of 0 tries once, announces, and rejects with no sleep', async () => {
  const { take, tries } = takeAfter([44]);
  const said = [];
  const err = await awaitLock('x.lock', take, {
    deadlineMs: 0,
    pollMs: 5,
    announce: (l) => said.push(l),
    sleep: noSleep,
  }).catch((e) => e);
  assert.ok(err instanceof LockWaitTimeout, String(err));
  assert.equal(err.holder, 44);
  assert.equal(tries.count, 1);
  assert.deepEqual(said, [waitingForLock('x.lock', 44)]);
});

test('awaitLock with no deadline keeps waiting until the lock frees', async () => {
  const { take, tries } = takeAfter(Array(500).fill('unknown'));
  const said = [];
  const got = await awaitLock('x.lock', take, {
    deadlineMs: null,
    pollMs: 1,
    announce: (l) => said.push(l),
    sleep: async () => {},
  });
  assert.equal(got, 'mine');
  assert.equal(tries.count, 501);
  assert.deepEqual(said, ['Waiting for lock (x.lock) held by pid unknown…']);
});

test('awaitLock passes an error from take through and does not wait', async () => {
  const boom = new Error('EPERM');
  await assert.rejects(
    awaitLock(
      'x.lock',
      () => {
        throw boom;
      },
      { deadlineMs: 1000, pollMs: 1, announce: () => {}, sleep: noSleep },
    ),
    (e) => e === boom,
  );
});

test('awaitLock awaits a timer by default, so the event loop runs while it waits', async () => {
  let held = true;
  let ticks = 0;
  const ticker = setInterval(() => (ticks += 1), 1);
  setTimeout(() => (held = false), 40);
  try {
    await awaitLock('x.lock', () => (held ? { holder: 43 } : { taken: true }), {
      deadlineMs: 5000,
      pollMs: 5,
      announce: () => {},
    });
  } finally {
    clearInterval(ticker);
  }
  assert.ok(ticks > 0, 'the interval ran during the wait');
});
