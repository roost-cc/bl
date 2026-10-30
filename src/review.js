/**
 * review.js — what `bl review` needs from a story's branch and PRs.
 *
 * `bl review S-n` runs the loop's review step (`cmdReviewStory` in
 * feature-cmd.js, F-35 decision I): two dimension passes and a verifier on
 * the review agent, one session in the story's Review Log. This module keeps
 * the pieces it shares with `bl review F-n`: bringing a branch up to date
 * with main before the round, and saying why there is no open PR to review.
 */

import { execSync } from 'child_process';
import { findExistingWorktree } from './story.js';

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
 * Never throws and never exits: a fetch/merge failure degrades to "review the
 * branch as-is". Conflicts are deliberately left UNRESOLVED — the merge is
 * aborted and resolution is the implementing agent's job, not the reviewer's. A
 * dirty worktree (e.g. an in-flight workon session) is skipped untouched.
 *
 * @returns {{ status: "merged"|"current"|"conflict"|"dirty"|"skip",
 *             ref: string, pushed?: boolean }}
 */
export function syncBranchWithMain(worktreePath) {
  const run = (cmd) => execSync(cmd, { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8' });

  // Prefer the freshest remote main; fall back to local main when offline or
  // there's no origin (local-only development).
  let ref = 'main';
  try {
    run('git fetch origin main');
    run('git rev-parse --verify origin/main');
    ref = 'origin/main';
  } catch {
    // no origin / offline — local main it is
  }

  try {
    if (run('git status --porcelain').trim()) return { status: 'dirty', ref };
  } catch {
    return { status: 'skip', ref };
  }

  try {
    if (run(`git rev-list --count HEAD..${ref}`).trim() === '0') {
      return { status: 'current', ref };
    }
  } catch {
    return { status: 'skip', ref };
  }

  try {
    run(`git merge --no-edit ${ref}`);
  } catch {
    try {
      run('git merge --abort');
    } catch {
      // nothing to abort / already clean
    }
    return { status: 'conflict', ref };
  }

  // Clean merge: push so the open PR shows the integrated diff. A push failure
  // (offline, no origin, non-fast-forward) keeps the local merge and is just
  // reported — the review still runs against the integrated tree.
  let pushed = false;
  try {
    run('git push origin HEAD');
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
 * @param {string} unitId
 * @param {{ searched: Array<{ repoName: string, repoPath: string, hasPR: boolean, reason?: string }>,
 *   merged: Array<{ repoName: string, number: number, url: string, headRefOid: string }> }} found
 *   what `findUnitPRs` returned
 * @param {string} branchName the unit's branch
 */
export function reportNoOpenPR(unitId, { searched, merged }, branchName) {
  console.error(`\nNo open PR found for ${unitId.startsWith('F-') ? 'feature' : 'story'} ${unitId}.`);
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
    console.error(`\nCommit and push the branch, then run \`bl review ${unitId}\` again: it opens the PR.`);
  }
}
