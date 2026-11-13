/**
 * flow-cmd.js — `bl flow` (F-119 D3): each type's transitions as a table,
 * read only. It reads the backlog's `flow.json`, or bl's template outside a
 * backlog (`flowForHelp`), and prints `flowTables`, which `bl report` uses
 * too.
 */

import { FLOW_DOC, flowForHelp } from './flow.js';
import { flowTables } from './flow-view.js';

const HELP = `Usage: bl flow

Print each type's transitions, as flow.json's verb rows define them: one row
per transition with its from status, to status, verb, guards (the verb's
"when") and gates (the statuses on the verb's nominal path, which a hold in
blockers.json can keep a unit out of). A "new" row's from is (none). bl force
is no row: it moves a unit to any status (bl force --help).

Outside a backlog it prints bl's template flow.json. bl report has the same
tables under "## Workflow". The file's format: ${FLOW_DOC}.

Options:
  -h, --help  Show this help`;

/**
 * @param {string[]} argv
 * @returns {number} the exit code
 */
export function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (argv.length > 0) {
    console.error(`bl flow: takes no arguments (got ${argv.join(' ')})`);
    return 1;
  }
  const flow = flowForHelp({ strict: true });
  console.log(`Transitions in ${flow.path}\n\n${flowTables(flow)}`);
  return 0;
}
