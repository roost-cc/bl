/**
 * Integration tests for `bl rank` (F-78 D3) against a git backlog with an
 * origin: each form edits only its entry, pulls first, commits priority.md
 * alone and pushes; the refusals; the listing; and BL_HEADLESS, under which
 * neither `bl rank` nor a backlog commit of priority.md goes through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV, addOrigin, git, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';

const bl = (args, cwd, env = {}) => runBl(args, { cwd, env: { ...GIT_ENV, ...env } });

/** A hand-written priority.md: comments, a wrapped reason, a body. */
const HAND = `---
# Ranked by hand.
ranked:
  # The deploy blocker first.
  - unit: S-1
    why: Blocks every deploy,
      wrapped by hand.
  - unit: F-2 # the big one
    why: "Users see it next"
---

# Priority

Hand-written body.
`;

/**
 * F-1 and F-2 open (S-11 inside F-1), F-5 done, loose S-1 and S-2 open, S-9
 * done; the backlog committed and pushed to a bare origin.
 */
function backlog() {
  const story = (id, extra = {}) => ({ id, component: 'C01', title: `Story ${id}`, ...extra });
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      story('S-1', { added: '2026-01-02' }),
      story('S-2', { added: '2026-01-03' }),
      story('S-9', { status: 'done' }),
      story('S-11', { feature: 'F-1' }),
      story('S-15', { feature: 'F-5', status: 'done' }),
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', added: '2026-01-01' },
      { id: 'F-2', title: 'Two', status: 'draft', added: '2026-01-04' },
      { id: 'F-5', title: 'Five', status: 'done', added: '2026-01-01' },
    ],
    priority: HAND,
  });
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

const read = (dir) => readFileSync(join(dir, 'priority.md'), 'utf8');
const originHead = (dir) => git(git(dir, 'remote', 'get-url', 'origin'), 'rev-parse', 'main');

test('bl rank places a new unit, pulls first, commits priority.md alone and pushes it', () => {
  const dir = backlog();
  // Someone else pushes a commit first: bl rank must pull it before committing.
  const other = mkTempDir('bl-rank-other-');
  git(other, 'clone', '-q', git(dir, 'remote', 'get-url', 'origin'), 'c');
  const clone = join(other, 'c');
  writeFileSync(join(clone, 'note.txt'), 'from the other clone\n');
  git(clone, 'add', 'note.txt');
  git(clone, 'commit', '-q', '-m', 'other: note');
  git(clone, 'push', '-q', 'origin', 'main');

  const r = bl(['rank', 'F-1', '--before', 'F-2', '--why', 'Needed: before F-2'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), HAND.replace('  - unit: F-2', '  - unit: F-1\n    why: "Needed: before F-2"\n  - unit: F-2'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-1 ranked before F-2 in priority.md');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.md');
  // The pull (and the index regeneration it commits) came first.
  assert.ok(git(dir, 'log', '--format=%s', 'HEAD~1').split('\n').includes('other: note'), 'pulled before committing');
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
});

test('each bl rank form changes only its entry; --why alone rewrites a reason; a no-op commits nothing', () => {
  const dir = backlog();
  const S1 = '  - unit: S-1\n    why: Blocks every deploy,\n      wrapped by hand.\n';
  const F2 = '  - unit: F-2 # the big one\n    why: "Users see it next"\n';
  const head = '---\n# Ranked by hand.\nranked:\n  # The deploy blocker first.\n';
  const body = '---\n\n# Priority\n\nHand-written body.\n';

  let r = bl(['rank', 'F-2', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), `${head}${F2}${S1}${body}`);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-2 ranked first in priority.md');

  r = bl(['rank', 'F-2', '--bottom'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), HAND);

  r = bl(['rank', 'S-1', '--after', 'F-2'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), `${head}${F2}${S1}${body}`);

  r = bl(['rank', 'S-1', '--why', 'Smaller now'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), `${head}${F2}  - unit: S-1\n    why: Smaller now\n${body}`);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: S-1 reason rewritten in priority.md');

  r = bl(['rank', 'S-1', '--remove'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), `${head}${F2}${body}`);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: S-1 unranked in priority.md');

  const before = git(dir, 'rev-parse', 'HEAD');
  r = bl(['rank', 'F-2', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /F-2 is already there; priority\.md is unchanged/);
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
  const args = ['rank', 'F-1', '--top', '--why', 'First'];

  // The commit fails after the write: reported, nothing committed.
  let r = bl(args, dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /backlog commit failed: injected-commit-failure/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  const written = read(dir);
  assert.match(written, /unit: F-1\n {4}why: First/);

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
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-1 ranked first in priority.md');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.md');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');

  // With nothing pending, the same command is a no-op again.
  const done = git(dir, 'rev-parse', 'HEAD');
  r = bl(args, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /F-1 is already there; priority\.md is unchanged/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), done);
});

test('bl rank refuses what is not an open unit, a new unit without --why, and a bad target, writing nothing', () => {
  const dir = backlog();
  const cases = [
    [['S-11', '--top', '--why', 'x'], /S-11 is a story inside F-1; the feature is the unit: rank F-1/],
    [['T-3', '--top', '--why', 'x'], /T-3 is a task/],
    [['S-77', '--top', '--why', 'x'], /S-77 names no story under stories\//],
    [['F-5', '--top', '--why', 'x'], /F-5 is done; only open units are ranked/],
    [['S-2', '--top'], /S-2 is not ranked yet; give --why <reason>/],
    [['S-2', '--why', 'x'], /S-2 is not ranked; give a position/],
    [['S-2', '--before', 'F-1', '--why', 'x'], /F-1 is not ranked; rank it first/],
    [['S-2', '--remove'], /S-2 is not ranked/],
    [['S-1', '--top', '--bottom'], /alternatives; give one/],
    [['S-1', '--remove', '--why', 'x'], /--remove takes no position and no --why/],
    [['S-1', '--before', 'S-1'], /beside itself/],
    [['S-1'], /give a position/],
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

test('bl rank with no arguments prints the ranked units, then the unranked tail oldest first', () => {
  const dir = backlog();
  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      'Ranked:',
      '  1. S-1  Story S-1 — Blocks every deploy, wrapped by hand.',
      '  2. F-2  Two — Users see it next',
      'Not yet ranked, oldest first:',
      '  F-1  One  (added 2026-01-01)',
      '  S-2  Story S-2  (added 2026-01-03)',
      '',
    ].join('\n'),
  );
});

test('under BL_HEADLESS bl rank refuses with nothing written, and so does a backlog commit of priority.md', () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const headless = { BL_HEADLESS: '1' };
  let r = bl(['rank', 'F-1', '--top', '--why', 'x'], dir, headless);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /BL_HEADLESS is set: .*only the operator or an interactive session ranks work\. Nothing was written/,
  );
  assert.equal(read(dir), HAND);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  // Reading the order is allowed.
  assert.equal(bl(['rank'], dir, headless).status, 0);

  // A hand edit cannot be committed through bl sync --commit either.
  writeFileSync(join(dir, 'priority.md'), HAND.replace('Hand-written body.', 'Edited by an agent.'));
  r = bl(['sync', '--commit', '-m', 'chore: rank by hand', '--path', 'priority.md'], dir, headless);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to commit priority\.md .*BL_HEADLESS is set/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  // The operator, without the marker, can.
  r = bl(['sync', '--commit', '-m', 'chore: rank by hand', '--path', 'priority.md'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.md');
});
