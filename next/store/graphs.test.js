import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, load } from '../test/helpers/config-fixture.js';
import * as containment from './engines/containment.js';
import * as rank from './engines/rank.js';
import { checkGraphText, checkGraphs, changedIds, graph, graphFaults, graphText, graphs, readGraph } from './graphs.js';

const GRAPHS = [
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

test('checkGraphs reads an unchanged graph file only when a touched id is of its nodes', () => {
  const ctx = context(GRAPHS, { 'graphs/dependency.json': '[]' });
  assert.deepEqual(checkGraphs(ctx, [], ['F-1'], exists).findings, []);
  assert.throws(() => checkGraphs(ctx, [], ['S-1'], exists), /^Error: graphs\/dependency\.json: type: must be object$/);
});
