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
 */

import { exitStatus, loadConfig, parseArgs, showText, info, buildHighlightRegex, highlightMatches } from './config.js';
import { readAllStories, readBacklogOrder, activeWorktreesByStory } from './story.js';
import { filterFromArgs, filterStories, storyThemes } from './filter.js';

const STATUS_ORDER = {
  in_progress: 1,
  backlog: 2,
  refined: 2,
  done: 3,
  superseded: 4,
};

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

  const showAll = args.all;
  const pattern = args.positional[0] ? new RegExp(args.positional[0], 'i') : null;
  const stories = filterStories(readAllStories(cfg), filter, ctx);

  const backlogIds = readBacklogOrder(cfg.backlogRoot);
  const priorityMap = new Map(backlogIds.map((id, i) => [id, i]));

  const wtsByStory = activeWorktreesByStory(cfg);

  let filtered = stories;
  if (!showAll) {
    filtered = stories.filter((s) => s.status !== 'done' && s.status !== 'superseded');
  }

  if (filtered.length === 0) {
    info('No stories found.');
    return;
  }

  filtered.sort((a, b) => {
    const aa = wtsByStory.has(a.id) ? 0 : 1;
    const ab = wtsByStory.has(b.id) ? 0 : 1;
    if (aa !== ab) return aa - ab;
    const sa = STATUS_ORDER[a.status] ?? 2;
    const sb = STATUS_ORDER[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    const pa = priorityMap.get(a.id) ?? 9999;
    const pb = priorityMap.get(b.id) ?? 9999;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

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
  const hlRe = buildHighlightRegex(args.positional[0]);

  const activeCount = filtered.filter((s) => wtsByStory.has(s.id)).length;
  const backlogCount = filtered.filter(
    (s) => !wtsByStory.has(s.id) && s.status !== 'done' && s.status !== 'superseded',
  ).length;
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
