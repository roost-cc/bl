/**
 * lock-wait.js — the one wait for a held lock (F-105 W1).
 *
 * Every lock wait in bl goes through `awaitLock`: it tries the lock, and while
 * a live process holds it, awaits a timer and tries again. The wait never
 * blocks the event loop, so the SIGINT and SIGTERM listeners (`signal-exit.js`)
 * run during it, and one Ctrl+C ends `bl` at once. Each caller keeps its own
 * deadline (F-105 A3) and its own outcome on a timeout.
 */

import { setTimeout as delay } from 'node:timers/promises';

/**
 * The line a lock wait prints once, when it first finds a live holder, so a
 * person (or a test) can tell a process blocked on a lock from one still
 * doing its pre-lock work.
 *
 * @param {string} lock  the lock's name or path, as the reader should see it
 * @param {number | 'unknown'} pid   the live holder
 */
export function waitingForLock(lock, pid) {
  return `Waiting for lock (${lock}) held by pid ${pid}…`;
}

/** A lock wait passed its deadline while a live process held the lock. */
export class LockWaitTimeout extends Error {
  /**
   * @param {string} lock  the lock's name or path, as `awaitLock` got it
   * @param {number | 'unknown'} holder  the live holder at the last try
   * @param {number} waitedMs  the deadline that passed
   */
  constructor(lock, holder, waitedMs) {
    super(`Timed out after ${waitedMs} ms waiting for lock (${lock}) held by pid ${holder}.`);
    this.name = 'LockWaitTimeout';
    this.lock = lock;
    this.holder = holder;
  }
}

/**
 * Take a lock, waiting for a live holder. `take()` tries once and returns
 * `{ taken: T }` or `{ holder: number | 'unknown' }`. On the first holder it
 * calls `announce(waitingForLock(name, holder))` once, then awaits `pollMs`
 * (at most the time left to the deadline) and tries again, until it takes the
 * lock or `deadlineMs` (null: none) has
 * passed. Resolves `T`; rejects with a LockWaitTimeout naming the lock and
 * the live holder. The message never tells anyone to remove the file. An
 * error that `take` throws rejects the wait as it is. `sleep` is a test seam.
 *
 * @template T
 * @param {string} name  the lock's name or path, as the reader should see it
 * @param {() => { taken: T } | { holder: number | 'unknown' }} take
 * @param {{ deadlineMs: number | null, pollMs: number, announce: (line: string) => void,
 *   sleep?: (ms: number) => Promise<unknown> }} opts
 * @returns {Promise<T>}
 */
export async function awaitLock(name, take, { deadlineMs, pollMs, announce, sleep = delay }) {
  const start = Date.now();
  let announced = false;
  for (;;) {
    const got = take();
    if ('taken' in got) return got.taken;
    if (!announced) {
      announced = true;
      announce(waitingForLock(name, got.holder));
    }
    // Never sleeps past the deadline (`withMainSyncLock` before F-105 did the same).
    const left = deadlineMs == null ? pollMs : deadlineMs - (Date.now() - start);
    if (left <= 0) throw new LockWaitTimeout(name, got.holder, deadlineMs);
    await sleep(Math.min(pollMs, left));
  }
}
