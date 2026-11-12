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
 * backlog root; by default it is found as `bl` finds it. The `ranked:`
 * entries' `unit`s are resolved as bl resolves priority.yaml's ids
 * (`resolveRanked`), so a work unit ranked twice is kept once, at its first
 * place, and an id that names no work unit is dropped.
 *
 * This script and its test are the only files that name priority.md
 * (`test/integration/old-order-file-guard.test.js`); a cleanup story after F-113
 * deletes them.
 *
 * Exit codes: 0 written, 1 priority.md is missing or unreadable (nothing is
 * written), 2 bad arguments.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stringify } from 'yaml';
import { loadBacklog } from '../src/backlog-graph.js';
import { listValue, parseFrontmatter } from '../src/config.js';
import { runMigrationScript } from '../src/migration-script.js';
import { PRIORITY_FILE, parseRanked, resolveRanked } from '../src/priority.js';

const SOURCE = 'priority.md';

await runMigrationScript('priority-to-yaml.js', async (config, { dryRun }) => {
  const path = join(config.backlogRoot, SOURCE);
  if (!existsSync(path)) throw new Error(`${SOURCE} is missing`);
  const ranked = listValue(parseFrontmatter(readFileSync(path, 'utf8')).fm.ranked);
  if (ranked == null) throw new Error(`${SOURCE}: "ranked:" is not a list`);
  const ids = parseRanked(
    ranked.map((e) => e?.unit ?? ''),
    SOURCE,
  );
  const { entries } = resolveRanked(ids, loadBacklog(config));
  const text = stringify(entries.filter((e) => !e.unit.done).map((e) => e.unit.id));
  if (dryRun) process.stdout.write(text);
  else {
    writeFileSync(join(config.backlogRoot, PRIORITY_FILE), text);
    console.log(`wrote ${PRIORITY_FILE}`);
  }
  return { commit: null };
});
