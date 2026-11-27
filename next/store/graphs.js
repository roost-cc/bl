/**
 * graphs.js — the graphs of a backlog (F-148 D1, D2, D5, D6, D7): their
 * configuration, their files, the read, the text and the schema check of each
 * file, the check runner of a store write (`checkGraphs`), the three-way
 * merge of a file (`mergeGraph`), and the work unit of an item (`workUnit`).
 *
 * `backlog.yaml` lists the graphs, each with its `name`, its `engine` and the
 * item types of its `nodes`. A graph's file is `graphs/<name>.json` at the
 * backlog's root; a missing file is the engine's `empty`. Each engine module
 * (`engines/`) gives the same shape: `schema`, `empty`, `canonical(value)`,
 * `changed(before, after)`, the keys of the value that changed,
 * `names(value, id)`, the ids that the entry of `id` names, `kind(value)`, the
 * faults of the whole file, and `check(value, ids, ctx, unitOf)`, the faults
 * of the entries of `ids` by the engine's per-item rules, `unitOf(id)` the
 * work unit of an item (`workUnit`), and `merge(base, ours, theirs)`, the
 * three-way merge of three values, or `null` for a conflict. This module is the only place that picks
 * an engine module; it never branches on the engine otherwise. The store
 * write (`write.js`) writes the files.
 */

import { checkValue, tokensOf } from '../config/check.js';
import * as containment from './engines/containment.js';
import * as dependency from './engines/dependency.js';
import * as rank from './engines/rank.js';
import { jsonFile, jsonText, parseJson, throwFaults } from './item-json.js';
import { printedId } from './ids.js';
import { backlogText, idPrefixes } from './items.js';

/**
 * @typedef {import('./items.js').StoreContext} StoreContext
 * @typedef {typeof containment | typeof dependency | typeof rank} Engine
 * @typedef {{ name: string, engine: string, nodes: string[], path: string, module: Engine }} Graph
 *   one configured graph, `path` its file relative to the backlog's root and
 *   `module` its engine module
 */

/** Each engine name of `backlog.schema.json` → its module. */
const ENGINES = { containment, dependency, rank };

/**
 * The faults of the graph configuration (D1), one line each: a second graph
 * of one engine or of one name, which names both graphs, and each type that a
 * graph's `nodes`, `work_types` or a parent slot's `types` names and
 * `id_prefixes` does not give. `graphs` throws them; `bl-validate` (F-145)
 * reports them.
 * @param {StoreContext} ctx
 * @returns {string[]}
 */
export function graphFaults(ctx) {
  const top = ctx.config.scope(null);
  const types = new Set(Object.values(idPrefixes(ctx)));
  const unknown = (/** @type {string} */ type, /** @type {string} */ where) =>
    types.has(type) ? [] : [`${where} names the type ${type}, which id_prefixes does not give`];
  /** @type {Array<{ name: string, engine: string, nodes: string[] }>} */
  const graphs = top.graphs ?? [];
  const twice = (/** @type {'engine'|'name'} */ key) =>
    graphs.flatMap((graph) => {
      const first = /** @type {typeof graph} */ (graphs.find((other) => other[key] === graph[key]));
      return first === graph
        ? []
        : [`the graphs ${first.name} and ${graph.name} have the same ${key}, ${graph[key]}; each graph needs its own`];
    });
  return [
    ...twice('engine'),
    ...twice('name'),
    ...graphs.flatMap((graph) => graph.nodes.flatMap((type) => unknown(type, `the nodes of the graph ${graph.name}`))),
    .../** @type {string[]} */ (top.work_types ?? []).flatMap((type) => unknown(type, 'work_types')),
    ...[...types].flatMap((type) =>
      /** @type {Array<{ name: string, types: string[] }>} */ (
        ctx.config.file('items', `${type}.yaml`)?.parents ?? []
      ).flatMap((slot) => slot.types.flatMap((t) => unknown(t, `the slot ${slot.name} of the type ${type}`))),
    ),
  ];
}

/**
 * The configured graphs, in `backlog.yaml` order. A configuration with a
 * fault (`graphFaults`) is an error that gives each one.
 * @param {StoreContext} ctx
 * @returns {Graph[]}
 */
export function graphs(ctx) {
  const faults = graphFaults(ctx);
  if (faults.length > 0) throw new Error(['the graphs of backlog.yaml have faults:', ...faults].join('\n  '));
  /** @type {Array<{ name: string, engine: keyof typeof ENGINES, nodes: string[] }>} */
  const configured = ctx.config.scope(null).graphs ?? [];
  return configured.map((graph) => ({ ...graph, path: `graphs/${graph.name}.json`, module: ENGINES[graph.engine] }));
}

/**
 * The configured graph `name`. A name that `backlog.yaml` does not give is an
 * error.
 * @param {StoreContext} ctx
 * @param {string} name
 * @returns {Graph}
 */
export function graph(ctx, name) {
  const found = graphs(ctx).find((g) => g.name === name);
  if (found === undefined) throw new Error(`backlog.yaml gives no graph named ${name}`);
  return found;
}

/**
 * The faults of a graph file's text by its engine's schema, and its value
 * when it has none (`jsonFile`). A text that is not JSON is one `json` fault.
 * @param {Engine} module  the graph's engine module
 * @param {string} text
 */
const graphFile = (module, text) => jsonFile(text, (value) => checkValue(module.schema, value));

/**
 * The value of a graph file's text, or a copy of the engine's `empty` when
 * the text is `null` (no file). A text that is not JSON or fails the schema is
 * an error that names the file and each fault.
 * @param {Graph} graph
 * @param {string|null} text
 * @returns {any}
 */
export function parseGraph(graph, text) {
  if (text === null) return structuredClone(graph.module.empty);
  const { faults, value } = graphFile(graph.module, text);
  throwFaults(graph.path, faults);
  return value;
}

/**
 * The value of the graph `name` as its file holds it (`parseGraph`).
 * @param {StoreContext} ctx
 * @param {string} name
 */
export function readGraph(ctx, name) {
  const g = graph(ctx, name);
  return parseGraph(g, backlogText(ctx, g.path));
}

/**
 * The text the store writes for a graph value: `jsonText` of its canonical
 * form (D2). A value that fails the schema has no canonical form, so its text
 * is the value as it is, and the store write's check (`checkGraphText`)
 * refuses it.
 * @param {Graph} graph
 * @param {unknown} value
 */
export function graphText(graph, value) {
  const valid = checkValue(graph.module.schema, value).length === 0;
  return jsonText(valid ? graph.module.canonical(/** @type {any} */ (value)) : value);
}

/**
 * The findings of a graph file's text as a store write leaves it (D5): one
 * for each fault of its schema, the rule `schema`, and `item` the key that the
 * fault's path starts in (for the rank chain, the node at that place), or
 * `null` for a fault of the whole file.
 * @param {Graph} graph
 * @param {string} text
 * @returns {Array<{ item: string|null, file: string, rule: string, path: string, message: string }>}
 */
export function checkGraphText(graph, text) {
  const parsed = parseJson(text);
  const value = 'value' in parsed ? parsed.value : undefined;
  return graphFile(graph.module, text).faults.map(({ path, message }) => {
    const key = tokensOf(path)[0];
    const item = Array.isArray(value) ? value[Number(key)] : key;
    return { item: typeof item === 'string' ? item : null, file: graph.path, rule: 'schema', path, message };
  });
}

/**
 * The ids of the graph keys that a store write changed (D4, "Trailers"):
 * the engine's `changed` between the file's text before the write (`null` for
 * no file) and a text that passes the schema.
 * @param {Graph} graph
 * @param {string|null} before
 * @param {string} after
 * @returns {string[]}
 */
export const changedIds = (graph, before, after) =>
  graph.module.changed(parseGraph(graph, before), parseGraph(graph, after));

/**
 * The three-way merge of the texts of one graph file (D6), as git's merge
 * driver makes it: the base (the text at git's merge base), ours and theirs.
 * It takes the engine's name, not a graph, so it needs no configuration.
 *
 * 1. A zero-byte base is the engine's `empty`: git passes one when both sides
 *    add the file. Any other text that is not JSON or fails the engine's
 *    schema, a blank ours or theirs included, is a conflict.
 * 2. The engine's `merge` merges the three values (by key for containment and
 *    dependency, as a list for the rank chain).
 * 3. A merged value that fails the schema or the kind rule (`kind`, for
 *    example a containment cycle that two clean adds close) is a conflict.
 *
 * It gives the text of the merged value as the store writes it (`jsonText`
 * of its canonical form), or `null` for a conflict. An engine name that no
 * engine has is an error.
 * @param {string} engine  an engine name of `backlog.schema.json`
 * @param {string} baseText
 * @param {string} oursText
 * @param {string} theirsText
 * @returns {string|null}
 */
export function mergeGraph(engine, baseText, oursText, theirsText) {
  if (!Object.hasOwn(ENGINES, engine)) throw new Error(`there is no graph engine named ${engine}`);
  /** @type {any} */
  const module = ENGINES[/** @type {keyof typeof ENGINES} */ (engine)];
  const valueOf = (/** @type {string} */ text) => graphFile(module, text).value;
  const base = baseText === '' ? structuredClone(module.empty) : valueOf(baseText);
  const [ours, theirs] = [oursText, theirsText].map(valueOf);
  if (base === undefined || ours === undefined || theirs === undefined) return null;
  const merged = module.merge(base, ours, theirs);
  const valid = merged !== null && checkValue(module.schema, merged).length === 0 && module.kind(merged).length === 0;
  return valid ? jsonText(module.canonical(merged)) : null;
}

/**
 * @typedef {{ item: string|null, file: string, rule: string, path?: string, message: string }} GraphFinding
 *   one broken graph rule of a store write
 */

/**
 * The graph rules of one store write (D5), and `touched`: the ids of the
 * items whose files the write changed (`items`, the items it created
 * included) and of every key it changed in any graph (`changedIds`). The
 * store write gives the same ids its `Bl-Item` trailers (D4).
 *
 * 1. Each changed graph file gets the check of its schema (`checkGraphText`).
 *    A file that fails it gets no other check.
 * 2. Each changed graph file gets its engine's kind rule (`kind`) on the
 *    whole file.
 * 3. In each graph, the entry of each id of `touched` whose type is one of
 *    the graph's `nodes`, and of each key the write changed in it, names only
 *    ids that are items (`no-item`: an item directory or an item the write
 *    created, the id in its printed form) of a type in `nodes` (`node-type`).
 * 4. In each graph, each id of `touched` that is an item of a type in
 *    `nodes` gets its engine's per-item rules (`check`), with the work unit
 *    of each item as the write leaves the containment graph (`workUnit`).
 *
 * An entry that the write did not touch gets no rule, so its fault does not
 * refuse the write; `bl-validate` (F-145) reports it. A graph file that the
 * write did not change is read only when an id of `touched` is of one of its
 * `nodes`, or, for the containment file, when the rank rule needs the work
 * unit of a touched node. A file that then fails its schema is an error
 * (`parseGraph`).
 *
 * @param {StoreContext} ctx
 * @param {Array<{ graph: Graph, base: string|null, text: string }>} files
 *   each graph file the write changed: its text before (null for no file) and after
 * @param {string[]} items  the ids of the items whose files the write changed
 * @param {(id: string) => boolean} exists  whether the item with this printed id exists
 * @returns {{ findings: GraphFinding[], touched: Set<string> }}
 */
export function checkGraphs(ctx, files, items, exists) {
  const prefixes = idPrefixes(ctx);
  const schemaFindings = files.flatMap(({ graph, text }) => checkGraphText(graph, text));
  const failed = new Set(schemaFindings.map(({ file }) => file));
  const valid = files.filter(({ graph }) => !failed.has(graph.path));
  const keys = new Map(valid.map(({ graph, base, text }) => [graph.path, changedIds(graph, base, text)]));
  // A changed file that fails its schema reads as its engine's empty: the write is refused for it already.
  const values = new Map(
    files.map(({ graph, text }) => [
      graph.path,
      failed.has(graph.path) ? structuredClone(graph.module.empty) : parseGraph(graph, text),
    ]),
  );
  const touched = new Set([...items, ...[...keys.values()].flat()]);
  const typeOf = (/** @type {string} */ id) => printedId(id, prefixes)?.type;
  const valueOf = graphValues(ctx, (g) => values.get(g.path));
  const unitOf = (/** @type {string} */ id) => workUnit(ctx, valueOf, id);
  const findings = graphs(ctx)
    .filter((g) => !failed.has(g.path))
    .flatMap((g) => {
      const ofNodes = [...touched].filter((id) => g.nodes.includes(typeOf(id) ?? ''));
      const changedKeys = keys.get(g.path) ?? [];
      if (ofNodes.length === 0 && changedKeys.length === 0) return [];
      const value = valueOf(g.engine);
      const nodeFindings = [...new Set([...ofNodes, ...changedKeys])].flatMap((key) =>
        [...new Set(g.module.names(value, key))].flatMap((id) => {
          const type = typeOf(id);
          if (type === undefined || !exists(id)) {
            return [{ item: key, rule: 'no-item', message: `${id} is no item in the backlog` }];
          }
          return g.nodes.includes(type)
            ? []
            : [{ item: key, rule: 'node-type', message: `${id} is a ${type}, not a node type of the graph ${g.name}` }];
        }),
      );
      return [
        ...(keys.has(g.path) ? g.module.kind(value) : []),
        ...nodeFindings,
        ...g.module.check(value, ofNodes.filter(exists), ctx, unitOf),
      ].map((finding) => ({ ...finding, file: g.path }));
    });
  return { findings: [...schemaFindings, ...findings], touched };
}

/**
 * @typedef {(engine: string) => any} GraphValues
 *   the value of the graph of an engine, or a copy of the engine's `empty`
 *   when no configured graph has that engine
 */

/**
 * The graph values of a read or a write (`GraphValues`): each graph's value
 * is `staged(graph)` when that gives one, else its file's (`parseGraph`). It
 * reads each file at most once, at the first call for its engine.
 * @param {StoreContext} ctx
 * @param {(graph: Graph) => unknown} [staged]  a value that a write holds for the graph, or undefined
 * @returns {GraphValues}
 */
export function graphValues(ctx, staged = () => undefined) {
  const all = graphs(ctx);
  /** @type {Map<string, unknown>} */
  const read = new Map();
  return (engine) => {
    const g = all.find((other) => other.engine === engine);
    if (g === undefined) return structuredClone(ENGINES[/** @type {keyof typeof ENGINES} */ (engine)].empty);
    if (!read.has(engine)) read.set(engine, staged(g) ?? parseGraph(g, backlogText(ctx, g.path)));
    return read.get(engine);
  };
}

/**
 * The work unit of the item `id` (D7) by the containment graph of `graphs`
 * (`containment.workUnit`): `null` for an item whose type is not in
 * `work_types`, the item's own id for a work unit, else the work unit of its
 * first parent of a work type. The rank rule (D5) and the record's `unit`
 * both use it.
 * @param {StoreContext} ctx
 * @param {GraphValues} graphs
 * @param {string} id  an id in its printed form
 * @returns {string|null}
 */
export const workUnit = (ctx, graphs, id) => containment.workUnit(graphs('containment'), id, ctx);
