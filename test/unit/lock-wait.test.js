import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { awaitLock, LockWaitTimeout, waitingForLock } from '../../src/lock-wait.js';

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
