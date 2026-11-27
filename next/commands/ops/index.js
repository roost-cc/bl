/**
 * ops/index.js — the op registry (F-138 D2).
 *
 * An op is an operation in `bl`'s code that a `commands.yaml` line names. It
 * gives records and never prints (architecture.md, "Op"); the command layer
 * prints them. F-138 registers no op: each later feature adds one line here.
 */

/**
 * @typedef {object} OpContext
 * @property {import('../../config/load.js').Configuration} config  the frozen configuration
 * @property {string} backlogDir  the backlog's root
 * @property {import('../../engine/flow-set.js').FlowSet} flowSet  the flow set, built once at start
 */

/**
 * @typedef {object} Op
 * @property {Record<string, Record<string, unknown>>} args  the option as it is
 *   typed (`--limit`, or a positional's name) → the options of `argparse`'s
 *   `add_argument`, by their own names (D-424)
 * @property {Record<string, unknown>} schema  the JSON Schema of one output record (D-461)
 * @property {string} [pattern]  the argument whose value is a search pattern (D-469)
 * @property {(args: Record<string, unknown>, ctx: OpContext) => unknown} run
 *   gives one record (a plain object) or a record set (an array or an async
 *   iterable), or a promise of one
 */

/** @type {Readonly<Record<string, Op>>} op name → op */
export const OPS = Object.freeze({});
