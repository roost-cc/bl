/**
 * run-arg.js — the arguments of a verb that names one run: `bl <verb>
 * <F-id|B-id|S-id> [--<flag>…]`. `bl watch` and `bl stop` read theirs here:
 * `bl run` runs a feature, a story batch (F-125 D1) or a story.
 */

import { normalizeId, parseArgs } from './config.js';
import { normalizeFeatureId } from './feature.js';
import { normalizeBatchId } from './batch.js';

/**
 * Parse `argv` for `bl <verb>`. With `--help`, print `help` and return null.
 * An unknown option, no run or more than one, or an id that is no feature,
 * story batch or story id prints why and exits 1. Else return the run's id and the parsed
 * arguments.
 *
 * @param {string} verb
 * @param {string[]} argv
 * @param {{ help: string, flags?: string[] }} opts  `flags`: the options the verb takes
 * @returns {{ id: string, args: Record<string, unknown> } | null}
 */
export function runArgs(verb, argv, { help, flags = [] }) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(help);
    return null;
  }
  const unknown = Object.keys(args).filter((k) => !['positional', ...flags].includes(k));
  if (unknown.length > 0) {
    console.error(`bl ${verb}: unknown option --${unknown[0]}`);
    process.exit(1);
  }
  if (args.positional.length !== 1) {
    console.error(`bl ${verb}: name one run: bl ${verb} <F-id|B-id|S-id>`);
    process.exit(1);
  }
  const raw = args.positional[0];
  const id = normalizeFeatureId(raw)?.id ?? normalizeBatchId(raw)?.id ?? normalizeId(raw)?.id;
  if (!id) {
    console.error(`bl ${verb}: ${raw} is not a feature, story batch or story id`);
    process.exit(1);
  }
  return { id, args };
}
