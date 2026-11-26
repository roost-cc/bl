/**
 * args.js — an `args` map to `add_argument` calls (F-138 D3).
 *
 * The one place that does this: for an op's declared arguments now, and for a
 * flow entry's `args:` in F-139 (D-424).
 */

/**
 * Add each argument of `args` to `parser`.
 * @param {import('argparse').ArgumentParser} parser
 * @param {Record<string, Record<string, unknown>>} args  the option as it is
 *   typed (`--limit`, or a positional's name) → the options of `add_argument`
 */
export function addArgs(parser, args) {
  for (const [name, options] of Object.entries(args)) parser.add_argument(name, { ...options });
}
