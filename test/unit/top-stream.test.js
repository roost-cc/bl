// F-87 D3: the stream reads `runs` every tick, `attention` and `next` when the
// backlog changes and at least every 30 s, `capacity` every 5 min and after a
// `capacity` line, and `history` every 5 min. Counted over 10 simulated
// minutes at the default 2000 ms interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { backlogStamp, createStream } from '../../src/top-stream.js';
import { SECTIONS } from '../../src/top-snapshot.js';

const INTERVAL = 2000;
const TICKS = (10 * 60 * 1000) / INTERVAL;

/**
 * A stream over counting readers and a clock the test moves. `before(i)`
 * runs before tick i; `throwing` names a reader that throws from its
 * second call on.
 */
function simulate({ before = () => {}, throwing = null } = {}) {
  let t = 0;
  let stamp = 'a';
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, 0]));
  const readers = Object.fromEntries(
    SECTIONS.map((name) => [
      name,
      (now) => {
        counts[name] += 1;
        if (name === throwing && counts[name] > 1) throw new Error(`${name} broke`);
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
    snapshots.push(stream.tick());
    t += INTERVAL;
  }
  return { counts, snapshots };
}

test('with no change, runs is read every tick, attention and next every 30 s, capacity and history every 5 min', () => {
  const { counts, snapshots } = simulate();
  assert.equal(TICKS, 300);
  assert.deepEqual(counts, { runs: 300, attention: 20, next: 20, capacity: 2, history: 2 });
  // Every snapshot holds every section, and a section not read this tick keeps its read_at.
  const last = snapshots.at(-1);
  assert.equal(last.runs.read_at, new Date(598000).toISOString());
  assert.equal(last.attention.read_at, new Date(570000).toISOString());
  assert.equal(last.capacity.read_at, new Date(300000).toISOString());
});

test('a backlog change reads attention and next at the next tick, and their 30 s restart from it', () => {
  const { counts } = simulate({ before: (i, { change }) => i === 10 && change() });
  // t=0, then t=20 s (the change), then every 30 s from it to t=590 s.
  assert.equal(counts.attention, 21);
  assert.equal(counts.next, 21);
  assert.equal(counts.runs, 300);
});

test('a capacity request reads capacity at the next tick, once', () => {
  const { counts, snapshots } = simulate({ before: (i, { stream }) => i === 5 && stream.requestCapacity() });
  // t=0, t=10 s (the request, read at tick 5), then t=310 s.
  assert.equal(counts.capacity, 3);
  assert.equal(snapshots[5].capacity.read_at, new Date(10000).toISOString());
  assert.equal(snapshots[6].capacity.read_at, new Date(10000).toISOString());
});

test('a reader that throws keeps its last good value with error, and the stream goes on', () => {
  const { counts, snapshots } = simulate({ throwing: 'runs' });
  assert.equal(counts.runs, 300);
  assert.deepEqual(snapshots[0].runs, { read_at: new Date(0).toISOString(), n: 1, now: 0 });
  assert.deepEqual(snapshots.at(-1).runs, { read_at: new Date(0).toISOString(), n: 1, now: 0, error: 'runs broke' });
  assert.equal(snapshots.at(-1).attention.error, undefined);
});

test('backlogStamp changes when a unit file, a change document or a new task changes the backlog', () => {
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
  ]) {
    change();
    assert.notEqual(backlogStamp(config), before, what);
    before = backlogStamp(config);
  }
});
