/**
 * token-writer.js — a token write in another process that is mid-way when
 * the code under test writes the same spec.
 *
 * `startTokenWriter(backlogRoot, indexPath, step)` spawns a process that,
 * through `updateSpecFile`, reads the spec under its spec lock, then holds
 * the lock for `holdMs` before it adds `{ input: 7 }` under `tokens_by_step[step]`
 * and writes. It returns once that process has read the spec, so a write the
 * caller starts next overlaps it: without the lock, the token writer would
 * write its stale read over the caller's change. `done` resolves with the
 * writer's exit code.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from './tempdir.js';

/**
 * @param {string} backlogRoot
 * @param {string} indexPath
 * @param {string} step
 * @param {{ holdMs?: number }} [opts]
 * @returns {{ done: Promise<number | null> }}
 */
export function startTokenWriter(backlogRoot, indexPath, step, { holdMs = 500 } = {}) {
  const marker = join(mkTempDir('bl-token-writer-'), 'read');
  const specUrl = new URL('../../src/spec-file.js', import.meta.url).href;
  const tokensUrl = new URL('../../src/tokens.js', import.meta.url).href;
  const writer = `
    import { writeFileSync } from "fs";
    const { updateSpecFile } = await import(${JSON.stringify(specUrl)});
    const { addStepUsageToFrontmatter } = await import(${JSON.stringify(tokensUrl)});
    updateSpecFile(${JSON.stringify(backlogRoot)}, ${JSON.stringify(indexPath)}, (fm) => {
      writeFileSync(${JSON.stringify(marker)}, "");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
      addStepUsageToFrontmatter(fm, ${JSON.stringify(step)}, { input: 7, output: 0, cache_creation: 0, cache_read: 0 });
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', writer], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const done = new Promise((res) => child.on('exit', (code) => res(code)));
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('the token writer never read the spec');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return { done };
}
