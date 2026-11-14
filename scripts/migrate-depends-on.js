#!/usr/bin/env node
/**
 * migrate-depends-on.js — the one F-111 migration (Design D5, Decision A3):
 * move every story's `depends_on:` into `blockers.json` as the edge each
 * entry stands for (an order edge between two stories of one feature, else a
 * run edge), and remove `depends_on:` and `required_for:` from the story
 * files. The logic is in `src/migrate-depends-on.js`.
 *
 *   node scripts/migrate-depends-on.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints every edge it would write, every entry it cannot place,
 * every file it would rewrite or keep, and the counts, and writes nothing.
 * Without it, everything is written and the backlog is committed once, with
 * the counts in the message. A story keeps its `depends_on:` while an edge it
 * gives is not in `blockers.json`; a later run removes the key once that is
 * fixed, and a run on a consistent backlog changes nothing. `--backlog` names
 * the backlog root; by default it is found as `bl` finds it
 * (`findBacklogRoot` in `src/config.js`). Run it from the merged bl after
 * `bl merge F-111` (task T-72).
 *
 * Exit codes: 0 done (or nothing to do), 1 the backlog is not clean at
 * origin/main with no bl run active (nothing is done), or a step or the
 * commit failed (the backlog is reset to HEAD; run it again once the cause is
 * fixed), 2 bad arguments.
 */

import { migrate } from '../src/migrate-depends-on.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-depends-on.js', migrate);
