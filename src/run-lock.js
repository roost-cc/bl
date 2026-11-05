/**
 * run-lock.js — where bl's run locks and run state live, and the lock the
 * `bl updates` commands share. Dependency-free (node built-ins only), so
 * running-man's `provision/tick-lock.mjs` can take the updates run lock with
 * bl's own definition even when bl's dependencies are not installed (F-74 D4).
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/** The run directory under the backlog root: machine-local scratch. */
export const RUN_DIR = join('.bl', 'run');

/** The run lock id `bl updates sync`, `vulns`, `run`, `approve` and `drop` share. */
export const RUN_LOCK_ID = 'updates';

/** `<backlog>/.bl/run/<id>.lock`. */
export function runLockPath(config, featureId) {
  return join(config.backlogRoot, RUN_DIR, `${featureId}.lock`);
}

export function ensureRunDir(config) {
  const dir = join(config.backlogRoot, RUN_DIR);
  mkdirSync(dir, { recursive: true });
  // Self-ignoring directory: run state is machine-local scratch and must never
  // ride along with a backlog commit.
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '*\n');
}
