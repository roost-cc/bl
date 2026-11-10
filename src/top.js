/**
 * top.js — `bl top`: a live view of bl's runs, inbox and next work (F-87).
 *
 *   bl top --json
 *   bl top --stream [--interval <ms>]
 *
 * `--json` prints one snapshot (`top-snapshot.js`) and exits; `--stream`
 * prints one per line until stdin closes (`top-stream.js`). The Go TUI
 * (S-1332) runs `bl top --stream` and draws its lines.
 */

import { parseArgs } from 'util';
import { loadConfig } from './config.js';
import { problemLines, TOP_SCHEMA, topSnapshot } from './top-snapshot.js';
import { ATTENTION_MAX_AGE_MS, CAPACITY_EVERY_MS, HISTORY_EVERY_MS, runStream } from './top-stream.js';

export const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 10000;

/** `30 s`, `5 min`. */
const s = (ms) => (ms >= 60000 ? `${ms / 60000} min` : `${ms / 1000} s`);

const HELP = `Usage: bl top --json
       bl top --stream [--interval <ms>]

A live view of bl: the runs, what waits on you, what bl next picks, agent
capacity and the stories done per day. The view itself (bl top with no flag)
comes with the Go TUI; until then use --json or --stream.

Options:
  --json             Print one snapshot (schema "${TOP_SCHEMA}") and exit
  --stream           Print one snapshot per line (JSON Lines) every interval,
                     the first at once, until stdin closes; a "capacity" line
                     on stdin reads capacity at the next snapshot
  --interval <ms>    The stream's interval, ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS} (default ${DEFAULT_INTERVAL_MS})

The snapshot: {schema, at, runs, attention, next, capacity, history}. Each
section carries read_at (an ISO time), and error when its last read failed;
it then keeps its last good value.
  runs        each run state that is running or stopped, or was updated in
              the last 24 h; status "stale" when it says running and its
              run lock has no live holder (every snapshot)
  attention   bl inbox's items, in its order (when the backlog changes, and
              at least every ${s(ATTENTION_MAX_AGE_MS)})
  next        bl next's pick and the first 10 ranked units with status,
              points and holds (as attention)
  capacity    bl capacity --json's configurations (every ${s(CAPACITY_EVERY_MS)})
  history     per day over the last 30 days, the stories that first reached
              done and their points (every ${s(HISTORY_EVERY_MS)})

Output:
  stdout   Only the JSON.
  stderr   A section that could not be read, and the inbox's warnings.

Exit codes:
  0   Printed (--json), or stdin closed (--stream).
  1   No flag, a bad flag or interval, or no backlog.`;

/** Parse the flags, or print why not and exit 1. */
function flags(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean' },
        stream: { type: 'boolean' },
        interval: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) {
    console.error(`bl top: ${e.message}`);
    process.exit(1);
  }
}

export async function main(argv) {
  const opts = flags(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.json && opts.stream) {
    console.error('bl top: --json and --stream exclude each other');
    process.exit(1);
  }
  if (!opts.json && !opts.stream) {
    console.error('bl top: the TUI is not built yet; use --json or --stream');
    process.exit(1);
  }
  const interval = opts.interval === undefined ? DEFAULT_INTERVAL_MS : Number(opts.interval);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
    console.error(`bl top: --interval must be a whole number of ms from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`);
    process.exit(1);
  }
  if (opts.interval !== undefined && !opts.stream) {
    console.error('bl top: --interval needs --stream');
    process.exit(1);
  }
  const config = loadConfig();
  if (opts.json) {
    const snapshot = topSnapshot(config);
    for (const line of problemLines(snapshot)) console.error(line);
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  await runStream(config, { interval });
  // stdin closed: a paused stdin or a pending timer must not keep bl alive.
  process.exit(0);
}
