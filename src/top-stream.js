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
 *   next       change document or priority.md changes: `backlogStamp`), and
 *              at least every ATTENTION_MAX_AGE_MS
 *   capacity   every CAPACITY_EVERY_MS, and at the tick after a `capacity`
 *              line on stdin
 *   history    every HISTORY_EVERY_MS
 *
 * The first tick reads every section. A read that throws keeps the last good
 * value (`readSection`), and the stream goes on.
 */

import { spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { backlogSignature } from './backlog-graph.js';
import { problemLines, readSection, sectionReaders, snapshotOf } from './top-snapshot.js';

export const ATTENTION_MAX_AGE_MS = 30 * 1000;
export const CAPACITY_EVERY_MS = 5 * 60 * 1000;
export const HISTORY_EVERY_MS = 5 * 60 * 1000;

/**
 * What says the backlog changed (D3a): git's `HEAD`, and the stat signature
 * of every unit file, change document and `priority.md` (`backlogSignature`,
 * the one `loadBacklog` compares). Equal stamps mean no change.
 * @param {{ backlogRoot: string }} config
 * @returns {string}
 */
export function backlogStamp(config) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: config.backlogRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return `${head.status === 0 ? head.stdout.trim() : ''}\n${backlogSignature(config)}`;
}

/**
 * The stream's state: the sections and when each was last read. `tick()`
 * reads what is due at `now()` and returns the snapshot; `requestCapacity()`
 * makes the next tick read capacity.
 *
 * @param {{ readers: Record<string, (now: number) => object>, now?: () => number,
 *   stamp: () => string }} opts  `stamp`: `backlogStamp` of the backlog (a test passes its own)
 */
export function createStream({ readers, now = Date.now, stamp }) {
  const sections = {};
  const readAt = {};
  let lastStamp;
  let capacityAsked = false;
  const read = (name, t) => {
    sections[name] = readSection(sections[name], () => readers[name](t), t);
    readAt[name] = t;
  };
  const due = (name, t, every) => readAt[name] === undefined || t - readAt[name] >= every;
  return {
    requestCapacity() {
      capacityAsked = true;
    },
    tick() {
      const t = now();
      read('runs', t);
      read('activity', t);
      read('tokens', t);
      const s = stamp();
      if (s !== lastStamp || due('attention', t, ATTENTION_MAX_AGE_MS)) {
        read('attention', t);
        read('next', t);
      }
      lastStamp = s;
      if (capacityAsked || due('capacity', t, CAPACITY_EVERY_MS)) {
        capacityAsked = false;
        read('capacity', t);
      }
      if (due('history', t, HISTORY_EVERY_MS)) read('history', t);
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
export function runStream(
  config,
  { interval, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr },
) {
  const stream = createStream({
    readers: sectionReaders(config),
    stamp: () => backlogStamp(config),
  });
  let shown = new Set();
  const emit = () => {
    const snapshot = stream.tick();
    const lines = problemLines(snapshot);
    for (const line of lines) if (!shown.has(line)) stderr.write(`${line}\n`);
    shown = new Set(lines);
    stdout.write(`${JSON.stringify(snapshot)}\n`);
  };
  return new Promise((resolve) => {
    const timer = setInterval(emit, interval);
    const lines = createInterface({ input: stdin });
    lines.on('line', (line) => {
      if (line.trim() === 'capacity') stream.requestCapacity();
    });
    lines.on('close', () => {
      clearInterval(timer);
      resolve();
    });
    // The reader went away (EPIPE): nobody is left to read a snapshot.
    stdout.on('error', () => lines.close());
    emit();
  });
}
