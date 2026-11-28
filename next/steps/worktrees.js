/**
 * worktrees.js — the repo contexts of an item, and the worktree snapshot
 * (F-141 D6, Decision A1).
 *
 *   - `repoContexts(ctx)` gives the item's repo contexts (`RepoContext`, F-140
 *     D4). It gives `[]` until F-143's `prepare` records worktrees; F-143
 *     changes only this function.
 *   - `snapshot(repos)` gives each repo's `HEAD`, `git status --porcelain`
 *     and a hash of its uncommitted content.
 *   - `changed(before, repos)` is true when a repo's `HEAD`, status or content
 *     differs from the snapshot `before`; `clean(repos)` is true when no repo has an
 *     uncommitted change.
 *
 * The runner takes a snapshot before each step. `worktree_unchanged()`,
 * `worktree_clean()` and the D-120 rule of the `agent` step compare with it,
 * so all three use one comparison.
 */

import { createHash } from 'crypto';
import { lstatSync, readFileSync, readlinkSync } from 'fs';
import { join } from 'path';
import { describeExit, git, gitOut } from '../lib/child.js';

/**
 * @typedef {import('./stage.js').RepoContext} RepoContext
 * @typedef {{ repo: string, head: string, status: string, content: string }} RepoSnapshot  one repo's state;
 *   `content` is the hash of its uncommitted content (`contentOf`)
 */

/**
 * The repo contexts of the item of `ctx`: none until F-143 (Decision A1).
 * @param {{ id: string }} _ctx  the item's context
 * @returns {RepoContext[]}
 */
export const repoContexts = (_ctx) => [];

/** The `git status --porcelain` of the worktree of `repo`. */
const statusOf = (/** @type {RepoContext} */ repo) => gitOut(repo.worktree_path, ['status', '--porcelain']);

/**
 * A hash of the uncommitted content of the worktree of `repo`: the diff of the
 * tracked files against `HEAD`, and the name and content of each untracked
 * file that git does not ignore. A second edit of a file that is already
 * modified or untracked leaves `git status` as it was, and changes this hash.
 * @param {RepoContext} repo
 * @returns {string}
 */
function contentOf(repo) {
  const cwd = repo.worktree_path;
  const hash = createHash('sha256').update(gitOut(cwd, ['diff', 'HEAD', '--binary']));
  const args = ['ls-files', '-z', '--others', '--exclude-standard'];
  const r = git(cwd, args);
  if (r.error || r.status !== 0) throw new Error(describeExit(r, `git ${args.join(' ')}`));
  for (const name of String(r.stdout).split('\0').filter(Boolean)) {
    const path = join(cwd, name);
    const stat = lstatSync(path);
    // A nested repository is listed as a directory, by its name only.
    const data = stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? readFileSync(path) : '';
    hash.update(`${name}\0${data.length}\0`).update(data);
  }
  return hash.digest('hex');
}

/**
 * Each repo's `HEAD`, status and uncommitted content.
 * @param {readonly RepoContext[]} repos
 * @returns {RepoSnapshot[]}
 */
export const snapshot = (repos) =>
  repos.map((repo) => ({
    repo: repo.repo,
    head: gitOut(repo.worktree_path, ['rev-parse', 'HEAD']),
    status: statusOf(repo),
    content: contentOf(repo),
  }));

/**
 * Whether a repo of `repos` has a `HEAD`, a status or an uncommitted content
 * that differs from the snapshot `before`, or is not in it.
 * @param {readonly RepoSnapshot[]} before
 * @param {readonly RepoContext[]} repos
 */
export function changed(before, repos) {
  return snapshot(repos).some((now) => {
    const then = before.find(({ repo }) => repo === now.repo);
    return then === undefined || then.head !== now.head || then.status !== now.status || then.content !== now.content;
  });
}

/**
 * Whether no repo of `repos` has an uncommitted change.
 * @param {readonly RepoContext[]} repos
 */
export const clean = (repos) => repos.every((repo) => statusOf(repo) === '');
