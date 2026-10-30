import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  loadConfig,
  parseFrontmatter,
  serializeFrontmatter,
  runForgeOp,
  configForRepo,
  FrontmatterError,
} from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import {
  findFeature,
  normalizeFeatureId,
  resolveFeatureStories,
  orderStoriesByDeps,
  extractSection,
  replaceSection,
  resolveFeaturePluginsReport,
} from '../../src/feature.js';
import {
  runFeature,
  planSteps,
  formatPlan,
  uncheckedCriteria,
  loadRunState,
  saveRunState,
  newRunState,
  runStatePath,
  runLockPath,
  reviewFeature,
  parseMaxRounds,
  acquireRunLock,
  RUN_DIR,
  unrelatedReason,
  rerunReason,
  looksFlaky,
  lastLine,
  shellMerged,
  ESCALATION_FILE,
  localTime,
  repoGuardWarnings,
  tokensStepKey,
  restoreKeepingTokens,
  hasHeadlessConfiguration,
} from '../../src/feature-run.js';
import { acquirePidLock, releasePidLock } from '../../src/pid-lock.js';
import { spawnSync } from 'child_process';
import { featureReviewGate } from '../../src/review-log.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { initGitBacklog, git as backlogGit, GIT_ENV } from '../helpers/git-backlog.js';
import { parseChange, serializeChange } from '../../src/change-doc.js';
import { storyUnit, storyAsOrdered, unitVars } from '../../src/unit.js';
import { cmdStatusStory, tokensLines } from '../../src/feature-cmd.js';
import { accumulateTokensOnFile } from '../../src/tokens.js';
import { _hooks as atomicHooks } from '../../src/atomic-write.js';
import { installPartialWrites } from '../helpers/partial-write.js';
import { startTokenWriter } from '../helpers/token-writer.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const AC_BODY = '## Acceptance Criteria\n\n- [ ] one works\n- [ ] two works\n';

function fixture(extra = {}, backlogConfig = null) {
  return mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Second',
        dirSuffix: 'second',
        points: 5,
        feature: 'F-1',
        depends_on: ['S-1'],
        body: AC_BODY,
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1', 'S-2'],
        branch: 'f1-feat',
        ...extra,
      },
    ],
    ...(backlogConfig ? { config: backlogConfig } : {}),
  });
}

/** `backlogConfig` adds top-level keys to the fixture's backlog.json (`{ run: { limit_wait_max_hours: 1 } }`). */
function setup(extra, backlogConfig = null) {
  const { dir, cleanup } = fixture(extra, backlogConfig);
  const config = loadConfig({ backlogRoot: dir });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const all = readAllStories(config);
  const ordered = orderStoriesByDeps(resolveFeatureStories(feature, config, all).stories);
  const worktreePath = mkTempDir('bl-wt-');
  const prep = {
    cfg: config,
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
    },
    reviewPending: false,
    // The lead repo (F-52 D3): the stories' one repo.
    targetRepoName: 'demo-repo',
  };
  return { dir, cleanup, config, feature, prep };
}

/** The unit's change document, beside its index.md. */
const CH = (unit) => join(dirname(unit.indexPath), 'change.md');

/** Edit a unit file or (by its name) a change document through `fn(fm, body)`. */
const creates = (runner) => runner.calls.filter((c) => c.type === 'forge' && c.op === 'change.open');

function editFile(path, fn) {
  if (path.endsWith('change.md')) {
    const doc = parseChange(readFileSync(path, 'utf8'));
    const out = fn(doc.fm, doc.body) ?? doc.body;
    writeFileSync(path, serializeChange({ ...doc, body: out }));
    return;
  }
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const out = fn(fm, body) ?? body;
  writeFileSync(path, serializeFrontmatter(fm) + out);
}

function checkAll(path) {
  editFile(path, (fm, body) => {
    fm.status = 'in_progress';
    return body.replaceAll('- [ ]', '- [x]');
  });
}

function writeSession(featurePath, { pending, round }) {
  editFile(featurePath, (fm, body) => {
    fm.review_round = String(round);
    fm.review_status = pending ? 'pending' : 'addressed';
    const block = pending
      ? `### Session 2026-09-24 (PR #7) r${round}\n\n**Must fix**\n\n- [ ] invariant X — Repro: y. Test: z.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n`
      : `### Session 2026-09-24 (PR #7) r${round}\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n`;
    return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
  });
}

/**
 * A fake runner whose `session` simulates the agents by editing files, and
 * whose shell answers git/test commands from a script. Its clock starts at
 * `clock` and advances only through `sleep`, which records each call;
 * `behaviour.limit(o)` returning a refusal object makes the session a
 * usage-limit refusal (`behaviour.onSleep` runs on every sleep slice).
 */
function fakeRunner({ dir, feature, behaviour = {}, testResults = [], clock = Date.parse('2026-10-13T23:59:36Z') }) {
  const calls = [];
  let head = 0;
  // What origin/<branch> holds: a push publishes the current head.
  let pushed = -1;
  let round = 0;
  const b = {
    story: (o) => checkAll(o.vars.storyAbsPath),
    verify: () => {
      round += 1;
      writeSession(CH(feature), { pending: round === 1, round });
    },
    fix: () =>
      editFile(CH(feature), (fm, body) => {
        fm.review_status = 'fixed';
        return body.replaceAll('- [ ] invariant', '- [x] invariant');
      }),
    ...behaviour,
  };
  return {
    calls,
    session(o) {
      calls.push({
        type: 'session',
        prompt: o.promptName,
        story: o.vars.storyId,
        mode: o.mode,
        agent: o.agent,
        model: o.model ?? null,
        vars: o.vars,
        unitDir: o.unitDir ?? null,
        worktreePath: o.worktreePath,
      });
      // A usage-limit refusal: the agent did nothing (unless `limit` itself did) and said so.
      const limit = b.limit ? b.limit(o) : null;
      if (limit) return { ok: false, output: limit.message, isError: true, usage: null, denials: [], refusal: limit };
      if (o.promptName === 'feature-story' || o.promptName === 'story-run') b.story(o);
      else if (o.promptName.startsWith('review-') && o.promptName !== 'review-verify') {
        writeFileSync(o.vars.findingsPath, `# ${o.vars.dimension}\n\n## Must fix\n\n- x\n`);
        if (b.review) b.review(o);
      } else if (o.promptName === 'review-verify') b.verify(o);
      else if (o.promptName === 'feature-workon-review') b.fix(o);
      else if (o.promptName === 'feature-fix-tests' && b.fixTests) b.fixTests(o);
      else if (o.promptName === 'feature-self-review' && b.selfReview) b.selfReview(o);
      else if (o.promptName === 'feature-fix-self-review' && b.fixSelfReview) b.fixSelfReview(o);
      return {
        ok: true,
        output: b.output ? b.output(o) : '',
        isError: false,
        usage: { input: 1, output: 1, cache_creation: 0, cache_read: 0 },
      };
    },
    shell(cmd, cwd) {
      calls.push({ type: 'shell', cmd, cwd });
      if (b.shell) {
        const r = b.shell(cmd);
        if (r) return r;
      }
      if (cmd.startsWith('git rev-parse HEAD')) return { status: 0, output: `sha${head}\n` };
      if (cmd.startsWith('git push')) {
        pushed = head;
        return { status: 0, output: '' };
      }
      if (cmd.startsWith('git rev-list --count origin/')) {
        return pushed < 0 ? { status: 128, output: 'unknown revision\n' } : { status: 0, output: `${head - pushed}\n` };
      }
      if (cmd.startsWith('git diff --name-only'))
        return { status: 0, output: cmd.includes(' -z ') ? 'src/a.js\0' : 'src/a.js\n' };
      if (cmd === 'npm test') {
        const r = testResults.shift() ?? 0;
        return { status: r, output: r ? '1) fails\nAssertionError: boom\n' : 'ok\n' };
      }
      return { status: 0, output: '' };
    },
    forge(op, vars) {
      calls.push({ type: 'forge', op, vars });
      return { configured: true, status: 0, stdout: 'https://github.com/x/y/pull/7\n' };
    },
    testPlugins() {
      return { plugins: [{ name: 'node', command: 'npm test' }], unknown: [] };
    },
    notify(label) {
      calls.push({ type: 'notify', label });
    },
    log() {},
    now() {
      return new Date(clock);
    },
    sleep(ms) {
      calls.push({ type: 'sleep', ms });
      clock += ms;
      if (b.onSleep) b.onSleep();
    },
    clock() {
      return clock;
    },
    bumpHead() {
      head += 1;
    },
    /** True when origin/<branch> holds the current head. */
    published() {
      return pushed === head;
    },
  };
}

test('planSteps and formatPlan list implement per story, then gate, PR, and review rounds', () => {
  const steps = planSteps([{ id: 'S-1' }, { id: 'S-2' }], 2);
  assert.deepEqual(
    steps.map((s) => s.step),
    [
      'setup',
      'implement',
      'implement',
      'test',
      'self-review',
      'pr',
      'review',
      'fix',
      'fix-self-review',
      're-review',
      'fix',
      'fix-self-review',
      'closing-review',
      'stop',
    ],
  );
  const text = formatPlan({ id: 'F-1', title: 'Feat' }, steps);
  assert.match(text, /2\. implement S-1/);
  assert.match(text, /8\. fix \(round 1\)/);
  assert.match(text, /9\. fix-self-review \(round 1\)/);
  assert.match(text, /13\. closing-review \(round 3\)/);
});

test('parseMaxRounds accepts only a positive integer in digits', () => {
  assert.equal(parseMaxRounds(undefined, 2), 2);
  assert.equal(parseMaxRounds('3', 2), 3);
  assert.equal(parseMaxRounds(' 4 ', 2), 4);
  assert.equal(parseMaxRounds(5, 2), 5);
  for (const bad of ['2abc', '1.5', '0', '-1', '', 'x', true]) {
    assert.ok(Number.isNaN(parseMaxRounds(bad, 2)), JSON.stringify(bad));
  }
});

test('uncheckedCriteria reads only the acceptance section', () => {
  const dir = mkTempDir('bl-ac-');
  const p = join(dir, 'index.md');
  writeFileSync(
    p,
    '---\nstory_id: S-1\n---\n\n# S\n\n## Acceptance Criteria\n\n- [x] done\n- [ ] open one\n\n## Plan\n\n- [ ] not a criterion\n',
  );
  assert.deepEqual(uncheckedCriteria(p), ['open one']);
  assert.equal(uncheckedCriteria(join(dir, 'nope.md')), null, "a missing file is not 'nothing open'");
});

test('uncheckedCriteria counts *, +, and numbered checkboxes', () => {
  const dir = mkTempDir('bl-ac-');
  const p = join(dir, 'index.md');
  writeFileSync(
    p,
    '---\nstory_id: S-1\n---\n\n## Acceptance Criteria\n\n- [ ] dash\n* [ ] star\n+ [ ] plus\n1. [ ] dot\n2) [ ] paren\n  - [ ] nested\n- [x] done\n* [x] done too\n',
  );
  assert.deepEqual(uncheckedCriteria(p), ['dash', 'star', 'plus', 'dot', 'paren', 'nested']);
  // A criterion wrapped at 100 columns is one criterion; lines after a checked box belong to none.
  writeFileSync(
    p,
    '---\nstory_id: S-1\n---\n\n## Acceptance Criteria\n\n- [ ] a criterion that `bl format` wrapped over\n      two lines, then\n      three\n- [x] done\n      with a tail of its own\n* [ ] last\n',
  );
  assert.deepEqual(uncheckedCriteria(p), ['a criterion that `bl format` wrapped over two lines, then three', 'last']);
  // A missing section (renamed, or never written) is null, not [].
  writeFileSync(p, '---\nstory_id: S-1\n---\n\n## Acceptance\n\n- [x] all done\n');
  assert.equal(uncheckedCriteria(p), null);
  writeFileSync(p, '---\nstory_id: S-1\n---\n\n## Summary\n\nNo criteria.\n');
  assert.equal(uncheckedCriteria(p), null);
});

test('happy path: stories, gate, self-review, PR, review → fix → re-review → clean', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.equal(state.pr.number, '7');
    const prompts = runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt);
    assert.deepEqual(prompts, [
      'feature-story',
      'feature-story',
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
    const stories = runner.calls.filter((c) => c.prompt === 'feature-story').map((c) => c.story);
    assert.deepEqual(stories, ['S-1', 'S-2'], 'dependency order');
    const fm = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
    assert.equal(fm.status, 'running');
    for (const k of ['branch', 'pr', 'review_round', 'review_status'])
      assert.equal(fm[k], undefined, `no ${k}: in index.md`);
    // The change document holds the PR, the review state and a line per gate run.
    const change = parseChange(readFileSync(CH(feature), 'utf8'));
    assert.equal(change.fm.change_of, 'F-1');
    assert.equal(change.fm.status, 'open');
    assert.equal(change.fm.review_status, 'addressed');
    assert.deepEqual(change.repos, [
      { repo: 'demo-repo', branch: 'f1-feat', pr: '7', url: 'https://github.com/x/y/pull/7', merged: '' },
    ]);
    assert.match(
      extractSection(change.body, 'Description'),
      /^\nFeature F-1: Feat\n\nStories:\n- S-1 — First \(3 pts\)\n- S-2 — Second \(5 pts\)\n/,
    );
    const gateLines = extractSection(change.body, 'Gate').trim().split('\n');
    assert.equal(gateLines.length, 2, 'one line per gate run');
    for (const [i, line] of gateLines.entries())
      assert.match(
        line,
        new RegExp(`^- \\d{4}-\\d{2}-\\d{2} · demo-repo · \`npm test\` · pass \\(attempt ${i + 1}\\)$`),
      );
    assert.equal(creates(runner)[0].vars.title, 'F-1: Feat');
    assert.match(
      creates(runner)[0].vars.body,
      /^Feature F-1: Feat\n\nStories:\n- S-1 — First \(3 pts\)\n- S-2 — Second \(5 pts\)\n\nFeature file: features\/F1-feat\/index\.md/,
    );
    assert.ok(existsSync(runStatePath(config, 'F-1')));
    assert.ok(existsSync(join(dir, RUN_DIR, '.gitignore')));
    assert.ok(runner.calls.some((c) => c.type === 'notify' && c.label === 'F-1 clean'));
    assert.ok(runner.calls.some((c) => c.type === 'shell' && /git commit .*PR opened/.test(c.cmd)));
    assert.equal(state.usage.input, 11, 'one unit per session, including the fix self-review');
    // test gate ran: after stories, and after the fix round
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 2);
  } finally {
    cleanup();
  }
});

test("every session of a run starts in the prep's unit directory; the gate and git stay in the worktree", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    prep.unitDir = mkTempDir('bl-unit-');
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const sessions = runner.calls.filter((c) => c.type === 'session');
    // Implement, self-review, review, fix and fix self-review (F-60 D3).
    assert.deepEqual([...new Set(sessions.map((c) => c.prompt))].sort(), [
      'feature-fix-self-review',
      'feature-self-review',
      'feature-story',
      'feature-workon-review',
      'review-correctness',
      'review-failure-paths',
      'review-verify',
    ]);
    for (const c of sessions) {
      assert.equal(c.unitDir, prep.unitDir, `${c.prompt}: started in the unit directory`);
      assert.equal(c.vars.unitDir, prep.unitDir, `${c.prompt}: its prompt names it`);
      assert.equal(c.worktreePath, prep.worktreePath, `${c.prompt}: the lead worktree still rides along`);
    }
    const shells = runner.calls.filter((c) => c.type === 'shell' && c.cwd);
    assert.ok(
      shells.some((c) => c.cmd === 'npm test' && c.cwd === prep.worktreePath),
      'the test gate runs in the worktree',
    );
    assert.ok(
      shells.every((c) => c.cwd !== prep.unitDir),
      'no command runs in the unit directory',
    );
    assert.ok(!existsSync(join(prep.unitDir, '.workon.lock')), "the review round's lock is released");
  } finally {
    cleanup();
  }
});

test('a test gate that fails twice escalates with the log and never opens a PR', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature, testResults: [1, 1] });
    const state = await runFeature({ feature, config, prep, runner });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /test gate failed twice/);
    assert.equal(runner.calls.filter((c) => c.prompt === 'feature-fix-tests').length, 1);
    assert.ok(!runner.calls.some((c) => c.type === 'forge'));
    const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.equal(fm.status, 'escalated');
    assert.match(body, /## Escalation\n\ntest gate failed twice/);
    assert.match(body, /AssertionError: boom/);
    // Each attempt keeps its own log; the escalation names the second.
    const log1 = join(dir, RUN_DIR, 'F-1.test-1.log');
    const log2 = join(dir, RUN_DIR, 'F-1.test-2.log');
    assert.equal(readFileSync(log1, 'utf8'), '── demo-repo · node: npm test\n1) fails\nAssertionError: boom\n');
    assert.ok(existsSync(log2));
    assert.equal(loadRunState(config, 'F-1').testAttempts, 2);
    const esc = extractSection(body, 'Escalation');
    const order = ['Command: `npm test`', `Full log: ${log2}`, 'Failure excerpt:', 'Last 30 lines:'].map((s) =>
      esc.indexOf(s),
    );
    assert.ok(
      order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])),
      `details in order: ${esc}`,
    );
  } finally {
    cleanup();
  }
});

test('shellMerged keeps stdout and stderr in the order the command printed them', () => {
  const cwd = mkTempDir('bl-merged-');
  const r = shellMerged('echo one; echo two >&2; echo three; echo four >&2; exit 3', cwd);
  assert.equal(r.status, 3);
  assert.equal(r.output, 'one\ntwo\nthree\nfour\n');
  const ok = shellMerged("printf 'no newline'", cwd);
  assert.deepEqual(ok, { status: 0, output: 'no newline' });
  // A cwd that does not exist fails the spawn; the error is the output.
  const bad = shellMerged('true', join(cwd, 'missing'));
  assert.equal(bad.status, 127);
  assert.match(bad.output, /ENOENT/);
});

test('the test gate asks the runner for merged streams', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const opts = [];
    const runner = fakeRunner({ dir, feature });
    runner.shell = ((orig) => (cmd, cwd, o) => {
      if (cmd === 'npm test') opts.push(o);
      return orig(cmd, cwd);
    })(runner.shell);
    await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.ok(opts.length > 0);
    for (const o of opts) assert.deepEqual(o, { mergeStreams: true });
  } finally {
    cleanup();
  }
});

test('a fix-tests session ending UNRELATED escalates after one gate run with its reason', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        output: (o) =>
          o.promptName === 'feature-fix-tests'
            ? 'Looked at the log.\n\nUNRELATED: dev certificate expired (CERT_HAS_EXPIRED on every client test)\n\n'
            : '',
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'test gate failure is environmental (fix-tests: UNRELATED)');
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 1, 'the gate is not rerun');
    assert.ok(!runner.calls.some((c) => c.type === 'forge'), 'no PR');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation').trim();
    assert.match(
      esc,
      /^test gate failure is environmental \(fix-tests: UNRELATED\)\n\ndev certificate expired \(CERT_HAS_EXPIRED on every client test\)\n\nCommand: `npm test`/,
    );
    assert.ok(esc.includes(`Full log: ${join(dir, RUN_DIR, 'F-1.test-1.log')}`), esc);
    assert.match(esc, /Failure excerpt:[\s\S]*AssertionError: boom[\s\S]*Last 30 lines:/);
    // The implement steps are recorded complete, so --resume starts at the gate.
    const again = fakeRunner({ dir, feature });
    editFile(feature.indexPath, (fm, body) => {
      fm.status = 'running';
      return body.replace(/## Escalation\n\n[\s\S]*$/, '## Escalation\n\nNone.\n');
    });
    const resumed = await runFeature({ feature, config, prep, runner: again, opts: { resume: true, maxRounds: 2 } });
    assert.equal(resumed.status, 'clean');
    assert.ok(!again.calls.some((c) => c.prompt === 'feature-story'), 'no story is implemented again');
  } finally {
    cleanup();
  }
});

test("an UNRELATED session's escalation file becomes the Escalation, followed by its reason and the gate details", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const explanation =
      "**The rule at stake:** the test gate runs this branch's code.\n\n**Details:**\n\n- cert expired";
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        fixTests: (o) => writeFileSync(join(o.vars.scratchDir, ESCALATION_FILE), `${explanation}\n\n`),
        output: (o) => (o.promptName === 'feature-fix-tests' ? 'UNRELATED: dev certificate expired\n' : ''),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation').trim();
    assert.ok(
      esc.startsWith(
        `test gate failure is environmental (fix-tests: UNRELATED)\n\n${explanation}\n\nfix-tests ended \`UNRELATED: dev certificate expired\`. The failed gate:\n\nCommand: \`npm test\``,
      ),
      esc,
    );
  } finally {
    cleanup();
  }
});

test("a sent-back fix-tests session does not inherit the previous session's escalation file", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let n = 0;
    const seen = [];
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        fixTests: (o) => {
          const file = join(o.vars.scratchDir, ESCALATION_FILE);
          seen.push(existsSync(file));
          if (++n === 1) writeFileSync(file, 'stale explanation\n');
        },
        output: (o) => (o.promptName === 'feature-fix-tests' ? 'UNRELATED: a flaky timeout\n' : ''),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.deepEqual(seen, [false, false], 'the file is cleared before each session');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(!esc.includes('stale explanation'), esc);
    assert.match(esc, /\n\na flaky timeout\n\nCommand: `npm test`/);
  } finally {
    cleanup();
  }
});

test('any other fix-tests ending reruns the gate', async () => {
  for (const [label, said] of [
    ['FIXED', 'Fixed the off-by-one.\nFIXED\n'],
    ['empty', ''],
    ['UNRELATED not on the last line', 'UNRELATED: maybe the certificate\nActually it was my bug.\nFIXED'],
    ['UNRELATED without a reason', 'UNRELATED:   '],
    ['UNRELATED inside a sentence', 'I first thought UNRELATED: cert, but no'],
  ]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({
        dir,
        feature,
        testResults: [1, 0],
        behaviour: { output: (o) => (o.promptName === 'feature-fix-tests' ? said : '') },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', label);
      assert.ok(runner.calls.filter((c) => c.cmd === 'npm test').length >= 2, `${label}: gate rerun`);
    } finally {
      cleanup();
    }
  }
});

test('a flaky UNRELATED is sent back to fix-tests once with a note, and a second UNRELATED escalates', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        output: (o) =>
          o.promptName === 'feature-fix-tests'
            ? 'Deferred it.\nUNRELATED: a flaky page.goto load timeout in debounce.int.test.js\n'
            : '',
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    const fixes = runner.calls.filter((c) => c.prompt === 'feature-fix-tests');
    assert.equal(fixes.length, 2, 'sent back once, not more');
    assert.equal(fixes[0].vars.fixNote, '', 'the first session gets no note');
    assert.match(fixes[1].vars.fixNote, /ended `UNRELATED: a flaky page\.goto load timeout/);
    assert.match(fixes[1].vars.fixNote, /is a bug to fix, not a reason to stop/);
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 1, 'the gate is not rerun in between');
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'test gate failure is environmental (fix-tests: UNRELATED)');
    assert.ok(
      state.history.some((h) => h.step === 'fix-tests' && /UNRELATED refused/.test(h.note ?? '')),
      'the pushback is in the history',
    );
  } finally {
    cleanup();
  }
});

test('a flaky UNRELATED sent back and then FIXED reruns the gate and carries on', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let n = 0;
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 0],
      behaviour: {
        output: (o) =>
          o.promptName === 'feature-fix-tests'
            ? ++n === 1
              ? 'UNRELATED: intermittent, not caused by this branch'
              : 'Fixed the race (S-9).\nFIXED'
            : '',
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(n, 2);
    assert.equal(state.status, 'clean');
  } finally {
    cleanup();
  }
});

test('RERUN reruns the gate; when it fails again one more fix session gets it, then the cap escalates', async () => {
  for (const [label, results, expected, sessions] of [
    ['rerun passes', [1, 0], 'clean', 1],
    ['rerun fails, then fixed', [1, 1, 0], 'clean', 2],
    ['rerun fails, RERUN again is FIXED', [1, 1, 1], 'escalated', 2],
  ]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({
        dir,
        feature,
        testResults: [...results],
        behaviour: {
          output: (o) =>
            o.promptName === 'feature-fix-tests'
              ? 'Ran it 20 times at 4 workers, never failed.\nRERUN: 20 passes at --workers=4'
              : '',
        },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      const fixes = runner.calls.filter((c) => c.prompt === 'feature-fix-tests');
      assert.equal(state.status, expected, label);
      assert.equal(fixes.length, sessions, `${label}: fix sessions`);
      if (sessions > 1)
        assert.match(
          fixes[1].vars.fixNote,
          /ended `RERUN: 20 passes at --workers=4`, and the gate was rerun and failed/,
          label,
        );
      if (expected === 'escalated') assert.match(state.lastError, /test gate failed twice/, label);
    } finally {
      cleanup();
    }
  }
});

test('looksFlaky matches flaky, intermittent, timeout and not-caused-by reasons only', () => {
  for (const yes of [
    'a flaky page.goto load timeout',
    'Intermittent failure',
    'page load timed out',
    'Timeout 30000ms exceeded',
    'times out under load',
    'not caused by this branch',
    'FLAKY',
  ]) {
    assert.ok(looksFlaky(yes), yes);
  }
  for (const no of [
    'dev certificate expired',
    "stack runs main's code (e2e profile)",
    'stray files in the worktree: a.log',
    '',
    null,
  ]) {
    assert.ok(!looksFlaky(no), String(no));
  }
});

test('rerunReason parses a RERUN last line like unrelatedReason', () => {
  assert.equal(rerunReason('tried\nRERUN: 20 passes\n'), '20 passes');
  assert.equal(rerunReason('**RERUN:** 5 passes'), '5 passes');
  for (const no of ['FIXED', 'RERUN:', 'RERUN: x\nFIXED', 'rerun: x', 'UNRELATED: x', null]) {
    assert.equal(rerunReason(no), null, JSON.stringify(no));
  }
  assert.equal(unrelatedReason('RERUN: x'), null);
});

test('unrelatedReason reads only the last non-blank line and tolerates markdown around the keyword', () => {
  assert.equal(unrelatedReason('x\nUNRELATED: cert expired\n\n'), 'cert expired');
  assert.equal(unrelatedReason('**UNRELATED:** stack runs main'), 'stack runs main');
  assert.equal(unrelatedReason('`UNRELATED: flaky`'), 'flaky');
  assert.equal(unrelatedReason('UNRELATED: a\r\n'), 'a');
  for (const no of [
    'FIXED',
    '',
    null,
    undefined,
    'UNRELATED:',
    'UNRELATED',
    'unrelated: x',
    'UNRELATED: x\nFIXED',
    'see UNRELATED: x',
  ]) {
    assert.equal(unrelatedReason(no), null, JSON.stringify(no));
  }
  assert.equal(lastLine('a\n  b  \n\n  \n'), 'b');
  assert.equal(lastLine(undefined), '');
});

test('implement, fix-tests and review-fix sessions each get a scratch dir under .bl/run, created before they start', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const seen = [];
    let unchecked = true;
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 0],
      behaviour: {
        story: (o) => {
          seen.push({
            prompt: o.promptName,
            story: o.vars.storyId,
            scratchDir: o.vars.scratchDir,
            exists: existsSync(o.vars.scratchDir),
          });
          // S-1's first session leaves a criterion open, so its retry runs.
          if (o.vars.storyId === 'S-1' && unchecked) {
            unchecked = false;
            return;
          }
          checkAll(o.vars.storyAbsPath);
        },
        fixTests: (o) =>
          seen.push({ prompt: o.promptName, scratchDir: o.vars.scratchDir, exists: existsSync(o.vars.scratchDir) }),
        fix: (o) => {
          seen.push({ prompt: o.promptName, scratchDir: o.vars.scratchDir, exists: existsSync(o.vars.scratchDir) });
          editFile(CH(feature), (fm, body) => {
            fm.review_status = 'fixed';
            return body.replaceAll('- [ ] invariant', '- [x] invariant');
          });
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    const run = join(dir, RUN_DIR);
    assert.deepEqual(seen, [
      { prompt: 'feature-story', story: 'S-1', scratchDir: join(run, 'F-1.S-1.scratch'), exists: true },
      { prompt: 'feature-story', story: 'S-1', scratchDir: join(run, 'F-1.S-1.scratch'), exists: true },
      { prompt: 'feature-story', story: 'S-2', scratchDir: join(run, 'F-1.S-2.scratch'), exists: true },
      { prompt: 'feature-fix-tests', scratchDir: join(run, 'F-1.fix-tests-1.scratch'), exists: true },
      { prompt: 'feature-workon-review', scratchDir: join(run, 'F-1.r1.fix.scratch'), exists: true },
    ]);
  } finally {
    cleanup();
  }
});

test("the escalation's excerpt finds an error far above the teardown noise the tail shows", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const noise = Array.from({ length: 120 }, (_, i) => `[teardown] removing container ${i}`).join('\n');
    const output = `Running 12 tests\n    Error: Session s0 container exited during startup.\n      at stack.setup.js:88\n${noise}\n`;
    let fixVars = null;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        shell: (cmd) => (cmd === 'npm test' ? { status: 1, output } : null),
        fixTests: (o) => {
          fixVars = o.vars;
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    const tailPart = esc.slice(esc.indexOf('Last 30 lines:'));
    assert.ok(!tailPart.includes('container exited during startup'), 'the tail alone would miss it');
    assert.match(esc.slice(0, esc.indexOf('Last 30 lines:')), /Error: Session s0 container exited during startup\./);
    assert.match(tailPart, /removing container 119/);
    assert.match(tailPart, /removing container 90\n/);
    assert.ok(!/removing container 89\b/.test(tailPart), 'the tail is 30 lines, not 200');
    // The fix-tests session got the same three views.
    assert.match(fixVars.testExcerpt, /container exited during startup/);
    assert.equal(fixVars.testTail.split('\n').length, 30);
    assert.equal(fixVars.testLogPath, join(dir, RUN_DIR, 'F-1.test-1.log'));
    assert.ok(!('testLog' in fixVars));
  } finally {
    cleanup();
  }
});

test("gate logs head each plugin's output, cover passing attempts, and keep counting across --resume", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    mkdirSync(join(dir, RUN_DIR), { recursive: true });
    // A state file from an earlier run that got two gate attempts in.
    const first = fakeRunner({ dir, feature, testResults: [1, 1] });
    await runFeature({ feature, config, prep, runner: first, opts: { maxRounds: 2 } });
    assert.equal(loadRunState(config, 'F-1').testAttempts, 2);
    editFile(feature.indexPath, (fm, body) => {
      fm.status = 'running';
      return body.replace(/## Escalation\n\n[\s\S]*$/, '## Escalation\n\nNone.\n');
    });
    const runner = fakeRunner({ dir, feature });
    runner.testPlugins = () => ({
      plugins: [
        { name: 'unit', command: 'npm test' },
        { name: 'lint', command: 'npm run lint' },
      ],
      unknown: [],
    });
    runner.shell = ((orig) => (cmd, cwd) =>
      cmd === 'npm run lint' ? { status: 0, output: 'lint clean' } : orig(cmd, cwd))(runner.shell);
    const state = await runFeature({ feature, config, prep, runner, opts: { resume: true, maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.equal(
      readFileSync(join(dir, RUN_DIR, 'F-1.test-1.log'), 'utf8'),
      '── demo-repo · node: npm test\n1) fails\nAssertionError: boom\n',
      'attempt 1 is not overwritten',
    );
    assert.equal(
      readFileSync(join(dir, RUN_DIR, 'F-1.test-3.log'), 'utf8'),
      '── demo-repo · unit: npm test\nok\n── demo-repo · lint: npm run lint\nlint clean\n',
    );
    assert.ok(state.testAttempts >= 3);
    assert.ok(existsSync(join(dir, RUN_DIR, `F-1.test-${state.testAttempts}.log`)));
  } finally {
    cleanup();
  }
});

test('a run state from before the gate counter starts its logs at test-1', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const seed = fakeRunner({ dir, feature });
    await runFeature({ feature, config, prep, runner: seed, opts: { maxRounds: 2 } });
    const p = runStatePath(config, 'F-1');
    const old = JSON.parse(readFileSync(p, 'utf8'));
    delete old.testAttempts;
    old.status = 'running';
    writeFileSync(p, JSON.stringify(old));
    rmSync(join(dir, RUN_DIR, 'F-1.test-1.log'));
    const runner = fakeRunner({ dir, feature });
    await runFeature({ feature, config, prep, runner, opts: { resume: true, maxRounds: 2 } });
    assert.ok(existsSync(join(dir, RUN_DIR, 'F-1.test-1.log')));
  } finally {
    cleanup();
  }
});

test('items still open after the last full round get one closing round, and escalate only if it leaves them open', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let round = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          round += 1;
          writeSession(CH(feature), { pending: true, round });
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /the closing round after the review round cap \(2\) left open items/);
    const verifies = runner.calls.filter((c) => c.prompt === 'review-verify');
    assert.deepEqual(
      verifies.map((c) => c.vars.closingRound),
      ['false', 'false', 'true'],
      'two full rounds, then the closing one',
    );
    assert.match(verifies[2].vars.findingsPaths, /closing round/);
    const passes = runner.calls.filter((c) => c.prompt === 'review-correctness' || c.prompt === 'review-failure-paths');
    assert.equal(passes.length, 4, 'the closing round runs no dimension passes');
    assert.equal(
      runner.calls.filter((c) => c.prompt === 'feature-workon-review').length,
      2,
      'one fix per open round, closing fix included',
    );
    assert.equal(runner.calls.filter((c) => c.prompt === 'feature-fix-self-review').length, 2);
    const { body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.match(body, /## Escalation\n\nthe closing round/);
    assert.match(body, /- \[ \] invariant X/);
    const change = parseFrontmatter(readFileSync(CH(feature), 'utf8'));
    assert.equal(change.fm.review_round, '3');
    assert.match(change.body, /## Review Log\n\n### Session[\s\S]*- \[ \] invariant X/);
  } finally {
    cleanup();
  }
});

test('an escalation lists each open item whole: the claim without its Repro/Test/Class tail, wrapped at 100 columns', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    // Items the way the verifier writes them and `bl format` rewraps them: the
    // ` — Repro:` marker on a continuation line, `Class:` on the last one.
    const must = [
      '- [ ] A generated documentation root must remain one complete version when a generator or',
      '      a later run fails part way, so the published site never mixes two builds of the same',
      '      pages — Repro: `node scripts/gen.mjs --fail-at 3` then `ls docs/`. Test: `gen.test.js`',
      '      › "partial failure". Class: must-fix.',
    ].join('\n');
    const should = [
      '- [ ] The lock file is left behind when the run is interrupted before the gate',
      '      Class: should-fix.',
      '- [ ] Class: tail-only.',
    ].join('\n');
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          editFile(CH(feature), (fm, body) => {
            fm.review_round = '1';
            fm.review_status = 'addressed';
            const block = `### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\n${must}\n\n**Should fix**\n\n${should}\n\n**Nits**\nNone.\n`;
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const { body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    const escalation = extractSection(body, 'Escalation');
    assert.match(escalation, /Open items from session 2026-09-24:/);
    const claim =
      'A generated documentation root must remain one complete version when a generator or a later run fails part way, so the published site never mixes two builds of the same pages';
    const items = escalation
      .replace(/\n {6}(?=\S)/g, ' ')
      .split('\n')
      .filter((l) => l.startsWith('- [ ] '));
    assert.deepEqual(items, [
      `- [ ] ${claim}`,
      '- [ ] The lock file is left behind when the run is interrupted before the gate',
      // An item that is only a tail has no claim to cut to; it is shown whole, not as a bare box.
      '- [ ] Class: tail-only.',
    ]);
    assert.doesNotMatch(escalation, /Repro:|Test:|must-fix|should-fix/, 'the tail stays in the Review Log');
    assert.match(escalation, /\n {6}\S/, 'the long claim is wrapped');
    for (const line of escalation.split('\n')) assert.ok(line.length <= 100, `over 100 columns: ${line}`);
    const log = parseFrontmatter(readFileSync(CH(feature), 'utf8')).body;
    assert.match(log, /## Review Log[\s\S]*Class: must-fix\.\n/, 'the Review Log keeps the whole item');
  } finally {
    cleanup();
  }
});

test('a closing round that closes the last items finishes clean', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let round = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          round += 1;
          writeSession(CH(feature), { pending: round < 3, round });
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.equal(runner.calls.filter((c) => c.prompt === 'review-verify').length, 3);
    assert.ok(
      state.history.some((h) => h.step === 'test' && h.ok) &&
        state.history.filter((h) => h.step === 'test').length >= 3,
      'the closing fix goes through the test gate',
    );
  } finally {
    cleanup();
  }
});

test('run loop terminates within maxRounds when the verifier does not bump review_round', async () => {
  // Every way the verifier can fail to advance the round: leave it unchanged,
  // write something that is not a number, or lower it after a proper round.
  const classes = {
    unchanged: () => () =>
      editFile(featurePathOf(), (fm) => {
        fm.review_status = 'pending';
      }),
    'non-numeric': () => () =>
      editFile(featurePathOf(), (fm) => {
        fm.review_status = 'pending';
        fm.review_round = 'r1';
      }),
    lowered: () => {
      let n = 0;
      return () => {
        n += 1;
        writeSession(featurePathOf(), { pending: true, round: n === 1 ? 1 : 0 });
      };
    },
    'bumped twice': () => () => writeSession(featurePathOf(), { pending: true, round: 2 }),
  };
  let current;
  const featurePathOf = () => current;
  for (const [name, make] of Object.entries(classes)) {
    const { dir, cleanup, config, feature, prep } = setup();
    current = feature.indexPath;
    try {
      const verify = make();
      let verifies = 0;
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          verify: () => {
            verifies += 1;
            assert.ok(verifies <= 2, `${name}: verifier ran ${verifies} times with maxRounds 2`);
            verify();
          },
        },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated', name);
      assert.match(state.lastError, /the verifier left review_round at/, name);
      assert.ok(verifies <= 2, name);
    } finally {
      cleanup();
    }
  }
});

test('run never finishes clean with unpushed commits or without a PR when a forge is configured', async () => {
  const forgeOk = (runner) => (op) => {
    runner.calls.push({ type: 'forge', op });
    return { configured: true, status: 0, stdout: 'https://github.com/x/y/pull/7\n' };
  };
  const cases = {
    'push rejected': {
      shell: (cmd) => (cmd.startsWith('git push') ? { status: 1, output: 'rejected\n' } : null),
      expect: 'escalated',
    },
    'push reports success but origin lacks HEAD': {
      shell: (cmd) => (cmd.startsWith('git push') ? { status: 0, output: '' } : null),
      expect: 'escalated',
    },
    'change.open fails and change.find finds nothing': {
      forge: (runner) => (op) => {
        runner.calls.push({ type: 'forge', op });
        return op === 'change.open'
          ? { configured: true, status: 1, stdout: '', stderr: 'HTTP 502' }
          : { configured: true, status: 0, stdout: '[]' };
      },
      expect: 'escalated',
    },
    'forge named but its binary is missing': {
      forge: () => () => ({ configured: false, reason: 'missing-binary' }),
      expect: 'escalated',
    },
    'fix-tests commits after a fix round': { testResults: [0, 1, 0], fixTests: true, expect: 'clean' },
    'no forge configured (explicit opt-out)': {
      forge: () => () => ({ configured: false, reason: 'no-forge' }),
      expect: 'clean',
      noPr: true,
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({
        dir,
        feature,
        testResults: c.testResults ? [...c.testResults] : [],
        behaviour: {
          shell: c.shell,
          fixTests: c.fixTests ? () => runner.bumpHead() : undefined,
          verify: (() => {
            let round = 0;
            return () => {
              assert.ok(runner.published(), `${name}: review ran on an unpublished HEAD`);
              round += 1;
              writeSession(CH(feature), { pending: round === 1, round });
            };
          })(),
        },
      });
      runner.forge = (c.forge ?? forgeOk)(runner);
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, c.expect, name);
      if (state.status === 'clean') {
        assert.ok(runner.published(), `${name}: clean with unpushed commits`);
        if (!c.noPr) assert.equal(state.pr?.number, '7', name);
        else assert.equal(state.prOptOut, 'no-forge', name);
      } else {
        assert.ok(!runner.calls.some((x) => x.prompt === 'review-verify'), `${name}: reviewed without a publish`);
      }
    } finally {
      cleanup();
    }
  }
});

test('a nits-only addressed session ends the run clean and passes the merge review gate', async () => {
  // Open boxes in every list-marker shape, under each category. Only the
  // Nits ones may stay open on a session signed off as `addressed`.
  const sessions = {
    'nits only, - marker': { must: 'None.', nits: '- [ ] [safe] rename x', expect: 'clean' },
    'nits only, * and 1. markers': { must: 'None.', nits: '* [ ] [safe] rename x\n1. [ ] tidy y', expect: 'clean' },
    'open Must with * marker': { must: '* [ ] invariant X', nits: 'None.', expect: 'escalated' },
    'open Should with 1. marker': { must: 'None.', should: '1. [ ] invariant Y', nits: 'None.', expect: 'escalated' },
  };
  for (const [name, s] of Object.entries(sessions)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          verify: () =>
            editFile(CH(feature), (fm, body) => {
              fm.review_round = '1';
              fm.review_status = 'addressed';
              const block = `### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\n${s.must}\n\n**Should fix**\n\n${s.should ?? 'None.'}\n\n**Nits**\n\n${s.nits}\n`;
              return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
            }),
        },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, s.expect, name);
      const { fm, body } = parseFrontmatter(readFileSync(CH(feature), 'utf8'));
      const gate = featureReviewGate(fm.review_status, body);
      // clean ⇔ the merge gate lets it through
      assert.equal(gate.blocked, s.expect !== 'clean', name);
    } finally {
      cleanup();
    }
  }
});

test('re-review with no recorded base sha reviews the full branch diff', async () => {
  const narrow = /^Only the files changed by the fixes since the previous review/;
  const full = /^The full branch diff: `git diff main\.\.\.HEAD`\. No base commit/;
  const cases = {
    // `fixed` left by a manual fix; no run state at all.
    'fresh run, no run state': { resume: false, state: null, diff: 'src/a.js\n', scope: full },
    // --resume on a state file that never recorded a base.
    'resume, base sha null': { resume: true, state: { reviewBaseSha: null }, diff: 'src/a.js\n', scope: full },
    // A base, but the diff since it names nothing.
    'resume, base sha but no changed files': { resume: true, state: { reviewBaseSha: 'sha0' }, diff: '', scope: full },
    'resume, base sha and changed files': {
      resume: true,
      state: { reviewBaseSha: 'sha0' },
      diff: 'src/a.js\n',
      scope: narrow,
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const { dir, cleanup, config, feature, prep } = setup({ review_status: 'fixed', review_round: '1', pr: '7' });
    try {
      for (const s of prep.ordered) checkAll(join(dir, s.storyRelPath));
      if (c.state) {
        const st = {
          feature: 'F-1',
          status: 'escalated',
          step: 'fix',
          history: [{ step: 'pr' }],
          pr: { number: '7', url: '' },
          usage: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
          ...c.state,
        };
        mkdirSync(join(dir, RUN_DIR), { recursive: true });
        writeFileSync(runStatePath(config, 'F-1'), JSON.stringify(st));
      }
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          shell: (cmd) =>
            cmd.startsWith('git diff --name-only sha')
              ? { status: 0, output: c.diff }
              : cmd === 'git diff --name-only main...HEAD'
                ? { status: 0, output: 'src/a.js\nsrc/b.js\n' }
                : null,
          verify: () => writeSession(CH(feature), { pending: false, round: 2 }),
        },
      });
      await runFeature({ feature, config, prep, runner, opts: { resume: c.resume, maxRounds: 3 } });
      const passes = runner.calls.filter(
        (x) => x.prompt === 'review-correctness' || x.prompt === 'review-failure-paths',
      );
      assert.equal(passes.length, 2, name);
      for (const p of passes) {
        assert.equal(p.vars.reReview, 'true', name);
        assert.match(p.vars.reviewScope, c.scope, name);
        assert.doesNotMatch(p.vars.reviewScope, /\(none\)|unknown/, name);
        if (c.scope === full) assert.match(p.vars.changedFiles, /src\/b\.js/, name);
      }
    } finally {
      cleanup();
    }
  }
});

test('story without an Acceptance Criteria section is implemented, not skipped', async () => {
  // Stories that look finished (in_progress, every visible box checked) but
  // whose criteria are not under `## Acceptance Criteria`, or use a marker
  // other than `-`.
  const shapes = {
    'section named ## Acceptance': (b) =>
      b.replace('## Acceptance Criteria', '## Acceptance').replaceAll('- [ ]', '- [x]'),
    'no acceptance section': (b) => b.replace(/## Acceptance Criteria[\s\S]*$/, '## Summary\n\nDone, trust me.\n'),
    '* markers left open': (b) => b.replaceAll('- [ ]', '* [ ]'),
    'numbered markers left open': (b) =>
      b.replace('- [ ] one works', '1. [ ] one works').replace('- [ ] two works', '2. [ ] two works'),
  };
  for (const [name, reshape] of Object.entries(shapes)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      for (const s of prep.ordered) {
        editFile(join(dir, s.storyRelPath), (fm, body) => {
          fm.status = 'in_progress';
          return reshape(body);
        });
      }
      // The agent's session only checks `- [ ]` boxes, which none of these
      // shapes has open, so every story still reads as unfinished after it.
      const runner = fakeRunner({ dir, feature });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      const sessions = runner.calls.filter((c) => c.prompt === 'feature-story');
      assert.ok(sessions.length > 0, `${name}: story was skipped as complete`);
      assert.ok(!state.history.some((h) => /already complete/.test(h.note ?? '')), name);
      assert.equal(state.status, 'escalated', `${name}: passed the post-implement check`);
      assert.match(state.lastError, /S-1 acceptance criteria unmet after two sessions/, name);
    } finally {
      cleanup();
    }
  }

  // A session that renames the section does not pass the post-implement check.
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        story: (o) =>
          editFile(o.vars.storyAbsPath, (fm, body) => {
            fm.status = 'in_progress';
            return body.replace('## Acceptance Criteria', '## Acceptance');
          }),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const { body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.match(body, /no `## Acceptance Criteria` section/);
  } finally {
    cleanup();
  }
});

test('second bl run on the same feature refuses while the first is alive', async () => {
  const deadPid = spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;
  // Nested: the first run's first session starts a second run in-process.
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      let inner = null;
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          story: async (o) => {
            if (!inner)
              inner = runFeature({
                feature,
                config,
                prep,
                runner: fakeRunner({ dir, feature }),
                opts: { maxRounds: 2 },
              });
            checkAll(o.vars.storyAbsPath);
          },
        },
      });
      const outer = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      const second = await inner;
      assert.equal(second.status, 'failed');
      assert.equal(second.refused, true);
      assert.match(second.lastError, /another bl run \(pid \d+\) is running F-1/);
      assert.equal(outer.status, 'clean', 'the first run is unaffected');
      assert.equal(loadRunState(config, 'F-1').status, 'clean', 'the refusal did not overwrite run state');
      assert.ok(!existsSync(runLockPath(config, 'F-1')), 'the lock is released when the run ends');
    } finally {
      cleanup();
    }
  }
  // Another live process holds the run lock, or the session lock: the unit
  // directory's (F-60 D3), or a prep's with none, its worktree's.
  for (const which of ['run lock', 'worktree lock', 'unit directory lock']) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      if (which === 'unit directory lock') prep.unitDir = mkTempDir('bl-unit-');
      mkdirSync(join(dir, RUN_DIR), { recursive: true });
      writeFileSync(runStatePath(config, 'F-1'), JSON.stringify({ feature: 'F-1', status: 'running', history: [] }));
      const before = readFileSync(runStatePath(config, 'F-1'), 'utf8');
      const lockPath =
        which === 'run lock' ? runLockPath(config, 'F-1') : join(prep.unitDir ?? prep.worktreePath, '.workon.lock');
      writeFileSync(lockPath, `${process.ppid}\n2026-09-24T00:00:00Z\nother\n`);
      const runner = fakeRunner({ dir, feature });
      const state = await runFeature({ feature, config, prep, runner, opts: { resume: true, maxRounds: 2 } });
      assert.equal(state.status, 'failed', which);
      assert.equal(runner.calls.filter((c) => c.type === 'session').length, 0, which);
      assert.equal(readFileSync(runStatePath(config, 'F-1'), 'utf8'), before, `${which}: run state untouched`);
      assert.match(readFileSync(lockPath, 'utf8'), new RegExp(`^${process.ppid}\\n`), `${which}: lock untouched`);
    } finally {
      cleanup();
    }
  }
  // A lock left by a dead process is reclaimed.
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      mkdirSync(join(dir, RUN_DIR), { recursive: true });
      writeFileSync(runLockPath(config, 'F-1'), `${deadPid}\n`);
      const state = await runFeature({
        feature,
        config,
        prep,
        runner: fakeRunner({ dir, feature }),
        opts: { maxRounds: 2 },
      });
      assert.equal(state.status, 'clean');
    } finally {
      cleanup();
    }
  }
});

test('writeEscalation fills an Escalation heading with trailing whitespace', async () => {
  // Heading shapes extractSection accepts; the diagnosis must land in each.
  const shapes = {
    'trailing spaces': (t) => t.replace('## Escalation\n', '## Escalation  \n'),
    'trailing tab': (t) => t.replace('## Escalation\n', '## Escalation\t\n'),
    'CRLF file': (t) => t.replace(/\r?\n/g, '\r\n'),
    'CRLF file, heading with trailing space': (t) =>
      t.replace('## Escalation\n', '## Escalation \n').replace(/\r?\n/g, '\r\n'),
    'section followed by another': (t) =>
      t.replace(/## Escalation\n\nNone\.\n?/, '## Escalation\n\nNone.\n\n## Notes\n\nkeep me\n'),
    'no section at all': (t) => t.replace(/## Escalation\n\nNone\.\n?/, ''),
  };
  for (const [name, reshape] of Object.entries(shapes)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      writeFileSync(feature.indexPath, reshape(readFileSync(feature.indexPath, 'utf8')));
      const runner = fakeRunner({ dir, feature, testResults: [1, 1] });
      const state = await runFeature({ feature, config, prep, runner });
      assert.equal(state.status, 'escalated', name);
      const raw = readFileSync(feature.indexPath, 'utf8');
      if (name.startsWith('CRLF')) assert.ok(!/[^\r]\n/.test(raw), `${name}: line ends stay CRLF`);
      const text = raw.replace(/\r\n/g, '\n');
      const { fm, body } = parseFrontmatter(text);
      assert.equal(fm.status, 'escalated', name);
      assert.match(extractSection(body, 'Escalation'), /test gate failed twice/, `${name}: diagnosis written`);
      assert.equal((body.match(/^## Escalation/gm) || []).length, 1, `${name}: one Escalation section`);
      if (name === 'section followed by another') assert.match(body, /## Notes\n\nkeep me/);
      // The next run is blocked by it.
      const again = await runFeature({ feature, config, prep, runner: fakeRunner({ dir, feature }) });
      assert.equal(again.status, 'failed', name);
      assert.match(again.lastError, /Escalation is not empty/, name);
    } finally {
      cleanup();
    }
  }
});

test('a backlog commit that fails is recorded at the escalation and the pr: write', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [0, 1, 1],
      behaviour: {
        shell: (cmd) => (cmd.startsWith('git commit') ? { status: 1, output: 'index.lock exists\n' } : null),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const failed = state.history.filter((h) => h.ok === false && /backlog commit failed/.test(h.note ?? ''));
    // The run's start, each gate line, the PR record and the escalation.
    assert.deepEqual(failed.map((h) => h.step).sort(), ['escalate', 'pr', 'setup', 'test', 'test', 'test']);
    assert.ok(
      failed.find((h) => h.step === 'pr').note.includes('features/F1-feat/change.md is written but uncommitted'),
    );
  } finally {
    cleanup();
  }
});

test('a findings file left by an earlier attempt is not fed to the verifier', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    mkdirSync(join(dir, RUN_DIR), { recursive: true });
    // Stale files for both rounds and both dimensions.
    for (const r of [1, 2]) {
      for (const dim of ['correctness', 'failure-paths']) {
        writeFileSync(join(dir, RUN_DIR, `F-1.r${r}.${dim}.md`), 'STALE from an aborted attempt\n');
      }
    }
    const seen = [];
    let round = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          round += 1;
          for (const dim of ['correctness', 'failure-paths']) {
            seen.push(readFileSync(join(dir, RUN_DIR, `F-1.r${round}.${dim}.md`), 'utf8'));
          }
          writeSession(CH(feature), { pending: round === 1, round });
        },
      },
    });
    // The correctness pass writes nothing; failure-paths writes its file.
    const session = runner.session;
    runner.session = (o) =>
      o.promptName === 'review-correctness' ? { ok: true, output: '', isError: false, usage: null } : session(o);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.equal(seen.length, 4);
    for (const s of seen) assert.doesNotMatch(s, /STALE/);
    assert.equal(seen.filter((s) => /no findings file was produced by the correctness pass/.test(s)).length, 2);
  } finally {
    cleanup();
  }
});

test('--resume on an unreadable run state refuses; on a missing one it warns', async () => {
  const corrupt = {
    truncated: '{"feature":"F-1","pr":{"number":"7"},"history":[{"step":"pr"}',
    'not an object': '[]',
    null: 'null',
    "another feature's state": JSON.stringify({ feature: 'F-9', history: [] }),
    'no history': JSON.stringify({ feature: 'F-1' }),
  };
  for (const [name, content] of Object.entries(corrupt)) {
    const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
    try {
      mkdirSync(join(dir, RUN_DIR), { recursive: true });
      writeFileSync(runStatePath(config, 'F-1'), content);
      const runner = fakeRunner({ dir, feature });
      const state = await runFeature({ feature, config, prep, runner, opts: { resume: true, maxRounds: 2 } });
      assert.equal(state.status, 'failed', name);
      assert.match(state.lastError, /cannot resume: run state .* (is unreadable|is not a run state for F-1)/, name);
      assert.equal(runner.calls.filter((c) => c.type === 'session').length, 0, `${name}: nothing ran`);
      assert.equal(readFileSync(runStatePath(config, 'F-1'), 'utf8'), content, `${name}: file left for inspection`);
    } finally {
      cleanup();
    }
  }
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const logs = [];
    const runner = fakeRunner({ dir, feature });
    runner.log = (m) => logs.push(m);
    const state = await runFeature({ feature, config, prep, runner, opts: { resume: true, maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(logs.some((l) => /warning: no run state to resume/.test(l)));
    assert.match(state.history[0].note, /--resume: no run state found — starting a new run/);
  } finally {
    cleanup();
  }
});

test('an unknown plugins-test name fails the test gate instead of skipping it', async () => {
  for (const key of ['plugins-test', 'plugins']) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      editFile(feature.indexPath, (fm) => {
        fm[key] = ['no-such-plugin'];
      });
      const runner = fakeRunner({ dir, feature });
      runner.testPlugins = (cfg, p) => resolveFeaturePluginsReport('test', cfg, p);
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated', key);
      assert.equal(state.lastError, 'test gate misconfigured', key);
      assert.ok(
        state.history.some(
          (h) => h.step === 'test' && h.ok === false && /unknown test plugin: no-such-plugin/.test(h.note),
        ),
        key,
      );
      assert.ok(!state.history.some((h) => /skipped/.test(h.note ?? '') && h.step === 'test'), key);
      assert.ok(!runner.calls.some((c) => c.type === 'forge'), `${key}: no PR for an untested branch`);
      assert.ok(!runner.calls.some((c) => c.prompt === 'feature-fix-tests'), `${key}: not an agent-fixable failure`);
    } finally {
      cleanup();
    }
  }
});

test("the test gate fills the feature's session number into plugin commands", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    prep.baseVars = { ...prep.baseVars, sessionId: 's1', sessionNum: '1' };
    const runner = fakeRunner({ dir, feature });
    runner.testPlugins = () => ({
      plugins: [{ name: 'app', command: 'env PLAYWRIGHT_SESSION_ID={{sessionNum}} SID={{sessionId}} npm test' }],
      unknown: [],
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const ran = runner.calls.filter((c) => c.type === 'shell' && /PLAYWRIGHT_SESSION_ID/.test(c.cmd)).map((c) => c.cmd);
    assert.ok(ran.length > 0);
    for (const cmd of ran) assert.equal(cmd, 'env PLAYWRIGHT_SESSION_ID=1 SID=s1 npm test');
  } finally {
    cleanup();
  }
});

test('a Go template in a test plugin command is not an unresolved placeholder', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const cmd = "docker ps --format '{{.Names}}' && docker inspect -f '{{ .State.Status }}' x";
    runner.testPlugins = () => ({ plugins: [{ name: 'probe', command: cmd }], unknown: [] });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.ok(runner.calls.some((c) => c.type === 'shell' && c.cmd === cmd));
  } finally {
    cleanup();
  }
});

test('a test plugin left with an unresolved placeholder escalates as misconfigured and never runs', async () => {
  for (const [label, baseVars, command, placeholder] of [
    [
      'unknown name',
      { sessionId: 's1', sessionNum: '1' },
      'env PLAYWRIGHT_SESSION_ID={{sessionNum}} X={{bogus}} npm test',
      '{{bogus}}',
    ],
    ['no session number', {}, 'env PLAYWRIGHT_SESSION_ID={{sessionNum}} npm test', '{{sessionNum}}'],
  ]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      prep.baseVars = { ...prep.baseVars, ...baseVars };
      const runner = fakeRunner({ dir, feature });
      runner.testPlugins = () => ({
        plugins: [
          { name: 'node', command: 'npm test' },
          { name: 'app', command },
        ],
        unknown: [],
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated', label);
      assert.equal(state.lastError, 'test gate misconfigured', label);
      const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
      assert.ok(esc.includes(`unresolved placeholder ${placeholder} in test plugin app`), `${label}: ${esc}`);
      assert.ok(
        !runner.calls.some((c) => c.type === 'shell' && /npm test/.test(c.cmd)),
        `${label}: no plugin ran, not even the valid one before it`,
      );
      assert.ok(!runner.calls.some((c) => c.prompt === 'feature-fix-tests'), `${label}: not an agent-fixable failure`);
    } finally {
      cleanup();
    }
  }
});

test("bl review takes the loop's review path: split passes, verifier, shared run state", async () => {
  assert.ok(
    !existsSync(new URL('../../prompts/feature-review.md', import.meta.url)),
    'the monolithic prompt is retired',
  );
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  try {
    const runner = fakeRunner({ dir, feature });
    const first = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.deepEqual(first, { status: 'pending', round: 1, escalated: false, error: null });
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt),
      ['review-correctness', 'review-failure-paths', 'review-verify'],
    );
    const saved = loadRunState(config, 'F-1');
    assert.equal(saved.status, 'reviewed');
    assert.equal(saved.reviewBaseSha, 'sha0', 'a later re-review narrows from this base');
    assert.ok(!existsSync(runLockPath(config, 'F-1')), 'lock released');

    // After a fix, the re-review narrows to the files the fix changed.
    editFile(CH(feature), (fm) => {
      fm.review_status = 'fixed';
    });
    const second = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(second.round, 2);
    const reverify = runner.calls.filter((c) => c.prompt === 'review-verify')[1];
    assert.equal(reverify.vars.reReview, 'true');
    assert.match(reverify.vars.reviewScope, /^Only the files changed by the fixes since the previous review \(sha0\)/);

    // At the cap it refuses rather than spend a round past it.
    const capped = await reviewFeature({ feature, config, prep, runner, maxRounds: 2 });
    assert.equal(capped.refused, true);
    assert.match(capped.lastError, /round cap \(2\) already reached at round 2/);

    // It refuses while a run holds the feature.
    writeFileSync(runLockPath(config, 'F-1'), `${process.ppid}\n`);
    const busy = await reviewFeature({ feature, config, prep, runner, maxRounds: 5 });
    assert.equal(busy.refused, true);
    assert.match(busy.lastError, /a bl run \(pid \d+\) is running F-1/);
  } finally {
    cleanup();
  }
});

test('an agent that writes ## Escalation while implementing stops the run before any PR', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        story: (o) => {
          if (o.vars.storyId === 'S-2') {
            editFile(feature.indexPath, (fm, body) =>
              body.replace(/## Escalation\n\nNone\./, '## Escalation\n\nPremise false: the store has no CAS.'),
            );
          } else {
            checkAll(o.vars.storyAbsPath);
          }
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /escalated while implementing S-2/);
    assert.ok(!runner.calls.some((c) => c.prompt === 'feature-self-review'));
    assert.equal(parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm.status, 'escalated');
  } finally {
    cleanup();
  }
});

test('unmet acceptance criteria get one retry with a nudge, then escalate', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const nudges = [];
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        story: (o) => {
          nudges.push(o.vars.nudge); /* never checks anything */
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /S-1 acceptance criteria unmet after two sessions/);
    assert.equal(nudges.length, 2);
    assert.equal(nudges[0], '');
    assert.match(nudges[1], /still unchecked/);
    assert.match(nudges[1], /one works/);
  } finally {
    cleanup();
  }
});

test('resume skips stories that are already complete and an open escalation blocks a restart', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    // S-1 already implemented.
    checkAll(join(dir, prep.ordered[0].storyRelPath));
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { resume: true, maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(
      runner.calls.filter((c) => c.prompt === 'feature-story').map((c) => c.story),
      ['S-2'],
    );
    assert.ok(state.history.some((h) => h.story === 'S-1' && /skipped/.test(h.note)));
    assert.equal(loadRunState(config, 'F-1').status, 'clean');

    // Now leave an escalation open and try again.
    editFile(feature.indexPath, (fm, body) => body.replace(/## Escalation\n\nNone\./, '## Escalation\n\nStill open.'));
    const again = await runFeature({
      feature,
      config,
      prep,
      runner: fakeRunner({ dir, feature }),
      opts: { resume: true },
    });
    assert.equal(again.status, 'failed');
    assert.match(again.lastError, /Escalation is not empty/);
  } finally {
    cleanup();
  }
});

test('a self-review that changes the tree re-runs the test gate', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature, behaviour: { selfReview: () => runner.bumpHead() } });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    // stories gate + post-self-review gate + post-fix gate
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 3);
  } finally {
    cleanup();
  }
});

test('a failed test gate leaves the run stopped at the test step, not a generic stop', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const state = await runFeature({
      feature,
      config,
      prep,
      runner: fakeRunner({ dir, feature, testResults: [1, 1] }),
    });
    assert.equal(state.status, 'escalated');
    assert.equal(state.step, 'test');
    assert.equal(loadRunState(config, 'F-1').step, 'test');
    assert.ok(state.history.some((h) => h.step === 'test' && h.ok === false && /node exited 1/.test(h.note)));
  } finally {
    cleanup();
  }
});

test('a denied tool is recorded as a failed event on the step it happened in', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const session = runner.session;
    runner.session = (o) => {
      const r = session(o);
      return o.promptName === 'feature-self-review' ? { ...r, denials: ['Bash(curl evil)'] } : r;
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', 'a denial does not stop the loop');
    const ev = state.history.find((h) => h.step === 'self-review');
    assert.equal(ev.ok, false);
    assert.match(ev.note, /denied: Bash\(curl evil\)/);
  } finally {
    cleanup();
  }
});

test('change.open failing on an existing PR adopts it via change.find and describes it', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    runner.forge = (op, vars) => {
      runner.calls.push({ type: 'forge', op, vars });
      if (op === 'change.open')
        return { configured: true, status: 1, stdout: '', stderr: 'a pull request already exists' };
      if (op === 'change.describe') return { configured: true, status: 0, stdout: '' };
      return {
        configured: true,
        status: 0,
        stdout: JSON.stringify([{ number: 42, url: 'https://github.com/x/y/pull/42', state: 'OPEN' }]),
      };
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.pr.number, '42');
    assert.deepEqual(runner.calls.find((c) => c.op === 'change.find').vars, { branch: 'f1-feat' });
    // The adopted PR's body becomes the change document's projection.
    const describe = runner.calls.find((c) => c.op === 'change.describe');
    assert.equal(describe.vars.number, '42');
    assert.match(describe.vars.body, /^Feature F-1: Feat\n/);
    assert.equal(parseChange(readFileSync(CH(feature), 'utf8')).repos[0].pr, '42');
  } finally {
    cleanup();
  }
});

test('forge: none — the run finishes clean, change.md records the branch with an empty pr:, no forge warning', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  const writes = [];
  const orig = process.stderr.write;
  try {
    assert.equal(config.raw.forge, undefined, 'the fixture has no forge key');
    const runner = fakeRunner({ dir, feature });
    runner.forge = (op, vars, opts) => {
      runner.calls.push({ type: 'forge', op, vars });
      return runForgeOp(op, vars, opts);
    };
    process.stderr.write = (chunk, ...rest) => {
      writes.push(String(chunk));
      return true;
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    process.stderr.write = orig;
    assert.equal(state.status, 'clean');
    assert.equal(state.prOptOut, 'no-forge');
    assert.deepEqual(parseChange(readFileSync(CH(feature), 'utf8')).repos, [
      { repo: 'demo-repo', branch: 'f1-feat', pr: '', url: '', merged: '' },
    ]);
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'forge').map((c) => c.op),
      ['change.open'],
    );
    assert.deepEqual(
      writes.filter((w) => /forge|change\.open/.test(w)),
      [],
      'no warning per op',
    );
  } finally {
    process.stderr.write = orig;
    cleanup();
  }
});

test('change.find listing only a merged PR for the branch is not adopted', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    runner.forge = (op, vars) => {
      runner.calls.push({ type: 'forge', op, vars });
      if (op === 'change.open') return { configured: true, status: 1, stdout: '', stderr: 'HTTP 422' };
      return { configured: true, status: 0, stdout: JSON.stringify([{ number: 9, url: 'u', state: 'MERGED' }]) };
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.ok(state.history.some((h) => /change\.find found no open PR/.test(h.note ?? '')));
  } finally {
    cleanup();
  }
});

test("a re-run rewrites the recorded PR's body through change.describe only when ## Description changed", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const first = fakeRunner({ dir, feature });
    await runFeature({ feature, config, prep, runner: first, opts: { maxRounds: 2 } });
    assert.equal(creates(first).length, 1);
    assert.equal(
      first.calls.filter((c) => c.op === 'change.describe').length,
      0,
      'a PR just opened has the current body',
    );

    // The same description on a resumed run: nothing to send.
    const same = fakeRunner({ dir, feature });
    await runFeature({ feature, config, prep, runner: same, opts: { maxRounds: 2, resume: true } });
    assert.equal(creates(same).length, 0, 'the recorded PR is not opened again');
    assert.equal(same.calls.filter((c) => c.op === 'change.describe').length, 0);

    // The operator rewrites the Description; the next run projects it.
    const path = CH(feature);
    const doc = parseChange(readFileSync(path, 'utf8'));
    doc.body = replaceSection(doc.body, 'Description', 'A new description.');
    writeFileSync(path, serializeChange(doc));
    const changed = fakeRunner({ dir, feature });
    await runFeature({ feature, config, prep, runner: changed, opts: { maxRounds: 2, resume: true } });
    const describes = changed.calls.filter((c) => c.op === 'change.describe');
    assert.equal(describes.length, 1);
    assert.equal(describes[0].vars.number, '7');
    assert.match(describes[0].vars.body, /^A new description\.\n\nFeature file: features\/F1-feat\/index\.md\n/);
  } finally {
    cleanup();
  }
});

test('resume after the round cap fixes the pending session first and skips self-review', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let round = 0;
    const capped = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          round += 1;
          writeSession(CH(feature), { pending: true, round });
        },
      },
    });
    const first = await runFeature({ feature, config, prep, runner: capped, opts: { maxRounds: 2 } });
    assert.equal(first.status, 'escalated');
    // Operator clears the escalation and resumes.
    editFile(feature.indexPath, (fm, body) => {
      fm.status = 'running';
      return body.replace(/## Escalation\n\n[\s\S]*$/, '## Escalation\n\nNone.\n');
    });
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { verify: () => writeSession(CH(feature), { pending: false, round: 4 }) },
    });
    // The first run spent two full rounds and the closing round (round 3).
    // Another full round needs the cap raised explicitly.
    assert.equal(parseFrontmatter(readFileSync(CH(feature), 'utf8')).fm.review_round, '3');
    const state = await runFeature({ feature, config, prep, runner, opts: { resume: true, maxRounds: 4 } });
    assert.equal(state.status, 'clean');
    const prompts = runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt);
    assert.deepEqual(prompts, [
      'feature-workon-review',
      'feature-fix-self-review',
      'review-correctness',
      'review-failure-paths',
      'review-verify',
    ]);

    // Resuming a clean run is a no-op.
    const again = fakeRunner({ dir, feature });
    const done = await runFeature({ feature, config, prep, runner: again, opts: { resume: true, maxRounds: 4 } });
    assert.equal(done.status, 'clean');
    assert.equal(again.calls.filter((c) => c.type === 'session').length, 0);
  } finally {
    cleanup();
  }
});

test('a run that enters at the cap runs only the closing round it is owed, and never a round past it', async () => {
  // At the cap: pending is fixed then verified, fixed is verified; addressed and
  // unset have nothing owed. Past the cap (the closing round done): nothing runs.
  const cases = [
    { round: '2', status: 'pending', fixes: 1, verifies: 1 },
    { round: '2', status: 'fixed', fixes: 0, verifies: 1 },
    { round: '2', status: 'addressed', fixes: 0, verifies: 0 },
    { round: '2', status: '', fixes: 0, verifies: 0 },
    { round: '3', status: 'pending', fixes: 0, verifies: 0 },
    { round: '3', status: 'fixed', fixes: 0, verifies: 0 },
  ];
  for (const c of cases) {
    for (const resume of [false, true]) {
      const { dir, cleanup, config, feature, prep } = setup({
        ...(c.status ? { review_status: c.status } : {}),
        review_round: c.round,
        pr: '7',
      });
      try {
        for (const s of prep.ordered) checkAll(join(dir, s.storyRelPath));
        if (resume) {
          // A run that already got as far as the PR.
          const st = {
            feature: 'F-1',
            status: 'escalated',
            step: 'review',
            history: [{ step: 'pr' }],
            pr: { number: '7', url: '' },
            reviewBaseSha: 'sha0',
            usage: { input: 0, output: 0, cache_creation: 0, cache_read: 0 },
          };
          mkdirSync(join(dir, RUN_DIR), { recursive: true });
          writeFileSync(runStatePath(config, 'F-1'), JSON.stringify(st));
        }
        const runner = fakeRunner({
          dir,
          feature,
          behaviour: { verify: () => writeSession(CH(feature), { pending: false, round: Number(c.round) + 1 }) },
        });
        const state = await runFeature({ feature, config, prep, runner, opts: { resume, maxRounds: 2 } });
        const label = `round=${c.round}, status=${JSON.stringify(c.status)}, resume=${resume}`;
        const prompts = runner.calls.filter((x) => x.type === 'session').map((x) => x.prompt);
        assert.equal(prompts.filter((p) => p === 'feature-workon-review').length, c.fixes, `${label}: fixes`);
        assert.equal(prompts.filter((p) => p === 'review-verify').length, c.verifies, `${label}: verifies`);
        assert.ok(
          !prompts.includes('review-correctness') && !prompts.includes('review-failure-paths'),
          `${label}: no full round past the cap`,
        );
        if (c.verifies) {
          assert.equal(runner.calls.find((x) => x.prompt === 'review-verify').vars.closingRound, 'true', label);
          assert.equal(state.status, 'clean', label);
          continue;
        }
        if (c.status === 'addressed' && resume) {
          // Signed off on the code this run already published: nothing left to review.
          assert.equal(state.status, 'clean', label);
          continue;
        }
        assert.equal(parseFrontmatter(readFileSync(CH(feature), 'utf8')).fm.review_round, c.round, label);
        assert.equal(state.status, 'escalated', label);
        assert.match(state.lastError, new RegExp(`round cap \\(2\\) already reached at round ${c.round}`), label);
        const { body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
        assert.match(body, new RegExp(`--max-rounds ${Number(c.round) + 1}`), label);
      } finally {
        cleanup();
      }
    }
  }
});

/** Fake `git status --porcelain -z` that reports whichever of `paths` exist under the worktree. */
function statusOf(wt, paths) {
  return (cmd) => {
    if (!cmd.startsWith('git status --porcelain')) return null;
    return {
      status: 0,
      output: paths
        .filter((p) => existsSync(join(wt, p)))
        .map((p) => `?? ${p}\0`)
        .join(''),
    };
  };
}

test("a reviewer's leftover file is quarantined out of the worktree and never reaches the test gate", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const probe = 'test/unit/zz-repro-scratch.test.js';
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        review: (o) => {
          if (o.vars.dimension !== 'failure-paths') return;
          assert.match(o.vars.scratchDir, /F-1\.r\d\.failure-paths\.scratch$/, 'reviewer is given a scratch dir');
          mkdirSync(join(prep.worktreePath, 'test', 'unit'), { recursive: true });
          writeFileSync(join(prep.worktreePath, probe), "test('REPRO', () => { throw new Error('stale'); });\n");
        },
        shell: statusOf(prep.worktreePath, [probe]),
        output: (o) => (o.promptName === 'review-verify' ? 'noise\nREVIEW pending round 1\n' : ''),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
    assert.equal(existsSync(join(prep.worktreePath, probe)), false, 'probe moved out of the worktree');
    const hygiene = state.history.filter((h) => h.step.startsWith('hygiene:'));
    assert.equal(hygiene.length, 2, 'once per round with a failure-paths pass');
    assert.match(
      hygiene[0].note,
      /reviewer left 1 untracked file in the worktree — quarantined to \.bl\/run\/F-1\.quarantine\//,
    );
    const qdir = join(dir, '.bl', 'run', 'F-1.quarantine');
    const kept = readdirSync(qdir)
      .map((d) => join(qdir, d, 'untracked', probe))
      .filter(existsSync);
    assert.equal(kept.length, 2, 'each copy is kept for the operator');
    assert.ok(!state.history.some((h) => h.step === 'test' && !h.ok), 'the gate never saw the probe');
    const verify = state.history.find((h) => h.step === 'review:verify');
    assert.match(verify.note, /said: REVIEW pending round 1/, "the agent's last line is recorded");
  } finally {
    cleanup();
  }
});

test('a dirty worktree fails the gate with the file list; fix-tests cleans it and the gate passes', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const stray = 'notes-scratch.txt';
    let fixLog = null;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        story: (o) => {
          checkAll(o.vars.storyAbsPath);
          writeFileSync(join(prep.worktreePath, stray), 'forgot to delete\n');
        },
        shell: statusOf(prep.worktreePath, [stray]),
        fixTests: (o) => {
          fixLog = o.vars;
          rmSync(join(prep.worktreePath, stray));
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
    assert.match(fixLog.testCommand, /git status --porcelain/);
    assert.match(fixLog.testExcerpt, /\?\? notes-scratch\.txt/);
    assert.equal(fixLog.testLogPath, join(dir, RUN_DIR, 'F-1.test-1.log'));
    assert.match(
      readFileSync(fixLog.testLogPath, 'utf8'),
      /\?\? notes-scratch\.txt/,
      'a dirty-tree refusal writes its list as the log',
    );
    const firstGate = state.history.find((h) => h.step === 'test');
    assert.equal(firstGate.ok, false);
    assert.match(firstGate.note, /worktree not clean: 1 path \(notes-scratch\.txt\)/);
    assert.equal(runner.calls.filter((c) => c.prompt === 'feature-fix-tests').length, 1);
  } finally {
    cleanup();
  }
});

test('a worktree that stays dirty after fix-tests escalates without running the suite', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const stray = 'left-behind.js';
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        story: (o) => {
          checkAll(o.vars.storyAbsPath);
          writeFileSync(join(prep.worktreePath, stray), 'x\n');
        },
        shell: statusOf(prep.worktreePath, [stray]),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /test gate failed twice/);
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 0, 'the suite never ran on a dirty tree');
    assert.ok(!runner.calls.some((c) => c.type === 'forge'), 'no PR');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Quarantine against a real git worktree
// ---------------------------------------------------------------------------

function git(wt, ...args) {
  const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** `setup()` whose worktree is a real git repo with a.js, b.js, c.js, gone.js committed on main. */
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
        verify: () =>
          editFile(CH(feature), (fm, body) => {
            fm.review_round = '1';
            fm.review_status = 'pending';
            const block =
              '### Session 2026-09-24 (PR #7, #12)\n\n**Must fix**\n\n- [ ] repo-b: invariant Y — Repro: y. Test: z.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n';
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          }),
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
    assert.deepEqual(r, { status: 'pending', round: 1, escalated: false, error: null });
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
    const { fm, body } = parseFrontmatter(readFileSync(CH(feature), 'utf8'));
    assert.equal(fm.review_round, '1');
    assert.equal(loadRunState(config, 'F-1').pr.number, '7', 'run state keeps the primary PR');
    assert.equal(featureReviewGate(fm.review_status, body).blocked, true, "repo B's open Must gates the merge");
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
            fm.review_round = '1';
            fm.review_status = 'addressed';
            const block =
              '### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\n- [ ] invariant X\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n';
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
          toCrlf();
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
            return base.session({ ...o, promptName: 'feature-workon-review' });
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

test('two runs reclaiming the same stale lock cannot both acquire it', () => {
  const deadPid = spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;
  // The run lock, and the helper the headless `.workon.lock` uses.
  const { dir, cleanup, config } = setup();
  try {
    mkdirSync(join(dir, RUN_DIR), { recursive: true });
    const cases = {
      'run lock': { path: runLockPath(config, 'F-1'), take: (hooks) => acquireRunLock(config, 'F-1', hooks) },
      '.workon.lock': {
        path: join(dir, '.workon.lock'),
        take: (hooks) => acquirePidLock(join(dir, '.workon.lock'), `${process.pid}\nx\n${Math.random()}\n`, hooks),
      },
    };
    for (const [name, { path, take }] of Object.entries(cases)) {
      writeFileSync(path, `${deadPid}\n2026-09-24T00:00:00Z\nstale\n`);
      // B reads the stale lock; before B reclaims it, A reclaims it and takes it.
      let a = null;
      const b = take({
        beforeReclaim: () => {
          a ??= take();
        },
      });
      assert.ok(a?.content, `${name}: A took the reclaimed lock`);
      assert.equal(b.content, undefined, `${name}: B did not also take it`);
      assert.equal(b.holder, process.pid, `${name}: B reports A as the holder`);
      assert.equal(readFileSync(path, 'utf8'), a.content, `${name}: A's lock is intact`);
      assert.ok(!existsSync(`${path}.reclaim`), `${name}: reclaim mutex released`);
      releasePidLock(path, a.content);
      assert.ok(!existsSync(path), name);

      // A reclaim mutex left by a reclaimer that died does not block for ever.
      writeFileSync(path, `${deadPid}\n`);
      writeFileSync(`${path}.reclaim`, `${deadPid}\n`);
      const c = take();
      assert.ok(c.content, `${name}: stale lock reclaimed past a dead reclaimer's mutex`);
      releasePidLock(path, c.content);
    }
  } finally {
    cleanup();
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
    const lock = join(s.prep.unitDir, '.workon.lock');
    const runner = fakeRunner({
      dir: s.dir,
      feature: s.feature,
      behaviour: { verify: () => writeSession(CH(s.feature), { pending: false, round: 1 }) },
    });
    const seen = [];
    const session = runner.session;
    runner.session = (o) => {
      seen.push({
        unit: existsSync(lock) ? readFileSync(lock, 'utf8').split('\n', 1)[0] : null,
        worktrees: others.filter((wt) => existsSync(join(wt, '.workon.lock'))),
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
    assert.ok(!existsSync(lock), 'released after the round');

    // A live session in the unit directory: no pass runs.
    writeFileSync(lock, `${process.ppid}\n2026-10-28T00:00:00Z\nF-1: interactive\n`);
    seen.length = 0;
    const held = await reviewFeature({
      feature: s.feature,
      config: s.config,
      prep: s.prep,
      runner,
      pr: { number: '7', url: 'u' },
      otherRepos,
      maxRounds: 3,
    });
    assert.deepEqual(seen, []);
    assert.match(
      held.error,
      new RegExp(`a live session \\(pid ${process.ppid}\\) holds ${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  } finally {
    s.cleanup();
  }
});

test('a review round locks every scoped worktree and aborts without verification when any pass fails', async () => {
  const lockOf = (wt) => join(wt, '.workon.lock');
  // Another process trying to start a session in `wt`: what acquirePidLock tells it.
  const otherProcessTakes = (wt) => {
    const src = `import { acquirePidLock, releasePidLock } from ${JSON.stringify(new URL('../../src/pid-lock.js', import.meta.url).href)};
const t = acquirePidLock(${JSON.stringify(lockOf(wt))}, process.pid + "\\n");
if (t.content) releasePidLock(${JSON.stringify(lockOf(wt))}, t.content);
console.log(t.content ? "taken" : "held by " + t.holder);`;
    return spawnSyncFiles(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }).stdout.trim();
  };
  const PASSES = ['review-correctness', 'review-failure-paths', 'review-verify'];
  const scenario = async ({
    failAt = null,
    preLock = null,
    failure = { ok: false, isError: true, error: 'provider crashed' },
  }) => {
    const s = setup({ pr: '7' });
    const others = [mkTempDir('bl-wt-b-'), mkTempDir('bl-wt-c-')];
    const all = [s.prep.worktreePath, ...others];
    try {
      if (preLock) writeFileSync(lockOf(all[preLock.at]), preLock.content);
      const runner = fakeRunner({
        dir: s.dir,
        feature: s.feature,
        behaviour: { verify: () => writeSession(CH(s.feature), { pending: false, round: 1 }) },
      });
      const seen = [];
      const session = runner.session;
      runner.session = (o) => {
        seen.push({
          prompt: o.promptName,
          locks: all.map((wt) => (existsSync(lockOf(wt)) ? readFileSync(lockOf(wt), 'utf8').split('\n', 1)[0] : null)),
          other: o.promptName === 'review-correctness' ? all.map(otherProcessTakes) : null,
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
        locksAfter: all.map((wt) => (existsSync(lockOf(wt)) ? readFileSync(lockOf(wt), 'utf8') : null)),
        state: loadRunState(s.config, 'F-1'),
      };
    } finally {
      for (const wt of others) rmSync(wt, { recursive: true, force: true });
      s.cleanup();
    }
  };

  // Every session of a clean round runs with every scoped worktree locked by
  // this process; another process is refused each one; all are released after.
  const ok = await scenario({});
  assert.deepEqual(ok.r, { status: 'addressed', round: 1, escalated: false, error: null });
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

  // A lock this process already held is used and left in place.
  const own = `${process.pid}\n2026-09-24T00:00:00Z\nF-1 run\n`;
  const kept = await scenario({ preLock: { at: 1, content: own } });
  assert.equal(kept.r.error, null);
  assert.deepEqual(kept.locksAfter, [null, own, null]);

  // A live session in any scoped worktree: no pass runs, its lock is untouched,
  // and nothing the round took is left behind.
  const live = `${process.ppid}\n2026-09-24T00:00:00Z\nF-1: interactive\n`;
  for (const at of [0, 1, 2]) {
    const x = await scenario({ preLock: { at, content: live } });
    assert.deepEqual(x.seen, [], `worktree ${at} held: no session ran`);
    assert.match(x.r.error, new RegExp(`a live session \\(pid ${process.ppid}\\) holds`));
    assert.equal(x.after, x.before, `worktree ${at} held: the feature file is untouched`);
    assert.deepEqual(
      x.locksAfter,
      [0, 1, 2].map((i) => (i === at ? live : null)),
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
      assert.match(x.r.error, /failed: /, name);
      assert.equal(x.r.status, '', `${name}: no verdict`);
      assert.equal(x.r.round, 0, `${name}: the round is not spent`);
      assert.equal(parseFrontmatter(x.after).fm.review_status, undefined, name);
      assert.equal(x.after, x.before, `${name}: the feature file is as it was`);
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
      behaviour: { verify: () => writeSession(CH(feature), { pending: false, round: 1 }) },
    });
    const session = runner.session;
    runner.session = (o) =>
      o.promptName === 'review-failure-paths'
        ? { ...session(o), ok: false, isError: true, error: 'provider crashed' }
        : session(o);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /review round 1 aborted before a verdict/);
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
          editFile(CH(feature), (fm, body) => {
            fm.review_status = 'fixed';
            return body.replaceAll('- [ ] invariant', '- [x] invariant');
          });
        },
        verify: () => writeSession(CH(feature), { pending: false, round: 2 }),
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
  const failures = {
    'ok: false': { ok: false, isError: true, error: 'provider failed', output: '' },
    'isError with ok': { ok: true, isError: true, output: 'half done' },
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
  } finally {
    cleanup();
  }
});

test('a fix self-review that changes review_status escalates instead of re-reviewing', async () => {
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
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /fix self-review for round 1 changed review_status/);
    assert.equal(runner.calls.filter((c) => c.prompt === 'review-verify').length, 1, 'no re-review after it');
  } finally {
    cleanup();
  }
});

/**
 * Wrap a fake runner with a scripted container table. `during` maps a session
 * prompt name to the containers that session "starts".
 */
function withContainers(runner, { initial = [], during = {} } = {}) {
  let table = [...initial];
  const removed = [];
  return {
    ...runner,
    session(o) {
      const r = runner.session(o);
      for (const c of during[o.promptName] ?? []) table.push(c);
      return r;
    },
    listContainers() {
      return table.map((c) => ({ ...c }));
    },
    removeContainers(ids) {
      removed.push(...ids);
      table = table.filter((c) => !ids.includes(c.id));
      return { status: 0, output: '' };
    },
    removed,
  };
}

test('containers a session leaves behind are removed; compose-stack and pre-existing containers are not', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      initial: [
        { id: 'aaa-stack-minio', name: 'containers-minio-1', compose: true },
        { id: 'bbb-old-probe', name: 'old-probe', compose: false },
      ],
      during: {
        'review-failure-paths': [
          { id: 'ccc-minio-in-memory', name: 'minio-in-memory', compose: false },
          { id: 'ddd-session-stack', name: 'containers-s9-account-1', compose: true },
        ],
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-4)));
    assert.deepEqual(
      [...new Set(runner.removed)],
      ['ccc-minio-in-memory'],
      'only the non-compose container the session created',
    );
    const hygiene = state.history.filter((h) => h.step === 'hygiene:containers');
    assert.ok(hygiene.length >= 1);
    assert.match(hygiene[0].note, /removed 1 container left by review:failure-paths: minio-in-memory/);
    assert.ok(hygiene.every((h) => h.ok));
  } finally {
    cleanup();
  }
});

test("the test gate's own containers are removed too", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const base = fakeRunner({ dir, feature });
    let gateRuns = 0;
    const runner = withContainers(base);
    const shell = runner.shell;
    runner.shell = (cmd, cwd) => {
      // The gate's integration tests start a helper container (see listContainers below).
      if (cmd === 'npm test') gateRuns += 1;
      return shell(cmd, cwd);
    };
    const list = runner.listContainers;
    runner.listContainers = () => {
      const t = list();
      return gateRuns > 0 && !runner.removed.includes('eee-dynamodb')
        ? [...t, { id: 'eee-dynamodb', name: 'dynamodb-inviteConcurrency', compose: false }]
        : t;
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(runner.removed.includes('eee-dynamodb'));
    assert.ok(
      state.history.some(
        (h) => h.step === 'hygiene:containers' && /left by test gate: dynamodb-inviteConcurrency/.test(h.note),
      ),
    );
  } finally {
    cleanup();
  }
});

test('container cleanup snapshot and removal failures stop safely without masking the wrapped step', async () => {
  const leak = { id: 'ggg-leak', name: 'minio-in-memory', compose: false };
  // How the second snapshot (after the step) or the removal fails.
  const snapshotFailures = {
    'nonzero (null)': () => null,
    missing: () => undefined,
    'malformed list': () => ({ id: 'x' }),
    'malformed entry': () => [{ name: 'no-id' }],
    thrown: () => {
      throw new Error('docker ps timed out');
    },
  };
  const removalFailures = {
    nonzero: () => ({ status: 1, output: 'daemon error' }),
    missing: () => undefined,
    malformed: () => ({ output: '?' }),
    thrown: () => {
      throw new Error('docker rm hung');
    },
  };
  const cases = [
    ...Object.entries(snapshotFailures).map(([k, list]) => ({
      kind: `snapshot ${k}`,
      list,
      remove: null,
      live: /may still be running/,
    })),
    ...Object.entries(removalFailures).map(([k, remove]) => ({
      kind: `removal ${k}`,
      list: null,
      remove,
      live: /may still be running: minio-in-memory/,
    })),
  ];
  for (const stepThrows of [false, true]) {
    for (const c of cases) {
      const kind = `${c.kind}${stepThrows ? ' (step throws)' : ''}`;
      const { dir, cleanup, config, feature, prep } = setup();
      try {
        const runner = withContainers(fakeRunner({ dir, feature }), {
          initial: [{ id: 'aaa-stack', name: 'containers-minio-1', compose: true }],
          during: { 'review-correctness': [leak] },
        });
        const session = runner.session;
        let armed = false;
        runner.session = (o) => {
          const r = session(o);
          if (o.promptName === 'review-correctness') {
            armed = true;
            if (stepThrows) throw new Error('agent crashed');
          }
          return r;
        };
        const list = runner.listContainers;
        runner.listContainers = () => (armed && c.list ? c.list() : list());
        const remove = runner.removeContainers;
        runner.removeContainers = (ids) => (c.remove ? c.remove(ids) : remove(ids));
        let state;
        if (stepThrows) {
          await assert.rejects(
            runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }),
            /agent crashed/,
            `${kind}: the step's error is not masked`,
          );
        } else {
          state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
          assert.equal(state.status, 'escalated', kind);
          assert.match(state.lastError, /container cleanup after review:correctness failed/, kind);
          assert.ok(
            state.history.some((h) => h.step === 'review:correctness' && h.promptName === 'review-correctness'),
            `${kind}: the session is still recorded`,
          );
        }
        const saved = loadRunState(config, 'F-1');
        assert.equal(saved.status, 'escalated', `${kind}: persisted status`);
        const failed = saved.history.find((h) => h.step === 'hygiene:containers' && !h.ok);
        assert.ok(failed, `${kind}: a failed hygiene entry`);
        assert.match(readFileSync(feature.indexPath, 'utf8'), c.live, `${kind}: the escalation names what may be live`);
        assert.ok(!runner.calls.some((x) => x.prompt === 'review-failure-paths'), `${kind}: no step after it`);
        assert.ok(!(c.remove ? [] : runner.removed).includes('aaa-stack'), `${kind}: compose container untouched`);
      } finally {
        cleanup();
      }
    }
  }
});

test('an initial container snapshot that throws or is malformed skips the cleanup', async () => {
  for (const initial of [
    () => {
      throw new Error('no docker');
    },
    () => 'garbage',
  ]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }));
      runner.listContainers = initial;
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean');
      assert.ok(!state.history.some((h) => h.step === 'hygiene:containers'));
    } finally {
      cleanup();
    }
  }
});

test('a malformed initial container entry never makes a pre-existing container removable', async () => {
  for (const malformed of [null, 'primitive', 7, {}, { id: 7 }, { id: null }, { id: '' }]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }));
      let snapshots = 0;
      runner.listContainers = () =>
        ++snapshots === 1
          ? [{ id: 'other', compose: false }, malformed]
          : [{ id: 'pre-existing', name: 'operator-db', compose: false }];
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', `initial entry ${JSON.stringify(malformed)}`);
      assert.deepEqual(runner.removed, [], `initial entry ${JSON.stringify(malformed)}`);
      assert.ok(!state.history.some((h) => h.step === 'hygiene:containers'));
    } finally {
      cleanup();
    }
  }
});

test('bl review reports a failed container cleanup as escalated', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      during: { 'review-correctness': [{ id: 'hhh', name: 'minio-in-memory', compose: false }] },
    });
    runner.removeContainers = () => ({ status: 1, output: 'daemon error' });
    const result = await reviewFeature({ feature, config, prep, runner, maxRounds: 2 });
    assert.equal(result.escalated, true);
    assert.match(result.error, /may still be running: minio-in-memory/);
    assert.equal(loadRunState(config, 'F-1').status, 'escalated');
  } finally {
    cleanup();
  }
});

test("a failed container cleanup after a review pass still quarantines the reviewer's changes", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const probe = 'zz-repro-scratch.txt';
    const fake = fakeRunner({
      dir,
      feature,
      behaviour: {
        review: (o) => {
          if (o.vars.dimension === 'correctness') writeFileSync(join(prep.worktreePath, probe), 'scratch\n');
        },
        shell: statusOf(prep.worktreePath, [probe]),
      },
    });
    const runner = withContainers(fake, {
      during: { 'review-correctness': [{ id: 'iii', name: 'minio-in-memory', compose: false }] },
    });
    runner.removeContainers = () => ({ status: 1, output: 'daemon error' });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(existsSync(join(prep.worktreePath, probe)), false, 'probe moved out of the worktree');
    assert.ok(
      state.history.some((h) => h.step === 'hygiene:r1-correctness' && /quarantined/.test(h.note)),
      'the quarantine is recorded',
    );
  } finally {
    cleanup();
  }
});

test('no cleanup when the runner cannot list containers (docker unavailable or BL_KEEP_TEST_CONTAINERS=1)', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      during: { 'review-correctness': [{ id: 'fff', name: 'minio-in-memory', compose: false }] },
    });
    runner.listContainers = () => null;
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(runner.removed, []);
    assert.ok(!state.history.some((h) => h.step === 'hygiene:containers'));
  } finally {
    cleanup();
  }
});

test('the default runner honours BL_KEEP_TEST_CONTAINERS=1', async () => {
  const { defaultRunner } = await import('../../src/feature-run.js');
  const saved = process.env.BL_KEEP_TEST_CONTAINERS;
  process.env.BL_KEEP_TEST_CONTAINERS = '1';
  try {
    assert.equal(defaultRunner().listContainers(), null);
  } finally {
    if (saved === undefined) delete process.env.BL_KEEP_TEST_CONTAINERS;
    else process.env.BL_KEEP_TEST_CONTAINERS = saved;
  }
  // Without the opt-out it returns a list (docker present) or null (absent), never throws.
  const res = defaultRunner().listContainers();
  assert.ok(res === null || Array.isArray(res));
  if (Array.isArray(res) && res.length > 0) {
    assert.deepEqual(Object.keys(res[0]).sort(), ['compose', 'id', 'name']);
  }
});

test('usableSnapshot applies one rule to every entry: an object with a non-blank string id', async () => {
  const { usableSnapshot, isUsableContainer } = await import('../../src/feature-run.js');
  const good = { id: 'abc123', name: 'x', compose: false };
  const cases = {
    'null list': [null, false],
    'non-array': [{ id: 'a' }, false],
    'empty list': [[], true],
    'valid entries': [[good, { id: 'def', compose: true }], true],
    'null entry': [[good, null], false],
    'string entry': [[good, 'abc'], false],
    'number entry': [[good, 7], false],
    'missing id': [[good, { name: 'n' }], false],
    'non-string id': [[good, { id: 42 }], false],
    'empty id': [[good, { id: '' }], false],
    'whitespace-only id': [[good, { id: '   ' }], false],
    'tab/newline id': [[good, { id: '\t\n' }], false],
  };
  for (const [label, [snapshot, expected]] of Object.entries(cases)) {
    assert.equal(usableSnapshot(snapshot), expected, label);
  }
  assert.equal(
    isUsableContainer({ id: ' padded ' }),
    true,
    'padding around a real id is usable; ids are trimmed before use',
  );
});

test('an unusable initial snapshot skips the cleanup: a container that may have existed is never removed', async () => {
  for (const bad of [{ id: '   ', name: 'blank', compose: false }, { id: 42, name: 'num', compose: false }, null]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        initial: [bad],
        during: { 'review-failure-paths': [{ id: 'fresh-1', name: 'minio-in-memory', compose: false }] },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', JSON.stringify(bad));
      assert.deepEqual(runner.removed, [], `nothing removed when the initial snapshot holds ${JSON.stringify(bad)}`);
    } finally {
      cleanup();
    }
  }
});

test('an unusable post-step snapshot escalates without removing anything', async () => {
  for (const bad of [{ id: '   ', name: 'blank', compose: false }, { id: 42, name: 'num', compose: false }, 'raw']) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        during: { 'review-correctness': [bad, { id: 'fresh-2', name: 'dynamodb-x', compose: false }] },
      });
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch(() => {});
      const state = loadRunState(config, 'F-1');
      assert.equal(state.status, 'escalated', JSON.stringify(bad));
      assert.match(state.lastError, /container cleanup after review:correctness failed/);
      assert.deepEqual(runner.removed, [], `no removal driven by a snapshot holding ${JSON.stringify(bad)}`);
    } finally {
      cleanup();
    }
  }
});

test('ids are trimmed the same way on both sides, so a padded id still matches its pre-existing container', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      initial: [{ id: 'old-1', name: 'old', compose: false }],
    });
    const list = runner.listContainers;
    // After any step the same container comes back with padding around its id.
    let calls = 0;
    runner.listContainers = () => (++calls % 2 === 0 ? list().map((c) => ({ ...c, id: ` ${c.id} ` })) : list());
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(runner.removed, [], 'the padded pre-existing container is not treated as fresh');
  } finally {
    cleanup();
  }
});

test('snapshot validation never throws: throwing getters, proxies, and iteration traps are just unusable', async () => {
  const { usableSnapshot, normalizeSnapshot } = await import('../../src/feature-run.js');
  const throwingId = Object.defineProperty({ name: 'x', compose: false }, 'id', {
    get() {
      throw new Error('id getter');
    },
  });
  const proxyEntry = new Proxy(
    {},
    {
      get() {
        throw new Error('proxy get');
      },
    },
  );
  const trapArray = new Proxy([{ id: 'a' }], {
    get(t, k) {
      if (k === Symbol.iterator || k === 'length') throw new Error('iteration trap');
      return Reflect.get(t, k);
    },
  });
  let reads = 0;
  const flaky = Object.defineProperty({ name: 'n', compose: false }, 'id', {
    get() {
      reads += 1;
      if (reads > 1) throw new Error('second read');
      return 'abc';
    },
  });
  for (const [label, snapshot] of Object.entries({
    'throwing id getter': [throwingId],
    'throwing proxy entry': [proxyEntry],
    'iteration trap': trapArray,
  })) {
    assert.doesNotThrow(() => usableSnapshot(snapshot), label);
    assert.equal(usableSnapshot(snapshot), false, label);
  }
  // A value that would throw on a second read is read exactly once and copied.
  const copy = normalizeSnapshot([flaky]);
  assert.deepEqual(copy, [{ id: 'abc', name: 'n', compose: false }]);
  assert.equal(reads, 1, 'each property is read once, at the boundary');
  const throwingCompose = Object.defineProperty({ id: 'abc', name: 'n' }, 'compose', {
    get() {
      throw new Error('compose getter');
    },
  });
  assert.equal(
    normalizeSnapshot([throwingCompose]),
    null,
    'a throwing name/compose read makes the snapshot unusable too',
  );
});

test('an exotic initial snapshot still lets the step run and skips cleanup; an exotic post-step snapshot escalates without removal', async () => {
  const exotic = [
    Object.defineProperty({}, 'id', {
      get() {
        throw new Error('boom');
      },
    }),
  ];
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        during: { 'review-failure-paths': [{ id: 'fresh-9', name: 'minio-in-memory', compose: false }] },
      });
      const list = runner.listContainers;
      let n = 0;
      // Usable before each step, exotic after it: the first cleanup must escalate, not throw or remove.
      runner.listContainers = () => (++n % 2 === 0 ? [...list(), ...exotic] : list());
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch(() => {});
      const state = loadRunState(config, 'F-1');
      assert.equal(state.status, 'escalated');
      assert.match(state.lastError, /container cleanup after .+ failed/);
      assert.deepEqual(runner.removed, [], 'an exotic post-step snapshot drives no removal');
    } finally {
      cleanup();
    }
  }
  {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }));
      const list = runner.listContainers;
      // Always exotic, so every "before" snapshot is unusable: each step runs and its
      // cleanup is skipped (no "after" snapshot is even taken) — never thrown, never escalated.
      runner.listContainers = () => [...list(), ...exotic];
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', 'an exotic initial snapshot skips cleanup instead of throwing');
      assert.deepEqual(runner.removed, []);
      assert.ok(
        runner.calls.some((c) => c.prompt === 'feature-self-review'),
        'the wrapped steps still ran',
      );
    } finally {
      cleanup();
    }
  }
});

test('describeThrown and readRemoval never throw, whatever the runner threw or returned', async () => {
  const { describeThrown, readRemoval } = await import('../../src/feature-run.js');
  const throwingMessage = Object.defineProperty(new Error('x'), 'message', {
    get() {
      throw new Error('message getter');
    },
  });
  const throwingToString = {
    toString() {
      throw new Error('toString');
    },
    [Symbol.toPrimitive]() {
      throw new Error('toPrimitive');
    },
  };
  for (const [label, v] of Object.entries({
    null: null,
    undefined: undefined,
    number: 42,
    string: 'boom',
    error: new Error('real'),
    throwingMessage,
    throwingToString,
  })) {
    assert.doesNotThrow(() => describeThrown(v), label);
    assert.equal(typeof describeThrown(v), 'string', label);
  }
  assert.equal(describeThrown(new Error('real')), 'real');
  const throwingStatus = Object.defineProperty({}, 'status', {
    get() {
      throw new Error('status getter');
    },
  });
  for (const [label, r] of Object.entries({
    null: null,
    undefined: undefined,
    throwingStatus,
    stringStatus: { status: '0' },
    ok: { status: 0, output: 'done' },
  })) {
    assert.doesNotThrow(() => readRemoval(r), label);
  }
  assert.deepEqual(readRemoval({ status: 0, output: 'done' }), { status: 0, output: 'done' });
  assert.equal(readRemoval({ status: '0' }).status, null, 'a non-number status is not success');
  assert.equal(readRemoval(throwingStatus).status, null);
});

test('every exotic removal failure is recorded and escalates; nothing throws out of the cleanup', async () => {
  const throwingMessage = Object.defineProperty(new Error('x'), 'message', {
    get() {
      throw new Error('message getter');
    },
  });
  const throwingStatus = Object.defineProperty({}, 'status', {
    get() {
      throw new Error('status getter');
    },
  });
  const cases = {
    'throws null': () => {
      throw null;
    },
    'throws undefined': () => {
      throw undefined;
    },
    'throws a string': () => {
      throw 'nope';
    },
    'throws an Error whose message getter throws': () => {
      throw throwingMessage;
    },
    'returns null': () => null,
    'returns a result whose status getter throws': () => throwingStatus,
    'returns a non-number status': () => ({ status: '0', output: '?' }),
  };
  for (const [label, remove] of Object.entries(cases)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = withContainers(fakeRunner({ dir, feature }), {
        during: { 'review-failure-paths': [{ id: 'fresh-x', name: 'minio-in-memory', compose: false }] },
      });
      runner.removeContainers = remove;
      let threw = null;
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch((e) => {
        threw = e;
      });
      const state = loadRunState(config, 'F-1');
      assert.equal(state.status, 'escalated', label);
      assert.match(state.lastError, /container cleanup after review:failure-paths failed/, label);
      const ev = state.history.find((h) => h.step === 'hygiene:containers');
      assert.ok(
        ev &&
          ev.ok === false &&
          /could not remove 1 container left by review:failure-paths: minio-in-memory/.test(ev.note),
        `${label}: recorded`,
      );
      if (threw)
        assert.equal(
          threw.constructor.name,
          'ContainerCleanupError',
          `${label}: only the cleanup escalation error surfaces`,
        );
    } finally {
      cleanup();
    }
  }
});

test('a log failure inside the cleanup path cannot skip its escalation', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = withContainers(fakeRunner({ dir, feature }), {
      during: { 'review-correctness': [{ id: 'fresh-y', name: 'dynamodb-x', compose: false }] },
    });
    runner.removeContainers = () => ({ status: 1, output: 'denied' });
    // Only the cleanup path's own log lines fail; the loop's step banners are outside this guarantee.
    runner.log = (msg) => {
      if (/^\s+\(.*container/.test(String(msg))) throw new Error('log broke');
    };
    let threw = null;
    await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }).catch((e) => {
      threw = e;
    });
    const state = loadRunState(config, 'F-1');
    assert.equal(state.status, 'escalated');
    assert.ok(!threw || threw.constructor.name === 'ContainerCleanupError', String(threw));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// A single story through the loop: `bl run S-n` (F-35 Design §3)
// ---------------------------------------------------------------------------

const STORY_BODY =
  '## Summary\n\nDo it.\n\n## Acceptance Criteria\n\n- [ ] one works\n- [ ] two works\n\n## To Do\n\nNone.\n';

/** A loose refined story S-5 as a unit, with the prep prepareStoryRun returns. */
function storySetup({ status = 'refined', body = STORY_BODY } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo' }],
    stories: [{ id: 'S-5', component: 'C00', title: 'Loose', dirSuffix: 'loose', points: 3, status, body }],
  });
  const config = loadConfig({ backlogRoot: dir });
  const record = readAllStories(config).find((s) => s.id === 'S-5');
  const unit = storyUnit(record, config);
  const worktreePath = mkTempDir('bl-wt-');
  const prep = {
    cfg: config,
    parsed: { id: 'S-5', num: '5', dirPrefix: 'S5' },
    worktreePath,
    branchName: 's5-loose',
    isNewWorktree: false,
    ordered: [storyAsOrdered(unit)],
    baseVars: {
      featureId: 'S-5',
      storyId: 'S-5',
      title: 'Loose',
      featureRelPath: unit.featureRelPath,
      featureAbsPath: unit.indexPath,
      branchName: 's5-loose',
      worktreePath,
      prTitle: 'S-5: Loose',
      backlogDir: dir,
      roostDir: config.roostDir,
      ...unitVars(unit),
    },
    reviewPending: false,
    targetRepoName: unit.unitRepo,
  };
  return { dir, cleanup, config, unit, prep };
}

function captureLog(fn) {
  const orig = console.log;
  let out = '';
  console.log = (...a) => {
    out += `${a.join(' ')}\n`;
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

test("story unit: the loop's field names, read from the story file", () => {
  const { cleanup, unit } = storySetup();
  try {
    assert.equal(unit.kind, 'story');
    assert.equal(unit.deferredHeading, 'To Do');
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
      deferredHeading: 'To Do',
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
    assert.equal(fm.status, 'in_progress', 'a story keeps its own status');
    for (const k of ['branch', 'pr', 'review_round', 'review_status'])
      assert.equal(fm[k], undefined, `no ${k}: in index.md`);
    const change = parseChange(readFileSync(CH(unit), 'utf8'));
    assert.equal(change.fm.change_of, 'S-5');
    assert.equal(change.fm.review_round, '2');
    assert.equal(change.fm.review_status, 'addressed');
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
    assert.equal(change.fm.review_round, '0');
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

test("a story escalation lands in the story's ## Escalation, keeps its status, blocks a rerun, and bl status S-n shows it", async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({ dir: config.backlogRoot, feature: unit, testResults: [1, 1] });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const { fm, body } = parseFrontmatter(readFileSync(unit.indexPath, 'utf8'));
    assert.equal(fm.status, 'in_progress', 'stories have no escalated status');
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
      /^S-5 · Loose\nstatus: in_progress   repo: demo-repo   branch: s5-loose   pr: -   points: 3\nreview: none \(round 0\/2\)/,
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

test("a story's review finding routed to its To Do: the review sessions get the story's heading", async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const runner = fakeRunner({
      dir: config.backlogRoot,
      feature: unit,
      behaviour: {
        // The verifier routes a pre-existing finding to the heading it is given.
        verify: (o) => {
          editFile(unit.indexPath, (fm, body) =>
            body.replace(
              `## ${o.vars.deferredHeading}\n\nNone.\n`,
              `## ${o.vars.deferredHeading}\n\n- [points: 2] (pre-existing, review round 1) old bug\n`,
            ),
          );
          editFile(CH(unit), (fm, body) => {
            fm.review_round = '1';
            fm.review_status = 'addressed';
            const block =
              '### Session 2026-10-07 (PR #7) r1\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n';
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
        },
      },
    });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const reviewCalls = runner.calls.filter((c) => c.type === 'session' && c.prompt.startsWith('review-'));
    for (const c of reviewCalls) {
      assert.equal(c.vars.unitKind, 'story', c.prompt);
      assert.equal(c.vars.deferredHeading, 'To Do', c.prompt);
    }
    const body = parseFrontmatter(readFileSync(unit.indexPath, 'utf8')).body;
    assert.match(extractSection(body, 'To Do'), /\(pre-existing, review round 1\) old bug/);
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

// ---------------------------------------------------------------------------
// An agent usage limit: wait it out and rerun the step (S-835)
// ---------------------------------------------------------------------------

const F41_LIMIT =
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:10pm (America/Los_Angeles)";

/** What `parseLimit` would return for the F-41 message, with the reset `minutes` ahead of the fake clock. */
function spendLimit(runner, { minutes = 30, reset = true } = {}) {
  return {
    kind: 'spend',
    scope: 'model',
    message: F41_LIMIT,
    resetsAt: reset ? new Date(runner.clock() + minutes * 60_000) : null,
  };
}

test('a usage limit with a reset time is waited out and the step rerun: no nudge spent, a clean run', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let hits = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.promptName === 'feature-story' && o.vars.storyId === 'S-1' && hits++ === 0 ? spendLimit(runner) : null,
      },
    });
    const start = runner.clock();
    const until = start + 30 * 60_000 + 60_000;
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(0, 4)));
    const waits = state.history.filter((h) => h.step === 'waiting');
    assert.equal(waits.length, 1);
    assert.equal(waits[0].ok, true);
    assert.equal(waits[0].session, 'implement');
    assert.equal(waits[0].kind, 'spend');
    assert.equal(waits[0].until, new Date(until).toISOString(), 'resetsAt + 60 s');
    assert.equal(waits[0].note, `implement: spend limit — ${F41_LIMIT} — waiting until ${localTime(until)}`);
    const sleeps = runner.calls.filter((c) => c.type === 'sleep').map((c) => c.ms);
    assert.equal(
      sleeps.reduce((a, b) => a + b, 0),
      until - start,
      'slept until resetsAt + 60 s and no longer',
    );
    assert.ok(
      sleeps.every((ms) => ms > 0 && ms <= 1000),
      'slices of at most one second',
    );
    assert.equal(runner.clock(), until);
    const s1 = runner.calls.filter((c) => c.prompt === 'feature-story' && c.story === 'S-1');
    assert.equal(s1.length, 2, 'the refused spawn and its rerun');
    assert.deepEqual(
      s1.map((c) => c.vars.nudge),
      ['', ''],
      'the same step with the same inputs, not the nudge retry',
    );
    // The refused spawn has no step record of its own: the waiting event is its record.
    const implemented = state.history.filter((h) => h.step === 'implement');
    assert.equal(implemented.length, 2, 'one record per story');
    assert.ok(implemented.every((h) => h.ok));
    assert.ok(
      state.history.indexOf(waits[0]) < state.history.indexOf(implemented[0]),
      "the wait precedes the rerun's record",
    );
    assert.equal(state.usage.input, 11, 'the refused spawn used nothing');
  } finally {
    cleanup();
  }
});

test('a usage limit on a review pass under bl review reruns the pass without spending the round', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  try {
    let hits = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { limit: (o) => (o.promptName === 'review-correctness' && hits++ === 0 ? spendLimit(runner) : null) },
    });
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.deepEqual(result, { status: 'pending', round: 1, escalated: false, error: null });
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt),
      ['review-correctness', 'review-correctness', 'review-failure-paths', 'review-verify'],
    );
    const saved = loadRunState(config, 'F-1');
    assert.equal(saved.status, 'reviewed');
    const waits = saved.history.filter((h) => h.step === 'waiting');
    assert.equal(waits.length, 1);
    assert.equal(waits[0].session, 'review:correctness');
    assert.ok(!saved.history.some((h) => h.step === 'review:abort'), 'the refused pass did not abort the round');
    assert.equal(parseFrontmatter(readFileSync(CH(feature), 'utf8')).fm.review_round, '1', 'one round spent');
    assert.ok(runner.calls.filter((c) => c.type === 'sleep').length > 0);
  } finally {
    cleanup();
  }
});

// The Codex message S-865's review round captured on 2026-10-14 (S-871).
const S865_LIMIT =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Oct 15th, 2026 1:40 AM.";

/** What `parseCodexLimit` would return for the S-865 message, with the reset `minutes` ahead of the fake clock. */
function codexLimit(runner, { minutes = 30, reset = true } = {}) {
  return {
    kind: 'other',
    scope: 'account',
    message: S865_LIMIT,
    resetsAt: reset ? new Date(runner.clock() + minutes * 60_000) : null,
  };
}

test('a usage limit on the verifier under bl review reruns the verifier without spending the round', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  try {
    let hits = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { limit: (o) => (o.promptName === 'review-verify' && hits++ === 0 ? codexLimit(runner) : null) },
    });
    const start = runner.clock();
    const until = start + 30 * 60_000 + 60_000;
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.deepEqual(result, { status: 'pending', round: 1, escalated: false, error: null });
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt),
      ['review-correctness', 'review-failure-paths', 'review-verify', 'review-verify'],
      'the refused verifier and its rerun, the dimension passes not repeated',
    );
    const saved = loadRunState(config, 'F-1');
    assert.equal(saved.status, 'reviewed');
    const waits = saved.history.filter((h) => h.step === 'waiting');
    assert.equal(waits.length, 1);
    assert.equal(waits[0].session, 'review:verify');
    assert.equal(waits[0].kind, 'other');
    assert.equal(waits[0].until, new Date(until).toISOString(), 'resetsAt + 60 s');
    assert.equal(waits[0].note, `review:verify: other limit — ${S865_LIMIT} — waiting until ${localTime(until)}`);
    assert.ok(!saved.history.some((h) => h.step === 'review:abort'), 'the refused verifier did not abort the round');
    assert.equal(parseFrontmatter(readFileSync(CH(feature), 'utf8')).fm.review_round, '1', 'one round spent');
    assert.ok(runner.calls.filter((c) => c.type === 'sleep').length > 0);
    assert.equal(runner.clock(), until);
  } finally {
    cleanup();
  }
});

test('a Codex usage limit with no reset time on the verifier under bl review escalates as agent unavailable', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { limit: (o) => (o.promptName === 'review-verify' ? codexLimit(runner, { reset: false }) : null) },
    });
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(result.escalated, true);
    assert.equal(result.error, `agent unavailable: ${S865_LIMIT}`);
    assert.equal(result.round, 0, 'the round was not spent');
    assert.equal(runner.calls.filter((c) => c.type === 'session').length, 3, 'nothing ran after the refusal');
    assert.equal(runner.calls.filter((c) => c.type === 'sleep').length, 0);
    const saved = loadRunState(config, 'F-1');
    assert.equal(saved.status, 'escalated');
    assert.ok(!saved.history.some((h) => h.step === 'waiting'));
    assert.ok(!saved.history.some((h) => h.step === 'review:abort'), 'a refusal is not a failed pass');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.match(esc, /^\nagent unavailable: You've hit your usage limit\./);
    assert.match(
      esc,
      /The review:verify session found every review configuration out: no configuration names a reset time\./,
    );
    assert.ok(esc.includes(`- codex: other — ${S865_LIMIT} (every codex configuration; no reset time)`), esc);
    assert.match(esc, /then run `bl review F-1`\./);
  } finally {
    cleanup();
  }
});

test('a usage limit with no reset time escalates at once as agent unavailable', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { limit: (o) => (o.promptName === 'feature-story' ? spendLimit(runner, { reset: false }) : null) },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /^agent unavailable: You've hit your monthly spend limit/);
    assert.equal(state.step, 'implement');
    assert.equal(runner.calls.filter((c) => c.type === 'session').length, 1, 'no nudge retry, nothing after');
    assert.equal(runner.calls.filter((c) => c.type === 'sleep').length, 0);
    assert.ok(!state.history.some((h) => h.step === 'waiting'));
    assert.ok(!state.history.some((h) => h.step === 'implement'), 'the refused spawn is not an implement attempt');
    const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.equal(fm.status, 'escalated');
    const esc = extractSection(body, 'Escalation');
    assert.match(esc, /^\nagent unavailable: You've hit your monthly spend limit/);
    assert.match(
      esc,
      /The implement session found every implementing configuration out: no configuration names a reset time\./,
    );
    assert.match(
      esc,
      /Configurations \(backlog\.json "agent", in priority order\):\n\n- claude: spend — You've hit your monthly spend limit.* \(this configuration; no reset time\)\n/,
    );
    assert.match(esc, /Raise the limit, then run `bl run F-1 --resume`\./);
    assert.ok(runner.calls.some((c) => c.type === 'notify' && c.label === 'F-1 escalated'));
    assert.equal(loadRunState(config, 'F-1').status, 'escalated', 'saved before the error unwound');
    assert.ok(!runner.calls.some((c) => c.type === 'forge'), 'no PR');
  } finally {
    cleanup();
  }
});

test('a reset time further away than run.limit_wait_max_hours escalates instead of sleeping', async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, { run: { limit_wait_max_hours: 1 } });
  try {
    assert.equal(config.limitWaitMaxHours, 1);
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { limit: (o) => (o.promptName === 'feature-story' ? spendLimit(runner, { minutes: 90 }) : null) },
    });
    const until = runner.clock() + 90 * 60_000 + 60_000;
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /^agent unavailable: You've hit your monthly spend limit/);
    assert.equal(runner.calls.filter((c) => c.type === 'sleep').length, 0);
    assert.ok(!state.history.some((h) => h.step === 'waiting'));
    assert.equal(runner.calls.filter((c) => c.type === 'session').length, 1);
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(esc.includes(`the earliest reset, ${localTime(until)}, is past the limit_wait_max_hours cap of 1.`), esc);
    assert.ok(esc.includes(`(this configuration; until ${localTime(until)})`), esc);
    assert.match(esc, /Raise the limit \(or wait for the reset\), then run `bl run F-1 --resume`\./);
  } finally {
    cleanup();
  }
});

test('a rerun that hits the limit again escalates: one wait per step, never a loop', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { limit: (o) => (o.promptName === 'feature-story' ? spendLimit(runner, { minutes: 5 }) : null) },
    });
    const until = runner.clock() + 5 * 60_000 + 60_000;
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /^agent unavailable: You've hit your monthly spend limit/);
    assert.equal(state.history.filter((h) => h.step === 'waiting').length, 1, 'exactly one wait');
    assert.equal(runner.calls.filter((c) => c.type === 'session').length, 2, 'the refused spawn, one rerun, then stop');
    assert.equal(runner.clock(), until, 'no second sleep');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(esc.includes(`every configuration was out again after waiting until ${localTime(until)}.`), esc);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The walk (F-64 D3, S-1137): every headless step walks its role's list,
// keeps an out-list in the run state, and waits or escalates naming every
// configuration.
// ---------------------------------------------------------------------------

const MODELS = {
  agent: [
    { agent: 'claude', model: 'opus' },
    { agent: 'claude', model: 'sonnet' },
  ],
};
const REVIEWERS = {
  review_agent: [
    { agent: 'codex', model: 'gpt-6-sol' },
    { agent: 'codex', model: 'gpt-6-astra' },
    { agent: 'claude', model: 'sonnet' },
    { agent: 'claude', model: 'opus' },
  ],
};

// The capacity refusal F-48's review round 1 died on (2026-10-26).
const CAPACITY = 'Selected model is at capacity. Please try a different model.';

/** What the Codex adapter's parser returns for the capacity refusal. */
const capacityRefusal = () => ({ kind: 'capacity', scope: 'model', message: CAPACITY, resetsAt: null });

const configsOf = (calls, pred) =>
  calls.filter((c) => c.type === 'session' && pred(c)).map((c) => `${c.agent} ${c.model}`);

test('a capacity refusal on a review pass runs the pass on the next configuration in the same round', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' }, { ...MODELS, ...REVIEWERS });
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { limit: (o) => (o.mode === 'review' && o.model === 'gpt-6-sol' ? capacityRefusal() : null) },
    });
    const logs = [];
    runner.log = (m) => logs.push(m);
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.deepEqual(result, { status: 'pending', round: 1, escalated: false, error: null });
    assert.deepEqual(
      configsOf(runner.calls, () => true),
      ['codex gpt-6-sol', 'codex gpt-6-astra', 'codex gpt-6-astra', 'codex gpt-6-astra'],
      'refused once, then the next model for every pass',
    );
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt),
      ['review-correctness', 'review-correctness', 'review-failure-paths', 'review-verify'],
    );
    assert.equal(
      runner.calls.filter((c) => c.type === 'sleep').length,
      0,
      'no wait: another configuration was available',
    );
    assert.equal(parseFrontmatter(readFileSync(CH(feature), 'utf8')).fm.review_round, '1', 'one round spent');
    const saved = loadRunState(config, 'F-1');
    assert.ok(!saved.history.some((h) => h.step === 'review:abort'), 'the refused pass did not abort the round');
    // The history records both configurations: the refusal and the pass that ran.
    const out = saved.history.filter((h) => h.step === 'unavailable');
    assert.equal(out.length, 1);
    assert.deepEqual(
      [out[0].session, out[0].agent, out[0].model, out[0].kind, out[0].scope, out[0].until],
      ['review:correctness', 'codex', 'gpt-6-sol', 'capacity', 'model', null],
    );
    const passes = saved.history.filter((h) => h.step === 'review:correctness');
    assert.deepEqual(
      passes.map((h) => [h.agent, h.model, h.ok]),
      [['codex', 'gpt-6-astra', true]],
    );
    assert.deepEqual(
      saved.history.filter((h) => h.step === 'review:verify').map((h) => h.model),
      ['gpt-6-astra'],
    );
    assert.deepEqual(saved.unavailable, [
      { agent: 'codex', model: 'gpt-6-sol', scope: 'model', kind: 'capacity', until: null, message: CAPACITY },
    ]);
    assert.ok(
      logs.some(
        (l) =>
          l.trim() ===
          `review:correctness: codex gpt-6-sol is unavailable (capacity): ${CAPACITY} — codex gpt-6-sol out for the rest of the run`,
      ),
      logs.join('\n'),
    );
    assert.ok(
      logs.some((l) =>
        l.trim().startsWith('review:failure-paths: skipping codex gpt-6-sol: out for the rest of the run (capacity:'),
      ),
      logs.join('\n'),
    );
  } finally {
    cleanup();
  }
});

test('a refusal on an implementing step moves down the list without spending the nudge retry', async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.promptName === 'feature-story' && o.vars.storyId === 'S-1' && o.model === 'opus'
            ? spendLimit(runner, { reset: false })
            : null,
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(0, 4)));
    const s1 = runner.calls.filter((c) => c.prompt === 'feature-story' && c.story === 'S-1');
    assert.deepEqual(
      s1.map((c) => [c.model, c.vars.nudge]),
      [
        ['opus', ''],
        ['sonnet', ''],
      ],
      'the same step on the next configuration, not the nudge retry',
    );
    // Opus is out for the rest of the run: every later implementing step runs on Sonnet.
    const later = runner.calls.filter((c) => c.type === 'session' && c.mode !== 'review').slice(2);
    assert.ok(later.length > 0 && later.every((c) => c.model === 'sonnet'), JSON.stringify(later.map((c) => c.model)));
    assert.deepEqual(
      state.history.filter((h) => h.step === 'implement').map((h) => h.model),
      ['sonnet', 'sonnet'],
    );
    assert.ok(!('model' in state), 'no state.model: the out-list is the record');
    assert.ok(!state.history.some((h) => h.step === 'fallback'), 'no fallback event');
  } finally {
    cleanup();
  }
});

test('a refusal on fix-tests moves down the list without spending the fix-tests rerun', async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 0],
      behaviour: {
        limit: (o) => (o.promptName === 'feature-fix-tests' && o.model === 'opus' ? capacityRefusal() : null),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.filter((h) => !h.ok)));
    assert.deepEqual(
      configsOf(runner.calls, (c) => c.prompt === 'feature-fix-tests'),
      ['claude opus', 'claude sonnet'],
    );
    assert.equal(state.history.filter((h) => h.step === 'fix-tests').length, 1, 'one fix-tests attempt');
  } finally {
    cleanup();
  }
});

test('an account-scoped refusal takes every configuration of the agent out; a model-scoped one only that one', async () => {
  // Account: a Codex usage limit on the first Codex model skips the second.
  {
    const { dir, cleanup, config, feature, prep } = setup({ pr: '7' }, { ...MODELS, ...REVIEWERS });
    try {
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          limit: (o) => (o.mode === 'review' && o.agent === 'codex' ? codexLimit(runner, { minutes: 30 }) : null),
        },
      });
      const result = await reviewFeature({
        feature,
        config,
        prep,
        runner,
        pr: { number: '7', url: 'u' },
        maxRounds: 2,
      });
      assert.equal(result.escalated, false);
      assert.deepEqual(
        configsOf(runner.calls, () => true),
        ['codex gpt-6-sol', 'claude sonnet', 'claude sonnet', 'claude sonnet'],
        'gpt-6-astra never spawned',
      );
      const saved = loadRunState(config, 'F-1');
      assert.deepEqual(
        saved.unavailable.map((o) => [o.agent, o.scope]),
        [['codex', 'account']],
      );
      assert.equal(saved.unavailable[0].until, new Date(runner.clock() + 31 * 60_000).toISOString(), 'resetsAt + 60 s');
    } finally {
      cleanup();
    }
  }
  // Model: a capacity refusal on both Codex models, each in turn.
  {
    const { dir, cleanup, config, feature, prep } = setup({ pr: '7' }, { ...MODELS, ...REVIEWERS });
    try {
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: { limit: (o) => (o.mode === 'review' && o.agent === 'codex' ? capacityRefusal() : null) },
      });
      const result = await reviewFeature({
        feature,
        config,
        prep,
        runner,
        pr: { number: '7', url: 'u' },
        maxRounds: 2,
      });
      assert.equal(result.escalated, false);
      assert.deepEqual(
        configsOf(runner.calls, () => true),
        ['codex gpt-6-sol', 'codex gpt-6-astra', 'claude sonnet', 'claude sonnet', 'claude sonnet'],
      );
      assert.deepEqual(
        loadRunState(config, 'F-1').unavailable.map((o) => [o.model, o.scope]),
        [
          ['gpt-6-sol', 'model'],
          ['gpt-6-astra', 'model'],
        ],
      );
    } finally {
      cleanup();
    }
  }
});

test('an unavailable capacity reading skips the spawn; an account-scoped one is asked once and covers every model', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' }, { ...MODELS, ...REVIEWERS });
  try {
    const runner = fakeRunner({ dir, feature });
    const asked = [];
    const resetsAt = new Date(runner.clock() + 3 * 3_600_000);
    runner.capacity = (agent, model) => {
      asked.push(`${agent} ${model}`);
      if (agent === 'codex')
        return { state: 'unavailable', scope: 'account', until: resetsAt, windows: [], message: '5h window at 0%' };
      return { state: 'unknown', scope: 'model', until: null, windows: [], message: 'claude cannot report capacity' };
    };
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(result.escalated, false);
    assert.deepEqual(
      configsOf(runner.calls, () => true),
      ['claude sonnet', 'claude sonnet', 'claude sonnet'],
      'Codex never spawned',
    );
    assert.deepEqual(
      asked,
      ['codex gpt-6-sol', 'claude sonnet', 'claude sonnet', 'claude sonnet'],
      'Codex asked once; an unknown answer still spawns',
    );
    const saved = loadRunState(config, 'F-1');
    assert.deepEqual(saved.unavailable, [
      {
        agent: 'codex',
        model: 'gpt-6-sol',
        scope: 'account',
        kind: 'quota',
        until: new Date(resetsAt.getTime() + 60_000).toISOString(),
        message: '5h window at 0%',
      },
    ]);
    // A model-scoped unavailable reading takes only that model out.
    const {
      dir: dir2,
      cleanup: cleanup2,
      config: config2,
      feature: feature2,
      prep: prep2,
    } = setup({ pr: '7' }, { ...MODELS, ...REVIEWERS });
    try {
      const r2 = fakeRunner({ dir: dir2, feature: feature2 });
      r2.capacity = (agent, model) =>
        model === 'gpt-6-sol'
          ? { state: 'unavailable', scope: 'model', until: null, message: 'busy' }
          : { state: 'available', scope: 'model', until: null, message: '' };
      await reviewFeature({
        feature: feature2,
        config: config2,
        prep: prep2,
        runner: r2,
        pr: { number: '7', url: 'u' },
        maxRounds: 2,
      });
      assert.deepEqual(
        configsOf(r2.calls, () => true),
        ['codex gpt-6-astra', 'codex gpt-6-astra', 'codex gpt-6-astra'],
      );
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

test('a capacity read that throws is unknown: the configuration is spawned', async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    const runner = fakeRunner({ dir, feature });
    runner.capacity = () => {
      throw new Error('app-server timed out');
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(runner.calls.filter((c) => c.prompt === 'feature-story').every((c) => c.model === 'opus'));
  } finally {
    cleanup();
  }
});

test('an unavailable reading whose until is not a time is unknown: the configuration is spawned, never out for the run', async () => {
  for (const until of [new Date(NaN), new Date(1e23), 'soon', Infinity]) {
    const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
    try {
      const runner = fakeRunner({ dir, feature });
      runner.capacity = () => ({ state: 'unavailable', scope: 'account', until, windows: [], message: 'bad reset' });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', String(until));
      assert.ok(
        runner.calls.filter((c) => c.prompt === 'feature-story').every((c) => c.model === 'opus'),
        String(until),
      );
      assert.deepEqual(loadRunState(config, 'F-1').unavailable ?? [], [], String(until));
    } finally {
      cleanup();
    }
  }
  // A reset at the very end of Date's range: the margin keeps it a time.
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    const runner = fakeRunner({ dir, feature });
    runner.capacity = (agent, model) =>
      model === 'opus'
        ? { state: 'unavailable', scope: 'model', until: new Date(8.64e15), windows: [], message: 'far' }
        : { state: 'available', scope: 'model', until: null, message: '' };
    await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(loadRunState(config, 'F-1').unavailable[0].until, new Date(8.64e15).toISOString());
  } finally {
    cleanup();
  }
});

test('the out-list is saved: --resume skips a configuration whose until has not passed and retries one whose until has', async () => {
  for (const [label, offsetMs, expected] of [
    ['not passed', 30 * 60_000, 'sonnet'],
    ['passed', -60_000, 'opus'],
  ]) {
    const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
    try {
      const runner = fakeRunner({ dir, feature });
      const state = newRunState(feature, { branch: prep.branchName, worktreePath: prep.worktreePath, maxRounds: 2 });
      state.unavailable = [
        {
          agent: 'claude',
          model: 'opus',
          scope: 'model',
          kind: 'spend',
          until: new Date(runner.clock() + offsetMs).toISOString(),
          message: F41_LIMIT,
        },
      ];
      saveRunState(config, state);
      const logs = [];
      runner.log = (m) => logs.push(m);
      const after = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2, resume: true } });
      assert.equal(after.status, 'clean', label);
      assert.equal(runner.calls.find((c) => c.prompt === 'feature-story').model, expected, label);
      if (expected === 'opus') {
        assert.deepEqual(after.unavailable, [], 'the passed entry is dropped');
        assert.ok(
          logs.some((l) => l.includes('claude opus is tried again')),
          logs.join('\n'),
        );
      } else {
        assert.equal(after.unavailable.length, 1, 'still out');
      }
    } finally {
      cleanup();
    }
  }
});

test('--resume tries again a configuration out with no reset time: the escalation told the operator to fix it, then resume', async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    const runner = fakeRunner({ dir, feature });
    const state = newRunState(feature, { branch: prep.branchName, worktreePath: prep.worktreePath, maxRounds: 2 });
    state.status = 'escalated';
    state.unavailable = [
      { agent: 'claude', model: 'opus', scope: 'model', kind: 'spend', until: null, message: F41_LIMIT },
      {
        agent: 'claude',
        model: 'sonnet',
        scope: 'model',
        kind: 'spend',
        until: new Date(runner.clock() + 30 * 60_000).toISOString(),
        message: F41_LIMIT,
      },
    ];
    saveRunState(config, state);
    const logs = [];
    runner.log = (m) => logs.push(m);
    const after = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2, resume: true } });
    assert.equal(after.status, 'clean');
    assert.equal(runner.calls.find((c) => c.prompt === 'feature-story').model, 'opus', 'the untimed entry is cleared');
    assert.deepEqual(
      after.unavailable.map((o) => o.model),
      ['sonnet'],
      'a timed entry still holds',
    );
    assert.ok(
      logs.some((l) => l.includes('claude opus is tried again: out with no reset time')),
      logs.join('\n'),
    );
  } finally {
    cleanup();
  }
});

test('a configuration whose until passes during the run is tried again at the next step', async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.promptName === 'feature-story' && o.vars.storyId === 'S-1' && o.model === 'opus'
            ? spendLimit(runner, { minutes: 10 })
            : null,
        // S-1's session on Sonnet takes longer than Opus's reset.
        story: (o) => {
          if (o.vars.storyId === 'S-1') runner.sleep(20 * 60_000);
          checkAll(o.vars.storyAbsPath);
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(
      configsOf(runner.calls, (c) => c.prompt === 'feature-story'),
      ['claude opus', 'claude sonnet', 'claude opus'],
      'S-2 is back on the first choice',
    );
    assert.ok(!state.history.some((h) => h.step === 'waiting'), 'nobody waited: Sonnet was available');
  } finally {
    cleanup();
  }
});

test('every configuration out with a reset inside the cap: one waiting event, then a fresh walk from the top', async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    let hits = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.promptName === 'feature-story' && hits++ < 2
            ? spendLimit(runner, { minutes: o.model === 'opus' ? 40 : 20 })
            : null,
      },
    });
    const start = runner.clock();
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const waits = state.history.filter((h) => h.step === 'waiting');
    assert.equal(waits.length, 1);
    assert.equal(waits[0].until, new Date(start + 21 * 60_000).toISOString(), "the earliest reset: Sonnet's");
    assert.equal(waits[0].model, 'sonnet');
    // Opus is still out after the wait, so the fresh walk skips it and runs Sonnet.
    assert.deepEqual(configsOf(runner.calls, (c) => c.prompt === 'feature-story').slice(0, 3), [
      'claude opus',
      'claude sonnet',
      'claude sonnet',
    ]);
  } finally {
    cleanup();
  }
});

test('every configuration out with no reachable reset escalates listing each configuration, reason, scope and reset', async () => {
  const { dir, cleanup, config, feature, prep } = setup(
    { pr: '7' },
    {
      ...MODELS,
      review_agent: [
        { agent: 'codex', model: 'gpt-6-sol' },
        { agent: 'claude', model: 'sonnet' },
      ],
      run: { limit_wait_max_hours: 1 },
    },
  );
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.mode !== 'review' ? null : o.agent === 'codex' ? capacityRefusal() : spendLimit(runner, { minutes: 120 }),
      },
    });
    const until = runner.clock() + 121 * 60_000;
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(result.escalated, true);
    assert.equal(result.error, 'agent unavailable: every review configuration is out (codex gpt-6-sol, claude sonnet)');
    assert.equal(runner.calls.filter((c) => c.type === 'sleep').length, 0);
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(
      esc.includes(
        `The review:correctness session found every review configuration out: the earliest reset, ${localTime(until)}, is past the limit_wait_max_hours cap of 1.`,
      ),
      esc,
    );
    assert.ok(esc.includes(`- codex gpt-6-sol: capacity — ${CAPACITY} (this configuration; no reset time)`), esc);
    assert.ok(
      esc.includes(`- claude sonnet: spend — ${F41_LIMIT} (this configuration; until ${localTime(until)})`),
      esc,
    );
    assert.match(esc, /Raise the limit \(or wait for the reset\), then run `bl review F-1`\./);
  } finally {
    cleanup();
  }
});

test('loadRunState ignores a retired model and rejects a malformed out-list', () => {
  const root = mkTempDir('bl-run-model-');
  try {
    const config = { backlogRoot: root };
    mkdirSync(join(root, RUN_DIR), { recursive: true });
    const write = (extra) =>
      writeFileSync(runStatePath(config, 'F-1'), JSON.stringify({ feature: 'F-1', history: [], ...extra }));
    write({ model: 'sonnet' });
    assert.equal(loadRunState(config, 'F-1').model, undefined, "S-880's state.model loads and is ignored");
    write({ model: null });
    assert.equal(loadRunState(config, 'F-1').model, undefined);
    const ok = {
      agent: 'codex',
      model: null,
      scope: 'account',
      kind: 'other',
      until: '2026-10-14T00:30:00.000Z',
      message: 'm',
    };
    write({ unavailable: [ok, { ...ok, model: 'gpt-6-sol', scope: 'model', until: null }] });
    assert.equal(loadRunState(config, 'F-1').unavailable.length, 2);
    for (const bad of [
      {},
      null,
      [null],
      [{ ...ok, agent: '' }],
      [{ ...ok, model: '' }],
      [{ ...ok, scope: 'global' }],
      [{ ...ok, until: 'soon' }],
      [{ ...ok, until: 5 }],
      [{ ...ok, message: 1 }],
      [{ ...ok, kind: undefined }],
    ]) {
      write({ unavailable: bad });
      assert.throws(() => loadRunState(config, 'F-1'), /^Error: run state .* unavailable/, JSON.stringify(bad));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a configuration whose agent has no headless mode is skipped with a log line', async () => {
  const { dir, cleanup, config, feature, prep } = setup(
    {},
    { agent: [{ agent: 'gemini' }, { agent: 'claude', model: 'opus' }] },
  );
  try {
    const runner = fakeRunner({ dir, feature });
    const logs = [];
    runner.log = (m) => logs.push(m);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(runner.calls.filter((c) => c.type === 'session').every((c) => c.agent !== 'gemini'));
    assert.ok(
      logs.some((l) => l.trim() === 'implement: skipping gemini: its agent has no headless mode'),
      logs.join('\n'),
    );
  } finally {
    cleanup();
  }
});

test("an interactive run uses its role's first configuration and does not walk", async () => {
  const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
  try {
    const runner = fakeRunner({ dir, feature });
    runner.interactive = true;
    runner.capacity = () => {
      throw new Error('an interactive run reads no capacity');
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(runner.calls.filter((c) => c.type === 'session' && c.mode !== 'review').every((c) => c.model === 'opus'));
  } finally {
    cleanup();
  }
});

test('hasHeadlessConfiguration: a role needs one entry with a headless mode', () => {
  assert.equal(hasHeadlessConfiguration([{ agent: 'gemini' }]), false);
  assert.equal(hasHeadlessConfiguration([{ agent: 'gemini' }, { agent: 'codex' }]), true);
  assert.equal(hasHeadlessConfiguration([]), false);
});

// Every path a limit hit can take; `limit(o, runner, n)` runs on the n-th
// implement spawn of S-1.
const LIMIT_USAGE_CASES = [
  {
    name: 'a first hit, waited out and rerun',
    status: 'clean',
    limit: (o, runner, n) => (n === 0 ? spendLimit(runner) : null),
  },
  { name: 'no reset time, escalated', status: 'escalated', limit: (o, runner) => spendLimit(runner, { reset: false }) },
  {
    name: 'a reset past the cap, escalated',
    status: 'escalated',
    config: { run: { limit_wait_max_hours: 1 } },
    limit: (o, runner) => spendLimit(runner, { minutes: 90 }),
  },
  {
    name: 'a second hit after waiting, escalated',
    status: 'escalated',
    limit: (o, runner) => spendLimit(runner, { minutes: 5 }),
  },
];

test('limit-hit session usage stays consistent across unit and run state', async () => {
  for (const c of LIMIT_USAGE_CASES) {
    const { dir, cleanup, config, feature, prep } = setup({}, c.config ?? null);
    try {
      let hits = 0;
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          limit: (o) =>
            o.promptName === 'feature-story' && o.vars.storyId === 'S-1' ? c.limit(o, runner, hits++) : null,
        },
      });
      const session = runner.session;
      // Like runHeadlessSession(): every spawn reports usage, and the provider
      // has added it to the unit file before the loop sees the result, refusal or not.
      runner.session = (o) => {
        const usage = { input: 1, output: 1, cache_creation: 0, cache_read: 0 };
        accumulateTokensOnFile(o.config.backlogRoot, o.usageIndexPath, usage);
        return { ...session(o), usage };
      };
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, c.status, c.name);
      const spawns = runner.calls.filter((x) => x.type === 'session').length;
      const { fm } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
      assert.equal(fm.tokens_input, String(spawns), `${c.name}: the unit file counts every spawn`);
      assert.equal(state.usage.input, spawns, `${c.name}: so does the run state`);
      assert.equal(
        loadRunState(config, 'F-1').usage.input,
        spawns,
        `${c.name}: and the saved state a --resume would load`,
      );
    } finally {
      cleanup();
    }
  }
});

test("bl review: an unavailable agent on a review pass escalates, names bl review as the resume, and quarantines the reviewer's changes", async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' });
  try {
    const probe = 'zz-limit-scratch.txt';
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) => {
          if (o.promptName !== 'review-correctness') return null;
          // The limit hit mid-session, after the reviewer had written a file.
          writeFileSync(join(prep.worktreePath, probe), 'scratch\n');
          return spendLimit(runner, { reset: false });
        },
        shell: statusOf(prep.worktreePath, [probe]),
      },
    });
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(result.escalated, true);
    assert.match(result.error, /^agent unavailable: You've hit your monthly spend limit/);
    assert.equal(result.round, 0, 'the round was not spent');
    assert.equal(runner.calls.filter((c) => c.type === 'session').length, 1, 'nothing ran after the refusal');
    const saved = loadRunState(config, 'F-1');
    assert.equal(saved.status, 'escalated');
    assert.ok(
      saved.history.some((h) => h.step === 'hygiene:r1-correctness' && /quarantined/.test(h.note)),
      'the quarantine is recorded',
    );
    assert.equal(existsSync(join(prep.worktreePath, probe)), false, 'probe moved out of the worktree');
    assert.ok(!existsSync(runLockPath(config, 'F-1')), 'lock released');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.match(
      esc,
      /The review:correctness session found every review configuration out: no configuration names a reset time\./,
    );
    assert.match(esc, /then run `bl review F-1`\./);
  } finally {
    cleanup();
  }
});

test('a session that succeeded and merely quoted a usage limit in its output is not a refusal', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const session = runner.session;
    // Every session ends well, its last line quoting the F-41 message (a
    // review of the limit handling, say): `refusal` is set, `isError` is not.
    runner.session = (o) => ({ ...session(o), output: `looked at ${F41_LIMIT}`, refusal: spendLimit(runner) });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(0, 4)));
    assert.equal(runner.calls.filter((c) => c.type === 'sleep').length, 0, 'no wait');
    assert.ok(!state.history.some((h) => h.step === 'waiting'));
    assert.equal(
      runner.calls.filter((c) => c.prompt === 'feature-story' && c.story === 'S-1').length,
      1,
      'the session ran once',
    );
    assert.equal(state.history.filter((h) => h.step === 'implement').length, 2, "both stories' sessions were recorded");
  } finally {
    cleanup();
  }
});

test('a runner without limit support (codex, --interactive) never waits', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const session = runner.session;
    runner.session = (o) => ({ ...session(o), refusal: null });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.equal(runner.calls.filter((c) => c.type === 'sleep').length, 0);
    assert.ok(!state.history.some((h) => h.step === 'waiting'));
  } finally {
    cleanup();
  }
});

test('bl status S-n shows a run sleeping through a usage limit as waiting until <local time>', async () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    let hits = 0;
    let during = null;
    const status = () =>
      captureLog(() =>
        cmdStatusStory(
          {},
          config,
          readAllStories(config).find((s) => s.id === 'S-5'),
        ),
      );
    const runner = fakeRunner({
      dir: config.backlogRoot,
      feature: unit,
      behaviour: {
        limit: (o) => (o.promptName === 'story-run' && hits++ === 0 ? spendLimit(runner) : null),
        onSleep: () => {
          during ??= status();
        },
      },
    });
    const state = await runFeature({ feature: unit, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const { until } = state.history.find((h) => h.step === 'waiting');
    assert.match(
      during,
      /\nrun: running at step implement \(updated [^,]+, \d+ events, last: implement: spend limit — You've hit your monthly spend limit[^\n]*\)\n  waiting until /,
    );
    assert.ok(during.includes(`\n  waiting until ${localTime(until)} — ${F41_LIMIT}\n`), during);
    // Once the rerun has started, the line is gone.
    assert.doesNotMatch(status(), /waiting until/);
  } finally {
    cleanup();
  }
});

test("bl status shows a running unit's out-list, an account-wide entry as every model, and drops a passed one", () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const state = newRunState(unit, { branch: prep.branchName, worktreePath: prep.worktreePath, maxRounds: 2 });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    state.unavailable = [
      { agent: 'codex', model: 'gpt-6-sol', scope: 'model', kind: 'capacity', until: null, message: CAPACITY },
      { agent: 'codex', model: 'gpt-6-astra', scope: 'account', kind: 'other', until: later, message: S865_LIMIT },
      {
        agent: 'claude',
        model: 'opus',
        scope: 'model',
        kind: 'spend',
        until: new Date(Date.now() - 60_000).toISOString(),
        message: F41_LIMIT,
      },
    ];
    saveRunState(config, state);
    const out = captureLog(() =>
      cmdStatusStory(
        {},
        config,
        readAllStories(config).find((s) => s.id === 'S-5'),
      ),
    );
    assert.ok(out.includes(`\n  out: codex gpt-6-sol for the rest of the run — capacity: ${CAPACITY}\n`), out);
    assert.ok(out.includes(`\n  out: codex (every model) until ${localTime(later)} — other: ${S865_LIMIT}\n`), out);
    assert.ok(!out.includes('out: claude opus'), 'its until has passed: the next step tries it again');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The reviewer is never the implementer (F-64 D4, S-1138)
// ---------------------------------------------------------------------------

const SKIP_IMPLEMENTER =
  /skipping claude opus: it ran implement(, [a-z-]+)* in this run, and the reviewer is never the implementer/;

test('a review configuration that implemented the run is skipped with a log line, and the pass runs on the next one', async () => {
  const { dir, cleanup, config, feature, prep } = setup(
    {},
    {
      ...MODELS,
      review_agent: [
        { agent: 'claude', model: 'opus' },
        { agent: 'codex', model: 'gpt-6-sol' },
      ],
    },
  );
  try {
    const runner = fakeRunner({ dir, feature });
    const logs = [];
    runner.log = (m) => logs.push(m);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.filter((h) => !h.ok)));
    assert.deepEqual(
      state.history.filter((h) => h.step === 'implement').map((h) => h.model),
      ['opus', 'opus'],
    );
    const reviewers = configsOf(runner.calls, (c) => c.mode === 'review');
    assert.ok(reviewers.length > 0 && reviewers.every((r) => r === 'codex gpt-6-sol'), JSON.stringify(reviewers));
    assert.ok(
      logs.some((l) => l.trim().startsWith('review:correctness: ') && SKIP_IMPLEMENTER.test(l)),
      logs.join('\n'),
    );
  } finally {
    cleanup();
  }
});

test('every configuration that implemented is excluded: Opus, then Sonnet once Opus is out', async () => {
  const review_agent = [
    { agent: 'claude', model: 'opus' },
    { agent: 'claude', model: 'sonnet' },
    { agent: 'codex', model: 'gpt-6-sol' },
  ];
  const { dir, cleanup, config, feature, prep } = setup({}, { ...MODELS, review_agent });
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.promptName === 'feature-story' && o.vars.storyId === 'S-2' && o.model === 'opus'
            ? spendLimit(runner, { reset: false })
            : null,
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.filter((h) => !h.ok)));
    assert.deepEqual(
      state.history.filter((h) => h.step === 'implement').map((h) => h.model),
      ['opus', 'sonnet'],
      'S-1 on Opus, S-2 on Sonnet',
    );
    const reviewers = configsOf(runner.calls, (c) => c.mode === 'review');
    assert.ok(
      reviewers.length > 0 && reviewers.every((r) => r === 'codex gpt-6-sol'),
      `neither Opus nor Sonnet reviews: ${JSON.stringify(reviewers)}`,
    );
  } finally {
    cleanup();
  }
});

test('a review list left empty by exclusion escalates as agent unavailable, naming each excluded entry and why', async () => {
  const { dir, cleanup, config, feature, prep } = setup(
    {},
    { agent: [{ agent: 'claude', model: 'opus' }], review_agent: [{ agent: 'claude', model: 'opus' }] },
  );
  try {
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(runner.calls.filter((c) => c.type === 'session' && c.mode === 'review').length, 0, 'nothing reviewed');
    assert.equal(runner.calls.filter((c) => c.type === 'sleep').length, 0, 'no wait: an implementer never comes back');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.match(esc, /^\nagent unavailable: every review configuration is out \(claude opus\)/);
    assert.match(
      esc,
      /found every review configuration out: every review configuration that can run ran an implementing step of this run, and the reviewer is never the implementer\./,
    );
    assert.match(
      esc,
      /- claude opus: excluded — it ran implement(, [a-z-]+)* in this run, and the reviewer is never the implementer/,
    );
    assert.match(esc, /Add a "review_agent" configuration that did not implement this run/);
  } finally {
    cleanup();
  }
});

test('each review round records its reviewers in the history, and the verifier gets them for the Review Log header', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' }, { ...MODELS, ...REVIEWERS });
  try {
    // gpt-6-sol is at capacity after the correctness pass: the other pass and the verifier run on gpt-6-astra.
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.mode === 'review' && o.model === 'gpt-6-sol' && o.promptName !== 'review-correctness'
            ? capacityRefusal()
            : null,
      },
    });
    const result = await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    assert.equal(result.escalated, false);
    const verify = runner.calls.filter((c) => c.type === 'session' && c.prompt === 'review-verify');
    assert.deepEqual(
      verify.map((c) => c.vars.reviewers),
      ['codex gpt-6-sol, codex gpt-6-astra'],
    );
    const saved = loadRunState(config, 'F-1');
    const rounds = saved.history.filter((h) => h.step === 'review:round');
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].round, 1);
    assert.deepEqual(rounds[0].reviewers, [
      { session: 'review:correctness', agent: 'codex', model: 'gpt-6-sol' },
      { session: 'review:failure-paths', agent: 'codex', model: 'gpt-6-astra' },
      { session: 'review:verify', agent: 'codex', model: 'gpt-6-astra' },
    ]);
    assert.equal(rounds[0].note, 'round 1 reviewed by codex gpt-6-sol, codex gpt-6-astra');
  } finally {
    cleanup();
  }
});

test('a round reviewed by one configuration names it once', async () => {
  const { dir, cleanup, config, feature, prep } = setup({ pr: '7' }, { ...MODELS, ...REVIEWERS });
  try {
    const runner = fakeRunner({ dir, feature });
    await reviewFeature({ feature, config, prep, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    const verify = runner.calls.filter((c) => c.type === 'session' && c.prompt === 'review-verify');
    assert.deepEqual(
      verify.map((c) => c.vars.reviewers),
      ['codex gpt-6-sol'],
    );
  } finally {
    cleanup();
  }
});

test('bl status names the configurations that reviewed the latest round', () => {
  const { cleanup, config, unit, prep } = storySetup();
  try {
    const state = newRunState(unit, { branch: prep.branchName, worktreePath: prep.worktreePath, maxRounds: 2 });
    state.history.push(
      { step: 'review:round', round: 1, ok: true, reviewers: [], note: 'round 1 reviewed by claude sonnet' },
      {
        step: 'review:round',
        round: 2,
        ok: true,
        reviewers: [],
        note: 'round 2 reviewed by codex gpt-6-sol, claude sonnet',
      },
      { step: 'fix', ok: true, note: '' },
    );
    saveRunState(config, state);
    const out = captureLog(() =>
      cmdStatusStory(
        {},
        config,
        readAllStories(config).find((s) => s.id === 'S-5'),
      ),
    );
    assert.ok(out.includes('\n  round 2 reviewed by codex gpt-6-sol, claude sonnet\n'), out);
    assert.ok(!out.includes('round 1 reviewed by'), 'only the latest round');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The per-repo test gate (S-1010): every prepared repo's plugins, resolved
// with that repo's config, run in that repo's worktree.
// ---------------------------------------------------------------------------

/**
 * A feature prepared in three repos: demo-repo (the run's, `unit` → npm test),
 * repo-b (`docs` → a command naming its worktree) and repo-c (no test plugin).
 * `docs` overrides repo-b's plugin command. The runner resolves plugins for
 * real, so each repo's own `plugins-test` is what decides.
 */
function setupMulti({ docs = 'make -C {{worktreePath}} check' } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: {
      'demo-repo': { path: '../demo-repo', 'plugins-test': ['unit'] },
      'repo-b': { path: '../repo-b', 'plugins-test': ['docs'] },
      'repo-c': { path: '../repo-c' },
    },
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1'], branch: 'f1-feat' }],
    config: { plugins: { unit: { test: 'npm test' }, docs: { test: docs } } },
  });
  const config = loadConfig({ backlogRoot: dir });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const ordered = orderStoriesByDeps(resolveFeatureStories(feature, config, readAllStories(config)).stories);
  const worktreePath = mkTempDir('bl-wt-');
  const wtB = mkTempDir('bl-wt-b-');
  const wtC = mkTempDir('bl-wt-c-');
  const prep = {
    cfg: configForRepo(config, 'demo-repo'),
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
    },
    reviewPending: false,
    targetRepoName: 'demo-repo',
    otherWorktrees: [
      { repoName: 'repo-b', worktreePath: wtB },
      { repoName: 'repo-c', worktreePath: wtC },
    ],
  };
  const realPlugins = (runner) => {
    runner.testPlugins = (cfg, p, componentEntry) => resolveFeaturePluginsReport('test', cfg, p, { componentEntry });
    return runner;
  };
  return { dir, cleanup, config, feature, prep, wtB, wtC, realPlugins };
}

test("the gate runs every prepared repo's own test plugins in its own worktree; a repo without one is skipped by name", async () => {
  const { dir, cleanup, config, feature, prep, wtB, realPlugins } = setupMulti();
  try {
    const runner = realPlugins(fakeRunner({ dir, feature }));
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    const ran = runner.calls.filter((c) => c.type === 'shell' && (c.cmd === 'npm test' || c.cmd.startsWith('make ')));
    assert.ok(ran.length >= 2);
    for (const c of ran) {
      if (c.cmd === 'npm test') assert.equal(c.cwd, prep.worktreePath, "demo-repo's plugin runs in its worktree");
      else
        assert.deepEqual(
          [c.cmd, c.cwd],
          [`make -C ${wtB} check`, wtB],
          "repo-b's plugin, filled with and run in repo-b's worktree",
        );
    }
    assert.equal(
      readFileSync(join(dir, RUN_DIR, 'F-1.test-1.log'), 'utf8'),
      `── demo-repo · unit: npm test\nok\n── repo-b · docs: make -C ${wtB} check\n── repo-c: skipped (no test plugin)\n`,
    );
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n');
    const first = lines.filter((l) => / \(attempt 1\)$/.test(l));
    assert.deepEqual(
      first.map((l) => l.replace(/^- \d{4}-\d{2}-\d{2} · /, '').replace(/ \(attempt 1\)$/, '')),
      [
        'demo-repo · `npm test` · pass',
        `repo-b · \`make -C ${wtB} check\` · pass`,
        'repo-c · (no test plugin) · skipped',
      ],
    );
  } finally {
    cleanup();
  }
});

test('the gate is skipped overall only when no prepared repo has a test plugin', async () => {
  const { dir, cleanup, config, feature, prep } = setupMulti();
  try {
    const runner = fakeRunner({ dir, feature });
    runner.testPlugins = () => ({ plugins: [], unknown: [] });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(state.history.some((h) => h.step === 'test' && h.ok && /^skipped/.test(h.note)));
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n');
    for (const repo of ['demo-repo', 'repo-b', 'repo-c']) {
      assert.ok(
        lines.some((l) => l.includes(` · ${repo} · (no test plugin) · skipped`)),
        `${repo}: ${lines.join('\n')}`,
      );
    }
  } finally {
    cleanup();
  }
});

test("a failing secondary's gate result names its repo and worktree, and fix-tests is told to fix there", async () => {
  const { dir, cleanup, config, feature, prep, wtB, realPlugins } = setupMulti();
  try {
    const runner = realPlugins(
      fakeRunner({
        dir,
        feature,
        behaviour: { shell: (cmd) => (cmd.startsWith('make ') ? { status: 2, output: 'docs: broken link\n' } : null) },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /test gate failed twice/);
    const fix = runner.calls.find((c) => c.prompt === 'feature-fix-tests');
    assert.equal(fix.vars.testRepo, 'repo-b');
    assert.equal(fix.vars.testWorktree, wtB);
    assert.equal(fix.vars.testCommand, `make -C ${wtB} check`);
    assert.match(fix.vars.testTail, /docs: broken link/);
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(esc.includes(`Repo: repo-b (${wtB})`), esc);
    // demo-repo passed, repo-b failed, repo-c was never reached.
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n')
      .filter((l) => / \(attempt 1\)$/.test(l));
    assert.deepEqual(
      lines.map((l) => l.split(' · ').slice(1, 2).concat(l.split(' · ').at(-1)).join(' ')),
      ['demo-repo pass (attempt 1)', 'repo-b fail (attempt 1)'],
    );
    assert.ok(state.history.some((h) => h.step === 'test' && !h.ok && /^repo-b · docs exited 2/.test(h.note)));
  } finally {
    cleanup();
  }
});

test('a dirty secondary worktree fails the gate before any command runs, naming its repo and path', async () => {
  const { dir, cleanup, config, feature, prep, wtB, realPlugins } = setupMulti();
  try {
    const stray = 'notes.txt';
    writeFileSync(join(wtB, stray), 'scratch\n');
    let fixVars = null;
    let ranBeforeFix = 0;
    const runner = realPlugins(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          fixTests: (o) => {
            fixVars = o.vars;
            ranBeforeFix = runner.calls.filter((c) => c.cmd === 'npm test' || c.cmd?.startsWith('make ')).length;
            rmSync(join(wtB, stray));
          },
        },
      }),
    );
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) => (cwd === wtB ? statusOf(wtB, [stray])(cmd) : null) ?? shell(cmd, cwd, o);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.equal(ranBeforeFix, 0, 'no plugin ran on a dirty tree');
    assert.equal(fixVars.testRepo, 'repo-b');
    assert.equal(fixVars.testWorktree, wtB);
    assert.ok(fixVars.testExcerpt.includes(`repo-b (${wtB}):\n?? notes.txt`), fixVars.testExcerpt);
    assert.ok(
      state.history.some(
        (h) => h.step === 'test' && !h.ok && h.note === 'worktree not clean: 1 path (repo-b: notes.txt)',
      ),
    );
  } finally {
    cleanup();
  }
});

test("a misconfigured secondary stops the gate as misconfigured before any repo's command runs", async () => {
  const { dir, cleanup, config, feature, prep, realPlugins } = setupMulti({ docs: 'make {{bogus}}' });
  try {
    const runner = realPlugins(fakeRunner({ dir, feature }));
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'test gate misconfigured');
    assert.ok(
      !runner.calls.some((c) => c.type === 'shell' && (c.cmd === 'npm test' || c.cmd.startsWith('make'))),
      "demo-repo's valid plugin never ran",
    );
    assert.ok(!runner.calls.some((c) => c.prompt === 'feature-fix-tests'));
    assert.ok(
      extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation').includes(
        'repo-b: unresolved placeholder {{bogus}} in test plugin docs',
      ),
    );
    const lines = extractSection(parseChange(readFileSync(CH(feature), 'utf8')).body, 'Gate')
      .trim()
      .split('\n');
    assert.match(lines.at(-1), / · repo-b · \(misconfigured\) · fail$/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The repo guard (F-52 D4, F-61 D1)
// ---------------------------------------------------------------------------

const GUARD_COMPONENTS = [
  { id: 'C10', repo: 'bl', paths: ['src/**', 'test/**'] },
  { id: 'C11', repo: 'bl', paths: ['docs/**'] },
  { id: 'C20', repo: 'app', paths: ['**'] },
  { id: 'C21', repo: 'app', paths: null },
];

test("repoGuardWarnings: a path outside the stories' components, or in no component, gets no warning", () => {
  const w = repoGuardWarnings(
    [{ repo: 'bl', files: ['src/a.js', 'docs/x.md', 'Makefile'] }],
    new Set(['C10']),
    GUARD_COMPONENTS,
  );
  assert.deepEqual(w, []);
  // A component with no paths: is still the repo's: its repo has a story.
  assert.deepEqual(repoGuardWarnings([{ repo: 'app', files: ['api/b.js'] }], new Set(['C21']), GUARD_COMPONENTS), []);
});

test('repoGuardWarnings: exactly one warning per repo with changes and no story of the unit', () => {
  const w = repoGuardWarnings(
    [
      { repo: 'bl', files: ['docs/x.md'] },
      { repo: 'app', files: ['web/a.js', 'api/b.js'] },
      { repo: 'containers', files: ['compose.yml', 'x.sh'] },
      { repo: 'solo', files: ['one.txt'] },
      { repo: 'quiet', files: [] },
    ],
    new Set(['C10']),
    GUARD_COMPONENTS,
  );
  assert.deepEqual(w, [
    'app: 2 changed paths, but no story of the unit is in this repo',
    'containers: 2 changed paths, but no story of the unit is in this repo',
    'solo: 1 changed path, but no story of the unit is in this repo',
  ]);
  // A component of another repo never stands for this repo.
  assert.deepEqual(repoGuardWarnings([{ repo: 'bl', files: ['web/a.js'] }], new Set(['C21']), GUARD_COMPONENTS), [
    'bl: 1 changed path, but no story of the unit is in this repo',
  ]);
});

function setupGuard() {
  const { dir, cleanup } = mkTempBacklog({
    repos: { 'demo-repo': { path: '../demo-repo' }, 'repo-b': { path: '../repo-b' }, 'repo-c': { path: '../repo-c' } },
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true, paths: ['src/**'] },
      { id: 'C01', title: 'Docs', dirSuffix: 'docs', repo: 'demo-repo', paths: ['docs/**'] },
      { id: 'C02', title: 'B', dirSuffix: 'b', repo: 'repo-b', home: true, paths: ['**'] },
      { id: 'C03', title: 'C', dirSuffix: 'c', repo: 'repo-c', home: true, paths: ['**'] },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
      {
        id: 'S-2',
        component: 'C02',
        title: 'Second',
        dirSuffix: 'second',
        points: 3,
        feature: 'F-1',
        depends_on: ['S-1'],
        body: AC_BODY,
      },
    ],
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1', 'S-2'], branch: 'f1-feat' },
    ],
  });
  const config = loadConfig({ backlogRoot: dir });
  // repo-c's main checkout, holding a worktree on the branch no story names.
  mkdirSync(config.reposByName['repo-c'], { recursive: true });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const ordered = orderStoriesByDeps(resolveFeatureStories(feature, config, readAllStories(config)).stories);
  const worktreePath = mkTempDir('bl-wt-');
  const wtB = mkTempDir('bl-wt-b-');
  const wtC = mkTempDir('bl-wt-c-');
  const prep = {
    cfg: configForRepo(config, 'demo-repo'),
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
    },
    reviewPending: false,
    targetRepoName: 'demo-repo',
    otherWorktrees: [{ repoName: 'repo-b', worktreePath: wtB }],
  };
  const diffs = {
    [worktreePath]: 'src/a.js\0docs/guide.md\0Makefile\0',
    [wtB]: 'anything/at/all.js\0',
    [wtC]: 'stray.txt\0',
  };
  const guardShell = (runner) => {
    const shell = runner.shell;
    runner.shell = (cmd, cwd, o) => {
      if (cmd.startsWith('git diff --name-only -z main...HEAD') && cwd in diffs) {
        runner.calls.push({ type: 'shell', cmd, cwd });
        return { status: 0, output: diffs[cwd] };
      }
      if (cmd === 'git worktree list --porcelain -z' && cwd === config.reposByName['repo-c']) {
        runner.calls.push({ type: 'shell', cmd, cwd });
        return {
          status: 0,
          output: `worktree ${cwd}\0HEAD abc\0branch refs/heads/main\0\0worktree ${wtC}\0HEAD def\0branch refs/heads/f1-feat\0\0`,
        };
      }
      return shell(cmd, cwd, o);
    };
    return runner;
  };
  return { dir, cleanup, config, feature, prep, wtB, wtC, guardShell };
}

test("bl run warns, before the gate, only for a repo with no story; a path outside the feature's components gets none; the run continues", async () => {
  const { dir, cleanup, config, feature, prep, guardShell } = setupGuard();
  try {
    const logged = [];
    const runner = guardShell(fakeRunner({ dir, feature }));
    runner.log = (line) => logged.push(line);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.ok(!state.history.some((h) => h.step === 'path-guard'), 'the path-guard step is gone');
    const guard = state.history.filter((h) => h.step === 'repo-guard');
    assert.deepEqual(
      guard.map((h) => h.note),
      ['repo-c: 1 changed path, but no story of the unit is in this repo'],
      'docs/guide.md (C01) and Makefile (no component) get none; the warning is recorded once across gates',
    );
    assert.ok(guard.every((h) => h.ok && h.warning));
    for (const h of guard) assert.ok(logged.includes(`warning: repo guard: ${h.note}`), h.note);
    assert.ok(!logged.some((l) => l.includes('docs/guide.md') || l.includes('Makefile')), logged.join('\n'));
    // The guard runs before the first gate.
    const firstGuard = state.history.findIndex((h) => h.step === 'repo-guard');
    const firstTest = state.history.findIndex((h) => h.step === 'test');
    assert.ok(firstGuard >= 0 && firstGuard < firstTest, JSON.stringify(state.history.map((h) => h.step)));
  } finally {
    cleanup();
  }
});

test("bl run's repo guard is silent when every changed repo has a story of the feature", async () => {
  const { dir, cleanup, config, feature, prep } = setupGuard();
  try {
    // fakeRunner's diff is src/a.js everywhere: inside C00 and C02; repo-c has no worktree.
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(
      !state.history.some((h) => h.step === 'repo-guard' || h.step === 'path-guard'),
      JSON.stringify(state.history),
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Repos added during a run (F-48 D3)
// ---------------------------------------------------------------------------

const DONE_BODY = '## Acceptance Criteria\n\n- [x] one works\n';

/**
 * F-1 runs with one story, S-1 in demo-repo. S-3 is a story in repo-b's home
 * component that a session adds to F-1 as `bl side` would (`addSide`), and
 * `sideWorktree` is what repo-b's main checkout lists on the branch.
 */
function setupSide({ withWorktree = true } = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: { 'demo-repo': { path: '../demo-repo' }, 'repo-b': { path: '../repo-b' } },
    components: [
      { id: 'C00', title: 'Core', dirSuffix: 'core', repo: 'demo-repo', home: true },
      { id: 'C02', title: 'B', dirSuffix: 'b', repo: 'repo-b', home: true },
      { id: 'C03', title: 'Z', dirSuffix: 'z', repo: 'repo-z' },
    ],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1', body: AC_BODY },
      {
        id: 'S-3',
        component: 'C02',
        title: 'Side',
        dirSuffix: 'side',
        points: 1,
        feature: 'F-1',
        status: 'in_progress',
        body: DONE_BODY,
      },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1'], branch: 'f1-feat' }],
  });
  const config = loadConfig({ backlogRoot: dir });
  mkdirSync(config.reposByName['repo-b'], { recursive: true });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const ordered = orderStoriesByDeps(resolveFeatureStories(feature, config, readAllStories(config)).stories);
  const worktreePath = mkTempDir('bl-wt-');
  const wtB = mkTempDir('bl-wt-b-');
  const prep = {
    cfg: configForRepo(config, 'demo-repo'),
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1-feat',
    isNewWorktree: false,
    ordered,
    baseVars: {
      featureId: 'F-1',
      storyId: 'F-1',
      title: 'Feat',
      featureRelPath: feature.featureRelPath,
      featureAbsPath: feature.indexPath,
      branchName: 'f1-feat',
      worktreePath,
      prTitle: 'F-1: Feat',
      backlogDir: dir,
      roostDir: config.roostDir,
      otherWorktrees: '(none)',
    },
    reviewPending: false,
    targetRepoName: 'demo-repo',
    otherWorktrees: [],
  };
  const addSide = () =>
    editFile(feature.indexPath, (fm) => {
      fm.stories = ['S-1', 'S-3'];
    });
  const sideShell = (runner) => {
    const shell = runner.shell;
    const forge = runner.forge;
    runner.shell = (cmd, cwd, o) => {
      if (cmd === 'git worktree list --porcelain -z' && cwd === config.reposByName['repo-b']) {
        runner.calls.push({ type: 'shell', cmd, cwd });
        const side = withWorktree ? `worktree ${wtB}\0HEAD def\0branch refs/heads/f1-feat\0\0` : '';
        return { status: 0, output: `worktree ${cwd}\0HEAD abc\0branch refs/heads/main\0\0${side}` };
      }
      return shell(cmd, cwd, o);
    };
    runner.forge = (op, vars, opts) => {
      const r = forge(op, vars, opts);
      runner.calls.at(-1).repoPath = opts?.repoPath;
      return r;
    };
    return runner;
  };
  return { dir, cleanup, config, feature, prep, wtB, addSide, sideShell };
}

test("a story a session adds in another repo is gated, PR'd and reviewed in that repo; the run records it once", async () => {
  const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
  const lead = prep.worktreePath;
  try {
    const runner = sideShell(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          story: (o) => {
            checkAll(o.vars.storyAbsPath);
            if (o.vars.storyId === 'S-1') addSide();
          },
        },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    // One refresh found it; the later ones (self-review, review, fix) add nothing.
    const repos = state.history.filter((h) => h.step === 'repos');
    assert.equal(repos.length, 1, JSON.stringify(repos));
    assert.deepEqual(repos[0].repos, ['repo-b']);
    assert.deepEqual(repos[0].stories, ['S-3']);
    assert.match(repos[0].note, new RegExp(`^repo-b \\(S-3\\) @ ${wtB}`));
    assert.deepEqual(prep.otherWorktrees, [{ repoName: 'repo-b', worktreePath: wtB }]);
    // The lead repo and its worktree stay; S-3 was complete, so no session ran for it.
    assert.equal(prep.worktreePath, lead);
    assert.equal(prep.targetRepoName, 'demo-repo');
    assert.deepEqual(
      runner.calls.filter((c) => c.prompt === 'feature-story').map((c) => c.story),
      ['S-1'],
    );
    assert.ok(
      state.history.some((h) => h.step === 'implement' && h.story === 'S-3' && /already complete/.test(h.note)),
    );
    // The gate ran in both worktrees.
    const tests = runner.calls.filter((c) => c.type === 'shell' && c.cmd === 'npm test').map((c) => c.cwd);
    assert.ok(tests.includes(lead) && tests.includes(wtB), JSON.stringify(tests));
    // Both repos were pushed and each got its PR, recorded on its repos: entry.
    const pushed = new Set(
      runner.calls.filter((c) => c.type === 'shell' && c.cmd === 'git push -u origin f1-feat').map((c) => c.cwd),
    );
    assert.deepEqual([...pushed].sort(), [lead, wtB].sort());
    assert.deepEqual(
      creates(runner)
        .map((c) => c.repoPath)
        .sort(),
      [lead, wtB].sort(),
    );
    const change = parseChange(readFileSync(CH(feature), 'utf8'));
    assert.deepEqual(
      change.repos.map((r) => [r.repo, r.branch, r.pr]),
      [
        ['demo-repo', 'f1-feat', '7'],
        ['repo-b', 'f1-feat', '7'],
      ],
    );
    // Every review pass covers repo-b's PR and worktree; later sessions are told of the worktree.
    const reviews = runner.calls.filter((c) => c.prompt?.startsWith('review-'));
    assert.ok(reviews.length > 0);
    for (const r of reviews)
      assert.ok(
        r.vars.reviewScope.includes(`- repo-b: PR #7 https://github.com/x/y/pull/7 — worktree ${wtB}`),
        r.vars.reviewScope,
      );
    const self = runner.calls.find((c) => c.prompt === 'feature-self-review');
    assert.equal(self.vars.otherWorktrees, `${wtB} (repo-b)`);
    assert.equal(runner.calls.find((c) => c.prompt === 'feature-story').vars.otherWorktrees, '(none)');
  } finally {
    cleanup();
  }
});

test('a story added in a repo with no worktree on the branch escalates, naming both, before the gate', async () => {
  const { dir, cleanup, config, feature, prep, addSide, sideShell } = setupSide({ withWorktree: false });
  try {
    const runner = sideShell(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          story: (o) => {
            checkAll(o.vars.storyAbsPath);
            addSide();
          },
        },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'S-3 is in repo-b, which has no worktree on f1-feat');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.ok(esc.includes('S-3 is in repo-b') && esc.includes('bl run F-1 --resume'), esc);
    assert.ok(!runner.calls.some((c) => c.cmd === 'npm test'), 'the gate never ran');
    assert.ok(!state.history.some((h) => h.step === 'test' || h.step === 'repos'));
    assert.deepEqual(prep.otherWorktrees, []);
  } finally {
    cleanup();
  }
});

test('a repo already prepared is not added again, and a story run never refreshes its repos', async () => {
  const { dir, cleanup, config, feature, prep } = setupGuard();
  try {
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.ok(!state.history.some((h) => h.step === 'repos'));
    assert.equal(prep.otherWorktrees.length, 1);
    assert.equal(prep.ordered.length, 2);
  } finally {
    cleanup();
  }
  const s = storySetup();
  try {
    const runner = fakeRunner({ dir: s.dir, feature: s.unit });
    const state = await runFeature({ feature: s.unit, config: s.config, prep: s.prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.ok(!state.history.some((h) => h.step === 'repos'));
    assert.equal(s.prep.otherWorktrees, undefined, "a story run's prep is never touched");
    assert.equal(s.prep.ordered.length, 1);
  } finally {
    s.cleanup();
  }
});

// refresh_rejects_unresolvable_story_scope: every way a session can leave the
// feature's stories unresolvable stops the run at the refresh, before the gate,
// a PR or a review, and is never read as "nothing changed".
test('refresh_rejects_unresolvable_story_scope: an unresolvable story list or story escalates before anything is gated, published or reviewed', async () => {
  const S3 = (dir) => join(dir, 'stories', 'S3-side', 'index.md');
  const cases = [
    {
      name: 'scalar list',
      edit: ({ feature }) =>
        editFile(feature.indexPath, (fm) => {
          fm.stories = 'S-1, S-3';
        }),
      error: /not a list/,
    },
    {
      name: 'mapping list',
      edit: ({ feature }) =>
        editFile(feature.indexPath, (fm) => {
          fm.stories = { story: 'S-3' };
        }),
      error: /not a list/,
    },
    {
      name: 'missing story',
      edit: ({ feature }) =>
        editFile(feature.indexPath, (fm) => {
          fm.stories = ['S-1', 'S-999'];
        }),
      error: /lists stories that don't exist: S-999/,
    },
    {
      name: 'invalid member',
      edit: ({ feature }) =>
        editFile(feature.indexPath, (fm) => {
          fm.stories = ['S-1', 'nonsense'];
        }),
      error: /lists stories that don't exist: nonsense/,
    },
    {
      name: 'malformed story YAML',
      edit: ({ dir, addSide }) => {
        addSide();
        writeFileSync(S3(dir), '---\nstory_id: S-3\ncomponent: [\n---\n');
      },
      error: /could not be re-read/,
    },
    {
      name: 'mismatched feature',
      edit: ({ dir, addSide }) => {
        addSide();
        editFile(S3(dir), (fm) => {
          fm.feature = 'F-2';
        });
      },
      error: /S-3 \(feature: F-2\) listed but pointing elsewhere/,
    },
    {
      name: 'story without a repo',
      edit: ({ dir, addSide }) => {
        addSide();
        editFile(S3(dir), (fm) => {
          fm.component = 'C99';
        });
      },
      error: /S-3 \(component C99\) has no repo/,
    },
    {
      name: 'unknown repo',
      edit: ({ dir, addSide }) => {
        addSide();
        editFile(S3(dir), (fm) => {
          fm.component = 'C03';
        });
      },
      error: /unknown repo repo-z/,
    },
    {
      name: 'blocked outside the feature',
      edit: ({ dir, addSide }) => {
        addSide();
        editFile(S3(dir), (fm) => {
          fm.depends_on = ['S-77'];
        });
      },
      error: /S-3 depends on S-77 \(missing\)/,
    },
    {
      name: 'change document write fails',
      edit: ({ addSide }) => {
        addSide();
        atomicHooks.beforeRename = (tmp) => {
          if (!readFileSync(tmp, 'utf8').includes('repo-b')) return;
          atomicHooks.beforeRename = null;
          throw new Error('injected change write failure');
        };
      },
      error: /could not name repo-b: injected change write failure/,
    },
  ];
  for (const c of cases) {
    const s = setupSide();
    try {
      const runner = s.sideShell(
        fakeRunner({
          dir: s.dir,
          feature: s.feature,
          behaviour: {
            story: (o) => {
              checkAll(o.vars.storyAbsPath);
              c.edit(s);
            },
          },
        }),
      );
      const state = await runFeature({
        feature: s.feature,
        config: s.config,
        prep: s.prep,
        runner,
        opts: { maxRounds: 2 },
      });
      assert.equal(state.status, 'escalated', `${c.name}: ${JSON.stringify(state.history.slice(-3))}`);
      assert.match(state.lastError, c.error, c.name);
      assert.ok(!runner.calls.some((x) => x.cmd === 'npm test'), `${c.name}: the gate never ran`);
      assert.equal(creates(runner).length, 0, `${c.name}: no PR was opened`);
      assert.ok(!runner.calls.some((x) => x.prompt?.startsWith('review-')), `${c.name}: no review ran`);
    } finally {
      atomicHooks.beforeRename = null;
      s.cleanup();
    }
  }
});

// secondary_review_scope_is_independent_of_pr_presence: a repo the run
// prepared is reviewed and snapshotted whether it has a PR (opened, recorded
// before the run) or none (its forge off, or no forge at all).
test("secondary_review_scope_is_independent_of_pr_presence: an added repo is in every review's scope and snapshots, PR or not", async () => {
  const cases = [
    { name: 'PR opened', line: 'PR #7 https://github.com/x/y/pull/7' },
    { name: 'PR recorded before', recorded: true, line: 'PR #9 https://github.com/x/b/pull/9' },
    {
      name: 'repo-b forge off',
      noForge: (o) => o.repoPath !== undefined && o.repoPath === o.wtB,
      line: 'no pull request',
    },
    { name: 'no forge at all', noForge: () => true, line: 'no pull request' },
  ];
  for (const c of cases) {
    const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
    try {
      const runner = sideShell(
        fakeRunner({
          dir,
          feature,
          behaviour: {
            story: (o) => {
              checkAll(o.vars.storyAbsPath);
              addSide();
              if (c.recorded) {
                const doc = parseChange(readFileSync(CH(feature), 'utf8'));
                doc.repos = [
                  ...doc.repos,
                  { repo: 'repo-b', branch: 'f1-feat', pr: '9', url: 'https://github.com/x/b/pull/9', merged: '' },
                ];
                writeFileSync(CH(feature), serializeChange(doc));
              }
            },
          },
        }),
      );
      if (c.noForge) {
        const forge = runner.forge;
        runner.forge = (op, vars, opts) =>
          c.noForge({ repoPath: opts?.repoPath, wtB })
            ? { configured: false, reason: 'no-forge' }
            : forge(op, vars, opts);
      }
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', `${c.name}: ${JSON.stringify(state.history.slice(-3))}`);
      const reviews = runner.calls.filter((x) => x.prompt?.startsWith('review-'));
      assert.ok(reviews.length > 0, c.name);
      for (const r of reviews)
        assert.ok(
          r.vars.reviewScope.includes(`- repo-b: ${c.line} — worktree ${wtB}`),
          `${c.name}: ${r.vars.reviewScope}`,
        );
      const snaps = runner.calls.filter(
        (x) => x.type === 'shell' && x.cwd === wtB && x.cmd.startsWith('git ls-files -s -z --'),
      );
      assert.ok(snaps.length >= reviews.length, `${c.name}: repo-b snapshotted around every pass (${snaps.length})`);
    } finally {
      cleanup();
    }
  }
});

// late_side_stories_complete_gates_before_clean: whichever session adds a
// story in another repo, the run implements it when it is unfinished, gates
// that repo and reviews it after the addition, and only then finishes clean.
test('late_side_stories_complete_gates_before_clean: a story added at any stage is implemented, gated and reviewed before clean', async () => {
  const S3 = (dir) => join(dir, 'stories', 'S3-side', 'index.md');
  const cases = [
    { name: 'story session', at: 'story' },
    { name: 'self-review', at: 'selfReview' },
    { name: 'self-review, story unfinished', at: 'selfReview', unfinished: true },
    { name: 'fix-tests', at: 'fixTests', testResults: [1] },
    { name: 'verifier, addressed', at: 'verify', verdicts: [false, false] },
    { name: 'verifier, pending', at: 'verify', verdicts: [true, false] },
    { name: 'fix', at: 'fix' },
    { name: 'fix, story unfinished', at: 'fix', unfinished: true },
    { name: 'fix self-review', at: 'fixSelfReview' },
  ];
  for (const c of cases) {
    const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
    try {
      let mark = null;
      let runner;
      const add = () => {
        if (mark != null) return;
        mark = runner.calls.length;
        addSide();
        if (c.unfinished) editFile(S3(dir), (fm, body) => body.replace('- [x]', '- [ ]'));
      };
      let round = 0;
      const verdicts = c.verdicts ?? [true, false];
      const behaviour = {
        story: (o) => {
          checkAll(o.vars.storyAbsPath);
          if (c.at === 'story' && o.vars.storyId === 'S-1') add();
        },
        verify: () => {
          round += 1;
          writeSession(CH(feature), { pending: verdicts[round - 1] ?? false, round });
          if (c.at === 'verify') add();
        },
      };
      if (c.at === 'selfReview') behaviour.selfReview = add;
      if (c.at === 'fixTests') behaviour.fixTests = add;
      if (c.at === 'fixSelfReview') behaviour.fixSelfReview = add;
      if (c.at === 'fix') {
        behaviour.fix = () => {
          editFile(CH(feature), (fm, body) => {
            fm.review_status = 'fixed';
            return body.replaceAll('- [ ] invariant', '- [x] invariant');
          });
          add();
        };
      }
      runner = sideShell(fakeRunner({ dir, feature, behaviour, testResults: c.testResults ?? [] }));
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 3 } });
      assert.equal(state.status, 'clean', `${c.name}: ${JSON.stringify(state.history.slice(-3))}`);
      assert.ok(mark != null, `${c.name}: the side story was added`);
      const after = runner.calls.slice(mark);
      if (c.unfinished) {
        assert.ok(
          after.some((x) => x.prompt === 'feature-story' && x.story === 'S-3'),
          `${c.name}: S-3 was implemented`,
        );
      }
      assert.ok(
        after.some((x) => x.cmd === 'npm test' && x.cwd === wtB),
        `${c.name}: repo-b was gated after the addition`,
      );
      assert.ok(
        after.some((x) => x.prompt?.startsWith('review-') && x.vars.reviewScope.includes(`worktree ${wtB}`)),
        `${c.name}: a review after the addition covered repo-b`,
      );
      assert.ok(
        creates(runner).some((x) => x.repoPath === wtB),
        `${c.name}: repo-b got its PR`,
      );
    } finally {
      cleanup();
    }
  }
});

test('late_side_stories_complete_gates_before_clean: a closing round that adds a story escalates rather than finishing unreviewed', async () => {
  const { dir, cleanup, config, feature, prep, wtB, addSide, sideShell } = setupSide();
  try {
    let round = 0;
    const runner = sideShell(
      fakeRunner({
        dir,
        feature,
        behaviour: {
          // Round 1 leaves an item; round 2 is the closing round (cap 1).
          verify: () => {
            round += 1;
            writeSession(CH(feature), { pending: round === 1, round });
            if (round === 2) addSide();
          },
        },
      }),
    );
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 1 } });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /the closing round added stories S-3 and repos repo-b, which no review has covered/);
    assert.ok(
      !runner.calls.some((x) => x.prompt?.startsWith('review-') && x.vars.reviewScope.includes(`worktree ${wtB}`)),
    );
  } finally {
    cleanup();
  }
});

test('late_side_stories_complete_gates_before_clean: a resumed addressed run reviews a story and repo its last review did not cover', async () => {
  const { dir, cleanup, config, feature, prep, wtB, sideShell } = setupSide();
  try {
    let round = 0;
    const behaviour = {
      verify: () => {
        round += 1;
        writeSession(CH(feature), { pending: false, round });
      },
    };
    const first = await runFeature({
      feature,
      config,
      prep,
      runner: sideShell(fakeRunner({ dir, feature, behaviour })),
      opts: { maxRounds: 2 },
    });
    assert.equal(first.status, 'clean');
    // S-3 joins after the run, as `bl side` would add it; `bl run --resume`
    // prepares every repo of the feature's stories.
    editFile(feature.indexPath, (fm) => {
      fm.stories = ['S-1', 'S-3'];
    });
    const again = findFeature(normalizeFeatureId('F-1'), config);
    const resumed = {
      ...prep,
      ordered: orderStoriesByDeps(resolveFeatureStories(again, config, readAllStories(config)).stories),
      otherWorktrees: [{ repoName: 'repo-b', worktreePath: wtB }],
    };
    const runner = sideShell(fakeRunner({ dir, feature: again, behaviour }));
    const state = await runFeature({
      feature: again,
      config,
      prep: resumed,
      runner,
      opts: { maxRounds: 2, resume: true },
    });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    const reviews = runner.calls.filter((x) => x.prompt?.startsWith('review-'));
    assert.ok(reviews.length > 0, 'the resumed run reviewed again');
    for (const r of reviews) assert.ok(r.vars.reviewScope.includes(`worktree ${wtB}`), r.vars.reviewScope);
    // Resumed again with nothing new, addressed stands.
    const quiet = sideShell(fakeRunner({ dir, feature: again, behaviour }));
    const done = await runFeature({
      feature: again,
      config,
      prep: resumed,
      runner: quiet,
      opts: { maxRounds: 2, resume: true },
    });
    assert.equal(done.status, 'clean');
    assert.ok(!quiet.calls.some((x) => x.prompt?.startsWith('review-')));
  } finally {
    cleanup();
  }
});

// late_stories_follow_dependency_order: whichever session adds stories, in
// the lead repo or another, the run implements what it has not taken yet in
// dependency order, as it orders the stories at the start: an added story
// after an added prerequisite listed after it, and an existing story not
// taken yet after a prerequisite a session gave it.
test('late_stories_follow_dependency_order: stories added at any stage are implemented after their prerequisites', async () => {
  const stages = [
    { at: 'story' },
    { at: 'selfReview' },
    { at: 'fixTests', testResults: [1] },
    { at: 'verify', verdicts: [false, false] },
    { at: 'fix' },
    { at: 'fixSelfReview' },
  ];
  const deps = [
    // [S-3's depends_on, S-4's depends_on, expected order of S-3 and S-4]
    { name: 'S-3 on later-listed S-4', s3: ['S-4'], s4: [], expected: ['S-4', 'S-3'] },
    { name: 'S-4 on S-3', s3: [], s4: ['S-3'], expected: ['S-3', 'S-4'] },
    { name: 'independent', s3: [], s4: [], expected: ['S-3', 'S-4'] },
  ];
  const failures = [];
  for (const stage of stages) {
    for (const component of ['C00', 'C02']) {
      for (const d of deps) {
        const label = `${stage.at}, ${component}, ${d.name}`;
        const { dir, cleanup, config, feature, prep, sideShell } = setupSide();
        try {
          let added = false;
          const add = () => {
            if (added) return;
            added = true;
            editFile(join(dir, 'stories', 'S3-side', 'index.md'), (fm, body) => {
              fm.component = component;
              fm.depends_on = d.s3;
              return body.replace('- [x]', '- [ ]');
            });
            mkdirSync(join(dir, 'stories', 'S4-dep'));
            writeFileSync(
              join(dir, 'stories', 'S4-dep', 'index.md'),
              serializeFrontmatter({
                story_id: 'S-4',
                title: 'Dep',
                component,
                feature: 'F-1',
                status: 'in_progress',
                points: '1',
                depends_on: d.s4,
              }) + AC_BODY,
            );
            editFile(feature.indexPath, (fm) => {
              fm.stories = ['S-1', 'S-3', 'S-4'];
            });
          };
          let round = 0;
          const verdicts = stage.verdicts ?? [true, false];
          const behaviour = {
            story: (o) => {
              checkAll(o.vars.storyAbsPath);
              if (stage.at === 'story' && o.vars.storyId === 'S-1') add();
            },
            verify: () => {
              round += 1;
              writeSession(CH(feature), { pending: verdicts[round - 1] ?? false, round });
              if (stage.at === 'verify') add();
            },
          };
          if (stage.at === 'selfReview') behaviour.selfReview = add;
          if (stage.at === 'fixTests') behaviour.fixTests = add;
          if (stage.at === 'fixSelfReview') behaviour.fixSelfReview = add;
          if (stage.at === 'fix') {
            behaviour.fix = () => {
              editFile(CH(feature), (fm, body) => {
                fm.review_status = 'fixed';
                return body.replaceAll('- [ ] invariant', '- [x] invariant');
              });
              add();
            };
          }
          // fakeRunner consumes testResults: each case gets its own copy.
          const runner = sideShell(
            fakeRunner({ dir, feature, behaviour, testResults: [...(stage.testResults ?? [])] }),
          );
          await runFeature({ feature, config, prep, runner, opts: { maxRounds: 3 } });
          const order = [...new Set(runner.calls.filter((x) => x.prompt === 'feature-story').map((x) => x.story))];
          const expected = ['S-1', ...d.expected];
          if (JSON.stringify(order) !== JSON.stringify(expected)) failures.push({ label, order, expected });
        } finally {
          cleanup();
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('late_stories_follow_dependency_order: an existing story not taken yet waits for a prerequisite a session gives it', async () => {
  for (const component of ['C00', 'C02']) {
    const { dir, cleanup, config, feature, prep, sideShell } = setupSide();
    try {
      // F-1 starts with S-1 and S-2; S-2 is not taken while S-1 runs.
      mkdirSync(join(dir, 'stories', 'S2-second'));
      writeFileSync(
        join(dir, 'stories', 'S2-second', 'index.md'),
        serializeFrontmatter({
          story_id: 'S-2',
          title: 'Second',
          component: 'C00',
          feature: 'F-1',
          status: 'in_progress',
          points: '1',
        }) + AC_BODY,
      );
      editFile(feature.indexPath, (fm) => {
        fm.stories = ['S-1', 'S-2'];
      });
      prep.ordered = orderStoriesByDeps(
        resolveFeatureStories(findFeature(normalizeFeatureId('F-1'), config), config, readAllStories(config)).stories,
      );
      const behaviour = {
        story: (o) => {
          checkAll(o.vars.storyAbsPath);
          if (o.vars.storyId !== 'S-1') return;
          // The S-1 session adds S-4 and makes S-2 depend on it.
          mkdirSync(join(dir, 'stories', 'S4-dep'));
          writeFileSync(
            join(dir, 'stories', 'S4-dep', 'index.md'),
            serializeFrontmatter({
              story_id: 'S-4',
              title: 'Dep',
              component,
              feature: 'F-1',
              status: 'in_progress',
              points: '1',
            }) + AC_BODY,
          );
          editFile(join(dir, 'stories', 'S2-second', 'index.md'), (fm) => {
            fm.depends_on = ['S-4'];
          });
          editFile(feature.indexPath, (fm) => {
            fm.stories = ['S-1', 'S-2', 'S-4'];
          });
        },
      };
      const runner = sideShell(fakeRunner({ dir, feature, behaviour }));
      await runFeature({ feature, config, prep, runner, opts: { maxRounds: 3 } });
      const order = [...new Set(runner.calls.filter((x) => x.prompt === 'feature-story').map((x) => x.story))];
      assert.deepEqual(order, ['S-1', 'S-4', 'S-2'], component);
    } finally {
      cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Tokens per step (S-904)
// ---------------------------------------------------------------------------

/**
 * Wrap `runner.session` like runHeadlessSession(): every spawn, refused or
 * not, reports one input token and adds it to the unit file under the key the
 * loop passed. `throwAt` (1-based) makes that spawn throw instead, as a
 * killed `bl` would leave it: nothing recorded for it.
 */
function recordingStepTokens(runner, { throwAt = 0 } = {}) {
  const session = runner.session;
  const keys = [];
  runner.session = (o) => {
    keys.push(o.tokensStep);
    if (keys.length === throwAt) throw new Error('killed');
    const usage = { input: 1, output: 0, cache_creation: 0, cache_read: 0 };
    accumulateTokensOnFile(o.config.backlogRoot, o.usageIndexPath, usage, o.tokensStep);
    return { ...session(o), usage };
  };
  return keys;
}

const stepInputs = (feature) => {
  const { fm } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
  return { fm, steps: Object.fromEntries(Object.entries(fm.tokens_by_step ?? {}).map(([k, v]) => [k, v.input])) };
};

test('tokens_by_step: a run records each session under its step and review round', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const keys = recordingStepTokens(runner);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(keys, [
      'implement',
      'implement',
      'self-review',
      'review.1',
      'review.1',
      'review.1',
      'fix.1',
      'fix-self-review.1',
      'review.2',
      'review.2',
      'review.2',
    ]);
    const { fm, steps } = stepInputs(feature);
    assert.deepEqual(steps, {
      implement: '2',
      'self-review': '1',
      'review.1': '3',
      'fix.1': '1',
      'fix-self-review.1': '1',
      'review.2': '3',
    });
    assert.equal(fm.tokens_input, '11', 'the totals count every session, as before');
    assert.equal(fm.tokens_headless_input, '11');
  } finally {
    cleanup();
  }
});

test('tokens_by_step: a session refused for a usage limit and its rerun add up under one key', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let hits = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.promptName === 'feature-story' && o.vars.storyId === 'S-1' && hits++ === 0 ? spendLimit(runner) : null,
      },
    });
    recordingStepTokens(runner);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const { fm, steps } = stepInputs(feature);
    assert.equal(steps.implement, '3', "S-1's refusal and rerun, and S-2");
    assert.equal(fm.tokens_input, '12');
  } finally {
    cleanup();
  }
});

test("tokens_by_step: a run killed mid-session keeps the earlier sessions' entries", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    // The fifth spawn is review round 1's second pass.
    recordingStepTokens(runner, { throwAt: 5 });
    await assert.rejects(runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }), /killed/);
    const { fm, steps } = stepInputs(feature);
    assert.deepEqual(steps, { implement: '2', 'self-review': '1', 'review.1': '1' });
    assert.equal(fm.tokens_input, '4');
  } finally {
    cleanup();
  }
});

test("tokensStepKey: the run loop's keys for each session", () => {
  assert.equal(tokensStepKey('implement', undefined), 'implement');
  assert.equal(tokensStepKey('fix-tests', 1), 'fix-tests');
  assert.equal(tokensStepKey('self-review', undefined), 'self-review');
  assert.equal(tokensStepKey('review:correctness', 2), 'review.2');
  assert.equal(tokensStepKey('review:verify', 2), 'review.2');
  assert.equal(tokensStepKey('fix', 1), 'fix.1');
  assert.equal(tokensStepKey('merge-resolve', 2), 'merge-resolve');
});

test('bl status tokens lines: totals and one line per step, totals alone, or nothing', () => {
  const totals = {
    tokens_input: '1234',
    tokens_output: '56',
    tokens_cache_creation: '0',
    tokens_cache_read: '1000000',
  };
  assert.deepEqual(tokensLines({}), []);
  assert.deepEqual(tokensLines({ tokens_by_step: { implement: { input: '1' } } }), [], 'no totals, nothing');
  assert.deepEqual(tokensLines(totals), ['tokens: input 1,234 · output 56 · cache_creation 0 · cache_read 1,000,000']);
  assert.deepEqual(
    tokensLines({
      ...totals,
      tokens_by_step: {
        'review.1': { input: '10', output: '2', cache_creation: '0', cache_read: '3000' },
        implement: { input: '1200', output: '50', cache_creation: '0', cache_read: '0' },
      },
    }),
    [
      'tokens: input 1,234 · output 56 · cache_creation 0 · cache_read 1,000,000',
      '  review.1: input 10 · output 2 · cache_creation 0 · cache_read 3,000',
      '  implement: input 1,200 · output 50 · cache_creation 0 · cache_read 0',
    ],
    'keys in file order',
  );
});

test('interactive-run-refreshes-totals-for-story-and-feature-after-each-session', async () => {
  const { defaultRunner } = await import('../../src/feature-run.js');
  const { ClaudeProvider } = await import('../../src/agents/claude.js');
  const { spawn, getTokens } = ClaudeProvider.prototype;
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  const { dir, cleanup } = mkTempBacklog();
  // Each spawn adds 5 input tokens to the worktree's transcript.
  let transcript = 10;
  ClaudeProvider.prototype.spawn = () => {
    transcript += 5;
    return { status: 0 };
  };
  ClaudeProvider.prototype.getTokens = () => ({ input: transcript, output: 0, cache_creation: 0, cache_read: 0 });
  try {
    const config = loadConfig({ backlogRoot: dir });
    const units = [
      ['story', '---\nstory_id: S-1\ntitle: T\ntokens_input: 10\n---\n\n# T\n', { id: 'S-1' }],
      [
        'feature',
        '---\nfeature_id: F-1\ntitle: T\ntokens_input: 10\ntokens_headless_input: 0\n---\n\n# T\n',
        { id: 'F-1' },
      ],
    ];
    for (const [kind, content, parsed] of units) {
      const indexPath = join(dir, `${kind}.md`);
      writeFileSync(indexPath, content);
      for (const [n, step] of [
        [1, 'self-review'],
        [2, 'review.1'],
      ]) {
        defaultRunner({ interactive: true }).session({
          mode: 'workon',
          agent: 'claude',
          promptName: 'feature-self-review',
          vars: {},
          worktreePath: mkTempDir('bl-wt-'),
          config,
          parsed,
          label: `${parsed.id}: T`,
          usageIndexPath: indexPath,
          tokensStep: step,
        });
        const { fm } = parseFrontmatter(readFileSync(indexPath, 'utf8'));
        assert.equal(fm.tokens_by_step[step].input, '5', `${kind} session ${n}: step`);
        assert.equal(fm.tokens_input, String(10 + 5 * n), `${kind} session ${n}: totals`);
      }
    }
  } finally {
    Object.assign(ClaudeProvider.prototype, { spawn, getTokens });
    if (tmux != null) process.env.TMUX = tmux;
    cleanup();
  }
});

// F-67 S-1098: the loop's spec writes go through updateSpecFile.

test('an escalation write overlapping a token write in another process keeps both', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let gates = 0;
    let writer = null;
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        // The token writer has read the feature, and holds its lock, when
        // the second failed gate escalates.
        shell: (cmd) => {
          if (cmd === 'npm test' && ++gates === 2) writer = startTokenWriter(dir, feature.indexPath, 'overlap');
          return null;
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner });
    assert.equal(state.status, 'escalated');
    assert.ok(writer, 'the gate ran twice');
    assert.equal(await writer.done, 0);
    const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.equal(fm.status, 'escalated');
    assert.match(extractSection(body, 'Escalation'), /test gate failed twice/);
    assert.equal(fm.tokens_by_step?.overlap?.input, '7', "the token writer's step entry is kept");
  } finally {
    cleanup();
  }
});

test('a failed escalation write leaves the previous feature file and no staging file', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let gates = 0;
    let before = null;
    let restore = null;
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        shell: (cmd) => {
          if (cmd === 'npm test' && ++gates === 2) {
            before = readFileSync(feature.indexPath, 'utf8');
            restore = installPartialWrites(feature.indexPath);
          }
          return null;
        },
      },
    });
    try {
      await assert.rejects(runFeature({ feature, config, prep, runner }), /ENOSPC/);
    } finally {
      restore?.();
    }
    assert.ok(before, 'the gate ran twice');
    assert.equal(readFileSync(feature.indexPath, 'utf8'), before, 'the previous file, whole');
    const staging = join(dir, '.bl', 'tmp');
    assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], [], 'no staging file left');
  } finally {
    cleanup();
  }
});

test("restoreKeepingTokens writes the snapshot back with the current file's token keys", () => {
  const { dir, cleanup, feature } = setup();
  try {
    const snapshot = readFileSync(feature.indexPath, 'utf8');
    const snap = parseFrontmatter(snapshot);
    editFile(feature.indexPath, (fm, body) => {
      fm.status = 'verifier-edit';
      fm.tokens_input = '9';
      fm.tokens_headless_input = '9';
      fm.tokens_updated = '2026-10-27';
      fm.tokens_by_step = { 'review.1': { input: '9', output: '0', cache_creation: '0', cache_read: '0' } };
      return `${body}\nverifier text\n`;
    });
    const current = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
    assert.equal(restoreKeepingTokens(dir, feature.indexPath, snapshot), true);
    const after = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    const tokens = (fm) => Object.fromEntries(Object.entries(fm).filter(([k]) => k.startsWith('tokens_')));
    const rest = (fm) => Object.fromEntries(Object.entries(fm).filter(([k]) => !k.startsWith('tokens_')));
    assert.deepEqual(tokens(after.fm), tokens(current), "the session's usage is kept");
    assert.deepEqual(rest(after.fm), rest(snap.fm), "the rest of the frontmatter is the snapshot's");
    assert.equal(after.body, snap.body, "the body is the snapshot's");
    // With the token keys taken out, the file is the snapshot byte for byte.
    const strip = (text) => {
      const { fm, body } = parseFrontmatter(text);
      return serializeFrontmatter(rest(fm)) + body;
    };
    assert.equal(strip(readFileSync(feature.indexPath, 'utf8')), strip(snapshot));
  } finally {
    cleanup();
  }
});

test('a failed review-verify session keeps the usage it recorded on the feature, and drops its edits', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let failed = false;
    let round = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          if (!failed) {
            editFile(feature.indexPath, (fm, body) => {
              fm.verifier_edit = 'x';
              return `${body}\nverifier text\n`;
            });
            return;
          }
          round += 1;
          writeSession(CH(feature), { pending: round === 1, round });
        },
      },
    });
    const session = runner.session;
    runner.session = (o) => {
      const r = session(o);
      if (o.promptName !== 'review-verify' || failed) return r;
      failed = true;
      return { ...r, ok: false, isError: true, error: 'provider crashed' };
    };
    const keys = recordingStepTokens(runner);
    await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.ok(failed, 'the verifier ran');
    const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.equal(fm.verifier_edit, undefined, "the failed verifier's edit is gone");
    assert.doesNotMatch(body, /verifier text/);
    assert.equal(fm.tokens_input, String(keys.length), "every session's usage, the failed verifier's included");
    const stepSum = Object.values(fm.tokens_by_step).reduce((n, e) => n + Number(e.input), 0);
    assert.equal(stepSum, keys.length, 'and its tokens_by_step entry');
  } finally {
    cleanup();
  }
});

test('failed_verify_restores_missing_or_malformed_spec_and_change_document', async () => {
  const dir = mkTempDir('bl-restore-');
  const path = join(dir, 'index.md');
  const snapshot = '---\nfeature_id: F-1\nstatus: running\ntokens_input: 1\n---\n\nOriginal\n';
  const crlf = (t) => t.replace(/\n/g, '\r\n');
  try {
    // The live file the failed session left: its readable token keys are kept, its line end too; an unreadable one gets the snapshot whole.
    const live = {
      valid: [
        '---\nfeature_id: F-1\nstatus: edited\ntokens_input: 9\n---\n\nEdit\n',
        '---\nfeature_id: F-1\nstatus: running\ntokens_input: 9\n---\n\nOriginal\n',
      ],
      crlf: [
        crlf('---\nfeature_id: F-1\nstatus: edited\ntokens_input: 9\n---\n\nEdit\n'),
        crlf('---\nfeature_id: F-1\nstatus: running\ntokens_input: 9\n---\n\nOriginal\n'),
      ],
      missing: [null, snapshot],
      empty: ['', snapshot],
      unfenced: ['Edited without fences\n', snapshot],
      malformed: ['---\nfeature_id: [\n---\nEdit\n', snapshot],
    };
    for (const [name, [current, expected]] of Object.entries(live)) {
      if (current === null) rmSync(path, { force: true });
      else writeFileSync(path, current);
      assert.equal(restoreKeepingTokens(dir, path, snapshot), true, name);
      assert.equal(readFileSync(path, 'utf8'), expected, name);
    }
    // A CRLF snapshot over a missing file goes back as it was.
    rmSync(path);
    restoreKeepingTokens(dir, path, crlf(snapshot));
    assert.equal(readFileSync(path, 'utf8'), crlf(snapshot), 'CRLF snapshot');
    // A snapshot that is not a spec is refused and the live file left alone.
    for (const [name, bad] of Object.entries({
      empty: '',
      unfenced: 'Snapshot without fences\n',
      malformed: '---\nfeature_id: [\n---\nBad\n',
    })) {
      writeFileSync(path, live.valid[0]);
      assert.throws(() => restoreKeepingTokens(dir, path, bad), FrontmatterError, `snapshot ${name}`);
      assert.equal(readFileSync(path, 'utf8'), live.valid[0], `snapshot ${name}: live file untouched`);
    }
    // A failed rename leaves the live file whole; the retry restores it.
    for (const current of [live.valid[0], live.unfenced[0]]) {
      writeFileSync(path, current);
      atomicHooks.beforeRename = () => {
        throw new Error('injected rename failure');
      };
      try {
        assert.throws(() => restoreKeepingTokens(dir, path, snapshot), /injected rename failure/);
      } finally {
        atomicHooks.beforeRename = null;
      }
      assert.equal(readFileSync(path, 'utf8'), current, 'the failed restore left the file whole');
      assert.equal(restoreKeepingTokens(dir, path, snapshot), true, 'retry');
      assert.match(readFileSync(path, 'utf8'), /Original/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // In the loop: a verifier that damaged the feature file and the change
  // document, then failed, has both put back, and the round aborts.
  const damage = {
    missing: (p) => rmSync(p),
    empty: (p) => writeFileSync(p, ''),
    unfenced: (p) => writeFileSync(p, '# damaged by the verifier\n'),
    malformed: (p) => writeFileSync(p, '---\nfeature_id: [\n---\n'),
    'restore fails': null,
  };
  for (const [name, hurt] of Object.entries(damage)) {
    const { dir: root, cleanup, config, feature, prep } = setup();
    try {
      let failed = false;
      let before = null;
      let seen = null;
      let round = 0;
      const runner = fakeRunner({
        dir: root,
        feature,
        behaviour: {
          verify: () => {
            if (!failed) {
              before = { feature: readFileSync(feature.indexPath, 'utf8'), change: readFileSync(CH(feature), 'utf8') };
              writeFileSync(CH(feature), 'verifier garbage\n');
              if (hurt) hurt(feature.indexPath);
              else editFile(feature.indexPath, (fm) => void (fm.verifier_edit = 'x'));
              return;
            }
            round += 1;
            writeSession(CH(feature), { pending: round === 1, round });
          },
        },
      });
      const session = runner.session;
      runner.session = (o) => {
        if (failed && !seen) {
          seen = {
            feature: existsSync(feature.indexPath) ? readFileSync(feature.indexPath, 'utf8') : null,
            change: readFileSync(CH(feature), 'utf8'),
          };
        }
        const r = session(o);
        if (o.promptName !== 'review-verify' || failed) return r;
        failed = true;
        // The feature's restore (the write that drops the verifier's edit,
        // not a token write that keeps it) fails once: the change document
        // is still restored.
        if (!hurt) {
          atomicHooks.beforeRename = (tmp) => {
            if (!tmp.includes('index.md.') || readFileSync(tmp, 'utf8').includes('verifier_edit')) return;
            atomicHooks.beforeRename = null;
            throw new Error('injected rename failure');
          };
        }
        return { ...r, ok: false, isError: true, error: 'provider crashed' };
      };
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      atomicHooks.beforeRename = null;
      assert.ok(failed, `${name}: the verifier ran`);
      // The aborted round escalates; it writes only the Escalation section.
      assert.equal(state.status, 'escalated', name);
      seen ??= {
        feature: existsSync(feature.indexPath) ? readFileSync(feature.indexPath, 'utf8') : null,
        change: readFileSync(CH(feature), 'utf8'),
      };
      assert.equal(seen.change, before.change, `${name}: the change document is restored`);
      const abort = state.history.find((h) => h.step === 'review:abort');
      assert.match(abort?.note ?? '', /the verifier failed: provider crashed/, `${name}: the round aborted`);
      if (hurt) {
        const after = parseFrontmatter(seen.feature ?? '');
        const rest = (body) => replaceSection(body, 'Escalation', '');
        assert.equal(
          rest(after.body),
          rest(parseFrontmatter(before.feature).body),
          `${name}: the feature file is restored`,
        );
        assert.equal(after.fm.feature_id, feature.id, `${name}: with its frontmatter`);
      } else {
        assert.match(
          abort.note,
          /could not restore the verifier's edits: injected rename failure/,
          `${name}: the failure is named`,
        );
      }
    } finally {
      atomicHooks.beforeRename = null;
      cleanup();
    }
  }
});
