/**
 * fail-renames.js — preloaded into a `bl` process with
 * `NODE_OPTIONS=--import=<this file>`. `BL_TEST_FAIL_RENAMES` is a comma list
 * of `<file name>:<n>`: the n-th rename onto a file of that name (the last
 * step of `atomicWriteFile`) throws, and the file keeps what it held. So a
 * test can fail a write and then the write that would undo it.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const fail = new Set(
  String(process.env.BL_TEST_FAIL_RENAMES ?? '')
    .split(',')
    .filter(Boolean),
);
const seen = new Map();
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const name = basename(String(to));
  const n = (seen.get(name) ?? 0) + 1;
  seen.set(name, n);
  if (fail.has(`${name}:${n}`)) throw new Error(`injected failure of rename ${n} onto ${name}`);
  return rename(from, to);
};
syncBuiltinESMExports();
