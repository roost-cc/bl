import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { GIT_ENV, git, initGitBacklog, headFiles, statusLines } from '../helpers/git-backlog.js';
import {
  BYSTANDER,
  NEW_IN_C01,
  componentBacklog,
  edgeSpec,
  fmOf,
  gitEdgeBacklog,
  gitNewBacklog,
  writeSpec,
} from '../helpers/new-fixture.js';

function assertOnlyBystandersDirty(dir) {
  assert.deepEqual(statusLines(dir), [` M ${BYSTANDER}`, 'A  staged.txt']);
}

// ---------------------------------------------------------------------------
// S-704: `bl new` commits the stories it created, and only those.
// ---------------------------------------------------------------------------

test('bl new commits the story dir, nothing else', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'Second'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'stories/S2-second/index.md');
    assert.match(r.stderr, /Committed \d+ backlog path\(s\)\./);

    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-2');
    const files = headFiles(dir);
    assert.ok(files.includes('A\tstories/S2-second/index.md'), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('bystander')), files.join('\n'));
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl new --component commits the new component dir', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl(['new', '--component', '--repo', 'beta', '--title', 'Fresh', '--paths', '**'], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add C04');
    const files = headFiles(dir);
    assert.ok(files.includes('A\tcomponents/C04-fresh/index.md'), files.join('\n'));
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl new --feature commits its story and leaves the feature file alone (F-79 D1)', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'Linked', '--feature', 'F-1'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(headFiles(dir), ['A\tstories/S2-linked/index.md']);
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

/** A git backlog with S-2 and S-3 committed in C01, for `bl new --feature` to link. */
function gitPairBacklog() {
  const t = gitNewBacklog();
  for (const title of ['Two', 'Three']) {
    const r = runBl([...NEW_IN_C01, '--title', title], { cwd: t.dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
  }
  return t;
}

const NEW_PAIR = ['new', '--feature', '--theme', 'demo', '--title', 'Pair', 'S-2', 'S-3'];
const PAIR_STORIES = ['stories/S2-two/index.md', 'stories/S3-three/index.md'];

/** The feature file at `rel` is F-2 in theme demo, and each of `stories` names it. */
function assertFeatureF2(dir, rel, title, stories) {
  const fm = fmOf(dir, rel);
  assert.deepEqual([fm.feature_id, fm.title, fm.theme], ['F-2', title, 'demo']);
  for (const p of stories) assert.equal(fmOf(dir, p).feature, 'F-2', p);
}

test('bl new --feature commits the feature and the stories it links (S-1368)', () => {
  const { dir, cleanup } = gitPairBacklog();
  try {
    const r = runBl(NEW_PAIR, { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'features/F2-pair/index.md');
    assertFeatureF2(dir, 'features/F2-pair/index.md', 'Pair', PAIR_STORIES);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add F-2');
    assert.deepEqual(headFiles(dir).sort(), [
      'A\tfeatures/F2-pair/index.md',
      'M\tstories/S2-two/index.md',
      'M\tstories/S3-three/index.md',
    ]);
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl new --feature with no story ids commits the feature alone (S-1368)', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl(['new', '--feature', '--theme', 'demo', '--title', 'Solo'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add F-2');
    assertFeatureF2(dir, 'features/F2-solo/index.md', 'Solo', []);
    assert.deepEqual(headFiles(dir), ['A\tfeatures/F2-solo/index.md']);
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl new --feature --no-sync makes no commit (S-1368)', () => {
  const { dir, cleanup } = gitPairBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl([...NEW_PAIR, '--no-sync'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Skipped the commit\. Commit it with 'bl sync --commit'\./);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assertFeatureF2(dir, 'features/F2-pair/index.md', 'Pair', PAIR_STORIES);
    assert.ok(statusLines(dir).includes('?? features/F2-pair/index.md'), statusLines(dir).join('\n'));
  } finally {
    cleanup();
  }
});

// A linked story whose index.md was dirty before the command is committed
// whole, with the new line; a staged file beside it stays staged and out.
for (const [name, setup, target, args, check] of [
  ['bl new --feature', gitPairBacklog, 'stories/S2-two/index.md', NEW_PAIR, (fm) => assert.equal(fm.feature, 'F-2')],
  [
    'bl new --required-for',
    gitEdgeBacklog,
    'stories/S1-later/index.md',
    [...NEW_IN_C01, '--title', 'First', '--required-for', 'S-1'],
    (fm) => assert.deepEqual(fm.depends_on, ['S-3']),
  ],
  [
    "bl new --from with a spec's required_for",
    gitEdgeBacklog,
    'stories/S1-later/index.md',
    (dir) => ['new', '--from', edgeSpec(dir)],
    (fm) => assert.deepEqual(fm.depends_on, ['S-3']),
  ],
]) {
  test(`${name} commits a dirty linked index but excludes its sibling file`, () => {
    const { dir, cleanup } = setup();
    const sibling = join(dirname(target), 'notes.md');
    try {
      writeFileSync(join(dir, target), '\nAn edit made before the command.\n', { flag: 'a' });
      writeFileSync(join(dir, sibling), '# Notes\n');
      git(dir, 'add', sibling);
      const r = runBl(typeof args === 'function' ? args(dir) : args, { cwd: dir, env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
      const committed = git(dir, 'show', `HEAD:${target}`);
      assert.equal(committed, readFileSync(join(dir, target), 'utf8').trim());
      assert.match(committed, /An edit made before the command\./);
      check(parseFrontmatter(committed).fm);
      assert.ok(!headFiles(dir).some((f) => f.endsWith(sibling)), headFiles(dir).join('\n'));
      assert.ok(statusLines(dir).includes(`A  ${sibling}`), statusLines(dir).join('\n'));
    } finally {
      cleanup();
    }
  });
}

// feature_commit_excludes_formatter_sidecars: every `bl new` branch commits
// the files it wrote and nothing else. The Markdown formatter here writes a
// `sidecar.txt` beside each file it formats; that file stays out of the commit.
// `fm` holds, per committed index.md, the frontmatter fields its HEAD copy has.
for (const [name, args, committed, sidecar, fm] of [
  [
    'story',
    () => ['new', 'C01', '--points', '1', '--title', 'Fresh'],
    ['A\tstories/S3-fresh/index.md'],
    'stories/S3-fresh',
    { 'stories/S3-fresh/index.md': { story_id: 'S-3', title: 'Fresh', component: 'C01' } },
  ],
  [
    'batch',
    (dir) => ['new', '--from', writeSpec(dir)],
    ['A\tstories/S3-alpha/index.md', 'A\tstories/S4-bravo/index.md'],
    'stories/S3-alpha',
    {
      'stories/S3-alpha/index.md': { story_id: 'S-3', title: 'Alpha', component: 'C01' },
      'stories/S4-bravo/index.md': { story_id: 'S-4', title: 'Bravo', component: 'C02' },
    },
  ],
  [
    'component',
    () => ['new', '--component', '--repo', 'beta', '--title', 'Fresh', '--paths', '**'],
    ['A\tcomponents/C04-fresh/index.md'],
    'components/C04-fresh',
    { 'components/C04-fresh/index.md': { component_id: 'C04', title: 'Fresh', repo: 'beta' } },
  ],
  [
    'theme',
    (dir) => ['new', '--theme', 'ops', '--title', 'Ops', '--brief', `${basename(dir)}/backlog.json`],
    ['A\tthemes/ops/index.md'],
    'themes/ops',
    { 'themes/ops/index.md': { theme_id: 'ops', title: 'Ops' } },
  ],
  [
    'epic',
    () => ['new', '--epic', '--theme', 'demo', '--title', 'Hub'],
    ['A\tepics/E50-hub/index.md'],
    'epics/E50-hub',
    { 'epics/E50-hub/index.md': { epic_id: 'E50', title: 'Hub', theme: 'demo' } },
  ],
  [
    'feature with stories',
    () => ['new', '--feature', '--theme', 'demo', '--title', 'Pair', 'S-1', 'S-2'],
    ['A\tfeatures/F1-pair/index.md', 'M\tstories/S1-one/index.md', 'M\tstories/S2-two/index.md'],
    'features/F1-pair',
    {
      'features/F1-pair/index.md': { feature_id: 'F-1', title: 'Pair', theme: 'demo' },
      'stories/S1-one/index.md': { story_id: 'S-1', feature: 'F-1' },
      'stories/S2-two/index.md': { story_id: 'S-2', feature: 'F-1' },
    },
  ],
  [
    'feature with no stories',
    () => ['new', '--feature', '--theme', 'demo', '--title', 'Solo'],
    ['A\tfeatures/F1-solo/index.md'],
    'features/F1-solo',
    { 'features/F1-solo/index.md': { feature_id: 'F-1', title: 'Solo', theme: 'demo' } },
  ],
]) {
  test(`feature_commit_excludes_formatter_sidecars: ${name}`, () => {
    const { dir, cleanup } = componentBacklog({
      stories: [
        { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one' },
        { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two' },
      ],
    });
    try {
      const script = join(dir, 'sidecar-formatter.mjs');
      writeFileSync(
        script,
        "import { writeFileSync } from 'node:fs';\nimport { dirname, join } from 'node:path';\n" +
          "for (const p of process.argv.slice(2)) writeFileSync(join(dirname(p), 'sidecar.txt'), 'formatter\\n');\n",
      );
      const cfgPath = join(dir, 'backlog.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      cfg.plugins = { ...cfg.plugins, md: { format: `node ${script} {{path}}` } };
      cfg.language_dispatch = { ...cfg.language_dispatch, format: { '.md': 'md' } };
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      initGitBacklog(dir);
      const r = runBl(args(dir), { cwd: dir, env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(headFiles(dir), committed);
      assert.deepEqual(Object.keys(fm).sort(), committed.map((f) => f.split('\t')[1]).sort());
      for (const [rel, want] of Object.entries(fm)) {
        const got = parseFrontmatter(git(dir, 'show', `HEAD:${rel}`)).fm;
        assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])), want, rel);
      }
      assert.ok(statusLines(dir).includes(`?? ${sidecar}/sidecar.txt`), statusLines(dir).join('\n'));
    } finally {
      cleanup();
    }
  });
}

test('bl new --json keeps stdout a single JSON object while it commits', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'Json', '--json'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, 'S-2');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-2');
  } finally {
    cleanup();
  }
});

test('bl new --no-sync makes no commit', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl([...NEW_IN_C01, '--title', 'Later', '--no-sync'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    cleanup();
  }
});
