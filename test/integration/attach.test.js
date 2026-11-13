/**
 * Integration tests for `bl attach` (S-1095): the story's `feature:`, the
 * only statement of membership (F-77 D3), written and committed by path (the
 * feature's Stories table is rendered when read, F-79 D2), `--no-sync`, `--json`, the ids in
 * either order, the no-op, every refusal leaving both files byte for byte,
 * and a failed write leaving the story whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { GIT_ENV, git, initGitBacklog } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { rendered } from '../helpers/rendered.js';
import { parseFrontmatter } from '../../src/config.js';
import { BLOCKERS_FILE, readBlockers } from '../../src/blockers.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';

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

/** The ids `bl status F-1` lists, its stories. */
const members = (dir) => [...bl(['status', 'F-1'], dir).stdout.matchAll(/^\d+\s+(S-\d+)\s/gm)].map((m) => m[1]).sort();

/**
 * F-1 (status `featureStatus`) holds S-1 (C00, demo-repo); S-2 is the story
 * to attach, with `story` overriding its fixture fields (`feature: ''` by
 * default: in no feature). `features` adds more features.
 */
function backlog({ featureStatus = 'refined', story = {}, features = [], git: inGit = false } = {}) {
  const { dir } = mkTempBacklog({
    repos: REPOS,
    components: COMPONENTS,
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', feature: 'F-1', status: 'refined' },
      { id: 'S-2', component: 'C00', title: 'Two', status: 'refined', feature: '', ...story },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: featureStatus }, ...features],
  });
  if (inGit) initGitBacklog(dir);
  return dir;
}

test('bl attach sets feature:, and commits the story dir and nothing else', () => {
  const dir = backlog({ git: true });
  const r = bl(['attach', 'S-2', 'F-1'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'stdout is empty without --json');
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.equal(Object.hasOwn(fm(dir, FEATURE), 'stories'), false, 'the feature stores no stories: (F-77 D3)');
  assert.match(rendered(dir, 'F-1'), /\| \[S-2\]\(\.\.\/\.\.\/stories\/S2\/index\.md\)/, 'its Stories table has S-2');
  assert.deepEqual(members(dir), ['S-1', 'S-2']);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: attach S-2 to F-1');
  assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [STORY]);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  // The story keeps its sections and is valid in the feature.
  const v = bl(['validate', '--json'], dir);
  const codes = JSON.parse(v.stdout).findings.map((f) => f.code);
  assert.ok(!codes.includes('derived-key') && !codes.includes('dangling-feature'), codes.join('\n'));
});

test('bl attach --no-sync writes the story under the lock and commits nothing', () => {
  const dir = backlog({ git: true });
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.deepEqual(
    git(dir, 'status', '--porcelain')
      .split('\n')
      .map((l) => l.trim())
      .sort(),
    [`M ${STORY}`],
  );
});

test('bl attach --json, the ids in reverse order and in any accepted form', () => {
  const dir = backlog();
  const r = bl(['attach', 'f1', 's-2', '--json', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { schema: 'bl-attach-json/v1', story: 'S-2', feature: 'F-1', changed: true });
  assert.equal(fm(dir, STORY).feature, 'F-1');
  assert.deepEqual(members(dir), ['S-1', 'S-2']);
});

test('bl attach on a story already in the feature writes and commits nothing', () => {
  for (const named of ['F-1', 'F1']) {
    const dir = backlog({ git: true, story: { feature: named, status: 'in_progress' } });
    const head = git(dir, 'rev-parse', 'HEAD');
    let r = bl(['attach', 'S-2', 'F-1'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /S-2 is already in F-1; nothing to do\./, named);
    r = bl(['attach', 'S-2', 'F-1', '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).changed, false, named);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head, named);
    assert.equal(git(dir, 'status', '--porcelain'), '', named);
  }
});

test('attach on a story already in the feature still turns its run edges into order edges', () => {
  // [case, S-2's feature: before, the commit's paths]. A story already in F-1
  // with a run edge to S-1 is what a failure between attach's two writes, or
  // bl new --feature's, leaves; a rerun of bl attach finishes it.
  const cases = [
    ['a story that joins F-1', '', ['.gitattributes', BLOCKERS_FILE, STORY]],
    ['a story already in F-1', 'F-1', ['.gitattributes', BLOCKERS_FILE]],
  ];
  for (const [name, feature, paths] of cases) {
    const dir = backlog({ story: { feature } });
    writeBlockersLocked(dir, [{ blocker: 'S-1', gate: 'run', unit: 'S-2', until: 'done' }]);
    initGitBacklog(dir);
    if (feature) {
      const v = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) => f.code === 'blockers-cycle');
      assert.deepEqual(
        v.map((f) => f.message),
        ['deadlock: F-1 → F-1 (S-2 at run by S-1); bl attach S-2 F-1 turns it into an order edge'],
        `${name}: bl validate names the fix`,
      );
    }
    const r = bl(['attach', 'S-2', 'F-1'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /S-2 at run by S-1 is now the order edge S-1 → S-2/, name);
    assert.doesNotMatch(r.stderr, /nothing to do/, name);
    assert.deepEqual(
      readBlockers(dir).edges,
      [{ blocker: 'S-1', gate: 'order', unit: 'S-2', until: 'implemented' }],
      name,
    );
    assert.deepEqual(git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), paths, name);
    assert.equal(git(dir, 'status', '--porcelain'), '', name);
    // A second rerun has nothing left to do.
    assert.match(bl(['attach', 'S-2', 'F-1'], dir).stderr, /S-2 is already in F-1; nothing to do\./, name);
  }
});

test('attach_already_in_feature_non_repo_reports_turned_edges', () => {
  // [case, a git backlog, extra args, what stderr says after the turn]. A
  // turned edge is a change whether or not there is a path to commit.
  const cases = [
    ['not a repo', false, [], /Backlog is not a git repository; skipping commit\./],
    ['not a repo, --no-sync', false, ['--no-sync'], /Skipped the commit\./],
    ['a repo, --no-sync', true, ['--no-sync'], /Skipped the commit\./],
  ];
  for (const [name, inGit, extra, said] of cases) {
    const dir = backlog({ story: { feature: 'F-1' } });
    writeBlockersLocked(dir, [{ blocker: 'S-1', gate: 'run', unit: 'S-2', until: 'done' }]);
    if (inGit) initGitBacklog(dir);
    const r = bl(['attach', 'S-2', 'F-1', ...extra], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /S-2 at run by S-1 is now the order edge S-1 → S-2/, name);
    assert.match(r.stderr, /^S-2 is already in F-1\.$/m, name);
    assert.doesNotMatch(r.stderr, /nothing to do/, name);
    assert.match(r.stderr, said, name);
    assert.deepEqual(
      readBlockers(dir).edges,
      [{ blocker: 'S-1', gate: 'order', unit: 'S-2', until: 'implemented' }],
      name,
    );
    // Nothing is left to turn, so the rerun says so.
    assert.match(bl(['attach', 'S-2', 'F-1', ...extra], dir).stderr, /S-2 is already in F-1; nothing to do\./, name);
  }
});

test('attach_keeps_or_refuses_a_run_edge_with_active_when: a story already in the feature', () => {
  // S-1 is refined, so the edge holds now: a deadlock bl attach cannot turn.
  const dir = backlog({ story: { feature: 'F-1' } });
  const edge = {
    blocker: 'S-1',
    gate: 'run',
    unit: 'S-2',
    until: 'done',
    active_when: { unit: 'S-1', status: 'refined' },
  };
  writeBlockersLocked(dir, [edge]);
  initGitBacklog(dir);
  const head = git(dir, 'rev-parse', 'HEAD');
  const v = JSON.parse(bl(['validate', '--json'], dir).stdout).findings.filter((f) => f.code === 'blockers-cycle');
  assert.deepEqual(
    v.map((f) => f.message),
    ['deadlock: F-1 → F-1 (S-2 at run by S-1)'],
    'no bl attach hint for an edge it refuses',
  );
  const r = bl(['attach', 'S-2', 'F-1'], dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /S-2 at run by S-1 holds only once S-1 is refined, and an order edge takes no active_when/);
  assert.deepEqual(readBlockers(dir).edges, [edge]);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('bl attach fills an empty feature: key in place', () => {
  const dir = backlog();
  writeFileSync(join(dir, STORY), read(dir, STORY).replace('type: feature\n', 'type: feature\nfeature:\n'));
  const feature = read(dir, FEATURE);
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(dir, STORY), /\ntype: feature\nfeature: F-1\npoints: 1\n/);
  assert.equal(read(dir, FEATURE), feature, 'the feature is not rewritten');
});

test('bl attach takes the story by its canonical id, whatever its story_id: says', () => {
  const dir = backlog();
  writeFileSync(join(dir, STORY), read(dir, STORY).replace('story_id: S-2\n', 'story_id: S2\n'));
  const r = bl(['attach', 'S-2', 'F-1', '--no-sync', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).story, 'S-2');
  assert.equal(fm(dir, STORY).feature, 'F-1');
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
      opts: { story: { feature: 'F-3' }, features: [{ id: 'F-3', title: 'Three' }] },
      err: /^S-2 is already in F-3\.$/m,
    },
    {
      opts: { story: { status: 'in_progress' } },
      err: /^S-2 is in_progress; only a draft or refined story moves into a feature\.$/m,
    },
    {
      opts: { story: { status: 'done' } },
      err: /^S-2 is done; only a draft or refined story moves into a feature\.$/m,
    },
    {
      opts: { featureStatus: 'in_progress', story: { component: 'C02' } },
      err: /F-1 is in_progress, and its branches do not span other-repo \(S-2's repo\); they span demo-repo\. Bring the repo in with bl side other-repo --from F-1\./,
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

// Review 2026-11-13, Must 2: a story is in a feature or in a batch (F-125
// D1), on both paths that move an existing story into a feature.
test('batch_story_cannot_join_feature_through_attach_or_new_from', () => {
  const paths = [
    ['bl attach', ['attach', 'S-2', 'F-1', '--no-sync']],
    ['bl new --feature', ['new', '--feature', '--title', 'Joined', 'S-2', '--theme', 'demo', '--no-sync']],
  ];
  const stories = [
    // [case, S-2's fields, the refusal (null: it joins)]
    ['a loose refined story', {}, null],
    ['a story in a batch', { batch: 'B-1' }, /^S-2 is already in B-1\.$/m],
    ['a story in a batch that names the feature too', { batch: 'B-1', feature: 'F-1' }, /^S-2 is already in B-1\.$/m],
    ['a story in another feature', { feature: 'F-3' }, /^S-2 is already in F-3\.$/m],
    ['a started story', { status: 'in_progress' }, /^S-2 is in_progress; only a draft or refined story moves/m],
  ];
  for (const [path, args] of paths) {
    for (const [name, story, refusal] of stories) {
      const label = `${path}: ${name}`;
      // A slugged directory: bl new --feature's repair record names stories/S<n>-<slug>.
      const dir = backlog({ story: { dirSuffix: 'two', ...story }, features: [{ id: 'F-3', title: 'Three' }] });
      const file = 'stories/S2-two/index.md';
      const before = read(dir, file);
      const r = bl(args, dir);
      if (refusal == null) {
        assert.equal(r.status, 0, `${label}: ${r.stderr}`);
        assert.match(String(fm(dir, file).feature), /^F-\d+$/, label);
        continue;
      }
      assert.equal(r.status, 1, `${label}: ${r.stderr}`);
      assert.match(r.stderr, refusal, label);
      assert.equal(read(dir, file), before, `${label}: story untouched`);
    }
  }
});

test('bl attach takes a story in a new repo into a feature that has not started', () => {
  for (const featureStatus of ['draft', 'refined', 'approved']) {
    const dir = backlog({ featureStatus, story: { component: 'C02' } });
    const r = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
    assert.equal(r.status, 0, `${featureStatus}: ${r.stderr}`);
    assert.equal(fm(dir, STORY).feature, 'F-1', featureStatus);
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
  // In no feature, and already in F-1.
  const memberships = [{}, { story: { feature: 'F-1' } }];
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
          features: [{ id: 'F-1', title: 'Feat', status: featureStatus }],
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
  // In no feature, and already naming F-1.
  const memberships = [{}, { story: { feature: 'F-1' } }];
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
});

test('attach_partial_write_preserves_the_story', () => {
  // BL_INTERNAL_TEST_FAIL_ON_RENAME=1 fails attach's one write, the story's,
  // after its bytes are staged, where a direct write would have left the file
  // cut short.
  const dir = backlog({ git: true });
  const story = read(dir, STORY);
  const feature = read(dir, FEATURE);
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = bl(['attach', 'S-2', 'F-1'], dir, { env: { BL_INTERNAL_TEST_FAIL_ON_RENAME: '1' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not write S-2: .*Nothing was changed\./);
  assert.equal(read(dir, STORY), story, 'story untouched');
  assert.equal(read(dir, FEATURE), feature, 'feature untouched');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  // No repair record: the next command runs.
  const next = bl(['attach', 'S-2', 'F-1', '--no-sync'], dir);
  assert.equal(next.status, 0, next.stderr);
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
    'draft or refined',
    'bl side <repo> --from F-<n>',
  ]) {
    assert.ok(r.stdout.includes(s), s);
  }
  const top = bl(['--help'], dir);
  assert.match(top.stdout, /^ {2}attach {5}Put an existing story in a feature/m);
});
