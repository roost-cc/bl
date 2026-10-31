/**
 * report.js — the backlog progress report's numbers (F-40 Design D3, D5).
 *
 * `buildReport(history, config, flow)` turns `buildHistory`'s snapshots and the
 * current tree into one plain data object (what `reports/data.json` holds);
 * `renderMarkdown(data, markdownById, flow)` turns that into `reports/index.md`. The parts are
 * exported one by one (`latest`, `series`, `firstSeen`, `throughput`,
 * `leadCycle`, `ages`, `percentile`, `units`, `cost`, `efficiency`) so
 * `bl retro` (S-905) computes the same figures. `bl report`
 * (`report-cmd.js`) writes the files.
 *
 * Counts and tables are the last snapshot's: each story's status and points,
 * each feature's status and `stories:` as committed that day. Titles, links
 * and grouping come from the current tree (Design D2). Charts are `Chart`
 * models (`src/chart.js`, Design D4) in `data.charts`; this module imports
 * no adapter. `renderMarkdown` takes each chart's markdown by id from the
 * adapter's `renderCharts`, and leaves a placeholder line
 * (`chartPlaceholder`) for a chart it was not given.
 */

import { readFileSync } from 'fs';
import { dirname } from 'path';
import { COMPONENTS_DIR, EPICS_DIR, STORIES_DIR, THEMES_DIR, parseFrontmatterOf } from './config.js';
import { listChanges, readChange } from './change-doc.js';
import { FEATURES_DIR, normalizeFeatureId, readAllFeatures } from './feature.js';
import { readAllStories, readComponents } from './story.js';
import { readAllEpics, readAllThemes } from './theme.js';
import { formatTable } from './sync.js';
import { addDays, isoWeek, pointsByStatus, scopeStories, weeklyDays } from './history.js';

/** Bumped whenever `data.json`'s shape changes. */
export const REPORT_VERSION = 3;

/** Weeks the throughput table covers, and the trailing average's width. */
export const THROUGHPUT_WEEKS = 26;
export const AVERAGE_WEEKS = 4;

/** Days before the last snapshot that lead and cycle time cover. */
export const LEAD_CYCLE_DAYS = 90;

/**
 * @typedef {import("./history.js").Day} Day
 * @typedef {import("./history.js").Groups} Groups
 * @typedef {{ days: Day[], earlier?: Day[], groups: Groups, unreadable: number }} History
 * @typedef {{ scope: number, done: number, remaining: number, percent: number | null }} Progress
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Whole days from `a` to `b` (YYYY-MM-DD). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** The Monday of `date`'s ISO week. */
export function weekStart(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return addDays(date, 1 - weekday);
}

/**
 * The `p` quantile (0..1) of `values` by linear interpolation between the
 * closest ranks, so `percentile(v, 0.5)` is the usual median; null when empty.
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

const round1 = (n) => Math.round(n * 10) / 10;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ''));
const byNum = (a, b) => Number(String(a).replace(/\D/g, '')) - Number(String(b).replace(/\D/g, ''));

/** `counts` keys in `order`, then any others sorted. */
function ordered(counts, order) {
  return [
    ...order.filter((s) => s in counts),
    ...Object.keys(counts)
      .filter((s) => !order.includes(s))
      .sort(),
  ];
}

/** Scope, done, remaining and percent done over `stories` (snapshots). Superseded stories are out of scope. */
export function progress(stories) {
  let scope = 0;
  let done = 0;
  for (const s of stories) {
    if (s.status === 'superseded') continue;
    scope += s.points;
    if (s.status === 'done') done += s.points;
  }
  return { scope, done, remaining: scope - done, percent: scope > 0 ? Math.round((done / scope) * 100) : null };
}

// ---------------------------------------------------------------------------
// Metrics (Design D3)
// ---------------------------------------------------------------------------

/** The last snapshot, or null when the history holds none. */
export function latest(history) {
  return history.days.at(-1) ?? null;
}

/**
 * Scope, done and remaining of `scope` per day, and per ISO week (the last
 * snapshot in each).
 * @param {History} history
 * @param {import("./history.js").Scope} scope
 */
export function series(history, scope = { kind: 'backlog' }) {
  const point = (day) => {
    const ids = scopeStories(day, scope, history.groups);
    const { scope: sc, done, remaining } = progress(ids.map((id) => day.stories[id]));
    return { date: day.date, backfilled: day.backfilled, scope: sc, done, remaining };
  };
  const daily = history.days.map(point);
  const weekly = weeklyDays(history.days).map(({ week, day }) => ({ week, start: weekStart(day.date), ...point(day) }));
  return { daily, weekly };
}

/**
 * The first date the report shows: its first day when `--since` cut earlier
 * days off, else "" (no cutoff).
 * @param {History} history
 */
function cutoff(history) {
  return history.earlier?.length > 0 ? (history.days[0]?.date ?? '') : '';
}

/**
 * Each story's first day in a started status (one `Flow.isRunnable` accepts:
 * this starts its cycle time and a work item's age) and its first day `done`,
 * with its points that day, read over the days
 * before a `--since` cutoff too (`history.earlier`). A backfilled day shows
 * `done` from the story's `completed` date, so that date stands in before the
 * first commit (Design D3).
 * @param {History} history
 * @param {import("./flow.js").Flow} flow
 * @returns {Map<string, { started: string, done: string, points: number }>}
 */
export function firstSeen(history, flow) {
  const out = new Map();
  for (const day of [...(history.earlier ?? []), ...history.days]) {
    for (const [id, s] of Object.entries(day.stories)) {
      let seen = out.get(id);
      if (!seen) out.set(id, (seen = { started: '', done: '', points: 0 }));
      if (!seen.started && !seen.done && flow.isRunnable('story', s.status)) seen.started = day.date;
      if (!seen.done && s.status === 'done') {
        seen.done = day.date;
        seen.points = s.points;
      }
    }
  }
  return out;
}

/**
 * Points and stories reaching `done` per ISO week, for the `weeks` weeks
 * ending with the last snapshot's (none before a `--since` cutoff's week),
 * each with the trailing `AVERAGE_WEEKS` average (the week and the ones
 * before it, across the cutoff).
 * @param {History} history
 * @param {{ weeks?: number, seen: ReturnType<typeof firstSeen> }} options
 */
export function throughput(history, { weeks = THROUGHPUT_WEEKS, seen }) {
  const last = latest(history);
  if (!last) return { weeks: [], averagePoints: 0, averageStories: 0 };
  const perWeek = new Map();
  for (const { done, points } of seen.values()) {
    if (!done) continue;
    const w = perWeek.get(isoWeek(done)) ?? { points: 0, stories: 0 };
    w.points += points;
    w.stories += 1;
    perWeek.set(isoWeek(done), w);
  }
  const lastStart = weekStart(last.date);
  const firstStart = cutoff(history) ? weekStart(cutoff(history)) : '';
  const at = (start) => perWeek.get(isoWeek(start)) ?? { points: 0, stories: 0 };
  const rows = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(lastStart, -7 * i);
    if (start < firstStart) continue;
    const window = Array.from({ length: AVERAGE_WEEKS }, (_, k) => at(addDays(start, -7 * k)));
    rows.push({
      week: isoWeek(start),
      start,
      ...at(start),
      avgPoints: round1(window.reduce((sum, w) => sum + w.points, 0) / AVERAGE_WEEKS),
      avgStories: round1(window.reduce((sum, w) => sum + w.stories, 0) / AVERAGE_WEEKS),
    });
  }
  return { weeks: rows, averagePoints: rows.at(-1)?.avgPoints ?? 0, averageStories: rows.at(-1)?.avgStories ?? 0 };
}

/**
 * Lead time (`added` → first `done`) and cycle time (first started day, as
 * `firstSeen` reads it → first `done`) in days, over the stories first done in the
 * `days` days up to the last snapshot, and not before a `--since` cutoff:
 * count, median and 85th percentile, to a tenth of a day.
 * @param {History} history
 * @param {{ days?: number, seen: ReturnType<typeof firstSeen> }} options
 */
export function leadCycle(history, { days = LEAD_CYCLE_DAYS, seen }) {
  const last = latest(history);
  const window = last ? addDays(last.date, -days) : '';
  const from = cutoff(history) > window ? cutoff(history) : window;
  const items = [];
  // No days (a `--since` after the last snapshot): an empty window, though `earlier` holds completions.
  for (const [id, s] of last ? seen : []) {
    if (!s.done || s.done < from) continue;
    const added = history.groups.stories[id]?.added ?? '';
    const lead = isDate(added) && added <= s.done ? daysBetween(added, s.done) : null;
    const cycle = s.started ? daysBetween(s.started, s.done) : null;
    items.push({ id, added: isDate(added) ? added : '', started: s.started, done: s.done, lead, cycle });
  }
  items.sort((a, b) => (a.done < b.done ? -1 : a.done > b.done ? 1 : byNum(a.id, b.id)));
  const tenth = (v) => (v === null ? null : round1(v));
  const stat = (values) => ({
    count: values.length,
    median: tenth(percentile(values, 0.5)),
    p85: tenth(percentile(values, 0.85)),
  });
  return {
    from,
    to: last?.date ?? '',
    lead: stat(items.map((i) => i.lead).filter((v) => v !== null)),
    cycle: stat(items.map((i) => i.cycle).filter((v) => v !== null)),
    items,
  };
}

/**
 * Work item age: each runnable story (`Flow.isRunnable`) in the last snapshot,
 * with the day it was first started and the days since, oldest first.
 * @param {History} history
 * @param {import("./flow.js").Flow} flow
 */
export function ages(history, flow, { seen = firstSeen(history, flow) } = {}) {
  const last = latest(history);
  if (!last) return [];
  return Object.entries(last.stories)
    .filter(([, s]) => flow.isRunnable('story', s.status))
    .map(([id, s]) => {
      const since = seen.get(id)?.started || last.date;
      return { id, status: s.status, points: s.points, since, days: daysBetween(since, last.date) };
    })
    .sort((a, b) => b.days - a.days || byNum(a.id, b.id));
}

/**
 * The review round of a unit's highest-numbered `change*.md`, or null when it
 * has none (or it records none).
 */
export function reviewRoundOf(unitDir) {
  const change = listChanges(unitDir).at(-1);
  const raw = change ? readChange(change.path)?.fm.review_round : undefined;
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Cost and token efficiency (Design D3 Cost, D7)
// ---------------------------------------------------------------------------

/** The four token kinds, as the `tokens_<kind>` frontmatter fields name them. */
export const TOKEN_KINDS = ['input', 'output', 'cache_creation', 'cache_read'];

/** Unit types in table order (`feature` for a feature, else the story's `type`); any other follows. */
export const UNIT_TYPE_ORDER = ['feature', 'chore', 'bug', 'update'];

/** Review rounds from which a unit counts as many-round in the review-round effect (D7). */
export const MANY_ROUNDS = 3;

/** Units the cost chart shows, by output tokens. */
export const COST_CHART_UNITS = 20;

/**
 * @typedef {Record<"input"|"output"|"cache_creation"|"cache_read", number>} Tokens
 * @typedef {{ id: string, kind: "feature"|"story", type: string, title: string, link: string,
 *   status: string, done: boolean, points: number, reviewRound: number | null,
 *   tokens: Tokens | null, headless: Tokens | null, updated: string,
 *   steps: Record<string, Tokens> | null }} Unit
 */

const toNum = (v) => {
  const n = Number(String(v ?? '').trim());
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};

/**
 * The four kinds under `prefix` (`tokens_` or `tokens_headless_`) in `fm`, or
 * null when it holds none of them; a missing kind among present ones is 0.
 */
export function tokenFields(fm, prefix = 'tokens_') {
  const values = TOKEN_KINDS.map((k) => toNum(fm?.[`${prefix}${k}`]));
  if (values.every((v) => v === null)) return null;
  return Object.fromEntries(TOKEN_KINDS.map((k, i) => [k, values[i] ?? 0]));
}

/**
 * The per-step tokens S-904 records as `tokens_by_step` (`<step>[.<round>]`
 * → the four kinds), summed per step name; null when the unit has none.
 */
export function stepTokens(fm) {
  const map = fm?.tokens_by_step;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    const t = tokenFields(value, '');
    if (!t) continue;
    const step = key.split('.')[0];
    out[step] = addTokens(out[step], t);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function addTokens(a, b) {
  return Object.fromEntries(TOKEN_KINDS.map((k) => [k, (a?.[k] ?? 0) + (b?.[k] ?? 0)]));
}

const sumTokens = (list) => list.reduce((acc, t) => addTokens(acc, t), addTokens(null, null));
const total = (t) => TOKEN_KINDS.reduce((sum, k) => sum + t[k], 0);

/**
 * The units `bl run` runs, from the current tree: every feature, and every
 * story with no feature (or one naming a feature the tree does not hold, so
 * its tokens are not lost). A feature's points are its listed stories' that
 * are not superseded; its type is `feature`, a story's its `type`.
 * @param {ReturnType<typeof readTree>} tree
 * @returns {Unit[]}
 */
export function units(tree) {
  const storiesById = new Map(tree.stories.map((s) => [s.id, s]));
  const featureIds = new Set(tree.features.map((f) => f.id));
  const record = (base, fm, dir) => ({
    ...base,
    done: base.status === 'done',
    reviewRound: reviewRoundOf(dir),
    tokens: tokenFields(fm),
    headless: tokenFields(fm, 'tokens_headless_'),
    updated: isDate(fm.tokens_updated) ? String(fm.tokens_updated) : '',
    steps: stepTokens(fm),
  });
  const out = tree.features.map((f) =>
    record(
      {
        id: f.id,
        kind: 'feature',
        type: 'feature',
        title: f.title,
        link: link(FEATURES_DIR, f.featureEntry),
        status: f.status,
        points: f.stories
          .map((id) => storiesById.get(id))
          .filter((s) => s && s.status !== 'superseded')
          .reduce((sum, s) => sum + (toNum(s.points) ?? 0), 0),
      },
      f.fm,
      f.featureDir,
    ),
  );
  for (const s of tree.stories) {
    if (featureIds.has(normalizeFeatureId(s.feature)?.id)) continue;
    const fm = parseFrontmatterOf(readFileSync(s.indexPath, 'utf8').replace(/\r\n/g, '\n'), s.indexPath).fm;
    out.push(
      record(
        {
          id: s.id,
          kind: 'story',
          type: s.type || 'feature',
          title: s.title,
          link: link(STORIES_DIR, s.storyEntry),
          status: s.status,
          points: toNum(s.points) ?? 0,
        },
        fm,
        dirname(s.indexPath),
      ),
    );
  }
  return out.sort((a, b) => (a.kind === b.kind ? byNum(a.id, b.id) : a.kind === 'feature' ? -1 : 1));
}

/** Output tokens per point, or null without tokens or points. */
export function outputPerPoint(u) {
  return u.tokens && u.points > 0 ? u.tokens.output / u.points : null;
}

/**
 * The cost table (Design D3): each unit with its tokens, headless share (of
 * all four kinds) and output tokens per point, by output tokens (units
 * without tokens last); the total over the units with tokens; and the
 * average per point over done units with tokens and points (each kind's sum
 * over their points' sum). A unit with no token fields is in the table only.
 * @param {Unit[]} list
 */
export function cost(list) {
  // The headless percentage of all four kinds, to a tenth.
  const share = (tokens, headless) =>
    tokens && total(tokens) > 0 ? round1(((headless ? total(headless) : 0) / total(tokens)) * 100) : null;
  const rows = list
    .map((u) => ({
      ...u,
      headlessShare: share(u.tokens, u.headless),
      outputPerPoint: outputPerPoint(u) === null ? null : Math.round(outputPerPoint(u)),
    }))
    .sort((a, b) => (b.tokens?.output ?? -1) - (a.tokens?.output ?? -1) || byNum(a.id, b.id));
  const withTokens = list.filter((u) => u.tokens);
  const averaged = withTokens.filter((u) => u.done && u.points > 0);
  const points = averaged.reduce((sum, u) => sum + u.points, 0);
  const sums = sumTokens(averaged.map((u) => u.tokens));
  const tokens = sumTokens(withTokens.map((u) => u.tokens));
  const headless = sumTokens(withTokens.map((u) => u.headless).filter(Boolean));
  return {
    units: rows,
    total: { units: withTokens.length, tokens, headless, headlessShare: share(tokens, headless) },
    average: {
      units: averaged.length,
      points,
      perPoint: points > 0 ? Object.fromEntries(TOKEN_KINDS.map((k) => [k, Math.round(sums[k] / points)])) : null,
    },
  };
}

/**
 * The token-efficiency section (Design D7) over done units with tokens and
 * points: output tokens per point by unit type (median, 90th percentile,
 * count); the review-round effect (median for units with 0 to 2 rounds, a
 * unit with no change document counting as 0, and for `MANY_ROUNDS` or
 * more); the per-step tokens summed (null until a unit records them, S-904);
 * and the outliers, units above their type's 90th percentile, highest first.
 * @param {Unit[]} list
 */
export function efficiency(list) {
  const done = list.filter((u) => u.done && outputPerPoint(u) !== null);
  const whole = (v) => (v === null ? null : Math.round(v));
  const types = ordered(Object.fromEntries(done.map((u) => [u.type, true])), UNIT_TYPE_ORDER);
  const byType = types.map((type) => {
    const ratios = done.filter((u) => u.type === type).map(outputPerPoint);
    return { type, count: ratios.length, median: whole(percentile(ratios, 0.5)), p90: whole(percentile(ratios, 0.9)) };
  });
  const rounds = (pick) => {
    const ratios = done.filter((u) => pick(u.reviewRound ?? 0)).map(outputPerPoint);
    return { count: ratios.length, median: whole(percentile(ratios, 0.5)) };
  };
  const stepped = done.filter((u) => u.steps);
  const steps = {};
  for (const u of stepped) for (const [step, t] of Object.entries(u.steps)) steps[step] = addTokens(steps[step], t);
  const p90 = new Map(
    types.map((type) => [type, percentile(done.filter((u) => u.type === type).map(outputPerPoint), 0.9)]),
  );
  const outliers = done
    .filter((u) => outputPerPoint(u) > p90.get(u.type))
    .map((u) => ({
      id: u.id,
      type: u.type,
      title: u.title,
      link: u.link,
      points: u.points,
      reviewRound: u.reviewRound,
      output: u.tokens.output,
      outputPerPoint: Math.round(outputPerPoint(u)),
      steps: u.steps,
    }))
    .sort((a, b) => b.outputPerPoint - a.outputPerPoint || byNum(a.id, b.id));
  return {
    units: done.length,
    byType,
    rounds: { few: rounds((r) => r < MANY_ROUNDS), many: rounds((r) => r >= MANY_ROUNDS) },
    steps: stepped.length > 0 ? steps : null,
    outliers,
  };
}

// ---------------------------------------------------------------------------
// Charts (Design D4): `Chart` models only; an adapter draws them
// ---------------------------------------------------------------------------

/**
 * @typedef {import("./chart.js").Chart} Chart
 */

/**
 * The id of `scope`'s burn-up chart: `burnup-backlog`, or
 * `burnup-<kind>-<id>` (`burnup-theme-backlog`, `burnup-epic-E63`,
 * `burnup-feature-F-40`).
 * @param {import("./history.js").Scope} scope
 */
export function burnupId(scope) {
  return scope.kind === 'backlog' ? 'burnup-backlog' : `burnup-${scope.kind}-${scope.id}`;
}

/**
 * The burn-up/burn-down chart of `scope`: weekly scope and remaining lines
 * and a done area, from the first week with any points. Backfilled weeks
 * (before the first commit) draw scope as a separate dashed "scope
 * (backfilled)" series, which also holds the first committed week so the two
 * lines meet.
 * @param {History} history
 * @param {import("./history.js").Scope} scope
 * @param {string} label  what the chart covers, for its title
 * @returns {Chart}
 */
export function burnupChart(history, scope, label) {
  const all = series(history, scope).weekly;
  const begin = all.findIndex((w) => w.scope > 0 || w.done > 0);
  const weekly = begin === -1 ? [] : all.slice(begin);
  const at = (key) => (w) => ({ x: w.start, y: w[key] });
  const committed = weekly.findIndex((w) => !w.backfilled);
  const backfilled = committed === -1 ? weekly : weekly.slice(0, committed + 1);
  const solid = committed === -1 ? [] : weekly.slice(committed);
  /** @type {import("./chart.js").ChartSeries[]} */
  const out = [
    { name: 'scope', kind: 'line', values: solid.map(at('scope')) },
    { name: 'remaining', kind: 'line', values: weekly.map(at('remaining')) },
    { name: 'done', kind: 'area', values: weekly.map(at('done')) },
  ];
  if (committed !== 0 && weekly.length > 0) {
    out.push({ name: 'scope (backfilled)', kind: 'line', dash: true, values: backfilled.map(at('scope')) });
  }
  return {
    id: burnupId(scope),
    title: `Burn-up: ${label}`,
    desc: `Points in scope, done and remaining per week for ${label}. Read done rising toward scope as a burn-up, remaining falling toward zero as a burn-down.`,
    x: 'time',
    yTitle: 'Points',
    series: out,
  };
}

/**
 * The cumulative flow chart: the backlog's points by status per week, as
 * stacked areas, the last status in `flow.json` at the bottom. Superseded
 * stories are out of scope and left out.
 * @param {History} history
 * @param {import("./flow.js").Flow} flow
 * @returns {Chart}
 */
export function flowChart(history, flow) {
  const statuses = [...flow.statusesOf('story')].reverse().filter((s) => s !== 'superseded');
  const spaced = (s) => s.replaceAll('_', ' ');
  // A name is its series' key, so statuses that would read alike keep their own.
  const names = statuses.map((s) => (statuses.filter((o) => spaced(o) === spaced(s)).length > 1 ? s : spaced(s)));
  const stacked = [names.slice(0, -1).join(', '), ...names.slice(-1)].filter(Boolean).join(' and ');
  const weeks = weeklyDays(history.days).map(({ day }) => ({ x: weekStart(day.date), points: pointsByStatus(day) }));
  return {
    id: 'flow',
    title: 'Cumulative flow',
    desc: `Points by status per week, stacked: ${stacked}. A band that widens is work piling up in that status.`,
    x: 'time',
    yTitle: 'Points',
    series: statuses.map((status, i) => ({
      name: names[i],
      kind: 'area',
      stack: 'status',
      values: weeks.map((w) => ({ x: w.x, y: w.points[status] ?? 0 })),
    })),
  };
}

/**
 * The throughput chart: points reaching `done` per week as bars, and the
 * trailing average as a line.
 * @param {ReturnType<typeof throughput>} t
 * @returns {Chart}
 */
export function throughputChart(t) {
  return {
    id: 'throughput',
    title: 'Throughput',
    desc: `Points reaching done per ISO week, with the trailing ${AVERAGE_WEEKS}-week average.`,
    x: 'time',
    yTitle: 'Points',
    series: [
      { name: 'points done', kind: 'bar', values: t.weeks.map((w) => ({ x: w.start, y: w.points })) },
      {
        name: `${AVERAGE_WEEKS}-week average`,
        kind: 'line',
        values: t.weeks.map((w) => ({ x: w.start, y: w.avgPoints })),
      },
    ],
  };
}

/**
 * The cost chart: output tokens of the `COST_CHART_UNITS` units with the
 * most, as bars stacked by unit type, so each bar takes its type's colour.
 * Every series holds every unit (0 for the others' units), which keeps the
 * bars in the table's order.
 * @param {ReturnType<typeof cost>} c
 * @returns {Chart}
 */
export function costChart(c) {
  const top = c.units.filter((u) => u.tokens).slice(0, COST_CHART_UNITS);
  const types = ordered(Object.fromEntries(top.map((u) => [u.type, true])), UNIT_TYPE_ORDER);
  return {
    id: 'cost',
    title: 'Agent cost',
    desc: `Output tokens of the ${COST_CHART_UNITS} units with the most, coloured by unit type.`,
    x: 'category',
    yTitle: 'Output tokens',
    series: types.map((type) => ({
      name: type,
      kind: 'bar',
      stack: 'type',
      values: top.map((u) => ({ x: u.id, y: u.type === type ? u.tokens.output : 0 })),
    })),
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The current tree's units, for titles, links and grouping. */
export function readTree(config) {
  return {
    stories: readAllStories(config),
    features: readAllFeatures(config),
    epics: readAllEpics(config),
    themes: readAllThemes(config),
    components: readComponents(config),
  };
}

/** A link from `reports/index.md` to a unit's index. */
const link = (dir, entry) => `../${dir}/${entry}/index.md`;

/**
 * The report's data: everything `data.json` holds and `renderMarkdown` draws.
 * @param {History} history  `buildHistory`'s result
 * @param {object} config  `loadConfig()`
 * @param {import("./flow.js").Flow} flow  the run's one flow, which `renderMarkdown` gets too
 * @param {ReturnType<typeof readTree>} [tree]  the current tree, when already read
 */
export function buildReport(history, config, flow, tree = readTree(config)) {
  const last = latest(history) ?? { date: '', commit: null, backfilled: false, stories: {}, features: {} };
  const seen = firstSeen(history, flow);
  const storiesById = new Map(tree.stories.map((s) => [s.id, s]));
  const snaps = (ids) => ids.map((id) => last.stories[id]);
  const scoped = (kind, id) => scopeStories(last, { kind, id }, history.groups);
  const featureStatus = (f) => last.features[f.id]?.status ?? f.status;

  // Summary: the last snapshot's units, by status.
  const stories = {};
  const points = {};
  for (const s of Object.values(last.stories)) {
    stories[s.status] = (stories[s.status] ?? 0) + 1;
    points[s.status] = (points[s.status] ?? 0) + s.points;
  }
  const features = {};
  for (const f of Object.values(last.features)) features[f.status] = (features[f.status] ?? 0) + 1;
  const isOpen = (s) => !flow.meets('story', s.status, 'done');
  const open = Object.values(last.stories).filter(isOpen);

  const epicRows = [...tree.epics]
    .sort((a, b) => byNum(a.id, b.id))
    .map((e) => {
      const own = tree.features.filter((f) => history.groups.features[f.id]?.epic === e.id);
      const closed = own.length > 0 && own.every((f) => flow.meets('feature', featureStatus(f), 'done'));
      return {
        id: e.id,
        title: e.title,
        theme: e.theme,
        link: link(EPICS_DIR, e.epicEntry),
        status: closed ? 'done' : 'open',
        features: own.length,
        ...progress(snaps(scoped('epic', e.id))),
      };
    });
  const epicsByStatus = {};
  for (const e of epicRows) epicsByStatus[e.status] = (epicsByStatus[e.status] ?? 0) + 1;

  const themeRows = [...tree.themes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({
      id: t.id,
      title: t.title,
      link: link(THEMES_DIR, t.themeEntry),
      ...progress(snaps(scoped('theme', t.id))),
    }));

  const featureRows = [...tree.features]
    .sort((a, b) => byNum(a.id, b.id))
    .map((f) => {
      const own = snaps(scoped('feature', f.id));
      const inScope = own.filter((s) => s.status !== 'superseded');
      return {
        id: f.id,
        title: f.title,
        theme: history.groups.features[f.id]?.theme ?? f.theme,
        epic: history.groups.features[f.id]?.epic ?? '',
        link: link(FEATURES_DIR, f.featureEntry),
        status: featureStatus(f),
        storiesDone: inScope.filter((s) => s.status === 'done').length,
        storiesTotal: inScope.length,
        reviewRound: reviewRoundOf(f.featureDir),
        ...progress(own),
      };
    });

  const componentRows = [...tree.components]
    .sort((a, b) => byNum(a.id, b.id))
    .map((c) => ({
      id: c.id,
      title: c.title,
      link: link(COMPONENTS_DIR, c.componentEntry),
      ...progress(snaps(scoped('component', c.id))),
    }));

  const tp = throughput(history, { seen });
  const label = (kind, r) => `${kind} ${r.id} · ${r.title}`;
  const unitList = units(tree);
  const costData = cost(unitList);
  const openFeatureRows = featureRows.filter((f) => !flow.meets('feature', f.status, 'done'));
  const charts = [
    burnupChart(history, { kind: 'backlog' }, 'the backlog'),
    flowChart(history, flow),
    throughputChart(tp),
    ...themeRows.map((t) => burnupChart(history, { kind: 'theme', id: t.id }, label('theme', t))),
    ...epicRows
      .filter((e) => snaps(scoped('epic', e.id)).some(isOpen))
      .map((e) => burnupChart(history, { kind: 'epic', id: e.id }, label('epic', e))),
    ...openFeatureRows.map((f) => burnupChart(history, { kind: 'feature', id: f.id }, label('feature', f))),
    costChart(costData),
  ];

  const storyRef = (id) => {
    const s = storiesById.get(id);
    return { title: s?.title ?? '', link: s ? link(STORIES_DIR, s.storyEntry) : '' };
  };
  const lc = leadCycle(history, { seen });

  return {
    version: REPORT_VERSION,
    snapshot: { date: last.date, commit: last.commit, backfilled: last.backfilled },
    first: history.days[0]?.date ?? '',
    unreadable: history.unreadable,
    summary: {
      themes: tree.themes.length,
      epics: { total: epicRows.length, byStatus: epicsByStatus },
      features: { total: Object.keys(last.features).length, byStatus: features },
      stories: { total: Object.keys(last.stories).length, byStatus: stories },
      points: { total: Object.values(points).reduce((a, b) => a + b, 0), byStatus: points },
      open: { stories: open.length, points: open.reduce((sum, s) => sum + s.points, 0) },
      progress: progress(Object.values(last.stories)),
    },
    series: { backlog: series(history) },
    throughput: tp,
    leadCycle: { ...lc, items: lc.items.map((i) => ({ ...i, ...storyRef(i.id) })) },
    ages: ages(history, flow, { seen }).map((a) => ({ ...a, ...storyRef(a.id) })),
    themes: themeRows,
    epics: epicRows,
    features: featureRows,
    components: componentRows,
    cost: costData,
    efficiency: efficiency(unitList),
    charts,
  };
}

// ---------------------------------------------------------------------------
// Markdown (Design D5)
// ---------------------------------------------------------------------------

/** The line standing in for a chart `renderMarkdown` was given no markdown for. */
export function chartPlaceholder(id) {
  return `<!-- chart: ${id} -->`;
}

/** A table cell's text: one line, a `|` escaped so it ends no cell. */
function cell(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');
}

const ref = (id, href) => (href ? `[${id}](${href})` : id);
const pct = (p) => (p === null ? '—' : `${p}%`);
const num = (n) => (n === null || n === undefined ? '—' : String(Math.round(n * 10) / 10));
/** A token count, whole and grouped by thousands (the report and `bl status`). */
export const tok = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));

function progressTable(rows, first, extra = []) {
  return formatTable(
    [...first.map((c) => c.head), 'Scope', 'Done', 'Remaining', '% done', ...extra.map((c) => c.head)],
    rows.map((r) => [
      ...first.map((c) => c.value(r)),
      r.scope,
      r.done,
      r.remaining,
      pct(r.percent),
      ...extra.map((c) => c.value(r)),
    ]),
  );
}

/**
 * `reports/index.md` from `buildReport`'s data: Summary, Backlog, Flow,
 * Throughput, Lead and cycle time, Themes, Epics, Features, Components,
 * Cost, Token efficiency. Each chart is its markdown from `markdownById`
 * (the chart adapter's `renderCharts`), or its placeholder line; a theme,
 * epic or feature chart follows its section's table under a heading of its
 * own.
 * @param {ReturnType<typeof buildReport>} data
 * @param {Record<string, string>} markdownById
 * @param {import("./flow.js").Flow} flow  orders the status lists; a status it lacks follows them
 * @returns {string}
 */
export function renderMarkdown(data, markdownById, flow) {
  const s = data.summary;
  const out = [];
  const chart = (id) => markdownById[id] ?? chartPlaceholder(id);
  const charted = new Set(data.charts.map((c) => c.id));
  const scopeCharts = (kind, rows) =>
    rows
      .filter((r) => charted.has(burnupId({ kind, id: r.id })))
      .flatMap((r) => [`### ${r.id} · ${cell(r.title)}`, chart(burnupId({ kind, id: r.id }))]);
  const section = (heading, ...parts) => out.push(`## ${heading}`, ...parts.filter((p) => p !== ''));

  out.push('# Backlog progress report');
  const commit = data.snapshot.commit ? ` (commit \`${data.snapshot.commit.slice(0, 12)}\`)` : '';
  out.push(
    data.snapshot.date
      ? `The snapshot of ${data.snapshot.date}${commit}, with history from ${data.first}. Generated by \`bl report\`; run it again to refresh.`
      : 'No snapshots: the backlog has no commits and no dated stories.',
  );

  const byStatus = (counts, order) =>
    ordered(counts, order)
      .map((st) => `${counts[st]} ${st}`)
      .join(', ') || 'none';
  section(
    'Summary',
    [
      `- Themes: ${s.themes}`,
      `- Epics: ${s.epics.total} (${byStatus(s.epics.byStatus, ['open', 'done'])})`,
      `- Features: ${s.features.total} (${byStatus(s.features.byStatus, flow.statusesOf('feature'))})`,
      `- Stories: ${s.stories.total}, ${s.points.total} points`,
      `- Open (not done or superseded): ${s.open.stories} stories, ${s.open.points} points`,
      `- Progress: ${s.progress.done} of ${s.progress.scope} points done (${pct(s.progress.percent)})`,
      ...(data.unreadable > 0
        ? [`- Unreadable: ${data.unreadable} \`index.md\` blob(s) in the history were skipped`]
        : []),
    ].join('\n'),
    formatTable(
      ['Status', 'Stories', 'Points'],
      ordered(s.stories.byStatus, flow.statusesOf('story')).map((st) => [
        st,
        s.stories.byStatus[st],
        s.points.byStatus[st] ?? 0,
      ]),
    ),
  );

  section('Backlog', 'Scope, done and remaining points per week.', chart('burnup-backlog'));
  section('Flow', 'Points by status per week.', chart('flow'));

  const t = data.throughput;
  section(
    'Throughput',
    `Points and stories reaching \`done\` per ISO week, the last ${t.weeks.length} weeks. Trailing ${AVERAGE_WEEKS}-week average: ${num(t.averagePoints)} points, ${num(t.averageStories)} stories a week.`,
    chart('throughput'),
    formatTable(
      ['Week', 'Starts', 'Points', 'Stories', `${AVERAGE_WEEKS}-week avg points`, `${AVERAGE_WEEKS}-week avg stories`],
      t.weeks.map((w) => [w.week, w.start, w.points, w.stories, num(w.avgPoints), num(w.avgStories)]),
    ),
  );

  const lc = data.leadCycle;
  section(
    'Lead and cycle time',
    `Stories first done from ${lc.from || '—'} to ${lc.to || '—'}, in days. Lead time runs from \`added\` to the first snapshot showing \`done\`; cycle time from the first snapshot showing \`refined\` or \`in_progress\`.`,
    formatTable(
      ['Measure', 'Stories', 'Median', '85th percentile'],
      [
        ['Lead time', lc.lead.count, num(lc.lead.median), num(lc.lead.p85)],
        ['Cycle time', lc.cycle.count, num(lc.cycle.median), num(lc.cycle.p85)],
      ],
    ),
    '### Work item age',
    data.ages.length === 0
      ? 'No story is `refined` or `in_progress`.'
      : formatTable(
          ['Story', 'Title', 'Status', 'Points', 'Since', 'Age (days)'],
          data.ages.map((a) => [ref(a.id, a.link), cell(a.title), a.status, a.points, a.since, a.days]),
        ),
  );

  const idCol = { head: 'ID', value: (r) => ref(r.id, r.link) };
  const titleCol = { head: 'Title', value: (r) => cell(r.title) };
  section('Themes', progressTable(data.themes, [idCol, titleCol]), ...scopeCharts('theme', data.themes));
  section(
    'Epics',
    progressTable(
      data.epics,
      [idCol, titleCol, { head: 'Theme', value: (r) => cell(r.theme) }],
      [
        { head: 'Status', value: (r) => r.status },
        { head: 'Features', value: (r) => r.features },
      ],
    ),
    ...scopeCharts('epic', data.epics),
  );
  section(
    'Features',
    progressTable(
      data.features,
      [idCol, titleCol, { head: 'Epic', value: (r) => r.epic }],
      [
        { head: 'Stories', value: (r) => `${r.storiesDone}/${r.storiesTotal}` },
        { head: 'Status', value: (r) => r.status },
        { head: 'Review round', value: (r) => (r.reviewRound === null ? '—' : r.reviewRound) },
      ],
    ),
    ...scopeCharts('feature', data.features),
  );
  section('Components', progressTable(data.components, [idCol, titleCol]));

  const c = data.cost;
  const kinds = (t) =>
    `input ${tok(t.input)}, output ${tok(t.output)}, cache creation ${tok(t.cache_creation)}, cache read ${tok(t.cache_read)}`;
  const tokenCells = (u) => (u.tokens ? TOKEN_KINDS.map((k) => tok(u.tokens[k])) : TOKEN_KINDS.map(() => '—'));
  section(
    'Cost',
    `Agent tokens per unit (a feature, or a story with no feature), by output tokens. ${c.total.units} of ${c.units.length} units recorded tokens; a unit showing \`—\` recorded none and is left out of the total and the average.`,
    [
      `- Total: ${kinds(c.total.tokens)}; headless ${pct(c.total.headlessShare)}`,
      c.average.perPoint
        ? `- Average per point over ${c.average.units} done units (${c.average.points} points): ${kinds(c.average.perPoint)}`
        : '- Average per point: — (no done unit with tokens and points)',
    ].join('\n'),
    chart('cost'),
    formatTable(
      [
        'Unit',
        'Title',
        'Type',
        'Status',
        'Points',
        'Input',
        'Output',
        'Cache creation',
        'Cache read',
        'Headless',
        'Output per point',
        'Updated',
      ],
      c.units.map((u) => [
        ref(u.id, u.link),
        cell(u.title),
        u.type,
        u.status,
        u.points,
        ...tokenCells(u),
        pct(u.headlessShare),
        tok(u.outputPerPoint),
        u.updated || '—',
      ]),
    ),
  );

  const e = data.efficiency;
  const stepText = (steps) =>
    steps
      ? Object.entries(steps)
          .map(([step, t]) => `${step} ${tok(t.output)}`)
          .join(', ')
      : '—';
  section(
    'Token efficiency',
    `Output tokens per point over the ${e.units} done units with tokens and points. The ratio is a baseline, not a verdict: an outlier is a unit to classify (diagnosis, review rounds, a wrong premise), not a charge against the agent.`,
    '### By unit type',
    e.byType.length === 0
      ? 'No done unit with tokens and points.'
      : formatTable(
          ['Type', 'Units', 'Median', '90th percentile'],
          e.byType.map((r) => [r.type, r.count, tok(r.median), tok(r.p90)]),
        ),
    '### Review rounds',
    `The highest-numbered change document's \`review_round\`; a unit with none counts as 0.`,
    formatTable(
      ['Review rounds', 'Units', 'Median output tokens per point'],
      [
        [`0 to ${MANY_ROUNDS - 1}`, e.rounds.few.count, tok(e.rounds.few.median)],
        [`${MANY_ROUNDS} or more`, e.rounds.many.count, tok(e.rounds.many.median)],
      ],
    ),
    '### Per step',
    e.steps
      ? formatTable(
          ['Step', 'Input', 'Output', 'Cache creation', 'Cache read'],
          Object.entries(e.steps).map(([step, t]) => [step, ...TOKEN_KINDS.map((k) => tok(t[k]))]),
        )
      : '— (no done unit records per-step tokens yet; S-904 adds them)',
    '### Outliers',
    'Units above their type’s 90th percentile of output tokens per point, highest first.',
    e.outliers.length === 0
      ? 'None.'
      : formatTable(
          ['Unit', 'Title', 'Type', 'Points', 'Review round', 'Output', 'Output per point', 'Output per step'],
          e.outliers.map((o) => [
            ref(o.id, o.link),
            cell(o.title),
            o.type,
            o.points,
            o.reviewRound ?? '—',
            tok(o.output),
            tok(o.outputPerPoint),
            stepText(o.steps),
          ]),
        ),
  );

  return out.join('\n\n') + '\n';
}
