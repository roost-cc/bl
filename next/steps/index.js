/**
 * steps/index.js — the step catalogue (F-139 D2).
 *
 * A code step is a step in `bl`'s code that a flow box runs, by name or with
 * `use:` (architecture.md, "Step"; flow-config.md, "Boxes"). The flow engine
 * runs it and follows the arrow of the outcome it returns. F-139 registers no
 * step: F-140 and later each add one line here. `buildFlowSet` and the runner
 * take the catalogue as an argument, so tests pass fake steps.
 */

/**
 * @typedef {object} StepContext
 * @property {string} id  the item's id
 * @property {string} type  the item's type
 * @property {string} box  the box path, for example `deliver/self_check/test_unit`
 * @property {Record<string, unknown>} record  the item's record when the step starts
 * @property {import('../config/load.js').Configuration} config  the frozen configuration
 * @property {string} backlogDir  the backlog's root
 * @property {(fn: (w: unknown) => void) => void} stage  adds a function that the
 *   runner calls inside the box's store write, so the step's own writes (a
 *   counter, for example) go into the box's commit
 * @property {(commit: { repo: string, sha: string }) => void} recordCommit  adds
 *   a repo commit to the invocation's `flow_end` `commits`
 */

/**
 * @typedef {object} Step
 * @property {readonly ('success'|'failure')[]} outcomes  the outcomes the step
 *   can return: each needs an arrow in every box that runs it (D-27)
 * @property {Record<string, unknown>|null} with  the JSON Schema of the step's
 *   `with:` arguments, or `null` for a step that takes none
 * @property {(ctx: StepContext, withArgs: unknown) => Promise<'success'|'failure'>} run
 *   runs the step; a step that throws is a crash
 */

/** @type {Readonly<Record<string, Step>>} code step name → step */
export const STEPS = Object.freeze({});
