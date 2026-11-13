/**
 * targets.js — resolve the ids a verb is given to stories, features, story
 * batches and components.
 *
 * `bl run|implement|review|merge|refine|status|approve|done` take any kind of
 * id and pick their handler by the target's kind (F-35 Design §1). The
 * refusals that depend only on the verb and the kind live here, so every verb
 * words them the same way.
 */

import { normalizeId, normalizeComponentId, componentIdHint } from './config.js';
import { findComponentDir, readAllStories } from './story.js';
import { normalizeFeatureId, findFeature } from './feature.js';
import { normalizeBatchId, findBatch } from './batch.js';
import { batchUnit } from './unit.js';

/** Verbs that cut or use a branch: a feature's or a batch's story goes through its unit. */
const BRANCH_VERBS = new Set(['run', 'implement', 'review', 'merge']);

/**
 * Classify a raw id by its prefix.
 * @returns {{ kind: "story" | "feature" | "batch" | "component", parsed } | null}
 */
export function classifyId(raw) {
  const story = normalizeId(raw);
  if (story) return { kind: 'story', parsed: story };
  const feature = normalizeFeatureId(raw);
  if (feature) return { kind: 'feature', parsed: feature };
  const batch = normalizeBatchId(raw);
  if (batch) return { kind: 'batch', parsed: batch };
  const component = normalizeComponentId(raw);
  if (component) return { kind: 'component', parsed: component };
  return null;
}

/**
 * Why `verb` refuses this target, or null when it takes it.
 * @param {string} verb
 * @param {{ kind: string, id: string, record: object }} target
 */
export function refusalFor(verb, { kind, id, record }) {
  if (kind === 'component') {
    if (verb === 'run' || verb === 'implement') {
      return `${id} is a component. Make the stories you want into a feature (\`bl new --feature --title … S-1 S-2\`) or a batch (\`bl batch S-1 S-2 --title …\`)`;
    }
    if (verb === 'review' || verb === 'merge' || verb === 'approve' || verb === 'change') {
      // A batch is built approved (F-125 D1), so bl approve does not take one.
      return `${id} is a component; bl ${verb} takes a story${verb === 'approve' ? ' or a feature' : ', a feature or a batch'}.`;
    }
    if (verb === 'done') {
      return `${id} is a component: a code boundary with no status, so it is never done.`;
    }
  }
  if (kind === 'story') {
    const unit = record?.feature || record?.batch;
    if (BRANCH_VERBS.has(verb) && unit) {
      return `${id} is part of ${unit}; use ${unit}`;
    }
    if (verb === 'approve') {
      return `${id} is a story; stories have no approve step: a refined story may run (bl run ${id}).`;
    }
  }
  if (kind === 'feature' && verb === 'done') {
    return `${id} is a feature; bl merge ${id} marks it done.`;
  }
  if (kind === 'batch') {
    // F-125 D1: built approved by `bl batch` from stories each refined on its own.
    if (verb === 'refine' || verb === 'approve') {
      return `${id} is a story batch; bl batch built it approved from stories refined on their own, so it has no ${verb} step. Refine a story of it with bl refine S-n.`;
    }
    if (verb === 'done') return `${id} is a story batch; bl merge ${id} marks it done.`;
  }
  return null;
}

/**
 * Resolve positional ids to targets, in the order given (duplicates dropped).
 *
 * Each target is `{ kind, id, record }`: a story's record is its
 * `readAllStories` entry, a feature's its `findFeature` record, a batch's
 * its `findBatch` record as a unit (`batchUnit`), a component's its
 * `findComponentDir` hit. An unknown or malformed id, and a
 * target `verb` refuses, is reported in `errors` and left out of `targets`.
 *
 * @param {string[]} positionals
 * @param {object} config
 * @param {string | null} verb  null skips the per-verb refusals
 * @returns {{ targets: Array<{ kind: string, id: string, record: object }>,
 *             errors: string[], notices: string[] }}
 */
export function resolveTargets(positionals, config, verb) {
  const targets = [];
  const errors = [];
  const notices = [];
  const seen = new Set();
  let stories = null;

  for (const raw of positionals) {
    const hit = classifyId(raw);
    if (!hit) {
      errors.push(
        componentIdHint(raw) ??
          `Invalid id: ${raw} (expected a story like S-34, a feature like F-3, a story batch like B-2 or a component like C01)`,
      );
      continue;
    }
    const { kind, parsed } = hit;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);

    let record = null;
    if (kind === 'story') {
      stories ??= readAllStories(config);
      record = stories.find((s) => s.id === parsed.id) ?? null;
      if (!record) {
        errors.push(`Story ${parsed.id} not found in backlog`);
        continue;
      }
    } else if (kind === 'feature') {
      record = findFeature(parsed, config);
      if (!record) {
        errors.push(`Feature ${parsed.id} not found under features/.`);
        continue;
      }
    } else if (kind === 'batch') {
      const batch = findBatch(parsed, config);
      if (!batch) {
        errors.push(`Story batch ${parsed.id} not found under batches/.`);
        continue;
      }
      // The feature handlers read it as a unit of its own kind (F-125 D1).
      record = batchUnit(batch);
    } else {
      record = findComponentDir(parsed, config);
      if (!record) {
        errors.push(`Component ${parsed.id} not found under components/.`);
        continue;
      }
    }

    const target = { kind, id: parsed.id, record };
    const refusal = verb ? refusalFor(verb, target) : null;
    if (refusal) {
      errors.push(refusal);
      continue;
    }
    targets.push(target);
  }
  return { targets, errors, notices };
}
