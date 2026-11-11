/**
 * S-1495: every lock file bl keeps in a backlog lives under `.bl/`, which the
 * backlog's `.gitignore` ignores, so a lock never shows in `git status` and
 * bl never asks git to ignore one. The report locks (the default output and
 * `--out` inside and outside the backlog) are covered in `report.test.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { LOCK_FILE, withLock } from '../../src/lock.js';
import { acquireRunLock, releaseRunLock, RUN_LOCK_ID, runLockPath } from '../../src/run-lock.js';
import { takeSessionLock } from '../../src/session.js';
import { sessionLockPath } from '../../src/story.js';
import { git, initGitBacklog } from '../helpers/git-backlog.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

test('every lock bl takes in a git backlog lives under .bl/ and leaves git status empty', async () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    initGitBacklog(dir);
    const config = loadConfig({ backlogRoot: dir });
    const unitDir = mkTempDir('bl-unit-');

    await withLock(dir, () => {});
    for (const id of ['F-1', RUN_LOCK_ID]) releaseRunLock(acquireRunLock(config, id).taken);
    // A unit directory's session, and a refine's in the backlog root.
    for (const where of [unitDir, dir]) {
      const lock = takeSessionLock(dir, where, 'test');
      assert.equal(lock.refused, null, where);
      lock.release();
    }

    const files = [
      join(dir, LOCK_FILE),
      runLockPath(config, 'F-1'),
      runLockPath(config, RUN_LOCK_ID),
      sessionLockPath(dir, unitDir),
      sessionLockPath(dir, dir),
    ];
    for (const f of files) {
      assert.ok(existsSync(f), `${f}: the lock file stays (F-104 D3)`);
      assert.ok(f.startsWith(join(dir, '.bl', '/')), `${f}: under .bl/`);
    }
    assert.equal(new Set(files).size, files.length, 'one file per lock');
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.deepEqual(readdirSync(unitDir), [], 'no lock file in the unit directory');
  } finally {
    cleanup();
  }
});
