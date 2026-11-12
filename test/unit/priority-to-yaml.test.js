/**
 * F-113 D1a: scripts/priority-to-yaml.js writes priority.yaml from
 * priority.md's `ranked:`: the open ranked work units, once each, in order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import { backlog } from '../helpers/rank-fixture.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/priority-to-yaml.js', import.meta.url));
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });
const written = (dir) => parse(readFileSync(join(dir, 'priority.yaml'), 'utf8'));

/** A hand-written priority.md, the format before F-113: comments, a wrapped reason, a body. */
const HAND = `---
# Ranked by hand.
ranked:
  # The deploy blocker first.
  - unit: S-1
    why: Blocks every deploy,
      wrapped by hand.
  - unit: F-2 # the big one
    why: "Users see it next"
---

# Priority

Hand-written body.
`;

/** HAND with the closed F-5 and S-9 ranked too. */
const CLOSED = HAND.replace('  - unit: F-2', '  - unit: F-5\n    why: Done now\n  - unit: F-2').replace(
  '---\n\n# Priority',
  '  - unit: S-9\n    why: Done too\n---\n\n# Priority',
);

/** The rank fixture's backlog with `text` as its priority.md and no priority.yaml. */
function withMd(text) {
  const dir = backlog(null);
  writeFileSync(join(dir, 'priority.md'), text);
  return dir;
}

test('keeps the ranked order and leaves priority.md in place', () => {
  const dir = withMd(HAND);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(written(dir), ['S-1', 'F-2']);
  assert.equal(readFileSync(join(dir, 'priority.md'), 'utf8'), HAND);
});

test('drops the closed work units', () => {
  const dir = withMd(CLOSED);
  assert.equal(run(dir).status, 0);
  assert.deepEqual(written(dir), ['S-1', 'F-2']);
});

test('keeps a work unit listed twice once, at its first place', () => {
  const dir = withMd(HAND.replace('---\n\n# Priority', '  - unit: S-1\n    why: Again\n---\n\n# Priority'));
  assert.equal(run(dir).status, 0);
  assert.deepEqual(written(dir), ['S-1', 'F-2']);
});

test('--dry-run prints the list and writes nothing', () => {
  const dir = withMd(HAND);
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

test('a ranked: that is not a list of {unit} exits 1 and writes nothing', () => {
  for (const text of ['---\nranked: F-1\n---\n', '---\nranked:\n  - why: x\n---\n']) {
    const dir = withMd(text);
    const r = run(dir);
    assert.equal(r.status, 1, text);
    assert.match(r.stderr, /^priority\.md: /, text);
    assert.equal(existsSync(join(dir, 'priority.yaml')), false, text);
  }
});
