/**
 * migrate-deferred-heading.js — the one F-82 migration (Design D9), run by
 * `scripts/migrate-deferred-heading.js`.
 *
 * Before F-82 a story held its follow-up code work under `## To Do` and a
 * feature under `## Deferred`. Since F-82 both use `## Deferred`, and
 * `bl validate` reports an open story that still has `## To Do`
 * (`deferred-heading-retired`). The migration renames the level-2 heading in
 * every story file of the backlog, open or closed, so the whole backlog uses
 * one name. It finds the heading as an mdast heading (`scanDeferred`), so a
 * `### To Do` or the words in prose stay, and it changes nothing else in the
 * file: CRLF line ends and the rest of the body stay byte for byte.
 *
 * Idempotent: with no `## To Do` left a run plans nothing.
 *
 * Retryable: it starts only on a clean backlog at origin/main with no bl run
 * active, and a step or commit that fails resets the backlog to HEAD
 * (`migration-txn.js`). It commits once through `syncAndCommit`.
 */

import { readFileSync } from 'fs';
import { relative } from 'path';
import { DEFERRED_HEADING, RETIRED_SECTION, scanDeferred } from './deferred.js';
import { withLock } from './lock.js';
import { applyMigration } from './migration-txn.js';
import { readAllStories } from './story.js';
import { runSync, syncAndCommit } from './sync.js';

/** The `## To Do` at the start of a heading line, after up to three spaces of indent. */
const RETIRED_RE = new RegExp(`^( {0,3}#{2}[ \\t]+)${RETIRED_SECTION}`);

/**
 * The file's text with each level-2 `## To Do` heading renamed, or null when
 * it has none.
 * @param {string} text  a story file as read
 * @returns {string | null}
 */
export function renameHeading(text) {
  const { retiredSection } = scanDeferred(text);
  if (retiredSection.length === 0) return null;
  // scanDeferred's lines are the file's: a CRLF line keeps its `\r` here.
  const lines = text.split('\n');
  for (const line of retiredSection) lines[line - 1] = lines[line - 1].replace(RETIRED_RE, `$1${DEFERRED_HEADING}`);
  return lines.join('\n');
}

/**
 * The story files to rename, as `{ id, path, text }`, in id order.
 * @param {object} config  the loaded backlog config
 */
export function planHeadings(config) {
  const out = [];
  for (const story of readAllStories(config)) {
    const text = renameHeading(readFileSync(story.indexPath, 'utf8'));
    if (text !== null) out.push({ id: story.id, path: story.indexPath, text });
  }
  return out.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

/**
 * Run the migration. With `dryRun`, print what would be done and do nothing;
 * otherwise write it under the backlog lock and commit it once through
 * `syncAndCommit`. `log` gets one line per story file.
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void,
 *   commit?: typeof syncAndCommit }} [opts]  `commit` is for tests
 * @returns {Promise<{ plan: ReturnType<typeof planHeadings>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit = syncAndCommit } = {}) {
  return withLock(config.backlogRoot, async () => {
    const plan = planHeadings(config);
    if (plan.length === 0) {
      log(`no story has ## ${RETIRED_SECTION}: nothing to migrate`);
      return { plan, commit: null };
    }
    const verb = dryRun ? 'would rename' : 'rename';
    for (const p of plan) log(`${verb} ${p.id}: ${relative(config.backlogRoot, p.path)}`);
    if (dryRun) return { plan, commit: null };

    const result = await applyMigration(config, {
      message: `chore: F-82 heading migration: a story's ## ${RETIRED_SECTION} becomes ## ${DEFERRED_HEADING} (${plan.length} stories)`,
      commit,
      sync: runSync,
      apply: ({ write }) => {
        for (const p of plan) write(p.path, p.text);
      },
    });
    return { plan, commit: result };
  });
}
