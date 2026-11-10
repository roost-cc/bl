// The loop's outcome rule (F-68 D5): a step with a schema whose session
// returns no valid outcome is a failed event, resumed once with a fixed note,
// and escalated on the second failure. Nothing reads an outcome from text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { loadConfig } from '../../src/config.js';
import { findFeature, normalizeFeatureId, extractSection } from '../../src/feature.js';
import { defaultRunner, runSession, newRunState, OutcomeError, OUTCOME_RETRY_NOTE } from '../../src/feature-run.js';
import { ClaudeProvider } from '../../src/agents/claude.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, done: { type: 'boolean' } },
  required: ['summary', 'done'],
  additionalProperties: false,
};
const VALID = { structured: { summary: 'implemented S-1', done: true }, structuredError: null };
const INVALID = { structured: null, structuredError: 'not JSON: Unexpected token' };

/**
 * A run context on F-1 whose fake runner answers each session with the next
 * of `results` (merged over a successful session with id `sess-<n>`).
 */
function setup(results) {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../demo-repo'],
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1'], branch: 'f1' }],
  });
  const config = loadConfig({ backlogRoot: dir });
  const feature = findFeature(normalizeFeatureId('F-1'), config);
  const worktreePath = mkTempDir('bl-wt-');
  const calls = [];
  const runner = {
    session(o) {
      calls.push(o);
      const n = calls.length;
      return {
        ok: true,
        output: '',
        isError: false,
        usage: null,
        sessionId: `sess-${n}`,
        ...results[n - 1],
      };
    },
    shell: () => ({ status: 0, output: '' }),
    notify() {},
    log() {},
  };
  const prep = {
    cfg: config,
    parsed: { id: 'F-1', num: '1' },
    worktreePath,
    branchName: 'f1',
    ordered: [],
    baseVars: { featureId: 'F-1', storyId: 'F-1', worktreePath, backlogDir: dir },
  };
  const state = newRunState(feature, { branch: 'f1', worktreePath, maxRounds: 2 });
  const ctx = { feature, config, prep, runner, state };
  const step = (extra = {}) =>
    runSession(ctx, {
      step: 'implement',
      mode: 'workon',
      promptName: 'feature-story',
      vars: {},
      label: 'F-1',
      ...extra,
    });
  return { ctx, calls, step, cleanup, feature };
}

test('a valid outcome is returned and recorded as outcome: <summary>', () => {
  const { ctx, calls, step, cleanup } = setup([VALID]);
  try {
    const r = step({ schema: SCHEMA });
    assert.deepEqual(r.structured, VALID.structured);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].schema, SCHEMA);
    assert.equal(calls[0].retry, undefined);
    const [h] = ctx.state.history;
    assert.equal(h.ok, true);
    assert.equal(h.note, 'outcome: implemented S-1');
  } finally {
    cleanup();
  }
});

test('no valid outcome: a failed event with the fault, then the same session resumed once with the note', () => {
  const { ctx, calls, step, cleanup } = setup([{ ...INVALID, output: '{"summary": DONE' }, VALID]);
  try {
    const r = step({ schema: SCHEMA });
    assert.deepEqual(r.structured, VALID.structured);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].retry, { sessionId: 'sess-1', note: OUTCOME_RETRY_NOTE });
    assert.equal(calls[1].agent, calls[0].agent, 'the same configuration');
    assert.deepEqual(
      ctx.state.history.map((h) => [h.step, h.ok, h.note]),
      [
        ['implement', false, 'outcome error: not JSON: Unexpected token'],
        ['implement', true, 'outcome: implemented S-1'],
      ],
    );
    assert.equal(ctx.state.status, 'running');
  } finally {
    cleanup();
  }
});

test('a session that ran but returned no outcome at all is a fault too, whatever its text says', () => {
  const { ctx, calls, step, cleanup } = setup([{ structured: null, structuredError: null, output: 'DONE S-1' }, VALID]);
  try {
    step({ schema: SCHEMA });
    assert.equal(calls.length, 2);
    assert.equal(ctx.state.history[0].note, 'outcome error: no output');
  } finally {
    cleanup();
  }
});

test('a second failure escalates with the fault and the last 20 lines of text', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const { ctx, calls, step, cleanup, feature } = setup([INVALID, { ...INVALID, output: `${text}\n` }]);
  try {
    assert.throws(() => step({ schema: SCHEMA }), OutcomeError);
    assert.equal(calls.length, 2, 'retried once, not twice');
    assert.equal(ctx.state.status, 'escalated');
    assert.deepEqual(
      ctx.state.history.map((h) => h.ok),
      [false, false],
    );
    const escalation = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.match(escalation, /implement: no valid outcome after one retry \(not JSON: Unexpected token\)/);
    assert.match(escalation, /line 11\nline 12/);
    assert.match(escalation, /line 30/);
    assert.doesNotMatch(escalation, /line 10\n/);
    assert.doesNotMatch(escalation, /stderr/, 'no stderr, no stderr block');
  } finally {
    cleanup();
  }
});

test("an escalation after a CLI failure names the exit and shows the CLI's stderr (S-1398)", () => {
  const failed = {
    structured: null,
    structuredError: 'claude exited 1: Error: bad flag',
    stderrTail: 'warn\nError: bad flag',
    output: '',
  };
  const { step, cleanup, feature } = setup([failed, failed]);
  try {
    assert.throws(() => step({ schema: SCHEMA }), OutcomeError);
    const escalation = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.match(escalation, /implement: no valid outcome after one retry \(claude exited 1: Error: bad flag\)/);
    assert.match(escalation, /The last 20 non-empty lines of the CLI's stderr:\n\n```text\nwarn\nError: bad flag\n```/);
  } finally {
    cleanup();
  }
});

test('defaultRunner().session returns the headless stderrTail', () => {
  const { spawn } = ClaudeProvider.prototype;
  const { dir, cleanup } = mkTempBacklog();
  const failed = {
    status: 1,
    output: '',
    isError: true,
    structured: null,
    structuredError: 'claude exited 1: Error: bad flag',
    stderrTail: 'warn\nError: bad flag',
  };
  try {
    const config = loadConfig({ backlogRoot: dir });
    const session = (ret) => {
      ClaudeProvider.prototype.spawn = () => ret;
      return defaultRunner().session({
        mode: 'workon',
        agent: 'claude',
        promptName: 'feature-self-review',
        vars: {},
        worktreePath: mkTempDir('bl-wt-'),
        config,
        parsed: { id: 'F-1' },
        label: 'F-1: T',
        schema: SCHEMA,
      });
    };
    const r = session(failed);
    assert.equal(r.stderrTail, 'warn\nError: bad flag');
    assert.equal(r.structuredError, 'claude exited 1: Error: bad flag');
    const { stderrTail, ...without } = failed;
    assert.equal(session(without).stderrTail, '', 'an adapter result without stderrTail gives none');
  } finally {
    ClaudeProvider.prototype.spawn = spawn;
    cleanup();
  }
});

test('escalateNoOutcome keeps a backtick-fenced stderr tail inside its block', () => {
  const cases = [
    {
      name: 'stderr tail',
      stderrTail: '````\nfoo\n````',
      output: '',
      heading: "The last 20 non-empty lines of the CLI's stderr:",
    },
    {
      name: 'session text',
      stderrTail: '',
      output: '````\nfoo\n````\n',
      heading: 'The last 20 lines of the session text:',
    },
  ];
  for (const c of cases) {
    const failed = { structured: null, structuredError: 'claude exited 1', stderrTail: c.stderrTail, output: c.output };
    const { step, cleanup, feature } = setup([failed, failed]);
    try {
      assert.throws(() => step({ schema: SCHEMA }), OutcomeError);
      const escalation = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
      const block = escalation.slice(escalation.indexOf(c.heading));
      assert.match(block, /\n\n`````text\n````\nfoo\n````\n`````\n/, c.name);
    } finally {
      cleanup();
    }
  }
});

test('a step without a schema reads no outcome, records none of its text, and is never retried', () => {
  const { ctx, calls, step, cleanup } = setup([
    { structured: null, structuredError: null, output: 'all done\nDONE S-1\n' },
  ]);
  try {
    const r = step();
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].schema, undefined);
    const [h] = ctx.state.history;
    assert.equal(h.note, '');
    assert.equal(h.outcome, undefined);
  } finally {
    cleanup();
  }
});

test('a story step records its story and its outcome summary beside the note', () => {
  const { ctx, step, cleanup } = setup([VALID]);
  try {
    step({ schema: SCHEMA, story: 'S-1' });
    const [h] = ctx.state.history;
    assert.equal(h.story, 'S-1');
    assert.equal(h.outcome, 'implemented S-1');
    assert.equal(h.note, 'outcome: implemented S-1');
  } finally {
    cleanup();
  }
});
