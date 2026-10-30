/**
 * init.js — initialization helper for the backlog repo.
 *
 * The backlog repo itself is created by hand (one per workspace).
 * This command sets up the agent and the backlog's local files for it.
 *
 *   bl init [--agent <id>]
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, parseArgs, info, sameConfiguration, DEFAULT_BACKLOG_TITLE } from './config.js';
import { LOCAL_TOOLS_FILE } from './permissions.js';
import { FLOW_FILE } from './flow.js';
import { ROADMAP_FILE } from './roadmap.js';
import { FEATURE_ORDER_FILE } from './feature-order.js';
import { atomicWriteFile } from './atomic-write.js';
import { getProvider, PROVIDER_NAMES } from './agents/index.js';
import { probePluginBinaries, formatPluginStatus } from './plugin-binaries.js';
import { detectGhCredentialHelper, formatGhCredentialHelperAdvisory } from './credential-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl init [options]

Options:
  -A, --agent <id>     Agent provider to initialize
  --help               Show this help

Registers the backlog repo in your global agent settings so agents can
commit and push backlog changes from any cwd, and creates allowed-tools.json,
flow.json (the statuses and gates per type), roadmap.md and feature-order.md
from their templates when the backlog has none. A new backlog.json (in
$BL_BACKLOG_DIR, else the current directory), one with no "repos", gets
an empty one, the display name "title": "Backlog" (bl sync heads index.md
with it), the worktree root "worktrees": "../worktrees", and, unless it
has them, the configuration lists "agent", [{ "agent": "<-A, else claude>" }],
and "review_agent", [{ "agent": "<the first other headless agent>" }]: the
reviewer is never the implementer. Repos are registered by hand in
backlog.json "repos"; themes are created with bl new --theme.`);
    process.exit(0);
  }

  ensureReposBlock(process.env.BL_BACKLOG_DIR || process.cwd(), args.agent);
  const config = loadConfig({ agent: args.agent });
  const provider = getProvider(config.agent);

  info(`Initializing agent: ${config.agent}...`);
  await provider.init(config.backlogRoot, config);
  ensureLocalToolsGitignored(config.backlogRoot);
  warnIfGhCredentialHelper();

  const toolsPath = join(config.backlogRoot, 'allowed-tools.json');
  if (!existsSync(toolsPath)) {
    const templatePath = join(__dirname, '..', 'templates', 'allowed-tools.json');
    copyFileSync(templatePath, toolsPath);
    info(`Created : allowed-tools.json (from template)`);
  }
  ensureFlowFile(config.backlogRoot);
  ensureBacklogDocs(config.backlogRoot);

  // The plugin-tools readout goes last: the setup checklist.
  printPluginStatus(config);
}

/**
 * Give a new backlog its `flow.json` (F-66 D1), the statuses and gates per
 * type that `bl validate` reads, from the template. An existing one is the
 * operator's and is left alone.
 */
export function ensureFlowFile(backlogRoot) {
  const flowPath = join(backlogRoot, FLOW_FILE);
  if (existsSync(flowPath)) return;
  copyFileSync(join(__dirname, '..', 'templates', FLOW_FILE), flowPath);
  info(`Created : ${FLOW_FILE} (from template)`);
}

/**
 * Give a new backlog the two hand-edited documents `bl validate` requires,
 * `roadmap.md` (F-53 D2) and `feature-order.md` (F-53 D1), each from its
 * template with an empty list (S-581). An existing one is left alone.
 */
export function ensureBacklogDocs(backlogRoot) {
  for (const file of [ROADMAP_FILE, FEATURE_ORDER_FILE]) {
    const path = join(backlogRoot, file);
    if (existsSync(path)) continue;
    copyFileSync(join(__dirname, '..', 'templates', file), path);
    info(`Created : ${file} (from template)`);
  }
}

/** A new backlog's worktree root: beside the backlog, `<parent>/worktrees`. */
const NEW_WORKTREE_ROOT = '../worktrees';

/** A new backlog's agent when `bl init` is given no -A. */
const NEW_AGENT = 'claude';

/** A role's list as backlog.json has it, provider names lowercased; [] for none. */
function roleList(value) {
  if (typeof value === 'string') return [{ agent: value.toLowerCase() }];
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => typeof c?.agent === 'string')
    .map((c) => ({ agent: c.agent.toLowerCase(), model: c.model ?? null }));
}

/**
 * A model-less configuration for the role init fills, independent of the
 * paired role's list `others` (F-64 D4, the reviewer is never the
 * implementer): the first headless agent of `preferred`, then of the
 * registered ones, that `others` does not use at all, else the first whose
 * model-less configuration no entry of `others` equals, so `bl run` can
 * start; with none, `preferred[0]`, else the first of `others`, which
 * `bl run` refuses at start, naming it.
 */
function independentConfiguration(others, preferred = []) {
  const names = [...new Set([...preferred, ...PROVIDER_NAMES])].filter((p) => getProvider(p).supportsHeadless());
  const agent =
    names.find((p) => !others.some((c) => c.agent === p)) ??
    names.find((p) => !others.some((c) => sameConfiguration(c, { agent: p }))) ??
    preferred[0] ??
    others[0]?.agent ??
    NEW_AGENT;
  return { agent };
}

/**
 * The lists `bl init` adds to backlog.json `raw` (F-64 D2): `agent`,
 * unless it has one, as -A (`agent`), else claude or, when the retained
 * reviewers use it, the first headless agent they do not; `review_agent`,
 * unless it has one, independent of the implementers it has or gets and of
 * -A (`independentConfiguration`).
 *
 * @param {object} raw
 * @param {string|null} [agent]
 * @returns {{ agent?: {agent: string}[], review_agent?: {agent: string}[] }}
 */
export function initConfigurationLists(raw, agent = null) {
  const flag = agent ? [{ agent: agent.toLowerCase() }] : [];
  const added = {};
  if (!Object.hasOwn(raw, 'agent'))
    added.agent = flag.length ? flag : [independentConfiguration(roleList(raw.review_agent), [NEW_AGENT])];
  const implementers = [...(added.agent ?? roleList(raw.agent)), ...flag];
  if (!Object.hasOwn(raw, 'review_agent')) added.review_agent = [independentConfiguration(implementers)];
  return added;
}

/**
 * Give a new backlog's `backlog.json` (in `dir`) an empty `repos` block, the
 * key bl finds a backlog by (F-51 D5), the worktree root `loadConfig`
 * requires (F-60 D1), unless it names one, and the two configuration lists
 * it requires (F-64 D2), unless it has them, each independent of the other
 * (`initConfigurationLists`), with no model. A
 * file that has `repos`, or the pre-F-51
 * `projects` that `loadConfig` refuses with the migration's name, is left
 * alone: an existing backlog's settings are its own. The write is atomic: a
 * failed one leaves the file as it was, and a successful one keeps its mode
 * and owner and, through a symlink, replaces the file the link names.
 */
export function ensureReposBlock(dir, agent = null) {
  const path = join(dir, 'backlog.json');
  if (!existsSync(path)) return;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  if (Object.hasOwn(raw, 'repos') || Object.hasOwn(raw, 'projects')) return;
  const added = {};
  if (!Object.hasOwn(raw, 'title')) added.title = DEFAULT_BACKLOG_TITLE;
  if (!Object.hasOwn(raw, 'worktrees')) added.worktrees = NEW_WORKTREE_ROOT;
  Object.assign(added, initConfigurationLists(raw, agent));
  atomicWriteFile(dir, path, JSON.stringify({ ...raw, ...added, repos: {} }, null, 2) + '\n', { preserve: true });
  const keys = [...Object.entries(added).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`), '"repos": {}'];
  info(`Updated : backlog.json (+ ${keys.join(', ')})`);
}

// The local tool-grant file holds user-discretion permissions and must never
// be committed. Seed the backlog's .gitignore with it on init (idempotent).
function ensureLocalToolsGitignored(backlogRoot) {
  const gitignorePath = join(backlogRoot, '.gitignore');
  let lines = [];
  if (existsSync(gitignorePath)) {
    lines = readFileSync(gitignorePath, 'utf8').split('\n');
    if (lines.some((l) => l.trim() === LOCAL_TOOLS_FILE)) return;
  }
  const needsNewline = lines.length > 0 && lines[lines.length - 1] !== '';
  const addition = (needsNewline ? '\n' : '') + LOCAL_TOOLS_FILE + '\n';
  writeFileSync(gitignorePath, (existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '') + addition);
  info(`Updated : .gitignore (+ ${LOCAL_TOOLS_FILE})`);
}

function warnIfGhCredentialHelper() {
  const advisory = formatGhCredentialHelperAdvisory(detectGhCredentialHelper());
  if (advisory) info(advisory);
}

function printPluginStatus(config) {
  const probed = probePluginBinaries(config);
  const block = formatPluginStatus(probed);
  if (!block) return;
  info('');
  // Write the formatted block directly so its internal newlines are
  // preserved (info() splits on whitespace via join(" ")).
  process.stderr.write(block);
}
