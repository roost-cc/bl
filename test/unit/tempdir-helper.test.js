import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// src/AGENTS.md: a test makes its temp dirs with `mkTempDir(prefix)` or
// `mkTempBacklog()` from test/helpers/tempdir.js, never a bare `mkdtempSync`,
// so each dir is removed when the file's tests end.
const TEST_DIR = fileURLToPath(new URL('..', import.meta.url));

test('unit_tests_use_tempdir_helper: no test file outside test/helpers calls mkdtempSync', () => {
  const offenders = [];
  for (const sub of readdirSync(TEST_DIR, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name === 'helpers') continue;
    for (const name of readdirSync(join(TEST_DIR, sub.name), { recursive: true })) {
      if (!String(name).endsWith('.js')) continue;
      const text = readFileSync(join(TEST_DIR, sub.name, String(name)), 'utf8');
      if (/\bmkdtemp(Sync)?\(/.test(text)) offenders.push(join(sub.name, String(name)));
    }
  }
  assert.deepEqual(offenders, [], 'use mkTempDir(prefix) or mkTempBacklog() from test/helpers/tempdir.js');
});
