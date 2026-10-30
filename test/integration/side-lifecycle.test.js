/**
 * Integration test for the side-change lifecycle (F-48 Acceptance 1 and 2),
 * end to end on real git repos with origins:
 *
 * - side_feature_lifecycle_two_repos: a story session of a running feature
 *   calls `bl side` for a second repo; the run (bl's own loop, with the agent
 *   sessions and the forge faked, every git and gate command real) gates
 *   both repos, opens both PRs and reviews both; `bl merge F-n` then merges
 *   both repos, records both merge commits and marks the side story done.
 * - standalone_side_batch_merge_clears_inbox: three standalone side stories
 *   show in `bl inbox` as `change` once their branches have commits, and one
 *   `bl merge S-a S-b S-c` lands all three and clears them.
 *
 * No main checkout leaves `main` in either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { parseChange, serializeChange } from '../../src/change-doc.js';
import { findFeature, normalizeFeatureId } from '../../src/feature.js';
import { prepareFeatureWorktree } from '../../src/feature-cmd.js';
import { defaultRunner, runFeature } from '../../src/feature-run.js';
import { runBl } from '../helpers/run-bl.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { git, initGitBacklog } from '../helpers/git-backlog.js';

const DONE = '## Acceptance Criteria\n\n- [x] done\n';
const fmOf = (path) => parseFrontmatter(readFileSync(path, 'utf8')).fm;

/**
 * repoA and repoB, each a git repo on `main` with a bare origin. Components
 * C00 (repoA's home) and C01 (repoB's home). F-1 runs S-1 (repoA) on f1-run;
 * S-3 is a standalone story. The backlog is a git repo with a clean tree.
 */
function build() {
  const tmp = mkTempDir('bl-side-life-');
  const repos = {};
  for (const name of ['repoA', 'repoB']) {
    const origin = join(tmp, `${name}.git`);
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const r = join(tmp, name);
    mkdirSync(r, { recursive: true });
    git(r, 'init', '-q', '-b', 'main');
    git(r, 'remote', 'add', 'origin', origin);
    writeFileSync(join(r, 'base.txt'), 'base\n');
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'base');
    git(r, 'push', '-q', 'origin', 'main');
    repos[name] = r;
  }
  const { dir } = mkTempBacklog({
    repos: { repoA: { path: repos.repoA }, repoB: { path: repos.repoB } },
    config: { worktrees: join(tmp, 'worktrees') },
    components: [
      { id: 'C00', title: 'A', dirSuffix: 'a', repo: 'repoA', home: true },
      { id: 'C01', title: 'B', dirSuffix: 'b', repo: 'repoB', home: true },
    ],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'One',
        dirSuffix: 'one',
        feature: 'F-1',
        status: 'in_progress',
        body: '## Acceptance Criteria\n\n- [ ] one\n',
      },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three', status: 'in_progress' },
    ],
    features: [{ id: 'F-1', title: 'Run', dirSuffix: 'run', status: 'running', stories: ['S-1'], branch: 'f1-run' }],
  });
  initGitBacklog(dir);
  const mainBranches = () =>
    Object.fromEntries(Object.entries(repos).map(([n, r]) => [n, git(r, 'branch', '--show-current')]));
  return { tmp, dir, repos, mainBranches };
}

/** A commit of `file` in the worktree at `wt`. */
function commitIn(wt, file, text) {
  writeFileSync(join(wt, file), text);
  git(wt, 'add', file);
  git(wt, 'commit', '-q', '-m', `add ${file}`);
}

/** The change document at `path` with a clean review session and `review_status: addressed`. */
function markAddressed(path, round) {
  const doc = parseChange(readFileSync(path, 'utf8'));
  doc.fm.review_round = String(round);
  doc.fm.review_status = 'addressed';
  const block = `### Session 2026-10-26 r${round}\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n`;
  doc.body = doc.body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
  writeFileSync(path, serializeChange(doc));
}

test('side_feature_lifecycle_two_repos: bl side in a story session, then the run gates, PRs and reviews both repos, and bl merge lands both', async () => {
  const { tmp, dir, repos, mainBranches } = build();
  const config = loadConfig({ backlogRoot: dir });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const prep = prepareFeatureWorktree(config, feature);
  const changePath = join(dir, 'features', 'F1-run', 'change.md');

  let side = null;
  let round = 0;
  const calls = [];
  const real = defaultRunner();
  const runner = {
    ...real,
    log() {},
    notify() {},
    listContainers: () => null,
    testPlugins: () => ({ plugins: [{ name: 'check', command: 'git status --porcelain' }], unknown: [] }),
    shell(cmd, cwd, o) {
      calls.push({ type: 'shell', cmd, cwd });
      return real.shell(cmd, cwd, o);
    },
    forge(op, vars, { repoPath }) {
      calls.push({ type: 'forge', op, repoPath });
      const repo = repoPath.includes(`${join('f1-run', 'repoB')}`) ? 'repoB' : 'repoA';
      if (op === 'change.open')
        return { configured: true, status: 0, stdout: `https://forge.test/${repo}/pull/${repo === 'repoB' ? 2 : 1}\n` };
      if (op === 'change.describe') return { configured: true, status: 0 };
      return { configured: false, reason: 'no-forge' };
    },
    session(o) {
      calls.push({ type: 'session', prompt: o.promptName, story: o.vars.storyId, vars: o.vars });
      if (o.promptName === 'feature-story' && o.vars.storyId === 'S-1') {
        commitIn(prep.worktreePath, 'a.txt', 'feature\n');
        writeFileSync(o.vars.storyAbsPath, readFileSync(o.vars.storyAbsPath, 'utf8').replace('- [ ] one', '- [x] one'));
        // The drive-by: a change to repoB, through bl side.
        const r = runBl(
          ['side', 'repoB', '--from', 'F-1', '--title', 'B fix', '--points', '1', '--body-file', '-', '--json'],
          { cwd: dir, input: DONE },
        );
        assert.equal(r.status, 0, r.stderr);
        side = JSON.parse(r.stdout);
        commitIn(side.worktree, 'b.txt', 'side\n');
      } else if (o.promptName.startsWith('review-') && o.promptName !== 'review-verify') {
        writeFileSync(o.vars.findingsPath, `# ${o.vars.dimension}\n\nNone.\n`);
      } else if (o.promptName === 'review-verify') {
        round += 1;
        markAddressed(changePath, round);
      }
      return { ok: true, output: '', isError: false, usage: null };
    },
  };
  const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
  assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
  assert.ok(side, 'the story session ran bl side');
  assert.equal(side.feature, 'F-1');
  const wtB = side.worktree;
  // Both repos gated, published, PR'd and reviewed.
  for (const wt of [prep.worktreePath, wtB]) {
    assert.ok(
      calls.some((c) => c.cmd === 'git status --porcelain' && c.cwd === wt),
      `gated: ${wt}`,
    );
    assert.ok(
      calls.some((c) => c.op === 'change.open' && c.repoPath === wt),
      `PR opened: ${wt}`,
    );
  }
  assert.equal(
    git(join(tmp, 'repoB.git'), 'rev-parse', 'f1-run'),
    git(wtB, 'rev-parse', 'HEAD'),
    "repoB's branch is pushed",
  );
  const reviews = calls.filter((c) => c.prompt?.startsWith('review-'));
  assert.ok(reviews.length > 0);
  for (const r of reviews)
    assert.ok(
      r.vars.reviewScope.includes(`- repoB: PR #2 https://forge.test/repoB/pull/2 — worktree ${wtB}`),
      r.vars.reviewScope,
    );
  assert.deepEqual(
    parseChange(readFileSync(changePath, 'utf8')).repos.map((e) => [e.repo, e.branch, e.pr]),
    [
      ['repoA', 'f1-run', '1'],
      ['repoB', 'f1-run', '2'],
    ],
  );
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });

  // bl merge F-1 lands both repos, records both and marks the side story done.
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const m = runBl(['merge', 'F-1'], { cwd: dir, env });
  assert.equal(m.status, 0, m.stderr);
  assert.equal(git(join(tmp, 'repoA.git'), 'show', 'main:a.txt'), 'feature');
  assert.equal(git(join(tmp, 'repoB.git'), 'show', 'main:b.txt'), 'side');
  const change = parseChange(readFileSync(changePath, 'utf8'));
  assert.equal(change.fm.status, 'merged');
  // Each repo's entry records the merge commit now on its main.
  assert.deepEqual(
    change.repos.map((e) => e.repo),
    ['repoA', 'repoB'],
  );
  for (const e of change.repos) {
    assert.match(e.merged, /^[0-9a-f]{7,}$/, e.repo);
    assert.ok(git(repos[e.repo], 'rev-parse', 'main').startsWith(e.merged), e.repo);
  }
  assert.equal(fmOf(join(dir, side.path)).status, 'done');
  assert.equal(fmOf(join(dir, 'stories', 'S1-one', 'index.md')).status, 'done');
  assert.equal(fmOf(feature.indexPath).status, 'done');
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });
});

test('standalone_side_batch_merge_clears_inbox: three standalone side stories are listed as change once they have commits, and one bl merge clears them', () => {
  const { tmp, dir, repos, mainBranches } = build();
  const made = [];
  for (const title of ['Side a', 'Side b', 'Side c']) {
    const r = runBl(
      ['side', 'repoB', '--from', 'S-3', '--title', title, '--points', '1', '--body-file', '-', '--json'],
      { cwd: dir, input: DONE },
    );
    assert.equal(r.status, 0, r.stderr);
    made.push(JSON.parse(r.stdout));
  }
  const ids = made.map((s) => s.story);
  const listed = () =>
    JSON.parse(runBl(['inbox', '--json'], { cwd: dir }).stdout)
      .filter((e) => e.kind === 'change')
      .sort((a, b) => a.id.localeCompare(b.id));
  // Nothing on the branches yet: nothing unmerged.
  assert.deepEqual(listed(), []);
  for (const s of made) commitIn(s.worktree, `${s.story}.txt`, `${s.story}\n`);
  assert.deepEqual(
    listed().map((e) => [e.id, e.next]),
    ids.map((id) => [`${id}:change`, `bl run ${id}`]),
  );

  // Reviewed and addressed (what bl run would record), the next step is bl merge.
  for (const s of made) markAddressed(join(dir, s.path.replace(/index\.md$/, 'change.md')), 1);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'reviewed');
  assert.deepEqual(
    listed().map((e) => e.next),
    ids.map((id) => `bl merge ${id}`),
  );

  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const m = runBl(['merge', ...ids], { cwd: dir, env });
  assert.equal(m.status, 0, m.stderr);
  assert.deepEqual(listed(), []);
  for (const s of made) {
    assert.equal(git(join(tmp, 'repoB.git'), 'show', `main:${s.story}.txt`), s.story);
    assert.equal(fmOf(join(dir, s.path)).status, 'done');
    const change = parseChange(readFileSync(join(dir, s.path.replace(/index\.md$/, 'change.md')), 'utf8'));
    assert.equal(change.fm.status, 'merged', s.story);
    assert.match(change.repos[0].merged, /^[0-9a-f]{7,}$/, s.story);
  }
  assert.deepEqual(mainBranches(), { repoA: 'main', repoB: 'main' });
});
