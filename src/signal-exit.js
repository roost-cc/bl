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

/** Register the SIGINT and SIGTERM handlers, once per process. */
export function exitOnSignal() {
  if (registered) return;
  registered = true;
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}
