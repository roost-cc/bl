/**
 * signal-exit.js — end the process on SIGINT or SIGTERM through `process.exit`.
 *
 * Node's default action for SIGINT and SIGTERM ends the process without the
 * `exit` event. `exitOnSignal` replaces it with `process.exit(130)` (SIGINT)
 * or `process.exit(143)` (SIGTERM), so the `exit` listeners run and see the
 * code. Only a process that needs this calls it: `lock.js` when it loads (to
 * remove its lock files), and `tab-title.js` on the first title (to end the
 * title as `interrupted`, S-1393). Any other `bl` command keeps Node's
 * default action. The handlers are registered once per process.
 */

let registered = false;

/**
 * Take the action of a SIGINT or SIGTERM that ended a synchronous child.
 * Node runs no listener during a synchronous wait, so a caller that sees the
 * child end on one of them raises it here: the listeners run now (`lock.js`
 * removes its locks and exits 130 or 143), or Node's default action ends the
 * process when there are none. Any other signal is not raised. Returns
 * whether `signal` was raised (a listener may let the process go on).
 * @param {string | null | undefined} signal
 * @returns {boolean}
 */
export function raiseSignal(signal) {
  if (signal !== 'SIGINT' && signal !== 'SIGTERM') return false;
  if (process.listenerCount(signal) > 0) process.emit(signal, signal);
  else process.kill(process.pid, signal);
  return true;
}

/** Register the SIGINT and SIGTERM handlers, once per process. */
export function exitOnSignal() {
  if (registered) return;
  registered = true;
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}
