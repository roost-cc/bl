import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';

test('bl list emits a table containing every active story', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['list'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // S-1 is done, default list excludes done. Anchor each ID so the test
    // doesn't misfire when the fixture grows past S-9 (e.g. /S-1/ would match
    // S-10) — matches the second test's \bS-N\b style.
    assert.match(r.stdout, /\bS-2\b/);
    assert.match(r.stdout, /\bS-3\b/);
    assert.match(r.stdout, /\bS-4\b/);
    assert.doesNotMatch(r.stdout, /\bS-1\b/);
  } finally {
    cleanup();
  }
});

test('--project and -p are unknown options, and bl project an unknown command (F-51 D5)', () => {
  const { dir, cleanup } = mkTempBacklog({
    stories: [{ id: 'S-1', component: 'C00', title: 'Demo Story' }],
  });
  try {
    for (const cmd of [
      ['list'],
      ['tree'],
      ['what-next'],
      ['validate'],
      ['new', '--title', 'x', '--points', '1', '--no-sync'],
    ]) {
      for (const flag of [['--project', 'demo'], ['--project=demo'], ['-p', 'demo']]) {
        const r = runBl([...cmd, ...flag], { cwd: dir });
        assert.notEqual(r.status, 0, `${cmd[0]} ${flag.join(' ')}`);
        assert.match(
          r.stderr,
          new RegExp(`unknown option "${flag[0].replace(/=.*/, '')}"`),
          `${cmd[0]} ${flag.join(' ')}`,
        );
      }
    }
    const r = runBl(['project', 'list'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl: unknown command 'project'/);
  } finally {
    cleanup();
  }
});

test('bl list on an empty backlog reports nothing on stdout', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const r = runBl(['list'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // "No stories found." is sent to stderr (info()), so stdout stays empty.
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /No stories/i);
  } finally {
    cleanup();
  }
});

// F-51 D2: the value-axis filters and the Theme column.

/**
 * Theme `product` (no repos) holds F-1 (epic E50) and F-2 (no epic); theme
 * `tools` lists repo `bl`. S-4 is a standalone bl story (in `tools`), S-5 a
 * standalone app story (in no theme).
 */
function valueAxisBacklog() {
  return mkTempBacklog({
    repos: ['../app', '../bl'],
    components: [
      { id: 'C01', title: 'App', dirSuffix: 'app', repo: 'app', home: true },
      { id: 'C32', title: 'Tools', dirSuffix: 'tools', repo: 'bl', home: true },
    ],
    themes: [
      { id: 'product', title: 'Product', repos: [] },
      { id: 'tools', title: 'Tools', repos: ['bl'] },
    ],
    valueEpics: [{ id: 'E50', title: 'Sign-up', dirSuffix: 'sign-up', theme: 'product' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', points: 2, dirSuffix: 'x', status: 'done', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', points: 3, dirSuffix: 'x', feature: 'F-1' },
      { id: 'S-3', component: 'C01', title: 'Three', points: 1, dirSuffix: 'x', feature: 'F-2' },
      { id: 'S-4', component: 'C32', title: 'Four', points: 1, dirSuffix: 'x' },
      { id: 'S-5', component: 'C01', title: 'Five', points: 1, dirSuffix: 'x' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Invites',
        dirSuffix: 'invites',
        theme: 'product',
        epic: 'E-50',
        status: 'running',
        primary_repo: 'app',
        stories: ['S-1', 'S-2'],
      },
      {
        id: 'F-2',
        title: 'Rooms',
        dirSuffix: 'rooms',
        theme: 'product',
        status: 'draft',
        primary_repo: 'app',
        stories: ['S-3'],
      },
    ],
  });
}

/** The listed story ids, in order. */
function listedIds(stdout) {
  return [...stdout.matchAll(/\b(S-\d+)\b/g)].map((m) => m[1]);
}

test("bl list shows a Theme column: the feature's theme, a standalone story's repo themes, or -", () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r = runBl(['list'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^Theme\s+Component\s+Story/);
    const row = (id) => lines.find((l) => new RegExp(`\\b${id}\\b`).test(l));
    assert.match(row('S-2'), /^product\s/);
    assert.match(row('S-4'), /^tools\s/);
    assert.match(row('S-5'), /^-\s/);
  } finally {
    cleanup();
  }
});

test('bl list --theme, --feature and --component filter the stories', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const ids = (args) => {
      const r = runBl(['list', ...args], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      return listedIds(r.stdout).sort();
    };
    assert.deepEqual(ids(['--theme', 'tools']), ['S-4']);
    assert.deepEqual(ids(['--theme', 'product']), ['S-2', 'S-3']);
    assert.deepEqual(ids(['--theme', 'product', '-a']), ['S-1', 'S-2', 'S-3']);
    assert.deepEqual(ids(['--feature', 'F-1']), ['S-2']);
    assert.deepEqual(ids(['--component', 'C32']), ['S-4']);
    assert.deepEqual(ids(['--component', 'C01', '--theme', 'product']), ['S-2', 'S-3']);
  } finally {
    cleanup();
  }
});

test('bl list --theme with an unknown theme fails and names the known ones', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r = runBl(['list', '--theme', 'nope'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl list: theme nope not found under themes\/ \(known: demo, product, tools\)/);
  } finally {
    cleanup();
  }
});

test("bl list --epic lists the epic's features with stories and points done/total", () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r = runBl(['list', '--epic', 'E-50'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], 'E50 · Sign-up [open] — 0/1 features done');
    assert.match(lines[1], /^ID\s+Status\s+Stories\s+Points\s+Theme\s+Title\s*$/);
    assert.match(r.stdout, /^F-1\s+running\s+1\/2\s+2\/5\s+product\s+Invites$/m);
    assert.doesNotMatch(r.stdout, /\bF-2\b/);
  } finally {
    cleanup();
  }
});

test("bl list --features --theme groups the theme's features by epic, those with none last", () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r = runBl(['list', '--features', '--theme', 'product'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /^E50 · Sign-up \[open\] — 0\/1 features done$/m);
    assert.match(out, /^No epic$/m);
    assert.ok(out.indexOf('E50 ·') < out.indexOf('No epic'), out);
    assert.ok(out.indexOf('F-1') < out.indexOf('No epic'), out);
    assert.match(out, /^F-2\s+draft\s+0\/1\s+0\/1\s+product\s+Rooms$/m);
    assert.match(out, /^2 features$/m);
  } finally {
    cleanup();
  }
});
