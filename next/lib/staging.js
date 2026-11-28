/**
 * staging.js — the backlog's ignored scratch directory, `.bl/tmp/`.
 *
 * `atomic-write.js` stages each file there before its rename, and the agent
 * step makes each session's prompt, schema and result directory there
 * (F-141 D5). `.bl/` is in every backlog's `.gitignore`, so nothing in it
 * shows in `git status`. This module holds only the path, so a module that
 * needs the directory does not import the atomic write, which only the store
 * and the merge driver may import.
 */

import { join } from 'path';

/** Staging directory under the backlog root. */
export const STAGING_DIR = join('.bl', 'tmp');
