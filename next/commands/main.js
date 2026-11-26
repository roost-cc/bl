/**
 * main.js — the process start of `bl-next` (F-136 D8).
 *
 * It finds the backlog and loads the configuration once, before any work. A
 * configuration fault stops it with one line per fault. It has no commands
 * yet: F-138 gives it argument parsing and commands, and grows `main`.
 */

import { ConfigurationFaults } from '../config/check.js';
import { findBacklogRoot, operatorDir } from '../config/files.js';
import { KINDS } from '../config/kinds.js';
import { loadConfiguration } from '../config/load.js';

/**
 * Run `bl-next`.
 * @param {string[]} argv  the arguments after the program name; F-138 reads them
 * @returns {number} the exit code: 1 on a fault at load, 2 with none (no commands yet)
 */
export function main(argv) {
  try {
    loadConfiguration({ backlogDir: findBacklogRoot(), operatorDir: operatorDir(), kinds: KINDS });
  } catch (error) {
    process.stderr.write(error instanceof ConfigurationFaults ? `${error.message}\n` : `bl-next: ${error.message}\n`);
    return 1;
  }
  process.stderr.write('bl-next: no commands yet\n');
  return 2;
}
