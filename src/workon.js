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
 * Dependency gating: a story is only launched when every story it waits for
 * (the blockers of the run and order edges on it, `storyDependencies` of
 * `readEdges`, F-111 D4) is already closed (i.e. merged).
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
import { findStoryDir, findComponentDir, readAllStories, refuseStoryRepo, storyRepoOrExit } from './story.js';
import {
  ensureWorktree,
  installDeps,
  runStagePlugins,
  workonDue,
  workonDone,
  prepareWorktreeOnce,
  loadPrompt,
  loadSchema,
  launchSession,
} from './session.js';
import { featureSessionVars } from './feature.js';
import { readEdges, storyDependencies } from './blockers.js';
import { storyUnit, storyAsOrdered, unitVars } from './unit.js';
import { applyFixOutcome, openUnitChange, readChange, unitChange } from './change-doc.js';
import { tokensStepKey } from './tokens.js';
import { loadFlow } from './flow.js';
import { enterVerb, implementVerbOf, nowAt, roundOf, startOf } from './transition.js';
import { acquireLock, releaseLock } from './lock.js';
import { takeUnitLocksOrExit } from './unit-lock.js';
import { syncAndCommit } from './sync.js';
import { sessionEffort, storyEffort } from './effort.js';
import {
  isScripted,
  recordScriptedRun,
  runImplementPlugin,
  scriptedEscalation,
  scriptedSummary,
  writeStoryEscalation,
} from './scripted.js';

export function idNum(id) {
  return parseInt(String(id).replace(/\D/g, ''), 10) || 0;
}

/**
 * Resolve workon targets from positional args, then split them by dependency
 * readiness.
 *
 * Component IDs expand to their refined stories (draft stories must be
 * refined first; closed ones are complete). An explicitly-named story is
 * included when `flow.json`'s `implement` row starts from its status, or its
 * `fix` row does when its review position is `fixing` (`implementVerbOf`,
 * `startOf`); any
 * other is reported as a notice with the table's refusal. Named targets
 * outrank component-expanded ones on dedup.
 *
 * Each resolved target is then classified:
 *   - `startable` — every story it waits for is already closed.
 *   - `deferred`  — at least one is not; `blockers` lists them.
 * A dependency that is itself a not-yet-merged story (even one in the same
 * batch) is unmet, so the dependent defers.
 *
 * @returns {{ startable: Array, deferred: Array, errors: string[],
 *             notices: string[] }}
 */
export function resolveWorkonTargets(positionals, config) {
  const flow = loadFlow(config.backlogRoot);
  const closed = (s) => flow.meets('story', s, 'done');
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
    const unit = storyUnit(story, config);
    const { refusal } = startOf(config, 'story', unit, implementVerbOf('story', unit));
    if (refusal) {
      notices.push(`${refusal} — skipping.`);
      continue;
    }
    addStory(story, 'named');
  }

  const startable = [];
  const deferred = [];
  const waits = storyDependencies(readEdges(config));
  for (const t of byId.values()) {
    const blockers = (waits.get(t.id) ?? []).filter((d) => !closed(statusById.get(d)));
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
 * @returns {Promise<{ repoName: string, repoPath: string, branchName: string,
 *             worktreePath: string, isNewWorktree: boolean }>}
 */
export async function prepareStoryRepo(parsed, found, config, repoName, { role = 'primary', strict = false } = {}) {
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

  return prepareWorktreeOnce(repoPath, branchName, async () => {
    const { effectiveWorktreePath, isNewWorktree } = await ensureWorktree(
      repoPath,
      branchName,
      worktreePath,
      config.backlogRoot,
    );
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
 * `bl run S-n`'s prep. A story whose review position is `fixing` (its
 * transition log, F-69 D5) gets the `workon-review` prompt over `workon`.
 *
 * Side-effecting and may `process.exit(1)` on a hard guard (no repo,
 * uncommitted changes, local main ahead) — same guards as a single workon.
 * `strict` makes the preparation strict (`bl run`).
 */
async function prepareStoryWorktree(parsed, found, config, { strict = false } = {}) {
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
  } = await prepareStoryRepo(parsed, found, config, repoName, { strict });
  // The story's own unit directory, where its session starts (F-60 D3).
  const unitDir = unitDirFor(config, branchName);

  // Creating the branch opens the change: one `repos:` entry, the story's repo.
  const change = await openUnitChange(config.backlogRoot, { id: parsed.id, title, indexPath }, branchName, [repoName]);

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
  // A unit whose review position is `fixing`, whatever its status, gets the
  // fix session (F-69 D3), for its log's round (D5).
  const reviewPending = implementVerbOf('story', { fm, change: unitState.change }) === 'fix';
  const reviewRound = roundOf('story', fm, unitState.change);
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
 * @returns {Promise<{ cfg, parsed, worktreePath, unitDir, branchName, isNewWorktree,
 *             ordered, baseVars, reviewPending, targetRepoName,
 *             otherWorktrees }>}
 */
export async function prepareStoryRun(parsed, found, config, { unit = storyUnit(found, config) } = {}) {
  // The story's repo's overrides and plugin layer, whatever config the caller loaded.
  config = configForRepo(config, found.unitRepo);
  const prep = await prepareStoryWorktree(parsed, found, config, { strict: true });
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

/**
 * `bl implement` of a scripted story (F-71 D3): its command in the worktree in
 * place of a session, recorded on the story and committed to the backlog.
 * `runner` needs `shell`.
 *
 * @returns {Promise<number>} the exit status
 */
export async function implementScripted(parsed, found, config, prep, runner) {
  const { fm } = parseFrontmatter(readFileSync(prep.indexPath, 'utf8'));
  const repo = prep.promptVars.primaryRepo;
  const session = featureSessionVars(storyUnit(found, config));
  const result = runImplementPlugin({
    id: parsed.id,
    title: prep.title,
    fm,
    plugins: config.plugins,
    vars: {
      ...session,
      storyId: parsed.id,
      worktreePath: prep.effectiveWorktreePath,
      branchName: prep.branchName,
      repoPath: config.reposByName[repo],
      repoName: repo,
      roostDir: config.roostDir,
      backlogDir: config.backlogRoot,
    },
    worktreePath: prep.effectiveWorktreePath,
    runner,
  });
  const summary = scriptedSummary(parsed.id, result);
  await acquireLock(config.backlogRoot);
  try {
    await recordScriptedRun({
      backlogRoot: config.backlogRoot,
      indexPath: prep.indexPath,
      changePath: prep.promptVars.changeAbsPath,
      id: parsed.id,
      repo,
      at: nowAt(),
      result,
    });
    if (result.kind === 'failed') {
      const { reason, details } = scriptedEscalation(parsed.id, result, `bl implement ${parsed.id}`);
      await writeStoryEscalation(config.backlogRoot, prep.indexPath, `${reason}\n\n${details}`);
    }
    await syncAndCommit(config, { message: `chore: ${summary.split('\n')[0].slice(0, 120)}`, storyIds: [parsed.id] });
  } finally {
    releaseLock(config.backlogRoot);
  }
  info(summary);
  if (result.kind === 'failed') {
    console.error(`See ## Escalation in ${prep.promptVars.storyRelPath}.`);
    return 1;
  }
  if (result.kind === 'changed') info(`\nNext: bl run ${parsed.id}: the test gate, the push and the PR.`);
  return 0;
}

/** Single-story interactive workon: `bl implement <story>`. */
async function workonOne(parsed, baseConfig, { additionalPrompt } = {}) {
  const found = findStoryDir(parsed, baseConfig);
  if (!found) {
    console.error(`Story ${parsed.id} not found in backlog`);
    process.exit(1);
  }
  // The story's repo's overrides and plugin layer apply (F-51 D4).
  const config = configForRepo(baseConfig, found.unitRepo);
  // The story's work unit lock, held to the end of the session (F-122 D4),
  // before prep or `enterVerb` writes anything.
  takeUnitLocksOrExit(config, [{ id: parsed.id, kind: 'story', indexPath: found.indexPath }], `implement ${parsed.id}`);

  const prep = await prepareStoryWorktree(parsed, found, config);

  if (prep.legacyPrReview && !prep.reviewPending) {
    console.error(
      `Found a legacy .pr-review.md in ${prep.effectiveWorktreePath} but the` +
        ` story is not in fixing. The .pr-review.md flow was` +
        ` retired in S-458 — review feedback now lives in the ## Review Log` +
        ` of the story's change.md. Delete the stale file by hand and re-run` +
        ` bl review if you actually need a feedback cycle.`,
    );
    process.exit(1);
  }

  const { fm } = parseFrontmatter(readFileSync(prep.indexPath, 'utf8'));
  if (!prep.reviewPending && isScripted(fm)) {
    const { defaultRunner } = await import('./feature-run.js');
    process.exit(await implementScripted(parsed, found, config, prep, defaultRunner()));
  }

  // bl, not the agent, records that the story started (F-69 D3): a fix from
  // `escalated` or `in_progress` goes back to `fixing`.
  const verb = prep.reviewPending ? 'fix' : 'implement';
  await enterVerb(config.backlogRoot, { kind: 'story', indexPath: prep.indexPath }, verb);

  // A fix session returns its outcome in the outcome file (F-68 D1, D3).
  const vars = prep.reviewPending ? { ...prep.promptVars, outcomeCarrier: 'file' } : prep.promptVars;
  const sessionPrompt = loadPrompt(prep.promptName, vars, {
    agent: config.agent,
    config,
  });

  if (prep.reviewPending) {
    info('Review pending in story — using review-feedback prompt.\n');
  }

  // The change document the fix session found, which places a story with no log.
  const changeBefore = prep.reviewPending ? readChange(prep.promptVars.changeAbsPath) : null;
  const ret = await launchSession({
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
    // The story's own level (F-85 D4).
    effort: sessionEffort(config, { mode: 'workon', stories: [{ id: parsed.id, effort: storyEffort(fm) }] }),
    ...(prep.reviewPending ? { schema: loadSchema('fix') } : {}),
  });
  const status = prep.reviewPending ? ret.status : ret;
  if (prep.reviewPending) {
    const unit = { id: parsed.id, kind: 'story', indexPath: prep.indexPath };
    await applyFixOutcome(config.backlogRoot, unit, ret, changeBefore);
  }
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
  -A, --agent <id>     Agent provider (e.g. "claude", "codex", "gemini", "local")
  --model <m>          Model of the -A configuration (needs -A)
  -P, --prompt <text>  Discuss <text> with the agent first
  --help               Show this help

Creates/resumes the story's worktree in its repo (its component's) and
launches an interactive agent session. A scripted story (plugins-implement)
runs its command there instead and commits the result; no agent starts.
Several targets (bl implement S-1 S-2) open one tmux window each.`);
    process.exit(0);
  }
  refuseStoryRepo('implement', args);

  const baseConfig = loadConfig({ agent: args.agent, model: args.model });

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
