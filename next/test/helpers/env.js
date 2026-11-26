/**
 * env.js — run a function with some environment variables set (F-136 S-1593).
 *
 * Copied from `withEnv` in `test/helpers/fake-pagers.js`, because no file of
 * `next/` imports a file outside `next/` (F-135 D3).
 */

/**
 * Run `fn` with `vars` set in `process.env`, then put back what was there.
 * A value of `undefined` unsets the variable.
 * @template T
 * @param {Record<string, string|undefined>} vars
 * @param {() => T} fn
 * @returns {T}
 */
export function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    for (const [k, v] of Object.entries(vars)) set(k, v);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) set(k, v);
  }
}
