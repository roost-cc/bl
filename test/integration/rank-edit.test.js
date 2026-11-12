import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { git } from '../helpers/git-backlog.js';
import { HAND, backlog, bl, list, originHead, read } from '../helpers/rank-fixture.js';

test('bl rank places a new unit, pulls first, commits priority.yaml alone and pushes it', () => {
  const dir = backlog();
  // Someone else pushes a commit first: bl rank must pull it before committing.
  const other = mkTempDir('bl-rank-other-');
  git(other, 'clone', '-q', git(dir, 'remote', 'get-url', 'origin'), 'c');
  const clone = join(other, 'c');
  writeFileSync(join(clone, 'note.txt'), 'from the other clone\n');
  git(clone, 'add', 'note.txt');
  git(clone, 'commit', '-q', '-m', 'other: note');
  git(clone, 'push', '-q', 'origin', 'main');

  const r = bl(['rank', 'F-1', '--before', 'F-2'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('S-1', 'F-1', 'F-2'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-1 ranked before F-2 in priority.yaml');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.yaml');
  // The pull came first.
  assert.ok(git(dir, 'log', '--format=%s', 'HEAD~1').split('\n').includes('other: note'), 'pulled before committing');
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
});

test('each bl rank form moves or removes its id; a no-op commits nothing', () => {
  const dir = backlog();

  let r = bl(['rank', 'F-2', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('F-2', 'S-1'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-2 ranked first in priority.yaml');

  r = bl(['rank', 'F-2', '--bottom'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('S-1', 'F-2'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-2 ranked last in priority.yaml');

  r = bl(['rank', 'S-1', '--after', 'F-2'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('F-2', 'S-1'));

  r = bl(['rank', 'S-1', '--remove'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('F-2'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: S-1 unranked in priority.yaml');

  const before = git(dir, 'rev-parse', 'HEAD');
  r = bl(['rank', 'F-2', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /F-2 is already there; priority\.yaml is unchanged/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before, 'nothing committed');
  assert.equal(originHead(dir), before, 'every commit pushed');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('rank_failed_commit_retry_finishes_or_reports_pending_change', () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho injected-commit-failure >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const args = ['rank', 'F-1', '--top'];

  // The commit fails after the write: reported, nothing committed.
  let r = bl(args, dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /backlog commit failed: injected-commit-failure/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  const written = read(dir);
  assert.equal(written, list('F-1', 'S-1', 'F-2'));

  // A retry that still cannot commit says so again; it never reports success.
  r = bl(args, dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not committed; committing it[\s\S]*backlog commit failed/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  // Once the commit can go through, the retry commits the requested ranking.
  unlinkSync(hook);
  r = bl(args, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), written);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-1 ranked first in priority.yaml');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.yaml');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');

  // With nothing pending, the same command is a no-op again.
  const done = git(dir, 'rev-parse', 'HEAD');
  r = bl(args, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /F-1 is already there; priority\.yaml is unchanged/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), done);
});

test('rank_noop_preserves_unrelated_dirty_priority', () => {
  // Each case: someone else's uncommitted edit to priority.yaml, then a bl
  // rank that is a no-op (noop) or would change the file (change). Neither
  // commits the edit; a change is refused with nothing written.
  const note = (t) => `${t}# Operator note.\n`;
  const added = (t) => t.replace('- F-2', '- F-1\n- F-2');
  const cases = [
    { name: 'unstaged comment', edit: note },
    { name: 'staged comment', edit: note, stage: true },
    { name: 'another id added', edit: added },
    { name: 'another id added, staged', edit: added, stage: true },
  ];
  const ops = [
    { kind: 'noop', args: ['rank', 'S-1', '--top'] },
    { kind: 'noop', args: ['rank', 'F-2', '--bottom'] },
    { kind: 'change', args: ['rank', 'F-2', '--top'] },
    { kind: 'change', args: ['rank', 'F-1', '--bottom'] },
  ];
  // Staged edits under a work tree that matches HEAD, or that holds the very
  // write the op makes: the commit's add would overwrite the staged edit.
  const rankF1 = ['rank', 'F-1', '--top'];
  const stagedOnly = [
    { name: 'staged comment, work tree as HEAD', staged: note, args: ['rank', 'S-1', '--top'] },
    {
      name: "staged other edit under the op's write",
      staged: note,
      work: () => list('F-1', 'S-1', 'F-2'),
      args: rankF1,
    },
  ];
  for (const c of stagedOnly) {
    const label = c.name;
    const dir = backlog();
    const head = git(dir, 'rev-parse', 'HEAD');
    const original = read(dir);
    writeFileSync(join(dir, 'priority.yaml'), c.staged(original));
    git(dir, 'add', 'priority.yaml');
    const edited = c.work ? c.work(original) : original;
    writeFileSync(join(dir, 'priority.yaml'), edited);
    const status = git(dir, 'status', '--porcelain');
    const index = git(dir, 'show', ':priority.yaml');
    const r = bl(c.args, dir);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.match(r.stderr, /other uncommitted edits, left uncommitted/, label);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, `${label}: nothing committed`);
    assert.equal(read(dir), edited, `${label}: the work tree is as it was`);
    assert.equal(git(dir, 'show', ':priority.yaml'), index, `${label}: the staged edit is as it was`);
    assert.equal(git(dir, 'status', '--porcelain'), status, label);
  }

  for (const c of cases) {
    for (const op of ops) {
      const label = `${c.name} / ${op.args.join(' ')}`;
      const dir = backlog();
      const head = git(dir, 'rev-parse', 'HEAD');
      const edited = c.edit(read(dir));
      writeFileSync(join(dir, 'priority.yaml'), edited);
      if (c.stage) git(dir, 'add', 'priority.yaml');
      const status = git(dir, 'status', '--porcelain');
      const r = bl(op.args, dir);
      assert.equal(r.status, op.kind === 'noop' ? 0 : 1, `${label}: ${r.stderr}`);
      if (op.kind === 'noop') assert.match(r.stderr, /other uncommitted edits, left uncommitted/, label);
      else assert.match(r.stderr, /has uncommitted edits; commit or discard them first/, label);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, `${label}: nothing committed`);
      assert.equal(originHead(dir), head, `${label}: nothing pushed`);
      assert.equal(read(dir), edited, `${label}: the edit is as it was`);
      assert.equal(git(dir, 'status', '--porcelain'), status, `${label}: staged state as it was`);
    }
  }

  // An operator edit on top of a failed rank commit's write: the retry
  // leaves both uncommitted rather than commit the operator's edit.
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  assert.equal(bl(rankF1, dir).status, 1);
  unlinkSync(hook);
  writeFileSync(join(dir, 'priority.yaml'), note(read(dir)));
  const r = bl(rankF1, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /other uncommitted edits, left uncommitted/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('bl rank refuses what is not an open unit, a bad target and --why, writing nothing', () => {
  const dir = backlog();
  const cases = [
    [['S-11', '--top'], /S-11 is a story inside F-1; the feature is the unit: rank F-1/],
    [['T-3', '--top'], /T-3 is a task/],
    [['S-77', '--top'], /S-77 names no story under stories\//],
    [['F-5', '--top'], /F-5 is done; only open units are ranked/],
    [['S-2', '--before', 'F-1'], /F-1 is not ranked; rank it first/],
    [['S-2', '--remove'], /S-2 is not ranked/],
    [['S-1', '--top', '--bottom'], /alternatives; give one/],
    [['S-1', '--remove', '--top'], /--remove takes no position/],
    [['S-1', '--before', 'S-1'], /beside itself/],
    [['S-1'], /give a position/],
    // F-113 D2: the file holds no reasons, so there is no --why.
    [['S-1', '--why', 'x'], /Unknown option '--why'/],
    [['S-2', '--top', '--why', 'x'], /Unknown option '--why'/],
  ];
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const [args, message] of cases) {
    const r = bl(['rank', ...args], dir);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(read(dir), HAND, args.join(' '));
  }
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});
