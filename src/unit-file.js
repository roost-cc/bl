/**
 * unit-file.js — find the file of a feature, story, component or task by id,
 * for the file-oriented verbs (`bl which`, `bl view`, `bl edit`).
 */

import { dirname } from 'path';
import { componentIdHint } from './config.js';
import { normalizeId, normalizeComponentId, findStoryDir, findComponentDir } from './story.js';
import { normalizeFeatureId, findFeature } from './feature.js';
import { normalizeTaskId, findTask } from './task.js';

/**
 * @typedef {{ kind: "feature" | "story" | "component" | "task", id: string,
 *   indexPath: string, dir: string }} UnitFile
 * `indexPath` is the unit's file (a task's `tasks/T<n>-<slug>.md`); `dir` is
 * its directory (`tasks/` for a task).
 */

/**
 * The file of the unit `rawId` names, or `{ error }` with the message to
 * print: `<Kind> <id> not found.` when the id parsed, else the component-id
 * hint or `Invalid id: <rawId>`. Prints nothing.
 * @returns {UnitFile | { error: string }}
 */
export function findUnitFile(rawId, cfg) {
  const featureParsed = normalizeFeatureId(rawId);
  if (featureParsed) {
    const feature = findFeature(featureParsed, cfg);
    if (!feature) return { error: `Feature ${featureParsed.id} not found.` };
    return {
      kind: 'feature',
      id: feature.id,
      indexPath: feature.indexPath,
      dir: feature.featureDir,
    };
  }

  const storyParsed = normalizeId(rawId);
  if (storyParsed) {
    const found = findStoryDir(storyParsed, cfg);
    if (!found) return { error: `Story ${storyParsed.id} not found.` };
    return {
      kind: 'story',
      id: storyParsed.id,
      indexPath: found.indexPath,
      dir: dirname(found.indexPath),
    };
  }

  const componentParsed = normalizeComponentId(rawId);
  if (componentParsed) {
    const hit = findComponentDir(componentParsed, cfg);
    if (!hit) return { error: `Component ${componentParsed.id} not found.` };
    return {
      kind: 'component',
      id: componentParsed.id,
      indexPath: hit.indexPath,
      dir: hit.componentDir,
    };
  }

  const taskParsed = normalizeTaskId(rawId);
  if (taskParsed) {
    const task = findTask(cfg, taskParsed.id);
    if (!task) return { error: `Task ${taskParsed.id} not found.` };
    return {
      kind: 'task',
      id: task.id,
      indexPath: task.path,
      dir: dirname(task.path),
    };
  }

  return { error: componentIdHint(rawId) ?? `Invalid id: ${rawId}` };
}
