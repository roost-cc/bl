/**
 * Integration tests for `bl block add|remove|list` (F-66 D4) against a git
 * backlog: the sorted line it writes and commits alone, its refusals, the
 * operator's remove, `list --fix`, and two clones whose adds merge.
 */
import { spawnSync } from 'child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { BLOCKERS_FILE, formatBlockers, readBlockers, writeBlockers } from '../../src/blockers.js';

const bl = (args, cwd) => runBl(args, { cwd, env: GIT_ENV });

/**
 * F-1 (S-11, S-14) and F-2 (S-12, S-13), each approved, standalone S-1 and S-2,
 * and a done S-9. `deps` maps a story to the one it depends on.
 */
function backlog({ deps = {}, features = [] } = {}) {
  const story = (id, extra = {}) => ({
    id,
    component: 'C01',
    title: id,
    depends_on: deps[id] ?? undefined,
    ...extra,
  });
  return mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      story('S-11', { feature: 'F-1' }),
      story('S-14', { feature: 'F-1' }),
      story('S-12', { feature: 'F-2' }),
      story('S-13', { feature: 'F-2' }),
      story('S-1'),
      story('S-2'),
      story('S-9', { status: 'done' }),
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', stories: ['S-11', 'S-14'] },
      { id: 'F-2', title: 'Two', status: 'approved', stories: ['S-12', 'S-13'] },
      ...features,
    ],
  });
}

test('bl block add writes one sorted line, commits blockers.json alone, and list shows it unmet', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  writeBlockers(dir, [{ blocker: 'S-2', gate: 'merge', unit: 'S-1', until: 'done' }]);
  git(dir, 'add', BLOCKERS_FILE);
  git(dir, 'commit', '-q', '-m', 'seed');

  const r = bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-1', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'blocked: F-1 at merge by S-1 until done\n');
  assert.equal(
    readFileSync(join(dir, BLOCKERS_FILE), 'utf8'),
    `{
  "schema": "bl-blockers/v1",
  "edges": [
    {"blocker":"S-1","gate":"merge","unit":"F-1","until":"done"},
    {"blocker":"S-2","gate":"merge","unit":"S-1","until":"done"}
  ]
}
`,
  );
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: block F-1 at merge on S-1');
  // The first commit also maps the file to its merge driver.
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), `.gitattributes\n${BLOCKERS_FILE}`);
  assert.equal(readFileSync(join(dir, '.gitattributes'), 'utf8'), '/blockers.json merge=bl-blockers\n');

  const list = bl(['block', 'list', 'F-1'], dir);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, 'F-1 held at merge by S-1 (backlog, needs done): unmet\n');
  // On a story of F-1 too, and by the blocker.
  assert.equal(bl(['block', 'list', 'S-1'], dir).stdout.split('\n').filter(Boolean).length, 2);
  assert.equal(bl(['block', 'list'], dir).stdout.split('\n').filter(Boolean).length, 2);
});

test('bl block add with --active-when files an inactive edge; a met blocker lists met', () => {
  const { dir } = backlog();
  let r = bl(
    [
      'block',
      'add',
      'S-2',
      '--gate',
      'run',
      '--unit',
      '*',
      '--until',
      'done',
      '--active-when',
      'F-2',
      '--active-status',
      'done',
    ],
    dir,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not a git repository|skipping commit/i);
  r = bl(['block', 'add', 'S-9', '--gate', 'run', '--unit', 'S-1', '--until', 'done'], dir);
  assert.equal(r.status, 0, r.stderr);
  const list = bl(['block', 'list', 'S-1'], dir);
  assert.equal(
    list.stdout,
    '* held at run by S-2 (backlog, needs done): inactive, active when F-2 is done (approved)\n' +
      'S-1 held at run by S-9 (done, needs done): met\n',
  );
  assert.equal(
    bl(['block', 'add', 'S-2', '--gate', 'run', '--unit', '*', '--until', 'done', '--active-when', 'F-2'], dir).status,
    1,
  );
});

test('bl block add refuses an unknown id, gate or status, an unmeetable until, and a duplicate', () => {
  const { dir } = backlog();
  const add = (...args) => bl(['block', 'add', ...args], dir);
  const cases = [
    [
      ['S-99', '--gate', 'run', '--unit', 'F-1', '--until', 'done'],
      /blocker S-99 is not a unit in the backlog \(blockers-unit\)/,
    ],
    [['S-1', '--gate', 'run', '--unit', 'F-99', '--until', 'done'], /unit F-99 is not a unit in the backlog/],
    [['*', '--gate', 'run', '--unit', 'F-1', '--until', 'done'], /the blocker is never "\*"/],
    [
      ['S-1', '--gate', 'deploy', '--unit', 'F-1', '--until', 'done'],
      /a feature has no gate "deploy" in flow\.json \(blockers-gate\)/,
    ],
    [
      ['S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'shipped'],
      /until "shipped" is not a story status in flow\.json \(blockers-status\)/,
    ],
    [
      ['S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done', '--active-when', 'F-1', '--active-status', 'merged'],
      /active_when status "merged" is not a feature status/,
    ],
    [
      ['S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done', '--active-when', 'T-1', '--active-status', 'done'],
      /active_when unit T-1 is not a unit in the backlog/,
    ],
    // S-9 is done, so closed, and done does not meet superseded: the edge would hold forever.
    [
      ['S-9', '--gate', 'run', '--unit', 'F-1', '--until', 'superseded'],
      /S-9 is done, closed, and never meets "superseded" \(blockers-unmeetable\)/,
    ],
  ];
  for (const [args, message] of cases) {
    const r = add(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
  assert.equal(readBlockers(dir).text, null, 'nothing written');

  assert.equal(add('S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done').status, 0);
  const dup = add('S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'in_progress');
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /F-1 at run by S-1 is already an edge/);
  assert.equal(readBlockers(dir).edges.length, 1);
});

test('bl block add refuses a cycle with a cross-feature depends_on, and a wildcard on its own blocker', () => {
  // S-11 (F-1) depends on S-12 (F-2): F-1 waits on F-2.
  const { dir } = backlog({ deps: { 'S-11': 'S-12' } });
  let r = bl(['block', 'add', 'S-11', '--gate', 'run', '--unit', 'S-13', '--until', 'done'], dir);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /S-13 at run by S-11 would close a deadlock: F-2 → F-1 \(S-13 at run by S-11\) → F-2 \(S-11 depends_on S-12\)/,
  );
  r = bl(['block', 'add', 'S-1', '--gate', 'run', '--unit', '*', '--until', 'done'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /would close a deadlock: S-1 → S-1 \(\* at run by S-1\)/);
  // Two edges that hold each other.
  assert.equal(bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'S-2', '--until', 'done'], dir).status, 0);
  r = bl(['block', 'add', 'S-2', '--gate', 'run', '--unit', 'S-1', '--until', 'done'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /S-1 → S-2 \(S-1 at run by S-2\) → S-1 \(S-2 at merge by S-1\)/);
  assert.equal(readBlockers(dir).edges.length, 1);
});

test('bl validate reports a deadlock of cross-feature depends_on alone', () => {
  const { dir } = backlog({ deps: { 'S-11': 'S-12', 'S-13': 'S-14' } });
  const r = bl(['validate', '--json'], dir);
  const cycle = JSON.parse(r.stdout).findings.filter((f) => f.code === 'blockers-cycle');
  assert.deepEqual(
    cycle.map((f) => f.message),
    ['deadlock: F-1 → F-2 (S-11 depends_on S-12) → F-1 (S-13 depends_on S-14)'],
  );
  assert.equal(cycle[0].severity, 'error');
});

test('bl block remove drops one edge by its identity and commits; an unknown edge refuses', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  assert.equal(bl(['block', 'add', 'S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done'], dir).status, 0);
  assert.equal(bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-1', '--until', 'done'], dir).status, 0);

  let r = bl(['block', 'remove', 'S-1', '--gate', 'run', '--unit', 'F-2'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no edge F-2 at run by S-1/);

  r = bl(['block', 'remove', 'S-1', '--gate', 'run', '--unit', 'F-1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'unblocked: F-1 at run by S-1\n');
  assert.deepEqual(readBlockers(dir).edges, [{ blocker: 'S-1', gate: 'merge', unit: 'F-1', until: 'done' }]);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: unblock F-1 at run on S-1');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), BLOCKERS_FILE);
});

test('bl block list --fix rewrites a hand-edited file sorted and commits it; validate warns until then', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  const edges = [
    { blocker: 'S-2', gate: 'run', unit: 'S-1', until: 'done' },
    { blocker: 'S-1', gate: 'run', unit: 'F-1', until: 'done' },
  ];
  writeFileSync(join(dir, BLOCKERS_FILE), JSON.stringify({ schema: 'bl-blockers/v1', edges }, null, 2));
  git(dir, 'add', BLOCKERS_FILE);
  git(dir, 'commit', '-q', '-m', 'hand edit');
  const before = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) =>
    f.code.startsWith('blockers-'),
  );
  assert.deepEqual(
    before.map((f) => [f.code, f.severity]),
    [['blockers-order', 'warning']],
  );

  const r = bl(['block', 'list', '--fix'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, BLOCKERS_FILE), 'utf8'), formatBlockers(edges));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), `chore: sort ${BLOCKERS_FILE}`);
  const after = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) =>
    f.code.startsWith('blockers-'),
  );
  assert.deepEqual(after, []);
  assert.match(bl(['block', 'list', '--fix'], dir).stderr, /already sorted/);
});

test('bl block list stops on a missing flow.json, naming the file', () => {
  const { dir } = mkTempBacklog({ flow: null });
  const r = bl(['block', 'list'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /flow\.json: missing/);
});

test("bl block add and remove on two clones merge without a conflict wherever the edges land, by git merge and by bl's pull", () => {
  const on = (unit) => ({ blocker: 'S-1', gate: 'merge', unit, until: 'done' });
  const add = (unit) => ['block', 'add', 'S-1', '--gate', 'merge', '--unit', unit, '--until', 'done'];
  const remove = (unit) => ['block', 'remove', 'S-1', '--gate', 'merge', '--unit', unit];
  // Each: the seeded edges, Alice's and Bob's commands, and the edges after.
  const cases = [
    { name: 'empty graph', seed: [], alice: add('F-2'), bob: add('F-4'), want: ['F-2', 'F-4'] },
    { name: 'both before the first', seed: ['F-5'], alice: add('F-2'), bob: add('F-4'), want: ['F-2', 'F-4', 'F-5'] },
    { name: 'both after the last', seed: ['F-1'], alice: add('F-2'), bob: add('F-4'), want: ['F-1', 'F-2', 'F-4'] },
    {
      name: 'one interior gap',
      seed: ['F-1', 'F-5'],
      alice: add('F-2'),
      bob: add('F-4'),
      want: ['F-1', 'F-2', 'F-4', 'F-5'],
    },
    {
      name: 'gaps apart',
      seed: ['F-1', 'F-3', 'F-5'],
      alice: add('F-2'),
      bob: add('F-4'),
      want: ['F-1', 'F-2', 'F-3', 'F-4', 'F-5'],
    },
    { name: 'remove beside an add', seed: ['F-1', 'F-3'], alice: remove('F-3'), bob: add('F-4'), want: ['F-1', 'F-4'] },
    { name: 'both remove one edge', seed: ['F-1', 'F-3'], alice: remove('F-3'), bob: remove('F-3'), want: ['F-1'] },
    {
      name: 'two removes side by side',
      seed: ['F-1', 'F-3', 'F-5'],
      alice: remove('F-3'),
      bob: remove('F-5'),
      want: ['F-1'],
    },
  ];
  for (const how of ['git merge', 'bl pull']) {
    for (const c of cases) {
      const at = `${c.name}, ${how}`;
      const { dir: alice } = backlog({
        features: ['F-3', 'F-4', 'F-5'].map((id) => ({ id, title: id, status: 'approved' })),
      });
      const tmp = mkTempDir('bl-block-clones-');
      try {
        initGitBacklog(alice);
        writeBlockers(alice, c.seed.map(on));
        git(alice, 'add', BLOCKERS_FILE);
        git(alice, 'commit', '-q', '-m', 'seed edges');
        const origin = join(tmp, 'origin.git');
        const bob = join(tmp, 'bob');
        git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
        git(alice, 'remote', 'add', 'origin', origin);
        git(alice, 'push', '-q', 'origin', 'main');
        git(tmp, 'clone', '-q', origin, bob);
        // Alice's push goes nowhere, so her commit stays local while Bob's lands.
        git(alice, 'remote', 'set-url', '--push', 'origin', join(tmp, 'nowhere.git'));

        const a = bl(c.alice, alice);
        assert.equal(a.status, 0, `${at}: ${a.stderr}`);
        const b = bl(c.bob, bob);
        assert.equal(b.status, 0, `${at}: ${b.stderr}`);
        assert.equal(git(origin, 'rev-parse', 'main'), git(bob, 'rev-parse', 'HEAD'));

        let want = c.want;
        if (how === 'git merge') {
          git(alice, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
        } else {
          // bl pulls (a rebase of Alice's commit onto Bob's) before it adds.
          const bobs = git(bob, 'rev-parse', 'HEAD');
          const pulled = bl(add('S-2'), alice);
          assert.equal(pulled.status, 0, `${at}: ${pulled.stderr}`);
          // The pull rebased onto Bob's commit, not a warning and a local add.
          assert.doesNotMatch(pulled.stderr, /backlog pull|backlog fetch/, `${at}: ${pulled.stderr}`);
          const rebased = spawnSync('git', ['merge-base', '--is-ancestor', bobs, 'HEAD'], { cwd: alice });
          assert.equal(rebased.status, 0, `${at}: Alice's HEAD has Bob's commit: ${pulled.stderr}`);
          want = [...want, 'S-2'];
        }
        for (const clone of [alice, bob]) {
          assert.match(
            git(clone, 'show', 'HEAD:.gitattributes'),
            /^\/blockers\.json merge=bl-blockers$/m,
            `${at}: ${clone}`,
          );
        }
        const text = readFileSync(join(alice, BLOCKERS_FILE), 'utf8');
        assert.doesNotMatch(text, /<<<<<<<|>>>>>>>/, at);
        const { edges } = readBlockers(alice);
        assert.deepEqual(
          edges.map((e) => e.unit),
          want,
          at,
        );
        assert.equal(text, formatBlockers(edges), `${at}: still sorted, one edge per line`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
});

test('block_setup_failure_preserves_retriable_graph_and_attributes: add, remove and list --fix change nothing when .gitattributes cannot be read or written', () => {
  const seeded = { blocker: 'S-1', gate: 'merge', unit: 'F-1', until: 'done' };
  const ops = {
    add: ['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-2', '--until', 'done'],
    remove: ['block', 'remove', 'S-1', '--gate', 'merge', '--unit', 'F-1'],
    fix: ['block', 'list', '--fix'],
  };
  const failures = {
    // A directory where the file goes: reading it fails.
    read: {
      make: (dir) => mkdirSync(join(dir, '.gitattributes')),
      undo: (dir) => rmSync(join(dir, '.gitattributes'), { recursive: true }),
      env: {},
    },
    // The first atomic write in the command, the attributes', fails.
    write: { make: () => {}, undo: () => {}, env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '1' } },
  };
  for (const [op, args] of Object.entries(ops)) {
    for (const [how, f] of Object.entries(failures)) {
      const at = `${op}, ${how}`;
      const { dir } = backlog();
      initGitBacklog(dir);
      // list --fix needs a hand-edited file to rewrite.
      const seed =
        op === 'fix' ? JSON.stringify({ schema: 'bl-blockers/v1', edges: [seeded] }) : formatBlockers([seeded]);
      writeFileSync(join(dir, BLOCKERS_FILE), seed);
      git(dir, 'add', BLOCKERS_FILE);
      git(dir, 'commit', '-q', '-m', 'seed');
      f.make(dir);

      const failed = runBl(args, { cwd: dir, env: { ...GIT_ENV, ...f.env } });
      assert.notEqual(failed.status, 0, `${at}: fails`);
      assert.equal(readFileSync(join(dir, BLOCKERS_FILE), 'utf8'), seed, `${at}: the graph is as it was`);
      assert.equal(git(dir, 'status', '--porcelain', '--', BLOCKERS_FILE), '', `${at}: nothing to commit`);

      f.undo(dir);
      const retry = bl(args, dir);
      assert.equal(retry.status, 0, `${at}: the retry goes through: ${retry.stderr}`);
      assert.equal(
        git(dir, 'status', '--porcelain', '--', BLOCKERS_FILE, '.gitattributes'),
        '',
        `${at}: all committed`,
      );
      assert.match(git(dir, 'show', 'HEAD:.gitattributes'), /^\/blockers\.json merge=bl-blockers$/m, at);
    }
  }
});

test('block_commit_retry_includes_uncommitted_driver_mapping: after a failed first commit the next one carries .gitattributes', () => {
  const { dir } = backlog();
  initGitBacklog(dir);
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const first = bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-1', '--until', 'done'], dir);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /Commit these backlog paths by hand:\n  blockers\.json\n  \.gitattributes/);
  rmSync(hook);

  const second = bl(['block', 'add', 'S-1', '--gate', 'merge', '--unit', 'F-2', '--until', 'done'], dir);
  assert.equal(second.status, 0, second.stderr);
  assert.match(git(dir, 'show', 'HEAD:.gitattributes'), /^\/blockers\.json merge=bl-blockers$/m);
  assert.equal(git(dir, 'status', '--porcelain', '--', BLOCKERS_FILE, '.gitattributes'), '');
  assert.deepEqual(
    readBlockers(dir).edges.map((e) => e.unit),
    ['F-1', 'F-2'],
  );
});
