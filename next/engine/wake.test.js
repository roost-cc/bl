// waitForWake (F-152 D3): the reflog, SIGUSR2, the timer and the capacity reset, each removed
// before it resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fixtureText } from '../test/helpers/config-fixture.js';
import { engineBacklog } from '../test/helpers/engine-backlog.js';
import { withEnv } from '../test/helpers/env.js';
import { git } from '../test/helpers/git.js';
import { replayEnv } from '../test/helpers/replay.js';
import { sendUsr2 } from '../test/helpers/sigusr2.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { BURST_MS, waitForWake } from './wake.js';

/** A replay script with the top-level `capacity` text `capacity`. */
function capacityScript(/** @type {string} */ capacity) {
  const path = join(mkTempDir('bl-wake-script-'), 'script.yaml');
  writeFileSync(path, `capacity: ${capacity}\nentries: []\n`);
  return path;
}

/** The ISO time `ms` from now. */
const inMs = (/** @type {number} */ ms) => new Date(Date.now() + ms).toISOString();

/**
 * A backlog whose agent profiles `soon`, `later` and `never` are replay profiles with no
 * capacity: `soon` resets in 300 ms, `later` in 5 s, and `never` gives `resets_at: null`; and
 * `free`, which has capacity. With `minutes`, the flow set's gate_recheck_minutes; with
 * `more`, more lines of config/agents.yaml.
 */
function backlog(minutes = 15, more = []) {
  const profile = (/** @type {string} */ name, /** @type {string} */ capacity) =>
    `${name}: { adapter: replay, env: { REPLAY_SCRIPT: '${capacityScript(capacity)}' } }`;
  const agents = [
    fixtureText('agents.yaml'),
    profile('soon', `{ available: false, resets_at: '${inMs(300)}' }`),
    profile('later', `{ available: false, resets_at: '${inMs(5000)}' }`),
    profile('never', '{ available: false, resets_at: null }'),
    profile('free', `{ available: true, resets_at: '${inMs(100)}' }`),
    ...more,
    '',
  ].join('\n');
  const ctx = engineBacklog({}, 'repos: {}\n', undefined, { 'config/agents.yaml': agents });
  return { ...ctx, flowSet: { ...ctx.flowSet, gateRecheckMinutes: minutes } };
}

const commit = (/** @type {{ backlogDir: string }} */ ctx) =>
  git(ctx.backlogDir, 'commit', '-q', '--allow-empty', '-m', 'a commit');

/** A failing plain entry, and a failing `has_capacity()` entry. */
const PLAIN = [{ entry: 'status == "merged"', text: 'status == "merged"' }];
const CAPACITY = [{ entry: { condition: 'has_capacity()', class: 'expected' }, text: 'has_capacity()' }];

/** Wait for a wake, and give its source and the time it took, in ms. */
async function timed(/** @type {Promise<string>} */ wake) {
  const start = Date.now();
  const source = await wake;
  return { source, ms: Date.now() - start };
}

/** The listeners that a wake leaves: SIGUSR2's must be back to what it was. */
const usr2 = () => process.listenerCount('SIGUSR2');

test('a burst of commits gives one wake, BURST_MS after the last commit', async () => {
  const ctx = backlog();
  const before = usr2();
  /** @type {string[]} */
  const sources = [];
  const wake = waitForWake(ctx, { failing: PLAIN }).then((source) => (sources.push(source), source));
  for (let i = 0; i < 3; i++) {
    commit(ctx);
    await new Promise((done) => setTimeout(done, 100));
  }
  const last = Date.now();
  assert.equal(await wake, 'reflog');
  assert.ok(Date.now() - last >= BURST_MS - 100, 'it waits for the burst to end');
  // A commit after the wake reaches no watcher of the first wait.
  commit(ctx);
  await new Promise((done) => setTimeout(done, BURST_MS + 200));
  assert.deepEqual(sources, ['reflog']);
  assert.equal(usr2(), before, 'the SIGUSR2 listener is removed');
});

test('SIGUSR2 wakes it, and its listener is removed', async () => {
  const ctx = backlog();
  const before = usr2();
  const wake = timed(waitForWake(ctx, { failing: PLAIN }));
  sendUsr2();
  const { source, ms } = await wake;
  assert.equal(source, 'signal');
  assert.ok(ms < BURST_MS, `woke after ${ms} ms`);
  assert.equal(usr2(), before);
});

test('open, checked after the watchers start, wakes it at once when it gives true', async () => {
  const ctx = backlog();
  const before = usr2();
  /** @type {number[]} the SIGUSR2 listeners when open runs */
  const seen = [];
  const open = async () => (seen.push(usr2()), true);
  const { source, ms } = await timed(waitForWake(ctx, { failing: PLAIN, open }));
  assert.equal(source, 'recheck');
  assert.ok(ms < BURST_MS, `woke after ${ms} ms`);
  assert.deepEqual(seen, [before + 1], 'the signal listener is on before open runs');
  assert.equal(usr2(), before);
});

test('a capacity reset that passes while open runs still wakes it at once', async () => {
  const ctx = backlog(0.05); // the timer: 3 s
  // soon resets 300 ms after backlog(); open takes longer than that.
  const open = async () => (await new Promise((done) => setTimeout(done, 600)), false);
  const env = replayEnv(capacityScript('{ available: true }'));
  const { source, ms } = await withEnv(env, () =>
    timed(waitForWake(ctx, { failing: CAPACITY, agents: ['soon'], open })),
  );
  assert.equal(source, 'capacity');
  assert.ok(ms < 1500, `woke after ${ms} ms`);
});

test('wake_capacity_becomes_available_after_open: a profile that gets capacity while open runs wakes it at once', async () => {
  const NONE = 'capacity: { available: false, resets_at: null }\nentries: []\n';
  const script = capacityScript('{ available: false, resets_at: null }');
  // The timer: 600 ms.
  const ctx = backlog(0.01, [`switch: { adapter: replay, env: { REPLAY_SCRIPT: '${script}' } }`]);
  for (const [what, names, gets, expected] of /** @type {const} */ ([
    ['one profile', ['switch'], true, 'capacity'],
    ['a mixed list with another profile that has no capacity', ['never', 'switch'], true, 'capacity'],
    ['a profile that stays without capacity', ['switch'], false, 'timer'],
    ['a profile that had capacity before open too', ['free'], false, 'timer'],
  ])) {
    writeFileSync(script, NONE);
    // open checks the gate, then the profile gets capacity, before open returns.
    const open = async () => {
      if (gets) writeFileSync(script, NONE.replace('available: false', 'available: true'));
      return false;
    };
    const { source, ms } = await withEnv(replayEnv(script), () =>
      timed(waitForWake(ctx, { failing: CAPACITY, agents: names, open })),
    );
    assert.equal(source, expected, what);
    if (expected === 'capacity') assert.ok(ms < 600, `${what}: woke after ${ms} ms`);
  }
});

test('gate_recheck_minutes wakes it with no commit and no signal', async () => {
  const ctx = backlog(0.005); // 300 ms
  const { source, ms } = await timed(waitForWake(ctx, { failing: PLAIN }));
  assert.equal(source, 'timer');
  assert.ok(ms >= 250, `woke after ${ms} ms`);
});

test("a failing has_capacity() entry wakes it at the earliest resets_at of the box's profiles with no capacity", async () => {
  const ctx = backlog();
  const env = replayEnv(capacityScript('{ available: true }'));
  const wake = (/** @type {any} */ failing, /** @type {string[]} */ agents, minutes = 15) =>
    withEnv(env, () =>
      timed(waitForWake({ ...ctx, flowSet: { ...ctx.flowSet, gateRecheckMinutes: minutes } }, { failing, agents })),
    );
  // free has capacity, so its reset counts for nothing; never gives no reset; soon is the earliest.
  const { source, ms } = await wake(CAPACITY, ['free', 'later', 'never', 'soon']);
  assert.equal(source, 'capacity');
  assert.ok(ms < 2000, `woke after ${ms} ms`);

  // resets_at: null adds no timer, and an entry with no has_capacity() call adds none either.
  for (const [failing, agents] of [
    [CAPACITY, ['never', 'free']],
    [PLAIN, ['soon']],
  ]) {
    assert.equal((await wake(failing, agents, 0.02)).source, 'timer', agents.join(', '));
  }
});

test('waitForWake starts the capacity timer from the reset deadline after slow capacity queries', async () => {
  // Ten profiles, so the capacity queries take a large part of the time to the reset.
  const script = capacityScript('{ available: true }');
  const names = Array.from({ length: 10 }, (_, i) => `slow${i}`);
  const agents = [
    fixtureText('agents.yaml'),
    ...names.map((name) => `${name}: { adapter: replay, env: { REPLAY_SCRIPT: '${script}' } }`),
    '',
  ].join('\n');
  const ctx = engineBacklog({}, 'repos: {}\n', undefined, { 'config/agents.yaml': agents });
  const deadline = Date.now() + 2500;
  writeFileSync(
    script,
    `capacity: { available: false, resets_at: '${new Date(deadline).toISOString()}' }\nentries: []\n`,
  );
  const source = await withEnv(replayEnv(script), () => waitForWake(ctx, { failing: CAPACITY, agents: names }));
  const late = Date.now() - deadline;
  assert.equal(source, 'capacity');
  assert.ok(late >= -50 && late < 500, `woke ${late} ms after the reset`);
});
