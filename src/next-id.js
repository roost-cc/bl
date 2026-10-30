/**
 * next-id.js — print the next available story, component, epic or task
 * ID(s).
 *
 * Pure query: no side effects, no reservation. Concurrent callers may both
 * see the same answer; that's acceptable for a single-user tool. The only
 * writers that matter are `bl new` and `bl task`, which hold the backlog
 * lock during ID assignment.
 */

import { loadConfig, parseArgs } from './config.js';
import { nextStoryNums, findNextComponentNum } from './story.js';
import { findNextEpicNum } from './theme.js';
import { nextTaskNums } from './task.js';

const KINDS = ['story', 'component', 'epic', 'task'];

const USAGE = `Usage: bl next-id <story|component|epic|task> [--count <n>]

Print the next available story, component, epic or task ID(s).

  <kind>            'story', 'component', 'epic' or 'task'
  --count <n>       How many consecutive IDs to print (default 1, max 1000)
  --help            Show this help

Story, component, epic and task IDs are globally unique across the backlog repo.
Epics are numbered from E50 (E00–E49 were components). This is a query, not
a reservation — concurrent callers may receive the same answer; no lock is
held.`;

function fail(msg) {
  console.error(msg);
  console.error(USAGE);
  process.exit(1);
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const kind = args.positional[0];
  if (!KINDS.includes(kind)) {
    fail("bl next-id: kind must be 'story', 'component', 'epic' or 'task'");
  }

  let count = 1;
  if (args.count != null && args.count !== false) {
    if (args.count === true) {
      fail('bl next-id: --count requires a value');
    }
    const raw = String(args.count);
    if (!/^-?\d+$/.test(raw)) {
      fail(`bl next-id: --count must be a positive integer (got '${raw}')`);
    }
    count = parseInt(raw, 10);
    if (count < 1 || count > 1000) {
      fail('bl next-id: --count must be between 1 and 1000');
    }
  }

  const config = loadConfig();

  if (kind === 'story') {
    const lines = nextStoryNums(config, count);
    process.stdout.write(lines.join('\n') + '\n');
  } else if (kind === 'task') {
    process.stdout.write(nextTaskNums(config, count).join('\n') + '\n');
  } else if (kind === 'epic') {
    const start = findNextEpicNum(config);
    const lines = [];
    for (let i = 0; i < count; i++) lines.push(`E${start + BigInt(i)}`);
    process.stdout.write(lines.join('\n') + '\n');
  } else {
    const start = findNextComponentNum(config);
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(`C${String(start + BigInt(i)).padStart(2, '0')}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
}
