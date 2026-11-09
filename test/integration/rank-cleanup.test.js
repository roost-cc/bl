import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { git } from '../helpers/git-backlog.js';
import { CLOSED, HAND, backlog, bl, originHead, read } from '../helpers/rank-fixture.js';

const LISTING = [
  'Ranked:',
  '  1. S-1  Story S-1 — Blocks every deploy, wrapped by hand.',
  '  2. F-2  Two — Users see it next',
  'Not yet ranked, oldest first:',
  '  F-1  One  (added 2026-01-01)',
  '  S-2  Story S-2  (added 2026-01-03)',
  '',
].join('\n');

test('bl rank with no arguments prints the ranked units, then the unranked tail oldest first', () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, LISTING);
  // No closed unit ranked: nothing written, committed or said about it.
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(read(dir), HAND);
  assert.doesNotMatch(r.stderr, /took out/);
});

test('a bare interactive bl rank takes closed units out in a commit of its own, then prints the order', () => {
  const dir = backlog(CLOSED);
  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), HAND);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-5, S-9 unranked (done) in priority.md');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.md');
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
  assert.match(r.stderr, /bl rank: took out F-5, S-9 \(done\)\./);
  assert.doesNotMatch(r.stderr, /--remove/);
  assert.equal(r.stdout, LISTING);
});

test('bare_rank_keeps_unknown_and_in_feature_entries_and_removes_a_closed_unit_listed_twice', () => {
  // F-99 names no unit; S-15 is a done story inside F-5; F-5 is listed twice.
  const kept = '  - unit: F-99\n    why: Gone\n  - unit: S-15\n    why: In a feature\n';
  const twice = '  - unit: F-5\n    why: Done now\n';
  const before = HAND.replace('---\n\n# Priority', `${twice}${kept}${twice}---\n\n# Priority`);
  let dir = backlog(before);
  let r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl rank: took out F-5 \(done\)\./);
  assert.equal(read(dir), HAND.replace('---\n\n# Priority', `${kept}---\n\n# Priority`));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-5 unranked (done) in priority.md');

  // The last closed entry leaves `ranked: []`.
  dir = backlog('---\nranked:\n  - unit: F-5\n    why: Done\n---\n\n# Priority\n');
  r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), '---\nranked: []\n---\n\n# Priority\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('an edit run with closed units ranked makes two commits, the cleanup first', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank', 'F-1', '--top', '--why', 'x'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    git(dir, 'log', '--format=%s', `${head}..HEAD`),
    'chore: F-1 ranked first in priority.md\nchore: F-5, S-9 unranked (done) in priority.md',
  );
  assert.equal(read(dir), HAND.replace('  - unit: S-1', '  - unit: F-1\n    why: x\n  - unit: S-1'));
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
});

test('bl rank <closed unit> --remove exits 0 after the cleanup took it out, with one commit', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank', 'F-5', '--remove'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /took out F-5, S-9 \(done\)/);
  assert.equal(git(dir, 'log', '--format=%s', `${head}..HEAD`), 'chore: F-5, S-9 unranked (done) in priority.md');
  assert.equal(read(dir), HAND);
});

test('usage errors and checkUnit refusals exit 1 before the cleanup; a flow list skips it with one line', () => {
  let dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const args of [['F-1'], ['F-5', '--top', '--why', 'x'], ['S-1', '--top', '--bottom']]) {
    const r = bl(['rank', ...args], dir);
    assert.equal(r.status, 1, args.join(' '));
    assert.doesNotMatch(r.stderr, /took out/, args.join(' '));
  }
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(read(dir), CLOSED);

  const flow = '---\nranked: [{ unit: F-5, why: Done }, { unit: F-2, why: Next }]\n---\n';
  dir = backlog(flow);
  let r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl rank: priority\.md: "ranked:" is a flow list/);
  assert.match(r.stdout, /F-2 {2}Two/);
  assert.equal(read(dir), flow);
  r = bl(['rank', 'F-1', '--top', '--why', 'x'], dir);
  assert.equal(r.status, 1);
  assert.equal(read(dir), flow);

  // The line prints when no ranked unit is closed too.
  const open = '---\nranked: [{ unit: F-1, why: x }]\n---\n';
  dir = backlog(open);
  r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl rank: priority\.md: "ranked:" is a flow list/);
  assert.equal(read(dir), open);
});

test('rank_bare_malformed_priority_reports_one_line', () => {
  // Every RankFileError shape the graph loads, on a bare run and on an edit:
  // one line, the file unchanged. (Frontmatter that is not YAML, or not a
  // mapping, stops loadBacklog before bl rank runs.)
  const shapes = {
    'not a list': '---\nranked: nope\n---\n',
    'entry without why': '---\nranked:\n  - unit: F-2\n---\n',
    'flow list': '---\nranked: [{ unit: F-2, why: Next }]\n---\n',
    'no frontmatter': '# Priority\n',
  };
  for (const [shape, text] of Object.entries(shapes)) {
    for (const [args, status] of [
      [[], 0],
      [['F-1', '--top', '--why', 'x'], 1],
    ]) {
      const label = `${shape} / ${args.length ? 'edit' : 'bare'}`;
      const dir = backlog(text);
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = bl(['rank', ...args], dir);
      assert.equal(r.status, status, `${label}: ${r.stderr}`);
      const lines = r.stderr.trim().split('\n');
      assert.equal(lines.length, 1, `${label}: ${r.stderr}`);
      assert.match(lines[0], /^bl rank: /, label);
      assert.equal(read(dir), text, label);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, label);
    }
  }
});

test('a headless bare bl rank writes nothing and says nothing about closed units', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank'], dir, { BL_HEADLESS: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(read(dir), CLOSED);
  assert.doesNotMatch(r.stderr, /took out|--remove|left/);
  // The order already skips closed units.
  assert.match(r.stdout, / {2}3\. F-2 {2}Two/);
  assert.doesNotMatch(r.stdout, /F-5|S-9/);
});

test('bl rank leaves closed units in a priority.md with uncommitted edits, and names them', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const edited = CLOSED.replace('Hand-written body.', 'Edited body.');
  writeFileSync(join(dir, 'priority.md'), edited);
  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl rank: priority\.md has uncommitted edits; left F-5, S-9 in ranked:/);
  assert.equal(read(dir), edited);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('a failed cleanup commit exits 1 and stops the edit; the next bare run commits the write', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho injected-commit-failure >&2\nexit 1\n');
  chmodSync(hook, 0o755);

  let r = bl(['rank', 'F-1', '--top', '--why', 'x'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /backlog commit failed: injected-commit-failure/);
  assert.equal(read(dir), HAND, 'the cleanup wrote; the edit did not run');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  unlinkSync(hook);
  r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /took out F-5, S-9 \(done\)/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-5, S-9 unranked (done) in priority.md');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(read(dir), HAND);
  assert.equal(r.stdout, LISTING);
});

test('rank_retry_keeps_a_pending_write_that_took_out_only_open_units', () => {
  // A failed `bl rank F-2 --remove` commit and a hand edit that deletes F-2's
  // entry leave the same text as a cleanup of F-2 would. F-2 is open, so the
  // write is not a cleanup's: a bare run leaves it as it is.
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  assert.equal(bl(['rank', 'F-2', '--remove'], dir).status, 1);
  unlinkSync(hook);
  const pending = read(dir);
  assert.doesNotMatch(pending, /unit: F-2/);

  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /open again/);
  assert.equal(read(dir), pending, 'the pending edit stays');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.match(git(dir, 'status', '--porcelain'), /priority\.md/);
});

test('the cleanup keeps a CRLF priority.md CRLF', () => {
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const dir = backlog(crlf(CLOSED));
  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /took out F-5, S-9 \(done\)/);
  assert.equal(read(dir), crlf(HAND));
  assert.equal(git(dir, 'status', '--porcelain'), '');
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
