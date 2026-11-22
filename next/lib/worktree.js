/**
 * worktree.js — the git primitives of worktrees (F-135 D4, "Worktrees: the
 * git primitives only").
 *
 * Carried from `src/story.js` (`listWorktrees`, `worktreeChanges`,
 * `findExistingWorktree`) and `src/session.js` (`prepareWorktreeOnce`).
 * `ensureWorktree` and `newWorktreeGuards` stay out: they mix git work with
 * the policy of the `prepare` step (F-143). These four call only git and the
 * prepare lock.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { git, gitOut } from './child.js';
import { release, tryLockOnce } from './kernel-lock.js';
import { awaitLock } from './lock-wait.js';
import { info } from './stderr.js';

/**
 * List all story worktrees for a given repo path. With `detached`, a
 * worktree on no branch (a detached HEAD, as `bl updates` makes) is listed
 * too, with `branch: null`. With `strict`, a list that may be incomplete
 * throws, not a shorter list: a repo path that is not there, a failed
 * `git worktree list`, or a record with no `worktree` line.
 * @param {string} repoPath
 * @param {{ detached?: boolean, strict?: boolean }} [opts]
 * @returns {{ path: string, branch: string | null }[]}
 */
export function listWorktrees(repoPath, { detached = false, strict = false } = {}) {
  const results = [];
  if (!existsSync(repoPath)) {
    if (strict) throw new Error(`no repo at ${repoPath}`);
    return results;
  }
  try {
    const output = gitOut(repoPath, ['worktree', 'list', '--porcelain']);
    for (const entry of output.split('\n\n').filter(Boolean)) {
      const lines = entry.split('\n');
      const pathLine = lines.find((l) => l.startsWith('worktree '));
      const branchLine = lines.find((l) => l.startsWith('branch '));
      if (!pathLine && strict) throw new Error(`git worktree list: a record has no worktree line: ${lines[0]}`);
      if (!pathLine || (!branchLine && !detached)) continue;
      const wPath = pathLine.slice('worktree '.length);
      const wBranch = branchLine ? branchLine.slice('branch refs/heads/'.length) : null;
      if (wPath !== repoPath) results.push({ path: wPath, branch: wBranch });
    }
  } catch (err) {
    // no worktrees or not a git repo
    if (strict) throw err;
  }
  return results;
}

/**
 * Uncommitted changes in a worktree (tracked or untracked). Null when git
 * cannot tell.
 *
 * @param {string} worktreePath
 * @returns {string[] | null}
 */
export function worktreeChanges(worktreePath) {
  const r = git(worktreePath, ['status', '--porcelain']);
  return r.status === 0 ? r.stdout.split('\n').filter((l) => l.trim()) : null;
}

/**
 * Find an existing worktree by branch name in a specific repo.
 * @param {string} repoPath
 * @param {string} branchName
 * @returns {{ path: string, branch: string | null } | null}
 */
export function findExistingWorktree(repoPath, branchName) {
  return listWorktrees(repoPath).find((w) => w.branch === branchName) ?? null;
}

/**
 * Run `fn` (making a worktree and running its bootstrap and `workon` plugins)
 * as the only preparer of `branchName`'s worktree in `repoPath` (S-862): a
 * concurrent `bl run` or `bl implement` waits here, then finds the worktree
 * made and its `workon` debt paid, or still owed if this one failed. The lock
 * sits in the repo's common git dir, since the worktree may not exist yet. It
 * is a kernel lock (`kernel-lock.js`, F-104): a preparer that ends holding it
 * leaves no lock, and its file stays (D3).
 *
 * The wait goes through `awaitLock` (`lock-wait.js`, F-105 W1) with no
 * deadline (F-105 A3): the lock is held while bootstrap and `workon` plugins
 * run. Ctrl+C during the wait ends `bl` at once. `fn` is async and awaited
 * (F-105 W4): `ensureWorktree` in it waits for the main-sync lock, so the
 * lock order is prepare, then main-sync. Because `fn` awaits, the take is not
 * re-entrant (`tryLockOnce`): another task of this process waits too.
 *
 * @template T
 * @param {string} repoPath
 * @param {string} branchName
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function prepareWorktreeOnce(repoPath, branchName, fn) {
  const commonDir = gitOut(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lockPath = join(commonDir, `bl-prepare-${branchName.replace(/[^\w.-]/g, '_')}.lock`);
  const take = () => tryLockOnce(lockPath, `prepare ${branchName}`);
  const { taken } = await awaitLock(lockPath, take, { deadlineMs: null, pollMs: 100, announce: info });
  try {
    return await fn();
  } finally {
    release(taken);
  }
}
