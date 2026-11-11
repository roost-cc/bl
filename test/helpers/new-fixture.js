/** The fixtures that test/integration/new-{story,component,commit,edges,plugins,theme,yaml}.test.js share. */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from './tempdir.js';
import { parseFrontmatter } from '../../src/config.js';
import { initGitBacklog, dirtyBystanders } from './git-backlog.js';

/**
 * A backlog whose `demo` project registers two repos, each with its home
 * component (alpha: C01, beta: C02), and a second alpha component, C03
 * (F-49 D4). `extra` is merged into the fixture.
 */
export function componentBacklog(extra = {}) {
  return mkTempBacklog({
    repos: ['../repos/alpha', '../repos/beta'],
    components: [
      { id: 'C01', title: 'Core', dirSuffix: 'core', repo: 'alpha', home: true },
      { id: 'C02', title: 'Beta', dirSuffix: 'beta', repo: 'beta', home: true },
      { id: 'C03', title: 'Sync', dirSuffix: 'sync', repo: 'alpha' },
    ],
    ...extra,
  });
}

export const fmOf = (dir, rel) => parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).fm;

export const BYSTANDER = 'stories/S1-bystander/index.md';

/** A git-backed backlog: C01 (alpha's home) with S-1 (bystander), feature F-1. */
export function gitNewBacklog() {
  const t = componentBacklog({
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'Bystander',
        dirSuffix: 'bystander',
      },
    ],
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites' }],
  });
  initGitBacklog(t.dir);
  dirtyBystanders(t.dir, BYSTANDER);
  return t;
}

export const NEW_IN_C01 = ['new', 'C01', '--points', '1'];

/**
 * A git-backed backlog: C01 with S-1 (in feature F-1) and S-2 (in no
 * feature), no edge between them.
 */
export function gitEdgeBacklog() {
  const t = componentBacklog({
    stories: [
      { id: 'S-1', component: 'C01', title: 'Later', dirSuffix: 'later', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Also later', dirSuffix: 'also-later' },
    ],
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites' }],
  });
  initGitBacklog(t.dir);
  return t;
}

/** Write a two-story spec into C01 and return its path. */
export function writeSpec(dir) {
  mkdirSync(join(dir, 'plan'), { recursive: true });
  writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
  writeFileSync(join(dir, 'plan', 'b.md'), '## Summary\n\nB.\n');
  const specPath = join(dir, 'plan', 'spec.json');
  writeFileSync(
    specPath,
    JSON.stringify({
      component: 'C01',
      stories: [
        { id: 'a', title: 'Alpha', points: 1, body_file: 'a.md' },
        { id: 'b', title: 'Bravo', points: 2, body_file: 'b.md', component: 'C02' },
      ],
    }),
  );
  return specPath;
}
