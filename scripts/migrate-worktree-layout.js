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

import { migrate } from '../src/migrate-worktree-layout.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-worktree-layout.js', migrate, { legacyWorktrees: true });
