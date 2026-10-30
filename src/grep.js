/**
 * grep.js — search story contents and display matches as a table.
 */

import { existsSync } from 'fs';
import { dirname, relative } from 'path';
import { spawnSync } from 'child_process';
import { spawnSyncFiles } from './child-stdio.js';
import { loadConfig, parseArgs, runPager, info, buildHighlightRegex, highlightMatches } from './config.js';
import { readAllStories, readBacklogOrder, activeWorktreesByStory, storiesRoot } from './story.js';

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
  const stories = readAllStories(cfg);
  const backlogIds = readBacklogOrder(cfg.backlogRoot);
  const priorityMap = new Map(backlogIds.map((id, i) => [id, i]));
  const wtsByStory = activeWorktreesByStory(cfg);

  // Map story dir (relative to backlog root) → story
  const storyByDir = new Map();
  for (const s of stories) {
    if (s.storyRelPath) storyByDir.set(dirname(s.storyRelPath), s);
  }

  // Run rg against stories/ and map each hit through `storyByDir`.
  const matchedIds = new Set();
  const searchRoots = [storiesRoot(cfg)];

  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    const result = spawnSync('rg', ['--files-with-matches', '--no-messages', '--hidden', '-i', pattern, root], {
      encoding: 'utf8',
      cwd: cfg.backlogRoot,
    });
    for (const file of (result.stdout || '').trim().split('\n').filter(Boolean)) {
      const rel = relative(cfg.backlogRoot, file);
      let dir = dirname(rel);
      while (dir && dir !== '.') {
        if (storyByDir.has(dir)) {
          matchedIds.add(storyByDir.get(dir).id);
          break;
        }
        dir = dirname(dir);
      }
    }
  }

  let filtered = stories.filter((s) => matchedIds.has(s.id));
  if (!showAll) {
    filtered = filtered.filter((s) => s.status !== 'done' && s.status !== 'superseded');
  }

  if (filtered.length === 0) {
    info('No matching stories.');
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
    return a.componentId.localeCompare(b.componentId);
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

  const totalLines = rows.length + 3;
  const termRows = process.stdout.rows || 24;

  if (process.stdout.isTTY && totalLines > termRows) {
    const text = output.join('\n') + '\n';
    const pagerResult = runPager(text);
    if (pagerResult.error && !process.env.PAGER) {
      spawnSyncFiles('more', { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
    }
  } else {
    for (const l of output) console.log(l);
  }
}
