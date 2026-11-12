import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  commitPaths,
  commandPullsBacklog,
  isGeneratedPath,
  pullBacklog,
  reportBacklogPull,
} from '../../src/backlog-commit.js';
import { mkTempDir, mkTempBacklog } from '../helpers/tempdir.js';
import { initGitBacklog } from '../helpers/git-backlog.js';
import { holdLock } from '../helpers/hold-lock.js';
import { holderOf } from '../../src/kernel-lock.js';
import { runBl } from '../helpers/run-bl.js';
import { loadConfig } from '../../src/config.js';
import { ensureAllowedTools } from '../../src/allowed-tools.js';
import { g, twoClones, bobPushes, captureStderr, STORY, GENERATED } from '../helpers/backlog-commit-fixture.js';

// ---------------------------------------------------------------------------
// Shared through the remote (F-50 D4): push after commit, pull with rebase
// ---------------------------------------------------------------------------

const COMPONENT_INDEX = 'components/C01-work/index.md';

test('commitPaths pushes the commit to origin main', async () => {
  const { tmp, remote, alice } = twoClones({ [STORY]: 'a\n' });
  try {
    writeFileSync(join(alice, STORY), 'a, edited\n');
    const res = await commitPaths(alice, [STORY], 'chore: edit');
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// F-74 D1: a rejection that is not "origin moved" (a hook, auth, network)
// gets no rebase, only today's warning.
test('a push rejected for another reason is one warning naming the retry, with no rebase', async () => {
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
      const [res, err] = await captureStderr(() => commitPaths(alice, [STORY], 'chore: alice'));
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

test('commitPaths waits while a pull holds the main sync lock, then commits and pushes', async () => {
  const { tmp, remote, alice } = twoClones({ [STORY]: 'a\n' });
  try {
    // A holder that lets go after about a second; the wait awaits a timer, so
    // this timer runs during it.
    const lockPath = join(alice, '.git', 'bl-main-sync.lock');
    const holder = holdLock(lockPath, `bl main sync ${alice}`);
    setTimeout(holder.release, 1000);
    writeFileSync(join(alice, STORY), 'a, edited\n');
    const start = Date.now();
    const res = await commitPaths(alice, [STORY], 'chore: edit');
    assert.ok(Date.now() - start >= 500, 'the commit waited for the lock');
    assert.equal(res.committed, true, res.error);
    assert.equal(res.pushed, true, res.pushError);
    assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'));
    assert.equal(holderOf(lockPath), null, 'the lock is released');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no origin remote: commitPaths commits and does not push', async () => {
  const dir = mkTempDir('bl-bc-');
  try {
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x.md'), 'x\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'x.md'), 'y\n');
    assert.deepEqual(await commitPaths(dir, ['x.md'], 'chore: y'), { committed: true, paths: ['x.md'] });
    assert.deepEqual(await pullBacklog(dir), { state: 'no-remote' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pull brings the other clone's story and replays local commits on top", async () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n' });
  try {
    assert.equal((await pullBacklog(alice)).state, 'current');
    g(alice, 'commit', '-q', '--allow-empty', '-m', 'alice local');
    bobPushes(bob, { 'stories/S2-b/index.md': "bob's story\n" });
    const res = await pullBacklog(alice);
    assert.equal(res.state, 'pulled');
    assert.deepEqual(res.resolved, []);
    assert.equal(readFileSync(join(alice, 'stories/S2-b/index.md'), 'utf8'), "bob's story\n");
    assert.equal(g(alice, 'log', '-1', '--format=%s'), 'alice local');
    assert.equal(g(alice, 'rev-parse', 'HEAD~1'), g(alice, 'rev-parse', 'origin/main'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a dirty tree is autostashed and restored around the pull', async () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    writeFileSync(join(alice, STORY), 'alice, uncommitted\n');
    writeFileSync(join(alice, 'scratch.md'), 'untracked\n');
    bobPushes(bob, { 'other.md': 'bob\n' });
    const res = await pullBacklog(alice);
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

test('a conflicting story aborts the rebase with a warning; work tree and edits as they were', async () => {
  const { tmp, alice, bob } = twoClones({ [STORY]: 'a\n', 'other.md': 'o\n' });
  try {
    writeFileSync(join(alice, STORY), 'alice\n');
    g(alice, 'commit', '-q', '-am', 'alice story');
    writeFileSync(join(alice, 'other.md'), 'alice, uncommitted\n');
    const head = g(alice, 'rev-parse', 'HEAD');
    bobPushes(bob, { [STORY]: 'bob\n' });
    const res = await pullBacklog(alice);
    assert.equal(res.state, 'conflict');
    assert.deepEqual(res.paths, [STORY]);
    assert.equal(g(alice, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(join(alice, STORY), 'utf8'), 'alice\n');
    assert.equal(readFileSync(join(alice, 'other.md'), 'utf8'), 'alice, uncommitted\n');
    assert.equal(g(alice, 'stash', 'list'), '');
    assert.equal(existsSync(join(alice, '.git', 'rebase-merge')), false);
    const [, err] = await captureStderr(() => reportBacklogPull(res, alice));
    assert.match(err, /^warning: backlog pull conflicts with origin\/main in stories\/S1-a\/index\.md; rebase aborted/);
    assert.match(err, /continuing from the local backlog/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a conflict confined to generated files is settled by taking a side', async () => {
  const { tmp, remote, alice, bob } = twoClones({ 'allowed-tools.json': '{}\n', [STORY]: 'a\n' });
  try {
    writeFileSync(join(alice, 'allowed-tools.json'), '{"a":1}\n');
    writeFileSync(join(alice, STORY), 'alice\n');
    g(alice, 'commit', '-q', '-am', 'alice');
    bobPushes(bob, { 'allowed-tools.json': '{"b":1}\n' });
    const res = await pullBacklog(alice);
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

test('a conflict in the root or a component index.md is a real conflict: rebase aborted, all as before', async () => {
  for (const rel of ['index.md', COMPONENT_INDEX]) {
    const { tmp, remote, alice, bob } = twoClones({ [rel]: 'page\n', [STORY]: 'a\n' });
    try {
      writeFileSync(join(alice, rel), 'page, alice\n');
      g(alice, 'commit', '-q', '-am', 'alice');
      const head = g(alice, 'rev-parse', 'HEAD');
      bobPushes(bob, { [rel]: 'page, bob\n' });
      const res = await pullBacklog(alice);
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
    ['refine', ['S-1']],
    ['approve', ['F-1']],
    ['init', []],
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
    ['refine', ['--help']],
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

test('bl inbox pulls; an allowed-tools.json conflict is regenerated, committed and pushed by bl', async () => {
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
    await ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
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
