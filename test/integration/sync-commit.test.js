import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { BL_BIN, lockOwnerVisible, runBl, startBlBehindLock } from '../helpers/run-bl.js';
import { GIT_ENV, git, headFiles, initGitBacklog } from '../helpers/git-backlog.js';
import { loadConfig } from '../../src/config.js';
import { acquireLock, LOCK_FILE, releaseLock } from '../../src/lock.js';
import { runSync, syncAndCommit } from '../../src/sync.js';

// S-578: `bl sync` serialises on the backlog lock, and `bl sync --commit`
// commits only what the sync wrote plus the named stories' directories.

const COMPONENT = 'components/C01-core';
const S1 = 'stories/S1-done';
const S2 = 'stories/S2-edited';
const S3 = 'stories/S3-bystander';
// A component's slug renamed by hand: both ends of the move.
const FROM = 'components/C02-other';
const TO = 'components/C02-renamed';

/** A git-backed backlog: component C01 with three stories, and an empty C02. */
function gitBacklog() {
  const t = mkTempBacklog({
    components: [
      { id: 'C01', title: 'Core', dirSuffix: 'core' },
      { id: 'C02', title: 'Other', dirSuffix: 'other' },
    ],
    stories: [1, 2, 3].map((n) => ({
      id: `S-${n}`,
      component: 'C01',
      title: `Story ${n}`,
      dirSuffix: ['done', 'edited', 'bystander'][n - 1],
    })),
  });
  initGitBacklog(t.dir);
  return t;
}

function setField(dir, storyDir, key, value) {
  const p = join(dir, storyDir, 'index.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace(new RegExp(`^${key}: .*$`, 'm'), `${key}: ${value}`));
}

function blAsync(args, cwd) {
  return spawnToFiles(BL_BIN, args, { cwd, env: { ...process.env, ...GIT_ENV, BL_BACKLOG_DIR: cwd } }).closed.then(
    ({ status, stderr }) => ({ status, stderr }),
  );
}

test('(a) runSync inside a held lock does not block and leaves the outer hold in place', async () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const lockPath = join(dir, LOCK_FILE);
    await acquireLock(dir);
    const paths = await Promise.race([
      runSync(loadConfig({ backlogRoot: dir })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('runSync blocked')), 5000)),
    ]);
    assert.ok(Array.isArray(paths));
    assert.ok(existsSync(lockPath), 'inner release must not drop the outer hold');
    releaseLock(dir);
    assert.equal(existsSync(lockPath), false);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('(a) a bare bl sync releases the lock when it finishes', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(dir, LOCK_FILE)), false);
  } finally {
    cleanup();
  }
});

test('(b) bl sync waits for another holder of the lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const { dir, cleanup } = mkTempBacklog();
  try {
    await acquireLock(dir);
    let done = false;
    const run = startBlBehindLock(['sync'], { cwd: dir, env: GIT_ENV });
    const pending = run.closed.then((r) => {
      done = true;
      return r;
    });
    await run.blocked;
    assert.equal(done, false, 'bl sync ran while another process held the lock');
    releaseLock(dir);
    const r = await pending;
    assert.equal(r.status, 0, r.stderr);
  } finally {
    releaseLock(dir);
    cleanup();
  }
});

test('(b) overlapping sync --commit runs serialise with no torn index or index.lock error', async () => {
  const { dir, cleanup } = gitBacklog();
  try {
    setField(dir, S2, 'points', 5);
    setField(dir, S3, 'points', 8);
    const runs = await Promise.all([
      blAsync(['sync', '--commit', '-m', 'chore: two', '--story', 'S-2'], dir),
      blAsync(['sync', '--commit', '-m', 'chore: three', '--story', 'S-3'], dir),
    ]);
    for (const r of runs) {
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /index\.lock/);
    }
    const subjects = git(dir, 'log', '--format=%s').split('\n');
    assert.ok(subjects.includes('chore: two'));
    assert.ok(subjects.includes('chore: three'));
    // Everything is committed, and a fresh sync has nothing left to rewrite.
    assert.equal(git(dir, 'status', '--porcelain'), '');
    const again = runBl(['sync'], { cwd: dir });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    const componentIndex = readFileSync(join(dir, COMPONENT, 'index.md'), 'utf8');
    assert.match(componentIndex, /S-2.*\| 5 +\| backlog +\|$/m);
    assert.match(componentIndex, /S-3.*\| 8 +\| backlog +\|$/m);
  } finally {
    cleanup();
  }
});

test("(c) --commit stages sync's paths and the --story dirs, and moves no story", () => {
  const { dir, cleanup } = gitBacklog();
  try {
    setField(dir, S1, 'status', 'done');
    setField(dir, S2, 'status', 'refined');
    writeFileSync(join(dir, S2, 'notes.txt'), 'attachment\n');
    // Another agent edits S-3 during the lock hold: the .md format pass runs
    // while this sync holds the lock, so a formatter that edits S-3 stands in.
    const cfgPath = join(dir, 'backlog.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const s3 = join(dir, S3, 'index.md');
    cfg.plugins = { md: { format: `echo concurrent >> ${s3} # {{path}}` } };
    cfg.language_dispatch = { format: { '.md': 'md' } };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    git(dir, 'add', 'backlog.json');
    git(dir, 'commit', '-q', '-m', 'formatter');

    const r = runBl(['sync', '--commit', '-m', 'chore: refine S-2', '--story', 'S-2'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: refine S-2');
    const files = git(dir, 'show', '--name-status', '--no-renames', '--format=', 'HEAD').split('\n').sort();
    assert.ok(files.includes(`M\t${S2}/index.md`), files.join('\n'));
    assert.ok(files.includes(`A\t${S2}/notes.txt`));
    // The done story leaves the component's table; its directory stays put
    // (F-49 D3) and, not named with --story, out of the commit.
    assert.ok(files.includes(`M\t${COMPONENT}/index.md`));
    assert.doesNotMatch(readFileSync(join(dir, COMPONENT, 'index.md'), 'utf8'), /S-1/);
    assert.ok(existsSync(join(dir, S1, 'index.md')));
    assert.ok(!files.some((f) => f.includes('S1-done')), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('S3-bystander')), files.join('\n'));
    // S-3's concurrent edit is still there, uncommitted.
    assert.match(readFileSync(s3, 'utf8'), /concurrent/);
    assert.match(git(dir, 'status', '--porcelain'), /S3-bystander\/index\.md/);
  } finally {
    cleanup();
  }
});

test('(c) --commit leaves out a dirty index that this sync rewrites byte-for-byte', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    // An unrelated agent's uncommitted edit to a generated index: sync keeps
    // the prose outside its tables, so it rewrites the file unchanged.
    const otherIndex = join(dir, FROM, 'index.md');
    writeFileSync(otherIndex, readFileSync(otherIndex, 'utf8').replace('## Stories', 'Unrelated note.\n\n## Stories'));
    const seeded = runBl(['sync'], { cwd: dir });
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.match(readFileSync(otherIndex, 'utf8'), /Unrelated note\./);

    setField(dir, S2, 'points', 5);
    const r = runBl(['sync', '--commit', '-m', 'chore: points S-2', '--story', 'S-2'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);

    const files = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.ok(files.includes(`${S2}/index.md`), files.join('\n'));
    assert.ok(files.includes(`${COMPONENT}/index.md`), files.join('\n'));
    assert.ok(!files.includes(`${FROM}/index.md`), files.join('\n'));
    assert.match(git(dir, 'status', '--porcelain'), /components\/C02-other\/index\.md/);
  } finally {
    cleanup();
  }
});

test('(c) --commit with nothing to commit exits 0 without a commit', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl(['sync', '--commit', '-m', 'chore: noop', '--story', 'S-2'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    cleanup();
  }
});

test('--commit without -m or --story is a usage error', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    for (const args of [
      ['sync', '--commit', '--story', 'S-1'],
      ['sync', '--commit', '-m', 'chore: x'],
      ['sync', '-m', 'chore: x'],
      // S-872: a dropped (empty) -m is still -m without --commit.
      ['sync', '-m', ''],
    ]) {
      const r = runBl(args, { cwd: dir });
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    }
  } finally {
    cleanup();
  }
});

// S-872: repeated `-m` joins as subject plus body, as `git commit` does.

test('--commit with two -m commits the first as subject and the second as body', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    setField(dir, S2, 'points', 5);
    const r = runBl(['sync', '--commit', '-m', 'chore: subject', '-m', 'body line', '--story', 'S-2'], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: subject');
    assert.equal(git(dir, 'log', '-1', '--format=%b').trim(), 'body line');
  } finally {
    cleanup();
  }
});

test('--commit with only empty -m values is a usage error and commits nothing', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    setField(dir, S2, 'points', 5);
    const r = runBl(['sync', '--commit', '-m', '', '-m', '  ', '--story', 'S-2'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--commit needs -m <message>/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    cleanup();
  }
});

test('--commit rejects an unknown story', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const r = runBl(['sync', '--commit', '-m', 'chore: x', '--story', 'S-99'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /S-99 not found/);
  } finally {
    cleanup();
  }
});

test('syncAndCommit stages extraPaths: a vanished tracked path and a new untracked one', async () => {
  const { dir, cleanup } = gitBacklog();
  try {
    // Stand-in for an operator renaming a component's slug by hand.
    const from = FROM;
    const to = TO;
    renameSync(join(dir, from), join(dir, to));
    setField(dir, S3, 'points', 8);

    const res = await syncAndCommit(loadConfig({ backlogRoot: dir }), {
      message: 'chore: rename C02',
      extraPaths: [from, to],
    });
    assert.equal(res.committed, true, res.error);
    const files = git(dir, 'show', '--name-status', '--no-renames', '--format=', 'HEAD').split('\n');
    assert.ok(files.includes(`D\t${from}/index.md`), files.join('\n'));
    assert.ok(files.includes(`A\t${to}/index.md`), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('S3-bystander')), files.join('\n'));
    assert.match(git(dir, 'status', '--porcelain'), /S3-bystander\/index\.md/);
  } finally {
    cleanup();
  }
});

test('syncAndCommit reports notRepo instead of committing outside a git repo', async () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const res = await syncAndCommit(loadConfig({ backlogRoot: dir }), {
      message: 'chore: x',
    });
    assert.equal(res.committed, false);
    assert.equal(res.notRepo, true);
    const r = runBl(['sync', '--commit', '-m', 'chore: x', '--story', 'S-1'], {
      cwd: dir,
    });
    assert.equal(r.status, 1);
  } finally {
    cleanup();
  }
});

// S-837: `--path` stages a backlog-relative path the caller moved itself.

test('--commit --path commits both ends of a git mv done before the call', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const from = FROM;
    const to = TO;
    git(dir, 'mv', from, to);
    setField(dir, S2, 'points', 5);

    const r = runBl(['sync', '--commit', '-m', 'chore: rename C02', '--story', 'S-2', '--path', from, '--path', to], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: rename C02');

    const files = git(dir, 'show', '--name-status', '--no-renames', '--format=', 'HEAD').split('\n');
    assert.ok(files.includes(`D\t${from}/index.md`), files.join('\n'));
    assert.ok(files.includes(`A\t${to}/index.md`), files.join('\n'));
    assert.ok(files.includes(`M\t${S2}/index.md`), files.join('\n'));
    // The committed tree holds the component at its new path only.
    const tree = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    assert.ok(tree.includes(`${to}/index.md`), tree.join('\n'));
    assert.ok(!tree.includes(`${from}/index.md`), tree.join('\n'));
    assert.ok(!files.some((f) => f.includes('S3-bystander')), files.join('\n'));
  } finally {
    cleanup();
  }
});

// S-867: a feature file has no story to name, so the loop's prompts commit it
// with `--path` alone; another session's staged edit stays out.
test('--commit with --path and no --story commits that path and leaves staged work alone', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    setField(dir, S2, 'points', 5);
    setField(dir, S3, 'points', 8);
    git(dir, 'add', `${S3}/index.md`);
    const r = runBl(['sync', '--commit', '-m', 'chore: review note', '--path', `${S2}/index.md`], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: review note');
    const files = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.ok(files.includes(`${S2}/index.md`), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('S3-bystander')), files.join('\n'));
    // The bystander's staged edit is still staged, uncommitted.
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), `${S3}/index.md`);
  } finally {
    cleanup();
  }
});

test('--commit with neither --story nor --path is a usage error', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const r = runBl(['sync', '--commit', '-m', 'chore: x'], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /at least one --story <id> or --path <path>/);
  } finally {
    cleanup();
  }
});

test('--commit --path that matches nothing in the backlog is a usage error', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    setField(dir, S2, 'points', 5);
    const r = runBl(
      ['sync', '--commit', '-m', 'chore: typo', '--story', 'S-2', '--path', FROM, '--path', 'components/C09-typo'],
      { cwd: dir, env: GIT_ENV },
    );
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--path matches nothing.*components\/C09-typo/);
    assert.doesNotMatch(r.stderr, /C02-other/);
    // Nothing was synced or committed.
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    cleanup();
  }
});

test('--path without --commit is a usage error', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const r = runBl(['sync', '--path', 'components/C00'], { cwd: dir });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--path only apply with --commit/);
  } finally {
    cleanup();
  }
});

// S-837 review: `--path` is a git pathspec, so it must name one exact file or
// directory. Anything broader (the root, all of `stories/`, `components/`,
// `features/`, `themes/` or `epics/`, a glob, a magic pathspec, a path that climbs
// out of the backlog) would commit unrelated work.

test('--commit --path rejects broad or escaping paths without committing unrelated work', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    setField(dir, S2, 'points', 5);
    writeFileSync(join(dir, 'unrelated.txt'), 'operator work\n');
    const rejected = [
      // [input class, argv tail]
      ['root', ['--path', '.']],
      ['the whole themes directory', ['--path', 'themes']],
      ['the whole epics directory', ['--path', 'epics']],
      ['the whole features directory', ['--path', 'features']],
      ['the whole stories directory', ['--path', 'stories']],
      ['the whole components directory', ['--path', 'components']],
      ['escapes to the root', ['--path', 'components/C02-other/../..']],
      ['escapes above the backlog', ['--path', '../unrelated']],
      ['empty inline value', ['--path=']],
      ['empty value', ['--path', '']],
      ['dot segment', ['--path', './components/C02-other']],
      ['trailing slash', ['--path', 'components/C02-other/']],
      ['double slash', ['--path', 'components//C02-other']],
      ['absolute', ['--path', join(dir, 'components/C02-other')]],
      ['the git directory', ['--path', '.git']],
      ['inside the git directory', ['--path', '.git/config']],
      ['git magic pathspec', ['--path', ':(glob)**']],
      ['git top-level magic', ['--path', ':/components/C02-other']],
      ['glob', ['--path', 'components/C0*']],
      ['backslash escape', ['--path', 'components\\C02-other']],
    ];
    for (const [why, tail] of rejected) {
      const r = runBl(['sync', '--commit', '-m', 'chore: broad', '--story', 'S-2', ...tail], {
        cwd: dir,
        env: GIT_ENV,
      });
      assert.equal(r.status, 2, `${why} (${tail.join(' ')}): exit ${r.status}\n${r.stderr}`);
      // The broad-path refusal, not the older "matches nothing" one, which
      // already caught paths that are not on disk or in git.
      assert.match(
        r.stderr,
        /^--path ".*" .+; name one exact backlog-relative file or directory\.$/m,
        `${why}: ${r.stderr}`,
      );
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, `${why}: committed`);
    }
    // Nothing was synced or committed: the edit and the operator's file wait.
    const status = git(dir, 'status', '--porcelain');
    assert.match(status, /unrelated\.txt/);
    assert.match(status, /S2-edited\/index\.md/);
  } finally {
    cleanup();
  }
});

test('--commit --path accepts repeated, existing and vanished-tracked paths and commits only them', () => {
  const { dir, cleanup } = gitBacklog();
  try {
    const from = FROM;
    const to = TO;
    git(dir, 'mv', from, to);
    writeFileSync(join(dir, 'notes.txt'), 'renamed C02\n');
    writeFileSync(join(dir, 'unrelated.txt'), 'operator work\n');
    setField(dir, S2, 'points', 5);

    const r = runBl(
      [
        'sync',
        '--commit',
        '-m',
        'chore: rename C02',
        '--story',
        'S-2',
        '--path',
        from, // vanished, tracked in HEAD
        '--path',
        to, // existing directory
        '--path',
        to, // repeated
        '--path',
        'notes.txt', // existing untracked file
      ],
      { cwd: dir, env: GIT_ENV },
    );
    assert.equal(r.status, 0, r.stderr);
    const files = headFiles(dir);
    assert.ok(files.includes(`D\t${from}/index.md`), files.join('\n'));
    assert.ok(files.includes(`A\t${to}/index.md`), files.join('\n'));
    assert.ok(files.includes('A\tnotes.txt'), files.join('\n'));
    assert.ok(files.includes(`M\t${S2}/index.md`), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('unrelated.txt')), files.join('\n'));
    assert.match(git(dir, 'status', '--porcelain'), /unrelated\.txt/);
  } finally {
    cleanup();
  }
});
