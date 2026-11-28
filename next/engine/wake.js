/**
 * wake.js — the wake of a process that a gate or a `wait` box suspended
 * (F-152 D3; flows.md, "Waking a suspended process", D-21, D-22).
 *
 * `waitForWake(ctx, { failing, agents })` resolves at the first of four
 * sources, and removes the watchers of all four before it resolves:
 *
 *   1. `reflog`: a change of the backlog's `HEAD` reflog, the file that
 *      `git rev-parse --git-path logs/HEAD` names. Every commit, pull, merge
 *      and reset changes it. The changes of one burst give one wake: it
 *      resolves `BURST_MS` after the last change;
 *   2. `signal`: SIGUSR2, which `bl resume` sends (D-22);
 *   3. `timer`: `gate_recheck_minutes` of the flow set (D-21);
 *   4. `capacity`: when a failing entry calls `has_capacity()`, the earliest
 *      `resets_at` in the future among the profiles of `agents` that have no
 *      capacity, when it comes before the timer. A profile with
 *      `resets_at: null` adds none.
 *
 * It watches the reflog's directory, not the file, so a rewrite of the file
 * (a `git reflog expire` renames a new file over it) still wakes it.
 */

import { watch } from 'fs';
import { basename, dirname, resolve } from 'path';
import { celEnvironment } from '../config/cel.js';
import { gitOut } from '../lib/child.js';
import { capacityOf } from '../steps/capacity.js';
import { celNodes } from './derive.js';

/**
 * @typedef {import('./conditions.js').EngineContext} EngineContext
 * @typedef {import('./gates.js').FailingEntry} FailingEntry
 * @typedef {'reflog'|'signal'|'timer'|'capacity'} WakeSource
 */

/** How long the reflog stays unchanged before its burst of changes wakes the process, in ms. */
export const BURST_MS = 500;

/**
 * Whether the failing entry `failing` calls `has_capacity()`. A dependency
 * entry evaluates over another item, which has no agent box, so it never does.
 * @param {import('@marcbachmann/cel-js').Environment} env
 * @param {FailingEntry} failing
 */
function callsCapacity(env, { entry }) {
  if (typeof entry === 'object' && 'item' in entry) return false;
  const expr = typeof entry === 'string' ? entry : entry.condition;
  return [...celNodes(env.parse(expr).ast)].some(
    ({ op, args }) => op === 'call' && /** @type {unknown[]} */ (args)[0] === 'has_capacity',
  );
}

/**
 * The time of the earliest capacity reset (source 4), in ms since the epoch,
 * or `null` when there is none to wait for. The caller schedules it from the
 * time, so the capacity calls do not move it later.
 * @param {EngineContext} ctx
 * @param {readonly FailingEntry[]} failing
 * @param {readonly string[]} [agents]
 * @returns {Promise<number|null>}
 */
async function capacityReset(ctx, failing, agents) {
  if (agents === undefined) return null;
  const env = celEnvironment(ctx.config.celInputs);
  if (!failing.some((entry) => callsCapacity(env, entry))) return null;
  const now = Date.now();
  /** @type {number[]} */
  const resets = [];
  for (const name of new Set(agents)) {
    const { available, resets_at } = await capacityOf(ctx, name);
    // A reset in the past would wake the process at once, again and again: the timer covers it.
    const at = resets_at === null ? NaN : Date.parse(resets_at);
    if (!available && at > now) resets.push(at);
  }
  return resets.length === 0 ? null : Math.min(...resets);
}

/**
 * Resolve at the next wake of a suspended process, with its source.
 * @param {EngineContext} ctx
 * @param {{ failing: readonly FailingEntry[], agents?: readonly string[] }} suspend  the failing
 *   entries that hold the item, and the `agents` list that the box's step gate checked
 * @returns {Promise<WakeSource>}
 * @throws {Error} when the capacity call of a profile fails
 */
export async function waitForWake(ctx, { failing, agents }) {
  const reflog = resolve(ctx.backlogDir, gitOut(ctx.backlogDir, ['rev-parse', '--git-path', 'logs/HEAD']));
  const recheck = ctx.flowSet.gateRecheckMinutes * 60_000;
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  /** @type {NodeJS.Timeout|undefined} */
  let burst;
  /** @type {(source: WakeSource) => void} */
  let wake = () => {};
  const woken = new Promise((/** @type {(source: WakeSource) => void} */ done) => (wake = done));
  const onSignal = () => wake('signal');
  // The watcher starts first, so a commit during the capacity calls below still wakes the process.
  const watcher = watch(dirname(reflog), (_event, name) => {
    if (name !== null && name !== basename(reflog)) return;
    clearTimeout(burst);
    burst = setTimeout(() => wake('reflog'), BURST_MS);
  });
  process.on('SIGUSR2', onSignal);
  const start = Date.now();
  timers.push(setTimeout(() => wake('timer'), recheck));
  try {
    // A wake during the capacity calls is kept: `woken` resolves with it as soon as they return.
    const at = await capacityReset(ctx, failing, agents);
    if (at !== null && at < start + recheck) {
      timers.push(setTimeout(() => wake('capacity'), Math.max(0, at - Date.now())));
    }
    return await woken;
  } finally {
    watcher.close();
    clearTimeout(burst);
    timers.forEach(clearTimeout);
    process.off('SIGUSR2', onSignal);
  }
}
