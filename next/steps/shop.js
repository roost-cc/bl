/**
 * shop.js — the shop's own steps (F-140 D6; steps.md, "Plugins", D-82).
 *
 * Each entry of the top-level `plugin_registry.steps` is a step of the
 * catalogue, keyed `steps.<name>`, so the engine knows no second kind of step.
 * A box runs one as `use: steps.<name>`. Its `with:` fills the command's
 * `{{with.<key>}}` names, exactly those, and its exit status is the outcome
 * (`runPlugin`). It runs once, in the backlog root, so the repo variables
 * render as nothing (Decision A1). Its note is the last line its plugin wrote
 * to stderr (Decision A2).
 */

import { templateNames } from '../config/template.js';
import { pluginParts, runPlugin } from './plugin.js';
import { commandView } from './view.js';

/** @typedef {import('./index.js').Step} Step */
/** @typedef {import('./plugin.js').Plugin} Plugin */

/**
 * The `with` schema of a command: an object that holds exactly the names of
 * its `{{with.<key>}}` references, or `null` when it reads none.
 * @param {string} command
 * @returns {Record<string, unknown>|null}
 */
function withSchema(command) {
  const names = templateNames(command, 'with');
  if (names.length === 0) return null;
  return {
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, {}])),
    required: names,
    additionalProperties: false,
  };
}

/**
 * One step for each entry of the top-level `plugin_registry.steps` of
 * `config`, keyed `steps.<name>`.
 * @param {import('../config/load.js').Configuration} config
 * @returns {Readonly<Record<string, Step>>}
 */
export function shopSteps(config) {
  const plugins = /** @type {Record<string, Plugin>} */ (config.scope(null)?.plugin_registry?.steps ?? {});
  return Object.freeze(
    Object.fromEntries(
      Object.entries(plugins).map(([name, plugin]) => {
        /** @type {Step} */
        const step = Object.freeze({
          outcomes: Object.freeze(/** @type {const} */ (['success', 'failure'])),
          with: withSchema(pluginParts(plugin).template),
          run: async (ctx, withArgs) => {
            const view = commandView(ctx, { box: ctx.box, with: withArgs });
            const { outcome, note } = await runPlugin(ctx, plugin, view, ctx.backlogDir);
            return { outcome, note };
          },
        });
        return [`steps.${name}`, step];
      }),
    ),
  );
}
