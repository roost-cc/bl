/**
 * Chart adapters (F-40 Design D4) over in-memory charts: the registry in
 * `src/chart.js`, `renderCharts`' output paths, and the `vega-lite`
 * adapter's specs. `test/integration/chart.test.js` draws the scripted
 * fixture repo's charts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { adapter, adapterNames, DEFAULT_ADAPTER, registerAdapter, renderCharts } from '../../src/chart.js';
import { SCHEMA, toSpec, vegaLite } from '../../src/chart-adapters/vega-lite.js';
import { writeReport } from '../../src/report-cmd.js';

/** A stub adapter: a marker line per chart and one file per chart. */
const stub = {
  name: 'stub',
  render: (chart) => ({
    markdown: `STUB ${chart.id}`,
    files: [{ path: `charts/${chart.id}.txt`, content: `${chart.title}\n` }],
  }),
};

test('the registry: vega-lite is the default; an unknown name throws naming the registered adapters', () => {
  registerAdapter(stub);
  assert.equal(DEFAULT_ADAPTER, 'vega-lite');
  assert.equal(adapter('vega-lite'), vegaLite);
  assert.equal(adapter('stub'), stub);
  assert.ok(adapterNames().includes('vega-lite') && adapterNames().includes('stub'));
  assert.throws(() => adapter('svg'), /unknown chart adapter "svg"; registered: .*stub.*vega-lite|vega-lite.*stub/);
  assert.throws(() => registerAdapter({ name: '', render() {} }), /needs a name/);
  assert.throws(() => registerAdapter({ name: 'x' }), /has no render\(\)/);
});

test("renderCharts gives each chart's markdown by id and every file; paths stay inside the output", () => {
  registerAdapter(stub);
  const charts = [
    { id: 'a', title: 'A', desc: '', x: 'time', yTitle: '', series: [] },
    { id: 'b', title: 'B', desc: '', x: 'time', yTitle: '', series: [] },
  ];
  assert.deepEqual(renderCharts(charts, 'stub'), {
    markdownById: { a: 'STUB a', b: 'STUB b' },
    files: [
      { path: 'charts/a.txt', content: 'A\n' },
      { path: 'charts/b.txt', content: 'B\n' },
    ],
  });
  for (const path of ['../out.txt', '/tmp/out.txt', 'a/../../b', '.']) {
    registerAdapter({ name: 'bad', render: () => ({ markdown: '', files: [{ path, content: '' }] }) });
    assert.throws(() => renderCharts(charts.slice(0, 1), 'bad'), /not inside the output directory/, path);
  }
  registerAdapter({ name: 'bad', render: () => ({ markdown: '', files: [{ path: 'same.txt', content: '' }] }) });
  assert.throws(() => renderCharts(charts, 'bad'), /clashes with same\.txt/);
  assert.throws(() => renderCharts(charts, 'nope'), /unknown chart adapter/);
});

test('adapter normalized paths cannot alias another output or a reserved report file', () => {
  const chart = { id: 'a', title: 'A', desc: '', x: 'time', yTitle: '', series: [] };
  const files = (paths) => {
    registerAdapter({
      name: 'paths',
      render: () => ({ markdown: '', files: paths.map((path) => ({ path, content: '' })) }),
    });
    return () => renderCharts([chart], 'paths');
  };
  // Each pair names one file, or a file and a directory holding it.
  for (const pair of [
    ['a.txt', './a.txt'],
    ['a/b.txt', 'a//b.txt'],
    ['a/b.txt', 'a/./b.txt'],
    ['a/b.txt', 'a/c/../b.txt'],
    ['a/b.txt', 'a\\b.txt'],
    ['a.txt', 'a.txt/'],
    ['a.txt', 'a.txt/.'],
    ['a', 'a/b.txt'],
    ['a/b.txt', 'a'],
  ]) {
    assert.throws(files(pair), /clashes with/, pair.join(' vs '));
  }
  // Paths come back normalized, as they are written.
  assert.deepEqual(
    files(['./x//y/./z.txt', 'w/'])().files.map((f) => f.path),
    ['x/y/z.txt', 'w'],
  );
  // The report's own files, however spelled, and directories in their place.
  for (const path of [
    'data.json',
    './data.json',
    'data.json/.',
    'index.md/.',
    '.gitignore/.',
    'x/../index.md',
    'data.json/x',
  ]) {
    files([path]);
    // The clash is found before anything is written: neither the config nor the directory is touched.
    assert.throws(
      () => writeReport({}, '/nonexistent/report', { charts: [chart] }, null, 'paths'),
      /would replace the report's own/,
      path,
    );
  }
});

test('weekly bars retain ISO Monday coordinates including year boundaries', () => {
  // Mondays across the 2025/2026 year boundary (ISO 2026-W01 starts 2025-12-29) and an ordinary week.
  const mondays = ['2025-12-22', '2025-12-29', '2026-01-05', '2026-04-27'];
  const spec = toSpec({
    id: 't',
    title: 'T',
    desc: '',
    x: 'time',
    yTitle: 'Points',
    series: [
      { name: 'points', kind: 'bar', values: mondays.map((x) => ({ x, y: 1 })) },
      { name: 'average', kind: 'line', values: mondays.map((x) => ({ x, y: 1 })) },
    ],
  });
  const bars = spec.data.values.filter((v) => v.series === 'points');
  assert.deepEqual(
    bars.map((v) => [v.x, v.x2]),
    [
      ['2025-12-22', '2025-12-29'],
      ['2025-12-29', '2026-01-05'],
      ['2026-01-05', '2026-01-12'],
      ['2026-04-27', '2026-05-04'],
    ],
  );
  // The line's points stay on the same Mondays the bars start on.
  assert.deepEqual(
    spec.data.values.filter((v) => v.series === 'average').map((v) => [v.x, v.x2]),
    mondays.map((x) => [x, undefined]),
  );
  // No layer re-bins x into a calendar week of the library's.
  for (const layer of spec.layer) assert.equal(layer.encoding.x.timeUnit, undefined);
  // A category chart's bars have no interval.
  const cat = toSpec({
    id: 'c',
    title: 'C',
    desc: '',
    x: 'category',
    yTitle: '',
    series: [{ name: 'a', kind: 'bar', values: [{ x: 'F-1', y: 1 }] }],
  });
  assert.equal(cat.data.values[0].x2, undefined);
  assert.equal(cat.layer[0].encoding.x2, undefined);
});

test('unit chart tests use only in-memory fixtures', () => {
  // src/AGENTS.md: unit tests do not spawn. F-40's unit tests import no helper
  // that builds a git repo or runs bl, and no child_process.
  for (const name of ['chart', 'history', 'report', 'report-cost']) {
    const source = readFileSync(join(import.meta.dirname, `${name}.test.js`), 'utf8');
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    for (const from of imports) {
      assert.ok(
        !/scripted-backlog|git-backlog|run-bl|child_process|tempdir/.test(from),
        `test/unit/${name}.test.js imports ${from}`,
      );
    }
  }
});

test('an empty series, or no series at all, renders a valid spec', () => {
  const empty = toSpec({
    id: 'e',
    title: 'Empty',
    desc: 'Nothing yet',
    x: 'category',
    yTitle: 'Points',
    series: [{ name: 'a', kind: 'bar', values: [] }],
  });
  assert.deepEqual(empty.data, { values: [] });
  assert.equal(empty.layer.length, 1);
  assert.deepEqual(empty.layer[0].encoding.x, { field: 'x', type: 'ordinal', title: null, sort: null });
  const none = toSpec({ id: 'n', title: 'None', desc: '', x: 'time', yTitle: 'Points', series: [] });
  assert.deepEqual(none.data, { values: [] });
  assert.equal(none.mark, 'line');
  assert.equal(none.layer, undefined);
  assert.equal(none.$schema, SCHEMA);
});
