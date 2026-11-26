/**
 * view-cel.js — the view environment, the one place that evaluates view CEL
 * (F-138 D5, Decision A5).
 *
 * A view's CEL is checked by name, not by type: each top-level property name
 * of the op's output schema is a variable of type `dyn`, beside `record`
 * (`dyn`) and `records` (`list<dyn>`). The start check passes each view
 * expression to F-136's `compileCel` with this environment; the renderer
 * evaluates in the same environment, and a failed evaluation gives
 * `undefined` (D-466, D-468, D-476).
 */

import { Environment } from '@marcbachmann/cel-js';
import { toCelValue } from '../config/cel.js';

/** An untyped schema node: `toCelValue` makes each integer a `BigInt` and walks lists and objects. */
const UNTYPED = {};

/**
 * The view environment of an op's output schema.
 * @param {{ properties?: Record<string, unknown> }} schema  the JSON Schema of one output record
 * @returns {Environment}
 */
export function viewEnvironment(schema) {
  const env = new Environment({ enableOptionalTypes: true })
    .registerVariable('record', 'dyn')
    .registerVariable('records', 'list<dyn>');
  // A property whose name is declared already (`type`, `record`, `records`) is read as `record.<name>`.
  for (const name of Object.keys(schema.properties ?? {})) {
    if (!env.hasVariable(name)) env.registerVariable(name, 'dyn');
  }
  return env;
}

/**
 * The variables of an expression over one record: its top-level fields and
 * `record`. A field named `records` is read as `record.records` only.
 */
export function recordVars(record) {
  const value = /** @type {Record<string, unknown>} */ (toCelValue(UNTYPED, record));
  const { records: _records, ...fields } = value;
  return { ...fields, record: value };
}

/** The variables of an expression over a record set: `records`. */
export const recordsVars = (records) => ({ records: toCelValue(UNTYPED, records) });

/** Each environment's parsed expressions, so a column parses once per render. */
const parsed = new WeakMap();

/**
 * `expr` in `env` with `vars` (from `recordVars` or `recordsVars`).
 * @param {Environment} env
 * @param {string} expr
 * @param {Record<string, unknown>} vars
 * @returns {unknown} the value, or `undefined` when the evaluation fails
 */
export function evaluate(env, expr, vars) {
  if (!parsed.has(env)) parsed.set(env, new Map());
  const cache = parsed.get(env);
  try {
    if (!cache.has(expr)) cache.set(expr, env.parse(expr));
    return cache.get(expr)(vars);
  } catch {
    return undefined;
  }
}
