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

import { existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';
import { createHash } from 'crypto';
import { FrontmatterError, info, parseFrontmatterOf, runPluginBatch, serializeFrontmatter } from './config.js';
import { awaitLock, LOCK_WAIT_MS, LockWaitTimeout } from './lock-wait.js';
import { assertHeld, release, tryLock } from './kernel-lock.js';
import { atomicWriteFile } from './atomic-write.js';
import { canonical, withLock } from './lock.js';
import { withCoveringLock } from './write-lock.js';

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

/** One `tryLock` of `indexPath`'s spec lock at `lockPath`; a lock that cannot be created throws `SpecLockError`. */
function takeSpecLock(indexPath, lockPath) {
  try {
    return tryLock(lockPath, `spec ${indexPath}`);
  } catch (e) {
    throw new SpecLockError(`${indexPath}: cannot take the spec lock ${lockPath}: ${e.message}`, {
      indexPath,
      cause: e,
    });
  }
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
  const take = () => takeSpecLock(indexPath, lockPath);
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
 * `withSpecLock` for synchronous code, which cannot await a wait (F-126 D7):
 * one `tryLock` of `indexPath`'s spec lock, then `fn`, then the release.
 * Throws `SpecLockError` naming the holder when another process holds the
 * lock, and `fn` does not run. The caller decides what a busy lock means:
 * `bl side`'s and `snapshot`'s undos leave the file and name it, and a
 * migration fails and restores. `fn` is synchronous. Returns `fn`'s result.
 * @template T
 * @param {string} indexPath
 * @param {() => T} fn
 * @returns {T}
 */
export function withSpecLockNow(indexPath, fn) {
  const lockPath = specLockPath(indexPath);
  const got = takeSpecLock(indexPath, lockPath);
  if (!('taken' in got)) {
    throw new SpecLockError(`${indexPath}: the spec lock ${lockPath} is held by pid ${got.holder}`, {
      indexPath,
      holder: got.holder,
    });
  }
  try {
    return runSync(fn, indexPath);
  } finally {
    release(got.taken);
  }
}

/**
 * Run `fn` holding the covering lock of the spec file at `path` (F-126 D2,
 * D3): a story or feature `index.md`, a change document, or
 * `allowed-tools.json`. An existing file takes its spec lock alone. A file
 * that does not exist yet is created under the backlog lock, as a new spec
 * file is, with its spec lock inside it (F-67 D4: the backlog lock first).
 * When another process removes the file between the check and the spec lock,
 * the spec lock is given back and the backlog lock taken first, so a write
 * that creates the file again holds its covering lock. `fn` is synchronous,
 * as for `withSpecLock`, and its result resolves. A caller already in a spec
 * lock cannot call this: its `fn` is synchronous.
 * @template T
 * @param {string} backlogRoot
 * @param {string} path
 * @param {() => T} fn
 * @returns {Promise<T>}
 */
export async function withSpecFileLock(backlogRoot, path, fn) {
  if (existsSync(path)) {
    const out = await withSpecLock(path, () => (existsSync(path) ? { result: fn() } : null));
    if (out) return out.result;
  }
  return withLock(backlogRoot, async () => withSpecLock(path, fn));
}

/**
 * Run a format or lint plugin (`runPluginBatch`, `config.js`) on `paths`, one
 * file per process, each inside that file's covering lock (`withCoveringLock`,
 * `write-lock.js`; F-126 D4). A plugin rewrites a file in place, so a batch
 * run could overwrite another writer's write to any file in it. A file whose
 * lock another process holds is waited for, and the wait is said once on
 * stderr. The cost is about 100 ms per file. Lock order (F-67 D4): a caller
 * may hold the backlog lock (`bl sync --commit`) but no spec lock.
 * A missing binary (exit 127) stops the run after the first file, with its
 * one warning; any other non-zero exit does not stop the other files.
 * @param {string} name  the plugin's name
 * @param {string} command  the plugin's command for the stage
 * @param {string[]} paths  relative to `cwd`, or absolute
 * @param {Record<string, string>} vars
 * @param {string} cwd
 * @param {string} backlogRoot
 * @returns {Promise<{ ok: boolean, status: number, missing?: true }>} the worst status
 */
export async function runPluginLocked(name, command, paths, vars, cwd, backlogRoot) {
  let status = 0;
  for (const path of paths) {
    // The plugin gets the file whose lock is held, not a link to it, written
    // as `path` is: absolute, or relative to `cwd`.
    const run = (target) =>
      runPluginBatch(name, command, [isAbsolute(path) ? target : relative(canonical(cwd), target)], vars, cwd);
    const r = await withCoveringLock(backlogRoot, resolve(cwd, path), run);
    if (r.missing) return r;
    if (r.status > status) status = r.status;
  }
  return { ok: status === 0, status };
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
 * Throws when this process does not hold the spec lock (`assertHeld`).
 * @param {string} backlogRoot
 * @param {string} indexPath
 * @param {(fm: object, body: string) => string | undefined | false} mutate
 * @returns {boolean}
 */
export function updateSpecFileHeld(backlogRoot, indexPath, mutate) {
  assertHeld(specLockPath(indexPath), 'the spec lock', `updateSpecFileHeld(${indexPath})`);
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
