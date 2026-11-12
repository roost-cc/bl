/**
 * kernel-lock.js — bl's one lock primitive: `flock(2)` on an open file
 * (`fs-ext`, F-104 D1 and K1). Every bl lock takes, releases and checks
 * through this module, and it is the only code that opens a lock file.
 *
 * The kernel holds the lock on the open descriptor and frees it when the
 * descriptor closes or the process ends, so a killed holder leaves no lock.
 * Nothing here decides from a PID whether a lock is held:
 *
 * - A lock file is permanent (D3). Release closes the descriptor; no code
 *   deletes a lock file that bl still takes, because a process that locked a
 *   new file at the same path would then hold "the lock" beside the old
 *   holder. The one exception is the one-off S-1495 migration
 *   (`migrate-lock-files.js`): it deletes retired lock files, each while it
 *   holds that file's lock. Every lock file
 *   in a backlog lives under `.bl/` (`lock.js`), which the backlog's
 *   `.gitignore` ignores.
 * - The PID in the file is information only (D4). The holder truncates the
 *   file and writes `${pid}\n${iso}\n[${info}\n]` after it takes the lock, so
 *   a reader can find the file empty for an instant and shows "unknown".
 * - A bl child under its parent's lock inherits the locked descriptor (D5)
 *   and registers it with `adopt`; it never takes the lock again, because a
 *   `flock` on a new descriptor would wait for itself.
 *
 * This process's held locks live in one map, keyed by the lock's absolute
 * path, with a depth count: a lock is re-entrant in one process, and only the
 * release that brings the depth to zero closes the descriptor.
 */

import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, statSync, writeSync } from 'fs';
import { resolve } from 'path';
import fsExt from 'fs-ext';

const { fcntlSync, flockSync } = fsExt;

/** @typedef {{ path: string, fd: number }} LockHandle */

/** @type {Map<string, { handle: LockHandle, depth: number }>} */
const held = new Map();

/** Whether `flock(fd, 'exnb')` failed because another descriptor holds the lock. */
function isBusy(e) {
  return e?.code === 'EAGAIN' || e?.code === 'EWOULDBLOCK';
}

/** The PID on the first line of `path`, or 'unknown' when the file holds none yet (D4). */
function pidIn(path) {
  let first;
  try {
    first = readFileSync(path, 'utf8').split('\n', 1)[0];
  } catch {
    return 'unknown';
  }
  const pid = Number(first);
  return Number.isInteger(pid) && pid > 0 ? pid : 'unknown';
}

/**
 * The info line of the lock file at `path` (its third line, `tryLock`'s
 * `info`), or null when it holds none. Information only, as the PID (D4).
 *
 * @param {string} path
 * @returns {string | null}
 */
export function infoOf(path) {
  try {
    return readFileSync(resolve(path), 'utf8').split('\n')[2] || null;
  } catch {
    return null;
  }
}

/**
 * One try-lock on `path`, created if missing and never truncated before the
 * lock is taken. Taken: truncate, write `${pid}\n${iso}\n` and `info` as one
 * more line when given (D4), and return `{ taken: handle }`. Held by another
 * descriptor: close ours and return `{ holder: pid | 'unknown' }`. A path this
 * process holds: the same handle, one depth deeper (re-entrant). The return
 * shape is the one `awaitLock`'s `take()` expects (`lock-wait.js`).
 *
 * @param {string} path
 * @param {string} [info]  one line that says what the lock guards
 * @returns {{ taken: LockHandle } | { holder: number | 'unknown' }}
 */
export function tryLock(path, info) {
  const key = resolve(path);
  const mine = held.get(key);
  if (mine) {
    mine.depth += 1;
    return { taken: mine.handle };
  }
  const fd = openSync(key, constants.O_RDWR | constants.O_CREAT, 0o644);
  try {
    flockSync(fd, 'exnb');
  } catch (e) {
    closeSync(fd);
    if (isBusy(e)) return { holder: pidIn(key) };
    throw e;
  }
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n${info == null ? '' : `${info}\n`}`, 0);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  const handle = { path: key, fd };
  held.set(key, { handle, depth: 1 });
  return { taken: handle };
}

/**
 * `tryLock` that is not re-entrant: a lock this process already holds is
 * refused with `{ holder: process.pid }`. For a lock whose holder must not
 * start its guarded work a second time (a run, a report).
 *
 * @param {string} path
 * @param {string} [info]
 * @returns {{ taken: LockHandle } | { holder: number | 'unknown' }}
 */
export function tryLockOnce(path, info) {
  if (held.has(resolve(path))) return { holder: process.pid };
  return tryLock(path, info);
}

/**
 * One depth less; at zero, close the descriptor, which frees the lock. Never
 * `flock(fd, 'un')`: an inherited descriptor (D5) shares its lock with the
 * parent, and an unlock from the child would free the parent's lock too.
 * Never unlinks the file (D3). A handle this process no longer holds is a no-op.
 *
 * @param {LockHandle} handle
 */
export function release(handle) {
  const mine = held.get(handle.path);
  if (mine?.handle !== handle) return;
  mine.depth -= 1;
  if (mine.depth > 0) return;
  held.delete(handle.path);
  closeSync(handle.fd);
}

/**
 * Who holds the lock on `path` (D6): null when it is free or the file is
 * missing (nothing is created); `process.pid` when this process holds it; else
 * the PID in the file, or 'unknown'. A free lock is found with a try-lock on a
 * descriptor of its own, closed at once.
 *
 * @param {string} path
 * @returns {number | 'unknown' | null}
 */
export function holderOf(path) {
  const key = resolve(path);
  if (held.has(key)) return process.pid;
  let fd;
  try {
    fd = openSync(key, constants.O_RDONLY);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    flockSync(fd, 'exnb');
    return null;
  } catch (e) {
    if (isBusy(e)) return pidIn(key);
    throw e;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether this process holds the lock on `path`: it took it (`tryLock`) or
 * adopted it, and has not released it. Decided from this process's own
 * handles, never from the PID in the file (D4).
 *
 * @param {string} path
 * @returns {boolean}
 */
export function holds(path) {
  return held.has(resolve(path));
}

/**
 * Who else holds the lock on `path`: null when it is free, missing, or held
 * by this process (`holds`); else the PID in the file, or 'unknown'. A
 * foreign holder whose file names this process still counts as another
 * holder. Every check that excludes this process's own lock uses this.
 *
 * @param {string} path
 * @returns {number | 'unknown' | null}
 */
export function otherHolder(path) {
  return holds(path) ? null : holderOf(path);
}

/**
 * Register a descriptor this process inherited from its parent (D5) as its
 * handle for `path`, when `fd` is open on that file (the same device and
 * inode) and holds its lock. Else return null and register nothing. A
 * try-lock on `fd` proves the lock: it succeeds on the descriptor that holds
 * it (or takes a free lock), and fails while another descriptor holds it.
 * A path this process already holds is not adopted again. The handle starts at depth 1,
 * which nobody releases: the process holds the lock for the rest of its life.
 * The descriptor is made close-on-exec, as Node opens every file, so the
 * process's own children (git, a formatter) do not hold the lock after it ends.
 *
 * @param {string} path
 * @param {number} fd
 * @returns {LockHandle | null}
 */
export function adopt(path, fd) {
  const key = resolve(path);
  if (held.has(key)) return null;
  try {
    const open = fstatSync(fd, { bigint: true });
    const file = statSync(key, { bigint: true });
    if (open.dev !== file.dev || open.ino !== file.ino) return null;
    flockSync(fd, 'exnb');
  } catch {
    return null;
  }
  fcntlSync(fd, 'setfd', fsExt.constants.FD_CLOEXEC);
  const handle = { path: key, fd };
  held.set(key, { handle, depth: 1 });
  return handle;
}
