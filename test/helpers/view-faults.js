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
 *
 * Only `bl view` processes are touched, and for `tty` the other verbs that
 * page through `showText` (`list`, `grep`, `tree`, `agents`).
 */

import fs from 'fs';
import { syncBuiltinESMExports } from 'module';

const faults = new Set(
  String(process.env.BL_VIEW_FAULT ?? '')
    .split(',')
    .filter(Boolean),
);
const view = process.argv[2] === 'view';
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
syncBuiltinESMExports();
