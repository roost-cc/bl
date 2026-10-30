import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';

test('bl tree renders a chain rooted at S-4', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['tree'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // Stdout should contain every node in the chain.
    for (const id of ['S-1', 'S-2', 'S-3', 'S-4']) {
      // Anchor with \b so /S-1/ doesn't accidentally match S-10/S-11/...
      assert.match(r.stdout, new RegExp(`\\b${id}\\b`), `expected ${id} in tree output`);
    }
    // ASCII connectors.
    assert.match(r.stdout, /└──|├──/);
  } finally {
    cleanup();
  }
});

test('bl tree on a backlog with no edges prints nothing on stdout', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const r = runBl(['tree'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /No dependency trees/);
  } finally {
    cleanup();
  }
});

test('bl tree C00 renders the pending chain rooted at S-4 exactly once', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['tree', 'C00'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // Every pending story under C00 is S-2; its ancestors (S-3, S-4) belong
    // to C01 but participate in the same chain, so they appear in the output.
    for (const id of ['S-2', 'S-3', 'S-4']) {
      assert.match(r.stdout, new RegExp(`\\b${id}\\b`), `expected ${id} in tree output`);
    }
    // S-4 is the chain root; it must appear as a top-level node exactly once.
    // Top-level lines start with the story id (no connector prefix).
    const rootLines = r.stdout.split('\n').filter((l) => /^S-4\b/.test(l));
    assert.equal(
      rootLines.length,
      1,
      `expected S-4 to appear once as a top-level node; got ${rootLines.length}:\n${r.stdout}`,
    );
    // ASCII connectors.
    assert.match(r.stdout, /└──|├──/);
  } finally {
    cleanup();
  }
});

test('bl tree C00 accepts hyphenated and lowercase forms', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const base = runBl(['tree', 'C00'], { cwd: dir }).stdout;
    for (const variant of ['c00', 'C-00', 'c-00']) {
      const r = runBl(['tree', variant], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, base, `output for ${variant} should match C00`);
    }
  } finally {
    cleanup();
  }
});

test('bl tree C99 (unknown component) exits 1 with component-not-found on stderr', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['tree', 'C99'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl tree: component not found: C99/);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('bl tree E00 and E-32 exit 1: components are C-ids; E-50 (an epic) gets no such hint', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    let r = runBl(['tree', 'E00'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl tree: E00 is not a component id: components are C-ids \(C00\)\./);
    assert.equal(r.stdout, '');
    r = runBl(['tree', 'E-32'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl tree: E-32 is not a component id: components are C-ids \(C32\)\./);
    r = runBl(['tree', 'E-50'], { cwd: dir });
    assert.doesNotMatch(r.stderr, /is not a component id/);
  } finally {
    cleanup();
  }
});

test('bl tree garbage exits 1 with the dual-form invalid-id message', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['tree', 'garbage'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /expected S-<n> or C<nn>/);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('bl tree on an all-done component prints the all-done message; -a renders', () => {
  const { dir, cleanup } = mkTempBacklog({
    components: [
      {
        id: 'C00',
        title: 'Foundation',
        dirSuffix: 'foundation',
      },
    ],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'First',
        dirSuffix: 'first',
        status: 'done',
        completed: '2026-01-01',
      },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Second',
        dirSuffix: 'second',
        status: 'done',
        completed: '2026-01-02',
        depends_on: 'S-1',
      },
    ],
  });
  try {
    const r = runBl(['tree', 'C00'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /All stories in C00 are done\./);

    // -a / --all renders the chain even when every story is done.
    const rAll = runBl(['tree', '-a', 'C00'], { cwd: dir });
    assert.equal(rAll.status, 0, rAll.stderr);
    assert.match(rAll.stdout, /\bS-1\b/);
    assert.match(rAll.stdout, /\bS-2\b/);
  } finally {
    cleanup();
  }
});

test('bl tree on a component whose pending stories have no edges reports it', () => {
  const { dir, cleanup } = mkTempBacklog({
    components: [
      {
        id: 'C00',
        title: 'Foundation',
        dirSuffix: 'foundation',
      },
    ],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Solo',
        dirSuffix: 'solo',
      },
    ],
  });
  try {
    const r = runBl(['tree', 'C00'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /No dependency trees for pending stories in C00/);
  } finally {
    cleanup();
  }
});

// F-51 D2: the value-axis filters.

/**
 * Two chains: S-2 → S-1 in bl (standalone, theme `tools` by repo) and
 * S-4 → S-3 in app (F-1, theme `product`, epic E50).
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
      { id: 'S-1', component: 'C32', title: 'One', dirSuffix: 'x' },
      { id: 'S-2', component: 'C32', title: 'Two', dirSuffix: 'x', depends_on: 'S-1' },
      { id: 'S-3', component: 'C01', title: 'Three', dirSuffix: 'x', feature: 'F-1' },
      { id: 'S-4', component: 'C01', title: 'Four', dirSuffix: 'x', feature: 'F-1', depends_on: 'S-3' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Invites',
        dirSuffix: 'invites',
        theme: 'product',
        epic: 'E50',
        status: 'running',
        primary_repo: 'app',
        stories: ['S-3', 'S-4'],
      },
    ],
  });
}

test('bl tree --theme, --epic, --feature and --component show only the trees they reach', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const roots = (args) => {
      const r = runBl(['tree', ...args], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout
        .split('\n')
        .filter((l) => /^S-\d+\b/.test(l))
        .map((l) => l.match(/^(S-\d+)/)[1]);
    };
    assert.deepEqual(roots([]), ['S-2', 'S-4']);
    assert.deepEqual(roots(['--theme', 'tools']), ['S-2']);
    assert.deepEqual(roots(['--theme', 'product']), ['S-4']);
    assert.deepEqual(roots(['--epic', 'E-50']), ['S-4']);
    assert.deepEqual(roots(['--feature', 'F-1']), ['S-4']);
    assert.deepEqual(roots(['--component', 'C32']), ['S-2']);
  } finally {
    cleanup();
  }
});

test('bl tree refuses a story id with a filter, and an unknown epic', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const both = runBl(['tree', 'S-2', '--theme', 'tools'], { cwd: dir });
    assert.equal(both.status, 1);
    assert.match(both.stderr, /give a story id or the --theme\/--epic\/--feature\/--component filters, not both/);
    const unknown = runBl(['tree', '--epic', 'E99'], { cwd: dir });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /bl tree: epic E99 not found under epics\//);
  } finally {
    cleanup();
  }
});
