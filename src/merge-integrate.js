/**
 * merge-integrate.js — `bl merge`'s step between the gates and the first
 * merge into main (F-36 D4), the same for a story and a feature: the prep
 * `integrateUnit` (feature-run.js) needs, built from the unit's existing
 * worktrees, and the call. A repo with no worktree on the branch is skipped
 * (its branch merges as it is, or was merged on the forge), as cleanup does.
 */

import { configForRepo, info, normalizeId, unitDirOf } from './config.js';
import { findExistingWorktree } from './story.js';
import { featureSessionVars } from './feature.js';
import { unitBranch } from './merge-gates.js';
import { unitVars } from './unit.js';

/**
 * The prep for `integrateUnit`, in the shape `bl review` builds: the first
 * of `repos` (merge order) with a worktree on the unit's branch leads, the
 * rest follow as `otherWorktrees`. Null when no repo has a worktree.
 *
 * @param {object} config
 * @param {object} unit — a `storyUnit` or `featureUnit`
 * @param {string[]} repos — the unit's repos, in merge order
 */
export function mergePrep(config, unit, repos) {
  const branchName = unitBranch(unit);
  const found = [];
  for (const repoName of repos) {
    const repoPath = config.reposByName[repoName];
    const wt = repoPath ? findExistingWorktree(repoPath, branchName) : null;
    if (wt) found.push({ repoName, worktreePath: wt.path });
  }
  if (found.length === 0) return null;
  const [lead, ...others] = found;
  const parsed =
    unit.kind === 'story' ? normalizeId(unit.id) : { id: unit.id, num: String(unit.id).match(/(\d+)$/)?.[1] ?? '0' };
  return {
    cfg: configForRepo(config, lead.repoName),
    worktreePath: lead.worktreePath,
    unitDir: unitDirOf(lead.worktreePath),
    branchName,
    parsed,
    ordered: [],
    // What the resolution session and the review round read (F-36 D6, D7),
    // as `bl review` gives them.
    baseVars: {
      featureId: unit.id,
      storyId: unit.id,
      title: unit.title,
      featureRelPath: unit.featureRelPath,
      featureAbsPath: unit.indexPath,
      worktreePath: lead.worktreePath,
      unitDir: unitDirOf(lead.worktreePath),
      branchName,
      targetRepo: lead.repoName,
      leadRepo: lead.repoName,
      roostDir: config.roostDir,
      backlogDir: config.backlogRoot,
      storyRepos: found.map((f) => f.repoName).join(', '),
      ...unitVars(unit),
      ...featureSessionVars(unit),
    },
    targetRepoName: lead.repoName,
    otherWorktrees: others,
  };
}

/**
 * Bring every worktree of the unit up to date with main, gate and push it
 * (`integrateUnit`). Prints why it stopped; true when the merge may go on.
 * `runner` is a test seam; by default the real one, headless unless the
 * agent has no headless mode, as `bl review` chooses.
 */
export async function integrateForMerge(config, unit, repos, { runner = null } = {}) {
  const prep = mergePrep(config, unit, repos);
  if (!prep) {
    info('Integrate: no worktree on the branch — nothing to bring up to date.');
    return true;
  }
  const { integrateUnit, defaultRunner, hasHeadlessConfiguration } = await import('./feature-run.js');
  info(`Integrate: bringing ${prep.branchName} up to date with main...`);
  const interactive = !hasHeadlessConfiguration(prep.cfg.agents);
  const result = integrateUnit({ unit, config, prep, runner: runner ?? defaultRunner({ interactive }) });
  if (result.ok) return true;
  console.error(`\n${unit.id}: integration with main stopped — ${result.reason}`);
  if (result.escalated) console.error(`See ## Escalation in ${unit.featureRelPath}.`);
  console.error('No main checkout was touched.');
  return false;
}
