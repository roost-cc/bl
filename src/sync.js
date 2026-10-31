/**
 * sync.js — regenerate the backlog's index tables (F-49 D3, D7).
 *
 *   1. Per-component index    backlog/components/C<nn>-*\/index.md
 *   2. Per-feature index      backlog/features/F<nn>-*\/index.md
 *   3. Per-epic index         backlog/epics/E<nn>-*\/index.md
 *   4. Per-theme index        backlog/themes/<slug>/index.md
 *   5. Top-level index        backlog/index.md
 *   6. Feature order          backlog/feature-order.md (F-53 D1)
 *
 * Rules:
 *   - Story IDs are globally unique (enforced); stories live in
 *     backlog/stories/S<n>-*\/ and name their component in `component:`.
 *   - Priority order comes from the top-level `## Backlog` table (global).
 *     Stories absent from it are appended in id order.
 *   - Points & status read from story frontmatter. Nothing moves: status is
 *     frontmatter, never location.
 *   - A component's index lists its open stories and the active features
 *     touching it; a component has no points or status (F-49 D4).
 *   - A feature gets its Stories table, points, and `components:` roll-up
 *     regenerated from the stories it lists.
 *   - A feature or story with a task gets its Tasks table (F-65 D1), from
 *     the task files' `unit:` and their edges in `blockers.json`; a unit
 *     with none is left as it is.
 *   - An epic gets its `features:` and `status:` derived from the features
 *     naming it, and a Features table; a theme lists its epics, then its
 *     features with no epic (F-51 D3).
 *   - `feature-order.md` gets its Next up and Not yet ranked tables from its
 *     `ranked:` frontmatter and the features' own; its frontmatter, intro and
 *     History are left as written. With no file, nothing is written.
 *
 * `runSync` holds the backlog-root lock (`lock.js`, re-entrant) for the whole
 * regeneration and returns every backlog path it wrote. Every write replaces
 * its file atomically (`atomicWriteFile`), so a failed one leaves the
 * previous file whole; a feature or story spec is rewritten through
 * `updateSpecFile`, under its spec lock, from the spec as it is then, not as
 * it was collected (F-67 D2, D4).
 * `bl sync --commit` commits exactly those paths plus the `--story`
 * directories the caller names, inside the same lock hold.
 */

import { readFileSync, statSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, relative } from 'path';
import { spawnSync } from 'child_process';
import { stringify as stringifyYaml } from 'yaml';
import {
  loadConfig,
  configForRepo,
  parseFrontmatter,
  serializeFrontmatter,
  parsePluginCascade,
  bucketByPlugin,
  runPluginBatch,
  info,
  normalizeId,
  STORIES_DIR,
  COMPONENTS_DIR,
  THEMES_DIR,
  EPICS_DIR,
  agentFlagOf,
  DEFAULT_BACKLOG_TITLE,
} from './config.js';
import { acquireLock, releaseLock, withLock } from './lock.js';
import {
  commitPaths,
  dirtySnapshot,
  hasOriginRemote,
  pathsChangedSince,
  pullBacklog,
  reportBacklogPull,
} from './backlog-commit.js';
import { ensureAllowedTools } from './allowed-tools.js';
import { atomicWriteFile } from './atomic-write.js';
import { updateSpecFile } from './spec-file.js';
import { RUN_STATE_KEYS } from './change-doc.js';
import { findStoryDir, readAllStories, readBacklogOrder, readComponents } from './story.js';
import { VALID_STORY_KEYS, VALID_COMPONENT_KEYS, VALID_FEATURE_KEYS, findDuplicateIds } from './validate.js';
import { readAllEpics, readAllThemes, normalizeEpicId } from './theme.js';
import { readAllTasks, tasksOf, taskTableRows } from './task.js';
import { readBlockers } from './blockers.js';
import { loadFlow } from './flow.js';
import { readFeatureOrder, rankedFeatures, unrankedFeatures, FEATURE_ORDER_FILE } from './feature-order.js';
import {
  FEATURES_DIR,
  featuresRoot,
  scanFeatureDirs,
  readFeature,
  storyLinkFromFeature,
  featureRepoOrder,
  LEAD_REPO,
} from './feature.js';

// ---------------------------------------------------------------------------
// Markdown tables
// ---------------------------------------------------------------------------

function stripLink(cell) {
  return String(cell ?? '').replace(/^\[([^\]]+)\]\(.*\)$/, '$1');
}

function parseTableIds(text) {
  if (!text) return [];
  return text
    .trim()
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .slice(2)
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    )
    .map((cells) => stripLink(cells[0]))
    .filter(Boolean);
}

export function formatTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length), 3));
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const row = (r) => '| ' + headers.map((_, i) => pad(r[i], widths[i])).join(' | ') + ' |';
  const sep = '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
  return [row(headers), sep, ...rows.map(row)].join('\n');
}

/**
 * Flatten an `fm.commit` value into the single string that sync stores in its
 * internal story map. Scalar values pass through; map values prefer
 * `repo`'s SHA (a story's one repo; for a feature, which names none, `bl`,
 * the lead of the repo order, F-52 D3), fall back to the first map value,
 * else "". The on-disk frontmatter is left untouched — sync only writes
 * rolled-up index tables.
 */
export function flattenCommit(rawCommit, repo = LEAD_REPO) {
  if (rawCommit == null || rawCommit === '') return '';
  if (typeof rawCommit === 'string') return rawCommit;
  if (typeof rawCommit === 'object' && !Array.isArray(rawCommit)) {
    if (repo && typeof rawCommit[repo] === 'string') {
      return rawCommit[repo];
    }
    const first = Object.values(rawCommit).find((v) => typeof v === 'string');
    return first ?? '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Story and component collection
// ---------------------------------------------------------------------------

function noteMarkdown(touchedMarkdown, path) {
  if (path.endsWith('.md')) touchedMarkdown.add(path);
}

/**
 * Replace `path` with `content` atomically (`atomicWriteFile`), unless it
 * equals `previous`, the bytes read before the regeneration. Only the
 * backlog lock's writers use it (epic, theme, component and top-level
 * indexes, F-67 D2); a story or feature spec goes through `updateSpecFile`.
 */
function writeFileIfChanged(backlogRoot, path, content, previous, touchedMarkdown) {
  if (content === previous) return false;
  atomicWriteFile(backlogRoot, path, content);
  noteMarkdown(touchedMarkdown, path);
  return true;
}

/**
 * Every story under `stories/` as a sync record: its component comes from
 * `readAllStories` (`story.js` `placeStory`), the rest from its
 * frontmatter. Unknown statuses and keys are warnings, as `bl validate` makes
 * them errors.
 */
function readStoriesForSync(config, flow) {
  const stories = [];
  for (const s of readAllStories(config)) {
    const { fm } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
    const status = fm.status ?? 'backlog';
    if (!flow.statusesOf('story').includes(status)) {
      console.warn(`  warning: ${s.storyRelPath} has unknown status "${status}"`);
    }
    // Run-state keys left in an index.md are `bl validate`'s
    // run-state-in-spec errors, not unknown keys.
    for (const key of Object.keys(fm)) {
      if (!VALID_STORY_KEYS.has(key) && !key.startsWith('plugins-') && !RUN_STATE_KEYS.includes(key)) {
        console.warn(`  warning: ${s.storyRelPath} has unknown frontmatter key "${key}"`);
      }
    }
    stories.push({
      componentId: s.componentId,
      id: s.id,
      title: s.title,
      type: s.type,
      points: parseInt(fm.points ?? '0', 10) || 0,
      status,
      added: fm.added ?? '',
      completed: fm.completed ?? '',
      commit: flattenCommit(fm.commit, s.unitRepo),
      feature: s.feature,
      unitRepo: s.unitRepo,
      depends_on: fm.depends_on,
      storyEntry: s.storyEntry,
      indexPath: s.indexPath,
    });
  }
  return stories;
}

// ---------------------------------------------------------------------------
// Link helpers
// ---------------------------------------------------------------------------
//
// Every unit sits at a fixed depth (F-49 D3): `stories/<entry>/`,
// `components/<entry>/`, `features/<entry>/`, `epics/<entry>/` and
// `themes/<slug>/` are all two levels below the backlog root, so a link from one index to another is
// `../../` and the target's root-relative path. Nothing moves when its status
// changes, so no link depends on one.

function storyLinkFromTop(story) {
  return `${STORIES_DIR}/${story.storyEntry}/index.md`;
}

function componentLinkFromTop(component) {
  return `${COMPONENTS_DIR}/${component.componentEntry}/index.md`;
}

/** A root-relative path, linked from an index two levels down. */
function fromUnit(topPath) {
  return `../../${topPath}`;
}

/**
 * `[C01](<path>)` for a story's component, or the bare id when the component
 * has no directory (`bl validate` reports it as `component-unknown`), so no
 * link points at a missing file.
 */
function componentRef(componentsById, story, link) {
  const c = componentsById.get(story.componentId);
  if (!c) return story.componentId;
  return `[${c.id}](${link(componentLinkFromTop(c))})`;
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the body of `## <heading>` with `content`, or create the section
 * (after `## <after>` when that exists, else before `## <before>` when that
 * exists, else at the end). A section that ends the file takes the trailing
 * blank lines with it, so a rewrite never grows the file. Function replacers
 * throughout so `$` in titles never turns into a backreference.
 */
function upsertSection(body, heading, content, { after, before } = {}) {
  // The section body runs to the next `## ` (keeping the newline before it)
  // or to the end of the file (taking the trailing whitespace).
  const END = `(?:(\\n)(?=## )|\\s*$)`;
  const re = new RegExp(`(## ${escapeRe(heading)}\\n)([\\s\\S]*?)${END}`);
  if (re.test(body)) {
    return body.replace(re, (_m, head, _old, nl) => `${head}\n${content}\n${nl ?? ''}`);
  }
  if (after) {
    const afterRe = new RegExp(`(## ${escapeRe(after)}\\n[\\s\\S]*?)${END}`);
    if (afterRe.test(body)) {
      return body.replace(afterRe, (_m, prev, nl) => `${prev.trimEnd()}\n\n## ${heading}\n\n${content}\n${nl ?? ''}`);
    }
  }
  if (before && hasSection(body, before)) {
    return body.replace(new RegExp(`^## ${escapeRe(before)}\\n`, 'm'), (m) => `## ${heading}\n\n${content}\n\n${m}`);
  }
  return `${body.trimEnd()}\n\n## ${heading}\n\n${content}\n`;
}

function hasSection(body, heading) {
  return new RegExp(`^## ${escapeRe(heading)}\\n`, 'm').test(body);
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/**
 * Read every feature and resolve its story records against `storyMap`.
 * Nothing moves: a closed feature stays in `features/` (F-49 D3).
 */
function readFeaturesForSync(config, storyMap) {
  const root = featuresRoot(config);
  if (!existsSync(root)) return [];

  const features = [];
  for (const entry of scanFeatureDirs(config)) {
    const f = readFeature(entry, config);
    if (!f) continue;
    for (const key of Object.keys(f.fm)) {
      if (!VALID_FEATURE_KEYS.has(key) && !key.startsWith('plugins-') && !RUN_STATE_KEYS.includes(key)) {
        console.warn(`  warning: ${f.featureRelPath} has unknown frontmatter key "${key}"`);
      }
    }
    f.storyRecords = f.stories.map((id) => storyMap.get(id)).filter(Boolean);
    f.computedPoints = f.storyRecords.reduce((sum, s) => sum + s.points, 0);
    f.repos = featureRepoOrder(f.storyRecords);
    f.commit = flattenCommit(f.fm.commit);
    features.push(f);
  }
  return features;
}

function featureLinkFromTop(f) {
  return `${FEATURES_DIR}/${f.featureEntry}/index.md`;
}

function featuresTouchingComponent(features, componentId, flow) {
  return features.filter(
    (f) => !flow.meets('feature', f.status, 'done') && f.storyRecords.some((s) => s.componentId === componentId),
  );
}

// ---------------------------------------------------------------------------
// Tasks (F-65 D1)
// ---------------------------------------------------------------------------

/**
 * What the `## Tasks` tables are built from: every task, the edges in
 * `blockers.json` and the flow, for the verbs a hold names. A
 * `blockers.json` that cannot be read is `bl validate`'s to report; the table
 * then shows no holds.
 */
function readTaskContext(config, flow) {
  const tasks = readAllTasks(config);
  if (tasks.length === 0) return { tasks, edges: [], flow };
  let edges = [];
  try {
    edges = readBlockers(config.backlogRoot).edges;
  } catch {
    // Reported by bl validate (blockers-json).
  }
  return { tasks, edges, flow };
}

/**
 * `body` with its `## Tasks` table rewritten after `## <after>`, when unit
 * `id` has a task; else `body` unchanged, so a unit with none is left byte
 * for byte. Every unit sits two levels down (`fromUnit`).
 */
function withTasksTable(body, id, taskCtx, after) {
  const own = tasksOf(id, taskCtx.tasks);
  if (own.length === 0) return body;
  const { headers, rows } = taskTableRows(own, taskCtx.edges, taskCtx.flow, fromUnit);
  return upsertSection(body, 'Tasks', formatTable(headers, rows), { after });
}

/**
 * Write the `## Tasks` table of every story with a task, after
 * `## Dependencies`, through `updateSpecFile`: the table goes into the spec
 * as read under its spec lock, so a token step entry a session wrote since
 * collection stays. Called inside the backlog lock (F-67 D4: the backlog
 * lock outer, the spec lock inner, one spec lock at a time).
 */
function syncStoryTasks(backlogRoot, stories, taskCtx, touchedMarkdown) {
  const units = new Set(taskCtx.tasks.map((t) => t.unit));
  for (const s of stories) {
    if (!units.has(s.id)) continue;
    const wrote = updateSpecFile(backlogRoot, s.indexPath, (_fm, body) => {
      const newBody = withTasksTable(body, s.id, taskCtx, 'Dependencies');
      return newBody === body ? false : newBody;
    });
    if (wrote) noteMarkdown(touchedMarkdown, s.indexPath);
  }
}

/**
 * Regenerate one feature's Stories table, points, and `components:` roll-up
 * (derived from its stories, F-49 D1), and its Tasks table when it has a
 * task. The pre-F-49 `epics:` roll-up it replaces is dropped.
 *
 * The rewrite goes through `updateSpecFile` and starts from the spec as read
 * under its spec lock, not from `f.content` read at collection, so a token
 * step entry a session wrote in between stays. Called inside the backlog
 * lock (F-67 D4: the backlog lock outer, the spec lock inner, one spec lock
 * at a time).
 */
function syncFeature(backlogRoot, f, componentsById, touchedMarkdown, taskCtx = { tasks: [] }) {
  const rows = f.storyRecords.map((s) => [
    `[${s.id}](${storyLinkFromFeature(f, storyLinkFromTop(s))})`,
    componentRef(componentsById, s, (p) => storyLinkFromFeature(f, p)),
    s.type,
    s.title,
    s.points,
    s.status,
  ]);
  const table = formatTable(['ID', 'Component', 'Type', 'Title', 'Points', 'Status'], rows);
  const changed = updateSpecFile(backlogRoot, f.indexPath, (fm, body) => {
    fm.points = String(f.computedPoints);
    delete fm.epics;
    fm.components = [...new Set(f.storyRecords.map((s) => s.componentId).filter(Boolean))].sort();
    return withTasksTable(upsertSection(body, 'Stories', table, { after: 'Acceptance' }), f.id, taskCtx, 'Stories');
  });
  if (changed) noteMarkdown(touchedMarkdown, f.indexPath);
  info(
    `  ${f.featureRelPath} — ${f.storyRecords.length} stories, ${f.computedPoints} points${changed ? '' : ' (unchanged)'}`,
  );
}

// ---------------------------------------------------------------------------
// Epics and themes (F-51 D3)
// ---------------------------------------------------------------------------

function epicLinkFromTop(e) {
  return `${EPICS_DIR}/${e.epicEntry}/index.md`;
}

function themeLinkFromTop(t) {
  return `${THEMES_DIR}/${t.themeEntry}/index.md`;
}

function featureNum(f) {
  return parseInt(String(f.id).replace(/^F-/, ''), 10);
}

/** The features naming epic `epicId` (`E50`), in id order. */
function featuresOfEpic(features, epicId) {
  return features.filter((f) => normalizeEpicId(f.epic)?.id === epicId).sort((a, b) => featureNum(a) - featureNum(b));
}

/**
 * An epic's derived status: `done` once it has features and every one is
 * closed (meets `done`), else `open`.
 */
export function epicStatus(epicFeatures, flow) {
  return epicFeatures.length > 0 && epicFeatures.every((f) => flow.meets('feature', f.status, 'done'))
    ? 'done'
    : 'open';
}

/** `<closed>/<total>` over `items` of the flow type `type`, by their `status`. */
function doneOfTotal(items, type, flow) {
  return `${items.filter((i) => flow.meets(type, i.status, 'done')).length}/${items.length}`;
}

/** `<closed points>/<total points>` over a feature's story records. */
function pointsDoneOfTotal(stories, flow) {
  const done = stories.filter((s) => flow.meets('story', s.status, 'done')).reduce((sum, s) => sum + s.points, 0);
  return `${done}/${stories.reduce((sum, s) => sum + s.points, 0)}`;
}

/** The Features table of an epic or theme index (links from two levels down). */
function valueFeaturesTable(features, flow) {
  return formatTable(
    ['ID', 'Title', 'Status', 'Stories', 'Points'],
    features.map((f) => [
      `[${f.id}](${fromUnit(featureLinkFromTop(f))})`,
      f.title,
      f.status,
      doneOfTotal(f.storyRecords, 'story', flow),
      pointsDoneOfTotal(f.storyRecords, flow),
    ]),
  );
}

/**
 * Regenerate one epic's index: `features:` and `status:` derived from the
 * features naming it, and its Features table after `## Outcome`.
 */
function syncEpic(backlogRoot, epic, features, touchedMarkdown, flow) {
  const content = readFileSync(epic.indexPath, 'utf8');
  const { fm, body } = parseFrontmatter(content);
  const own = featuresOfEpic(features, epic.id);
  fm.features = own.map((f) => f.id);
  fm.status = epicStatus(own, flow);
  const newBody = upsertSection(body, 'Features', valueFeaturesTable(own, flow), {
    after: 'Outcome',
  });
  const changed = writeFileIfChanged(
    backlogRoot,
    epic.indexPath,
    serializeFrontmatter(fm) + newBody,
    content,
    touchedMarkdown,
  );
  info(`  ${epic.relPath} — ${own.length} features, ${fm.status}${changed ? '' : ' (unchanged)'}`);
  return { ...epic, status: fm.status, featureRecords: own };
}

/**
 * Regenerate one theme's index: its epics (id, title, status, features
 * done/total), then its features that have no epic.
 */
function syncTheme(backlogRoot, theme, epics, features, touchedMarkdown, flow) {
  const content = readFileSync(theme.indexPath, 'utf8');
  const { fm, body } = parseFrontmatter(content);
  const own = epics.filter((e) => e.theme === theme.id);
  const loose = features
    .filter((f) => f.theme === theme.id && !String(f.epic ?? '').trim())
    .sort((a, b) => featureNum(a) - featureNum(b));
  const epicsTable = formatTable(
    ['ID', 'Title', 'Status', 'Features'],
    own.map((e) => [
      `[${e.id}](${fromUnit(epicLinkFromTop(e))})`,
      e.title,
      e.status,
      doneOfTotal(e.featureRecords, 'feature', flow),
    ]),
  );
  let newBody = upsertSection(body, 'Epics', epicsTable, { after: 'Overview' });
  newBody = upsertSection(newBody, 'Features', valueFeaturesTable(loose, flow), {
    after: 'Epics',
  });
  const changed = writeFileIfChanged(
    backlogRoot,
    theme.indexPath,
    serializeFrontmatter(fm) + newBody,
    content,
    touchedMarkdown,
  );
  info(
    `  ${theme.relPath} — ${own.length} epics, ${loose.length} features without an epic${changed ? '' : ' (unchanged)'}`,
  );
}

// ---------------------------------------------------------------------------
// Feature order (F-53 D1)
// ---------------------------------------------------------------------------

/** A table cell's text: one line, a `|` escaped so it ends no cell. */
function cell(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');
}

/**
 * Regenerate `feature-order.md`'s `## Next up` (#, Feature, Title, Theme,
 * Epic, Why) and `## Not yet ranked` tables from its `ranked:` and the
 * features' frontmatter. Everything else, the frontmatter block included, is
 * written back byte for byte, and only when it changed, replacing the file
 * atomically: it holds the operator's ranking and History. No file is a warning, not an error: until the
 * F-53 migration has run, `bl validate` reports it.
 */
function syncFeatureOrder(config, features, touchedMarkdown, flow) {
  let order;
  try {
    order = readFeatureOrder(config);
  } catch (e) {
    console.warn(`  warning: ${FEATURE_ORDER_FILE} not regenerated: ${e.message}`);
    return;
  }
  if (!order) return;
  const ranked = rankedFeatures(order, features, flow);
  const unranked = unrankedFeatures(order, features, flow);
  const featureRef = (f) => `[${f.id}](${featureLinkFromTop(f)})`;
  const nextUp = formatTable(
    ['#', 'Feature', 'Title', 'Theme', 'Epic', 'Why'],
    ranked.map((r) => [
      r.position,
      featureRef(r.feature),
      cell(r.feature.title),
      cell(r.feature.theme),
      cell(normalizeEpicId(r.feature.epic)?.id ?? r.feature.epic),
      cell(r.why),
    ]),
  );
  const notRanked = formatTable(
    ['Feature', 'Title', 'Theme'],
    unranked.map((f) => [featureRef(f), cell(f.title), cell(f.theme)]),
  );
  let body = upsertSection(order.body, 'Next up', nextUp, { before: 'History' });
  body = upsertSection(body, 'Not yet ranked', notRanked, { after: 'Next up' });
  const content = order.fmText + body;
  const changed = content !== order.content;
  if (changed) {
    atomicWriteFile(config.backlogRoot, order.indexPath, content);
    noteMarkdown(touchedMarkdown, order.indexPath);
  }
  info(
    `  ${FEATURE_ORDER_FILE} — ${ranked.length} ranked, ${unranked.length} not yet ranked${changed ? '' : ' (unchanged)'}`,
  );
}

// ---------------------------------------------------------------------------
// Global priority order (from top-level index)
// ---------------------------------------------------------------------------

function buildGlobalOrder(backlogIds) {
  const order = new Map();
  backlogIds.forEach((id, i) => order.set(id, i));
  return order;
}

function sortByGlobal(stories, globalOrder) {
  const known = stories.filter((s) => globalOrder.has(s.id));
  const unknown = stories.filter((s) => !globalOrder.has(s.id));
  known.sort((a, b) => globalOrder.get(a.id) - globalOrder.get(b.id));
  unknown.sort((a, b) => {
    const na = parseInt(a.id.replace('S-', ''), 10);
    const nb = parseInt(b.id.replace('S-', ''), 10);
    return na - nb;
  });
  return [...known, ...unknown];
}

// ---------------------------------------------------------------------------
// Component-level sync
// ---------------------------------------------------------------------------

/**
 * Regenerate one component's index: its open stories in priority order and
 * the active features touching it. A component has no points or status
 * (F-49 D4), so its frontmatter is left as it is.
 */
function syncComponent(backlogRoot, component, stories, globalOrder, touchedMarkdown, features, flow) {
  const content = readFileSync(component.indexPath, 'utf8');
  const { fm, body } = parseFrontmatter(content);
  const rel = `${COMPONENTS_DIR}/${component.componentEntry}/index.md`;

  for (const key of Object.keys(fm)) {
    if (!VALID_COMPONENT_KEYS.has(key) && !key.startsWith('plugins-')) {
      console.warn(`  warning: ${rel} has unknown key "${key}"`);
    }
  }

  const sorted = sortByGlobal(stories, globalOrder);
  const active = sorted.filter((s) => !flow.meets('story', s.status, 'done'));
  const done = sorted.length - active.length;

  const storiesTable = formatTable(
    ['ID', 'Type', 'Title', 'Points', 'Status'],
    active.map((s) => [`[${s.id}](${fromUnit(storyLinkFromTop(s))})`, s.type, s.title, s.points, s.status]),
  );

  let newBody = body.replace(/\n## Completed[\s\S]*$/, '').trimEnd() + '\n';
  newBody = upsertSection(newBody, 'Stories', storiesTable);

  // Features touching this component. The section is only created once a
  // feature references a story here, so other components keep their shape.
  const touching = featuresTouchingComponent(features, component.id, flow);
  if (touching.length > 0 || hasSection(newBody, 'Features')) {
    const featuresTable = formatTable(
      ['ID', 'Title', 'Status', 'Stories here'],
      touching.map((f) => [
        `[${f.id}](${fromUnit(featureLinkFromTop(f))})`,
        f.title,
        f.status,
        f.storyRecords.filter((s) => s.componentId === component.id).length,
      ]),
    );
    newBody = upsertSection(newBody, 'Features', featuresTable, {
      after: 'Stories',
    });
  }
  newBody = newBody.trimEnd() + '\n';

  const newFile = serializeFrontmatter(fm) + newBody;
  const changed = writeFileIfChanged(backlogRoot, component.indexPath, newFile, content, touchedMarkdown);
  info(`  ${rel} — ${active.length} active, ${done} done${changed ? '' : ' (unchanged)'}`);
}

// ---------------------------------------------------------------------------
// Top-level sync
// ---------------------------------------------------------------------------

/**
 * The backlog's display name in its top-level `index.md`: `backlog.json`
 * `title`, else "Backlog" (`config.title`, S-581).
 */
function indexTitle(config) {
  return config.title ?? DEFAULT_BACKLOG_TITLE;
}

/** `title` as a one-line YAML scalar, quoted only when YAML needs it. */
function yamlScalar(title) {
  return stringifyYaml(title, { lineWidth: 0 }).trimEnd();
}

/**
 * Set the top-level index's frontmatter `title:` and its first `# ` heading
 * to `title`, so a change to `backlog.json` `title` reaches an index an
 * older sync wrote.
 */
function withIndexTitle(content, title) {
  const fm = content.match(/^---\n([\s\S]*?\n)?---\n/);
  // Function replacers: a `$&` or `$1` in the title is text, not a pattern.
  const head = fm ? fm[0].replace(/^title: .*$/m, () => `title: ${yamlScalar(title)}`) : '';
  return head + content.slice(fm ? fm[0].length : 0).replace(/^# .*$/m, () => `# ${title}`);
}

function ensureTopLevelIndex(backlogRoot, touchedMarkdown, title) {
  const indexPath = join(backlogRoot, 'index.md');
  if (existsSync(indexPath)) return indexPath;
  const stub =
    `---\n` +
    `title: ${yamlScalar(title)}\n` +
    `---\n\n` +
    `# ${title}\n\n` +
    `Total backlog: 0 points across 0 stories in 0 components.\n\n` +
    `## Components\n\n` +
    `| ID | Title | Repo | Home | Open | Done |\n` +
    `| -- | ----- | ---- | ---- | ---- | ---- |\n\n` +
    `## Backlog\n\n` +
    `| ID | Type | Component | Title | Points |\n` +
    `| -- | ---- | --------- | ----- | ------ |\n`;
  atomicWriteFile(backlogRoot, indexPath, stub);
  noteMarkdown(touchedMarkdown, indexPath);
  return indexPath;
}

function syncTopLevel(config, ctx, backlogIds, touchedMarkdown, features) {
  const { storyMap, components, componentsById, themes, epics } = ctx;
  const indexPath = ensureTopLevelIndex(config.backlogRoot, touchedMarkdown, indexTitle(config));
  const content = readFileSync(indexPath, 'utf8');

  const seen = new Set(backlogIds);
  // Never-indexed stories go last in id order (`sortByGlobal`), as every
  // other index sorts them.
  const unseen = sortByGlobal(
    [...storyMap.values()].filter((s) => !seen.has(s.id)),
    new Map(),
  ).map((s) => s.id);
  const ordered = [...backlogIds, ...unseen].map((id) => storyMap.get(id)).filter((s) => s != null);
  const closed = (s) => ctx.flow.meets('story', s.status, 'done');
  const active = ordered.filter((s) => !closed(s));
  const done = ordered.length - active.length;

  // No points: a component is a label and never finishes (F-49 D4).
  const componentRows = components.map((c) => {
    const stories = [...storyMap.values()].filter((s) => s.componentId === c.id);
    const open = stories.filter((s) => !closed(s)).length;
    return [`[${c.id}](${componentLinkFromTop(c)})`, c.title, c.repo, c.home ? 'yes' : '', open, stories.length - open];
  });

  const totalPoints = active.reduce((sum, s) => sum + s.points, 0);

  const componentsTable = formatTable(['ID', 'Title', 'Repo', 'Home', 'Open', 'Done'], componentRows);
  const backlogTable = formatTable(
    ['ID', 'Type', 'Component', 'Title', 'Points'],
    active.map((s) => [
      `[${s.id}](${storyLinkFromTop(s)})`,
      s.type,
      componentRef(componentsById, s, (p) => p),
      s.title,
      s.points,
    ]),
  );

  // A Projects table an older sync wrote goes (F-51 D3): projects are
  // retired and no project page is written for it to link to.
  let newContent = withIndexTitle(content, indexTitle(config))
    .replace(/\n*## Completed\n[\s\S]*$/, '')
    .replace(
      /Total backlog: \d+ points across \d+ stories in \d+ components\./,
      `Total backlog: ${totalPoints} points across ${active.length} stories in ${componentRows.length} components.`,
    )
    .replace(/^## Projects\n[\s\S]*?(?=^## |(?![\s\S]))/m, '');

  // Themes table (F-51 D3): created once the backlog has a theme, so a
  // backlog without themes keeps its exact index.
  if (themes.length > 0 || hasSection(newContent, 'Themes')) {
    const themesTable = formatTable(
      ['Theme', 'Title', 'Epics', 'Open features'],
      themes.map((t) => [
        `[${t.id}](${themeLinkFromTop(t)})`,
        t.title,
        epics.filter((e) => e.theme === t.id).length,
        features.filter((f) => f.theme === t.id && !ctx.flow.meets('feature', f.status, 'done')).length,
      ]),
    );
    const anchor = ['Components', 'Features', 'Backlog'].find((h) => hasSection(newContent, h));
    newContent = upsertSection(newContent, 'Themes', themesTable, {
      before: anchor,
    });
  }
  newContent = upsertSection(newContent, 'Components', componentsTable, {
    before: hasSection(newContent, 'Features') ? 'Features' : 'Backlog',
  });

  // Features table (active only) between Components and Backlog. Created on
  // first use so backlogs without features keep their exact current index.
  const activeFeatures = features.filter((f) => !ctx.flow.meets('feature', f.status, 'done'));
  if (activeFeatures.length > 0 || hasSection(newContent, 'Features')) {
    const featuresTable = formatTable(
      ['ID', 'Title', 'Status', 'Points', 'Stories', 'Repo'],
      activeFeatures.map((f) => [
        `[${f.id}](${featureLinkFromTop(f)})`,
        f.title,
        f.status,
        f.computedPoints,
        f.storyRecords.length,
        f.repos.join(', '),
      ]),
    );
    newContent = upsertSection(newContent, 'Features', featuresTable, {
      before: 'Backlog',
    });
  }

  newContent = upsertSection(newContent, 'Backlog', backlogTable);

  const changed = writeFileIfChanged(config.backlogRoot, indexPath, newContent, content, touchedMarkdown);
  info(
    `  index.md — ${active.length} active, ${done} done, ${componentRows.length} components${changed ? '' : ' (unchanged)'}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Regenerate every index under the backlog lock. Re-entrant: `bl new` and
 * `bl new --feature` already hold the lock when they call this.
 *
 * @returns {Promise<string[]>} sorted backlog-relative paths of the indexes
 *   this run changed. An index this run rewrote byte-for-byte is left out, so
 *   a dirty index an earlier uncommitted sync left behind never rides along.
 *   Sync moves nothing: status is frontmatter, never location (F-49 D3).
 */
export async function runSync(config) {
  return withLock(config.backlogRoot, () => regenerate(config));
}

async function regenerate(config) {
  const touchedMarkdown = new Set();
  const flow = loadFlow(config.backlogRoot);

  const allStories = readStoriesForSync(config, flow);
  const dupes = findDuplicateIds(allStories);
  if (dupes.length > 0) {
    const err = new Error(dupes.map((d) => d.message).join('; '));
    err.code = 'DUPLICATE_STORY_IDS';
    err.duplicates = dupes;
    throw err;
  }
  const storyMap = new Map(allStories.map((s) => [s.id, s]));

  const closedCount = allStories.filter((s) => flow.meets('story', s.status, 'done')).length;
  info(
    `backlog-sync: ${storyMap.size} stories (${storyMap.size - closedCount} active, ${closedCount} ${flow.closedStatusesOf('story').join('/')})`,
  );

  const backlogIds = readBacklogOrder(config.backlogRoot);
  const globalOrder = buildGlobalOrder(backlogIds);

  // Components keep their first directory when two claim one id
  // (`bl validate` reports the clash).
  const components = [];
  const componentsById = new Map();
  for (const c of readComponents(config)) {
    if (componentsById.has(c.id)) continue;
    componentsById.set(c.id, c);
    components.push(c);
  }
  const ctx = { storyMap, components, componentsById, globalOrder, flow };

  // Features: resolve story records, regenerate tables. Then the stories'
  // Tasks tables (F-65 D1).
  const taskCtx = readTaskContext(config, flow);
  const features = readFeaturesForSync(config, storyMap);
  if (features.length > 0) {
    info(`backlog-sync: ${features.length} feature(s)`);
    for (const f of features) syncFeature(config.backlogRoot, f, componentsById, touchedMarkdown, taskCtx);
  }
  syncStoryTasks(config.backlogRoot, allStories, taskCtx, touchedMarkdown);

  for (const c of components) {
    syncComponent(
      config.backlogRoot,
      c,
      allStories.filter((s) => s.componentId === c.id),
      globalOrder,
      touchedMarkdown,
      features,
      flow,
    );
  }

  // Epics before themes: a theme's Epics table shows each epic's derived
  // status.
  const epics = readAllEpics(config).map((e) => syncEpic(config.backlogRoot, e, features, touchedMarkdown, flow));
  const themes = readAllThemes(config);
  for (const t of themes) syncTheme(config.backlogRoot, t, epics, features, touchedMarkdown, flow);
  ctx.epics = epics;
  ctx.themes = themes;

  syncTopLevel(config, ctx, backlogIds, touchedMarkdown, features);
  syncFeatureOrder(config, features, touchedMarkdown, flow);

  formatBacklogMarkdown(config, touchedMarkdown);
  info('done.');
  return [...touchedMarkdown]
    .map((p) => relative(config.backlogRoot, p))
    .filter((p) => p && !p.startsWith('..'))
    .sort();
}

/**
 * Run the configured `format` plugin over Markdown files this sync invocation
 * touched. Backlog-scoped (no story context). The plugin registered for `.md`
 * under `language_dispatch.format` runs; absence is a silent skip (`bl sync`
 * must not crash on a fresh `bl init` that hasn't picked a Markdown formatter).
 *
 * The backlog-root cascade is consulted purely for opt-out: a top-level
 * `plugins-format: -md` in `<backlogRoot>/index.md` suppresses the pass.
 * Defaults run otherwise — gating on the cascade as an *include* list (the
 * earlier model) made the pass dead in any setup that didn't redundantly
 * declare `plugins-format: md`.
 */
export function formatBacklogMarkdown(config, touchedMarkdown) {
  const dispatch = config.languageDispatch ?? {};
  const formatMap = dispatch.format ?? {};
  const mdPlugins = formatMap['.md'];
  if (!mdPlugins) return;
  const pluginNames = Array.isArray(mdPlugins) ? mdPlugins : [mdPlugins];

  const { removes } = parsePluginCascade('format', {
    backlogRoot: config.backlogRoot,
  });
  const activePluginNames = pluginNames.filter((name) => !removes.includes(name) && config.plugins[name]?.format);
  if (activePluginNames.length === 0) return;

  const files = [...touchedMarkdown]
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .map((path) => relative(config.backlogRoot, path))
    .filter((path) => path && !path.startsWith('..'));
  if (files.length === 0) return;

  // Bucket by plugin so sync uses the same dispatch semantics as bl format /
  // bl lint, but only over files this sync invocation touched.
  const buckets = bucketByPlugin(files, 'format', { format: { '.md': activePluginNames } }, config.plugins);
  for (const [name, paths] of buckets) {
    runPluginBatch(name, config.plugins[name].format, paths, { roostDir: config.roostDir }, config.backlogRoot);
  }
}

/**
 * Keep the paths git can stage: those on disk, plus vanished ones git still
 * tracks (the source side of a migration), in the index or in HEAD. The
 * source of a `git mv` is already gone from the index, so `--with-tree=HEAD`
 * keeps it; without it the commit would leave the old files in the tree. A
 * migrated directory that was never committed has nothing to stage, and
 * naming it would fail the pathspec.
 */
function stageablePaths(root, paths) {
  return paths.filter((p) => {
    if (existsSync(join(root, p))) return true;
    const r = spawnSync('git', ['ls-files', '--with-tree=HEAD', '--', p], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 && r.stdout.trim() !== '';
  });
}

/**
 * Why `p` is not an exact backlog-relative path for `--path`, or null when it
 * is. `--path` is operator input that reaches `git add` and `git commit
 * --only` as a pathspec, so anything wider than one named file or directory
 * (the root, a whole unit directory such as `stories/`, a glob,
 * a git magic pathspec, a path that climbs out of the backlog) would sweep
 * unrelated work into the commit.
 *
 * @param {string} p
 * @returns {string | null}
 */
export function extraPathProblem(p) {
  if (p === '') return 'is empty';
  if (p.startsWith(':')) return 'is a git pathspec, not a path';
  if (/[*?[\]\\]/.test(p)) return 'contains glob characters';
  if (p.startsWith('/')) return 'is absolute, not backlog-relative';
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'is not a normalized relative path';
  }
  if (segments[0] === '.git') return 'is inside .git/';
  // Each top-level unit directory holds every story, component, feature,
  // theme or epic beside the one the operator means.
  const whole = [STORIES_DIR, COMPONENTS_DIR, FEATURES_DIR, THEMES_DIR, EPICS_DIR];
  if (whole.some((d) => d === p || d.startsWith(`${p}/`))) {
    return 'names a whole unit directory, or more';
  }
  return null;
}

/**
 * Where a regeneration after a pull that has not been committed yet keeps
 * the dirty snapshot it started from, so the next command finishes it.
 */
const PULL_REGEN_PENDING = join('.bl', 'run', 'pull-regenerate.json');

/**
 * Rebase the backlog onto `origin/main` before a command (F-50 D4; see
 * `backlog-commit.js` `pullBacklog`), under the backlog lock so no other `bl`
 * process commits mid-rebase. A pull that brought anything is followed by a
 * regeneration (`runSync`, and `allowed-tools.json`, whose inputs a pulled
 * `backlog.json` may have changed without touching the file), committed and
 * pushed when it changed a path, so two clones never need a human for a
 * generated file. Pull failures are warnings; the command goes on from local
 * state, unless the pull is `unsafe`. A regeneration that cannot be built or
 * committed is `unsafe` too: it is left pending (`PULL_REGEN_PENDING`) and
 * the next command that pulls finishes it before it runs, pulled or not. A
 * push that fails after the commit is only a warning (`commitPaths`). An
 * interrupted `bl new --feature` is settled after the pull and before the
 * regeneration (`feature-links.js` `settlePending`).
 *
 * @param {object} config
 * @returns {Promise<import("./backlog-commit.js").BacklogPull>}
 */
export async function pullBeforeCommand(config) {
  const root = config.backlogRoot;
  // Nothing to pull: leave the lock to the command, whose first wait for it
  // is then the one it announces.
  if (!hasOriginRemote(root)) return { state: 'no-remote' };
  await acquireLock(root);
  try {
    const res = pullBacklog(root);
    reportBacklogPull(res, root);
    const pendingPath = join(root, PULL_REGEN_PENDING);
    const pending = existsSync(pendingPath);
    if (res.state !== 'pulled' && !(pending && res.state !== 'unsafe' && res.state !== 'not-main')) {
      return res;
    }
    // The regeneration reads membership: settle an interrupted
    // `bl new --feature` first, so its half-made links are not committed.
    const { settlePending } = await import('./feature-links.js');
    await settlePending(root);
    const problem = await regenerateAfterPull(root, config, pendingPath, pending);
    if (!problem) return res;
    process.stderr.write(
      `error: the backlog regeneration after the pull did not finish (${problem}); not running the command. The next bl command that pulls retries it.\n`,
    );
    return { ...res, state: 'unsafe', message: problem };
  } finally {
    releaseLock(root);
  }
}

/**
 * Rebuild the generated files for the pulled backlog and commit what that
 * changed since the regeneration began (`pendingPath` holds that snapshot
 * while it is unfinished). Null when done, else what failed.
 */
async function regenerateAfterPull(root, config, pendingPath, pending) {
  let before;
  try {
    if (pending) {
      before = new Map(JSON.parse(readFileSync(pendingPath, 'utf8')));
    } else {
      before = dirtySnapshot(root);
      if (!before) return 'git status failed';
      mkdirSync(join(pendingPath, '..'), { recursive: true });
      atomicWriteFile(root, pendingPath, JSON.stringify([...before]));
    }
    // The pull may have brought a new backlog.json.
    const flag = agentFlagOf(config);
    const fresh = configForRepo(
      loadConfig({
        backlogRoot: root,
        agent: flag.agent ?? undefined,
        agentRole: flag.role,
        lenientAgents: flag.lenient,
      }),
      config.repoName,
    );
    await runSync(fresh);
    // A no-op when the file is current for the pulled configuration.
    ensureAllowedTools(root, fresh);
  } catch (err) {
    return err.message;
  }
  const after = dirtySnapshot(root);
  if (!after) return 'git status failed';
  const touched = pathsChangedSince(before, after).filter((p) => p !== PULL_REGEN_PENDING);
  if (touched.length > 0) {
    const c = commitPaths(root, touched, 'chore: regenerate backlog indexes after pull');
    if (!c.committed) return `commit failed: ${c.error ?? 'nothing to commit'}`;
  }
  rmSync(pendingPath, { force: true });
  return null;
}

/**
 * `bl sync --commit`: under one lock hold, regenerate the indexes and commit
 * exactly (paths `runSync` reported) ∪ (each story's directory) ∪
 * `extraPaths`. Never stages the whole backlog, so an unrelated dirty story
 * file, including one another agent edits while this holds the lock, stays out
 * of the commit. `bl done`, `bl new` and `bl merge` commit through this too,
 * holding the lock across their own writes so the sync sees them.
 *
 * When the backlog is not a git work tree, the sync still runs and the result
 * carries `notRepo: true` instead of committing.
 *
 * @param {object} config
 * @param {{ message: string, storyIds?: string[], extraPaths?: string[] }} opts
 *   `extraPaths` are backlog-relative paths the caller wrote or moved itself
 *   (a new component dir, an appended feature file).
 * @returns {Promise<{ committed: boolean, paths: string[], error?: string,
 *   notRepo?: boolean }>}
 */
export async function syncAndCommit(config, { message, storyIds = [], extraPaths = [] }) {
  const root = config.backlogRoot;
  await acquireLock(root);
  try {
    const synced = await runSync(config);
    const storyDirs = storyIds.map((raw) => {
      const parsed = normalizeId(raw);
      const found = parsed && findStoryDir(parsed, config);
      if (!found) throw new Error(`Story ${raw} not found in backlog`);
      return relative(root, found.storyDir);
    });
    const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') {
      return {
        committed: false,
        paths: [...new Set([...synced, ...storyDirs, ...extraPaths])].sort(),
        notRepo: true,
      };
    }
    const paths = stageablePaths(root, [...new Set([...synced, ...storyDirs, ...extraPaths])]).sort();
    if (paths.length === 0) return { committed: false, paths };
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (status.status !== 0) {
      return {
        committed: false,
        paths,
        error: (status.stderr || '').trim() || 'git status failed',
      };
    }
    if (status.stdout.trim() === '') return { committed: false, paths };
    return commitPaths(root, paths, message);
  } finally {
    releaseLock(root);
  }
}

/**
 * Report a `syncAndCommit` result for a command that commits its own backlog
 * changes (`bl done`, `bl new`, `bl merge`). Everything goes to stderr, so
 * a command's stdout contract is untouched. A failed commit exits 1 and names
 * the paths to commit by hand; the on-disk changes stay in place.
 *
 * @param {{ committed: boolean, paths: string[], error?: string,
 *   notRepo?: boolean }} res
 * @param {string} command  e.g. "bl done", for the error prefix
 * @param {{ nothing?: string }} [opts]  line to print when nothing changed
 */
export function reportBacklogCommit(res, command, { nothing = 'Nothing to commit.' } = {}) {
  if (res.notRepo) {
    info('Backlog is not a git repository; skipping commit.');
    return;
  }
  if (res.error) {
    console.error(`${command}: backlog commit failed: ${res.error}`);
    console.error('Commit these backlog paths by hand:');
    for (const p of res.paths) console.error(`  ${p}`);
    process.exit(1);
  }
  info(res.committed ? `Committed ${res.paths.length} backlog path(s).` : nothing);
}

/** Print a sync error the way `bl sync` does, then exit 1. */
export function exitOnSyncError(err) {
  if (err.code === 'DUPLICATE_STORY_IDS') {
    for (const d of err.duplicates) console.error(`  ERROR: ${d.message}`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
}

/**
 * Parse `bl sync` flags. `--story`, `--path` and `-m`/`--message` repeat.
 * Repeated `-m` values are joined in order as paragraphs (one blank line
 * between them), the way `git commit -m a -m b` does: the first is the
 * subject, the rest form the body. Empty or whitespace-only values are
 * dropped; `message` is null when none remain, while `messageGiven` stays
 * true, so `bl sync -m ""` without `--commit` is still a usage error.
 */
export function parseSyncArgs(argv) {
  const args = {
    commit: false,
    message: null,
    messageGiven: false,
    storyIds: [],
    paths: [],
    help: false,
  };
  const messages = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq !== -1 ? a.slice(eq + 1) : null;
    const value = () => {
      if (inline != null) return inline;
      const next = argv[i + 1];
      // An option token where a value should be means the value was dropped
      // (`-m --story S-1`): fail instead of taking `--story` as the message.
      // A lone `-` is an ordinary value; `--flag=-x` returned above.
      if (next === undefined || (next.startsWith('-') && next !== '-')) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (name === '--help' || name === '-h') args.help = true;
    else if (name === '--commit') args.commit = true;
    else if (name === '-m' || name === '--message') messages.push(value());
    else if (name === '--story') args.storyIds.push(value());
    else if (name === '--path') args.paths.push(value());
    else throw new Error(`Unknown argument: ${a}`);
  }
  const kept = messages.filter((m) => m.trim() !== '');
  args.message = kept.length > 0 ? kept.join('\n\n') : null;
  args.messageGiven = messages.length > 0;
  return args;
}

const USAGE = `Usage: bl sync [--commit -m <message> (--story <id> | --path <backlog-relative>) …]

Regenerates the backlog's index files:
  - top-level (backlog/index.md): themes, components, features, backlog
    order
  - per-component (backlog/components/C<nn>-*/index.md): its stories and features
  - per-feature (backlog/features/F<nn>-*/index.md): its stories and points
  - per-epic (backlog/epics/E<nn>-*/index.md): its features and status, derived
    from the features naming it, and their progress
  - per-theme (backlog/themes/<slug>/index.md): its epics, then its features
    with no epic

Moves nothing: a story's status is frontmatter, never location.

Serialises on the backlog lockfile (.bl-new.lock), so concurrent syncs and
bl new runs wait their turn instead of tearing each other's writes.

Options:
  --commit          After regenerating, commit to the backlog repo, inside the
                    same lock hold. Stages only the paths this sync wrote or
                    moved plus each --story directory — never the whole
                    backlog. Exits 0 without a commit when nothing changed.
  -m, --message     Commit message (required with --commit). Repeatable, as
                    with git commit: the first is the subject and each later
                    one becomes a body paragraph (blank line between). Empty
                    values are dropped. Put the why/how of the change here,
                    not in story frontmatter. A value that begins with - (other
                    than a lone -) is read as a missing value; give it inline
                    as --message=<v> (likewise --story=<v> and --path=<v>).
  --story <id>      A story you created or edited; its whole directory is
                    staged. Repeat for each story (with --commit, at least one
                    --story or --path).
  --path <path>     A backlog-relative path you wrote or moved yourself (both
                    ends of a git mv, say) that the sync did not touch; it is
                    staged with the commit. Must name one exact file or
                    directory (no root, whole stories/, components/,
                    features/, themes/ or epics/, glob or ..) that is on disk or
                    tracked by git. Repeatable;
                    only with --commit.`;

export async function main(argv) {
  let args;
  try {
    args = parseSyncArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.commit && (args.messageGiven || args.storyIds.length > 0 || args.paths.length > 0)) {
    console.error('-m, --story and --path only apply with --commit.');
    process.exit(2);
  }
  // A feature file has no story to name, so one --path scopes a commit too.
  if (args.commit && (!args.message || (args.storyIds.length === 0 && args.paths.length === 0))) {
    console.error('--commit needs -m <message> and at least one --story <id> or --path <path>.');
    process.exit(2);
  }

  const config = loadConfig();
  // A `--path` is operator input: it must name one exact file or directory
  // (see `extraPathProblem`), and one that is neither on disk nor known to
  // git is a typo that `syncAndCommit` would drop without a word.
  for (const p of args.paths) {
    const problem = extraPathProblem(p);
    if (problem) {
      console.error(`--path "${p}" ${problem}; name one exact backlog-relative file or directory.`);
      process.exit(2);
    }
  }
  const unknown = args.paths.filter((p) => stageablePaths(config.backlogRoot, [p]).length === 0);
  if (unknown.length > 0) {
    console.error(`--path matches nothing in the backlog (not on disk, not tracked by git): ${unknown.join(', ')}`);
    process.exit(2);
  }
  try {
    if (args.commit) {
      const res = await syncAndCommit(config, {
        message: args.message,
        storyIds: args.storyIds,
        extraPaths: args.paths,
      });
      if (res.notRepo) {
        console.error(`bl sync --commit: ${config.backlogRoot} is not a git repository.`);
        process.exit(1);
      }
      if (res.error) {
        console.error(`bl sync --commit: ${res.error}`);
        process.exit(1);
      }
      info(res.committed ? `Committed ${res.paths.length} backlog path(s).` : 'Nothing to commit.');
      return;
    }
    await runSync(config);
  } catch (err) {
    exitOnSyncError(err);
  }
}
