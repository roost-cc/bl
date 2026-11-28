// A committed backlog git repo for tests of the engine's conditions and gates (`engine/conditions.js`,
// `engine/gates.js`): the uTop flow set, the types feature, story and task, the containment and
// dependency graphs, and items made through `storeWrite`.
import { parse, stringify } from 'yaml';
import { git, initRepo } from './git.js';
import { fixture, load } from './config-fixture.js';
import { UTOP, UTOP_STEPS } from './flow-fixture.js';
import { buildFlowSet } from '../../engine/flow-set.js';
import { storeWrite } from '../../store/write.js';

/**
 * uTop's `defined-steps.yaml` with no step gates and no post-conditions (their conditions call
 * functions that F-139 does not bind), after `edit` changes its `defined_steps`.
 */
export function definedSteps(edit = (/** @type {any} */ _steps) => {}) {
  const value = parse(UTOP['defined-steps.yaml']);
  delete value.step_gates;
  for (const step of Object.values(value.defined_steps)) delete step.after;
  edit(value.defined_steps);
  return stringify(value);
}

const FILES = {
  'backlog.yaml': [
    'color_scheme: mocha',
    'language: en',
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
 * set built with `catalogue`, by default the uTop test catalogue.
 * `backlogYaml` ends `backlog.yaml`: its `repos`, and for example a
 * `plugin_registry`.
 * @param {Record<string, string>} [flows]  flow file name → YAML text
 * @param {string} [backlogYaml]
 * @param {Readonly<Record<string, any>> | ((config: any) => Readonly<Record<string, any>>)} [catalogue]
 *   the step catalogue, or a function of the loaded configuration that gives
 *   it (for the shop's steps)
 * @param {Record<string, string>} [files]  more files, path under the backlog → text
 *   (for example `config/alerts.yaml`)
 * @returns {{ backlogDir: string, config: any, flowSet: import('../../engine/flow-set.js').FlowSet }}
 */
export function engineBacklog(flows = {}, backlogYaml = 'repos: {}\n', catalogue = UTOP_STEPS, files = {}) {
  const all = {
    ...FILES,
    ...files,
    'backlog.yaml': FILES['backlog.yaml'] + backlogYaml,
    ...Object.fromEntries(Object.entries({ ...UTOP, ...flows }).map(([name, text]) => [`config/flows/${name}`, text])),
  };
  const dirs = fixture(Object.fromEntries(Object.entries(all).map(([path, text]) => [`backlog/${path}`, text])));
  initRepo(dirs.backlogDir);
  git(dirs.backlogDir, 'add', '.');
  git(dirs.backlogDir, 'commit', '-q', '-m', 'init');
  const config = load(dirs);
  const steps = typeof catalogue === 'function' ? catalogue(config) : catalogue;
  return { backlogDir: dirs.backlogDir, config, flowSet: buildFlowSet(config, steps, dirs.backlogDir) };
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
