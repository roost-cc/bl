// The loop's outcome rule (F-68 D5): a step with a schema whose session
// returns no valid outcome is a failed event, resumed once with a fixed note,
// and escalated on the second failure. Nothing reads an outcome from text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { loadConfig } from '../../src/config.js';
import { findFeature, normalizeFeatureId, extractSection } from '../../src/feature.js';
import {
  defaultRunner,
  runSession,
  newRunState,
  OutcomeError,
  OUTCOME_RETRY_NOTE,
  sessionError,
} from '../../src/feature-run.js';
import { ClaudeProvider } from '../../src/agents/claude.js';
import { withExitFault } from '../../src/outcome.js';
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
  const titles = [];
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
    title(fields, opts) {
      titles.push({ ...fields, final: opts?.final ?? false });
    },
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
  return { ctx, calls, titles, step, cleanup, feature };
}

test('a valid outcome is returned and recorded as outcome: <summary>', async () => {
  const { ctx, calls, step, cleanup } = setup([VALID]);
  try {
    const r = await step({ schema: SCHEMA });
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

test('no valid outcome: a failed event with the fault, then the same session resumed once with the note', async () => {
  const { ctx, calls, step, cleanup } = setup([{ ...INVALID, output: '{"summary": DONE' }, VALID]);
  try {
    const r = await step({ schema: SCHEMA });
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

test('a session that ran but returned no outcome at all is a fault too, whatever its text says', async () => {
  const { ctx, calls, step, cleanup } = setup([{ structured: null, structuredError: null, output: 'DONE S-1' }, VALID]);
  try {
    await step({ schema: SCHEMA });
    assert.equal(calls.length, 2);
    assert.equal(ctx.state.history[0].note, 'outcome error: no output');
  } finally {
    cleanup();
  }
});

test('a second failure escalates with the fault and the last 20 lines of text', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const { ctx, calls, titles, step, cleanup, feature } = setup([INVALID, { ...INVALID, output: `${text}\n` }]);
  try {
    await assert.rejects(step({ schema: SCHEMA }), OutcomeError);
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
    // No resumeHint in this context: the title falls back to bl run's --resume.
    assert.deepEqual(titles.at(-1), {
      feature: 'F-1',
      story: '',
      status: 'escalated',
      next: '→ fix, --resume',
      final: true,
    });
  } finally {
    cleanup();
  }
});

test("an escalation after a CLI failure names the exit and shows the CLI's stderr (S-1398)", async () => {
  const failed = {
    structured: null,
    structuredError: 'claude exited 1: Error: bad flag',
    stderrTail: 'warn\nError: bad flag',
    output: '',
  };
  const { step, cleanup, feature } = setup([failed, failed]);
  try {
    await assert.rejects(step({ schema: SCHEMA }), OutcomeError);
    const escalation = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.match(escalation, /implement: no valid outcome after one retry \(claude exited 1: Error: bad flag\)/);
    assert.match(escalation, /The last 20 non-empty lines of the CLI's stderr:\n\n```text\nwarn\nError: bad flag\n```/);
  } finally {
    cleanup();
  }
});

test('defaultRunner().shell takes a commit message built from a fault of NUL stderr (S-1398)', () => {
  const none = { structured: null, structuredError: 'no output' };
  const fault = withExitFault(none, 'claude', 1, 'Error: bad\0flag\n').structuredError;
  const dir = mkTempDir('bl-shell-');
  assert.equal(defaultRunner().shell(`echo 'chore: S-1 escalated — ${fault}'`, dir).status, 0);
});

test('defaultRunner().session returns the headless stderrTail', async () => {
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
    const r = await session(failed);
    assert.equal(r.stderrTail, 'warn\nError: bad flag');
    assert.equal(r.structuredError, 'claude exited 1: Error: bad flag');
    const { stderrTail, ...without } = failed;
    assert.equal((await session(without)).stderrTail, '', 'an adapter result without stderrTail gives none');
  } finally {
    ClaudeProvider.prototype.spawn = spawn;
    cleanup();
  }
});

test('escalateNoOutcome keeps a backtick-fenced stderr tail inside its block', async () => {
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
      await assert.rejects(step({ schema: SCHEMA }), OutcomeError);
      const escalation = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
      const block = escalation.slice(escalation.indexOf(c.heading));
      assert.match(block, /\n\n`````text\n````\nfoo\n````\n`````\n/, c.name);
    } finally {
      cleanup();
    }
  }
});

test('escalateNoOutcome removes control characters from the session text (S-1405)', async () => {
  const failed = {
    structured: null,
    structuredError: 'claude exited 1',
    output: 'first\n\u0000\u001b[31mred\u001b[0m\u0007 words\n',
  };
  const { step, cleanup, feature } = setup([failed, failed]);
  try {
    await assert.rejects(step({ schema: SCHEMA }), OutcomeError);
    const escalation = extractSection(readFileSync(feature.indexPath, 'utf8'), 'Escalation');
    assert.match(escalation, /\nfirst\nred words\n/);
    // LF stays: the section has many lines.
    assert.doesNotMatch(escalation, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  } finally {
    cleanup();
  }
});

test("sessionError cleans the session text's last line, and keeps bl's own error as is (S-1405)", () => {
  assert.equal(sessionError({ output: 'x\n\u0000\u001b[31mboom\u001b[0m\u0007' }), 'boom');
  assert.equal(sessionError({ output: '\u0000\u0007\n' }), 'agent reported an error');
  assert.equal(sessionError({ output: '' }), 'agent reported an error');
  assert.equal(sessionError({ error: 'spawn claude ENOENT', output: 'x' }), 'spawn claude ENOENT');
});

test('a step without a schema reads no outcome, records none of its text, and is never retried', async () => {
  const { ctx, calls, step, cleanup } = setup([
    { structured: null, structuredError: null, output: 'all done\nDONE S-1\n' },
  ]);
  try {
    const r = await step();
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

test("a session's history entry carries its usage when the result has one, and no usage key when not (F-87 D3b)", async () => {
  const usage = { input: 10, output: 20, cache_creation: 30, cache_read: 40 };
  const { ctx, step, cleanup } = setup([{ usage }, {}]);
  try {
    await step();
    await step();
    const [withUsage, without] = ctx.state.history;
    assert.deepEqual(withUsage.usage, usage);
    assert.ok(!('usage' in without), 'a session without usage writes no usage key');
    assert.deepEqual(ctx.state.usage, usage, "the run state's totals still add it");
  } finally {
    cleanup();
  }
});

test('a story step records its story and its outcome summary beside the note', async () => {
  const { ctx, step, cleanup } = setup([VALID]);
  try {
    await step({ schema: SCHEMA, story: 'S-1' });
    const [h] = ctx.state.history;
    assert.equal(h.story, 'S-1');
    assert.equal(h.outcome, 'implemented S-1');
    assert.equal(h.note, 'outcome: implemented S-1');
  } finally {
    cleanup();
  }
});
