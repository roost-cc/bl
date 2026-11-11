/**
 * F-104 D4: the PID in a lock file is information only. Every check that
 * leaves out this process's own lock asks the kernel lock module
 * (`otherHolder`, `holds`), so another process that holds a lock blocks
 * whatever its file says, and a lock this process holds never blocks it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { release, tryLock } from '../../src/kernel-lock.js';
import { specLockPath, updateSpecFileHeld } from '../../src/spec-file.js';
import { runFeature } from '../../src/feature-run.js';
import { heldUnits } from '../../src/migrate-transitions.js';
import { assertMigrationCanStart } from '../../src/migration-txn.js';
import { sessionLockPath } from '../../src/story.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { addOrigin, git } from '../helpers/git-backlog.js';
import { fakeRunner, setup } from '../helpers/feature-run-fixture.js';

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A backlog at origin/main that ignores `.bl/`, with F-9's run state `running`. */
function migrationBacklog() {
  const dir = mkTempDir('bl-lock-ownership-');
  put(join(dir, '.gitignore'), '.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  addOrigin(dir);
  put(join(dir, '.bl/run/F-9.json'), '{"feature":"F-9","status":"running"}\n');
  return dir;
}

/** A repo with S-1's worktree; its session lock is the unit directory's, in `backlogRoot`'s `.bl/lock/`. */
function sessionRepo(backlogRoot) {
  const repo = mkTempDir('bl-lock-ownership-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const wt = join(mkTempDir('bl-lock-ownership-wt-'), 's1-story');
  git(repo, 'worktree', 'add', '-q', '-b', 's1-story', wt);
  return { repos: { r: { name: 'r', path: repo } }, lockPath: sessionLockPath(backlogRoot, dirname(wt)) };
}

/** Whether `fn` throws an error whose message matches `re`. */
function refuses(fn, re) {
  try {
    fn();
    return false;
  } catch (e) {
    assert.match(e.message, re);
    return true;
  }
}

/**
 * Each check that excludes this process's own lock: `arrange` makes the lock
 * path and returns `blocked()`, which says whether the check refuses.
 */
const CHECKS = [
  [
    'updateSpecFileHeld_refuses_foreign_lock_with_matching_pid_text',
    () => {
      const dir = mkTempDir('bl-lock-ownership-');
      const spec = join(dir, 'index.md');
      put(spec, '---\nstatus: draft\n---\n\n# Story\n');
      return {
        lockPath: specLockPath(spec),
        blocked: () => refuses(() => updateSpecFileHeld(dir, spec, () => false), /the spec lock is not held/),
      };
    },
  ],
  [
    'runFeature_refuses_foreign_session_lock_with_matching_pid_text',
    () => {
      const { config, feature, prep, dir } = setup();
      return {
        lockPath: sessionLockPath(config.backlogRoot, prep.unitDir ?? prep.worktreePath),
        own: false,
        blocked: async () => {
          const state = await runFeature({ feature, config, prep, runner: fakeRunner({ dir, feature }) });
          return state.refused === true;
        },
      };
    },
  ],
  [
    'heldUnits_reports_foreign_flock_with_matching_pid_text (run lock)',
    () => {
      const dir = mkTempDir('bl-lock-ownership-');
      mkdirSync(join(dir, '.bl/run'), { recursive: true });
      return {
        lockPath: join(dir, '.bl/run/F-9.lock'),
        blocked: () => heldUnits({ backlogRoot: dir, repos: {} }).has('F-9'),
      };
    },
  ],
  [
    'heldUnits_reports_foreign_flock_with_matching_pid_text (session lock)',
    () => {
      const dir = mkTempDir('bl-lock-ownership-');
      const { repos, lockPath } = sessionRepo(dir);
      return { lockPath, blocked: () => heldUnits({ backlogRoot: dir, repos }).has('S-1') };
    },
  ],
  [
    'assertMigrationCanStart_refuses_foreign_flock_with_matching_pid_text (run lock)',
    () => {
      const dir = migrationBacklog();
      return {
        lockPath: join(dir, '.bl/run/F-9.lock'),
        blocked: () => refuses(() => assertMigrationCanStart({ backlogRoot: dir, repos: {} }), /a bl run is active/),
      };
    },
  ],
  [
    'assertMigrationCanStart_refuses_foreign_flock_with_matching_pid_text (session lock)',
    () => {
      const dir = migrationBacklog();
      const { repos, lockPath } = sessionRepo(dir);
      return {
        lockPath,
        blocked: () =>
          refuses(() => assertMigrationCanStart({ backlogRoot: dir, repos }), /a bl session is running in/),
      };
    },
  ],
];

/** What the lock file says while another process holds the lock. */
const TEXTS = [
  ['blank', () => ''],
  ['this process', () => `${process.pid}\n`],
  ['an ancestor', () => `${process.ppid}\n`],
  ['the holder', (holder) => `${holder.pid}\n`],
];

test('a lock another process holds blocks every ownership check, whatever PID its file names', async () => {
  for (const [name, arrange] of CHECKS) {
    for (const [text, content] of TEXTS) {
      const { lockPath, blocked } = arrange();
      const holder = await holdLockInChild(lockPath);
      try {
        writeFileSync(lockPath, content(holder));
        assert.equal(await blocked(), true, `${name}, file names ${text}`);
      } finally {
        await holder.kill();
      }
    }
  }
});

test('a lock this process holds never blocks its own ownership checks', async () => {
  for (const [name, arrange] of CHECKS) {
    const { lockPath, blocked, own } = arrange();
    if (own === false) continue; // runFeature would run its whole loop; the review round covers it.
    mkdirSync(dirname(lockPath), { recursive: true });
    const { taken } = tryLock(lockPath);
    try {
      assert.equal(await blocked(), false, name);
    } finally {
      release(taken);
    }
  }
});
