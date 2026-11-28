/**
 * flow-child-run.js — start `flow-child.js` for a test that signals the process that holds an item
 * (F-152 D3, D7).
 */

import { spawn } from 'child_process';
import { closeSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from './tempdir.js';

export const FLOW_CHILD = join(import.meta.dirname, 'flow-child.js');

/**
 * Start `flow-child.js` on item `id` of the backlog `backlogDir`, with `entry` (or `resume`) and
 * `flags` (`wake`, `hang`). Its stderr goes to a file. The test's end sends the child SIGKILL, so
 * a failed assertion leaves no child behind.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} backlogDir
 * @param {string} id
 * @param {string} entry
 * @param {string[]} flags
 * @returns {{
 *   child: import('child_process').ChildProcess,
 *   exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }>,
 *   stderr: () => string,
 * }}
 */
export function startFlowChild(t, backlogDir, id, entry, flags) {
  const dir = mkTempDir('bl-flow-child-');
  const stderrFile = join(dir, 'stderr');
  const fd = openSync(stderrFile, 'w');
  const child = spawn(process.execPath, [FLOW_CHILD, backlogDir, id, entry, join(dir, 'result.json'), ...flags], {
    stdio: ['ignore', 'ignore', fd],
  });
  closeSync(fd);
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  return { child, exited, stderr: () => readFileSync(stderrFile, 'utf8') };
}
