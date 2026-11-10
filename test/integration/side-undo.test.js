import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { findExistingWorktree } from '../../src/story.js';
import { runBl } from '../helpers/run-bl.js';
import { git, statusLines } from '../helpers/git-backlog.js';
import { FAULTS, build, fmOf, members, sideWithFaults, storyDirs } from '../helpers/side-fixture.js';

test("side_failure_and_concurrent_sync_preserve_unit_consistency: bl new writes the story under bl side's backlog lock", () => {
  for (const from of ['F-1', 'S-3']) {
    const { tmp, dir } = build();
    const out = join(tmp, 'lock.json');
    const r = sideWithFaults(dir, from, 'lock', { BL_SIDE_FAULT_OUT: out });
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(readFileSync(out, 'utf8'));
    // The lock file names bl new's parent, bl side, not bl new itself: no
    // other bl can commit between the story's creation and bl side's commit.
    assert.equal(seen.holder, seen.ppid, from);
    assert.notEqual(seen.holder, seen.pid, from);
    assert.equal(existsSync(join(dir, '.bl-new.lock')), false, `${from}: released at the end`);
  }
});

test('side_failure_and_concurrent_sync_preserve_unit_consistency: a failed bl side undoes its story before it lets go of the backlog lock', () => {
  for (const from of ['F-1', 'S-3']) {
    const { tmp, dir } = build();
    const out = join(tmp, 'undo.json');
    const r = sideWithFaults(dir, from, 'mark,undo-lock', { BL_SIDE_FAULT_OUT: out });
    assert.equal(r.status, 1, r.stderr);
    // Released first, another bl could commit the half-made story in between.
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { locked: true }, from);
    assert.equal(
      storyDirs(dir).find((d) => d.startsWith('S4-')),
      undefined,
      `${from}: no story left`,
    );
    assert.equal(existsSync(join(dir, '.bl-new.lock')), false, `${from}: released at the end`);
  }
});

// side_body_refusals_leave_no_partial_state: a body bl new would refuse is
// refused by bl side before any worktree, story or commit.
test('side_body_refusals_leave_no_partial_state: a bad --body-file is refused before anything is written', () => {
  const { tmp, dir, repos, mainBranches } = build();
  const withFm = join(tmp, 'fm.md');
  writeFileSync(withFm, '---\ntitle: x\n---\n\n## Summary\n');
  const unreadable = join(tmp, 'locked.md');
  writeFileSync(unreadable, '## Summary\n');
  chmodSync(unreadable, 0o000);
  const asDir = join(tmp, 'a-dir');
  mkdirSync(asDir);
  const cases = [
    { name: 'frontmatter', file: withFm, error: /--body-file contains frontmatter/ },
    { name: 'directory', file: asDir, error: /--body-file .* could not be read: EISDIR/ },
    { name: 'missing', file: join(tmp, 'nope.md'), error: /--body-file .* not found/ },
    { name: 'stdin with frontmatter', file: '-', input: '---\na: b\n---\n', error: /--body-file contains frontmatter/ },
  ];
  // Root reads a 000 file; the case only holds for an ordinary user.
  if (process.getuid?.() !== 0)
    cases.push({ name: 'unreadable', file: unreadable, error: /--body-file .* could not be read: EACCES/ });
  const stories = storyDirs(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  try {
    for (const c of cases) {
      for (const from of ['F-1', 'S-3']) {
        const r = runBl(['side', 'repoB', '--from', from, '--title', 'T', '--points', '1', '--body-file', c.file], {
          cwd: dir,
          ...(c.input != null ? { input: c.input } : {}),
        });
        const label = `${c.name}, --from ${from}`;
        assert.equal(r.status, 1, `${label}: ${r.stderr}`);
        assert.match(r.stderr, c.error, label);
        assert.doesNotMatch(r.stderr, /nothing else was written/, label);
        assert.deepEqual(storyDirs(dir), stories, label);
        assert.equal(git(dir, 'rev-parse', 'HEAD'), head, label);
        assert.deepEqual(statusLines(dir), [], label);
        assert.equal(findExistingWorktree(repos.repoB, 'f1-run'), null, `${label}: no worktree`);
      }
    }
  } finally {
    chmodSync(unreadable, 0o644);
  }
  assert.equal(existsSync(join(tmp, 'worktrees')), false);
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });

  // A good body on stdin reaches the story.
  const ok = runBl(['side', 'repoB', '--from', 'F-1', '--title', 'T', '--points', '1', '--body-file', '-', '--json'], {
    cwd: dir,
    input: '## Summary\n\nFrom stdin.\n',
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(dir, JSON.parse(ok.stdout).path), 'utf8'), /From stdin\./);
});

// failed_side_must_preserve_worktree_adopted_by_successful_caller: a failed
// bl side removes a worktree it made only while nobody has taken it up; one a
// concurrent bl side committed a story to stays, with its branch and the work
// in it, and a bl side whose worktree went while it waited writes nothing.
test('failed_side_must_preserve_worktree_adopted_by_successful_caller: the worktree, its branch and its work stay', () => {
  const { tmp, dir, repos } = build();
  const out = join(tmp, 'second.json');
  const r = sideWithFaults(dir, 'F-1', 'adopt,mark', { BL_SIDE_FAULT_OUT: out });
  assert.equal(r.status, 1, r.stderr);
  const second = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(second.status, 0, second.stderr);
  const survivor = JSON.parse(second.stdout);
  assert.equal(survivor.story, 'S-4');
  // The second caller's unit is whole and committed; the first's story is gone.
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-4 (bl side, found by F-1)');
  assert.deepEqual(
    storyDirs(dir).filter((d) => /^S[45]-/.test(d)),
    ['S4-survivor'],
  );
  assert.deepEqual(members(dir, 'F-1'), ['S-1', 'S-4']);
  assert.deepEqual(
    fmOf(join(dir, 'features', 'F1-run', 'change.md')).repos.map((e) => e.repo),
    ['repoA', 'repoB'],
  );
  assert.deepEqual(statusLines(dir), []);
  // Its worktree, branch and uncommitted work stay.
  assert.equal(findExistingWorktree(repos.repoB, 'f1-run')?.path, survivor.worktree);
  assert.equal(readFileSync(join(survivor.worktree, 'uncommitted.txt'), 'utf8'), "the second caller's work\n");
  assert.match(git(repos.repoB, 'branch', '--list', 'f1-run'), /f1-run/);
});

test('failed_side_must_preserve_worktree_adopted_by_successful_caller: a worktree removed while bl side waited for the lock stops it before anything is written', () => {
  const { tmp, dir, repos } = build();
  const head = git(dir, 'rev-parse', 'HEAD');
  const stories = storyDirs(dir);
  const r = sideWithFaults(dir, 'F-1', 'gone', { BL_SIDE_FAULT_REPO: repos.repoB, BL_SIDE_FAULT_BRANCH: 'f1-run' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the worktree on f1-run in repoB was removed while bl side waited for the backlog lock/);
  assert.deepEqual(storyDirs(dir), stories);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(existsSync(join(tmp, 'worktrees', 'f1-run', 'repoB')), false);
});

// markSideStory goes through updateSpecFile (F-67 S-1102): a write that fails
// part way leaves the story bl new wrote, whole, and no staging file.
const PARTIAL = fileURLToPath(new URL('../helpers/partial-write-preload.js', import.meta.url));

test('a failed markSideStory write leaves the previous story file and no staging file', () => {
  const { dir } = build();
  const storyPath = join(dir, 'stories', 'S4-partial', 'index.md');
  const featureBefore = readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8');
  // `undo` keeps the story directory, so the file the failed write left is there to read.
  const r = sideWithFaults(dir, 'F-1', 'undo', {
    NODE_OPTIONS: `--import=${FAULTS} --import=${PARTIAL}`,
    BL_PARTIAL_WRITE_VERB: 'side',
    BL_PARTIAL_WRITE_TARGET: storyPath,
    BL_PARTIAL_WRITE_MATCH: 'found_by:',
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ENOSPC/);
  const fm = fmOf(storyPath);
  assert.deepEqual([fm.story_id, fm.status, fm.found_by], ['S-4', 'draft', undefined], 'the story as bl new wrote it');
  const tmpDir = join(dir, '.bl', 'tmp');
  assert.deepEqual(
    existsSync(tmpDir) ? readdirSync(tmpDir).filter((f) => f.startsWith('index.md.')) : [],
    [],
    'no staging file left',
  );
  assert.equal(
    readFileSync(join(dir, 'features', 'F1-run', 'index.md'), 'utf8'),
    featureBefore,
    'the feature is put back',
  );
});
