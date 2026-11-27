/**
 * runner.js — one flow invocation (F-139 D8): an item from a node of its flat
 * flow to `stop` or to a failing gate.
 *
 * `runFlow(ctx, { id, start, by, entry | resume, catalogue })` holds the item
 * lock for the whole invocation (D6) and applies the flow-change reset first
 * (D-46). Its first commit holds the `flow_start` and `active: <start>`. Then,
 * for each node:
 *
 *   1. the visit limit (D-115, Decision A6);
 *   2. the step gate with the entry gates of the subflows the flow enters
 *      (D-11, Decision A4); a failing entry ends the invocation at
 *      `gated before: <box>` (Decision P1);
 *   3. the step from the catalogue (D2), with `ctx.evaluate`; a note it
 *      gives is printed as `<box>: <note>` and goes first in the box's notes,
 *      so a `flow_end` at this box holds it (F-140 Decision A2);
 *   4. after `success`, the post-conditions: a failing entry makes the outcome
 *      `failure` (D-35);
 *   5. the arrow of the outcome, through any return nodes (D-26, D-43): a
 *      missing arrow commits an `outcome` entry and crashes; an arrow with a
 *      `status` makes the transition, unless the status is not in the arrow's
 *      derived `from` (the invocation stops) or the status gate fails (the
 *      invocation ends at `gated: <to>`, D-18, D-19);
 *   6. one commit for the box: the step's staged writes, the status and the
 *      run state that follows, `active: <next node>` with `host`, or at the end
 *      the end run state and a `flow_end`.
 *
 * So the stored run state names each step before the step starts, and a crash
 * leaves `active: <box>` of a box that has not finished; the item then reads
 * `interrupted: <box>` (D-50). A crash writes no `flow_end` (history.md, "Item
 * history"): the runner throws `FlowCrash`, and the command layer prints it.
 *
 * Gates and post-conditions read the committed record (`gates.js`), so they do
 * not see the staged writes of the box that runs.
 */

import { relative } from 'path';
import { hostname } from 'os';
import { release, tryLockOnce } from '../lib/kernel-lock.js';
import { ensureLockDir, itemLockPath } from '../lib/lock.js';
import { info } from '../lib/stderr.js';
import { readState } from '../store/item-json.js';
import { itemDir } from '../store/items.js';
import { record as readRecord } from '../store/record.js';
import { now, storeWrite } from '../store/write.js';
import { bindConditions, engineRecord } from './conditions.js';
import { STOP } from './flow-set.js';
import { postConditions, statusGate, stepGate } from './gates.js';
import { checkAgainstFlow } from './run-state.js';

/**
 * @typedef {import('./conditions.js').EngineContext} EngineContext
 * @typedef {import('./flow-set.js').Flow} Flow
 * @typedef {import('./gates.js').FailingEntry} FailingEntry
 * @typedef {import('../steps/index.js').Step} Step
 * @typedef {import('../store/items.js').Item} Item
 * @typedef {import('../store/write.js').Writer} Writer
 */

/**
 * @typedef {object} FlowResult  how the invocation ended, as its `flow_end` gives it
 * @property {string} ended  `stop`, `gated: <to status>` or `gated before: <box>`
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

/** The node id a return node `<subflow box>/_return_<outcome>` stands for: its subflow box. */
const subflowBox = (/** @type {string} */ id) => id.slice(0, id.lastIndexOf('/'));

/**
 * Run one flow invocation of the item `id` from the node `start` (D8), and
 * give how it ended. Throws `FlowCrash` on a crash, and an error without a
 * commit when another process holds the item lock, or with no commit but the
 * reset's when `start` is no box of the item's flow.
 * @param {EngineContext} ctx  a store context with the flow set (the op context is one)
 * @param {object} invocation
 * @param {string} invocation.id  the item's id
 * @param {string} invocation.start  the node id where the invocation starts
 * @param {string} invocation.by  who started it: `operator`, or the parent item (`flow_start`'s `by`)
 * @param {string} [invocation.entry]  the entry that started it
 * @param {boolean} [invocation.resume]  `bl resume` started it; then `entry` is absent
 * @param {Readonly<Record<string, Step>>} invocation.catalogue  the step catalogue (D2)
 * @returns {Promise<FlowResult>}
 */
export async function runFlow(ctx, { id, start, by, entry, resume = false, catalogue }) {
  const item = itemDir(ctx, id);
  if (item === null) throw new Error(`there is no item ${id} in the backlog`);
  const flow = ctx.flowSet.flows[item.type];
  if (flow === undefined) throw new Error(`${item.id}: the item type ${item.type} has no flow`);
  const path = itemLockPath(ctx.backlogDir, item.id);
  ensureLockDir(ctx.backlogDir);
  const lock = tryLockOnce(path, `the flow of ${item.id}`);
  if (!('taken' in lock)) {
    throw new Error(`${item.id}: another process (pid ${lock.holder}) runs its flow and holds ${path}`);
  }
  try {
    return await invoke(ctx, item, flow, { start, by, entry, resume, catalogue });
  } finally {
    release(lock.taken);
  }
}

/**
 * The invocation under the item lock (`runFlow`).
 * @param {EngineContext} ctx
 * @param {Item} item
 * @param {Flow} flow
 * @param {{ start: string, by: string, entry?: string, resume: boolean, catalogue: Readonly<Record<string, Step>> }} invocation
 * @returns {Promise<FlowResult>}
 */
async function invoke(ctx, item, flow, { start, by, entry, resume, catalogue }) {
  const { id, type } = item;
  const host = hostname();
  /**
   * One store write with the message `message` and the trailers of the flow
   * and, when given, of the box (history.md, "Commit trailers"); the store
   * write adds `Bl-Item`.
   * @param {string} message
   * @param {string|null} box
   * @param {(w: Writer) => void} fn
   */
  const flowCommit = async (message, box, fn) => {
    await storeWrite(
      ctx,
      { message, trailers: [`Bl-Flow: ${type}`, ...(box === null ? [] : [`Bl-Step: ${box}`])] },
      fn,
    );
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
  // A start that the flow does not have (a box that the reset just found gone,
  // or a return node, which runs no step) is refused before the flow_start.
  if (flow.nodes[start]?.kind !== 'step') throw new Error(`${id}: '${start}' is no box of the ${type} flow`);
  let status = /** @type {{ status: string }} */ (readState(ctx, item)).status;
  await flowCommit(resume ? `${id}: resumed at ${start}` : `${id}: ${entry} started`, start, (w) => {
    setState(w, status, `active: ${start}`, { host });
    w.log(id, { at: now(), event: 'flow_start', ...(resume ? { resume: true } : { entry }), status, by });
  });

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

  for (let box = start; ;) {
    try {
      const node = flow.nodes[box];
      const visit = (visits.get(box) ?? 0) + 1;
      visits.set(box, visit);
      if (visit > ctx.flowSet.maxBoxVisits) throw new FlowCrash(`${box} started ${visit} times (max_box_visits)`);

      const record = current();
      const gated = stepGate(ctx, record, node, previous);
      if (gated.length > 0) {
        const ended = `gated before: ${box}`;
        await flowCommit(`${id}: ${box} gated before`, box, (w) => {
          setState(w, status, ended);
          w.log(id, flowEnd(ended, last, `the step gate of ${box} failed: ${texts(gated)}`));
        });
        return { ended, status, ...(last === undefined ? {} : { outcome: last }) };
      }

      /** @type {Array<(w: Writer) => void>} */
      const staged = [];
      /** @type {ReturnType<typeof bindConditions>|undefined} */
      let conditions;
      const result = await catalogue[/** @type {string} */ (node.step)].run(
        {
          id,
          type,
          box,
          record,
          config: ctx.config,
          backlogDir: ctx.backlogDir,
          stage: (fn) => staged.push(/** @type {(w: Writer) => void} */ (fn)),
          recordCommit: ({ repo, sha }) => commits.push({ repo, sha }),
          // The call that the gates make (gates.js), so assert and the gates evaluate in one place.
          evaluate: (expr) => (conditions ??= bindConditions(ctx, id, { current: record })).evaluate(expr, record),
        },
        node.with,
      );
      // A step gives a bare outcome or { outcome, note } (F-140 Decision A2).
      let outcome = typeof result === 'string' ? result : result.outcome;
      /** @type {string[]} */
      const notes = [];
      if (typeof result !== 'string' && result.note !== undefined) {
        info(`${box}: ${result.note}`);
        notes.push(result.note);
      }
      if (outcome === 'success') {
        const failed = postConditions(ctx, current(), node);
        if (failed.length > 0) {
          outcome = 'failure';
          notes.push(`the post-conditions of ${box} failed: ${texts(failed)}`);
        }
      }

      // Follow the outcome's arrow, and through each return node the arrow of
      // the caller (D-43): a return node is never `active`.
      let from = box;
      let followed = outcome;
      /** @type {{ ended: string, held?: { box: string, outcome: string } } | null} */
      let end = null;
      /** @type {string} */
      let next = STOP;
      for (;;) {
        const arrow = flow.nodes[from].arrows[followed];
        if (arrow == null) {
          await flowCommit(`${id}: ${box} ${outcome}`, box, (w) => {
            setState(w, status, `active: ${box}`, { host }, staged);
            w.log(id, { at: now(), event: 'outcome', box, outcome, note: notes.join('; ') || undefined, by });
          });
          const file = relative(ctx.backlogDir, flow.nodes[from].source.file);
          throw new FlowCrash(`${from}: no arrow for the outcome ${followed} in ${file}`);
        }
        if (arrow.status !== undefined) {
          if (!arrow.from.includes(status)) {
            notes.push(`the ${followed} arrow of ${from} sets ${arrow.status} only from ${arrow.from.join(', ')}`);
            end = { ended: STOP };
            break;
          }
          const failing = statusGate(ctx, current(), arrow.status);
          if (failing.length > 0) {
            notes.push(`the status gate of ${arrow.status} failed: ${texts(failing)}`);
            end = { ended: `gated: ${arrow.status}`, held: { box: from, outcome: followed } };
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
      await flowCommit(`${id}: ${box} ${outcome}${note === undefined ? '' : `\n\n${note}`}`, box, (w) => {
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
      if (end !== null) return { ended: end.ended, status, outcome };
      // The arrow out of a return node is its caller's arrow, so the flow
      // comes from the subflow box, outside the subflow: an arrow back to the
      // subflow's first node enters it again (Decision A4).
      previous = flow.nodes[from].kind === 'return' ? subflowBox(from) : from;
      last = outcome;
      box = next;
    } catch (error) {
      if (error instanceof FlowCrash) throw error;
      throw new FlowCrash(`${box}: ${/** @type {Error} */ (error).message}`, { cause: error });
    }
  }
}
