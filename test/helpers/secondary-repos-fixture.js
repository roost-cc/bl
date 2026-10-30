/**
 * The S-1010 secondary_repos migration's backlog, shared by its unit and
 * integration tests. F-1 (running) lists `other`, its story's repo (the
 * story's component's), and `gone`, which no story is in; F-2 (done) lists
 * `x`; F-3 has no secondary_repos.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from './tempdir.js';

export function secondaryReposFixture() {
  const t = mkTempBacklog({
    repos: ['../demo-repo', '../other'],
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' },
      { id: 'C01', title: 'Other', dirSuffix: 'other', repo: 'other' },
    ],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', feature: 'F-2', status: 'done' },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three', feature: 'F-3' },
    ],
    features: [
      { id: 'F-1', title: 'One', dirSuffix: 'one', status: 'running', primary_repo: 'demo-repo', stories: ['S-1'] },
      { id: 'F-2', title: 'Two', dirSuffix: 'two', status: 'done', primary_repo: 'demo-repo', stories: ['S-2'] },
      {
        id: 'F-3',
        title: 'Three',
        dirSuffix: 'three',
        status: 'approved',
        primary_repo: 'demo-repo',
        stories: ['S-3'],
      },
    ],
  });
  const path = (n, slug) => join(t.dir, 'features', `F${n}-${slug}`, 'index.md');
  const original = {};
  for (const [n, slug, list] of [
    ['1', 'one', '[other, gone]'],
    ['2', 'two', '[x]'],
    ['3', 'three', null],
  ]) {
    const p = path(n, slug);
    original[n] = readFileSync(p, 'utf8');
    if (list)
      writeFileSync(
        p,
        original[n].replace('primary_repo: demo-repo\n', `primary_repo: demo-repo\nsecondary_repos: ${list}\n`),
      );
  }
  return { ...t, path, original };
}
