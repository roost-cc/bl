/**
 * The process start of `bl-next` (F-136 D8, F-138 D3): `next/bin/bl-next` run
 * on fixture backlogs, with `BL_BACKLOG_DIR`, `HOME` and `XDG_CONFIG_HOME` set
 * to fixture directories.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fakeTmux, renamedTitles } from '../test/helpers/fake-tmux.js';
import { spawnToFiles } from '../test/helpers/spawn-files.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { TMUX_TIMEOUT_MS } from './tab-title.js';

const BL_NEXT = fileURLToPath(new URL('../bin/bl-next', import.meta.url));

/**
 * Run `bl-next` in a fresh home with `files` written under it; the backlog is
 * `<home>/backlog`, the operator's directory `<home>/.config/bl`. It runs
 * outside tmux unless `env` sets `TMUX`, so it never renames a real window.
 * @param {Record<string, string>} files  path under the home → text
 * @param {{ backlog?: boolean, argv?: string[], env?: Record<string, string|undefined>, bin?: string }} [opts]
 *   `backlog: false` leaves BL_BACKLOG_DIR unset; `argv` are the arguments;
 *   `env` adds to or (undefined) removes from the environment; `bin` is the
 *   script to run, `bl-next` by default
 */
async function runBlNext(files, { backlog = true, argv = [], env: extra = {}, bin = BL_NEXT } = {}) {
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
    TMUX: undefined,
    BL_TMUX_WINDOW_ID: undefined,
    BL_TAB_TITLE: undefined,
    ...extra,
  };
  if (backlog) env.BL_BACKLOG_DIR = join(home, 'backlog');
  else delete env.BL_BACKLOG_DIR;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return spawnToFiles(process.execPath, [bin, ...argv], { cwd: home, env }).closed;
}

/**
 * Run `bl-next` as `runBlNext` does, under a fake tmux with window `@7`;
 * resolve with its exit status and the titles it set.
 * @param {Record<string, string>} files
 * @param {{ backlog?: boolean, argv?: string[], env?: Record<string, string|undefined> }} [opts]
 */
async function runUnderFakeTmux(files, { env = {}, ...opts } = {}) {
  const fake = fakeTmux();
  const tmuxEnv = {
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TMUX: '/tmp/tmux-fake,1,0',
    BL_TMUX_WINDOW_ID: '@7',
  };
  const { status } = await runBlNext(files, { ...opts, env: { ...tmuxEnv, ...env } });
  return { status, calls: fake.calls(), titles: renamedTitles(fake.calls()) };
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

/** bl-next with the fixture ops `story` (one record) and `stories` (an async iterable). */
const WITH_FIXTURE_OPS = fileURLToPath(new URL('../test/helpers/bl-next-fixture-ops.js', import.meta.url));
const FIXTURE_COMMANDS = 'story:\n  op: story\n  help: show a story\nstories:\n  op: stories\n  help: list stories\n';

test('bl-next <command> --json prints one record as one JSON document, a record set as JSON Lines', async () => {
  const files = { 'backlog/backlog.yaml': BACKLOG, 'backlog/config/commands.yaml': FIXTURE_COMMANDS };
  const one = await runBlNext(files, { bin: WITH_FIXTURE_OPS, argv: ['story', 'S-1', '--json'] });
  assert.equal(one.stderr, '');
  assert.equal(one.status, 0);
  assert.equal(one.stdout, '{"id":"S-1","title":"Story S-1"}\n');
  const set = await runBlNext(files, { bin: WITH_FIXTURE_OPS, argv: ['stories', 'S-1', 'S-2', '--json'] });
  assert.equal(set.stderr, '');
  assert.equal(set.status, 0);
  assert.equal(set.stdout, '{"id":"S-1","title":"Story S-1"}\n{"id":"S-2","title":"Story S-2"}\n');
  // With no view in views.yaml, the output is the same without --json.
  const noView = await runBlNext(files, { bin: WITH_FIXTURE_OPS, argv: ['stories', 'S-1', 'S-2'] });
  assert.equal(noView.stdout, set.stdout);
});

test('bl-next with no backlog to find exits 1 with bl-next: and the error', async () => {
  const { status, stderr } = await runBlNext({}, { backlog: false });
  assert.match(stderr, /^bl-next: no backlog found: .*\n$/);
  assert.equal(status, 1);
});

// ---------------------------------------------------------------------------
// the tab title (F-138 D9)
// ---------------------------------------------------------------------------

const VALID = { 'backlog/backlog.yaml': BACKLOG, 'backlog/config/commands.yaml': ENTRIES };

test('bl-next list --help and bl-next --help rename the window to help, then ended', async () => {
  for (const argv of [['list', '--help'], ['--help'], ['list', '-h']]) {
    const { status, calls, titles } = await runUnderFakeTmux(VALID, { argv });
    assert.equal(status, 0, argv.join(' '));
    assert.ok(
      calls.every((c) => c.startsWith('rename-window\n-t\n@7\n--\n')),
      argv.join(' '),
    );
    assert.deepEqual(titles, ['help', 'ended'], argv.join(' '));
  }
});

test('bl-next <command> renames the window to the command name, also before a load fault', async () => {
  const { status, titles } = await runUnderFakeTmux(VALID, { argv: ['start'] });
  assert.equal(status, 2);
  assert.deepEqual(titles, ['start', 'failed (exit 2)']);
  const noBacklog = await runUnderFakeTmux({}, { backlog: false, argv: ['list'] });
  assert.equal(noBacklog.status, 1);
  assert.deepEqual(noBacklog.titles, ['list', 'failed (exit 1)']);
});

test('bl-next with no arguments renames the window to help', async () => {
  const { titles } = await runUnderFakeTmux(VALID);
  assert.equal(titles[0], 'help');
});

test("with BL_TAB_TITLE='', bl-next sends no title", async () => {
  const { status, calls } = await runUnderFakeTmux(VALID, { argv: ['list', '--help'], env: { BL_TAB_TITLE: '' } });
  assert.equal(status, 0);
  assert.deepEqual(calls, []);
});

test('a hung tmux does not hold bl-next back', async () => {
  // Each tmux call hangs for 20 s. Without BL_TMUX_WINDOW_ID, bl-next calls
  // tmux three times: display-message, the start title and the exit title.
  const dir = mkTempDir('bl-tmux-hung-');
  writeFileSync(join(dir, 'tmux'), '#!/bin/sh\nexec sleep 20\n');
  chmodSync(join(dir, 'tmux'), 0o755);
  for (const windowId of ['@7', undefined]) {
    const env = {
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      TMUX: '/tmp/tmux-fake,1,0',
      BL_TMUX_WINDOW_ID: windowId,
    };
    const started = Date.now();
    const { status } = await runBlNext(VALID, { argv: ['list', '--help'], env });
    const ms = Date.now() - started;
    assert.equal(status, 0);
    assert.ok(ms < 3 * TMUX_TIMEOUT_MS + 5000, `bl-next list --help took ${ms} ms (window id ${windowId})`);
  }
});
