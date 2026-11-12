import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { acquireLock, releaseLock } from '../../src/lock.js';
import { STAGED_CONFLICT, STAGED_FILE } from '../../src/priority.js';
import { NO_TERMINAL } from '../../src/rank-cmd.js';
import { GIT_ENV, git } from '../helpers/git-backlog.js';
import { startBlBehindLock } from '../helpers/run-bl.js';
import {
  CLOSED,
  HAND,
  TTY,
  backlog,
  base,
  bl,
  list,
  originHead,
  pushPriority,
  read,
  staged,
} from '../helpers/rank-fixture.js';

const SUBJECT = 'chore: commit the staged order of priority.yaml';

/** The env under which bl asks in a terminal and a file changes at the question (`on-question.js`). */
const ON_QUESTION = {
  NODE_OPTIONS: `--import=${fileURLToPath(new URL('../helpers/on-question.js', import.meta.url))}`,
};

/** Stage `S-2` between S-1 and F-2 while main puts F-1 there: the two edits conflict. */
function conflicted() {
  const dir = backlog(list('S-1', 'F-2'));
  assert.equal(bl(['rank', 'S-2', '--after', 'S-1'], dir).status, 0);
  pushPriority(dir, list('S-1', 'F-1', 'F-2'));
  return dir;
}

test('two edits then --commit make one commit of priority.yaml alone, without closed units, and delete both copies; bl next reads the committed order until then', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const next = () => bl(['next'], dir).stdout;
  const before = next();

  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  assert.equal(bl(['rank', 'S-2', '--before', 'F-2'], dir).status, 0);
  assert.equal(next(), before, 'a staged edit changes no pick');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  const r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl rank: took out F-5, S-9 \(done\)\./);
  assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1', 'one commit');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), `${SUBJECT}; F-5, S-9 out (done)`);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.yaml');
  assert.equal(read(dir), list('F-1', 'S-1', 'S-2', 'F-2'));
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
  assert.equal(staged(dir), null);
  assert.equal(base(dir), null);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.notEqual(next(), before, 'the committed order picks now');
});

test('--commit with no staged copy exits 0 and prints nothing', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(read(dir), CLOSED, 'nothing staged: no closed unit taken out either');
});

test('rank commit with no staged copy skips pull', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  pushPriority(dir, list('F-1', 'S-1', 'F-2'));
  const r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'origin moved, nothing pulled');
  assert.equal(read(dir), CLOSED);
});

test('rank commit reloads work units after lock and answer', async () => {
  const s2 = (dir) => join(dir, 'stories', 'S2', 'index.md');
  const closedText = (dir) => readFileSync(s2(dir), 'utf8').replace(/^status: .*$/m, 'status: done');

  // A clean merge: S-2 closes while --commit waits for the backlog lock. No
  // origin, so the wait is the merge's own, not the pull's.
  let dir = backlog(list('S-1', 'F-2'));
  assert.equal(bl(['rank', 'S-2', '--after', 'S-1'], dir).status, 0);
  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  git(dir, 'remote', 'remove', 'origin');
  await acquireLock(dir);
  let run;
  try {
    run = startBlBehindLock(['rank', '--commit'], { cwd: dir, env: GIT_ENV });
    await run.blocked;
    writeFileSync(s2(dir), closedText(dir));
  } finally {
    releaseLock(dir);
  }
  const waited = await run.closed;
  assert.equal(waited.status, 0, waited.stderr);
  assert.match(waited.stderr, /took out S-2 \(done\)/);
  assert.equal(read(dir), list('F-1', 'S-1', 'F-2'), 'lock wait: S-2 out');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), `${SUBJECT}; S-2 out (done)`);

  // A conflict: S-2 closes while the operator answers y.
  dir = conflicted();
  const r = bl(
    ['rank', '--commit'],
    dir,
    { ...ON_QUESTION, BL_TEST_ON_QUESTION_FILE: s2(dir), BL_TEST_ON_QUESTION_TEXT: closedText(dir) },
    'y\n',
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /S-2/, 'S-2 was open when the proposal was shown');
  assert.match(r.stderr, /took out S-2 \(done\)/);
  assert.equal(read(dir), list('S-1', 'F-2', 'F-1'), 'answer: S-2 out');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), `${SUBJECT}; S-2 out (done)`);
});

test('rank commit refuses invalid staged work units', () => {
  const dir = backlog(list('S-1', 'F-2'));
  // S-20: an update story.
  const s2 = readFileSync(join(dir, 'stories', 'S2', 'index.md'), 'utf8');
  mkdirSync(join(dir, 'stories', 'S20'));
  writeFileSync(
    join(dir, 'stories', 'S20', 'index.md'),
    s2.replace('story_id: S-2', 'story_id: S-20').replace(/^status:/m, 'update_repo: bl\nstatus:'),
  );
  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const [bad, why] of [
    ['garbage', /entry 2 \(garbage\) is not a feature \(F-<n>\) or story \(S-<n>\) id/],
    ['F-9', /entry 2 \(F-9\) names no feature under features\//],
    ['S-99', /entry 2 \(S-99\) names no story under stories\//],
    ['T-1', /entry 2 \(T-1\) names a task/],
    ['S-11', /entry 2 \(S-11\) is a story inside F-1/],
    ['S-20', /entry 2 \(S-20\) is an update story/],
  ]) {
    const text = list('F-1', bad, 'S-1', 'F-2');
    writeFileSync(join(dir, STAGED_FILE), text);
    const r = bl(['rank', '--commit'], dir);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, why, bad);
    assert.match(r.stderr, /Nothing was committed\.$/m, bad);
    assert.equal(read(dir), list('S-1', 'F-2'), bad);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, bad);
    assert.equal(staged(dir), text, `${bad}: the staged copy stays`);
  }

  // A proposal on a conflict is checked too, before the question.
  const conflict = conflicted();
  writeFileSync(join(conflict, STAGED_FILE), list('S-1', 'garbage', 'S-2', 'F-2'));
  const r = bl(['rank', '--commit'], conflict, TTY, 'y\n');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\(garbage\) is not a feature/);
  assert.doesNotMatch(r.stderr, /\[y\/n\]/);
  assert.equal(read(conflict), list('S-1', 'F-1', 'F-2'));

  // A second entry of a unit is no refusal: it is dropped.
  writeFileSync(join(dir, STAGED_FILE), list('F-1', 'S-1', 'F-1', 'F-2'));
  const dup = bl(['rank', '--commit'], dir);
  assert.equal(dup.status, 0, dup.stderr);
  assert.equal(read(dir), list('F-1', 'S-1', 'F-2'));
});

test('--commit pulls first and merges a change on main cleanly', () => {
  const dir = backlog(list('S-1', 'F-2'));
  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  // Another workstation adds S-2 at the end: no line the staged edit changed.
  pushPriority(dir, list('S-1', 'F-2', 'S-2'));
  const r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('F-1', 'S-1', 'F-2', 'S-2'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), SUBJECT);
  assert.ok(git(dir, 'log', '--format=%s', 'HEAD~1').split('\n').includes('other: rank'), 'pulled before the merge');
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
  assert.equal(staged(dir), null);
});

test('--commit of a staged order that is already main commits nothing and drops the copies', () => {
  const dir = backlog();
  assert.equal(bl(['rank', 'F-2', '--top'], dir).status, 0);
  assert.equal(bl(['rank', 'S-1', '--top'], dir).status, 0);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /already; dropped the staged edits/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(read(dir), HAND);
  assert.equal(staged(dir), null);
  assert.equal(base(dir), null);
});

test('a conflict with no terminal changes nothing and exits 1 with the conflict line last', () => {
  const dir = conflicted();
  const before = [staged(dir), base(dir)];
  const r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.trim().split('\n').at(-1), NO_TERMINAL);
  assert.equal(NO_TERMINAL, 'conflict: run bl rank --commit in a terminal');
  assert.deepEqual([staged(dir), base(dir)], before);
  assert.equal(read(dir), list('S-1', 'F-1', 'F-2'), "main's file, pulled");
  assert.doesNotMatch(git(dir, 'log', '--format=%s'), new RegExp(SUBJECT), 'nothing committed');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a conflict in a terminal proposes the staged order plus what main added, and y commits it', () => {
  const dir = conflicted();
  const r = bl(['rank', '--commit'], dir, TTY, 'y\n');
  assert.equal(r.status, 0, r.stderr);
  // The proposal, marked against main's order (S-1, F-1, F-2): S-2 is new,
  // and F-1, which main added, comes last.
  assert.equal(
    r.stdout,
    [
      'Proposed order (the staged order, less what main took out, plus what main added):',
      '  1. S-1  Story S-1',
      '+ 2. S-2  Story S-2',
      '  3. F-2  Two',
      '~ 4. F-1  One',
      '',
    ].join('\n'),
  );
  assert.match(r.stderr, /Commit this order to priority\.yaml\? \[y\/n\]/);
  assert.equal(read(dir), list('S-1', 'S-2', 'F-2', 'F-1'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), SUBJECT);
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
  assert.equal(staged(dir), null);
  assert.equal(base(dir), null);
});

test("a conflict answered n writes git's markers into the staged copy and main as the base; the edited copy then commits", () => {
  const dir = conflicted();
  const main = list('S-1', 'F-1', 'F-2');
  let r = bl(['rank', '--commit'], dir, TTY, 'n\n');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`${STAGED_CONFLICT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n$`));
  assert.match(staged(dir), /^<<<<<<< staged$[\s\S]*^=======$[\s\S]*^>>>>>>> main$/m);
  assert.equal(base(dir), main, "main's priority.yaml is the base now");
  assert.equal(read(dir), main, 'priority.yaml is as main has it');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.doesNotMatch(git(dir, 'log', '--format=%s'), new RegExp(SUBJECT), 'nothing committed');

  // In conflict: every command but --reset refuses.
  r = bl(['rank'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /merge conflict in \.bl\/priority\.staged\.yaml/);

  // The operator edits the copy; --commit merges it as usual.
  writeFileSync(join(dir, STAGED_FILE), list('S-1', 'F-1', 'S-2', 'F-2'));
  r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('S-1', 'F-1', 'S-2', 'F-2'));
  assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), SUBJECT);
  assert.equal(staged(dir), null);
});

test('--commit refuses while priority.yaml has uncommitted edits; a failed commit keeps the copies for a retry', () => {
  const dir = backlog();
  assert.equal(bl(['rank', 'F-1', '--top'], dir).status, 0);
  const head = git(dir, 'rev-parse', 'HEAD');

  writeFileSync(join(dir, 'priority.yaml'), `${HAND}# Operator note.\n`);
  let r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /priority\.yaml has uncommitted edits; commit or discard them first/);
  assert.equal(read(dir), `${HAND}# Operator note.\n`);
  git(dir, 'checkout', '-q', '--', 'priority.yaml');

  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho injected-commit-failure >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /backlog commit failed: injected-commit-failure/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(read(dir), HAND, 'priority.yaml back as HEAD has it');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'index and work tree clean');
  assert.equal(staged(dir), list('F-1', 'S-1', 'F-2'), 'the staged copy stays');

  unlinkSync(hook);
  r = bl(['rank', '--commit'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), list('F-1', 'S-1', 'F-2'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), SUBJECT);
  assert.equal(staged(dir), null);
});
