import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl, BL_BIN } from '../helpers/run-bl.js';
import { spawnToFiles } from '../helpers/spawn-files.js';
import { holdLock } from '../helpers/hold-lock.js';
import { LOCK_FILE } from '../../src/lock.js';

function seedStory(dir) {
  const r = runBl(['new', 'C00', '--title', 'Seed', '--points', '1'], { cwd: dir });
  if (r.status !== 0) throw new Error('seed failed:\n' + r.stderr);
}

test('bl new --from rolls back partial moves when one story fails mid-rename', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Foundation', dirSuffix: 'foundation', repo: 'demo-repo', home: true }],
  });
  try {
    seedStory(dir);
    const storiesDir = join(dir, 'stories');

    // Spec adds 3 more stories into the existing C00.
    const specDir = join(dir, 'spec');
    mkdirSync(join(specDir, 'stories'), { recursive: true });
    writeFileSync(join(specDir, 'stories', 'a.md'), '## Body A\n');
    writeFileSync(join(specDir, 'stories', 'b.md'), '## Body B\n');
    writeFileSync(join(specDir, 'stories', 'c.md'), '## Body C\n');

    const spec = {
      component: 'C00',
      stories: [
        { id: 'a', title: 'Alpha', points: 1, body_file: 'stories/a.md' },
        { id: 'b', title: 'Bravo', points: 1, body_file: 'stories/b.md' },
        { id: 'c', title: 'Charlie', points: 1, body_file: 'stories/c.md' },
      ],
    };
    const specPath = join(specDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // Snapshot which dirs existed before (just S1-seed-* directory).
    const beforeDirs = readdirSync(storiesDir).sort();
    assert.equal(beforeDirs.filter((d) => /^S\d/.test(d)).length, 1, 'expected only the seed story before --from');

    // Stories will be S-2, S-3, S-4. Ask the seam to throw on the third.
    const r = runBl(['new', '--from', specPath], {
      cwd: dir,
      env: { BL_INTERNAL_TEST_FAIL_ON_MOVE: 'S-4' },
    });
    assert.equal(r.status, 1, 'expected exit 1 from injected failure');

    // (a) No new story dirs landed under stories/.
    const afterDirs = readdirSync(storiesDir).sort();
    assert.deepEqual(
      afterDirs.filter((d) => /^S\d/.test(d)).sort(),
      beforeDirs.filter((d) => /^S\d/.test(d)).sort(),
      'expected no new story dirs under stories/ after rollback',
    );

    // (b) Tempdir is removed.
    const stale = readdirSync(dir).filter((e) => e.startsWith('.bl-new-'));
    assert.deepEqual(stale, [], 'expected no .bl-new-* tempdirs to linger');
  } finally {
    cleanup();
  }
});

/** Every file under `dir` (but the lock and `.bl/`), relative path → bytes. */
function tree(dir) {
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name.endsWith('.lock')) continue;
    const p = join(e.parentPath, e.name);
    if (relative(dir, p).startsWith('.bl/')) continue;
    out[relative(dir, p)] = readFileSync(p, 'utf8');
  }
  return out;
}

function featureBacklog() {
  const story = (id, slug, extra = {}) => ({
    id,
    component: 'C00',
    title: slug,
    dirSuffix: slug,
    points: 3,
    status: 'backlog',
    primary_repo: 'demo-repo',
    ...extra,
  });
  return mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true }],
    // S-2 has an empty `feature:` key, the in-place rewrite.
    stories: [story('S-1', 'one'), story('S-2', 'two', { feature: '' })],
  });
}

test('new --feature rolls back feature and story links after every injected write failure', () => {
  // Each write in order; a failed rollback is the next test's.
  for (const fail of ['feature', 'record', 'S-1', 'S-2']) {
    const { dir, cleanup } = featureBacklog();
    try {
      const before = tree(dir);
      // Synced, not --no-sync: a failure must exit before the indexes change.
      const r = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2'], {
        cwd: dir,
        env: { BL_INTERNAL_TEST_FAIL_ON_LINK: fail },
      });
      assert.equal(r.status, 1, `${fail}: exit 1`);
      assert.match(
        r.stderr,
        new RegExp(`injected write failure at ${fail.split(',')[0]}.*Rolled back: F-1 was not created`),
        fail,
      );
      assert.deepEqual(readdirSync(join(dir, 'features')), [], `${fail}: no feature left`);
      assert.deepEqual(tree(dir), before, `${fail}: every file keeps its bytes`);
    } finally {
      cleanup();
    }
  }

  // No failure: both stories name the feature, which stores no list (F-77 D3).
  const { dir, cleanup } = featureBacklog();
  try {
    const r = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], {
      cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    const feature = readFileSync(join(dir, 'features', readdirSync(join(dir, 'features'))[0], 'index.md'), 'utf8');
    assert.doesNotMatch(feature, /^(stories|points|components):/m);
    for (const p of ['S1-one', 'S2-two']) {
      const text = readFileSync(join(dir, 'stories', p, 'index.md'), 'utf8');
      assert.equal(text.match(/^feature:.*$/gm)?.join('|'), 'feature: F-1', p);
    }
  } finally {
    cleanup();
  }
});

/**
 * Each story's `feature:` value, and each feature on disk with the stories
 * naming it, its members (F-77 D3).
 */
function membership(dir) {
  const stories = {};
  for (const p of ['S1-one', 'S2-two']) {
    const text = readFileSync(join(dir, 'stories', p, 'index.md'), 'utf8');
    stories[p.replace(/^S(\d+)-.*/, 'S-$1')] = text.match(/^feature: *(\S*)$/m)?.[1] || null;
  }
  const features = {};
  for (const d of readdirSync(join(dir, 'features'))) {
    const text = readFileSync(join(dir, 'features', d, 'index.md'), 'utf8');
    const id = text.match(/^feature_id: *(\S+)$/m)[1];
    features[id] = Object.keys(stories).filter((s) => stories[s] === id);
  }
  return { stories, features };
}

test('new --feature serializes eligibility validation and preserves bidirectional membership when rollback fails', async () => {
  // Two creators claim S-1, both reading it free before either holds the
  // lock: the test holds it until both have started.
  {
    const { dir, cleanup } = featureBacklog();
    const held = holdLock(join(dir, LOCK_FILE));
    try {
      const run = (title) =>
        spawnToFiles(BL_BIN, ['new', '--feature', '--theme', 'demo', '--title', title, 'S-1', '--no-sync'], {
          cwd: dir,
          env: { ...process.env, BL_BACKLOG_DIR: dir },
        }).closed.then(({ status, stderr }) => ({ status, stderr }));
      const both = Promise.all([run('Alpha'), run('Beta')]);
      await new Promise((r) => setTimeout(r, 1500));
      held.release();
      const results = await both;
      assert.deepEqual(results.map((r) => r.status).sort(), [0, 1], results.map((r) => r.stderr).join('\n'));
      assert.match(results.find((r) => r.status === 1).stderr, /S-1 is already in F-1\./);
      assert.deepEqual(membership(dir), { stories: { 'S-1': 'F-1', 'S-2': null }, features: { 'F-1': ['S-1'] } });
    } finally {
      held.release();
      cleanup();
    }
  }

  // A story whose restore fails still names the feature, so the feature is
  // kept with it.
  const cases = [
    { fail: 'S-2,restore:S-1', want: { stories: { 'S-1': 'F-1', 'S-2': null }, features: { 'F-1': ['S-1'] } } },
  ];
  for (const { fail, want } of cases) {
    const { dir, cleanup } = featureBacklog();
    try {
      // The story files are the ones the links change; everything else is an index or config.
      const indexes = Object.entries(tree(dir)).filter(([p]) => !p.startsWith('stories/'));
      const r = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2'], {
        cwd: dir,
        env: { BL_INTERNAL_TEST_FAIL_ON_LINK: fail },
      });
      assert.equal(r.status, 1, `${fail}: exit 1`);
      assert.doesNotMatch(r.stderr, /Rolled back/, fail);
      const got = membership(dir);
      assert.deepEqual(got, want, fail);
      // No story names a feature that is gone.
      for (const f of Object.values(got.stories)) if (f) assert.ok(got.features[f], `${fail}: ${f} exists`);
      assert.match(r.stderr, /could not restore S-1, so F-1 is kept with it/, fail);
      // It exits before the sync: the indexes are untouched.
      const after = tree(dir);
      for (const [p, bytes] of indexes) assert.equal(after[p], bytes, `${fail}: ${p}`);
    } finally {
      cleanup();
    }
  }
});

/** No story names a feature that is not on disk. */
function assertNoDangling({ stories, features }, label) {
  for (const [s, f] of Object.entries(stories))
    if (f) assert.ok(features[f], `${label}: ${s} names ${f}, which exists`);
}

const records = (dir) => {
  try {
    return readdirSync(join(dir, '.bl/run')).filter((f) => f.endsWith('.links.json'));
  } catch {
    return [];
  }
};

test('new --feature keeps the feature of a story it cannot restore, and the next command rolls it back', () => {
  // S-1 is written, S-2's write fails and S-1's restore fails too.
  const cases = ['S-2,restore:S-1'];
  for (const fail of cases) {
    const { dir, cleanup } = featureBacklog();
    try {
      const before = tree(dir);
      const r = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], {
        cwd: dir,
        env: { BL_INTERNAL_TEST_FAIL_ON_LINK: fail },
      });
      assert.equal(r.status, 1, `${fail}: exit 1`);
      assert.deepEqual(records(dir), ['F-1.links.json'], `${fail}: the repair record stays`);

      // While the writes still fail, a later command settles what it can and
      // refuses to run until the record is settled.
      const again = runBl(['list'], { cwd: dir, env: { BL_INTERNAL_TEST_FAIL_ON_LINK: fail } });
      assert.equal(again.status, 1, `${fail}: refuses`);
      assert.match(again.stderr, /bl refuses to run until/, fail);
      assertNoDangling(membership(dir), `${fail} (still failing)`);

      // Once the writes succeed, the next command finishes the rollback, or
      // keeps a feature whose links are complete.
      const next = runBl(['list'], { cwd: dir });
      assert.equal(next.status, 0, `${fail}: ${next.stderr}`);
      assert.match(again.stderr + next.stderr, /settled the interrupted bl new --feature of F-1/, fail);
      assert.deepEqual(records(dir), [], `${fail}: no record left`);
      const got = membership(dir);
      assertNoDangling(got, fail);
      assert.deepEqual(tree(dir), before, `${fail}: every file keeps its bytes`);
    } finally {
      cleanup();
    }
  }

  // A record left after the links were all written is dropped; nothing is undone.
  const { dir, cleanup } = featureBacklog();
  try {
    assert.equal(
      runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], { cwd: dir })
        .status,
      0,
    );
    const done = tree(dir);
    const stories = [
      { id: 'S-1', path: 'stories/S1-one/index.md', before: 'stale' },
      { id: 'S-2', path: 'stories/S2-two/index.md', before: 'stale' },
    ];
    writeFileSync(
      join(dir, '.bl/run/F-1.links.json'),
      JSON.stringify({ feature: 'F-1', dir: 'features/F1-atomic', stories }),
    );
    const next = runBl(['list'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stderr, /of F-1: complete/);
    assert.deepEqual(records(dir), []);
    assert.deepEqual(tree(dir), done);

    // A record cut short by a crash never took its name, so it settles nothing.
    writeFileSync(join(dir, '.bl/run/F-1.links.json.tmp'), '{"feature": "F-1", "st');
    const half = runBl(['list'], { cwd: dir });
    assert.equal(half.status, 0, half.stderr);
    assert.deepEqual(tree(dir), done);
  } finally {
    cleanup();
  }
});

test('pending listed recovery refuses membership mutations until the record is terminal', () => {
  const commands = [
    ['list'],
    ['new', 'F-1', 'C00', '--title', 'Three', '--points', '1', '--no-sync'],
    ['new', '--feature', 'F-1', '--component', 'C00', '--title', 'Three', '--points', '1', '--no-sync'],
    ['new', '--feature', '--theme', 'demo', '--title', 'Other', 'S-2', '--no-sync'],
  ];
  // `kept`: S-1 still names F-1, which is kept.
  for (const fail of ['S-2,restore:S-1']) {
    for (const cmd of commands) {
      const label = `${fail}: bl ${cmd.join(' ')}`;
      const { dir, cleanup } = featureBacklog();
      try {
        assert.equal(
          runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], {
            cwd: dir,
            env: { BL_INTERNAL_TEST_FAIL_ON_LINK: fail },
          }).status,
          1,
        );
        // A second record, one that rolls back, settles beside it.
        const s2 = 'stories/S2-two/index.md';
        const other = {
          feature: 'F-2',
          dir: 'features/F2-gone',
          stories: [{ id: 'S-2', path: s2, before: readFileSync(join(dir, s2), 'utf8') }],
        };
        writeFileSync(join(dir, '.bl/run/F-2.links.json'), JSON.stringify(other));
        const before = tree(dir);
        const r = runBl(cmd, { cwd: dir, env: { BL_INTERNAL_TEST_FAIL_ON_LINK: fail.replace('S-2,', '') } });
        assert.equal(r.status, 1, label);
        assert.match(r.stderr, /bl refuses to run until/, label);
        assert.match(r.stderr, /of F-2: rolled back/, label);
        assert.deepEqual(records(dir), ['F-1.links.json'], label);
        assert.deepEqual(tree(dir), before, `${label}: nothing changed`);

        // Once the restore succeeds, the record rolls back before the command runs.
        const next = runBl(cmd, { cwd: dir });
        assert.match(next.stderr, /of F-1: rolled back/, label);
        assert.deepEqual(records(dir), [], label);
        assert.ok(!readdirSync(join(dir, 'features')).includes('F1-atomic'), `${label}: F-1 is gone`);
        assertNoDangling(membership(dir), label);
      } finally {
        cleanup();
      }
    }
  }
});

test('settle rejects malformed or escaping repair records without changing backlog files', () => {
  const s1 = 'stories/S1-one/index.md';
  const valid = { feature: 'F-1', dir: 'features/F1-atomic', stories: [{ id: 'S-1', path: s1, before: 'stale' }] };
  const story = (fields) => JSON.stringify({ ...valid, stories: [{ ...valid.stories[0], ...fields }] });
  const cases = {
    'invalid JSON': '{',
    'not an object': 'null',
    'another feature': JSON.stringify({ ...valid, feature: 'F-2' }),
    'no stories member': JSON.stringify({ feature: 'F-1', dir: 'features/F1-atomic' }),
    'stories not a list': JSON.stringify({ ...valid, stories: 'S-1' }),
    'no stories': JSON.stringify({ ...valid, stories: [] }),
    'dir is the root': JSON.stringify({ ...valid, dir: '.' }),
    'dir climbs out': JSON.stringify({ ...valid, dir: 'features/F1-atomic/../..' }),
    'dir is absolute': JSON.stringify({ ...valid, dir: '/tmp' }),
    'dir of another feature': JSON.stringify({ ...valid, dir: 'features/F2-other' }),
    'dir not a string': JSON.stringify({ ...valid, dir: 1 }),
    'dir is a link out': JSON.stringify({ ...valid, dir: 'features/F1-link' }),
    'story id malformed': story({ id: '../S-1' }),
    'story id of another file': story({ id: 'S-2' }),
    'story path climbs out': story({ path: 'stories/../../S1-one/index.md' }),
    'story path missing': story({ path: 'stories/S1-gone/index.md' }),
    'story path not a string': story({ path: null }),
    'story path is a link out': story({ path: 'stories/S1-link/index.md' }),
    'story without bytes': story({ before: 3 }),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    const { dir, cleanup } = featureBacklog();
    const outside = mkTempDir('bl-outside-');
    try {
      assert.equal(
        runBl(['new', '--feature', '--theme', 'demo', '--title', 'Atomic', 'S-1', 'S-2', '--no-sync'], { cwd: dir })
          .status,
        0,
      );
      writeFileSync(join(outside, 'index.md'), '---\nfeature: F-1\n---\n');
      symlinkSync(outside, join(dir, 'features/F1-link'));
      symlinkSync(outside, join(dir, 'stories/S1-link'));
      writeFileSync(join(dir, '.bl/run/F-1.links.json'), bytes);
      const before = tree(dir);
      const r = runBl(['list'], { cwd: dir });
      assert.equal(r.status, 1, label);
      assert.match(
        r.stderr,
        /^bl: could not settle \.bl\/run\/F-1\.links\.json: .+ Check F-1 and its stories by hand, then delete the record\.$/m,
        label,
      );
      assert.doesNotMatch(r.stderr, /at .*\.js:\d+/, `${label}: no stack trace`);
      assert.deepEqual(records(dir), ['F-1.links.json'], `${label}: the record stays`);
      assert.deepEqual(tree(dir), before, `${label}: every file keeps its bytes`);
      assert.deepEqual(readdirSync(outside), ['index.md'], `${label}: nothing outside is touched`);
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  }
});
