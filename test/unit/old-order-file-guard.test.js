/**
 * F-78 D4: the old feature order file became `priority.md`, ranked with
 * `bl rank`. Only the migration that turns one into the other may name it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Built so this file does not name it itself.
const OLD = ['feature', 'order.md'].join('-');
const MIGRATION = new Set([
  'scripts/migrate-priority.js',
  'src/migrate-priority.js',
  'test/integration/migrate-priority.test.js',
]);

test('no tracked file outside the migration names the old feature order file', () => {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split('\0').filter(Boolean);
  assert.ok(files.includes('src/migrate-priority.js'), 'run from the bl checkout');
  const naming = files.filter((f) => !MIGRATION.has(f) && readFileSync(join(ROOT, f), 'latin1').includes(OLD));
  assert.deepEqual(naming, []);
});
