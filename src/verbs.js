/**
 * verbs.js — the id-dispatched verbs.
 *
 *   bl run|implement|review|merge|refine|status|approve|done <id...>
 *
 * Each id resolves to a story, a feature, a story batch or a component
 * (targets.js), and the verb calls that kind's handler (F-35 Design §1). A
 * batch uses the feature handlers (F-125 D1). `bl status` with no arguments at
 * all has no target: it lists the open stories by status (list.js).
 *
 * Several ids (Design §5): `run` and `implement` take one target and refuse
 * several (F-125 D5: grouping stories is `bl batch`); `review` runs each unit
 * as a child `bl review <id>` with its output in `.bl/run/<id>.out`; `merge`
 * goes in dependency order and stops at the first failure; `refine`,
 * `status`, `approve` and `done` take each target on its own.
 */

import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { dirname, join, relative } from 'path';
import { BL_PATH, runBl } from './child.js';
import { loadConfig, parseArgs, info, openTmuxWindow } from './config.js';
import { renderTabTitle, TAB_TITLE_ENV, unitTitleFields } from './tab-title.js';
import { readAllStories } from './story.js';
import { classifyId, resolveTargets } from './targets.js';
import { dependencyOrder } from './execution-plan.js';
import { heldBy, readEdges, readUnits } from './blockers.js';
import { RUN_DIR, ensureRunDir, escalationOpen, loadRunState, readFm, reviewEnd } from './feature-run.js';
import { reviewOf } from './transition.js';
import { currentChange } from './change-doc.js';
import { featureUnit, storyUnit } from './unit.js';

/**
 * What each verb does with each kind of target. A cell starting `./` names
 * the module whose `main(argv)` is today's story command; any other cell is a
 * handler exported by feature-cmd.js, called with `(args, config, record)`:
 * the feature handlers, and the story handlers that run a story through the
 * feature loop. A story batch takes the feature handlers (F-125 D1). null:
 * targets.js refuses the kind.
 */
export const DISPATCH = {
  run: { story: 'cmdRunStory', feature: 'cmdRun', batch: 'cmdRun', component: null },
  implement: { story: './workon.js', feature: 'cmdWorkon', batch: 'cmdWorkon', component: null },
  review: { story: 'cmdReviewStory', feature: 'cmdReview', batch: 'cmdReview', component: null },
  merge: { story: './cleanup.js', feature: 'cmdMerge', batch: 'cmdMerge', component: null },
  refine: { story: './refine.js', feature: 'cmdRefine', batch: null, component: './refine.js' },
  status: { story: 'cmdStatusStory', feature: 'cmdStatus', batch: 'cmdStatus', component: 'cmdStatusComponent' },
  approve: { story: null, feature: 'cmdApprove', batch: null, component: null },
  done: { story: './done.js', feature: null, batch: null, component: null },
};

export const VERBS = Object.keys(DISPATCH);

/** The verbs whose story handler once took `--repo` (F-52 D1 removed it). */
const STORY_REPO_REFUSED = new Set(['run', 'implement', 'review', 'merge']);

/** The verbs whose feature (and batch) handler once took `--repo` (F-52 D3 removed it). */
const FEATURE_REPO_REFUSED = new Set(['run', 'implement']);

const VERB_HELP = {
  run: `Usage: bl run <id> [options]

Arguments:
  <id>                 One target: a feature (F-3), a story batch (B-2) or a
                       refined story (S-34), which goes through the loop on
                       its own branch. A story that belongs to a feature or
                       a batch is refused (run that unit). A component is
                       refused: make its stories a feature. Several ids are
                       refused: group stories with bl batch.

Options:
  --resume             Continue from the saved run state
  --interactive        Attach each session instead of running it headless
  --plan               Print the steps and exit
  --max-rounds <n>     Review-round cap for this run
  -A, --agent <id>     Agent provider; replaces backlog.json's agent list,
                       not review_agent
  --model <m>          Model of the -A configuration (needs -A)
  --help               Show this help

No --repo: a story's repo is its component's, and a feature prepares every
repo of its stories, bl first, then by first story in dependency order, and
starts in the first. A batch runs as a feature does, each story with its own
plan.

The autonomous loop: implement, test gate, self-review, one PR, review → fix →
re-review until clean or the round cap escalates. Stops before merge.`,
  implement: `Usage: bl implement <id> [options]

Arguments:
  <id>                 One target: a feature (F-3), a story batch (B-2) or a
                       story (S-34). A story that belongs to a feature or a
                       batch is refused (implement that unit). A component
                       is refused: make its stories a feature. Several ids
                       are refused: group stories with bl batch.

Options:
  -A, --agent <id>     Agent provider
  --model <m>          Model of the -A configuration (needs -A)
  -P, --prompt <text>  Discuss <text> with the agent first
  --help               Show this help

No --repo: a feature or a batch prepares every repo of its stories, as bl run does, and
starts in the first. Creates or resumes the worktree and opens an interactive agent session: the
manual single step. Use bl run for the whole loop.`,
  review: `Usage: bl review <id...> [options]

Arguments:
  <id...>              Stories (S-34), features (F-3) or story batches (B-2).
                       A story that belongs to a feature or a batch is
                       refused (review that unit).

Options:
  -r, --repo <name>    Feature or batch: restrict the review to one repo's PR.
                       Refused for a story: it has one repo
  -A, --agent <id>     Agent provider; replaces backlog.json's review_agent
                       list
  --model <m>          Model of the -A configuration (needs -A)
  -P, --prompt <text>  Extra instructions for the review sessions
  --interactive        Attach each review session (one target)
  --help               Show this help

One review round, the step bl run takes: two dimension passes and a verifier
on the review agent over the open PR(s), one session in the Review Log, and
one verdict in the unit's transition log. Several targets are reviewed in parallel, each as a
child bl review with its output in .bl/run/<id>.out.`,
  merge: `Usage: bl merge <id...> [options]

Arguments:
  <id...>              Stories (S-34), features (F-3) or story batches (B-2).
                       A story that belongs to a feature or a batch is
                       refused (merge that unit).

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
unless --no-review (a story at ready_for_merge whose branch has no commits
passes and merges nothing), while ## Escalation is open, on a worktree on the
branch in a repo the work does not own, and when a main checkout is off main.
Then merges every repo's branch, marks the work done, syncs the backlog, closes
PRs and removes the worktrees. Several targets merge one at a time in
dependency order, stopping at the first that fails.`,
  refine: `Usage: bl refine <id...> [options]

Arguments:
  <id...>              A feature (F-3), or stories (S-34) and/or components
                       (C01). A component expands to its 'draft' stories.

Options:
  -A, --agent <id>     Agent provider
  --model <m>          Model of the -A configuration (needs -A)
  -P, --prompt <text>  Discuss <text> with the agent first (single target)
  -t                   Detach into a new tmux window
  --help               Show this help

Launches an agent session in the backlog repo to refine and plan the work.
Several stories go to one orchestrator session with a sub-agent each. With a
feature among the targets, each target opens in its own tmux window. When the
session ends, bl commits and pushes what it left uncommitted in the directories
of its targets (a feature's stories included), and names each other path it
left. A refine locks its targets first: if another bl process holds one, it
refuses with that process's pid.`,
  status: `Usage: bl status [<id...>]

Arguments:
  [<id...>]            A feature (F-3) or a story batch (B-2): its stories in
                       dependency order, review state, blockers, deferred
                       items, escalation and run state. A story (S-34): its status, branch, PR,
                       review state and round, escalation and run state. A
                       component (C01): its open stories.

Options:
  --help               Show this help

With no id it lists the open stories, furthest along first as flow.json has it
(in_progress then refined then backlog by default), by priority.yaml's order
within each, in the table bl list prints.`,
  approve: `Usage: bl approve <id...> [options]

Arguments:
  <id...>              Refined features (F-3). Stories have no approve step:
                       a refined story may run.

Options:
  --force              Approve a draft
  --help               Show this help

The human gate before bl run. Refuses while ## Escalation is not "None.".
Commits and pushes the feature file.`,
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
  if (ids.length > 1 && ONE_TARGET_VERBS.has(verb)) {
    console.error(oneTargetRefusal(verb));
    process.exit(1);
  }

  // -A replaces the review list on `bl review`, the implementing list on
  // every other verb (F-64 D2).
  const config = loadConfig({
    agent: args.agent,
    model: args.model,
    agentRole: verb === 'review' ? 'review' : 'agent',
  });
  const { targets, errors, notices } = resolveTargets(ids, config, verb);
  for (const n of notices) info(n);
  for (const e of errors) console.error(e);
  if (errors.length > 0) process.exit(1);
  // A story has one repo, its component's (F-52 D1): no story verb takes --repo.
  if (targets.some((t) => t.kind === 'story') && STORY_REPO_REFUSED.has(verb)) {
    const { refuseStoryRepo } = await import('./story.js');
    refuseStoryRepo(verb, args);
  }
  // A feature's repos are its stories', and it starts in the lead (F-52 D3); a batch's too.
  if (
    targets.some((t) => t.kind === 'feature' || t.kind === 'batch') &&
    FEATURE_REPO_REFUSED.has(verb) &&
    args.repo != null &&
    args.repo !== false
  ) {
    console.error(
      `bl ${verb}: unknown option "--repo" for a ${targets[0].kind === 'batch' ? 'story batch' : 'feature'}: it prepares every repo of its stories and starts in the first (bl, else its first story's).`,
    );
    process.exit(1);
  }

  // A target held at its `run` gate by an unmet edge does not start (F-66 D3).
  // A gated verb takes one target (ONE_TARGET_VERBS).
  const held = GATED_VERBS.has(verb) ? heldTargets(verb, targets, config) : [];
  if (held.length === 1) {
    for (const line of held[0].lines) console.error(line);
    for (const b of held[0].blockers) console.error(`next: bl status ${b}`);
    process.exit(1);
  }

  if (targets.length > 1) return dispatchSeveral(verb, argv, args, config, targets);
  return runTarget(verb, targets[0], args, argv, config);
}

/** The verbs that take one target (F-125 Decision A3): grouping work is a batch, built on purpose. */
export const ONE_TARGET_VERBS = new Set(['run', 'implement']);

/** Why `bl <verb>` refuses several ids, and what to do instead. */
export function oneTargetRefusal(verb) {
  return `bl ${verb}: takes one target; give one id. To ${verb} several stories as one unit, group them with bl batch S-a S-b … --title <t>, then bl ${verb} the batch.`;
}

/**
 * The verbs `dispatch` checks a gate at. `bl merge` checks its own in
 * `mergeGates`, where a story and a feature merge alike.
 */
export const GATED_VERBS = new Set(['run', 'implement']);

/**
 * The targets an unmet edge (`readEdges`: `blockers.json`'s and the
 * `depends_on:` keys') holds at a gate `verb` checks (F-66 D3), each with
 * one line per edge and its blockers. Units are read once, and only when
 * there is an edge.
 * @returns {Array<{ id: string, kind: string, lines: string[], blockers: string[] }>}
 */
export function heldTargets(verb, targets, config) {
  if (readEdges(config).length === 0) return [];
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

/** Run `verb` on one target, `argv` and `args` naming only it: its cell's capability. */
async function runTarget(verb, target, args, argv, config) {
  // Imported here: capabilities.js derives its registry from DISPATCH.
  const { CAPABILITIES } = await import('./capabilities.js');
  return CAPABILITIES.get(DISPATCH[verb][target.kind])(args, config, target.record, argv);
}

/** `runTarget` for one of several targets: the shared flags plus its id. */
async function runOne(verb, target, flags, config) {
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
async function dispatchSeveral(verb, argv, args, config, targets) {
  const flags = flagsOf(argv, args.positional);
  switch (verb) {
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

/** One detached tmux window per target, each running `bl <verb> <id>`. */
function openWindows(verb, targets, flags, outsideTmux) {
  if (!process.env.TMUX) {
    console.error(outsideTmux);
    process.exit(1);
  }
  for (const t of targets) {
    openTmuxWindow(renderTabTitle({ ...unitTitleFields(t.id), status: verb }), [verb, ...flags, t.id]);
    info(`Started bl ${verb} ${t.id} in a new tmux window.`);
  }
}

/** A child `bl` process's environment: tab titles off (`tab-title.js`) and no tmux, so this window's title stays ours. */
function childEnv() {
  const env = { ...process.env };
  env[TAB_TITLE_ENV] = '';
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
  const prs = (change?.repos ?? []).filter((r) => r.pr).map((r) => `#${r.pr}`);
  const pr = prs.length > 0 ? `, PR ${prs.join(', ')}` : '';
  if (code === 0) {
    if (verb === 'review') {
      // The unit's cap and path only: a feature record was read before the
      // child ran, so the review state is read from the log now (F-69 D5).
      let review;
      try {
        // A target's kind (story, feature, batch) is its type in flow.json.
        review = reviewOf(target.kind, readFm(target.record.indexPath), change);
      } catch {
        // An unreadable unit file has no review state to show.
        return { line: `${id}: reviewed, its file cannot be read${pr}`, ok: true };
      }
      let unit = null;
      try {
        unit = target.kind === 'story' ? storyUnit(target.record, config) : featureUnit(target.record);
      } catch {
        // an unreadable story file leaves the line without a next command
      }
      let state = null;
      try {
        state = loadRunState(config, id);
      } catch {
        // an unreadable run state owes no integration round
      }
      const end = reviewEnd({
        id,
        unitRelPath: unit?.featureRelPath,
        maxRounds: unit?.reviewRoundsMax,
        review,
        body: change?.body ?? '',
        state,
        escalated: false,
      });
      return {
        line: `${id}: reviewed, round ${review.reviewed} done: ${end.outcome}${pr}${unit && end.next ? ` — next: ${end.next}` : ''}`,
        ok: true,
      };
    }
    return { line: `${id}: clean${pr} — next: bl merge ${id}`, ok: true };
  }
  let escalated = false;
  try {
    escalated = escalationOpen(target.record.indexPath);
  } catch {
    // an unreadable story file reads as not escalated: the line says failed
  }
  if (escalated) {
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
    const res = runBl(BL_PATH, ['merge', ...flags, t.id], { stdio: 'inherit' });
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
    const res = runBl(BL_PATH, [verb, ...flags, t.id], { stdio: 'inherit' });
    if (res.status !== 0) failed.push(t.id);
  }
  if (failed.length > 0) {
    console.error(`\nbl ${verb}: failed for ${failed.join(', ')}.`);
    process.exit(1);
  }
}
