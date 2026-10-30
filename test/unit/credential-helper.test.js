import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectGhCredentialHelper,
  formatGhCredentialHelperAdvisory,
  parseGhCredentialHelpers,
} from '../../src/credential-helper.js';

test('parseGhCredentialHelpers detects only a gh-backed helper', () => {
  const detection = parseGhCredentialHelpers(['credential.helper !gh auth git-credential']);

  assert.equal(detection.configured, true);
  assert.deepEqual(detection.matches, [{ key: 'credential.helper', value: '!gh auth git-credential' }]);
});

test('parseGhCredentialHelpers detects gh-backed helper beside another helper', () => {
  const detection = parseGhCredentialHelpers([
    'credential.helper store',
    'credential.https://github.com.helper !/usr/bin/gh auth git-credential',
  ]);

  assert.equal(detection.configured, true);
  assert.deepEqual(detection.matches, [
    {
      key: 'credential.https://github.com.helper',
      value: '!/usr/bin/gh auth git-credential',
    },
  ]);
});

test('parseGhCredentialHelpers ignores non-gh helpers', () => {
  const detection = parseGhCredentialHelpers([
    'credential.helper=store',
    'credential.https://example.com.helper osxkeychain',
  ]);

  assert.deepEqual(detection, { configured: false, matches: [] });
});

test('parseGhCredentialHelpers tolerates malformed and empty config output', () => {
  const detection = parseGhCredentialHelpers([
    '',
    '   ',
    'credential.helper',
    'not-a-helper !gh auth git-credential',
    'credential.helper=',
  ]);

  assert.deepEqual(detection, { configured: false, matches: [] });
});

test('detectGhCredentialHelper treats missing git and git failures as no match', () => {
  assert.deepEqual(detectGhCredentialHelper({ run: () => ({ error: { code: 'ENOENT' } }) }), {
    configured: false,
    matches: [],
  });
  assert.deepEqual(detectGhCredentialHelper({ run: () => ({ status: 1, stdout: '' }) }), {
    configured: false,
    matches: [],
  });
});

test('detectGhCredentialHelper trusts captured stdout despite spawn metadata errors', () => {
  assert.deepEqual(
    detectGhCredentialHelper({
      run: () => ({
        error: { code: 'EPERM' },
        status: 0,
        stdout: 'credential.helper !gh auth git-credential\n',
      }),
    }),
    {
      configured: true,
      matches: [{ key: 'credential.helper', value: '!gh auth git-credential' }],
    },
  );
});

test('formatGhCredentialHelperAdvisory names matching keys and migration recipe', () => {
  const advisory = formatGhCredentialHelperAdvisory({
    configured: true,
    matches: [{ key: 'credential.helper', value: '!gh auth git-credential' }],
  });

  assert.match(advisory, /credential\.helper/);
  assert.match(advisory, /Removing `gh` will break `git push`/);
  assert.match(advisory, /Migration recipe/);
});
