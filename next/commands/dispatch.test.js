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
import { withEnv } from '../test/helpers/env.js';
import { ESCAPE, recorder } from '../test/helpers/streams.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { CommandFailed, dispatch, runInProcess, startFaults } from './dispatch.js';
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

/** The shop's `mocha` color scheme of every fixture. */
const MOCHA = 'match: [bold, "#f9e2af"]\n';

/**
 * A loaded configuration of a fixture backlog with `commands` as its
 * commands.yaml, and with `views` and `operatorViews` as the shop's and the
 * operator's views.yaml when given. The backlog names the color scheme
 * `mocha`; `schemes` are the shop's color-scheme files, name → text, and
 * `operatorSchemes` the operator's.
 */
function fixture(commands = COMMANDS, { views, operatorViews, schemes = { mocha: MOCHA }, operatorSchemes = {} } = {}) {
  const backlogDir = mkTempDir('bl-dispatch-');
  const operatorDir = join(backlogDir, 'operator');
  writeFileSync(join(backlogDir, 'backlog.yaml'), 'color_scheme: mocha\nrepos: {}\n');
  mkdirSync(join(backlogDir, 'config', 'color-schemes'), { recursive: true });
  mkdirSync(join(operatorDir, 'color-schemes'), { recursive: true });
  for (const [name, text] of Object.entries(schemes)) {
    writeFileSync(join(backlogDir, 'config', 'color-schemes', `${name}.yaml`), text);
  }
  for (const [name, text] of Object.entries(operatorSchemes)) {
    writeFileSync(join(operatorDir, 'color-schemes', `${name}.yaml`), text);
  }
  writeFileSync(join(backlogDir, 'config', 'commands.yaml'), commands);
  if (views !== undefined) writeFileSync(join(backlogDir, 'config', 'views.yaml'), views);
  if (operatorViews !== undefined) writeFileSync(join(operatorDir, 'views.yaml'), operatorViews);
  const config = loadConfiguration({ backlogDir, operatorDir, kinds: KINDS });
  return { config, backlogDir };
}

const run = (argv, at = fixture()) => dispatch(argv, { ...at, ops: OPS });

test('dispatch runs the named op with the parsed arguments and the context', async () => {
  const at = fixture();
  const outcome = await run(['list', 'F-1', 'S-2', '--limit', '3'], at);
  assert.equal(outcome.name, 'list');
  assert.equal(outcome.op, echo);
  const expected = { ids: ['F-1', 'S-2'], limit: 3, state: 'open', json: false };
  assert.deepEqual(outcome.args, expected);
  assert.deepEqual(outcome.result, { args: expected, ctx: { config: at.config, backlogDir: at.backlogDir } });
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

test('an entry line exits 2: entries are not supported yet', async () => {
  assert.deepEqual(await run(['start']), {
    status: 2,
    stdout: '',
    stderr: 'bl-next: start: entries are not supported yet\n',
  });
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
