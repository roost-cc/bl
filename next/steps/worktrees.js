/**
 * worktrees.js — the repo contexts of an item, and the worktree snapshot
 * (F-141 D6, Decision A1).
 *
 *   - `repoContexts(ctx)` gives the item's repo contexts (`RepoContext`, F-140
 *     D4). It gives `[]` until F-143's `prepare` records worktrees; F-143
 *     changes only this function.
 *   - `snapshot(repos)` gives each repo's `HEAD` and `git status --porcelain`.
 *   - `changed(before, repos)` is true when a repo's `HEAD` or status differs
 *     from the snapshot `before`; `clean(repos)` is true when no repo has an
 *     uncommitted change.
 *
 * The runner takes a snapshot before each step. `worktree_unchanged()`,
 * `worktree_clean()` and the D-120 rule of the `agent` step compare with it,
 * so all three use one comparison.
 */

import { gitOut } from '../lib/child.js';

/**
 * @typedef {import('./stage.js').RepoContext} RepoContext
 * @typedef {{ repo: string, head: string, status: string }} RepoSnapshot  one repo's state
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
 * Each repo's `HEAD` and status.
 * @param {readonly RepoContext[]} repos
 * @returns {RepoSnapshot[]}
 */
export const snapshot = (repos) =>
  repos.map((repo) => ({
    repo: repo.repo,
    head: gitOut(repo.worktree_path, ['rev-parse', 'HEAD']),
    status: statusOf(repo),
  }));

/**
 * Whether a repo of `repos` has a `HEAD` or a status that differs from the
 * snapshot `before`, or is not in it.
 * @param {readonly RepoSnapshot[]} before
 * @param {readonly RepoContext[]} repos
 */
export function changed(before, repos) {
  return snapshot(repos).some((now) => {
    const then = before.find(({ repo }) => repo === now.repo);
    return then === undefined || then.head !== now.head || then.status !== now.status;
  });
}

/**
 * Whether no repo of `repos` has an uncommitted change.
 * @param {readonly RepoContext[]} repos
 */
export const clean = (repos) => repos.every((repo) => statusOf(repo) === '');
