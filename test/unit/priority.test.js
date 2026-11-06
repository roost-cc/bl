/**
 * priority.test.js — `priority.md` and the order the graph gives from it
 * (F-78 D1, S-1261): `backlog.priority`, `backlog.rankOf` and the
 * `priority-file` and `priority-unit` problems `bl validate` reports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadBacklog } from '../../src/backlog-graph.js';
import { FrontmatterError, serializeFrontmatter } from '../../src/config.js';
import { PriorityError, parseRanked } from '../../src/priority.js';
import { findPriorityFindings } from '../../src/validate.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';

function write(path, fm, body = '') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${serializeFrontmatter(fm)}\n${body}`);
}

/**
 * A backlog of units, each `[id, frontmatter]`:
 *
 *   F-1 draft 2026-03-01   S-1 in F-1          S-5 loose 2026-03-01
 *   F-2 done  2026-01-01   S-2 loose, no added S-6 loose done
 *   F-3 draft 2026-02-01   S-3 loose 2026-02-01 S-7 update story 2026-01-01
 *   F-4 draft, no added    S-4 loose 2026-01-15 T-1 a task
 *
 * `priority` is `priority.md`'s whole text, or null for none.
 */
function backlog(priority) {
  const root = join(mkTempDir('bl-priority-'), 'backlog');
  mkdirSync(root, { recursive: true });
  copyFileSync(FLOW_TEMPLATE, join(root, 'flow.json'));
  const features = [
    ['F-1', { status: 'draft', added: '2026-03-01' }],
    ['F-2', { status: 'done', added: '2026-01-01' }],
    ['F-3', { status: 'draft', added: '2026-02-01' }],
    ['F-4', { status: 'draft' }],
  ];
  for (const [id, fm] of features) {
    const n = id.slice(2);
    write(join(root, 'features', `F${n}-x`, 'index.md'), { feature_id: id, title: id, ...fm });
  }
  const stories = [
    ['S-1', { feature: 'F-1', added: '2026-01-01' }],
    ['S-2', {}],
    ['S-3', { added: '2026-02-01' }],
    ['S-4', { added: '2026-01-15' }],
    ['S-5', { added: '2026-03-01' }],
    ['S-6', { status: 'done', added: '2025-01-01' }],
    ['S-7', { update_repo: 'bl', added: '2026-01-01' }],
  ];
  for (const [id, fm] of stories) {
    const n = id.slice(2);
    write(join(root, 'stories', `S${n}-x`, 'index.md'), {
      story_id: id,
      title: id,
      type: 'feature',
      points: 1,
      status: 'backlog',
      ...fm,
    });
  }
  write(join(root, 'tasks', 'T1-x.md'), { task_id: 'T-1', title: 'A task', unit: 'F-1', status: 'open' });
  if (priority != null) writeFileSync(join(root, 'priority.md'), priority);
  return { root, config: { backlogRoot: root }, cleanup: () => rmSync(join(root, '..'), { recursive: true }) };
}

const ranked = (...entries) =>
  `${serializeFrontmatter({ ranked: entries.map(([unit, why = 'Because.']) => ({ unit, why })) })}\n# Priority\n`;

const ids = (units) => units.map((u) => u.id);
const problems = (g) => g.problems.filter((p) => p.code.startsWith('priority')).map((p) => `${p.code}: ${p.message}`);

// ---------------------------------------------------------------------------
// parseRanked
// ---------------------------------------------------------------------------

test('parseRanked reads a list of {unit, why}; an empty or absent ranked: is an empty order', () => {
  assert.deepEqual(parseRanked([{ unit: ' S-1 ', why: ' x ' }]), [{ unit: 'S-1', why: 'x', position: 1 }]);
  assert.deepEqual(parseRanked(''), []);
  assert.deepEqual(parseRanked(undefined), []);
  assert.deepEqual(parseRanked([]), []);
});

test('parseRanked refuses every other shape', () => {
  for (const [raw, reason] of [
    ['F-1', /"ranked:" is not a list/],
    [{ unit: 'F-1' }, /"ranked:" is not a list/],
    [['F-1'], /entry 1 is not a mapping with "unit" and "why"/],
    [[{ unit: 'F-1', why: 'x' }, ['F-2']], /entry 2 is not a mapping/],
    [[{ why: 'x' }], /entry 1 has no "unit"/],
    [[{ unit: 'F-1' }], /entry 1 has no "why"/],
    [[{ unit: 'F-1', why: '  ' }], /entry 1 has no "why"/],
    [[{ unit: ['F-1'], why: 'x' }], /entry 1 has no "unit"/],
  ]) {
    assert.throws(
      () => parseRanked(raw),
      (e) => e instanceof PriorityError && reason.test(e.message) && e.message.startsWith('priority.md: '),
      JSON.stringify(raw),
    );
  }
});

// ---------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------

test('priority: open ranked units in list order, then open unranked units by added:, undated first', () => {
  const b = backlog(ranked(['S-5'], ['F-3']));
  try {
    const g = loadBacklog(b.config);
    // Tail: F-4 and S-2 are undated (feature first), then S-4 (01-15),
    // S-3 (02-01) and F-1 (03-01).
    assert.deepEqual(ids(g.priority), ['S-5', 'F-3', 'F-4', 'S-2', 'S-4', 'S-3', 'F-1']);
    assert.deepEqual(problems(g), []);
    assert.ok(Object.isFrozen(g.priority));
    assert.equal(g.priority, g.priority, 'computed once');
    assert.deepEqual(
      g.ranked.map((e) => `${e.position}:${e.unit.id}:${e.why}`),
      ['1:S-5:Because.', '2:F-3:Because.'],
    );
  } finally {
    b.cleanup();
  }
});

test('priority: on an added: tie features come first, then by number', () => {
  const b = backlog(ranked());
  try {
    // F-3 and S-3 share 2026-02-01; F-1 and S-5 share 2026-03-01.
    assert.deepEqual(ids(loadBacklog(b.config).priority), ['F-4', 'S-2', 'S-4', 'F-3', 'S-3', 'F-1', 'S-5']);
  } finally {
    b.cleanup();
  }
});

test('priority: closed units, stories inside a feature, update stories and tasks are never in it', () => {
  const b = backlog(ranked(['F-2'], ['S-6'], ['F-1']));
  try {
    const g = loadBacklog(b.config);
    // F-2 and S-6 are closed: skipped, and no problem.
    assert.deepEqual(ids(g.priority), ['F-1', 'F-4', 'S-2', 'S-4', 'F-3', 'S-3', 'S-5']);
    assert.deepEqual(problems(g), []);
    for (const id of ['F-2', 'S-6', 'S-1', 'S-7', 'T-1']) assert.ok(!ids(g.priority).includes(id), id);
  } finally {
    b.cleanup();
  }
});

test('priority: a new unranked story lands in the dated tail with no edit to priority.md', () => {
  const b = backlog(ranked(['S-2']));
  try {
    write(join(b.root, 'stories', 'S8-x', 'index.md'), {
      story_id: 'S-8',
      title: 'New',
      type: 'feature',
      points: 1,
      status: 'backlog',
      added: '2026-11-05',
    });
    assert.equal(loadBacklog(b.config).priority.at(-1).id, 'S-8');
  } finally {
    b.cleanup();
  }
});

test('rankOf: a unit its place, a story inside a feature its feature place, the rest Infinity', () => {
  const b = backlog(ranked(['S-5'], ['F-1']));
  try {
    const g = loadBacklog(b.config);
    assert.equal(g.rankOf('S-5'), 0);
    assert.equal(g.rankOf('F-1'), 1);
    assert.equal(g.rankOf('S-1'), 1, 'S-1 is in F-1');
    assert.equal(g.rankOf('s1'), 1, 'any spelling');
    assert.equal(g.rankOf(g.get('S-1')), 1, 'a unit');
    assert.equal(g.rankOf('F-4'), 2);
    for (const id of ['F-2', 'S-6', 'S-7', 'T-1', 'S-404', 'nonsense']) assert.equal(g.rankOf(id), Infinity, id);
    // Every placed unit sorts before every unplaced one.
    const sorted = ['S-7', 'S-1', 'F-4', 'S-5'].sort((a, b2) => g.rankOf(a) - g.rankOf(b2));
    assert.deepEqual(sorted, ['S-5', 'S-1', 'F-4', 'S-7']);
  } finally {
    b.cleanup();
  }
});

test('the order follows priority.md as it changes (revalidated by stat)', () => {
  const b = backlog(ranked(['S-5']));
  try {
    assert.equal(loadBacklog(b.config).priority[0].id, 'S-5');
    writeFileSync(join(b.root, 'priority.md.new'), ranked(['F-3'], ['S-5']));
    rmSync(join(b.root, 'priority.md'));
    copyFileSync(join(b.root, 'priority.md.new'), join(b.root, 'priority.md'));
    rmSync(join(b.root, 'priority.md.new'));
    assert.deepEqual(ids(loadBacklog(b.config).priority).slice(0, 2), ['F-3', 'S-5']);
    rmSync(join(b.root, 'priority.md'));
    const g = loadBacklog(b.config);
    assert.equal(g.ranked.length, 0);
    assert.deepEqual(
      problems(g).map((p) => p.split(':')[0]),
      ['priority-file'],
    );
  } finally {
    b.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Problems and findings
// ---------------------------------------------------------------------------

test('priority-file: a missing file is a problem, never thrown, and an empty order', () => {
  const b = backlog(null);
  try {
    const g = loadBacklog(b.config);
    assert.deepEqual(problems(g), [
      `priority-file: priority.md is missing; the backlog's priority lives in its "ranked:" frontmatter`,
    ]);
    assert.deepEqual(g.ranked, []);
    assert.equal(g.priority[0].id, 'F-4', 'the dated tail alone');
  } finally {
    b.cleanup();
  }
});

test('priority-file: a non-YAML file throws on a strict load and is a problem on a tolerant one', () => {
  const b = backlog('---\nranked: [\n---\n');
  try {
    assert.throws(
      () => loadBacklog(b.config),
      (e) => e instanceof FrontmatterError && /priority\.md: frontmatter is not YAML/.test(e.message),
    );
    const g = loadBacklog(b.config, { tolerant: true });
    const [p] = g.problems.filter((x) => x.code === 'priority-file');
    assert.equal(p.file, 'priority.md');
    assert.match(p.message, /the frontmatter is not YAML/);
    assert.deepEqual(g.ranked, []);
  } finally {
    b.cleanup();
  }
});

test('priority-file: a malformed ranked: is a problem, not thrown, and an empty order', () => {
  for (const [text, message] of [
    ['---\nranked: F-1\n---\n', '"ranked:" is not a list'],
    ['---\nranked:\n  - F-1\n---\n', '"ranked:" entry 1 is not a mapping with "unit" and "why"'],
    ['---\nranked:\n  - why: x\n---\n', '"ranked:" entry 1 has no "unit"'],
    ['---\nranked:\n  - unit: F-1\n---\n', '"ranked:" entry 1 has no "why"'],
    ['---\nranked:\n  - feature: F-1\n    why: x\n---\n', '"ranked:" entry 1 has no "unit"'],
  ]) {
    const b = backlog(text);
    try {
      const g = loadBacklog(b.config);
      assert.deepEqual(problems(g), [`priority-file: ${message}`], text);
      assert.deepEqual(g.ranked, []);
    } finally {
      b.cleanup();
    }
  }
});

test('priority-unit: unknown unit, duplicate, story inside a feature, update story, task', () => {
  const b = backlog(ranked(['F-99'], ['S-99'], ['nonsense'], ['S-5'], ['s5'], ['S-1'], ['S-7'], ['T-1'], ['F-2']));
  try {
    const g = loadBacklog(b.config);
    assert.deepEqual(problems(g), [
      'priority-unit: "ranked:" entry 1 (F-99) names no feature under features/',
      'priority-unit: "ranked:" entry 2 (S-99) names no story under stories/',
      'priority-unit: "ranked:" entry 3 (nonsense) is not a feature (F-<n>) or story (S-<n>) id',
      'priority-unit: "ranked:" entry 5 (s5) is ranked twice (first at entry 4)',
      'priority-unit: "ranked:" entry 6 (S-1) is a story inside F-1; rank its feature instead',
      'priority-unit: "ranked:" entry 7 (S-7) is an update story; update stories are never ranked',
      'priority-unit: "ranked:" entry 8 (T-1) names a task; only features and loose stories are ranked',
    ]);
    // The valid entries still order: S-5 first; F-2 (closed) is skipped silently.
    assert.equal(g.priority[0].id, 'S-5');
    assert.deepEqual(
      g.ranked.map((e) => e.unit.id),
      ['S-5', 'F-2'],
    );
  } finally {
    b.cleanup();
  }
});

test('bl validate reports the priority problems as errors at priority.md', () => {
  const b = backlog(ranked(['F-99'], ['F-2']));
  try {
    const findings = findPriorityFindings(loadBacklog(b.config, { tolerant: true }));
    assert.deepEqual(findings, [
      {
        severity: 'error',
        code: 'priority-unit',
        message: '"ranked:" entry 1 (F-99) names no feature under features/',
        location: 'priority.md',
      },
    ]);
  } finally {
    b.cleanup();
  }
  const none = backlog(null);
  try {
    assert.deepEqual(
      findPriorityFindings(loadBacklog(none.config, { tolerant: true })).map((f) => `${f.severity} ${f.code}`),
      ['error priority-file'],
    );
  } finally {
    none.cleanup();
  }
});
