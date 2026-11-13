/**
 * flow.js — the backlog's `flow.json` (F-66 D1, F-69 D1): per unit type, its
 * statuses in lifecycle order, the terminal ones, and the verbs that move a
 * unit between them. A hold in `blockers.json` can gate entry into any status
 * (F-119 D4), so the file has no gates of its own; a verb checks the holds on
 * its nominal path (`nominalPath`, D6).
 *
 *   {
 *     "schema": "bl-flow/v2",
 *     "types": {
 *       "story": {
 *         "statuses": ["draft", "refined", "in_progress", "done", "superseded"],
 *         "terminal": ["done", "superseded"],
 *         "verbs": {
 *           "refine": { "from": ["draft", "refined"], "via": ["refine"],
 *                       "success": [{ "to": "refined" }], "failure": [{ "to": "draft" }] }
 *         }
 *       }
 *     }
 *   }
 *
 * A verb is `{ from, when?, during?, via?, success?, failure? }`: `from` is a
 * list of statuses or `*` (every status that is not terminal), `when` and
 * `via` name guards (`guards.js`) and capabilities (`capabilities.js`), and
 * each branch is `{ when?, to, then? }`. A status meets `X` when it is `X` or
 * comes after `X` in `statuses`. `findFlowFindings` (`bl validate`'s
 * `flow-json`) checks the tables. `loadFlow` fails loud on a file the helpers
 * cannot read at all: missing, not JSON, a wrong `schema`, a type bl needs
 * missing, or a shape that is not the one above.
 *
 * A `bl-flow/v1` file (statuses with `implies`, no verbs) still loads, until
 * the migration rewrites it (F-69 D4): as bl's v2 template, with
 * `flow.legacy` set. `LEGACY_STATUSES` maps the v1 words. A type's `gates`
 * table, from before F-119, still loads and is not read; `flow-json` warns on
 * it.
 */

import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { findBacklogRoot } from './config.js';

/** The file's name, at the backlog root. */
export const FLOW_FILE = 'flow.json';

export const FLOW_SCHEMA = 'bl-flow/v2';

/** The schema before F-69: read as the template. */
export const LEGACY_FLOW_SCHEMA = 'bl-flow/v1';

/** The one document of the file's format (F-119 R7); `bl flow --help` and each `flow-json` finding name it. */
export const FLOW_DOC = 'bl/templates/flow.schema.md';

/** The script that rewrites a v1 backlog (F-69 D4); `flow-json` names it. */
export const MIGRATION_SCRIPT = 'bl/scripts/migrate-transitions.js';

/** The types every backlog's flow names: `task` since F-65 (D1). */
export const FLOW_TYPES = ['story', 'feature', 'task'];

/** The `bl` verbs that only read a unit, so no table has a row for them. */
export const READ_VERBS = ['status'];

/** `from: "*"`: every status of the type that is not terminal. */
export const ANY_OPEN = '*';

/**
 * The v1 status words that F-69 renamed (Decision A3), per type. The reader,
 * the migration and `history.js` map them through `fromLegacy`.
 */
export const LEGACY_STATUSES = {
  story: { backlog: 'draft' },
  feature: { running: 'in_progress' },
  task: { open: 'draft' },
};

/**
 * How a unit with no transition log reads (F-69 D4), beside
 * `LEGACY_STATUSES`; `legacyLog` (`transition.js`) and the migration use it.
 * `reviewed`: the statuses (in the current words) whose log takes its change
 * document's review part. `terminal`: the ones whose entry is dated at
 * `completed`. `review`: the statuses that follow the `in_review` entries for
 * each v1 `review_status` of a change document (`fixed`: the fix put the unit
 * back in review for the next round).
 */
export const LEGACY_LOG = {
  reviewed: ['in_progress', 'escalated'],
  terminal: ['done', 'superseded'],
  review: { pending: ['fixing'], fixed: ['fixing', 'in_review'], addressed: ['ready_for_merge'] },
};

/**
 * The statuses a review round moves a unit between (F-69 D5), by role:
 * `open`, a round in review with no verdict yet; `items`, the round's open
 * items, being fixed; `clean`, the round passed. `reviewOf`
 * (`transition.js`) reads a unit's review state from them, and the merge
 * gate refuses `blocked`.
 */
export const REVIEW = Object.freeze({
  open: 'in_review',
  items: 'fixing',
  clean: 'ready_for_merge',
  blocked: Object.freeze(['in_review', 'fixing']),
});

/**
 * `status` in the current words: a v1 word of `type` mapped, anything else
 * unchanged.
 * @param {string} type
 * @param {any} status
 * @returns {any}
 */
export function fromLegacy(type, status) {
  const map = LEGACY_STATUSES[type];
  return map && typeof status === 'string' && Object.hasOwn(map, status) ? map[status] : status;
}

/**
 * `bl validate`'s reading of a stored status word of `type` (F-69 D6): null
 * when it is one of the type's statuses, a warning when it is a v1 word
 * `LEGACY_STATUSES` maps (the migration rewrites it), and an error otherwise.
 * @param {Flow} flow
 * @param {string} type
 * @param {string} status
 * @returns {{ severity: "error" | "warning", message: string } | null}
 */
export function statusWordProblem(flow, type, status) {
  const statuses = flow.statusesOf(type);
  if (statuses.includes(status)) return null;
  const word = fromLegacy(type, status);
  if (statuses.includes(word)) {
    return {
      severity: 'warning',
      message: `status "${status}" is the old word for "${word}"; node ${MIGRATION_SCRIPT} rewrites it`,
    };
  }
  return {
    severity: 'error',
    message: `status "${status}" not in known set (${FLOW_FILE} ${type} statuses: ${statuses.join(', ')})`,
  };
}

/** A `flow.json` bl cannot read: the message names the file and the fault. */
export class FlowError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'FlowError';
    this.path = path;
    this.reason = reason;
  }
}

/** One parsed flow per file, kept while its mtime and size are unchanged. */
const cache = new Map();

/** Where `bl init`'s `flow.json` lives. */
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export function flowPath(backlogRoot) {
  return join(backlogRoot, FLOW_FILE);
}

/**
 * Read `<backlogRoot>/flow.json`. Throws `FlowError` when it is missing,
 * unparsable, of a wrong schema, lacks a type in `FLOW_TYPES`, or has a part
 * of the wrong shape.
 * @param {string} backlogRoot
 * @returns {Flow}
 */
export function loadFlow(backlogRoot) {
  const path = flowPath(backlogRoot);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new FlowError(path, 'missing; every backlog needs one (bl init writes it)');
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(path);
  if (hit?.key === key) return hit.flow;
  const flow = new Flow(path, readJson(path));
  cache.set(path, { key, flow });
  return flow;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FlowError(path, `not valid JSON (${err.message})`);
  }
}

/**
 * The flow `--help` words its status lists from: the backlog's, or `bl init`'s
 * template where there is none to read, since help works anywhere. With
 * `strict`, the template stands in only outside a backlog: a backlog's
 * `flow.json` that `loadFlow` cannot read throws (`bl flow`, which shows the
 * admin that file).
 * @param {{ strict?: boolean }} [opts]
 * @returns {Flow}
 */
export function flowForHelp({ strict = false } = {}) {
  let root;
  try {
    root = findBacklogRoot();
  } catch {
    return loadFlow(TEMPLATE_DIR);
  }
  try {
    return loadFlow(root);
  } catch (err) {
    if (strict) throw err;
    return loadFlow(TEMPLATE_DIR);
  }
}

/**
 * `names` as prose: `a`, `a or b`, `a, b or c`, for a message about a set of
 * statuses. `(none)` when a flow has none.
 * @param {string[]} names
 * @param {string} [word]  what joins the last two
 * @returns {string}
 */
export function statusWords(names, word = 'or') {
  if (names.length === 0) return '(none)';
  return [names.slice(0, -1).join(', '), names.at(-1)].filter(Boolean).join(` ${word} `);
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * @typedef {{ when: string[], to: string, then: string | null }} Branch
 * @typedef {{ from: string[] | "*", when: string[], during: string | null, via: string[],
 *   success: Branch[], failure: Branch[] }} Verb
 * @typedef {{ statuses: string[], terminal: string[], verbs: Record<string, Verb> }} FlowType
 */

/** A v1 file's types as v2: bl's template alone (F-69 D4). */
function legacyAsV2() {
  return readJson(join(TEMPLATE_DIR, FLOW_FILE)).types;
}

/**
 * The `flow.json` text the migration writes over a v1 file (F-69 D4): bl's
 * template, or null when the file is v2 already. Throws `FlowError` as
 * `loadFlow` does.
 * @param {string} backlogRoot
 * @returns {string | null}
 */
export function migratedFlowText(backlogRoot) {
  return loadFlow(backlogRoot).legacy ? readFileSync(join(TEMPLATE_DIR, FLOW_FILE), 'utf8') : null;
}

/** A branch list, checked; `at` names it in a message. */
function parseBranches(path, at, v) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new FlowError(path, `${at} is not a list of branches`);
  return v.map((b, i) => {
    if (!isObject(b) || typeof b.to !== 'string') throw new FlowError(path, `${at} branch ${i + 1} has no "to" status`);
    if (b.when !== undefined && !isStringList(b.when)) {
      throw new FlowError(path, `${at} branch ${i + 1} has a "when" that is not a list of guards`);
    }
    if (b.then !== undefined && typeof b.then !== 'string') {
      throw new FlowError(path, `${at} branch ${i + 1} has a "then" that is not a verb`);
    }
    return { when: b.when ?? [], to: b.to, then: b.then ?? null };
  });
}

/** A verb row, checked and with its optional keys filled. */
function parseVerb(path, at, v) {
  if (!isObject(v)) throw new FlowError(path, `${at} is not an object`);
  if (v.from !== ANY_OPEN && !isStringList(v.from)) {
    throw new FlowError(path, `${at} has no "from" list of statuses (or "${ANY_OPEN}")`);
  }
  for (const key of ['when', 'via']) {
    if (v[key] !== undefined && !isStringList(v[key]))
      throw new FlowError(path, `${at} "${key}" is not a list of names`);
  }
  if (v.during !== undefined && typeof v.during !== 'string') {
    throw new FlowError(path, `${at} "during" is not a status`);
  }
  return {
    from: v.from,
    when: v.when ?? [],
    during: v.during ?? null,
    via: v.via ?? [],
    success: parseBranches(path, `${at} "success"`, v.success),
    failure: parseBranches(path, `${at} "failure"`, v.failure),
  };
}

/** One type of a v2 file, checked. */
function parseType(path, type, def) {
  const at = `type "${type}"`;
  if (!isObject(def)) throw new FlowError(path, `${at} is not an object`);
  if (!isStringList(def.statuses) || def.statuses.length === 0) {
    throw new FlowError(path, `${at} has no "statuses" list`);
  }
  if (!isStringList(def.terminal)) throw new FlowError(path, `${at} has no "terminal" list`);
  if (!isObject(def.verbs)) throw new FlowError(path, `${at} has no "verbs" object`);
  const verbs = {};
  for (const [verb, v] of Object.entries(def.verbs)) verbs[verb] = parseVerb(path, `${at} verb "${verb}"`, v);
  return { statuses: def.statuses, terminal: def.terminal, verbs };
}

export class Flow {
  /**
   * @param {string} path  the file, for messages
   * @param {any} raw      its parsed JSON
   */
  constructor(path, raw) {
    this.path = path;
    if (!isObject(raw)) throw new FlowError(path, 'not a JSON object');
    if (raw.schema !== FLOW_SCHEMA && raw.schema !== LEGACY_FLOW_SCHEMA) {
      throw new FlowError(path, `"schema" is ${JSON.stringify(raw.schema)}, not "${FLOW_SCHEMA}"`);
    }
    if (!isObject(raw.types)) throw new FlowError(path, `"types" is not an object`);
    for (const type of FLOW_TYPES) {
      if (!Object.hasOwn(raw.types, type)) throw new FlowError(path, `no "${type}" type in "types"`);
    }
    /** Whether the file is v1, read as the template (F-69 D4). */
    this.legacy = raw.schema === LEGACY_FLOW_SCHEMA;
    const types = this.legacy ? legacyAsV2() : raw.types;
    /** The types that still have a `gates` table, which bl does not read (F-119 D4). */
    this.gateTables = Object.keys(types).filter((t) => isObject(types[t]) && Object.hasOwn(types[t], 'gates'));
    /** @type {Record<string, FlowType>} */
    this.types = {};
    for (const [type, def] of Object.entries(types)) this.types[type] = parseType(path, type, def);
  }

  /** The type's definition, or a `FlowError` when the flow has no such type. */
  typeOf(type) {
    const def = Object.hasOwn(this.types, type) ? this.types[type] : null;
    if (!def) throw new FlowError(this.path, `no "${type}" type in "types"`);
    return def;
  }

  /**
   * The type's statuses, in lifecycle order.
   * @param {string} type
   * @returns {string[]}
   */
  statusesOf(type) {
    return [...this.typeOf(type).statuses];
  }

  /**
   * The status a unit of `type` starts in: the first of `statuses`.
   * @param {string} type
   * @returns {string}
   */
  initial(type) {
    return this.typeOf(type).statuses[0];
  }

  /**
   * `status` as a status of `type`, a v1 word mapped (`fromLegacy`); null
   * when it is not one, or not a string.
   * @returns {string | null}
   */
  #known(type, status) {
    const { statuses } = this.typeOf(type);
    // A string only: frontmatter's `[superseded]` is no status.
    if (typeof status !== 'string') return null;
    const word = statuses.includes(status) ? status : fromLegacy(type, status);
    return statuses.includes(word) ? word : null;
  }

  /**
   * The type's open statuses (those that do not meet `done`), furthest along
   * first: the reverse of lifecycle order.
   * @param {string} type
   * @returns {string[]}
   */
  openStatusesOf(type) {
    return this.statusesOf(type)
      .filter((status) => !this.meets(type, status, 'done'))
      .reverse();
  }

  /**
   * The type's closed statuses (those that meet `done`), in lifecycle order.
   * @param {string} type
   * @returns {string[]}
   */
  closedStatusesOf(type) {
    return this.statusesOf(type).filter((status) => this.meets(type, status, 'done'));
  }

  /**
   * The statuses `isRunnable` accepts, in lifecycle order.
   * @param {string} type
   * @returns {string[]}
   */
  runnableStatusesOf(type) {
    return this.statusesOf(type).filter((status) => this.isRunnable(type, status));
  }

  /**
   * The statuses `isUnstarted` accepts, in lifecycle order.
   * @param {string} type
   * @returns {string[]}
   */
  unstartedStatusesOf(type) {
    return this.statusesOf(type).filter((status) => this.isUnstarted(type, status));
  }

  /**
   * Where `bl list` and `bl grep` sort a unit at `status`, lowest first: open
   * statuses that meet `in_progress`; the other open statuses together, an
   * unknown one among them since it meets nothing; then closed statuses (those
   * that meet `done`), in lifecycle order.
   * @param {string} type
   * @param {string} status
   * @returns {number}
   */
  listRankOf(type, status) {
    if (this.meets(type, status, 'done')) {
      return 2 + this.closedStatusesOf(type).indexOf(this.#known(type, status));
    }
    return this.meets(type, status, 'in_progress') ? 0 : 1;
  }

  /**
   * Whether a unit of `type` at `status` meets `wanted`: it is `wanted` or
   * comes after it in `statuses`. Terminal statuses come last, so one meets
   * every open status, and `superseded` meets `done` (F-66 A4). A v1 word
   * reads as its current one; an unknown `status` meets nothing.
   * @param {string} type
   * @param {string} status
   * @param {string} wanted
   * @returns {boolean}
   */
  meets(type, status, wanted) {
    const s = this.#known(type, status);
    const w = this.#known(type, wanted);
    if (s == null || w == null) return false;
    const { statuses } = this.typeOf(type);
    return statuses.indexOf(s) >= statuses.indexOf(w);
  }

  /**
   * Whether a unit of `type` at `status` is ready to run or already running: it
   * meets `refined` and does not meet `done`. An unknown `status` is neither.
   * @param {string} type
   * @param {string} status
   * @returns {boolean}
   */
  isRunnable(type, status) {
    return this.meets(type, status, 'refined') && !this.meets(type, status, 'done');
  }

  /**
   * Whether `status` is a status of `type` that does not meet `in_progress`. It
   * checks the status exists, since `!meets` alone accepts an unknown one.
   * @param {string} type
   * @param {string} status
   * @returns {boolean}
   */
  isUnstarted(type, status) {
    return this.#known(type, status) != null && !this.meets(type, status, 'in_progress');
  }

  /**
   * The row of `verb` in the type's table, or null when it has none.
   * @param {string} type
   * @param {string} verb
   * @returns {Verb | null}
   */
  verbOf(type, verb) {
    const { verbs } = this.typeOf(type);
    return Object.hasOwn(verbs, verb) ? verbs[verb] : null;
  }

  /**
   * The statuses a verb row starts from, `*` expanded.
   * @param {string} type
   * @param {Verb} row
   * @returns {string[]}
   */
  fromOf(type, row) {
    const { statuses, terminal } = this.typeOf(type);
    return row.from === ANY_OPEN ? statuses.filter((s) => !terminal.includes(s)) : [...row.from];
  }

  /**
   * `verb` and the verbs its branches' `then` reach, transitively, each once,
   * in the order they are first reached: `run`'s chain is `run`, `review`,
   * `fix`.
   * @param {string} type
   * @param {string} verb
   * @returns {string[]}
   */
  chainOf(type, verb) {
    const out = [verb];
    for (let i = 0; i < out.length; i++) {
      const row = this.verbOf(type, out[i]);
      for (const b of row ? [...row.success, ...row.failure] : []) {
        if (b.then && !out.includes(b.then)) out.push(b.then);
      }
    }
    return out;
  }

  /**
   * The statuses a verb enters on its nominal path (F-119 D6), each once, in
   * the order it enters them: the row's `during`, then each `success`
   * branch's `to`, and the same for the verb a success branch chains to with
   * `then`. A failure branch is no part of it. `run`'s is `in_progress`,
   * `in_review`, `ready_for_merge`; `[]` for a verb the type lacks. A verb
   * checks the holds on these statuses when it starts.
   * @param {string} type
   * @param {string} verb
   * @returns {string[]}
   */
  nominalPath(type, verb) {
    const out = [];
    const add = (status) => {
      if (status != null && !out.includes(status)) out.push(status);
    };
    const walked = new Set();
    const walk = (name) => {
      const row = this.verbOf(type, name);
      if (!row || walked.has(name)) return;
      walked.add(name);
      add(row.during);
      for (const b of row.success) {
        add(b.to);
        if (b.then) walk(b.then);
      }
    };
    walk(verb);
    return out;
  }

  /**
   * Every transition the type's table defines, once each: from each `from`
   * to the verb's `during` (none when they are equal: that records nothing),
   * and to each branch's `to`, from the `during` status when the verb has one
   * and from each `from` when it has none. A verb with an empty `from` (`new`)
   * gives edges `from: null`.
   * @param {string} type
   * @returns {Array<{ from: string | null, to: string, by: string }>}
   */
  edges(type) {
    const out = [];
    const seen = new Set();
    const add = (from, to, by) => {
      const key = `${from}\0${to}\0${by}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ from, to, by });
    };
    for (const [verb, row] of Object.entries(this.typeOf(type).verbs)) {
      const from = this.fromOf(type, row);
      const starts = from.length === 0 ? [null] : from;
      if (row.during != null) for (const f of starts) if (f !== row.during) add(f, row.during, verb);
      const sources = row.during != null ? [row.during] : starts;
      for (const b of [...row.success, ...row.failure]) for (const f of sources) add(f, b.to, verb);
    }
    return out;
  }
}

/**
 * @typedef {object} FlowWiring  what bl defines that `flow.json` names
 * @property {Map<string, Function>} guards        `guards.js`'s `GUARDS`
 * @property {Map<string, Function>} capabilities  `capabilities.js`'s `VIA_CAPABILITIES`
 * @property {Record<string, Record<string, string | null>>} dispatch  `verbs.js`'s `DISPATCH`
 */

/**
 * `bl validate`'s `flow-json` findings (F-66 D1, F-69 D1) on a flow `loadFlow`
 * could read. Errors: a `from`, `during`, `to` or terminal status the type
 * lacks; a `when` or `via` name bl does not register; a last `success` or
 * `failure` branch with a `when`; a `then` that is not a
 * verb of the type starting from the branch's `to`; a status no branch goes
 * to and no verb records as its `during`; a terminal status before an open one, or one a verb other than
 * `supersede` starts from; a verb bl dispatches for a type that the type's
 * table lacks. Warnings: a v1 file; a type with a `gates` table (F-119 D4).
 * @param {Flow} flow
 * @param {FlowWiring} wiring
 * @param {string} location  the file, relative to the backlog root
 * @returns {Array<{ severity: "error" | "warning", code: "flow-json", message: string, location: string }>}
 */
export function findFlowFindings(flow, wiring, location = FLOW_FILE) {
  const findings = [];
  const add = (message, severity = 'error') =>
    findings.push({
      severity,
      code: 'flow-json',
      message: `${message.replace(/\.$/, '')}. See ${FLOW_DOC}.`,
      location,
    });
  if (flow.legacy) {
    add(
      `${location} is ${LEGACY_FLOW_SCHEMA}; bl reads it as its ${FLOW_SCHEMA} template. ` +
        `Run node ${MIGRATION_SCRIPT} to rewrite the backlog.`,
      'warning',
    );
  }
  const guardRegistered = (name) => wiring.guards.has(name.split(':')[0]);
  for (const [type, def] of Object.entries(flow.types)) {
    const isStatus = (s) => def.statuses.includes(s);
    const notStatus = (what, s) => add(`${type} ${what} "${s}", which is not a ${type} status`);
    for (const t of def.terminal.filter((s) => !isStatus(s))) notStatus('terminal names', t);
    const firstTerminal = Math.min(...def.terminal.filter(isStatus).map((s) => def.statuses.indexOf(s)));
    for (const s of def.statuses.slice(firstTerminal).filter((x) => !def.terminal.includes(x))) {
      add(`${type} status "${s}" comes after a terminal status; terminal statuses come last in "statuses"`);
    }
    const reached = new Set();
    for (const [verb, row] of Object.entries(def.verbs)) {
      const at = `${type} verb "${verb}"`;
      if (row.from !== ANY_OPEN) {
        for (const f of row.from.filter((s) => !isStatus(s))) notStatus(`verb "${verb}" starts from`, f);
        for (const f of row.from.filter((s) => def.terminal.includes(s) && verb !== 'supersede')) {
          add(`${at} starts from terminal status "${f}"; only supersede may`);
        }
      }
      if (row.during != null) {
        reached.add(row.during);
        if (!isStatus(row.during)) notStatus(`verb "${verb}" records during`, row.during);
      }
      for (const g of row.when.filter((n) => !guardRegistered(n))) {
        add(`${at} checks guard "${g}", which bl does not register (bl/src/guards.js)`);
      }
      for (const c of row.via.filter((n) => !wiring.capabilities.has(n))) {
        add(`${at} runs capability "${c}", which bl does not register (bl/src/capabilities.js)`);
      }
      for (const [outcome, branches] of [
        ['success', row.success],
        ['failure', row.failure],
      ]) {
        // When no guard holds, bl has no branch to record (`requireBranch`).
        if (branches.at(-1)?.when.length > 0) {
          add(`${at} has a "when" on its last ${outcome} branch; the last branch must hold always`);
        }
        for (const b of branches) {
          reached.add(b.to);
          if (!isStatus(b.to)) notStatus(`verb "${verb}" goes on ${outcome} to`, b.to);
          for (const g of b.when.filter((n) => !guardRegistered(n))) {
            add(`${at} checks guard "${g}" on ${outcome}, which bl does not register (bl/src/guards.js)`);
          }
          if (b.then == null) continue;
          const next = flow.verbOf(type, b.then);
          if (!next) add(`${at} chains on ${outcome} to "${b.then}", which is not a ${type} verb`);
          else if (!flow.fromOf(type, next).includes(b.to)) {
            add(`${at} chains on ${outcome} to "${b.then}", which does not start from "${b.to}"`);
          }
        }
      }
    }
    for (const s of def.statuses.filter((x) => !reached.has(x))) {
      add(`${type} status "${s}" is no branch's "to" and no verb's "during"; no verb reaches it`);
    }
    for (const [verb, kinds] of Object.entries(wiring.dispatch)) {
      if (READ_VERBS.includes(verb) || !kinds[type] || flow.verbOf(type, verb)) continue;
      add(`bl dispatches "${verb}" for a ${type}, and the ${type} table has no "${verb}" verb`);
    }
    if (flow.gateTables.includes(type)) {
      add(
        `${type} has a "gates" table, which bl no longer reads; remove it: a hold can gate any ${type} status`,
        'warning',
      );
    }
  }
  return findings;
}
