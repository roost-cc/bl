/**
 * next.js — `bl next`: the next feature by the operator's feature order
 * (F-53 D3).
 *
 *   bl next [--theme <slug>] [--epic E<nn>]
 *
 * stdout: the first feature in `feature-order.md`'s `ranked:` that matches
 * every filter given, or nothing. stderr: the matching ranked list (position,
 * id, title, theme, epic, why), or, when nothing ranked matches, the matching
 * features not yet ranked. The order is a preference (B2): this reads the
 * feature order and the features, never the roadmap. The story picker is
 * `bl what-next`.
 */

import { loadConfig, parseArgs, info } from './config.js';
import { filterFromArgs, filterLabel, featureEpicId } from './filter.js';
import { readFeatureOrder, rankedFeatures, unrankedFeatures, FEATURE_ORDER_FILE } from './feature-order.js';

const HELP = `Usage: bl next [--theme <slug>] [--epic <E-id>]

Print the next feature to run, by the operator's feature order: the first
feature in ${FEATURE_ORDER_FILE}'s "ranked:" that is not done or superseded and
matches every filter given.

Options:
  --theme <slug>   Only features in this theme
  --epic <E-id>    Only features of this epic

Output:
  stdout   The feature id (e.g. F-48), or nothing when no ranked feature
           matches.
  stderr   The matching ranked features (position, id, title, theme, epic,
           why); with none, the matching features not yet ranked.

Exit codes:
  0   Answered (stdout may be empty).
  1   Unknown theme or epic, a malformed filter, or a "ranked:" that is not
      a list of {feature, why} (run bl validate).

The order is a preference: depends_on overrides it. bl what-next picks the
next story by the dependency graph.`;

function describe(f) {
  const epic = featureEpicId(f);
  return `${f.id}  ${f.title}  [${f.theme || 'no theme'}${epic ? `, ${epic}` : ''}]`;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  for (const flag of ['feature', 'component']) {
    if (args[flag] != null) {
      console.error(`bl next: --${flag} is not a feature filter; use --theme or --epic`);
      process.exit(1);
    }
  }
  if (args.positional.length > 0) {
    console.error(`bl next: takes no arguments (got ${args.positional.join(' ')}); bl what-next picks a story`);
    process.exit(1);
  }

  const config = loadConfig();
  const { filter, ctx } = filterFromArgs(args, config, 'bl next');
  let order;
  try {
    order = readFeatureOrder(config);
  } catch (e) {
    console.error(`bl next: ${e.message}`);
    process.exit(1);
  }
  if (!order) info(`bl next: no ${FEATURE_ORDER_FILE} in the backlog, so no feature is ranked`);

  const scope = filterLabel(filter);
  const ranked = rankedFeatures(order, ctx.features, filter);
  if (ranked.length === 0) {
    const unranked = unrankedFeatures(order, ctx.features, filter);
    info(`No ranked feature${scope ? ` matches ${scope}` : ' is open'}.`);
    if (unranked.length > 0) {
      info(`Not yet ranked${scope ? ` (${scope})` : ''}:`);
      for (const f of unranked) info(`  ${describe(f)}`);
    }
    return;
  }
  info(`Ranked${scope ? ` (${scope})` : ''}:`);
  for (const r of ranked) info(`  ${r.position}. ${describe(r.feature)} — ${r.why}`);
  process.stdout.write(`${ranked[0].id}\n`);
}
