/**
 * migrate-lock-files.js — the S-1495 migration, run by
 * `scripts/migrate-lock-files.js`.
 *
 * Since S-1495 every lock file bl keeps in a backlog lives under `.bl/`
 * (`lock.js` `LOCK_DIR`), which the backlog's `.gitignore` ignores. Before it,
 * three lock files lived outside `.bl/`, and `.gitignore` listed each one
 * (`OLD_LOCK_FILES`): the backlog lock `.bl-new.lock` and the report lock
 * `.reports.lock` in the backlog root, and the session lock `.workon.lock` in
 * each unit directory (in the backlog root for a refine, and in a worktree for
 * a session from before F-60). The migration:
 *
 *   1. adds `.bl/` to the backlog's `.gitignore` if the line is missing, and
 *      writes the file before it deletes anything;
 *   2. deletes each old lock file that no other process holds, while it holds
 *      the file's kernel lock itself (`deleteUnderLock`), so nobody takes the
 *      lock between the check and the delete; and the unit directory it
 *      leaves empty (`removeUnitDirIfEmpty`). It skips, and lists, a file
 *      whose kernel lock another process holds; a rerun tries that file
 *      again. A `bl` from before F-104 holds its locks as PID files, which
 *      this step cannot see, so the migration runs only when no older `bl`
 *      runs;
 *   3. once a second scan finds no old lock file left, removes the old lock
 *      lines from `.gitignore`;
 *   4. commits `.gitignore` (`commitPaths`) when it is what steps 1 and 3
 *      make of the HEAD version, so a rerun commits what a run that failed
 *      after step 1 wrote. A `.gitignore` with any other change stays
 *      uncommitted, and the migration says so.
 *
 * It does not use `applyMigration` (`migration-txn.js`), which refuses to
 * start while any bl run or session is live: each step is safe beside a live
 * run, and a rerun finishes what a run skipped. It prints "nothing to do" when
 * nothing is left.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { commitPaths, textAt } from './backlog-commit.js';
import { worktreeRoot } from './config.js';
import { BL_DIR_LINE, withGitignoreLines } from './init.js';
import { otherHolder, release, tryLockOnce } from './kernel-lock.js';
import { canonical } from './lock.js';
import { allActiveWorktrees, removeUnitDirIfEmpty } from './story.js';

/** The lock files bl kept outside `.bl/` before S-1495; `.gitignore` listed each. */
export const OLD_LOCK_FILES = ['.bl-new.lock', '.reports.lock', '.workon.lock'];
const [OLD_BACKLOG_LOCK, OLD_REPORTS_LOCK, OLD_SESSION_LOCK] = OLD_LOCK_FILES;

/**
 * Every old lock file that exists: the backlog and report locks in the
 * backlog root, and the session lock in the backlog root, in each unit
 * directory (each directory under the worktree root), in each directory in a
 * unit directory (a worktree, registered with git or not), and in each
 * registered worktree. A link to a directory counts as a directory. A
 * directory reached by two names (a link) is listed once, by the first name
 * the scan finds (`canonical`).
 * @param {object} config
 * @returns {string[]}
 */
export function oldLockFiles(config) {
  const root = config.backlogRoot;
  const dirs = new Map();
  const add = (dir) => dirs.has(canonical(dir)) || dirs.set(canonical(dir), dir);
  add(root);
  for (const unit of subdirs(worktreeRoot(config))) {
    add(unit);
    for (const wt of subdirs(unit)) add(wt);
  }
  for (const wt of allActiveWorktrees(config)) add(wt.path);
  return [
    join(root, OLD_BACKLOG_LOCK),
    join(root, OLD_REPORTS_LOCK),
    ...[...dirs.values()].map((d) => join(d, OLD_SESSION_LOCK)),
  ].filter((p) => existsSync(p));
}

/**
 * The directories in `dir`, links to directories included; none when `dir`
 * cannot be read. An entry that cannot be stat'ed (a dangling link, a link
 * loop, no permission) is skipped.
 */
function subdirs(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((n) => join(dir, n)).filter(isDir);
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Run the migration. With `dryRun`, say what it would do and change nothing.
 * `log` gets one line per lock file deleted or skipped, one per lock file
 * left because it appeared during the run, one per `.gitignore` change, one
 * when it commits a `.gitignore` an earlier run left uncommitted, one when it
 * leaves `.gitignore` uncommitted because of a change it did not make, or
 * "nothing to do".
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void }} [opts]
 * @returns {Promise<{ deleted: string[], skipped: string[], commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log } = {}) {
  const root = config.backlogRoot;
  const verb = (done, would) => (dryRun ? would : done);
  const gitignorePath = join(root, '.gitignore');
  const before = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const write = (next) => dryRun || atomicWriteFile(root, gitignorePath, next);

  // 1. `.bl/` first, written before any delete, so no lock file is ever
  // outside what git ignores and a step that fails leaves it for a rerun.
  let text = migrated(before, false);
  if (text !== before) {
    write(text);
    log(`${verb('added', 'would add')} ${BL_DIR_LINE} to .gitignore`);
  }

  // 2. Each old lock file that no other process holds.
  const deleted = [];
  const skipped = [];
  for (const path of oldLockFiles(config)) {
    // A file another process deleted since the scan: a take would create it.
    if (!existsSync(path)) continue;
    const pid = dryRun ? otherHolder(path) : deleteUnderLock(path);
    if (pid != null) {
      skipped.push(path);
      log(`skipped ${path}: a live process (pid ${pid}) holds its lock; a rerun deletes it`);
      continue;
    }
    if (!dryRun && basename(path) === OLD_SESSION_LOCK && dirname(path) !== root) removeUnitDirIfEmpty(dirname(path));
    deleted.push(path);
    log(`${verb('deleted', 'would delete')} ${path}`);
  }

  // 3. The old lines, once no old lock file is left. A new scan finds a file
  // that a process created after the first scan.
  const left = dryRun ? skipped : oldLockFiles(config);
  for (const path of left) {
    if (!skipped.includes(path)) log(`left ${path}: it appeared during this run; a rerun deletes it`);
  }
  const dropOld = left.length === 0;
  if (dropOld && migrated(text, true) !== text) {
    text = migrated(text, true);
    write(text);
    log(`${verb('removed', 'would remove')} the old lock lines from .gitignore`);
  }

  // 4. One commit of `.gitignore`, only when it is what steps 1 and 3 make of
  // the HEAD version: also when an earlier run wrote it and then failed
  // before its commit or in it, never with a change the migration did not
  // make. The index must hold HEAD's version or that text, since the commit
  // stages the file over whatever the index holds.
  const head = textAt(root, 'HEAD', '.gitignore') ?? '';
  const ours = migrated(head, dropOld);
  if (ours === head) {
    if (deleted.length === 0 && skipped.length === 0) log('nothing to do');
    return { deleted, skipped, commit: null };
  }
  const staged = textAt(root, '', '.gitignore') ?? '';
  if (text !== ours || (staged !== head && staged !== ours)) {
    log(`left .gitignore uncommitted: it holds changes this migration did not make; commit it yourself`);
    return { deleted, skipped, commit: null };
  }
  if (text === before) log(`${verb('commits', 'would commit')} the .gitignore an earlier run left uncommitted`);
  if (dryRun) return { deleted, skipped, commit: null };
  const commit = await commitPaths(root, ['.gitignore'], 'chore: S-1495 lock files live under .bl/');
  return { deleted, skipped, commit };
}

/** What steps 1 and 3 make of the `.gitignore` text: `.bl/` added, and with `dropOld` the old lock lines removed. */
function migrated(text, dropOld) {
  const added = withGitignoreLines(text, [BL_DIR_LINE]).text;
  if (!dropOld) return added;
  return added
    .split('\n')
    .filter((l) => !OLD_LOCK_FILES.includes(l.trim()))
    .join('\n');
}

/**
 * Delete the old lock file `path` while this process holds its kernel lock,
 * so no other descriptor can take the lock between the check and the delete.
 * When another process holds the lock, delete nothing and return its holder.
 * @param {string} path
 * @returns {number | 'unknown' | null}
 */
function deleteUnderLock(path) {
  const res = tryLockOnce(path);
  if ('holder' in res) return res.holder;
  try {
    rmSync(path, { force: true });
  } finally {
    release(res.taken);
  }
  return null;
}
