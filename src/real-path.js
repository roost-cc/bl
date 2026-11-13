/**
 * real-path.js — a path with its symlinks resolved, for comparing two paths
 * that may name one directory through different links.
 */

import { realpathSync } from 'fs';
import { resolve } from 'path';

/**
 * `path` with its symlinks resolved, or `path` resolved as given when it is
 * not there.
 *
 * @param {string} path
 * @returns {string}
 */
export function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
