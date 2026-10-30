/**
 * config.js — backlog-repo-aware configuration loader.
 *
 * Architecture:
 *   - One shared backlog repo at `<roostDir>/backlog/` (discovered by walking
 *     up from cwd or via $BL_BACKLOG_DIR).
 *   - Top-level `backlog.json` registers the code repos in `repos`, keyed by
 *     repo name: each entry's `path`, `deployable` and `update_tests`, and the
 *     optional per-repo layers `plugins-<stage>` and `overrides` (F-51 D4).
 *     Stories, components and features live in `stories/`, `components/` and
 *     `features/` at the backlog root (F-49 D3).
 *   - A repo's `overrides` refine the top-level settings for work in that
 *     repo (`configForRepo`): plugins are shallow-merged, scalar keys are
 *     overridden. Which repo is the unit's, never the cwd's.
 *   - `worktrees` names the worktree root (F-60 D1). A unit's directory is
 *     `<root>/<branch>` and each of its repos' worktree is
 *     `<root>/<branch>/<repo>`, built only by `unitDirFor` and
 *     `worktreePathFor`.
 */

import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, resolve, basename, dirname, relative, isAbsolute, sep } from 'path';
import { spawnSync } from 'child_process';
import { Document, LineCounter, Scalar, isMap, isScalar, parseDocument, visit } from 'yaml';
import { getProvider, hasProvider, PROVIDER_NAMES } from './agents/index.js';
import { sessionStackOf } from './session-stack.js';

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

// Status / progress / explanatory output goes to stderr. stdout is reserved
// for the answer to the user's question (paths, IDs, tables, JSON). See
// `src/AGENTS.md` § Stream policy.
export const info = (...a) => process.stderr.write(a.map((x) => String(x ?? '')).join(' ') + '\n');

export const warn = (...a) => process.stderr.write('warning: ' + a.map((x) => String(x ?? '')).join(' ') + '\n');

// ---------------------------------------------------------------------------
// Terminal color / match highlighting
// ---------------------------------------------------------------------------

const HL_ON = '\x1b[1;33m'; // bold yellow
const HL_OFF = '\x1b[0m';

/** True when stdout is a TTY and the user hasn't opted out via NO_COLOR. */
export function colorEnabled() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/**
 * Build a global, case-insensitive RegExp from a user pattern, for use with
 * `highlightMatches`. Returns null for an empty pattern or invalid regex, so
 * highlighting silently becomes a no-op rather than throwing.
 */
export function buildHighlightRegex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'gi');
  } catch {
    return null;
  }
}

/**
 * Wrap each substring of `text` matching `re` in a highlight color.
 * No-op (returns `text` unchanged) when color is disabled or `re` is null.
 * `re` should be a global RegExp (e.g. from `buildHighlightRegex`).
 */
export function highlightMatches(text, re) {
  if (!re || !colorEnabled()) return text;
  return text.replace(re, (m) => (m ? HL_ON + m + HL_OFF : m));
}

// ---------------------------------------------------------------------------
// Backlog-root discovery
// ---------------------------------------------------------------------------

function isBacklogRoot(dir) {
  const cfg = join(dir, 'backlog.json');
  if (!existsSync(cfg)) return false;
  try {
    const raw = JSON.parse(readFileSync(cfg, 'utf8'));
    // `projects` is the pre-F-51 registry: still found, so loadConfig can
    // refuse it with the migration's name rather than "no backlog".
    return Boolean(raw && typeof raw === 'object' && (raw.repos || raw.projects));
  } catch {
    return false;
  }
}

/**
 * Find the backlog repo root.
 *
 * Resolution order:
 *   1. `$BL_BACKLOG_DIR` env var, if set and valid.
 *   2. Walk up from `start`; at each ancestor, check the ancestor itself and
 *      its `backlog/` child for a `backlog.json` with a `repos` key.
 *
 * @param {string} [start] — directory to start searching from (default cwd)
 * @returns {string} absolute path to backlog repo root
 */
export function findBacklogRoot(start = process.cwd()) {
  const envDir = process.env.BL_BACKLOG_DIR;
  if (envDir && isBacklogRoot(envDir)) return resolve(envDir);

  let dir = resolve(start);
  while (true) {
    if (isBacklogRoot(dir)) return dir;
    const child = join(dir, 'backlog');
    if (isBacklogRoot(child)) return child;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find backlog repo (no backlog.json with 'repos' key in any ancestor).\n" +
      'Set BL_BACKLOG_DIR to the backlog directory or run bl from inside a known code repo.',
  );
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Merge a repo's `overrides` on top of top-level config.
 *   - `plugins` is deep-merged per plugin name (one level): a repo that
 *     overrides `plugins.md.format` keeps any top-level `plugins.md.extensions`
 *     or sibling stage commands. Overriding a whole plugin still works — the
 *     repo just specifies every field it wants present.
 *   - `language_dispatch` is shallow-merged by stage; within each stage the
 *     extension→plugin map is shallow-merged so a repo can override a
 *     single extension without restating the whole map.
 *   - All other scalar / array keys: per-repo overrides.
 */
function mergeConfig(top, overrides) {
  const merged = { ...top, ...overrides };
  if (top.plugins || overrides.plugins) {
    const topPlugins = top.plugins ?? {};
    const repoPlugins = overrides.plugins ?? {};
    const out = { ...topPlugins };
    for (const [name, def] of Object.entries(repoPlugins)) {
      const existing = topPlugins[name];
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        def &&
        typeof def === 'object' &&
        !Array.isArray(def)
      ) {
        out[name] = { ...existing, ...def };
      } else {
        out[name] = def;
      }
    }
    merged.plugins = out;
  }
  if (top.language_dispatch || overrides.language_dispatch) {
    const stages = new Set([
      ...Object.keys(top.language_dispatch ?? {}),
      ...Object.keys(overrides.language_dispatch ?? {}),
    ]);
    const out = {};
    for (const stage of stages) {
      out[stage] = {
        ...(top.language_dispatch?.[stage] ?? {}),
        ...(overrides.language_dispatch?.[stage] ?? {}),
      };
    }
    merged.language_dispatch = out;
  }
  return merged;
}

/** The backlog's display name when `backlog.json` sets no `title` (S-581). */
export const DEFAULT_BACKLOG_TITLE = 'Backlog';

/**
 * `backlog.json` `title`, the name `bl sync` gives the top-level `index.md`
 * (S-581): a one-line, non-empty string, trimmed, else
 * `DEFAULT_BACKLOG_TITLE`. Any other value throws.
 * @param {object} topLevel
 */
function backlogTitle(topLevel) {
  if (!Object.hasOwn(topLevel, 'title')) return DEFAULT_BACKLOG_TITLE;
  const t = topLevel.title;
  if (typeof t !== 'string' || !t.trim() || /[\r\n]/.test(t)) {
    throw new Error('backlog.json "title" must be a one-line, non-empty string (the backlog\'s display name)');
  }
  return t.trim();
}

/** The keys every `repos` entry must set (F-51 D4); there are no defaults. */
const REQUIRED_REPO_KEYS = ['path', 'deployable', 'update_tests'];

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isNameList = (v) => Array.isArray(v) && v.every((n) => typeof n === 'string' && n.trim() !== '');

/**
 * Resolve `backlog.json`'s `repos` block (F-51 D4) into one record per repo:
 * `{ name, path, deployable, updateTests, plugins, overrides }`, with `path`
 * absolute and `plugins` the entry's `plugins-<stage>` lists keyed by stage.
 * A missing required key, a value of the wrong type or an unknown key throws,
 * naming the repo and the key.
 * @param {string} backlogRoot
 * @param {unknown} raw — the `repos` value
 * @returns {Record<string, { name: string, path: string, deployable: boolean,
 *   updateTests: string[], plugins: Record<string, string[]>, overrides: object | null }>}
 */
function resolveRepos(backlogRoot, raw) {
  if (!isPlainObject(raw)) {
    throw new Error('backlog.json "repos" must be an object keyed by repo name');
  }
  const repos = {};
  for (const [name, def] of Object.entries(raw)) {
    const where = `backlog.json repos["${name}"]`;
    if (!isPlainObject(def)) throw new Error(`${where} must be an object`);
    for (const key of REQUIRED_REPO_KEYS) {
      if (!Object.hasOwn(def, key)) {
        throw new Error(`${where} has no "${key}": every repo sets ${REQUIRED_REPO_KEYS.join(', ')}`);
      }
    }
    if (typeof def.path !== 'string' || def.path.trim() === '') {
      throw new Error(`${where} "path" must be a non-empty string`);
    }
    if (typeof def.deployable !== 'boolean') {
      throw new Error(`${where} "deployable" must be true or false`);
    }
    if (!isNameList(def.update_tests)) {
      throw new Error(`${where} "update_tests" must be a list of plugin names ([] for none)`);
    }
    const plugins = {};
    for (const [key, value] of Object.entries(def)) {
      if (REQUIRED_REPO_KEYS.includes(key)) continue;
      if (key === 'overrides') {
        if (!isPlainObject(value)) throw new Error(`${where} "overrides" must be an object`);
        continue;
      }
      const stage = key.match(/^plugins-([a-z][a-z0-9-]*)$/)?.[1];
      if (!stage) {
        throw new Error(
          `${where} has an unknown key "${key}" (allowed: ${REQUIRED_REPO_KEYS.join(', ')}, plugins-<stage>, overrides)`,
        );
      }
      if (!isNameList(value)) throw new Error(`${where} "${key}" must be a list of plugin names`);
      plugins[stage] = value.map((n) => n.trim());
    }
    repos[name] = {
      name,
      path: resolve(backlogRoot, def.path),
      deployable: def.deployable,
      updateTests: [...def.update_tests],
      plugins,
      overrides: def.overrides ?? null,
    };
  }
  return repos;
}

/**
 * A `regenerate` plugin (F-36 D5) names the files it regenerates: one that
 * defines `regenerate` must define `paths`, a non-empty list of repo-relative
 * globs, and one that defines `paths` must define `regenerate`. There are no
 * defaults; anything else throws, naming the plugin.
 * @param {unknown} plugins — a `plugins` registry, after any repo overrides
 * @param {string} where — where it was read, for the message
 */
function checkRegeneratePlugins(plugins, where) {
  if (!isPlainObject(plugins)) return;
  for (const [name, def] of Object.entries(plugins)) {
    if (!isPlainObject(def)) continue;
    const hasCmd = Object.hasOwn(def, 'regenerate');
    const hasPaths = Object.hasOwn(def, 'paths');
    if (!hasCmd && !hasPaths) continue;
    const at = `${where} plugin "${name}"`;
    if (!hasPaths) throw new Error(`${at} defines "regenerate" but no "paths": list the files it regenerates`);
    if (!hasCmd) throw new Error(`${at} defines "paths" but no "regenerate": name the command that regenerates them`);
    if (typeof def.regenerate !== 'string' || def.regenerate.trim() === '') {
      throw new Error(`${at} "regenerate" must be a non-empty command`);
    }
    if (!isNameList(def.paths) || def.paths.length === 0) {
      throw new Error(`${at} "paths" must be a non-empty list of repo-relative globs`);
    }
  }
}

/** Where every story, component and feature lives (F-49 D3). */
export const STORIES_DIR = 'stories';
export const COMPONENTS_DIR = 'components';
/** Where the value axis above features lives: themes and epics (F-51 D1). */
export const THEMES_DIR = 'themes';
export const EPICS_DIR = 'epics';

/**
 * Load the backlog's configuration: the top level of `backlog.json` and its
 * `repos` registry. No repo's `overrides` apply; `configForRepo` layers them
 * for a unit's repo. The cwd only finds the backlog.
 *
 * A `backlog.json` that still has the pre-F-51 `projects` block is refused
 * (F-51 D4), so nothing half-works on it, and so is one whose `worktrees`
 * is not a worktree root (`checkWorktreeRoot`, F-60 D1).
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]          — where discovery starts (default process.cwd())
 * @param {string} [opts.backlogRoot]  — explicit backlog root (skips discovery)
 * @param {string} [opts.agent]        — the -A override: a one-entry list
 *   with no model for the role `opts.agentRole` names (F-64 D2)
 * @param {"agent"|"review"} [opts.agentRole] — the role -A replaces:
 *   `review` on `bl review`, `agent` (the default) on every other verb
 * @param {boolean} [opts.lenientAgents] — load a backlog.json whose `agent`
 *   or `review_agent` is wrong (the retired shape included) with both lists
 *   empty and the reason in `agentConfigError`; only `bl validate`, which
 *   reports it, passes it
 * @param {boolean} [opts.legacyWorktrees] — accept a `worktrees` that still
 *   holds `{repo}`, or none (the old default); only
 *   `scripts/migrate-worktree-layout.js` passes it (F-60 D4)
 * @returns {{
 *   backlogRoot: string,
 *   roostDir: string,
 *   title: string,
 *   topLevel: object,
 *   repos: Record<string, object>,
 *   reposByName: Record<string, string>,
 *   repoName: string | null,
 *   raw: object,
 *   plugins: Record<string, Record<string, string>>
 * }}
 */
export function loadConfig(opts = {}) {
  const backlogRoot = opts.backlogRoot ? resolve(opts.backlogRoot) : findBacklogRoot(opts.cwd ?? process.cwd());
  const roostDir = dirname(backlogRoot);

  const topLevel = readJson(join(backlogRoot, 'backlog.json'));
  if (Object.hasOwn(topLevel, 'projects')) {
    throw new Error(
      'This backlog.json still has "projects": the repo registry and every per-repo setting now live in "repos" (F-51 D4). ' +
        "Move them there (F-51's migrate-value-axis.js did it; it is in bl's git history before F-62).",
    );
  }
  const repos = resolveRepos(backlogRoot, topLevel.repos ?? {});
  checkWorktreeRoot(topLevel, repos, { legacy: opts.legacyWorktrees === true });
  checkRegeneratePlugins(topLevel.plugins, 'backlog.json');
  sessionStackOf(topLevel, backlogRoot); // throws on a malformed "session_stack"
  for (const r of Object.values(repos)) {
    if (r.overrides?.plugins) {
      checkRegeneratePlugins(mergeConfig(topLevel, r.overrides).plugins, `backlog.json repos["${r.name}"] overrides`);
    }
  }
  const reposByName = Object.fromEntries(Object.values(repos).map((r) => [r.name, r.path]));
  const title = backlogTitle(topLevel);

  const agentFlag = {
    agent: opts.agent ?? null,
    role: opts.agentRole ?? 'agent',
    lenient: opts.lenientAgents === true,
  };
  const config = withRaw({ backlogRoot, roostDir, title, topLevel, repos, reposByName }, topLevel, agentFlag, null);
  // A repo's overrides that set the retired shape, or a wrong list, throw
  // here, not only when a unit of that repo loads them.
  for (const r of Object.values(repos)) {
    if (r.overrides) configForRepo(config, r.name);
  }
  return config;
}

/**
 * `config` for work in `repoName`: that repo's `overrides` merged over the
 * top level by `mergeConfig` (F-51 D4). A repo with no `overrides`, an
 * unknown repo or no repo gives the top-level config. Returns `config` itself
 * when it is already for that repo.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {string | null | undefined} repoName
 */
export function configForRepo(config, repoName) {
  const repo = repoName ? config.repos?.[repoName] : null;
  const name = repo ? repo.name : null;
  if (!config.topLevel || (config.repoName ?? null) === name) return config;
  const raw = repo?.overrides ? mergeConfig(config.topLevel, repo.overrides) : config.topLevel;
  const { backlogRoot, roostDir, title, topLevel, repos, reposByName } = config;
  return withRaw({ backlogRoot, roostDir, title, topLevel, repos, reposByName }, raw, agentFlagOf(config), name);
}

/** The -A handling `config` was loaded with, for a reload or `configForRepo`. */
export function agentFlagOf(config) {
  return { agent: config.agentFlag ?? null, role: config.agentRole ?? 'agent', lenient: config.lenientAgents === true };
}

/**
 * The `repos` record `config` is for (`configForRepo`): the plugin cascade's
 * repo layer. Null for the top-level config.
 */
export function repoOf(config) {
  return (config?.repoName && config.repos?.[config.repoName]) || null;
}

/** The config record for `raw` (the top level, or it with a repo's overrides). */
function withRaw(base, raw, { agent: agentFlag, role: agentRole, lenient: lenientAgents }, repoName) {
  // Each role is an ordered list of { agent, model } configurations (F-64
  // D2), both required. Reviews run on their own list so the configuration
  // that wrote the code isn't the one signing it off (`review_status:
  // addressed` is reviewer-only). -A replaces one role's list: the review
  // list on `bl review`, the implementing list on every other verb.
  const where = repoName ? `backlog.json repos["${repoName}"] overrides` : 'backlog.json';
  let agents = [];
  let reviewAgents = [];
  let agentConfigError = null;
  try {
    const retired = retiredAgentShape(raw, where);
    if (retired) throw new Error(retired);
    agents =
      agentFlag && agentRole !== 'review' ? [flagConfiguration(agentFlag)] : agentConfigurations(raw, 'agent', where);
    reviewAgents =
      agentFlag && agentRole === 'review'
        ? [flagConfiguration(agentFlag)]
        : agentConfigurations(raw, 'review_agent', where);
  } catch (e) {
    if (!lenientAgents) throw e;
    agents = [];
    reviewAgents = [];
    agentConfigError = e.message;
  }

  // How long `bl run` may wait for an agent usage limit to reset before it
  // escalates instead (feature-run.js `runSession`). Hours; default 8.
  const limitWaitMaxHours = raw.run?.limit_wait_max_hours ?? 8;
  if (typeof limitWaitMaxHours !== 'number' || !Number.isFinite(limitWaitMaxHours) || limitWaitMaxHours <= 0) {
    throw new Error('backlog.json run.limit_wait_max_hours must be a positive number');
  }

  return {
    ...base,
    // The repo whose `overrides` `raw` carries (null: the top level only).
    repoName,
    raw,
    // Both roles' lists, in priority order (F-64 D2).
    agents,
    reviewAgents,
    // The first entry of each role, for the callers that do not walk the
    // list (`bl implement`, `bl refine`, `bl init`, `bl allow`, `bl agent`,
    // and every step of `bl run` until the walk). A null model passes no
    // model flag, so the agent CLI uses the account's model.
    agent: agents[0]?.agent ?? null,
    agentModel: agents[0]?.model ?? null,
    reviewAgent: reviewAgents[0]?.agent ?? null,
    reviewAgentModel: reviewAgents[0]?.model ?? null,
    // The explicit -A value (or null) and the role it replaces.
    // `configForRepo` forwards these, not the resolved lists, so a repo's
    // `agent` or `review_agent` still applies.
    agentFlag,
    agentRole,
    lenientAgents,
    // Why the lists are empty, under `lenientAgents` only (`bl validate`).
    agentConfigError,
    limitWaitMaxHours,
    plugins: raw.plugins ?? {},
    languageDispatch: raw.language_dispatch ?? {},
  };
}

/** The script that rewrites the retired agent keys into configuration lists. */
export const AGENT_MIGRATION = 'scripts/migrate-agent-configurations.js';

/** One configuration list, as an error message shows it. */
const LIST_SHAPE = '[{ "agent": "<provider>", "model": "<model>" }, …]';

/**
 * The retired agent shape in `obj` (a backlog.json top level, or one with a
 * repo's overrides): a string `agent` or `review_agent`, or an `agent_model`
 * or `fallback_model` key (F-64 D2). A message naming the list shape and the
 * migration script, or null. Never migrated silently, as for `projects`
 * (F-51) and `worktrees` (F-60).
 * @param {object} obj
 * @param {string} where — where it was read, for the message
 * @returns {string|null}
 */
export function retiredAgentShape(obj, where) {
  if (!isPlainObject(obj)) return null;
  const found = [
    ...['agent', 'review_agent'].filter((k) => typeof obj[k] === 'string').map((k) => `a string "${k}"`),
    ...['agent_model', 'fallback_model'].filter((k) => Object.hasOwn(obj, k)).map((k) => `"${k}"`),
  ];
  if (found.length === 0) return null;
  return (
    `${where} has ${found.join(' and ')}, the retired agent shape: "agent" and "review_agent" are each a list of configurations, ` +
    `${LIST_SHAPE}, in priority order, and a model belongs to its configuration (F-64 D2). ` +
    `Run bl's ${AGENT_MIGRATION} <backlog.json> to rewrite them.`
  );
}

/**
 * `raw[key]` as a role's list of configurations (F-64 D2): required, a
 * non-empty list of `{ agent, model }`, each `agent` a registered provider,
 * each `model` optional (absent: null, the account's model) and named only
 * for an adapter whose supportsModel() is true, and no entry twice. Throws,
 * naming the entry, otherwise.
 * @returns {{ agent: string, model: string|null }[]}
 */
function agentConfigurations(raw, key, where) {
  if (!Object.hasOwn(raw, key)) {
    throw new Error(`${where} has no "${key}": list its configurations in priority order, ${LIST_SHAPE} (F-64 D2)`);
  }
  const list = raw[key];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${where} "${key}" must be a non-empty list of configurations, ${LIST_SHAPE}`);
  }
  const seen = new Set();
  return list.map((entry, i) => {
    const at = `${where} "${key}"[${i}]`;
    if (!isPlainObject(entry))
      throw new Error(`${at} must be a configuration, { "agent": "<provider>", "model": "<model>" }`);
    const unknown = Object.keys(entry).filter((k) => k !== 'agent' && k !== 'model');
    if (unknown.length > 0) throw new Error(`${at} has an unknown key "${unknown[0]}" (allowed: agent, model)`);
    if (!hasProvider(entry.agent)) {
      throw new Error(
        `${at} "agent" must be a registered provider (${PROVIDER_NAMES.join(', ')}), not ${JSON.stringify(entry.agent)}`,
      );
    }
    const agent = entry.agent.toLowerCase();
    const model = Object.hasOwn(entry, 'model') ? checkModel(entry.model, `${at} "model"`) : null;
    if (model != null && !getProvider(agent).supportsModel()) {
      throw new Error(`${at} names model "${model}", but ${agent} cannot select a model: drop "model"`);
    }
    const id = configurationLabel({ agent, model });
    if (seen.has(id)) throw new Error(`${at} repeats ${id}: each configuration is listed once`);
    seen.add(id);
    return { agent, model };
  });
}

/**
 * -A as its one-entry list's configuration (F-64 D2): a registered provider,
 * lowercased like a list entry, so D4's equality sees `-A Claude` as the
 * `claude` a list may hold. No model.
 */
function flagConfiguration(agent) {
  if (!hasProvider(agent)) {
    throw new Error(`-A must name a registered provider (${PROVIDER_NAMES.join(', ')}), not ${JSON.stringify(agent)}`);
  }
  return { agent: agent.toLowerCase(), model: null };
}

/** A configuration as the operator reads it: "codex gpt-6-sol", or "claude" with no model. */
export function configurationLabel({ agent, model }) {
  return model == null ? agent : `${agent} ${model}`;
}

/**
 * Whether two configurations are the same one (F-64 D4): the same agent and
 * the same model, an absent model equal only to an absent model.
 */
export function sameConfiguration(a, b) {
  return a.agent === b.agent && (a.model ?? null) === (b.model ?? null);
}

/**
 * The review entries that equal no implementing entry (F-64 D4). With none,
 * every review configuration would review its own work, and `bl run` refuses
 * at start.
 * @param {{ agent: string, model: string|null }[]} agents
 * @param {{ agent: string, model: string|null }[]} reviewAgents
 */
export function independentReviewers(agents, reviewAgents) {
  return (reviewAgents ?? []).filter((r) => !(agents ?? []).some((a) => sameConfiguration(a, r)));
}

/** `value` when it is a non-empty string (a model name); throws otherwise. */
export function checkModel(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/** The script that moves worktrees from `<root>/<repo>/<branch>` to `<root>/<branch>/<repo>`. */
const WORKTREE_MIGRATION = 'scripts/migrate-worktree-layout.js';

/**
 * `backlog.json` `worktrees` must name the worktree root (F-60 D1): a
 * non-empty string, with no default. One that still holds `{repo}` is the
 * old per-repo template and throws, naming the migration, unless `legacy`
 * (the migration's own load), which also accepts it unset: before F-60 that
 * meant `../worktrees/{repo}`. A repo's `overrides.worktrees` throws: a repo
 * outside the unit directory would split the unit.
 */
function checkWorktreeRoot(topLevel, repos, { legacy = false } = {}) {
  const value = topLevel.worktrees;
  if (!(legacy && value === undefined) && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(
      'backlog.json "worktrees" must name the worktree root, a directory relative to the backlog (e.g. "../worktrees"). ' +
        `A backlog from before F-60 that left it unset had its worktrees at ../worktrees/<repo>: run bl's ${WORKTREE_MIGRATION} to move them.`,
    );
  }
  if (value?.includes('{repo}') && !legacy) {
    throw new Error(
      `backlog.json "worktrees" is "${value}", a per-repo template: worktrees now live at <root>/<branch>/<repo> (F-60). ` +
        `Run bl's ${WORKTREE_MIGRATION} to move them and set the root.`,
    );
  }
  for (const r of Object.values(repos)) {
    if (r.overrides && Object.hasOwn(r.overrides, 'worktrees')) {
      throw new Error(
        `backlog.json repos["${r.name}"] overrides "worktrees": every repo's worktree lives in the unit directory, <root>/<branch>/${r.name}, so the root is set once, at the top level`,
      );
    }
  }
}

/**
 * The worktree root (F-60 D1): `backlog.json` `worktrees`, resolved against
 * the backlog. Every unit directory is a child of it.
 */
export function worktreeRoot(config) {
  const value = config.raw?.worktrees;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('backlog.json "worktrees" is not set: it names the worktree root');
  }
  return resolve(config.backlogRoot, value);
}

/** A unit's directory, `<root>/<branch>`: every repo's worktree of the unit is under it. */
export function unitDirFor(config, branch) {
  return join(worktreeRoot(config), branch);
}

/** `repo`'s worktree on `branch`, `<root>/<branch>/<repo>`. */
export function worktreePathFor(config, repo, branch) {
  return join(unitDirFor(config, branch), repo);
}

/**
 * The unit directory a worktree path of `worktreePathFor` lies in, for a
 * caller that holds only the worktree: its parent, `<root>/<branch>`.
 */
export function unitDirOf(worktreePath) {
  return dirname(worktreePath);
}

/**
 * Whether `path` is a bl worktree under the worktree root `root`, or a path
 * inside one: `<root>/<branch>/bl[/…]` for some branch. A repo whose name
 * only starts with `bl` (`bl-x`), the root itself, a unit directory and any
 * path outside the root are not. `root` is `worktreeRoot(config)`; both
 * sides are compared as given, so a caller that resolves links does it to
 * both.
 */
export function isBlBranchPath(root, path) {
  if (!root || !path) return false;
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const [branch, repo] = rel.split(sep);
  return Boolean(branch) && repo === 'bl';
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/** Normalise a story ID like "S34", "S-34", "s-34". */
export function normalizeId(raw) {
  const m = String(raw).match(/^[Ss]-?(\d+)$/);
  if (!m) return null;
  const num = m[1];
  return { num, id: `S-${num}`, dirPrefix: `S${num}` };
}

/** Normalise a component ID like "C01", "C1", "c-01" (F-49 D2). */
export function normalizeComponentId(raw) {
  const m = String(raw).match(/^[Cc]-?(\d+)$/);
  if (!m) return null;
  // C032 is C32: at least two digits, no other leading zeros. The digits
  // stay a string: a Number would alias ids past 2^53.
  const num = m[1].replace(/^0+/, '').padStart(2, '0');
  return { num, id: `C${num}`, dirPrefix: `C${num}` };
}

/**
 * The error for an old component's `E<n>` id (E00–E49) given where a
 * component is meant, or null for any other id. A code boundary is a
 * component, `C<n>`, and keeps its old number (E32 → C32, F-49 D2). E50
 * upward is an epic (F-51 D1), so it gets no hint.
 */
export function componentIdHint(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^[Ee]-?(\d+)$/);
  if (!m || Number(m[1]) >= 50) return null;
  return `${String(raw).trim()} is not a component id: components are C-ids (C${m[1].padStart(2, '0')}).`;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

// Frontmatter is YAML under the failsafe schema (F-62 D1), read and written
// only by `parseFrontmatter` and `serializeFrontmatter` through the `yaml`
// package: every scalar is a string, mappings and sequences are objects and
// arrays at any depth, and the library alone decides what is quoted.

const YAML_OPTIONS = { schema: 'failsafe' };

/**
 * The keys whose value is a list (F-62 D2). A list key with no value
 * (`depends_on:`, the empty string) is an empty list; any other scalar is not
 * a list, which `bl validate` reports as `frontmatter-list`.
 */
export const LIST_KEYS = Object.freeze([
  'stories',
  'depends_on',
  'required_for',
  'components',
  'features',
  'epics',
  'paths',
  'repos',
  'brief',
]);

/**
 * Whether frontmatter `key` holds a list: one of `LIST_KEYS`, or a plugin
 * list (`plugins`, `plugins-<stage>`).
 */
export function isListKey(key) {
  return LIST_KEYS.includes(key) || /^plugins(-[\w-]+)?$/.test(key);
}

/**
 * A list key's parsed value as an array (F-62 D2): the sequence itself, `[]`
 * for an absent or empty key, and null for anything else (a non-empty scalar
 * or a mapping), which is not a list.
 * @returns {unknown[] | null}
 */
export function listValue(raw) {
  if (Array.isArray(raw)) return raw;
  return raw == null || raw === '' ? [] : null;
}

/**
 * A list key the readers cannot read: a non-empty scalar or a mapping, or a
 * member of the wrong kind (`depends_on: [{S-2: ""}]`). `bl validate`
 * reports each as `frontmatter-list`; every other command stops here
 * rather than read the list without the member, which would drop a blocker
 * or a plugin as if it were never written.
 */
export class FrontmatterListError extends Error {
  constructor(key, raw, { member = 'a string' } = {}) {
    const whole = listValue(raw) == null;
    const shown = JSON.stringify(whole ? raw : listValue(raw).find((m) => !memberIs(m, member)));
    const reason = `${key ? `"${key}:"` : 'a list key'} ${whole ? `is ${shown}, not a list` : `holds ${shown}, not ${member}`}`;
    super(`${reason}; run bl validate`);
    this.name = 'FrontmatterListError';
    this.reason = reason;
    this.key = key;
  }
}

/** Whether `m` is a list member of kind `member` (`a string`, `a mapping`). */
function memberIs(m, member) {
  return member === 'a mapping' ? m != null && typeof m === 'object' && !Array.isArray(m) : typeof m === 'string';
}

/**
 * List key `key`'s parsed value as its members (F-62 D2; `key` names it in
 * the error, when the caller knows it): `[]` for an
 * absent or empty key. Throws `FrontmatterListError` on any other scalar, a
 * mapping, or a member that is not `member` (`a string`, or `a mapping` for
 * a change document's `repos:`).
 * @returns {unknown[]}
 */
export function listMembers(raw, key, { member = 'a string' } = {}) {
  const list = listValue(raw);
  if (list == null || !list.every((m) => memberIs(m, member))) throw new FrontmatterListError(key, raw, { member });
  return list;
}

/**
 * A frontmatter block that is not YAML. `line` and `column` are 1-based and
 * count from the top of the file (the opening `---` is line 1); `file` is set
 * by a caller that knows it (`withFile`).
 */
export class FrontmatterError extends Error {
  constructor(reason, { line = 0, column = 0, file = null } = {}) {
    super(FrontmatterError.text(reason, line, column, file));
    this.name = 'FrontmatterError';
    this.reason = reason;
    this.line = line;
    this.column = column;
    this.file = file;
  }

  static text(reason, line, column, file) {
    const at = line ? ` at line ${line}${column ? `, column ${column}` : ''}` : '';
    return `${file ? `${file}: ` : ''}frontmatter is not YAML${at}: ${reason}`;
  }

  /** This error, naming `file`. */
  withFile(file) {
    this.file = file;
    this.message = FrontmatterError.text(this.reason, this.line, this.column, file);
    return this;
  }
}

/**
 * Parse the YAML frontmatter of a markdown string: `{ fm, body }`, `fm` the
 * block's mapping (every scalar a string) and `body` the text after the
 * closing `---`. Text with no `---` block is all body. Throws
 * `FrontmatterError` when the block is not YAML or not a mapping.
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { fm: {}, body: content };
  const lineCounter = new LineCounter();
  const doc = parseDocument(match[1], { ...YAML_OPTIONS, lineCounter });
  const error = doc.errors[0];
  if (error) {
    const pos = error.linePos?.[0];
    const reason = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    throw new FrontmatterError(reason, { line: pos ? pos.line + 1 : 0, column: pos?.col ?? 0 });
  }
  let fm;
  try {
    // A node with no value at all (`{x}`, `? k`) is null in `toJS`; under
    // the failsafe schema it is the empty string, like `key:`.
    fm = failsafeValue(doc.toJS() ?? {});
  } catch (e) {
    // An alias with no anchor (`*x`) parses but does not resolve.
    let at = null;
    visit(doc, {
      Alias(_, node) {
        at = lineCounter.linePos(node.range[0]);
        return visit.BREAK;
      },
    });
    throw new FrontmatterError(e.message, { line: at ? at.line + 1 : 0, column: at?.col ?? 0 });
  }
  if (typeof fm !== 'object' || Array.isArray(fm)) {
    throw new FrontmatterError('the block is not a mapping of keys to values', { line: 2, column: 1 });
  }
  return { fm, body: match[2] };
}

/**
 * The file line (1-based, the opening `---` is line 1) of top-level `key` in
 * `content`'s frontmatter, or 0 when the block is absent, is not YAML or has
 * no such key.
 */
export function frontmatterKeyLine(content, key) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return 0;
  const lineCounter = new LineCounter();
  const doc = parseDocument(match[1], { ...YAML_OPTIONS, lineCounter });
  if (doc.errors.length || !isMap(doc.contents)) return 0;
  const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === key);
  return pair?.key?.range ? lineCounter.linePos(pair.key.range[0]).line + 1 : 0;
}

/**
 * Whether the backlog readers (`readAllStories`, `readComponents`,
 * `readAllFeatures`, `readAllThemes`, `readAllEpics`) skip the unit at
 * `indexPath`: `bl validate` lists in `config.invalidFrontmatter` the files
 * it reports as not YAML (F-62 D4), so none is read partially. Every other
 * command reads them and stops at the `FrontmatterError`.
 */
export function frontmatterSkipped(config, indexPath) {
  return config?.invalidFrontmatter?.has(indexPath) ?? false;
}

/**
 * `parseFrontmatter` of `content` read from `file`: a `FrontmatterError`
 * names the file.
 */
export function parseFrontmatterOf(content, file) {
  try {
    return parseFrontmatter(content);
  } catch (e) {
    throw e instanceof FrontmatterError ? e.withFile(file) : e;
  }
}

/** `value` as the failsafe schema holds it: strings, arrays and plain objects. */
function failsafeValue(value) {
  if (Array.isArray(value)) return value.map(failsafeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, failsafeValue(v)]),
    );
  }
  return value == null ? '' : String(value);
}

/**
 * A frontmatter object as a `---` block (F-62 D1): keys in object order, a
 * sequence of scalars in flow style (`[S-1, S-2]`, `[]` when empty), mappings
 * and sequences of mappings in block style, an empty value as a bare `key:`
 * but an empty sequence member as `""` (bare, `[a, ]` reads back as `[a]`).
 * Numbers and booleans are written as their strings, `null` as empty, and an
 * `undefined` key is left out.
 */
export function serializeFrontmatter(fm) {
  const value = failsafeValue(fm);
  const doc = new Document(value, YAML_OPTIONS);
  visit(doc, {
    Seq(_, node) {
      if (!node.items.every((item) => isScalar(item))) return;
      node.flow = true;
      for (const item of node.items) if (item.value === '') item.type = Scalar.QUOTE_DOUBLE;
    },
  });
  const text = Object.keys(value).length ? doc.toString({ lineWidth: 0, flowCollectionPadding: false }) : '';
  return `---\n${text}---\n`;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Slugify a title for directory names. */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  'all',
  'dir',
  'list',
  'refine',
  'plan-only',
  'keep',
  'switch-main',
  'superseded',
  'dry-run',
  'json',
  'no-sync',
  'no-story',
  'no-review',
  'force',
  'features',
  'home',
]);

const SHORT_FLAGS = {
  a: 'all',
  A: 'agent',
  d: 'dir',
  m: 'message',
  P: 'prompt',
  r: 'repo',
};

// Options no command takes any more (F-51 D5): refused rather than ignored,
// so a script that still passes one learns it filters nothing. Keyed as the
// option is spelled after its dashes.
const UNKNOWN_OPTIONS = new Set(['project', 'p']);

function refuseUnknown(name, arg) {
  if (UNKNOWN_OPTIONS.has(name)) throw new Error(`bl: unknown option "${arg}"`);
}

// Flags whose values accumulate into an array across repeated occurrences.
const LIST_FLAGS = new Set(['depends-on', 'required-for', 'commit', 'skip']);

function assignFlag(args, name, value) {
  if (LIST_FLAGS.has(name)) {
    if (!Array.isArray(args[name])) args[name] = [];
    args[name].push(value);
  } else {
    args[name] = value;
  }
}

// A separate token may serve as a flag's value unless it looks like an option
// (`-x`, `--x`). A lone `-` is a value (conventionally "stdin"). A refused
// token leaves the flag `true`, which each subcommand reports as
// `requires a value`; values that start with `-` go in the inline
// `--flag=value` form.
function isValueToken(t) {
  return t === '-' || !t.startsWith('-');
}

export function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      const name = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
      refuseUnknown(name, `--${name}`);
      if (eqIdx !== -1) {
        assignFlag(args, name, arg.slice(eqIdx + 1));
      } else if (BOOLEAN_FLAGS.has(name)) {
        args[name] = true;
      } else if (i + 1 < argv.length && isValueToken(argv[i + 1])) {
        assignFlag(args, name, argv[++i]);
      } else {
        args[name] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const letter = arg.slice(1);
      refuseUnknown(letter, arg);
      const longName = SHORT_FLAGS[letter] || letter;
      if (BOOLEAN_FLAGS.has(longName)) {
        args[longName] = true;
      } else if (i + 1 < argv.length && isValueToken(argv[i + 1])) {
        assignFlag(args, longName, argv[++i]);
      } else {
        args[longName] = true;
      }
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Plugin system
// ---------------------------------------------------------------------------

/**
 * A parsed plugin list (`plugins: [a, -b]`, F-62 D2) as its names, each
 * `-name` kept as written; `[]` when absent or empty. Throws
 * `FrontmatterListError` when it is not a list of strings.
 * @returns {string[]}
 */
export function parsePluginList(raw) {
  return listMembers(raw)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve active plugins for a stage via a cascade of frontmatter layers.
 *
 * Layers (later overrides earlier):
 *   1. Top-level backlog index (`<backlogRoot>/index.md`)
 *   2. The unit's repo entry   (`repo`: a `config.repos` record, whose
 *                               `plugins-<stage>` lists `backlog.json` sets)
 *   3. Component index         (`<backlogRoot>/components/<componentEntry>/index.md`)
 *   4. Story index             (`<backlogRoot>/stories/<storyEntry>/index.md`)
 *
 * Each frontmatter may declare `plugins: [a, -b, c]` (generic) or
 * `plugins-<stage>: [...]` (stage-specific; takes precedence within that layer).
 * The repo layer has only the stage-specific form (F-51 D4).
 * Bare names add plugins; `-name` removes them. Only names defined in the
 * merged plugin registry with a command for `stage` are honoured.
 */
export function resolvePlugins(stage, pluginRegistry, { backlogRoot, repo, componentEntry, storyEntry } = {}) {
  const available = new Set(Object.keys(pluginRegistry).filter((name) => pluginRegistry[name]?.[stage]));
  const active = new Set();

  for (const fm of cascadeLayers({ backlogRoot, repo, componentEntry, storyEntry })) {
    for (const entry of parsePluginList(fm[`plugins-${stage}`] ?? fm.plugins)) {
      if (entry.startsWith('-')) active.delete(entry.slice(1));
      else if (available.has(entry)) active.add(entry);
    }
  }

  return [...active].map((name) => ({
    name,
    command: pluginRegistry[name][stage],
  }));
}

/**
 * Parse the frontmatter cascade for a stage and return adds vs removes
 * separately. Used by the `format` / `lint` dispatchers so that
 * `plugins-format: extra-md` *augments* `language_dispatch.format` (both the
 * default and the cascade-added plugin run on `.md` files) rather than
 * replacing it. `-name` entries record removes so callers can suppress a
 * default plugin without silently emptying the entire dispatch table.
 *
 * Walks the same four layers as `resolvePlugins`. Later layers may flip an
 * earlier add into a remove (and vice versa) — last write wins per name.
 */
export function parsePluginCascade(stage, { backlogRoot, repo, componentEntry, storyEntry } = {}) {
  const adds = new Set();
  const removes = new Set();

  for (const fm of cascadeLayers({ backlogRoot, repo, componentEntry, storyEntry })) {
    for (const entry of parsePluginList(fm[`plugins-${stage}`] ?? fm.plugins)) {
      if (entry.startsWith('-')) {
        const name = entry.slice(1);
        adds.delete(name);
        removes.add(name);
      } else {
        removes.delete(entry);
        adds.add(entry);
      }
    }
  }

  return { adds: [...adds], removes: [...removes] };
}

/**
 * The cascade's layers, in order (see `resolvePlugins`), each as a
 * frontmatter-shaped object. The repo layer is its `plugins-<stage>` lists.
 */
function cascadeLayers({ backlogRoot, repo, componentEntry, storyEntry }) {
  const fmAt = (path) => (existsSync(path) ? parseFrontmatter(readFileSync(path, 'utf8')).fm : {});
  const out = [];
  if (backlogRoot) out.push(fmAt(join(backlogRoot, 'index.md')));
  if (repo?.plugins) {
    out.push(Object.fromEntries(Object.entries(repo.plugins).map(([s, list]) => [`plugins-${s}`, list])));
  }
  if (backlogRoot && componentEntry) {
    out.push(fmAt(join(backlogRoot, COMPONENTS_DIR, componentEntry, 'index.md')));
  }
  if (backlogRoot && storyEntry) {
    out.push(fmAt(join(backlogRoot, STORIES_DIR, storyEntry, 'index.md')));
  }
  return out;
}

/**
 * Emit the canonical "missing binary" warning. Shared by `runPlugins` and
 * `runPluginBatch` so the contract stays in lockstep — the implicit-context
 * soft-skip and the explicit-context non-zero exit both surface the same
 * shape of message, including the resolved leader name when available.
 */
export function warnMissingBinary(pluginName, cmd) {
  const leader = commandLeader(cmd);
  warn(`plugin ${pluginName}: command not found${leader ? ` (${leader})` : ''} — skipping`);
}

/**
 * Run resolved plugins, interpolating `{{vars}}` in each command.
 *
 * Plugin stdout is routed to the parent's stderr so callers like `bl new`
 * can keep their stdout clean for the documented contract (one path, or a
 * JSON object). Plugin stderr also goes to parent's stderr unchanged. In
 * an interactive terminal both streams render to the TTY, so users see
 * plugin output as before.
 */
export function runPlugins(plugins, vars, cwd) {
  for (const { name, command } of plugins) {
    let cmd = command;
    for (const [k, v] of Object.entries(vars)) {
      cmd = cmd.replaceAll(`{{${k}}}`, v);
    }
    info(`  plugin ${name}: ${cmd}`);
    const result = spawnSync(cmd, {
      cwd,
      shell: true,
      // Plugins run fully non-interactively (stdin is ignored, no TTY), so
      // advertise that: `CI=true` stops tools like pnpm from aborting when
      // they'd otherwise prompt for confirmation — e.g.
      // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when purging a stale
      // worktree node_modules during bootstrap.
      env: { CI: 'true', ...process.env },
      stdio: ['ignore', process.stderr, process.stderr],
    });
    if (result.status === 127 || (result.error && result.error.code === 'ENOENT')) {
      // Implicit-context callers (`installDeps`, `runStagePlugins`): missing
      // binary is a soft skip — warn one line and continue to the next
      // plugin so the outer command (workon, sync) keeps flowing.
      warnMissingBinary(name, cmd);
      continue;
    }
    if (result.error) {
      console.error(`  plugin ${name} failed to spawn: ${result.error.message}`);
      return false;
    }
    if (result.status !== 0) {
      console.error(`  plugin ${name} failed (exit ${result.status ?? '?'})`);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tool dispatch — language_dispatch + per-extension plugin lookup
// ---------------------------------------------------------------------------
//
// `language_dispatch` maps `<stage> → <extension> → <plugin name>`. The plugin
// name then resolves through the same registry as the frontmatter cascade
// (`plugins[name][stage]`). S-441 plugs `runForgeOp` in here next to these
// helpers; S-442 reads the table to render `{{toolGuide}}` for prompts.

/**
 * Look up the plugin name(s) registered for a file extension under a stage.
 * Returns an array (possibly empty) so callers can uniformly handle the
 * single-string and array dispatch shapes — `language_dispatch.format[".md"]`
 * accepts both `"md"` and `["md", "extra-md"]`.
 */
export function pluginForExtension(languageDispatch, stage, ext) {
  const map = languageDispatch?.[stage];
  if (!map) return [];
  const val = map[ext];
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Bucket file paths by the plugin that handles them for `stage`.
 * Returns a `Map<pluginName, paths[]>`. Files with no registered plugin (or
 * a plugin missing a `stage` entry) are silently dropped — that's the
 * "absent plugin = silent skip" contract. Missing-binary failures surface
 * later when the spawned command fails; we only filter at registration time
 * here.
 *
 * Array-valued dispatch entries (`{".md": ["md", "extra-md"]}`) are honoured
 * so the same shape works in `bl sync`'s backlog-scoped pass and in the
 * `bl format` / `bl lint` story-scoped pass.
 */
export function bucketByPlugin(paths, stage, languageDispatch, pluginRegistry) {
  const buckets = new Map();
  for (const p of paths) {
    // Extension parsing must work on the basename — `lastIndexOf(".")` on a
    // full path like `foo.config/bar` would otherwise resolve to ext
    // `.config/bar`. Leading-dot files (`.eslintrc`) have no extension and
    // are skipped: their leading dot is filename, not separator.
    const base = basename(p);
    if (base.startsWith('.')) continue;
    const dot = base.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = base.slice(dot);
    const names = pluginForExtension(languageDispatch, stage, ext);
    for (const name of names) {
      if (!pluginRegistry?.[name]?.[stage]) continue;
      const list = buckets.get(name);
      if (list) list.push(p);
      else buckets.set(name, [p]);
    }
  }
  return buckets;
}

/** A leader that begins with a `{{var}}` template token. */
const TEMPLATE_LEADER = /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/;

/**
 * Whether a leader ends in a `;`, `)` or `}` that is shell grouping syntax
 * (`cmd;`, `cmd)`, `cmd}`) rather than token content. A balanced scan pairs
 * every unescaped `(` and `{` before the last character with its closer,
 * so a `)` or `}` that closes a still-open `${var}` expansion, `$(cmd)`
 * substitution or `{{var}}` template at any depth (`${A:-${B:-${C}}}`,
 * `$(a-$(b-$(c)))`, `$((1+(2*3)))`, `{{bin}}`) is content, and a last
 * character preceded by an odd run of backslashes is escaped and also
 * content (`foo\;` keeps its `;`; `foo\\;` ends in an unescaped `;`).
 */
function endsWithGroupingSyntax(name) {
  const last = name.at(-1);
  if (last !== ';' && last !== ')' && last !== '}') return false;
  const open = [];
  let escaped = false;
  for (const ch of name.slice(0, -1)) {
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '(' || ch === '{') {
      open.push(ch);
    } else if (ch === ')' || ch === '}') {
      if (open.at(-1) === (ch === ')' ? '(' : '{')) open.pop();
    }
  }
  if (escaped) return false;
  if (last === ';') return true;
  return open.at(-1) !== (last === ')' ? '(' : '{');
}

/** Trim the trailing `;`, `)` and `}` that are shell grouping, not content. */
function trimGroupingSyntax(word) {
  while (word && endsWithGroupingSyntax(word)) word = word.slice(0, -1);
  return word;
}

/**
 * Split a command string into its leading command name (`leader`) and the
 * word after it (`next`), the pair the allowlist's two-word mode rules
 * (`gh pr:*`) are made of. One parse serves both words, so they agree on
 * every shape.
 *
 * The leader: skips, in any order, leading `FOO=bar` env-var assignments
 * and the whitespace-separated grouping tokens of a brace group or subshell
 * (`CI=true { cmd; }`, `{ CI=true cmd; }`, `( cmd )`); strips grouping
 * characters attached to the front of a token one at a time (`(cmd)`,
 * `{cmd;}`, `((cmd`, `(CI=true cmd)`); and trims trailing `;`, `)` or `}`
 * left on the leader by a one-token group (`cmd;`, `cmd)`). A leader that
 * starts with a `{{var}}` template token
 * (`{{roostDir}}/tools/bin/prettier`, also wrapped as
 * `({{roostDir}}/tools/bin/prettier` or `{ {{roostDir}}/tools/bin/prettier; }`)
 * is returned intact: the brace strip is for shell grouping, so it stops at
 * the template rather than eating its `{{` and leaving a dead
 * `roostDir}}/...` token, and the trailing trim never eats the closing `}}`
 * of a leader that ends in a template (`{{bin}}`). Trailing punctuation that
 * is token content also stays: the closing `}` or `)` of a `${var}`
 * parameter expansion or `$(cmd)` command substitution at any nesting depth
 * (`${TOOL}`, `${A:-${B:-${C}}}`, `$(a-$(b-$(c)))`) and a `;`, `)` or `}`
 * escaped by an odd run of backslashes (`foo\;`), both decided by
 * `endsWithGroupingSyntax`.
 *
 * `next`: the token after the leader with the same trailing trim (`pr` in
 * `gh pr create`, `CI=true gh pr create`, `(gh pr)` and `{ gh pr; }`), or
 * null when there is none (`gh`, `(gh)`, `{ gh; }`), when the leader itself
 * closed its group (`cmd; foo`, `(cmd) foo`: `foo` starts a new command
 * rather than being an argument), or when the word is a `{{var}}` runtime
 * template (`gh {{sub}}`): a permission rule holds no variables.
 *
 * Returns null if no leader is left (`""`, `{`, `{ }`, `{{`).
 *
 * @param {string} commandStr
 * @returns {{ leader: string, next: string | null } | null}
 */
export function commandWords(commandStr) {
  if (typeof commandStr !== 'string') return null;
  const tokens = commandStr.trim().split(/\s+/);
  let i = 0;
  let name = '';
  for (; i < tokens.length; i++) {
    let token = tokens[i];
    // Grouping characters at the front of a token are shell grouping, not
    // the leader; a `{{var}}` token stops the strip because it carries a
    // name. A token that is nothing but grouping (`{`, `((`) or an env-var
    // assignment is skipped, in any order, so `{ CI=true cmd; }` reaches
    // `cmd`.
    while (token && !TEMPLATE_LEADER.test(token) && /^[(){}]/.test(token)) {
      token = token.slice(1);
    }
    if (!token || /^[A-Z_][A-Z0-9_]*=/.test(token)) continue;
    name = token;
    break;
  }
  const leader = trimGroupingSyntax(name);
  if (!leader) return null;
  // A leader that lost trailing punctuation ended its group or statement,
  // so whatever follows is not its argument.
  const word = leader === name ? trimGroupingSyntax(tokens[i + 1] ?? '') : '';
  const next = word && !word.startsWith('{{') ? word : null;
  return { leader, next };
}

/**
 * The leading command name of a command string: `commandWords(cmd).leader`,
 * or null if there is none. Used by the allowlist generator
 * (`allowed-tools.js`), the tool guide and the missing-binary signal in
 * `runPluginBatch` / `runPlugins`.
 */
export function commandLeader(commandStr) {
  return commandWords(commandStr)?.leader ?? null;
}

/**
 * Interpolate config-static `{{var}}` tokens (paths known at config-load time)
 * into a plugin command string. Only the vars that can appear in a command's
 * *leader* — `{{roostDir}}`, `{{backlogRoot}}` — are resolved here, so the
 * binary probe (`enumeratePlugins`/`probePluginBinaries`) checks the real
 * path on this machine. The allowlist generator deliberately does not call
 * this: it keeps the leader templated so the committed `allowed-tools.json`
 * is machine-independent, and `resolveAllowedTokens` (`allowed-tools.js`)
 * makes it absolute at session build. Per-invocation runtime vars
 * (`{{path}}`, `{{number}}`, `{{branch}}`, ...) are deliberately left intact —
 * they never form the leader and are substituted at run time.
 */
export function interpolateStaticVars(command, config) {
  if (typeof command !== 'string') return command;
  const vars = {
    roostDir: config?.roostDir,
    backlogRoot: config?.backlogRoot,
  };
  let out = command;
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string') out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

/**
 * Enumerate every (plugin, first-token) pair declared in `config.plugins`.
 *
 * For each plugin key, walks its string-valued entries (every stage / forge
 * op whose value is a shell command) and groups them by their resolved
 * first-token (via `commandLeader`). Plugin entries whose command string is
 * empty (or whose leader is unresolvable) collapse into a single entry per
 * plugin key with `firstToken: null` so callers can mark them SKIP in init
 * output and skip them entirely in `bl validate`'s missing-binary check.
 *
 * Used by `bl init`'s plugin-tools readout and by `bl validate`'s
 * `plugin-binary` finding (S-443).
 *
 * @returns {Array<{
 *   key: string,
 *   stages: string[],
 *   command: string,
 *   firstToken: string | null
 * }>}
 */
export function enumeratePlugins(config) {
  const plugins = config?.plugins ?? config?.raw?.plugins ?? {};
  const out = [];
  for (const [key, def] of Object.entries(plugins)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
    const byToken = new Map();
    let hadCommand = false;
    for (const [stage, cmd] of Object.entries(def)) {
      if (typeof cmd !== 'string') continue;
      if (cmd.trim() === '') {
        if (!byToken.has(null)) {
          byToken.set(null, {
            key,
            stages: [],
            command: '',
            firstToken: null,
          });
        }
        byToken.get(null).stages.push(stage);
        continue;
      }
      hadCommand = true;
      // Resolve `{{roostDir}}`-style static vars before extracting the leader
      // so probes check the real binary path, not a mangled template token.
      const resolved = interpolateStaticVars(cmd, config);
      const token = commandLeader(resolved);
      if (!token) {
        if (!byToken.has(null)) {
          byToken.set(null, {
            key,
            stages: [],
            command: resolved,
            firstToken: null,
          });
        }
        byToken.get(null).stages.push(stage);
        continue;
      }
      const existing = byToken.get(token);
      if (existing) {
        existing.stages.push(stage);
      } else {
        byToken.set(token, {
          key,
          stages: [stage],
          command: resolved,
          firstToken: token,
        });
      }
    }
    if (byToken.size === 0 && !hadCommand) {
      // Plugin with no string-valued entries at all (e.g. only `extensions`
      // metadata). Emit a single SKIP row so the init readout still surfaces
      // it.
      out.push({ key, stages: [], command: '', firstToken: null });
      continue;
    }
    for (const entry of byToken.values()) out.push(entry);
  }
  return out;
}

/**
 * Run one plugin for a stage against a batch of paths in a single spawn.
 * `{{path}}` in the command is replaced by the space-joined paths; other
 * `{{var}}` tokens come from `vars`.
 *
 * Returns `{ ok, status, missing? }`. Missing-binary case (`shell` exits
 * 127) yields `{ ok: false, status: 127, missing: true }` so callers can
 * distinguish "tool not installed" from a normal non-zero plugin exit:
 *   - implicit callers (`bl sync`'s .md format pass, `installDeps`) treat
 *     `missing: true` as a soft skip — warn already emitted, outer command
 *     continues.
 *   - explicit callers (`bl format` / `bl lint` via `applyStageInWorktree`)
 *     fold the 127 into `worstStatus` so CI fails when configured tooling
 *     is absent.
 *
 * `shell: true` swallows ENOENT (the leader is found by the shell, not by
 * spawn), so status 127 is the canonical missing-binary signal.
 */
export function runPluginBatch(name, command, paths, vars, cwd) {
  const quoted = paths.map((p) => `'${p.replaceAll("'", "'\\''")}'`).join(' ');
  let cmd = command.replaceAll('{{path}}', quoted);
  for (const [k, v] of Object.entries(vars ?? {})) {
    cmd = cmd.replaceAll(`{{${k}}}`, v);
  }
  info(`  plugin ${name}: ${cmd}`);
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    // See runPlugins: plugins are non-interactive (stdin ignored), so CI=true
    // keeps tools from aborting on would-be confirmation prompts.
    env: { CI: 'true', ...process.env },
    stdio: ['ignore', process.stderr, process.stderr],
  });
  if (result.status === 127 || (result.error && result.error.code === 'ENOENT')) {
    warnMissingBinary(name, cmd);
    return { ok: false, status: 127, missing: true };
  }
  if (result.error) {
    warn(`plugin ${name}: failed to spawn (${result.error.message}) — skipping`);
    return { ok: false, status: result.status ?? 1 };
  }
  return { ok: result.status === 0, status: result.status ?? 1 };
}

// ---------------------------------------------------------------------------
// Forge ops — conceptual PR operations dispatched through a configured plugin
// ---------------------------------------------------------------------------
//
// `forge` is a top-level `backlog.json` key naming which plugin handles the
// change operations of F-42 D4 (`FORGE_OPS`: `change.open`, `change.find`,
// `change.close`, …). The same plugin registry that holds toolchain commands
// (S-440) doubles as the forge registry: `plugins.<forgeName>.<op>` is the
// shell command, with the same `{{var}}` interpolation contract. Every op
// runs in a repo's checkout, so an op is keyed by that repo and a
// `{{branch}}`, or by the `{{number}}` the change document records. Only bl
// calls them; no agent permission mode is granted a forge command.
//
// `runForgeOp` returns a structured result so callers can JSON-parse list
// output without each one re-implementing `execSync`. Missing forge config,
// missing op, and missing binaries all collapse to the same
// `{ configured: false, reason }` sentinel — callers fall through to their
// existing "no PR or gh unavailable" non-fatal path. `repoPath` is required
// (every forge op runs against a specific repo's working tree, not "current
// cwd") and round-trips back into the result so per-repo logging works.

/**
 * POSIX-portable single-quoting: wrap a value in single quotes and rewrite
 * any embedded `'` as `'\''` (close, escape, reopen). Safe to drop into any
 * `sh -c` string. Used by forge `{{var}}` substitution, by the `bl refine -t`
 * tmux-detach argv reconstruction, etc.
 */
export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

const shellQuoteForgeVar = shellQuote;

/**
 * Capture the id of the tmux window `bl` was invoked in, once, at startup.
 *
 * tmux window ids (e.g. `@5`) are stable for the life of a window regardless
 * of which window is currently active, unlike `#W` (name) or the implicit
 * "current window" target. Renames can fire a moment after `bl` starts — long
 * enough for the user to switch tabs — so every rename must target the window
 * we started in, not whichever one happens to be focused. We grab the id here
 * and stash it in the environment so it survives across the dynamic `import()`
 * boundaries the subcommands load through.
 */
export function captureTmuxWindowId() {
  if (!process.env.TMUX || process.env.BL_TMUX_WINDOW_ID) return;
  const res = spawnSync('tmux', ['display-message', '-p', '#{window_id}'], {
    encoding: 'utf8',
  });
  if (res.status === 0 && res.stdout) {
    process.env.BL_TMUX_WINDOW_ID = res.stdout.trim();
  }
}

/**
 * Rename the tmux window `bl` was invoked in (see `captureTmuxWindowId`),
 * targeting it by captured id so we never rename a window the user has since
 * switched to. No-op when not under tmux. Non-fatal on any tmux error.
 */
export function renameTmuxWindow(label) {
  if (!process.env.TMUX) return;
  const id = process.env.BL_TMUX_WINDOW_ID;
  const args = ['rename-window'];
  if (id) args.push('-t', id);
  args.push(label);
  try {
    spawnSync('tmux', args, { stdio: 'pipe' });
  } catch {
    // not fatal
  }
}

/**
 * Run `bl <argv>` in a new, detached tmux window named `name`, from `cwd`;
 * the window keeps a shell open when bl exits. The invoking window is left
 * alone: renaming it, even to its own name, would turn off tmux
 * `automatic-rename`. The captured window id is unset first so the inner bl
 * captures the new window instead of renaming ours. Throws when tmux fails.
 *
 * @param {string} name
 * @param {string[]} argv  the arguments after `bl`
 * @param {{ cwd?: string }} [opts]
 */
export function openTmuxWindow(name, argv, { cwd = process.cwd() } = {}) {
  const innerCmd = `unset BL_TMUX_WINDOW_ID; cd ${shellQuote(cwd)} && bl ${argv.map(shellQuote).join(' ')}; exec $SHELL`;
  const res = spawnSync('tmux', ['new-window', '-d', '-n', name, innerCmd], { stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    throw new Error(`tmux new-window failed for ${name}${res.error ? `: ${res.error.message}` : ''}`);
  }
}

/**
 * The forge ops bl calls (F-42 D4), each with the `{{vars}}` it is given. A
 * forge plugin holds these and no others (`bl validate`), and only
 * `update.notes` (Renovate's release notes) may read a PR body.
 *
 *   change.open      title, body       prints the new PR's URL   (bl run)
 *   change.describe  number, body      rewrites an open PR's body (bl run)
 *   change.find      branch            JSON [{number,url,state,headRefOid,labels}]
 *   change.close     number, comment   (bl merge, bl updates drop)
 *   change.ready     number            marks a draft PR ready (bl updates run)
 *   update.notes     number            Renovate's PR body (bl updates run)
 */
export const FORGE_OPS = Object.freeze({
  'change.open': ['title', 'body'],
  'change.describe': ['number', 'body'],
  'change.find': ['branch'],
  'change.close': ['number', 'comment'],
  'change.ready': ['number'],
  'update.notes': ['number'],
});

/** The one op allowed to read a PR body. */
export const BODY_READING_OP = 'update.notes';

/**
 * Run a forge op (e.g. `change.find`, `change.close`) through the
 * configured forge plugin.
 *
 * @param {string} opName — an op of `FORGE_OPS`, e.g. `change.find`
 * @param {Record<string, string>} [vars] — `{{var}}` substitutions
 * @param {object} opts
 * @param {object} opts.config — loaded config (from `loadConfig`)
 * @param {string} opts.repoPath — required cwd for the forge command
 * @returns {{
 *   configured: boolean,
 *   reason?: 'no-forge' | 'no-plugin' | 'no-op' | 'missing-binary' | 'spawn-error',
 *   stdout?: string,
 *   stderr?: string,
 *   status?: number,
 *   repoPath: string,
 *   repoName: string,
 * }}
 */
export function runForgeOp(opName, vars = {}, opts = {}) {
  const { config, repoPath } = opts;
  if (!repoPath) {
    throw new Error('runForgeOp: repoPath is required');
  }
  const repoName = basename(repoPath);
  const forgeName = config?.raw?.forge;
  if (!forgeName || typeof forgeName !== 'string') {
    return { configured: false, reason: 'no-forge', repoPath, repoName };
  }
  const plugins = config?.plugins ?? config?.raw?.plugins ?? {};
  const plugin = plugins[forgeName];
  if (!plugin || typeof plugin !== 'object') {
    return { configured: false, reason: 'no-plugin', repoPath, repoName };
  }
  const command = plugin[opName];
  if (typeof command !== 'string' || !command) {
    return { configured: false, reason: 'no-op', repoPath, repoName };
  }
  let cmd = command;
  for (const [k, v] of Object.entries(vars)) {
    // A function, not a string: a replacement string expands $', $` and $&,
    // which git allows in branch names and which would undo the quoting.
    cmd = cmd.replaceAll(`{{${k}}}`, () => shellQuoteForgeVar(v));
  }
  const result = spawnSync(cmd, {
    cwd: repoPath,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.status === 127 || (result.error && result.error.code === 'ENOENT')) {
    warnMissingBinary(`forge:${forgeName}:${opName}`, cmd);
    return { configured: false, reason: 'missing-binary', repoPath, repoName };
  }
  if (result.error) {
    warn(`forge ${forgeName}:${opName}: failed to spawn (${result.error.message})`);
    return {
      configured: false,
      reason: 'spawn-error',
      repoPath,
      repoName,
    };
  }
  return {
    configured: true,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
    repoPath,
    repoName,
  };
}

/**
 * A branch's PRs through `change.find`, as the forge lists them, each
 * `{ number, url, state, headRefOid, labels }` with `state` upper-cased
 * (`OPEN`, `MERGED`, `CLOSED`; `OPEN` when the template asks for no state,
 * since the forge then lists open PRs only). Never throws:
 *   { ok: true, prs }
 *   { ok: false, configured: false, reason }  — runForgeOp's sentinel
 *   { ok: false, configured: true, reason: "failed", error }
 *   { ok: false, configured: true, reason: "unparseable" }
 *
 * @param {string} branch
 * @param {{ config: object, repoPath: string, runOp?: Function }} opts
 */
export function findChange(branch, { config, repoPath, runOp = runForgeOp }) {
  let res;
  try {
    res = runOp('change.find', { branch }, { config, repoPath });
  } catch (e) {
    return { ok: false, configured: false, reason: 'spawn-error', error: e.message };
  }
  if (!res?.configured) {
    return { ok: false, configured: false, reason: res?.reason ?? 'unknown' };
  }
  if (res.status !== 0) {
    const error = String(res.stderr ?? '').trim() || `exit ${res.status}`;
    return { ok: false, configured: true, reason: 'failed', error };
  }
  let list;
  try {
    list = JSON.parse(res.stdout || '[]');
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) {
    return { ok: false, configured: true, reason: 'unparseable' };
  }
  const prs = list
    .filter((p) => p && typeof p === 'object' && p.number != null)
    .map((p) => ({ ...p, state: String(p.state || 'OPEN').toUpperCase() }));
  return { ok: true, prs };
}

// ---------------------------------------------------------------------------
// Pager
// ---------------------------------------------------------------------------

/**
 * Run text through $PAGER exactly as set, through the shell (default `less`).
 * bl adds no flags of its own: how less behaves is the operator's `$LESS`.
 */
export function runPager(text) {
  const pager = process.env.PAGER?.trim();
  if (pager) {
    return spawnSync(pager, {
      input: text,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true,
    });
  }
  return spawnSync('less', [], {
    input: text,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** The operator's editor command: `$VISUAL`, then `$EDITOR`, then `vi`. */
export function editorCommand() {
  return process.env.VISUAL || process.env.EDITOR || 'vi';
}

/**
 * Open `path` in the operator's editor (`bl edit`, `bl view`). The editor
 * value runs through the shell, so one with arguments (`code --wait`) works;
 * the path is shell-quoted into the command, since `shell: true` joins args
 * unquoted.
 */
export function runEditor(path) {
  return spawnSync(`${editorCommand()} ${shellQuote(path)}`, {
    stdio: 'inherit',
    shell: true,
  });
}
