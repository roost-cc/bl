/**
 * migrate-depends-on.js — the one F-111 migration (Design D5, Decision A3),
 * run by `scripts/migrate-depends-on.js`.
 *
 * Since F-111 every hold and order between units lives in `blockers.json`;
 * until this migration runs, bl reads each `depends_on:` entry in a story
 * file as the edge it stands for (`dependsOnEdges`, the read adapter of R4),
 * and `bl validate` warns `depends-on-key`. The migration:
 *
 *   1. writes to `blockers.json` each entry's edge (`dependencyEdge`: an
 *      order edge between two stories of one feature, else a run edge) that
 *      is not there yet; an entry whose edge `bl block add` would refuse (an
 *      id that is no story) is not placed, and is listed;
 *   2. re-reads `blockers.json`, and removes a story's `depends_on:` only
 *      when every edge its entries give is there; a story that does not
 *      match keeps its key and is listed with the missing edges, and a later
 *      run removes the key once it is fixed. It removes `required_for:` (a
 *      derived key, F-77) and an empty `depends_on:` from every story, closed
 *      ones too. Each block is written through `serializeFrontmatter` and
 *      checked to read back as the old block less those keys (`planText`);
 *   3. appends a section to MIGRATION.md with the counts and the stories
 *      kept, and commits the backlog once through `syncAndCommit`.
 *
 * Only story files hold `depends_on:` or `required_for:` (`bl validate`
 * refuses both on any other kind). Reading the edges after the migration
 * gives the same edges as before it (`readEdges`: the file's edge wins over a
 * key's of one identity), so every verb prints the same.
 *
 * Idempotent: a second run on a consistent backlog plans nothing and commits
 * nothing. Retryable: it starts only on a clean backlog at origin/main with
 * no bl run active, and a step or commit that fails resets the backlog to
 * HEAD (`migration-txn.js`).
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { loadBacklog } from './backlog-graph.js';
import {
  BLOCKERS_FILE,
  ORDER_EDGE,
  blockersPath,
  dependsOnEdges,
  edgeKey,
  edgeLabel,
  edgeProblems,
  formatBlockers,
  readBlockers,
  readUnits,
} from './blockers.js';
import { loadFlow } from './flow.js';
import { withLock } from './lock.js';
import { planText } from './migrate-derived-keys.js';
import { applyMigration, assertMigrationCanStart } from './migration-txn.js';
import { syncAndCommit } from './sync.js';

const MIGRATION_HEADING = '## F-111 depends_on migration';

/**
 * The edges to write and the entries that cannot be placed, from the
 * backlog as it is: every story's `depends_on:` entries as edges
 * (`dependsOnEdges`), split into those `blockers.json` already holds (by
 * identity), those to add (each once), and those `bl block add` would refuse
 * (`edgeProblems`: an id that is no story).
 * @param {object} config
 * @returns {{ stories: any[], keyEdges: Map<string, import("./blockers.js").Edge[]>,
 *   fileEdges: import("./blockers.js").Edge[], add: import("./blockers.js").Edge[],
 *   present: number, unplaced: { edge: import("./blockers.js").Edge, why: string }[] }}
 */
function planEdges(config) {
  const graph = loadBacklog(config, { reload: true });
  const stories = graph.list('story');
  const fromKeys = dependsOnEdges(
    stories.map((s) => ({ id: s.id, depends_on: s.fm.depends_on, feature: s.feature?.id ?? '' })),
  );
  const keyEdges = new Map();
  for (const e of fromKeys) keyEdges.set(e.unit, [...(keyEdges.get(e.unit) ?? []), e]);

  const { edges: fileEdges } = readBlockers(config.backlogRoot);
  const known = new Set(fileEdges.map(edgeKey));
  const units = readUnits(config);
  const flow = loadFlow(config.backlogRoot);
  const add = [];
  const unplaced = [];
  let present = 0;
  for (const e of fromKeys) {
    if (known.has(edgeKey(e))) {
      present++;
      continue;
    }
    const problems = edgeProblems(e, units, flow);
    if (problems.length > 0) {
      unplaced.push({ edge: e, why: problems.map((p) => p.message).join('; ') });
      continue;
    }
    known.add(edgeKey(e));
    add.push(e);
  }
  return { stories, keyEdges, fileEdges, add, present, unplaced };
}

/**
 * Each story file to rewrite against the edges in `keys` (identities): its
 * `required_for:` goes, and its `depends_on:` too when every edge its
 * entries give is in `keys`; else the story keeps the key and is listed in
 * `kept` with the missing edges.
 * @param {any[]} stories  the graph's story units
 * @param {Map<string, import("./blockers.js").Edge[]>} keyEdges
 * @param {Set<string>} keys
 */
function planFiles(stories, keyEdges, keys) {
  const rewrites = [];
  const kept = [];
  for (const s of stories) {
    const remove = ['required_for'];
    if (Object.hasOwn(s.fm, 'depends_on')) {
      const missing = (keyEdges.get(s.id) ?? []).filter((e) => !keys.has(edgeKey(e)));
      if (missing.length === 0) remove.push('depends_on');
      else kept.push({ id: s.id, relPath: s.relPath, missing });
    }
    let planned;
    try {
      planned = planText(s.text(), remove);
    } catch (e) {
      throw new Error(`${s.relPath}: ${e.message}`);
    }
    if (planned) rewrites.push({ path: s.file, id: s.id, ...planned });
  }
  return { rewrites, kept };
}

/**
 * What the migration would do, without doing it.
 * @param {object} config  the loaded backlog config
 */
export function planDependsOn(config) {
  const edges = planEdges(config);
  const keys = new Set([...edges.fileEdges, ...edges.add].map(edgeKey));
  return { ...edges, ...planFiles(edges.stories, edges.keyEdges, keys) };
}

/**
 * The counts a plan reports: the order and run edges it writes, the edges
 * already in `blockers.json`, the `depends_on:` and `required_for:` keys it
 * removes, the stories that keep their `depends_on:`, and the entries it
 * cannot place.
 */
export function planCounts(plan) {
  const removed = (k) => plan.rewrites.filter((r) => r.removed.includes(k)).length;
  return {
    order_edges: plan.add.filter((e) => e.gate === ORDER_EDGE.gate).length,
    run_edges: plan.add.filter((e) => e.gate !== ORDER_EDGE.gate).length,
    already_in_blockers: plan.present,
    depends_on_removed: removed('depends_on'),
    required_for_removed: removed('required_for'),
    files_kept: plan.kept.length,
    unplaced: plan.unplaced.length,
  };
}

/** `order edges: 3, run edges: 5, …`. */
export function countsText(c) {
  return Object.entries(c)
    .map(([k, n]) => `${k.replace(/_/g, ' ')}: ${n}`)
    .join(', ');
}

/** The MIGRATION.md section for a plan. */
export function migrationSection(plan, date = new Date().toISOString().slice(0, 10)) {
  const lines = [
    `${MIGRATION_HEADING} (${date})`,
    '',
    `Every story's depends_on: entry is an edge in ${BLOCKERS_FILE} (F-111 D4, D5): an order edge between two ` +
      'stories of one feature, else a run edge. A depends_on: key was removed only where every edge it gives ' +
      `is in ${BLOCKERS_FILE}; required_for: and empty depends_on: keys were removed from every story. ` +
      `${countsText(planCounts(plan))}.`,
  ];
  if (plan.kept.length > 0) {
    lines.push('', 'Stories that keep their depends_on: (bl reads it until the missing edges are fixed):', '');
    for (const k of plan.kept) lines.push(`- ${k.id}: missing ${k.missing.map(edgeLabel).join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

/** The backlog commit message, with the counts. */
export function commitMessage(c) {
  return `chore: F-111 depends_on migration: ${countsText(c)}`;
}

/**
 * Run the migration. With `dryRun`, print what would be done and do
 * nothing; otherwise write everything under the backlog lock and commit it
 * once through `syncAndCommit`. `log` gets one line per edge it would write,
 * per entry it cannot place, per story it would rewrite or keep, then the
 * counts.
 *
 * @param {object} config  the loaded backlog config
 * @param {{ dryRun?: boolean, log?: (line: string) => void,
 *   commit?: typeof syncAndCommit }} [opts]  `commit` is for tests
 * @returns {Promise<{ counts: ReturnType<typeof planCounts>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit = syncAndCommit } = {}) {
  const root = config.backlogRoot;
  return withLock(root, async () => {
    // Before the plan: a dry run, or a run with nothing to change, is refused too.
    assertMigrationCanStart(config);
    const plan = planDependsOn(config);
    const counts = planCounts(plan);
    const verb = dryRun ? 'would ' : '';
    for (const e of plan.add) log(`${verb}write   ${edgeLabel(e)} until ${e.until}`);
    for (const u of plan.unplaced) log(`cannot place ${edgeLabel(u.edge)}: ${u.why}`);
    for (const r of plan.rewrites) log(`${verb}rewrite ${relative(root, r.path)} (${r.removed.join(', ')} removed)`);
    for (const k of plan.kept) log(`keep    ${k.relPath} depends_on: (missing ${k.missing.map(edgeLabel).join(', ')})`);
    const changes = plan.add.length > 0 || plan.rewrites.length > 0;
    if (changes) log(`${verb}append  MIGRATION.md`);
    log(countsText(counts));
    if (dryRun || !changes) return { counts, commit: null };

    const result = await applyMigration(config, {
      message: commitMessage(counts),
      commit,
      apply: ({ write }) => {
        if (plan.add.length > 0) write(blockersPath(root), formatBlockers([...plan.fileEdges, ...plan.add]));
        // The evidence (Decision A3): a depends_on: goes only when the file, as
        // re-read, holds every edge it gives.
        const onDisk = new Set(readBlockers(root).edges.map(edgeKey));
        const { rewrites } = planFiles(plan.stories, plan.keyEdges, onDisk);
        const same = (a, b) =>
          a.map((r) => `${r.id}:${r.removed}`).join() === b.map((r) => `${r.id}:${r.removed}`).join();
        if (!same(rewrites, plan.rewrites))
          throw new Error(`${BLOCKERS_FILE} does not read back with the edges written`);
        for (const r of rewrites) write(r.path, r.text);
        const path = join(root, 'MIGRATION.md');
        const was = existsSync(path) ? readFileSync(path, 'utf8') : '# Backlog Migration\n';
        write(path, `${was.replace(/\s*$/, '')}\n\n${migrationSection(plan)}`);
      },
    });
    return { counts, commit: result };
  });
}
