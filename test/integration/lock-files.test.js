/**
 * S-1495: every lock file bl keeps in a backlog lives under `.bl/`, which the
 * backlog's `.gitignore` ignores, so a lock never shows in `git status` and
 * bl never asks git to ignore one. The report locks (the default output and
 * `--out` inside and outside the backlog) are covered in `report.test.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { dirLockPath, LOCK_FILE, withLock } from '../../src/lock.js';
import { acquireRunLock, releaseRunLock, RUN_LOCK_ID, runLockPath } from '../../src/run-lock.js';
import { takeSessionLock } from '../../src/session.js';
import { isSessionRunning, sessionLockPath } from '../../src/story.js';
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

test('a directory reached through a link has the lock file of its real path', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const real = mkTempDir('bl-unit-');
    const link = join(mkTempDir('bl-link-'), 'units');
    symlinkSync(real, link);
    mkdirSync(join(real, 'f1'));
    const cases = [
      ['an existing directory', join(real, 'f1'), join(link, 'f1')],
      ['a directory not made yet (a first report output)', join(real, 'out', 'r'), join(link, 'out', 'r')],
    ];
    for (const [name, viaReal, viaLink] of cases) {
      assert.equal(dirLockPath(dir, 'session', viaLink), dirLockPath(dir, 'session', viaReal), name);
    }
    // A session taken through the link (a configured unit directory) is seen
    // through the real path (the path `git worktree list` gives).
    const lock = takeSessionLock(dir, join(link, 'f1'), 'test');
    assert.equal(lock.refused, null);
    try {
      assert.equal(isSessionRunning(dir, join(real, 'f1')), true);
    } finally {
      lock.release();
    }
  } finally {
    cleanup();
  }
});
