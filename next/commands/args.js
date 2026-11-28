/**
 * args.js — an `args` map to `add_argument` calls (F-138 D3).
 *
 * The one place that does this: for an op's declared arguments, and for a
 * flow entry's `args:` (D-424, F-152 D6), whose `sets` and `steps` are `bl`'s
 * and not `add_argument`'s, so they are removed first (F-152 D4).
 */

/**
 * Add each argument of `args` to `parser`, and give the name under which
 * `argparse` stores each one's value (its `dest`).
 * @param {import('argparse').ArgumentParser} parser
 * @param {Record<string, Record<string, unknown>>} args  the option as it is
 *   typed (`--limit`, or a positional's name) → the options of `add_argument`,
 *   with an entry option's `sets` and `steps`
 * @returns {Record<string, string>} the option as it is typed → its `dest`
 */
export function addArgs(parser, args) {
  return Object.fromEntries(
    Object.entries(args).map(([name, { sets: _sets, steps: _steps, ...options }]) => [
      name,
      parser.add_argument(name, options).dest,
    ]),
  );
}
