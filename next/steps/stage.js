/**
 * stage.js — stages (F-140 D4): a stage is a `bl.<stage>` name that each repo
 * fills with a command (steps.md, "The stages `bl` calls", D-80; "Plugins",
 * D-82). `stageDefinitions` resolves a stage for one repo, over the repo's
 * layers (`config.scope(repo)`), and `runStage` runs a single-command stage
 * for each repo of an item. The steps that call a stage (F-141, F-143) use
 * these, and never read `plugin_registry` themselves.
 */

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
 * @throws {Error} when the repo has no definition for the stage, or a list names a shared definition that does not exist
 */
export function stageDefinitions(config, repo, stage) {
  const stages = config.scope(repo)?.plugin_registry?.stages ?? {};
  const value = stages[stage];
  if (value === undefined) {
    throw new Error(`repo '${repo}' has no definition for the stage '${stage}' (steps.md, "Plugins")`);
  }
  if (value === 'none') return [];
  if (typeof value === 'string') return [{ [stage.slice('bl.'.length)]: value }];
  if (!Array.isArray(value)) return [value];
  return value.map((name) => {
    if (!Object.hasOwn(stages, name) || name.startsWith('bl.')) {
      throw new Error(`repo '${repo}' stage '${stage}' names '${name}', which is not a shared definition`);
    }
    return stages[name];
  });
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
