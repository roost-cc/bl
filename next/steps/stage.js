/**
 * stage.js — stages (F-140 D4): a stage is a `bl.<stage>` name that each repo
 * fills with a command (steps.md, "The stages `bl` calls", D-80; "Plugins",
 * D-82). `stageDefinitions` resolves a stage for one repo, over the repo's
 * layers (`config.scope(repo)`), and `runStage` runs a single-command stage
 * for each repo of an item. The steps that call a stage (F-141, F-143) use
 * these, and never read `plugin_registry` themselves.
 */

import { attribute } from '../config/check.js';
import { isMapping, pointerToken } from '../config/files.js';
import { runPlugin } from './plugin.js';
import { commandView } from './view.js';

/**
 * @typedef {Record<string, unknown>} Definition
 *   a stage's definition: the stage's command under the stage's key
 *   (`regenerate: …`), plus that stage's fields (`paths`)
 */
/**
 * @typedef {{ repo: string, repo_path: string, worktree_path: string, branch: string, base: string }} RepoContext
 *   the repo a stage runs in, its worktree for the item, the item's branch and the recorded base (D-84)
 */

/**
 * The definitions of `stage` for `repo`, in the order they run: `[]` for
 * `none`, the shared definitions in list order for a list, and the one inline
 * definition otherwise. An inline command string is the definition that holds
 * it under the stage's key (`bl.post-checkout: x` is `{ post-checkout: x }`).
 * @param {import('../config/load.js').Configuration} config
 * @param {string} repo
 * @param {string} stage  a `bl.` name, for example `bl.regenerate`
 * @returns {Definition[]}
 * @throws {Error} when the repo has no definition for the stage, a list names a shared definition that does not
 *   exist, or a definition holds no command under the stage's key (`stageFaults` reports these at start)
 */
export function stageDefinitions(config, repo, stage) {
  const stages = config.scope(repo)?.plugin_registry?.stages ?? {};
  if (stages[stage] === undefined) {
    throw new Error(`repo '${repo}' has no definition for the stage '${stage}' (steps.md, "Plugins")`);
  }
  const resolved = resolveStage(stages, stage);
  if ('problem' in resolved) throw new Error(`repo '${repo}' ${resolved.problem}`);
  return resolved.definitions;
}

/** Whether `value` is the command of `stage`: a map of scope to command for `bl.test`, else a command. */
const isCommand = (stage, value) =>
  stage === 'bl.test'
    ? isMapping(value) && Object.values(value).every((command) => typeof command === 'string')
    : typeof value === 'string';

/**
 * The definitions of the defined `stage` in `stages`, or the first problem
 * and the path under `stages` where it is: a list that names no shared
 * definition, or a definition with no command under the stage's key.
 * @param {Record<string, unknown>} stages
 * @param {string} stage
 * @returns {{ definitions: Definition[] } | { problem: string, at: string[] }}
 */
function resolveStage(stages, stage) {
  const value = stages[stage];
  if (value === 'none') return { definitions: [] };
  const key = stage.slice('bl.'.length);
  /** @type {Array<{ definition: unknown, at: string[] }>} */
  let named;
  if (typeof value === 'string') named = [{ definition: { [key]: value }, at: [stage] }];
  else if (!Array.isArray(value)) named = [{ definition: value, at: [stage] }];
  else {
    named = [];
    for (const [i, name] of value.entries()) {
      if (!Object.hasOwn(stages, name) || name.startsWith('bl.')) {
        return {
          problem: `stage '${stage}' names '${name}', which is not a shared definition`,
          at: [stage, String(i)],
        };
      }
      named.push({ definition: stages[name], at: [name] });
    }
  }
  const what = stage === 'bl.test' ? 'map of scope to command' : 'command';
  for (const { definition, at } of named) {
    if (!isCommand(stage, /** @type {Definition} */ (definition)[key])) {
      return { problem: `stage '${stage}' has no ${what} under '${key}' in '${at[0]}'`, at: [...at, key] };
    }
  }
  return { definitions: named.map(({ definition }) => /** @type {Definition} */ (definition)) };
}

/** The stages that hold a group or a map of channels, which their own steps read (D4). */
const NOT_SINGLE = new Set(['bl.change', 'bl.notify']);

/**
 * The start faults of the stages of the top-level scope and of each repo
 * scope: one `stage` fault for each defined `bl.` stage whose list names no
 * shared definition, or whose definition holds no command under the stage's
 * key. Each is at the file and path that write it, once, though every repo
 * scope holds the top-level stages too.
 * @param {import('../config/load.js').Configuration} config
 * @returns {import('../config/files.js').Fault[]}
 */
export function stageFaults(config) {
  const repos = Object.keys(config.scope(null)?.repos ?? {});
  /** @type {Map<string, import('../config/files.js').Fault>} */
  const faults = new Map();
  for (const repo of [null, ...repos]) {
    const stages = config.scope(repo)?.plugin_registry?.stages ?? {};
    const layers = /** @type {import('../config/layers.js').Layer[]} */ (config.layers('backlog', repo));
    for (const stage of Object.keys(stages)) {
      if (!stage.startsWith('bl.') || NOT_SINGLE.has(stage)) continue;
      const resolved = resolveStage(stages, stage);
      if (!('problem' in resolved)) continue;
      const at = attribute(`/plugin_registry/stages/${resolved.at.map(pointerToken).join('/')}`, layers);
      faults.set(`${at.file}\0${at.path}\0${resolved.problem}`, { ...at, rule: 'stage', message: resolved.problem });
    }
  }
  return [...faults.values()];
}

/**
 * Run `stage` for each repo context in order: each definition's `key`
 * command through `runPlugin`, in the repo's `worktree_path`, with the
 * command view plus the repo context and `change`, the repo's entry in
 * `state.json`'s `changes`. It stops at the first failure.
 * @param {import('./index.js').StepContext} ctx
 * @param {string} stage  a single-command stage, for example `bl.post-checkout`
 * @param {string} key  the stage's command key in a definition, for example `post-checkout`
 * @param {RepoContext[]} repos
 * @returns {Promise<{ outcome: 'success' } | { outcome: 'failure', repo: string, note?: string }>}
 * @throws {Error} on a stage with no definition for a repo, or a plugin crash
 */
export async function runStage(ctx, stage, key, repos) {
  for (const repoContext of repos) {
    const { repo, worktree_path } = repoContext;
    for (const definition of stageDefinitions(ctx.config, repo, stage)) {
      const base = commandView(ctx, repoContext);
      const view = { ...base, change: /** @type {any} */ (base.changes)?.[repo] };
      const { outcome, note } = await runPlugin(ctx, /** @type {string} */ (definition[key]), view, worktree_path);
      if (outcome === 'failure') return { outcome, repo, ...(note === undefined ? {} : { note }) };
    }
  }
  return { outcome: 'success' };
}
