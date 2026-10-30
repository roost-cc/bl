/**
 * filter.js — the one story filter `bl list`, `bl tree` and `bl what-next`
 * share (F-51 D2): `--theme <slug>`, `--epic <E-id>`, `--feature <F-id>` and
 * `--component <C-id>`. Every given filter must match (they combine with AND).
 *
 * Membership follows F-51 D1: a story reaches its theme and epic through its
 * feature; a story with no feature belongs to every theme whose `repos` lists
 * its component's repo, and to no epic.
 */

import { normalizeComponentId, componentIdHint } from './config.js';
import { readComponents } from './story.js';
import { readAllFeatures, normalizeFeatureId } from './feature.js';
import { readAllThemes, readAllEpics, normalizeEpicId, themesOfStory, THEME_ID_RE } from './theme.js';

/** The filter flags, in the order help and errors name them. */
export const FILTER_FLAGS = ['theme', 'epic', 'feature', 'component'];

/**
 * Read the filter flags from parsed args. Throws, with a message for the
 * user, when a flag has no value or a malformed id.
 * @param {object} args  `parseArgs` output
 * @returns {{ theme: string | null, epic: string | null,
 *   feature: string | null, component: string | null }}
 */
export function parseFilter(args) {
  const raw = (name) => {
    const v = args[name];
    if (v == null || v === false) return null;
    if (v === true || String(v).trim() === '') throw new Error(`--${name} requires a value`);
    return String(v).trim();
  };
  const filter = { theme: null, epic: null, feature: null, component: null };
  const theme = raw('theme');
  if (theme != null) {
    if (!THEME_ID_RE.test(theme)) throw new Error(`invalid theme: '${theme}' (expected a slug like backlog)`);
    filter.theme = theme;
  }
  const epic = raw('epic');
  if (epic != null) {
    const parsed = normalizeEpicId(epic);
    if (!parsed) throw new Error(`invalid epic id: '${epic}' (expected E<n>, E50 upward)`);
    filter.epic = parsed.id;
  }
  const feature = raw('feature');
  if (feature != null) {
    const parsed = normalizeFeatureId(feature);
    if (!parsed) throw new Error(`invalid feature id: '${feature}' (expected F-<n>)`);
    filter.feature = parsed.id;
  }
  const component = raw('component');
  if (component != null) {
    const parsed = normalizeComponentId(component);
    if (!parsed) {
      throw new Error(componentIdHint(component) ?? `invalid component id: '${component}' (expected C<nn>)`);
    }
    filter.component = parsed.id;
  }
  return filter;
}

/** True when any filter flag is set. */
export function hasFilter(filter) {
  return FILTER_FLAGS.some((k) => filter[k] != null);
}

/**
 * The filter in words for messages: `C32` for a component alone, else e.g.
 * `theme backlog, E62`.
 */
export function filterLabel(filter) {
  return [filter.theme && `theme ${filter.theme}`, filter.epic, filter.feature, filter.component]
    .filter(Boolean)
    .join(', ');
}

/**
 * What membership is read from: features by id, themes, epics and component
 * repos. Read once per command.
 */
export function filterContext(config) {
  const features = readAllFeatures(config);
  const featuresById = new Map(features.map((f) => [f.id, f]));
  const componentRepo = new Map();
  for (const c of readComponents(config)) {
    if (!componentRepo.has(c.id)) componentRepo.set(c.id, c.repo);
  }
  return {
    features,
    featuresById,
    themes: readAllThemes(config),
    epics: readAllEpics(config),
    componentRepo,
  };
}

/**
 * The filter's theme, epic, feature and component that do not exist, as
 * messages; empty when every one does.
 * @returns {string[]}
 */
export function unknownFilterTargets(filter, ctx) {
  const out = [];
  if (filter.theme && !ctx.themes.some((t) => t.id === filter.theme)) {
    const known = ctx.themes.map((t) => t.id).join(', ') || '(none)';
    out.push(`theme ${filter.theme} not found under themes/ (known: ${known})`);
  }
  if (filter.epic && !ctx.epics.some((e) => e.id === filter.epic)) {
    out.push(`epic ${filter.epic} not found under epics/`);
  }
  if (filter.feature && !ctx.featuresById.has(filter.feature)) {
    out.push(`feature ${filter.feature} not found under features/`);
  }
  if (filter.component && !ctx.componentRepo.has(filter.component)) {
    out.push(`component ${filter.component} not found under components/`);
  }
  return out;
}

/** A feature's epic as a normalised id (`E50`), or null. */
export function featureEpicId(feature) {
  return normalizeEpicId(feature?.epic)?.id ?? null;
}

/** A story's feature as a normalised id (`F-51`), or null. */
function storyFeatureId(story) {
  return story.feature ? (normalizeFeatureId(story.feature)?.id ?? null) : null;
}

/**
 * The themes a story belongs to (F-51 D1).
 * @param {{ feature?: string, componentId?: string }} story
 * @returns {string[]}
 */
export function storyThemes(story, ctx) {
  return themesOfStory(
    { feature: storyFeatureId(story), componentRepo: ctx.componentRepo.get(story.componentId) ?? '' },
    ctx.featuresById,
    ctx.themes,
  );
}

/** True when `story` passes every filter that is set. */
export function storyMatches(story, filter, ctx) {
  const featureId = storyFeatureId(story);
  if (filter.component && story.componentId !== filter.component) return false;
  if (filter.feature && featureId !== filter.feature) return false;
  if (filter.epic && featureEpicId(ctx.featuresById.get(featureId)) !== filter.epic) return false;
  if (filter.theme && !storyThemes(story, ctx).includes(filter.theme)) return false;
  return true;
}

/** The stories that pass the filter, in their given order. */
export function filterStories(stories, filter, ctx) {
  if (!hasFilter(filter)) return stories;
  return stories.filter((s) => storyMatches(s, filter, ctx));
}

/**
 * True when feature `f` passes every filter that is set: its own theme,
 * epic and id, and, for `--component`, a story in the component.
 * @param {object} f  `readFeature` record
 * @param {object[]} featureStories  the feature's stories (`componentId`)
 */
export function featureMatches(f, featureStories, filter) {
  if (filter.theme && f.theme !== filter.theme) return false;
  if (filter.epic && featureEpicId(f) !== filter.epic) return false;
  if (filter.feature && f.id !== filter.feature) return false;
  if (filter.component && !featureStories.some((s) => s.componentId === filter.component)) return false;
  return true;
}

/**
 * Parse the filter and check its targets exist, or print the problem and
 * exit 1. Returns the filter and the context it was checked against.
 * @param {object} args  `parseArgs` output
 * @param {object} config
 * @param {string} command  e.g. "bl list", for the error prefix
 */
export function filterFromArgs(args, config, command) {
  let filter;
  try {
    filter = parseFilter(args);
  } catch (err) {
    console.error(`${command}: ${err.message}`);
    process.exit(1);
  }
  const ctx = filterContext(config);
  const unknown = unknownFilterTargets(filter, ctx);
  if (unknown.length > 0) {
    for (const m of unknown) console.error(`${command}: ${m}`);
    process.exit(1);
  }
  return { filter, ctx };
}
