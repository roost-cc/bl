/**
 * main.js — the process start of `bl-next` (F-136 D8, F-138 D3).
 *
 * It finds the backlog and loads the configuration once, before any work,
 * then runs the start checks. A configuration fault stops it with one line per
 * fault and a line that names `bl-validate` (D-423). It then parses the
 * arguments and runs the command through `dispatch.js`.
 */

import { ConfigurationFaults } from '../config/check.js';
import { findBacklogRoot, operatorDir } from '../config/files.js';
import { KINDS } from '../config/kinds.js';
import { loadConfiguration } from '../config/load.js';
import { dispatch, startFaults } from './dispatch.js';
import { OPS } from './ops/index.js';

/** The last line of a configuration fault report (D-423). */
const DOES_NOT_LOAD = 'bl-next: the configuration does not load; bl-validate checks it';

/**
 * Run `bl-next`.
 * @param {string[]} argv  the arguments after the program name
 * @returns {Promise<number>} the exit code: 1 on a configuration fault, 2 on a usage error
 */
export async function main(argv) {
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
