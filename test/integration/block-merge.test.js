import { spawnSync } from 'child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { git, initGitBacklog } from '../helpers/git-backlog.js';
import { BLOCKERS_FILE, formatBlockers, readBlockers } from '../../src/blockers.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { backlog, bl } from '../helpers/block-fixture.js';

test("bl block add and remove on two clones merge without a conflict wherever the edges land, by git merge and by bl's pull", () => {
  const on = (unit) => ({ blocker: 'S-1', gate: 'merge', unit, until: 'done' });
  const add = (unit) => ['block', 'add', 'S-1', '--gate', 'merge', '--unit', unit, '--until', 'done'];
  const remove = (unit) => ['block', 'remove', 'S-1', '--gate', 'merge', '--unit', unit];
  // Each: the seeded edges, Alice's and Bob's commands, and the edges after.
  const cases = [
    { name: 'empty graph', seed: [], alice: add('F-2'), bob: add('F-4'), want: ['F-2', 'F-4'] },
    { name: 'both before the first', seed: ['F-5'], alice: add('F-2'), bob: add('F-4'), want: ['F-2', 'F-4', 'F-5'] },
    { name: 'both after the last', seed: ['F-1'], alice: add('F-2'), bob: add('F-4'), want: ['F-1', 'F-2', 'F-4'] },
    {
      name: 'one interior gap',
      seed: ['F-1', 'F-5'],
      alice: add('F-2'),
      bob: add('F-4'),
      want: ['F-1', 'F-2', 'F-4', 'F-5'],
    },
    {
      name: 'gaps apart',
      seed: ['F-1', 'F-3', 'F-5'],
      alice: add('F-2'),
      bob: add('F-4'),
      want: ['F-1', 'F-2', 'F-3', 'F-4', 'F-5'],
    },
    { name: 'remove beside an add', seed: ['F-1', 'F-3'], alice: remove('F-3'), bob: add('F-4'), want: ['F-1', 'F-4'] },
    { name: 'both remove one edge', seed: ['F-1', 'F-3'], alice: remove('F-3'), bob: remove('F-3'), want: ['F-1'] },
    {
      name: 'two removes side by side',
      seed: ['F-1', 'F-3', 'F-5'],
      alice: remove('F-3'),
      bob: remove('F-5'),
      want: ['F-1'],
    },
  ];
  for (const how of ['git merge', 'bl pull']) {
    for (const c of cases) {
      const at = `${c.name}, ${how}`;
      const { dir: alice } = backlog({
        features: ['F-3', 'F-4', 'F-5'].map((id) => ({ id, title: id, status: 'approved' })),
      });
      const tmp = mkTempDir('bl-block-clones-');
      try {
        initGitBacklog(alice);
        writeBlockersLocked(alice, c.seed.map(on));
        git(alice, 'add', BLOCKERS_FILE);
        git(alice, 'commit', '-q', '-m', 'seed edges');
        const origin = join(tmp, 'origin.git');
        const bob = join(tmp, 'bob');
        git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
        git(alice, 'remote', 'add', 'origin', origin);
        git(alice, 'push', '-q', 'origin', 'main');
        git(tmp, 'clone', '-q', origin, bob);
        // Alice's push goes nowhere, so her commit stays local while Bob's lands.
        git(alice, 'remote', 'set-url', '--push', 'origin', join(tmp, 'nowhere.git'));

        const a = bl(c.alice, alice);
        assert.equal(a.status, 0, `${at}: ${a.stderr}`);
        const b = bl(c.bob, bob);
        assert.equal(b.status, 0, `${at}: ${b.stderr}`);
        assert.equal(git(origin, 'rev-parse', 'main'), git(bob, 'rev-parse', 'HEAD'));

        let want = c.want;
        if (how === 'git merge') {
          git(alice, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
        } else {
          // bl pulls (a rebase of Alice's commit onto Bob's) before it adds.
          const bobs = git(bob, 'rev-parse', 'HEAD');
          const pulled = bl(add('S-2'), alice);
          assert.equal(pulled.status, 0, `${at}: ${pulled.stderr}`);
          // The pull rebased onto Bob's commit, not a warning and a local add.
          assert.doesNotMatch(pulled.stderr, /backlog pull|backlog fetch/, `${at}: ${pulled.stderr}`);
          const rebased = spawnSync('git', ['merge-base', '--is-ancestor', bobs, 'HEAD'], {
            cwd: alice,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          assert.equal(rebased.status, 0, `${at}: Alice's HEAD has Bob's commit: ${pulled.stderr}`);
          want = [...want, 'S-2'];
        }
        for (const clone of [alice, bob]) {
          assert.match(
            git(clone, 'show', 'HEAD:.gitattributes'),
            /^\/blockers\.json merge=bl-blockers$/m,
            `${at}: ${clone}`,
          );
        }
        const text = readFileSync(join(alice, BLOCKERS_FILE), 'utf8');
        assert.doesNotMatch(text, /<<<<<<<|>>>>>>>/, at);
        const { edges } = readBlockers(alice);
        assert.deepEqual(
          edges.map((e) => e.unit),
          want,
          at,
        );
        assert.equal(text, formatBlockers(edges), `${at}: still sorted, one edge per line`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
});
