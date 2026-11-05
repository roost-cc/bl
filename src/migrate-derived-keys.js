/**
 * migrate-derived-keys.js — the one F-77 migration (Design D3), run by
 * `scripts/migrate-derived-keys.js`.
 *
 * Since F-77 a feature's stories, points and components, and an epic's
 * features and status, are derived by `loadBacklog()` and never stored
 * (`DERIVED_KEYS`, `src/backlog-graph.js`); `bl validate` reports one still
 * stored as `derived-key`. The migration:
 *
 *   1. finds every unit of a kind in `DERIVED_KEYS` that stores one of its
 *      derived keys, through the graph (the one way in, F-77 D2);
 *   2. writes its block without them through `serializeFrontmatter`, leaving
 *      the body as it is, and checks it reads back as the frontmatter less
 *      those keys;
 *   3. appends a section to MIGRATION.md with the per-kind counts, and
 *      commits the backlog once through `syncAndCommit`, after a `bl sync`.
 *
 * Idempotent: a migrated block holds no derived key, so a second run plans
 * nothing and commits nothing.
 *
 * Retryable: it starts only on a clean backlog at origin/main with no bl run
 * active, and a step or commit that fails resets the backlog to HEAD
 * (`migration-txn.js`).
 */

import { existsSync, readFileSync } from 'fs';
import { isDeepStrictEqual } from 'util';
import { join, relative } from 'path';
import { parseFrontmatter, serializeFrontmatter } from './config.js';
import { DERIVED_KEYS, loadBacklog } from './backlog-graph.js';
import { withLock } from './lock.js';
import { applyMigration } from './migration-txn.js';
import { runSync, syncAndCommit } from './sync.js';

const MIGRATION_HEADING = '## F-77 derived-keys migration';

/**
 * A unit file's text without the derived keys `keys`, or null when it stores
 * none of them.
 * @param {string} text  the file as read
 * @param {string[]} keys  the keys its kind derives
 * @returns {{ text: string, removed: string[] } | null}
 */
export function planText(text, keys) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lf = text.replace(/\r\n/g, '\n');
  const { fm, body } = parseFrontmatter(lf);
  const removed = keys.filter((k) => Object.hasOwn(fm, k));
  if (removed.length === 0) return null;
  for (const k of removed) delete fm[k];
  const out = `${serializeFrontmatter(fm)}${body}`;
  if (!isDeepStrictEqual(parseFrontmatter(out).fm, fm)) {
    throw new Error('the rewritten block does not read back as planned');
  }
  return { text: eol === '\n' ? out : out.replace(/\n/g, eol), removed };
}

/**
 * What the migration would do, without doing it: every unit file that stores
 * a derived key, with its text after.
 *
 * @param {object} config  the loaded backlog config
 * @returns {{ rewrites: { path: string, kind: string, id: string, removed: string[], text: string }[],
 *   migration: string | null }}
 */
export function planDerivedKeys(config) {
  const graph = loadBacklog(config);
  const rewrites = [];
  for (const [kind, derived] of Object.entries(DERIVED_KEYS)) {
    const keys = Object.keys(derived);
    for (const unit of graph.list(kind)) {
      let planned;
      try {
        planned = planText(unit.text(), keys);
      } catch (e) {
        throw new Error(`${unit.relPath}: ${e.message}`);
      }
      if (planned) rewrites.push({ path: unit.file, kind, id: unit.id, ...planned });
    }
  }
  const plan = { rewrites, migration: null };
  plan.migration = rewrites.length > 0 ? migrationSection(planCounts(plan)) : null;
  return plan;
}

/**
 * The counts a plan reports, per kind in `DERIVED_KEYS`: the files
 * rewritten and how many held each key.
 * @returns {Record<string, { files: number, keys: Record<string, number> }>}
 */
export function planCounts(plan) {
  const out = {};
  for (const [kind, derived] of Object.entries(DERIVED_KEYS)) {
    const mine = plan.rewrites.filter((r) => r.kind === kind);
    out[kind] = {
      files: mine.length,
      keys: Object.fromEntries(Object.keys(derived).map((k) => [k, mine.filter((r) => r.removed.includes(k)).length])),
    };
  }
  return out;
}

/** `features: 78 (stories: 78, points: 78, components: 70)`, one per kind. */
function countsText(c) {
  return Object.entries(c)
    .map(
      ([kind, { files, keys }]) =>
        `${kind === 'story' ? 'stories' : `${kind}s`}: ${files} (${Object.entries(keys)
          .map(([k, n]) => `${k}: ${n}`)
          .join(', ')})`,
    )
    .join('; ');
}

/** The MIGRATION.md section for a plan's counts. */
export function migrationSection(c, date = new Date().toISOString().slice(0, 10)) {
  return (
    [
      `${MIGRATION_HEADING} (${date})`,
      '',
      "A feature's stories, points and components, and an epic's features and status, are derived by " +
        '`loadBacklog()` and no longer stored (F-77 D3). The keys were removed from every file that held ' +
        `them, per kind the files rewritten and how many held each key: ${countsText(c)}.`,
    ].join('\n') + '\n'
  );
}

/** The backlog commit message, with the counts. */
export function commitMessage(c) {
  return `chore: F-77 derived-keys migration: ${countsText(c)}`;
}

/**
 * Run the migration. With `dryRun`, print what would be done and do
 * nothing; otherwise write everything under the backlog lock and commit it
 * once through `syncAndCommit`. `log` gets one line per file it would
 * rewrite, then the per-kind counts.
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void,
 *   commit?: typeof syncAndCommit }} [opts]  `commit` is for tests
 * @returns {Promise<{ counts: ReturnType<typeof planCounts>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit = syncAndCommit } = {}) {
  const root = config.backlogRoot;
  return withLock(root, async () => {
    const plan = planDerivedKeys(config);
    const counts = planCounts(plan);
    const verb = dryRun ? 'would ' : '';
    for (const r of plan.rewrites) {
      log(`${verb}rewrite ${relative(root, r.path)} (${r.removed.join(', ')} removed)`);
    }
    if (plan.migration) log(`${verb}append  MIGRATION.md`);
    log(countsText(counts));
    if (dryRun || !plan.migration) return { counts, commit: null };

    const result = await applyMigration(config, {
      message: commitMessage(counts),
      commit,
      sync: runSync,
      apply: ({ write }) => {
        for (const r of plan.rewrites) write(r.path, r.text);
        const path = join(root, 'MIGRATION.md');
        const was = existsSync(path) ? readFileSync(path, 'utf8') : '# Backlog Migration\n';
        write(path, `${was.replace(/\s*$/, '')}\n\n${plan.migration}`);
      },
    });
    return { counts, commit: result };
  });
}
