/**
 * kinds.js — the registry of configuration kinds (F-136 D5).
 *
 * A configuration kind is one kind of configuration file: where the shop and
 * the operator keep it, how its layers combine (D4), and its schema. F-136
 * registers `backlog`; each later feature of E72 appends the kind of each
 * file it defines (Decision A1). `loadConfiguration` takes the list as an
 * argument, so the tests pass fixture kinds.
 */

import { MARKER } from './files.js';
import AGENTS_SCHEMA from './schemas/agents.schema.json' with { type: 'json' };
import ALERTS_SCHEMA from './schemas/alerts.schema.json' with { type: 'json' };
import BACKLOG_SCHEMA from './schemas/backlog.schema.json' with { type: 'json' };
import COLOR_SCHEME_SCHEMA from './schemas/color-scheme.schema.json' with { type: 'json' };
import COMMANDS_SCHEMA from './schemas/commands.schema.json' with { type: 'json' };
import FLOWS_SCHEMA from './schemas/flows.schema.json' with { type: 'json' };
import ITEMS_SCHEMA from './schemas/items.schema.json' with { type: 'json' };
import TEMPLATES_SCHEMA from './schemas/templates.schema.json' with { type: 'json' };
import VIEWS_SCHEMA from './schemas/views.schema.json' with { type: 'json' };

/**
 * @typedef {object} Kind
 * @property {string} name  the kind's name, as `file(kind)` takes it
 * @property {string} shop  the path under the backlog: a file, or a directory
 *   of `.yaml` files when it ends in `/`
 * @property {string} [operator]  the path under the operator's directory, in
 *   the same form; none for a kind the operator does not layer
 * @property {'both'|'who'|'none'} order  the layer order (D4): both axes, the
 *   who axis only, or the shop's file alone
 * @property {Record<string, unknown>} schema  the JSON Schema of each layered
 *   result; it marks CEL strings with the `cel` keyword
 */

/** @type {readonly Kind[]} */
export const KINDS = Object.freeze([
  Object.freeze({
    name: 'backlog',
    shop: MARKER,
    operator: 'config.yaml',
    order: 'both',
    schema: BACKLOG_SCHEMA,
  }),
  // The item definitions, `config/items/<type>.yaml`: the shop's alone (F-137 D9).
  Object.freeze({
    name: 'items',
    shop: 'config/items/',
    order: 'none',
    schema: ITEMS_SCHEMA,
  }),
  // F-138 D2: the command layer's files.
  Object.freeze({ name: 'commands', shop: 'config/commands.yaml', order: 'none', schema: COMMANDS_SCHEMA }),
  Object.freeze({
    name: 'views',
    shop: 'config/views.yaml',
    operator: 'views.yaml',
    order: 'who',
    schema: VIEWS_SCHEMA,
  }),
  Object.freeze({
    name: 'color-schemes',
    shop: 'config/color-schemes/',
    operator: 'color-schemes/',
    order: 'who',
    schema: COLOR_SCHEME_SCHEMA,
  }),
  // The flow set, `config/flows/*.yaml`: the shop's alone, not layered (F-139 D3, D-85).
  Object.freeze({ name: 'flows', shop: 'config/flows/', order: 'none', schema: FLOWS_SCHEMA }),
  // F-140 D2: the alert routing and the notification texts, files for people (views.md, D-471).
  Object.freeze({
    name: 'alerts',
    shop: 'config/alerts.yaml',
    operator: 'alerts.yaml',
    order: 'who',
    schema: ALERTS_SCHEMA,
  }),
  Object.freeze({
    name: 'templates',
    shop: 'config/templates/',
    operator: 'templates/',
    order: 'who',
    schema: TEMPLATES_SCHEMA,
  }),
  // F-141 D2: the agent profiles (D-498); an operator layer can add an argument to one profile.
  Object.freeze({
    name: 'agents',
    shop: 'config/agents.yaml',
    operator: 'agents.yaml',
    order: 'who',
    schema: AGENTS_SCHEMA,
  }),
]);
