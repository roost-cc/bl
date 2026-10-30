/**
 * unit.js — what the feature loop runs: a feature, or a single story.
 *
 * The loop in feature-run.js reads a feature record's field names (`id`,
 * `indexPath`, `featureRelPath`, `featureEntry`, `reviewRoundsMax`, …). A
 * story gets the same names from `storyUnit`, so `bl run S-n` goes through
 * the same loop with nothing copied (F-35 Design §3). `kind` and
 * `deferredHeading` are what differ: a feature's follow-ups go under
 * `## Deferred`, a story's under `## To Do`.
 */

import { readFileSync } from 'fs';
import { basename, dirname, relative } from 'path';
import { parseFrontmatter, normalizeComponentId } from './config.js';
import { DEFAULT_REVIEW_ROUNDS_MAX } from './feature.js';
import { unitChange } from './change-doc.js';

function toInt(v, fallback = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** A feature record as a unit: the record itself, plus its kind. */
export function featureUnit(feature) {
  return { ...feature, kind: 'feature', deferredHeading: 'Deferred' };
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
    deferredHeading: 'To Do',
    id,
    title: fm.title ?? storyEntry,
    status: fm.status ?? 'backlog',
    primaryRepo,
    // featureSessionVars numbers the test session after the first story.
    stories: [id],
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
    status: unit.status,
    depends_on: unit.fm.depends_on ?? '',
    unitRepo: unit.unitRepo,
    componentId: unit.componentId,
    indexPath: unit.indexPath,
    storyRelPath: unit.featureRelPath,
  };
}

/**
 * The prompt variables that say which kind of unit a session works on: the
 * shared loop prompts read "the {{unitKind}} file", "## {{deferredHeading}}"
 * and "{{premise}}".
 */
export function unitVars(unit) {
  const story = unit.kind === 'story';
  return {
    unitKind: story ? 'story' : 'feature',
    deferredHeading: story ? 'To Do' : 'Deferred',
    premise: story ? "the story's Summary and Acceptance Criteria" : "the feature's Premise",
  };
}
