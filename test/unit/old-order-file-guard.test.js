/**
 * F-113 D1a: the priority file became `priority.yaml`, a YAML list of work
 * unit ids. Only the conversion script that writes it from the old markdown
 * file, and its test, may name the old file. The cleanup story after F-113
 * deletes both and these exceptions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Built so this file does not name it itself.
const OLD = ['priority', 'md'].join('.');
const CONVERSION = new Set(['scripts/priority-to-yaml.js', 'test/unit/priority-to-yaml.test.js']);

test('no tracked file outside the conversion names the old priority file', () => {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split('\0').filter(Boolean);
  assert.ok(files.includes('scripts/priority-to-yaml.js'), 'run from the bl checkout');
  const naming = files.filter((f) => !CONVERSION.has(f) && readFileSync(join(ROOT, f), 'latin1').includes(OLD));
  assert.deepEqual(naming, []);
});
