/**
 * derive.js — the checks of one item type's flat flow, and the statuses
 * derived from it (F-139 D5).
 *
 *   - `checkFlow(type, flow, env)` gives the faults of the flat graph: a
 *     missing arrow (D-26, D-27), a status that the item type does not have
 *     on an arrow, in an entry's `from` or as `initial`, an entry `start` that
 *     is no box (D-45, D-54), and a property that compares `status` with a
 *     literal that is not a status (D-40).
 *   - `deriveStatuses(flow)` writes each arrow's derived `from` (D-45) and the
 *     flow's terminal statuses (D-65) on the flow.
 *
 * `buildFlowSet` (`flow-set.js`) calls both for each item type. The arrow
 * targets (a `next` to no box, `stop` in a subflow, `return` in a flow, a
 * `return:` whose caller has no arrow) are `flow-set.js`'s faults, because
 * the flattening removes the nesting they need; such an arrow is `null` here,
 * and counts as present.
 */

import { pointerToken } from '../config/files.js';

/** @typedef {import('../config/files.js').Fault} Fault */
/** @typedef {import('./flow-set.js').Flow} Flow */

/** A node of the parse tree of `@marcbachmann/cel-js` (`env.parse(expr).ast`). */
/** @typedef {{ op: string, args: unknown }} CelNode */

/** @type {(node: any) => boolean} the variable `status` */
const isStatus = (node) => node?.op === 'id' && node.args === 'status';
/** @type {(node: any) => boolean} a string literal */
const isString = (node) => node?.op === 'value' && typeof node.args === 'string';

/**
 * The string literals that `ast` compares `status` with: `status == "x"`,
 * `"x" != status` and `status in ["x", "y"]`, anywhere in the expression.
 * @param {unknown} ast
 * @returns {Generator<string>}
 */
function* statusLiterals(ast) {
  if (Array.isArray(ast)) {
    for (const node of ast) yield* statusLiterals(node);
    return;
  }
  if (ast === null || typeof ast !== 'object') return;
  const node = /** @type {CelNode} */ (ast);
  const [a, b] = Array.isArray(node.args) ? node.args : [];
  if (node.op === '==' || node.op === '!=') {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      if (isStatus(x) && isString(y)) yield y.args;
    }
  }
  if (node.op === 'in' && isStatus(a) && b?.op === 'list') {
    for (const item of b.args) if (isString(item)) yield item.args;
  }
  yield* statusLiterals(node.args);
}

/**
 * The faults of the item type `type`'s flat flow (D5 steps 1, 2 and 5). A
 * fault names the file and the JSON pointer of what the configuration
 * writes. A subflow's box or arrow is checked in each item type whose flow
 * calls it; its fault names the item type, so the same fault from two copies
 * of one subflow in one flow is one line.
 * @param {string} type  the item type
 * @param {Flow} flow
 * @param {import('@marcbachmann/cel-js').Environment} env  the CEL environment that parses the properties
 * @returns {Fault[]}
 */
export function checkFlow(type, flow, env) {
  /** @type {Fault[]} */
  const faults = [];
  /** @type {(source: { file: string, path: string }, suffix: string, rule: string, message: string) => void} */
  const fault = (source, suffix, rule, message) =>
    faults.push({ file: source.file, path: source.path + suffix, rule, message });
  const hasStatus = (status) => Object.hasOwn(flow.statuses, status);
  const notStatus = (status) => `'${status}' is not a status of the item type '${type}'`;

  // 1. arrows (D-26, D-27), and 2. the statuses they set (D-45).
  for (const node of Object.values(flow.nodes)) {
    for (const outcome of node.outcomes) {
      if (!Object.hasOwn(node.arrows, outcome)) {
        fault(node.source, '', 'arrow', `no ${outcome} arrow: the step '${node.step}' can end with ${outcome}`);
      }
    }
    for (const arrow of Object.values(node.arrows)) {
      if (arrow?.status !== undefined && !hasStatus(arrow.status))
        fault(arrow.source, '/status', 'status', notStatus(arrow.status));
    }
  }

  // 2. initial and the entries (D-45, D-54).
  if (!hasStatus(flow.initial)) fault(flow.source, '/initial', 'status', notStatus(flow.initial));
  for (const [name, entry] of Object.entries(flow.entries)) {
    const path = `/entries/${pointerToken(name)}`;
    entry.from.forEach((status, i) => {
      if (!hasStatus(status)) fault(flow.source, `${path}/from/${i}`, 'status', notStatus(status));
    });
    if (!Object.hasOwn(flow.nodes, entry.start))
      fault(flow.source, `${path}/start`, 'entry', `'${entry.start}' names no box of the flow '${type}'`);
  }

  // 5. properties (D-40).
  for (const [name, expr] of Object.entries(flow.properties)) {
    for (const literal of new Set(statusLiterals(env.parse(expr).ast))) {
      if (!hasStatus(literal))
        fault(
          flow.source,
          `/properties/${pointerToken(name)}`,
          'property',
          `compares status with ${notStatus(literal)}`,
        );
    }
  }
  return faults;
}

/**
 * Writes each arrow's `from` and the flow's `terminal` (D5 steps 3 and 4).
 *
 * `from` (D-45): a walk of the flat graph from each entry's start node
 * carries the set of statuses the item can hold, starting with the entry's
 * `from`. An arrow with a `status` passes on only that status; one without
 * passes on its node's set. The walk repeats until no set grows. An arrow's
 * `from` is the set at its source node, in the order of the flow's
 * `statuses`; an arrow that no entry reaches has an empty `from`.
 *
 * `terminal` (D-65): a status is terminal when no arrow has it in its `from`
 * with a different `status`. `closed` means terminal.
 * @param {Flow} flow
 */
export function deriveStatuses(flow) {
  /** @type {Map<string, Set<string>>} node id → the statuses the item can hold there */
  const held = new Map(Object.keys(flow.nodes).map((id) => [id, new Set()]));
  /** @type {string[]} the nodes whose set grew */
  const grown = [];
  const add = (id, statuses) => {
    const set = held.get(id);
    if (set === undefined) return; // `stop`, or a start that is a fault
    const size = set.size;
    for (const status of statuses) set.add(status);
    if (set.size > size) grown.push(id);
  };
  for (const entry of Object.values(flow.entries)) add(entry.start, entry.from);
  while (grown.length > 0) {
    const id = /** @type {string} */ (grown.pop());
    const set = /** @type {Set<string>} */ (held.get(id));
    for (const arrow of Object.values(flow.nodes[id].arrows)) {
      if (arrow !== null) add(arrow.next, arrow.status === undefined ? [...set] : [arrow.status]);
    }
  }

  const order = Object.keys(flow.statuses);
  /** @type {Set<string>} the statuses that an arrow takes the item out of */
  const left = new Set();
  for (const [id, node] of Object.entries(flow.nodes)) {
    const set = /** @type {Set<string>} */ (held.get(id));
    for (const arrow of Object.values(node.arrows)) {
      if (arrow === null) continue;
      arrow.from = order.filter((status) => set.has(status));
      if (arrow.status !== undefined) for (const status of arrow.from) if (status !== arrow.status) left.add(status);
    }
  }
  flow.terminal = order.filter((status) => !left.has(status));
}
