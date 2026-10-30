/**
 * pid-lock.js — exclusive lock files that name their holder's PID on the
 * first line.
 *
 * A lock is created whole and exclusively (written to a private temp file,
 * then hard-linked into place, which fails if the lock exists), so two
 * processes racing for a free lock cannot both win and nobody ever reads a
 * half-written one. A lock whose holder is dead is reclaimed only under the
 * `<lock>.reclaim` mutex, which is taken the same way: the reclaimer re-reads
 * the lock there and removes it only if it still holds what that read found
 * and its holder is dead. A process that saw a stale lock earlier can
 * therefore never remove the fresh lock a faster reclaimer has just taken,
 * and a lock that is missing (just released) is never "reclaimed": the
 * caller only tries to create it again, so a holder that takes it meanwhile
 * keeps it.
 */

import { readFileSync, writeFileSync, unlinkSync, linkSync } from 'fs';

/** PID on a lock file's first line when that process is alive, else null. */
export function liveLockHolder(lockPath) {
  const content = readMaybe(lockPath);
  return content == null ? null : liveHolderOf(content);
}

/** PID on lock content's first line when that process is alive, else null. */
function liveHolderOf(content) {
  const pid = parseInt(content.split('\n', 1)[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Create `path` holding `content`, atomically and only if it does not exist. */
function createExclusive(path, content) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

/** Remove `path` only if it still holds `content`. */
export function releasePidLock(path, content) {
  try {
    if (readFileSync(path, 'utf8') === content) unlinkSync(path);
  } catch {
    // already gone
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove `lockPath` if its holder is dead, under the reclaim mutex. Returns
 * false when another process is reclaiming it right now.
 */
function reclaimStale(lockPath) {
  const mutex = `${lockPath}.reclaim`;
  const token = `${process.pid}\n${new Date().toISOString()}\nreclaim\n`;
  if (!createExclusive(mutex, token)) {
    // A reclaimer that died inside the mutex (it is held for microseconds)
    // would otherwise block every later reclaim. One read decides: a mutex
    // released and retaken since is not the dead one, and stays.
    const held = readMaybe(mutex);
    if (held != null && liveHolderOf(held) == null) releasePidLock(mutex, held);
    return false;
  }
  try {
    // Only the dead holder's lock, as read here: a missing lock was released,
    // and the next create may race a new holder for it, never remove one.
    const stale = readMaybe(lockPath);
    if (stale != null && liveHolderOf(stale) == null) releasePidLock(lockPath, stale);
  } finally {
    releasePidLock(mutex, token);
  }
  return true;
}

function readMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Take `lockPath` with `content` (first line: this process's PID). Returns
 * `{ content }` when taken, `{ holder }` when a live process holds it.
 * `hooks.beforeReclaim` is a test seam, called after a stale lock is seen and
 * before it is reclaimed.
 */
export function acquirePidLock(lockPath, content, hooks = {}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (createExclusive(lockPath, content)) return { content };
    const holder = liveLockHolder(lockPath);
    if (holder != null) return { holder };
    hooks.beforeReclaim?.();
    if (!reclaimStale(lockPath)) sleepMs(10);
  }
  return { holder: liveLockHolder(lockPath) ?? 'unknown' };
}
