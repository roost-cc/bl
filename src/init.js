/**
 * init.js — initialization helper for the backlog repo.
 *
 * The backlog repo itself is created by hand (one per workspace).
 * This command sets up the agent and the backlog's local files for it.
 *
 *   bl init [--agent <id>]
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadConfig,
  parseArgs,
  info,
  sameConfiguration,
  CODING_DICTIONARY_FILE,
  DEFAULT_BACKLOG_TITLE,
  serializeFrontmatter,
  EFFORT_KEYS,
} from './config.js';
import { LOCAL_TOOLS_FILE } from './permissions.js';
import { FLOW_FILE } from './flow.js';
import { ROADMAP_FILE } from './roadmap.js';
import { PRIORITY_FILE } from './priority.js';
import { atomicWriteFile, STAGING_DIR } from './atomic-write.js';
import { getProvider, PROVIDER_NAMES } from './agents/index.js';
import { probePluginBinaries, formatPluginStatus } from './plugin-binaries.js';
import { commitChangedSince, dirtySnapshot, recordChangedSince } from './backlog-commit.js';
import { acquireLock, releaseLock, LOCK_FILE } from './lock.js';
import { detectGhCredentialHelper, formatGhCredentialHelperAdvisory } from './credential-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `bl init`'s commit message, and the owner of its failed-commit record. */
const INIT_COMMIT_MESSAGE = 'chore: bl init';

/**
 * The directory `bl init` treats as the backlog root: `$BL_BACKLOG_DIR`, else
 * the current directory. `bl.js` pulls it before `bl init` writes, when
 * `loadConfig` rejects the `backlog.json` there (S-1330).
 */
export function initBacklogDir() {
  return process.env.BL_BACKLOG_DIR || process.cwd();
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl init [options]

Options:
  -A, --agent <id>     Agent provider to initialize
  --help               Show this help

Registers the backlog repo in your global agent settings so agents can
commit and push backlog changes from any cwd, and creates allowed-tools.json,
flow.json (the statuses and gates per type), roadmap.md, priority.md and
coding-dictionary.yaml (bl's seed of software-engineering terms) from
their templates, and the root index.md (the "title" and a heading of it),
when the backlog has none; an existing one is left as it is. A new
backlog.json (in $BL_BACKLOG_DIR, else the current directory), one with no
"repos", gets an empty one, the display name "title": "Backlog", the worktree root
"worktrees": "../worktrees", the dictionary list "dictionaries":
["coding-dictionary.yaml"] (the prompts name each listed file), the effort
levels "effort": { "refine": "high", "review": "high", "default": "high" },
and, unless it
has them, the configuration lists "agent", [{ "agent": "<-A, else claude>" }],
and "review_agent", [{ "agent": "<the first other headless agent>" }]: the
reviewer is never the implementer. A backlog.json that has "repos" keeps
its settings and gets only the effort levels, unless it has them. Repos are
registered by hand in
backlog.json "repos"; themes are created with bl new --theme. When the backlog
is a git repo, bl init commits and pushes the files it wrote ("chore: bl
init"); edits you made before it stay uncommitted.`);
    process.exit(0);
  }

  // `ensureReposBlock` treats this directory as the backlog root. The
  // snapshot keeps edits made before `bl init` out of its commit (S-1330).
  const backlogDir = initBacklogDir();
  // The backlog lock is held from the first write through the commit, so no
  // other bl command commits what init wrote first.
  await acquireLock(backlogDir);
  let config;
  let commitFailed;
  let before;
  try {
    before = dirtySnapshot(backlogDir);
    ensureReposBlock(backlogDir, args.agent);
    config = loadConfig({ agent: args.agent });
    const provider = getProvider(config.agent);

    info(`Initializing agent: ${config.agent}...`);
    await provider.init(config.backlogRoot, config);
    ensureGitignored(config.backlogRoot);
    warnIfGhCredentialHelper();

    copySeed(config.backlogRoot, 'allowed-tools.json');
    ensureFlowFile(config.backlogRoot);
    ensureBacklogDocs(config.backlogRoot);
    ensureRootIndex(config);
    commitFailed = commitChangedSince(config.backlogRoot, before, INIT_COMMIT_MESSAGE);
  } catch (e) {
    // A step failed after others wrote: the next `bl init` commits what this
    // one wrote with its own writes (S-1330).
    recordChangedSince(config?.backlogRoot ?? backlogDir, before ?? null, INIT_COMMIT_MESSAGE);
    throw e;
  } finally {
    releaseLock(backlogDir);
  }

  // The plugin-tools readout goes last: the setup checklist.
  printPluginStatus(config);
  if (commitFailed) process.exit(1);
}

/**
 * Give a new backlog its `flow.json` (F-66 D1), the statuses and gates per
 * type that `bl validate` reads, from the template. An existing one is the
 * operator's and is left alone.
 */
export function ensureFlowFile(backlogRoot) {
  copySeed(backlogRoot, FLOW_FILE);
}

/**
 * Give a new backlog the two hand-edited documents `bl validate` requires,
 * `roadmap.md` (F-53 D2) and `priority.md` (F-78 D1), each from its
 * template with an empty list (S-581), and the coding dictionary seed
 * (F-82 D2), which the project then curates. An existing one is left alone.
 */
export function ensureBacklogDocs(backlogRoot) {
  for (const file of [ROADMAP_FILE, PRIORITY_FILE, CODING_DICTIONARY_FILE]) copySeed(backlogRoot, file);
}

/**
 * Give a new backlog its root `index.md` (F-79 D3): frontmatter `title` and
 * a `# <title>` heading from `backlog.json` `title`, and no tables, which
 * `bl report` and `bl view` render when the page is read. An existing one is
 * hand-written and left alone.
 */
export function ensureRootIndex(config) {
  const text = `${serializeFrontmatter({ title: config.title })}\n# ${config.title}\n`;
  writeSeed(config.backlogRoot, 'index.md', text, 'Created : index.md');
}

/** Copy `templates/<file>` into the backlog `dir` unless `dir` has the file (`writeSeed`). */
function copySeed(dir, file) {
  writeSeed(dir, file, readFileSync(join(__dirname, '..', 'templates', file)), `Created : ${file} (from template)`);
}

/**
 * Write `text` to `<dir>/<file>` unless `dir` has the file, and say `done`.
 * The write is whole or absent: it is staged in
 * `.bl/tmp/` and linked into place (`atomicWriteFile`, exclusive), so a
 * failed write leaves no partial file that a rerun would keep, and a file
 * another process makes meanwhile is kept, not overwritten.
 */
function writeSeed(dir, file, text, done) {
  const path = join(dir, file);
  if (existsSync(path)) return;
  try {
    atomicWriteFile(dir, path, text, { exclusive: true });
  } catch (e) {
    // Made by another process since the check: theirs stays. A link to
    // nothing is not a file, so it fails.
    if (e.code === 'EEXIST' && existsSync(path)) return;
    throw e;
  }
  info(done);
}

/** A new backlog's worktree root: beside the backlog, `<parent>/worktrees`. */
const NEW_WORKTREE_ROOT = '../worktrees';

/** A new backlog's agent when `bl init` is given no -A. */
const NEW_AGENT = 'claude';

/** A new backlog's effort levels (F-85 D2): `high`, the level before F-85, for each. */
const NEW_EFFORT = Object.fromEntries(EFFORT_KEYS.map((k) => [k, 'high']));

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
 * requires (F-60 D1), unless it names one, the dictionary list naming the
 * coding dictionary (F-82 D3), unless it has one, the effort levels
 * (F-85 D2), unless it has them, and the two configuration lists
 * it requires (F-64 D2), unless it has them, each independent of the other
 * (`initConfigurationLists`), with no model. When it adds the dictionary
 * list it copies the seed first, so a failed copy leaves backlog.json as it
 * was and a rerun tries again. A
 * file that has `repos` keeps its settings: it gets only the effort levels,
 * which `loadConfig` requires, unless it has them. A file with the pre-F-51
 * `projects` that `loadConfig` refuses with the migration's name, or one that
 * is not a JSON object, is left alone. The write is atomic: a
 * failed one leaves the file as it was, and a successful one keeps its mode
 * and owner and, through a symlink, replaces the file the link names. If
 * another caller edits the file after bl reads it, bl keeps that edit: the
 * write fails (`unchanged`), and bl reads the file again and retries, up to
 * `CONFIG_WRITE_ATTEMPTS` times.
 */
export function ensureReposBlock(dir, agent = null) {
  const path = join(dir, 'backlog.json');
  if (!existsSync(path)) return;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return addToBacklogJson(dir, path, agent);
    } catch (e) {
      if (e.code !== 'ECHANGED' || attempt === CONFIG_WRITE_ATTEMPTS) throw e;
    }
  }
}

/** Reads of `backlog.json` `ensureReposBlock` makes before a concurrent edit fails `bl init`. */
export const CONFIG_WRITE_ATTEMPTS = 5;

/** One read and write of `ensureReposBlock`; the write fails with ECHANGED if the file changed after the read. */
function addToBacklogJson(dir, path, agent) {
  const text = readFileSync(path, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  if (Object.hasOwn(raw, 'projects')) return;
  if (Object.hasOwn(raw, 'repos')) {
    // An existing backlog keeps its settings, but `loadConfig` now requires
    // the effort levels (F-85 D2), so it gets them unless it has them.
    if (Object.hasOwn(raw, 'effort')) return;
    atomicWriteFile(dir, path, JSON.stringify({ ...raw, effort: NEW_EFFORT }, null, 2) + '\n', {
      preserve: true,
      unchanged: text,
    });
    info(`Updated : backlog.json (+ "effort": ${JSON.stringify(NEW_EFFORT)})`);
    return;
  }
  const added = {};
  if (!Object.hasOwn(raw, 'title')) added.title = DEFAULT_BACKLOG_TITLE;
  if (!Object.hasOwn(raw, 'worktrees')) added.worktrees = NEW_WORKTREE_ROOT;
  if (!Object.hasOwn(raw, 'dictionaries')) added.dictionaries = [CODING_DICTIONARY_FILE];
  if (!Object.hasOwn(raw, 'effort')) added.effort = NEW_EFFORT;
  Object.assign(added, initConfigurationLists(raw, agent));
  // The seed first: if its copy fails, backlog.json does not list a missing file.
  if (added.dictionaries) copySeed(dir, CODING_DICTIONARY_FILE);
  atomicWriteFile(dir, path, JSON.stringify({ ...raw, ...added, repos: {} }, null, 2) + '\n', {
    preserve: true,
    unchanged: text,
  });
  const keys = [...Object.entries(added).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`), '"repos": {}'];
  info(`Updated : backlog.json (+ ${keys.join(', ')})`);
}

// The local tool-grant file holds user-discretion permissions, and `.bl/`
// holds bl's runtime state (the activity log, staging files, run state), and
// the backlog lock file exists only while a bl command holds it: none is ever
// committed. Seed the backlog's .gitignore with them on init (idempotent).
const GITIGNORED = [LOCAL_TOOLS_FILE, `${dirname(STAGING_DIR)}/`, LOCK_FILE];

function ensureGitignored(backlogRoot) {
  const gitignorePath = join(backlogRoot, '.gitignore');
  const text = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = text.split('\n');
  const missing = GITIGNORED.filter((entry) => !lines.some((l) => l.trim() === entry));
  if (missing.length === 0) return;
  const needsNewline = text !== '' && !text.endsWith('\n');
  writeFileSync(gitignorePath, text + (needsNewline ? '\n' : '') + missing.map((m) => `${m}\n`).join(''));
  info(`Updated : .gitignore (+ ${missing.join(', ')})`);
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
