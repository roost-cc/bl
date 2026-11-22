/**
 * ignores-sigterm.js — a long child that ignores SIGTERM, for the tests of the
 * SIGKILL that follows a stop (F-128 A6).
 *
 * Copied from `test/helpers/ignores-sigterm.js` for `next/`, whose files
 * import nothing outside `next/` (F-135 D1), and cut down to the argv form:
 * the carried tests run no test-gate command line.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { waitUntil } from './wait-until.js';

/**
 * An `sh` script that ignores SIGTERM, then becomes `sleep 30`, which inherits
 * the ignored SIGTERM, as the argv `command` with `args`. `ready()` resolves
 * once the child ignores SIGTERM: it touches a file in `dir` after its `trap`.
 * `ready()` rejects when the file is not there after `timeoutMs`.
 * @param {string} dir  a directory for the ready file, its path free of `'`
 * @param {number} [timeoutMs]
 * @returns {{ command: string, args: string[], ready: () => Promise<void> }}
 */
export function ignoresSigterm(dir, timeoutMs) {
  const file = join(dir, 'ignores-sigterm');
  const script = `trap '' TERM; touch '${file}'; exec sleep 30`;
  return {
    command: 'sh',
    args: ['-c', script],
    async ready() {
      await waitUntil(() => (existsSync(file) ? true : undefined), `the ready file ${file}`, timeoutMs);
    },
  };
}
