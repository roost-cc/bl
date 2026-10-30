#!/usr/bin/env node
/**
 * migrate-frontmatter-yaml.js — the one F-62 migration (Design D5): rewrite
 * every backlog frontmatter block as YAML through `serializeFrontmatter`,
 * quoting whole each line the retired line reader read differently from
 * YAML, and turning each list key's string into a sequence. The logic is in
 * `src/migrate-frontmatter-yaml.js`.
 *
 *   node scripts/migrate-frontmatter-yaml.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints every file it would rewrite and the counts (titles
 * quoted, list strings turned into sequences, blocks read by the legacy
 * reader), and writes nothing. Without it, everything is written and the
 * backlog is committed once, with the counts in the message. `--backlog`
 * names the backlog root; by default it is found as `bl` finds it
 * ($BL_BACKLOG_DIR, else the nearest ancestor or ancestor's `backlog/`
 * with a backlog.json). Run it from F-62's worktree before `bl merge F-62`,
 * and again from the merged bl after it.
 *
 * Exit codes: 0 done (or nothing to do), 1 the backlog is not clean at
 * origin/main with no bl run active (nothing is done), or a step or the
 * commit failed (the backlog is reset to HEAD; run it again once the cause is
 * fixed), 2 bad arguments.
 */

import { spawnSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate-frontmatter-yaml.js';

const USAGE = 'Usage: node scripts/migrate-frontmatter-yaml.js [--dry-run] [--backlog <dir>]';

function parse(argv) {
  const opts = { dryRun: false, backlog: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--backlog' && argv[i + 1]) opts.backlog = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

let config;
let result;
try {
  config = loadConfig(opts.backlog ? { backlogRoot: opts.backlog } : {});
  result = await migrate(config, { dryRun: opts.dryRun });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const { commit } = result;
if (commit?.error) {
  console.error(`backlog commit failed: ${commit.error}`);
  process.exit(1);
}
if (commit?.committed) {
  const head = spawnSync('git', ['log', '-1', '--format=%h %s'], {
    cwd: config.backlogRoot,
    encoding: 'utf8',
  }).stdout.trim();
  console.log(`committed ${commit.paths.length} backlog path(s) in ${head}`);
}
