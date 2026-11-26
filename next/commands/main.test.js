/**
 * The process start of `bl-next` (F-136 D8): `next/bin/bl-next` run on
 * fixture backlogs, with `BL_BACKLOG_DIR`, `HOME` and `XDG_CONFIG_HOME` set
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
 * @param {{ backlog?: boolean }} [opts]  `backlog: false` leaves BL_BACKLOG_DIR unset
 */
async function runBlNext(files, { backlog = true } = {}) {
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
  return spawnToFiles(BL_NEXT, [], { cwd: home, env }).closed;
}

const ADDITIONAL = 'additionalProperties: must NOT have additional properties';

test('bl-next exits 1 on an unknown top-level key in backlog.yaml, with one line that names it', async () => {
  const { status, stdout, stderr, error } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\nsigning_kye: x\n',
  });
  assert.equal(error, null);
  assert.equal(stderr, `backlog.yaml: /signing_kye: ${ADDITIONAL}\n`);
  assert.equal(status, 1);
  assert.equal(stdout, '');
});

test("bl-next exits 1 on a bad key under repos.utop of the operator's config.yaml, and names that file", async () => {
  const { status, stderr } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos:\n  utop: {}\n',
    '.config/bl/config.yaml': 'repos:\n  utop:\n    signing_kye: x\n',
  });
  assert.equal(stderr, `~/.config/bl/config.yaml: /repos/utop/signing_kye: ${ADDITIONAL}\n`);
  assert.equal(status, 1);
});

test('bl-next exits 1 on a partial with an unclosed section, with one line that names the partial file', async () => {
  const { status, stdout, stderr } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos: {}\n',
    'backlog/config/partials/head.mustache': '{{#items}}- {{title}}\n',
  });
  assert.equal(stderr, 'config/partials/head.mustache: : mustache: Unclosed section "items" at 22\n');
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
      assert.equal(stderr, line, `${yaml} backlog=${backlog}`);
      assert.equal(status, 1);
    }
  }
});

test('bl-next with a valid backlog exits 2: no commands yet', async () => {
  const { status, stdout, stderr } = await runBlNext({
    'backlog/backlog.yaml': 'color_scheme: mocha\nrepos:\n  utop: {}\n',
    '.config/bl/config.yaml': 'repos:\n  utop: {}\n',
  });
  assert.equal(stderr, 'bl-next: no commands yet\n');
  assert.equal(status, 2);
  assert.equal(stdout, '');
});

test('bl-next with no backlog to find exits 1 with bl-next: and the error', async () => {
  const { status, stderr } = await runBlNext({}, { backlog: false });
  assert.match(stderr, /^bl-next: no backlog found: .*\n$/);
  assert.equal(status, 1);
});
