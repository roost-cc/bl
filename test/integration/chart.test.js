/**
 * Chart adapters (F-40 Design D4) over the scripted fixture repo
 * (`test/helpers/scripted-backlog.js`): the charts `buildReport` makes, the
 * `vega-lite` adapter's specs against the checked-in JSON under
 * `test/fixtures/charts/`, and a stub adapter's markdown and files in a
 * written report.
 *
 * After a deliberate change to the specs, rewrite the fixtures with
 * `env UPDATE_CHART_FIXTURES=1 node --test test/integration/chart.test.js` and
 * review the diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { registerAdapter, renderCharts } from '../../src/chart.js';
import { COLOURS, SCHEMA, toSpec } from '../../src/chart-adapters/vega-lite.js';
import { loadConfig } from '../../src/config.js';
import { buildHistory } from '../../src/history.js';
import { buildReport } from '../../src/report.js';
import { writeReport } from '../../src/report-cmd.js';
import { scriptedBacklog } from '../helpers/scripted-backlog.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'charts');

/** The scripted fixture's report data, built once. */
let fixture;
function fixtureReport() {
  if (!fixture) {
    const { dir } = scriptedBacklog();
    const config = loadConfig({ backlogRoot: dir });
    fixture = { dir, config, data: buildReport(buildHistory(config), config) };
  }
  return fixture;
}

/** A stub adapter: a marker line per chart and one file per chart. */
const stub = {
  name: 'stub',
  render: (chart) => ({
    markdown: `STUB ${chart.id}`,
    files: [{ path: `charts/${chart.id}.txt`, content: `${chart.title}\n` }],
  }),
};

test("buildReport's charts: backlog, flow, throughput, each theme, open epic and feature not done, cost", () => {
  const { data } = fixtureReport();
  assert.deepEqual(
    data.charts.map((c) => c.id),
    ['burnup-backlog', 'flow', 'throughput', 'burnup-theme-demo', 'burnup-epic-E50', 'burnup-feature-F-1', 'cost'],
  );
  // F-1 listed S-1 and S-2 until 2026-04-28, then S-1 and S-3 (S-3 was added on 2026-04-25).
  const f1 = data.charts.find((c) => c.id === 'burnup-feature-F-1');
  assert.deepEqual(
    Object.fromEntries(f1.series.map((s) => [s.name, s.values.map((v) => `${v.x}=${v.y}`)])),
    {
      scope: ['2026-04-20=8', '2026-04-27=11'],
      remaining: ['2026-04-20=8', '2026-04-27=8'],
      done: ['2026-04-20=0', '2026-04-27=3'],
    },
    'no backfilled series: features start at the first commit',
  );
});

test('backfilled weeks are a separate dashed scope series that meets the solid one', () => {
  const { data } = fixtureReport();
  const backlog = data.charts.find((c) => c.id === 'burnup-backlog');
  const scope = backlog.series.find((s) => s.name === 'scope');
  const backfilled = backlog.series.find((s) => s.name === 'scope (backfilled)');
  assert.equal(backfilled.dash, true);
  assert.equal(backfilled.kind, 'line');
  // The weeks of 2026-04-06 and -13 are before the first commit (2026-04-21).
  assert.deepEqual(
    backfilled.values.map((v) => v.x),
    ['2026-04-06', '2026-04-13', '2026-04-20'],
  );
  assert.deepEqual(
    scope.values.map((v) => v.x),
    ['2026-04-20', '2026-04-27'],
  );
  assert.ok(!scope.dash);
});

test('vega-lite specs over the fixture equal the checked-in JSON', () => {
  const { data } = fixtureReport();
  // burnup-backlog: a dashed series; flow: stacked areas; throughput: layered line and bar;
  // cost: stacked bars on a category axis.
  for (const id of ['burnup-backlog', 'flow', 'throughput', 'cost']) {
    const spec = toSpec(data.charts.find((c) => c.id === id));
    const file = join(FIXTURES, `${id}.json`);
    if (process.env.UPDATE_CHART_FIXTURES) writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
    assert.deepEqual(spec, JSON.parse(readFileSync(file, 'utf8')), id);
  }
});

test("the spec's layers: stacking, the dash, bars by week, the fixed colours", () => {
  const { data } = fixtureReport();
  const spec = (id) => toSpec(data.charts.find((c) => c.id === id));
  const flow = spec('flow');
  assert.equal(flow.layer.length, 1);
  assert.equal(flow.layer[0].mark.type, 'area');
  assert.equal(flow.layer[0].encoding.y.stack, 'zero');
  assert.deepEqual(flow.layer[0].encoding.color.scale, {
    domain: ['done', 'in progress', 'refined', 'backlog'],
    range: COLOURS,
  });
  const burnup = spec('burnup-backlog');
  assert.deepEqual(
    burnup.layer.map((l) => [l.mark.type, l.mark.strokeDash ?? null, l.encoding.y.stack, l.transform[0].filter.oneOf]),
    [
      ['area', null, null, ['done']],
      ['line', null, null, ['scope', 'remaining']],
      ['line', [6, 4], null, ['scope (backfilled)']],
    ],
  );
  const tp = spec('throughput');
  assert.deepEqual(
    tp.layer.map((l) => [l.mark.type, l.encoding.x.timeUnit ?? null, l.encoding.x2 ?? null]),
    [
      ['bar', null, { field: 'x2' }],
      ['line', null, null],
    ],
  );
  const cost = spec('cost');
  assert.deepEqual(
    cost.layer.map((l) => [l.mark.type, l.encoding.x.type, l.encoding.x.timeUnit ?? null, l.encoding.y.stack]),
    [['bar', 'ordinal', null, 'zero']],
  );
  assert.deepEqual(cost.layer[0].encoding.x.sort, null, "bars in the chart's order");
  for (const s of [flow, burnup, tp]) {
    assert.equal(s.width, 'container');
    assert.equal(s.background, undefined, "no colours but the series'");
    for (const l of s.layer) {
      assert.equal(l.encoding.x.type, 'temporal');
      assert.equal(l.encoding.y.scale.zero, true);
    }
  }
});

test('every spec has $schema, inline data.values, title and description, fenced as vega-lite', () => {
  const { data } = fixtureReport();
  const { markdownById, files } = renderCharts(data.charts, 'vega-lite');
  assert.deepEqual(files, []);
  for (const chart of data.charts) {
    const md = markdownById[chart.id];
    assert.ok(md.startsWith('```vega-lite\n') && md.endsWith('\n```'), chart.id);
    const spec = JSON.parse(md.slice('```vega-lite\n'.length, -'\n```'.length));
    assert.equal(spec.$schema, SCHEMA);
    assert.ok(Array.isArray(spec.data.values) && spec.data.values.length > 0, chart.id);
    assert.equal(spec.title, chart.title);
    assert.equal(spec.description, chart.desc);
  }
});

test("a stub adapter's markdown takes each chart's place in index.md and its files are written", () => {
  registerAdapter(stub);
  const { dir, config, data } = fixtureReport();
  const out = join(dir, '.bl', 'stub-report');
  const page = writeReport(config, out, data, 'stub');
  const text = readFileSync(page, 'utf8');
  for (const chart of data.charts) {
    assert.ok(text.includes(`STUB ${chart.id}`), chart.id);
    assert.equal(readFileSync(join(out, 'charts', `${chart.id}.txt`), 'utf8'), `${chart.title}\n`);
  }
  assert.ok(!text.includes('<!-- chart:'), 'no placeholder left');
  assert.match(text, /### F-1 · Feature one\n\nSTUB burnup-feature-F-1/);

  // The next run removes the last run's files first.
  registerAdapter({ name: 'stub-2', render: (chart) => ({ markdown: `TWO ${chart.id}`, files: [] }) });
  writeReport(config, out, data, 'stub-2');
  assert.ok(!existsSync(join(out, 'charts')));
  assert.match(readFileSync(page, 'utf8'), /TWO flow/);

  // An adapter file may not replace the report's own.
  registerAdapter({
    name: 'clash',
    render: (chart) => ({ markdown: '', files: chart.id === 'flow' ? [{ path: './data.json', content: '{}' }] : [] }),
  });
  assert.throws(() => writeReport(config, out, data, 'clash'), /would replace the report's own/);
  assert.match(readFileSync(page, 'utf8'), /TWO flow/, 'and the last report stays');
});
