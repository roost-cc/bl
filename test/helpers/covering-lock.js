/**
 * covering-lock.js — run a bl writer in a test the way bl runs it: holding
 * the covering lock of what it writes (F-126, `src/write-lock.js`).
 *
 * `atomicWriteFile` and its siblings throw without that lock, so a test that
 * calls a writer directly (to seed a file or to test the writer) wraps the
 * call in `underLock(root, fn)`: the backlog lock, taken at once in this
 * process, and the spec lock of each existing spec file the test names.
 */

import { join } from 'path';
import { ensureLockDir, LOCK_FILE } from '../../src/lock.js';
import { release, tryLock } from '../../src/kernel-lock.js';
import { specLockPath } from '../../src/spec-file.js';
import { writeBlockers } from '../../src/blockers.js';

/**
 * `writeBlockers` (`src/blockers.js`) under the backlog lock, its covering
 * lock: how a test seeds `blockers.json`.
 * @param {string} root
 * @param {import('../../src/blockers.js').Edge[]} edges
 */
export function writeBlockersLocked(root, edges) {
  return underLock(root, () => writeBlockers(root, edges));
}

/**
 * Run the synchronous `fn` holding the backlog lock of `root` and the spec
 * lock of each of `specs` (paths of existing spec files), and return its
 * result. Throws when another process holds one of the locks.
 * @template T
 * @param {string} root
 * @param {() => T} fn
 * @param {string[]} [specs]
 * @returns {T}
 */
export function underLock(root, fn, specs = []) {
  ensureLockDir(root);
  const taken = [];
  try {
    for (const path of [join(root, LOCK_FILE), ...specs.map(specLockPath)]) {
      const got = tryLock(path);
      if (!('taken' in got)) throw new Error(`underLock: pid ${got.holder} holds ${path}`);
      taken.push(got.taken);
    }
    return fn();
  } finally {
    for (const handle of taken.reverse()) release(handle);
  }
}
