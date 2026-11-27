/**
 * load.js — the one load of the configuration (F-136 D8).
 *
 * `loadConfiguration` reads every file of every kind, layers it per scope
 * (D4), checks each layered result against its kind's schema, compiles each
 * CEL string the schemas mark (D5), runs the CEL self-test (D6), and reads and
 * parses the partials (D7). It then throws `ConfigurationFaults` with every
 * fault, or returns the frozen configuration. Nothing reads a configuration
 * file after it returns (architecture.md, "Configuration loads once").
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import Mustache from 'mustache';
import { celEnvironment, celSelfTest } from './cel.js';
import { ConfigurationFaults, compileCel, shapeChecker } from './check.js';
import { readYaml } from './files.js';
import { applyLayers, bothAxes, reposLayers, scopesOf, whoAxis, whoEntries } from './layers.js';

/** @typedef {import('./kinds.js').Kind} Kind */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./layers.js').Source} Source */
/** @typedef {import('./files.js').Fault} Fault */

/**
 * The CEL inputs of every scope. F-140 gives the shop predicates
 * (`plugin_registry.predicates`) when it adds that key's schema; until then
 * there are none (D6).
 */
const CEL_INPUTS = Object.freeze({ predicates: Object.freeze({}) });

/**
 * @typedef {object} Configuration
 * @property {(repo: string|null) => any} scope  the result of the `both` kind
 *   for work in `repo`, or outside any repo with `null`; `undefined` for a repo
 *   that the merged `repos` map does not name
 * @property {(kind: string, name?: string) => any} file  the result of a `who`
 *   or `none` kind; for a directory kind, of its file `name` (`en.yaml`), and
 *   `undefined` for a name that neither directory holds
 * @property {(kind: string) => string[]} names  the file names of a directory
 *   kind, sorted: each name that `file` takes (the flow set reads every file
 *   of `config/flows/`, F-139 D4)
 * @property {(kind: string, name?: string|null) => readonly Layer[]|undefined} layers
 *   the layers of that same result, lowest first, so that a check after the
 *   load names a fault's file by `attribute` (F-138 D3); for the `both` kind,
 *   of the scope of the repo `name`, the top level with none or `null`
 * @property {(name: string) => string|undefined} partial  the text of a partial,
 *   `undefined` for a name that neither directory holds; `render` takes it (D7)
 * @property {import('./cel.js').CelInputs} celInputs  the inputs of `bindCel`
 */

const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const isDirectory = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * One file as a source: `null` when it is not there (no layer, D3) or does
 * not read, its faults then added to `faults`.
 * @param {string} path
 * @param {Fault[]} faults
 * @returns {Source}
 */
function readSource(path, faults) {
  if (!isFile(path)) return null;
  const read = readYaml(path);
  if ('faults' in read) {
    faults.push(...read.faults);
    return null;
  }
  return { file: path, value: read.value };
}

/**
 * The `.yaml` files of a directory kind's directory: file name → source.
 * A missing directory has none. The name of each file that does not read is
 * added to `broken`.
 * @param {string} dir
 * @param {Fault[]} faults
 * @param {Set<string>} broken
 * @returns {Record<string, Source>}
 */
function readDirectory(dir, faults, broken) {
  if (!isDirectory(dir)) return {};
  const names = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
  return Object.fromEntries(
    names.flatMap((name) => {
      const before = faults.length;
      const source = readSource(join(dir, name), faults);
      if (faults.length > before) broken.add(name);
      return source === null ? [] : [[name, source]];
    }),
  );
}

/**
 * The layered results of a kind to check: `[key, layers]`, the key a repo
 * name (or `null`) for a `both` kind, a file name for a directory kind, and
 * `null` for a file kind. A file that does not read leaves out each result
 * that it is a layer of, because checking the rest of that result would
 * report faults that are not there: for a directory kind, the entry of that
 * file name; for a file kind, every result.
 * @param {Kind} kind
 * @param {string} backlogDir
 * @param {string} operatorDir
 * @param {Fault[]} faults
 * @returns {[string|null, Layer[]][]}
 */
function unitsOf(kind, backlogDir, operatorDir, faults) {
  const shopPath = join(backlogDir, kind.shop);
  // A `none` kind is the shop's file alone (D4), whatever operator path it names.
  const operatorPath = kind.operator === undefined || kind.order === 'none' ? null : join(operatorDir, kind.operator);
  if (kind.shop.endsWith('/')) {
    const broken = new Set();
    const shop = readDirectory(shopPath, faults, broken);
    const operator = operatorPath === null ? {} : readDirectory(operatorPath, faults, broken);
    return Object.entries(whoEntries(shop, operator)).filter(([name]) => !broken.has(name));
  }
  const before = faults.length;
  const shop = readSource(shopPath, faults);
  const operator = operatorPath === null ? null : readSource(operatorPath, faults);
  if (faults.length > before) return [];
  // With no file at all, the result is `{}`, and a fault names the shop's file.
  const orEmpty = (layers) => (layers.length > 0 ? layers : [{ file: shopPath, pointer: '', patch: {} }]);
  if (kind.order === 'both') {
    return scopesOf(shop, operator).map((repo) => [
      repo,
      orEmpty([...reposLayers(shop, operator), ...bothAxes(shop, operator, repo)]),
    ]);
  }
  return [[null, orEmpty(whoAxis(shop, operator))]];
}

/** The suffix of a partial's file. */
const PARTIAL = '.mustache';

/**
 * The partials (D7): `config/partials/<name>.mustache`, which the operator's
 * `<operatorDir>/partials/<name>.mustache` replaces by name (D-441). Each file
 * is parsed with `Mustache.parse`, and a parse error is a fault with the file.
 * @param {string} backlogDir
 * @param {string} operatorDir
 * @param {Fault[]} faults
 * @returns {Map<string, string>} name → text
 */
function readPartials(backlogDir, operatorDir, faults) {
  const partials = new Map();
  for (const dir of [join(backlogDir, 'config', 'partials'), join(operatorDir, 'partials')]) {
    if (!isDirectory(dir)) continue;
    for (const name of readdirSync(dir)
      .filter((n) => n.endsWith(PARTIAL))
      .sort()) {
      const file = join(dir, name);
      if (!isFile(file)) continue;
      const text = readFileSync(file, 'utf8');
      try {
        Mustache.parse(text);
      } catch (error) {
        faults.push({ file, path: '', rule: 'mustache', message: error.message });
      }
      partials.set(name.slice(0, -PARTIAL.length), text);
    }
  }
  return partials;
}

/** `value` frozen all the way down. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The one load (D8).
 * @param {{ backlogDir: string, operatorDir: string, kinds: readonly Kind[] }} options
 * @returns {Configuration}
 * @throws {ConfigurationFaults} with every fault of every file
 */
export function loadConfiguration({ backlogDir, operatorDir, kinds }) {
  const checker = shapeChecker();
  const env = celEnvironment(CEL_INPUTS);
  /** @type {Fault[]} */
  const faults = [];
  /** @type {Map<string, Map<string|null, { result: unknown, layers: readonly Layer[] }>>} */
  const results = new Map();
  for (const kind of kinds) {
    const check = checker.compile(kind.schema);
    const kindResults = new Map();
    for (const [key, layers] of unitsOf(kind, backlogDir, operatorDir, faults)) {
      const result = applyLayers(layers);
      const checked = check(result, layers);
      // The cross-check runs after the shape check, and only on a result whose shape holds (D-622).
      faults.push(...(checked.faults.length > 0 ? checked.faults : compileCel(checked.cel, env)));
      kindResults.set(key, { result: deepFreeze(result), layers: deepFreeze(layers) });
    }
    results.set(kind.name, kindResults);
  }
  celSelfTest(CEL_INPUTS);
  const partials = readPartials(backlogDir, operatorDir, faults);
  if (faults.length > 0) throw new ConfigurationFaults(faults, backlogDir);

  const bothKind = kinds.find((kind) => kind.order === 'both');
  /** The loaded unit of a `who` or `none` kind, as `file` and `layers` take it. */
  const unitOf = (kind, name) => {
    const found = kinds.find((k) => k.name === kind && k.order !== 'both');
    if (found === undefined) throw new Error(`no who or none configuration kind: ${kind}`);
    return results.get(kind)?.get(name ?? null);
  };
  return Object.freeze({
    scope: (repo) => (bothKind === undefined ? undefined : results.get(bothKind.name)?.get(repo)?.result),
    file: (kind, name) => unitOf(kind, name)?.result,
    names: (kind) => {
      if (!kinds.some((k) => k.name === kind && k.shop.endsWith('/'))) {
        throw new Error(`no directory configuration kind: ${kind}`);
      }
      return [.../** @type {Map<string, unknown>} */ (results.get(kind)).keys()].sort();
    },
    layers: (kind, name) =>
      kind === bothKind?.name ? results.get(kind)?.get(name ?? null)?.layers : unitOf(kind, name)?.layers,
    partial: (name) => partials.get(name),
    celInputs: CEL_INPUTS,
  });
}
