/**
 * migrate-generated-sections.js — the one F-79 migration (Design D3), run by
 * `scripts/migrate-generated-sections.js`.
 *
 * Before F-79 `bl sync` wrote derived tables into committed pages. Since
 * F-79 `bl report` and `bl view` render them when a page is read
 * (`render.js`), and `bl validate` reports a committed one
 * (`generated-section`). The migration removes, from every committed page,
 * each `## ` section `GENERATED_SECTIONS` names for the page's kind, with its
 * body, and from the root `index.md` its "Total backlog" line and the two
 * tables the root had before the priority (`## Features`, `## Backlog`). A
 * section is matched as `extractSection` (and so `bl validate`) matches it
 * (`removeSection`), and goes only when its body is a table and nothing else
 * (`isGeneratedBody`): a story's hand-written `## Tasks` list stays.
 * Everything else, frontmatter included, stays byte for byte.
 *
 * Idempotent: with no generated section left a run plans nothing.
 *
 * Retryable: it starts only on a clean backlog at origin/main with no bl run
 * active (checked before it plans, so a dry run is refused too), and a step
 * or commit that fails resets the backlog to HEAD (`migration-txn.js`). It
 * commits once through `syncAndCommit`.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadBacklog } from './backlog-graph.js';
import { parseFrontmatter } from './config.js';
import { removeSection } from './feature.js';
import { withLock } from './lock.js';
import { applyMigration, assertMigrationCanStart } from './migration-txn.js';
import { GENERATED_SECTIONS, TOTAL_BACKLOG_RE, isGeneratedBody } from './render.js';
import { syncAndCommit } from './sync.js';

/** The root's tables before F-78's priority; this module is the last to know them. */
const RETIRED_ROOT_SECTIONS = ['Features', 'Backlog'];

/** The page kinds with generated sections, in the order the plan lists them. */
const KINDS = ['root', 'theme', 'epic', 'component', 'feature', 'story'];

/**
 * `text` (a whole page, frontmatter included) without the `headings`
 * sections and, for the root, the "Total backlog" line with the blank lines
 * after it; null when nothing goes.
 * @param {string} text
 * @param {string} body  the part of `text` after its frontmatter
 * @param {readonly string[]} headings
 * @param {boolean} root
 * @returns {string | null}
 */
export function stripGenerated(text, body, headings, root) {
  let out = body;
  if (root) out = out.replace(new RegExp(`${TOTAL_BACKLOG_RE.source}\\r?\\n(?:[ \\t]*\\r?\\n)*`, 'm'), '');
  for (const h of headings) out = removeSection(out, h, isGeneratedBody);
  return out === body ? null : text.slice(0, text.length - body.length) + out;
}

/**
 * The pages to rewrite, as `{ kind, path, text }`, root first, then by kind
 * and the graph's order.
 * @param {object} config  the loaded backlog config
 */
export function planSections(config) {
  const graph = loadBacklog(config, { reload: true });
  const out = [];
  const root = join(config.backlogRoot, 'index.md');
  if (existsSync(root)) {
    const text = readFileSync(root, 'utf8');
    const headings = [...GENERATED_SECTIONS.root, ...RETIRED_ROOT_SECTIONS];
    const stripped = stripGenerated(text, parseFrontmatter(text).body, headings, true);
    if (stripped !== null) out.push({ kind: 'root', path: root, text: stripped });
  }
  for (const kind of KINDS.slice(1)) {
    for (const u of graph.list(kind)) {
      const stripped = stripGenerated(u.text(), u.body(), GENERATED_SECTIONS[kind], false);
      if (stripped !== null) out.push({ kind, path: u.file, text: stripped });
    }
  }
  return out;
}

/** `<n> <kind>` per kind with a page in the plan, in `KINDS` order. */
function counts(plan) {
  return KINDS.map((k) => [k, plan.filter((p) => p.kind === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
}

/**
 * Run the migration. With `dryRun`, print what would be done and do nothing;
 * otherwise write it under the backlog lock and commit it once through
 * `syncAndCommit`. `log` gets one line: the pages per kind.
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void,
 *   commit?: typeof syncAndCommit }} [opts]  `commit` is for tests
 * @returns {Promise<{ plan: ReturnType<typeof planSections>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit = syncAndCommit } = {}) {
  return withLock(config.backlogRoot, async () => {
    // Before the plan: a dry run, or a run with nothing to remove, is refused too.
    assertMigrationCanStart(config);
    const plan = planSections(config);
    if (plan.length === 0) {
      log('no page has a generated section: nothing to migrate');
      return { plan, commit: null };
    }
    log(`${dryRun ? 'would remove' : 'remove'} generated sections from ${counts(plan).join(', ')} page(s)`);
    if (dryRun) return { plan, commit: null };

    const result = await applyMigration(config, {
      message: `chore: F-79 generated-sections migration: derived tables leave the committed pages (${plan.length} pages)`,
      commit,
      apply: ({ write }) => {
        for (const p of plan) write(p.path, p.text);
      },
    });
    return { plan, commit: result };
  });
}
