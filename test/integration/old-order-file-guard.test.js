/**
 * F-113 D1a: the priority file became `priority.yaml`, a YAML list of work
 * unit ids. No tracked file may name the old markdown file.
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

test('no tracked file names the old priority file', () => {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split('\0').filter(Boolean);
  assert.ok(files.includes('src/priority.js'), 'run from the bl checkout');
  const naming = files.filter((f) => readFileSync(join(ROOT, f), 'latin1').includes(OLD));
  assert.deepEqual(naming, []);
});
