/**
 * wait-until.js — wait for a condition that another process makes true, with a
 * time limit (F-128), so that a child that never gets ready fails the test
 * instead of holding it.
 */

import { setTimeout as sleep } from 'timers/promises';

/**
 * Call `check` every 10 ms until it returns a value other than `undefined`,
 * and resolve with that value. Reject when `timeoutMs` passes first.
 * @template T
 * @param {() => T | undefined} check
 * @param {string} what  the condition, for the error message
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function waitUntil(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(10);
  }
}
