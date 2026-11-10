/**
 * transition.js — the transition log and its one writer (F-69 D2, D4).
 *
 * A story's, a feature's and a task's frontmatter holds `transitions:`, an
 * append-only list of entries:
 *
 *   transitions:
 *     - at: 2026-10-26T09:12:40Z    # ISO 8601, UTC
 *       to: draft                   # a status of the type
 *       by: new                     # the verb (`operator` for a hand edit)
 *       via: refine                 # the last capability that ran (optional)
 *       outcome: clean              # one line from its outcome (optional)
 *       note: migrated              # optional
 *
 * The status is the last entry's `to`, and the round is the number of entries
 * into `in_review`; neither is stored. An entry's `from` is the previous
 * entry's `to`. `added` (the first entry's date) and `completed` (a task's
 * `done`: the date of the entry to a terminal status) stay as fields for one
 * release; the writer sets them and `bl validate` checks them.
 *
 * `applyTransition` is the one writer: it appends an entry only along an
 * edge of `flow.json`'s table (`Flow.edges`). A work unit with no log reads
 * as the log the migration would write (`legacyLog`): its `status:` through
 * `LEGACY_STATUSES`, and an `in_progress` or `escalated` unit's review
 * position from its change document's `review_round` and `review_status`.
 */

import { FlowError, LEGACY_LOG, fromLegacy, loadFlow, statusWords } from './flow.js';
import { GUARDS } from './guards.js';
import { updateSpecFile } from './spec-file.js';

/** The fields an entry may have, in the order the writer puts them. */
export const ENTRY_FIELDS = ['at', 'to', 'by', 'via', 'outcome', 'note'];

/** The `note` of every entry the migration synthesized; `bl validate` does not check their edges. */
export const MIGRATED = 'migrated';

/** The `by` of a synthesized entry after the first. */
const MIGRATED_BY = 'migrated';

/** The `by` of an entry the operator wrote by hand: any verb's edge allows it. */
export const OPERATOR = 'operator';

/** The field that holds the date a unit reached a terminal status, per type. */
export const COMPLETED_KEY = { story: 'completed', feature: 'completed', task: 'done' };

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether an entry is one the migration (or a first write) synthesized. */
export const isMigrated = (entry) => typeof entry?.note === 'string' && /^migrated\b/.test(entry.note);

/** `at`'s date, `YYYY-MM-DD`. */
const dayOf = (at) => String(at).slice(0, 10);

/** A time (a `Date`, a time value or a date string) as an entry's `at`: UTC, whole seconds. */
export const isoAt = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Now, as an entry's `at`. */
export const nowAt = () => isoAt(Date.now());

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * The unit's stored log, or null when it has none: no `transitions:`, an
 * empty one, or one that is not a list of entries with a `to` (`bl validate`
 * reports that one; readers fall back to `status:`).
 * @param {object} fm
 * @returns {object[] | null}
 */
export function storedLog(fm) {
  const log = fm.transitions;
  if (!Array.isArray(log) || log.length === 0) return null;
  const ok = log.every((e) => e != null && typeof e === 'object' && !Array.isArray(e) && typeof e.to === 'string');
  return ok ? log : null;
}

/**
 * Whether a unit with no log reads its change document: its `status:` is
 * `in_progress` or `escalated`, so its review position (D4) matters.
 * @param {string} kind
 * @param {object} fm
 * @returns {boolean}
 */
export function readsChange(kind, fm) {
  if (kind === 'task' || storedLog(fm)) return false;
  return LEGACY_LOG.reviewed.includes(fromLegacy(kind, str(fm.status)));
}

/** A change document's `review_round` as a count: 0 when unset or not a number. */
function reviewRoundOf(change) {
  const n = parseInt(str(change?.fm?.review_round), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The log the migration writes for a unit with no log (F-69 D4), without
 * git dates: the first entry at `added`, the terminal one at `completed`
 * (a task's `done`), the others at `added`. Every entry has `note:
 * migrated`; a superseded unit's keeps its `superseded_by`. Empty when the
 * unit has no `status:`. An entry has no `at` when the unit has no `added`.
 *
 * | `status:`                    | after `draft`                                          |
 * | ---------------------------- | ------------------------------------------------------ |
 * | `refined`, `approved`        | that status                                            |
 * | `in_progress`                | `in_progress`, then the change document's review part  |
 * | `escalated`                  | the same, then `escalated`                             |
 * | `done`, `superseded`         | that status, at `completed`                            |
 *
 * The review part: one `in_review` per `review_round`, a `fixing` between
 * two; then `fixing` for `pending`, `fixing` and `in_review` for `fixed`
 * (the fix put it back in review for the next round), `ready_for_merge` for
 * `addressed`. Any other word (an unknown one) follows `draft` as it is.
 * @param {string} kind
 * @param {object} fm
 * @param {{ fm: object } | null} [change]  the unit's current change document (`readChange`)
 * @returns {object[]}
 */
export function legacyLog(kind, fm, change = null) {
  const word = fromLegacy(kind, str(fm.status));
  if (!word) return [];
  const added = DATE_RE.test(str(fm.added)) ? `${fm.added}T00:00:00Z` : null;
  const log = [];
  const push = (to, by, at = added, note = MIGRATED) => {
    // Never before the entry it follows.
    const prev = log.at(-1)?.at;
    const when = at && prev && at < prev ? prev : (at ?? prev ?? null);
    log.push({ ...(when ? { at: when } : {}), to, by, note });
  };
  push('draft', 'new');
  if (word === 'draft') return log;
  if (LEGACY_LOG.terminal.includes(word)) {
    const completed = str(fm[COMPLETED_KEY[kind]]);
    const supersededBy = str(fm.superseded_by);
    push(
      word,
      MIGRATED_BY,
      DATE_RE.test(completed) ? `${completed}T00:00:00Z` : added,
      supersededBy ? `${MIGRATED}; superseded_by: ${supersededBy}` : MIGRATED,
    );
    return log;
  }
  if (!LEGACY_LOG.reviewed.includes(word)) {
    push(word, MIGRATED_BY);
    return log;
  }
  push('in_progress', MIGRATED_BY);
  for (let i = 1; i <= reviewRoundOf(change); i++) {
    if (i > 1) push('fixing', MIGRATED_BY);
    push('in_review', MIGRATED_BY);
  }
  const review = str(change?.fm?.review_status);
  for (const to of Object.hasOwn(LEGACY_LOG.review, review) ? LEGACY_LOG.review[review] : []) push(to, MIGRATED_BY);
  if (word === 'escalated') push(word, MIGRATED_BY);
  return log;
}

/**
 * The unit's log: the stored one, or `legacyLog` for a unit with none.
 * @param {string} kind
 * @param {object} fm
 * @param {{ fm: object } | null} [change]
 * @returns {object[]}
 */
export function logOf(kind, fm, change = null) {
  return storedLog(fm) ?? legacyLog(kind, fm, change);
}

/**
 * The unit's status: its log's last `to`, `''` when it has neither a log nor
 * a `status:`.
 * @param {string} kind
 * @param {object} fm
 * @param {{ fm: object } | null} [change]
 * @returns {string}
 */
export function statusOf(kind, fm, change = null) {
  return logOf(kind, fm, change).at(-1)?.to ?? '';
}

/**
 * The unit's round: the number of entries into `in_review`.
 * @param {string} kind
 * @param {object} fm
 * @param {{ fm: object } | null} [change]
 * @returns {number}
 */
export function roundOf(kind, fm, change = null) {
  return logOf(kind, fm, change).filter((e) => e.to === 'in_review').length;
}

/** The unit's id, for a message: its id key, else `the <kind>`. */
function idOf(kind, fm) {
  return str(fm.story_id) || str(fm.feature_id) || str(fm.task_id) || `the ${kind}`;
}

/** Whether the type's table has the edge `from` → `to` under `by` (`operator`: under any verb). */
function hasEdge(flow, kind, from, to, by) {
  return flow.edges(kind).some((e) => e.from === from && e.to === to && (by === OPERATOR || e.by === by));
}

/**
 * Store `log` as `fm`'s `transitions:` and remove `status:`, in place:
 * `transitions:` takes `status:`'s place, and a unit with neither gets it
 * last. `applyTransition` and the migration (`migrate-transitions.js`) write
 * the log through it.
 * @param {object} fm
 * @param {object[]} log
 */
export function setLog(fm, log) {
  const keys = Object.keys(fm);
  if (!Object.hasOwn(fm, 'transitions') && Object.hasOwn(fm, 'status')) {
    const entries = keys.map((k) => (k === 'status' ? ['transitions', log] : [k, fm[k]]));
    for (const k of keys) delete fm[k];
    Object.assign(fm, Object.fromEntries(entries));
  } else {
    fm.transitions = log;
    delete fm.status;
  }
}

/**
 * Record `to` in `fm`'s log (F-69 D2): pure, so a caller that changes other
 * fields in one locked write calls it inside its `updateSpecFile` mutate.
 * The type's table must have an edge from the current status to `to` under
 * `by`: the verb's `during`, or one of its `success` or `failure` branches.
 * Else it throws `FlowError` and leaves `fm` unchanged. A `during` equal to
 * the current status records nothing and returns null.
 *
 * A unit with no log first gets the log `legacyLog` synthesizes (each entry
 * with no `at` takes this entry's), and loses `status:`; `transitions:`
 * takes `status:`'s place. The first entry sets `added`, and an entry to a
 * terminal status sets `completed` (a task's `done`), each to `at`'s date.
 * @param {import("./flow.js").Flow} flow
 * @param {"story" | "feature" | "task"} kind
 * @param {object} fm  the unit's frontmatter, changed in place
 * @param {string} to
 * @param {{ by: string, via?: string, outcome?: string, note?: string, at?: string,
 *   change?: { fm: object } | null }} opts  `change`: the unit's current change document,
 *   for a unit with no log
 * @returns {object | null}  the entry, or null when nothing was recorded
 */
export function applyTransition(flow, kind, fm, to, { by, via, outcome, note, at = nowAt(), change = null }) {
  const stored = storedLog(fm);
  const log = stored ?? legacyLog(kind, fm, change).map((e) => ({ at, ...e }));
  const current = log.at(-1)?.to ?? null;
  const row = flow.verbOf(kind, by);
  if (row?.during != null && row.during === to && current === to) return null;
  if (!hasEdge(flow, kind, current, to, by)) {
    const from = current ?? '(no status)';
    throw new FlowError(flow.path, `${idOf(kind, fm)} is ${from}; the ${kind} verb "${by}" has no transition to ${to}`);
  }
  const fields = { at, to, by, via, outcome, note };
  const entry = Object.fromEntries(ENTRY_FIELDS.filter((k) => str(fields[k])).map((k) => [k, fields[k]]));
  const next = [...log, entry];
  setLog(fm, next);
  if (next.length === 1 || !DATE_RE.test(str(fm.added))) fm.added = dayOf(next[0].at);
  if (flow.typeOf(kind).terminal.includes(to)) fm[COMPLETED_KEY[kind]] = dayOf(at);
  return entry;
}

/**
 * `applyTransition` on the unit's file, under its spec lock
 * (`updateSpecFile`). `unit` is a graph unit or a record with `kind` and
 * `file` or `indexPath`; its change document is read for a unit with no log.
 * Returns the entry, or null when nothing was recorded.
 * @param {string} backlogRoot
 * @param {{ kind: "story" | "feature" | "task", file?: string, indexPath?: string,
 *   change?: any }} unit
 * @param {string} to
 * @param {{ by: string, via?: string, outcome?: string, note?: string, at?: string }} opts
 * @returns {object | null}
 */
export function transition(backlogRoot, unit, to, opts) {
  const flow = loadFlow(backlogRoot);
  const change = typeof unit.change === 'function' ? (unit.change()?.change ?? null) : (unit.change ?? null);
  let entry = null;
  updateSpecFile(backlogRoot, unit.file ?? unit.indexPath, (fm) => {
    entry = applyTransition(flow, unit.kind, fm, to, { change, ...opts });
    return entry ? undefined : false;
  });
  return entry;
}

/**
 * Whether `verb` may start on `unit` (F-69 D3): null, or the refusal. The
 * unit's status must be in the verb row's `from`; the refusal names the
 * verb that reaches the first `from` status it can reach, as "S-5 is draft;
 * run starts from refined, in_progress or escalated (bl refine S-5 reaches
 * refined)". Then each of the row's `when` guards (`guards.js`) must hold.
 * @param {import("./flow.js").Flow} flow
 * @param {{ id: string, kind: "story" | "feature" | "task", status: string }} unit
 * @param {string} verb
 * @param {import("./guards.js").GuardContext} ctx
 * @returns {string | null}
 */
export function assertFrom(flow, unit, verb, ctx) {
  const { id, kind, status } = unit;
  const row = flow.verbOf(kind, verb);
  if (!row) return `${id}: a ${kind} has no ${verb} verb in flow.json`;
  const from = flow.fromOf(kind, row);
  if (!from.includes(status)) {
    const edges = flow.edges(kind).filter((e) => e.from === status && e.to !== status);
    const reach = from.map((s) => edges.find((e) => e.to === s)).find(Boolean);
    const hint = reach ? ` (bl ${reach.by} ${id} reaches ${reach.to})` : '';
    return `${id} is ${status || '(no status)'}; ${verb} starts from ${statusWords(from)}${hint}`;
  }
  for (const when of row.when) {
    const [name, arg] = when.split(':');
    if (!GUARDS.get(name)(ctx, arg)) return `${id}: ${verb} needs ${when}, and it does not hold`;
  }
  return null;
}

/**
 * `bl validate`'s findings on a unit's log (F-69 D2, D4). Errors
 * (`transition-log`): `transitions:` that is not a list of entries; an entry
 * with a field outside `ENTRY_FIELDS`, no `by`, or an `at` that is not ISO
 * 8601 UTC; a `to` that is not a status of the type; a consecutive pair no
 * verb defines (an entry with `note: migrated` is exempt); an `at` before
 * the one above it; an `added` or `completed` (a task's `done`) that
 * disagrees with the log. Warnings (`legacy-status`): `status:` with no log,
 * and `status:` beside a log.
 * @param {import("./flow.js").Flow} flow
 * @param {"story" | "feature" | "task"} kind
 * @param {object} fm
 * @param {string} location
 * @returns {Array<{ severity: "error" | "warning", code: string, message: string, location: string }>}
 */
export function findTransitionFindings(flow, kind, fm, location) {
  const findings = [];
  const error = (message) => findings.push({ severity: 'error', code: 'transition-log', message, location });
  const legacy = (message) => findings.push({ severity: 'warning', code: 'legacy-status', message, location });
  const raw = fm.transitions;
  const hasStatus = str(fm.status) !== '';
  if (raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
    if (hasStatus) {
      legacy(`status: "${fm.status}" and no transitions: log; node bl/scripts/migrate-transitions.js writes the log`);
    }
    return findings;
  }
  if (!Array.isArray(raw)) {
    error('transitions: is not a list of entries');
    return findings;
  }
  if (hasStatus) legacy(`status: "${fm.status}" beside a transitions: log; bl reads the log, so remove status:`);
  const { statuses, terminal } = flow.typeOf(kind);
  let prev = null;
  let terminalAt = null;
  raw.forEach((e, i) => {
    const at = `transitions entry ${i + 1}`;
    if (e == null || typeof e !== 'object' || Array.isArray(e)) {
      error(`${at} is not a mapping`);
      prev = null;
      return;
    }
    for (const k of Object.keys(e).filter((k) => !ENTRY_FIELDS.includes(k))) {
      error(`${at} has field "${k}"; an entry has only ${ENTRY_FIELDS.join(', ')}`);
    }
    if (!ISO_UTC_RE.test(str(e.at))) error(`${at} has at "${str(e.at)}", not an ISO 8601 UTC time`);
    else if (prev && ISO_UTC_RE.test(str(prev.at)) && Date.parse(e.at) < Date.parse(prev.at)) {
      error(`${at} at ${e.at} is before the entry above it (${prev.at})`);
    }
    if (!str(e.by)) error(`${at} has no "by" verb`);
    if (!statuses.includes(e.to)) {
      error(
        `${at} goes to "${str(e.to)}", which is not a ${kind} status (flow.json ${kind} statuses: ${statuses.join(', ')})`,
      );
    } else if (!isMigrated(e) && str(e.by) && !hasEdge(flow, kind, prev?.to ?? null, e.to, e.by)) {
      error(`${at}: no ${kind} verb "${e.by}" goes from ${prev?.to ?? '(no status)'} to ${e.to} (flow.json)`);
    }
    if (terminal.includes(e.to)) terminalAt = str(e.at);
    prev = e;
  });
  const first = str(raw[0]?.at);
  if (str(fm.added) && ISO_UTC_RE.test(first) && fm.added !== dayOf(first)) {
    error(`added: ${fm.added} disagrees with the log's first entry (${dayOf(first)})`);
  }
  const key = COMPLETED_KEY[kind];
  const completed = str(fm[key]);
  if (completed && terminalAt == null) {
    error(`${key}: ${completed} is set, and the log has no entry to ${statusWords(terminal)}`);
  } else if (completed && ISO_UTC_RE.test(terminalAt) && completed !== dayOf(terminalAt)) {
    error(`${key}: ${completed} disagrees with the log's entry to a terminal status (${dayOf(terminalAt)})`);
  }
  return findings;
}
