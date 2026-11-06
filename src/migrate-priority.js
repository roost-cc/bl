/**
 * migrate-priority.js — the one F-78 migration (Design D5), run by
 * `scripts/migrate-priority.js`.
 *
 * Before F-78 the operator's feature order was `feature-order.md`'s
 * `ranked:` (`{ feature, why }` entries), with `## Next up` and
 * `## Not yet ranked` tables `bl sync` wrote and a `## History` `bl merge`
 * appended to. Since F-78 the order is `priority.md`'s (`src/priority.js`),
 * one list of units nothing automated writes. The migration:
 *
 *   1. reads `feature-order.md`'s `ranked:` and keeps, in order, each entry
 *      whose feature exists and is open (`flow.meets(…, 'done')` false, via
 *      the graph), once, as `{ unit, why }`; the rest are dropped;
 *   2. writes `priority.md`: that `ranked:` (any other frontmatter key kept),
 *      a body made of the template's intro (`templates/priority.md`, the one
 *      wording of how the file works), the old intro's own paragraphs less
 *      the ones that describe the old mechanism (they name `bl sync` or
 *      `ranked:`), and the old `## History` with a line for this migration;
 *      the generated `## Next up` and `## Not yet ranked` are dropped;
 *   3. moves `feature-order.md` to `priority.md`, so the commit removes the
 *      old file, and commits the backlog once through `syncAndCommit`, after
 *      a `bl sync`.
 *
 * Every loose story starts unranked: the Backlog table's story order was
 * never a deliberate ranking (operator, 2026-11-05).
 *
 * Idempotent: with no `feature-order.md` a run plans nothing. A backlog that
 * already has a `priority.md` beside `feature-order.md` is refused, so a
 * ranking the operator made is never overwritten.
 *
 * Retryable: it starts only on a clean backlog at origin/main with no bl run
 * active, and a step or commit that fails resets the backlog to HEAD
 * (`migration-txn.js`). The commit goes through `commitPaths`, which refuses
 * `priority.md` under `BL_HEADLESS`: the operator runs it, not an agent.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter, parseFrontmatterOf, serializeFrontmatter } from './config.js';
import { loadBacklog } from './backlog-graph.js';
import { extractSection, normalizeFeatureId } from './feature.js';
import { withLock } from './lock.js';
import { applyMigration } from './migration-txn.js';
import { PRIORITY_FILE, parseRanked } from './priority.js';
import { runSync, syncAndCommit } from './sync.js';

/** The old file's name, at the backlog root; this module is the last to know it. */
export const OLD_FILE = 'feature-order.md';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', PRIORITY_FILE);

/** A paragraph of the old intro that describes the old mechanism. */
const MECHANISM = /`bl sync`|`ranked:`/;

/** The body of `templates/priority.md`: `# Priority` and how the file works. */
function templateBody() {
  return parseFrontmatter(readFileSync(TEMPLATE, 'utf8')).body.trim();
}

/**
 * The old body's intro paragraphs to keep: those between its `# ` title and
 * its first `## ` section that do not describe the old mechanism.
 * @param {string} body
 * @returns {string[]}
 */
export function keptIntro(body) {
  const intro = body.split(/^## /m)[0];
  return intro
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^# /.test(p) && !MECHANISM.test(p));
}

/**
 * `priority.md`'s text from `feature-order.md`'s: see the module comment.
 * @param {string} oldText  `feature-order.md` as read
 * @param {Map<string, any>} features  the graph's feature units
 * @param {string} date  `YYYY-MM-DD`, for the History line
 * @returns {{ text: string, kept: Array<{ unit: string, why: string }>,
 *   dropped: Array<{ feature: string, reason: string }> }}
 */
export function planText(oldText, features, date) {
  const lf = oldText.replace(/\r\n/g, '\n');
  const { fm, body } = parseFrontmatterOf(lf, OLD_FILE);
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const entry of parseRanked(fm.ranked, 'feature', OLD_FILE)) {
    const id = normalizeFeatureId(entry.feature)?.id;
    const f = id && features.get(id);
    const drop = (reason) => dropped.push({ feature: entry.feature, reason });
    if (!f) drop('no such feature');
    else if (f.done) drop(`${f.status}`);
    else if (seen.has(id)) drop('ranked twice');
    else {
      seen.add(id);
      kept.push({ unit: id, why: entry.why });
    }
  }
  const history = (extractSection(body, 'History') ?? '').trim();
  const line = `- ${date}: ${OLD_FILE} became ${PRIORITY_FILE} (F-78): one list of features and loose stories, ranked with \`bl rank\`; the open ranked features kept their order.`;
  const parts = [templateBody(), ...keptIntro(body), `## History\n\n${history ? `${history}\n` : ''}${line}`];
  const text = `${serializeFrontmatter({ ...fm, ranked: kept })}\n${parts.join('\n\n')}\n`;
  // The written file must read back as the order planned.
  const back = parseRanked(parseFrontmatter(text).fm.ranked).map(({ unit, why }) => ({ unit, why }));
  if (JSON.stringify(back) !== JSON.stringify(kept)) {
    throw new Error(`the ${PRIORITY_FILE} written does not read back as planned`);
  }
  return { text, kept, dropped };
}

/**
 * What the migration would do, without doing it, or null when there is
 * nothing to migrate (no `feature-order.md`). Throws when `priority.md`
 * exists beside it.
 * @param {object} config  the loaded backlog config
 * @param {string} [date]
 */
export function planPriority(config, date = new Date().toISOString().slice(0, 10)) {
  const root = config.backlogRoot;
  const from = join(root, OLD_FILE);
  const to = join(root, PRIORITY_FILE);
  if (!existsSync(from)) return null;
  if (existsSync(to)) {
    throw new Error(
      `${PRIORITY_FILE} already exists beside ${OLD_FILE}: compare the two, keep the ranking you want in ${PRIORITY_FILE}, remove ${OLD_FILE} by hand, and do not rerun`,
    );
  }
  const graph = loadBacklog(config, { reload: true });
  return { from, to, ...planText(readFileSync(from, 'utf8'), graph.features, date) };
}

/** The backlog commit message. */
export function commitMessage(plan) {
  return `chore: F-78 priority migration: ${OLD_FILE} becomes ${PRIORITY_FILE} (${plan.kept.length} kept, ${plan.dropped.length} dropped)`;
}

/**
 * Run the migration. With `dryRun`, print what would be done and do
 * nothing; otherwise write it under the backlog lock and commit it once
 * through `syncAndCommit`. `log` gets one line per entry kept or dropped.
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void,
 *   commit?: typeof syncAndCommit, date?: string }} [opts]  `commit` and `date` are for tests
 * @returns {Promise<{ plan: ReturnType<typeof planPriority>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit = syncAndCommit, date } = {}) {
  return withLock(config.backlogRoot, async () => {
    const plan = planPriority(config, date);
    if (!plan) {
      log(`no ${OLD_FILE}: nothing to migrate`);
      return { plan, commit: null };
    }
    const verb = dryRun ? 'would ' : '';
    for (const k of plan.kept) log(`${verb}keep ${k.unit}`);
    for (const d of plan.dropped) log(`${verb}drop ${d.feature} (${d.reason})`);
    log(`${verb}move ${OLD_FILE} to ${PRIORITY_FILE}`);
    if (dryRun) return { plan, commit: null };

    const result = await applyMigration(config, {
      message: commitMessage(plan),
      commit,
      sync: runSync,
      apply: ({ move, write }) => {
        move(plan.from, plan.to);
        write(plan.to, plan.text);
      },
    });
    return { plan, commit: result };
  });
}
