// Fixture flow sets for tests of `buildFlowSet` (`engine/flow-set.js`,
// `engine/derive.js`): the uTop flow set, fake code steps, the flow set of a
// fixture backlog, and the fault lines of a flow set that must fail.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { stringify } from 'yaml';
import { ConfigurationFaults } from '../../config/check.js';
import { buildFlowSet } from '../../engine/flow-set.js';
import { fixture, load } from './config-fixture.js';

const FLOWS = fileURLToPath(new URL('../fixtures/flows/', import.meta.url));
const BACKLOG = 'color_scheme: mocha\nlanguage: en\nrepos: {}\nid_prefixes:\n  S: story\n';

/** The uTop flow set: file name → text. */
export const UTOP = Object.fromEntries(
  readdirSync(FLOWS)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => [name, readFileSync(FLOWS + name, 'utf8')]),
);

/**
 * A fake code step that ends with `success`.
 * @param {Record<string, unknown>|null} [schema]  its `with` schema
 * @param {('success'|'failure')[]} [outcomes]  the outcomes it can return; both by default
 */
export const step = (schema = null, outcomes = ['success', 'failure']) => ({
  outcomes,
  with: schema,
  run: async () => 'success',
});

/**
 * The code steps that the uTop flow set names, as fake steps that take any
 * `with:`, with the outcomes of steps.md's catalogue: `failure` is not used
 * by `cleanup`, `increment`, `prepare`, `rank` and `succeed`. The schema of
 * `agent` names the property `agents`, which the entries' `--agent` options
 * set (F-152 D4).
 */
export const UTOP_STEPS = Object.fromEntries([
  ['agent', step({ type: 'object', properties: { agents: {} } })],
  ...[
    'assert',
    'fast_forward',
    'join',
    'merge',
    'notify',
    'open_pr',
    'release',
    'run_children',
    'run_task_list',
    'test',
    'wait',
  ].map((name) => [name, step({})]),
  ...['cleanup', 'increment', 'prepare', 'rank', 'succeed'].map((name) => [name, step({}, ['success'])]),
]);

/**
 * The configuration and the flow set of a fixture backlog whose `config/flows/` holds `files`.
 * @param {Record<string, string|object>} files  file name → YAML text, or a value to write as YAML
 * @param {Record<string, any>} catalogue
 */
export function buildLoaded(files, catalogue) {
  const written = { 'backlog/backlog.yaml': BACKLOG };
  for (const [name, value] of Object.entries(files)) {
    written[`backlog/config/flows/${name}`] = typeof value === 'string' ? value : stringify(value);
  }
  const dirs = fixture(written);
  const config = load(dirs);
  return { config, backlogDir: dirs.backlogDir, flowSet: buildFlowSet(config, catalogue, dirs.backlogDir) };
}

/**
 * The flow set of a fixture backlog whose `config/flows/` holds `files`.
 * @param {Record<string, string|object>} files  file name → YAML text, or a value to write as YAML
 * @param {Record<string, any>} catalogue
 */
export const build = (files, catalogue) => buildLoaded(files, catalogue).flowSet;

/**
 * The fault lines of a flow set that must fail.
 * @param {Record<string, string|object>} files
 * @param {Record<string, any>} catalogue
 */
export function faultLines(files, catalogue) {
  try {
    build(files, catalogue);
  } catch (error) {
    if (error instanceof ConfigurationFaults) return error.message.split('\n');
    throw error;
  }
  assert.fail('the flow set gave no fault');
}
