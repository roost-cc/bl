/**
 * schedule.js — which of several targets start now, and which wait.
 *
 * `bl run|implement <id...>` start only units that neither depend on nor
 * overlap another unmerged unit (F-35 Design §5, decision F):
 *
 * - A unit whose stories wait for a story of another target, or a story
 *   outside the targets that is not done, is deferred, naming the blocker.
 *   A story waits for the blockers of the run and order edges on it
 *   (`storyDependencies` of `readEdges`, F-111 D4).
 * - Of the rest, lowest id first, a unit whose files overlap a unit already
 *   started is deferred, naming the shared files. One branch per unit and no
 *   stacking: two units that touch one file would conflict at merge.
 *
 * A unit's files are its branch diff against main once the branch has
 * commits, else the backticked paths in its stories' Implementation Plans
 * outside `### Sources of truth` (a feature: the union over its stories), each
 * keyed by repo.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { reposForStory } from './story.js';
import { readEdges, storyDependencies } from './blockers.js';
import { reposForFeature } from './feature.js';
import { byId, featureRepoOrder, planFiles, sameFiles, storyOwners, unitStories } from './execution-plan.js';

/**
 * `repo:path` for every file the branches in `worktrees` change against
 * main. `complete` is false when a worktree is missing or its diff fails:
 * `files` then holds only what the other repos changed.
 *
 * @param {{ repoName: string, worktreePath: string }[]} worktrees
 * @returns {{ files: Set<string>, complete: boolean }}
 */
export function branchFiles(worktrees) {
  const out = new Set();
  let complete = true;
  for (const { repoName, worktreePath } of worktrees) {
    if (!existsSync(worktreePath)) {
      complete = false;
      continue;
    }
    let diff;
    try {
      // -z: paths verbatim, not C-quoted, so they compare equal to plan paths.
      diff = execFileSync('git', ['-C', worktreePath, 'diff', '--name-only', '-z', 'main...HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      complete = false;
      continue;
    }
    for (const path of diff.split('\0').filter(Boolean)) out.add(`${repoName}:${path}`);
  }
  return { files: out, complete };
}

/**
 * The files a unit touches: its branch diff once the branch has commits in
 * a diff that read every repo, else its plan paths. A partial diff (a repo
 * missing or unreadable) is not the whole branch: it adds to the plan paths.
 * @returns {Set<string>}
 */
export function unitFiles(unit, config, all) {
  const worktrees =
    unit.kind === 'feature'
      ? reposForFeature(unit.record, config, unitStories(unit, config, all))
      : reposForStory(unit.id, config);
  const fromBranch = branchFiles(worktrees);
  if (fromBranch.complete && fromBranch.files.size > 0) return fromBranch.files;
  const stories = unitStories(unit, config, all);
  const defaultRepo = unit.kind === 'feature' ? (featureRepoOrder(stories)[0] ?? '') : unit.record.unitRepo || '';
  const files = planFiles(stories, defaultRepo);
  for (const f of fromBranch.files) files.add(f);
  return files;
}

/** "src/a.js, src/b.js and 2 more", repo names dropped when there is one repo. */
function describeFiles(keys) {
  const repos = new Set(keys.map((k) => k.slice(0, k.indexOf(':'))));
  const shown = keys.map((k) => (repos.size > 1 ? k : k.slice(k.indexOf(':') + 1)));
  if (shown.length <= 3) return shown.join(', ');
  return `${shown.slice(0, 3).join(', ')} and ${shown.length - 3} more`;
}

/**
 * Decide which units start and which wait.
 *
 * @param {Array<{ kind: string, id: string, record: object }>} units
 * @param {object[]} all  every story (`readAllStories`)
 * @param {import("./flow.js").Flow} flow
 * @param {{ config: object, files?: (unit) => Set<string> }} opts
 *   `config` is the backlog's, for its edges (`readEdges`); `files`
 *   defaults to `unitFiles`, a test seam.
 * @returns {{ start: object[], deferred: Array<{ id: string, reason: string,
 *             blockers: string[] }> }}
 */
export function schedule(units, all, flow, { config, files = (u) => unitFiles(u, config, all) }) {
  const sorted = [...units].sort(byId);
  const statusById = new Map(all.map((s) => [s.id, s.status]));
  const { owner, storiesOf } = storyOwners(sorted, config, all);
  const waits = storyDependencies(readEdges(config));

  const deferred = [];
  const candidates = [];
  for (const u of sorted) {
    const reasons = [];
    const blockers = [];
    for (const s of storiesOf.get(u)) {
      for (const dep of waits.get(s.id) ?? []) {
        const other = owner.get(dep);
        // A merged dependency blocks nothing, even when it is among the targets.
        if (other === u || flow.meets('story', statusById.get(dep), 'done')) continue;
        const via = s.id === u.id ? u.id : `${u.id}: ${s.id}`;
        if (other) {
          const name = other.id === dep ? dep : `${dep} (in ${other.id})`;
          reasons.push(`${via} depends on ${name}; run it after ${other.id} merges`);
          blockers.push(other.id);
        } else {
          reasons.push(`${via} depends on ${dep}, which is ${statusById.get(dep) ?? 'missing'}; merge ${dep} first`);
          blockers.push(dep);
        }
      }
    }
    if (reasons.length > 0) deferred.push({ id: u.id, kind: u.kind, reason: reasons.join('; '), blockers });
    else candidates.push(u);
  }

  // Overlap is checked against the units that start: a deferred unit starts
  // later from a main that already holds the earlier merge.
  const start = [];
  const started = [];
  for (const u of candidates) {
    const mine = files(u);
    const clashes = started
      .map(({ unit, set }) => ({ unit, shared: [...mine].filter((f) => [...set].some((g) => sameFiles(f, g))).sort() }))
      .filter((c) => c.shared.length > 0);
    if (clashes.length > 0) {
      const ids = clashes.map((c) => c.unit.id);
      const on = clashes.map((c) => `${c.unit.id} on ${describeFiles(c.shared)}`).join(' and ');
      deferred.push({
        id: u.id,
        kind: u.kind,
        reason: `${u.id} overlaps ${on}; run it after ${ids.join(' and ')} ${ids.length === 1 ? 'merges' : 'merge'}`,
        blockers: ids,
      });
      continue;
    }
    start.push(u);
    started.push({ unit: u, set: mine });
  }
  deferred.sort(byId);
  return { start, deferred };
}
