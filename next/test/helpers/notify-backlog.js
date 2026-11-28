// A committed engine backlog whose notifications reach test channels (F-140 D9, D10): the
// top-level bl.notify, config/alerts.yaml and config/templates/en.yaml, by default the uTop
// copies, and channels that append their {{message}} to a file under .bl/, which git ignores.
import { readFileSync } from 'fs';
import { join } from 'path';
import { engineBacklog } from './engine-backlog.js';

/** The text of the file `name` of `next/test/fixtures/`. */
export const fixtureText = (/** @type {string} */ name) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/** A channel command, as YAML, that appends its `{{message}}` to `.bl/<name>` and then exits `code`. */
export const channel = (/** @type {string} */ name, code = 0) =>
  `"mkdir -p .bl && printf '%s\\\\n' {{message}} >> .bl/${name} && exit ${code}"`;

/**
 * `engineBacklog` with `channels` as the top-level `bl.notify`, `alerts` as
 * `config/alerts.yaml` and `texts` as `config/templates/en.yaml`; a `texts`
 * of null writes no language file.
 * @param {object} options
 * @param {Record<string, string>} [options.flows]  flow file name → YAML text
 * @param {Record<string, string>} options.channels  channel name → command YAML (`channel`)
 * @param {string} [options.alerts]
 * @param {string|null} [options.texts]
 * @param {Parameters<typeof engineBacklog>[2]} [options.catalogue]
 */
export function notifyBacklog({
  flows = {},
  channels,
  alerts = fixtureText('alerts.yaml'),
  texts = fixtureText('templates/en.yaml'),
  catalogue,
}) {
  const notify = Object.entries(channels).map(([name, command]) => `      ${name}: ${command}`);
  const registry = ['repos: {}', 'plugin_registry:', '  stages:', '    bl.notify:', ...notify, ''].join('\n');
  const files = { 'config/alerts.yaml': alerts, ...(texts === null ? {} : { 'config/templates/en.yaml': texts }) };
  return engineBacklog(flows, registry, catalogue, files);
}

/** What the channel `name` wrote, or null when it did not run. */
export const delivered = (/** @type {{ backlogDir: string }} */ ctx, /** @type {string} */ name) => {
  try {
    return readFileSync(join(ctx.backlogDir, '.bl', name), 'utf8');
  } catch {
    return null;
  }
};
