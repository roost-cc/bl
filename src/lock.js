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
import { acquirePidLock, releasePidLock } from './pid-lock.js';
import { exitOnSignal } from './signal-exit.js';

export const LOCK_FILE = '.bl-new.lock';
const LOCK_TIMEOUT_MS = 30_000;
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

export async function acquireLock(backlogRoot, options = {}) {
  const {
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
  const start = now().getTime();
  let announced = false;

  while (true) {
    const taken = acquirePidLock(lockPath, `${process.pid}\n${now().toISOString()}\n`);
    if ('content' in taken) {
      heldLocks.set(lockPath, { depth: 1, content: taken.content });
      return;
    }
    if (!announced) {
      // Said once, so a caller (or a test) can tell a process blocked on a
      // live holder from one still doing its pre-lock work.
      announced = true;
      error(`Waiting for lock (${LOCK_FILE}) held by pid ${taken.holder}…`);
    }
    if (now().getTime() - start > timeoutMs) {
      error(`Timed out waiting for lock (${LOCK_FILE}). Another bl process may be stuck.`);
      error(`Remove manually: rm "${lockPath}"`);
      exit(1);
      return;
    }
    await sleep(pollMs);
  }
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
