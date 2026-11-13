/**
 * Integration tests for the run gate (F-66 D3): `bl run` and `bl implement`
 * refuse a target held at `run` by an unmet `blockers.json` edge, naming the
 * blocker; a wildcard edge with `active_when` holds nothing until its unit
 * is done; several targets are refused before any gate check (F-125
 * Decision A3). `--plan` keeps every run to its plan, so nothing is prepared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';

/**
 * Refined S-1 and S-2, the blocker S-3 and S-5 (the `active_when` unit),
 * both in progress, all in one repo, `code`; `edges` in blockers.json.
 */
function fixture(edges) {
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code' } },
    components: [{ id: 'C00', title: 'code', dirSuffix: 'code', repo: 'code', home: true }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', status: 'refined' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', status: 'refined' },
      { id: 'S-3', component: 'C00', title: 'Blocker', dirSuffix: 'blocker', status: 'in_progress' },
      { id: 'S-5', component: 'C00', title: 'Trigger', dirSuffix: 'trigger', status: 'in_progress' },
    ],
  });
  const repo = join(dir, 'code');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  spawnSync(
    'git',
    ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  writeBlockersLocked(dir, edges);
  return { dir, cleanup };
}

const bl = (dir, args) => runBl(args, { cwd: dir });

function setStatus(dir, entry, from, to) {
  const path = join(dir, 'stories', entry, 'index.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(`status: ${from}`, `status: ${to}`));
}

test('a wildcard run edge with active_when holds nothing until its unit is done, then refuses bl run and bl implement naming the blocker', () => {
  const fx = fixture([
    { blocker: 'S-3', gate: 'run', unit: '*', until: 'done', active_when: { unit: 'S-5', status: 'done' } },
  ]);
  try {
    let r = bl(fx.dir, ['run', '--plan', 'S-1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^S-1 · One — run plan$/m);
    assert.doesNotMatch(bl(fx.dir, ['status', 'S-1']).stdout, /^held:/m);

    setStatus(fx.dir, 'S5-trigger', 'in_progress', 'done');
    const want = 'S-1 is held at run by S-3 (in_progress, needs done)\nnext: bl status S-3\n';
    r = bl(fx.dir, ['run', '--plan', 'S-1']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, want);
    assert.equal(r.stdout, '');
    r = bl(fx.dir, ['implement', 'S-1']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, want);

    // bl status is never held, and shows the hold.
    r = bl(fx.dir, ['status', 'S-1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^held: S-1 is held at run by S-3 \(in_progress, needs done\)$/m);

    // The blocker moving on lifts the hold.
    setStatus(fx.dir, 'S3-blocker', 'in_progress', 'done');
    r = bl(fx.dir, ['run', '--plan', 'S-1']);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fx.cleanup();
  }
});

test('several targets are refused before the gate check, naming bl batch (F-125 Decision A3)', () => {
  const fx = fixture([{ blocker: 'S-3', gate: 'run', unit: 'S-1', until: 'done' }]);
  try {
    for (const verb of ['run', 'implement']) {
      const r = bl(fx.dir, [verb, '--plan', 'S-1', 'S-2']);
      assert.equal(r.status, 1, verb);
      assert.match(r.stderr, new RegExp(`^bl ${verb}: takes one target; .*bl batch`), verb);
      assert.doesNotMatch(r.stderr, /held at run/, `${verb}: no gate check`);
      assert.equal(r.stdout, '', verb);
    }
  } finally {
    fx.cleanup();
  }
});

test('a next task (bl task --gate next) holds nothing while its unit is open, then holds bl run and bl implement of every unit until bl task done', () => {
  const fx = fixture([]);
  try {
    let r = bl(fx.dir, ['task', 'S-5', '--gate', 'next', '--title', 'Reinstall the browsers']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(fx.dir, 'blockers.json'), 'utf8')).edges, [
      { blocker: 'T-1', gate: 'run', unit: '*', until: 'done', active_when: { unit: 'S-5', status: 'done' } },
    ]);
    r = bl(fx.dir, ['run', '--plan', 'S-1']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(bl(fx.dir, ['inbox']).stdout, /holds:/, 'an inactive edge holds nothing');

    setStatus(fx.dir, 'S5-trigger', 'in_progress', 'done');
    for (const args of [
      ['run', '--plan', 'S-1'],
      ['implement', 'S-2'],
    ]) {
      r = bl(fx.dir, args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /^S-[12] is held at run by T-1 \(draft, needs done\)\nnext: bl status T-1\n$/);
    }
    assert.match(
      bl(fx.dir, ['inbox']).stdout,
      /^  T-1 +S-5 +Reinstall the browsers\n +holds: bl run, bl implement \(every unit\)\n/m,
    );

    r = bl(fx.dir, ['task', 'done', 'T-1', 'reinstalled']);
    assert.equal(r.status, 0, r.stderr);
    r = bl(fx.dir, ['run', '--plan', 'S-1']);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fx.cleanup();
  }
});
