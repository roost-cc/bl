import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { repoGuardWarnings, diffAgainstMain, strayWorktrees, defaultRunner } from '../../src/feature-run.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV } from '../helpers/git-backlog.js';

test('repo_guard_counts_git_names_for_all_filename_classes_and_warns_per_repo_only', () => {
  // Real git: every filename class reaches the guard exactly as git names it,
  // a path outside the unit's components gets no warning, a repo with no story
  // gets one, and a worktree path holding a newline stays whole.
  const repo = mkTempDir('bl-guard-names-');
  const g = (...args) => {
    const r = spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(r.status, 0, r.stderr);
  };
  g('init', '-q', '-b', 'main');
  g('commit', '--allow-empty', '-qm', 'base');
  g('checkout', '-qb', 'f1-feat');
  const inside = [
    'src/plain.js',
    ' spaced.js ',
    'src/é.js',
    'src/tab\t.js',
    'src/line\n.js',
    'src/quo"te.js',
    'src/back\\slash.js',
  ];
  const outside = [' a.txt'];
  mkdirSync(join(repo, 'src'), { recursive: true });
  for (const name of [...inside, ...outside]) writeFileSync(join(repo, name), 'x');
  g('add', '-A');
  g('commit', '-qm', 'files');
  const ctx = { runner: defaultRunner(), config: { reposByName: { r: repo } }, prep: { branchName: 'f1-feat' } };
  const files = diffAgainstMain(ctx, repo);
  assert.deepEqual([...files].sort(), [...inside, ...outside].sort());
  const components = [
    { id: 'C1', repo: 'r', paths: ['src/**', ' spaced.js '] },
    { id: 'C2', repo: 'r', paths: ['a.txt'] },
    { id: 'C3', repo: 'other', paths: ['**'] },
  ];
  assert.deepEqual(
    repoGuardWarnings([{ repo: 'r', files }], new Set(['C1']), components),
    [],
    'outside[0] is in no component, and gets no warning',
  );
  assert.deepEqual(repoGuardWarnings([{ repo: 'r', files }], new Set(['C3']), components), [
    `r: ${inside.length + outside.length} changed paths, but no story of the unit is in this repo`,
  ]);

  g('checkout', '-q', 'main');
  const wt = join(mkTempDir('bl-guard-wt-'), 'wt\nline');
  g('worktree', 'add', '-q', wt, 'f1-feat');
  assert.deepEqual(strayWorktrees(ctx, new Set()), [{ repo: 'r', worktreePath: wt }]);
});
