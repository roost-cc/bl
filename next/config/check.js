/**
 * check.js — the shape check, the `cel` keyword and the fault report
 * (F-136 D5).
 *
 *   - `shapeChecker()`: one ajv instance per load (`strict`, `allErrors`, no
 *     defaults). Its `compile(schema)` gives a check of one layered result,
 *     whose faults name the file and the path of the layer that holds the
 *     failing value, and which records each string that the schema marks with
 *     `cel`, in a schema branch that accepts the value.
 *   - `compileCel(recorded, env)`: the cross-check after the shape check
 *     (graphs.md, D-622): each recorded string type-checks in the CEL
 *     environment, to the marked type.
 *   - `checkValue(schema, value)`: the same check of one value, for the files
 *     that the store writes (F-137 D9 item 3).
 *   - `ConfigurationFaults`: every fault of a load, sorted, one line each.
 */

import Ajv2020, { _ } from 'ajv/dist/2020.js';
import { isAbsolute, relative, sep } from 'path';
import { isMapping, pointerToken } from './files.js';

/** @typedef {import('./files.js').Fault} Fault */
/** @typedef {import('./layers.js').Layer} Layer */

/**
 * @typedef {object} CelString  one string that a schema marks with `cel`
 * @property {string} file  the file that writes it
 * @property {string} path  the JSON pointer as that file writes it
 * @property {string} expr  the CEL expression
 * @property {'bool'|'dyn'} type  the marked type: `bool` for a condition, `dyn` for any
 */

/** The values of the `cel` keyword. */
const CEL_TYPES = ['bool', 'dyn'];

/** The tokens of a JSON pointer (RFC 6901, section 4). */
export const tokensOf = (pointer) =>
  pointer === ''
    ? []
    : pointer
        .slice(1)
        .split('/')
        .map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'));

/**
 * The file and the path, as that file writes it, of the value at `path` in
 * the result of `layers` (D5). The layers are followed as JSON Merge Patch
 * applies them, lowest first: each prefix of the path belongs to the last
 * layer that wrote it, and the layer of the longest prefix that one owns is
 * named. A layer that holds a prefix as a mapping merges beside the values
 * below it, so a lower layer that holds more of the path keeps them. A layer
 * that holds a prefix as anything else (a list, a scalar, `null`) replaces
 * all below it, so no lower layer keeps a part of it. When no layer holds
 * even the first token (a required key that nobody set), the lowest layer's
 * file is named; the root belongs to the highest layer.
 * @param {string} path  a JSON pointer into the layered result
 * @param {Layer[]} layers  lowest first; at least one
 * @returns {{ file: string, path: string }}
 */
export function attribute(path, layers) {
  const tokens = tokensOf(path);
  /** @type {Layer[]} the layer that last wrote each prefix: index 0 for the first token */
  const owners = [];
  for (const layer of layers) {
    let value = layer.patch;
    for (let depth = 0; depth < tokens.length && isMapping(value) && Object.hasOwn(value, tokens[depth]); depth++) {
      value = value[tokens[depth]];
      owners[depth] = layer;
      if (!isMapping(value)) owners.length = depth + 1;
    }
  }
  const best = owners.at(-1) ?? (tokens.length === 0 ? layers.at(-1) : layers[0]);
  return { file: best.file, path: best.pointer + path };
}

/**
 * The failing path of an ajv error. An error about a key has the path of the
 * key: for `required`, `additionalProperties` and `unevaluatedProperties`
 * with the property; for `propertyNames` and each error of its subschema,
 * with the key it checks.
 */
function errorPath(error) {
  const property =
    error.params.missingProperty ??
    error.params.additionalProperty ??
    error.params.unevaluatedProperty ??
    error.params.propertyName ??
    error.propertyName;
  return property === undefined ? error.instancePath : `${error.instancePath}/${pointerToken(property)}`;
}

/**
 * The keyword that wraps a trial subschema (below). `compile` adds it; a
 * shipped schema does not write it.
 */
const TRIAL = 'x-bl-trial';

/**
 * The keyword that wraps each `propertyNames` subschema, so the `cel` keyword
 * knows that its data is a key, at any depth and through `$ref`. `compile`
 * adds it; a shipped schema does not write it.
 */
const KEY = 'x-bl-key';

/**
 * The keywords whose value is one subschema, a list of them, or a map of them:
 * every such keyword that ajv's 2020-12 draft knows, with its draft-07
 * `definitions` and `dependencies` (a map of subschemas and lists of names).
 */
const ONE = [
  'additionalProperties',
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const MAP = ['properties', 'patternProperties', 'dependentSchemas', 'dependencies', '$defs', 'definitions'];
/** Every keyword that `withTrials` walks into. */
export const SUBSCHEMA_KEYWORDS = [...ONE, ...LIST, ...MAP];

/**
 * The keywords whose subschemas are trials: a subschema that fails there does
 * not fail the schema that holds it (a rejected `anyOf` or `oneOf` branch, an
 * `if`, a `contains` that an item does not match, the subschema of a `not`).
 */
const TRIALS = new Set(['anyOf', 'oneOf', 'if', 'contains', 'not']);

/**
 * `schema` with each trial subschema, at any depth, wrapped as
 * `{ "x-bl-trial": <subschema> }`. The wrapper validates as its subschema, and
 * when that fails, it drops the CEL strings the subschema recorded: a string
 * counts only in a branch that accepts the value. Each `propertyNames`
 * subschema is wrapped as `{ "x-bl-key": <subschema> }` (`KEY`).
 * @param {unknown} schema
 * @returns {unknown}
 */
function withTrials(schema) {
  if (!isMapping(schema)) return schema;
  const out = { ...schema };
  const wrapper = (keyword) => (TRIALS.has(keyword) ? TRIAL : keyword === 'propertyNames' ? KEY : undefined);
  const sub = (keyword, value) =>
    wrapper(keyword) === undefined ? withTrials(value) : { [wrapper(keyword)]: withTrials(value) };
  for (const keyword of ONE) {
    if (Object.hasOwn(schema, keyword)) out[keyword] = sub(keyword, schema[keyword]);
  }
  for (const keyword of LIST) {
    if (Array.isArray(schema[keyword])) out[keyword] = schema[keyword].map((s) => sub(keyword, s));
  }
  for (const keyword of MAP) {
    if (isMapping(schema[keyword])) {
      out[keyword] = Object.fromEntries(Object.entries(schema[keyword]).map(([name, s]) => [name, withTrials(s)]));
    }
  }
  return out;
}

/** An ISO 8601 timestamp in UTC, in whole or fractional seconds. */
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * Whether `text` is an ISO 8601 timestamp in UTC that names a real moment,
 * for example `2026-11-14T13:08:57Z` or `2026-11-14T13:08:57.120Z`: the date
 * exists (no `2026-02-30`) and the clock is in range (no `24:00:00`, no leap
 * second). The schemas name it as `"format": "utc-timestamp"`.
 * @param {string} text
 */
export function isUtcTimestamp(text) {
  const match = UTC_TIMESTAMP.exec(text);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

/**
 * The shape checker of one load: one ajv instance, with the `cel` keyword
 * and the `utc-timestamp` format (`isUtcTimestamp`).
 * @returns {{ compile: (schema: Record<string, unknown>) =>
 *   (result: unknown, layers: Layer[]) => { faults: Fault[], cel: CelString[] } }}
 */
export function shapeChecker() {
  /** @type {{ path: string, expr: string, type: 'bool'|'dyn' }[]} */
  const recorded = [];
  /** How many `propertyNames` subschemas run now: above 0, the data is a key. */
  const keys = { depth: 0 };
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
  ajv.addFormat('utc-timestamp', { type: 'string', validate: isUtcTimestamp });
  ajv.addKeyword({
    keyword: 'cel',
    schemaType: 'string',
    metaSchema: { enum: CEL_TYPES },
    validate: (type, data, _parent, cxt) => {
      if (typeof data !== 'string') return true;
      const at = cxt?.instancePath ?? '';
      // Under `propertyNames`, `data` is a key and ajv gives its object's path.
      recorded.push({ path: keys.depth > 0 ? `${at}/${pointerToken(data)}` : at, expr: data, type });
      return true;
    },
  });
  ajv.addKeyword({
    keyword: TRIAL,
    schemaType: ['object', 'boolean'],
    // As `allOf` with one subschema; when it fails, `recorded` goes back to its length before it.
    code(cxt) {
      const { gen } = cxt;
      const list = gen.scopeValue('keyword', { ref: recorded });
      const mark = gen.const('celMark', _`${list}.length`);
      const valid = gen.name('valid');
      const sub = cxt.subschema({ keyword: TRIAL }, valid);
      gen.if(_`!${valid}`, () => gen.assign(_`${list}.length`, mark));
      cxt.ok(valid);
      cxt.mergeEvaluated(sub);
    },
  });
  ajv.addKeyword({
    keyword: KEY,
    schemaType: ['object', 'boolean'],
    // As `allOf` with one subschema, with `keys.depth` raised while it runs.
    code(cxt) {
      const { gen } = cxt;
      const ref = gen.scopeValue('keyword', { ref: keys });
      gen.code(_`${ref}.depth++`);
      const valid = gen.name('valid');
      const sub = cxt.subschema({ keyword: KEY }, valid);
      gen.code(_`${ref}.depth--`);
      cxt.ok(valid);
      cxt.mergeEvaluated(sub);
    },
  });
  return {
    compile(schema) {
      const validate = ajv.compile(/** @type {object} */ (withTrials(schema)));
      return (result, layers) => {
        recorded.length = 0;
        validate(result);
        const faults = (validate.errors ?? []).map((error) => ({
          ...attribute(errorPath(error), layers),
          rule: error.keyword,
          message: error.message ?? '',
        }));
        const cel = recorded.map(({ path, expr, type }) => ({ ...attribute(path, layers), expr, type }));
        return { faults, cel };
      };
    },
  };
}

/** The shape checker of `checkValue`, made at its first call, and each schema it compiled. */
let valueChecker;
/** @type {WeakMap<object, ReturnType<ReturnType<typeof shapeChecker>['compile']>>} */
const compiledValues = new WeakMap();

/**
 * The faults of `value` by `schema` (F-137 D9 item 3): the check of a file
 * that the store writes, with the ajv setup of a load (`shapeChecker`). Each
 * fault has the D5 shape, with `file` empty: the caller names the file. A
 * schema is compiled once, at its first check. A schema that ajv does not
 * compile (strict mode refuses an unknown format or keyword, it is no valid
 * JSON Schema, or a `$ref` does not resolve) gives every value one fault with
 * the rule `schema` and ajv's message: an attribute's `schema` comes from the
 * shop's item definition, and the configuration load does not compile it.
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @returns {Fault[]}
 */
export function checkValue(schema, value) {
  valueChecker ??= shapeChecker();
  let check = compiledValues.get(schema);
  if (check === undefined) {
    try {
      check = valueChecker.compile(schema);
    } catch (e) {
      const faults = [{ file: '', path: '', rule: 'schema', message: /** @type {Error} */ (e).message }];
      check = () => ({ faults, cel: [] });
    }
    compiledValues.set(schema, check);
  }
  return check(value, [{ file: '', pointer: '', patch: value }]).faults;
}

/**
 * The faults of the recorded CEL strings in `env`: a string that does not
 * compile, or whose type is not the marked one. A `dyn` mark takes any type.
 * @param {CelString[]} recorded
 * @param {import('@marcbachmann/cel-js').Environment} env
 * @returns {Fault[]}
 */
export function compileCel(recorded, env) {
  return recorded.flatMap(({ file, path, expr, type }) => {
    const checked = env.check(expr);
    const fault = (message) => [{ file, path, rule: 'cel', message }];
    if (!checked.valid) return fault(String(checked.error?.message).split('\n')[0]);
    if (type !== 'dyn' && checked.type !== type) return fault(`the type is ${checked.type}, not ${type}`);
    return [];
  });
}

/**
 * A file as a fault names it: relative to the backlog when it is inside it,
 * else with `~` for `$HOME`, else whole.
 * @param {string} file  absolute
 * @param {string} backlogDir
 */
function shownFile(file, backlogDir) {
  const inBacklog = relative(backlogDir, file);
  if (inBacklog !== '' && inBacklog.split(sep)[0] !== '..' && !isAbsolute(inBacklog)) return inBacklog;
  const home = process.env.HOME;
  return home && file.startsWith(home + sep) ? `~${file.slice(home.length)}` : file;
}

/** The text of one fault. */
const lineOf = (f) => `${f.file}: ${f.path}: ${f.rule}: ${f.message}`;

/** Order by file, then path, then the rest of the line. */
const byFileAndPath = (a, b) =>
  a.file < b.file
    ? -1
    : a.file > b.file
      ? 1
      : a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : lineOf(a) < lineOf(b)
            ? -1
            : 1;

/**
 * Every configuration fault of a load. Its `faults` are sorted by file and
 * path with each repeat dropped (a shop fault shows in every scope), and its
 * message is one line per fault: `<file>: <path>: <rule>: <message>`.
 */
export class ConfigurationFaults extends Error {
  /**
   * @param {Fault[]} faults  their files absolute
   * @param {string} backlogDir
   */
  constructor(faults, backlogDir) {
    const shown = new Map(
      faults.map((f) => {
        const fault = { ...f, file: shownFile(f.file, backlogDir) };
        return [lineOf(fault), fault];
      }),
    );
    const sorted = [...shown.values()].sort(byFileAndPath);
    super(sorted.map(lineOf).join('\n'));
    this.name = 'ConfigurationFaults';
    /** @type {Fault[]} */
    this.faults = sorted;
  }
}
