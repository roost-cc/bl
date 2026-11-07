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

import { migrate } from '../src/migrate-derived-keys.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-derived-keys.js', migrate);
