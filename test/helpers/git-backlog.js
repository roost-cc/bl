/**
 * git-backlog.js — turn a tempdir backlog into a git repo for tests of the
 * commands that commit their own backlog changes (`bl sync --commit`,
 * `bl done`, `bl new`, `bl merge`).
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { LOCK_FILE } from '../../src/lock.js';
import { runBl } from './run-bl.js';
import { mkTempDir } from './tempdir.js';

/** Identity for commits, without reading the developer's git config. */
export const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/** Run git in `cwd`; throws on a non-zero exit, returns trimmed stdout. */
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
 * `git init -b main` the backlog at `dir`, sync it once and commit the result
 * as the base, so a test starts from a clean tree.
 */
export function initGitBacklog(dir) {
  writeFileSync(join(dir, '.gitignore'), `${LOCK_FILE}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  const r = runBl(['sync'], { cwd: dir });
  if (r.status !== 0) throw new Error(`seed sync failed: ${r.stderr}`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
}

/**
 * Give the repo at `dir` a bare `origin` with its `main` pushed, so HEAD
 * is `origin/main`, as a migration requires (F-51 decision R2).
 */
export function addOrigin(dir) {
  const bare = mkTempDir('bl-origin-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
}

/** `git show --name-status --no-renames HEAD` as sorted "X\tpath" lines. */
export function headFiles(dir) {
  return git(dir, 'show', '--name-status', '--no-renames', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
}

/**
 * Dirty a bystander story and pre-stage an unrelated new file, so a test can
 * check that neither rides along in the command's commit.
 * @param {string} dir
 * @param {string} bystanderIndex backlog-relative path of a story index.md
 */
export function dirtyBystanders(dir, bystanderIndex) {
  writeFileSync(join(dir, bystanderIndex), "\nA bystander's edit.\n", {
    flag: 'a',
  });
  writeFileSync(join(dir, 'staged.txt'), 'pre-staged\n');
  git(dir, 'add', 'staged.txt');
}

/**
 * `git status --porcelain` lines (untracked files listed), sorted. Read raw:
 * `git()` trims, which would eat the first line's leading status column.
 */
export function statusLines(dir) {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git status: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean).sort();
}
