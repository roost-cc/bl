/**
 * signal-exit.js — end the process on SIGINT or SIGTERM through `process.exit`.
 *
 * Node's default action for SIGINT and SIGTERM ends the process without the
 * `exit` event. `exitOnSignal` replaces it with `process.exit` and the
 * signal's `EXIT_CODES` code (130 for SIGINT, 143 for SIGTERM), so the `exit`
 * listeners run and see the code. `bl.js` calls it when `bl` starts, so every
 * command exits 130 or 143 and runs its `exit` listeners (the throwaway
 * worktree of `bl merge`, a session's lock file). `tab-title.js` calls it on
 * the first title too (to end the title as `interrupted`, S-1393): `bl.js`
 * sets a start title for every command (S-1412), so a new command needs no
 * code of its own for either. A `bl` started for data runs with
 * `BL_TAB_TITLE=''` and sets no title, so only `bl.js` registers the handlers
 * there. The backlog lock needs none: the kernel frees it when the process
 * ends (F-104). The handlers are registered once per process.
 * `takeInterrupts` lets `bl run`'s loop take the first interrupt as a stop
 * instead (F-128 D8), and `ignoreSignals` lets `bl view` ignore them while
 * its editor runs (S-1182).
 *
 * `INTERRUPT_SIGNALS` names the signals that interrupt `bl`, and
 * `raiseSignal` raises one of them again after a synchronous child ended on
 * it. `src/child.js` (F-114 D2) is the one place that calls it for a child:
 * at once, or when the outermost `raiseAfter` ends (D2a). It reads the
 * child's signal through `interruptOf(r)`, which is null when Node itself
 * killed the child (`r.error` set, such as `ETIMEDOUT`), so that kill is not
 * raised.
 */

import { constants } from 'os';

let registered = false;

/**
 * The signals that interrupt `bl`. A synchronous child ended by one of them
 * stops the command, and `raiseSignal` raises it again. A child ended by any
 * other signal (SIGABRT, SIGSEGV, SIGKILL from the out-of-memory killer) has
 * failed, as one with a non-zero exit code has.
 */
export const INTERRUPT_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * The exit code a shell gives for a child that `signal` ended: 128 + the
 * signal's number, or 128 for a name this platform does not know.
 * @param {string} signal
 * @returns {number}
 */
export function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 0);
}

/**
 * The exit code of each interrupt (`signalExitCode`: 130 for SIGINT, 143 for
 * SIGTERM). `exitOnSignal` exits with it, and `src/child.js` reads it back
 * from a shell or a `bl` child.
 */
export const EXIT_CODES = Object.freeze(
  Object.fromEntries(INTERRUPT_SIGNALS.map((signal) => [signal, signalExitCode(signal)])),
);

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
 * run now (`exitOnSignal`'s exit 130 or 143, and the `exit` listeners), or Node's
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
  for (const signal of INTERRUPT_SIGNALS) {
    process.on(signal, () => {
      if (ignored.has(signal)) return;
      const handler = interruptHandler;
      if (!handler) process.exit(EXIT_CODES[signal]);
      interruptHandler = null;
      handler(signal);
    });
  }
}

/** The handler that `takeInterrupts` set and no interrupt has called yet. */
let interruptHandler = null;

/**
 * Take the first interrupt as a stop (F-128 D8): while `handler` is set, the
 * first SIGINT or SIGTERM calls `handler(signal)` and the process goes on. A
 * second one exits 130 or 143, as `exitOnSignal` does without a handler.
 * Registers `exitOnSignal`'s listeners itself. `bl run`'s loop is the one
 * caller. Returns the release function, which unsets `handler`.
 * @param {(signal: string) => void} handler
 * @returns {() => void}
 */
export function takeInterrupts(handler) {
  exitOnSignal();
  interruptHandler = handler;
  return () => {
    if (interruptHandler === handler) interruptHandler = null;
  };
}

/** The signals `ignoreSignals` holds now. */
const ignored = new Set();

/**
 * Ignore `signals` until the returned release function runs (S-1182): a
 * listener that does nothing replaces Node's default action, and
 * `exitOnSignal`'s listener returns at once for them. `bl view` ignores
 * SIGINT and SIGQUIT while its editor runs, as `system(3)` does, and SIGTERM,
 * as its synchronous wait did before S-1182: a Ctrl-C or Ctrl-\ meant for the
 * editor does not end `bl` and leave its copy behind. One holder at a time:
 * the set of ignored signals is shared, so the first release of two
 * overlapping calls for one signal would let `exitOnSignal` act on it again.
 * @param {readonly NodeJS.Signals[]} signals
 * @returns {() => void}
 */
export function ignoreSignals(signals) {
  const nothing = () => {};
  for (const signal of signals) {
    ignored.add(signal);
    process.on(signal, nothing);
  }
  return () => {
    for (const signal of signals) {
      ignored.delete(signal);
      process.off(signal, nothing);
    }
  };
}
