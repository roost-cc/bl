/**
 * pager.js — long output on a terminal goes to the pager (F-138 D8, D-440,
 * Decision A9).
 *
 * When stdout is a terminal and the text has more lines than it has rows,
 * `page` runs `$PAGER` (when set and not blank) through a shell. Else it runs
 * `less`, and when `less` cannot start, `more`, each with no shell; when
 * neither can start, it writes the text to stdout with no message. When the
 * pager that runs cannot start or exits nonzero, it writes the text to stdout
 * too, so no text is lost. The pager
 * gets the text on its stdin, and stdout and stderr on the terminal. Its
 * environment has `LESS=FRX` when `LESS` is not set, as git does, so `less`
 * passes the colors through and quits on a text that fits.
 */

import { exitStatus, runChild, runCommandLine } from '../lib/child.js';
import { LINE_BREAK } from './table.js';

/** The pagers to try, in order, when `$PAGER` is unset or empty. */
const FALLBACKS = ['less', 'more'];

/** The `LESS` of a pager when the operator has none. */
const LESS = 'FRX';

/** The lines of `text`, split at each line break of a table (`LINE_BREAK`), a last line with no break included. */
const lineCount = (text) => {
  const parts = text.split(LINE_BREAK);
  return parts.length - (parts.at(-1) === '' ? 1 : 0);
};

/**
 * Write `text` to `stdout`, through the pager when `stdout` is a terminal
 * with fewer rows than `text` has lines.
 * @param {string} text
 * @param {NodeJS.WritableStream} stdout
 * @returns {void}
 */
export function page(text, stdout) {
  const tty = /** @type {import('tty').WriteStream} */ (stdout);
  if (!tty.isTTY || lineCount(text) <= tty.rows) {
    stdout.write(text);
    return;
  }
  const opts = {
    input: text,
    stdio: /** @type {import('child_process').StdioOptions} */ (['pipe', 'inherit', 'inherit']),
    env: { ...process.env, LESS: process.env.LESS ?? LESS },
  };
  const pager = process.env.PAGER?.trim();
  /** The text goes to stdout when the pager could not start or exited unsuccessfully. */
  const settle = (result) => {
    if (exitStatus(result) !== 0) stdout.write(text);
  };
  if (pager) {
    settle(runCommandLine(pager, opts));
    return;
  }
  for (const fallback of FALLBACKS) {
    const result = runChild(fallback, [], opts);
    if (result.error?.code !== 'ENOENT') {
      settle(result);
      return;
    }
  }
  stdout.write(text);
}
