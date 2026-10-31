/**
 * verbs.js — the id-dispatched verbs.
 *
 *   bl run|implement|review|merge|refine|status|approve|done <id...>
 *
 * Each id resolves to a story, a feature or a component (targets.js), and the verb
 * calls that kind's handler (F-35 Design §1). `bl status` with no arguments at
 * all has no target: it lists the open stories by status (list.js).
 *
 * Several ids (Design §5): `run` and `implement` start only the units that
 * neither depend on nor overlap another (schedule.js) and list the rest first;
 * `run` and `review` run each unit as a child `bl <verb> <id>` with its output
 * in `.bl/run/<id>.out`; `implement` opens a tmux window per unit; `merge`
 * goes in dependency order and stops at the first failure; `refine`,
 * `status`, `approve` and `done` take each target on its own.
 */

import { spawn, spawnSync } from 'child_process';
import { closeSync, openSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, parseArgs, info, openTmuxWindow } from './config.js';
import { readAllStories } from './story.js';
import { classifyId, resolveTargets } from './targets.js';
import { schedule, dependencyOrder, byId } from './schedule.js';
import { heldBy, readBlockers, readUnits } from './blockers.js';
import { RUN_DIR, ensureRunDir, escalationOpen } from './feature-run.js';
import { changeNextVerb, currentChange } from './change-doc.js';

const BL_PATH = fileURLToPath(new URL('./bl.js', import.meta.url));

/**
 * What each verb does with each kind of target. A cell starting `./` names
 * the module whose `main(argv)` is today's story command; any other cell is a
 * handler exported by feature-cmd.js, called with `(args, config, record)`:
 * the feature handlers, and the story handlers that run a story through the
 * feature loop. null: targets.js refuses the kind.
 */
export const DISPATCH = {
  run: { story: 'cmdRunStory', feature: 'cmdRun', component: null },
  implement: { story: './workon.js', feature: 'cmdWorkon', component: null },
  review: { story: 'cmdReviewStory', feature: 'cmdReview', component: null },
  merge: { story: './cleanup.js', feature: 'cmdMerge', component: null },
  refine: { story: './refine.js', feature: 'cmdRefine', component: './refine.js' },
  status: { story: 'cmdStatusStory', feature: 'cmdStatus', component: 'cmdStatusComponent' },
  approve: { story: null, feature: 'cmdApprove', component: null },
  done: { story: './done.js', feature: null, component: null },
};

export const VERBS = Object.keys(DISPATCH);

/** The verbs whose story handler once took `--repo` (F-52 D1 removed it). */
const STORY_REPO_REFUSED = new Set(['run', 'implement', 'review', 'merge']);

/** The verbs whose feature handler once took `--repo` (F-52 D3 removed it). */
const FEATURE_REPO_REFUSED = new Set(['run', 'implement']);

export const NEED_TMUX =
  'several targets need tmux: start a tmux session and rerun this, or run them one at a time, or use run';

const VERB_HELP = {
  run: `Usage: bl run <id...> [options]

Arguments:
  <id...>              Features (F-3), or refined stories (S-34), each of
                       which goes through the same loop on its own branch. A
                       story that belongs to a feature is refused (run the
                       feature). A component is refused: make its stories a
                       feature.

Options:
  --resume             Continue from the saved run state
  --interactive        Attach each session instead of running it headless
                       (one target)
  --plan               Print the steps and exit
  --max-rounds <n>     Review-round cap for this run
  -A, --agent <id>     Agent provider; replaces backlog.json's agent list
                       (no model), not review_agent
  --help               Show this help

No --repo: a story's repo is its component's, and a feature prepares every
repo of its stories, bl first, then by first story in dependency order, and
starts in the first.

The autonomous loop: implement, test gate, self-review, one PR, review → fix →
re-review until clean or the round cap escalates. Stops before merge.

Several targets: a target that depends on another target, or on a story that
is not done, waits; so does one whose files overlap a lower-numbered target's.
The waiting ones are listed first. The rest run in parallel, each as a child
bl run with its output in .bl/run/<id>.out, and one line per target is printed
when all are done. Exits 1 if any failed or escalated.`,
  implement: `Usage: bl implement <id...> [options]

Arguments:
  <id...>              Features (F-3) or stories (S-34). A story that
                       belongs to a feature is refused (implement the
                       feature). A component is refused: make its stories a
                       feature.

Options:
  -A, --agent <id>     Agent provider
  -P, --prompt <text>  Discuss <text> with the agent first (one target)
  --help               Show this help

No --repo: a feature prepares every repo of its stories, as bl run does, and
starts in the first. Creates or resumes the worktree and opens an interactive agent session: the
manual single step. Use bl run for the whole loop. Several targets are
scheduled as bl run schedules them, and each started one opens in its own
tmux window.`,
  review: `Usage: bl review <id...> [options]

Arguments:
  <id...>              Stories (S-34) or features (F-3). A story that belongs
                       to a feature is refused (review the feature).

Options:
  -r, --repo <name>    Feature: restrict the review to one repo's PR.
                       Refused for a story: it has one repo
  -A, --agent <id>     Agent provider; replaces backlog.json's review_agent
                       list (no model)
  -P, --prompt <text>  Extra instructions for the review sessions
  --interactive        Attach each review session (one target)
  --help               Show this help

One review round, the step bl run takes: two dimension passes and a verifier
on the review agent over the open PR(s), one session in the Review Log, and
review_round up by one. Several targets are reviewed in parallel, each as a
child bl review with its output in .bl/run/<id>.out.`,
  merge: `Usage: bl merge <id...> [options]

Arguments:
  <id...>              Stories (S-34) or features (F-3). A story that belongs
                       to a feature is refused (merge the feature).

Options:
  --keep               Keep the branch after merging
  --switch-main        Switch a main checkout left on a merged side branch
                       back to main and continue
  --no-review          Merge work that was never reviewed; the change
                       document's ## Merge records the choice
  --help               Show this help

One gate set for stories and features: refused while the review is pending or
fixed or the latest Review Log session has an open Must or Should (open nits
pass), when the work was never reviewed (naming a PR the forge merged first)
unless --no-review, while ## Escalation is open, on a worktree on the branch in
a repo the work does not own, and when a main checkout is off main. Then merges
every repo's branch, marks the work done, syncs the backlog, closes PRs and
removes the worktrees. Several targets merge one at a time in dependency order,
stopping at the first that fails.`,
  refine: `Usage: bl refine <id...> [options]

Arguments:
  <id...>              A feature (F-3), or stories (S-34) and/or components
                       (C01). A component expands to its 'backlog' stories.

Options:
  -A, --agent <id>     Agent provider
  -P, --prompt <text>  Discuss <text> with the agent first (single target)
  -t                   Detach into a new tmux window
  --help               Show this help

Launches an agent session in the backlog repo to refine and plan the work.
Several stories go to one orchestrator session with a sub-agent each. With a
feature among the targets, each target opens in its own tmux window.`,
  status: `Usage: bl status [<id...>]

Arguments:
  [<id...>]            A feature (F-3): its stories in dependency order,
                       review state, blockers, deferred items, escalation and
                       run state. A story (S-34): its status, branch, PR,
                       review state and round, escalation and run state. A
                       component (C01): its open stories.

Options:
  --help               Show this help

With no id it lists the open stories, furthest along first as flow.json has it
(in_progress then refined then backlog by default), stack rank within each, in
the table bl list prints.`,
  approve: `Usage: bl approve <id...> [options]

Arguments:
  <id...>              Refined features (F-3). Stories have no approve step:
                       a refined story may run.

Options:
  --force              Approve a draft
  --no-sync            Skip the backlog sync
  --help               Show this help

The human gate before bl run. Refuses while ## Escalation is not "None.".`,
  done: `Usage: bl done [options] <story-id> [commit-hash]
       bl done [options] <id> <id...>

Arguments:
  <story-id>           Story ID (e.g. S34, S-34, s34)
  [commit-hash]        Short git hash (default: HEAD of primary repo)

Options:
  --commit <repo>=<sha>       Repeatable. Records a per-repo merge SHA map
                              (multi-repo stories). Cannot be combined with
                              the [commit-hash] positional.
  --superseded                Mark as superseded instead of done
  --help                      Show this help

A feature is refused: bl merge marks it done. A component has no status. Sets
the story's status and moves nothing; commits the backlog change on the
backlog's current branch. Several ids are marked one at a time.`,
};

/**
 * parseArgs, with the feature verbs' value-less flags released: parseArgs
 * would otherwise swallow a following positional (the id) as their value.
 */
function parseVerbArgs(argv) {
  const args = parseArgs(argv);
  for (const flag of ['resume', 'interactive', 'plan']) {
    if (typeof args[flag] === 'string') {
      args.positional.push(args[flag]);
      args[flag] = true;
    }
  }
  return args;
}

/**
 * The ids among the positionals. `bl done <id> [commit-hash]`: a second
 * positional that is not an id is the commit hash, and so is one that reads
 * as a short hash (`c123456` would otherwise be component C123456).
 */
function idsOf(verb, positional) {
  const isHash = (s) => /^[0-9a-f]{7,40}$/i.test(s) || !classifyId(s);
  if (verb === 'done' && positional.length === 2 && isHash(positional[1])) return positional.slice(0, 1);
  return positional;
}

/** `argv` without the positionals: the flags every per-target child gets. */
export function flagsOf(argv, positional) {
  const left = [...positional];
  return argv.filter((a) => {
    const i = left.indexOf(a);
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
}

/**
 * Run `verb` on the ids in `argv`. A story or component goes to today's story
 * command with `argv` untouched; a feature to its feature-cmd.js handler.
 * Several ids go through `dispatchSeveral`.
 *
 * @param {string} verb   one of VERBS
 * @param {string[]} argv the arguments after the verb
 */
export async function dispatch(verb, argv) {
  const args = parseVerbArgs(argv);
  if (args.help) {
    console.log(VERB_HELP[verb]);
    process.exit(0);
  }
  const ids = idsOf(verb, args.positional);
  if (ids.length === 0) {
    // Only a truly empty argv lists: a flag with no id stays a usage error.
    if (verb === 'status' && argv.length === 0) {
      const { listByStatus } = await import('./list.js');
      return listByStatus();
    }
    console.error(VERB_HELP[verb].split('\n')[0]);
    process.exit(1);
  }

  // -A replaces the review list on `bl review`, the implementing list on
  // every other verb (F-64 D2).
  const config = loadConfig({ agent: args.agent, agentRole: verb === 'review' ? 'review' : 'agent' });
  const { targets, errors, notices } = resolveTargets(ids, config, verb);
  for (const n of notices) info(n);
  for (const e of errors) console.error(e);
  if (errors.length > 0) process.exit(1);
  // A story has one repo, its component's (F-52 D1): no story verb takes --repo.
  if (targets.some((t) => t.kind === 'story') && STORY_REPO_REFUSED.has(verb)) {
    const { refuseStoryRepo } = await import('./story.js');
    refuseStoryRepo(verb, args);
  }
  // A feature's repos are its stories', and it starts in the lead (F-52 D3).
  if (
    targets.some((t) => t.kind === 'feature') &&
    FEATURE_REPO_REFUSED.has(verb) &&
    args.repo != null &&
    args.repo !== false
  ) {
    console.error(
      `bl ${verb}: unknown option "--repo" for a feature: it prepares every repo of its stories and starts in the first (bl, else its first story's).`,
    );
    process.exit(1);
  }

  // A target held at its `run` gate by an unmet edge does not start (F-66 D3).
  const held = GATED_VERBS.has(verb) ? heldTargets(verb, targets, config) : [];
  if (targets.length === 1 && held.length === 1) {
    for (const line of held[0].lines) console.error(line);
    for (const b of held[0].blockers) console.error(`next: bl status ${b}`);
    process.exit(1);
  }

  if (targets.length > 1) return dispatchSeveral(verb, argv, args, config, targets, held);
  return runTarget(verb, targets[0], args, argv, config);
}

/**
 * The verbs `dispatch` checks a gate at. `bl merge` checks its own in
 * `mergeGates`, where a story and a feature merge alike.
 */
export const GATED_VERBS = new Set(['run', 'implement']);

/**
 * The targets an unmet `blockers.json` edge holds at a gate `verb` checks
 * (F-66 D3), each with one line per edge and its blockers. Units are read
 * once, and only when the file has an edge.
 * @returns {Array<{ id: string, kind: string, lines: string[], blockers: string[] }>}
 */
export function heldTargets(verb, targets, config) {
  if (readBlockers(config.backlogRoot).edges.length === 0) return [];
  const units = readUnits(config);
  const out = [];
  for (const t of targets) {
    const holds = heldBy(config, t.id, verb, { units });
    if (holds.length === 0) continue;
    out.push({
      id: t.id,
      kind: t.kind,
      lines: holds.map((h) => h.line),
      blockers: [...new Set(holds.map((h) => h.edge.blocker))],
    });
  }
  return out;
}

/** Run `verb` on one target, `argv` and `args` naming only it. */
async function runTarget(verb, target, args, argv, config) {
  const cell = DISPATCH[verb][target.kind];
  if (!cell.startsWith('./')) {
    const handlers = await import('./feature-cmd.js');
    return handlers[cell](args, config, target.record);
  }
  const { main } = await import(cell);
  return main(argv);
}

/** `runTarget` for one of several targets: the shared flags plus its id. */
function runOne(verb, target, flags, config) {
  const argv = [...flags, target.id];
  return runTarget(verb, target, parseVerbArgs(argv), argv, config);
}

/** Refuse a flag that only makes sense for one target. */
function oneTargetOnly(verb, args, flags) {
  for (const flag of flags) {
    if (args[flag] != null && args[flag] !== false) {
      console.error(`bl ${verb}: --${flag} takes one target; give one id, or drop --${flag}.`);
      process.exit(1);
    }
  }
}

/**
 * Several targets (F-35 Design §5).
 */
async function dispatchSeveral(verb, argv, args, config, targets, held = []) {
  const flags = flagsOf(argv, args.positional);
  switch (verb) {
    case 'run':
    case 'implement': {
      oneTargetOnly(verb, args, verb === 'run' ? ['interactive'] : ['prompt']);
      const all = readAllStories(config);
      // A held target waits like a scheduler deferral; the others start.
      const heldIds = new Set(held.map((h) => h.id));
      const { start, deferred } = schedule(
        targets.filter((t) => !heldIds.has(t.id)),
        all,
        { config },
      );
      for (const h of held) deferred.push({ id: h.id, kind: h.kind, reason: h.lines.join('; '), blockers: h.blockers });
      deferred.sort(byId);
      printSchedule(start, deferred);
      if (start.length === 0) {
        console.error('Nothing to start: every target waits (see above).');
        process.exit(1);
      }
      if (start.length === 1) return runOne(verb, start[0], flags, config);
      if (verb === 'implement') return openWindows(verb, start, flags, NEED_TMUX);
      if (args.plan) {
        for (const t of start) {
          console.log('');
          await runOne(verb, t, flags, config);
        }
        return;
      }
      return runChildren(verb, start, flags, config);
    }
    case 'review':
      oneTargetOnly(verb, args, ['interactive']);
      return runChildren(verb, targets, flags, config);
    case 'merge':
      return mergeInOrder(targets, flags, config);
    case 'refine': {
      if (targets.some((t) => t.kind === 'feature')) {
        oneTargetOnly(verb, args, ['prompt']);
        return openWindows(
          verb,
          targets,
          flags,
          'several targets with a feature among them need tmux: start a tmux session and rerun this, or refine them one at a time',
        );
      }
      // Stories and components: today's refine batch, one orchestrator session.
      const { main } = await import('./refine.js');
      return main(argv);
    }
    case 'status':
      for (const [i, t] of targets.entries()) {
        if (i > 0) console.log('');
        await runOne(verb, t, flags, config);
      }
      return;
    default:
      return eachInTurn(verb, targets, flags);
  }
}

/** The schedule, printed before anything starts. */
function printSchedule(start, deferred) {
  if (deferred.length > 0) {
    info('Deferred:');
    for (const d of deferred) info(`  ${d.id}: ${d.reason}`);
    info('');
  }
  info(`Starting: ${start.map((t) => t.id).join(', ') || '(none)'}`);
}

/** One detached tmux window per target, each running `bl <verb> <id>`. */
function openWindows(verb, targets, flags, outsideTmux) {
  if (!process.env.TMUX) {
    console.error(outsideTmux);
    process.exit(1);
  }
  for (const t of targets) {
    openTmuxWindow(`${t.id} ${verb}`, [verb, ...flags, t.id]);
    info(`Started bl ${verb} ${t.id} in a new tmux window.`);
  }
}

/** A child `bl` process's environment: no tmux, so it renames no window. */
function childEnv() {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.BL_TMUX_WINDOW_ID;
  return env;
}

/**
 * Run `bl <verb> <id>` for each target in parallel, output to
 * `.bl/run/<id>.out`; wait for all, print one line each, exit 1 when any
 * failed or escalated.
 */
async function runChildren(verb, targets, flags, config) {
  ensureRunDir(config);
  const env = childEnv();
  info(`Running bl ${verb} for ${targets.map((t) => t.id).join(', ')} in parallel; output in ${RUN_DIR}/<id>.out`);
  const results = await Promise.all(
    targets.map(
      (t) =>
        new Promise((resolve) => {
          const outPath = join(config.backlogRoot, RUN_DIR, `${t.id}.out`);
          const fd = openSync(outPath, 'w');
          let child;
          try {
            child = spawn(process.execPath, [BL_PATH, verb, ...flags, t.id], { stdio: ['ignore', fd, fd], env });
          } finally {
            closeSync(fd);
          }
          child.on('error', (e) => resolve({ target: t, code: 1, outPath, error: e.message }));
          child.on('close', (code) => resolve({ target: t, code: code ?? 1, outPath }));
        }),
    ),
  );
  info('');
  let failed = false;
  for (const r of results) {
    const { line, ok } = outcomeLine(verb, r, config);
    console.log(line);
    if (!ok) failed = true;
  }
  if (verb === 'run') {
    const { printInboxCount } = await import('./inbox.js');
    printInboxCount(config);
  }
  process.exit(failed ? 1 : 0);
}

/**
 * The summary line for one child: outcome, PR(s), next step, read from the
 * unit's change document. A unit escalated when its `## Escalation` is open
 * after the child exits.
 *
 * @returns {{ line: string, ok: boolean }}
 */
export function outcomeLine(verb, { target, code, outPath, error = null }, config) {
  const id = target.id;
  const out = relative(process.cwd(), outPath) || outPath;
  let change = null;
  try {
    change = currentChange(dirname(target.record.indexPath))?.doc ?? null;
  } catch {
    // an unreadable change document leaves the line without a PR
  }
  const fm = change?.fm ?? {};
  const prs = (change?.repos ?? []).filter((r) => r.pr).map((r) => `#${r.pr}`);
  const pr = prs.length > 0 ? `, PR ${prs.join(', ')}` : '';
  if (code === 0) {
    if (verb === 'review') {
      const next =
        changeNextVerb(fm.review_status) === 'merge' ? `bl merge ${id}` : `bl run ${id} to fix, or bl implement ${id}`;
      return {
        line: `${id}: reviewed, round ${fm.review_round ?? '?'}, ${fm.review_status || 'no verdict'}${pr} — next: ${next}`,
        ok: true,
      };
    }
    return { line: `${id}: clean${pr} — next: bl merge ${id}`, ok: true };
  }
  if (escalationOpen(target.record.indexPath)) {
    return { line: `${id}: escalated${pr} — next: answer its ## Escalation (bl status ${id})`, ok: false };
  }
  return { line: `${id}: failed (${error ?? `exit ${code}`})${pr} — see ${out}`, ok: false };
}

/** `bl merge` for each target in dependency order; stop at the first failure. */
function mergeInOrder(targets, flags, config) {
  const ordered = dependencyOrder(targets, readAllStories(config), { config });
  info(`Merging in dependency order: ${ordered.map((t) => t.id).join(', ')}`);
  for (const [i, t] of ordered.entries()) {
    info(`\n== bl merge ${t.id} ==`);
    const res = spawnSync(process.execPath, [BL_PATH, 'merge', ...flags, t.id], { stdio: 'inherit' });
    if (res.status !== 0) {
      const rest = ordered.slice(i + 1).map((u) => u.id);
      console.error(`\nbl merge: ${t.id} failed; stopped.${rest.length > 0 ? ` Not merged: ${rest.join(', ')}.` : ''}`);
      process.exit(1);
    }
  }
}

/** `bl <verb> <id>` for each target in turn, each on its own; exit 1 if any failed. */
function eachInTurn(verb, targets, flags) {
  const failed = [];
  for (const [i, t] of targets.entries()) {
    if (i > 0) console.log('');
    const res = spawnSync(process.execPath, [BL_PATH, verb, ...flags, t.id], { stdio: 'inherit' });
    if (res.status !== 0) failed.push(t.id);
  }
  if (failed.length > 0) {
    console.error(`\nbl ${verb}: failed for ${failed.join(', ')}.`);
    process.exit(1);
  }
}
