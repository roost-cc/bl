/**
 * With BL_BACKLOG_DIR unset, `bl init` writes to the cwd and loads the cwd
 * as the backlog, never a backlog that the walk up from the cwd finds
 * (S-1155). Each case runs `bl init` in a new backlog where the walk would
 * find another backlog, several, or none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

const SIBLING = JSON.stringify({ repos: {} }) + '\n';

/** `bl init` in `dir` with BL_BACKLOG_DIR unset and a home of its own. */
function init(dir) {
  return runBl(['init'], { cwd: dir, env: { BL_BACKLOG_DIR: '', HOME: mkTempDir('bl-init-home-') } });
}

/** `<parent>/<name>` with `json` as its backlog.json. */
function backlogAt(parent, name, json) {
  const dir = join(parent, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'backlog.json'), json);
  return dir;
}

test('bl init with the cwd as the backlog, next to a second backlog, finishes', () => {
  const parent = mkTempDir('bl-init-parent-');
  const sibling = backlogAt(parent, 'a', SIBLING);
  const dir = backlogAt(parent, 'b', '{}\n');

  // No "repos" yet: the walk from the cwd finds only the sibling.
  const r = init(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).repos);
  assert.ok(readFileSync(join(dir, 'coding-dictionary.yaml'), 'utf8'));
  assert.equal(readFileSync(join(sibling, 'backlog.json'), 'utf8'), SIBLING);
  // "repos" now: the walk from the cwd finds two backlogs.
  const again = init(dir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(sibling, 'backlog.json'), 'utf8'), SIBLING);
});

test('bl init settles no record of a sibling backlog', () => {
  // The cwd with a backlog.json without "repos", and with none at all. In
  // each, bl init exits as it does in a directory with no sibling.
  for (const json of ['{}\n', null]) {
    /** `b` in a new parent, beside `a` when `withSibling`. */
    const cwd = (withSibling) => {
      const parent = mkTempDir('bl-init-parent-');
      let record = null;
      if (withSibling) {
        record = join(backlogAt(parent, 'a', SIBLING), '.bl', 'run', 'F-1.links.json');
        mkdirSync(dirname(record), { recursive: true });
        writeFileSync(record, 'not json');
      }
      const dir = json === null ? join(parent, 'b') : backlogAt(parent, 'b', json);
      if (json === null) mkdirSync(dir);
      return { dir, record };
    };
    const { dir, record } = cwd(true);
    const alone = init(cwd(false).dir);

    const r = init(dir);
    assert.equal(r.status, alone.status, r.stderr);
    assert.doesNotMatch(r.stderr, /settle/);
    assert.equal(readFileSync(record, 'utf8'), 'not json');
  }
});

test('bl init with the cwd directly below a ceiling directory finishes', () => {
  // The suite's BL_CEILING_DIRECTORIES is its TMPDIR, the parent of mkTempDir's directory.
  const dir = mkTempDir('bl-init-ceiling-');
  writeFileSync(join(dir, 'backlog.json'), '{}\n');

  const r = init(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8')).repos);
});
