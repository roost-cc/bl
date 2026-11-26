/**
 * main.js — the process start of `bl-next` (F-136 D8, F-138 D3).
 *
 * It finds the backlog and loads the configuration once, before any work,
 * then runs the start checks. A configuration fault stops it with one line per
 * fault and a line that names `bl-validate` (D-423). It then parses the
 * arguments and runs the command through `dispatch.js`, and prints the op's
 * records through `output.js`.
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
import { blIn, CommandFailed, dispatch, PROG, startFaults } from './dispatch.js';
import { OPS } from './ops/index.js';
import { writeOutput } from './output.js';
import { captureTmuxWindowId, updateTabTitle } from './tab-title.js';

/** The last line of a configuration fault report (D-423). */
const DOES_NOT_LOAD = `${PROG}: the configuration does not load; bl-validate checks it`;

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
 * @param {{ ops?: Readonly<Record<string, import('./ops/index.js').Op>> }} [options]
 *   `ops` is the op registry, `OPS`; a test passes fixture ops
 * @returns {Promise<number>} the exit code: 1 on a configuration fault, 2 on a usage error
 */
export async function main(argv, { ops = OPS } = {}) {
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
    const faults = startFaults(config, ops);
    if (faults.length > 0) throw new ConfigurationFaults(faults, backlogDir);
  } catch (error) {
    process.stderr.write(
      error instanceof ConfigurationFaults ? `${error.message}\n${DOES_NOT_LOAD}\n` : `${PROG}: ${error.message}\n`,
    );
    return 1;
  }
  const context = { config, backlogDir, ops };
  const exit = ({ status, stdout, stderr }) => {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    return status;
  };
  const outcome = await dispatch(argv, context);
  if ('status' in outcome) return exit(outcome);
  const { name, op, args, result } = outcome;
  try {
    // A pager that started and failed fails the command with its status.
    return await writeOutput({
      command: name,
      op,
      args,
      result,
      config,
      stdout: process.stdout,
      bl: blIn(context, [name]),
    });
  } catch (error) {
    // A `{{#bl}}` command that failed fails this one, with its message (D7).
    if (error instanceof CommandFailed) return exit(error.exit);
    throw error;
  }
}
