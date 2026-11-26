/**
 * main.js — the process start of `bl-next` (F-136 D8, F-138 D3).
 *
 * It finds the backlog and loads the configuration once, before any work,
 * then runs the start checks. A configuration fault stops it with one line per
 * fault and a line that names `bl-validate` (D-423). It then parses the
 * arguments and runs the command through `dispatch.js`.
 *
 * Before the load, it names the terminal tab (F-138 D9): the status is the
 * command name, or `help` when the arguments are empty or hold `-h` or
 * `--help`. The exit sets the end state (`endTabTitle` in `tab-title.js`).
 */

import { exitOnSignal } from '../lib/signal-exit.js';
import { ConfigurationFaults } from '../config/check.js';
import { findBacklogRoot, operatorDir } from '../config/files.js';
import { KINDS } from '../config/kinds.js';
import { loadConfiguration } from '../config/load.js';
import { dispatch, startFaults } from './dispatch.js';
import { OPS } from './ops/index.js';
import { captureTmuxWindowId, updateTabTitle } from './tab-title.js';

/** The last line of a configuration fault report (D-423). */
const DOES_NOT_LOAD = 'bl-next: the configuration does not load; bl-validate checks it';

/**
 * The start status of the tab title: `help` when `argv` is empty or holds
 * `-h` or `--help`, else its first argument, the command name.
 * @param {string[]} argv
 */
function startStatus(argv) {
  return argv.length === 0 || argv.includes('-h') || argv.includes('--help') ? 'help' : argv[0];
}

/**
 * Run `bl-next`.
 * @param {string[]} argv  the arguments after the program name
 * @returns {Promise<number>} the exit code: 1 on a configuration fault, 2 on a usage error
 */
export async function main(argv) {
  // The window id first, before any async work, so every title targets the
  // window bl-next started in even if the operator has switched since.
  captureTmuxWindowId();
  updateTabTitle({ status: startStatus(argv) });
  // Ctrl+C and SIGTERM end bl-next with 130 and 143 through `process.exit`,
  // so its `exit` listeners run (signal-exit.js).
  exitOnSignal();
  let backlogDir;
  let config;
  try {
    backlogDir = findBacklogRoot();
    config = loadConfiguration({ backlogDir, operatorDir: operatorDir(), kinds: KINDS });
    const faults = startFaults(config, OPS);
    if (faults.length > 0) throw new ConfigurationFaults(faults, backlogDir);
  } catch (error) {
    process.stderr.write(
      error instanceof ConfigurationFaults ? `${error.message}\n${DOES_NOT_LOAD}\n` : `bl-next: ${error.message}\n`,
    );
    return 1;
  }
  const outcome = await dispatch(argv, { config, backlogDir, ops: OPS });
  if ('status' in outcome) {
    process.stdout.write(outcome.stdout);
    process.stderr.write(outcome.stderr);
    return outcome.status;
  }
  // The op ran; S-1612's output.js prints its records.
  return 0;
}
