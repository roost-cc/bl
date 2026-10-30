/**
 * spec.js — `bl new --from <spec.json>` schema validator.
 *
 * The spec names the stories' component (an existing one, or one to create)
 * and N stories, each of which may name another component. Sibling
 * cross-references in `depends_on` / `required_for` use `@<placeholder>`
 * syntax that resolves to the assigned story IDs at creation time. Bare
 * `S-<n>` IDs pass through unchanged (warn-not-block on missing, like
 * `bl new --depends-on`).
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { hasFrontmatter } from './body.js';
import { normalizeFeatureId, findFeature } from './feature.js';
import { normalizeComponentId, componentIdHint } from './config.js';
import { findComponentDir, pathEntryProblem } from './story.js';

function checkBodyFile(specDir, bodyFile, push, path) {
  const p = resolveBodyPath(specDir, bodyFile);
  if (!p || !existsSync(p) || !statSync(p).isFile()) {
    push(path, `file not found: ${bodyFile}`);
    return;
  }
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch (err) {
    push(path, `failed to read ${bodyFile}: ${err.message}`);
    return;
  }
  if (hasFrontmatter(text)) {
    push(path, `body file '${bodyFile}' contains frontmatter; remove it — bl manages frontmatter`);
  }
}

const FIBONACCI = new Set([1, 2, 3, 5, 8, 13]);
const PLACEHOLDER_RE = /^[a-z][a-z0-9-]*$/;
const REF_RE = /^(@[a-z][a-z0-9-]*|S-\d+)$/;

export class SpecError extends Error {
  constructor(errors) {
    const lines = errors.map((e) => `  ${e.path}: ${e.msg}`);
    super(`spec validation failed:\n${lines.join('\n')}`);
    this.code = 'SPEC_INVALID';
    this.errors = errors;
  }
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function resolveBodyPath(specDir, bodyFile) {
  if (typeof bodyFile !== 'string' || bodyFile === '') return null;
  return isAbsolute(bodyFile) ? bodyFile : resolve(specDir, bodyFile);
}

/**
 * An existing component named by a spec's C-id string, or null after
 * pushing the reason: not a C-id (an E-id gets the hint that components
 * are C-ids), not under `components/`, or without a `repo:`.
 */
function existingComponent(raw, config, push, path) {
  if (typeof raw !== 'string' || !normalizeComponentId(raw)) {
    push(path, componentIdHint(raw) ?? "must be a component ID like 'C32'");
    return null;
  }
  const parsed = normalizeComponentId(raw);
  const hit = findComponentDir(parsed, config);
  if (!hit) {
    push(path, `component '${parsed.id}' not found under components/`);
    return null;
  }
  if (!hit.repo) {
    push(path, `component '${parsed.id}' has no repo: in its index.md`);
    return null;
  }
  return hit;
}

/**
 * Validate a parsed spec object and return `{ spec, componentMode,
 * component, repo, storyComponents, placeholderToIndex, warnings,
 * featureId }`.
 *
 * `componentMode` is `"existing"` (`component` is a C-id string; `component`
 * is then its `findComponentDir` record) or `"new"` (`component` is an
 * object with `repo`, `title` and `body_file`; `component` is then null).
 * `repo` is the spec component's repo, whose config the batch uses
 * (`configForRepo`).
 * `storyComponents[i]` is the record of story i's own `component`, or null
 * when it takes the spec's. Every story's repo is its component's repo
 * (F-49 D4, F-52 D1). `featureId` is the normalized `F-<n>` when `spec.feature`
 * is set (every created story is tagged with it and appended to the
 * feature's `stories:`). `warnings` is an array of non-fatal diagnostic
 * strings the caller should surface.
 *
 * `config` is required and used to check components, repos and the feature
 * against the on-disk backlog.
 *
 * Throws `SpecError` on failure; the error's `errors` array contains every
 * detected issue keyed by spec path (e.g. `stories[2].depends_on[0]`).
 */
export function validateSpec(spec, specDir, config) {
  const errors = [];
  const warnings = [];
  const push = (path, msg) => errors.push({ path, msg });

  if (!isPlainObject(spec)) {
    throw new SpecError([{ path: '(root)', msg: 'spec must be a JSON object' }]);
  }

  if (spec.epic != null) {
    push(
      'epic',
      "the epic block is gone: name the stories' component with a top-level 'component' " +
        "(a C-id like 'C32', or { repo, title, paths, body_file } to create one)",
    );
  }

  // --- component ---
  const c = spec.component;
  let componentMode = null;
  let component = null;
  let repo = null;
  if (typeof c === 'string') {
    componentMode = 'existing';
    component = existingComponent(c, config, push, 'component');
    repo = component?.repo || null;
  } else if (isPlainObject(c)) {
    componentMode = 'new';
    if (c.id != null) {
      push('component.id', 'an existing component is named by its C-id string: "component": "C32"');
    }
    if (typeof c.repo !== 'string' || !c.repo) {
      push('component.repo', 'required string: a repo registered in backlog.json');
    } else if (!config.reposByName[c.repo]) {
      push(
        'component.repo',
        `unknown repo '${c.repo}' (registered: ${Object.keys(config.reposByName).join(', ') || 'none'})`,
      );
    } else {
      repo = c.repo;
    }
    if (typeof c.title !== 'string' || !c.title) {
      push('component.title', 'required when creating a new component');
    }
    // `paths` is optional (F-61 D2): left out, the component gets no paths: key.
    if (c.paths != null && !Array.isArray(c.paths)) {
      push('component.paths', 'an array of globs relative to the repo root, e.g. ["src/**"], or left out');
    } else if (c.paths != null) {
      c.paths.forEach((glob, j) => {
        if (typeof glob !== 'string') return push(`component.paths[${j}]`, 'must be a string');
        const problem = pathEntryProblem(glob);
        if (problem) push(`component.paths[${j}]`, `${problem}; an entry is a glob relative to the repo root`);
      });
    }
    if (typeof c.body_file !== 'string' || !c.body_file) {
      push('component.body_file', 'required when creating a new component');
    } else {
      checkBodyFile(specDir, c.body_file, push, 'component.body_file');
    }
  } else {
    push(
      'component',
      "required: a component ID like 'C32', or an object { repo, title, paths, body_file } that creates one",
    );
  }
  if (component && repo && !config.reposByName[repo]) {
    push('component', `component '${component.id}' is in repo '${repo}', which backlog.json does not register`);
  }

  // --- feature (optional) ---
  let featureId = null;
  if (spec.feature != null) {
    const parsed = typeof spec.feature === 'string' ? normalizeFeatureId(spec.feature) : null;
    if (!parsed) {
      push('feature', "must be a feature ID like 'F-3'");
    } else {
      const feature = findFeature(parsed, config);
      if (!feature) {
        push('feature', `feature '${parsed.id}' not found under features/`);
      } else if (feature.status === 'done' || feature.status === 'superseded') {
        push('feature', `feature '${parsed.id}' is ${feature.status}`);
      } else {
        featureId = parsed.id;
      }
    }
  }

  // --- stories ---
  if (!Array.isArray(spec.stories) || spec.stories.length === 0) {
    push('stories', 'must be a non-empty array');
    throw new SpecError(errors);
  }

  const placeholderToIndex = new Map();
  const storyComponents = [];
  for (let i = 0; i < spec.stories.length; i++) {
    const s = spec.stories[i];
    const base = `stories[${i}]`;
    storyComponents.push(null);
    if (!isPlainObject(s)) {
      push(base, 'must be an object');
      continue;
    }

    if (s.epic != null) {
      push(`${base}.epic`, "is gone: a story names another component with 'component' (a C-id like 'C33')");
    }
    // Optional per-story component override: an existing component.
    if (s.component != null) {
      storyComponents[i] = existingComponent(s.component, config, push, `${base}.component`);
    }

    if (typeof s.id !== 'string' || !s.id) {
      push(`${base}.id`, "required placeholder string (e.g. 'bootstrap')");
    } else if (s.id.startsWith('S-')) {
      push(`${base}.id`, `placeholder must not start with 'S-' (use a name like 'bootstrap', not '${s.id}')`);
    } else if (!PLACEHOLDER_RE.test(s.id)) {
      push(`${base}.id`, `placeholder must match /^[a-z][a-z0-9-]*$/ (got '${s.id}')`);
    } else if (placeholderToIndex.has(s.id)) {
      push(`${base}.id`, `duplicate placeholder '${s.id}' (also at stories[${placeholderToIndex.get(s.id)}])`);
    } else {
      placeholderToIndex.set(s.id, i);
    }

    if (typeof s.title !== 'string' || !s.title) {
      push(`${base}.title`, 'required string');
    }
    if (!FIBONACCI.has(s.points)) {
      push(`${base}.points`, `must be a Fibonacci integer (1 2 3 5 8 13); got ${JSON.stringify(s.points)}`);
    }
    if (s.type != null && (typeof s.type !== 'string' || !s.type)) {
      push(`${base}.type`, 'must be a non-empty string');
    }
    if (typeof s.body_file !== 'string' || !s.body_file) {
      push(`${base}.body_file`, 'required string (path relative to spec file)');
    } else {
      checkBodyFile(specDir, s.body_file, push, `${base}.body_file`);
    }

    for (const field of ['depends_on', 'required_for']) {
      if (s[field] == null) continue;
      if (!Array.isArray(s[field])) {
        push(`${base}.${field}`, 'must be an array of strings');
        continue;
      }
      for (let j = 0; j < s[field].length; j++) {
        const ref = s[field][j];
        if (typeof ref !== 'string' || !REF_RE.test(ref)) {
          push(`${base}.${field}[${j}]`, `must be '@<placeholder>' or 'S-<n>' (got ${JSON.stringify(ref)})`);
        }
      }
    }
  }

  // Second pass: verify @placeholder targets exist in the spec.
  for (let i = 0; i < spec.stories.length; i++) {
    const s = spec.stories[i];
    if (!isPlainObject(s)) continue;
    for (const field of ['depends_on', 'required_for']) {
      if (!Array.isArray(s[field])) continue;
      for (let j = 0; j < s[field].length; j++) {
        const ref = s[field][j];
        if (typeof ref !== 'string' || !ref.startsWith('@')) continue;
        const name = ref.slice(1);
        if (!placeholderToIndex.has(name)) {
          push(`stories[${i}].${field}[${j}]`, `unknown placeholder '${ref}' (no story with id '${name}')`);
        }
      }
    }
  }

  if (errors.length > 0) throw new SpecError(errors);
  return {
    spec,
    componentMode,
    component,
    repo,
    storyComponents,
    placeholderToIndex,
    warnings,
    featureId,
  };
}

/**
 * Resolve a single ref (`@placeholder` or bare `S-<n>`) to its assigned ID
 * given a placeholder→ID map. Bare IDs pass through unchanged.
 */
export function resolveRef(ref, placeholderToId) {
  if (ref.startsWith('@')) {
    const id = placeholderToId.get(ref.slice(1));
    if (!id) throw new Error(`unresolved placeholder '${ref}'`);
    return id;
  }
  return ref;
}
