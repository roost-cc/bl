/**
 * Integration tests for `bl move` (F-61 D5): each story's `component:`
 * rewritten and committed by path with the regenerated component indexes,
 * `--no-sync`, `--json`, the ids in any order, a cross-repo move, the
 * unchanged report, every refusal leaving every story byte for byte, and the
 * stories already written restored when a later write fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { main as moveMain } from '../../src/move.js';
import { _hooks } from '../../src/atomic-write.js';
import { updateSpecFile } from '../../src/spec-file.js';

/** demo-repo's C00 and C01, other-repo's C02, and C03 with no repo. */
const COMPONENTS = [
  { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true },
  { id: 'C01', title: 'Widgets', dirSuffix: 'widgets', repo: 'demo-repo' },
  { id: 'C02', title: 'Other', dirSuffix: 'other', repo: 'other-repo', home: true },
  { id: 'C03', title: 'Bare', dirSuffix: 'bare' },
];
const REPOS = ['../demo-repo', '../other-repo'];

const story = (n) => `stories/S${n}/index.md`;

const bl = (args, cwd, opts = {}) => runBl(args, { cwd, env: { ...GIT_ENV, ...(opts.env ?? {}) } });
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const fm = (dir, rel) => parseFrontmatter(read(dir, rel)).fm;

/**
 * S-1 (in F-1) and S-2, S-3 in C00, refined; `stories` overrides each
 * story's fixture fields by id. F-1 has status `featureStatus`.
 */
function backlog({ featureStatus = 'refined', featureStories = ['S-1'], stories = {}, git: inGit = false } = {}) {
  const { dir } = mkTempBacklog({
    repos: REPOS,
    components: COMPONENTS,
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', feature: 'F-1', status: 'refined', ...stories['S-1'] },
      { id: 'S-2', component: 'C00', title: 'Two', status: 'refined', ...stories['S-2'] },
      { id: 'S-3', component: 'C00', title: 'Three', status: 'backlog', ...stories['S-3'] },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: featureStatus, stories: featureStories }],
  });
  if (inGit) initGitBacklog(dir);
  return dir;
}

const snapshot = (dir) => [1, 2, 3].map((n) => read(dir, story(n)));

test("bl move rewrites each story's component: and commits the story dirs and both component indexes", () => {
  const dir = backlog({ git: true });
  const s2 = read(dir, story(2));
  const r = bl(['move', 'S-2', 'S-3', 'C01'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'stdout is empty without --json');
  assert.match(r.stderr, /Moved S-2 from C00 to C01\./);
  assert.equal(fm(dir, story(2)).component, 'C01');
  assert.equal(fm(dir, story(3)).component, 'C01');
  assert.equal(fm(dir, story(1)).component, 'C00', 'a story not named is not moved');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: move S-2, S-3 to C01');
  const paths = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  for (const p of ['components/C00-core/index.md', 'components/C01-widgets/index.md', story(2), story(3)]) {
    assert.ok(paths.includes(p), `${p} in ${paths.join(', ')}`);
  }
  assert.ok(!paths.includes(story(1)), 'S-1 is not committed');
  assert.match(read(dir, 'components/C01-widgets/index.md'), /S-2/);
  assert.doesNotMatch(read(dir, 'components/C00-core/index.md'), /\bS-2\b/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  // The story keeps its sections, byte for byte apart from the key.
  assert.equal(read(dir, story(2)), s2.replace('component: C00\n', 'component: C01\n'));
});

test('bl move --no-sync writes the stories and commits nothing', () => {
  const dir = backlog({ git: true });
  const head = git(dir, 'rev-parse', 'HEAD');
  const index = read(dir, 'index.md');
  const before = read(dir, story(2));
  const r = bl(['move', 'S-2', 'C01', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(dir, story(2)), before.replace('component: C00\n', 'component: C01\n'), 'only the key changes');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(read(dir, 'index.md'), index, 'the indexes are not regenerated');
  assert.deepEqual(git(dir, 'status', '--porcelain').trim(), `M ${story(2)}`);
});

test('bl move --json, the ids in any order and form, a repeated story once', () => {
  const dir = backlog();
  const r = bl(['move', 'c1', 's3', 'S-2', 's-3', '--json', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    schema: 'bl-move-json/v1',
    component: 'C01',
    moved: ['S-3', 'S-2'],
    unchanged: [],
  });
  assert.equal(fm(dir, story(2)).component, 'C01');
  assert.equal(fm(dir, story(3)).component, 'C01');
});

test('bl move reports a story already in the component as unchanged, whatever its status', () => {
  const dir = backlog({ git: true, stories: { 'S-3': { component: 'C01', status: 'in_progress' } } });
  const s3 = read(dir, story(3));
  const r = bl(['move', 'S-2', 'S-3', 'C01', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    schema: 'bl-move-json/v1',
    component: 'C01',
    moved: ['S-2'],
    unchanged: ['S-3'],
  });
  assert.match(r.stderr, /S-3 is already in C01; nothing to do\./);
  assert.equal(read(dir, story(3)), s3);
  assert.ok(!git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes(story(3)));
});

test('bl move with every story unchanged writes and commits nothing', () => {
  const dir = backlog({ git: true });
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['move', 'S-2', 'C00', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).moved, []);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('bl move takes an unbranched story to another repo, in a feature before it runs too', () => {
  for (const featureStatus of ['draft', 'refined', 'approved', 'running']) {
    const dir = backlog({ featureStatus });
    // S-1 is in F-1; S-2 is in no feature, so a running F-1 does not hold it.
    const args = featureStatus === 'running' ? ['S-2', 'C02'] : ['S-1', 'S-2', 'C02'];
    const r = bl(['move', ...args, '--no-sync'], dir);
    assert.equal(r.status, 0, `${featureStatus}: ${r.stderr}`);
    assert.equal(fm(dir, story(2)).component, 'C02', featureStatus);
    const w = bl(['which', 'S-2'], dir);
    assert.equal(w.status, 0, w.stderr);
  }
});

test('bl move keeps a story of a running feature in its repo', () => {
  for (const featureStatus of ['running', 'escalated']) {
    const dir = backlog({ featureStatus });
    const r = bl(['move', 'S-1', 'C01', '--no-sync'], dir);
    assert.equal(r.status, 0, `${featureStatus}: ${r.stderr}`);
    assert.equal(fm(dir, story(1)).component, 'C01', featureStatus);
  }
});

test('move_refuses_cross_repo_for_listed_feature_members_with_missing_or_invalid_backlinks', () => {
  // S-1's backlink as written: valid, missing, empty, not a feature id, a feature that does not exist.
  const backlinks = {
    valid: 'feature: F-1\n',
    missing: '',
    empty: "feature: ''\n",
    malformed: 'feature: not-a-feature\n',
    dangling: 'feature: F-9\n',
  };
  for (const featureStatus of ['running', 'escalated']) {
    for (const listed of [true, false]) {
      for (const [kind, line] of Object.entries(backlinks)) {
        const label = `${featureStatus} listed=${listed} ${kind}`;
        const member = listed || kind === 'valid';
        const dir = backlog({ featureStatus, featureStories: listed ? ['S-1'] : [] });
        writeFileSync(join(dir, story(1)), read(dir, story(1)).replace('feature: F-1\n', line));
        const before = snapshot(dir);
        // A cross-repo move, with S-2 an otherwise movable sibling.
        let r = bl(['move', 'S-2', 'S-1', 'C02', '--no-sync'], dir);
        if (member) {
          assert.equal(r.status, 1, `${label}: ${r.stderr}`);
          assert.match(
            r.stderr,
            new RegExp(`S-1 is in F-1, which is ${featureStatus}: moving it to C02 changes its repo`),
            label,
          );
          assert.deepEqual(snapshot(dir), before, `${label}: the batch is untouched`);
        } else {
          assert.equal(r.status, 0, `${label}: ${r.stderr}`);
          assert.equal(fm(dir, story(1)).component, 'C02', label);
          assert.equal(fm(dir, story(2)).component, 'C02', label);
          continue;
        }
        // The same repo: the feature's branches already span it.
        r = bl(['move', 'S-2', 'S-1', 'C01', '--no-sync'], dir);
        assert.equal(r.status, 0, `${label} same repo: ${r.stderr}`);
        assert.equal(fm(dir, story(1)).component, 'C01', label);
      }
    }
  }
});

test('bl move refuses the whole call, writing nothing and naming every offending story', () => {
  const cases = [
    { args: ['C01'], err: /takes one or more story ids and one component id/ },
    { args: ['S-2'], err: /takes one or more story ids and one component id/ },
    { args: ['S-2', 'C01', 'C02'], err: /takes one or more story ids and one component id/ },
    { args: ['S-2', 'F-1'], err: /'F-1' is not a story \(S-<n>\) or component \(C-<n>\) id/ },
    { args: ['S-2', 'C09'], err: /component C09 not found under components\// },
    { args: ['S-2', 'C03'], err: /component C03 names no repo/ },
    {
      args: ['S-2', 'S-8', 'S-9', 'C01'],
      err: /nothing was moved:\n {2}S-8 not found under stories\/\.\n {2}S-9 not found under stories\/\.$/m,
    },
    {
      opts: { stories: { 'S-2': { status: 'in_progress' }, 'S-3': { status: 'done' } } },
      args: ['S-2', 'S-3', 'C01'],
      err: /S-2 is in_progress; only a backlog or refined story moves to another component\.\n {2}S-3 is done; only a backlog/,
    },
    {
      opts: { stories: { 'S-3': { status: 'superseded' } } },
      args: ['S-2', 'S-3', 'C01'],
      err: /S-3 is superseded/,
    },
    {
      opts: { featureStatus: 'running' },
      args: ['S-1', 'S-2', 'C02'],
      err: /S-1 is in F-1, which is running: moving it to C02 changes its repo from demo-repo to other-repo, and the feature's branches span a fixed set of repos\./,
    },
    {
      opts: { featureStatus: 'escalated' },
      args: ['S-1', 'C02'],
      err: /S-1 is in F-1, which is escalated: moving it to C02 changes its repo/,
    },
  ];
  for (const { args, opts = {}, err } of cases) {
    const dir = backlog(opts);
    const before = snapshot(dir);
    const r = bl(['move', ...args, '--no-sync', '--json'], dir);
    const label = `${args.join(' ')} ${JSON.stringify(opts)}`;
    assert.equal(r.status, 1, `${label}: ${r.stderr}`);
    assert.match(r.stderr, err, label);
    assert.equal(r.stdout, '', label);
    assert.deepEqual(snapshot(dir), before, `${label}: stories untouched`);
  }
});

test('bl move takes one component named twice in two forms', () => {
  const dir = backlog();
  const r = bl(['move', 'C01', 'S-2', 'c-1', '--no-sync', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).moved, ['S-2']);
});

test('bl move refuses a story whose frontmatter does not parse, naming it, and writes nothing', () => {
  const dir = backlog();
  writeFileSync(join(dir, story(3)), read(dir, story(3)).replace('title: Three', 'title: [Three'));
  const before = snapshot(dir);
  const r = bl(['move', 'S-2', 'S-3', 'C01', '--no-sync'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /nothing was moved:\n {2}.*S3/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  assert.deepEqual(snapshot(dir), before);
});

test('bl move fixes a story whose component is unknown', () => {
  const dir = backlog();
  writeFileSync(join(dir, story(2)), read(dir, story(2)).replace('component: C00', 'component: C99'));
  const r = bl(['move', 'S-2', 'C01', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Moved S-2 from C99 to C01\./);
  assert.equal(fm(dir, story(2)).component, 'C01');
});

test('bl move restores the stories already written when a later write fails', () => {
  const dir = backlog({ git: true });
  const before = snapshot(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  // The third write (S-1's) fails after S-2 and S-3 are written.
  let r = bl(['move', 'S-2', 'S-3', 'S-1', 'C01'], dir, { env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '3' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not write S-1: .*BL_INTERNAL_TEST_FAIL_ON_RENAME.*\. S-2, S-3 are restored\./);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');

  // The first write fails: nothing to restore.
  r = bl(['move', 'S-2', 'C01', '--no-sync'], dir, { env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not write S-2: .*\. Nothing was changed\./);
  assert.deepEqual(snapshot(dir), before);

  // The restore fails too: S-3's write is refused, then S-2's restore (the
  // second rename) fails, and the operator is told which story to fix.
  r = bl(['move', 'S-2', 'S-3', 'C01', '--no-sync'], dir, {
    env: { BL_INTERNAL_TEST_FAIL_ON_LINK: 'S-3', BL_INTERNAL_TEST_FAIL_ON_RENAME: '2' },
  });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /could not write S-3: injected write failure at S-3\. Could not restore S-2 \(.*\): set component: back by hand\./,
  );
  assert.equal(fm(dir, story(2)).component, 'C01');
  assert.equal(read(dir, story(3)), before[2]);
});

test('move_rollback_preserves_concurrent_spec_updates', async () => {
  // In process, so a writer can save S-2 and S-3 between their move and the
  // failed write of S-1 that rolls them back.
  const dir = backlog();
  const before = snapshot(dir);
  const savedDir = process.env.BL_BACKLOG_DIR;
  const savedExit = process.exit;
  process.env.BL_BACKLOG_DIR = dir;
  let renames = 0;
  _hooks.beforeRename = () => {
    if (++renames !== 3) return;
    _hooks.beforeRename = null;
    for (const n of [2, 3]) {
      updateSpecFile(dir, join(dir, story(n)), (f, body) => {
        f.tokens_input = 999;
        return `${body}\nA note from another writer.\n`;
      });
    }
    throw new Error('third write failed');
  };
  process.exit = (code) => {
    throw new Error(`exit ${code}`);
  };
  try {
    await assert.rejects(moveMain(['S-2', 'S-3', 'S-1', 'C01', '--no-sync']), /exit 1/);
  } finally {
    _hooks.beforeRename = null;
    process.exit = savedExit;
    if (savedDir === undefined) delete process.env.BL_BACKLOG_DIR;
    else process.env.BL_BACKLOG_DIR = savedDir;
  }
  for (const n of [2, 3]) {
    const f = fm(dir, story(n));
    assert.equal(f.component, 'C00', `S-${n}'s component is restored`);
    assert.equal(String(f.tokens_input), '999', `S-${n}'s concurrent frontmatter update stays`);
    assert.match(read(dir, story(n)), /A note from another writer\.\n$/, `S-${n}'s concurrent body update stays`);
    // Nothing else changed: the file is the one before the move plus the other writer's change.
    assert.equal(
      read(dir, story(n)).replace('tokens_input: 999\n', '').replace('\nA note from another writer.\n', ''),
      before[n - 1],
    );
  }
  assert.equal(read(dir, story(1)), before[0], 'the failed story is untouched');
});

test('bl move --help lists the flags and the refusals, and bl --help lists the verb', () => {
  const dir = backlog();
  const r = bl(['move', '--help'], dir);
  assert.equal(r.status, 0, r.stderr);
  for (const s of [
    '--no-sync',
    '--json',
    'bl-move-json/v1',
    'does not exist',
    'names no repo',
    'backlog or refined',
    'running or\n    escalated',
  ]) {
    assert.ok(r.stdout.includes(s), s);
  }
  const top = bl(['--help'], dir);
  assert.match(top.stdout, /^ {2}move {7}Move stories to another component/m);
});
