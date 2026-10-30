/**
 * blockers.js — the backlog's `blockers.json` (F-66 D2): every edge that
 * holds a unit at a gate until another unit's status meets a status.
 *
 *   {
 *     "schema": "bl-blockers/v1",
 *     "edges": [
 *       {"blocker":"T-22","gate":"merge","unit":"F-1","until":"done"},
 *       {"blocker":"T-30","gate":"run","unit":"*","until":"done","active_when":{"unit":"F-54","status":"done"}}
 *     ]
 *   }
 *
 * An edge's identity is (`blocker`, `gate`, `unit`): no id, no duplicates.
 * `unit: "*"` holds every unit of every type that has the gate; `blocker`
 * is never `*`. `active_when` keeps the edge from holding anything until
 * that unit's status meets that status. Statuses meet through `flow.json`
 * (`Flow.meets`). Met edges stay as history; nothing prunes them.
 *
 * The file is written only by bl (`writeBlockers`, through
 * `atomicWriteFile`), sorted by `unit`, then `blocker`, then `gate` in code
 * point order, one edge per line. Git merges it by edge, not by line
 * (`mergeEdges`, through `blockers-merge.js`). A missing file is an empty
 * graph. `findBlockersFindings` is `bl validate`'s D5 checks;
 * `holdGraph` and `wouldCycle` are the deadlock graph `bl block add` and
 * `blockers-cycle` share. `heldBy` is the gate check `bl run`,
 * `bl implement` and `bl merge` make (D3), and `heldLines` what `bl status`
 * prints.
 */

import { lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { loadFlow } from './flow.js';
import { parseIdList, readAllStories } from './story.js';
import { readAllFeatures } from './feature.js';
import { readAllTasks } from './task.js';

/** The file's name, at the backlog root. */
export const BLOCKERS_FILE = 'blockers.json';

export const BLOCKERS_SCHEMA = 'bl-blockers/v1';

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
 * is not JSON, has a `schema` other than `bl-blockers/v1`, or an edge of the
 * wrong shape (a missing or empty field, an unknown key, an `active_when`
 * that is not `{ unit, status }`).
 * @param {string} text
 * @param {string} [path]  for messages
 * @returns {Edge[]}
 */
export function parseBlockers(text, path = BLOCKERS_FILE) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BlockersError(path, `not valid JSON (${err.message})`);
  }
  if (!isObject(raw)) throw new BlockersError(path, 'not a JSON object');
  if (raw.schema !== BLOCKERS_SCHEMA) {
    throw new BlockersError(path, `"schema" is ${JSON.stringify(raw.schema)}, not "${BLOCKERS_SCHEMA}"`);
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
  return raw.edges.map(normalizeEdge);
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
 * gate never takes it for an empty graph.
 * @param {string} backlogRoot
 * @returns {{ edges: Edge[], text: string | null, path: string }}
 */
export function readBlockers(backlogRoot) {
  const path = blockersPath(backlogRoot);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && !lstatSync(path, { throwIfNoEntry: false })) return { edges: [], text: null, path };
    throw new BlockersError(path, `cannot be read (${err.code ?? err.message})`);
  }
  return { edges: parseBlockers(text, path), text, path };
}

// Code point order, so the layout is the same under every locale.
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** By `unit`, then `blocker`, then `gate`. */
export function compareEdges(a, b) {
  return cmp(a.unit, b.unit) || cmp(a.blocker, b.blocker) || cmp(a.gate, b.gate);
}

/**
 * The file's text as bl writes it: sorted, one edge per line. Reading it
 * back and formatting again gives the same bytes.
 * @param {Edge[]} edges
 * @returns {string}
 */
export function formatBlockers(edges) {
  const lines = [...edges].sort(compareEdges).map((e) => `    ${JSON.stringify(normalizeEdge(e))}`);
  const list = lines.length === 0 ? '[]' : `[\n${lines.join(',\n')}\n  ]`;
  return `{\n  "schema": "${BLOCKERS_SCHEMA}",\n  "edges": ${list}\n}\n`;
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
// Units and statuses
// ---------------------------------------------------------------------------

/**
 * Every unit an edge can name, by id. A story's `feature` is the feature
 * it runs and merges with: its `feature:` when that names a feature, else
 * the feature that lists it. A task (F-65 D1) is a unit too, so it can be a
 * blocker or an `active_when` unit; its type has no gates, so no edge holds
 * it (`blockers-gate`).
 * @param {Array<{ id: string, status: string, feature?: string, depends_on?: any }>} stories
 * @param {Array<{ id: string, status: string, stories: string[] }>} features
 * @param {Array<{ id: string, status: string }>} [tasks]
 * @returns {Map<string, Unit>}
 */
export function unitIndex(stories, features, tasks = []) {
  const units = new Map();
  const listedIn = new Map();
  for (const f of features) {
    units.set(f.id, { id: f.id, type: 'feature', status: f.status, stories: [...f.stories] });
    for (const s of f.stories) if (!listedIn.has(s)) listedIn.set(s, f.id);
  }
  for (const s of stories) {
    const own = units.get(s.feature)?.type === 'feature' ? s.feature : '';
    units.set(s.id, {
      id: s.id,
      type: 'story',
      status: s.status,
      feature: own || listedIn.get(s.id) || '',
      depends_on: parseIdList(s.depends_on),
    });
  }
  for (const t of tasks) if (t.id) units.set(t.id, { id: t.id, type: 'task', status: t.status });
  return units;
}

/** `unitIndex` over the backlog's stories, features and tasks. */
export function readUnits(config) {
  return unitIndex(readAllStories(config), readAllFeatures(config), readAllTasks(config));
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
 * The ids a unit's gate checks: itself, and for a feature every story that
 * runs and merges with it (D2), so an edge on one of its stories holds it.
 * @param {Map<string, Unit>} units
 * @param {string} id
 * @returns {string[]}
 */
export function gateIds(units, id) {
  const ids = [id];
  if (units.get(id)?.type !== 'feature') return ids;
  for (const u of units.values()) if (u.type === 'story' && u.feature === id) ids.push(u.id);
  return ids;
}

/** The gates of `type` that `verb` checks, from `flow.json`. */
export function gatesAt(flow, type, verb) {
  return Object.entries(flow.gatesOf(type))
    .filter(([, verbs]) => verbs.includes(verb))
    .map(([gate]) => gate);
}

/**
 * `F-1 is held at merge by S-9 (in_progress, needs done)`: one unmet edge as
 * the gate and `bl status` name it. A wildcard edge is named on `id`.
 */
export function heldLine(edge, id, units) {
  const on = edge.unit === WILDCARD ? id : edge.unit;
  const status = units.get(edge.blocker)?.status ?? 'unknown';
  return `${on} is held at ${edge.gate} by ${edge.blocker} (${status}, needs ${edge.until})`;
}

/**
 * The active, unmet edges that hold unit `id`, in the file's order: each on
 * one of `gateIds(units, id)` or on `*`, at a gate that `gatesFor(type)`
 * names for that member's own type. So a feature's gate honours each of its
 * stories' gates with the story type's verbs, not the feature's.
 * @param {(type: string) => string[]} gatesFor
 * @returns {Edge[]}
 */
function holding(edges, units, flow, id, gatesFor) {
  const members = gateIds(units, id).map((m) => ({ id: m, gates: gatesFor(units.get(m).type) }));
  return edges.filter(
    (e) =>
      members.some((m) => m.gates.includes(e.gate) && (e.unit === WILDCARD || e.unit === m.id)) &&
      isActive(e, units, flow) &&
      !isMet(e, units, flow),
  );
}

/**
 * The gate check (D3): the unmet edges that hold unit `id` at every gate of
 * its type that `verb` checks and, for a feature, every gate of its
 * stories' type that `verb` checks on them (`holding`), each with its line.
 * No `blockers.json`, or one with no edges, holds nothing and reads neither
 * `flow.json` nor the units; otherwise a missing `flow.json` throws
 * `FlowError` and an unreadable `blockers.json` `BlockersError`.
 * @param {{ backlogRoot: string }} config
 * @param {string} id
 * @param {string} verb  `run`, `implement` or `merge`
 * @param {{ units?: Map<string, Unit> }} [opts]  the units, when the caller has them
 * @returns {Array<{ edge: Edge, line: string }>}
 */
export function heldBy(config, id, verb, { units = null } = {}) {
  const { edges } = readBlockers(config.backlogRoot);
  if (edges.length === 0) return [];
  const flow = loadFlow(config.backlogRoot);
  const all = units ?? readUnits(config);
  const unit = all.get(id);
  if (!unit) return [];
  return holding(edges, all, flow, id, (type) => gatesAt(flow, type, verb)).map((edge) => ({
    edge,
    line: heldLine(edge, id, all),
  }));
}

/**
 * `bl status`'s `held:` lines: every unmet, active edge on unit `id` (and a
 * feature's stories) at any gate of the member's type, in the file's order.
 * @param {{ backlogRoot: string }} config
 * @param {string} id
 * @returns {string[]}
 */
export function heldLines(config, id) {
  const { edges } = readBlockers(config.backlogRoot);
  if (edges.length === 0) return [];
  const flow = loadFlow(config.backlogRoot);
  const units = readUnits(config);
  const unit = units.get(id);
  if (!unit) return [];
  return holding(edges, units, flow, id, (type) => Object.keys(flow.gatesOf(type))).map((e) => heldLine(e, id, units));
}

/**
 * What is wrong with one edge against the flow and the backlog: unknown
 * ids (`blockers-unit`), a gate the unit's type lacks (`blockers-gate`), a
 * status its unit's type lacks (`blockers-status`), a blocker that is closed
 * and does not meet `until`, so would hold forever (`blockers-unmeetable`).
 * `bl block add` refuses an edge with any; `bl validate` reports each.
 * @returns {Array<{ code: string, message: string }>}
 */
export function edgeProblems(e, units, flow) {
  const out = [];
  const add = (code, message) => out.push({ code, message });
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

  if (e.unit === WILDCARD) {
    const types = Object.keys(flow.types).filter((t) => Object.hasOwn(flow.gatesOf(t), e.gate));
    if (types.length === 0) add('blockers-gate', `no type in flow.json has a gate "${e.gate}"`);
  } else if (unit && !Object.hasOwn(flow.gatesOf(unit.type), e.gate)) {
    add('blockers-gate', `a ${unit.type} has no gate "${e.gate}" in flow.json`);
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
 * The node a unit stands as: a story of a feature is its feature, since a
 * feature runs and merges as one unit; anything else is itself.
 */
function nodeOf(units, id) {
  const u = units.get(id);
  return u?.type === 'story' && u.feature ? u.feature : id;
}

/**
 * The arcs one edge adds (`from` waits on `to`), as if it were active and
 * unmet. A wildcard is expanded to every open unit whose type has the gate,
 * so a blocker that has the gate itself holds its own node.
 * @returns {Arc[]}
 */
function edgeArcs(e, units, flow) {
  if (!units.has(e.blocker)) return [];
  const to = nodeOf(units, e.blocker);
  const why = edgeLabel(e);
  if (e.unit !== WILDCARD) return units.has(e.unit) ? [{ from: nodeOf(units, e.unit), to, why, kind: 'edge' }] : [];
  const froms = new Set();
  for (const u of units.values()) {
    if (isClosed(u, flow) || !Object.hasOwn(flow.gatesOf(u.type), e.gate)) continue;
    froms.add(nodeOf(units, u.id));
  }
  return [...froms].map((from) => ({ from, to, why, kind: 'edge' }));
}

/**
 * D5's graph: nodes are features (standing for their stories) and
 * standalone stories; an arc `from → to` says `from` cannot pass a gate
 * until `to` moves on. Arcs come from every active, unmet edge (a wildcard
 * expanded) and from every `depends_on` on an open story that crosses a
 * feature boundary (until F-66 A5 folds those into edges).
 * @param {Edge[]} edges
 * @returns {Map<string, Arc[]>}
 */
export function holdGraph(edges, units, flow) {
  const graph = new Map();
  const add = (arc) => {
    if (!graph.has(arc.from)) graph.set(arc.from, []);
    graph.get(arc.from).push(arc);
  };
  for (const e of edges) {
    if (!isActive(e, units, flow) || isMet(e, units, flow)) continue;
    for (const arc of edgeArcs(e, units, flow)) add(arc);
  }
  for (const u of units.values()) {
    if (u.type !== 'story') continue;
    for (const dep of u.depends_on) {
      const d = units.get(dep);
      if (!d || isClosed(d, flow)) continue;
      const from = nodeOf(units, u.id);
      const to = nodeOf(units, dep);
      if (from !== to) add({ from, to, why: `${u.id} depends_on ${dep}`, kind: 'depends_on' });
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

/** `F-1 → F-2 (S-a depends_on S-b) → F-1 (F-2 at run by S-d)`. */
export function describeCycle(arcs) {
  return [arcs[0].from, ...arcs.map((a) => `${a.to} (${a.why})`)].join(' → ');
}

/**
 * The cycle `edge` would close in the graph of `edges`, or null. Like the
 * graph's other edges, it adds arcs only while active and unmet, so an edge
 * filed to start holding later (`active_when`) is checked by `bl validate`
 * once it does.
 * @returns {Arc[] | null}
 */
export function wouldCycle(edge, edges, units, flow) {
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
 * `blockers-cycle` (a deadlock in `holdGraph`; one of standalone stories'
 * `depends_on` alone is `cycle`'s, not reported twice), all errors, and
 * `blockers-order` (a warning: the text is not what `formatBlockers` writes).
 * A missing file has no findings.
 * @param {string} backlogRoot
 * @param {Map<string, Unit>} units
 * @param {import("./flow.js").Flow} flow
 */
export function findBlockersFindings(backlogRoot, units, flow) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message, location: BLOCKERS_FILE });
  let read;
  try {
    read = readBlockers(backlogRoot);
  } catch (err) {
    if (!(err instanceof BlockersError)) throw err;
    add('error', 'blockers-json', err.reason);
    return findings;
  }
  const { edges, text } = read;
  if (text != null && text !== formatBlockers(edges)) {
    add(
      'warning',
      'blockers-order',
      'not sorted by unit, blocker and gate one edge per line as bl writes it; bl block list --fix rewrites it',
    );
  }
  const seen = new Set();
  for (const e of edges) {
    const label = edgeLabel(e);
    if (seen.has(edgeKey(e))) add('error', 'blockers-duplicate', `${label} is listed more than once`);
    seen.add(edgeKey(e));
    for (const p of edgeProblems(e, units, flow)) add('error', p.code, `${label}: ${p.message}`);
  }
  for (const cycle of findHoldCycles(holdGraph(edges, units, flow))) {
    if (cycle.every((a) => a.kind === 'depends_on' && units.get(a.from)?.type === 'story')) continue;
    add('error', 'blockers-cycle', `deadlock: ${describeCycle(cycle)}`);
  }
  return findings;
}

/**
 * @typedef {{ blocker: string, gate: string, unit: string, until: string,
 *   active_when?: { unit: string, status: string } }} Edge
 * @typedef {{ id: string, type: string, status: string, feature?: string,
 *   stories?: string[], depends_on?: string[] }} Unit
 * @typedef {{ from: string, to: string, why: string, kind: "edge" | "depends_on" }} Arc
 */
