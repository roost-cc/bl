/**
 * story.js — story and component discovery.
 *
 * Stories live in `stories/S<n>-<slug>/`, components in
 * `components/C<nn>-<slug>/` (F-49 D3). Story IDs and component IDs are both
 * globally unique across the backlog repo.
 *
 * The readers here (`readAllStories`, `readComponents`, `findStoryDir`,
 * `findComponentDir` and the next-id lookups) are projections of
 * `loadBacklog()`'s units into their record shapes (F-77 D2): none lists or
 * reads a unit directory itself.
 */

import { existsSync, readdirSync, rmdirSync } from 'fs';
import { join, matchesGlob } from 'path';
import { execSync } from 'child_process';
import { graphOf } from './backlog-graph.js';
import { holderOf } from './kernel-lock.js';
import { dirLockPath } from './lock.js';
import {
  listMembers,
  listValue,
  normalizeId,
  normalizeComponentId,
  worktreePathFor,
  unitDirFor,
  findChange,
  STORIES_DIR,
  COMPONENTS_DIR,
} from './config.js';
import { storyEffort } from './effort.js';

export { normalizeId, normalizeComponentId };

/**
 * The session lock of the directory `dir` a session runs in (a unit
 * directory, F-60 D3, or the backlog root for a refine): one file per
 * directory under the backlog's `.bl/lock/` (`dirLockPath`, S-1495).
 *
 * @param {string} backlogRoot
 * @param {string} dir
 */
export function sessionLockPath(backlogRoot, dir) {
  return dirLockPath(backlogRoot, 'session', dir);
}

/**
 * A parsed list key of story IDs (`depends_on: [S-1, S-2]`, F-62 D2): the
 * sequence's string members, each normalised through `normalizeId` so `S1`,
 * `s-1`, `S-1` all collapse to `S-1`; members that don't normalise are passed
 * through as-is so downstream callers (e.g. dangling-dep checks) can flag
 * them. An absent or empty key is `[]`; a value that is not a list of
 * strings (a scalar, a mapping, a mapping member) throws
 * `FrontmatterListError`, which `bl validate` reports as `frontmatter-list`.
 */
export function parseIdList(raw) {
  return listMembers(raw)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeId(s)?.id ?? s);
}

/**
 * Refuse `--repo` (`-r`) on a story verb (`bl implement|review|merge|run
 * S-n`): a story's one repo is its component's (F-52 D1), so there is no
 * other repo to pick. Exits 1 naming the option.
 *
 * @param {string} verb
 * @param {{ repo?: unknown }} args  parsed arguments
 */
export function refuseStoryRepo(verb, args) {
  if (args.repo == null || args.repo === false) return;
  console.error(`bl ${verb}: unknown option "--repo" for a story: a story's repo is its component's.`);
  process.exit(1);
}

/**
 * A story's one repo, its component's (`unitRepo`, F-52 D1), or exit 1
 * naming the component when it has none. Frontmatter is never read for it.
 *
 * @param {{ id: string }} parsed
 * @param {{ unitRepo: string, componentId: string, componentEntry: string }} found  a `findStoryDir` hit
 * @returns {string}
 */
export function storyRepoOrExit(parsed, found) {
  if (found.unitRepo) return found.unitRepo;
  const component = found.componentId || '(none)';
  const why = found.componentEntry ? 'names no repo' : 'is not found under components/';
  console.error(
    `Story ${parsed.id} has no repo: its component ${component} ${why}. A story's repo is its component's; set \`repo:\` on the component or move the story to a component that has one.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Layout (F-49 D3): stories/, components/ and features/ at the backlog root.
// A unit's directory never moves; its status is frontmatter only.
// ---------------------------------------------------------------------------

export function storiesRoot(config) {
  return join(config.backlogRoot, STORIES_DIR);
}

export function componentsRoot(config) {
  return join(config.backlogRoot, COMPONENTS_DIR);
}

/** Whether a directory name is the unit `parsed` names (`S12` or `S12-<slug>`). */
export function entryMatches(entry, parsed) {
  return entry === parsed.dirPrefix || entry.startsWith(parsed.dirPrefix + '-');
}

/**
 * A graph unit's frontmatter as a reader record carries it: a copy the
 * caller owns and may change, since the graph's is frozen and shared.
 */
export function ownFm(unit) {
  return structuredClone(unit.fm);
}

// ---------------------------------------------------------------------------
// Component paths (F-52 D4): globs relative to the component's repo root.
// ---------------------------------------------------------------------------

/**
 * A `paths:` member that is not a glob string (a YAML list or mapping), or a
 * `paths:` that is not a list. It is kept, not dropped, so `pathEntryProblem`
 * reports it; it reads as its JSON text.
 */
class InvalidPath {
  constructor(text, problem) {
    this.text = text;
    this.problem = problem;
  }
  toString() {
    return this.text;
  }
}

/**
 * A component's parsed `paths:` (F-62 D2): null when the key is absent, `[]`
 * when it is present but empty (`paths:` or `paths: []`), so `bl validate`
 * can tell the two apart. Nothing is dropped or coerced: an empty member
 * stays `''`, a member that is not a string (a nested list or mapping) stays
 * as an `InvalidPath`, and so does a `paths:` that is not a list, so
 * `pathEntryProblem` reports each.
 * @returns {Array<string | InvalidPath> | null}
 */
export function parsePathList(raw) {
  if (raw == null) return null;
  const list = listValue(raw);
  if (list == null) return [new InvalidPath(JSON.stringify(raw), 'is not a list (write paths: ["<glob>", …])')];
  return list.map((s) => (typeof s === 'string' ? s.trim() : new InvalidPath(JSON.stringify(s), 'is not a string')));
}

/**
 * Why `glob` is not a valid `paths:` entry, or null when it is: a non-empty
 * glob relative to the repo root, not absolute and with no `..` segment. A
 * `.` segment (`./src/**`) is refused too: `git diff` names no path that
 * way, so the entry would never match.
 */
export function pathEntryProblem(glob) {
  if (glob instanceof InvalidPath) return glob.problem;
  if (typeof glob !== 'string') return 'is not a string';
  if (glob.trim() === '') return 'is empty';
  if (glob.startsWith('/') || /^[A-Za-z]:[\\/]/.test(glob)) return 'is absolute';
  const segments = glob.split(/[\\/]/);
  if (segments.includes('..')) return 'contains ".."';
  if (segments.includes('.')) return 'contains a "." segment';
  return null;
}

// Node's `path.matchesGlob` has no `dot` option: `*` and `**` skip a segment
// that starts with a dot. A component's `**` must cover `.github/…` too, so
// both sides swap a segment's leading dot for a byte no path holds.
const DOT = '\u0001';
const undot = (s) =>
  s
    .split('/')
    .map((seg) => (seg.startsWith('.') ? DOT + seg.slice(1) : seg))
    .join('/');

/** Whether repo-relative `file` matches one of `globs` (dotfiles included). */
export function pathMatches(file, globs) {
  const f = undot(file);
  return (globs ?? []).some((g) => typeof g === 'string' && matchesGlob(f, undot(g)));
}

/**
 * Every component under `components/`. `paths` is the parsed `paths:` list,
 * null when the component has none.
 * @returns {Array<{ id: string, title: string, repo: string, home: boolean,
 *   paths: string[] | null, componentEntry: string, componentDir: string,
 *   indexPath: string, fm: object }>}
 */
export function readComponents(config) {
  return graphOf(config).list('component').map(componentRecord);
}

/** A component unit as `readComponents` returns it. */
function componentRecord(unit) {
  const fm = ownFm(unit);
  return {
    id: normalizeComponentId(fm.component_id)?.id ?? unit.entry.match(/^(C\d+)/)[1],
    title: fm.title ?? '',
    repo: String(fm.repo ?? ''),
    home: fm.home === true || fm.home === 'true',
    paths: parsePathList(fm.paths),
    componentEntry: unit.entry,
    componentDir: unit.dir,
    indexPath: unit.file,
    fm,
  };
}

/**
 * Find a component by parsed ID (`normalizeComponentId`): the first
 * directory named for it.
 * @returns {{ id, title, repo, home, componentEntry, componentDir, indexPath, fm } | null}
 */
export function findComponentDir(parsed, config) {
  if (!parsed) return null;
  const unit = graphOf(config)
    .list('component')
    .find((u) => entryMatches(u.entry, parsed));
  return unit ? componentRecord(unit) : null;
}

/**
 * A repo's home component (F-49 D4): the component with `home: true` whose
 * `repo` is `repoName`, where work with no better component lands. The first
 * by number when several claim it (`bl validate` reports that), else null.
 */
export function homeComponent(config, repoName) {
  if (!repoName) return null;
  return readComponents(config).find((c) => c.home && c.repo === repoName) ?? null;
}

/**
 * A story's component and repo. The component is the one its `component:`
 * names; the story's one repo (`unitRepo`) is that component's `repo`, empty
 * when the component is unknown or has none (F-52 D1). A leftover
 * `primary_repo` or `secondary_repos` in the frontmatter is never read. The
 * repo keys the story's per-repo config and plugin layer (F-51 D4).
 */
function placeStory(fm, graph) {
  const componentId = normalizeComponentId(fm.component ?? '')?.id ?? '';
  // The graph's components by id: when two directories claim one, the first
  // wins (`bl validate` reports the clash as `duplicate-id`).
  const component = graph.components.get(componentId) ?? null;
  const unitRepo = String(component?.fm.repo ?? '');
  return { componentId, componentEntry: component?.entry ?? '', unitRepo };
}

// ---------------------------------------------------------------------------
// Story finding
// ---------------------------------------------------------------------------

/**
 * Find a story by ID under `stories/`: the first directory named for it.
 * @returns {{ unitRepo, componentId, componentEntry, storyEntry, storyDir, indexPath } | null}
 */
export function findStoryDir(parsed, config) {
  if (!parsed) return null;
  const graph = graphOf(config);
  const hit = graph.list('story').find((u) => entryMatches(u.entry, parsed));
  if (!hit) return null;
  return { ...placeStory(hit.fm, graph), storyEntry: hit.entry, storyDir: hit.dir, indexPath: hit.file };
}

// ---------------------------------------------------------------------------
// Worktree detection (across all repos in the config)
// ---------------------------------------------------------------------------

/**
 * List all story worktrees for a given repo path.
 * @returns {{ path, branch }[]}
 */
export function listWorktrees(repoPath) {
  const results = [];
  if (!existsSync(repoPath)) return results;
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const entry of output.split('\n\n').filter(Boolean)) {
      const lines = entry.split('\n');
      const pathLine = lines.find((l) => l.startsWith('worktree '));
      const branchLine = lines.find((l) => l.startsWith('branch '));
      if (!pathLine || !branchLine) continue;
      const wPath = pathLine.slice('worktree '.length);
      const wBranch = branchLine.slice('branch refs/heads/'.length);
      if (wPath !== repoPath) results.push({ path: wPath, branch: wBranch });
    }
  } catch {
    // no worktrees or not a git repo
  }
  return results;
}

/** Find an existing worktree by branch name in a specific repo. */
export function findExistingWorktree(repoPath, branchName) {
  return listWorktrees(repoPath).find((w) => w.branch === branchName) ?? null;
}

/**
 * Remove a unit directory (`unitDirFor`, F-60 D2) once its last worktree is
 * gone, when it is empty. One that holds anything stays, and so does one that
 * is not there. Never throws: a directory that cannot be read or removed
 * stays.
 * @returns {boolean} whether the directory was removed
 */
export function removeUnitDirIfEmpty(unitDir) {
  try {
    if (readdirSync(unitDir).length) return false;
    rmdirSync(unitDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a session running in `dir` (a unit directory, F-60 D3)? Whether a process,
 * this one included, holds its session lock (`sessionLockPath`; a try-lock,
 * F-104 D6).
 */
export function isSessionRunning(backlogRoot, dir) {
  return holderOf(sessionLockPath(backlogRoot, dir)) != null;
}

/**
 * Gather all active worktrees across every repo in the config.
 * @returns {{ storyId, repoName, repoPath, path, branch }[]}
 */
export function allActiveWorktrees(config) {
  const out = [];
  const seen = new Set();
  for (const { name, path } of Object.values(config.repos ?? {})) {
    if (seen.has(path)) continue;
    seen.add(path);
    for (const { path: wtPath, branch } of listWorktrees(path)) {
      const m = branch.match(/^s(\d+)/);
      const storyId = m ? `S-${m[1]}` : null;
      out.push({
        storyId,
        repoName: name,
        repoPath: path,
        path: wtPath,
        branch,
      });
    }
  }
  return out;
}

/**
 * A story's repo as a one-entry list: its component's repo (`unitRepo`,
 * F-52 D1), with the worktree path the story would use there (existence is
 * the caller's concern). Empty when the story is unknown, its component has
 * no `repo`, or that repo is not registered.
 *
 * Used by every story-aware caller (bootstrap, format, lint, …) so each sees
 * the same repo without re-deriving it.
 *
 * @param {string} storyId
 * @returns {{ repoName: string, repoPath: string, worktreePath: string,
 *             unitRepo: string, componentEntry: string, storyEntry: string,
 *             indexPath: string }[]}
 */
export function reposForStory(storyId, config) {
  const parsed = normalizeId(storyId);
  if (!parsed) return [];
  const found = findStoryDir(parsed, config);
  if (!found) return [];

  const name = found.unitRepo;
  const repoPath = name ? config.reposByName[name] : null;
  if (!repoPath) return [];
  return [
    {
      repoName: name,
      repoPath,
      worktreePath: worktreePathFor(config, name, found.storyEntry.toLowerCase()),
      unitDir: unitDirFor(config, found.storyEntry.toLowerCase()),
      unitRepo: found.unitRepo,
      componentEntry: found.componentEntry,
      storyEntry: found.storyEntry,
      indexPath: found.indexPath,
    },
  ];
}

/**
 * A unit's PRs, keyed by repo and branch (F-42 D4); nothing is searched by
 * title. The repos are the change document's `repos:` entries, then the
 * unit's `primaryRepo` (a story unit's is its component's) and `repos` (a
 * feature's derived repos; only `opts.repo` when given). Per
 * repo, the PR is the one the change document records, its state read from
 * `change.find`'s list for the branch; a repo with none recorded takes the
 * first PR `change.find` lists. An open PR goes to `prs`, a merged one to
 * `merged` (S-788: it merged before review), a closed one nowhere.
 *
 * Never throws. Without a usable forge a recorded PR counts as open, and a
 * repo with none recorded is reported in `searched` with the forge's reason
 * (`no-forge`, `no-op`, `failed`, …).
 *
 * @param {object} config — loaded backlog config (see `loadConfig`)
 * @param {{ branch?: string, featureEntry?: string, primaryRepo?: string,
 *   repos?: string[], change?: { repos: object[] } | null }} unit
 * @param {{ repo?: string | null, runOp?: Function }} [opts]
 * @returns {{
 *   prs: Array<{ repoName: string, repoPath: string, prNumber: number,
 *                prUrl: string, isPrimary: boolean }>,
 *   merged: Array<{ repoName: string, number: number, url: string, headRefOid: string }>,
 *   searched: Array<{ repoName: string, repoPath: string, hasPR: boolean, reason?: string }>
 * }}
 */
export function findUnitPRs(config, unit, { repo = null, runOp } = {}) {
  const branch = unit.branch || String(unit.featureEntry ?? '').toLowerCase();
  const recorded = new Map((unit.change?.repos ?? []).map((r) => [r.repo, r]));
  let names = repo ? [repo] : [...recorded.keys(), unit.primaryRepo, ...(Array.isArray(unit.repos) ? unit.repos : [])];
  names = names.filter((n, i) => n && names.indexOf(n) === i);

  const prs = [];
  const merged = [];
  const searched = [];
  for (const repoName of names) {
    const repoPath = config.reposByName?.[repoName];
    if (!repoPath) continue;
    const rec = recorded.get(repoName);
    const found = findChange(rec?.branch || branch, { config, repoPath, ...(runOp ? { runOp } : {}) });
    const listed = found.ok ? found.prs : [];
    let pr = listed[0] ?? null;
    if (rec?.pr) {
      pr = listed.find((p) => String(p.number) === String(rec.pr)) ?? { number: rec.pr, url: rec.url, state: 'OPEN' };
    }
    if (pr?.state === 'MERGED') {
      merged.push({ repoName, number: Number(pr.number), url: pr.url ?? '', headRefOid: pr.headRefOid ?? '' });
    }
    const open = pr?.state === 'OPEN';
    if (open) {
      prs.push({
        repoName,
        repoPath,
        prNumber: Number(pr.number),
        prUrl: pr.url || rec?.url || '',
        isPrimary: repoName === unit.primaryRepo,
      });
    }
    searched.push({ repoName, repoPath, hasPR: open, ...(!found.ok && !rec?.pr ? { reason: found.reason } : {}) });
  }
  return { prs, merged, searched };
}

/**
 * Map story ID → list of worktrees (a story may have multiple: primary + secondaries).
 * @returns {Map<string, { repoName, repoPath, path, branch }[]>}
 */
export function activeWorktreesByStory(config) {
  const map = new Map();
  for (const wt of allActiveWorktrees(config)) {
    if (!wt.storyId) continue;
    const list = map.get(wt.storyId) ?? [];
    list.push(wt);
    map.set(wt.storyId, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Bulk story reading
// ---------------------------------------------------------------------------

/**
 * Read every story under `stories/`. Each carries its
 * component (`componentId`, empty when `component:` is missing or malformed)
 * and its one repo (`unitRepo`, `placeStory`).
 * @returns {Array<{
 *   unitRepo, componentId, componentEntry, id, title, status, type, points, effort,
 *   requiredFor, feature, batch, found_by, added, completed,
 *   storyEntry, indexPath, storyRelPath
 * }>}
 */
export function readAllStories(config) {
  const graph = graphOf(config);
  const out = [];
  for (const unit of graph.list('story')) {
    if (!unit.fm.story_id) continue;
    const fm = ownFm(unit);
    const indexPath = unit.file;
    out.push({
      ...placeStory(fm, graph),
      id: fm.story_id,
      title: fm.title ?? '',
      // A v1 word reads as its current one (`makeUnit`, F-69 D4).
      status: unit.status,
      type: fm.type ?? '',
      points: fm.points ?? '',
      // The refiner's effort level (F-85 D1); null when the key is unset or empty.
      effort: storyEffort(fm),
      // The stories that wait for this one, in number order: the graph's
      // inverse of the run and order edges (F-77 D3, F-111 D4), never a
      // stored `required_for:`.
      requiredFor: (unit.requiredFor ?? []).map((r) => r.id),
      feature: fm.feature ?? '',
      // The story batch it is in (F-125 D1); a story names a feature or a batch.
      batch: fm.batch ?? '',
      found_by: fm.found_by ?? '',
      added: fm.added ?? '',
      completed: fm.completed ?? '',
      // Present only on a scripted story: `isScripted` reads the key (F-71 D3).
      ...(Object.hasOwn(fm, 'plugins-implement') ? { 'plugins-implement': fm['plugins-implement'] } : {}),
      review: fm.review,
      // The whole frontmatter, for `bl list --json`.
      frontmatter: fm,
      storyEntry: unit.entry,
      indexPath,
      storyRelPath: indexPath.slice(config.backlogRoot.length + 1),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Max story ID
// ---------------------------------------------------------------------------

/**
 * Find the highest story number in the backlog: every story directory's,
 * readable or not, and every story id (`maxNum`), and any active worktree
 * branch's, which may hold a newer id.
 */
export function findMaxStoryNum(config) {
  let max = Number(graphOf(config).maxNum('story') ?? 0);
  for (const wt of allActiveWorktrees(config)) {
    if (!wt.storyId) continue;
    const m = wt.storyId.match(/^S-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/**
 * Return `count` consecutive next story IDs as an array of `S-<n>` strings.
 * Pure query — does not reserve anything. Callers that need atomicity must
 * hold the `bl new` lock while computing and consuming the result.
 */
export function nextStoryNums(config, count) {
  const start = findMaxStoryNum(config) + 1;
  const out = [];
  for (let i = 0; i < count; i++) out.push(`S-${start + i}`);
  return out;
}

/**
 * The next component number: one past the highest `C<nn>` directory under
 * `components/` (`maxNum`; 0n on an empty backlog). A BigInt, so a number
 * past 2^53 does not round onto an existing component.
 * @returns {bigint}
 */
export function findNextComponentNum(config) {
  const max = graphOf(config).maxNum('component');
  return max == null ? 0n : max + 1n;
}
