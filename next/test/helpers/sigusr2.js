/**
 * sigusr2.js — send SIGUSR2 to the test process, the wake of a suspended
 * flow (F-152 D3, D-22).
 *
 * `node --test` starts each test file with `reportOnSignal` on, and the
 * report signal is SIGUSR2, so each SIGUSR2 would write a diagnostic report
 * file into the working directory. `bl` runs with it off. The report's
 * handler is a SIGUSR2 listener, so the module turns it off when a test file
 * imports it: the test then counts only the listeners of `bl`.
 */

process.report.reportOnSignal = false;

/** Send SIGUSR2 to this process. */
export function sendUsr2() {
  process.kill(process.pid, 'SIGUSR2');
}
