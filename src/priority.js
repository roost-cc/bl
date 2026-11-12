/**
 * priority.js — the backlog's one ranked list of units (F-78 D1, F-113 D1).
 *
 * `backlog/priority.yaml` is the operator's order: a YAML list of work unit
 * ids, one per line, and nothing else:
 *
 *   - S-1
 *   - F-2
 *
 * bl reads it with the `yaml` package and `bl rank` writes the whole list
 * with its `stringify`. The reasons for the order are in git history, not in
 * the file. A **unit** is a feature or a **loose
 * story** (a story with no `feature:` and no `update_repo:`); stories inside a
 * feature, update stories and tasks are never ranked. `loadBacklog()` reads the
 * file and exposes the order it gives as `backlog.priority` and
 * `backlog.rankOf(id)`: the open ranked units in list order, then every other
 * open unit by `added:` (undated first), features before stories on a tie,
 * then by number. A unit needs no entry to be in the order: an unranked one
 * falls into that dated tail.
 *
 * The order is a preference, never a dependency: the readers that pick work
 * let hard dependencies override it.
 *
 * `bl rank` stages every edit (F-113 D3): it writes the staged copy
 * `.bl/priority.staged.yaml` and, on the first edit, the base copy
 * `.bl/priority.base.yaml` (`priority.yaml` as that edit found it), and only
 * `bl rank --commit` writes `priority.yaml`. Every reader that picks work
 * reads `priority.yaml` alone. `bl rank` and the `bl top` snapshot share the
 * paths, the reader of the staged copy (`readStaged`) and the markers
 * (`marks`) from here (F-113 D8).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseDocument } from 'yaml';
import { listValue, normalizeId } from './config.js';
import { normalizeFeatureId } from './feature.js';
import { normalizeTaskId } from './task.js';

/** The file's name, at the backlog root. */
export const PRIORITY_FILE = 'priority.yaml';

/** The staged copy every `bl rank` edit writes, from the backlog root (F-113 D3). */
export const STAGED_FILE = join('.bl', 'priority.staged.yaml');

/** The base copy: `priority.yaml` as the first staged edit found it, the merge base of `bl rank --commit`. */
export const BASE_FILE = join('.bl', 'priority.base.yaml');

/** What every `bl rank` command but `--reset` says while the staged copy is in conflict (F-113 Decision A3). */
export const STAGED_CONFLICT = `merge conflict in ${STAGED_FILE}: edit it, then bl rank --commit; or bl rank --reset`;

/** A staged copy that is not a YAML list of ids: in conflict (F-113 Decision A3). */
export class StagedConflictError extends Error {
  constructor() {
    super(STAGED_CONFLICT);
    this.name = 'StagedConflictError';
  }
}

/**
 * A priority file that is not YAML, or not a list of non-empty id strings.
 * `bl validate` reports it as `priority-file`.
 */
export class PriorityError extends Error {
  constructor(reason, file = PRIORITY_FILE) {
    super(`${file}: ${reason}; run bl validate`);
    this.name = 'PriorityError';
    this.reason = reason;
  }
}

/**
 * The priority file's list as entries `{ unit, position }`: each id as
 * written, trimmed, and `position` from 1. An empty file (YAML `null`) is an
 * empty order. Throws `PriorityError` on anything that is not a list of
 * non-empty strings.
 * @param {unknown} raw  the file's parsed YAML
 * @param {string} [file]  the file named in the error
 * @returns {Array<{ unit: string, position: number }>}
 */
export function parseRanked(raw, file = PRIORITY_FILE) {
  const list = listValue(raw);
  if (list == null) throw new PriorityError('the file is not a YAML list of work unit ids', file);
  return list.map((id, i) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new PriorityError(`entry ${i + 1} is not a work unit id`, file);
    }
    return { unit: id.trim(), position: i + 1 };
  });
}

/** The unit id an entry names (`F-3`, `S-4`), or its trimmed text. */
export function canonicalId(raw) {
  const s = String(raw ?? '').trim();
  return normalizeFeatureId(s)?.id ?? normalizeId(s)?.id ?? s;
}

/**
 * The unit ids the text of a priority file lists, in order, each as
 * `canonicalId` spells it. Throws `PriorityError` naming `file` when the text
 * is not YAML or not a list of ids (`parseRanked`).
 * @param {string} content
 * @param {string} [file]
 * @returns {string[]}
 */
export function listIds(content, file = PRIORITY_FILE) {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw new PriorityError(`the file is not YAML (${doc.errors[0].message.split('\n')[0]})`, file);
  }
  return parseRanked(doc.toJS(), file).map((e) => canonicalId(e.unit));
}

/**
 * The ids of the staged copy (`STAGED_FILE`) under the backlog `root`, or
 * null when there is none. Throws `StagedConflictError` when the copy is not
 * a YAML list of ids, which is normally git's conflict markers that
 * `bl rank --commit` wrote into it.
 * @param {string} root
 * @returns {string[] | null}
 */
export function readStaged(root) {
  let text;
  try {
    text = readFileSync(join(root, STAGED_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return listIds(text, STAGED_FILE);
  } catch (e) {
    if (e instanceof PriorityError) throw new StagedConflictError();
    throw e;
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Whether a story's frontmatter `fm` is an update story's, one `bl updates`
 * writes: a non-blank `update_repo:`.
 */
export function isUpdateStory(fm) {
  return str(fm.update_repo) !== '';
}

/**
 * Whether story unit `s` is a loose story, a unit of its own: no `feature:`
 * and not an update story (`isUpdateStory`). The raw keys, so a story naming
 * a feature that does not exist is not loose either.
 */
export function isLooseStory(s) {
  return !str(s.fm.feature) && !isUpdateStory(s.fm);
}

/**
 * Resolve the list against the graph's units: each valid entry once, as
 * `{ unit, position }` with `unit` the feature or story unit, and a
 * `priority-unit` problem for every other entry: one that names no feature or
 * story (a task included), one ranked twice (the first stays), a story inside
 * a feature, and an update story. A closed unit is resolved like an open one:
 * it is skipped by the order, never a problem.
 * @param {ReturnType<typeof parseRanked>} ranked
 * @param {{ features: ReadonlyMap<string, any>, stories: ReadonlyMap<string, any> }} maps
 * @returns {{ entries: Array<{ unit: any, position: number }>,
 *   problems: Array<{ ref: string, message: string }> }}
 */
export function resolveRanked(ranked, { features, stories }) {
  const entries = [];
  const problems = [];
  const first = new Map();
  for (const entry of ranked) {
    const at = `entry ${entry.position} (${entry.unit})`;
    const bad = (message) => problems.push({ ref: entry.unit, message: `${at} ${message}` });
    const fid = normalizeFeatureId(entry.unit)?.id;
    const sid = normalizeId(entry.unit)?.id;
    const unit = (fid && features.get(fid)) || (sid && stories.get(sid)) || null;
    if (!unit) {
      if (normalizeTaskId(entry.unit)) bad('names a task; only features and loose stories are ranked');
      else if (fid) bad('names no feature under features/');
      else if (sid) bad('names no story under stories/');
      else bad('is not a feature (F-<n>) or story (S-<n>) id');
      continue;
    }
    if (unit.kind === 'story' && str(unit.fm.feature)) {
      bad(`is a story inside ${str(unit.fm.feature)}; rank its feature instead`);
      continue;
    }
    if (unit.kind === 'story' && isUpdateStory(unit.fm)) {
      bad('is an update story; update stories are never ranked');
      continue;
    }
    if (first.has(unit.id)) {
      bad(`is ranked twice (first at entry ${first.get(unit.id)})`);
      continue;
    }
    first.set(unit.id, entry.position);
    entries.push({ unit, position: entry.position });
  }
  return { entries, problems };
}

/**
 * The number in an id (`S-12` → 12), for ordering only; -1 when it has none.
 * Past 2^53 two numbers may tie, which only leaves their order to the sort.
 * The graph's own sorts (`backlog-graph.js`) use it too.
 */
export function numOf(id) {
  const m = String(id).match(/(\d+)$/);
  return m ? Number(m[1]) : -1;
}

/**
 * The unranked tail's order: by `added:`, undated first (a unit with no
 * `added:` predates the field), then features before stories, then by number.
 */
export function byAdded(a, b) {
  if (a.added !== b.added) return a.added < b.added ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'feature' ? -1 : 1;
  return numOf(a.id) - numOf(b.id);
}

/**
 * The priority order (F-78 D1): the open units of `entries` in list order,
 * then every other open unit, features and loose stories alike, `byAdded`.
 * A unit is open when its `done` is false (`flow.meets(kind, status,
 * 'done')`), so with no flow this throws the flow's error.
 * @param {Array<{ unit: any }>} entries  `resolveRanked`'s entries
 * @param {{ features: ReadonlyMap<string, any>, stories: ReadonlyMap<string, any> }} maps
 * @returns {any[]} the units, feature and story units
 */
export function priorityOrder(entries, { features, stories }) {
  const placed = new Set();
  const out = [];
  for (const { unit } of entries) {
    if (unit.done) continue;
    placed.add(unit);
    out.push(unit);
  }
  const tail = [...features.values(), ...[...stories.values()].filter(isLooseStory)]
    .filter((u) => !u.done && !placed.has(u))
    .sort(byAdded);
  return [...out, ...tail];
}

/**
 * The place a unit sorts at in `order` (`priorityOrder`), from 0: a feature's
 * or loose story's own, a story inside a feature its feature's, so a
 * feature's stories sort together at its rank. Anything with no place (a
 * closed unit, an update story, a task, a story of a closed or missing
 * feature, an unknown id) is `Infinity`, after every placed one.
 * @param {any[]} order
 * @returns {(unit: any) => number}  the place of a unit (not an id)
 */
export function rankerOf(order) {
  const place = new Map(order.map((u, i) => [u, i]));
  return (unit) => (unit ? (place.get(rankedAs(unit)) ?? Infinity) : Infinity);
}

/**
 * The comparator every story listing sorts by (F-78 D2): the place
 * `rankOf(id)` gives (`backlog.rankOf`: a story at its feature's place, a
 * loose story at its own, no place last), then the id's number, so a
 * feature's stories sort together, by number.
 * @param {(id: string) => number} rankOf
 * @returns {(a: { id: string }, b: { id: string }) => number}
 */
export function byRank(rankOf) {
  return (a, b) => {
    const pa = rankOf(a.id);
    const pb = rankOf(b.id);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return numOf(a.id) - numOf(b.id);
  };
}

/**
 * The unit a story or feature is ranked as: a story inside a feature its
 * feature (null when that feature does not exist), anything else itself.
 * @param {any} unit
 * @returns {any}
 */
export function rankedAs(unit) {
  return unit.kind === 'story' && str(unit.fm.feature) ? unit.feature : unit;
}

/**
 * The order a list of ids gives: `ranked`, its open units in list order (each
 * valid entry once, `resolveRanked`), and `unranked`, every other open unit
 * `byAdded` (`priorityOrder`). For a list that is not `priority.yaml`'s, such
 * as the staged copy (`readStaged`).
 * @param {string[]} ids
 * @param {{ features: ReadonlyMap<string, any>, stories: ReadonlyMap<string, any> }} maps
 * @returns {{ ranked: any[], unranked: any[] }}
 */
export function orderOf(ids, maps) {
  const { entries } = resolveRanked(
    ids.map((unit, i) => ({ unit, position: i + 1 })),
    maps,
  );
  const order = priorityOrder(entries, maps);
  const ranked = new Set(entries.map((e) => e.unit));
  return { ranked: order.filter((u) => ranked.has(u)), unranked: order.filter((u) => !ranked.has(u)) };
}

/**
 * The ids of the longest common subsequence of `a` and `b`, two lists of
 * distinct ids. On a tie it keeps `b`'s earlier id.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Set<string>}
 */
function commonOrder(a, b) {
  const len = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const out = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      out.add(a[i]);
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * The marker of each work unit in the staged order against the committed one
 * (F-113 D4): `+` newly ranked, `~` ranked in both lists and moved, `-` taken
 * out of the ranked list, `''` unchanged. A unit is `~` when it is not in the
 * longest common subsequence of the two lists, so a move marks only the unit
 * that moved, not the rows it passed. Ids in neither list have no entry.
 * @param {string[]} committed  the committed ranked ids, distinct
 * @param {string[]} staged  the staged ranked ids, distinct
 * @returns {Map<string, '+' | '~' | '-' | ''>}
 */
export function marks(committed, staged) {
  const kept = commonOrder(committed, staged);
  const was = new Set(committed);
  const now = new Set(staged);
  const out = new Map();
  for (const id of staged) out.set(id, !was.has(id) ? '+' : kept.has(id) ? '' : '~');
  for (const id of committed) if (!now.has(id)) out.set(id, '-');
  return out;
}
