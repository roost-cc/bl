/**
 * fake-pager.js — a fake pager for the pager tests (F-138 D8).
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from './tempdir.js';

/**
 * A fake pager named `name` in a new directory: a node script that copies its
 * stdin to `<script>.in` and its `LESS` (or `<unset>`) to `<script>.less`.
 * It needs nothing from `PATH`. `input()` and `less()` read the copies, `null`
 * when the pager did not run.
 * @param {string} name
 * @returns {{ dir: string, script: string, input: () => string|null, less: () => string|null }}
 */
export function fakePager(name) {
  const dir = mkTempDir('bl-pager-');
  const script = join(dir, name);
  const body = [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(`${script}.in`)}, fs.readFileSync(0));`,
    `fs.writeFileSync(${JSON.stringify(`${script}.less`)}, process.env.LESS ?? '<unset>');`,
  ].join('\n');
  writeFileSync(script, `${body}\n`);
  chmodSync(script, 0o755);
  const read = (suffix) => (existsSync(`${script}${suffix}`) ? readFileSync(`${script}${suffix}`, 'utf8') : null);
  return { dir, script, input: () => read('.in'), less: () => read('.less') };
}
