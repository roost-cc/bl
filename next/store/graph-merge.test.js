/**
 * Two clones of one backlog that change the same graph files (F-148 D4, D6):
 * each writes through the store write, which adds the graph lines to
 * `.gitattributes` and names `bl-merge-driver` in the clone's git config, and
 * the second clone's `git pull --rebase` merges each graph file by key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fixture, load } from '../test/helpers/config-fixture.js';
import { cloneRepo, git, initRepo } from '../test/helpers/git.js';
import { storeWrite } from './write.js';

const STORY = 'dir: stories\nparents:\n  - { name: unit, types: [feature], min: 0, max: 1 }\n';

/** `value` as the store writes JSON. */
const jsonOf = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A backlog with the features F-1 and F-2 and the stories S-1 to S-4 (each
 * only its document: no write here changes them), one graph of each engine,
 * a containment file and a rank file but no dependency file, and a
 * `.gitattributes` with a line of its own.
 */
const FILES = {
  'backlog.yaml': [
    'color_scheme: mocha',
    'repos: {}',
    'id_prefixes:',
    '  S: story',
    '  F: feature',
    'work_types: [feature, story]',
    'graphs:',
    '  - { name: containment, engine: containment, nodes: [story, feature] }',
    '  - { name: dependency, engine: dependency, nodes: [story, feature] }',
    '  - { name: rank, engine: rank, nodes: [story, feature] }',
    '',
  ].join('\n'),
  'config/items/story.yaml': STORY,
  'config/items/feature.yaml': 'dir: features\n',
  '.gitignore': '.bl/\n',
  '.gitattributes': '*.md text\n',
  'features/F1-one/index.md': '# One\n',
  'features/F2-two/index.md': '# Two\n',
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [`stories/S${n}-s/index.md`, `# S${n}\n`])),
  'graphs/containment.json': jsonOf({ 'S-2': { unit: 'F-1' } }),
  'graphs/rank.json': jsonOf(['F-1']),
};

/**
 * The origin of a backlog of FILES, a bare repo, and two clones of it, Alice's
 * and Bob's, each a store context.
 */
function clones() {
  const dirs = fixture(Object.fromEntries(Object.entries(FILES).map(([path, text]) => [`backlog/${path}`, text])));
  initRepo(dirs.backlogDir);
  git(dirs.backlogDir, 'add', '.');
  git(dirs.backlogDir, 'commit', '-q', '-m', 'init');
  const origin = join(dirs.home, 'origin.git');
  git(dirs.home, 'clone', '-q', '--bare', dirs.backlogDir, origin);
  const clone = (/** @type {string} */ name) => {
    const backlogDir = join(dirs.home, name);
    cloneRepo(origin, backlogDir);
    return { backlogDir, config: load({ ...dirs, backlogDir }) };
  };
  return { alice: clone('alice'), bob: clone('bob') };
}

const read = (ctx, path) => readFileSync(join(ctx.backlogDir, path), 'utf8');

test('two clones that each add a containment entry, a dependency entry and a rank node merge with no conflict', async () => {
  const { alice, bob } = clones();
  await storeWrite(alice, { message: 'alice' }, (w) => {
    w.graph('containment', (g) => ({ ...g, 'S-1': { unit: 'F-1' } }));
    w.graph('dependency', (g) => ({ ...g, 'S-1': { in_progress: [{ 'S-2': 'status == "done"' }] } }));
    w.graph('rank', (g) => [...g, 'F-2']);
  });
  git(alice.backlogDir, 'push', '-q', 'origin', 'main');
  // Bob writes the three graphs in the other order, one write each.
  await storeWrite(bob, { message: 'bob rank' }, (w) => w.graph('rank', (g) => [...g, 'S-3']));
  await storeWrite(bob, { message: 'bob dependency' }, (w) =>
    w.graph('dependency', (g) => ({ ...g, 'F-1': { done: [{ 'S-3': 'true' }] } })),
  );
  await storeWrite(bob, { message: 'bob containment' }, (w) =>
    w.graph('containment', (g) => ({ ...g, 'S-4': { unit: 'F-2' } })),
  );

  git(bob.backlogDir, 'pull', '-q', '--rebase', 'origin', 'main');

  assert.equal(
    read(bob, 'graphs/containment.json'),
    jsonOf({ 'S-1': { unit: 'F-1' }, 'S-2': { unit: 'F-1' }, 'S-4': { unit: 'F-2' } }),
  );
  assert.equal(
    read(bob, 'graphs/dependency.json'),
    jsonOf({ 'F-1': { done: [{ 'S-3': 'true' }] }, 'S-1': { in_progress: [{ 'S-2': 'status == "done"' }] } }),
  );
  // In a rebase, ours is the upstream side: Alice's node, which reached origin first, comes first.
  assert.equal(read(bob, 'graphs/rank.json'), jsonOf(['F-1', 'F-2', 'S-3']));
  assert.equal(
    read(bob, '.gitattributes'),
    [
      '*.md text',
      '/graphs/containment.json merge=bl-graph-containment',
      '/graphs/dependency.json merge=bl-graph-dependency',
      '/graphs/rank.json merge=bl-graph-rank',
      '',
    ].join('\n'),
  );
  assert.equal(
    git(bob.backlogDir, 'log', '--format=%s').split('\n').join(' '),
    'bob containment bob dependency bob rank alice init',
  );
  assert.equal(git(bob.backlogDir, 'status', '--porcelain'), '');
});

test('a containment slot that the two clones set to different parents leaves conflict markers, and the pull stops', async () => {
  const { alice, bob } = clones();
  await storeWrite(alice, { message: 'alice' }, (w) =>
    w.graph('containment', (g) => ({ ...g, 'S-1': { unit: 'F-1' } })),
  );
  git(alice.backlogDir, 'push', '-q', 'origin', 'main');
  await storeWrite(bob, { message: 'bob' }, (w) => w.graph('containment', (g) => ({ ...g, 'S-1': { unit: 'F-2' } })));

  assert.throws(() => git(bob.backlogDir, 'pull', '-q', '--rebase', 'origin', 'main'), /could not apply .* bob/);

  // The labels `ours` and `theirs` are the driver's (`git merge-file -L`), not git's own line merge.
  assert.match(read(bob, 'graphs/containment.json'), /^<{7} ours\n[^]*"F-1"[^]*\n={7}\n[^]*"F-2"[^]*\n>{7} theirs$/m);
  assert.ok(existsSync(join(bob.backlogDir, '.git', 'rebase-merge')), 'the rebase stops at the conflict');
  assert.equal(git(bob.backlogDir, 'diff', '--name-only', '--diff-filter=U'), 'graphs/containment.json');
});
