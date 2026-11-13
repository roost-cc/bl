/**
 * F-124 S-1521: if SIGINT ends `syncBranchWithMain`'s `git merge --no-edit
 * <ref>` (src/review.js), `git merge --abort` runs, then `bl` exits 130
 * (`raiseAfter`, F-124 D3).
 *
 * A Node child calls `exitOnSignal()` (as `bl.js` does), then
 * `syncBranchWithMain` on Alice's story branch, whose merge with origin's main
 * conflicts. A `git` shim first on that child's PATH runs the real
 * `git merge --no-edit`, which stops with a merge in progress, and then ends
 * itself with SIGINT; it runs the real git for every other call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HEADLESS_ENV } from '../../src/agents/provider.js';
import { bobPushes, g, REAL_GIT, twoClones } from '../helpers/backlog-commit-fixture.js';
import { runAfterExitOnSignal } from '../helpers/exit-on-signal-script.js';
import { mkTempDir } from '../helpers/tempdir.js';

const REVIEW = new URL('../../src/review.js', import.meta.url).href;

const shimDir = mkTempDir('bl-review-signal-shim-');
writeFileSync(
  join(shimDir, 'git'),
  `#!/bin/sh
if [ "$1 $2" = "merge --no-edit" ]; then
  "${REAL_GIT}" "$@"
  kill -INT $$
fi
exec "${REAL_GIT}" "$@"
`,
  { mode: 0o755 },
);

test.after(() => rmSync(shimDir, { recursive: true, force: true }));

test('SIGINT that ends the merge with main in syncBranchWithMain: the merge is aborted, then bl exits 130', () => {
  const { tmp, alice, bob } = twoClones({ 'a.md': '1\n' });
  try {
    g(alice, 'checkout', '-q', '-b', 'story');
    writeFileSync(join(alice, 'a.md'), 'alice\n');
    g(alice, 'commit', '-q', '-am', 'alice');
    bobPushes(bob, { 'a.md': 'bob\n' });
    const head = g(alice, 'rev-parse', 'HEAD');

    const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` };
    delete env[HEADLESS_ENV];
    const r = runAfterExitOnSignal(
      [
        `import { syncBranchWithMain } from ${JSON.stringify(REVIEW)};`,
        `console.log(JSON.stringify(syncBranchWithMain(${JSON.stringify(alice)})));`,
      ],
      { env },
    );

    const why = `status ${r.status} signal ${r.signal}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
    assert.equal(r.status, 130, why);
    assert.match(r.stderr, /^bl: git merge --no-edit origin\/main was ended by SIGINT$/m, why);
    assert.equal(r.stdout, '', why);
    assert.equal(existsSync(join(alice, '.git', 'MERGE_HEAD')), false, why);
    assert.equal(g(alice, 'rev-parse', 'HEAD'), head);
    assert.equal(g(alice, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(alice, 'a.md'), 'utf8'), 'alice\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
