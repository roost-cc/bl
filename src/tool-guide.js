/**
 * tool-guide.js — render `prompts/_tool-guide.md` against live config.
 *
 * The tool guide is the single source of truth for generic tool-usage
 * guidance injected into every top-level prompt. Concrete commands
 * (`{{formatExamples}}`, `{{lintExamples}}`, `{{prOps}}`,
 * `{{toolsOnPath}}`) are derived from `backlog.json`'s `plugins`,
 * `language_dispatch`, and `forge` registries — swapping a plugin in
 * config changes what the agent reads, with no source edit and no
 * prompt-file edit.
 *
 * The renderer is forgiving: unconfigured optional sections render as
 * `_(none)_` rather than blowing up. That keeps the same prompt usable
 * during the S-440/S-441/S-442 landing window when a backlog hasn't yet
 * declared every registry slot.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { commandLeader } from './config.js';
import { resolveLocale, fragmentCandidates } from './locale.js';
import { resolveSurface } from './surface.js';
import { renderSessionStack } from './session-stack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Private test seam: `BL_INTERNAL_TEST_PROMPTS_DIR` lets unit tests point
 * fragment lookups at a fixture directory without shipping non-English
 * prompts in the real `prompts/` tree. Resolved lazily on every read so
 * a test can set/unset between cases.
 */
function promptsDir() {
  return process.env.BL_INTERNAL_TEST_PROMPTS_DIR || join(__dirname, '..', 'prompts');
}

/**
 * Read a prompt fragment, preferring agent-specific and localized variants
 * when present. Returns the empty string when nothing exists — callers
 * that swallow missing fragments still work.
 */
function readFragment(name, locale = null, agent = null) {
  const dir = promptsDir();
  for (const variant of fragmentCandidates(name, locale, agent)) {
    const path = join(dir, variant);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return '';
}

function interpolate(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.replaceAll(`{{${k}}}`, v ?? '');
  }
  return out;
}

/**
 * Render the "Use dedicated tools" bullet list with agent-specific tool
 * names slotted in. Returns a markdown bullet block (no trailing newline).
 */
export function renderToolUsageHint(toolHints, locale = null, agent = null) {
  const text = readFragment('_dedicated-tools', locale, agent);
  return interpolate(text, toolHints).replace(/\n+$/, '');
}

function uniqueExtsFromDispatch(stageMap) {
  const out = new Set();
  for (const ext of Object.keys(stageMap ?? {})) out.add(ext);
  return [...out];
}

function pluginNamesForExt(stageMap, ext) {
  const v = stageMap?.[ext];
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Render a markdown bullet list of `<ext> → <command>` pairs from
 * `language_dispatch[stage]` and the matching plugin's `[stage]` command.
 * If the stage is unconfigured (or every dispatch entry resolves to a
 * missing plugin), returns the literal `_(none configured)_` so the
 * surrounding prose still reads naturally.
 *
 * The output ends with a trailing newline so adjacent `{{...Examples}}`
 * slots in the skeleton render with a blank line between sections.
 */
export function renderStageExamples(stage, languageDispatch, plugins) {
  const stageMap = languageDispatch?.[stage] ?? {};
  const exts = uniqueExtsFromDispatch(stageMap).sort();
  const lines = [];
  for (const ext of exts) {
    for (const name of pluginNamesForExt(stageMap, ext)) {
      const cmd = plugins?.[name]?.[stage];
      if (typeof cmd !== 'string' || !cmd) continue;
      lines.push(`- \`${ext}\` → \`${cmd}\` (plugin \`${name}\`)`);
    }
  }
  if (lines.length === 0) return '_(none configured)_\n';
  return `**${stage}**:\n${lines.join('\n')}\n`;
}

/**
 * Say who owns the unit's pull request. bl makes every forge call (F-42
 * D4): the session commits and pushes, `bl run` / `bl review` open the PR
 * and write its body from the change document, `bl merge` closes it. The
 * forge plugin's ops are not listed: they are bl's, not the agent's.
 */
export function renderPrOps(forgeName, plugins) {
  if (!forgeName || typeof forgeName !== 'string') {
    return 'No forge is configured: the change document records the branch and the merge, with no pull request.';
  }
  if (!plugins?.[forgeName] || typeof plugins[forgeName] !== 'object') {
    return `_(forge \`${forgeName}\` is not registered in plugins)_`;
  }
  return [
    `\`bl\` makes every call to the forge (\`${forgeName}\`). Commit and push your branch; never open,`,
    "edit or close this unit's pull request with the forge CLI. `bl run` and `bl review` open it and",
    "write its title and body from the change document's `## Description`, and `bl merge` closes it.",
  ].join('\n');
}

/**
 * Build the union of first-token leaders across every plugin command
 * except the forge plugin's (its ops are bl's to run). Adds a baseline of
 * `bl`, `git`, `node` so the resulting list is meaningful even with an
 * empty config. Sorted, deduplicated, returned as a comma-joined inline
 * list.
 */
export function renderToolsOnPath(plugins, forgeName) {
  const leaders = new Set(['bl', 'git', 'node']);
  const allPlugins = plugins ?? {};
  for (const [name, def] of Object.entries(allPlugins)) {
    if (typeof forgeName === 'string' && name === forgeName) continue;
    if (!def || typeof def !== 'object') continue;
    for (const v of Object.values(def)) {
      if (typeof v !== 'string') continue;
      const leader = commandLeader(v);
      if (leader) leaders.add(leader);
    }
  }
  return [...leaders]
    .sort()
    .map((l) => `\`${l}\``)
    .join(', ');
}

function renderIdeHints(surface, locale, slots) {
  if (!surface) return '';
  const text = readFragment(`_ide-hints.${surface}`, locale);
  if (!text.trim()) return '';
  return interpolate(text, slots).replace(/\n+$/, '');
}

/**
 * Render the full tool guide for a given config + agent + caller-supplied
 * variables (`storyId`, `storyRepos`, `backlogDir`, `roostDir`).
 *
 * The function is purposely tolerant of a missing config — the only hard
 * requirement is `toolHints` (we always need agent-specific tool names).
 * Everything else degrades to a `_(none configured)_` placeholder.
 */
export function renderToolGuide(config, toolHints, vars = {}, agent = null) {
  const plugins = config?.plugins ?? config?.raw?.plugins ?? {};
  const languageDispatch = config?.languageDispatch ?? config?.raw?.language_dispatch ?? {};
  const forgeName = config?.raw?.forge ?? null;
  const locale = resolveLocale(config);
  const surface = resolveSurface(config);

  const skeleton = readFragment('_tool-guide', locale, agent);
  if (!skeleton) return '';

  const slots = {
    ...toolHints,
    toolUsageHint: renderToolUsageHint(toolHints, locale, agent),
    formatExamples: renderStageExamples('format', languageDispatch, plugins),
    lintExamples: renderStageExamples('lint', languageDispatch, plugins),
    testExamples: renderStageExamples('test', languageDispatch, plugins),
    prOps: renderPrOps(forgeName, plugins),
    toolsOnPath: renderToolsOnPath(plugins, forgeName),
    storyId: vars.storyId ?? '<unknown>',
    storyRepos: vars.storyRepos ?? '<unknown>',
    backlogDir: vars.backlogDir ?? '<backlog>',
    roostDir: vars.roostDir ?? config?.roostDir ?? '<backlog-parent>',
  };
  // A unit's session starts in its unit directory (F-60 D3); any other
  // (refine, triage) in the directory it names.
  slots.workingDirectory = interpolate(
    readFragment(vars.unitDir ? '_working-dir-unit' : '_working-dir', locale, agent),
    { unitDir: vars.unitDir ?? '', backlogDir: slots.backlogDir },
  ).replace(/\n+$/, '');
  slots.ideHints = renderIdeHints(surface, locale, slots);
  // The workspace's session-stack tool rules, if backlog.json names a
  // session_stack guide (S-581).
  slots.sessionStackTools = renderSessionStack(config, ['tool-guide'], slots);
  return interpolate(skeleton, slots).replace(/\n+$/, '\n');
}

/**
 * Read a hook-deny fragment by name and return JSON-safe text suitable for
 * embedding inside `jq -n '... permissionDecisionReason: "<text>" ...'`.
 *
 * The fragment is the single editable surface for the deny message. The
 * caller (claude.js hook installers) JSON-stringifies via this helper so
 * embedded backticks / quotes / newlines round-trip safely through the
 * shell wrapper.
 */
export function loadHookDenyMessage(name, agent = null) {
  // Hook deny fragments are loaded at hook-install time, so they pick up
  // env-only locale signals (`BL_LOCALE` / `LC_ALL` / `LANG`). No config
  // surface — hooks are written once per `bl` invocation that re-installs
  // them, and a runtime locale change does not rewrite installed hooks.
  const text = readFragment(name, resolveLocale(null), agent).trim();
  if (!text) {
    throw new Error(`hook deny fragment '${name}' not found or empty`);
  }
  return text;
}

/**
 * Render a shared prompt fragment (`prompts/_<name>.md`) against `vars`,
 * trailing newlines trimmed. `loadPrompt` uses it for partials a template
 * names by slot (`{{blockedByBug}}`), so the fragment sees the same session
 * variables as the prompt around it. Missing fragments render as "".
 */
export function renderFragment(name, vars, locale = null, agent = null) {
  return interpolate(readFragment(name, locale, agent), vars).replace(/\n+$/, '');
}
