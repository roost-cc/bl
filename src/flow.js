/**
 * flow.js — the backlog's `flow.json` (F-66 D1): every status of each unit
 * type, what each status implies, and the gates a type can be held at.
 *
 *   {
 *     "schema": "bl-flow/v1",
 *     "types": {
 *       "story": {
 *         "statuses": { "backlog": { "implies": [] }, "done": { "implies": ["backlog"] } },
 *         "gates": { "run": { "verbs": ["run", "implement"] } }
 *       }
 *     }
 *   }
 *
 * A status meets `X` when it is `X` or lists `X` in `implies`. `implies` is
 * written in full, never derived: `findFlowFindings` (`bl validate`'s
 * `flow-json`) checks it is closed and names only statuses of its type, and
 * that every gate verb is one bl checks. `loadFlow` fails loud on a file the
 * helpers cannot read at all: missing, not JSON, a wrong `schema`, a type bl
 * needs missing, or a shape that is not the one above.
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';

/** The file's name, at the backlog root. */
export const FLOW_FILE = 'flow.json';

export const FLOW_SCHEMA = 'bl-flow/v1';

/** The types every backlog's flow names: `task` since F-65 (D1). */
export const FLOW_TYPES = ['story', 'feature', 'task'];

/** The verbs bl checks a gate at (F-66 D3); any other is `flow-json`. */
export const GATE_VERBS = ['run', 'implement', 'merge'];

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

export function flowPath(backlogRoot) {
  return join(backlogRoot, FLOW_FILE);
}

/**
 * Read `<backlogRoot>/flow.json`. Throws `FlowError` when it is missing,
 * unparsable, of a wrong schema, lacks a type in `FLOW_TYPES`, or has a
 * `statuses` or `gates` of the wrong shape.
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
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FlowError(path, `not valid JSON (${err.message})`);
  }
  const flow = new Flow(path, raw);
  cache.set(path, { key, flow });
  return flow;
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

export class Flow {
  /**
   * @param {string} path  the file, for messages
   * @param {any} raw      its parsed JSON
   */
  constructor(path, raw) {
    this.path = path;
    if (!isObject(raw)) throw new FlowError(path, 'not a JSON object');
    if (raw.schema !== FLOW_SCHEMA) {
      throw new FlowError(path, `"schema" is ${JSON.stringify(raw.schema)}, not "${FLOW_SCHEMA}"`);
    }
    if (!isObject(raw.types)) throw new FlowError(path, `"types" is not an object`);
    for (const type of FLOW_TYPES) {
      if (!Object.hasOwn(raw.types, type)) throw new FlowError(path, `no "${type}" type in "types"`);
    }
    for (const [type, def] of Object.entries(raw.types)) {
      const at = `type "${type}"`;
      if (!isObject(def)) throw new FlowError(path, `${at} is not an object`);
      if (!isObject(def.statuses) || Object.keys(def.statuses).length === 0) {
        throw new FlowError(path, `${at} has no "statuses" object`);
      }
      for (const [status, s] of Object.entries(def.statuses)) {
        if (!isObject(s) || !isStringList(s.implies)) {
          throw new FlowError(path, `${at} status "${status}" has no "implies" list of statuses`);
        }
      }
      if (!isObject(def.gates)) throw new FlowError(path, `${at} has no "gates" object`);
      for (const [gate, g] of Object.entries(def.gates)) {
        if (!isObject(g) || !isStringList(g.verbs) || g.verbs.length === 0) {
          throw new FlowError(path, `${at} gate "${gate}" has no "verbs" list`);
        }
      }
    }
    /** @type {Record<string, { statuses: Record<string, { implies: string[] }>, gates: Record<string, { verbs: string[] }> }>} */
    this.types = raw.types;
  }

  /** The type's definition, or a `FlowError` when the flow has no such type. */
  typeOf(type) {
    const def = Object.hasOwn(this.types, type) ? this.types[type] : null;
    if (!def) throw new FlowError(this.path, `no "${type}" type in "types"`);
    return def;
  }

  /**
   * The type's statuses, in the file's order.
   * @param {string} type
   * @returns {string[]}
   */
  statusesOf(type) {
    return Object.keys(this.typeOf(type).statuses);
  }

  /**
   * The type's open statuses (those that do not meet `done`), furthest along
   * first: most `implies` entries first, since `bl validate` keeps `implies`
   * closed but does not check the file's order. Ties keep the file's order.
   * @param {string} type
   * @returns {string[]}
   */
  openStatusesOf(type) {
    const { statuses } = this.typeOf(type);
    return this.statusesOf(type)
      .filter((status) => !this.meets(type, status, 'done'))
      .sort((a, b) => statuses[b].implies.length - statuses[a].implies.length);
  }

  /**
   * Where `bl list` and `bl grep` sort a unit at `status`, lowest first: open
   * statuses that meet `in_progress`; the other open statuses together, an
   * unknown one among them since it meets nothing; then closed statuses (those
   * that meet `done`), in the file's order.
   * @param {string} type
   * @param {string} status
   * @returns {number}
   */
  listRankOf(type, status) {
    if (this.meets(type, status, 'done')) {
      return (
        2 +
        this.statusesOf(type)
          .filter((s) => this.meets(type, s, 'done'))
          .indexOf(status)
      );
    }
    return this.meets(type, status, 'in_progress') ? 0 : 1;
  }

  /**
   * Whether a unit of `type` at `status` meets `wanted`: it is `wanted` or
   * lists it in `implies`. An unknown `status` meets nothing.
   * @param {string} type
   * @param {string} status
   * @param {string} wanted
   * @returns {boolean}
   */
  meets(type, status, wanted) {
    const { statuses } = this.typeOf(type);
    // `hasOwn` coerces its key: frontmatter's `[superseded]` is no status.
    if (typeof status !== 'string' || !Object.hasOwn(statuses, status)) return false;
    return status === wanted || statuses[status].implies.includes(wanted);
  }

  /**
   * The type's gates: each name with the verbs that check it.
   * @param {string} type
   * @returns {Record<string, string[]>}
   */
  gatesOf(type) {
    const { gates } = this.typeOf(type);
    return Object.fromEntries(Object.entries(gates).map(([gate, g]) => [gate, [...g.verbs]]));
  }
}

/**
 * `bl validate`'s `flow-json` findings (F-66 D1) on a flow `loadFlow` could
 * read: an `implies` that names a status its type lacks, or that is not
 * closed (A implies B, B implies C, A does not list C); a gate verb bl does
 * not check.
 * @param {Flow} flow
 * @param {string} location  the file, relative to the backlog root
 * @returns {Array<{ severity: "error", code: "flow-json", message: string, location: string }>}
 */
export function findFlowFindings(flow, location = FLOW_FILE) {
  const findings = [];
  const add = (message) => findings.push({ severity: 'error', code: 'flow-json', message, location });
  for (const [type, def] of Object.entries(flow.types)) {
    for (const [status, { implies }] of Object.entries(def.statuses)) {
      for (const implied of implies) {
        if (!Object.hasOwn(def.statuses, implied)) {
          add(`${type} status "${status}" implies "${implied}", which is not a ${type} status`);
          continue;
        }
        // An unknown `next` is reported on its own status's line.
        const missing = def.statuses[implied].implies.filter(
          (next) => next !== status && !implies.includes(next) && Object.hasOwn(def.statuses, next),
        );
        for (const next of missing) {
          add(`${type} status "${status}" implies "${implied}", which implies "${next}"; list "${next}" too`);
        }
      }
    }
    for (const [gate, { verbs }] of Object.entries(def.gates)) {
      for (const verb of verbs.filter((v) => !GATE_VERBS.includes(v))) {
        add(`${type} gate "${gate}" names verb "${verb}"; bl checks gates only at ${GATE_VERBS.join(', ')}`);
      }
    }
  }
  return findings;
}
