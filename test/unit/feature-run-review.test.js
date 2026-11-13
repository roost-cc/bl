import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { runFeature, loadRunState, reviewFeature, RUN_DIR, OutcomeError } from '../../src/feature-run.js';
import { holderOf, release, tryLock } from '../../src/kernel-lock.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
import { spawnSync } from 'child_process';
import { featureReviewGate } from '../../src/review-log.js';
import { extractSection } from '../../src/feature.js';
import { _hooks as atomicHooks } from '../../src/atomic-write.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import {
  PENDING_END,
  setup,
  CH,
  editFile,
  checkAll,
  writeSession,
  verifySession,
  fakeRunner,
  statusOf,
  withContainers,
} from '../helpers/feature-run-fixture.js';
import { FIX_OUTCOME, reviewOutcome, SELF_REVIEW_OUTCOME } from '../helpers/outcomes.js';
import { validateOutcome } from '../../src/outcome.js';
import { loadSchema } from '../../src/session.js';
import { sessionLockPath } from '../../src/story.js';
import { reviewOf, statusOf as logStatusOf } from '../../src/transition.js';

// ---------------------------------------------------------------------------
// Quarantine against a real git worktree
// ---------------------------------------------------------------------------

function git(wt, ...args) {
  const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * `setup()` whose worktree is a real git repo with a.js, b.js, c.js, gone.js committed on main.
 * The fixture's unit directory is the worktree; its session lock file is in the backlog's
 * `.bl/lock/` (S-1495), not in it.
 */
function realGitSetup(extra) {
  const s = setup(extra);
  const wt = s.prep.worktreePath;
  git(wt, 'init', '-q', '-b', 'main');
  git(wt, 'config', 'user.email', 't@example.com');
  git(wt, 'config', 'user.name', 't');
  git(wt, 'config', 'commit.gpgsign', 'false');
  for (const f of ['a.js', 'b.js', 'c.js', 'gone.js']) writeFileSync(join(wt, f), `orig ${f}\n`);
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'base');
  return s;
}

/** fakeRunner whose git commands in the worktree run for real (stdout and stderr joined, as defaultRunner does). */
function realGitRunner(args, wt) {
  const runner = fakeRunner(args);
  const fake = runner.shell;
  runner.shell = (cmd, cwd) => {
    if (cwd === wt && cmd.startsWith('git ') && !/^git (push|rev-list --count origin)/.test(cmd)) {
      runner.calls.push({ type: 'shell', cmd, cwd });
      const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    }
    return fake(cmd, cwd);
  };
  return runner;
}

/** Everything a review session could disturb: HEAD, status, index, and every file's bytes. */
function treeState(wt) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(join(wt, d), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else files[rel] = readFileSync(join(wt, rel), 'utf8');
    }
  };
  walk('');
  return {
    head: git(wt, 'rev-parse', 'HEAD'),
    status: git(wt, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    index: git(wt, 'ls-files', '-s'),
    files,
  };
}

/** The operator's uncommitted work: an unstaged edit, a staged+unstaged edit, an untracked note, a deletion. */
function operatorWip(wt) {
  writeFileSync(join(wt, 'a.js'), 'OPERATOR WIP\n');
  writeFileSync(join(wt, 'b.js'), 'staged b\n');
  git(wt, 'add', 'b.js');
  writeFileSync(join(wt, 'b.js'), 'staged b\nplus unstaged\n');
  writeFileSync(join(wt, 'notes.md'), 'operator notes\n');
  rmSync(join(wt, 'gone.js'));
}

test('quarantine touches only what the review session changed and leaves the tree as it found it', async () => {
  const w = (wt, f, s) => writeFileSync(join(wt, f), s);
  // `operator: true` marks acts that only touch the operator's work, so on a
  // clean tree they change nothing.
  const acts = {
    'does nothing': { act: null },
    "edits the operator's modified file": { act: (wt) => w(wt, 'a.js', 'reviewer\n') },
    "stages the operator's work": { operator: true, act: (wt) => git(wt, 'add', '-A') },
    "unstages the operator's staged change": { operator: true, act: (wt) => git(wt, 'reset', '-q') },
    "edits the operator's untracked note": { act: (wt) => w(wt, 'notes.md', 'reviewer was here\n') },
    "deletes the operator's untracked note": {
      operator: true,
      act: (wt) => rmSync(join(wt, 'notes.md'), { force: true }),
    },
    "restores the operator's deleted file": { operator: true, act: (wt) => git(wt, 'checkout', '--', 'gone.js') },
    "discards all the operator's work": {
      operator: true,
      act: (wt) => {
        git(wt, 'reset', '-q', '--hard');
        git(wt, 'clean', '-qfd');
      },
    },
    'adds a new file': { act: (wt) => w(wt, 'zz-repro.test.js', 'probe\n') },
    'edits a clean tracked file': { act: (wt) => w(wt, 'c.js', 'reviewer edit\n') },
    'deletes a clean tracked file': { act: (wt) => rmSync(join(wt, 'c.js')) },
    'stages a new file': {
      act: (wt) => {
        w(wt, 'staged-probe.js', 'probe\n');
        git(wt, 'add', 'staged-probe.js');
      },
    },
    'renames a clean tracked file': { act: (wt) => git(wt, 'mv', 'c.js', 'd.js') },
    'commits its own file': {
      act: (wt) => {
        w(wt, 'committed-probe.js', 'probe\n');
        git(wt, 'add', 'committed-probe.js');
        git(wt, 'commit', '-q', '-m', 'probe');
      },
    },
    "commits the operator's work along with its own": {
      act: (wt) => {
        w(wt, 'c.js', 'reviewer edit\n');
        git(wt, 'add', '-A');
        git(wt, 'commit', '-q', '-m', 'everything');
      },
    },
  };
  for (const [name, { act, operator }] of Object.entries(acts)) {
    for (const preDirty of [true, false]) {
      const label = `${name}, ${preDirty ? 'operator WIP present' : 'clean tree'}`;
      const { dir, cleanup, config, feature, prep } = realGitSetup({ pr: '7' });
      const wt = prep.worktreePath;
      try {
        if (preDirty) operatorWip(wt);
        const before = treeState(wt);
        const runner = realGitRunner(
          { dir, feature, behaviour: { review: (o) => o.vars.dimension === 'correctness' && act?.(wt) } },
          wt,
        );
        const r = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
        assert.equal(r.error, null, label);
        assert.deepEqual(treeState(wt), before, `${label}: tree as the review found it`);
        const hygiene = loadRunState(config, 'F-1').history.filter((h) => h.step.startsWith('hygiene:'));
        const changedSomething = act != null && (preDirty || !operator);
        assert.deepEqual(
          hygiene.map((h) => h.step),
          changedSomething ? ['hygiene:r1-correctness'] : [],
          `${label}: only the pass that changed something is blamed`,
        );
      } finally {
        rmSync(wt, { recursive: true, force: true });
        cleanup();
      }
    }
  }
});

test("a reviewer's tracked edit is saved as tracked.patch and reverted", async () => {
  const { dir, cleanup, config, feature, prep } = realGitSetup({ pr: '7' });
  const wt = prep.worktreePath;
  try {
    operatorWip(wt);
    const runner = realGitRunner(
      {
        dir,
        feature,
        behaviour: {
          review: (o) => o.vars.dimension === 'failure-paths' && writeFileSync(join(wt, 'c.js'), 'reviewer edit\n'),
        },
      },
      wt,
    );
    const r = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(r.error, null);
    assert.equal(readFileSync(join(wt, 'c.js'), 'utf8'), 'orig c.js\n');
    assert.equal(readFileSync(join(wt, 'a.js'), 'utf8'), 'OPERATOR WIP\n', "operator's edit untouched");
    const qdir = join(dir, RUN_DIR, 'F-1.quarantine');
    const [pass] = readdirSync(qdir);
    assert.match(pass, /r1-failure-paths$/);
    const patch = readFileSync(join(qdir, pass, 'tracked.patch'), 'utf8');
    assert.match(patch, /\+reviewer edit/);
    assert.doesNotMatch(patch, /OPERATOR WIP/, "only the session's paths are in the patch");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    cleanup();
  }
});

test("a reviewer's commit is saved with format-patch and reset away", async () => {
  const { dir, cleanup, config, feature, prep } = realGitSetup({ pr: '7' });
  const wt = prep.worktreePath;
  try {
    const base = git(wt, 'rev-parse', 'HEAD');
    const runner = realGitRunner(
      {
        dir,
        feature,
        behaviour: {
          review: (o) => {
            if (o.vars.dimension !== 'correctness') return;
            writeFileSync(join(wt, 'b.js'), 'committed by reviewer\n');
            git(wt, 'commit', '-q', '-am', 'reviewer commit');
          },
        },
      },
      wt,
    );
    const r = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(r.error, null);
    assert.equal(git(wt, 'rev-parse', 'HEAD'), base);
    assert.equal(git(wt, 'status', '--porcelain'), '');
    assert.equal(readFileSync(join(wt, 'b.js'), 'utf8'), 'orig b.js\n');
    const qdir = join(dir, RUN_DIR, 'F-1.quarantine');
    const [pass] = readdirSync(qdir);
    const patches = readdirSync(join(qdir, pass, 'commits'));
    assert.equal(patches.length, 1);
    assert.match(
      readFileSync(join(qdir, pass, 'commits', patches[0]), 'utf8'),
      /reviewer commit[\s\S]*\+committed by reviewer/,
    );
    const ev = loadRunState(config, 'F-1').history.find((h) => h.step === 'hygiene:r1-correctness');
    assert.match(ev.note, /commits on the branch/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    cleanup();
  }
});

test("a reviewer's file with a non-ASCII or spaced name is quarantined", async () => {
  const names = ['prüfung.test.js', 'my probe.js', 'sub dir/ümlaut x.js', "quote'd.js"];
  const { dir, cleanup, config, feature, prep } = realGitSetup({ pr: '7' });
  const wt = prep.worktreePath;
  try {
    const runner = realGitRunner(
      {
        dir,
        feature,
        behaviour: {
          review: (o) => {
            if (o.vars.dimension !== 'correctness') return;
            mkdirSync(join(wt, 'sub dir'), { recursive: true });
            for (const n of names) writeFileSync(join(wt, n), `probe ${n}\n`);
          },
        },
      },
      wt,
    );
    const r = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(r.error, null);
    assert.equal(git(wt, 'status', '--porcelain', '--untracked-files=all'), '', 'nothing left behind');
    const qdir = join(dir, RUN_DIR, 'F-1.quarantine');
    const [pass] = readdirSync(qdir);
    for (const n of names) assert.equal(readFileSync(join(qdir, pass, 'untracked', n), 'utf8'), `probe ${n}\n`, n);
    const ev = loadRunState(config, 'F-1').history.find((h) => h.step === 'hygiene:r1-correctness');
    assert.match(ev.note, /reviewer left 4 untracked files/);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    cleanup();
  }
});

test('a git status failure reads as dirty: the gate fails and a review round stops', async () => {
  // The test gate.
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          shell: (cmd) =>
            cmd.startsWith('git status') ? { status: 128, output: 'fatal: not a git repository\n' } : null,
        },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated');
      assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 0, 'the suite never ran');
      assert.ok(state.history.some((h) => h.step === 'test' && h.ok === false && /git status failed/.test(h.note)));
    } finally {
      cleanup();
    }
  }
  // A review pass: before it, or after it.
  for (const failAt of ['before', 'after']) {
    const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
    try {
      let passes = 0;
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          review: () => {
            passes += 1;
          },
          shell: (cmd) =>
            cmd.startsWith('git status') && (failAt === 'before' || passes > 0)
              ? { status: 128, output: 'fatal\n' }
              : null,
        },
      });
      const r = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
      assert.ok(r.error, failAt);
      assert.equal(passes, failAt === 'before' ? 0 : 1, `${failAt}: no pass ran on a tree it could not snapshot`);
      assert.ok(!runner.calls.some((c) => c.prompt === 'review-verify'), `${failAt}: no verifier`);
      assert.equal(loadRunState(config, 'F-1').status, 'failed', failAt);
    } finally {
      cleanup();
    }
  }
});

test("bl review on a two-repo feature spends one round and keeps both repos' open items gating", async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  const wtB = mkTempDir('bl-wt-b-');
  try {
    const probe = 'zz-probe.js';
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        // A reviewer leaves a probe in the secondary repo's worktree.
        review: (o) => o.vars.dimension === 'correctness' && writeFileSync(join(wtB, probe), 'probe\n'),
        // The verifier records one session for both PRs; the open Must is repo B's.
        verify: () => {
          editFile(CH(feature), (fm, body) => {
            const block =
              '### Session 2026-09-24 (PR #7, #12)\n\n**Must fix**\n\n- [ ] repo-b: invariant Y — Repro: y. Test: z.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n';
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
          return reviewOutcome({ must: 1 });
        },
      },
    });
    const shell = runner.shell;
    runner.shell = (cmd, cwd) => (cwd === wtB ? statusOf(wtB, [probe])(cmd) : null) ?? shell(cmd, cwd);
    const otherRepos = [
      { repoName: 'repo-b', worktreePath: wtB, pr: { number: '12', url: 'https://github.com/x/b/pull/12' } },
    ];
    const r = await reviewFeature({
      feature,
      config,
      prep,
      runner,
      pr: { number: '7', url: 'u' },
      otherRepos,
      maxRounds: 3,
    });
    assert.deepEqual(r, { status: 'fixing', round: 1, verdict: true, escalated: false, error: null, end: PENDING_END });
    const sessions = runner.calls.filter((c) => c.type === 'session');
    assert.equal(sessions.filter((c) => c.prompt === 'review-verify').length, 1, 'one verifier: one round spent');
    for (const s of sessions) {
      assert.match(
        s.vars.reviewScope,
        /repo-b: PR #12 https:\/\/github\.com\/x\/b\/pull\/12/,
        `${s.prompt} covers repo B's PR`,
      );
      assert.ok(s.vars.reviewScope.includes(wtB), `${s.prompt} names repo B's worktree`);
      assert.equal(s.vars.prNumber, '7', `${s.prompt}: the primary PR`);
    }
    const { body } = parseFrontmatter(readFileSync(CH(feature), 'utf8'));
    const unitFm = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
    assert.equal(reviewOf('feature', unitFm).reviewed, 1);
    assert.equal(loadRunState(config, 'F-1').pr.number, '7', 'run state keeps the primary PR');
    assert.equal(
      featureReviewGate(logStatusOf('feature', unitFm), body).blocked,
      true,
      "repo B's open Must gates the merge",
    );
    assert.equal(existsSync(join(wtB, probe)), false, 'the secondary worktree is quarantined too');
  } finally {
    rmSync(wtB, { recursive: true, force: true });
    cleanup();
  }
});

test('featureReviewGate blocks an open Must in a CRLF feature file', async () => {
  // Every session shape the gate distinguishes, with each review_status: the
  // CRLF verdict must equal the LF one.
  const sessions = {
    'open Must': { must: '- [ ] invariant X', should: 'None.', nits: 'None.' },
    'open Should': { must: 'None.', should: '* [ ] invariant Y', nits: 'None.' },
    'open nit only': { must: 'None.', should: 'None.', nits: '- [ ] [safe] rename' },
    'all checked': { must: '- [x] invariant X', should: 'None.', nits: 'None.' },
  };
  for (const [name, s] of Object.entries(sessions)) {
    const lf = `# F\n\n## Review Log\n\n### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\n${s.must}\n\n**Should fix**\n\n${s.should}\n\n**Nits**\n\n${s.nits}\n\n## Escalation\n\nNone.\n`;
    const crlf = lf.replace(/\n/g, '\r\n');
    for (const status of ['pending', 'fixed', 'addressed', '']) {
      const a = featureReviewGate(status, lf);
      const b = featureReviewGate(status, crlf);
      assert.deepEqual(b, a, `${name}, ${status || 'unset'}`);
      assert.ok(a.review, `${name}: the session is read`);
    }
  }
  assert.equal(
    featureReviewGate(
      'addressed',
      '## Review Log\r\n\r\n### Session 2026-09-24 (PR #7)\r\n\r\n**Must fix**\r\n\r\n- [ ] x\r\n',
    ).blocked,
    true,
  );

  // The loop reads the CRLF file the same way: an `addressed` verdict with an
  // open Must escalates with the open items instead of ending clean.
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const toCrlf = () =>
      writeFileSync(feature.indexPath, readFileSync(feature.indexPath, 'utf8').replace(/\r?\n/g, '\r\n'));
    toCrlf();
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          writeFileSync(feature.indexPath, readFileSync(feature.indexPath, 'utf8').replace(/\r\n/g, '\n'));
          editFile(CH(feature), (fm, body) => {
            const block =
              '### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\n- [ ] invariant X\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n';
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
          toCrlf();
          // An outcome that missed the open Must: bl writes addressed, and the gate catches it.
          return reviewOutcome();
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /1 open Must\/Should item/);
    assert.match(
      readFileSync(feature.indexPath, 'utf8'),
      /Open items from session 2026-09-24:\r\n\r\n- \[ \] invariant X/,
    );
  } finally {
    cleanup();
  }
});

test('an escalation flags an open item whose → note names a commit, and the item still escalates (S-1292)', async () => {
  // F-78's shape: the fixer wrote `→ c531dab.` but left the box unticked.
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          editFile(CH(feature), (fm, body) => {
            const block =
              '### Session 2026-09-24 (PR #7)\n\n**Must fix**\nNone.\n\n**Should fix**\n\n' +
              '- [ ] guard checks pathspec elements\n      → c531dab. fixed every instance\n' +
              '- [ ] second item\n\n**Nits**\nNone.\n';
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
          return reviewOutcome();
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const text = readFileSync(feature.indexPath, 'utf8');
    assert.match(
      text,
      /- \[ \] guard checks pathspec elements → c531dab\. fixed every instance \(has a resolution note naming\s+c531dab, but its box is unticked: possible oversight\)/,
    );
    assert.match(text, /- \[ \] second item\n/);
  } finally {
    cleanup();
  }
});

test('the test gate refuses a dirty tree with no test plugin configured', async () => {
  // Leftovers from each step the gate follows: a story, the self-review, a fix round.
  for (const leftBy of ['story', 'selfReview', 'fix']) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const stray = `left-by-${leftBy}.js`;
      const leave = () => writeFileSync(join(prep.worktreePath, stray), 'x\n');
      let fixLog = null;
      const base = fakeRunner({ dir, feature });
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          story: (o) => {
            checkAll(o.vars.storyAbsPath);
            if (leftBy === 'story') leave();
          },
          selfReview: () => {
            if (leftBy === 'selfReview') {
              runner.bumpHead();
              leave();
            }
          },
          fix: (o) => {
            if (leftBy === 'fix') leave();
            return base.session({ ...o, promptName: 'feature-workon-review' }).structured;
          },
          shell: statusOf(prep.worktreePath, [stray]),
          fixTests: (o) => {
            fixLog = o.vars;
            rmSync(join(prep.worktreePath, stray));
          },
        },
      });
      runner.testPlugins = () => ({ plugins: [], unknown: [] });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', `${leftBy}: ${JSON.stringify(state.history.slice(-3))}`);
      assert.ok(fixLog, `${leftBy}: the dirty tree went to fix-tests`);
      assert.match(fixLog.testExcerpt, new RegExp(`\\?\\? ${stray.replace(/\./g, '\\.')}`), leftBy);
      assert.ok(
        state.history.some((h) => h.step === 'test' && h.ok === false && /worktree not clean/.test(h.note)),
        leftBy,
      );
    } finally {
      cleanup();
    }
  }
});

test("review passes and the verifier run on the first review_agent configuration; implementation stays on agent's", async () => {
  const { dir, cleanup, feature, prep } = setup();
  try {
    const cfgPath = join(dir, 'backlog.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfgPath, 'utf8')),
        agent: [{ agent: 'claude', model: 'opus' }],
        review_agent: [
          { agent: 'codex', model: 'gpt-6-sol' },
          { agent: 'claude', model: 'sonnet' },
        ],
      }),
    );
    const config = loadConfig({ backlogRoot: dir });
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep: { ...prep, cfg: config }, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const byPrompt = {};
    for (const c of runner.calls.filter((c) => c.type === 'session'))
      (byPrompt[c.prompt] ??= new Set()).add(`${c.agent} ${c.model}`);
    for (const p of ['review-correctness', 'review-failure-paths', 'review-verify']) {
      assert.deepEqual(
        [...byPrompt[p]],
        ['codex gpt-6-sol'],
        `${p} runs on the review configuration, with its own model`,
      );
    }
    for (const p of ['feature-story', 'feature-self-review', 'feature-workon-review']) {
      assert.deepEqual([...byPrompt[p]], ['claude opus'], `${p} runs on the implementing configuration`);
    }
  } finally {
    cleanup();
  }
});

test('a review round over a unit directory takes its one session lock, not one per worktree', async () => {
  const s = setup({ pr: '7' });
  try {
    s.prep.unitDir = mkTempDir('bl-unit-');
    const others = ['repo-b', 'repo-c'].map((r) => join(s.prep.unitDir, r));
    for (const wt of others) mkdirSync(wt);
    const lock = sessionLockPath(s.config.backlogRoot, s.prep.unitDir);
    const runner = fakeRunner({
      dir: s.dir,
      feature: s.feature,
      behaviour: { verify: () => verifySession(CH(s.feature), { pending: false, round: 1 }) },
    });
    const seen = [];
    const session = runner.session;
    runner.session = (o) => {
      seen.push({
        unit: existsSync(lock) ? readFileSync(lock, 'utf8').split('\n', 1)[0] : null,
        worktrees: others.filter((wt) => existsSync(sessionLockPath(s.config.backlogRoot, wt))),
      });
      return session(o);
    };
    const otherRepos = others.map((wt, i) => ({
      repoName: `repo-${i}`,
      worktreePath: wt,
      pr: { number: String(12 + i), url: 'u' },
    }));
    const r = await reviewFeature({
      feature: s.feature,
      config: s.config,
      prep: s.prep,
      runner,
      pr: { number: '7', url: 'u' },
      otherRepos,
      maxRounds: 3,
    });
    assert.equal(r.error, null);
    assert.equal(seen.length, 3);
    for (const x of seen) {
      assert.equal(x.unit, String(process.pid), 'the unit directory is locked by this process');
      assert.deepEqual(x.worktrees, [], 'no lock inside a worktree under it');
    }
    assert.equal(holderOf(lock), null, 'released after the round');

    // A live session in the unit directory: no pass runs.
    const live = await holdLockInChild(lock);
    seen.length = 0;
    const held = await reviewFeature({
      feature: s.feature,
      config: s.config,
      prep: s.prep,
      runner,
      pr: { number: '7', url: 'u' },
      otherRepos,
      maxRounds: 3,
    }).finally(() => live.kill());
    assert.deepEqual(seen, []);
    assert.match(
      held.error,
      new RegExp(`a live session \\(pid ${live.pid}\\) holds ${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );

    // A session lock that cannot be opened (a directory in its place): no pass runs either.
    rmSync(lock);
    mkdirSync(lock);
    const unusable = await reviewFeature({
      feature: s.feature,
      config: s.config,
      prep: s.prep,
      runner,
      pr: { number: '7', url: 'u' },
      otherRepos,
      maxRounds: 3,
    });
    assert.deepEqual(seen, []);
    assert.match(unusable.error, /\/\.bl\/lock\/session-.* could not be opened: /);
  } finally {
    s.cleanup();
  }
});

test('a review round locks every scoped worktree and aborts without verification when any pass fails', async () => {
  // Another process trying to start a session on the lock `path`: what its try-lock tells it.
  const otherProcessTakes = (path) => {
    const src = `import { tryLock } from ${JSON.stringify(new URL('../../src/kernel-lock.js', import.meta.url).href)};
const t = tryLock(${JSON.stringify(path)}, 'other');
console.log(t.taken ? "taken" : "held by " + t.holder);`;
    return spawnSyncFiles(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }).stdout.trim();
  };
  const PASSES = ['review-correctness', 'review-failure-paths', 'review-verify'];
  // `preLock.hold(path)` holds a worktree's lock before the round and returns its release.
  const scenario = async ({
    failAt = null,
    preLock = null,
    failure = { ok: false, isError: true, error: 'provider crashed' },
  }) => {
    const s = setup({ pr: '7' });
    const lockOf = (wt) => sessionLockPath(s.config.backlogRoot, wt);
    const others = [mkTempDir('bl-wt-b-'), mkTempDir('bl-wt-c-')];
    const all = [s.prep.worktreePath, ...others];
    const releasePre = preLock ? await preLock.hold(lockOf(all[preLock.at])) : () => {};
    try {
      const runner = fakeRunner({
        dir: s.dir,
        feature: s.feature,
        behaviour: { verify: () => verifySession(CH(s.feature), { pending: false, round: 1 }) },
      });
      const seen = [];
      const session = runner.session;
      runner.session = (o) => {
        seen.push({
          prompt: o.promptName,
          locks: all.map((wt) => (existsSync(lockOf(wt)) ? readFileSync(lockOf(wt), 'utf8').split('\n', 1)[0] : null)),
          other: o.promptName === 'review-correctness' ? all.map((wt) => otherProcessTakes(lockOf(wt))) : null,
        });
        const r = session(o);
        return o.promptName === failAt ? { ...r, ...failure } : r;
      };
      const before = readFileSync(s.feature.indexPath, 'utf8');
      const otherRepos = others.map((wt, i) => ({
        repoName: `repo-${i}`,
        worktreePath: wt,
        pr: { number: String(12 + i), url: 'u' },
      }));
      const r = await reviewFeature({
        feature: s.feature,
        config: s.config,
        prep: s.prep,
        runner,
        pr: { number: '7', url: 'u' },
        otherRepos,
        maxRounds: 3,
      });
      return {
        r,
        seen,
        before,
        after: readFileSync(s.feature.indexPath, 'utf8'),
        locksAfter: all.map((wt) => holderOf(lockOf(wt))),
        state: loadRunState(s.config, 'F-1'),
      };
    } finally {
      await releasePre();
      for (const wt of others) rmSync(wt, { recursive: true, force: true });
      s.cleanup();
    }
  };

  // Every session of a clean round runs with every scoped worktree locked by
  // this process; another process is refused each one; all are released after.
  const ok = await scenario({});
  assert.deepEqual(ok.r, {
    status: 'ready_for_merge',
    round: 1,
    verdict: true,
    escalated: false,
    error: null,
    end: { outcome: 'nothing left to fix', cap: '', next: 'bl merge F-1' },
  });
  assert.deepEqual(
    ok.seen.map((x) => x.prompt),
    PASSES,
  );
  for (const x of ok.seen)
    assert.deepEqual(
      x.locks,
      [String(process.pid), String(process.pid), String(process.pid)],
      `${x.prompt}: every worktree locked`,
    );
  assert.deepEqual(
    ok.seen[0].other,
    [`held by ${process.pid}`, `held by ${process.pid}`, `held by ${process.pid}`],
    'a concurrent session is refused in every worktree',
  );
  assert.deepEqual(ok.locksAfter, [null, null, null], 'every lock the round took is released');

  // A lock this process already held is used and left held.
  const own = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    const { taken } = tryLock(path, 'F-1 run');
    return () => release(taken);
  };
  const kept = await scenario({ preLock: { at: 1, hold: own } });
  assert.equal(kept.r.error, null);
  assert.deepEqual(kept.locksAfter, [null, process.pid, null]);

  // A live session in any scoped worktree: no pass runs, its lock is untouched,
  // and nothing the round took is left behind.
  for (const at of [0, 1, 2]) {
    let pid;
    const live = async (path) => {
      const child = await holdLockInChild(path);
      pid = child.pid;
      return () => child.kill();
    };
    const x = await scenario({ preLock: { at, hold: live } });
    assert.deepEqual(x.seen, [], `worktree ${at} held: no session ran`);
    assert.match(x.r.error, new RegExp(`a live session \\(pid ${pid}\\) holds`));
    // No session failed: the error is today's, with no cause line and no failure text (S-1140).
    assert.doesNotMatch(x.r.error, /not a capacity refusal/);
    assert.equal(x.r.details, undefined);
    assert.equal(x.after, x.before, `worktree ${at} held: the feature file is untouched`);
    assert.deepEqual(
      x.locksAfter,
      [0, 1, 2].map((i) => (i === at ? pid : null)),
    );
    assert.equal(x.state.status, 'failed');
  }

  // Any failed session — a dimension pass or the verifier, reported as an
  // error or only as not ok — aborts the round before a verdict: no later
  // session runs, review_round and review_status stay where they were, even
  // when the failed verifier wrote a verdict, and every lock is released.
  const failures = [
    { ok: false, isError: true, error: 'provider crashed' },
    { ok: false, isError: true, output: 'Error: rate limited' },
    { ok: false },
  ];
  for (const failAt of PASSES) {
    for (const failure of failures) {
      const x = await scenario({ failAt, failure });
      const name = `${failAt} fails with ${JSON.stringify(failure)}`;
      assert.deepEqual(
        x.seen.map((s) => s.prompt),
        PASSES.slice(0, PASSES.indexOf(failAt) + 1),
        `${name}: nothing runs after it`,
      );
      assert.match(x.r.error, /failed: .* — unknown — not a capacity refusal bl recognised$/, name);
      // The step, the time, the raw error and the steps to rule capacity in or out (S-1140).
      const step = failAt === 'review-verify' ? 'verifier' : failAt.slice('review-'.length);
      assert.ok(x.r.details.includes(`Step: review round 1 ${step}, failed at `), `${name}: ${x.r.details}`);
      assert.match(x.r.details, /\nError: .+\n/, name);
      assert.match(x.r.details, /\n1\. Run `bl capacity`.*\n2\. Fix what that shows\.\n/, name);
      assert.equal(x.r.verdict, false, `${name}: no verdict`);
      assert.equal(x.r.status, 'in_review', `${name}: the unit stays in review`);
      assert.equal(x.r.round, 0, `${name}: the round is not spent`);
      assert.equal(parseFrontmatter(x.after).fm.review_status, undefined, name);
      // The review started (F-69 D3): the log holds `in_review`, so the next
      // round resumes it without another entry; nothing else changed.
      assert.equal(logStatusOf('feature', parseFrontmatter(x.after).fm), 'in_review', name);
      assert.equal(parseFrontmatter(x.after).body, parseFrontmatter(x.before).body, `${name}: the body is as it was`);
      assert.deepEqual(x.locksAfter, [null, null, null], `${name}: locks released`);
      assert.equal(x.state.status, 'failed', name);
      assert.ok(
        x.state.history.some((h) => h.step === 'review:abort'),
        `${name}: recorded`,
      );
    }
  }
});

test('the loop escalates a review round aborted by a failed pass instead of reading a verdict', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { verify: () => verifySession(CH(feature), { pending: false, round: 1 }) },
    });
    const session = runner.session;
    runner.session = (o) =>
      o.promptName === 'review-failure-paths'
        ? { ...session(o), ok: false, isError: true, error: 'provider crashed' }
        : session(o);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(
      state.lastError,
      'review round 1 aborted before a verdict — unknown — not a capacity refusal bl recognised',
    );
    // The step, the configuration, the raw error and the unknown steps (S-1140).
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(esc.includes('\nthe failure-paths pass failed: provider crashed\n'), esc);
    assert.ok(esc.includes('\nStep: review round 1 failure-paths, failed at '), esc);
    assert.match(esc, /\n- \S+ \S+[^\n]*\n\nError: provider crashed\n/);
    assert.match(
      esc,
      /\n1\. Run `bl capacity`[^\n]*\n2\. Fix what that shows\.\n3\. Clear `## Escalation` to `None\.`\.\n4\. Run `bl run F-1 --resume`\.\n?$/,
    );
    assert.equal(runner.calls.filter((c) => c.type === 'session' && c.prompt === 'review-verify').length, 0);
    assert.notEqual(parseFrontmatter(readFileSync(CH(feature), 'utf8')).fm.review_status, 'addressed');
  } finally {
    cleanup();
  }
});

test("every fix round is followed by a fix self-review scoped to the last review's commit, before the test gate", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
    const seq = runner.calls
      .filter((c) => c.type === 'session' || c.cmd === 'npm test')
      .map((c) => (c.type === 'session' ? c.prompt : 'GATE'));
    const fix = seq.indexOf('feature-workon-review');
    assert.deepEqual(seq.slice(fix, fix + 3), ['feature-workon-review', 'feature-fix-self-review', 'GATE']);
    const selfReview = runner.calls.find((c) => c.prompt === 'feature-fix-self-review');
    assert.match(selfReview.vars.fixDiff, /^git diff sha\d+\.\.HEAD$/, 'scoped to the commit the last review saw');
    assert.equal(selfReview.vars.fixBaseSha, selfReview.vars.fixDiff.split(' ')[2].split('..')[0]);
    assert.ok(state.history.some((h) => h.step === 'fix-self-review'));
  } finally {
    cleanup();
  }
});

test('a pending session with no recorded review commit scopes the fix self-review to the fix session, not the branch', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    // Written by hand or by an earlier run whose state is gone: no reviewBaseSha.
    writeSession(CH(feature), { pending: true, round: 1 });
    let runner;
    runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        fix: () => {
          runner.bumpHead();
          editFile(CH(feature), (fm, body) => body.replaceAll('- [ ] invariant', '- [x] invariant'));
        },
        verify: () => verifySession(CH(feature), { pending: false, round: 2 }),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
    const selfReview = runner.calls.find((c) => c.prompt === 'feature-fix-self-review');
    assert.equal(selfReview.vars.fixDiff, 'git diff sha0..HEAD', 'the commit the fix session started from');
  } finally {
    cleanup();
  }
});

test('a session that throws still has its containers removed, and the error propagates', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const base = fakeRunner({ dir, feature });
    const runner = withContainers(base, {
      during: { 'review-correctness': [{ id: 'ggg', name: 'minio-in-memory', compose: false }] },
    });
    const session = runner.session;
    runner.session = (o) => {
      const r = session(o);
      if (o.promptName === 'review-correctness') throw new Error('agent crashed');
      return r;
    };
    await assert.rejects(runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }), /agent crashed/);
    assert.deepEqual(runner.removed, ['ggg']);
  } finally {
    cleanup();
  }
});

test('a returned fix-self-review failure stops before the test gate and re-review', async () => {
  // A session that failed but returned an outcome, and one whose outcome says
  // the fix is not ready (F-68 D2).
  const failures = {
    'ok: false': { ok: false, isError: true, error: 'provider failed', output: '', structured: SELF_REVIEW_OUTCOME },
    'isError with ok': { ok: true, isError: true, output: 'half done', structured: SELF_REVIEW_OUTCOME },
    'outcome ok: false': {
      ok: true,
      isError: false,
      output: '',
      structured: { summary: 'item 1 needs a redesign', ok: false, changed: false },
    },
  };
  for (const [kind, result] of Object.entries(failures)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({ dir, feature });
      const session = runner.session;
      runner.session = (o) => {
        const r = session(o);
        return o.promptName === 'feature-fix-self-review' ? result : r;
      };
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated', kind);
      assert.match(state.lastError, /fix self-review for round 1 failed/, kind);
      if (kind === 'outcome ok: false') assert.match(state.lastError, /failed: item 1 needs a redesign/);
      const after = runner.calls.slice(runner.calls.findIndex((c) => c.prompt === 'feature-fix-self-review') + 1);
      assert.ok(!after.some((c) => c.cmd === 'npm test'), `${kind}: no test gate after it`);
      assert.ok(!after.some((c) => c.prompt?.startsWith('review-')), `${kind}: no re-review after it`);
      assert.equal(loadRunState(config, 'F-1').status, 'escalated', kind);
    } finally {
      cleanup();
    }
  }
  // A thrown failure still stops the run.
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const session = runner.session;
    runner.session = (o) => {
      if (o.promptName === 'feature-fix-self-review') throw new Error('agent crashed');
      return session(o);
    };
    await assert.rejects(runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }), /agent crashed/);
    const after = runner.calls.slice(runner.calls.findIndex((c) => c.prompt === 'feature-workon-review') + 1);
    assert.ok(!after.some((c) => c.cmd === 'npm test' || c.prompt?.startsWith('review-')));
  } finally {
    cleanup();
  }
});

test('a fix self-review with permission denials but a good result continues to the gate and re-review', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const session = runner.session;
    runner.session = (o) => {
      const r = session(o);
      return o.promptName === 'feature-fix-self-review'
        ? { ...r, output: 'FIX SELF-REVIEW DONE', denials: ['Bash(cd /wt && rg foo)', 'Bash(cp a /tmp/a)'] }
        : r;
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', 'denials are warnings, not failures');
    const after = runner.calls.slice(runner.calls.findIndex((c) => c.prompt === 'feature-fix-self-review') + 1);
    assert.ok(
      after.some((c) => c.cmd === 'npm test'),
      'the test gate still runs',
    );
    assert.ok(
      after.some((c) => c.prompt === 'review-verify'),
      'the re-review still runs',
    );
    const ev = state.history.find((h) => h.step === 'fix-self-review');
    assert.match(ev.note, /denied: Bash\(cd \/wt && rg foo\); Bash\(cp a \/tmp\/a\)/, 'still visible in the history');
    // As a list too, for bl top's detail box (S-1334).
    assert.deepEqual(ev.denials, ['Bash(cd /wt && rg foo)', 'Bash(cp a /tmp/a)']);
  } finally {
    cleanup();
  }
});

test('a review round that ends without a verdict records none in the log', async () => {
  // Each case breaks the round at one point after the verifier starts. The
  // unit's log must hold no verdict for the round (F-69 D5), and a rerun at a
  // cap of 1 must review.
  const cases = [
    {
      name: 'the verifier session throws a plain Error',
      session: () => {
        throw new Error('simulated crash');
      },
    },
    {
      name: 'the verifier stops the run (no valid outcome)',
      session: () => {
        throw new OutcomeError('no valid outcome', null);
      },
    },
    {
      name: 'the quarantine fails after a good verifier',
      verify: (s) => {
        s.failRevParse = true;
      },
    },
    {
      name: 'writing the verdict fails after a good verifier',
      verify: () => {
        atomicHooks.beforeRename = (tmp) => {
          if (!readFileSync(tmp, 'utf8').includes('to: ready_for_merge')) return;
          atomicHooks.beforeRename = null;
          throw new Error('injected change write failure');
        };
      },
    },
    {
      // A killed bl leaves the log as it was while the verifier ran.
      name: 'bl is killed while the verifier runs',
      verify: (s, feature) => {
        s.whileVerifying = reviewedOf(feature);
      },
    },
  ];
  // The rounds with a verdict, and whether the last one has one.
  const reviewedOf = (feature) => {
    const r = reviewOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm);
    return { reviewed: r.reviewed, verdict: r.position === 'fixing' || r.position === 'ready_for_merge' };
  };
  for (const c of cases) {
    const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
    const s = { failRevParse: false, whileVerifying: null, broken: true };
    try {
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          verify: () => {
            if (s.broken) c.verify?.(s, feature);
            return verifySession(CH(feature), { pending: false, round: 1 });
          },
          shell: (cmd) => (s.failRevParse && cmd.startsWith('git rev-parse HEAD') ? { status: 1, output: '' } : null),
        },
      });
      const session = runner.session;
      runner.session = (o) => {
        if (s.broken && c.session && o.promptName === 'review-verify') c.session();
        return session(o);
      };
      const before = reviewedOf(feature);
      try {
        await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 3 });
      } catch {
        // A plain Error unwinds; the log is what this test checks.
      }
      atomicHooks.beforeRename = null;
      if (c.name.includes('killed')) {
        // The fake round itself finishes; what a kill would leave is what matters.
        assert.deepEqual(s.whileVerifying, before, `${c.name}: the log while the verifier ran`);
        continue;
      }
      assert.deepEqual(reviewedOf(feature), before, `${c.name}: the log after the round`);
      s.broken = false;
      s.failRevParse = false;
      const r = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 1 });
      assert.equal(r.round, 1, `${c.name}: a rerun at a cap of 1 reviews`);
      assert.deepEqual(reviewedOf(feature), { reviewed: 1, verdict: true }, `${c.name}: with a verdict`);
    } finally {
      atomicHooks.beforeRename = null;
      cleanup();
    }
  }
});

test('review_outcome_decides_the_round: the loop takes each branch from the outcomes and records it in the log', async () => {
  // `seen` holds the unit's review state (F-69 D5) as each session starts, as
  // <rounds with a verdict>/<position>, `+fix` when a fix opened the round:
  // the verifier sees the round open (bl records the verdict after it
  // returns), the fix and its self-review see the verdict's `fixing`, the
  // re-review sees the round the fix opened. `final` is the run's end.
  const FIXED_NOT = { summary: 'item 1 needs the operator', fixed: false, open: 1 };
  const cases = [
    {
      name: 'must: 1 → a fix round, then a clean re-review',
      verdicts: [{ must: 1 }, {}],
      expect: 'clean',
      seen: ['verify 0/in_review', 'fix 1/fixing', 'fix-self-review 1/fixing', 'verify 1/in_review+fix'],
      final: '2/ready_for_merge',
    },
    {
      name: 'should: 1 → a fix round',
      verdicts: [{ should: 1 }, {}],
      expect: 'clean',
      seen: ['verify 0/in_review', 'fix 1/fixing', 'fix-self-review 1/fixing', 'verify 1/in_review+fix'],
      final: '2/ready_for_merge',
    },
    {
      name: 'must: 0, should: 0 → clean, open nits or not',
      verdicts: [{ nits: 2 }],
      expect: 'clean',
      seen: ['verify 0/in_review'],
      final: '1/ready_for_merge',
    },
    {
      name: 'fixed: false → escalates, the items left in fixing',
      verdicts: [{ must: 1 }],
      fix: FIXED_NOT,
      expect: 'escalated',
      error: /^fix session for round 1 left 1 item\(s\) open: item 1 needs the operator$/,
      seen: ['verify 0/in_review', 'fix 1/fixing'],
      final: '1/fixing',
    },
    {
      name: 'escalated: true with no ## Escalation → bl writes it',
      verdicts: [{ must: 1, escalated: true }],
      expect: 'escalated',
      error: /^reviewer escalated in round 1$/,
      escalation: /review round 1: the verifier escalated\n\nThe verifier's outcome: open items/,
      seen: ['verify 0/in_review'],
      final: '1/fixing',
    },
  ];
  for (const c of cases) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const fields = () => {
        const r = reviewOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm);
        return `${r.reviewed}/${r.position}${r.fixed ? '+fix' : ''}`;
      };
      const seen = [];
      let round = 0;
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          verify: () => {
            seen.push(`verify ${fields()}`);
            const v = c.verdicts[round++] ?? {};
            const pending = (v.must ?? 0) + (v.should ?? 0) > 0;
            verifySession(CH(feature), { pending, round });
            return reviewOutcome(v);
          },
          fix: () => {
            seen.push(`fix ${fields()}`);
            editFile(CH(feature), (fm, body) => body.replaceAll('- [ ] invariant', '- [x] invariant'));
            return c.fix ?? FIX_OUTCOME;
          },
          fixSelfReview: () => void seen.push(`fix-self-review ${fields()}`),
        },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, c.expect, `${c.name}: ${state.lastError}`);
      if (c.error) assert.match(state.lastError, c.error, c.name);
      assert.deepEqual(seen, c.seen, c.name);
      assert.equal(fields(), c.final, c.name);
      for (const o of [...c.verdicts.map(reviewOutcome), c.fix ?? FIX_OUTCOME]) {
        assert.equal(validateOutcome(loadSchema(o.fixed == null ? 'review' : 'fix'), o).structuredError, null);
      }
      if (c.escalation) {
        const { body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
        assert.match(extractSection(body, 'Escalation'), c.escalation, c.name);
      }
      // Every step with an outcome records it, never a last line.
      for (const h of state.history.filter((e) => ['review:verify', 'fix', 'fix-self-review'].includes(e.step))) {
        if (!h.warning) assert.match(h.note, /outcome: /, `${c.name}: ${h.step}`);
      }
    } finally {
      cleanup();
    }
  }
});

test('a failed verdict write stops the run instead of continuing', async () => {
  // [the verdict, the entry whose write fails]
  const cases = [
    [{ must: 1 }, 'to: fixing'],
    [{}, 'to: ready_for_merge'],
  ];
  for (const [verdict, entry] of cases) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const steps = [];
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          verify: () => {
            steps.push('verify');
            verifySession(CH(feature), { pending: (verdict.must ?? 0) > 0, round: 1 });
            atomicHooks.beforeRename = (tmp) => {
              if (!readFileSync(tmp, 'utf8').includes(entry)) return;
              atomicHooks.beforeRename = null;
              throw new Error('injected log write failure');
            };
            return reviewOutcome(verdict);
          },
          fix: () => {
            steps.push('fix');
            return FIX_OUTCOME;
          },
        },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'failed', `${entry}: ${state.lastError}`);
      assert.match(state.lastError, /^the transition log could not be written at review: .*injected log write failure/);
      assert.deepEqual(steps, ['verify'], `${entry}: no step after the failed write`);
      const r = reviewOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm);
      assert.equal(r.position, 'in_review', `${entry}: no verdict in the log`);
    } finally {
      atomicHooks.beforeRename = null;
      cleanup();
    }
  }
});

test('a log write that fails during bl review is reported as failed, not escalated', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          verifySession(CH(feature), { pending: true, round: 1 });
          atomicHooks.beforeRename = (tmp) => {
            if (!readFileSync(tmp, 'utf8').includes('to: fixing')) return;
            atomicHooks.beforeRename = null;
            throw new Error('injected log write failure');
          };
          return reviewOutcome({ must: 1 });
        },
      },
    });
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(result.escalated, false);
    assert.equal(result.end, null, 'no escalation end, which would tell the operator to clear ## Escalation');
    assert.match(result.error, /^the transition log could not be written at review: .*injected log write failure/);
    assert.equal(loadRunState(config, 'F-1').status, 'failed');
    const body = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).body;
    assert.match(extractSection(body, 'Escalation')?.trim() ?? 'None.', /^None\.$/);
  } finally {
    atomicHooks.beforeRename = null;
    cleanup();
  }
});

test('the fake agents return outcomes their schemas accept', () => {
  for (const [name, o] of [
    ['review', reviewOutcome({ pending: true })],
    ['fix', FIX_OUTCOME],
    ['self-review', SELF_REVIEW_OUTCOME],
  ]) {
    assert.equal(validateOutcome(loadSchema(name), o).structuredError, null, name);
  }
  // A count that is not a whole number, or a missing field, is no outcome.
  assert.match(
    validateOutcome(loadSchema('review'), { summary: 's', must: 1.5, should: 0, nits: 0, escalated: false })
      .structuredError,
    /schema violation at \$\/must/,
  );
  assert.match(validateOutcome(loadSchema('fix'), { summary: 's', fixed: true }).structuredError, /schema violation/);
});

test('a fix self-review that writes the old review_status changes nothing: bl re-reviews the fixes', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        fixSelfReview: () =>
          editFile(CH(feature), (fm) => {
            fm.review_status = 'pending';
          }),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const verifies = runner.calls.filter((c) => c.prompt === 'review-verify');
    assert.equal(verifies.length, 2, 'the re-review runs');
    assert.equal(verifies[1].vars.reReview, 'true', 'the fix opened the round: a re-review, not a first review');
    assert.deepEqual(
      state.history.filter((h) => h.warning && /review_status/.test(h.note ?? '')),
      [],
      'the review state is the log, so the edit is no warning',
    );
  } finally {
    cleanup();
  }
});

test('every exit of the fix and fix self-review steps before the hop leaves the unit in fixing', async () => {
  // The session writes the old review fields, then the step stops. Only the
  // fix's `in_review` entry, after the fix self-review passes, says the items
  // are fixed (F-69 D5): on every other exit the log keeps round 1's `fixing`.
  const escalate = (feature) =>
    editFile(feature.indexPath, (fm, body) => body.replace(/## Escalation\n\nNone\./, '## Escalation\n\nStop.'));
  const breakStory = (feature, prep) =>
    writeFileSync(prep.ordered.find((s) => s.id === 'S-1').indexPath, '---\neffort: [\n---\n');
  const NOT_FIXED = { summary: 'item 1 needs the operator', fixed: false, open: 1 };
  const NOT_READY = { summary: 'item 1 needs a redesign', ok: false, changed: false };
  const rows = [
    { name: 'fix: fixed false', at: 'fix', outcome: NOT_FIXED, error: /left 1 item\(s\) open/ },
    { name: 'fix: an open ## Escalation', at: 'fix', act: escalate, error: /while addressing review feedback/ },
    { name: 'fix: a scope stop', at: 'fix', act: breakStory, error: /could not be re-read/ },
    // Text, not the schema's object, twice: the step throws.
    { name: 'fix: no valid outcome', at: 'fix', outcome: 'done', error: /^fix: no valid outcome after one retry/ },
    { name: 'fix self-review: ok false', at: 'fixSelfReview', outcome: NOT_READY, error: /self-review .* failed/ },
    { name: 'fix self-review: an open ## Escalation', at: 'fixSelfReview', act: escalate, error: /fix self-review$/ },
    { name: 'fix self-review: a scope stop', at: 'fixSelfReview', act: breakStory, error: /could not be re-read/ },
    {
      name: 'fix self-review: no valid outcome',
      at: 'fixSelfReview',
      outcome: 'done',
      error: /^fix-self-review: no valid outcome after one retry/,
    },
  ];
  for (const r of rows) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const session = () => {
        editFile(CH(feature), (fm, body) => {
          fm.review_round = '5';
          fm.review_status = 'addressed';
          return body.replaceAll('- [ ] invariant', '- [x] invariant');
        });
        r.act?.(feature, prep);
        return r.outcome;
      };
      const runner = fakeRunner({ dir, feature, behaviour: { [r.at]: session } });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated', r.name);
      assert.match(state.lastError, r.error, `${r.name}: ${state.lastError}`);
      const fm = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
      const { reviewed, position } = reviewOf('feature', fm);
      assert.deepEqual([reviewed, position], [1, 'fixing'], `${r.name}: the log after the step`);
      assert.ok(!fm.transitions.some((e) => e.by === 'fix' && e.to === 'in_review'), `${r.name}: no fix recorded`);
    } finally {
      cleanup();
    }
  }
});
