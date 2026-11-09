/**
 * local.js — the `local` adapter (S-1371): Claude Code against a local model
 * server that speaks the Anthropic Messages API (llama-server).
 *
 * LocalProvider is ClaudeProvider with three changes. spawnEnv() points
 * `claude` at the server named by `backlog.json`'s top-level `local` key
 * (`localSpawnEnv`). checkConfiguration() refuses a configuration with no
 * model (the server's alias) and a backlog whose `local` key is missing,
 * wrong, or set in a repo's `overrides` (`checkLocalConfiguration`).
 * capacity() asks the server's `/health` (`localServerCapacity`). The CLI, its
 * arguments, the permissions, the hooks and the JSON result are claude's.
 *
 * The class itself is in claude.js, below ClaudeProvider, and this file
 * exports it. A class here would extend ClaudeProvider while this file loads,
 * and a module that imports claude.js first reaches this file through
 * config.js and the registry before ClaudeProvider exists ("Cannot access
 * 'ClaudeProvider' before initialization"). A re-export reads nothing while
 * it loads.
 */

import { fileURLToPath } from 'url';
import { isPlainObject } from '../config.js';
import { runCapacityHelper } from './capacity-helper.js';
import { LOCAL_CAPACITY_TIMEOUT_MS } from './local-capacity.js';
import { agentEnv } from './provider.js';

export { LocalProvider } from './claude.js';

// The script that asks the server's /health (see its JSDoc).
const CAPACITY_HELPER = fileURLToPath(new URL('./local-capacity.js', import.meta.url));

/** The `local` key's keys, each a required non-empty string. */
const LOCAL_KEYS = ['url', 'token'];

/** The `local` key as an error message shows it. */
const LOCAL_SHAPE = '"local": { "url": "http://localhost:8090", "token": "local" }';

/** A capacity reading of the local server: `account`-scoped, never an `until`. */
const reading = (state, message) => ({ state, scope: 'account', until: null, windows: [], message });

/**
 * `backlog.json`'s top-level `local` key as `{ url, token }`. Throws a
 * message that names the key and shows its shape when the key is missing,
 * is not an object, has another key, or has a key that is not a non-empty
 * string. There are no defaults.
 * @param {object} topLevel — `backlog.json`'s top level
 * @returns {{ url: string, token: string }}
 */
export function localServer(topLevel) {
  const at = 'backlog.json "local"';
  if (!isPlainObject(topLevel) || !Object.hasOwn(topLevel, 'local')) {
    throw new Error(`${at} is missing: the local provider needs its server, ${LOCAL_SHAPE}`);
  }
  const value = topLevel.local;
  if (!isPlainObject(value)) throw new Error(`${at} must be an object, ${LOCAL_SHAPE}`);
  const unknown = Object.keys(value).filter((k) => !LOCAL_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${at} has an unknown key "${unknown[0]}" (allowed: ${LOCAL_KEYS.join(', ')})`);
  }
  for (const key of LOCAL_KEYS) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new Error(`${at} "${key}" must be a non-empty string, ${LOCAL_SHAPE}`);
    }
  }
  return { url: value.url, token: value.token };
}

/**
 * The environment that points `claude` at the local server: `base` with
 * `ANTHROPIC_BASE_URL` set to `url` and `ANTHROPIC_AUTH_TOKEN` to `token`.
 * `ANTHROPIC_API_KEY` is the empty string, so the operator's real key never
 * reaches the local server. `ANTHROPIC_SMALL_FAST_MODEL` is `model`, so
 * Claude Code's side requests also go to the server's model. Pure.
 * @param {{ url: string, token: string, model: string,
 *   base: Record<string, string|undefined> }} opts
 */
export function localEnv({ url, token, model, base }) {
  return {
    ...base,
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_SMALL_FAST_MODEL: model,
  };
}

/**
 * The capacity (provider.js `capacity()`) the helper's answer `out` means,
 * for the server at `url`. A 200 is `available`. A refused connection is
 * `unavailable` with no `until`: nothing listens, and bl does not start the
 * server. Any other answer, a timeout or another failure is `unknown`. A
 * record of another shape (no boolean `ok`, or `ok: true` with no integer
 * `status`) is `unknown` too, so only `ok: false` with `code: "ECONNREFUSED"`
 * skips the configuration. Every answer is `account`-scoped and its message
 * names `url`.
 * @param {unknown} out
 * @param {string} url
 * @returns {ReturnType<import("./provider.js").AgentProvider["capacity"]>}
 */
export function localCapacity(out, url) {
  const malformed = !isPlainObject(out) || typeof out.ok !== 'boolean' || (out.ok && !Number.isInteger(out.status));
  if (malformed) return reading('unknown', `local server ${url}: the health check gave no answer`);
  if (out.ok && out.status === 200) return reading('available', `local server ${url} is up`);
  if (out.ok) {
    return reading('unknown', `local server ${url}: /health answered ${out.status}`);
  }
  if (out.code === 'ECONNREFUSED') {
    return reading('unavailable', `local server ${url} refused the connection: start the server`);
  }
  if (out.code === 'TIMEOUT') return reading('unknown', `local server ${url}: /health did not answer in time`);
  const error = typeof out.error === 'string' && out.error !== '' ? out.error : 'the health check failed';
  return reading('unknown', `local server ${url}: ${error}`);
}

/**
 * LocalProvider.checkConfiguration(): a local configuration names the
 * server's model alias, and the backlog's top level names the server.
 * `spawn()` knows the backlog but not the repo, so a repo's `overrides` may
 * not set `local`: `mergeConfig` copies the top level's object unless they do.
 * @param {{ model: string|null }} configuration
 * @param {{ topLevel: object, raw: object }} ctx
 * @returns {string|null}
 */
export function checkLocalConfiguration({ model }, { topLevel, raw }) {
  if (model == null) {
    return 'a local configuration needs a "model": the server\'s alias (llama-server --alias), e.g. { "agent": "local", "model": "qwen3.8-27b" }';
  }
  try {
    localServer(topLevel);
  } catch (error) {
    return error.message;
  }
  if (raw.local !== topLevel.local) {
    return 'a repo\'s "overrides" set "local": bl reads backlog.json "local" from the top level only';
  }
  return null;
}

/**
 * LocalProvider.spawnEnv(): claude's environment (`agentEnv`) over
 * `localEnv`, with the server that `topLevel` names. `topLevel` is the
 * `backlog.json` top level of the config the caller loaded, so the server is
 * the one that load checked. A later load, a rejected load or an edit of
 * `backlog.json` does not change it, and nothing reads `backlog.json` again.
 * Throws `localServer`'s message when `topLevel` names no server.
 * @param {{ headless: boolean, backlogRoot: string|null, model: string, topLevel: object|null }} opts
 */
export function localSpawnEnv({ headless, backlogRoot, model, topLevel }) {
  const { url, token } = localServer(topLevel);
  return agentEnv({ headless, backlogRoot, base: localEnv({ url, token, model, base: process.env }) });
}

/**
 * LocalProvider.capacity(): whether the server that `topLevel` names (the
 * caller's loaded config, as for `localSpawnEnv`) answers its `/health`
 * within `timeoutMs`, asked by `local-capacity.js` through
 * `runCapacityHelper` and mapped by `localCapacity()`. Never throws: a
 * `topLevel` that names no server is `unknown` with `localServer`'s message.
 * `run`, `env` and `timeoutMs` are for tests.
 */
export function localServerCapacity({ topLevel, run, env, timeoutMs = LOCAL_CAPACITY_TIMEOUT_MS } = {}) {
  let url;
  try {
    url = localServer(topLevel).url;
  } catch (error) {
    return reading('unknown', error.message);
  }
  const { out, reason } = runCapacityHelper(CAPACITY_HELPER, ['--url', url, '--timeout', String(timeoutMs)], {
    run,
    env,
    timeoutMs,
  });
  if (!out) return reading('unknown', `local server ${url}: the health check failed (${reason})`);
  return localCapacity(out, url);
}
