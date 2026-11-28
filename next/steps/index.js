/**
 * steps/index.js — the step catalogue (F-139 D2).
 *
 * A code step is a step in `bl`'s code that a flow box runs, by name or with
 * `use:` (architecture.md, "Step"; flow-config.md, "Boxes"). The flow engine
 * runs it and follows the arrow of the outcome it returns. F-140 and later
 * each add one line here. `buildFlowSet` and the runner take the catalogue as
 * an argument, so tests pass fake steps.
 *
 * A step gives a bare outcome, or `{ outcome, note }` (F-140 Decision A2):
 * the runner prints `<box path>: <note>` on stderr, and puts the note in the
 * `flow_end` `note` when the outcome ends the invocation.
 */

import { agent } from './agent.js';
import { assertStep, succeed } from './simple.js';
import { increment } from './increment.js';
import { notify } from './notify.js';
import { rank } from './rank.js';
import { wait } from './wait.js';

/** @typedef {'success'|'failure'} Outcome */

/** @typedef {Outcome | { outcome: Outcome, note?: string }} StepResult  what a step's `run` gives */

/**
 * @typedef {object} StepContext
 * @property {string} id  the item's id
 * @property {string} type  the item's type
 * @property {string} box  the box path, for example `deliver/self_check/test_unit`
 * @property {string} [from]  the path of the previous node of the invocation,
 *   the box the flow came from; absent at its first node (F-140 D9)
 * @property {Record<string, unknown>} record  the item's record when the step starts
 * @property {import('./worktrees.js').RepoContext[]} repos  the item's repo contexts
 *   (`repoContexts`, F-141 D6); `[]` until F-143's `prepare` records worktrees
 * @property {import('./worktrees.js').RepoSnapshot[]} snapshot  each repo's `HEAD`
 *   status and uncommitted content when the step starts (`snapshot`)
 * @property {import('../config/load.js').Configuration} config  the frozen configuration
 * @property {string} backlogDir  the backlog's root
 * @property {(line: string) => Promise<string>} [bl]  runs a `{{#bl}}` command
 *   line in process (`blIn` of the op context), for a prompt (F-141 D5)
 * @property {(fn: (w: unknown) => void) => void} stage  adds a function that the
 *   runner calls inside the box's store write, so the step's own writes (a
 *   counter, for example) go into the box's commit
 * @property {(session: { profile: string, id: string|null }) => Promise<void>} session  commits
 *   at once the agent session id of the box, with the profile that runs it, in
 *   `state.json`, so a resumed invocation at the box continues it (F-141 D8); an
 *   `id` of `null` commits `state.json` with no session
 * @property {(commit: { repo: string, sha: string }) => void} recordCommit  adds
 *   a repo commit to the invocation's `flow_end` `commits`
 * @property {(expr: string) => Promise<unknown>} evaluate  the CEL expression
 *   over `record`, as the gates evaluate it (F-140 D5); it rejects with an
 *   error that names the expression when the evaluation throws
 */

/**
 * @typedef {object} Step
 * @property {readonly Outcome[]} outcomes  the outcomes the step can return:
 *   each needs an arrow in every box that runs it (D-27)
 * @property {Record<string, unknown>|null} with  the JSON Schema of the step's
 *   `with:` arguments, or `null` for a step that takes none; a string that it
 *   marks `cel` is compiled when the flow set loads
 * @property {(withArgs: any) => boolean} [interactive]  true when the box's step needs
 *   the operator's terminal; with no terminal, the runner does not start it
 *   (D-29, F-141 D9). A step without it is never interactive.
 * @property {true} [waits]  the box waits for an `outcome` entry (`wait`, F-152 D5): the
 *   runner checks its step gate, then commits `waiting: <box>` and suspends; such a step
 *   has no `run`
 * @property {(ctx: StepContext, withArgs: any) => StepResult | Promise<StepResult>} [run]
 *   runs the step, and the runner awaits what it gives; a step that throws is
 *   a crash. Every step without `waits` has it.
 */

/** @type {Readonly<Record<string, Step>>} code step name → step */
export const STEPS = Object.freeze({
  succeed,
  assert: assertStep,
  increment,
  rank,
  notify,
  agent,
  wait,
});
