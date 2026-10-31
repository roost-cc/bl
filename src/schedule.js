/**
 * schedule.js — which of several targets start now, and which wait.
 *
 * `bl run|implement <id...>` start only units that neither depend on nor
 * overlap another unmerged unit (F-35 Design §5, decision F):
 *
 * - A unit whose stories `depends_on` a story of another target, or a story
 *   outside the targets that is not done, is deferred, naming the blocker.
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
import { existsSync, readFileSync } from 'fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { parseFrontmatter } from './config.js';
import { parseIdList, reposForStory } from './story.js';
import { resolveFeatureStories, reposForFeature, featureRepoOrder, extractSection } from './feature.js';
import { idNum } from './workon.js';

const isDone = (s) => s === 'done' || s === 'superseded';

/**
 * The stories a unit carries: a story itself, a feature its listed stories.
 * @param {{ kind: string, id: string, record: object }} unit
 */
export function unitStories(unit, config, all) {
  if (unit.kind === 'feature') return resolveFeatureStories(unit.record, config, all).stories;
  return [unit.record];
}

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
 * A backticked span that reads as a repository-relative path: a `/` or an
 * extension, no empty, `.` or `..` segment, not absolute, and no template or
 * glob marker (`<id>`, `{a,b}`, `*`, `$VAR`). Spaces, punctuation and
 * Unicode are kept as `git diff --name-only -z` prints them.
 */
function asPath(span) {
  const t = span.trim().replace(/^\.\//, '');
  const p = t.replace(/\/$/, '');
  if (!p || p.startsWith('/') || /[<>{}*?$|\\]/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  // A trailing `/` marks a directory, so `src/` is kept.
  if (!t.includes('/') && !/\.[\p{L}\p{N}]+$/u.test(p)) return null;
  return p;
}

/** Two `repo:path` keys touch the same file: equal, or one is a directory holding the other. */
function sameFiles(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * A plan without its `### Sources of truth` subsections, each running to the
 * next heading of level 1 to 3. Headings are mdast nodes, so every Markdown
 * form of one counts and a `#` line in a code block does not. A heading's
 * title is its text as read: inline formatting does not change it, and an
 * HTML comment is not part of it.
 */
function withoutSourcesOfTruth(plan) {
  const headings = fromMarkdown(plan).children.filter((n) => n.type === 'heading' && n.depth <= 3);
  let kept = '';
  let from = 0;
  headings.forEach((h, i) => {
    const title = toString(h, { includeHtml: false }).replace(/\s+/g, ' ').trim();
    if (h.depth !== 3 || title !== 'Sources of truth') return;
    kept += plan.slice(from, h.position.start.offset);
    from = headings[i + 1]?.position.start.offset ?? plan.length;
  });
  return kept + plan.slice(from);
}

/**
 * `repo:path` for every backticked path in the stories' `## Implementation
 * Plan`, keyed by each story's repo (`unitRepo`, its component's; else
 * `defaultRepo`). A path that is not backticked is not seen, and neither is
 * one under `### Sources of truth`: those files are read, not changed, so
 * they hold back no other target.
 *
 * @param {{ indexPath: string, unitRepo?: string }[]} stories
 * @param {string} [defaultRepo]
 * @returns {Set<string>}
 */
export function planFiles(stories, defaultRepo = '') {
  const out = new Set();
  for (const s of stories) {
    if (!existsSync(s.indexPath)) continue;
    const { body } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
    const plan = extractSection(body, 'Implementation Plan');
    if (!plan) continue;
    const repo = s.unitRepo || defaultRepo;
    for (const [, span] of withoutSourcesOfTruth(plan).matchAll(/`([^`\n]+)`/g)) {
      const p = asPath(span);
      if (p) out.add(`${repo}:${p}`);
    }
  }
  return out;
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

/** Lowest id first; a feature before a story of the same number. */
export function byId(a, b) {
  return idNum(a.id) - idNum(b.id) || (a.kind === b.kind ? 0 : a.kind === 'feature' ? -1 : 1);
}

/** Which target carries each story: story id → unit. */
function storyOwners(units, config, all) {
  const owner = new Map();
  const storiesOf = new Map();
  for (const u of units) {
    const stories = unitStories(u, config, all);
    storiesOf.set(u, stories);
    for (const s of stories) if (!owner.has(s.id)) owner.set(s.id, u);
  }
  return { owner, storiesOf };
}

/**
 * Decide which units start and which wait.
 *
 * @param {Array<{ kind: string, id: string, record: object }>} units
 * @param {object[]} all  every story (`readAllStories`)
 * @param {{ config?: object, files?: (unit) => Set<string> }} [opts]
 *   `files` defaults to `unitFiles`; a test seam.
 * @returns {{ start: object[], deferred: Array<{ id: string, reason: string,
 *             blockers: string[] }> }}
 */
export function schedule(units, all, { config = null, files = (u) => unitFiles(u, config, all) } = {}) {
  const sorted = [...units].sort(byId);
  const statusById = new Map(all.map((s) => [s.id, s.status]));
  const { owner, storiesOf } = storyOwners(sorted, config, all);

  const deferred = [];
  const candidates = [];
  for (const u of sorted) {
    const reasons = [];
    const blockers = [];
    for (const s of storiesOf.get(u)) {
      for (const dep of parseIdList(s.depends_on)) {
        const other = owner.get(dep);
        // A merged dependency blocks nothing, even when it is among the targets.
        if (other === u || isDone(statusById.get(dep))) continue;
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

/**
 * Units in dependency order (a unit after every target it depends on),
 * lowest id first among equals. A cycle falls back to id order for the rest.
 */
export function dependencyOrder(units, all, { config = null } = {}) {
  const remaining = [...units].sort(byId);
  const { owner, storiesOf } = storyOwners(remaining, config, all);
  const deps = new Map();
  for (const u of remaining) {
    const set = new Set();
    for (const s of storiesOf.get(u)) {
      for (const d of parseIdList(s.depends_on)) {
        const other = owner.get(d);
        if (other && other !== u) set.add(other);
      }
    }
    deps.set(u, set);
  }
  const out = [];
  const emitted = new Set();
  while (remaining.length > 0) {
    const i = remaining.findIndex((u) => [...deps.get(u)].every((d) => emitted.has(d)));
    if (i === -1) {
      out.push(...remaining);
      break;
    }
    const [next] = remaining.splice(i, 1);
    emitted.add(next);
    out.push(next);
  }
  return out;
}
