/**
 * fake-agent.js — a PATH on which every agent CLI bl can spawn (`claude`,
 * `codex`, `gemini`) is a stub that refuses: it prints an error result and
 * exits 1. `runBl` and `startBlBehindLock` put it first on every spawned
 * `bl`'s PATH (`withNoAgent`), so no test ever reaches a real agent through
 * a command that may start a session (`bl merge`'s resolution agent, F-36
 * D6). A test that calls such code in-process puts `noAgentEnv()` into its
 * own `process.env`.
 */

import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from './tempdir.js';

let stubDir;

/** The directory of refusing stubs, made once per test process. */
function agentStubDir() {
  if (stubDir) return stubDir;
  stubDir = mkTempDir('bl-no-agent-');
  for (const name of ['claude', 'codex', 'gemini']) {
    const bin = join(stubDir, name);
    writeFileSync(bin, `#!/bin/sh\necho '{"type":"result","is_error":true,"result":"no agent in tests"}'\nexit 1\n`);
    chmodSync(bin, 0o755);
  }
  return stubDir;
}

/** `{ PATH }` with the refusing stubs first. */
export function noAgentEnv() {
  return { PATH: `${agentStubDir()}:${process.env.PATH ?? ''}` };
}

/**
 * `env` with the refusing stubs first on its PATH. Applied after a caller's
 * own env, so a test that sets PATH (a failing `git` first, say) keeps its
 * tools and still gets the stubs.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withNoAgent(env) {
  return { ...env, PATH: `${agentStubDir()}:${env.PATH ?? ''}` };
}
