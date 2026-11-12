/**
 * F-113 D1a: scripts/priority-to-yaml.js writes priority.yaml from
 * priority.md's `ranked:`: the open ranked work units, once each, in order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import { CLOSED, HAND, backlog } from '../helpers/rank-fixture.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/priority-to-yaml.js', import.meta.url));
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });
const written = (dir) => parse(readFileSync(join(dir, 'priority.yaml'), 'utf8'));

test('keeps the ranked order and leaves priority.md in place', () => {
  const dir = backlog(HAND);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(written(dir), ['S-1', 'F-2']);
  assert.equal(readFileSync(join(dir, 'priority.md'), 'utf8'), HAND);
});

test('drops the closed work units', () => {
  const dir = backlog(CLOSED);
  assert.equal(run(dir).status, 0);
  assert.deepEqual(written(dir), ['S-1', 'F-2']);
});

test('keeps a work unit listed twice once, at its first place', () => {
  const dir = backlog(HAND.replace('---\n\n# Priority', '  - unit: S-1\n    why: Again\n---\n\n# Priority'));
  assert.equal(run(dir).status, 0);
  assert.deepEqual(written(dir), ['S-1', 'F-2']);
});

test('--dry-run prints the list and writes nothing', () => {
  const dir = backlog(HAND);
  const r = run(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parse(r.stdout), ['S-1', 'F-2']);
  assert.equal(existsSync(join(dir, 'priority.yaml')), false);
});

test('a missing priority.md exits 1 and writes nothing', () => {
  const dir = backlog(null);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /priority\.md is missing/);
  assert.equal(existsSync(join(dir, 'priority.yaml')), false);
});
