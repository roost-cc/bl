#!/usr/bin/env node
/**
 * migrate-lock-files.js — the S-1495 migration: every lock file bl keeps in a
 * backlog now lives under `.bl/`. It adds `.bl/` to the backlog's
 * `.gitignore`, deletes the old lock files (`.bl-new.lock`, `.reports.lock`,
 * every `.workon.lock`) that no other process holds, and once none is left
 * removes their lines from `.gitignore`. The logic is in
 * `src/migrate-lock-files.js`.
 *
 *   node scripts/migrate-lock-files.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints what it would do and changes nothing. A lock file whose
 * lock a live process holds (a `bl` from before S-1495 that still runs) is
 * skipped and listed, and its `.gitignore` line stays; a rerun deletes it and
 * removes the lines. A changed `.gitignore` is committed once; a rerun with
 * nothing left prints "nothing to do". `--backlog` names the backlog root; by
 * default it is found as `bl` finds it.
 *
 * Exit codes: 0 done (or nothing to do), 1 a step or the commit failed, 2 bad
 * arguments.
 */

import { migrate } from '../src/migrate-lock-files.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-lock-files.js', migrate);
