/**
 * capabilities.js — the capabilities `flow.json` names in a verb's `via`, and
 * the verb handlers `DISPATCH` (`verbs.js`) names (F-69 D1). The file wires
 * them; this registry defines them. `bl validate`'s `flow-json` reports a
 * `via` name that is not a step (`VIA_CAPABILITIES`).
 *
 * Two kinds, until feature 3's executor calls capabilities through the table:
 *
 * - every `DISPATCH` cell, derived from it: a handler that `feature-cmd.js`
 *   exports, called `(args, config, record)`, or a module (`./workon.js`)
 *   whose `main(argv)` is the story command. `bl <verb> <id>` calls it here.
 * - the steps that `bl run`'s loop (`feature-run.js`) and `bl refine` run in
 *   code (`implement`, `test`, `review`, …). The table names them so that its
 *   rows read as the loop runs; calling one here throws.
 */

import { DISPATCH } from './verbs.js';

/** A `DISPATCH` cell as a function of `(args, config, record, argv)`. */
function dispatchHandler(cell) {
  if (cell.startsWith('./')) {
    return async (args, config, record, argv) => (await import(cell)).main(argv);
  }
  return async (args, config, record) => (await import('./feature-cmd.js'))[cell](args, config, record);
}

/** The steps that run in code today: the template's `via` names. */
const IN_CODE = ['refine', 'implement', 'test', 'self_review', 'open_pr', 'review', 'fix', 'fix_self_review', 'merge'];

function inCode(name) {
  return () => {
    throw new Error(`capability "${name}" runs inside bl's own code until the executor calls it (F-69 D3)`);
  };
}

const cells = new Set(
  Object.values(DISPATCH)
    .flatMap((kinds) => Object.values(kinds))
    .filter((cell) => cell != null),
);

/**
 * The capabilities a verb's `via` may name: the table's steps only, so a
 * `DISPATCH` handler name (`cmdRun`) in `via` is a `flow-json` finding.
 * @type {Map<string, Function>}
 */
export const VIA_CAPABILITIES = new Map(IN_CODE.map((name) => [name, inCode(name)]));

/** @type {Map<string, Function>} */
export const CAPABILITIES = new Map([...[...cells].map((cell) => [cell, dispatchHandler(cell)]), ...VIA_CAPABILITIES]);
