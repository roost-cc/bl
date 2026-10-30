/**
 * Integration test for `bl run S-n`'s prep and gates (F-35 Design §3):
 * `prepareStoryRun` against a real git repo, and the refusals `cmdRunStory`
 * makes before any worktree or session.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { loadConfig, normalizeId } from '../../src/config.js';
import { findStoryDir, readAllStories } from '../../src/story.js';
import { prepareStoryRun } from '../../src/workon.js';
import { cmdRunStory } from '../../src/feature-cmd.js';
import { AGENT_CONFIG, mkTempDir, reposConfig } from '../helpers/tempdir.js';

function build({ status = 'refined', dependsOn = null } = {}) {
  const tmp = mkTempDir('bl-story-run-');
  const backlog = join(tmp, 'backlog');
  const repo = join(tmp, 'repoA');
  mkdirSync(repo, { recursive: true });
  execSync('git init -q -b main', { cwd: repo });
  execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', { cwd: repo });
  mkdirSync(join(backlog, 'stories', 'S7-loose'), { recursive: true });
  mkdirSync(join(backlog, 'stories', 'S6-dep'), { recursive: true });
  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      backlog: 'backlog',
      worktrees: join(tmp, 'worktrees'),
      ...AGENT_CONFIG,
      repos: reposConfig([repo]),
    }),
  );
  mkdirSync(join(backlog, 'components', 'C00-core'), { recursive: true });
  writeFileSync(
    join(backlog, 'components', 'C00-core', 'index.md'),
    '---\ncomponent_id: C00\ntitle: Core\nrepo: repoA\nhome: true\n---\n',
  );
  writeFileSync(
    join(backlog, 'stories', 'S6-dep', 'index.md'),
    '---\nstory_id: S-6\ntitle: Dep\nstatus: in_progress\npoints: 1\n---\n\n# Dep\n',
  );
  writeFileSync(
    join(backlog, 'stories', 'S7-loose', 'index.md'),
    `---\nstory_id: S-7\ncomponent: C00\ntitle: Loose\nstatus: ${status}\npoints: 3\n${dependsOn ? `depends_on: [${dependsOn}]\n` : ''}---\n\n# Loose\n\n## Acceptance Criteria\n\n- [ ] works\n`,
  );
  return { tmp, backlog, repo };
}

async function run(backlog, args) {
  const config = loadConfig({ backlogRoot: backlog });
  const story = readAllStories(config).find((s) => s.id === 'S-7');
  const origExit = process.exit;
  const origErr = console.error;
  const origLog = console.log;
  let exit = null;
  let err = '';
  let out = '';
  process.exit = (code) => {
    exit = code ?? 0;
    throw new Error('__exit__');
  };
  console.error = (...a) => {
    err += `${a.join(' ')}\n`;
  };
  console.log = (...a) => {
    out += `${a.join(' ')}\n`;
  };
  try {
    await cmdRunStory({ positional: ['S-7'], ...args }, config, story);
  } catch (e) {
    if (e.message !== '__exit__') throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
    console.log = origLog;
  }
  return { exit, err, out };
}

test("prepareStoryRun: the story's own branch and worktree, in prepareFeatureWorktree's shape", () => {
  const { tmp, backlog, repo } = build();
  const prevBacklog = process.env.BL_BACKLOG_DIR;
  process.env.BL_BACKLOG_DIR = backlog;
  try {
    const config = loadConfig({ backlogRoot: backlog, projectId: 'demo' });
    const parsed = normalizeId('S-7');
    const found = findStoryDir(parsed, config);
    const prep = prepareStoryRun(parsed, found, config);
    assert.equal(prep.branchName, 's7-loose');
    assert.equal(prep.worktreePath, join(tmp, 'worktrees', 's7-loose', 'repoA'));
    assert.ok(existsSync(prep.worktreePath));
    assert.ok(execSync('git worktree list', { cwd: repo, encoding: 'utf8' }).includes('[s7-loose]'));
    assert.equal(prep.cfg.repoName, 'repoA', "the story's repo's config (F-51 D4)");
    assert.equal(prep.cfg.backlogRoot, config.backlogRoot);
    assert.deepEqual(prep.parsed, parsed);
    assert.deepEqual(
      prep.ordered.map((s) => [s.id, s.title, s.points, s.storyRelPath]),
      [['S-7', 'Loose', 3, 'stories/S7-loose/index.md']],
    );
    assert.equal(prep.targetRepoName, 'repoA');
    const v = prep.baseVars;
    assert.equal(v.prTitle, 'S-7: Loose');
    assert.equal(v.featureId, 'S-7');
    assert.equal(v.featureAbsPath, found.indexPath);
    assert.equal(v.featureRelPath, 'stories/S7-loose/index.md');
    assert.equal(v.unitKind, 'story');
    assert.equal(v.deferredHeading, 'To Do');
    assert.equal(v.sessionNum, '7');
    assert.equal(v.sessionId, 's7');
    assert.equal(v.adhocComponent, 'C00');
  } finally {
    if (prevBacklog == null) delete process.env.BL_BACKLOG_DIR;
    else process.env.BL_BACKLOG_DIR = prevBacklog;
  }
});

test("bl run S-n --plan prints the loop's steps for the story and touches nothing", async () => {
  const { backlog, repo } = build();
  const { exit, out } = await run(backlog, { plan: true });
  assert.equal(exit, null);
  assert.match(out, /^S-7 · Loose — run plan\n 1\. setup\n 2\. implement S-7\n 3\. test/);
  assert.ok(!execSync('git worktree list', { cwd: repo, encoding: 'utf8' }).includes('s7-loose'), 'no worktree');
});

test('bl run S-n refuses a backlog story, pointing at bl refine', async () => {
  const { backlog } = build({ status: 'backlog' });
  const { exit, err } = await run(backlog, {});
  assert.equal(exit, 1);
  assert.match(err, /Story S-7 is backlog — run `bl refine S-7` first\./);
});

test('bl run S-n refuses while a dependency is not merged', async () => {
  const { backlog } = build({ dependsOn: 'S-6' });
  const { exit, err } = await run(backlog, {});
  assert.equal(exit, 1);
  assert.match(err, /Story S-7 is blocked on unmerged work:\n {2}S-7 depends on S-6 \(in_progress\)/);
});

test('bl run S-n refuses an open ## Escalation before any worktree is made', async () => {
  const { backlog, repo } = build();
  const p = join(backlog, 'stories', 'S7-loose', 'index.md');
  writeFileSync(p, `${readFileSync(p, 'utf8')}\n## Escalation\n\nWhich way?\n`);
  const { exit, err } = await run(backlog, {});
  assert.equal(exit, 1);
  assert.match(err, /Story S-7 has an open ## Escalation/);
  assert.ok(!execSync('git worktree list', { cwd: repo, encoding: 'utf8' }).includes('s7-loose'), 'no worktree');
});

test('bl run S-n rejects a bad --max-rounds', async () => {
  const { backlog } = build();
  const { exit, err } = await run(backlog, { 'max-rounds': '0' });
  assert.equal(exit, 1);
  assert.match(err, /--max-rounds must be a positive integer/);
});
