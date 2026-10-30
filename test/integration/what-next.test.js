import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';

test('bl what-next suggests S-2 after S-1 is closed', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['what-next'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'S-2');
    assert.match(r.stderr, /Next:/);
  } finally {
    cleanup();
  }
});

test('bl what-next on a backlog with no closed stories explains why on stderr', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const r = runBl(['what-next'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    // No stories at all → "No stories found.". With backlog stories present
    // but none closed, "No closed stories yet". Either is fine.
    assert.match(r.stderr, /No (stories|closed)/);
  } finally {
    cleanup();
  }
});

test('bl what-next C00 prints next startable story in the component', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['what-next', 'C00'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // C00 has S-1 (done) and S-2 (depends_on S-1) → S-2 is startable.
    assert.equal(r.stdout.trim(), 'S-2');
    assert.match(r.stderr, /Next:/);
  } finally {
    cleanup();
  }
});

test('bl what-next C99 (unknown component) exits 1', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['what-next', 'C99'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /component not found/);
  } finally {
    cleanup();
  }
});

test('bl what-next E00 exits 1: components are C-ids', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['what-next', 'E00'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /bl what-next: E00 is not a component id: components are C-ids \(C00\)\./);
  } finally {
    cleanup();
  }
});

test('bl what-next garbage exits 1 with form-hint error', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['what-next', 'garbage'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /expected S-<n> or C<nn>/);
  } finally {
    cleanup();
  }
});

// F-53 D3: `next` is no longer an alias of `what-next`; it picks a feature.
test('bl next is not what-next: a story or component argument is refused', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['next', 'C00'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /bl next: takes no arguments \(got C00\); bl what-next picks a story/);
  } finally {
    cleanup();
  }
});

// F-51 D2: the value-axis filters.

/**
 * S-2 → S-1 in bl (standalone, theme `tools` by repo; S-1 done) and
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
      { id: 'S-1', component: 'C32', title: 'One', dirSuffix: 'x', status: 'done', completed: '2026-10-01' },
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

test('bl what-next --theme, --epic, --feature and --component pick the next startable story among their stories', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const next = (args) => {
      const r = runBl(['what-next', ...args], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(next(['--theme', 'tools']), 'S-2');
    assert.equal(next(['--theme', 'product']), 'S-3');
    assert.equal(next(['--epic', 'E50']), 'S-3');
    assert.equal(next(['--feature', 'F-1']), 'S-3');
    assert.equal(next(['--component', 'C32']), 'S-2');
    const r = runBl(['what-next', '--theme', 'product', '--epic', 'E50'], { cwd: dir });
    assert.match(r.stderr, /Filter: theme product, E50/);
  } finally {
    cleanup();
  }
});

test('bl what-next with a filter no story matches says so and prints nothing', () => {
  const { dir, cleanup } = valueAxisBacklog();
  try {
    const r = runBl(['what-next', '--theme', 'demo'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /No stories in theme demo\./);
  } finally {
    cleanup();
  }
});
