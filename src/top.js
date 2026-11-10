/**
 * top.js — `bl top`: a live view of bl's runs, inbox and next work (F-87).
 *
 *   bl top [--interval <ms>] [--no-bell] [--no-desktop] [--no-push]
 *   bl top --json
 *   bl top --stream [--interval <ms>]
 *
 * `--json` prints one snapshot (`top-snapshot.js`) and exits; `--stream`
 * prints one per line until stdin closes (`top-stream.js`). With neither,
 * `bl top` runs the Go TUI (`top/`, D2), which runs `bl top --stream` and
 * draws its lines. It builds the TUI first when its binary is missing or
 * older than its sources.
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'fs';
import { join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { loadConfig, topSettings } from './config.js';
import {
  ACTIVITY_SHOWN,
  HISTORY_DAYS,
  NEXT_SHOWN,
  problemLines,
  TOKEN_MINUTES,
  TOP_SCHEMA,
  topSnapshot,
} from './top-snapshot.js';
import { ATTENTION_MAX_AGE_MS, CAPACITY_EVERY_MS, HISTORY_EVERY_MS, runStream } from './top-stream.js';

export const DEFAULT_INTERVAL_MS = 2000;
// The TUI's `+` and `-` keep to the same bounds (top/internal/ui/model.go).
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 10000;

/** The Go TUI's module, its binary, and the bl the TUI runs for its stream. */
const TOP_DIR = fileURLToPath(new URL('../top/', import.meta.url));
const TOP_BIN = join(TOP_DIR, 'bin', 'bl-top');
const BL_PATH = fileURLToPath(new URL('./bl.js', import.meta.url));

/** `30 s`, `5 min`. */
const s = (ms) => (ms >= 60000 ? `${ms / 60000} min` : `${ms / 1000} s`);

const HELP = `Usage: bl top [--interval <ms>] [--no-bell] [--no-desktop] [--no-push]
       bl top --json
       bl top --stream [--interval <ms>]

A live view of bl: the runs, what waits on you, what bl next picks, agent
capacity and the stories done per day.

With no --json or --stream, bl top runs the view, a terminal UI in btop's
style. It builds the view with go build (top/ in bl) when top/bin/bl-top is
missing or older than a file under top/; that build needs Go. Keys: 1-5 hide
or show a box, tab and shift+tab move the focus, up and down select a row,
enter opens or closes the grouped update row, c reads capacity now, + and -
change the refresh interval, h shows the help, q quits.

The view notifies for a new escalation, a new task, and a run that ends
(clean, no-change, reviewed, escalated, failed or stopped: every status but
running and stale); the first snapshot only sets what is not new. A
notification rings the terminal bell, which tmux shows as a flag on the
window, and runs notify-send -a "bl top" -- "<id> <kind>" "<line>" when
notify-send is on PATH. If notify-send fails or runs longer than 10 s, the
bottom border shows a red warning until it next succeeds.

A new escalation or task also runs the phone push command, when backlog.json
names one in "top": { "push": ["<command>", "<arg>", …] }, with the same two
last arguments as notify-send. It fails and warns as notify-send does. A run
that ends sends no phone push.

Options:
  --no-bell          Ring no bell for a notification (the view)
  --no-desktop       Run no notify-send for a notification (the view)
  --no-push          Run no phone push command (the view)
  --version          Print the view's version (after a build when it needs
                     one) and exit
  --json             Print one snapshot (schema "${TOP_SCHEMA}") and exit
  --stream           Print one snapshot per line (JSON Lines) every interval,
                     the first at once, until stdin closes; a "capacity" line
                     on stdin reads capacity at the next snapshot
  --interval <ms>    The refresh interval of the view or the stream,
                     ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS} (default ${DEFAULT_INTERVAL_MS})

The snapshot is one object: schema, at, and one key per section below. Each
section carries read_at (an ISO time), and error when its last read failed;
it then keeps its last good value.
  runs        each run state that is running or stopped, or was updated in
              the last 24 h; status "stale" when it says running and its
              run lock has no live holder (every snapshot)
  attention   bl inbox's items, in its order (when the backlog changes, and
              at least every ${s(ATTENTION_MAX_AGE_MS)})
  next        bl next's pick and the first ${NEXT_SHOWN} ranked units with status,
              points and holds (as attention)
  capacity    bl capacity --json's configurations (every ${s(CAPACITY_EVERY_MS)})
  history     per day over the last ${HISTORY_DAYS} days, the stories that first reached
              done and their points (every ${s(HISTORY_EVERY_MS)})
  activity    the newest ${ACTIVITY_SHOWN} history entries of all run states, newest
              first (every snapshot)
  tokens      the output tokens of each of the last ${TOKEN_MINUTES} minutes, from the
              ended sessions' usage, and today's totals (every snapshot)

Output:
  stdout   Only the JSON (--json, --stream), or the version (--version).
  stderr   A section that could not be read, and the inbox's warnings
           (--json, --stream); the build's output; why the view's stream
           ended.

Exit codes:
  0   Printed (--json, --version), stdin closed (--stream), or the view quit.
  1   A bad flag or interval, no backlog, a bad "top" block in backlog.json
      (the view), a build that is needed and fails or finds no Go, or the
      view's stream ended.`;

/** Parse the flags, or print why not and exit 1. */
function flags(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean' },
        stream: { type: 'boolean' },
        interval: { type: 'string' },
        version: { type: 'boolean' },
        'no-bell': { type: 'boolean' },
        'no-desktop': { type: 'boolean' },
        'no-push': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) {
    console.error(`bl top: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Whether the TUI's binary `top/bin/bl-top` is missing, or older than a file
 * under `top/` outside `top/bin/` (D2).
 * @param {string} [topDir]
 */
export function tuiNeedsBuild(topDir = TOP_DIR) {
  const bin = join(topDir, 'bin', 'bl-top');
  if (!existsSync(bin)) return true;
  const built = statSync(bin).mtimeMs;
  return readdirSync(topDir, { recursive: true, withFileTypes: true }).some((e) => {
    const path = join(e.parentPath, e.name);
    return e.isFile() && relative(topDir, path).split(sep)[0] !== 'bin' && statSync(path).mtimeMs > built;
  });
}

/**
 * The Go version `top/go.mod` needs: its `go` directive. Only that one line
 * is read, for the message when Go is missing; Go itself reads the file.
 */
function goVersion() {
  return /^go (\S+)$/m.exec(readFileSync(join(TOP_DIR, 'go.mod'), 'utf8'))?.[1] ?? '(see top/go.mod)';
}

/**
 * Build `top/bin/bl-top` with `go build`, or exit 1: with the Go version
 * `top/go.mod` needs when `go` is not on PATH, or when the build fails. The
 * build's output goes to stderr. A build that leaves the binary as it was
 * still marks it built, so the next `bl top` does not build again.
 */
function buildTui() {
  console.error('bl top: building the view (go build in top/)');
  const r = spawnSync('go', ['build', '-o', TOP_BIN, '.'], { cwd: TOP_DIR, stdio: ['ignore', 2, 2] });
  if (r.error?.code === 'ENOENT') {
    console.error(`bl top: the view needs a build, and go is not on PATH; install Go ${goVersion()} (top/go.mod)`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`bl top: go build failed in ${TOP_DIR}`);
    process.exit(1);
  }
  const now = new Date();
  utimesSync(TOP_BIN, now, now);
}

/**
 * The view's arguments: `interval` is the number that `main` checked, never
 * the flag's text (`1e3`, `0600`), which Go's flag package reads otherwise.
 * @param {Record<string, string | boolean | undefined>} opts
 * @param {number} interval
 * @param {string[] | null} push
 * @returns {string[]}
 */
export function tuiArgs(opts, interval, push) {
  const args = ['--bl-argv', JSON.stringify([process.execPath, BL_PATH])];
  if (opts.interval !== undefined) args.push('--interval', String(interval));
  if (opts.version) args.push('--version');
  if (opts['no-bell']) args.push('--no-bell');
  if (opts['no-desktop']) args.push('--no-desktop');
  if (opts['no-push']) args.push('--no-push');
  if (push) args.push('--push-argv', JSON.stringify(push));
  return args;
}

/**
 * Run the TUI with the terminal's stdio and exit with its code; build it
 * first when it needs a build. The phone push command comes from
 * backlog.json's `top` block (D8a), read before the build: a bad block exits
 * 1. `--no-push` passes no command.
 */
function runTui(opts, interval) {
  let push;
  try {
    push = topSettings(loadConfig());
  } catch (e) {
    console.error(`bl top: ${e.message}`);
    process.exit(1);
  }
  if (tuiNeedsBuild()) buildTui();
  const r = spawnSync(TOP_BIN, tuiArgs(opts, interval, push), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
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
  if (opts.version && (opts.json || opts.stream)) {
    console.error('bl top: --version goes without --json and --stream');
    process.exit(1);
  }
  if ((opts['no-bell'] || opts['no-desktop'] || opts['no-push']) && (opts.json || opts.stream)) {
    console.error('bl top: --no-bell, --no-desktop and --no-push go with the view, not --json or --stream');
    process.exit(1);
  }
  const interval = opts.interval === undefined ? DEFAULT_INTERVAL_MS : Number(opts.interval);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
    console.error(`bl top: --interval must be a whole number of ms from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`);
    process.exit(1);
  }
  if (opts.interval !== undefined && opts.json) {
    console.error('bl top: --interval goes with --stream or the view, not --json');
    process.exit(1);
  }
  if (!opts.json && !opts.stream) runTui(opts, interval);
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
