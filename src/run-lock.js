/**
 * run-lock.js — where bl's run locks and run state live, the run lock itself,
 * and the lock the `bl updates` commands share. A run lock is a kernel lock
 * (`kernel-lock.js`, F-104): its file stays, and a killed run leaves no lock.
 * A run lock never waits: a held lock is refused.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { release, tryLockOnce } from './kernel-lock.js';

/** The run directory under the backlog root: machine-local scratch. */
export const RUN_DIR = join('.bl', 'run');

/** The run lock id `bl updates sync`, `vulns`, `run`, `approve` and `drop` share. */
export const RUN_LOCK_ID = 'updates';

/** `<backlog>/.bl/run/<id>.lock`. */
export function runLockPath(config, featureId) {
  return join(config.backlogRoot, RUN_DIR, `${featureId}.lock`);
}

/**
 * `<backlog>/.bl/run/<id>.stop`: the stop request `bl stop` writes for the
 * bl that holds `id`'s run lock (F-87 D7a). The loop checks it at each step
 * start and after each scoped spawn; `takeRunLocks` deletes a leftover one.
 */
export function stopRequestPath(config, featureId) {
  return join(config.backlogRoot, RUN_DIR, `${featureId}.stop`);
}

/**
 * A run state's status as `bl top` and `bl watch` show it: `stale` for one
 * that says `running` while no process holds its run lock (its bl died).
 * `holder` is the lock's holder (`holderOf(runLockPath())`), or null.
 */
export function runStatus(state, holder) {
  return state.status === 'running' && holder == null ? 'stale' : state.status;
}

export function ensureRunDir(config) {
  const dir = join(config.backlogRoot, RUN_DIR);
  mkdirSync(dir, { recursive: true });
  // Self-ignoring directory: run state is machine-local scratch and must never
  // ride along with a backlog commit.
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '*\n');
}

/**
 * Take the run lock of `id`: `{ taken: handle }`, or `{ holder }` when another
 * process holds it. A lock this process already holds is refused with
 * `process.pid` too (`tryLockOnce`): one process runs a unit once.
 *
 * @returns {{ taken: import('./kernel-lock.js').LockHandle } | { holder: number | 'unknown' }}
 */
export function acquireRunLock(config, id) {
  ensureRunDir(config);
  return tryLockOnce(runLockPath(config, id), `bl run ${id}`);
}

/** Free a run lock that `acquireRunLock` took. The file stays. */
export function releaseRunLock(handle) {
  release(handle);
}

/** The refusal of a `bl updates` command when another one holds the `updates` lock. */
export function updatesLockRefusal(config, holder) {
  return `another bl updates command (pid ${holder}) holds ${runLockPath(config, RUN_LOCK_ID)}; try again when it ends`;
}
