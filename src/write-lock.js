/**
 * write-lock.js — the covering lock of a backlog path (F-126): the one place
 * that says which lock a bl write to a backlog path must hold.
 *
 * | Path (backlog-relative)                                        | Covering lock    |
 * | -------------------------------------------------------------- | ---------------- |
 * | an existing story, feature or batch `index.md`, change doc, or | its spec lock    |
 * | `allowed-tools.json`                                           |                  |
 * | any of those when the file does not exist yet                  | the backlog lock |
 * | every other path that git does not ignore                      | the backlog lock |
 * | a path that git ignores (`.bl/` among them), or outside        | none             |
 *
 * The write chokepoints in `atomic-write.js` (`atomicWriteFile`,
 * `removeBacklogPath`, `moveIntoBacklog`) call `assertCovered` before they
 * write. A git call that changes the backlog's index, working tree or refs
 * holds the main sync lock instead (`main-sync.js`, F-126 D1).
 *
 * This module sits in an import cycle (`atomic-write.js` imports it, and
 * `change-doc.js` and `spec-file.js` import `atomic-write.js`), so it reads
 * the imported names only when a function runs, never at load time.
 */

import { existsSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'path';
import { ALLOWED_TOOLS_FILE } from './allowed-tools.js';
import { STAGING_DIR } from './atomic-write.js';
import { isChangeFile } from './change-doc.js';
import { git } from './child.js';
import { STORIES_DIR } from './config.js';
import { FEATURES_DIR } from './feature.js';
import { BATCHES_DIR } from './batch.js';
import { holds } from './kernel-lock.js';
import { canonical, LOCK_FILE, withLock } from './lock.js';
import { specLockPath, withSpecFileLock, withSpecLock } from './spec-file.js';

/** @typedef {{ kind: 'spec' | 'backlog', path: string }} CoveringLock */

/**
 * Whether `rel` (backlog-relative, split on `sep`) is a file that takes a
 * spec lock while it exists: a story, feature or story batch `index.md`, a
 * change document in a unit directory, or `allowed-tools.json` at the root.
 * @param {string[]} parts
 */
function isSpecFile(parts) {
  if (parts.length === 1) return parts[0] === ALLOWED_TOOLS_FILE;
  if (parts.length !== 3 || ![STORIES_DIR, FEATURES_DIR, BATCHES_DIR].includes(parts[0])) return false;
  return parts[2] === 'index.md' || isChangeFile(parts[2]) != null;
}

/**
 * `path` relative to `backlogRoot`, both compared as `canonical` paths, or
 * null when `path` is the backlog root or not inside it. A name that only
 * starts with `..` (`..notes.md`) is inside.
 * @param {string} backlogRoot
 * @param {string} path
 * @returns {string | null}
 */
export function insideBacklog(backlogRoot, path) {
  return relInside(backlogRoot, canonical(path));
}

/** `target`, a `canonical` path, relative to `backlogRoot`'s, or null when it is the root or outside it. */
function relInside(backlogRoot, target) {
  const rel = relative(canonical(backlogRoot), target);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
}

/**
 * The backlog-relative path that a write to `path` changes, or null when it
 * is not inside `backlogRoot`: `path` with the links in its directory
 * resolved, but not a link at `path` itself, since a rename or a removal
 * replaces that link and leaves its target. A writer that writes through the
 * link (`atomicWriteFile`'s `preserve`, a plugin) passes the link's target.
 * `lockFor` and `assertCovered`'s git check both use it, so the lock and the
 * ignore rule are those of the one path the write changes.
 * @param {string} backlogRoot
 * @param {string} path
 */
function writtenPath(backlogRoot, path) {
  return relInside(backlogRoot, writeTarget(path));
}

/** Absolute `path` with the links in its directory resolved (`canonical`), not a link at `path` itself. */
function writeTarget(path) {
  return join(canonical(dirname(path)), basename(path));
}

/**
 * `git check-ignore`'s exit status for `rel` (backlog-relative): 0 when git
 * ignores it (never a tracked file), 1 when it does not, 128 when the backlog
 * is no git repository.
 */
function checkIgnore(backlogRoot, rel) {
  return git(backlogRoot, ['check-ignore', '-q', '--', rel]).status;
}

/**
 * The covering lock of a write to `path` (`writtenPath`): null when that is
 * not inside `backlogRoot`, or is inside `.bl/`, bl's runtime directory, which
 * `bl init` adds to every backlog's `.gitignore` (`BL_DIR_LINE`), and git
 * ignores it (not a file someone added with `git add -f`, nor a `.bl/` with no
 * ignore rule) or the backlog is no git repository; the spec lock
 * (`specLockPath`) of an existing spec file (`isSpecFile`); else the backlog
 * lock (`LOCK_FILE`). It does not ask git about other ignored paths:
 * `assertCovered` does, and only when the lock is not held.
 * @param {string} backlogRoot
 * @param {string} path
 * @returns {CoveringLock | null}
 */
export function lockFor(backlogRoot, path) {
  const rel = writtenPath(backlogRoot, path);
  if (rel == null) return null;
  const parts = rel.split(sep);
  if (parts[0] === dirname(STAGING_DIR) && checkIgnore(backlogRoot, rel) !== 1) return null;
  if (isSpecFile(parts) && existsSync(path)) return { kind: 'spec', path: specLockPath(path) };
  return { kind: 'backlog', path: join(backlogRoot, LOCK_FILE) };
}

/**
 * Run the synchronous `fn` holding the covering lock of `path` (`lockFor`),
 * and resolve its result. A path with no covering lock runs `fn` with none.
 * An existing spec file takes its spec lock (`withSpecFileLock`). Every other
 * path takes the backlog lock, and then its spec lock too: a missing spec
 * file that another process creates before the backlog lock frees is covered
 * by its spec lock once it exists. The lock is that of `path`'s target, with
 * every link resolved (`canonical`), and `fn` gets that target to write:
 * a link retargeted while this waits for the lock cannot send the write to
 * a file whose lock it does not hold. Lock order (F-67 D4): the caller holds
 * no spec lock.
 * @template T
 * @param {string} backlogRoot
 * @param {string} path
 * @param {(target: string) => T} fn
 * @returns {Promise<T>}
 */
export async function withCoveringLock(backlogRoot, path, fn) {
  const target = canonical(path);
  const run = () => fn(target);
  const lock = lockFor(backlogRoot, target);
  if (lock == null) return run();
  if (lock.kind === 'spec') return withSpecFileLock(backlogRoot, target, run);
  return withLock(backlogRoot, async () => withSpecLock(target, run));
}

/**
 * Throw unless this process may write `path` now: the path the write changes
 * (`writtenPath`) is outside the backlog, this process holds its covering lock
 * (`lockFor`), or git ignores it (`git check-ignore`, which never ignores a
 * tracked file; a backlog that is no git repository ignores nothing). The
 * error names that path and the lock:
 * `<rel>: bl writes it without its covering lock (<kind> lock <lock path>)`.
 * Returns that path, absolute (`writeTarget`): the caller writes it, not
 * `path`, so a directory link retargeted after the check cannot send the
 * write to a file whose lock it does not hold.
 * @param {string} backlogRoot
 * @param {string} path
 * @returns {string}
 */
export function assertCovered(backlogRoot, path) {
  const target = writeTarget(path);
  const lock = lockFor(backlogRoot, target);
  if (lock == null || holds(lock.path)) return target;
  const rel = writtenPath(backlogRoot, target);
  if (checkIgnore(backlogRoot, rel) === 0) return target;
  throw new Error(`${rel}: bl writes it without its covering lock (${lock.kind} lock ${lock.path})`);
}
