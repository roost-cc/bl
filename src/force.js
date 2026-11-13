/**
 * force.js — `bl force <id> <status>` (F-119 D1.3, D2, R5): move a story, a
 * feature or a story batch to any status of its type, past every transition
 * rule, hold and guard, terminal statuses included.
 *
 * It is the operator's emergency relief, so it needs a terminal: it refuses
 * under `BL_HEADLESS` or when stdin is not a terminal, before it prompts. It
 * takes the work unit lock (`unit-lock.js`), so it refuses while a live
 * session holds the unit. It prints what the move skips (`skipsOf`) and reads
 * one line; only the exact line `force <id> to <status>` writes the entry
 * `by: force` (`transition.js`) and commits the unit file. Under the backlog
 * lock it reads the unit's status and the skip list again: if either changed
 * while the operator typed, it writes nothing.
 */

import { relative } from 'path';
import { parseArgs } from 'node:util';
import { askLine } from './ask-line.js';
import { HEADLESS_ENV, isHeadless } from './agents/provider.js';
import { heldAt } from './blockers.js';
import { info, loadConfig } from './config.js';
import { loadFlow } from './flow.js';
import { withLock } from './lock.js';
import { reportBacklogCommit, syncAndCommit } from './sync.js';
import { resolveTargets } from './targets.js';
import { FORCE, failingGuards, guardRefusal, transition } from './transition.js';
import { flowKind, storyUnit } from './unit.js';
import { takeUnitLocks } from './unit-lock.js';

export const HELP = `Usage: bl force <id> <status>

Arguments:
  <id>                 A story (S-34), a feature (F-3) or a story batch (B-2)
  <status>             Any status of its type in flow.json, terminal ones
                       included (bl force S-34 in_progress reopens a done
                       story)

Options:
  --help               Show this help

The operator's way out of a stuck state (F-119 D2). bl force prints what the
move skips: that flow.json has no transition for it, each hold in
blockers.json on the status, and each failing "when" guard of the verbs that
have the transition. It then asks for the line "force <id> to <status>"; any
other input, an empty line or the end of input changes nothing and exits 1.
On the exact line it records the status in the unit's transition log as
"by: force" and commits the unit file ("chore: force <id> to <status>"). A
move out of done or superseded removes "completed:". If the unit's status or
what the move skips changed after the list was shown (a hold added while you
typed), it writes nothing, prints the new list and exits 1.

It needs a terminal: it refuses under ${HEADLESS_ENV} or when stdin is not a
terminal, so a headless agent cannot force. It refuses while a live bl session
holds the unit's work unit lock, and it refuses a status the unit is at
already or that its type lacks.`;

/**
 * What a forced move of `unit` to `to` skips, one line each: that the type's
 * table has no transition from the unit's status to `to`, each hold in
 * `blockers.json` that keeps the unit (or a feature's stories) out of `to`
 * (`heldAt`), and each `when` guard that does not hold, of each verb that has
 * the transition. Empty when the move skips nothing.
 * @param {{ backlogRoot: string }} config
 * @param {{ id: string, kind?: string, status: string, indexPath: string }} unit
 * @param {string} to
 * @returns {string[]}
 */
export function skipsOf(config, unit, to) {
  const flow = loadFlow(config.backlogRoot);
  const kind = flowKind(unit);
  const verbs = [
    ...new Set(
      flow
        .edges(kind)
        .filter((e) => e.from === unit.status && e.to === to)
        .map((e) => e.by),
    ),
  ];
  const skips = [];
  if (verbs.length === 0) skips.push(`flow.json has no ${kind} transition from ${unit.status} to ${to}`);
  for (const { line } of heldAt(config, unit.id, to)) skips.push(`hold: ${line}`);
  const ctx = { config, id: unit.id, indexPath: unit.indexPath };
  for (const verb of verbs) {
    for (const when of failingGuards(flow, flow.verbOf(kind, verb).when, ctx)) {
      skips.push(`guard: ${guardRefusal(unit.id, verb, when)}`);
    }
  }
  return skips;
}

/** The skip list's one line when the move skips nothing. */
const NOTHING_SKIPPED = 'nothing: flow.json has the transition, and no hold or guard refuses it';

/** Print `message` on stderr and return the exit code 1. */
function refuse(message) {
  console.error(`bl force: ${message}`);
  return 1;
}

/**
 * The target as a unit with its status read now: a story through
 * `storyUnit`, a feature or a batch as its record.
 */
function unitOf(target, config) {
  if (target.kind === 'story') return storyUnit(target.record, config);
  return { ...target.record, kind: target.kind };
}

/**
 * `bl force <id> <status>`. Returns the exit code.
 * @param {string[]} argv
 * @param {{ interactive?: boolean, readLine?: (question: string) => Promise<string>,
 *   env?: NodeJS.ProcessEnv }} [io]  `interactive`: stdin is a terminal;
 *   `readLine`: asks the question and reads one line (`askLine`)
 * @returns {Promise<number>}
 */
export async function main(
  argv,
  { interactive = process.stdin.isTTY === true, readLine = askLine, env = process.env } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  } catch (err) {
    return refuse(`${err.message}\n${HELP.split('\n')[0]}`);
  }
  if (parsed.values.help) {
    console.log(HELP);
    return 0;
  }
  const [rawId, to, ...rest] = parsed.positionals;
  if (!rawId || !to || rest.length > 0) return refuse(`give one id and one status\n${HELP.split('\n')[0]}`);
  if (isHeadless(env)) {
    return refuse(
      `${HEADLESS_ENV} is set: this is an agent bl started headless, and only the operator forces a move. ` +
        `Nothing was written. Say what should move and why in a task for the operator instead.`,
    );
  }
  if (!interactive) return refuse('stdin is not a terminal; run bl force in a terminal. Nothing was written.');

  const config = loadConfig();
  const { targets, errors } = resolveTargets([rawId], config, null);
  if (errors.length > 0) return refuse(errors.join('\n'));
  const [target] = targets;
  if (target.kind === 'component') return refuse(`${target.id} is a component: a code boundary with no status.`);
  const unit = unitOf(target, config);
  const kind = flowKind(unit);
  const statuses = loadFlow(config.backlogRoot).statusesOf(kind);
  if (!statuses.includes(to)) {
    return refuse(`${to} is not a ${kind} status (flow.json ${kind} statuses: ${statuses.join(', ')}).`);
  }
  if (unit.status === to) return refuse(`${unit.id} is ${to} already; nothing to force.`);

  const lock = takeUnitLocks(config, [unit], `force ${unit.id}`);
  if (lock.refused != null) return refuse(lock.refused);
  try {
    const skips = skipsOf(config, unit, to);
    info(`bl force ${unit.id}: ${unit.status} → ${to}. The move skips:`);
    const shown = (list) => (list.length > 0 ? list : [NOTHING_SKIPPED]);
    for (const line of shown(skips)) info(`  - ${line}`);
    const confirmation = `force ${unit.id} to ${to}`;
    const answer = await readLine(`Type "${confirmation}" to force it; anything else cancels: `);
    if (answer !== confirmation) {
      info('Cancelled. Nothing was written.');
      return 1;
    }
    const root = config.backlogRoot;
    const res = await withLock(root, async () => {
      // The operator confirmed the list shown. A hold, a guard, flow.json or
      // the unit's status may have changed while they typed: then write nothing.
      const now = unitOf(target, config);
      const again = now.status === unit.status ? skipsOf(config, now, to) : null;
      if (again == null || again.join('\n') !== skips.join('\n')) return { changed: again };
      await transition(root, unit, to, { by: FORCE });
      return syncAndCommit(config, {
        message: `chore: force ${unit.id} to ${to}`,
        extraPaths: [relative(root, unit.indexPath)],
      });
    });
    if (Object.hasOwn(res ?? {}, 'changed')) {
      const what = res.changed == null ? [`${unit.id} is no longer ${unit.status}`] : shown(res.changed);
      return refuse(
        `what the move skips changed after the list was shown; nothing was written. Run bl force again.\n` +
          what.map((line) => `  - ${line}`).join('\n'),
      );
    }
    info(`${unit.id} is ${to} (by: force).`);
    reportBacklogCommit(res, 'bl force');
    return 0;
  } finally {
    lock.release();
  }
}
