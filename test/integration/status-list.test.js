/**
 * status-list.test.js — bare `bl status`: the open stories by status, in the
 * table `bl list` prints (S-1161).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { FLOW_TEMPLATE, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

const STORIES = [
  { id: 'S-20', status: 'backlog' },
  { id: 'S-10', status: 'refined' },
  { id: 'S-9', status: 'refined' },
  { id: 'S-8', status: 'done', completed: '2026-01-01' },
  { id: 'S-7', status: 'superseded' },
  { id: 'S-6', status: 'in_progress' },
  { id: 'S-5', status: 'refined' },
  { id: 'S-4', status: 'backlog' },
  { id: 'S-3', status: 'in_progress' },
  { id: 'S-2', status: 'refined' },
].map((s) => ({ ...s, component: 'C00', title: `Story ${s.id}` }));

/** The fixture's `## Backlog` table: `ranked` first, in that order. */
function writeRanks(dir, ranked) {
  const rows = ranked.map((id) => `| ${id} | x |`).join('\n');
  writeFileSync(join(dir, 'index.md'), `# Backlog\n\n## Backlog\n\n| ID | Title |\n| -- | ----- |\n${rows}\n`);
}

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
}

function fixture(extra = {}) {
  const { dir } = mkTempBacklog({ components: [{ id: 'C00', title: 'Work' }], stories: STORIES, ...extra });
  writeRanks(dir, ['S-4', 'S-20', 'S-5', 'S-2', 'S-6', 'S-3']);
  return dir;
}

/** A registered git repo with a linked worktree on a branch of story S-5. */
function fixtureWithWorktree() {
  const repo = mkTempDir('bl-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 's5-work', join(mkTempDir('bl-wt-'), 'wt'));
  return fixture({ repos: { app: repo } });
}

/** The table's body rows as `[id, status]`, past the Theme and Component columns. */
function rows(stdout) {
  return stdout
    .split('\n')
    .filter((l) => /\sC00\s/.test(l))
    .map((l) => l.trim().split(/\s{2,}/))
    .map((cells) => [cells[2], cells[5]]);
}

const ids = (stdout) => rows(stdout).map(([id]) => id);

test('bl status: in_progress, refined, backlog; rank then numeric id; closed stories absent', () => {
  const dir = fixture();
  const r = runBl(['status'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(ids(r.stdout), ['S-6', 'S-3', 'S-5', 'S-2', 'S-9', 'S-10', 'S-4', 'S-20']);
});

test('bl status: a refined story with a worktree stays in its group; bl list still puts it first', () => {
  const dir = fixtureWithWorktree();
  const status = runBl(['status'], { cwd: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(rows(status.stdout), [
    ['S-6', 'in_progress'],
    ['S-3', 'in_progress'],
    ['S-5', 'refined*'],
    ['S-2', 'refined'],
    ['S-9', 'refined'],
    ['S-10', 'refined'],
    ['S-4', 'backlog'],
    ['S-20', 'backlog'],
  ]);
  const list = runBl(['list'], { cwd: dir });
  assert.equal(ids(list.stdout)[0], 'S-5');
});

test('bl status prints what bl list prints, reordered; bl list keeps its order', () => {
  const dir = fixture();
  const status = runBl(['status'], { cwd: dir }).stdout.split('\n');
  const list = runBl(['list'], { cwd: dir }).stdout.split('\n');
  assert.deepEqual(status.slice(0, 2), list.slice(0, 2));
  assert.deepEqual(status.slice(-3), list.slice(-3));
  assert.match(status.at(-2), /^8 stories \(0 active, 8 backlog\)$/);
  assert.deepEqual([...status].sort(), [...list].sort());
  assert.deepEqual(ids(list.join('\n')), ['S-6', 'S-3', 'S-4', 'S-20', 'S-5', 'S-2', 'S-9', 'S-10']);
});

test('a flag with no id is a usage error that lists nothing; bl run with no id too', () => {
  const dir = fixture();
  for (const argv of [['-a'], ['--component', 'C00'], ['--bogus']]) {
    const r = runBl(['status', ...argv], { cwd: dir });
    assert.equal(r.status, 1, argv.join(' '));
    assert.equal(r.stdout, '', argv.join(' '));
    assert.match(r.stderr, /Usage: bl status \[<id\.\.\.>\]/, argv.join(' '));
  }
  const run = runBl(['run'], { cwd: dir });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Usage: bl run <id\.\.\.>/);
});

test('bl status <id> still reports the one target', () => {
  const dir = fixture();
  const r = runBl(['status', 'S-5'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('S-20'), r.stdout);
  assert.ok(r.stdout.includes('S-5'), r.stdout);
});

test('an empty backlog says so on stderr, as bl list does', () => {
  const { dir } = mkTempBacklog();
  const r = runBl(['status'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^No stories found\.$/m);
});

test('a backlog of only closed stories says so on stderr', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C00', title: 'Work' }],
    stories: STORIES.filter((s) => s.status === 'done' || s.status === 'superseded'),
  });
  const r = runBl(['status'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^No stories found\.$/m);
});

/** The shipped flow with `in_review` after `in_progress`, written last in the file. */
function flowWithInReview() {
  const flow = JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
  const { statuses } = flow.types.story;
  statuses.in_review = { implies: ['in_progress', 'refined', 'backlog'] };
  statuses.done.implies.unshift('in_review');
  statuses.superseded.implies.unshift('in_review');
  return flow;
}

test('a status added to flow.json sorts by what it implies, with no code change', () => {
  const { dir } = mkTempBacklog({
    flow: flowWithInReview(),
    components: [{ id: 'C00', title: 'Work' }],
    stories: [
      { id: 'S-1', status: 'backlog', component: 'C00', title: 'Plain' },
      { id: 'S-2', status: 'in_progress', component: 'C00', title: 'Active' },
      { id: 'S-3', status: 'in_review', component: 'C00', title: 'Reviewing' },
      { id: 'S-4', status: 'refined', component: 'C00', title: 'Ready' },
      { id: 'S-5', status: 'blocked', component: 'C00', title: 'Odd' },
    ],
  });
  const r = runBl(['status'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(ids(r.stdout), ['S-3', 'S-2', 'S-4', 'S-1', 'S-5']);
});

test('a closed status added to flow.json is not listed', () => {
  const flow = JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
  flow.types.story.statuses.wontfix = { implies: ['done', 'in_progress', 'refined', 'backlog'] };
  const { dir } = mkTempBacklog({
    flow,
    components: [{ id: 'C00', title: 'Work' }],
    stories: [
      { id: 'S-1', status: 'backlog', component: 'C00', title: 'Plain' },
      { id: 'S-2', status: 'wontfix', component: 'C00', title: 'Dropped' },
    ],
  });
  const r = runBl(['status'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r.stdout), ['S-1']);
  // `bl list` keeps its own constants, not flow.json.
  assert.deepEqual(ids(runBl(['list'], { cwd: dir }).stdout), ['S-1', 'S-2']);
});

test('a flow.json bl cannot read stops bare bl status naming the file', () => {
  const dir = fixture();
  rmSync(join(dir, 'flow.json'));
  const missing = runBl(['status'], { cwd: dir });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /flow\.json: missing/);

  writeFileSync(join(dir, 'flow.json'), '{');
  const broken = runBl(['status'], { cwd: dir });
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  assert.match(broken.stderr, /flow\.json: not valid JSON/);

  // `bl list` does not read it; bare `bl status` stops even with no stories.
  assert.equal(runBl(['list'], { cwd: dir }).status, 0);
  const { dir: empty } = mkTempBacklog({ flow: null });
  const none = runBl(['status'], { cwd: empty });
  assert.equal(none.status, 1);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /flow\.json: missing/);
});

test('a status outside flow.json stays listed, after backlog', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C00', title: 'Work' }],
    stories: [
      { id: 'S-1', status: 'blocked', component: 'C00', title: 'Odd' },
      { id: 'S-2', status: 'backlog', component: 'C00', title: 'Plain' },
      { id: 'S-3', status: 'refined', component: 'C00', title: 'Ready' },
    ],
  });
  const r = runBl(['status'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r.stdout), ['S-3', 'S-2', 'S-1']);
});

test('bl status sorts every unknown status after backlog including prototype keys', () => {
  const unknown = ['blocked', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 7, true, ['refined'], ['superseded'], ['done']];
  for (const status of unknown) {
    const { dir } = mkTempBacklog({
      components: [{ id: 'C00', title: 'Work' }],
      stories: [
        { id: 'S-1', status: 'backlog', component: 'C00', title: 'Plain' },
        { id: 'S-2', status, component: 'C00', title: 'Odd' },
        { id: 'S-3', status: 'refined', component: 'C00', title: 'Ready' },
        { id: 'S-4', status: 'in_progress', component: 'C00', title: 'Active' },
        { id: 'S-5', status: 'done', component: 'C00', title: 'Closed', completed: '2026-01-01' },
      ],
    });
    const r = runBl(['status'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ids(r.stdout), ['S-4', 'S-3', 'S-1', 'S-2'], JSON.stringify(status));

    // `bl list` keeps ranking an unknown status with backlog and refined.
    const list = runBl(['list', '-a'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(ids(list.stdout), ['S-4', 'S-1', 'S-2', 'S-3', 'S-5'], JSON.stringify(status));
  }
});

test('bl status keeps ranks 10000 and later ahead of unranked stories', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C00', title: 'Work' }],
    stories: ['S-10', 'S-9', 'S-3', 'S-2', 'S-1'].map((id) => ({
      id,
      status: 'refined',
      component: 'C00',
      title: `Story ${id}`,
    })),
  });
  // S-3 lands on rank 9999, S-2 on 10000, S-1 on 10001; S-9 and S-10 have none.
  const filler = Array.from({ length: 9999 }, (_, i) => `S-${100 + i}`);
  writeRanks(dir, [...filler, 'S-3', 'S-2', 'S-1']);
  for (const verb of ['status', 'list']) {
    const r = runBl([verb], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ids(r.stdout), ['S-3', 'S-2', 'S-1', 'S-9', 'S-10'], verb);
  }
});

test('bl list rejects malformed pattern even when no stories are available', () => {
  const closed = STORIES.filter((s) => s.status === 'done' || s.status === 'superseded');
  const stories = { empty: [], closed, open: STORIES };
  for (const [name, list] of Object.entries(stories)) {
    const { dir } = mkTempBacklog({ components: [{ id: 'C00', title: 'Work' }], stories: list });
    const r = runBl(['list', '['], { cwd: dir });
    assert.notEqual(r.status, 0, name);
    assert.equal(r.stdout, '', name);
    assert.match(r.stderr, /Invalid regular expression/, name);
    assert.doesNotMatch(r.stderr, /No stories found/, name);
  }
  // A filter that leaves no stories, and a valid pattern matching no row.
  const { dir } = mkTempBacklog({
    components: [
      { id: 'C00', title: 'Work' },
      { id: 'C01', title: 'Idle' },
    ],
    stories: STORIES,
  });
  const filtered = runBl(['list', '[', '--component', 'C01'], { cwd: dir });
  assert.notEqual(filtered.status, 0);
  assert.match(filtered.stderr, /Invalid regular expression/);
  const nomatch = runBl(['list', 'no-such-row'], { cwd: dir });
  assert.equal(nomatch.status, 0, nomatch.stderr);
  assert.match(nomatch.stderr, /No matching stories\./);
});

test('the Feature column comes along when a listed story has a feature', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C00', title: 'Work' }],
    features: [{ id: 'F-1', title: 'A feature', status: 'draft' }],
    stories: [
      { id: 'S-1', status: 'backlog', component: 'C00', title: 'Plain' },
      { id: 'S-2', status: 'refined', component: 'C00', title: 'Member', feature: 'F-1' },
    ],
  });
  const status = runBl(['status'], { cwd: dir });
  const list = runBl(['list'], { cwd: dir });
  assert.equal(status.status, 0, status.stderr);
  const lines = status.stdout.split('\n');
  assert.match(lines[0], /\bFeature\b/);
  assert.match(lines[2], /S-2\s+F-1\b/);
  assert.deepEqual([...lines].sort(), list.stdout.split('\n').sort());
});

test('bl status --help shows the bare form', () => {
  const { dir } = mkTempBacklog();
  const r = runBl(['status', '--help'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: bl status \[<id\.\.\.>\]$/m);
  assert.match(r.stdout, /With no id it lists the open stories/);
});
