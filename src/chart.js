/**
 * chart.js — the report's charts as a neutral model, and the registry of the
 * adapters that render them (F-40 Design D4, Decision A2).
 *
 * `src/report.js` builds `Chart` objects as plain data and knows no adapter.
 * An adapter turns one `Chart` into the markdown that takes the chart's place
 * in `reports/index.md`, plus any files to write under the output directory
 * (paths relative to it). Adapters register themselves on import
 * (`registerAdapter`); `bl report --charts <name>` picks one, `vega-lite`
 * (`src/chart-adapters/vega-lite.js`) by default.
 */

/**
 * @typedef {{ name: string, kind: "line"|"area"|"bar", stack?: string, dash?: boolean,
 *   values: { x: string, y: number }[] }} ChartSeries  x is an ISO date (week start) or a label
 * @typedef {{ id: string, title: string, desc: string, x: "time"|"category",
 *   yTitle: string, series: ChartSeries[] }} Chart
 * @typedef {{ name: string,
 *   render(chart: Chart): { markdown: string, files: { path: string, content: string }[] } }} ChartAdapter
 */

import { posix } from 'path';

/** The adapter `bl report` uses when `--charts` is not given. */
export const DEFAULT_ADAPTER = 'vega-lite';

/** @type {Map<string, ChartAdapter>} */
const registry = new Map();

/**
 * Register `chartAdapter` under its `name`. Registering a name again replaces
 * the earlier adapter, so a module that registers on import may load twice.
 * @param {ChartAdapter} chartAdapter
 */
export function registerAdapter(chartAdapter) {
  if (!chartAdapter || typeof chartAdapter.name !== 'string' || chartAdapter.name === '') {
    throw new Error('a chart adapter needs a name');
  }
  if (typeof chartAdapter.render !== 'function') throw new Error(`chart adapter ${chartAdapter.name} has no render()`);
  registry.set(chartAdapter.name, chartAdapter);
}

/** The registered adapters' names, sorted. */
export function adapterNames() {
  return [...registry.keys()].sort();
}

/**
 * The adapter registered as `name`; throws, naming the registered ones, when
 * there is none.
 * @param {string} name
 * @returns {ChartAdapter}
 */
export function adapter(name) {
  const found = registry.get(name);
  if (!found) {
    const names = adapterNames();
    throw new Error(`unknown chart adapter "${name}"; registered: ${names.length > 0 ? names.join(', ') : 'none'}`);
  }
  return found;
}

/**
 * `path` as `renderCharts` returns it: `/`-separated, without `.` segments,
 * repeated or trailing separators (`./a//b/.` → `a/b`); null when it is
 * absolute, leaves the output directory or names the directory itself.
 * @param {string} path
 * @returns {string | null}
 */
export function outputPath(path) {
  const slashed = String(path).replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const norm = posix.normalize(slashed).replace(/\/+$/, '');
  return norm === '' || norm === '.' || norm === '..' || norm.startsWith('../') ? null : norm;
}

/** Whether output paths `a` and `b` (`outputPath`'s) name one file, or one is a directory holding the other. */
export function pathsClash(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Render every chart with the adapter `name`: each chart's markdown by its
 * id, and every file the adapter returned, its path normalized
 * (`outputPath`). A file path that is absolute, leaves the output directory,
 * or names a file another one does or a directory holding it throws.
 * @param {Chart[]} charts
 * @param {string} [name]
 * @returns {{ markdownById: Record<string, string>, files: { path: string, content: string }[] }}
 */
export function renderCharts(charts, name = DEFAULT_ADAPTER) {
  const chosen = adapter(name);
  /** @type {Record<string, string>} */
  const markdownById = {};
  const files = [];
  for (const chart of charts) {
    const out = chosen.render(chart);
    markdownById[chart.id] = out.markdown;
    for (const file of out.files ?? []) {
      const path = outputPath(file.path);
      if (path === null) {
        throw new Error(
          `chart adapter ${name}: file path ${JSON.stringify(file.path)} is not inside the output directory`,
        );
      }
      const other = files.find((f) => pathsClash(f.path, path));
      if (other) throw new Error(`chart adapter ${name}: file ${file.path} clashes with ${other.path}`);
      files.push({ ...file, path });
    }
  }
  return { markdownById, files };
}
