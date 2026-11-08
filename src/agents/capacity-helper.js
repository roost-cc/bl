/**
 * capacity-helper.js — run a capacity helper script and read its answer.
 *
 * `capacity()` is synchronous (provider.js), like spawn() and the loop, but
 * an adapter's read may need async I/O: a JSON-RPC conversation
 * (`codex-capacity.js`) or an HTTP request (`local-capacity.js`). So the
 * adapter runs a Node script with `spawnSyncFiles` and a timeout, and the
 * script prints its answer as one JSON line. The answer comes back through a
 * file (F-70 D1).
 */

import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawnSyncFiles } from '../child-stdio.js';

// Past the helper's own deadline: its own start-up, and any clean-up it does
// after the deadline (codex's SIGTERM-then-SIGKILL grace), fit inside it.
export const CAPACITY_SPAWN_MARGIN_MS = 5_000;

/**
 * Run `script` with `args` under this Node, and parse the last line it
 * prints as JSON. Never throws: `{ out }` when the helper exits 0 and that
 * line is a JSON object, else `{ reason }`, the failure in a few words
 * (`exit 1`, `signal SIGTERM`, `exit 0` for no JSON answer, the spawn
 * error). A helper
 * that exits with an error or a signal gives a `reason`, whatever it printed.
 * `run` and `env` are for tests.
 *
 * @param {string} script — absolute path of the helper
 * @param {string[]} args
 * @param {{ run?: Function, env?: Record<string, string|undefined>, timeoutMs: number }} opts
 * @returns {{ out: object } | { reason: string }}
 */
export function runCapacityHelper(script, args, { run = spawnSyncFiles, env = process.env, timeoutMs }) {
  let r;
  try {
    r = run(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs + CAPACITY_SPAWN_MARGIN_MS,
    });
  } catch (error) {
    return { reason: error.message };
  }
  if (r.error) return { reason: r.error.message };
  // A helper that failed may have printed an answer first: trust none.
  if (r.signal) return { reason: `signal ${r.signal}` };
  if (r.status !== 0) return { reason: `exit ${r.status}` };
  let out;
  try {
    out = JSON.parse(
      String(r.stdout ?? '')
        .trim()
        .split('\n')
        .pop(),
    );
  } catch {
    out = null;
  }
  if (out == null || typeof out !== 'object' || Array.isArray(out)) return { reason: `exit ${r.status}` };
  return { out };
}

/**
 * Whether the module at `url` (its `import.meta.url`) is the script Node
 * runs, so a helper prints its answer only when run, not when imported.
 * @param {string} url
 */
export function isMainModule(url) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
