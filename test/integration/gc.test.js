// `bl gc` (S-1112): the run files and worktree directories of done and
// superseded work units go; an open work unit's are untouched and unlisted,
// and a name that is no work unit's is kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, git } from '../helpers/git-backlog.js';
import { REAL_GIT } from '../helpers/backlog-commit-fixture.js';

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

test('bl gc removes a closed work unit directory whose registered worktree was deleted by hand', () => {
  const { dir, code, wt, cleanup } = gcBacklog();
  try {
    git(code, 'worktree', 'add', '-q', '-b', 's2-gone', join(wt, 's2-gone', 'code'));
    rmSync(join(wt, 's2-gone', 'code'), { recursive: true, force: true });
    mkdirSync(join(wt, 's2-gone', '.ruff_cache'));
    const r = runBl(['gc'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^removed ${join(wt, 's2-gone')}$`, 'm'));
    assert.ok(!existsSync(join(wt, 's2-gone')));
    assert.doesNotMatch(git(code, 'worktree', 'list'), /s2-gone/);
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

/**
 * A directory to put first on PATH whose `git` runs `prelude` (shell) and
 * then the real git.
 */
function gitShim(dir, prelude) {
  const bin = join(dir, 'shim');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${prelude}\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  return { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` };
}

test('gc_keeps_unit_on_list_failure_or_late_worktree', async (t) => {
  for (const mode of ['--dry-run', 'remove']) {
    await t.test(`${mode}: a failed git worktree list keeps every closed work unit directory`, () => {
      const { dir, run, wt, cleanup } = gcBacklog();
      try {
        const env = gitShim(dir, 'if [ "$1 $2" = "worktree list" ]; then echo injected-list-failure >&2; exit 1; fi');
        const r = runBl(mode === 'remove' ? ['gc'] : ['gc', mode], { cwd: dir, env });
        assert.equal(r.status, 1, r.stderr);
        assert.match(
          r.stdout,
          new RegExp(
            `^kept ${join(wt, 's1-done')} \\(git cannot list the worktrees: .*injected-list-failure.*\\)$`,
            'm',
          ),
        );
        assert.match(r.stdout, new RegExp(`^kept ${join(wt, 's4-dirty')} \\(git cannot list the worktrees`, 'm'));
        assert.doesNotMatch(r.stdout, /(removed|would remove) .*\/wt\//);
        assert.ok(existsSync(join(wt, 's1-done', 'code')));
        assert.ok(existsSync(join(wt, 's4-dirty', 'code', 'notes.txt')));
        // The run files are swept all the same.
        assert.match(r.stdout, new RegExp(`(removed|would remove) ${join(run, 'S-1.S-1.scratch')}`));
      } finally {
        cleanup();
      }
    });
  }

  await t.test('a worktree registered in the directory after the first listing keeps it', () => {
    const { dir, code, wt, cleanup } = gcBacklog();
    try {
      const late = join(wt, 's1-done', 'late');
      const fired = join(dir, 'shim-fired');
      const env = gitShim(
        dir,
        `if [ "$1 $2" = "worktree list" ] && [ ! -e '${fired}' ]; then : > '${fired}'; "${REAL_GIT}" "$@"; ` +
          `"${REAL_GIT}" -C '${code}' worktree add -q --detach '${late}' >/dev/null 2>&1; exit 0; fi`,
      );
      const r = runBl(['gc'], { cwd: dir, env });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^kept ${late} \\(registered while bl gc ran\\)$`, 'm'));
      assert.doesNotMatch(r.stdout, new RegExp(`^removed ${join(wt, 's1-done')}$`, 'm'));
      assert.ok(existsSync(late), 'the late worktree stays');
      assert.match(git(code, 'worktree', 'list'), /s1-done\/late/);
    } finally {
      cleanup();
    }
  });
});

test('gc_reports_partial_cleanup_and_prune_failure: each failed step is a failed kept line, and the rest is still printed', async (t) => {
  /** `fail` is a shell test on the git arguments; `kept` is the kept line's path and reason. */
  const cases = [
    {
      name: 'unreadable status',
      fail: '[ "$1" = status ]',
      kept: (wt) => [join(wt, 's1-done', 'code'), 'git cannot read its status'],
    },
    {
      name: 'refused removal',
      fail: '[ "$1 $2" = "worktree remove" ]',
      kept: (wt) => [join(wt, 's1-done', 'code'), 'injected'],
    },
    {
      name: 'failed prune',
      fail: '[ "$1 $2" = "worktree prune" ]',
      kept: (_wt, code) => [code, 'git worktree prune: injected'],
    },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const { dir, run, code, wt, cleanup } = gcBacklog();
      try {
        const env = gitShim(dir, `if ${c.fail}; then echo injected >&2; exit 1; fi`);
        const r = runBl(['gc'], { cwd: dir, env });
        assert.equal(r.status, 1, r.stderr);
        const [path, reason] = c.kept(wt, code);
        assert.match(r.stdout, new RegExp(`^kept ${path} \\(${reason}\\)$`, 'm'));
        assert.match(r.stdout, new RegExp(`^removed ${join(run, 'S-1.S-1.scratch')}$`, 'm'));
        assert.match(r.stderr, /^bl gc: removed \d+ paths/m);
      } finally {
        cleanup();
      }
    });
  }

  await t.test('a worktree sweep that stops on an error still reports the run files removed', () => {
    const { dir, run, wt, cleanup } = gcBacklog();
    try {
      rmSync(wt, { recursive: true, force: true });
      writeFileSync(wt, 'not a directory\n');
      const r = runBl(['gc'], { cwd: dir, env: GIT_ENV });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stdout, new RegExp(`^removed ${join(run, 'S-1.S-1.scratch')}$`, 'm'));
      assert.match(r.stdout, new RegExp(`^kept ${wt} \\(.*ENOTDIR.*\\)$`, 'm'));
      assert.ok(!existsSync(join(run, 'S-1.S-1.scratch')));
      assert.match(r.stderr, /^bl gc: removed 5 paths, .*; kept 2\.$/m);
    } finally {
      cleanup();
    }
  });
});

/**
 * A backlog with a done feature F-7 (its story S-5 done), a done story batch
 * B-3 (its story S-6 done), their run files, and a worktree root `wt/` with a
 * directory per branch, plus `F7-feat` (the branch with its case kept).
 */
function featureBatchBacklog() {
  const t = mkTempBacklog({
    config: { worktrees: './wt' },
    stories: [
      { id: 'S-5', title: 'In feature', dirSuffix: 'in-feature', status: 'done', feature: 'F-7' },
      { id: 'S-6', title: 'In batch', dirSuffix: 'in-batch', status: 'done', batch: 'B-3' },
    ],
    features: [{ id: 'F-7', title: 'Feat', dirSuffix: 'feat', status: 'done' }],
    batches: [
      {
        id: 'B-3',
        title: 'Batch',
        transitions: [
          { at: '2026-11-12T00:00:00Z', to: 'approved', by: 'new' },
          { at: '2026-11-13T00:00:00Z', to: 'done', by: 'merge' },
        ],
      },
    ],
  });
  const run = join(t.dir, '.bl', 'run');
  mkdirSync(run, { recursive: true });
  for (const name of [
    'F-7.S-5.scratch',
    'B-3.r1.fix.scratch',
    'S-6.S-6.scratch',
    'F7.S-5.scratch',
    'f-7.S-5.scratch',
  ]) {
    mkdirSync(join(run, name));
  }
  for (const name of ['F-7.test-1.log', 'F-7.test-2.log', 'B-3.test-1.log', 'B-3.test-2.log', 'F-7.json']) {
    writeFileSync(join(run, name), '{}\n');
  }
  const wt = join(t.dir, 'wt');
  for (const d of ['f7-feat', 'b3-batch', 's5-in-feature', 's6-in-batch', 'F7-feat']) {
    mkdirSync(join(wt, d, '.codex'), { recursive: true });
  }
  return { ...t, run, wt };
}

test('gc_matches_story_feature_and_batch_branch_names and gc_selects_feature_and_batch_run_files', async (t) => {
  for (const [mode, verb] of [
    ['--dry-run', 'would remove'],
    ['remove', 'removed'],
  ]) {
    await t.test(mode, () => {
      const { dir, run, wt, cleanup } = featureBatchBacklog();
      try {
        const r = runBl(mode === 'remove' ? ['gc'] : ['gc', mode], { cwd: dir });
        assert.equal(r.status, 0, r.stderr);
        const removed = ['F-7.S-5.scratch', 'B-3.r1.fix.scratch', 'S-6.S-6.scratch', 'F-7.test-1.log', 'B-3.test-1.log']
          .map((n) => join(run, n))
          .concat(['f7-feat', 'b3-batch', 's5-in-feature', 's6-in-batch'].map((d) => join(wt, d)));
        const kept = [join(run, 'F7.S-5.scratch'), join(run, 'f-7.S-5.scratch'), join(wt, 'F7-feat')];
        assert.deepEqual(
          lines(r.stdout),
          [...removed.map((p) => `${verb} ${p}`), ...kept.map((p) => `kept ${p} (names no work unit)`)].sort(),
        );
        for (const p of removed) assert.equal(existsSync(p), mode === '--dry-run', p);
        for (const p of [...kept, join(run, 'F-7.test-2.log'), join(run, 'B-3.test-2.log'), join(run, 'F-7.json')]) {
          assert.ok(existsSync(p), `${p} stays`);
        }
      } finally {
        cleanup();
      }
    });
  }
});

test('gc_rejects_or_honors_inline_dry_run_values: a valued boolean flag is refused and removes nothing', () => {
  const { dir, cleanup } = mkTempBacklog({
    config: { worktrees: './wt' },
    stories: [{ id: 'S-1', title: 'Done', dirSuffix: 'done', status: 'done' }],
  });
  try {
    const scratch = join(dir, '.bl', 'run', 'S-1.S-1.scratch');
    mkdirSync(scratch, { recursive: true });
    for (const flag of ['--dry-run=true', '--dry-run=false', '--dry-run=bad', '--dry-run=', '--help=false']) {
      const r = runBl(['gc', flag], { cwd: dir });
      assert.equal(r.status, 1, flag);
      assert.equal(r.stdout, '', flag);
      assert.match(r.stderr, /Usage: bl gc \[--dry-run\]/, flag);
      assert.ok(existsSync(scratch), `${flag} removed nothing`);
    }
  } finally {
    cleanup();
  }
});
