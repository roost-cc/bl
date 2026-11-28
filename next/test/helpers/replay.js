/**
 * replay.js — the environment of a test that runs the `replay` program (F-141 Decision A3).
 *
 * bl's `package.json` names `replay` as a dev dependency, pinned to a commit
 * of `roost-cc/replay`, so `npm ci` installs it in `node_modules/.bin`. The
 * adapter finds the program on the `PATH` (D-497), so a test puts that
 * directory first on the `PATH` of the children it starts. Every checkout
 * then tests against the same `replay`.
 */

import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { mkTempDir } from './tempdir.js';

/** The directory that `npm ci` installs `replay` in. */
export const REPLAY_BIN = join(import.meta.dirname, '..', '..', '..', 'node_modules', '.bin');

/**
 * The variables of a test's `replay` children: `PATH` with `REPLAY_BIN`
 * first, `REPLAY_STATE` a new temporary directory, so the test starts with
 * no used entries and no sessions, and `REPLAY_SCRIPT` the script `script`.
 * Give them to `withEnv`, or spread them over a child's `env`.
 * @param {string} script  the path of the replay script
 * @returns {{ PATH: string, REPLAY_STATE: string, REPLAY_SCRIPT: string }}
 */
export function replayEnv(script) {
  return {
    PATH: `${REPLAY_BIN}${delimiter}${process.env.PATH ?? ''}`,
    REPLAY_STATE: mkTempDir('bl-replay-state-'),
    REPLAY_SCRIPT: script,
  };
}

/**
 * `PATH` without each directory that holds a `replay`, so the adapter finds
 * no program (D-479). `npm run` puts `node_modules/.bin` on the `PATH` of the
 * tests, so the test's own `PATH` may hold one.
 * @returns {{ PATH: string }}
 */
export function noReplayPath() {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => !existsSync(join(dir, 'replay')));
  return { PATH: dirs.join(delimiter) };
}
