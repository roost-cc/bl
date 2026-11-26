/**
 * stderr.js — the progress and warning lines of `lib/` (F-135 D4).
 *
 * Copied from `info` and `warn` in `src/config.js`. Status, progress and
 * explanatory output goes to stderr; stdout is reserved for the answer to the
 * user's question (paths, IDs, tables, JSON). See `src/AGENTS.md`, "Stream
 * policy". Every `lib/` module that writes a progress or warning line imports
 * these two helpers.
 */

/**
 * Write the arguments, joined by spaces, as one line on stderr.
 *
 * @param {...unknown} a  each is written as `String(x ?? '')`
 */
export const info = (...a) => process.stderr.write(a.map((x) => String(x ?? '')).join(' ') + '\n');

/**
 * Write the arguments, joined by spaces, as one `warning: ` line on stderr.
 *
 * @param {...unknown} a  each is written as `String(x ?? '')`
 */
export const warn = (...a) => process.stderr.write('warning: ' + a.map((x) => String(x ?? '')).join(' ') + '\n');
