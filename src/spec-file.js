/**
 * spec-file.js — the one read-modify-write of a story or feature spec (F-67).
 *
 * `updateSpecFile(backlogRoot, indexPath, mutate)` reads a spec under its
 * spec lock, refuses a file with no `---` frontmatter block, lets `mutate`
 * change the frontmatter and body, and replaces the file atomically
 * (`atomicWriteFile`), so a writer that dies, runs out of disk or overlaps
 * another `bl` never leaves a truncated, doubled-fence or stale spec behind.
 *
 * `withSpecLock(indexPath, fn)` is the lock: a pid lock in the temp dir keyed
 * by the spec's real path (the file `withTokensLock` used, so an older `bl`
 * and this one still exclude each other). It is re-entrant within a process
 * and throws `SpecLockError` when the lock never frees.
 *
 * Lock order (F-67 D4): the backlog lock (`lock.js`) is the outer lock, a
 * spec lock the inner one. Nothing takes the backlog lock while holding a
 * spec lock, and nothing holds two spec locks at once.
 */

import { readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { FrontmatterError, parseFrontmatterOf, serializeFrontmatter } from './config.js';
import { acquirePidLock, releasePidLock } from './pid-lock.js';
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
 * is the one the token writers used before F-67, kept so an older process
 * and a newer one take the same lock.
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

/** Lock paths this process holds, so a nested `withSpecLock` runs without waiting on itself. */
const held = new Map();

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
 * other's change. Waits up to `waitMs` for a live holder (a write takes
 * milliseconds); a dead holder's lock is reclaimed. A nested call for a lock
 * this process already holds runs `fn` directly. Returns `fn`'s result.
 * Throws `SpecLockError` naming the spec and the holder when the lock never
 * frees, or when it cannot be created. `fn` must be synchronous.
 */
export function withSpecLock(indexPath, fn, { waitMs = 10_000 } = {}) {
  const lockPath = specLockPath(indexPath);
  if (held.has(lockPath)) return runSync(fn, indexPath);
  const content = `${process.pid}\n${new Date().toISOString()}\nspec ${indexPath}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let got;
    try {
      got = acquirePidLock(lockPath, content);
    } catch (e) {
      throw new SpecLockError(`${indexPath}: cannot take the spec lock ${lockPath}: ${e.message}`, {
        indexPath,
        cause: e,
      });
    }
    if (got.content != null) break;
    if (Date.now() > deadline) {
      throw new SpecLockError(
        `${indexPath}: the spec lock ${lockPath} is held by pid ${got.holder} (waited ${waitMs} ms)`,
        { indexPath, holder: got.holder },
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  held.set(lockPath, content);
  try {
    return runSync(fn, indexPath);
  } finally {
    held.delete(lockPath);
    releasePidLock(lockPath, content);
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
 * equal to the file's are not written. Returns whether it wrote. Every error
 * (a missing file, the lock, the write) propagates.
 * @param {string} backlogRoot the backlog the spec is in (`atomicWriteFile` stages there)
 * @param {string} indexPath
 * @param {(fm: object, body: string) => string | undefined | false} mutate
 * @returns {boolean}
 */
export function updateSpecFile(backlogRoot, indexPath, mutate) {
  return withSpecLock(indexPath, () => {
    const raw = readFileSync(indexPath, 'utf8');
    const { content, crlf } = readSpecText(raw, indexPath);
    const { fm, body } = parseFrontmatterOf(content, indexPath);
    const next = mutate(fm, body);
    if (next === false) return false;
    const text = specText(serializeFrontmatter(fm) + (next === undefined ? body : next), crlf);
    if (text === raw) return false;
    atomicWriteFile(backlogRoot, indexPath, text);
    return true;
  });
}
