/**
 * The fixtures that test/integration/merge-integrate-{clean,conflict,land,exception,repos,rollback,retained,resume}.test.js share.
 *
 * Integration tests for `bl merge`'s integration step (F-36 D4, D9) on real
 * git repos: one repo `code` with an origin, a feature F-1 (over S-2) on
 * `f1-feat` and a loose story S-1 on `s1-loose`, each with a worktree and a
 * reviewed change document.
 *
 * `integrateUnit` is driven directly with a stub runner (real git, a fixed
 * test plugin, scripted sessions): a branch already current, a clean merge
 * (gated and pushed), a red gate after a clean merge (the agent fails, or
 * fixes it), a conflict the agent refuses, resolves and gets re-reviewed
 * (addressed: lands; pending: kept on the branch), leaves unfinished or
 * commits with markers, a dirty worktree and a held run lock. `bl merge`
 * itself covers a branch behind main landing, a story conflict stopping
 * before main, and main moving between the integration and the merge into
 * main (aborted, clean, the rerun lands). Every path that may start an agent
 * finds refusing stubs first on PATH (`runBl` for spawned commands,
 * `noAgentEnv` for direct calls).
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkTempBacklog, mkTempDir } from './tempdir.js';
import { noAgentEnv } from './fake-agent.js';
import { fixTestsOutcome, MERGE_RESOLVE_OUTCOME, reviewOutcome } from './outcomes.js';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { extractSection, findFeature, normalizeFeatureId } from '../../src/feature.js';
import { featureUnit } from '../../src/unit.js';
import { mergePrep } from '../../src/merge-integrate.js';
import { defaultRunner } from '../../src/feature-run.js';

export const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  BL_KEEP_TEST_CONTAINERS: '1',
  // `runBl` stubs the agents for spawned commands; this covers the direct
  // calls (`integrateUnit`, `runFeature`) that may start the resolution agent.
  ...noAgentEnv(),
};
// The direct calls commit in the backlog and the worktrees from this process.
Object.assign(process.env, ENV);

export function g(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export const ok = (cwd, ...args) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;

const SESSION =
  '### Session 2026-10-20 (PR #4)\n\n**Must fix**\n\nNone.\n\n**Should fix**\n\nNone.\n\n**Nits**\n\nNone.';
const REVIEWED = { review_status: 'addressed', reviewLog: SESSION };

/**
 * The backlog, the repo and its origin, a commit on each branch (its own
 * file, `<branch>.txt`) and a worktree on each. `test` is the repo's test
 * plugin command, when given.
 */
export function fixture({ test: testCmd = null, reviewRound = null } = {}) {
  const config = testCmd ? { plugins: { t: { test: testCmd } } } : {};
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: { path: './code', deployable: true, ...(testCmd ? { 'plugins-test': ['t'] } : {}) } },
    components: [{ id: 'C00', title: 'code', dirSuffix: 'code', repo: 'code', home: true }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Loose',
        dirSuffix: 'loose',
        status: 'in_progress',
        branch: 's1-loose',
        primary_repo: 'code',
        ...REVIEWED,
      },
      {
        id: 'S-2',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'in-feature',
        status: 'in_progress',
        feature: 'F-1',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-2'],
        branch: 'f1-feat',
        ...REVIEWED,
        ...(reviewRound != null ? { review_round: reviewRound } : {}),
      },
    ],
    config,
  });
  const origin = join(dir, 'code-origin.git');
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(dir, 'code');
  g(dir, 'init', '-q', '-b', 'main', repo);
  g(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', 'origin', 'main');
  const wts = {};
  for (const b of ['s1-loose', 'f1-feat']) {
    wts[b] = join(dir, 'wt', b);
    g(repo, 'worktree', 'add', '-q', '-b', b, wts[b]);
    writeFileSync(join(wts[b], `${b}.txt`), `${b}\n`);
    g(wts[b], 'add', '.');
    g(wts[b], 'commit', '-q', '-m', `work on ${b}`);
    g(wts[b], 'push', '-q', 'origin', b);
  }
  writeFileSync(join(dir, '.gitignore'), 'code/\ncode-origin.git/\nwt/\nclone/\n.bl/\n');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, repo, origin, wts };
}

/** A commit on origin's main from a clone of its own, as another merge would land. */
export function landOnMain(fx, file, content, message) {
  const clone = mkTempDir('bl-integrate-clone-');
  g(clone, 'clone', '-q', fx.origin, 'c');
  const c = join(clone, 'c');
  writeFileSync(join(c, file), content);
  g(c, 'add', '.');
  g(c, 'commit', '-q', '-m', message);
  g(c, 'push', '-q', 'origin', 'main');
  return g(c, 'rev-parse', '--short', 'HEAD');
}

/**
 * Real git through the default runner; the test plugin is `test`. The
 * resolution agent resolves nothing (`resolved: false`, F-68 D2), fix-tests
 * returns `fixed` without changing anything, and every other session is
 * refused.
 */
export function stubRunner(testCmd) {
  const calls = { gates: 0, sessions: 0, log: [] };
  const runner = {
    ...defaultRunner(),
    session({ promptName }) {
      calls.sessions++;
      if (promptName === 'merge-resolve') return UNRESOLVED;
      if (promptName === 'feature-fix-tests') return FIXED_TESTS;
      return { ok: false, output: 'no sessions in this test', isError: true };
    },
    testPlugins() {
      calls.gates++;
      return { plugins: testCmd ? [{ name: 't', command: testCmd }] : [], unknown: [] };
    },
    listContainers: () => null,
    notify() {},
    log: (m) => calls.log.push(m),
  };
  return { runner, calls };
}

export const REFUSED = { ok: false, output: 'no agent in this test', isError: true };
/** A resolution session's outcome (F-68 D2): every merge committed. */
export const RESOLVED = { ok: true, output: '', isError: false, structured: MERGE_RESOLVE_OUTCOME };
/** A resolution session that says it could not resolve the merge. */
export const UNRESOLVED = {
  ok: true,
  output: '',
  isError: false,
  structured: { summary: 'could not resolve', resolved: false, reason: 'no agent in this test' },
};
/** A fix-tests session that committed a fix. */
export const FIXED_TESTS = { ok: true, output: '', isError: false, structured: fixTestsOutcome() };
export const REVIEW_SESSIONS = ['review-correctness', 'review-failure-paths', 'review-verify'];

/** The resolution `both\n` for the f1-feat.txt conflict, committed as the merge. */
export function resolveBoth(cwd) {
  writeFileSync(join(cwd, 'f1-feat.txt'), 'both\n');
  g(cwd, 'add', 'f1-feat.txt');
  g(cwd, 'commit', '-q', '--no-edit');
  return RESOLVED;
}

/**
 * Write the verifier's session on top of the change document's Review Log,
 * with `must` as its Must fix items, as review-verify does, and return its
 * outcome (F-68 D2): `pending` counts one open Must fix, `addressed` none, and
 * `unset` is a verifier that returned no outcome. The loop writes
 * `review_round` and `review_status` itself.
 */
function writeVerdict(path, verdict, must) {
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const session = `### Session 2026-10-26 (merge resolution)\n\n**Must fix**\n\n${must}\n\n**Should fix**\n\nNone.\n\n**Nits**\n\nNone.\n\n`;
  writeFileSync(path, serializeFrontmatter(fm) + body.replace('## Review Log\n\n', `## Review Log\n\n${session}`));
  return verdict === 'unset' ? null : reviewOutcome({ pending: verdict === 'pending' });
}

/**
 * Real git through the default runner, the test plugin `test`, and scripted
 * sessions: `resolve(worktreePath, vars)` plays the resolution agent, the
 * dimension passes find nothing, the verifier returns `verdict`, and a
 * fix-tests session returns `fixed` without changing anything.
 */
export function scriptedRunner({ test: testCmd, resolve, verdict = 'addressed', must = 'None.' }) {
  const calls = { gates: 0, sessions: [], vars: {}, log: [] };
  const runner = {
    ...defaultRunner(),
    session({ promptName, vars, worktreePath }) {
      calls.sessions.push(promptName);
      calls.vars[promptName] = vars;
      if (promptName === 'merge-resolve') return resolve(worktreePath, vars);
      if (promptName === 'review-verify') {
        const structured = writeVerdict(vars.changeAbsPath, verdict, must);
        return { ok: true, output: '', isError: false, structured };
      }
      if (promptName.startsWith('review-')) return { ok: true, output: 'no findings', isError: false };
      if (promptName === 'feature-fix-tests') return FIXED_TESTS;
      return REFUSED;
    },
    testPlugins() {
      calls.gates++;
      return { plugins: [{ name: 't', command: testCmd }], unknown: [] };
    },
    listContainers: () => null,
    notify() {},
    log: (m) => calls.log.push(m),
  };
  return { runner, calls };
}

export const changeFile = (fx) => join(fx.dir, 'features', 'F1-feat', 'change.md');

export function featureCtx(fx) {
  const config = loadConfig({ backlogRoot: fx.dir });
  const unit = featureUnit(findFeature(normalizeFeatureId('F-1'), config));
  return { config, unit, prep: mergePrep(config, unit, ['code']) };
}

export const featureFile = (fx) => join(fx.dir, 'features', 'F1-feat', 'index.md');
export const escalation = (path) =>
  extractSection(parseFrontmatter(readFileSync(path, 'utf8')).body, 'Escalation')?.trim() ?? '';

/**
 * A second repo `second` (its origin, a reviewed commit on `f1-feat` in a
 * worktree) added to the feature's prep. `behind`: main moves in it too, so
 * the integration merges it cleanly.
 */
export function addSecond(fx, ctx, { behind = false } = {}) {
  const repo = join(fx.dir, 'second');
  const wt = join(fx.dir, 'wt', 'second');
  const origin = join(fx.dir, 'second-origin.git');
  g(fx.dir, 'init', '-q', '--bare', '-b', 'main', origin);
  g(fx.dir, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'remote', 'add', 'origin', origin);
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'worktree', 'add', '-q', '-b', 'f1-feat', wt);
  writeFileSync(join(wt, 'file.txt'), 'reviewed work\n');
  g(wt, 'commit', '-q', '-am', 'reviewed');
  g(wt, 'push', '-q', 'origin', 'HEAD');
  if (behind) {
    writeFileSync(join(repo, 'main.txt'), 'main\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'main moves in second');
    g(repo, 'push', '-q', 'origin', 'main');
  }
  ctx.config.reposByName.second = repo;
  ctx.config.repos.second = { name: 'second', path: repo, deployable: true, update_tests: [] };
  ctx.prep.otherWorktrees.push({ repoName: 'second', worktreePath: wt });
  return { repo, wt };
}

/** A commit of `text` to second's file.txt, as a session would make it. */
export function commitSecond(wt, text, message) {
  writeFileSync(join(wt, 'file.txt'), text);
  g(wt, 'commit', '-q', '-am', message);
}

/** Clear `## Escalation` to "None.", as the operator does before a rerun. */
export function clearEscalation(fx) {
  const { fm, body } = parseFrontmatter(readFileSync(featureFile(fx), 'utf8'));
  const text = body.replace(/## Escalation\n[\s\S]*?(?=\n## |$(?![\s\S]))/, '## Escalation\n\nNone.\n');
  writeFileSync(featureFile(fx), serializeFrontmatter(fm) + text);
}
