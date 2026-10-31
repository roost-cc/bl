/**
 * status-list.test.js — bare `bl status`: the open stories by status, in the
 * table `bl list` prints (S-1161).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
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

test('a status outside the three stays listed, after backlog', () => {
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
