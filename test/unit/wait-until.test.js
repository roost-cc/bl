// A wait for a condition that another process makes true has a time limit
// (F-128): `waitUntil` and the waits built on it reject when the condition
// never comes, and resolve when it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { ignoresSigterm } from '../helpers/ignores-sigterm.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { waitUntil } from '../helpers/wait-until.js';

const LIMIT = 100;

test('wait_until_rejects_when_the_condition_never_comes', async () => {
  const rows = [
    ['a check that stays undefined', () => waitUntil(() => undefined, 'nothing', LIMIT)],
    [
      'ignoresSigterm().ready() with a missing directory',
      () => ignoresSigterm(join(mkTempDir('bl-wait-'), 'missing'), LIMIT).ready(),
    ],
    ['ignoresSigterm().ready() with no child started', () => ignoresSigterm(mkTempDir('bl-wait-'), LIMIT).ready()],
  ];
  for (const [name, wait] of rows) {
    const t0 = Date.now();
    await assert.rejects(wait(), /timed out after 100 ms/, name);
    assert.ok(Date.now() - t0 < 2_000, `${name}: rejects near the limit`);
  }
});

test('wait_until_resolves_with_the_first_defined_value', async () => {
  const rows = [
    ['a value at once', [7], 7],
    ['null after two undefined', [undefined, undefined, null], null],
    ['false is a value', [false], false],
  ];
  for (const [name, values, expected] of rows) {
    let i = 0;
    assert.equal(await waitUntil(() => values[i++], name, 1_000), expected, name);
  }
});
