/**
 * cleanup.js — merge, sync, push, and remove story worktrees.
 *
 * By default, cleans up EVERY worktree the story has: the primary repo
 * first, then a backlog sync with the merged primary's code, then each
 * secondary. A secondary's pre-push gate may read backlog output the primary
 * generates (S-864), so the primary must land and the backlog must be
 * regenerated before any secondary pushes. The story is marked done only
 * after the final worktree is cleaned. Pass --repo <name> to clean exactly
 * one (no reorder, no interim sync).
 *
 * When the primary repo is `bl` itself, every sync after its merge runs as a
 * child `node <bl>/src/bl.js sync --commit …` from the merged checkout: this
 * process still has the old modules loaded. The child may start only once
 * this process has released the backlog lock, which is re-entrant within a
 * process only.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { execSync, execFileSync, spawnSync } from 'child_process';
import {
  loadConfig,
  configForRepo,
  repoOf,
  parseFrontmatter,
  parseFrontmatterOf,
  serializeFrontmatter,
  parseArgs,
  resolvePlugins,
  runPlugins,
  runForgeOp,
  findChange,
  shellQuote,
  normalizeId,
  info,
  renameTmuxWindow,
  unitDirFor,
} from './config.js';
import {
  findStoryDir,
  findExistingWorktree,
  isSessionRunning,
  allActiveWorktrees,
  refuseStoryRepo,
  storyRepoOrExit,
  removeUnitDirIfEmpty,
  LOCK_FILE,
} from './story.js';
import { getAllowedTools, loadPrompt } from './session.js';
import { recordMerge } from './change-doc.js';
import { storyUnit } from './unit.js';
import { mergeGates, noReviewLines, reportMergeGates } from './merge-gates.js';
import { integrateForMerge } from './merge-integrate.js';
import { extractSection } from './feature.js';
import { resolvePermissionScopes } from './permissions.js';
import { getProvider } from './agents/index.js';
import { acquireLock, releaseLock } from './lock.js';
import { atomicWriteFile } from './atomic-write.js';
import { readSpecText, specText, withSpecLock } from './spec-file.js';
import { syncMain, reportMainSync, MAIN_REFSPEC } from './main-sync.js';
import { syncAndCommit, reportBacklogCommit, exitOnSyncError } from './sync.js';

/**
 * A story's `## To Do` body, for the merge's triage agent: since F-65 D4 it
 * holds `[points: N]` follow-up work only (`bl validate` refuses anything
 * else on an open story), so the agent gets it whole.
 *
 * @param {string} storyContent
 * @returns {string}
 */
export function todoForTriage(storyContent) {
  return extractSection(storyContent.replace(/\r\n/g, '\n'), 'To Do') ?? '';
}

/**
 * Pick the frontmatter shape for a collected `<repo>: <sha>` commit map.
 * Single-entry maps collapse to the bare SHA string (the legacy single-repo
 * format); multi-entry maps stay as the map object. Empty input returns null
 * so the caller can decide whether to skip writing the field at all.
 */
export function commitFmShape(commitMap) {
  const keys = Object.keys(commitMap ?? {});
  if (keys.length === 0) return null;
  if (keys.length === 1) return commitMap[keys[0]];
  return { ...commitMap };
}

/**
 * The `<repo>: <sha>` map a story's `commit:` carries while its merge is in
 * progress (S-864): the repos earlier `bl merge` runs already landed. Only
 * entries whose value is a non-empty string count. A bare string (a done
 * story's collapsed shape), an empty value or anything else starts an empty
 * map.
 */
export function landedCommitMap(commit) {
  if (!commit || typeof commit !== 'object' || Array.isArray(commit)) return {};
  return Object.fromEntries(Object.entries(commit).filter(([, sha]) => typeof sha === 'string' && sha !== ''));
}

/**
 * The `commit:` map to write: the SHAs on disk unioned with this run's
 * landings. `landed` (exact merge SHAs) wins over the disk; `tips` (the tip
 * of `main` a repo with no local story branch reports, S-868) only fills a
 * repo the disk does not name, so an exact SHA any run recorded for that
 * repo is kept. A bare string on disk is the collapsed single-repo shape: it
 * names the one repo of a single-repo unit, so when this run names exactly
 * one repo (`landed` and `tips` together) it is that repo's exact SHA. When
 * the run names several repos the string's repo is unknowable and it is
 * ignored, like every other unreadable value.
 */
export function unionLandedCommits(onDisk, landed, tips = {}) {
  const named = Object.keys({ ...tips, ...landed });
  const exact =
    typeof onDisk === 'string' && onDisk !== '' && named.length === 1
      ? { [named[0]]: onDisk }
      : landedCommitMap(onDisk);
  return { ...tips, ...exact, ...landed };
}

/**
 * Record the repos this `bl merge` run has landed (`<repo>: <sha>`) in the
 * story's `commit:` map on disk (S-864). Under the backlog lock the story
 * file is re-read, so a SHA a concurrent `bl merge` (another `--repo` run)
 * wrote since this process read the story is kept: the map on disk and
 * `landed` are unioned, `landed` winning for the repos this run merged. The
 * file is then replaced atomically (`atomicWriteFile`: a staging file in
 * the backlog's ignored `.bl/tmp/`, then a rename), so an
 * interrupted or short write never leaves a half-written story, and a failed
 * write leaves the old file intact and throws. A story already `done` on
 * disk is left alone (a re-run after its final backlog commit failed).
 * `tips` (`<repo>: <sha>`, S-868) are recorded only for repos the re-read
 * map does not name (`unionLandedCommits`), so the keep-or-replace decision
 * for a no-branch repo is made under the lock, never from a stale read.
 * `mutate(fm, commitMap)` may edit the re-read frontmatter further before
 * the write (mark-done). The read, change and write run inside the story's
 * spec lock (`withSpecLock`), taken inside the backlog lock (F-67 D4), so a
 * token step entry a session writes meanwhile is not lost; like
 * `updateSpecFile`, a CRLF story keeps its line end and one with no `---`
 * block is refused with a `FrontmatterError` naming it.
 *
 * @returns {Promise<{ fm: object, body: string, commitMap: object,
 *   written: boolean }>} the frontmatter and body as written (as found, when
 *   the story was already done) and the unioned map.
 */
export async function persistLandedCommits(
  backlogRoot,
  indexPath,
  landed,
  {
    tips = {},
    mutate = null,
    read = readFileSync,
    write = (path, text) => atomicWriteFile(backlogRoot, path, text),
  } = {},
) {
  await acquireLock(backlogRoot);
  try {
    // Spec lock inside the backlog lock (F-67 D4).
    return withSpecLock(indexPath, () => {
      const { content, crlf } = readSpecText(read(indexPath, 'utf8'), indexPath);
      const { fm, body } = parseFrontmatterOf(content, indexPath);
      const commitMap = unionLandedCommits(fm.commit, landed, tips);
      if (fm.status === 'done') return { fm, body, commitMap, written: false };
      if (Object.keys(commitMap).length > 0) fm.commit = { ...commitMap };
      mutate?.(fm, commitMap);
      write(indexPath, specText(serializeFrontmatter(fm) + body, crlf));
      return { fm, body, commitMap, written: true };
    });
  } finally {
    releaseLock(backlogRoot);
  }
}

/**
 * A `persistLandedCommits` failure after the story's repo was pushed: name
 * the landed SHA so it can be put in the story by hand, and how to resume.
 */
function exitOnCommitWriteError(err, { parsed, indexPath, landed }) {
  console.error(`\nRecording the merged SHAs in ${indexPath} failed: ${err.message}`);
  console.error("These repos are merged and pushed; add them to the story's commit: map by hand:");
  for (const [repo, sha] of Object.entries(landed)) {
    console.error(`  ${repo}: ${sha}`);
  }
  console.error(`Then re-run:\n  bl merge ${parsed.id}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Backlog sync runner (S-864)
// ---------------------------------------------------------------------------

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Pick how `bl merge` runs its backlog syncs once the primary repo has
 * merged. When the primary is `bl` itself (its checkout's `package.json`
 * names the package `bl` and `src/bl.js` exists), the syncs run in a child
 * process from that checkout, so the just-merged code regenerates the
 * backlog; the running process still has the old modules loaded. Any other
 * primary, a missing or unreadable `package.json`, or no primary at all
 * keeps the in-process `syncAndCommit`.
 *
 * Pure: the file reader and the existence check are injected.
 *
 * @param {{ primaryRepoPath?: string | null,
 *   readJson?: (path: string) => any,
 *   exists?: (path: string) => boolean }} p
 * @returns {{ kind: "child", blEntry: string } | { kind: "in-process" }}
 */
export function chooseSyncRunner({ primaryRepoPath, readJson = readJsonFile, exists = existsSync }) {
  if (!primaryRepoPath) return { kind: 'in-process' };
  let pkg;
  try {
    pkg = readJson(join(primaryRepoPath, 'package.json'));
  } catch {
    return { kind: 'in-process' };
  }
  if (pkg?.name !== 'bl') return { kind: 'in-process' };
  const blEntry = join(primaryRepoPath, 'src', 'bl.js');
  if (!exists(blEntry)) return { kind: 'in-process' };
  return { kind: 'child', blEntry };
}

/**
 * The argument vector of the child `bl sync --commit` run: one `--story`
 * per id, so each story directory is staged with the regenerated indexes.
 */
export function syncChildArgs(blEntry, { message, storyIds = [] }) {
  // `bl sync --commit` refuses a commit scoped to no story or path (S-578),
  // so an empty list is a caller bug, caught here and not in the child.
  if (storyIds.length === 0) throw new Error('syncChildArgs: at least one story id is required');
  return [blEntry, 'sync', '--commit', '-m', message, ...storyIds.flatMap((id) => ['--story', id])];
}

/**
 * One backlog sync-and-commit through `runner`.
 *
 * In process it is `syncAndCommit`, which takes the backlog lock itself
 * (re-entrant, so a caller may already hold it). As a child it is
 * `node <blEntry> sync --commit …` run from the backlog root with this
 * process's environment; the caller must NOT hold the backlog lock, or the
 * child waits out the lock timeout and fails. The child reports its own
 * outcome on stderr, so a successful child returns `{ child: true }` in
 * place of a path list; a failed one carries the exact `command` to re-run
 * by hand, since this process never learns which paths the child wrote.
 *
 * @returns {Promise<{ committed: boolean, paths: string[], error?: string,
 *   notRepo?: boolean, child?: boolean, command?: string }>}
 */
export async function runBacklogSync(config, runner, { message, storyIds = [] }, exec = execFileSync) {
  if (runner.kind !== 'child') {
    return syncAndCommit(config, { message, storyIds });
  }
  const args = syncChildArgs(runner.blEntry, { message, storyIds });
  try {
    exec(process.execPath, args, {
      cwd: config.backlogRoot,
      stdio: ['inherit', process.stderr, process.stderr],
      env: process.env,
    });
  } catch (err) {
    const status = err?.status;
    const command = ['node', ...args].map(displayArg).join(' ');
    return {
      committed: false,
      paths: [],
      child: true,
      command,
      error: status != null ? `child bl sync exited ${status}` : `child bl sync failed: ${err?.message ?? err}`,
    };
  }
  return { committed: false, paths: [], child: true };
}

/**
 * Report a `runBacklogSync` result as `bl merge` does. A successful child
 * already printed its own report. A failed child printed its error too, so
 * name the command to re-run by hand (the story's edits stay on disk,
 * uncommitted) and exit 1. Everything else goes through
 * `reportBacklogCommit`, which exits 1 on a failed commit.
 */
function reportMergeSync(res) {
  if (res.child) {
    if (!res.error) return;
    console.error(`bl merge: backlog sync failed: ${res.error}`);
    console.error('The backlog edits are still on disk. Re-run the sync by hand:');
    console.error(`  ${res.command}`);
    process.exit(1);
  }
  reportBacklogCommit(res, 'bl merge', {
    nothing: 'Backlog indexes already up-to-date.',
  });
}

// ---------------------------------------------------------------------------
// Main-checkout gate (S-776)
// ---------------------------------------------------------------------------

/** How many commits ahead of origin/main an unmerged branch lists. */
const AHEAD_CAP = 10;

/**
 * Default `git <args>` runner for the gate: an argument vector run without a
 * shell (the branch name comes from the checkout, and git allows `$` and
 * backticks in it), quiet, trimmed stdout.
 *
 * @param {string} repoPath
 * @returns {(args: string[]) => string}
 */
function gitIn(repoPath) {
  return (args) =>
    execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

/** Quote a word for display in a copy-pasteable command, only when needed. */
function displayArg(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : shellQuote(word);
}

/**
 * Classify a repo's main checkout before a merge touches it.
 *
 * A side PR opened from the main checkout leaves it on a branch. Once that
 * PR has merged the checkout is stale: switching back loses nothing. GitHub
 * squash-merges side PRs, so ancestry alone cannot prove the merge; the
 * forge op `change.find` must also list the branch's PR as merged at the
 * very commit the checkout holds (`state: MERGED`, `headRefOid`).
 *
 * Returns `{ state, branch, reason, changed, ahead, aheadTotal }` where state
 * is one of:
 *   "on-main"   — nothing to do
 *   "stale"     — clean and merged; `switchToMain` is lossless
 *   "dirty"     — tracked changes (`changed` lists them)
 *   "unmerged"  — clean, merge not confirmed (`ahead` lists commits)
 *   "detached"  — detached HEAD
 *   "on-target" — on `branchName`, the branch being cleaned
 * Untracked files are carried across `git switch`, so they never count as
 * dirty.
 */
export function classifyMainCheckout({ repoPath, config, branchName, runOp = runForgeOp, git = gitIn(repoPath) }) {
  // `branch --show-current`, not `rev-parse --abbrev-ref HEAD`: the latter
  // answers `heads/<b>` when a tag shares the branch's name. Empty when
  // HEAD is detached.
  const branch = git(['branch', '--show-current']);
  if (branch === 'main') return { state: 'on-main', branch };
  if (!branch) {
    return { state: 'detached', branch: 'HEAD', reason: 'HEAD is detached' };
  }
  if (branchName && branch === branchName) {
    return {
      state: 'on-target',
      branch,
      reason: `the main checkout is on '${branch}', the branch being merged`,
    };
  }

  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status) {
    const changed = git(['status', '--short', '--untracked-files=no']).split('\n').filter(Boolean);
    return { state: 'dirty', branch, reason: 'tracked changes', changed };
  }

  // Two fetches, as `syncLocked` does: the configured refspec prunes gone
  // remote branches, then `main` is fetched by its explicit refspec so
  // `origin/main` is current even when `remote.origin.fetch` has been
  // narrowed to something that does not cover `refs/heads/main`. Each
  // runs on its own: the explicit fetch matters most when the configured
  // one is broken.
  let fetchNote = '';
  const FETCH_NOTE = ' (git fetch failed — checked against the last-fetched origin/main)';
  try {
    git(['fetch', '--prune', 'origin']);
  } catch {
    fetchNote = FETCH_NOTE;
  }
  try {
    git(['fetch', 'origin', MAIN_REFSPEC]);
  } catch {
    fetchNote = FETCH_NOTE;
  }

  // Name the branch by its full ref, so a branch named like a tag or a sha
  // can never resolve to a different object.
  const ref = `refs/heads/${branch}`;
  try {
    git(['merge-base', '--is-ancestor', ref, 'origin/main']);
    return { state: 'stale', branch, reason: `merged into origin/main${fetchNote}` };
  } catch {
    // not an ancestor — ask the forge about a squash merge
  }

  let reason;
  const found = findChange(branch, { config, repoPath, runOp });
  if (!found.ok && !found.configured) {
    reason = 'not an ancestor of origin/main, and the forge op change.find is not configured';
  } else if (found.reason === 'failed') {
    reason = 'not an ancestor of origin/main, and the merged-PR lookup failed';
  } else {
    const prs = found.ok ? found.prs.filter((p) => p.state === 'MERGED') : null;
    if (!prs) {
      reason = 'not an ancestor of origin/main, and the merged-PR lookup returned unparseable output';
    } else if (prs.length === 0) {
      reason = 'not an ancestor of origin/main, and no merged PR has this branch as its head';
    } else {
      const pr = prs[0];
      let head = '';
      try {
        head = git(['rev-parse', '--verify', ref]);
      } catch {
        // leave empty: never equals a headRefOid
      }
      if (head && pr.headRefOid === head) {
        return {
          state: 'stale',
          branch,
          reason: `PR #${pr.number} merged at ${head.slice(0, 7)}${fetchNote}`,
        };
      }
      reason = `PR #${pr.number} merged at ${String(pr.headRefOid ?? '?').slice(0, 7)} but the branch is at ${head.slice(0, 7) || '?'} (commits added after the merge)`;
    }
  }

  let ahead = [];
  try {
    ahead = git(['log', '--oneline', `origin/main..${ref}`, '--'])
      .split('\n')
      .filter(Boolean);
  } catch {
    // no origin/main — nothing to list
  }
  return {
    state: 'unmerged',
    branch,
    reason: reason + fetchNote,
    ahead: ahead.slice(0, AHEAD_CAP),
    aheadTotal: ahead.length,
  };
}

/**
 * The recovery for a stale checkout, as the three commands it runs: each an
 * argument vector for git, plus a shell-quoted `display` to copy and paste.
 */
export function switchMainSteps(repoPath, branch) {
  return [
    ['switch', 'main'],
    ['pull', '--ff-only'],
    ['branch', '-D', '--', branch],
  ].map((args) => ({
    args,
    display: ['git', '-C', repoPath, ...args].map(displayArg).join(' '),
  }));
}

/**
 * Switch a stale main checkout back to main: switch, fast-forward, delete the
 * branch. `branch -D`, because a squash-merged branch is never an ancestor;
 * `classifyMainCheckout`'s headRefOid match is the safety check. Stops at
 * the first failing step, so a failed pull never deletes the branch.
 */
export function switchToMain({ repoPath, branch, git = gitIn(repoPath) }) {
  for (const step of switchMainSteps(repoPath, branch)) {
    try {
      git(step.args);
      info(`  ✓ ${step.display}`);
    } catch (err) {
      const msg = String(err?.stderr || err?.message || err).trim();
      console.error(`  ✗ ${step.display}\n    ${msg}`);
      return { ok: false, step: step.display, error: msg };
    }
  }
  return { ok: true };
}

/**
 * Check every target repo's main checkout before any repo is merged, so a
 * refusal never lands after an earlier repo was already merged. Prints each
 * finding; with `switchMain`, switches stale checkouts back to main — but
 * only when no target is refused outright, so nothing is touched on a run
 * that will stop anyway.
 *
 * @param {object} p
 * @param {Array<{repoName: string, repoPath: string, config: object}>} p.targets
 * @param {boolean} [p.switchMain]
 * @param {string} [p.branchName] — the story or feature branch being merged
 * @returns {{ ok: boolean, findings: Array<object> }}
 */
export function preflightMainCheckouts({
  targets,
  switchMain = false,
  branchName,
  classify = classifyMainCheckout,
  doSwitch = switchToMain,
}) {
  const findings = [];
  for (const t of targets) {
    const c = classify({
      repoPath: t.repoPath,
      config: t.config,
      branchName,
    });
    if (c.state !== 'on-main') findings.push({ ...t, ...c });
  }
  if (findings.length === 0) return { ok: true, findings };

  const refused = findings.filter((f) => f.state !== 'stale');
  for (const f of findings) {
    console.error(`\n${f.repoName}: main checkout (${f.repoPath}) is not on main.`);
    if (f.state === 'stale') {
      console.error(`  On '${f.branch}', clean and merged: ${f.reason}.`);
      if (switchMain && refused.length === 0) continue;
      console.error('  Recover with:');
      console.error(
        `    ${switchMainSteps(f.repoPath, f.branch)
          .map((s) => s.display)
          .join(' && ')}`,
      );
      console.error('  or re-run with --switch-main.');
    } else if (f.state === 'dirty') {
      console.error(`  On '${f.branch}' with tracked changes — commit or discard them first:`);
      for (const line of f.changed) console.error(`    ${line}`);
    } else if (f.state === 'unmerged') {
      console.error(`  On '${f.branch}', not confirmed merged: ${f.reason}.`);
      if (f.ahead.length > 0) {
        console.error(`  Commits ahead of origin/main (${f.aheadTotal}):`);
        for (const line of f.ahead) console.error(`    ${line}`);
        if (f.aheadTotal > f.ahead.length) {
          console.error(`    … and ${f.aheadTotal - f.ahead.length} more`);
        }
      }
      console.error('  Merge or move that work, then switch the checkout to main by hand.');
    } else {
      console.error(`  Refusing: ${f.reason}. Switch the checkout to main by hand.`);
    }
  }
  if (refused.length > 0 || !switchMain) return { ok: false, findings };

  for (const f of findings) {
    info(`\n${f.repoName}: --switch-main: switching '${f.branch}' back to main...`);
    const res = doSwitch({ repoPath: f.repoPath, branch: f.branch });
    if (!res.ok) {
      console.error(`${f.repoName}: --switch-main stopped at: ${res.step}`);
      return { ok: false, findings };
    }
  }
  return { ok: true, findings };
}

// ---------------------------------------------------------------------------
// Per-repo cleanup (merge, push, close PR, remove worktree, delete branch)
// ---------------------------------------------------------------------------

export function cleanupOneRepo({ parsed, storyEntry, repoName, repoPath, keepBranch, config, isSecondary = false }) {
  const branchName = storyEntry.toLowerCase();

  const wt = findExistingWorktree(repoPath, branchName);
  const unitDir = unitDirFor(config, branchName);
  if (wt && isSessionRunning(unitDir)) {
    console.error(`A session appears to be running in ${unitDir}. Stop it first.`);
    return { ok: false };
  }

  // A secondary's worktree is removed even when its branch has nothing to
  // merge (below), so uncommitted work in it is refused up front.
  if (isSecondary && wt) {
    const changes = worktreeChanges(wt.path);
    if (changes == null || changes.length > 0) {
      console.error(`${repoName}: worktree ${wt.path} has uncommitted changes — commit or discard them first.`);
      for (const line of changes ?? []) console.error(`  ${line}`);
      return { ok: false };
    }
  }

  const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (currentBranch !== 'main') {
    console.error(`${repoName}: must be on main to cleanup. Currently on '${currentBranch}'.`);
    return { ok: false };
  }

  info(`\n=== ${repoName} ===`);
  info('Pulling latest main...');
  // Under the per-repo lock (S-865). A failed fetch is a warning and the
  // merge goes on from local main; a failed fast-forward or a lock timeout
  // stops this repo.
  if (!reportMainSync(syncMain(repoPath, { prune: true }), repoName)) {
    return { ok: false };
  }

  const branchExists = (() => {
    try {
      execSync(`git rev-parse --verify "${branchName}"`, {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  })();

  // A secondary `bl run` prepared up front that the story never changed
  // (S-862): nothing to merge, push or record, so only its worktree and
  // branch go.
  if (isSecondary && branchExists && commitsAhead(repoPath, branchName) === 0) {
    info(`Skipping the merge: no changes in ${repoName}.`);
    removeWorktreeAndBranch({ repoPath, repoName, branchName, branchExists, keepBranch, config });
    return { ok: true, mergeCommitHash: null, branchExists, noChanges: true };
  }

  let mergeCommitHash = null;
  if (branchExists) {
    const unmergedCommits = execSync(`git rev-list main..${branchName} --count`, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (parseInt(unmergedCommits, 10) > 0) {
      info(`Branch '${branchName}' has ${unmergedCommits} unmerged commit(s). Merging...`);
      try {
        execSync(`git merge --no-ff "${branchName}" -m "Merge branch '${branchName}' into main (${parsed.id})"`, {
          cwd: repoPath,
          stdio: ['inherit', process.stderr, process.stderr],
        });
      } catch {
        abortFailedMerge({ repoPath, repoName, id: parsed.id });
        return { ok: false };
      }
    } else {
      info(`Branch '${branchName}' is already merged into main.`);
    }
    try {
      mergeCommitHash = execSync('git rev-parse --short HEAD', {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // ignore
    }
  } else {
    // The branch was merged on the forge (or by an earlier run that already
    // deleted it). The pull above fast-forwarded main to origin/main and the
    // push below fails this repo if main is not on origin, so main's tip is a
    // SHA that landed and includes the forge merge (S-868).
    try {
      mergeCommitHash = execSync('git rev-parse --short HEAD', {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // ignore
    }
    info(
      `Branch '${branchName}' not found locally in ${repoName} — assuming PR was merged on the forge${
        mergeCommitHash ? `; recording main at ${mergeCommitHash}` : ''
      }.`,
    );
  }

  info(`Pushing main in ${repoName}...`);
  try {
    execSync('git push origin main', {
      cwd: repoPath,
      stdio: ['inherit', process.stderr, process.stderr],
    });
  } catch (err) {
    console.error(
      `${repoName}: push of main to origin failed — the recorded commit must always be one that landed on origin, not just locally.`,
    );
    return {
      ok: false,
      error: err?.message ?? 'git push origin main failed',
    };
  }

  // The branch's open PR is closed through the forge ops (F-42 D4):
  // `change.find` by branch, then `change.close`. Without a forge, an op or
  // the binary, or with no open PR, there is nothing to close — not fatal.
  try {
    const found = findChange(branchName, { config, repoPath });
    const open = found.ok ? found.prs.find((p) => p.state === 'OPEN') : null;
    if (open) {
      info(`Closing PR #${open.number}...`);
      const closeResult = runForgeOp(
        'change.close',
        { number: String(open.number), comment: 'Merged via bl merge.' },
        { config, repoPath },
      );
      if (closeResult.configured) {
        if (closeResult.stderr) process.stderr.write(closeResult.stderr);
        if (closeResult.stdout) process.stderr.write(closeResult.stdout);
      }
    }
  } catch {
    // no PR or gh unavailable — not fatal
  }

  removeWorktreeAndBranch({ repoPath, repoName, branchName, branchExists, keepBranch, config });

  return { ok: true, mergeCommitHash, branchExists };
}

/**
 * After a failed `git merge --no-ff` into main (F-36 D9): abort it, then
 * confirm the main checkout is back where it was, with no `MERGE_HEAD` and no
 * tracked change (the operator's untracked files are not the merge's). A
 * merge git refused outright (an untracked file in the way) leaves no
 * `MERGE_HEAD`, so there is nothing to abort. Prints the outcome; the caller
 * returns `{ ok: false }`. Returns whether the checkout is clean.
 */
export function abortFailedMerge({ repoPath, repoName, id }) {
  const git = (args) =>
    spawnSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const mergeHead = () => git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;
  const byHand = `git -C ${shellQuote(repoPath)} merge --abort`;
  if (mergeHead()) {
    const abort = git(['merge', '--abort']);
    if (abort.status !== 0) {
      const why = String(abort.stderr || abort.stdout || '').trim();
      console.error(
        `\n${repoName}: the merge into main failed, and so did \`git merge --abort\`${why ? `:\n  ${why}` : '.'}\nRun it by hand before anything else:\n  ${byHand}`,
      );
      return false;
    }
  }
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const left = status.status === 0 ? status.stdout.trim() : '(git status failed)';
  if (mergeHead() || left) {
    console.error(
      `\n${repoName}: the merge into main failed and the main checkout is not clean after the abort${left ? `:\n${left}` : '.'}\nRun:\n  ${byHand}\nand check \`git -C ${shellQuote(repoPath)} status\` before rerunning \`bl merge ${id}\`.`,
    );
    return false;
  }
  console.error(
    `\n${repoName}: the merge into main failed and was aborted; the main checkout is clean.\nmain moved since the branch was integrated; rerun \`bl merge ${id}\`.`,
  );
  return true;
}

/**
 * Commits on `branchName` that origin/main (local main when there is no
 * origin/main) does not have.
 */
function commitsAhead(repoPath, branchName) {
  for (const base of ['origin/main', 'main']) {
    try {
      return parseInt(
        execSync(`git rev-list --count "${base}..${branchName}"`, {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim(),
        10,
      );
    } catch {
      // no such base — try the next
    }
  }
  return null;
}

/**
 * Uncommitted changes in a worktree (tracked or untracked), not counting the
 * session lock file. Null when git cannot tell.
 *
 * @returns {string[] | null}
 */
function worktreeChanges(worktreePath) {
  try {
    return execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter((l) => l.trim() && l.slice(3) !== LOCK_FILE);
  } catch {
    return null;
  }
}

/**
 * The end of every repo's cleanup: its worktree, then its unit directory
 * once no other repo's worktree is in it, then its branches.
 */
function removeWorktreeAndBranch({ repoPath, repoName, branchName, branchExists, keepBranch, config }) {
  try {
    execSync('git worktree prune', { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // non-fatal
  }

  const wtNow = findExistingWorktree(repoPath, branchName);
  if (wtNow) {
    info(`Removing worktree: ${wtNow.path}`);
    try {
      execSync(`git worktree remove "${wtNow.path}"`, {
        cwd: repoPath,
        stdio: ['inherit', process.stderr, process.stderr],
      });
    } catch {
      info('  Normal remove failed, trying --force...');
      try {
        execSync(`git worktree remove --force "${wtNow.path}"`, {
          cwd: repoPath,
          stdio: ['inherit', process.stderr, process.stderr],
        });
      } catch {
        info(`  Could not remove worktree. Remove manually:\n    rm -rf "${wtNow.path}" && git worktree prune`);
      }
    }
  }
  const unitDir = unitDirFor(config, branchName);
  if (removeUnitDirIfEmpty(unitDir)) info(`Removed unit directory: ${unitDir}`);

  if (keepBranch) {
    info(`--keep: keeping branch '${branchName}' in ${repoName}.`);
  } else {
    try {
      execSync(`git push origin --delete "${branchName}"`, {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      info(`Deleted remote branch: origin/${branchName}`);
    } catch {
      // already deleted — fine
    }
    if (branchExists) {
      try {
        execSync(`git branch -d "${branchName}"`, {
          cwd: repoPath,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        info(`Deleted branch: ${branchName}`);
      } catch {
        try {
          execSync(`git branch -D "${branchName}"`, {
            cwd: repoPath,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          info(`Deleted branch: ${branchName} (force — squash merge)`);
        } catch {
          info(`Could not delete branch ${branchName}.`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl merge <story-id> [options]

Arguments:
  <story-id>           Story ID (e.g. S34, S-34, s34)

Options:
  --keep               Keep branches after cleanup
  --switch-main        When a repo's main checkout is left on a side branch
                       that is clean and already merged, switch it back to
                       main (switch, pull --ff-only, branch -D) and continue
  --no-review          Merge a story that was never reviewed; its change
                       document's ## Merge records the choice
  --help               Show this help

Merges the story's one repo, its component's: merges the branch, marks the
story done, syncs the backlog, closes the PR and removes the worktree.

The gates are a feature's (one set, F-36): refused while review_status is
pending or fixed or the latest Review Log session has an open Must or Should
(open nits pass), when it was never reviewed (naming a PR the forge merged
first) unless --no-review, while ## Escalation is open, and when a worktree on
the story's branch is in any other repo (work in another repo is another
story).

Before merging anything, every target repo's main checkout must be on main.
One left on a merged side branch is reported with the exact recovery (or
fixed by --switch-main); one with tracked changes or unmerged commits is
refused.

Then the branch is brought up to date with main in its worktree (main merged
into the branch), gated by the test plugins when it took commits, and pushed.
A conflict or a red gate rolls that back, writes ## Escalation and stops with
no main checkout touched. A merge into main that still fails is aborted.`);
    process.exit(0);
  }

  refuseStoryRepo('merge', args);

  const rawId = args.positional[0];
  if (!rawId) {
    console.error('Usage: bl merge <story-id>');
    process.exit(1);
  }

  const parsed = normalizeId(rawId);
  if (!parsed) {
    console.error(`Invalid story id: ${rawId}`);
    process.exit(1);
  }

  let config = loadConfig();
  const found = findStoryDir(parsed, config);
  if (!found) {
    console.error(`Story ${parsed.id} not found in backlog`);
    process.exit(1);
  }
  const { unitRepo, componentEntry, storyEntry, indexPath } = found;
  config = configForRepo(config, unitRepo);
  const storyContent = readFileSync(indexPath, 'utf8');
  const { fm: storyFm } = parseFrontmatter(storyContent);

  // A story merges one repo, its component's (F-52 D1).
  const primaryRepoName = storyRepoOrExit(parsed, found);
  const targetRepoNames = [primaryRepoName];

  // Validate every target exists in the config
  for (const name of targetRepoNames) {
    if (!config.reposByName[name]) {
      console.error(`Unknown repo: ${name}`);
      console.error(`Known repos: ${Object.keys(config.reposByName).join(', ')}`);
      process.exit(1);
    }
  }

  // One gate set with `bl merge F-n` (F-36 D1), before any repo is touched:
  // an unmet blockers.json edge (F-66 D3), review state, never reviewed,
  // escalation, stray worktrees and every main checkout on main.
  const unit = storyUnit(found, config);
  const gates = mergeGates(unit, {
    config,
    args,
    repos: targetRepoNames,
  });
  if (reportMergeGates(gates)) process.exit(1);

  info(`Story    : ${parsed.id} — ${storyFm.title ?? storyEntry}`);
  info(`Repos    : ${targetRepoNames.join(', ')}`);

  // The branch is brought up to date with main in its worktree, gated and
  // pushed before any main checkout is touched (F-36 D4).
  if (!(await integrateForMerge(config, unit, targetRepoNames))) process.exit(1);

  // Every backlog sync from here on may need the merged primary's code
  // (S-864): the runner is a child `bl sync` when the primary is `bl`.
  const syncRunner = chooseSyncRunner({
    primaryRepoPath: primaryRepoName ? config.reposByName[primaryRepoName] : null,
  });
  // Every landed SHA is written to the story's `commit:` map as its repo
  // lands (S-864), so a later failure in this run, a resume or a
  // concurrent run never loses it: `persistLandedCommits` unions
  // this run's landings with the map on disk under the lock, and the union
  // is collapsed at mark-done.
  const landed = {};
  // The tip of main a repo with no local branch reports (S-868): written
  // only when no run has recorded that repo's exact merge SHA, decided from
  // the map re-read under the lock on every write.
  const tips = {};
  const cleanedRepos = [];
  for (const repoName of targetRepoNames) {
    const repoPath = config.reposByName[repoName];
    const result = cleanupOneRepo({
      parsed,
      storyEntry,
      repoName,
      repoPath,
      keepBranch: !!args.keep,
      config,
    });
    if (!result.ok) {
      console.error(`\nCleanup of ${repoName} failed. Stopping. Resume with:\n  bl merge ${parsed.id}`);
      process.exit(1);
    }
    cleanedRepos.push(repoName);
    if (result.mergeCommitHash) {
      (result.branchExists ? landed : tips)[repoName] = result.mergeCommitHash;
      try {
        const { commitMap } = await persistLandedCommits(config.backlogRoot, indexPath, landed, { tips });
        if (commitMap[repoName] !== result.mergeCommitHash) {
          info(
            `Keeping ${repoName}'s recorded merge SHA ${commitMap[repoName]}; main is at ${result.mergeCommitHash}.`,
          );
        }
      } catch (err) {
        exitOnCommitWriteError(err, {
          parsed,
          indexPath,
          landed: { ...tips, ...landed },
        });
      }
    }
  }

  // After cleanup, check whether any worktree is still on the story's branch.
  const remainingWorktrees = allActiveWorktrees(config).filter((w) => w.storyId === parsed.id);
  const allCleaned = remainingWorktrees.length === 0;

  const todoRaw = todoForTriage(storyContent);
  // Strip HTML comments (placeholder scaffolding), then trim and check for
  // common "no content" markers. The regex is generous so a stray period or
  // capitalization doesn't trick us into spawning a pointless triage agent.
  const todoStripped = todoRaw.replace(/<!--[\s\S]*?-->/g, '').trim();
  const todoSection = /^(none|n\/a|tbd|nothing|—|-)?\.?$/i.test(todoStripped) ? '' : todoStripped;

  if (!allCleaned) {
    info(`\nStory ${parsed.id} still has worktrees in: ${remainingWorktrees.map((w) => w.repoName).join(', ')}`);
    info(`  — not marking done yet.`);
  } else {
    // Mark done, sync and commit in one lock hold, staging only the story and
    // the paths the sync wrote or moved, so other agents' uncommitted edits
    // in the shared backlog stay out of this commit. A child runner cannot
    // share this process's lock, so for it the lock covers the frontmatter
    // write alone and the child starts after the release; its `--story`
    // stages the story directory, so the done edit lands in the same commit.
    const syncOpts = {
      message: `chore: mark ${parsed.id} done, sync backlog`,
      storyIds: [parsed.id],
    };
    let res = null;
    await acquireLock(config.backlogRoot);
    try {
      const today = new Date().toISOString().slice(0, 10);
      let doneWrite;
      try {
        doneWrite = await persistLandedCommits(config.backlogRoot, indexPath, landed, {
          tips,
          mutate: (fm, commitMap) => {
            fm.status = 'done';
            const shape = commitFmShape(commitMap);
            if (shape !== null) fm.commit = shape;
            fm.completed = today;
          },
        });
        // The change document records each repo's merge commit; a story
        // merged alone gets no tag and no release manifest.
        if (doneWrite.written) {
          recordMerge(config.backlogRoot, dirname(indexPath), {
            commits: doneWrite.commitMap,
            date: today,
            extra: noReviewLines(gates.unreviewed, today),
          });
        }
      } catch (err) {
        exitOnCommitWriteError(err, {
          parsed,
          indexPath,
          landed: { ...tips, ...landed },
        });
      }
      if (doneWrite.written) {
        const shape = doneWrite.fm.commit;
        const commitForLog =
          typeof shape === 'string'
            ? shape
            : shape && typeof shape === 'object'
              ? Object.entries(shape)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')
              : null;
        info(`\nMarked ${parsed.id} done${commitForLog ? ` (commit=${commitForLog})` : ''}, completed=${today}`);
      }

      if (syncRunner.kind !== 'child') {
        info('\nSyncing backlog...');
        try {
          res = await runBacklogSync(config, syncRunner, syncOpts);
        } catch (err) {
          exitOnSyncError(err);
        }
      }
    } finally {
      releaseLock(config.backlogRoot);
    }
    if (syncRunner.kind === 'child') {
      info(`\nSyncing backlog with the merged ${primaryRepoName}...`);
      res = await runBacklogSync(config, syncRunner, syncOpts);
    }
    reportMergeSync(res);
  }

  if (allCleaned && todoSection) {
    const componentId = componentEntry.match(/^(C\d+)/)?.[1] ?? '';
    info(`\nStory ${parsed.id} has a To Do section — launching triage agent...\n`);
    const triagePrompt = loadPrompt(
      'cleanup-triage',
      {
        storyId: parsed.id,
        title: storyFm.title ?? storyEntry,
        todoSection,
        componentId,
        componentEntry,
        roostDir: config.roostDir,
        backlogDir: config.backlogRoot,
        storyRepos: primaryRepoName,
      },
      { agent: config.agent, config },
    );
    const triageName = `${parsed.id}: triage — ${storyFm.title ?? storyEntry}`;
    renameTmuxWindow(`${parsed.id} triage`);
    const provider = getProvider(config.agent);
    const allowedTools = getAllowedTools('triage', {
      backlogRoot: config.backlogRoot,
      roostDir: config.roostDir,
      config,
    });
    const translatedPermissions = provider.translatePermissions(allowedTools, {
      mode: 'triage',
      roostDir: config.roostDir,
      backlogRoot: config.backlogRoot,
      worktreePath: config.backlogRoot,
    });
    const triageResult = provider.spawn({
      mode: 'triage',
      name: triageName,
      prompt: triagePrompt,
      permissions: translatedPermissions,
      worktreePath: config.backlogRoot,
      roostDir: config.roostDir,
      backlogRoot: config.backlogRoot,
      scopes: resolvePermissionScopes(config, {
        unitDir: config.backlogRoot,
      }),
      model: config.agentModel,
    });
    if (triageResult.status !== 0) {
      info('  (triage session ended — you may need to create stories manually)');
    }
    info('');
  }

  if (allCleaned) {
    const cleanupPlugins = resolvePlugins('cleanup', config.plugins, {
      backlogRoot: config.backlogRoot,
      repo: repoOf(config),
      componentEntry,
      storyEntry,
    });
    if (cleanupPlugins.length > 0) {
      info('\nRunning cleanup plugins...');
      const primaryRepoPath = primaryRepoName ? config.reposByName[primaryRepoName] : config.backlogRoot;
      const pluginVars = {
        sessionId: `s${parsed.num}`,
        storyId: parsed.id,
        worktreePath: '',
        branchName: storyEntry.toLowerCase(),
        componentId: componentEntry.replace(/-.*/, ''),
        roostDir: config.roostDir,
        backlogDir: config.backlogRoot,
        repoPath: primaryRepoPath,
      };
      if (!runPlugins(cleanupPlugins, pluginVars, primaryRepoPath)) {
        console.error('Cleanup plugin failed — continuing anyway.');
      }
    }
  }

  info(
    `\nDone. ${parsed.id} cleaned in: ${cleanedRepos.join(', ')}${allCleaned ? ' (story marked done)' : ' (still has worktrees elsewhere)'}.`,
  );
  const { printInboxCount } = await import('./inbox.js');
  printInboxCount(config);
}
