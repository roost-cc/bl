import { test } from 'node:test';
import assert from 'node:assert/strict';
import BACKLOG_SCHEMA from '../config/schemas/backlog.schema.json' with { type: 'json' };
import { fixture, load } from '../test/helpers/config-fixture.js';
import { git, initRepo } from '../test/helpers/git.js';
import * as containment from './engines/containment.js';
import * as rank from './engines/rank.js';
import {
  checkGraphText,
  checkGraphs,
  changedIds,
  configureMergeDrivers,
  graph,
  graphFaults,
  graphText,
  graphValues,
  graphs,
  mergeGraph,
  readGraph,
  workUnit,
} from './graphs.js';

const GRAPHS = [
  'work_types: [feature, story]',
  'graphs:',
  '  - { name: containment, engine: containment, nodes: [story, feature] }',
  '  - { name: dependency, engine: dependency, nodes: [story] }',
  '  - { name: rank, engine: rank, nodes: [feature, story] }',
].join('\n');

/**
 * A store context on a backlog with the types story and feature, the graphs
 * `graphsYaml` and `files`.
 * @param {string} [graphsYaml]  the `graphs` and `work_types` lines of backlog.yaml
 * @param {Record<string, string>} [files]  path under the backlog → text
 */
function context(graphsYaml = GRAPHS, files = {}) {
  const all = {
    'backlog.yaml': `color_scheme: mocha\nrepos: {}\nid_prefixes:\n  S: story\n  F: feature\n${graphsYaml}\n`,
    'config/items/story.yaml': 'dir: stories\nparents:\n  - { name: unit, types: [feature], min: 0, max: 1 }\n',
    'config/items/feature.yaml': 'dir: features\n',
    ...files,
  };
  const dirs = fixture(Object.fromEntries(Object.entries(all).map(([path, text]) => [`backlog/${path}`, text])));
  return { backlogDir: dirs.backlogDir, config: load(dirs) };
}

test('the configured graphs come in backlog.yaml order, each with its file and its engine module', () => {
  const ctx = context();
  assert.deepEqual(
    graphs(ctx).map(({ name, engine, nodes, path }) => ({ name, engine, nodes, path })),
    [
      { name: 'containment', engine: 'containment', nodes: ['story', 'feature'], path: 'graphs/containment.json' },
      { name: 'dependency', engine: 'dependency', nodes: ['story'], path: 'graphs/dependency.json' },
      { name: 'rank', engine: 'rank', nodes: ['feature', 'story'], path: 'graphs/rank.json' },
    ],
  );
  assert.equal(graph(ctx, 'rank').module, rank);
  assert.deepEqual(graphFaults(ctx), []);
  assert.throws(() => graph(ctx, 'blockers'), { message: 'backlog.yaml gives no graph named blockers' });
});

test('a backlog.yaml with no graphs has none', () => {
  assert.deepEqual(graphs(context('')), []);
});

test('two graphs of one engine are an error that names both graphs', () => {
  const ctx = context(`${GRAPHS}\n  - { name: order, engine: rank, nodes: [story] }`);
  assert.throws(() => graphs(ctx), {
    message:
      'the graphs of backlog.yaml have faults:\n' +
      '  the graphs rank and order have the same engine, rank; each graph needs its own',
  });
});

test('two graphs of one name are a fault that names the name', () => {
  const ctx = context(
    'graphs:\n  - { name: g, engine: containment, nodes: [story] }\n  - { name: g, engine: rank, nodes: [story] }',
  );
  assert.deepEqual(graphFaults(ctx), ['the graphs g and g have the same name, g; each graph needs its own']);
});

test('a type that id_prefixes does not give, in nodes, work_types or a slot, is a fault that names the type', () => {
  const ctx = context(
    'work_types: [feature, batch]\ngraphs:\n  - { name: rank, engine: rank, nodes: [feature, task] }',
    {
      'config/items/story.yaml': 'dir: stories\nparents:\n  - { name: unit, types: [feature, epic], min: 0, max: 1 }\n',
    },
  );
  assert.deepEqual(graphFaults(ctx), [
    'the nodes of the graph rank names the type task, which id_prefixes does not give',
    'work_types names the type batch, which id_prefixes does not give',
    'the slot unit of the type story names the type epic, which id_prefixes does not give',
  ]);
  assert.throws(() => graph(ctx, 'rank'), /the nodes of the graph rank names the type task/);
});

test("a missing graph file reads as a copy of the engine's empty", () => {
  const ctx = context();
  const value = readGraph(ctx, 'rank');
  assert.deepEqual(value, []);
  value.push('S-1');
  assert.deepEqual(readGraph(ctx, 'rank'), []);
  assert.deepEqual(readGraph(ctx, 'containment'), {});
});

test('a graph file that is not JSON or fails the schema is an error that names the file', () => {
  const ctx = context(GRAPHS, { 'graphs/rank.json': '{}\n', 'graphs/containment.json': '{' });
  assert.throws(() => readGraph(ctx, 'rank'), /^Error: graphs\/rank\.json: type: must be array$/);
  assert.throws(() => readGraph(ctx, 'containment'), /^Error: graphs\/containment\.json: json: /);
});

test('a graph file reads as its file holds it', () => {
  const ctx = context(GRAPHS, { 'graphs/rank.json': '["F-1", "S-2"]' });
  assert.deepEqual(readGraph(ctx, 'rank'), ['F-1', 'S-2']);
});

test('graphText gives the canonical form as jsonText, and a value that fails the schema as it is', () => {
  const g = graph(context(), 'containment');
  assert.equal(
    graphText(g, { 'S-2': { unit: 'F-1' }, 'S-1': { unit: [] } }),
    '{\n  "S-2": {\n    "unit": "F-1"\n  }\n}\n',
  );
  assert.equal(graphText(g, { 'S-2': { unit: 5 } }), '{\n  "S-2": {\n    "unit": 5\n  }\n}\n');
});

test('checkGraphText gives a schema finding with the file and the key, or null for the whole file', () => {
  const ctx = context();
  assert.deepEqual(checkGraphText(graph(ctx, 'containment'), '{ "S-2": { "unit": 5 } }'), [
    { item: 'S-2', file: 'graphs/containment.json', rule: 'schema', path: '/S-2/unit', message: 'must be string' },
    { item: 'S-2', file: 'graphs/containment.json', rule: 'schema', path: '/S-2/unit', message: 'must be array' },
    {
      item: 'S-2',
      file: 'graphs/containment.json',
      rule: 'schema',
      path: '/S-2/unit',
      message: 'must match a schema in anyOf',
    },
  ]);
  assert.deepEqual(checkGraphText(graph(ctx, 'rank'), '["F-1", 3]'), [
    { item: null, file: 'graphs/rank.json', rule: 'schema', path: '/1', message: 'must be string' },
  ]);
  assert.deepEqual(
    checkGraphText(graph(ctx, 'rank'), 'undefined\n').map(({ item, rule }) => ({ item, rule })),
    [{ item: null, rule: 'schema' }],
  );
  assert.deepEqual(checkGraphText(graph(ctx, 'containment'), '{}'), []);
});

test("changedIds gives the engine's changed keys between the text before and after, no file being empty", () => {
  const g = graph(context(), 'containment');
  assert.equal(g.module, containment);
  assert.deepEqual(changedIds(g, null, '{ "S-2": { "unit": "F-1" } }'), ['S-2']);
  assert.deepEqual(changedIds(g, '{ "S-2": { "unit": "F-1" } }', '{ "S-2": { "unit": "F-1" } }'), []);
});

/** Every printed id but S-9 and F-9 is an item. */
const exists = (id) => !['S-9', 'F-9'].includes(id);

test('checkGraphs gives touched, the items and every changed key, and no finding when the rules hold', () => {
  const ctx = context(GRAPHS, { 'graphs/rank.json': '["F-1", "S-1"]' });
  const files = [
    { graph: graph(ctx, 'containment'), base: null, text: '{ "S-2": { "unit": "F-1" } }' },
    { graph: graph(ctx, 'rank'), base: '["F-1", "S-1"]', text: '["S-1", "F-1", "S-3"]' },
  ];
  const { findings, touched } = checkGraphs(ctx, files, ['S-4'], exists);
  assert.deepEqual(findings, []);
  assert.deepEqual([...touched].sort(), ['F-1', 'S-1', 'S-2', 'S-3', 'S-4']);
});

test('checkGraphs gives a file that fails its schema only its schema findings, and none of its keys', () => {
  const ctx = context();
  const files = [{ graph: graph(ctx, 'containment'), base: null, text: '{ "S-9": { "unit": 5 } }' }];
  const { findings, touched } = checkGraphs(ctx, files, [], exists);
  assert.deepEqual(
    findings.map(({ item, rule }) => [item, rule]),
    Array(3).fill(['S-9', 'schema']),
  );
  assert.deepEqual([...touched], []);
});

test('checkGraphs gives no-item to an id that is no item or not printed, and node-type to one of another type', () => {
  const ctx = context();
  const files = [
    {
      graph: graph(ctx, 'dependency'),
      base: null,
      text: '{ "S-1": { "done": [{ "F-1": "true" }, { "S-9": "true" }] } }',
    },
    { graph: graph(ctx, 'rank'), base: null, text: '["X-1", "s2", "F-1"]' },
  ];
  const { findings } = checkGraphs(ctx, files, [], exists);
  assert.deepEqual(findings, [
    {
      item: 'S-1',
      file: 'graphs/dependency.json',
      rule: 'node-type',
      message: 'F-1 is a feature, not a node type of the graph dependency',
    },
    { item: 'S-1', file: 'graphs/dependency.json', rule: 'no-item', message: 'S-9 is no item in the backlog' },
    { item: 'X-1', file: 'graphs/rank.json', rule: 'no-item', message: 'X-1 is no item in the backlog' },
    { item: 's2', file: 'graphs/rank.json', rule: 'no-item', message: 's2 is no item in the backlog' },
  ]);
});

test("checkGraphs runs the engine's kind rule on a changed file, and its per-item rules on a touched node of an unchanged one", () => {
  const ctx = context(GRAPHS, { 'graphs/containment.json': '{ "S-1": { "owner": "F-1" } }' });
  const cycle = [{ graph: graph(ctx, 'containment'), base: null, text: '{ "F-1": { "unit": "F-1" } }' }];
  assert.deepEqual(
    checkGraphs(ctx, cycle, [], exists).findings.map(({ item, file, rule }) => [item, file, rule]),
    [
      ['F-1', 'graphs/containment.json', 'cycle'],
      ['F-1', 'graphs/containment.json', 'slot'],
    ],
  );
  assert.deepEqual(checkGraphs(ctx, [], ['S-2'], exists).findings, []);
  assert.deepEqual(
    checkGraphs(ctx, [], ['S-1'], exists).findings.map(({ item, file, rule }) => [item, file, rule]),
    [['S-1', 'graphs/containment.json', 'slot']],
  );
});

/**
 * A store context with the work types batch, feature and story, and the type
 * epic. A story has a `unit` slot of a feature, then a `batch` slot of a batch
 * and an `epics` slot; a feature has a `within` slot of a batch or a feature.
 * @param {Record<string, string>} [files]
 */
const unitContext = (files = {}) =>
  context('', {
    'backlog.yaml': [
      'color_scheme: mocha',
      'repos: {}',
      'id_prefixes: { S: story, F: feature, B: batch, E: epic }',
      'work_types: [batch, feature, story]',
      'graphs:',
      '  - { name: containment, engine: containment, nodes: [story, feature, batch, epic] }',
      '  - { name: rank, engine: rank, nodes: [story, feature, batch] }',
      '',
    ].join('\n'),
    'config/items/story.yaml': [
      'dir: stories',
      'parents:',
      '  - { name: unit, types: [feature], min: 0, max: 1 }',
      '  - { name: batch, types: [batch], min: 0, max: 1 }',
      '  - { name: epics, types: [epic], min: 0, max: 2 }',
      '',
    ].join('\n'),
    'config/items/feature.yaml':
      'dir: features\nparents:\n  - { name: within, types: [batch, feature], min: 0, max: 1 }\n',
    'config/items/batch.yaml': 'dir: batches\n',
    'config/items/epic.yaml': 'dir: epics\n',
    ...files,
  });

test('workUnit gives null for a type not in work_types, the own id for a work unit, else the unit of the first work parent', () => {
  const value = {
    'S-2': { epics: ['E-1'] },
    'S-3': { epics: ['E-1'], unit: 'F-1' },
    'S-4': { batch: 'B-1', unit: 'F-2' },
    'F-2': { within: 'B-2' },
    'F-3': { within: 'F-4' },
    'F-4': { within: 'F-3' },
    'S-5': { unit: 'F-3' },
  };
  const ctx = unitContext({ 'graphs/containment.json': JSON.stringify(value) });
  const unit = (/** @type {string} */ id) => workUnit(ctx, graphValues(ctx), id);
  const CASES = [
    ['E-1', null],
    ['X-1', null],
    ['S-1', 'S-1'],
    ['B-1', 'B-1'],
    ['F-1', 'F-1'],
    ['S-2', 'S-2'],
    ['S-3', 'F-1'],
    ['S-4', 'B-2'],
    ['F-3', null],
    ['S-5', null],
  ];
  for (const [id, expected] of CASES) assert.equal(unit(/** @type {string} */ (id)), expected, id);
});

test('workUnit reads the containment graph of its graph values, and the staged value before the file', () => {
  const ctx = unitContext({ 'graphs/containment.json': '{ "S-1": { "unit": "F-1" } }' });
  assert.equal(workUnit(ctx, graphValues(ctx), 'S-1'), 'F-1');
  const staged = graphValues(ctx, (g) => (g.engine === 'containment' ? {} : undefined));
  assert.equal(workUnit(ctx, staged, 'S-1'), 'S-1');
  assert.equal(workUnit(context(''), graphValues(context('')), 'S-1'), null);
});

test('checkGraphs gives not-work-unit to a ranked node that a containment change puts in another work unit', () => {
  const ctx = unitContext({ 'graphs/rank.json': '["S-1", "F-1"]' });
  const attach = [{ graph: graph(ctx, 'containment'), base: null, text: '{ "S-1": { "unit": "F-1" } }' }];
  assert.deepEqual(checkGraphs(ctx, attach, [], exists).findings, [
    {
      item: 'S-1',
      file: 'graphs/rank.json',
      rule: 'not-work-unit',
      path: '/0',
      message: 'S-1 is no work unit: it belongs to F-1',
    },
  ]);
  const loose = [{ graph: graph(ctx, 'containment'), base: null, text: '{ "S-2": { "unit": "F-1" } }' }];
  assert.deepEqual(checkGraphs(ctx, loose, [], exists).findings, []);
});

test('checkGraphs reads an unchanged graph file only when a touched id is of its nodes', () => {
  const ctx = context(GRAPHS, { 'graphs/dependency.json': '[]' });
  assert.deepEqual(checkGraphs(ctx, [], ['F-1'], exists).findings, []);
  assert.throws(() => checkGraphs(ctx, [], ['S-1'], exists), /^Error: graphs\/dependency\.json: type: must be object$/);
});

/**
 * The JSON text of a value, as a graph file of another tool could hold it.
 * @param {unknown} value
 */
const text = (value) => JSON.stringify(value);

test("mergeGraph('rank') gives the results of Decision A3's examples, as text the store writes", () => {
  const rank = (/** @type {string} */ base, /** @type {string} */ ours, /** @type {string} */ theirs) => {
    const merged = mergeGraph('rank', ...[base, ours, theirs].map((chain) => text(chain.split(' '))));
    return merged === null ? null : JSON.parse(merged).join(' ');
  };
  assert.equal(rank('A B C', 'A B C Y', 'A B C Z'), 'A B C Y Z');
  assert.equal(rank('A B C', 'A Y B C', 'A Z B C'), 'A Y Z B C');
  assert.equal(rank('A B C', 'A C', 'A B Y C'), 'A Y C');
  assert.equal(rank('A B C', 'B A C', 'A C B'), null);
  assert.equal(rank('A B C', 'C A B', 'A B'), null);
  assert.equal(mergeGraph('rank', text(['A']), text(['A', 'B']), text(['A'])), '[\n  "A",\n  "B"\n]\n');
});

test('mergeGraph merges containment and dependency by key, in canonical form', () => {
  const base = text({ 'S-1': { unit: 'F-1' } });
  assert.equal(
    mergeGraph(
      'containment',
      base,
      text({ 'S-1': { unit: 'F-1', epics: ['E-2', 'E-1'] } }),
      text({ 'S-1': { within: 'F-1' } }),
    ),
    `${JSON.stringify({ 'S-1': { epics: ['E-1', 'E-2'], within: 'F-1' } }, null, 2)}\n`,
  );
  assert.equal(
    mergeGraph('containment', base, text({ 'S-1': { unit: 'F-2' } }), text({ 'S-1': { unit: 'F-3' } })),
    null,
  );
  const DONE = 'status == "done"';
  assert.equal(
    mergeGraph(
      'dependency',
      '{}',
      text({ 'S-1': { done: [{ 'S-3': DONE }] } }),
      text({ 'S-1': { done: [{ 'S-2': DONE }] } }),
    ),
    `${JSON.stringify({ 'S-1': { done: [{ 'S-2': DONE }, { 'S-3': DONE }] } }, null, 2)}\n`,
  );
});

test('mergeGraph reads a zero-byte base as the engine empty, and gives null for a damaged side', () => {
  assert.equal(mergeGraph('rank', '', text(['A']), text(['B'])), '[\n  "A",\n  "B"\n]\n');
  assert.equal(
    mergeGraph('containment', '', text({ 'S-1': { unit: 'F-1' } }), text({ 'S-2': { unit: 'F-1' } })),
    `${JSON.stringify({ 'S-1': { unit: 'F-1' }, 'S-2': { unit: 'F-1' } }, null, 2)}\n`,
  );
  for (const damaged of ['', '\n', '{ "S-1": ', '[]']) {
    assert.equal(mergeGraph('containment', '{}', damaged, '{}'), null, JSON.stringify(damaged));
    assert.equal(mergeGraph('containment', '{}', '{}', damaged), null, JSON.stringify(damaged));
  }
  assert.equal(mergeGraph('containment', '\n', '{}', '{}'), null);
  assert.equal(mergeGraph('rank', '[1]', '[]', '[]'), null);
});

test('mergeGraph gives null for a merged value that breaks the kind rule', () => {
  const base = text({});
  assert.equal(
    mergeGraph('containment', base, text({ 'S-1': { unit: 'S-2' } }), text({ 'S-2': { unit: 'S-1' } })),
    null,
  );
  assert.equal(
    mergeGraph(
      'dependency',
      base,
      text({ 'S-1': { done: [{ 'S-2': 'true' }] } }),
      text({ 'S-2': { done: [{ 'S-1': 'true' }] } }),
    ),
    null,
  );
});

test('cycle checks accept long acyclic chains in both keyed engines', () => {
  const ids = Array.from({ length: 12000 }, (_, i) => `S-${i + 1}`);
  /** each keyed engine → the entry of an edge to `to` */
  const EDGES = {
    containment: (/** @type {string} */ to) => ({ unit: to }),
    dependency: (/** @type {string} */ to) => ({ done: [{ [to]: 'true' }] }),
  };
  const ctx = context();
  for (const [engine, edge] of Object.entries(EDGES)) {
    const g = graph(ctx, engine);
    // S-1 → S-2 → … → S-12000, then the same chain closed by S-12000 → S-1.
    const open = Object.fromEntries(ids.slice(0, -1).map((id, i) => [id, edge(ids[i + 1])]));
    const closed = { ...open, [/** @type {string} */ (ids.at(-1))]: edge(ids[0]) };
    const cycles = (/** @type {Array<{ rule: string, item: string|null }>} */ faults) =>
      faults.filter(({ rule }) => rule === 'cycle').map(({ item }) => item);
    assert.deepEqual(g.module.kind(open), [], engine);
    assert.deepEqual(cycles(g.module.kind(closed)), ['S-1'], engine);
    assert.equal(mergeGraph(engine, '', text(open), text(open)), graphText(g, open), engine);
    assert.equal(mergeGraph(engine, '', text(open), text(closed)), null, engine);
    const write = (/** @type {object} */ after) => [{ graph: g, base: text(open), text: text(after) }];
    const { [ids[0]]: _, ...rest } = open;
    assert.deepEqual(cycles(checkGraphs(ctx, write(rest), [], exists).findings), [], engine);
    assert.deepEqual(cycles(checkGraphs(ctx, write(closed), [], exists).findings), ['S-1'], engine);
  }
});

test('mergeGraph refuses an engine name that no engine has', () => {
  assert.throws(() => mergeGraph('blockers', '', '[]', '[]'), { message: 'there is no graph engine named blockers' });
});

test("the engine names of backlog.schema.json are the engines that graphs.js has, in the schema's order", () => {
  const names = BACKLOG_SCHEMA.properties.graphs.items.properties.engine.enum;
  for (const name of names) assert.doesNotThrow(() => mergeGraph(name, '', '', ''), name);
  const ctx = context();
  initRepo(ctx.backlogDir);
  configureMergeDrivers(ctx.backlogDir);
  assert.deepEqual(
    git(ctx.backlogDir, 'config', '--get-regexp', String.raw`^merge\..*\.driver$`)
      .split('\n')
      .map((line) => line.split(' ')[0]),
    names.map((name) => `merge.bl-graph-${name}.driver`),
  );
});
