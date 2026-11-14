/**
 * ignores-sigterm.js — a long child that ignores SIGTERM, for the tests of the
 * SIGKILL that follows a stop (F-128 A6).
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { waitUntil } from './wait-until.js';

/**
 * An `sh` script that ignores SIGTERM, then becomes `sleep 30`, which inherits
 * the ignored SIGTERM: `script` for a test-gate command, and `command` with
 * `args` for an argv. `ready()` resolves once the child ignores SIGTERM: it
 * touches a file in `dir` after its `trap`. `ready()` rejects when the file is
 * not there after `timeoutMs`.
 * @param {string} dir  a directory for the ready file, its path free of `'`
 * @param {number} [timeoutMs]
 * @returns {{ script: string, command: string, args: string[], ready: () => Promise<void> }}
 */
export function ignoresSigterm(dir, timeoutMs) {
  const file = join(dir, 'ignores-sigterm');
  const script = `trap '' TERM; touch '${file}'; exec sleep 30`;
  return {
    script,
    command: 'sh',
    args: ['-c', script],
    async ready() {
      await waitUntil(() => (existsSync(file) ? true : undefined), `the ready file ${file}`, timeoutMs);
    },
  };
}
