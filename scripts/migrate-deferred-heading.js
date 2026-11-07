#!/usr/bin/env node
/**
 * migrate-deferred-heading.js — the one F-82 migration (Design D9): every
 * story file's `## To Do` becomes `## Deferred`, open or closed, in one
 * backlog commit. The logic is in `src/migrate-deferred-heading.js`.
 *
 *   node scripts/migrate-deferred-heading.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints each story it would rename, and writes nothing. A second
 * run changes nothing. `--backlog` names the backlog root; by default it is
 * found as `bl` finds it ($BL_BACKLOG_DIR, else the nearest ancestor or
 * ancestor's `backlog/` with a backlog.json). The operator runs it after
 * `bl merge F-82`.
 *
 * Exit codes: 0 done (or nothing to do), 1 the backlog is not clean at
 * origin/main with no bl run active (nothing is done), or a step or the
 * commit failed (the backlog is reset to HEAD; run it again once the cause is
 * fixed), 2 bad arguments.
 */

import { migrate } from '../src/migrate-deferred-heading.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-deferred-heading.js', migrate);
