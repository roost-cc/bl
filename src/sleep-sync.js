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
 * (in a probe with 100 ms and 200 ms polls, 2 in 150 sent at random times).
 * Node queues such a signal for the event loop, and no synchronous code can
 * see it. A second Ctrl+C ends `bl`. A wait that passes its announcement as
 * `say` has no such gap right after the announcement: the child writes it.
 */

import { spawnSync } from 'child_process';

/**
 * Sleep `ms` milliseconds without returning to the event loop.
 *
 * `say` is a line for stderr, such as a wait's announcement. The child writes
 * it and then sleeps, so a Ctrl+C sent once the line shows reaches the child,
 * not `bl` alone before the child starts.
 *
 * @param {number} ms
 * @param {string} [say]
 */
export function sleepSync(ms, say) {
  const tell = () => say != null && process.stderr.write(`${say}\n`);
  // `!(ms > 0)` also catches NaN, which `Atomics.wait` takes as "forever".
  if (!(ms > 0)) return void tell();
  const secs = (ms / 1000).toFixed(3);
  const r =
    say == null
      ? spawnSync('sleep', [secs], { stdio: 'ignore' })
      : spawnSync('sh', ['-c', 'printf "%s\\n" "$2" >&2; exec sleep "$1"', 'sh', secs, say], {
          stdio: ['ignore', 'ignore', 'inherit'],
        });
  if (r.signal === 'SIGINT' || r.signal === 'SIGTERM') {
    if (process.listenerCount(r.signal) > 0) process.emit(r.signal, r.signal);
    else process.kill(process.pid, r.signal);
    return;
  }
  if (r.status !== 0) {
    // The child did not start (it wrote nothing), did not sleep (it refused
    // the argument) or ended on another signal (SIGPIPE when it wrote `say` to
    // a pipe with no reader): sleep in this process, deaf to signals as before.
    if (r.error) tell();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}
