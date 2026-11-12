/**
 * unit-lock.js — the work unit lock (F-122 D2, D6): one kernel lock per work
 * unit directory (`stories/S<n>-…/`, `features/F<n>-…/`), in the backlog's
 * `.bl/lock/` (`unitLockPath`). A verb that holds a session on a work unit
 * takes the lock of its work unit and of each of its stories, all or nothing,
 * with one try-lock each (`takeDirLock`, `lock.js`). It never waits: a lock
 * that another process holds refuses the verb before it writes anything.
 *
 * It is a lock of its own, beside the spec lock (`spec-file.js`): the spec
 * lock guards one write and waits, and this one is held for a whole session.
 * Short commands (`bl new`, `bl sync --commit`, `bl approve` and the rest)
 * neither take nor check it, because a session's agent runs them as children.
 */

import { dirname, relative } from 'path';
import { dirLockPath, takeDirLock } from './lock.js';
import { resolveFeatureStories } from './feature.js';

/**
 * A unit with no `kind` is a feature, as the run loop reads one (a
 * `findFeature` record carries none; `isStory`, `feature-run.js`).
 *
 * @typedef {{ id: string, kind?: 'story' | 'feature', indexPath: string }} WorkUnit
 */

/**
 * The work unit lock file of the work unit directory `dir`.
 *
 * @param {string} backlogRoot
 * @param {string} dir
 */
export function unitLockPath(backlogRoot, dir) {
  return dirLockPath(backlogRoot, 'unit', dir);
}

/**
 * The work units whose locks `unit` takes, with their ids: `unit` itself, and
 * for a feature each of its stories (`resolveFeatureStories`), read fresh from
 * disk on every call.
 *
 * @param {{ backlogRoot: string }} config
 * @param {WorkUnit} unit
 * @returns {{ id: string, dir: string }[]}
 */
function lockTargets(config, unit) {
  const own = { id: unit.id, dir: dirname(unit.indexPath) };
  if (unit.kind === 'story') return [own];
  const { stories } = resolveFeatureStories(unit, config);
  return [own, ...stories.map((s) => ({ id: s.id, dir: dirname(s.indexPath) }))];
}

/**
 * The work unit directories whose locks `unit` takes: a story's directory, or
 * a feature's directory and each of its stories' directories, read fresh from
 * disk.
 *
 * @param {{ backlogRoot: string }} config
 * @param {WorkUnit} unit
 * @returns {string[]}
 */
export function unitLockDirs(config, unit) {
  return lockTargets(config, unit).map((t) => t.dir);
}

/**
 * Take the work unit lock of every directory in `unitLockDirs` of each of
 * `units`, all or nothing (D2). If another process holds one, release the
 * locks this call took and refuse with `<id> is locked by a live bl process
 * (pid <n>): <lock path>`. A lock this process already holds is taken again,
 * one depth deeper (`tryLock` is re-entrant), so `bl merge F-n` can run the
 * run loop's take under its own.
 *
 * On success, `release()` gives back every lock this call took, and `scope()`
 * reads `unitLockDirs` again and returns the backlog-relative directories, so
 * a story tagged to a feature after the take is in it (D3).
 *
 * @param {{ backlogRoot: string }} config
 * @param {WorkUnit[]} units
 * @param {string} info  one line that names the holder
 * @returns {{ refused: string } | { refused: null, release: () => void, scope: () => string[] }}
 */
export function takeUnitLocks(config, units, info) {
  /** @type {(() => void)[]} */
  const taken = [];
  const release = () => {
    for (const give of taken.splice(0).reverse()) give();
  };
  for (const unit of units) {
    for (const { id, dir } of lockTargets(config, unit)) {
      const got = takeDirLock(config.backlogRoot, 'unit', dir, info);
      if (got.refused != null) {
        release();
        if (got.holder == null) return { refused: got.refused };
        return { refused: `${id} is locked by a live bl process (pid ${got.holder}): ${got.path}` };
      }
      taken.push(got.release);
    }
  }
  const scope = () => [
    ...new Set(units.flatMap((u) => unitLockDirs(config, u)).map((d) => relative(config.backlogRoot, d))),
  ];
  return { refused: null, release, scope };
}

/**
 * `takeUnitLocks` for a command, before it writes anything: on a refusal,
 * print it and exit 1. The process's exit drops the locks, so a command that
 * holds them to its end needs no release.
 *
 * @param {{ backlogRoot: string }} config
 * @param {WorkUnit[]} units
 * @param {string} info  one line that names the holder
 * @returns {{ refused: null, release: () => void, scope: () => string[] }}
 */
export function takeUnitLocksOrExit(config, units, info) {
  const lock = takeUnitLocks(config, units, info);
  if (lock.refused == null) return lock;
  console.error(`Error: ${lock.refused}`);
  process.exit(1);
}
