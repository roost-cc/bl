/**
 * next.js — `bl next`: the next unit to run, by the backlog's priority and
 * its hard dependencies (F-78 D2).
 *
 *   bl next [--theme <slug>] [--epic E<nn>]
 *
 * It walks `backlog.priority` (`priority.yaml`'s open ranked units, then every
 * other open unit by `added:`, F-78 D1) and prints the first unit that nothing
 * holds. A unit is held by what `bl run` would refuse it for, so `bl next`
 * never offers what `bl run` refuses: an unmet edge at a status on `run`'s
 * nominal path (`heldBy` of `readEdges`: `blockers.json`'s, and the run edge of each
 * `depends_on:` on a loose story or outside a feature).
 *
 * A unit held by an open story or feature gives way to the blocker's unit
 * (the story's feature, or the story itself when loose), ranked or not,
 * followed until one is free; stderr says which unit that unblocks. A unit
 * held only by a task (an operator action) or by nothing bl can run is passed
 * over, its holder named on stderr.
 *
 * stdout: one id, `F-<n>` or `S-<n>`, or nothing. stderr: the ranked units
 * that match the filter (position, id, title), the unranked tail's first
 * few, and why the pick was made. The order is a preference; this never reads
 * the roadmap. The story picker inside a feature or filter is `bl what-next`.
 *
 * The walk is `nextPlan()`, which `bl top`'s snapshot reads too (F-87 D1).
 */

import { loadConfig, parseArgs, info } from './config.js';
import { filterContext, filterFromArgs, filterLabel, featureEpicId, featureMatches, storyMatches } from './filter.js';
import { heldBy, readUnits } from './blockers.js';
import { readAllStories } from './story.js';
import { loadBacklog } from './backlog-graph.js';
import { PRIORITY_FILE, isLooseStory } from './priority.js';
import { flowForHelp, loadFlow, statusWords } from './flow.js';

/** How many of the unranked tail stderr names. */
const TAIL_SHOWN = 5;

const help = (flow) => `Usage: bl next [--theme <slug>] [--epic <E-id>]

Print the next unit to run, a feature or a loose story, that is not ${statusWords(flow.closedStatusesOf('feature'))} and
that nothing holds, by the backlog's priority: the units ${PRIORITY_FILE} lists first,
then every other unit, oldest "added:" first. Hard dependencies come first: a
unit that bl run would refuse (an open story it depends on outside itself, or
a blockers.json edge at a status on bl run's path) gives way to its blocker's unit, followed
until one is free. A unit held only by a task is passed over.

Options:
  --theme <slug>   Only units in this theme (a loose story: a theme whose
                   repos list its component's repo)
  --epic <E-id>    Only features of this epic

Output:
  stdout   The unit id (e.g. F-48 or S-120), or nothing when no unit can
           run.
  stderr   The matching ranked units (position, id, title), the first
           few unranked ones, and why the pick was made: the ranked unit a
           blocker unblocks, or the task a unit waits for.

Exit codes:
  0   Answered (stdout may be empty).
  1   Unknown theme or epic, a malformed filter, or a ${PRIORITY_FILE} that
      is not YAML (run bl validate).

Rank units with bl rank. bl what-next picks the next story inside a feature
or filter.`;

/**
 * Everything `bl next` reads, once: the graph, its story records, the
 * blocker units and the filter context.
 */
function readState(config, flow, ctx) {
  const graph = loadBacklog(config);
  const pinned = { ...config, backlogGraph: graph };
  const recordById = new Map(readAllStories(pinned).map((r) => [r.id, r]));
  // `waits`: each unit found held with no free blocker, and what holds it.
  return { graph, flow, config: pinned, recordById, units: readUnits(pinned), ctx, waits: new Map() };
}

/** A unit's member story records: a feature's stories, or the loose story itself. */
function members(state, unit) {
  const ids = unit.kind === 'feature' ? unit.stories.map((s) => s.id) : [unit.id];
  return ids.map((id) => state.recordById.get(id)).filter(Boolean);
}

/** Whether unit `u` passes the filter (theme and epic; F-51 D1). */
function matches(state, u, filter) {
  if (u.kind === 'feature') {
    const record = state.ctx.featuresById.get(u.id);
    return record != null && featureMatches(record, members(state, u), filter);
  }
  const record = state.recordById.get(u.id);
  return record != null && storyMatches(record, filter, state.ctx);
}

/**
 * The unit a blocker is run as: a feature itself, a story's feature, a loose
 * story itself. Null for anything bl cannot run as a unit: a task, an update
 * story, a story of a closed feature, an unknown id.
 */
function unitOf(graph, id) {
  const u = graph.get(id);
  if (!u || u.done) return null;
  if (u.kind === 'feature') return u;
  if (u.kind !== 'story') return null;
  if (u.feature) return u.feature.done ? null : u.feature;
  return isLooseStory(u) ? u : null;
}

/**
 * What holds unit `u` from `bl run`: `runnable`, each open blocker as the unit
 * it runs as (with the words that name the hold), and `waits`, every other
 * holder named (a task, a missing story, an update story). `ids` names every
 * holder once: the unit an open blocker runs as, or the holder's own id.
 * @returns {{ runnable: Array<{ unit: any, why: string }>, waits: string[], ids: string[] }}
 */
function holdsOf(state, u) {
  const { graph } = state;
  const runnable = [];
  const waits = [];
  const ids = new Set();
  const add = (id, why) => {
    const target = unitOf(graph, id);
    ids.add(target?.id ?? id);
    if (target) runnable.push({ unit: target, why });
    else waits.push(why);
  };
  for (const h of heldBy(state.config, u.id, 'run', { units: state.units })) add(h.edge.blocker, h.line);
  return { runnable, waits, ids: [...ids] };
}

/**
 * The first unit, from `u` along its runnable blockers depth first, that
 * nothing holds; null when every path ends at a task or loops. `path` is the
 * chain of hold words that led to it.
 * @returns {{ unit: any, path: string[] } | null}
 */
function free(state, u, seen = new Set(), path = []) {
  if (seen.has(u) || state.waits.has(u)) return null;
  seen.add(u);
  const { runnable, waits } = holdsOf(state, u);
  if (runnable.length === 0 && waits.length === 0) return { unit: u, path };
  for (const r of runnable) {
    const found = free(state, r.unit, seen, [...path, r.why]);
    if (found) return found;
  }
  state.waits.set(u, waits.length > 0 ? waits : runnable.map((r) => r.why));
  return null;
}

/** `F-3  Title  [backlog, E50]` or `S-4  Title  [C01]`. */
function describe(u) {
  if (u.kind === 'feature') {
    const epic = featureEpicId({ epic: u.fm.epic });
    const theme = u.theme?.id ?? (String(u.fm.theme ?? '').trim() || 'no theme');
    return `${u.id}  ${u.title}  [${theme}${epic ? `, ${epic}` : ''}]`;
  }
  return `${u.id}  ${u.title}  [${u.component?.id ?? 'no component'}]`;
}

/** `F-3 (ranked 1)` or `S-9 (unranked)`. */
function placeOf(entry) {
  return `${entry.id} (${entry.position != null ? `ranked ${entry.position}` : 'unranked'})`;
}

/**
 * @typedef {{ unit: any, id: string, title: string, status: string, points: number,
 *   position: number | null }} PlanEntry
 *   `position`: its entry's place in the priority file from 1, null when unranked
 */

/**
 * The walk `bl next` prints (F-87 D1): the open units that match `filter`
 * in priority order, split into the ranked ones and the unranked tail (each
 * with `holds`, the words of everything that holds it from `bl run`, and
 * `heldBy`, the ids of those holders), and the pick. `pick.from` is the unit
 * the walk started at, which the pick unblocks when it is another;
 * `pick.path` the hold words that led to it. `waits` is each unit found held
 * with no free blocker, and what holds it. `graph` is the backlog graph the
 * walk read. Throws when `priority.yaml` is not YAML.
 *
 * @param {object} config  `loadConfig()`
 * @param {{ theme: string|null, epic: string|null }} filter  `parseFilter`'s, or all null
 * @param {{ ctx?: object, flow?: object }} [opts]  the filter context and flow, when the caller has read them
 * @returns {{ problems: object[], graph: any, ranked: Array<PlanEntry & { holds: string[], heldBy: string[] }>,
 *   unranked: Array<PlanEntry & { holds: string[], heldBy: string[] }>,
 *   pick: { unit: any, from: PlanEntry, path: string[] } | null,
 *   waits: Array<{ entry: PlanEntry, why: string[] }> }}
 */
export function nextPlan(config, filter, { ctx = filterContext(config), flow = loadFlow(config.backlogRoot) } = {}) {
  // A priority.yaml that is not YAML stops the strict graph load, naming the file.
  const state = readState(config, flow, ctx);
  const { graph } = state;
  const rankedEntry = new Map(graph.ranked.map((e) => [e.unit, e]));
  /** @returns {PlanEntry} */
  const entry = (u) => {
    const e = rankedEntry.get(u);
    return {
      unit: u,
      id: u.id,
      title: u.title,
      status: u.status,
      points: u.points,
      position: e?.position ?? null,
    };
  };
  const withHolds = (u) => {
    const { runnable, waits, ids } = holdsOf(state, u);
    return { ...entry(u), holds: [...runnable.map((r) => r.why), ...waits], heldBy: ids };
  };
  const order = graph.priority.filter((u) => matches(state, u, filter));
  const ranked = order.filter((u) => rankedEntry.has(u)).map(withHolds);
  const unranked = order.filter((u) => !rankedEntry.has(u)).map(withHolds);

  let pick = null;
  for (const u of order) {
    if (state.waits.has(u)) continue;
    const found = free(state, u, new Set());
    if (found) {
      pick = { unit: found.unit, from: entry(u), path: found.path };
      break;
    }
  }
  const waits = [...state.waits]
    .filter(([held]) => held !== pick?.from.unit)
    .map(([held, why]) => ({ entry: entry(held), why }));
  return { problems: graph.problems, graph, ranked, unranked, pick, waits };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(help(flowForHelp()));
    process.exit(0);
  }
  for (const flag of ['feature', 'component']) {
    if (args[flag] != null) {
      console.error(`bl next: --${flag} is not a unit filter; use --theme or --epic`);
      process.exit(1);
    }
  }
  if (args.positional.length > 0) {
    console.error(`bl next: takes no arguments (got ${args.positional.join(' ')}); bl what-next picks a story`);
    process.exit(1);
  }

  const config = loadConfig();
  const flow = loadFlow(config.backlogRoot);
  const { filter, ctx } = filterFromArgs(args, config, 'bl next');
  const { problems, ranked, unranked, pick, waits } = nextPlan(config, filter, { ctx, flow });
  for (const p of problems) {
    if (p.code === 'priority-file') info(`bl next: ${p.message}; every unit is unranked (run bl validate)`);
  }

  const scope = filterLabel(filter);
  if (ranked.length === 0 && unranked.length === 0) {
    info(`No open unit${scope ? ` matches ${scope}` : ''}.`);
    return;
  }

  if (ranked.length > 0) {
    info(`Ranked${scope ? ` (${scope})` : ''}:`);
    for (const e of ranked) info(`  ${e.position}. ${describe(e.unit)}`);
  }
  if (unranked.length > 0) {
    const more = unranked.length > TAIL_SHOWN ? ` (first ${TAIL_SHOWN} of ${unranked.length})` : '';
    info(`Not yet ranked, oldest first${scope ? ` (${scope})` : ''}${more}:`);
    for (const e of unranked.slice(0, TAIL_SHOWN)) info(`  ${describe(e.unit)}`);
  }

  for (const { entry, why } of waits) info(`Passed over ${placeOf(entry)}: ${why.join('; ')}.`);
  if (!pick) {
    info(`No unit${scope ? ` matching ${scope}` : ''} can run: each is held by a task or by work bl cannot run.`);
    return;
  }
  if (pick.unit !== pick.from.unit) {
    info(
      `${placeOf(pick.from)} is held: ${pick.path.join(', then ')}. ` +
        `${pick.unit.id} comes first; it unblocks ${pick.from.id}.`,
    );
  }
  info(`Next: ${describe(pick.unit)}`);
  process.stdout.write(`${pick.unit.id}\n`);
}
