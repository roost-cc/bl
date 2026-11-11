/**
 * hold-lock.js — hold a bl kernel lock (`flock(2)`, F-104) for a test, as
 * another holder would.
 *
 * `holdLock` holds it from the test process, on a descriptor of its own that
 * `kernel-lock.js` does not know, so bl code in this process and in its
 * children sees another holder (named by this process's PID). `holdLockInChild`
 * holds it from a child process that a test can kill, with SIGKILL for one.
 * Both write the file the way a holder does (D4): PID, time, one info line.
 */

import { closeSync, constants, ftruncateSync, openSync, writeSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import fsExt from 'fs-ext';
import { holderOf } from '../../src/kernel-lock.js';
import { spawnToFiles } from './spawn-files.js';

/**
 * Hold `path`'s lock from this process until `release()`. Throws EAGAIN when
 * anyone else holds it.
 *
 * @param {string} path
 * @param {string} [info]  the info line written after the PID and the time
 * @returns {{ content: string, release: () => void }}  `content` is what the file holds
 */
export function holdLock(path, info = 'held by the test') {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o644);
  try {
    fsExt.flockSync(fd, 'exnb');
    const content = `${process.pid}\n${new Date().toISOString()}\n${info}\n`;
    ftruncateSync(fd, 0);
    writeSync(fd, content, 0);
    let open = true;
    const release = () => {
      if (open) closeSync(fd);
      open = false;
    };
    return { content, release };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

const CHILD = `
import { holdLock } from ${JSON.stringify(import.meta.url)};
holdLock(process.argv[1], 'held by a test child');
setInterval(() => {}, 1 << 30);
`;

/**
 * Hold `path`'s lock from a child process. Resolves once the child holds it
 * (`holderOf` names the child), or rejects when it has not within `timeoutMs`.
 * `kill(signal)` (SIGKILL by default) ends the child and resolves once it is
 * gone.
 *
 * @param {string} path
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ pid: number, kill: (signal?: NodeJS.Signals) => Promise<void> }>}
 */
export async function holdLockInChild(path, { timeoutMs = 10_000 } = {}) {
  const run = spawnToFiles(process.execPath, ['--input-type=module', '-e', CHILD, path]);
  const { child } = run;
  const kill = async (signal = 'SIGKILL') => {
    child.kill(signal);
    await run.closed;
  };
  const start = Date.now();
  let gone = false;
  run.closed.then(() => (gone = true));
  while (holderOf(path) !== child.pid) {
    if (gone || Date.now() - start > timeoutMs) {
      await kill();
      throw new Error(`holdLockInChild: the child never held ${path}: ${run.read().stderr}`);
    }
    await delay(10);
  }
  return { pid: child.pid, kill };
}
