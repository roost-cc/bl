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
 * pushes what the session left uncommitted in the backlog
 * (`refineAndCommit`).
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
import { assertFrom, requireBranch, statusOf, transition } from './transition.js';
import { commitChangedSince, dirtySnapshot } from './backlog-commit.js';
import { sessionEffort } from './effort.js';

/**
 * Resolve refine targets from positional args. Component IDs expand to their
 * draft stories; explicitly-named story IDs are included when `flow.json`'s
 * `refine` row starts from their status (`assertFrom`), else skipped with
 * the table's message. Results are deduped by story ID —
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
        addStory(found, fm, 'component');
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
    const unit = { id: parsed.id, kind: 'story', status: statusOf('story', fm) };
    const refused = assertFrom(loadFlow(config.backlogRoot), unit, 'refine', { config, ...unit });
    if (refused) {
      notices.push(`${refused} — skipping.`);
      continue;
    }
    addStory(found, fm, 'named');
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

  const promptName = statusOf('story', fm) === 'refined' ? 're-refine' : 'refine';
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
 * Apply one unit's refine outcome (F-68 D3): record the `refine` verb's
 * `success` branch (`refined`) or `failure` branch (`draft`, the premise
 * does not hold) in the unit's log, `by: refine, via: refine`, with `reason`
 * as the entry's `outcome` (`transition`, F-69 D3); or, when `result` is
 * null, leave the status and print `reason`.
 * @param {string} backlogRoot
 * @param {{ id: string, kind: "story" | "feature", indexPath: string }} unit
 * @param {"success" | "failure" | null} result
 * @param {string} [reason]
 */
export function applyRefineStatus(backlogRoot, { id, kind, indexPath }, result, reason) {
  if (result) {
    let status;
    // The error names the unit: in a batch, the units before it are set.
    try {
      status = requireBranch(loadFlow(backlogRoot), kind, 'refine', result, {}).to;
      transition(backlogRoot, { kind, indexPath }, status, { by: 'refine', via: 'refine', outcome: reason });
    } catch (e) {
      throw new Error(`${id}: ${e.message}`);
    }
    // A draft (the premise does not hold) says why.
    info(result === 'failure' && reason ? `${id}: status ${status}: ${reason}` : `${id}: status ${status}.`);
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
 * changes no status, and its fault is printed (F-68 D5). Exits with the
 * session's status, or 1 when the status write or the commit failed.
 * `bl refine S-n`, the batch and `bl refine F-n` (`feature-cmd.js`
 * `cmdRefine`) all end here.
 * @param {object} opts  `launchSession` options
 * @param {string} message
 * @param {string[]} ids  the refined units: a failed commit's paths go to
 *   the next refine of the same units (`refine <ids>`), whether it is a
 *   refine or a re-refine
 * @param {(structured: object) => void} apply  writes the statuses from the
 *   validated outcome
 */
export function refineAndCommit(opts, message, ids, apply) {
  const before = dirtySnapshot(opts.backlogRoot);
  const { status, structured, structuredError } = launchSession({ ...opts, returnOnExit: true });
  let applyFailed = false;
  if (structured) {
    try {
      apply(structured);
    } catch (e) {
      applyFailed = true;
      console.error(`Error: cannot set the status from the refine outcome: ${e.message}`);
    }
  } else {
    console.error(
      `No refine outcome (${structuredError}); every status is unchanged.\n` +
        `  Run \`bl refine ${ids.join(' ')}\` again to set it.`,
    );
  }
  const failed = commitChangedSince(opts.backlogRoot, before, message, {
    session: true,
    owner: `refine ${ids.join(', ')}`,
  });
  // A failed commit is 1 whatever the session ended with (S-1330).
  process.exit(failed || applyFailed ? 1 : status);
}

/** Single-story interactive refine (the original `bl refine <story>` flow). */
function refineOne(target, config, { additionalPrompt } = {}) {
  const { backlogRoot, roostDir } = config;
  const { parsed, title, storyRelPath, promptName, vars } = storyRefineContext(target.found, target.fm, config);

  if (statusOf('story', target.fm) === 'refined') {
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

  refineAndCommit(
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
    [parsed.id],
    ({ refined, reason }) =>
      applyRefineStatus(
        backlogRoot,
        { id: parsed.id, kind: 'story', indexPath: target.found.indexPath },
        refined ? 'success' : null,
        reason,
      ),
  );
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
function refineBatch(targets, config) {
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

  refineAndCommit(
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
    targets.map((t) => t.id),
    ({ stories }) => applyBatchStatuses(backlogRoot, targets, stories),
  );
}

/**
 * Apply a batch refine's outcome to every story. A story whose status write
 * fails does not stop the others: bl tries each one, then throws one error
 * that names the stories set and each story not set.
 * @param {string} backlogRoot
 * @param {Array<{ id: string, found: { indexPath: string } }>} targets
 * @param {Record<string, { refined: boolean, reason?: string }>} stories
 */
export function applyBatchStatuses(backlogRoot, targets, stories) {
  const set = [];
  const failed = [];
  for (const t of targets) {
    const entry = stories[t.id] ?? { refined: false, reason: 'the outcome has no entry for it' };
    const unit = { id: t.id, kind: 'story', indexPath: t.found.indexPath };
    try {
      applyRefineStatus(backlogRoot, unit, entry.refined ? 'success' : null, entry.reason);
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
ends, bl sets each story the agent refined to "refined", and prints the reason
for each one it did not. Then bl commits and pushes what the session left
uncommitted in the backlog.`);
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
