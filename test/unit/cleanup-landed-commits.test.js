/**
 * Unit tests for `persistLandedCommits` (S-864): the one write `bl merge`
 * uses to record a landed repo's SHA, and to mark the story done. Under the
 * backlog lock it re-reads the story, unions the `commit:` map on disk with
 * the repos this run landed, and replaces the file atomically, so a
 * concurrent `--repo` merge's SHA survives and a failed write leaves the old
 * file intact.
 *
 * Invoked as `node <this file> worker <root> <repo> <sha> [fail]` the file is
 * the worker of the concurrency test: one `bl merge` process landing `repo`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitFmShape, persistLandedCommits } from '../../src/cleanup.js';
import { parseFrontmatter } from '../../src/config.js';
import { LOCK_FILE } from '../../src/lock.js';
import { mkTempDir } from '../helpers/tempdir.js';

const THIS_FILE = fileURLToPath(import.meta.url);

if (process.argv[2] === 'worker') {
  const [root, repo, sha, fail] = process.argv.slice(3);
  while (!existsSync(join(root, 'go'))) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const opts = fail
    ? {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      }
    : {};
  await persistLandedCommits(root, join(root, 'index.md'), { [repo]: sha }, opts);
  process.exit(0);
}

const STORY_BODY = '\n## Summary\n\nbody\n';

function story(fm) {
  const root = mkTempDir('s864-landed-');
  const indexPath = join(root, 'index.md');
  const lines = Object.entries(fm).map(([k, v]) =>
    typeof v === 'object' && v !== null
      ? `${k}:\n${Object.entries(v)
          .map(([r, s]) => `  ${r}: ${s}`)
          .join('\n')}`
      : `${k}: ${v}`,
  );
  writeFileSync(indexPath, `---\n${lines.join('\n')}\n---\n${STORY_BODY}`);
  return { root, indexPath };
}

const readFm = (indexPath) => parseFrontmatter(readFileSync(indexPath, 'utf8')).fm;

// Every `commit:` state a merge can find on disk, crossed with what this run
// landed: the map on disk is always kept, the landings are added, and a done
// story is left alone.
for (const [name, onDisk, landed, expected] of [
  ['no commit yet, first repo lands', {}, { alpha: 'aaa1111' }, { alpha: 'aaa1111' }],
  [
    'a concurrent merge landed alpha after this run read the story',
    { commit: { alpha: 'aaa1111' } },
    { beta: 'bbb2222' },
    { alpha: 'aaa1111', beta: 'bbb2222' },
  ],
  [
    "this run's SHA wins for the repo it landed",
    { commit: { alpha: '0000000', beta: 'bbb2222' } },
    { alpha: 'aaa1111' },
    { alpha: 'aaa1111', beta: 'bbb2222' },
  ],
  [
    "an earlier run's two repos plus this run's third",
    { commit: { alpha: 'aaa1111', beta: 'bbb2222' } },
    { gamma: 'ccc3333' },
    { alpha: 'aaa1111', beta: 'bbb2222', gamma: 'ccc3333' },
  ],
]) {
  test(`persistLandedCommits: ${name}`, async () => {
    const { root, indexPath } = story({
      story_id: 'S-99',
      status: 'in_progress',
      ...onDisk,
    });
    const out = await persistLandedCommits(root, indexPath, landed);
    assert.equal(out.written, true);
    assert.deepEqual(out.commitMap, expected);
    const fm = readFm(indexPath);
    assert.deepEqual(fm.commit, expected);
    assert.equal(fm.status, 'in_progress');
    assert.ok(readFileSync(indexPath, 'utf8').endsWith(STORY_BODY), 'body kept');
    assert.ok(!existsSync(join(root, LOCK_FILE)), 'lock released');
  });
}

test('persistLandedCommits: a story already done on disk is left alone', async () => {
  const { root, indexPath } = story({
    story_id: 'S-99',
    status: 'done',
    commit: 'aaa1111',
    completed: '2026-10-01',
  });
  const before = readFileSync(indexPath, 'utf8');
  const out = await persistLandedCommits(
    root,
    indexPath,
    { beta: 'bbb2222' },
    {
      mutate: (fm) => {
        fm.status = 'done';
      },
    },
  );
  assert.equal(out.written, false);
  assert.equal(readFileSync(indexPath, 'utf8'), before);
});

// Mark-done goes through the same write: the union is what gets collapsed.
for (const [name, onDisk, landed, expectedCommit] of [
  ['one repo collapses to a bare SHA', {}, { alpha: 'aaa1111' }, 'aaa1111'],
  [
    "the repos on disk and this run's stay a map",
    { commit: { alpha: 'aaa1111' } },
    { beta: 'bbb2222' },
    { alpha: 'aaa1111', beta: 'bbb2222' },
  ],
  ['no SHA at all leaves commit unset', {}, {}, undefined],
]) {
  test(`persistLandedCommits: mark-done ${name}`, async () => {
    const { root, indexPath } = story({
      story_id: 'S-99',
      status: 'in_progress',
      ...onDisk,
    });
    const out = await persistLandedCommits(root, indexPath, landed, {
      mutate: (fm, commitMap) => {
        fm.status = 'done';
        const keys = Object.keys(commitMap);
        if (keys.length === 1) fm.commit = commitMap[keys[0]];
        else if (keys.length > 1) fm.commit = { ...commitMap };
        fm.completed = '2026-10-14';
      },
    });
    assert.equal(out.written, true);
    const fm = readFm(indexPath);
    assert.equal(fm.status, 'done');
    assert.equal(fm.completed, '2026-10-14');
    assert.deepEqual(fm.commit, expectedCommit);
  });
}

test('persistLandedCommits: a failed write leaves the file intact, throws and releases the lock', async () => {
  const { root, indexPath } = story({
    story_id: 'S-99',
    status: 'in_progress',
    commit: { alpha: 'aaa1111' },
  });
  const before = readFileSync(indexPath, 'utf8');
  await assert.rejects(
    persistLandedCommits(
      root,
      indexPath,
      { beta: 'bbb2222' },
      {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    ),
    /ENOSPC/,
  );
  assert.equal(readFileSync(indexPath, 'utf8'), before);
  assert.ok(!existsSync(join(root, LOCK_FILE)), 'lock released');
  // The next write still goes through.
  await persistLandedCommits(root, indexPath, { beta: 'bbb2222' });
  assert.deepEqual(readFm(indexPath).commit, {
    alpha: 'aaa1111',
    beta: 'bbb2222',
  });
});

test('persistLandedCommits: the real write stages in .bl/tmp and leaves no temp file behind', async () => {
  const { root, indexPath } = story({
    story_id: 'S-99',
    status: 'in_progress',
  });
  await persistLandedCommits(root, indexPath, { alpha: 'aaa1111' });
  assert.deepEqual(readdirSync(root).sort(), ['.bl', 'index.md']);
  assert.deepEqual(readdirSync(join(root, '.bl', 'tmp')), []);
});

/**
 * Spawn one worker per landing, release them together once all are up, and
 * wait for every exit code.
 */
async function raceWorkers(root, landings) {
  const children = landings.map(([repo, sha, fail]) =>
    spawn(process.execPath, [THIS_FILE, 'worker', root, repo, sha, ...(fail ? ['fail'] : [])], {
      stdio: ['ignore', 'ignore', 'pipe'],
    }),
  );
  const exits = children.map(
    (child) =>
      new Promise((resolve) => {
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d));
        child.once('exit', (code) => resolve({ code, stderr }));
      }),
  );
  writeFileSync(join(root, 'go'), 'go\n');
  return Promise.all(exits);
}

test('concurrent --repo merges union their landed SHA maps, including when one persistence write fails', async () => {
  // Two merges landing alpha and beta at once: both SHAs end up on disk.
  {
    const { root, indexPath } = story({
      story_id: 'S-99',
      status: 'in_progress',
    });
    const exits = await raceWorkers(root, [
      ['alpha', 'aaa1111'],
      ['beta', 'bbb2222'],
    ]);
    assert.deepEqual(
      exits.map((e) => e.code),
      [0, 0],
      exits.map((e) => e.stderr).join('\n'),
    );
    assert.deepEqual(readFm(indexPath).commit, {
      alpha: 'aaa1111',
      beta: 'bbb2222',
    });
    assert.ok(!existsSync(join(root, LOCK_FILE)), 'lock released');
  }
  // Three merges, gamma's write fails: alpha and beta are still recorded,
  // gamma's process fails, and the story file is intact.
  {
    const { root, indexPath } = story({
      story_id: 'S-99',
      status: 'in_progress',
    });
    const exits = await raceWorkers(root, [
      ['alpha', 'aaa1111'],
      ['beta', 'bbb2222'],
      ['gamma', 'ccc3333', true],
    ]);
    assert.deepEqual(
      exits.slice(0, 2).map((e) => e.code),
      [0, 0],
    );
    assert.notEqual(exits[2].code, 0);
    assert.match(exits[2].stderr, /ENOSPC/);
    const fm = readFm(indexPath);
    assert.equal(fm.status, 'in_progress');
    assert.deepEqual(fm.commit, { alpha: 'aaa1111', beta: 'bbb2222' });
    assert.ok(!existsSync(join(root, LOCK_FILE)), 'lock released');
  }
});

// S-868: a repo with no local story branch reports the tip of its main as a
// `tip`, not a landing. Every `commit:` state on disk crossed with tips and
// exact landings: the disk's SHA for a repo always beats a tip for it, a tip
// fills a repo nobody named, and an exact landing still wins over the disk.
for (const [name, onDisk, landed, tips, expected] of [
  ['a tip is recorded for a repo no run named', {}, {}, { alpha: 'tip1111' }, { alpha: 'tip1111' }],
  [
    'a tip never replaces the exact SHA on disk for its repo',
    { commit: { alpha: 'aaa1111' } },
    {},
    { alpha: 'tip1111' },
    { alpha: 'aaa1111' },
  ],
  [
    'tips and exact landings of other repos union with the disk',
    { commit: { alpha: 'aaa1111' } },
    { beta: 'bbb2222' },
    { alpha: 'tip1111', gamma: 'tip3333' },
    { alpha: 'aaa1111', beta: 'bbb2222', gamma: 'tip3333' },
  ],
  [
    'an exact landing beats the disk even when the same repo is also a tip',
    { commit: { alpha: '0000000' } },
    { alpha: 'aaa1111' },
    { alpha: 'tip1111' },
    { alpha: 'aaa1111' },
  ],
  [
    "a bare string on disk beats the tip of a single-repo story's one repo",
    { commit: 'aaa1111' },
    {},
    { alpha: 'tip1111' },
    { alpha: 'aaa1111' },
  ],
  [
    'a bare string on disk is not placed when the run names several repos',
    { commit: 'aaa1111' },
    { beta: 'bbb2222' },
    { alpha: 'tip1111' },
    { alpha: 'tip1111', beta: 'bbb2222' },
  ],
]) {
  test(`persistLandedCommits: tips — ${name}`, async () => {
    const { root, indexPath } = story({
      story_id: 'S-99',
      status: 'in_progress',
      ...onDisk,
    });
    const out = await persistLandedCommits(root, indexPath, landed, { tips });
    assert.equal(out.written, true);
    assert.deepEqual(out.commitMap, expected);
    assert.deepEqual(readFm(indexPath).commit, expected);
    // Mark-done decides the same way from the re-read map.
    const done = await persistLandedCommits(root, indexPath, landed, {
      tips,
      mutate: (fm, commitMap) => {
        fm.status = 'done';
        fm.commit = commitFmShape(commitMap);
      },
    });
    assert.deepEqual(done.commitMap, expected);
    assert.deepEqual(readFm(indexPath).commit, commitFmShape(expected));
    assert.ok(!existsSync(join(root, LOCK_FILE)), 'lock released');
  });
}

test('concurrent no-branch cleanup keeps the SHA written after its initial story read', async () => {
  // Run A reads the story (no `commit:` yet), then takes alpha down the
  // no-branch path and reports main's tip. Run B lands alpha's exact merge
  // SHA in between. A's per-repo write and its mark-done must both keep B's
  // SHA: the decision is made from the map re-read under the lock, never
  // from A's stale first read.
  const { root, indexPath } = story({
    story_id: 'S-99',
    status: 'in_progress',
  });
  assert.equal(readFm(indexPath).commit, undefined, "A's first read");
  await persistLandedCommits(root, indexPath, { alpha: 'exact111' });

  const tips = { alpha: 'later222' };
  const perRepo = await persistLandedCommits(root, indexPath, {}, { tips });
  assert.deepEqual(perRepo.commitMap, { alpha: 'exact111' });
  assert.deepEqual(readFm(indexPath).commit, { alpha: 'exact111' });

  await persistLandedCommits(
    root,
    indexPath,
    {},
    {
      tips,
      mutate: (fm, commitMap) => {
        fm.status = 'done';
        fm.commit = commitFmShape(commitMap);
      },
    },
  );
  const fm = readFm(indexPath);
  assert.equal(fm.status, 'done');
  assert.equal(fm.commit, 'exact111');
  assert.ok(!existsSync(join(root, LOCK_FILE)), 'lock released');
});

test("persistLandedCommits reads and writes inside the story's spec lock, through its read and write seams", async () => {
  const { specLockPath } = await import('../../src/spec-file.js');
  const { liveLockHolder } = await import('../../src/pid-lock.js');
  const { root, indexPath } = story({ story_id: 'S-99', status: 'in_progress' });
  const held = [];
  const { written } = await persistLandedCommits(
    root,
    indexPath,
    { alpha: 'aaa1111' },
    {
      read: (path, enc) => {
        held.push(liveLockHolder(specLockPath(path)));
        return readFileSync(path, enc);
      },
      write: (path, text) => {
        held.push(liveLockHolder(specLockPath(path)));
        writeFileSync(path, text);
      },
    },
  );
  assert.equal(written, true);
  assert.deepEqual(held, [process.pid, process.pid]);
  assert.equal(liveLockHolder(specLockPath(indexPath)), null, 'released');
  assert.deepEqual(readFm(indexPath).commit, { alpha: 'aaa1111' });
});

test("persistLandedCommits keeps a CRLF story's one block and line end, and refuses one with no block, named", async () => {
  const { FrontmatterError } = await import('../../src/config.js');
  const crlf = story({ story_id: 'S-99', status: 'in_progress' });
  writeFileSync(crlf.indexPath, readFileSync(crlf.indexPath, 'utf8').replace(/\n/g, '\r\n'));
  await persistLandedCommits(crlf.root, crlf.indexPath, { alpha: 'aaa1111' });
  const text = readFileSync(crlf.indexPath, 'utf8');
  assert.equal(text.match(/^---\r$/gm).length, 2, 'one block');
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'every line ends CRLF');
  assert.deepEqual(parseFrontmatter(text.replace(/\r\n/g, '\n')).fm.commit, { alpha: 'aaa1111' });

  const bare = story({ story_id: 'S-99' });
  writeFileSync(bare.indexPath, STORY_BODY);
  await assert.rejects(
    persistLandedCommits(bare.root, bare.indexPath, { alpha: 'aaa1111' }),
    (e) => e instanceof FrontmatterError && e.message.includes(bare.indexPath),
  );
  assert.equal(readFileSync(bare.indexPath, 'utf8'), STORY_BODY, 'no block prepended');
});
