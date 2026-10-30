/**
 * done-faults.js — faults injected into a `bl done` process, preloaded with
 * `NODE_OPTIONS=--import=<this file>`.
 *
 * `BL_DONE_FAULT` picks one:
 *
 * - `partial`: every write of the spec `BL_DONE_FAULT_TARGET` (or its
 *   staging file) writes ten bytes and throws ENOSPC (`partial-write.js`).
 * - `race`: the transcript read (`ClaudeProvider.getTokens`) starts a second
 *   process that adds `{ input: 5 }` under `implement` to
 *   `BL_DONE_FAULT_TARGET` (`accumulateStepTokensOnFile`), waits 300 ms so
 *   that writer is waiting on the spec lock, and returns `{ input: 15 }`.
 *   The writer then writes `BL_DONE_FAULT_OUT` with whether it wrote. Only
 *   the unit directory's read does this (its parent is the worktree root,
 *   `worktrees`, F-60 D3); a worktree has no transcripts.
 *
 * Only `bl done` processes are touched.
 */

import { spawn } from 'child_process';
import { basename, dirname } from 'path';
import { installPartialWrites } from './partial-write.js';
import { ClaudeProvider } from '../../src/agents/claude.js';

const fault = process.argv[2] === 'done' ? process.env.BL_DONE_FAULT : null;
const target = process.env.BL_DONE_FAULT_TARGET;

if (fault === 'partial') installPartialWrites(target);

if (fault === 'race') {
  const tokensUrl = new URL('../../src/tokens.js', import.meta.url).href;
  const root = process.env.BL_BACKLOG_DIR;
  const out = process.env.BL_DONE_FAULT_OUT;
  ClaudeProvider.prototype.getTokens = (dir) => {
    if (basename(dirname(dir)) !== 'worktrees') return null;
    const writer = `
      import { writeFileSync } from "fs";
      const { accumulateStepTokensOnFile } = await import(${JSON.stringify(tokensUrl)});
      const use = { input: 5, output: 0, cache_creation: 0, cache_read: 0 };
      const wrote = accumulateStepTokensOnFile(${JSON.stringify(root)}, ${JSON.stringify(target)}, "implement", use);
      writeFileSync(${JSON.stringify(out)}, JSON.stringify({ wrote }));`;
    spawn(process.execPath, ['--input-type=module', '-e', writer], {
      stdio: 'ignore',
      env: { ...process.env, NODE_OPTIONS: '' },
    }).unref();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    return { input: 15, output: 0, cache_creation: 0, cache_read: 0 };
  };
}
