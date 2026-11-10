import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { resolveFeatureStories, orderStoriesByDeps, extractSection } from '../../src/feature.js';
import {
  runFeature,
  loadRunState,
  saveRunState,
  newRunState,
  runStatePath,
  runLockPath,
  reviewFeature,
  RUN_DIR,
  localTime,
  hasHeadlessConfiguration,
  defaultRunner,
} from '../../src/feature-run.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { cmdStatusStory } from '../../src/feature-cmd.js';
import { accumulateTokensOnFile } from '../../src/tokens.js';
import {
  PENDING_END,
  setup,
  editFile,
  checkAll,
  fakeRunner,
  lastTitle,
  statusOf,
  STORY_BODY,
  storySetup,
  captureLog,
  F41_LIMIT,
  spendLimit,
} from '../helpers/feature-run-fixture.js';
import { reviewOf, statusOf as logStatusOf } from '../../src/transition.js';
import { claudeCapacity } from '../../src/agents/claude.js';
import { codexCapacity } from '../../src/agents/codex.js';

// ---------------------------------------------------------------------------
// An agent usage limit: wait it out and rerun the step (S-835)
// ---------------------------------------------------------------------------

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

test('the usage-limit wait awaits runner.sleep: no session starts while a sleep is pending (F-105 A2)', async () => {
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
    // Each slice advances the fake clock on a later turn of the event loop.
    let pending = false;
    const sleep = runner.sleep;
    runner.sleep = (ms) => {
      pending = true;
      return new Promise((resolve) =>
        setImmediate(() => {
          sleep(ms);
          pending = false;
          resolve();
        }),
      );
    };
    let startedWhilePending = 0;
    const session = runner.session;
    runner.session = (o) => {
      if (pending) startedWhilePending += 1;
      return session(o);
    };
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(0, 4)));
    assert.equal(state.history.filter((h) => h.step === 'waiting').length, 1);
    assert.ok(runner.calls.filter((c) => c.type === 'sleep').length > 0, 'the wait slept');
    assert.equal(startedWhilePending, 0, 'no session started while a sleep was pending');
  } finally {
    cleanup();
  }
});

test('defaultRunner().sleep returns a promise that resolves after the timer', async () => {
  const start = performance.now();
  const p = defaultRunner().sleep(30);
  assert.ok(p instanceof Promise);
  await p;
  assert.ok(performance.now() - start >= 25, 'it waited for the timer');
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
    assert.deepEqual(result, {
      status: 'fixing',
      round: 1,
      verdict: true,
      escalated: false,
      error: null,
      end: PENDING_END,
    });
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
    assert.equal(
      reviewOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm).reviewed,
      1,
      'one round spent',
    );
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
    assert.deepEqual(result, {
      status: 'fixing',
      round: 1,
      verdict: true,
      escalated: false,
      error: null,
      end: PENDING_END,
    });
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
    assert.equal(
      reviewOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm).reviewed,
      1,
      'one round spent',
    );
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
    assert.deepEqual(lastTitle(runner), {
      feature: 'F-1',
      story: '',
      status: 'escalated',
      next: '→ fix, bl review',
      final: true,
    });
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
    assert.equal(logStatusOf('feature', fm), 'escalated');
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
    assert.deepEqual(result, {
      status: 'fixing',
      round: 1,
      verdict: true,
      escalated: false,
      error: null,
      end: PENDING_END,
    });
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
    assert.equal(
      reviewOf('feature', parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm).reviewed,
      1,
      'one round spent',
    );
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

test("a story run's unit is its one story, so storyAsOrdered carries the story's effort (F-85 D4)", () => {
  for (const [effort, want] of [
    ['low', 'low'],
    [undefined, null],
  ]) {
    const { cleanup, prep } = storySetup({ effort });
    try {
      assert.equal(prep.ordered[0].effort, want);
    } finally {
      cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Effort per step (F-85 D4): picked once per step, before the walk.
// ---------------------------------------------------------------------------

/** `setup` with S-1 and S-2 at `levels` (null: unset), the walk's MODELS and review effort `xhigh`. */
function effortSetup(levels) {
  const fx = setup({}, { ...MODELS, effort: { refine: 'high', review: 'xhigh', default: 'high' } });
  for (const s of fx.prep.ordered) {
    editFile(s.indexPath, (fm) => {
      if (levels[s.id]) fm.effort = levels[s.id];
      else delete fm.effort;
    });
  }
  fx.prep.ordered = orderStoriesByDeps(resolveFeatureStories(fx.feature, fx.config, readAllStories(fx.config)).stories);
  return fx;
}

const effortsOf = (calls, prompt) =>
  calls.filter((c) => c.type === 'session' && c.prompt === prompt).map((c) => c.effort);

test("each step runs at its story's level or the unit's highest, reviews at effort.review, and the walk keeps it", async () => {
  const { dir, cleanup, config, feature, prep } = effortSetup({ 'S-1': 'low', 'S-2': 'medium' });
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
      s1.map((c) => [c.model, c.effort]),
      [
        ['opus', 'low'],
        ['sonnet', 'low'],
      ],
      'the walk to the next configuration keeps the level',
    );
    assert.deepEqual(effortsOf(runner.calls, 'feature-story'), ['low', 'low', 'medium']);
    for (const prompt of ['feature-self-review', 'feature-workon-review', 'feature-fix-self-review']) {
      const got = effortsOf(runner.calls, prompt);
      assert.ok(got.length > 0 && got.every((e) => e === 'medium'), `${prompt}: ${JSON.stringify(got)}`);
    }
    const reviews = runner.calls.filter((c) => c.type === 'session' && c.mode === 'review').map((c) => c.effort);
    assert.ok(reviews.length > 0 && reviews.every((e) => e === 'xhigh'), JSON.stringify(reviews));
    // Every session event in the run state carries the level it ran at.
    const sessions = loadRunState(config, 'F-1').history.filter((h) => 'agent' in h && h.step !== 'unavailable');
    assert.ok(sessions.length > 0 && sessions.every((h) => typeof h.effort === 'string'), JSON.stringify(sessions));
    assert.deepEqual(
      sessions.filter((h) => h.step === 'implement').map((h) => h.effort),
      ['low', 'medium'],
    );
  } finally {
    cleanup();
  }
});

test('a story with no effort: counts as effort.default, and bl review runs its passes at effort.review', async () => {
  const { dir, cleanup, config, feature, prep } = effortSetup({ 'S-1': 'low' });
  try {
    const runner = fakeRunner({ dir, feature });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(effortsOf(runner.calls, 'feature-story'), ['low', 'high']);
    assert.deepEqual(effortsOf(runner.calls, 'feature-self-review'), ['high']);
  } finally {
    cleanup();
  }
  const fx = effortSetup({ 'S-1': 'low', 'S-2': 'low' });
  try {
    const runner = fakeRunner({ dir: fx.dir, feature: fx.feature });
    const { config: c, feature: f, prep: p } = fx;
    await reviewFeature({ feature: f, config: c, prep: p, runner, pr: { number: '7', url: 'u' }, maxRounds: 2 });
    // Two passes and the verifier.
    assert.deepEqual(
      runner.calls.filter((x) => x.type === 'session').map((x) => x.effort),
      ['xhigh', 'xhigh', 'xhigh'],
    );
  } finally {
    fx.cleanup();
  }
});

test('run_refreshes_existing_story_effort_before_retry_and_unit_steps', async () => {
  // A session changes a held story's effort: and adds no story. Every later
  // session takes the new level: the same-story retry, a later story's
  // session and the unit-level steps.
  const { dir, cleanup, config, feature, prep } = effortSetup({ 'S-1': 'low', 'S-2': 'low' });
  try {
    const path = (id) => prep.ordered.find((s) => s.id === id).indexPath;
    let first = true;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        story: (o) => {
          if (o.vars.storyId === 'S-1' && first) {
            // Leaves its criteria open, so S-1 gets a retry, and raises S-1.
            first = false;
            editFile(path('S-1'), (fm) => void (fm.effort = 'max'));
            return;
          }
          // S-2's session lowers S-2's level below S-1's new one.
          if (o.vars.storyId === 'S-2') editFile(path('S-2'), (fm) => void (fm.effort = 'medium'));
          checkAll(o.vars.storyAbsPath);
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean', JSON.stringify(state.history.slice(-3)));
    assert.deepEqual(
      runner.calls.filter((c) => c.prompt === 'feature-story').map((c) => [c.story, c.effort]),
      [
        ['S-1', 'low'],
        ['S-1', 'max'],
        ['S-2', 'low'],
      ],
    );
    for (const prompt of ['feature-self-review', 'feature-workon-review']) {
      const got = effortsOf(runner.calls, prompt);
      assert.ok(got.length > 0 && got.every((e) => e === 'max'), `${prompt}: ${JSON.stringify(got)}`);
    }
  } finally {
    cleanup();
  }
  // A story run (refreshRepos skips it): its retry takes the level its first session set.
  const fx = storySetup({ effort: 'low', body: STORY_BODY });
  try {
    let first = true;
    const runner = fakeRunner({
      dir: fx.config.backlogRoot,
      feature: fx.unit,
      behaviour: {
        story: (o) => {
          if (first) {
            first = false;
            editFile(fx.unit.indexPath, (fm) => void (fm.effort = 'xhigh'));
            return;
          }
          checkAll(o.vars.storyAbsPath);
        },
      },
    });
    await runFeature({ feature: fx.unit, config: fx.config, prep: fx.prep, runner, opts: { maxRounds: 2 } });
    assert.deepEqual(effortsOf(runner.calls, 'story-run'), ['low', 'xhigh']);
    assert.deepEqual(effortsOf(runner.calls, 'feature-self-review'), ['xhigh']);
  } finally {
    fx.cleanup();
  }
});

test('run_stops_when_story_effort_cannot_be_read', async () => {
  // A session leaves a story file missing or unparseable. The next session
  // must not start at the level the run held before: the run stops.
  const breaks = {
    missing: (path) => unlinkSync(path),
    'malformed YAML': (path) => writeFileSync(path, '---\neffort: [\n---\n' + STORY_BODY),
  };
  // [the session that breaks a file, the story whose file it breaks, the session next]
  const cases = [
    ['S-1', 'S-1', 'the S-1 retry'],
    ['S-1', 'S-2', 'the S-2 session'],
    ['S-2', 'S-1', 'the unit self-review'],
  ];
  for (const [how, breakFile] of Object.entries(breaks)) {
    for (const [by, target, next] of cases) {
      const label = `${how} ${target}, before ${next}`;
      const { dir, cleanup, config, feature, prep } = effortSetup({ 'S-1': 'low', 'S-2': 'low' });
      try {
        const path = prep.ordered.find((s) => s.id === target).indexPath;
        const runner = fakeRunner({
          dir,
          feature,
          behaviour: {
            story: (o) => {
              if (by !== target) checkAll(o.vars.storyAbsPath);
              if (o.vars.storyId === by) breakFile(path);
            },
          },
        });
        let stopped;
        try {
          stopped = (await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } })).status;
        } catch (e) {
          stopped = e.message;
        }
        // Escalated by refreshRepos, or thrown by the first read that fails.
        assert.match(stopped, /^escalated$|ENOENT/, label);
        const sessions = runner.calls.filter((c) => c.type === 'session').map((c) => c.story);
        assert.deepEqual(sessions, by === 'S-1' ? ['S-1'] : ['S-1', 'S-2'], `${label}: no session after the break`);
      } finally {
        cleanup();
      }
    }
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
    const topLevels = [];
    const resetsAt = new Date(runner.clock() + 3 * 3_600_000);
    runner.capacity = (agent, model, topLevel) => {
      asked.push(`${agent} ${model}`);
      topLevels.push(topLevel);
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
    assert.ok(
      topLevels.every((top) => top === config.topLevel),
      "every ask gets the run config's top level (local reads its server there)",
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

test('an unavailable Claude reading from claudeCapacity() keeps the walk off that configuration until its reset (S-1143)', async () => {
  // A used-up session window applies to every model: the walk waits for its reset, then runs opus.
  {
    const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
    try {
      const runner = fakeRunner({ dir, feature });
      const reset = runner.clock() + 30 * 60_000;
      const body = () => ({
        limits: [
          {
            kind: 'session',
            percent: runner.clock() < reset ? 100 : 10,
            resets_at: new Date(reset).toISOString(),
            scope: null,
          },
        ],
      });
      runner.capacity = (agent, model) => claudeCapacity(body(), model);
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', JSON.stringify(state.history.filter((h) => !h.ok)));
      const waits = state.history.filter((h) => h.step === 'waiting');
      assert.equal(waits.length, 1);
      assert.equal(waits[0].until, new Date(reset + 60_000).toISOString(), 'resetsAt + 60 s');
      const firstStory = runner.calls.findIndex((c) => c.prompt === 'feature-story');
      const firstSleep = runner.calls.findIndex((c) => c.type === 'sleep');
      assert.ok(firstSleep >= 0 && firstSleep < firstStory, 'no feature-story spawn before the wait');
      assert.equal(runner.calls[firstStory].model, 'opus');
    } finally {
      cleanup();
    }
  }
  // A used-up limit scoped to Opus takes only opus out: sonnet runs, and nothing waits.
  {
    const { dir, cleanup, config, feature, prep } = setup({}, MODELS);
    try {
      const runner = fakeRunner({ dir, feature });
      const body = {
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 100,
            resets_at: new Date(runner.clock() + 2 * 86_400_000).toISOString(),
            scope: { model: { id: null, display_name: 'Opus' }, surface: null },
          },
        ],
      };
      runner.capacity = (agent, model) => claudeCapacity(body, model);
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', JSON.stringify(state.history.filter((h) => !h.ok)));
      const stories = configsOf(runner.calls, (c) => c.prompt === 'feature-story');
      assert.ok(stories.length > 0);
      assert.ok(
        stories.every((c) => c === 'claude sonnet'),
        stories.join(', '),
      );
      assert.equal(state.history.filter((h) => h.step === 'waiting').length, 0);
    } finally {
      cleanup();
    }
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

test('an unavailable reading whose until has passed is unknown: the configuration is spawned, and nothing waits (S-1444)', async () => {
  const claudeAt = (offsetMs) => (runner) => {
    const body = {
      limits: [
        { kind: 'session', percent: 100, resets_at: new Date(runner.clock() + offsetMs).toISOString(), scope: null },
      ],
    };
    return (agent, model) => claudeCapacity(body, model);
  };
  const cases = [
    { label: 'claude, 10 minutes past', models: MODELS, first: 'claude opus', read: claudeAt(-600_000) },
    { label: 'claude, exactly now', models: MODELS, first: 'claude opus', read: claudeAt(0) },
    {
      label: 'codex, 30 seconds past',
      models: {
        agent: [
          { agent: 'codex', model: 'gpt-6-sol' },
          { agent: 'claude', model: 'sonnet' },
        ],
      },
      first: 'codex gpt-6-sol',
      read: (runner) => {
        const result = {
          rateLimits: {
            primary: {
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: Math.floor((runner.clock() - 30_000) / 1000),
            },
          },
        };
        return (agent) =>
          agent === 'codex'
            ? codexCapacity(result)
            : { state: 'available', scope: 'model', until: null, windows: [], message: '' };
      },
    },
  ];
  for (const { label, models, first, read } of cases) {
    const { dir, cleanup, config, feature, prep } = setup({}, models);
    try {
      const runner = fakeRunner({ dir, feature });
      runner.capacity = read(runner);
      const logs = [];
      runner.log = (m) => logs.push(m);
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      assert.equal(state.status, 'clean', `${label}: ${JSON.stringify(state.history.filter((h) => !h.ok))}`);
      assert.equal(configsOf(runner.calls, (c) => c.prompt === 'feature-story')[0], first, label);
      assert.equal(state.history.filter((h) => h.step === 'waiting' || h.step === 'unavailable').length, 0, label);
      assert.deepEqual(loadRunState(config, 'F-1').unavailable ?? [], [], label);
      assert.ok(!logs.some((l) => l.includes('is unavailable')), `${label}: ${logs.join('\n')}`);
    } finally {
      cleanup();
    }
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
