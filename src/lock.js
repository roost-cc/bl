/**
 * lock.js — the backlog-root lockfile that serialises mutating bl commands.
 *
 * `bl new` (single-story and batch `--from`) and `bl new --feature` hold it
 * across ID assignment and their follow-up commit; `syncAndCommit` (so
 * `bl sync --commit`, `bl done`, `bl merge`) holds it across the format pass
 * and the commit; `pullBeforeCommand` across the pull; `bl fix` (without
 * `--dry-run`) holds it from its story scan through its last frontmatter
 * write, so two fixes that land on the same story file serialise. The file
 * keeps its historical name `<backlogRoot>/.bl-new.lock`. `pid-lock.js` takes
 * and releases it: the file is created whole (its name never exists without
 * the holder's PID in it), a lock whose holder is dead is reclaimed only under
 * its `.reclaim` mutex, and a release removes the file only while it still
 * holds this process's content (S-1397). The exit and signal handlers remove
 * only the lock itself: a temp file (`.bl-new.lock.<pid>.<random>.tmp`) or a
 * `.bl-new.lock.reclaim` mutex that a killed process leaves stays in the
 * backlog root.
 *
 * The lock is re-entrant within a process: `bl new` acquires it and then calls
 * `syncAndCommit`, which acquires it again. Each acquire bumps a depth count; only
 * the release that brings it back to zero removes the file.
 *
 * A bl child its holder runs under the lock (`bl side` runs `bl new`, F-48)
 * works under the parent's: the parent sets `BL_LOCK_HOLDER` to its pid in the
 * child's environment, and the child's acquire returns at once while the lock
 * file names that pid and it is the child's parent. The child never removes
 * the file.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { awaitLock, LockWaitTimeout } from './lock-wait.js';
import { acquirePidLock, releasePidLock } from './pid-lock.js';
import { exitOnSignal } from './signal-exit.js';

export const LOCK_FILE = '.bl-new.lock';
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 500;

// Locks held by this process, mapped to their re-entrancy depth and the
// content this process wrote. The `exit` listener registered at module init
// (below) walks this map. On SIGINT or SIGTERM, the handler in signal-exit.js
// calls process.exit, so it runs too. The listener removes the lock files
// only, not a temp file that a killed process leaves.
/** @type {Map<string, { depth: number, content: string }>} */
const heldLocks = new Map();

function cleanupAll() {
  for (const [path, { content }] of heldLocks) releasePidLock(path, content);
  heldLocks.clear();
}

export function releaseLock(backlogRoot) {
  const lockPath = join(backlogRoot, LOCK_FILE);
  const held = heldLocks.get(lockPath);
  if (held == null) return;
  if (held.depth > 1) {
    held.depth -= 1;
    return;
  }
  releasePidLock(lockPath, held.content);
  heldLocks.delete(lockPath);
}

process.on('exit', cleanupAll);
// SIGINT and SIGTERM end the process with process.exit(130|143), so the exit listener above runs.
exitOnSignal();

/**
 * Take the backlog lock, waiting through `awaitLock` (`lock-wait.js`) up to
 * `timeoutMs` (60 s, F-104 D2) for a live holder. The wait is announced once
 * on `error`. On a timeout it prints the holder on `error` and calls
 * `exit(1)`. `now` stamps the lock's content; `sleep` is the wait's test seam.
 */
export async function acquireLock(backlogRoot, options = {}) {
  const {
    now = () => new Date(),
    sleep,
    timeoutMs = LOCK_TIMEOUT_MS,
    pollMs = LOCK_POLL_MS,
    exit = process.exit,
    error = console.error,
  } = options;
  const lockPath = join(backlogRoot, LOCK_FILE);
  const held = heldLocks.get(lockPath);
  if (held != null) {
    held.depth += 1;
    return;
  }
  if (heldByParent(lockPath)) return;
  const take = () => {
    const got = acquirePidLock(lockPath, `${process.pid}\n${now().toISOString()}\n`);
    return 'content' in got ? { taken: got.content } : got;
  };
  let content;
  try {
    content = await awaitLock(LOCK_FILE, take, { deadlineMs: timeoutMs, pollMs, announce: error, sleep });
  } catch (e) {
    if (!(e instanceof LockWaitTimeout)) throw e;
    error(e.message);
    exit(1);
    return;
  }
  heldLocks.set(lockPath, { depth: 1, content });
}

/** Whether the lock file names this process's parent, which passed it down in `BL_LOCK_HOLDER`. */
function heldByParent(lockPath) {
  const holder = parseInt(process.env.BL_LOCK_HOLDER ?? '', 10);
  if (!Number.isInteger(holder) || holder !== process.ppid) return false;
  try {
    return parseInt(readFileSync(lockPath, 'utf8').split('\n')[0], 10) === holder;
  } catch {
    return false;
  }
}

/** Run `fn` while holding the backlog lock, releasing it however `fn` ends. */
export async function withLock(backlogRoot, fn, options = {}) {
  await acquireLock(backlogRoot, options);
  try {
    return await fn();
  } finally {
    releaseLock(backlogRoot);
  }
}
