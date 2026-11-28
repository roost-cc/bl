/**
 * notify.js — the one module that sends a notification (F-140 D9; alerts.md,
 * "Notifications", D-93, D-94, D-96; "Channels", D-99; "When no notification
 * is defined", D-100; "The seed's notification", D-101).
 *
 * - `routeChannels` gives the channels that `config/alerts.yaml` routes a
 *   kind and its reasons (a `notify` topic, a `gated` class) to.
 * - `templateText` gives a text of the operator's language file
 *   (`config/templates/<language>.yaml`, views.md, D-472, D-473).
 * - `send` renders the text with the command view and runs each channel of
 *   the top-level `bl.notify` through the plugin runner, with the text as
 *   `{{message}}`. A channel that does not exit 0 is not delivered, and is
 *   never a crash.
 * - The `notify` step is a flow box's notification. The alerts are the other
 *   caller.
 * - `checkNotifications` is the start check of the routes and the language.
 */

import { attribute } from '../config/check.js';
import { pointerToken } from '../config/files.js';
import { render } from '../config/template.js';
import { info } from '../lib/stderr.js';
import { runPlugin } from './plugin.js';
import { commandView } from './view.js';

/** @typedef {import('../config/files.js').Fault} Fault */
/** @typedef {import('../config/load.js').Configuration} Configuration */
/** @typedef {import('./index.js').Step} Step */
/** @typedef {import('./index.js').StepContext} StepContext */

/** The top-level channels: channel name → command (Decision A1). */
const channelsOf = (/** @type {Configuration} */ config) =>
  /** @type {Record<string, string>} */ (config.scope(null)?.plugin_registry?.stages?.['bl.notify'] ?? {});

/**
 * The channels of `kind` for `reasons` (D-97): for each reason the
 * `<kind>.<reason>` key if `alerts` has it, else the `<kind>` key, joined in
 * order with repeats dropped. With no reason, the `<kind>` key.
 * @param {Record<string, string[]>} alerts  `config.file('alerts')`
 * @param {string} kind  `gated`, `ended` or `notify`
 * @param {string[]} [reasons]
 * @returns {string[]}
 */
export function routeChannels(alerts, kind, reasons = []) {
  const keys =
    reasons.length === 0 ? [kind] : reasons.map((r) => (Object.hasOwn(alerts, `${kind}.${r}`) ? `${kind}.${r}` : kind));
  return [...new Set(keys.flatMap((key) => alerts[key] ?? []))];
}

/**
 * The text of `<kind>.<reason>` if the language file has it, else of
 * `<kind>`, from `config/templates/<language>.yaml` with the operator's file
 * patched over it; `language` is that of the top-level scope.
 * @param {Configuration} config
 * @param {string} kind  an alert kind, or a `notify` box's `template`
 * @param {string} [reason]
 * @returns {string}
 * @throws {Error} when the language has no file, or the file has neither name
 */
export function templateText(config, kind, reason) {
  const language = /** @type {string} */ (config.scope(null)?.language);
  const file = `${language}.yaml`;
  const texts = /** @type {Record<string, string>|undefined} */ (config.file('templates', file));
  if (texts === undefined) throw new Error(`the language '${language}' has no template file templates/${file}`);
  const names = reason === undefined ? [kind] : [`${kind}.${reason}`, kind];
  const name = names.find((n) => Object.hasOwn(texts, n));
  if (name === undefined) throw new Error(`templates/${file} has no template named '${names.join("' or '")}'`);
  return texts[name];
}

/**
 * Render `text` with `view`, with no escape, and run each channel's command
 * of the top-level `bl.notify` with `view` plus `message`, in the backlog
 * root. A channel is delivered when it exits 0. Any other exit, a crash code
 * too (127 when the command is not installed), is not delivered: one line on
 * stderr names the channel, and the invocation goes on (D-101).
 * @param {StepContext} ctx
 * @param {string[]} channels  `[]` sends nothing
 * @param {string} text  a Mustache template (`templateText`)
 * @param {Record<string, unknown>} view  the command view (`commandView`)
 * @returns {Promise<number>} the number of channels delivered
 */
export async function send(ctx, channels, text, view) {
  const message = render(text, view);
  const commands = channelsOf(ctx.config);
  let delivered = 0;
  for (const channel of channels) {
    try {
      const { code } = await runPlugin(ctx, commands[channel], { ...view, message }, ctx.backlogDir);
      if (code === 0) delivered += 1;
    } catch (error) {
      info(`bl.notify ${channel}: ${/** @type {Error} */ (error).message.replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  return delivered;
}

/**
 * The `notify` step (D-94, D-100): `with: { template, topic }`. It sends the
 * text `template` to the channels of `notify.<topic>`, with `box` the box the
 * flow came from (D-482). It gives `success` when the route is `[]` or one
 * channel is delivered, and `failure` when none is.
 * @type {Step}
 */
export const notify = Object.freeze({
  outcomes: Object.freeze(/** @type {const} */ (['success', 'failure'])),
  with: {
    type: 'object',
    properties: { template: { type: 'string' }, topic: { type: 'string' } },
    required: ['template', 'topic'],
    additionalProperties: false,
  },
  run: async (ctx, /** @type {{ template: string, topic: string }} */ { template, topic }) => {
    const channels = routeChannels(ctx.config.file('alerts'), 'notify', [topic]);
    const text = templateText(ctx.config, template);
    if (channels.length === 0) return 'success';
    const delivered = await send(ctx, channels, text, commandView(ctx, { box: ctx.from }));
    return delivered > 0 ? 'success' : 'failure';
  },
});

/**
 * The start faults of the notifications (D9): one for each channel that a
 * route of `alerts.yaml` names and the top-level `bl.notify` does not define
 * (D-99), at the route's entry, and one for a `language` that has no
 * template file (D-473), at `/language`.
 * @param {Configuration} config
 * @returns {Fault[]}
 */
export function checkNotifications(config) {
  const channels = channelsOf(config);
  const alertLayers = /** @type {import('../config/layers.js').Layer[]} */ (config.layers('alerts'));
  const routes = Object.entries(/** @type {Record<string, string[]>} */ (config.file('alerts') ?? {})).flatMap(
    ([key, list]) =>
      list.flatMap((channel, i) =>
        Object.hasOwn(channels, channel)
          ? []
          : [
              {
                ...attribute(`/${pointerToken(key)}/${i}`, alertLayers),
                rule: 'channel',
                message: `no bl.notify channel named '${channel}'`,
              },
            ],
      ),
  );
  const language = config.scope(null)?.language;
  const languageFaults =
    config.file('templates', `${language}.yaml`) === undefined
      ? [
          {
            ...attribute('/language', /** @type {any} */ (config.layers('backlog'))),
            rule: 'language',
            message: `the language '${language}' has no template file templates/${language}.yaml`,
          },
        ]
      : [];
  return [...routes, ...languageFaults];
}
