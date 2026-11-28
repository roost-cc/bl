/**
 * index.js — the Adapter interface and `ADAPTERS` (agents.md, "Adapters";
 * F-141 D3).
 *
 * Every agent CLI is reached through one interface. An adapter imports only
 * `lib/`: it gets the profile, the prompt text and the file paths as
 * arguments, never the configuration. F-141 registers `replay`; F-154 adds
 * `claude`, `codex` and `local`.
 */

import { replay } from './replay.js';

/**
 * @typedef {object} Profile  an entry of `config/agents.yaml` (D-498)
 * @property {'claude'|'codex'|'local'|'replay'} adapter
 * @property {string} [model]
 * @property {string[]} [args]  arguments after `bl`'s own (`profileCommand`)
 * @property {Record<string, string>} [env]  variables over `bl`'s environment
 */
/** @typedef {{ available: boolean, resets_at: string|null, message: string|null }} Capacity */
/** @typedef {{ input: number, output: number, cache_creation: number, cache_read: number }} Usage */
/**
 * @typedef {object} AgentRun
 * @property {Profile} profile
 * @property {string} prompt
 * @property {'headless'|'interactive'} mode
 * @property {string} schemaPath  the outcome schema the result must pass
 * @property {string} resultPath  where the agent writes its result
 * @property {string} cwd
 * @property {string|null} session  the session that `resume` continues
 * @property {string} unit  the work unit's id, for the name of the session's process scope
 * @property {(id: string) => Promise<void>} onSession
 */
/**
 * @typedef {object} Ended
 * @property {unknown} result  the parsed result, or `null` when there is none
 * @property {string|null} error  `null` with a result; else one line: the exit
 *   code and the last line of stderr, why the result could not be read, or why
 *   the session could not start
 * @property {Usage} usage  zeros when the adapter cannot read them
 */
/**
 * @typedef {object} Adapter
 * @property {(profile: Profile) => string[]} faults  faults of a profile, for example a model the agent cannot take
 * @property {(profile: Profile) => Promise<Capacity>} capacity
 * @property {(run: AgentRun) => Promise<Ended>} start  a new session; it calls
 *   `run.onSession(id)` as soon as it knows the id, before the agent can change anything,
 *   and never for a session that it knows cannot launch
 * @property {(run: AgentRun) => Promise<Ended>} resume  the session `run.session`
 */

/** @type {Readonly<Record<string, Adapter>>} Each built adapter, by its name in a profile. */
export const ADAPTERS = Object.freeze({ replay });

/**
 * The adapter of `profile`. Until F-154, a profile whose adapter is not built
 * is a crash when a step reaches it (F-141 D3).
 * @param {Profile} profile
 * @returns {Adapter}
 * @throws {Error} `the <adapter> adapter is not built yet`
 */
export function adapterOf(profile) {
  const adapter = ADAPTERS[profile.adapter];
  if (!adapter) throw new Error(`the ${profile.adapter} adapter is not built yet`);
  return adapter;
}
