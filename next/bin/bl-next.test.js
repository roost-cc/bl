import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { spawnToFiles } from '../test/helpers/spawn-files.js';

const BL_NEXT = fileURLToPath(new URL('./bl-next', import.meta.url));

test('bl-next has no commands yet: it exits 2 with one line on stderr', async () => {
  const { stdout, stderr, status, error } = await spawnToFiles(BL_NEXT, []).closed;
  assert.equal(error, null);
  assert.equal(status, 2);
  assert.equal(stderr, 'bl-next: no commands yet\n');
  assert.equal(stdout, '');
});
