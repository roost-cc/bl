/**
 * block.js — `bl block add|remove|list` (F-66 D4): write and read the edges
 * in `blockers.json` (`src/blockers.js`).
 *
 * `add` checks every field against `flow.json` and the backlog, refuses a
 * duplicate and an edge that would close a cycle in the deadlock graph, and
 * `add`, `remove` and `list --fix` write the file sorted and commit it alone
 * under the backlog lock. `bl task --gate` (F-65 D2) files its edge through
 * the same check and write (`writeEdge`) and commits it with the task file.
 * The backlog is pulled first (`commandPullsBacklog`). Agents may not run
 * `remove` (`MODE_DENY`, F-66 A7): lifting a hold is the operator's.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'node:util';
import { atomicWriteFile } from './atomic-write.js';
import { info, loadConfig } from './config.js';
import { commitPaths } from './backlog-commit.js';
import { acquireLock, releaseLock, withLock } from './lock.js';
import { reportBacklogCommit } from './sync.js';
import { loadFlow } from './flow.js';
import { GITATTRIBUTES_LINE, configureMergeDriver } from './blockers-merge.js';
import {
  BLOCKERS_FILE,
  WILDCARD,
  describeCycle,
  edgeKey,
  edgeLabel,
  edgeProblems,
  formatBlockers,
  isActive,
  isMet,
  readBlockers,
  readUnits,
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
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
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
  const head = spawnSync('git', ['show', 'HEAD:.gitattributes'], { cwd: root, encoding: 'utf8' });
  return head.status === 0 && mapped(head.stdout) ? [BLOCKERS_FILE] : [BLOCKERS_FILE, '.gitattributes'];
}

/** Commit `paths` (`prepareCommit`'s), or say the backlog is not a repo. */
function commitBlockers(root, paths, message) {
  if (!paths) return { committed: false, paths: [BLOCKERS_FILE], notRepo: true };
  return commitPaths(root, paths, message);
}

/** Run `fn` under the backlog lock with the file read fresh. */
async function underLock(config, fn) {
  const root = config.backlogRoot;
  await acquireLock(root);
  try {
    return fn(readBlockers(root));
  } finally {
    releaseLock(root);
  }
}

/**
 * The check and the write of one edge, under the backlog lock the caller
 * holds, with no commit: refuses (returns `{ refused }`) an edge that
 * `edgeProblems` faults (an unknown id, gate or status, an unmeetable
 * `until`), a duplicate, and an edge that closes a cycle; otherwise readies
 * the clone (`prepareCommit`), writes `blockers.json` with the edge, and
 * returns the paths to commit (null when the backlog is not a repo).
 * `bl block add` and `bl task --gate` (F-65 D2) share it.
 * @param {object} config
 * @param {import("./blockers.js").Edge} edge
 * @returns {{ refused?: string[], edge?: object, paths?: string[] | null }}
 */
export function writeEdge(config, edge) {
  const flow = loadFlow(config.backlogRoot);
  const { edges } = readBlockers(config.backlogRoot);
  const units = readUnits(config);
  const problems = edgeProblems(edge, units, flow);
  if (problems.length > 0) return { refused: problems.map((p) => `${p.message} (${p.code})`) };
  if (edges.some((e) => edgeKey(e) === edgeKey(edge))) {
    return { refused: [`${edgeLabel(edge)} is already an edge (see bl block list ${edge.unit})`] };
  }
  const cycle = wouldCycle(edge, edges, units, flow);
  if (cycle) return { refused: [`${edgeLabel(edge)} would close a deadlock: ${describeCycle(cycle)}`] };
  const paths = prepareCommit(config.backlogRoot);
  writeBlockers(config.backlogRoot, [...edges, edge]);
  return { edge, paths };
}

/**
 * `bl block add`: file one edge (`writeEdge`) and commit `blockers.json`
 * alone under the backlog lock.
 * @param {object} config
 * @param {import("./blockers.js").Edge} edge
 * @returns {Promise<{ refused?: string[], edge?: object, commit?: object }>}
 */
export async function addEdge(config, edge) {
  return withLock(config.backlogRoot, () => {
    const res = writeEdge(config, edge);
    if (res.refused) return res;
    const message = `chore: block ${edge.unit} at ${edge.gate} on ${edge.blocker}`;
    return { edge, commit: commitBlockers(config.backlogRoot, res.paths, message) };
  });
}

/**
 * `bl block remove`: drop the edge with this identity. An unknown one
 * refuses.
 * @returns {Promise<{ refused?: string[], edge?: object, commit?: object }>}
 */
export async function removeEdge(config, key) {
  return underLock(config, ({ edges }) => {
    const found = edges.find((e) => edgeKey(e) === edgeKey(key));
    if (!found) return { refused: [`no edge ${edgeLabel(key)} (see bl block list ${key.unit})`] };
    const paths = prepareCommit(config.backlogRoot);
    writeBlockers(
      config.backlogRoot,
      edges.filter((e) => e !== found),
    );
    const message = `chore: unblock ${key.unit} at ${key.gate} on ${key.blocker}`;
    const commit = commitBlockers(config.backlogRoot, paths, message);
    return { edge: found, commit };
  });
}

/**
 * `bl block list --fix`: rewrite a hand-edited file sorted, one edge per
 * line. Nothing is written when it already is.
 * @returns {Promise<{ fixed: boolean, commit?: object }>}
 */
export async function fixOrder(config) {
  return underLock(config, ({ edges, text }) => {
    if (text == null || text === formatBlockers(edges)) return { fixed: false };
    const paths = prepareCommit(config.backlogRoot);
    writeBlockers(config.backlogRoot, edges);
    return { fixed: true, commit: commitBlockers(config.backlogRoot, paths, `chore: sort ${BLOCKERS_FILE}`) };
  });
}

/**
 * The edges on and by `id` (every edge without one): held on it, on `*`,
 * on one of a feature's stories, or with it as the blocker. Each line says
 * whether the edge holds: `unmet`, `met`, or `inactive` until its
 * `active_when` is met.
 * @param {import("./blockers.js").Edge[]} edges
 * @param {string | null} id
 * @returns {string[]}
 */
export function listLines(edges, id, units, flow) {
  const on = new Set(id ? [id, ...(units.get(id)?.stories ?? [])] : []);
  const statusOf = (unit) => units.get(unit)?.status ?? 'unknown';
  return edges
    .filter((e) => !id || on.has(e.unit) || e.unit === WILDCARD || e.blocker === id)
    .map((e) => {
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
edge per line, sorted by unit, blocker and gate). An edge holds <unit> at
<gate> until <blocker>'s status meets <until>, as flow.json says; --unit *
holds every unit with the gate. --active-when and --active-status keep the
edge from holding anything until that unit meets that status.

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
