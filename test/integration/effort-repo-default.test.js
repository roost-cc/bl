import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { configForRepo, loadConfig } from '../../src/config.js';
import { effortLabel, sessionEffort } from '../../src/effort.js';

// An unset story's level is its repo's `effort.default`, at every place bl
// shows or uses it: `bl status`, `bl approve` and `sessionEffort` (F-85 D2).
// The top level says `high`, the `code` repo overrides it to `low`, and the
// `docs` repo has no override.
function fixture() {
  return mkTempBacklog({
    repos: {
      code: { overrides: { effort: { refine: 'high', review: 'high', default: 'low' } } },
      docs: {},
    },
    components: [
      { id: 'C00', title: 'Core', repo: 'code' },
      { id: 'C01', title: 'Docs', repo: 'docs' },
    ],
    stories: [
      { id: 'S-1', title: 'One', component: 'C00', feature: 'F-1', status: 'refined' },
      { id: 'S-2', title: 'Two', component: 'C01', feature: 'F-1', status: 'refined' },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: 'refined', stories: ['S-1', 'S-2'] }],
  });
}

test('status_shows_repo_effort_default', () => {
  const fx = fixture();
  try {
    const r = runBl(['status', 'F-1'], { cwd: fx.dir });
    assert.equal(r.status, 0, r.stderr);
    const row = (id) => r.stdout.split('\n').find((l) => l.includes(` ${id} `)) ?? '';
    assert.match(row('S-1'), /low \(default\)/, r.stdout);
    assert.match(row('S-2'), /high \(default\)/, r.stdout);
  } finally {
    fx.cleanup();
  }
});

test('approve_shows_repo_effort_default', () => {
  const fx = fixture();
  try {
    const r = runBl(['approve', 'F-1', '--no-sync'], { cwd: fx.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /S-1 {2}effort: low \(default\)/, r.stderr);
    assert.match(r.stderr, /S-2 {2}effort: high \(default\)/, r.stderr);
  } finally {
    fx.cleanup();
  }
});

test("effortLabel and sessionEffort take an unset story's default from its repo, from any config", () => {
  const fx = fixture();
  try {
    const config = loadConfig({ backlogRoot: fx.dir });
    const code = { id: 'S-1', effort: null, unitRepo: 'code' };
    const docs = { id: 'S-2', effort: null, unitRepo: 'docs' };
    // The top-level config and a repo's config give the same answer for a story.
    for (const cfg of [config, configForRepo(config, 'code'), configForRepo(config, 'docs')]) {
      assert.equal(effortLabel(code, cfg), 'low (default)');
      assert.equal(effortLabel(docs, cfg), 'high (default)');
      assert.equal(sessionEffort(cfg, { mode: 'implement', stories: [code] }), 'low');
      assert.equal(sessionEffort(cfg, { mode: 'implement', stories: [docs] }), 'high');
      assert.equal(sessionEffort(cfg, { mode: 'implement', stories: [code, docs] }), 'high');
      assert.equal(sessionEffort(cfg, { mode: 'implement', stories: [{ ...code, effort: 'max' }, docs] }), 'max');
    }
  } finally {
    fx.cleanup();
  }
});
