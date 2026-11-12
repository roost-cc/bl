import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { git } from '../helpers/git-backlog.js';
import { CLOSED, HAND, backlog, bl, list, originHead, read } from '../helpers/rank-fixture.js';

const LISTING = [
  'Ranked:',
  '  1. S-1  Story S-1',
  '  2. F-2  Two',
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
  assert.equal(read(dir), list('S-1', 'F-2'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-5, S-9 unranked (done) in priority.yaml');
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.yaml');
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
  assert.match(r.stderr, /bl rank: took out F-5, S-9 \(done\)\./);
  assert.doesNotMatch(r.stderr, /--remove/);
  assert.equal(r.stdout, LISTING);
});

test('bare_rank_keeps_unknown_and_in_feature_entries_and_removes_a_closed_unit_listed_twice', () => {
  // F-99 names no unit; S-15 is a done story inside F-5; F-5 is listed twice.
  let dir = backlog(list('S-1', 'F-5', 'F-2', 'F-99', 'S-15', 'F-5'));
  let r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl rank: took out F-5 \(done\)\./);
  assert.equal(read(dir), list('S-1', 'F-2', 'F-99', 'S-15'));
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-5 unranked (done) in priority.yaml');

  // The last closed entry leaves `[]`; a flow list reads like a block list.
  dir = backlog('[F-5]\n');
  r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir), '[]\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('an edit run with closed units ranked makes two commits, the cleanup first', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank', 'F-1', '--top'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    git(dir, 'log', '--format=%s', `${head}..HEAD`),
    'chore: F-1 ranked first in priority.yaml\nchore: F-5, S-9 unranked (done) in priority.yaml',
  );
  assert.equal(read(dir), list('F-1', 'S-1', 'F-2'));
  assert.equal(originHead(dir), git(dir, 'rev-parse', 'HEAD'), 'pushed');
});

test('bl rank <closed unit> --remove exits 0 after the cleanup took it out, with one commit', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['rank', 'F-5', '--remove'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /took out F-5, S-9 \(done\)/);
  assert.equal(git(dir, 'log', '--format=%s', `${head}..HEAD`), 'chore: F-5, S-9 unranked (done) in priority.yaml');
  assert.equal(read(dir), list('S-1', 'F-2'));
});

test('usage errors and checkUnit refusals exit 1 before the cleanup', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  for (const args of [['F-1'], ['F-5', '--top'], ['S-1', '--top', '--bottom'], ['S-1', '--why', 'x']]) {
    const r = bl(['rank', ...args], dir);
    assert.equal(r.status, 1, args.join(' '));
    assert.doesNotMatch(r.stderr, /took out/, args.join(' '));
  }
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(read(dir), CLOSED);
});

test('rank_bare_malformed_priority_reports_one_line', () => {
  // Every RankFileError shape the graph loads, on a bare run and on an edit:
  // one line, the file unchanged. (A file that is not YAML stops
  // loadBacklog before bl rank runs.)
  const shapes = {
    'a mapping': 'ranked: nope\n',
    'a scalar': 'F-2\n',
    'an entry that is a mapping': '- unit: F-2\n  why: Next\n',
    'an entry that is a number': '- F-2\n- 7\n',
  };
  for (const [shape, text] of Object.entries(shapes)) {
    for (const [args, status] of [
      [[], 0],
      [['F-1', '--top'], 1],
    ]) {
      const label = `${shape} / ${args.length ? 'edit' : 'bare'}`;
      const dir = backlog(text);
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = bl(['rank', ...args], dir);
      assert.equal(r.status, status, `${label}: ${r.stderr}`);
      const lines = r.stderr.trim().split('\n');
      assert.equal(lines.length, 1, `${label}: ${r.stderr}`);
      assert.match(lines[0], /^bl rank: priority\.yaml: /, label);
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

test('bl rank leaves closed units in a priority.yaml with uncommitted edits, and names them', () => {
  const dir = backlog(CLOSED);
  const head = git(dir, 'rev-parse', 'HEAD');
  const edited = CLOSED.replace('# Ranked by hand.', '# Edited by hand.');
  writeFileSync(join(dir, 'priority.yaml'), edited);
  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /bl rank: priority\.yaml has uncommitted edits; left F-5, S-9 in the list/);
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

  let r = bl(['rank', 'F-1', '--top'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /backlog commit failed: injected-commit-failure/);
  assert.equal(read(dir), list('S-1', 'F-2'), 'the cleanup wrote; the edit did not run');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  unlinkSync(hook);
  r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /took out F-5, S-9 \(done\)/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: F-5, S-9 unranked (done) in priority.yaml');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(read(dir), list('S-1', 'F-2'));
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
  assert.equal(pending, list('S-1'));

  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /open again/);
  assert.equal(read(dir), pending, 'the pending edit stays');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.match(git(dir, 'status', '--porcelain'), /priority\.yaml/);
});

test('the cleanup reads a CRLF priority.yaml and writes the list with LF', () => {
  const dir = backlog(CLOSED.replace(/\n/g, '\r\n'));
  const r = bl(['rank'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /took out F-5, S-9 \(done\)/);
  assert.equal(read(dir), list('S-1', 'F-2'));
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('under BL_HEADLESS bl rank refuses with nothing written, and so does a backlog commit of priority.yaml', () => {
  const dir = backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const headless = { BL_HEADLESS: '1' };
  let r = bl(['rank', 'F-1', '--top'], dir, headless);
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
  writeFileSync(join(dir, 'priority.yaml'), `${HAND}- F-1\n`);
  r = bl(['sync', '--commit', '-m', 'chore: rank by hand', '--path', 'priority.yaml'], dir, headless);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to commit priority\.yaml .*BL_HEADLESS is set/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);

  // The operator, without the marker, can.
  r = bl(['sync', '--commit', '-m', 'chore: rank by hand', '--path', 'priority.yaml'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.yaml');
});
