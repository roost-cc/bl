// `bl gc` (S-1112): the run files and worktree directories of done and
// superseded work units go; an open work unit's are untouched and unlisted,
// and a name that is no work unit's is kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, git } from '../helpers/git-backlog.js';

/** The run files of the fixture, as `[name, isDirectory]`. */
const RUN_FILES = [
  ['S-1.S-1.scratch', true],
  ['S-1.r1.correctness.scratch', true],
  ['S-1.test-1.log', false],
  ['S-1.test-2.log', false],
  ['S-1.test-3.log', false],
  ['S-1.json', false],
  ['S-1.r1.correctness.md', false],
  ['S-2.S-2.scratch', true],
  ['S-3.S-3.scratch', true],
  ['S-3.test-1.log', false],
  ['S-3.test-2.log', false],
  ['F-89-spec.json', false],
];

/**
 * A backlog with S-1 done, S-2 superseded, S-3 open and S-4 done, a `.bl/run`
 * holding `RUN_FILES`, and a repo `code` with worktrees under the worktree
 * root `wt/`: S-1's clean one beside a `.codex` sandbox stub, S-4's with an
 * untracked file, S-3's, and a directory `docs` that names no work unit.
 */
function gcBacklog() {
  const t = mkTempBacklog({
    repos: { code: './code' },
    config: { worktrees: './wt' },
    components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Done', dirSuffix: 'done', status: 'done' },
      { id: 'S-2', component: 'C00', title: 'Gone', dirSuffix: 'gone', status: 'superseded' },
      { id: 'S-3', component: 'C00', title: 'Open', dirSuffix: 'open', status: 'in_progress' },
      { id: 'S-4', component: 'C00', title: 'Dirty', dirSuffix: 'dirty', status: 'done' },
    ],
  });
  const { dir } = t;
  const run = join(dir, '.bl', 'run');
  mkdirSync(run, { recursive: true });
  for (const [name, isDir] of RUN_FILES) {
    if (isDir) {
      mkdirSync(join(run, name));
      writeFileSync(join(run, name, 'probe.txt'), 'x'.repeat(100));
    } else writeFileSync(join(run, name), '{}\n');
  }

  const code = join(dir, 'code');
  git(dir, 'init', '-q', '-b', 'main', code);
  git(code, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(dir, 'wt');
  for (const branch of ['s1-done', 's3-open', 's4-dirty']) {
    git(code, 'worktree', 'add', '-q', '-b', branch, join(wt, branch, 'code'));
  }
  mkdirSync(join(wt, 's1-done', '.codex'));
  writeFileSync(join(wt, 's4-dirty', 'code', 'notes.txt'), 'work in progress\n');
  mkdirSync(join(wt, 'docs'));
  return { ...t, run, code, wt };
}

/** The stdout lines, sorted. */
const lines = (out) => out.split('\n').filter(Boolean).sort();

test('bl gc --dry-run lists what it would remove and the kept names, and changes nothing', () => {
  const { dir, run, code, wt, cleanup } = gcBacklog();
  try {
    const runBefore = readdirSync(run).sort();
    const r = runBl(['gc', '--dry-run'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      lines(r.stdout),
      [
        `would remove ${join(run, 'S-1.S-1.scratch')}`,
        `would remove ${join(run, 'S-1.r1.correctness.scratch')}`,
        `would remove ${join(run, 'S-1.test-1.log')}`,
        `would remove ${join(run, 'S-1.test-2.log')}`,
        `would remove ${join(run, 'S-2.S-2.scratch')}`,
        `kept ${join(run, 'F-89-spec.json')} (names no work unit)`,
        `would remove ${join(wt, 's1-done')}`,
        `kept ${join(wt, 's4-dirty', 'code')} (uncommitted changes in 1 paths)`,
        `kept ${join(wt, 'docs')} (names no work unit)`,
      ].sort(),
    );
    assert.match(r.stderr, /^bl gc: would remove 6 paths, \d+(\.\d)? [KM]?B; kept 3\.$/m);
    assert.deepEqual(readdirSync(run).sort(), runBefore, 'no run file removed');
    assert.ok(existsSync(join(wt, 's1-done', 'code')), 'no worktree removed');
    assert.match(git(code, 'worktree', 'list'), /s1-done/);
  } finally {
    cleanup();
  }
});

test('bl gc removes the run files and the directories of closed work units and keeps the rest', () => {
  const { dir, run, code, wt, cleanup } = gcBacklog();
  try {
    const r = runBl(['gc'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      lines(r.stdout).filter((l) => l.startsWith('removed ')),
      [
        `removed ${join(run, 'S-1.S-1.scratch')}`,
        `removed ${join(run, 'S-1.r1.correctness.scratch')}`,
        `removed ${join(run, 'S-1.test-1.log')}`,
        `removed ${join(run, 'S-1.test-2.log')}`,
        `removed ${join(run, 'S-2.S-2.scratch')}`,
        `removed ${join(wt, 's1-done')}`,
      ].sort(),
    );
    assert.match(r.stderr, /^bl gc: removed 6 paths, \d+(\.\d)? [KM]?B; kept 3\.$/m);
    assert.deepEqual(readdirSync(run).sort(), [
      'F-89-spec.json',
      'S-1.json',
      'S-1.r1.correctness.md',
      'S-1.test-3.log',
      'S-3.S-3.scratch',
      'S-3.test-1.log',
      'S-3.test-2.log',
    ]);
    assert.ok(!existsSync(join(wt, 's1-done')), 'the whole directory goes, the stub with it');
    assert.doesNotMatch(git(code, 'worktree', 'list'), /s1-done/);
    assert.ok(existsSync(join(wt, 's4-dirty', 'code', 'notes.txt')), 'the dirty worktree stays');
    assert.ok(existsSync(join(wt, 's3-open', 'code')), 'the open work unit is untouched');
    assert.ok(existsSync(join(wt, 'docs')));
    assert.doesNotMatch(r.stdout, /s3-open|S-3/);
  } finally {
    cleanup();
  }
});

test('bl gc refuses an argument it does not take', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    for (const args of [
      ['gc', 'S-1'],
      ['gc', '--force'],
    ]) {
      const r = runBl(args, { cwd: dir });
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /Usage: bl gc \[--dry-run\]/);
    }
  } finally {
    cleanup();
  }
});
