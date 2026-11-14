/**
 * top-stream.js — `bl top --stream`: one snapshot per line until stdin
 * closes (F-87 D1, D3).
 *
 * Each tick reads the fast sections and the slow ones only when they are
 * due:
 *
 *   runs       every tick
 *   activity   every tick
 *   tokens     every tick
 *   attention  when the backlog changes (D3a: git HEAD moves, or a unit file,
 *   next       change document, priority.yaml or the staged copy changes:
 *              `backlogStamp`), and
 *              at least every ATTENTION_MAX_AGE_MS
 *   capacity   every CAPACITY_EVERY_MS, and at the tick after a `capacity`
 *              line on stdin
 *   history    every HISTORY_EVERY_MS
 *
 * The first tick reads every section. A read that throws keeps the last good
 * value (`readSection`), and the stream goes on. A section read on a timer
 * (`attention`, `next`, `capacity`, `history`) whose read throws is read again
 * after RETRY_FIRST_MS, then after twice as long at each further failure, never
 * later than its period; a backlog change does not read it sooner. A good read
 * goes back to the usual schedule.
 */

import { join } from 'path';
import { createInterface } from 'readline';
import { backlogSignature, statKey } from './backlog-graph.js';
import { git } from './child.js';
import { STAGED_FILE } from './priority.js';
import { problemLines, readSection, sectionReaders, snapshotOf } from './top-snapshot.js';

export const ATTENTION_MAX_AGE_MS = 30 * 1000;
export const CAPACITY_EVERY_MS = 5 * 60 * 1000;
export const HISTORY_EVERY_MS = 5 * 60 * 1000;
export const RETRY_FIRST_MS = 10 * 1000;

/** The period of each section read on a timer. */
const PERIOD = {
  attention: ATTENTION_MAX_AGE_MS,
  next: ATTENTION_MAX_AGE_MS,
  capacity: CAPACITY_EVERY_MS,
  history: HISTORY_EVERY_MS,
};

/** The stamp of a tick whose `stamp()` threw: one value, so a stamp that keeps throwing is no change. */
const NO_STAMP = Symbol('no stamp');

/**
 * What says the backlog changed (D3a): git's `HEAD`, and the stat signature
 * of every unit file, change document and `priority.yaml` (`backlogSignature`,
 * the one `loadBacklog` compares), and the stat of the staged copy
 * (`STAGED_FILE`, F-113 D5), which no commit records. Equal stamps mean no
 * change.
 * @param {{ backlogRoot: string }} config
 * @returns {string}
 */
export function backlogStamp(config) {
  const head = git(config.backlogRoot, ['rev-parse', 'HEAD']);
  const staged = statKey(join(config.backlogRoot, STAGED_FILE)) ?? '';
  return `${head.status === 0 ? head.stdout.trim() : ''}\n${backlogSignature(config)}\n${staged}`;
}

/**
 * The stream's state: the sections and when each was last read. `tick()`
 * reads what is due at `now()` and resolves to the snapshot; `requestCapacity()`
 * makes the next tick read capacity.
 *
 * @param {{ readers: Record<string, (now: number) => object | Promise<object>>, now?: () => number,
 *   stamp: () => string }} opts  `stamp`: `backlogStamp` of the backlog (a test passes its own)
 */
export function createStream({ readers, now = Date.now, stamp }) {
  const sections = {};
  const readAt = {};
  // A section on a timer whose read threw: when it is due again, and how many reads in a row threw.
  const retryAt = {};
  const failures = {};
  let lastStamp;
  let capacityAsked = false;
  const readOne = async (name, t) => {
    let ok = false;
    sections[name] = await readSection(
      sections[name],
      async () => {
        const value = await readers[name](t);
        ok = true;
        return value;
      },
      t,
    );
    if (ok) {
      readAt[name] = t;
      delete retryAt[name];
      delete failures[name];
    } else if (name in PERIOD) {
      failures[name] = (failures[name] ?? 0) + 1;
      retryAt[name] = t + Math.min(PERIOD[name], RETRY_FIRST_MS * 2 ** (failures[name] - 1));
    }
  };
  const due = (name, t) =>
    name in retryAt ? t >= retryAt[name] : readAt[name] === undefined || t - readAt[name] >= PERIOD[name];
  return {
    requestCapacity() {
      capacityAsked = true;
    },
    async tick() {
      const t = now();
      await readOne('runs', t);
      await readOne('activity', t);
      await readOne('tokens', t);
      let s;
      try {
        s = stamp();
      } catch {
        // No stamp: the first one after a stamp is a change, and the next ones are not.
        s = NO_STAMP;
      }
      const changed = s !== lastStamp;
      lastStamp = s;
      // Two schedules: a section that waits for a retry is not read for a change.
      for (const name of ['attention', 'next']) {
        if ((changed && !(name in retryAt)) || due(name, t)) await readOne(name, t);
      }
      if (capacityAsked || due('capacity', t)) {
        capacityAsked = false;
        await readOne('capacity', t);
      }
      if (due('history', t)) await readOne('history', t);
      return snapshotOf(sections, t);
    },
  };
}

/**
 * Print one snapshot per line on `stdout` every `interval` ms, the first at
 * once, until `stdin` closes; then resolve. A `capacity` line on stdin reads
 * capacity at the next tick. A problem line (a section not read, an inbox
 * warning) goes to stderr when it first appears, not at every tick.
 *
 * @param {object} config
 * @param {{ interval: number, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream }} opts
 * @returns {Promise<void>}
 */
export async function runStream(
  config,
  { interval, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr },
) {
  const stream = createStream({
    readers: sectionReaders(config),
    stamp: () => backlogStamp(config),
  });
  let shown = new Set();
  // A tick that is still reading (a capacity read waits up to its deadline) skips the next one.
  let ticking = false;
  const emitSnapshot = async () => {
    if (ticking) return;
    ticking = true;
    let snapshot;
    try {
      snapshot = await stream.tick();
    } finally {
      ticking = false;
    }
    let lines;
    try {
      lines = problemLines(snapshot);
    } catch (e) {
      lines = [`bl top: problems not read: ${e?.message ?? e}`];
    }
    for (const line of lines) if (!shown.has(line)) stderr.write(`${line}\n`);
    shown = new Set(lines);
    stdout.write(`${JSON.stringify(snapshot)}\n`);
  };
  const lines = createInterface({ input: stdin });
  lines.on('line', (line) => {
    if (line.trim() === 'capacity') stream.requestCapacity();
  });
  const closed = new Promise((resolve) => lines.on('close', resolve));
  // The reader went away (EPIPE): nobody is left to read a snapshot.
  stdout.on('error', () => lines.close());
  await emitSnapshot();
  const timer = setInterval(emitSnapshot, interval);
  await closed;
  clearInterval(timer);
}
