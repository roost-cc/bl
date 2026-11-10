import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter, runForgeOp } from '../../src/config.js';
import { extractSection, replaceSection, resolveFeaturePluginsReport } from '../../src/feature.js';
import {
  runFeature,
  planSteps,
  formatPlan,
  uncheckedCriteria,
  loadRunState,
  runStatePath,
  runLockPath,
  reviewFeature,
  parseMaxRounds,
  RUN_DIR,
  looksFlaky,
  shellMerged,
  ESCALATION_FILE,
  reviewEnd,
  roundCapStanding,
} from '../../src/feature-run.js';
import { spawnSync } from 'child_process';
import { featureReviewGate, summarizeLatestReviewSession } from '../../src/review-log.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { parseChange, serializeChange } from '../../src/change-doc.js';
import {
  PENDING_END,
  setup,
  CH,
  creates,
  editFile,
  checkAll,
  verifySession,
  fakeRunner,
  lastTitle,
  statusOf,
} from '../helpers/feature-run-fixture.js';
import { fixTestsOutcome, reviewOutcome } from '../helpers/outcomes.js';
import { validateOutcome } from '../../src/outcome.js';
import { loadSchema } from '../../src/session.js';
import { reviewOf, statusOf as logStatusOf, transition } from '../../src/transition.js';

// --- how `bl review` ends (S-1348) ---

const MUST_LOG = '## Review Log\n\n### Session 2026-11-09 (PR #1)\n\n**Must fix**\n\n- [ ] one\n';

/**
 * A review state as `reviewOf` reads it from a log (F-69 D5): `reviewed`
 * rounds with a verdict, the unit at `position`; `fixed`, a fix opened the
 * round in review.
 */
const review = (reviewed, position, fixed = false) => ({
  round: reviewed + (position === 'in_review' ? 1 : 0),
  reviewed,
  position,
  fixed,
});

const end = (r, extra = {}) =>
  reviewEnd({
    id: 'S-7',
    unitRelPath: 'stories/S7-x/index.md',
    maxRounds: 2,
    review: r,
    body: MUST_LOG,
    state: null,
    ...extra,
  });

const CLOSING = ' The round cap (2) is reached: the next run fixes these items and runs one closing round on them.';

test('roundCapStanding: below the cap, owed a closing round, or reached', () => {
  assert.equal(roundCapStanding(null, review(1, 'fixing'), 2), 'below');
  assert.equal(roundCapStanding(null, review(2, 'fixing'), 2), 'closing');
  assert.equal(roundCapStanding(null, review(2, 'in_review', true), 2), 'closing');
  assert.equal(
    roundCapStanding(null, review(2, 'in_review'), 2),
    'reached',
    'an open round no fix opened owes nothing',
  );
  assert.equal(roundCapStanding(null, review(2, 'ready_for_merge'), 2), 'reached');
  assert.equal(roundCapStanding(null, review(3, 'fixing'), 2), 'reached');
  // A round bl merge's integration review left open is owed whatever the cap (F-36 D7).
  assert.equal(roundCapStanding({ integrationReview: 3 }, review(3, 'fixing'), 2), 'closing');
  assert.equal(roundCapStanding({ integrationReview: 2 }, review(3, 'fixing'), 2), 'reached');
});

test('reviewEnd: open items below the cap point at bl run --resume', () => {
  assert.deepEqual(end(review(1, 'fixing')), {
    outcome: '1 open item (1 Must fix)',
    cap: '',
    next: 'bl run S-7 --resume',
  });
});

test('reviewEnd: open items in the round that reached the cap are owed a closing round', () => {
  for (const state of [null, { integrationReview: null }]) {
    assert.deepEqual(end(review(2, 'fixing'), { state }), {
      outcome: '1 open item (1 Must fix)',
      cap: CLOSING,
      next: 'bl run S-7 --resume',
    });
  }
});

test('reviewEnd: open items past what the cap allows need a higher cap', () => {
  assert.deepEqual(end(review(3, 'fixing')), {
    outcome: '1 open item (1 Must fix)',
    cap: ' The round cap (2) is reached.',
    next: 'bl run S-7 --resume --max-rounds 4',
  });
});

test('reviewEnd: an open integration round past the cap is still owed its closing round', () => {
  assert.deepEqual(end(review(3, 'fixing'), { state: { integrationReview: 3 } }), {
    outcome: '1 open item (1 Must fix)',
    cap: CLOSING,
    next: 'bl run S-7 --resume',
  });
});

test('reviewEnd: a ready_for_merge round points at bl merge, at the cap too', () => {
  for (const round of [1, 2, 3]) {
    assert.deepEqual(end(review(round, 'ready_for_merge'), { body: '' }), {
      outcome: 'nothing left to fix',
      cap: '',
      next: 'bl merge S-7',
    });
  }
});

test('reviewEnd: ready_for_merge with an open Must fix gives no merge command', () => {
  assert.deepEqual(end(review(1, 'ready_for_merge')), {
    outcome: 'ready_for_merge, but the latest Review Log session has 1 open Must fix/Should fix item',
    cap: '',
    // A review checks the boxes again; the table's implement row does not start from ready_for_merge.
    next: 'bl review S-7',
  });
});

test('reviewEnd: fixing with no open item at the cap adds no fix sentence', () => {
  const body = MUST_LOG.replace('[ ]', '[x]');
  assert.deepEqual(end(review(2, 'fixing'), { body }), {
    outcome: 'fixing, but the latest Review Log session has no open item',
    cap: ' The round cap (2) is reached.',
    next: 'bl run S-7 --resume',
  });
});

// The invariant: the end lines never claim what the latest session contradicts.
test('reviewEnd: no "nothing left to fix" or bl merge with an open Must/Should box, no "these items" with none', () => {
  const log = (box) => `## Review Log\n\n### Session 2026-11-09 (PR #1)\n\n${box}\n`;
  const bodies = {
    none: '',
    checked: log('**Must fix**\n\n- [x] one'),
    must: log('**Must fix**\n\n- [ ] one'),
    should: log('**Should fix**\n\n- [ ] one'),
    nit: log('**Nits**\n\n- [ ] one'),
    other: log('- [ ] one'),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const session = summarizeLatestReviewSession(body);
    for (const position of ['fixing', 'ready_for_merge']) {
      for (const round of [1, 2, 3]) {
        for (const state of [null, { integrationReview: 3 }]) {
          const r = end(review(round, position), { body, state });
          const at = `${name}, ${position}, round ${round}, state ${JSON.stringify(state)}`;
          if ((session?.blocking ?? 0) > 0) {
            assert.doesNotMatch(r.outcome, /nothing left to fix/, at);
            assert.notEqual(r.next, 'bl merge S-7', at);
          }
          if ((session?.unchecked ?? 0) === 0) assert.doesNotMatch(r.cap, /these items/, at);
        }
      }
    }
  }
});

test('reviewEnd: no verdict names the review position and no next command', () => {
  assert.deepEqual(end(review(1, 'in_review', true)), {
    outcome: 'no verdict recorded (in_review)',
    cap: '',
    next: null,
  });
  assert.deepEqual(end(review(0, null)), {
    outcome: 'no verdict recorded (never reviewed)',
    cap: '',
    next: null,
  });
});

test('reviewEnd: an escalation points at the unit index.md', () => {
  assert.deepEqual(end(review(1, 'fixing'), { escalated: true }), {
    outcome: 'escalated',
    cap: '',
    next: 'read ## Escalation in stories/S7-x/index.md',
  });
});

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
    // The log the run recorded (F-69 D3): the fixture's `status: running` as
    // a log, then each hop with its verb, capability and outcome.
    assert.equal(fm.status, undefined, 'the log replaces status:');
    assert.deepEqual(
      fm.transitions.slice(2).map((e) => [e.to, e.by, e.via ?? null]),
      [
        ['in_review', 'run', 'open_pr'],
        ['fixing', 'review', 'review'],
        ['in_review', 'fix', 'fix_self_review'],
        ['ready_for_merge', 'review', 'review'],
      ],
    );
    assert.ok(
      fm.transitions.slice(3).every((e) => e.outcome),
      'each session hop carries its outcome',
    );
    assert.equal(logStatusOf('feature', fm), 'ready_for_merge');
    assert.deepEqual(reviewOf('feature', fm), { round: 2, reviewed: 2, position: 'ready_for_merge', fixed: false });
    for (const k of ['branch', 'pr', 'review_round', 'review_status'])
      assert.equal(fm[k], undefined, `no ${k}: in index.md`);
    // The change document holds the PR and a line per gate run; the review
    // state is the log's (F-69 D5).
    const change = parseChange(readFileSync(CH(feature), 'utf8'));
    assert.equal(change.fm.change_of, 'F-1');
    assert.equal(change.fm.status, 'open');
    assert.deepEqual(Object.keys(change.fm).sort(), ['change_of', 'status']);
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
    assert.deepEqual(lastTitle(runner), {
      feature: 'F-1',
      story: '',
      status: 'clean',
      next: '→ bl merge',
      final: true,
    });
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

test('a feature run with no commits still opens its PR (S-1437 is for stories only)', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        shell: (cmd) => (cmd === 'git rev-list --count main..HEAD' ? { status: 0, output: '0\n' } : null),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(runner.calls.filter((c) => c.type === 'forge' && c.op === 'change.open').length, 1);
    assert.ok(
      runner.calls.some((c) => c.prompt === 'review-verify'),
      'the run reaches the review loop',
    );
    assert.ok(!state.history.some((h) => /no commits/.test(h.note ?? '')));
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
    assert.deepEqual(lastTitle(runner), {
      feature: 'F-1',
      story: '',
      status: 'escalated',
      next: '→ fix, --resume',
      final: true,
    });
    assert.match(state.lastError, /test gate failed twice/);
    assert.equal(runner.calls.filter((c) => c.prompt === 'feature-fix-tests').length, 1);
    assert.ok(!runner.calls.some((c) => c.type === 'forge'));
    const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.equal(logStatusOf('feature', fm), 'escalated');
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
    // No scope: this runner has no scope methods (F-70 D4).
    for (const o of opts) assert.deepEqual(o, { mergeStreams: true, scope: null });
  } finally {
    cleanup();
  }
});

test('a fix-tests session returning unrelated escalates after one gate run with its reason', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        fixTestsOutcome: () =>
          fixTestsOutcome('unrelated', 'dev certificate expired (CERT_HAS_EXPIRED on every client test)'),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'test gate failure is environmental (fix-tests: unrelated)');
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 1, 'the gate is not rerun');
    assert.ok(!runner.calls.some((c) => c.type === 'forge'), 'no PR');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation').trim();
    assert.match(
      esc,
      /^test gate failure is environmental \(fix-tests: unrelated\)\n\ndev certificate expired \(CERT_HAS_EXPIRED on every client test\)\n\nCommand: `npm test`/,
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

test("an unrelated session's escalation file becomes the Escalation, followed by its reason and the gate details", async () => {
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
        fixTestsOutcome: () => fixTestsOutcome('unrelated', 'dev certificate expired'),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation').trim();
    assert.ok(
      esc.startsWith(
        `test gate failure is environmental (fix-tests: unrelated)\n\n${explanation}\n\nfix-tests returned \`unrelated\`: dev certificate expired. The failed gate:\n\nCommand: \`npm test\``,
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
        fixTestsOutcome: () => fixTestsOutcome('unrelated', 'a flaky timeout'),
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

test('a fixed outcome reruns the gate, whatever the session text says', async () => {
  for (const [label, text] of [
    ['no text', ''],
    ['an old verdict line', 'UNRELATED: maybe the certificate'],
    ['an old RERUN line', 'RERUN: 20 passes'],
  ]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({
        dir,
        feature,
        testResults: [1, 0],
        behaviour: { output: (o) => (o.promptName === 'feature-fix-tests' ? text : '') },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', label);
      assert.equal(runner.calls.filter((c) => c.prompt === 'feature-fix-tests').length, 1, label);
      assert.ok(runner.calls.filter((c) => c.cmd === 'npm test').length >= 2, `${label}: gate rerun`);
      const fix = state.history.find((h) => h.step === 'fix-tests');
      assert.equal(fix.outcome, 'fix-tests: fixed', label);
      assert.equal(fix.note, 'outcome: fix-tests: fixed', label);
    } finally {
      cleanup();
    }
  }
});

test('a fix-tests session that ends with a verdict line and no outcome is no verdict: resumed once, then escalated', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1],
      behaviour: {
        output: (o) => (o.promptName === 'feature-fix-tests' ? 'Looked.\nUNRELATED: dev certificate expired\n' : ''),
        // A session that returns text, not the schema's object.
        fixTestsOutcome: () => 'UNRELATED: dev certificate expired',
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(runner.calls.filter((c) => c.prompt === 'feature-fix-tests').length, 2, 'resumed once');
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 1, 'the gate is not rerun');
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /^fix-tests: no valid outcome after one retry \(not JSON/);
    const failed = state.history.filter((h) => h.step === 'fix-tests' && h.ok === false);
    assert.equal(failed.length, 2);
    for (const h of failed) assert.match(h.note, /^outcome error: not JSON/);
  } finally {
    cleanup();
  }
});

test('a flaky unrelated is sent back to fix-tests once with a note, and a second unrelated escalates', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        fixTestsOutcome: () => fixTestsOutcome('unrelated', 'a flaky page.goto load timeout in debounce.int.test.js'),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    const fixes = runner.calls.filter((c) => c.prompt === 'feature-fix-tests');
    assert.equal(fixes.length, 2, 'sent back once, not more');
    assert.equal(fixes[0].vars.fixNote, '', 'the first session gets no note');
    assert.match(fixes[1].vars.fixNote, /returned `unrelated` with the reason "a flaky page\.goto load timeout/);
    assert.match(fixes[1].vars.fixNote, /is a bug to fix, not a reason to\nstop/);
    assert.equal(runner.calls.filter((c) => c.cmd === 'npm test').length, 1, 'the gate is not rerun in between');
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'test gate failure is environmental (fix-tests: unrelated)');
    assert.ok(
      state.history.some((h) => h.step === 'fix-tests' && /unrelated refused/.test(h.note ?? '')),
      'the pushback is in the history',
    );
  } finally {
    cleanup();
  }
});

test('a flaky unrelated sent back and then fixed reruns the gate and carries on', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let n = 0;
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 0],
      behaviour: {
        fixTestsOutcome: () =>
          ++n === 1
            ? fixTestsOutcome('unrelated', 'intermittent, not caused by this branch')
            : fixTestsOutcome('fixed', 'the race (S-9)'),
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(n, 2);
    assert.equal(state.status, 'clean');
  } finally {
    cleanup();
  }
});

test('rerun reruns the gate; when it fails again one more fix session gets it, then the cap escalates', async () => {
  for (const [label, results, expected, sessions] of [
    ['rerun passes', [1, 0], 'clean', 1],
    ['rerun fails, then fixed', [1, 1, 0], 'clean', 2],
    ['rerun fails, a second rerun counts as fixed', [1, 1, 1], 'escalated', 2],
  ]) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      const runner = fakeRunner({
        dir,
        feature,
        testResults: [...results],
        behaviour: { fixTestsOutcome: () => fixTestsOutcome('rerun', '20 passes at --workers=4') },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      const fixes = runner.calls.filter((c) => c.prompt === 'feature-fix-tests');
      assert.equal(state.status, expected, label);
      assert.equal(fixes.length, sessions, `${label}: fix sessions`);
      if (sessions > 1)
        assert.match(
          fixes[1].vars.fixNote,
          /returned `rerun` with the reason "20 passes at --workers=4", and the gate was\nrerun and failed/,
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

test('the fix-tests schema takes fixed, rerun and unrelated, each with a reason', () => {
  const schema = loadSchema('fix-tests');
  for (const outcome of ['fixed', 'rerun', 'unrelated']) {
    assert.equal(validateOutcome(schema, fixTestsOutcome(outcome, 'x')).structuredError, null, outcome);
  }
  for (const [label, value, fault] of [
    ['no reason', { summary: 's', outcome: 'unrelated' }, /at \$\/reason: must have required property 'reason'/],
    ['an empty reason', { summary: 's', outcome: 'rerun', reason: '' }, /at \$\/reason:/],
    ['an old keyword', { summary: 's', outcome: 'UNRELATED', reason: 'x' }, /at \$\/outcome:/],
    ['an extra field', { ...fixTestsOutcome(), said: 'FIXED' }, /at \$\/said:/],
  ]) {
    assert.match(validateOutcome(schema, value).structuredError, fault, label);
  }
});

test('the implement and merge-resolve schemas take a null blocked or reason, and refuse a multi-line one', () => {
  const implement = loadSchema('implement');
  const resolve = loadSchema('merge-resolve');
  assert.equal(validateOutcome(implement, { summary: 's', done: true, blocked: null }).structuredError, null);
  assert.equal(validateOutcome(implement, { summary: 's', done: false, blocked: 'no db' }).structuredError, null);
  assert.match(validateOutcome(implement, { summary: 's', done: true }).structuredError, /\$\/blocked/);
  assert.match(
    validateOutcome(implement, { summary: 's', done: false, blocked: 'a\nb' }).structuredError,
    /\$\/blocked/,
  );
  assert.equal(validateOutcome(resolve, { summary: 's', resolved: true, reason: null }).structuredError, null);
  assert.equal(validateOutcome(resolve, { summary: 's', resolved: false, reason: 'x' }).structuredError, null);
  assert.match(validateOutcome(resolve, { summary: 's', resolved: true }).structuredError, /\$\/reason/);
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
          editFile(CH(feature), (fm, body) => body.replaceAll('- [ ] invariant', '- [x] invariant'));
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
          return verifySession(CH(feature), { pending: true, round });
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
    // The log: three rounds reviewed, the closing round's items open, escalated (F-69 D5).
    const unitFm = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
    const { round: rounds, reviewed, position } = reviewOf('feature', unitFm);
    assert.deepEqual([rounds, reviewed, position], [3, 3, 'fixing']);
    assert.equal(logStatusOf('feature', unitFm), 'escalated');
    const change = parseFrontmatter(readFileSync(CH(feature), 'utf8'));
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
        // An outcome that counts no open item for a block that has three: the
        // merge gate's read of the block stops the run at finishClean.
        verify: () => {
          editFile(CH(feature), (fm, body) => {
            const block = `### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\n${must}\n\n**Should fix**\n\n${should}\n\n**Nits**\nNone.\n`;
            return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
          });
          return reviewOutcome();
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
          return verifySession(CH(feature), { pending: round < 3, round });
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

test('a verifier that writes the old review fields changes nothing bl decides: the log counts the rounds', async () => {
  // The review state is the unit's log (F-69 D5): a session that writes
  // `review_round` or `review_status` into the change document, as before F-68,
  // decides nothing. The cap still bounds the loop: two full rounds, then the
  // closing one.
  const edits = {
    addressed: (fm) => {
      fm.review_status = 'addressed';
    },
    'non-numeric round': (fm) => {
      fm.review_status = 'addressed';
      fm.review_round = 'r1';
    },
    'round 0': (fm) => {
      fm.review_round = '0';
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      let verifies = 0;
      const runner = fakeRunner({
        dir,
        feature,
        behaviour: {
          verify: () => {
            verifies += 1;
            editFile(CH(feature), edit);
            return verifySession(CH(feature), { pending: true, round: verifies });
          },
        },
      });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'escalated', name);
      assert.match(state.lastError, /the closing round after the review round cap \(2\) left open items/, name);
      assert.equal(verifies, 3, `${name}: two full rounds and the closing one`);
      const unitFm = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
      assert.equal(reviewOf('feature', unitFm).reviewed, 3, name);
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
              return verifySession(CH(feature), { pending: round === 1, round });
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
          // Every outcome counts no open Must or Should item, so bl writes
          // addressed; an open box the count missed is the merge gate's to catch.
          verify: () => {
            editFile(CH(feature), (fm, body) => {
              const block = `### Session 2026-09-24 (PR #7)\n\n**Must fix**\n\n${s.must}\n\n**Should fix**\n\n${s.should ?? 'None.'}\n\n**Nits**\n\n${s.nits}\n`;
              return body.replace(/(## Review Log\n\n)(No reviews yet\.\n)?/, `$1${block}\n`);
            });
            return reviewOutcome();
          },
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
          verify: () => verifySession(CH(feature), { pending: false, round: 2 }),
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

test('a refined story with no acceptance checkboxes is implemented, not skipped', async () => {
  const prose = (b) => b.replace(/## Acceptance Criteria[\s\S]*$/, '## Acceptance Criteria\n\nIt works.\n');
  const plain = (b) => b.replaceAll('- [ ] ', '- ');
  const checked = (b) => b.replaceAll('- [ ]', '- [x]');
  // [status, the criteria, skipped as complete]
  const cases = [
    ['refined', prose, false],
    ['draft', plain, false],
    ['refined', checked, true],
    ['in_progress', prose, true],
  ];
  for (const [status, reshape, skipped] of cases) {
    const name = `${status}, ${reshape.name} criteria`;
    const { dir, cleanup, config, feature, prep } = setup();
    try {
      for (const s of prep.ordered) {
        editFile(join(dir, s.storyRelPath), (fm, body) => {
          fm.status = status;
          return reshape(body);
        });
      }
      const runner = fakeRunner({ dir, feature });
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      const sessions = runner.calls.filter((c) => c.prompt === 'feature-story');
      assert.equal(sessions.length === 0, skipped, `${name}: ${sessions.length} session(s)`);
      const skips = state.history.filter((h) => /already complete/.test(h.note ?? ''));
      assert.equal(skips.length > 0, skipped, name);
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
      assert.equal(logStatusOf('feature', fm), 'escalated', name);
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
    // The run's start, each story's start, each gate line, the PR record and
    // the hop to in_review, the verdict's hop to fixing and the fix's back to
    // in_review, and the escalation. The change document holds no review
    // field to commit (F-69 D5).
    assert.deepEqual(failed.map((h) => h.step).sort(), [
      'escalate',
      'fix-self-review',
      'implement',
      'implement',
      'pr',
      'pr',
      'review',
      'setup',
      'test',
      'test',
      'test',
    ]);
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
          return verifySession(CH(feature), { pending: round === 1, round });
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
    assert.deepEqual(first, {
      status: 'fixing',
      round: 1,
      verdict: true,
      escalated: false,
      error: null,
      end: PENDING_END,
    });
    assert.deepEqual(
      runner.calls.filter((c) => c.type === 'session').map((c) => c.prompt),
      ['review-correctness', 'review-failure-paths', 'review-verify'],
    );
    const saved = loadRunState(config, 'F-1');
    assert.equal(saved.status, 'reviewed');
    assert.equal(saved.reviewBaseSha, 'sha0', 'a later re-review narrows from this base');
    assert.ok(!existsSync(runLockPath(config, 'F-1')), 'lock released');

    // After a fix (`in_review` by `fix` in the log, F-69 D5), the re-review
    // narrows to the files the fix changed.
    await transition(dir, { kind: 'feature', indexPath: feature.indexPath }, 'in_review', { by: 'fix' });
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
    assert.equal(logStatusOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm), 'escalated');
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

test('an implement retry that returns blocked names it at the end of the escalation', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature, behaviour: { story: () => {} } });
    const session = runner.session;
    runner.session = (o) => {
      const r = session(o);
      if (o.promptName !== 'feature-story') return r;
      return { ...r, structured: { summary: 'stopped', done: false, blocked: 'the database is not reachable' } };
    };
    const state = await runFeature({ feature, config, prep, runner });
    assert.equal(state.status, 'escalated');
    assert.match(state.lastError, /S-1 acceptance criteria unmet after two sessions/);
    const esc = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation').trim();
    assert.match(esc, /\n\nThe agent was blocked: the database is not reachable$/);
  } finally {
    cleanup();
  }
});

test('a first self-review that returns ok: false escalates before the review', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: { selfReview: () => ({ summary: 'S-1 misses its main case', ok: false, changed: false }) },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'escalated');
    assert.equal(state.lastError, 'the self-review found the branch not ready for review: S-1 misses its main case');
    assert.ok(!runner.calls.some((c) => c.prompt?.startsWith('review-')), 'no review session ran');
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
    const againRunner = fakeRunner({ dir, feature });
    const again = await runFeature({ feature, config, prep, runner: againRunner, opts: { resume: true } });
    assert.equal(again.status, 'failed');
    assert.match(again.lastError, /Escalation is not empty/);
    assert.deepEqual(lastTitle(againRunner), { feature: 'F-1', story: '', status: 'failed', next: '', final: true });
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
          return verifySession(CH(feature), { pending: true, round });
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
      behaviour: { verify: () => verifySession(CH(feature), { pending: false, round: 4 }) },
    });
    // The first run spent two full rounds and the closing round (round 3).
    // Another full round needs the cap raised explicitly.
    assert.equal(reviewOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm).reviewed, 3);
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
  // At the cap: items in fixing are fixed then verified, fixed items are
  // verified; ready_for_merge, and a round no fix opened, have nothing owed.
  // Past the cap (the closing round done): nothing runs. Each state is a log
  // (F-69 D5); `rounds` reviewed rounds, each with open items, then `end`.
  const reviewed = (rounds, end) => [
    { to: 'in_progress', by: 'run' },
    ...Array.from({ length: rounds }, (_, i) => [
      { to: 'in_review', by: i === 0 ? 'run' : 'fix' },
      { to: 'fixing', by: 'review', via: 'review' },
    ]).flat(),
    ...end,
  ];
  const cases = [
    { round: '2', status: 'fixing', log: reviewed(2, []), fixes: 1, verifies: 1 },
    { round: '2', status: 'fixed', log: reviewed(2, [{ to: 'in_review', by: 'fix' }]), fixes: 0, verifies: 1 },
    {
      round: '2',
      status: 'ready_for_merge',
      log: reviewed(1, [
        { to: 'in_review', by: 'fix' },
        { to: 'ready_for_merge', by: 'review' },
      ]),
      fixes: 0,
      verifies: 0,
    },
    {
      round: '2',
      status: 'in_review, no fix',
      log: reviewed(1, [
        { to: 'in_review', by: 'fix' },
        { to: 'ready_for_merge', by: 'review' },
        { to: 'in_review', by: 'review' },
      ]),
      fixes: 0,
      verifies: 0,
    },
    { round: '3', status: 'fixing', log: reviewed(3, []), fixes: 0, verifies: 0 },
    { round: '3', status: 'fixed', log: reviewed(3, [{ to: 'in_review', by: 'fix' }]), fixes: 0, verifies: 0 },
  ];
  for (const c of cases) {
    for (const resume of [false, true]) {
      const { dir, cleanup, config, feature, prep } = setup({
        status: undefined,
        transitions: [{ to: 'draft', by: 'new' }, { to: 'approved', by: 'operator' }, ...c.log],
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
          behaviour: { verify: () => verifySession(CH(feature), { pending: false, round: Number(c.round) + 1 }) },
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
        if (c.status === 'ready_for_merge' && resume) {
          // Signed off on the code this run already published: nothing left to review.
          assert.equal(state.status, 'clean', label);
          continue;
        }
        const unitFm = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
        assert.equal(reviewOf('feature', unitFm).reviewed, Number(c.round), label);
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
    assert.match(verify.note, /^outcome: open items$/, "the outcome's summary is recorded");
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
