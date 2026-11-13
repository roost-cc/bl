import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { schedule, branchFiles, unitFiles } from '../../src/schedule.js';
import { planFiles } from '../../src/execution-plan.js';
import { reposForFeature } from '../../src/feature.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';
import { PATH_CASES, plan, withBacklog } from '../helpers/plan-fixture.js';
import { loadFlow } from '../../src/flow.js';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

const noFiles = () => new Set();

test('a dependency that is done does not hold back its dependent, even when it is a target', () => {
  withBacklog(({ config, all, units }) => {
    const { start, deferred } = schedule(units('S-5', 'S-8'), all, flow, { config, files: noFiles });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-5', 'S-8'],
    );
    assert.deepEqual(deferred, []);
  });
});

test('a target that depends on another target waits for it to merge', () => {
  withBacklog(({ config, all, units }) => {
    const { start, deferred } = schedule(units('S-2', 'S-1'), all, flow, { config, files: noFiles });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-1'],
    );
    assert.deepEqual(deferred, [
      { id: 'S-2', kind: 'story', reason: 'S-2 depends on S-1; run it after S-1 merges', blockers: ['S-1'] },
    ]);
  });
});

test('a dependency outside the targets blocks until it is done', () => {
  withBacklog(({ config, all, units }) => {
    const { start, deferred } = schedule(units('S-3', 'S-5'), all, flow, { config, files: noFiles });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-5'],
      "S-5's dependency S-8 is done",
    );
    assert.equal(deferred[0].reason, 'S-3 depends on S-9, which is draft; merge S-9 first');
    assert.deepEqual(deferred[0].blockers, ['S-9']);
  });
});

test("a feature's stories carry its dependencies, both ways", () => {
  withBacklog(({ config, all, units }) => {
    // F-2's S-12 depends on target S-1; S-4 depends on S-10, inside target F-1.
    // S-10 → S-11 stays inside F-1 and blocks nothing.
    const { start, deferred } = schedule(units('F-2', 'S-1', 'S-4', 'F-1'), all, flow, { config, files: noFiles });
    assert.deepEqual(start.map((u) => u.id).sort(), ['F-1', 'S-1']);
    assert.deepEqual(
      deferred.map((d) => d.reason),
      ['F-2: S-12 depends on S-1; run it after S-1 merges', 'S-4 depends on S-10 (in F-1); run it after F-1 merges'],
    );
  });
});

test('overlapping targets: the lowest id starts, the rest wait naming the shared files', () => {
  withBacklog(({ config, all, units }) => {
    const files = {
      'S-1': ['bl:src/x.js', 'bl:src/a.js'],
      'S-3': ['bl:src/other.js'],
      'S-5': ['bl:src/x.js', 'bl:src/z.js'],
      'F-1': ['bl:src/z.js'],
    };
    const outside = all.map((s) => (s.id === 'S-9' ? { ...s, status: 'done' } : s));
    const { start, deferred } = schedule(units('S-5', 'S-3', 'S-1', 'F-1'), outside, flow, {
      config,
      files: (u) => new Set(files[u.id]),
    });
    // F-1 sorts before S-1: a feature first at the same number.
    assert.deepEqual(
      start.map((u) => u.id),
      ['F-1', 'S-1', 'S-3'],
    );
    assert.deepEqual(deferred, [
      {
        id: 'S-5',
        kind: 'story',
        reason: 'S-5 overlaps F-1 on src/z.js and S-1 on src/x.js; run it after F-1 and S-1 merge',
        blockers: ['F-1', 'S-1'],
      },
    ]);
  });
});

test('a target overlapping only a waiting target starts', () => {
  withBacklog(({ config, all, units }) => {
    // S-2 waits on its dependency S-1; S-5 shares a file with S-2 only.
    const files = { 'S-1': ['bl:src/a.js'], 'S-2': ['bl:src/b.js'], 'S-5': ['bl:src/b.js'] };
    const { start, deferred } = schedule(units('S-2', 'S-1', 'S-5'), all, flow, {
      config,
      files: (u) => new Set(files[u.id]),
    });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-1', 'S-5'],
    );
    assert.deepEqual(
      deferred.map((d) => d.id),
      ['S-2'],
    );
  });
});

test('shared files in several repos keep their repo names', () => {
  withBacklog(({ config, all, units }) => {
    const files = { 'S-1': ['bl:a.js', 'tools:b.js'], 'S-5': ['bl:a.js', 'tools:b.js'] };
    const { deferred } = schedule(units('S-1', 'S-5'), all, flow, { config, files: (u) => new Set(files[u.id]) });
    assert.equal(deferred[0].reason, 'S-5 overlaps S-1 on bl:a.js, tools:b.js; run it after S-1 merges');
  });
});

test("unitFiles: with no branch commits, a feature's files are its stories' plan paths together", () => {
  withBacklog(({ config, all, units }) => {
    const [f1, s1] = units('F-1', 'S-1');
    assert.deepEqual([...unitFiles(f1, config, all)].sort(), ['bl:src/x.js', 'bl:src/y.js', 'bl:test/unit/x.test.js']);
    assert.deepEqual([...unitFiles(s1, config, all)], ['bl:src/a.js']);
  });
});

test("branchFiles lists what a worktree's branch changes against main", () => {
  const root = mkTempDir('bl-schedule-git-');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 's1-x', wt);
    assert.deepEqual(
      branchFiles([{ repoName: 'bl', worktreePath: wt }]),
      { files: new Set(), complete: true },
      'no commits yet',
    );
    mkdirSync(join(wt, 'src'));
    writeFileSync(join(wt, 'src', 'new.js'), 'x\n');
    git(wt, 'add', '.');
    git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add');
    assert.deepEqual(branchFiles([{ repoName: 'bl', worktreePath: wt }]), {
      files: new Set(['bl:src/new.js']),
      complete: true,
    });
    assert.deepEqual(
      branchFiles([
        { repoName: 'bl', worktreePath: wt },
        { repoName: 'gone', worktreePath: join(root, 'nope') },
      ]),
      { files: new Set(['bl:src/new.js']), complete: false },
      'a missing worktree makes the read partial',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unitFiles does not schedule from a partial multi-repository branch diff', () => {
  const root = mkTempDir('bl-schedule-partial-');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, msg) =>
    git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);
  // Repo `a` holds the branch's commit; the story's plan names `b:shared.js`.
  const states = {
    changed: (wt) => {
      git(wt, 'init', '-q', '-b', 'main');
      commit(wt, 'init');
      git(wt, 'checkout', '-q', '-b', 'f1-x');
      writeFileSync(join(wt, 'a.js'), 'x\n');
      git(wt, 'add', '.');
      commit(wt, 'work');
    },
    empty: (wt) => {
      git(wt, 'init', '-q', '-b', 'main');
      commit(wt, 'init');
      git(wt, 'checkout', '-q', '-b', 'f1-x');
    },
    missing: null,
    'diff fails': () => {},
  };
  const rows = [
    { a: 'changed', b: 'empty', complete: true, want: ['a:a.js'] },
    { a: 'empty', b: 'empty', complete: true, want: ['b:shared.js'] },
    { a: 'changed', b: 'missing', complete: false, want: ['a:a.js', 'b:shared.js'] },
    { a: 'changed', b: 'diff fails', complete: false, want: ['a:a.js', 'b:shared.js'] },
    { a: 'missing', b: 'diff fails', complete: false, want: ['b:shared.js'] },
  ];
  try {
    rows.forEach((row, i) => {
      const base = join(root, String(i));
      for (const name of ['a', 'b']) {
        if (states[row[name]] === null) continue;
        const wt = join(base, 'f1-x', name);
        mkdirSync(wt, { recursive: true });
        states[row[name]](wt);
      }
      const indexPath = join(base, 'S1.md');
      writeFileSync(indexPath, `---\nstory_id: S-1\n---\n${plan('1. `shared.js`')}`);
      const indexA = join(base, 'S0.md');
      writeFileSync(indexA, '---\nstory_id: S-0\n---\n');
      const config = { backlogRoot: base, raw: { worktrees: base }, reposByName: { a: 'a', b: 'b' } };
      // F-1 touches a and b because its stories' components are there (F-52 D3), not through a field on the feature.
      const all = [
        { id: 'S-0', feature: 'F-1', status: 'refined', unitRepo: 'a', indexPath: indexA },
        { id: 'S-1', feature: 'F-1', status: 'refined', unitRepo: 'b', indexPath },
      ];
      const record = { id: 'F-1', featureEntry: 'F1-x', stories: ['S-0', 'S-1'] };
      const f1 = { kind: 'feature', id: 'F-1', record };
      const label = `a ${row.a}, b ${row.b}`;
      assert.equal(branchFiles(reposForFeature(record, config, all)).complete, row.complete, label);
      assert.deepEqual([...unitFiles(f1, config, all)].sort(), row.want, label);
      if (row.complete) return;
      // A target planning b:shared.js waits for F-1 even though F-1's readable diff never names it.
      const s2 = { kind: 'story', id: 'S-2', record: { id: 'S-2', status: 'refined' } };
      const { start, deferred } = schedule([f1, s2], [...all, s2.record], flow, {
        config,
        files: (u) => (u === f1 ? unitFiles(f1, config, all) : new Set(['b:shared.js'])),
      });
      assert.deepEqual(
        start.map((u) => u.id),
        ['F-1'],
        label,
      );
      assert.deepEqual(
        deferred.map((d) => d.id),
        ['S-2'],
        label,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schedule defers the overlaps of valid repository paths with spaces and punctuation', () => {
  const root = mkTempDir('bl-schedule-paths-');
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    const make = (id, spans) => {
      const indexPath = join(root, `${id}.md`);
      writeFileSync(indexPath, `---\nstory_id: ${id}\n---\n\n${plan(...spans.map((s) => `- edit \`${s}\``))}`);
      return { id, indexPath, unitRepo: 'bl', status: 'refined' };
    };
    // Each kept path, named by two targets, defers the later one; the union
    // over a feature's stories (`unitStories` → `planFiles`) keeps it too.
    const kept = PATH_CASES.filter(([, want]) => want !== null);
    for (const [span, want, why] of kept) {
      const a = make('S-1', ['src/unrelated.js', span]);
      const b = make('S-2', [span.trim()]);
      const units = [a, b].map((record) => ({ kind: 'story', id: record.id, record }));
      const { start, deferred } = schedule(units, [a, b], flow, {
        config: { backlogRoot: root },
        files: (u) => planFiles([u.record]),
      });
      assert.deepEqual(
        start.map((u) => u.id),
        ['S-1'],
        why,
      );
      assert.equal(deferred[0]?.reason, `S-2 overlaps S-1 on ${want}; run it after S-1 merges`, why);
      assert.ok(planFiles([make('S-3', ['src/other.js']), a]).has(`bl:${want}`), `feature union: ${why}`);
    }

    // A directory in one plan overlaps a file under it in another.
    const dir = make('S-1', ['src/dir/']);
    const file = make('S-2', ['src/dir/inner.js']);
    const { deferred } = schedule(
      [dir, file].map((record) => ({ kind: 'story', id: record.id, record })),
      [dir, file],
      flow,
      { config: { backlogRoot: root }, files: (u) => planFiles([u.record]) },
    );
    assert.deepEqual(
      deferred.map((d) => d.id),
      ['S-2'],
      'directory holds the file',
    );

    // The kept file paths read the same as `git diff --name-only` prints them.
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'checkout', '-q', '-b', 's1');
    const files = kept.map(([, want]) => want).filter((p) => !p.startsWith('src/dir') && p !== 'lib');
    for (const p of files) {
      mkdirSync(join(repo, p, '..'), { recursive: true });
      writeFileSync(join(repo, p), 'x\n');
    }
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add');
    const fromPlan = planFiles([
      make(
        'S-1',
        kept.map(([span]) => span),
      ),
    ]);
    for (const key of branchFiles([{ repoName: 'bl', worktreePath: repo }]).files) {
      assert.ok(fromPlan.has(key), `git's ${key} is a plan path`);
    }
    assert.equal(branchFiles([{ repoName: 'bl', worktreePath: repo }]).files.size, new Set(files).size);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
