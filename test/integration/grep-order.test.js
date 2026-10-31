/**
 * grep-order.test.js — `bl grep` takes its order and its closed filter from
 * flow.json (S-1162).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { FLOW_TEMPLATE, mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

const story = (id, status, extra = {}) => ({
  id,
  status,
  component: 'C00',
  title: `Findme ${id}`,
  body: '## Summary\n\nfindme\n',
  ...extra,
});

/** The stories, ranked `ranked` first in the `## Backlog` table. */
function fixture(stories, ranked = [], extra = {}) {
  const { dir } = mkTempBacklog({ components: [{ id: 'C00', title: 'Work' }], stories, ...extra });
  const rows = ranked.map((id) => `| ${id} | x |`).join('\n');
  writeFileSync(join(dir, 'index.md'), `# Backlog\n\n## Backlog\n\n| ID | Title |\n| -- | ----- |\n${rows}\n`);
  return dir;
}

function ids(dir, ...args) {
  const r = runBl(['grep', 'findme', ...args], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split('\n')
    .filter((l) => /\sC00\s/.test(l) || /^C00\s/.test(l))
    .map((l) => l.trim().split(/\s{2,}/)[1]);
}

const ALL = [
  story('S-1', 'superseded'),
  story('S-2', 'done', { completed: '2026-01-01' }),
  story('S-3', 'blocked'),
  story('S-4', 'refined'),
  story('S-5', 'backlog'),
  story('S-6', 'in_progress'),
];

test('bl grep: in_progress; backlog, refined and unknown together by rank; done; superseded', () => {
  const dir = fixture(ALL, ['S-5', 'S-3', 'S-4']);
  assert.deepEqual(ids(dir), ['S-6', 'S-5', 'S-3', 'S-4']);
  assert.deepEqual(ids(dir, '-a'), ['S-6', 'S-5', 'S-3', 'S-4', 'S-2', 'S-1']);
});

test('bl grep ranks a prototype-key status like any other unknown status', () => {
  for (const status of ['blocked', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 7, true, ['done']]) {
    const dir = fixture(
      [
        story('S-1', 'backlog'),
        story('S-2', status),
        story('S-3', 'refined'),
        story('S-4', 'in_progress'),
        story('S-5', 'done', { completed: '2026-01-01' }),
      ],
      ['S-1', 'S-2', 'S-3'],
    );
    const label = JSON.stringify(status);
    assert.deepEqual(ids(dir), ['S-4', 'S-1', 'S-2', 'S-3'], label);
    assert.deepEqual(ids(dir, '-a'), ['S-4', 'S-1', 'S-2', 'S-3', 'S-5'], label);
  }
});

test('bl grep keeps ranks 9999 and later ahead of unranked stories', () => {
  const stories = ['S-10', 'S-9', 'S-3', 'S-2', 'S-1'].map((id) => story(id, 'refined'));
  // S-3 lands on rank 9999, S-2 on 10000, S-1 on 10001; S-9 and S-10 have none.
  const filler = Array.from({ length: 9999 }, (_, i) => `S-${100 + i}`);
  const dir = fixture(stories, [...filler, 'S-3', 'S-2', 'S-1']);
  const order = ids(dir);
  assert.deepEqual(order.slice(0, 3), ['S-3', 'S-2', 'S-1']);
  assert.deepEqual(order.slice(3).sort(), ['S-10', 'S-9']);
});

test('a closed status added to flow.json is filtered out and sorts last', () => {
  const flow = JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
  flow.types.story.statuses.wontfix = { implies: ['done', 'in_progress', 'refined', 'backlog'] };
  const dir = fixture([story('S-1', 'wontfix'), story('S-2', 'backlog'), story('S-3', 'superseded')], [], { flow });
  assert.deepEqual(ids(dir), ['S-2']);
  assert.deepEqual(ids(dir, '-a'), ['S-2', 'S-3', 'S-1']);
});

test('a flow.json bl cannot read stops bl grep naming the file', () => {
  const dir = fixture(ALL);
  rmSync(join(dir, 'flow.json'));
  const missing = runBl(['grep', 'findme'], { cwd: dir });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /flow\.json: missing/);

  writeFileSync(join(dir, 'flow.json'), '{');
  const broken = runBl(['grep', 'findme', '-a'], { cwd: dir });
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  assert.match(broken.stderr, /flow\.json: not valid JSON/);
});
