/**
 * run-state.js — reading an item's run state, and the flow-change reset
 * (F-139 D6).
 *
 *   - `readRunState(ctx, id, state)` gives the run state as `bl` reads it: a
 *     stored `active: <box>` of this host whose item lock no process holds is
 *     `interrupted: <box>` (D-3, D-50). The lock is local, so an `active` of
 *     another host reads as stored (D-4).
 *   - `checkAgainstFlow(flowSet, type, state)` finds what the stored state
 *     names that the current flow no longer has, and gives the reset state and
 *     its `reset` log entry (D-46, Decision A3). It is pure: the runner writes
 *     the reset, under the item lock, before an invocation starts.
 */

import { hostname } from 'os';
import { holderOf } from '../lib/kernel-lock.js';
import { itemLockPath } from '../lib/lock.js';

/** @typedef {import('./flow-set.js').FlowSet} FlowSet */

/**
 * @typedef {object} State  an item's `state.json` (`config/schemas/state.schema.json`)
 * @property {string} status
 * @property {string} run  `idle`, `active: <box>`, `waiting: <box>`, `gated: <to status>` or `gated before: <box>`
 * @property {Record<string, { value?: number, threshold?: number }>} [counters]
 * @property {string} [host]  with `active` only: the host that runs the box
 * @property {string} [next]  with `idle` only: the box where the next invocation starts
 * @property {{ box: string, outcome: string }} [held]  with `gated` only: the arrow that holds the transition
 * @property {{ box: string, profile: string, id: string }} [session]  with `active` only: the agent session of
 *   the box that runs (F-141 D8)
 */

/**
 * @typedef {object} Reset  a flow-change reset (D-46)
 * @property {State} state  the state after the reset
 * @property {{ event: 'reset', run: string, status: string, from_status?: string, note: string }} entry
 *   the `reset` log entry without its `at`
 */

/**
 * A stored run state's kind (`idle`, `active`, `waiting`, `gated` or
 * `gated before`) and its box or `to` status (`''` for `idle`).
 * @param {string} run
 */
function parseRun(run) {
  const at = run.indexOf(': ');
  return at === -1 ? { kind: run, arg: '' } : { kind: run.slice(0, at), arg: run.slice(at + 2) };
}

/**
 * The run state of the item `id` as `bl` reads it (D-3, D-4, D-50): the
 * stored run state, except that a stored `active: <box>` of this host whose
 * item lock no process holds reads `interrupted: <box>`. An `active` whose
 * `host` is another host reads as stored: only `bl` on that host can tell a
 * live invocation from a crashed one, so the caller names `state.host`. An
 * `active` with no `host` is this host's. A `gated` or `gated before` with no
 * lock holder reads as stored.
 * @param {{ backlogDir: string }} ctx
 * @param {string} id  the item's id in its printed form, `S-123`
 * @param {State} state  the item's stored state
 * @returns {string}
 */
export function readRunState(ctx, id, state) {
  const { kind, arg } = parseRun(state.run);
  if (kind !== 'active' || (state.host ?? hostname()) !== hostname()) return state.run;
  return holderOf(itemLockPath(ctx.backlogDir, id)) === null ? `interrupted: ${arg}` : state.run;
}

/**
 * The flow-change reset of an item of the type `type` (D-46), or `null` when
 * everything its stored state names exists in the type's flat flow: the
 * status; the node of `active`, `waiting` or `gated before`; the `to` status
 * of `gated`, the arrow that `held` names, and that arrow's `status`, which
 * must be `to`; the node of `next`. Otherwise the state becomes `idle` with
 * no `next`, `held` or `host`, the status stays or, when it is gone, becomes
 * the type's `initial`, and `counters` stay.
 * @param {FlowSet} flowSet
 * @param {string} type  an item type that has a flow
 * @param {State} state  the item's stored state
 * @returns {Reset|null}
 */
export function checkAgainstFlow(flowSet, type, state) {
  const flow = flowSet.flows[type];
  const hasStatus = (/** @type {string} */ status) => Object.hasOwn(flow.statuses, status);
  const hasNode = (/** @type {string} */ id) => Object.hasOwn(flow.nodes, id);
  /** @type {string[]} */
  const gone = [];
  if (!hasStatus(state.status)) gone.push(`the status '${state.status}'`);
  const { kind, arg } = parseRun(state.run);
  if (kind === 'gated') {
    if (!hasStatus(arg)) gone.push(`the status '${arg}'`);
    else if (state.held !== undefined) {
      const { box, outcome } = state.held;
      const arrows = hasNode(box) ? flow.nodes[box].arrows : {};
      const arrow = Object.hasOwn(arrows, outcome) ? arrows[/** @type {'success'|'failure'} */ (outcome)] : null;
      if (arrow == null) gone.push(`the ${outcome} arrow of the box '${box}'`);
      else if (arrow.status !== arg) gone.push(`the status '${arg}' on the ${outcome} arrow of the box '${box}'`);
    }
  } else if (kind !== 'idle' && !hasNode(arg)) gone.push(`the box '${arg}'`);
  if (state.next !== undefined && !hasNode(state.next)) gone.push(`the box '${state.next}'`);
  if (gone.length === 0) return null;

  const status = hasStatus(state.status) ? state.status : flow.initial;
  return {
    state: { status, run: 'idle', ...(state.counters === undefined ? {} : { counters: state.counters }) },
    entry: {
      event: 'reset',
      run: state.run,
      status,
      ...(status === state.status ? {} : { from_status: state.status }),
      note: `no longer in the ${type} flow: ${[...new Set(gone)].join(', ')}`,
    },
  };
}
