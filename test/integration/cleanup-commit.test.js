/**
 * Integration tests for `bl merge`'s S-431 behaviour:
 *
 *   1. A story merges one repo, its component's (F-52 D1), and writes
 *      `commit:` as a bare string. A worktree on the story's branch in
 *      another repo is refused, naming the repo, and `--repo` is refused as
 *      an unknown option.
 *   2. `git push origin main` failure is fatal — the run exits non-zero
 *      and the story stays not-done.
 *   3. (S-864) When the story's repo is `bl` itself, the mark-done sync runs
 *      as a child of the merged checkout's `src/bl.js`, after this process
 *      released the backlog lock. The landed SHA is written to the story's
 *      `commit:` as it lands, so a re-run keeps it.
 *
 * Drives `cleanup.main()` end-to-end against tempdir backlogs with real git
 * repos (bare upstream + working clone + worktree on the story branch), so
 * the merge / push / write-frontmatter pipeline is exercised intact. The
 * forge ops are stubbed out by NOT configuring a `forge` key — `runForgeOp`
 * then returns `{ configured: false }` and the PR find/close block becomes
 * a no-op, which is fine for these tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { main as cleanupMain } from '../../src/cleanup.js';
import { endTabTitle } from '../../src/tab-title.js';
import { fakeTmux, renamedTitles } from '../helpers/fake-tmux.js';
import { withEnv } from '../helpers/fake-pagers.js';
import { parseFrontmatter } from '../../src/config.js';
import { parseChange } from '../../src/change-doc.js';
import { extractSection } from '../../src/feature.js';
import { FLOW_TEMPLATE, AGENT_CONFIG, mkTempDir, reposConfig } from '../helpers/tempdir.js';
import { statusOf as logStatusOf } from '../../src/transition.js';
import { holderOf } from '../../src/kernel-lock.js';
import { LOCK_FILE } from '../../src/lock.js';
import { unitLockPath } from '../../src/unit-lock.js';

const GIT_ENV = '-c user.email=t@t -c user.name=t';

function initRepoWithUpstream(workPath, upstreamPath) {
  mkdirSync(workPath, { recursive: true });
  mkdirSync(upstreamPath, { recursive: true });
  execSync(`git init -q --bare -b main "${upstreamPath}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git init -q -b main "${workPath}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git ${GIT_ENV} -C "${workPath}" commit --allow-empty -q -m init`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git -C "${workPath}" remote add origin "${upstreamPath}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git -C "${workPath}" push -q origin main`, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function addStoryWorktreeWithCommit(repoPath, worktreePath, branchName) {
  mkdirSync(worktreePath, { recursive: true });
  execSync(`git -C "${repoPath}" worktree add -q -b "${branchName}" "${worktreePath}" main`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(join(worktreePath, 'marker.txt'), `${branchName}\n`);
  execSync(`git ${GIT_ENV} -C "${worktreePath}" add marker.txt`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git ${GIT_ENV} -C "${worktreePath}" commit -q -m "work on ${branchName}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * A signed-off review session: `bl merge` refuses a story never reviewed
 * (F-36 D3), so every story here is reviewed unless a test says otherwise.
 */
const REVIEWED = '### Session 2026-07-08 (PR #1)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.';

/**
 * Build a temp backlog with one story and a working clone (plus bare
 * upstream and story worktree) per repo in `repoNames`.
 *
 * `pushBroken` is `true` for every repo or an array of repo names whose
 * origin is pointed at a missing path, so `git push origin main` fails there.
 * `prePushHook(repoName, { tmp, backlog })` may return a shell script to
 * install as that repo's working clone's `pre-push` hook (null for none).
 * `setupRepo(repoName, workPath, { tmp })` runs right after a repo's working
 * clone is initialised and pushed, before its story worktree is created, so
 * files it commits to main are on the story branch too.
 */
function buildStoryBacklog({
  repoNames,
  storyId = 'S-99',
  storyDirSuffix = 'test-cleanup',
  primaryRepo,
  pushBroken = false,
  prePushHook = null,
  setupRepo = null,
  reviewStatus = 'addressed',
  reviewLog = REVIEWED,
  backlogJsonExtra = {},
  initBacklogGit = false,
}) {
  const tmp = mkTempDir('bl-cleanup-int-');
  const backlog = join(tmp, 'backlog');
  const worktreesBase = join(tmp, 'worktrees');
  mkdirSync(backlog, { recursive: true });
  mkdirSync(worktreesBase, { recursive: true });

  const repos = {};
  for (const name of repoNames) {
    const work = join(tmp, 'repos', name);
    const upstream = join(tmp, 'upstream', `${name}.git`);
    initRepoWithUpstream(work, upstream);
    if (setupRepo) setupRepo(name, work, { tmp });
    const broken = Array.isArray(pushBroken) ? pushBroken.includes(name) : pushBroken;
    if (broken) {
      // Point origin at a non-existent path so `git push origin main` fails.
      execSync(`git -C "${work}" remote set-url origin "${tmp}/missing-${name}.git"`, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    repos[name] = work;
  }

  copyFileSync(FLOW_TEMPLATE, join(backlog, 'flow.json'));
  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      backlog: 'backlog',
      worktrees: worktreesBase,
      ...AGENT_CONFIG,
      repos: reposConfig(Object.values(repos)),
      ...backlogJsonExtra,
    }),
  );

  const componentDir = join(backlog, 'components', 'C00-cleanup');
  mkdirSync(componentDir, { recursive: true });
  // The story's repo is its component's (F-52 D1).
  writeFileSync(
    join(componentDir, 'index.md'),
    `---\ncomponent_id: C00\ntitle: Cleanup\nrepo: ${primaryRepo ?? repoNames[0]}\n---\n`,
  );

  const num = storyId.replace(/^S-?/, '');
  const storyDirName = `S${num}-${storyDirSuffix}`;
  const sDir = join(backlog, 'stories', storyDirName);
  mkdirSync(sDir, { recursive: true });
  const branchName = storyDirName.toLowerCase();
  const storyIndexPath = join(sDir, 'index.md');
  writeFileSync(
    storyIndexPath,
    `---
component: C00
story_id: ${storyId}
title: Test Cleanup
type: chore
points: 1
status: in_progress
---

# Test Cleanup
`,
  );
  // The review state lives in the story's change document.
  if (reviewStatus || reviewLog) {
    writeFileSync(
      join(sDir, 'change.md'),
      `---
change_of: ${storyId}
status: open
review_round: 1
review_status:${reviewStatus ? ` ${reviewStatus}` : ''}
repos:
${repoNames.map((n) => `  - repo: ${n}\n    branch: ${branchName}\n    pr: 1\n`).join('')}---

# ${storyId}

## Review Log

${reviewLog ?? ''}

## Merge
`,
    );
  }

  for (const name of repoNames) {
    const wt = join(worktreesBase, branchName, name);
    addStoryWorktreeWithCommit(repos[name], wt, branchName);
  }

  if (initBacklogGit) {
    // `buildStoryBacklog` normally leaves the backlog as a plain dir, so
    // cleanup skips its backlog commit. Init it as a git repo (with an
    // origin) so the commit runs and we can assert on it. Local user config
    // lets the commit succeed without relying on ambient global git identity.
    const backlogUpstream = join(tmp, 'upstream', 'backlog.git');
    mkdirSync(backlogUpstream, { recursive: true });
    execSync(`git init -q --bare -b main "${backlogUpstream}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`git init -q -b main "${backlog}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    // A real backlog ignores `.bl/` (`bl init`), where its lock files stay after a release (F-104 D3).
    writeFileSync(join(backlog, '.git', 'info', 'exclude'), '.bl/\n');
    execSync(`git -C "${backlog}" config user.email t@t`, { stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`git -C "${backlog}" config user.name t`, { stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`git -C "${backlog}" add -A`, { stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`git ${GIT_ENV} -C "${backlog}" commit -q -m init`, { stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`git -C "${backlog}" remote add origin "${backlogUpstream}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    execSync(`git -C "${backlog}" push -q origin main`, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  if (prePushHook) {
    for (const name of repoNames) {
      const script = prePushHook(name, { tmp, backlog });
      if (!script) continue;
      const hooksDir = join(repos[name], '.git', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'pre-push'), script, { mode: 0o755 });
    }
  }

  return { tmp, backlog, repos, branchName, storyIndexPath };
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

function silenceStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  return Promise.resolve(fn()).finally(() => {
    process.stderr.write = orig;
  });
}

/** Run `fn` with this process's stderr captured; child processes' is not. */
function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  return Promise.resolve(fn())
    .then((result) => ({ result, stderr }))
    .finally(() => {
      process.stderr.write = orig;
    });
}

test('single-repo cleanup writes commit as a bare string', async () => {
  const { backlog, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
  });
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  // The story is marked done where it is (F-49 D3).
  const fileToRead = storyIndexPath;
  const { fm } = parseFrontmatter(readFileSync(fileToRead, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'done');
  assert.equal(typeof fm.commit, 'string', 'expected a bare string commit');
  assert.match(fm.commit, /^[0-9a-f]{7,}$/);
});

test('bl merge shows check and install as statuses (S-1412)', async () => {
  // A `check` plugin and a lockfile, so every long step of the repo runs.
  const { backlog } = buildStoryBacklog({
    repoNames: ['bl'],
    backlogJsonExtra: { plugins: { 'ok-check': { check: 'true' } } },
    setupRepo: (_name, work) => {
      writeFileSync(join(work, 'package-lock.json'), '{}\n');
      execSync(`git ${GIT_ENV} -C "${work}" add package-lock.json`, { stdio: ['ignore', 'pipe', 'pipe'] });
      execSync(`git ${GIT_ENV} -C "${work}" commit -q -m lockfile`, { stdio: ['ignore', 'pipe', 'pipe'] });
      execSync(`git -C "${work}" push -q origin main`, { stdio: ['ignore', 'pipe', 'pipe'] });
    },
  });
  writeFileSync(join(backlog, 'index.md'), '---\nplugins-check: [ok-check]\n---\n');
  const fake = fakeTmux();
  // `npm ci` succeeds without doing anything.
  writeFileSync(join(fake.dir, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const fakeEnv = {
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    TMUX: '/tmp/tmux-fake,1,0',
    BL_TMUX_WINDOW_ID: '@7',
    BL_BACKLOG_DIR: backlog,
    // Titles on, also when the test runs under an agent session's empty BL_TAB_TITLE.
    BL_TAB_TITLE: undefined,
  };
  // withEnv is synchronous, so the variables are set and restored around the awaited merge.
  const saved = Object.fromEntries(Object.keys(fakeEnv).map((k) => [k, process.env[k]]));
  const setAll = (vars) => {
    for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  const restore = () => setAll(saved);
  setAll(fakeEnv);
  let out;
  try {
    out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    restore();
  }
  // The exit hook that the first title registered must never reach a real tmux.
  withEnv(fakeEnv, () => endTabTitle(0));
  process.env.BL_TAB_TITLE = '';
  assert.equal(out.result.exit, null, out.stderr);
  const statuses = renamedTitles(fake.calls())
    .map((title) => title.split(' : ').at(-1).trim())
    .filter((status, i, all) => status !== all[i - 1]);
  // `pull` starts each repo of the loop (`cleanupOneRepo`), so a feature's next repo never shows the last one's `cleanup`.
  assert.deepEqual(statuses, [
    'integrate',
    'pull',
    'check',
    'pre-push gate + push',
    'install',
    'cleanup',
    'sync',
    'ended',
  ]);
});

test('bl merge removes the emptied unit directory, and keeps one with another worktree (F-60 D2)', async () => {
  for (const other of [null, 'docs']) {
    const { tmp, backlog, branchName } = buildStoryBacklog({ repoNames: ['bl'] });
    const unitDir = join(tmp, 'worktrees', branchName);
    assert.ok(existsSync(join(unitDir, 'bl')), "the story's worktree is <root>/<branch>/<repo>");
    // Another repo's worktree in the same unit directory.
    if (other === 'docs') mkdirSync(join(unitDir, other, 'src'), { recursive: true });
    process.env.BL_BACKLOG_DIR = backlog;
    let out;
    try {
      out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
    } finally {
      delete process.env.BL_BACKLOG_DIR;
    }
    assert.equal(out.result.exit, null, out.stderr);
    assert.equal(existsSync(join(unitDir, 'bl')), false, 'the worktree is removed');
    if (other) {
      assert.deepEqual(readdirSync(unitDir), [other], 'a unit directory that still holds a worktree is left as it is');
    } else {
      assert.equal(existsSync(unitDir), false, 'the emptied unit directory is removed');
      assert.match(out.stderr, /Removed unit directory: .*s99-test-cleanup/);
    }
  }
});

test("a leftover primary_repo naming another repo still merges the component's repo", async () => {
  const { backlog, storyIndexPath, tmp } = buildStoryBacklog({
    repoNames: ['bl'],
  });
  writeFileSync(
    storyIndexPath,
    readFileSync(storyIndexPath, 'utf8').replace(
      'status: in_progress\n',
      'status: in_progress\nprimary_repo: elsewhere\nsecondary_repos: [gone]\n',
    ),
  );
  process.env.BL_BACKLOG_DIR = backlog;
  let out;
  try {
    out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(out.result.exit, null, out.stderr);
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'done');
  assert.equal(fm.commit, upstreamMain(tmp, 'bl'));
});

test("a worktree on the story's branch in another repo is refused, naming the repo, and nothing merges", async () => {
  const { tmp, backlog, storyIndexPath } = buildStoryBacklog({
    repoNames: ['alpha', 'beta'],
    primaryRepo: 'alpha',
  });
  const before = { alpha: upstreamMain(tmp, 'alpha'), beta: upstreamMain(tmp, 'beta') };
  process.env.BL_BACKLOG_DIR = backlog;
  let out;
  try {
    out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(out.result.exit, 1);
  assert.match(
    out.stderr,
    /S-99 has a worktree on s99-test-cleanup in beta, but its repo is alpha\. Work in another repo is another story/,
  );
  assert.deepEqual({ alpha: upstreamMain(tmp, 'alpha'), beta: upstreamMain(tmp, 'beta') }, before, 'nothing merged');
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'in_progress');
  assert.equal(fm.commit, undefined);
});

test('bl merge S-n --repo is refused as an unknown option and merges nothing', async () => {
  const { tmp, backlog, storyIndexPath } = buildStoryBacklog({ repoNames: ['bl'] });
  const before = upstreamMain(tmp, 'bl');
  process.env.BL_BACKLOG_DIR = backlog;
  let out;
  try {
    out = await captureStderr(() => captureExit(() => cleanupMain(['S-99', '--repo', 'bl'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(out.result.exit, 1);
  assert.match(out.stderr, /bl merge: unknown option "--repo" for a story: a story's repo is its component's\./);
  assert.equal(upstreamMain(tmp, 'bl'), before);
  assert.equal(logStatusOf('story', parseFrontmatter(readFileSync(storyIndexPath, 'utf8')).fm), 'in_progress');
});

test('a story whose component names no repo exits 1 naming the component', async () => {
  const { backlog } = buildStoryBacklog({ repoNames: ['bl'] });
  writeFileSync(
    join(backlog, 'components', 'C00-cleanup', 'index.md'),
    '---\ncomponent_id: C00\ntitle: Cleanup\n---\n',
  );
  process.env.BL_BACKLOG_DIR = backlog;
  let out;
  try {
    out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(out.result.exit, 1);
  assert.match(out.stderr, /Story S-99 has no repo: its component C00 names no repo\./);
});

test("cleanup's merge commit subject leans on commitlint's default merge-ignore", async () => {
  const { backlog, repos } = buildStoryBacklog({ repoNames: ['bl'] });
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  const subject = execSync(`git -C "${repos.bl}" log -1 --format=%s main`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  // Carries the story id, greppable via \(S-\d+\).
  assert.match(subject, /^Merge branch '.*' into main \(S-99\)$/);
  // commitlint's default (@commitlint/is-ignored) skips any "Merge … into …"
  // message, so this passes with no Conventional Commits type.
  assert.match(subject, /^Merge .* into /);
});

test("cleanup's backlog-sync commit uses a Conventional-Commits chore subject", async () => {
  const { backlog } = buildStoryBacklog({
    repoNames: ['bl'],
    initBacklogGit: true,
  });
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  const subject = execSync(`git -C "${backlog}" log -1 --format=%s`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(subject, 'chore: mark S-99 done, sync backlog');
  // Valid Conventional Commits type, so the backlog repo can adopt the
  // commitlint baseline without breaking `bl done` / cleanup.
  assert.match(subject, /^chore: /);
});

test('cleanup refuses when review_status is pending', async () => {
  const { backlog, repos, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    reviewStatus: 'pending',
    reviewLog:
      '### Session 2026-07-08 (PR #1)\n\n**Must fix**\n\n- [ ] broken thing\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
  });
  process.env.BL_BACKLOG_DIR = backlog;
  let exitCode;
  try {
    const { exit } = await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
    exitCode = exit;
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.notEqual(exitCode, 0, 'cleanup must exit non-zero while review is pending');
  // Nothing merged: main still has only the init commit.
  const mainCount = execSync(`git -C "${repos.bl}" rev-list --count main`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(mainCount, '1', 'story branch must not be merged into main');
  // Story untouched at its original location.
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'in_progress');
});

test('cleanup refuses when review_status is addressed but items are unchecked', async () => {
  const { backlog, repos, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    reviewStatus: 'addressed',
    reviewLog:
      '### Session 2026-07-08 (PR #1)\n\n**Must fix**\n\n- [x] fixed thing\n- [ ] still broken\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
  });
  process.env.BL_BACKLOG_DIR = backlog;
  let exitCode;
  try {
    const { exit } = await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
    exitCode = exit;
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.notEqual(exitCode, 0, 'cleanup must exit non-zero with unchecked review items');
  const mainCount = execSync(`git -C "${repos.bl}" rev-list --count main`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(mainCount, '1', 'story branch must not be merged into main');
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'in_progress');
});

test('cleanup refuses when review_status is fixed (awaiting re-review)', async () => {
  const { backlog, repos, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    reviewStatus: 'fixed',
    reviewLog:
      '### Session 2026-07-08 (PR #1)\n\n**Must fix**\n\n- [x] fixed thing → fixed in abc1234\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
  });
  process.env.BL_BACKLOG_DIR = backlog;
  let exitCode;
  try {
    const { exit } = await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
    exitCode = exit;
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.notEqual(exitCode, 0, 'cleanup must exit non-zero until a re-review signs off');
  const mainCount = execSync(`git -C "${repos.bl}" rev-list --count main`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(mainCount, '1', 'story branch must not be merged into main');
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'in_progress');
});

test('cleanup proceeds when the latest review session is fully addressed', async () => {
  const { backlog, repos, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    reviewStatus: 'addressed',
    reviewLog:
      '### Session 2026-07-08 (PR #1)\n\n**Must fix**\n\n- [x] fixed thing → fixed in abc1234\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
  });
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'done');
  // The change document moved with the story and records the merge.
  const change = parseChange(readFileSync(storyIndexPath.replace(/index\.md$/, 'change.md'), 'utf8'));
  assert.equal(change.fm.status, 'merged');
  assert.match(change.repos[0].merged, /^[0-9a-f]{7,}$/);
  assert.equal(change.repos[0].merged, fm.commit, 'the same SHA as commit:');
  assert.match(
    extractSection(change.body, 'Merge'),
    new RegExp(`^\\n- \\d{4}-\\d{2}-\\d{2} · bl · merged ${fm.commit}\\n`),
  );
  assert.ok(!existsSync(join(backlog, 'releases')), 'a story merged alone gets no release manifest');
  const tags = execSync(`git -C "${repos.bl}" tag`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(tags, '', 'and no tag');
});

// Fake forge: two tiny node scripts stand in for `gh pr list --state all`
// and `gh pr close`. `prs` is what change.find lists; every call is logged.
function writeForgeShims(dir, { prs }) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const find = join(dir, 'find.mjs');
  writeFileSync(
    find,
    `import { appendFileSync } from "fs";\nappendFileSync(${JSON.stringify(log)}, "find " + process.argv.slice(2).join(" ") + "\\n");\nprocess.stdout.write(${JSON.stringify(JSON.stringify(prs))});\n`,
  );
  const close = join(dir, 'close.mjs');
  writeFileSync(
    close,
    `import { appendFileSync } from "fs";\nappendFileSync(${JSON.stringify(log)}, "close " + process.argv.slice(2).join(" | ") + "\\n");\n`,
  );
  return {
    log,
    extra: {
      forge: 'github',
      plugins: {
        github: {
          'change.find': `node ${find} {{branch}}`,
          'change.close': `node ${close} {{number}} {{comment}}`,
        },
      },
    },
  };
}

test("bl merge closes the branch's open PR through change.find and change.close", async () => {
  const shimDir = mkTempDir('bl-forge-shim-');
  const { log, extra } = writeForgeShims(shimDir, {
    prs: [{ number: 7, url: 'https://x/pr/7', state: 'OPEN' }],
  });
  const { backlog, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    backlogJsonExtra: extra,
  });
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'done');
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.includes('find s99-test-cleanup'), calls.join('\n'));
  assert.ok(calls.includes('close 7 | Merged via bl merge.'), calls.join('\n'));
});

test('bl merge closes nothing when change.find lists only a merged PR', async () => {
  const shimDir = mkTempDir('bl-forge-shim-');
  const { log, extra } = writeForgeShims(shimDir, {
    prs: [{ number: 7, url: 'https://x/pr/7', state: 'MERGED', headRefOid: 'abc' }],
  });
  const { backlog, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    backlogJsonExtra: extra,
  });
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(logStatusOf('story', parseFrontmatter(readFileSync(storyIndexPath, 'utf8')).fm), 'done');
  assert.ok(!readFileSync(log, 'utf8').includes('close '), 'a merged PR is not closed');
});

test('push failure during cleanup exits non-zero and leaves the story not-done', async () => {
  const { backlog, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    pushBroken: true,
  });
  process.env.BL_BACKLOG_DIR = backlog;
  let exitCode;
  try {
    const { exit } = await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
    exitCode = exit;
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.notEqual(exitCode, 0, 'cleanup must exit non-zero when push fails');
  // Story file is still at its original (in_progress) location, untouched.
  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.notEqual(
    logStatusOf('story', fm),
    'done',
    'story must not be marked done when the push that landed the merge SHA failed',
  );
  assert.equal(fm.commit, undefined, 'commit must not be recorded when the SHA never reached origin');
});

test("cleanup's backlog commit holds only the story and the synced paths", async () => {
  const { backlog } = buildStoryBacklog({
    repoNames: ['bl'],
    initBacklogGit: true,
  });
  // Another agent's story in progress, and something the operator staged.
  const bystanderDir = join(backlog, 'stories', 'S7-bystander');
  mkdirSync(bystanderDir);
  const bystander = join(bystanderDir, 'index.md');
  writeFileSync(
    bystander,
    '---\ncomponent: C00\nstory_id: S-7\ntitle: Bystander\ntype: chore\npoints: 1\nstatus: backlog\n---\n\n# Bystander\n',
  );
  execSync(`git -C "${backlog}" add -A`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git ${GIT_ENV} -C "${backlog}" commit -q -m bystander`, { stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(bystander, '\nIn-progress edit.\n', { flag: 'a' });
  writeFileSync(join(backlog, 'staged.txt'), 'pre-staged\n');
  execSync(`git -C "${backlog}" add staged.txt`, { stdio: ['ignore', 'pipe', 'pipe'] });

  process.env.BL_BACKLOG_DIR = backlog;
  try {
    await silenceStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  const files = execSync(`git -C "${backlog}" show --name-status --no-renames --format= HEAD`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n');
  assert.ok(files.includes('M\tstories/S99-test-cleanup/index.md'), files.join('\n'));
  assert.ok(!files.some((f) => f.includes('S7-bystander')), files.join('\n'));
  assert.ok(!files.some((f) => f.includes('staged.txt')), files.join('\n'));
  const status = execSync(`git -C "${backlog}" status --porcelain`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(status, / M stories\/S7-bystander\/index\.md/);
  assert.match(status, /A {2}staged\.txt/);
});

// ---------------------------------------------------------------------------
// S-1330: what the merge's triage agent leaves is committed and pushed
// ---------------------------------------------------------------------------

/**
 * Give the story a `## Deferred` item, committed and pushed, and put on PATH
 * a `claude` stub that writes `newStory`, marks the story file triaged, and
 * exits 0.
 */
function triageSetup(backlog, storyIndexPath, newStory, { hook = false } = {}) {
  writeFileSync(storyIndexPath, '\n## Deferred\n\n- [points: 8] the follow-up work\n', { flag: 'a' });
  execSync(`git ${GIT_ENV} -C "${backlog}" commit -q -am deferred`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git -C "${backlog}" push -q origin main`, { stdio: ['ignore', 'pipe', 'pipe'] });
  const bin = mkTempDir('bl-triage-claude-');
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\nmkdir -p "${dirname(newStory)}"\nprintf -- '---\\nstory_id: S-100\\n---\\n' > "${newStory}"\necho triaged >> "${storyIndexPath}"\n${
      // The hook goes in after the merge's own commit, so only the triage commit meets it.
      hook
        ? `printf '#!/bin/sh\\nexit 1\\n' > "${backlog}/.git/hooks/pre-commit"\nchmod +x "${backlog}/.git/hooks/pre-commit"\n`
        : ''
    }exit 0\n`,
    { mode: 0o755 },
  );
  return bin;
}

/** `bl merge S-99` with `bin` first on PATH; `exitCode` is the `process.exitCode` it set. */
async function mergeWithStub(backlog, bin) {
  const origPath = process.env.PATH;
  process.env.PATH = `${bin}:${origPath}`;
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    const out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
    return { ...out, exitCode: process.exitCode };
  } finally {
    process.env.PATH = origPath;
    delete process.env.BL_BACKLOG_DIR;
    process.exitCode = undefined;
  }
}

function backlogGit(backlog, args) {
  return execSync(`git -C "${backlog}" ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test("bl merge commits and pushes what the triage agent left in the story's directory, and names the rest (F-122 D3)", async () => {
  const { tmp, backlog, storyIndexPath } = buildStoryBacklog({ repoNames: ['bl'], initBacklogGit: true });
  const newStory = join(backlog, 'stories', 'S100-new', 'index.md');
  const out = await mergeWithStub(backlog, triageSetup(backlog, storyIndexPath, newStory));
  assert.equal(out.result.exit, null, out.stderr);
  assert.equal(backlogGit(backlog, 'log -1 --format=%s').trim(), 'chore: triage S-99 Deferred into new stories');
  assert.equal(backlogGit(backlog, 'show --name-only --format= HEAD').trim(), 'stories/S99-test-cleanup/index.md');
  // The new story is outside the merged story's work unit: the agent commits it.
  // (So is the allowlist bl generated for the session, which this fixture never committed.)
  const status = backlogGit(backlog, 'status --porcelain');
  assert.match(status, /^\?\? stories\/S100-new\/$/m);
  assert.doesNotMatch(status, /S99-test-cleanup/);
  assert.match(out.stderr, /Left uncommitted, outside triage S-99's work units: .*stories\/S100-new\/index\.md/);
  const origin = backlogGit(join(tmp, 'upstream', 'backlog.git'), 'rev-parse main');
  assert.equal(origin, backlogGit(backlog, 'rev-parse HEAD'), 'origin has the triage commit');
});

test("the triage is skipped with one line naming the holder while another process holds the story's lock (F-122 D4)", async () => {
  // Another process takes the story's lock after the merge's integration,
  // which holds it itself (F-122 D9): a pre-push hook on main's push starts
  // a child that holds it and writes its PID.
  const holder = (tmp) => join(tmp, 'holder.pid');
  const { tmp, backlog, storyIndexPath } = buildStoryBacklog({
    repoNames: ['bl'],
    initBacklogGit: true,
    prePushHook: (name, { tmp: t, backlog: b }) => {
      const script = join(t, 'hold.mjs');
      writeFileSync(
        script,
        `import { writeFileSync } from 'fs';\nimport { holdLock } from ${JSON.stringify(new URL('../helpers/hold-lock.js', import.meta.url).href)};\nholdLock(process.argv[2], 'held by a test child');\nwriteFileSync(process.argv[3], String(process.pid));\nsetInterval(() => {}, 1 << 30);\n`,
      );
      const lock = unitLockPath(b, join(b, 'stories', 'S99-test-cleanup'));
      const pid = holder(t);
      return `#!/bin/sh\nwhile read l ls r rs; do\n  if [ "$r" = refs/heads/main ] && [ ! -e "${pid}" ]; then\n    "${process.execPath}" "${script}" "${lock}" "${pid}" >/dev/null 2>&1 </dev/null &\n    while [ ! -s "${pid}" ]; do sleep 0.05; done\n  fi\ndone\nexit 0\n`;
    },
  });
  const newStory = join(backlog, 'stories', 'S100-new', 'index.md');
  const bin = triageSetup(backlog, storyIndexPath, newStory);
  let out;
  try {
    out = await mergeWithStub(backlog, bin);
  } finally {
    if (existsSync(holder(tmp))) process.kill(Number(readFileSync(holder(tmp), 'utf8')), 'SIGKILL');
  }
  assert.equal(out.result.exit, null, out.stderr);
  const pid = readFileSync(holder(tmp), 'utf8');
  assert.match(
    out.stderr,
    new RegExp(
      `\\nTriage of S-99's ## Deferred skipped: S-99 is locked by a live bl process \\(pid ${pid}\\): .*/\\.bl/lock/unit-S99-test-cleanup-`,
    ),
  );
  assert.doesNotMatch(out.stderr, /launching triage agent/);
  assert.equal(existsSync(newStory), false, 'no triage session ran');
  // The merge itself stands.
  assert.equal(logStatusOf('story', parseFrontmatter(readFileSync(storyIndexPath, 'utf8')).fm), 'done');
  assert.equal(backlogGit(backlog, 'log -1 --format=%s').trim(), 'chore: mark S-99 done, sync backlog');
  assert.equal(backlogGit(backlog, 'status --porcelain'), '');
});

test('a triage commit that fails makes bl merge exit 1 after its remaining steps', async () => {
  const { backlog, storyIndexPath } = buildStoryBacklog({ repoNames: ['bl'], initBacklogGit: true });
  const newStory = join(backlog, 'stories', 'S100-new', 'index.md');
  const out = await mergeWithStub(backlog, triageSetup(backlog, storyIndexPath, newStory, { hook: true }));
  assert.equal(out.result.exit, null, out.stderr);
  assert.equal(out.exitCode, 1, out.stderr);
  assert.match(
    out.stderr,
    /backlog commit failed: .*\n {2}Commit these paths yourself: stories\/S99-test-cleanup\/index\.md\n/,
  );
  // The remaining steps ran: the closing line comes after the failure.
  assert.match(out.stderr, /backlog commit failed[\s\S]*\nDone\. S-99 cleaned in: bl \(story marked done\)\./);
});

// ---------------------------------------------------------------------------
// S-864: a `bl` story's mark-done sync runs with the merged bl
// ---------------------------------------------------------------------------

/** The short SHA at the tip of a repo's upstream `main`: what landed. */
function upstreamMain(tmp, name) {
  return execSync(`git -C "${join(tmp, 'upstream', `${name}.git`)}" rev-parse --short main`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Make the temp repo at `work` look like the `bl` package: `package.json`
 * names it `bl` and `src/bl.js` is a shim that appends its cwd and argv to
 * `logPath`, then hands over to this checkout's real `src/bl.js`, so the
 * child `bl sync --commit` really runs against the temp backlog.
 */
function installBlShim(work, logPath) {
  const realBl = fileURLToPath(new URL('../../src/bl.js', import.meta.url));
  writeFileSync(join(work, 'package.json'), '{ "name": "bl", "type": "module" }\n');
  mkdirSync(join(work, 'src'));
  writeFileSync(
    join(work, 'src', 'bl.js'),
    [
      'import { appendFileSync } from "fs";',
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + "\\n");`,
      `await import(${JSON.stringify(pathToFileURL(realBl).href)});`,
      '',
    ].join('\n'),
  );
  execSync(`git ${GIT_ENV} -C "${work}" add package.json src/bl.js`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git ${GIT_ENV} -C "${work}" commit -q -m "bl shim"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git -C "${work}" push -q origin main`, { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('a bl story runs the mark-done sync as a child of its merged checkout', async () => {
  let shimLog;
  const {
    tmp: root,
    backlog,
    storyIndexPath,
  } = buildStoryBacklog({
    repoNames: ['bl'],
    initBacklogGit: true,
    setupRepo: (name, work, { tmp }) => {
      if (name !== 'bl') return;
      shimLog = join(tmp, 'bl-shim-log');
      installBlShim(work, shimLog);
    },
  });

  process.env.BL_BACKLOG_DIR = backlog;
  let exitCode, stderr;
  try {
    const out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
    exitCode = out.result.exit;
    stderr = out.stderr;
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(exitCode, null, stderr);

  // One child run, from the backlog root: mark-done. A story has one repo,
  // so there is no sync between repos.
  const runs = readFileSync(shimLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(realpathSync(runs[0].cwd), realpathSync(backlog));
  assert.deepEqual(runs[0].argv, ['sync', '--commit', '-m', 'chore: mark S-99 done, sync backlog', '--story', 'S-99']);

  // The child committed (so the parent had released the lock), and its
  // `--story` staged the done edit.
  const subjects = execSync(`git -C "${backlog}" log --format=%s`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n');
  assert.deepEqual(subjects, ['chore: mark S-99 done, sync backlog', 'init']);
  const done = execSync(`git -C "${backlog}" show --name-status --no-renames --format= HEAD`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(done, /stories\/S99-test-cleanup\/index\.md$/m, done);
  assert.equal(
    execSync(`git -C "${backlog}" status --porcelain`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    '',
  );
  assert.equal(holderOf(join(backlog, LOCK_FILE)), null);

  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'done');
  assert.equal(fm.commit, upstreamMain(root, 'bl'));
});

// ---------------------------------------------------------------------------
// S-868: a repo whose story branch was merged on the forge and is absent
// locally still gets a `commit:` entry — the tip of main after the pull and
// the push, which equals its origin/main.
// ---------------------------------------------------------------------------

/**
 * Make `name` look like a repo whose story branch was merged on the forge:
 * drop its local story worktree and branch, then push a commit straight to
 * its upstream `main` from a scratch clone (standing in for the forge merge),
 * so origin is ahead of the working clone. Returns the upstream's short SHA.
 */
function mergeOnForge({ tmp, repos, branchName }, name) {
  const work = repos[name];
  const wt = join(tmp, 'worktrees', branchName, name);
  execSync(`git -C "${work}" worktree remove --force "${wt}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git -C "${work}" branch -D "${branchName}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  const upstream = join(tmp, 'upstream', `${name}.git`);
  const scratch = join(tmp, 'scratch', name);
  mkdirSync(scratch, { recursive: true });
  execSync(`git clone -q "${upstream}" "${scratch}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(scratch, 'forge-merge.txt'), `${branchName}\n`);
  execSync(`git ${GIT_ENV} -C "${scratch}" add forge-merge.txt`, { stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git ${GIT_ENV} -C "${scratch}" commit -q -m "Merge pull request from ${branchName}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execSync(`git -C "${scratch}" push -q origin main`, { stdio: ['ignore', 'pipe', 'pipe'] });
  return upstreamMain(tmp, name);
}

test('a single-repo story merged on the forge with no local branch gets a bare-string commit', async () => {
  const built = buildStoryBacklog({ repoNames: ['bl'] });
  const { tmp, backlog, storyIndexPath } = built;
  const forgeSha = mergeOnForge(built, 'bl');

  process.env.BL_BACKLOG_DIR = backlog;
  let exitCode, stderr;
  try {
    const out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
    exitCode = out.result.exit;
    stderr = out.stderr;
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(exitCode, null, stderr);

  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'done');
  assert.equal(fm.commit, forgeSha);
  assert.equal(fm.commit, upstreamMain(tmp, 'bl'));
});

test('a repo with no local branch whose push fails records nothing', async () => {
  // The no-branch path reads main's tip before the push. The push failing
  // must still fail the repo, so a tip that never reached origin is not
  // written to `commit:` and the story stays not done.
  const built = buildStoryBacklog({ repoNames: ['bl'], pushBroken: true });
  const { backlog, storyIndexPath } = built;
  mergeOnForge(built, 'bl');

  process.env.BL_BACKLOG_DIR = backlog;
  let exitCode, stderr;
  try {
    const out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
    exitCode = out.result.exit;
    stderr = out.stderr;
  } finally {
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.notEqual(exitCode, 0, 'the push failure must be fatal');
  assert.notEqual(exitCode, null, 'the push failure must be fatal');
  assert.match(stderr, /recording main at [0-9a-f]+\./);
  assert.match(stderr, /push of main to origin failed/);

  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.notEqual(logStatusOf('story', fm), 'done');
  assert.equal(fm.commit, undefined, 'a tip that never reached origin must not be recorded');
});

/**
 * A `git` on PATH that fails `git rev-parse --short` of `HEAD` or of a
 * commit ID and passes every other call to the real git: the lookups
 * `cleanupOneRepo` reads a landed SHA with, `HEAD` on the no-branch path and
 * the merge commit (`landedMergeCommit`) on the local-branch path.
 */
function gitWithBrokenShortHead(dir) {
  const realGit = execSync('command -v git', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\nif [ "$1" = "rev-parse" ] && [ "$2" = "--short" ]; then\n  case "$3" in HEAD|[0-9a-f]*)\n    echo "fatal: rev-parse broken by the test" >&2\n    exit 128;;\n  esac\nfi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  return dir;
}

// Both catches around that lookup: the SHA stays null, the repo still merges
// and pushes, the story is done, and no commit is recorded (nothing stands in
// for a SHA the run could not read).
for (const [name, absent] of [
  ['absent branch with rev-parse failure records no commit', true],
  ['local branch with rev-parse failure records no commit', false],
]) {
  test(name, async () => {
    const built = buildStoryBacklog({ repoNames: ['bl'] });
    const { tmp, backlog, storyIndexPath } = built;
    if (absent) mergeOnForge(built, 'bl');

    const origPath = process.env.PATH;
    process.env.PATH = `${gitWithBrokenShortHead(join(tmp, 'shim'))}:${origPath}`;
    process.env.BL_BACKLOG_DIR = backlog;
    let out;
    try {
      out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
    } finally {
      process.env.PATH = origPath;
      delete process.env.BL_BACKLOG_DIR;
    }
    assert.equal(out.result.exit, null, out.stderr);
    assert.doesNotMatch(out.stderr, /recording main at|Keeping /);
    assert.match(out.stderr, absent ? /assuming PR was merged on the forge\./ : /has 1 unmerged commit\(s\)\. Merging/);

    const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
    assert.equal(logStatusOf('story', fm), 'done');
    assert.equal(fm.commit, undefined, 'no SHA was read, so none is recorded');
  });
}

/**
 * A `git` on PATH that, the first time `git rev-parse --short HEAD` runs
 * (the no-branch path reading main's tip, after `bl merge` read the story),
 * records `exact111` as `bl`'s merge SHA in the story, as a concurrent merge
 * would; every call then goes to the real git.
 */
function gitThatLandsConcurrently(dir, storyIndexPath) {
  const realGit = execSync('command -v git', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(dir, { recursive: true });
  const fired = join(dir, 'fired');
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\nif [ "$1" = "rev-parse" ] && [ "$2" = "--short" ] && [ "$3" = "HEAD" ] && [ ! -e "${fired}" ]; then\n  : > "${fired}"\n  sed -i 's/^status: in_progress$/status: in_progress\\ncommit:\\n  bl: exact111/' "${storyIndexPath}"\nfi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  return dir;
}

test('concurrent no-branch cleanup keeps the SHA written after its initial story read (bl merge)', async () => {
  // `bl merge` read the story (no `commit:` yet) before taking bl down the
  // no-branch path; a concurrent merge then recorded bl's exact SHA. The
  // per-repo write and mark-done must both keep that SHA, deciding from the
  // file re-read under the lock, never from the stale first read.
  const built = buildStoryBacklog({ repoNames: ['bl'] });
  const { tmp, backlog, storyIndexPath } = built;
  mergeOnForge(built, 'bl');

  const origPath = process.env.PATH;
  process.env.PATH = `${gitThatLandsConcurrently(join(tmp, 'shim'), storyIndexPath)}:${origPath}`;
  process.env.BL_BACKLOG_DIR = backlog;
  let out;
  try {
    out = await captureStderr(() => captureExit(() => cleanupMain(['S-99'])));
  } finally {
    process.env.PATH = origPath;
    delete process.env.BL_BACKLOG_DIR;
  }
  assert.equal(out.result.exit, null, out.stderr);
  assert.ok(existsSync(join(tmp, 'shim', 'fired')), 'the concurrent write ran');
  const tip = upstreamMain(tmp, 'bl');
  assert.notEqual(tip, 'exact111');
  assert.match(out.stderr, new RegExp(`Keeping bl's recorded merge SHA exact111; main is at ${tip}\\.`));

  const { fm } = parseFrontmatter(readFileSync(storyIndexPath, 'utf8'));
  assert.equal(logStatusOf('story', fm), 'done');
  assert.equal(fm.commit, 'exact111', 'the SHA recorded after the first read must survive the no-branch tip');
});
