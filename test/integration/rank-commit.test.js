import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { STAGED_CONFLICT, STAGED_FILE } from '../../src/priority.js';
import { NO_TERMINAL } from '../../src/rank-cmd.js';
import { git } from '../helpers/git-backlog.js';
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
