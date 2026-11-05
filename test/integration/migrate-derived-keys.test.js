/**
 * Integration tests for `scripts/migrate-derived-keys.js` (F-77 D3): it
 * removes the keys bl derives (`DERIVED_KEYS`) from every unit file in one
 * commit, `--dry-run` prints the per-kind counts and writes nothing, a
 * second run changes nothing, and what bl derives is the same before and
 * after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { loadBacklog } from '../../src/backlog-graph.js';
import { migrate } from '../../src/migrate-derived-keys.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';
import { addOrigin, git, statusLines } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-derived-keys.js', import.meta.url));

const unit = (fm, heading) => `${serializeFrontmatter(fm)}\n# ${heading}\n\n## Summary\n\nWhy.\n`;
const story = (id, feature, points) =>
  unit(
    {
      component: 'C32',
      story_id: id,
      title: `Story ${id}`,
      type: 'chore',
      points: String(points),
      status: 'backlog',
      added: '2026-11-01',
      feature,
    },
    id,
  );

/**
 * A backlog in git as bl wrote it before F-77: F-1 stores all three derived
 * keys, F-2 only `points:`, F-3 none; E50 stores `features:` and `status:`,
 * E51 none. Every stored value is what the graph derives.
 */
function oldBacklog() {
  const dir = mkTempDir('bl-migrate-derived-');
  const files = {
    '.gitignore': '.workon.lock\n.bl/\n',
    'flow.json': readFileSync(FLOW_TEMPLATE, 'utf8'),
    'backlog.json': `${JSON.stringify({ agent: [{ agent: 'claude' }], review_agent: [{ agent: 'claude' }], worktrees: '../worktrees', repos: { bl: { path: '../bl', deployable: false, update_tests: [] } } }, null, 2)}\n`,
    'index.md': '# Backlog\n',
    'themes/demo/index.md': unit({ theme_id: 'demo', title: 'Demo', repos: ['bl'] }, 'demo'),
    'components/C32-bl/index.md': unit(
      { component_id: 'C32', title: 'bl', repo: 'bl', home: 'true', paths: ['**'] },
      'C32',
    ),
    'stories/S1-one/index.md': story('S-1', 'F-1', 1),
    'stories/S2-two/index.md': story('S-2', 'F-1', 2),
    'stories/S3-three/index.md': story('S-3', 'F-2', 3),
    'features/F1-one/index.md': unit(
      {
        feature_id: 'F-1',
        title: 'One',
        theme: 'demo',
        epic: 'E50',
        status: 'running',
        stories: ['S-1', 'S-2'],
        points: '3',
        components: ['C32'],
        review_rounds_max: '2',
      },
      'F-1',
    ),
    'features/F2-two/index.md': unit(
      { feature_id: 'F-2', title: 'Two', theme: 'demo', status: 'draft', points: '3' },
      'F-2',
    ),
    'features/F3-three/index.md': unit({ feature_id: 'F-3', title: 'Three', theme: 'demo', status: 'draft' }, 'F-3'),
    'epics/E50-fifty/index.md': unit(
      { epic_id: 'E50', title: 'Fifty', theme: 'demo', status: 'open', features: ['F-1'] },
      'E50',
    ),
    'epics/E51-fifty-one/index.md': unit({ epic_id: 'E51', title: 'Fifty-one', theme: 'demo' }, 'E51'),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  addOrigin(dir);
  return dir;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const fm = (dir, rel) => parseFrontmatter(read(dir, rel)).fm;
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const script = (dir, ...args) =>
  spawnSyncFiles(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });
const COUNTS = 'features: 2 (stories: 1, points: 2, components: 1); epics: 1 (features: 1, status: 1)';

/** What bl derives: each feature's stories, points and components, each epic's features and status. */
function derived(dir) {
  const g = loadBacklog(loadConfig({ backlogRoot: dir }), { reload: true });
  return {
    features: [...g.features.values()].map((f) => [
      f.id,
      f.stories.map((s) => s.id),
      f.points,
      f.components.map((c) => c.id),
    ]),
    epics: [...g.epics.values()].map((e) => [e.id, e.features.map((f) => f.id), e.status]),
  };
}

const derivedKeyFindings = (dir) => {
  const v = runBl(['validate', '--json'], { cwd: dir });
  return JSON.parse(v.stdout)
    .findings.filter((f) => f.code === 'derived-key')
    .map((f) => f.location)
    .sort();
};

test('--dry-run prints each file it would rewrite and the per-kind counts, and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const r = script(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would rewrite features\/F1-one\/index\.md \(stories, points, components removed\)$/m);
  assert.match(r.stdout, /^would rewrite features\/F2-two\/index\.md \(points removed\)$/m);
  assert.match(r.stdout, /^would rewrite epics\/E50-fifty\/index\.md \(features, status removed\)$/m);
  assert.match(r.stdout, /^would append {2}MIGRATION\.md$/m);
  assert.doesNotMatch(r.stdout, /F3-three|E51|stories\/|components\//);
  assert.match(r.stdout, new RegExp(`^${COUNTS.replace(/[()]/g, '\\$&')}$`, 'm'));
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a run removes every derived key in one commit, derives the same, and a second run changes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const was = derived(dir);
  assert.deepEqual(derivedKeyFindings(dir), [
    'epics/E50-fifty/index.md',
    'epics/E50-fifty/index.md',
    'features/F1-one/index.md',
    'features/F1-one/index.md',
    'features/F1-one/index.md',
    'features/F2-two/index.md',
  ]);
  const untouched = ['features/F3-three/index.md', 'epics/E51-fifty-one/index.md', 'stories/S1-one/index.md'];
  // Their frontmatter, as the migration's own sync regenerates tables in bodies.
  const kept = Object.fromEntries(untouched.map((p) => [p, fm(dir, p)]));

  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^committed \d+ backlog path\(s\) in \w+ chore: F-77 derived-keys migration: features: 2 /m);
  assert.equal(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(statusLines(dir), []);

  assert.deepEqual(fm(dir, 'features/F1-one/index.md'), {
    feature_id: 'F-1',
    title: 'One',
    theme: 'demo',
    epic: 'E50',
    status: 'running',
    review_rounds_max: '2',
  });
  assert.deepEqual(fm(dir, 'features/F2-two/index.md'), {
    feature_id: 'F-2',
    title: 'Two',
    theme: 'demo',
    status: 'draft',
  });
  assert.deepEqual(fm(dir, 'epics/E50-fifty/index.md'), { epic_id: 'E50', title: 'Fifty', theme: 'demo' });
  assert.match(read(dir, 'features/F1-one/index.md'), /\n# F-1\n\n## Summary\n\nWhy\.\n/);
  for (const p of untouched) assert.deepEqual(fm(dir, p), kept[p], p);
  assert.match(read(dir, 'MIGRATION.md'), /^## F-77 derived-keys migration \(\d{4}-\d\d-\d\d\)$/m);

  assert.deepEqual(derived(dir), was);
  assert.deepEqual(derivedKeyFindings(dir), []);

  const after = head(dir);
  const again = script(dir, '--dry-run');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^features: 0 \(stories: 0, points: 0, components: 0\); epics: 0 /m);
  assert.doesNotMatch(again.stdout, /would rewrite/);
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(head(dir), after);
  assert.deepEqual(statusLines(dir), []);
});

test('it refuses a dirty backlog and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  writeFileSync(join(dir, 'stray.txt'), 'untracked\n');
  const r = script(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /migration refused: the backlog's work tree is not clean \(\?\? stray\.txt\)/);
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), ['?? stray.txt']);
});

test('a commit that fails leaves the backlog as it was: every key kept, no MIGRATION.md', async () => {
  const dir = oldBacklog();
  const before = head(dir);
  const f1 = read(dir, 'features/F1-one/index.md');
  await assert.rejects(
    migrate(loadConfig({ backlogRoot: dir }), {
      log: () => {},
      commit: async () => {
        throw new Error('push rejected');
      },
    }),
    /^Error: migration failed: push rejected; backlog restored; fix the cause and rerun$/,
  );
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(read(dir, 'features/F1-one/index.md'), f1);
});
