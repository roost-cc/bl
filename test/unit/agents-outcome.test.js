// The provider carriers of the outcome contract (F-68 D1): each adapter's
// argument construction and result parsing, with fake CLI outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { ClaudeProvider, buildClaudeArgs, parseClaudeJsonResult } from '../../src/agents/claude.js';
import { CodexProvider, buildCodexArgs, parseCodexJsonEvents } from '../../src/agents/codex.js';
import { GeminiProvider } from '../../src/agents/gemini.js';

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, done: { type: 'boolean' } },
  required: ['summary', 'done'],
  additionalProperties: false,
};
const VALID = { summary: 'implemented S-1', done: true };

// What the fake CLIs print as their final message, and the outcome each must give.
const CASES = [
  ['valid', VALID, { structured: VALID, structuredError: null }],
  [
    'extra property',
    { ...VALID, verdict: 'DONE' },
    { structured: null, structuredError: 'schema violation at $/verdict: must NOT have additional properties' },
  ],
  ['not JSON', 'DONE S-1', null],
  ['empty', '', { structured: null, structuredError: 'no output' }],
];

function assertOutcome(r, expected, name) {
  if (expected) {
    assert.deepEqual({ structured: r.structured, structuredError: r.structuredError }, expected, name);
  } else {
    assert.equal(r.structured, null, name);
    assert.match(r.structuredError, /^not JSON: /, name);
  }
}

// --- claude ---

test('buildClaudeArgs passes --json-schema with the schema as JSON, headless only', () => {
  const args = buildClaudeArgs({ prompt: 'p', headless: true, schema: SCHEMA });
  const i = args.indexOf('--json-schema');
  assert.ok(i > 0);
  assert.deepEqual(JSON.parse(args[i + 1]), SCHEMA);
  assert.ok(i < args.indexOf('--'), 'before the prompt');
  assert.equal(buildClaudeArgs({ prompt: 'p', headless: true }).includes('--json-schema'), false);
});

test('buildClaudeArgs resumes a headless session by id (the outcome retry)', () => {
  const args = buildClaudeArgs({ prompt: 'note', headless: true, sessionId: 'abc' });
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--resume', 'abc']);
  assert.equal(buildClaudeArgs({ prompt: 'p', headless: true }).includes('--resume'), false);
});

test('parseClaudeJsonResult validates structured_output against the schema', () => {
  // claude sets structured_output to the object (or omits it); `result` holds it as text.
  for (const [name, message, expected] of CASES) {
    const obj = { type: 'result', subtype: 'success', result: JSON.stringify(message), session_id: 's' };
    if (message !== '') obj.structured_output = message;
    assertOutcome(parseClaudeJsonResult(JSON.stringify(obj), SCHEMA), expected, name);
  }
  // `result` text is never read as the outcome.
  const textOnly = { type: 'result', result: JSON.stringify(VALID) };
  assert.equal(parseClaudeJsonResult(JSON.stringify(textOnly), SCHEMA).structuredError, 'no output');
  assert.equal(parseClaudeJsonResult('claude crashed', SCHEMA).structuredError, 'no output');
  assert.deepEqual(
    (({ structured, structuredError }) => ({ structured, structuredError }))(
      parseClaudeJsonResult(JSON.stringify({ type: 'result', result: 'x', structured_output: VALID })),
    ),
    { structured: null, structuredError: null },
    'no schema, no outcome',
  );
});

test('ClaudeProvider.spawn headless passes the schema and returns the outcome', () => {
  let argv;
  const r = new ClaudeProvider().spawn({
    prompt: 'p',
    worktreePath: '/wt',
    headless: true,
    schema: SCHEMA,
    run: (_cmd, args) => {
      argv = args;
      return { status: 0, stdout: JSON.stringify({ type: 'result', result: '', structured_output: VALID }) };
    },
  });
  assert.ok(argv.includes('--json-schema'));
  assert.deepEqual(r.structured, VALID);
  assert.equal(r.structuredError, null);
});

// --- codex ---

test('buildCodexArgs passes --output-schema beside --output-last-message, and resumes by id', () => {
  const args = buildCodexArgs({ prompt: 'p', headless: true, outputFile: '/t/m.md', schemaFile: '/t/m.schema.json' });
  assert.equal(args[args.indexOf('--output-schema') + 1], '/t/m.schema.json');
  assert.equal(args.at(-1), 'p');
  const resumed = buildCodexArgs({ prompt: 'note', headless: true, outputFile: '/t/m.md', sessionId: 'th-1' });
  assert.deepEqual(resumed.slice(-3), ['resume', 'th-1', 'note']);
  assert.ok(resumed.indexOf('--output-last-message') < resumed.indexOf('resume'), 'exec options before the subcommand');
  assert.equal(buildCodexArgs({ prompt: 'p', headless: true }).includes('--output-schema'), false);
});

test('parseCodexJsonEvents reads the thread id the resume takes', () => {
  const events = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th-9' }),
    JSON.stringify({ type: 'turn.completed' }),
  ];
  assert.equal(parseCodexJsonEvents(events.join('\n')).sessionId, 'th-9');
  assert.equal(parseCodexJsonEvents('').sessionId, null);
});

/** CodexProvider.spawn headless whose fake `codex` writes `message` to the last-message file. */
function codexSpawn(message, { schema = SCHEMA } = {}) {
  const seen = {};
  const r = new CodexProvider().spawn({
    prompt: 'p',
    worktreePath: '/wt',
    backlogRoot: '/bl',
    headless: true,
    schema,
    ensureApprovedCommandPrefixes: () => ({ added: 0 }),
    run: (_cmd, args) => {
      const out = args[args.indexOf('--output-last-message') + 1];
      const i = args.indexOf('--output-schema');
      seen.schemaFile = i < 0 ? null : args[i + 1];
      seen.schema = i < 0 ? null : JSON.parse(readFileSync(seen.schemaFile, 'utf8'));
      seen.out = out;
      writeFileSync(out, typeof message === 'string' ? message : JSON.stringify(message));
      return { status: 0, stdout: JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }) };
    },
  });
  return { r, seen };
}

test('CodexProvider.spawn writes the schema file, parses the last message, and removes both files', () => {
  for (const [name, message, expected] of CASES) {
    const { r, seen } = codexSpawn(message);
    assertOutcome(r, expected, name);
    assert.deepEqual(seen.schema, SCHEMA, name);
    assert.equal(seen.schemaFile.replace(/\.schema\.json$/, '.md'), seen.out, `${name}: beside the last message`);
    assert.equal(existsSync(seen.schemaFile), false, `${name}: schema file removed`);
    assert.equal(existsSync(seen.out), false, `${name}: last message removed`);
    assert.equal(r.sessionId, 'th-1');
  }
  const { r, seen } = codexSpawn(VALID, { schema: null });
  assert.equal(seen.schemaFile, null);
  assert.deepEqual([r.structured, r.structuredError], [null, null]);
});

// --- gemini ---

test('GeminiProvider.spawn with a schema runs nothing and names the fault', () => {
  let ran = false;
  const r = new GeminiProvider().spawn({
    prompt: 'p',
    worktreePath: '/wt',
    headless: true,
    schema: SCHEMA,
    run: () => {
      ran = true;
      return { status: 0 };
    },
  });
  assert.equal(ran, false);
  assert.equal(r.isError, true);
  assert.equal(r.structured, null);
  assert.equal(r.structuredError, 'provider has no structured output');
});
