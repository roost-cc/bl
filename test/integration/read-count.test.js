/**
 * read-count.test.js — F-77 D2: a command reads each unit file at most once
 * per run unless the file changed. `bl list` and `bl validate` run on a
 * fixture under `count-reads.js`, which records every `fs.readFileSync`;
 * each unit file (a story's, feature's, component's, theme's or epic's
 * `index.md`, or a task file) must be read exactly once: once, because every
 * reader projects the one graph (`loadBacklog`), and not zero, so the count
 * is known to see the reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { REPO_ROOT, runBl } from '../helpers/run-bl.js';

const COUNTER = pathToFileURL(join(REPO_ROOT, 'test', 'helpers', 'count-reads.js')).href;

/** A backlog with every kind of unit, its files' mtimes an hour back (no racy rereads). */
function fixture() {
  const { dir } = mkTempBacklog({
    repos: ['../bl'],
    components: [
      { id: 'C01', title: 'Core', dirSuffix: 'core', repo: 'bl', home: true },
      { id: 'C02', title: 'Docs', dirSuffix: 'docs', repo: 'bl' },
    ],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', status: 'done', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', depends_on: 'S-1', feature: 'F-1' },
      { id: 'S-3', component: 'C02', title: 'Three', status: 'refined' },
    ],
    features: [{ id: 'F-1', title: 'Feature', dirSuffix: 'feature', status: 'approved', stories: ['S-1', 'S-2'] }],
    valueEpics: [{ id: 'E50', title: 'Epic', dirSuffix: 'epic' }],
  });
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, 'tasks', 'T1-check.md'),
    '---\ntask_id: T-1\ntitle: Check\nunit: F-1\nowner: operator\nstatus: open\nadded: 2026-11-05\n---\n\n# T-1 · Check\n',
  );
  const old = new Date(Date.now() - 3600_000);
  for (const file of unitFiles(dir)) utimesSync(file, old, old);
  return dir;
}

/** Every unit file of the backlog at `dir`, by listing it. */
function unitFiles(dir) {
  const out = [];
  for (const kind of ['stories', 'features', 'components', 'themes', 'epics']) {
    for (const entry of readdirSync(join(dir, kind), { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(join(dir, kind, entry.name, 'index.md'));
    }
  }
  for (const entry of readdirSync(join(dir, 'tasks'))) out.push(join(dir, 'tasks', entry));
  return out.sort();
}

/** `bl <args>` under the counter: how often each unit file was read, per process. */
function unitReads(dir, args) {
  const log = join(mkTempDir('bl-reads-'), 'reads.jsonl');
  const r = runBl(args, { cwd: dir, env: { NODE_OPTIONS: `--import=${COUNTER}`, BL_COUNT_READS: log } });
  assert.ok(r.status === 0 || r.status === 1, `bl ${args.join(' ')}: ${r.status}\n${r.stderr}`);
  const roots = [dir, realpathSync(dir)];
  const units = new Set(unitFiles(dir).map((f) => relative(dir, f)));
  const perProcess = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return perProcess.map(({ reads }) => {
    const counts = {};
    for (const path of reads) {
      const root = roots.find((p) => path.startsWith(`${p}/`));
      const rel = root ? relative(root, path) : null;
      if (rel && units.has(rel)) counts[rel] = (counts[rel] ?? 0) + 1;
    }
    return counts;
  });
}

for (const args of [['list', '--all'], ['validate']]) {
  test(`bl ${args[0]} reads every unit file once (F-77 D2)`, () => {
    const dir = fixture();
    const want = Object.fromEntries(unitFiles(dir).map((f) => [relative(dir, f), 1]));
    // bl runs as one node process; a helper process would show up as another line.
    const [main, ...others] = unitReads(dir, args);
    assert.deepEqual(main, want);
    for (const counts of others) {
      assert.ok(
        Object.values(counts).every((n) => n <= 1),
        JSON.stringify(counts),
      );
    }
  });
}

test('a unit file changed between two loads in one process is read again, and only it', async () => {
  const dir = fixture();
  const { loadBacklog } = await import('../../src/backlog-graph.js');
  const { syncBuiltinESMExports } = await import('node:module');
  const fs = (await import('node:fs')).default;
  const original = fs.readFileSync;
  const reads = [];
  fs.readFileSync = function (path, ...rest) {
    if (typeof path === 'string') reads.push(relative(dir, path));
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    loadBacklog({ backlogRoot: dir });
    const first = reads.length;
    loadBacklog({ backlogRoot: dir });
    assert.equal(reads.length, first, 'nothing changed: nothing read');
    const story = join(dir, 'stories', 'S3', 'index.md');
    writeFileSync(`${story}.new`, original(story, 'utf8').replace('status: refined', 'status: backlog'));
    fs.renameSync(`${story}.new`, story);
    loadBacklog({ backlogRoot: dir });
    assert.deepEqual(reads.slice(first), ['stories/S3/index.md']);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
});
