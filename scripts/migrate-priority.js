#!/usr/bin/env node
/**
 * migrate-priority.js — the one F-78 migration (Design D5): the backlog's
 * feature-order.md becomes priority.md. The open ranked features keep their
 * order as `{ unit, why }`, the generated tables go, the hand-written intro
 * and History stay, and feature-order.md is removed, in one backlog commit.
 * The logic is in `src/migrate-priority.js`.
 *
 *   node scripts/migrate-priority.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints the entries it would keep and drop, and writes nothing.
 * A second run changes nothing. `--backlog` names the backlog root; by
 * default it is found as `bl` finds it ($BL_BACKLOG_DIR, else the nearest
 * ancestor or ancestor's `backlog/` with a backlog.json). Run it from the
 * merged bl right after `bl merge F-78`, outside any headless agent session
 * (`BL_HEADLESS` refuses a commit of priority.md).
 *
 * Exit codes: 0 done (or nothing to do), 1 the backlog is not clean at
 * origin/main with no bl run active, or priority.md already exists (nothing
 * is done), or a step or the commit failed (the backlog is reset to HEAD; run
 * it again once the cause is fixed), 2 bad arguments.
 */

import { migrate } from '../src/migrate-priority.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-priority.js', migrate);
