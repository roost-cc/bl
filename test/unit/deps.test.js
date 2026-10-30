import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCone, unblockCounts, orderCone, formatPlanRows } from '../../src/deps.js';

/**
 * Build the subset of a `buildGraph()` result that deps.js reads, from a
 * compact spec: `{ "S-1": { status, deps: ["S-2"] } }` where `deps` is the
 * dependency direction (S-1 depends_on S-2). Mirrors buildGraph's contract:
 * `children` is parent -> deps, `parents` is the reverse, both ID-sorted.
 */
function mkGraph(spec) {
  const byId = new Map(
    Object.entries(spec).map(([id, s]) => [id, { id, status: s.status ?? 'backlog', title: s.title ?? `Story ${id}` }]),
  );
  const children = new Map();
  const parents = new Map();
  const num = (id) => parseInt(id.slice(2), 10);
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  for (const [id, s] of Object.entries(spec)) {
    for (const dep of s.deps ?? []) {
      push(children, id, dep);
      push(parents, dep, id);
    }
  }
  for (const m of [children, parents]) for (const arr of m.values()) arr.sort((a, b) => num(a) - num(b));
  return { byId, children, parents };
}

function plan(spec, targetId) {
  const graph = mkGraph(spec);
  const cone = collectCone(targetId, graph);
  const counts = unblockCounts(cone, graph);
  return { cone, counts, ...orderCone(cone, graph, counts, targetId) };
}

test('orders a chain leaf-first with the target last', () => {
  // S-4 → S-3 → S-2 → S-1
  const { order, cycle } = plan(
    {
      'S-1': {},
      'S-2': { deps: ['S-1'] },
      'S-3': { deps: ['S-2'] },
      'S-4': { deps: ['S-3'] },
    },
    'S-4',
  );
  assert.deepEqual(order, ['S-1', 'S-2', 'S-3', 'S-4']);
  assert.equal(cycle, false);
});

test('counts unblocks within the cone only', () => {
  // S-9 (outside the cone) also depends on S-1, but must not be counted.
  const { counts } = plan(
    {
      'S-1': {},
      'S-2': { deps: ['S-1'] },
      'S-3': { deps: ['S-2'] },
      'S-9': { deps: ['S-1'] },
    },
    'S-3',
  );
  assert.equal(counts.get('S-1'), 2); // S-2 and S-3, not S-9
  assert.equal(counts.get('S-2'), 1);
  assert.equal(counts.get('S-3'), 0);
});

test('ranks by unblocks descending, tiebreaking on lowest id', () => {
  // S-10 and S-11 are both immediately ready. S-11 unblocks S-12 as well as
  // the target, so it outranks S-10 despite the higher ID. S-13 and S-14 are
  // ready peers with equal (zero) unblock counts → ID order.
  const { order } = plan(
    {
      'S-10': {},
      'S-11': {},
      'S-12': { deps: ['S-11'] },
      'S-13': {},
      'S-14': {},
      'S-20': { deps: ['S-10', 'S-12', 'S-13', 'S-14'] },
    },
    'S-20',
  );
  assert.deepEqual(order, ['S-11', 'S-10', 'S-13', 'S-14', 'S-12', 'S-20']);
});

test('omits done/superseded stories and does not descend through them', () => {
  // S-1 is only reachable through the done S-2, so it stays out of the plan
  // even though it is itself open.
  const { cone, order } = plan(
    {
      'S-1': {},
      'S-2': { status: 'done', deps: ['S-1'] },
      'S-3': { status: 'superseded' },
      'S-4': { deps: ['S-2', 'S-3'] },
    },
    'S-4',
  );
  assert.deepEqual([...cone], ['S-4']);
  assert.deepEqual(order, ['S-4']);
});

test('a target with no unfinished dependencies yields just the target', () => {
  const { order } = plan({ 'S-1': { status: 'done' }, 'S-2': { deps: ['S-1'] } }, 'S-2');
  assert.deepEqual(order, ['S-2']);
});

test('a closed target yields an empty cone', () => {
  const { order, cone } = plan({ 'S-1': { status: 'done' } }, 'S-1');
  assert.equal(cone.size, 0);
  assert.deepEqual(order, []);
});

test('an unknown target yields an empty cone', () => {
  const { order } = plan({ 'S-1': {} }, 'S-99');
  assert.deepEqual(order, []);
});

test('a cycle emits the orderable prefix, then the rest, with the flag', () => {
  // S-2 ⇄ S-3 cycle; S-1 is orderable, S-4 (target) is stuck behind the cycle.
  const { order, cycle } = plan(
    {
      'S-1': {},
      'S-2': { deps: ['S-1', 'S-3'] },
      'S-3': { deps: ['S-2'] },
      'S-4': { deps: ['S-2'] },
    },
    'S-4',
  );
  assert.equal(cycle, true);
  assert.equal(order[0], 'S-1');
  assert.equal(order.at(-1), 'S-4');
  // Nothing is dropped: every cone story still appears exactly once.
  assert.deepEqual([...order].sort(), ['S-1', 'S-2', 'S-3', 'S-4']);
});

test('keeps a low-numbered target last when it is caught in the cycle', () => {
  // The target has the lowest ID in the cone, so the by-ID cycle fallback
  // would otherwise emit it before the blockers it is stuck behind.
  const { order, cycle } = plan(
    {
      'S-1': { deps: ['S-8'] },
      'S-8': { deps: ['S-9'] },
      'S-9': { deps: ['S-8'] },
    },
    'S-1',
  );
  assert.equal(cycle, true);
  assert.deepEqual(order, ['S-8', 'S-9', 'S-1']);
});

test('a cycle does not hang unblockCounts', () => {
  const { counts } = plan({ 'S-1': { deps: ['S-2'] }, 'S-2': { deps: ['S-1'] } }, 'S-1');
  // Each is reachable from the other; neither counts itself.
  assert.equal(counts.get('S-1'), 1);
  assert.equal(counts.get('S-2'), 1);
});

test('a diamond lists the shared dependency once, first', () => {
  const { order, counts } = plan(
    {
      'S-1': {},
      'S-2': { deps: ['S-1'] },
      'S-3': { deps: ['S-1'] },
      'S-4': { deps: ['S-2', 'S-3'] },
    },
    'S-4',
  );
  assert.deepEqual(order, ['S-1', 'S-2', 'S-3', 'S-4']);
  assert.equal(counts.get('S-1'), 3);
});

test('formatPlanRows pads status to a fixed column', () => {
  const spec = {
    'S-1': { status: 'in_progress', title: 'One' },
    'S-2': { status: 'backlog', deps: ['S-1'], title: 'Two' },
    'S-10': { status: 'refined', deps: ['S-2'], title: 'Ten' },
  };
  const graph = mkGraph(spec);
  const { cone, counts, order } = plan(spec, 'S-10');
  assert.equal(cone.size, 3);
  const rows = formatPlanRows(order, graph, counts);

  assert.deepEqual(rows, [
    '  S-1   in_progress  unblocks 2  One',
    '  S-2   backlog      unblocks 1  Two',
    '  S-10  refined      unblocks 0  Ten',
  ]);

  // Both the status cell and the `unblocks` count start at the same offset on
  // every row, despite `in_progress` (11) and `backlog` (7) differing in width.
  for (const key of ['unblocks', 'in_progress|backlog|refined']) {
    const offsets = rows.map((r) => r.search(new RegExp(key)));
    assert.equal(new Set(offsets).size, 1, `${key} column is ragged: ${offsets}`);
  }
});

test('formatPlanRows trims trailing whitespace when the title is empty', () => {
  const spec = { 'S-1': { title: '' } };
  const graph = mkGraph(spec);
  const { counts, order } = plan(spec, 'S-1');
  const rows = formatPlanRows(order, graph, counts);
  assert.deepEqual(rows, ['  S-1  backlog  unblocks 0']);
});

test('formatPlanRows on a single row does not collapse the separators', () => {
  const spec = { 'S-7': { status: 'refined', title: 'Solo' } };
  const graph = mkGraph(spec);
  const { counts, order } = plan(spec, 'S-7');
  assert.deepEqual(formatPlanRows(order, graph, counts), ['  S-7  refined  unblocks 0  Solo']);
});
