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
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'fs';
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

/** The `git status --porcelain` of the worktree `cwd`. */
const statusIn = (/** @type {string} */ cwd) => gitOut(cwd, ['status', '--porcelain']);

/** The `git status --porcelain` of the worktree of `repo`. */
const statusOf = (/** @type {RepoContext} */ repo) => statusIn(repo.worktree_path);

/** The NUL-separated names that `git <args>` prints in `cwd`. */
function namesOf(/** @type {string} */ cwd, /** @type {string[]} */ args) {
  const r = git(cwd, args);
  if (r.error || r.status !== 0) throw new Error(describeExit(r, `git ${args.join(' ')}`));
  return String(r.stdout).split('\0').filter(Boolean);
}

/**
 * A hash of the uncommitted content of the worktree `cwd`: the staged and the
 * unstaged diff, the name and content of each untracked file that git does not
 * ignore, and the state of each nested repository. A second edit of a file
 * that is already modified or untracked leaves `git status` as it was, and
 * changes this hash.
 *
 * A nested repository is an untracked directory with its own `.git`, which
 * git lists by its name only, or a gitlink (a submodule entry) whose directory
 * is checked out. Its outer status and diff stay the same while files inside
 * it change, so its `HEAD`, status and content go into the hash too, at every
 * depth.
 * @param {string} cwd
 * @returns {string}
 */
function contentOf(cwd) {
  const hash = createHash('sha256')
    .update(gitOut(cwd, ['diff', '--cached', '--binary']))
    .update('\0')
    .update(gitOut(cwd, ['diff', '--binary']));
  /** @type {string[]} */
  const nested = [];
  for (const name of namesOf(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])) {
    const path = join(cwd, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) nested.push(name);
    else {
      const data = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
      hash.update(`${name}\0${data.length}\0`).update(data);
    }
  }
  for (const line of namesOf(cwd, ['ls-files', '-z', '--stage'])) {
    // `<mode> <object> <stage>\t<name>`; mode 160000 is a gitlink.
    if (line.startsWith('160000 ')) nested.push(line.slice(line.indexOf('\t') + 1));
  }
  for (const name of nested) {
    const path = join(cwd, name);
    if (!existsSync(join(path, '.git'))) continue;
    const head = git(path, ['rev-parse', '--verify', '-q', 'HEAD']);
    hash.update(`${name}\0${String(head.stdout).trim()}\0${statusIn(path)}\0${contentOf(path)}\0`);
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
    content: contentOf(repo.worktree_path),
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
