/**
 * check.js — the shape check, the `cel` keyword and the fault report
 * (F-136 D5).
 *
 *   - `shapeChecker()`: one ajv instance per load (`strict`, `allErrors`, no
 *     defaults). Its `compile(schema)` gives a check of one layered result,
 *     whose faults name the file and the path of the layer that holds the
 *     failing value, and which records each string that the schema marks with
 *     `cel`.
 *   - `compileCel(recorded, env)`: the cross-check after the shape check
 *     (graphs.md, D-622): each recorded string type-checks in the CEL
 *     environment, to the marked type.
 *   - `ConfigurationFaults`: every fault of a load, sorted, one line each.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import { isAbsolute, relative, sep } from 'path';
import { pointerToken } from './layers.js';

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
const tokensOf = (pointer) =>
  pointer === ''
    ? []
    : pointer
        .slice(1)
        .split('/')
        .map((t) => t.replaceAll('~1', '/').replaceAll('~0', '~'));

/** How many leading tokens of `tokens` the patch holds. */
function depthIn(patch, tokens) {
  let value = patch;
  let depth = 0;
  for (const token of tokens) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)) break;
    value = value[token];
    depth++;
  }
  return depth;
}

/**
 * The file and the path, as that file writes it, of the value at `path` in
 * the result of `layers` (D5). The layer that holds the most of the path
 * wins, and the highest of those: a lower layer that holds the whole path
 * gave the value, though a higher one holds a prefix and merged beside it.
 * When no layer holds even the first token (a required key that nobody set),
 * the lowest layer's file is named.
 * @param {string} path  a JSON pointer into the layered result
 * @param {Layer[]} layers  lowest first; at least one
 * @returns {{ file: string, path: string }}
 */
export function attribute(path, layers) {
  const tokens = tokensOf(path);
  let best = null;
  let bestDepth = 0;
  for (const layer of layers) {
    const depth = depthIn(layer.patch, tokens);
    // Every layer holds the root; for any other path, a layer must hold the first token.
    if (depth >= bestDepth && (depth > 0 || tokens.length === 0)) {
      best = layer;
      bestDepth = depth;
    }
  }
  best ??= layers[0];
  return { file: best.file, path: best.pointer + path };
}

/** The failing path of an ajv error: for `required` and `additionalProperties`, with the property. */
function errorPath(error) {
  const property = error.params.missingProperty ?? error.params.additionalProperty;
  return property === undefined ? error.instancePath : `${error.instancePath}/${pointerToken(property)}`;
}

/**
 * The shape checker of one load: one ajv instance, with the `cel` keyword.
 * @returns {{ compile: (schema: Record<string, unknown>) =>
 *   (result: unknown, layers: Layer[]) => { faults: Fault[], cel: CelString[] } }}
 */
export function shapeChecker() {
  /** @type {{ path: string, expr: string, type: 'bool'|'dyn' }[]} */
  let recorded = [];
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
  ajv.addKeyword({
    keyword: 'cel',
    schemaType: 'string',
    metaSchema: { enum: CEL_TYPES },
    validate: (type, data, _parent, cxt) => {
      if (typeof data === 'string') recorded.push({ path: cxt?.instancePath ?? '', expr: data, type });
      return true;
    },
  });
  return {
    compile(schema) {
      const validate = ajv.compile(schema);
      return (result, layers) => {
        recorded = [];
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
