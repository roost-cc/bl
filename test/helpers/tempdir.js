/**
 * tempdir.js — scaffold a tempdir backlog for tests.
 *
 * `bl init` is interactive and unsuited for tests, so we write the minimum
 * layout (a top-level backlog.json with its `repos` block and the default
 * theme) directly. Optionally seeds repos, components, stories and features
 * from a fixture object, in the F-49 D3 layout: `stories/`, `components/` and
 * `features/` at the backlog root.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { serializeFrontmatter } from '../../src/config.js';

/** The flow.json `bl init` writes, and every fixture backlog gets. */
export const FLOW_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'flow.json');

const trackedDirs = new Set();

// Signals that end the process without an `exit` event: the test runner
// cancels a file with SIGTERM, Ctrl-C sends SIGINT, a closed terminal SIGHUP.
const TERMINATING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * Create a temp dir and remove it when the test process exits. Each test
 * file runs in its own process under `node --test`, so the dirs a file makes
 * are gone once its tests finish; a test that already removed its dir, or
 * never populated it, is fine because removal is forced.
 *
 * Removal runs on a normal end, `process.exit()`, an uncaught exception or
 * rejection, and SIGTERM, SIGINT or SIGHUP. SIGKILL cannot be caught, so a
 * killed process leaves its dirs behind.
 *
 * @param {string} prefix  mkdtemp prefix, for example "bl-wt-"
 * @param {string} [parent] directory to create it in (default os.tmpdir())
 * @returns {string} the new directory
 */
export function mkTempDir(prefix, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, prefix));
  if (trackedDirs.size === 0) {
    process.once('exit', removeTrackedDirs);
    for (const signal of TERMINATING_SIGNALS) process.on(signal, onSignal);
  }
  trackedDirs.add(dir);
  return dir;
}

// Listening for a signal replaces its default of ending the process, so
// once the dirs are gone, re-raise it unless another listener handles it.
function onSignal(signal) {
  removeTrackedDirs();
  for (const s of TERMINATING_SIGNALS) process.removeListener(s, onSignal);
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

// A dir that cannot be removed (a test left it read-only) is skipped, not
// thrown: a throw here would fail a file whose tests passed and leave every
// later dir behind.
function removeTrackedDirs() {
  for (const dir of trackedDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // left behind; nothing useful to do while the process exits
    }
  }
  trackedDirs.clear();
}

// `paths` defaults to ["**"], what the F-52 migration gives every component;
// `null` writes no `paths:` line.
export const COMPONENT_INDEX_TEMPLATE = (id, title, { repo, home, paths = ['**'] } = {}) => `${serializeFrontmatter({
  component_id: id,
  title,
  repo: repo || undefined,
  home: home ? 'true' : undefined,
  paths: paths ?? undefined,
})}
# ${id} · ${title}

## Stories

| ID | Type | Title | Points | Status |
| -- | ---- | ----- | ------ | ------ |
`;

/**
 * A fixture's component id: `C00` as given, or the `C` of a pre-F-49 epic id
 * (`E00`, `E00 · Title`), which keeps its number (F-49 D2).
 */
export function componentIdOf(raw) {
  const m = String(raw ?? '').match(/^[CcEe]-?(\d+)/);
  return m ? `C${m[1].padStart(2, '0')}` : String(raw ?? '');
}

/** The theme every fixture has, and every fixture feature names by default. */
export const DEFAULT_THEME = 'demo';

export const THEME_INDEX_TEMPLATE = (t) => `${serializeFrontmatter({
  theme_id: t.id,
  title: t.title ?? t.id,
  repos: t.repos === null ? undefined : (t.repos ?? []),
  brief: t.brief ?? undefined,
})}
# ${t.title ?? t.id}

## Overview
`;

export const EPIC_INDEX_TEMPLATE = (e) => `${serializeFrontmatter({
  epic_id: e.id,
  title: e.title ?? e.id,
  theme: e.theme === null ? undefined : (e.theme ?? DEFAULT_THEME),
  status: e.status ?? 'open',
  features: [],
})}
# ${e.id} · ${e.title ?? e.id}

## Outcome
`;

export const FEATURE_INDEX_TEMPLATE = (f) => `${serializeFrontmatter({
  feature_id: f.id,
  title: f.title,
  theme: f.theme === null ? undefined : (f.theme ?? DEFAULT_THEME),
  epic: f.epic || undefined,
  status: f.status ?? 'draft',
  primary_repo: f.primary_repo || undefined,
  stories: f.stories?.length ? f.stories : '',
  points: '0',
  review_rounds_max: f.review_rounds_max ?? 2,
})}
# ${f.id} · ${f.title}

## Premise

${f.premise ?? ''}

## Acceptance

- [ ] something observable

## Stories

| ID | Component | Type | Title | Points | Status |
| -- | --------- | ---- | ----- | ------ | ------ |

## Deferred

${f.deferred ?? 'None.'}

## Escalation

${f.escalation ?? 'None.'}
`;

/**
 * The backlog's `feature-order.md` (F-53 D1): `ranked` is its `ranked:`
 * list, each `{ feature, why }`; the body is an intro and a `## History`.
 */
export const FEATURE_ORDER_TEMPLATE = (ranked = []) => `${serializeFrontmatter({ ranked })}
# Feature order

The order the operator prefers features to run in.

## History

- 2026-01-01: F-0 done (Before the fixture).
`;

/**
 * The backlog's `roadmap.md` (F-53 D2): `entries` is its `entries:` list,
 * each `{ title, added, status }`, and each gets its `## <title>` section
 * after a preamble.
 */
export const ROADMAP_TEMPLATE = (entries = []) => `${serializeFrontmatter({ entries })}
# Roadmap

Where the project is heading.
${entries.map((e) => `\n## ${e.title}\n\n_Added ${e.added}._ Prose for ${e.title}.\n`).join('')}`;

/**
 * A unit's change document (change.md): `c.repo` gets one `repos:` entry on
 * `c.branch` with `c.pr`; `c.reviewLog` fills `## Review Log`.
 */
export const CHANGE_TEMPLATE = (id, c) => `${serializeFrontmatter({
  change_of: id,
  status: c.change_status ?? 'open',
  review_round: c.review_round ?? 0,
  review_status: c.review_status ?? '',
  repos: c.repo ? [{ repo: c.repo, branch: c.branch ?? '', pr: c.pr ?? '', url: '', merged: '' }] : [],
})}
# ${id}

## Description

## Gate

## Review Log

${c.reviewLog ?? 'No reviews yet.'}

## Merge
`;

/** Whether a fixture unit carries run state, so it gets a change.md. */
const hasRunState = (u) => ['branch', 'pr', 'review_status', 'review_round', 'reviewLog'].some((k) => u[k] != null);

// `depends_on` / `required_for` are YAML sequences (F-62 D2). A fixture may
// give an array or, for short, a string of ids (`"S-2"`, `"S-2, S-3"`); the
// string is split into the sequence. An empty string stays an empty key.
function refList(value) {
  if (value == null || Array.isArray(value)) return value ?? undefined;
  const ids = String(value)
    .split(/[\s,]+/)
    .filter(Boolean);
  return ids.length ? ids : '';
}

export const STORY_INDEX_TEMPLATE = (story) => `${serializeFrontmatter({
  component: componentIdOf(story.component ?? story.epic),
  story_id: story.id,
  title: story.title,
  type: story.type ?? 'feature',
  points: story.points ?? 1,
  status: story.status ?? 'backlog',
  depends_on: refList(story.depends_on),
  required_for: refList(story.required_for),
  completed: story.completed || undefined,
  feature: story.feature || undefined,
  primary_repo: story.primary_repo || undefined,
  secondary_repos: story.secondary_repos ?? undefined,
})}
# ${story.title}

${story.body ?? ''}
`;

/**
 * @typedef Fixture
 * @property {string[] | Record<string, string | object>} [repos]
 *           backlog.json `repos`: a list of paths (each named by its
 *           basename), or entries keyed by name, each a path or an entry.
 *           `deployable` defaults to false and `update_tests` to `[]`.
 * @property {Array<{ id: string, title: string, dirSuffix?: string,
 *           repo?: string, home?: boolean, paths?: string[] | null }>} [components]
 *           Written under components/C<nn>-<dirSuffix>/; `paths` defaults
 *           to ["**"] and `null` omits it. `epics` is read the
 *           same way, an `E<nn>` id becoming `C<nn>`.
 * @property {Array<{ id: string, component?: string,
 *           epic?: string, title: string, type?: string, points?: number,
 *           status?: string, depends_on?: string, required_for?: string,
 *           completed?: string, dirSuffix?: string, body?: string,
 *           feature?: string, primary_repo?: string,
 *           secondary_repos?: string[] }>} [stories]
 *           Written under stories/S<n>-<dirSuffix>/ whatever the status.
 *           `component` (or a pre-F-49 `epic`, `E<nn>` → `C<nn>`) is the
 *           story's `component:`.
 * @property {Array<{ id: string, title: string, dirSuffix?: string,
 *           status?: string, changeRepo?: string, stories?: string[],
 *           review_status?: string, branch?: string, premise?: string,
 *           deferred?: string, reviewLog?: string, escalation?: string }>} [features]
 *           Written under features/F<n>-<dirSuffix>/ whatever the status.
 *           `branch`, `pr`, `review_status`, `review_round` and `reviewLog`
 *           (on a story too) go to the unit's change.md (CHANGE_TEMPLATE).
 *           `theme` defaults to `demo` (null writes none); `epic` is optional.
 * @property {Array<{ id: string, title?: string, repos?: string[] | null,
 *           brief?: string[] | null }>} [themes]
 *           Written under themes/<id>/, beside the default `demo` theme
 *           (`repos: []`), which a fixture theme with that id replaces.
 *           `brief` defaults to the fixture's own backlog.json, relative to
 *           the backlog's parent directory (the backlog's parent); null writes none.
 * @property {Array<{ id: string, title?: string, dirSuffix?: string,
 *           theme?: string | null, status?: string }>} [valueEpics]
 *           Written under epics/E<nn>-<dirSuffix>/; `theme` defaults to `demo`.
 * @property {Array<{ feature: string, why: string }> | string | null} [featureOrder]
 *           `feature-order.md`: a `ranked:` list (FEATURE_ORDER_TEMPLATE,
 *           `[]` by default), the file's whole text, or null for no file.
 * @property {Array<{ title: string, added: string, status: string }> | string | null} [roadmap]
 *           `roadmap.md`: an `entries:` list (ROADMAP_TEMPLATE, `[]` by
 *           default), the file's whole text, or null for no file.
 * @property {object} [config] Extra top-level keys for backlog.json (for
 *           example `{ run: { limit_wait_max_hours: 1 } }`). `worktrees`, the
 *           worktree root bl requires (F-60 D1), is `"../worktrees"`, and
 *           `agent` and `review_agent` (required, F-64 D2) are AGENT_CONFIG's,
 *           unless this sets them.
 * @property {object | null} [flow] The backlog's flow.json as an object;
 *           default `templates/flow.json`, `null` for none.
 */

/**
 * The two required configuration lists (F-64 D2) a fixture backlog.json
 * carries unless it sets its own: Claude implements and Codex reviews, with
 * no model, as `bl init` scaffolds them (the reviewer is never the
 * implementer, F-64 D4). Spread it into a backlog.json a test writes by hand.
 */
export const AGENT_CONFIG = Object.freeze({
  agent: [{ agent: 'claude' }],
  review_agent: [{ agent: 'codex' }],
});

/**
 * A fixture's `repos` as backlog.json writes them: every entry with its
 * required `path`, `deployable` and `update_tests` (F-51 D4).
 */
export function reposConfig(repos = {}) {
  const entries = Array.isArray(repos)
    ? repos.map((p) => [p.split('/').filter(Boolean).pop(), p])
    : Object.entries(repos);
  const out = {};
  for (const [name, def] of entries) {
    const entry = typeof def === 'string' ? { path: def } : def;
    out[name] = { path: `../${name}`, deployable: false, update_tests: [], ...entry };
  }
  return out;
}

/**
 * Create a tempdir backlog. Returns `{ dir, cleanup }`.
 *
 * The default layout registers no repos. Pass a fixture to add
 * repos/components/stories.
 *
 * The dir is removed when the process exits (see `mkTempDir`). Pass
 * `{ keep: true }` when it must outlive this process, as for the bash suites
 * that build a backlog in a one-shot `node -e` and remove it themselves.
 *
 * @param {Fixture} [fixture]
 * @param {{ keep?: boolean }} [opts]
 */
export function mkTempBacklog(fixture = {}, { keep = false } = {}) {
  const dir = keep ? mkdtempSync(join(tmpdir(), 'bl-test-')) : mkTempDir('bl-test-');
  writeFileSync(
    join(dir, 'backlog.json'),
    JSON.stringify(
      {
        backlog: 'backlog',
        worktrees: '../worktrees',
        ...AGENT_CONFIG,
        repos: reposConfig(fixture.repos),
        ...(fixture.config ?? {}),
      },
      null,
      2,
    ) + '\n',
  );
  // flow.json (F-66 D1): bl init's template unless the fixture gives its own,
  // or none with `flow: null`.
  if (fixture.flow !== null) {
    writeFileSync(
      join(dir, 'flow.json'),
      fixture.flow ? JSON.stringify(fixture.flow, null, 2) + '\n' : readFileSync(FLOW_TEMPLATE, 'utf8'),
    );
  }

  for (const c of [...(fixture.components ?? []), ...(fixture.epics ?? [])]) {
    const id = componentIdOf(c.id);
    const dirName = c.dirSuffix != null ? `${id}-${c.dirSuffix}` : id;
    const componentDir = join(dir, 'components', dirName);
    mkdirSync(componentDir, { recursive: true });
    writeFileSync(
      join(componentDir, 'index.md'),
      COMPONENT_INDEX_TEMPLATE(id, c.title, { repo: c.repo, home: c.home, paths: c.paths }),
    );
  }

  for (const story of fixture.stories ?? []) {
    // bl uses `S<num>-<slug>` as the story dir name (no hyphen between S and num).
    const baseDir = story.id.replace(/^S-/, 'S');
    const storyDirName = story.dirSuffix != null ? `${baseDir}-${story.dirSuffix}` : baseDir;
    const storyDir = join(dir, 'stories', storyDirName);
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(join(storyDir, 'index.md'), STORY_INDEX_TEMPLATE(story));
    if (hasRunState(story)) {
      writeFileSync(join(storyDir, 'change.md'), CHANGE_TEMPLATE(story.id, { repo: story.primary_repo, ...story }));
    }
  }

  const themes = new Map([[DEFAULT_THEME, { id: DEFAULT_THEME, title: 'Demo' }]]);
  for (const t of fixture.themes ?? []) themes.set(t.id, t);
  for (const t of themes.values()) {
    mkdirSync(join(dir, 'themes', t.id), { recursive: true });
    const brief = t.brief === undefined ? [`${basename(dir)}/backlog.json`] : t.brief;
    writeFileSync(join(dir, 'themes', t.id, 'index.md'), THEME_INDEX_TEMPLATE({ ...t, brief }));
  }
  for (const e of fixture.valueEpics ?? []) {
    const dirName = e.dirSuffix != null ? `${e.id}-${e.dirSuffix}` : e.id;
    mkdirSync(join(dir, 'epics', dirName), { recursive: true });
    writeFileSync(join(dir, 'epics', dirName, 'index.md'), EPIC_INDEX_TEMPLATE(e));
  }

  for (const f of fixture.features ?? []) {
    const base = f.id.replace(/^F-/, 'F');
    const dirName = f.dirSuffix != null ? `${base}-${f.dirSuffix}` : base;
    const featureDir = join(dir, 'features', dirName);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'index.md'), FEATURE_INDEX_TEMPLATE(f));
    if (hasRunState(f)) {
      // A feature names no repo (F-52 D3): its change document's entry is
      // `changeRepo`, else the fixture's first registered repo.
      const repo = f.changeRepo ?? f.primary_repo ?? Object.keys(reposConfig(fixture.repos))[0];
      writeFileSync(join(featureDir, 'change.md'), CHANGE_TEMPLATE(f.id, { repo, ...f }));
    }
  }

  if (fixture.featureOrder !== null) {
    writeFileSync(
      join(dir, 'feature-order.md'),
      typeof fixture.featureOrder === 'string' ? fixture.featureOrder : FEATURE_ORDER_TEMPLATE(fixture.featureOrder),
    );
  }
  if (fixture.roadmap !== null) {
    writeFileSync(
      join(dir, 'roadmap.md'),
      typeof fixture.roadmap === 'string' ? fixture.roadmap : ROADMAP_TEMPLATE(fixture.roadmap),
    );
  }

  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}
