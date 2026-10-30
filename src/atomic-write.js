/**
 * atomic-write.js — replace a file atomically, staging in the backlog's
 * ignored `.bl/tmp/`.
 *
 * `atomicWriteFile(backlogRoot, path, text)` writes `text` to a staging file
 * under `<backlogRoot>/.bl/tmp/` and renames it over `path`. `.bl/` is in
 * every backlog's `.gitignore` (`bl init` seeds it), so a process killed
 * between the write and the rename leaves its staging file only in ignored
 * space: nothing stray shows in `git status`, and `bl sync --commit --story`
 * cannot commit it from a story directory. `rename(2)` is atomic between any
 * two directories on one filesystem, and `.bl/` lives inside the backlog
 * checkout. When `.bl/` is on another filesystem (a symlink) the rename fails
 * with EXDEV; that error names the staging directory and the target, and
 * there is no fallback to staging beside the target.
 *
 * Callers pass the backlog root; it is never worked out from the target.
 * `ensureAllowedTools` (`allowed-tools.json`), `bl fix` and `bl merge`
 * (`persistLandedCommits` in `cleanup.js`) all write through here. Old files
 * in `.bl/tmp/` are never swept: they are ignored and harmless, and a sweep
 * could delete a live caller's staging file.
 */

import { chmodSync, chownSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { warn } from './config.js';

/** Staging directory under the backlog root. */
export const STAGING_DIR = join('.bl', 'tmp');

/** Generated staging names tried before a persistent EEXIST propagates. */
export const STAGING_ATTEMPTS = 10;

/**
 * Test-only seam. `beforeRename(tmp)` runs after the staging file is written
 * (and after the fail-point check) and before it is renamed over the target,
 * so a unit test can interleave two writes at the point where a shared
 * staging name would collide. Never set outside tests.
 */
export const _hooks = { beforeRename: null };

let renameCallCount = 0;

/**
 * Write `text` to `path` atomically: stage it at
 * `<backlogRoot>/.bl/tmp/<basename>.<pid>.<random>.tmp` (`.bl/` and
 * `.bl/tmp/` are created when missing; a missing backlog root is not, and
 * fails with ENOENT), then rename over `path`. The staging file is
 * created exclusively (`wx`): a generated name that already exists belongs
 * to another caller in this process, so a fresh name is tried instead of
 * truncating theirs and renaming it over the target. A collided name is
 * dropped before the next draw, so the cleanup below only ever removes a
 * staging file this caller created, also when drawing the next name
 * throws. After `STAGING_ATTEMPTS` collisions the EEXIST propagates and
 * nothing is removed, since the file at that name is not ours.
 *
 * The per-process name matters because concurrent `bl` processes write
 * some targets outside the backlog lock (`allowed-tools.json`): with a fixed
 * name, one process's rename consumed the other's staging file, which then
 * failed with ENOENT or left a failed caller's partial bytes live. If the
 * write or the rename throws, the staging file is removed before the error
 * propagates; when that removal fails for any reason other than the file
 * already being gone, the failure and the staging path are reported on
 * stderr so the orphan is not left unnoticed.
 * `BL_INTERNAL_TEST_FAIL_ON_RENAME=<n>` makes the n-th call in this process
 * fail before its rename (tests only).
 *
 * With `{ preserve: true }` an existing target keeps what it was: a symlink
 * stays a symlink and the file it resolves to is the one replaced, and the
 * staging file takes that file's mode, owner and group before the rename.
 * When those cannot be given (chmod or chown refused, or the resolved file is on
 * another filesystem, EXDEV) the write fails and the target is unchanged.
 *
 * @param {string} backlogRoot
 * @param {string} path
 * @param {string} text
 * @param {{ preserve?: boolean }} [options]
 */
export function atomicWriteFile(backlogRoot, path, text, { preserve = false } = {}) {
  let st = null;
  if (preserve) {
    try {
      path = realpathSync(path);
      st = statSync(path);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const dir = join(backlogRoot, STAGING_DIR);
  try {
    mkdirSync(join(backlogRoot, '.bl'));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  mkdirSync(dir, { recursive: true });
  let tmp = null;
  try {
    for (let attempt = 1; ; attempt += 1) {
      tmp = join(dir, `${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
      try {
        writeFileSync(tmp, text, { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Another caller's file: leave it alone, also if drawing the next
        // name throws before this caller owns one.
        tmp = null;
        if (attempt === STAGING_ATTEMPTS) throw e;
      }
    }
    renameCallCount += 1;
    const failOn = parseInt(process.env.BL_INTERNAL_TEST_FAIL_ON_RENAME ?? '', 10);
    if (Number.isInteger(failOn) && failOn === renameCallCount) {
      throw new Error(`BL_INTERNAL_TEST_FAIL_ON_RENAME triggered (call #${renameCallCount})`);
    }
    if (st) {
      chmodSync(tmp, st.mode & 0o7777);
      const own = statSync(tmp);
      if (own.uid !== st.uid || own.gid !== st.gid) {
        chownSync(tmp, st.uid, st.gid);
      }
    }
    _hooks.beforeRename?.(tmp);
    try {
      renameSync(tmp, path);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      throw Object.assign(
        new Error(
          `cannot rename ${tmp} over ${path}: the staging directory ${dir} ` +
            `is on a different filesystem from the target (EXDEV); ` +
            `${STAGING_DIR} must not be a link to another filesystem`,
          { cause: e },
        ),
        { code: 'EXDEV' },
      );
    }
  } catch (err) {
    // The staging file may never have been created (a failed write), so a
    // missing file is the one expected unlink failure; any other leaves an
    // orphan in .bl/tmp/ and is reported with its path. The original error
    // is the one thrown.
    if (tmp !== null) {
      try {
        unlinkSync(tmp);
      } catch (u) {
        if (u.code !== 'ENOENT') {
          warn(`could not remove staging file ${tmp} after a failed write: ${u.message}`);
        }
      }
    }
    throw err;
  }
}
