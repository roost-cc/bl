/**
 * `bl sync` writes no derived list (F-79 D1): with no `--commit` it pulls and
 * pushes, and two clones that each add a story under the same component and
 * feature rebase onto each other without a conflict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { join, relative } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { loadConfig } from '../../src/config.js';
import { ensureAllowedTools } from '../../src/allowed-tools.js';

/** One component, one feature and one story in it. */
function seeded() {
  return mkTempBacklog({
    repos: ['../core'],
    components: [{ id: 'C01', title: 'Core', dirSuffix: 'core', repo: 'core' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'First Story', dirSuffix: 'first-story', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'One', dirSuffix: 'one', status: 'approved' }],
  });
}

/** Every file under `dir` (outside `.git/`) with its bytes and mtime. */
function tree(dir, root = dir, out = new Map()) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) tree(p, root, out);
    else out.set(relative(root, p), `${readFileSync(p, 'utf8')}\0${statSync(p).mtimeMs}`);
  }
  return out;
}

/**
 * `seeded()` as Alice's git clone, a bare origin, and Bob's clone of it, each
 * with its own identity.
 */
function twoClones() {
  const { dir: alice, cleanup } = seeded();
  initGitBacklog(alice);
  // The one generated file, current, so no pull regenerates it.
  ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
  git(alice, 'add', '.');
  git(alice, 'commit', '-q', '--allow-empty', '-m', 'allowed tools');
  const tmp = mkTempDir('bl-sync-remote-');
  const remote = join(tmp, 'remote.git');
  const bob = join(tmp, 'bob');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(alice, 'remote', 'add', 'origin', remote);
  git(alice, 'push', '-q', 'origin', 'main');
  git(tmp, 'clone', '-q', remote, bob);
  return {
    alice,
    bob,
    remote,
    cleanup: () => {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const bl = (args, cwd) => runBl(args, { cwd, env: { ...GIT_ENV, BL_BACKLOG_DIR: cwd } });

test('bl sync on a clean tree with no origin writes no file and creates no index', () => {
  const { dir, cleanup } = seeded();
  try {
    const before = tree(dir);
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(tree(dir), before);
  } finally {
    cleanup();
  }
});

test('bl sync pulls what origin has and pushes what main has, and writes nothing else', () => {
  const { alice, bob, remote, cleanup } = twoClones();
  try {
    // Bob's story arrives at Alice by her bare bl sync.
    git(bob, 'mv', 'stories/S1-first-story', 'stories/S1-renamed');
    git(bob, '-c', 'user.name=b', '-c', 'user.email=b@b', 'commit', '-q', '-m', 'bob');
    git(bob, 'push', '-q', 'origin', 'main');
    const r = bl(['sync'], alice);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(alice, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
    assert.equal(git(alice, 'status', '--porcelain'), '');
    assert.deepEqual(git(alice, 'log', '--format=%s').split('\n'), ['bob', 'allowed tools', 'base']);

    // A commit Alice made by hand is pushed by her next bare bl sync.
    git(alice, 'commit', '-q', '--allow-empty', '-m', 'alice');
    const p = bl(['sync'], alice);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(git(remote, 'rev-parse', 'main'), git(alice, 'rev-parse', 'HEAD'));
    assert.equal(git(alice, 'status', '--porcelain'), '');
  } finally {
    cleanup();
  }
});

test('bl sync --help says it pulls and pushes and writes no index', () => {
  const { dir, cleanup } = seeded();
  try {
    const r = runBl(['sync', '--help'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rebases main onto\norigin\/main/);
    assert.match(r.stdout, /Writes no index or table/);
    assert.doesNotMatch(r.stdout, /Regenerates/);
  } finally {
    cleanup();
  }
});

test('bl sync refuses a backlog.json title that is not a one-line string', () => {
  const { dir, cleanup } = mkTempBacklog({ config: { title: 7 } });
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /backlog\.json "title" must be a one-line, non-empty string/);
  } finally {
    cleanup();
  }
});

test('two clones that each bl new a story under the same component and feature rebase onto each other without a conflict', () => {
  const { alice, bob, remote, cleanup } = twoClones();
  try {
    // Alice adds her story: bl new commits it and pushes.
    const a = bl(['new', 'F-1', 'C01', '--title', 'Alice story', '--points', '1'], alice);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(git(remote, 'rev-parse', 'main'), git(alice, 'rev-parse', 'HEAD'));

    // Bob adds his while origin cannot be reached, so his commit is made on
    // the base, beside Alice's.
    git(bob, 'remote', 'set-url', 'origin', join(bob, 'offline.git'));
    const b = bl(['new', 'F-1', 'C01', '--title', 'Bob story', '--points', '2'], bob);
    assert.equal(b.status, 0, b.stderr);
    git(bob, 'remote', 'set-url', 'origin', remote);
    assert.equal(git(bob, 'rev-list', '--count', 'origin/main..HEAD'), '1');

    // Both take S-2: each clone allocates ids from what it has (bl validate
    // reports the duplicate-id). Each commit holds its story directory and
    // nothing else.
    for (const [who, subject] of [
      [alice, 'chore: add S-2'],
      [bob, 'chore: add S-2'],
    ]) {
      assert.equal(git(who, 'log', '-1', '--format=%s'), subject);
      const files = git(who, 'show', '--name-only', '--format=', 'HEAD').split('\n');
      assert.ok(
        files.every((f) => f.startsWith('stories/')),
        files.join('\n'),
      );
    }

    // Bob's bl sync rebases his commit onto Alice's and pushes it; Alice's
    // bl sync brings it to her.
    const s = bl(['sync'], bob);
    assert.equal(s.status, 0, s.stderr);
    assert.doesNotMatch(s.stderr, /conflict|warning/);
    assert.equal(git(remote, 'rev-parse', 'main'), git(bob, 'rev-parse', 'HEAD'));
    const t = bl(['sync'], alice);
    assert.equal(t.status, 0, t.stderr);
    assert.equal(git(alice, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
    for (const who of [alice, bob]) {
      assert.equal(git(who, 'status', '--porcelain'), '');
      const stories = readdirSync(join(who, 'stories')).sort();
      assert.deepEqual(stories, ['S1-first-story', 'S2-alice-story', 'S2-bob-story']);
    }
  } finally {
    cleanup();
  }
});
