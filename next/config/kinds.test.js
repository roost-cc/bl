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
import { ALERTS, ALERTS_PATH, fixtureText } from '../test/helpers/config-fixture.js';
import { withEnv } from '../test/helpers/env.js';
import { mkTempDir } from '../test/helpers/tempdir.js';

const SHOP = { 'backlog/backlog.yaml': 'color_scheme: mocha\nlanguage: en\nrepos: {}\n', [ALERTS_PATH]: ALERTS };

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

test('KINDS lists commands, views, color-schemes, alerts and templates with their paths and orders', () => {
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
  assert.deepEqual(shape('alerts'), { shop: 'config/alerts.yaml', operator: 'alerts.yaml', order: 'who' });
  assert.deepEqual(shape('templates'), { shop: 'config/templates/', operator: 'templates/', order: 'who' });
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

/** The uTop sample's `repos` and `plugin_registry` (backlog.yaml), in a fixture backlog. */
const UTOP_BACKLOG = `color_scheme: mocha
language: en
repos:
  utop:
    plugin_registry:
      stages:
        bl.test:
          test:
            unit: go test ./...
            integration: go test -tags integration ./...
            merge: go test ./... && go test -tags integration ./...
        bl.regenerate: [go-sum]
plugin_registry:
  stages:
    go-sum:
      regenerate: go mod tidy
      paths: [go.sum]
    bl.change:
      change.open: gh pr create --repo utop-dev/{{repo}} --head {{branch}} --base {{base}} --title {{title}} --body {{body}}
      change.find: gh pr list --repo utop-dev/{{repo}} --head {{branch}} --state all --json number,url --limit 1
      change.describe: gh pr edit {{change.number}} --repo utop-dev/{{repo}} --body {{body}}
      change.close: gh pr close {{change.number}} --repo utop-dev/{{repo}} --comment {{comment}}
    bl.notify:
      terminal: 'echo "bl: {{item_id}} {{message}}" > /dev/tty'
      bell: printf '\\a' > /dev/tty
  predicates:
    readme_mentions: grep -q {{args.0}} README.md
`;

test("the uTop sample's plugin_registry, alerts.yaml and templates/en.yaml load, with the operator's files patched over them", () => {
  const config = load({
    'backlog/backlog.yaml': UTOP_BACKLOG,
    [ALERTS_PATH]: fixtureText('alerts.yaml'),
    'backlog/config/templates/en.yaml': fixtureText('templates/en.yaml'),
    '.config/bl/alerts.yaml': 'ended: [bell]\nnotify.escalation: null\n',
    '.config/bl/templates/en.yaml': "ended: '{{item_id}} stopped'\n",
  });
  const top = config.scope(null);
  assert.equal(top.language, 'en');
  assert.deepEqual(Object.keys(top.plugin_registry.stages), ['go-sum', 'bl.change', 'bl.notify']);
  assert.deepEqual(config.scope('utop').plugin_registry.stages['bl.regenerate'], ['go-sum']);
  assert.deepEqual(config.celInputs, { predicates: { readme_mentions: 'grep -q {{args.0}} README.md' } });
  assert.deepEqual(config.file('alerts'), {
    gated: ['terminal'],
    'gated.expected': [],
    'gated.needs_operator_action': ['terminal', 'bell'],
    'gated.should_always_be_true': ['terminal', 'bell'],
    ended: ['bell'],
    'ended.crash': ['terminal', 'bell'],
    notify: ['terminal'],
  });
  const en = config.file('templates', 'en.yaml');
  assert.equal(en.ended, '{{item_id}} stopped');
  assert.equal(en['ended.crash'], '{{item_id}} crashed at {{box.path}}: {{error}}');
  assert.equal(en.triage_waiting, '{{item_id}} has deferred work to triage: {{title}}');
  assert.deepEqual(config.names('templates'), ['en.yaml']);
});

test('each refused alert routing is one fault with its file and path', () => {
  const required = (key, file = 'config/alerts.yaml') =>
    `${file}: /${key}: required: must have required property '${key}'`;
  const rows = [
    ['ended: []\nnotify: []\n', [required('gated')]],
    ['gated: []\nnotify: []\n', [required('ended')]],
    ['gated: []\nended: []\n', [required('notify')]],
    [
      `${ALERTS}ended.aborted: []\n`,
      ['config/alerts.yaml: /ended.aborted: additionalProperties: must NOT have additional properties'],
    ],
    [`${ALERTS}gated.expected: desktop\n`, ['config/alerts.yaml: /gated.expected: type: must be array']],
  ];
  for (const [text, lines] of rows) assert.deepEqual(faultLines({ [ALERTS_PATH]: text }), lines, text);
  // A kind's key that the operator's file deletes is a fault in that file.
  assert.deepEqual(faultLines({ '.config/bl/alerts.yaml': 'notify: null\n' }), [
    required('notify', '~/.config/bl/alerts.yaml'),
  ]);
});

test("the uTop sample's agents.yaml loads, and file('agents') gives its four profiles (F-141 D2)", () => {
  assert.deepEqual(
    (({ shop, operator, order }) => ({ shop, operator, order }))(KINDS.find((kind) => kind.name === 'agents') ?? {}),
    { shop: 'config/agents.yaml', operator: 'agents.yaml', order: 'who' },
  );
  const config = load({ 'backlog/config/agents.yaml': fixtureText('agents.yaml') });
  assert.deepEqual(config.file('agents'), {
    replay: { adapter: 'replay' },
    claude: { adapter: 'claude' },
    'claude-opus': { adapter: 'claude', model: 'opus' },
    codex: { adapter: 'codex' },
  });
});

test('each refused agent profile is a fault that names its file and path (F-141 D2)', () => {
  const rows = [
    ['p: { adapter: gemini }\n', 'config/agents.yaml: /p/adapter: enum: must be equal to one of the allowed values'],
    ['p: { model: opus }\n', "config/agents.yaml: /p/adapter: required: must have required property 'adapter'"],
    [
      'p: { adapter: replay, argv: [] }\n',
      'config/agents.yaml: /p/argv: additionalProperties: must NOT have additional properties',
    ],
    ['p: { adapter: replay, args: --fast }\n', 'config/agents.yaml: /p/args: type: must be array'],
    ['p: { adapter: replay, args: [1] }\n', 'config/agents.yaml: /p/args/0: type: must be string'],
    ['p: { adapter: replay, env: { A: 1 } }\n', 'config/agents.yaml: /p/env/A: type: must be string'],
    ['p: { adapter: replay, model: 4 }\n', 'config/agents.yaml: /p/model: type: must be string'],
  ];
  for (const [text, line] of rows) {
    assert.deepEqual(faultLines({ 'backlog/config/agents.yaml': text }), [line], text);
  }
  // An operator layer that breaks a profile names the operator's file.
  assert.deepEqual(
    faultLines({
      'backlog/config/agents.yaml': fixtureText('agents.yaml'),
      '.config/bl/agents.yaml': 'codex: { args: x }\n',
    }),
    ['~/.config/bl/agents.yaml: /codex/args: type: must be array'],
  );
});

test('no string in views.schema.json carries the cel keyword', () => {
  const views = KINDS.find((kind) => kind.name === 'views')?.schema;
  const hasCel = (node) =>
    node !== null && typeof node === 'object' && (Object.hasOwn(node, 'cel') || Object.values(node).some(hasCel));
  assert.equal(hasCel(views), false);
});
