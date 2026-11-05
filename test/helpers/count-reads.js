/**
 * count-reads.js — a `node --import` hook that records every path a process
 * reads with `fs.readFileSync`, for tests that count how often a command
 * reads each file (F-77 D2: a unit file at most once per run).
 *
 * Inert unless `BL_COUNT_READS` names a file: then, at exit, the process
 * appends one JSON line `{ pid, reads }` to it, `reads` being every string
 * path read, in order. Load it through `NODE_OPTIONS=--import=<file URL>` so
 * it is in place before bl's modules bind their `fs` imports
 * (`syncBuiltinESMExports` carries the patch to ESM named imports too).
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const out = process.env.BL_COUNT_READS;
if (out) {
  const readFileSync = fs.readFileSync;
  const appendFileSync = fs.appendFileSync;
  const reads = [];
  fs.readFileSync = function countedReadFileSync(path, ...rest) {
    if (typeof path === 'string') reads.push(path);
    return readFileSync.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  process.on('exit', () => appendFileSync(out, `${JSON.stringify({ pid: process.pid, reads })}\n`));
}
