/**
 * done.js — mark a backlog story done or superseded.
 *
 * Status is frontmatter, never location (F-49 D3): `bl done` writes the
 * story's `status:`, `commit:` and `completed:` and moves nothing. It commits
 * the backlog change (the story file and every index the sync rewrote) under
 * the backlog lock, via `syncAndCommit`. A component has no status, so it is
 * never marked done.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, relative } from 'path';
import { execSync } from 'child_process';
import {
  loadConfig,
  parseArgs,
  parseFrontmatter,
  resolvePlugins,
  configForRepo,
  repoOf,
  runPlugins,
  normalizeId,
  normalizeComponentId,
  info,
} from './config.js';
import { findStoryDir } from './story.js';
import { collectStoryTokens, applyTokensToFrontmatter } from './tokens.js';
import { updateSpecFile } from './spec-file.js';
import { summarizeLatestReviewSession } from './review-log.js';
import { unitChange } from './change-doc.js';
import { acquireLock, releaseLock } from './lock.js';
import { syncAndCommit, reportBacklogCommit, exitOnSyncError } from './sync.js';

function resolveCommitHash(config, primaryRepoName, rawCommit) {
  if (rawCommit) return rawCommit;
  const repoPath = primaryRepoName ? config.reposByName[primaryRepoName] : null;
  if (repoPath && existsSync(repoPath)) {
    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
    } catch {
      // fall through
    }
  }
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  const config = loadConfig();

  if (args.help) {
    console.log(`Usage: bl done [options] <story-id> [commit-hash]

Arguments:
  <story-id>           Story ID (e.g. S34, S-34, s34)
  [commit-hash]        Short git hash (default: HEAD of primary repo)

Options:
  --commit <repo>=<sha>       Repeatable. Records a per-repo merge SHA map
                              (multi-repo stories). Cannot be combined with
                              the [commit-hash] positional.
  --superseded                Mark as superseded instead of done
  --help                      Show this help

Sets the story's status; its directory stays where it is. Commits the backlog
change (the story file and every index the sync rewrote) on the backlog's
current branch, under the backlog lock. Other
uncommitted edits in the backlog stay out of the commit. When the backlog is
not a git repository, the commit is skipped.`);
    process.exit(0);
  }

  const rawId = args.positional[0];
  const rawCommit = args.positional[1] ?? null;
  const status = args.superseded ? 'superseded' : 'done';

  if (!rawId) {
    console.error('Usage: bl done [--superseded] <story-id> [commit-hash]');
    process.exit(1);
  }

  const componentParsed = normalizeComponentId(rawId);
  if (componentParsed) {
    console.error(`${componentParsed.id} is a component: a code boundary with no status, so it is never done.`);
    process.exit(1);
  }

  const storyParsed = normalizeId(rawId);
  if (!storyParsed) {
    console.error(`Invalid id: ${rawId}`);
    process.exit(1);
  }

  // --commit accumulates into args.commit (LIST_FLAGS). Normalize into the
  // commitMap form here so doneStory only deals with one shape downstream.
  let commitMap = null;
  if (args.commit !== undefined) {
    if (rawCommit) {
      console.error('bl done: cannot mix the positional [commit-hash] with --commit <repo>=<sha>; pick one.');
      process.exit(1);
    }
    const entries = Array.isArray(args.commit) ? args.commit : [args.commit];
    commitMap = {};
    for (const raw of entries) {
      const eq = raw.indexOf('=');
      if (eq <= 0 || eq === raw.length - 1) {
        console.error(`bl done: invalid --commit value "${raw}" — expected <repo>=<sha>.`);
        process.exit(1);
      }
      const repo = raw.slice(0, eq).trim();
      const sha = raw.slice(eq + 1).trim();
      if (!config.reposByName[repo]) {
        console.error(
          `bl done: --commit references unknown repo "${repo}". Known repos: ${Object.keys(config.reposByName).join(', ')}`,
        );
        process.exit(1);
      }
      commitMap[repo] = sha;
    }
  }

  return doneStory(storyParsed, status, rawCommit, config, commitMap);
}

async function doneStory(parsed, status, rawCommit, config, commitMap = null) {
  // Held across the frontmatter write, the sync that migrates the story and
  // the commit, so no other bl process interleaves its writes.
  let done;
  await acquireLock(config.backlogRoot);
  try {
    done = await markStoryDone(parsed, status, rawCommit, config, commitMap);
  } finally {
    releaseLock(config.backlogRoot);
  }
  const { unitRepo, componentEntry, storyEntry } = done;

  // Plugins run after the lock is released (they may call bl themselves) and
  // their output is not part of the commit.
  const cfg = configForRepo(config, unitRepo);
  const donePlugins = resolvePlugins('done', cfg.plugins, {
    backlogRoot: config.backlogRoot,
    repo: repoOf(cfg),
    componentEntry,
    storyEntry,
  });
  if (donePlugins.length > 0) {
    info('\nRunning done plugins...');
    const primaryRepoPath = unitRepo ? config.reposByName[unitRepo] : null;
    const pluginVars = {
      sessionId: `s${parsed.num}`,
      storyId: parsed.id,
      componentId: componentEntry.replace(/-.*/, ''),
      repoPath: primaryRepoPath ?? '',
      roostDir: config.roostDir,
      backlogDir: config.backlogRoot,
    };
    runPlugins(donePlugins, pluginVars, primaryRepoPath ?? config.backlogRoot);
  }

  info(`\nDone. Story ${parsed.id} marked ${status}.`);
}

async function markStoryDone(parsed, status, rawCommit, config, commitMap) {
  const found = findStoryDir(parsed, config);
  if (!found || !existsSync(found.indexPath)) {
    console.error(`Story ${parsed.id} not found under stories/.`);
    process.exit(1);
  }

  const { unitRepo, componentEntry, storyEntry, indexPath } = found;
  const backlogRel = relative(config.backlogRoot, indexPath);

  const content = readFileSync(indexPath, 'utf8');
  const { fm } = parseFrontmatter(content);

  if (fm.status === 'done' || fm.status === 'superseded') {
    console.error(`Story ${parsed.id} is already marked ${fm.status}.`);
    process.exit(1);
  }

  // Only the reviewer may sign a story off: `pending` means items are open,
  // `fixed` means the implementing agent claims they're resolved but no
  // re-review has verified it. Both block. Unchecked items in the latest
  // session block too, regardless of the frontmatter, so a hand-flipped
  // `addressed` with open boxes doesn't slip through. Both live in the
  // story's change document.
  const change = unitChange(dirname(indexPath), unitRepo);
  const reviewStatus = change.reviewStatus || undefined;
  const reviewSummary = summarizeLatestReviewSession(change.changeBody);
  const reviewBlocked = reviewStatus === 'pending' || reviewStatus === 'fixed' || reviewSummary?.unchecked > 0;
  if (reviewBlocked) {
    const date = reviewSummary?.date ?? 'unknown date';
    const unchecked = reviewSummary?.unchecked ?? 0;
    const next =
      reviewStatus === 'pending'
        ? `Address the review feedback (bl implement ${parsed.id})`
        : `Re-review the fixes (bl review ${parsed.id})`;
    console.error(
      `Story ${parsed.id} has unresolved review state` +
        ` (review_status: ${reviewStatus ?? 'unset'}, latest session ${date},` +
        ` ${unchecked} unchecked item${unchecked === 1 ? '' : 's'}).` +
        `\n${next} — or edit its change document manually — before marking done.`,
    );
    process.exit(1);
  }

  let commit;
  let commitForLog;
  if (commitMap) {
    commit = commitMap;
    commitForLog = Object.entries(commitMap)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
  } else {
    const commitHash = resolveCommitHash(config, unitRepo, rawCommit);
    if (!commitHash) {
      console.error('Could not determine commit hash. Pass one as the second argument.');
      process.exit(1);
    }
    commit = commitHash;
    commitForLog = commitHash;
  }

  const today = new Date().toISOString().slice(0, 10);
  // One read-modify-write under the story's spec lock (F-67 D1), inside the
  // backlog lock `doneStory` holds (D4): a session difference written while
  // the transcripts are read is either in the file this write starts from or
  // waits for it, so it is never lost and the totals never fall below the
  // step map. A failed write leaves the previous spec and fails `bl done`.
  let closedAs = null;
  let written;
  try {
    updateSpecFile(config.backlogRoot, indexPath, (fm) => {
      // Re-checked on the file read in the hold.
      if (fm.status === 'done' || fm.status === 'superseded') {
        closedAs = fm.status;
        return false;
      }
      fm.commit = commit;
      fm.status = status;
      fm.completed = today;
      // Final reconciliation pass — picks up token totals for any session that
      // exited without launchSession's post-spawn hook running (e.g. hard kill).
      // Worktrees may already be cleaned up; that's fine — provider transcripts
      // live under ~/.claude/projects keyed by path and survive worktree removal.
      try {
        applyTokensToFrontmatter(fm, collectStoryTokens(parsed.id, config));
      } catch {
        // non-fatal
      }
      written = fm;
    });
  } catch (err) {
    console.error(`bl done: could not write ${backlogRel}: ${err.message}`);
    process.exit(1);
  }
  if (closedAs) {
    console.error(`Story ${parsed.id} is already marked ${closedAs}.`);
    process.exit(1);
  }
  info(`Updated : ${backlogRel}  (status=${status}, commit=${commitForLog}, completed=${today})`);

  info('Syncing backlog...');
  let res;
  try {
    res = await syncAndCommit(config, {
      message: `chore: mark ${parsed.id} ${status}`,
      storyIds: [parsed.id],
    });
  } catch (err) {
    exitOnSyncError(err);
  }
  reportBacklogCommit(res, 'bl done');

  return { fm: written, unitRepo, componentEntry, storyEntry };
}
