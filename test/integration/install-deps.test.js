import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { loadConfig, normalizeId } from '../../src/config.js';
import { installDeps } from '../../src/session.js';
import { AGENT_CONFIG, mkTempDir, reposConfig } from '../helpers/tempdir.js';

// `installDeps` is the bootstrap step that replaced the literal
// `pnpm install`. A story's one repo, its component's (F-52 D1), gets its
// resolved plugin invocation in its own worktree; a repo the story's
// leftover `primary_repo` / `secondary_repos` names is never bootstrapped,
// even with a worktree on the branch. The marker file proves which ran.
function buildTwoRepoStory() {
  const tmp = mkTempDir('bl-installdeps-');
  const backlog = join(tmp, 'backlog');
  const worktreesBase = join(tmp, 'worktrees');
  const codeRepo = join(tmp, 'code');
  const goRepo = join(tmp, 'logr');

  mkdirSync(backlog, { recursive: true });
  mkdirSync(worktreesBase, { recursive: true });
  for (const r of [codeRepo, goRepo]) {
    mkdirSync(r, { recursive: true });
    execSync('git init -q', { cwd: r });
  }

  // Pre-create both worktrees so installDeps doesn't skip them.
  const codeWt = join(worktreesBase, 's1-test', 'code');
  const goWt = join(worktreesBase, 's1-test', 'logr');
  mkdirSync(codeWt, { recursive: true });
  mkdirSync(goWt, { recursive: true });

  // The bootstrap plugin writes a marker inside the worktree it runs in,
  // using `{{worktreePath}}` and `{{repoName}}`.
  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      backlog: 'backlog',
      worktrees: worktreesBase,
      // The story's repo (code, its component's) turns the bootstrap plugin on.
      ...AGENT_CONFIG,
      repos: reposConfig({ code: { path: codeRepo, 'plugins-bootstrap': ['marker'] }, logr: goRepo }),
      plugins: {
        marker: {
          bootstrap: `sh -c 'echo {{repoName}} > {{worktreePath}}/.bootstrapped'`,
        },
      },
    }),
  );

  const componentDir = join(backlog, 'components', 'C00-test');
  mkdirSync(componentDir, { recursive: true });
  writeFileSync(join(componentDir, 'index.md'), '---\ncomponent_id: C00\ntitle: Test\nrepo: code\n---\n');
  const sDir = join(backlog, 'stories', 'S1-test');
  mkdirSync(sDir, { recursive: true });
  writeFileSync(
    join(sDir, 'index.md'),
    `---
component: C00
story_id: S-1
title: Test
status: refined
primary_repo: logr
secondary_repos: [logr]
---
`,
  );

  return { backlog, codeWt, goWt };
}

test("installDeps bootstraps only the story's component repo, with repo-scoped vars", () => {
  const { backlog, codeWt, goWt } = buildTwoRepoStory();
  // The repo layer comes from the story's repo, not from the config the
  // caller loaded or the cwd (F-51 D4): a plain top-level config will do.
  const config = loadConfig({ backlogRoot: backlog });
  const parsed = normalizeId('S-1');
  installDeps(config, parsed, {
    componentEntry: 'C00-test',
    storyEntry: 'S1-test',
  });

  const codeMarker = join(codeWt, '.bootstrapped');
  const goMarker = join(goWt, '.bootstrapped');
  assert.ok(existsSync(codeMarker), "the component's repo (code) should be bootstrapped");
  assert.ok(!existsSync(goMarker), 'the leftover repo (logr) must not be bootstrapped');
  assert.equal(readFileSync(codeMarker, 'utf8').trim(), 'code');
});

test('installDeps emits a hint when no bootstrap plugin is configured', () => {
  const tmp = mkTempDir('bl-installdeps-noop-');
  const backlog = join(tmp, 'backlog');
  const worktreesBase = join(tmp, 'worktrees');
  const codeRepo = join(tmp, 'code');

  mkdirSync(backlog, { recursive: true });
  mkdirSync(worktreesBase, { recursive: true });
  mkdirSync(codeRepo, { recursive: true });
  execSync('git init -q', { cwd: codeRepo });
  const codeWt = join(worktreesBase, 's1-test', 'code');
  mkdirSync(codeWt, { recursive: true });

  writeFileSync(
    join(backlog, 'backlog.json'),
    JSON.stringify({
      backlog: 'backlog',
      worktrees: worktreesBase,
      ...AGENT_CONFIG,
      repos: reposConfig([codeRepo]),
      // No `plugins-bootstrap` cascade entry anywhere — this is the
      // post-S-440 default, and the user should see a hint pointing at the
      // opt-in rather than a silent no-op.
      plugins: {
        'node-ws': { bootstrap: 'pnpm install --no-frozen-lockfile' },
      },
    }),
  );
  const componentDir = join(backlog, 'components', 'C00-test');
  mkdirSync(componentDir, { recursive: true });
  writeFileSync(join(componentDir, 'index.md'), '---\ncomponent_id: C00\ntitle: Test\nrepo: code\n---\n');
  const sDir = join(backlog, 'stories', 'S1-test');
  mkdirSync(sDir, { recursive: true });
  writeFileSync(join(sDir, 'index.md'), '---\ncomponent: C00\nstory_id: S-1\ntitle: Test\nstatus: refined\n---\n');

  const config = loadConfig({ backlogRoot: backlog, projectId: 'demo' });
  const parsed = normalizeId('S-1');

  // Capture stderr to inspect the hint.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += String(chunk);
    return origWrite(chunk, ...rest);
  };
  try {
    installDeps(config, parsed, {
      componentEntry: 'C00-test',
      storyEntry: 'S1-test',
    });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.match(captured, /no bootstrap plugin configured for code/);
});
