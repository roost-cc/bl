/**
 * view-faults.js — faults injected into a `bl view` process, preloaded with
 * `NODE_OPTIONS=--import=<this file>`.
 *
 * `BL_VIEW_FAULT` picks them (comma-separated):
 *
 * - `tty`: stdout reads as a terminal (`isTTY` true, `rows` unset, so 24), so
 *   bl takes the editor path although the test captures stdout in a file.
 * - `chmod`: making the copy read-only throws, so bl falls back to showing the
 *   file (`showText`).
 * - `rm`: removing the copy's `bl-view-*` temp directory throws.
 * - `renames`: each rename into a `bl-view-*` directory (the first copy, then
 *   each refresh) appends its target to the file `BL_VIEW_RENAME_LOG` names.
 * - `rename`: each rename into a `bl-view-*` directory after the first (each
 *   refresh, not the first copy) throws `injected rename failure`.
 *
 * Only `bl view` and `bl change` processes are touched (they share the viewer,
 * `showReadOnly`), and for `tty` the other verbs that page through `showText`
 * (`list`, `grep`, `tree`, `agents`).
 */

import fs from 'fs';
import { syncBuiltinESMExports } from 'module';

const faults = new Set(
  String(process.env.BL_VIEW_FAULT ?? '')
    .split(',')
    .filter(Boolean),
);
const view = ['view', 'change'].includes(process.argv[2]);
const pages = view || ['list', 'grep', 'tree', 'agents'].includes(process.argv[2]);

if (pages && faults.has('tty')) {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true });
}

if (view && faults.has('chmod')) {
  fs.chmodSync = () => {
    throw new Error('injected chmod failure');
  };
}
if (view && faults.has('rm')) {
  const rm = fs.rmSync;
  fs.rmSync = (path, ...rest) => {
    if (/\/bl-view-[^/]+$/.test(String(path))) throw new Error('injected rm failure');
    return rm(path, ...rest);
  };
}
if (view && (faults.has('renames') || faults.has('rename'))) {
  const rename = fs.renameSync;
  const append = fs.appendFileSync;
  let placed = 0;
  fs.renameSync = (from, to) => {
    if (/\/bl-view-[^/]+\//.test(String(to))) {
      placed += 1;
      if (faults.has('renames')) append(process.env.BL_VIEW_RENAME_LOG, `${to}\n`);
      if (faults.has('rename') && placed > 1) throw new Error('injected rename failure');
    }
    return rename(from, to);
  };
}
syncBuiltinESMExports();
