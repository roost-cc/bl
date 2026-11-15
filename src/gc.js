/**
 * gc.js — remove what closed work units (a status that meets `done` in
 * flow.json) leave behind (S-1112).
 *
 * Two kinds of litter outlive a work unit:
 *
 * 1. Its run files in `<backlog>/.bl/run`: a scratch directory per agent
 *    session (`<id>.<slot>.scratch`) and a log per test-gate attempt
 *    (`<id>.test-<n>.log`). `bl merge` and `bl done` call `removeRunFiles`
 *    when they mark a work unit done; `bl gc` does the same for every closed
 *    work unit. The run state, the lock, the review findings and the event
 *    logs stay, and so does the newest gate log.
 * 2. Its directory under the worktree root, `<root>/<branch>`. `bl merge`
 *    removes it only when it is empty; `bl gc` removes a closed work unit's
 *    directory with everything in it, once git has removed each clean
 *    worktree in it (`sweepWorktrees`).
 *
 * This module decides which files are litter, so the three verbs agree.
 */

import { existsSync, lstatSync, readdirSync, renameSync, rmSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { git } from './child.js';
import { info, loadConfig, parseArgs, worktreeRoot, unitBranchName } from './config.js';
import { loadBacklog } from './backlog-graph.js';
import { flowForHelp } from './flow.js';
import { realOrResolved } from './real-path.js';
import { RUN_DIR } from './run-lock.js';
import { listWorktrees, worktreeChanges } from './story.js';

/** The work unit kinds that have run files and a branch. */
export const RUN_KINDS = new Set(['story', 'feature', 'batch']);

/** The reason `bl gc` keeps a path whose name is no work unit's. */
const NO_UNIT = 'names no work unit';

/** A gate log's name, `<id>.test-<n>.log`: the id and `n`. */
const GATE_LOG_RE = /^([^.]+)\.test-(\d+)\.log$/;

/** `bl gc --help`, naming the closed statuses from the flow. */
const help = () => `Usage: bl gc [--dry-run]

Remove what closed work units (stories, features and story batches that are
${flowForHelp().closedStatusesOf('story').join(' or ')}) left behind:

  - in .bl/run: each <id>.*.scratch directory, and each <id>.test-<n>.log
    but the one with the highest n. The run state, the lock, the review
    findings and the event logs stay.
  - under the worktree root: the work unit's directory (its branch). Git
    removes each clean worktree in it first (git worktree remove, no
    --force); then the directory goes with everything left in it. A
    worktree with uncommitted changes, or one git cannot read or refuses to
    remove, is kept, and so is its directory. Then git worktree prune runs
    in each repo.

A .bl/run entry or a directory whose name is no work unit's is kept. An open
work unit's files are not touched and not listed.

Options:
  --dry-run   Remove nothing; print what would be removed
  --help      Show this help

Output: one stdout line per path, "removed <path>" ("would remove <path>"
with --dry-run) or "kept <path> (<reason>)". Then one stderr line with the
count and size removed, and the count kept.

Exit codes:
  0   Nothing failed (a path kept for its changes or its name is not a
      failure).
  1   A path could not be removed, a git command failed, or a bad argument.`;

/**
 * The leading segment of a `.bl/run` entry's name, up to its first `.`: the
 * work unit id the entry belongs to (the whole name when it has no `.`).
 *
 * @param {string} name
 * @returns {string}
 */
export function runFileKey(name) {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/**
 * The `.bl/run` entry names to remove for the work units `ids`: each
 * directory whose key is an id and whose name ends in `.scratch`, and each
 * `<id>.test-<n>.log` file but the one with the highest `n` (compared as a
 * number). Pure.
 *
 * @param {{ name: string, isDirectory: boolean }[]} entries
 * @param {Set<string>} ids
 * @returns {string[]} names, in `entries` order
 */
export function selectRunFiles(entries, ids) {
  const newest = new Map();
  for (const e of entries) {
    const m = e.isDirectory ? null : GATE_LOG_RE.exec(e.name);
    if (m && ids.has(m[1])) newest.set(m[1], Math.max(newest.get(m[1]) ?? 0, Number(m[2])));
  }
  return entries
    .filter((e) => {
      if (!ids.has(runFileKey(e.name))) return false;
      if (e.isDirectory) return e.name.endsWith('.scratch');
      const m = GATE_LOG_RE.exec(e.name);
      return m != null && Number(m[2]) < newest.get(m[1]);
    })
    .map((e) => e.name);
}

/**
 * The bytes of the files and symlinks under `path` (`path` itself when it is
 * not a directory). It never follows a symlink: a link counts its own size.
 * A path that is gone or unreadable adds 0.
 *
 * @param {string} path
 * @returns {number}
 */
export function sizeOf(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let names;
  try {
    names = readdirSync(path);
  } catch {
    return 0;
  }
  return names.reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

/**
 * Remove each path with everything in it, after measuring it (`sizeOf`). A
 * symlink is removed, never followed. With `dryRun`, measure only. Never
 * throws: a path that cannot be removed is in `failed`.
 *
 * @param {string[]} paths
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ removed: { path: string, bytes: number }[], failed: { path: string, error: string }[] }}
 */
export function removePaths(paths, { dryRun = false } = {}) {
  const removed = [];
  const failed = [];
  for (const path of paths) {
    const bytes = sizeOf(path);
    try {
      if (!dryRun) rmSync(path, { recursive: true, force: true });
      removed.push({ path, bytes });
    } catch (err) {
      failed.push({ path, error: err.message });
    }
  }
  return { removed, failed };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * A byte count for people: `512 B`, `3.4 KB`, `1.9 MB`, `12.7 GB` (base
 * 1024, one decimal above B).
 *
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** Code-point order of two names, so the output does not depend on the locale. */
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The first line of `text`, trimmed. */
const firstLine = (text) => text.trim().split('\n')[0];

/** Why a git run failed: the first line of its stderr, else its exit status. */
const gitFailure = (r) => firstLine(r.stderr ?? '') || `git exited ${r.status}`;

/**
 * `sweep()`, or, when it throws, a `Sweep` that keeps `path` as failed with
 * the error, so the other sweep's results are still printed.
 *
 * @param {() => Sweep} sweep
 * @param {string} path
 * @returns {Sweep}
 */
function attempt(sweep, path) {
  try {
    return sweep();
  } catch (err) {
    return { removed: [], kept: [{ path, reason: firstLine(err.message), failed: true }] };
  }
}

/** The total of `{ bytes }` items. */
const totalBytes = (items) => items.reduce((sum, r) => sum + r.bytes, 0);

/**
 * The entries of `.bl/run` by name, or null when it does not exist.
 *
 * @param {string} dir
 * @returns {{ name: string, isDirectory: boolean }[] | null}
 */
function listRunDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
      .sort((a, b) => byName(a.name, b.name));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Remove the run files of the work units `ids` (`selectRunFiles`), for `bl
 * merge` and `bl done` once they have marked a work unit done. Writes one
 * stderr line with the count and size, none when nothing was removed, and a
 * warning per path it could not remove. Never throws.
 *
 * @param {{ backlogRoot: string }} config
 * @param {string[]} ids
 */
export function removeRunFiles(config, ids) {
  const dir = join(config.backlogRoot, RUN_DIR);
  try {
    const entries = listRunDir(dir);
    if (!entries) return;
    const names = selectRunFiles(entries, new Set(ids));
    const { removed, failed } = removePaths(names.map((n) => join(dir, n)));
    for (const f of failed) console.error(`bl: warning: could not remove ${f.path}: ${f.error}`);
    if (removed.length > 0) {
      info(`Removed ${removed.length} run files of ${ids.join(', ')} (${formatBytes(totalBytes(removed))}).`);
    }
  } catch (err) {
    console.error(`bl: warning: could not remove the run files of ${ids.join(', ')}: ${err.message}`);
  }
}

/**
 * @typedef {{ removed: { path: string, bytes: number }[],
 *   kept: { path: string, reason: string, failed?: boolean }[] }} Sweep
 * `kept` entries with `failed` are paths `removePaths` could not remove, or
 * paths kept because a git command failed.
 */

/**
 * `removePaths` of `paths` as a `Sweep`: a path it could not remove is kept,
 * failed, with the error as the reason.
 *
 * @returns {Sweep}
 */
function sweepPaths(paths, dryRun) {
  const { removed, failed } = removePaths(paths, { dryRun });
  return { removed, kept: failed.map((f) => ({ path: f.path, reason: f.error, failed: true })) };
}

/**
 * The run files of every closed work unit in `.bl/run`. An entry whose key
 * is not exactly the id of a story, feature or story batch is kept; an open
 * work unit's entries are left out.
 *
 * @param {object} config
 * @param {import('./backlog-graph.js').BacklogGraph} graph
 * @param {{ dryRun: boolean }} opts
 * @returns {Sweep}
 */
export function sweepRunFiles(config, graph, { dryRun }) {
  const dir = join(config.backlogRoot, RUN_DIR);
  const entries = listRunDir(dir) ?? [];
  const kept = [];
  const closed = new Set();
  for (const e of entries) {
    const key = runFileKey(e.name);
    const u = graph.get(key);
    // `u.id !== key`: `F104` would otherwise alias `F-104`.
    if (!u || u.id !== key || !RUN_KINDS.has(u.kind)) kept.push({ path: join(dir, e.name), reason: NO_UNIT });
    else if (u.done) closed.add(key);
  }
  const swept = sweepPaths(
    selectRunFiles(entries, closed).map((n) => join(dir, n)),
    dryRun,
  );
  return { removed: swept.removed, kept: [...swept.kept, ...kept] };
}

/** A kept `dir` whose worktrees git cannot list completely. */
const listFailure = (dir, err) => ({
  path: dir,
  reason: `git cannot list the worktrees: ${firstLine(err.message)}`,
  failed: true,
});

/**
 * `path` relative to the first of `bases` that holds it (`''` for a base
 * itself), else null.
 *
 * @param {string[]} bases
 * @param {string} path
 * @returns {string | null}
 */
function relativeIn(bases, path) {
  for (const base of bases) {
    const rel = relative(base, resolve(path));
    if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
  }
  return null;
}

/**
 * Remove a closed work unit's directory `dir` once `bl gc` has removed the
 * worktrees it checked. It moves `dir` aside to `<dir>.bl-gc-<pid>` first,
 * then lists the worktrees of every repo again. A worktree registered in
 * `dir` since the first listing (a path git removed counts too) moved with
 * it: the directory goes back and stays. What a failed removal leaves goes
 * back too. A worktree registered after the move is made in a new `dir`,
 * outside the moved tree, so the removal never reaches it.
 *
 * @param {string} dir
 * @param {string[]} repoPaths
 * @returns {Sweep}
 */
function removeUnitDir(dir, repoPaths) {
  const aside = `${dir}.bl-gc-${process.pid}`;
  const bases = [...new Set([dir, realOrResolved(dir)])];
  try {
    renameSync(dir, aside);
  } catch (err) {
    return { removed: [], kept: [{ path: dir, reason: err.message, failed: true }] };
  }
  let held;
  try {
    held = repoPaths
      .flatMap((repoPath) => listWorktrees(repoPath, { detached: true, strict: true }))
      .filter((w) => {
        const rel = relativeIn(bases, w.path);
        return rel != null && existsSync(join(aside, rel));
      })
      .map((w) => ({ path: w.path, reason: 'registered while bl gc ran' }));
  } catch (err) {
    held = [listFailure(dir, err)];
  }
  if (held.length === 0) {
    const swept = sweepPaths([aside], false);
    if (swept.kept.length === 0) return { removed: [{ path: dir, bytes: swept.removed[0].bytes }], kept: [] };
    // What the removal left goes back, so the next `bl gc` finds it by name.
    held = swept.kept.map((k) => ({ ...k, path: dir }));
  }
  try {
    renameSync(aside, dir);
  } catch (err) {
    held.push({ path: aside, reason: `could not move it back to ${dir}: ${err.message}`, failed: true });
  }
  return { removed: [], kept: held };
}

/**
 * The directories of closed work units under the worktree root. A directory
 * is a work unit's when its name is the work unit's directory name,
 * lowercased (its branch). For a closed one, each registered worktree in it
 * is removed with `git worktree remove` (no `--force`) when it has no
 * uncommitted changes; one that git cannot read, that has changes or that
 * git refuses to remove is kept, and so is the directory. The directory is
 * moved aside and the worktrees are listed again before it goes
 * (`removeUnitDir`); one registered in it since the first listing is kept,
 * and so is the directory. A directory is kept when any configured repo
 * gives no complete worktree list (its path is not there, git fails, or a
 * record has no path). Otherwise the directory goes
 * with everything in it, reported as one path. A directory that names no
 * work unit is kept; an open work unit's is left out. Unless `dryRun`, `git
 * worktree prune` runs in each repo afterwards; a failed prune, or a repo
 * path that is not there, keeps the repo as a failure.
 *
 * @param {object} config
 * @param {import('./backlog-graph.js').BacklogGraph} graph
 * @param {{ dryRun: boolean }} opts
 * @returns {Sweep}
 */
export function sweepWorktrees(config, graph, { dryRun }) {
  const removed = [];
  const kept = [];
  const root = worktreeRoot(config);
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(byName);
  } catch (err) {
    if (err.code === 'ENOENT') return { removed, kept };
    throw err;
  }

  const byBranch = new Map();
  for (const kind of RUN_KINDS) {
    for (const u of graph.list(kind)) if (u.id) byBranch.set(unitBranchName(u.entry), u);
  }
  const repoPaths = [...new Set(Object.values(config.repos ?? {}).map((r) => r.path))];
  // The worktrees registered in the directory `real`, listed now from every
  // repo. Throws when git cannot list a repo's worktrees, so a failed listing
  // never reads as "no worktree here". A registered worktree whose path is
  // gone (deleted by hand) is not in the directory; the `git worktree prune`
  // below drops its registration.
  const registeredIn = (real) =>
    repoPaths.flatMap((repoPath) =>
      listWorktrees(repoPath, { detached: true, strict: true })
        .filter((w) => existsSync(w.path))
        .map((w) => ({ repoPath, path: w.path, real: realOrResolved(w.path) }))
        .filter((w) => w.real === real || w.real.startsWith(real + sep)),
    );

  for (const d of dirs) {
    const dir = join(root, d);
    const u = byBranch.get(d);
    if (!u) {
      kept.push({ path: dir, reason: NO_UNIT });
      continue;
    }
    if (!u.done) continue;
    const real = realOrResolved(dir);
    let inside;
    try {
      inside = registeredIn(real);
    } catch (err) {
      kept.push(listFailure(dir, err));
      continue;
    }
    const gone = [];
    const held = [];
    for (const w of inside) {
      const changes = worktreeChanges(w.path);
      if (changes == null) held.push({ path: w.path, reason: 'git cannot read its status', failed: true });
      else if (changes.length > 0)
        held.push({ path: w.path, reason: `uncommitted changes in ${changes.length} paths` });
      else if (dryRun) gone.push({ path: w.path, bytes: sizeOf(w.path) });
      else {
        const bytes = sizeOf(w.path);
        const r = git(w.repoPath, ['worktree', 'remove', w.path]);
        if (r.status === 0) gone.push({ path: w.path, bytes });
        else held.push({ path: w.path, reason: gitFailure(r), failed: true });
      }
    }
    if (held.length > 0) {
      removed.push(...gone);
      kept.push(...held);
      continue;
    }
    const swept = dryRun ? sweepPaths([dir], true) : removeUnitDir(dir, repoPaths);
    if (swept.kept.length > 0) {
      removed.push(...gone);
      kept.push(...swept.kept);
      continue;
    }
    // A dry run measured the whole directory, its worktrees included.
    const bytes = swept.removed[0].bytes + (dryRun ? 0 : totalBytes(gone));
    removed.push({ path: dir, bytes });
  }

  if (!dryRun) {
    for (const repoPath of repoPaths) {
      // A repo path that is not there is a skipped prune, so a failure too.
      const r = existsSync(repoPath) ? git(repoPath, ['worktree', 'prune']) : null;
      const why = r ? r.status !== 0 && gitFailure(r) : `no repo at ${repoPath}`;
      if (why) kept.push({ path: repoPath, reason: `git worktree prune: ${why}`, failed: true });
    }
  }
  return { removed, kept };
}

/**
 * `bl gc [--dry-run]`: sweep the run files and the worktree directories of
 * every closed work unit, print one line per path, and exit 1 when a path
 * could not be removed or a git command failed.
 *
 * @param {string[]} argv
 */
export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help === true) {
    console.log(help());
    process.exit(0);
  }
  // Each flag is a bare boolean: `--dry-run=false` is refused, never read as
  // "not a dry run".
  const bad = Object.entries(args).filter(([k, v]) => k !== 'positional' && (k !== 'dry-run' || v !== true));
  if (args.positional.length > 0 || bad.length > 0) {
    console.error(help());
    process.exit(1);
  }
  const dryRun = args['dry-run'] === true;
  const config = loadConfig();
  const graph = loadBacklog(config);
  const sweeps = [
    attempt(() => sweepRunFiles(config, graph, { dryRun }), join(config.backlogRoot, RUN_DIR)),
    attempt(() => sweepWorktrees(config, graph, { dryRun }), worktreeRoot(config)),
  ];

  const verb = dryRun ? 'would remove' : 'removed';
  const removed = sweeps.flatMap((s) => s.removed);
  const kept = sweeps.flatMap((s) => s.kept);
  for (const s of sweeps) {
    for (const r of s.removed) console.log(`${verb} ${r.path}`);
    for (const k of s.kept) console.log(`kept ${k.path} (${k.reason})`);
  }
  console.error(`bl gc: ${verb} ${removed.length} paths, ${formatBytes(totalBytes(removed))}; kept ${kept.length}.`);
  if (kept.some((k) => k.failed)) process.exitCode = 1;
}
