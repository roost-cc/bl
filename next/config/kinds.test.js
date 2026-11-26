/**
 * The configuration kinds of `next/config/kinds.js` and their schemas, loaded
 * through `loadConfiguration` on fixture backlogs (F-138 D2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ConfigurationFaults } from './check.js';
import { KINDS } from './kinds.js';
import { loadConfiguration } from './load.js';
import { withEnv } from '../test/helpers/env.js';
import { mkTempDir } from '../test/helpers/tempdir.js';

const SHOP = { 'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\n' };

const COMMANDS = `
list: { op: list, help: List items, description: Lists the items., args: [--sort, rank] }
run: { entry: run, help: Run a work unit }
`;

const VIEWS = `
list:
  columns:
    - { field: item_id, header: ID, justify: left, truncate: false }
    - { field: title, header: Title, justify: left, truncate: true, style: '"title"', indent: depth }
  style: 'status == "done" ? "closed" : ""'
  footer: 'string(size(records)) + " items"'
item: { template: '{{item_id}} {{title}}' }
flow-chart: { records_template: '{{#records}}{{id}}{{/records}}' }
`;

const MOCHA = "match: [bold, '#f9e2af']\nclosed: [dim]\n";

/** Load `KINDS` on a fixture home with `files` written under it, `$HOME` the home. */
function load(files) {
  const home = mkTempDir('bl-kinds-');
  for (const [path, text] of Object.entries({ ...SHOP, ...files })) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  const options = { backlogDir: join(home, 'backlog'), operatorDir: join(home, '.config', 'bl'), kinds: KINDS };
  return withEnv({ HOME: home }, () => loadConfiguration(options));
}

/** The fault lines of a load that must fail. */
function faultLines(files) {
  try {
    load(files);
  } catch (error) {
    if (error instanceof ConfigurationFaults) return error.message.split('\n');
    throw error;
  }
  assert.fail('the load gave no fault');
}

test('KINDS lists commands, views and color-schemes with their paths and orders', () => {
  const shape = (name) => {
    const { shop, operator, order } = KINDS.find((kind) => kind.name === name) ?? {};
    return { shop, operator, order };
  };
  assert.deepEqual(shape('commands'), { shop: 'config/commands.yaml', operator: undefined, order: 'none' });
  assert.deepEqual(shape('views'), { shop: 'config/views.yaml', operator: 'views.yaml', order: 'who' });
  assert.deepEqual(shape('color-schemes'), {
    shop: 'config/color-schemes/',
    operator: 'color-schemes/',
    order: 'who',
  });
  assert.ok(KINDS.every((kind) => Object.isFrozen(kind)));
});

test('valid files of every kind load, and file(kind, name) returns each', () => {
  const config = load({
    'backlog/config/commands.yaml': COMMANDS,
    'backlog/config/views.yaml': VIEWS,
    'backlog/config/color-schemes/mocha.yaml': MOCHA,
  });
  assert.equal(config.scope(null).color_scheme, 'mocha');
  assert.deepEqual(config.file('commands').run, { entry: 'run', help: 'Run a work unit' });
  assert.deepEqual(config.file('commands').list.args, ['--sort', 'rank']);
  assert.deepEqual(Object.keys(config.file('views')), ['list', 'item', 'flow-chart']);
  assert.deepEqual(config.file('color-schemes', 'mocha.yaml'), { match: ['bold', '#f9e2af'], closed: ['dim'] });
});

test("an operator views.yaml is patched over the shop's", () => {
  const config = load({
    'backlog/config/views.yaml': VIEWS,
    '.config/bl/views.yaml': "item: { template: '{{title}}' }\nlist: { footer: null }\n",
  });
  assert.deepEqual(config.file('views').item, { template: '{{title}}' });
  assert.equal(config.file('views').list.footer, undefined);
  assert.equal(config.file('views').list.columns.length, 2);
});

test("an operator color scheme is patched over the shop's, and one with a new name adds a scheme", () => {
  const config = load({
    'backlog/config/color-schemes/mocha.yaml': MOCHA,
    '.config/bl/color-schemes/mocha.yaml': 'closed: [gray, strikethrough]\n',
    '.config/bl/color-schemes/mine.yaml': 'match: [underline]\n',
  });
  assert.deepEqual(config.file('color-schemes', 'mocha.yaml'), {
    match: ['bold', '#f9e2af'],
    closed: ['gray', 'strikethrough'],
  });
  assert.deepEqual(config.file('color-schemes', 'mine.yaml'), { match: ['underline'] });
});

test('an operator commands.yaml is not read', () => {
  const config = load({ 'backlog/config/commands.yaml': COMMANDS, '.config/bl/commands.yaml': 'x: [\n' });
  assert.deepEqual(Object.keys(config.file('commands')), ['list', 'run']);
});

/**
 * Each refused shape is a fault that names its file and path: `[files, line]`,
 * where `line` is one of the load's fault lines.
 */
const REFUSED = [
  [
    { 'backlog/config/commands.yaml': 'list: { op: list, entry: list, help: x }\n' },
    'config/commands.yaml: /list: oneOf: must match exactly one schema in oneOf',
  ],
  [
    { 'backlog/config/commands.yaml': 'list: { help: x }\n' },
    'config/commands.yaml: /list: oneOf: must match exactly one schema in oneOf',
  ],
  [
    { 'backlog/config/commands.yaml': 'list: { op: list }\n' },
    "config/commands.yaml: /list/help: required: must have required property 'help'",
  ],
  [
    { 'backlog/config/views.yaml': "list: { columns: [], template: 'x' }\n" },
    'config/views.yaml: /list: oneOf: must match exactly one schema in oneOf',
  ],
  [
    { 'backlog/config/views.yaml': "list: { template: 'x', records_template: 'y' }\n" },
    'config/views.yaml: /list: oneOf: must match exactly one schema in oneOf',
  ],
  ...['field', 'header', 'justify', 'truncate'].map((key) => {
    const column = { field: 'a', header: 'A', justify: 'left', truncate: false };
    delete column[key];
    return [
      { '.config/bl/views.yaml': `list: { columns: [${JSON.stringify(column)}] }\n` },
      `~/.config/bl/views.yaml: /list/columns/0/${key}: required: must have required property '${key}'`,
    ];
  }),
  [
    { 'backlog/config/views.yaml': 'list: { columns: [{ field: a, header: A, justify: middle, truncate: false }] }\n' },
    'config/views.yaml: /list/columns/0/justify: enum: must be equal to one of the allowed values',
  ],
  [
    { 'backlog/config/color-schemes/mocha.yaml': 'closed: [dim]\n' },
    "config/color-schemes/mocha.yaml: /match: required: must have required property 'match'",
  ],
  [
    { 'backlog/config/color-schemes/mocha.yaml': 'match: [bold]\nclosed: []\n' },
    'config/color-schemes/mocha.yaml: /closed: minItems: must NOT have fewer than 1 items',
  ],
  [
    { 'backlog/config/color-schemes/mocha.yaml': MOCHA, '.config/bl/color-schemes/mocha.yaml': 'match: []\n' },
    '~/.config/bl/color-schemes/mocha.yaml: /match: minItems: must NOT have fewer than 1 items',
  ],
  [
    { 'backlog/backlog.yaml': 'repos: {}\n' },
    "backlog.yaml: /color_scheme: required: must have required property 'color_scheme'",
  ],
];

test('each refused shape is a configuration fault with its file and path', () => {
  for (const [files, line] of REFUSED) {
    const lines = faultLines(files);
    assert.ok(lines.includes(line), `${JSON.stringify(files)}:\n${lines.join('\n')}`);
  }
});

test('no string in views.schema.json carries the cel keyword', () => {
  const views = KINDS.find((kind) => kind.name === 'views')?.schema;
  const hasCel = (node) =>
    node !== null && typeof node === 'object' && (Object.hasOwn(node, 'cel') || Object.values(node).some(hasCel));
  assert.equal(hasCel(views), false);
});
