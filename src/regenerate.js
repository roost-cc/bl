/**
 * regenerate.js — the `regenerate` plugin stage (F-36 D5): generated files a
 * merge with main left conflicted are regenerated, never hand-merged.
 *
 * A plugin defines `regenerate` (a command run in the worktree) and `paths`
 * (the repo-relative globs it regenerates); `loadConfig` refuses one without
 * the other. A repo activates it with `plugins-regenerate: [<name>]`, through
 * the same cascade as every other stage.
 */

import { resolveFeaturePluginsReport } from './feature.js';
import { pathMatches } from './story.js';

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const OUTPUT_TAIL_LINES = 20;

/**
 * The `regenerate` plugins active for a repo, each with its `paths`: the
 * cascade the test gate resolves (`resolveFeaturePluginsReport`), on the
 * repo's own config (`configForRepo`).
 * @returns {Array<{ name: string, command: string, paths: string[] }>}
 */
export function regeneratePlugins(cfg, unitIndexPath, componentEntry) {
  const { plugins } = resolveFeaturePluginsReport('regenerate', cfg, unitIndexPath, { componentEntry });
  return plugins.map((p) => ({ ...p, paths: cfg.plugins?.[p.name]?.paths ?? [] }));
}

/**
 * Regenerate the conflicted paths of a merge in progress in `worktreePath`.
 * Per plugin, in order, every conflicted path its `paths` match (dotfiles
 * included) that no earlier plugin took is checked out from the branch side
 * (`git checkout --ours`), or removed from the worktree when the branch
 * deleted it, the command runs once, and its paths are staged, with every
 * other path its `paths` match that the command created, changed or deleted
 * (untracked included, ignored not). A plugin any of whose steps fails (the
 * index read, the checkout, the command, the output scan, the staging) puts
 * its paths back as conflicted (`git checkout -m`, or the one side left
 * when the other deleted the path), for the resolution agent or the operator.
 *
 * Commits nothing: the caller commits the merge when `remaining` is empty.
 *
 * @param {object} o
 * @param {string} o.worktreePath
 * @param {string[]} o.conflicted — the merge's conflicted paths
 * @param {Array<{ name: string, command: string, paths: string[] }>} o.plugins
 * @param {(cmd: string, cwd: string) => { status: number, output: string }} o.shell
 * @param {(msg: string) => void} [o.log]
 * @returns {{ regenerated: Array<{ name: string, paths: string[] }>,
 *   remaining: string[],
 *   failed: Array<{ name: string, paths: string[], command: string, output: string }> }}
 */
export function regenerateConflicts({ worktreePath, conflicted, plugins, shell, log = () => {} }) {
  const regenerated = [];
  const failed = [];
  const taken = new Set();
  for (const p of plugins) {
    const paths = conflicted.filter((f) => !taken.has(f) && pathMatches(f, p.paths));
    if (paths.length === 0) continue;
    for (const f of paths) taken.add(f);
    const list = paths.map(shq).join(' ');
    // A path the branch deleted has no `--ours` side: it is removed instead,
    // and the command may write it again.
    const side = branchSide(shell, worktreePath, paths);
    // Unknown sides: nothing is touched yet, so the paths stay conflicted.
    if (side.error) {
      failed.push({ name: p.name, paths, command: side.command, output: tail(side.error.output) });
      log(`  regenerate ${p.name}: \`${side.command}\` failed; ${paths.join(', ')} left conflicted`);
      continue;
    }
    const ours = side.paths;
    const kept = paths
      .filter((f) => ours.has(f))
      .map(shq)
      .join(' ');
    const gone = paths
      .filter((f) => !ours.has(f))
      .map(shq)
      .join(' ');
    const fail = (command, r) => {
      // `-m` refuses a path main deleted: the branch's side goes back instead.
      for (const f of paths.filter((x) => ours.has(x)).map(shq)) {
        shell(`git checkout -m -- ${f} || git checkout --ours -- ${f}`, worktreePath);
      }
      if (gone) shell(`git checkout --theirs -- ${gone}`, worktreePath);
      failed.push({ name: p.name, paths, command, output: tail(r.output) });
      log(`  regenerate ${p.name}: \`${command}\` failed; ${paths.join(', ')} left conflicted`);
    };
    const take = kept ? shell(`git checkout --ours -- ${kept}`, worktreePath) : { status: 0 };
    if (take.status !== 0) {
      fail(`git checkout --ours -- ${kept}`, take);
      continue;
    }
    const drop = gone ? shell(`rm -rf -- ${gone}`, worktreePath) : { status: 0 };
    if (drop.status !== 0) {
      fail(`rm -rf -- ${gone}`, drop);
      continue;
    }
    const run = shell(p.command, worktreePath);
    if (run.status !== 0) {
      fail(p.command, run);
      continue;
    }
    // A conflicted path an earlier plugin left (its command failed) is not
    // this command's output: staging it would mark its markers resolved.
    // Outputs that cannot be listed are not none: staging only `paths` would
    // commit a tree without them.
    const scan = 'git status --porcelain -z --untracked-files=all';
    const changed = shell(scan, worktreePath);
    if (changed.status !== 0) {
      fail(scan, changed);
      continue;
    }
    const also = statusPaths(changed.output).filter((f) => !conflicted.includes(f) && pathMatches(f, p.paths));
    const add = shell(`git add -A -- ${[...paths, ...also].map(shq).join(' ')}`, worktreePath);
    if (add.status !== 0) {
      fail(`git add -A -- ${list}`, add);
      continue;
    }
    regenerated.push({ name: p.name, paths: [...paths, ...also] });
    log(`  regenerate ${p.name}: ${paths.join(', ')}`);
  }
  const done = new Set(regenerated.flatMap((r) => r.paths));
  return { regenerated, remaining: conflicted.filter((f) => !done.has(f)), failed };
}

/**
 * `{ paths }`: the `paths` whose merge has a branch side (index stage 2), or
 * `{ error, command }` when the index cannot be read.
 */
function branchSide(shell, cwd, paths) {
  const command = `git --literal-pathspecs ls-files -u -z -- ${paths.map(shq).join(' ')}`;
  const r = shell(command, cwd);
  if (r.status !== 0) return { error: r, command };
  const out = new Set();
  for (const e of String(r.output).split('\0')) {
    const m = e.match(/^\d+ [0-9a-f]+ 2\t([\s\S]+)$/);
    if (m) out.add(m[1]);
  }
  return { paths: out };
}

/** The paths `git status --porcelain -z` names (a rename's source, gone, is not). */
function statusPaths(output) {
  const parts = String(output).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length < 4) continue;
    out.push(parts[i].slice(3));
    if (/[RC]/.test(parts[i][0])) i++;
  }
  return out;
}

function tail(output) {
  return String(output ?? '')
    .trimEnd()
    .split('\n')
    .slice(-OUTPUT_TAIL_LINES)
    .join('\n');
}
