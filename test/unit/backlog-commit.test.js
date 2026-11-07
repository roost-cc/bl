import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  parsePorcelainZ,
  dirtySnapshot,
  pathsChangedSince,
  commitPaths,
  commandPullsBacklog,
  isGeneratedPath,
  isNonFastForwardRejection,
  pullBacklog,
  reportBacklogPull,
  leaveRegenerationPending,
  markRegenerationPending,
  PULL_REGEN_PENDING,
} from '../../src/backlog-commit.js';
import { mkTempDir, mkTempBacklog } from '../helpers/tempdir.js';
import { initGitBacklog } from '../helpers/git-backlog.js';
import { REPO_ROOT, runBl } from '../helpers/run-bl.js';
import { pullBeforeCommand } from '../../src/sync.js';
import { loadConfig } from '../../src/config.js';
import {
  allowlistInput,
  configHash,
  ensureAllowedTools,
  GENERATOR_VERSION,
  regenReason,
} from '../../src/allowed-tools.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('parsePorcelainZ returns both sides of a rename and plain paths with spaces', () => {
  const out = ' M a b.md\0R  new.md\0old.md\0?? dir/x.md\0';
  assert.deepEqual(parsePorcelainZ(out), ['a b.md', 'new.md', 'old.md', 'dir/x.md']);
  assert.deepEqual(parsePorcelainZ(''), []);
});

test('commits only what changed after the snapshot; pre-existing edits and staged work stay out', () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'stories'));
    for (const f of ['stories/a.md', 'stories/b.md', 'stories/c.md', 'index.md']) writeFileSync(join(dir, f), `${f}\n`);
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');

    // The operator's own state before the command runs.
    writeFileSync(join(dir, 'stories/b.md'), 'operator edit\n');
    writeFileSync(join(dir, 'notes.md'), 'operator scratch\n');
    writeFileSync(join(dir, 'stories/c.md'), 'operator staged\n');
    g(dir, 'add', 'stories/c.md');
    const before = dirtySnapshot(dir);

    // What the command does: edit, rewrite an index, move a file, add one.
    writeFileSync(join(dir, 'stories/a.md'), 'done\n');
    writeFileSync(join(dir, 'index.md'), 'regenerated\n');
    mkdirSync(join(dir, 'stories/.completed'));
    renameSync(join(dir, 'stories/a.md'), join(dir, 'stories/.completed/a.md'));
    writeFileSync(join(dir, 'feature.md'), 'new\n');
    const touched = pathsChangedSince(before, dirtySnapshot(dir));
    assert.deepEqual(touched, ['feature.md', 'index.md', 'stories/.completed/a.md', 'stories/a.md']);

    const res = commitPaths(dir, touched, 'chore: test');
    assert.equal(res.committed, true, res.error);
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
    assert.deepEqual(files, ['feature.md', 'index.md', 'stories/.completed/a.md', 'stories/a.md']);
    // The operator's edit, scratch file, and staged change are untouched.
    // Untrimmed: the leading space of " M" is significant.
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout;
    assert.match(status, /^ M stories\/b\.md$/m);
    assert.match(status, /^\?\? notes\.md$/m);
    assert.match(status, /^M  stories\/c\.md$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file the operator had dirty is included only when the command changed it again', () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x.md'), 'x\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'x.md'), 'operator\n');
    const before = dirtySnapshot(dir);
    assert.deepEqual(pathsChangedSince(before, dirtySnapshot(dir)), []);
    writeFileSync(join(dir, 'x.md'), 'operator + command\n');
    assert.deepEqual(pathsChangedSince(before, dirtySnapshot(dir)), ['x.md']);
    assert.equal(dirtySnapshot(join(dir, 'nope')), null);
    assert.deepEqual(commitPaths(dir, [], 'noop'), { committed: false, paths: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// S-837: a `git mv` source is gone from the work tree and the index, so it is
// not addable; the commit must still record the deletion, and when no path is
// addable the operator's dirty files must not be swept into the index.
test("commitPaths commits a git rm'd path without staging the rest of the tree", () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'stories'));
    writeFileSync(join(dir, 'stories/a.md'), 'a\n');
    writeFileSync(join(dir, 'bystander.md'), 'b\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');

    writeFileSync(join(dir, 'bystander.md'), 'operator edit\n');
    g(dir, 'rm', '-q', 'stories/a.md');

    const res = commitPaths(dir, ['stories/a.md'], 'chore: drop a');
    assert.equal(res.committed, true, res.error);
    const files = g(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n');
    assert.deepEqual(files, ['D\tstories/a.md']);
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout;
    assert.equal(status, ' M bystander.md\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitPaths reports a commit that fails without output as an error', () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.md'), 'a\n');
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const res = commitPaths(dir, ['a.md'], 'chore: a');
    assert.equal(res.committed, false);
    assert.match(res.error, /git commit exited 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared through the remote (F-50 D4): push after commit, pull with rebase
// ---------------------------------------------------------------------------

/**
 * A bare remote and two clones of it, Alice's and Bob's, each with its own
 * identity, seeded with `files` on `main`.
 */
function twoClones(files) {
  const tmp = mkTempDir('bl-bc-remote-');
  const remote = join(tmp, 'remote.git');
  const alice = join(tmp, 'alice');
  const bob = join(tmp, 'bob');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  g(tmp, 'init', '-q', '-b', 'main', alice);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(alice, rel, '..'), { recursive: true });
    writeFileSync(join(alice, rel), text);
  }
  g(alice, 'add', '.');
  g(alice, 'commit', '-q', '-m', 'base');
  g(alice, 'remote', 'add', 'origin', remote);
  g(alice, 'push', '-q', 'origin', 'main');
  g(tmp, 'clone', '-q', remote, bob);
  for (const [dir, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ]) {
    g(dir, 'config', 'user.name', name);
    g(dir, 'config', 'user.email', `${name}@t`);
  }
  return { tmp, remote, alice, bob };
}

/** Bob commits `files` and pushes them. */
function bobPushes(bob, files, message = 'bob') {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(bob, rel, '..'), { recursive: true });
    writeFileSync(join(bob, rel), text);
  }
  g(bob, 'add', '.');
  g(bob, 'commit', '-q', '-m', message);
  g(bob, 'push', '-q', 'origin', 'main');
}

/** Run `fn` with stderr captured; returns [result, stderr text]. */
function captureStderr(fn) {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (chunk) => {
    err += chunk;
    return true;
  };
  try {
    return [fn(), err];
  } finally {
    process.stderr.write = orig;
  }
}

const STORY = 'stories/S1-a/index.md';
const COMPONENT_INDEX = 'components/C01-work/index.md';
/** The one path a pull settles by taking a side (`isGeneratedPath`, F-79 D1). */
const GENERATED = 'allowed-tools.json';

test('commitPaths pushes the commit to origin main', () => {
  const { tmp, remote, alice } = twoClones({ [STORY]: 'a\n' });
  try {
    writeFileSync(join(alice, STORY), 'a, edited\n');
    const res = commitPaths(alice, [STORY], 'chore: edit');
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// F-74 D1: a rejection that is not "origin moved" (a hook, auth, network)
// gets no rebase, only today's warning.
test('a push rejected for another reason is one warning naming the retry, with no rebase', () => {
  const cases = [
    {
      name: 'a pre-receive hook declines',
      setup: ({ remote }) =>
        writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho declined >&2\nexit 1\n', { mode: 0o755 }),
      why: /\[remote rejected\]/,
    },
    {
      // Origin moved too, and the fetch works: still no rebase, since the
      // push failed for another reason. (git checks fast-forward before a
      // hook runs, so the hook case cannot also have origin moved.)
      name: 'the push URL is unreachable while origin moved',
      setup: ({ alice, bob, tmp }) => {
        bobPushes(bob, { 'other.md': 'bob\n' });
        g(alice, 'remote', 'set-url', '--push', 'origin', join(tmp, 'gone.git'));
      },
      why: /fatal:/,
    },
  ];
  for (const c of cases) {
    const ctx = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
    const { tmp, alice } = ctx;
    try {
      const base = g(alice, 'rev-parse', 'HEAD');
      c.setup(ctx);
      writeFileSync(join(alice, STORY), 'alice\n');
      const [res, err] = captureStderr(() => commitPaths(alice, [STORY], 'chore: alice'));
      assert.equal(res.committed, true, res.error);
      assert.equal(res.pushed, false, c.name);
      assert.ok(res.pushError, c.name);
      assert.equal(err.trim().split('\n').length, 1, err);
      assert.match(err, /^warning: backlog commit not pushed/);
      assert.match(err, c.why, c.name);
      assert.ok(err.includes(`git -C "${alice}" push origin main`), err);
      assert.equal(g(alice, 'rev-parse', 'HEAD~1'), base, `${c.name}: not rebased`);
      assert.equal(g(alice, 'rev-parse', 'origin/main'), base, `${c.name}: not even fetched`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('commitPaths waits while a pull holds the main sync lock, then commits and pushes', () => {
  const { tmp, remote, alice } = twoClones({ [STORY]: 'a\n' });
  try {
    // A holder outside this process that lives about a second: the shell
    // exits at once, so init reaps the sleep and its PID goes dead.
    const pid = spawnSync('sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout.trim();
    const lockPath = join(alice, '.git', 'bl-main-sync.lock');
    writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\nbl main sync ${alice}\n`);
    writeFileSync(join(alice, STORY), 'a, edited\n');
    const start = Date.now();
    const res = commitPaths(alice, [STORY], 'chore: edit');
    assert.ok(Date.now() - start >= 500, 'the commit waited for the lock');
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(existsSync(lockPath), false, 'the lock is released');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no origin remote: commitPaths commits and does not push', () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x.md'), 'x\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'x.md'), 'y\n');
    assert.deepEqual(commitPaths(dir, ['x.md'], 'chore: y'), { committed: true, paths: ['x.md'] });
    assert.deepEqual(pullBacklog(dir), { state: 'no-remote' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pull brings the other clone's story and replays local commits on top", () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n' });
  try {
    assert.equal(pullBacklog(alice).state, 'current');
    g(alice, 'commit', '-q', '--allow-empty', '-m', 'alice local');
    bobPushes(bob, { 'stories/S2-b/index.md': "bob's story\n" });
    const res = pullBacklog(alice);
    assert.equal(res.state, 'pulled');
    assert.deepEqual(res.resolved, []);
    assert.equal(readFileSync(join(alice, 'stories/S2-b/index.md'), 'utf8'), "bob's story\n");
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'alice local');
    assert.equal(g(alice, 'rev-parse', 'HEAD~1'), g(alice, 'rev-parse', 'origin/main'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a dirty tree is autostashed and restored around the pull', () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    writeFileSync(join(alice, STORY), 'alice, uncommitted\n');
    writeFileSync(join(alice, 'scratch.md'), 'untracked\n');
    bobPushes(bob, { 'other.md': 'bob\n' });
    const res = pullBacklog(alice);
    assert.equal(res.state, 'pulled', res.message);
    assert.equal(res.message, undefined);
    assert.equal(readFileSync(join(alice, 'other.md'), 'utf8'), 'bob\n');
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice, uncommitted\n');
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: alice,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout;
    assert.match(status, new RegExp(`^ M ${STORY}$`, 'm'));
    assert.match(status, /^\?\? scratch\.md$/m);
    assert.equal(g(alice, 'stash', 'list'), '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a conflicting story aborts the rebase with a warning; work tree and edits as they were', () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    writeFileSync(join(alice, STORY), 'alice\n');
    g(alice, 'commit', '-q', '-am', 'alice story');
    writeFileSync(join(alice, 'other.md'), 'alice, uncommitted\n');
    const head = g(alice, 'rev-parse', 'HEAD');
    bobPushes(bob, { [STORY]: 'bob\n' });
    const res = pullBacklog(alice);
    assert.equal(res.state, 'conflict');
    assert.deepEqual(res.paths, [STORY]);
    assert.equal(g(alice, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice\n');
    assert.equal(readFileSync(join(alice, 'other.md'), 'utf8'), 'alice, uncommitted\n');
    assert.equal(g(alice, 'stash', 'list'), '');
    assert.equal(existsSync(join(alice, '.git', 'rebase-merge')), false);
    const [, err] = captureStderr(() => reportBacklogPull(res, alice));
    assert.match(err, /^warning: backlog pull conflicts with origin\/main in stories\/S1-a\/index\.md; rebase aborted/);
    assert.match(err, /continuing from the local backlog/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a conflict confined to generated files is settled by taking a side', () => {
  const { tmp, remote, alice, bob } = twoClones({ 'allowed-tools.json': '{}\n', [STORY]: 'a\n' });
  try {
    writeFileSync(join(alice, 'allowed-tools.json'), '{"a":1}\n');
    writeFileSync(join(alice, STORY), 'alice\n');
    g(alice, 'commit', '-q', '-am', 'alice');
    bobPushes(bob, { 'allowed-tools.json': '{"b":1}\n' });
    const res = pullBacklog(alice);
    assert.equal(res.state, 'pulled', res.message);
    assert.deepEqual(res.resolved, ['allowed-tools.json']);
    assert.equal(g(alice, 'rev-parse', 'HEAD~1'), g(remote, 'rev-parse', 'main'));
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice\n');
    assert.doesNotMatch(readFileSync(join(alice, 'allowed-tools.json'), 'utf8'), /<<<<<<<|>>>>>>>/);
    assert.equal(g(alice, 'status', '--porcelain'), '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a conflict in the root or a component index.md is a real conflict: rebase aborted, all as before', () => {
  for (const rel of ['index.md', COMPONENT_INDEX]) {
    const { tmp, remote, alice, bob } = twoClones({ [rel]: 'page\n', [STORY]: 'a\n' });
    try {
      writeFileSync(join(alice, rel), 'page, alice\n');
      g(alice, 'commit', '-q', '-am', 'alice');
      const head = g(alice, 'rev-parse', 'HEAD');
      bobPushes(bob, { [rel]: 'page, bob\n' });
      const res = pullBacklog(alice);
      assert.equal(res.state, 'conflict', `${rel}: ${res.message}`);
      assert.deepEqual(res.paths, [rel]);
      assert.equal(g(alice, 'rev-parse', 'HEAD'), head, rel);
      assert.equal(readFileSync(join(alice, rel), 'utf8'), 'page, alice\n', rel);
      assert.notEqual(g(remote, 'rev-parse', 'main'), head, rel);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('isGeneratedPath: allowed-tools.json only; the root and component indexes are hand-written (F-79 D1)', () => {
  assert.equal(isGeneratedPath('allowed-tools.json'), true);
  for (const p of [
    'index.md',
    'components/C01-work/index.md',
    'components/C01/index.md',
    'features/F1-x/index.md',
    'stories/S1-a/index.md',
    'components/notes/index.md',
    'components/C01-work/notes.md',
    'projects/infra/index.md',
    'projects/infra/notes/index.md',
    'projects/infra/E01-work/index.md',
  ]) {
    assert.equal(isGeneratedPath(p), false, p);
  }
});

test('commandPullsBacklog: committing commands, inbox and updates; never help', () => {
  for (const [cmd, argv] of [
    ['new', ['--title', 'x']],
    ['attach', ['S-1', 'F-1']],
    ['move', ['S-1', 'C01']],
    ['run', ['F-1']],
    ['implement', ['S-1']],
    ['merge', ['F-1']],
    ['done', ['S-1']],
    ['inbox', []],
    ['inbox', ['done', 'F-1:op1']],
    ['updates', ['status']],
    ['updates', ['approve', 'S-1']],
    ['sync', ['--commit', '-m', 'x', '--story', 'S-1']],
    ['s', ['--commit']],
    // A bare bl sync's whole job is the pull and push (F-79 D1).
    ['sync', []],
    ['s', []],
    ['block', ['add', 'S-1', '--gate', 'run', '--unit', 'F-1', '--until', 'done']],
    ['block', ['remove', 'S-1', '--gate', 'run', '--unit', 'F-1']],
    ['block', ['list', '--fix']],
    ['task', ['F-1', '--title', 'x', '--gate', 'none']],
    ['task', ['done', 'T-1']],
  ]) {
    assert.equal(commandPullsBacklog(cmd, argv), true, `${cmd} ${argv.join(' ')}`);
  }
  for (const [cmd, argv] of [
    ['sync', ['--help']],
    ['list', []],
    ['status', ['F-1']],
    ['status', []],
    ['updates', []],
    ['inbox', ['--help']],
    ['run', ['-h']],
    ['attach', ['--help']],
    ['move', ['--help']],
    ['block', ['list']],
    ['block', ['list', 'F-1']],
    ['block', ['add', '--help']],
    ['task', []],
    ['task', ['list', '--open']],
    ['task', ['done', '--help']],
  ]) {
    assert.equal(commandPullsBacklog(cmd, argv), false, `${cmd} ${argv.join(' ')}`);
  }
});

test('bl inbox pulls; an allowed-tools.json conflict is regenerated, committed and pushed by bl', () => {
  const { dir: alice, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'First' },
      { id: 'S-2', component: 'C01', title: 'Second' },
    ],
  });
  const tmp = mkTempDir('bl-bc-remote-');
  try {
    initGitBacklog(alice);
    ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
    g(alice, 'add', GENERATED);
    g(alice, 'commit', '-q', '-m', 'allowed tools');
    const remote = join(tmp, 'remote.git');
    const bob = join(tmp, 'bob');
    g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    g(alice, 'remote', 'add', 'origin', remote);
    g(alice, 'push', '-q', 'origin', 'main');
    g(tmp, 'clone', '-q', remote, bob);
    for (const [d, name] of [
      [alice, 'alice'],
      [bob, 'bob'],
    ]) {
      g(d, 'config', 'user.name', name);
      g(d, 'config', 'user.email', `${name}@t`);
    }
    const retitle = (root, id, title) => {
      const rel = g(root, 'ls-files', `stories/${id.replace('-', '')}/index.md`);
      const p = join(root, rel);
      writeFileSync(p, readFileSync(p, 'utf8').replace(/^title: .*$/m, `title: ${title}`));
    };

    // Bob retitles S-2 and commits through bl, which pushes; his clone's
    // allowed-tools.json was edited by hand too.
    retitle(bob, 'S-2', 'Second, by Bob');
    writeFileSync(join(bob, GENERATED), '{"b":1}\n');
    const b = runBl(['sync', '--commit', '-m', 'chore: bob', '--story', 'S-2', '--path', GENERATED], { cwd: bob });
    assert.equal(b.status, 0, b.stderr);
    assert.equal(g(remote, 'rev-parse', 'main'), g(bob, 'rev-parse', 'HEAD'));

    // Alice retitles S-1 and edits allowed-tools.json, and commits by hand,
    // unpushed: the two commits conflict in allowed-tools.json only.
    retitle(alice, 'S-1', 'First, by Alice');
    writeFileSync(join(alice, GENERATED), '{"a":1}\n');
    g(alice, 'commit', '-q', '-am', 'alice');

    const r = runBl(['inbox'], { cwd: alice });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /warning: backlog/);
    assert.match(readFileSync(join(alice, 'stories/S1/index.md'), 'utf8'), /First, by Alice/);
    assert.match(readFileSync(join(alice, 'stories/S2/index.md'), 'utf8'), /Second, by Bob/);
    const tools = readFileSync(join(alice, GENERATED), 'utf8');
    assert.doesNotMatch(tools, /<<<<<<<|>>>>>>>/);
    assert.ok(JSON.parse(tools)._generated, tools);
    assert.equal(g(alice, 'status', '--porcelain'), '');
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A pull that does not go through puts the checkout back, or stops the command
// ---------------------------------------------------------------------------

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).stdout.trim();
const BACKLOG_COMMIT = new URL('../../src/backlog-commit.js', import.meta.url).href;

/**
 * A `git` on PATH that fails (exit 91) when its first two arguments are one
 * of `failing` (e.g. "rebase --abort") and runs the real git otherwise.
 * @returns {string} the directory to put first on PATH
 */
function fakeGitBin(dir, failing) {
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const checks = failing
    .map((f) => `if [ "$1 $2" = "${f}" ]; then echo "injected: ${f} failed" >&2; exit 91; fi\n`)
    .join('');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${checks}exec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  return bin;
}

/** `pullBacklog(root)` in a child process whose git fails `failing`. */
function pullWithFailingGit(root, failing) {
  const bin = fakeGitBin(join(root, '..'), failing);
  const r = spawnSyncFiles(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(BACKLOG_COMMIT)}); console.log(JSON.stringify(m.pullBacklog(${JSON.stringify(root)})));`,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Branch, HEAD, rebase state, unmerged paths, stash and uncommitted edits. */
function checkoutState(root) {
  return {
    branch: spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout.trim(),
    head: g(root, 'rev-parse', 'HEAD'),
    rebasing: existsSync(join(root, '.git', 'rebase-merge')) || existsSync(join(root, '.git', 'rebase-apply')),
    unmerged: g(root, 'diff', '--name-only', '--diff-filter=U'),
    stash: g(root, 'stash', 'list'),
    edits: [...dirtySnapshot(root)].sort(),
    index: [
      ['ls-files', '-s'],
      ['status', '--porcelain'],
      ['diff', '--raw', '--no-renames'],
    ].map((a) => g(root, ...a)),
  };
}

// Every conflict phase of a pull, on clean, dirty, generated-only,
// hand-written and mixed pulls. `abortTo` is the state when the recovery
// works; with `git rebase --abort` (or the stash pop) failing too, the pull
// is `unsafe` and the checkout is not reported as restored.
const PULL_RECOVERY_CASES = [
  {
    name: 'hand-written conflict, clean tree',
    alice: { [STORY]: 'alice\n' },
    bob: { [STORY]: 'bob\n' },
    abortTo: 'conflict',
  },
  {
    name: 'hand-written conflict, dirty tree',
    alice: { [STORY]: 'alice\n' },
    dirty: { 'other.md': 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n' },
    abortTo: 'conflict',
  },
  {
    name: 'generated-only conflict whose settlement fails',
    alice: { [GENERATED]: 'component, alice\n' },
    dirty: { 'other.md': 'alice, uncommitted\n' },
    bob: { [GENERATED]: 'component, bob\n' },
    fail: ['checkout --theirs'],
    abortTo: 'failed',
  },
  {
    name: 'generated-only conflict, settled, then the rebase fails with nothing unmerged',
    alice: { [GENERATED]: 'component, alice\n' },
    bob: { [GENERATED]: 'component, bob\n' },
    fail: ['rebase --continue'],
    abortTo: 'failed',
  },
  {
    name: 'mixed conflict, dirty tree',
    alice: { [STORY]: 'alice\n', [GENERATED]: 'component, alice\n' },
    dirty: { 'other.md': 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n', [GENERATED]: 'component, bob\n' },
    abortTo: 'conflict',
  },
  {
    name: 'uncommitted edit conflicts with the pull, no local commits',
    dirty: { [STORY]: 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n' },
    abortTo: 'conflict',
    unsafeWhen: ['stash pop'],
  },
  {
    name: 'uncommitted edit conflicts with the pull, after a settled generated conflict',
    alice: { [GENERATED]: 'component, alice\n' },
    dirty: { [STORY]: 'alice, uncommitted\n' },
    bob: { [STORY]: 'bob\n', [GENERATED]: 'component, bob\n' },
    abortTo: 'conflict',
    unsafeWhen: ['stash pop'],
  },
];

function setUpPull(c) {
  const clones = twoClones({ [STORY]: 'a\n', [GENERATED]: 'component\n', 'other.md': 'o\n', 'staged.md': 's\n' });
  const { alice, bob } = clones;
  if (c.alice) {
    for (const [rel, text] of Object.entries(c.alice)) writeFileSync(join(alice, rel), text);
    g(alice, 'commit', '-q', '-am', 'alice');
  }
  for (const [rel, text] of Object.entries(c.dirty ?? {})) writeFileSync(join(alice, rel), text);
  bobPushes(bob, c.bob);
  return clones;
}

test('pullBacklog_recovery_restores_the_exact_checkout_in_every_conflict_phase', () => {
  for (const c of PULL_RECOVERY_CASES) {
    const { tmp, alice } = setUpPull(c);
    try {
      const start = checkoutState(alice);
      const res = pullWithFailingGit(alice, c.fail ?? []);
      assert.equal(res.state, c.abortTo, `${c.name}: ${res.message}`);
      assert.deepEqual(checkoutState(alice), start, c.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('pullBacklog_abort_failure_is_fatal_and_no_command_runs', () => {
  for (const c of PULL_RECOVERY_CASES) {
    const { tmp, alice } = setUpPull(c);
    try {
      const res = pullWithFailingGit(alice, [...(c.fail ?? []), ...(c.unsafeWhen ?? ['rebase --abort'])]);
      assert.equal(res.state, 'unsafe', `${c.name}: ${JSON.stringify(res)}`);
      assert.ok(res.message, c.name);
      const [, err] = captureStderr(() => reportBacklogPull(res, alice));
      assert.match(err, /^error: backlog pull could not put the checkout back .*; not running the command/, c.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Through bl: the command after an unsafe pull does not run.
  const { dir: alice, cleanup } = mkTempBacklog({
    projects: { infra: { title: 'Infra' } },
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'First' }],
  });
  const tmp = mkTempDir('bl-bc-remote-');
  try {
    initGitBacklog(alice);
    const remote = join(tmp, 'remote.git');
    const bob = join(tmp, 'bob');
    g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    g(alice, 'remote', 'add', 'origin', remote);
    g(alice, 'push', '-q', 'origin', 'main');
    g(tmp, 'clone', '-q', remote, bob);
    for (const [d, name] of [
      [alice, 'alice'],
      [bob, 'bob'],
    ]) {
      g(d, 'config', 'user.name', name);
      g(d, 'config', 'user.email', `${name}@t`);
    }
    const story = g(alice, 'ls-files', 'stories/S1/index.md');
    writeFileSync(join(alice, story), readFileSync(join(alice, story), 'utf8') + '\nalice\n');
    g(alice, 'commit', '-q', '-am', 'alice');
    writeFileSync(join(bob, story), readFileSync(join(bob, story), 'utf8') + '\nbob\n');
    g(bob, 'commit', '-q', '-am', 'bob');
    g(bob, 'push', '-q', 'origin', 'main');
    const bin = fakeGitBin(tmp, ['rebase --abort']);
    const r = runBl(['inbox', '--json'], { cwd: alice, env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /error: backlog pull could not put the checkout back/);
    assert.equal(r.stdout, '', 'bl inbox printed nothing: it did not run');
  } finally {
    cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// What the operator may have in the index besides work-tree edits. `lost`:
// git's own recovery (`git rebase --abort` re-applying the autostash
// unstaged) does not give it back.
const INDEX_CLASSES = [
  {
    name: 'staged edit',
    set: (r) => (writeFileSync(join(r, 'staged.md'), 'staged\n'), g(r, 'add', 'staged.md')),
    lost: true,
  },
  {
    name: 'staged edit, then edited again',
    set: (r) => (
      writeFileSync(join(r, 'staged.md'), 'staged\n'),
      g(r, 'add', 'staged.md'),
      writeFileSync(join(r, 'staged.md'), 'again\n')
    ),
    lost: true,
  },
  { name: 'staged deletion', set: (r) => g(r, 'rm', '-q', 'staged.md'), lost: true },
  { name: 'index-only mode change', set: (r) => g(r, 'update-index', '--chmod=+x', 'staged.md'), lost: true },
  { name: 'work-tree mode change', set: (r) => chmodSync(join(r, 'staged.md'), 0o755) },
  {
    name: 'intent-to-add entry',
    set: (r) => (writeFileSync(join(r, 'new.md'), 'n\n'), g(r, 'add', '-N', 'new.md')),
    state: 'failed',
  },
];

test('pullBacklog_recovery_rejects_changed_index_state', () => {
  // Every conflict phase × every index class: the pull that does not go
  // through gives the index back exactly, or it is not reported safe.
  for (const c of PULL_RECOVERY_CASES) {
    for (const ix of INDEX_CLASSES) {
      const name = `${c.name}, ${ix.name}`;
      const { tmp, alice } = setUpPull(c);
      try {
        ix.set(alice);
        const start = checkoutState(alice);
        const res = pullWithFailingGit(alice, c.fail ?? []);
        assert.equal(res.state, ix.state ?? c.abortTo, `${name}: ${res.message}`);
        assert.deepEqual(checkoutState(alice), start, name);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
  // When the index cannot be written back, the changed staging is caught.
  const c = PULL_RECOVERY_CASES.find((k) => k.name === 'hand-written conflict, dirty tree');
  for (const ix of INDEX_CLASSES.filter((k) => k.lost)) {
    const { tmp, alice } = setUpPull(c);
    try {
      ix.set(alice);
      const res = pullWithFailingGit(alice, ['rev-parse --path-format=absolute']);
      assert.equal(res.state, 'unsafe', `${ix.name}: ${JSON.stringify(res)}`);
      assert.match(res.message, /^the (staged|uncommitted) edits are not as they were before the pull/, ix.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('committing commands pull before settling an interrupted feature-link record, and unsafe pull leaves the record and linked files byte-identical', () => {
  // Every command that pulls; each meets a repair record of an interrupted
  // `bl new --feature` (settling it would restore S-1 and remove F-1) and a
  // pull that cannot put the checkout back.
  const commands = [
    ['new', '--title', 'x'],
    ['run', 'S-3'],
    ['implement', 'S-3'],
    ['merge', 'S-3'],
    ['done', 'S-3'],
    ['updates', 'status'],
    ['updates', 'approve', 'S-3'],
    ['sync', '--commit', '-m', 'x'],
    ['inbox'],
    ['inbox', 'done', 'F-1:op1'],
  ];
  for (const argv of commands) {
    const label = argv.join(' ');
    const story = (id, slug) => ({
      id,
      component: 'C00',
      title: slug,
      dirSuffix: slug,
      status: 'backlog',
      primary_repo: 'demo-repo',
    });
    const { dir: alice, cleanup } = mkTempBacklog({
      repos: ['../demo-repo'],
      components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
      stories: [story('S-1', 'one'), story('S-2', 'two'), story('S-3', 'three')],
    });
    const tmp = mkTempDir('bl-bc-remote-');
    try {
      initGitBacklog(alice);
      writeFileSync(join(alice, '.gitignore'), readFileSync(join(alice, '.gitignore'), 'utf8') + '.bl/\n');
      g(alice, 'commit', '-q', '-am', 'ignore .bl');
      const remote = join(tmp, 'remote.git');
      const bob = join(tmp, 'bob');
      g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
      g(alice, 'remote', 'add', 'origin', remote);
      g(alice, 'push', '-q', 'origin', 'main');
      g(tmp, 'clone', '-q', remote, bob);
      for (const [d, name] of [
        [alice, 'alice'],
        [bob, 'bob'],
      ]) {
        g(d, 'config', 'user.name', name);
        g(d, 'config', 'user.email', `${name}@t`);
      }
      const n = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], {
        cwd: alice,
        env: { BL_INTERNAL_TEST_FAIL_ON_LINK: 'S-2,restore:S-1' },
      });
      assert.equal(n.status, 1, `${label}: ${n.stderr}`);
      g(alice, 'add', '-A');
      g(alice, 'commit', '-q', '-m', 'interrupted feature');
      // Alice's and Bob's edits to S-3 conflict; the rebase cannot be aborted.
      const s3 = g(alice, 'ls-files', 'stories/S3-three/index.md');
      writeFileSync(join(alice, s3), readFileSync(join(alice, s3), 'utf8') + '\nalice\n');
      g(alice, 'commit', '-q', '-am', 'alice');
      writeFileSync(join(bob, s3), readFileSync(join(bob, s3), 'utf8') + '\nbob\n');
      g(bob, 'commit', '-q', '-am', 'bob');
      g(bob, 'push', '-q', 'origin', 'main');

      const linked = () => {
        const out = { record: readFileSync(join(alice, '.bl/run/F-1.links.json'), 'utf8') };
        for (const p of g(alice, 'ls-files', 'features', 'stories/S1-one', 'stories/S2-two').split('\n')) {
          out[p] = readFileSync(join(alice, p), 'utf8');
        }
        return out;
      };
      const before = linked();
      const bin = fakeGitBin(tmp, ['rebase --abort']);
      const r = runBl(argv, { cwd: alice, env: { PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(r.status, 1, `${label}: ${r.stderr}`);
      assert.match(r.stderr, /error: backlog pull could not put the checkout back/, label);
      assert.doesNotMatch(r.stderr, /settled the interrupted/, label);
      assert.deepEqual(linked(), before, `${label}: the record and its linked files keep their bytes`);
    } finally {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('a pull that goes through settles an interrupted feature-link record before its regeneration commits anything', () => {
  // `bl new --feature` failed and could not restore S-1: F-1 and its links
  // are uncommitted. Settling rolls them back, so the regeneration after
  // the pull must not commit or push F-1.
  const story = (id, slug) => ({
    id,
    component: 'C00',
    title: slug,
    dirSuffix: slug,
    status: 'backlog',
    primary_repo: 'demo-repo',
  });
  const { dir: alice, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [story('S-1', 'one'), story('S-2', 'two'), story('S-3', 'three')],
  });
  const tmp = mkTempDir('bl-bc-remote-');
  try {
    initGitBacklog(alice);
    writeFileSync(join(alice, '.gitignore'), readFileSync(join(alice, '.gitignore'), 'utf8') + '.bl/\n');
    g(alice, 'commit', '-q', '-am', 'ignore .bl');
    const remote = join(tmp, 'remote.git');
    const bob = join(tmp, 'bob');
    g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    g(alice, 'remote', 'add', 'origin', remote);
    g(alice, 'push', '-q', 'origin', 'main');
    g(tmp, 'clone', '-q', remote, bob);
    for (const [d, name] of [
      [alice, 'alice'],
      [bob, 'bob'],
    ]) {
      g(d, 'config', 'user.name', name);
      g(d, 'config', 'user.email', `${name}@t`);
    }
    const n = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], {
      cwd: alice,
      env: { BL_INTERNAL_TEST_FAIL_ON_LINK: 'S-2,restore:S-1' },
    });
    assert.equal(n.status, 1, n.stderr);
    // Bob's unrelated edit: the pull goes through and regenerates.
    const s3 = g(bob, 'ls-files', 'stories/S3-three/index.md');
    writeFileSync(join(bob, s3), readFileSync(join(bob, s3), 'utf8') + '\nbob\n');
    g(bob, 'commit', '-q', '-am', 'bob');
    g(bob, 'push', '-q', 'origin', 'main');

    const r = runBl(['inbox'], { cwd: alice });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /settled the interrupted bl new --feature of F-1: rolled back/);
    assert.equal(existsSync(join(alice, '.bl/run/F-1.links.json')), false);
    assert.equal(g(alice, 'ls-tree', '-r', '--name-only', 'HEAD', 'features'), '', 'no commit holds F-1');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(g(alice, 'status', '--porcelain'), '', 'nothing of F-1 is left behind');
  } finally {
    cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pullBacklog restores the exact dirty tree when autostash application conflicts', () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n' });
  try {
    writeFileSync(join(alice, STORY), 'alice, uncommitted\n');
    const start = checkoutState(alice);
    bobPushes(bob, { [STORY]: 'bob\n' });
    const res = pullBacklog(alice);
    assert.equal(res.state, 'conflict', res.message);
    assert.deepEqual(res.paths, [STORY]);
    assert.deepEqual(checkoutState(alice), start);
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice, uncommitted\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// allowed-tools.json follows its inputs after every pull
// ---------------------------------------------------------------------------

const TOOLS = 'allowed-tools.json';
const editJson = (root, rel, fn) => {
  const p = join(root, rel);
  const doc = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  fn(doc);
  writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
};

// What Bob pushes (a changed input, or an unrelated story when the case is
// about the shape of Alice's own allowed-tools.json) and what Alice commits
// to her allowed-tools.json beforehand.
const ALLOWED_TOOLS_PULL_CASES = [
  {
    name: 'top-level backlog.json plugin change',
    bob: (r) => editJson(r, 'backlog.json', (c) => (c.plugins.shellcheck = { lint: 'shellcheck {{path}}' })),
    expect: 'shellcheck',
  },
  {
    name: 'top-level backlog.json forge change',
    bob: (r) => editJson(r, 'backlog.json', (c) => (c.forge = 'github')),
  },
  {
    name: "a repo's override plugin change",
    bob: (r) =>
      editJson(r, 'backlog.json', (c) => {
        c.repos.extra = {
          path: '../extra',
          deployable: false,
          update_tests: [],
          overrides: { plugins: { yamllint: { lint: 'yamllint {{path}}' } } },
        };
      }),
    expect: 'yamllint',
  },
  { name: 'allowed-tools.json missing', alice: (r) => g(r, 'rm', '-q', TOOLS) },
  { name: 'stale config hash', alice: (r) => editJson(r, TOOLS, (t) => (t._generated.config_hash = 'stale')) },
  { name: 'stale generator version', alice: (r) => editJson(r, TOOLS, (t) => (t._generated.generator_version = 1)) },
  { name: 'malformed', alice: (r) => writeFileSync(join(r, TOOLS), '{ not json\n') },
  { name: 'clean and current', unchanged: true },
  {
    name: 'conflicted on both sides',
    alice: (r) => writeFileSync(join(r, TOOLS), '{"a":1}\n'),
    bob: (r) => writeFileSync(join(r, TOOLS), '{"b":1}\n'),
  },
];

const SYNC = new URL('../../src/sync.js', import.meta.url).href;
const CONFIG = new URL('../../src/config.js', import.meta.url).href;
const PENDING = '.bl/run/pull-regenerate.json';

/** `pullBeforeCommand` in a child process with `bin` first on PATH; [result, stderr]. */
function pullBeforeCommandIn(root, bin) {
  const src = `const s = await import(${JSON.stringify(SYNC)}); const c = await import(${JSON.stringify(CONFIG)});
console.log(JSON.stringify(await s.pullBeforeCommand(c.loadConfig({ backlogRoot: ${JSON.stringify(root)} }))));`;
  const r = spawnSyncFiles(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
    env: { ...process.env, ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}) },
  });
  assert.equal(r.status, 0, r.stderr);
  return [JSON.parse(r.stdout), r.stderr];
}

// Each way the regeneration after a pull can fail. `git` is a shell
// fragment run before the real git; `fixedBy` is what Bob pushes to make
// the retry go through (none: the retry is a pull that brings nothing).
const REGEN_FAILURES = [
  {
    name: 'the regeneration commit fails',
    git: `[ "$1 $2" = "commit -q" ] && { echo "injected: commit failed" >&2; exit 91; }`,
    message: /commit failed/,
  },
  {
    name: 'git status fails after the regeneration',
    git: `[ "$1" = "status" ] && [ -e ${PENDING} ] && { echo "injected: status failed" >&2; exit 91; }`,
    message: /git status failed/,
  },
  {
    name: 'the pulled configuration cannot be read (allowed-tools.json cannot be built)',
    bob: (r) =>
      editJson(r, 'backlog.json', (c) => {
        c.repos.extra = { path: '../extra', deployable: false, update_tests: [], overrides: { plugins: 'not-a-map' } };
      }),
    fixedBy: (r) =>
      editJson(r, 'backlog.json', (c) => {
        c.repos.extra = {
          path: '../extra',
          deployable: false,
          update_tests: [],
          overrides: { plugins: { yamllint: { lint: 'yamllint {{path}}' } } },
        };
      }),
    message: /./,
  },
];

test('pullBeforeCommand_retries_or_stops_after_regeneration_commit_failure', () => {
  for (const c of REGEN_FAILURES) {
    const { dir: alice, cleanup } = mkTempBacklog({
      config: { plugins: { prettier: { format: 'prettier --write {{path}}' } } },
    });
    const tmp = mkTempDir('bl-bc-remote-');
    try {
      initGitBacklog(alice);
      ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
      g(alice, 'add', TOOLS);
      g(alice, 'commit', '-q', '-m', 'allowed tools');
      const remote = join(tmp, 'remote.git');
      const bob = join(tmp, 'bob');
      g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
      g(alice, 'remote', 'add', 'origin', remote);
      g(alice, 'push', '-q', 'origin', 'main');
      g(tmp, 'clone', '-q', remote, bob);
      for (const [d, name] of [
        [alice, 'alice'],
        [bob, 'bob'],
      ]) {
        g(d, 'config', 'user.name', name);
        g(d, 'config', 'user.email', `${name}@t`);
      }
      const bobPushesFn = (fn) => {
        fn(bob);
        g(bob, 'add', '-A');
        g(bob, 'commit', '-q', '-m', 'bob');
        g(bob, 'push', '-q', 'origin', 'main');
      };
      // A pulled plugin change: allowed-tools.json has to be rebuilt.
      bobPushesFn(
        c.bob ??
          ((r) => editJson(r, 'backlog.json', (cfg) => (cfg.plugins.shellcheck = { lint: 'shellcheck {{path}}' }))),
      );

      const bin = join(tmp, 'fakebin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'git'), `#!/bin/sh\n${c.git ?? ''}\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
      const [res, err] = pullBeforeCommandIn(alice, bin);
      assert.equal(res.state, 'unsafe', `${c.name}: ${JSON.stringify(res)}`);
      assert.match(res.message, c.message, c.name);
      assert.match(
        err,
        /error: the backlog regeneration after the pull did not finish .*; not running the command/,
        c.name,
      );
      assert.ok(existsSync(join(alice, PENDING)), `${c.name}: the regeneration is left pending`);
      assert.notEqual(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull', c.name);

      // The next command finishes it before it runs, whether or not its pull brings anything.
      if (c.fixedBy) bobPushesFn(c.fixedBy);
      const [again] = pullBeforeCommandIn(alice, null);
      assert.equal(again.state, c.fixedBy ? 'pulled' : 'current', `${c.name}: ${JSON.stringify(again)}`);
      assert.equal(existsSync(join(alice, PENDING)), false, `${c.name}: nothing pending`);
      const cfg = loadConfig({ backlogRoot: alice });
      const tools = JSON.parse(readFileSync(join(alice, TOOLS), 'utf8'));
      assert.equal(
        regenReason(tools, { hash: configHash(allowlistInput(cfg)), version: GENERATOR_VERSION }),
        null,
        c.name,
      );
      assert.equal(g(alice, 'status', '--porcelain'), '', `${c.name}: the regeneration is committed`);
      assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull', c.name);
      assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), `${c.name}: and pushed`);
    } finally {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('pullBeforeCommand regenerates allowed-tools after a pulled configuration change without a file conflict', async () => {
  for (const c of ALLOWED_TOOLS_PULL_CASES) {
    const { dir: alice, cleanup } = mkTempBacklog({
      config: { plugins: { prettier: { format: 'prettier --write {{path}}' } } },
    });
    const tmp = mkTempDir('bl-bc-remote-');
    try {
      initGitBacklog(alice);
      ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
      g(alice, 'add', TOOLS);
      g(alice, 'commit', '-q', '-m', 'allowed tools');
      const remote = join(tmp, 'remote.git');
      const bob = join(tmp, 'bob');
      g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
      g(alice, 'remote', 'add', 'origin', remote);
      g(alice, 'push', '-q', 'origin', 'main');
      g(tmp, 'clone', '-q', remote, bob);
      for (const [d, name] of [
        [alice, 'alice'],
        [bob, 'bob'],
      ]) {
        g(d, 'config', 'user.name', name);
        g(d, 'config', 'user.email', `${name}@t`);
      }
      if (c.alice) {
        c.alice(alice);
        g(alice, 'add', '-A');
        g(alice, 'commit', '-q', '-m', 'alice');
      }
      (c.bob ?? ((r) => writeFileSync(join(r, 'notes.md'), 'bob\n')))(bob);
      g(bob, 'add', '-A');
      g(bob, 'commit', '-q', '-m', 'bob');
      g(bob, 'push', '-q', 'origin', 'main');
      const toolsBefore = existsSync(join(alice, TOOLS)) ? readFileSync(join(alice, TOOLS), 'utf8') : null;

      const [res] = await (async () => {
        const orig = process.stderr.write;
        process.stderr.write = () => true;
        try {
          return [await pullBeforeCommand(loadConfig({ backlogRoot: alice }))];
        } finally {
          process.stderr.write = orig;
        }
      })();
      assert.equal(res.state, 'pulled', `${c.name}: ${res.message}`);

      const cfg = loadConfig({ backlogRoot: alice });
      const text = readFileSync(join(alice, TOOLS), 'utf8');
      const reason = regenReason(JSON.parse(text), {
        hash: configHash(allowlistInput(cfg)),
        version: GENERATOR_VERSION,
      });
      assert.equal(reason, null, `${c.name}: allowed-tools.json is current`);
      if (c.expect) assert.ok(text.includes(c.expect), `${c.name}: ${c.expect} in allowed-tools.json`);
      if (c.unchanged) assert.equal(text, toolsBefore, c.name);
      assert.equal(g(alice, 'status', '--porcelain'), '', `${c.name}: the regeneration is committed`);
      assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), `${c.name}: and pushed`);
    } finally {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// F-74 D1: a push rejected because origin moved is rebased and pushed again;
// a pull pushes a `main` still ahead of origin
// ---------------------------------------------------------------------------

test('origin moved by an unrelated commit: the push succeeds after one rebase, with no warning', () => {
  const { tmp, remote, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    bobPushes(bob, { 'other.md': 'bob\n' });
    const bobHead = g(bob, 'rev-parse', 'HEAD');
    writeFileSync(join(alice, STORY), 'alice\n');
    writeFileSync(join(alice, 'scratch.md'), 'operator, uncommitted\n');
    const [res, err] = captureStderr(() => commitPaths(alice, [STORY], 'chore: alice'));
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(res.pushResolved, undefined);
    assert.equal(err, '');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(g(alice, 'rev-parse', 'HEAD~1'), bobHead);
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: alice');
    assert.equal(readFileSync(join(alice, 'scratch.md'), 'utf8'), 'operator, uncommitted\n');
    assert.equal(existsSync(join(alice, PENDING)), false, 'nothing to regenerate');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the retry rebases under the main sync lock the commit holds', () => {
  const { tmp, remote, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    const seen = join(tmp, 'lock-seen');
    // git runs pre-rebase as the rebase starts: record whether the lock is held.
    writeFileSync(
      join(alice, '.git', 'hooks', 'pre-rebase'),
      `#!/bin/sh\nif [ -e "${join(alice, '.git', 'bl-main-sync.lock')}" ]; then echo held > "${seen}"; else echo free > "${seen}"; fi\n`,
      { mode: 0o755 },
    );
    bobPushes(bob, { 'other.md': 'bob\n' });
    writeFileSync(join(alice, STORY), 'alice\n');
    const res = commitPaths(alice, [STORY], 'chore: alice');
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(readFileSync(seen, 'utf8').trim(), 'held');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('origin moved by a commit that conflicts in a story file: rebase aborted, all as before, warning names the path', () => {
  const { tmp, remote, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    bobPushes(bob, { [STORY]: 'bob\n' });
    writeFileSync(join(alice, 'other.md'), 'alice, uncommitted\n');
    writeFileSync(join(alice, 'staged.md'), 'alice, staged\n');
    g(alice, 'add', 'staged.md');
    writeFileSync(join(alice, STORY), 'alice\n');
    const [res, err] = captureStderr(() => commitPaths(alice, [STORY], 'chore: alice'));
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, false);
    assert.deepEqual(res.pushConflicts, [STORY]);
    // The checkout is as the commit left it: HEAD is Alice's commit on her base.
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: alice');
    assert.equal(g(alice, 'rev-parse', 'HEAD~1'), g(bob, 'rev-parse', 'HEAD~1'));
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice\n');
    assert.equal(readFileSync(join(alice, 'other.md'), 'utf8'), 'alice, uncommitted\n');
    assert.match(g(alice, 'status', '--porcelain'), /^A  staged\.md$/m);
    assert.equal(g(alice, 'stash', 'list'), '');
    assert.equal(existsSync(join(alice, '.git', 'rebase-merge')), false);
    assert.notEqual(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(err.trim().split('\n').length, 1, err);
    assert.match(
      err,
      /^warning: backlog commit not pushed \(origin\/main moved and the rebase onto it conflicts in stories\/S1-a\/index\.md\)/,
    );
    assert.ok(err.includes(`git -C "${alice}" pull --rebase --autostash origin main`), err);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('isNonFastForwardRejection: fetch first and non-fast-forward only', () => {
  assert.equal(
    isNonFastForwardRejection('To /r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push'),
    true,
  );
  assert.equal(isNonFastForwardRejection(' ! [rejected]        main -> main (non-fast-forward)\n'), true);
  assert.equal(isNonFastForwardRejection(' ! [remote rejected] main -> main (pre-receive hook declined)\n'), false);
  assert.equal(isNonFastForwardRejection("fatal: '/gone.git' does not appear to be a git repository\n"), false);
  assert.equal(isNonFastForwardRejection(undefined), false);
});

/**
 * A real backlog (synced, committed) for Alice, a bare origin and Bob's
 * clone of it, so `pullBeforeCommand` can regenerate after a pull.
 */
function backlogClones() {
  const { dir: alice, cleanup } = mkTempBacklog({});
  const tmp = mkTempDir('bl-bc-remote-');
  initGitBacklog(alice);
  ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
  g(alice, 'add', TOOLS);
  g(alice, 'commit', '-q', '-m', 'allowed tools');
  const remote = join(tmp, 'remote.git');
  const bob = join(tmp, 'bob');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  g(alice, 'remote', 'add', 'origin', remote);
  g(alice, 'push', '-q', 'origin', 'main');
  g(tmp, 'clone', '-q', remote, bob);
  for (const [d, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ]) {
    g(d, 'config', 'user.name', name);
    g(d, 'config', 'user.email', `${name}@t`);
  }
  return {
    alice,
    bob,
    remote,
    done: () => {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** `pullBeforeCommand` in this process with stderr captured: [result, stderr]. */
async function pullBeforeCommandCaptured(root) {
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (chunk) => {
    err += chunk;
    return true;
  };
  try {
    return [await pullBeforeCommand(loadConfig({ backlogRoot: root })), err];
  } finally {
    process.stderr.write = orig;
  }
}

test('a conflict only in a generated path is settled, pushed, and regenerated by the next pulling command', async () => {
  const { alice, bob, remote, done } = backlogClones();
  try {
    const generated = readFileSync(join(alice, TOOLS), 'utf8');
    bobPushes(bob, { [TOOLS]: `${generated}\nbob's line\n` });
    writeFileSync(join(alice, TOOLS), `${generated}\nalice's line\n`);
    writeFileSync(join(alice, 'notes.md'), 'alice\n');
    const [res, err] = captureStderr(() => commitPaths(alice, [TOOLS, 'notes.md'], 'chore: alice'));
    assert.equal(res.pushed, true, res.pushError);
    assert.deepEqual(res.pushResolved, [TOOLS]);
    assert.equal(err, '');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.ok(existsSync(join(alice, PENDING)), 'the regeneration is left pending');
    assert.match(readFileSync(join(alice, TOOLS), 'utf8'), /alice's line/, 'not regenerated under the lock');

    const [pull, pullErr] = await pullBeforeCommandCaptured(alice);
    assert.equal(pull.state, 'current', pullErr);
    assert.doesNotMatch(pullErr, /warning|error/);
    assert.equal(existsSync(join(alice, PENDING)), false, 'the regeneration finished');
    assert.doesNotMatch(readFileSync(join(alice, TOOLS), 'utf8'), /alice's line|bob's line/);
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull');
    assert.equal(g(alice, 'status', '--porcelain'), '');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    done();
  }
});

test("an edit made after the retry left a regeneration pending stays out of the regeneration's commit", async () => {
  const { alice, bob, remote, done } = backlogClones();
  try {
    const generated = readFileSync(join(alice, TOOLS), 'utf8');
    writeFileSync(join(alice, 'notes.md'), 'committed\n');
    g(alice, 'add', 'notes.md');
    g(alice, 'commit', '-q', '-m', 'notes');
    g(alice, 'push', '-q', 'origin', 'main');
    g(bob, 'pull', '-q', 'origin', 'main');
    bobPushes(bob, { [TOOLS]: `${generated}\nbob's line\n` });
    writeFileSync(join(alice, TOOLS), `${generated}\nalice's line\n`);
    const res = commitPaths(alice, [TOOLS], 'chore: alice');
    assert.deepEqual(res.pushResolved, [TOOLS]);
    assert.ok(existsSync(join(alice, PENDING)), 'the regeneration is left pending');

    // The operator goes on working before the next command that pulls.
    writeFileSync(join(alice, 'notes.md'), 'operator, half done\n');
    writeFileSync(join(alice, 'draft.md'), 'operator, new\n');
    const [pull, pullErr] = await pullBeforeCommandCaptured(alice);
    assert.equal(pull.state, 'current', pullErr);
    assert.equal(existsSync(join(alice, PENDING)), false, 'the regeneration finished');
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull');
    const regenerated = g(alice, 'show', '--format=', '--name-only', 'HEAD').split('\n');
    assert.ok(regenerated.includes(TOOLS), regenerated.join(', '));
    assert.ok(!regenerated.includes('notes.md') && !regenerated.includes('draft.md'), regenerated.join(', '));
    assert.equal(readFileSync(join(alice, 'notes.md'), 'utf8'), 'operator, half done\n');
    assert.equal(g(alice, 'status', '--porcelain'), 'M notes.md\n?? draft.md');
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    done();
  }
});

test('push_retry_cannot_report_success_when_regeneration_marker_fails', async () => {
  const runDir = (r) => join(r, '.bl', 'run');
  const cases = [
    { name: 'the marker path is a directory', marker: (r) => mkdirSync(join(r, PENDING), { recursive: true }) },
    { name: 'the marker holds no JSON', marker: (r) => writeFileSync(join(r, PENDING), 'not json') },
    {
      name: 'the marker cannot be written',
      marker: (r) => {
        mkdirSync(runDir(r), { recursive: true });
        chmodSync(runDir(r), 0o555);
      },
    },
    { name: 'a snapshot is already pending', marker: (r) => writeFileSync(join(r, PENDING), '[]'), ok: true },
  ];
  for (const c of cases) {
    const { alice, bob, remote, done } = backlogClones();
    try {
      const generated = readFileSync(join(alice, TOOLS), 'utf8');
      bobPushes(bob, { [TOOLS]: `${generated}\nbob's line\n` });
      const origin = g(remote, 'rev-parse', 'main');
      writeFileSync(join(alice, TOOLS), `${generated}\nalice's line\n`);
      mkdirSync(runDir(alice), { recursive: true });
      c.marker(alice);
      const [res, err] = captureStderr(() => commitPaths(alice, [TOOLS], 'chore: alice'));
      assert.equal(res.committed, true, `${c.name}: ${res.error}`);
      if (c.ok) {
        assert.equal(res.pushed, true, `${c.name}: ${res.pushError}`);
        assert.deepEqual(res.pushResolved, [TOOLS], c.name);
        assert.equal(readFileSync(join(alice, PENDING), 'utf8'), '[]', `${c.name}: the pending snapshot is kept`);
        continue;
      }
      assert.equal(res.pushed, false, `${c.name}: no success without a marker`);
      assert.equal(res.pushResolved, undefined, `${c.name}: nothing settled`);
      assert.equal(g(remote, 'rev-parse', 'main'), origin, `${c.name}: origin keeps bob's index`);
      assert.equal(g(alice, 'rev-parse', 'HEAD~1'), g(bob, 'rev-parse', 'HEAD~1'), `${c.name}: not rebased`);
      assert.match(err, /^warning: backlog commit not pushed \(origin\/main moved and the regeneration marker/, c.name);
      // The next command that pulls cannot regenerate either: it stops, it
      // does not push the commit as it is.
      const [pull] = await pullBeforeCommandCaptured(alice);
      assert.equal(pull.state, 'unsafe', `${c.name}: ${pull.message}`);
      assert.equal(g(remote, 'rev-parse', 'main'), origin, `${c.name}: still not pushed`);
    } finally {
      if (existsSync(runDir(alice))) chmodSync(runDir(alice), 0o755);
      done();
    }
  }
});

test('push_if_ahead_reports_count_query_failure', () => {
  // Run in a child so a fake `git` on PATH can answer the count with something else.
  const pushIfAheadIn = (root, path = process.env.PATH) => {
    const r = spawnSyncFiles(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { pushIfAhead, pushWarning } from ${JSON.stringify(join(REPO_ROOT, 'src', 'backlog-commit.js'))};
         const p = pushIfAhead(process.argv[1]);
         console.log(JSON.stringify({ p, warning: p && !p.pushed ? pushWarning(process.argv[1], p) : null }));`,
        root,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: path } },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const cases = [
    { name: 'origin/main is missing', setup: ({ alice }) => g(alice, 'update-ref', '-d', 'refs/remotes/origin/main') },
    {
      name: 'the count is not a number',
      fakeGit:
        '#!/bin/sh\ncase "$*" in *\'rev-list --count origin/main..HEAD\'*) echo many; exit 0;; esac\nexec /usr/bin/git "$@"\n',
    },
    { name: 'nothing ahead', none: true },
    { name: 'one commit ahead', ahead: true, pushed: true },
  ];
  for (const c of cases) {
    const { tmp, remote, alice } = twoClones({ [STORY]: 'a\n' });
    try {
      g(alice, 'fetch', '-q', 'origin');
      if (!c.none) {
        writeFileSync(join(alice, 'notes.md'), 'alice\n');
        g(alice, 'add', 'notes.md');
        g(alice, 'commit', '-q', '-m', 'alice, unpushed');
      }
      c.setup?.({ alice });
      let path;
      if (c.fakeGit) {
        const bin = join(tmp, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'git'), c.fakeGit, { mode: 0o755 });
        path = `${bin}:${process.env.PATH}`;
      }
      const { p, warning } = pushIfAheadIn(alice, path);
      if (c.none) {
        assert.equal(p, null, c.name);
      } else if (c.pushed) {
        assert.equal(p.pushed, true, `${c.name}: ${p.error}`);
        assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), c.name);
      } else {
        assert.notEqual(p, null, `${c.name}: a failed count is not "nothing ahead"`);
        assert.equal(p.pushed, false, c.name);
        assert.match(p.error, /^cannot count the commits origin\/main lacks \(/, c.name);
        assert.doesNotMatch(p.error, /\n/, c.name);
        assert.match(warning, /^backlog commit not pushed \(cannot count the commits origin\/main lacks/, c.name);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('a pulling command pushes a main still ahead: 1 ahead and N behind, and 1 ahead and 0 behind', async () => {
  for (const behind of [2, 0]) {
    const { alice, bob, remote, done } = backlogClones();
    try {
      for (let i = 0; i < behind; i++) bobPushes(bob, { [`notes-bob-${i}.md`]: 'bob\n' }, `bob ${i}`);
      writeFileSync(join(alice, 'notes.md'), 'alice\n');
      g(alice, 'add', 'notes.md');
      g(alice, 'commit', '-q', '-m', 'alice, unpushed');
      const [res, err] = await pullBeforeCommandCaptured(alice);
      assert.equal(res.state, behind ? 'pulled' : 'current', err);
      assert.doesNotMatch(err, /warning|error/, `behind ${behind}`);
      assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), `behind ${behind}: pushed`);
      assert.match(g(alice, 'log', '--format=%s'), /alice, unpushed/);
      if (behind) assert.ok(existsSync(join(alice, 'notes-bob-1.md')));
    } finally {
      done();
    }
  }
});

test("a pulling command's push that is rejected again is a warning, and the command still runs", async () => {
  const { alice, remote, done } = backlogClones();
  try {
    writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(alice, 'notes.md'), 'alice\n');
    g(alice, 'add', 'notes.md');
    g(alice, 'commit', '-q', '-m', 'alice, unpushed');
    const [res, err] = await pullBeforeCommandCaptured(alice);
    assert.equal(res.state, 'current');
    assert.match(err, /^warning: backlog commit not pushed \(.*\[remote rejected\]/);
    assert.notEqual(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    done();
  }
});

test('regeneration_marker_self_ignores_fresh_run_directory: both marker writers leave .bl/run self-ignoring', () => {
  const writers = [
    ['leaveRegenerationPending', leaveRegenerationPending],
    ['markRegenerationPending', markRegenerationPending],
  ];
  for (const [name, write] of writers) {
    const root = mkTempDir('bl-marker-');
    try {
      assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' }).status, 0);
      assert.ok(!existsSync(join(root, '.bl')), `${name}: a fresh backlog has no run directory`);
      write(root);
      assert.ok(existsSync(join(root, PULL_REGEN_PENDING)), `${name}: marker written`);
      assert.equal(readFileSync(join(root, '.bl', 'run', '.gitignore'), 'utf8'), '*\n', name);
      const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(status.stdout.trim(), '', `${name}: nothing under .bl/run is untracked`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
