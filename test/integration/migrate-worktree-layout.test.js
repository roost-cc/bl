import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { loadConfig } from '../../src/config.js';
import { JOURNAL, migrate, rewritePaths, rootOfTemplate, setWorktrees } from '../../src/migrate-worktree-layout.js';
import { _hooks } from '../../src/atomic-write.js';
import { GIT_ENV, addOrigin, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

// F-60 D4: the whole migration on a workspace directory with a backlog at
// origin/main, two repos and real old-layout worktrees.

Object.assign(process.env, GIT_ENV);

const BRANCH = 'f7-two-repos';
const DETACHED = 'upd-beta-1';
const quiet = () => {};

/**
 * A roost dir: a git backlog at origin/main whose `worktrees` is the old
 * template, repos `alpha` and `beta`, and old-layout worktrees: `alpha` and
 * `beta` on `BRANCH`, a detached `beta` worktree `DETACHED`, a stray
 * directory under `worktrees/alpha/` and a run state naming two of them.
 */
function roost({ template = '../worktrees/{repo}' } = {}) {
  const root = mkTempDir('bl-migrate-worktrees-');
  const { dir: made } = mkTempBacklog({ repos: { alpha: '../alpha', beta: '../beta' } });
  const dir = join(root, 'backlog');
  renameSync(made, dir);
  initGitBacklog(dir);
  writeFileSync(join(dir, '.gitignore'), `${readFileSync(join(dir, '.gitignore'), 'utf8')}.bl/\n`);
  const json = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
  if (template === undefined) delete json.worktrees;
  else json.worktrees = template;
  writeFileSync(join(dir, 'backlog.json'), `${JSON.stringify(json, null, 2)}\n`);
  git(dir, 'commit', '-q', '-am', 'old worktrees template');
  addOrigin(dir);

  const wt = join(root, 'worktrees');
  for (const repo of ['alpha', 'beta']) {
    const path = join(root, repo);
    mkdirSync(path);
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(path, 'worktree', 'add', '-q', '-b', BRANCH, join(wt, repo, BRANCH));
  }
  git(join(root, 'beta'), 'worktree', 'add', '-q', '--detach', join(wt, 'beta', DETACHED));
  mkdirSync(join(wt, 'alpha', 'stray'));
  writeFileSync(join(wt, 'alpha', 'stray', 'note.txt'), 'not a worktree\n');

  const runDir = join(dir, '.bl', 'run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'F-7.json'),
    JSON.stringify({
      status: 'done',
      worktreePath: join(wt, 'alpha', BRANCH),
      repos: [{ repoName: 'beta', worktreePath: join(wt, 'beta', BRANCH) }],
      findings: [{ file: join(wt, 'alpha', BRANCH, 'src', 'x.js') }],
      other: join(wt, 'alpha', `${BRANCH}-not-it`),
    }),
  );
  return { root, dir, wt };
}

/** The linked worktree paths `git worktree list` gives for `repo`. */
function worktreePaths(repo) {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .slice(1)
    .map((l) => l.slice('worktree '.length))
    .sort();
}

const load = (dir) => loadConfig({ backlogRoot: dir, legacyWorktrees: true });

test('rootOfTemplate cuts the trailing /{repo}, defaults an unset value and refuses {repo} elsewhere', () => {
  assert.deepEqual(rootOfTemplate('../worktrees/{repo}'), { template: '../worktrees/{repo}', root: '../worktrees' });
  assert.deepEqual(rootOfTemplate(undefined), { template: '../worktrees/{repo}', root: '../worktrees' });
  assert.deepEqual(rootOfTemplate('../worktrees'), { template: null, root: '../worktrees' });
  assert.throws(() => rootOfTemplate('../wt/{repo}-trees'), /"\{repo\}" is not its last segment/);
});

test('setWorktrees replaces the one value in place, or adds the key', () => {
  const text = '{\n  "backlog": "backlog",\n  "worktrees": "../worktrees/{repo}",\n  "repos": {}\n}\n';
  assert.equal(setWorktrees(text, '../worktrees'), text.replace('../worktrees/{repo}', '../worktrees'));
  assert.equal(setWorktrees('{"a": 1}', '../worktrees'), '{\n  "a": 1,\n  "worktrees": "../worktrees"\n}\n');
});

test('migrate --dry-run prints the moves and writes nothing', async () => {
  const { root, dir, wt } = roost();
  const head = git(dir, 'rev-parse', 'HEAD');
  const runState = readFileSync(join(dir, '.bl', 'run', 'F-7.json'), 'utf8');
  const lines = [];
  const { commit } = await migrate(load(dir), { dryRun: true, log: (l) => lines.push(l) });
  assert.equal(commit, null);
  assert.deepEqual(lines, [
    `would move    ${join(wt, 'alpha', BRANCH)} -> ${join(wt, BRANCH, 'alpha')}`,
    `would move    ${join(wt, 'beta', BRANCH)} -> ${join(wt, BRANCH, 'beta')}`,
    `would move    ${join(wt, 'beta', DETACHED)} -> ${join(wt, DETACHED, 'beta')} (detached)`,
    'would rewrite .bl/run/F-7.json (3 paths)',
    `would remove  ${join(wt, 'beta')}`,
    `leave   ${join(wt, 'alpha', 'stray')} (not a registered worktree)`,
    'would set     backlog.json worktrees: "../worktrees/{repo}" -> "../worktrees"',
    'worktrees moved: 3; run states rewritten: 1; directories left: 1',
  ]);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(readFileSync(join(dir, '.bl', 'run', 'F-7.json'), 'utf8'), runState);
  assert.ok(existsSync(join(wt, 'alpha', BRANCH)));
  assert.ok(!existsSync(join(wt, BRANCH)));
  assert.deepEqual(worktreePaths(join(root, 'alpha')), [join(wt, 'alpha', BRANCH)]);
});

test('migrate moves every worktree, rewrites backlog.json and the run state, commits once, and a rerun plans nothing', async () => {
  const { root, dir, wt } = roost();
  const head = git(dir, 'rev-parse', 'HEAD');
  const { commit } = await migrate(load(dir), { log: quiet });
  assert.equal(commit.committed, true, commit.error);

  assert.deepEqual(worktreePaths(join(root, 'alpha')), [join(wt, BRANCH, 'alpha')]);
  assert.deepEqual(worktreePaths(join(root, 'beta')), [join(wt, DETACHED, 'beta'), join(wt, BRANCH, 'beta')].sort());
  assert.equal(git(join(wt, BRANCH, 'beta'), 'branch', '--show-current'), BRANCH);
  assert.ok(!existsSync(join(wt, 'beta')), 'the emptied worktrees/beta is removed');
  assert.ok(existsSync(join(wt, 'alpha', 'stray', 'note.txt')), 'the stray directory stays');
  assert.ok(!existsSync(join(wt, 'alpha', BRANCH)));

  assert.equal(JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).worktrees, '../worktrees');
  const state = JSON.parse(readFileSync(join(dir, '.bl', 'run', 'F-7.json'), 'utf8'));
  assert.equal(state.worktreePath, join(wt, BRANCH, 'alpha'));
  assert.equal(state.repos[0].worktreePath, join(wt, BRANCH, 'beta'));
  assert.equal(state.findings[0].file, join(wt, BRANCH, 'alpha', 'src', 'x.js'));
  assert.equal(state.other, join(wt, 'alpha', `${BRANCH}-not-it`), 'a path that only shares a prefix is left');

  assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: migrate worktrees to the feature-first layout (F-60)');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['backlog.json']);
  assert.deepEqual(statusLines(dir), []);

  // The new bl loads it, and a rerun (pushed, so the backlog is at origin/main) plans nothing.
  git(dir, 'push', '-q', 'origin', 'main');
  const lines = [];
  const again = await migrate(loadConfig({ backlogRoot: dir }), { log: (l) => lines.push(l) });
  assert.equal(again.commit, null);
  assert.deepEqual(again.plan.moves, []);
  assert.equal(again.plan.backlogJson, null);
  assert.deepEqual(lines, [
    `leave   ${join(wt, 'alpha', 'stray')} (not a registered worktree)`,
    'worktrees moved: 0; run states rewritten: 0; directories left: 1',
  ]);
});

test('migrate treats an unset worktrees as the old ../worktrees/{repo}', async () => {
  const { dir, wt } = roost({ template: undefined });
  const { plan, commit } = await migrate(load(dir), { log: quiet });
  assert.equal(commit.committed, true, commit.error);
  assert.equal(plan.moves.length, 3);
  assert.ok(existsSync(join(wt, BRANCH, 'alpha')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).worktrees, '../worktrees');
});

/** Assert `migrate` refuses with `re`, and nothing moved or changed. */
async function assertRefused(fixture, re) {
  const { root, dir, wt } = fixture;
  const head = git(dir, 'rev-parse', 'HEAD');
  const template = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).worktrees;
  await assert.rejects(migrate(load(dir), { log: quiet }), re);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).worktrees, template);
  assert.deepEqual(worktreePaths(join(root, 'alpha')), [join(wt, 'alpha', BRANCH)]);
  assert.ok(!existsSync(join(wt, BRANCH, 'alpha')));
  assert.ok(existsSync(join(wt, 'beta', BRANCH)));
}

test('migrate refuses before anything moves when a worktree has a live .workon.lock', async () => {
  const fixture = roost();
  writeFileSync(join(fixture.wt, 'beta', BRANCH, '.workon.lock'), `${process.pid}\n`);
  await assertRefused(fixture, /migration refused: a bl session holds .*beta.*\.workon\.lock/);
});

test('migrate refuses before anything moves when a target path exists', async () => {
  const fixture = roost();
  mkdirSync(join(fixture.wt, BRANCH, 'beta'), { recursive: true });
  await assertRefused(fixture, /migration refused: .*already exists/);
});

// Every way a target can be blocked is found by the plan, before the first
// worktree moves, not as an EEXIST part-way.
test('all collisions must refuse before moving the first worktree', async () => {
  const cases = [
    {
      label: "a file where a target's parent would be made",
      setup: ({ wt }) => writeFileSync(join(wt, BRANCH), 'in the way\n'),
      re: new RegExp(`${join('worktrees', BRANCH)} is not a directory`),
    },
    {
      label: "a link where a target's parent would be made",
      setup: ({ root, wt }) => {
        mkdirSync(join(root, 'away'));
        symlinkSync(join(root, 'away'), join(wt, BRANCH));
      },
      re: new RegExp(`${join('worktrees', BRANCH)} is not a directory`),
    },
    {
      label: 'a dangling link at a target',
      setup: ({ root, wt }) => {
        mkdirSync(join(wt, BRANCH));
        symlinkSync(join(root, 'nowhere'), join(wt, BRANCH, 'beta'));
      },
      re: /already exists/,
    },
    {
      label: 'two detached worktrees with one directory name',
      setup: ({ root, wt }) =>
        git(join(root, 'beta'), 'worktree', 'add', '-q', '--detach', join(wt, 'beta', 'nested', DETACHED)),
      re: new RegExp(`would both move to .*${join(DETACHED, 'beta')}`),
    },
    {
      label: 'a target inside another target (nested branch names)',
      setup: ({ root, wt }) =>
        git(join(root, 'beta'), 'worktree', 'add', '-q', '-b', `${DETACHED}/beta`, join(wt, 'beta', 'nested-branch')),
      re: new RegExp(`${join(DETACHED, 'beta', 'beta')} lies inside .*${join(DETACHED, 'beta')}, where`),
    },
    {
      label: 'a target inside a worktree to move',
      setup: ({ root, wt }) =>
        git(join(root, 'beta'), 'worktree', 'add', '-q', '-b', `alpha/${BRANCH}`, join(wt, 'beta', 'inside-source')),
      re: new RegExp(`${join('alpha', BRANCH, 'beta')} lies inside the worktree .*${join('alpha', BRANCH)},`),
    },
    {
      label: 'a target inside a worktree to move, the root named through a link',
      template: '../wt-alias/{repo}',
      setup: ({ root, wt }) => {
        symlinkSync(wt, join(root, 'wt-alias'));
        git(join(root, 'beta'), 'worktree', 'add', '-q', '-b', `alpha/${BRANCH}`, join(wt, 'beta', 'inside-source'));
      },
      re: new RegExp(
        `${join('wt-alias', 'alpha', BRANCH, 'beta')} lies inside the worktree .*${join('alpha', BRANCH)},`,
      ),
    },
  ];
  for (const c of cases) {
    const fixture = roost(c.template ? { template: c.template } : {});
    c.setup(fixture);
    await assertRefused(fixture, c.re);
  }
});

// A failure at any point after the first move, then a rerun: every run
// state names where its worktrees are, whichever writes the failure cut off.
test('migrated run-state path must still resolve after migration/retry', async () => {
  const failOnRename = (name) => (tmp) => {
    if (basename(tmp).startsWith(`${name}.`)) throw new Error(`injected ${name} write failure`);
  };
  const cases = [
    { label: 'the run-state write after the first move', hook: failOnRename('F-7.json') },
    { label: 'between two run states', hook: failOnRename('F-8.json') },
    { label: 'the backlog.json write', hook: failOnRename('backlog.json') },
    { label: 'the commit', commit: async () => Promise.reject(new Error('injected commit failure')) },
  ];
  for (const c of cases) {
    const { dir, wt } = roost();
    const runDir = join(dir, '.bl', 'run');
    writeFileSync(join(runDir, 'F-8.json'), JSON.stringify({ status: 'done', worktreePath: join(wt, 'beta', BRANCH) }));
    _hooks.beforeRename = c.hook ?? null;
    try {
      await assert.rejects(
        migrate(load(dir), { log: quiet, ...(c.commit ? { commit: c.commit } : {}) }),
        /injected/,
        c.label,
      );
    } finally {
      _hooks.beforeRename = null;
    }
    const { commit } = await migrate(load(dir), { log: quiet });
    assert.equal(commit?.committed, true, `${c.label}: ${commit?.error}`);
    const f7 = JSON.parse(readFileSync(join(runDir, 'F-7.json'), 'utf8'));
    const f8 = JSON.parse(readFileSync(join(runDir, 'F-8.json'), 'utf8'));
    assert.equal(f7.worktreePath, join(wt, BRANCH, 'alpha'), c.label);
    assert.equal(f7.repos[0].worktreePath, join(wt, BRANCH, 'beta'), c.label);
    assert.equal(f8.worktreePath, join(wt, BRANCH, 'beta'), c.label);
    for (const p of [f7.worktreePath, f7.repos[0].worktreePath, f8.worktreePath])
      assert.ok(existsSync(p), `${c.label}: ${p}`);
    assert.ok(!existsSync(join(dir, '.bl', JOURNAL)), `${c.label}: the journal goes with the commit`);
    git(dir, 'push', '-q', 'origin', 'main');
    assert.deepEqual((await migrate(loadConfig({ backlogRoot: dir }), { log: quiet })).plan.runStates, [], c.label);
  }
});

// A saved path names a worktree through a link (an aliased workspace directory),
// or the root itself is reached through one: the saved paths follow the
// move all the same, exact and inside, and a path that only shares a prefix
// is left.
test('migrated run-state path must still resolve after migration: saved through a symlink alias', async () => {
  for (const viaRoot of [false, true]) {
    const label = viaRoot
      ? 'backlog.json names the root through a link'
      : 'run state names the worktree through a link';
    const { root, dir, wt } = roost(viaRoot ? { template: '../wt-alias/{repo}' } : {});
    symlinkSync(root, join(root, 'alias'));
    symlinkSync(wt, join(root, 'wt-alias'));
    const aliased = join(root, 'alias', 'worktrees');
    writeFileSync(
      join(dir, '.bl', 'run', 'F-8.json'),
      JSON.stringify({
        worktreePath: join(aliased, 'alpha', BRANCH),
        file: join(aliased, 'beta', BRANCH, 'src', 'y.js'),
        other: join(aliased, 'alpha', `${BRANCH}-not-it`),
      }),
    );
    const { commit } = await migrate(load(dir), { log: quiet });
    assert.equal(commit.committed, true, `${label}: ${commit.error}`);
    const state = JSON.parse(readFileSync(join(dir, '.bl', 'run', 'F-8.json'), 'utf8'));
    const newRoot = viaRoot ? join(root, 'wt-alias') : wt;
    assert.equal(state.worktreePath, join(newRoot, BRANCH, 'alpha'), label);
    assert.equal(state.file, join(newRoot, BRANCH, 'beta', 'src', 'y.js'), label);
    assert.equal(state.other, join(aliased, 'alpha', `${BRANCH}-not-it`), `${label}: a prefix-only match is left`);
    assert.ok(existsSync(state.worktreePath), label);
    const f7 = JSON.parse(readFileSync(join(dir, '.bl', 'run', 'F-7.json'), 'utf8'));
    assert.equal(f7.worktreePath, join(newRoot, BRANCH, 'alpha'), label);
  }
});

// Inside means by path segment: a first segment that only begins with two
// dots is a descendant, the parent segment `..` is not.
test('containment accepts dot-prefixed descendants and rejects parent traversal', async () => {
  const from = '/r/old';
  const to = '/r/new';
  for (const [saved, want] of [
    ['/r/old', '/r/new'],
    ['/r/old/ordinary', '/r/new/ordinary'],
    ['/r/old/..cache', '/r/new/..cache'],
    ['/r/old/..cache/file', '/r/new/..cache/file'],
    ['/r/old/nested/..cache/file', '/r/new/nested/..cache/file'],
    ['/r/old/...', '/r/new/...'],
    ['/r/old/../sibling', '/r/old/../sibling'],
    ['/r/sibling', '/r/sibling'],
    ['/r/old-not-it', '/r/old-not-it'],
    ['/r', '/r'],
  ]) {
    assert.equal(rewritePaths({ p: saved }, from, to).value.p, want, saved);
  }

  // The same through a whole migration, for a directory and a file.
  const { dir, wt } = roost();
  const old = join(wt, 'alpha', BRANCH);
  mkdirSync(join(old, '..cache'));
  writeFileSync(join(old, '..cache', 'file'), '');
  writeFileSync(
    join(dir, '.bl', 'run', 'F-8.json'),
    JSON.stringify({ dir: join(old, '..cache'), file: join(old, '..cache', 'file') }),
  );
  const { commit } = await migrate(load(dir), { log: quiet });
  assert.equal(commit.committed, true, commit.error);
  const state = JSON.parse(readFileSync(join(dir, '.bl', 'run', 'F-8.json'), 'utf8'));
  assert.equal(state.dir, join(wt, BRANCH, 'alpha', '..cache'));
  assert.equal(state.file, join(wt, BRANCH, 'alpha', '..cache', 'file'));
  assert.ok(existsSync(state.file));
});

// Paths saved through links that lead into a worktree to move, or through a
// link inside it that leads out: each still resolves after the migration,
// and after a rerun when the first run failed once the moves had begun (the
// links into the worktree dangle by then).
test('migrated paths through worktree and descendant symlinks survive moves and retries', async () => {
  /** Fail the `nth` write of `name`. */
  const failOnRename = (name, nth) => {
    let n = 0;
    return (tmp) => {
      if (basename(tmp).startsWith(`${name}.`) && ++n === nth) throw new Error(`injected ${name} write failure`);
    };
  };
  for (const c of [
    { label: 'one run' },
    { label: 'the pinning write before the first move fails', hook: failOnRename('F-9.json', 1) },
    { label: 'the run-state write after the first move fails', hook: failOnRename('F-9.json', 2) },
    { label: 'the backlog.json write fails', hook: failOnRename('backlog.json', 1) },
  ]) {
    const { root, dir, wt } = roost();
    const old = join(wt, 'alpha', BRANCH);
    const now = join(wt, BRANCH, 'alpha');
    mkdirSync(join(old, 'src'));
    writeFileSync(join(old, 'src', 'file.js'), '');
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'x'), '');
    symlinkSync(old, join(root, 'alias'));
    symlinkSync(join(root, 'alias'), join(root, 'alias2'));
    symlinkSync(join(old, 'src'), join(root, 'src-alias'));
    symlinkSync(join(old, 'src', 'file.js'), join(root, 'file-alias'));
    symlinkSync(root, join(root, 'ancestor-alias'));
    symlinkSync(join(root, 'elsewhere'), join(old, 'out-link'));
    const saved = {
      worktree: [join(root, 'alias'), now],
      descendant: [join(root, 'alias', 'src', 'file.js'), join(now, 'src', 'file.js')],
      dirAlias: [join(root, 'src-alias', 'file.js'), join(now, 'src', 'file.js')],
      fileAlias: [join(root, 'file-alias'), join(now, 'src', 'file.js')],
      chained: [join(root, 'alias2', 'src'), join(now, 'src')],
      ancestor: [join(root, 'ancestor-alias', 'worktrees', 'alpha', BRANCH), now],
      outward: [join(old, 'out-link', 'x'), join(root, 'elsewhere', 'x')],
      unrelated: [join(root, 'elsewhere'), join(root, 'elsewhere')],
    };
    const runState = join(dir, '.bl', 'run', 'F-9.json');
    writeFileSync(runState, JSON.stringify(Object.fromEntries(Object.entries(saved).map(([k, [v]]) => [k, v]))));
    if (c.hook) {
      _hooks.beforeRename = c.hook;
      try {
        await assert.rejects(migrate(load(dir), { log: quiet }), /injected/, c.label);
      } finally {
        _hooks.beforeRename = null;
      }
    }
    const { plan, commit } = await migrate(load(dir), { log: quiet });
    assert.equal(commit.committed, true, `${c.label}: ${commit.error}`);
    if (!c.hook) assert.deepEqual(plan.runStates.find((s) => s.path === runState)?.rewrites, 7, c.label);
    const state = JSON.parse(readFileSync(runState, 'utf8'));
    for (const [k, [, want]] of Object.entries(saved)) {
      assert.equal(state[k], want, `${c.label}: ${k}`);
      assert.ok(existsSync(state[k]), `${c.label}: ${k} resolves`);
    }
  }
});

// A git worktree inside one to move, of the same repo on a branch or
// detached, or of another registered repo, would be carried along with its
// registration left at the old path: refused before anything moves.
test('nested registered worktree sources are refused before moves or migrated with valid registrations', async () => {
  for (const c of [
    { label: 'same repo, a branch', repo: 'alpha', add: ['-b', 'f2-inner'] },
    { label: 'same repo, detached', repo: 'alpha', add: ['--detach'] },
    { label: 'another registered repo', repo: 'beta', add: ['-b', 'f2-inner'] },
  ]) {
    const { root, dir, wt } = roost();
    const outer = join(wt, 'alpha', BRANCH);
    const inner = join(outer, 'nested');
    git(join(root, c.repo), 'worktree', 'add', '-q', ...c.add, inner);
    const head = git(dir, 'rev-parse', 'HEAD');
    const before = { alpha: worktreePaths(join(root, 'alpha')), beta: worktreePaths(join(root, 'beta')) };
    await assert.rejects(
      migrate(load(dir), { log: quiet }),
      new RegExp(`the git worktree ${inner} lies inside ${outer}, and would lose its registration`),
      c.label,
    );
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, c.label);
    assert.deepEqual(
      { alpha: worktreePaths(join(root, 'alpha')), beta: worktreePaths(join(root, 'beta')) },
      before,
      c.label,
    );
    assert.ok(!existsSync(join(wt, BRANCH)), `${c.label}: nothing moved`);
    assert.ok(!existsSync(join(dir, '.bl', JOURNAL)), c.label);
  }
});

// A journal entry the rerun can neither count as done nor plan again is
// refused, not dropped from the journal it rewrites.
test('migrate refuses a journal entry that is neither done nor still planned', async () => {
  for (const entry of [
    { label: 'neither end there', from: 'gone', to: 'nowhere' },
    { label: 'the source there, but not planned to that target', from: join('alpha', BRANCH), to: 'elsewhere' },
  ]) {
    const fixture = roost();
    const move = { from: join(fixture.wt, entry.from), to: join(fixture.wt, entry.to) };
    writeFileSync(join(fixture.dir, '.bl', JOURNAL), JSON.stringify({ moves: [move] }));
    await assertRefused(
      fixture,
      new RegExp(`records the move ${move.from} -> ${move.to}, which is neither done nor still planned`),
    );
  }
  // A journaled move still to make, as a failure before it leaves it, is planned again.
  const { dir, wt } = roost();
  const move = { from: join(wt, 'alpha', BRANCH), to: join(wt, BRANCH, 'alpha') };
  writeFileSync(join(dir, '.bl', JOURNAL), JSON.stringify({ moves: [move] }));
  const { commit } = await migrate(load(dir), { log: quiet });
  assert.equal(commit.committed, true, commit.error);
});

test('migrate refuses before anything moves when a run state or the journal cannot be read', async () => {
  for (const [file, re] of [
    [join('run', 'F-8.json'), /run state .*F-8\.json cannot be read/],
    [JOURNAL, /migrate-worktree-layout\.json cannot be read/],
  ]) {
    const fixture = roost();
    writeFileSync(join(fixture.dir, '.bl', file), '{broken json');
    await assertRefused(fixture, re);
  }
});

test('migrate refuses before anything moves when a bl run is active', async () => {
  const fixture = roost();
  const runDir = join(fixture.dir, '.bl', 'run');
  writeFileSync(join(runDir, 'F-9.json'), JSON.stringify({ status: 'running' }));
  writeFileSync(join(runDir, 'F-9.lock'), `${process.ppid}\n`);
  await assertRefused(fixture, /migration refused: a bl run is active/);
});
