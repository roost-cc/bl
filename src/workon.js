/**
 * workon.js — begin work on backlog stories in isolated worktrees: the story
 * side of `bl implement`.
 *
 * Usage:
 *   bl implement <story-id>   The story's worktree in its repo: its
 *                             component's (F-52 D1)
 *
 * Several targets are scheduled by verbs.js, which opens one tmux window per
 * started story (F-35 decision J); this module works on one story.
 *
 * Dependency gating: a story is only launched when every `depends_on` is
 * already `done`/`superseded` (i.e. merged).
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import {
  loadConfig,
  configForRepo,
  parseFrontmatter,
  parseArgs,
  worktreePathFor,
  unitDirFor,
  info,
  normalizeId,
  normalizeComponentId,
} from './config.js';
import {
  findStoryDir,
  findComponentDir,
  readAllStories,
  parseIdList,
  refuseStoryRepo,
  storyRepoOrExit,
} from './story.js';
import {
  ensureWorktree,
  installDeps,
  runStagePlugins,
  workonDue,
  workonDone,
  prepareWorktreeOnce,
  loadPrompt,
  launchSession,
} from './session.js';
import { featureSessionVars } from './feature.js';
import { storyUnit, storyAsOrdered, unitVars } from './unit.js';
import { openUnitChange, unitChange } from './change-doc.js';
import { tokensStepKey } from './tokens.js';

const isDoneStatus = (s) => s === 'done' || s === 'superseded';

export function idNum(id) {
  return parseInt(String(id).replace(/\D/g, ''), 10) || 0;
}

/**
 * Resolve workon targets from positional args, then split them by dependency
 * readiness.
 *
 * Component IDs expand to their `status: refined` stories (backlog stories must be
 * refined first; done/superseded are complete). An explicitly-named story is
 * included when its status is `refined` or `in_progress`; backlog/done/
 * superseded are reported as notices. Named targets outrank component-expanded ones
 * on dedup.
 *
 * Each resolved target is then classified:
 *   - `startable` — every `depends_on` is already `done`/`superseded`.
 *   - `deferred`  — at least one `depends_on` is unmet; `blockers` lists them.
 * A dependency that is itself a not-yet-merged story (even one in the same
 * batch) is unmet, so the dependent defers.
 *
 * @returns {{ startable: Array, deferred: Array, errors: string[],
 *             notices: string[] }}
 */
export function resolveWorkonTargets(positionals, config) {
  const errors = [];
  const notices = [];
  const byId = new Map();

  const all = readAllStories(config);
  const statusById = new Map(all.map((s) => [s.id, s.status]));

  const addStory = (story, source) => {
    const existing = byId.get(story.id);
    // A named target outranks a component-expanded one; never downgrade.
    if (existing && existing.source === 'named') return;
    byId.set(story.id, { ...story, source });
  };

  for (const raw of positionals) {
    const component = normalizeComponentId(raw);
    if (component) {
      if (!findComponentDir(component, config)) {
        errors.push(`Component ${component.id} not found under components/.`);
        continue;
      }
      const stories = all.filter((s) => s.componentId === component.id && s.status === 'refined');
      if (stories.length === 0) {
        notices.push(`Component ${component.id} has no refined stories ready to work on.`);
        continue;
      }
      for (const s of stories) addStory(s, 'component');
      continue;
    }

    const parsed = normalizeId(raw);
    if (!parsed) {
      errors.push(`Invalid id: ${raw} (expected a story like S-34 or a component like C01)`);
      continue;
    }
    const story = all.find((s) => s.id === parsed.id);
    if (!story) {
      errors.push(`Story ${parsed.id} not found in backlog`);
      continue;
    }
    if (isDoneStatus(story.status)) {
      notices.push(`Story ${parsed.id} has status '${story.status}' — skipping (already complete).`);
      continue;
    }
    if (story.status !== 'refined' && story.status !== 'in_progress') {
      notices.push(
        `Story ${parsed.id} has status '${story.status}' — must be refined first (run: bl refine ${parsed.id}).`,
      );
      continue;
    }
    addStory(story, 'named');
  }

  const startable = [];
  const deferred = [];
  for (const t of byId.values()) {
    const deps = parseIdList(t.depends_on);
    const blockers = deps.filter((d) => !isDoneStatus(statusById.get(d)));
    if (blockers.length === 0) startable.push(t);
    else deferred.push({ ...t, blockers });
  }

  const byNum = (a, b) => idNum(a.id) - idNum(b.id);
  startable.sort(byNum);
  deferred.sort(byNum);

  return { startable, deferred, errors, notices };
}

/**
 * One repo's story worktree, the single preparation path every story worktree
 * takes (S-862): the worktree on the story branch under the repo's worktree
 * base (with `ensureWorktree`'s guards), the repo's bootstrap, and the
 * `workon` stage plugins on a new worktree (or one whose earlier run of
 * them failed). It builds no prompt variables and
 * launches no session, so `bl implement` and `bl run` both come through here.
 *
 * Exits on a hard guard (unknown repo, uncommitted changes, local main
 * ahead). A failed bootstrap or `workon` plugin is a warning, unless
 * `strict`: then it exits too, naming the repo, so a headless run never
 * starts its agent without a worktree the prompt promises.
 *
 * @param {string} repoName
 * @param {{ role?: string, strict?: boolean }} [opts]
 * @returns {{ repoName: string, repoPath: string, branchName: string,
 *             worktreePath: string, isNewWorktree: boolean }}
 */
export function prepareStoryRepo(parsed, found, config, repoName, { role = 'primary', strict = false } = {}) {
  const { componentEntry, storyEntry, indexPath } = found;
  const repoPath = config.reposByName[repoName];
  if (!repoPath) {
    console.error(`Unknown repo: ${repoName}`);
    console.error(`Known repos: ${Object.keys(config.reposByName).join(', ')}`);
    process.exit(1);
  }
  const branchName = storyEntry.toLowerCase();
  const storyRelPath = indexPath.slice(config.backlogRoot.length + 1);
  const worktreePath = worktreePathFor(config, repoName, branchName);

  info(`Repo     : ${repoName} (${role})`);
  info(`Branch   : ${branchName}`);
  info(`Worktree : ${worktreePath}`);
  info('');

  return prepareWorktreeOnce(repoPath, branchName, () => {
    const { effectiveWorktreePath, isNewWorktree } = ensureWorktree(repoPath, branchName, worktreePath);
    // Owed before bootstrap, so a run stopped there still owes them (S-862).
    const workonPending = workonDue(effectiveWorktreePath, isNewWorktree);

    const stop = (what) => {
      console.error(
        `${parsed.id}: ${what} failed in ${repoName} (${effectiveWorktreePath}) — stopping before the agent starts.`,
      );
      process.exit(1);
    };

    const bootstrapped = installDeps(config, parsed, {
      componentEntry,
      storyEntry,
      repoName,
      worktreePath: effectiveWorktreePath,
    });
    if (!bootstrapped && strict) {
      stop('bootstrap');
    }

    const pluginsOk = runStagePlugins('workon', workonPending, config, {
      componentEntry,
      storyEntry,
      parsed,
      worktreePath: effectiveWorktreePath,
      branchName,
      storyRelPath,
      repoPath,
    });
    if (pluginsOk) workonDone(effectiveWorktreePath);
    else {
      if (strict) stop('a workon plugin');
      console.error('Continuing anyway.\n');
    }

    return {
      repoName,
      repoPath,
      branchName,
      worktreePath: effectiveWorktreePath,
      isNewWorktree,
    };
  });
}

/**
 * The prompt line that names the other worktrees of a run, aligned under
 * `Lead worktree:` (15 columns), or `(none)`.
 *
 * @param {{ repoName: string, worktreePath: string }[]} list
 */
export function otherWorktreesLine(list) {
  if (list.length === 0) return '(none)';
  return list.map((w) => `${w.worktreePath} (${w.repoName})`).join(`\n${' '.repeat(15)}`);
}

/**
 * Create/resume a story's worktree through `prepareStoryRepo`, record the
 * branch in the story's change document (change-doc.js), and build the
 * prompt-template variables. Shared by the interactive flow and
 * `bl run S-n`'s prep. The change document's `review_status`
 * selects the `workon-review` prompt over `workon`.
 *
 * Side-effecting and may `process.exit(1)` on a hard guard (no repo,
 * uncommitted changes, local main ahead) — same guards as a single workon.
 * `strict` makes the preparation strict (`bl run`).
 */
function prepareStoryWorktree(parsed, found, config, { strict = false } = {}) {
  const { componentEntry, storyEntry, indexPath } = found;

  const content = readFileSync(indexPath, 'utf8');
  const { fm } = parseFrontmatter(content);
  const title = fm.title ?? storyEntry;
  const storyRelPath = indexPath.slice(config.backlogRoot.length + 1);

  const repoName = storyRepoOrExit(parsed, found);
  if (!config.reposByName[repoName]) {
    console.error(`Unknown repo: ${repoName} (the repo of component ${found.componentId})`);
    console.error(`Known repos: ${Object.keys(config.reposByName).join(', ')}`);
    process.exit(1);
  }

  info(`Story    : ${parsed.id} — ${title}`);
  info(`Story    : ${storyRelPath}`);

  const {
    branchName,
    worktreePath: effectiveWorktreePath,
    isNewWorktree,
  } = prepareStoryRepo(parsed, found, config, repoName, { strict });
  // The story's own unit directory, where its session starts (F-60 D3).
  const unitDir = unitDirFor(config, branchName);

  // Creating the branch opens the change: one `repos:` entry, the story's repo.
  const change = openUnitChange(config.backlogRoot, { id: parsed.id, title, indexPath }, branchName, [repoName]);

  const promptVars = {
    storyId: parsed.id,
    title,
    worktreePath: effectiveWorktreePath,
    unitDir,
    branchName,
    storyRelPath,
    storyAbsPath: indexPath,
    changeAbsPath: change.path,
    changeRelPath: relative(config.backlogRoot, change.path),
    componentId: componentEntry.replace(/-.*/, ''),
    primaryRepo: repoName,
    targetRepo: repoName,
    roostDir: config.roostDir,
    backlogDir: config.backlogRoot,
    storyRepos: repoName,
  };

  const unitState = unitChange(dirname(indexPath), repoName);
  const reviewPending = unitState.reviewStatus === 'pending';
  const reviewRound = parseInt(unitState.reviewRoundRaw, 10) || 0;
  const legacyPrReview = existsSync(join(effectiveWorktreePath, '.pr-review.md'));
  const promptName = reviewPending ? 'workon-review' : 'workon';

  return {
    promptVars,
    promptName,
    title,
    branchName,
    effectiveWorktreePath,
    unitDir,
    isNewWorktree,
    reviewPending,
    reviewRound,
    legacyPrReview,
    indexPath,
  };
}

/**
 * `bl run S-n`'s prep: the story's worktree as `bl implement` makes it, in
 * the shape `prepareFeatureWorktree` returns, so the feature loop runs the
 * story as a one-story unit (F-35 Design §3). The branch is the story's own
 * (its directory name, lower case) and the PR title `S-n: <title>`, so
 * `bl merge` and `bl review` find both. `unit` is the story's `storyUnit`.
 *
 * A story has one repo, its component's (F-52 D1), so it has one worktree,
 * prepared before any agent starts through `prepareStoryRepo` in strict mode
 * (S-862): a repo that cannot be prepared stops the run. `otherWorktrees`
 * is always empty; it keeps the shape `prepareFeatureWorktree` returns.
 *
 * @returns {{ cfg, parsed, worktreePath, unitDir, branchName, isNewWorktree,
 *             ordered, baseVars, reviewPending, targetRepoName,
 *             otherWorktrees }}
 */
export function prepareStoryRun(parsed, found, config, { unit = storyUnit(found, config) } = {}) {
  // The story's repo's overrides and plugin layer, whatever config the caller loaded.
  config = configForRepo(config, found.unitRepo);
  const prep = prepareStoryWorktree(parsed, found, config, { strict: true });
  const v = prep.promptVars;
  const story = storyAsOrdered(unit);
  const baseVars = {
    ...v,
    featureId: unit.id,
    title: unit.title,
    featureRelPath: unit.featureRelPath,
    featureAbsPath: unit.indexPath,
    storiesPlan: `1. ${unit.id} — ${unit.title} (${unit.points} pts, ${unit.status})\n   file: ${unit.indexPath}`,
    storyCount: '1',
    prTitle: `${unit.id}: ${unit.title}`,
    adhocComponent: story.componentId,
    ...unitVars(unit),
    ...featureSessionVars(unit),
  };
  return {
    cfg: config,
    parsed,
    worktreePath: prep.effectiveWorktreePath,
    unitDir: prep.unitDir,
    branchName: prep.branchName,
    isNewWorktree: prep.isNewWorktree,
    ordered: [story],
    baseVars,
    reviewPending: prep.reviewPending,
    targetRepoName: v.targetRepo,
    otherWorktrees: [],
  };
}

/** Single-story interactive workon: `bl implement <story>`. */
function workonOne(parsed, baseConfig, { additionalPrompt } = {}) {
  const found = findStoryDir(parsed, baseConfig);
  if (!found) {
    console.error(`Story ${parsed.id} not found in backlog`);
    process.exit(1);
  }
  // The story's repo's overrides and plugin layer apply (F-51 D4).
  const config = configForRepo(baseConfig, found.unitRepo);

  const prep = prepareStoryWorktree(parsed, found, config);

  if (prep.legacyPrReview && !prep.reviewPending) {
    console.error(
      `Found a legacy .pr-review.md in ${prep.effectiveWorktreePath} but the` +
        ` story has no review_status: pending. The .pr-review.md flow was` +
        ` retired in S-458 — review feedback now lives in the ## Review Log` +
        ` of the story's change.md. Delete the stale file by hand and re-run` +
        ` bl review if you actually need a feedback cycle.`,
    );
    process.exit(1);
  }

  const sessionPrompt = loadPrompt(prep.promptName, prep.promptVars, {
    agent: config.agent,
    config,
  });

  if (prep.reviewPending) {
    info('Review pending in story — using review-feedback prompt.\n');
  }

  const status = launchSession({
    mode: 'workon',
    parsed,
    title: prep.title,
    worktreePath: prep.effectiveWorktreePath,
    unitDir: prep.unitDir,
    branchName: prep.branchName,
    sessionPrompt,
    roostDir: config.roostDir,
    backlogRoot: config.backlogRoot,
    isNewWorktree: prep.isNewWorktree,
    agent: config.agent,
    forceNew: prep.reviewPending,
    config,
    additionalPrompt,
    returnOnExit: true,
    // The same key `bl run` gives this session (S-904): the round's fix
    // while a review is pending.
    tokensStep: prep.reviewPending ? tokensStepKey('fix', prep.reviewRound) : 'implement',
    tokensIndexPath: prep.indexPath,
  });
  if (!status) info(implementNextSteps(parsed.id));
  // launchSession returns exitStatus of the agent: a kill is nonzero.
  process.exit(status);
}

/**
 * `bl implement`'s closing line: review comes before merge, which refuses
 * work that was never reviewed (F-36 D3).
 */
export function implementNextSteps(id) {
  return `\nNext: bl review ${id}, then bl merge ${id}.`;
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl implement <story-id> [options]

Arguments:
  <story-id>           A story ID (S34, S-34). A story whose dependencies
                       aren't all merged (done) is deferred, not launched.

Options:
  -A, --agent <id>     Agent provider (e.g. "claude", "codex", "gemini")
  -P, --prompt <text>  Discuss <text> with the agent first
  --help               Show this help

Creates/resumes the story's worktree in its repo (its component's) and
launches an interactive agent session. Several targets (bl implement S-1 S-2)
open one tmux window each.`);
    process.exit(0);
  }
  refuseStoryRepo('implement', args);

  const baseConfig = loadConfig({ agent: args.agent });

  const positionals = args.positional;
  if (positionals.length === 0) {
    console.error('Usage: bl implement <id...>  (story IDs)');
    process.exit(1);
  }

  const { startable, deferred, errors, notices } = resolveWorkonTargets(positionals, baseConfig);

  for (const n of notices) info(n);
  for (const e of errors) console.error(e);

  if (deferred.length > 0) {
    info('');
    info('Deferred (dependencies not yet merged):');
    for (const d of deferred) {
      info(`  ${d.id} — ${d.title}  (blocked on: ${d.blockers.join(', ')})`);
    }
    info('');
  }

  if (startable.length === 0) {
    if (deferred.length > 0) {
      console.error(
        'No startable stories — every resolved story is blocked by unmerged ' +
          'dependencies (see above). Merge them, then re-run.',
      );
    } else if (errors.length === 0 && notices.length === 0) {
      console.error('No stories to work on.');
    }
    process.exit(1);
  }

  if (startable.length > 1) {
    console.error('bl implement takes one story here; bl implement <id...> opens one tmux window per story.');
    process.exit(1);
  }

  return workonOne(normalizeId(startable[0].id), baseConfig, {
    additionalPrompt: args.prompt,
  });
}
