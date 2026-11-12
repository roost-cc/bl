#!/usr/bin/env node
/**
 * priority-to-yaml.js — the F-113 conversion (Design D1a): the backlog's
 * priority.md becomes priority.yaml, a YAML list of work unit ids. It keeps
 * the open ranked work units of priority.md's `ranked:`, once each, in their
 * order, and drops the closed ones and `why`. It deletes nothing and commits
 * nothing: the operator or agent commits priority.yaml with
 * `bl sync --commit --path priority.yaml`.
 *
 *   node scripts/priority-to-yaml.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints the list and writes nothing. `--backlog` names the
 * backlog root; by default it is found as `bl` finds it. The ranked entries
 * are `loadBacklog().ranked`, so an entry ranked twice is kept once, at its
 * first place.
 *
 * Exit codes: 0 written, 1 priority.md is missing or unreadable (nothing is
 * written), 2 bad arguments.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { stringify } from 'yaml';
import { loadBacklog } from '../src/backlog-graph.js';
import { runMigrationScript } from '../src/migration-script.js';

const TARGET = 'priority.yaml';

await runMigrationScript('priority-to-yaml.js', async (config, { dryRun }) => {
  const graph = loadBacklog(config);
  const fault = graph.problems.find((p) => p.code === 'priority-file');
  if (fault) throw new Error(fault.message);
  const text = stringify(graph.ranked.filter((e) => !e.unit.done).map((e) => e.unit.id));
  if (dryRun) process.stdout.write(text);
  else {
    writeFileSync(join(config.backlogRoot, TARGET), text);
    console.log(`wrote ${TARGET}`);
  }
  return { commit: null };
});
