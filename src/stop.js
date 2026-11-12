/**
 * stop.js — `bl stop <F-id|S-id>`: stop a running `bl run` cleanly, so that
 * `bl run <id> --resume` continues it (F-87 Design D7a, Decision A4; S-1335).
 *
 * The run loop is synchronous (agents start through `spawnSync`), so a signal
 * to its bl would be handled only after the run ends. Instead `bl stop`:
 *
 * 1. reads the run state. With none, or one that is not `running`, there is
 *    nothing to stop: a live holder of the run lock is then a `bl review` or
 *    a `bl merge`. Then it reads the holder of the run lock
 *    `.bl/run/<id>.lock`. With none, the run's bl died: `bl stop` writes
 *    `status: stopped` itself.
 * 2. writes the stop request `.bl/run/<id>.stop` (`stopRequestPath`): JSON
 *    with its own pid and the time.
 * 3. stops each process scope of the holder (`scopesOf`), which ends the
 *    current session or test-gate command. The loop's spawn returns, and the
 *    loop finds the request (`checkStop` in feature-run.js), records
 *    `stopped`, releases its locks and exits 130.
 * 4. waits up to STOP_WAIT_MS for the run lock to go.
 *
 * It never sends a signal to the bl process. Without user systemd there is no
 * scope to stop, and the run stops at its next check. `bl stop` is a short
 * command (F-122 D2): it neither takes nor checks work unit locks, because the
 * run it stops holds them. stdout stays empty; every line goes to stderr.
 */

import { rmSync, writeFileSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { loadConfig } from './config.js';
import { loadRunState, markStopped, saveRunState } from './feature-run.js';
import { otherHolder } from './kernel-lock.js';
import { scopeAvailable, scopesOf, stopScope } from './process-scope.js';
import { runArgs } from './run-arg.js';
import { ensureRunDir, runLockPath, stopRequestPath } from './run-lock.js';

/** How long `bl stop` waits for the run lock to go, in ms (F-87 D7a). */
export const STOP_WAIT_MS = 30_000;

/** How often `bl stop` checks the run lock while it waits, in ms. */
const STOP_POLL_MS = 200;

const HELP = `Usage: bl stop <F-id|S-id>

Stop a running bl run cleanly. Continue it later with bl run <id> --resume.

bl stop writes the stop request .bl/run/<id>.stop and stops the run's agent
session or test command (its user systemd scope). The run then records
"stopped", releases its locks and exits 130. bl stop waits up to
${STOP_WAIT_MS / 1000} s for that. Without user systemd, the run stops when its
current session ends. The work unit's status does not change, and bl stop
never sends a signal to the bl process.

A run state that says running while no bl holds the run (the bl died) is
marked stopped at once.

Output (stderr; stdout stays empty):
  stopped <id> at <step>; resume: bl run <id> --resume

Exit codes:
  0   The run stopped.
  1   No running run for the id, a bad argument, or the run still holds its
      lock after ${STOP_WAIT_MS / 1000} s: "stop requested: <id> (pid <n>) stops at its
      next check". The request stays, and the run stops at its next check.`;

/** The line `bl stop` ends with when the run stopped. */
function stoppedLine(id, step, why = '') {
  return `stopped ${id} at ${step}${why}; resume: bl run ${id} --resume`;
}

/**
 * Stop run `id`; resolves to the exit code. `err(line)` gets each line.
 *
 * @param {{ config: object, id: string, err: (line: string) => void,
 *   waitMs?: number, pollMs?: number }} opts
 * @returns {Promise<number>}
 */
export async function stopRun({ config, id, err, waitMs = STOP_WAIT_MS, pollMs = STOP_POLL_MS }) {
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
  const holder = otherHolder(lock);
  if (holder == null) {
    markStopped(state, 'stopped by bl stop: no live bl held the run');
    saveRunState(config, state);
    err(stoppedLine(id, state.step, ' (no live bl held the run)'));
    return 0;
  }

  const request = stopRequestPath(config, id);
  ensureRunDir(config);
  writeFileSync(request, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  // A holder the lock file does not name yet has no scopes to find.
  if (holder !== 'unknown' && scopeAvailable().ok) {
    let scopes = [];
    try {
      scopes = scopesOf(id, holder);
    } catch (e) {
      err(`bl stop: ${e.message}; the run stops at its next check`);
    }
    for (const unit of scopes) {
      const r = stopScope(unit);
      if (!r.ok) err(`bl stop: could not stop ${unit}.scope: ${r.output}`);
    }
  }

  const end = Date.now() + waitMs;
  while (otherHolder(lock) != null) {
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
  // The run ended on its own before it read the request, which nobody reads now.
  rmSync(request, { force: true });
  err(`${id} ended ${after?.status ?? 'with no run state'} at ${after?.step ?? '?'} before it read the stop request`);
  return 0;
}

export async function main(argv) {
  const parsed = runArgs('stop', argv, { help: HELP });
  if (!parsed) return;
  process.exitCode = await stopRun({ config: loadConfig(), id: parsed.id, err: (line) => console.error(line) });
}
