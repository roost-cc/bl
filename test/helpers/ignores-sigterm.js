/**
 * ignores-sigterm.js — a long child that ignores SIGTERM, for the tests of the
 * SIGKILL that follows a stop (F-128 A6).
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';

/**
 * An `sh` script that ignores SIGTERM, then becomes `sleep 30`, which inherits
 * the ignored SIGTERM: `script` for a test-gate command, and `command` with
 * `args` for an argv. `ready()` resolves once the child ignores SIGTERM: it
 * touches a file in `dir` after its `trap`.
 * @param {string} dir  a directory for the ready file, its path free of `'`
 * @returns {{ script: string, command: string, args: string[], ready: () => Promise<void> }}
 */
export function ignoresSigterm(dir) {
  const file = join(dir, 'ignores-sigterm');
  const script = `trap '' TERM; touch '${file}'; exec sleep 30`;
  return {
    script,
    command: 'sh',
    args: ['-c', script],
    async ready() {
      while (!existsSync(file)) await sleep(10);
    },
  };
}
