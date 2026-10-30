/**
 * Integration test for `bl review S-n`: the loop's review step for a story
 * (F-35 decision I), with its PRs read from the change document and the
 * forge op `change.find`, keyed by repo and branch (F-42 D4).
 *
 * Drives `cmdReviewStory` end-to-end against a tempdir backlog: real git repos
 * (so `findExistingWorktree` and the main sync work) and a forge plugin stubbed
 * with a recorder shim, as in `test/integration/forge-cleanup.test.js`. The
 * runner is the real one with its agent sessions replaced: the dimension
 * passes write findings files and the verifier writes a session into the
 * story's Review Log, as the review agent would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { extractSection, readAllFeatures } from '../../src/feature.js';
import { defaultRunner, REVIEW_DIMENSIONS } from '../../src/feature-run.js';
import { appendSection, parseChange, serializeChange } from '../../src/change-doc.js';
import { cmdReview, cmdReviewStory } from '../../src/feature-cmd.js';
import { AGENT_CONFIG, mkTempDir, reposConfig } from '../helpers/tempdir.js';

function writeJsonShim(dir) {
  const path = join(dir, 'shim.mjs');
  writeFileSync(
    path,
    `import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
if (process.env.RECORDER_LOG) {
  appendFileSync(process.env.RECORDER_LOG, process.argv.slice(2).join(' ') + '\\n');
}
const queue = process.env.RECORDER_QUEUE;
if (queue && existsSync(queue)) {
  const lines = readFileSync(queue, 'utf8').split('\\n').filter(Boolean);
  if (lines.length > 0) {
    process.stdout.write(lines[0]);
    writeFileSync(queue, lines.slice(1).join('\\n') + (lines.length > 1 ? '\\n' : ''));
  }
} else if (process.env.RECORDER_STDOUT) {
  process.stdout.write(process.env.RECORDER_STDOUT);
}
`,
  );
  return path;
}

const GIT = 'git -c user.email=t@t -c user.name=t';

function initRepo(path) {
  mkdirSync(path, { recursive: true });
  execSync('git init -q -b main', { cwd: path, stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`${GIT} commit --allow-empty -q -m init`, { cwd: path, stdio: ['ignore', 'pipe', 'pipe'] });
}

function addWorktree(repoPath, worktreePath, branchName) {
  mkdirSync(worktreePath, { recursive: true });
  execSync(`git worktree add -q -b "${branchName}" "${worktreePath}" main`, {
    cwd: repoPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildBacklog({ repoNames, plugins, withWorktreeFor = repoNames, backlogJsonExtra = {} }) {
  const tmp = mkTempDir('bl-review-int-');
  const backlog = join(tmp, 'backlog');
  const worktreesBase = join(tmp, 'worktrees');
  mkdirSync(backlog, { recursive: true });
  mkdirSync(worktreesBase, { recursive: true });

  const repos = {};
  for (const name of repoNames) {
    const p = join(tmp, name);
    initRepo(p);
    repos[name] = p;
  }

  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      backlog: 'backlog',
      worktrees: worktreesBase,
      ...AGENT_CONFIG,
      repos: reposConfig(Object.values(repos)),
      plugins: { github: plugins },
      forge: 'github',
      ...backlogJsonExtra,
    }),
  );

  const componentDir = join(backlog, 'components', 'C00-test');
  mkdirSync(componentDir, { recursive: true });
  // The story's repo is its component's (F-52 D1): the first repo.
  writeFileSync(join(componentDir, 'index.md'), `---\ncomponent_id: C00\ntitle: Test\nrepo: ${repoNames[0]}\n---\n`);
  const sDir = join(backlog, 'stories', 'S99-test-review');
  mkdirSync(sDir, { recursive: true });
  const storyPath = join(sDir, 'index.md');
  writeFileSync(
    storyPath,
    `---
component: C00
story_id: S-99
title: Test Review
status: in_progress
points: 3
${repoNames.length > 1 ? `primary_repo: ${repoNames[1]}\nsecondary_repos: [${repoNames.slice(1).join(', ')}]\n` : ''}---

# Test Review

## Acceptance Criteria

- [x] it works

## To Do

None.
`,
  );

  const branch = 's99-test-review';
  const worktrees = {};
  for (const name of withWorktreeFor) {
    const wt = join(worktreesBase, branch, name);
    addWorktree(repos[name], wt, branch);
    worktrees[name] = wt;
  }

  return { tmp, backlog, repos, worktrees, branch, storyPath };
}

/**
 * The real runner (shell, git) with the review agent's sessions simulated:
 * each dimension pass writes its findings file, and the verifier prepends one
 * session to the Review Log of the change document it is given
 * (`changeAbsPath`) and advances its `review_round` by one.
 */
function reviewRunner(storyPath, { status = 'pending' } = {}) {
  const sessions = [];
  const real = defaultRunner();
  return {
    ...real,
    sessions,
    session(o) {
      sessions.push({ prompt: o.promptName, agent: o.agent, mode: o.mode, worktreePath: o.worktreePath, vars: o.vars });
      if (o.promptName === 'review-verify') {
        assert.equal(o.vars.changeAbsPath, changeOf(storyPath));
        const doc = parseChange(readFileSync(o.vars.changeAbsPath, 'utf8'));
        const next = Number(doc.fm.review_round || 0) + 1;
        doc.fm.review_round = String(next);
        doc.fm.review_status = status;
        const item = status === 'pending' ? '- [ ] invariant X — Repro: y. Test: z.' : 'None.';
        const block = `### Session 2026-10-07 (PR #${o.vars.prNumber})\n\n**Must fix**\n\n${item}\n\n**Should fix**\n\nNone.\n\n**Nits**\n\nNone.\n`;
        doc.body = appendSection(doc.body, 'Review Log', block);
        writeFileSync(o.vars.changeAbsPath, serializeChange(doc));
      } else {
        writeFileSync(o.vars.findingsPath, `# ${o.vars.dimension}\n\nNone.\n`);
      }
      return { ok: true, output: '', isError: false, usage: null };
    },
    listContainers: () => null,
    notify() {},
    log() {},
  };
}

/** The story's change document, beside its index.md. */
function changeOf(storyPath) {
  return join(dirname(storyPath), 'change.md');
}

/** Edit the story's change document through `fn(doc)`, creating it when missing. */
function editChange(storyPath, fn) {
  const p = changeOf(storyPath);
  const doc = existsSync(p)
    ? parseChange(readFileSync(p, 'utf8'))
    : parseChange(
        '---\nchange_of: S-99\nstatus: open\nreview_round: 0\nreview_status:\nrepos:\n---\n\n## Review Log\n',
      );
  fn(doc);
  writeFileSync(p, serializeChange(doc));
}

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    void rest;
    captured += String(chunk);
    return true;
  };
  const restore = () => {
    process.stderr.write = orig;
  };
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        restore();
        return { value, stderr: captured };
      },
      (err) => {
        restore();
        return { error: err, stderr: captured };
      },
    );
}

function captureExit(fn) {
  const origExit = process.exit;
  let exited = null;
  process.exit = (code) => {
    exited = code ?? 0;
    throw new Error(`__test_exit__:${exited}`);
  };
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => ({ value, exit: exited }),
      (err) => (err.message?.startsWith('__test_exit__:') ? { exit: exited } : { error: err, exit: exited }),
    )
    .finally(() => {
      process.exit = origExit;
    });
}

/**
 * `bl review S-99` with `args`, the backlog at `backlog`, and the forge
 * answering from `env` (RECORDER_STDOUT or RECORDER_QUEUE). Returns
 * `{ exit, stderr, error }`.
 */
async function review(backlog, { args = {}, env = {}, runner = null, agent } = {}) {
  process.env.BL_BACKLOG_DIR = backlog;
  Object.assign(process.env, env);
  try {
    // As `bl review` loads it: -A replaces the review list (F-64 D2).
    const config = loadConfig({ backlogRoot: backlog, agent, agentRole: 'review' });
    const story = readAllStories(config).find((s) => s.id === 'S-99');
    const r = await captureStderr(() =>
      captureExit(() => cmdReviewStory({ positional: ['S-99'], ...args }, config, story, { runner })),
    );
    return { exit: r.value?.exit, stderr: r.stderr, error: r.value?.error ?? r.error };
  } finally {
    delete process.env.BL_BACKLOG_DIR;
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

const SHIM_DIR = mkTempDir('bl-review-shim-');
const SHIM_PATH = writeJsonShim(SHIM_DIR);

// `change.open`: logs its title and body to `$OPEN_LOG` and prints a PR URL.
const OPEN_SHIM = join(SHIM_DIR, 'open.mjs');
writeFileSync(
  OPEN_SHIM,
  `import { writeFileSync } from 'fs';
writeFileSync(process.env.OPEN_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write('https://x/pr/321\\n');
`,
);

const STD_PLUGIN = {
  'change.find': `node ${SHIM_PATH} {{branch}}`,
};

const ONE_PR = (branch, number = 100) =>
  JSON.stringify([
    {
      number,
      url: `https://x/pr/${number}`,
      state: 'OPEN',
      headRefOid: 'abc',
    },
  ]);

function queueFile(lines) {
  const p = join(SHIM_DIR, `queue-${Date.now()}-${Math.random()}`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('bl review S-n: two dimension passes and the verifier on the review agent, one session, review_round up by one', async () => {
  const { backlog, worktrees, branch, storyPath } = buildBacklog({
    repoNames: ['repoA'],
    plugins: STD_PLUGIN,
    backlogJsonExtra: { agent: [{ agent: 'claude' }], review_agent: [{ agent: 'codex' }] },
  });
  const runner = reviewRunner(storyPath);
  const { exit, stderr, error } = await review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner });
  assert.equal(error, undefined, error?.stack);
  assert.equal(exit, 0, stderr);
  assert.deepEqual(
    runner.sessions.map((s) => s.prompt),
    [...REVIEW_DIMENSIONS.map((d) => `review-${d}`), 'review-verify'],
  );
  for (const s of runner.sessions) {
    assert.equal(s.agent, 'codex', `${s.prompt} runs on the review agent`);
    assert.equal(s.mode, 'review');
    assert.equal(s.worktreePath, worktrees.repoA);
    assert.equal(s.vars.unitKind, 'story');
    assert.equal(s.vars.deferredHeading, 'To Do');
    assert.equal(s.vars.featureAbsPath, storyPath, 'the story file stands in for the feature file');
    assert.equal(s.vars.prNumber, '100');
  }
  const { fm, body } = parseChange(readFileSync(changeOf(storyPath), 'utf8'));
  assert.equal(fm.review_round, '1');
  assert.equal(fm.review_status, 'pending');
  assert.deepEqual(
    parseChange(readFileSync(changeOf(storyPath), 'utf8')).repos,
    [{ repo: 'repoA', branch, pr: '100', url: 'https://x/pr/100', merged: '' }],
    "the PR is recorded in the story's change document",
  );
  assert.equal((extractSection(body, 'Review Log').match(/^### Session/gm) ?? []).length, 1);
  const story = parseFrontmatter(readFileSync(storyPath, 'utf8'));
  for (const k of ['branch', 'pr', 'review_round', 'review_status'])
    assert.equal(story.fm[k], undefined, `no ${k}: on the story`);
  assert.equal(extractSection(story.body, 'Review Log'), null);
  assert.match(stderr, /Review round 1: pending/);
});

test('bl review S-n: a second round re-reviews and advances the round again', async () => {
  const { backlog, branch, storyPath } = buildBacklog({ repoNames: ['repoA'], plugins: STD_PLUGIN });
  await review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner: reviewRunner(storyPath) });
  editChange(storyPath, (doc) => {
    doc.fm.review_status = 'fixed';
  });
  const runner = reviewRunner(storyPath, { status: 'addressed' });
  const { exit } = await review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner });
  assert.equal(exit, 0);
  assert.equal(runner.sessions[0].vars.reReview, 'true');
  const after = parseChange(readFileSync(changeOf(storyPath), 'utf8'));
  assert.equal(after.fm.review_round, '2');
  assert.equal(after.fm.review_status, 'addressed');
  assert.equal((extractSection(after.body, 'Review Log').match(/^### Session/gm) ?? []).length, 2);
});

test('bl review S-n: refuses at the review round cap', async () => {
  const { backlog, branch, storyPath } = buildBacklog({ repoNames: ['repoA'], plugins: STD_PLUGIN });
  editChange(storyPath, (doc) => {
    doc.fm.review_round = '2';
  });
  const runner = reviewRunner(storyPath);
  const { exit, stderr } = await review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner });
  assert.equal(exit, 1);
  assert.match(stderr, /review round cap \(2\) already reached at round 2/);
  assert.equal(runner.sessions.length, 0);
});

test("bl review S-n reviews only its component's repo, whatever repo fields the story names", async () => {
  // The story names repoB in a leftover primary_repo and secondary_repos, and repoB has a worktree.
  const { backlog, worktrees, branch, storyPath } = buildBacklog({
    repoNames: ['repoA', 'repoB'],
    plugins: STD_PLUGIN,
  });
  const runner = reviewRunner(storyPath);
  const log = join(SHIM_DIR, `argv-${Date.now()}-${Math.random()}.log`);
  const { exit, stderr } = await review(backlog, {
    env: { RECORDER_STDOUT: ONE_PR(branch, 1), RECORDER_LOG: log },
    runner,
  });
  assert.equal(exit, 0, stderr);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'one repo searched');
  const verify = runner.sessions.at(-1);
  assert.equal(verify.worktreePath, worktrees.repoA);
  assert.equal(verify.vars.prNumber, '1');
  assert.doesNotMatch(verify.vars.reviewScope, /repoB/);
  assert.deepEqual(
    parseChange(readFileSync(changeOf(storyPath), 'utf8')).repos.map((r) => [r.repo, r.branch, r.pr]),
    [['repoA', branch, '1']],
  );
});

test('bl review S-n --repo is refused as an unknown option', async () => {
  const { backlog, branch, storyPath } = buildBacklog({ repoNames: ['repoA'], plugins: STD_PLUGIN });
  const runner = reviewRunner(storyPath);
  const { exit, stderr } = await review(backlog, {
    args: { repo: 'repoA' },
    env: { RECORDER_STDOUT: ONE_PR(branch, 7) },
    runner,
  });
  assert.equal(exit, 1);
  assert.match(stderr, /bl review: unknown option "--repo" for a story: a story's repo is its component's\./);
  assert.equal(runner.sessions.length, 0);
});

test('bl review S-n: no PR → error names the repo searched', async () => {
  const { backlog, storyPath } = buildBacklog({
    repoNames: ['repoA', 'repoB'],
    plugins: STD_PLUGIN,
  });
  const runner = reviewRunner(storyPath);
  const { exit, stderr } = await review(backlog, { env: { RECORDER_STDOUT: '[]' }, runner });
  assert.equal(exit, 1);
  assert.match(stderr, /No open PR found for story S-99\./);
  assert.match(stderr, /repoA.*no PR/);
  assert.doesNotMatch(stderr, /repoB/);
  assert.equal(runner.sessions.length, 0);
});

test('bl review S-n: the PR recorded in the change document is the one reviewed', async () => {
  const { backlog, branch, storyPath } = buildBacklog({ repoNames: ['repoA'], plugins: STD_PLUGIN });
  editChange(storyPath, (doc) => {
    doc.repos = [{ repo: 'repoA', branch, pr: '50', url: 'https://x/pr/50', merged: '' }];
  });
  const runner = reviewRunner(storyPath);
  const log = join(SHIM_DIR, `argv-${Date.now()}-${Math.random()}.log`);
  const { exit, stderr } = await review(backlog, {
    env: { RECORDER_STDOUT: ONE_PR(branch, 51), RECORDER_LOG: log },
    runner,
  });
  assert.equal(exit, 0, stderr);
  assert.equal(runner.sessions.at(-1).vars.prNumber, '50');
  // Asked by branch, never by title.
  assert.equal(readFileSync(log, 'utf8').trim(), branch);
});

test('bl review S-n: a branch with commits and no PR gets one opened through change.open', async () => {
  const { tmp, backlog, repos, worktrees, branch, storyPath } = buildBacklog({
    repoNames: ['repoA'],
    plugins: {
      ...STD_PLUGIN,
      'change.open': `node ${OPEN_SHIM} {{title}} {{body}}`,
    },
  });
  const upstream = join(tmp, 'upstream-repoA.git');
  execSync(`git init -q --bare "${upstream}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git -C "${repos.repoA}" remote add origin "${upstream}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(worktrees.repoA, 'work.txt'), 'work\n');
  execSync(`git add work.txt && ${GIT} commit -q -m work`, { cwd: worktrees.repoA, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = join(SHIM_DIR, `open-${Date.now()}-${Math.random()}.log`);
  const runner = reviewRunner(storyPath);
  const { exit, stderr } = await review(backlog, { env: { RECORDER_STDOUT: '[]', OPEN_LOG: log }, runner });
  assert.equal(exit, 0, stderr);
  assert.match(stderr, /repoA: opened PR #321 — https:\/\/x\/pr\/321/);
  const [title, body] = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(title, 'S-99: Test Review');
  assert.match(body, /^Story S-99: Test Review \(3 pts\)\n\nStory file: stories\/S99-test-review\/index\.md\n/);
  // The branch was pushed first, and the PR is recorded and reviewed.
  assert.equal(
    execSync(`git -C "${upstream}" rev-parse ${branch}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    execSync('git rev-parse HEAD', {
      cwd: worktrees.repoA,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
  );
  assert.deepEqual(
    parseChange(readFileSync(changeOf(storyPath), 'utf8')).repos.map((r) => [r.repo, r.pr, r.url]),
    [['repoA', '321', 'https://x/pr/321']],
  );
  assert.equal(runner.sessions.at(-1).vars.prNumber, '321');
});

test('bl review S-n: missing worktree for a found PR is a fatal error naming the repo', async () => {
  const { backlog, storyPath } = buildBacklog({
    repoNames: ['repoA'],
    plugins: STD_PLUGIN,
    withWorktreeFor: [],
  });
  const runner = reviewRunner(storyPath);
  const { exit, stderr } = await review(backlog, {
    env: {
      RECORDER_STDOUT: JSON.stringify([
        { number: 9, url: 'u9', state: 'OPEN', headRefName: 'x', updatedAt: '2026-05-10' },
      ]),
    },
    runner,
  });
  assert.equal(exit, 1);
  assert.match(stderr, /Found PR #9 in repoA but no worktree for branch/i);
  assert.match(stderr, /Run `bl implement S-99` first\./);
  assert.equal(runner.sessions.length, 0);
});

test('bl review S-n: a branch that conflicts with main exits pointing at bl implement', async () => {
  const { backlog, repos, worktrees, branch, storyPath } = buildBacklog({ repoNames: ['repoA'], plugins: STD_PLUGIN });
  writeFileSync(join(worktrees.repoA, 'a.txt'), 'branch\n');
  execSync(`git add a.txt && ${GIT} commit -q -m branch`, { cwd: worktrees.repoA, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(repos.repoA, 'a.txt'), 'main\n');
  execSync(`git add a.txt && ${GIT} commit -q -m main`, { cwd: repos.repoA, stdio: ['ignore', 'pipe', 'pipe'] });
  const runner = reviewRunner(storyPath);
  const { exit, stderr } = await review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner });
  assert.equal(exit, 1);
  assert.match(
    stderr,
    /Branch s99-test-review in repoA conflicts with main \(the merge was aborted\)\. Run `bl implement S-99` to merge and resolve, then review\./,
  );
  assert.equal(runner.sessions.length, 0);
  assert.ok(!existsSync(changeOf(storyPath)), 'no round spent, nothing recorded');
});

test('bl review S-n: a closed story is refused', async () => {
  const { backlog, branch, storyPath } = buildBacklog({ repoNames: ['repoA'], plugins: STD_PLUGIN });
  writeFileSync(storyPath, readFileSync(storyPath, 'utf8').replace('status: in_progress', 'status: done'));
  const { exit, stderr } = await review(backlog, {
    env: { RECORDER_STDOUT: ONE_PR(branch) },
    runner: reviewRunner(storyPath),
  });
  assert.equal(exit, 1);
  assert.match(stderr, /Story S-99 is done; nothing to review\./);
});

// ---------------------------------------------------------------------------
// review_agent — reviews run on a different provider than implementation
// ---------------------------------------------------------------------------

test('bl review S-n: -A replaces the review list', async () => {
  const { backlog, branch, storyPath } = buildBacklog({
    repoNames: ['repoA'],
    plugins: STD_PLUGIN,
    backlogJsonExtra: { review_agent: [{ agent: 'codex' }] },
  });
  const runner = reviewRunner(storyPath);
  await review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner, agent: 'claude' });
  assert.ok(runner.sessions.length > 0);
  for (const s of runner.sessions) assert.equal(s.agent, 'claude');
});

test("bl review S-n: reviews run on the first review_agent configuration, not on agent's", async () => {
  const { backlog, branch, storyPath } = buildBacklog({
    repoNames: ['repoA'],
    plugins: STD_PLUGIN,
    backlogJsonExtra: {
      agent: [{ agent: 'claude', model: 'opus' }],
      review_agent: [{ agent: 'codex' }, { agent: 'claude', model: 'sonnet' }],
    },
  });
  const runner = reviewRunner(storyPath);
  await review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner });
  assert.ok(runner.sessions.length > 0);
  for (const s of runner.sessions) assert.equal(s.agent, 'codex');
});

test('bl review S-n: an unknown review_agent provider is a config error, and -A naming one is fatal', async () => {
  const { backlog, branch, storyPath } = buildBacklog({
    repoNames: ['repoA'],
    plugins: STD_PLUGIN,
    backlogJsonExtra: { review_agent: [{ agent: 'clippy' }] },
  });
  assert.throws(
    () => loadConfig({ backlogRoot: backlog }),
    /"review_agent"\[0\] "agent" must be a registered provider \(claude, codex, gemini\), not "clippy"/,
  );
  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      ...JSON.parse(readFileSync(join(backlog, 'backlog.json'), 'utf8')),
      review_agent: [{ agent: 'codex' }],
    }),
  );
  const runner = reviewRunner(storyPath);
  // -A is checked when the config loads, like a list entry; bl.js prints the
  // error and exits 1.
  await assert.rejects(
    review(backlog, { env: { RECORDER_STDOUT: ONE_PR(branch) }, runner, agent: 'clippy' }),
    /^Error: -A must name a registered provider \(claude, codex, gemini\), not "clippy"$/,
  );
  assert.equal(runner.sessions.length, 0, 'no session may start');
});

// ---------------------------------------------------------------------------
// S-788: a PR that merged before review
// ---------------------------------------------------------------------------

async function runNoOpenPR({ plugins, queue }) {
  const { backlog, storyPath } = buildBacklog({ repoNames: ['repoA'], plugins });
  return review(backlog, { env: { RECORDER_QUEUE: queueFile(queue) }, runner: reviewRunner(storyPath) });
}

test("bl review S-n: change.find lists the branch's PR as merged → says it merged before review", async () => {
  const { exit, stderr } = await runNoOpenPR({
    plugins: STD_PLUGIN,
    queue: [JSON.stringify([{ number: 46, url: 'https://x/pr/46', state: 'MERGED', headRefOid: '0123456789abcdef' }])],
  });
  assert.equal(exit, 1);
  assert.match(stderr, /repoA: PR #46 \(https:\/\/x\/pr\/46\) already merged at 0123456; it was merged before review/);
  assert.match(stderr, /Review was skipped: the PR merged first\. See S-789/);
  assert.doesNotMatch(stderr, /it opens the PR/);
});

test('bl review S-n: no open and no merged PR, nothing to push → says to push and review again', async () => {
  const { exit, stderr } = await runNoOpenPR({
    plugins: STD_PLUGIN,
    queue: ['[]'],
  });
  assert.equal(exit, 1);
  assert.match(stderr, /repoA: worktree present, no PR/);
  assert.match(stderr, /Commit and push the branch, then run `bl review S-99` again: it opens the PR\./);
  assert.doesNotMatch(stderr, /merged/);
});

test("bl review S-n: change.find not configured → the forge's reason is reported", async () => {
  const { exit, stderr } = await runNoOpenPR({
    plugins: { 'change.close': 'true' },
    queue: [],
  });
  assert.equal(exit, 1);
  assert.match(stderr, /repoA: worktree present, forge no-op/);
});

test('bl review F-n --repo keeps the lead repo first in the change document', async () => {
  // F-52 D3: reviewing one repo of a feature must not move it ahead of the
  // lead, or the feature's branch and PR are read off the wrong entry.
  const { backlog, repos } = buildBacklog({ repoNames: ['repoA', 'repoB'], plugins: STD_PLUGIN, withWorktreeFor: [] });
  const branch = 'f1-feat';
  for (const name of ['repoA', 'repoB'])
    addWorktree(repos[name], join(dirname(backlog), 'worktrees', branch, name), branch);
  const write = (rel, text) => {
    mkdirSync(dirname(join(backlog, rel)), { recursive: true });
    writeFileSync(join(backlog, rel), text);
  };
  write('components/C01-b/index.md', '---\ncomponent_id: C01\ntitle: B\nrepo: repoB\n---\n');
  for (const [n, c] of [
    ['1', 'C00'],
    ['2', 'C01'],
  ]) {
    write(
      `stories/S${n}-s${n}/index.md`,
      `---\ncomponent: C00\nstory_id: S-${n}\ntitle: S${n}\nstatus: in_progress\npoints: 1\nfeature: F-1\n---\n\n# S${n}\n`.replace(
        'C00',
        c,
      ),
    );
  }
  const featurePath = join(backlog, 'features', 'F1-feat', 'index.md');
  write(
    'features/F1-feat/index.md',
    '---\nfeature_id: F-1\ntitle: Feat\nstatus: running\nstories: [S-1, S-2]\npoints: 0\nreview_rounds_max: 2\n---\n\n# F-1 · Feat\n',
  );
  const entry = (repo, pr) =>
    `  - repo: ${repo}\n    branch: ${branch}\n    pr: ${pr}\n    url: https://x/pr/${pr}\n    merged:\n`;
  write(
    'features/F1-feat/change.md',
    `---\nchange_of: F-1\nstatus: open\nreview_round: 0\nreview_status:\nrepos:\n${entry('repoA', 100)}${entry('repoB', 200)}---\n\n# F-1\n\n## Review Log\n\nNo reviews yet.\n`,
  );
  const runner = reviewRunner(featurePath);
  process.env.BL_BACKLOG_DIR = backlog;
  process.env.RECORDER_STDOUT = ONE_PR(branch, 200);
  try {
    const config = loadConfig({ backlogRoot: backlog });
    const feature = readAllFeatures(config).find((f) => f.id === 'F-1');
    const r = await captureStderr(() =>
      captureExit(() => cmdReview({ positional: ['F-1'], repo: 'repoB' }, config, feature, { runner })),
    );
    assert.equal(r.value?.exit, 0, r.stderr);
  } finally {
    delete process.env.BL_BACKLOG_DIR;
    delete process.env.RECORDER_STDOUT;
  }
  assert.equal(runner.sessions.at(-1).vars.prNumber, '200');
  assert.deepEqual(
    parseChange(readFileSync(changeOf(featurePath), 'utf8')).repos.map((r) => [r.repo, r.pr]),
    [
      ['repoA', '100'],
      ['repoB', '200'],
    ],
  );
});
