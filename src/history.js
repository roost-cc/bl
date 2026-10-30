/**
 * history.js — the backlog's state over time, one snapshot per day the
 * backlog repo was committed (F-40 Design D2, Decision A1).
 *
 * Each day is read from git objects (one `git ls-tree -r`, one
 * `git cat-file --batch`), cached by commit in `.bl/report-cache.json`, and
 * grouped by the current working tree. Days before the first commit are
 * projected backwards from the current stories' `added` and `completed`.
 * `bl history` (`history-cmd.js`) prints it; `bl report` builds on it.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSyncFiles } from './child-stdio.js';
import { parse } from 'yaml';
import { normalizeId, parseFrontmatter } from './config.js';
import { atomicWriteFile } from './atomic-write.js';
import { legacyRepaired, listOfString } from './migrate-frontmatter-yaml.js';
import { readAllStories } from './story.js';
import { readAllFeatures, normalizeFeatureId } from './feature.js';
import { normalizeEpicId } from './theme.js';

/** The cache file, under the backlog's git-ignored `.bl/`. */
export const CACHE_FILE = join('.bl', 'report-cache.json');

/** Bumped whenever a cached day's shape or content would change. */
export const CACHE_VERSION = 3;

const BLOCK_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const STORY_ID_RE = /^S-\d+$/;
const FEATURE_ID_RE = /^F-\d+$/;

/**
 * @typedef {{ status: string, points: number }} StorySnap
 * @typedef {{ status: string, stories: string[] }} FeatureSnap
 * @typedef {{ date: string, commit: string | null, backfilled: boolean,
 *   stories: Record<string, StorySnap>, features: Record<string, FeatureSnap> }} Day
 * @typedef {{ stories: Record<string, { feature: string, component: string,
 *   added: string, completed: string }>,
 *   features: Record<string, { epic: string, theme: string }> }} Groups
 */

// Through files, not sockets: `cat-file --batch` reads its stdin to EOF, which a
// socket never delivers inside Codex's sandbox (`spawnSyncFiles`, F-70 D1).
function git(root, args, input) {
  const r = spawnSyncFiles('git', args, {
    cwd: root,
    input,
    // With input, stdout stays a Buffer: cat-file's sizes count bytes.
    ...(input === undefined ? { encoding: 'utf8' } : {}),
  });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  }
  return r.stdout;
}

/**
 * Every calendar day with a commit reachable from HEAD, oldest first, each
 * with its last commit by committer date. Days are UTC days: a commit's own
 * `%cd` is in its committer's time zone, so a commit stamped `+00:00` would
 * otherwise land on a later date than a newer one stamped `-07:00`, and the
 * last day would not hold HEAD.
 * @returns {{ date: string, commit: string }[]}
 */
export function commitDays(root) {
  const out = git(root, ['log', '--format=%H %ct', 'HEAD']);
  const byDate = new Map();
  for (const line of out.split('\n')) {
    const [commit, ts] = line.split(' ');
    if (!ts) continue;
    const t = Number(ts);
    const date = new Date(t * 1000).toISOString().slice(0, 10);
    const seen = byDate.get(date);
    if (!seen || t > seen.t) byDate.set(date, { commit, t });
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { commit }]) => ({ date, commit }));
}

/**
 * A blob's frontmatter mapping, `{}` when it has none, or null when it is
 * neither YAML nor the legacy dialect.
 * @param {string} text
 * @returns {object | null}
 */
export function parseBlob(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const match = lf.match(BLOCK_RE);
  if (!match) return {};
  try {
    // `parseFrontmatter` needs a newline after the closing `---`.
    return parseFrontmatter(lf.endsWith('\n') ? lf : `${lf}\n`).fm;
  } catch {
    // Decision A1 (operator, 2026-10-26): `parseFrontmatter` rejects some
    // blobs from before F-62 (2026-10-25), mostly unquoted titles holding
    // `: `, because they were written for the retired line reader and were
    // never YAML. No standard library reads them. They are a closed corpus,
    // frozen in git history and never written again, and without them about
    // a quarter of the stories lose their refined and in-progress
    // transitions before that date, which holds 88 of the 90 days the
    // cycle-time figures cover. So a historical blob YAML rejects is read
    // through F-62's `legacyRepaired`, then YAML under the failsafe schema;
    // live files stay YAML only.
    try {
      const fm = parse(legacyRepaired(match[1]).block, { schema: 'failsafe' });
      return fm && typeof fm === 'object' && !Array.isArray(fm) ? fm : null;
    } catch {
      return null;
    }
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * A feature's `stories:` as ids, whether a sequence or a pre-F-62 string,
 * each normalized (`S1`, `s-1` → `S-1`) as the current tree's reader does.
 */
function storyList(raw) {
  const ids = Array.isArray(raw) ? raw.map(str) : typeof raw === 'string' ? listOfString(raw, 'stories') : [];
  return ids.filter(Boolean).map((id) => normalizeId(id)?.id ?? id);
}

/**
 * What a day records of a unit's frontmatter, or null when it is not a
 * story or a feature.
 * @returns {{ kind: "story", id: string, snap: StorySnap }
 *   | { kind: "feature", id: string, snap: FeatureSnap } | null}
 */
function unitOf(fm) {
  const storyId = str(fm.story_id);
  if (STORY_ID_RE.test(storyId)) {
    return {
      kind: 'story',
      id: storyId,
      snap: { status: str(fm.status) || 'backlog', points: parseInt(str(fm.points), 10) || 0 },
    };
  }
  const featureId = str(fm.feature_id);
  if (FEATURE_ID_RE.test(featureId)) {
    return {
      kind: 'feature',
      id: featureId,
      snap: { status: str(fm.status) || 'draft', stories: storyList(fm.stories) },
    };
  }
  return null;
}

/**
 * The `index.md` blobs of commit `sha`: `[{ blob, path }]`.
 */
function indexBlobs(root, sha) {
  const out = git(root, ['ls-tree', '-r', '-z', sha]);
  const blobs = [];
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [, type, blob] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (type === 'blob' && (path === 'index.md' || path.endsWith('/index.md'))) blobs.push({ blob, path });
  }
  return blobs;
}

/**
 * The contents of `blobs` (shas) through one `git cat-file --batch`, split
 * at each object's `<sha> <type> <size>` header.
 * @returns {Map<string, string>}
 */
function catBlobs(root, blobs) {
  const texts = new Map();
  if (blobs.length === 0) return texts;
  const buf = git(root, ['cat-file', '--batch'], blobs.join('\n') + '\n');
  let at = 0;
  while (at < buf.length) {
    const eol = buf.indexOf(0x0a, at);
    if (eol === -1) break;
    const header = buf.toString('utf8', at, eol).split(' ');
    if (header[1] === 'missing') throw new Error(`git cat-file: blob ${header[0]} is missing`);
    const size = Number(header[2]);
    texts.set(header[0], buf.toString('utf8', eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return texts;
}

/**
 * Read one commit's units: every `index.md` whose frontmatter names a
 * `story_id` or `feature_id`, wherever it lives. `memo` (blob sha → parsed
 * unit, or `undefined` for unreadable) spares parsing a blob twice in a run.
 * @returns {{ stories: Record<string, StorySnap>, features: Record<string, FeatureSnap>,
 *   unreadable: string[] }}  `unreadable`: the blob shas that could not be parsed
 */
export function readDay(root, sha, memo = new Map()) {
  const blobs = indexBlobs(root, sha);
  const fresh = [...new Set(blobs.map((b) => b.blob).filter((b) => !memo.has(b)))];
  for (const [blob, text] of catBlobs(root, fresh)) {
    const fm = parseBlob(text);
    memo.set(blob, fm === null ? undefined : unitOf(fm));
  }
  const day = { stories: {}, features: {}, unreadable: [] };
  // Sorted by path so a unit with two files (a copy left behind by a move)
  // reads the same on every run.
  for (const { blob } of [...blobs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const unit = memo.get(blob);
    if (unit === undefined) {
      if (!day.unreadable.includes(blob)) day.unreadable.push(blob);
      continue;
    }
    if (unit === null) continue;
    (unit.kind === 'story' ? day.stories : day.features)[unit.id] = unit.snap;
  }
  return day;
}

/**
 * Grouping from the current working tree: each story's feature, component,
 * `added` and `completed`, each feature's epic and theme.
 * @param {object} config
 * @param {ReturnType<typeof readAllStories>} [stories]  the current stories, when already read
 * @returns {Groups}
 */
export function currentGroups(config, stories = readAllStories(config)) {
  const groups = { stories: {}, features: {} };
  for (const s of stories) {
    groups.stories[s.id] = {
      feature: s.feature ? (normalizeFeatureId(s.feature)?.id ?? '') : '',
      component: s.componentId ?? '',
      added: str(s.added),
      completed: str(s.completed),
    };
  }
  for (const f of readAllFeatures(config)) {
    groups.features[f.id] = { epic: normalizeEpicId(f.epic)?.id ?? '', theme: f.theme };
  }
  return groups;
}

/** `date` (YYYY-MM-DD) moved by `n` days. */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The days before `firstDate` projected from the current stories: one per
 * calendar day from the earliest `added`, a story in scope from its `added`
 * and done (or superseded) from its `completed`, with its current points;
 * every other status is unknown and reads `backlog`.
 * @param {Groups} groups
 * @param {Map<string, { status: string, points: number }>} current  the stories' current status and points
 * @param {string} firstDate  the first commit's date
 * @returns {Day[]}
 */
export function backfill(groups, current, firstDate) {
  const added = Object.values(groups.stories)
    .map((s) => s.added)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < firstDate)
    .sort();
  if (added.length === 0) return [];
  const days = [];
  for (let date = added[0]; date < firstDate; date = addDays(date, 1)) {
    const stories = {};
    for (const [id, g] of Object.entries(groups.stories)) {
      if (!g.added || g.added > date) continue;
      const now = current.get(id) ?? { status: 'backlog', points: 0 };
      const closed = (now.status === 'done' || now.status === 'superseded') && g.completed && g.completed <= date;
      stories[id] = { status: closed ? now.status : 'backlog', points: now.points };
    }
    days.push({ date, commit: null, backfilled: true, stories, features: {} });
  }
  return days;
}

const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * Whether `day` has the shape `readDay` returns: story and feature maps
 * (empty or not) of well-formed snapshots, and the unreadable blob shas.
 */
export function validCachedDay(day) {
  return (
    isMap(day) &&
    isMap(day.stories) &&
    Object.values(day.stories).every((s) => isMap(s) && typeof s.status === 'string' && Number.isFinite(s.points)) &&
    isMap(day.features) &&
    Object.values(day.features).every((f) => isMap(f) && typeof f.status === 'string' && isStrings(f.stories)) &&
    isStrings(day.unreadable)
  );
}

/**
 * The cache's days by commit, or an empty map when the file is missing,
 * unreadable or written under another `version`. A day of another shape
 * (`validCachedDay`) is left out, so it is read from git again.
 * @returns {Map<string, object>}
 */
export function loadCache(root) {
  const path = join(root, CACHE_FILE);
  if (!existsSync(path)) return new Map();
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data?.version !== CACHE_VERSION || !isMap(data.days)) return new Map();
    return new Map(Object.entries(data.days).filter(([, day]) => validCachedDay(day)));
  } catch {
    return new Map();
  }
}

/** Write `days` (commit → parsed day) as the cache, atomically. */
export function saveCache(root, days) {
  const text = JSON.stringify({ version: CACHE_VERSION, days: Object.fromEntries(days) }) + '\n';
  atomicWriteFile(root, join(root, CACHE_FILE), text);
}

/**
 * The backlog's daily snapshots, oldest first.
 * @param {object} config  `loadConfig()`
 * @param {{ since?: string }} [opts]  `since`: the first date kept (YYYY-MM-DD)
 * @returns {{ days: Day[], earlier: Day[], groups: Groups, unreadable: number }}
 *   `earlier`: the days before `since`, which only `firstSeen` reads, so a
 *   story's first transitions keep their dates across the cutoff;
 *   `unreadable`: distinct `index.md` blobs no reader could parse, over `days`
 */
export function buildHistory(config, { since = '' } = {}) {
  const root = config.backlogRoot;
  const stories = readAllStories(config);
  const groups = currentGroups(config, stories);
  const commits = commitDays(root);

  const cache = loadCache(root);
  const memo = new Map();
  let added = 0;
  const unreadable = new Set();
  const gitDays = [];
  for (const { date, commit } of commits) {
    let parsed = cache.get(commit);
    if (!parsed) {
      parsed = readDay(root, commit, memo);
      cache.set(commit, parsed);
      added++;
    }
    if (!since || date >= since) for (const blob of parsed.unreadable ?? []) unreadable.add(blob);
    gitDays.push({ date, commit, backfilled: false, stories: parsed.stories, features: parsed.features });
  }
  if (added > 0) saveCache(root, cache);

  const current = new Map(stories.map((s) => [s.id, { status: s.status, points: parseInt(str(s.points), 10) || 0 }]));
  const firstDate = commits[0]?.date ?? addDays(new Date().toISOString().slice(0, 10), 1);
  const all = [...backfill(groups, current, firstDate), ...gitDays];
  const kept = all.findIndex((d) => !since || d.date >= since);
  const cut = kept === -1 ? all.length : kept;
  return { days: all.slice(cut), earlier: all.slice(0, cut), groups, unreadable: unreadable.size };
}

// ---------------------------------------------------------------------------
// Scopes (Design D2, Definitions)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ kind: "backlog" } | { kind: "theme" | "epic" | "feature" | "component", id: string }} Scope
 */

/**
 * The stories of `day` in `scope`, as ids. A feature's are the `stories:` it
 * listed that day; an epic's, its current features'; a theme's, its current
 * features' (its epics' and those with no epic); a component's, the current
 * stories in it. Outside the backlog scope, only stories in the current tree
 * count.
 * @param {Day} day
 * @param {Scope} scope
 * @param {Groups} groups
 * @returns {string[]}
 */
export function scopeStories(day, scope, groups) {
  const ids = Object.keys(day.stories);
  if (scope.kind === 'backlog') return ids;
  if (scope.kind === 'component') return ids.filter((id) => groups.stories[id]?.component === scope.id);
  const features = Object.entries(groups.features)
    .filter(([id, f]) =>
      scope.kind === 'feature' ? id === scope.id : scope.kind === 'epic' ? f.epic === scope.id : f.theme === scope.id,
    )
    .map(([id]) => id);
  const members = new Set(features.flatMap((id) => day.features[id]?.stories ?? []));
  return ids.filter((id) => members.has(id) && groups.stories[id]);
}

/** `history` with each day's stories (`earlier` too) narrowed to `scope`. */
export function narrowHistory(history, scope) {
  if (scope.kind === 'backlog') return history;
  const narrow = (day) => {
    const keep = new Set(scopeStories(day, scope, history.groups));
    return { ...day, stories: Object.fromEntries(Object.entries(day.stories).filter(([id]) => keep.has(id))) };
  };
  return { ...history, days: history.days.map(narrow), earlier: (history.earlier ?? []).map(narrow) };
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/** The ISO week of `date` (YYYY-MM-DD), as `2026-W17`. */
export function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The last day of each ISO week in `days` (oldest first), with its week. */
export function weeklyDays(days) {
  const byWeek = new Map();
  for (const day of days) byWeek.set(isoWeek(day.date), day);
  return [...byWeek.entries()].map(([week, day]) => ({ week, day }));
}

/** A day's points per status. */
export function pointsByStatus(day) {
  const out = {};
  for (const s of Object.values(day.stories)) out[s.status] = (out[s.status] ?? 0) + s.points;
  return out;
}
