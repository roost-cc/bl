/**
 * `bl init` commits and pushes the backlog files it wrote, with
 * "chore: bl init" (S-1330). Edits made before it stay out, a second run
 * commits nothing, and a backlog that is not a git repo gets no commit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AGENT_CONFIG, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { lockOwnerVisible, runBl, startBlBehindLock } from '../helpers/run-bl.js';
import { LOCK_FILE } from '../../src/lock.js';
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

test('init_retries_failed_commit_without_losing_written_paths: a rerun commits what the failed run wrote', () => {
  const dir = newBacklog();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  addOrigin(dir);
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const first = init(dir);
  assert.equal(first.status, 1, first.stderr);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'base');
  rmSync(hook);

  const retry = init(dir);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: bl init');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').length, 8);
  assert.equal(git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));
});

// Each step of `bl init` after its first write, made to fail once: the
// rerun commits what the failed run wrote with its own writes. A link to
// nothing makes a seed's write fail (`writeSeed`); a home that is a file
// makes the agent's setup fail.
const INIT_FILES = [
  '.gitignore',
  'allowed-tools.json',
  'backlog.json',
  'coding-dictionary.yaml',
  'flow.json',
  'index.md',
  'priority.md',
  'roadmap.md',
];
const brokenSeed = (file) => [
  (dir) => symlinkSync(join(dir, 'nowhere'), join(dir, file)),
  (dir) => rmSync(join(dir, file)),
];
for (const [label, [breakIt, repair], home] of [
  ['provider.init', [() => {}, () => {}], 'file'],
  [
    'ensureGitignored',
    [(dir) => mkdirSync(join(dir, '.gitignore')), (dir) => rmSync(join(dir, '.gitignore'), { recursive: true })],
  ],
  ['copySeed (allowed-tools.json)', brokenSeed('allowed-tools.json')],
  ['ensureFlowFile', brokenSeed('flow.json')],
  ['ensureBacklogDocs', brokenSeed('roadmap.md')],
  ['ensureRootIndex', brokenSeed('index.md')],
]) {
  test(`init_retry_commits_files_written_before_setup_failure: ${label} fails`, () => {
    const dir = newBacklog();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    addOrigin(dir);
    const homeDir = mkTempDir('bl-init-home-');
    const badHome = join(homeDir, 'a-file');
    writeFileSync(badHome, 'not a directory\n');
    breakIt(dir);
    // The claude provider writes its settings under CLAUDE_CONFIG_DIR, else HOME.
    const env = home === 'file' ? { HOME: badHome, CLAUDE_CONFIG_DIR: badHome } : { HOME: homeDir };
    const first = runBl(['init'], { cwd: dir, env: { ...GIT_ENV, ...env } });
    assert.notEqual(first.status, 0, first.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'base');
    repair(dir);

    const retry = init(dir);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(statusLines(dir), []);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: bl init');
    assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), INIT_FILES);
    assert.equal(git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));
  });
}

test('init_write_and_commit_share_lock: bl init writes nothing until it holds the backlog lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  // No origin: the pull before the command would wait for the lock first.
  const dir = newBacklog();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const json = readFileSync(join(dir, 'backlog.json'), 'utf8');
  writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n${new Date().toISOString()}\n`);
  const run = startBlBehindLock(['init'], { cwd: dir, env: { ...GIT_ENV, HOME: mkTempDir('bl-init-home-') } });
  await run.blocked;
  assert.equal(readFileSync(join(dir, 'backlog.json'), 'utf8'), json, 'nothing written before the lock');
  assert.equal(existsSync(join(dir, '.gitignore')), false);
  rmSync(join(dir, LOCK_FILE));
  const r = await run.closed;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: bl init');
});

test('init_inside_parent_git_checkout_skips_commit: a backlog with no repo of its own, inside a parent checkout', () => {
  const parent = mkTempDir('bl-init-parent-');
  const dir = join(parent, 'backlog');
  mkdirSync(dir);
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ backlog: 'backlog' }) + '\n');
  git(parent, 'init', '-q', '-b', 'main');
  git(parent, 'add', '.');
  git(parent, 'commit', '-q', '-m', 'base');
  // The parent's origin is ahead: init must not pull the parent either.
  addOrigin(parent);
  const other = mkTempDir('bl-init-parent-other-');
  git(other, 'clone', '-q', git(parent, 'remote', 'get-url', 'origin'), '.');
  writeFileSync(join(other, 'theirs.md'), 'theirs\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'the other clone');
  git(other, 'push', '-q', 'origin', 'main');
  const head = git(parent, 'rev-parse', 'HEAD');

  const r = runBl(['init'], { cwd: dir, env: { ...GIT_ENV, BL_BACKLOG_DIR: dir, HOME: mkTempDir('bl-init-home-') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(parent, 'rev-parse', 'HEAD'), head, 'no commit in the parent, and no pull of it');
  assert.doesNotMatch(r.stderr, /Committing backlog changes|Left your uncommitted|backlog commit failed/);
});

// Every path that pulls or commits a backlog with no repo of its own: the
// pull before a command (`pullBeforeCommand`, which refine's pull is too),
// `syncAndCommit` (approve) and `commitChangedSince` (init). The parent's
// origin is ahead, so a pull of the parent would move its HEAD.
const FEATURE_BACKLOG = {
  components: [{ id: 'C01', title: 'Core', dirSuffix: 'core' }],
  stories: [{ id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'refined', feature: 'F-1' }],
  features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: ['S-1'] }],
};
for (const [label, seed, args] of [
  [
    'bl init, a backlog.json that loadConfig rejects',
    (dir) => writeFileSync(join(dir, 'backlog.json'), '{}\n'),
    ['init'],
  ],
  ['bl init, a valid backlog.json', copyFixture({}), ['init']],
  ['bl approve', copyFixture(FEATURE_BACKLOG), ['approve', 'F-1']],
  ['bl sync, the pull every committing command runs first', copyFixture({}), ['sync']],
]) {
  test(`init_and_approve_inside_parent_checkout_leave_parent_head_unchanged: ${label}`, () => {
    const parent = mkTempDir('bl-nested-parent-');
    const dir = join(parent, 'backlog');
    mkdirSync(dir);
    seed(dir);
    git(parent, 'init', '-q', '-b', 'main');
    git(parent, 'add', '.');
    git(parent, 'commit', '-q', '-m', 'base');
    addOrigin(parent);
    const other = mkTempDir('bl-nested-other-');
    git(other, 'clone', '-q', git(parent, 'remote', 'get-url', 'origin'), '.');
    writeFileSync(join(other, 'theirs.md'), 'theirs\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'the other clone');
    git(other, 'push', '-q', 'origin', 'main');
    const head = git(parent, 'rev-parse', 'HEAD');

    const r = runBl(args, { cwd: dir, env: { ...GIT_ENV, HOME: mkTempDir('bl-nested-home-') } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(parent, 'rev-parse', 'HEAD'), head, 'no commit in the parent, and no pull of it');
    assert.doesNotMatch(r.stderr, /Committing backlog changes|Committed \d|backlog commit failed/);
  });
}

/** A seed that copies a `mkTempBacklog(spec)` backlog into the directory. */
function copyFixture(spec) {
  return (dir) => {
    const fixture = mkTempBacklog(spec);
    try {
      cpSync(fixture.dir, dir, { recursive: true });
    } finally {
      fixture.cleanup();
    }
  };
}
