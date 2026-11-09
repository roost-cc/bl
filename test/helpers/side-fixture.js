/**
 * The fixtures that test/integration/side-{from,failure,undo}.test.js share.
 *
 * Integration test for `bl side` (F-48 D1, D2): a change to another repo as a
 * story in that repo's component, with its worktree and change document
 * entry. From a running feature (or a story of one) it joins the feature, on
 * the feature's branch; from anything else it is a standalone story on its
 * own branch. Every refusal comes before anything is written, no main
 * checkout leaves `main`, and the backlog commit holds only the paths
 * `bl side` wrote.
 */

import { mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { findFeature, normalizeFeatureId } from '../../src/feature.js';
import { runBl } from './run-bl.js';
import { mkTempBacklog, mkTempDir } from './tempdir.js';
import { git, initGitBacklog } from './git-backlog.js';

/**
 * Repos repoA and repoB (each a git repo on `main`), components C00 (repoA's
 * home), C01 (repoB's home), C02 (repoB, not home) and C03 (no repo).
 * F-1 is running (S-1, in repoA, on branch f1-run); F-2 is a draft (S-2);
 * S-3 is a standalone story. The backlog is a git repo with a clean tree.
 */
export function build() {
  const tmp = mkTempDir('bl-side-');
  const repos = {};
  for (const name of ['repoA', 'repoB']) {
    const r = join(tmp, name);
    mkdirSync(r, { recursive: true });
    git(r, 'init', '-q', '-b', 'main');
    git(r, 'commit', '--allow-empty', '-q', '-m', 'init');
    repos[name] = r;
  }
  const { dir } = mkTempBacklog({
    repos: { repoA: { path: repos.repoA }, repoB: { path: repos.repoB } },
    config: { worktrees: join(tmp, 'worktrees') },
    components: [
      { id: 'C00', title: 'A', dirSuffix: 'a', repo: 'repoA', home: true },
      { id: 'C01', title: 'B', dirSuffix: 'b', repo: 'repoB', home: true },
      { id: 'C02', title: 'B docs', dirSuffix: 'b-docs', repo: 'repoB' },
      { id: 'C03', title: 'Nowhere', dirSuffix: 'nowhere' },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', feature: 'F-1', status: 'in_progress' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', feature: 'F-2' },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three', status: 'in_progress' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Run',
        dirSuffix: 'run',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-run',
        changeRepo: 'repoA',
      },
      { id: 'F-2', title: 'Draft', dirSuffix: 'draft', status: 'draft', stories: ['S-2'] },
    ],
  });
  initGitBacklog(dir);
  const mainBranches = () =>
    Object.fromEntries(Object.entries(repos).map(([n, r]) => [n, git(r, 'branch', '--show-current')]));
  return { tmp, dir, repos, mainBranches };
}

export const fmOf = (path) => parseFrontmatter(readFileSync(path, 'utf8')).fm;
/** A feature's stories: the ones whose `feature:` names it (F-77 D3). */
export const members = (dir, id) => findFeature(normalizeFeatureId(id), loadConfig({ backlogRoot: dir })).stories;
export const storyDirs = (dir) => readdirSync(join(dir, 'stories')).sort();

export const FAULTS = fileURLToPath(new URL('./side-faults.js', import.meta.url));

/** `bl side repoB --from <from>` with `BL_SIDE_FAULT=<faults>` preloaded. */
export function sideWithFaults(dir, from, faults, extraEnv = {}) {
  return runBl(['side', 'repoB', '--from', from, '--title', 'Partial', '--points', '1'], {
    cwd: dir,
    env: { NODE_OPTIONS: `--import=${FAULTS}`, BL_SIDE_FAULT: faults, ...extraEnv },
  });
}
