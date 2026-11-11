/**
 * new-rollback.test.js — F-111 D5: a `bl new` whose dependency edges cannot
 * be written to `blockers.json` undoes what it wrote.
 *
 * new_edge_write_failure_restores_blockers_and_removes_the_new_stories:
 * `bl new` runs in this process with `atomicWriteFile`'s test hook failing a
 * write of `blockers.json` (the first edge's or the second's) and, in one
 * case, a created directory that cannot be removed. In every case
 * `blockers.json` is as it was, so no edge names a story that is not there,
 * and the error says what is left.
 *
 * new_edge_rollback_failure_keeps_new_stories_and_names_blockers_json: the
 * write that puts `blockers.json` back fails too, after a thrown write or a
 * refused edge. The error names `blockers.json` as left changed, and the new
 * story is kept, so no edge names a story that is not there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { _hooks } from '../../src/atomic-write.js';
import { main } from '../../src/new.js';

const SINGLE = () => ['C01', '--title', 'First', '--points', '1', '--required-for', 'S-1,S-2', '--no-sync'];
const SPEC = (dir) => {
  mkdirSync(join(dir, 'plan'), { recursive: true });
  writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
  const spec = join(dir, 'plan', 'spec.json');
  writeFileSync(
    spec,
    JSON.stringify({
      component: 'C01',
      stories: [{ id: 'base', title: 'Base', points: 1, body_file: 'a.md', required_for: ['S-1', 'S-2'] }],
    }),
  );
  return ['--from', spec, '--no-sync'];
};

// [case, the blockers.json write that fails (1 = the first edge's), the new directory is read-only, error names]
const CASES = [
  ['the first edge write fails', 1, false, /nothing is written or committed: the new stories are removed/],
  ['the second edge write fails', 2, false, /nothing is written or committed: the new stories are removed/],
  [
    'a created directory cannot be removed',
    2,
    true,
    /undoing failed, so fix these by hand: stories\/S3-\w+ is still there/,
  ],
];

for (const [how, argv] of [
  ['--required-for', SINGLE],
  ["a spec's required_for", SPEC],
]) {
  for (const [name, failAt, readOnly, message] of CASES) {
    test(`new_edge_write_failure_restores_blockers_and_removes_the_new_stories: ${how}, ${name}`, async (t) => {
      if (readOnly && process.getuid?.() === 0) return t.skip('root removes from a read-only directory');
      const { dir, cleanup } = mkTempBacklog({
        repos: ['../repos/alpha'],
        components: [{ id: 'C01', title: 'Core', repo: 'alpha', home: true }],
        stories: [
          { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one' },
          { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two' },
        ],
      });
      const cwd = process.cwd();
      const env = process.env.BL_BACKLOG_DIR;
      const newDir = () => readdirSync(join(dir, 'stories')).find((e) => e.startsWith('S3-'));
      let writes = 0;
      // The hook sees each staged file before its rename: count the blockers.json writes.
      _hooks.beforeRename = (tmp) => {
        if (!readFileSync(tmp, 'utf8').startsWith('{\n  "schema": "bl-blockers/')) return;
        if (++writes !== failAt) return;
        if (readOnly) chmodSync(join(dir, 'stories', newDir()), 0o555);
        throw new Error('injected blockers.json write failure');
      };
      let error = null;
      try {
        process.env.BL_BACKLOG_DIR = dir;
        process.chdir(dir);
        await main(argv(dir));
      } catch (e) {
        error = e;
      } finally {
        _hooks.beforeRename = null;
        process.chdir(cwd);
        if (env === undefined) delete process.env.BL_BACKLOG_DIR;
        else process.env.BL_BACKLOG_DIR = env;
        if (readOnly && newDir()) chmodSync(join(dir, 'stories', newDir()), 0o755);
      }
      try {
        assert.equal(writes, failAt, 'the failing write was reached');
        assert.ok(error, 'bl new failed');
        assert.match(
          error.message,
          /could not write the edges to blockers\.json \(injected blockers\.json write failure\)/,
        );
        assert.match(error.message, message);
        assert.equal(Boolean(newDir()), readOnly, 'new story kept only when it cannot be removed');
        assert.equal(existsSync(join(dir, 'blockers.json')), false, 'blockers.json as it was: none');
      } finally {
        cleanup();
      }
    });
  }
}

// new_edge_rollback_failure_keeps_new_stories_and_names_blockers_json: the
// edge write fails (a thrown write, or a refused edge) and so does the write
// that puts blockers.json back. [case, argv, the error names]
const ROLLBACK_CASES = [
  [
    'the second edge write throws',
    SINGLE,
    /\(injected blockers\.json write failure; could not put back blockers\.json/,
  ],
  [
    'the second edge is refused',
    () => ['C01', '--title', 'First', '--points', '1', '--depends-on', 'S-1', '--required-for', 'S-1', '--no-sync'],
    /would close a deadlock.*; could not put back blockers\.json \(injected/,
  ],
];

for (const [name, argv, message] of ROLLBACK_CASES) {
  test(`new_edge_rollback_failure_keeps_new_stories_and_names_blockers_json: ${name}`, async () => {
    const { dir, cleanup } = mkTempBacklog({
      repos: ['../repos/alpha'],
      components: [{ id: 'C01', title: 'Core', repo: 'alpha', home: true }],
      stories: [
        { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one' },
        { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two' },
      ],
    });
    const blockers = join(dir, 'blockers.json');
    writeFileSync(
      blockers,
      '{\n  "schema": "bl-blockers/v2",\n  "edges": [\n    {"blocker":"S-1","gate":"run","unit":"S-2","until":"done"}\n  ]\n}\n',
    );
    const cwd = process.cwd();
    const env = process.env.BL_BACKLOG_DIR;
    const newDir = () => readdirSync(join(dir, 'stories')).find((e) => e.startsWith('S3-'));
    let writes = 0;
    // Every blockers.json write after the first fails: the second edge's and the one that puts it back.
    _hooks.beforeRename = (tmp) => {
      if (!readFileSync(tmp, 'utf8').startsWith('{\n  "schema": "bl-blockers/')) return;
      if (++writes >= 2) throw new Error('injected blockers.json write failure');
    };
    let error = null;
    try {
      process.env.BL_BACKLOG_DIR = dir;
      process.chdir(dir);
      await main(argv(dir));
    } catch (e) {
      error = e;
    } finally {
      _hooks.beforeRename = null;
      process.chdir(cwd);
      if (env === undefined) delete process.env.BL_BACKLOG_DIR;
      else process.env.BL_BACKLOG_DIR = env;
    }
    try {
      assert.ok(error, 'bl new failed');
      assert.match(error.message, message);
      assert.match(error.message, /so it is left changed/);
      assert.match(
        error.message,
        /fix these by hand: blockers\.json; stories\/S3-\w+ kept, since an edge in blockers\.json may name it/,
      );
      assert.doesNotMatch(error.message, /nothing is written/);
      // Every edge left in blockers.json names a story that is there.
      const ids = readdirSync(join(dir, 'stories')).map((e) => `S-${e.match(/^S(\d+)/)[1]}`);
      for (const e of JSON.parse(readFileSync(blockers, 'utf8')).edges) {
        assert.ok(ids.includes(e.blocker) && ids.includes(e.unit), `${JSON.stringify(e)} names stories that are there`);
      }
      assert.ok(newDir(), 'the new story is kept');
    } finally {
      cleanup();
    }
  });
}
