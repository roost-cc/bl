#!/usr/bin/env node
/**
 * migrate-generated-sections.js — the one F-79 migration (Design D3): every
 * committed page loses the generated sections of its kind, and the root
 * `index.md` its "Total backlog" line, in one backlog commit. The logic is in
 * `src/migrate-generated-sections.js`.
 *
 *   node scripts/migrate-generated-sections.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints how many pages of each kind it would change, and writes
 * nothing. A second run changes nothing. `--backlog` names the backlog root;
 * by default it is found as `bl` finds it (`findBacklogRoot` in
 * `src/config.js`). The operator runs it after `bl merge F-79`.
 *
 * Exit codes: 0 done (or nothing to do), 1 the backlog is not clean at
 * origin/main with no bl run active (nothing is done), or a step or the
 * commit failed (the backlog is reset to HEAD; run it again once the cause is
 * fixed), 2 bad arguments.
 */

import { migrate } from '../src/migrate-generated-sections.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-generated-sections.js', migrate);
