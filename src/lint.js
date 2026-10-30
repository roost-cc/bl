/**
 * lint.js — `bl lint` subcommand. Thin wrapper around the shared
 * format/lint dispatcher in format-lint.js (which both stages share).
 */

import { runStage } from './format-lint.js';

export async function main(argv) {
  return runStage('lint', argv);
}
