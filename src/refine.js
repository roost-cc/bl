/**
 * refine.js — refine stories for implementation.
 *
 * Runs in the backlog repo (not a worktree). Accepts one or more targets: a
 * story ID (S-34) refines just that story interactively; a component ID (C01)
 * expands to every draft story in the component. When more than one story is
 * resolved, a single orchestrator session is launched that delegates each
 * story to its own sub-agent (Task tool), refining them in parallel.
 *
 * The session ends by writing its outcome file (F-68 D1); when the session
 * exits, sets each story's status to "refined" from it, then commits and
 * pushes what the session left uncommitted in its work units' directories
 * (`refineAndCommit`), whose locks it holds for the whole session (F-122).
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import {
  loadConfig,
  parseFrontmatter,
  parseArgs,
  info,
  normalizeId,
  normalizeComponentId,
  componentIdHint,
} from './config.js';
import { findStoryDir, findComponentDir, readAllStories } from './story.js';
import { updateTabTitle } from './tab-title.js';
import { launchSession, loadPrompt, loadSchema, spillSubagentPrompts } from './session.js';
import { flowForHelp, loadFlow } from './flow.js';
import { enterVerb, logOf, requireBranch, startOf, transition } from './transition.js';
import { commitChangedSince, dirtySnapshot } from './backlog-commit.js';
import { sessionEffort } from './effort.js';
import { takeUnitLocksOrExit } from './unit-lock.js';
import { snapshot } from './atomic-write.js';

/**
 * Resolve refine targets from positional args. Component IDs expand to their
 * draft stories; a story is included when `refine` may start on it
 * (`startOf`: the row's from and guards, and no hold on its nominal path),
 * else skipped with the refusal. Results are deduped by story ID —
 * an explicitly-named story wins over the same story pulled in via a component, so
 * an already-refined story named on the command line is still re-refined.
 *
 * @returns {{ targets: Array<{ id, found, fm, title, source }>,
 *             errors: string[], notices: string[] }}
 */
export function resolveRefineTargets(positionals, config) {
  const errors = [];
  const notices = [];
  const byId = new Map();
  // `startOf`: the refine row's from, its guards and the holds (F-119 R4); a refused story is skipped.
  const refusedOf = (id, found, fm) => {
    const { refusal } = startOf(config, 'story', { id, indexPath: found.indexPath, fm }, 'refine');
    if (refusal) notices.push(`${refusal} — skipping.`);
    return refusal != null;
  };

  const addStory = (found, fm, source) => {
    const id = fm.story_id ?? normalizeId(found.storyEntry)?.id ?? found.storyEntry;
    const existing = byId.get(id);
    // A named target outranks a component-expanded one; never downgrade.
    if (existing && existing.source === 'named') return;
    byId.set(id, {
      id,
      found,
      fm,
      title: fm.title ?? found.storyEntry,
      source,
    });
  };

  for (const raw of positionals) {
    const component = normalizeComponentId(raw);
    if (component) {
      if (!findComponentDir(component, config)) {
        errors.push(`Component ${component.id} not found under components/.`);
        continue;
      }
      const stories = readAllStories(config).filter((s) => s.componentId === component.id && s.status === 'draft');
      if (stories.length === 0) {
        notices.push(`Component ${component.id} has no draft stories to refine.`);
        continue;
      }
      for (const s of stories) {
        const parsed = normalizeId(s.id);
        const found = parsed && findStoryDir(parsed, config);
        if (!found) continue;
        const { fm } = parseFrontmatter(readFileSync(found.indexPath, 'utf8'));
        if (!refusedOf(parsed.id, found, fm)) addStory(found, fm, 'component');
      }
      continue;
    }

    const parsed = normalizeId(raw);
    if (!parsed) {
      errors.push(componentIdHint(raw) ?? `Invalid id: ${raw} (expected a story like S-34 or a component like C01)`);
      continue;
    }
    const found = findStoryDir(parsed, config);
    if (!found) {
      errors.push(`Story ${parsed.id} not found in backlog`);
      continue;
    }
    const { fm } = parseFrontmatter(readFileSync(found.indexPath, 'utf8'));
    if (!refusedOf(parsed.id, found, fm)) addStory(found, fm, 'named');
  }

  const targets = [...byId.values()].sort(
    (a, b) =>
      (parseInt(String(a.id).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.id).replace(/\D/g, ''), 10) || 0),
  );
  return { targets, errors, notices };
}

/**
 * Build the prompt-template variables for one story, plus the template name to
 * use (`re-refine` for an already-refined story, `refine` otherwise). Shared by
 * the single-story path and the per-story sub-agent prompts in batch mode.
 */
function storyRefineContext(found, fm, config) {
  const { unitRepo, componentId, storyEntry, indexPath } = found;
  const title = fm.title ?? storyEntry;
  const storyRelPath = indexPath.slice(config.backlogRoot.length + 1);
  const parsed = normalizeId(fm.story_id ?? storyEntry) ?? { id: storyEntry };

  // A story's one repo is its component's (F-52 D1).
  const primaryRepoName = unitRepo ?? '';
  const primaryRepoPath = primaryRepoName ? (config.reposByName[primaryRepoName] ?? '') : '';

  const promptName =
    statusBeforeRefine(loadFlow(config.backlogRoot), 'story', fm) === 'refined' ? 're-refine' : 'refine';
  const vars = {
    storyId: parsed.id,
    title,
    storyRelPath,
    componentId,
    primaryRepo: primaryRepoName,
    primaryRepoPath,
    roostDir: config.roostDir,
    backlogDir: config.backlogRoot,
    storyRepos: primaryRepoName || '(none)',
  };
  return { parsed, title, storyRelPath, promptName, vars };
}

/**
 * The status a unit had before its refinement session (F-119 R1): its status,
 * or, on a unit at the `refine` verb's `during` (`in_refinement`, a resumed
 * refinement session), the status of the entry before the last one. The
 * prompt (`refine` or `re-refine`) follows it.
 * @param {import("./flow.js").Flow} flow
 * @param {"story" | "feature"} kind
 * @param {object} fm
 * @param {{ fm: object } | null} [change]
 * @returns {string}
 */
export function statusBeforeRefine(flow, kind, fm, change = null) {
  const log = logOf(kind, fm, change);
  const during = flow.verbOf(kind, 'refine')?.during;
  const at = during != null && log.at(-1)?.to === during ? -2 : -1;
  return log.at(at)?.to ?? '';
}

/**
 * Apply one unit's refine outcome (F-68 D3): record the `refine` verb's
 * `success` branch (`refined`) or `failure` branch (`draft`, the premise
 * does not hold) in the unit's log, `by: refine, via: refine`, with `reason`
 * as the entry's `outcome` (`transition`, F-69 D3); or, when `result` is
 * null, leave the status. Either way, print `reason`: the outcome schemas
 * require it for every verdict (S-1408).
 * @param {string} backlogRoot
 * @param {{ id: string, kind: "story" | "feature", indexPath: string }} unit
 * @param {"success" | "failure" | null} result
 * @param {string} reason
 */
export async function applyRefineStatus(backlogRoot, { id, kind, indexPath }, result, reason) {
  if (result) {
    let status;
    // The error names the unit: in a batch, the units before it are set.
    try {
      status = requireBranch(loadFlow(backlogRoot), kind, 'refine', result, {}).to;
      await transition(backlogRoot, { kind, indexPath }, status, { by: 'refine', via: 'refine', outcome: reason });
    } catch (e) {
      throw new Error(`${id}: ${e.message}`);
    }
    info(`${id}: status ${status}: ${reason}`);
  } else {
    info(`${id} is not refined; its status is unchanged: ${reason}`);
  }
}

/**
 * Run a refine session (`launchSession` options, with the step's `schema`),
 * apply its outcome, then commit and push what it left uncommitted in the
 * backlog with `message` (S-1330 D1): the agent commits its own work during
 * the session, and this catches the rest, the token totals `launchSession`
 * writes and the status `apply` writes included. The snapshot is taken here,
 * before the session starts (D3). A session without a valid outcome file
 * records no outcome: each unit stays at the refine verb's `during`, where
 * the session started it, and its fault is printed (F-68 D5). Exits with the
 * session's status, or 1 when the status write or the commit failed.
 * `bl refine S-n`, the batch and `bl refine F-n` (`feature-cmd.js`
 * `cmdRefine`) all end here.
 *
 * First it takes the work unit locks of `units` (`takeUnitLocksOrExit`, F-122 D2):
 * a lock another process holds refuses the refine with exit 1, before it
 * writes anything. Then it records the `refine` verb's `during` on each unit
 * (`enterVerb`, F-119 R1), so an outcome with no status leaves the unit there.
 * When one of those writes fails, it puts every unit back (`snapshot`),
 * starts no session and commits nothing; a unit file it cannot put back is
 * named, with what to do, and left changed.
 * The commit holds only the paths under the units'
 * directories (`scope()`, read at the end, so a story the session made for
 * the feature is in it, D3); bl names each other changed path.
 * @param {import('./unit-lock.js').WorkUnit[]} units  the refined units: a
 *   failed commit's paths go to the next refine of the same units
 *   (`refine <ids>`), whether it is a refine or a re-refine
 * @param {object} opts  `launchSession` options
 * @param {string} message
 * @param {(structured: object) => Promise<void>} apply  writes the statuses
 *   from the validated outcome
 */
export async function refineAndCommit(units, opts, message, apply) {
  const ids = units.map((u) => u.id);
  const owner = `refine ${ids.join(', ')}`;
  const lock = takeUnitLocksOrExit(opts.config, units, owner);
  let exitCode;
  try {
    const before = dirtySnapshot(opts.backlogRoot);
    // The refine verb's `during` (`in_refinement`, F-119 R1), in the session's
    // commit; nothing on a unit there already or a row with no `during`. All
    // or nothing: a failed write puts back each unit an earlier one moved.
    const undo = snapshot(
      opts.backlogRoot,
      units.map((u) => u.indexPath),
      ' that started the refinement session',
    );
    let entered = true;
    let leftChanged = false;
    try {
      for (const u of units) await enterVerb(opts.backlogRoot, u, 'refine');
    } catch (e) {
      entered = false;
      const err = undo(e);
      leftChanged = err.unrecovered != null;
      console.error(`Error: cannot record the refinement session's start: ${err.message}`);
    }
    const { status, structured, structuredError } = entered
      ? await launchSession({ ...opts, units, returnOnExit: true })
      : { status: 1, structured: null, structuredError: 'the session did not start' };
    let applyFailed = false;
    if (structured) {
      try {
        await apply(structured);
      } catch (e) {
        applyFailed = true;
        console.error(`Error: cannot set the status from the refine outcome: ${e.message}`);
      }
    } else {
      // A started session left each unit at the refine verb's `during`.
      const where = entered
        ? 'each unit stays at the status the session started it in'
        : leftChanged
          ? 'each file named above is left changed'
          : 'every status is unchanged';
      console.error(
        `No refine outcome (${structuredError}); ${where}.\n` + `  Run \`bl refine ${ids.join(' ')}\` again to set it.`,
      );
    }
    // No session, nothing to commit: a start write is put back or named above, never committed.
    const failed = entered
      ? await commitChangedSince(opts.backlogRoot, before, message, {
          session: true,
          owner,
          scope: lock.scope,
        })
      : false;
    // A failed commit is 1 whatever the session ended with (S-1330).
    exitCode = failed || applyFailed ? 1 : status;
  } finally {
    lock.release();
  }
  process.exit(exitCode);
}

/** Single-story interactive refine (the original `bl refine <story>` flow). */
async function refineOne(target, config, { additionalPrompt } = {}) {
  const { backlogRoot, roostDir } = config;
  const { parsed, title, storyRelPath, promptName, vars } = storyRefineContext(target.found, target.fm, config);

  if (promptName === 're-refine') {
    info(`Story ${parsed.id} is already refined. Re-refining.\n`);
  }

  info(`Story   : ${parsed.id} — ${title}`);
  info(`File    : ${storyRelPath}`);
  info('');

  // The story's feature, when it has one; `launchSession` adds the story and the mode.
  updateTabTitle({ feature: target.fm.feature });

  const sessionPrompt = loadPrompt(promptName, vars, {
    agent: config.agent,
    config,
  });

  const unit = storyUnit(target);
  return refineAndCommit(
    [unit],
    {
      mode: 'refine',
      parsed,
      title,
      worktreePath: backlogRoot,
      branchName: 'main',
      sessionPrompt,
      roostDir,
      backlogRoot,
      isNewWorktree: false,
      agent: config.agent,
      config,
      additionalPrompt,
      effort: sessionEffort(config, { mode: 'refine' }),
      schema: loadSchema('refine'),
    },
    `chore: ${promptName} ${parsed.id}`,
    async ({ refined, reason }) => applyRefineStatus(backlogRoot, unit, refined ? 'success' : null, reason),
  );
}

/**
 * The work unit of a refine target (`resolveRefineTargets`).
 * @param {{ id: string, found: { indexPath: string } }} target
 * @returns {import('./unit-lock.js').WorkUnit}
 */
function storyUnit(target) {
  return { id: target.id, kind: 'story', indexPath: target.found.indexPath };
}

/**
 * The unit id of a batch refine's session (`refine-batch-<12 hex>`): the first
 * 12 hex characters of a SHA-256 of the sorted story ids. It names the batch's
 * outcome file, so two batches of other stories never share one, and its
 * length does not grow with the batch (a component can hold hundreds of
 * stories, and a file name is at most 255 bytes).
 * @param {string[]} ids the batch's story ids
 */
export function refineBatchId(ids) {
  const hash = createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
  return `refine-batch-${hash.slice(0, 12)}`;
}

/** Batch refine: one orchestrator session that fans out to per-story sub-agents. */
async function refineBatch(targets, config) {
  const { backlogRoot, roostDir } = config;

  info(`Refining ${targets.length} stories via sub-agents:`);
  for (const t of targets) {
    info(`  ${t.id} — ${t.title}  (${t.source})`);
  }
  info('');

  // Each sub-agent replies with its story's outcome; the orchestrator writes the file.
  // A sub-agent talks with the orchestrator, which carries the collaboration rules (F-97 D2).
  const refineOutcome = loadPrompt('_refine-outcome-subagent', {}, { agent: config.agent, config });
  const items = targets.map((t) => {
    const { promptName, vars } = storyRefineContext(t.found, t.fm, config);
    const body = loadPrompt(
      promptName,
      { ...vars, refineOutcome, collaborationGuide: '' },
      { agent: config.agent, config },
    );
    return { id: t.id, title: t.title, body };
  });

  // Each story's full instruction block goes to its own temp file; the
  // orchestrator prompt only carries the file pointers (a single argv string is
  // capped at ~128 KB, which inline blocks overflow — E2BIG).
  const { files } = spillSubagentPrompts('refine', items);
  const storyTasks = files.map((f) => `- ${f.id} — ${f.title}: read and follow \`${f.file}\``).join('\n');

  const sessionPrompt = loadPrompt(
    'refine-batch',
    {
      storyCount: String(targets.length),
      storyTasks,
      // The shared commit flow names each sub-agent's own story.
      storyId: '<its story>',
      backlogDir: backlogRoot,
      // Each sub-agent is started at this level by name (F-85 D5).
      refineEffort: sessionEffort(config, { mode: 'refine' }),
    },
    { agent: config.agent, config },
  );

  // No single story: the count stands in its place (`refine-batch` names no unit).
  updateTabTitle({ story: `${targets.length} stories` });

  return refineAndCommit(
    targets.map(storyUnit),
    {
      mode: 'refine',
      parsed: { id: refineBatchId(targets.map((t) => t.id)) },
      title: `${targets.length} stories`,
      worktreePath: backlogRoot,
      branchName: 'main',
      sessionPrompt,
      roostDir,
      backlogRoot,
      isNewWorktree: false,
      agent: config.agent,
      config,
      forceNew: true,
      recordTokens: false,
      sessionName: `refine batch — ${targets.map((t) => t.id).join(', ')}`,
      effort: sessionEffort(config, { mode: 'refine' }),
      schema: loadSchema('refine-batch'),
    },
    `chore: refine ${targets.map((t) => t.id).join(', ')}`,
    async ({ stories }) => applyBatchStatuses(backlogRoot, targets, stories),
  );
}

/**
 * Apply a batch refine's outcome to every story. A story whose status write
 * fails does not stop the others: bl tries each one, then throws one error
 * that names the stories set and each story not set. A story takes the
 * first entry with its id; an entry for a story outside the batch is not read.
 * @param {string} backlogRoot
 * @param {Array<{ id: string, found: { indexPath: string } }>} targets
 * @param {Array<{ id: string, refined: boolean, reason: string }>} stories
 */
export async function applyBatchStatuses(backlogRoot, targets, stories) {
  const set = [];
  const failed = [];
  for (const t of targets) {
    const entry = stories.find((s) => s.id === t.id) ?? { refined: false, reason: 'the outcome has no entry for it' };
    try {
      await applyRefineStatus(backlogRoot, storyUnit(t), entry.refined ? 'success' : null, entry.reason);
      if (entry.refined) set.push(t.id);
    } catch (e) {
      failed.push(e.message);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `status set for: ${set.join(', ') || 'none'}; not set for:\n` + failed.map((m) => `  ${m}`).join('\n'),
    );
  }
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl refine <id...> [options]

Arguments:
  <id...>              One or more story IDs (S34, S-34) and/or component IDs (C01).
                       A component expands to every 'draft' story it contains.
                       Naming a story directly refines it even if already
                       refined (only ${flowForHelp().closedStatusesOf('story').join('/')} are skipped).

Options:
  -A, --agent <id>     Agent provider (e.g. "claude", "codex", "gemini", "local")
  --model <m>          Model of the -A configuration (needs -A)
  -P, --prompt <text>  Discuss <text> with the agent first (single story only)
  -t                   Detach into a new tmux window
  --help               Show this help

With a single resolved story, launches one interactive agent session in the
backlog repo to refine and plan it. With multiple stories, launches one
orchestrator session that delegates each story to its own sub-agent, refining
them in parallel. The session ends by writing its outcome: when the session
ends, bl sets each story the agent refined to "refined", leaves each other
story as it is, and prints the agent's reason for each. Then bl commits and
pushes what the session left uncommitted in the stories' directories, and
names each other path it left.

A refine locks its stories first. If another bl process holds one of them,
the refine refuses with that process's pid.`);
    process.exit(0);
  }

  const config = loadConfig({ agent: args.agent, model: args.model });

  const positionals = args.positional;
  if (positionals.length === 0) {
    console.error('Usage: bl refine <id...>  (story IDs and/or component IDs)');
    process.exit(1);
  }

  const { targets, errors, notices } = resolveRefineTargets(positionals, config);

  for (const n of notices) info(n);
  for (const e of errors) console.error(e);

  if (targets.length === 0) {
    if (errors.length === 0) console.error('No stories to refine.');
    process.exit(1);
  }

  if (targets.length === 1) {
    return refineOne(targets[0], config, { additionalPrompt: args.prompt });
  }

  if (args.prompt) {
    console.error('--prompt is only supported when refining a single story (sub-agents run autonomously).');
    process.exit(1);
  }

  return refineBatch(targets, config);
}
