/**
 * `bl-merge-driver` (F-148 Decision A2, D6): `next/bin/bl-merge-driver` run as
 * git runs it, `<node> bl-merge-driver <engine> <base> <ours> <theirs>`, on
 * files in a temp dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { spawnToFiles } from '../test/helpers/spawn-files.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { USAGE } from './merge-driver.js';

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
