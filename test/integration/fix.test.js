import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { startTokenWriter } from '../helpers/token-writer.js';

function readStory(td, storyEntry) {
  return readFileSync(join(td.dir, 'stories', storyEntry, 'index.md'), 'utf8');
}

function storyMtime(td, storyEntry) {
  return statSync(join(td.dir, 'stories', storyEntry, 'index.md')).mtimeMs;
}

test('bl fix writes inverse required_for for one-sided depends_on', async () => {
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
      { id: 'S-2', component: 'C01', title: 'b' },
    ],
  });
  const before = readStory(td, 'S2');
  const r = await runBl(['fix'], { cwd: td.dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /asymmetric-dep: added S-1 to required_for/);
  assert.match(r.stdout, /1 fix applied/);

  const after = readStory(td, 'S2');
  assert.notEqual(after, before);
  assert.match(after, /^required_for: \[S-1\]$/m);
  // Body untouched
  assert.ok(after.endsWith('\n'));
  td.cleanup();
});

test('bl fix writes inverse depends_on for one-sided required_for', async () => {
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        required_for: 'S-2',
      },
      { id: 'S-2', component: 'C01', title: 'b' },
    ],
  });
  const r = await runBl(['fix'], { cwd: td.dir });
  assert.equal(r.status, 0, r.stderr);
  const after = readStory(td, 'S2');
  assert.match(after, /^depends_on: \[S-1\]$/m);
  td.cleanup();
});

test('bl fix is idempotent — second run is a no-op', async () => {
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
      { id: 'S-2', component: 'C01', title: 'b' },
    ],
  });
  const r1 = await runBl(['fix'], { cwd: td.dir });
  assert.equal(r1.status, 0);
  const m1 = storyMtime(td, 'S2');
  // tiny pause to make any further mtime change visible
  await new Promise((res) => setTimeout(res, 20));
  const r2 = await runBl(['fix'], { cwd: td.dir });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.trim(), '');
  const m2 = storyMtime(td, 'S2');
  assert.equal(m2, m1, 'mtime changed on idempotent re-run');
  td.cleanup();
});

test('bl fix --dry-run writes nothing and prints a plan', async () => {
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
      { id: 'S-2', component: 'C01', title: 'b' },
    ],
  });
  const before = storyMtime(td, 'S2');
  const beforeText = readStory(td, 'S2');
  await new Promise((res) => setTimeout(res, 20));
  const r = await runBl(['fix', '--dry-run'], { cwd: td.dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would fix/);
  assert.match(r.stdout, /would add S-1 to required_for/);
  const after = storyMtime(td, 'S2');
  assert.equal(after, before, 'dry-run mutated mtime');
  assert.equal(readStory(td, 'S2'), beforeText);
  td.cleanup();
});

test('bl fix --code asymmetric-dep is accepted; bogus code → exit 2', async () => {
  const td = mkTempBacklog({});
  const ok = await runBl(['fix', '--code', 'asymmetric-dep'], { cwd: td.dir });
  assert.equal(ok.status, 0);
  const bad = await runBl(['fix', '--code', 'not-a-code'], { cwd: td.dir });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown --code/);
  td.cleanup();
});

test('bl fix --theme scopes the run', async () => {
  // Standalone stories reach a theme through their component's repo
  // (F-51 D1): C01's in theme app, C02's in theme tools.
  const td = mkTempBacklog({
    repos: ['../app', '../bl'],
    components: [
      { id: 'C01', title: 'E1', repo: 'app' },
      { id: 'C02', title: 'E2', repo: 'bl' },
    ],
    themes: [
      { id: 'app', title: 'App', repos: ['app'] },
      { id: 'tools', title: 'Tools', repos: ['bl'] },
    ],
    stories: [
      { id: 'S-1', component: 'C01', title: 'a', depends_on: 'S-3' },
      { id: 'S-3', component: 'C01', title: 'c' },
      { id: 'S-2', component: 'C02', title: 'b', depends_on: 'S-4' },
      { id: 'S-4', component: 'C02', title: 'd' },
    ],
  });
  const unknown = await runBl(['fix', '--theme', 'nope'], { cwd: td.dir });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /bl fix: unknown --theme "nope"/);
  const refused = await runBl(['fix', '--project', 'demo'], { cwd: td.dir });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /bl fix: unknown option "--project"/);
  const r = await runBl(['fix', '--theme', 'app'], { cwd: td.dir });
  assert.equal(r.status, 0, r.stderr);
  // S-3 in app should have inverse added; S-4 in tools should not.
  const s3 = readStory(td, 'S3');
  const s4 = readStory(td, 'S4');
  assert.match(s3, /^required_for: \[S-1\]$/m);
  assert.doesNotMatch(s4, /^required_for: \[S-2\]$/m);
  td.cleanup();
});

test('bl fix appends to a populated list, preserving existing order', async () => {
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
      // S-2 already required_for S-3, S-4 — fix should append S-1 at end.
      {
        id: 'S-2',
        component: 'C01',
        title: 'b',
        required_for: ['S-3', 'S-4'],
      },
      {
        id: 'S-3',
        component: 'C01',
        title: 'c',
        depends_on: 'S-2',
      },
      {
        id: 'S-4',
        component: 'C01',
        title: 'd',
        depends_on: 'S-2',
      },
    ],
  });
  const r = await runBl(['fix'], { cwd: td.dir });
  assert.equal(r.status, 0, r.stderr);
  const s2 = readStory(td, 'S2');
  // Order preserved, S-1 at the end.
  assert.match(s2, /^required_for: \[S-3, S-4, S-1\]$/m);
  td.cleanup();
});

test('bl fix --json emits one JSON object on stdout', async () => {
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
      { id: 'S-2', component: 'C01', title: 'b' },
    ],
  });
  const r = await runBl(['fix', '--json'], { cwd: td.dir });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const obj = JSON.parse(r.stdout);
  assert.ok(Array.isArray(obj.fixes));
  assert.equal(obj.fixes.length, 1);
  const f = obj.fixes[0];
  for (const k of ['code', 'location', 'key', 'before', 'after', 'addedId', 'targetId']) {
    assert.ok(k in f, `missing field ${k}`);
  }
  assert.equal(typeof obj.summary.total, 'number');
  assert.equal(obj.summary.byCode['asymmetric-dep'], 1);
  td.cleanup();
});

test('bl fix --help prints documented options on stdout, empty stderr', async () => {
  const td = mkTempBacklog({});
  const r = await runBl(['fix', '--help'], { cwd: td.dir });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /Usage: bl fix/);
  assert.match(r.stdout, /--dry-run/);
  assert.match(r.stdout, /--json/);
  assert.match(r.stdout, /Output:/);
  assert.match(r.stdout, /Exit codes:/);
  assert.match(r.stdout, /asymmetric-dep/);
  td.cleanup();
});

test('bl fix → bl validate clears asymmetric-dep findings', async () => {
  const td = mkTempBacklog({
    // A registered repo with its home component, so validate is clean (F-49 D4).
    repos: ['../demo-repo'],
    components: [{ id: 'C01', title: 'E', repo: 'demo-repo', home: true }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
      {
        id: 'S-2',
        component: 'C01',
        title: 'b',
        depends_on: 'S-3',
      },
      { id: 'S-3', component: 'C01', title: 'c' },
    ],
  });
  // Two asymmetric warnings before fix.
  const v0 = await runBl(['validate'], { cwd: td.dir });
  assert.match(v0.stdout, /asymmetric-dep/);

  const f = await runBl(['fix'], { cwd: td.dir });
  assert.equal(f.status, 0, f.stderr);

  const v1 = await runBl(['validate'], { cwd: td.dir });
  assert.equal(v1.status, 0);
  assert.doesNotMatch(v1.stdout, /asymmetric-dep/);
  td.cleanup();
});

test('bl fix is re-runnable after an injected mid-run write failure', async () => {
  // Three independent asymmetric pairs → three target files → three renames.
  // Inject a failure on the third rename and expect the partial run to
  // surface as exit 1, then a clean re-run finishes the remaining fixes.
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
      { id: 'S-2', component: 'C01', title: 'b' },
      {
        id: 'S-3',
        component: 'C01',
        title: 'c',
        depends_on: 'S-4',
      },
      { id: 'S-4', component: 'C01', title: 'd' },
      {
        id: 'S-5',
        component: 'C01',
        title: 'e',
        depends_on: 'S-6',
      },
      { id: 'S-6', component: 'C01', title: 'f' },
    ],
  });

  const r1 = await runBl(['fix'], {
    cwd: td.dir,
    env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '3' },
  });
  // The rename failure surfaces as an unfixed finding → exit 1.
  assert.equal(r1.status, 1);
  // Some fixes did land on disk before the third write failed.
  const targets = ['S2', 'S4', 'S6'].map((s) => readStory(td, s));
  const fixedCount = targets.filter((t) => /required_for: \[S-/.test(t)).length;
  assert.ok(fixedCount >= 1 && fixedCount < 3, `expected partial progress, got ${fixedCount}`);

  // No leftover .tmp files from the aborted run: none in the story
  // directories, and the failed write removed its own staging file from
  // the backlog's .bl/tmp/.
  const storiesDir = join(td.dir, 'stories');
  for (const s of ['S2', 'S4', 'S6']) {
    const sd = join(storiesDir, s);
    if (!existsSync(sd)) continue;
    const stale = readdirSync(sd).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(stale, [], `stale tmp files in ${s}: ${stale.join(',')}`);
  }
  const stagingDir = join(td.dir, '.bl/tmp');
  const staged = existsSync(stagingDir) ? readdirSync(stagingDir).filter((f) => f.startsWith('index.md.')) : [];
  assert.deepEqual(staged, [], `stale staging files: ${staged.join(',')}`);

  // Re-run with no injected failure — completes cleanly.
  const r2 = await runBl(['fix'], { cwd: td.dir });
  assert.equal(r2.status, 0, r2.stderr);
  for (const s of ['S2', 'S4', 'S6']) {
    assert.match(readStory(td, s), /^required_for: \[S-/m);
  }
  td.cleanup();
});

test('bl fix inserts required_for after depends_on when missing', async () => {
  // Hand-craft a story file that lacks required_for entirely.
  const td = mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'a',
        depends_on: 'S-2',
      },
    ],
  });
  // Write S-2 by hand without any required_for line at all.
  const s2dir = join(td.dir, 'stories/S2-b');
  mkdirSync(s2dir, { recursive: true });
  writeFileSync(
    join(s2dir, 'index.md'),
    `---
component: C01
story_id: S-2
title: b
type: feature
points: 1
status: backlog
depends_on:
---

# b
`,
  );

  const r = await runBl(['fix'], { cwd: td.dir });
  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(join(s2dir, 'index.md'), 'utf8');
  assert.match(after, /depends_on:\nrequired_for: \[S-1\]/);
  td.cleanup();
});

// F-67: `bl fix` rewrites a story spec under its spec lock, CRLF kept.

const ONE_SIDED = () =>
  mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'a', depends_on: 'S-2' },
      { id: 'S-2', component: 'C01', title: 'b' },
    ],
  });

test("bl fix keeps a CRLF story's one frontmatter block and its line end", async () => {
  const td = ONE_SIDED();
  try {
    const path = join(td.dir, 'stories', 'S2', 'index.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'));
    const r = await runBl(['fix'], { cwd: td.dir });
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(path, 'utf8');
    assert.equal(after.match(/^---\r$/gm).length, 2, 'one block');
    assert.doesNotMatch(after.replace(/\r\n/g, ''), /\n/, 'every line ends CRLF');
    assert.match(after, /^required_for: \[S-1\]\r$/m);
  } finally {
    td.cleanup();
  }
});

test('bl fix overlapping a token write in another process keeps both', async () => {
  const td = ONE_SIDED();
  try {
    const path = join(td.dir, 'stories', 'S2', 'index.md');
    // The token writer has read S-2, and holds its spec lock, as bl fix
    // rewrites it.
    const writer = startTokenWriter(td.dir, path, 'implement');
    const r = await runBl(['fix'], { cwd: td.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await writer.done, 0);
    const after = readFileSync(path, 'utf8');
    assert.match(after, /^required_for: \[S-1\]$/m, 'the fix is kept');
    assert.match(after, /^tokens_by_step:\n {2}implement:\n {4}input: .?7.?$/m, 'the step entry is kept');
  } finally {
    td.cleanup();
  }
});
