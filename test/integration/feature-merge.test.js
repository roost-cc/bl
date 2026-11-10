import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { parseChange } from '../../src/change-doc.js';
import { extractSection } from '../../src/feature.js';
import { fm, initFeatureRepo } from '../helpers/feature-fixture.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

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
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    assert.equal(logStatusOf('story', fm(join(dir, 'stories', 'S1-a', 'index.md'))), 'done');
    assert.ok(!files.some((f) => f.includes('S2-b')), `operator's story must not be committed:\n${files.join('\n')}`);
    assert.match(g(dir, 'status', '--porcelain'), /S2-b\/index\.md/);
    assert.match(readFileSync(opStory, 'utf8'), /Operator notes in progress/);
    assert.match(r.stderr, /Left your uncommitted backlog edits alone: .*S2-b/);
    const featureFm = fm(join(dir, 'features', 'F1-feat', 'index.md'));
    assert.equal(logStatusOf('feature', featureFm), 'done');
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
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], {
        cwd: origin,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).status,
      1,
      'no remote tag',
    );
    assert.equal(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).status,
      1,
      'no local tag',
    );
    assert.ok(!existsSync(join(dir, 'releases', 'F-1.json')), 'no manifest');
    assert.equal(
      logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))),
      'in_progress',
      'the feature is not done',
    );
    assert.equal(
      logStatusOf('story', fm(join(dir, 'stories', 'S1-a', 'index.md'))),
      'in_progress',
      'the story is not done',
    );
    assert.equal(g(dir, 'log', '--format=%s', '-1'), 'backlog', 'nothing committed');

    // Once the origin takes tags, the retry tags the set and completes.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const again = runBl(['merge', 'F-1'], { cwd: dir, env });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(g(origin, 'rev-parse', 'F-1^{commit}'), g(origin, 'rev-parse', 'main'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'releases', 'F-1.json'), 'utf8')).repos, {
      code: g(origin, 'rev-parse', 'main'),
    });
    assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'done');
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
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], {
        cwd: origin,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).status,
      1,
      'no remote tag',
    );
    assert.equal(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-1'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).status,
      1,
      'no local tag',
    );
    assert.ok(!existsSync(join(dir, 'releases', 'F-1.json')), 'no manifest');
    assert.equal(
      logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))),
      'in_progress',
      'the feature is not done',
    );
    assert.equal(
      logStatusOf('story', fm(join(dir, 'stories', 'S1-a', 'index.md'))),
      'in_progress',
      'the story is not done',
    );
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
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      assert.equal(logStatusOf('feature', fm(join(dir, 'features', 'F1-feat', 'index.md'))), 'in_progress');
    }
  } finally {
    cleanup();
  }
});
