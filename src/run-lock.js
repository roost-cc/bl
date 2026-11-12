/**
 * run-lock.js — where bl's run locks and run state live, the run lock itself,
 * and the lock the `bl updates` commands share. A run lock is a kernel lock
 * (`kernel-lock.js`, F-104): its file stays, and a killed run leaves no lock.
 * A run lock never waits: a held lock is refused.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { holderOf, infoOf, release, tryLockOnce } from './kernel-lock.js';

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
 * The stop request of `id` (`stopRequestPath`): `{ pid, at, holder }`, where
 * `holder` is the pid of the `bl run` it stops. Null when there is none, or
 * when it is not whole JSON yet (`bl stop` is writing it).
 */
export function readStopRequest(config, featureId) {
  try {
    return JSON.parse(readFileSync(stopRequestPath(config, featureId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Who holds `id`'s run lock (`holderOf`): null when it is free; else
 * `{ pid, run }`. `pid` is the holder's pid, or 'unknown'. `run` is true when
 * the holder is a `bl run` of `id`: the lock's info line (`infoOf`), which
 * `takeRunLocks` writes as `bl run <id>`, `bl review <id>` or `bl merge <id>`.
 */
export function runHolder(config, featureId) {
  const path = runLockPath(config, featureId);
  const pid = holderOf(path);
  return pid == null ? null : { pid, run: infoOf(path) === `bl run ${featureId}` };
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
 * Take the run lock of `id` for `info`, the lock file's info line (`bl run
 * <id>` by default; `runHolder` reads it): `{ taken: handle }`, or
 * `{ holder }` when another process holds it. A lock this process already
 * holds is refused with `process.pid` too (`tryLockOnce`): one process runs a
 * unit once.
 *
 * @returns {{ taken: import('./kernel-lock.js').LockHandle } | { holder: number | 'unknown' }}
 */
export function acquireRunLock(config, id, info = `bl run ${id}`) {
  ensureRunDir(config);
  return tryLockOnce(runLockPath(config, id), info);
}

/** Free a run lock that `acquireRunLock` took. The file stays. */
export function releaseRunLock(handle) {
  release(handle);
}

/** The refusal of a `bl updates` command when another one holds the `updates` lock. */
export function updatesLockRefusal(config, holder) {
  return `another bl updates command (pid ${holder}) holds ${runLockPath(config, RUN_LOCK_ID)}; try again when it ends`;
}
