/**
 * tempdir.js — temp dirs for the tests of `next/` (F-135 D1).
 *
 * Copied from `test/helpers/tempdir.js`, cut down to `mkTempDir` and its
 * removal on exit and signals. The backlog fixtures stay out: they import
 * `src/`, and nothing in `next/` imports `src/`.
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const trackedDirs = new Set();

// Signals that end the process without an `exit` event: the test runner
// cancels a file with SIGTERM, Ctrl-C sends SIGINT, a closed terminal SIGHUP.
const TERMINATING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * Create a temp dir and remove it when the test process exits. Each test
 * file runs in its own process under `node --test`, so the dirs a file makes
 * are gone once its tests finish; a test that already removed its dir, or
 * never populated it, is fine because removal is forced.
 *
 * Removal runs on a normal end, `process.exit()`, an uncaught exception or
 * rejection, and SIGTERM, SIGINT or SIGHUP. SIGKILL cannot be caught, so a
 * killed process leaves its dirs behind.
 *
 * @param {string} prefix  mkdtemp prefix, for example "bl-wt-"
 * @param {string} [parent] directory to create it in (default os.tmpdir())
 * @returns {string} the new directory
 */
export function mkTempDir(prefix, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, prefix));
  if (trackedDirs.size === 0) {
    process.once('exit', removeTrackedDirs);
    for (const signal of TERMINATING_SIGNALS) process.on(signal, onSignal);
  }
  trackedDirs.add(dir);
  return dir;
}

// Listening for a signal replaces its default of ending the process, so
// once the dirs are gone, re-raise it. When another listener handles the
// signal, that listener decides whether the process ends; its own
// `process.exit` runs the `exit` listener, which removes the dirs.
function onSignal(signal) {
  if (process.listenerCount(signal) > 1) return;
  removeTrackedDirs();
  for (const s of TERMINATING_SIGNALS) process.removeListener(s, onSignal);
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

// A dir that cannot be removed (a test left it read-only) is skipped, not
// thrown: a throw here would fail a file whose tests passed and leave every
// later dir behind.
function removeTrackedDirs() {
  for (const dir of trackedDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // left behind; nothing useful to do while the process exits
    }
  }
  trackedDirs.clear();
}
