#!/usr/bin/env node
/**
 * migrate-frontmatter-yaml.js — the one F-62 migration (Design D5): rewrite
 * every backlog frontmatter block as YAML through `serializeFrontmatter`,
 * quoting whole each line the retired line reader read differently from
 * YAML, and turning each list key's string into a sequence. The logic is in
 * `src/migrate-frontmatter-yaml.js`.
 *
 *   node scripts/migrate-frontmatter-yaml.js [--dry-run] [--backlog <dir>]
 *
 * `--dry-run` prints every file it would rewrite and the counts (titles
 * quoted, list strings turned into sequences, blocks read by the legacy
 * reader), and writes nothing. Without it, everything is written and the
 * backlog is committed once, with the counts in the message. `--backlog`
 * names the backlog root; by default it is found as `bl` finds it
 * ($BL_BACKLOG_DIR, else the nearest ancestor or ancestor's `backlog/`
 * with a backlog.json). Run it from F-62's worktree before `bl merge F-62`,
 * and again from the merged bl after it.
 *
 * Exit codes: 0 done (or nothing to do), 1 the backlog is not clean at
 * origin/main with no bl run active (nothing is done), or a step or the
 * commit failed (the backlog is reset to HEAD; run it again once the cause is
 * fixed), 2 bad arguments.
 */

import { migrate } from '../src/migrate-frontmatter-yaml.js';
import { runMigrationScript } from '../src/migration-script.js';

await runMigrationScript('migrate-frontmatter-yaml.js', migrate);
