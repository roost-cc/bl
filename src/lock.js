/**
 * lock.js — the backlog-root lock that serialises mutating bl commands.
 *
 * `bl new` (single-story and batch `--from`) and `bl new --feature` hold it
 * across ID assignment and their follow-up commit; `syncAndCommit` (so
 * `bl sync --commit`, `bl done`, `bl merge`) holds it across the format pass
 * and the commit; `pullBeforeCommand` across the pull; `bl fix` (without
 * `--dry-run`) holds it from its story scan through its last frontmatter
 * write, so two fixes that land on the same story file serialise. The file
 * is `<backlogRoot>/.bl/lock/backlog.lock` (`LOCK_FILE`).
 *
 * Every lock file bl keeps in a backlog lives under `.bl/` (S-1495), which
 * the backlog's `.gitignore` ignores, so git never sees one: the backlog
 * lock, the session locks and the report locks in `.bl/lock/` (`LOCK_DIR`,
 * `dirLockPath`), and the run locks in `.bl/run/` (`run-lock.js`).
 *
 * It is a kernel lock (`kernel-lock.js`, F-104 K1): the kernel frees it when
 * the holder closes the descriptor or ends, even by SIGKILL. The file stays
 * (D3), so this module registers no exit or signal handler.
 *
 * The lock is re-entrant within a process: `bl new` acquires it and then calls
 * `syncAndCommit`, which acquires it again. `kernel-lock.js` counts the depth;
 * only the release that brings it back to zero frees the lock.
 *
 * A bl child its holder runs under the lock (`bl side` runs `bl new`, F-48)
 * works under the parent's (D5): the parent passes the locked descriptor to
 * the child and names its number in `BL_LOCK_FD`, and the child's first
 * acquire adopts it. The child holds the lock as long as it lives.
 */

import { createHash } from 'crypto';
import { mkdirSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { adopt, release, tryLock } from './kernel-lock.js';
import { awaitLock, LOCK_WAIT_MS, LockWaitTimeout } from './lock-wait.js';

/** The directory of bl's lock files in a backlog, backlog-relative. */
export const LOCK_DIR = join('.bl', 'lock');
/** The backlog lock file, backlog-relative. */
export const LOCK_FILE = join(LOCK_DIR, 'backlog.lock');
const LOCK_POLL_MS = 500;

/**
 * Absolute `path` with the links of its longest existing ancestor resolved,
 * so a path saved through a link compares equal to the real path, even when
 * the path itself is not there (yet, or any more).
 *
 * @param {string} path
 */
export function canonical(path) {
  const rest = [];
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      return join(realpathSync(p), ...rest);
    } catch {
      if (dirname(p) === p) return resolve(path);
      rest.unshift(basename(p));
    }
  }
}

/**
 * The lock file of `kind` for the directory `dir`, one per directory:
 * `<backlogRoot>/.bl/lock/<kind>-<base name>-<hash>.lock`. The base name of
 * `dir` makes it readable; a hash of `dir`'s `canonical` path keeps two
 * directories with one base name apart, and gives a directory reached through
 * a link (a configured unit directory) the file of its real path (the one
 * `git worktree list` gives).
 *
 * @param {string} backlogRoot
 * @param {string} kind  `session` or `report`
 * @param {string} dir
 */
export function dirLockPath(backlogRoot, kind, dir) {
  const abs = canonical(dir);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 12);
  return join(backlogRoot, LOCK_DIR, `${kind}-${basename(abs)}-${hash}.lock`);
}

/**
 * Create `<backlogRoot>/.bl/lock/` when it is missing, before a take opens
 * (and creates) a lock file in it. A missing backlog root is not created: the
 * error (ENOENT) is thrown.
 *
 * @param {string} backlogRoot
 */
export function ensureLockDir(backlogRoot) {
  for (const dir of [dirname(LOCK_DIR), LOCK_DIR]) {
    try {
      mkdirSync(join(backlogRoot, dir));
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

/** The environment variable that names the descriptor a bl parent passed down locked (D5). */
export const LOCK_FD_ENV = 'BL_LOCK_FD';

// The handle each backlog root's lock was last taken with, so `releaseLock`
// can name it. `kernel-lock.js` keeps the depth: a release of a handle it no
// longer holds does nothing.
/** @type {Map<string, import('./kernel-lock.js').LockHandle>} */
const handles = new Map();

// Whether this process adopted the descriptor its parent passed in `BL_LOCK_FD` (D5).
let adopted = false;

export function releaseLock(backlogRoot) {
  const handle = handles.get(backlogRoot);
  if (handle != null) release(handle);
}

/**
 * Adopt the locked descriptor a bl parent passed down for `lockPath` (D5), at
 * most once. A descriptor open on another file (the parent locked another
 * backlog root), or one that does not hold the lock while another process
 * does, is not adopted, and this process takes its lock as usual.
 */
function adoptInherited(lockPath) {
  const raw = process.env[LOCK_FD_ENV];
  if (adopted || !raw || !Number.isInteger(Number(raw))) return;
  adopted = adopt(lockPath, Number(raw)) != null;
}

/**
 * Take the backlog lock, waiting through `awaitLock` (`lock-wait.js`) up to
 * `timeoutMs` (60 s, F-104 D2) for a live holder. The wait is announced once
 * on `error`. On a timeout it prints the holder on `error` and calls
 * `exit(1)`. `sleep` is the wait's test seam. Resolves the lock's handle,
 * which `bl side` passes to its `bl new` child (D5).
 *
 * @returns {Promise<import('./kernel-lock.js').LockHandle | undefined>}
 */
export async function acquireLock(backlogRoot, options = {}) {
  const {
    sleep,
    timeoutMs = LOCK_WAIT_MS,
    pollMs = LOCK_POLL_MS,
    exit = process.exit,
    error = console.error,
  } = options;
  const lockPath = join(backlogRoot, LOCK_FILE);
  ensureLockDir(backlogRoot);
  adoptInherited(lockPath);
  try {
    const { taken } = await awaitLock(LOCK_FILE, () => tryLock(lockPath), {
      deadlineMs: timeoutMs,
      pollMs,
      announce: error,
      sleep,
    });
    handles.set(backlogRoot, taken);
    return taken;
  } catch (e) {
    if (!(e instanceof LockWaitTimeout)) throw e;
    error(e.message);
    exit(1);
  }
}

/**
 * Run `fn(handle)` while holding the backlog lock, releasing it however `fn`
 * ends. `handle` is the lock's (`acquireLock`).
 *
 * @template T
 * @param {string} backlogRoot
 * @param {(handle: import('./kernel-lock.js').LockHandle | undefined) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(backlogRoot, fn, options = {}) {
  const handle = await acquireLock(backlogRoot, options);
  try {
    return await fn(handle);
  } finally {
    releaseLock(backlogRoot);
  }
}
