/**
 * The suite runs without git's repository variables (`git rev-parse
 * --local-env-vars`: `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, …). Git
 * exports `GIT_DIR` to a pre-push hook in a linked worktree, and the pre-push
 * gate runs this suite. With it set, every git call a test makes in its temp
 * repo acts on that worktree's repo instead: the gate rewrote the worktree's
 * index (S-1330). `test/helpers/without-repo-env.sh` unsets them for every
 * `npm run test:*` script.
 *
 * The same wrapper unsets `BL_BACKLOG_DIR` and refuses a temporary directory
 * inside a git repository (S-1394): with `TMPDIR` inside the backlog's working
 * tree, git in a test's temp dir found the real backlog's `.git`, and the
 * tests took its main sync lock and pushed to its origin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempDir } from '../helpers/tempdir.js';

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'without-repo-env.sh');

function localEnvVars() {
  const r = spawnSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

test('the suite runs with none of git’s repository variables set', () => {
  const vars = localEnvVars();
  assert.ok(vars.includes('GIT_DIR'), vars.join('\n'));
  assert.deepEqual(
    vars.filter((v) => process.env[v] !== undefined),
    [],
  );
});

test('the suite runs without BL_BACKLOG_DIR', () => {
  assert.equal(process.env.BL_BACKLOG_DIR, undefined, 'run `npm run test:unit`, which unsets BL_BACKLOG_DIR');
});

test('the suite runs with BL_CEILING_DIRECTORIES at its own temporary directory', () => {
  assert.equal(
    process.env.BL_CEILING_DIRECTORIES,
    tmpdir(),
    'run `npm run test:unit`, which sets BL_CEILING_DIRECTORIES',
  );
});

/**
 * Run the wrapper with `true` and `TMPDIR` set, in an env free of git's
 * repository variables, plus `extra`.
 */
function runWrapper(tmpdir, extra = {}) {
  const env = { ...process.env, TMPDIR: tmpdir };
  for (const v of localEnvVars()) delete env[v];
  Object.assign(env, extra);
  return spawnSync('bash', [WRAPPER, 'true'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A fresh `git init` repository in a temp dir. */
function tempRepo() {
  const repo = mkTempDir('bl-tmpdir-repo-');
  const r = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 0, r.stderr);
  return repo;
}

test('the wrapper refuses a TMPDIR inside a git working tree', () => {
  const repo = tempRepo();
  const tmp = join(repo, 'scratch', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const r = runWrapper(tmp);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(tmp), r.stderr);
  assert.ok(r.stderr.includes(`git repository ${repo}.`), r.stderr);
  assert.match(r.stderr, /outside every git repository/);
});

test('the wrapper refuses a TMPDIR inside a repository’s .git directory', () => {
  const repo = tempRepo();
  const tmp = join(repo, '.git', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const r = runWrapper(tmp);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(tmp), r.stderr);
  assert.ok(r.stderr.includes(`git repository ${join(repo, '.git')}.`), r.stderr);
});

test('the wrapper accepts a TMPDIR outside every git repository', () => {
  const r = runWrapper(mkTempDir('bl-tmpdir-plain-'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('an exported GIT_DIR does not decide where the temporary directory is', () => {
  const r = runWrapper(mkTempDir('bl-tmpdir-plain-'), { GIT_DIR: join(tempRepo(), '.git') });
  assert.equal(r.status, 0, r.stderr);
});
