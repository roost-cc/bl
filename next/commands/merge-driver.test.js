/**
 * `bl-merge-driver` (F-148 Decision A2, D6): `next/bin/bl-merge-driver` run as
 * git runs it, `<node> bl-merge-driver <engine> <base> <ours> <theirs>`, on
 * files in a temp dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
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
 * Run `mergeDriver` in this process on the three texts, and give its exit
 * code or the code of the error it throws, what ours holds after it, the mode
 * of ours, what it wrote on stderr, and the files (not directories) under its
 * directory. While it runs, each `fs[name]` of `fail` throws an error with
 * that code, `env` is set, and `Math.random` gives the values of `draws`
 * first. `before(dir)` runs before the call.
 * @param {[string, string, string]} texts  base, ours, theirs
 * @param {{ engine?: string, argv?: (paths: string[]) => string[], fail?: Record<string, string>, env?: Record<string, string>, draws?: number[], before?: (dir: string) => void }} how
 */
function driveHere(texts, { engine = 'rank', argv = (paths) => paths, fail = {}, env = {}, draws = [], before }) {
  const dir = mkTempDir('bl-merge-driver-');
  const paths = ['base', 'ours', 'theirs'].map((name) => join(dir, name));
  texts.forEach((text, i) => writeFileSync(paths[i], text));
  before?.(dir);
  const saved = {
    fs: Object.keys(fail).map((name) => [name, fs[name]]),
    env: Object.keys(env).map((key) => [key, process.env[key]]),
    random: Math.random,
    write: process.stderr.write,
  };
  for (const [name, code] of Object.entries(fail)) {
    const original = fs[name];
    fs[name] = (path, ...rest) => {
      // A disk that fails mid-write: the first bytes land, then the error.
      if (name === 'writeFileSync') original(path, String(rest[0]).slice(0, 3));
      throw Object.assign(new Error(`injected ${name} failure`), { code });
    };
  }
  syncBuiltinESMExports();
  const queued = [...draws];
  Math.random = () => (queued.length > 0 ? /** @type {number} */ (queued.shift()) : saved.random());
  let stderr = '';
  process.stderr.write = (/** @type {string} */ text) => ((stderr += text), true);
  Object.assign(process.env, env);
  let result;
  try {
    result = mergeDriver([engine, ...argv(paths)]);
  } catch (e) {
    result = /** @type {NodeJS.ErrnoException} */ (e).code;
  } finally {
    for (const [name, original] of saved.fs) fs[name] = original;
    syncBuiltinESMExports();
    Math.random = saved.random;
    process.stderr.write = saved.write;
    for (const [key, value] of saved.env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const files = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((path) => !lstatSync(join(dir, path)).isDirectory())
    .sort();
  const mode = statSync(paths[1]).mode & 0o777;
  return { result, ours: readFileSync(paths[1], 'utf8'), mode, stderr, files, dir };
}

test('merge_driver_write_failure_preserves_ours', () => {
  const MERGES = [jsonOf(['A']), jsonOf(['A', 'Y']), jsonOf(['A', 'Z'])];
  const FILES = ['base', 'ours', 'theirs'];
  /** [case, the texts, how the call runs, its exit code or error code, whether ours holds markers after it] */
  const CASES = [
    ['the merged text cannot be written', MERGES, { fail: { writeFileSync: 'EIO' } }, 'EIO', false],
    ['the merged text cannot be renamed over ours', MERGES, { fail: { renameSync: 'EIO' } }, 'EIO', false],
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
  const clean = driveHere(/** @type {[string, string, string]} */ (MERGES), {});
  assert.deepEqual([clean.result, clean.ours, clean.files], [0, jsonOf(['A', 'Y', 'Z']), FILES]);
});

/** Base, ours and theirs of a rank chain that merges to `A Y Z`. */
const RANKS = /** @type {[string, string, string]} */ ([jsonOf(['A']), jsonOf(['A', 'Y']), jsonOf(['A', 'Z'])]);
/** The driver's first staging file when `Math.random` gives 0.5 first. */
const DRAWN = join('.bl', 'tmp', `ours.${process.pid}.${(0.5).toString(36).slice(2)}.tmp`);
/** The staging file of the round 1 driver, beside ours. */
const BESIDE = `ours.${process.pid}.bl-merge.tmp`;

test('merge_driver_preserves_ours_mode_and_existing_staging_file', () => {
  for (const mode of [0o600, 0o640, 0o644]) {
    const label = mode.toString(8);
    const after = driveHere(RANKS, {
      draws: [0.5],
      before: (dir) => {
        chmodSync(join(dir, 'ours'), mode);
        mkdirSync(join(dir, '.bl', 'tmp'), { recursive: true });
        writeFileSync(join(dir, DRAWN), 'another caller\n');
        writeFileSync(join(dir, BESIDE), 'user data\n');
      },
    });
    assert.deepEqual([after.result, after.ours, after.mode], [0, jsonOf(['A', 'Y', 'Z']), mode], label);
    assert.deepEqual(after.files, [DRAWN, BESIDE, 'base', 'ours', 'theirs'].sort(), label);
    assert.equal(readFileSync(join(after.dir, DRAWN), 'utf8'), 'another caller\n', label);
    assert.equal(readFileSync(join(after.dir, BESIDE), 'utf8'), 'user data\n', label);
  }
});

test('merge_driver_staging_collision_and_cleanup_ownership', () => {
  /** A link at the drawn staging name to `other`, a file that no merge names. */
  const link = (/** @type {string} */ dir) => {
    writeFileSync(join(dir, 'other'), 'unrelated\n');
    mkdirSync(join(dir, '.bl', 'tmp'), { recursive: true });
    symlinkSync(join(dir, 'other'), join(dir, DRAWN));
  };
  const LINKED = ['base', 'ours', 'theirs', 'other', DRAWN].sort();
  /** [case, how the call runs, its exit code or error code, what ours holds, the files after it, stderr] */
  const CASES = [
    ['a link at the drawn name', { draws: [0.5], before: link }, 0, jsonOf(['A', 'Y', 'Z']), LINKED, ''],
    [
      'the rename fails after a collision',
      { draws: [0.5], before: link, fail: { renameSync: 'EIO' } },
      'EIO',
      RANKS[1],
      LINKED,
      '',
    ],
    // The staging file stays, as an orphan in ignored space, and stderr names it.
    [
      'the rename fails and so does the cleanup',
      { draws: [0.5], fail: { renameSync: 'EIO', unlinkSync: 'EACCES' } },
      'EIO',
      RANKS[1],
      ['base', 'ours', 'theirs', DRAWN].sort(),
      /^warning: could not remove staging file .*\.tmp after a failed write: injected unlinkSync failure\n$/,
    ],
  ];
  for (const [label, how, result, ours, files, stderr] of CASES) {
    const after = driveHere(RANKS, /** @type {any} */ (how));
    assert.equal(after.result, result, label);
    assert.equal(after.ours, ours, label);
    assert.equal(lstatSync(join(after.dir, 'ours')).isSymbolicLink(), false, label);
    assert.deepEqual(after.files, files, label);
    if (typeof stderr === 'string') assert.equal(after.stderr, stderr, label);
    else assert.match(after.stderr, stderr, label);
    if (files === LINKED) {
      assert.equal(readlinkSync(join(after.dir, DRAWN)), join(after.dir, 'other'), label);
      assert.equal(readFileSync(join(after.dir, 'other'), 'utf8'), 'unrelated\n', label);
    }
  }
});
