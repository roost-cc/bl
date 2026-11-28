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
 * - The `notify` step is a flow box's notification. `sendAlert` is the other
 *   caller: the runner's `gated` and `ended` alerts (D10).
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
 * order with repeats dropped. With no reason, the `<kind>` key. An undefined
 * reason (a gate entry with no class) takes the `<kind>` key.
 * @param {Record<string, string[]>} alerts  `config.file('alerts')`
 * @param {string} kind  `gated`, `ended` or `notify`
 * @param {Array<string|undefined>} [reasons]
 * @returns {string[]}
 */
export function routeChannels(alerts, kind, reasons = []) {
  const keyOf = (/** @type {string|undefined} */ r) =>
    r !== undefined && Object.hasOwn(alerts, `${kind}.${r}`) ? `${kind}.${r}` : kind;
  const keys = reasons.length === 0 ? [kind] : reasons.map(keyOf);
  return [...new Set(keys.flatMap((key) => alerts[key] ?? []))];
}

/**
 * The template file of the top-level `language` (D-473): its name, its texts
 * (undefined when there is no such file), and the message for a missing file.
 * @param {Configuration} config
 */
function languageFile(config) {
  const language = /** @type {string} */ (config.scope(null)?.language);
  const file = `${language}.yaml`;
  return {
    file,
    texts: /** @type {Record<string, string>|undefined} */ (config.file('templates', file)),
    missing: `the language '${language}' has no template file templates/${file}`,
  };
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
  const { file, texts, missing } = languageFile(config);
  if (texts === undefined) throw new Error(missing);
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

/** The longest `condition` an alert text gets; a longer one is cut with `…` (D-97). */
const CONDITION_MAX = 120;

/**
 * Send the alert `kind` (D10; alerts.md, "Alerts", D-97): to the channels
 * that `routeChannels` gives for `reasons`, the text of `<kind>.<reasons[0]>`
 * or `<kind>`, rendered with the command view of `extras` plus `reason`, the
 * first reason. `condition` is cut at 120 characters with `…`. A route of
 * `[]` sends nothing and reads no text. An alert that no channel delivers
 * prints one line on stderr that names it, after the lines of `send`.
 * @param {StepContext} ctx  the step context of the box the alert is about
 * @param {string} kind  `gated` or `ended`
 * @param {Array<string|undefined>} reasons  for a `gated` alert the class of each failing
 *   entry, undefined for an entry with none; `normal` or `crash` for an `ended` one
 * @param {{ box?: string, condition?: string, class?: string, error?: string }} [extras]
 * @returns {Promise<void>}
 * @throws {Error} when the language file has no text for the alert
 */
export async function sendAlert(ctx, kind, reasons, { condition, ...extras } = {}) {
  const channels = routeChannels(ctx.config.file('alerts'), kind, reasons);
  if (channels.length === 0) return;
  const [reason] = reasons;
  const text = templateText(ctx.config, kind, reason);
  const view = commandView(ctx, {
    ...extras,
    ...(reason === undefined ? {} : { reason }),
    ...(condition === undefined
      ? {}
      : { condition: condition.length > CONDITION_MAX ? `${condition.slice(0, CONDITION_MAX)}…` : condition }),
  });
  const delivered = await send(ctx, channels, text, view);
  if (delivered === 0)
    info(`${ctx.id}: the ${reason === undefined ? kind : `${kind}.${reason}`} alert reached no channel`);
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
  const { texts, missing } = languageFile(config);
  const languageFaults =
    texts === undefined
      ? [
          {
            ...attribute('/language', /** @type {any} */ (config.layers('backlog'))),
            rule: 'language',
            message: missing,
          },
        ]
      : [];
  return [...routes, ...languageFaults];
}
