/**
 * The suite runs without git's repository variables (`git rev-parse
 * --local-env-vars`: `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, …). Git
 * exports `GIT_DIR` to a pre-push hook in a linked worktree, and the pre-push
 * gate runs this suite. With it set, every git call a test makes in its temp
 * repo acts on that worktree's repo instead: the gate rewrote the worktree's
 * index (S-1330). `test/helpers/without-repo-env.sh` unsets them for every
 * `npm run test:*` script.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';

test('the suite runs with none of git’s repository variables set', () => {
  const r = spawnSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, r.stderr);
  const vars = r.stdout.split('\n').filter(Boolean);
  assert.ok(vars.includes('GIT_DIR'), r.stdout);
  assert.deepEqual(
    vars.filter((v) => process.env[v] !== undefined),
    [],
  );
});
