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
 *
 * `atomicWriteFile`, `removeBacklogPath` and `moveIntoBacklog` are bl's three
 * write chokepoints for the backlog (F-126 D6): each throws before it changes
 * anything when this process does not hold the target's covering lock
 * (`assertCovered`, `write-lock.js`).
 */

import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, join, relative } from 'path';
import { warn } from './config.js';
import { withSpecLockNow } from './spec-file.js';
import { assertCovered, lockFor } from './write-lock.js';

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
 * The per-process name matters because two writers of different targets
 * hold different locks (a spec lock each, F-126) and so may stage at the
 * same time: with a fixed name, one process's rename could consume the
 * other's staging file, which then failed with ENOENT or left a failed
 * caller's partial bytes live. If the
 * write or the rename throws, the staging file is removed before the error
 * propagates; when that removal fails for any reason other than the file
 * already being gone, the failure and the staging path are reported on
 * stderr so the orphan is not left unnoticed.
 * `BL_INTERNAL_TEST_FAIL_ON_RENAME=<n>[,<n>...]` makes each listed n-th call
 * in this process fail before its rename (tests only).
 *
 * The write throws before it starts when the file it replaces (the link's
 * target with `preserve`, else `path`) is a backlog path that git does not
 * ignore and this process does not hold its covering lock (`assertCovered`,
 * `write-lock.js`, F-126 D6).
 *
 * With `{ preserve: true }` an existing target keeps what it was: a symlink
 * stays a symlink and the file it resolves to is the one replaced, and the
 * staging file takes that file's mode, owner and group before the rename.
 * When those cannot be given (chmod or chown refused, or the resolved file is on
 * another filesystem, EXDEV) the write fails and the target is unchanged.
 *
 * With `{ exclusive: true }` the staging file is hard-linked to `path`
 * instead of renamed over it, and then removed: a `path` that exists, also
 * one another process made after the caller looked, stays as it is, and the
 * write fails with EEXIST.
 *
 * With `{ unchanged: <text> }` the target is read again just before the
 * rename: when it no longer holds `<text>` (another caller edited it after
 * this caller read it), the write fails with code `ECHANGED` and the target
 * keeps that edit. The caller reads the file again and retries.
 *
 * @param {string} backlogRoot
 * @param {string} path
 * @param {string | Buffer} text
 * @param {{ preserve?: boolean, exclusive?: boolean, unchanged?: string }} [options]
 */
export function atomicWriteFile(
  backlogRoot,
  path,
  text,
  { preserve = false, exclusive = false, unchanged = undefined } = {},
) {
  let st = null;
  if (preserve) {
    try {
      path = realpathSync(path);
      st = statSync(path);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  // After `preserve` resolves a link: the check is of the file replaced, and
  // the write goes to the path checked, not through a link retargeted since.
  path = assertCovered(backlogRoot, path);
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
    const failOn = String(process.env.BL_INTERNAL_TEST_FAIL_ON_RENAME ?? '').split(',');
    if (failOn.includes(String(renameCallCount))) {
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
    if (unchanged !== undefined && readFileSync(path, 'utf8') !== unchanged) {
      throw Object.assign(new Error(`${path} changed while bl wrote it`), { code: 'ECHANGED' });
    }
    try {
      if (exclusive) linkSync(tmp, path);
      else renameSync(tmp, path);
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
  // The link is made: the staging name goes, and a failure leaves an
  // orphan in ignored space, reported, not a failed write.
  if (exclusive) {
    try {
      unlinkSync(tmp);
    } catch (u) {
      warn(`could not remove staging file ${tmp} after a write: ${u.message}`);
    }
  }
}

/**
 * Remove the file or tree at `path` (nothing when it is not there), after the
 * covering-lock check `atomicWriteFile` makes (`assertCovered`, F-126 D6).
 * Every bl removal of a backlog path goes through it.
 * @param {string} backlogRoot
 * @param {string} path
 */
export function removeBacklogPath(backlogRoot, path) {
  rmSync(assertCovered(backlogRoot, path), { recursive: true, force: true });
}

/**
 * Rename `from` to `to`, after the covering-lock check of both
 * (`assertCovered`, F-126 D6): a file or directory staged in ignored space
 * (`.bl/tmp/`) moves into the backlog whole. Every bl move into or inside a
 * backlog goes through it.
 * @param {string} backlogRoot
 * @param {string} from
 * @param {string} to
 */
export function moveIntoBacklog(backlogRoot, from, to) {
  renameSync(assertCovered(backlogRoot, from), assertCovered(backlogRoot, to));
}

/**
 * Undo for the files a write touched, run when the commit could not be
 * reached: each path is put back as it was (removed when it was not there),
 * and a path that is as it was is left alone. Every path is tried, whatever
 * fails before it. `undo(cause)` returns `cause` when all were put back, else an error naming `cause` and each path left changed,
 * with what to do; its `unrecovered` holds each such path's text before
 * (`null`: it was not there). `bl task` (`task.js`), the edge writes
 * (`allOrNothing` in `block.js`) and `bl attach` share it.
 *
 * The caller holds the backlog lock. A path whose covering lock is a spec
 * lock (`lockFor`) is put back inside it, taken with one try
 * (`withSpecLockNow`, F-126 D7): the undo is synchronous. When another
 * process holds that lock, the path is left and named in the error.
 * @param {string} root  the backlog root, for the paths the error names
 * @param {string[]} paths
 * @param {string} [left]  what a path left changed means, for the error
 */
export function snapshot(root, paths, left = '') {
  const was = new Map(paths.map((p) => [p, existsSync(p) ? readFileSync(p, 'utf8') : null]));
  return (cause) => {
    const unrecovered = [];
    for (const [p, text] of was) {
      try {
        // A path the write never touched is not rewritten, so it cannot fail.
        if ((existsSync(p) ? readFileSync(p, 'utf8') : null) === text) continue;
        writeBacklogPathNow(root, p, text);
      } catch (e) {
        unrecovered.push({ path: p, text, error: e.message });
      }
    }
    if (unrecovered.length === 0) return cause;
    const what = unrecovered.map(({ path, text, error }) => {
      const rel = relative(root, path);
      return `${rel} (${error}): ${text == null ? 'remove it' : `put it back with git -C "${root}" checkout -- ${rel}`}`;
    });
    const err = new Error(`${cause.message}; and could not undo the write${left}: ${what.join('; ')}`, { cause });
    err.unrecovered = unrecovered;
    return err;
  };
}

/**
 * Write `text` to the backlog path `path`, or remove it when `text` is null,
 * from synchronous code that holds the backlog lock: inside the path's spec
 * lock when that is its covering lock (`lockFor`), taken with one try
 * (`withSpecLockNow`, F-126 D7). Throws `SpecLockError` naming the holder
 * when another process holds it, and leaves the path. `snapshot`'s undo,
 * `bl side`'s exit-time undo and the migration's `write` op write through it.
 * @param {string} root  the backlog root
 * @param {string} path
 * @param {string | Buffer | null} text
 */
export function writeBacklogPathNow(root, path, text) {
  const put = () => (text == null ? removeBacklogPath(root, path) : atomicWriteFile(root, path, text));
  if (lockFor(root, path)?.kind === 'spec') withSpecLockNow(path, put);
  else put();
}
