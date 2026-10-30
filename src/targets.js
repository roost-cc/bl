/**
 * targets.js — resolve the ids a verb is given to stories, features and
 * components.
 *
 * `bl run|implement|review|merge|refine|status|approve|done` take any kind of
 * id and pick their handler by the target's kind (F-35 Design §1). The
 * refusals that depend only on the verb and the kind live here, so every verb
 * words them the same way.
 */

import { normalizeId, normalizeComponentId, componentIdHint } from './config.js';
import { findComponentDir, readAllStories } from './story.js';
import { normalizeFeatureId, findFeature } from './feature.js';

/** Verbs that cut or use a branch: a feature's story goes through its feature. */
const BRANCH_VERBS = new Set(['run', 'implement', 'review', 'merge']);

/**
 * Classify a raw id by its prefix.
 * @returns {{ kind: "story" | "feature" | "component", parsed } | null}
 */
export function classifyId(raw) {
  const story = normalizeId(raw);
  if (story) return { kind: 'story', parsed: story };
  const feature = normalizeFeatureId(raw);
  if (feature) return { kind: 'feature', parsed: feature };
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
      return `${id} is a component. Make the stories you want into a feature: \`bl new --feature --title … S-1 S-2\``;
    }
    if (verb === 'review' || verb === 'merge' || verb === 'approve') {
      return `${id} is a component; bl ${verb} takes a story or a feature.`;
    }
    if (verb === 'done') {
      return `${id} is a component: a code boundary with no status, so it is never done.`;
    }
  }
  if (kind === 'story') {
    if (BRANCH_VERBS.has(verb) && record?.feature) {
      return `${id} is part of ${record.feature}; use ${record.feature}`;
    }
    if (verb === 'approve') {
      return `${id} is a story; stories have no approve step: a refined story may run (bl run ${id}).`;
    }
  }
  if (kind === 'feature' && verb === 'done') {
    return `${id} is a feature; bl merge ${id} marks it done.`;
  }
  return null;
}

/**
 * Resolve positional ids to targets, in the order given (duplicates dropped).
 *
 * Each target is `{ kind, id, record }`: a story's record is its
 * `readAllStories` entry, a feature's its `findFeature` record, a
 * component's its `findComponentDir` hit. An unknown or malformed id, and a
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
          `Invalid id: ${raw} (expected a story like S-34, a feature like F-3 or a component like C01)`,
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
