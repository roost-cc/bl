/**
 * rank-cmd.js — `bl rank`: how a person changes `priority.yaml` (F-78 D3,
 * F-113 D1).
 *
 *   bl rank                                   print the order
 *   bl rank <unit> --top|--bottom             put a unit first or last
 *   bl rank <unit> --before|--after <unit>    put it beside a ranked unit
 *   bl rank <unit> --remove                   take it out of the list
 *
 * A unit is a feature or a loose story (`priority.js`). The file is a YAML
 * list of unit ids and nothing else, so an edit reads the list with the
 * `yaml` package, moves or removes the id, and writes the whole list with
 * its `stringify`. The file is written under the backlog lock and committed
 * alone (`commitPaths`, which pushes); `bl.js` pulls the backlog first
 * (`commandPullsBacklog`).
 *
 * Every interactive run, with or without arguments, first takes each closed
 * unit out of the list (`removeClosed`) and commits that alone, before it
 * prints the order or applies the edit (S-1364). `bl merge` and `bl sync`
 * still never touch the file.
 *
 * Only a person ranks: inside an agent bl started headless (`BL_HEADLESS`,
 * set by each adapter's spawn) an edit is refused before anything is pulled
 * or written, and `commitPaths` refuses any commit of `priority.yaml` there
 * too. Printing the order is allowed everywhere; under `BL_HEADLESS` it
 * writes nothing and takes no closed unit out.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { atomicWriteFile } from './atomic-write.js';
import { info, loadConfig, normalizeId } from './config.js';
import { commitPaths } from './backlog-commit.js';
import { withLock } from './lock.js';
import { reportBacklogCommit } from './sync.js';
import { loadBacklog } from './backlog-graph.js';
import { normalizeFeatureId } from './feature.js';
import { normalizeTaskId } from './task.js';
import { HEADLESS_ENV, isHeadless } from './agents/provider.js';
import { PRIORITY_FILE, PriorityError, isLooseStory, parseRanked } from './priority.js';

const HELP = `Usage: bl rank
       bl rank <unit> (--top | --bottom | --before <unit> | --after <unit>)
       bl rank <unit> --remove

Change ${PRIORITY_FILE}, the backlog's one ranked list of units: features (F-<n>)
and loose stories (S-<n>, a story in no feature and not an update story).

${PRIORITY_FILE} is a YAML list of unit ids, one per line ("- F-93"), and
nothing else. Its order is the operator's preference: bl next and bl run pick
the first open unit that nothing holds, ranked units first, then every other
open unit, oldest "added:" first. Hard dependencies still come first (bl
next). The file holds no reasons; git history keeps them.

With no arguments, take closed units out (below), then print the order: the
ranked units (position, id, title), then every other open unit, oldest
"added:" first.

  --top, --bottom     Put <unit> first or last in the list
  --before <unit>     Put <unit> just before a ranked unit
  --after <unit>      Put <unit> just after a ranked unit
  --remove            Take <unit> out of the list; it falls back into the
                      dated tail

bl rank writes the whole list again, so comments in the file are not kept.
The file is committed alone and pushed, after the usual pull.

An interactive run, with or without arguments, first takes every closed unit
out of the list, in a commit of its own, and names them on stderr. Under
${HEADLESS_ENV} (every agent bl starts headless) an edit is refused and the
listing writes nothing: only the operator or an interactive session ranks.`;

// ---------------------------------------------------------------------------
// The list edit
// ---------------------------------------------------------------------------

/** A `priority.yaml` that bl rank cannot edit. */
export class RankFileError extends Error {}

/** The unit id an entry names (`F-3`, `S-4`), or its trimmed text. */
function canonical(raw) {
  const s = String(raw ?? '').trim();
  return normalizeFeatureId(s)?.id ?? normalizeId(s)?.id ?? s;
}

/**
 * The unit ids `content` lists, in order: each entry as `canonical` spells
 * it. Throws `RankFileError` when `content` is not YAML or not a list of ids
 * (`parseRanked`), so an edit never reports success on a file bl validate
 * rejects.
 * @param {string} content  priority.yaml
 * @returns {string[]}
 */
export function rankedIds(content) {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw new RankFileError(`${PRIORITY_FILE} is not YAML: ${doc.errors[0].message.split('\n')[0]}`);
  }
  try {
    return parseRanked(doc.toJS()).map((e) => canonical(e.unit));
  } catch (err) {
    if (err instanceof PriorityError) throw new RankFileError(err.message);
    throw err;
  }
}

/**
 * `content` without the units `ids`, each entry of them; `content` itself
 * when it lists none of them.
 * @param {string} content  priority.yaml
 * @param {string[]} ids
 */
export function removeClosed(content, ids) {
  const listed = rankedIds(content);
  const kept = listed.filter((x) => !ids.includes(x));
  return kept.length === listed.length ? content : stringify(kept);
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
 * Apply one `bl rank` edit to `content` and return the new text; `content`
 * itself when the order stays as it is.
 * @param {string} content  priority.yaml
 * @param {{ id: string, where?: 'top'|'bottom'|{before: string}|{after: string},
 *   remove?: boolean }} op
 */
export function applyRank(content, op) {
  const ids = rankedIds(content);
  if (op.remove && !ids.includes(op.id)) throw new RankFileError(`${op.id} is not ranked`);
  const next = op.remove ? ids.filter((x) => x !== op.id) : moved(ids, op.id, op.where);
  return sameOrder(ids, next) ? content : stringify(next);
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

/** One line of the listing: `F-3  Title`. */
function describe(u) {
  return `${u.id}  ${u.title}`;
}

/**
 * `bl rank` with no arguments: the order, ranked then the dated tail.
 * `fileReported`: the cleanup already named the file's problem.
 */
function printOrder(graph, fileReported = false) {
  for (const p of graph.problems) {
    if ((p.code === 'priority-file' && !fileReported) || p.code === 'priority-unit')
      info(`bl rank: ${p.message} (run bl validate)`);
  }
  const entryOf = new Map(graph.ranked.map((e) => [e.unit, e]));
  const ranked = graph.priority.filter((u) => entryOf.has(u));
  const tail = graph.priority.filter((u) => !entryOf.has(u));
  const out = [];
  if (ranked.length > 0) {
    out.push('Ranked:');
    for (const u of ranked) out.push(`  ${entryOf.get(u).position}. ${describe(u)}`);
  }
  if (tail.length > 0) {
    out.push('Not yet ranked, oldest first:');
    for (const u of tail) out.push(`  ${describe(u)}${u.added ? `  (added ${u.added})` : ''}`);
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

/**
 * Whether the uncommitted `content` of `priority.yaml` is exactly what
 * `change` (a function from HEAD's text to the new text: an edit, or the
 * cleanup of closed units) makes of HEAD's version: the write of an earlier
 * run whose commit failed, and nothing else (no other entry's edit). The
 * index must hold HEAD's version or that write (its `git add` may or may not
 * have run), never a staged edit of someone else's, which the commit's add
 * would overwrite.
 * @param {string} root
 * @param {string} content
 * @param {(head: string) => string} change
 */
function pendingIsOurs(root, content, change) {
  const show = (rev) => {
    const r = spawnSync('git', ['show', `${rev}:${PRIORITY_FILE}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 ? r.stdout : null;
  };
  const head = show('HEAD');
  const staged = show('');
  if (head == null || staged == null) return false;
  try {
    const ourWrite = change(head);
    return ourWrite !== head && ourWrite === content && (staged === head || staged === content);
  } catch (err) {
    if (err instanceof RankFileError) return false;
    throw err;
  }
}

/** The op's words for the commit subject and the report. */
function opWords(op) {
  if (op.remove) return 'unranked';
  if (op.where === 'top') return 'ranked first';
  if (op.where === 'bottom') return 'ranked last';
  return op.where.before ? `ranked before ${op.where.before}` : `ranked after ${op.where.after}`;
}

/**
 * The closed units `text` lists, once each, in list order: the entries
 * `loadBacklog` resolves (`graph.ranked`: a feature or a loose story) whose
 * unit is done. An entry that names no unit is never one of them. Throws
 * `RankFileError` on a file bl rank cannot edit.
 */
function closedIn(graph, text) {
  const ids = rankedIds(text).filter((id) => {
    const u = graph.get(id);
    return u?.done && (u.kind === 'feature' || isLooseStory(u));
  });
  return [...new Set(ids)];
}

/**
 * Take every closed unit out of the list and commit `priority.yaml` alone,
 * under the caller's lock. A file with someone else's uncommitted edits is
 * left as it is; a file that holds exactly an earlier cleanup's write whose
 * commit failed is redone on HEAD with today's closed units and committed
 * (`pendingIsOurs`); `reopened` names the units it put back.
 * @returns {Promise<{ removed: string[], reopened?: string[], commit?: object } | { skipped: string, fileError?: boolean }>}
 */
async function cleanup(root, path, graph) {
  const content = readFileSync(path, 'utf8');
  let ids;
  try {
    ids = closedIn(graph, content);
  } catch (err) {
    if (!(err instanceof RankFileError)) throw err;
    return { skipped: err.message, fileError: true };
  }
  const message = (removed) => `chore: ${removed.join(', ')} unranked (done) in ${PRIORITY_FILE}`;
  if (inRepo(root) && uncommitted(root)) {
    // An earlier cleanup whose commit failed left HEAD's text without the
    // entries of some units (`gone`). Closed states may have changed since, so
    // the retry redoes the cleanup on HEAD with today's closed set: a unit
    // closed since goes too, and a unit open again gets its entry back. A
    // write that took out only open units is not a cleanup's: a failed
    // `--remove` edit or a hand edit leaves the same text, so it stays.
    const left = new Set(rankedIds(content));
    const gone = (text) =>
      [...new Set(rankedIds(text))].filter((id) => {
        const u = graph.get(id);
        return !left.has(id) && u && (u.kind === 'feature' || isLooseStory(u));
      });
    let head = null;
    const ours = pendingIsOurs(root, content, (h) => removeClosed((head = h), gone(h)));
    const removed = ours ? closedIn(graph, head) : [];
    if (ours && gone(head).some((id) => removed.includes(id))) {
      const reopened = gone(head).filter((id) => !removed.includes(id));
      const next = removeClosed(head, removed);
      if (next !== content) atomicWriteFile(root, path, next);
      return { removed, reopened, commit: await commitPaths(root, [PRIORITY_FILE], message(removed)) };
    }
    if (ids.length === 0) return { removed: [] };
    return { skipped: `${PRIORITY_FILE} has uncommitted edits; left ${ids.join(', ')} in the list` };
  }
  if (ids.length === 0) return { removed: [] };
  atomicWriteFile(root, path, removeClosed(content, ids));
  if (!inRepo(root)) return { removed: ids, commit: { committed: false, paths: [PRIORITY_FILE], notRepo: true } };
  return { removed: ids, commit: await commitPaths(root, [PRIORITY_FILE], message(ids)) };
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

  const config = loadConfig();
  let graph = loadBacklog(config);
  const root = config.backlogRoot;
  const path = join(root, PRIORITY_FILE);
  const op = editing ? editOp(graph, path, values, positionals) : null;

  // An interactive run first takes closed units out, in a commit of its own.
  let fileReported = false;
  if (!isHeadless(env) && existsSync(path)) {
    const res = await withLock(root, async () => cleanup(root, path, graph));
    if (res.skipped) {
      // A file bl rank cannot edit: an edit refuses with this one line, and
      // the listing does not name the file's problem again.
      if (res.fileError && op) refuse(res.skipped);
      info(`bl rank: ${res.skipped}`);
      fileReported = Boolean(res.fileError);
    } else {
      if (res.reopened?.length > 0) info(`bl rank: ${res.reopened.join(', ')} open again; put back in the list`);
      if (res.removed.length > 0) {
        info(`bl rank: took out ${res.removed.join(', ')} (done).`);
        reportBacklogCommit(res.commit, 'bl rank');
        if (op?.remove && res.removed.includes(op.id)) return;
      }
      // The listing's positions are the file's as it now stands.
      if (!op && (res.removed.length > 0 || res.reopened?.length > 0)) graph = loadBacklog(config);
    }
  }
  if (!op) {
    printOrder(graph, fileReported);
    return;
  }
  await applyEdit(root, path, op);
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
    id = canonical(raw);
  } else {
    const checked = checkUnit(graph, raw);
    if (checked.refused) refuse(checked.refused);
    id = checked.id;
  }
  const pos = positions[0];
  const where = pos === 'top' || pos === 'bottom' ? pos : pos ? { [pos]: canonical(values[pos]) } : undefined;
  if (where?.before === id || where?.after === id) refuse(`${id} cannot be ranked beside itself`);
  return { id, where, remove: Boolean(values.remove) };
}

/** Apply `op` to `priority.yaml` under the lock, commit it alone and report. */
async function applyEdit(root, path, op) {
  const { id } = op;
  const res = await withLock(root, async () => {
    const content = readFileSync(path, 'utf8');
    let ids;
    try {
      ids = rankedIds(content);
    } catch (err) {
      if (err instanceof RankFileError) return { refused: err.message };
      throw err;
    }
    if (op.remove && !ids.includes(id)) return { refused: `${id} is not ranked` };
    const target = op.where?.before ?? op.where?.after;
    if (target && !ids.includes(target))
      return { refused: `${target} is not ranked; rank it first, or use --top or --bottom` };
    const next = applyRank(content, op);
    const commit = async () => commitPaths(root, [PRIORITY_FILE], `chore: ${id} ${opWords(op)} in ${PRIORITY_FILE}`);
    // Uncommitted edits to priority.yaml are committed only when they are
    // this command's own earlier write whose commit failed (a hook, git add,
    // the sync lock); anyone else's edits are never swept into a rank commit.
    const dirty = inRepo(root) && uncommitted(root);
    if (next === content) {
      if (!dirty) return { unchanged: true };
      if (!pendingIsOurs(root, content, (head) => applyRank(head, op))) return { unchanged: true, leftAlone: true };
      return { pending: true, commit: await commit() };
    }
    if (dirty) {
      return {
        refused: `${PRIORITY_FILE} has uncommitted edits; commit or discard them first. Nothing was written.`,
      };
    }
    atomicWriteFile(root, path, next);
    if (!inRepo(root)) return { commit: { committed: false, paths: [PRIORITY_FILE], notRepo: true } };
    return { commit: await commit() };
  });
  if (res.refused) refuse(res.refused);
  if (res.unchanged) {
    if (res.leftAlone) {
      info(`${id} is already there; ${PRIORITY_FILE} has other uncommitted edits, left uncommitted.`);
    } else info(`${id} is already there; ${PRIORITY_FILE} is unchanged.`);
    return;
  }
  if (res.pending) info(`${id} is already there, but ${PRIORITY_FILE} is not committed; committing it.`);
  else info(`${id} ${opWords(op)}.`);
  reportBacklogCommit(res.commit, 'bl rank');
}
