/**
 * suspending.js — a flow run that suspends, for the tests of the suspend and
 * wake (F-152 D3): `runner.test.js`, and the ops tests whose commit wakes a
 * suspended process (`outcome.test.js`).
 */

import { runFlow } from '../../engine/runner.js';
import { waitForWake } from '../../engine/wake.js';
import { sendUsr2 } from './sigusr2.js';

/**
 * Start `runFlow` with `invocation` and `waitForWake`, or the `wake` in `invocation`, with stderr
 * caught: give its promise and the lines it printed so far. If the test ends while the flow is
 * suspended (an assertion failed), a SIGUSR2 wakes it and its next wait throws, so the flow ends
 * and the test file does not hang.
 */
export function suspending(/** @type {any} */ t, /** @type {any} */ ctx, /** @type {any} */ invocation) {
  /** @type {string[]} */
  const printed = [];
  t.mock.method(process.stderr, 'write', (/** @type {string} */ text) => printed.push(String(text)) > 0);
  const { wake = waitForWake } = invocation;
  let ended = false;
  let settled = false;
  const pending = runFlow(ctx, {
    by: 'operator',
    ...invocation,
    wake: async (/** @type {any} */ c, /** @type {any} */ suspend) => {
      if (ended) throw new Error('the test ended');
      return wake(c, suspend);
    },
  }).finally(() => (settled = true));
  pending.catch(() => {});
  t.after(() => {
    ended = true;
    if (!settled) sendUsr2();
  });
  const lines = () => printed.join('').split('\n').filter(Boolean);
  return { pending, lines };
}

/** A `wake` that records each suspend's run state in `runs`, then waits with `waitForWake`. */
export function recordingWake() {
  /** @type {string[]} */
  const runs = [];
  const wake = async (/** @type {any} */ c, /** @type {any} */ suspend) => {
    runs.push(suspend.run);
    return waitForWake(c, suspend);
  };
  return { runs, wake };
}
