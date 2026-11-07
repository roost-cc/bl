/**
 * `bl init` commits and pushes the backlog files it wrote, with
 * "chore: bl init" (S-1330). Edits made before it stay out, a second run
 * commits nothing, and a backlog that is not a git repo gets no commit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
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
