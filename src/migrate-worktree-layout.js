/**
 * migrate-worktree-layout.js — the one F-60 migration (Design D4), run by
 * `scripts/migrate-worktree-layout.js`.
 *
 * Before F-60 a repo's worktrees lived at `<root>/<repo>/<branch>`
 * (`backlog.json` `worktrees: "../worktrees/{repo}"`, or unset, which meant
 * the same). Since F-60 they live at `<root>/<branch>/<repo>`, so each unit
 * has one directory (`config.js` `unitDirFor`), and `worktrees` names the
 * root. The migration:
 *
 *   1. moves, for every registered repo, each linked worktree under
 *      `<root>/<repo>/` to `<root>/<branch>/<repo>` with `git worktree move`,
 *      so git's own records follow. A detached worktree (an update run's)
 *      uses its directory name as the branch;
 *   2. rewrites, right after each move, every string in a `.bl/run/*.json`
 *      run state that is the moved path or lies inside it (`worktreePath`,
 *      each repo's entry, a finding's `file`), a path saved through a link
 *      included: those are pinned to their real paths before the first move.
 *      The moves are recorded first
 *      in `.bl/` (`JOURNAL`), so a rerun after a failure between a move and
 *      its rewrites makes the rewrites for the moves already done;
 *   3. removes each `<root>/<repo>/` (and any branch-name subdirectory) the
 *      moves left empty, and leaves and lists anything else in it;
 *   4. sets `backlog.json` `worktrees` to the root (the template with
 *      `/{repo}` cut) and commits the backlog once through `applyMigration`.
 *
 * It refuses before anything moves when a worktree to move holds a live
 * `.workon.lock`, when a target path already exists or two moves share one,
 * when a file or link stands where a target's parent directory would be made,
 * when a target lies inside a worktree to move or inside another target,
 * when another registered git worktree lies inside a worktree to move,
 * when the journal records a move that is neither done nor still planned,
 * when a run state or the journal cannot be read (its paths could not follow),
 * and (through `migration-txn.js`) when a bl run or session is active or the
 * backlog is not clean at origin/main.
 *
 * Idempotent: once nothing is left under `<root>/<repo>/` and `worktrees` is
 * the root, a rerun plans nothing. A run that failed after some moves plans
 * the rest. The moves are outside the backlog, so `applyMigration`'s restore
 * does not undo them; a rerun finishes the job.
 */

import { spawnSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { loadConfig } from './config.js';
import { withLock } from './lock.js';
import { applyMigration } from './migration-txn.js';
import { isSessionRunning } from './story.js';

/** What `worktrees` meant before F-60 when `backlog.json` left it unset. */
export const LEGACY_TEMPLATE = '../worktrees/{repo}';

/** The backlog commit the migration makes. */
export const COMMIT_MESSAGE = 'chore: migrate worktrees to the feature-first layout (F-60)';

/**
 * The moves of a run that has not committed yet, under `.bl/` (ignored):
 * written before the first move and removed once the commit lands, so a rerun
 * after a failure part-way still knows what moved and points the run states
 * there.
 */
export const JOURNAL = 'migrate-worktree-layout.json';

/**
 * The old per-repo template and the root it becomes. A value without
 * `{repo}` is already the root. A template whose `{repo}` is not its last
 * path segment names no root, and throws.
 * @param {string | undefined} value  `backlog.json` `worktrees`
 * @returns {{ template: string | null, root: string }}
 */
export function rootOfTemplate(value) {
  const v = value ?? LEGACY_TEMPLATE;
  if (!v.includes('{repo}')) return { template: null, root: v };
  const m = v.match(/^(.+)\/\{repo\}\/?$/);
  if (!m || m[1].includes('{repo}')) {
    throw new Error(
      `backlog.json "worktrees" is "${v}": the migration moves <root>/{repo}/<branch> only, and "{repo}" is not its last segment. ` +
        'Move the worktrees by hand and set it to the root.',
    );
  }
  return { template: v, root: m[1] };
}

/** The linked worktrees of the repo at `repoPath`: `{ path, branch|null }`, the main one left out. */
export function linkedWorktrees(repoPath) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git worktree list failed in ${repoPath}: ${(r.stderr || '').trim()}`);
  const entries = r.stdout.split('\n\n').filter((e) => e.trim());
  return entries.slice(1).map((entry) => {
    const lines = entry.split('\n');
    const path = lines.find((l) => l.startsWith('worktree ')).slice('worktree '.length);
    const branchLine = lines.find((l) => l.startsWith('branch refs/heads/'));
    return { path, branch: branchLine ? branchLine.slice('branch refs/heads/'.length) : null };
  });
}

/** `path` with its links resolved when it exists, else as given. */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` is `dir` or inside it, by path segment: `..cache` is inside, `..` is not. */
function within(dir, path) {
  const rel = relative(dir, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Absolute `path` with the links of its longest existing ancestor resolved,
 * so a path saved through a link compares equal to the worktree's real path,
 * even once the worktree has moved away from it.
 */
function canonical(path) {
  const rest = [];
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      return join(realpathSync(p), ...rest);
    } catch {
      if (dirname(p) === p) return resolve(path);
      rest.unshift(basename(p));
    }
  }
}

/**
 * Whether resolving `path` goes through `dir`: some leading part of it, its
 * links resolved, is `dir` or inside it. Such a path stops resolving once
 * `dir` moves, whether it names something inside `dir` or follows a link in
 * `dir` out of it.
 */
function passesThrough(dir, path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (within(dir, canonical(p))) return true;
    if (dirname(p) === p) return false;
  }
}

/** Whether anything, a dangling link included, is at `path`. */
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first path on the way from `root` down to `to`'s parent that is there
 * but is not a directory (a file, or a link `mkdir` would follow out of the
 * root), or null. `root` itself may be a link to a directory.
 */
function obstruction(root, to) {
  if (present(root) && !statSync(root, { throwIfNoEntry: false })?.isDirectory()) return root;
  const rel = relative(root, dirname(to));
  let d = root;
  for (const name of rel ? rel.split(sep) : []) {
    d = join(d, name);
    if (present(d) && !lstatSync(d).isDirectory()) return d;
  }
  return null;
}

/**
 * Plan the migration from the config the migration loaded
 * (`loadConfig({ legacyWorktrees: true })`). Reads only.
 *
 * @returns {{
 *   root: string,
 *   moves: { repo: string, repoPath: string, from: string, to: string, branch: string, detached: boolean }[],
 *   done: { from: string, to: string }[],
 *   removeDirs: string[],
 *   leftovers: string[],
 *   runStates: { path: string, rewrites: number }[],
 *   backlogJson: { path: string, from: string | undefined, to: string, text: string } | null,
 *   refusals: string[],
 * }}
 */
export function planWorktreeLayout(config) {
  const backlogRoot = config.backlogRoot;
  const value = config.topLevel?.worktrees;
  const { template, root: rootValue } = rootOfTemplate(value);
  const root = resolve(backlogRoot, rootValue);

  const moves = [];
  const removeDirs = [];
  const leftovers = [];
  const refusals = [];
  const seen = new Set();
  for (const repo of Object.values(config.repos ?? {})) {
    if (seen.has(repo.path)) continue;
    seen.add(repo.path);
    const base = template ? resolve(backlogRoot, template.replaceAll('{repo}', repo.name)) : join(root, repo.name);
    if (!existsSync(base) || !existsSync(repo.path)) continue;
    const realBase = real(base);
    const mine = [];
    for (const wt of linkedWorktrees(repo.path)) {
      const from = real(wt.path);
      if (from === realBase || !within(realBase, from) || !existsSync(from)) continue;
      const branch = wt.branch ?? basename(from);
      const to = join(root, branch, repo.name);
      mine.push(from);
      moves.push({ repo: repo.name, repoPath: repo.path, from, to, branch, detached: wt.branch == null });
    }
    // What stays: anything under the base that is neither a moved worktree
    // nor a directory on the way to one (a branch name with a `/`).
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (mine.includes(path)) continue;
        if (mine.some((m) => within(path, m)) && statSync(path).isDirectory()) walk(path);
        else leftovers.push(path);
      }
    };
    walk(realBase);
    const dirs = [realBase];
    for (const m of mine) for (let d = dirname(m); d !== realBase && within(realBase, d); d = dirname(d)) dirs.push(d);
    // Deepest first, and only those nothing left behind still needs.
    for (const d of [...new Set(dirs)].sort((a, b) => b.length - a.length)) {
      if (!leftovers.some((l) => within(d, l))) removeDirs.push(d);
    }
  }

  // Every checkout git knows of, any registered repo's: one inside a worktree
  // to move would be carried along and its registration left behind.
  const registered = [];
  for (const repo of new Map(Object.values(config.repos ?? {}).map((r) => [r.path, r])).values()) {
    if (!existsSync(repo.path)) continue;
    registered.push(real(repo.path), ...linkedWorktrees(repo.path).map((wt) => real(wt.path)));
  }

  const targets = new Map();
  for (const m of moves) {
    for (const p of registered) {
      if (p !== m.from && within(m.from, p) && existsSync(p)) {
        refusals.push(
          `the git worktree ${p} lies inside ${m.from}, and would lose its registration when that moves: move it out first`,
        );
      }
    }
    if (isSessionRunning(m.from))
      refusals.push(`a bl session holds ${join(m.from, '.workon.lock')}: let it finish or stop it`);
    if (present(m.to)) refusals.push(`${m.to} already exists, so ${m.from} cannot move there`);
    const blocked = obstruction(root, m.to);
    if (blocked) refusals.push(`${blocked} is not a directory, so ${m.from} cannot move to ${m.to}`);
    if (targets.has(m.to)) refusals.push(`${targets.get(m.to)} and ${m.from} would both move to ${m.to}`);
    targets.set(m.to, m.from);
    // A target inside a worktree still to move (`from` is real, so the
    // target is compared with its links resolved), or inside another target.
    for (const o of moves) {
      if (within(o.from, canonical(m.to)))
        refusals.push(`${m.to} lies inside the worktree ${o.from}, so ${m.from} cannot move there`);
      else if (o !== m && o.to !== m.to && within(o.to, m.to)) {
        refusals.push(`${m.to} lies inside ${o.to}, where ${o.from} moves, so ${m.from} cannot move there`);
      }
    }
  }

  // The moves an earlier run made before it failed: gone from `from`, at `to`.
  // Every other entry must still be planned, so the rewritten journal keeps it.
  const done = [];
  const journalPath = join(backlogRoot, '.bl', JOURNAL);
  if (present(journalPath)) {
    let journal = [];
    try {
      journal = JSON.parse(readFileSync(journalPath, 'utf8')).moves.map(({ from, to }) => ({ from, to }));
    } catch (e) {
      refusals.push(`${journalPath} cannot be read (${e.message}): it records the moves of a run that failed`);
    }
    for (const j of journal) {
      if (!present(j.from) && present(j.to)) done.push(j);
      else if (!moves.some((m) => m.from === j.from && m.to === j.to)) {
        refusals.push(
          `${journalPath} records the move ${j.from} -> ${j.to}, which is neither done nor still planned: ` +
            'put the worktree at one of them, or remove the journal once the run states name where it is',
        );
      }
    }
  }

  const runStates = [];
  const runDir = join(backlogRoot, '.bl', 'run');
  for (const f of existsSync(runDir) ? readdirSync(runDir).sort() : []) {
    if (!f.endsWith('.json')) continue;
    const path = join(runDir, f);
    let state;
    try {
      state = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      refusals.push(
        `run state ${path} cannot be read (${e.message}), so its paths could not follow the moves: fix or remove it`,
      );
      continue;
    }
    const rewrites = [...done, ...moves].reduce((n, m) => n + rewritePaths(state, m.from, m.to).count, 0);
    if (rewrites > 0) runStates.push({ path, rewrites });
  }

  let backlogJson = null;
  if (value !== rootValue) {
    const path = join(backlogRoot, 'backlog.json');
    backlogJson = { path, from: value, to: rootValue, text: setWorktrees(readFileSync(path, 'utf8'), rootValue) };
  }
  return { root, moves, done, removeDirs, leftovers, runStates, backlogJson, refusals };
}

/**
 * `node` (a parsed run state) with every string that is `from` or a path
 * inside it pointed at `to` instead, and how many it changed. `from` is a
 * real path; each absolute string is compared with its links resolved. A
 * string that only goes through `from` (a link in it pointing out) becomes
 * its real path. With `to` equal to `from`, this pins every string that
 * depends on `from` to its real path, which still compares equal once `from`
 * has moved and its links are gone.
 */
export function rewritePaths(node, from, to) {
  let count = 0;
  const map = (v) => {
    if (typeof v === 'string') {
      if (!isAbsolute(v) || !passesThrough(from, v)) return v;
      const c = canonical(v);
      const out = within(from, c) ? join(to, relative(from, c)) : c;
      if (out !== v) count++;
      return out;
    }
    if (Array.isArray(v)) return v.map(map);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]));
    return v;
  };
  return { value: map(node), count };
}

/**
 * `backlog.json`'s text with `worktrees` set to `root`. The one value is
 * replaced in place so the rest of the file keeps its layout; a file that
 * left it unset gets it as a new top-level key.
 */
export function setWorktrees(text, root) {
  const parsed = JSON.parse(text);
  if (Object.hasOwn(parsed, 'worktrees')) {
    const re = new RegExp(`("worktrees"\\s*:\\s*)${escapeRe(JSON.stringify(parsed.worktrees))}`);
    if (re.test(text)) return text.replace(re, (_, key) => `${key}${JSON.stringify(root)}`);
  }
  return `${JSON.stringify({ ...parsed, worktrees: root }, null, 2)}\n`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Point every run state's paths in each `from` of `pairs` at its `to`.
 * Throws on a run state it cannot read: the plan refused those.
 */
function rewriteRunStates(pairs, runDir, backlogRoot) {
  if (pairs.length === 0) return;
  for (const f of existsSync(runDir) ? readdirSync(runDir) : []) {
    if (!f.endsWith('.json')) continue;
    const path = join(runDir, f);
    let value = JSON.parse(readFileSync(path, 'utf8'));
    let changed = 0;
    for (const m of pairs) {
      const r = rewritePaths(value, m.from, m.to);
      value = r.value;
      changed += r.count;
    }
    // `.bl/` is ignored, so the run states are written in place, not committed.
    if (changed > 0) atomicWriteFile(backlogRoot, path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

/** `git worktree move` `m.from` to `m.to`, then point the run states at it. */
function moveWorktree(m, runDir, backlogRoot) {
  const parent = dirname(m.to);
  const made = !existsSync(parent);
  mkdirSync(parent, { recursive: true });
  const r = spawnSync('git', ['worktree', 'move', m.from, m.to], { cwd: m.repoPath, encoding: 'utf8' });
  if (r.status !== 0) {
    if (made && readdirSync(parent).length === 0) rmdirSync(parent);
    throw new Error(`git worktree move ${m.from} ${m.to} failed: ${(r.stderr || '').trim()}`);
  }
  rewriteRunStates([m], runDir, backlogRoot);
}

/**
 * Run the migration. With `dryRun`, print the plan and do nothing; otherwise
 * move, rewrite and commit under the backlog lock. Throws on a refusal,
 * before anything moves (a dry run prints its plan first).
 *
 * @param {object} config  `loadConfig({ legacyWorktrees: true })`
 * @param {{ dryRun?: boolean, log?: (line: string) => void, commit?: Function }} [opts]
 *   `commit` is for tests (default `syncAndCommit`)
 * @returns {Promise<{ plan: ReturnType<typeof planWorktreeLayout>, commit: object | null }>}
 */
export async function migrate(config, { dryRun = false, log = console.log, commit } = {}) {
  const backlogRoot = config.backlogRoot;
  const { runSync, syncAndCommit } = await import('./sync.js');
  return withLock(backlogRoot, async () => {
    const plan = planWorktreeLayout(config);
    const refused = () => new Error(`migration refused: ${plan.refusals.join('; ')}`);
    // A dry run shows the whole plan first; a real run says nothing it will not do.
    if (plan.refusals.length > 0 && !dryRun) throw refused();
    const verb = dryRun ? 'would ' : '';
    const rel = (p) => relative(backlogRoot, p);
    for (const m of plan.moves) log(`${verb}move    ${m.from} -> ${m.to}${m.detached ? ' (detached)' : ''}`);
    for (const s of plan.runStates)
      log(`${verb}rewrite ${rel(s.path)} (${s.rewrites} path${s.rewrites === 1 ? '' : 's'})`);
    for (const d of plan.removeDirs) log(`${verb}remove  ${d}`);
    for (const l of plan.leftovers) log(`leave   ${l} (not a registered worktree)`);
    if (plan.backlogJson) {
      const { from, to } = plan.backlogJson;
      log(
        `${verb}set     backlog.json worktrees: ${from === undefined ? '(unset)' : JSON.stringify(from)} -> ${JSON.stringify(to)}`,
      );
    }
    log(
      `worktrees moved: ${plan.moves.length}; run states rewritten: ${plan.runStates.length}; directories left: ${plan.leftovers.length}`,
    );
    if (plan.refusals.length > 0) throw refused();
    if (dryRun) return { plan, commit: null };

    const runDir = join(backlogRoot, '.bl', 'run');
    const journalPath = join(backlogRoot, '.bl', JOURNAL);
    if (plan.moves.length === 0 && !plan.backlogJson) {
      rewriteRunStates(plan.done, runDir, backlogRoot);
      rmSync(journalPath, { force: true });
      return { plan, commit: null };
    }
    const result = await applyMigration(config, {
      message: COMMIT_MESSAGE,
      commit: commit ?? syncAndCommit,
      sync: runSync,
      // The sync and commit run on the backlog as migrated, which the new bl loads.
      commitConfig: () => loadConfig({ backlogRoot }),
      apply: ({ write }) => {
        const journal = [...plan.done, ...plan.moves].map(({ from, to }) => ({ from, to }));
        atomicWriteFile(backlogRoot, journalPath, `${JSON.stringify({ moves: journal }, null, 2)}\n`);
        rewriteRunStates(plan.done, runDir, backlogRoot);
        // Before anything moves, a saved path that reaches a worktree through
        // a link becomes its real path: after the move the link no longer
        // leads there, here or in a rerun.
        rewriteRunStates(
          plan.moves.map(({ from }) => ({ from, to: from })),
          runDir,
          backlogRoot,
        );
        for (const m of plan.moves) moveWorktree(m, runDir, backlogRoot);
        for (const d of plan.removeDirs) if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
        if (plan.backlogJson) write(plan.backlogJson.path, plan.backlogJson.text);
      },
    });
    if (result?.committed) rmSync(journalPath, { force: true });
    return { plan, commit: result };
  });
}
