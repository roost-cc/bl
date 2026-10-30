/**
 * agents.js — print the backlog AGENTS.md reference.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exitStatus, showText } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: bl agents

Prints the backlog system reference (AGENTS.md) for agents and humans.`);
    process.exit(0);
  }

  process.exitCode = exitStatus(showText(readFileSync(join(__dirname, 'AGENTS.md'), 'utf8')));
}
