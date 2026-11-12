import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { git } from '../helpers/git-backlog.js';
import { CLOSED, backlog, bl, list, read } from '../helpers/rank-fixture.js';

test('rank_retry_reconciles_closed_work_units_before_edit', () => {
  // A failed cleanup commit leaves S-1 and F-2 (F-5 and S-9 taken out). Before the
  // retry, closed states change; the retry redoes the cleanup on HEAD with
  // today's closed units, then lists or edits, with every index state.
  const setStatus = (dir, file, from, to) => {
    writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').replace(`status: ${from}`, `status: ${to}`));
    git(dir, 'commit', '-q', '-m', `${file} ${to}`, '--', file);
  };
  const F2 = 'features/F2/index.md';
  const F5 = 'features/F5/index.md';
  const S9 = 'stories/S9/index.md';
  const changes = {
    'F-2 closes': { apply: (d) => setStatus(d, F2, 'draft', 'done'), removed: ['F-5', 'F-2', 'S-9'], back: [] },
    'F-5 reopens': { apply: (d) => setStatus(d, F5, 'done', 'draft'), removed: ['S-9'], back: ['F-5'] },
    'F-2 closes, F-5 reopens': {
      apply: (d) => {
        setStatus(d, F2, 'draft', 'done');
        setStatus(d, F5, 'done', 'draft');
      },
      removed: ['F-2', 'S-9'],
      back: ['F-5'],
    },
  };
  const modes = { bare: [], edit: ['S-2', '--top'], remove: ['F-2', '--remove'] };
  for (const [change, c] of Object.entries(changes)) {
    for (const [mode, args] of Object.entries(modes)) {
      for (const staged of [true, false]) {
        const label = `${change} / ${mode} / ${staged ? 'staged' : 'unstaged'}`;
        const dir = backlog(CLOSED);
        const hook = join(dir, '.git', 'hooks', 'pre-commit');
        mkdirSync(dirname(hook), { recursive: true });
        writeFileSync(hook, '#!/bin/sh\nexit 1\n');
        chmodSync(hook, 0o755);
        assert.equal(bl(['rank'], dir).status, 1, label);
        unlinkSync(hook);
        if (!staged) git(dir, 'reset', '-q', '--', 'priority.yaml');
        c.apply(dir);
        const before = git(dir, 'rev-parse', 'HEAD');

        const r = bl(['rank', ...args], dir);
        assert.equal(r.status, 0, `${label}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /uncommitted|left/, label);
        const file = read(dir);
        for (const id of c.removed) assert.doesNotMatch(file, new RegExp(`^- ${id}$`, 'm'), `${label}: ${id} out`);
        for (const id of c.back) assert.match(file, new RegExp(`^- ${id}$`, 'm'), `${label}: ${id} back`);
        if (c.back.length > 0) assert.match(r.stderr, new RegExp(`${c.back.join(', ')} open again`), label);
        const subjects = git(dir, 'log', '--format=%s', `${before}..HEAD`).split('\n').filter(Boolean);
        const cleaned = c.removed.length > 0 ? [`chore: ${c.removed.join(', ')} unranked (done) in priority.yaml`] : [];
        const removedByCleanup = mode === 'remove' && c.removed.includes('F-2');
        const edits = { bare: [], edit: ['chore: S-2 ranked first in priority.yaml'], remove: [] };
        edits.remove = removedByCleanup ? [] : ['chore: F-2 unranked in priority.yaml'];
        assert.deepEqual(subjects, [...edits[mode], ...cleaned], label);
        assert.equal(git(dir, 'status', '--porcelain'), '', label);
        if (mode === 'bare')
          assert.doesNotMatch(r.stdout, /Not yet ranked[\s\S]*F-5/, `${label}: F-5 listed as ranked`);
      }
    }
  }

  // When every unit the write took out is open again, the write looks like a
  // failed `--remove` edit or a hand edit: a bare run leaves it, and an edit
  // asks for it to be committed or discarded.
  for (const [mode, args] of Object.entries(modes)) {
    const dir = backlog(CLOSED);
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    assert.equal(bl(['rank'], dir).status, 1, mode);
    unlinkSync(hook);
    setStatus(dir, F5, 'done', 'draft');
    setStatus(dir, S9, 'done', 'draft');
    const before = git(dir, 'rev-parse', 'HEAD');
    const r = bl(['rank', ...args], dir);
    assert.equal(r.status, mode === 'bare' ? 0 : 1, `all reopen / ${mode}: ${r.stderr}`);
    if (mode !== 'bare') assert.match(r.stderr, /commit or discard them first/, mode);
    assert.equal(read(dir), list('S-1', 'F-2'), `all reopen / ${mode}: the pending write stays`);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before, mode);
  }
});
