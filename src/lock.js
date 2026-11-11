/**
 * lock.js — the backlog-root lock that serialises mutating bl commands.
 *
 * `bl new` (single-story and batch `--from`) and `bl new --feature` hold it
 * across ID assignment and their follow-up commit; `syncAndCommit` (so
 * `bl sync --commit`, `bl done`, `bl merge`) holds it across the format pass
 * and the commit; `pullBeforeCommand` across the pull; `bl fix` (without
 * `--dry-run`) holds it from its story scan through its last frontmatter
 * write, so two fixes that land on the same story file serialise. The file
 * keeps its historical name `<backlogRoot>/.bl-new.lock`.
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

import { join } from 'path';
import { adopt, release, tryLock } from './kernel-lock.js';
import { awaitLock, LOCK_WAIT_MS, LockWaitTimeout } from './lock-wait.js';

export const LOCK_FILE = '.bl-new.lock';
const LOCK_POLL_MS = 500;

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
 * backlog root) is not adopted, and this process takes its lock as usual.
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
