/**
 * codex-capacity.js — read Codex's quota over `codex app-server` (F-64 D5).
 *
 * `codex app-server` speaks newline-delimited JSON-RPC on stdio. The read is
 * the three messages `~/codex-usage.py` sends: `initialize` (id 1),
 * `initialized` (a notification) and `account/rateLimits/read` (id 2), whose
 * result carries `rateLimitsByLimitId` and `rateLimits`. app-server is marked
 * `[experimental]` (0.164.0), so every failure here is a reason string, never
 * a crash: the caller turns it into an `unknown` capacity.
 *
 * Why a script run by `spawnSync` and not a `spawnSync` of app-server
 * itself: app-server exits when its stdin closes, before it answers a
 * request still waiting on the network (checked 2026-10-28, 0.164.0: given
 * all three messages and EOF it answers `initialize` and exits without the
 * rate limits), so it must be held open until the answer comes. The adapter
 * interface is synchronous (`capacity()`, like `spawn()` and the loop), so
 * `CodexProvider.capacity()` runs this file with `spawnSync` and a timeout
 * a little past this one's, and this file runs the conversation
 * asynchronously, kills app-server on every exit path, and prints one JSON
 * line: `{ "ok": true, "result": {...} }` or `{ "ok": false, "error": "..." }`.
 *
 * Usage: node codex-capacity.js [--timeout <ms>]
 */

import { spawn } from 'child_process';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';

/** How long the whole read may take before it is abandoned (D5: 20 s). */
export const CODEX_CAPACITY_TIMEOUT_MS = 20_000;

// Between SIGTERM and SIGKILL when app-server is stopped.
const KILL_GRACE_MS = 2_000;

/**
 * Ask `command app-server` for the account's rate limits. Resolves with the
 * `account/rateLimits/read` result; rejects with an Error whose message is
 * the reason (the command is missing, it exited first, it replied with a
 * JSON-RPC error, the deadline passed). app-server is stopped before the
 * promise settles, whatever the outcome.
 *
 * @param {{ command?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<object>}
 */
export async function readCodexRateLimits({ command = 'codex', timeoutMs = CODEX_CAPACITY_TIMEOUT_MS } = {}) {
  const child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise((resolve) => child.once('close', resolve));
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const pending = new Map();
      let buffer = '';
      const fail = (message) => {
        for (const p of pending.values()) p.reject(new Error(message));
        pending.clear();
        reject(new Error(message));
      };
      const request = (id, method, params) =>
        new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          send({ id, method, ...(params ? { params } : {}) });
        });
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      timer = setTimeout(() => fail(`codex app-server did not answer within ${timeoutMs / 1000}s`), timeoutMs);
      child.once('error', (error) => fail(`codex app-server could not start: ${error.message}`));
      // A write to an app-server that already exited; its exit says why.
      child.stdin.on('error', () => {});
      child.once('close', (code, signal) =>
        fail(
          `codex app-server exited before returning usage (${signal ? `signal ${signal}` : `exit ${code}`}); try: codex login status`,
        ),
      );
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          const p = message && pending.get(message.id);
          if (!p) continue;
          pending.delete(message.id);
          if (message.error) p.reject(new Error(`codex app-server: ${message.error.message ?? 'request failed'}`));
          else p.resolve(message.result ?? {});
        }
      });
      (async () => {
        await request(1, 'initialize', { clientInfo: { name: 'bl', version: '1.0.0' } });
        send({ method: 'initialized', params: {} });
        resolve(await request(2, 'account/rateLimits/read'));
      })().catch((error) => fail(error.message));
    });
  } finally {
    clearTimeout(timer);
    // A command that never started has no process to stop.
    if (child.pid != null && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      const grace = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      await exited;
      clearTimeout(grace);
    }
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const i = process.argv.indexOf('--timeout');
  const timeoutMs = i >= 0 ? Number(process.argv[i + 1]) : CODEX_CAPACITY_TIMEOUT_MS;
  let out;
  try {
    out = {
      ok: true,
      result: await readCodexRateLimits({ timeoutMs: timeoutMs > 0 ? timeoutMs : CODEX_CAPACITY_TIMEOUT_MS }),
    };
  } catch (error) {
    out = { ok: false, error: error.message };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
