import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFixArgs, SUPPORTED_CODES } from '../../src/fix.js';

test('bl fix supports no code since F-77 D3 retired asymmetric-dep', () => {
  assert.deepEqual([...SUPPORTED_CODES], []);
});

// ---------------------------------------------------------------------------
// parseFixArgs (S-858)
// ---------------------------------------------------------------------------

test('parseFixArgs accepts every documented option', () => {
  const a = parseFixArgs([
    '--code',
    'some-code',
    '--theme=infra',
    '--story',
    'S-1',
    '--story=S2',
    '--dry-run',
    '--json',
  ]);
  assert.equal(a.error, null);
  assert.equal(a.help, false);
  assert.deepEqual(a.codes, ['some-code']);
  assert.equal(a.theme, 'infra');
  assert.deepEqual(a.stories, ['S-1', 'S2']);
  assert.equal(a.dryRun, true);
  assert.equal(a.json, true);
});

test('parseFixArgs returns defaults for an empty argv', () => {
  const a = parseFixArgs([]);
  assert.deepEqual(a, {
    help: false,
    codes: [],
    theme: null,
    stories: [],
    dryRun: false,
    json: false,
    error: null,
  });
});

test('parseFixArgs reports the first unknown option in every spelling', () => {
  for (const argv of [
    ['--bogus'],
    ['--bogus', 'value'],
    ['--bogus=value'],
    ['--dry-run', '--bogus'],
    ['--json', '--bogus', '--story', 'S-1'],
  ]) {
    assert.equal(parseFixArgs(argv).error, 'unknown option "--bogus"', argv);
  }
  assert.equal(parseFixArgs(['-x']).error, 'unknown option "-x"');
});

test('parseFixArgs rejects a stray positional', () => {
  assert.equal(parseFixArgs(['S-1']).error, 'unexpected argument "S-1"');
  assert.equal(parseFixArgs(['--story', 'S-1', 'S-2']).error, 'unexpected argument "S-2"');
});

test('parseFixArgs rejects a value option with no value', () => {
  assert.equal(parseFixArgs(['--story']).error, 'option "--story" needs a value');
  assert.equal(parseFixArgs(['--story', '--dry-run']).error, 'option "--story" needs a value');
  // An empty inline value is no value: `--story=` must not reach
  // normalizeId as "" and surface as `unknown --story ""`.
  assert.equal(parseFixArgs(['--story=']).error, 'option "--story" needs a value');
  assert.equal(parseFixArgs(['--story=', 'S-1']).error, 'option "--story" needs a value');
  assert.equal(parseFixArgs(['--json=1']).error, 'option "--json" takes no value');
});

test('parseFixArgs lets help win over an error', () => {
  const a = parseFixArgs(['--bogus', '-h']);
  assert.equal(a.help, true);
  assert.equal(a.error, 'unknown option "--bogus"');
  assert.equal(parseFixArgs(['--help']).help, true);
});
