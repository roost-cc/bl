/**
 * Integration tests for `scripts/migrate-depends-on.js` (F-111 D5, Decision
 * A3): it writes each story's `depends_on:` entries to `blockers.json` as
 * order and run edges, removes a story's `depends_on:` only when every edge
 * it gives is in the file, removes every `required_for:` and empty
 * `depends_on:` (closed stories too), commits once, and a second run changes
 * nothing. `--dry-run` prints the counts and writes nothing. What bl reads is
 * the same before and after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { parseBlockers } from '../../src/blockers.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';
import { addOrigin, git, statusLines } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { migrate } from '../../src/migrate-depends-on.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-depends-on.js', import.meta.url));

const unit = (fm, heading) => `${serializeFrontmatter(fm)}\n# ${heading}\n\n## Summary\n\nWhy.\n`;
const story = (id, { status = 'backlog', feature = '', ...keys } = {}) =>
  unit(
    {
      component: 'C32',
      story_id: id,
      title: `Story ${id}`,
      type: 'chore',
      points: '1',
      status,
      added: '2026-11-01',
      feature,
      ...keys,
    },
    id,
  );

/** The edge S-6 → S-1 is in blockers.json before the migration; S-1's other edges are not. */
const BLOCKERS_BEFORE = `{
  "schema": "bl-blockers/v2",
  "edges": [
    {"blocker":"S-5","gate":"run","unit":"S-6","until":"done"}
  ]
}
`;

/**
 * A backlog in git as bl wrote it before F-111 S-1456: F-1 holds S-1 and S-2
 * (S-2 depends on S-1: an order edge); S-3 is loose and depends on S-1 (a run
 * edge); S-4 depends on S-1 and on S-9, which is no story (it keeps its key);
 * S-5 is done, with an empty `depends_on:` and a `required_for:`; S-6 depends
 * on S-5, an edge `blockers.json` already holds.
 */
function oldBacklog() {
  const dir = mkTempDir('bl-migrate-depends-on-');
  const files = {
    '.gitignore': '.workon.lock\n.bl/\n',
    'flow.json': readFileSync(FLOW_TEMPLATE, 'utf8'),
    'backlog.json': `${JSON.stringify({ agent: [{ agent: 'claude' }], review_agent: [{ agent: 'claude' }], effort: { refine: 'high', review: 'high', default: 'high' }, worktrees: '../worktrees', repos: { bl: { path: '../bl', deployable: false, update_tests: [] } } }, null, 2)}\n`,
    'blockers.json': BLOCKERS_BEFORE,
    'index.md': '# Backlog\n',
    'themes/demo/index.md': unit({ theme_id: 'demo', title: 'Demo', repos: ['bl'] }, 'demo'),
    'components/C32-bl/index.md': unit(
      { component_id: 'C32', title: 'bl', repo: 'bl', home: 'true', paths: ['**'] },
      'C32',
    ),
    'features/F1-one/index.md': unit(
      { feature_id: 'F-1', title: 'One', theme: 'demo', status: 'draft', review_rounds_max: '2' },
      'F-1',
    ),
    'stories/S1-one/index.md': story('S-1', { feature: 'F-1' }),
    'stories/S2-two/index.md': story('S-2', { feature: 'F-1', depends_on: ['S-1'] }),
    'stories/S3-three/index.md': story('S-3', { depends_on: ['S-1'] }),
    'stories/S4-four/index.md': story('S-4', { depends_on: ['S-1', 'S-9'] }),
    'stories/S5-five/index.md': story('S-5', { status: 'done', depends_on: '', required_for: ['S-6'] }),
    'stories/S6-six/index.md': story('S-6', { depends_on: ['S-5'] }),
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
const edges = (dir) =>
  parseBlockers(read(dir, 'blockers.json')).map((e) => `${e.blocker} ${e.gate} ${e.unit} ${e.until}`);
const script = (dir, ...args) =>
  spawnSyncFiles(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });
const COUNTS =
  'order edges: 1, run edges: 2, already in blockers: 1, depends on removed: 4, required for removed: 1, files kept: 1, unplaced: 1';

/**
 * What bl prints from the edges: the tree, what next, the feature's status,
 * and validate less `depends-on-key` and `derived-key` (S-5's `required_for:`,
 * which the migration removes).
 */
function views(dir) {
  const bl = (...args) => {
    const r = runBl(args, { cwd: dir });
    return r.stdout;
  };
  const findings = JSON.parse(bl('validate', '--json'))
    .findings.filter((f) => f.code !== 'depends-on-key' && f.code !== 'derived-key')
    .map((f) => `${f.code} ${f.location} ${f.message}`)
    .sort();
  return { tree: bl('tree'), whatNext: bl('what-next'), status: bl('status', 'F-1'), findings };
}

test('--dry-run prints the edges, the files, the kept file and the counts, and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const r = script(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would write {3}S-2 at order by S-1 until implemented$/m);
  assert.match(r.stdout, /^would write {3}S-3 at run by S-1 until done$/m);
  assert.match(r.stdout, /^would write {3}S-4 at run by S-1 until done$/m);
  assert.match(r.stdout, /^cannot place S-4 at run by S-9: blocker S-9 is not a unit in the backlog$/m);
  assert.match(r.stdout, /^would rewrite stories\/S5-five\/index\.md \(required_for, depends_on removed\)$/m);
  assert.match(r.stdout, /^would rewrite stories\/S6-six\/index\.md \(depends_on removed\)$/m);
  assert.match(r.stdout, /^keep {4}stories\/S4-four\/index\.md depends_on: \(missing S-4 at run by S-9\)$/m);
  assert.doesNotMatch(r.stdout, /rewrite stories\/S(1|4)-/);
  assert.match(r.stdout, new RegExp(`^${COUNTS}$`, 'm'));
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a run moves every depends_on into blockers.json in one commit, bl reads the same, a second run changes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const was = views(dir);
  const s4 = read(dir, 'stories/S4-four/index.md');

  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^committed \d+ backlog path\(s\) in \w+ chore: F-111 depends_on migration: order edges: 1, /m,
  );
  assert.equal(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(statusLines(dir), []);

  assert.deepEqual(edges(dir), [
    'S-1 order S-2 implemented',
    'S-1 run S-3 done',
    'S-1 run S-4 done',
    'S-5 run S-6 done',
  ]);
  for (const id of ['S1-one', 'S2-two', 'S3-three', 'S5-five', 'S6-six']) {
    const keys = fm(dir, `stories/${id}/index.md`);
    assert.equal(Object.hasOwn(keys, 'depends_on'), false, id);
    assert.equal(Object.hasOwn(keys, 'required_for'), false, id);
  }
  // The rewritten block reads back as the old one less the removed keys, the body as it was.
  const { depends_on: _dep, ...rest } = parseFrontmatter(story('S-2', { feature: 'F-1', depends_on: ['S-1'] })).fm;
  assert.deepEqual(fm(dir, 'stories/S2-two/index.md'), rest);
  assert.match(read(dir, 'stories/S2-two/index.md'), /\n# S-2\n\n## Summary\n\nWhy\.\n$/);
  // S-4's edge to S-9 is missing: it keeps its key, and MIGRATION.md lists it.
  assert.equal(read(dir, 'stories/S4-four/index.md'), s4);
  assert.match(read(dir, 'MIGRATION.md'), /^## F-111 depends_on migration \(\d{4}-\d\d-\d\d\)$/m);
  assert.match(read(dir, 'MIGRATION.md'), /^- S-4: missing S-4 at run by S-9$/m);

  assert.deepEqual(views(dir), was);

  const after = head(dir);
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /^order edges: 0, run edges: 0, already in blockers: 1, .*files kept: 1, unplaced: 1$/m);
  assert.equal(head(dir), after);
  assert.deepEqual(statusLines(dir), []);

  // Fixed (S-9 exists), a later run writes its edge and removes S-4's key.
  mkdirSync(join(dir, 'stories/S9-nine'));
  writeFileSync(join(dir, 'stories/S9-nine/index.md'), story('S-9'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'add S-9');
  git(dir, 'push', '-q', 'origin', 'main');
  const fixed = script(dir);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(
    fixed.stdout,
    /run edges: 1, .*depends on removed: 1, required for removed: 0, files kept: 0, unplaced: 0/,
  );
  assert.equal(Object.hasOwn(fm(dir, 'stories/S4-four/index.md'), 'depends_on'), false);
  assert.ok(edges(dir).includes('S-9 run S-4 done'));
});

test('a commit that fails leaves the backlog as it was: every key and blockers.json kept', async () => {
  const dir = oldBacklog();
  const before = head(dir);
  const s2 = read(dir, 'stories/S2-two/index.md');
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
  assert.equal(read(dir, 'stories/S2-two/index.md'), s2);
  assert.equal(read(dir, 'blockers.json'), BLOCKERS_BEFORE);
});
