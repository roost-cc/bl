/**
 * agents.js — print the backlog AGENTS.md reference.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSyncFiles } from './child-stdio.js';
import { fileURLToPath } from 'url';
import { runPager } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: bl agents

Prints the backlog system reference (AGENTS.md) for agents and humans.`);
    process.exit(0);
  }

  const content = readFileSync(join(__dirname, 'AGENTS.md'), 'utf8');

  const lines = content.split('\n').length;
  const termRows = process.stdout.rows || 24;

  if (process.stdout.isTTY && lines > termRows) {
    const pagerResult = runPager(content);
    if (pagerResult.error && !process.env.PAGER) {
      spawnSyncFiles('more', {
        input: content,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
    }
  } else {
    process.stdout.write(content);
  }
}
