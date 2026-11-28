/**
 * The parser and the run of one command (F-138 D3), on a fixture backlog
 * loaded with the shipped kinds and a fixture ops map.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigurationFaults } from '../config/check.js';
import { KINDS } from '../config/kinds.js';
import { loadConfiguration } from '../config/load.js';
import { ALERTS, TEMPLATES } from '../test/helpers/config-fixture.js';
import { withEnv } from '../test/helpers/env.js';
import { buildLoaded, step } from '../test/helpers/flow-fixture.js';
import { ESCAPE, recorder } from '../test/helpers/streams.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { blIn, CommandFailed, dispatch, entryArgFaults, runInProcess, startFaults } from './dispatch.js';
import { writeOutput } from './output.js';

/** The fixture op: it gives back its arguments and its context. */
const echo = {
  args: {
    ids: { nargs: '*', help: 'the items to show' },
    '--limit': { type: 'int', help: 'at most this many' },
    '--state': { choices: ['open', 'done'], default: 'open', help: 'the state to show' },
  },
  schema: { type: 'object' },
  run: async (args, ctx) => ({ args, ctx }),
};
const OPS = Object.freeze({ echo });

const COMMANDS = `
list:
  op: echo
  help: list the items
  description: Lists the items of the backlog.
open:
  op: echo
  help: list the open items
  args: [--state, done, --limit, '5']
start:
  entry: start
  help: start an item
`;

/** The `--agent` option of the entry `start`, with the `sets` and `steps` of an override (F-152 D4). */
const AGENT = { metavar: 'profile', nargs: 1, help: 'the agent profile', sets: 'agents', steps: ['implement'] };

/**
 * The flow set of every fixture: the story and task flows both have the entry `start`, with one
 * `--agent` option declared alike, and the task's with `--dry-run` too.
 */
const FLOW_SET = Object.freeze({
  flows: {
    story: { entries: { start: { from: ['draft'], start: 'work', args: { '--agent': AGENT } } } },
    task: {
      entries: {
        start: {
          from: ['draft'],
          start: 'work',
          args: { '--agent': AGENT, '--dry-run': { action: 'store_true', help: 'change nothing' } },
        },
      },
    },
  },
});

/** The shop's `mocha` color scheme of every fixture. */
const MOCHA = 'match: [bold, "#f9e2af"]\n';

/**
 * A loaded configuration of a fixture backlog with `commands` as its
 * commands.yaml, and with `views` and `operatorViews` as the shop's and the
 * operator's views.yaml when given. The backlog names the color scheme
 * `mocha`; `schemes` are the shop's color-scheme files, name → text, and
 * `operatorSchemes` the operator's. `registry` is added to backlog.yaml.
 * `alerts` is config/alerts.yaml, and `templates` the shop's language files,
 * name → text. The context's flow set is `FLOW_SET`.
 */
function fixture(
  commands = COMMANDS,
  {
    views,
    operatorViews,
    schemes = { mocha: MOCHA },
    operatorSchemes = {},
    registry = '',
    alerts = ALERTS,
    templates = { 'en.yaml': TEMPLATES },
  } = {},
) {
  const backlogDir = mkTempDir('bl-dispatch-');
  const operatorDir = join(backlogDir, 'operator');
  writeFileSync(join(backlogDir, 'backlog.yaml'), `color_scheme: mocha\nlanguage: en\nrepos: {}\n${registry}`);
  mkdirSync(join(backlogDir, 'config', 'color-schemes'), { recursive: true });
  mkdirSync(join(operatorDir, 'color-schemes'), { recursive: true });
  for (const [name, text] of Object.entries(schemes)) {
    writeFileSync(join(backlogDir, 'config', 'color-schemes', `${name}.yaml`), text);
  }
  for (const [name, text] of Object.entries(operatorSchemes)) {
    writeFileSync(join(operatorDir, 'color-schemes', `${name}.yaml`), text);
  }
  writeFileSync(join(backlogDir, 'config', 'commands.yaml'), commands);
  writeFileSync(join(backlogDir, 'config', 'alerts.yaml'), alerts);
  mkdirSync(join(backlogDir, 'config', 'templates'), { recursive: true });
  for (const [name, text] of Object.entries(templates)) {
    writeFileSync(join(backlogDir, 'config', 'templates', name), text);
  }
  if (views !== undefined) writeFileSync(join(backlogDir, 'config', 'views.yaml'), views);
  if (operatorViews !== undefined) writeFileSync(join(operatorDir, 'views.yaml'), operatorViews);
  const config = loadConfiguration({ backlogDir, operatorDir, kinds: KINDS });
  return { config, backlogDir, flowSet: FLOW_SET };
}

const run = (argv, at = fixture()) => dispatch(argv, { ...at, ops: OPS });

test('dispatch runs the named op with the parsed arguments and the context', async () => {
  const at = fixture();
  const outcome = await run(['list', 'F-1', 'S-2', '--limit', '3'], at);
  assert.equal(outcome.name, 'list');
  assert.equal(outcome.op, echo);
  const expected = { ids: ['F-1', 'S-2'], limit: 3, state: 'open', json: false };
  assert.deepEqual(outcome.args, expected);
  assert.deepEqual(outcome.result, {
    args: expected,
    ctx: { config: at.config, backlogDir: at.backlogDir, flowSet: FLOW_SET },
  });
});

test("a line's args go before the caller's arguments, so the caller's win", async () => {
  assert.deepEqual((await run(['open'])).args, { ids: [], limit: 5, state: 'done', json: false });
  assert.deepEqual((await run(['open', '--limit', '2', '--json'])).args, {
    ids: [],
    limit: 2,
    state: 'done',
    json: true,
  });
});

test('--help lists each command with its help', async () => {
  const { status, stdout, stderr } = await run(['--help']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^usage: bl-next \[-h\] command \.\.\./);
  assert.match(stdout, /\n {4}list +list the items\n/);
  assert.match(stdout, /\n {4}open +list the open items\n/);
  assert.match(stdout, /\n {4}start +start an item\n/);
});

test("<name> --help shows the description and the op's arguments", async () => {
  const { status, stdout } = await run(['list', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^usage: bl-next list /);
  assert.match(stdout, /\nLists the items of the backlog\.\n/);
  assert.match(stdout, /\n {2}ids +the items to show\n/);
  assert.match(stdout, /\n {2}--limit LIMIT +at most this many\n/);
  assert.match(stdout, /\n {2}--state \{open,done\}/);
  assert.match(stdout, /\n {2}--json +print the records as JSON\n/);
});

test('an unknown command exits 2 and suggests the closest names', async () => {
  assert.deepEqual(await run(['lsit']), {
    status: 2,
    stdout: '',
    stderr: "bl-next: 'lsit' is not a command. Did you mean 'list'?\n",
  });
  assert.equal((await run(['opn'])).stderr, "bl-next: 'opn' is not a command. Did you mean 'open'?\n");
});

test('an unknown command with no name within distance 2 has no second sentence', async () => {
  assert.deepEqual(await run(['frobnicate', '--json']), {
    status: 2,
    stdout: '',
    stderr: "bl-next: 'frobnicate' is not a command.\n",
  });
});

test("an unknown option exits 2 and suggests from the command's options", async () => {
  const outcome = await run(['list', '--limt', '3']);
  assert.equal(outcome.status, 2);
  assert.equal(outcome.stderr, "bl-next: '--limt' is not an option of 'list'. Did you mean '--limit'?\n");
  assert.equal((await run(['list', '--frobnicate'])).stderr, "bl-next: '--frobnicate' is not an option of 'list'.\n");
});

test('a bad value or no command is an argparse error with the usage, exit 2', async () => {
  const bad = await run(['list', '--limit', 'many']);
  assert.equal(bad.status, 2);
  assert.match(
    bad.stderr,
    /^usage: bl-next list .*\nbl-next list: error: argument --limit: invalid 'int' value: 'many'\n$/s,
  );
  const none = await run([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /bl-next: error: the following arguments are required: command\n$/);
});

// ---------------------------------------------------------------------------
// entry commands (F-152 D6)
// ---------------------------------------------------------------------------

test("<entry> --help lists the id and the options of every flow's entry of that name, each once, with the item types that accept each, without sets and steps", async () => {
  const { status, stdout } = await run(['start', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^usage: bl-next start \[-h\] \[--agent profile\] \[--dry-run\] \[--json\] id\n/);
  assert.match(stdout, /\n {2}id +the item \(item types: story, task\)\n/);
  assert.match(stdout, /\n {2}--agent profile +the agent profile \(item types: story, task\)\n/);
  // Only the task flow's entry declares --dry-run.
  assert.match(stdout, /\n {2}--dry-run +change nothing \(item types: task\)\n/);
  assert.match(stdout, /\n {2}--json +print the records as JSON\n/);
  assert.equal(stdout.split('--agent profile').length - 1, 2, 'once in the usage and once in the options');
  assert.doesNotMatch(stdout, /sets|steps|agents|implement/);
});

test('an entry command needs the id, suggests its options, and runs the entry with the parsed arguments', async () => {
  const none = await run(['start']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /bl-next start: error: the following arguments are required: id\n$/);
  assert.equal(
    (await run(['start', 'S-1', '--agnet'])).stderr,
    "bl-next: '--agnet' is not an option of 'start'. Did you mean '--agent'?\n",
  );
  // The fixture backlog has no item types: the entry runs, and refuses the id.
  await assert.rejects(run(['start', 'S-1', '--agent', 'p']), /not an item id: "S-1"/);
});

/**
 * The fault lines of `entryArgFaults` for a flow set whose story and task flows each have a `fix`
 * entry with the options `story` and `task`.
 * @param {Record<string, object>} story
 * @param {Record<string, object>} [task]
 */
function entryArgLines(story, task = {}) {
  const flow = (/** @type {Record<string, object>} */ args) => ({
    initial: 'draft',
    statuses: { draft: {} },
    entries: { fix: { from: ['draft'], start: 'fix', args } },
    steps: { fix: { success: 'stop', failure: 'stop' } },
  });
  const { config, backlogDir, flowSet } = buildLoaded(
    {
      'settings.yaml': { max_box_visits: 20, gate_recheck_minutes: 15 },
      'steps.yaml': { defined_steps: { fix: { use: 'agent', with: { agents: ['replay'] } } } },
      'story.yaml': { flows: { story: flow(story) } },
      'task.yaml': { flows: { task: flow(task) } },
    },
    { agent: step({ type: 'object', properties: { agents: {} } }) },
  );
  const faults = entryArgFaults(config, flowSet);
  return faults.length === 0 ? [] : new ConfigurationFaults(faults, backlogDir).message.split('\n');
}

test('entryArgFaults_rejects_reserved_entry_arguments: the parser of the entry command refuses each', () => {
  const at = (/** @type {string} */ name) =>
    `config/flows/story.yaml: /flows/story/entries/fix/args/${name}: args: the parser of the entry command 'fix' refuses '${name}':`;
  for (const [name, options, why] of /** @type {const} */ ([
    ['--json', {}, 'argument --json: conflicting option string: --json'],
    ['--help', {}, 'argument --help: conflicting option string: --help'],
    ['-h', {}, 'argument -h: conflicting option string: -h'],
    ['id', {}, "it stores its value under 'id', as id does"],
    ['--id', {}, "it stores its value under 'id', as id does"],
    ['--out', { dest: 'json' }, "it stores its value under 'json', as --json does"],
  ])) {
    assert.deepEqual(entryArgLines({ [name]: options }), [`${at(name)} ${why}`], `${name} ${JSON.stringify(options)}`);
  }
  // argparse's help action stores no value, so an option may store under `help`.
  for (const [name, options] of /** @type {const} */ ([
    ['--json-out', {}],
    ['--agent', {}],
    ['-a', {}],
    ['target', {}],
    ['--to', { dest: 'help' }],
  ])) {
    assert.deepEqual(entryArgLines({ [name]: options }), [], name);
  }
});

test('startFaults names config/commands.yaml and /<name>/op for each op that the ops map does not hold', () => {
  const at = fixture(`${COMMANDS}\nshow:\n  op: item\n  help: show one item\n`);
  assert.equal(
    new ConfigurationFaults(startFaults(at.config, OPS), at.backlogDir).message,
    "config/commands.yaml: /show/op: op: no op named 'item'",
  );
  assert.deepEqual(startFaults(fixture().config, OPS), []);
});

// ---------------------------------------------------------------------------
// the start check of the views (D3 step 1, D5)
// ---------------------------------------------------------------------------

/** An op whose records have `id`, `title` and `depth` at top level. */
const story = {
  args: {},
  schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, depth: {} } },
  run: () => [],
};
const VIEW_OPS = Object.freeze({ ...OPS, story });
const VIEW_COMMANDS = `${COMMANDS}\nstories:\n  op: story\n  help: list stories\n`;

/** The fault lines of the start check on a fixture with these views. */
function viewFaults(views, operatorViews) {
  const at = fixture(VIEW_COMMANDS, { views, operatorViews });
  const faults = startFaults(at.config, VIEW_OPS);
  return faults.length === 0 ? '' : new ConfigurationFaults(faults, at.backlogDir).message;
}

const GOOD_VIEW = `
stories:
  columns:
    - { field: id, header: ID, justify: left, truncate: false, style: 'depth > 0 ? "child" : ""' }
    - { field: record.title, header: Title, justify: left, truncate: true, indent: depth }
  style: '""'
  footer: 'string(size(records)) + " stories"'
`;

test('views whose expressions name top-level fields, record or records pass the start check', () => {
  assert.equal(viewFaults(GOOD_VIEW), '');
});

test('view_environment_accepts_reserved_record_fields: an op schema with record or records passes the start check', () => {
  for (const name of ['record', 'records']) {
    const ops = { ...OPS, story: { ...story, schema: { type: 'object', properties: { [name]: { type: 'string' } } } } };
    const views = `stories:\n  columns:\n    - { field: record.${name}, header: H, justify: left, truncate: false }\n  footer: 'string(size(records))'\n`;
    const at = fixture(VIEW_COMMANDS, { views });
    assert.deepEqual(startFaults(at.config, ops), [], name);
  }
});

test('a view expression with a syntax error or an unknown top-level name is a fault in config/views.yaml at its path', () => {
  const views = `
stories:
  columns:
    - { field: 'id +', header: ID, justify: left, truncate: false }
    - { field: points, header: Points, justify: right, truncate: false, indent: level, style: 'id' }
  style: owner
  footer: 'size(items)'
`;
  assert.deepEqual(viewFaults(views).split('\n'), [
    'config/views.yaml: /stories/columns/0/field: cel: Unexpected token: EOF',
    'config/views.yaml: /stories/columns/1/field: cel: Unknown variable: points',
    'config/views.yaml: /stories/columns/1/indent: cel: Unknown variable: level',
    'config/views.yaml: /stories/footer: cel: Unknown variable: items',
    'config/views.yaml: /stories/style: cel: Unknown variable: owner',
  ]);
});

test('a view of an entry command is checked against the entry record schema: its fields, and item_id', () => {
  const view = (/** @type {string} */ field) =>
    `start:\n  columns:\n    - { field: item_id, header: Item, justify: left, truncate: false }\n    - { field: ${field}, header: X, justify: left, truncate: false }\n`;
  for (const field of ['event', 'box', 'ended', 'step', 'input', 'record.note'])
    assert.equal(viewFaults(view(field)), '', field);
  assert.equal(viewFaults(view('nosuch')), 'config/views.yaml: /start/columns/1/field: cel: Unknown variable: nosuch');
});

test('a view key that names no command is a fault at /<name>', () => {
  assert.equal(
    viewFaults(`${GOOD_VIEW}\nstoreis:\n  template: '{{id}}'\n`),
    "config/views.yaml: /storeis: view: no command named 'storeis'",
  );
});

test("an operator views.yaml that patches a column list gives the fault in the operator's file", () => {
  const operatorViews = `
stories:
  columns:
    - { field: id, header: ID, justify: left, truncate: false }
    - { field: titel, header: Title, justify: left, truncate: true }
`;
  assert.equal(
    viewFaults(GOOD_VIEW, operatorViews),
    'operator/views.yaml: /stories/columns/1/field: cel: Unknown variable: titel',
  );
  // The shop's footer, which the operator's patch keeps, is still the shop's.
  assert.equal(
    viewFaults(GOOD_VIEW.replace('size(records)', 'size(recrods)'), operatorViews).split('\n')[0],
    'config/views.yaml: /stories/footer: cel: Unknown variable: recrods',
  );
});

// ---------------------------------------------------------------------------
// the start check of the color scheme (D8)
// ---------------------------------------------------------------------------

/** The fault lines of the start check on a fixture with these color schemes. */
function schemeFaults(options) {
  const at = fixture(COMMANDS, options);
  const faults = startFaults(at.config, OPS);
  return faults.length === 0 ? '' : new ConfigurationFaults(faults, at.backlogDir).message;
}

test('a color_scheme that no layer has is a fault in backlog.yaml at /color_scheme', () => {
  assert.equal(
    schemeFaults({ schemes: { latte: MOCHA } }),
    "backlog.yaml: /color_scheme: color_scheme: no color scheme named 'mocha'",
  );
  // The operator's directory alone may hold it.
  assert.equal(schemeFaults({ schemes: {}, operatorSchemes: { mocha: MOCHA } }), '');
});

test('a format that util.styleText refuses is a fault in the scheme file that writes it, at its path', () => {
  assert.equal(
    schemeFaults({ schemes: { mocha: 'match: [blod]\ndone: [green, "#zzz"]\n' } }),
    [
      "config/color-schemes/mocha.yaml: /done/1: format: '#zzz' is not a util.styleText format",
      "config/color-schemes/mocha.yaml: /match/0: format: 'blod' is not a util.styleText format",
    ].join('\n'),
  );
  assert.equal(
    schemeFaults({ operatorSchemes: { mocha: 'done: [blod]\n' } }),
    "operator/color-schemes/mocha.yaml: /done/0: format: 'blod' is not a util.styleText format",
  );
});

// ---------------------------------------------------------------------------
// the start check of the plugin commands (F-140 D3, Decision A5)
// ---------------------------------------------------------------------------

test('startFaults gives a raw-name fault for {{{with.a}}} in a shop step and {{& message}} in a channel, none for {{with.a}}', () => {
  const registry = [
    'plugin_registry:',
    '  steps: { tag: "tag {{{with.a}}}", fine: "tag {{with.a}}" }',
    '  stages: { bl.notify: { terminal: "echo {{& message}}" } }',
    '',
  ].join('\n');
  const at = fixture(COMMANDS, { registry });
  const raw = (name) => `'${name}' is filled raw, which puts its value into the command; write {{${name}}}`;
  assert.equal(
    new ConfigurationFaults(startFaults(at.config, OPS), at.backlogDir).message,
    [
      `backlog.yaml: /plugin_registry/stages/bl.notify/terminal: raw-name: ${raw('message')}`,
      `backlog.yaml: /plugin_registry/steps/tag: raw-name: ${raw('with.a')}`,
    ].join('\n'),
  );
  const fine = fixture(COMMANDS, { registry: 'plugin_registry: { steps: { fine: "tag {{with.a}}" } }\n' });
  assert.deepEqual(startFaults(fine.config, OPS), []);
});

// ---------------------------------------------------------------------------
// the start check of the notifications (F-140 D9)
// ---------------------------------------------------------------------------

test('startFaults gives one fault for a route to a channel that bl.notify does not define, at the route entry', () => {
  const registry = 'plugin_registry: { stages: { bl.notify: { terminal: "echo {{message}}" } } }\n';
  const alerts = 'gated: [terminal]\nended: []\nnotify: [terminal]\nnotify.escalation: [terminal, bel]\n';
  const at = fixture(COMMANDS, { registry, alerts });
  assert.equal(
    new ConfigurationFaults(startFaults(at.config, OPS), at.backlogDir).message,
    "config/alerts.yaml: /notify.escalation/1: channel: no bl.notify channel named 'bel'",
  );
  // With no bl.notify at all, each named channel is a fault.
  assert.equal(startFaults(fixture(COMMANDS, { alerts }).config, OPS).length, 4);
  assert.deepEqual(startFaults(fixture(COMMANDS, { registry }).config, OPS), []);
});

test('startFaults gives one fault for a language that has no template file, at /language', () => {
  const at = fixture(COMMANDS, { templates: { 'de.yaml': TEMPLATES } });
  assert.equal(
    new ConfigurationFaults(startFaults(at.config, OPS), at.backlogDir).message,
    "backlog.yaml: /language: language: the language 'en' has no template file templates/en.yaml",
  );
});

// ---------------------------------------------------------------------------
// runInProcess: the {{#bl}} lambda (D7)
// ---------------------------------------------------------------------------

/** An op that gives two records; the first's title is its `--flag`, the second's has `|` and a newline. */
const rows = {
  args: { '--flag': { help: 'the first title' } },
  schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
  run: (args) => [
    { id: 'S-1', title: args.flag },
    { id: 'S-2', title: 'a|b\nc' },
  ],
};
const BL_OPS = Object.freeze({ ...OPS, rows });
const BL_COMMANDS = `${COMMANDS}\nrows:\n  op: rows\n  help: two rows\npage:\n  op: rows\n  help: a page\n`;
const BL_VIEWS = `
rows:
  columns:
    - { field: id, header: ID, justify: left, truncate: true }
    - { field: title, header: Title, justify: right, truncate: true }
page:
  records_template: "{{#records}}{{id}}{{/records}}\\n{{#bl}}rows --flag 'from {{#records}}{{id}}{{/records}}'{{/bl}}"
`;

const inProcess = (line) => {
  const at = fixture(BL_COMMANDS, { views: BL_VIEWS });
  return runInProcess(line, { ...at, ops: BL_OPS });
};

test('runInProcess splits the line as a shell does, runs the command and gives the Markdown table', async () => {
  assert.equal(
    await inProcess('rows --flag "a b"'),
    '| ID | Title |\n| :-- | --: |\n| S-1 | a b |\n| S-2 | a\\|b c |\n',
  );
});

test('runInProcess renders a template view, whose own {{#bl}} lines run in the same process', async () => {
  assert.equal(
    await inProcess('page --flag x'),
    'S-1S-2\n| ID | Title |\n| :-- | --: |\n| S-1 | from S-1S-2 |\n| S-2 | a\\|b c |\n',
  );
});

test('runInProcess with --json, or with no view, gives the structured form', async () => {
  const lines = '{"id":"S-1","title":"x"}\n{"id":"S-2","title":"a|b\\nc"}\n';
  assert.equal(await inProcess('rows --flag x --json'), lines);
  const at = fixture(BL_COMMANDS);
  assert.equal(await runInProcess('rows --flag x', { ...at, ops: BL_OPS }), lines);
});

test('with FORCE_COLOR=1, the Markdown form of {{#bl}} has no escape codes, where the table has them', async () => {
  // The op names `--flag` as its search pattern, and the view styles the cells and the rows.
  const styledOps = Object.freeze({ ...BL_OPS, rows: { ...rows, pattern: 'flag' } });
  const views = BL_VIEWS.replace('truncate: true }', 'truncate: true, style: \'"hit"\' }').replace(
    'rows:\n  columns:',
    'rows:\n  style: \'"hit"\'\n  columns:',
  );
  const at = fixture(BL_COMMANDS, { views, schemes: { mocha: `${MOCHA}hit: [red]\n` } });
  const context = { ...at, ops: styledOps };
  assert.deepEqual(startFaults(at.config, styledOps), []);
  const { stream, chunks } = recorder();
  const color = { FORCE_COLOR: '1', NO_COLOR: undefined };
  const [markdown, page] = await withEnv(color, async () => {
    const outcome = await dispatch(['rows', '--flag', 'S'], context);
    await writeOutput({ command: 'rows', ...outcome, config: at.config, stdout: stream });
    return [await runInProcess('rows --flag S', context), await runInProcess('page --flag S', context)];
  });
  assert.match(chunks.join(''), ESCAPE);
  assert.doesNotMatch(markdown, ESCAPE);
  assert.doesNotMatch(page, ESCAPE);
  assert.equal(markdown, '| ID | Title |\n| :-- | --: |\n| S-1 | S |\n| S-2 | a\\|b c |\n');
});

test('runInProcess refuses a shell operator outside quotes, and takes one inside quotes', async () => {
  for (const [line, operator] of [
    ['rows | sort', '|'],
    ['rows > out.txt', '>'],
    ['rows; rows', ';'],
  ]) {
    await assert.rejects(inProcess(line), (error) => {
      assert.ok(error instanceof CommandFailed, line);
      assert.equal(error.exit.status, 2);
      assert.equal(error.exit.stderr, `bl-next: {{#bl}} ${line}: '${operator}' is a shell operator\n`);
      return true;
    });
  }
  assert.match(await inProcess("rows --flag 'x | y > z'"), /\| S-1 \| x \\\| y > z \|/);
});

test('dispatch_rejects_invalid_pattern_before_op_run: an invalid search pattern exits 2 and runs no op', async () => {
  let runs = 0;
  const counted = { ...rows, pattern: 'flag', run: (args) => (runs++, rows.run(args)) };
  const ops = Object.freeze({ ...BL_OPS, rows: counted });
  const stderr = 'bl-next NAME: error: Invalid regular expression: /[/g: Unterminated character class\n';
  for (const [label, views, command, extra] of [
    ['columns view', BL_VIEWS, 'rows', []],
    ['--json', BL_VIEWS, 'rows', ['--json']],
    ['no view', undefined, 'rows', []],
    ['template view', BL_VIEWS, 'page', []],
  ]) {
    const context = { ...fixture(BL_COMMANDS, { views }), ops };
    assert.deepEqual(
      await dispatch([command, '--flag', '[', ...extra], context),
      { status: 2, stdout: '', stderr: stderr.replace('NAME', command) },
      label,
    );
    await assert.rejects(runInProcess(`${command} --flag '[' ${extra.join(' ')}`, context), (error) => {
      assert.ok(error instanceof CommandFailed, label);
      assert.equal(error.exit.stderr, stderr.replace('NAME', command), label);
      return true;
    });
  }
  assert.equal(runs, 0);
  // A valid pattern and an empty one run the op.
  const context = { ...fixture(BL_COMMANDS, { views: BL_VIEWS }), ops };
  assert.equal((await dispatch(['rows', '--flag', 'S-?'], context)).name, 'rows');
  assert.equal((await dispatch(['rows', '--flag', ''], context)).name, 'rows');
  assert.equal(runs, 2);
});

test('template_bl_rejects_recursive_commands: a {{#bl}} line that runs a command of its own chain fails before its op runs', async () => {
  let runs = 0;
  const counted = { ...rows, run: (args) => (runs++, rows.run(args)) };
  const ops = Object.freeze({ ...BL_OPS, rows: counted });
  const commands = ['self', 'each', 'ping', 'pong', 'part'].map((n) => `${n}:\n  op: rows\n  help: ${n}\n`).join('');
  const views = `
self:
  records_template: '{{#bl}}self --flag x{{/bl}}'
each:
  template: '{{#bl}}each{{/bl}}'
ping:
  records_template: '{{#bl}}pong{{/bl}}'
pong:
  records_template: '{{#bl}}ping{{/bl}}'
part:
  records_template: '{{> loop}}'
`;
  const at = fixture(`${BL_COMMANDS}${commands}`, { views: `${BL_VIEWS}${views}` });
  const partial = (name) => (name === 'loop' ? '{{#bl}}part{{/bl}}' : undefined);
  const context = { ...at, config: { ...at.config, partial }, ops };
  for (const [line, failing, cycle, expectedRuns] of [
    ['self', 'self --flag x', 'self → self', 1],
    ['each', 'each', 'each → each', 1],
    ['ping', 'ping', 'ping → pong → ping', 2],
    ['part', 'part', 'part → part', 1],
  ]) {
    runs = 0;
    await assert.rejects(runInProcess(line, context), (error) => {
      assert.ok(error instanceof CommandFailed, line);
      assert.equal(
        error.exit.stderr,
        `bl-next: {{#bl}} ${failing}: '${failing.split(' ')[0]}' runs itself: ${cycle}\n`,
      );
      return true;
    });
    assert.equal(runs, expectedRuns, line);
  }
  // From the outer command (main passes its name), the first inner run is already refused.
  runs = 0;
  const outcome = await dispatch(['self'], context);
  await assert.rejects(
    writeOutput({
      command: 'self',
      ...outcome,
      config: context.config,
      stdout: recorder().stream,
      bl: blIn(context, ['self']),
    }),
    (error) => error instanceof CommandFailed && /'self' runs itself: self → self/.test(error.message),
  );
  assert.equal(runs, 1);
  // A line that runs another command, as each record of `rows` does, still runs.
  assert.match(await runInProcess('page --flag x', context), /\| S-1 \| from S-1S-2 \|/);
});

test('run_in_process_rejects_incomplete_shell_quote: an unfinished quote or a trailing backslash fails before the op runs', async () => {
  let runs = 0;
  const counted = { ...rows, run: (args) => (runs++, rows.run(args)) };
  const context = { ...fixture(BL_COMMANDS, { views: BL_VIEWS }), ops: Object.freeze({ ...BL_OPS, rows: counted }) };
  for (const line of [
    "rows --flag 'unfinished",
    'rows --flag "unfinished',
    'rows --flag trailing\\',
    'rows \\',
    'rows --flag \'a" b',
    'rows --flag "a\' b',
    "rows --flag $'abc",
    'rows --flag "a\\',
  ]) {
    await assert.rejects(runInProcess(line, context), (error) => {
      assert.ok(error instanceof CommandFailed, line);
      assert.deepEqual(error.exit, {
        status: 2,
        stdout: '',
        stderr: `bl-next: {{#bl}} ${line}: unfinished quote or trailing backslash\n`,
      });
      return true;
    });
  }
  assert.equal(runs, 0);
  // Complete quoted arguments run, with each word as a shell gives it.
  for (const [line, title] of [
    ['rows --flag "a b"', 'a b'],
    ["rows --flag 'it''s'", 'its'],
    ['rows --flag a\\ b', 'a b'],
    ['rows --flag "a\\"b"', 'a"b'],
    ["rows --flag $'a\\'b'", "a'b"],
    ['rows --flag \\\\', '\\'],
    ['rows --flag ""', ''],
  ]) {
    assert.ok((await runInProcess(line, context)).includes(`| S-1 | ${title} |`), line);
  }
  assert.equal(runs, 7);
  // An operator, help and an argument error keep their own messages.
  await assert.rejects(runInProcess("rows | 'x", context), /'\|' is a shell operator/);
  assert.match(await runInProcess('rows --help', context), /^usage: bl-next rows /);
  await assert.rejects(runInProcess('rows --flg x', context), /'--flg' is not an option of 'rows'/);
});

test('an inner command that fails gives CommandFailed with its exit', async () => {
  await assert.rejects(inProcess('rosw'), (error) => {
    assert.ok(error instanceof CommandFailed);
    assert.deepEqual(error.exit, {
      status: 2,
      stdout: '',
      stderr: "bl-next: 'rosw' is not a command. Did you mean 'rows'?\n",
    });
    assert.equal(error.message, "bl-next: 'rosw' is not a command. Did you mean 'rows'?");
    return true;
  });
});
