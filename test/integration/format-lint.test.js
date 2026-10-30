import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_CONFIG, mkTempBacklog, mkTempDir, reposConfig } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

function buildBacklogStory({
  storyId = 'S-1',
  storyDirName = 'S1-test',
  storyTitle = 'Test',
  storyFrontmatter = 'primary_repo: code\n',
  pluginsConfig = {
    plugins: { md: { format: 'true {{path}}' } },
    language_dispatch: { format: { '.md': 'md' } },
  },
} = {}) {
  const tmp = mkTempDir('bl-fmt-');
  const backlog = join(tmp, 'backlog');
  const repoRoot = join(tmp, 'code');

  mkdirSync(backlog, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });

  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify(
      {
        backlog: 'backlog',
        worktrees: `${tmp}/worktrees`,
        ...AGENT_CONFIG,
        repos: reposConfig([repoRoot]),
        ...pluginsConfig,
      },
      null,
      2,
    ),
  );

  const componentDir = join(backlog, 'components', 'C00-test');
  mkdirSync(componentDir, { recursive: true });
  writeFileSync(join(componentDir, 'index.md'), '---\ncomponent_id: C00\ntitle: Test\n---\n');
  const sDir = join(backlog, 'stories', storyDirName);
  mkdirSync(sDir, { recursive: true });
  const storyPath = join(sDir, 'index.md');
  writeFileSync(
    storyPath,
    `---\nstory_id: ${storyId}\ntitle: ${storyTitle}\nstatus: refined\n${storyFrontmatter}---\n\n## Summary\n\nText.\n`,
  );

  return { backlog, storyPath, tmp };
}

function addFeature(backlog, stories) {
  const fDir = join(backlog, 'features', 'F1-feat');
  mkdirSync(fDir, { recursive: true });
  const featurePath = join(fDir, 'index.md');
  writeFileSync(
    featurePath,
    `---\nfeature_id: F-1\ntitle: Feat\nstatus: running\nprimary_repo: code\nstories: [${stories.join(', ')}]\n---\n\n# F-1\n`,
  );
  return featurePath;
}

test('bl format --story F-<n> covers the feature file and every listed story', () => {
  const tmp = mkTempDir('bl-fmt-seen-');
  const seen = join(tmp, 'seen.txt');
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: { md: { format: `echo {{path}} >> ${seen}` } },
      language_dispatch: { format: { '.md': 'md' } },
    },
  });
  addFeature(backlog, ['S-1']);
  const r = runBl(['format', '--story', 'F-1'], { cwd: backlog });
  assert.equal(r.status, 0, r.stderr);
  const got = readFileSync(seen, 'utf8');
  assert.match(got, /features\/F1-feat\/index\.md/);
  assert.match(got, /stories\/S1-test\/index\.md/);
  assert.match(r.stderr, /backlog \(S-1\): 1 files via 1 plugin\(s\)/);
});

test('bl lint --story F-<n> exits with the worst status and warns on a missing story', () => {
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: { md: { lint: 'grep -L story_id {{path}} | grep -q . && exit 3 || exit 0' } },
      language_dispatch: { lint: { '.md': 'md' } },
    },
  });
  addFeature(backlog, ['S-1', 'S-9']);
  const r = runBl(['lint', '--story', 'F-1'], { cwd: backlog });
  // The feature file has no story_id, so the lint plugin fails on it.
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /F-1 lists S-9, which was not found — skipped/);
});

test('bl format --story F-<n> refuses an unknown feature', () => {
  const { backlog } = buildBacklogStory();
  const r = runBl(['format', '--story', 'F-7'], { cwd: backlog });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Feature F-7 not found/);
});

test('bl format requires --story unless --no-story is given', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const r = runBl(['format'], { cwd: dir });
    assert.equal(r.status, 2, 'should exit non-zero without --story');
    assert.match(r.stderr, /--story <id> is required/);
  } finally {
    cleanup();
  }
});

test('bl format runs the registered plugin against the backlog story file', () => {
  const { backlog } = buildBacklogStory();
  const r = runBl(['format', '--story', 'S-1'], { cwd: backlog });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /backlog: 1 files via 1 plugin\(s\)/);
});

test("bl format does not require the story's implementation worktree", () => {
  const { backlog } = buildBacklogStory({
    storyFrontmatter: 'primary_repo: code\n',
  });
  const r = runBl(['format', '--story', 'S-1'], { cwd: backlog });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no worktree/);
});

test('bl format reports when no plugin is registered for markdown', () => {
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: { py: { format: 'true {{path}}' } },
      language_dispatch: { format: { '.py': 'py' } },
    },
  });
  const r = runBl(['format', '--story', 'S-1'], { cwd: backlog });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /backlog: no configured format plugin for \.md/);
});

test('bl lint reports when no lint plugin is registered for markdown', () => {
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: { md: { format: 'true {{path}}' } },
      language_dispatch: { format: { '.md': 'md' } },
    },
  });
  const r = runBl(['lint', '--story', 'S-1'], { cwd: backlog });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /backlog: no configured lint plugin for \.md/);
});

test('bl lint surfaces non-zero plugin exit for the backlog story file', () => {
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: { md: { lint: 'false {{path}}' } },
      language_dispatch: { lint: { '.md': 'md' } },
    },
  });
  const r = runBl(['lint', '--story', 'S-1'], { cwd: backlog });
  assert.notEqual(r.status, 0, 'lint should fail when plugin returns non-zero');
});

test('bl format --no-story without paths errors clearly', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const r = runBl(['format', '--no-story'], { cwd: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /requires at least one path/);
  } finally {
    cleanup();
  }
});

test('bl format exits non-zero in explicit context when binary is missing', () => {
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: {
        md: { format: 'this-binary-does-not-exist-440 {{path}}' },
      },
      language_dispatch: { format: { '.md': 'md' } },
    },
  });
  const r = runBl(['format', '--story', 'S-1'], { cwd: backlog });
  assert.notEqual(r.status, 0, 'explicit bl format must fail on missing tool');
  assert.match(r.stderr, /command not found/);
});

test('bl format multi-plugin same-extension cascade runs both plugins', () => {
  const tmp = mkTempDir('bl-fmt-cascade-');
  const markerDefault = join(tmp, 'default-ran');
  const markerExtra = join(tmp, 'extra-ran');
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: {
        md: { format: `sh -c 'echo md > ${markerDefault}; true' {{path}}` },
        'extra-md': {
          format: `sh -c 'echo extra > ${markerExtra}; true' {{path}}`,
          extensions: ['.md'],
        },
      },
      language_dispatch: { format: { '.md': 'md' } },
    },
    storyFrontmatter: 'primary_repo: code\nplugins-format: [extra-md]\n',
  });

  const r = runBl(['format', '--story', 'S-1'], { cwd: backlog });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(markerDefault), 'default md plugin should have run');
  assert.ok(existsSync(markerExtra), 'cascaded extra-md plugin should have run');
  assert.match(r.stderr, /backlog: \d+ files via 2 plugin\(s\)/);
});

test('bl format warns when a cascade-added plugin contributes no extensions', () => {
  const { backlog } = buildBacklogStory({
    pluginsConfig: {
      plugins: {
        md: { format: 'true {{path}}' },
        dud: { format: 'true {{path}}' },
      },
      language_dispatch: { format: { '.md': 'md' } },
    },
    storyFrontmatter: 'primary_repo: code\nplugins-format: [dud]\n',
  });

  const r = runBl(['format', '--story', 'S-1'], { cwd: backlog });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /cascade plugin 'dud' for stage 'format' contributed no extensions/);
});

test('bl format scoped invocation drops paths outside the backlog repo', () => {
  const { backlog, storyPath } = buildBacklogStory();
  const r = runBl(['format', '--story', 'S-1', storyPath, '/tmp/definitely-outside-this-backlog-440.md'], {
    cwd: backlog,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /backlog: 1 files via 1 plugin\(s\)/);
  assert.doesNotMatch(r.stderr, /definitely-outside/);
});

test('bl format exits non-zero when explicit story paths are outside backlog', () => {
  const { backlog } = buildBacklogStory();
  const r = runBl(['format', '--story', 'S-1', '/tmp/definitely-outside-this-backlog-440.md'], { cwd: backlog });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /explicit paths must be inside the backlog repo/);
});
