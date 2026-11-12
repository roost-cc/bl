/**
 * run-lock.js — where bl's run locks and run state live, the run lock itself,
 * and the lock the `bl updates` commands share. A run lock is a kernel lock
 * (`kernel-lock.js`, F-104): its file stays, and a killed run leaves no lock.
 * A run lock never waits: a held lock is refused.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { holderFileOf, release, tryLockOnce } from './kernel-lock.js';

/** The run directory under the backlog root: machine-local scratch. */
export const RUN_DIR = join('.bl', 'run');

/** The run lock id `bl updates sync`, `vulns`, `run`, `approve` and `drop` share. */
export const RUN_LOCK_ID = 'updates';

/** `<backlog>/.bl/run/<id>.lock`. */
export function runLockPath(config, featureId) {
  return join(config.backlogRoot, RUN_DIR, `${featureId}.lock`);
}

/**
 * `<backlog>/.bl/run/<id>.stop/`: the stop requests that `bl stop` writes for
 * the bl that holds `id`'s run lock (F-87 D7a), one file for each `bl stop`
 * (`writeStopRequest`). The loop checks them at each step start and after
 * each scoped spawn; `takeRunLocks` deletes the ones for an earlier holder.
 */
export function stopRequestDir(config, featureId) {
  return join(config.backlogRoot, RUN_DIR, `${featureId}.stop`);
}

/**
 * Write the stop request of this `bl stop` for `holder`, the pid of the `bl
 * run` it stops: `{ pid, at, holder }` in a new file of its own in
 * `stopRequestDir` (`<pid>-<uuid>.json`), and return its path. So no other
 * `bl stop` writes or deletes it. A write that fails deletes its own file and
 * throws; every other request stays as it was.
 *
 * @returns {string}
 */
export function writeStopRequest(config, featureId, holder) {
  ensureRunDir(config);
  const dir = stopRequestDir(config, featureId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${process.pid}-${randomUUID()}.json`);
  try {
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), holder })}\n`, {
      flag: 'wx',
    });
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
  return path;
}

/**
 * The stop requests of `id` (`stopRequestDir`): `[{ path, request }]`, where
 * `request` is `{ pid, at, holder }`. A file that is gone, or not whole JSON
 * yet (its `bl stop` is writing it), is left out. No directory: none.
 *
 * @returns {{ path: string, request: { pid?: number, at?: string, holder?: number } }[]}
 */
export function stopRequests(config, featureId) {
  const dir = stopRequestDir(config, featureId);
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const path = join(dir, name);
    try {
      out.push({ path, request: JSON.parse(readFileSync(path, 'utf8')) });
    } catch {
      // Gone since the listing, or still being written.
    }
  }
  return out;
}

/**
 * Who holds `id`'s run lock (`holderFileOf`): null when it is free; else
 * `{ pid, run }`. `pid` is the holder's pid, or 'unknown'. `run` is true when
 * the holder is a `bl run` of `id`: the lock's info line, which
 * `takeRunLocks` writes as `bl run <id>`, `bl review <id>` or `bl merge <id>`.
 * Both come from one read of the lock file, so they are one holder's.
 */
export function runHolder(config, featureId) {
  const holder = holderFileOf(runLockPath(config, featureId));
  return holder == null ? null : { pid: holder.pid, run: holder.info === `bl run ${featureId}` };
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
