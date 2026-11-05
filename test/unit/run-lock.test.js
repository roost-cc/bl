import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../helpers/run-bl.js';
import * as runLock from '../../src/run-lock.js';
import * as featureRun from '../../src/feature-run.js';
import * as updates from '../../src/updates.js';
import * as pidLock from '../../src/pid-lock.js';

// running-man's provision/tick-lock.mjs takes bl's updates run lock with these two modules,
// before bl's dependencies may be installed (F-74 D4): they import node built-ins only.
test('updates_lock_path_contract: run-lock.js and pid-lock.js import only node built-ins', () => {
  for (const file of ['run-lock.js', 'pid-lock.js']) {
    const src = readFileSync(join(REPO_ROOT, 'src', file), 'utf8');
    const specifiers = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, file);
    for (const s of specifiers) assert.match(s, /^(node:)?(fs|path)$/, `${file} imports ${s}`);
  }
  assert.equal(typeof pidLock.acquirePidLock, 'function');
});

test('updates_lock_path_contract: the loop and bl updates use run-lock.js’s one definition', () => {
  assert.equal(featureRun.RUN_DIR, runLock.RUN_DIR);
  assert.equal(featureRun.runLockPath, runLock.runLockPath);
  assert.equal(featureRun.ensureRunDir, runLock.ensureRunDir);
  assert.equal(updates.RUN_LOCK_ID, runLock.RUN_LOCK_ID);
  assert.equal(
    runLock.runLockPath({ backlogRoot: '/b' }, runLock.RUN_LOCK_ID),
    join('/b', '.bl', 'run', 'updates.lock'),
  );
});
