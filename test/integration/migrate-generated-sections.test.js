/**
 * Integration tests for `scripts/migrate-generated-sections.js` and the
 * `generated-section` finding (F-79 D3). The fixture backlog has each page
 * kind as `bl sync` left it before F-79: its committed text with the
 * generated tables placed in it (`renderPage`), and the root `index.md` with
 * its "Total backlog" line and the old `## Features` and `## Backlog` tables.
 * The migration gives back each page as written by hand, byte for byte, in
 * one commit; `--dry-run` writes nothing; a second run changes nothing; a
 * story's hand-written `## Tasks` stays; and `bl validate` reports each
 * generated section before, and none after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadBacklog } from '../../src/backlog-graph.js';
import { loadConfig } from '../../src/config.js';
import { removeSection } from '../../src/feature.js';
import { migrate, stripGenerated } from '../../src/migrate-generated-sections.js';
import { renderPage } from '../../src/render.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { addOrigin, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-generated-sections.js', import.meta.url));

const ROOT = '---\ntitle: Backlog\n---\n\n# Backlog\n\nHand-written intro.\n';
const HAND_TASKS =
  '## Summary\n\nx\n\n## Tasks\n\n### Move files\n\n| File | To |\n| ---- | -- |\n| a.js | b/ |\n\nThen check.\n';
const OLD_TASKS =
  '\n## Tasks\n\n| ID | Title | Holds | Status | Done |\n| -- | ----- | ----- | ------ | ---- |\n| [T-1](../../tasks/T1-x.md) | x | none | open | |\n';

const PAGES = {
  root: 'index.md',
  theme: 'themes/demo/index.md',
  epic: 'epics/E50/index.md',
  component: 'components/C01-work/index.md',
  feature: 'features/F1-one/index.md',
  story: 'stories/S1-one/index.md',
  hand: 'stories/S2-hand/index.md',
};

/**
 * A clean backlog at origin/main whose pages carry the generated sections;
 * returns the dir and each page as written by hand.
 */
function oldBacklog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work', dirSuffix: 'work' }],
    valueEpics: [{ id: 'E50', title: 'Epic' }],
    features: [{ id: 'F-1', title: 'One', dirSuffix: 'one', epic: 'E50', status: 'approved', stories: ['S-1'] }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'backlog', body: '## Summary\n\nx\n' },
      { id: 'S-2', component: 'C01', title: 'Hand', dirSuffix: 'hand', status: 'done', body: HAND_TASKS },
    ],
  });
  writeFileSync(join(dir, 'index.md'), ROOT);
  // The story ends as a page does once its last section is a generated one that went.
  writeFileSync(join(dir, PAGES.story), read(dir, PAGES.story).trimEnd() + '\n');
  const hand = Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, read(dir, p)]));

  // The pages as the old bl sync left them.
  const graph = loadBacklog(loadConfig({ backlogRoot: dir }), { reload: true });
  const root = renderPage(graph, null);
  writeFileSync(
    join(dir, PAGES.root),
    `${root}\n## Features\n\n| ID | Title |\n| -- | ----- |\n| [F-1](features/F1-one/index.md) | One |\n\n## Backlog\n\n| ID | Title |\n| -- | ----- |\n`,
  );
  for (const id of ['demo', 'E50', 'C01', 'F-1']) {
    const u = graph.get(id);
    writeFileSync(u.file, renderPage(graph, u));
  }
  writeFileSync(join(dir, PAGES.story), hand.story + OLD_TASKS);
  initGitBacklog(dir);
  addOrigin(dir);
  return { dir, hand };
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const script = (dir, ...args) =>
  spawnSyncFiles(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });
const generated = (dir) =>
  JSON.parse(runBl(['validate', '--json'], { cwd: dir }).stdout)
    .findings.filter((f) => f.code === 'generated-section')
    .map((f) => `${f.location} ${f.message.split(' is ')[0]}`)
    .sort();

test('removeSection removes every matching section, keeps the rest, and ends the body once', () => {
  assert.equal(removeSection('## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n', 'B'), '## A\n\na\n\n## C\n\nc\n');
  assert.equal(removeSection('## A\n\na\n\n## B\n\nb\n\n\n', 'B'), '## A\n\na\n');
  assert.equal(removeSection('## A\r\n\r\na\r\n\r\n## B\r\n\r\nb\r\n', 'B'), '## A\r\n\r\na\r\n');
  assert.equal(removeSection('## B\n\n1\n\n## A\n\na\n\n## B\n\n2\n', 'B'), '## A\n\na\n');
  assert.equal(removeSection('### B\n\nb\n', 'B'), '### B\n\nb\n', 'a level-3 heading stays');
  assert.equal(
    removeSection('## B\n\nprose\n', 'B', () => false),
    '## B\n\nprose\n',
  );
});

test('stripGenerated removes the root total line and table sections only, and returns null when nothing goes', () => {
  const body =
    '# B\n\nTotal backlog: 3 points across 2 stories in 1 components.\n\nintro\n\n## Themes\n\n| a |\n| - |\n';
  assert.equal(stripGenerated(`---\nt: 1\n---\n${body}`, body, ['Themes'], true), '---\nt: 1\n---\n# B\n\nintro\n');
  assert.equal(stripGenerated('## Tasks\n\nprose\n', '## Tasks\n\nprose\n', ['Tasks'], false), null);
  assert.equal(stripGenerated('x\n', 'x\n', ['Tasks'], false), null);
});

test('bl validate reports each generated section, naming file and heading, and not a hand-written one', () => {
  const { dir } = oldBacklog();
  assert.deepEqual(generated(dir), [
    `${PAGES.component} "## Features"`,
    `${PAGES.component} "## Stories"`,
    `${PAGES.epic} "## Features"`,
    `${PAGES.feature} "## Stories"`,
    `${PAGES.root} "## Components"`,
    `${PAGES.root} "## Priority"`,
    `${PAGES.root} "## Themes"`,
    `${PAGES.story} "## Tasks"`,
    `${PAGES.theme} "## Epics"`,
    `${PAGES.theme} "## Features"`,
  ]);
  const r = runBl(['validate', '--json'], { cwd: dir });
  const f = JSON.parse(r.stdout).findings.find((x) => x.code === 'generated-section');
  assert.equal(f.severity, 'error');
});

test('--dry-run prints the pages per kind, and writes nothing', () => {
  const { dir } = oldBacklog();
  const before = head(dir);
  const r = script(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'would remove generated sections from 1 root, 1 component, 1 epic, 1 theme, 1 feature, 1 story page(s)\n',
  );
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a run gives back every page as written by hand in one commit, and a second run changes nothing', async () => {
  const { dir, hand } = oldBacklog();
  const before = head(dir);
  const r = await migrate(loadConfig({ backlogRoot: dir }), { log: () => {} });
  assert.equal(r.commit?.committed, true, JSON.stringify(r.commit));
  assert.equal(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(statusLines(dir), []);
  assert.match(git(dir, 'log', '-1', '--format=%s'), /^chore: F-79 generated-sections migration: .* \(6 pages\)$/);
  assert.deepEqual(
    git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    Object.entries(PAGES)
      .filter(([k]) => k !== 'hand')
      .map(([, p]) => p)
      .sort(),
  );
  for (const [k, p] of Object.entries(PAGES)) assert.equal(read(dir, p), hand[k], k);
  assert.deepEqual(generated(dir), []);

  const after = head(dir);
  const again = script(dir, '--dry-run');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'no page has a generated section: nothing to migrate\n');
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(head(dir), after);
  assert.deepEqual(statusLines(dir), []);
});

test('it refuses a backlog that is not clean at origin/main, and writes nothing', () => {
  const { dir } = oldBacklog();
  writeFileSync(join(dir, 'stray.md'), 'x\n');
  const before = head(dir);
  const r = script(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /migration refused: the backlog's work tree is not clean/);
  assert.equal(head(dir), before);
  assert.match(read(dir, PAGES.feature), /^## Stories$/m);
});
