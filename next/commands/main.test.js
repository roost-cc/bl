/**
 * The process start of `bl-next` (F-136 D8, F-138 D3): `next/bin/bl-next` run
 * on fixture backlogs, with `BL_BACKLOG_DIR`, `HOME` and `XDG_CONFIG_HOME` set
 * to fixture directories.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnToFiles } from '../test/helpers/spawn-files.js';
import { mkTempDir } from '../test/helpers/tempdir.js';

const BL_NEXT = fileURLToPath(new URL('../bin/bl-next', import.meta.url));

/**
 * Run `bl-next` in a fresh home with `files` written under it; the backlog is
 * `<home>/backlog`, the operator's directory `<home>/.config/bl`.
 * @param {Record<string, string>} files  path under the home → text
 * @param {{ backlog?: boolean, argv?: string[] }} [opts]  `backlog: false` leaves
 *   BL_BACKLOG_DIR unset; `argv` are the arguments
 */
async function runBlNext(files, { backlog = true, argv = [] } = {}) {
  const home = mkTempDir('bl-main-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    // The walk for a backlog looks no higher than the home.
    BL_CEILING_DIRECTORIES: dirname(home),
  };
  if (backlog) env.BL_BACKLOG_DIR = join(home, 'backlog');
  else delete env.BL_BACKLOG_DIR;
  return spawnToFiles(BL_NEXT, argv, { cwd: home, env }).closed;
}

const ADDITIONAL = 'additionalProperties: must NOT have additional properties';
/** The last line of a configuration fault report (D-423). */
const DOES_NOT_LOAD = 'bl-next: the configuration does not load; bl-validate checks it\n';
const BACKLOG = 'color_scheme: mocha\nrepos: {}\n';

test('bl-next exits 1 on an unknown top-level key in backlog.yaml, with one line that names it', async () => {
  const { status, stdout, stderr, error } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\nsigning_kye: x\n',
  });
  assert.equal(error, null);
  assert.equal(stderr, `backlog.yaml: /signing_kye: ${ADDITIONAL}\n${DOES_NOT_LOAD}`);
  assert.equal(status, 1);
  assert.equal(stdout, '');
});

test("bl-next exits 1 on a bad key under repos.utop of the operator's config.yaml, and names that file", async () => {
  const { status, stderr } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos:\n  utop: {}\n',
    '.config/bl/config.yaml': 'repos:\n  utop:\n    signing_kye: x\n',
  });
  assert.equal(stderr, `~/.config/bl/config.yaml: /repos/utop/signing_kye: ${ADDITIONAL}\n${DOES_NOT_LOAD}`);
  assert.equal(status, 1);
});

test('bl-next exits 1 on a partial with an unclosed section, with one line that names the partial file', async () => {
  const { status, stdout, stderr } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\n',
    'backlog/config/partials/head.mustache': '{{#items}}- {{title}}\n',
  });
  assert.equal(stderr, `config/partials/head.mustache: : mustache: Unclosed section "items" at 22\n${DOES_NOT_LOAD}`);
  assert.equal(status, 1);
  assert.equal(stdout, '');
});

test('bl-next exits 1 on a null, false, 0 or empty repos, found by BL_BACKLOG_DIR or the walk, and names backlog.yaml and the rule', async () => {
  const rows = [
    ['color_scheme: mocha\nrepos: null\n', "backlog.yaml: /repos: required: must have required property 'repos'\n"],
    ['color_scheme: mocha\nrepos: false\n', 'backlog.yaml: /repos: type: must be object\n'],
    ['color_scheme: mocha\nrepos: 0\n', 'backlog.yaml: /repos: type: must be object\n'],
    ["color_scheme: mocha\nrepos: ''\n", 'backlog.yaml: /repos: type: must be object\n'],
  ];
  for (const [yaml, line] of rows) {
    for (const backlog of [true, false]) {
      const { status, stderr } = await runBlNext({ 'backlog/backlog.yaml': yaml }, { backlog });
      assert.equal(stderr, `${line}${DOES_NOT_LOAD}`, `${yaml} backlog=${backlog}`);
      assert.equal(status, 1);
    }
  }
});

test('bl-next with a valid backlog and no arguments exits 2: the command is required', async () => {
  const { status, stdout, stderr } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos:\n  utop: {}\n',
    '.config/bl/config.yaml': 'repos:\n  utop: {}\n',
  });
  assert.match(stderr, /\nbl-next: error: the following arguments are required: command\n$/);
  assert.equal(status, 2);
  assert.equal(stdout, '');
});

test('bl-next exits 1 on an op that the registry does not hold, naming config/commands.yaml and /<name>/op', async () => {
  const { status, stdout, stderr } = await runBlNext({
    'backlog/backlog.yaml': BACKLOG,
    'backlog/config/commands.yaml': 'list:\n  op: no-such-op\n  help: list the items\n',
  });
  assert.equal(stderr, `config/commands.yaml: /list/op: op: no op named 'no-such-op'\n${DOES_NOT_LOAD}`);
  assert.equal(status, 1);
  assert.equal(stdout, '');
});

/** A commands.yaml of entry lines, which need no op. */
const ENTRIES = 'list:\n  entry: list\n  help: list the items\nstart:\n  entry: start\n  help: start an item\n';

test('bl-next --help lists each command with its help', async () => {
  const { status, stdout, stderr } = await runBlNext(
    { 'backlog/backlog.yaml': BACKLOG, 'backlog/config/commands.yaml': ENTRIES },
    { argv: ['--help'] },
  );
  assert.equal(stderr, '');
  assert.equal(status, 0);
  assert.match(stdout, /^usage: bl-next \[-h\] command \.\.\./);
  assert.match(stdout, /\n {4}list +list the items\n {4}start +start an item\n/);
});

test("bl-next lsit exits 2 and suggests 'list'", async () => {
  const { status, stdout, stderr } = await runBlNext(
    { 'backlog/backlog.yaml': BACKLOG, 'backlog/config/commands.yaml': ENTRIES },
    { argv: ['lsit'] },
  );
  assert.equal(stderr, "bl-next: 'lsit' is not a command. Did you mean 'list'?\n");
  assert.equal(status, 2);
  assert.equal(stdout, '');
});

test('bl-next with no backlog to find exits 1 with bl-next: and the error', async () => {
  const { status, stderr } = await runBlNext({}, { backlog: false });
  assert.match(stderr, /^bl-next: no backlog found: .*\n$/);
  assert.equal(status, 1);
});
