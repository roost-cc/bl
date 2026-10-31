/**
 * The report's metrics over hand-built histories (F-40 D3): no git, no tree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrowHistory } from '../../src/history.js';
import {
  ages,
  daysBetween,
  firstSeen,
  leadCycle,
  percentile,
  progress,
  throughput,
  weekStart,
} from '../../src/report.js';
import { FLOW_TEMPLATE } from '../helpers/tempdir.js';
import { loadFlow } from '../../src/flow.js';
import { dirname } from 'path';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

/** A history from `[date, { id: [status, points] }]` pairs; `added` per story id. */
function history(days, added = {}) {
  return {
    days: days.map(([date, stories, backfilled = false]) => ({
      date,
      commit: backfilled ? null : `c-${date}`,
      backfilled,
      stories: Object.fromEntries(Object.entries(stories).map(([id, [status, points]]) => [id, { status, points }])),
      features: {},
    })),
    groups: {
      stories: Object.fromEntries(
        Object.entries(added).map(([id, a]) => [id, { feature: '', component: '', added: a, completed: '' }]),
      ),
      features: {},
    },
    unreadable: 0,
  };
}

test("percentile interpolates between ranks; the median of an even count is the middle pair's mean", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.85), 7);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([0, 10], 0.85), 8.5);
});

test("weekStart is the ISO week's Monday; daysBetween counts whole days", () => {
  assert.equal(weekStart('2026-04-26'), '2026-04-20', 'a Sunday');
  assert.equal(weekStart('2026-04-27'), '2026-04-27', 'a Monday');
  assert.equal(weekStart('2026-01-01'), '2025-12-29', 'across a year');
  assert.equal(daysBetween('2026-02-27', '2026-03-02'), 3);
});

test('progress leaves superseded stories out of scope', () => {
  assert.deepEqual(
    progress([
      { status: 'done', points: 3 },
      { status: 'backlog', points: 5 },
      { status: 'superseded', points: 8 },
    ]),
    { scope: 8, done: 3, remaining: 5, percent: 38 },
  );
  assert.deepEqual(progress([]), { scope: 0, done: 0, remaining: 0, percent: null });
});

test('firstSeen keeps the first started and the first done day; a reopened story keeps its first done', () => {
  const h = history([
    ['2026-04-20', { 'S-1': ['backlog', 2] }],
    ['2026-04-21', { 'S-1': ['in_progress', 2], 'S-2': ['done', 1] }],
    ['2026-04-22', { 'S-1': ['refined', 3], 'S-2': ['backlog', 1] }],
    ['2026-04-24', { 'S-1': ['done', 3], 'S-2': ['done', 1] }],
  ]);
  const seen = firstSeen(h, flow);
  assert.deepEqual(seen.get('S-1'), { started: '2026-04-21', done: '2026-04-24', points: 3 });
  assert.deepEqual(seen.get('S-2'), { started: '', done: '2026-04-21', points: 1 });
});

test("throughput sums each week's first-done points with the trailing four-week average", () => {
  const h = history([
    ['2026-04-06', { 'S-1': ['done', 4] }],
    ['2026-04-21', { 'S-1': ['done', 4], 'S-2': ['done', 2], 'S-3': ['done', 1] }],
    ['2026-04-28', { 'S-1': ['done', 4], 'S-2': ['done', 2], 'S-3': ['done', 1], 'S-4': ['refined', 5] }],
  ]);
  const t = throughput(h, { weeks: 4, seen: firstSeen(h, flow) });
  assert.deepEqual(
    t.weeks.map((w) => [w.week, w.points, w.stories, w.avgPoints]),
    [
      ['2026-W15', 4, 1, 1],
      ['2026-W16', 0, 0, 1],
      ['2026-W17', 3, 2, 1.8],
      ['2026-W18', 0, 0, 1.8],
    ],
  );
  assert.equal(t.averagePoints, 1.8);
  assert.deepEqual(throughput(history([]), { seen: new Map() }), { weeks: [], averagePoints: 0, averageStories: 0 });
});

test('leadCycle covers the stories first done in the window; ages lists the started ones, oldest first', () => {
  const h = history(
    [
      ['2026-01-02', { 'S-1': ['refined', 1], 'S-2': ['backlog', 1] }],
      ['2026-01-05', { 'S-1': ['done', 1], 'S-2': ['refined', 1], 'S-3': ['in_progress', 2] }],
      ['2026-04-10', { 'S-1': ['done', 1], 'S-2': ['done', 1], 'S-3': ['in_progress', 2], 'S-4': ['refined', 1] }],
      ['2026-04-12', { 'S-1': ['done', 1], 'S-2': ['done', 1], 'S-3': ['in_progress', 2], 'S-4': ['refined', 1] }],
    ],
    { 'S-1': '2025-12-30', 'S-2': '2026-01-01' },
  );
  const lc = leadCycle(h, { seen: firstSeen(h, flow) });
  assert.equal(lc.from, '2026-01-12');
  assert.deepEqual(
    lc.items.map((i) => [i.id, i.lead, i.cycle]),
    [['S-2', 99, 95]],
    'S-1 was done before the window',
  );
  assert.deepEqual(lc.lead, { count: 1, median: 99, p85: 99 });
  assert.deepEqual(
    ages(h, flow).map((a) => [a.id, a.status, a.since, a.days]),
    [
      ['S-3', 'in_progress', '2026-01-05', 97],
      ['S-4', 'refined', '2026-04-10', 2],
    ],
  );
});

test('leadCycle_returns_empty_when_since_excludes_all_days', () => {
  // S-1 refined on 04-20 and done on 04-28, the last snapshot; added 04-01.
  const all = history([
    ['2026-04-20', { 'S-1': ['refined', 3] }],
    ['2026-04-28', { 'S-1': ['done', 3] }],
  ]).days;
  const groups = {
    stories: { 'S-1': { added: '2026-04-01', completed: '', component: 'C01', feature: 'F-1' } },
    features: { 'F-1': { epic: 'E1', theme: 'demo' } },
  };
  for (const day of all) day.features = { 'F-1': { status: 'running', stories: ['S-1'] } };
  const scopes = [
    { kind: 'backlog' },
    { kind: 'feature', id: 'F-1' },
    { kind: 'component', id: 'C01' },
    { kind: 'epic', id: 'E1' },
    { kind: 'theme', id: 'demo' },
  ];
  const done = { id: 'S-1', added: '2026-04-01', started: '2026-04-20', done: '2026-04-28', lead: 27, cycle: 8 };
  const one = { count: 1, median: 27, p85: 27 };
  // [since, items, lead]: absent, before the first day, the first day, between commits, the last day, after it.
  const cases = [
    ['', [done], one],
    ['2026-04-01', [done], one],
    ['2026-04-20', [done], one],
    ['2026-04-24', [done], one],
    ['2026-04-28', [done], one],
    ['2026-04-29', [], { count: 0, median: null, p85: null }],
    ['2099-01-01', [], { count: 0, median: null, p85: null }],
  ];
  for (const [since, items, lead] of cases) {
    const h = {
      days: all.filter((d) => d.date >= since),
      earlier: all.filter((d) => d.date < since),
      groups,
      unreadable: 0,
    };
    for (const scope of scopes) {
      const lc = leadCycle(narrowHistory(h, scope), { seen: firstSeen(narrowHistory(h, scope), flow) });
      const label = `${since || 'no cutoff'} ${scope.kind}`;
      assert.deepEqual(lc.items, items, label);
      assert.deepEqual(lc.lead, lead, label);
      assert.equal(lc.cycle.count, items.length, label);
      if (items.length === 0) assert.deepEqual([lc.from, lc.to], ['', ''], label);
    }
  }
  const empty = { count: 0, median: null, p85: null };
  assert.deepEqual(
    leadCycle(history([]), { seen: new Map() }),
    { from: '', to: '', lead: empty, cycle: empty, items: [] },
    'a wholly empty history',
  );
});
