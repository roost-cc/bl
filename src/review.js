/**
 * review.js — what `bl review` needs from a story's branch and PRs.
 *
 * `bl review S-n` runs the loop's review step (`cmdReviewStory` in
 * feature-cmd.js, F-35 decision I): two dimension passes and a verifier on
 * the review agent, one session in the story's Review Log. This module keeps
 * the pieces it shares with `bl review F-n`: bringing a branch up to date
 * with main before the round, and saying why there is no open PR to review.
 */

import { gitOut, interruptKept, raiseAfter } from './child.js';
import { findExistingWorktree } from './story.js';
import { unitLabel } from './unit.js';

/**
 * Bring a story worktree's branch up to date with main before reviewing it.
 *
 * While stories are reviewed one at a time, `bl merge` on the earlier ones
 * advances main — so a later story's branch falls behind and its diff against
 * main fills up with the other stories' (reverted-looking) changes. Merging the
 * latest main into the branch first keeps the review diff and test run focused
 * on this story's actual changes.
 *
 * On a clean merge the branch is pushed so the open PR reflects the integrated
 * diff; a push failure (offline, no remote, non-fast-forward) is non-fatal and
 * recorded in `pushed`.
 *
 * Never throws, and exits only on an interrupt: a fetch/merge failure degrades
 * to "review the branch as-is". Conflicts are deliberately left UNRESOLVED — the
 * merge is aborted and resolution is the implementing agent's job, not the
 * reviewer's. A dirty worktree (e.g. an in-flight workon session) is skipped
 * untouched.
 *
 * Each git child runs through `src/child.js`, so SIGINT or SIGTERM that ends
 * one ends `bl` (F-114 D2). The merge and its abort run in one `raiseAfter`
 * (F-124 D3): an interrupted merge is aborted first, then raised.
 *
 * @returns {{ status: "merged"|"current"|"conflict"|"dirty"|"skip",
 *             ref: string, pushed?: boolean }}
 */
export function syncBranchWithMain(worktreePath) {
  // Prefer the freshest remote main; fall back to local main when offline or
  // there's no origin (local-only development).
  let ref = 'main';
  try {
    gitOut(worktreePath, ['fetch', 'origin', 'main']);
    gitOut(worktreePath, ['rev-parse', '--verify', 'origin/main']);
    ref = 'origin/main';
  } catch {
    // no origin / offline — local main it is
  }

  try {
    if (gitOut(worktreePath, ['status', '--porcelain'])) return { status: 'dirty', ref };
  } catch {
    return { status: 'skip', ref };
  }

  try {
    if (gitOut(worktreePath, ['rev-list', '--count', `HEAD..${ref}`]) === '0') {
      return { status: 'current', ref };
    }
  } catch {
    return { status: 'skip', ref };
  }

  const merged = raiseAfter(() => {
    try {
      gitOut(worktreePath, ['merge', '--no-edit', ref]);
      return true;
    } catch {
      try {
        gitOut(worktreePath, ['merge', '--abort']);
      } catch (e) {
        // Nothing to abort, or already clean. Under an interrupt the line goes
        // out before the raise, since no caller sees the result then.
        if (interruptKept()) process.stderr.write(`bl: ${worktreePath}: ${e.message}\n`);
      }
      return false;
    }
  });
  if (!merged) return { status: 'conflict', ref };

  // Clean merge: push so the open PR shows the integrated diff. A push failure
  // (offline, no origin, non-fast-forward) keeps the local merge and is just
  // reported — the review still runs against the integrated tree.
  let pushed = false;
  try {
    gitOut(worktreePath, ['push', 'origin', 'HEAD']);
    pushed = true;
  } catch {
    // non-fatal — leave the merge local
  }
  return { status: 'merged', ref, pushed };
}

/**
 * Explain on stderr why a unit has no open PR to review: per repo searched,
 * a PR that already merged (S-788: it merged before review), else whether a
 * worktree exists and why the forge found nothing.
 *
 * @param {{ id: string, kind?: string }} unit  a story, batch or feature record
 * @param {{ searched: Array<{ repoName: string, repoPath: string, hasPR: boolean, reason?: string }>,
 *   merged: Array<{ repoName: string, number: number, url: string, headRefOid: string }> }} found
 *   what `findUnitPRs` returned
 * @param {string} branchName the unit's branch
 */
export function reportNoOpenPR(unit, { searched, merged }, branchName) {
  console.error(`\nNo open PR found for ${unitLabel(unit).toLowerCase()} ${unit.id}.`);
  const mergedByRepo = new Map(merged.map((m) => [m.repoName, m]));
  if (searched.length === 0) {
    console.error('  (no repos configured for this backlog)');
  } else {
    for (const s of searched) {
      const m = mergedByRepo.get(s.repoName);
      if (m) {
        console.error(
          `  - ${s.repoName}: PR #${m.number} (${m.url}) already merged at ${String(m.headRefOid).slice(0, 7)}; it was merged before review`,
        );
        continue;
      }
      const wt = findExistingWorktree(s.repoPath, branchName);
      const wtPart = wt ? 'worktree present' : 'no worktree';
      const prPart = s.reason ? `forge ${s.reason}` : 'no PR';
      console.error(`  - ${s.repoName}: ${wtPart}, ${prPart}`);
    }
  }
  if (merged.length > 0) {
    console.error('\nReview was skipped: the PR merged first. See S-789 for retrospective review.');
  } else {
    console.error(`\nCommit and push the branch, then run \`bl review ${unit.id}\` again: it opens the PR.`);
  }
}
