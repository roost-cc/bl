// F-87 D3: the stream reads `runs`, `activity` and `tokens` every tick, `attention` and `next` when the
// backlog changes and at least every 30 s, `capacity` every 5 min and after a
// `capacity` line, and `history` every 5 min. Counted over 10 simulated
// minutes at the default 2000 ms interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PassThrough, Writable } from 'stream';
import { mkTempDir } from '../helpers/tempdir.js';
import { STAGED_FILE } from '../../src/priority.js';
import { RETRY_FIRST_MS, backlogStamp, createStream, runStream } from '../../src/top-stream.js';
import { SECTIONS } from '../../src/top-snapshot.js';

const INTERVAL = 2000;
const TICKS = (10 * 60 * 1000) / INTERVAL;

/**
 * A stream over counting readers and a clock the test moves. `before(i)`
 * runs before tick i; `throwing` names a reader that throws from its
 * second call on, `failOnce` one that throws on its second call only.
 * `times` holds the clock of each call of each reader.
 */
async function simulate({ before = () => {}, throwing = null, failOnce = null } = {}) {
  let t = 0;
  let stamp = 'a';
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, 0]));
  const times = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  const readers = Object.fromEntries(
    SECTIONS.map((name) => [
      name,
      (now) => {
        counts[name] += 1;
        times[name].push(now);
        if (name === throwing && counts[name] > 1) throw new Error(`${name} broke`);
        if (name === failOnce && counts[name] === 2) throw new Error(`${name} broke once`);
        return { n: counts[name], now };
      },
    ]),
  );
  const stream = createStream({ readers, now: () => t, stamp: () => stamp });
  const snapshots = [];
  for (let i = 0; i < TICKS; i++) {
    before(i, {
      stream,
      change: () => {
        stamp += 'x';
      },
    });
    snapshots.push(await stream.tick());
    t += INTERVAL;
  }
  return { counts, times, snapshots };
}

test('with no change, runs, activity and tokens are read every tick, attention and next every 30 s, capacity and history every 5 min', async () => {
  const { counts, snapshots } = await simulate();
  assert.equal(TICKS, 300);
  assert.deepEqual(counts, {
    runs: 300,
    attention: 20,
    next: 20,
    capacity: 2,
    history: 2,
    activity: 300,
    tokens: 300,
  });
  // Every snapshot holds every section, and a section not read this tick keeps its read_at.
  const last = snapshots.at(-1);
  assert.equal(last.runs.read_at, new Date(598000).toISOString());
  assert.equal(last.attention.read_at, new Date(570000).toISOString());
  assert.equal(last.capacity.read_at, new Date(300000).toISOString());
});

test('a backlog change reads attention and next at the next tick, and their 30 s restart from it', async () => {
  const { counts } = await simulate({ before: (i, { change }) => i === 10 && change() });
  // t=0, then t=20 s (the change), then every 30 s from it to t=590 s.
  assert.equal(counts.attention, 21);
  assert.equal(counts.next, 21);
  assert.equal(counts.runs, 300);
});

test('a capacity request reads capacity at the next tick, once', async () => {
  const { counts, snapshots } = await simulate({ before: (i, { stream }) => i === 5 && stream.requestCapacity() });
  // t=0, t=10 s (the request, read at tick 5), then t=310 s.
  assert.equal(counts.capacity, 3);
  assert.equal(snapshots[5].capacity.read_at, new Date(10000).toISOString());
  assert.equal(snapshots[6].capacity.read_at, new Date(10000).toISOString());
});

test('a reader that throws keeps its last good value with error, and the stream goes on', async () => {
  const { counts, snapshots } = await simulate({ throwing: 'runs' });
  assert.equal(counts.runs, 300);
  assert.deepEqual(snapshots[0].runs, { read_at: new Date(0).toISOString(), n: 1, now: 0 });
  assert.deepEqual(snapshots.at(-1).runs, { read_at: new Date(0).toISOString(), n: 1, now: 0, error: 'runs broke' });
  assert.equal(snapshots.at(-1).attention.error, undefined);
});

test('a failed read of a due section is read again RETRY_FIRST_MS later, not after its period', async () => {
  // name, the clock of its second read (which fails), its read count with no failure.
  for (const [name, second, reads] of [
    ['attention', 30000, 20],
    ['next', 30000, 20],
    ['capacity', 300000, 2],
    ['history', 300000, 2],
  ]) {
    const { counts, times, snapshots } = await simulate({ failOnce: name });
    assert.equal(times[name][1], second, name);
    assert.equal(times[name][2], second + RETRY_FIRST_MS, `${name}: read again after the retry`);
    const failed = snapshots[second / INTERVAL][name];
    assert.equal(failed.error, `${name} broke once`, name);
    const retried = (second + RETRY_FIRST_MS) / INTERVAL;
    assert.equal(snapshots[retried - 1][name].error, `${name} broke once`, `${name}: no read before the retry`);
    assert.equal(snapshots[retried][name].error, undefined, `${name}: the good read drops the error`);
    // From the good read on, the usual period (capacity and history have no fourth read in 10 min).
    if (name === 'attention' || name === 'next') assert.equal(times[name][3] - times[name][2], 30000, name);
    assert.equal(counts[name], reads + 1, name);
  }
});

test('a stamp that throws ends no tick: its first throw counts as a change, and the next throws do not', async () => {
  const readers = Object.fromEntries(SECTIONS.map((name) => [name, () => ({ ok: true })]));
  const times = { attention: [], next: [] };
  for (const name of Object.keys(times)) {
    readers[name] = (now) => (times[name].push(now), { n: times[name].length });
  }
  let t = 0;
  const stream = createStream({
    readers,
    now: () => t,
    stamp: () => {
      if (t === 0) return 'a';
      throw new Error('git is gone');
    },
  });
  for (let i = 0; i < 30; i++, t += INTERVAL) assert.equal((await stream.tick()).attention.error, undefined);
  // t=0 (the first tick), t=2 s (the stamp went: a change), then every 30 s from it.
  for (const name of Object.keys(times)) assert.deepEqual(times[name], [0, 2000, 32000], name);
});

test('a section that keeps failing is not read at every tick', async () => {
  const period = { attention: 30000, next: 30000, capacity: 300000, history: 300000 };
  // The usual read count of each section over the 10 minutes, with no failure.
  const usual = { attention: 20, next: 20, capacity: 2, history: 2 };
  for (const name of Object.keys(period)) {
    // A backlog that changes at every tick reads attention and next at every tick, unless they fail.
    for (const changing of [false, true]) {
      const what = `${name}${changing ? ', the backlog changing at every tick' : ''}`;
      const { counts, times } = await simulate({ throwing: name, before: (i, { change }) => changing && change() });
      // After the first failure, each retry waits twice as long as the one before, up to the period.
      for (let i = 2; i < times[name].length; i++) {
        const want = Math.min(period[name], RETRY_FIRST_MS * 2 ** (i - 2));
        assert.equal(times[name][i] - times[name][i - 1], want, `${what}: read ${i}`);
      }
      // The other sections keep their own schedule.
      for (const other of Object.keys(period).filter((o) => o !== name)) {
        const want = changing && (other === 'attention' || other === 'next') ? TICKS : usual[other];
        assert.equal(counts[other], want, `${what}: ${other}`);
      }
    }
  }
});

test('backlogStamp changes when a unit file, a change document, a new task or the staged copy changes the backlog', () => {
  const dir = mkTempDir('bl-top-stamp-');
  const config = { backlogRoot: dir };
  const unit = join(dir, 'stories', 'S1-one');
  mkdirSync(unit, { recursive: true });
  writeFileSync(join(unit, 'index.md'), 'one\n');
  let before = backlogStamp(config);
  assert.equal(backlogStamp(config), before, 'no change, same stamp');
  for (const [what, change] of [
    ['a unit file edited', () => writeFileSync(join(unit, 'index.md'), 'one, edited\n')],
    ['a change document added', () => writeFileSync(join(unit, 'change.md'), 'change\n')],
    [
      'a task added',
      () => {
        mkdirSync(join(dir, 'tasks'));
        writeFileSync(join(dir, 'tasks', 'T1-do.md'), 'task\n');
      },
    ],
    [
      'a staged copy written (F-113 D5)',
      () => {
        mkdirSync(join(dir, '.bl'));
        writeFileSync(join(dir, STAGED_FILE), '- F-1\n');
      },
    ],
    ['a staged edit', () => writeFileSync(join(dir, STAGED_FILE), '- F-2\n- F-1\n')],
    ['the staged copy deleted', () => rmSync(join(dir, STAGED_FILE))],
  ]) {
    change();
    assert.notEqual(backlogStamp(config), before, what);
    before = backlogStamp(config);
  }
});

// Each row: the tick whose `runs` read is still pending when the reader goes
// away, and how it goes: stdin closes, or stdout fails (EPIPE). That tick and
// every one after it write nothing; the ticks before it wrote their lines.
for (const at of [1, 2]) {
  for (const how of ['stdin closes', 'stdout fails']) {
    test(`runStream_stops_at_closed_stdin: ${how} during tick ${at}`, async () => {
      const config = { backlogRoot: mkTempDir('bl-top-stream-') };
      const stdin = new PassThrough();
      const written = { stdout: 0, stderr: 0 };
      const sink = (name) =>
        new Writable({
          write(_chunk, _enc, cb) {
            written[name] += 1;
            cb();
          },
        });
      const stdout = sink('stdout');
      const stderr = sink('stderr');
      let calls = 0;
      let settled;
      const readers = Object.fromEntries(SECTIONS.map((name) => [name, () => ({ ok: true })]));
      // A section that never reads: its problem line goes to stderr on the first tick.
      readers.activity = () => {
        throw new Error('activity broke');
      };
      readers.runs = async () => {
        calls += 1;
        if (calls !== at) return { ok: true };
        settled = new Promise((resolve) => setTimeout(resolve, 50));
        if (how === 'stdin closes') stdin.end();
        else stdout.emit('error', new Error('write EPIPE'));
        await settled;
        return { ok: true };
      };
      await runStream(config, { interval: 10, stdin, stdout, stderr, readers });
      // The pending read ends after runStream resolved; give its tick the turn it would write in.
      await settled;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(written, { stdout: at - 1, stderr: at - 1 });
      assert.equal(calls, at, 'no tick after the reader went away');
    });
  }
}
