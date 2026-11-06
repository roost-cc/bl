import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

// F-77 D3: an edge is stated once, on the dependent story's `depends_on`,
// and its inverse is derived, so `asymmetric-dep` is gone and `bl fix` has
// no code to repair (feature Q1). The command and its contract stay.

function readStory(td, storyEntry) {
  return readFileSync(join(td.dir, 'stories', storyEntry, 'index.md'), 'utf8');
}

const ONE_SIDED = () =>
  mkTempBacklog({
    components: [{ id: 'C01', title: 'E' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'a', depends_on: 'S-2' },
      { id: 'S-2', component: 'C01', title: 'b' },
    ],
  });

test('bl fix leaves a one-sided depends_on alone and prints its empty report', async () => {
  const td = ONE_SIDED();
  try {
    const before = readStory(td, 'S2');
    const r = await runBl(['fix'], { cwd: td.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /scanning 2 stories across 1 component…/);
    assert.equal(readStory(td, 'S2'), before);
    assert.doesNotMatch(readStory(td, 'S2'), /required_for/);
  } finally {
    td.cleanup();
  }
});

test('bl fix --dry-run and --story print the empty report too', async () => {
  const td = ONE_SIDED();
  try {
    for (const args of [['--dry-run'], ['--story', 'S-1'], ['--dry-run', '--story', 'S-1']]) {
      const r = await runBl(['fix', ...args], { cwd: td.dir });
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '', args.join(' '));
    }
  } finally {
    td.cleanup();
  }
});

test('bl fix --json emits the empty JSON report on stdout', async () => {
  const td = ONE_SIDED();
  try {
    const r = await runBl(['fix', '--json'], { cwd: td.dir });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), { fixes: [], summary: { total: 0, byCode: {} } });
  } finally {
    td.cleanup();
  }
});

test('bl fix refuses every --code, asymmetric-dep included, with exit 2', async () => {
  const td = mkTempBacklog({});
  try {
    for (const code of ['asymmetric-dep', 'not-a-code']) {
      const r = await runBl(['fix', '--code', code], { cwd: td.dir });
      assert.equal(r.status, 2, code);
      assert.match(r.stderr, new RegExp(`bl fix: unknown --code "${code}" \\(supported: none\\)`));
    }
  } finally {
    td.cleanup();
  }
});

test('bl fix still judges --theme, --story and unknown options', async () => {
  const td = mkTempBacklog({
    repos: ['../app'],
    components: [{ id: 'C01', title: 'E1', repo: 'app' }],
    themes: [{ id: 'app', title: 'App', repos: ['app'] }],
    stories: [{ id: 'S-1', component: 'C01', title: 'a' }],
  });
  try {
    const unknown = await runBl(['fix', '--theme', 'nope'], { cwd: td.dir });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /bl fix: unknown --theme "nope"/);
    const missing = await runBl(['fix', '--story', 'S-999'], { cwd: td.dir });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /bl fix: unknown --story "S-999"/);
    const refused = await runBl(['fix', '--project', 'demo'], { cwd: td.dir });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /bl fix: unknown option "--project"/);
    const ok = await runBl(['fix', '--theme', 'app'], { cwd: td.dir });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, '');
  } finally {
    td.cleanup();
  }
});

test('bl fix --help prints documented options on stdout, empty stderr', async () => {
  const td = mkTempBacklog({});
  try {
    const r = await runBl(['fix', '--help'], { cwd: td.dir });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /Usage: bl fix/);
    assert.match(r.stdout, /--dry-run/);
    assert.match(r.stdout, /--json/);
    assert.match(r.stdout, /Output:/);
    assert.match(r.stdout, /Exit codes:/);
    assert.match(r.stdout, /Supported codes:\n {2}\(none\)/);
  } finally {
    td.cleanup();
  }
});
