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
 *
 * `INTERRUPT_SIGNALS` names the signals that interrupt `bl`, and
 * `raiseSignal` raises one of them again after a synchronous child ended on
 * it (`checkedMerge`, the push of main and the install in `cleanupOneRepo`,
 * `landedMergeCommit` and `removeWorktreeAndBranch` in `cleanup.js`,
 * `main-sync.js`'s git commands, and `reportBacklogCommit` in `sync.js`).
 * Those callers read the signal of their own git children through
 * `interruptOf(r)`, which is null when Node itself killed the child (`r.error`
 * set, such as `ENOBUFS`), so that kill is not raised. The signal that
 * `commitPaths` returns is not read through `interruptOf` yet.
 */

let registered = false;

/**
 * The signals that interrupt `bl`. A synchronous child ended by one of them
 * stops the command, and `raiseSignal` raises it again. A child ended by any
 * other signal (SIGABRT, SIGSEGV, SIGKILL from the out-of-memory killer) has
 * failed, as one with a non-zero exit code has.
 */
export const INTERRUPT_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * Whether `signal` is one of `INTERRUPT_SIGNALS`.
 * @param {string | null | undefined} signal
 * @returns {boolean}
 */
export function isInterrupt(signal) {
  return INTERRUPT_SIGNALS.includes(signal);
}

/**
 * The interrupt (`INTERRUPT_SIGNALS`) that ended the synchronous child `r`, or
 * null. A child that Node itself killed (`r.error` set: `ENOBUFS` past
 * `maxBuffer`, `ETIMEDOUT` past `timeout`) is a failed child, not an interrupt.
 * @param {{ signal?: string | null, error?: Error }} r  a `spawnSync` result
 * @returns {string | null}
 */
export function interruptOf(r) {
  return !r.error && isInterrupt(r.signal) ? r.signal : null;
}

/**
 * Take the action of an interrupt (`INTERRUPT_SIGNALS`) that ended a
 * synchronous child. Node runs no listener during a synchronous wait, so a
 * caller that sees the child end on one of them raises it here: the listeners
 * run now (`lock.js` removes its locks and exits 130 or 143), or Node's
 * default action ends the process when there are none. Any other signal is
 * not raised. Returns whether `signal` was raised (a listener may let the
 * process go on).
 * @param {string | null | undefined} signal
 * @returns {boolean}
 */
export function raiseSignal(signal) {
  if (!isInterrupt(signal)) return false;
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
