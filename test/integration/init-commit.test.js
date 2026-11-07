/**
 * `bl init` commits and pushes the backlog files it wrote, with
 * "chore: bl init" (S-1330). Edits made before it stay out, a second run
 * commits nothing, and a backlog that is not a git repo gets no commit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AGENT_CONFIG, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, addOrigin, git, statusLines } from '../helpers/git-backlog.js';

/** A new backlog: a backlog.json with no "repos" yet. */
function newBacklog() {
  const dir = mkTempDir('bl-init-commit-');
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ backlog: 'backlog' }) + '\n');
  return dir;
}

/** `bl init` with its own home, so the agent's global settings stay the test's. */
function init(dir) {
  return runBl(['init'], { cwd: dir, env: { ...GIT_ENV, HOME: mkTempDir('bl-init-home-') } });
}

test('bl init commits and pushes the files it wrote with "chore: bl init"; an edit made before it stays out', () => {
  const dir = newBacklog();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  addOrigin(dir);
  writeFileSync(join(dir, 'notes.md'), 'the operator, before bl init\n');

  const r = init(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: bl init');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    '.gitignore',
    'allowed-tools.json',
    'backlog.json',
    'coding-dictionary.yaml',
    'flow.json',
    'index.md',
    'priority.md',
    'roadmap.md',
  ]);
  assert.deepEqual(statusLines(dir), ['?? notes.md']);
  assert.match(r.stderr, /Left your uncommitted backlog edits alone: notes\.md/);
  assert.equal(git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));

  // A second run writes nothing, so it commits nothing.
  const head = git(dir, 'rev-parse', 'HEAD');
  const again = init(dir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.doesNotMatch(again.stderr, /Committing backlog changes/);
});

test("bl init ignores bl's runtime directory .bl/, so a session's activity log is never committed", () => {
  const dir = newBacklog();
  git(dir, 'init', '-q', '-b', 'main');
  assert.equal(init(dir).status, 0);
  assert.equal(git(dir, 'check-ignore', '.bl/activity.log'), '.bl/activity.log');
  // A rerun adds nothing twice.
  const text = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.equal(init(dir).status, 0);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), text);
});

test('bl init in a backlog that is not a git repo commits nothing and says nothing about it', () => {
  const dir = newBacklog();
  const r = init(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Committing backlog changes|Left your uncommitted|backlog commit failed|git repo/);
});

// Each backlog.json `loadConfig` rejects and `bl init` repairs: init pulls
// origin's newer commit before it writes, so its own commit goes on top.
for (const [label, json] of [
  ['no "repos"', { backlog: 'backlog' }],
  ['"repos" and no effort levels', { ...AGENT_CONFIG, effort: undefined, worktrees: '../worktrees', repos: {} }],
]) {
  test(`init_pulls_before_repairing_incomplete_config: ${label}`, () => {
    const dir = mkTempDir('bl-init-stale-');
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(json, null, 2) + '\n');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    addOrigin(dir);
    const origin = git(dir, 'remote', 'get-url', 'origin');
    const other = mkTempDir('bl-init-other-');
    git(other, 'clone', '-q', origin, '.');
    // The same file init repairs: without the pull first, init's commit and
    // this one conflict, and init's stays unpushed.
    writeFileSync(join(other, 'backlog.json'), JSON.stringify({ ...json, title: 'Theirs' }, null, 2) + '\n');
    git(other, 'commit', '-q', '-am', 'the other clone');
    git(other, 'push', '-q', 'origin', 'main');

    const r = init(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(statusLines(dir), []);
    assert.deepEqual(git(dir, 'log', '--format=%s', '-3').split('\n'), ['chore: bl init', 'the other clone', 'base']);
    assert.equal(git(origin, 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'), 'origin has the commit');
    const repaired = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
    assert.equal(repaired.title, 'Theirs');
    assert.ok(repaired.repos && repaired.effort, 'init repaired the pulled file');
  });
}

test('init_inside_parent_git_checkout_skips_commit: a backlog with no repo of its own, inside a parent checkout', () => {
  const parent = mkTempDir('bl-init-parent-');
  const dir = join(parent, 'backlog');
  mkdirSync(dir);
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ backlog: 'backlog' }) + '\n');
  git(parent, 'init', '-q', '-b', 'main');
  git(parent, 'add', '.');
  git(parent, 'commit', '-q', '-m', 'base');
  const head = git(parent, 'rev-parse', 'HEAD');

  const r = runBl(['init'], { cwd: dir, env: { ...GIT_ENV, BL_BACKLOG_DIR: dir, HOME: mkTempDir('bl-init-home-') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(parent, 'rev-parse', 'HEAD'), head);
  assert.doesNotMatch(r.stderr, /Committing backlog changes|Left your uncommitted|backlog commit failed/);
});
