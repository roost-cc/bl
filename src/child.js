/**
 * child.js — the one module that runs a child of `bl` (F-114 D1).
 *
 * Four entry points start a synchronous child, each through `spawnSyncFiles`
 * (`src/child-stdio.js`, F-70 D1), and return the `spawnSync` result shape:
 *
 * - `runChild(command, args, opts)`: an argv command, no shell.
 * - `runCommandLine(line, opts)`: a command line from configuration (a plugin,
 *   a test gate, a forge operation), through a shell for its shell syntax.
 * - `runBl(entry, args, opts)`: a `bl` child, `process.execPath entry …args`,
 *   no shell. `entry` is the `bl.js` to run (the just-merged one of the bl
 *   checkout, or this process's own).
 * - `git(cwd, args, opts)`: `runChild('git', args)` in `cwd`, with
 *   `encoding: 'utf8'` and stdio `['ignore', 'pipe', 'pipe']` unless `opts`
 *   says otherwise. It sets `cwd`, not `git -C`, so the argv stays what the
 *   tests' git shims match.
 *
 * The fifth entry point, `runLongChild(command, args, opts)`, starts a long
 * child (a headless agent session, a test-gate command: F-128 D3). It runs
 * an argv with no shell through `spawnFiles`, the asynchronous counterpart of
 * `spawnSyncFiles`, and resolves to the same result shape. It never raises an
 * interrupt: during an asynchronous wait every signal sent to `bl` reaches
 * `bl`'s own listeners, so the reason for D2's raise (no listener runs during
 * a synchronous wait) does not apply. A child that a signal ended is a failed
 * child for its caller. `opts.signal` (an `AbortSignal`) sends SIGTERM to the
 * child. The module's `exit` listener sends SIGTERM to every long child that
 * is still running (F-128 A1). `bl` does not wait for it and sends no SIGKILL,
 * so a child that handles or ignores SIGTERM can outlive `bl`.
 *
 * `gitOut(cwd, args, opts)` is `git()` for a git command that must succeed
 * (F-124 D2): it returns the trimmed stdout, and throws `describeExit`'s
 * message when the child failed. `BL_PATH` is this process's own `bl.js`
 * (F-124 D5), the `entry` for a `runBl` of this `bl`.
 *
 * **An interrupt is raised at once (D2).** If SIGINT or SIGTERM
 * (`INTERRUPT_SIGNALS`) ends a synchronous child, the module prints
 * `bl: <child> was ended by <signal>` on stderr and raises the signal
 * (`raiseSignal`): the `exit` listeners run and `bl` exits 130 or 143. If a
 * listener lets the process go on, the module exits 130 or 143 itself. The
 * caller never sees the result. `runCommandLine` and `runBl` read exit 130 as
 * SIGINT and exit 143 as SIGTERM too: a shell turns a signal that ends its
 * child into 128 + n, and a `bl` child exits 130 or 143 on its own interrupt.
 * A child that Node itself killed (`ETIMEDOUT` past `timeout`, `r.error` set)
 * is a failed child, not an interrupt (`interruptOf`). While `bl` exits, an
 * interrupt that ends a child of an `exit` listener is printed, not raised:
 * `bl` keeps its exit code and the other listeners run.
 *
 * **`raiseAfter(fn)` keeps an undo (D2a).** Inside it, an interrupted child
 * returns to its caller as a failed child, so the caller's undo (a rebase
 * abort) runs. The module prints its line when the child ends, keeps the first
 * interrupt, and raises it when the outermost `raiseAfter` ends.
 * `interruptKept()` says whether it keeps one, so a failed undo is reported
 * before the raise.
 *
 * `describeExit(r, what)` words a failed child for every caller.
 * `exitStatus(r)` is the exit status a child result stands for, and
 * `reportExit(cmd, r)` says on stderr why a child could not start or was
 * killed (F-124 D6).
 */

import { fileURLToPath } from 'url';
import { spawnFiles, spawnSyncFiles } from './child-stdio.js';
import { EXIT_CODES, INTERRUPT_SIGNALS, interruptOf, raiseSignal, signalExitCode } from './signal-exit.js';

/** The path of this process's own `bl.js`. */
export const BL_PATH = fileURLToPath(new URL('./bl.js', import.meta.url));

/** How many `raiseAfter` calls are running, and the first interrupt one of them kept. */
let depth = 0;
let kept = null;

/** The long children that are still running: the controller that ends each one. */
const longChildren = new Set();

/**
 * True once `bl` exits. An interrupt that ends a child of an `exit` listener
 * (the throwaway removal of `bl merge`) is not raised again: a raise there
 * would change the exit code and skip the listeners after it.
 * The listener also sends SIGTERM to each long child that is still running.
 */
let exiting = false;
process.on('exit', () => {
  exiting = true;
  for (const controller of longChildren) controller.abort();
});

/**
 * @typedef {import('child_process').SpawnSyncOptions} ChildOptions
 * @typedef {import('child_process').SpawnSyncReturns<string | Buffer>} ChildResult
 */

/**
 * Run the long child `command` with `args` and no shell, and resolve to its
 * result. An interrupt that ends it returns to the caller too (F-128 D3).
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {import('child_process').SpawnOptions & { encoding?: BufferEncoding | 'buffer' }} [opts]
 *   `opts.signal` sends SIGTERM to the child when it fires
 * @returns {Promise<ChildResult>}
 */
export async function runLongChild(command, args = [], opts = {}) {
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  longChildren.add(controller);
  try {
    return await spawnFiles(command, args, { ...opts, shell: false, signal });
  } finally {
    longChildren.delete(controller);
  }
}

/**
 * Run `command` with `args` and no shell.
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {ChildOptions} [opts]
 * @returns {ChildResult}
 */
export function runChild(command, args = [], opts = {}) {
  return settle(spawnArgv(command, args, opts), [command, ...args].join(' '));
}

/**
 * Run the command line `line` through a shell.
 * @param {string} line
 * @param {ChildOptions} [opts]
 * @returns {ChildResult}
 */
export function runCommandLine(line, opts = {}) {
  return settle(spawnSyncFiles(line, { ...opts, shell: true }), line, { codes: true });
}

/**
 * Run the `bl` program `entry` with `args`, as `process.execPath entry …args`.
 * @param {string} entry  the path of a `bl.js`
 * @param {readonly string[]} [args]
 * @param {ChildOptions} [opts]
 * @returns {ChildResult}
 */
export function runBl(entry, args = [], opts = {}) {
  const argv = [entry, ...args];
  return settle(spawnArgv(process.execPath, argv, opts), [process.execPath, ...argv].join(' '), {
    codes: true,
  });
}

/**
 * Run `git …args` in `cwd`: utf8 output, stdin ignored, stdout and stderr
 * captured, unless `opts` says otherwise.
 * @param {string | undefined} cwd  undefined runs it in `process.cwd()`
 * @param {readonly string[]} args
 * @param {ChildOptions} [opts]
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
export function git(cwd, args, opts = {}) {
  return /** @type {import('child_process').SpawnSyncReturns<string>} */ (
    runChild('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts, cwd })
  );
}

/**
 * Run `git …args` in `cwd` as `git()` does, for a command that must succeed:
 * return its trimmed stdout (`''` when `opts.stdio` does not capture it), or
 * throw an `Error` with `describeExit`'s message when the child failed.
 * @param {string | undefined} cwd  undefined runs it in `process.cwd()`
 * @param {readonly string[]} args
 * @param {ChildOptions} [opts]
 * @returns {string}
 */
export function gitOut(cwd, args, opts = {}) {
  const r = git(cwd, args, opts);
  if (r.error || r.status !== 0) throw new Error(describeExit(r, `git ${args.join(' ')}`));
  return String(r.stdout ?? '').trim();
}

/**
 * Run the synchronous `fn`, and raise the first interrupt that ended a child
 * inside it once it returns or throws. Inside it, the interrupted child's
 * result returns to its caller, so an undo after it runs. A `raiseAfter`
 * inside another raises once, when the outermost one ends.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function raiseAfter(fn) {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    if (depth === 0 && kept) {
      const signal = kept;
      kept = null;
      raise(signal);
    }
  }
}

/**
 * Whether a `raiseAfter` that is running keeps an interrupt, which it raises
 * when the outermost one ends. A caller whose undo failed reports it before
 * then: no caller sees a result after the raise.
 * @returns {boolean}
 */
export function interruptKept() {
  return kept !== null;
}

/**
 * Words a failed child `r`: the error when Node could not start the child or
 * killed it. A child that a signal ended starts with
 * `<what> was ended by <signal>`, then `: ` and its trimmed stderr, else its
 * trimmed stdout, when it wrote any. Any other child is its trimmed stderr,
 * else its trimmed stdout, else `<what> exited <n>`.
 * @param {{ status?: number | null, signal?: string | null, error?: Error,
 *   stdout?: string | Buffer | null, stderr?: string | Buffer | null }} r
 * @param {string} what  the child, as the message names it (`git fetch`)
 * @returns {string}
 */
export function describeExit(r, what) {
  if (r.error) return r.error.message;
  const text = String(r.stderr ?? '').trim() || String(r.stdout ?? '').trim();
  if (r.signal) return `${what} was ended by ${r.signal}${text ? `: ${text}` : ''}`;
  return text || `${what} exited ${r.status}`;
}

/**
 * The exit status a `spawnSync` result stands for, as a shell reports it
 * (F-70 D3): 127 when the child could not be launched (`error`), 128 + the
 * signal's number when a signal killed it (128 for a name this platform does
 * not know), else its `status`. A result with none of the three (a test fake)
 * is 0. Every caller that turns a child's result into bl's exit status or an
 * `isError` goes through this, never `status ?? 0`, which reads a launch
 * failure or a kill as success.
 * @param {{ status?: number | null, signal?: string | null, error?: Error } | null | undefined} result
 * @returns {number}
 */
export function exitStatus(result) {
  if (result?.error) return 127;
  if (result?.signal) return signalExitCode(result.signal);
  return result?.status ?? 0;
}

/**
 * Say on stderr why a child failed when its status alone would not: it could
 * not be launched, or a signal killed it. A plain nonzero exit says nothing,
 * since the child spoke for itself. Returns `exitStatus(result)`.
 * @param {string} cmd — the command, as the operator would recognise it
 * @param {{ status?: number | null, signal?: string | null, error?: Error }} result
 */
export function reportExit(cmd, result) {
  if (result?.error) console.error(`bl: could not start ${cmd}: ${result.error.message}`);
  else if (result?.signal) console.error(`bl: ${cmd} was killed by ${result.signal}`);
  return exitStatus(result);
}

/**
 * Return `r`, unless an interrupt ended the child: then print the D2 line and
 * raise the interrupt, or keep it inside a `raiseAfter` and return `r`. While
 * `bl` exits (`exiting`), print the line and return `r`.
 * `codes` reads exit 130 and 143 (`EXIT_CODES`) as SIGINT and SIGTERM.
 * @param {ChildResult} r
 * @param {string} child  the argv joined by spaces, or the command line
 * @param {{ codes?: boolean }} [how]
 * @returns {ChildResult}
 */
function settle(r, child, { codes = false } = {}) {
  const signal = interruptOf(r) ?? (codes && !r.error ? signalOfCode(r.status) : null);
  if (!signal) return r;
  // One line: a control character (a newline in a command line) or a Unicode
  // line separator is escaped as JSON escapes it, and as `\uXXXX` where JSON
  // leaves it as it is (DEL, the C1 controls such as NEL, U+2028, U+2029).
  const name = child.replace(/[\p{Cc}\u2028\u2029]/gu, (c) => {
    const json = JSON.stringify(c).slice(1, -1);
    return json !== c ? json : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  try {
    process.stderr.write(`bl: ${name} was ended by ${signal}\n`);
  } catch {
    // A line that cannot be written is lost; the interrupt is still raised or
    // kept, and an `exit` listener still returns.
  }
  if (exiting) return r;
  if (depth > 0) {
    kept ??= signal;
    return r;
  }
  raise(signal);
}

/** Start the argv `command …args` with no shell, whatever `opts.shell` says. */
function spawnArgv(command, args, opts) {
  return spawnSyncFiles(command, args, { ...opts, shell: false });
}

/** The interrupt whose exit code (`EXIT_CODES`) is `status`, or null. */
function signalOfCode(status) {
  return INTERRUPT_SIGNALS.find((signal) => EXIT_CODES[signal] === status) ?? null;
}

/** Raise `signal`; if a listener lets the process go on, exit with its code. */
function raise(signal) {
  raiseSignal(signal);
  process.exit(EXIT_CODES[signal]);
}
