/**
 * wait.js — the step `wait` (F-152 D5; flow-config.md, "The `wait` step",
 * D-32).
 *
 * A planned wait is a box of its own that runs `wait`. The step has no `run`:
 * the runner checks the box's step gate, then commits `waiting: <box>` and a
 * `flow_end`, and the process suspends (`waits`). The step ends with the
 * outcome of an `outcome` entry for the box (`bl outcome`), which the suspend
 * loop finds after a wake (`wayOn`, F-152 D2), and the box's arrows say where
 * the flow goes.
 */

/** @typedef {import('./index.js').Step} Step */

/** @type {Step} */
export const wait = Object.freeze({
  outcomes: Object.freeze(/** @type {const} */ (['success', 'failure'])),
  with: null,
  waits: true,
});
