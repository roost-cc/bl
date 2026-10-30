/**
 * Integration tests for `bl attach` (S-1095): the story's `feature:` and the
 * feature's `stories:` written and committed by path, `--no-sync`, `--json`,
 * the ids in either order, the no-op, both half-attached repairs, every
 * refusal leaving both files byte for byte, and the story restored when the
 * feature write fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';

/** demo-repo's home C00, and other-repo's home C02. */
const COMPONENTS = [
  { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true },
  { id: 'C02', title: 'Other', dirSuffix: 'other', repo: 'other-repo', home: true },
];
const REPOS = ['../demo-repo', '../other-repo'];

const STORY = 'stories/S2/index.md';
const FEATURE = 'features/F1/index.md';

const bl = (args, cwd, opts = {}) => runBl(args, { cwd, env: { ...GIT_ENV, ...(opts.env ?? {}) } });
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const fm = (dir, rel) => parseFrontmatter(read(dir, rel)).fm;

/**
 * F-1 (status `featureStatus`) lists S-1 (C00, demo-repo); S-2 is the story
 * to attach, with `story` overriding its fixture fields. `features` adds
 * more features.
 */
function backlog({ featureStatus = 'refined', story = {}, stories = ['S-1'], features = [], git: inGit = false } = {}) {
  const { dir } = mkTempBacklog({
    repos: REPOS,
    components: COMPONENTS,
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', feature: 'F-1', status: 'refined' },
      { id: 'S-2', component: 'C00', title: 'Two', status: 'refined', ...story },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: featureStatus, stories }, ...features],
  });
  if (inGit) initGitBacklog(dir);
  return dir;
}

test('bl attach sets feature:, lists the story, and commits the story dir, the feature and the indexes', () => {
  const dir = backlog({ git: true });
  const r = bl(['attach', 'S-2', 'F-1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'stdout is empty without --json');
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.deepEqual(fm(dir, FEATURE).stories, ['S-1', 'S-2']);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: attach S-2 to F-1');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    'components/C00-core/index.md',
    FEATURE,
    'index.md',
    STORY,
    'themes/demo/index.md',
  ]);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  // The story keeps its sections and is valid in the feature.
  const v = bl(['validate', '--json'], dir);
  const codes = JSON.parse(v.stdout).findings.map((f) => f.code);
  assert.ok(!codes.includes('feature-story-unlisted') && !codes.includes('feature-story-mismatch'), codes.join('\n'));
});

test('bl attach --no-sync writes both files under the lock and commits nothing', () => {
  const dir = backlog({ git: true });
  const head = git(dir, 'rev-parse', 'HEAD');
  const index = read(dir, 'index.md');
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.deepEqual(fm(dir, FEATURE).stories, ['S-1', 'S-2']);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(read(dir, 'index.md'), index, 'the indexes are not regenerated');
  assert.deepEqual(
    git(dir, 'status', '--porcelain')
      .split('\n')
      .map((l) => l.trim())
      .sort(),
    [`M ${FEATURE}`, `M ${STORY}`],
  );
});

test('bl attach --json, the ids in reverse order and in any accepted form', () => {
  const dir = backlog();
  const r = bl(['attach', 'f1', 's-2', '--json', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { schema: 'bl-attach-json/v1', story: 'S-2', feature: 'F-1', changed: true });
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.deepEqual(fm(dir, FEATURE).stories, ['S-1', 'S-2']);
});

test('bl attach on a story already in the feature writes and commits nothing', () => {
  const dir = backlog({ git: true, story: { feature: 'F-1', status: 'in_progress' }, stories: ['S-1', 'S-2'] });
  const head = git(dir, 'rev-parse', 'HEAD');
  let r = bl(['attach', 'S-2', 'F-1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /S-2 is already in F-1; nothing to do\./);
  r = bl(['attach', 'S-2', 'F-1', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).changed, false);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('bl attach completes a story that names the feature but is not listed, writing only the list', () => {
  // The S-1013 case: in progress, `feature: F-1`, missing from `stories:`.
  const dir = backlog({ featureStatus: 'running', story: { feature: 'F-1', status: 'in_progress' } });
  const story = read(dir, STORY);
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).changed, true);
  assert.equal(read(dir, STORY), story, 'the story is not rewritten');
  assert.deepEqual(fm(dir, FEATURE).stories, ['S-1', 'S-2']);
});

test('bl attach completes a story listed with no feature:, writing only the story', () => {
  const dir = backlog({ story: { status: 'in_progress' }, stories: ['S-1', 'S-2'] });
  const feature = read(dir, FEATURE);
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.equal(read(dir, FEATURE), feature, 'the feature is not rewritten');
});

test('bl attach fills an empty feature: key in place and lists into a feature with no stories: key', () => {
  const dir = backlog({ stories: [] });
  writeFileSync(join(dir, STORY), read(dir, STORY).replace('type: feature\n', 'type: feature\nfeature:\n'));
  writeFileSync(join(dir, FEATURE), read(dir, FEATURE).replace(/^stories:.*\n/m, ''));
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(dir, STORY), /\ntype: feature\nfeature: F-1\npoints: 1\n/);
  assert.deepEqual(fm(dir, FEATURE).stories, ['S-2']);
});

test('bl attach lists the story by its canonical id, whatever its story_id: says', () => {
  const dir = backlog({ stories: ['S-1', 'S-2'] });
  writeFileSync(join(dir, STORY), read(dir, STORY).replace('story_id: S-2\n', 'story_id: S2\n'));
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).story, 'S-2');
  assert.deepEqual(fm(dir, FEATURE).stories, ['S-1', 'S-2'], 'not listed a second time');
});

test('bl attach refuses, writing nothing, for bad ids, missing units, closed features and stories it may not move', () => {
  const cases = [
    { args: ['S-2'], err: /takes one story id and one feature id/ },
    { args: ['S-2', 'F-1', 'F-3'], err: /takes one story id and one feature id/ },
    { args: ['S-2', 'S-1'], err: /takes one story id and one feature id/ },
    { args: ['S-2', 'nope'], err: /'nope' is not a story \(S-<n>\) or feature \(F-<n>\) id/ },
    { args: ['S-9', 'F-1'], err: /story S-9 not found/ },
    { args: ['S-2', 'F-9'], err: /feature F-9 not found/ },
    { opts: { featureStatus: 'done' }, err: /^Feature F-1 is done; stories can't be added\.$/m },
    { opts: { featureStatus: 'superseded' }, err: /^Feature F-1 is superseded; stories can't be added\.$/m },
    {
      opts: { story: { feature: 'F-3' }, features: [{ id: 'F-3', title: 'Three', stories: ['S-2'] }] },
      err: /^S-2 is already in F-3\.$/m,
    },
    // Listed in another feature too: the "another feature" refusal wins.
    { opts: { story: { feature: 'F-3' }, stories: ['S-1', 'S-2'] }, err: /^S-2 is already in F-3\.$/m },
    {
      opts: { story: { status: 'in_progress' } },
      err: /^S-2 is in_progress; only a backlog or refined story moves into a feature\.$/m,
    },
    {
      opts: { story: { status: 'done' } },
      err: /^S-2 is done; only a backlog or refined story moves into a feature\.$/m,
    },
    {
      opts: { featureStatus: 'running', story: { component: 'C02' } },
      err: /F-1 is running, and its branches do not span other-repo \(S-2's repo\); they span demo-repo\. Bring the repo in with bl side other-repo --from F-1\./,
    },
    {
      opts: { featureStatus: 'escalated', story: { component: 'C02' } },
      err: /F-1 is escalated, and its branches do not span other-repo/,
    },
  ];
  for (const { args = ['S-2', 'F-1'], opts = {}, err } of cases) {
    const dir = backlog(opts);
    const story = read(dir, STORY);
    const feature = read(dir, FEATURE);
    const r = bl(['attach', ...args], dir);
    const label = `${args.join(' ')} ${JSON.stringify(opts)}`;
    assert.equal(r.status, 1, `${label}: ${r.stderr}`);
    assert.match(r.stderr, err, label);
    assert.equal(r.stdout, '', label);
    assert.equal(read(dir, STORY), story, `${label}: story untouched`);
    assert.equal(read(dir, FEATURE), feature, `${label}: feature untouched`);
  }
});

test('bl attach takes a story in a new repo into a feature that has not started', () => {
  for (const featureStatus of ['draft', 'refined', 'approved']) {
    const dir = backlog({ featureStatus, story: { component: 'C02' } });
    const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
    assert.equal(r.status, 0, `${featureStatus}: ${r.stderr}`);
    assert.deepEqual(fm(dir, FEATURE).stories, ['S-1', 'S-2'], featureStatus);
  }
});

test('attach refuses unresolved story repos before every feature status without changing either file', () => {
  const shapes = [
    {
      label: 'absent component',
      edit: (t) => t.replace('component: C00\n', ''),
      err: /component \(none\) is not found under components\//,
    },
    {
      label: 'unknown component',
      edit: (t) => t.replace('component: C00', 'component: C99'),
      err: /component C99 is not found under components\//,
    },
    {
      label: 'component without a repo',
      edit: (t) => t.replace('component: C00', 'component: C03'),
      err: /component C03 names no repo/,
    },
  ];
  const noRepo = { id: 'C03', title: 'Bare', dirSuffix: 'bare' };
  // Fresh, both half-attached shapes, and already attached.
  const memberships = [
    {},
    { stories: ['S-1', 'S-2'] },
    { story: { feature: 'F-1' } },
    { story: { feature: 'F-1' }, stories: ['S-1', 'S-2'] },
  ];
  for (const featureStatus of ['draft', 'refined', 'approved', 'running', 'escalated']) {
    for (const { label, edit, err } of shapes) {
      for (const m of memberships) {
        const { dir } = mkTempBacklog({
          repos: REPOS,
          components: [...COMPONENTS, noRepo],
          stories: [
            { id: 'S-1', component: 'C00', title: 'One', feature: 'F-1', status: 'refined' },
            { id: 'S-2', component: 'C00', title: 'Two', status: 'refined', ...m.story },
          ],
          features: [{ id: 'F-1', title: 'Feat', status: featureStatus, stories: m.stories ?? ['S-1'] }],
        });
        writeFileSync(join(dir, STORY), edit(read(dir, STORY)));
        const story = read(dir, STORY);
        const feature = read(dir, FEATURE);
        const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
        const at = `${featureStatus} / ${label} / ${JSON.stringify(m)}`;
        assert.equal(r.status, 1, `${at}: ${r.stderr}`);
        assert.match(r.stderr, /Story S-2 has no repo: /, at);
        assert.match(r.stderr, err, at);
        assert.equal(read(dir, STORY), story, `${at}: story untouched`);
        assert.equal(read(dir, FEATURE), feature, `${at}: feature untouched`);
      }
    }
  }
});

test('attach_refuses_mismatched_feature_identity_without_writes', () => {
  // Fresh, both half-attached shapes, and already attached.
  const memberships = [
    {},
    { stories: ['S-1', 'S-2'] },
    { story: { feature: 'F-1' } },
    { story: { feature: 'F-1' }, stories: ['S-1', 'S-2'] },
  ];
  for (const m of memberships) {
    for (const featureId of ['F-9', 'F9', 'nope']) {
      const dir = backlog(m);
      writeFileSync(join(dir, FEATURE), read(dir, FEATURE).replace('feature_id: F-1', `feature_id: ${featureId}`));
      const story = read(dir, STORY);
      const feature = read(dir, FEATURE);
      const r = bl(['attach', 'S-2', 'F-1', '--no-sync', '--json'], dir);
      const at = `${featureId} ${JSON.stringify(m)}`;
      assert.equal(r.status, 1, `${at}: ${r.stderr}`);
      assert.match(
        r.stderr,
        new RegExp(`features/F1/index\\.md names feature_id: ${featureId}, not F-1; fix the file first\\.`),
        at,
      );
      assert.equal(r.stdout, '', at);
      assert.equal(read(dir, STORY), story, `${at}: story untouched`);
      assert.equal(read(dir, FEATURE), feature, `${at}: feature untouched`);
    }
  }
  // An accepted alternate form is the same feature, written canonically.
  const dir = backlog();
  writeFileSync(join(dir, FEATURE), read(dir, FEATURE).replace('feature_id: F-1', 'feature_id: F1'));
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).feature, 'F-1');
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.deepEqual(fm(dir, FEATURE).stories, ['S-1', 'S-2']);
});

test('bl attach restores the story when the feature write fails', () => {
  const dir = backlog({ git: true });
  const story = read(dir, STORY);
  const feature = read(dir, FEATURE);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['attach', 'S-2', 'F-1'], dir, { env: { BL_INTERNAL_TEST_FAIL_ON_LINK: 'list' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not list S-2 in F-1: injected write failure at list\. S-2 is restored\./);
  assert.equal(read(dir, STORY), story);
  assert.equal(read(dir, FEATURE), feature);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  // No repair record: the next command runs.
  const next = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
  assert.equal(next.status, 0, next.stderr);
});

test('attach_partial_write_preserves_both_documents', () => {
  // BL_INTERNAL_TEST_FAIL_ON_RENAME=<n> fails attach's n-th write after its
  // bytes are staged, where a direct write would have left the file cut
  // short. Each case: the failed write, the story's and feature's contents
  // afterwards ("before", or "attached" for the story's full new bytes).
  const cases = [
    {
      label: 'story write',
      env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '1' },
      err: /could not write S-2: .*Nothing was changed\./,
      story: 'before',
    },
    {
      label: 'feature write',
      env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '2' },
      err: /could not list S-2 in F-1: .*S-2 is restored\./,
      story: 'before',
    },
    {
      label: 'restore after a failed feature write',
      env: { BL_INTERNAL_TEST_FAIL_ON_LINK: 'list', BL_INTERNAL_TEST_FAIL_ON_RENAME: '2' },
      err: /S-2 could not be restored \(.*\); it names F-1, so remove that by hand\./,
      story: 'attached',
    },
    // Half-attached: only the missing half is written, so it is write 1.
    {
      label: 'story write, listed already',
      opts: { stories: ['S-1', 'S-2'] },
      env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '1' },
      err: /could not write S-2/,
      story: 'before',
    },
    {
      label: 'feature write, named already',
      opts: { story: { feature: 'F-1' } },
      env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '1' },
      err: /could not list S-2 in F-1: .*BL_INTERNAL_TEST_FAIL_ON_RENAME/,
      story: 'before',
    },
  ];
  for (const { label, opts = {}, env, err, story: storyAfter } of cases) {
    const dir = backlog(opts);
    const story = read(dir, STORY);
    const feature = read(dir, FEATURE);
    const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir, { env });
    assert.equal(r.status, 1, `${label}: ${r.stderr}`);
    assert.match(r.stderr, err, label);
    assert.equal(read(dir, FEATURE), feature, `${label}: feature untouched`);
    if (storyAfter === 'before') {
      assert.equal(read(dir, STORY), story, `${label}: story untouched`);
    } else {
      const was = parseFrontmatter(story);
      const now = parseFrontmatter(read(dir, STORY));
      assert.equal(now.body, was.body, `${label}: story body whole`);
      assert.deepEqual(now.fm, { ...was.fm, feature: 'F-1' }, `${label}: story frontmatter whole`);
    }
  }
});

test('bl attach --help lists the flags and the refusals', () => {
  const dir = backlog();
  const r = bl(['attach', '--help'], dir);
  assert.equal(r.status, 0, r.stderr);
  for (const s of [
    '--no-sync',
    '--json',
    'bl-attach-json/v1',
    'done or superseded',
    'another feature',
    'backlog or refined',
    'bl side <repo> --from F-<n>',
  ]) {
    assert.ok(r.stdout.includes(s), s);
  }
  const top = bl(['--help'], dir);
  assert.match(top.stdout, /^ {2}attach {5}List an existing story in a feature/m);
});
