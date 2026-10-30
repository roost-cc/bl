/**
 * vega-lite.js — the `vega-lite` chart adapter (F-40 Design D4, Decision A2):
 * each `Chart` becomes a fenced block with the language `vega-lite` holding one
 * Vega-Lite v5 spec, which up-doc draws in the browser (S-1090). It writes no
 * files. Registered on import.
 *
 * The spec: data inline as rows `{ series, x, y, order }`, `title` and
 * `description` from the chart, `width: "container"`, the y axis from zero, a
 * temporal x axis in UTC (the dates are UTC days) labelled by month for
 * `time` charts (ordinal, in the
 * chart's order, for `category`), and one layer per kind of mark (areas, then
 * bars, then lines, so lines are drawn on top), filtered to its series. A bar
 * on a time axis spans its ISO week explicitly, from its Monday `x` to the
 * next Monday `x2`: Vega-Lite's `utcyearweek` starts weeks on Sunday.
 * Stacked series share a layer stacked from zero; a `dash` series is a dashed
 * line. Colours follow the series' order through a fixed colour-blind-safe
 * scale (Okabe-Ito blue, orange, green, grey); light and dark themes are
 * up-doc's job, so the spec sets no background or text colour.
 */

import { registerAdapter } from '../chart.js';

export const SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json';

/** Okabe-Ito blue, orange, green and grey, then reused in turn. */
export const COLOURS = ['#0072B2', '#E69F00', '#009E73', '#999999'];

const DASH = [6, 4];

/** The Monday after the week starting `monday` (YYYY-MM-DD). */
const nextWeek = (monday) => new Date(Date.parse(`${monday}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
const KIND_ORDER = ['area', 'bar', 'line'];

/**
 * The Vega-Lite spec for `chart`.
 * @param {import("../chart.js").Chart} chart
 */
export function toSpec(chart) {
  const names = chart.series.map((s) => s.name);
  const time = chart.x === 'time';
  const values = chart.series.flatMap((s, order) =>
    s.values.map((v) => ({
      series: s.name,
      x: v.x,
      ...(time && s.kind === 'bar' ? { x2: nextWeek(v.x) } : {}),
      y: v.y,
      order,
    })),
  );

  const x = time
    ? {
        field: 'x',
        type: 'temporal',
        title: null,
        scale: { type: 'utc' },
        axis: { format: '%b %Y', tickCount: 'month' },
      }
    : { field: 'x', type: 'ordinal', title: null, sort: null };
  const color = {
    field: 'series',
    type: 'nominal',
    title: null,
    scale: { domain: names, range: names.map((_, i) => COLOURS[i % COLOURS.length]) },
    legend: { orient: 'bottom' },
  };
  const tooltip = [
    { field: 'series', type: 'nominal', title: 'Series' },
    time
      ? { field: 'x', type: 'temporal', timeUnit: 'utcyearmonthdate', title: 'Week of', format: '%Y-%m-%d' }
      : { field: 'x', type: 'ordinal', title: '' },
    { field: 'y', type: 'quantitative', title: chart.yTitle },
  ];

  // One layer per kind, stack and dash, in KIND_ORDER then first appearance.
  const groups = new Map();
  for (const s of chart.series) {
    const key = JSON.stringify([s.kind, s.stack ?? null, Boolean(s.dash)]);
    if (!groups.has(key)) groups.set(key, { kind: s.kind, stack: s.stack ?? null, dash: Boolean(s.dash), names: [] });
    groups.get(key).names.push(s.name);
  }
  const layers = [...groups.values()]
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((g) => {
      const mark =
        g.kind === 'line'
          ? { type: 'line', point: true, ...(g.dash ? { strokeDash: DASH } : {}) }
          : g.kind === 'area'
            ? { type: 'area', opacity: g.stack ? 0.85 : 0.35, line: true }
            : { type: 'bar' };
      return {
        transform: [{ filter: { field: 'series', oneOf: g.names } }],
        mark,
        encoding: {
          x,
          // Weekly bars on a time axis span their ISO week, Monday to Monday.
          ...(g.kind === 'bar' && time ? { x2: { field: 'x2' } } : {}),
          y: {
            field: 'y',
            type: 'quantitative',
            title: chart.yTitle,
            scale: { zero: true },
            stack: g.stack ? 'zero' : null,
          },
          color,
          ...(g.stack ? { order: { field: 'order', type: 'quantitative' } } : {}),
          tooltip,
        },
      };
    });

  return {
    $schema: SCHEMA,
    title: chart.title,
    description: chart.desc,
    width: 'container',
    data: { values },
    // A chart with no series still needs a mark to be a valid spec.
    ...(layers.length > 0
      ? { layer: layers }
      : {
          mark: 'line',
          encoding: { x, y: { field: 'y', type: 'quantitative', title: chart.yTitle, scale: { zero: true } } },
        }),
  };
}

/** @type {import("../chart.js").ChartAdapter} */
export const vegaLite = {
  name: 'vega-lite',
  render(chart) {
    return { markdown: '```vega-lite\n' + JSON.stringify(toSpec(chart), null, 2) + '\n```', files: [] };
  },
};

registerAdapter(vegaLite);
