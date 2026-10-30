import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { serializeFrontmatter } from '../../src/config.js';
import { withPartialWrites } from '../helpers/partial-write.js';
import {
  appendHistory,
  FeatureOrderError,
  findFeatureOrderFindings,
  parseRanked,
  rankedFeatures,
  readFeatureOrder,
  recordFeatureOrderMerge,
  unrankedFeatures,
} from '../../src/feature-order.js';

// F-53 D1: the feature order is `feature-order.md`'s `ranked:` frontmatter.

const FEATURES = [
  { id: 'F-1', title: 'One', theme: 'backlog', epic: 'E50', status: 'running' },
  { id: 'F-2', title: 'Two', theme: 'accounts', epic: '', status: 'draft' },
  { id: 'F-3', title: 'Three', theme: 'backlog', epic: 'E51', status: 'approved' },
  { id: 'F-4', title: 'Four', theme: 'backlog', epic: '', status: 'done' },
  { id: 'F-5', title: 'Five', theme: 'accounts', epic: '', status: 'superseded' },
  { id: 'F-6', title: 'Six', theme: 'backlog', epic: '', status: 'refined' },
];

function backlogWith(text) {
  const dir = mkTempDir('bl-feature-order-');
  if (text != null) writeFileSync(join(dir, 'feature-order.md'), text);
  return { config: { backlogRoot: dir }, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ORDER = `---
ranked:
  # The operator's comment survives a body rewrite.
  - feature: F-3
    why: Unblocks the rest.
  - feature: f4
    why: Done already.
  - feature: F-1
    why: Then this.
---

# Feature order

Intro.

## History

- 2026-01-01: F-0 done (Zero).
`;

test('parseRanked reads a list of {feature, why}; an empty or absent ranked: is an empty order', () => {
  assert.deepEqual(parseRanked([{ feature: ' F-1 ', why: 'x' }]), [{ feature: 'F-1', why: 'x', position: 1 }]);
  assert.deepEqual(parseRanked(''), []);
  assert.deepEqual(parseRanked(undefined), []);
  assert.deepEqual(parseRanked([]), []);
});

test('parseRanked refuses every other shape', () => {
  for (const [raw, reason] of [
    ['F-1', /"ranked:" is not a list/],
    [{ feature: 'F-1' }, /"ranked:" is not a list/],
    [['F-1'], /entry 1 is not a mapping/],
    [[{ feature: 'F-1', why: 'x' }, ['F-2']], /entry 2 is not a mapping/],
    [[{ why: 'x' }], /entry 1 has no "feature"/],
    [[{ feature: 'F-1' }], /entry 1 has no "why"/],
    [[{ feature: 'F-1', why: '  ' }], /entry 1 has no "why"/],
    [[{ feature: ['F-1'], why: 'x' }], /entry 1 has no "feature"/],
  ]) {
    assert.throws(
      () => parseRanked(raw),
      (e) => e instanceof FeatureOrderError && reason.test(e.message),
      JSON.stringify(raw),
    );
  }
});

test('readFeatureOrder keeps the frontmatter block as written, and is null with no file', () => {
  const b = backlogWith(ORDER);
  try {
    const order = readFeatureOrder(b.config);
    assert.equal(order.fmText + order.body, ORDER);
    assert.match(order.fmText, /# The operator's comment/);
    assert.deepEqual(
      order.ranked.map((e) => e.feature),
      ['F-3', 'f4', 'F-1'],
    );
  } finally {
    b.cleanup();
  }
  const none = backlogWith(null);
  try {
    assert.equal(readFeatureOrder(none.config), null);
  } finally {
    none.cleanup();
  }
});

test('rankedFeatures keeps rank order, skips closed and unknown ids, and filters by theme and epic', () => {
  const order = {
    ranked: parseRanked([
      { feature: 'F-3', why: 'a' },
      { feature: 'F-4', why: 'done' },
      { feature: 'F-99', why: 'unknown' },
      { feature: 'F-2', why: 'b' },
      { feature: 'F-3', why: 'again' },
      { feature: 'f1', why: 'c' },
    ]),
  };
  const ids = (list) => list.map((r) => `${r.position}:${r.id}`);
  assert.deepEqual(ids(rankedFeatures(order, FEATURES)), ['1:F-3', '4:F-2', '6:F-1']);
  assert.deepEqual(ids(rankedFeatures(order, FEATURES, { theme: 'accounts' })), ['4:F-2']);
  assert.deepEqual(ids(rankedFeatures(order, FEATURES, { epic: 'E50' })), ['6:F-1']);
  assert.deepEqual(ids(rankedFeatures(order, FEATURES, { theme: 'backlog', epic: 'E51' })), ['1:F-3']);
  assert.deepEqual(rankedFeatures(order, FEATURES, { theme: 'backlog', epic: 'E52' }), []);
  assert.equal(rankedFeatures(order, FEATURES)[0].why, 'a');
  assert.equal(rankedFeatures(order, FEATURES)[0].feature.title, 'Three');
  assert.deepEqual(rankedFeatures(null, FEATURES), []);
});

test('unrankedFeatures lists the open features not in ranked:, by id, filtered', () => {
  const order = { ranked: parseRanked([{ feature: 'F-3', why: 'a' }]) };
  const ids = (list) => list.map((f) => f.id);
  assert.deepEqual(ids(unrankedFeatures(order, FEATURES)), ['F-1', 'F-2', 'F-6']);
  assert.deepEqual(ids(unrankedFeatures(order, FEATURES, { theme: 'backlog' })), ['F-1', 'F-6']);
  assert.deepEqual(ids(unrankedFeatures(null, FEATURES, { epic: 'E51' })), ['F-3']);
});

test('appendHistory appends to the end of ## History, creates it when absent, and adds a line once', () => {
  const body = '\nIntro.\n\n## History\n\n- a\n- b\n';
  assert.equal(appendHistory(body, '- c'), '\nIntro.\n\n## History\n\n- a\n- b\n- c\n');
  assert.equal(appendHistory(body, '- b'), body);
  assert.equal(appendHistory('\nIntro.\n', '- c'), '\nIntro.\n\n## History\n\n- c\n');
  assert.equal(appendHistory('## History\n\n## Later\n\nx\n', '- c'), '## History\n\n- c\n\n## Later\n\nx\n');
});

// bl validate (F-53 D1): one test per case.

function codes(findings) {
  return findings.map((f) => `${f.code}: ${f.message}`);
}

test('validate: a clean feature order has no finding', () => {
  const b = backlogWith('---\nranked:\n  - feature: F-1\n    why: x\n---\n');
  try {
    assert.deepEqual(findFeatureOrderFindings(b.config, FEATURES), []);
  } finally {
    b.cleanup();
  }
});

test('validate: feature-order-file when the file is missing', () => {
  const b = backlogWith(null);
  try {
    const f = findFeatureOrderFindings(b.config, FEATURES);
    assert.deepEqual(codes(f), [
      `feature-order-file: feature-order.md is missing; the feature order lives in its "ranked:" frontmatter`,
    ]);
    assert.equal(f[0].severity, 'error');
    assert.equal(f[0].location, 'feature-order.md');
  } finally {
    b.cleanup();
  }
});

test('validate: feature-order-file when the frontmatter is not YAML', () => {
  const b = backlogWith('---\nranked: [\n---\n');
  try {
    const f = findFeatureOrderFindings(b.config, FEATURES);
    assert.equal(f.length, 1);
    assert.equal(f[0].code, 'feature-order-file');
    assert.match(f[0].message, /frontmatter is not YAML/);
  } finally {
    b.cleanup();
  }
});

test('validate: feature-order-file when ranked: is not a list', () => {
  const b = backlogWith('---\nranked: F-1\n---\n');
  try {
    assert.deepEqual(codes(findFeatureOrderFindings(b.config, FEATURES)), [
      'feature-order-file: "ranked:" is not a list',
    ]);
  } finally {
    b.cleanup();
  }
});

test('validate: feature-order-file when an entry is not a mapping', () => {
  const b = backlogWith('---\nranked:\n  - F-1\n---\n');
  try {
    assert.deepEqual(codes(findFeatureOrderFindings(b.config, FEATURES)), [
      'feature-order-file: "ranked:" entry 1 is not a mapping with "feature" and "why"',
    ]);
  } finally {
    b.cleanup();
  }
});

test('validate: feature-order-file when an entry lacks feature or why', () => {
  for (const [entry, key] of [
    ['why: x', 'feature'],
    ['feature: F-1', 'why'],
  ]) {
    const b = backlogWith(`---\nranked:\n  - ${entry}\n---\n`);
    try {
      assert.deepEqual(codes(findFeatureOrderFindings(b.config, FEATURES)), [
        `feature-order-file: "ranked:" entry 1 has no "${key}"`,
      ]);
    } finally {
      b.cleanup();
    }
  }
});

test('validate: feature-order-feature when a ranked id has no feature', () => {
  const b = backlogWith('---\nranked:\n  - feature: F-99\n    why: x\n  - feature: nonsense\n    why: y\n---\n');
  try {
    assert.deepEqual(codes(findFeatureOrderFindings(b.config, FEATURES)), [
      'feature-order-feature: "ranked:" entry 1 (F-99) names no feature under features/',
      'feature-order-feature: "ranked:" entry 2 (nonsense) names no feature under features/',
    ]);
  } finally {
    b.cleanup();
  }
});

test('validate: feature-order-feature when a ranked feature is done or superseded', () => {
  const b = backlogWith('---\nranked:\n  - feature: F-4\n    why: x\n  - feature: F-5\n    why: y\n---\n');
  try {
    assert.deepEqual(codes(findFeatureOrderFindings(b.config, FEATURES)), [
      'feature-order-feature: "ranked:" entry 1 (F-4) is done; remove it from "ranked:"',
      'feature-order-feature: "ranked:" entry 2 (F-5) is superseded; remove it from "ranked:"',
    ]);
  } finally {
    b.cleanup();
  }
});

test('validate: feature-order-feature when a feature is ranked twice', () => {
  const b = backlogWith(
    '---\nranked:\n  - feature: F-1\n    why: x\n  - feature: F-2\n    why: y\n  - feature: f1\n    why: z\n---\n',
  );
  try {
    assert.deepEqual(codes(findFeatureOrderFindings(b.config, FEATURES)), [
      'feature-order-feature: "ranked:" entry 3 (f1) is ranked twice (first at entry 1)',
    ]);
  } finally {
    b.cleanup();
  }
});

test('recordFeatureOrderMerge drops the feature from ranked: and appends the History line', () => {
  const b = backlogWith(ORDER);
  try {
    assert.equal(recordFeatureOrderMerge(b.config, { id: 'F-3', title: 'Three' }, '2026-10-25'), true);
    const order = readFeatureOrder(b.config);
    assert.deepEqual(
      order.ranked.map((e) => e.feature),
      ['f4', 'F-1'],
    );
    assert.equal(
      order.body,
      '\n# Feature order\n\nIntro.\n\n## History\n\n- 2026-01-01: F-0 done (Zero).\n- 2026-10-25: F-3 done (Three).\n',
    );
    // A re-run writes nothing more.
    const text = readFileSync(join(b.dir, 'feature-order.md'), 'utf8');
    assert.equal(recordFeatureOrderMerge(b.config, { id: 'F-3', title: 'Three' }, '2026-10-25'), false);
    assert.equal(readFileSync(join(b.dir, 'feature-order.md'), 'utf8'), text);
  } finally {
    b.cleanup();
  }
});

test('merge removes all feature spellings accepted by the reader', () => {
  for (const spelling of ['F-3', 'f3', 'F3', 'f-3', ' F-3', 'F-3 ', '\tF-3\t', '  f3  ']) {
    const text =
      serializeFrontmatter({
        ranked: [
          { feature: spelling, why: 'This.' },
          { feature: 'F-1', why: 'Other.' },
        ],
      }) + '\n## History\n';
    const b = backlogWith(text);
    try {
      assert.equal(rankedFeatures(readFeatureOrder(b.config), FEATURES)[0]?.id, 'F-3', JSON.stringify(spelling));
      assert.equal(recordFeatureOrderMerge(b.config, { id: 'F-3', title: 'Three' }, '2026-10-25'), true);
      assert.deepEqual(
        readFeatureOrder(b.config).ranked.map((e) => e.feature),
        ['F-1'],
        JSON.stringify(spelling),
      );
    } finally {
      b.cleanup();
    }
  }
});

test('recordFeatureOrderMerge of an unranked feature keeps the frontmatter as written and records History', () => {
  const b = backlogWith(ORDER);
  try {
    assert.equal(recordFeatureOrderMerge(b.config, { id: 'F-6', title: 'Six' }, '2026-10-25'), true);
    const text = readFileSync(join(b.dir, 'feature-order.md'), 'utf8');
    assert.ok(text.startsWith(readFeatureOrder(b.config).fmText));
    assert.match(text, /# The operator's comment/);
    assert.match(text, /- 2026-10-25: F-6 done \(Six\)\.\n$/);
  } finally {
    b.cleanup();
  }
});

test('recordFeatureOrderMerge warns, never throws, on a missing or malformed file', () => {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => (writes.push(String(s)), true);
  try {
    const none = backlogWith(null);
    try {
      assert.equal(recordFeatureOrderMerge(none.config, { id: 'F-1', title: 'One' }, '2026-10-25'), false);
    } finally {
      none.cleanup();
    }
    const bad = backlogWith('---\nranked: F-1\n---\n');
    try {
      assert.equal(recordFeatureOrderMerge(bad.config, { id: 'F-1', title: 'One' }, '2026-10-25'), false);
      assert.equal(readFileSync(join(bad.dir, 'feature-order.md'), 'utf8'), '---\nranked: F-1\n---\n');
    } finally {
      bad.cleanup();
    }
  } finally {
    process.stderr.write = orig;
  }
  assert.match(writes.join(''), /warning: feature-order\.md is missing, so F-1 is not recorded/);
  assert.match(writes.join(''), /warning: feature-order\.md not updated for F-1: .*"ranked:" is not a list/);
});

test('recordFeatureOrderMerge_partial_write_preserves_order_and_history', async () => {
  const b = backlogWith(ORDER);
  const path = join(b.dir, 'feature-order.md');
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => (writes.push(String(s)), true);
  try {
    // The disk fills after ten bytes: a warning, and the live file is whole.
    const failed = await withPartialWrites(path, () =>
      recordFeatureOrderMerge(b.config, { id: 'F-3', title: 'Three' }, '2026-10-25'),
    );
    assert.equal(failed, false);
    assert.equal(readFileSync(path, 'utf8'), ORDER);
    // The retry starts from the operator's content, not from a truncated file.
    assert.equal(recordFeatureOrderMerge(b.config, { id: 'F-3', title: 'Three' }, '2026-10-25'), true);
    const order = readFeatureOrder(b.config);
    assert.deepEqual(
      order.ranked.map((e) => e.feature),
      ['f4', 'F-1'],
    );
    assert.match(order.body, /- 2026-01-01: F-0 done \(Zero\)\.\n- 2026-10-25: F-3 done \(Three\)\.\n$/);
  } finally {
    process.stderr.write = orig;
    b.cleanup();
  }
  assert.match(writes.join(''), /warning: feature-order\.md not updated for F-3: injected ENOSPC/);
});
