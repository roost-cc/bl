/**
 * migration-txn.js — the all-or-nothing apply of a one-off backlog
 * migration (F-49's taxonomy and F-51's value-axis migrations had it; F-62
 * removed both once they had run).
 *
 * The guarantee comes from git, not from bookkeeping (F-51 decision R2).
 * `applyMigration` refuses to start unless, after `git fetch` (`main-sync.js`
 * `fetchMainNow`, under the main sync lock taken with one try), the backlog's
 * HEAD is `origin/main`, its work tree is clean (no change, staged or not,
 * and no untracked file) and no `bl` run or session is active. Its steps are
 * then plain writes, moves and removals, and it commits the backlog once
 * through the `commit` it is given (`syncAndCommit`). On any failure, or a
 * SIGINT or SIGTERM, before HEAD moves, `git reset --hard HEAD` and
 * `git clean -fd` put the backlog back as it was, since nothing else was in
 * it (`backlog-commit.js` `discardChanges`, under the main sync lock, taken
 * with one try: F-126 D7). Once HEAD has moved the commit has landed, and a
 * rerun plans nothing.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { moveIntoBacklog, removeBacklogPath, writeBacklogPathNow } from './atomic-write.js';
import { discardChanges } from './backlog-commit.js';
import { fetchMainNow, withMainSyncLockNow } from './main-sync.js';
import { otherHolder } from './kernel-lock.js';
import { RUN_DIR } from './run-lock.js';
import { allActiveWorktrees, sessionLockPath } from './story.js';

/**
 * @typedef {object} MigrationOps
 * @property {(path: string, text: string | Buffer) => void} write
 * @property {(from: string, to: string) => void} move
 * @property {(path: string) => void} remove  a file or a whole tree
 * @property {(dir: string) => void} ensureDir
 * @property {(dir: string) => void} rmdir  an empty directory
 */

/**
 * @param {object} config  the backlog config the run loaded
 * @param {{
 *   apply: (ops: MigrationOps) => void,
 *   message: string,
 *   commit: (config: object, opts: { message: string, extraPaths: string[] }) => Promise<object>,
 *   commitConfig?: () => object,
 * }} opts
 *   `commitConfig` gives the config the commit runs on (default: `config`).
 * @returns {Promise<object>} the commit result
 */
export async function applyMigration(config, { apply, message, commit, commitConfig = () => config }) {
  const root = config.backlogRoot;
  const rel = (p) => relative(root, p);
  const git = gitIn(root);

  assertMigrationCanStart(config);

  const headOf = () => git('rev-parse', 'HEAD').stdout.trim();
  const startHead = headOf();
  let restored = false;
  const restore = () => {
    if (restored) return '';
    restored = true;
    const manual = `run git -C "${root}" reset --hard HEAD && git -C "${root}" clean -fd`;
    // A signal listener calls this, so it cannot wait: one try for the main
    // sync lock (F-126 D7), and a busy lock leaves the restore to the operator.
    const held = withMainSyncLockNow(root, () => (headOf() !== startHead ? LANDED : discardChanges(root)));
    if ('holder' in held) {
      return `; could not restore the backlog (PID ${held.holder} holds the main sync lock): ${manual}`;
    }
    if (held.value === LANDED) return '; the commit landed, so a rerun plans nothing';
    const failed = held.value;
    if (failed) return `; could not restore the backlog (${firstLine(failed)}): ${manual}`;
    return '; backlog restored; fix the cause and rerun';
  };

  // A Ctrl-C (or SIGTERM) reaches Node only between synchronous steps, and
  // the signal-exit.js handler (registered by bl.js) then exits before the
  // catch below runs: restore first.
  const onSignal = () => console.error(`migration interrupted${restore()}`);
  process.prependListener('SIGINT', onSignal);
  process.prependListener('SIGTERM', onSignal);

  // The caller holds the backlog lock. `apply` is synchronous, so a spec file
  // is written inside its spec lock taken with one try (F-126 D7): a lock
  // another process holds fails the migration, which then restores.
  const paths = new Set();
  const ensureDir = (dir) => mkdirSync(dir, { recursive: true });
  const write = (path, text) => {
    ensureDir(dirname(path));
    writeBacklogPathNow(root, path, text);
    paths.add(rel(path));
  };
  const move = (from, to) => {
    ensureDir(dirname(to));
    moveIntoBacklog(root, from, to);
    paths.add(rel(from));
    paths.add(rel(to));
  };
  const remove = (path) => {
    removeBacklogPath(root, path);
    paths.add(rel(path));
  };
  const rmdir = (dir) => {
    if (readdirSync(dir).length > 0) {
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, ${dir}`), { code: 'ENOTEMPTY' });
    }
    removeBacklogPath(root, dir);
    paths.add(rel(dir));
  };

  let result;
  try {
    apply({ write, move, remove, ensureDir, rmdir });
    // Moved directories are named whole, so their files (renames) are staged.
    const extra = [...paths].filter((p) => !p.startsWith('..'));
    result = await commit(commitConfig(), { message, extraPaths: extra.filter((p) => !filesInside(p, extra)) });
  } catch (e) {
    throw new Error(`migration failed: ${e.message}${restore()}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  if (result.error) result.error += restore();
  return result;
}

/** The options of every git call here: it never prompts and never reads stdin. */
const GIT_OPTIONS = {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
};

/** What the restore finds when the migration's commit has landed. */
const LANDED = Symbol('landed');

/** A git runner in `root` for the reads (`rev-parse`, `status`). */
function gitIn(root) {
  return (...args) => spawnSync('git', args, { ...GIT_OPTIONS, cwd: root });
}

/**
 * Throw `migration refused: …` unless the backlog is clean at origin/main
 * with no bl run or session active: the check `applyMigration` makes. A
 * migration calls it before it plans, so a run that plans nothing, or a
 * dry run, is refused as the real run would be.
 * @param {object} config  the backlog config the run loaded
 */
export function assertMigrationCanStart(config) {
  const refusal = refuse(config, gitIn(config.backlogRoot));
  if (refusal) throw new Error(`migration refused: ${refusal}`);
}

/** Why the migration must not start, with what to do, or null. */
function refuse(config, git) {
  const root = config.backlogRoot;
  const fetched = fetchMainNow(root, GIT_OPTIONS);
  if ('holder' in fetched) {
    return `PID ${fetched.holder} holds the backlog's main sync lock (a pull, commit or fetch): let it finish, then rerun`;
  }
  const fetch = fetched.value;
  if (fetch.status !== 0) {
    return `git fetch origin main failed (${firstLine(fetch)}): give the backlog an origin remote it can fetch, then rerun`;
  }
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const origin = git('rev-parse', 'origin/main').stdout.trim();
  if (head !== origin) {
    return `the backlog's HEAD (${head.slice(0, 7)}) is not origin/main (${origin.slice(0, 7)}): push or pull until they match, then rerun`;
  }
  const status = git('status', '--porcelain', '--untracked-files=all', '--', '.');
  const dirty = status.stdout.split('\n').filter(Boolean);
  if (status.status !== 0 || dirty.length > 0) {
    const what =
      status.status !== 0 ? firstLine(status) : dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ', …' : '');
    return `the backlog's work tree is not clean (${what}): commit or remove every change and untracked file, then rerun`;
  }
  const active = activeRuns(config);
  if (active.length > 0) return `${active.join(', ')}: let it finish or stop it, then rerun`;
  return null;
}

/** Each live `bl run` (a running run state whose run lock is held) and `bl` session. */
function activeRuns(config) {
  const root = config.backlogRoot;
  const out = [];
  const runDir = join(root, RUN_DIR);
  for (const f of existsSync(runDir) ? readdirSync(runDir) : []) {
    if (!f.endsWith('.json')) continue;
    let state;
    try {
      state = JSON.parse(readFileSync(join(runDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (state?.status !== 'running') continue;
    const pid = otherHolder(join(runDir, f.replace(/\.json$/, '.lock')));
    if (pid != null) out.push(`a bl run is active (${join(RUN_DIR, f)}, pid ${pid})`);
  }
  for (const { dir, pid } of liveSessionLocks(config)) {
    out.push(`a bl session is running in ${dir} (pid ${pid})`);
  }
  return out;
}

/**
 * Each `bl` session lock that another process holds (`otherHolder`, a
 * try-lock, F-104 D6): the directory that holds it, the branch of the
 * worktree it belongs to, and the holder's pid from the lock file, or
 * 'unknown'. A lock this process holds is left out.
 * @param {object} config  the backlog config
 * @returns {{ dir: string, branch: string, pid: number | 'unknown' }[]}
 */
export function liveSessionLocks(config) {
  const root = config.backlogRoot;
  // An unmigrated backlog.json registers its repos under `projects`.
  const repos = { ...config.repos };
  for (const [id, def] of Object.entries(config.topLevel?.projects ?? {})) {
    const list = [
      ...(typeof def?.repo === 'string' ? [def.repo] : []),
      ...(Array.isArray(def?.repos) ? def.repos : []),
    ];
    for (const p of list) if (typeof p === 'string') repos[`${id}:${p}`] = { name: p, path: resolve(root, p) };
  }
  // A session runs in its unit directory (F-60 D3), the worktree's parent; a
  // review round also locks a worktree outside its unit directory.
  const dirs = new Map(
    allActiveWorktrees({ repos }).flatMap((wt) => [
      [wt.path, wt.branch],
      [dirname(wt.path), wt.branch],
    ]),
  );
  const out = [];
  for (const [dir, branch] of dirs) {
    const pid = otherHolder(sessionLockPath(root, dir));
    if (pid != null) out.push({ dir, branch, pid });
  }
  return out;
}

/** The first line of what a failed git command said. */
function firstLine(r) {
  return (r.stderr || '').trim().split('\n')[0];
}

/** Whether `p` lies inside another of `paths` (so naming it again is redundant). */
function filesInside(p, paths) {
  return paths.some((q) => q !== p && p.startsWith(`${q}/`));
}
