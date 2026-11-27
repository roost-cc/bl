// A committed backlog git repo for tests of the engine's conditions and gates (`engine/conditions.js`,
// `engine/gates.js`): the uTop flow set, the types feature, story and task, the containment and
// dependency graphs, and items made through `storeWrite`.
import { git, initRepo } from './git.js';
import { fixture, load } from './config-fixture.js';
import { UTOP, UTOP_STEPS } from './flow-fixture.js';
import { buildFlowSet } from '../../engine/flow-set.js';
import { storeWrite } from '../../store/write.js';

const FILES = {
  'backlog.yaml': [
    'color_scheme: mocha',
    'language: en',
    'repos: {}',
    'id_prefixes: { F: feature, S: story, T: task }',
    'work_types: [feature, story]',
    'graphs:',
    '  - { name: containment, engine: containment, nodes: [feature, story, task] }',
    '  - { name: dependency, engine: dependency, nodes: [feature, story, task] }',
    '',
  ].join('\n'),
  'config/items/feature.yaml': 'dir: features\n',
  'config/items/story.yaml': 'dir: stories\nparents:\n  - { name: unit, types: [feature], min: 0, max: 1 }\n',
  'config/items/task.yaml': 'dir: tasks\nparents:\n  - { name: parent, types: [feature, story], min: 0, max: 1 }\n',
  '.gitignore': '.bl/\n',
};

/**
 * A committed backlog repo whose `config/flows/` holds the uTop flow set with
 * `flows` added or replaced, and its context: the store context and the flow
 * set built with the uTop test catalogue.
 * @param {Record<string, string>} [flows]  flow file name → YAML text
 * @returns {{ backlogDir: string, config: any, flowSet: import('../../engine/flow-set.js').FlowSet }}
 */
export function engineBacklog(flows = {}) {
  const all = {
    ...FILES,
    ...Object.fromEntries(Object.entries({ ...UTOP, ...flows }).map(([name, text]) => [`config/flows/${name}`, text])),
  };
  const dirs = fixture(Object.fromEntries(Object.entries(all).map(([path, text]) => [`backlog/${path}`, text])));
  initRepo(dirs.backlogDir);
  git(dirs.backlogDir, 'add', '.');
  git(dirs.backlogDir, 'commit', '-q', '-m', 'init');
  const config = load(dirs);
  return { backlogDir: dirs.backlogDir, config, flowSet: buildFlowSet(config, UTOP_STEPS, dirs.backlogDir) };
}

/**
 * Make one item per spec in one store write, and give their ids in spec order.
 * @param {{ backlogDir: string, config: any }} ctx
 * @param {Array<{ type: string, state: Record<string, unknown> }>} specs
 * @returns {Promise<string[]>}
 */
export const createItems = (ctx, specs) =>
  storeWrite(ctx, { message: 'chore: items' }, (w) =>
    specs.map(({ type, state }, i) => w.create(type, `${type} ${i + 1}`, { state, by: 'operator' })),
  );

/**
 * Replace the value of the graph `name` in one store write.
 * @param {{ backlogDir: string, config: any }} ctx
 * @param {string} name
 * @param {unknown} value
 */
export const setGraph = (ctx, name, value) =>
  storeWrite(ctx, { message: `chore: ${name}` }, (w) => w.graph(name, () => value));
