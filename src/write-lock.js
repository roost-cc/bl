/**
 * write-lock.js — the covering lock of a backlog path (F-126): the one place
 * that says which lock a bl write to a backlog path must hold.
 *
 * | Path (backlog-relative)                                        | Covering lock    |
 * | -------------------------------------------------------------- | ---------------- |
 * | an existing story or feature `index.md`, change document, or   | its spec lock    |
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
import { dirname, isAbsolute, join, relative, sep } from 'path';
import { ALLOWED_TOOLS_FILE } from './allowed-tools.js';
import { STAGING_DIR } from './atomic-write.js';
import { isChangeFile } from './change-doc.js';
import { git } from './child.js';
import { STORIES_DIR } from './config.js';
import { FEATURES_DIR } from './feature.js';
import { holds } from './kernel-lock.js';
import { canonical, LOCK_FILE } from './lock.js';
import { specLockPath } from './spec-file.js';

/** @typedef {{ kind: 'spec' | 'backlog', path: string }} CoveringLock */

/**
 * Whether `rel` (backlog-relative, split on `sep`) is a file that takes a
 * spec lock while it exists: a story or feature `index.md`, a change document
 * in a unit directory, or `allowed-tools.json` at the root.
 * @param {string[]} parts
 */
function isSpecFile(parts) {
  if (parts.length === 1) return parts[0] === ALLOWED_TOOLS_FILE;
  if (parts.length !== 3 || (parts[0] !== STORIES_DIR && parts[0] !== FEATURES_DIR)) return false;
  return parts[2] === 'index.md' || isChangeFile(parts[2]) != null;
}

/**
 * The covering lock of `path`: null when `path` is not inside `backlogRoot`
 * (compared as `canonical` paths) or is inside `.bl/`, bl's runtime
 * directory, which `bl init` adds to every backlog's `.gitignore`
 * (`BL_DIR_LINE`); the spec lock (`specLockPath`) of an existing spec file
 * (`isSpecFile`); else the backlog lock (`LOCK_FILE`). It does not ask git
 * about other ignored paths: `assertCovered` does, and only when the lock is
 * not held.
 * @param {string} backlogRoot
 * @param {string} path
 * @returns {CoveringLock | null}
 */
export function lockFor(backlogRoot, path) {
  const rel = relative(canonical(backlogRoot), canonical(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts[0] === dirname(STAGING_DIR)) return null;
  if (isSpecFile(parts) && existsSync(path)) return { kind: 'spec', path: specLockPath(path) };
  return { kind: 'backlog', path: join(backlogRoot, LOCK_FILE) };
}

/**
 * Throw unless this process may write `path` now: it is outside the backlog,
 * this process holds its covering lock (`lockFor`), or git ignores it
 * (`git check-ignore`; a backlog that is no git repository ignores nothing).
 * The error names the path and the lock:
 * `<rel>: bl writes it without its covering lock (<kind> lock <lock path>)`.
 * @param {string} backlogRoot
 * @param {string} path
 */
export function assertCovered(backlogRoot, path) {
  const lock = lockFor(backlogRoot, path);
  if (lock == null || holds(lock.path)) return;
  if (git(backlogRoot, ['check-ignore', '-q', '--', path]).status === 0) return;
  throw new Error(
    `${relative(backlogRoot, path)}: bl writes it without its covering lock (${lock.kind} lock ${lock.path})`,
  );
}
