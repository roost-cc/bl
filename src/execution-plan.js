/**
 * execution-plan.js — the execution plan of a list of stories, and every
 * ordering of stories and repos (F-125 D2).
 *
 * A feature, a story batch and a loose story are each a list of stories
 * (F-125 A1). `computePlan(stories, edges)` gives the plan of such a list:
 *
 * - `dependencies`: for each story, the listed stories it waits for, from
 *   the run and order edges between two of them (`storyDependencies`);
 * - `order`: the work order (`orderStoriesByDeps`), ties by story number;
 * - `groups`: the parallel groups in work order. A group holds stories whose
 *   dependencies are in earlier groups and whose plan files (`planFiles`) do
 *   not overlap another story of the group. File overlap is derived here and
 *   never written as an edge;
 * - `repos`: the repo order (`featureRepoOrder`), and `merge_order`, the
 *   repos sorted by the work unit's merge edges (`mergeOrder`).
 *
 * The module also holds the orderings bl used before the plan existed:
 * `dependencyOrder` (targets of a multi-story `bl merge`) and the plan-file
 * reader `planFiles`. No other module defines a story or repo ordering.
 *
 * `bl run` stores the plan as `plan.yaml` in the work unit's directory
 * (`writePlan`, checked against `schemas/plan.json`), and the run, `--resume`
 * and `bl merge` read it back (`readPlan`). During the run the stored plan,
 * not a new sort, decides the order.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { parseFrontmatter } from './config.js';
import { featureGraph, featureMergeEdges, findHoldCycles, readEdges, repoEnd, storyDependencies } from './blockers.js';
import { extractSection, normalizeFeatureId, resolveFeatureStories } from './feature.js';
import { normalizeBatchId } from './batch.js';
import { idNum } from './workon.js';
import { atomicWriteFile } from './atomic-write.js';
import { withCoveringLock } from './write-lock.js';
import { validateOutcome } from './outcome.js';
import { loadSchema } from './session.js';

// ---------------------------------------------------------------------------
// Story order
// ---------------------------------------------------------------------------

/**
 * For each of `ids`, the listed stories it waits for: the run and order
 * edges between two of them (`storyDependencies`, F-111 D4), in edge order.
 * @param {string[]} ids
 * @param {import("./blockers.js").Edge[]} edges
 * @returns {Map<string, string[]>}
 */
function listedDependencies(ids, edges) {
  const listed = new Set(ids);
  const all = storyDependencies(edges);
  return new Map(ids.map((id) => [id, (all.get(id) ?? []).filter((d) => listed.has(d) && d !== id)]));
}

/**
 * Order stories by their run and order edges (F-111 D4, F-125 D2): each
 * story after the stories it waits for, ties by story number. Only edges
 * between two of `stories` count, so one rule orders a feature, a batch and
 * a loose story. A cycle (`bl validate`'s `blockers-cycle`) leaves the stuck
 * remainder in number order.
 * @template {{ id: string }} S
 * @param {S[]} stories
 * @param {import("./blockers.js").Edge[]} edges  `readEdges`'s, or the graph's `edges`
 * @returns {S[]}
 */
export function orderStoriesByDeps(stories, edges) {
  const num = (s) => Number(String(s.id).match(/(\d+)$/)?.[1] ?? -1);
  const after = listedDependencies(
    stories.map((s) => s.id),
    edges,
  );
  const remaining = [...stories].sort((a, b) => num(a) - num(b));
  const emitted = new Set();
  const out = [];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((s) => (after.get(s.id) ?? []).every((d) => emitted.has(d)));
    if (idx === -1) {
      out.push(...remaining);
      break;
    }
    const [next] = remaining.splice(idx, 1);
    emitted.add(next.id);
    out.push(next);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repo order
// ---------------------------------------------------------------------------

/** The repo a feature's order puts first whenever one of its stories is in it (F-52 D3). */
export const LEAD_REPO = 'bl';

/**
 * A feature's repos in the one order every step uses (F-52 D3): its stories'
 * repos (`unitRepo`, each story's component's, D1), `bl` first when one is
 * there (S-864: a later repo's push gate reads backlog output the new `bl`
 * generates), then every other repo by its first story in the order given:
 * `resolveFeatureStories`'s (`orderStoriesByDeps`). A repo named twice keeps
 * its first place; an empty name is dropped. The first entry is the lead
 * repo. Pure: the stories are `readAllStories` records.
 *
 * @param {Array<{ id?: string, unitRepo?: string }>} stories
 * @returns {string[]}
 */
export function featureRepoOrder(stories) {
  const names = [];
  for (const s of stories ?? []) {
    const name = String(s.unitRepo ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  const lead = names.indexOf(LEAD_REPO);
  if (lead > 0) names.unshift(...names.splice(lead, 1));
  return names;
}

/**
 * The order `bl merge` merges a feature's repos in (F-111 D2): a
 * topological sort of `names` (`featureRepoOrder`) by the feature's merge
 * edges, each edge's blocker repo before its unit repo. Among the repos no
 * unmerged repo holds, `names`' order stays, so with no merge edge the order
 * is `names`. `edges` are the edges between two of `names`. A cycle gives no
 * order and the edges of one cycle.
 * @param {string[]} names
 * @param {import("./blockers.js").Edge[]} edges  the feature's merge edges (`featureMergeEdges`)
 * @returns {{ order: string[] | null, edges: import("./blockers.js").Edge[], cycle: import("./blockers.js").Edge[] | null }}
 */
export function mergeOrder(names, edges) {
  const repo = (id) => repoEnd(id)?.repo;
  const used = edges.filter((e) => names.includes(repo(e.blocker)) && names.includes(repo(e.unit)));
  const order = [];
  const rest = [...names];
  while (rest.length > 0) {
    const free = rest.findIndex((n) => used.every((e) => repo(e.unit) !== n || order.includes(repo(e.blocker))));
    if (free === -1) {
      const stuck = used.filter((e) => !order.includes(repo(e.unit)) && !order.includes(repo(e.blocker)));
      const [cycle] = findHoldCycles(featureGraph(stuck));
      return { order: null, edges: used, cycle: cycle.map((arc) => arc.edge) };
    }
    order.push(...rest.splice(free, 1));
  }
  return { order, edges: used, cycle: null };
}

// ---------------------------------------------------------------------------
// Plan files
// ---------------------------------------------------------------------------

/**
 * A backticked span that reads as a repository-relative path: a `/` or an
 * extension, no empty, `.` or `..` segment, not absolute, and no template or
 * glob marker (`<id>`, `{a,b}`, `*`, `$VAR`). Spaces, punctuation and
 * Unicode are kept as `git diff --name-only -z` prints them.
 */
function asPath(span) {
  const t = span.trim().replace(/^\.\//, '');
  const p = t.replace(/\/$/, '');
  if (!p || p.startsWith('/') || /[<>{}*?$|\\]/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  // A trailing `/` marks a directory, so `src/` is kept.
  if (!t.includes('/') && !/\.[\p{L}\p{N}]+$/u.test(p)) return null;
  return p;
}

/** Two `repo:path` keys touch the same file: equal, or one is a directory holding the other. */
function sameFiles(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * A plan without its `### Sources of truth` subsections, each running to the
 * next heading of level 1 to 3. Headings are mdast nodes, so every Markdown
 * form of one counts and a `#` line in a code block does not. A heading's
 * title is its text as read: inline formatting does not change it, and an
 * HTML comment is not part of it.
 */
function withoutSourcesOfTruth(plan) {
  const headings = fromMarkdown(plan).children.filter((n) => n.type === 'heading' && n.depth <= 3);
  let kept = '';
  let from = 0;
  headings.forEach((h, i) => {
    const title = toString(h, { includeHtml: false }).replace(/\s+/g, ' ').trim();
    if (h.depth !== 3 || title !== 'Sources of truth') return;
    kept += plan.slice(from, h.position.start.offset);
    from = headings[i + 1]?.position.start.offset ?? plan.length;
  });
  return kept + plan.slice(from);
}

/**
 * `repo:path` for every backticked path in the stories' `## Implementation
 * Plan`, keyed by each story's repo (`unitRepo`, its component's; else
 * `defaultRepo`). A path that is not backticked is not seen, and neither is
 * one under `### Sources of truth`: those files are read, not changed, so
 * they hold back no other story.
 *
 * @param {{ indexPath: string, unitRepo?: string }[]} stories
 * @param {string} [defaultRepo]
 * @returns {Set<string>}
 */
export function planFiles(stories, defaultRepo = '') {
  const out = new Set();
  for (const s of stories) {
    if (!existsSync(s.indexPath)) continue;
    const { body } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
    const plan = extractSection(body, 'Implementation Plan');
    if (!plan) continue;
    const repo = s.unitRepo || defaultRepo;
    for (const [, span] of withoutSourcesOfTruth(plan).matchAll(/`([^`\n]+)`/g)) {
      const p = asPath(span);
      if (p) out.add(`${repo}:${p}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Order of several targets (multi-story `bl merge`)
// ---------------------------------------------------------------------------

/**
 * The stories a unit carries: a story itself, a feature the stories naming it.
 * @param {{ kind: string, id: string, record: object }} unit
 */
function unitStories(unit, config, all) {
  if (unit.kind === 'feature') return resolveFeatureStories(unit.record, config, all).stories;
  return [unit.record];
}

/** Lowest id first; a feature before a story of the same number. */
function byId(a, b) {
  return idNum(a.id) - idNum(b.id) || (a.kind === b.kind ? 0 : a.kind === 'feature' ? -1 : 1);
}

/** Which target carries each story: story id → unit. */
function storyOwners(units, config, all) {
  const owner = new Map();
  const storiesOf = new Map();
  for (const u of units) {
    const stories = unitStories(u, config, all);
    storiesOf.set(u, stories);
    for (const s of stories) if (!owner.has(s.id)) owner.set(s.id, u);
  }
  return { owner, storiesOf };
}

/**
 * Units in dependency order (a unit after every target it depends on),
 * lowest id first among equals. A cycle falls back to id order for the rest.
 */
export function dependencyOrder(units, all, { config }) {
  const remaining = [...units].sort(byId);
  const { owner, storiesOf } = storyOwners(remaining, config, all);
  const waits = storyDependencies(readEdges(config));
  const deps = new Map();
  for (const u of remaining) {
    const set = new Set();
    for (const s of storiesOf.get(u)) {
      for (const d of waits.get(s.id) ?? []) {
        const other = owner.get(d);
        if (other && other !== u) set.add(other);
      }
    }
    deps.set(u, set);
  }
  const out = [];
  const emitted = new Set();
  while (remaining.length > 0) {
    const i = remaining.findIndex((u) => [...deps.get(u)].every((d) => emitted.has(d)));
    if (i === -1) {
      out.push(...remaining);
      break;
    }
    const [next] = remaining.splice(i, 1);
    emitted.add(next);
    out.push(next);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * The parallel groups of `order` (F-125 D2). Each round walks the stories
 * not yet grouped in work order and takes a story when every dependency
 * that comes before it in `order` is in an earlier group and its plan files
 * do not overlap (`sameFiles`) a story the round already took. A dependency
 * later in `order` is the rest of a cycle, which `order` already broke. The
 * first story left always qualifies, so every round takes one.
 * @param {string[]} order
 * @param {Map<string, string[]>} dependencies
 * @param {Map<string, Set<string>>} files  story id → its `repo:path` keys
 * @returns {string[][]}
 */
function parallelGroups(order, dependencies, files) {
  const place = new Map(order.map((id, i) => [id, i]));
  const grouped = new Set();
  const groups = [];
  let rest = [...order];
  while (rest.length > 0) {
    const group = [];
    const taken = [];
    for (const id of rest) {
      const ready = dependencies.get(id).every((d) => place.get(d) > place.get(id) || grouped.has(d));
      const clash = [...files.get(id)].some((f) => taken.some((g) => sameFiles(f, g)));
      if (!ready || clash) continue;
      group.push(id);
      taken.push(...files.get(id));
    }
    for (const id of group) grouped.add(id);
    rest = rest.filter((id) => !grouped.has(id));
    groups.push(group);
  }
  return groups;
}

/**
 * The execution plan of a list of stories (F-125 D2). Pure apart from
 * reading each story's file for its plan paths (`planFiles`).
 *
 * The merge edges used are those of the stories' work unit
 * (`featureMergeEdges` of the feature or batch the stories name). A merge-edge
 * cycle gives `merge_order: null` and the cycle's edges in `merge_cycle`.
 *
 * `taken` are the ids of stories a run has already taken (`replan`): they
 * keep that order at the front, and the other stories follow in dependency
 * order.
 *
 * @param {Array<{ id: string, unitRepo?: string, indexPath: string, feature?: string, batch?: string }>} stories
 *   `readAllStories` records
 * @param {import("./blockers.js").Edge[]} edges  `readEdges`'s, or the graph's `edges`
 * @param {{ taken?: string[] }} [options]
 * @returns {{ stories: string[], dependencies: Record<string, string[]>, order: string[],
 *   groups: string[][], repos: string[], merge_order: string[] | null,
 *   merge_cycle: import("./blockers.js").Edge[] | null }}
 */
export function computePlan(stories, edges, { taken = [] } = {}) {
  const ids = stories.map((s) => s.id);
  const dependencies = listedDependencies(ids, edges);
  const first = taken.map((id) => stories.find((s) => s.id === id)).filter(Boolean);
  const ordered = [
    ...first,
    ...orderStoriesByDeps(
      stories.filter((s) => !first.includes(s)),
      edges,
    ),
  ];
  const order = ordered.map((s) => s.id);
  const repos = featureRepoOrder(ordered);
  const files = new Map(stories.map((s) => [s.id, planFiles([s], repos[0] ?? '')]));
  const units = new Set(
    stories
      .map(
        (s) =>
          normalizeFeatureId(String(s.feature ?? '').trim())?.id ?? normalizeBatchId(String(s.batch ?? '').trim())?.id,
      )
      .filter(Boolean),
  );
  const merge = mergeOrder(
    repos,
    [...units].flatMap((id) => featureMergeEdges(edges, id)),
  );
  return {
    stories: ids,
    dependencies: Object.fromEntries(dependencies),
    order,
    groups: parallelGroups(order, dependencies, files),
    repos,
    merge_order: merge.order,
    merge_cycle: merge.cycle,
  };
}

// ---------------------------------------------------------------------------
// The stored plan: plan.yaml
// ---------------------------------------------------------------------------

/** The format and version `plan.yaml` names in its `schema:` field. */
export const PLAN_SCHEMA = 'bl-plan/v1';

/** The plan file's name in a work unit's directory, beside its change document. */
export const PLAN_FILE = 'plan.yaml';

/** The plan file of the work unit whose directory is `unitDir`. */
export function planPath(unitDir) {
  return join(unitDir, PLAN_FILE);
}

/**
 * The plan of `stories` for the unit `unitId` as `plan.yaml` stores it:
 * `computePlan`'s fields and no changes. `merge_cycle` is not stored: on a
 * cycle `merge_order` is null, and `bl merge` computes the merge order again
 * and names the cycle's edges.
 * @param {string} unitId
 * @param {Parameters<typeof computePlan>[0]} stories
 * @param {import("./blockers.js").Edge[]} edges
 * @param {string} [at]  ISO 8601
 */
export function newPlan(unitId, stories, edges, at = new Date().toISOString()) {
  const { merge_cycle: _cycle, ...plan } = computePlan(stories, edges);
  return { schema: PLAN_SCHEMA, unit: unitId, computed_at: at, ...plan, changes: [] };
}

/**
 * `plan` for the stories `stories`, when they are not the plan's stories:
 * computed again with the `taken` stories first in their order (a story
 * added during a run goes after the stories the run has taken), and one
 * `changes` entry by `bl` that names the stories added and removed and
 * says `why`. With the same stories it returns `plan` unchanged.
 * @param {object} plan  a stored plan (`readPlan`, `newPlan`)
 * @param {Parameters<typeof computePlan>[0]} stories
 * @param {import("./blockers.js").Edge[]} edges
 * @param {{ taken?: string[], why: string, at?: string }} change
 */
export function replan(plan, stories, edges, { taken = [], why, at = new Date().toISOString() }) {
  const ids = stories.map((s) => s.id);
  const added = ids.filter((id) => !plan.stories.includes(id));
  const removed = plan.stories.filter((id) => !ids.includes(id));
  if (added.length === 0 && removed.length === 0) return plan;
  const { merge_cycle: _cycle, ...next } = computePlan(stories, edges, { taken });
  const what = [added.length > 0 && `added ${added.join(', ')}`, removed.length > 0 && `removed ${removed.join(', ')}`]
    .filter(Boolean)
    .join('; ');
  return { ...plan, ...next, changes: [...plan.changes, { at, by: 'bl', what, why }] };
}

/** `plan` when it matches `schemas/plan.json`; else an error that names `path` and the field. */
function checkedPlan(path, plan) {
  if (plan == null) throw new Error(`${path}: the file holds no plan`);
  const { structuredError } = validateOutcome(loadSchema('plan'), plan);
  if (structuredError) throw new Error(`${path}: ${structuredError}`);
  return plan;
}

/**
 * The plan stored in `unitDir`, or null when it has none. Throws, naming
 * the file and the field, when the file is not YAML or does not match
 * `schemas/plan.json`.
 * @param {string} unitDir
 */
export function readPlan(unitDir) {
  const path = planPath(unitDir);
  if (!existsSync(path)) return null;
  let plan;
  try {
    plan = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: not YAML: ${e.message}`, { cause: e });
  }
  return checkedPlan(path, plan);
}

/**
 * Write `plan` to `unitDir`'s `plan.yaml` through `atomicWriteFile`, under
 * its covering lock. Throws, naming the file and the field, when `plan`
 * does not match `schemas/plan.json`, and writes nothing. Returns the path.
 * @param {string} backlogRoot
 * @param {string} unitDir
 * @param {object} plan
 */
export async function writePlan(backlogRoot, unitDir, plan) {
  const path = planPath(unitDir);
  const text = stringifyYaml(checkedPlan(path, plan));
  await withCoveringLock(backlogRoot, path, (target) => atomicWriteFile(backlogRoot, target, text));
  return path;
}
