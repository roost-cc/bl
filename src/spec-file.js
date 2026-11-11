/**
 * spec-file.js — the one read-modify-write of a story or feature spec (F-67).
 *
 * `updateSpecFile(backlogRoot, indexPath, mutate)` reads a spec under its
 * spec lock, refuses a file with no `---` frontmatter block, lets `mutate`
 * change the frontmatter and body, and replaces the file atomically
 * (`atomicWriteFile`), so a writer that dies, runs out of disk or overlaps
 * another `bl` never leaves a truncated, doubled-fence or stale spec behind.
 *
 * `withSpecLock(indexPath, fn)` is the lock: a kernel lock (`kernel-lock.js`,
 * F-104) on a file in the temp dir keyed by the spec's real path. The file
 * stays after release (F-104 D3). It is re-entrant within a process,
 * awaits its wait (`awaitLock`, F-105 W1) and rejects with `SpecLockError`
 * when the lock never frees. Its `fn` is synchronous, so a nested write in it
 * calls `updateSpecFileHeld`.
 *
 * Lock order (F-67 D4): the backlog lock (`lock.js`) is the outer lock, a
 * spec lock the inner one. Nothing takes the backlog lock while holding a
 * spec lock, and nothing holds two spec locks at once.
 */

import { readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { FrontmatterError, info, parseFrontmatterOf, serializeFrontmatter } from './config.js';
import { awaitLock, LOCK_WAIT_MS, LockWaitTimeout } from './lock-wait.js';
import { holderOf, release, tryLock } from './kernel-lock.js';
import { atomicWriteFile } from './atomic-write.js';

/** The spec lock could not be taken: held by a live process past the wait, or not creatable. */
export class SpecLockError extends Error {
  constructor(message, { indexPath, holder = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SpecLockError';
    this.indexPath = indexPath;
    this.holder = holder;
  }
}

/**
 * The lock file every writer of `indexPath` shares: in the temp dir, keyed by
 * the spec's real path, so the backlog never sees it. The `bl-tokens-` name
 * is the one the token writers used before F-67. The file stays after
 * release (F-104 D3).
 */
export function specLockPath(indexPath) {
  let path = resolve(indexPath);
  try {
    path = realpathSync(path);
  } catch {
    // not there (yet): the resolved path
  }
  return join(tmpdir(), `bl-tokens-${createHash('sha1').update(path).digest('hex').slice(0, 16)}.lock`);
}

/** `fn()`, refusing a promise: the lock is released when `fn` returns, not when it settles. */
function runSync(fn, indexPath) {
  const out = fn();
  if (out != null && typeof out.then === 'function') {
    throw new TypeError(`withSpecLock(${indexPath}): fn returned a promise; it must be synchronous`);
  }
  return out;
}

/**
 * Run `fn` holding `indexPath`'s spec lock, so two writers of the same spec
 * (parallel headless sessions, an interactive session's difference, a totals
 * re-read, a status write) never both write from one snapshot and drop the
 * other's change. Waits through `awaitLock` (`lock-wait.js`) up to `waitMs`
 * (60 s, F-104 D2) for a live holder, and says so once on stderr. The lock is
 * a kernel lock (`kernel-lock.js`): a killed holder leaves none, and release
 * closes the descriptor. A nested call for a lock this process already holds
 * takes it again at once (`tryLock` is re-entrant). Resolves `fn`'s result.
 * Rejects with `SpecLockError` naming the spec and the holder when the lock
 * never frees, or when it cannot be created. `fn` must be synchronous (F-105
 * W4): the lock is re-entrant per process, so an `await` inside `fn` would let
 * another task of this process skip the lock.
 */
export async function withSpecLock(indexPath, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = specLockPath(indexPath);
  const take = () => {
    try {
      return tryLock(lockPath, `spec ${indexPath}`);
    } catch (e) {
      throw new SpecLockError(`${indexPath}: cannot take the spec lock ${lockPath}: ${e.message}`, {
        indexPath,
        cause: e,
      });
    }
  };
  let handle;
  try {
    ({ taken: handle } = await awaitLock(lockPath, take, { deadlineMs: waitMs, pollMs: 10, announce: info }));
  } catch (e) {
    if (!(e instanceof LockWaitTimeout)) throw e;
    throw new SpecLockError(
      `${indexPath}: the spec lock ${lockPath} is held by pid ${e.holder} (waited ${waitMs} ms)`,
      {
        indexPath,
        holder: e.holder,
        cause: e,
      },
    );
  }
  try {
    return runSync(fn, indexPath);
  } finally {
    release(handle);
  }
}

/**
 * A spec's text as its writers read it: CRLF read as LF (`crlf` says whether
 * to put it back, `specText`), refused with a `FrontmatterError` naming
 * `indexPath` when it does not start with a `---` block, since a writer that
 * parsed it would prepend a second one. Shared by `updateSpecFile` and the
 * writers that keep their own read and write (`persistLandedCommits`,
 * `bl fix`, `restoreKeepingTokens`).
 * @param {string} raw the file's bytes
 * @param {string} indexPath
 * @returns {{ content: string, crlf: boolean }}
 */
export function readSpecText(raw, indexPath) {
  const crlf = raw.includes('\r\n');
  const content = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  if (!/^---\n[\s\S]*?\n---\n/.test(content)) {
    throw new FrontmatterError('the file does not start with a `---` block', { line: 1, file: indexPath });
  }
  return { content, crlf };
}

/** `text` (LF) with the line end `readSpecText` found. */
export function specText(text, crlf) {
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * Read-modify-write the spec at `indexPath` under its spec lock: the file is
 * read (CRLF read as LF), refused with a `FrontmatterError` naming it when it
 * does not start with a `---` block (a writer would otherwise prepend a
 * second one), and parsed; `mutate(fm, body)` changes `fm` in place and
 * returns the new body, `undefined` (body unchanged) or `false` (write
 * nothing). The result goes back with the file's line end through
 * `atomicWriteFile`, so a failed write leaves the previous file whole; bytes
 * equal to the file's are not written. Resolves whether it wrote. Every error
 * (a missing file, the lock, the write) rejects.
 * @param {string} backlogRoot the backlog the spec is in (`atomicWriteFile` stages there)
 * @param {string} indexPath
 * @param {(fm: object, body: string) => string | undefined | false} mutate
 * @returns {Promise<boolean>}
 */
export async function updateSpecFile(backlogRoot, indexPath, mutate) {
  return withSpecLock(indexPath, () => updateSpecFileHeld(backlogRoot, indexPath, mutate));
}

/**
 * `updateSpecFile` for a caller inside `withSpecLock(indexPath, …)`, whose
 * `fn` is synchronous and so cannot await it. Returns whether it wrote.
 * Throws a TypeError when this process does not hold the spec lock.
 * @param {string} backlogRoot
 * @param {string} indexPath
 * @param {(fm: object, body: string) => string | undefined | false} mutate
 * @returns {boolean}
 */
export function updateSpecFileHeld(backlogRoot, indexPath, mutate) {
  if (holderOf(specLockPath(indexPath)) !== process.pid) {
    throw new TypeError(`updateSpecFileHeld(${indexPath}): the spec lock is not held; use updateSpecFile`);
  }
  const raw = readFileSync(indexPath, 'utf8');
  const { content, crlf } = readSpecText(raw, indexPath);
  const { fm, body } = parseFrontmatterOf(content, indexPath);
  const next = mutate(fm, body);
  if (next === false) return false;
  const text = specText(serializeFrontmatter(fm) + (next === undefined ? body : next), crlf);
  if (text === raw) return false;
  atomicWriteFile(backlogRoot, indexPath, text);
  return true;
}
