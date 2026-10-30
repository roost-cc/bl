/**
 * spawn-files.js — start a child asynchronously with its stdout and stderr on
 * files, for a test that runs a child alongside its own work (F-70 D1).
 *
 * Inside Codex's sandbox a Node child whose stdout or stderr is a socket, the
 * `'pipe'` Node gives it, writes into nothing: the parent reads empty output
 * from a child that exited 0. A file works there and everywhere else. The
 * synchronous form is `spawnSyncFiles` (`src/child-stdio.js`).
 */

import { spawn } from 'child_process';
import { closeSync, openSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from './tempdir.js';

/**
 * Start `command args` with stdin ignored and stdout and stderr on files in a
 * fresh temp dir.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import('child_process').SpawnOptions} [opts]  spawn options; `stdio` is set here
 * @returns {{ child: import('child_process').ChildProcess,
 *            stderrPath: string,
 *            read: () => { stdout: string, stderr: string },
 *            closed: Promise<{ stdout: string, stderr: string,
 *                              status: number | null,
 *                              signal: NodeJS.Signals | null,
 *                              error: Error | null }> }}
 *          `read` returns what the child has written so far (all of it once
 *          it has closed), decoded whole so a multi-byte character split
 *          across writes stays intact. `closed`
 *          resolves once the child has closed, or failed to start (`error`
 *          set, `status` and `signal` null), with everything it wrote; the
 *          files are removed then.
 */
export function spawnToFiles(command, args, opts = {}) {
  const dir = mkTempDir('bl-spawn-files-');
  const outPath = join(dir, 'stdout');
  const errPath = join(dir, 'stderr');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let child;
  try {
    child = spawn(command, args, { ...opts, stdio: ['ignore', outFd, errFd] });
  } finally {
    // The child holds its own copies.
    closeSync(outFd);
    closeSync(errFd);
  }
  const text = (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  };
  // Once the child is gone the files are too; `read` then returns their last text.
  let final = null;
  const read = () => final ?? { stdout: text(outPath), stderr: text(errPath) };
  const closed = new Promise((resolve) => {
    let error = null;
    const finish = (status, signal) => {
      if (final) return;
      final = read();
      rmSync(dir, { recursive: true, force: true });
      resolve({ ...final, status, signal: signal ?? null, error });
    };
    child.on('close', finish);
    // A child that cannot start emits "error" and may never "close".
    child.on('error', (err) => {
      error ??= err;
      if (child.pid === undefined) finish(null, null);
    });
  });
  return { child, stderrPath: errPath, read, closed };
}
