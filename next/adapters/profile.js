/**
 * profile.js — the one rule by which a profile changes an agent's command
 * line (agents.md, "Agent profiles", D-498; F-141 D3).
 *
 * A profile's `args` come after `bl`'s own arguments, and its `env` goes over
 * `bl`'s environment. So a profile adds to what `bl` passes and cannot remove
 * it. Every adapter builds its command line through `profileCommand`, and
 * adds the profile's `model` in its own CLI's form.
 */

/** @typedef {import('./index.js').Profile} Profile */

/**
 * The arguments and environment of an agent command: `base`, `bl`'s own
 * arguments, then the profile's `args`; `process.env` with the profile's
 * `env` over it.
 * @param {readonly string[]} base
 * @param {Pick<Profile, 'args'|'env'>} profile
 * @returns {{ args: string[], env: NodeJS.ProcessEnv }}
 */
export function profileCommand(base, profile) {
  return { args: [...base, ...(profile.args ?? [])], env: { ...process.env, ...profile.env } };
}
