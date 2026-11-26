/**
 * cel.js — the CEL environment of conditions, views and `list --where`
 * (F-136 D6), with `@marcbachmann/cel-js` (D-495) and optional types on
 * (D-496).
 *
 * The record schema (`schemas/record.schema.json`) gives the types: each
 * `$defs` entry is a registered class, and each top-level property of
 * `Record` is a variable. One schema walker (`shapeOf`) serves both
 * `celTypeOf`, the CEL type of a schema node, and `toCelValue`, a JSON value
 * as CEL takes it. The library does not convert plain objects nested in maps
 * or returned by functions into a registered type, so `toCelValue` makes the
 * class instances itself (the spike's workaround, D-495).
 *
 * Two kinds of environment share one set of declarations:
 *
 *   - `celEnvironment(inputs)` type-checks; its function handlers throw
 *     `not bound: <name>`;
 *   - `bindCel(inputs, handlers)` evaluates, with the caller's handlers. The
 *     library passes a handler only its arguments, so a handler that needs
 *     the current item is a closure that the caller makes per item.
 *
 * `inputs` is `{ predicates }`: a map from a shop predicate's name to its
 * command template (steps.md, "Plugins", D-481).
 */

import { Environment } from '@marcbachmann/cel-js';
import Mustache from 'mustache';
import RECORD_SCHEMA from './schemas/record.schema.json' with { type: 'json' };

/**
 * @typedef {object} CelInputs
 * @property {Record<string, string>} predicates  predicate name → its command template
 */

/** @typedef {Record<string, any>} SchemaNode */

const DEFS = RECORD_SCHEMA.$defs;
const DEF_REF = '#/$defs/';
const RECORD_REF = { $ref: `${DEF_REF}Record` };
const BOOL = { type: 'boolean' };
const TIMESTAMP = 'google.protobuf.Timestamp';

/** A map's values, each through `f`. */
const mapValues = (object, f) => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, f(v)]));

/** The base of the registered classes: an instance holds the fields it is given. */
class CelObject {
  /** @param {Record<string, unknown>} fields */
  constructor(fields) {
    Object.assign(this, fields);
  }
}

/** `$defs` name → its class, named as the entry. */
const CLASSES = new Map(Object.keys(DEFS).map((name) => [name, { [name]: class extends CelObject {} }[name]]));

/** The type of the `predicates` constant; each shop predicate is a receiver function on it. */
class Predicates {}

/**
 * The shape of a schema node, the one walk behind `celTypeOf` and
 * `toCelValue`. A `$ref` names a `$defs` entry of the record schema.
 * @param {SchemaNode} node
 * @returns {{ kind: 'ref', name: string } | { kind: 'list' | 'map', of: SchemaNode }
 *   | { kind: 'string' | 'timestamp' | 'int' | 'double' | 'bool' | 'dyn' }}
 */
function shapeOf(node) {
  if (node.$ref !== undefined) return { kind: 'ref', name: node.$ref.slice(DEF_REF.length) };
  switch (node.type) {
    case 'string':
      return { kind: node.format === 'date-time' ? 'timestamp' : 'string' };
    case 'integer':
      return { kind: 'int' };
    case 'number':
      return { kind: 'double' };
    case 'boolean':
      return { kind: 'bool' };
    case 'array':
      return { kind: 'list', of: node.items ?? {} };
    case 'object': {
      const values = node.additionalProperties;
      const typed = values !== null && typeof values === 'object';
      return typed && node.properties === undefined ? { kind: 'map', of: values } : { kind: 'dyn' };
    }
    default:
      // No type, several types, or a type that allows null.
      return { kind: 'dyn' };
  }
}

const SCALAR_TYPES = { string: 'string', timestamp: TIMESTAMP, int: 'int', double: 'double', bool: 'bool', dyn: 'dyn' };

/**
 * The CEL type of a schema node (D6): `string`, a `date-time` string as
 * `google.protobuf.Timestamp`, `int`, `double`, `bool`, `list<T>`, a `$ref`
 * as the `$defs` entry's name, an object with schema-typed
 * `additionalProperties` as `map<string, T>`, and anything else as `dyn`.
 * @param {SchemaNode} node
 * @returns {string}
 */
export function celTypeOf(node) {
  const shape = shapeOf(node);
  if (shape.kind === 'ref') return shape.name;
  if (shape.kind === 'list') return `list<${celTypeOf(shape.of)}>`;
  if (shape.kind === 'map') return `map<string, ${celTypeOf(shape.of)}>`;
  return SCALAR_TYPES[shape.kind];
}

/**
 * A `dyn` value as CEL takes it: each integer a `BigInt`, lists and objects
 * walked.
 * @param {unknown} value
 */
function dynValue(value) {
  if (Number.isInteger(value)) return BigInt(/** @type {number} */ (value));
  if (Array.isArray(value)) return value.map(dynValue);
  if (value !== null && typeof value === 'object') return mapValues(value, dynValue);
  return value;
}

/**
 * A JSON value as CEL takes it, by the schema node it has: an integer
 * becomes a `BigInt`, a `date-time` string a `Date`, and a named object an
 * instance of its class. `null` stays `null`.
 * @param {SchemaNode} node
 * @param {unknown} value
 * @returns {unknown}
 */
export function toCelValue(node, value) {
  if (value === null || value === undefined) return value;
  const shape = shapeOf(node);
  switch (shape.kind) {
    case 'ref': {
      const properties = DEFS[shape.name].properties;
      const Class = /** @type {typeof CelObject} */ (CLASSES.get(shape.name));
      return new Class(
        Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toCelValue(properties[k] ?? {}, v)])),
      );
    }
    case 'list':
      return /** @type {unknown[]} */ (value).map((v) => toCelValue(shape.of, v));
    case 'map':
      return mapValues(value, (v) => toCelValue(shape.of, v));
    case 'timestamp':
      return new Date(/** @type {string} */ (value));
    case 'int':
      return BigInt(/** @type {number} */ (value));
    case 'dyn':
      return dynValue(value);
    default:
      return value;
  }
}

/**
 * The functions of core.md's table ("Records and CEL"). `returns` is a
 * schema node, because `bindCel` converts each result by it.
 */
const FUNCTIONS = [
  { name: 'item', params: ['string'], returns: RECORD_REF },
  { name: 'children', params: ['string'], returns: { type: 'array', items: RECORD_REF } },
  { name: 'signed', params: ['string', 'string'], returns: BOOL },
  ...[
    'has_capacity',
    'has_terminal',
    'worktree_clean',
    'worktree_unchanged',
    'conflict_free',
    'item_valid',
    'graph_valid',
  ].map((name) => ({ name, params: [], returns: BOOL })),
];

/** The handler names `bindCel` takes: one per function, and `predicate` for the shop predicates. */
const HANDLER_NAMES = [...FUNCTIONS.map((fn) => fn.name), 'predicate'];

/** The Mustache token types that read a name. */
const NAME_TOKENS = new Set(['name', '&', '#', '^']);

/**
 * The number of parameters of a shop predicate: the number of distinct
 * `{{args.<n>}}` names that its command template reads, in sections too.
 * @param {string} template
 */
function predicateArity(template) {
  const names = new Set();
  const walk = (tokens) => {
    for (const [type, value, , , children] of tokens) {
      if (NAME_TOKENS.has(type) && /^args\.\d+$/.test(value)) names.add(value);
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(Mustache.parse(template));
  return names.size;
}

/**
 * An environment with every declaration of D6, its handlers from
 * `functionHandler` and `predicateHandler`.
 * @param {CelInputs} inputs
 * @param {(fn: (typeof FUNCTIONS)[number]) => Function} functionHandler
 * @param {(name: string) => Function} predicateHandler
 */
function environment({ predicates }, functionHandler, predicateHandler) {
  const env = new Environment({ enableOptionalTypes: true });
  for (const [name, def] of Object.entries(DEFS)) {
    env.registerType(name, { ctor: CLASSES.get(name), fields: mapValues(def.properties, celTypeOf) });
  }
  // A property whose name the library declares already (`type`) is read as `record.<name>`.
  for (const [name, node] of Object.entries(DEFS.Record.properties)) {
    if (!env.hasVariable(name)) env.registerVariable(name, celTypeOf(node));
  }
  env.registerVariable('record', 'Record').registerVariable('now', TIMESTAMP);
  for (const fn of FUNCTIONS) {
    env.registerFunction(`${fn.name}(${fn.params.join(', ')}): ${celTypeOf(fn.returns)}`, functionHandler(fn));
  }
  env.registerType('Predicates', Predicates).registerConstant('predicates', 'Predicates', new Predicates());
  for (const [name, template] of Object.entries(predicates)) {
    env.registerFunction({
      name,
      receiverType: 'Predicates',
      returnType: 'bool',
      params: Array.from({ length: predicateArity(template) }, (_, i) => ({ name: `arg${i}`, type: 'dyn' })),
      handler: predicateHandler(name),
    });
  }
  return env;
}

/** A handler that refuses to run. */
const notBound = (name) => () => {
  throw new Error(`not bound: ${name}`);
};

/**
 * The environment that type-checks: every declaration, and handlers that
 * throw `not bound: <name>`.
 * @param {CelInputs} inputs
 * @returns {Environment}
 */
export function celEnvironment(inputs) {
  return environment(
    inputs,
    (fn) => notBound(fn.name),
    (name) => notBound(`predicates.${name}`),
  );
}

/** A handler's result as CEL takes it, after the promise when it gives one. */
const celResult = (node, result) =>
  typeof result?.then === 'function' ? result.then((v) => toCelValue(node, v)) : toCelValue(node, result);

/**
 * An environment for evaluation, with the caller's handlers: one function
 * per declared name, which gets the call's arguments and may return plain
 * JSON, and `predicate(name, args)` for the shop predicates. A handler may be
 * async; evaluation then returns a promise.
 * @param {CelInputs} inputs
 * @param {Record<string, Function>} handlers
 * @returns {{ evaluate: (expr: string, record: Record<string, unknown>) => unknown }}
 */
export function bindCel(inputs, handlers) {
  const missing = HANDLER_NAMES.filter((name) => typeof handlers[name] !== 'function');
  const unknown = Object.keys(handlers).filter((name) => !HANDLER_NAMES.includes(name));
  const faults = [
    ...(missing.length > 0 ? [`missing handlers: ${missing.join(', ')}`] : []),
    ...(unknown.length > 0 ? [`unknown handlers: ${unknown.join(', ')}`] : []),
  ];
  if (faults.length > 0) throw new Error(`bindCel: ${faults.join('; ')}`);
  const env = environment(
    inputs,
    (fn) =>
      (...args) =>
        celResult(fn.returns, handlers[fn.name](...args)),
    (name) =>
      (_predicates, ...args) =>
        handlers.predicate(name, args),
  );
  /** @type {Map<string, Function>} */
  const parsed = new Map();
  return {
    /**
     * `expr` over `record` (plain JSON, as the record schema gives it), with
     * `now` the time of the call.
     */
    evaluate(expr, record) {
      if (!parsed.has(expr)) parsed.set(expr, env.parse(expr));
      const value = /** @type {CelObject} */ (toCelValue(RECORD_REF, record));
      return /** @type {Function} */ (parsed.get(expr))({ ...value, record: value, now: new Date() });
    },
  };
}

/** The fixed record of the self-test. */
const SELF_TEST_RECORD = {
  item_id: 'S-1',
  type: 'story',
  title: 'self-test',
  unit: 'S-1',
  id_prefix: 'S',
  id_number: 1,
  status: 'review',
  run: '',
  status_since: '2026-01-01T00:00:00Z',
  attributes: {},
  attribute_list: [],
  parents: {},
  sections: {},
  body: '',
  path: '',
  dir: '',
  rank: null,
  counters: { x: { value: 1, threshold: 2 } },
  findings: [{ id: 'R1-1', round: 1, category: 'Nit', text: '', file: '', state: 'open' }],
  deferred: [],
  checkboxes: {},
  gates: [],
  change: '',
};

/** The stub handlers of the self-test: `item` and `children` give the fixed record, the rest `true`. */
const SELF_TEST_HANDLERS = {
  ...Object.fromEntries(HANDLER_NAMES.map((name) => [name, () => true])),
  item: () => SELF_TEST_RECORD,
  children: () => [{ ...SELF_TEST_RECORD, closed: true }],
};

/**
 * The self-test at load ("Libraries": "A self-test at load covers the type
 * names, nested objects and predicates"): fixed expressions on the fixed
 * record through an environment with stub handlers. Each shop predicate is
 * called once.
 * @param {CelInputs} inputs
 * @throws {Error} `CEL self-test: <expression>: <the error>` on the first failure
 */
export function celSelfTest(inputs) {
  const cases = [
    ['type(status_since) == google.protobuf.Timestamp', true],
    ['counters.x.value < counters.x.threshold', true],
    ['findings.exists(f, f.state == "open" && f.round == 1)', true],
    ['attributes.?owner.orValue("none")', 'none'],
    ['item(unit).counters.x.value', 1n],
    ['children("story").all(c, c.closed)', true],
    ...Object.entries(inputs.predicates).map(([name, template]) => [
      `predicates.${name}(${Array(predicateArity(template)).fill('""').join(', ')})`,
      true,
    ]),
  ];
  const bound = bindCel(inputs, SELF_TEST_HANDLERS);
  for (const [expr, want] of cases) {
    let got;
    try {
      got = bound.evaluate(expr, SELF_TEST_RECORD);
    } catch (err) {
      throw new Error(`CEL self-test: ${expr}: ${String(err.message).split('\n')[0]}`);
    }
    if (got !== want) throw new Error(`CEL self-test: ${expr}: gave ${String(got)}, not ${String(want)}`);
  }
}
