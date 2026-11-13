/**
 * command-output.js — how bl shows a failed command's output in a record or
 * an escalation: its last lines, its failure excerpt, and both as fenced
 * sections. `feature-run.js` (the test gate), `push-gate.js` (a failed push)
 * and `scripted.js` (a scripted story) share it.
 */

import { fenced } from './escalation.js';
import { failureExcerpt, NO_MARKERS } from './test-excerpt.js';

/** Lines of a command's output kept in a record (`## Gate result`, `## Gate`, an escalation). */
export const GATE_TAIL_LINES = 30;

/** How many of a failed push's last lines its reason shows. */
const PUSH_TAIL_LINES = 10;

/** The last `n` lines of `text`, trailing blanks dropped. */
export function tail(text, n = GATE_TAIL_LINES) {
  const lines = String(text ?? '')
    .replace(/\s+$/, '')
    .split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * The "Failure excerpt" and "Last <lines> lines" sections of a failed
 * command's output, each fenced. A null `excerpt` leaves its section out.
 */
export function outputSections(excerpt, last, lines) {
  return [
    ...(excerpt == null ? [] : [`Failure excerpt:\n\n${fenced(excerpt)}`]),
    `Last ${lines} lines:\n\n${fenced(last)}`,
  ];
}

/**
 * The failure excerpt and the last `lines` lines of a failed command's
 * output, trailing whitespace dropped first.
 */
export function outputParts(output, lines) {
  const shown = String(output ?? '').replace(/\s+$/, '');
  return { excerpt: failureExcerpt(shown), tail: tail(shown, lines) };
}

/**
 * The output of a failed `git push`, or of the gate's log (S-897): the
 * failure excerpt (a pre-push gate's failed test and error, S-1499), then its
 * last `lines` lines. With no failure marker (a rejected push), the last
 * lines alone.
 */
export function pushFailure(output, lines = PUSH_TAIL_LINES) {
  const { excerpt, tail: last } = outputParts(output, lines);
  return outputSections(excerpt === NO_MARKERS ? null : excerpt, last, lines).join('\n\n');
}
