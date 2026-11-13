/**
 * block.js — `bl block add|remove|list` (F-66 D4): write and read the edges
 * in `blockers.json` (`src/blockers.js`).
 *
 * `add` checks every field against `flow.json` and the backlog, refuses a
 * duplicate and an edge that would close a cycle in the deadlock graph, and
 * `add`, `remove` and `list --fix` write the file sorted and commit it alone
 * under the backlog lock. `bl task --gate` (F-65 D2) files its edge through
 * the same check and write (`writeEdge`) and commits it with the task file;
 * `bl new` writes a new story's dependency edges through it (`writeEdges`),
 * and a story that joins a feature has its run edges with the feature's
 * stories turned into order edges (`orderJoinedEdges`, F-111 D5).
 * The backlog is pulled first (`commandPullsBacklog`). Agents may not run
 * `remove` (`MODE_DENY`, F-66 A7): lifting a hold is the operator's.
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { parseArgs } from 'node:util';
import { atomicWriteFile, snapshot } from './atomic-write.js';
import { git } from './child.js';
import { info, loadConfig } from './config.js';
import { commitPaths } from './backlog-commit.js';
import { acquireLock, releaseLock, withLock } from './lock.js';
import { reportBacklogCommit } from './sync.js';
import { loadFlow } from './flow.js';
import { GITATTRIBUTES_LINE, configureMergeDriver } from './blockers-merge.js';
import {
  BLOCKERS_FILE,
  ORDER_EDGE,
  RUN_EDGE,
  WILDCARD,
  dependencyEdge,
  describeCycle,
  edgeArrow,
  edgeKey,
  edgeLabel,
  edgeProblems,
  formatBlockers,
  holdGate,
  inFeature,
  isActive,
  isMet,
  readBlockers,
  readEdges,
  readUnits,
  repoEnd,
  storyUnitOf,
  wouldCycle,
  writeBlockers,
} from './blockers.js';

/**
 * Ready the clone before `blockers.json` is written, so a failure here
 * leaves the graph as it was: the merge driver (`blockers-merge.js`) in its
 * git config and its line in `.gitattributes`. Returns the paths to commit:
 * `blockers.json`, and `.gitattributes` while HEAD's lacks the line (a
 * commit that failed left it on disk only). Null when the backlog is not a
 * repo.
 * @returns {string[] | null}
 */
function prepareCommit(root) {
  const inRepo = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') return null;
  configureMergeDriver(root);
  const mapped = (text) => text.split('\n').includes(GITATTRIBUTES_LINE);
  const attributes = join(root, '.gitattributes');
  const text = existsSync(attributes) ? readFileSync(attributes, 'utf8') : '';
  if (!mapped(text)) {
    atomicWriteFile(
      root,
      attributes,
      `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${GITATTRIBUTES_LINE}\n`,
    );
  }
  const head = git(root, ['show', 'HEAD:.gitattributes']);
  return head.status === 0 && mapped(head.stdout) ? [BLOCKERS_FILE] : [BLOCKERS_FILE, '.gitattributes'];
}

/**
 * Run `fn`, which writes `blockers.json` and maybe `.gitattributes`, all or
 * nothing. When `fn` throws or returns `{ refused }`, each of the two files
 * that changed gets back the bytes it had (`snapshot`). The backlog-relative
 * path of a file that cannot be put back is in `left`, on the result beside
 * `refused` or on the thrown error, and the refusal or the error message
 * names it and what to do. A call inside another's `fn` only runs its own
 * `fn`: the outer call saved the bytes from before both.
 * @template T
 * @param {string} root
 * @param {() => T} fn
 * @returns {T & { left?: string[] }}
 */
export function allOrNothing(root, fn) {
  if (nested) return fn();
  nested = true;
  try {
    return putBackOnFailure(root, fn);
  } finally {
    nested = false;
  }
}

let nested = false;

/** `allOrNothing`'s save, run and put-back (`snapshot`). */
function putBackOnFailure(root, fn) {
  const undo = snapshot(root, [join(root, BLOCKERS_FILE), join(root, '.gitattributes')], ` of ${BLOCKERS_FILE}`);
  const leftOf = (err) => err.unrecovered.map((u) => relative(root, u.path));
  let res;
  try {
    res = fn();
  } catch (err) {
    const out = undo(err);
    if (out !== err) out.left = leftOf(out);
    throw out;
  }
  if (!res?.refused) return res;
  const out = undo(new Error(res.refused.join('; ')));
  return out.unrecovered ? { ...res, refused: [out.message], left: leftOf(out) } : res;
}

/**
 * Ready the clone (`prepareCommit`) and write `blockers.json` with `edges`,
 * all or nothing (`allOrNothing`): a failed write leaves `.gitattributes` as
 * it was too. Returns the paths to commit, null when the backlog is not a
 * repo.
 * @returns {string[] | null}
 */
function prepareAndWrite(root, edges) {
  return allOrNothing(root, () => {
    const paths = prepareCommit(root);
    writeBlockers(root, edges);
    return paths;
  });
}

/** Commit `paths` (`prepareCommit`'s), or say the backlog is not a repo. */
async function commitBlockers(root, paths, message) {
  if (!paths) return { committed: false, paths: [BLOCKERS_FILE], notRepo: true };
  return commitPaths(root, paths, message);
}

/** Run `fn` under the backlog lock with the file read fresh. */
async function underLock(config, fn) {
  const root = config.backlogRoot;
  await acquireLock(root);
  try {
    return await fn(readBlockers(root));
  } finally {
    releaseLock(root);
  }
}

/**
 * The check and the write of one edge, under the backlog lock the caller
 * holds, with no commit: refuses (returns `{ refused }`) an edge that
 * `edgeProblems` faults (an unknown id, gate or status, an unmeetable
 * `until`), a duplicate, and an edge that closes a cycle; otherwise readies
 * the clone and writes `blockers.json` with the edge (`prepareAndWrite`, all
 * or nothing), and returns the paths to commit (null when the backlog is not
 * a repo). A gate name from before F-119 is read as its status (`holdGate`),
 * so `--gate run` writes `in_progress`.
 * `bl block add` and `bl task --gate` (F-65 D2) share it.
 * @param {object} config
 * @param {import("./blockers.js").Edge} given
 * @returns {{ refused?: string[], edge?: object, paths?: string[] | null }}
 */
export function writeEdge(config, given) {
  const edge = holdGate(given);
  const flow = loadFlow(config.backlogRoot);
  const { edges } = readBlockers(config.backlogRoot);
  const units = readUnits(config);
  const problems = edgeProblems(edge, units, flow);
  if (problems.length > 0) return { refused: problems.map((p) => `${p.message} (${p.code})`) };
  if (edges.some((e) => edgeKey(e) === edgeKey(edge))) {
    return { refused: [`${edgeLabel(edge)} is already an edge (see bl block list ${edge.unit})`] };
  }
  // The cycle is checked among every edge bl reads, the `depends_on:` keys' too.
  const cycle = wouldCycle(edge, readEdges(config), units, flow);
  if (cycle) return { refused: [`${edgeLabel(edge)} would close a deadlock: ${describeCycle(cycle)}`] };
  const paths = prepareAndWrite(config.backlogRoot, [...edges, edge]);
  return { edge, paths };
}

/**
 * `writeEdge` for several edges, all or nothing, under the backlog lock the
 * caller holds, with no commit: `bl new` writes a new story's dependencies
 * through it (F-111 D5). When one edge is refused, or a write throws,
 * `blockers.json` and `.gitattributes` get back the bytes they had
 * (`allOrNothing`, which names in `left` a file it could not put back), and
 * the refusal is returned or the error thrown. `paths` are the paths to
 * commit.
 * @param {object} config
 * @param {import("./blockers.js").Edge[]} edges
 * @returns {{ refused?: string[], left?: string[], paths: string[] }}
 */
export function writeEdges(config, edges) {
  return allOrNothing(config.backlogRoot, () => {
    let paths = [];
    for (const edge of edges) {
      const res = writeEdge(config, edge);
      if (res.refused) return { refused: res.refused, paths: [] };
      paths = res.paths ?? [];
    }
    return { paths };
  });
}

/**
 * The run edges that become order edges when `joined` are in `feature`
 * (null: the feature their `feature:` names already), each a run edge between
 * one of `joined` and another story of that feature, and `order`, which maps
 * one to its order edge.
 */
function joinedRunEdges(config, joined, feature = null) {
  const { edges } = readBlockers(config.backlogRoot);
  const units = readUnits(config);
  const unitOf = (id) => (feature && joined.includes(id) ? feature : storyUnitOf(units, id));
  // The edge the pair stands for now: an order edge when both are in one feature or batch.
  const order = (e) => dependencyEdge(e.blocker, e.unit, unitOf);
  const turned = edges.filter(
    (e) =>
      e.gate === RUN_EDGE.gate &&
      (joined.includes(e.unit) || joined.includes(e.blocker)) &&
      order(e).gate === ORDER_EDGE.gate,
  );
  return { edges, turned, order };
}

/**
 * The refusal of `joined` joining `feature` (F-111 D5), null when there is
 * none: a run edge with `active_when` that the join would turn into an order
 * edge, which takes no `active_when`. `bl attach` and `bl new --feature … S-n`
 * check it before they write; `orderJoinedEdges` throws it.
 * @param {object} config
 * @param {string[]} joined  story ids
 * @param {string | null} [feature]  null: the feature their `feature:` names
 * @returns {string | null}
 */
export function joinRefusal(config, joined, feature = null) {
  return refusalOf(joinedRunEdges(config, joined, feature).turned);
}

/** `joinRefusal` of the run edges a join turns. */
function refusalOf(turned) {
  const held = turned.filter((e) => e.active_when);
  if (held.length === 0) return null;
  return held
    .map(
      (e) =>
        `${edgeLabel(e)} holds only once ${e.active_when.unit} is ${e.active_when.status}, and an order edge ` +
        `takes no active_when; remove it first (bl block remove ${e.blocker} --gate ${e.gate} --unit ${e.unit})`,
    )
    .join('; ');
}

/**
 * Stories that joined a feature (their `feature:` already written, F-111
 * D5): each run edge between one of `joined` and another story of the same
 * feature becomes the order edge between the two, since a run edge inside one
 * feature holds the feature on itself. It throws `joinRefusal` before it
 * writes anything. Under the backlog lock the caller holds, with no commit.
 * Returns null when no edge changed, else the paths to commit (empty when the
 * backlog is not a repo).
 * @param {object} config
 * @param {string[]} joined  story ids
 * @returns {string[] | null}
 */
export function orderJoinedEdges(config, joined) {
  const root = config.backlogRoot;
  const { edges, turned, order } = joinedRunEdges(config, joined);
  const refusal = refusalOf(turned);
  if (refusal) throw new Error(refusal);
  if (turned.length === 0) return null;
  const kept = edges.filter((e) => !turned.includes(e));
  const keys = new Set(kept.map(edgeKey));
  const added = turned.map(order).filter((e) => !keys.has(edgeKey(e)) && keys.add(edgeKey(e)));
  const paths = prepareAndWrite(root, [...kept, ...added]);
  for (const e of turned) info(`${edgeLabel(e)} is now the order edge ${edgeArrow(e)}`);
  return paths ?? [];
}

/**
 * `bl block add`: file one edge (`writeEdge`) and commit `blockers.json`
 * alone under the backlog lock.
 * @param {object} config
 * @param {import("./blockers.js").Edge} edge
 * @returns {Promise<{ refused?: string[], edge?: object, commit?: object }>}
 */
export async function addEdge(config, edge) {
  return withLock(config.backlogRoot, async () => {
    const res = writeEdge(config, edge);
    if (res.refused) return res;
    const message = `chore: block ${res.edge.unit} at ${res.edge.gate} on ${res.edge.blocker}`;
    return { edge: res.edge, commit: await commitBlockers(config.backlogRoot, res.paths, message) };
  });
}

/**
 * `bl block remove`: drop the edge with this identity, its gate read as
 * `writeEdge` reads it (`holdGate`). An unknown one refuses.
 * @returns {Promise<{ refused?: string[], edge?: object, commit?: object }>}
 */
export async function removeEdge(config, given) {
  const key = holdGate(given);
  return underLock(config, async ({ edges }) => {
    const found = edges.find((e) => edgeKey(e) === edgeKey(key));
    if (!found) return { refused: [`no edge ${edgeLabel(key)} (see bl block list ${key.unit})`] };
    const paths = prepareAndWrite(
      config.backlogRoot,
      edges.filter((e) => e !== found),
    );
    const message = `chore: unblock ${key.unit} at ${key.gate} on ${key.blocker}`;
    const commit = await commitBlockers(config.backlogRoot, paths, message);
    return { edge: found, commit };
  });
}

/**
 * `bl block list --fix`: rewrite a hand-edited file sorted, one edge per
 * line. Nothing is written when it already is.
 * @returns {Promise<{ fixed: boolean, commit?: object }>}
 */
export async function fixOrder(config) {
  return underLock(config, async ({ edges, text }) => {
    if (text == null || text === formatBlockers(edges)) return { fixed: false };
    const paths = prepareAndWrite(config.backlogRoot, edges);
    return { fixed: true, commit: await commitBlockers(config.backlogRoot, paths, `chore: sort ${BLOCKERS_FILE}`) };
  });
}

/**
 * The edges on and by `id` (every edge without one): held on it, on `*`,
 * on one of a feature's stories, with it as the blocker, or a merge or
 * order edge inside it (F-111 D1). Each line says whether the edge holds:
 * `unmet`, `met`, or `inactive` until its `active_when` is met. A merge or
 * order edge holds nothing, so its line names only the order.
 * @param {import("./blockers.js").Edge[]} edges
 * @param {string | null} id
 * @returns {string[]}
 */
export function listLines(edges, id, units, flow) {
  const on = new Set(id ? [id, ...(units.get(id)?.stories ?? [])] : []);
  const statusOf = (unit) => units.get(unit)?.status ?? 'unknown';
  return edges
    .filter((e) => !id || on.has(e.unit) || e.unit === WILDCARD || e.blocker === id || repoEnd(e.unit)?.unit === id)
    .map((e) => {
      if (inFeature(e, units)) {
        const after =
          e.gate === ORDER_EDGE.gate
            ? `${e.unit} is implemented after ${e.blocker}`
            : `${repoEnd(e.unit).repo} merges after ${repoEnd(e.blocker).repo}`;
        return `${e.gate} edge ${edgeArrow(e)}: ${after}`;
      }
      const line = `${e.unit} held at ${e.gate} by ${e.blocker} (${statusOf(e.blocker)}, needs ${e.until})`;
      const a = e.active_when;
      const when = a ? `, active when ${a.unit} is ${a.status} (${statusOf(a.unit)})` : '';
      const state = isMet(e, units, flow) ? 'met' : isActive(e, units, flow) ? 'unmet' : 'inactive';
      return `${line}: ${state}${when}`;
    });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: bl block add <blocker> --gate <gate> --unit <id|*> --until <status>
                    [--active-when <id> --active-status <status>]
       bl block remove <blocker> --gate <gate> --unit <id|*>
       bl block list [<id>] [--fix]

Holds between units, kept in ${BLOCKERS_FILE} at the backlog root (one
edge per line, sorted by unit, blocker and gate). A hold's <gate> is a
status of <unit>'s type in flow.json: the edge keeps <unit> out of that
status until <blocker>'s status meets <until>. bl run, bl implement and
bl merge check, when they start, the holds on each status their nominal
path enters. --unit * holds every unit whose type has the status. The gate
names run and merge read as in_progress and done. --active-when and
--active-status keep the edge from holding anything until that unit meets
that status; a merge or order edge takes neither.

  bl block add S-1 --gate in_refinement --unit S-2 --until done

A merge edge joins two repos of one feature and holds nothing: bl merge
merges the blocker's repo before the unit's, as in
  bl block add F-96:ci-cd --gate merge --unit F-96:bl --until merged
An order edge joins two stories of one feature or story batch and holds
nothing: the unit's implement loop takes the blocker before the unit, as in
  bl block add S-1446 --gate order --unit S-1448 --until implemented

  add      Check every field against flow.json and the backlog, refuse a
           duplicate or an edge that would close a deadlock, write the
           file and commit it
  remove   Drop the edge (blocker, gate, unit) and commit (operator only)
  list     Print the edges on and by <id> (every edge without one), met
           and unmet
    --fix  Rewrite a hand-edited ${BLOCKERS_FILE} sorted and commit it`;

const EDGE_OPTIONS = {
  gate: { type: 'string' },
  unit: { type: 'string' },
  until: { type: 'string' },
  'active-when': { type: 'string' },
  'active-status': { type: 'string' },
};

function usage(message) {
  console.error(`bl block: ${message}\n\n${HELP}`);
  process.exit(1);
}

function parse(argv, options, maxPositionals) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    usage(err.message);
  }
  if (parsed.positionals.length > maxPositionals) usage(`unexpected argument '${parsed.positionals[maxPositionals]}'`);
  return parsed;
}

function refuse(verb, reasons) {
  for (const r of reasons) console.error(`bl block ${verb}: ${r}`);
  process.exit(1);
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help' || rest.includes('-h') || rest.includes('--help')) {
    console.log(HELP);
    return;
  }
  const config = loadConfig();
  if (sub === 'add' || sub === 'remove') {
    const options = sub === 'add' ? EDGE_OPTIONS : { gate: EDGE_OPTIONS.gate, unit: EDGE_OPTIONS.unit };
    const { values, positionals } = parse(rest, options, 1);
    const [blocker] = positionals;
    const need = sub === 'add' ? ['gate', 'unit', 'until'] : ['gate', 'unit'];
    if (!blocker) usage(`${sub} needs a <blocker> id`);
    for (const k of need) if (!values[k]) usage(`${sub} needs --${k}`);
    if (sub === 'remove') {
      const res = await removeEdge(config, { blocker, gate: values.gate, unit: values.unit });
      if (res.refused) refuse(sub, res.refused);
      console.log(`unblocked: ${edgeLabel(res.edge)}`);
      reportBacklogCommit(res.commit, 'bl block remove');
      return;
    }
    if (!values['active-when'] !== !values['active-status']) {
      usage('--active-when and --active-status go together');
    }
    const edge = {
      blocker,
      gate: values.gate,
      unit: values.unit,
      until: values.until,
      ...(values['active-when']
        ? { active_when: { unit: values['active-when'], status: values['active-status'] } }
        : {}),
    };
    const res = await addEdge(config, edge);
    if (res.refused) refuse(sub, res.refused);
    console.log(`blocked: ${edgeLabel(res.edge)} until ${res.edge.until}`);
    reportBacklogCommit(res.commit, 'bl block add');
    return;
  }
  if (sub === 'list') {
    const { values, positionals } = parse(rest, { fix: { type: 'boolean' } }, 1);
    if (values.fix) {
      const res = await fixOrder(config);
      if (!res.fixed) {
        info(`${BLOCKERS_FILE} is already sorted.`);
        return;
      }
      info(`Rewrote ${BLOCKERS_FILE} sorted.`);
      reportBacklogCommit(res.commit, 'bl block list --fix');
      return;
    }
    const flow = loadFlow(config.backlogRoot);
    const { edges } = readBlockers(config.backlogRoot);
    const lines = listLines(edges, positionals[0] ?? null, readUnits(config), flow);
    if (lines.length === 0) info(positionals[0] ? `No edges on or by ${positionals[0]}.` : 'No edges.');
    for (const line of lines) console.log(line);
    return;
  }
  usage(`unknown subcommand '${sub}'`);
}
