/**
 * migration-txn.js — the all-or-nothing apply of a one-off backlog
 * migration (F-49's taxonomy and F-51's value-axis migrations had it; F-62
 * removed both once they had run).
 *
 * The guarantee comes from git, not from bookkeeping (F-51 decision R2).
 * `applyMigration` refuses to start unless, after `git fetch`, the backlog's
 * HEAD is `origin/main`, its work tree is clean (no change, staged or not,
 * and no untracked file) and no `bl` run or session is active. Its steps are
 * then plain writes, moves and removals, and it commits the backlog once
 * through the `commit` it is given (`syncAndCommit`). On any failure, or a
 * SIGINT or SIGTERM, before HEAD moves, `git reset --hard HEAD` and
 * `git clean -fd` put the backlog back as it was, since nothing else was in
 * it. Once HEAD has moved the commit has landed, and a rerun plans nothing.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { LOCK_FILE } from './lock.js';
import { MAIN_REFSPEC } from './main-sync.js';
import { liveLockHolder } from './pid-lock.js';
import { allActiveWorktrees, LOCK_FILE as SESSION_LOCK_FILE } from './story.js';

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
 *   sync?: (config: object) => Promise<unknown>,
 *   commitConfig?: () => object,
 * }} opts
 *   `commitConfig` gives the config the commit's sync runs on (default:
 *   `config`); `sync` is that sync, run once before the commit, and the
 *   paths it returns are committed with the run's own.
 * @returns {Promise<object>} the commit result
 */
export async function applyMigration(
  config,
  { apply, message, commit, sync = async () => {}, commitConfig = () => config },
) {
  const root = config.backlogRoot;
  const rel = (p) => relative(root, p);
  const git = (...args) =>
    spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const refusal = refuse(config, git);
  if (refusal) throw new Error(`migration refused: ${refusal}`);

  const headOf = () => git('rev-parse', 'HEAD').stdout.trim();
  const startHead = headOf();
  let restored = false;
  const restore = () => {
    if (restored) return '';
    restored = true;
    if (headOf() !== startHead) return '; the commit landed, so a rerun plans nothing';
    const failed = [git('reset', '-q', '--hard', 'HEAD'), git('clean', '-q', '-fd', '-e', LOCK_FILE)].find(
      (r) => r.status !== 0,
    );
    if (failed) {
      return `; could not restore the backlog (${firstLine(failed)}): run git -C "${root}" reset --hard HEAD && git -C "${root}" clean -fd`;
    }
    return '; backlog restored; fix the cause and rerun';
  };

  // A Ctrl-C (or SIGTERM) reaches Node only between synchronous steps, and
  // lock.js's handler then exits before the catch below runs: restore first.
  const onSignal = () => console.error(`migration interrupted${restore()}`);
  process.prependListener('SIGINT', onSignal);
  process.prependListener('SIGTERM', onSignal);

  const paths = new Set();
  const ensureDir = (dir) => mkdirSync(dir, { recursive: true });
  const write = (path, text) => {
    ensureDir(dirname(path));
    atomicWriteFile(root, path, text);
    paths.add(rel(path));
  };
  const move = (from, to) => {
    ensureDir(dirname(to));
    renameSync(from, to);
    paths.add(rel(from));
    paths.add(rel(to));
  };
  const remove = (path) => {
    rmSync(path, { recursive: true });
    paths.add(rel(path));
  };
  const rmdir = (dir) => {
    rmdirSync(dir);
    paths.add(rel(dir));
  };

  let result;
  try {
    apply({ write, move, remove, ensureDir, rmdir });
    // The commit's own sync then changes nothing, so it stages what this one wrote.
    const synced = (await sync(commitConfig())) ?? [];
    // Moved directories are named whole, so their files (renames) are staged.
    const extra = [...new Set([...paths, ...synced])].filter((p) => !p.startsWith('..'));
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

/** Why the migration must not start, with what to do, or null. */
function refuse(config, git) {
  const root = config.backlogRoot;
  const fetch = git('fetch', '-q', 'origin', MAIN_REFSPEC);
  if (fetch.status !== 0) {
    return `git fetch origin main failed (${firstLine(fetch)}): give the backlog an origin remote it can fetch, then rerun`;
  }
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const origin = git('rev-parse', 'origin/main').stdout.trim();
  if (head !== origin) {
    return `the backlog's HEAD (${head.slice(0, 7)}) is not origin/main (${origin.slice(0, 7)}): push or pull until they match, then rerun`;
  }
  // The backlog lock, which the caller holds, is not a change.
  const status = git('status', '--porcelain', '--untracked-files=all', '--', '.', `:!${LOCK_FILE}`);
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

/** Each live `bl run` (a running run state whose lock has a live holder) and `bl` session. */
function activeRuns(config) {
  const root = config.backlogRoot;
  const out = [];
  const runDir = join(root, '.bl', 'run');
  for (const f of existsSync(runDir) ? readdirSync(runDir) : []) {
    if (!f.endsWith('.json')) continue;
    let state;
    try {
      state = JSON.parse(readFileSync(join(runDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (state?.status !== 'running') continue;
    const pid = liveLockHolder(join(runDir, f.replace(/\.json$/, '.lock')));
    if (pid != null && pid !== process.pid) out.push(`a bl run is active (${join('.bl', 'run', f)}, pid ${pid})`);
  }
  // An unmigrated backlog.json registers its repos under `projects`.
  const repos = { ...config.repos };
  for (const [id, def] of Object.entries(config.topLevel?.projects ?? {})) {
    const list = [
      ...(typeof def?.repo === 'string' ? [def.repo] : []),
      ...(Array.isArray(def?.repos) ? def.repos : []),
    ];
    for (const p of list) if (typeof p === 'string') repos[`${id}:${p}`] = { name: p, path: resolve(root, p) };
  }
  // A session's lock is in its unit directory (F-60 D3), the worktree's
  // parent; one started before that is in the worktree itself.
  const dirs = new Set(allActiveWorktrees({ repos }).flatMap((wt) => [wt.path, dirname(wt.path)]));
  for (const dir of dirs) {
    const pid = liveLockHolder(join(dir, SESSION_LOCK_FILE));
    if (pid != null && pid !== process.pid) out.push(`a bl session is running in ${dir} (pid ${pid})`);
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
