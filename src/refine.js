/**
 * refine.js — refine backlog stories for implementation.
 *
 * Runs in the backlog repo (not a worktree). Accepts one or more targets: a
 * story ID (S-34) refines just that story interactively; a component ID (C01)
 * expands to every backlog story in the component. When more than one story is
 * resolved, a single orchestrator session is launched that delegates each
 * story to its own sub-agent (Task tool), refining them in parallel.
 *
 * Sets each story's status to "refined" when done. Does not commit — leaves
 * that to the user.
 */

import { readFileSync } from 'fs';
import {
  loadConfig,
  parseFrontmatter,
  parseArgs,
  info,
  renameTmuxWindow,
  normalizeId,
  normalizeComponentId,
  componentIdHint,
} from './config.js';
import { findStoryDir, findComponentDir, readAllStories } from './story.js';
import { launchSession, loadPrompt, spillSubagentPrompts } from './session.js';

/**
 * Resolve refine targets from positional args. Component IDs expand to their
 * `status: backlog` stories; explicitly-named story IDs are always included
 * (only `done`/`superseded` are rejected). Results are deduped by story ID —
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
      const stories = readAllStories(config).filter((s) => s.componentId === component.id && s.status === 'backlog');
      if (stories.length === 0) {
        notices.push(`Component ${component.id} has no backlog stories to refine.`);
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
    if (fm.status === 'done' || fm.status === 'superseded') {
      notices.push(`Story ${parsed.id} has status '${fm.status}' — skipping (cannot refine).`);
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

  const promptName = fm.status === 'refined' ? 're-refine' : 'refine';
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

/** Single-story interactive refine (the original `bl refine <story>` flow). */
function refineOne(target, config, { additionalPrompt } = {}) {
  const { backlogRoot, roostDir } = config;
  const { parsed, title, storyRelPath, promptName, vars } = storyRefineContext(target.found, target.fm, config);

  if (target.fm.status === 'refined') {
    info(`Story ${parsed.id} is already refined. Re-refining.\n`);
  }

  info(`Story   : ${parsed.id} — ${title}`);
  info(`File    : ${storyRelPath}`);
  info('');

  renameTmuxWindow(`${parsed.id} refine`);

  const sessionPrompt = loadPrompt(promptName, vars, {
    agent: config.agent,
    config,
  });

  launchSession({
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
  });
}

/** Batch refine: one orchestrator session that fans out to per-story sub-agents. */
function refineBatch(targets, config) {
  const { backlogRoot, roostDir } = config;

  info(`Refining ${targets.length} stories via sub-agents:`);
  for (const t of targets) {
    info(`  ${t.id} — ${t.title}  (${t.source})`);
  }
  info('');

  const items = targets.map((t) => {
    const { promptName, vars } = storyRefineContext(t.found, t.fm, config);
    const body = loadPrompt(promptName, vars, { agent: config.agent, config });
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
    },
    { agent: config.agent, config },
  );

  renameTmuxWindow('refine batch');

  launchSession({
    mode: 'refine',
    parsed: { id: 'refine-batch' },
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
    tmuxLabel: 'refine batch',
  });
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl refine <id...> [options]

Arguments:
  <id...>              One or more story IDs (S34, S-34) and/or component IDs (C01).
                       A component expands to every 'backlog' story it contains.
                       Naming a story directly refines it even if already
                       refined (only done/superseded are skipped).

Options:
  -A, --agent <id>     Agent provider (e.g. "claude", "codex", "gemini")
  -P, --prompt <text>  Discuss <text> with the agent first (single story only)
  -t                   Detach into a new tmux window
  --help               Show this help

With a single resolved story, launches one interactive agent session in the
backlog repo to refine and plan it. With multiple stories, launches one
orchestrator session that delegates each story to its own sub-agent, refining
them in parallel. Sets status to "refined" when complete. Does not commit.`);
    process.exit(0);
  }

  const config = loadConfig({ agent: args.agent });

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
