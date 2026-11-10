import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { extractSection, resolveFeaturePluginsReport } from '../../src/feature.js';
import { runFeature, planSteps, formatPlan, runStatePath } from '../../src/feature-run.js';
import { spawnSync } from 'child_process';
import { mkTempDir } from '../helpers/tempdir.js';
import { initGitBacklog, git as backlogGit, GIT_ENV } from '../helpers/git-backlog.js';
import { parseChange } from '../../src/change-doc.js';
import { unitVars } from '../../src/unit.js';
import { cmdStatusStory } from '../../src/feature-cmd.js';
import { CH, creates, editFile, fakeRunner, storySetup, captureLog } from '../helpers/feature-run-fixture.js';
import { reviewOutcome } from '../helpers/outcomes.js';
import { reviewOf, statusOf as logStatusOf } from '../../src/transition.js';

// ---------------------------------------------------------------------------
// A single story through the loop: `bl run S-n` (F-35 Design §3)
// ---------------------------------------------------------------------------

test("story unit: the loop's field names, read from the story file", () => {
  const { cleanup, unit } = storySetup();
  try {
    assert.equal(unit.kind, 'story');
    assert.equal(unit.id, 'S-5');
    assert.equal(unit.featureEntry, 'S5-loose');
    assert.equal(unit.primaryRepo, 'demo-repo', "the component's repo when primary_repo is unset");
    assert.equal(unit.reviewRoundsMax, 2);
    assert.deepEqual(unit.stories, ['S-5']);
    assert.match(unit.featureRelPath, /^stories\/S5-loose\/index\.md$/);
    assert.equal(unit.componentEntry, 'C00-core');
    assert.equal(unit.componentId, 'C00');
    assert.deepEqual(unitVars(unit), {
      unitKind: 'story',
      premise: "the story's Summary and Acceptance Criteria",
    });
    assert.equal(unitVars({ id: 'F-1' }).unitKind, 'feature');
  } finally {
    cleanup();
  }
});

test('bl run S-n --plan prints the same steps as a one-story feature', () => {
  const { cleanup, unit, prep } = storySetup();
  try {
    const story = formatPlan(unit, planSteps(prep.ordered, 2));
    const feature = formatPlan({ id: 'S-5', title: 'Loose' }, planSteps([{ id: 'S-5' }], 2));
    assert.equal(story, feature);
    assert.match(
      story,
      /^S-5 · Loose — run plan\n 1\. setup\n 2\. implement S-5\n 3\. test\n 4\. self-review\n 5\. pr\n 6\. review \(round 1\)/,
    );
  } finally {
    cleanup();
  }
});

test('a story run: implement, gate, self-review, one PR titled S-n: <title>, review → fix → clean; stops before merge', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const prompts = runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt);
    assert.deepEqual(prompts, [
      'story-run',
      'feature-self-review',
      'review-correctness',
      'review-failure-paths',
      'review-verify',
      'feature-workon-review',
      'feature-fix-self-review',
      'review-correctness',
      'review-failure-paths',
      'review-verify',
    ]);
    const creates = runner.calls.filter((c) => c.type === 'forge' && c.op === 'change.open');
    assert.equal(creates.length, 1, 'one PR');
    assert.equal(creates[0].vars.title, 'S-5: Loose');
    assert.match(creates[0].vars.body, /^Story S-5: Loose \(3 pts\)\n\nStory file: stories\/S5-loose\/index\.md/);
    assert.ok(!runner.calls.some((c) => c.type === 'forge' && /merge/.test(c.op)), 'stops before merge');
    const { fm } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(fm.review_rounds_max, '2');
    assert.equal(logStatusOf('story', fm), 'ready_for_merge', 'a story run records its hops (F-69 D3)');
    for (const k of ['branch', 'pr', 'review_round', 'review_status'])
      assert.equal(fm[k], undefined, `no ${k}: in index.md`);
    const change = parseChange(readFileSync(CH(unit), 'utf8'));
    assert.equal(change.fm.change_of, 'S-5');
    // The review state is the story's log (F-69 D5), not the change document's.
    assert.equal(reviewOf('story', fm).reviewed, 2);
    assert.deepEqual(Object.keys(change.fm).sort(), ['change_of', 'status']);
    assert.deepEqual(
      change.repos.map((r) => [r.repo, r.branch, r.pr]),
      [['demo-repo', 's5-loose', '7']],
    );
    assert.match(extractSection(change.body, 'Description'), /^\nStory S-5: Loose \(3 pts\)\n/);
    assert.ok(existsSync(runStatePath(config, 'S-5')), 'run state keyed by the story id');
    assert.ok(runner.calls.some((c) => c.type === 'shell' && /git commit .*S-5 run started on s5-loose/.test(c.cmd)));
  } finally {
    cleanup();
  }
});

test("bl run's own backlog commits are pushed to origin main (F-50 D4)", async () => {
  const { cleanup, config, unit, prep } = storySetup();
  const remote = mkTempDir('bl-fr-remote-');
  try {
    const dir = config.backlogRoot;
    initGitBacklog(dir);
    backlogGit(remote, 'init', '-q', '--bare', '-b', 'main');
    backlogGit(dir, 'remote', 'add', 'origin', remote);
    backlogGit(dir, 'push', '-q', 'origin', 'main');
    // The backlog's own add and commit run for real; everything else is fake.
    const runner = fakeRunner({
      dir,
      feature: unit,
      behaviour: {
        shell: (cmd) =>
          /^git (add --|commit -q -m) /.test(cmd)
            ? (({ status, stdout, stderr }) => ({ status, output: stdout + stderr }))(
                spawnSync('sh', ['-c', cmd], {
                  cwd: dir,
                  encoding: 'utf8',
                  env: { ...process.env, ...GIT_ENV },
                  stdio: ['ignore', 'pipe', 'pipe'],
                }),
              )
            : null,
      },
    });
    await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.match(
      backlogGit(dir, 'log', '-1', '--format=%s', '--grep=run started', 'main'),
      /S-5 run started on s5-loose/,
    );
    assert.equal(
      backlogGit(remote, 'rev-parse', 'main'),
      backlogGit(dir, 'rev-parse', 'main'),
      'every backlog commit reached origin',
    );
  } finally {
    rmSync(remote, { recursive: true, force: true });
    cleanup();
  }
});

test("a story's first run writes review_rounds_max from --max-rounds and keeps fields already set", async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit, testResults: [1, 1] });
    await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 3 } });
    const { fm } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(fm.review_rounds_max, '3');
    const change = parseChange(readFileSync(CH(unit), 'utf8'));
    assert.equal(change.fm.review_round, undefined, 'the change document holds no review field');
    assert.deepEqual(
      change.repos.map((r) => [r.repo, r.branch, r.pr]),
      [['demo-repo', 's5-loose', '']],
    );
    // A second run does not overwrite them.
    editFile(unit.indexPath, (f, body) => {
      f.review_rounds_max = '4';
      return body.replace(/## Escalation\n\n[\s\S]*$/, '## Escalation\n\nNone.\n');
    });
    await runFeature({
      feature: unit,
      config,
      prep,
      runner: fakeRunner({ dir: config.backlogRoot, feature: unit, testResults: [1, 1] }),
      opts: { maxRounds: 2 },
    });
    assert.equal(parseFrontmatter(readFileSync(unit.indexPath, 'utf8')).fm.review_rounds_max, '4');
    assert.equal(
      readdirSync(dirname(unit.indexPath)).filter((n) => n.startsWith('change')).length,
      1,
      'the open change is reused',
    );
  } finally {
    cleanup();
  }
});

test("a story escalation lands in the story's ## Escalation, records escalated, blocks a rerun, and bl status S-n shows it", async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit, testResults: [1, 1] });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const { fm, body } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(logStatusOf('story', fm), 'escalated', 'a story is escalated as a feature is (F-69 D1)');
    assert.match(extractSection(body, 'Escalation'), /^\ntest gate failed twice/);
    // The open section blocks the next run.
    const again = await runFeature({
      feature: unit,
      config,
      prep,
      runner: fakeRunner({ dir: config.backlogRoot, feature: unit }),
      opts: { maxRounds: 2 },
    });
    assert.equal(again.status, 'failed');
    assert.match(again.lastError, /## Escalation is not empty/);
    const out = captureLog(() =>
      cmdStatusStory(
        {},
        config,
        readAllStories(config).find((s) => s.id === 'S-5'),
      ),
    );
    assert.match(
      out,
      /^S-5 · Loose\nstatus: escalated   repo: demo-repo   branch: s5-loose   pr: -   points: 3\nreview: none \(round 0\/2\)/,
    );
    assert.match(out, /\nescalation:\ntest gate failed twice/);
    assert.match(out, /\nrun: failed at step setup — ## Escalation is not empty/);
  } finally {
    cleanup();
  }
});

test('a story run --resume after the escalation is cleared picks up at the gate', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    await runFeature({
      feature: unit,
      config,
      prep,
      runner: fakeRunner({ dir: config.backlogRoot, feature: unit, testResults: [1, 1] }),
      opts: { maxRounds: 2 },
    });
    editFile(unit.indexPath, (fm, body) => body.replace(/## Escalation\n\n[\s\S]*$/, '## Escalation\n\nNone.\n'));
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2, resume: true } });
    assert.equal(state.status, 'clean');
    const prompts = runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt);
    assert.equal(prompts[0], 'feature-self-review', 'the story is complete; the run resumes at the gate');
    assert.ok(state.history.some((h) => h.step === 'implement' && /already complete/.test(h.note)));
  } finally {
    cleanup();
  }
});

// A branch with no commits ahead of main (S-1437).
const emptyBranch = (cmd) => (cmd === 'git rev-list --count main..HEAD' ? { status: 0, output: '0\n' } : null);
const NO_COMMITS = 'skipped: no commits, nothing to review';

test('a story run whose self-review passes with no commits ends clean at ready_for_merge: no push, no PR, no review', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit, behaviour: { shell: emptyBranch } });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const prompts = runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt);
    assert.deepEqual(prompts, ['story-run', 'feature-self-review']);
    assert.ok(!runner.calls.some((c) => c.type === 'forge'), 'no forge call');
    assert.ok(!runner.calls.some((c) => c.type === 'shell' && c.cmd.startsWith('git push')), 'no push');
    for (const step of ['pr', 'review']) {
      assert.ok(
        state.history.some((h) => h.step === step && h.note === NO_COMMITS),
        `a ${step} entry notes the skip`,
      );
    }
    const { fm } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(logStatusOf('story', fm), 'ready_for_merge');
    assert.equal(fm.transitions.at(-1).by, 'review');
    const change = parseChange(readFileSync(CH(unit), 'utf8'));
    assert.ok(
      change.repos.every((r) => !r.pr),
      'no PR in the change document',
    );
  } finally {
    cleanup();
  }
});

test('a story run with no commits whose self-review fails escalates as it does today', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({
      dir: config.backlogRoot,
      feature: unit,
      behaviour: {
        shell: emptyBranch,
        selfReview: () => ({ summary: 'misses its case', ok: false, changed: false }),
      },
    });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.ok(!runner.calls.some((c) => c.type === 'forge'), 'no forge call');
    const { fm } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(logStatusOf('story', fm), 'escalated');
  } finally {
    cleanup();
  }
});

test('a story escalated at the pr step with no PR takes the no-commit path on --resume (S-1379)', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const first = fakeRunner({ dir: config.backlogRoot, feature: unit });
    first.forge = (op, vars) => {
      first.calls.push({ type: 'forge', op, vars });
      return { configured: true, status: 1, stdout: '', stderr: 'No commits between main and s5-loose' };
    };
    const run1 = await runFeature({ feature: unit, config, prep, runner: first, opts: { maxRounds: 2 } });
    assert.equal(run1.status, 'escalated');
    assert.match(run1.lastError, /no pull request could be opened/);
    editFile(unit.indexPath, (fm, body) => body.replace(/## Escalation\n\n[\s\S]*$/, '## Escalation\n\nNone.\n'));
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit, behaviour: { shell: emptyBranch } });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2, resume: true } });
    assert.equal(state.status, 'clean');
    assert.ok(!runner.calls.some((c) => c.type === 'forge' && c.op === 'change.open'), 'no change.open');
    const { fm } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(logStatusOf('story', fm), 'ready_for_merge');
  } finally {
    cleanup();
  }
});

test('a no-commit resume with the log at fixing does not end clean', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const first = fakeRunner({ dir: config.backlogRoot, feature: unit, behaviour: { shell: emptyBranch } });
    assert.equal(
      (await runFeature({ feature: unit, config, prep, runner: first, opts: { maxRounds: 2 } })).status,
      'clean',
    );
    editFile(unit.indexPath, (fm) => {
      fm.transitions.push({ at: '2026-11-10T08:00:00Z', to: 'in_review', by: 'review' });
      fm.transitions.push({ at: '2026-11-10T08:00:01Z', to: 'fixing', by: 'review' });
    });
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit, behaviour: { shell: emptyBranch } });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2, resume: true } });
    assert.notEqual(state.status, 'clean');
    assert.ok(!state.history.some((h) => h.warning), 'no unrecorded hop');
    const { fm } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.notEqual(logStatusOf('story', fm), 'ready_for_merge');
  } finally {
    cleanup();
  }
});

test('a resumed run of a story already at ready_for_merge with no commits records nothing twice', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const first = fakeRunner({ dir: config.backlogRoot, feature: unit, behaviour: { shell: emptyBranch } });
    const run1 = await runFeature({ feature: unit, config, prep, runner: first, opts: { maxRounds: 2 } });
    assert.equal(run1.status, 'clean');
    const logLength = parseFrontmatter(readFileSync(unit.indexPath, 'utf8')).fm.transitions.length;
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit, behaviour: { shell: emptyBranch } });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2, resume: true } });
    assert.equal(state.status, 'clean');
    for (const step of ['pr', 'review']) {
      assert.equal(state.history.filter((h) => h.step === step && h.note === NO_COMMITS).length, 1, step);
    }
    assert.ok(!state.history.some((h) => h.warning), 'no unrecorded hop');
    assert.ok(!runner.calls.some((c) => c.type === 'forge'), 'no forge call');
    const { fm } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(fm.transitions.length, logLength, 'no new log entry');
    assert.equal(logStatusOf('story', fm), 'ready_for_merge');
  } finally {
    cleanup();
  }
});

test("a story's review finding routed to its Deferred: the review sessions get the story's kind", async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({
      dir: config.backlogRoot,
      feature: unit,
      behaviour: {
        // The verifier routes a pre-existing finding to the unit's ## Deferred.
        verify: (o) => {
          editFile(unit.indexPath, (fm, body) =>
            body.replace(
              '## Deferred\n\nNone.\n',
              '## Deferred\n\n- [points: 2] (pre-existing, review round 1) old bug\n',
            ),
          );
          editFile(CH(unit), (fm, body) => {
            const block =
              '### Session 2026-10-07 (PR #7) r1\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n';
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
          return reviewOutcome();
        },
      },
    });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const reviewCalls = runner.calls.filter((c) => c.type === 'session' && c.prompt.startsWith('review-'));
    for (const c of reviewCalls) {
      assert.equal(c.vars.unitKind, 'story', c.prompt);
    }
    const body = parseFrontmatter(readFileSync(unit.indexPath, 'utf8')).body;
    assert.match(extractSection(body, 'Deferred'), /\(pre-existing, review round 1\) old bug/);
  } finally {
    cleanup();
  }
});

test("the story's test gate layers the component's plugins under the story's own", () => {
  const { dir, cleanup, unit } = storySetup();
  try {
    // The story's project config, as prepareStoryRun's cfg is.
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    raw.plugins = { alpha: { test: 'a' }, beta: { test: 'b' } };
    writeFileSync(cfgPath, JSON.stringify(raw));
    const config = loadConfig({ backlogRoot: dir, projectId: 'demo' });
    const componentIndex = join(dir, 'components', 'C00-core', 'index.md');
    writeFileSync(
      componentIndex,
      readFileSync(componentIndex, 'utf8').replace('title: Core\n', 'title: Core\nplugins-test: [alpha, beta]\n'),
    );
    writeFileSync(
      unit.indexPath,
      readFileSync(unit.indexPath, 'utf8').replace('status: refined\n', 'status: refined\nplugins-test: [-beta]\n'),
    );
    const { plugins } = resolveFeaturePluginsReport('test', config, unit.indexPath, {
      componentEntry: unit.componentEntry,
    });
    assert.deepEqual(
      plugins.map((p) => p.name),
      ['alpha'],
    );
    assert.deepEqual(
      resolveFeaturePluginsReport('test', config, unit.indexPath).plugins.map((p) => p.name),
      [],
      'no component layer without componentEntry',
    );
  } finally {
    cleanup();
  }
});
