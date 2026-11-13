/**
 * blockers.js — the backlog's `blockers.json` (F-66 D2): every edge that
 * keeps a unit out of a status (its gate, F-119 D4) until another unit's
 * status meets a status.
 *
 *   {
 *     "schema": "bl-blockers/v2",
 *     "edges": [
 *       {"blocker":"F-96:ci-cd","gate":"merge","unit":"F-96:bl","until":"merged"},
 *       {"blocker":"T-22","gate":"done","unit":"F-1","until":"done"},
 *       {"blocker":"T-30","gate":"in_progress","unit":"*","until":"done","active_when":{"unit":"F-54","status":"done"}}
 *     ]
 *   }
 *
 * An edge's identity is (`blocker`, `gate`, `unit`): no id, no duplicates.
 * A hold's gate is a status of its unit's type. The reader takes the gate
 * names from before F-119 as the statuses they stand for (`holdGate`:
 * `run` is `in_progress`, `merge` is `done`), so the next write stores
 * statuses. `unit: "*"` holds every unit of every type that has the status;
 * `blocker` is never `*`. `active_when` keeps the edge from holding anything until
 * that unit's status meets that status. Statuses meet through `flow.json`
 * (`Flow.meets`). Met edges stay as history; nothing prunes them.
 *
 * A merge edge (F-111 D1) joins two repos of one feature, each end
 * `<feature>:<repo>`: `bl merge` merges the blocker's repo before the
 * unit's (`mergeOrder` in `execution-plan.js`). An order edge joins two stories of
 * one feature (`{"blocker":"S-1446","gate":"order","unit":"S-1448",
 * "until":"implemented"}`): the implement loop takes the blocker first
 * (`orderStoriesByDeps`). A story batch (F-125 D1) has both as a feature
 * does: "feature" here reads "the work unit of a story" (`storyUnitOf`).
 * Both are edges inside one feature (`inFeature`):
 * no verb checks them as a gate, so neither is a hold or adds an arc to
 * `holdGraph`; a cycle of one feature's merge edges, or of its order edges,
 * is `blockers-cycle`. bl reads `bl-blockers/v1` (which has neither) and
 * `v2`, and writes `v2`.
 *
 * Until the migration moves them here (F-111 D5, R4), each `depends_on:`
 * entry in a story file is read as the edge it stands for
 * (`dependsOnEdges`). `readEdges` gives every reader the file's edges and
 * those, through one call.
 *
 * The file is written only by bl (`writeBlockers`, through
 * `atomicWriteFile`), sorted by `unit`, then `blocker`, then `gate` in code
 * point order, one edge per line. Git merges it by edge, not by line
 * (`mergeEdges`, through `blockers-merge.js`). A missing file is an empty
 * graph. `findBlockersFindings` is `bl validate`'s D5 checks;
 * `holdGraph` and `wouldCycle` are the deadlock graph `bl block add` and
 * `blockers-cycle` share. `heldBy` is the hold check a verb makes on the
 * statuses of its nominal path (`Flow.nominalPath`, F-119 D6): today
 * `bl run`, `bl implement` and `bl merge` make it. `heldLines` is what
 * `bl status` prints.
 */

import { lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { loadFlow } from './flow.js';
import { normalizeId } from './config.js';
import { parseIdList, readAllStories } from './story.js';
import { normalizeFeatureId, readAllFeatures } from './feature.js';
import { normalizeBatchId, readAllBatches } from './batch.js';
import { featureRepoOrder } from './execution-plan.js';
import { readAllTasks } from './task.js';
import { graphOf } from './backlog-graph.js';

/** The file's name, at the backlog root. */
export const BLOCKERS_FILE = 'blockers.json';

/** The schema bl writes. */
export const BLOCKERS_SCHEMA = 'bl-blockers/v2';

/** Every schema bl reads: `v1` is `v2` without merge and order edges (F-111 D1). */
export const BLOCKERS_SCHEMAS = ['bl-blockers/v1', BLOCKERS_SCHEMA];

/** A merge edge's gate and `until` (F-111 D1): neither is in `flow.json`. */
export const MERGE_EDGE = { gate: 'merge', until: 'merged' };

/** An order edge's gate and `until` (F-111 D1): neither is in `flow.json`. */
export const ORDER_EDGE = { gate: 'order', until: 'implemented' };

/**
 * A hold's gate names before F-119, and the status each stands for (R3):
 * `run` the status `run` and `implement` enter, `merge` the one `merge`
 * enters. A merge edge keeps its gate `merge` (`holdGate`).
 */
export const OLD_GATES = Object.freeze({ run: 'in_progress', merge: 'done' });

/**
 * The edge a dependency outside one feature stands for (F-111 D4): it keeps
 * the story out of `in_progress` (what `run` enters) until the dependency is
 * `done`.
 */
export const RUN_EDGE = { gate: OLD_GATES.run, until: 'done' };

/** The status gate name `gate` stands for: an old name (`OLD_GATES`) mapped, any other unchanged. */
export function gateStatus(gate) {
  return Object.hasOwn(OLD_GATES, gate) ? OLD_GATES[gate] : gate;
}

/** Whether an edge names a `<feature>:<repo>` end: a merge edge (F-111 D1). */
function isRepoEdge(e) {
  return repoEnd(e.blocker) != null || repoEnd(e.unit) != null;
}

/**
 * The edge with a hold's gate read as a status (`gateStatus`, F-119 R3). A
 * merge edge and an order edge keep their gate. `blockers.json`'s reader and
 * `bl block add` and `remove` read every gate through it, so bl compares and
 * writes statuses only.
 * @param {Edge} e
 * @returns {Edge}
 */
export function holdGate(e) {
  return isRepoEdge(e) ? e : { ...e, gate: gateStatus(e.gate) };
}

/** The `unit` that holds every unit of every type with the gate (F-66 A3). */
export const WILDCARD = '*';

/** An edge's keys, in the order bl writes them. */
const EDGE_KEYS = ['blocker', 'gate', 'unit', 'until', 'active_when'];
const REQUIRED_KEYS = ['blocker', 'gate', 'unit', 'until'];

/** A `blockers.json` bl cannot read: the message names the file and the fault. */
export class BlockersError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'BlockersError';
    this.path = path;
    this.reason = reason;
  }
}

export function blockersPath(backlogRoot) {
  return join(backlogRoot, BLOCKERS_FILE);
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v.trim() !== '' && v === v.trim();

/**
 * Parse a `blockers.json` text into its edges. Throws `BlockersError` when it
 * is not JSON, has a `schema` that is not one of `BLOCKERS_SCHEMAS`, or an
 * edge of the wrong shape (a missing or empty field, an unknown key, an
 * `active_when` that is not `{ unit, status }`).
 * @param {string} text
 * @param {string} [path]  for messages
 * @returns {Edge[]}
 */
export function parseBlockers(text, path = BLOCKERS_FILE) {
  return parseFile(text, path).edges;
}

/** `parseBlockers`, with the file's schema. */
function parseFile(text, path) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BlockersError(path, `not valid JSON (${err.message})`);
  }
  if (!isObject(raw)) throw new BlockersError(path, 'not a JSON object');
  if (!BLOCKERS_SCHEMAS.includes(raw.schema)) {
    const known = BLOCKERS_SCHEMAS.map((s) => `"${s}"`).join(' or ');
    throw new BlockersError(path, `"schema" is ${JSON.stringify(raw.schema)}, not ${known}`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'schema' && key !== 'edges') throw new BlockersError(path, `unknown key "${key}"`);
  }
  if (!Array.isArray(raw.edges)) throw new BlockersError(path, `"edges" is not a list`);
  raw.edges.forEach((e, i) => {
    const at = `edge ${i + 1}`;
    if (!isObject(e)) throw new BlockersError(path, `${at} is not an object`);
    for (const key of Object.keys(e)) {
      if (!EDGE_KEYS.includes(key)) throw new BlockersError(path, `${at} has unknown key "${key}"`);
    }
    for (const key of REQUIRED_KEYS) {
      if (!isName(e[key])) throw new BlockersError(path, `${at} has no "${key}" string`);
    }
    if (e.active_when !== undefined) {
      const a = e.active_when;
      const keys = isObject(a) ? Object.keys(a).sort().join(',') : '';
      if (keys !== 'status,unit' || !isName(a.unit) || !isName(a.status)) {
        throw new BlockersError(path, `${at} "active_when" is not { "unit", "status" }`);
      }
    }
  });
  const edges = raw.edges.map((e) => normalizeEdge(holdGate(e)));
  const renamed = raw.edges.some((e, i) => e.gate !== edges[i].gate);
  return { schema: raw.schema, edges, renamed };
}

/** The edge with its keys in bl's order. */
function normalizeEdge(e) {
  return {
    blocker: e.blocker,
    gate: e.gate,
    unit: e.unit,
    until: e.until,
    ...(e.active_when ? { active_when: { unit: e.active_when.unit, status: e.active_when.status } } : {}),
  };
}

/**
 * Read `<backlogRoot>/blockers.json`. A missing file is an empty graph
 * (`text` null); one that is there but cannot be read (a directory, a
 * dangling symlink, no permission) or parsed throws `BlockersError`, so a
 * gate never takes it for an empty graph. `schema` is the file's (null when
 * it is missing). `renamed` is true when an edge's gate in the text is a
 * name from before F-119, which `edges` gives as its status (`holdGate`).
 * @param {string} backlogRoot
 * @returns {{ edges: Edge[], text: string | null, path: string, schema: string | null, renamed: boolean }}
 */
export function readBlockers(backlogRoot) {
  const path = blockersPath(backlogRoot);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && !lstatSync(path, { throwIfNoEntry: false })) {
      return { edges: [], text: null, path, schema: null, renamed: false };
    }
    throw new BlockersError(path, `cannot be read (${err.code ?? err.message})`);
  }
  return { ...parseFile(text, path), text, path };
}

// Code point order, so the layout is the same under every locale.
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** By `unit`, then `blocker`, then `gate`. */
export function compareEdges(a, b) {
  return cmp(a.unit, b.unit) || cmp(a.blocker, b.blocker) || cmp(a.gate, b.gate);
}

/**
 * The file's text as bl writes it: sorted, one edge per line. Reading it
 * back and formatting again gives the same bytes. `schema` is the one bl
 * writes; `bl validate` passes a `v1` file's own, so the old schema alone is
 * not a layout fault.
 * @param {Edge[]} edges
 * @param {string} [schema]
 * @returns {string}
 */
export function formatBlockers(edges, schema = BLOCKERS_SCHEMA) {
  const lines = [...edges].sort(compareEdges).map((e) => `    ${JSON.stringify(normalizeEdge(e))}`);
  const list = lines.length === 0 ? '[]' : `[\n${lines.join(',\n')}\n  ]`;
  return `{\n  "schema": "${schema}",\n  "edges": ${list}\n}\n`;
}

/** Write `edges` to `<backlogRoot>/blockers.json`, sorted, atomically. */
export function writeBlockers(backlogRoot, edges) {
  atomicWriteFile(backlogRoot, blockersPath(backlogRoot), formatBlockers(edges));
}

/**
 * The three-way merge of two edge lists that share `base`, by identity, as
 * git's merge driver for `blockers.json` makes it (`blockers-merge.js`): an
 * edge either side added is kept, one either side removed is dropped, and a
 * side that changed an edge wins over one that left it. Null when both sides
 * added or changed one edge differently, one changed an edge the other
 * removed, or a side lists one identity more than once (which to keep is the
 * operator's, and `bl validate` reports it): a conflict for the operator. A
 * merge can still close a deadlock neither side had; `bl validate` reports
 * it (`blockers-cycle`).
 * @param {Edge[]} base
 * @param {Edge[]} ours
 * @param {Edge[]} theirs
 * @returns {Edge[] | null}
 */
export function mergeEdges(base, ours, theirs) {
  const byKey = (edges) => new Map(edges.map((e) => [edgeKey(e), e]));
  const [b, o, t] = [byKey(base), byKey(ours), byKey(theirs)];
  if (b.size !== base.length || o.size !== ours.length || t.size !== theirs.length) return null;
  const same = (x, y) => JSON.stringify(normalizeEdge(x)) === JSON.stringify(normalizeEdge(y));
  const out = [];
  for (const key of new Set([...o.keys(), ...t.keys()])) {
    const [be, oe, te] = [b.get(key), o.get(key), t.get(key)];
    if (oe && te) {
      if (same(oe, te) || (be && same(be, te))) out.push(oe);
      else if (be && same(be, oe)) out.push(te);
      else return null;
    } else if (!be) {
      out.push(oe ?? te);
    } else if (!same(be, oe ?? te)) {
      return null;
    }
  }
  return out;
}

/** An edge's identity: (`blocker`, `gate`, `unit`). */
export function edgeKey(e) {
  return JSON.stringify([e.blocker, e.gate, e.unit]);
}

/** `F-1 at merge by T-22`, the words an edge is named by in messages. */
export function edgeLabel(e) {
  return `${e.unit} at ${e.gate} by ${e.blocker}`;
}

// ---------------------------------------------------------------------------
// Merge and order edges (F-111 D1)
// ---------------------------------------------------------------------------

/**
 * A merge edge's end, `<feature>:<repo>` (`F-96:bl` → `{ unit: "F-96", repo:
 * "bl" }`); null for a unit id or `*`.
 * @param {string} id
 * @returns {{ unit: string, repo: string } | null}
 */
export function repoEnd(id) {
  const at = id.indexOf(':');
  return at > 0 && at < id.length - 1 ? { unit: id.slice(0, at), repo: id.slice(at + 1) } : null;
}

/** `F-96:ci-cd → F-96:bl`: a merge or order edge as `bl merge` and `bl block list` name it. */
export function edgeArrow(e) {
  return `${e.blocker} → ${e.unit}`;
}

/** The unit types whose stories run and merge as one: a feature and a story batch (F-125 D1). */
const WORK_UNIT_TYPES = ['feature', 'batch'];

/**
 * The work unit of story `storyId` (F-125 D1): the id of its feature or its
 * story batch (`unitIndex`), `''` when it is a loose story or not a story.
 * Every edge check that asks which unit a story runs and merges with asks
 * this.
 * @param {Map<string, Unit>} units
 * @param {string} storyId
 * @returns {string}
 */
export function storyUnitOf(units, storyId) {
  const s = units.get(storyId);
  return s?.type === 'story' ? s.feature || s.batch || '' : '';
}

/**
 * Whether an edge joins two parts of one work unit (a feature or a story
 * batch): two repo ends of one unit (a merge edge), or two stories of one
 * unit at gate `order` (an order edge). The unit's own loops read such an
 * edge; no verb checks it as a gate.
 * @param {Edge} e
 * @param {Map<string, Unit>} units
 */
export function inFeature(e, units) {
  if (e.gate === ORDER_EDGE.gate) {
    const own = storyUnitOf(units, e.blocker);
    return own !== '' && own === storyUnitOf(units, e.unit);
  }
  const [b, u] = [repoEnd(e.blocker), repoEnd(e.unit)];
  return b != null && u != null && b.unit === u.unit && WORK_UNIT_TYPES.includes(units.get(b.unit)?.type);
}

/** The merge edges of feature `id`: both ends `<id>:<repo>`. */
export function featureMergeEdges(edges, id) {
  return edges.filter((e) => repoEnd(e.blocker)?.unit === id && repoEnd(e.unit)?.unit === id);
}

/**
 * The graph of edges inside features (merge and order edges, `inFeature`)
 * for `findHoldCycles`: an arc from each edge's unit end to its blocker end
 * (the unit's repo merges, or its story is implemented, after the
 * blocker's), with the edge. A merge edge's ends are repos and an order
 * edge's stories, so a cycle never mixes the two.
 * @param {Edge[]} edges
 * @returns {Map<string, Arc[]>}
 */
export function featureGraph(edges) {
  const graph = new Map();
  for (const e of edges) {
    // A merge edge with a wrong gate (`blockers-gate`) is still a merge edge here.
    const kind = e.gate === ORDER_EDGE.gate ? 'order' : 'merge';
    if (!graph.has(e.unit)) graph.set(e.unit, []);
    graph.get(e.unit).push({ from: e.unit, to: e.blocker, why: `${kind} edge ${edgeArrow(e)}`, kind, edge: e });
  }
  return graph;
}

/** The repos of work unit `id` (`featureRepoOrder` of its stories, F-52 D3). */
function featureRepos(units, id) {
  return featureRepoOrder([...units.values()].filter((u) => storyUnitOf(units, u.id) === id));
}

/**
 * What is wrong with a merge edge (one that names a `<feature>:<repo>` end),
 * by F-111 D1: an end that is `*`, not `<feature>:<repo>`, not a feature or
 * a batch, or a repo no story of the unit names, or ends in two units
 * (`blockers-unit`); a gate other than `merge` (`blockers-gate`); an `until`
 * other than `merged` (`blockers-status`).
 */
function mergeEdgeProblems(e, units, add) {
  const ends = [];
  for (const [role, id] of [
    ['blocker', e.blocker],
    ['unit', e.unit],
  ]) {
    const end = repoEnd(id);
    let problem = null;
    if (id === WILDCARD) problem = `a merge edge's ${role} is never "${WILDCARD}"`;
    else if (!end) problem = `a merge edge's ${role} is <feature>:<repo>, not ${id}`;
    else if (!WORK_UNIT_TYPES.includes(units.get(end.unit)?.type))
      problem = `${role} ${id}: ${end.unit} is not a feature or batch in the backlog`;
    else if (!featureRepos(units, end.unit).includes(end.repo)) {
      problem = `${role} ${id}: no story of ${end.unit} names repo ${end.repo}`;
    }
    if (problem) add('blockers-unit', problem);
    else ends.push(end);
  }
  if (ends.length === 2 && ends[0].unit !== ends[1].unit) {
    add('blockers-unit', `a merge edge joins two repos of one feature, not of ${ends[0].unit} and ${ends[1].unit}`);
  }
  if (e.gate !== MERGE_EDGE.gate) {
    add('blockers-gate', `a merge edge's gate is "${MERGE_EDGE.gate}", not "${e.gate}"`);
  }
  if (e.until !== MERGE_EDGE.until) {
    add('blockers-status', `a merge edge's until is "${MERGE_EDGE.until}", not "${e.until}"`);
  }
}

/**
 * What is wrong with an order edge (one at gate `order`), by F-111 D1: an
 * end that is `*`, not a story, or a story in no feature or batch, or ends
 * in two work units (`blockers-unit`); an `until` other than `implemented`
 * (`blockers-status`).
 */
function orderEdgeProblems(e, units, add) {
  const owners = [];
  for (const [role, id] of [
    ['blocker', e.blocker],
    ['unit', e.unit],
  ]) {
    const own = storyUnitOf(units, id);
    let problem = null;
    if (id === WILDCARD) problem = `an order edge's ${role} is never "${WILDCARD}"`;
    else if (units.get(id)?.type !== 'story') problem = `${role} ${id} is not a story in the backlog`;
    else if (!own) problem = `${role} ${id} is in no feature or batch`;
    if (problem) add('blockers-unit', problem);
    else owners.push(own);
  }
  if (owners.length === 2 && owners[0] !== owners[1]) {
    add(
      'blockers-unit',
      `an order edge joins two stories of one feature or batch, not of ${owners[0]} and ${owners[1]}`,
    );
  }
  if (e.until !== ORDER_EDGE.until) {
    add('blockers-status', `an order edge's until is "${ORDER_EDGE.until}", not "${e.until}"`);
  }
}

// ---------------------------------------------------------------------------
// Units and statuses
// ---------------------------------------------------------------------------

/**
 * Every unit an edge can name, by id. A story's `feature` is the feature
 * it runs and merges with: its `feature:` when that names a feature (the
 * only statement of membership, F-77 D3); its `batch` the same for its
 * `batch:` and a story batch (F-125 D1), and `unitRepo` its one repo.
 * `storyUnitOf` reads the two as the story's work unit. A task (F-65 D1) is
 * a unit too, so it can be a blocker or an `active_when` unit, and a hold
 * can keep it out of one of its statuses.
 * @param {Array<{ id: string, status: string, feature?: string, batch?: string, unitRepo?: string }>} stories
 * @param {Array<{ id: string, status: string, stories: string[] }>} features
 * @param {Array<{ id: string, status: string }>} [tasks]
 * @param {Array<{ id: string, status: string, stories: string[] }>} [batches]
 * @returns {Map<string, Unit>}
 */
export function unitIndex(stories, features, tasks = [], batches = []) {
  const units = new Map();
  for (const f of features) {
    units.set(f.id, { id: f.id, type: 'feature', status: f.status, stories: [...f.stories] });
  }
  for (const b of batches) {
    units.set(b.id, { id: b.id, type: 'batch', status: b.status, stories: [...b.stories] });
  }
  // The id `raw` names, when it is a unit of `type`.
  const own = (raw, normalize, type) => {
    const named = String(raw ?? '').trim();
    const id = normalize(named)?.id ?? named;
    return units.get(id)?.type === type ? id : '';
  };
  for (const s of stories) {
    units.set(s.id, {
      id: s.id,
      type: 'story',
      status: s.status,
      feature: own(s.feature, normalizeFeatureId, 'feature'),
      batch: own(s.batch, normalizeBatchId, 'batch'),
      unitRepo: s.unitRepo ?? '',
    });
  }
  for (const t of tasks) if (t.id) units.set(t.id, { id: t.id, type: 'task', status: t.status });
  return units;
}

/** `unitIndex` over the backlog's stories, features, tasks and story batches. */
export function readUnits(config) {
  return unitIndex(readAllStories(config), readAllFeatures(config), readAllTasks(config), readAllBatches(config));
}

// ---------------------------------------------------------------------------
// depends_on as edges (F-111 D4, D5)
// ---------------------------------------------------------------------------

/**
 * The edges the `depends_on:` keys still in story files stand for (F-111
 * D4), the read adapter of R4: for `S-a depends_on S-b`, the order edge
 * `S-b → S-a` when both are in one work unit (a feature or a batch), else
 * the run edge that holds `S-a` until `S-b` is `done`. An entry that names
 * no story still gives a run edge, so it holds, as it did. Each entry once,
 * in the key's order.
 * @param {Array<{ id: string, depends_on?: unknown, unit: string }>} stories
 *   `unit` is the id of the story's work unit (`''` for none)
 * @returns {Edge[]}
 */
export function dependsOnEdges(stories) {
  const unitOf = new Map(stories.map((s) => [s.id, s.unit]));
  const out = [];
  for (const s of stories) {
    for (const dep of new Set(parseIdList(s.depends_on))) {
      out.push(dependencyEdge(dep, s.id, (id) => unitOf.get(id) ?? ''));
    }
  }
  return out;
}

/**
 * The edge for "story `unit` waits for story `blocker`" (F-111 D4): the order
 * edge when both are in one work unit (a feature or a batch, F-125 D1),
 * else the run edge that holds `unit` until `blocker` is `done`. `bl new`
 * writes it, the migration moves each `depends_on:` entry to it, and
 * `dependsOnEdges` reads an entry as it.
 * @param {string} blocker
 * @param {string} unit
 * @param {(id: string) => string} unitOf  a story's work unit id (`storyUnitOf`), `''` for none
 * @returns {Edge}
 */
export function dependencyEdge(blocker, unit, unitOf) {
  const own = unitOf(unit);
  const { gate, until } = own !== '' && unitOf(blocker) === own ? ORDER_EDGE : RUN_EDGE;
  return { blocker, gate, unit, until };
}

/** `edges` (the file's) and the `extra` edges (`dependsOnEdges`) whose identity is not in the file: the file's edge wins. */
export function withDependsOn(edges, extra) {
  const keys = new Set(edges.map(edgeKey));
  return [...edges, ...extra.filter((e) => !keys.has(edgeKey(e)))];
}

/**
 * Every edge bl reads: `blockers.json`'s, and those its stories'
 * `depends_on:` keys stand for (`withDependsOn`), as the backlog graph holds
 * them (`edges`). An unreadable `blockers.json` throws `BlockersError`, so a
 * gate never takes it for an empty graph.
 * @param {{ backlogRoot: string }} config
 * @returns {Edge[]}
 */
export function readEdges(config) {
  return graphOf(config).edges;
}

/**
 * Each story's dependencies, from the run and order edges between two
 * stories (F-111 D4): story id → the ids of the stories it waits for, in
 * edge order, each once. A blocker that is a story id is kept whether or not
 * the story exists, so a reader can name a missing one.
 * @param {Edge[]} edges
 * @returns {Map<string, string[]>}
 */
export function storyDependencies(edges) {
  const isStory = (id) => normalizeId(id)?.id === id;
  const out = new Map();
  for (const e of edges) {
    if ((e.gate !== RUN_EDGE.gate && e.gate !== ORDER_EDGE.gate) || !isStory(e.unit) || !isStory(e.blocker)) continue;
    const deps = out.get(e.unit) ?? [];
    if (!deps.includes(e.blocker)) deps.push(e.blocker);
    out.set(e.unit, deps);
  }
  return out;
}

/** Whether unit `id` exists and its status meets `wanted`. */
export function statusMeets(units, flow, id, wanted) {
  const u = units.get(id);
  return u != null && flow.meets(u.type, u.status, wanted);
}

/** Whether a unit is closed: its status meets `done` (so `superseded` is too). */
export function isClosed(unit, flow) {
  return flow.meets(unit.type, unit.status, 'done');
}

/** An edge holds only once its `active_when` unit meets that status. */
export function isActive(edge, units, flow) {
  return !edge.active_when || statusMeets(units, flow, edge.active_when.unit, edge.active_when.status);
}

/** An edge is met once its blocker's status meets `until`. */
export function isMet(edge, units, flow) {
  return statusMeets(units, flow, edge.blocker, edge.until);
}

/**
 * The active edges at `gate` on any of `unitIds`, or on `*`, whose blocker
 * does not meet `until` (F-66 D3).
 * @param {Edge[]} edges
 * @param {string[]} unitIds
 * @param {string} gate
 * @returns {Edge[]}
 */
export function unmetEdges(edges, unitIds, gate, units, flow) {
  return edges.filter(
    (e) =>
      e.gate === gate &&
      (e.unit === WILDCARD || unitIds.includes(e.unit)) &&
      isActive(e, units, flow) &&
      !isMet(e, units, flow),
  );
}

// ---------------------------------------------------------------------------
// Gate checks (F-66 D3)
// ---------------------------------------------------------------------------

/**
 * The ids a unit's gate checks: itself, and for a feature or a story batch
 * every story that runs and merges with it (D2, `storyUnitOf`), so an edge
 * on one of its stories holds it.
 * @param {Map<string, Unit>} units
 * @param {string} id
 * @returns {string[]}
 */
export function gateIds(units, id) {
  const ids = [id];
  if (!WORK_UNIT_TYPES.includes(units.get(id)?.type)) return ids;
  for (const u of units.values()) if (storyUnitOf(units, u.id) === id) ids.push(u.id);
  return ids;
}

/**
 * `F-1 is held at done by S-9 (in_progress, needs done)`: one unmet edge as
 * the gate and `bl status` name it. A wildcard edge is named on `id`.
 */
export function heldLine(edge, id, units) {
  const on = edge.unit === WILDCARD ? id : edge.unit;
  const status = units.get(edge.blocker)?.status ?? 'unknown';
  return `${on} is held at ${edge.gate} by ${edge.blocker} (${status}, needs ${edge.until})`;
}

/**
 * The active, unmet edges that hold unit `id`, in the file's order: each on
 * one of `gateIds(units, id)` or on `*`, at a status that `gatesFor(type)`
 * names for that member's own type. So a feature's check honours each of
 * its stories' holds with the story type's row of the verb, not the
 * feature's. An edge inside one feature (`inFeature`) never holds.
 * @param {(type: string) => string[]} gatesFor
 * @returns {Edge[]}
 */
function holding(edges, units, flow, id, gatesFor) {
  const members = gateIds(units, id).map((m) => ({ id: m, gates: gatesFor(units.get(m).type) }));
  return edges.filter(
    (e) =>
      !inFeature(e, units) &&
      members.some((m) => m.gates.includes(e.gate) && (e.unit === WILDCARD || e.unit === m.id)) &&
      isActive(e, units, flow) &&
      !isMet(e, units, flow),
  );
}

/**
 * The hold check (F-119 D6): the unmet edges that hold unit `id` at a status
 * on its type's nominal path of `verb` (`Flow.nominalPath`) and, for a
 * feature, at a status on its stories' type's nominal path of `verb`
 * (`holding`), each with its line. The edges are `readEdges`'s, so a
 * `depends_on:` outside a feature holds too. No edge at all holds nothing
 * and reads neither `flow.json` nor the units; otherwise a missing
 * `flow.json` throws `FlowError` and an unreadable `blockers.json`
 * `BlockersError`.
 * @param {{ backlogRoot: string }} config
 * @param {string} id
 * @param {string} verb  a verb of the unit's type, such as `run` or `merge`
 * @param {{ units?: Map<string, Unit> }} [opts]  the units, when the caller has them
 * @returns {Array<{ edge: Edge, line: string }>}
 */
export function heldBy(config, id, verb, { units = null } = {}) {
  return heldWhere(config, id, units, (flow, type) => flow.nominalPath(type, verb));
}

/**
 * `heldBy` for one status rather than a verb's nominal path: the unmet edges
 * that keep unit `id` (and a feature's stories) out of `status`. The
 * `gate_free` guard (`guards.js`, F-69 D1) reads it.
 * @param {{ backlogRoot: string }} config
 * @param {string} id
 * @param {string} status
 * @returns {Array<{ edge: Edge, line: string }>}
 */
export function heldAt(config, id, status) {
  return heldWhere(config, id, null, (flow, type) => (flow.statusesOf(type).includes(status) ? [status] : []));
}

/** `heldBy` and `heldAt`: the holds at the statuses `gatesFor(flow, type)` names per member type. */
function heldWhere(config, id, units, gatesFor) {
  const edges = readEdges(config);
  if (edges.length === 0) return [];
  const flow = loadFlow(config.backlogRoot);
  const all = units ?? readUnits(config);
  const unit = all.get(id);
  if (!unit) return [];
  return holding(edges, all, flow, id, (type) => gatesFor(flow, type)).map((edge) => ({
    edge,
    line: heldLine(edge, id, all),
  }));
}

/**
 * `bl status`'s `held:` lines: every unmet, active edge on unit `id` (and a
 * feature's stories) at any status of the member's type, in the file's
 * order.
 * @param {{ backlogRoot: string }} config
 * @param {string} id
 * @returns {string[]}
 */
export function heldLines(config, id) {
  const edges = readEdges(config);
  if (edges.length === 0) return [];
  const flow = loadFlow(config.backlogRoot);
  const units = readUnits(config);
  const unit = units.get(id);
  if (!unit) return [];
  return holding(edges, units, flow, id, (type) => flow.statusesOf(type)).map((e) => heldLine(e, id, units));
}

/**
 * What is wrong with one edge against the flow and the backlog: unknown
 * ids (`blockers-unit`), a gate that is not a status of the unit's type
 * (`blockers-gate`), an `until` or `active_when` status its unit's type
 * lacks (`blockers-status`), a blocker that is closed
 * and does not meet `until`, so would hold forever (`blockers-unmeetable`).
 * An edge that names a `<feature>:<repo>` end is a merge edge, and one at
 * gate `order` an order edge; each is checked by its own rules
 * (`mergeEdgeProblems`, `orderEdgeProblems`), and takes no `active_when`
 * (`blockers-gate`), since it holds nothing. `bl block add` refuses an edge
 * with any; `bl validate` reports each.
 * @returns {Array<{ code: string, message: string }>}
 */
export function edgeProblems(e, units, flow) {
  const out = [];
  const add = (code, message) => out.push({ code, message });
  const kind = isRepoEdge(e) ? 'a merge' : e.gate === ORDER_EDGE.gate ? 'an order' : null;
  if (kind) {
    (kind === 'a merge' ? mergeEdgeProblems : orderEdgeProblems)(e, units, add);
    // It holds nothing, so nothing can keep it from holding.
    if (e.active_when) add('blockers-gate', `${kind} edge holds nothing, so it takes no active_when`);
    return out;
  }
  const known = (id) => units.get(id) ?? null;
  const blocker = e.blocker === WILDCARD ? null : known(e.blocker);
  if (e.blocker === WILDCARD) add('blockers-unit', `the blocker is never "${WILDCARD}"`);
  else if (!blocker) add('blockers-unit', `blocker ${e.blocker} is not a unit in the backlog`);
  const unit = e.unit === WILDCARD ? null : known(e.unit);
  if (e.unit !== WILDCARD && !unit) add('blockers-unit', `unit ${e.unit} is not a unit in the backlog`);
  const after = e.active_when ? known(e.active_when.unit) : null;
  if (e.active_when && !after) {
    add('blockers-unit', `active_when unit ${e.active_when.unit} is not a unit in the backlog`);
  }

  // A hold's gate is the status it keeps its unit out of (F-119 D4).
  if (e.unit === WILDCARD) {
    const types = Object.keys(flow.types).filter((t) => flow.statusesOf(t).includes(e.gate));
    if (types.length === 0) add('blockers-gate', `gate "${e.gate}" is no type's status in flow.json`);
  } else if (unit && !flow.statusesOf(unit.type).includes(e.gate)) {
    add('blockers-gate', `gate "${e.gate}" is not a ${unit.type} status in flow.json`);
  }
  if (blocker && !flow.statusesOf(blocker.type).includes(e.until)) {
    add('blockers-status', `until "${e.until}" is not a ${blocker.type} status in flow.json`);
  }
  if (after && !flow.statusesOf(after.type).includes(e.active_when.status)) {
    add('blockers-status', `active_when status "${e.active_when.status}" is not a ${after.type} status in flow.json`);
  }
  if (blocker && isClosed(blocker, flow) && !flow.meets(blocker.type, blocker.status, e.until)) {
    add('blockers-unmeetable', `${e.blocker} is ${blocker.status}, closed, and never meets "${e.until}"`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The deadlock graph (F-66 D5)
// ---------------------------------------------------------------------------

/**
 * The node a unit stands as: a story of a feature or a batch is that work
 * unit, since it runs and merges as one; anything else is itself.
 */
function nodeOf(units, id) {
  return storyUnitOf(units, id) || id;
}

/**
 * The arcs one edge adds (`from` waits on `to`), as if it were active and
 * unmet. A wildcard is expanded to every open unit whose type has the gate's
 * status, so a blocker that has it itself holds its own node. An edge inside
 * one feature (`inFeature`) adds none: both its ends are one node.
 * @returns {Arc[]}
 */
function edgeArcs(e, units, flow) {
  if (!units.has(e.blocker) || inFeature(e, units)) return [];
  const to = nodeOf(units, e.blocker);
  const why = edgeLabel(e);
  if (e.unit !== WILDCARD) {
    return units.has(e.unit) ? [{ from: nodeOf(units, e.unit), to, why, kind: 'edge', edge: e }] : [];
  }
  const froms = new Set();
  for (const u of units.values()) {
    if (isClosed(u, flow) || !flow.statusesOf(u.type).includes(e.gate)) continue;
    froms.add(nodeOf(units, u.id));
  }
  return [...froms].map((from) => ({ from, to, why, kind: 'edge' }));
}

/**
 * D5's graph: nodes are features (standing for their stories) and
 * standalone stories; an arc `from → to` says `from` cannot pass a gate
 * until `to` moves on. Arcs come from every active, unmet edge (a wildcard
 * expanded); pass `readEdges`'s, so a `depends_on:` outside a feature adds
 * its run edge's arc.
 * @param {Edge[]} edges
 * @returns {Map<string, Arc[]>}
 */
export function holdGraph(edges, units, flow) {
  const graph = new Map();
  for (const e of edges) {
    if (!isActive(e, units, flow) || isMet(e, units, flow)) continue;
    for (const arc of edgeArcs(e, units, flow)) {
      if (!graph.has(arc.from)) graph.set(arc.from, []);
      graph.get(arc.from).push(arc);
    }
  }
  return graph;
}

/** The shortest arc path from `src` to `dst`, within `allowed` when given; null when none. */
function shortestPath(graph, src, dst, allowed = null) {
  if (src === dst) return [];
  const via = new Map([[src, null]]);
  const queue = [src];
  while (queue.length > 0) {
    const n = queue.shift();
    for (const arc of graph.get(n) ?? []) {
      if (via.has(arc.to) || (allowed && !allowed.has(arc.to))) continue;
      via.set(arc.to, arc);
      if (arc.to === dst) {
        const path = [];
        for (let a = arc; a; a = via.get(a.from)) path.unshift(a);
        return path;
      }
      queue.push(arc.to);
    }
  }
  return null;
}

/** The strongly connected components of `graph` (Tarjan), each a set of nodes. */
function components(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  let next = 0;
  const visit = (n) => {
    index.set(n, next);
    low.set(n, next);
    next++;
    stack.push(n);
    onStack.add(n);
    for (const { to } of graph.get(n) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(n, Math.min(low.get(n), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(n, Math.min(low.get(n), index.get(to)));
      }
    }
    if (low.get(n) === index.get(n)) {
      const scc = new Set();
      let m;
      do {
        m = stack.pop();
        onStack.delete(m);
        scc.add(m);
      } while (m !== n);
      out.push(scc);
    }
  };
  for (const n of [...graph.keys()].sort()) if (!index.has(n)) visit(n);
  return out;
}

/**
 * One cycle per deadlocked group of nodes: each strongly connected component
 * of more than one node, or of one node with an arc to itself, as the
 * shortest cycle through its first node.
 * @param {Map<string, Arc[]>} graph
 * @returns {Arc[][]}
 */
export function findHoldCycles(graph) {
  const cycles = [];
  for (const scc of components(graph)) {
    const start = [...scc].sort()[0];
    let best = null;
    for (const arc of graph.get(start) ?? []) {
      if (!scc.has(arc.to)) continue;
      const back = shortestPath(graph, arc.to, start, scc);
      if (back && (!best || back.length + 1 < best.length)) best = [arc, ...back];
    }
    if (best) cycles.push(best);
  }
  return cycles.sort((a, b) => cmp(a[0].from, b[0].from));
}

/** `F-1 → F-2 (S-a at run by S-b) → F-1 (F-2 at run by S-d)`. */
export function describeCycle(arcs) {
  return [arcs[0].from, ...arcs.map((a) => `${a.to} (${a.why})`)].join(' → ');
}

/**
 * The cycle `edge` would close in the graph of `edges`, or null. Like the
 * graph's other edges, it adds arcs only while active and unmet, so an edge
 * filed to start holding later (`active_when`) is checked by `bl validate`
 * once it does. A merge or order edge is checked against the edges inside
 * features alone (`featureGraph`). Pass `readEdges`'s edges, so the
 * `depends_on:` keys count.
 * @returns {Arc[] | null}
 */
export function wouldCycle(edge, edges, units, flow) {
  if (inFeature(edge, units)) {
    const graph = featureGraph([...edges.filter((e) => inFeature(e, units)), edge]);
    const back = shortestPath(graph, edge.blocker, edge.unit);
    return back ? [graph.get(edge.unit).at(-1), ...back] : null;
  }
  if (!isActive(edge, units, flow) || isMet(edge, units, flow)) return null;
  const graph = holdGraph(edges, units, flow);
  const added = edgeArcs(edge, units, flow);
  for (const arc of added) {
    if (!graph.has(arc.from)) graph.set(arc.from, []);
    graph.get(arc.from).push(arc);
  }
  for (const arc of added) {
    const back = shortestPath(graph, arc.to, arc.from);
    if (back) return [arc, ...back];
  }
  return null;
}

// ---------------------------------------------------------------------------
// bl validate (F-66 D5)
// ---------------------------------------------------------------------------

/**
 * `bl validate`'s findings on `blockers.json`, all at that file:
 * `blockers-json` (unreadable; nothing else is checked), `blockers-unit`,
 * `blockers-gate`, `blockers-status`, `blockers-duplicate`,
 * `blockers-unmeetable` (a closed blocker that does not meet `until`),
 * `blockers-cycle` (a deadlock in `holdGraph`, or a cycle of one feature's
 * merge edges or of its order edges), all errors, and `blockers-order` (a
 * warning: the text is not what `formatBlockers` writes in the file's
 * schema). The cycles are found among `readEdges`'s edges, so a cycle of
 * `depends_on:` keys is one too; the other checks are the file's. A missing
 * file has no findings of its own.
 * @param {{ backlogRoot: string }} config
 * @param {Map<string, Unit>} units
 * @param {import("./flow.js").Flow} flow
 */
export function findBlockersFindings(config, units, flow) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message, location: BLOCKERS_FILE });
  let read;
  try {
    read = readBlockers(config.backlogRoot);
  } catch (err) {
    if (!(err instanceof BlockersError)) throw err;
    add('error', 'blockers-json', err.reason);
    return findings;
  }
  const { edges, text, schema, renamed } = read;
  if (text != null && text !== formatBlockers(edges, schema)) {
    const fault = renamed
      ? `names a gate from before F-119 (${Object.keys(OLD_GATES).join(', ')}), which bl reads as its status`
      : 'not sorted by unit, blocker and gate one edge per line as bl writes it';
    add('warning', 'blockers-order', `${fault}; bl block list --fix rewrites it`);
  }
  const seen = new Set();
  for (const e of edges) {
    const label = edgeLabel(e);
    if (seen.has(edgeKey(e))) add('error', 'blockers-duplicate', `${label} is listed more than once`);
    seen.add(edgeKey(e));
    for (const p of edgeProblems(e, units, flow)) add('error', p.code, `${label}: ${p.message}`);
  }
  const all = readEdges(config);
  for (const cycle of findHoldCycles(holdGraph(all, units, flow))) {
    // A run edge between two stories of one feature holds the feature on
    // itself: a story that joined it left the edge (F-111 D5). `bl attach`
    // refuses to turn one with `active_when`, so the hint is not given for it.
    const e = cycle.length === 1 ? cycle[0].edge : null;
    const joined = e?.gate === RUN_EDGE.gate && !e.active_when && inFeature({ ...e, gate: ORDER_EDGE.gate }, units);
    const fix = joined ? `; bl attach ${e.unit} ${cycle[0].from} turns it into an order edge` : '';
    add('error', 'blockers-cycle', `deadlock: ${describeCycle(cycle)}${fix}`);
  }
  for (const cycle of findHoldCycles(featureGraph(all.filter((e) => inFeature(e, units))))) {
    const what = cycle[0].kind === 'order' ? 'story' : 'merge';
    add('error', 'blockers-cycle', `${what} order cycle: ${describeCycle(cycle)}`);
  }
  return findings;
}

/**
 * @typedef {{ blocker: string, gate: string, unit: string, until: string,
 *   active_when?: { unit: string, status: string } }} Edge
 * @typedef {{ id: string, type: string, status: string, feature?: string, batch?: string,
 *   stories?: string[], unitRepo?: string }} Unit
 * @typedef {{ from: string, to: string, why: string, kind: "edge" | "merge" | "order",
 *   edge?: Edge }} Arc
 */
