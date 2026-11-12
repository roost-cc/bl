/**
 * rank-cmd.js — `bl rank`: how a person changes `priority.yaml` (F-78 D3,
 * F-113 D1, D3).
 *
 *   bl rank                                   print the order
 *   bl rank <unit> --top|--bottom             put a unit first or last
 *   bl rank <unit> --before|--after <unit>    put it beside a ranked unit
 *   bl rank <unit> --remove                   take it out of the list
 *   bl rank --commit                          commit the staged edits
 *   bl rank --reset                           drop the staged edits
 *
 * A unit is a feature or a loose story (`priority.js`). The file is a YAML
 * list of unit ids and nothing else. Every edit is staged (F-113 D3): it
 * writes the staged copy `STAGED_FILE` under the backlog lock, and the first
 * edit also copies `priority.yaml` to the base copy `BASE_FILE`. An edit
 * never writes or commits `priority.yaml`, so `bl next` and `bl run` pick by
 * the committed order until `--commit`.
 *
 * `--commit` with no staged copy does nothing. With one, it pulls the backlog
 * (`pullBeforeCommand`, which `bl.js` runs for other committing commands), then merges
 * the staged copy and `priority.yaml` with `git merge-file`, base copy as the
 * merge base. It takes every closed unit out of the result, commits
 * `priority.yaml` alone (`commitPaths`, which pushes) and deletes both
 * copies. On a conflict it proposes a list (`proposal`) and asks y/n; on n it
 * writes git's conflict markers into the staged copy, which then blocks every
 * command but `--reset` (`StagedConflictError`) until the operator edits it.
 *
 * Only a person ranks: inside an agent bl started headless (`BL_HEADLESS`,
 * set by each adapter's spawn) an edit, `--commit` and `--reset` are refused
 * before anything is pulled or written, and `commitPaths` refuses any commit
 * of `priority.yaml` there too. Printing the order is allowed everywhere.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { atomicWriteFile } from './atomic-write.js';
import { info, loadConfig, normalizeId } from './config.js';
import { commitPaths } from './backlog-commit.js';
import { withLock } from './lock.js';
import { pullBeforeCommand, reportBacklogCommit } from './sync.js';
import { loadBacklog } from './backlog-graph.js';
import { normalizeFeatureId } from './feature.js';
import { normalizeTaskId } from './task.js';
import { HEADLESS_ENV, isHeadless } from './agents/provider.js';
import {
  BASE_FILE,
  PRIORITY_FILE,
  PriorityError,
  STAGED_FILE,
  StagedConflictError,
  canonicalId,
  isLooseStory,
  listIds,
  marks,
  orderOf,
  readStaged,
} from './priority.js';

/** The last stderr line of a `--commit` conflict with no terminal to ask in (F-113 D3). */
export const NO_TERMINAL = 'conflict: run bl rank --commit in a terminal';

const HELP = `Usage: bl rank
       bl rank <unit> (--top | --bottom | --before <unit> | --after <unit>)
       bl rank <unit> --remove
       bl rank --commit
       bl rank --reset

Change ${PRIORITY_FILE}, the backlog's one ranked list of units: features (F-<n>)
and loose stories (S-<n>, a story in no feature and not an update story).

${PRIORITY_FILE} is a YAML list of unit ids, one per line ("- F-93"), and
nothing else. Its order is the operator's preference: bl next and bl run pick
the first open unit that nothing holds, ranked units first, then every other
open unit, oldest "added:" first. Hard dependencies still come first (bl
next). The file holds no reasons; git history keeps them.

Every edit is staged: it writes ${STAGED_FILE}, which every session
on this backlog checkout shares, and never ${PRIORITY_FILE}. bl next and
bl run read only ${PRIORITY_FILE}, so a staged edit changes no pick until
--commit.

With no arguments, print the order: the ranked units (position, id, title),
then every other open unit, oldest "added:" first. While edits are staged,
print the staged order, each row marked: "+" newly ranked, "~" moved, "-"
taken out of the ranked list.

  --top, --bottom     Put <unit> first or last in the list
  --before <unit>     Put <unit> just before a ranked unit
  --after <unit>      Put <unit> just after a ranked unit
  --remove            Take <unit> out of the list; it falls back into the
                      dated tail
  --commit            Pull, merge the staged edits with ${PRIORITY_FILE} on
                      main, take closed units out, and commit and push the
                      file alone. On a conflict, propose the staged order
                      without the units main took out and with the units main
                      added at the end, and ask y/n. On n, write git's
                      conflict markers into ${STAGED_FILE} and exit 1:
                      edit it, then run --commit again. Without a terminal, a
                      conflict changes nothing and exits 1.
  --reset             Drop the staged edits

While ${STAGED_FILE} is not a YAML list of ids (a conflict), every
command but --reset exits 1.

bl rank writes the whole list again, so comments in the file are not kept.
Under ${HEADLESS_ENV} (every agent bl starts headless) an edit, --commit and
--reset are refused: only the operator or an interactive session ranks.`;

// ---------------------------------------------------------------------------
// The list edit
// ---------------------------------------------------------------------------

/** A `priority.yaml` that bl rank cannot edit, or an edit it cannot make. */
export class RankFileError extends Error {}

/**
 * The unit ids `content` lists, in order (`listIds`). Throws `RankFileError`
 * when `content` is not YAML or not a list of ids, so an edit never reports
 * success on a file bl validate rejects.
 * @param {string} content  priority.yaml
 * @returns {string[]}
 */
export function rankedIds(content) {
  try {
    return listIds(content);
  } catch (err) {
    if (err instanceof PriorityError) throw new RankFileError(err.message);
    throw err;
  }
}

/** `ids` with `id` moved to `where` (`applyRank`'s `where`). */
function moved(ids, id, where) {
  const rest = ids.filter((x) => x !== id);
  if (where === 'top') return [id, ...rest];
  if (where === 'bottom') return [...rest, id];
  const at = rest.indexOf(where.before ?? where.after);
  if (at < 0) throw new RankFileError(`${where.before ?? where.after} is not ranked`);
  return [...rest.slice(0, where.before ? at : at + 1), id, ...rest.slice(where.before ? at : at + 1)];
}

const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Apply one `bl rank` edit to the list `ids` and return the new list.
 * @param {string[]} ids
 * @param {{ id: string, where?: 'top'|'bottom'|{before: string}|{after: string},
 *   remove?: boolean }} op
 * @returns {string[]}
 */
export function applyRank(ids, op) {
  if (op.remove && !ids.includes(op.id)) throw new RankFileError(`${op.id} is not ranked`);
  return op.remove ? ids.filter((x) => x !== op.id) : moved(ids, op.id, op.where);
}

/**
 * The list `--commit` proposes on a conflict (F-113 D3): the staged order
 * without the units `main` took out of `base`, with the units `main` added
 * at the end.
 * @param {string[]} staged
 * @param {string[]} base
 * @param {string[]} main
 * @returns {string[]}
 */
export function proposal(staged, base, main) {
  const kept = staged.filter((id) => !base.includes(id) || main.includes(id));
  return [...kept, ...main.filter((id) => !base.includes(id) && !kept.includes(id))];
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Why `raw` cannot be ranked, or the unit's canonical id: a feature or loose
 * story that is open. A story inside a feature, an update story, a task, a
 * closed unit and an id the backlog does not have are refused.
 * @returns {{ id: string } | { refused: string }}
 */
export function checkUnit(graph, raw) {
  const s = String(raw ?? '').trim();
  const fid = normalizeFeatureId(s)?.id;
  const sid = normalizeId(s)?.id;
  if (!fid && !sid) {
    if (normalizeTaskId(s)) {
      return {
        refused: `${normalizeTaskId(s).id} is a task, an operator action; only features and loose stories are ranked`,
      };
    }
    return { refused: `'${s}' is not a feature (F-<n>) or story (S-<n>) id` };
  }
  const id = fid ?? sid;
  const unit = graph.get(id);
  if (!unit) return { refused: `${id} names no ${fid ? 'feature under features/' : 'story under stories/'}` };
  if (unit.kind === 'story' && !isLooseStory(unit)) {
    const feature = String(unit.fm.feature ?? '').trim();
    if (feature) return { refused: `${id} is a story inside ${feature}; the feature is the unit: rank ${feature}` };
    return { refused: `${id} is an update story; update stories are never ranked` };
  }
  if (unit.done) return { refused: `${id} is ${unit.status}; only open units are ranked` };
  return { id };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(message) {
  console.error(`bl rank: ${message}\n\n${HELP}`);
  process.exit(1);
}

function refuse(message) {
  console.error(`bl rank: ${message}`);
  process.exit(1);
}

/** The staged ids, null with no staged copy; refuses on a conflict (Decision A3). */
function stagedOrRefuse(root) {
  try {
    return readStaged(root);
  } catch (err) {
    if (err instanceof StagedConflictError) refuse(err.message);
    throw err;
  }
}

/** One line of the listing: `F-3  Title`. */
function describe(u) {
  return `${u.id}  ${u.title}`;
}

/**
 * Print the order: ranked, then the dated tail. With `ids` (the staged copy's
 * list, or a `--commit` proposal) print the order they give, each row with
 * its marker against the committed order (`marks`).
 * @param {any} graph
 * @param {string[] | null} [ids]
 * @param {string} [title]  the ranked group's heading
 */
function printOrder(graph, ids = null, title = 'Ranked:') {
  for (const p of graph.problems) {
    if (p.code === 'priority-file' || p.code === 'priority-unit') info(`bl rank: ${p.message} (run bl validate)`);
  }
  const committed = orderOf(
    graph.ranked.map((e) => e.unit.id),
    graph,
  );
  const shown = ids ? orderOf(ids, graph) : committed;
  const mark = ids
    ? marks(
        committed.ranked.map((u) => u.id),
        shown.ranked.map((u) => u.id),
      )
    : new Map();
  const col = (u) => (ids ? `${mark.get(u.id) || ' '} ` : '  ');
  const out = [];
  if (shown.ranked.length > 0) {
    out.push(title);
    shown.ranked.forEach((u, i) => out.push(`${col(u)}${i + 1}. ${describe(u)}`));
  }
  if (shown.unranked.length > 0) {
    out.push('Not yet ranked, oldest first:');
    for (const u of shown.unranked) out.push(`${col(u)}${describe(u)}${u.added ? `  (added ${u.added})` : ''}`);
  }
  if (out.length === 0) info('No open unit.');
  else process.stdout.write(`${out.join('\n')}\n`);
}

/** Whether the backlog root is a git work tree. */
function inRepo(root) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** Whether `priority.yaml` differs from HEAD, in the index or the work tree. */
function uncommitted(root) {
  const r = spawnSync('git', ['status', '--porcelain', '--', PRIORITY_FILE], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status !== 0 || r.stdout.trim() !== '';
}

/** The op's words for the report. */
function opWords(op) {
  if (op.remove) return 'unranked';
  if (op.where === 'top') return 'ranked first';
  if (op.where === 'bottom') return 'ranked last';
  return op.where.before ? `ranked before ${op.where.before}` : `ranked after ${op.where.after}`;
}

/**
 * The closed units `ids` names, once each, in list order: a feature or a
 * loose story whose unit is done. An id that names no unit is never one.
 */
function closedIn(graph, ids) {
  return [
    ...new Set(
      ids.filter((id) => {
        const u = graph.get(id);
        return u?.done && (u.kind === 'feature' || isLooseStory(u));
      }),
    ),
  ];
}

export async function main(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        top: { type: 'boolean' },
        bottom: { type: 'boolean' },
        before: { type: 'string' },
        after: { type: 'string' },
        remove: { type: 'boolean' },
        commit: { type: 'boolean' },
        reset: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    usage(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return;
  }
  const editing = positionals.length > 0 || Object.keys(values).length > 0;
  if (editing && isHeadless(env)) {
    refuse(
      `${HEADLESS_ENV} is set: this is an agent bl started headless, and only the operator or an ` +
        `interactive session ranks work. Nothing was written. Say what should change and why in your ` +
        `notes or a task for the operator instead.`,
    );
  }
  const whole = ['commit', 'reset'].filter((k) => values[k]);
  if (whole.length > 0 && (positionals.length > 0 || Object.keys(values).length > 1)) {
    usage(`--${whole[0]} takes no unit, position or other option`);
  }

  const config = loadConfig();
  const root = config.backlogRoot;
  if (values.reset) {
    await reset(root);
    return;
  }
  const staged = stagedOrRefuse(root);
  if (values.commit) {
    // With nothing staged, --commit is a no-op: it pulls nothing (F-113 D3).
    if (!staged) return;
    if ((await pullBeforeCommand(config)).state === 'unsafe') process.exit(1);
    await commitStaged(root, config);
    return;
  }
  const graph = loadBacklog(config);
  if (!editing) {
    printOrder(graph, staged, staged ? 'Ranked (staged; bl rank --commit commits it, --reset drops it):' : undefined);
    return;
  }
  await applyEdit(root, editOp(graph, join(root, PRIORITY_FILE), values, positionals));
}

/**
 * The edit `bl rank <unit> …` asks for, after the usage checks and
 * `checkUnit`; exits 1 on a refusal, before anything is written.
 */
function editOp(graph, path, values, positionals) {
  if (positionals.length !== 1) usage(positionals.length === 0 ? 'name the unit to rank' : 'name one unit');
  const positions = ['top', 'bottom', 'before', 'after'].filter((k) => values[k] != null && values[k] !== false);
  if (positions.length > 1) usage(`--${positions.join(', --')} are alternatives; give one`);
  if (values.remove && positions.length > 0) usage('--remove takes no position');
  if (!values.remove && positions.length === 0)
    usage('give a position (--top, --bottom, --before, --after) or --remove');

  if (!existsSync(path)) refuse(`${PRIORITY_FILE} is missing; bl init writes an empty one`);

  // The unit: --remove takes whatever the list names (a closed or vanished
  // unit included); anything else must be an open unit.
  const raw = positionals[0];
  let id;
  if (values.remove) {
    id = canonicalId(raw);
  } else {
    const checked = checkUnit(graph, raw);
    if (checked.refused) refuse(checked.refused);
    id = checked.id;
  }
  const pos = positions[0];
  const where = pos === 'top' || pos === 'bottom' ? pos : pos ? { [pos]: canonicalId(values[pos]) } : undefined;
  if (where?.before === id || where?.after === id) refuse(`${id} cannot be ranked beside itself`);
  return { id, where, remove: Boolean(values.remove) };
}

/**
 * Apply `op` to the staged copy under the lock. The first edit starts the
 * copy from `priority.yaml` and writes that file's text as the base copy.
 */
async function applyEdit(root, op) {
  const { id } = op;
  const res = await withLock(root, async () => {
    let staged;
    try {
      staged = readStaged(root);
    } catch (err) {
      if (err instanceof StagedConflictError) return { refused: err.message };
      throw err;
    }
    const committed = staged ? null : readFileSync(join(root, PRIORITY_FILE), 'utf8');
    let ids = staged;
    if (!ids) {
      try {
        ids = rankedIds(committed);
      } catch (err) {
        if (err instanceof RankFileError) return { refused: err.message };
        throw err;
      }
    }
    if (op.remove && !ids.includes(id)) return { refused: `${id} is not ranked` };
    const target = op.where?.before ?? op.where?.after;
    if (target && !ids.includes(target))
      return { refused: `${target} is not ranked; rank it first, or use --top or --bottom` };
    const next = applyRank(ids, op);
    if (sameOrder(ids, next)) return { unchanged: true };
    // The base copy first: a staged copy never stands without its base.
    if (committed != null) atomicWriteFile(root, join(root, BASE_FILE), committed);
    atomicWriteFile(root, join(root, STAGED_FILE), stringify(next));
    return {};
  });
  if (res.refused) refuse(res.refused);
  if (res.unchanged) info(`${id} is already there; nothing staged changed.`);
  else info(`${id} ${opWords(op)} (staged; bl rank --commit commits it).`);
}

/** `--reset`: delete the staged copy and the base copy under the lock. */
async function reset(root) {
  const had = await withLock(root, async () => {
    const was = existsSync(join(root, STAGED_FILE));
    for (const f of [STAGED_FILE, BASE_FILE]) rmSync(join(root, f), { force: true });
    return was;
  });
  info(had ? 'Dropped the staged edits.' : 'No staged edits.');
}

/**
 * The merge `--commit` makes of the three files as they are now, under the
 * caller's lock: `{ refused }`; `{ clean, ids }` for a merge with no
 * conflict; or `{ conflict, ids, markers }` with the proposed list and
 * `git merge-file`'s output. `ids` has no closed unit (`closed` names them)
 * and each id once. `inputs` is the three files' text, so a caller can tell
 * whether they changed since. The units are loaded here, under the lock, so
 * a unit closed during a lock wait or a question is taken out; `graph` is
 * that load.
 */
function mergeStaged(root, config) {
  let staged;
  try {
    staged = readStaged(root);
  } catch (err) {
    if (err instanceof StagedConflictError) return { refused: err.message };
    throw err;
  }
  if (!staged) return { nothing: true };
  const repo = inRepo(root);
  if (repo && uncommitted(root)) {
    return { refused: `${PRIORITY_FILE} has uncommitted edits; commit or discard them first. Nothing was committed.` };
  }
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const mainText = read(PRIORITY_FILE);
  let main;
  let base;
  try {
    main = rankedIds(mainText);
    base = rankedIds(read(BASE_FILE));
  } catch (err) {
    if (err instanceof RankFileError) return { refused: err.message };
    throw err;
  }
  const merge = spawnSync(
    'git',
    ['merge-file', '-p', '-L', 'staged', '-L', 'base', '-L', 'main', STAGED_FILE, BASE_FILE, PRIORITY_FILE],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Negative (255) is an error; 1 to 127 counts the conflicts.
  if (merge.error || merge.status == null || merge.status > 127) {
    return { refused: `git merge-file failed: ${merge.error?.message ?? merge.stderr.trim()}` };
  }
  let merged = null;
  if (merge.status === 0) {
    try {
      merged = rankedIds(merge.stdout);
    } catch (err) {
      if (!(err instanceof RankFileError)) throw err;
    }
  }
  const list = merged ?? proposal(staged, base, main);
  const graph = loadBacklog(config);
  const closed = closedIn(graph, list);
  const ids = [...new Set(list.filter((id) => !closed.includes(id)))];
  const inputs = [read(STAGED_FILE), read(BASE_FILE), mainText].join('\0');
  return {
    repo,
    main,
    mainText,
    graph,
    ids,
    closed,
    inputs,
    ...(merged ? { clean: true } : { markers: merge.stdout }),
  };
}

/**
 * Write `plan.ids` to `priority.yaml`, commit it alone and delete both
 * copies, under the caller's lock. An order that is already main's commits
 * nothing. A failed commit puts `priority.yaml` back as HEAD has it and keeps
 * the copies, so `--commit` can run again.
 */
async function commitPlan(root, plan) {
  const drop = () => {
    for (const f of [STAGED_FILE, BASE_FILE]) rmSync(join(root, f), { force: true });
  };
  if (sameOrder(plan.ids, plan.main)) {
    drop();
    return { same: true };
  }
  atomicWriteFile(root, join(root, PRIORITY_FILE), stringify(plan.ids));
  if (!plan.repo) {
    drop();
    return { commit: { committed: false, paths: [PRIORITY_FILE], notRepo: true } };
  }
  const out = plan.closed.length > 0 ? `; ${plan.closed.join(', ')} out (done)` : '';
  const commit = await commitPaths(root, [PRIORITY_FILE], `chore: commit the staged order of ${PRIORITY_FILE}${out}`);
  if (commit.committed) drop();
  else spawnSync('git', ['checkout', '-q', 'HEAD', '--', PRIORITY_FILE], { cwd: root, stdio: 'ignore' });
  return { commit };
}

/** Ask `question` on stderr and read one answer from stdin: whether it is yes. */
async function askYes(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  process.stderr.write(question);
  const answer = await new Promise((res) => {
    rl.once('line', res);
    rl.once('close', () => res(''));
  });
  rl.close();
  return /^\s*y(es)?\s*$/i.test(answer);
}

/** Report a `commitPlan` result. */
function reportCommit(res, closed) {
  if (closed.length > 0) info(`bl rank: took out ${closed.join(', ')} (done).`);
  if (res.same) {
    info(`The staged order is ${PRIORITY_FILE}'s already; dropped the staged edits.`);
    return;
  }
  info(`Committed the staged order of ${PRIORITY_FILE}.`);
  reportBacklogCommit(res.commit, 'bl rank');
}

/**
 * `--commit` with a staged copy (F-113 D3). A clean merge is committed
 * under the lock. A conflict prints the proposal with its markers and asks
 * y/n with the lock let go; the answer is acted on under the lock again,
 * only when the three files are as they were when it was asked.
 */
async function commitStaged(root, config) {
  const first = await withLock(root, async () => {
    const plan = mergeStaged(root, config);
    if (!plan.clean) return plan;
    return { plan, done: await commitPlan(root, plan) };
  });
  if (first.refused) refuse(first.refused);
  if (first.nothing) return;
  if (first.done) {
    reportCommit(first.done, first.plan.closed);
    return;
  }
  const plan = first;
  info(`bl rank: the staged edits conflict with ${PRIORITY_FILE} on main.`);
  if (!process.stdin.isTTY) {
    console.error(NO_TERMINAL);
    process.exit(1);
  }
  printOrder(plan.graph, plan.ids, 'Proposed order (the staged order, less what main took out, plus what main added):');
  const yes = await askYes(`Commit this order to ${PRIORITY_FILE}? [y/n] `);
  const res = await withLock(root, async () => {
    const now = mergeStaged(root, config);
    if (now.refused) return now;
    if (now.inputs !== plan.inputs) {
      return {
        refused: `${STAGED_FILE} or ${PRIORITY_FILE} changed while you answered; nothing was written. Run bl rank --commit again.`,
      };
    }
    if (yes) return { done: await commitPlan(root, now), closed: now.closed };
    // The marked copy already holds main's changes: main becomes the base, so
    // the next --commit does not apply them twice.
    atomicWriteFile(root, join(root, STAGED_FILE), now.markers);
    atomicWriteFile(root, join(root, BASE_FILE), now.mainText);
    return { marked: true };
  });
  if (res.refused) refuse(res.refused);
  if (res.marked) refuse(`wrote git's conflict markers into ${STAGED_FILE}; ${new StagedConflictError().message}`);
  reportCommit(res.done, res.closed);
}
