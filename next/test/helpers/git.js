/**
 * git.js — run git in a test's temp repo (F-135 D1).
 *
 * Copied from `test/helpers/git-backlog.js`, cut down to `git` and its
 * identity. The tests of `next/` that build temp repos share it.
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
