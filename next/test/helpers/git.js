/**
 * git.js — run git in a test's temp repo (F-135 D1).
 *
 * Copied from `test/helpers/git-backlog.js`, cut down to `git` and its
 * identity. The tests of `next/` that build temp repos share it, and
 * `initRepo` for a repo that `bl`'s own git children commit in.
 */

import { spawnSync } from 'node:child_process';

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
