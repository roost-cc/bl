/**
 * files.js — where the configuration files are, and how one is read (F-136 D3).
 *
 *   - `findBacklogRoot(start)`: the backlog, by the rule of today's
 *     `findBacklogRoot` (`src/config.js`), with `backlog.yaml` as the marker
 *     (D-755 moves `backlog.json` to YAML).
 *   - `operatorDir()`: the operator's directory, as XDG gives it.
 *   - `readYaml(path)`: one YAML file as a mapping, or its configuration faults.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { parse, parseDocument } from 'yaml';
import { realOrResolved } from '../lib/real-path.js';

/** The file that marks a directory as a backlog; the `backlog` kind's shop file. */
export const MARKER = 'backlog.yaml';

/** True when `value` is a mapping: an object that is not a list. */
export const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One token of a JSON pointer (RFC 6901, section 3). */
export const pointerToken = (name) => name.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * True when `dir` holds a `backlog.yaml` that is a regular file and parses to
 * a mapping with a `repos` key. Any error reading or parsing it is "no". The
 * key's value does not count (`repos: null` qualifies): the shape check
 * reports a bad value with the file and the rule (D5).
 * @param {string} dir
 */
function isBacklogRoot(dir) {
  const file = join(dir, MARKER);
  try {
    // Only a regular file: reading a FIFO there would block for ever.
    if (!statSync(file).isFile()) return false;
    const value = parse(readFileSync(file, 'utf8'));
    return isMapping(value) && Object.hasOwn(value, 'repos');
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
 * One YAML file as a mapping, or every fault of it. Each YAML error is a
 * fault with the error's line; a top level that is not a mapping is a fault
 * too, because a layer must be an object to merge (D3), and so are a cycle
 * of aliases and each key that the merge cannot hold (`RESERVED_KEYS`). A
 * file that cannot be read throws: the caller reads only files it found.
 *
 * @param {string} path
 * @returns {{ value: Record<string, unknown> } | { faults: Fault[] }}
 */
export function readYaml(path) {
  /** @param {{ message: string, path?: string }[]} found */
  const faults = (found) => ({
    faults: found.map((f) => ({ file: path, path: f.path ?? '', rule: 'yaml', message: f.message })),
  });
  // `parseDocument` keeps every error of the text, where `parse` throws the first.
  const doc = parseDocument(readFileSync(path, 'utf8'));
  for (const warning of doc.warnings) process.emitWarning(warning);
  if (doc.errors.length > 0) {
    // The library's message ends in " at line N, column M:" and a code frame;
    // a fault is one line (D5), so it keeps the first line without that tail.
    return faults(
      doc.errors.map((error) => {
        const first = error.message.split('\n')[0].replace(/ at line \d+, column \d+:$/, '');
        const line = error.linePos?.[0]?.line;
        return { message: line === undefined ? first : `line ${line}: ${first}` };
      }),
    );
  }
  let value;
  try {
    value = doc.toJS();
  } catch (error) {
    // The library throws as it builds the value: a ReferenceError for an
    // alias with no anchor before it, or for aliases that expand too far.
    return faults([{ message: String(error.message).split('\n')[0] }]);
  }
  if (!isMapping(value)) return faults([{ message: 'the top level must be a mapping' }]);
  const found = unmergeable(value);
  return found.length === 0 ? { value } : faults(found);
}

/**
 * The keys that the merge cannot hold (D4). `json-merge-patch` stops merging
 * a mapping at `__proto__`, `constructor` or `prototype`, so the key and each
 * key after it are lost. It deletes a key after a call to
 * `target.hasOwnProperty(key)`, which throws a TypeError when the target has
 * a key `hasOwnProperty`.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty']);

/**
 * Each part of `value` that no merge or check can take:
 *
 *   - a cycle, at path `''`: a YAML alias inside the node that it names
 *     (`a: &x { b: *x }`). An alias used twice side by side is no cycle.
 *   - a mapping key in `RESERVED_KEYS`, at the key's path.
 *
 * @param {unknown} value
 * @param {string} [path]  the JSON pointer of `value`
 * @param {Set<object>} [ancestors]
 * @returns {{ path: string, message: string }[]}
 */
function unmergeable(value, path = '', ancestors = new Set()) {
  if (value === null || typeof value !== 'object') return [];
  if (ancestors.has(value)) return [{ path: '', message: 'an alias refers to a node that holds it' }];
  ancestors.add(value);
  const found = Object.entries(value).flatMap(([key, child]) => {
    const at = `${path}/${pointerToken(key)}`;
    // A reserved key is a fault, and the check goes on below it.
    const reserved = isMapping(value) && RESERVED_KEYS.has(key);
    return [
      ...(reserved ? [{ path: at, message: `the key ${key} is reserved: the merge cannot hold it` }] : []),
      ...unmergeable(child, at, ancestors),
    ];
  });
  ancestors.delete(value);
  return found;
}
