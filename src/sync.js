/**
 * sync.js — bring the backlog up to date with origin, and commit and push
 * (F-79 D1).
 *
 * `bl sync` writes no derived list: every table is rendered when read
 * (`render.js`). What is left:
 *
 *   - `pullBeforeCommand`: rebase onto `origin/main` before a command, settle
 *     an interrupted `bl new --feature`, regenerate `allowed-tools.json` after
 *     a pull, and push a `main` still ahead.
 *   - `syncAndCommit`: under the backlog lock, format the changed Markdown
 *     files among the paths it is given, then commit exactly those paths and
 *     push.
 *   - `bl sync` with no `--commit` pulls and pushes (`bl.js` runs
 *     `pullBeforeCommand` for it) and writes nothing.
 */

import { existsSync, rmSync, statSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { spawnSync } from 'child_process';
import {
  loadConfig,
  configForRepo,
  parsePluginCascade,
  bucketByPlugin,
  runPluginBatch,
  info,
  warn,
  normalizeId,
  STORIES_DIR,
  COMPONENTS_DIR,
  THEMES_DIR,
  EPICS_DIR,
  agentFlagOf,
} from './config.js';
import { acquireLock, releaseLock } from './lock.js';
import {
  commitPaths,
  dirtySnapshot,
  hasOriginRemote,
  markRegenerationPending,
  parsePorcelainZ,
  pathsChangedSince,
  PULL_REGEN_PENDING,
  pullBacklog,
  pushIfAhead,
  pushWarning,
  reportBacklogPull,
} from './backlog-commit.js';
import { ensureAllowedTools } from './allowed-tools.js';
import { findStoryDir } from './story.js';
import { FEATURES_DIR } from './feature.js';

/**
 * Run the configured `format` plugin over the Markdown files in
 * `touchedMarkdown` (absolute paths). Backlog-scoped (no story context). The
 * plugin registered for `.md` under `language_dispatch.format` runs; absence
 * is a silent skip (a fresh `bl init` may not have picked a Markdown
 * formatter).
 *
 * The backlog-root cascade is consulted purely for opt-out: a top-level
 * `plugins-format: -md` in `<backlogRoot>/index.md` suppresses the pass.
 * Defaults run otherwise — gating on the cascade as an *include* list (the
 * earlier model) made the pass dead in any setup that didn't redundantly
 * declare `plugins-format: md`.
 */
export function formatBacklogMarkdown(config, touchedMarkdown) {
  const dispatch = config.languageDispatch ?? {};
  const formatMap = dispatch.format ?? {};
  const mdPlugins = formatMap['.md'];
  if (!mdPlugins) return;
  const pluginNames = Array.isArray(mdPlugins) ? mdPlugins : [mdPlugins];

  const { removes } = parsePluginCascade('format', {
    backlogRoot: config.backlogRoot,
  });
  const activePluginNames = pluginNames.filter((name) => !removes.includes(name) && config.plugins[name]?.format);
  if (activePluginNames.length === 0) return;

  // A file in the backlog goes by its backlog-relative path; one outside it
  // (a `bl report --out` page) by its absolute path, so it is formatted too.
  const files = [...touchedMarkdown]
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .map((path) => {
      const rel = relative(config.backlogRoot, path);
      return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
    });
  if (files.length === 0) return;

  // Bucket by plugin so the pass uses the same dispatch semantics as
  // bl format / bl lint, but only over the files it was given.
  const buckets = bucketByPlugin(files, 'format', { format: { '.md': activePluginNames } }, config.plugins);
  for (const [name, paths] of buckets) {
    runPluginBatch(name, config.plugins[name].format, paths, { roostDir: config.roostDir }, config.backlogRoot);
  }
}

/**
 * Keep the paths git can stage: those on disk, plus vanished ones git still
 * tracks (the source side of a migration), in the index or in HEAD. The
 * source of a `git mv` is already gone from the index, so `--with-tree=HEAD`
 * keeps it; without it the commit would leave the old files in the tree. A
 * migrated directory that was never committed has nothing to stage, and
 * naming it would fail the pathspec.
 */
function stageablePaths(root, paths) {
  return paths.filter((p) => {
    if (existsSync(join(root, p))) return true;
    const r = spawnSync('git', ['ls-files', '--with-tree=HEAD', '--', p], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 && r.stdout.trim() !== '';
  });
}

/**
 * Why `p` is not an exact backlog-relative path for `--path`, or null when it
 * is. `--path` is operator input that reaches `git add` and `git commit
 * --only` as a pathspec, so anything wider than one named file or directory
 * (the root, a whole unit directory such as `stories/`, a glob,
 * a git magic pathspec, a path that climbs out of the backlog) would sweep
 * unrelated work into the commit.
 *
 * @param {string} p
 * @returns {string | null}
 */
export function extraPathProblem(p) {
  if (p === '') return 'is empty';
  if (p.startsWith(':')) return 'is a git pathspec, not a path';
  if (/[*?[\]\\]/.test(p)) return 'contains glob characters';
  if (p.startsWith('/')) return 'is absolute, not backlog-relative';
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'is not a normalized relative path';
  }
  if (segments[0] === '.git') return 'is inside .git/';
  // Each top-level unit directory holds every story, component, feature,
  // theme or epic beside the one the operator means.
  const whole = [STORIES_DIR, COMPONENTS_DIR, FEATURES_DIR, THEMES_DIR, EPICS_DIR];
  if (whole.some((d) => d === p || d.startsWith(`${p}/`))) {
    return 'names a whole unit directory, or more';
  }
  return null;
}

/**
 * Rebase the backlog onto `origin/main` before a command (F-50 D4; see
 * `backlog-commit.js` `pullBacklog`), under the backlog lock so no other `bl`
 * process commits mid-rebase. A pull that brought anything is followed by a
 * regeneration of `allowed-tools.json`, whose inputs a pulled `backlog.json`
 * may have changed without touching the file, committed and pushed when it
 * changed the file, so two clones never need a human for it. Pull failures
 * are warnings; the command goes on from local state, unless the pull is
 * `unsafe`. A regeneration that cannot be built or committed is `unsafe` too:
 * it is left pending (`PULL_REGEN_PENDING`) and the next command that pulls
 * finishes it before it runs, pulled or not. A push that fails after the
 * commit is only a warning (`commitPaths`). An interrupted `bl new --feature`
 * is settled after the pull and before the regeneration (`feature-links.js`
 * `settlePending`). After a pull that ended `pulled` or `current` and made no
 * regeneration commit (whose own push carries `main`), a `main` still ahead
 * of `origin/main` is pushed (`pushIfAhead`, F-74 D1); a failed push is a
 * warning (`pushWarning`).
 *
 * @param {object} config
 * @returns {Promise<import("./backlog-commit.js").BacklogPull>}
 */
export async function pullBeforeCommand(config) {
  const root = config.backlogRoot;
  // Nothing to pull: leave the lock to the command, whose first wait for it
  // is then the one it announces.
  if (!hasOriginRemote(root)) return { state: 'no-remote' };
  await acquireLock(root);
  try {
    const res = pullBacklog(root);
    reportBacklogPull(res, root);
    const pendingPath = join(root, PULL_REGEN_PENDING);
    const pending = existsSync(pendingPath);
    let committed = false;
    if (res.state === 'pulled' || (pending && res.state !== 'unsafe' && res.state !== 'not-main')) {
      // Settle an interrupted `bl new --feature` first, so its half-made
      // links are not committed with the regeneration.
      const { settlePending } = await import('./feature-links.js');
      await settlePending(root);
      const regen = await regenerateAfterPull(root, config, pendingPath);
      if (regen.problem) {
        process.stderr.write(
          `error: the backlog regeneration after the pull did not finish (${regen.problem}); not running the command. The next bl command that pulls retries it.\n`,
        );
        return { ...res, state: 'unsafe', message: regen.problem };
      }
      committed = regen.committed;
    }
    if ((res.state === 'pulled' || res.state === 'current') && !committed) {
      const p = pushIfAhead(root);
      if (p?.state === 'lock-timeout') {
        warn(
          `backlog push timed out waiting for ${p.lockPath} (PID ${p.holder}); the next bl command that pulls pushes it`,
        );
      } else if (p && !p.pushed) {
        warn(pushWarning(root, p));
      }
    }
    return res;
  } finally {
    releaseLock(root);
  }
}

/**
 * Rebuild `allowed-tools.json` for the pulled backlog and commit what that
 * changed since the regeneration began (`pendingPath` holds that snapshot
 * while it is unfinished). `problem` is what failed, if anything;
 * `committed` says whether a regeneration commit was made (its push carried
 * `main`). When that push's retry settled generated paths, the regeneration
 * stays pending for the next command (`pushBacklog`).
 * @returns {Promise<{ problem?: string, committed?: boolean }>}
 */
async function regenerateAfterPull(root, config, pendingPath) {
  let before;
  try {
    before = markRegenerationPending(root);
    if (!before) return { problem: 'git status failed' };
    // The pull may have brought a new backlog.json.
    const flag = agentFlagOf(config);
    const fresh = configForRepo(
      loadConfig({
        backlogRoot: root,
        agent: flag.agent ?? undefined,
        agentRole: flag.role,
        lenientAgents: flag.lenient,
      }),
      config.repoName,
    );
    // A no-op when the file is current for the pulled configuration.
    ensureAllowedTools(root, fresh);
  } catch (err) {
    return { problem: err.message };
  }
  const after = dirtySnapshot(root);
  if (!after) return { problem: 'git status failed' };
  const touched = pathsChangedSince(before, after).filter((p) => p !== PULL_REGEN_PENDING);
  if (touched.length === 0) {
    rmSync(pendingPath, { force: true });
    return { committed: false };
  }
  const c = commitPaths(root, touched, 'chore: regenerate allowed-tools.json after pull');
  if (!c.committed) return { problem: `commit failed: ${c.error ?? 'nothing to commit'}` };
  if (!c.pushResolved) rmSync(pendingPath, { force: true });
  return { committed: true };
}

/**
 * `bl sync --commit`: under one lock hold, format the changed Markdown files
 * among (each story's directory) ∪ `extraPaths` (`formatBacklogMarkdown`),
 * then commit exactly those paths and push. Never stages the whole backlog,
 * so an unrelated dirty story file, including one another agent edits while
 * this holds the lock, stays out of the commit. `bl done`, `bl new` and
 * `bl merge` commit through this too, holding the lock across their own
 * writes.
 *
 * When the backlog is not a git work tree, nothing is formatted or
 * committed, and the result carries `notRepo: true`.
 *
 * @param {object} config
 * @param {{ message: string, storyIds?: string[], extraPaths?: string[] }} opts
 *   `extraPaths` are backlog-relative paths the caller wrote or moved itself
 *   (a new component dir, an appended feature file).
 * @returns {Promise<{ committed: boolean, paths: string[], error?: string,
 *   notRepo?: boolean }>}
 */
export async function syncAndCommit(config, { message, storyIds = [], extraPaths = [] }) {
  const root = config.backlogRoot;
  await acquireLock(root);
  try {
    const storyDirs = storyIds.map((raw) => {
      const parsed = normalizeId(raw);
      const found = parsed && findStoryDir(parsed, config);
      if (!found) throw new Error(`Story ${raw} not found in backlog`);
      return relative(root, found.storyDir);
    });
    const named = [...new Set([...storyDirs, ...extraPaths])];
    const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') {
      return { committed: false, paths: named.sort(), notRepo: true };
    }
    const paths = stageablePaths(root, named).sort();
    if (paths.length === 0) return { committed: false, paths };
    const status = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (status.status !== 0) {
      return {
        committed: false,
        paths,
        error: (status.stderr || '').trim() || 'git status failed',
      };
    }
    if (status.stdout === '') return { committed: false, paths };
    // A deleted file is not on disk, so the format pass skips it.
    const changed = parsePorcelainZ(status.stdout).filter((p) => p.endsWith('.md'));
    formatBacklogMarkdown(config, new Set(changed.map((p) => join(root, p))));
    return commitPaths(root, paths, message);
  } finally {
    releaseLock(root);
  }
}

/**
 * Report a `syncAndCommit` result for a command that commits its own backlog
 * changes (`bl done`, `bl new`, `bl merge`). Everything goes to stderr, so
 * a command's stdout contract is untouched. A failed commit exits 1 and names
 * the paths to commit by hand; the on-disk changes stay in place.
 *
 * @param {{ committed: boolean, paths: string[], error?: string,
 *   notRepo?: boolean }} res
 * @param {string} command  e.g. "bl done", for the error prefix
 * @param {{ nothing?: string }} [opts]  line to print when nothing changed
 */
export function reportBacklogCommit(res, command, { nothing = 'Nothing to commit.' } = {}) {
  if (res.notRepo) {
    info('Backlog is not a git repository; skipping commit.');
    return;
  }
  if (res.error) {
    console.error(`${command}: backlog commit failed: ${res.error}`);
    console.error('Commit these backlog paths by hand:');
    for (const p of res.paths) console.error(`  ${p}`);
    process.exit(1);
  }
  info(res.committed ? `Committed ${res.paths.length} backlog path(s).` : nothing);
}

/** Print a `syncAndCommit` error the way `bl sync` does, then exit 1. */
export function exitOnSyncError(err) {
  console.error(err.message);
  process.exit(1);
}

/**
 * Parse `bl sync` flags. `--story`, `--path` and `-m`/`--message` repeat.
 * Repeated `-m` values are joined in order as paragraphs (one blank line
 * between them), the way `git commit -m a -m b` does: the first is the
 * subject, the rest form the body. Empty or whitespace-only values are
 * dropped; `message` is null when none remain, while `messageGiven` stays
 * true, so `bl sync -m ""` without `--commit` is still a usage error.
 */
export function parseSyncArgs(argv) {
  const args = {
    commit: false,
    message: null,
    messageGiven: false,
    storyIds: [],
    paths: [],
    help: false,
  };
  const messages = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq !== -1 ? a.slice(eq + 1) : null;
    const value = () => {
      if (inline != null) return inline;
      const next = argv[i + 1];
      // An option token where a value should be means the value was dropped
      // (`-m --story S-1`): fail instead of taking `--story` as the message.
      // A lone `-` is an ordinary value; `--flag=-x` returned above.
      if (next === undefined || (next.startsWith('-') && next !== '-')) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (name === '--help' || name === '-h') args.help = true;
    else if (name === '--commit') args.commit = true;
    else if (name === '-m' || name === '--message') messages.push(value());
    else if (name === '--story') args.storyIds.push(value());
    else if (name === '--path') args.paths.push(value());
    else throw new Error(`Unknown argument: ${a}`);
  }
  const kept = messages.filter((m) => m.trim() !== '');
  args.message = kept.length > 0 ? kept.join('\n\n') : null;
  args.messageGiven = messages.length > 0;
  return args;
}

const USAGE = `Usage: bl sync [--commit -m <message> (--story <id> | --path <backlog-relative>) …]

Brings the backlog up to date with origin and pushes it: rebases main onto
origin/main, then pushes a main that is still ahead. Writes no index or table:
bl renders those when they are read (bl view, bl report). With no origin
remote it does nothing.

Options:
  --commit          After the pull, commit to the backlog repo and push, under
                    the backlog lockfile (.bl-new.lock). Formats the changed
                    Markdown files among the named paths, then stages and
                    commits only each --story directory and each --path, never
                    the whole backlog. Exits 0 without a commit when nothing
                    changed.
  -m, --message     Commit message (required with --commit). Repeatable, as
                    with git commit: the first is the subject and each later
                    one becomes a body paragraph (blank line between). Empty
                    values are dropped. Put the why/how of the change here,
                    not in story frontmatter. A value that begins with - (other
                    than a lone -) is read as a missing value; give it inline
                    as --message=<v> (likewise --story=<v> and --path=<v>).
  --story <id>      A story you created or edited; its whole directory is
                    staged. Repeat for each story (with --commit, at least one
                    --story or --path).
  --path <path>     A backlog-relative path you wrote or moved yourself (both
                    ends of a git mv, say); it is staged with the commit. Must
                    name one exact file or directory (no root, whole stories/,
                    components/, features/, themes/ or epics/, glob or ..) that
                    is on disk or tracked by git. Repeatable; only with
                    --commit.`;

export async function main(argv) {
  let args;
  try {
    args = parseSyncArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.commit && (args.messageGiven || args.storyIds.length > 0 || args.paths.length > 0)) {
    console.error('-m, --story and --path only apply with --commit.');
    process.exit(2);
  }
  // A feature file has no story to name, so one --path scopes a commit too.
  if (args.commit && (!args.message || (args.storyIds.length === 0 && args.paths.length === 0))) {
    console.error('--commit needs -m <message> and at least one --story <id> or --path <path>.');
    process.exit(2);
  }

  // `bl.js` has already pulled and pushed (`commandPullsBacklog`); a bare
  // `bl sync` has nothing more to do.
  const config = loadConfig();
  if (!args.commit) return;
  // A `--path` is operator input: it must name one exact file or directory
  // (see `extraPathProblem`), and one that is neither on disk nor known to
  // git is a typo that `syncAndCommit` would drop without a word.
  for (const p of args.paths) {
    const problem = extraPathProblem(p);
    if (problem) {
      console.error(`--path "${p}" ${problem}; name one exact backlog-relative file or directory.`);
      process.exit(2);
    }
  }
  const unknown = args.paths.filter((p) => stageablePaths(config.backlogRoot, [p]).length === 0);
  if (unknown.length > 0) {
    console.error(`--path matches nothing in the backlog (not on disk, not tracked by git): ${unknown.join(', ')}`);
    process.exit(2);
  }
  let res;
  try {
    res = await syncAndCommit(config, {
      message: args.message,
      storyIds: args.storyIds,
      extraPaths: args.paths,
    });
  } catch (err) {
    exitOnSyncError(err);
  }
  if (res.notRepo) {
    console.error(`bl sync --commit: ${config.backlogRoot} is not a git repository.`);
    process.exit(1);
  }
  if (res.error) {
    console.error(`bl sync --commit: ${res.error}`);
    process.exit(1);
  }
  info(res.committed ? `Committed ${res.paths.length} backlog path(s).` : 'Nothing to commit.');
}
