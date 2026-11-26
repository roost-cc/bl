/**
 * files.js — where the configuration files are, and how one is read (F-136 D3).
 *
 *   - `findBacklogRoot(start)`: the backlog, by the rule of today's
 *     `findBacklogRoot` (`src/config.js`), with `backlog.yaml` as the marker
 *     (D-755 moves `backlog.json` to YAML).
 *   - `operatorDir()`: the operator's directory, as XDG gives it.
 *   - `readYaml(path)`: one YAML file as a mapping, or a configuration fault.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { YAMLParseError, parse } from 'yaml';
import { realOrResolved } from '../lib/real-path.js';

/** The file that marks a directory as a backlog. */
const MARKER = 'backlog.yaml';

/** True when `value` is a mapping: an object that is not a list. */
export const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * True when `dir` holds a `backlog.yaml` that is a regular file and parses to
 * a mapping with a `repos` key. Any error reading or parsing it is "no".
 * @param {string} dir
 */
function isBacklogRoot(dir) {
  const file = join(dir, MARKER);
  try {
    // Only a regular file: reading a FIFO there would block for ever.
    if (!statSync(file).isFile()) return false;
    const value = parse(readFileSync(file, 'utf8'));
    return isMapping(value) && Boolean(value.repos);
  } catch {
    return false;
  }
}

/**
 * The subdirectories of `dir` (one level down, hidden names skipped) that are
 * backlogs, sorted. A `dir` that cannot be read has none.
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function backlogsIn(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(dir, name))
    .filter(isBacklogRoot)
    .sort();
}

/**
 * The directories the walk does not move up into: `$BL_CEILING_DIRECTORIES`,
 * absolute paths split on `path.delimiter`, as git reads
 * `GIT_CEILING_DIRECTORIES`. Relative entries are ignored. Real paths, so a
 * symlinked temp directory (macOS `/var` → `/private/var`) still matches.
 * @returns {Set<string>}
 */
function ceilingDirs() {
  const raw = process.env.BL_CEILING_DIRECTORIES ?? '';
  return new Set(raw.split(delimiter).filter(isAbsolute).map(realOrResolved));
}

/**
 * The backlog's root directory.
 *
 *   1. `$BL_BACKLOG_DIR`, if it names a backlog.
 *   2. For `start`, then each directory above it up to the filesystem root:
 *      the one subdirectory that is a backlog. The nearest level wins; two at
 *      one level is an error. The walk does not move up into a directory in
 *      `$BL_CEILING_DIRECTORIES`; `start` itself is always searched.
 *
 * @param {string} [start] the directory to start from (default the cwd)
 * @returns {string} the absolute path of the backlog
 */
export function findBacklogRoot(start = process.cwd()) {
  const envDir = process.env.BL_BACKLOG_DIR;
  if (envDir && isBacklogRoot(envDir)) return resolve(envDir);

  const from = resolve(start);
  const ceilings = ceilingDirs();
  let dir = from;
  while (true) {
    const found = backlogsIn(dir);
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(`several backlogs under ${dir}: ${found.join(', ')} (set BL_BACKLOG_DIR to choose one)`);
    }
    const parent = dirname(dir);
    if (parent === dir || ceilings.has(realOrResolved(parent))) break;
    dir = parent;
  }
  throw new Error(
    `no backlog found: no subdirectory of ${from} or of any directory above it up to ${dir} holds a ${MARKER} with "repos" (set BL_BACKLOG_DIR, or run bl at or under the backlog's parent directory)`,
  );
}

/**
 * The operator's directory: `$XDG_CONFIG_HOME/bl` when `$XDG_CONFIG_HOME` is
 * set, else `$HOME/.config/bl` (core.md, "Operator configuration").
 * @returns {string}
 */
export function operatorDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'bl') : join(process.env.HOME ?? '', '.config', 'bl');
}

/**
 * @typedef {object} Fault  one configuration fault (D5)
 * @property {string} file     the file the fault is in
 * @property {string} path     the JSON pointer of the failing value; '' for the whole file
 * @property {string} rule     what failed: here `yaml`
 * @property {string} message  what is wrong, in the library's or bl's words
 */

/**
 * One YAML file as a mapping. A YAML error is a fault with the error's line;
 * a top level that is not a mapping is a fault too, because a layer must be
 * an object to merge (D3). A file that cannot be read throws: the caller
 * reads only files it found.
 *
 * @param {string} path
 * @returns {{ value: Record<string, unknown> } | { fault: Fault }}
 */
export function readYaml(path) {
  const fault = (message) => ({ fault: { file: path, path: '', rule: 'yaml', message } });
  let value;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    // The library's message ends in " at line N, column M:" and a code frame;
    // a fault is one line (D5), so it keeps the first line without that tail.
    const text = error.message.split('\n')[0].replace(/ at line \d+, column \d+:$/, '');
    const line = error.linePos?.[0]?.line;
    return fault(line === undefined ? text : `line ${line}: ${text}`);
  }
  if (!isMapping(value)) return fault('the top level must be a mapping');
  return { value };
}
