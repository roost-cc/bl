/**
 * partial-write.js — run code with the disk filling up mid-write.
 *
 * `withPartialWrites(target, fn)` makes every `writeFileSync` to `target`, or
 * to its staging file under a `.bl/tmp/` directory (`atomic-write.js`), write
 * its first ten bytes and then throw ENOSPC, for the duration of `fn`. ESM
 * importers of `fs` see the stub through `syncBuiltinESMExports`.
 * `installPartialWrites(target)` installs the same stub until the returned
 * function is called (a fault preloaded into a `bl` child process).
 * With `when`, only a write whose text `when(text)` accepts fails: staging
 * files are named for the target's basename, and every spec is an
 * `index.md`.
 */

import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { basename, sep } from 'path';

const STAGING = `${sep}.bl${sep}tmp${sep}`;

/**
 * @template T
 * @param {string} target
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPartialWrites(target, fn) {
  const restore = installPartialWrites(target);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/**
 * @param {string} target
 * @param {{ when?: (text: string) => boolean }} [opts]
 * @returns {() => void} the restore
 */
export function installPartialWrites(target, { when } = {}) {
  const write = fs.writeFileSync;
  const staging = `${STAGING}${basename(target)}.`;
  fs.writeFileSync = (path, text, ...rest) => {
    if (path !== target && !String(path).includes(staging)) return write(path, text, ...rest);
    if (when && !when(String(text))) return write(path, text, ...rest);
    write(path, String(text).slice(0, 10), ...rest);
    throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
  };
  syncBuiltinESMExports();
  return () => {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  };
}
