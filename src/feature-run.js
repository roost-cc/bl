/**
 * feature-run.js — `bl run <F-id>`: the autonomous feature loop.
 *
 * A deterministic state machine in Node. Each step is one headless agent
 * invocation (or an attached one with --interactive); every outcome is read
 * back from files bl owns — story frontmatter, the feature file, its change
 * document (change-doc.js: the branch, PR, review round and status, Gate
 * lines and Review Log), and the run state under <backlogRoot>/.bl/run/. The
 * operator's two touchpoints stay
 * `bl approve` (before) and `bl merge` (after).
 *
 *   setup → implement (each story, dependency order) → test gate → self-review
 *   → push + one PR → review → fix → fix self-review → re-review … until
 *   `addressed`. Items still open after the last full round (the cap) get one
 *   closing round: fix → fix self-review → test gate → a verifier that checks
 *   only those items. Anything still open after it → `escalated` with a
 *   diagnosis in ## Escalation.
 *
 * Everything with a side effect outside the backlog files goes through the
 * injected `runner` (agent sessions, shell, forge ops, plugins) so the loop can
 * be driven by a fake in tests.
 *
 * `bl run S-n` drives the same loop over one story: `feature` is then a story
 * unit (unit.js) with `kind: "story"`, `prep.ordered` is `[story]`, the story
 * file stands in for the feature file, and the implement step uses
 * `prompts/story-run.md`.
 *
 * The loop records each hop in the unit's transition log (F-69 D3,
 * `transition.js`): `in_progress` at run start, `in_review` after the PR,
 * `fixing` or `ready_for_merge`
 * after a review, `in_review` after a fix, `escalated` with every escalation,
 * and `in_progress` by `implement` on each story before its session.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  chmodSync,
  openSync,
  closeSync,
  mkdtempSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative, dirname } from 'path';
import { isDeepStrictEqual } from 'util';
import { exitStatus, runChild, runCommandLine } from './child.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  parseFrontmatter,
  parseFrontmatterOf,
  FrontmatterError,
  serializeFrontmatter,
  runForgeOp,
  findChange,
  info,
  checkModel,
  configurationLabel,
  sameConfiguration,
  configForRepo,
} from './config.js';
import {
  escalationOpen,
  extractSection,
  replaceSection,
  sectionHasContent,
  resolveFeaturePluginsReport,
  resolveFeatureStories,
} from './feature.js';
import { featureRepoOrder, newPlan, planPath, readPlan, replan, writePlan } from './execution-plan.js';
import { edgeArrow, heldBy, readEdges } from './blockers.js';
import { runHeadlessSession, launchSession, loadPrompt, loadSchema, takeSessionLock } from './session.js';
import { flowKind, unitLabel } from './unit.js';
import { cleanStderrLine } from './outcome.js';
import { getProvider, hasProvider } from './agents/index.js';
import { tokensStepKey } from './tokens.js';
import { readSpecText, specText, updateSpecFile, withSpecFileLock } from './spec-file.js';
import { atomicWriteFile } from './atomic-write.js';
import { readComponents, sessionLockPath } from './story.js';
import { finalTabTitle, unitTitleFields, updateTabTitle } from './tab-title.js';
import { sessionEffort, storyEffort } from './effort.js';
import { otherWorktreesLine } from './workon.js';
import {
  isScripted,
  recordScriptedRun,
  reviewSkipped,
  runImplementPlugin,
  scriptedEscalation,
  scriptedSummary,
} from './scripted.js';
import {
  CHECKED_BOX_RE,
  changeNextVerb,
  parseLatestSession,
  extractReviewLog,
  featureReviewGate,
  openCheckboxItems,
  resolutionCommit,
  reviewOutcome,
  summarizeLatestReviewSession,
} from './review-log.js';
import {
  appendSection,
  changePath,
  currentChange,
  ensureChange,
  gateLine,
  readChange,
  restoreChange,
  setRepo,
  updateChange,
} from './change-doc.js';
import { otherHolder } from './kernel-lock.js';
import { RUN_DIR, runLockPath, ensureRunDir, acquireRunLock, releaseRunLock, stopRequests } from './run-lock.js';
import { takeUnitLocks } from './unit-lock.js';
import { commitPaths, dirtySnapshot } from './backlog-commit.js';
import { withMainSyncLock, MAIN_REFSPEC } from './main-sync.js';
import { GATE_TAIL_LINES, outputParts, outputSections } from './command-output.js';
import { codeSpan, fenced } from './escalation.js';
import { gateRecord, pushEscalation } from './push-gate.js';
import { describeFailure, localTime } from './agent-failure.js';
import * as processScope from './process-scope.js';
import { regenerateConflicts, regeneratePlugins } from './regenerate.js';
import { REVIEW, loadFlow } from './flow.js';
import {
  NoEdgeError,
  applyTransition,
  enterVerb,
  ensureLog,
  isoAt,
  requireBranch,
  reviewOf,
  statusOf,
  transition,
} from './transition.js';

// The run directory, its run lock and its self-ignoring setup live in
// run-lock.js; re-exported for the loop's callers.
export { RUN_DIR, runLockPath, ensureRunDir, acquireRunLock, releaseRunLock };
// Its home is agent-failure.js; feature-cmd.js and capacity.js import it from here.
export { localTime };
/**
 * The tab-title status while `bl merge` pushes an integrated branch or main:
 * git runs the repo's pre-push gate inside `git push`, so bl cannot show the
 * two apart (S-1412).
 */
export const PUSH_STATUS = 'pre-push gate + push';

export const REVIEW_DIMENSIONS = ['correctness', 'failure-paths'];

/**
 * Take the run lock of `unit` (`acquireRunLock`), then the work unit locks of
 * the unit and its stories (`takeUnitLocks`, F-122 D9), for `owner` (`run
 * F-1`). `runFeature`, `reviewFeature` and `integrateUnit` hold both to their
 * end. A work unit lock this process already holds (`bl merge F-n` took them
 * before its integration, `bl run` before its prep) is taken one depth deeper.
 *
 * Returns `{ refused }`, which names the other holder, with neither lock held;
 * or `{ refused: null, release }`, where `release()` gives back both. If the
 * take throws (the stories cannot be read), it holds neither either. With
 * both held, each stop request left by `bl stop` for an earlier holder is
 * deleted (F-87 D7a): one for another pid, or one written before this process
 * took the run lock (an earlier holder with the same pid). A request for this
 * run, written since, stays. If a delete throws, it releases both and throws.
 *
 * @param {object} config
 * @param {import('./unit-lock.js').WorkUnit} unit
 * @param {string} owner
 * @returns {{ refused: string } | { refused: null, release: () => void }}
 */
function takeRunLocks(config, unit, owner) {
  const takenAt = Date.now();
  // The lock's info line names the owner, so `bl stop` stops only a `bl run` (`runHolder`).
  const run = acquireRunLock(config, unit.id, `bl ${owner}`);
  if (run.holder != null) return { refused: `a bl run (pid ${run.holder}) is running ${unit.id}` };
  let units;
  try {
    units = takeUnitLocks(config, [unit], owner);
  } catch (e) {
    releaseRunLock(run.taken);
    throw e;
  }
  if (units.refused != null) {
    releaseRunLock(run.taken);
    return { refused: units.refused };
  }
  const release = () => {
    units.release();
    releaseRunLock(run.taken);
  };
  try {
    for (const { path, request } of stopRequests(config, unit.id)) {
      if (request.holder !== process.pid || !(Date.parse(request.at) >= takenAt)) rmSync(path, { force: true });
    }
  } catch (e) {
    release();
    throw e;
  }
  return { refused: null, release };
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export function runStatePath(config, featureId) {
  return join(config.backlogRoot, RUN_DIR, `${featureId}.json`);
}

/**
 * The saved run state, or null when there is none. Throws when the file
 * exists but is not a run state for this feature: resuming from it would
 * silently lose what it recorded (the review base, the PR, the steps done).
 */
export function loadRunState(config, featureId) {
  const p = runStatePath(config, featureId);
  if (!existsSync(p)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`run state ${p} is unreadable (${e.message})`);
  }
  if (!state || typeof state !== 'object' || state.feature !== featureId || !Array.isArray(state.history)) {
    throw new Error(`run state ${p} is not a run state for ${featureId}`);
  }
  // S-880's move to the second implementing configuration is retired by the
  // walk (F-64 D3): a state that still has `model` loads, and it is ignored.
  delete state.model;
  if (Object.hasOwn(state, 'unavailable')) checkOutList(state.unavailable, `run state ${p} unavailable`);
  return state;
}

/**
 * The run's out-list (F-64 D3) as saved: `[{ agent, model, scope, kind,
 * until, message }]`, `model` a non-empty string or null, `scope` account or
 * model, `until` an ISO time or null (out for the rest of the run). Throws,
 * naming the entry, otherwise: a misread entry would spawn a configuration
 * refused an hour ago, or skip one for good.
 */
function checkOutList(list, label) {
  if (!Array.isArray(list)) throw new Error(`${label} must be a list`);
  list.forEach((o, i) => {
    const at = `${label}[${i}]`;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${at} must be an object`);
    if (typeof o.agent !== 'string' || o.agent.trim() === '') throw new Error(`${at} agent must be a non-empty string`);
    if (o.model != null) checkModel(o.model, `${at} model`);
    if (o.scope !== 'account' && o.scope !== 'model') throw new Error(`${at} scope must be "account" or "model"`);
    if (o.until != null && !(typeof o.until === 'string' && Number.isFinite(Date.parse(o.until))))
      throw new Error(`${at} until must be an ISO time or null`);
    for (const k of ['kind', 'message']) if (typeof o[k] !== 'string') throw new Error(`${at} ${k} must be a string`);
  });
}

export function saveRunState(config, state) {
  ensureRunDir(config);
  state.updatedAt = new Date().toISOString();
  writeFileSync(runStatePath(config, state.feature), JSON.stringify(state, null, 2) + '\n');
}

export function newRunState(feature, { branch, worktreePath, maxRounds }) {
  return {
    feature: feature.id,
    branch,
    worktreePath,
    startedAt: new Date().toISOString(),
    updatedAt: null,
    // running | clean | escalated | failed | reviewed (bl review) | stopped (bl stop, with `stoppedAt` and `stoppedBy`)
    status: 'running',
    step: 'setup',
    storyIndex: 0,
    // Test-gate attempts so far; attempt n's output is .bl/run/<id>.test-<n>.log.
    testAttempts: 0,
    maxRounds,
    reviewBaseSha: null,
    pr: null,
    prOptOut: null,
    usage: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
    history: [],
    // The out-list (F-64 D3): configurations the walk skips until `until`.
    unavailable: [],
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// File readers
// ---------------------------------------------------------------------------

/**
 * Unchecked items under a story's `## Acceptance Criteria`, whatever the list
 * marker (`-`, `*`, `+`, `1.`, `1)`), each wrapped criterion joined into one
 * line. `null` when the file or the section is missing: that is never
 * "nothing left to do".
 */
export function uncheckedCriteria(storyIndexPath) {
  if (!existsSync(storyIndexPath)) return null;
  const { body } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  const section = extractSection(body, 'Acceptance Criteria');
  if (section == null) return null;
  return openCheckboxItems(section).map((i) => [i.text, ...i.lines].join(' '));
}

/** How many checked items a story's `## Acceptance Criteria` has: 0 when the file or the section is missing. */
function checkedCriteriaCount(storyIndexPath) {
  if (!existsSync(storyIndexPath)) return 0;
  const { body } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  const section = extractSection(body, 'Acceptance Criteria') ?? '';
  return section.split('\n').filter((line) => CHECKED_BOX_RE.test(line)).length;
}

/** Open criteria as the loop reports them; a missing section is one of them. */
function unmetCriteria(storyIndexPath) {
  return (
    uncheckedCriteria(storyIndexPath) ?? [
      '(no `## Acceptance Criteria` section — the criteria must live there as checkboxes)',
    ]
  );
}

/**
 * A backlog file's text with LF line ends, plus the line end it was written
 * with — so a CRLF file reads the same as an LF one and is written back as
 * CRLF.
 */
function readText(path) {
  const raw = readFileSync(path, 'utf8');
  return { text: raw.replace(/\r\n/g, '\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

/** A frontmatter key a session's usage is recorded under (`tokens_*`, `tokens_headless_*`, `tokens_updated`, `tokens_by_step`). */
const isTokenKey = (key) => key.startsWith('tokens_');

/**
 * Write the spec snapshot `before` (its text) back over `indexPath`, keeping
 * the current file's token keys: a session that ran between the snapshot and
 * the restore recorded its usage on the file, and the restore must not drop
 * it (F-67 D6). Everything else is the snapshot's, with the current file's
 * line end. A current file the session deleted, emptied or left without a
 * readable `---` block has no usage to keep: the snapshot goes back as it
 * was. A snapshot that is not a spec is refused with a `FrontmatterError`,
 * the current file left alone. Under the file's covering lock
 * (`withSpecFileLock`: its spec lock, and the backlog lock first when the
 * session deleted it), so a token write that lands meanwhile waits for it,
 * and through `atomicWriteFile`, so a failed write leaves the current file
 * whole.
 */
export async function restoreKeepingTokens(backlogRoot, indexPath, before) {
  const { content, crlf: snapCrlf } = readSpecText(before, indexPath);
  const { fm: snap, body } = parseFrontmatterOf(content, indexPath);
  return withSpecFileLock(backlogRoot, indexPath, () => {
    let raw;
    let current;
    let crlf = snapCrlf;
    try {
      raw = readFileSync(indexPath, 'utf8');
      const live = readSpecText(raw, indexPath);
      current = parseFrontmatterOf(live.content, indexPath).fm;
      crlf = live.crlf;
    } catch (e) {
      if (e?.code !== 'ENOENT' && !(e instanceof FrontmatterError)) throw e;
      if (raw === before) return false;
      atomicWriteFile(backlogRoot, indexPath, before);
      return true;
    }
    const fm = {};
    // The snapshot's keys in its order, a token key with its current value.
    for (const [k, v] of Object.entries(snap)) {
      if (!isTokenKey(k)) fm[k] = v;
      else if (Object.hasOwn(current, k)) fm[k] = current[k];
    }
    for (const [k, v] of Object.entries(current)) if (isTokenKey(k) && !Object.hasOwn(fm, k)) fm[k] = v;
    const text = specText(serializeFrontmatter(fm) + body, crlf);
    if (text === raw) return false;
    atomicWriteFile(backlogRoot, indexPath, text);
    return true;
  });
}

export function readFm(indexPath) {
  return parseFrontmatter(readText(indexPath).text).fm;
}

/**
 * `--max-rounds`: the feature's cap when absent, else a positive integer
 * written in digits only (`2abc`, `1.5`, `0`, and a bare flag are NaN).
 */
export function parseMaxRounds(raw, fallback) {
  if (raw == null) return fallback;
  const s = String(raw).trim();
  return raw !== true && /^\d+$/.test(s) && parseInt(s, 10) >= 1 ? parseInt(s, 10) : NaN;
}

const isStory = (unit) => unit?.kind === 'story';

export { escalationOpen };

/**
 * The unit's change document: the current one, else where the first one
 * goes. Fixed for the rest of the run once found (or once `setupChange`
 * ensured it), so a verifier's write is read back from the same file.
 */
function changeFile(ctx) {
  if (!ctx.changePath) {
    const dir = dirname(ctx.feature.indexPath);
    ctx.changePath = currentChange(dir)?.path ?? changePath(dir);
  }
  return ctx.changePath;
}

function changeRelPath(ctx) {
  return relative(ctx.config.backlogRoot, changeFile(ctx));
}

/** The unit's `plan.yaml` (F-125 D2), beside its change document, relative to the backlog. */
function planRelPath(ctx) {
  return relative(ctx.config.backlogRoot, planPath(dirname(ctx.feature.indexPath)));
}

/**
 * The run's execution plan: the one the run holds, else the stored one,
 * else computed from `prep.ordered` (a `bl review` or `bl merge` of a unit
 * run before F-125). Throws when the stored plan cannot be read.
 */
function runPlan(ctx) {
  ctx.plan ??=
    readPlan(dirname(ctx.feature.indexPath), ctx.feature.id) ??
    newPlan(ctx.feature.id, ctx.prep.ordered ?? [], readEdges(ctx.config));
  return ctx.plan;
}

/**
 * `prep.ordered`: the stories the run has taken first, in the order it took
 * them, then the others in the plan's work order, each as `stories` has it.
 * In place, and the taken stories first, because the implement loop's index
 * points into this array: a story the plan moves before that index is not
 * skipped.
 */
function followPlan(ctx, stories) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  ctx.prep.ordered ??= [];
  const taken = ctx.prep.ordered.filter((s) => ctx.implemented.has(s.id));
  const rest = runPlan(ctx)
    .order.filter((id) => !ctx.implemented.has(id))
    .map((id) => byId.get(id))
    .filter(Boolean);
  ctx.prep.ordered.splice(0, ctx.prep.ordered.length, ...taken, ...rest);
}

/**
 * The plan at run start (F-125 D2). A fresh run computes it from the unit's
 * stories (`prep.ordered`) and `readEdges`, and writes it. `--resume` reads
 * the stored plan and does not compute it again, unless the unit's stories
 * changed between the runs (`replan`, with a `changes` entry); a resumed run
 * with no `plan.yaml` computes and writes one. `prep.ordered` then follows
 * the plan's `order`. Returns whether it wrote the file; throws when the
 * stored plan cannot be read or the plan cannot be written.
 */
async function setupPlan(ctx, resume) {
  const { feature, config, prep } = ctx;
  const dir = dirname(feature.indexPath);
  const stories = prep.ordered ?? [];
  let stored = null;
  try {
    if (resume) stored = readPlan(dir, feature.id);
  } catch (e) {
    throw new Error(`${e.message} — fix it, or delete it to compute a new plan`, { cause: e });
  }
  const plan = stored
    ? replan(stored, stories, readEdges(config), { why: `the stories of ${feature.id} changed between runs` })
    : newPlan(feature.id, stories, readEdges(config));
  ctx.plan = plan;
  followPlan(ctx, stories);
  if (plan === stored) return false;
  await writePlan(config.backlogRoot, dir, plan);
  return true;
}

/** The change document's frontmatter and body; empty while there is none. */
function readChangeText(ctx) {
  const p = changeFile(ctx);
  return existsSync(p) ? parseFrontmatter(readText(p).text) : { fm: {}, body: '' };
}

/**
 * The unit's review state, from its log (`reviewOf`, F-69 D5): its round,
 * the rounds with a verdict, and its review position. A unit with no log
 * reads its change document's old fields (D4).
 */
function reviewState(ctx) {
  return reviewOf(unitKind(ctx), readFm(ctx.feature.indexPath), readChangeText(ctx));
}

/**
 * The repo whose worktree the run works in, and where its PR opens: a
 * story's one repo, or a feature's lead repo (`featureRepoOrder`, F-52 D3).
 */
function prepRepo(ctx) {
  return ctx.prep.targetRepoName ?? '';
}

/** The change document's `repos:` entry for `repo` (the run's repo by default), or null. */
function recordedRepo(ctx, repo = prepRepo(ctx)) {
  return readChange(changeFile(ctx))?.repos.find((r) => r.repo === repo) ?? null;
}

/** The unit as `## Description` (the PR body) opens it; `ordered` is a feature's or a batch's stories. */
export function unitDescription(unit, ordered = []) {
  if (isStory(unit)) return `Story ${unit.id}: ${unit.title} (${unit.points} pts)`;
  const stories = ordered.map((s) => `- ${s.id} — ${s.title} (${s.points} pts)`).join('\n');
  return `${unitLabel(unit)} ${unit.id}: ${unit.title}\n\nStories:\n${stories}`;
}

function describeUnit(ctx) {
  return unitDescription(ctx.feature, ctx.prep.ordered);
}

/**
 * The run's change document: an open one naming every repo the run prepared,
 * on the run's branch (created with the branch when the unit has none open),
 * with `## Description` written once. Resolves whether it changed.
 */
async function setupChange(ctx) {
  const { feature, prep, config } = ctx;
  const names = [prepRepo(ctx), ...(prep.otherWorktrees ?? []).map((w) => w.repoName)];
  const repos = names.filter((r, i) => r && names.indexOf(r) === i).map((repo) => ({ repo, branch: prep.branchName }));
  const res = await ensureChange(config.backlogRoot, dirname(feature.indexPath), {
    changeOf: feature.id,
    title: feature.title,
    repos,
  });
  ctx.changePath = res.path;
  if (sectionHasContent(extractSection(res.doc.body, 'Description'))) return res.changed;
  await updateChange(config.backlogRoot, res.path, (doc) => {
    if (sectionHasContent(extractSection(doc.body, 'Description'))) return false;
    doc.body = appendSection(doc.body, 'Description', describeUnit(ctx));
  });
  return true;
}

/**
 * The `## Gate` lines in the change document for one gate run, one per repo
 * the gate reached (`gate.perRepo`, S-1010): the date, the repo, its command
 * and its verdict. Committed at once; a gate whose lines cannot be written
 * still stands.
 */
async function recordGateLine(ctx, gate) {
  const path = changeFile(ctx);
  if (!existsSync(path)) return;
  const date = runnerNow(ctx.runner).toISOString().slice(0, 10);
  const verdict = !gate.ok ? 'fail' : gate.skipped ? 'skipped' : 'pass';
  const attempt = ctx.state.testAttempts > 0 ? `attempt ${ctx.state.testAttempts}` : '';
  const entries = gate.perRepo ?? [
    { repo: gate.repo ?? prepRepo(ctx), command: gate.command, config: gate.config, verdict },
  ];
  const lines = entries.map((e) => {
    const command = e.command ? codeSpan(e.command) : e.config ? '(misconfigured)' : '(no test plugin)';
    return gateLine({ date, repo: e.repo, command, verdict: e.verdict, detail: attempt });
  });
  try {
    await updateChange(ctx.config.backlogRoot, path, (doc) => {
      for (const line of lines) doc.body = appendSection(doc.body, 'Gate', line);
    });
  } catch (e) {
    record(ctx, {
      step: 'test',
      ok: false,
      note: `could not write the gate line to ${changeRelPath(ctx)}: ${e.message}`,
    });
    return;
  }
  await commitChangeFile(ctx, 'test', `chore: ${ctx.feature.id} gate ${verdict}${attempt ? ` (${attempt})` : ''}`);
}

/**
 * Whether the implement step skips `story`: it is closed, or no acceptance
 * criterion is unchecked. A story that is not started (`draft`, `refined`)
 * also needs at least one checked box: criteria with no checkbox (prose, a
 * plain list) say nothing about work done. An agent files an ad-hoc story
 * with its criteria checked.
 */
function storyComplete(story, backlogRoot) {
  const flow = loadFlow(backlogRoot);
  if (flow.meets('story', story.status, 'done')) return true;
  const path = join(backlogRoot, story.storyRelPath);
  const status = statusOf('story', readFm(path));
  if (flow.meets('story', status, 'done')) return true;
  const open = uncheckedCriteria(path);
  if (open === null || open.length > 0) return false;
  return flow.meets('story', status, 'in_progress') || checkedCriteriaCount(path) > 0;
}

/**
 * Record `in_progress` by `implement` on story `s` when it is not started
 * yet (`draft` or `refined`), and commit it (F-69 D3): before its session,
 * and for a complete story an agent filed or attached during the run
 * (`_blocked-by-bug.md`). The agent no longer sets a status. A story run on
 * its own is started by its run already.
 */
async function startStory(ctx, s) {
  const root = ctx.config.backlogRoot;
  const path = join(root, s.storyRelPath);
  if (!loadFlow(root).isUnstarted('story', statusOf('story', readFm(path)))) return;
  if (await logWrite(ctx, 'implement', async () => enterVerb(root, { kind: 'story', indexPath: path }, 'implement'))) {
    await commitUnitPaths(ctx, 'implement', [s.storyRelPath], `chore: ${s.id} in_progress (implement)`);
  }
}

function tail(text, lines = 200) {
  const arr = String(text ?? '').split('\n');
  return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}

function head(text, lines) {
  const arr = String(text ?? '').split('\n');
  return arr.length <= lines ? arr.join('\n') : `${arr.slice(0, lines).join('\n')}\n… (see the full log)`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** The step list a run would execute, for `--plan` and for tests. */
export function planSteps(ordered, maxRounds) {
  const steps = [{ step: 'setup' }];
  for (const s of ordered) steps.push({ step: 'implement', story: s.id });
  steps.push({ step: 'test' }, { step: 'self-review' }, { step: 'pr' });
  steps.push({ step: 'review', round: 1 });
  for (let r = 2; r <= maxRounds; r++) {
    steps.push(
      { step: 'fix', round: r - 1 },
      { step: 'fix-self-review', round: r - 1 },
      { step: 're-review', round: r },
    );
  }
  // Items still open after the last full round get one closing round: a fix,
  // then a verifier that checks only those items (see runFeature).
  steps.push(
    { step: 'fix', round: maxRounds },
    { step: 'fix-self-review', round: maxRounds },
    { step: 'closing-review', round: maxRounds + 1 },
  );
  steps.push({ step: 'stop', note: 'clean → bl merge; else escalated' });
  return steps;
}

/**
 * What `bl run --plan` prints: the execution plan (`computePlan`'s: the
 * dependencies, the work order, the parallel groups, the repo order and the
 * merge order, or the merge-edge cycle that leaves none), then the step list
 * (`planSteps`).
 */
export function formatPlan(unit, plan, steps) {
  const list = (ids) => (ids.length > 0 ? ids.join(', ') : '(none)');
  const merge = plan.merge_order
    ? list(plan.merge_order)
    : `none: the merge edges form a cycle (${(plan.merge_cycle ?? []).map(edgeArrow).join(', ')})`;
  const lines = [
    `${unit.id} · ${unit.title} — run plan`,
    'Dependencies:',
    ...plan.stories.map((id) => `  ${id} waits for ${list(plan.dependencies[id] ?? [])}`),
    `Work order  : ${list(plan.order)}`,
    `Groups      : ${plan.groups.map((g, i) => `${i + 1}. ${g.join(', ')}`).join(' · ')}`,
    `Repos       : ${list(plan.repos)}`,
    `Merge order : ${merge}`,
    'Steps:',
  ];
  steps.forEach((s, i) => {
    const extra = s.story ? ` ${s.story}` : s.round ? ` (round ${s.round})` : s.note ? ` — ${s.note}` : '';
    lines.push(`${String(i + 1).padStart(2)}. ${s.step}${extra}`);
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default runner (real side effects)
// ---------------------------------------------------------------------------

/** The environment variable that carries this bl's container-owner token to its steps. */
export const CONTAINER_OWNER_ENV = 'BL_CONTAINER_OWNER';
/** The label a test helper sets to that token on each container it creates. */
export const CONTAINER_OWNER_LABEL = 'cc.roost.bl-owner';

/**
 * Parse `docker ps` lines (ID, name, compose project, owner label; tab-separated)
 * into the container cleanup's snapshot. A container whose owner label names
 * another bl is left out: two loops run at the same time, and one loop's
 * cleanup must not remove the containers that the other loop's step uses. A
 * container without the label is kept, as before.
 * @param {string|null|undefined} stdout
 * @param {string} owner - this bl's token
 * @returns {{ id: string, name: string, compose: boolean }[]}
 */
export function parseContainerList(stdout, owner) {
  return String(stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([, , , label]) => !label || label === owner)
    .map(([id, name, project]) => ({ id, name, compose: Boolean(project) }));
}

export function defaultRunner({ interactive = false, extraPrompt = '' } = {}) {
  // Every step this bl starts inherits the token. A test helper sets it as the
  // CONTAINER_OWNER_LABEL of each container it creates, and listContainers
  // leaves out containers that carry another bl's token.
  const containerOwner = `${process.pid}-${randomUUID()}`;
  process.env[CONTAINER_OWNER_ENV] = containerOwner;
  return {
    // An interactive run attaches each session and does not walk the list.
    interactive,
    /**
     * The adapter's capacity reading for one configuration (F-64 D1), with
     * the run config's `backlog.json` top level `topLevel`; never throws.
     */
    capacity(agent, model, topLevel) {
      return getProvider(agent).capacity({ model, topLevel });
    },
    /** The adapter's `{ checkCommand, billingUrl }` for an escalation's steps (S-1140). */
    remediation(agent) {
      return getProvider(agent).remediation();
    },
    async session({
      mode,
      agent,
      promptName,
      vars,
      worktreePath,
      unitDir = null,
      config,
      parsed,
      label,
      usageIndexPath,
      tokensStep = null,
      model = undefined,
      effort = null,
      scope = null,
      schema = null,
      retry = null,
      follow = null,
    }) {
      // An interactive session returns its outcome in the outcome file (F-68 D1).
      const promptVars = interactive && schema ? { ...vars, outcomeCarrier: 'file' } : vars;
      const base = loadPrompt(promptName, promptVars, { agent, config });
      let prompt = extraPrompt ? `${base}\n\n## Additional instructions from the operator\n\n${extraPrompt}\n` : base;
      // The outcome retry (F-68 D5): a resumed headless session hears only the
      // note; any other session gets the whole prompt with the note after it.
      const resume = !interactive && retry?.sessionId ? retry.sessionId : null;
      if (retry) prompt = resume ? retry.note : `${prompt}\n\n${retry.note}\n`;
      if (interactive) {
        const ret = await launchSession({
          mode,
          parsed,
          title: label,
          worktreePath,
          unitDir,
          branchName: vars.branchName,
          sessionPrompt: prompt,
          roostDir: config.roostDir,
          backlogRoot: config.backlogRoot,
          isNewWorktree: false,
          agent,
          config,
          forceNew: true,
          returnOnExit: true,
          recordTokens: false,
          sessionName: label,
          tokensStep,
          tokensIndexPath: usageIndexPath,
          model,
          effort,
          schema,
        });
        // launchSession returns exitStatus of the agent (a kill is nonzero),
        // with the outcome beside it when the step has a schema.
        const { status, structured = null, structuredError = null } = schema ? ret : { status: ret };
        return {
          ok: status === 0,
          output: '',
          isError: status !== 0,
          usage: null,
          refusal: null,
          structured,
          structuredError,
        };
      }
      const r = await runHeadlessSession({
        mode,
        parsed,
        prompt,
        worktreePath,
        unitDir,
        agent,
        config,
        roostDir: config.roostDir,
        backlogRoot: config.backlogRoot,
        label,
        usageIndexPath,
        usageStep: tokensStep,
        logCommand: `feature ${mode}`,
        model,
        effort,
        schema,
        sessionId: resume,
        follow,
        // The agent and all it starts live in the step's scope (F-70 D4).
        run: scope ? processScope.scopedSpawn(scope) : undefined,
      });
      return {
        ok: !r.isError,
        output: r.output,
        isError: r.isError,
        usage: r.usage,
        error: r.error,
        denials: r.denials ?? [],
        refusal: r.refusal ?? null,
        sessionId: r.sessionId ?? null,
        structured: r.structured ?? null,
        structuredError: r.structuredError ?? null,
        stderrTail: r.stderrTail ?? '',
      };
    },
    /** `scope`: run `cmd` as `sh -c <cmd>` inside that user systemd scope (F-70 D4). */
    shell(cmd, cwd, { mergeStreams = false, scope = null } = {}) {
      if (mergeStreams) return shellMerged(cmd, cwd, { scope });
      const r = spawnShell(cmd, scope, {
        cwd,
        encoding: 'utf8',
        env: { CI: 'true', ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        status: exitStatus(r),
        output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      };
    },
    forge(op, vars, { config, repoPath }) {
      return runForgeOp(op, vars, { config, repoPath });
    },
    testPlugins(config, featureIndexPath, componentEntry) {
      return resolveFeaturePluginsReport('test', config, featureIndexPath, { componentEntry });
    },
    /**
     * Every container on the host that no other bl owns, with whether it
     * belongs to a compose project. Null when docker is unavailable or the
     * operator opted out with BL_KEEP_TEST_CONTAINERS=1 — the cleanup then
     * does nothing.
     */
    listContainers() {
      if (process.env.BL_KEEP_TEST_CONTAINERS === '1') return null;
      const r = runChild(
        'docker',
        [
          'ps',
          '-a',
          '--no-trunc',
          '--format',
          `{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "${CONTAINER_OWNER_LABEL}"}}`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 },
      );
      if (r.error || r.status !== 0) return null;
      return parseContainerList(r.stdout, containerOwner);
    },
    removeContainers(ids) {
      const r = runChild('docker', ['rm', '-f', ...ids], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      return { status: exitStatus(r), output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
    // Process hygiene (F-70 D4, src/process-scope.js). A runner without these
    // methods (the unit tests' fake) skips it, as one without listContainers
    // skips the container cleanup.
    scopeAvailable() {
      return processScope.scopeAvailable();
    },
    scopeProcesses(unit) {
      return processScope.scopeProcesses(unit);
    },
    stopScope(unit) {
      return processScope.stopScope(unit);
    },
    staleScopes(unitId) {
      return processScope.staleScopes(unitId);
    },
    /** Ring the terminal bell: the run reached an end state the operator should look at. */
    notify() {
      process.stderr.write('\x07');
    },
    /**
     * Set tab-title fields (`tab-title.js`): the feature, the story in hand, the step or end state.
     * With `final`, the title is an end state that stays after bl exits.
     */
    title(fields, { final = false } = {}) {
      if (final) finalTabTitle(fields);
      else updateTabTitle(fields);
    },
    now() {
      return new Date();
    },
    /**
     * Wait `ms` on a timer. The usage-limit wait awaits this in slices of at
     * most a second; Ctrl+C ends it at once (F-105 A2).
     */
    async sleep(ms) {
      await delay(ms);
    },
    log: info,
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function record(ctx, entry) {
  ctx.state.history.push({ ...entry, at: new Date().toISOString() });
  saveRunState(ctx.config, ctx.state);
}

/**
 * The tab-title fields for the run's unit and the story in hand (`unitTitleFields`):
 * a feature or story batch is `feature` with `story` the story in hand, a story unit
 * is `story`. A field the unit does not name is set empty, so a field from an
 * earlier title is cleared.
 */
function unitTitle(ctx, story = '') {
  return { feature: '', story, ...unitTitleFields(ctx.feature.id) };
}

/** Enter `step` and save it; a stop request stops the run here, before the step does anything. */
function setStep(ctx, step, extra = {}) {
  ctx.state.step = step;
  Object.assign(ctx.state, extra);
  saveRunState(ctx.config, ctx.state);
  // A runner without `title` (the unit tests' fake) sets no tab title.
  ctx.runner.title?.({ ...unitTitle(ctx, extra.story), status: step });
  ctx.runner.log(
    `\n── ${ctx.feature.id} ▸ ${step}${extra.story ? ` ${extra.story}` : ''}${extra.round ? ` (round ${extra.round})` : ''}`,
  );
  checkStop(ctx);
}

/**
 * Mark run state `state` stopped (F-87 D7a): a `{ step: "stopped" }` history
 * entry with `note`, `status: stopped`, `stoppedAt`, and `stoppedBy`, the
 * pids of the `bl stop`s whose requests stopped it (`by`). So `bl top` knows
 * whether its own stop did it (D8). `step` keeps the step the run stopped in,
 * which `bl status` shows. The caller saves the state. The loop (`checkStop`)
 * and `bl stop` for a run no bl holds both use it.
 *
 * @param {number[]} by
 */
export function markStopped(state, note, by) {
  const at = new Date().toISOString();
  state.history.push({ step: 'stopped', ok: true, note, at });
  state.status = 'stopped';
  state.stoppedAt = at;
  state.stoppedBy = by;
  state.lastError = null;
}

/**
 * Stop the run when `bl stop` has written its stop request (F-87 D7a):
 * called at each step start (`setStep`), in each slice of a usage-limit wait,
 * and after each spawn in `newScope(ctx)` returns, before the loop reads its
 * result, so the stopped session is not an attempt and does not escalate.
 * Marks the state stopped
 * (`markStopped`), saves it, deletes the requests for this process and throws a
 * StopRequestError, which unwinds the step's cleanups to `runFeature`. The
 * locks go with it, and `bl run` exits 130. The unit's `status:` does not
 * change. Only a request for this process counts (its `holder`, the run lock
 * holder `bl stop` saw): a request for an earlier holder is not for this run,
 * and it stays for its own `bl stop` or the next `takeRunLocks` to delete.
 */
function checkStop(ctx) {
  const mine = stopRequests(ctx.config, ctx.feature.id).filter(({ request }) => request.holder === process.pid);
  if (mine.length === 0) return;
  const { state } = ctx;
  const reason = `stopped by bl stop at ${state.step}`;
  markStopped(
    state,
    reason,
    mine.map(({ request }) => request.pid),
  );
  saveRunState(ctx.config, state);
  for (const { path } of mine) rmSync(path, { force: true });
  finalTitle(ctx, 'stopped');
  safeLog(ctx.runner, `\n${ctx.feature.id} stopped at ${state.step}; resume: ${ctx.resumeHint}`);
  throw new StopRequestError(reason, state);
}

/**
 * Commit `paths` in the backlog through `commitPaths` (`backlog-commit.js`,
 * F-126 D1): under the main sync lock, pushed to an `origin` remote (F-50
 * D4), and a failed push is its warning. A backlog with no repo of its own
 * commits nothing and is no failure. A backlog commit that did not land is a
 * failed event, not a silent one.
 */
async function commitUnitPaths(ctx, step, paths, message) {
  const c = await commitPaths(ctx.config.backlogRoot, paths, message);
  if (c.committed || c.notRepo) return true;
  const note = `backlog commit failed: "${message}" — ${paths.join(', ')} ${paths.length === 1 ? 'is' : 'are'} written but uncommitted${c.error ? ` (${c.error})` : ''}`;
  record(ctx, { step, ok: false, note });
  ctx.runner.log(`  (${note})`);
  return false;
}

async function commitFeatureFile(ctx, step, message) {
  return commitUnitPaths(ctx, step, [ctx.feature.featureRelPath], message);
}

async function commitChangeFile(ctx, step, message) {
  return commitUnitPaths(ctx, step, [changeRelPath(ctx)], message);
}

/** The unit's type in `flow.json`: a story run on its own, a story batch, or a feature. */
function unitKind(ctx) {
  return flowKind(ctx.feature);
}

/** The unit as `transition` takes it. */
function unitRef(ctx) {
  return { kind: unitKind(ctx), indexPath: ctx.feature.indexPath };
}

/** The unit's status now, from its log. */
function unitStatus(ctx) {
  return statusOf(unitKind(ctx), readFm(ctx.feature.indexPath));
}

/**
 * Record a hop of the loop in the unit's log (F-69 D3) and commit the unit
 * file, through `logWrite`.
 */
async function hop(ctx, step, to, opts) {
  await writeHop(ctx, step, async () => transition(ctx.config.backlogRoot, unitRef(ctx), to, opts));
}

/** `hop` for a verb's start (`enterVerb`). */
async function enterHop(ctx, step, verb) {
  await writeHop(ctx, step, async () => enterVerb(ctx.config.backlogRoot, unitRef(ctx), verb));
}

/** Run `write` through `logWrite`, and commit the unit file when it recorded an entry. */
async function writeHop(ctx, step, write) {
  const entry = await logWrite(ctx, step, write);
  if (entry) await commitFeatureFile(ctx, step, `chore: ${ctx.feature.id} ${entry.to} (${entry.by})`);
}

/**
 * Run `write`, a write to a transition log that returns the entry it
 * recorded or null. A status with no such edge (`NoEdgeError`: an operator
 * moved the unit while the run went on) records nothing, and a warning in
 * the run's history says so. Any other error (a spec lock timeout, a disk
 * error) stops the run: the next step depends on the entry.
 */
async function logWrite(ctx, step, write) {
  try {
    return await write();
  } catch (e) {
    if (!(e instanceof NoEdgeError)) {
      const reason = `the transition log could not be written at ${step}: ${e.message}`;
      throw new RunStoppedError(reason, await finish(ctx, 'failed', reason));
    }
    record(ctx, { step, ok: true, warning: true, note: `not recorded in the transition log: ${e.message}` });
    ctx.runner.log(`  warning: not recorded in the transition log: ${e.message}`);
    return null;
  }
}

/**
 * The verb whose failure branch takes a unit at `status` to `escalated`:
 * `merge` inside `bl merge`'s integration, else the one running at that
 * status (`run`, `review`, `fix`); null when no verb does or it is escalated
 * already (`merge` starts from `escalated`, so its failure branch is an edge
 * from `escalated` to itself).
 */
export function escalatingVerb(flow, kind, status, integration) {
  if (status === 'escalated') return null;
  const bys = flow
    .edges(kind)
    .filter((e) => e.from === status && e.to === 'escalated')
    .map((e) => e.by);
  if (integration && bys.includes('merge')) return 'merge';
  return bys.find((b) => b !== 'merge') ?? bys[0] ?? null;
}

/**
 * Write `## Escalation` unless it already has content, and record
 * `escalated` in the unit's log, story or feature (F-69 D1, D3), by the verb
 * that escalated, with the reason as its note. With `fold`, used by
 * `bl merge`'s integration, content an agent wrote during the merge is kept
 * below bl's own reason and details instead of standing alone (F-36 D8).
 */
async function writeEscalation(ctx, reason, details = '', { fold = false } = {}) {
  const { feature } = ctx;
  const text = `${reason}${details ? `\n\n${details}` : ''}`.trim();
  const flow = loadFlow(ctx.config.backlogRoot);
  const kind = unitKind(ctx);
  // Under the spec lock, inside the backlog lock when `bl merge` holds it
  // (F-67 D4): a token step entry a session writes meanwhile is kept.
  await updateSpecFile(ctx.config.backlogRoot, feature.indexPath, (fm, body) => {
    const by = escalatingVerb(flow, kind, statusOf(kind, fm), Boolean(ctx.integration));
    const note = String(reason).split('\n')[0];
    if (by) applyTransition(flow, kind, fm, 'escalated', { by, note });
    const existing = extractSection(body, 'Escalation');
    if (!sectionHasContent(existing)) {
      return existing == null
        ? `${body.trimEnd()}\n\n## Escalation\n\n${text}\n`
        : replaceSection(body, 'Escalation', text);
    }
    if (fold) return replaceSection(body, 'Escalation', `${text}\n\nWritten during the merge:\n\n${existing.trim()}`);
    return body;
  });
  await commitFeatureFile(ctx, 'escalate', `chore: ${feature.id} escalated — ${reason}`);
}

/**
 * Set the tab title's end state for a run status (S-1393) as a final title,
 * which stays after bl exits: the status shown and the step the operator
 * does next, short enough for the tmux status bar. The next step after an
 * escalation is the loop's resume command (`ctx.resumeHint`) without the
 * unit id.
 */
function finalTitle(ctx, status) {
  let next = '';
  if (status === 'clean') next = '→ bl merge';
  else if (status === 'escalated') {
    const hint = resumeCommand(ctx);
    next = `→ fix, ${hint.endsWith(' --resume') ? '--resume' : hint.replace(` ${ctx.feature.id}`, '')}`;
  }
  const shown = status === 'no-change' ? 'done' : status;
  ctx.runner.title?.({ ...unitTitle(ctx), status: shown, next }, { final: true });
}

async function finish(ctx, status, reason = null, details = '') {
  // Inside `bl merge`'s integration a stop is a merge escalation (F-36 D8):
  // its reason says so, and it names the repos, files and next step.
  if (status === 'escalated' && ctx.integration) {
    reason = `merge with main: ${reason}`;
    details = [details, ctx.integration.details()].filter(Boolean).join('\n\n');
  }
  if (status === 'escalated') await writeEscalation(ctx, reason, details, { fold: Boolean(ctx.integration) });
  ctx.state.status = status;
  ctx.state.lastError = reason;
  // `step` keeps the step the run stopped in — that is what `bl status`
  // shows and where `--resume` picks up.
  saveRunState(ctx.config, ctx.state);
  finalTitle(ctx, status);
  ctx.runner.notify(`${ctx.feature.id} ${status}`);
  const log = ctx.runner.log;
  log('');
  if (status === 'no-change') {
    log(`${ctx.feature.id} needed no change: marked done, nothing pushed.`);
  } else if (status === 'clean') {
    log(`${ctx.feature.id} is reviewed clean${ctx.state.pr?.url ? `: ${ctx.state.pr.url}` : ''}.`);
    log(`Next: bl merge ${ctx.feature.id}`);
  } else if (status === 'escalated') {
    log(`${ctx.feature.id} escalated — ${reason}`);
    log(
      `See ## Escalation in ${ctx.feature.featureRelPath}; fix, clear it to "None.", then ${ctx.integration ? ctx.resumeHint : `bl run ${ctx.feature.id} --resume`}`,
    );
  } else {
    log(`${ctx.feature.id} run failed — ${reason}`);
  }
  return ctx.state;
}

/**
 * Run `fn`, then remove the containers it left behind: new since the call
 * started and not part of a compose project. Integration tests run by an
 * agent or by the test gate start helpers (garcon's `minio-in-memory` on port
 * 9000, `dynamodb-*`) and leave them running; on 2026-09-24 one blocked the
 * containers stack's MinIO and the whole stack start aborted. Compose-stack
 * containers and anything that already existed are never touched. A runner
 * without `listContainers` (or one that returns null: docker unavailable,
 * BL_KEEP_TEST_CONTAINERS=1) skips the cleanup, as does an initial snapshot
 * with any entry lacking a non-empty string ID: it cannot vouch for what
 * already existed.
 *
 * A cleanup that was attempted and failed (the second snapshot or the removal
 * failed, threw, or returned something unusable) escalates the run: the
 * containers may still be running and would collide with the next step.
 * `fn`'s own error, when it threw, is rethrown; otherwise a
 * ContainerCleanupError unwinds to runFeature / reviewFeature.
 */
/**
 * A container entry the cleanup can act on: an object whose `id` is a string
 * with something other than whitespace in it. One rule for both snapshots —
 * rounds 2 and 3 of F-3's review each found a sibling case that one snapshot
 * checked and the other did not.
 */
export function isUsableContainer(c) {
  return normalizeSnapshot([c]) !== null;
}

/** A snapshot is usable only when it is an array and every entry is usable. */
export function usableSnapshot(list) {
  return normalizeSnapshot(list) !== null;
}

/**
 * Validate a runner's container snapshot and copy it into plain objects, or
 * return null when it is unusable. The runner is a boundary: whatever it
 * returns is read exactly once, here, inside a try — a throwing getter, a
 * proxy, or an iteration trap makes the snapshot unusable instead of throwing
 * — and everything downstream works on the copies, so no later read of `id`,
 * `name`, or `compose` can throw or change value.
 *
 * @returns {{ id: string, name: string, compose: boolean }[] | null}
 */
export function normalizeSnapshot(list) {
  try {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const c of list) {
      if (c === null || typeof c !== 'object') return null;
      const id = c.id;
      if (typeof id !== 'string' || id.trim() === '') return null;
      const name = c.name;
      const compose = c.compose;
      out.push({ id: id.trim(), name: typeof name === 'string' ? name : '', compose: Boolean(compose) });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Describe a thrown value without letting the description throw: `null`,
 * `undefined`, primitives, and objects whose `message` getter or string
 * conversion throws all come back as text. Every catch block in the cleanup
 * path goes through this (F-3 rounds 4 and 5 each found an unguarded one).
 */
export function describeThrown(e) {
  try {
    if (e instanceof Error && typeof e.message === 'string') return e.message;
    return String(e);
  } catch {
    return 'an unprintable value';
  }
}

/** Read a runner's removal result once, guarded, into `{ status, output }`. */
export function readRemoval(r) {
  try {
    const status = r?.status;
    const output = r?.output;
    return { status: typeof status === 'number' ? status : null, output: typeof output === 'string' ? output : '' };
  } catch {
    return { status: null, output: 'an unreadable removal result' };
  }
}

/** Log through the runner without letting a logging failure skip an escalation. */
function safeLog(runner, message) {
  try {
    runner.log(message);
  } catch {
    // the history record is the source of truth; the log line is a courtesy
  }
}

async function withContainerCleanup(ctx, label, fn) {
  const { runner } = ctx;
  let before = null;
  try {
    before = typeof runner.listContainers === 'function' ? runner.listContainers() : null;
  } catch {
    before = null;
  }
  // An unusable initial snapshot means we cannot tell what already existed,
  // so nothing may be classified as fresh: skip the cleanup entirely.
  before = normalizeSnapshot(before);
  if (!before) return await fn();
  let result;
  let thrown = null;
  try {
    result = await fn();
  } catch (e) {
    thrown = { e };
  }
  const failure = removeFreshContainers(ctx, label, before);
  if (failure) await finish(ctx, 'escalated', `container cleanup after ${label} failed`, failure);
  if (thrown) throw thrown.e;
  if (failure) throw new ContainerCleanupError(failure, ctx.state);
  return result;
}

/**
 * A run the loop stopped from inside a step, after `finish()` saved the
 * escalated state, or the failed one when a log write failed (`logWrite`,
 * `recordVerdict`), or after `checkStop` saved the stopped one. Thrown so the step's callers skip their bookkeeping (a
 * nudge retry, a review round's verdict), and caught by runFeature and
 * reviewFeature, which return that state; `escalated` is true only for an
 * escalated one.
 */
export class RunStoppedError extends Error {
  constructor(message, state) {
    super(message);
    this.state = state;
  }
}

export class ContainerCleanupError extends RunStoppedError {}

/** A step's processes could not be stopped (F-70 D4). */
export class ProcessCleanupError extends RunStoppedError {}

/** The agent refused for a usage limit the loop could not wait out. */
export class AgentUnavailableError extends RunStoppedError {}

/** A step's session returned no valid outcome, retried once (F-68 D5). */
export class OutcomeError extends RunStoppedError {}

/** `bl stop` asked the run to stop (F-87 D7a, `checkStop`). */
export class StopRequestError extends RunStoppedError {}

/** Remove what `label` left behind; returns why it could not, or null. Never throws. */
function removeFreshContainers(ctx, label, before) {
  const { runner } = ctx;
  let raw;
  let listThrew = false;
  let listError;
  try {
    raw = runner.listContainers();
  } catch (e) {
    listThrew = true;
    listError = e;
  }
  // An unusable post-step snapshot cannot drive a removal: escalate instead.
  const after = listThrew ? null : normalizeSnapshot(raw);
  if (!after) {
    const why = listThrew ? describeThrown(listError) : 'no usable container list';
    const note = `could not list containers after ${label} (${why}) — any it started may still be running`;
    record(ctx, { step: 'hygiene:containers', ok: false, note });
    safeLog(runner, `  (${note})`);
    return note;
  }
  const known = new Set(before.map((c) => c.id));
  const fresh = after.filter((c) => !known.has(c.id) && !c.compose);
  if (fresh.length > 0) {
    const names = fresh.map((c) => c.name || c.id.slice(0, 12)).join(', ');
    let r;
    try {
      r = readRemoval(runner.removeContainers(fresh.map((c) => c.id)));
    } catch (e) {
      r = { status: null, output: describeThrown(e) };
    }
    const ok = r.status === 0;
    record(ctx, {
      step: 'hygiene:containers',
      ok,
      note: `${ok ? 'removed' : 'could not remove'} ${fresh.length} container${fresh.length === 1 ? '' : 's'} left by ${label}: ${names}`,
    });
    safeLog(
      runner,
      `  (${ok ? 'removed' : 'could not remove'} test container${fresh.length === 1 ? '' : 's'} left by ${label}: ${names})`,
    );
    if (!ok)
      return `could not remove the containers left by ${label}; they may still be running: ${names}${r.output ? ` (${r.output.trim()})` : ''}`;
  }
  return null;
}

/** The runner methods process hygiene needs (F-70 D4); a runner without them skips it. */
const SCOPE_METHODS = ['scopeAvailable', 'scopeProcesses', 'stopScope', 'staleScopes'];

/** Scope names are numbered per bl process, so two units' runs in one process never share one. */
let scopeCount = 0;

/**
 * Whether this run's steps run in user systemd scopes. The runner's probe is
 * read once per context; when it fails, the run records one
 * `hygiene:processes` entry (`ok: true`) and one log line saying process
 * hygiene is unavailable and why, and nothing is ever killed (decision D4-a).
 */
function processHygiene(ctx) {
  const { runner } = ctx;
  if (!SCOPE_METHODS.every((m) => typeof runner[m] === 'function')) return false;
  if (ctx.processHygiene !== undefined) return ctx.processHygiene;
  let probe;
  try {
    probe = runner.scopeAvailable();
  } catch (e) {
    probe = { ok: false, why: describeThrown(e) };
  }
  const ok = probe?.ok === true;
  ctx.processHygiene = ok;
  if (!ok) {
    const why = typeof probe?.why === 'string' && probe.why ? probe.why : 'the probe gave no reason';
    const note = `process hygiene unavailable: ${why}; steps run unscoped and no process is stopped`;
    record(ctx, { step: 'hygiene:processes', ok: true, note });
    safeLog(runner, `  (${note})`);
  }
  return ok;
}

/**
 * A new scope name for a command of the current step, or null when the step
 * is not scoped (no hygiene, or outside `withProcessCleanup`). The step's
 * cleanup stops every name handed out here.
 */
function newScope(ctx) {
  if (!Array.isArray(ctx.scopes)) return null;
  scopeCount += 1;
  const unit = processScope.scopeUnitName(ctx.feature.id, scopeCount);
  ctx.scopes.push(unit);
  return unit;
}

/**
 * Run `fn` with its commands in user systemd scopes (`newScope`), then stop
 * every scope of the step still active and record what was left in it, as
 * `withContainerCleanup` does for containers. Called inside
 * `withContainerCleanup`, so processes are stopped before containers are
 * listed: a hung test can hold a container.
 *
 * A stop that fails, or a scope still active after it, escalates the run: the
 * processes may still be running and would collide with the next step. `fn`'s
 * own error, when it threw, is rethrown; otherwise a ProcessCleanupError
 * unwinds to runFeature / reviewFeature / integrateUnit.
 */
async function withProcessCleanup(ctx, label, fn) {
  if (!processHygiene(ctx)) return await fn();
  const outer = ctx.scopes;
  ctx.scopes = [];
  let result;
  let thrown = null;
  try {
    result = await fn();
  } catch (e) {
    thrown = { e };
  }
  const scopes = ctx.scopes;
  ctx.scopes = outer;
  const failure = removeLeftoverProcesses(ctx, label, scopes);
  if (failure) await finish(ctx, 'escalated', `process cleanup after ${label} failed`, failure);
  if (thrown) throw thrown.e;
  if (failure) throw new ProcessCleanupError(failure, ctx.state);
  return result;
}

/**
 * Stop each of `scopes` that still has processes, and record them in one
 * `hygiene:processes` entry and one log line. A scope already gone means none
 * were left: no entry. Returns why a stop failed (the details for the
 * escalation), or null. Never throws.
 */
function removeLeftoverProcesses(ctx, label, scopes) {
  const { runner } = ctx;
  const stopped = [];
  const failed = [];
  for (const unit of scopes) {
    // `[]` is the one answer that means the scope is gone; a listing that
    // failed or is malformed still gets the stop, and its verification.
    let procs;
    try {
      procs = runner.scopeProcesses(unit);
      if (!Array.isArray(procs)) throw new Error(`malformed listing: ${JSON.stringify(procs)}`);
    } catch (e) {
      procs = [{ pid: '?', command: `(could not list: ${describeThrown(e)})` }];
    }
    if (procs.length === 0) continue;
    const named = procs.map((p) => `${p?.pid ?? '?'} ${p?.command ?? '?'}`);
    let r;
    try {
      r = runner.stopScope(unit);
    } catch (e) {
      r = { ok: false, output: describeThrown(e) };
    }
    if (r?.ok === true) stopped.push(...named);
    else failed.push({ unit, named, why: typeof r?.output === 'string' && r.output ? r.output : 'the stop failed' });
  }
  if (stopped.length === 0 && failed.length === 0) return null;
  const left = [...stopped, ...failed.flatMap((f) => f.named)];
  const count = `${left.length} process${left.length === 1 ? '' : 'es'}`;
  const note = failed.length
    ? `could not stop ${count} left by ${label}: ${left.join('; ')}`
    : `stopped ${count} left by ${label}: ${left.join('; ')}`;
  record(ctx, { step: 'hygiene:processes', ok: failed.length === 0, note });
  safeLog(runner, `  (${note})`);
  if (!failed.length) return null;
  return [
    `Processes left by ${label} may still be running. Stop them with:`,
    '',
    ...failed.flatMap((f) => [`- \`systemctl --user stop ${f.unit}.scope\` (${f.why}): ${f.named.join('; ')}`]),
  ].join('\n');
}

/**
 * Stop the scopes of this unit that a bl no longer running left behind (one
 * that crashed or was killed mid-step), at `bl run` start and `--resume`, `bl
 * review` and `bl merge`'s integration; recorded as a step's are. Throws
 * ProcessCleanupError after escalating when a stop fails, or when the scopes
 * cannot be listed: they may be running and would collide with the next step.
 */
async function reapStaleScopes(ctx) {
  if (!processHygiene(ctx)) return;
  const label = 'an earlier bl that is no longer running';
  let stale;
  let failure = null;
  try {
    stale = ctx.runner.staleScopes(ctx.feature.id);
    if (!Array.isArray(stale)) throw new Error(`malformed listing: ${JSON.stringify(stale)}`);
  } catch (e) {
    const why = describeThrown(e);
    const pattern = `${processScope.scopeUnitName(ctx.feature.id, '*', '*')}.scope`;
    failure = [
      `Could not list the process scopes earlier bl runs of ${ctx.feature.id} may have left (${why}).`,
      `List them with \`systemctl --user list-units '${pattern}'\` and stop each with \`systemctl --user stop <unit>\`.`,
    ].join('\n');
    record(ctx, { step: 'hygiene:processes', ok: false, note: `could not list scopes left by ${label}: ${why}` });
    safeLog(ctx.runner, `  (could not list earlier bl runs' process scopes: ${why})`);
  }
  if (!failure) {
    if (stale.length === 0) return;
    failure = removeLeftoverProcesses(ctx, label, stale);
  }
  if (!failure) return;
  await finish(ctx, 'escalated', `process cleanup after ${label} failed`, failure);
  throw new ProcessCleanupError(failure, ctx.state);
}

/**
 * Run the shell command `cmd`: through `runCommandLine` (`src/child.js`),
 * which raises the SIGINT or SIGTERM that ends it, or its exit 130 or 143
 * (F-114 D2); with `scope`, as `sh -c <cmd>` inside that user systemd scope
 * (F-70 D4). stdin is 'ignore'; `stdout` and `stderr` are the other two
 * streams.
 */
function spawnShell(cmd, scope, { stdout, stderr, ...options }) {
  const stdio = ['ignore', stdout, stderr];
  if (!scope) return runCommandLine(cmd, { ...options, stdio });
  // Through the scope's files, so a leftover holding stdout cannot hang it.
  return processScope.scopedSpawn(scope)('sh', ['-c', cmd], { ...options, stdio });
}

/**
 * Run `cmd` with stdout and stderr on one file descriptor, so the output
 * keeps the order the command printed it: a pipe per stream would put every
 * stderr line after all of stdout, and a runner's error would land below its
 * teardown noise in the gate log. Returns the runner's `{ status, output }`.
 * A command ended by a signal that does not stop `bl` has `status` 128 + the
 * signal's number (`exitStatus`).
 */
export function shellMerged(cmd, cwd, { scope = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bl-gate-'));
  const file = join(dir, 'output');
  let fd = null;
  try {
    fd = openSync(file, 'a');
    const r = spawnShell(cmd, scope, { cwd, env: { CI: 'true', ...process.env }, stdout: fd, stderr: fd });
    closeSync(fd);
    fd = null;
    const output = readFileSync(file, 'utf8');
    return {
      status: exitStatus(r),
      output: r.error ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}${r.error.message}\n` : output,
    };
  } finally {
    if (fd != null) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether the reason of an `unrelated` fix-tests outcome describes a flaky
 * failure: flaky, intermittent, a timeout, or "not caused by" this branch.
 * Those are bugs to fix, not reasons to stop (F-22 escalated a page-load
 * timeout that had failed 2 of its 4 gate runs), so the loop sends the session
 * back once.
 */
export function looksFlaky(reason) {
  return /flak|intermittent|time[sd]?[ -]?out|not caused by/i.test(String(reason ?? ''));
}

/** The note a fix-tests session gets when its flaky `unrelated` outcome is refused. */
export function flakyPushbackNote(reason) {
  return [
    '',
    '## Your previous session was sent back',
    '',
    `A fix-tests session on this failure returned \`unrelated\` with the reason "${reason}". A flaky,`,
    'intermittent or timing failure, or one this branch did not cause, is a bug to fix, not a reason to',
    'stop. Find its cause and fix it in its own commit with an ad-hoc story (rule 4 and **Blocked by a',
    'bug**), or return `rerun` with what you tried if it truly will not reproduce. A second `unrelated`',
    'escalates.',
    '',
  ].join('\n');
}

/** The note a fix-tests session gets when the gate failed again after a `rerun` outcome. */
export function rerunFailedNote(reason) {
  return [
    '',
    '## The failure reproduced',
    '',
    `The previous fix-tests session returned \`rerun\` with the reason "${reason}", and the gate was`,
    'rerun and failed again (the excerpt below is from that run). It reproduces: find its cause and fix',
    'it. `rerun` is not available again for this failure.',
    '',
  ].join('\n');
}

/**
 * Create and return `<backlog>/.bl/run/<F-id>.<slot>.scratch`: where a
 * session writes its diagnostics (probe scripts, redirected output, scratch
 * configs). A headless agent cannot delete files, and the test gate refuses a
 * dirty worktree, so anything it makes to diagnose must never land there.
 */
function scratchFor(ctx, slot) {
  ensureRunDir(ctx.config);
  const dir = join(ctx.config.backlogRoot, RUN_DIR, `${ctx.feature.id}.${slot}.scratch`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The key a session records its tokens under; in tokens.js so `bl implement`
// (workon.js, which this module imports) can share it without a cycle.
export { tokensStepKey };

/**
 * The unit directory every agent session of the run starts in (F-60 D3), its
 * write root and the home of its session lock. Every prep sets it; one that
 * does not (a test's) runs in its lead worktree, as before.
 */
export function prepUnitDir(prep) {
  return prep.unitDir ?? prep.worktreePath;
}

/**
 * The `backlog.json` key of a role's configuration list: `roleConfigurations`'
 * refusal and the escalations of a failed step (S-1140) name it.
 */
function roleKey(role) {
  return role === 'review' ? 'review_agent' : 'agent';
}

/**
 * A role's configurations in priority order (F-64 D2): the review list for
 * the review passes and the verifier, the implementing list for every other
 * step. An interactive run attaches the operator to the role's first entry
 * and does not walk (F-64 Out of Scope): the operator at the keyboard does.
 */
function roleConfigurations(ctx, role) {
  const cfg = ctx.prep.cfg ?? ctx.config;
  const list = (role === 'review' ? cfg.reviewAgents : cfg.agents) ?? [];
  if (list.length === 0) throw new Error(`backlog.json "${roleKey(role)}" lists no configurations`);
  if (!ctx.runner.interactive) return list;
  // The interactive reviewer is the first one D4 does not exclude.
  const excluded = role === 'review' ? implementers(ctx) : [];
  return [list.find((c) => !excluded.some((x) => sameConfiguration(x, c))) ?? list[0]];
}

/** The steps that write the unit's code: who ran one never reviews the run (F-64 D4). */
const IMPLEMENTING_STEPS = new Set([
  'implement',
  'fix-tests',
  'self-review',
  'fix',
  'fix-self-review',
  'merge-resolve',
]);

/**
 * The configurations that ran an implementing step of this run (F-64 D4),
 * read from the run history the walk writes (`{ step, agent, model }` on
 * every agent step), each once with the steps it ran. The history survives
 * `--resume` and `bl review`, so an earlier session's implementer stays
 * excluded.
 * @returns {{ agent: string, model: string|null, steps: string[] }[]}
 */
function implementers(ctx) {
  const found = [];
  for (const h of ctx.state.history ?? []) {
    if (!IMPLEMENTING_STEPS.has(h.step) || typeof h.agent !== 'string') continue;
    let c = found.find((x) => sameConfiguration(x, h));
    if (!c) found.push((c = { agent: h.agent, model: h.model ?? null, steps: [] }));
    if (!c.steps.includes(h.step)) c.steps.push(h.step);
  }
  return found;
}

/** The distinct configurations of `list`, as the Review Log header and `bl status` name them: "codex gpt-6-sol, claude sonnet". */
export function reviewersLabel(list) {
  const distinct = [];
  for (const c of list) if (c && !distinct.some((x) => sameConfiguration(x, c))) distinct.push(c);
  return distinct.map(configurationLabel).join(', ');
}

/** Whether `agent`'s adapter can run a session without a terminal. */
function headlessAgent(agent) {
  if (!hasProvider(agent)) return false;
  const provider = getProvider(agent);
  return typeof provider.supportsHeadless === 'function' && provider.supportsHeadless();
}

/**
 * Whether a role's list has an entry `bl run` can walk to headless (F-64 D3
 * step 1): with none, `bl run` refuses at start, and `bl review` and `bl
 * merge`'s integration attach a terminal instead.
 * @param {{ agent: string }[]} list
 */
export function hasHeadlessConfiguration(list) {
  return (list ?? []).some((c) => headlessAgent(c.agent));
}

/** Whether out-list entry `o` covers configuration `c`: an account-wide one covers every model of its agent. */
function outCovers(o, c) {
  return o.agent === c.agent && (o.scope === 'account' || (o.model ?? null) === (c.model ?? null));
}

const untilMs = (o) => (o.until == null ? Infinity : new Date(o.until).getTime());

/** The out-list entry that keeps `c` out longest (no `until`: the rest of the run), or null. */
function outEntry(ctx, c) {
  let found = null;
  for (const o of ctx.state.unavailable ?? []) {
    if (outCovers(o, c) && (found == null || untilMs(o) > untilMs(found))) found = o;
  }
  return found;
}

/**
 * Drop the out-list entries whose `until` has passed, with a log line each:
 * those configurations are tried again, so the run returns to the operator's
 * first choice as soon as it can (F-64 D3).
 */
function pruneOutList(ctx, now) {
  const list = ctx.state.unavailable ?? [];
  const kept = list.filter((o) => untilMs(o) > now);
  for (const o of list.filter((x) => !kept.includes(x))) {
    const who = o.scope === 'account' ? `every ${o.agent} configuration` : configurationLabel(o);
    ctx.runner.log(`  (${who} is tried again: out until ${localTime(o.until)}, which has passed)`);
  }
  ctx.state.unavailable = kept;
}

/**
 * Clear the out-list entries with no `until` when the operator starts the
 * run again (`bl run --resume`, `bl review`, `bl merge`'s integration), with
 * a log line each. Such an entry (a capacity refusal, a spend cap) is out
 * for the rest of the run that hit it; that run escalated, asking the
 * operator to raise the limit and resume, so the resume tries it again. An
 * entry with a time still holds until it (F-64 D3).
 */
function clearUntimedOut(ctx) {
  const list = ctx.state.unavailable ?? [];
  for (const o of list.filter((x) => x.until == null)) {
    const who = o.scope === 'account' ? `every ${o.agent} configuration` : configurationLabel(o);
    ctx.runner.log(`  (${who} is tried again: out with no reset time, and the run was started again)`);
  }
  ctx.state.unavailable = list.filter((o) => o.until != null);
}

/**
 * Put configuration `c` on the run's out-list (F-64 D3) and save it, so
 * neither this run nor its `--resume` spawns it again before `until` (null:
 * the rest of the run). `scope: account` takes every configuration of the
 * agent out. The `unavailable` history event and its log line name the move.
 */
function markOut(ctx, { step, configuration: c, kind, scope, message, until }) {
  const entry = {
    agent: c.agent,
    model: c.model ?? null,
    scope: scope === 'account' ? 'account' : 'model',
    kind: String(kind ?? 'other'),
    // The margin added to a reset at the end of Date's range stays a time.
    until: until == null ? null : new Date(Math.min(until, 8.64e15)).toISOString(),
    message: String(message ?? ''),
  };
  const same = (o) =>
    o.agent === entry.agent &&
    o.scope === entry.scope &&
    (entry.scope === 'account' || (o.model ?? null) === entry.model);
  ctx.state.unavailable = [...(ctx.state.unavailable ?? []).filter((o) => !same(o)), entry];
  const who = entry.scope === 'account' ? `every ${entry.agent} configuration` : configurationLabel(entry);
  const when = entry.until == null ? 'for the rest of the run' : `until ${localTime(entry.until)}`;
  const note = `${step}: ${configurationLabel(entry)} is unavailable (${entry.kind}): ${entry.message} — ${who} out ${when}`;
  record(ctx, {
    step: 'unavailable',
    ok: true,
    session: step,
    agent: entry.agent,
    model: entry.model,
    kind: entry.kind,
    scope: entry.scope,
    until: entry.until,
    message: entry.message,
    note,
  });
  ctx.runner.log(`  ${note}`);
}

/**
 * Record the session a step is about to spawn as the run state's `session`
 * (S-1272), and save the state before the spawn, so `bl watch` follows it
 * while it runs: `{ step, story, agent, model, id, path, startedAt }`.
 * `path` and `id` are the adapter's follow handle (`followHandle()`): the
 * file the session's events go to and the session id, when known. Both are
 * null for an interactive session (the operator's terminal shows it) and for
 * an adapter that cannot follow one. Returns the handle, for the spawn, or
 * null. A Codex session's events go to
 * `.bl/run/<id>.<n>.<step>.events.jsonl`, `n` the history's length, so each
 * spawn of the run has a file of its own.
 */
function recordSession(ctx, { step, story, configuration: c, startedAt, cwd, sessionId }) {
  const eventsPath = join(
    ctx.config.backlogRoot,
    RUN_DIR,
    `${ctx.feature.id}.${ctx.state.history.length}.${step.replace(/[^A-Za-z0-9-]/g, '-')}.events.jsonl`,
  );
  const handle =
    ctx.runner.interactive || !hasProvider(c.agent)
      ? null
      : getProvider(c.agent).followHandle({ cwd, eventsPath, sessionId });
  ctx.state.session = {
    step,
    story: story ?? null,
    agent: c.agent,
    model: c.model ?? null,
    id: handle?.id ?? null,
    path: handle?.path ?? null,
    startedAt,
  };
  saveRunState(ctx.config, ctx.state);
  return handle;
}

/**
 * The adapter's capacity reading for `c` (F-64 D1), through the runner. An
 * `account`-scoped answer is the agent's for every model, so `asked` keeps
 * it and the agent is asked once per walk. A runner without `capacity`, or
 * one that throws or answers nothing usable, reads `unknown`: a broken read
 * costs at most a refused spawn. An `unavailable` reading whose reset has
 * passed also reads `unknown`. `topLevel` is the run config's
 * `backlog.json` top level, which an adapter may read its settings from
 * (`local`).
 */
function readCapacity(runner, c, asked, topLevel) {
  if (asked.has(c.agent)) return asked.get(c.agent);
  let reading = null;
  try {
    reading = typeof runner.capacity === 'function' ? runner.capacity(c.agent, c.model ?? null, topLevel) : null;
  } catch (e) {
    reading = { state: 'unknown', scope: 'model', until: null, message: describeThrown(e) };
  }
  if (reading == null || typeof reading !== 'object')
    reading = { state: 'unknown', scope: 'model', until: null, message: '' };
  // An `until` that is not a time would read as "out for the rest of the run".
  if (reading.until != null && !Number.isFinite(new Date(reading.until).getTime())) {
    reading = {
      ...reading,
      state: 'unknown',
      until: null,
      message: `${reading.message ?? ''} (its reset is not a time)`.trim(),
    };
  }
  // A reset that has passed says nothing about now: the local clock may run
  // ahead of the agent's, or the reading may lag a reset. The spawn finds out,
  // and a refusal puts the configuration on the out-list (S-1444).
  if (reading.state === 'unavailable' && untilMs(reading) <= runnerNow(runner).getTime()) {
    reading = {
      ...reading,
      state: 'unknown',
      until: null,
      message: `${reading.message ?? ''} (its reset, ${localTime(reading.until)}, has passed)`.trim(),
    };
  }
  if (reading.scope === 'account') asked.set(c.agent, reading);
  return reading;
}

/**
 * One headless step of the loop, walked down its role's list (F-64 D3):
 * implement, fix-tests, self-review, the fix steps and the merge resolution
 * walk `agents`; the review dimension passes and the verifier (`role:
 * "review"`) walk `reviewAgents`.
 *
 * Each configuration, from the top: skipped while the out-list has it, or
 * when its adapter has no headless mode; then its capacity is read, and an
 * `unavailable` reading puts it on the out-list, unless its `until` has
 * passed (S-1444); then it is spawned, and a
 * refusal puts it on the out-list. The review role also skips every
 * configuration that ran an implementing step of this run (F-64 D4): the
 * reviewer is never the implementer. A refused or skipped configuration is not
 * an attempt, so callers only ever see a session that ran: a refusal never
 * spends a nudge retry, a fix-tests rerun or a review round. Only a session
 * that ended in error is a refusal (every capture so far was one): a session
 * that succeeded and merely quoted the message in its last line ran, and
 * its result stands. With the list exhausted, `waitOrEscalate` sleeps until
 * the earliest reset and the walk starts again, or escalates.
 *
 * `vars` may be a function of the configuration about to spawn (the
 * verifier names itself among the reviewers). The result carries
 * `configuration`, the `{ agent, model }` that ran it.
 *
 * With `schema` (F-68 D1, D5), the step's outcome is the result's
 * `structured`, and its history entry says `outcome: <summary>`. A session
 * that returns `structured: null` is recorded as a failed event with its
 * `structuredError`, and the same session is resumed once with
 * `OUTCOME_RETRY_NOTE` (a session with no id to resume starts again with the
 * note after its prompt). A second failure escalates with the text's last 20
 * lines and throws an OutcomeError. Nothing reads an outcome from the text.
 */
export async function runSession(
  ctx,
  { step, mode, role = 'implement', story = null, promptName, vars, label, schema = null },
) {
  const { runner, prep, config, feature } = ctx;
  const unitDir = prepUnitDir(prep);
  // Picked once, before the walk, so every configuration it walks to runs at
  // the same level (F-85 D4): a story's own step at that story's level, a
  // unit-level step at the highest of the unit's stories. Each level is read
  // from the story's file now: an earlier session may have changed it.
  const effort = sessionEffort(prep.cfg ?? config, {
    mode: role,
    stories: (prep.ordered ?? [])
      .filter((s) => story == null || s.id === story)
      .map((s) => withCurrentEffort(config.backlogRoot, s)),
  });
  // One spawn of configuration `c`, recorded in the history; null when it was
  // a refusal, which puts `c` on the out-list instead. `retry` is the outcome
  // retry's `{ sessionId, note }` (F-68 D5).
  const spawnRecorded = async (c, retry) => {
    const started = new Date().toISOString();
    const follow = recordSession(ctx, {
      step,
      story,
      configuration: c,
      startedAt: started,
      cwd: unitDir ?? prep.worktreePath,
      sessionId: retry?.sessionId ?? null,
    });
    const r = await runner.session({
      mode,
      agent: c.agent,
      promptName,
      vars: {
        ...prep.baseVars,
        unitDir,
        changeAbsPath: changeFile(ctx),
        changeRelPath: changeRelPath(ctx),
        ...(typeof vars === 'function' ? vars(c) : vars),
      },
      worktreePath: prep.worktreePath,
      unitDir,
      config: prep.cfg ?? config,
      parsed: prep.parsed,
      label,
      usageIndexPath: feature.indexPath,
      tokensStep: tokensStepKey(step, ctx.state.round),
      model: c.model ?? null,
      effort,
      scope: newScope(ctx),
      ...(schema ? { schema } : {}),
      ...(retry ? { retry } : {}),
      ...(follow ? { follow } : {}),
    });
    // A session `bl stop` ended is no attempt: the loop stops before it reads it.
    checkStop(ctx);
    // Usage first, on every spawn: the provider has already added it to the
    // unit file, and the run state must agree even when the spawn was a
    // refusal (marked out, waited out or escalated, all of which save it).
    if (r?.usage) {
      for (const k of Object.keys(ctx.state.usage)) ctx.state.usage[k] += r.usage[k] ?? 0;
    }
    if (r?.refusal && r.isError) {
      const reset = r.refusal.resetsAt == null ? NaN : new Date(r.refusal.resetsAt).getTime();
      markOut(ctx, {
        step,
        configuration: c,
        kind: r.refusal.kind,
        scope: r.refusal.scope,
        message: r.refusal.message,
        until: Number.isFinite(reset) ? reset + LIMIT_WAIT_MARGIN_MS : null,
      });
      return null;
    }
    // A denied tool does not fail the session (the agent sees a tool error and
    // carries on), but the operator must see it in `bl status`.
    const denials = Array.isArray(r.denials) ? r.denials : [];
    // A step with a schema says what its outcome was, or why it has none
    // (F-68 D1, D4); `outcome` keeps the summary for `bl status`. A step
    // without one (a review dimension pass) says nothing: its text is no verdict.
    const noOutcome = Boolean(schema) && r.structured == null;
    const outcome = schema && !noOutcome ? String(r.structured.summary).slice(0, 160) : null;
    const notes = [
      r.error ?? (r.isError ? 'agent reported an error' : ''),
      denials.length ? `denied: ${denials.join('; ')}` : '',
      noOutcome ? `outcome error: ${outcomeFault(r)}` : outcome != null ? `outcome: ${outcome}` : '',
    ];
    record(ctx, {
      step,
      ...(story ? { story } : {}),
      promptName,
      startedAt: started,
      agent: c.agent,
      model: c.model ?? null,
      effort,
      ok: r.ok && denials.length === 0 && !noOutcome,
      ...(outcome != null ? { outcome } : {}),
      note: notes.filter(Boolean).join(' — '),
      // The denied tools as a list, for bl top's detail box (F-88 S-1334).
      ...(denials.length ? { denials } : {}),
      // The session's own tokens, for bl top's graph (F-87 D3b).
      ...(r.usage ? { usage: r.usage } : {}),
    });
    return { ...r, configuration: { agent: c.agent, model: c.model ?? null } };
  };
  // The session is recorded before its containers are cleaned, so a failed
  // cleanup cannot hide what the session did. A headless session runs in a
  // user systemd scope stopped afterwards (F-70 D4); an interactive one is
  // the operator's.
  const scoped = async (fn) => (runner.interactive ? fn() : withProcessCleanup(ctx, step, fn));
  return withContainerCleanup(ctx, step, async () =>
    scoped(async () => {
      const list = roleConfigurations(ctx, role);
      const excluded = role === 'review' ? implementers(ctx) : [];
      let waitedUntil = null;
      for (;;) {
        pruneOutList(ctx, runnerNow(runner).getTime());
        // A fresh walk after a wait asks again: the reading before it is stale.
        const asked = new Map();
        for (const c of list) {
          const name = configurationLabel(c);
          const implemented = excluded.find((x) => sameConfiguration(x, c));
          if (implemented) {
            runner.log(
              `  ${step}: skipping ${name}: it ran ${implemented.steps.join(', ')} in this run, and the reviewer is never the implementer`,
            );
            continue;
          }
          if (!runner.interactive) {
            const out = outEntry(ctx, c);
            const skip = out
              ? `out ${out.until == null ? 'for the rest of the run' : `until ${localTime(out.until)}`} (${out.kind}: ${out.message})`
              : !headlessAgent(c.agent)
                ? 'its agent has no headless mode'
                : null;
            if (skip) {
              runner.log(`  ${step}: skipping ${name}: ${skip}`);
              continue;
            }
            const reading = readCapacity(runner, c, asked, config.topLevel);
            if (reading.state === 'unavailable') {
              const until = reading.until == null ? NaN : new Date(reading.until).getTime();
              markOut(ctx, {
                step,
                configuration: c,
                kind: 'quota',
                scope: reading.scope,
                message: reading.message,
                until: Number.isFinite(until) ? until + LIMIT_WAIT_MARGIN_MS : null,
              });
              continue;
            }
          }
          let r = await spawnRecorded(c, null);
          if (!r) continue;
          // No valid outcome: the same session once more with the note (F-68 D5).
          if (schema && r.structured == null) {
            runner.log(`  ${step}: no valid outcome (${outcomeFault(r)}); resuming the session once`);
            r = await spawnRecorded(c, { sessionId: r.sessionId ?? null, note: OUTCOME_RETRY_NOTE });
            if (!r) continue;
            if (r.structured == null) await escalateNoOutcome(ctx, step, r);
          }
          return r;
        }
        waitedUntil = await waitOrEscalate(ctx, { step, story, role, list, excluded, waitedUntil });
      }
    }),
  );
}

/** The one-line note a resumed session gets when its final message was no valid outcome (F-68 D5). */
export const OUTCOME_RETRY_NOTE =
  'Your final message must be the JSON object the schema describes; nothing else was read.';

/** Why a session has no outcome: its `structuredError`, else its error, else `no output`. */
function outcomeFault(r) {
  return r.structuredError ?? r.error ?? 'no output';
}

/**
 * A step's session returned no valid outcome twice (F-68 D5): escalate with
 * the fault, the last 20 lines of the session's text and, when the agent CLI
 * wrote any, the last 20 non-empty lines of its stderr (`stderrTail`, S-1398),
 * and throw an OutcomeError. The text is evidence for the operator, never a
 * verdict.
 */
async function escalateNoOutcome(ctx, step, r) {
  const reason = `${step}: no valid outcome after one retry (${outcomeFault(r)})`;
  const tail = String(r.output ?? '')
    .trimEnd()
    .split('\n')
    .slice(-20)
    .map(cleanStderrLine)
    .join('\n');
  const resume = resumeCommand(ctx);
  const details = [
    `The ${step} session's final message was not the JSON object its schema describes, and the resumed session's was not either. The loop reads no outcome from text, so it stops.`,
    '',
    `Fault: ${outcomeFault(r)}`,
    '',
    tail ? 'The last 20 lines of the session text:' : 'The session left no text.',
    ...(tail ? ['', fenced(tail)] : []),
    ...(r.stderrTail ? ['', "The last 20 non-empty lines of the CLI's stderr:", '', fenced(r.stderrTail)] : []),
    '',
    `Find why the agent did not return the outcome, then run \`${resume}\`.`,
  ].join('\n');
  await finish(ctx, 'escalated', reason, details);
  throw new OutcomeError(reason, ctx.state);
}

// Added to the reset time the agent named: the limit lifts on the minute, and
// a clock a little behind the agent's would otherwise hit it again.
const LIMIT_WAIT_MARGIN_MS = 60_000;

function runnerNow(runner) {
  return typeof runner.now === 'function' ? runner.now() : new Date();
}

/** The command that starts the run again after an escalation. */
function resumeCommand(ctx) {
  return ctx.resumeHint ?? `bl run ${ctx.feature.id} --resume`;
}

/** The adapter's `{ checkCommand, billingUrl }` through the runner; null on a runner without it. */
function remediationOf(runner, agent) {
  return typeof runner.remediation === 'function' ? runner.remediation(agent) : null;
}

/**
 * The step bl was running, in the operator's words (S-1140): `implement S-n`,
 * `fix round N`, `review round N failure-paths`, `merge resolution`. The
 * round is the run state's, which setStep keeps.
 */
function stepLabel(ctx, step, story = null) {
  const round = ctx.state.round;
  if (step === 'implement') return story ? `implement ${story}` : 'implement';
  if (step === 'fix') return `fix round ${round}`;
  if (step === 'fix-self-review') return `fix self-review round ${round}`;
  if (step === 'merge-resolve') return 'merge resolution';
  if (step === 'review:verify') return `review round ${round} verifier`;
  if (step.startsWith('review:')) return `review round ${round} ${step.slice('review:'.length)}`;
  return step;
}

/**
 * A session that ran and failed with no refusal bl recognised (S-1140), as
 * `describeFailure` renders it: the step, its configuration, the time, the
 * raw error (`sessionError`), the cause `unknown` and its steps. No capacity
 * is read: `bl capacity` does that when the operator runs it. Null for a
 * result with no configuration (no session ran). `ctx.failsWithoutEscalation`
 * (`bl review`, whose round abort writes no `## Escalation`) leaves out the
 * step that clears it.
 */
function sessionFailure(ctx, step, r) {
  if (!r?.configuration) return null;
  const { agent, model } = r.configuration;
  return describeFailure({
    step: stepLabel(ctx, step),
    failedAt: runnerNow(ctx.runner),
    roleKey: roleKey(step.startsWith('review:') ? 'review' : 'implement'),
    resumeHint: resumeCommand(ctx),
    configurations: [{ agent, model, out: null, reading: null, remediation: remediationOf(ctx.runner, agent) }],
    error: sessionError(r),
    escalates: !ctx.failsWithoutEscalation,
  });
}

/**
 * Every configuration of `step`'s role is out (F-64 D3 step 4). Either sleep
 * until the earliest `until` on the out-list and return it (the caller walks
 * the list again), or escalate as "agent unavailable" and throw an
 * AgentUnavailableError that unwinds to runFeature / reviewFeature. It
 * escalates when no refusal names a reset time (a pure spend cap, a
 * capacity refusal), when the earliest lies further away than
 * `run.limit_wait_max_hours`, and when this step already waited once: a
 * misread or inapplicable reset time costs at most one wait per step
 * invocation, never a loop. The details are `describeFailure`'s (S-1140):
 * the step and the time, every configuration with its reason, scope and reset
 * time in local time and a capacity reading taken now, each one `excluded`
 * (F-64 D4: it implemented this run) with the steps it ran, the cause line
 * and the ordered steps. The reason ends with the cause line.
 */
async function waitOrEscalate(ctx, { step, story = null, role, list, excluded = [], waitedUntil }) {
  const { runner, prep, config } = ctx;
  const cfg = prep.cfg ?? config;
  const capHours = cfg.limitWaitMaxHours ?? 8;
  const now = runnerNow(runner).getTime();
  const rows = list.map((c) => ({
    c,
    out: outEntry(ctx, c),
    headless: Boolean(runner.interactive) || headlessAgent(c.agent),
    implemented: excluded.find((x) => sameConfiguration(x, c)) ?? null,
  }));
  // The configuration back soonest: only an out-list entry with a time comes
  // back, and never one that implemented.
  let next = null;
  for (const row of rows) {
    if (
      row.headless &&
      !row.implemented &&
      row.out?.until != null &&
      (next == null || untilMs(row.out) < untilMs(next.out))
    )
      next = row;
  }
  const roleName = role === 'review' ? 'review' : 'implementing';
  let why = null;
  if (rows.every((row) => row.implemented || !row.headless) && rows.some((row) => row.implemented))
    why = `every ${roleName} configuration that can run ran an implementing step of this run, and the reviewer is never the implementer`;
  else if (waitedUntil != null) why = `every configuration was out again after waiting until ${localTime(waitedUntil)}`;
  else if (next == null) why = 'no refusal names a reset time';
  else if (untilMs(next.out) - now > capHours * 3_600_000)
    why = `the earliest reset, ${localTime(next.out.until)}, is past the limit_wait_max_hours cap of ${capHours}`;
  if (why) {
    const only = list.length === 1 && !rows[0].implemented ? rows[0].out : null;
    const unavailable = only
      ? `agent unavailable: ${only.message}`
      : `agent unavailable: every ${roleName} configuration is out (${list.map(configurationLabel).join(', ')})`;
    // A fresh reading of each refused configuration; an account-wide one is asked once.
    const asked = new Map();
    const failure = describeFailure({
      step: stepLabel(ctx, step, story),
      failedAt: now,
      roleKey: roleKey(role),
      resumeHint: resumeCommand(ctx),
      configurations: rows.map(({ c, out, headless, implemented }) => ({
        agent: c.agent,
        model: c.model ?? null,
        out,
        reading: out && headless && !implemented ? readCapacity(runner, c, asked, config.topLevel) : null,
        remediation: remediationOf(runner, c.agent),
        excluded: implemented?.steps ?? null,
        headless,
      })),
    });
    const reason = `${unavailable} — ${failure.causeLine}`;
    const details = `The ${step} session found every ${roleName} configuration out: ${why}.\n\n${failure.text}`;
    await finish(ctx, 'escalated', reason, details);
    throw new AgentUnavailableError(reason, ctx.state);
  }
  const until = untilMs(next.out);
  const note = `${step}: ${next.out.kind} limit — ${next.out.message} — waiting until ${localTime(until)}`;
  // Saved before the first slice: a Ctrl-C during the wait leaves the run
  // resumable at this step, and `bl status` shows what it is waiting for.
  record(ctx, {
    step: 'waiting',
    ok: true,
    session: step,
    agent: next.c.agent,
    model: next.c.model ?? null,
    kind: next.out.kind,
    message: next.out.message,
    until: new Date(until).toISOString(),
    note,
  });
  runner.log(`  (${note})`);
  // Slices of at most a second, re-reading the clock each time: a machine
  // suspended through the deadline sees that it has passed instead of
  // sleeping the whole stretch again. The wait awaits a timer, so Ctrl-C ends it.
  // A wait has no scope for `bl stop` to stop, so each slice checks its stop
  // request: the run stops within a second, not after a session past the wait.
  const sleep = typeof runner.sleep === 'function' ? async (ms) => runner.sleep(ms) : delay;
  for (;;) {
    checkStop(ctx);
    const t = runnerNow(runner).getTime();
    if (t >= until) break;
    await sleep(Math.min(1000, until - t));
  }
  return until;
}

// ---------------------------------------------------------------------------
// Worktree hygiene
// ---------------------------------------------------------------------------

// bl's own bookkeeping in every worktree. Several repos do not gitignore it,
// so it is excluded explicitly rather than trusted to be ignored.
const BOOKKEEPING = ['.bl'];
const BOOKKEEPING_EXCLUDES = BOOKKEEPING.map((p) => `':(exclude)${p}'`).join(' ');
const BOOKKEEPING_PATHS = BOOKKEEPING.map((p) => `'${p}'`).join(' ');

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * `git status --porcelain=v1 -z` entries as `[{ code, path }]`. Names are
 * verbatim (no C-quoting); a rename or copy yields its source path as a
 * second entry with the same code. Anything that is not a status record (a
 * warning git printed on stderr, which the runner appends) is skipped.
 */
export function parseStatusZ(output) {
  const parts = String(output ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4 || !/^[ MTADRCU?!]{2} /.test(p)) continue;
    const code = p.slice(0, 2);
    entries.push({ code, path: p.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') {
      const from = parts[++i];
      if (from) entries.push({ code, path: from });
    }
  }
  return entries;
}

/**
 * Uncommitted and untracked paths in a worktree (the feature worktree by
 * default), bl bookkeeping excluded. `[{ code, path }]`, empty when clean;
 * `null` when git cannot answer — which callers treat as dirty, never clean.
 */
export function worktreeChanges(ctx, wt = ctx.prep.worktreePath) {
  const r = ctx.runner.shell(`git status --porcelain=v1 -z --untracked-files=all -- . ${BOOKKEEPING_EXCLUDES}`, wt);
  if (r.status !== 0) return null;
  return parseStatusZ(r.output);
}

/** What is on disk at a path: bytes, a link target, a directory, or nothing. */
function diskState(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { kind: 'link', data: readlinkSync(abs) };
  if (st.isDirectory()) return { kind: 'dir' };
  return { kind: 'file', data: readFileSync(abs), mode: st.mode & 0o777 };
}

function sameDisk(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'file') return a.mode === b.mode && a.data.equals(b.data);
  return a.data === b.data;
}

function restoreDisk(abs, s) {
  rmSync(abs, { recursive: s?.kind !== 'dir', force: true });
  if (s == null || s.kind === 'dir') return;
  mkdirSync(dirname(abs), { recursive: true });
  if (s.kind === 'link') return symlinkSync(s.data, abs);
  writeFileSync(abs, s.data);
  chmodSync(abs, s.mode);
}

/**
 * Everything a session could change in a worktree without touching the
 * branch's history: HEAD, and for every changed path its status code, what is
 * on disk, and its index entry (`<mode>,<sha>`, or null when not in the
 * index), plus the index entries of bl's bookkeeping. `null` when git cannot
 * answer.
 */
export function worktreeSnapshot(ctx, wt) {
  const head = ctx.runner.shell('git rev-parse HEAD', wt);
  if (head.status !== 0) return null;
  const changes = worktreeChanges(ctx, wt);
  if (changes == null) return null;
  const book = ctx.runner.shell(`git ls-files -s -z -- ${BOOKKEEPING_PATHS}`, wt);
  if (book.status !== 0) return null;
  const index = new Map();
  const indexed = changes.filter((c) => c.code !== '??').map((c) => c.path);
  if (indexed.length > 0) {
    const r = ctx.runner.shell(`git --literal-pathspecs ls-files -s -z -- ${indexed.map(shq).join(' ')}`, wt);
    if (r.status !== 0) return null;
    for (const line of String(r.output ?? '').split('\0')) {
      const m = line.match(/^(\d+) ([0-9a-f]+) 0\t(.*)$/s);
      if (m) index.set(m[3], `${m[1]},${m[2]}`);
    }
  }
  const paths = new Map();
  for (const c of changes) {
    if (!paths.has(c.path))
      paths.set(c.path, { code: c.code, disk: diskState(join(wt, c.path)), index: index.get(c.path) ?? null });
  }
  return { head: head.output.trim(), paths, bookkeeping: String(book.output ?? '') };
}

/** Paths whose status, disk content, or index entry differ between two snapshots. */
function snapshotDiff(before, after) {
  const out = [];
  for (const p of new Set([...before.paths.keys(), ...after.paths.keys()])) {
    const b = before.paths.get(p);
    const a = after.paths.get(p);
    if (!b || !a || b.code !== a.code || !sameDisk(b.disk, a.disk) || (b.code !== '??' && b.index !== a.index))
      out.push(p);
  }
  return out;
}

/** Snapshots of every worktree a review pass can reach, or `{ error }`. */
function snapshotWorktrees(ctx) {
  const snaps = new Map();
  for (const wt of reviewWorktrees(ctx)) {
    const s = worktreeSnapshot(ctx, wt);
    if (s == null) return { error: `git could not report the state of ${wt}` };
    snaps.set(wt, s);
  }
  return { snaps };
}

function reviewWorktrees(ctx) {
  return [ctx.prep.worktreePath, ...reviewOtherRepos(ctx).map((r) => r.worktreePath)];
}

/**
 * The other repos a review round covers, `{ repoName, worktreePath, pr }`
 * (`pr` null when the repo has none): every other repo the run publishes
 * (`publishTargets`, so a repo with no PR, as when its forge is off, is still
 * reviewed and snapshotted), then each PR'd repo `bl review` passed in
 * `prep.otherRepos` that the run did not prepare.
 */
function reviewOtherRepos(ctx) {
  const prs = ctx.prep.otherRepos ?? [];
  const out = publishTargets(ctx)
    .slice(1)
    .map((t) => ({
      repoName: t.repo,
      worktreePath: t.worktreePath,
      pr: prs.find((r) => r.repoName === t.repo)?.pr ?? null,
    }));
  for (const r of prs) if (!out.some((o) => o.repoName === r.repoName)) out.push(r);
  return out;
}

/**
 * Take the session lock of every unit directory a review round reaches (one
 * per unit, whichever repos it holds, F-60 D3; `sessionLockPath`), so no
 * other bl session starts in one while the round's snapshots are live: its
 * edits would be quarantined and reverted as the reviewer's. Each is taken
 * as a session takes its own (`takeSessionLock`); a lock this process already
 * holds is reused, one depth deeper. Returns `{ release }`, which closes what
 * the round took, or `{ error }` with nothing taken when a live session holds
 * one or a lock file cannot be opened.
 */
function holdReviewLocks(ctx) {
  const held = [];
  const releaseAll = () => {
    for (const release of held) release();
  };
  // A worktree outside the unit directory (`bl review` given one elsewhere)
  // is locked on its own.
  const unitDir = prepUnitDir(ctx.prep);
  const outside = reviewWorktrees(ctx).filter((wt) => wt !== unitDir && !wt.startsWith(`${unitDir}/`));
  for (const dir of new Set([unitDir, ...outside])) {
    const lock = takeSessionLock(ctx.config.backlogRoot, dir, `${ctx.feature.id} review round`);
    if (lock.refused) {
      releaseAll();
      return { error: lock.refused };
    }
    held.push(lock.release);
  }
  return { release: releaseAll };
}

/**
 * Review passes are read-only by contract, but an agent reproducing a finding
 * will happily drop a probe script into the worktree — and the next test gate
 * then runs it (seen on F-2's first run: a reviewer's stale repro failed the
 * gate twice after the fixes landed). After every review-mode session, put
 * each worktree back exactly as the snapshot taken before the session found
 * it: what the session added goes to the run's quarantine directory, tracked
 * edits and any commits it made are saved as patches, and only paths the
 * session changed are touched — an operator's uncommitted work stays. Returns
 * `{ note }` (null when the session left nothing), or `{ error }` when a
 * worktree could not be restored.
 */
function quarantineReviewerChanges(ctx, label, before) {
  const { runner, config, feature } = ctx;
  const dir = join(
    config.backlogRoot,
    RUN_DIR,
    `${feature.id}.quarantine`,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`,
  );
  const counts = { untracked: 0, modified: 0, commits: false };
  const errors = [];
  for (const [wt, snap] of before) {
    const wtDir = before.size > 1 ? join(dir, wt.replace(/[\\/:]+/g, '_')) : dir;
    const err = restoreWorktree(ctx, wt, snap, wtDir, counts);
    if (err) errors.push(`${wt}: ${err}`);
  }
  const what = [
    counts.untracked ? `${counts.untracked} untracked file${counts.untracked === 1 ? '' : 's'}` : '',
    counts.modified ? `${counts.modified} modified file${counts.modified === 1 ? '' : 's'}` : '',
    counts.commits ? 'commits on the branch' : '',
  ]
    .filter(Boolean)
    .join(', ');
  if (!what && errors.length === 0) return { note: null };
  const note = errors.length
    ? `worktree hygiene failed after the ${label} pass — ${errors.join('; ')}`
    : `reviewer left ${what} in the worktree — quarantined to ${relative(config.backlogRoot, dir)}`;
  record(ctx, { step: `hygiene:${label}`, ok: false, note });
  runner.log(`  (${note})`);
  return errors.length ? { error: note } : { note };
}

/** One worktree back to `snap`. Returns null, or what went wrong. */
function restoreWorktree(ctx, wt, snap, dir, counts) {
  const { runner } = ctx;
  const git = (cmd) => runner.shell(cmd, wt);
  const head = git('git rev-parse HEAD');
  if (head.status !== 0) return 'git rev-parse HEAD failed';
  // Commits first: a soft reset turns them into staged changes, which the
  // path-by-path restore below then puts back.
  if (head.output.trim() !== snap.head) {
    mkdirSync(dir, { recursive: true });
    const fp = git(`git format-patch -q -o ${shq(join(dir, 'commits'))} ${snap.head}..${head.output.trim()}`);
    if (fp.status !== 0) return `git format-patch exited ${fp.status}`;
    const reset = git(`git reset -q --soft ${snap.head}`);
    if (reset.status !== 0) return `git reset --soft ${snap.head} exited ${reset.status}`;
    counts.commits = true;
  }
  const after = worktreeSnapshot(ctx, wt);
  if (after == null) return 'git status failed after the pass';
  // The round's lock sits in every worktree, so a session's `git add -A`
  // stages it. bl's files are never the session's work: unstage them, and
  // leave them on disk (the lock is held).
  if (after.bookkeeping !== snap.bookkeeping) {
    const r = git(`git reset -q -- ${BOOKKEEPING_PATHS}`);
    if (r.status !== 0) return `git reset of bl's bookkeeping exited ${r.status}`;
  }
  const changed = snapshotDiff(snap, after);
  if (changed.length === 0) return after.bookkeeping === snap.bookkeeping ? null : notRestored(ctx, wt, snap);
  mkdirSync(dir, { recursive: true });

  const lit = (paths) => paths.map(shq).join(' ');
  const indexed = (s, p) => s.paths.has(p) && s.paths.get(p).code !== '??';
  const inIndex = changed.filter((p) => indexed(after, p) || indexed(snap, p));
  const trackedAfter = changed.filter((p) => indexed(after, p));
  if (trackedAfter.length > 0) {
    const d = git(
      `git --literal-pathspecs diff HEAD --binary -- ${lit(trackedAfter)} > ${shq(join(dir, 'tracked.patch'))}`,
    );
    if (d.status !== 0) return `git diff exited ${d.status}`;
  }
  // The index: back to HEAD for every changed path, then to the snapshot's
  // entry where it had one.
  if (inIndex.length > 0) {
    const r = git(`git --literal-pathspecs reset -q -- ${lit(inIndex)}`);
    if (r.status !== 0) return `git reset exited ${r.status}`;
    for (const p of inIndex) {
      const b = snap.paths.get(p);
      if (!b || b.code === '??') continue;
      const u = b.index
        ? git(`git update-index --add --cacheinfo ${b.index},${shq(p)}`)
        : git(`git --literal-pathspecs update-index --force-remove -- ${shq(p)}`);
      if (u.status !== 0) return `git update-index ${p} exited ${u.status}`;
    }
  }
  // The files: what the snapshot had, else what HEAD has, else nothing (the
  // session's new file goes to quarantine).
  const headHas = new Set();
  const clean = changed.filter((p) => !snap.paths.has(p));
  if (clean.length > 0) {
    const t = git(`git --literal-pathspecs ls-tree -r -z --name-only HEAD -- ${lit(clean)}`);
    if (t.status !== 0) return `git ls-tree exited ${t.status}`;
    for (const p of String(t.output ?? '').split('\0')) if (p) headHas.add(p);
  }
  const checkout = [];
  for (const p of changed) {
    const abs = join(wt, p);
    const b = snap.paths.get(p);
    const a = after.paths.get(p);
    if (a?.code === '??' || (!b && !headHas.has(p))) {
      if (diskState(abs) != null) {
        const to = join(dir, 'untracked', p);
        try {
          mkdirSync(dirname(to), { recursive: true });
          renameSync(abs, to);
        } catch {
          rmSync(abs, { recursive: true, force: true });
        }
      }
      counts.untracked += 1;
    } else {
      counts.modified += 1;
    }
    if (b) restoreDisk(abs, b.disk);
    else if (headHas.has(p)) checkout.push(p);
  }
  if (checkout.length > 0) {
    const c = git(`git --literal-pathspecs checkout -- ${lit(checkout)}`);
    if (c.status !== 0) return `git checkout exited ${c.status}`;
  }
  return notRestored(ctx, wt, snap);
}

/** What still differs from `snap` after a restore: null, or the error. */
function notRestored(ctx, wt, snap) {
  const check = worktreeSnapshot(ctx, wt);
  if (check == null) return 'git status failed after the restore';
  const left = snapshotDiff(snap, check);
  if (check.bookkeeping !== snap.bookkeeping) left.push(...BOOKKEEPING);
  return left.length ? `not restored: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}` : null;
}

async function runTestGate(ctx) {
  // The gate's test commands run in user systemd scopes too (decision D4-b).
  const gate = await withContainerCleanup(ctx, 'test gate', async () =>
    withProcessCleanup(ctx, 'test gate', () => runTestGateInner(ctx)),
  );
  await recordGateLine(ctx, gate);
  return gate;
}

/**
 * Start a gate attempt: bump `testAttempts` (saved at once, so neither a
 * crash nor `--resume` reuses a number; a state file from before the counter
 * reads as 0) and return the attempt's log path,
 * `<backlog>/.bl/run/<F-id>.test-<n>.log`.
 */
function nextGateLog(ctx) {
  const prev = ctx.state.testAttempts;
  ctx.state.testAttempts = (Number.isInteger(prev) && prev > 0 ? prev : 0) + 1;
  saveRunState(ctx.config, ctx.state);
  return join(ctx.config.backlogRoot, RUN_DIR, `${ctx.feature.id}.test-${ctx.state.testAttempts}.log`);
}

/**
 * Write an attempt's complete output. Returns the path to show, or, when the
 * write failed, a note saying so: the gate's verdict does not depend on it.
 */
function writeGateLog(ctx, logPath, text) {
  try {
    writeFileSync(logPath, text.endsWith('\n') ? text : `${text}\n`);
    return logPath;
  } catch (e) {
    const note = `could not write the gate log ${logPath}: ${e.message}`;
    record(ctx, { step: 'test', ok: false, note });
    return `(not written: ${note})`;
  }
}

/**
 * A failed gate result. The excerpt comes from `output` (the failing
 * plugin's own output); `excerpt` overrides it for bl's own refusals, whose
 * text has no runner markers.
 */
function gateFailure(ctx, { command, logPath, log, output, excerpt, repo, worktreePath, perRepo }) {
  const shownPath = writeGateLog(ctx, logPath, log);
  const parts = outputParts(output, GATE_TAIL_LINES);
  return {
    ok: false,
    command,
    logPath: shownPath,
    excerpt: excerpt ?? parts.excerpt,
    tail: parts.tail,
    // The repo whose check failed and its worktree: where the fix goes.
    repo,
    worktreePath,
    perRepo,
  };
}

/**
 * The file in a fix-tests session's scratch dir where a session returning
 * `unrelated` writes its explanation for the operator, in the shape
 * `prompts/_escalation.md` describes. The outcome's reason stays short.
 */
export const ESCALATION_FILE = 'escalation.md';

/**
 * The details of a fix-tests `unrelated` escalation: the session's written
 * explanation when it left one (then its outcome's reason as a label), else
 * the reason alone; the gate's details follow either way.
 */
function unrelatedDetails(reason, explanationPath, gate) {
  let written = '';
  try {
    written = readFileSync(explanationPath, 'utf8').trim();
  } catch {
    // No file: the session left only its outcome's reason.
  }
  if (!written) return `${reason}\n\n${gateDetails(gate)}`;
  return `${written}\n\nfix-tests returned \`unrelated\`: ${reason}. The failed gate:\n\n${gateDetails(gate)}`;
}

/** A failed gate's escalation details: command, log path, excerpt, tail. */
function gateDetails(gate) {
  return [
    `Command: \`${gate.command}\``,
    ...(gate.repo ? [`Repo: ${gate.repo} (${gate.worktreePath})`] : []),
    `Full log: ${gate.logPath}`,
    ...outputSections(gate.excerpt, gate.tail, GATE_TAIL_LINES),
  ].join('\n\n');
}

/**
 * The repos the test gate covers (S-1010): the run's own repo (a feature's
 * lead), then every other repo the run prepared (`prep.otherWorktrees`), in
 * the feature's repo order (F-52 D3), each with its worktree and its own
 * config (`configForRepo`), so every repo's tests run before review rather
 * than only at its push gate after it.
 */
function gateTargets(ctx) {
  const { prep, config } = ctx;
  const out = [{ repo: prepRepo(ctx), worktreePath: prep.worktreePath, cfg: prep.cfg ?? config }];
  for (const w of prep.otherWorktrees ?? []) {
    if (!w?.repoName || out.some((t) => t.repo === w.repoName)) continue;
    out.push({ repo: w.repoName, worktreePath: w.worktreePath, cfg: configForRepo(config, w.repoName) });
  }
  return out;
}

/**
 * Files a worktree's branch changes against main, or null when git fails.
 * NUL-delimited and untrimmed, so every name is git's exact one (no quoting
 * of tabs, newlines or non-ASCII, no lost spaces).
 */
export function diffAgainstMain(ctx, worktreePath) {
  const r = ctx.runner.shell('git diff --name-only -z main...HEAD', worktreePath);
  if (r?.status !== 0) return null;
  return String(r.output ?? '')
    .split('\0')
    .filter(Boolean);
}

/**
 * Worktrees on the unit's branch in registered repos the run did not
 * prepare (`git worktree list --porcelain -z` in each main checkout: NUL
 * ends each line and an empty line ends each worktree, so a path holding a
 * newline stays whole).
 * @returns {{ repo: string, worktreePath: string }[]}
 */
export function strayWorktrees(ctx, prepared) {
  const out = [];
  for (const [repo, repoPath] of Object.entries(ctx.config.reposByName ?? {})) {
    if (prepared.has(repo)) continue;
    for (const worktreePath of branchWorktrees(ctx, repoPath)) out.push({ repo, worktreePath });
  }
  return out;
}

/**
 * The worktrees of the main checkout at `repoPath` that are on the unit's
 * branch, the main checkout itself left out; [] when git cannot list them.
 */
function branchWorktrees(ctx, repoPath) {
  if (!repoPath || !existsSync(repoPath)) return [];
  const r = ctx.runner.shell('git worktree list --porcelain -z', repoPath);
  if (r?.status !== 0) return [];
  const ref = `branch refs/heads/${ctx.prep.branchName}`;
  const out = [];
  for (const entry of String(r.output ?? '').split('\0\0')) {
    const lines = entry.split('\0');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path && path !== repoPath && lines.includes(ref)) out.push(path);
  }
  return out;
}

/**
 * `s` (a `prep.ordered` entry) with `effort:` as its file has it now (F-85
 * D4), so a level a session changed applies to the next session. When the
 * file is missing or cannot be parsed, it throws, naming the story: the run
 * stops before the session, as for a bad `effort:`, and never runs it at a
 * level the file may no longer have.
 */
function withCurrentEffort(backlogRoot, s) {
  let fm;
  try {
    fm = readFm(join(backlogRoot, s.storyRelPath));
  } catch (e) {
    throw new Error(`${s.id} "effort:" cannot be read from ${s.storyRelPath}: ${e.message}`, { cause: e });
  }
  return { ...s, effort: storyEffort(fm) };
}

/**
 * After a session, the run follows the stored `plan.yaml` (F-125 D2), which
 * the session may have changed (`_execution-inputs.md` tells it to when the
 * plan proves wrong), with `stories` the unit's stories now. A story in
 * `added` joins the stored plan (`replan`: after the stories the run has
 * taken, the others in the stored order, with a `changes` entry by `bl`), on
 * `edges`, and bl writes the plan; a missing file gets the run's plan back.
 * `prep.ordered` follows the plan, and an uncommitted `plan.yaml` is
 * committed. A stored plan that `readPlan` refuses escalates with its
 * message. Returns the final state when the run stopped, else null.
 */
async function followStoredPlan(ctx, stories, { added = [], edges = [] } = {}) {
  const { feature, config, prep } = ctx;
  const dir = dirname(feature.indexPath);
  const ids = added.map((s) => s.id).join(', ');
  const before = ctx.plan;
  try {
    const stored = readPlan(dir, feature.id);
    const plan = stored ?? runPlan(ctx);
    ctx.plan =
      added.length === 0
        ? plan
        : replan(plan, stories, edges, {
            taken: prep.ordered.filter((s) => ctx.implemented.has(s.id)).map((s) => s.id),
            why: `a session added ${ids} to ${feature.id} during the run`,
          });
    if (ctx.plan !== stored) await writePlan(config.backlogRoot, dir, ctx.plan);
  } catch (e) {
    const reason = ids
      ? `${ids} could not join the execution plan`
      : `the execution plan cannot be read after a session`;
    return finish(
      ctx,
      'escalated',
      `${reason}: ${e.message}`,
      `Correct ${planRelPath(ctx)} (\`schemas/plan.json\` gives its shape), with a \`changes\` entry that says why, or delete it to compute a new plan; then \`bl run ${feature.id} --resume\`.`,
    );
  }
  followPlan(ctx, stories);
  // Committed when the session or bl changed it and it is not committed yet.
  if (!isDeepStrictEqual(before, ctx.plan) && dirtySnapshot(config.backlogRoot)?.has(planRelPath(ctx))) {
    const message = ids ? `chore: ${feature.id} plan adds ${ids}` : `chore: ${feature.id} plan as a session changed it`;
    await commitUnitPaths(ctx, 'plan', [planRelPath(ctx)], message);
  }
  return null;
}

/**
 * Re-read the feature's stories after an agent session (F-48 D3): the
 * session may have added one (`bl side`), possibly in a repo the run did not
 * prepare. The run follows the stored plan, and a new story joins it
 * (`followStoredPlan`), so the implement loop reaches each story after its
 * prerequisites and the repo guard knows its component. A new repo's worktree
 * on the branch (`bl side` prepares it with the story) joins
 * `prep.otherWorktrees` and the change document's `repos:`, so from then on
 * the gate, the repo guard, the push, the PR step, the review and the
 * `{{otherWorktrees}}` prompt variable cover it. The lead repo and its
 * worktree never change. A new repo with no worktree on the branch
 * escalates, naming the story and the repo. A story run has one repo and
 * only follows the stored plan. Returns the final state when the run
 * stopped, else null.
 */
async function refreshRepos(ctx) {
  const { feature, config, prep } = ctx;
  if (isStory(feature)) return followStoredPlan(ctx, prep.ordered ?? []);
  const scope = refreshedStories(ctx);
  if (scope.error) {
    return finish(
      ctx,
      'escalated',
      `the feature's stories could not be re-read after a session: ${scope.error}`,
      `A session changed ${feature.id}'s stories, and the run cannot tell which stories and repos it now covers, so it stops before anything is gated, published or reviewed on a guess. Fix the story (\`bl validate\` names the problem), then \`bl run ${feature.id} --resume\`.`,
    );
  }
  const { stories } = scope;
  prep.ordered ??= [];
  prep.otherWorktrees ??= [];
  const known = new Set(prep.ordered.map((s) => s.id));
  const added = stories.filter((s) => !known.has(s.id));
  const have = new Set([prepRepo(ctx), ...prep.otherWorktrees.map((w) => w.repoName)]);
  const repos = [];
  for (const name of featureRepoOrder(stories)) {
    if (have.has(name)) continue;
    const story = stories.find((s) => s.unitRepo === name);
    const worktreePath = branchWorktrees(ctx, config.reposByName?.[name])[0];
    if (!worktreePath) {
      return finish(
        ctx,
        'escalated',
        `${story.id} is in ${name}, which has no worktree on ${prep.branchName}`,
        `A session added ${story.id} to ${feature.id} during the run, in a repo the run had not prepared, and ${name} has no worktree on the branch, so its work cannot be gated, pushed or reviewed. \`bl side\` prepares the worktree when it adds a story; a story added another way gets none. \`bl run ${feature.id} --resume\` prepares every repo of the feature's stories, ${name} included.`,
      );
    }
    repos.push({ repoName: name, worktreePath, story: story.id });
  }
  const current = new Map(stories.map((s) => [s.id, s]));
  const held = [...prep.ordered, ...added].map((s) => (ctx.implemented.has(s.id) ? s : (current.get(s.id) ?? s)));
  const stopped = await followStoredPlan(ctx, held, { added, edges: scope.edges });
  if (stopped) return stopped;
  if (added.length === 0 && repos.length === 0) return null;
  if (repos.length > 0) {
    prep.otherWorktrees.push(...repos.map(({ repoName, worktreePath }) => ({ repoName, worktreePath })));
    prep.baseVars = { ...prep.baseVars, otherWorktrees: otherWorktreesLine(prep.otherWorktrees) };
    const names = [prepRepo(ctx), ...prep.otherWorktrees.map((w) => w.repoName)];
    try {
      const res = await ensureChange(config.backlogRoot, dirname(feature.indexPath), {
        changeOf: feature.id,
        title: feature.title,
        repos: names.map((repo) => ({ repo, branch: prep.branchName })),
      });
      ctx.changePath = res.path;
      if (res.changed)
        await commitChangeFile(
          ctx,
          'repos',
          `chore: ${feature.id} run adds ${repos.map((r) => r.repoName).join(', ')}`,
        );
    } catch (e) {
      // `bl merge` merges and records the repos the change document names.
      return finish(
        ctx,
        'escalated',
        `${changeRelPath(ctx)} could not name ${repos.map((r) => r.repoName).join(', ')}: ${e.message}`,
      );
    }
  }
  const note = [
    ...repos.map((r) => `${r.repoName} (${r.story}) @ ${r.worktreePath}`),
    ...(added.length ? [`stories ${added.map((s) => s.id).join(', ')}`] : []),
  ].join('; ');
  ctx.runner.log(`  ${feature.id}: added during the run — ${note}`);
  record(ctx, { step: 'repos', ok: true, repos: repos.map((r) => r.repoName), stories: added.map((s) => s.id), note });
  return null;
}

/**
 * The prompt variables of a batch's story on `story-run.md` (F-125 D1), {}
 * for another unit. The story works as a story run does: in its own repo's
 * worktree, and with the story partials, so an ad-hoc fix goes in its own
 * `## Notes` and a side story (`bl side --from S-n`) stands alone. Its unit
 * file (`featureAbsPath`) stays the batch's, where the loop reads an
 * escalation.
 */
function batchStoryVars(ctx, s) {
  if (unitKind(ctx) !== 'batch') return {};
  const { prep } = ctx;
  const own = [{ repoName: prepRepo(ctx), worktreePath: prep.worktreePath }, ...(prep.otherWorktrees ?? [])].find(
    (w) => w.repoName === s.unitRepo,
  );
  return {
    featureId: s.id,
    unitKind: 'story',
    ...(own ? { worktreePath: own.worktreePath, targetRepo: own.repoName, primaryRepo: own.repoName } : {}),
  };
}

/**
 * Implement every story of `prep.ordered` the run has not taken yet, in
 * order; a story a session adds joins the stories not taken yet, in
 * dependency order (`refreshRepos`), and is reached by the same loop. The
 * stories taken stay first, so the loop's index still points past them. A
 * complete story is skipped; one left with
 * unchecked criteria gets one retry. Re-entered by `rescope` when a later
 * session adds stories. Returns the final state when the run stopped, else
 * null.
 */
async function implementStories(ctx) {
  const { feature, config, prep, state, implementPrompt } = ctx;
  const cfg = prep.cfg ?? config;
  for (let i = 0; i < prep.ordered.length; i++) {
    const s = prep.ordered[i];
    if (ctx.implemented.has(s.id)) continue;
    ctx.implemented.add(s.id);
    if (storyComplete(s, config.backlogRoot)) {
      await startStory(ctx, s);
      record(ctx, { step: 'implement', story: s.id, ok: true, note: 'already complete — skipped' });
      continue;
    }
    ctx.implementedThisRun = true;
    setStep(ctx, 'implement', { story: s.id, storyIndex: i });
    const storyAbsPath = join(config.backlogRoot, s.storyRelPath);
    if (isScripted(readFm(storyAbsPath))) {
      const stopped = await implementScripted(ctx, s, storyAbsPath);
      if (stopped) return stopped;
      state.storyIndex = i + 1;
      saveRunState(config, state);
      continue;
    }
    await startStory(ctx, s);
    const storyVars = {
      ...batchStoryVars(ctx, s),
      storyId: s.id,
      storyTitle: s.title,
      storyAbsPath,
      storyRelPath: s.storyRelPath,
      storyPoints: String(s.points),
      nudge: '',
      // One slot per story: its retry picks up what the first session left.
      scratchDir: scratchFor(ctx, s.id),
    };
    await runSession(ctx, {
      step: 'implement',
      story: s.id,
      mode: 'workon',
      promptName: implementPrompt,
      vars: storyVars,
      label: isStory(feature) ? `${s.id}: ${s.title}` : `${feature.id}: ${s.id} ${s.title}`,
      schema: loadSchema('implement'),
    });
    if (escalationOpen(feature.indexPath)) {
      return finish(ctx, 'escalated', `agent escalated while implementing ${s.id}`);
    }
    let stopped = await refreshRepos(ctx);
    if (stopped) return stopped;
    let open = unmetCriteria(storyAbsPath);
    if (open.length > 0) {
      const retry = await runSession(ctx, {
        step: 'implement',
        story: s.id,
        mode: 'workon',
        promptName: implementPrompt,
        vars: {
          ...storyVars,
          nudge: `A previous session on this story ended with these acceptance criteria still unchecked. Finish them (or, if one cannot be met, say why in the story file and escalate):\n${open.map((o) => `- ${o}`).join('\n')}`,
        },
        label: isStory(feature) ? `${s.id} (retry)` : `${feature.id}: ${s.id} (retry)`,
        schema: loadSchema('implement'),
      });
      if (escalationOpen(feature.indexPath)) {
        return finish(ctx, 'escalated', `agent escalated while implementing ${s.id}`);
      }
      stopped = await refreshRepos(ctx);
      if (stopped) return stopped;
      open = unmetCriteria(storyAbsPath);
      if (open.length > 0) {
        const blocked = retry.structured.blocked;
        return finish(
          ctx,
          'escalated',
          `${s.id} acceptance criteria unmet after two sessions`,
          [...open.map((o) => `- [ ] ${o}`), ...(blocked ? ['', `The agent was blocked: ${blocked}`] : [])].join('\n'),
        );
      }
    }
    state.storyIndex = i + 1;
    saveRunState(config, state);
  }
  return null;
}

/**
 * The `implement` step of a scripted story (F-71 D3): its command in its
 * repo's worktree, in place of a session. Returns the final state when the
 * run stopped, else null.
 */
async function implementScripted(ctx, s, storyAbsPath) {
  const { config, prep, feature } = ctx;
  const fm = readFm(storyAbsPath);
  const target = gateTargets(ctx).find((t) => t.repo === s.unitRepo);
  if (!target) {
    return finish(ctx, 'escalated', `${s.id}: ${s.unitRepo} has no worktree on ${prep.branchName}`);
  }
  const result = runImplementPlugin({
    id: s.id,
    title: s.title,
    fm,
    plugins: target.cfg.plugins,
    vars: {
      sessionId: prep.baseVars.sessionId,
      sessionNum: prep.baseVars.sessionNum,
      storyId: s.id,
      worktreePath: target.worktreePath,
      branchName: prep.branchName,
      repoPath: config.reposByName?.[target.repo],
      repoName: target.repo,
      roostDir: config.roostDir,
      backlogDir: config.backlogRoot,
    },
    worktreePath: target.worktreePath,
    runner: ctx.runner,
  });
  await recordScriptedRun({
    backlogRoot: config.backlogRoot,
    indexPath: storyAbsPath,
    changePath: existsSync(changeFile(ctx)) ? changeFile(ctx) : null,
    id: s.id,
    repo: target.repo,
    at: isoAt(runnerNow(ctx.runner)),
    result,
  });
  const note = scriptedSummary(s.id, result);
  record(ctx, {
    step: 'implement',
    story: s.id,
    ok: result.kind !== 'failed',
    scripted: {
      plugin: result.plugin ?? null,
      command: result.command ?? null,
      exit: result.exit ?? null,
      tail: result.tail,
    },
    note,
  });
  ctx.runner.log(`  ${note}`);
  await commitUnitPaths(
    ctx,
    'implement',
    [s.storyRelPath, changeRelPath(ctx)],
    `chore: ${note.split('\n')[0].slice(0, 120)}`,
  );
  if (result.kind === 'failed') {
    const { reason, details } = scriptedEscalation(s.id, result, ctx.resumeHint);
    return finish(ctx, 'escalated', reason, details);
  }
  if (result.kind === 'unchanged' && isStory(feature)) return finish(ctx, 'no-change');
  return null;
}

/**
 * Whether this run skips review: a story unit that is scripted, without
 * `review: true`, and that no agent has touched. A fix session after a red gate
 * is agent work, so it gets reviewed. A feature always is: its review covers
 * the whole branch.
 */
function skipsReview(ctx) {
  return (
    isStory(ctx.feature) && reviewSkipped(readFm(ctx.feature.indexPath)) && !ctx.state.history.some((h) => h.agent)
  );
}

/** The run's stories and repos, as `{ stories, repos }` id lists. */
function runScope(ctx) {
  return { stories: (ctx.prep.ordered ?? []).map((s) => s.id), repos: gateTargets(ctx).map((t) => t.repo) };
}

/**
 * After a session that is not an implementation: `refreshRepos`, then, when
 * it added stories or repos, the stage they missed (implementing every
 * story not yet taken), so the gate and the review that follow cover them.
 * Returns `{ stop }` (the final state) when the run stopped, else
 * `{ changed, added }`.
 */
async function rescope(ctx) {
  // `bl merge`'s integration merges the repos it prepared; a story added by
  // its sessions is for the next `bl run`, not this merge. An edit to
  // `plan.yaml`'s `merge_order` is not followed here: `cmdMerge` reads the
  // plan again after the integration.
  if (ctx.integration) return { changed: false, added: { stories: [], repos: [] } };
  const before = runScope(ctx);
  const stopped = await refreshRepos(ctx);
  if (stopped) return { stop: stopped };
  const after = runScope(ctx);
  const added = {
    stories: after.stories.filter((id) => !before.stories.includes(id)),
    repos: after.repos.filter((r) => !before.repos.includes(r)),
  };
  const changed = added.stories.length > 0 || added.repos.length > 0;
  if (changed) {
    const s = await implementStories(ctx);
    if (s) return { stop: s };
  }
  return { changed, added };
}

/** `stories S-3 and repos repo-b`, for a `rescope` result. */
function scopeNote(scope) {
  return [
    scope.added.stories.length ? `stories ${scope.added.stories.join(', ')}` : '',
    scope.added.repos.length ? `repos ${scope.added.repos.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' and ');
}

/**
 * Whether the last review round covered every story and repo the run now
 * has (`state.reviewedScope`, saved by each round). A run state from before
 * the field was kept counts as covered.
 */
function scopeReviewed(ctx) {
  const reviewed = ctx.state.reviewedScope;
  if (!reviewed) return true;
  const now = runScope(ctx);
  return now.stories.every((id) => reviewed.stories.includes(id)) && now.repos.every((r) => reviewed.repos.includes(r));
}

/** Each gate target's HEAD, by repo; null where git cannot read it. */
function targetHeads(ctx) {
  const out = new Map();
  for (const t of gateTargets(ctx)) {
    const r = ctx.runner.shell('git rev-parse HEAD', t.worktreePath);
    out.set(t.repo, r?.status === 0 ? String(r.output ?? '').trim() : null);
  }
  return out;
}

/**
 * Whether any gate target moved since `before` (`targetHeads`): a new HEAD, a
 * repo that was not there, an unreadable HEAD, or uncommitted changes.
 */
function targetsMoved(ctx, before) {
  const now = targetHeads(ctx);
  for (const t of gateTargets(ctx)) {
    const head = now.get(t.repo);
    if (head == null || head !== before.get(t.repo)) return true;
    const leftovers = worktreeChanges(ctx, t.worktreePath);
    if (leftovers == null || leftovers.length > 0) return true;
  }
  return false;
}

/**
 * The feature's stories as the backlog has them now: every story whose
 * `feature:` names it (F-77 D3). Each story the run does not hold yet is
 * checked the way `bl run` checks the others before it starts
 * (`prepareFeatureWorktree`): it has a repo the config knows and no edge
 * holds it at `run` (`heldBy`; a `depends_on:` outside the feature is one).
 * Returns `{ stories, edges }` (`readEdges`'s) or `{ error }`; a read that
 * fails is an error, never "nothing changed".
 */
function refreshedStories(ctx) {
  const { feature, config } = ctx;
  let res;
  let edges;
  let holds;
  try {
    res = resolveFeatureStories(feature, config);
    edges = readEdges(config);
    holds = heldBy(config, feature.id, 'run');
  } catch (e) {
    return { error: e.message };
  }
  const { stories } = res;
  if (stories.length === 0) return { error: `${feature.id} has no stories` };
  const held = new Set((ctx.prep.ordered ?? []).map((s) => s.id));
  const added = stories.filter((s) => !held.has(s.id));
  const noRepo = added.filter((s) => !s.unitRepo);
  if (noRepo.length > 0) {
    return { error: `${noRepo.map((s) => `${s.id} (component ${s.componentId || '(none)'})`).join(', ')} has no repo` };
  }
  const unknown = featureRepoOrder(added).filter((name) => !config.reposByName?.[name]);
  if (unknown.length > 0) return { error: `unknown repo ${unknown.join(', ')} (not in backlog.json)` };
  const blockers = holds.filter((h) => added.some((s) => s.id === h.edge.unit));
  if (blockers.length > 0) {
    return { error: `blocked on work outside the feature: ${blockers.map((h) => h.line).join(', ')}` };
  }
  return { stories, edges };
}

/**
 * The repo guard's warnings (F-52 D4, F-61 D1) for a unit's branch diff: one
 * per repo with changes but no story of the unit, naming the repo. A changed
 * path outside the stories' components gets no warning: a component's
 * `paths:` is a map for people and agents, not a rule. Pure; `repoGuard`
 * gathers the inputs.
 *
 * @param {{ repo: string, files: string[] }[]} repos  each worktree's diff against main
 * @param {Set<string>} storyComponentIds  the unit's stories' components
 * @param {Array<{ id: string, repo: string }>} components  readComponents records
 * @returns {string[]}
 */
export function repoGuardWarnings(repos, storyComponentIds, components) {
  const warnings = [];
  for (const { repo, files } of repos) {
    if (files.length === 0) continue;
    if (components.some((c) => c.repo === repo && storyComponentIds.has(c.id))) continue;
    warnings.push(
      `${repo}: ${files.length} changed path${files.length === 1 ? '' : 's'}, but no story of the unit is in this repo`,
    );
  }
  return warnings;
}

/**
 * The repo guard (F-52 D4, F-61 D1), after the agent's work and before the
 * test gate: every prepared worktree, and any other worktree on the branch, is
 * diffed against main, and each warning is printed and recorded once per run
 * in the history (`step: "repo-guard"`). It only warns: the run continues.
 */
function repoGuard(ctx) {
  const targets = gateTargets(ctx);
  const prepared = new Set(targets.map((t) => t.repo));
  const repos = [];
  for (const t of [...targets, ...strayWorktrees(ctx, prepared)]) {
    const files = diffAgainstMain(ctx, t.worktreePath);
    if (files == null) {
      ctx.runner.log(`warning: repo guard: ${t.repo}: git diff against main failed; it is not checked`);
      continue;
    }
    repos.push({ repo: t.repo, files });
  }
  const ids = new Set((ctx.prep.ordered ?? []).map((s) => s.componentId).filter(Boolean));
  const seen = new Set(ctx.state.history.filter((h) => h.step === 'repo-guard').map((h) => h.note));
  for (const note of repoGuardWarnings(repos, ids, readComponents(ctx.config))) {
    ctx.runner.log(`warning: repo guard: ${note}`);
    if (!seen.has(note)) record(ctx, { step: 'repo-guard', ok: true, warning: true, note });
    seen.add(note);
  }
}

const GIT_STATUS_COMMAND = 'git status --porcelain --untracked-files=all';

function runTestGateInner(ctx) {
  const { runner, prep, config } = ctx;
  const targets = gateTargets(ctx);
  const multi = targets.length > 1;
  // Every repo's plugins are resolved and filled before anything runs, and
  // before the dirty-tree check: no fix-tests session can repair backlog.json.
  for (const t of targets) {
    const misconfigured = (note, reason) => {
      record(ctx, { step: 'test', ok: false, note: `${t.repo}: ${note}` });
      return {
        ok: false,
        config: true,
        reason: `${t.repo}: ${reason}`,
        repo: t.repo,
        worktreePath: t.worktreePath,
        perRepo: [{ repo: t.repo, command: null, config: true, verdict: 'fail' }],
      };
    };
    // `{ plugins, unknown }`; a plain list (a runner that cannot know about
    // unknown names) is read as having none.
    const res = runner.testPlugins(t.cfg, ctx.feature.indexPath, ctx.feature.componentEntry);
    const { plugins, unknown = [] } = Array.isArray(res) ? { plugins: res } : (res ?? {});
    if (unknown.length > 0) {
      // A misspelt plugin is a broken gate, not an absent one: an untested
      // branch must not go on to the PR.
      const note = `unknown test plugin${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (not defined in backlog.json plugins)`;
      return misconfigured(note, note);
    }
    // The feature's session number (featureSessionVars) comes through baseVars;
    // a prep without it leaves the placeholder for the check below to refuse.
    const vars = {
      worktreePath: t.worktreePath,
      featureId: ctx.feature.id,
      branchName: prep.branchName,
      backlogDir: config.backlogRoot,
      roostDir: config.roostDir,
    };
    for (const k of ['sessionId', 'sessionNum']) {
      if (typeof prep.baseVars?.[k] === 'string' && prep.baseVars[k]) vars[k] = prep.baseVars[k];
    }
    t.commands = [];
    for (const { name, command } of plugins ?? []) {
      let cmd = String(command ?? '');
      for (const [k, v] of Object.entries(vars)) cmd = cmd.replaceAll(`{{${k}}}`, v);
      // A literal `{{sessionNum}}` would reach the app as a session ID (and
      // Playwright falls back to the shared session 0), so a placeholder bl
      // cannot fill is a broken gate, not a command to run. Only bl's own
      // form, `{{name}}`, counts: a Go template in the command
      // (`docker ps --format '{{.Names}}'`) is not a placeholder.
      const left = cmd.match(/\{\{\s*[A-Za-z_]\w*\s*\}\}/);
      if (left) {
        const note = `unresolved placeholder ${left[0]} in test plugin ${name}`;
        return misconfigured(note, `${note}: \`${cmd}\``);
      }
      t.commands.push({ name, cmd });
    }
  }
  // The gate certifies committed code. Stray files (an implementer's
  // forgotten scratch, an uncommitted edit) would make it test something the
  // PR does not contain, so a dirty tree fails the gate and the file list goes
  // to the fix-tests session to commit or remove. That holds with no test
  // plugin too: a fix round's leftovers must not reach the review passes.
  // Every worktree is checked before any command runs.
  const dirtyTargets = [];
  for (const t of targets) {
    const dirty = worktreeChanges(ctx, t.worktreePath);
    if (dirty == null) {
      record(ctx, {
        step: 'test',
        ok: false,
        note: `git status failed — the ${multi ? `${t.repo} ` : ''}worktree cannot be shown clean`,
      });
      const text = `git status failed in the ${t.repo} worktree (${t.worktreePath}), so the test gate cannot tell whether it is testing committed code. Make \`git status\` work there.`;
      return gateFailure(ctx, {
        command: GIT_STATUS_COMMAND,
        logPath: nextGateLog(ctx),
        log: text,
        output: text,
        excerpt: text,
        repo: t.repo,
        worktreePath: t.worktreePath,
        perRepo: [{ repo: t.repo, command: GIT_STATUS_COMMAND, verdict: 'fail' }],
      });
    }
    if (dirty.length > 0) dirtyTargets.push({ ...t, dirty });
  }
  if (dirtyTargets.length > 0) {
    const all = dirtyTargets.flatMap((t) => t.dirty.map((c) => (multi ? `${t.repo}: ${c.path}` : c.path)));
    record(ctx, {
      step: 'test',
      ok: false,
      note: `worktree not clean: ${all.length} path${all.length === 1 ? '' : 's'} (${all.slice(0, 3).join(', ')}${all.length > 3 ? ', …' : ''})`,
    });
    const list = dirtyTargets
      .map((t) => `${t.repo} (${t.worktreePath}):\n${t.dirty.map((c) => `${c.code} ${c.path}`).join('\n')}`)
      .join('\n\n');
    const text = `The worktree is not clean; the test gate only runs on committed code.\nCommit what belongs to the ${unitKind(ctx)} and move scratch files out of the worktree:\n\n${list}`;
    const first = dirtyTargets[0];
    // The log holds the whole list; the excerpt is its head.
    return gateFailure(ctx, {
      command: GIT_STATUS_COMMAND,
      logPath: nextGateLog(ctx),
      log: text,
      output: text,
      excerpt: head(text, 80),
      repo: first.repo,
      worktreePath: first.worktreePath,
      perRepo: dirtyTargets.map((t) => ({ repo: t.repo, command: GIT_STATUS_COMMAND, verdict: 'fail' })),
    });
  }
  if (targets.every((t) => t.commands.length === 0)) {
    record(ctx, {
      step: 'test',
      ok: true,
      note: 'skipped — no `test` stage plugin configured (plugins-test: <name> on the feature, or plugins-test on its repo in backlog.json)',
    });
    runner.log('  (test gate skipped — no `test` plugin configured)');
    return {
      ok: true,
      skipped: true,
      perRepo: targets.map((t) => ({ repo: t.repo, command: null, verdict: 'skipped' })),
    };
  }
  // Every attempt keeps its complete output, pass or fail, in one log: the
  // escalation shows only an excerpt and a tail, and the fix-tests session
  // reads the rest.
  const logPath = nextGateLog(ctx);
  let log = '';
  const perRepo = [];
  for (const t of targets) {
    if (t.commands.length === 0) {
      runner.log(`  ${t.repo}: no \`test\` plugin configured — skipped`);
      log += `── ${t.repo}: skipped (no test plugin)\n`;
      perRepo.push({ repo: t.repo, command: null, verdict: 'skipped' });
      continue;
    }
    for (const { name, cmd } of t.commands) {
      runner.log(`  ${t.repo} · test plugin ${name}: ${cmd}`);
      // Merged streams: an error printed on stderr stays next to the stdout
      // lines around it (runners without the option ignore it).
      const r = runner.shell(cmd, t.worktreePath, { mergeStreams: true, scope: newScope(ctx) });
      checkStop(ctx);
      const output = String(r.output ?? '');
      log += `── ${t.repo} · ${name}: ${cmd}\n${output}${output.endsWith('\n') || !output ? '' : '\n'}`;
      if (r.status !== 0) {
        record(ctx, {
          step: 'test',
          ok: false,
          note: `${multi ? `${t.repo} · ` : ''}${name} exited ${r.status} — log: ${logPath}`,
        });
        perRepo.push({ repo: t.repo, command: cmd, verdict: 'fail' });
        return gateFailure(ctx, {
          command: cmd,
          logPath,
          log,
          output,
          repo: t.repo,
          worktreePath: t.worktreePath,
          perRepo,
        });
      }
    }
    perRepo.push({ repo: t.repo, command: t.commands.map((c) => c.cmd).join(' && '), verdict: 'pass' });
  }
  const shownPath = writeGateLog(ctx, logPath, log);
  record(ctx, { step: 'test', ok: true, note: `log: ${shownPath}` });
  return {
    ok: true,
    logPath: shownPath,
    command: perRepo
      .filter((e) => e.command)
      .map((e) => e.command)
      .join(' && '),
    perRepo,
  };
}

function headSha(ctx) {
  const r = ctx.runner.shell('git rev-parse HEAD', ctx.prep.worktreePath);
  return r.status === 0 ? r.output.trim() : null;
}

function changedFilesSince(ctx, sha) {
  if (!sha) return [];
  const r = ctx.runner.shell(`git diff --name-only ${sha}..HEAD`, ctx.prep.worktreePath);
  return r.status === 0
    ? r.output
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Test gate with a fix session. Returns true when green (or skipped).
 *
 * gate → fix-tests → gate, escalating when the second gate fails, with two
 * bounded detours, each taken at most once per call. The session's outcome
 * (`schemas/fix-tests.json`, F-68 D2) decides:
 * - `unrelated` with a flaky-sounding reason (looksFlaky) is sent back to
 *   fix-tests with a note instead of escalating; a second `unrelated`
 *   escalates.
 * - `rerun` (the failure would not reproduce) reruns the gate as `fixed`
 *   does; if that gate fails, the failure goes to one more fix-tests session
 *   instead of escalating.
 * So a call runs at most three fix-tests sessions and three gates.
 */
async function testGateWithFix(ctx) {
  repoGuard(ctx);
  let gate = await runTestGate(ctx);
  if (gate.ok) return true;
  if (gate.config) {
    await finish(ctx, 'escalated', 'test gate misconfigured', gate.reason);
    return false;
  }
  let pushedBack = false;
  let rerunUsed = false;
  let fixNote = '';
  for (;;) {
    setStep(ctx, 'fix-tests');
    const scratchDir = scratchFor(ctx, `fix-tests-${ctx.state.testAttempts}`);
    // Where a session returning `unrelated` writes the operator's explanation
    // (prompts/_escalation.md). A send-back shares the slot, so an earlier
    // session's file is cleared first.
    const explanationPath = join(scratchDir, ESCALATION_FILE);
    rmSync(explanationPath, { force: true });
    const fix = await runSession(ctx, {
      step: 'fix-tests',
      mode: 'workon',
      promptName: 'feature-fix-tests',
      vars: {
        // The repo whose check failed and its worktree; the session starts
        // in the run's own worktree and fixes and commits there (S-1010).
        testRepo: gate.repo ?? prepRepo(ctx),
        testWorktree: gate.worktreePath ?? ctx.prep.worktreePath,
        testCommand: gate.command,
        testLogPath: gate.logPath,
        testExcerpt: gate.excerpt,
        testTail: gate.tail,
        fixNote,
        scratchDir,
      },
      label: `${ctx.feature.id}: fix tests`,
      schema: loadSchema('fix-tests'),
    });
    const { outcome, reason } = fix.structured;
    // An agent that judged the failure environmental (an expired certificate,
    // a stack running other code) has nothing to fix; rerunning the gate would
    // only cost minutes and replace its reason with a second identical failure.
    // `--resume` after the operator fixes the environment starts at the gate.
    // A flaky failure is not environmental: it goes back to be fixed, once.
    if (outcome === 'unrelated') {
      if (!pushedBack && looksFlaky(reason)) {
        pushedBack = true;
        fixNote = flakyPushbackNote(reason);
        record(ctx, {
          step: 'fix-tests',
          ok: false,
          note: `unrelated refused — a flaky failure is a bug to fix; sent back once: ${reason.slice(0, 120)}`,
        });
        continue;
      }
      await finish(
        ctx,
        'escalated',
        'test gate failure is environmental (fix-tests: unrelated)',
        unrelatedDetails(reason, explanationPath, gate),
      );
      return false;
    }
    if ((await rescope(ctx)).stop) return false;
    const rerun = !rerunUsed && outcome === 'rerun' ? reason : null;
    setStep(ctx, 'test');
    gate = await runTestGate(ctx);
    if (gate.ok) return true;
    if (rerun && !gate.config) {
      rerunUsed = true;
      fixNote = rerunFailedNote(rerun);
      continue;
    }
    await finish(ctx, 'escalated', 'test gate failed twice', gateDetails(gate));
    return false;
  }
}

/**
 * Push the branch and confirm `origin/<branch>` contains HEAD. Returns null
 * when it does, else `{ note, details }`: the run log's line, and the
 * escalation (`pushEscalation()`, S-897) from the gate's check record. Run
 * before every review pass and before a clean finish, so a commit made after
 * the last push (a fix-tests commit, a fix round that did not push) never
 * goes unreviewed or unpublished.
 */
function pushBranch(ctx, step) {
  const { runner, prep } = ctx;
  const next = `set this section to "None.", then \`${resumeCommand(ctx)}\``;
  for (const t of publishTargets(ctx)) {
    const lead = t.repo === prepRepo(ctx);
    const pushStartedAt = runnerNow(runner).getTime();
    const push = runner.shell(`git push -u origin ${prep.branchName}`, t.worktreePath);
    let failed = null;
    if (push.status !== 0) {
      failed = {
        note: 'git push failed',
        push,
        gate: gateRecord({ runner, worktreePath: t.worktreePath, pushStartedAt }),
      };
    } else {
      const ahead = runner.shell(`git rev-list --count origin/${prep.branchName}..HEAD`, t.worktreePath);
      if (ahead.status !== 0 || ahead.output.trim() !== '0') {
        const note = `origin/${prep.branchName} does not contain HEAD after the push (${ahead.status !== 0 ? `rev-list exited ${ahead.status}` : `${ahead.output.trim() || '?'} commit(s) ahead`})`;
        failed = { note, push: { status: 0, output: note }, gate: { none: 'the push exited 0' } };
      }
    }
    if (failed) {
      const note = lead ? failed.note : `${t.repo}: ${failed.note}`;
      record(ctx, { step, ok: false, note });
      const details = pushEscalation({
        repo: t.repo,
        branch: prep.branchName,
        worktreePath: t.worktreePath,
        push: failed.push,
        gate: failed.gate,
        next,
      });
      return { note, details };
    }
  }
  return null;
}

/**
 * The repos the run publishes (pushes, and opens a PR in): the run's own
 * repo always, then each other prepared repo whose branch has commits ahead
 * of main. A repo with nothing on the branch gets no PR, as in `bl review`.
 */
function publishTargets(ctx) {
  const [lead, ...others] = gateTargets(ctx);
  return [lead, ...others.filter((t) => !branchEmpty(ctx, t))];
}

/** Whether `t`'s branch has no commits ahead of main (`git rev-list --count main..HEAD` is 0). */
function branchEmpty(ctx, t) {
  const r = ctx.runner.shell('git rev-list --count main..HEAD', t.worktreePath);
  return r?.status === 0 && String(r.output ?? '').trim() === '0';
}

/**
 * A PR in every other published repo that has none yet in the run
 * (`prep.otherRepos`, which the review rounds read), through
 * `openPullRequest`. Run after each push, so a repo added during the run
 * (`refreshRepos`) gets its PR before the next review. Returns `{ error }`
 * naming the repo, or `{}`.
 */
async function openOtherPullRequests(ctx) {
  const { prep } = ctx;
  prep.otherRepos ??= [];
  for (const t of publishTargets(ctx).slice(1)) {
    if (prep.otherRepos.some((r) => r.repoName === t.repo)) continue;
    const opened = await openPullRequest(ctx, t);
    if (opened.error) return { error: `${t.repo}: ${opened.error}` };
    if (opened.pr) prep.otherRepos.push({ repoName: t.repo, worktreePath: t.worktreePath, pr: opened.pr });
  }
  return {};
}

/**
 * The PR's title and body, generated from the change document (F-42 D4):
 * the title is the unit's id and title, the body its `## Description` and
 * the spec's path. The forge holds nothing of its own, so an edit made on
 * the forge is overwritten by the next `change.describe`.
 */
export function changePrContent(unit, description) {
  return {
    title: `${unit.id}: ${unit.title}`,
    body: `${String(description ?? '').trim()}\n\n${unitLabel(unit)} file: ${unit.featureRelPath}\n\nGenerated by \`bl\` from the change document; edits made here are overwritten.`,
  };
}

/**
 * Bring an existing PR's body in line with the change document through
 * `change.describe`, once per body: the run state keeps the body last sent,
 * so a re-entry rewrites the PR only when `## Description` changed. Never
 * fatal: a failure is recorded and the run goes on with the PR as it is.
 */
function describePullRequest(ctx, t, number, body) {
  if (sentBody(ctx, t.repo) === body) return;
  const { runner } = ctx;
  const label = prLabel(ctx, t.repo, number);
  let res;
  try {
    res = runner.forge(
      'change.describe',
      { number: String(number), body },
      { config: t.cfg, repoPath: t.worktreePath },
    );
  } catch (e) {
    res = { configured: false, reason: e.message };
  }
  if (res?.configured && res.status === 0) {
    setSentBody(ctx, t.repo, body);
    record(ctx, { step: 'pr', ok: true, note: `${label} description updated` });
  } else if (res?.reason !== 'no-forge') {
    const why = !res?.configured
      ? `change.describe unavailable (${res?.reason ?? 'unknown'})`
      : `change.describe failed: ${tail(res.stderr, 3)}`;
    record(ctx, { step: 'pr', ok: false, note: `${label} keeps its old description — ${why}` });
  }
}

/** The PR body last sent for `repo`: the run repo's in `prBody`, the others' in `prBodies`. */
function sentBody(ctx, repo) {
  return repo === prepRepo(ctx) ? ctx.state.prBody : ctx.state.prBodies?.[repo];
}

function setSentBody(ctx, repo, body) {
  if (repo === prepRepo(ctx)) ctx.state.prBody = body;
  else ctx.state.prBodies = { ...ctx.state.prBodies, [repo]: body };
}

/** `PR #7` for the run's repo, `repo-b PR #7` for another. */
function prLabel(ctx, repo, number) {
  return repo === prepRepo(ctx) ? `PR #${number}` : `${repo} PR #${number}`;
}

/**
 * Open the unit's PR in one repo (`t`, a `gateTargets` entry; the run's
 * own repo by default) through `change.open`, or adopt the one already
 * recorded or already open (`change.find`). Title and body come from the
 * change document (`changePrContent`); a recorded or adopted PR gets the
 * current body through `change.describe`. The number and URL are recorded
 * on that repo's `repos:` entry. Returns `{ pr }`, `{ optOut }` when no
 * forge is configured (the one explicit way to run without a PR), or
 * `{ error }`.
 */
async function openPullRequest(ctx, t = gateTargets(ctx)[0]) {
  const { runner, prep, feature, config } = ctx;
  const cfg = t.cfg;
  const lead = t.repo === prepRepo(ctx);
  const description = extractSection(readChangeText(ctx).body, 'Description')?.trim() || describeUnit(ctx);
  const { title, body } = changePrContent(feature, description);
  const recorded = recordedRepo(ctx, t.repo);
  if (recorded?.pr) {
    record(ctx, { step: 'pr', ok: true, note: `${prLabel(ctx, t.repo, recorded.pr)} already recorded` });
    describePullRequest(ctx, t, recorded.pr, body);
    return { pr: { number: String(recorded.pr), url: recorded.url || (lead ? ctx.state.pr?.url : '') || '' } };
  }
  const res = runner.forge('change.open', { title, body }, { config: cfg, repoPath: t.worktreePath });
  if (res && !res.configured && res.reason === 'no-forge') {
    if (lead) record(ctx, { step: 'pr', ok: true, note: 'no forge configured — running without a PR' });
    return { optOut: 'no-forge' };
  }
  if (!res || !res.configured) {
    // A forge is named but unusable (no plugin, no change.open op, binary
    // missing): that is a broken setup, not an opt-out.
    const error = `forge change.open unavailable (${res?.reason ?? 'unknown'})`;
    record(ctx, { step: 'pr', ok: false, note: error });
    return { error };
  }
  let url = '';
  let number = '';
  if (res.status === 0) {
    url =
      String(res.stdout ?? '')
        .trim()
        .split('\n')
        .filter((l) => /https?:\/\//.test(l))
        .pop() ?? '';
    number = url.match(/\/(\d+)\s*$/)?.[1] ?? '';
    if (number) setSentBody(ctx, t.repo, body);
  } else {
    // The usual cause is a PR that already exists for the branch (opened by
    // hand, or by a run whose `pr:` write never landed): adopt it.
    const found = findChange(prep.branchName, {
      config: cfg,
      repoPath: t.worktreePath,
      runOp: runner.forge.bind(runner),
    });
    const pr = found.ok ? (found.prs.find((p) => p.state === 'OPEN') ?? null) : null;
    if (!pr) {
      const error = `change.open failed and change.find found no open PR: ${tail(res.stderr, 3)}`;
      record(ctx, { step: 'pr', ok: false, note: error });
      return { error };
    }
    number = String(pr.number);
    url = pr.url ?? '';
    describePullRequest(ctx, t, number, body);
  }
  if (!number) {
    const error = `change.open printed no PR URL: ${tail(res.stdout, 3)}`;
    record(ctx, { step: 'pr', ok: false, note: error });
    return { error };
  }
  try {
    await updateChange(config.backlogRoot, changeFile(ctx), (doc) =>
      setRepo(doc, t.repo, { branch: prep.branchName, pr: number, url }),
    );
    await commitChangeFile(ctx, 'pr', `chore: ${feature.id} PR opened (${lead ? '' : t.repo}#${number})`);
  } catch (e) {
    record(ctx, {
      step: 'pr',
      ok: false,
      note: `${prLabel(ctx, t.repo, number)} could not be recorded in ${changeRelPath(ctx)}: ${e.message}`,
    });
  }
  record(ctx, { step: 'pr', ok: true, note: lead ? url : `${t.repo}: ${url}` });
  return { pr: { number, url } };
}

/** `clean` only with the branch published and a PR (or the no-forge opt-out). */
async function finishClean(ctx) {
  const pushErr = pushBranch(ctx, 'stop');
  if (pushErr) return finish(ctx, 'escalated', 'the reviewed branch could not be published', pushErr.details);
  const others = await openOtherPullRequests(ctx);
  if (others.error) return finish(ctx, 'escalated', 'no pull request could be opened', others.error);
  if (!ctx.state.pr?.number && !ctx.state.prOptOut) {
    return finish(ctx, 'escalated', 'no pull request is recorded for the reviewed branch');
  }
  // `clean` means `bl merge` will take it: the same gate, read the
  // same way.
  const status = reviewState(ctx).position;
  const gate = featureReviewGate(status, readChangeText(ctx).body);
  if (gate.blocked) {
    return finish(
      ctx,
      'escalated',
      `${ctx.feature.id} is ${status ?? unitStatus(ctx)} and the latest session has ${gate.review?.blocking ?? 0} open Must/Should item(s)`,
      openItemsSummary(ctx),
    );
  }
  return finish(ctx, 'clean');
}

function reviewVars(ctx, { reReview, changedFiles, round, position, fullScope, closing = false, scope = null }) {
  const max = ctx.state.maxRounds;
  const changed = changedFiles?.length ? changedFiles.map((f) => `- ${f}`).join('\n') : '';
  // A feature with a PR in more than one repo gets one round over all of
  // them: one verdict, one Review Log session, one round spent.
  const others = reviewOtherRepos(ctx);
  const otherPrs = others.length
    ? `\n\nThis feature changes ${others.length + 1} repos, and this round reviews them together — one Review Log session covering all of them. The scope above is for this worktree; also review the full branch diff (\`git diff main...HEAD\`) in each of:\n${others.map((r) => `- ${r.repoName}: ${r.pr ? `PR #${r.pr.number} ${r.pr.url ?? ''}` : 'no pull request'} — worktree ${r.worktreePath}`).join('\n')}`
    : '';
  return {
    mainRef: 'main',
    prNumber: ctx.state.pr?.number || recordedRepo(ctx)?.pr || '(none)',
    prUrl: ctx.state.pr?.url || '(no pull request)',
    // The review position the round starts from (F-69 D5).
    reviewStatus: position ?? '(none)',
    reviewRound: String(round),
    nextRound: String(round + 1),
    reviewRoundsMax: String(max),
    reReview: reReview ? 'true' : 'false',
    closingRound: closing ? 'true' : 'false',
    changedFiles: changed || '(none recorded)',
    // A `scope` override (the integration round, F-36 D7) names every repo
    // itself.
    reviewScope:
      scope ??
      (!fullScope
        ? `Only the files changed by the fixes since the previous review (${ctx.state.reviewBaseSha}):\n${changed}`
        : reReview
          ? 'The full branch diff: `git diff main...HEAD`. No base commit from the previous review is recorded (or nothing changed since it), so this re-review covers the whole branch, not only the fixes.'
          : 'The full branch diff: `git diff main...HEAD`.') + otherPrs,
  };
}

/** Files the branch changes against main (`git diff --name-only main...HEAD`). */
function branchFiles(ctx) {
  const r = ctx.runner.shell('git diff --name-only main...HEAD', ctx.prep.worktreePath);
  return r.status === 0
    ? r.output
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * One review round: the dimension passes, then the verifier. The round is one
 * transaction over every worktree it reaches — each worktree's lock is held
 * from the first pass's snapshot through the verifier's restore — and it
 * aborts (`abortError`) without a verdict when a lock cannot be taken, a
 * worktree cannot be restored, or any session fails.
 */
async function reviewRound(ctx, { reReview, closing = false, scope = null }) {
  // The rounds with a verdict (F-69 D5): this round is the next one.
  const { reviewed: round, position } = reviewState(ctx);
  const locks = holdReviewLocks(ctx);
  if (locks.error) return roundAborted(ctx, round, locks.error);
  try {
    return await reviewRoundLocked(ctx, { reReview, round, position, closing, scope });
  } finally {
    locks.release();
  }
}

/**
 * `scope` (`{ text, files }`) replaces the review's scope and changed files:
 * `bl merge`'s round over a merge resolution (F-36 D7). Every other caller
 * passes none.
 */
async function reviewRoundLocked(ctx, { reReview, round, position, closing = false, scope = null }) {
  const { prep, feature, config } = ctx;
  setStep(ctx, closing ? 'closing-review' : reReview ? 're-review' : 'review', { round: round + 1 });
  // The review starts (F-69 D3): a unit with no log gets one, and a unit in
  // progress (`bl review` after `bl implement`) or ready for merge (`bl
  // merge`'s round over a merge resolution) goes to `in_review`, the
  // `review` verb's `during`. Its verdict is recorded below (D5).
  await ensureLog(config.backlogRoot, { ...unitRef(ctx), change: readChange(changeFile(ctx)) });
  const flow = loadFlow(config.backlogRoot);
  if (flow.fromOf(unitKind(ctx), flow.verbOf(unitKind(ctx), 'review')).includes(unitStatus(ctx))) {
    await enterHop(ctx, 'review', 'review');
  }

  // A re-review narrows to the files the fixes touched only when there is a
  // recorded base to diff against and the diff names something. Otherwise
  // (a fresh run after a manual fix, lost run state) it reviews the branch.
  let changedFiles = scope ? scope.files : reReview ? changedFilesSince(ctx, ctx.state.reviewBaseSha) : [];
  const fullScope = !reReview || !ctx.state.reviewBaseSha || changedFiles.length === 0;
  if (!scope && reReview && fullScope) changedFiles = branchFiles(ctx);
  const runDir = join(config.backlogRoot, RUN_DIR);
  mkdirSync(runDir, { recursive: true });
  const findingsPaths = [];
  // The configuration of each pass, for the verifier's Review Log header and
  // the round's history entry (F-64 D4).
  const passes = [];
  const common = reviewVars(ctx, {
    reReview,
    changedFiles,
    round,
    position,
    fullScope,
    closing,
    scope: scope?.text ?? null,
  });
  // The closing round runs no dimension passes: it verifies that the items
  // already found were fixed, and does not look for new ones.
  for (const dim of closing ? [] : REVIEW_DIMENSIONS) {
    const findingsPath = join(runDir, `${feature.id}.r${round + 1}.${dim}.md`);
    findingsPaths.push(findingsPath);
    // A file left by an aborted attempt at this round is not this pass's
    // output; the verifier must never read it as such.
    rmSync(findingsPath, { force: true });
    const scratchDir = join(runDir, `${feature.id}.r${round + 1}.${dim}.scratch`);
    mkdirSync(scratchDir, { recursive: true });
    const before = snapshotWorktrees(ctx);
    if (before.error) return roundAborted(ctx, round, before.error);
    const r = await quarantineOnCleanupError(ctx, `r${round + 1}-${dim}`, before.snaps, async () =>
      runSession(ctx, {
        step: `review:${dim}`,
        mode: 'review',
        role: 'review',
        promptName: `review-${dim}`,
        vars: { ...common, findingsPath, dimension: dim, scratchDir },
        label: `${feature.id}: review r${round + 1} ${dim}`,
      }),
    );
    const q = quarantineReviewerChanges(ctx, `r${round + 1}-${dim}`, before.snaps);
    if (q.error) return roundAborted(ctx, round, q.error);
    // The verifier weighs every dimension; with one missing, its verdict
    // would pass what nobody reviewed.
    if (!r.ok)
      return roundAborted(
        ctx,
        round,
        `the ${dim} pass failed: ${sessionError(r)}`,
        sessionFailure(ctx, `review:${dim}`, r),
      );
    if (r.configuration) passes.push({ session: `review:${dim}`, ...r.configuration });
    if (!existsSync(findingsPath)) {
      writeFileSync(findingsPath, `# ${dim}\n\n(no findings file was produced by the ${dim} pass)\n`);
    }
  }
  const verifyScratch = join(runDir, `${feature.id}.r${round + 1}.verify.scratch`);
  mkdirSync(verifyScratch, { recursive: true });
  const beforeVerify = snapshotWorktrees(ctx);
  if (beforeVerify.error) return roundAborted(ctx, round, beforeVerify.error);
  // A failed verifier session's edits to the unit file and its change
  // document are not a verdict. The session's own usage, recorded on the
  // unit file as it ended, is kept (F-67 D6).
  const featureBefore = readFileSync(feature.indexPath, 'utf8');
  const changeBefore = existsSync(changeFile(ctx)) ? readFileSync(changeFile(ctx)) : null;
  const restoreChangeDoc = async () => restoreChange(ctx.config.backlogRoot, changeFile(ctx), changeBefore);
  // The round's verdict is bl's (F-68 D3). bl records it in the unit's log
  // once, after the verifier returns one: a round that ends any other way (a
  // throw, an abort, a killed bl) records none, and the unit stays in
  // `in_review`. The Review Log may not: if bl dies after the verifier
  // committed its session block, the Review Log holds a block for round N+1
  // while the log has no verdict for it. The prompt gives the verifier the
  // round as `nextRound`.
  let rv;
  try {
    rv = await quarantineOnCleanupError(ctx, `r${round + 1}-verify`, beforeVerify.snaps, async () =>
      runSession(ctx, {
        step: 'review:verify',
        mode: 'review',
        role: 'review',
        promptName: 'review-verify',
        vars: (c) => ({
          ...common,
          findingsPaths: closing
            ? '(none: this is the closing round, and no dimension passes ran)'
            : findingsPaths.map((p) => `- ${p}`).join('\n'),
          scratchDir: verifyScratch,
          reviewers: reviewersLabel([...passes, c]),
        }),
        label: `${feature.id}: review r${round + 1} verify`,
        schema: loadSchema('review'),
      }),
    );
  } catch (e) {
    // A stopped round (no valid outcome, no agent) has no verdict: the change
    // document goes back to how the round found it. The unit file keeps the
    // escalation the stop wrote.
    if (e instanceof RunStoppedError) await restoreChangeDoc();
    throw e;
  }
  // Each restore is tried, and the quarantine runs, whatever an earlier one
  // threw: the round aborts with every failure named.
  const restoreErrors = [];
  if (!rv.ok) {
    for (const restore of [
      async () => restoreKeepingTokens(ctx.config.backlogRoot, feature.indexPath, featureBefore),
      restoreChangeDoc,
    ]) {
      try {
        await restore();
      } catch (e) {
        restoreErrors.push(`could not restore the verifier's edits: ${e.message}`);
      }
    }
  }
  const qv = quarantineReviewerChanges(ctx, `r${round + 1}-verify`, beforeVerify.snaps);
  if (qv.error) restoreErrors.push(qv.error);
  if (!rv.ok) restoreErrors.unshift(`the verifier failed: ${sessionError(rv)}`);
  if (restoreErrors.length > 0)
    return roundAborted(ctx, round, restoreErrors.join('; '), rv.ok ? null : sessionFailure(ctx, 'review:verify', rv));
  if (rv.configuration) passes.push({ session: 'review:verify', ...rv.configuration });
  // The independence of the sign-off, on record (F-64 D4): `bl status` reads it.
  const reviewedBy = reviewersLabel(passes);
  record(ctx, {
    step: 'review:round',
    round: round + 1,
    ok: true,
    reviewers: passes,
    note: `round ${round + 1} reviewed by ${reviewedBy}`,
  });
  ctx.runner.log(`  review round ${round + 1} reviewed by ${reviewedBy}`);

  ctx.state.reviewBaseSha = headSha(ctx);
  const covered = runScope(ctx);
  ctx.state.reviewedScope = {
    stories: covered.stories,
    repos: [...new Set([...covered.repos, ...reviewOtherRepos(ctx).map((r) => r.repoName)])],
  };
  saveRunState(config, ctx.state);
  // The verdict is the outcome's (F-68 D3): clean with no Must fix or Should
  // fix item open. bl records it in the unit's log (F-69 D5).
  const outcome = rv.structured;
  const clean = outcome.must + outcome.should === 0;
  const to = await recordVerdict(ctx, { clean, round: round + 1, summary: outcome.summary });
  // An escalation the outcome claims is one the operator reads: when the
  // verifier wrote none, bl writes it.
  if (outcome.escalated && !escalationOpen(feature.indexPath)) {
    await writeEscalation(
      ctx,
      `review round ${round + 1}: the verifier escalated`,
      `The verifier's outcome: ${outcome.summary}\n\nIt wrote no ## Escalation; the session block in ${changeRelPath(ctx)} has its findings.`,
    );
  }
  return { clean, to, round: round + 1, summary: outcome.summary };
}

/**
 * A failed container cleanup or an unavailable agent unwinds past the
 * caller's quarantine; move the reviewer's changes aside anyway so the
 * escalated run does not inherit them.
 */
async function quarantineOnCleanupError(ctx, label, snaps, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RunStoppedError) quarantineReviewerChanges(ctx, label, snaps);
    throw e;
  }
}

/**
 * A review round stopped before its verdict: a worktree lock was held
 * elsewhere, a worktree could not be snapshotted or put back (the next pass,
 * or the test gate, would inherit and be blamed for whatever is left), or a
 * session failed. `failure` is that session's `sessionFailure` (S-1140),
 * kept as `abortFailure` for the escalation; null for every other abort.
 */
function roundAborted(ctx, round, error, failure = null) {
  record(ctx, { step: 'review:abort', ok: false, note: error });
  return { round, expected: round + 1, abortError: error, abortFailure: failure };
}

/**
 * An abort's reason and details with its session failure (S-1140): the
 * reason ends with the cause line, and the details end with the failure's
 * text. Without a failure (a lock held, a snapshot failed) both stay as given.
 */
function withFailure(reason, details, failure) {
  if (!failure) return { reason, details };
  return {
    reason: `${reason} — ${failure.causeLine}`,
    details: [details, failure.text].filter(Boolean).join('\n\n'),
  };
}

export function sessionError(r) {
  return (
    r.error ||
    cleanStderrLine(
      String(r.output ?? '')
        .trim()
        .split('\n')
        .pop(),
    ) ||
    'agent reported an error'
  );
}

function openItemsSummary(ctx) {
  const { body } = readChangeText(ctx);
  const log = extractReviewLog(body);
  const latest = log ? parseLatestSession(log) : null;
  if (!latest) return '';
  const block = log.match(/^###[ \t]+Session[^\n]*\n([\s\S]*?)(?=^###[ \t]+Session\b|$(?![\s\S]))/m)?.[1] ?? '';
  // The claim only: the Review Log keeps each item's Repro, Test and Class tail.
  // An item that is nothing but a tail is shown whole rather than as a bare box.
  const items = openCheckboxItems(block).map((i) => {
    const whole = [i.text, ...i.lines].join(' ');
    const claim = whole.split(/ — Repro:|\bClass:/)[0].trim();
    // A `→` note naming a commit on an unticked item is likely a missed tick (S-1292).
    const sha = resolutionCommit(i);
    const flag = sha ? ` (has a resolution note naming ${sha}, but its box is unticked: possible oversight)` : '';
    return `- [ ] ${wrapItem(`${claim || whole}${flag}`)}`;
  });
  return items.length ? `Open items from session ${latest.date}:\n\n${items.join('\n')}` : '';
}

/**
 * `claim` wrapped at word boundaries to fit `width` columns under a `- [ ] `
 * marker, continuation lines indented six spaces. A single token longer than
 * the width stays on a line of its own.
 */
function wrapItem(claim, width = 100) {
  const indent = '      ';
  const limit = width - indent.length;
  const lines = [];
  let line = '';
  for (const word of claim.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > limit) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

// ---------------------------------------------------------------------------
// Integration before the merge into main (F-36 D4)
// ---------------------------------------------------------------------------

/**
 * `bl merge`'s integration (F-36 D4): bring the unit's branch up to date with
 * main in each of its worktrees, before any main checkout is touched, so the
 * merge into main that follows cannot conflict.
 *
 * Under the unit's run lock (never beside a `bl run` of the unit), and
 * refusing when any worktree has uncommitted changes (every one is checked
 * before any merge starts). Per repo, in `gateTargets` order (the lead, then
 * the feature's repo order): fetch `origin/main` by `MAIN_REFSPEC` (local
 * `main` without an origin), then `git merge --no-edit <ref>` in the
 * worktree. Each repo ends `current`, `merged` or `conflicted`.
 *
 * A conflicted repo the `regenerate` stage leaves conflicted, and a red test
 * gate after clean merges, go to one resolution session (F-36 D6,
 * `resolveIntegration`), then the gate with its fix step and one review round
 * over the resolution (D7). A green tree is pushed. A stop rolls back the
 * merges this call made, so every branch is left as it was reviewed and a
 * rerun integrates (and gates) again; only a resolution whose review left
 * open items stays on the branch, with the unit in `fixing` (F-69 D5).
 *
 * `prep` is the shape `bl review` builds: `{ cfg, worktreePath, branchName,
 * baseVars, targetRepoName, otherWorktrees }`.
 *
 * @returns {{ ok: boolean, refused?: boolean, escalated?: boolean, reason?: string,
 *   repos: Array<{ repoName: string, worktreePath: string, ref: string,
 *   state: "current"|"merged"|"conflicted", conflicted: string[],
 *   resolved?: string[] }> }} — `resolved`: the files the agent resolved
 */
export async function integrateUnit({ unit, config, prep, runner }) {
  const lock = takeRunLocks(config, unit, `merge ${unit.id}`);
  if (lock.refused != null) return { ok: false, refused: true, reason: lock.refused, repos: [] };
  try {
    let state;
    try {
      state = loadRunState(config, unit.id);
    } catch (e) {
      return { ok: false, refused: true, reason: `${e.message} — fix it, or delete it`, repos: [] };
    }
    state ??= newRunState(unit, {
      branch: prep.branchName,
      worktreePath: prep.worktreePath,
      maxRounds: unit.reviewRoundsMax,
    });
    const ctx = { feature: unit, config, prep, runner, state, resumeHint: `bl merge ${unit.id}`, repos: [] };
    clearUntimedOut(ctx);
    try {
      await reapStaleScopes(ctx);
      return await integrateLocked(ctx);
    } catch (e) {
      return await integrationThrew(ctx, e);
    }
  } finally {
    lock.release();
  }
}

/**
 * Whatever stops the integration by throwing (a session that could not run, a
 * failed container cleanup, a failed run-state write, a bug) leaves no
 * worktree mid-merge, still under the run lock: every merge in progress is
 * aborted and the merges are rolled back. A `RunStoppedError` has stopped
 * the run already, escalated or failed (a log write that failed writes no
 * ## Escalation); any other error escalates as a merge here (F-36 D8), with the
 * conflict evidence read before the abort: what the resolution recorded
 * (`ctx.integrationEvidence`), else each repo still mid-merge.
 */
async function integrationThrew(ctx, e) {
  ctx.integration = null;
  const evidence = e instanceof RunStoppedError ? '' : integrationEvidence(ctx);
  const stuck = ctx.repos.filter((r) => !abortIntegration(ctx, r.worktreePath));
  const rolledBack = rollBackNote(ctx, ctx.repos);
  if (e instanceof RunStoppedError) {
    return { ok: false, escalated: e.state?.status === 'escalated', reason: e.message, repos: ctx.repos };
  }
  ctx.runner.log(`  ${e.stack ?? e}`);
  const reason = `merge with main: stopped by an error: ${e.message}`;
  const details = [evidence, abortNote(stuck).trim(), rolledBack, integrationNextStep(ctx, ctx.repos)]
    .filter(Boolean)
    .join('\n\n');
  try {
    await escalateIntegration(ctx, reason, details, { save: true });
  } catch (w) {
    ctx.runner.log(`  warning: the escalation could not be written: ${w.message}\n\n${details}`);
  }
  return { ok: false, escalated: true, reason, repos: ctx.repos };
}

/** The conflict evidence of an integration stopped by an error; never throws. */
function integrationEvidence(ctx) {
  if (ctx.integrationEvidence) return ctx.integrationEvidence;
  return ctx.repos
    .filter((r) => r.state === 'conflicted')
    .map((r) => {
      try {
        return conflictBlock(ctx, r);
      } catch (x) {
        return `- ${r.repoName} (worktree ${r.worktreePath}), merging ${r.ref}: conflicted ${r.conflicted.map((f) => `\`${f}\``).join(', ') || '(unknown files)'}; its commits could not be read: ${x.message}`;
      }
    })
    .join('\n\n');
}

async function integrateLocked(ctx) {
  const { runner } = ctx;
  const targets = gateTargets(ctx);
  for (const t of targets) {
    const dirty = worktreeChanges(ctx, t.worktreePath);
    if (dirty == null) {
      return {
        ok: false,
        refused: true,
        reason: `${t.repo}: git status failed in ${t.worktreePath}, so the worktree cannot be shown clean`,
        repos: [],
      };
    }
    if (dirty.length > 0) {
      const list = dirty.map((c) => `  ${c.code} ${c.path}`).join('\n');
      return {
        ok: false,
        refused: true,
        reason: `${t.repo}: worktree ${t.worktreePath} has uncommitted changes — commit or discard them first:\n${list}`,
        repos: [],
      };
    }
  }

  const repos = ctx.repos;
  for (const t of targets) {
    const ref = await integrationRef(ctx, t);
    const entry = { repoName: t.repo, worktreePath: t.worktreePath, ref, state: 'current', conflicted: [] };
    repos.push(entry);
    // Every repo's start, current ones too: a resolution or fix session may
    // commit in any of them, and what it commits is reviewed, pushed or rolled
    // back like the merges.
    entry.before = headOf(ctx, entry);
    // An earlier integration whose roll back failed left what it committed on
    // the branch, untested: it counts as this call's merge, gated before it
    // can land and rolled back to where that integration began. What a
    // resolution session left there (`review`) is also checked and reviewed.
    const retained = ctx.state.integrationRetained?.[t.repo];
    if (retained && retained.before !== entry.before) {
      entry.before = retained.before;
      entry.state = 'merged';
      if (retained.review) {
        entry.review = true;
        entry.resolved = retained.resolved ?? [];
      }
      runner.log(
        `  ${t.repo}: an earlier integration's commits are still on the branch, untested — they are ${retained.review ? 'checked, gated and reviewed' : 'gated'} again`,
      );
    }
    const behind = runner.shell(`git rev-list --count HEAD..${ref}`, t.worktreePath);
    const count = behind.status === 0 ? parseInt(String(behind.output).trim(), 10) : NaN;
    if (!Number.isInteger(count)) {
      const rolledBack = rollBackNote(ctx, repos);
      return {
        ok: false,
        refused: true,
        reason: `${t.repo}: cannot compare the branch with ${ref} in ${t.worktreePath}: ${String(behind.output ?? '').trim()}\n${rolledBack}`,
        repos,
      };
    }
    if (count === 0) {
      runner.log(`  ${t.repo}: current with ${ref}`);
      continue;
    }
    // A branch with no commits of its own (a repo prepared up front that no
    // story changed) has nothing to integrate: the merge skips it.
    const own = runner.shell(`git rev-list --count ${ref}..HEAD`, t.worktreePath);
    if (own.status === 0 && String(own.output).trim() === '0') {
      runner.log(`  ${t.repo}: no commits of its own — nothing to integrate`);
      continue;
    }
    const merge = runner.shell(`git merge --no-edit ${ref}`, t.worktreePath);
    if (merge.status === 0) {
      entry.state = 'merged';
      runner.log(`  ${t.repo}: merged ${count} commit${count === 1 ? '' : 's'} from ${ref}`);
      continue;
    }
    entry.state = 'conflicted';
    const u = runner.shell('git diff --name-only -z --diff-filter=U', t.worktreePath);
    entry.conflicted = u.status === 0 ? String(u.output).split('\0').filter(Boolean) : [];
    entry.mergeOutput = tail(merge.output, 10).trim();
    runner.log(
      `  ${t.repo}: conflicts with ${ref}${entry.conflicted.length ? ` in ${entry.conflicted.join(', ')}` : ''}`,
    );
    regenerateRepo(ctx, t, entry);
  }

  const conflicts = repos.filter((r) => r.state === 'conflicted');
  // A merge that failed with no conflicted file (git refused to start it, or
  // the regenerated merge could not be committed) has nothing to resolve.
  if (conflicts.some((r) => r.conflicted.length === 0)) return stopOnConflicts(ctx, repos, conflicts);
  if (conflicts.length > 0) return resolveIntegration(ctx, repos, { conflicts, gate: null });
  // A resolution an earlier roll back left owes its checks, gate and review.
  if (repos.some((r) => r.review)) return resolveIntegration(ctx, repos, { conflicts: [], gate: null });

  const merged = repos.filter((r) => r.state === 'merged');
  if (merged.length === 0) return pushIntegrated(ctx, repos);

  runner.log('  test gate on the integrated tree...');
  // A stop inside the gate (a failed container cleanup) escalates as a merge
  // and rolls the merges back (`integrationThrew`), so the rerun gates again.
  ctx.integration = { details: () => `${rollBackNote(ctx, repos)}\n\n${integrationNextStep(ctx, merged)}` };
  runner.title?.({ status: 'test gate' });
  const gate = await runTestGate(ctx);
  ctx.integration = null;
  if (gate.ok) return pushIntegrated(ctx, repos);
  if (gate.config) {
    const rolledBack = rollBackNote(ctx, repos);
    const reason = `merge with main: the test gate is misconfigured`;
    await escalateIntegration(ctx, reason, `${gate.reason}\n\n${rolledBack}\n\n${integrationNextStep(ctx, merged)}`);
    return { ok: false, escalated: true, reason, repos };
  }
  return resolveIntegration(ctx, repos, { conflicts: [], gate });
}

/** Abort every conflicted merge, roll back the rest and escalate (F-36 D8). */
async function stopOnConflicts(ctx, repos, conflicts) {
  const blocks = conflicts.map((r) => conflictBlock(ctx, r));
  ctx.integrationEvidence = blocks.join('\n\n');
  const stuck = conflicts.filter((r) => !abortIntegration(ctx, r.worktreePath));
  const rolledBack = rollBackNote(ctx, repos);
  const reason = `merge with main: ${conflicts.map((r) => r.repoName).join(', ')} conflict${conflicts.length === 1 ? 's' : ''} with main`;
  await escalateIntegration(
    ctx,
    reason,
    `${blocks.join('\n\n')}${abortNote(stuck)}\n\n${rolledBack}\n\n${integrationNextStep(ctx, conflicts)}`,
  );
  return { ok: false, escalated: true, reason, repos };
}

function abortNote(stuck) {
  return stuck.length
    ? `\n\nThe merge could not be aborted in ${stuck.map((r) => `${r.repoName}: run \`git -C ${shq(r.worktreePath)} merge --abort\``).join('; ')}.`
    : '';
}

/**
 * The resolution (F-36 D6, D7): one `merge-resolve` session for the unit, in
 * the lead worktree, over every repo still mid-merge (`conflicts`) or, when
 * the gate was red after clean merges (`gate`), every merged repo. Then bl
 * checks each repo: no `MERGE_HEAD`, no unmerged index entry, the ref merged
 * and no conflict marker left in the merge commit's conflicted files. A
 * failure aborts and rolls everything back and escalates. Otherwise the test
 * gate runs with its fix step, and one review round over the resolution
 * (`resolutionScope`): `addressed` pushes, `pending` escalates and keeps the
 * resolution on the branch, anything else rolls it back and escalates.
 *
 * A resolution an earlier roll back left on the branch (`review` on its
 * repos, from the run state) goes through the same checks, gate and review:
 * with no conflict and no red gate, without a session.
 */
async function resolveIntegration(ctx, repos, { conflicts, gate }) {
  const { runner, feature: unit } = ctx;
  const cfg = ctx.prep.cfg ?? ctx.config;
  const owed = repos.filter((r) => r.review);
  const session = conflicts.length > 0 || Boolean(gate);
  const work = conflicts.length > 0 ? conflicts : gate ? repos.filter((r) => r.state === 'merged') : owed;
  const names = work.map((r) => r.repoName).join(', ');
  const what = !session
    ? `an earlier resolution in ${names}, left on the branch by a failed roll back, is unreviewed`
    : gate
      ? `the test gate failed after merging main into ${names}`
      : `${names} conflict${work.length === 1 ? 's' : ''} with main`;
  const checked = [...work, ...owed.filter((r) => !work.includes(r))];
  const blocks = checked.map((r) =>
    r.state === 'conflicted'
      ? conflictBlock(ctx, r)
      : r.review
        ? `- ${r.repoName} (worktree ${r.worktreePath}), an earlier resolution of the merge of ${r.ref}, left on the branch by a failed roll back${r.resolved?.length ? `; it resolved ${r.resolved.map((f) => `\`${f}\``).join(', ')}` : ''}`
        : `- ${r.repoName} (worktree ${r.worktreePath}), merged ${r.ref} with no conflict`,
  );
  // Read while the merges are in progress: an error later in the resolution
  // or its review escalates with it (`integrationThrew`).
  ctx.integrationEvidence = [blocks.join('\n\n'), gate ? gateDetails(gate) : ''].filter(Boolean).join('\n\n');
  for (const r of repos) r.integrated = r.state === 'conflicted' ? null : headOf(ctx, r);
  // Rolls back, then says what happened; a stop inside a session (`finish`)
  // calls it before it writes the escalation.
  const rolledBack = () => `${rollBackNote(ctx, repos)}\n\n${integrationNextStep(ctx, work)}`;
  ctx.integration = { details: () => `${blocks.join('\n\n')}\n\n${rolledBack()}` };
  try {
    // What any session commits from here, in any repo, is owed a review: a
    // failed roll back keeps that in the run state (`rollBackMerges`).
    if (session) for (const e of repos) e.review = true;
    runner.log(`  ${session ? 'resolution agent' : 'checks'}: ${what}...`);
    setStep(ctx, 'merge-resolve');
    const r = !session
      ? { ok: true, structured: null }
      : await runSession(ctx, {
          step: 'merge-resolve',
          mode: 'workon',
          promptName: 'merge-resolve',
          vars: {
            mergeRepos: blocks.join('\n\n'),
            gateFailure: gate ? `## The test gate failed on the merged tree\n\n${gateDetails(gate)}` : '',
            scratchDir: scratchFor(ctx, 'merge-resolve'),
          },
          label: `${unit.id}: resolve the merge with main`,
          schema: loadSchema('merge-resolve'),
        });
    const problems = checked.flatMap((e) => resolutionProblems(ctx, e));
    // The agent may change plan.yaml (`_execution-inputs.md`); `bl merge` commits it.
    try {
      readPlan(dirname(unit.indexPath), unit.id);
    } catch (e) {
      problems.push(e.message);
    }
    let failure = null;
    if (escalationOpen(unit.indexPath)) problems.unshift('the agent wrote an escalation');
    else if (!r.ok || r.isError) {
      problems.unshift(`the session failed: ${sessionError(r)}`);
      failure = sessionFailure(ctx, 'merge-resolve', r);
    } else if (r.structured?.resolved === false)
      problems.unshift(`the agent did not resolve it: ${r.structured.reason ?? '(no reason given)'}`);
    if (problems.length > 0) {
      const stuck = work.filter((e) => !abortIntegration(ctx, e.worktreePath));
      const left = agentCommits(ctx, repos);
      const restored = rolledBack();
      const { reason, details } = withFailure(
        `merge with main: ${what}, and ${session ? 'the resolution agent did not resolve it' : 'it fails the resolution checks'}`,
        [
          blocks.join('\n\n'),
          gate ? gateDetails(gate) : '',
          `After the session:\n\n${problems.map((p) => `- ${p}`).join('\n')}`,
          r.structured ? `The agent's outcome: ${r.structured.summary}` : '',
          `${abortNote(stuck).trim()}${left}`.trim(),
          restored,
        ]
          .filter(Boolean)
          .join('\n\n'),
        failure,
      );
      await escalateIntegration(ctx, reason, details, { save: true });
      return { ok: false, escalated: true, reason, repos };
    }
    for (const e of work) {
      e.resolved = [...new Set([...(e.state === 'conflicted' ? e.conflicted : []), ...(e.resolved ?? [])])];
      e.state = 'merged';
    }

    // The gate's fix step is a session too: what it commits, in any repo, is
    // owed a review, also when no resolution session ran.
    for (const e of repos) e.review = true;
    setStep(ctx, 'test');
    if (!(await testGateWithFix(ctx))) {
      rollBackMerges(ctx, repos);
      return { ok: false, escalated: true, reason: ctx.state.lastError, repos };
    }

    // A repo with no merge of its own (current with main) is in scope when a
    // session committed in it, now or in the resolution a failed roll back
    // left: its diff starts where that integration did (`before`).
    const scoped = repos.filter((e) => checked.includes(e) || headOf(ctx, e) !== e.integrated);
    const scope = scoped.map((e) => {
      const merge = e.state === 'merged' ? mergeCommit(ctx, e) : null;
      return { repoName: e.repoName, worktreePath: e.worktreePath, ref: e.ref, merge, base: merge ?? e.before };
    });
    const files = scoped.flatMap((e, i) => {
      const after = runner.shell(`git diff --name-only ${scope[i].base}..HEAD`, e.worktreePath);
      const later = after.status === 0 ? String(after.output).split('\n').filter(Boolean) : [];
      return [...new Set([...(e.resolved ?? []), ...later])].map((f) =>
        scoped.length === 1 ? f : `${e.repoName}: ${f}`,
      );
    });
    runner.log('  review of the resolution...');
    const result = await reviewRound(ctx, { reReview: false, scope: { text: resolutionScope(scope), files } });
    const verdict = result.abortError ? null : result.clean;
    if (verdict === true && !escalationOpen(unit.indexPath)) {
      ctx.integration = null;
      return pushIntegrated(ctx, repos);
    }
    if (verdict === false) {
      // Outside the round cap, so `bl run --resume` owes it a fix whatever the cap.
      ctx.state.integrationReview = result.round;
      // The resume's loop gates and reviews it now; `fixing` blocks the merge.
      setRetained(ctx, {});
      const reason = 'merge with main: the review of the resolution left open items';
      const next = `Next: the resolution stays on the branch, and ${unit.id} is in fixing. Clear this section to "None.", run \`bl run ${unit.id} --resume\` (it fixes the open items through the ordinary loop), then \`bl merge ${unit.id}\`, which integrates again.`;
      await escalateIntegration(
        ctx,
        reason,
        [blocks.join('\n\n'), openItemsSummary(ctx), next].filter(Boolean).join('\n\n'),
        { save: true },
      );
      return { ok: false, escalated: true, reason, repos };
    }
    const restored = rolledBack();
    const why = result.abortError
      ? `was aborted before a verdict: ${result.abortError}`
      : 'ended addressed, but an escalation was written during it';
    const { reason, details } = withFailure(
      `merge with main: the review of the resolution ${why}`,
      `${blocks.join('\n\n')}\n\n${restored}`,
      result.abortFailure,
    );
    await escalateIntegration(ctx, reason, details, { save: true });
    return { ok: false, escalated: true, reason, repos };
  } finally {
    ctx.integration = null;
  }
}

/** Why a repo the resolution agent worked on cannot land; empty when it can. */
function resolutionProblems(ctx, e) {
  const { runner } = ctx;
  const wt = e.worktreePath;
  const out = [];
  if (runner.shell('git rev-parse -q --verify MERGE_HEAD', wt).status === 0)
    out.push(`${e.repoName}: the merge is still in progress`);
  const u = runner.shell('git ls-files -u', wt);
  if (u.status !== 0 || String(u.output).trim()) out.push(`${e.repoName}: the index still has unmerged entries`);
  if (runner.shell(`git merge-base --is-ancestor ${e.ref} HEAD`, wt).status !== 0) {
    out.push(`${e.repoName}: the branch does not contain ${e.ref} (the merge was not committed)`);
  } else {
    // A resolution a failed roll back left (`resolved`) is checked as well,
    // in each merge since `before`: a fresh merge may sit on top of it.
    const files = [...new Set([...(e.state === 'conflicted' ? e.conflicted : []), ...(e.resolved ?? [])])];
    const m = e.before ? runner.shell(`git rev-list --merges --first-parent ${e.before}..HEAD`, wt) : null;
    const merges = m?.status === 0 ? String(m.output).split('\n').filter(Boolean) : [];
    for (const merge of files.length > 0 ? (merges.length > 0 ? merges : ['HEAD']) : []) {
      const g = runner.shell(`git grep -nE '^(<{7}|>{7})( |$)' ${merge} -- ${files.map(shq).join(' ')}`, wt);
      if (g.status !== 0) continue;
      out.push(`${e.repoName}: conflict markers left in the merge commit:\n\n${fenced(tail(g.output, 10).trim())}`);
      break;
    }
  }
  return out;
}

/** The merge with main this integration made: the oldest merge on HEAD's first-parent line since `before`. */
function mergeCommit(ctx, e) {
  if (!e.before) return null;
  const r = ctx.runner.shell(`git rev-list --reverse --merges --first-parent ${e.before}..HEAD`, e.worktreePath);
  return r.status === 0 ? String(r.output).trim().split('\n')[0] || null : null;
}

function headOf(ctx, e) {
  const r = ctx.runner.shell('git rev-parse HEAD', e.worktreePath);
  return r.status === 0 ? String(r.output).trim() : null;
}

/** Where the commits an agent made before its resolution was rolled back are kept. */
function agentCommits(ctx, work) {
  const moved = work.filter((e) => e.before && headOf(ctx, e) !== e.before && headOf(ctx, e) !== e.integrated);
  if (moved.length === 0) return '';
  return `\n\nThe agent's commits are kept in each reflog: ${moved.map((e) => `${e.repoName}: \`git -C ${shq(e.worktreePath)} reset --keep ${headOf(ctx, e)}\` restores them`).join('; ')}.`;
}

/**
 * The scope of the review round over a merge resolution (F-36 D7): per repo,
 * the merge's `git show --remerge-diff` (what the resolution changed against
 * git's own merge) and the commits after it; for a repo with no merge (`merge`
 * null: it was current with main), the commits the resolution made there,
 * from `base`. `repos` is `[{ repoName, worktreePath, ref, merge, base? }]`.
 */
export function resolutionScope(repos) {
  const lines = repos.map((r) =>
    r.merge
      ? [
          `- ${r.repoName} (worktree ${r.worktreePath}), the merge of ${r.ref} into the branch:`,
          `  - \`git -C ${shq(r.worktreePath)} show --remerge-diff ${r.merge}\`: the resolution, as it differs from git's own merge`,
          `  - \`git -C ${shq(r.worktreePath)} diff ${r.merge}..HEAD\`: the commits after the merge`,
        ].join('\n')
      : [
          `- ${r.repoName} (worktree ${r.worktreePath}), already current with ${r.ref}, changed by the resolution:`,
          `  - \`git -C ${shq(r.worktreePath)} diff ${r.base}..HEAD\`: the commits the resolution made`,
        ].join('\n'),
  );
  return [
    "Only the resolution of the merge with main that `bl merge` made, not the branch's own work, which earlier rounds reviewed. Per repo:",
    ...lines,
    'Check that each resolution keeps what both sides meant and that the commits after it are correct. Code neither diff touches is out of scope.',
  ].join('\n');
}

/**
 * Push each branch its origin does not have as it is here, so its PR shows
 * what merges: one this integration merged or committed on, and one an
 * earlier integration left unpushed (a rejected push keeps the merge, and the
 * rerun finds the branch current). A branch its origin already contains, and
 * one never pushed that this call did not change, are left as they are.
 */
function pushIntegrated(ctx, repos) {
  const { runner, feature: unit } = ctx;
  // The gate passed: nothing an earlier roll back left is untested now.
  setRetained(ctx, {});
  for (const r of repos) {
    if (runner.shell('git remote get-url origin', r.worktreePath).status !== 0) continue;
    const head = headOf(ctx, r);
    const tracked = runner.shell(
      `git rev-parse -q --verify refs/remotes/origin/${ctx.prep.branchName}`,
      r.worktreePath,
    );
    const published = tracked.status === 0 ? String(tracked.output).trim() : null;
    if (
      published == null
        ? head === r.before
        : runner.shell(`git merge-base --is-ancestor HEAD ${published}`, r.worktreePath).status === 0
    )
      continue;
    const pushStartedAt = runnerNow(runner).getTime();
    runner.title?.({ status: PUSH_STATUS });
    const push = runner.shell('git push origin HEAD', r.worktreePath);
    if (push.status !== 0) {
      const escalation = pushEscalation({
        repo: r.repoName,
        branch: ctx.prep.branchName,
        worktreePath: r.worktreePath,
        push,
        gate: gateRecord({ runner, worktreePath: r.worktreePath, pushStartedAt }),
        next: `\`bl merge ${unit.id}\``,
      });
      return {
        ok: false,
        reason: `${r.repoName}: git push origin HEAD failed after a green gate (the merge is kept on the branch; rerun \`bl merge ${unit.id}\`):\n\n${escalation}`,
        repos,
      };
    }
    runner.log(`  ${r.repoName}: pushed the integrated branch`);
  }
  return { ok: true, repos };
}

/**
 * The `regenerate` stage (F-36 D5) on a conflicted repo: its generated files
 * are taken from the branch side and regenerated by the repo's active
 * `regenerate` plugins. With no conflict left, bl commits the merge and the
 * repo counts as `merged` (gated, pushed and, on a stop, rolled back like a
 * clean merge); a regeneration is not re-reviewed. Otherwise the repo stays
 * `conflicted` with only the files still to merge by hand, and `regenerated`
 * and `regenerateFailed` say what the stage did.
 */
function regenerateRepo(ctx, t, entry) {
  const { runner, feature: unit } = ctx;
  if (entry.conflicted.length === 0) return;
  const plugins = regeneratePlugins(t.cfg, unit.indexPath, unit.componentEntry);
  if (plugins.length === 0) return;
  const r = regenerateConflicts({
    worktreePath: t.worktreePath,
    conflicted: entry.conflicted,
    plugins,
    shell: (cmd, cwd) => runner.shell(cmd, cwd),
    log: (m) => runner.log(`  ${t.repo}:${m.replace(/^ +/, ' ')}`),
  });
  entry.regenerated = r.regenerated.flatMap((g) => g.paths);
  entry.regenerateFailed = r.failed;
  entry.conflicted = r.remaining;
  if (r.remaining.length > 0 || r.regenerated.length === 0) return;
  const commit = runner.shell('git commit -q --no-edit', t.worktreePath);
  if (commit.status !== 0) {
    entry.mergeOutput = `git commit --no-edit failed after regenerating ${entry.regenerated.join(', ')}:\n${tail(commit.output, 10).trim()}`;
    return;
  }
  entry.state = 'merged';
  runner.log(`  ${t.repo}: regenerated ${entry.regenerated.join(', ')} and committed the merge with ${entry.ref}`);
}

/**
 * The ref a repo's branch is brought up to date with: `origin/main`, freshly
 * fetched by `MAIN_REFSPEC` under the repo's main sync lock, else local `main`
 * when there is no origin. A failed fetch is a warning and the last fetched
 * `origin/main` is used, as `syncBranchWithMain` falls back.
 */
async function integrationRef(ctx, t) {
  const { runner } = ctx;
  if (runner.shell('git remote get-url origin', t.worktreePath).status !== 0) return 'main';
  const fetch = await withMainSyncLock(t.worktreePath, () =>
    runner.shell(`git fetch origin ${MAIN_REFSPEC}`, t.worktreePath),
  );
  if (fetch?.state === 'lock-timeout') {
    runner.log(
      `  warning: ${t.repo}: timed out waiting for the main sync lock (PID ${fetch.holder}); using the last fetched origin/main`,
    );
  } else if (fetch.status !== 0) {
    runner.log(
      `  warning: ${t.repo}: fetch of origin/main failed; using the last fetched origin/main: ${tail(fetch.output, 3).trim()}`,
    );
  }
  return runner.shell('git rev-parse -q --verify origin/main', t.worktreePath).status === 0 ? 'origin/main' : 'main';
}

/**
 * One conflicted repo as the escalation names it: its worktree, the ref
 * merged, and each conflicted file with both sides' commits since the merge
 * base (F-36 D8). Read while the merge is in progress.
 */
function conflictBlock(ctx, r) {
  const { runner } = ctx;
  const base = runner.shell(`git merge-base HEAD ${r.ref}`, r.worktreePath);
  const mb = base.status === 0 ? String(base.output).trim().split('\n')[0] : null;
  const log = (range, f) => {
    if (!mb) return [];
    const out = runner.shell(`git log --format='%h %s' ${range} -- ${shq(f)}`, r.worktreePath);
    return out.status === 0 ? String(out.output).split('\n').filter(Boolean) : [];
  };
  const files = r.conflicted.map((f) => {
    const main = log(`${mb}..${r.ref}`, f);
    const branch = log(`${mb}..HEAD`, f);
    return [
      `  - \`${f}\``,
      ...(main.length ? main.map((l) => `    - main: ${l}`) : ['    - main: (no commit found)']),
      ...(branch.length ? branch.map((l) => `    - branch: ${l}`) : ['    - branch: (no commit found)']),
    ].join('\n');
  });
  const head = `- ${r.repoName} (worktree ${r.worktreePath}), merging ${r.ref}:`;
  const regen = [
    ...(r.regenerated?.length
      ? [`  - regenerated (not to be hand-merged): ${r.regenerated.map((f) => `\`${f}\``).join(', ')}`]
      : []),
    ...(r.regenerateFailed ?? []).map(
      (x) =>
        `  - regenerate plugin ${x.name} failed (\`${x.command}\`), so ${x.paths.map((f) => `\`${f}\``).join(', ')} stayed conflicted:\n\n${fenced(x.output).replace(/^(?=.)/gm, '    ')}`,
    ),
  ];
  if (files.length) return [head, ...files, ...regen].join('\n');
  return `${head} git merge failed with no conflicted file:\n\n${fenced(r.mergeOutput)}`;
}

/** Abort the merge in progress in `worktreePath`; true when none is left. */
function abortIntegration(ctx, worktreePath) {
  const { runner } = ctx;
  const inMerge = () => runner.shell('git rev-parse -q --verify MERGE_HEAD', worktreePath).status === 0;
  if (inMerge()) runner.shell('git merge --abort', worktreePath);
  return !inMerge();
}

/**
 * Undo the merges and the commits this integration made, in every repo it
 * started in, current ones too (`git reset --keep` to each repo's start), so a
 * stopped integration leaves every branch as it was reviewed and the next
 * `bl merge` integrates and gates it again.
 */
function rollBackMerges(ctx, repos) {
  const failed = [];
  const retained = { ...(ctx.state.integrationRetained ?? {}) };
  for (const r of repos) {
    if (!r.before) continue;
    if (headOf(ctx, r) !== r.before) {
      const reset = ctx.runner.shell(`git reset -q --keep ${r.before}`, r.worktreePath);
      if (reset.status !== 0) {
        const output = tail(reset.output, 3).trim();
        ctx.runner.log(`  warning: ${r.repoName}: could not roll back the merge of ${r.ref} (${output})`);
        failed.push({ ...r, output });
        // A session's commits keep their review obligation and the files the
        // resolution was to merge, for the next integration's checks.
        const resolved = r.resolved ?? (r.state === 'conflicted' ? r.conflicted : []);
        retained[r.repoName] = r.review ? { before: r.before, review: true, resolved } : { before: r.before };
        continue;
      }
    }
    delete retained[r.repoName];
  }
  setRetained(ctx, retained);
  return failed;
}

/**
 * Record in the run state, which outlives this call, the repos whose roll
 * back failed (`{ [repoName]: { before, review?, resolved? } }`: the commit
 * it began at, and whether a resolution session ran, with the files it was to
 * merge): the next integration gates what is left there, and checks and
 * reviews a session's work, before it can land.
 */
function setRetained(ctx, retained) {
  const before = ctx.state.integrationRetained ?? {};
  if (JSON.stringify(before) === JSON.stringify(retained)) return;
  if (Object.keys(retained).length) ctx.state.integrationRetained = retained;
  else delete ctx.state.integrationRetained;
  saveRunState(ctx.config, ctx.state);
}

/**
 * Abort every merge in progress and roll the merges back; what the escalation
 * says about it, true to what happened.
 */
function rollBackNote(ctx, repos) {
  for (const r of repos) abortIntegration(ctx, r.worktreePath);
  const failed = rollBackMerges(ctx, repos);
  if (failed.length === 0) return 'The merges were rolled back; each branch is as it was reviewed.';
  const where = failed.map(
    (r) => `${r.repoName} (\`git -C ${shq(r.worktreePath)} reset --keep ${r.before}\`: ${r.output || 'failed'})`,
  );
  return `The roll back failed in ${where.join('; ')}. What the integration committed there is still on the branch, untested: the next \`bl merge ${ctx.feature.id}\` gates it before it can land.`;
}

/** The next step an integration escalation names (D8). */
function integrationNextStep(ctx, repos) {
  const id = ctx.feature.id;
  const where = repos.map((r) => `\`git -C ${shq(r.worktreePath)} merge ${r.ref}\``).join(', ');
  return `Next: resolve it by hand in the worktree (${where}, then fix and commit), clear this section to "None.", and rerun \`bl merge ${id}\`.`;
}

/**
 * `save` records the stop in the run state, as `finish` does, for an
 * integration whose sessions have written to it.
 */
async function escalateIntegration(ctx, reason, details, { save = false } = {}) {
  await writeEscalation(ctx, reason, details, { fold: true });
  if (save) {
    ctx.state.status = 'escalated';
    ctx.state.lastError = reason;
    saveRunState(ctx.config, ctx.state);
  }
  finalTitle(ctx, 'escalated');
  ctx.runner.log(`\n${ctx.feature.id} escalated — ${reason}`);
  ctx.runner.log(`See ## Escalation in ${ctx.feature.featureRelPath}.`);
}

/**
 * One review round outside the loop — `bl review`. The same two
 * dimension passes, findings files, verifier, and run state as the loop's
 * review step, so there is one review path per feature and a later
 * `run --resume` re-reviews from the base this round recorded. Refuses while
 * a run holds the feature, and at the round cap. Returns
 * `{ status, round, verdict, escalated, error, end }` (`status` the unit's
 * after the round, `end` from `reviewEnd`, `null`
 * for a round that did not finish: `error` set and no escalation) or a
 * refusal. A round a session failure aborted also returns `details`, the
 * failure's step, configuration, cause and steps (S-1140), and its `error`
 * ends with the cause line.
 *
 * `prep` and `pr` are the lead repo's (the PR the run state keeps);
 * `otherRepos` (`[{ repoName, worktreePath, pr: { number, url } }]`) are the
 * feature's PRs in other repos, reviewed in the same round.
 */
export async function reviewFeature({
  feature,
  config,
  prep: basePrep,
  runner,
  pr = null,
  otherRepos = [],
  maxRounds,
}) {
  const prep = { ...basePrep, otherRepos };
  const lock = takeRunLocks(config, feature, `review ${feature.id}`);
  if (lock.refused != null) return refuse(runner, feature, lock.refused);
  try {
    let state;
    try {
      state = loadRunState(config, feature.id);
    } catch (e) {
      return refuse(runner, feature, `${e.message} — fix it, or delete it`);
    }
    state ??= newRunState(feature, { branch: prep.branchName, worktreePath: prep.worktreePath, maxRounds });
    state.maxRounds = maxRounds;
    if (pr?.number) state.pr = pr;
    // A round a session failure aborts stops as `failed`, with no ## Escalation.
    const ctx = {
      feature,
      config,
      prep,
      runner,
      state,
      resumeHint: `bl review ${feature.id}`,
      failsWithoutEscalation: true,
    };
    clearUntimedOut(ctx);
    // `bl review` records the PRs in the change document before it gets
    // here; a unit reviewed with none gets one now, for the verifier.
    if (!existsSync(changeFile(ctx))) {
      ctx.changePath = (
        await ensureChange(config.backlogRoot, dirname(feature.indexPath), {
          changeOf: feature.id,
          title: feature.title,
          repos: [{ repo: prepRepo(ctx), branch: prep.branchName }],
        })
      ).path;
    }
    // The unit's review state, from its log (F-69 D5).
    const review = reviewState(ctx);
    const round = review.reviewed;
    const owed = integrationRoundOwed(state, review);
    if (round >= maxRounds && !owed) {
      return refuse(runner, feature, `review round cap (${maxRounds}) already reached at round ${round}`);
    }
    let result;
    try {
      await reapStaleScopes(ctx);
      result = await reviewRound(ctx, { reReview: isReReview(review), closing: owed && round >= maxRounds });
    } catch (e) {
      if (!(e instanceof RunStoppedError)) throw e;
      // A failed log write stops the run as `failed`, with no ## Escalation.
      const escalated = e.state?.status === 'escalated';
      return {
        status: unitStatus(ctx),
        round: reviewState(ctx).reviewed,
        verdict: false,
        escalated,
        error: e.message,
        end: escalated ? endOfReview(ctx, maxRounds, true) : null,
      };
    }
    // A round a session failure aborted says why, and what to do (S-1140).
    const failed = result.abortError ? withFailure(result.abortError, '', result.abortFailure) : null;
    state.status = failed ? 'failed' : 'reviewed';
    state.lastError = failed?.reason ?? null;
    saveRunState(config, state);
    const escalated = escalationOpen(feature.indexPath);
    const error = failed?.reason ?? null;
    return {
      ...(failed?.details ? { details: failed.details } : {}),
      status: unitStatus(ctx),
      round: result.round,
      // Whether the round reached a verdict, which the unit's log records.
      verdict: !error,
      escalated,
      // A round that did not finish recorded no verdict: no end.
      end: error && !escalated ? null : endOfReview(ctx, maxRounds, escalated),
      error,
    };
  } finally {
    lock.release();
  }
}

/**
 * Record a review round's verdict in the unit's log (F-69 D1, D3): the
 * first branch of `flow.json`'s `review` row whose guards hold, a `success`
 * one with no open item, else a `failure` one (`fixing` while the round is
 * within the cap, `round_within_cap`; then `escalated`). `bl merge`'s round
 * over a merge resolution is outside the cap (F-36 D7), so its open items go
 * to `fixing` whatever the round. Returns the unit's status read back from
 * its log, which is the branch's unless the hop was not recorded. No branch
 * that holds stops the run.
 */
async function recordVerdict(ctx, { clean, round, summary }) {
  const guardCtx = {
    config: ctx.config,
    id: ctx.feature.id,
    indexPath: ctx.feature.indexPath,
    round,
    maxRounds: ctx.integration ? Infinity : ctx.state.maxRounds,
  };
  const outcome = clean ? 'success' : 'failure';
  let branch;
  try {
    branch = requireBranch(loadFlow(ctx.config.backlogRoot), unitKind(ctx), 'review', outcome, guardCtx);
  } catch (e) {
    const reason = `the round's verdict could not be recorded: ${e.message}`;
    throw new RunStoppedError(reason, await finish(ctx, 'failed', reason));
  }
  await hop(ctx, 'review', branch.to, { by: 'review', via: 'review', outcome: summary });
  return unitStatus(ctx);
}

/** `reviewEnd` for the round `bl review` just ran, from the log and the change document it left. */
function endOfReview(ctx, maxRounds, escalated) {
  return reviewEnd({
    id: ctx.feature.id,
    unitRelPath: ctx.feature.featureRelPath,
    maxRounds,
    review: reviewState(ctx),
    body: readChangeText(ctx).body,
    state: ctx.state,
    escalated,
  });
}

/**
 * A run that never started: nothing is saved, so the state of the run that
 * holds the feature (or the worktree) is left as it is.
 */
function refuse(runner, feature, reason) {
  runner.log(`${feature.id}: not starting — ${reason}`);
  return { feature: feature.id, status: 'failed', step: 'setup', lastError: reason, history: [], refused: true };
}

/**
 * Drive the loop. `prep` is the prepared worktree (see
 * `prepareFeatureWorktree` in feature-cmd.js), `runner` the side-effect
 * boundary. Returns the final run state.
 *
 * One run per feature: the run holds `.bl/run/<id>.lock` and the work unit
 * locks of the unit and its stories (`takeRunLocks`) for its whole length,
 * and does not start while another live process holds the unit directory's
 * session lock (`sessionLockPath`).
 */
export async function runFeature({ feature, config, prep, runner, opts = {} }) {
  const sessionLock = sessionLockPath(config.backlogRoot, prepUnitDir(prep));
  const wtHolder = otherHolder(sessionLock);
  if (wtHolder != null) {
    return refuse(runner, feature, `a live session (pid ${wtHolder}) holds ${sessionLock}`);
  }
  const lock = takeRunLocks(config, feature, `run ${feature.id}`);
  if (lock.refused != null) return refuse(runner, feature, lock.refused);
  try {
    return await driveFeature({ feature, config, prep, runner, opts });
  } catch (e) {
    // Already escalated and saved by withContainerCleanup or waitOrEscalate.
    if (e instanceof RunStoppedError) return e.state;
    throw e;
  } finally {
    lock.release();
  }
}

/**
 * A story's first run gives its frontmatter the review budget a feature has,
 * `review_rounds_max` (kept when already set). The branch and PR go to the
 * change document, the review round to the story's log. Returns whether the file changed.
 */
async function recordStoryRunFields(ctx, maxRounds) {
  const { feature } = ctx;
  return updateSpecFile(ctx.config.backlogRoot, feature.indexPath, (fm) => {
    if (fm.review_rounds_max != null) return false;
    fm.review_rounds_max = String(maxRounds);
  });
}

/**
 * A round `bl merge`'s review of a merge resolution left open (F-36 D7). That
 * review runs outside the round cap, so its items are owed a fix and a closing
 * round whatever the cap, below, at or above it.
 */
function integrationRoundOwed(state, review) {
  return state?.integrationReview === review.reviewed && itemsOwed(review);
}

/**
 * Whether the last round's open items are owed a review (`reviewOf`, F-69
 * D5): the unit is in `fixing`, or back in review after a fix with no
 * verdict yet.
 */
function itemsOwed(review) {
  return review.position === 'fixing' || isReReview(review);
}

/** Whether the next review re-reviews fixes: a round is open, and a fix opened it. */
function isReReview(review) {
  return review.position === 'in_review' && review.fixed;
}

/**
 * Where a run that starts now stands against the round cap: `'below'` the
 * cap; `'closing'` at or past it with a closing round owed (the last full
 * round, at the cap, left items in `fixing` or fixed them, or an open
 * integration round); else `'reached'`, where `bl run` refuses until the
 * operator raises the cap with --max-rounds. `review` is the unit's review
 * state (`reviewOf`, F-69 D5); `state` is the run state, or `null` when
 * there is none (then no integration round is owed).
 *
 * @param {object|null} state
 * @param {{ reviewed: number, position: string|null, fixed: boolean }} review
 * @param {number} maxRounds
 * @returns {'below'|'closing'|'reached'}
 */
export function roundCapStanding(state, review, maxRounds) {
  const round = review.reviewed;
  if (round < maxRounds) return 'below';
  const owed = (round === maxRounds && itemsOwed(review)) || integrationRoundOwed(state, review);
  return owed ? 'closing' : 'reached';
}

/** The command that raises the cap for one more round after `round`. */
function higherCapCommand(id, round) {
  return `bl run ${id} --resume --max-rounds ${round + 1}`;
}

/**
 * How `bl review` ends: the round's outcome words, the cap sentence (`''`
 * when there is none) and the next command (`null` when there is none). The
 * next command follows `roundCapStanding`, the rule `bl run` refuses by, so
 * the two cannot disagree. `review` is the unit's review state after the
 * round (`reviewOf`, F-69 D5), `body` its change document's; `unitRelPath`
 * is the unit's `index.md`, relative to the backlog.
 *
 * @returns {{ outcome: string, cap: string, next: string|null }}
 */
export function reviewEnd({ id, unitRelPath, maxRounds, review, body, state, escalated }) {
  if (escalated) return { outcome: 'escalated', cap: '', next: `read ## Escalation in ${unitRelPath}` };
  const { position } = review;
  const session = summarizeLatestReviewSession(body ?? '');
  const outcome = reviewOutcome(position, session);
  if (outcome == null) {
    return { outcome: `no verdict recorded (${position ?? 'never reviewed'})`, cap: '', next: null };
  }
  // At ready_for_merge: `bl merge`, or `bl review` while an open Must/Should box blocks the merge gate.
  const verb = changeNextVerb(position, body ?? '');
  if (verb !== 'run') return { outcome, cap: '', next: `bl ${verb} ${id}` };
  const standing = roundCapStanding(state, review, maxRounds);
  if (standing === 'below') return { outcome, cap: '', next: `bl run ${id} --resume` };
  if (standing === 'closing') {
    const items = (session?.unchecked ?? 0) > 0;
    return {
      outcome,
      cap: ` The round cap (${maxRounds}) is reached${items ? ': the next run fixes these items and runs one closing round on them' : ''}.`,
      next: `bl run ${id} --resume`,
    };
  }
  return {
    outcome,
    cap: ` The round cap (${maxRounds}) is reached.`,
    next: higherCapCommand(id, review.reviewed),
  };
}

async function driveFeature({ feature, config, prep, runner, opts }) {
  const cfg = prep.cfg ?? config;
  const maxRounds = opts.maxRounds ?? feature.reviewRoundsMax;
  let state = null;
  let resumeNote = '';
  if (opts.resume) {
    try {
      state = loadRunState(config, feature.id);
    } catch (e) {
      return refuse(runner, feature, `cannot resume: ${e.message} — fix it, or delete it to start a new run`);
    }
    if (!state) {
      resumeNote = ' (--resume: no run state found — starting a new run)';
      runner.log(`  warning: no run state to resume at ${runStatePath(config, feature.id)} — starting a new run`);
    }
  }
  if (!state) {
    state = newRunState(feature, { branch: prep.branchName, worktreePath: prep.worktreePath, maxRounds });
  } else {
    state.status = 'running';
    state.lastError = null;
    delete state.stoppedAt;
    delete state.stoppedBy;
    state.maxRounds = maxRounds;
  }
  // A batch has no premise or design of its own (F-125 D1): each of its
  // stories carries its own refined plan, as a story run's does.
  const implementPrompt = flowKind(feature) === 'feature' ? 'feature-story' : 'story-run';
  const ctx = {
    feature,
    config,
    prep,
    runner,
    state,
    resumeHint: `bl run ${feature.id} --resume`,
    implementPrompt,
    implemented: new Set(),
    implementedThisRun: false,
  };
  clearUntimedOut(ctx);
  const started = [];
  // The execution plan, made after worktree preparation and before the first
  // implement step; the `run started` commit carries it.
  try {
    if (await setupPlan(ctx, opts.resume)) started.push(planRelPath(ctx));
  } catch (e) {
    return refuse(runner, feature, e.message);
  }
  // A unit with no log gets the one its status and change document give
  // (F-69 D4) before the run records a hop: the document as it is now, since
  // its review fields place the unit (D5).
  const logged = await ensureLog(config.backlogRoot, { ...unitRef(ctx), change: readChange(changeFile(ctx)) });
  const runFields = isStory(feature) && (await recordStoryRunFields(ctx, maxRounds));
  if (logged || runFields) started.push(feature.featureRelPath);
  if (await setupChange(ctx)) started.push(changeRelPath(ctx));
  if (started.length > 0)
    await commitUnitPaths(ctx, 'setup', started, `chore: ${feature.id} run started on ${prep.branchName}`);
  // A resumed run that already got as far as the PR has been self-reviewed;
  // it goes back through the gate and the push, then on to the review loop.
  // A `pr` entry that a no-commit finish skipped (S-1437) opened no PR.
  const reachedReview = Boolean(opts.resume && (state.pr || state.history.some((h) => h.step === 'pr' && !h.skipped)));
  saveRunState(config, state);
  record(ctx, {
    step: 'setup',
    ok: true,
    note: `${prep.branchName} @ ${prep.worktreePath}${resumeNote || (opts.resume ? ' (resumed)' : '')}`,
  });
  // What a crashed or killed bl left running for this unit (F-70 D4).
  await reapStaleScopes(ctx);

  // An escalation left open by a previous run (or an operator) blocks a
  // restart until it is cleared — that is the point of the section.
  if (escalationOpen(feature.indexPath)) {
    return finish(ctx, 'failed', '## Escalation is not empty — clear it to "None." before running again');
  }
  // The run starts (F-69 D3): `in_progress` by `run` from a status `run`
  // starts from. A unit in review or fixing resumes where it is.
  const flow = loadFlow(config.backlogRoot);
  if (flow.fromOf(unitKind(ctx), flow.verbOf(unitKind(ctx), 'run')).includes(unitStatus(ctx))) {
    await enterHop(ctx, 'setup', 'run');
  }

  // 1. Implement stories in dependency order. A story unit's one story uses
  // story-run.md: no feature file, and its follow-ups go to its own Deferred.
  const implementStopped = await implementStories(ctx);
  if (implementStopped) return implementStopped;

  // 2. Test gate.
  setStep(ctx, 'test');
  if (!(await testGateWithFix(ctx))) return state;

  // 3. Self-review, then the gate again if the tree changed.
  if (!reachedReview && !skipsReview(ctx)) {
    setStep(ctx, 'self-review');
    const beforeSelf = targetHeads(ctx);
    const self = await runSession(ctx, {
      step: 'self-review',
      mode: 'workon',
      promptName: 'feature-self-review',
      vars: { mainRef: 'main' },
      label: `${feature.id}: self-review`,
      schema: loadSchema('self-review'),
    });
    if (escalationOpen(feature.indexPath)) return finish(ctx, 'escalated', 'agent escalated during self-review');
    if (!self.structured.ok) {
      return finish(
        ctx,
        'escalated',
        `the self-review found the branch not ready for review: ${self.structured.summary}`,
      );
    }
    const scope = await rescope(ctx);
    if (scope.stop) return scope.stop;
    // Gate again when the self-review says it changed something, committed
    // something in any repo, also when it left edits uncommitted (those would
    // otherwise ride along untested until a later gate refused the dirty
    // tree), and when it added stories or repos.
    if (scope.changed || self.structured.changed || targetsMoved(ctx, beforeSelf)) {
      setStep(ctx, 'test');
      if (!(await testGateWithFix(ctx))) return state;
    }
  }

  // A story whose self-review passed with nothing on its branch did its work
  // elsewhere (the backlog, S-1437): no push, no PR, no review. A resumed run
  // with no PR passed its self-review before its `pr` step. A story with a
  // review session goes on below. A story this path already took to
  // ready_for_merge ends clean again with nothing recorded (what `bl merge`
  // takes, `mergeGates`); any other status takes it only when the `review`
  // verb starts from that status.
  const noCommitStatus = unitStatus(ctx);
  const noCommits =
    isStory(feature) &&
    !skipsReview(ctx) &&
    !state.pr &&
    !featureReviewGate(reviewState(ctx).position, readChangeText(ctx).body).review &&
    gateTargets(ctx).every((t) => branchEmpty(ctx, t));
  if (noCommits && noCommitStatus === REVIEW.clean) return finish(ctx, 'clean');
  if (noCommits && flow.fromOf(unitKind(ctx), flow.verbOf(unitKind(ctx), 'review')).includes(noCommitStatus)) {
    setStep(ctx, 'pr');
    // The `review` verb's edges pass through its `during` status (flow.json).
    await enterHop(ctx, 'review', 'review');
    await hop(ctx, 'review', REVIEW.clean, { by: 'review', note: 'no commits: nothing to review' });
    if (unitStatus(ctx) !== REVIEW.clean) {
      return finish(
        ctx,
        'escalated',
        `the story has no commits, but its log could not record ${REVIEW.clean} (it is ${unitStatus(ctx)})`,
      );
    }
    const note = 'skipped: no commits, nothing to review';
    record(ctx, { step: 'pr', ok: true, skipped: true, note });
    record(ctx, { step: 'review', ok: true, skipped: true, note });
    return finish(ctx, 'clean');
  }

  // 4. Push + one PR.
  setStep(ctx, 'pr');
  const pushErr = pushBranch(ctx, 'pr');
  if (pushErr) return finish(ctx, 'escalated', 'push failed', pushErr.details);
  const opened = await openPullRequest(ctx);
  if (opened.error) return finish(ctx, 'escalated', 'no pull request could be opened', opened.error);
  state.pr = opened.pr ?? null;
  state.prOptOut = opened.optOut ?? null;
  saveRunState(config, state);
  const others = await openOtherPullRequests(ctx);
  if (others.error) return finish(ctx, 'escalated', 'no pull request could be opened', others.error);

  if (skipsReview(ctx)) {
    record(ctx, { step: 'review', ok: true, note: 'skipped: scripted story, nothing an agent wrote' });
    return finishClean(ctx);
  }
  // The run's success: the unit goes to review (F-69 D3). A resumed unit in
  // review or fixing stays where it is.
  if (unitStatus(ctx) === 'in_progress') {
    await hop(ctx, 'pr', 'in_review', { by: 'run', via: 'open_pr', outcome: state.pr?.url || undefined });
  }

  // 5. Review loop. The unit's status places it (F-69 D3): a unit in
  // `fixing` (a resumed run, or a review written before this run) is fixed
  // first, since re-reviewing unfixed code would only spend a round.
  // A run resumed after an escalation is back in review; the last review's
  // open items, which nobody fixed, are still its verdict. Its return to
  // `in_review` opened no round (`reviewOf`, F-69 D5).
  const entry = reviewState(ctx);
  if (unitStatus(ctx) === REVIEW.open && entry.position === REVIEW.items) {
    await hop(ctx, 'review', 'fixing', { by: 'review', note: `round ${entry.round} items still open` });
  }
  const position = unitStatus(ctx);
  // Ready for merge is a verdict on the scope that was reviewed: work this
  // run implemented, or a story or repo the last review did not cover, is
  // reviewed first.
  if (reachedReview && position === 'ready_for_merge' && !ctx.implementedThisRun && scopeReviewed(ctx))
    return finishClean(ctx);
  // The cap is re-checked on entry. A feature at the cap with its last full
  // round's items still in `fixing`, or fixed and not yet re-reviewed, is
  // owed its closing round; anything else at the cap, or past it, would
  // spend a round the cap does not allow — the same refusal `bl review`
  // makes. Raising the cap is the operator's call, made with --max-rounds.
  if (roundCapStanding(state, entry, maxRounds) === 'reached') {
    return finish(
      ctx,
      'escalated',
      `review round cap (${maxRounds}) already reached at round ${entry.reviewed}`,
      `Another round needs a higher cap: ${higherCapCommand(feature.id, entry.reviewed)}\n\n${openItemsSummary(ctx)}`.trim(),
    );
  }
  // The round of the open items: the log's.
  let pendingRound = position === 'fixing' ? entry.round : null;
  for (;;) {
    let fixRound = pendingRound;
    pendingRound = null;
    if (fixRound == null) {
      const review = reviewState(ctx);
      const reReview = isReReview(review);
      // After the last full round, the verifier checks only that round's
      // items: on F-4 a cap of 2 stopped a run whose round 2 had one Should
      // item left, which one more fix would have closed.
      const closing = review.reviewed >= maxRounds;
      const pushErr = pushBranch(ctx, reReview ? 're-review' : 'review');
      if (pushErr) return finish(ctx, 'escalated', 'push before review failed', pushErr.details);
      const others = await openOtherPullRequests(ctx);
      if (others.error) return finish(ctx, 'escalated', 'no pull request could be opened', others.error);
      const result = await reviewRound(ctx, { reReview, closing });
      if (result.abortError) {
        const { reason, details } = withFailure(
          `review round ${result.expected} aborted before a verdict`,
          result.abortError,
          result.abortFailure,
        );
        return finish(ctx, 'escalated', reason, details);
      }
      if (escalationOpen(feature.indexPath)) {
        return finish(ctx, 'escalated', `reviewer escalated in round ${result.round}`);
      }
      const scope = await rescope(ctx);
      if (scope.stop) return scope.stop;
      // Stories or repos added during the round are not in its verdict: they
      // are gated and get a round of their own, from `ready_for_merge`.
      if (result.clean && scope.changed) {
        if (closing) {
          return finish(
            ctx,
            'escalated',
            `the closing round added ${scopeNote(scope)}, which no review has covered`,
            `Another round needs a higher cap: ${higherCapCommand(feature.id, result.round)}`,
          );
        }
        setStep(ctx, 'test');
        if (!(await testGateWithFix(ctx))) return state;
        continue;
      }
      // Open items went to `fixing` while the round was within the cap; the
      // closing round's open items escalate (`recordVerdict`).
      if (result.clean) return finishClean(ctx);
      if (result.to === 'escalated') {
        return finish(
          ctx,
          'escalated',
          `the closing round after the review round cap (${maxRounds}) left open items`,
          openItemsSummary(ctx),
        );
      }
      fixRound = result.round;
    }
    setStep(ctx, 'fix', { round: fixRound });
    const preFixSha = headSha(ctx);
    // The unit stays in `fixing` on every exit before the fix self-review
    // passes: only `in_review` by `fix` says the items are fixed (F-69 D5).
    const fix = await runSession(ctx, {
      step: 'fix',
      mode: 'workon',
      promptName: 'feature-workon-review',
      vars: { scratchDir: scratchFor(ctx, `r${fixRound}.fix`) },
      label: `${feature.id}: address review r${fixRound}`,
      schema: loadSchema('fix'),
    });
    if (escalationOpen(feature.indexPath)) {
      return finish(ctx, 'escalated', 'agent escalated while addressing review feedback');
    }
    const afterFix = await rescope(ctx);
    if (afterFix.stop) return afterFix.stop;
    if (!fix.structured.fixed) {
      return finish(
        ctx,
        'escalated',
        `fix session for round ${fixRound} left ${fix.structured.open} item(s) open: ${fix.structured.summary}`,
        openItemsSummary(ctx),
      );
    }
    // The author re-reads the fix diff in a fresh context before anyone else
    // does: on F-2, fix rounds wrote more code than the feature and none of it
    // was re-read before the next review, which then reviewed it for them.
    // Without a recorded review commit (a session written by an earlier run or
    // by hand) the fix diff starts where the fix session did — never the whole
    // branch, whose feature code no review item "asked for".
    const fixBaseSha = ctx.state.reviewBaseSha ?? preFixSha;
    setStep(ctx, 'fix-self-review', { round: fixRound });
    const selfReview = await runSession(ctx, {
      step: 'fix-self-review',
      mode: 'workon',
      promptName: 'feature-fix-self-review',
      vars: {
        fixBaseSha: fixBaseSha ?? '',
        fixDiff: fixBaseSha ? `git diff ${fixBaseSha}..HEAD` : 'git diff main...HEAD',
      },
      label: `${feature.id}: self-review fix r${fixRound}`,
      schema: loadSchema('self-review'),
    });
    if (escalationOpen(feature.indexPath)) {
      return finish(ctx, 'escalated', 'agent escalated during the fix self-review');
    }
    const afterSelfReview = await rescope(ctx);
    if (afterSelfReview.stop) return afterSelfReview.stop;
    // A fix diff nobody re-read is what this step exists to prevent.
    // A denied command is a warning, not a failure: the agent sees a tool
    // error and takes another route (runSession has already recorded it in
    // the history). Only a session that errored, or whose outcome says the
    // fix is not ready, stops the loop — on F-3 a strict "any denial
    // escalates" rule stopped a self-review that had recovered and done its
    // job (operator decision 2026-09-24).
    if (!selfReview.ok || selfReview.isError || !selfReview.structured.ok) {
      const notReady = selfReview.structured?.ok === false;
      const why = notReady ? selfReview.structured.summary : sessionError(selfReview);
      const { reason, details } = withFailure(
        `the fix self-review for round ${fixRound} failed: ${why}`,
        openItemsSummary(ctx),
        notReady ? null : sessionFailure(ctx, 'fix-self-review', selfReview),
      );
      return finish(ctx, 'escalated', reason, details);
    }
    await hop(ctx, 'fix-self-review', 'in_review', {
      by: 'fix',
      via: 'fix_self_review',
      outcome: selfReview.structured.summary,
    });
    setStep(ctx, 'test');
    if (!(await testGateWithFix(ctx))) return state;
  }
}
