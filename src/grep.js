/**
 * grep.js — search story contents and display matches as a table.
 *
 * The pattern is a JavaScript regular expression, case-insensitive, `^` and
 * `$` at line ends, matched against each story's whole `index.md` as the
 * backlog graph read it (`unit.text()`, F-77 D2): its frontmatter and body.
 */

import { exitStatus } from './child.js';
import { loadConfig, parseArgs, showText, info, buildHighlightRegex, highlightMatches } from './config.js';
import { readAllStories, activeWorktreesByStory } from './story.js';
import { byRank } from './priority.js';
import { loadBacklog } from './backlog-graph.js';
import { loadFlow } from './flow.js';

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl grep <pattern> [options]

Arguments:
  <pattern>            Regex pattern to search for in story contents

Options:
  -a, --all            Include completed and superseded stories
  --help               Show this help

Searches every story's index.md and displays matching
stories in the same table format as bl list.`);
    process.exit(0);
  }

  const pattern = args.positional[0];
  if (!pattern) {
    console.error('Usage: bl grep <pattern>');
    process.exit(1);
  }

  const showAll = args.all;
  const cfg = loadConfig();
  const flow = loadFlow(cfg.backlogRoot);
  let re;
  try {
    re = new RegExp(pattern, 'im');
  } catch (e) {
    console.error(`bl grep: ${e.message}`);
    process.exit(1);
  }
  // Every story's index.md, as the graph read it (F-77 D2): one snapshot for
  // the records and the texts searched.
  const graph = loadBacklog(cfg);
  const stories = readAllStories({ ...cfg, backlogGraph: graph });
  const wtsByStory = activeWorktreesByStory(cfg);

  const matched = new Set(
    graph
      .list('story')
      .filter((u) => re.test(u.text()))
      .map((u) => u.file),
  );
  let filtered = stories.filter((s) => matched.has(s.indexPath));
  if (!showAll) {
    filtered = filtered.filter((s) => !flow.meets('story', s.status, 'done'));
  }

  if (filtered.length === 0) {
    info('No matching stories.');
    return;
  }

  // Then the backlog's priority (F-78 D2), as `bl list` sorts.
  const byPriority = byRank((id) => graph.rankOf(id));
  filtered.sort((a, b) => {
    const aa = wtsByStory.has(a.id) ? 0 : 1;
    const ab = wtsByStory.has(b.id) ? 0 : 1;
    if (aa !== ab) return aa - ab;
    const sa = flow.listRankOf('story', a.status);
    const sb = flow.listRankOf('story', b.status);
    if (sa !== sb) return sa - sb;
    return byPriority(a, b);
  });

  const headers = ['Component', 'Story', 'Type', 'Pts', 'Status', 'Title'];

  const rows = filtered.map((s) => {
    const status = wtsByStory.has(s.id) ? `${s.status}*` : s.status;
    return [s.componentId, s.id, s.type, s.points, status, s.title];
  });

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const line = (r) => headers.map((_, i) => pad(r[i], widths[i])).join('  ');
  const hlRe = buildHighlightRegex(pattern);

  const output = [
    line(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((r) => highlightMatches(line(r), hlRe)),
    `\n${filtered.length} matching stories`,
  ];

  process.exitCode = exitStatus(showText(output.join('\n') + '\n'));
}
