/**
 * which.js — print the path to a story, component, feature, epic or theme's
 * index.md, or a task's file.
 *
 * Usage:
 *   bl which <id>             Path to the unit's file (a theme by its slug)
 */

import { loadConfig, parseArgs } from './config.js';
import { findUnitFile } from './unit-file.js';

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl which <id> [options]

Arguments:
  <id>                Story, component, feature, epic, or task ID, or a theme slug
                      (e.g. S34, C10, F3, E69, T5, backlog)

Options:
  -d, --dir           Print the directory instead of the file
  --help              Show this help

Prints the absolute path to the index.md or task file (or its directory with -d).`);
    process.exit(0);
  }

  const rawId = args.positional[0];
  if (!rawId) {
    console.error('Usage: bl which <id>');
    process.exit(1);
  }

  const hit = findUnitFile(rawId, loadConfig());
  if ('error' in hit) {
    console.error(hit.error);
    process.exit(1);
  }
  process.stdout.write((args.dir ? hit.dir : hit.indexPath) + '\n');
}
