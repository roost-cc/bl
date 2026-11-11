import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, initGitBacklog } from '../helpers/git-backlog.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { findFeature, normalizeFeatureId } from '../../src/feature.js';
import { parseBlockers } from '../../src/blockers.js';
import { loadConfig } from '../../src/config.js';
import { rendered } from '../helpers/rendered.js';
import { HOME, REPOS, fm, newFeature, newStory } from '../helpers/feature-fixture.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

/** A feature's stories, the ones whose `feature:` names it (F-77 D3), in its order. */
function members(dir, id = 'F-1') {
  return findFeature(normalizeFeatureId(id), loadConfig({ backlogRoot: dir })).stories;
}

/**
 * Assert every `](…)` target in the `## <heading>` section of an index file
 * (its `content`, the file's text by default) exists on disk, resolved
 * against the index's own directory. Returns the
 * targets so a caller can check the section was not empty.
 */
function assertLinksResolve(indexPath, heading, content = readFileSync(indexPath, 'utf8')) {
  const section = content.match(new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\s*$)`));
  assert.ok(section, `missing ## ${heading} in ${indexPath}`);
  const targets = [...section[1].matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  for (const target of targets) {
    const abs = resolve(dirname(indexPath), target);
    assert.ok(existsSync(abs), `${indexPath}: ${target} does not resolve (${abs})`);
  }
  return targets;
}

test('bl new --feature scaffolds features/F1-<slug>/index.md, which the rendered root lists', () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS, components: [HOME] });
  try {
    const rel = newFeature(dir);
    assert.equal(rel, 'features/F1-invite-codes/index.md');
    const f = fm(join(dir, rel));
    assert.equal(f.feature_id, 'F-1');
    assert.equal(logStatusOf('feature', f), 'draft');
    assert.equal(f.primary_repo, undefined, 'a feature names no repo (F-52 D3)');
    assert.equal(f.review_rounds_max, '2');
    const content = readFileSync(join(dir, rel), 'utf8');
    for (const h of ['## Premise', '## Design', '## Acceptance', '## Deferred', '## Escalation']) {
      assert.match(content, new RegExp(`^${h}$`, 'm'), `missing ${h}`);
    }
    // The Stories table is rendered when the page is read, never committed (F-79 D3).
    assert.doesNotMatch(content, /^## Stories$/m);
    // The run state and the Review Log belong to the change document, which a
    // unit gets only when its branch is created.
    assert.doesNotMatch(content, /^## Review Log$/m);
    for (const k of ['branch', 'pr', 'review_round', 'review_status']) assert.equal(f[k], undefined, k);
    assert.ok(!existsSync(join(dir, 'features', 'F1-invite-codes', 'change.md')));
    // No index file is written (F-79 D1); the rendered root's Priority table lists it.
    assert.ok(!existsSync(join(dir, 'index.md')));
    const root = rendered(dir);
    assert.match(root, /## Priority\n\n[^#]*\[F-1\]\(features\/F1-invite-codes\/index\.md\)/);
    // A second feature gets F-2.
    const rel2 = newFeature(dir, 'Second');
    assert.equal(rel2, 'features/F2-second/index.md');
    // A freshly scaffolded feature (no stories, and no derived key) validates clean.
    assert.deepEqual(
      ['stories', 'points', 'components'].filter((k) => Object.hasOwn(f, k)),
      [],
    );
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
    // Shorter template: no Review Log / Deferred on feature stories.
    const storyContent = readFileSync(join(dir, storyRel), 'utf8');
    assert.doesNotMatch(storyContent, /## Review Log/);
    assert.doesNotMatch(storyContent, /## Deferred/);
    assert.match(storyContent, /## Implementation Plan/);

    const featurePath = join(dir, 'features', 'F1-invite-codes', 'index.md');
    assert.deepEqual(members(dir), ['S-1']);
    assert.equal(fm(featurePath).stories, undefined, 'the feature stores no stories: (F-77 D3)');

    // A second story joins; F-<n> C-<n> is the same as --feature.
    const r = runBl(['new', 'F-1', 'C00', '--title', 'Redeem', '--points', '2'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(members(dir), ['S-1', 'S-2']);
    assert.equal(fm(featurePath).points, undefined, 'nor points:');

    // --json carries the feature id.
    const j = runBl(['new', '--json', 'C00', '--title', 'Third', '--points', '2', '--feature', 'F-1'], { cwd: dir });
    assert.equal(j.status, 0, j.stderr);
    assert.equal(JSON.parse(j.stdout).feature, 'F-1');
    assert.deepEqual(members(dir), ['S-1', 'S-2', 'S-3']);

    // A done feature stays in features/, and the rendered root lists open
    // units only; whatever it links must resolve.
    // Closed by hand: an operator entry in its log (F-69 D2).
    const closed = parseFrontmatter(readFileSync(featurePath, 'utf8'));
    closed.fm.transitions.push({ at: closed.fm.transitions[0].at, to: 'done', by: 'operator' });
    writeFileSync(featurePath, serializeFrontmatter(closed.fm) + closed.body);
    assert.ok(existsSync(featurePath));
    const root = rendered(dir);
    assert.doesNotMatch(root, /\[F-1\]/, 'the Priority table lists open units only');
    assert.ok(assertLinksResolve(join(dir, 'index.md'), 'Components', root).length > 0);
  } finally {
    cleanup();
  }
});

test('the ad-hoc story command in prompts/_blocked-by-bug.md files a bug on the feature without syncing', () => {
  const { dir, cleanup } = mkTempBacklog({ repos: REPOS, components: [HOME] });
  try {
    newFeature(dir);
    newStory(dir, { title: 'Mint codes', extra: ['--feature', 'F-1'] });
    const featureFile = join(dir, 'features', 'F1-invite-codes', 'index.md');
    const before = readFileSync(featureFile, 'utf8');
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
    assert.deepEqual(members(dir), ['S-1', 'S-2']);
    assert.equal(readFileSync(featureFile, 'utf8'), before, 'the feature file is left alone');
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
        body: '## Summary\n\nTimeout.\n\n## Deferred\n\nNone.\n',
      },
    ],
  });
  try {
    newFeature(dir);
    newStory(dir, { title: 'Mint codes', extra: ['--feature', 'F-1'] });
    const featureFile = join(dir, 'features', 'F1-invite-codes', 'index.md');
    const before = readFileSync(featureFile, 'utf8');
    const line = blockedByBugLine(/^ *bl attach S-<id> \{\{featureId\}\} --no-sync$/m).trim();
    const args = line.replace('S-<id>', 'S-7').replace('{{featureId}}', 'F-1').split(' ').slice(1);
    const r = runBl(args, { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fm(join(dir, 'stories', 'S7', 'index.md')).feature, 'F-1');
    assert.deepEqual(members(dir), ['S-7', 'S-8']);
    assert.equal(readFileSync(featureFile, 'utf8'), before, 'the feature file is left alone');
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
          { id: 'mint', title: 'Mint codes', points: 5, effort: 'low', body_file: 'a.md', depends_on: ['@store'] },
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
    // Two stories of one feature: the dependency is an order edge in blockers.json (F-111 D5).
    assert.equal(Object.hasOwn(mint, 'depends_on'), false);
    assert.deepEqual(parseBlockers(readFileSync(join(dir, 'blockers.json'), 'utf8')), [
      { blocker: 'S-3', gate: 'order', unit: 'S-4', until: 'implemented' },
    ]);
    // A spec's effort is written as `effort:`; one with none keeps the template's empty key (F-85 D1).
    assert.equal(mint.effort, 'low');
    assert.match(readFileSync(join(dir, paths[0]), 'utf8'), /^points: 3\neffort:\n/m);
    // Each story's repo is its component's; none is written on the story (F-52 D1).
    assert.deepEqual([store.component, store.primary_repo], ['C01', undefined]);
    assert.deepEqual([mint.component, mint.primary_repo], ['C00', undefined]);
    assert.deepEqual([wire.component, wire.primary_repo], ['C02', undefined]);
    assert.match(r.stderr, /\[C01\]/, 'the plan marks a per-story component');
    // S-1 and S-2 were cut before the feature took any, so only the spec's are in it.
    assert.deepEqual(members(dir), ['S-3', 'S-4', 'S-5']);
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
          { id: 'y', title: 'Y', points: 2, component: 'E01', effort: 'fast', body_file: 's.md' },
        ],
      }),
    );
    let r = runBl(['new', '--from', 'bad.json'], { cwd: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /feature: feature 'F-4' not found/);
    assert.match(r.stderr, /stories\[1\]\.effort: must be one of low, medium, high, xhigh, max; got "fast"/);
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
