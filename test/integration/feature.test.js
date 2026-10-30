import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, initGitBacklog } from '../helpers/git-backlog.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { parseChange } from '../../src/change-doc.js';
import { extractSection } from '../../src/feature.js';

const REPOS = ['../demo-repo'];
/** demo-repo's home component, so `bl validate` has no home-component finding (F-49 D4). */
const HOME = { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true };

function newStory(dir, { component = 'C00', title, points = '3', extra = [] }) {
  const r = runBl(['new', component, '--title', title, '--points', points, ...extra], { cwd: dir });
  if (r.status !== 0) throw new Error('seed failed:\n' + r.stderr);
  return r.stdout.trim();
}

function newFeature(dir, title = 'Invite codes') {
  const r = runBl(['new', '--feature', '--theme', 'demo', '--title', title], {
    cwd: dir,
  });
  if (r.status !== 0) throw new Error('feature new failed:\n' + r.stderr);
  return r.stdout.trim();
}

function fm(path) {
  return parseFrontmatter(readFileSync(path, 'utf8')).fm;
}

/**
 * Assert every `](…)` target in the `## <heading>` section of an index file
 * exists on disk, resolved against the index's own directory. Returns the
 * targets so a caller can check the section was not empty.
 */
function assertLinksResolve(indexPath, heading) {
  const content = readFileSync(indexPath, 'utf8');
  const section = content.match(new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\s*$)`));
  assert.ok(section, `missing ## ${heading} in ${indexPath}`);
  const targets = [...section[1].matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  for (const target of targets) {
    const abs = resolve(dirname(indexPath), target);
    assert.ok(existsSync(abs), `${indexPath}: ${target} does not resolve (${abs})`);
  }
  return targets;
}

test('bl new --feature scaffolds features/F1-<slug>/index.md and the root Features table', () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS, components: [HOME] });
  try {
    const rel = newFeature(dir);
    assert.equal(rel, 'features/F1-invite-codes/index.md');
    const f = fm(join(dir, rel));
    assert.equal(f.feature_id, 'F-1');
    assert.equal(f.status, 'draft');
    assert.equal(f.primary_repo, undefined, 'a feature names no repo (F-52 D3)');
    assert.equal(f.review_rounds_max, '2');
    const content = readFileSync(join(dir, rel), 'utf8');
    for (const h of ['## Premise', '## Design', '## Acceptance', '## Stories', '## Deferred', '## Escalation']) {
      assert.match(content, new RegExp(`^${h}$`, 'm'), `missing ${h}`);
    }
    // The run state and the Review Log belong to the change document, which a
    // unit gets only when its branch is created.
    assert.doesNotMatch(content, /^## Review Log$/m);
    for (const k of ['branch', 'pr', 'review_round', 'review_status']) assert.equal(f[k], undefined, k);
    assert.ok(!existsSync(join(dir, 'features', 'F1-invite-codes', 'change.md')));
    const root = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.match(root, /## Features\n/);
    assert.match(root, /\[F-1\]\(features\/F1-invite-codes\/index\.md\)/);
    // Features sits before Backlog.
    assert.ok(root.indexOf('## Features') < root.indexOf('## Backlog'));
    // A second feature gets F-2.
    const rel2 = newFeature(dir, 'Second');
    assert.equal(rel2, 'features/F2-second/index.md');
    // A freshly scaffolded feature (points: 0, no stories) validates clean.
    const v = runBl(['validate', '--json'], { cwd: dir });
    const errors = JSON.parse(v.stdout).findings.filter((f) => f.severity === 'error');
    assert.deepEqual(errors, [], JSON.stringify(errors));
  } finally {
    cleanup();
  }
});

test("bl new --feature requires --title and refuses --repo: a feature's repos are its stories'", () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS });
  try {
    let r = runBl(['new', '--feature', '--theme', 'demo'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--title/);
    for (const repo of ['demo-repo', 'nope']) {
      r = runBl(['new', '--feature', '--theme', 'demo', '--title', 'X', '--repo', repo], { cwd: dir });
      assert.equal(r.status, 1, repo);
      assert.match(r.stderr, /unknown option "--repo": a feature's repos come from its stories' components/, repo);
      assert.ok(!existsSync(join(dir, 'features')), `nothing written (${repo})`);
    }
  } finally {
    cleanup();
  }
});

test('bl new --feature tags the story, links it on the feature, and keeps the order', () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS, components: [HOME] });
  try {
    newFeature(dir);
    const storyRel = newStory(dir, { title: 'Mint codes', extra: ['--feature', 'F-1'] });
    assert.equal(storyRel, 'stories/S1-mint-codes/index.md');
    const s = fm(join(dir, storyRel));
    assert.equal(s.feature, 'F-1');
    assert.equal(s.component, 'C00');
    assert.equal(s.primary_repo, undefined, "a story's repo is its component's (F-52 D1)");
    // Shorter template: no Review Log / To Do on feature stories.
    const storyContent = readFileSync(join(dir, storyRel), 'utf8');
    assert.doesNotMatch(storyContent, /## Review Log/);
    assert.doesNotMatch(storyContent, /## To Do/);
    assert.match(storyContent, /## Implementation Plan/);

    const featurePath = join(dir, 'features', 'F1-invite-codes', 'index.md');
    assert.deepEqual(fm(featurePath).stories, ['S-1']);

    // A second story appends, keeping order; F-<n> C-<n> is the same as --feature.
    const r = runBl(['new', 'F-1', 'C00', '--title', 'Redeem', '--points', '2'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fm(featurePath).stories, ['S-1', 'S-2']);

    // --json carries the feature id.
    const j = runBl(['new', '--json', 'C00', '--title', 'Third', '--points', '2', '--feature', 'F-1'], { cwd: dir });
    assert.equal(j.status, 0, j.stderr);
    assert.equal(JSON.parse(j.stdout).feature, 'F-1');
    assert.deepEqual(fm(featurePath).stories, ['S-1', 'S-2', 'S-3']);

    // A done feature stays in features/, and the top-level index lists
    // active features only; whatever it links must resolve.
    writeFileSync(featurePath, readFileSync(featurePath, 'utf8').replace('status: draft', 'status: done'));
    const sync = runBl(['sync'], { cwd: dir });
    assert.equal(sync.status, 0, sync.stderr);
    assert.ok(existsSync(featurePath));
    const rootPath = join(dir, 'index.md');
    assert.doesNotMatch(readFileSync(rootPath, 'utf8'), /\[F-1\]/, 'top-level Features lists active features only');
    assert.deepEqual(assertLinksResolve(rootPath, 'Features'), []);
  } finally {
    cleanup();
  }
});

test('the ad-hoc story command in prompts/_blocked-by-bug.md files a bug on the feature without syncing', () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS, components: [HOME] });
  try {
    newFeature(dir);
    newStory(dir, { title: 'Mint codes', extra: ['--feature', 'F-1'] });
    const rootIndex = join(dir, 'index.md');
    const before = readFileSync(rootIndex, 'utf8');
    mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
    const body = join(dir, '.bl', 'run', 'F-1.adhoc-goto-timeout.md');
    writeFileSync(
      body,
      '## Summary\n\npage.goto timed out under 4 workers.\n\n## Acceptance Criteria\n\n- [x] The load waits for the app shell.\n\n## Dependencies\n\nNone.\n',
    );
    // The command exactly as the prompt spells it, `{{adhocComponent}}` being
    // the component of the feature's first story.
    const r = runBl(
      [
        'new',
        'F-1',
        'C00',
        '--type',
        'bug',
        '--points',
        '1',
        '--no-sync',
        '--title',
        'goto timeout under load',
        '--body-file',
        body,
      ],
      { cwd: dir },
    );
    assert.equal(r.status, 0, r.stderr);
    const storyPath = join(dir, 'stories', 'S2-goto-timeout-under-load', 'index.md');
    const s = fm(storyPath);
    assert.equal(s.type, 'bug');
    assert.equal(s.feature, 'F-1');
    assert.equal(s.component, 'C00');
    assert.match(readFileSync(storyPath, 'utf8'), /- \[x\] The load waits for the app shell\./);
    assert.deepEqual(fm(join(dir, 'features', 'F1-invite-codes', 'index.md')).stories, ['S-1', 'S-2']);
    assert.equal(readFileSync(rootIndex, 'utf8'), before, '--no-sync leaves the index files alone');
  } finally {
    cleanup();
  }
});

/** A line of prompts/_blocked-by-bug.md, as the prompt spells it (S-1095). */
function blockedByBugLine(re) {
  const prompt = readFileSync(new URL('../../prompts/_blocked-by-bug.md', import.meta.url), 'utf8');
  const m = prompt.match(re);
  assert.ok(m, `prompts/_blocked-by-bug.md has ${re}`);
  return m[0];
}

test('the existing-story command in prompts/_blocked-by-bug.md attaches the story to the feature without syncing', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    stories: [
      {
        id: 'S-7',
        component: 'C00',
        title: 'goto timeout',
        type: 'bug',
        body: '## Summary\n\nTimeout.\n\n## To Do\n\nNone.\n',
      },
    ],
  });
  try {
    newFeature(dir);
    newStory(dir, { title: 'Mint codes', extra: ['--feature', 'F-1'] });
    const rootIndex = join(dir, 'index.md');
    const before = readFileSync(rootIndex, 'utf8');
    const line = blockedByBugLine(/^ *bl attach S-<id> \{\{featureId\}\} --no-sync$/m).trim();
    const args = line.replace('S-<id>', 'S-7').replace('{{featureId}}', 'F-1').split(' ').slice(1);
    const r = runBl(args, { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fm(join(dir, 'stories', 'S7', 'index.md')).feature, 'F-1');
    assert.deepEqual(fm(join(dir, 'features', 'F1-invite-codes', 'index.md')).stories, ['S-8', 'S-7']);
    assert.equal(readFileSync(rootIndex, 'utf8'), before, '--no-sync leaves the index files alone');
  } finally {
    cleanup();
  }
});

test('the refused-attach fallback in prompts/_blocked-by-bug.md files an operator task and no story', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    stories: [{ id: 'S-7', component: 'C00', title: 'goto timeout', type: 'bug', status: 'in_progress' }],
  });
  try {
    newFeature(dir);
    newStory(dir, { title: 'Mint codes', extra: ['--feature', 'F-1'] });
    initGitBacklog(dir);
    const storiesBefore = readdirSync(join(dir, 'stories')).sort();
    const attach = runBl(['attach', 'S-7', 'F-1', '--no-sync'], { cwd: dir, env: GIT_ENV });
    assert.equal(attach.status, 1);
    assert.match(attach.stderr, /S-7 is in_progress/);
    mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
    const body = join(dir, '.bl', 'run', 'F-1.adhoc-goto-timeout.md');
    writeFileSync(
      body,
      `## Summary\n\nS-7 already tracks it; bl attach refused: ${attach.stderr.trim()}\n\n## Acceptance Criteria\n\n- [x] The load waits.\n\n## Dependencies\n\nNone.\n`,
    );
    // The fallback exactly as the prompt spells it (its first occurrence).
    const line = blockedByBugLine(/`bl task \{\{featureId\}\} [^`]*`/).slice(1, -1);
    const args = line
      .replaceAll('{{featureId}}', 'F-1')
      .replace('{{backlogDir}}/.bl/run/F-1.adhoc-<slug>.md', body)
      .replace('<short sha>', 'abc1234')
      .replace('<the bug>', 'goto timeout under load')
      .match(/"[^"]*"|\S+/g)
      .map((a) => a.replace(/^"|"$/g, ''))
      .slice(1);
    assert.deepEqual(args.slice(0, 2), ['task', 'F-1']);
    const r = runBl(args, { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'T-1\n');
    const tasks = readdirSync(join(dir, 'tasks'));
    assert.equal(tasks.length, 1);
    const task = readFileSync(join(dir, 'tasks', tasks[0]), 'utf8');
    assert.match(task, /title: "?Ad-hoc fix \(done, abc1234\): goto timeout under load"?/);
    assert.match(task, /S-7 already tracks it/);
    assert.deepEqual(readdirSync(join(dir, 'stories')).sort(), storiesBefore, 'no story is created');
    assert.equal(fm(join(dir, 'stories', 'S7', 'index.md')).feature, undefined);
  } finally {
    cleanup();
  }
});

test('bl new --feature refuses unknown or closed features', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    features: [{ id: 'F-1', title: 'Gone', dirSuffix: 'gone', status: 'done' }],
  });
  try {
    let r = runBl(['new', 'C00', '--title', 'T', '--points', '1', '--feature', 'F-9'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /F-9 not found/);
    r = runBl(['new', 'C00', '--title', 'T', '--points', '1', '--feature', 'F-1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is done/);
  } finally {
    cleanup();
  }
});

/** C00 (demo-repo's home) and C01, a second demo-repo component, plus other-repo's home C02. */
const SPLIT = {
  repos: ['../demo-repo', '../other-repo'],
  components: [
    HOME,
    { id: 'C01', title: 'Storage', dirSuffix: 'storage', repo: 'demo-repo' },
    { id: 'C02', title: 'Other', dirSuffix: 'other', repo: 'other-repo', home: true },
  ],
};

test('bl new --from with feature + per-story component cuts stories across components and repos', () => {
  const { dir, cleanup } = mkTempBacklog(SPLIT);
  try {
    newFeature(dir);
    newStory(dir, { title: 'seed a' }); // S-1
    newStory(dir, { component: 'C01', title: 'seed b' }); // S-2
    mkdirSync(join(dir, 'plan'), { recursive: true });
    writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA body.\n');
    writeFileSync(join(dir, 'plan', 'b.md'), '## Summary\n\nB body.\n');
    writeFileSync(join(dir, 'plan', 'c.md'), '## Summary\n\nC body.\n');
    writeFileSync(
      join(dir, 'plan', 'spec.json'),
      JSON.stringify({
        feature: 'F-1',
        component: 'C00',
        stories: [
          { id: 'store', title: 'Store primitive', points: 3, component: 'C01', body_file: 'b.md' },
          { id: 'mint', title: 'Mint codes', points: 5, body_file: 'a.md', depends_on: ['@store'] },
          { id: 'wire', title: 'Wire other', points: 2, component: 'C02', body_file: 'c.md' },
        ],
      }),
    );
    const r = runBl(['new', '--from', 'plan/spec.json'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const paths = r.stdout.trim().split('\n');
    assert.deepEqual(paths, [
      'stories/S3-store-primitive/index.md',
      'stories/S4-mint-codes/index.md',
      'stories/S5-wire-other/index.md',
    ]);
    const [store, mint, wire] = paths.map((p) => fm(join(dir, p)));
    for (const s of [store, mint, wire]) assert.equal(s.feature, 'F-1');
    assert.deepEqual(mint.depends_on, ['S-3']);
    // Each story's repo is its component's; none is written on the story (F-52 D1).
    assert.deepEqual([store.component, store.primary_repo], ['C01', undefined]);
    assert.deepEqual([mint.component, mint.primary_repo], ['C00', undefined]);
    assert.deepEqual([wire.component, wire.primary_repo], ['C02', undefined]);
    assert.match(r.stderr, /\[C01\]/, 'the plan marks a per-story component');
    assert.deepEqual(fm(join(dir, 'features', 'F1-invite-codes', 'index.md')).stories, ['S-3', 'S-4', 'S-5']);
  } finally {
    cleanup();
  }
});

test('bl new --from creates a new component and files the stories in it', () => {
  const { dir, cleanup } = mkTempBacklog(SPLIT);
  try {
    mkdirSync(join(dir, 'plan'), { recursive: true });
    writeFileSync(join(dir, 'plan', 'component.md'), '## Boundary\n\n`src/{{componentId}}/` in {{repo}}.\n');
    writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA body.\n');
    writeFileSync(
      join(dir, 'plan', 'spec.json'),
      JSON.stringify({
        component: { repo: 'other-repo', title: 'Ledger', paths: ['src/**'], body_file: 'component.md' },
        stories: [{ id: 'a', title: 'Ledger rows', points: 2, body_file: 'a.md' }],
      }),
    );
    const r = runBl(['new', '--from', 'plan/spec.json', '--json'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.schema, 'bl-new-batch-json/v2');
    assert.deepEqual(out.component, { id: 'C03', path: 'components/C03-ledger/index.md', created: true });
    assert.equal(out.stories[0].component, 'C03');
    const text = readFileSync(join(dir, 'components', 'C03-ledger', 'index.md'), 'utf8');
    assert.deepEqual(parseFrontmatter(text).fm, {
      component_id: 'C03',
      title: 'Ledger',
      repo: 'other-repo',
      paths: ['src/**'],
    });
    assert.match(text, /`src\/C03\/` in other-repo\./);
    const s = fm(join(dir, out.stories[0].path));
    assert.deepEqual([s.component, s.primary_repo], ['C03', undefined]);
  } finally {
    cleanup();
  }
});

test('bl new --from rejects an epic block, an unknown component and an unknown feature (exit 2)', () => {
  const { dir, cleanup } = mkTempBacklog(SPLIT);
  try {
    writeFileSync(join(dir, 's.md'), 'body\n');
    writeFileSync(
      join(dir, 'bad.json'),
      JSON.stringify({
        feature: 'F-4',
        component: 'C00',
        stories: [
          { id: 'x', title: 'X', points: 2, component: 'C07', body_file: 's.md' },
          { id: 'y', title: 'Y', points: 2, component: 'E01', body_file: 's.md' },
        ],
      }),
    );
    let r = runBl(['new', '--from', 'bad.json'], { cwd: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /feature: feature 'F-4' not found/);
    assert.match(r.stderr, /stories\[0\]\.component: component 'C07' not found under components\//);
    assert.match(r.stderr, /stories\[1\]\.component: E01 is not a component id: components are C-ids \(C01\)\./);

    writeFileSync(
      join(dir, 'old.json'),
      JSON.stringify({ epic: { id: 'E00' }, stories: [{ id: 'x', title: 'X', points: 2, body_file: 's.md' }] }),
    );
    r = runBl(['new', '--from', 'old.json'], { cwd: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /epic: the epic block is gone: name the stories' component with a top-level 'component'/);
    assert.match(r.stderr, /component: required/);

    writeFileSync(
      join(dir, 'repo.json'),
      JSON.stringify({
        component: { repo: 'nope', title: 'T', body_file: 's.md' },
        stories: [{ id: 'x', title: 'X', points: 2, body_file: 's.md' }],
      }),
    );
    r = runBl(['new', '--from', 'repo.json'], { cwd: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /component\.repo: unknown repo 'nope' \(registered: demo-repo, other-repo\)/);
    assert.doesNotMatch(r.stderr, /component\.paths/, 'paths is optional (F-61 D2)');

    writeFileSync(
      join(dir, 'paths.json'),
      JSON.stringify({
        component: { repo: 'other-repo', title: 'T', paths: ['src/**', '/abs/**', '../up', 3], body_file: 's.md' },
        stories: [{ id: 'x', title: 'X', points: 2, body_file: 's.md' }],
      }),
    );
    r = runBl(['new', '--from', 'paths.json'], { cwd: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /component\.paths\[1\]: is absolute/);
    assert.match(r.stderr, /component\.paths\[2\]: contains "\.\."/);
    assert.match(r.stderr, /component\.paths\[3\]: must be a string/);
    assert.doesNotMatch(r.stderr, /component\.paths\[0\]/);
    assert.ok(!existsSync(join(dir, 'stories')), 'nothing written');
  } finally {
    cleanup();
  }
});

test('bl approve gates on refined status and a non-empty, consistent story list', () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS, components: [HOME] });
  try {
    const rel = newFeature(dir);
    const featurePath = join(dir, rel);
    // draft → refuse
    let r = runBl(['approve', 'F-1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /still a draft/);
    // refined but no stories → refuse
    writeFileSync(featurePath, readFileSync(featurePath, 'utf8').replace('status: draft', 'status: refined'));
    r = runBl(['approve', 'F-1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lists no stories/);
    // with a story → approved + approved date, root table updated
    newStory(dir, { title: 'Mint', points: '3', extra: ['--feature', 'F-1'] });
    r = runBl(['approve', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const f = fm(featurePath);
    assert.equal(f.status, 'approved');
    assert.match(f.approved, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.stderr, /3 points/);
    assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /F-1.*approved/);
    // approving again is a no-op
    r = runBl(['approve', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /already approved/);
  } finally {
    cleanup();
  }
});

test('bl approve warns about open dependencies outside the feature', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Outside', dirSuffix: 'outside' },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Inside',
        dirSuffix: 'inside',
        points: 8,
        feature: 'F-1',
        depends_on: 'S-1',
      },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: ['S-2'] }],
  });
  try {
    const r = runBl(['approve', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /S-2 depends on S-1 \(backlog\)/);
    // workon refuses on the same blocker (before touching git).
    const w = runBl(['implement', 'F-1'], { cwd: dir });
    assert.equal(w.status, 1);
    assert.match(w.stderr, /blocked on work outside the feature/);
  } finally {
    cleanup();
  }
});

test('bl implement refuses unapproved features with a hint', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', primary_repo: 'demo-repo' }],
  });
  try {
    const r = runBl(['implement', 'F-1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl approve F-1/);
    const rv = runBl(['review', 'F-1'], { cwd: dir });
    assert.equal(rv.status, 1);
    assert.match(rv.stderr, /no branch yet/);
  } finally {
    cleanup();
  }
});

test('bl status prints stories in dependency order plus review and blocker state', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', depends_on: 'S-2' },
      { id: 'S-2', component: 'C00', title: 'Second', dirSuffix: 'second', points: 5, feature: 'F-1' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1', 'S-2'],
        branch: 'f1-feat',
        review_status: 'pending',
        reviewLog:
          '### Session 2026-09-20 (PR #7)\n\n**Must fix**\n\n- [ ] invariant X — Repro: y. Test: z.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
        escalation: 'Design problem: premise false.',
      },
    ],
  });
  try {
    const r = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /status: running/);
    assert.match(r.stdout, /branch: f1-feat/);
    assert.match(r.stdout, /review: pending \(round 0\/2\), latest session 2026-09-20 with 1 unchecked/);
    // S-2 first (S-1 depends on it)
    const s2 = r.stdout.indexOf('S-2');
    const s1 = r.stdout.indexOf('S-1');
    assert.ok(s2 < s1, 'S-2 should be listed before S-1');
    assert.match(r.stdout, /escalation:\nDesign problem/);
  } finally {
    cleanup();
  }
});

test('bl merge refuses on pending review and on an open escalation', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    // The gates run once the feature's repos are known (F-36 D1).
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', feature: 'F-2' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Pending',
        dirSuffix: 'pending',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-pending',
        review_status: 'pending',
        reviewLog:
          '### Session 2026-09-20 (PR #7)\n\n**Must fix**\n\n- [ ] open item\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
      {
        id: 'F-2',
        title: 'Escalated',
        dirSuffix: 'escalated',
        status: 'escalated',
        stories: ['S-2'],
        branch: 'f2-escalated',
        review_status: 'addressed',
        escalation: 'Premise does not hold: see S-605.',
      },
      { id: 'F-3', title: 'Unstarted', dirSuffix: 'unstarted', status: 'approved', primary_repo: 'demo-repo' },
    ],
  });
  try {
    let r = runBl(['merge', 'F-1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unresolved review state/);
    assert.match(r.stderr, /1 unchecked/);
    r = runBl(['merge', 'F-2'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /open Escalation section/);
    r = runBl(['merge', 'F-3'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /nothing has been implemented/);
  } finally {
    cleanup();
  }
});

test('bl validate reports feature link drift and verification-only titles', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Dangling', dirSuffix: 'dangling', feature: 'F-9' },
      { id: 'S-2', component: 'C00', title: 'Mismatch', dirSuffix: 'mismatch', feature: 'F-2' },
      { id: 'S-3', component: 'C00', title: 'Unlisted', dirSuffix: 'unlisted', feature: 'F-1' },
      { id: 'S-4', component: 'C00', title: 'Verify the login flow still works', dirSuffix: 'verify' },
      {
        id: 'S-5',
        component: 'C00',
        title: 'Confirm CI is green',
        dirSuffix: 'confirm',
        status: 'done',
        completed: '2026-01-01',
      },
    ],
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-2', 'S-42'], branch: 'f1-feat' },
      { id: 'F-2', title: 'Other', dirSuffix: 'other', status: 'approved', primary_repo: 'demo-repo' },
    ],
  });
  try {
    const r = runBl(['validate', '--json'], { cwd: dir });
    const { findings } = JSON.parse(r.stdout);
    const codes = findings.map((f) => `${f.code}:${f.location}`);
    assert.ok(codes.includes('dangling-feature:stories/S1-dangling/index.md'), codes.join('\n'));
    assert.ok(codes.includes('feature-story-mismatch:stories/S2-mismatch/index.md'), codes.join('\n'));
    assert.ok(codes.includes('feature-story-unlisted:features/F1-feat/index.md'), codes.join('\n'));
    const unlisted = findings.filter((f) => f.code === 'feature-story-unlisted').map((f) => f.message);
    assert.ok(
      unlisted.includes('story S-3 names F-1 but F-1 does not list it in stories: (bl attach S-3 F-1 lists it)'),
      unlisted.join('\n'),
    );
    assert.ok(codes.includes('feature-story-missing:features/F1-feat/index.md'), codes.join('\n'));
    assert.ok(codes.includes('feature-no-stories:features/F2-other/index.md'), codes.join('\n'));
    assert.ok(codes.includes('verification-only-title:stories/S4-verify/index.md'), codes.join('\n'));
    // Done stories are not relitigated.
    assert.ok(!codes.some((c) => c.startsWith('verification-only-title:') && c.includes('S5-confirm')));
    assert.equal(r.status, 1, 'link errors must fail validate');
    // --skip suppresses the title warning; feature errors stay.
    const s = runBl(['validate', '--json', '--skip', 'verification-only-title'], { cwd: dir });
    const skipped = JSON.parse(s.stdout).findings.map((f) => f.code);
    assert.ok(!skipped.includes('verification-only-title'));
    assert.ok(skipped.includes('dangling-feature'));
    // human mode mentions features in the scan line
    const h = runBl(['validate'], { cwd: dir });
    assert.match(h.stderr, /scanning 5 stories across 1 component… \(2 features\)/);
  } finally {
    cleanup();
  }
});

test('bl validate flags bad feature frontmatter (status, id/dir)', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'cooking', primary_repo: 'demo-repo' }],
  });
  try {
    const featurePath = join(dir, 'features', 'F1-feat', 'index.md');
    writeFileSync(featurePath, readFileSync(featurePath, 'utf8').replace('feature_id: F-1', 'feature_id: F-7'));
    const r = runBl(['validate', '--json'], { cwd: dir });
    const codes = JSON.parse(r.stdout)
      .findings.filter((f) => f.location === 'features/F1-feat/index.md')
      .map((f) => f.code);
    assert.ok(codes.includes('bad-status'), codes.join(','));
    assert.ok(codes.includes('id-dir-mismatch'), codes.join(','));
  } finally {
    cleanup();
  }
});

test('bl sync leaves a done feature where it is, keeps it out of the root table, and is idempotent', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'A',
        dirSuffix: 'a',
        points: 3,
        feature: 'F-1',
        status: 'done',
        completed: '2026-01-01',
      },
      { id: 'S-2', component: 'C00', title: 'B', dirSuffix: 'b', points: 2, feature: 'F-2' },
    ],
    features: [
      { id: 'F-1', title: 'Done one', dirSuffix: 'done-one', status: 'done', stories: ['S-1'] },
      { id: 'F-2', title: 'Live one', dirSuffix: 'live-one', status: 'approved', stories: ['S-2'] },
    ],
  });
  try {
    let r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // Status is frontmatter, never location (F-49 D3).
    assert.ok(existsSync(join(dir, 'features', 'F1-done-one', 'index.md')));
    assert.ok(!existsSync(join(dir, 'features', '.completed')));
    assert.match(r.stderr, /^(?!.*migrate)/s);
    const root = readFileSync(join(dir, 'index.md'), 'utf8');
    assert.match(root, /\[F-2\]\(features\/F2-live-one\/index\.md\)/);
    assert.doesNotMatch(root, /F-1/);
    const before = readFileSync(join(dir, 'features', 'F2-live-one', 'index.md'), 'utf8');
    r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'features', 'F2-live-one', 'index.md'), 'utf8'), before);
    assert.equal(readFileSync(join(dir, 'index.md'), 'utf8'), root);
  } finally {
    cleanup();
  }
});

test('bl list shows a Feature column only when a listed story belongs to one; bl which/feature list resolve F ids', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'Plain', dirSuffix: 'plain' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: [] }],
  });
  try {
    let r = runBl(['list'], { cwd: dir });
    assert.doesNotMatch(r.stdout, /Feature/);
    const storyPath = join(dir, 'stories', 'S1-plain', 'index.md');
    writeFileSync(
      storyPath,
      readFileSync(storyPath, 'utf8').replace('status: backlog\n', 'status: backlog\nfeature: F-1\n'),
    );
    r = runBl(['list'], { cwd: dir });
    assert.match(r.stdout, /Feature/);
    assert.match(r.stdout, /F-1/);
    const w = runBl(['which', 'f1'], { cwd: dir });
    assert.equal(w.stdout.trim(), join(dir, 'features', 'F1-feat', 'index.md'));
    const l = runBl(['list', '--features'], { cwd: dir });
    assert.equal(l.status, 0, l.stderr);
    assert.match(l.stdout, /F-1\s+refined/);
    const h = runBl(['approve', '--help'], { cwd: dir });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /Usage: bl approve <id\.\.\.>/);
  } finally {
    cleanup();
  }
});

test('bl run --plan prints the steps; run refuses unapproved features and unknown agents cleanly', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1' },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Second',
        dirSuffix: 'second',
        points: 5,
        feature: 'F-1',
        depends_on: 'S-1',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'approved',
        stories: ['S-2', 'S-1'],
        review_rounds_max: 3,
      },
      { id: 'F-2', title: 'Draft', dirSuffix: 'draft', status: 'refined', stories: ['S-1'] },
    ],
  });
  try {
    let r = runBl(['run', '--plan', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1\. setup/);
    assert.match(r.stdout, /2\. implement S-1\n 3\. implement S-2/, 'dependency order, not listed order');
    assert.match(r.stdout, /re-review \(round 3\)/);
    r = runBl(['run', 'F-1', '--plan', '--max-rounds', '1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /re-review/);
    r = runBl(['run', 'F-2'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl approve F-2/);
    r = runBl(['run', 'F-1', '-A', 'gemini'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /No configuration in backlog\.json "agent" has a headless mode \(gemini\); use --interactive\./,
    );
    // -A sets the implementing list only; the fixture reviews on codex, so
    // every reviewer would review its own work (F-64 D4).
    r = runBl(['run', 'F-1', '-A', 'codex'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /Every backlog\.json "review_agent" configuration \(codex\) is also an "agent" configuration, and the reviewer is never the implementer/,
    );
  } finally {
    cleanup();
  }
});

test("bl status reports the last run's state from .bl/run", () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'escalated', branch: 'f1-feat' }],
  });
  try {
    mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
    writeFileSync(
      join(dir, '.bl', 'run', 'F-1.json'),
      JSON.stringify({
        feature: 'F-1',
        status: 'escalated',
        step: 'test',
        lastError: 'test gate failed twice',
        updatedAt: '2026-09-24T12:00:00Z',
        history: [
          { step: 'implement', story: 'S-1', ok: false, note: 'denied: Bash(touch x)' },
          { step: 'test', ok: true },
          { step: 'test', ok: false, note: 'node exited 1' },
        ],
      }),
    );
    const r = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /run: escalated at step test — test gate failed twice \(updated 2026-09-24T12:00:00Z, 3 events, last: node exited 1\)/,
    );
    assert.match(r.stdout, /✗ implement S-1: denied: Bash\(touch x\)\n {2}✗ test: node exited 1/);

    // An open escalation refuses the run before the worktree is touched, so
    // the feature stays `escalated` instead of flipping to `running`.
    const fpath = join(dir, 'features', 'F1-feat', 'index.md');
    writeFileSync(
      fpath,
      readFileSync(fpath, 'utf8').replace(/## Escalation\n\nNone\./, '## Escalation\n\nStill open.'),
    );
    const run = runBl(['run', 'F-1'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /open ## Escalation/);
    assert.equal(parseFrontmatter(readFileSync(fpath, 'utf8')).fm.status, 'escalated');
  } finally {
    cleanup();
  }
});

test("bl status prints each repo's branch, PR, URL and merge state from the change documents, every one when there are several", () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', branch: 'f1-feat' }],
  });
  try {
    const fdir = join(dir, 'features', 'F1-feat');
    // The first change was merged; the second is open across two repos.
    writeFileSync(
      join(fdir, 'change.md'),
      readFileSync(join(fdir, 'change.md'), 'utf8')
        .replace('status: open', 'status: merged')
        .replace('    pr:\n    url:\n    merged:\n', '    pr: 7\n    url: https://x/pull/7\n    merged: abc1234\n'),
    );
    writeFileSync(
      join(fdir, 'change-2.md'),
      '---\nchange_of: F-1\nstatus: open\nreview_round: 1\nreview_status: pending\nrepos:\n  - repo: demo-repo\n    branch: f1-feat\n    pr: 9\n    url: https://x/pull/9\n    merged:\n  - repo: tools\n    branch: f1-feat\n    pr:\n    url:\n    merged:\n---\n\n## Review Log\n\n### Session 2026-10-18 (PR #9)\n\n**Must fix**\n\n- [ ] open\n',
    );
    const r = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /branch: f1-feat {3}pr: #9 {3}points: 0\nreview: pending \(round 1\/2\), latest session 2026-10-18 with 1 unchecked Must\/Should\n/,
      'the open change is current',
    );
    assert.match(
      r.stdout,
      /\nchange change\.md \(merged\):\n {2}demo-repo: branch f1-feat {3}pr: #7 https:\/\/x\/pull\/7 {3}merged: abc1234\n/,
    );
    assert.match(
      r.stdout,
      /\nchange change-2\.md \(open, current\):\n {2}demo-repo: branch f1-feat {3}pr: #9 https:\/\/x\/pull\/9 {3}merged: no\n {2}tools: branch f1-feat {3}pr: - {3}merged: no\n/,
    );
  } finally {
    cleanup();
  }
});

test('bl merge lands the branch, marks work done, and commits only what it changed in the backlog', async () => {
  const { spawnSync } = await import('child_process');
  const { appendFileSync } = await import('fs');
  const { dir, cleanup } = mkTempBacklog({
    repos: ['./code'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
      { id: 'S-2', component: 'C00', title: 'Operator editing', dirSuffix: 'b', points: 2 },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const origin = join(dir, 'origin.git');
    g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    const code = join(dir, 'code');
    g(dir, 'init', '-q', '-b', 'main', code);
    g(code, 'remote', 'add', 'origin', origin);
    writeFileSync(join(code, 'a.txt'), 'base\n');
    g(code, 'add', '.');
    g(code, 'commit', '-q', '-m', 'base');
    g(code, 'push', '-q', 'origin', 'main');
    g(code, 'checkout', '-q', '-b', 'f1-feat');
    writeFileSync(join(code, 'a.txt'), 'feature\n');
    g(code, 'commit', '-qam', 'feat');
    g(code, 'push', '-q', 'origin', 'f1-feat');
    g(code, 'checkout', '-q', 'main');

    // A cleanup plugin records the session variables merge hands it.
    const bj = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
    bj.plugins = { sess: { cleanup: 'echo {{sessionId}} {{sessionNum}} > {{backlogDir}}/.bl-sess.txt' } };
    bj.repos.code.deployable = true;
    bj.repos.code['plugins-cleanup'] = ['sess'];
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(bj, null, 2) + '\n');
    writeFileSync(join(dir, '.gitignore'), 'code/\norigin.git/\n.bl/\n.bl-sess.txt\n');
    // Per-step tokens on the story and the feature, folded key by key (S-904).
    const addSteps = (path, steps) => {
      const { fm: f, body } = parseFrontmatter(readFileSync(path, 'utf8'));
      f.tokens_input = '1';
      f.tokens_by_step = steps;
      writeFileSync(path, serializeFrontmatter(f) + body);
    };
    const kinds = (input) => ({ input: String(input), output: '1', cache_creation: '0', cache_read: '0' });
    addSteps(join(dir, 'features', 'F1-feat', 'index.md'), { implement: kinds(10), 'review.1': kinds(20) });
    addSteps(join(dir, 'stories', 'S1-a', 'index.md'), { 'review.1': kinds(2), 'fix.1': kinds(3) });
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'backlog');
    const opStory = join(dir, 'stories', 'S2-b', 'index.md');
    appendFileSync(opStory, '\nOperator notes in progress.\n');

    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(g(code, 'show', 'main:a.txt'), 'feature', 'branch merged into main');
    assert.equal(g(origin, 'show', 'main:a.txt'), 'feature', 'main pushed');
    const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.ok(
      files.some((f) => f.startsWith('features/F1-feat/')),
      files.join('\n'),
    );
    // The story is marked done where it is: nothing moves (F-49 D3).
    assert.ok(files.includes('stories/S1-a/index.md'), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('.completed/')), files.join('\n'));
    assert.equal(fm(join(dir, 'stories', 'S1-a', 'index.md')).status, 'done');
    assert.ok(!files.some((f) => f.includes('S2-b')), `operator's story must not be committed:\n${files.join('\n')}`);
    assert.match(g(dir, 'status', '--porcelain'), /S2-b\/index\.md/);
    assert.match(readFileSync(opStory, 'utf8'), /Operator notes in progress/);
    assert.match(r.stderr, /Left your uncommitted backlog edits alone: .*S2-b/);
    const featureFm = fm(join(dir, 'features', 'F1-feat', 'index.md'));
    assert.equal(featureFm.status, 'done');
    assert.match(featureFm.commit, /^[0-9a-f]{7,}$/);
    assert.equal(featureFm.tokens_input, '2', "the story's totals folded in");
    assert.deepEqual(featureFm.tokens_by_step, {
      implement: kinds(10),
      'review.1': { ...kinds(22), output: '2' },
      'fix.1': kinds(3),
    });
    assert.equal(
      readFileSync(join(dir, '.bl-sess.txt'), 'utf8').trim(),
      's1 1',
      "cleanup plugins get the first story's session, not f<n>",
    );

    // The merge commit is tagged F-1 (annotated, naming the change document) and the tag pushed.
    const mergeSha = g(code, 'rev-parse', 'main');
    assert.equal(g(code, 'rev-parse', 'F-1^{commit}'), mergeSha);
    assert.equal(g(code, 'cat-file', '-t', 'F-1'), 'tag', 'annotated');
    assert.match(
      g(code, 'tag', '-l', '--format=%(contents)', 'F-1'),
      /^F-1: Feat\n\nChange: features\/F1-feat\/change\.md/,
    );
    assert.equal(g(origin, 'rev-parse', 'F-1^{commit}'), mergeSha, 'the tag is pushed');
    // The release manifest records main of every deployable repo, and is committed.
    const manifest = JSON.parse(readFileSync(join(dir, 'releases', 'F-1.json'), 'utf8'));
    assert.deepEqual(manifest.repos, { code: mergeSha });
    assert.equal(manifest.feature, 'F-1');
    assert.equal(manifest.change, 'features/F1-feat/change.md');
    assert.ok(files.includes('releases/F-1.json'), files.join('\n'));
    // The change document stays beside the feature and records the merge.
    const change = parseChange(readFileSync(join(dir, 'features', 'F1-feat', 'change.md'), 'utf8'));
    assert.equal(change.fm.status, 'merged');
    assert.equal(change.repos[0].merged, featureFm.commit);
    const merge = extractSection(change.body, 'Merge');
    assert.match(
      merge,
      new RegExp(
        `- \\d{4}-\\d{2}-\\d{2} · code · merged ${featureFm.commit}\\n- Tag: \`F-1\` on code\\n- Release manifest: \\[releases/F-1\\.json\\]\\(\\.\\./\\.\\./releases/F-1\\.json\\)`,
      ),
    );
    assert.ok(existsSync(join(dir, 'features', 'F1-feat', '../../releases/F-1.json')), 'the link resolves');
  } finally {
    cleanup();
  }
});

test('feature merge tag push failure writes no manifest or merged completion state, and the retry completes', async () => {
  const { spawnSync } = await import('child_process');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true } },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const { repo, origin } = initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
    // The origin takes main but refuses every tag.
    const hook = join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nif grep -q refs/tags/; then echo injected tag refusal >&2; exit 1; fi\n', {
      mode: 0o755,
    });
    writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'backlog');

    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Tagging F-1 failed: code: git push of tag F-1 failed: .*injected tag refusal/);
    assert.equal(g(origin, 'show', 'main:a.txt'), 'feature', 'the merge is pushed');
    assert.equal(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], { cwd: origin }).status,
      1,
      'no remote tag',
    );
    assert.equal(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], { cwd: repo }).status,
      1,
      'no local tag',
    );
    assert.ok(!existsSync(join(dir, 'releases', 'F-1.json')), 'no manifest');
    assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'running', 'the feature is not done');
    assert.equal(fm(join(dir, 'stories', 'S1-a', 'index.md')).status, 'in_progress', 'the story is not done');
    assert.equal(g(dir, 'log', '--format=%s', '-1'), 'backlog', 'nothing committed');

    // Once the origin takes tags, the retry tags the set and completes.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const again = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(g(origin, 'rev-parse', 'F-1^{commit}'), g(origin, 'rev-parse', 'main'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'releases', 'F-1.json'), 'utf8')).repos, {
      code: g(origin, 'rev-parse', 'main'),
    });
    assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'done');
  } finally {
    cleanup();
  }
});

test('feature merge main lookup failure writes no manifest or merged completion state', async () => {
  const { spawnSync } = await import('child_process');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true }, other: { path: './other', deployable: true } },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const { repo, origin } = initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
    // A deployable repo the feature does not touch, whose origin is unreachable
    // while its local main has a commit.
    const other = initFeatureRepo(g, dir, 'other');
    g(other.repo, 'remote', 'set-url', 'origin', join(dir, 'gone.git'));
    writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\nother/\nother-origin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'backlog');

    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /release manifest: other: origin main unreadable/);
    assert.equal(g(origin, 'show', 'main:a.txt'), 'feature', 'the merge is pushed');
    assert.equal(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], { cwd: origin }).status,
      1,
      'no remote tag',
    );
    assert.equal(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], { cwd: repo }).status,
      1,
      'no local tag',
    );
    assert.ok(!existsSync(join(dir, 'releases', 'F-1.json')), 'no manifest');
    assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'running', 'the feature is not done');
    assert.equal(fm(join(dir, 'stories', 'S1-a', 'index.md')).status, 'in_progress', 'the story is not done');
    assert.equal(g(dir, 'log', '--format=%s', '-1'), 'backlog', 'nothing committed');

    // Once the origin is reachable, the retry records both remote mains; a
    // backlog commit that then fails still makes the command exit 1.
    g(other.repo, 'remote', 'set-url', 'origin', other.origin);
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const again = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(again.status, 1, again.stderr);
    assert.match(
      again.stderr,
      /backlog commit failed[\s\S]*F-1: the release manifest and the merged state are written but not committed/,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'releases', 'F-1.json'), 'utf8')).repos, {
      code: g(origin, 'rev-parse', 'main'),
      other: g(other.origin, 'rev-parse', 'main'),
    });
  } finally {
    cleanup();
  }
});

test('bl merge F-n refuses before merging anything when a repos entry has no valid deployable', async () => {
  const { spawnSync } = await import('child_process');
  const { dir, cleanup } = mkTempBacklog({
    repos: ['./code'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const { repo } = initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
    const before = g(repo, 'rev-parse', 'main');
    for (const [value, why] of [
      [undefined, /repos\["code"\] has no "deployable"/],
      ['yes', /repos\["code"\] "deployable" must be true or false/],
    ]) {
      const bj = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
      if (value === undefined) delete bj.repos.code.deployable;
      else bj.repos.code.deployable = value;
      writeFileSync(join(dir, 'backlog.json'), JSON.stringify(bj, null, 2) + '\n');
      const r = runBl(['merge', 'F-1'], { cwd: dir, env });
      assert.equal(r.status, 1, JSON.stringify(value));
      assert.match(r.stderr, why);
      assert.equal(g(repo, 'rev-parse', 'main'), before, 'nothing merged');
      assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'running');
    }
  } finally {
    cleanup();
  }
});

test('bl approve refuses while ## Escalation has content, even with --force, and passes with None.', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'Inside', dirSuffix: 'inside', points: 8, feature: 'F-1' }],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'refined',
        stories: ['S-1'],
        escalation: 'Resolved 2026-10-04. The operator chose A1, B2 and C1 (see Premise).',
      },
    ],
  });
  const featurePath = join(dir, 'features/F1-feat/index.md');
  try {
    for (const extra of [[], ['--force']]) {
      const r = runBl(['approve', 'F-1', ...extra], { cwd: dir });
      assert.equal(r.status, 1, extra.join(' '));
      assert.match(r.stderr, /"Resolved 2026-10-04\. The operator chose A1, B2 and C1 \(see Premise\)\."/);
      assert.match(
        r.stderr,
        /record the decision in the Design \(or the Review Log\) and set `## Escalation` to `None\.`/i,
      );
      assert.equal(fm(featurePath).status, 'refined');
    }
    const text = readFileSync(featurePath, 'utf8');
    writeFileSync(featurePath, text.replace(/(## Escalation\n\n)[^\n]*/, '$1None.'));
    const r = runBl(['approve', 'F-1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fm(featurePath).status, 'approved');
  } finally {
    cleanup();
  }
});

test('bl validate warns escalation-not-none for a refined/approved/running feature, not for an escalated one', () => {
  const esc = 'Resolved 2026-10-04. The operator chose A1.';
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', feature: 'F-2' },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three', feature: 'F-3' },
    ],
    features: [
      { id: 'F-1', title: 'Refined', dirSuffix: 'refined', status: 'refined', stories: ['S-1'], escalation: esc },
      { id: 'F-2', title: 'Escalated', dirSuffix: 'escalated', status: 'escalated', stories: ['S-2'], escalation: esc },
      { id: 'F-3', title: 'Clean', dirSuffix: 'clean', status: 'approved', stories: ['S-3'] },
    ],
  });
  try {
    const r = runBl(['validate', '--json'], { cwd: dir });
    const hits = JSON.parse(r.stdout).findings.filter((f) => f.code === 'escalation-not-none');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].severity, 'warning');
    assert.equal(hits[0].location, 'features/F1-refined/index.md');
    assert.match(hits[0].message, /feature F-1 is refined/);
    assert.match(
      hits[0].message,
      /record the decision in the Design \(or the Review Log\) and set ## Escalation to "None\."/,
    );
    assert.equal(r.status, 0, 'a warning alone does not fail validate');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S-868: a repo whose feature branch is absent locally records the tip of
// its main, unless the feature already names an exact merge SHA for it.
// ---------------------------------------------------------------------------

/**
 * A bare origin plus a working clone on `main` with one commit, under `dir`.
 * With `branch`, that branch holds one more commit and the clone is back on
 * `main`. Returns the clone and origin paths.
 */
function initFeatureRepo(g, dir, name, { branch = null } = {}) {
  const origin = join(dir, `${name}-origin.git`);
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(dir, name);
  g(dir, 'init', '-q', '-b', 'main', repo);
  g(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', 'origin', 'main');
  if (branch) {
    g(repo, 'checkout', '-q', '-b', branch);
    writeFileSync(join(repo, 'a.txt'), 'feature\n');
    g(repo, 'commit', '-qam', 'feat');
    g(repo, 'checkout', '-q', 'main');
  }
  return { repo, origin };
}

/** Land an unrelated commit on origin's main and leave the clone behind it. */
function advanceOriginMain(g, repo) {
  writeFileSync(join(repo, 'later.txt'), 'later\n');
  g(repo, 'add', 'later.txt');
  g(repo, 'commit', '-q', '-m', 'later work');
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'reset', '-q', '--hard', 'HEAD~1');
}

// Every `commit:` shape the feature file can carry (`commitFm` is its literal
// text): a two-repo feature whose secondary is absent stays a map with the
// secondary's earlier SHA; a one-repo feature whose only repo is absent keeps
// that SHA whether it is held as a one-entry map or as the collapsed bare
// string, and ends as the bare string. In all, the absent repo's main has
// moved on, so its tip is not the SHA on record.
for (const [name, repos, recorded, commitFm, expected] of [
  [
    'a multi-repo map',
    { code: { branch: 'f1-feat' }, lib: {} },
    { lib: 'exact111' },
    'commit:\n  lib: exact111',
    (tips) => ({ code: tips.code, lib: 'exact111' }),
  ],
  ['a single-repo one-entry map', { code: {} }, { code: 'exact111' }, 'commit:\n  code: exact111', () => 'exact111'],
  [
    'a genuine single-repo bare-string commit',
    { code: {} },
    { code: 'exact111' },
    'commit: exact111',
    () => 'exact111',
  ],
]) {
  test(`feature merge re-run keeps an earlier exact SHA from ${name} when the branch is absent and main advanced`, async () => {
    const { spawnSync } = await import('child_process');
    const repoNames = Object.keys(repos);
    // The other repos are the feature's through a story each, in a component of that repo
    // (S-1010: a feature's repos come from its stories; F-52 D1: a story's repo is its component's).
    const secondaries = repoNames.filter((r) => r !== 'code');
    const { dir, cleanup } = mkTempBacklog({
      repos: Object.fromEntries(repoNames.map((r) => [r, { path: `./${r}`, deployable: true }])),
      components: [
        { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' },
        ...secondaries.map((r, i) => ({ id: `C0${i + 1}`, title: r, dirSuffix: r, repo: r })),
      ],
      stories: [
        {
          id: 'S-1',
          component: 'C00',
          title: 'In feature',
          dirSuffix: 'a',
          points: 3,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] a\n',
        },
        ...secondaries.map((r, i) => ({
          id: `S-${i + 2}`,
          component: `C0${i + 1}`,
          title: `In ${r}`,
          dirSuffix: r,
          points: 1,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] a\n',
        })),
      ],
      features: [
        {
          id: 'F-1',
          title: 'Feat',
          dirSuffix: 'feat',
          status: 'running',
          stories: ['S-1', ...secondaries.map((_, i) => `S-${i + 2}`)],
          branch: 'f1-feat',
          review_status: 'addressed',
          reviewLog:
            '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
        },
      ],
    });
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      const built = {};
      for (const r of repoNames) built[r] = initFeatureRepo(g, dir, r, repos[r]);
      // The feature already names an exact SHA for the absent repo (an
      // earlier run), and that repo's main has moved on since.
      const fpath = join(dir, 'features', 'F1-feat', 'index.md');
      writeFileSync(fpath, readFileSync(fpath, 'utf8').replace(/^stories:/m, `${commitFm}\nstories:`));
      for (const r of Object.keys(recorded)) advanceOriginMain(g, built[r].repo);
      writeFileSync(join(dir, '.gitignore'), `${repoNames.map((r) => `${r}/\n${r}-origin.git/\n`).join('')}.bl/\n`);
      g(dir, 'init', '-q', '-b', 'main');
      g(dir, 'add', '.');
      g(dir, 'commit', '-q', '-m', 'backlog');

      const r = runBl(['merge', 'F-1'], { cwd: dir, env });
      assert.equal(r.status, 0, r.stderr);

      const tips = {};
      for (const n of repoNames) tips[n] = g(built[n].origin, 'rev-parse', '--short', 'main');
      const want = expected(tips);
      const featureFm = fm(join(dir, 'features', 'F1-feat', 'index.md'));
      assert.equal(featureFm.status, 'done');
      assert.deepEqual(featureFm.commit, want);
      assert.deepEqual(fm(join(dir, 'stories', 'S1-a', 'index.md')).commit, want);
      for (const n of Object.keys(recorded)) {
        assert.notEqual(tips[n], 'exact111', 'main advanced past the SHA on record');
        assert.equal(g(built[n].repo, 'rev-parse', '--short', 'main'), tips[n], 'the clone was pulled to origin/main');
      }
    } finally {
      cleanup();
    }
  });
}

/**
 * A running, reviewed feature F-1 over one story per repo in `repos` (in
 * that listed order, `deps` its depends_on), each repo a clone with an
 * origin and, unless in `noBranch`, a commit on f1-feat. Returns the paths
 * and a git runner.
 */
async function mergeFixture(repos, { deps = {}, extraRepos = [] } = {}) {
  const { spawnSync } = await import('child_process');
  const all = [...repos, ...extraRepos];
  const { dir, cleanup } = mkTempBacklog({
    repos: Object.fromEntries(all.map((r) => [r, { path: `./${r}`, deployable: true }])),
    components: all.map((r, i) => ({ id: `C0${i}`, title: r, dirSuffix: r, repo: r, home: true })),
    stories: repos.map((r, i) => ({
      id: `S-${i + 1}`,
      component: `C0${i}`,
      title: `In ${r}`,
      dirSuffix: r,
      points: 1,
      status: 'in_progress',
      feature: 'F-1',
      depends_on: deps[`S-${i + 1}`],
      body: '## Acceptance Criteria\n\n- [x] a\n',
    })),
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: repos.map((_, i) => `S-${i + 1}`),
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const built = {};
  for (const r of all) built[r] = initFeatureRepo(g, dir, r, { branch: 'f1-feat' });
  writeFileSync(join(dir, '.gitignore'), `${all.map((r) => `${r}/\n${r}-origin.git/\n`).join('')}.bl/\n`);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, env, g, built };
}

test('bl merge F-n merges bl first, syncs the backlog, then the other repos in dependency order', async () => {
  // Listed app, containers, bl; app's story depends on containers', so the
  // order is bl, containers, app (F-52 D3).
  const { dir, cleanup, env } = await mergeFixture(['app', 'containers', 'bl'], { deps: { 'S-1': 'S-2' } });
  try {
    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^Repos {3}: bl, containers, app$/m);
    const at = (s) => {
      const i = r.stderr.indexOf(s);
      assert.notEqual(i, -1, `missing ${s}`);
      return i;
    };
    const bl = at('=== bl ===');
    const sync = at('Syncing backlog with the merged bl...');
    const containers = at('=== containers ===');
    const app = at('=== app ===');
    assert.ok(bl < sync && sync < containers && containers < app, 'bl, the sync, containers, app');
    assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'done');
  } finally {
    cleanup();
  }
});

test('bl merge F-n refuses a worktree on the branch in a repo no story names, and merges nothing', async () => {
  const { dir, cleanup, env, g, built } = await mergeFixture(['code'], { extraRepos: ['stray'] });
  try {
    g(built.stray.repo, 'worktree', 'add', '-q', join(dir, 'stray-wt'), 'f1-feat');
    const before = g(built.code.repo, 'rev-parse', 'main');
    const r = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /F-1 has a worktree on f1-feat in stray, but its repo is code\. Work in another repo is another story/,
    );
    assert.equal(g(built.code.repo, 'rev-parse', 'main'), before, 'code not merged');
    assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'running');
  } finally {
    cleanup();
  }
});

test('bl implement and bl run F-n refuse --repo as an unknown option', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    stories: [
      { id: 'S-1', component: 'C00', title: 'A', dirSuffix: 'a', points: 3, status: 'refined', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', stories: ['S-1'] }],
  });
  try {
    for (const verb of ['implement', 'run']) {
      const r = runBl([verb, 'F-1', '--repo', 'demo-repo'], { cwd: dir });
      assert.equal(r.status, 1, verb);
      assert.match(r.stderr, new RegExp(`bl ${verb}: unknown option "--repo" for a feature`), verb);
      assert.match(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, /^approved$/, verb);
    }
  } finally {
    cleanup();
  }
});

test('concurrent feature no-branch cleanup keeps the exact SHA written after its decision read', async () => {
  // A one-repo feature whose repo has no local branch. The test holds the
  // backlog lock while `bl merge` does its git work, then records the repo's
  // exact merge SHA (another merge landing it) before releasing the lock.
  // The merge decides under the lock, so it must find that SHA and keep it
  // instead of installing main's tip.
  const { spawn, spawnSync } = await import('child_process');
  const { unlinkSync } = await import('fs');
  const { BL_BIN } = await import('../helpers/run-bl.js');
  const { LOCK_FILE } = await import('../../src/lock.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true } },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'a',
        points: 3,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const { repo, origin } = initFeatureRepo(g, dir, 'code');
    advanceOriginMain(g, repo);
    writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'backlog');

    const lockPath = join(dir, LOCK_FILE);
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
    const child = spawn(BL_BIN, ['merge', 'F-1'], {
      cwd: dir,
      env: { ...process.env, BL_BACKLOG_DIR: dir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve((exitCode = code))));
    // The no-branch path reports main's tip (`info` writes to stderr) before
    // its last git calls; the merge then blocks on the lock the test holds,
    // which is when its stderr goes quiet. Injecting only then puts the SHA
    // after any read the merge makes without the lock, so a decision read
    // outside the lock sees the tip and fails this test.
    const deadline = Date.now() + 20_000;
    let quietSince = null;
    let seen = stderr;
    for (;;) {
      if (exitCode !== null || Date.now() > deadline) {
        throw new Error(
          `merge never blocked on the lock after the no-branch path (exit ${exitCode}):\n${stdout}\n${stderr}`,
        );
      }
      if (stderr !== seen) {
        seen = stderr;
        quietSince = Date.now();
      }
      if (seen.includes('recording main at') && quietSince !== null && Date.now() - quietSince >= 1_000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const fpath = join(dir, 'features', 'F1-feat', 'index.md');
    writeFileSync(fpath, readFileSync(fpath, 'utf8').replace(/^stories:/m, 'commit:\n  code: exact111\nstories:'));
    unlinkSync(lockPath);
    assert.equal(await exited, 0, stderr);

    assert.notEqual(g(origin, 'rev-parse', '--short', 'main'), 'exact111', "main's tip is not the SHA on record");
    assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).commit, 'exact111');
    assert.equal(fm(join(dir, 'stories', 'S1-a', 'index.md')).commit, 'exact111');
  } finally {
    cleanup();
  }
});

test('feature_merge_refuses_any_story_without_component_repo_before_mutation', async () => {
  const { spawnSync } = await import('child_process');
  // Every way a story has no repo, beside a story that has one: nothing lands, nothing is marked done.
  const cases = [
    [
      'unknown component, legacy primary_repo',
      { component: 'C99', primary_repo: 'lib' },
      /S-2 \(component C99\) has no repo/,
    ],
    ['no component', { component: undefined }, /S-2 \(component \(none\)\) has no repo/],
    ['component without a repo', { component: 'C01' }, /S-2 \(component C01\) has no repo/],
  ];
  for (const [name, s2, why] of cases) {
    const { dir, cleanup } = mkTempBacklog({
      repos: ['./code'],
      components: [
        { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' },
        { id: 'C01', title: 'Loose', dirSuffix: 'loose' },
      ],
      stories: [
        {
          id: 'S-1',
          component: 'C00',
          title: 'Code',
          dirSuffix: 'a',
          points: 3,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] a\n',
        },
        {
          id: 'S-2',
          title: 'Lib',
          dirSuffix: 'b',
          points: 1,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] b\n',
          ...s2,
        },
      ],
      features: [
        {
          id: 'F-1',
          title: 'Feat',
          dirSuffix: 'feat',
          status: 'running',
          stories: ['S-1', 'S-2'],
          branch: 'f1-feat',
          review_status: 'addressed',
        },
      ],
    });
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      const { repo } = initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
      const bj = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
      bj.repos.code.deployable = true;
      writeFileSync(join(dir, 'backlog.json'), JSON.stringify(bj, null, 2) + '\n');
      const before = g(repo, 'rev-parse', 'main');
      const r = runBl(['merge', 'F-1'], { cwd: dir, env });
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, why, name);
      assert.equal(g(repo, 'rev-parse', 'main'), before, `${name}: nothing merged`);
      assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'running', name);
      for (const s of ['S1-a', 'S2-b'])
        assert.equal(fm(join(dir, 'stories', s, 'index.md')).status, 'in_progress', `${name}: ${s}`);
      // A feature review refuses the same way, rather than reviewing only some repos.
      const rv = runBl(['review', 'F-1'], { cwd: dir, env });
      assert.equal(rv.status, 1, name);
      assert.match(rv.stderr, why, `${name}: review`);
    } finally {
      cleanup();
    }
  }
});

// F-53 D1: the feature order follows a feature merge, in its one backlog
// commit; a missing feature-order.md only warns.
for (const missing of [false, true]) {
  test(`bl merge F-n ${missing ? 'warns and completes with no feature-order.md' : "drops the feature from ranked: and records it in History, in the merge's backlog commit"}`, async () => {
    const { spawnSync } = await import('child_process');
    const { dir, cleanup } = mkTempBacklog({
      repos: { code: { path: './code', deployable: true } },
      components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'code' }],
      stories: [
        {
          id: 'S-1',
          component: 'C00',
          title: 'In feature',
          dirSuffix: 'a',
          points: 3,
          status: 'in_progress',
          feature: 'F-1',
          body: '## Acceptance Criteria\n\n- [x] a\n',
        },
      ],
      features: [
        {
          id: 'F-1',
          title: 'Feat',
          dirSuffix: 'feat',
          status: 'running',
          stories: ['S-1'],
          branch: 'f1-feat',
          review_status: 'addressed',
          reviewLog:
            '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
        },
        { id: 'F-2', title: 'Later', dirSuffix: 'later', status: 'draft' },
      ],
      featureOrder: missing
        ? null
        : [
            { feature: 'F-1', why: 'Lands first.' },
            { feature: 'F-2', why: 'After F-1.' },
          ],
    });
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      initFeatureRepo(g, dir, 'code', { branch: 'f1-feat' });
      writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\n.bl/\n');
      g(dir, 'init', '-q', '-b', 'main');
      g(dir, 'add', '.');
      g(dir, 'commit', '-q', '-m', 'backlog');

      const r = runBl(['merge', 'F-1'], { cwd: dir, env });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fm(join(dir, 'features', 'F1-feat', 'index.md')).status, 'done');
      assert.equal(g(dir, 'status', '--porcelain'), '', 'the merge commits everything it wrote');
      const files = g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
      if (missing) {
        assert.match(r.stderr, /warning: feature-order\.md is missing, so F-1 is not recorded in the feature order/);
        assert.ok(!existsSync(join(dir, 'feature-order.md')), 'no file is created');
        return;
      }
      assert.ok(files.includes('feature-order.md'), files.join('\n'));
      assert.ok(files.includes('features/F1-feat/index.md'), 'one commit with the feature marked done');
      // Its theme's `## State` records it in the same commit (F-53 D4).
      assert.ok(files.includes('themes/demo/index.md'), files.join('\n'));
      const themeText = g(dir, 'show', 'HEAD:themes/demo/index.md');
      const doneOn = fm(join(dir, 'features', 'F1-feat', 'index.md')).completed;
      assert.equal(extractSection(`${themeText}\n`, 'State').trim(), `- ${doneOn}: F-1 done (Feat).`);
      const text = g(dir, 'show', 'HEAD:feature-order.md');
      const order = parseFrontmatter(`${text}\n`);
      assert.deepEqual(order.fm.ranked, [{ feature: 'F-2', why: 'After F-1.' }]);
      const stamp = fm(join(dir, 'features', 'F1-feat', 'index.md')).completed;
      assert.match(
        extractSection(order.body, 'History'),
        new RegExp(`- 2026-01-01: F-0 done \\(Before the fixture\\)\\.\\n- ${stamp}: F-1 done \\(Feat\\)\\.\\n`),
      );
      // The sync in the same merge regenerated Next up without F-1.
      const nextUp = extractSection(order.body, 'Next up');
      assert.match(nextUp, /\| 1 +\| \[F-2\]\(features\/F2-later\/index\.md\)/);
      assert.doesNotMatch(nextUp, /\[F-1\]/);
    } finally {
      cleanup();
    }
  });
}

test('concurrent_feature_merges_fold_each_story_once', async () => {
  const { spawnSync } = await import('child_process');
  const { loadConfig } = await import('../../src/config.js');
  const { readAllFeatures } = await import('../../src/feature.js');
  const { cmdMerge } = await import('../../src/feature-cmd.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true } },
    components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'T',
        dirSuffix: 'a',
        points: 1,
        status: 'in_progress',
        feature: 'F-1',
        body: '## Acceptance Criteria\n\n- [x] a\n',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-feat',
        review_status: 'addressed',
        reviewLog: '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  const env = { ...process.env };
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  });
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const fpath = join(dir, 'features', 'F1-feat', 'index.md');
  const spath = join(dir, 'stories', 'S1-a', 'index.md');
  const update = (path, mutate) => {
    const { fm: f, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    mutate(f);
    writeFileSync(path, serializeFrontmatter(f) + body);
  };
  const kinds = (input) => ({ input: String(input), output: '0', cache_creation: '0', cache_read: '0' });
  try {
    const code = join(dir, 'code');
    mkdirSync(code, { recursive: true });
    g(code, 'init', '-q', '-b', 'main');
    writeFileSync(join(code, 'a.txt'), 'base\n');
    g(code, 'add', '.');
    g(code, 'commit', '-qm', 'base');
    g(dir, 'clone', '-q', '--bare', code, join(dir, 'origin.git'));
    g(code, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    const tip = g(code, 'rev-parse', '--short', 'HEAD');
    update(fpath, (f) => {
      f.commit = tip;
      f.tokens_input = '10';
      f.tokens_by_step = { implement: kinds(10) };
    });
    update(spath, (f) => {
      f.tokens_input = '5';
      f.tokens_by_step = { 'review.1': kinds(5) };
    });
    writeFileSync(join(dir, '.gitignore'), 'code/\norigin.git/\n.bl/\n');
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, 'add', '.');
    g(dir, 'commit', '-qm', 'backlog');
    const config = loadConfig({ backlogRoot: dir });
    // Both callers load the running feature before either takes the lock.
    const [first] = readAllFeatures(config);
    const [second] = readAllFeatures(config);
    await cmdMerge({}, config, first);
    await cmdMerge({}, config, second);
    const f = fm(fpath);
    assert.equal(f.status, 'done');
    assert.deepEqual(f.tokens_by_step, { implement: kinds(10), 'review.1': kinds(5) }, "the story's map folded once");
    assert.equal(f.tokens_input, '15', "the story's totals folded once");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    cleanup();
  }
});

test('concurrent_feature_merges_with_transcripts_preserve_folded_totals', async () => {
  const { spawnSync } = await import('child_process');
  const { loadConfig } = await import('../../src/config.js');
  const { readAllFeatures } = await import('../../src/feature.js');
  const { cmdMerge } = await import('../../src/feature-cmd.js');
  const { ClaudeProvider } = await import('../../src/agents/claude.js');
  const kinds = (input) => ({ input: String(input), output: '0', cache_creation: '0', cache_read: '0' });
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const update = (path, mutate) => {
    const { fm: f, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    mutate(f);
    writeFileSync(path, serializeFrontmatter(f) + body);
  };
  // The feature's own transcripts hold 10 input tokens, or there are none;
  // the second caller loaded the running feature before the first merge
  // finished, or retries one that stopped after marking the story done.
  const cases = [];
  for (const transcripts of [10, null]) {
    for (const second of ['stale after done', 'retry after story writes']) cases.push({ transcripts, second });
  }
  const env = { ...process.env };
  const getTokens = ClaudeProvider.prototype.getTokens;
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  });
  try {
    for (const { transcripts, second } of cases) {
      const name = `${transcripts ? 'transcripts' : 'no transcripts'}, ${second}`;
      // The feature's sessions started in its unit directory (F-60 D3), whose
      // parent is the worktree root; its worktree has no transcripts.
      ClaudeProvider.prototype.getTokens = (d) =>
        transcripts && basename(dirname(d)) === 'worktrees'
          ? { input: transcripts, output: 0, cache_creation: 0, cache_read: 0 }
          : null;
      const { dir, cleanup } = mkTempBacklog({
        repos: { code: { path: './code', deployable: true } },
        components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'T',
            dirSuffix: 'a',
            points: 1,
            status: second === 'retry after story writes' ? 'done' : 'in_progress',
            feature: 'F-1',
            body: '## Acceptance Criteria\n\n- [x] a\n',
          },
        ],
        features: [
          {
            id: 'F-1',
            title: 'Feat',
            dirSuffix: 'feat',
            status: 'running',
            stories: ['S-1'],
            branch: 'f1-feat',
            review_status: 'addressed',
            reviewLog:
              '### Session 2026-09-24 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
          },
        ],
      });
      try {
        const fpath = join(dir, 'features', 'F1-feat', 'index.md');
        const spath = join(dir, 'stories', 'S1-a', 'index.md');
        const code = join(dir, 'code');
        mkdirSync(code, { recursive: true });
        g(code, 'init', '-q', '-b', 'main');
        writeFileSync(join(code, 'a.txt'), 'base\n');
        g(code, 'add', '.');
        g(code, 'commit', '-qm', 'base');
        g(dir, 'clone', '-q', '--bare', code, join(dir, 'origin.git'));
        g(code, 'remote', 'add', 'origin', join(dir, 'origin.git'));
        const tip = g(code, 'rev-parse', '--short', 'HEAD');
        update(fpath, (f) => {
          f.commit = tip;
          f.tokens_input = '10';
          f.tokens_by_step = { implement: kinds(10) };
        });
        update(spath, (f) => {
          f.tokens_input = '5';
          f.tokens_by_step = { 'review.1': kinds(5) };
        });
        writeFileSync(join(dir, '.gitignore'), 'code/\norigin.git/\n.bl/\n');
        g(dir, 'init', '-q', '-b', 'main');
        g(dir, 'add', '.');
        g(dir, 'commit', '-qm', 'backlog');
        const config = loadConfig({ backlogRoot: dir });
        const [first] = readAllFeatures(config);
        const [stale] = readAllFeatures(config);
        if (second === 'stale after done') await cmdMerge({}, config, first);
        await cmdMerge({}, config, stale);
        const f = fm(fpath);
        assert.equal(f.status, 'done', name);
        assert.deepEqual(
          f.tokens_by_step,
          { implement: kinds(10), 'review.1': kinds(5) },
          `${name}: the map folded once`,
        );
        assert.equal(f.tokens_input, '15', `${name}: the totals folded once, and agree with the map`);
      } finally {
        cleanup();
      }
    }
  } finally {
    ClaudeProvider.prototype.getTokens = getTokens;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
});
