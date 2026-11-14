/**
 * stop.js — `bl stop <F-id|B-id|S-id>`: stop a running `bl run` cleanly, so that
 * `bl run <id> --resume` continues it (F-87 Design D7a, Decision A4; S-1335;
 * F-128 D9). `bl stop`:
 *
 * 1. reads the run state. With none, or one that is not `running`, there is
 *    nothing to stop: a live holder of the run lock is then a `bl review` or
 *    a `bl merge`. Then it reads the holder of the run lock
 *    `.bl/run/<id>.lock` (`runHolder`). With none, the run's bl died: `bl
 *    stop` takes the run lock, reads the state again and writes `status:
 *    stopped` itself (`markDead`). A holder that is not a `bl run` (a review
 *    or a merge of a state a dead bl left `running`) gets no request.
 * 2. writes its stop request, a file of its own in `.bl/run/<id>.stop/`
 *    (`writeStopRequest`): JSON with its own pid, the time and `holder`, the
 *    pid of the run it stops. It deletes no other `bl stop`'s request.
 * 3. sends SIGTERM to the holder. `bl run` takes it as a stop (F-128 D8): it
 *    sends SIGTERM to the current session or test-gate command, then SIGKILL
 *    if it still runs 10 s later (F-128 A6). When that exits, the run finds the request (`checkStop` in feature-run.js),
 *    records `stopped`, releases its locks and exits 130. A holder that is
 *    already gone (`ESRCH`) needs no signal; any other failure is one line,
 *    and the run stops at its next check.
 * 4. waits up to STOP_WAIT_MS for that holder to let the run lock go.
 *
 * This works with or without user systemd. `bl stop` is a short
 * command (F-122 D2): it neither takes nor checks work unit locks, because the
 * run it stops holds them. stdout stays empty; every line goes to stderr.
 */

import { rmSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { loadConfig } from './config.js';
import { loadRunState, markStopped, saveRunState } from './feature-run.js';
import { otherHolder } from './kernel-lock.js';
import { runArgs } from './run-arg.js';
import { acquireRunLock, releaseRunLock, runHolder, runLockPath, writeStopRequest } from './run-lock.js';

/** How long `bl stop` waits for the run lock to go, in ms (F-87 D7a). */
export const STOP_WAIT_MS = 30_000;

/** How often `bl stop` checks the run lock while it waits, in ms. */
const STOP_POLL_MS = 200;

const HELP = `Usage: bl stop <F-id|B-id|S-id>

Stop a running bl run cleanly. Continue it later with bl run <id> --resume.

bl stop writes a stop request in .bl/run/<id>.stop/ and sends SIGTERM to the
run's bl. The run then sends SIGTERM to its agent session or test command,
and SIGKILL if it still runs 10 s later. When that exits, the run records "stopped", releases its locks and exits 130.
bl stop waits up to ${STOP_WAIT_MS / 1000} s for that. The work unit's status
does not change.

A run state that says running while no bl holds the run (the bl died) is
marked stopped at once.

Output (stderr; stdout stays empty):
  stopped <id> at <step>; resume: bl run <id> --resume

Exit codes:
  0   The run stopped.
  1   No running run for the id (a bl review or bl merge holds it), a bad
      argument, a holder that has not written its pid yet, a stop request
      that could not be written (nothing stopped), or the run still
      holds its lock after ${STOP_WAIT_MS / 1000} s: "stop requested: <id> (pid <n>) stops at its
      next check". The request stays, and the run stops at its next check.`;

/** The line `bl stop` ends with when the run stopped. */
function stoppedLine(id, step, why = '') {
  return `stopped ${id} at ${step}${why}; resume: bl run ${id} --resume`;
}

/**
 * Mark the `running` run state of `id`, which no bl holds, stopped. `bl stop`
 * holds the run lock while it reads and saves the state again, so a `bl run`
 * that takes the run after the check is never marked: it is refused, or it
 * finds the lock free after the save. Returns the exit code.
 */
export function markDead(config, id, err) {
  const lock = acquireRunLock(config, id, `bl stop ${id}`);
  if (lock.holder != null) {
    err(`bl stop: another bl (pid ${lock.holder}) took ${id} just now; nothing stopped`);
    return 1;
  }
  try {
    const state = loadRunState(config, id);
    if (state?.status !== 'running') {
      err(`no running run for ${id}`);
      return 1;
    }
    markStopped(state, 'stopped by bl stop: no live bl held the run', [process.pid]);
    saveRunState(config, state);
    err(stoppedLine(id, state.step, ' (no live bl held the run)'));
    return 0;
  } finally {
    releaseRunLock(lock.taken);
  }
}

/**
 * Stop run `id`; resolves to the exit code. `err(line)` gets each line.
 *
 * `kill(pid, signal)` sends the SIGTERM (default `process.kill`), a test seam.
 *
 * @param {{ config: object, id: string, err: (line: string) => void,
 *   waitMs?: number, pollMs?: number,
 *   kill?: (pid: number, signal: string) => unknown }} opts
 * @returns {Promise<number>}
 */
export async function stopRun({ config, id, err, waitMs = STOP_WAIT_MS, pollMs = STOP_POLL_MS, kill = process.kill }) {
  let state;
  try {
    state = loadRunState(config, id);
  } catch (e) {
    err(`bl stop: ${e.message}`);
    return 1;
  }
  // A run lock held for a state that is not `running` is a `bl review` or a
  // `bl merge` (they take it too), which `bl stop` leaves alone.
  if (state?.status !== 'running') {
    err(`no running run for ${id}`);
    return 1;
  }
  const lock = runLockPath(config, id);
  const seen = runHolder(config, id);
  if (seen == null) return markDead(config, id, err);
  const holder = seen.pid;
  // A request names the run it stops; a holder that has not written its lock file yet cannot be named.
  if (holder === 'unknown') {
    err(`bl stop: the bl that holds ${id} has not written its pid yet; try again`);
    return 1;
  }
  // A review or a merge of a run state left `running` by a bl that died.
  if (!seen.run) {
    err(`no running run for ${id}: another bl (pid ${holder}) holds it, not a bl run`);
    return 1;
  }

  let request;
  try {
    request = writeStopRequest(config, id, holder);
  } catch (e) {
    err(`bl stop: cannot write the stop request: ${e.message}; nothing stopped`);
    return 1;
  }
  try {
    kill(holder, 'SIGTERM');
  } catch (e) {
    // A holder that is gone lets the lock go; the wait finds it free.
    if (e.code !== 'ESRCH') err(`bl stop: could not signal pid ${holder}: ${e.message}`);
  }

  const end = Date.now() + waitMs;
  // Until the run it saw lets go: a later holder is another run, which the request does not stop.
  while (otherHolder(lock) === holder) {
    if (Date.now() >= end) {
      err(`stop requested: ${id} (pid ${holder}) stops at its next check`);
      return 1;
    }
    await delay(pollMs);
  }
  let after = null;
  try {
    after = loadRunState(config, id);
  } catch {
    // The run is gone either way; the line below says what is known.
  }
  if (after?.status === 'stopped') {
    err(stoppedLine(id, after.step));
    return 0;
  }
  // The run ended on its own before it read the request, which nobody reads
  // now. Only this bl stop's own file goes: another bl stop's request stays.
  rmSync(request, { force: true });
  err(`${id} ended ${after?.status ?? 'with no run state'} at ${after?.step ?? '?'} before it read the stop request`);
  return 0;
}

export async function main(argv) {
  const parsed = runArgs('stop', argv, { help: HELP });
  if (!parsed) return;
  process.exitCode = await stopRun({ config: loadConfig(), id: parsed.id, err: (line) => console.error(line) });
}
