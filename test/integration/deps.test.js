import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBl } from '../helpers/run-bl.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

// The sample backlog is a chain: S-1 (done) → S-2 → S-3 → S-4.

/**
 * The shared fixture leaves every open story at the default `backlog`, so its
 * status cells are all the same width and alignment is trivially satisfied.
 * This variant gives the same chain three different-width statuses
 * (`in_progress` 11, `refined` 7, `backlog` 7) so padding is actually exercised.
 */
function buildMixedStatusBacklog() {
  return mkTempBacklog({
    components: [{ id: 'C00', title: 'Foundation', dirSuffix: 'foundation' }],
    stories: [
      {
        id: 'S-2',
        component: 'C00',
        title: 'Second',
        dirSuffix: 'second',
        status: 'in_progress',
      },
      {
        id: 'S-3',
        component: 'C00',
        title: 'Third',
        dirSuffix: 'third',
        status: 'refined',
        depends_on: 'S-2',
      },
      {
        id: 'S-4',
        component: 'C00',
        title: 'Fourth',
        dirSuffix: 'fourth',
        depends_on: 'S-3',
      },
    ],
  });
}

test('bl deps prints the cone leaf-first on stdout, the plan on stderr', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 'S-4'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // S-1 is done, so it is pruned; the rest is ordered leaf-first.
    assert.equal(r.stdout, 'S-2\nS-3\nS-4\n');
    assert.match(r.stderr, /Plan for S-4/);
    assert.match(r.stderr, /S-2\s+backlog\s+unblocks 2/);
    assert.match(r.stderr, /S-4\s+backlog\s+unblocks 0/);
  } finally {
    cleanup();
  }
});

test('bl deps aligns the status column across mixed-width statuses', () => {
  const { dir, cleanup } = buildMixedStatusBacklog();
  try {
    const r = runBl(['deps', 'S-4'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /S-2\s+in_progress\s+unblocks 2/);
    assert.match(r.stderr, /S-3\s+refined\s+unblocks 1/);
    assert.match(r.stderr, /S-4\s+backlog\s+unblocks 0/);

    // `unblocks` starts at the same column on every row despite the statuses
    // differing in width.
    const offsets = r.stderr
      .split('\n')
      .filter((l) => l.includes('unblocks'))
      .map((l) => l.indexOf('unblocks'));
    assert.equal(offsets.length, 3);
    assert.equal(new Set(offsets).size, 1, `ragged unblocks column: ${offsets}`);

    // stdout stays bare IDs even with the extra stderr column.
    assert.equal(r.stdout, 'S-2\nS-3\nS-4\n');
  } finally {
    cleanup();
  }
});

test('bl deps stdout is IDs only — no titles or counts leak in', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 'S-4'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    for (const line of r.stdout.trim().split('\n')) {
      assert.match(line, /^S-\d+$/);
    }
  } finally {
    cleanup();
  }
});

test('bl deps accepts a lowercase/unhyphenated id', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 's4'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'S-2\nS-3\nS-4\n');
  } finally {
    cleanup();
  }
});

test('bl deps on a story with only done dependencies prints just that story', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 'S-2'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'S-2\n');
  } finally {
    cleanup();
  }
});

test('bl deps on a done story prints nothing to stdout and explains on stderr', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /S-1 is done/);
  } finally {
    cleanup();
  }
});

test('bl deps with a component id exits 1 and points at bl what-next; an E-id is told components are C-ids', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 'C00'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /bl what-next C00/);
    const e = runBl(['deps', 'E00'], { cwd: dir });
    assert.equal(e.status, 1);
    assert.equal(e.stdout, '');
    assert.match(e.stderr, /bl deps: E00 is not a component id: components are C-ids \(C00\)\./);
  } finally {
    cleanup();
  }
});

test('bl deps with an unknown story id exits 1', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 'S-999'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /story not found: S-999/);
  } finally {
    cleanup();
  }
});

test('bl deps with a malformed id exits 1 with the form hint', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', 'banana'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /invalid id \(expected S-<n>\)/);
  } finally {
    cleanup();
  }
});

test('bl deps with no argument exits 1', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /missing argument/);
  } finally {
    cleanup();
  }
});

test('bl deps --help documents the command on stdout', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const r = runBl(['deps', '--help'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage: bl deps <story-id>/);
    assert.equal(r.stderr, '');
  } finally {
    cleanup();
  }
});
