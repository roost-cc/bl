/**
 * `bl-merge-driver` (F-148 Decision A2, D6): `next/bin/bl-merge-driver` run as
 * git runs it, `<node> bl-merge-driver <engine> <base> <ours> <theirs>`, on
 * files in a temp dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, readdirSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { spawnToFiles } from '../test/helpers/spawn-files.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { USAGE, mergeDriver } from './merge-driver.js';

const DRIVER = fileURLToPath(new URL('../bin/bl-merge-driver', import.meta.url));

/** `value` as the store writes JSON. */
const jsonOf = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Run the driver with the arguments `engine`, then the paths of the base,
 * ours and theirs files, which hold the three texts. `extra` are more
 * arguments after them.
 * @param {string} engine
 * @param {[string, string, string]} texts  base, ours, theirs
 * @param {string[]} [extra]
 */
async function drive(engine, [base, ours, theirs], extra = []) {
  const dir = mkTempDir('bl-merge-driver-');
  const paths = ['base', 'ours', 'theirs'].map((name) => join(dir, name));
  [base, ours, theirs].forEach((text, i) => writeFileSync(paths[i], text));
  const { status, stderr } = await spawnToFiles(process.execPath, [DRIVER, engine, ...paths, ...extra], {
    cwd: dir,
  }).closed;
  return { status, stderr, ours: readFileSync(paths[1], 'utf8') };
}

test('a merge writes the merged text over ours in canonical form and exits 0', async () => {
  const rank = await drive(
    'rank',
    [
      ['A', 'B', 'C'],
      ['A', 'B', 'C', 'Y'],
      ['A', 'B', 'C', 'Z'],
    ].map(jsonOf),
  );
  assert.deepEqual(rank, { status: 0, stderr: '', ours: jsonOf(['A', 'B', 'C', 'Y', 'Z']) });
  // A zero-byte base is the empty graph: git passes one when both sides add the file.
  const both = await drive('dependency', [
    '',
    jsonOf({ 'S-2': { done: [{ 'S-1': 'true' }] } }),
    '{"S-1":{"done":[{"S-3":"true"}]}}',
  ]);
  assert.deepEqual(both, {
    status: 0,
    stderr: '',
    ours: jsonOf({ 'S-1': { done: [{ 'S-3': 'true' }] }, 'S-2': { done: [{ 'S-1': 'true' }] } }),
  });
});

/** Base, ours and theirs of a containment slot that both sides set to different parents. */
const CONFLICT = [jsonOf({}), jsonOf({ 'S-1': { unit: 'F-1' } }), jsonOf({ 'S-1': { unit: 'F-2' } })];

test("a conflict leaves git's conflict markers in ours and exits 1", async () => {
  const { status, stderr, ours } = await drive('containment', CONFLICT);
  assert.equal(status, 1);
  assert.equal(stderr, '');
  assert.match(ours, /^<{7} ours\n[^]*\n={7}\n[^]*"F-2"[^]*\n>{7} theirs\n/m);
});

test('a blank ours is a conflict, not an empty graph', async () => {
  const { status, ours } = await drive('rank', [jsonOf(['A']), '\n', jsonOf(['A', 'B'])]);
  assert.equal(status, 1);
  assert.match(ours, /^<{7} ours$/m);
});

test('an engine that no engine has is a conflict that says why on stderr', async () => {
  const { status, stderr, ours } = await drive('blockers', CONFLICT);
  assert.equal(status, 1);
  assert.equal(stderr, 'bl-merge-driver: there is no graph engine named blockers\n');
  assert.match(ours, /^<{7} ours$/m);
});

test('a call with the wrong number of arguments prints the usage, exits 2 and changes nothing', async () => {
  const { status, stderr, ours } = await drive('rank', CONFLICT, ['more']);
  assert.deepEqual({ status, stderr, ours }, { status: 2, stderr: `${USAGE}\n`, ours: CONFLICT[1] });
});

/**
 * Run `mergeDriver` in this process on the three texts, with `fs[name]`
 * replaced by `replacement` and `env` set while it runs, and give its exit
 * code or the code of the error it throws, what ours holds after it, and the
 * files of its directory.
 * @param {[string, string, string]} texts  base, ours, theirs
 * @param {{ engine?: string, argv?: (paths: string[]) => string[], fail?: 'writeFileSync'|'renameSync', env?: Record<string, string> }} how
 */
function driveHere(texts, { engine = 'rank', argv = (paths) => paths, fail, env = {} }) {
  const dir = mkTempDir('bl-merge-driver-');
  const paths = ['base', 'ours', 'theirs'].map((name) => join(dir, name));
  texts.forEach((text, i) => writeFileSync(paths[i], text));
  const saved = {
    fs: fail === undefined ? undefined : fs[fail],
    env: Object.keys(env).map((key) => [key, process.env[key]]),
  };
  if (fail !== undefined) {
    const original = fs[fail];
    fs[fail] = (path, ...rest) => {
      // A disk that fails mid-write: the first bytes land, then the error.
      if (fail === 'writeFileSync') original(path, String(rest[0]).slice(0, 3));
      throw Object.assign(new Error(`injected ${fail} failure`), { code: 'EIO' });
    };
    syncBuiltinESMExports();
  }
  Object.assign(process.env, env);
  let result;
  try {
    result = mergeDriver([engine, ...argv(paths)]);
  } catch (e) {
    result = /** @type {NodeJS.ErrnoException} */ (e).code;
  } finally {
    if (fail !== undefined) {
      fs[fail] = saved.fs;
      syncBuiltinESMExports();
    }
    for (const [key, value] of saved.env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { result, ours: readFileSync(paths[1], 'utf8'), files: readdirSync(dir).sort() };
}

test('merge_driver_write_failure_preserves_ours', () => {
  const MERGES = [jsonOf(['A']), jsonOf(['A', 'Y']), jsonOf(['A', 'Z'])];
  const FILES = ['base', 'ours', 'theirs'];
  /** [case, the texts, how the call runs, its exit code or error code, whether ours holds markers after it] */
  const CASES = [
    ['the merged text cannot be written', MERGES, { fail: 'writeFileSync' }, 'EIO', false],
    ['the merged text cannot be renamed over ours', MERGES, { fail: 'renameSync' }, 'EIO', false],
    ['the wrong number of arguments', MERGES, { argv: (/** @type {string[]} */ p) => [...p, 'more'] }, 2, false],
    ['the base cannot be read', MERGES, { argv: ([, o, t]) => [join(o, '..', 'missing'), o, t] }, 'ENOENT', false],
    ['git merge-file cannot run', CONFLICT, { engine: 'containment', env: { PATH: '' } }, 1, false],
    ['a side that does not parse', [jsonOf(['A']), '{ bad\n', jsonOf(['A', 'Z'])], {}, 1, true],
  ];
  for (const [label, texts, how, result, markers] of CASES) {
    const after = driveHere(/** @type {[string, string, string]} */ (texts), /** @type {any} */ (how));
    assert.equal(after.result, result, label);
    assert.deepEqual(after.files, FILES, label);
    if (markers) assert.match(after.ours, /^<{7} ours$/m, label);
    else assert.equal(after.ours, texts[1], label);
  }
  // With nothing broken, the merged text replaces ours and nothing else stays.
  assert.deepEqual(driveHere(/** @type {[string, string, string]} */ (MERGES), {}), {
    result: 0,
    ours: jsonOf(['A', 'Y', 'Z']),
    files: FILES,
  });
});
