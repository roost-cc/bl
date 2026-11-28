/**
 * git.js — run git in a test's temp repo (F-135 D1).
 *
 * Copied from `test/helpers/git-backlog.js`, cut down to `git` and its
 * identity. The tests of `next/` that build temp repos share it, and
 * `initRepo` for a repo that `bl`'s own git children commit in, and
 * `tempRepo` for a repo context (F-141 D6).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempDir } from './tempdir.js';

/** Identity for commits, without reading the developer's git config. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/**
 * Run git in `cwd`; throws on a non-zero exit, returns trimmed stdout.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
export function git(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Make `dir` a git repo on `main` whose own config gives the commit identity
 * and the repo's own hooks (`.git/hooks`), so that a git child that reads the
 * developer's config (`lib/child.js` `git`) commits there as `git` above does.
 * @param {string} dir
 */
export function initRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  configureRepo(dir);
}

/**
 * Clone `url` into `dir` and give the clone the config of `initRepo`.
 * @param {string} url
 * @param {string} dir
 */
export function cloneRepo(url, dir) {
  git(process.cwd(), 'clone', '-q', url, dir);
  configureRepo(dir);
}

/**
 * Give the repo `dir` the commit identity and its own hooks (`initRepo`).
 * @param {string} dir
 */
function configureRepo(dir) {
  for (const [key, value] of Object.entries({
    'user.name': GIT_ENV.GIT_AUTHOR_NAME,
    'user.email': GIT_ENV.GIT_AUTHOR_EMAIL,
    'commit.gpgsign': 'false',
    'core.hooksPath': '.git/hooks',
  }))
    git(dir, 'config', key, value);
}

/**
 * A repo context (F-140 D4) of a fresh repo of `initRepo` with one commit,
 * whose worktree is the repo itself.
 * @param {string} name  the context's `repo`
 * @returns {{ repo: string, repo_path: string, worktree_path: string, branch: string, base: string }}
 */
export function tempRepo(name) {
  const path = mkTempDir(`bl-repo-${name}-`);
  initRepo(path);
  writeFileSync(join(path, 'a'), 'a\n');
  git(path, 'add', 'a');
  git(path, 'commit', '-q', '-m', 'a');
  return { repo: name, repo_path: path, worktree_path: path, branch: 'main', base: 'main' };
}
