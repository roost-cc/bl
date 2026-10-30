/**
 * history-cmd.js — `bl history`: the snapshot series behind the report
 * (F-40 Design D1, D2), for scripts and tests.
 *
 *   bl history [--json] [--since <YYYY-MM-DD>] [--scope <theme|E<n>|F-<n>|C<n>>]
 *
 * stdout is a table of ISO weeks × points by status, or with `--json` the
 * `buildHistory` structure. It only reads git objects and the working tree:
 * no lock, no activity log.
 */

import { loadConfig, parseArgs, warn } from './config.js';
import { formatTable } from './sync.js';
import { filterContext, parseFilter, unknownFilterTargets } from './filter.js';
import { buildHistory, narrowHistory, pointsByStatus, weeklyDays } from './history.js';

const HELP = `Usage: bl history [--json] [--since <YYYY-MM-DD>] [--scope <id>]

One snapshot per day the backlog repo was committed, read from git, with the
days before the first commit projected from the stories' added and completed
dates (marked backfilled). Cached by commit in .bl/report-cache.json.

Options:
  --json             Print every day's stories and features, the grouping and
                     the unreadable count as JSON
  --since <date>     Only days from this date (YYYY-MM-DD)
  --scope <id>       Narrow the stories to a theme (slug), an epic (E<n>), a
                     feature (F-<n>) or a component (C<n>)

Without --json, prints a table of ISO weeks (the last snapshot in each) by
points per status, with the scope (every status but superseded).`;

/** The statuses in table order; any other status a snapshot holds follows them. */
const STATUS_ORDER = ['backlog', 'refined', 'in_progress', 'done', 'superseded'];

/**
 * `--scope`'s value as a scope, or throws naming it. An id that names no unit
 * in the current tree is unknown.
 * @returns {import("./history.js").Scope}
 */
export function parseScope(raw, config) {
  if (raw == null || raw === false) return { kind: 'backlog' };
  if (raw === true || String(raw).trim() === '') throw new Error('--scope requires a value');
  const id = String(raw).trim();
  const kind = /^[Ee]-?\d+$/.test(id)
    ? 'epic'
    : /^[Ff]-?\d+$/.test(id)
      ? 'feature'
      : /^[Cc]-?\d+$/.test(id)
        ? 'component'
        : 'theme';
  let filter;
  try {
    filter = parseFilter({ [kind]: id });
  } catch (e) {
    throw new Error(`unknown scope ${id}: ${e.message}`);
  }
  const unknown = unknownFilterTargets(filter, filterContext(config));
  if (unknown.length > 0) throw new Error(`unknown scope ${id}: ${unknown.join('; ')}`);
  return { kind, id: filter[kind] };
}

/** The week table of `history`. */
export function weekTable(history) {
  const weeks = weeklyDays(history.days).map(({ week, day }) => ({ week, day, points: pointsByStatus(day) }));
  const seen = new Set(weeks.flatMap((w) => Object.keys(w.points)));
  const statuses = [...STATUS_ORDER, ...[...seen].filter((s) => !STATUS_ORDER.includes(s)).sort()];
  const headers = ['Week', 'Date', ...statuses, 'scope'];
  const rows = weeks.map(({ week, day, points }) => {
    const scope = Object.entries(points).reduce((sum, [s, p]) => (s === 'superseded' ? sum : sum + p), 0);
    return [
      week,
      day.backfilled ? `${day.date} (backfilled)` : day.date,
      ...statuses.map((s) => points[s] ?? 0),
      scope,
    ];
  });
  return formatTable(headers, rows);
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.since != null && (args.since === true || !/^\d{4}-\d{2}-\d{2}$/.test(String(args.since)))) {
    console.error('bl history: --since needs a date, YYYY-MM-DD');
    process.exit(1);
  }
  const config = loadConfig();
  let scope;
  try {
    scope = parseScope(args.scope, config);
  } catch (e) {
    console.error(`bl history: ${e.message}`);
    process.exit(1);
  }
  let history;
  try {
    history = narrowHistory(buildHistory(config, { since: args.since ?? '' }), scope);
  } catch (e) {
    console.error(`bl history: ${e.message}`);
    process.exit(1);
  }
  if (history.unreadable > 0) warn(`${history.unreadable} index.md blob(s) could not be read and were skipped`);
  if (args.json) {
    const { earlier, ...shown } = history;
    console.log(JSON.stringify(shown, null, 2));
  } else {
    console.log(weekTable(history));
  }
}
