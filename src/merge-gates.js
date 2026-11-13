/**
 * merge-gates.js — the one set of gates `bl merge` applies to a story and a
 * feature alike (F-36 D1, D3), before any repo is touched.
 *
 * `mergeGates` returns findings and never exits; the caller prints each
 * finding's message and exits 1. Kind-specific preconditions (a feature must
 * have started, `isFeatureBranched`) and post-merge bookkeeping stay with the
 * callers, `main` in cleanup.js and `cmdMerge` in feature-cmd.js.
 */

import { configForRepo, findChange } from './config.js';
import { listWorktrees } from './story.js';
import { featureReviewGate, reviewBlockedMessage } from './review-log.js';
import { extractSection, sectionHasContent, featureBranchName } from './feature.js';
import { commitsAhead, preflightMainCheckouts } from './cleanup.js';
import { heldBy } from './blockers.js';
import { reviewSkipped } from './scripted.js';
import { reviewOf } from './transition.js';
import { REVIEW } from './flow.js';

/**
 * The branch a unit merges: a story's is its directory name, lower case; a
 * feature's is the one its change document names, else the one derived from
 * its directory.
 */
export function unitBranch(unit) {
  if (unit.kind === 'story') return unit.storyEntry.toLowerCase();
  return unit.branch || featureBranchName(unit.featureEntry);
}

/**
 * The branch's PRs merged on the forge, per repo, through `change.find`. A
 * repo whose forge has no `change.find` (or whose op fails) adds nothing.
 *
 * @returns {Array<{ repoName: string, number: number|string, url: string, headRefOid: string }>}
 */
function forgeMergedPRs(repos, branchName, config, find) {
  const out = [];
  for (const repoName of repos) {
    const repoPath = config.reposByName[repoName];
    if (!repoPath) continue;
    let found;
    try {
      found = find(branchName, { config: configForRepo(config, repoName), repoPath });
    } catch {
      continue;
    }
    if (!found?.ok) continue;
    for (const p of found.prs) {
      if (p.state === 'MERGED')
        out.push({ repoName, number: p.number, url: p.url ?? '', headRefOid: p.headRefOid ?? '' });
    }
  }
  return out;
}

/** A forge-merged PR as the refusal and the `## Merge` line name it. */
function prLine(p) {
  return `${p.repoName}: PR #${p.number}${p.url ? ` (${p.url})` : ''} merged on the forge at ${p.headRefOid || 'an unknown commit'} before any review`;
}

/**
 * Every gate `bl merge` applies to a unit, in order: an unmet
 * `blockers.json` edge at the unit's `merge` gate, on it or, for a feature,
 * on one of its stories (`blocker`, one finding per edge, F-66 D3), the
 * review state, a unit never reviewed (D3), `## Escalation`, a worktree on
 * the unit's branch in a repo it does not own, and, only when nothing else
 * refused it, every target main checkout on `main` (`preflightMainCheckouts`,
 * which prints its own detail and with `--switch-main` may switch a stale
 * checkout back).
 *
 * The review rule is `featureReviewGate` for both kinds: blocked while the
 * unit's review position (`reviewOf`) is `fixing` or `in_review`, whatever
 * its status (F-69 D5), or the latest Review Log
 * session has an open Must or Should box; `ready_for_merge` and open nits
 * pass. The refusal is `reviewBlockedMessage`, shared with `bl done`. A unit with no Review Log session
 * is refused unless `args["no-review"]`; then `unreviewed` carries what the
 * change document's `## Merge` records (`noReviewLines`). A scripted story
 * without `review: true` is not refused: it has no review to wait for (F-71 D3).
 * Neither is a story at `ready_for_merge` with no session whose branch has no
 * commits in any repo (`noCommits`, S-1437): `bl run` finished it without a
 * pull request, and there is nothing to review or merge.
 *
 * @param {object} unit — a `storyUnit` or `featureUnit`: its `status` and `round` are its log's,
 *   and its `fm` and `change` give its review position
 * @param {{ config: object, args?: object, repos: string[], find?: Function, preflight?: Function, held?: Function }} opts
 *   `repos` are the unit's repos, lead first (`featureRepoOrder`); `held(id)` is the gate
 *   check, `heldBy` at `merge` by default
 * @returns {{ findings: Array<{ gate: string, message: string }>, unreviewed: null | { prs: object[] }, noCommits: boolean }}
 */
export function mergeGates(
  unit,
  {
    config,
    args = {},
    repos,
    find = findChange,
    preflight = preflightMainCheckouts,
    held = (id) => heldBy(config, id, 'merge'),
  },
) {
  const findings = [];
  const id = unit.id;
  const branchName = unitBranch(unit);
  let unreviewed = null;

  // No override flag: the blocker moves on, or `bl block remove` lifts the hold.
  for (const { edge, line } of held(id)) {
    findings.push({
      gate: 'blocker',
      message: `${line}: ${id} merges once ${edge.blocker} meets "${edge.until}" (bl status ${edge.blocker}).`,
    });
  }

  // The review position, whatever the status: an escalated unit keeps its open items (F-69 D5).
  const { position } = reviewOf(unit.kind, unit.fm, unit.change ?? null);
  const { blocked, review } = featureReviewGate(position, unit.changeBody ?? '');
  // A story `bl run` finished with nothing on its branch (S-1437): the run
  // recorded ready_for_merge without a round, and there is nothing to review.
  // The current status decides, not the position: a later in_progress or
  // escalated keeps the position at ready_for_merge.
  const noCommits =
    !review &&
    unit.kind === 'story' &&
    unit.status === REVIEW.clean &&
    position === REVIEW.clean &&
    repos.every((r) => commitsAhead(config.reposByName[r], branchName) === 0);
  if (blocked) {
    findings.push({
      gate: 'review',
      message: reviewBlockedMessage({
        id,
        state: unit.status,
        round: unit.round ?? 0,
        review,
        position,
        action: 'merging',
      }),
    });
  } else if (!review && !noCommits && !(unit.kind === 'story' && reviewSkipped(unit.fm))) {
    // Never reviewed (D3). The PR lookup only sharpens the message; a forge
    // without `change.find` still gets the refusal.
    const prs = forgeMergedPRs(repos, branchName, config, find);
    if (args['no-review']) {
      unreviewed = { prs };
    } else {
      findings.push({
        gate: 'never-reviewed',
        message: [
          `${id} has never been reviewed — run \`bl review ${id}\` (or \`bl run ${id}\`), or pass --no-review to merge without one.`,
          ...prs.map(prLine),
        ].join('\n'),
      });
    }
  }

  const escalation = extractSection(unit.body ?? '', 'Escalation');
  if (sectionHasContent(escalation)) {
    findings.push({
      gate: 'escalation',
      message: `${id} has an open Escalation section — resolve it and set it back to "None." before merging:\n${escalation.trim()}`,
    });
  }

  // A worktree on the unit's branch in a repo the unit does not own is work
  // no story here owns: refused, never merged or left behind silently.
  // A second name on a target repo's path is that repo, not a stray.
  const seen = new Set(repos.map((r) => config.reposByName?.[r]).filter(Boolean));
  const strays = [];
  for (const [repoName, repoPath] of Object.entries(config.reposByName ?? {})) {
    if (repos.includes(repoName) || seen.has(repoPath)) continue;
    seen.add(repoPath);
    if (listWorktrees(repoPath).some((w) => w.branch === branchName)) strays.push(repoName);
  }
  if (strays.length > 0) {
    const one = strays.length === 1;
    findings.push({
      gate: 'stray-worktree',
      message: `${id} has a worktree on ${branchName} in ${strays.join(', ')}, but its ${repos.length === 1 ? 'repo is' : 'repos are'} ${repos.join(', ')}. Work in another repo is another story: merge or remove ${one ? 'that worktree' : 'those worktrees'} by hand, then rerun.`,
    });
  }

  if (findings.length === 0) {
    const res = preflight({
      targets: repos.map((repoName) => ({
        repoName,
        repoPath: config.reposByName[repoName],
        config: configForRepo(config, repoName),
      })),
      switchMain: !!args['switch-main'],
      branchName,
    });
    if (!res.ok) {
      const off = [...new Set((res.findings ?? []).map((f) => f.repoName))];
      findings.push({
        gate: 'main-checkout',
        message: `${id}: the main checkout of ${off.join(', ') || 'a target repo'} is not on main (above).`,
      });
    }
  }

  return { findings, unreviewed, noCommits };
}

/**
 * The `## Merge` lines a merge with `--no-review` appends: the operator's
 * choice, then each PR the forge merged before any review.
 *
 * @param {{ prs: object[] } | null} unreviewed
 * @param {string} date
 */
export function noReviewLines(unreviewed, date) {
  if (!unreviewed) return [];
  return [
    `- Merged without review (operator, ${date})`,
    ...unreviewed.prs.map(
      (p) =>
        `- ${p.repoName}: PR #${p.number} merged on the forge at ${p.headRefOid || 'an unknown commit'} before any review`,
    ),
  ];
}

/** Print every finding to stderr; true when there was one. */
export function reportMergeGates({ findings }) {
  for (const f of findings) console.error(f.message);
  return findings.length > 0;
}
