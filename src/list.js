/**
 * list.js — list backlog stories in a table.
 *
 * Usage:
 *   bl list                     All active/backlog stories
 *   bl list -a                  Include completed + superseded
 *   bl list --theme <slug>      Filter by theme, likewise --epic, --feature
 *                               and --component (filter.js, F-51 D2)
 *   bl list <pattern>           Filter rows by regex
 *   bl list --features [-a]     Features instead of stories
 *   bl list --epic <E-id>       An epic's features, with their progress
 *   bl status                   Open stories by status (listByStatus; verbs.js)
 */

import { exitStatus, loadConfig, parseArgs, showText, info, buildHighlightRegex, highlightMatches } from './config.js';
import { readAllStories, readBacklogOrder, activeWorktreesByStory } from './story.js';
import { filterContext, filterFromArgs, filterStories, storyThemes } from './filter.js';
import { loadFlow } from './flow.js';

/** Comparator: stack rank (unranked last), then numeric id. */
function byRankThenId(priorityMap) {
  return (a, b) => {
    const pa = priorityMap.get(a.id) ?? Infinity;
    const pb = priorityMap.get(b.id) ?? Infinity;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  };
}

/**
 * Comparator for the bare `bl status`: strictly by status, whatever has a
 * worktree, in `openStatuses` order (`Flow.openStatusesOf`), then rank and id.
 * A status outside the list stays listed, last.
 *
 * @param {Map<string, number>} priorityMap
 * @param {string[]} openStatuses
 */
export function byOpenStatus(priorityMap, openStatuses) {
  const tiebreak = byRankThenId(priorityMap);
  const order = new Map(openStatuses.map((status, i) => [status, i]));
  return (a, b) => {
    const sa = order.get(a.status) ?? order.size;
    const sb = order.get(b.status) ?? order.size;
    return sa !== sb ? sa - sb : tiebreak(a, b);
  };
}

/** The stack rank of each ranked story id. */
function readPriorityMap(cfg) {
  return new Map(readBacklogOrder(cfg.backlogRoot).map((id, i) => [id, i]));
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl list [pattern] [options]

Arguments:
  [pattern]            Filter rows by regex (matched against the full line)

Options:
  -a, --all            Include completed and superseded stories
  --theme <slug>       Stories in a theme: their feature's theme, or, with no
                       feature, a theme whose repos list their component's repo
  --epic <E-id>        Features in an epic, grouped, with their progress
  --feature <F-id>     Stories of one feature
  --component <C-id>   Stories in one component
  --features           List features instead (-a includes done ones); with
                       --theme, --epic, --feature or --component, grouped by
                       epic with stories and points done/total
  --help               Show this help

Filters combine: every one given must match.`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const { filter, ctx } = filterFromArgs(args, cfg, 'bl list');

  // An epic is a set of features: `bl list --epic` lists them (F-51 D2).
  if (args.features || filter.epic) {
    const { cmdList } = await import('./feature-cmd.js');
    return cmdList(args, cfg, { filter, ctx });
  }

  const flow = loadFlow(cfg.backlogRoot);
  const showAll = args.all;
  const stories = filterStories(readAllStories(cfg), filter, ctx);

  const tiebreak = byRankThenId(readPriorityMap(cfg));

  const wtsByStory = activeWorktreesByStory(cfg);

  const filtered = showAll ? stories : stories.filter((s) => !flow.meets('story', s.status, 'done'));

  filtered.sort((a, b) => {
    const aa = wtsByStory.has(a.id) ? 0 : 1;
    const ab = wtsByStory.has(b.id) ? 0 : 1;
    if (aa !== ab) return aa - ab;
    const sa = flow.listRankOf('story', a.status);
    const sb = flow.listRankOf('story', b.status);
    if (sa !== sb) return sa - sb;
    return tiebreak(a, b);
  });

  printStories(filtered, { flow, ctx, wtsByStory, patternSource: args.positional[0], showAll });
}

/**
 * The bare `bl status`: every open story in the table `bl list` prints, sorted
 * strictly by status (`byOpenStatus`), so a story with a worktree keeps its
 * group. Which statuses are open, and their order, come from `flow.json`; a
 * status it does not name meets nothing, so reads as open. A `flow.json` bl
 * cannot read stops here with its `FlowError`.
 */
export function listByStatus() {
  const cfg = loadConfig();
  const flow = loadFlow(cfg.backlogRoot);
  const stories = readAllStories(cfg)
    .filter((s) => !flow.meets('story', s.status, 'done'))
    .sort(byOpenStatus(readPriorityMap(cfg), flow.openStatusesOf('story')));
  printStories(stories, { flow, ctx: filterContext(cfg), wtsByStory: activeWorktreesByStory(cfg), showAll: false });
}

/**
 * The one story table: stdout, through the pager, with its summary line. `filtered`
 * is already sorted. An empty list or a pattern matching nothing says so on stderr.
 *
 * @param {object[]} filtered
 * @param {{ flow: import('./flow.js').Flow, ctx: object, wtsByStory: Map<string, object[]>, patternSource?: string, showAll: boolean }} opts
 */
function printStories(filtered, { flow, ctx, wtsByStory, patternSource, showAll }) {
  // Before the empty check: a malformed pattern is an error with no rows too.
  const pattern = patternSource ? new RegExp(patternSource, 'i') : null;

  if (filtered.length === 0) {
    info('No stories found.');
    return;
  }

  // The Theme column (F-51 D2) appears once the backlog has a theme: a story
  // in several themes shows them joined, one in none shows `-`.
  const themed = ctx.themes.length > 0;
  // The Feature column only appears once at least one listed story belongs
  // to a feature, so backlogs that don't use features see no change.
  const anyFeature = filtered.some((s) => s.feature);
  const base = ['Component', 'Story', 'Type', 'Pts', 'Status', 'Title'];
  if (anyFeature) base.splice(2, 0, 'Feature');
  const headers = themed ? ['Theme', ...base] : base;

  let rows = filtered.map((s) => {
    const status = wtsByStory.has(s.id) ? `${s.status}*` : s.status;
    const cells = [s.componentId, s.id, s.type, s.points, status, s.title];
    if (anyFeature) cells.splice(2, 0, s.feature || '');
    if (!themed) return cells;
    return [storyThemes(s, ctx).join(',') || '-', ...cells];
  });

  if (pattern) rows = rows.filter((r) => pattern.test(r.join('  ')));

  if (rows.length === 0) {
    info('No matching stories.');
    return;
  }

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const line = (r) => headers.map((_, i) => pad(r[i], widths[i])).join('  ');
  const hlRe = buildHighlightRegex(patternSource);

  const activeCount = filtered.filter((s) => wtsByStory.has(s.id)).length;
  const backlogCount = filtered.filter((s) => !wtsByStory.has(s.id) && !flow.meets('story', s.status, 'done')).length;
  const completedCount = filtered.length - activeCount - backlogCount;
  const summary = `\n${filtered.length} stories (${activeCount} active, ${backlogCount} backlog${
    showAll ? `, ${completedCount} completed` : ''
  })`;

  const output = [
    line(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((r) => highlightMatches(line(r), hlRe)),
    summary,
  ];

  process.exitCode = exitStatus(showText(output.join('\n') + '\n'));
}
