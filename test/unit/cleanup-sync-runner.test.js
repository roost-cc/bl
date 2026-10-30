/**
 * Unit tests for the backlog-sync runner `bl merge` picks once the primary
 * repo has merged (S-864): a child `node <bl>/src/bl.js sync --commit …` when
 * the primary is `bl` itself, the in-process `syncAndCommit` otherwise. The
 * file reader, the existence check and the process runner are injected, so no
 * file system or child process is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseSyncRunner,
  syncChildArgs,
  runBacklogSync,
  landedCommitMap,
  unionLandedCommits,
} from '../../src/cleanup.js';

// The `commit:` value a merge reads back when it starts (S-864): a map of
// repos earlier runs landed is carried on; every other shape starts empty.
for (const [name, commit, expected] of [
  ['a landed-repo map', { alpha: '1111111' }, { alpha: '1111111' }],
  ["a done story's bare string", '1111111', {}],
  ['no commit at all', undefined, {}],
  ['a null commit', null, {}],
  ['an empty string', '', {}],
  ['a list', ['1111111'], {}],
  [
    'a map with an empty or non-string entry keeps only the SHAs',
    { alpha: '1111111', beta: '', gamma: null },
    { alpha: '1111111' },
  ],
]) {
  test(`landedCommitMap: ${name}`, () => {
    const out = landedCommitMap(commit);
    assert.deepEqual(out, expected);
    if (commit && typeof commit === 'object') {
      assert.notEqual(out, commit, 'returns a copy, never the parsed object');
    }
  });
}

// The union a write decides from (S-868): every `commit:` shape on disk
// against this run's exact landings and no-branch tips. The disk's SHA for a
// repo beats a tip; an exact landing beats the disk; a bare string is the one
// repo's SHA when the run names exactly one repo, and nothing otherwise.
for (const [name, onDisk, landed, tips, expected] of [
  ['unset', undefined, {}, { alpha: 'tip1111' }, { alpha: 'tip1111' }],
  ['null', null, {}, { alpha: 'tip1111' }, { alpha: 'tip1111' }],
  ['an empty string', '', {}, { alpha: 'tip1111' }, { alpha: 'tip1111' }],
  ['an empty map', {}, {}, { alpha: 'tip1111' }, { alpha: 'tip1111' }],
  [
    'a multi-repo map keeps its SHA over the tip and gains the landing',
    { alpha: 'aaa1111', beta: 'bbb2222' },
    { gamma: 'ccc3333' },
    { alpha: 'tip1111' },
    { alpha: 'aaa1111', beta: 'bbb2222', gamma: 'ccc3333' },
  ],
  [
    'a bare string beats the tip of the one repo the run names',
    'aaa1111',
    {},
    { alpha: 'tip1111' },
    { alpha: 'aaa1111' },
  ],
  [
    'a bare string yields to the exact landing of the one repo',
    'aaa1111',
    { alpha: 'new1111' },
    {},
    { alpha: 'new1111' },
  ],
  [
    'a bare string is ignored when the run names several repos',
    'aaa1111',
    { alpha: 'new1111' },
    { beta: 'tip2222' },
    { alpha: 'new1111', beta: 'tip2222' },
  ],
  ['a bare string with nothing to record stays out of the map', 'aaa1111', {}, {}, {}],
  ['a list', ['aaa1111'], {}, { alpha: 'tip1111' }, { alpha: 'tip1111' }],
  ['a number', 1111111, {}, { alpha: 'tip1111' }, { alpha: 'tip1111' }],
  [
    'a map whose entry for the repo is empty or not a string',
    { alpha: '', beta: null },
    {},
    { alpha: 'tip1111', beta: 'tip2222' },
    { alpha: 'tip1111', beta: 'tip2222' },
  ],
]) {
  test(`unionLandedCommits: ${name}`, () => {
    assert.deepEqual(unionLandedCommits(onDisk, landed, tips), expected);
  });
}

/** A fake file system: JSON files by path; any listed path exists. */
function files(map) {
  return {
    readJson: (path) => {
      if (!(path in map)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      if (map[path] instanceof Error) throw map[path];
      return map[path];
    },
    exists: (path) => path in map,
  };
}

test('chooseSyncRunner: a bl package with src/bl.js runs the sync in a child', () => {
  const out = chooseSyncRunner({
    primaryRepoPath: '/r/bl',
    ...files({ '/r/bl/package.json': { name: 'bl' }, '/r/bl/src/bl.js': true }),
  });
  assert.deepEqual(out, { kind: 'child', blEntry: '/r/bl/src/bl.js' });
});

test('chooseSyncRunner: any other package stays in process', () => {
  const out = chooseSyncRunner({
    primaryRepoPath: '/r/app',
    ...files({
      '/r/app/package.json': { name: 'app.acme.com' },
      '/r/app/src/bl.js': true,
    }),
  });
  assert.deepEqual(out, { kind: 'in-process' });
});

test('chooseSyncRunner: a missing package.json stays in process', () => {
  const out = chooseSyncRunner({
    primaryRepoPath: '/r/docs',
    ...files({ '/r/docs/src/bl.js': true }),
  });
  assert.deepEqual(out, { kind: 'in-process' });
});

test('chooseSyncRunner: an unparseable package.json stays in process', () => {
  const out = chooseSyncRunner({
    primaryRepoPath: '/r/bl',
    ...files({
      '/r/bl/package.json': new SyntaxError('Unexpected token'),
      '/r/bl/src/bl.js': true,
    }),
  });
  assert.deepEqual(out, { kind: 'in-process' });
});

test('chooseSyncRunner: a bl package without src/bl.js stays in process', () => {
  const out = chooseSyncRunner({
    primaryRepoPath: '/r/bl',
    ...files({ '/r/bl/package.json': { name: 'bl' } }),
  });
  assert.deepEqual(out, { kind: 'in-process' });
});

test('chooseSyncRunner: no primary repo stays in process', () => {
  assert.deepEqual(chooseSyncRunner({ primaryRepoPath: null, ...files({}) }), {
    kind: 'in-process',
  });
  assert.deepEqual(chooseSyncRunner({ primaryRepoPath: undefined, ...files({}) }), { kind: 'in-process' });
});

test('syncChildArgs: bl sync --commit with the message and one --story per id', () => {
  assert.deepEqual(
    syncChildArgs('/r/bl/src/bl.js', {
      message: 'chore: sync backlog after merging bl (S-1)',
      storyIds: ['S-1', 'S-2'],
    }),
    [
      '/r/bl/src/bl.js',
      'sync',
      '--commit',
      '-m',
      'chore: sync backlog after merging bl (S-1)',
      '--story',
      'S-1',
      '--story',
      'S-2',
    ],
  );
});

test('syncChildArgs: no story id is a caller bug, refused before the child would (F-62 merge)', () => {
  assert.throws(
    () => syncChildArgs('/r/bl/src/bl.js', { message: 'chore: sync backlog with the merged bl (F-62)' }),
    /at least one story id/,
  );
});

test('runBacklogSync: the child runs node on the bl entry from the backlog root', async () => {
  const calls = [];
  const exec = (file, args, opts) => {
    calls.push({ file, args, opts });
  };
  const res = await runBacklogSync(
    { backlogRoot: '/b' },
    { kind: 'child', blEntry: '/r/bl/src/bl.js' },
    { message: 'chore: mark S-9 done, sync backlog', storyIds: ['S-9'] },
    exec,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [
    '/r/bl/src/bl.js',
    'sync',
    '--commit',
    '-m',
    'chore: mark S-9 done, sync backlog',
    '--story',
    'S-9',
  ]);
  assert.equal(calls[0].opts.cwd, '/b');
  assert.equal(calls[0].opts.env, process.env);
  assert.equal(calls[0].opts.stdio[0], 'inherit');
  assert.deepEqual(res, { committed: false, paths: [], child: true });
});

test('runBacklogSync: a failing child reports its exit status instead of throwing', async () => {
  const exec = () => {
    throw Object.assign(new Error('Command failed'), { status: 1 });
  };
  const res = await runBacklogSync(
    { backlogRoot: '/b' },
    { kind: 'child', blEntry: '/r/bl/src/bl.js' },
    {
      message: 'chore: sync backlog after merging bl (S-9)',
      storyIds: ['S-9'],
    },
    exec,
  );
  assert.equal(res.committed, false);
  assert.deepEqual(res.paths, []);
  assert.equal(res.child, true);
  assert.equal(res.error, 'child bl sync exited 1');
  // The command to re-run by hand, quoted where the shell needs it.
  assert.match(res.command, /^node \/r\/bl\/src\/bl\.js sync --commit -m '/);
  assert.match(res.command, /--story S-9$/);
});

test('runBacklogSync: a child that could not start reports the spawn error', async () => {
  const exec = () => {
    throw new Error('spawn ENOENT');
  };
  const res = await runBacklogSync(
    { backlogRoot: '/b' },
    { kind: 'child', blEntry: '/r/bl/src/bl.js' },
    { message: 'm', storyIds: ['S-9'] },
    exec,
  );
  assert.equal(res.error, 'child bl sync failed: spawn ENOENT');
  assert.match(res.command, /^node \/r\/bl\/src\/bl\.js sync /);
});
