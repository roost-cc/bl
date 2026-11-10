#!/usr/bin/env node
/**
 * migrate-transitions.js — the F-69 migration (Design D4): give every story,
 * feature and task a transition log (`transitions:`) synthesized from its
 * `status:`, `added`, `completed`, its change document's review fields and git
 * dates, in place of `status:`; remove `review_round` and `review_status` from
 * every change document; and write `flow.json` v2. The logic is in
 * `src/migrate-transitions.js`.
 *
 *   node scripts/migrate-transitions.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints per type the work units it would convert, the entries it
 * would write and the units a change document places, and writes nothing.
 * Without it, each unit is written under its own lock, so it can run beside
 * live `bl` runs; a unit a live run or session holds is skipped and listed,
 * and a rerun converts it. A unit whose `transitions:` is malformed is skipped
 * too; a rerun converts it once someone fixes it. The changed paths are
 * committed once, with the counts in the message; a rerun with nothing left
 * prints "nothing to do".
 * `--backlog` names the backlog root; by default it is found as `bl` finds it.
 *
 * Exit codes: 0 done (or nothing to do), 1 a step or the commit failed (run
 * it again once the cause is fixed: each unit reads correctly in either
 * shape, and the rerun commits what the failed run wrote, from its record in
 * `.bl/run/commit-failed/`), 2 bad arguments.
 */

import { migrate } from '../src/migrate-transitions.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-transitions.js', migrate);
