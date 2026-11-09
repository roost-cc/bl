/** The fixtures that test/integration/feature-{new,approve,approve-lock,status,merge,merge-repos}.test.js share. */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runBl } from './run-bl.js';
import { parseFrontmatter } from '../../src/config.js';

export const REPOS = ['../demo-repo'];
/** demo-repo's home component, so `bl validate` has no home-component finding (F-49 D4). */
export const HOME = { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true };

export function newStory(dir, { component = 'C00', title, points = '3', extra = [], env }) {
  const r = runBl(['new', component, '--title', title, '--points', points, ...extra], { cwd: dir, env });
  if (r.status !== 0) throw new Error('seed failed:\n' + r.stderr);
  return r.stdout.trim();
}

export function newFeature(dir, title = 'Invite codes', env = undefined) {
  const r = runBl(['new', '--feature', '--theme', 'demo', '--title', title], {
    cwd: dir,
    env,
  });
  if (r.status !== 0) throw new Error('feature new failed:\n' + r.stderr);
  return r.stdout.trim();
}

export function fm(path) {
  return parseFrontmatter(readFileSync(path, 'utf8')).fm;
}

/**
 * A bare origin plus a working clone on `main` with one commit, under `dir`.
 * With `branch`, that branch holds one more commit and the clone is back on
 * `main`. Returns the clone and origin paths.
 */
export function initFeatureRepo(g, dir, name, { branch = null } = {}) {
  const origin = join(dir, `${name}-origin.git`);
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(dir, name);
  g(dir, 'init', '-q', '-b', 'main', repo);
  g(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', 'origin', 'main');
  if (branch) {
    g(repo, 'checkout', '-q', '-b', branch);
    writeFileSync(join(repo, 'a.txt'), 'feature\n');
    g(repo, 'commit', '-qam', 'feat');
    g(repo, 'checkout', '-q', 'main');
  }
  return { repo, origin };
}
