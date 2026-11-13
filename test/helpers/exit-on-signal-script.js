/**
 * Run module code in a Node child that calls `exitOnSignal()` first, as `bl.js`
 * does, and prints `after` last. A test of the F-114 D2 raise checks that the
 * child exited 130 or 143 with the `bl: <child> was ended by <signal>` line,
 * and that `after` never appeared.
 */

import { spawnSyncFiles } from '../../src/child-stdio.js';

const SIGNAL_EXIT = new URL('../../src/signal-exit.js', import.meta.url).href;

/**
 * @param {string[]} lines  the module's code: its imports, then the calls
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function runAfterExitOnSignal(lines, { env = process.env } = {}) {
  const script = [
    `import { exitOnSignal } from ${JSON.stringify(SIGNAL_EXIT)};`,
    'exitOnSignal();',
    ...lines,
    `console.log('after');`,
  ].join('\n');
  return spawnSyncFiles(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}
