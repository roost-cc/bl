/**
 * The report's cost and token-efficiency figures over hand-built units
 * (F-40 D3 Cost, D7): no git, no tree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cost, costChart, efficiency, stepTokens, tokenFields } from '../../src/report.js';

/** A unit; `output: null` for one with no token fields. */
function unit(id, { type = 'feature', status = 'done', points, output, rounds = null, steps = null, headless = null }) {
  return {
    id,
    kind: id.startsWith('F-') ? 'feature' : 'story',
    type,
    title: `Unit ${id}`,
    link: `../x/${id}/index.md`,
    status,
    done: status === 'done',
    points,
    reviewRound: rounds,
    tokens: output === null ? null : { input: 100, output, cache_creation: 0, cache_read: 900 },
    headless,
    updated: output === null ? '' : '2026-10-20',
    steps,
  };
}

const STEPS = { implement: { input: 0, output: 70000, cache_creation: 0, cache_read: 0 } };

// Done units with tokens and points: F-1, F-2, F-3 (features, 10k, 20k, 60k a
// point) and S-1, S-2 (bugs, 30k and 10k). S-3 has zero points, S-4 no
// tokens, F-4 is open.
const UNITS = [
  unit('F-1', { points: 10, output: 100000, rounds: 1 }),
  unit('F-2', { points: 5, output: 100000, rounds: 3 }),
  unit('F-3', { points: 2, output: 120000, rounds: 4, steps: STEPS }),
  unit('F-4', {
    status: 'running',
    points: 4,
    output: 500000,
    headless: { input: 50, output: 250000, cache_creation: 0, cache_read: 450 },
  }),
  unit('S-1', { type: 'bug', points: 1, output: 30000 }),
  unit('S-2', { type: 'bug', points: 2, output: 20000, rounds: 0 }),
  unit('S-3', { type: 'chore', points: 0, output: 9000 }),
  unit('S-4', { type: 'chore', points: 3, output: null }),
];

test('tokenFields reads the four kinds under a prefix, null when none is present', () => {
  assert.equal(tokenFields({}), null);
  assert.equal(tokenFields({ tokens_updated: '2026-10-20' }), null);
  assert.deepEqual(tokenFields({ tokens_output: '7', tokens_input: 2 }), {
    input: 2,
    output: 7,
    cache_creation: 0,
    cache_read: 0,
  });
  assert.deepEqual(tokenFields({ tokens_headless_cache_read: '5' }, 'tokens_headless_'), {
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 5,
  });
});

test("stepTokens sums S-904's per-step map by step name across rounds", () => {
  assert.equal(stepTokens({}), null);
  assert.equal(stepTokens({ tokens_by_step: 'implement' }), null);
  assert.deepEqual(
    stepTokens({
      tokens_by_step: {
        implement: { input: '1', output: '10' },
        'review.1': { output: 5 },
        'review.2': { output: 7, cache_read: 3 },
        broken: 'x',
      },
    }),
    {
      implement: { input: 1, output: 10, cache_creation: 0, cache_read: 0 },
      review: { input: 0, output: 12, cache_creation: 0, cache_read: 3 },
    },
  );
});

test('cost: per-point figures, units without tokens last and left out, a zero-point unit has no per-point figure', () => {
  const c = cost(UNITS);
  assert.deepEqual(
    c.units.map((u) => [u.id, u.tokens?.output ?? null, u.outputPerPoint]),
    [
      ['F-4', 500000, 125000],
      ['F-3', 120000, 60000],
      ['F-1', 100000, 10000],
      ['F-2', 100000, 20000],
      ['S-1', 30000, 30000],
      ['S-2', 20000, 10000],
      ['S-3', 9000, null],
      ['S-4', null, null],
    ],
  );
  assert.equal(c.units.find((u) => u.id === 'S-4').headlessShare, null);
  assert.equal(c.units.find((u) => u.id === 'F-4').headlessShare, 50);
  assert.equal(c.units.find((u) => u.id === 'F-1').headlessShare, 0);
  // The total covers the seven units with tokens, open ones included.
  assert.equal(c.total.units, 7);
  assert.deepEqual(c.total.tokens, { input: 700, output: 879000, cache_creation: 0, cache_read: 6300 });
  assert.equal(c.total.headlessShare, round1((250500 / 885000) * 100));
  // The average: done units with tokens and points (F-1, F-2, F-3, S-1, S-2), sums over points.
  assert.deepEqual(c.average, {
    units: 5,
    points: 20,
    perPoint: { input: 25, output: 18500, cache_creation: 0, cache_read: 225 },
  });
  assert.deepEqual(cost([unit('S-9', { points: 0, output: 5 })]).average, { units: 0, points: 0, perPoint: null });
});

test('efficiency: per-type median and p90, the review-round split, per-step sums and the outliers', () => {
  const e = efficiency(UNITS);
  assert.equal(e.units, 5);
  assert.deepEqual(e.byType, [
    // [10k, 20k, 60k]: p90 at rank 1.8 = 20k + 0.8 × 40k.
    { type: 'feature', count: 3, median: 20000, p90: 52000 },
    // [10k, 30k]: the median is the pair's mean; p90 = 10k + 0.9 × 20k.
    { type: 'bug', count: 2, median: 20000, p90: 28000 },
  ]);
  // 0 to 2 rounds: F-1 (1), S-1 (no change document, 0), S-2 (0); 3 or more: F-2, F-3.
  assert.deepEqual(e.rounds, { few: { count: 3, median: 10000 }, many: { count: 2, median: 40000 } });
  assert.deepEqual(e.steps, STEPS);
  assert.deepEqual(
    e.outliers.map((o) => [o.id, o.type, o.points, o.reviewRound, o.outputPerPoint, o.steps]),
    [
      ['F-3', 'feature', 2, 4, 60000, STEPS],
      ['S-1', 'bug', 1, null, 30000, null],
    ],
  );
  const none = efficiency([unit('F-1', { points: 1, output: 10 })]);
  assert.equal(none.steps, null, 'shown as — until S-904 records them');
  assert.deepEqual(none.outliers, [], "a single unit is its type's p90, not above it");
});

test('costChart: the top units by output tokens, one stacked bar series per type in table order', () => {
  const chart = costChart(cost(UNITS));
  assert.equal(chart.id, 'cost');
  assert.equal(chart.x, 'category');
  assert.deepEqual(
    chart.series.map((s) => [s.name, s.kind, s.stack]),
    [
      ['feature', 'bar', 'type'],
      ['chore', 'bar', 'type'],
      ['bug', 'bar', 'type'],
    ],
  );
  const bug = chart.series.find((s) => s.name === 'bug');
  assert.deepEqual(
    bug.values.map((v) => `${v.x}=${v.y}`),
    ['F-4=0', 'F-3=0', 'F-1=0', 'F-2=0', 'S-1=30000', 'S-2=20000', 'S-3=0'],
    "every unit with tokens, in the table's order",
  );
  const many = Array.from({ length: 25 }, (_, i) => unit(`S-${i + 1}`, { points: 1, output: 1000 + i }));
  assert.equal(costChart(cost(many)).series[0].values.length, 20);
  assert.deepEqual(costChart(cost([unit('S-1', { points: 1, output: null })])).series, []);
});

function round1(n) {
  return Math.round(n * 10) / 10;
}
