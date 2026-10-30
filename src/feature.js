/**
 * feature.js — feature discovery and helpers.
 *
 * A feature is the execution unit: one branch, one PR, one review cycle and
 * one merge over an ordered set of stories that may span components and
 * repos. Components label the code a story changes; features sequence what
 * lands together. Every feature lives in one flat directory, whatever its
 * status (F-49 D3):
 *
 *   <backlogRoot>/features/F<n>-<slug>/index.md
 *
 * Stories live in `stories/` and point back with a `feature: F-<n>`
 * frontmatter key; the feature lists them in order under `stories:`.
 * `bl sync` cross-checks the two and renders the tables.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  frontmatterSkipped,
  info,
  parseFrontmatterOf,
  parsePluginList,
  worktreePathFor,
  unitDirFor,
  resolvePlugins,
  repoOf,
  warn,
} from './config.js';
import { parseIdList, readAllStories } from './story.js';
import { unitChange } from './change-doc.js';
import { updateSpecFile } from './spec-file.js';

export const FEATURES_DIR = 'features';

/** Statuses from which `bl run` / `bl implement` may start or resume a feature. */
export const FEATURE_WORKABLE_STATUSES = new Set(['approved', 'running', 'escalated']);

export const DEFAULT_REVIEW_ROUNDS_MAX = 2;

const isClosed = (s) => s === 'done' || s === 'superseded';

/** Normalise a feature ID like "F1", "F-1", "f-1". */
export function normalizeFeatureId(raw) {
  const m = String(raw).match(/^[Ff]-?(\d+)$/);
  if (!m) return null;
  const num = m[1];
  return { num, id: `F-${num}`, dirPrefix: `F${num}` };
}

export function featuresRoot(config) {
  return join(config.backlogRoot, FEATURES_DIR);
}

/** The git branch a feature is implemented on: its directory name, lowercased. */
export function featureBranchName(featureEntry) {
  return featureEntry.toLowerCase();
}

/**
 * The feature's test-session variables: `sessionId` (`s<N>`, the session
 * CLI's form) and `sessionNum` (`<N>`, what `PLAYWRIGHT_SESSION_ID` takes),
 * where N is the number of the first story in `stories:` — listed order, not
 * the lowest. A story belongs to one feature, so two features never share N.
 * Empty (no keys) when the first entry is not a story ID: a placeholder left
 * unresolved fails the test gate rather than running with a made-up number.
 */
export function featureSessionVars(feature) {
  const m = String(feature?.stories?.[0] ?? '').match(/^S-(\d+)$/);
  return m ? { sessionId: `s${m[1]}`, sessionNum: m[1] } : {};
}

/**
 * Enumerate feature directories under `features/`, sorted. Nothing below a
 * feature directory's siblings (a `.completed/` left by hand) is read.
 * @returns {{ featureEntry, featureDir, indexPath }[]}
 */
export function scanFeatureDirs(config) {
  const root = featuresRoot(config);
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root).sort()) {
    if (!/^F\d+/.test(entry)) continue;
    const featureDir = join(root, entry);
    if (!statSync(featureDir).isDirectory()) continue;
    const indexPath = join(featureDir, 'index.md');
    if (!existsSync(indexPath)) continue;
    out.push({ featureEntry: entry, featureDir, indexPath });
  }
  return out;
}

function toInt(v, fallback = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse one feature index file into the record shape used across bl. The
 * branch, PR, review state and Review Log (`changeBody`) come from the
 * feature's current change document (change-doc.js), not its spec.
 */
export function readFeature(entry, config) {
  // CRLF read as LF, as the story reader does (S-896): a CRLF file's `---\r\n`
  // block is not a frontmatter block to the parser, so the feature went missing.
  const content = readFileSync(entry.indexPath, 'utf8').replace(/\r\n/g, '\n');
  const { fm, body } = parseFrontmatterOf(content, entry.indexPath);
  if (!fm.feature_id) return null;
  // No repo of its own (F-52 D3): the branch and PR are read off the change
  // document's first `repos:` entry, which is the lead repo's.
  const change = unitChange(entry.featureDir);
  return {
    id: fm.feature_id,
    title: fm.title ?? '',
    status: fm.status ?? 'draft',
    // The value axis (F-51 D1): the theme slug and the epic id as written.
    theme: String(fm.theme ?? '').trim(),
    epic: String(fm.epic ?? '').trim(),
    stories: parseIdList(fm.stories),
    points: toInt(fm.points),
    branch: change.branch,
    pr: change.pr,
    prUrl: change.prUrl,
    reviewStatus: change.reviewStatus,
    reviewRound: toInt(change.reviewRoundRaw),
    reviewRoundsMax: toInt(fm.review_rounds_max, DEFAULT_REVIEW_ROUNDS_MAX),
    changePath: change.changePath,
    change: change.change,
    changeBody: change.changeBody,
    indexPath: entry.indexPath,
    featureRelPath: relative(config.backlogRoot, entry.indexPath),
    featureEntry: entry.featureEntry,
    featureDir: entry.featureDir,
    fm,
    body,
    content,
  };
}

/** Read every feature, whatever its status. */
export function readAllFeatures(config) {
  const out = [];
  for (const entry of scanFeatureDirs(config)) {
    if (frontmatterSkipped(config, entry.indexPath)) continue;
    const f = readFeature(entry, config);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Find a feature by parsed ID.
 * @returns {ReturnType<typeof readFeature> | null}
 */
export function findFeature(parsed, config) {
  for (const entry of scanFeatureDirs(config)) {
    const e = entry.featureEntry;
    if (e !== parsed.dirPrefix && !e.startsWith(parsed.dirPrefix + '-')) {
      continue;
    }
    return readFeature(entry, config);
  }
  return null;
}

export function findMaxFeatureNum(config) {
  let max = 0;
  for (const entry of scanFeatureDirs(config)) {
    const m = entry.featureEntry.match(/^F(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

export function nextFeatureId(config) {
  return `F-${findMaxFeatureNum(config) + 1}`;
}

/**
 * Why no story can be added to `feature`, or null when one can: a `done` or
 * `superseded` feature is closed (`bl new F-<n>`, `bl attach`).
 */
export function closedFeatureRefusal(feature) {
  return isClosed(feature.status) ? `Feature ${feature.id} is ${feature.status}; stories can't be added.` : null;
}

/**
 * Why the existing story `id` (frontmatter `fm`) cannot move into the feature
 * `featureId`, or null when it can: it names another feature, or it is not
 * `backlog` or `refined` (an `in_progress` story is someone's work in flight,
 * and the feature's merge would mark it done). A story that already names
 * `featureId` is the feature's and is never refused. `bl new --feature`
 * passes a null `featureId`: its feature is new, so any `feature:` refuses.
 */
export function storyMoveRefusal(id, fm, featureId) {
  const named = String(fm.feature ?? '').trim();
  if (named) {
    if (featureId != null && (normalizeFeatureId(named)?.id ?? named) === featureId) return null;
    return `${id} is already in ${named}.`;
  }
  if (fm.status !== 'backlog' && fm.status !== 'refined') {
    return `${id} is ${fm.status}; only a backlog or refined story moves into a feature.`;
  }
  return null;
}

/**
 * Append story IDs to a feature's `stories:` list (deduped, order kept)
 * through `updateSpecFile` (F-67): the list is the one read under the spec
 * lock, and a failed write leaves the previous file. Sync regenerates the
 * table afterwards. The caller holds the backlog lock, the outer one (D4).
 * Shared by `bl new` and `bl attach`.
 */
export function appendStoriesToFeature(backlogRoot, feature, ids) {
  let count;
  updateSpecFile(backlogRoot, feature.indexPath, (fm) => {
    const current = parseIdList(fm.stories);
    for (const id of ids) if (!current.includes(id)) current.push(id);
    fm.stories = current;
    count = current.length;
  });
  info(`Linked ${ids.join(', ')} to ${feature.id} (${count} stories).`);
}

/**
 * Resolve the stories a feature lists, in listed order.
 *
 * @returns {{
 *   stories: Array<object>,       // readAllStories records, listed order
 *   missing: string[],            // listed IDs with no story on disk
 *   unlisted: Array<object>,      // stories tagged `feature: <id>` but not listed
 *   mismatched: Array<object>     // listed stories whose `feature:` points elsewhere
 * }}
 */
export function resolveFeatureStories(feature, config, allStories = null) {
  const all = allStories ?? readAllStories(config);
  const byId = new Map(all.map((s) => [s.id, s]));
  const stories = [];
  const missing = [];
  const mismatched = [];
  for (const id of feature.stories) {
    const s = byId.get(id);
    if (!s) {
      missing.push(id);
      continue;
    }
    stories.push(s);
    if ((s.feature ?? '') !== feature.id) mismatched.push(s);
  }
  const listed = new Set(feature.stories);
  const unlisted = all.filter((s) => (s.feature ?? '') === feature.id && !listed.has(s.id));
  return { stories, missing, unlisted, mismatched };
}

/**
 * Order a feature's stories so that every in-feature dependency comes before
 * its dependents. Stable: ties keep the listed order. A dependency cycle
 * inside the set falls back to listed order for the stuck remainder.
 */
export function orderStoriesByDeps(stories) {
  const ids = new Set(stories.map((s) => s.id));
  const remaining = [...stories];
  const emitted = new Set();
  const out = [];
  while (remaining.length > 0) {
    const idx = remaining.findIndex((s) =>
      parseIdList(s.depends_on)
        .filter((d) => ids.has(d))
        .every((d) => emitted.has(d)),
    );
    if (idx === -1) {
      out.push(...remaining);
      break;
    }
    const [next] = remaining.splice(idx, 1);
    emitted.add(next.id);
    out.push(next);
  }
  return out;
}

/**
 * Dependencies that block a feature from starting: every `depends_on` of a
 * feature story that is neither part of the feature nor already closed.
 * @returns {{ story: string, dep: string, status: string }[]}
 */
export function outsideBlockers(stories, allStories) {
  const inFeature = new Set(stories.map((s) => s.id));
  const byId = new Map(allStories.map((s) => [s.id, s]));
  const out = [];
  for (const s of stories) {
    for (const dep of parseIdList(s.depends_on)) {
      if (inFeature.has(dep)) continue;
      const target = byId.get(dep);
      const status = target?.status ?? 'missing';
      if (target && isClosed(status)) continue;
      out.push({ story: s.id, dep, status });
    }
  }
  return out;
}

/** The repo a feature's order puts first whenever one of its stories is in it (F-52 D3). */
export const LEAD_REPO = 'bl';

/**
 * A feature's repos in the one order every step uses (F-52 D3): its stories'
 * repos (`unitRepo`, each story's component's, D1), `bl` first when one is
 * there (S-864: a later repo's push gate reads backlog output the new `bl`
 * generates), then every other repo by its first story in
 * `orderStoriesByDeps`. A repo named twice keeps its first place; an empty
 * name is dropped. The first entry is the lead repo. Pure: the stories are
 * `readAllStories` records.
 *
 * @param {Array<{ id?: string, unitRepo?: string, depends_on?: unknown }>} stories
 * @returns {string[]}
 */
export function featureRepoOrder(stories) {
  const names = [];
  for (const s of orderStoriesByDeps(stories ?? [])) {
    const name = String(s.unitRepo ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  const lead = names.indexOf(LEAD_REPO);
  if (lead > 0) names.unshift(...names.splice(lead, 1));
  return names;
}

/**
 * Every repo a feature touches, in `featureRepoOrder` (stories read from the
 * backlog when `stories` is null), each with the worktree path the feature
 * branch uses there. Nothing is read from the feature's frontmatter or its
 * change document: a repo no story names is not the feature's. A repo the
 * config does not know is dropped.
 * @returns {{ repoName, repoPath, worktreePath, unitDir }[]}
 */
export function reposForFeature(feature, config, stories = null) {
  const names = featureRepoOrder(stories ?? resolveFeatureStories(feature, config).stories);
  const branch = featureBranchName(feature.featureEntry);
  const out = [];
  for (const name of names) {
    const repoPath = config.reposByName[name];
    if (!repoPath) continue;
    out.push({
      repoName: name,
      repoPath,
      worktreePath: worktreePathFor(config, name, branch),
      unitDir: unitDirFor(config, branch),
    });
  }
  return out;
}

/**
 * Resolve the active plugins for a stage with the feature as the last cascade
 * layer: backlog root → repo (the `configForRepo` repo's `plugins-<stage>`) →
 * component (a story run's) → feature. A feature has no component of its own, so `plugins-test: <name>` / `plugins: …` on the
 * feature is where per-repo tooling is chosen. Same syntax as every other
 * layer: bare names add, `-name` removes, `plugins-<stage>` beats `plugins`.
 */
export function resolveFeaturePlugins(stage, config, featureIndexPath) {
  const { plugins, unknown } = resolveFeaturePluginsReport(stage, config, featureIndexPath);
  for (const name of unknown) {
    warn(`${featureIndexPath}: plugin '${name}' is not defined in backlog.json plugins — ignored for ${stage}`);
  }
  return plugins;
}

/**
 * `resolveFeaturePlugins` plus the names the feature lists that no config
 * defines. A typo in `plugins-test` must not read as "no test configured" —
 * the test gate fails on `unknown` instead of skipping.
 *
 * `componentEntry` adds the component layer before the file's own: a story
 * run by `bl run S-n` passes its story file and its component.
 *
 * @returns {{ plugins: {name: string, command: string}[], unknown: string[] }}
 */
export function resolveFeaturePluginsReport(stage, config, featureIndexPath, { componentEntry } = {}) {
  const unknown = [];
  const active = new Map(
    resolvePlugins(stage, config.plugins, {
      backlogRoot: config.backlogRoot,
      repo: repoOf(config),
      componentEntry,
    }).map((p) => [p.name, p]),
  );
  if (featureIndexPath && existsSync(featureIndexPath)) {
    const { fm } = parseFrontmatterOf(readFileSync(featureIndexPath, 'utf8'), featureIndexPath);
    for (const entry of parsePluginList(fm[`plugins-${stage}`] ?? fm.plugins)) {
      const name = entry.startsWith('-') ? entry.slice(1) : entry;
      if (!config.plugins?.[name]) {
        unknown.push(name);
        continue;
      }
      if (entry.startsWith('-')) active.delete(name);
      else if (config.plugins[name][stage]) {
        active.set(name, { name, command: config.plugins[name][stage] });
      }
    }
  }
  return { plugins: [...active.values()], unknown };
}

/**
 * Relative link from a feature's index.md to a story's index.md. Feature dirs
 * sit two levels below the backlog root.
 */
export function storyLinkFromFeature(feature, storyRelPath) {
  return `../../${storyRelPath}`;
}

/**
 * Extract a `## <heading>` section body (until the next `## ` or EOF).
 * Returns null when the heading is absent.
 */
export function extractSection(body, heading) {
  const m = body.match(sectionRe(heading));
  return m ? m[2] : null;
}

/**
 * Replace the body of a `## <heading>` section, matched exactly as
 * `extractSection` matches it (trailing blanks and CRLF on the heading line
 * included). Returns the body unchanged when the heading is absent.
 */
export function replaceSection(body, heading, text) {
  return body.replace(
    sectionRe(heading),
    (m, head, _content, offset, whole) => `${head}\n${text}\n${offset + m.length < whole.length ? '\n' : ''}`,
  );
}

/**
 * The heading text of every `## ` section, in order, as `extractSection`
 * matches a heading (trailing blanks and CR dropped).
 * @returns {string[]}
 */
export function sectionHeadings(body) {
  return [...body.matchAll(/^##[ \t]+(.*?)[ \t]*\r?$/gm)].map((m) => m[1]);
}

/**
 * `body` with `line` appended to the end of `## <heading>`, which is created
 * at the end of the file when absent. A line already there is not added
 * again, so a retried merge records it once.
 */
export function appendSectionLine(body, heading, line) {
  const section = extractSection(body, heading);
  if (section == null) return `${body.trimEnd()}\n\n## ${heading}\n\n${line}\n`;
  if (section.split('\n').includes(line)) return body;
  const kept = section.trim();
  return replaceSection(body, heading, kept ? `${kept}\n${line}` : line);
}

function sectionRe(heading) {
  return new RegExp(
    `^(##[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\r?\\n)([\\s\\S]*?)(?=^##[ \\t]|$(?![\\s\\S]))`,
    'm',
  );
}

/**
 * True when a section holds real content — anything beyond HTML comments,
 * blank lines, and a lone "None." style marker.
 */
export function sectionHasContent(text) {
  if (text == null) return false;
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (stripped === '') return false;
  return !/^(none|n\/a|tbd|nothing|—|-)?\.?$/i.test(stripped);
}
