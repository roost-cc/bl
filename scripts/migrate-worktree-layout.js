#!/usr/bin/env node
/**
 * migrate-worktree-layout.js — the one F-60 migration (Design D4): move every
 * registered repo's worktrees from `<root>/<repo>/<branch>` to
 * `<root>/<branch>/<repo>`, point the run states at the new paths, remove the
 * emptied `<root>/<repo>/` directories and set `backlog.json` `worktrees` to
 * the root. The logic is in `src/migrate-worktree-layout.js`.
 *
 *   node scripts/migrate-worktree-layout.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints every move, run-state rewrite, removal, directory left in
 * place and the `backlog.json` change, and writes nothing. Without it,
 * everything is done and the backlog is committed once. `--backlog` names the
 * backlog root; by default it is found as `bl` finds it ($BL_BACKLOG_DIR,
 * else the nearest ancestor or ancestor's `backlog/` with a backlog.json).
 * It is the one caller of `loadConfig`'s `legacyWorktrees`, which accepts the
 * old `{repo}` template every other bl command refuses. Only the operator
 * runs it, as task T-14 says.
 *
 * Exit codes: 0 done (or nothing to do), 1 a refusal (a worktree holds a live
 * session lock, a target path exists or is blocked, a run state cannot be
 * read, a bl run is active, or the backlog is not clean at origin/main:
 * nothing has moved), or a step or the commit failed (the backlog is reset to
 * HEAD; worktrees already moved stay moved, and a rerun moves the rest and,
 * from the journal in `.bl/`, points the run states at them), 2 bad arguments.
 */

import { spawnSync } from 'child_process';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate-worktree-layout.js';

const USAGE = 'Usage: node scripts/migrate-worktree-layout.js [--dry-run] [--backlog <dir>]';

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
  config = loadConfig({ ...(opts.backlog ? { backlogRoot: opts.backlog } : {}), legacyWorktrees: true });
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
