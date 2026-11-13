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
 * Stories live in `stories/` and name their feature in a `feature: F-<n>`
 * frontmatter key, which is the only statement of membership: a feature's
 * stories, points and components are derived from it (`loadBacklog()`,
 * F-77 D3), never stored in the feature's frontmatter.
 *
 * `readAllFeatures` and `findFeature` project `loadBacklog()`'s feature
 * units into the record shape (F-77 D2); nothing here lists `features/`.
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  parseFrontmatterOf,
  parsePluginList,
  worktreePathFor,
  unitDirFor,
  resolvePlugins,
  repoOf,
  warn,
} from './config.js';
import { statusWords } from './flow.js';
import { CHECKBOX_RE } from './review-log.js';
import { statusOf } from './transition.js';
import { entryMatches, ownFm, readAllStories } from './story.js';
import { graphOf } from './backlog-graph.js';
import { readEdges } from './blockers.js';
import { featureRepoOrder, orderStoriesByDeps } from './execution-plan.js';

export const FEATURES_DIR = 'features';

/**
 * Whether `bl run` / `bl implement` may start or resume a feature at `status`:
 * it meets `approved` and does not meet `done` (`approved` up to `escalated`).
 * @param {import("./flow.js").Flow} flow
 * @param {string} status
 * @returns {boolean}
 */
export function isFeatureWorkable(flow, status) {
  return flow.meets('feature', status, 'approved') && !flow.meets('feature', status, 'done');
}

/**
 * Whether a feature at `status` has branches and worktrees, so a fixed set of
 * repos: it meets `in_progress` and does not meet `done`.
 * @param {import("./flow.js").Flow} flow
 * @param {string} status
 * @returns {boolean}
 */
export function isFeatureBranched(flow, status) {
  return isFeatureWorkable(flow, status) && flow.meets('feature', status, 'in_progress');
}

/**
 * The feature statuses `isFeatureBranched` accepts, in lifecycle order, for a
 * message.
 * @param {import("./flow.js").Flow} flow
 * @returns {string[]}
 */
export function branchedStatusesOf(flow) {
  return flow.statusesOf('feature').filter((s) => isFeatureBranched(flow, s));
}

export const DEFAULT_REVIEW_ROUNDS_MAX = 2;

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
 * where N is the number of the feature's first story, in its `stories` order
 * (dependency order, ties by number). A story belongs to one feature, so two
 * features never share N.
 * Empty (no keys) when the first entry is not a story ID: a placeholder left
 * unresolved fails the test gate rather than running with a made-up number.
 */
export function featureSessionVars(feature) {
  const m = String(feature?.stories?.[0] ?? '').match(/^S-(\d+)$/);
  return m ? { sessionId: `s${m[1]}`, sessionNum: m[1] } : {};
}

function toInt(v, fallback = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * One feature or story batch unit of the graph (`loadBacklog`) in the record
 * shape used across bl, or null when it has no id key (`feature_id`,
 * `batch_id`). A batch record has a feature's field names (F-125 D1), its
 * `theme` and `epic` empty. The branch, PR, review state and Review Log
 * (`changeBody`) come from the unit's current change document
 * (`unit.change()`, read now), not its spec. The text is the graph's, CRLF
 * read as LF (S-896).
 */
export function workUnitRecord(unit, config) {
  const idKey = unit.kind === 'batch' ? 'batch_id' : 'feature_id';
  if (!unit.fm[idKey]) return null;
  const fm = ownFm(unit);
  // No repo of its own (F-52 D3): the branch and PR are read off the change
  // document's first `repos:` entry, which is the lead repo's.
  const change = unit.change();
  return {
    id: fm[idKey],
    title: fm.title ?? '',
    // The log's last `to` and its review rounds (F-69 D2, D5); with no log,
    // `status:` (a v1 word mapped) placed by the change document (D4).
    status: statusOf(unit.kind, fm, change.change) || unit.status,
    round: unit.round,
    // The value axis (F-51 D1): the theme slug and the epic id as written.
    theme: String(fm.theme ?? '').trim(),
    epic: String(fm.epic ?? '').trim(),
    // Derived by the graph (F-77 D3): the stories naming it, in dependency
    // order, their points summed and their components.
    stories: unit.stories.map((s) => s.id),
    points: unit.points,
    components: unit.components.map((c) => c.id),
    branch: change.branch,
    pr: change.pr,
    prUrl: change.prUrl,
    reviewRoundsMax: toInt(fm.review_rounds_max, DEFAULT_REVIEW_ROUNDS_MAX),
    changePath: change.changePath,
    change: change.change,
    changeBody: change.changeBody,
    indexPath: unit.file,
    featureRelPath: relative(config.backlogRoot, unit.file),
    featureEntry: unit.entry,
    featureDir: unit.dir,
    fm,
    body: unit.body(),
    content: unit.text(),
  };
}

/**
 * Every `kind` (`feature` or `batch`) work unit as a record, whatever its status.
 * @param {"feature" | "batch"} kind
 */
export function readWorkUnits(kind, config) {
  const out = [];
  for (const unit of graphOf(config).list(kind)) {
    const f = workUnitRecord(unit, config);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Find a `kind` (`feature` or `batch`) work unit by parsed ID: the first
 * directory named for it.
 * @param {"feature" | "batch"} kind
 * @returns {ReturnType<typeof workUnitRecord> | null}
 */
export function findWorkUnit(kind, parsed, config) {
  const unit = graphOf(config)
    .list(kind)
    .find((u) => entryMatches(u.entry, parsed));
  return unit ? workUnitRecord(unit, config) : null;
}

/** Read every feature, whatever its status. */
export function readAllFeatures(config) {
  return readWorkUnits('feature', config);
}

/** Find a feature by parsed ID: the first directory named for it. */
export function findFeature(parsed, config) {
  return findWorkUnit('feature', parsed, config);
}

/** The highest feature number: every feature directory's, readable or not (`maxNum`). */
export function findMaxFeatureNum(config) {
  return Number(graphOf(config).maxNum('feature') ?? 0);
}

export function nextFeatureId(config) {
  return `F-${findMaxFeatureNum(config) + 1}`;
}

/**
 * Why no story can be added to `feature`, or null when one can: a `done` or
 * `superseded` feature is closed (`bl new F-<n>`, `bl attach`).
 */
export function closedFeatureRefusal(feature, flow) {
  return flow.meets('feature', feature.status, 'done')
    ? `Feature ${feature.id} is ${feature.status}; stories can't be added.`
    : null;
}

/**
 * Why the existing story `id` (frontmatter `fm`) cannot move into the feature
 * `featureId`, or null when it can: it names another feature, or it is not
 * unstarted (`Flow.isUnstarted`; a started story is someone's work in flight,
 * and the feature's merge would mark it done). A story that already names
 * `featureId` is the feature's and is never refused. `bl new --feature`
 * passes a null `featureId`: its feature is new, so any `feature:` refuses.
 */
export function storyMoveRefusal(id, fm, featureId, flow) {
  const named = String(fm.feature ?? '').trim();
  if (named) {
    if (featureId != null && (normalizeFeatureId(named)?.id ?? named) === featureId) return null;
    return `${id} is already in ${named}.`;
  }
  const status = statusOf('story', fm);
  if (!flow.isUnstarted('story', status)) {
    return `${id} is ${status}; only a ${statusWords(flow.unstartedStatusesOf('story'))} story moves into a feature.`;
  }
  return null;
}

/**
 * Whether `raw` (a story's `feature:` or `batch:`) names the work unit `id`
 * in any spelling `normalize` reads.
 * @param {unknown} raw
 * @param {string} id
 * @param {(raw: string) => { id: string } | null} normalize
 */
export function namesWorkUnit(raw, id, normalize) {
  const named = String(raw ?? '').trim();
  return named !== '' && (normalize(named)?.id ?? named) === id;
}

/** Whether the story record `s` names the feature `featureId` in its `feature:`. */
export function namesFeature(s, featureId) {
  return namesWorkUnit(s?.feature, featureId, normalizeFeatureId);
}

/**
 * The stories of a feature: the records in `allStories` (read when null)
 * whose `feature:` names it, the only statement of membership (F-77 D3), in
 * the graph's order: the order of the run and order edges between them
 * (`orderStoriesByDeps` of `readEdges`), ties by story number.
 *
 * @returns {{ stories: Array<object> }}  readAllStories records
 */
export function resolveFeatureStories(feature, config, allStories = null) {
  const all = allStories ?? readAllStories(config);
  const own = all.filter((s) => namesFeature(s, feature.id));
  return { stories: orderStoriesByDeps(own, readEdges(config)) };
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
 * The body without any `## <heading>` section whose content `test` accepts
 * (by default every one), each matched exactly as `extractSection` matches
 * it: the heading line and everything up to the next `## ` line. Every other
 * byte stays. When the last section goes, the blank lines before it go too,
 * and the body ends with one line end.
 * @param {string} body
 * @param {string} heading
 * @param {(content: string) => boolean} [test]
 */
export function removeSection(body, heading, test = () => true) {
  let last = false;
  const out = body.replace(new RegExp(sectionRe(heading).source, 'gm'), (m, _head, content, offset) => {
    if (!test(content)) return m;
    if (offset + m.length === body.length) last = true;
    return '';
  });
  if (!last || out.trim() === '') return out;
  return out.trimEnd() + (body.includes('\r\n') ? '\r\n' : '\n');
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

/**
 * Check the acceptance boxes a merge satisfies: every one, except "Remote
 * branch deleted" when the deletion failed.
 */
export function checkCriteria(body, { branchDeleted = true } = {}) {
  const section = extractSection(body, 'Acceptance Criteria');
  if (section == null) return body;
  const checked = section
    .split('\n')
    .map((l) => {
      if (!CHECKBOX_RE.test(l)) return l;
      if (!branchDeleted && /remote branch deleted/i.test(l)) return l;
      return l.replace('[ ]', '[x]');
    })
    .join('\n');
  return replaceSection(body, 'Acceptance Criteria', checked.replace(/^\n+|\n+$/g, ''));
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

/**
 * Whether the unit file at `indexPath` has an open `## Escalation`: one with
 * content (`sectionHasContent`). Here, not in `feature-run.js`, so the guards
 * (`guards.js`) load without the loop.
 */
export function escalationOpen(indexPath) {
  const text = readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
  return sectionHasContent(extractSection(parseFrontmatterOf(text, indexPath).body, 'Escalation'));
}
