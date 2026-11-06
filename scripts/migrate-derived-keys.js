#!/usr/bin/env node
/**
 * migrate-derived-keys.js — the one F-77 migration (Design D3): remove from
 * every unit file the frontmatter keys bl now derives (`DERIVED_KEYS`: a
 * story's `required_for:`, a feature's `stories:`, `points:` and
 * `components:`, an epic's `features:` and `status:`). The logic is in
 * `src/migrate-derived-keys.js`.
 *
 *   node scripts/migrate-derived-keys.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints every file it would rewrite and the per-kind counts, and
 * writes nothing. Without it, everything is written and the backlog is
 * committed once, with the counts in the message; a second run changes
 * nothing. `--backlog` names the backlog root; by default it is found as `bl`
 * finds it ($BL_BACKLOG_DIR, else the nearest ancestor or ancestor's
 * `backlog/` with a backlog.json). Run it from the merged bl after
 * `bl merge F-77`: the bl before F-77 reads membership from `stories:`.
 *
 * Exit codes: 0 done (or nothing to do), 1 the backlog is not clean at
 * origin/main with no bl run active (nothing is done), or a step or the
 * commit failed (the backlog is reset to HEAD; run it again once the cause is
 * fixed), 2 bad arguments.
 */

import { spawnSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate-derived-keys.js';

const USAGE = 'Usage: node scripts/migrate-derived-keys.js [--dry-run] [--backlog <dir>]';

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
