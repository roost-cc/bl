/**
 * ignores-sigterm.js — a long child that ignores SIGTERM, for the tests of the
 * SIGKILL that follows a stop (F-128 A6).
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';

/**
 * An `sh` argv that ignores SIGTERM, then becomes `sleep 30`, which inherits
 * the ignored SIGTERM. `ready()` resolves once the child ignores SIGTERM: it
 * touches a file in `dir` after its `trap`.
 * @param {string} dir  a directory for the ready file
 * @returns {{ command: string, args: string[], ready: () => Promise<void> }}
 */
export function ignoresSigterm(dir) {
  const file = join(dir, 'ignores-sigterm');
  return {
    command: 'sh',
    args: ['-c', `trap '' TERM; touch "$1"; exec sleep 30`, 'sh', file],
    async ready() {
      while (!existsSync(file)) await sleep(10);
    },
  };
}
