/**
 * runner.js — one flow invocation (F-139 D8): an item from a node of its flat
 * flow to `stop` or to a failing gate.
 *
 * `runFlow(ctx, { id, by, entry | resume, catalogue })` holds the item
 * lock for the whole invocation (D6) and applies the flow-change reset first
 * (D-46). An entry starts at its `start` box, after the checks of D-48
 * (F-152 D6): the run state as `bl` reads it is `idle` or one of the entry's
 * `run_states`, never `active`; the status is in the entry's `from`; the
 * start box's step gate with its entry gates passes; and the status gate of
 * the status that the start box's `success` arrow sets passes. A check that
 * fails is a refusal that says why, with no commit but the reset's. An entry
 * on a `waiting`, `gated` or `interrupted` item drops its run state, `held`
 * and `next`, and its `flow_start` names the stored run state in `replaced`.
 * A resumed invocation takes no entry:
 * `wayOn` gives where it goes on from the stored run state and the last log
 * entry (F-152 D2), or that the item is still held, or the entries of an item
 * with nothing to continue; then `runFlow` gives that and commits nothing.
 * After each commit, `runFlow` gives `emit` each log entry and each usage
 * entry of the item that the commit wrote, with `item_id` (D-462).
 * Its first commit holds the `flow_start` and `active: <start>`; a
 * resumed invocation keeps there the agent `session` of its start box (F-141
 * D8). A resumed start with an outcome (a logged outcome, or a held
 * transition) runs no step there: the `flow_start` goes in the commit of that
 * outcome's arrow, and the node is never `active`. Then, for each node:
 *
 *   1. the visit limit (D-115, Decision A6);
 *   2. the step gate with the entry gates of the subflows the flow enters
 *      (D-11, Decision A4); a failing entry ends the invocation at
 *      `gated before: <box>`, and the process suspends. The gate and the step
 *      see one `with`: the node's, with the invocation's overrides that apply
 *      to it (`applyOverrides`, F-152 D4), so in an `agent` box
 *      `has_capacity()` reads the list that the step runs (`agentList`);
 *      a box whose step `waits` (`wait`) runs no step: the invocation ends at
 *      `waiting: <box>`, and the process suspends until an `outcome` entry for
 *      the box is the last log entry (D-32, F-152 D5);
 *   3. an interactive step with no terminal does not start: the invocation
 *      ends `idle` with that box `next` (D-29, F-141 D9);
 *   4. the step from the catalogue (D2), with that `with`, and with
 *      `ctx.evaluate`, `ctx.from`,
 *      `ctx.repos` and `ctx.snapshot`, the item's repo contexts and their state
 *      before the step (F-141 D6), and `ctx.session`, which commits the agent
 *      session id at once (F-141 D8); a note it
 *      gives is printed as `<box>: <note>` and goes first in the box's notes,
 *      so a `flow_end` at this box holds it (F-140 Decision A2);
 *   5. when the item's last log entry is an `outcome` for the box that
 *      `bl outcome` wrote while the step ran, that outcome wins over the
 *      step's, with no post-conditions (D-9); the box's commit then logs a
 *      `flow_start` with `resume` after it, as a resume that follows a logged
 *      outcome does (F-152 D2), so the run state may leave the box (D-612).
 *      Else, after `success`, the post-conditions: a failing entry makes the
 *      outcome `failure` (D-35);
 *   6. the arrow of the outcome, through any return nodes (D-26, D-43): a
 *      missing arrow commits an `outcome` entry and crashes; an arrow with a
 *      `status` makes the transition, unless the status is not in the arrow's
 *      derived `from` (the invocation stops) or the status gate fails (the
 *      invocation ends at `gated: <to>`, D-18, D-19, and the process suspends);
 *   7. one commit for the box: the step's staged writes, the status and the
 *      run state that follows, `active: <next node>` with `host`, or at the end
 *      the end run state and a `flow_end`. It holds no `session`, so a session
 *      id lasts only while its box runs.
 *
 * So the stored run state names each step before the step starts, and a crash
 * leaves `active: <box>` of a box that has not finished; the item then reads
 * `interrupted: <box>` (D-50). A crash writes no `flow_end` (history.md, "Item
 * history"): the runner throws `FlowCrash`, and the command layer prints it.
 *
 * **Suspend and wake (F-152 D3, Decision A1).** An invocation that ends at a
 * gate or a wait box has committed its gated or waiting run state and its
 * `flow_end`. With a `wake` option, `runFlow` then keeps the item lock and
 * suspends: it prints `<id>: suspended at <run state>: <failing entries>`
 * (at a wait box, the `bl outcome` that ends the wait), waits for `wake`
 * (`waitForWake`), and runs a new invocation with `resume: true` and the
 * first `by`. The wake checks the item once after its watchers start
 * (`open`), so a change before them wakes the process at once. That
 * invocation goes on where `wayOn` says, or finds the item
 * still held, commits nothing, and suspends again; the line is printed again
 * only when it changed. When the stored run state is no longer the one the
 * process suspended at (a `bl force`), the process prints so and returns.
 * Without `wake`, `runFlow` returns at the first suspend. While it holds the
 * item lock, `runFlow` keeps a SIGUSR2 listener that does nothing, so the
 * signal of `bl resume` (D-22) does not end a running step.
 *
 * After the commit of a gated end the runner sends the `gated` alert, after
 * a `flow_end` at `stop` the `ended.normal` alert, and before it throws
 * `FlowCrash` the `ended.crash` alert (F-140 D10, Decision A3). An alert that
 * fails prints one line and changes neither the result nor the crash.
 *
 * Gates and post-conditions read the committed record (`gates.js`), so they do
 * not see the staged writes of the box that runs.
 */

import { relative } from 'path';
import { hostname } from 'os';
import { ConfigurationFaults } from '../config/check.js';
import { release, tryLockOnce } from '../lib/kernel-lock.js';
import { ensureLockDir, itemLockPath } from '../lib/lock.js';
import { info } from '../lib/stderr.js';
import { agentList } from '../steps/capacity.js';
import { sendAlert } from '../steps/notify.js';
import { repoContexts as itemRepoContexts, snapshot as takeSnapshot } from '../steps/worktrees.js';
import { readState } from '../store/item-json.js';
import { existingItem } from '../store/items.js';
import { LOG, readJsonl } from '../store/jsonl.js';
import { record as readRecord } from '../store/record.js';
import { now, storeWrite } from '../store/write.js';
import { bindConditions, engineRecord, hasTerminal } from './conditions.js';
import { outcomeFor, wayOn } from './continuation.js';
import { OUTCOMES, STOP } from './flow-set.js';
import { postConditions, statusGate, stepGate } from './gates.js';
import { applyOverrides, overrideFaults } from './overrides.js';
import { checkAgainstFlow, lockedRunState, parseRun } from './run-state.js';

/**
 * @typedef {import('./conditions.js').EngineContext} EngineContext
 * @typedef {import('./flow-set.js').Flow} Flow
 * @typedef {import('./gates.js').FailingEntry} FailingEntry
 * @typedef {import('../steps/index.js').Step} Step
 * @typedef {import('../steps/index.js').StepContext} StepContext
 * @typedef {import('../store/items.js').Item} Item
 * @typedef {import('../store/write.js').Writer} Writer
 */

/**
 * @typedef {object} FlowResult  how the invocation ended, as its `flow_end` gives it
 * @property {string} ended  `stop`, `gated: <to status>`, `gated before: <box>` or `waiting: <box>`
 * @property {string} status  the status at the end
 * @property {string} [outcome]  the outcome of the last step; absent when no step ran
 */

/**
 * A crash of a flow invocation: a step that threw, a gate or post-condition
 * whose evaluation threw, an outcome with no arrow, or the visit limit. The
 * invocation wrote no `flow_end`, and the stored run state is `active: <box>`.
 */
export class FlowCrash extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'FlowCrash';
  }
}

/** The texts of failing gate entries, as one note. */
const texts = (/** @type {FailingEntry[]} */ failing) => failing.map(({ text }) => text).join(', ');

/** The class of a failing entry, or undefined for a plain or a dependency entry. */
const classOf = (/** @type {FailingEntry} */ { entry }) =>
  typeof entry === 'object' && 'class' in entry ? entry.class : undefined;

/**
 * The `gated` alert of the failing entries `failing` (F-140 D10, D-97): its
 * reasons are their classes, so an entry with no class routes by `gated`, and
 * its `condition` and `class` are the first entry's. `box` is the gated box of
 * a step gate, and absent for a status gate.
 * @param {StepContext} step
 * @param {FailingEntry[]} failing
 * @param {string} [box]
 */
async function gatedAlert(step, failing, box) {
  await sendAlert(step, 'gated', failing.map(classOf), {
    ...(box === undefined ? {} : { box }),
    condition: failing[0].text,
    class: classOf(failing[0]) ?? '',
  });
}

/**
 * Send an alert with `send`. An alert that fails (a missing text, a template
 * that does not render) prints one line that names it, and changes nothing
 * else: the end it is about is committed, and a crash is still thrown.
 * @param {string} id
 * @param {string} name  the alert, for example `ended.crash`
 * @param {() => Promise<void>} send
 */
async function alertOrReport(id, name, send) {
  try {
    await send();
  } catch (error) {
    info(`${id}: the ${name} alert failed: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * One store write of an item of the type `type` with the message `message`
 * and the trailers of the flow and, when given, of the box (history.md,
 * "Commit trailers"); the store write adds `Bl-Item`. The runner and
 * `bl outcome` commit through it.
 * @template T
 * @param {import('../store/items.js').StoreContext} ctx
 * @param {string} type  the item's type, which names its flow
 * @param {string} message
 * @param {string|null} box
 * @param {(w: Writer) => T} fn
 * @returns {Promise<T>}
 */
export async function flowWrite(ctx, type, message, box, fn) {
  return await storeWrite(
    ctx,
    { message, trailers: [`Bl-Flow: ${type}`, ...(box === null ? [] : [`Bl-Step: ${box}`])] },
    fn,
  );
}

/** The node id a return node `<subflow box>/_return_<outcome>` stands for: its subflow box. */
const subflowBox = (/** @type {string} */ id) => id.slice(0, id.lastIndexOf('/'));

/**
 * Run one flow invocation of the item `id` (D8): from the start box of the
 * entry `entry`, or from where `wayOn` says for a resume (F-152 D2); with
 * `wake`, the invocations after each suspend too (F-152 D3). Give how the last one
 * ended, or, for a resume with nothing to run, the failing entries that still
 * hold the item (`held`) or the entries its status allows (`entries`), with no
 * commit but the reset's. Throws `FlowCrash` on a crash, and an error without a
 * commit when another process holds the item lock, when the item's flow has
 * no entry `entry`, or when the item is `active` on another host, or with no
 * commit but the reset's when a check of D-48 refuses the entry (F-152 D6).
 * @param {EngineContext} ctx  a store context with the flow set (the op context is one)
 * @param {object} invocation
 * @param {string} invocation.id  the item's id
 * @param {string} invocation.by  who started it: `operator`, or the parent item (`flow_start`'s `by`)
 * @param {string} [invocation.entry]  the entry that starts it, an entry of the item's flow
 * @param {boolean} [invocation.resume]  `bl resume` started it; then `entry` is absent
 * @param {Readonly<Record<string, Step>>} invocation.catalogue  the step catalogue (D2)
 * @param {typeof itemRepoContexts} [invocation.repoContexts]  gives the item's repo contexts
 *   before each step; `steps/worktrees.js` by default, a test seam (F-141 D6)
 * @param {readonly import('./overrides.js').Override[]} [invocation.overrides]  the entry options
 *   with `sets`: each replaces one key of `with` in the boxes it applies to (`applyOverrides`,
 *   F-152 D4)
 * @param {string} [invocation.tty]  the terminal an interactive step needs (`hasTerminal`), a
 *   test seam (F-141 D9)
 * @param {Wake} [invocation.wake]  gives the next wake of a suspended process (`waitForWake`);
 *   absent, `runFlow` returns at the first suspend
 * @param {Emit} [invocation.emit]  takes each log entry and usage entry of the item that a
 *   commit wrote, with `item_id`, after the commit (D-462)
 * @returns {Promise<FlowResult | { held: FailingEntry[] } | { entries: string[] }>}
 * @throws {ConfigurationFaults} before any commit, when an override makes a box's `with` fail
 *   its step's `with` schema, or names a profile that is not defined or has a fault
 *   (`overrideFaults`)
 */
export async function runFlow(
  ctx,
  {
    id,
    by,
    entry,
    resume = false,
    catalogue,
    repoContexts = itemRepoContexts,
    overrides = [],
    tty,
    wake,
    emit = () => {},
  },
) {
  const item = existingItem(ctx, id);
  const flow = ctx.flowSet.flows[item.type];
  if (flow === undefined) throw new Error(`${item.id}: the item type ${item.type} has no flow`);
  if (!resume && !Object.hasOwn(flow.entries, /** @type {string} */ (entry))) {
    throw new Error(`${item.id}: the ${item.type} flow has no entry '${entry}'`);
  }
  const faults = overrideFaults(ctx.config, flow, catalogue, overrides);
  if (faults.length > 0) throw new ConfigurationFaults(faults, ctx.backlogDir);
  const path = itemLockPath(ctx.backlogDir, item.id);
  ensureLockDir(ctx.backlogDir);
  // Node ends a process on SIGUSR2 by default. `bl resume` sends it to the lock holder (D-22): it
  // wakes a suspend (`wake`), and must not end a running step. The listener comes before the
  // lock, so a signal at the instant the lock is taken does not end the process either.
  const nothing = () => {};
  process.on('SIGUSR2', nothing);
  const lock = tryLockOnce(path, `the flow of ${item.id}`);
  if (!('taken' in lock)) {
    process.off('SIGUSR2', nothing);
    throw new Error(`${item.id}: another process (pid ${lock.holder}) runs its flow and holds ${path}`);
  }
  try {
    const invocation = { by, catalogue, repoContexts, overrides, tty, emit };
    let { result, suspend } = await invoke(ctx, item, flow, { ...invocation, entry, resume });
    if (wake === undefined) return result;
    let shown = '';
    while (suspend !== undefined) {
      const { run, failing } = suspend;
      // The failing entries are printed again only when they changed (D3). A wait box has none.
      const why = failing.length > 0 ? texts(failing) : `waiting for bl outcome ${item.id} ${OUTCOMES.join('|')}`;
      const report = `${item.id}: suspended at ${run}: ${why}`;
      if (report !== shown) info(report);
      shown = report;
      // Whether the item can go on now. The wake checks it after its watchers start, so an
      // outcome, a commit or a signal before them is not lost (D3).
      const open = async () => {
        const stored = /** @type {import('./run-state.js').State} */ (readState(ctx, item));
        if (stored.run !== run) return true;
        try {
          return !('held' in (await wayNow(ctx, item, stored, invocation)));
        } catch {
          // The error shows again in the invocation that the wake starts.
          return true;
        }
      };
      await wake(ctx, { ...suspend, open });
      const now = /** @type {import('./run-state.js').State} */ (readState(ctx, item)).run;
      if (now !== run) {
        // Another command (`bl force`) changed the run state that this process wrote.
        info(`${item.id}: the run state changed to ${now}; this process ends`);
        return result;
      }
      // A new invocation (Decision A1): it commits nothing while the item is still held.
      ({ result, suspend } = await invoke(ctx, item, flow, { ...invocation, resume: true }));
    }
    return result;
  } finally {
    process.off('SIGUSR2', nothing);
    release(lock.taken);
  }
}

/**
 * @typedef {object} Suspend  why an invocation suspends
 * @property {string} run  the stored run state it suspends at
 * @property {FailingEntry[]} failing  the failing entries that hold it
 * @property {string[]} [agents]  the `agents` list that a held box's step gate checked
 */
/**
 * @typedef {(ctx: EngineContext, suspend: Suspend & { open: () => Promise<boolean> }) => Promise<unknown>} Wake
 *   `open` gives whether the item can go on now: its run state changed, or `wayOn` no longer
 *   finds it held
 */

/**
 * `wayOn` of the item from its state `stored` and its last log entry (F-152 D2).
 * @param {EngineContext} ctx
 * @param {Item} item
 * @param {import('./run-state.js').State} stored
 * @param {{ repoContexts: typeof itemRepoContexts, overrides: readonly import('./overrides.js').Override[],
 *   catalogue: Readonly<Record<string, Step>> }} invocation
 */
const wayNow = async (ctx, item, stored, { repoContexts, overrides, catalogue }) =>
  await wayOn(ctx, item, stored, readJsonl(ctx, item, LOG).at(-1), {
    repos: repoContexts({ ...ctx, id: item.id }),
    overrides,
    catalogue,
  });
/** @typedef {(record: Record<string, unknown>) => void} Emit */

/**
 * Why the entry `name` must not start on the item (D-48, F-152 D6), or
 * undefined when it may. The caller holds the item lock, so the run state is
 * read as `lockedRunState` gives it; `gated before` counts as `gated`. Gates
 * are evaluated, never written: the start box's step gate with its entry
 * gates, as at an invocation's first node (`previous` is `null`, F-139
 * Decision A4), and the status gate of the status that the start box's
 * `success` arrow sets.
 * @param {EngineContext} ctx
 * @param {Item} item
 * @param {Flow} flow
 * @param {string} name  an entry of `flow`
 * @param {import('./run-state.js').State} stored  the item's state, after the flow-change reset
 * @param {{ repos: import('./gates.js').Worktrees['repos'], agents?: readonly string[] }} options  the
 *   item's repo contexts, and the `agents` list that the start box's step runs (`agentList`)
 * @returns {Promise<string|undefined>}
 */
async function entryRefusal(ctx, item, flow, name, stored, options) {
  const { from, start, run_states: runStates = [] } = flow.entries[name];
  const run = lockedRunState(stored);
  const { kind } = parseRun(run);
  // `idle` is always accepted, and `run_states` may name it too (flows.schema.json).
  const accepted = [...new Set(['idle', ...runStates])];
  if (!accepted.includes(kind === 'gated before' ? 'gated' : kind)) {
    return `the run state is ${run}; it starts only from ${accepted.join(', ')}`;
  }
  if (!from.includes(stored.status)) return `the status is ${stored.status}; it starts only from ${from.join(', ')}`;
  const record = engineRecord(ctx, ctx.flowSet, readRecord(ctx, item.id));
  const node = flow.nodes[start];
  const gated = await stepGate(ctx, record, node, null, options);
  if (gated.length > 0) return `the step gate of ${start} fails: ${texts(gated)}`;
  const to = node.arrows.success?.status;
  const failing = to === undefined ? [] : await statusGate(ctx, record, to);
  if (failing.length === 0) return undefined;
  return `the status gate of ${to}, which the success arrow of ${start} sets, fails: ${texts(failing)}`;
}

/**
 * The invocation under the item lock (`runFlow`): its result, and why it
 * suspends when it ends at a gate or finds the item still held.
 * @param {EngineContext} ctx
 * @param {Item} item
 * @param {Flow} flow
 * @param {{ by: string, entry?: string, resume: boolean, catalogue: Readonly<Record<string, Step>>,
 *   repoContexts: typeof itemRepoContexts, overrides: readonly import('./overrides.js').Override[],
 *   tty?: string, emit: Emit }} invocation
 * @returns {Promise<{ result: FlowResult | { held: FailingEntry[] } | { entries: string[] }, suspend?: Suspend }>}
 */
async function invoke(ctx, item, flow, { by, entry, resume, catalogue, repoContexts, overrides, tty, emit }) {
  const { id, type } = item;
  const host = hostname();
  /** The `with` of `node` that its step gate and its step see (F-152 D4). */
  const argsOf = (/** @type {import('./flow-set.js').Node} */ node) => applyOverrides(node, overrides, catalogue);
  /**
   * `flowWrite` of this item's flow; then each log entry and usage entry of
   * the item that it wrote, as the file holds it, goes to `emit` with
   * `item_id` (D-462).
   * @param {string} message
   * @param {string|null} box
   * @param {(w: Writer) => void} fn
   */
  const flowCommit = async (message, box, fn) => {
    /** @type {Record<string, unknown>[]} */
    const written = [];
    /** @param {'log'|'usage'} file */
    const kept = (w, file) => (/** @type {string} */ other, /** @type {Record<string, unknown>} */ entry) => {
      if (other === id) written.push(entry);
      w[file](other, entry);
    };
    await flowWrite(ctx, type, message, box, (w) => fn({ ...w, log: kept(w, 'log'), usage: kept(w, 'usage') }));
    // The JSON round trip drops the fields that are undefined, as the file does.
    for (const entry of written) emit({ item_id: id, ...JSON.parse(JSON.stringify(entry)) });
  };
  /**
   * Stage the step's writes `staged`, then `state.json` with `status`, `run`
   * and `extra` (`host` or `held`), and the counters. The runner owns the
   * status and the run state, so a step's `w.state` of the item gives only its
   * counters, and one without `counters` keeps the counters before it; with
   * none, the counters are the ones the last commit left. The step's writes
   * come first, so the runner's log entry is the last one.
   * @param {Writer} w
   * @param {string} status
   * @param {string} run
   * @param {Record<string, unknown>} [extra]
   * @param {Array<(w: Writer) => void>} [staged]
   */
  const setState = (w, status, run, extra = {}, staged = []) => {
    let { counters } = /** @type {import('./run-state.js').State} */ (readState(ctx, item));
    /** @type {Writer} */
    const step = {
      ...w,
      state: (other, value) => {
        if (other !== id) w.state(other, value);
        else counters = /** @type {import('./run-state.js').State} */ (value).counters ?? counters;
      },
    };
    for (const fn of staged) fn(step);
    w.state(id, { status, run, ...extra, ...(counters === undefined ? {} : { counters }) });
  };
  /**
   * The item's committed record, as conditions read it, with the status the
   * invocation has reached: a status gate after a return node sees the status
   * that the arrow into the return node set.
   */
  const current = () => engineRecord(ctx, ctx.flowSet, { ...readRecord(ctx, id), status });

  const reset = checkAgainstFlow(ctx.flowSet, type, /** @type {any} */ (readState(ctx, item)));
  if (reset !== null) {
    await flowCommit(`${id}: reset to the ${type} flow`, null, (w) => {
      w.state(id, reset.state);
      w.log(id, { at: now(), ...reset.entry });
    });
    info(`${id}: reset: ${reset.entry.note}`);
  }
  const stored = /** @type {import('./run-state.js').State} */ (readState(ctx, item));
  /** @type {string|undefined} the outcome a resumed start follows with no step (F-152 D2) */
  let given;
  /** @type {string} */
  let start;
  if (resume) {
    const way = await wayNow(ctx, item, stored, { repoContexts, overrides, catalogue });
    if ('held' in way) {
      // Still held: the process suspends at the stored run state, with no commit (F-152 D3).
      const { kind, arg } = parseRun(stored.run);
      const node = flow.nodes[arg];
      const agents = kind === 'gated before' ? agentList(node, argsOf(node)) : undefined;
      return { result: way, suspend: { run: stored.run, failing: way.held, agents } };
    }
    if ('entries' in way) return { result: way };
    ({ start, outcome: given } = way);
  } else {
    const name = /** @type {string} */ (entry);
    // The load checks that an entry's start names a box of its flow (`derive.js`).
    start = flow.entries[name].start;
    const node = flow.nodes[start];
    const why = await entryRefusal(ctx, item, flow, name, stored, {
      repos: repoContexts({ ...ctx, id }),
      agents: agentList(node, argsOf(node)),
    });
    if (why !== undefined) throw new Error(`${id}: the entry ${name} is refused: ${why}`);
  }
  let { status } = stored;
  // An entry on a waiting, gated or interrupted item drops that run state (D-48, history.md D-617).
  const replaced = resume || stored.run === 'idle' ? {} : { replaced: stored.run };
  const flowStart = {
    at: now(),
    event: 'flow_start',
    ...(resume ? { resume: true } : { entry }),
    status,
    ...replaced,
    by,
  };
  /**
   * Log the `flow_start` in the commit of the start's outcome: a start with an
   * outcome runs no step, so it has no commit of its own (`given`).
   * @type {((w: Writer) => void) | null}
   */
  let logStart = null;
  if (given === undefined) {
    // A resumed invocation at the box of a kept session keeps it, so the step continues it (F-141 D8).
    const kept = resume && stored.session?.box === start ? { session: stored.session } : {};
    await flowCommit(resume ? `${id}: resumed at ${start}` : `${id}: ${entry} started`, start, (w) => {
      setState(w, status, `active: ${start}`, { host, ...kept });
      w.log(id, flowStart);
    });
  } else logStart = (w) => w.log(id, flowStart);

  /** @type {Array<{ repo: string, sha: string }>} */
  const commits = [];
  /** @type {Map<string, number>} */
  const visits = new Map();
  /** @type {string|null} */
  let previous = null;
  /** @type {string|undefined} */
  let last;
  /**
   * A `flow_end` entry; JSON drops the fields that are undefined.
   * @param {string} ended
   * @param {string|undefined} outcome
   * @param {string|undefined} note
   */
  const flowEnd = (ended, outcome, note) => ({ at: now(), event: 'flow_end', ended, outcome, status, commits, note });
  /**
   * The result of an invocation that ends `ended` before the step of its box
   * runs: the outcome is the last step's, absent when no step ran.
   * @param {string} ended
   * @returns {FlowResult}
   */
  const endedBefore = (ended) => ({ ended, status, ...(last === undefined ? {} : { outcome: last }) });

  /**
   * The step context of `box` over `record`, with its staged writes in `staged`,
   * and the item's repo contexts `repos` and their `snapshot` before the step.
   * @param {string} box
   * @param {import('./conditions.js').ItemRecord} record
   * @param {Array<(w: Writer) => void>} staged
   * @param {StepContext['repos']} repos
   * @param {StepContext['snapshot']} snapshot
   * @returns {StepContext}
   */
  const stepContext = (box, record, staged, repos, snapshot) => {
    /** @type {ReturnType<typeof bindConditions>|undefined} */
    let conditions;
    return {
      id,
      type,
      box,
      // The box the flow came from, which a notify text names (F-140 D9).
      ...(previous === null ? {} : { from: previous }),
      record,
      repos,
      snapshot,
      config: ctx.config,
      backlogDir: ctx.backlogDir,
      bl: ctx.bl,
      stage: (fn) => staged.push(/** @type {(w: Writer) => void} */ (fn)),
      // Its own commit, so a crash after it leaves the id in the stored state (F-141 D8).
      // `null`: the session did not launch, so no id stays to resume.
      session: async ({ profile, id: session }) =>
        flowCommit(`${id}: ${box} session ${session ?? `of ${profile} did not launch`}`, box, (w) =>
          setState(w, status, `active: ${box}`, {
            host,
            ...(session === null ? {} : { session: { box, profile, id: session } }),
          }),
        ),
      recordCommit: ({ repo, sha }) => commits.push({ repo, sha }),
      // The call that the gates make (gates.js), so assert and the gates evaluate in one place.
      evaluate: async (expr) =>
        (conditions ??= bindConditions(ctx, id, { current: record, repos })).evaluate(expr, record),
    };
  };

  for (let box = start; ;) {
    /** @type {StepContext|undefined} */
    let step;
    try {
      const node = flow.nodes[box];
      /** @type {Array<(w: Writer) => void>} */
      const staged = [];
      const record = current();
      const repos = repoContexts({ ...ctx, id });
      const before = takeSnapshot(repos);
      step = stepContext(box, record, staged, repos, before);
      /** @type {string} */
      let outcome;
      /** @type {string[]} */
      const notes = [];
      /** @type {string|undefined} */
      let stepNote;
      if (given !== undefined) {
        // A resumed start with an outcome: no step gate, no step, no post-conditions (F-152 D2).
        outcome = given;
        given = undefined;
      } else {
        const visit = (visits.get(box) ?? 0) + 1;
        visits.set(box, visit);
        if (visit > ctx.flowSet.maxBoxVisits) throw new FlowCrash(`${box} started ${visit} times (max_box_visits)`);

        const withArgs = argsOf(node);
        const agents = agentList(node, withArgs);
        const gated = await stepGate(ctx, record, node, previous, { repos, agents });
        if (gated.length > 0) {
          const ended = `gated before: ${box}`;
          await flowCommit(`${id}: ${box} gated before`, box, (w) => {
            setState(w, status, ended);
            w.log(id, flowEnd(ended, last, `the step gate of ${box} failed: ${texts(gated)}`));
          });
          // A gated end suspends, so it sends no ended alert (F-140 Decision A3).
          await alertOrReport(id, 'gated', async () => gatedAlert(step, gated, box));
          return { result: endedBefore(ended), suspend: { run: ended, failing: gated, agents } };
        }

        const code = catalogue[/** @type {string} */ (node.step)];
        if (code.waits) {
          // A wait box runs no step: the process suspends until an outcome entry for the box (D-32, F-152 D5).
          const ended = `waiting: ${box}`;
          await flowCommit(`${id}: ${box} waiting`, box, (w) => {
            setState(w, status, ended);
            w.log(id, flowEnd(ended, last, undefined));
          });
          return { result: endedBefore(ended), suspend: { run: ended, failing: [] } };
        }
        if (code.interactive?.(withArgs) && !hasTerminal(tty)) {
          // The step needs the operator, so it does not start (D-29): a later `bl resume` runs it.
          const note = `no terminal for the interactive step ${box}`;
          await flowCommit(`${id}: ${box} no terminal`, box, (w) => {
            setState(w, status, 'idle', { next: box });
            w.log(id, flowEnd(STOP, last, note));
          });
          info(`${box}: ${note}`);
          info(`run \`bl resume ${id}\` to continue`);
          await alertOrReport(id, 'ended.normal', async () => sendAlert(step, 'ended', ['normal'], { box }));
          return { result: endedBefore(STOP) };
        }
        const result = await /** @type {NonNullable<Step['run']>} */ (code.run)(step, withArgs);
        // A step gives a bare outcome or { outcome, note } (F-140 Decision A2).
        outcome = typeof result === 'string' ? result : result.outcome;
        stepNote = typeof result === 'string' ? undefined : result.note;
        if (stepNote !== undefined) notes.push(stepNote);
        // An outcome that `bl outcome` logged for the box while the step ran wins (D-9).
        const logged = outcomeFor(readJsonl(ctx, item, LOG).at(-1), box);
        if (logged !== undefined) {
          outcome = logged;
          // The commit of its arrow logs a flow_start after it, as a resume that follows a logged
          // outcome does, so the outcome is no longer the newest state entry (D-612).
          const resumed = { at: now(), event: 'flow_start', resume: true, status, by };
          logStart = (w) => w.log(id, resumed);
        } else if (outcome === 'success') {
          const failed = await postConditions(ctx, current(), node, { repos, snapshot: before });
          if (failed.length > 0) {
            outcome = 'failure';
            notes.push(`the post-conditions of ${box} failed: ${texts(failed)}`);
          }
        }
      }
      // The note is printed once the box's writes are committed, so a failed write prints none.
      const printNote = () => stepNote !== undefined && info(`${box}: ${stepNote}`);
      /**
       * The box's one commit: its `flow_start` first when it has no commit of its own (`logStart`).
       * @param {string} message
       * @param {(w: Writer) => void} fn
       */
      const boxCommit = async (message, fn) => {
        await flowCommit(message, box, (w) => {
          logStart?.(w);
          fn(w);
        });
        logStart = null;
      };

      // Follow the outcome's arrow, and through each return node the arrow of
      // the caller (D-43): a return node is never `active`.
      let from = box;
      let followed = outcome;
      /** @type {{ ended: string, held?: { box: string, outcome: string }, gated?: FailingEntry[] } | null} */
      let end = null;
      /** @type {string} */
      let next = STOP;
      for (;;) {
        const arrow = flow.nodes[from].arrows[followed];
        if (arrow == null) {
          await boxCommit(`${id}: ${box} ${outcome}`, (w) => {
            setState(w, status, `active: ${box}`, { host }, staged);
            w.log(id, { at: now(), event: 'outcome', box, outcome, note: notes.join('; ') || undefined, by });
          });
          printNote();
          const file = relative(ctx.backlogDir, flow.nodes[from].source.file);
          throw new FlowCrash(`${from}: no arrow for the outcome ${followed} in ${file}`);
        }
        if (arrow.status !== undefined) {
          if (!arrow.from.includes(status)) {
            notes.push(`the ${followed} arrow of ${from} sets ${arrow.status} only from ${arrow.from.join(', ')}`);
            end = { ended: STOP };
            break;
          }
          const failing = await statusGate(ctx, current(), arrow.status);
          if (failing.length > 0) {
            notes.push(`the status gate of ${arrow.status} failed: ${texts(failing)}`);
            end = { ended: `gated: ${arrow.status}`, held: { box: from, outcome: followed }, gated: failing };
            break;
          }
          status = arrow.status;
        }
        if (arrow.next === STOP) {
          end = { ended: STOP };
          break;
        }
        const target = flow.nodes[arrow.next];
        if (target.kind !== 'return') {
          next = arrow.next;
          break;
        }
        from = arrow.next;
        followed = target.outcomes[0];
      }

      const note = notes.join('; ') || undefined;
      await boxCommit(`${id}: ${box} ${outcome}${note === undefined ? '' : `\n\n${note}`}`, (w) => {
        if (end === null) setState(w, status, `active: ${next}`, { host }, staged);
        else {
          setState(
            w,
            status,
            end.ended === STOP ? 'idle' : end.ended,
            end.held === undefined ? {} : { held: end.held },
            staged,
          );
          w.log(id, flowEnd(end.ended, outcome, note));
        }
      });
      printNote();
      if (end !== null) {
        // A status gate has no box (D-97); a stop is the normal end (F-140 Decision A3).
        const { ended, gated } = end;
        const result = { ended, status, outcome };
        if (gated === undefined) {
          await alertOrReport(id, 'ended.normal', async () => sendAlert(step, 'ended', ['normal'], { box }));
          return { result };
        }
        await alertOrReport(id, 'gated', async () => gatedAlert(step, gated));
        return { result, suspend: { run: ended, failing: gated } };
      }
      // The arrow out of a return node is its caller's arrow, so the flow
      // comes from the subflow box, outside the subflow: an arrow back to the
      // subflow's first node enters it again (Decision A4).
      previous = flow.nodes[from].kind === 'return' ? subflowBox(from) : from;
      last = outcome;
      box = next;
    } catch (error) {
      // Every crash is made here once and sends one ended.crash alert (F-140 D10).
      const crash =
        error instanceof FlowCrash
          ? error
          : new FlowCrash(`${box}: ${/** @type {Error} */ (error).message}`, { cause: error });
      // An alert that cannot be sent does not hide the crash it is about.
      await alertOrReport(id, 'ended.crash', async () =>
        sendAlert(step ?? stepContext(box, current(), [], [], []), 'ended', ['crash'], { box, error: crash.message }),
      );
      throw crash;
    }
  }
}
