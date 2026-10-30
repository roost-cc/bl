/**
 * run-bl.js — spawn the local bin/bl with captured streams.
 *
 * Every integration test uses this helper so the spawned child resolves the
 * tempdir as its backlog (via BL_BACKLOG_DIR) and never touches the real
 * one, and finds refusing agent stubs first on PATH (`withNoAgent`) so it
 * never reaches a real agent. Returns { stdout, stderr, status } from
 * spawnSync.
 */

import { spawn, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { LOCK_FILE } from '../../src/lock.js';
import { withNoAgent } from './fake-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const BL_BIN = join(REPO_ROOT, 'bin', 'bl');

/**
 * Spawn `bl <args>` against a tempdir backlog.
 *
 * `cwd` is required: it doubles as BL_BACKLOG_DIR for the spawned child.
 * Defaulting to process.cwd() would cause a forgetful caller to resolve the
 * developer's actual repo as the backlog and write into it.
 *
 * @param {string[]} args            CLI args to pass to bl
 * @param {object}   opts
 * @param {string}   opts.cwd        working directory + BL_BACKLOG_DIR (required)
 * @param {object}   [opts.env]      extra env vars (override the inherited env)
 * @param {string}   [opts.input]    written to the child's stdin
 * @returns {{ stdout: string, stderr: string, status: number | null,
 *            signal: NodeJS.Signals | null }}
 *          `signal` is non-null when the child died on a signal (in which
 *          case `status` is `null`). Surfacing it lets test failures say
 *          "killed by SIGTERM" instead of just "null !== 0".
 */
export function runBl(args, opts = {}) {
  const { cwd } = opts;
  if (!cwd) {
    throw new Error('runBl: opts.cwd is required (must be a tempdir backlog root)');
  }
  const env = withNoAgent({
    ...process.env,
    BL_BACKLOG_DIR: cwd,
    ...(opts.env ?? {}),
  });
  const result = spawnSync(BL_BIN, args, {
    cwd,
    env,
    encoding: 'utf8',
    ...(opts.input != null ? { input: opts.input } : {}),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal ?? null,
  };
}

/**
 * Start `bl <args>` while this process holds the backlog lock, and report
 * when the child says it is blocked on that lock. `acquireLock` prints
 * `Waiting for lock (.bl-new.lock) held by pid <ours>…` once, only for a
 * live holder and only after every pre-lock step, so a test that waits for
 * it observes the child at the lock instead of guessing from a delay.
 *
 * The caller takes the lock before calling (via `acquireLock`, or by writing
 * the lock file with this process's pid) and releases it afterwards. The
 * helper throws before spawning unless the lock file in the child's backlog
 * root (`BL_BACKLOG_DIR`, after `opts.env`) names this process, so a
 * caller cannot wait on a lock the child will never see as ours.
 *
 * @param {string[]} args              CLI args to pass to bl
 * @param {object}   opts
 * @param {string}   opts.cwd          working directory + BL_BACKLOG_DIR (required)
 * @param {object}   [opts.env]        extra env vars (override the inherited env)
 * @param {number}   [opts.timeoutMs]  how long to wait for the announcement
 * @param {string}   [opts.bin]        executable to run instead of bin/bl
 *                                     (tests of this helper only)
 * @returns {{ blocked: Promise<void>,
 *            closed: Promise<{ stdout: string, stderr: string,
 *                              status: number | null,
 *                              signal: NodeJS.Signals | null }> }}
 *          `blocked` resolves on the announced wait. Otherwise it rejects
 *          once the child is gone, never before: when the child exits first,
 *          fails to start, or stays silent past `timeoutMs` (killed with
 *          SIGTERM, then SIGKILL if it is still running a second later), so
 *          a caller that then releases the lock and removes the tempdir does
 *          not do so under a running child. `closed` always resolves, with
 *          `status` and `signal` null when the child never started.
 */
export function startBlBehindLock(args, opts = {}) {
  const { cwd, timeoutMs = 15_000, bin = BL_BIN } = opts;
  if (!cwd) {
    throw new Error('startBlBehindLock: opts.cwd is required (must be a tempdir backlog root)');
  }
  const env = withNoAgent({
    ...process.env,
    BL_BACKLOG_DIR: cwd,
    ...(opts.env ?? {}),
  });
  const lockPath = join(env.BL_BACKLOG_DIR, LOCK_FILE);
  const lockText = () => {
    try {
      return readFileSync(lockPath, 'utf8');
    } catch (err) {
      return err.code;
    }
  };
  if (parseInt(lockText(), 10) !== process.pid) {
    throw new Error(
      `startBlBehindLock: ${lockPath} must name this process (pid ${process.pid}), found ${JSON.stringify(lockText())}`,
    );
  }
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Decode as a stream so a multi-byte character split across chunks (the
  // "…" in the announcement) is not mangled into replacement characters.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  // A child that cannot start emits "error" and never "close"; record it (and
  // any stream error) instead of letting it crash the test runner.
  let failure = null;
  const noteFailure = (err) => (failure ??= err);
  child.stdout.on('error', noteFailure);
  child.stderr.on('error', noteFailure);
  child.stdout.on('data', (b) => (stdout += b));
  const closed = new Promise((resolve) => {
    const finish = (status, signal) => resolve({ stdout, stderr, status, signal: signal ?? null });
    child.on('close', finish);
    child.on('error', (err) => {
      noteFailure(err);
      if (child.pid === undefined) finish(null, null);
    });
  });
  const waiting = new RegExp(`^Waiting for lock \\(\\.bl-new\\.lock\\) held by pid ${process.pid}…$`, 'm');
  let announced = false;
  const blocked = new Promise((resolve, reject) => {
    let why = 'bl exited before waiting for the lock';
    let force;
    const timer = setTimeout(() => {
      why = `bl never reported waiting for the lock within ${timeoutMs} ms (lock file then: ${JSON.stringify(lockText())})`;
      child.kill();
      force = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
    child.stderr.on('data', (b) => {
      stderr += b;
      if (announced || !waiting.test(stderr)) return;
      announced = true;
      clearTimeout(timer);
      resolve();
    });
    closed.then(({ status, signal }) => {
      clearTimeout(timer);
      clearTimeout(force);
      if (announced) return;
      if (failure) why += ` (${failure.message})`;
      reject(new Error(`${why}, status ${status}, signal ${signal}: ${stderr}`));
    });
  });
  return { blocked, closed };
}

/** Why a lock-wait test skips where its children cannot see it. */
export const PID_ISOLATED = "PID-isolated runner: lock-owner liveness can't be observed";

/**
 * Whether a spawned process sees `pid` as live through `kill(pid, 0)`, the
 * check `acquireLock` makes before it announces a wait. A sandbox that hides
 * this process from its children fails it, and there a child behind our lock
 * never announces the wait.
 *
 * @param {number} [pid]
 * @returns {boolean}
 */
export function childSeesPid(pid = process.pid) {
  const r = spawnSync(process.execPath, ['-e', `process.kill(${pid}, 0)`], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

let childSeesUs;

/**
 * Guard a lock-wait test (one that uses `startBlBehindLock`): true when a
 * child can see this process as a live lock owner. Otherwise skip the test
 * with `PID_ISOLATED` and return false, or throw when
 * `BL_REQUIRE_PID_TESTS=1`. The `bl-tests` gate sets that, so the gate can
 * never skip these tests silently.
 *
 * @param {{ skip: (message: string) => void }} t  the node:test context
 * @param {object} [opts]
 * @param {() => boolean} [opts.probe]  defaults to `childSeesPid()`, run
 *                                      once per test process
 * @param {Record<string, string | undefined>} [opts.env]
 * @returns {boolean}
 */
export function lockOwnerVisible(t, opts = {}) {
  const { probe = () => (childSeesUs ??= childSeesPid()), env = process.env } = opts;
  if (probe()) return true;
  if (env.BL_REQUIRE_PID_TESTS === '1') {
    throw new Error(`${PID_ISOLATED} (BL_REQUIRE_PID_TESTS=1 forbids a skip)`);
  }
  t.skip(PID_ISOLATED);
  return false;
}
