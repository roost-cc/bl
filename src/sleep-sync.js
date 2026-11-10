/**
 * sleep-sync.js — a synchronous sleep that Ctrl+C can end (S-1394).
 *
 * A synchronous wait never yields to the event loop, so Node never runs a
 * SIGINT listener during it. `lock.js` installs one, so Node no longer takes
 * the default action either: `bl` sat in its wait for the main sync lock,
 * deaf to Ctrl+C, until the lock was free.
 *
 * `sleepSync` sleeps in a child `sleep` process in `bl`'s process group. A
 * terminal's Ctrl+C reaches that child too. When the child ends on SIGINT or
 * SIGTERM, `bl` raises the same signal at once: it runs the listeners now
 * (`migration-txn.js` restores the backlog, then `lock.js` removes the held
 * locks and exits 130 or 143), or takes the default action when there are
 * none.
 *
 * Two signals still wait for the synchronous wait to end: one sent to `bl`'s
 * pid alone, and one that lands while `bl` runs between two `sleep` children
 * (in a test, about 1 in 40 sent at random times, and about half sent right
 * after the wait's announcement). Node queues such a signal for the event
 * loop, and no synchronous code can see it. A second Ctrl+C ends `bl`.
 */

import { spawnSync } from 'child_process';

/**
 * Sleep `ms` milliseconds without returning to the event loop.
 *
 * @param {number} ms
 */
export function sleepSync(ms) {
  if (ms <= 0) return;
  const r = spawnSync('sleep', [(ms / 1000).toFixed(3)], { stdio: 'ignore' });
  if (r.error) {
    // No `sleep` to run: sleep in this process, deaf to signals as before.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  }
  if (r.signal === 'SIGINT' || r.signal === 'SIGTERM') {
    if (process.listenerCount(r.signal) > 0) process.emit(r.signal, r.signal);
    else process.kill(process.pid, r.signal);
  }
}
