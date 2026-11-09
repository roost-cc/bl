/**
 * feature-cmd.js — the feature-level flow behind the id-dispatched verbs.
 *
 *   bl list --features [-a]
 *   bl new --feature --title <t> --theme <slug> [--epic <E-id>] [--rounds <n>] [--body-file <p>] [S-id…]
 *   bl refine    <F-id> [-P <text>] [-A <agent>]
 *   bl approve   <F-id> [--force]
 *   bl status    <F-id|S-id|C-id>
 *   bl implement <F-id> [-P <text>] [-A <agent>]
 *   bl review    <F-id|S-id> [-P <text>] [-r <repo>] [-A <agent>]
 *   bl run       <F-id|S-id> [--resume] [--interactive] [--plan] [--max-rounds <n>]
 *   bl merge     <F-id> [--keep] [--switch-main] [--no-review]
 *
 * A feature is one branch, one PR, one review cycle and one merge over an
 * ordered set of stories. The operator touches it twice: `approve` (the spec
 * gate) and `merge`. Everything between is agent work driven by the
 * `feature-*` prompts.
 *
 * `bl run|implement|review|merge|refine|status|approve F-n` call the verb
 * handlers exported here (src/verbs.js). `bl run|review|status S-n` call
 * `cmdRunStory`, `cmdReviewStory` and `cmdStatusStory`, which share the
 * feature handlers' code with the story as a unit (unit.js): one loop, one
 * review step.
 */

import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { basename, join, relative, dirname } from 'path';
import { execFileSync, execSync } from 'child_process';
import {
  configForRepo,
  configurationLabel,
  independentReviewers,
  normalizeId,
  parseFrontmatter,
  slugify,
  info,
  runForgeOp,
  runPlugins,
  worktreePathFor,
  unitDirFor,
  unitDirOf,
} from './config.js';
import { readAllStories, findExistingWorktree, isSessionRunning, findUnitPRs, refuseStoryRepo } from './story.js';
import { effortLabel, sessionEffort } from './effort.js';
import { findEpic, findTheme, normalizeEpicId, readAllThemes, recordThemeState, themeBriefList } from './theme.js';
import { renderTemplate } from './template.js';
import { hasFilter, featureMatches, featureEpicId } from './filter.js';
import {
  normalizeFeatureId,
  findFeature,
  readAllFeatures,
  nextFeatureId,
  featuresRoot,
  featureBranchName,
  featureSessionVars,
  resolveFeatureStories,
  orderStoriesByDeps,
  outsideBlockers,
  featureRepoOrder,
  reposForFeature,
  LEAD_REPO,
  extractSection,
  sectionHasContent,
  resolveFeaturePlugins,
  FEATURE_WORKABLE_STATUSES,
  DEFAULT_REVIEW_ROUNDS_MAX,
} from './feature.js';
import { heldLines } from './blockers.js';
import {
  ensureWorktree,
  launchSession,
  loadPrompt,
  loadSchema,
  workonDue,
  workonDone,
  prepareWorktreeOnce,
} from './session.js';
import { syncBranchWithMain, reportNoOpenPR } from './review.js';
import { featureUnit, storyUnit, storyAsOrdered, unitVars } from './unit.js';
import { mergeGates, noReviewLines, reportMergeGates } from './merge-gates.js';
import { integrateForMerge } from './merge-integrate.js';
import { prepareStoryRun, otherWorktreesLine, implementNextSteps } from './workon.js';
import { reviewSkipped } from './scripted.js';
import { chooseSyncRunner, cleanupOneRepo, commitFmShape, runBacklogSync, unionLandedCommits } from './cleanup.js';
import { reviewOutcome, summarizeLatestReviewSession } from './review-log.js';
import {
  runStatePath,
  ensureRunDir,
  RUN_DIR,
  localTime,
  changePrContent,
  unitDescription,
  hasHeadlessConfiguration,
} from './feature-run.js';
import { getProvider, hasProvider } from './agents/index.js';
import {
  addTokenTotals,
  addUsageTotals,
  applyTokensToFrontmatter,
  applyFeatureTokens,
  mergeStepTokens,
  tokensStepKey,
  transcriptDirs,
} from './tokens.js';
import { updateSpecFile, withSpecLock } from './spec-file.js';
import { atomicWriteFile } from './atomic-write.js';
import { tok, tokenFields } from './report.js';
import { acquireLock, releaseLock, withLock } from './lock.js';
import { failPoint } from './feature-links.js';
import { prepareBody } from './body.js';
import { scanDeferred, DEFERRED_HEADING } from './deferred.js';
import { readAllTasks, tasksOf } from './task.js';
import { commitChangedSince, dirtySnapshot, failedCommitPending, failedCommitRecord } from './backlog-commit.js';
import { loadBacklog } from './backlog-graph.js';
import { commitAndRecord, reportBacklogCommit } from './sync.js';
import { applyRefineStatus, refineAndCommit } from './refine.js';
import {
  applyFixOutcome,
  changeName,
  ensureChange,
  listChanges,
  openUnitChange,
  readChange,
  recordMerge,
  setRepo,
  updateChange,
} from './change-doc.js';
import { deployableRepos, mainCommits, tagRepos, writeReleaseManifest } from './release.js';
import { loadFlow, statusWords } from './flow.js';

const POINTS_GUIDELINE = { min: 8, max: 20 };

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Re-read, mutate and write a feature's frontmatter and body: `updateSpecFile`
 * (F-67 D1), under the feature's spec lock, fence-checked and replaced
 * atomically. `mutate(fm, body)` returns the new body, `undefined` (body
 * unchanged) or `false` (write nothing). Every error propagates.
 */
export function updateFeature(config, feature, mutate) {
  return updateSpecFile(config.backlogRoot, feature.indexPath, mutate);
}

/**
 * The end of `bl merge F-n`: mark every story of the feature not yet closed
 * done, then the feature, and fold the stories' `tokens_*` (BigInt sums,
 * `addTokenTotals`) and `tokens_by_step` into the feature's. Each spec is
 * read, changed and written through `updateSpecFile`, one at a time, so a
 * token entry a session writes meanwhile is kept and a failed write leaves
 * the previous spec. The caller holds the backlog lock: it is the outer lock,
 * each spec lock the inner one, and no two spec locks are held at once
 * (F-67 D4). The fold happens once, by the merge that finds the feature not
 * yet closed. `decided` is the `commit:` shape to record, or null.
 */
export function markFeatureMerged(config, feature, stories, { decided, stamp }) {
  const flow = loadFlow(config.backlogRoot);
  const tokens = { input: 0n, output: 0n, cache_creation: 0n, cache_read: 0n };
  let anyTokens = false;
  let storySteps = {};
  for (const s of stories) {
    // Spec lock inside the caller's backlog lock (F-67 D4).
    const wrote = updateSpecFile(config.backlogRoot, s.indexPath, (fm) => {
      if (addTokenTotals(tokens, fm)) anyTokens = true;
      storySteps = mergeStepTokens(storySteps, fm.tokens_by_step);
      if (flow.meets('story', fm.status, 'done')) return false;
      fm.status = 'done';
      if (decided !== null) fm.commit = decided;
      fm.completed = stamp;
    });
    if (wrote) info(`Marked ${s.id} done.`);
  }

  // Spec lock inside the caller's backlog lock (F-67 D4), after every story's is released.
  updateFeature(config, feature, (fm) => {
    // The stories are folded in once, by the merge that marks the feature
    // done: a caller that loaded it before another merge finished finds it
    // closed here, under the lock, and adds nothing again.
    if (!flow.meets('feature', fm.status, 'done')) {
      if (addTokenTotals(tokens, fm)) anyTokens = true;
      if (anyTokens) applyTokensToFrontmatter(fm, tokens);
      // Per step as well, key by key (S-904): the feature's own keys first.
      const steps = mergeStepTokens(fm.tokens_by_step, storySteps);
      if (Object.keys(steps).length > 0) fm.tokens_by_step = steps;
    }
    fm.status = 'done';
    if (decided !== null) fm.commit = decided;
    fm.completed = stamp;
  });
}

function parsedFor(feature) {
  const m = feature.id.match(/^F-(\d+)$/);
  return { id: feature.id, num: m ? m[1] : '0' };
}

function renderStoriesPlan(config, ordered) {
  if (ordered.length === 0) return '(no stories)';
  return ordered
    .map(
      (s, i) =>
        `${i + 1}. ${s.id} — ${s.title} (${s.points} pts, ${s.status})\n   file: ${join(config.backlogRoot, s.storyRelPath)}`,
    )
    .join('\n');
}

/**
 * The `{{storyRepos}}` line: a feature's repos derived from its stories, in
 * the order every step uses (`featureRepoOrder`, F-52 D3), or a story unit's
 * one repo, its component's (`unitRepo`, F-52 D1).
 */
function storyReposList(unit, stories = []) {
  const names = unit.kind === 'story' ? [unit.unitRepo].filter(Boolean) : featureRepoOrder(stories);
  return names.length > 0 ? names.join(', ') : '(none)';
}

/**
 * Exit naming every story of the feature with no repo (no component, an
 * unknown one, or one with no `repo`). The derived repo set drops such a
 * story (F-52 D3), so preparing, reviewing or merging without this check
 * would leave its work out while treating it as part of the feature.
 */
function exitOnStoryWithoutRepo(feature, stories) {
  const noRepo = stories.filter((s) => !s.unitRepo);
  if (noRepo.length > 0) {
    console.error(
      `Feature ${feature.id}: ${noRepo.map((s) => `${s.id} (component ${s.componentId || '(none)'})`).join(', ')} has no repo; a story's repo is its component's, so give the component a repo or move the story to one that has it.`,
    );
    process.exit(1);
  }
}

/** The first story that puts `repoName` in a feature. */
function repoSource(stories, repoName) {
  const s = stories.find((st) => st.unitRepo === repoName);
  return s ? `story ${s.id}, component ${s.componentId || '(none)'}` : 'no story';
}

/**
 * Sum agent token usage across the feature's worktrees and write it to the
 * feature frontmatter. Best-effort: never blocks a command.
 */
export function recordFeatureTokens(feature, config) {
  try {
    const provider = getProvider(config.agent);
    // Under the spec lock, like every token writer of the spec (S-904), the
    // transcript read included: totals read before it could predate a
    // session difference written meanwhile, and would put them below the map.
    withSpecLock(feature.indexPath, () => {
      const totals = { input: 0n, output: 0n, cache_creation: 0n, cache_read: 0n };
      let any = false;
      for (const dir of transcriptDirs(reposForFeature(feature, config))) {
        let u;
        try {
          u = provider.getTokens(dir, `${feature.id}:`);
        } catch {
          return;
        }
        if (!u) continue;
        // A count that is not exact (an unsafe number) leaves the stored totals alone.
        if (!addUsageTotals(totals, u)) return;
        any = true;
      }
      if (!any) return;
      // Nested in this hold: `withSpecLock` is re-entrant within a process.
      updateFeature(config, feature, (fm) => {
        // A merged feature's totals hold its stories' too, folded in once by
        // `bl merge`: a re-read of its own transcripts must not replace them.
        if (!loadFlow(config.backlogRoot).meets('feature', fm.status, 'done')) applyFeatureTokens(fm, totals);
      });
    });
  } catch {
    // bookkeeping only
  }
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const line = (r) => headers.map((_, i) => pad(r[i], widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * `bl list --features`. With a value-axis filter (`--theme`, `--epic`,
 * `--feature`, `--component`; `bl list --epic` implies `--features`), the
 * matching features are grouped by epic (F-51 D2), each with its stories and
 * points done/total.
 * @param {object} args
 * @param {object} config
 * @param {{ filter?: object, ctx?: object }} [opts]  from `filter.js` `filterFromArgs`
 */
export function cmdList(args, config, { filter = null, ctx = null } = {}) {
  const flow = loadFlow(config.backlogRoot);
  if (filter && hasFilter(filter)) return listByEpic(args, config, filter, ctx);
  const features = readAllFeatures(config).filter((f) => args.all || !flow.meets('feature', f.status, 'done'));
  if (features.length === 0) {
    info('No features found.');
    return;
  }
  const all = readAllStories(config);
  const rows = features.map((f) => {
    const { stories } = resolveFeatureStories(f, config, all);
    const done = stories.filter((s) => flow.meets('story', s.status, 'done')).length;
    return [
      f.id,
      f.status,
      f.points,
      `${done}/${f.stories.length}`,
      featureRepoOrder(stories).join(', ') || '-',
      f.title,
    ];
  });
  printTable(['ID', 'Status', 'Pts', 'Done', 'Repo', 'Title'], rows);
}

/** Stories and points, done and total, over a feature's resolved stories. */
export function featureProgress(stories, flow) {
  const closed = stories.filter((s) => flow.meets('story', s.status, 'done'));
  const pts = (list) => list.reduce((sum, s) => sum + (parseInt(s.points, 10) || 0), 0);
  return {
    stories: `${closed.length}/${stories.length}`,
    points: `${pts(closed)}/${pts(stories)}`,
  };
}

/**
 * The features that pass `filter`, grouped by epic in id order, then those
 * with no epic. Without `-a`, closed features are left out of
 * the tables; an epic's header still counts them.
 */
function listByEpic(args, config, filter, ctx) {
  const flow = loadFlow(config.backlogRoot);
  const all = readAllStories(config);
  const matching = ctx.features
    .map((f) => ({ f, stories: resolveFeatureStories(f, config, all).stories }))
    .filter(({ f, stories }) => featureMatches(f, stories, filter));
  const shown = matching.filter(({ f }) => args.all || !flow.meets('feature', f.status, 'done'));
  if (shown.length === 0) {
    info(matching.length > 0 ? 'No open features match. Use -a/--all to include done ones.' : 'No features match.');
    return;
  }
  const featureNum = (id) => parseInt(id.replace(/^F-/, ''), 10);
  const epicNum = (id) => parseInt(id.slice(1), 10);
  const groups = new Map();
  for (const entry of shown) {
    const epicId = featureEpicId(entry.f) ?? '';
    if (!groups.has(epicId)) groups.set(epicId, []);
    groups.get(epicId).push(entry);
  }
  const order = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : epicNum(a) - epicNum(b)));
  order.forEach((epicId, i) => {
    if (i > 0) console.log('');
    if (epicId) {
      const epic = ctx.epics.find((e) => e.id === epicId);
      const members = matching.filter(({ f }) => featureEpicId(f) === epicId);
      const done = members.filter(({ f }) => flow.meets('feature', f.status, 'done')).length;
      const name = epic ? ` · ${epic.title} [${epic.status}]` : ' (no directory)';
      console.log(`${epicId}${name} — ${done}/${members.length} features done`);
    } else {
      console.log('No epic');
    }
    const rows = groups
      .get(epicId)
      .sort((a, b) => featureNum(a.f.id) - featureNum(b.f.id))
      .map(({ f, stories }) => {
        const p = featureProgress(stories, flow);
        return [f.id, f.status, p.stories, p.points, f.theme || '-', f.title];
      });
    printTable(['ID', 'Status', 'Stories', 'Points', 'Theme', 'Title'], rows);
  });
  console.log(`\n${shown.length} feature${shown.length === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

/**
 * A new feature's theme and epic (F-51 D1, D2): `--theme`, else the theme of
 * `--epic`. Exits 1 when no theme is given, the theme or epic does not
 * exist, or the epic is in another theme, so nothing is written.
 * @returns {{ theme: string, epic: string | null }}
 */
export function featureValueAxis(args, config) {
  const fail = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  const given = (v) => v != null && v !== false && v !== true;
  let epic = null;
  if (given(args.epic)) {
    const parsed = normalizeEpicId(args.epic);
    if (!parsed) fail(`invalid epic id: '${args.epic}' (expected E<n>, E50 upward)`);
    epic = findEpic(parsed, config);
    if (!epic) fail(`Epic ${parsed.id} not found under epics/.`);
  }
  const slug = given(args.theme) ? String(args.theme).trim() : epic?.theme || '';
  const known = () =>
    readAllThemes(config)
      .map((t) => t.id)
      .join(', ') || '(none)';
  if (!slug) {
    fail(
      `bl new --feature: pass --theme <slug>; every feature names its theme (known themes: ${known()}). ` +
        `bl new --theme <slug> --title <t> creates one.`,
    );
  }
  const theme = findTheme(slug, config);
  if (!theme) fail(`Theme ${slug} not found under themes/. Existing: ${known()}`);
  if (epic && epic.theme !== theme.id) {
    fail(`${epic.id} is in theme ${epic.theme || '(none)'}, not ${theme.id}; a feature's epic is in its theme.`);
  }
  return { theme: theme.id, epic: epic?.id ?? null };
}

/**
 * Scaffold a feature. `beforeCreate()` runs as soon as the backlog lock is
 * held, before any write, to check what it reads there. `afterCreate(feature)`
 * runs once its file is written, still under the lock:
 * `bl new --feature … S-1` moves its stories in there. If writing the feature
 * or `afterCreate` throws, the feature directory is removed and bl exits 1,
 * unless the error has `keepFeature` set (a story still names the feature).
 *
 * @param {object} args
 * @param {object} config
 * @param {{ beforeCreate?: () => void, afterCreate?: (feature: object) => void }} [opts]
 */
export async function cmdNew(args, config, { beforeCreate = null, afterCreate = null } = {}) {
  const title = args.title && args.title !== true ? String(args.title) : '';
  if (!title) {
    console.error('bl new --feature: --title is required.');
    process.exit(1);
  }
  // A feature names no repo (F-52 D3): its repos are its stories' components'.
  if (args.repo != null && args.repo !== false) {
    console.error(
      'bl new --feature: unknown option "--repo": a feature\'s repos come from its stories\' components; give each story a component in the repo instead.',
    );
    process.exit(1);
  }
  const rounds = parseInt(String(args.rounds ?? DEFAULT_REVIEW_ROUNDS_MAX), 10);
  if (!Number.isInteger(rounds) || rounds < 1) {
    console.error('bl new --feature: --rounds must be a positive integer.');
    process.exit(1);
  }
  const valueAxis = featureValueAxis(args, config);

  let customBody = null;
  if (args['body-file'] != null) {
    if (args['body-file'] === true) {
      console.error('--body-file requires a path');
      process.exit(1);
    }
    try {
      customBody = prepareBody(readFileSync(String(args['body-file']), 'utf8'));
    } catch (err) {
      console.error(`Failed to read --body-file: ${err.message}`);
      process.exit(1);
    }
  }

  await acquireLock(config.backlogRoot);
  if (beforeCreate) beforeCreate();

  const id = nextFeatureId(config);
  const dirName = `${id.replace('-', '')}-${slugify(title)}`;
  const dir = join(featuresRoot(config), dirName);
  const indexPath = join(dir, 'index.md');
  if (existsSync(dir)) {
    console.error(`Feature directory already exists: ${relative(config.backlogRoot, dir)}`);
    process.exit(1);
  }
  const vars = {
    featureId: id,
    title,
    reviewRoundsMax: String(rounds),
    today: today(),
  };
  // The template holds `theme:` and `epic:` after `title:`; a feature
  // with no epic leaves the key out.
  const content = renderTemplate('feature', {
    values: {
      feature_id: id,
      title,
      theme: valueAxis.theme,
      epic: valueAxis.epic ?? undefined,
      review_rounds_max: vars.reviewRoundsMax,
      added: vars.today,
    },
    vars,
    body: customBody,
  });
  const rel = relative(config.backlogRoot, indexPath);
  try {
    mkdirSync(dir, { recursive: true });
    failPoint('feature');
    atomicWriteFile(config.backlogRoot, indexPath, content);
    info(`\nNew feature: ${id} — ${title}`);
    info(`Created: ${rel}`);
    if (afterCreate) afterCreate(findFeature(normalizeFeatureId(id), config));
  } catch (err) {
    if (err.keepFeature) {
      console.error(`bl new --feature: ${err.message}.`);
      process.exit(1);
    }
    // The directory is this invocation's: it did not exist above.
    rmSync(dir, { recursive: true, force: true });
    console.error(`bl new --feature: ${err.message}. Rolled back: ${id} was not created.`);
    process.exit(1);
  }

  info(`\nNext: bl refine ${id}`);
  process.stdout.write(`${rel}\n`);
}

// ---------------------------------------------------------------------------
// refine
// ---------------------------------------------------------------------------

export function cmdRefine(args, config, feature) {
  if (loadFlow(config.backlogRoot).meets('feature', feature.status, 'done')) {
    console.error(`Feature ${feature.id} is ${feature.status}; nothing to refine.`);
    process.exit(1);
  }
  const all = readAllStories(config);
  const { stories } = resolveFeatureStories(feature, config, all);

  info(`Feature : ${feature.id} — ${feature.title}`);
  info(`Status  : ${feature.status}`);
  info(`Repos   : ${storyReposList(feature, stories)}`);
  info(`File    : ${feature.featureRelPath}`);
  info('');
  if (feature.status !== 'draft') {
    info(`Feature ${feature.id} is already ${feature.status}. Re-refining.\n`);
  }

  const vars = {
    featureId: feature.id,
    storyId: feature.id,
    title: feature.title,
    status: feature.status,
    featureRelPath: feature.featureRelPath,
    featureAbsPath: feature.indexPath,
    roostDir: config.roostDir,
    backlogDir: config.backlogRoot,
    storyRepos: storyReposList(feature, stories),
    storiesList:
      stories.length > 0
        ? stories.map((s) => `- ${s.id} — ${s.title} (${s.points} pts, ${s.status}) — ${s.storyRelPath}`).join('\n')
        : '(none yet)',
    pointsMin: String(POINTS_GUIDELINE.min),
    pointsMax: String(POINTS_GUIDELINE.max),
    themeBrief: themeBriefList(config, feature.theme),
  };
  const sessionPrompt = loadPrompt('feature-refine', vars, {
    agent: config.agent,
    config,
  });
  refineAndCommit(
    {
      mode: 'refine',
      parsed: parsedFor(feature),
      title: feature.title,
      worktreePath: config.backlogRoot,
      branchName: 'main',
      sessionPrompt,
      roostDir: config.roostDir,
      backlogRoot: config.backlogRoot,
      isNewWorktree: false,
      agent: config.agent,
      config,
      additionalPrompt: args.prompt,
      recordTokens: false,
      sessionName: `${feature.id}: refine — ${feature.title}`,
      effort: sessionEffort(config, { mode: 'refine' }),
      schema: loadSchema('feature-refine'),
    },
    `chore: refine ${feature.id}`,
    [feature.id],
    // A premise that does not hold puts the feature back to draft (F-68 D2).
    ({ premise_holds, refined, reason }) =>
      applyRefineStatus(config.backlogRoot, feature, !premise_holds ? 'draft' : refined ? 'refined' : null, reason),
  );
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export async function cmdApprove(args, config, feature) {
  // Held from the state check through the commit (S-1330): the feature is
  // read again under it, so a status another command wrote while approve
  // waited is the one checked, and no other command commits the approval
  // first, under its own message.
  await acquireLock(config.backlogRoot);
  try {
    const fresh = { ...config, backlogGraph: loadBacklog(config, { reload: true }) };
    await approveLocked(args, config, findFeature(normalizeFeatureId(feature.id), fresh) ?? feature);
  } finally {
    releaseLock(config.backlogRoot);
  }
}

async function approveLocked(args, config, feature) {
  if (loadFlow(config.backlogRoot).meets('feature', feature.status, 'done')) {
    console.error(`Feature ${feature.id} is ${feature.status}.`);
    process.exit(1);
  }
  if (feature.status !== 'draft' && feature.status !== 'refined') {
    info(`Feature ${feature.id} is already ${feature.status}.`);
    if (feature.status === 'approved') await retryApprovalCommit(config, feature);
    return;
  }
  if (feature.status === 'draft' && !args.force) {
    console.error(`Feature ${feature.id} is still a draft — run \`bl refine ${feature.id}\` first (or pass --force).`);
    process.exit(1);
  }
  // An open escalation blocks `bl run`, so approving past it only
  // moves the refusal later. Like the story-list gates, --force does not
  // bypass it (--force only skips the draft gate).
  const escalation = extractSection(feature.body, 'Escalation');
  if (sectionHasContent(escalation)) {
    console.error(
      `Feature ${feature.id} has content in ## Escalation: "${escalation.trim().split('\n')[0]}"\n` +
        'Record the decision in the Design (or the Review Log) and set `## Escalation` to `None.`, then approve again.',
    );
    process.exit(1);
  }
  const all = readAllStories(config);
  const { stories } = resolveFeatureStories(feature, config, all);
  if (stories.length === 0) {
    console.error(
      `Feature ${feature.id} has no stories. Refine it (or add stories with \`bl new --feature ${feature.id} …\`) first.`,
    );
    process.exit(1);
  }

  const points = stories.reduce((sum, s) => sum + (parseInt(s.points, 10) || 0), 0);
  if (points < POINTS_GUIDELINE.min || points > POINTS_GUIDELINE.max) {
    info(
      `note: ${feature.id} is ${points} points; the guideline is ${POINTS_GUIDELINE.min}–${POINTS_GUIDELINE.max} per feature.`,
    );
  }
  const blockers = outsideBlockers(stories, all, loadFlow(config.backlogRoot));
  if (blockers.length > 0) {
    info(`note: ${feature.id} depends on work outside the feature that is not done yet:`);
    for (const b of blockers) info(`  ${b.story} depends on ${b.dep} (${b.status})`);
    info('  `bl run` and `bl implement` will refuse until these are merged or pulled into the feature.');
  }

  // An edit outside bl since the read (an editor) is not approved over.
  const wrote = updateFeature(config, feature, (fm) => {
    if ((fm.status ?? 'draft') !== feature.status) return false;
    fm.status = 'approved';
    fm.approved = today();
  });
  if (!wrote) {
    console.error(`Feature ${feature.id} changed while bl approve read it; nothing written. Run bl approve again.`);
    process.exit(1);
  }
  info(`\nApproved ${feature.id} — ${feature.title} (${stories.length} stories, ${points} points).`);
  for (const s of orderStoriesByDeps(stories)) info(`  ${s.id}  effort: ${effortLabel(s, config)}  ${s.title}`);

  info(`\nNext: bl run ${feature.id} (or bl implement ${feature.id} to work interactively)`);
  reportBacklogCommit(await approvalCommit(config, feature), 'bl approve');
}

/** The owner of an approval's failed-commit record (`failedCommitRecord`). */
const approvalOwner = (feature) => `approve ${feature.id}`;

/**
 * Commit and push the approved feature file (`commitAndRecord`), so a rerun
 * after a failed commit commits that approval and nothing else
 * (`retryApprovalCommit`).
 */
function approvalCommit(config, feature) {
  const rel = feature.featureRelPath;
  return commitAndRecord(config, approvalOwner(feature), rel, {
    message: `chore: approve ${feature.id}`,
    extraPaths: [rel],
  });
}

/**
 * A rerun on an `approved` feature (S-1330): commit the approval only when an
 * earlier `bl approve` failed to commit it and the file still holds what that
 * commit tried. An operator's edit since, staged or not, and an approval
 * already committed make no commit and print nothing more. A record that
 * cannot be read fails the command.
 */
async function retryApprovalCommit(config, feature) {
  const root = config.backlogRoot;
  const rel = feature.featureRelPath;
  const owner = approvalOwner(feature);
  let pending;
  try {
    pending = failedCommitPending(root, owner, rel);
  } catch (e) {
    console.error(
      `bl approve: cannot read ${failedCommitRecord(owner)} (${e.message}); an earlier approval may be uncommitted. Check: git -C "${root}" status -- ${rel}`,
    );
    process.exit(1);
  }
  if (!pending) return;
  const res = await approvalCommit(config, feature);
  if (res.committed || res.error) reportBacklogCommit(res, 'bl approve');
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * The `bl status` line for a unit's `## Deferred`: its top-level items, or
 * null when the section is empty or has none. Tasks are counted apart
 * (`taskCountLine`); a closed unit's retired operator items
 * (`### Operator tasks`, `operator:` bullets) are not items.
 *
 *   deferred: 3 items
 */
export function deferredCountLine(body) {
  const lf = String(body ?? '').replace(/\r\n/g, '\n');
  if (!sectionHasContent(extractSection(lf, DEFERRED_HEADING))) return null;
  const items = scanDeferred(lf).items.filter((i) => !i.operator).length;
  if (items === 0) return null;
  return `deferred: ${items} item${items === 1 ? '' : 's'}`;
}

/**
 * The `bl status` line for a unit's tasks (F-65 D3), or null when it has
 * none. What they hold is in the `held:` lines.
 *
 *   tasks: 1 open, 2 done
 * @param {import("./task.js").Task[]} tasks
 */
export function taskCountLine(unitId, tasks) {
  const of = tasksOf(unitId, tasks);
  if (of.length === 0) return null;
  const open = of.filter((t) => t.status !== 'done').length;
  return `tasks: ${open} open, ${of.length - open} done`;
}

/**
 * What `bl status` shows after a unit's stories: what holds it at a gate
 * (F-66 D4), open follow-ups, its tasks, the escalation, and the run state.
 */
function printUnitTail(config, unit) {
  const held = heldLines(config, unit.id);
  if (held.length > 0) console.log(`\n${held.map((l) => `held: ${l}`).join('\n')}`);
  const countLine = deferredCountLine(unit.body);
  const tasksLine = taskCountLine(unit.id, readAllTasks(config));
  if (countLine || tasksLine) console.log(`\n${[countLine, tasksLine].filter(Boolean).join('\n')}`);
  const tokens = tokensLines(unit.fm);
  if (tokens.length > 0) console.log(`\n${tokens.join('\n')}`);
  const escalation = extractSection(unit.body, 'Escalation');
  if (sectionHasContent(escalation)) {
    console.log(`\nescalation:\n${escalation.trim()}`);
  }
  const statePath = runStatePath(config, unit.id);
  if (existsSync(statePath)) {
    try {
      const run = JSON.parse(readFileSync(statePath, 'utf8'));
      const last = run.history?.[run.history.length - 1];
      console.log(
        `\nrun: ${run.status} at step ${run.step}${run.lastError ? ` — ${run.lastError}` : ''} (updated ${run.updatedAt ?? '?'}, ${run.history?.length ?? 0} events${last?.note ? `, last: ${last.note}` : ''})`,
      );
      // A run sleeping through an agent usage limit: what it waits for, and
      // until when (local time).
      if (run.status === 'running' && last?.step === 'waiting') {
        console.log(`  waiting until ${localTime(last.until)} — ${last.message ?? last.note ?? ''}`);
      }
      for (const line of outcomeLines(run.history)) console.log(line);
      // The out-list (F-64 D3): the configurations the walk skips, and until
      // when, so the operator sees why a run is not on its first choice.
      if (run.status !== 'clean') {
        const now = Date.now();
        for (const o of Array.isArray(run.unavailable) ? run.unavailable : []) {
          if (o?.until != null && new Date(o.until).getTime() <= now) continue;
          const who = o.scope === 'account' ? `${o.agent} (every model)` : configurationLabel(o);
          console.log(
            `  out: ${who} ${o.until == null ? 'for the rest of the run' : `until ${localTime(o.until)}`} — ${o.kind}: ${o.message}`,
          );
        }
      }
      // The configurations that reviewed the latest round (F-64 D4).
      const reviewed = (run.history ?? []).findLast((e) => e.step === 'review:round');
      if (reviewed) console.log(`  ${reviewed.note}`);
      // Failed steps (a denied tool, a red test gate, a failed push) with the
      // step they happened in — the last event alone hides them.
      for (const h of (run.history ?? []).filter((e) => e.ok === false).slice(-5)) {
        console.log(`  ✗ ${h.step}${h.story ? ` ${h.story}` : ''}: ${h.note || 'failed'}`);
      }
    } catch {
      // unreadable run state is not an error for status
    }
  }
}

/**
 * `bl status`'s outcome lines (F-68 D4): the latest outcome summary of each
 * step of a run (and story, for an implement step), in the order the steps
 * last ran. A step without an outcome (a review dimension pass, a gate) has
 * no line.
 */
function outcomeLines(history) {
  const latest = new Map();
  for (const h of Array.isArray(history) ? history : []) {
    if (typeof h?.outcome !== 'string') continue;
    const key = `${h.step}${h.story ? ` ${h.story}` : ''}`;
    latest.delete(key);
    latest.set(key, h.outcome);
  }
  return [...latest].map(([key, outcome]) => `  ${key}: outcome: ${outcome}`);
}

/**
 * `bl status`'s token lines: the unit's four totals, then one indented line
 * per `tokens_by_step` key (S-904) in file order. None without totals.
 */
export function tokensLines(fm) {
  const kinds = (t) =>
    `input ${tok(t.input)} · output ${tok(t.output)} · cache_creation ${tok(t.cache_creation)} · cache_read ${tok(t.cache_read)}`;
  const totals = tokenFields(fm);
  if (!totals) return [];
  const lines = [`tokens: ${kinds(totals)}`];
  const map = fm.tokens_by_step;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [key, value] of Object.entries(map)) {
      const t = value && typeof value === 'object' && !Array.isArray(value) ? tokenFields(value, '') : null;
      if (t) lines.push(`  ${key}: ${kinds(t)}`);
    }
  }
  return lines;
}

/** The header lines `bl status` prints for a feature or a story; `repos` is its repo list. */
function printUnitHead(unit, repos) {
  const review = summarizeLatestReviewSession(unit.changeBody ?? '');
  console.log(`${unit.id} · ${unit.title}`);
  // A side story's `found_by` (F-48 D2): a record, printed when set.
  const foundBy = typeof unit.fm?.found_by === 'string' ? unit.fm.found_by.trim() : '';
  console.log(
    `status: ${unit.status}   repo: ${repos || '-'}   branch: ${unit.branch || '-'}   pr: ${unit.pr ? `#${unit.pr}` : '-'}   points: ${unit.points}${foundBy ? `   found by: ${foundBy}` : ''}`,
  );
  const rounds = `${unit.reviewRound}/${unit.reviewRoundsMax}`;
  const outcome = reviewOutcome(unit.reviewStatus, review);
  const state = !unit.reviewStatus
    ? `none (round ${rounds})`
    : outcome != null
      ? `round ${rounds} done: ${outcome}`
      : `round ${rounds}, review_status: ${unit.reviewStatus}`;
  console.log(`review: ${state}${review ? `, latest session ${review.date}` : ''}`);
  printChanges(unit);
}

/**
 * Each repo's branch, PR, URL and merge state from the unit's change
 * documents: every `change-<n>.md` when there are several, the current one
 * marked.
 */
function printChanges(unit) {
  const dir = dirname(unit.indexPath);
  const all = listChanges(dir);
  for (const c of all) {
    const doc = readChange(c.path);
    if (!doc) continue;
    const current = all.length > 1 && c.path === unit.changePath ? ', current' : '';
    console.log(`\nchange ${relative(dir, c.path)} (${doc.fm.status || 'open'}${current}):`);
    if (doc.repos.length === 0) console.log('  (no repos recorded)');
    for (const r of doc.repos) {
      console.log(
        `  ${r.repo}: branch ${r.branch || '-'}   pr: ${r.pr ? `#${r.pr}` : '-'}${r.url ? ` ${r.url}` : ''}   merged: ${r.merged || 'no'}`,
      );
    }
  }
}

export function cmdStatus(args, config, feature) {
  const all = readAllStories(config);
  const { stories } = resolveFeatureStories(feature, config, all);
  const ordered = orderStoriesByDeps(stories);
  printUnitHead(feature, featureRepoOrder(stories).join(', '));
  console.log('');
  if (ordered.length > 0) {
    printTable(
      ['#', 'ID', 'Status', 'Pts', 'Effort', 'Component', 'Title'],
      ordered.map((s, i) => [i + 1, s.id, s.status, s.points, effortLabel(s, config), s.componentId, s.title]),
    );
  } else {
    console.log('(no stories)');
  }
  const blockers = outsideBlockers(stories, all, loadFlow(config.backlogRoot));
  if (blockers.length > 0) {
    console.log('\nblocked on:');
    for (const b of blockers) console.log(`  ${b.story} depends on ${b.dep} (${b.status})`);
  }
  printUnitTail(config, feature);
}

/**
 * `bl status S-n`: the story's status, branch, PR, review state and round,
 * its open Deferred items and escalation, and the run state `bl run S-n` keeps.
 */
export function cmdStatusStory(args, config, story) {
  const { unit } = loadStoryUnit(story, config);
  printUnitHead(unit, unit.primaryRepo);
  const all = readAllStories(config);
  const blockers = outsideBlockers([storyAsOrdered(unit)], all, loadFlow(config.backlogRoot));
  if (blockers.length > 0) {
    console.log('\nblocked on:');
    for (const b of blockers) console.log(`  ${b.story} depends on ${b.dep} (${b.status})`);
  }
  printUnitTail(config, unit);
}

/**
 * `bl status C01`: the component's open stories (not closed),
 * one row each, in id order. `component` is a `findComponentDir` hit.
 */
export function cmdStatusComponent(args, config, component) {
  const flow = loadFlow(config.backlogRoot);
  const stories = readAllStories(config)
    .filter((s) => s.componentId === component.id && !flow.meets('story', s.status, 'done'))
    .sort((a, b) => parseInt(a.id.slice(2), 10) - parseInt(b.id.slice(2), 10));
  console.log(`${component.id} · ${component.componentEntry}${component.repo ? ` (${component.repo})` : ''}\n`);
  if (stories.length === 0) {
    console.log('(no open stories)');
    return;
  }
  printTable(
    ['ID', 'Status', 'Pts', 'Feature', 'Title'],
    stories.map((s) => [s.id, s.status, s.points, s.feature || '-', s.title]),
  );
}

/**
 * A story target as a unit, with the config of its repo (`configForRepo`)
 * and the `findStoryDir`-shaped hit and parsed id that `prepareStoryRun` takes.
 */
function loadStoryUnit(story, baseConfig) {
  const config = configForRepo(baseConfig, story.unitRepo);
  const unit = storyUnit(story, config);
  const found = {
    unitRepo: unit.unitRepo,
    componentId: unit.componentId,
    componentEntry: unit.componentEntry,
    storyEntry: unit.storyEntry,
    storyDir: unit.featureDir,
    indexPath: unit.indexPath,
  };
  return { config, unit, found, parsed: normalizeId(unit.id) };
}

// ---------------------------------------------------------------------------
// workon
// ---------------------------------------------------------------------------

function runFeatureStagePlugins(stage, config, feature, vars, cwd) {
  const active = resolveFeaturePlugins(stage, config, feature.indexPath);
  if (active.length === 0) return true;
  info(`Running ${stage} plugins...`);
  const ok = runPlugins(active, vars, cwd);
  if (!ok) console.error(`${stage} plugin failed — continuing anyway.\n`);
  info('');
  return ok;
}

/**
 * One repo's feature worktree: the worktree on the feature branch (with
 * `ensureWorktree`'s guards), the bootstrap plugins and, on a new worktree
 * (or one whose earlier run of them failed), the `workon` stage plugins. A failed plugin is a warning unless `strict`,
 * which exits naming the repo (every repo of a feature, S-862). `bl side` prepares a side story's repo through
 * this too (F-48 D1).
 *
 * @returns {{ repoName: string, repoPath: string, worktreePath: string,
 *             isNewWorktree: boolean }}
 */
export function prepareFeatureRepo(config, feature, repoName, { strict = false } = {}) {
  const repoPath = config.reposByName[repoName];
  if (!repoPath) {
    console.error(`Unknown repo: ${repoName}. Known: ${Object.keys(config.reposByName).join(', ')}`);
    process.exit(1);
  }
  const cfg = configForRepo(config, repoName);
  const branchName = featureBranchName(feature.featureEntry);
  const worktreePath = worktreePathFor(cfg, repoName, branchName);
  return prepareWorktreeOnce(repoPath, branchName, () => {
    const { effectiveWorktreePath, isNewWorktree } = ensureWorktree(repoPath, branchName, worktreePath);
    // Owed before bootstrap, so a run stopped there still owes them (S-862).
    const workonPending = workonDue(effectiveWorktreePath, isNewWorktree);
    const stop = (what) => {
      console.error(
        `${feature.id}: ${what} failed in ${repoName} (${effectiveWorktreePath}) — stopping before the agent starts.`,
      );
      process.exit(1);
    };
    const pluginVars = {
      ...featureSessionVars(feature),
      storyId: feature.id,
      featureId: feature.id,
      worktreePath: effectiveWorktreePath,
      branchName,
      storyRelPath: feature.featureRelPath,
      componentId: '',
      repoPath,
      repoName,
      roostDir: cfg.roostDir,
      backlogDir: cfg.backlogRoot,
    };
    const bootstrap = resolveFeaturePlugins('bootstrap', cfg, feature.indexPath);
    if (bootstrap.length > 0) {
      info(`Bootstrapping ${repoName} worktree...`);
      if (!runPlugins(bootstrap, pluginVars, effectiveWorktreePath)) {
        if (strict) stop('bootstrap');
        info(`  (${repoName} bootstrap failed — you may need to run it manually)`);
      }
      info('');
    }
    if (workonPending) {
      if (runFeatureStagePlugins('workon', cfg, feature, pluginVars, repoPath)) workonDone(effectiveWorktreePath);
      else if (strict) stop('a workon plugin');
    }
    return { repoName, repoPath, worktreePath: effectiveWorktreePath, isNewWorktree };
  });
}

/**
 * Everything `workon` and `run` share: gates, worktrees, bootstrap, stage
 * plugins, the `running` transition, and the prompt variables every feature
 * session receives. Exits the process on a hard guard (same as `bl implement`
 * on a story). Every repo of the feature (`featureRepoOrder`, F-52 D3) gets
 * its worktree, in that order and strictly, before any agent starts (S-862),
 * under the feature's unit directory `unitDir`, where the session starts
 * (F-60 D3). The lead repo is the first; its config is `cfg`.
 *
 * @returns {{ cfg, parsed, worktreePath, unitDir, branchName, isNewWorktree,
 *             ordered, baseVars, reviewPending, targetRepoName,
 *             otherWorktrees }}
 */
export function prepareFeatureWorktree(config, feature) {
  if (!FEATURE_WORKABLE_STATUSES.has(feature.status)) {
    const hint =
      feature.status === 'draft'
        ? `run \`bl refine ${feature.id}\` and then \`bl approve ${feature.id}\``
        : feature.status === 'refined'
          ? `run \`bl approve ${feature.id}\` first`
          : 'it is closed';
    console.error(`Feature ${feature.id} is ${feature.status} — ${hint}.`);
    process.exit(1);
  }
  const all = readAllStories(config);
  const { stories } = resolveFeatureStories(feature, config, all);
  const ordered = orderStoriesByDeps(stories);
  const blockers = outsideBlockers(ordered, all, loadFlow(config.backlogRoot));
  if (blockers.length > 0) {
    console.error(`Feature ${feature.id} is blocked on work outside the feature:`);
    for (const b of blockers) console.error(`  ${b.story} depends on ${b.dep} (${b.status})`);
    console.error('Merge those first, or pull them into the feature.');
    process.exit(1);
  }

  // The feature's repos are its stories' components' (F-52 D3), nothing on
  // the feature itself: a story with no repo, or one the config does not know,
  // stops here naming the story.
  if (stories.length === 0) {
    console.error(
      `Feature ${feature.id} has no stories, so it has no repo to work in. Cut its stories first (\`bl refine ${feature.id}\`), each in a component of the repo it changes.`,
    );
    process.exit(1);
  }
  exitOnStoryWithoutRepo(feature, stories);
  const names = featureRepoOrder(stories);
  for (const name of names) {
    if (!config.reposByName[name]) {
      console.error(
        `Unknown repo: ${name} (named by ${repoSource(stories, name)}). Known: ${Object.keys(config.reposByName).join(', ')}`,
      );
      process.exit(1);
    }
  }
  const targetRepoName = names[0];

  const cfg = configForRepo(config, targetRepoName);
  const branchName = featureBranchName(feature.featureEntry);
  const worktreePath = worktreePathFor(cfg, targetRepoName, branchName);
  const unitDir = unitDirFor(cfg, branchName);
  const parsed = parsedFor(feature);

  info(`Feature  : ${feature.id} — ${feature.title}`);
  info(`Repos    : ${names.join(', ')} (lead: ${targetRepoName})`);
  info(`Branch   : ${branchName}`);
  info(`Unit dir : ${unitDir}`);
  info(`Worktree : ${worktreePath}`);
  info(`Stories  : ${ordered.map((s) => s.id).join(', ') || '(none)'}`);
  info('');

  const { worktreePath: effectiveWorktreePath, isNewWorktree } = prepareFeatureRepo(config, feature, targetRepoName, {
    strict: true,
  });
  // The other repos, in order: a repo that cannot be prepared stops the run
  // before the agent starts (S-862).
  const otherWorktrees = [];
  for (const name of names.slice(1)) {
    info(`Repo     : ${name}`);
    info('');
    const w = prepareFeatureRepo(config, feature, name, { strict: true });
    otherWorktrees.push({ repoName: w.repoName, worktreePath: w.worktreePath });
  }
  const sessionVars = featureSessionVars(feature);

  updateFeature(config, feature, (fm) => {
    if (fm.status === 'approved' || fm.status === 'escalated') fm.status = 'running';
  });
  // The branch is recorded in the change document, with every repo prepared.
  const change = openUnitChange(cfg.backlogRoot, feature, branchName, names);
  const reviewPending = feature.reviewStatus === 'pending';

  const baseVars = {
    featureId: feature.id,
    storyId: feature.id,
    title: feature.title,
    featureRelPath: feature.featureRelPath,
    featureAbsPath: feature.indexPath,
    changeAbsPath: change.path,
    changeRelPath: relative(cfg.backlogRoot, change.path),
    leadRepo: targetRepoName,
    targetRepo: targetRepoName,
    worktreePath: effectiveWorktreePath,
    unitDir,
    branchName,
    roostDir: cfg.roostDir,
    backlogDir: cfg.backlogRoot,
    storyRepos: storyReposList(feature, stories),
    storiesPlan: renderStoriesPlan(cfg, ordered),
    storyCount: String(ordered.length),
    otherWorktrees: otherWorktreesLine(otherWorktrees),
    prTitle: `${feature.id}: ${feature.title}`,
    // The feature's theme brief (F-53 D4), for every implementing prompt.
    themeBrief: themeBriefList(cfg, feature.theme),
    ...unitVars(feature),
    // Where an ad-hoc bug-fix story goes (prompts/_blocked-by-bug.md): the
    // component of the feature's first story.
    adhocComponent: ordered[0]?.componentId ?? '',
    ...sessionVars,
  };
  return {
    cfg,
    parsed,
    worktreePath: effectiveWorktreePath,
    unitDir,
    branchName,
    isNewWorktree,
    ordered,
    baseVars,
    reviewPending,
    targetRepoName,
    otherWorktrees,
  };
}

export async function cmdWorkon(args, config, feature) {
  const prep = prepareFeatureWorktree(config, feature);
  const { cfg, parsed, reviewPending } = prep;
  const promptName = reviewPending ? 'feature-workon-review' : 'feature-workon';
  if (reviewPending) info('Review pending on the feature — using the review-feedback prompt.\n');
  const vars = { ...prep.baseVars };
  if (reviewPending) {
    // A fix session returns its outcome in the outcome file (F-68 D1, D3).
    vars.outcomeCarrier = 'file';
    // The same slot `bl run` gives this round's fix session.
    ensureRunDir(cfg);
    vars.scratchDir = join(cfg.backlogRoot, RUN_DIR, `${feature.id}.r${feature.reviewRound}.fix.scratch`);
    mkdirSync(vars.scratchDir, { recursive: true });
  }
  const sessionPrompt = loadPrompt(promptName, vars, { agent: cfg.agent, config: cfg });

  const ret = launchSession({
    mode: 'workon',
    parsed,
    title: feature.title,
    worktreePath: prep.worktreePath,
    unitDir: prep.unitDir,
    branchName: prep.branchName,
    sessionPrompt,
    roostDir: cfg.roostDir,
    backlogRoot: cfg.backlogRoot,
    isNewWorktree: prep.isNewWorktree,
    agent: cfg.agent,
    forceNew: reviewPending,
    config: cfg,
    additionalPrompt: args.prompt,
    returnOnExit: true,
    recordTokens: false,
    // The same key `bl run` gives this session (S-904): the round's fix
    // while a review is pending.
    tokensStep: reviewPending ? tokensStepKey('fix', feature.reviewRound) : 'implement',
    tokensIndexPath: feature.indexPath,
    // One session for every story: the highest of their levels (F-85 D4).
    effort: sessionEffort(cfg, { mode: 'workon', stories: prep.ordered }),
    ...(reviewPending ? { schema: loadSchema('fix') } : {}),
  });
  const status = reviewPending ? ret.status : ret;
  recordFeatureTokens(feature, cfg);
  if (reviewPending) applyFixOutcome(cfg.backlogRoot, { id: feature.id, changePath: vars.changeAbsPath }, ret);
  if (!status) info(implementNextSteps(feature.id));
  // launchSession returns exitStatus of the agent: a kill is nonzero.
  process.exit(status);
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

/** The review agent, after checking it exists; exits when it does not. */
function reviewAgentOrExit(config) {
  const reviewAgent = config.reviewAgent;
  if (!hasProvider(reviewAgent)) {
    console.error(`Unknown review agent provider: ${reviewAgent}.`);
    process.exit(1);
  }
  if (reviewAgent !== config.agent) {
    info(`Review agent : ${reviewAgent} (implementation agent: ${config.agent})`);
  }
  if (!getProvider(reviewAgent).supportsDeny()) {
    info(`  note: ${reviewAgent} enforces review-mode denials (gh pr merge, git push) via prompt guidance only.`);
  }
  return reviewAgent;
}

export async function cmdReview(args, config, feature, opts = {}) {
  if (!feature.branch) {
    console.error(
      `Feature ${feature.id} has no branch yet — run \`bl run ${feature.id}\` or \`bl implement ${feature.id}\` first.`,
    );
    process.exit(1);
  }
  if (feature.status !== 'running' && feature.status !== 'escalated') {
    console.error(`Feature ${feature.id} is ${feature.status}; nothing to review.`);
    process.exit(1);
  }
  reviewAgentOrExit(config);

  const branchName = feature.branch;
  const all = readAllStories(config);
  const { stories } = resolveFeatureStories(feature, config, all);
  exitOnStoryWithoutRepo(feature, stories);
  let repos = reposForFeature(feature, config, stories);
  if (args.repo && args.repo !== true) {
    repos = repos.filter((r) => r.repoName === String(args.repo));
    if (repos.length === 0) {
      console.error(`Repo ${args.repo} is not part of ${feature.id}.`);
      process.exit(1);
    }
  }

  const ordered = orderStoriesByDeps(stories);
  // The lead repo's PR is the one the run state keeps (F-52 D3), and the
  // round reviews the PRs in the feature's repo order.
  const order = reposForFeature(feature, config, stories).map((r) => r.repoName);
  const unit = { ...feature, primaryRepo: order[0] ?? '', repos: repos.map((r) => r.repoName) };
  const found = findUnitPRs(config, unit, args.repo && args.repo !== true ? { repo: String(args.repo) } : {});
  openMissingPRs(config, unit, found, branchName, ordered);
  const rank = (name) => (unit.repos.includes(name) ? unit.repos.indexOf(name) : unit.repos.length);
  found.prs.sort((a, b) => rank(a.repoName) - rank(b.repoName));
  if (found.prs.length === 0) {
    reportNoOpenPR(feature.id, found, branchName);
    process.exit(1);
  }
  return reviewUnitPRs(args, config, feature, {
    prs: found.prs,
    branchName,
    ordered,
    repoOrder: order,
    runner: opts.runner,
  });
}

/**
 * Open the PR `bl review` needs where the branch has none (F-42 D4: bl makes
 * every forge call, so an implementing session only pushes). For each repo
 * `findUnitPRs` searched with a usable forge and found no PR, open or merged,
 * whose worktree has commits ahead of main: push the branch, then
 * `change.open` with the title and body generated from the change document.
 * Each PR opened joins `found.prs`; reviewUnitPRs records it in the change
 * document. A failure is reported and leaves that repo without a PR.
 */
function openMissingPRs(config, unit, found, branchName, ordered) {
  const merged = new Set(found.merged.map((m) => m.repoName));
  const description =
    extractSection(unit.change?.body ?? unit.changeBody ?? '', 'Description')?.trim() || unitDescription(unit, ordered);
  const { title, body } = changePrContent(unit, description);
  for (const s of found.searched) {
    if (s.hasPR || s.reason || merged.has(s.repoName)) continue;
    const wt = findExistingWorktree(s.repoPath, branchName);
    if (!wt) continue;
    const git = (gitArgs) =>
      execFileSync('git', gitArgs, { cwd: wt.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let ahead = '0';
    try {
      ahead = git(['rev-list', '--count', 'main..HEAD']);
    } catch {
      continue;
    }
    if (ahead === '0') continue;
    try {
      git(['push', '-u', 'origin', branchName]);
    } catch (e) {
      console.error(
        `${s.repoName}: could not push ${branchName} to open its PR: ${String(e.stderr || e.message)
          .trim()
          .split('\n')
          .pop()}`,
      );
      continue;
    }
    const res = runForgeOp('change.open', { title, body }, { config, repoPath: wt.path });
    const url =
      res.configured && res.status === 0
        ? (String(res.stdout ?? '')
            .trim()
            .split('\n')
            .filter((l) => /https?:\/\//.test(l))
            .pop() ?? '')
        : '';
    const number = url.match(/\/(\d+)\s*$/)?.[1];
    if (!number) {
      const why = !res.configured
        ? `change.open unavailable (${res.reason})`
        : String(res.stderr || res.stdout || `exit ${res.status}`)
            .trim()
            .split('\n')
            .pop();
      console.error(`${s.repoName}: could not open the PR for ${branchName}: ${why}`);
      continue;
    }
    info(`${s.repoName}: opened PR #${number} — ${url}`);
    s.hasPR = true;
    found.prs.push({
      repoName: s.repoName,
      repoPath: s.repoPath,
      prNumber: Number(number),
      prUrl: url,
      isPrimary: s.repoName === unit.primaryRepo,
    });
  }
}

/**
 * `bl review S-n`: the loop's review step for a story (decision I) — its PRs
 * read from its change document and `change.find` (opened when missing),
 * each worktree synced with main, then one round of dimension passes and the
 * verifier, one session in the story's Review Log. `opts.runner` is a test
 * seam.
 */
export async function cmdReviewStory(args, baseConfig, story, opts = {}) {
  refuseStoryRepo('review', args);
  const { config, unit } = loadStoryUnit(story, baseConfig);
  if (loadFlow(config.backlogRoot).meets('story', unit.status, 'done')) {
    console.error(`Story ${unit.id} is ${unit.status}; nothing to review.`);
    process.exit(1);
  }
  if (reviewSkipped(unit.fm)) {
    info(`${unit.id} is a scripted story: nothing an agent wrote, so review is skipped (review: true opts in).`);
    return;
  }
  reviewAgentOrExit(config);
  const branchName = unit.branch || unit.featureEntry.toLowerCase();
  const ordered = [storyAsOrdered(unit)];
  const found = findUnitPRs(config, { ...unit, branch: branchName });
  openMissingPRs(config, unit, found, branchName, ordered);
  if (found.prs.length === 0) {
    reportNoOpenPR(unit.id, found, branchName);
    process.exit(1);
  }
  return reviewUnitPRs(args, config, unit, { prs: found.prs, branchName, ordered, runner: opts.runner });
}

/**
 * One review round over a unit's open PRs (`[{ repoName, repoPath,
 * prNumber, prUrl, isPrimary }]`): find each worktree, sync it with main,
 * record the primary PR, run `reviewFeature`, and exit with its outcome.
 */
async function reviewUnitPRs(
  args,
  config,
  unit,
  { prs, branchName, ordered, repoOrder = null, runner: injected = null },
) {
  const reviewAgent = config.reviewAgent;
  const parsed = unit.kind === 'story' ? normalizeId(unit.id) : parsedFor(unit);
  const round = unit.reviewRound;
  // The same review step `bl run` takes: two dimension passes and a
  // verifier, headless unless the agent has no headless mode or
  // --interactive asks to attach each session.
  const { reviewFeature, defaultRunner } = await import('./feature-run.js');
  const interactive = args.interactive === true || !hasHeadlessConfiguration(config.reviewAgents);
  const runner =
    injected ??
    defaultRunner({
      interactive,
      extraPrompt: typeof args.prompt === 'string' ? args.prompt : '',
    });

  // One invocation is one review round over every PR the unit has: one
  // verifier, one Review Log session, `review_round` up by one. The primary
  // repo's PR (else the first found) is the one the run state keeps.
  const primary = prs.find((p) => p.isPrimary) ?? prs[0];
  const targets = [primary, ...prs.filter((p) => p !== primary)];
  info(`${unit.kind === 'story' ? 'Story   ' : 'Feature '} : ${unit.id} — ${unit.title}`);
  info(`Branch   : ${branchName}`);
  info(
    `Round    : ${round + 1} of ${unit.reviewRoundsMax}${unit.reviewStatus === 'fixed' ? ' (re-review of claimed fixes)' : ''}`,
  );
  const syncs = new Map();
  for (const pr of targets) {
    const wt = findExistingWorktree(pr.repoPath, branchName);
    if (!wt) {
      // A story has one repo (F-52 D1), so its hint takes no --repo.
      console.error(
        `Found PR #${pr.prNumber} in ${pr.repoName} but no worktree for branch '${branchName}'. Run \`bl implement ${unit.id}\` first.`,
      );
      process.exit(1);
    }
    if (isSessionRunning(unitDirOf(wt.path))) {
      console.error(`Warning: a workon session appears to be running in ${unitDirOf(wt.path)}.`);
    }
    pr.worktreePath = wt.path;
    info(`Repo     : ${pr.repoName}${pr === primary && unit.kind !== 'story' ? ' (lead)' : ''}`);
    info(`  Worktree : ${wt.path}`);
    info(`  PR       : #${pr.prNumber} — ${pr.prUrl}`);
    const sync = syncBranchWithMain(wt.path);
    info(`  Sync     : ${sync.status}`);
    if (sync.status === 'conflict') {
      console.error(
        `Branch ${branchName} in ${pr.repoName} conflicts with ${sync.ref} (the merge was aborted). Run \`bl implement ${unit.id}\` to merge and resolve, then review.`,
      );
      process.exit(1);
    }
    syncs.set(pr, sync);
  }
  info('');

  // Every repo's PR goes on its `repos:` entry in the change document. A
  // feature's entries keep its whole derived order (`--repo` reviews one), so
  // the lead stays first.
  const change = ensureChange(config.backlogRoot, dirname(unit.indexPath), {
    changeOf: unit.id,
    title: unit.title,
    repos: (repoOrder ?? targets.map((p) => p.repoName)).map((repo) => ({ repo, branch: branchName })),
  });
  updateChange(config.backlogRoot, change.path, (doc) => {
    for (const p of targets)
      setRepo(doc, p.repoName, { branch: branchName, pr: String(p.prNumber), url: p.prUrl ?? '' });
  });

  const cfg = configForRepo(config, primary.repoName);
  const vars = {
    featureId: unit.id,
    storyId: unit.id,
    title: unit.title,
    featureRelPath: unit.featureRelPath,
    featureAbsPath: unit.indexPath,
    changeAbsPath: change.path,
    changeRelPath: relative(config.backlogRoot, change.path),
    worktreePath: primary.worktreePath,
    unitDir: unitDirOf(primary.worktreePath),
    branchName,
    mainRef: syncs.get(primary).ref,
    prNumber: String(primary.prNumber),
    prUrl: primary.prUrl,
    primaryRepo: primary.repoName,
    roostDir: cfg.roostDir,
    backlogDir: cfg.backlogRoot,
    storyRepos: storyReposList(unit, ordered),
    storiesPlan: renderStoriesPlan(cfg, ordered),
    ...unitVars(unit),
    ...featureSessionVars(unit),
  };
  const result = await reviewFeature({
    feature: unit,
    config,
    prep: {
      cfg,
      parsed,
      worktreePath: primary.worktreePath,
      unitDir: vars.unitDir,
      branchName,
      ordered,
      baseVars: vars,
      targetRepoName: primary.repoName,
    },
    runner,
    pr: { number: String(primary.prNumber), url: primary.prUrl ?? '' },
    otherRepos: targets.slice(1).map((p) => ({
      repoName: p.repoName,
      worktreePath: p.worktreePath,
      pr: { number: String(p.prNumber), url: p.prUrl ?? '' },
    })),
    maxRounds: unit.reviewRoundsMax,
  });
  if (result.refused) {
    console.error(`bl review: ${result.lastError}`);
    process.exit(1);
  }
  const { end } = result;
  if (!end) info('\nThe review round did not finish.');
  else if (end.outcome === 'escalated') info(`\nReview round ${result.round}: escalated.`);
  else info(`\nReview round ${result.round} done: ${end.outcome}.${end.cap}`);
  if (end?.next) info(`Next: ${end.next}`);
  if (result.error) console.error(`bl review: ${result.error}`);
  const ok = !result.error && !result.escalated && (result.status === 'pending' || result.status === 'addressed');
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function cmdRun(args, config, feature) {
  return runUnit(args, config, feature, {
    ordered: () => orderStoriesByDeps(resolveFeatureStories(feature, config, readAllStories(config)).stories),
    prepare: () => prepareFeatureWorktree(config, feature),
  });
}

/**
 * `bl run S-n`: a runnable story (`Flow.isRunnable`) through the feature loop,
 * as a one-story unit on its own branch (F-35 Design §3).
 */
export async function cmdRunStory(args, baseConfig, story) {
  refuseStoryRepo('run', args);
  const { config, unit, found, parsed } = loadStoryUnit(story, baseConfig);
  const flow = loadFlow(config.backlogRoot);
  if (!flow.isRunnable('story', unit.status)) {
    // Only the shipped key keeps its prose spelling; any other is named as flow.json has it.
    const named = flow.runnableStatusesOf('story').map((s) => (s === 'in_progress' ? 'in-progress' : s));
    const runnable = statusWords(named);
    const hint = unit.status === 'backlog' ? `run \`bl refine ${unit.id}\` first` : `only a ${runnable} story runs`;
    console.error(`Story ${unit.id} is ${unit.status} — ${hint}.`);
    process.exit(1);
  }
  const ordered = [storyAsOrdered(unit)];
  if (!args.plan) {
    const blockers = outsideBlockers(ordered, readAllStories(config), flow);
    if (blockers.length > 0) {
      console.error(`Story ${unit.id} is blocked on unmerged work:`);
      for (const b of blockers) console.error(`  ${b.story} depends on ${b.dep} (${b.status})`);
      console.error('Merge those first.');
      process.exit(1);
    }
  }
  return runUnit(args, config, unit, {
    ordered: () => ordered,
    prepare: () => prepareStoryRun(parsed, found, config, { unit }),
  });
}

/** The run both kinds share: flags, gates, prep, the loop, the exit code. */
async function runUnit(args, config, unit, { ordered, prepare }) {
  const {
    planSteps,
    formatPlan,
    runFeature,
    defaultRunner,
    escalationOpen,
    liveLockHolder,
    runLockPath,
    parseMaxRounds,
  } = await import('./feature-run.js');
  const kind = unit.kind === 'story' ? 'Story' : 'Feature';
  const maxRounds = parseMaxRounds(args['max-rounds'], unit.reviewRoundsMax);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    console.error('bl run: --max-rounds must be a positive integer.');
    process.exit(1);
  }
  if (args.plan) {
    console.log(formatPlan(unit, planSteps(ordered(), maxRounds)));
    return;
  }
  const interactive = args.interactive === true;
  // Each role's walk skips a configuration with no headless mode (F-64 D3),
  // so a role needs one that has one.
  for (const [key, list] of [
    ['agent', config.agents],
    ['review_agent', config.reviewAgents],
  ]) {
    if (!interactive && !hasHeadlessConfiguration(list)) {
      console.error(
        `No configuration in backlog.json "${key}" has a headless mode (${(list ?? []).map(configurationLabel).join(', ')}); use --interactive.`,
      );
      process.exit(1);
    }
  }
  // The reviewer is never the implementer (F-64 D4): a review list whose every
  // entry is also an implementing one could never review this run.
  if (independentReviewers(config.agents, config.reviewAgents).length === 0) {
    console.error(
      `Every backlog.json "review_agent" configuration (${config.reviewAgents.map(configurationLabel).join(', ')}) is also an "agent" configuration, and the reviewer is never the implementer: add a "review_agent" configuration that is not in "agent".`,
    );
    process.exit(1);
  }
  // Checked before prep, which would flip `escalated` back to `running`
  // and leave the feature running with an open escalation.
  if (escalationOpen(unit.indexPath)) {
    console.error(
      `${kind} ${unit.id} has an open ## Escalation — resolve it and set the section to "None." before running again.`,
    );
    process.exit(1);
  }
  // Checked before prep too, so a refused run leaves the feature file alone.
  const holder = liveLockHolder(runLockPath(config, unit.id));
  if (holder != null) {
    console.error(`Another bl run (pid ${holder}) is running ${unit.id}.`);
    process.exit(1);
  }
  const prep = prepare();
  const runner = defaultRunner({ interactive });
  const state = await runFeature({
    feature: unit,
    config,
    prep,
    runner,
    opts: { resume: args.resume === true, maxRounds },
  });
  // Headless sessions accumulate their usage on the unit as they finish
  // (into `tokens_headless_*` as well, which the re-read adds back).
  if (interactive) recordFeatureTokens(unit, prep.cfg);
  const { printInboxCount } = await import('./inbox.js');
  printInboxCount(config);
  process.exit(state.status === 'clean' || state.status === 'no-change' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

export async function cmdMerge(args, config, feature) {
  if (loadFlow(config.backlogRoot).meets('feature', feature.status, 'done')) {
    console.error(`Feature ${feature.id} is already ${feature.status}.`);
    process.exit(1);
  }
  if (feature.status !== 'running' && feature.status !== 'escalated') {
    console.error(`Feature ${feature.id} is ${feature.status} — nothing has been implemented on a branch yet.`);
    process.exit(1);
  }

  const all = readAllStories(config);
  const { stories } = resolveFeatureStories(feature, config, all);
  // Before any repo lands: every story is merged and marked done below.
  exitOnStoryWithoutRepo(feature, stories);

  // The release manifest written after the merge records every deployable
  // repo (`deployable: true` in `repos`, which every entry must set).
  const deployable = deployableRepos(config);

  const branchName = feature.branch || featureBranchName(feature.featureEntry);
  // The feature's repos in the one order (F-52 D3): `bl` first, so the
  // backlog is synced by the new `bl` before a later repo's push gate reads
  // it (S-864), then each other repo by its first story.
  const names = featureRepoOrder(stories);
  const unknown = names.filter((n) => !config.reposByName[n]);
  if (unknown.length > 0) {
    console.error(
      `Feature ${feature.id}: unknown repo ${unknown.map((n) => `${n} (named by ${repoSource(stories, n)})`).join(', ')}. Known: ${Object.keys(config.reposByName).join(', ')}`,
    );
    process.exit(1);
  }
  if (names.length === 0) {
    console.error(`Feature ${feature.id} has no story with a repo, so there is nothing to merge.`);
    process.exit(1);
  }
  const targets = names.map((repoName) => ({ repoName, repoPath: config.reposByName[repoName] }));
  const primary = targets[0];

  // One gate set with `bl merge S-n` (F-36 D1), before any repo is touched:
  // an unmet blockers.json edge on it or a story (F-66 D3), review state,
  // never reviewed, escalation, a worktree on the branch in a repo no story
  // names, and every main checkout on main.
  const unit = featureUnit(feature);
  const gates = mergeGates(unit, { config, args, repos: names });
  if (reportMergeGates(gates)) process.exit(1);

  info(`Feature : ${feature.id} — ${feature.title}`);
  info(`Branch  : ${branchName}`);
  info(`Repos   : ${targets.map((t) => t.repoName).join(', ')}`);
  info(`Stories : ${stories.map((s) => s.id).join(', ') || '(none)'}`);

  // Every branch is brought up to date with main in its worktree, gated and
  // pushed before any main checkout is touched (F-36 D4).
  if (!(await integrateForMerge(config, unit, names))) process.exit(1);

  // Snapshot the backlog before merge touches it, so the final commit takes
  // only what merge and sync changed — never the operator's own uncommitted
  // edits (a story in progress, a regenerated allowed-tools.json).
  const backlogBefore = dirtySnapshot(config.backlogRoot);
  recordFeatureTokens(feature, config);

  const parsed = parsedFor(feature);
  const landed = {};
  // The tip of main a repo with no local branch reports (S-868): recorded
  // only when the feature does not already name that repo's exact merge SHA.
  const tips = {};
  for (const t of targets) {
    const result = cleanupOneRepo({
      parsed,
      storyEntry: feature.featureEntry,
      repoName: t.repoName,
      repoPath: t.repoPath,
      keepBranch: !!args.keep,
      config: configForRepo(config, t.repoName),
      // Every repo is prepared up front (S-862), so any but the lead may
      // have nothing to merge.
      isSecondary: t !== primary,
    });
    if (!result.ok) {
      console.error(`\nMerge of ${t.repoName} failed. Stopping. Resume with:\n  bl merge ${feature.id}`);
      process.exit(1);
    }
    if (result.mergeCommitHash) (result.branchExists ? landed : tips)[t.repoName] = result.mergeCommitHash;
    // The backlog is synced right after `bl` merges, as a story merge does
    // (S-864): from the merged checkout, so the new `bl` formats and commits
    // the feature's story directories. It writes no index (F-79 D1).
    if (t.repoName === LEAD_REPO && !result.noChanges) {
      info(`\nSyncing backlog with the merged ${t.repoName}...`);
      const res = await runBacklogSync(config, chooseSyncRunner({ primaryRepoPath: t.repoPath }), {
        message: `chore: sync backlog with the merged ${t.repoName} (${feature.id})`,
        storyIds: feature.stories,
      });
      if (res.error) {
        console.error(
          `bl merge: backlog sync after ${t.repoName} failed: ${res.error}${res.command ? `\n  Re-run it by hand: ${res.command}` : ''}\nThen resume with:\n  bl merge ${feature.id}`,
        );
        process.exit(1);
      }
    }
  }

  // Every repo is pushed: tag each touched repo's merge commit, push the
  // tags last, then record every deployable repo's main in the manifest.
  const stamp = today();
  const release = changeName(
    feature.id,
    listChanges(feature.featureDir).find((c) => c.path === feature.changePath)?.n ?? 1,
  );
  // A done feature stays where it is (F-49 D3): the tag, the manifest and the
  // link name its change document there.
  const changeHome = feature.featureDir;
  const changeRel = feature.changePath
    ? relative(config.backlogRoot, join(changeHome, basename(feature.changePath)))
    : '(no change document)';
  const merged = { ...tips, ...landed };
  const releaseLines = [];
  // The manifest needs every deployable repo's main from its remote; read
  // them before anything is published, and stop when one is unreadable.
  const mains = mainCommits(config, deployable);
  if (mains.errors.length > 0) {
    for (const e of mains.errors) console.error(`  release manifest: ${e}`);
    console.error(
      `\nThe merges are pushed, but ${feature.id} is not marked done and has no tag or manifest. Fix the cause, then resume with:\n  bl merge ${feature.id}`,
    );
    process.exit(1);
  }
  const tagTargets = targets.filter((t) => merged[t.repoName]).map((t) => ({ ...t, commit: merged[t.repoName] }));
  // Under the backlog lock, so a second `bl merge` of the feature waits for
  // this one's tags to be pushed or rolled back (a refused rollback is named
  // in the error, and that re-run completes the set).
  const tagged = await withLock(config.backlogRoot, () =>
    tagRepos(tagTargets, release, `${feature.id}: ${feature.title}\n\nChange: ${changeRel}`),
  );
  if (tagged.ok) {
    info(`\nTagged ${release} in: ${tagTargets.map((t) => t.repoName).join(', ') || '(no repo)'}`);
    releaseLines.push(`- Tag: \`${release}\` on ${tagTargets.map((t) => t.repoName).join(', ') || '(no repo)'}`);
  } else {
    // No remote keeps the tag, and nothing records the feature as merged:
    // the re-run tags the whole set.
    console.error(
      `\nTagging ${release} failed: ${tagged.error}\nThe merges are pushed, but ${feature.id} is not marked done. Fix the cause, then resume with:\n  bl merge ${feature.id}`,
    );
    process.exit(1);
  }
  const manifestRel = writeReleaseManifest(config.backlogRoot, {
    name: release,
    feature: feature.id,
    title: feature.title,
    date: stamp,
    change: changeRel,
    repos: mains.commits,
  });
  info(`Release manifest: ${manifestRel}`);
  releaseLines.push(
    `- Release manifest: [${manifestRel}](${relative(changeHome, join(config.backlogRoot, manifestRel))})`,
  );
  // The keep-or-replace decision for a tip is made from the feature file
  // re-read under the backlog lock, in the same hold as the story and feature
  // writes, so an exact SHA another merge records meanwhile is never replaced.
  const shape = await withLock(config.backlogRoot, () => {
    const recorded = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm.commit;
    const union = unionLandedCommits(recorded, landed, tips);
    const decided = commitFmShape(union);
    markFeatureMerged(config, feature, stories, { decided, stamp });
    recordMerge(config.backlogRoot, feature.featureDir, {
      commits: union,
      date: stamp,
      extra: [...releaseLines, ...noReviewLines(gates.unreviewed, stamp)],
    });
    // `priority.md` is not touched (F-78 D3): a merged feature leaves the
    // order because it is closed, and its date is in this merge's commit.
    // Its theme's `## State` records it too (F-53 D4), in the same hold.
    const themeFile = recordThemeState(config, feature, stamp);
    if (themeFile) info(`Recorded ${feature.id} in ${themeFile} (## State).`);
    return decided;
  });
  info(
    `\nMarked ${feature.id} done${
      shape
        ? ` (commit=${
            typeof shape === 'string'
              ? shape
              : Object.entries(shape)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')
          })`
        : ''
    }, completed=${stamp}`,
  );

  const commitFailed = commitChangedSince(
    config.backlogRoot,
    backlogBefore,
    `chore: merge ${feature.id}, mark stories done`,
  );

  runFeatureStagePlugins(
    'cleanup',
    configForRepo(config, primary.repoName),
    feature,
    {
      ...featureSessionVars(feature),
      storyId: feature.id,
      featureId: feature.id,
      worktreePath: '',
      branchName,
      componentId: '',
      roostDir: config.roostDir,
      backlogDir: config.backlogRoot,
      repoPath: primary.repoPath,
    },
    primary.repoPath,
  );

  const deferred = extractSection(feature.body, 'Deferred');
  if (sectionHasContent(deferred)) {
    info(`\nDeferred items recorded on ${feature.id} — decide once what becomes new work:\n${deferred.trim()}`);
  }
  info(
    `\nDone. ${feature.id} merged in: ${targets.map((t) => t.repoName).join(', ')}; ${stories.length} stories marked done.`,
  );
  const { printInboxCount } = await import('./inbox.js');
  printInboxCount(config);
  if (commitFailed) {
    console.error(
      `\n${feature.id}: the release manifest and the merged state are written but not committed (see above).`,
    );
    process.exit(1);
  }
}
