import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSyncArgs } from '../../src/sync.js';

// S-872: repeated `-m`/`--message` values are joined as paragraphs the way
// `git commit -m a -m b` does, instead of the last one winning.

test('no -m leaves message null', () => {
  assert.equal(parseSyncArgs(['--commit', '--story', 'S-1']).message, null);
});

test('a single -m is kept verbatim', () => {
  const args = parseSyncArgs(['--commit', '-m', 'chore: x', '--story', 'S-1']);
  assert.equal(args.message, 'chore: x');
  assert.equal(args.commit, true);
  assert.deepEqual(args.storyIds, ['S-1']);
});

test('two -m values become subject and body paragraph', () => {
  const args = parseSyncArgs(['--commit', '-m', 'a', '-m', 'b', '--story', 'S-1']);
  assert.equal(args.message, 'a\n\nb');
});

test('--message=<v> and -m mix in order', () => {
  const args = parseSyncArgs(['--message=a', '-m', 'b', '--commit', '--story', 'S-1']);
  assert.equal(args.message, 'a\n\nb');
});

test('empty and whitespace-only -m values are dropped', () => {
  assert.equal(parseSyncArgs(['--commit', '-m', '', '-m', '  ']).message, null);
  assert.equal(parseSyncArgs(['--commit', '-m', '', '-m', 'a']).message, 'a');
  assert.equal(parseSyncArgs(['--commit', '-m', 'a', '-m', ' ', '-m', 'b']).message, 'a\n\nb');
});

test('a value with embedded newlines is kept verbatim', () => {
  const args = parseSyncArgs(['-m', 'a\nb', '-m', 'c']);
  assert.equal(args.message, 'a\nb\n\nc');
});

test('-m without a value is an error', () => {
  assert.throws(() => parseSyncArgs(['--commit', '-m']), /-m needs a value/);
});

test('an all-empty -m still counts as given, so main can reject it without --commit', () => {
  const dropped = parseSyncArgs(['-m', '']);
  assert.equal(dropped.message, null);
  assert.equal(dropped.messageGiven, true);
  assert.equal(parseSyncArgs(['--commit', '--story', 'S-1']).messageGiven, false);
});

// S-874: a value-taking flag followed by another option token is a missing
// value, not a value of `--story` or `--commit`.

test('-m followed by an option is a missing value', () => {
  assert.throws(() => parseSyncArgs(['--commit', '-m', '--story', 'S-1']), /^Error: -m needs a value$/);
  assert.throws(() => parseSyncArgs(['--commit', '-m', '--commit']), /^Error: -m needs a value$/);
});

test('--message followed by an option is a missing value', () => {
  assert.throws(() => parseSyncArgs(['--commit', '--message', '--story', 'S-1']), /^Error: --message needs a value$/);
  assert.throws(() => parseSyncArgs(['--commit', '--message', '--commit']), /^Error: --message needs a value$/);
});

test('--story followed by an option is a missing value', () => {
  assert.throws(
    () => parseSyncArgs(['--commit', '-m', 'x', '--story', '--path', 'foo']),
    /^Error: --story needs a value$/,
  );
  assert.throws(() => parseSyncArgs(['-m', 'x', '--story', '--commit']), /^Error: --story needs a value$/);
});

test('--path followed by an option is a missing value', () => {
  assert.throws(
    () => parseSyncArgs(['--commit', '-m', 'x', '--story', 'S-1', '--path', '--story', 'S-2']),
    /^Error: --path needs a value$/,
  );
  assert.throws(
    () => parseSyncArgs(['-m', 'x', '--story', 'S-1', '--path', '--commit']),
    /^Error: --path needs a value$/,
  );
});

test('a short-option-looking token or -- is also a missing value', () => {
  assert.throws(() => parseSyncArgs(['--commit', '-m', '-x']), /^Error: -m needs a value$/);
  assert.throws(() => parseSyncArgs(['--commit', '-m', 'x', '--story', '-m', 'y']), /^Error: --story needs a value$/);
  // `--` is not a value either: bl sync has no end-of-options marker, so a
  // template that emits it in place of the value should fail, not record it.
  assert.throws(() => parseSyncArgs(['--commit', '-m', '--']), /^Error: -m needs a value$/);
  assert.throws(() => parseSyncArgs(['-m', 'x', '--story', 'S-1', '--path', '--']), /^Error: --path needs a value$/);
});

test('an empty next token is still a value, not a missing one', () => {
  const args = parseSyncArgs(['--commit', '-m', '', '--story', 'S-1']);
  assert.equal(args.message, null);
  assert.equal(args.messageGiven, true);
  assert.deepEqual(parseSyncArgs(['--path', '']).paths, ['']);
});

test('the inline form keeps a value that starts with -', () => {
  const args = parseSyncArgs(['--commit', '--message=-x', '--story=-S', '--path=-p']);
  assert.equal(args.message, '-x');
  assert.deepEqual(args.storyIds, ['-S']);
  assert.deepEqual(args.paths, ['-p']);
  assert.equal(parseSyncArgs(['--message=- note']).message, '- note');
});

test('a lone - is an ordinary value', () => {
  const args = parseSyncArgs(['--commit', '-m', '-', '--story', '-', '--path', '-']);
  assert.equal(args.message, '-');
  assert.deepEqual(args.storyIds, ['-']);
  assert.deepEqual(args.paths, ['-']);
  assert.equal(parseSyncArgs(['--message', '-']).message, '-');
});
