/**
 * replay.js — the `replay` adapter (agents.md, "The replay agent"; F-141 D4).
 *
 * It runs the `replay` program of F-147, a scripted agent that needs no
 * account and uses no tokens, so flow tests run an `agent` box without an
 * agent account. The program is found on the `PATH` (D-497).
 *
 * - Every call runs with the arguments and environment of `profileCommand`.
 * - `capacity` gives `replay capacity`'s object. When the program is not on
 *   the `PATH`, it gives no capacity, so the step goes on to the next entry
 *   of its list (D-479). That holds for `replay` only.
 * - `start` runs `replay --session-id <id> …` with the prompt on stdin, and
 *   `resume` runs `replay --resume <id> …`. Each session is a long child in a
 *   process scope where user systemd has scopes (D-486).
 * - Headless, the child's stdout and stderr are kept, and stderr is written
 *   to `bl`'s stderr. Interactive, they go to `/dev/tty`, never to `bl`'s
 *   stdout (D-30).
 * - The result is the JSON of the result file; the usage is zeros.
 */

import { randomUUID } from 'crypto';
import { closeSync, openSync, readFileSync, statSync } from 'fs';
import { describeExit, exitStatus, findOnPath, lastLine, runChild } from '../lib/child.js';
import { runScopedChild } from '../lib/process-scope.js';
import { profileCommand } from './profile.js';

/** @typedef {import('./index.js').Adapter} Adapter */
/** @typedef {import('./index.js').AgentRun} AgentRun */
/** @typedef {import('./index.js').Ended} Ended */
/** @typedef {import('./index.js').Profile} Profile */

const PROGRAM = 'replay';

/** `replay` uses no tokens. */
const NO_USAGE = Object.freeze({ input: 0, output: 0, cache_creation: 0, cache_read: 0 });

/**
 * One fault for a `model`: `replay` takes none.
 * @param {Profile} profile
 * @returns {string[]}
 */
function faults(profile) {
  return profile.model === undefined
    ? []
    : [`the replay adapter takes no model, and this profile gives '${profile.model}'`];
}

/** Whether `value` is a string or `null`. */
const stringOrNull = (/** @type {unknown} */ value) => value === null || typeof value === 'string';

/** Why `capacity`, `start` and `resume` give up when `programOf` finds no `replay`. */
const NOT_ON_PATH = 'replay is not on the PATH';

/**
 * The `replay` file on the profile's `PATH` (`findOnPath`), or `undefined`.
 * `capacity`, `start` and `resume` each run the file it gives, so all three
 * agree on which `PATH` entries can launch `replay`.
 * @param {Profile} profile
 */
const programOf = (profile) => findOnPath(PROGRAM, profileCommand([], profile).env.PATH);

/**
 * `replay capacity`'s object, or no capacity when the program is not on the
 * `PATH`.
 * @param {Profile} profile
 * @returns {Promise<import('./index.js').Capacity>}
 * @throws {Error} when `replay capacity` fails, prints no JSON, or prints no
 *   object with a boolean `available` and a string or `null` `resets_at` and `message`
 */
async function capacity(profile) {
  const program = programOf(profile);
  if (program === undefined) return { available: false, resets_at: null, message: NOT_ON_PATH };
  const { args, env } = profileCommand(['capacity'], profile);
  const r = runChild(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  if (r.error || r.status !== 0) throw new Error(`replay capacity failed: ${describeExit(r, 'replay capacity')}`);
  let record;
  try {
    record = JSON.parse(String(r.stdout));
  } catch (e) {
    throw new Error(`replay capacity printed no JSON: ${e.message}`);
  }
  if (
    record === null ||
    typeof record !== 'object' ||
    typeof record.available !== 'boolean' ||
    !stringOrNull(record.resets_at) ||
    !stringOrNull(record.message)
  ) {
    throw new Error(`replay capacity printed no capacity record: ${String(r.stdout).trim()}`);
  }
  return { available: record.available, resets_at: record.resets_at, message: record.message };
}

/**
 * @typedef {{ program: string, tty: number|null }} Launch  what a session needs to launch:
 *   the `replay` file, and the terminal it writes to when interactive
 */

/** An `Ended` for a session that could not start, and why. */
const notStarted = (/** @type {string} */ why) => ({
  result: null,
  error: `replay could not start: ${why}`,
  usage: NO_USAGE,
});

/**
 * What a session of `run` needs to launch, or why it cannot: `replay` is not
 * on the `PATH`, `run.cwd` is not a directory, or an interactive session
 * cannot open `/dev/tty`. `start` asks before it gives out an id, so each
 * failure that can be found before the launch keeps no id.
 * @param {AgentRun} run
 * @returns {Launch|{ why: string }}
 */
function launchOf(run) {
  const program = programOf(run.profile);
  if (program === undefined) return { why: NOT_ON_PATH };
  if (!statSync(run.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return { why: `the working directory ${run.cwd} does not exist` };
  }
  if (run.mode !== 'interactive') return { program, tty: null };
  try {
    return { program, tty: openSync('/dev/tty', 'w') };
  } catch (e) {
    return { why: `cannot open /dev/tty: ${e.message}` };
  }
}

/**
 * Run one session: `replay <sessionArgs> --schema … --result … [--interactive]`
 * in `run.cwd`, with the prompt on stdin. It closes `launch.tty`.
 * @param {AgentRun} run
 * @param {string[]} sessionArgs  `--session-id <id>` or `--resume <id>`
 * @param {Launch} launch
 * @returns {Promise<{ launched: boolean, ended: Ended }>}  `launched` is false when the
 *   child (`replay`, or the `systemd-run` of its process scope) could not be spawned
 * @throws {Error} when the session's process scope cannot be stopped
 */
async function session(run, sessionArgs, { program, tty }) {
  const { args, env } = profileCommand(
    [
      ...sessionArgs,
      '--schema',
      run.schemaPath,
      '--result',
      run.resultPath,
      ...(tty === null ? [] : ['--interactive']),
    ],
    run.profile,
  );
  let ran;
  try {
    const out = tty ?? 'pipe';
    ran = await runScopedChild(
      program,
      args,
      { cwd: run.cwd, env, encoding: 'utf8', input: run.prompt, stdio: ['pipe', out, out] },
      run.unit,
    );
  } finally {
    if (tty !== null) closeSync(tty);
  }
  const { result: r, unit, stop } = ran;
  // No pid: the spawn failed, so nothing ran, and no scope was made to stop.
  if (!r.pid) return { launched: false, ended: notStarted(r.error?.message ?? 'the spawn failed') };
  return { launched: true, ended: endedOf(run, r, unit, stop) };
}

/**
 * The `Ended` of a session that launched.
 * @param {AgentRun} run
 * @param {Awaited<ReturnType<typeof runScopedChild>>['result']} r
 * @param {string|null} unit
 * @param {{ ok: boolean, output?: string }} stop
 * @returns {Ended}
 * @throws {Error} when the session's process scope cannot be stopped
 */
function endedOf(run, r, unit, stop) {
  if (r.stderr) process.stderr.write(r.stderr);
  if (!stop.ok) throw new Error(`could not stop what replay left in ${unit}.scope: ${stop.output}`);
  const code = exitStatus(r);
  if (code !== 0) {
    const line = r.error ? r.error.message : lastLine(r.stderr);
    return { result: null, error: `replay exited ${code}${line === undefined ? '' : `: ${line}`}`, usage: NO_USAGE };
  }
  try {
    return { result: JSON.parse(readFileSync(run.resultPath, 'utf8')), error: null, usage: NO_USAGE };
  } catch (e) {
    return { result: null, error: `could not read the result ${run.resultPath}: ${e.message}`, usage: NO_USAGE };
  }
}

/**
 * A new session: its id is made here and given to `run.onSession` before
 * `replay` starts. A session that cannot launch (`launchOf`) gives no id. A
 * spawn that fails after the id was given drops it again with
 * `run.onSession(null)`. So no later invocation resumes a session that never
 * started.
 * @param {AgentRun} run
 * @returns {Promise<Ended>}
 */
async function start(run) {
  const launch = launchOf(run);
  if ('why' in launch) return notStarted(launch.why);
  const id = randomUUID();
  try {
    await run.onSession(id);
  } catch (e) {
    if (launch.tty !== null) closeSync(launch.tty);
    throw e;
  }
  const { launched, ended } = await session(run, ['--session-id', id], launch);
  if (!launched) await run.onSession(null);
  return ended;
}

/**
 * The session `run.session`, continued after its last finished turn. Its id
 * stays kept when it cannot launch: the session started before.
 * @param {AgentRun} run
 * @returns {Promise<Ended>}
 */
async function resume(run) {
  const launch = launchOf(run);
  if ('why' in launch) return notStarted(launch.why);
  return (await session(run, ['--resume', /** @type {string} */ (run.session)], launch)).ended;
}

/** @type {Adapter} */
export const replay = Object.freeze({ faults, capacity, start, resume });
