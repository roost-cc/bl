/**
 * lock.js — the backlog-root lockfile that serialises mutating bl commands.
 *
 * `bl new` (single-story and batch `--from`) and `bl new --feature` hold it
 * across ID assignment and their follow-up sync; `runSync` (so `bl sync`,
 * `bl sync --commit`, `bl merge`) holds it across index
 * regeneration and, for `--commit`, the commit; `bl fix` (without
 * `--dry-run`) holds it from its story scan through its last frontmatter
 * write, so two fixes that land on the same story file serialise. The file
 * keeps its historical name `<backlogRoot>/.bl-new.lock`. Stale locks (whose
 * owning PID is no longer alive) are reclaimed automatically.
 *
 * The lock is re-entrant within a process: `bl new` acquires it and then calls
 * `runSync`, which acquires it again. Each acquire bumps a depth count; only
 * the release that brings it back to zero removes the file.
 *
 * A bl child its holder runs under the lock (`bl side` runs `bl new`, F-48)
 * works under the parent's: the parent sets `BL_LOCK_HOLDER` to its pid in the
 * child's environment, and the child's acquire returns at once while the lock
 * file names that pid and it is the child's parent. The child never removes
 * the file.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export const LOCK_FILE = '.bl-new.lock';
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 500;

// Locks held by this process, mapped to their re-entrancy depth. Cleanup
// handlers are registered once at module init (below) and walk this map on
// exit/SIGINT/SIGTERM.
const heldLocks = new Map();

function cleanupAll() {
  for (const path of heldLocks.keys()) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
  heldLocks.clear();
}

export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(backlogRoot) {
  const lockPath = join(backlogRoot, LOCK_FILE);
  const depth = heldLocks.get(lockPath);
  if (depth == null) return;
  if (depth > 1) {
    heldLocks.set(lockPath, depth - 1);
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
  heldLocks.delete(lockPath);
}

process.on('exit', cleanupAll);
process.on('SIGINT', () => {
  cleanupAll();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupAll();
  process.exit(143);
});

export async function acquireLock(backlogRoot, options = {}) {
  const {
    kill = process.kill,
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = LOCK_TIMEOUT_MS,
    pollMs = LOCK_POLL_MS,
    exit = process.exit,
    error = console.error,
  } = options;
  const lockPath = join(backlogRoot, LOCK_FILE);
  const depth = heldLocks.get(lockPath);
  if (depth != null) {
    heldLocks.set(lockPath, depth + 1);
    return;
  }
  if (heldByParent(lockPath)) return;
  const start = now().getTime();
  let announced = false;

  while (true) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${now().toISOString()}\n`, {
        flag: 'wx',
      });
      heldLocks.set(lockPath, 1);
      return;
    } catch {
      if (existsSync(lockPath)) {
        try {
          const content = readFileSync(lockPath, 'utf8');
          const pid = parseInt(content.split('\n')[0], 10);
          if (!isPidAlive(pid, kill)) {
            try {
              unlinkSync(lockPath);
              continue;
            } catch {
              // try again
            }
          } else if (!announced) {
            // Said once, so a caller (or a test) can tell a process blocked
            // on a live holder from one still doing its pre-lock work.
            announced = true;
            error(`Waiting for lock (${LOCK_FILE}) held by pid ${pid}…`);
          }
        } catch {
          // try again
        }
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
