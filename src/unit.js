/**
 * unit.js — what the feature loop runs: a feature, a story batch, or a
 * single story.
 *
 * The loop in feature-run.js reads a feature record's field names (`id`,
 * `indexPath`, `featureRelPath`, `featureEntry`, `reviewRoundsMax`, …). A
 * story gets the same names from `storyUnit`, so `bl run S-n` goes through
 * the same loop with nothing copied (F-35 Design §3), and a batch record has
 * them already (`workUnitRecord`, F-125 D1). `kind` is what differs, and it
 * is the unit's type in `flow.json` (`flowKind`); a feature and a story hold
 * follow-up code work under `## Deferred` (F-82 D9).
 */

import { readFileSync } from 'fs';
import { basename, dirname, relative } from 'path';
import { parseFrontmatter, normalizeComponentId } from './config.js';
import { DEFAULT_REVIEW_ROUNDS_MAX } from './feature.js';
import { roundOf, statusOf } from './transition.js';
import { unitChange } from './change-doc.js';
import { storyEffort } from './effort.js';

function toInt(v, fallback = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A feature record as a unit: the record itself, plus its kind. A batch unit
 * (`batchUnit`) keeps its own kind, so the feature handlers that take either
 * one can call this.
 */
export function featureUnit(feature) {
  return { kind: 'feature', ...feature };
}

/**
 * A story batch record (`findBatch`) as a unit (F-125 D1): it has the field
 * names the loop reads from a feature, and `kind: 'batch'`.
 */
export function batchUnit(batch) {
  return { ...batch, kind: 'batch' };
}

/**
 * The unit's type in `flow.json`: `story`, `batch`, or `feature`, which is
 * also what a record with no `kind` is (a `findFeature` record carries none).
 * @param {{ kind?: string } | null | undefined} unit
 * @returns {"story" | "batch" | "feature"}
 */
export function flowKind(unit) {
  return unit?.kind === 'story' || unit?.kind === 'batch' ? unit.kind : 'feature';
}

/**
 * A story as a unit, read from its file. `story` needs `indexPath`,
 * `unitRepo` and `componentEntry` (a `findStoryDir` hit or a
 * `readAllStories` record). The unit's `primaryRepo`, the field the loop
 * reads on a feature record, is the story's one repo: its component's
 * (`unitRepo`, F-52 D1), never the frontmatter's.
 */
export function storyUnit(story, config) {
  const content = readFileSync(story.indexPath, 'utf8');
  const { fm, body } = parseFrontmatter(content);
  const storyDir = dirname(story.indexPath);
  const storyEntry = basename(storyDir);
  const id = fm.story_id ?? story.id;
  const primaryRepo = story.unitRepo ?? '';
  // The branch, PR, review state and Review Log live in the change document.
  const change = unitChange(storyDir, primaryRepo);
  return {
    kind: 'story',
    id,
    title: fm.title ?? storyEntry,
    // The log's last `to` and its review rounds (F-69 D2, D5); with no log,
    // `status:` (a v1 word mapped) placed by the change document (D4).
    status: statusOf('story', fm, change.change) || 'draft',
    round: roundOf('story', fm, change.change),
    primaryRepo,
    // featureSessionVars numbers the test session after the first story.
    stories: [id],
    points: toInt(fm.points),
    branch: change.branch,
    pr: change.pr,
    prUrl: change.prUrl,
    reviewRoundsMax: toInt(fm.review_rounds_max, DEFAULT_REVIEW_ROUNDS_MAX),
    changePath: change.changePath,
    change: change.change,
    changeBody: change.changeBody,
    indexPath: story.indexPath,
    featureRelPath: relative(config.backlogRoot, story.indexPath),
    // The story branch is its directory name, lower case, as for a feature.
    featureEntry: storyEntry,
    featureDir: storyDir,
    unitRepo: story.unitRepo ?? '',
    componentId: story.componentId ?? normalizeComponentId(fm.component ?? '')?.id ?? '',
    componentEntry: story.componentEntry ?? '',
    storyEntry,
    fm,
    body,
    content,
  };
}

/** The unit's single story as the loop's `ordered` list holds it. */
export function storyAsOrdered(unit) {
  return {
    id: unit.id,
    title: unit.title,
    points: unit.points,
    // As `readAllStories` reads it (F-85 D1): the run's sessions take their level from it.
    effort: storyEffort(unit.fm),
    status: unit.status,
    unitRepo: unit.unitRepo,
    componentId: unit.componentId,
    indexPath: unit.indexPath,
    storyRelPath: unit.featureRelPath,
  };
}

/** The word for the unit's kind at the start of a line: `Story`, `Batch` or `Feature`. */
export function unitLabel(unit) {
  return { story: 'Story', batch: 'Batch', feature: 'Feature' }[flowKind(unit)];
}

/** What the premise of each kind of unit is, for `{{premise}}`. */
const PREMISE = {
  story: "the story's Summary and Acceptance Criteria",
  // A batch has no premise of its own (F-125 D1): each story carries its own.
  batch: "each story's Summary and Acceptance Criteria",
  feature: "the feature's Premise",
};

/**
 * The prompt variables that say which kind of unit a session works on: the
 * shared loop prompts read "the {{unitKind}} file" and "{{premise}}".
 */
export function unitVars(unit) {
  const kind = flowKind(unit);
  return { unitKind: kind, premise: PREMISE[kind] };
}
