import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt } from '../../src/session.js';

// S-1165: a `bl agent` session stays on the conversation and delegates
// high-output work to sub-agents, in words that suit every provider.

const VARS = { backlogDir: '/bl', roostDir: '/roost' };
const PROVIDERS = ['claude', 'codex', 'gemini', 'local'];

/** @param {string} agent */
function prose(agent) {
  return loadPrompt('agent', VARS, { agent, config: null }).replace(/\s+/g, ' ');
}

test('the agent prompt says what to delegate, do inline and keep', () => {
  const text = prose('claude');
  assert.match(
    text,
    /\*\*Delegate\*\* implementation, test runs, broad searches across many files, long research and loops of `bl` commands, when only the conclusion matters/,
  );
  assert.match(
    text,
    /\*\*Do inline\*\* a lookup with a known target or a handful of tool calls: reading one file, running `bl status`, creating a story/,
  );
  assert.match(text, /\*\*Keep for yourself\*\* the decisions, the trade-offs and the conversation itself/);
});

test('the agent prompt says how to brief a sub-agent and to check its report', () => {
  const text = prose('claude');
  assert.match(text, /\*\*Brief\*\* each sub-agent with the goal, what is settled and what is out of scope/);
  assert.match(text, /Describe the intent, not the mechanism\. Do not hand it a hypothesis to confirm/);
  assert.match(
    text,
    /if it meets a decision that is the operator's, it stops and returns the open question with what it found\. It does not decide\. Bring the question to the operator/,
  );
  assert.match(
    text,
    /\*\*Do not relay blindly\.\*\* When a sub-agent finishes, tell the operator its outcome in a few lines: what it did or found, and any question it returned\. A sub-agent's report is a claim/,
  );
});

test('the code-change rule is unchanged and holds for a sub-agent', () => {
  const text = prose('claude');
  assert.match(text, /Without an explicit request and a branch, make no code edits\./);
  assert.match(text, /The same rule holds when you give code work to a sub-agent: it works only on that branch/);
});

test('the delegation rule reads the same for every provider and names no tool', () => {
  const texts = PROVIDERS.map(prose);
  for (const text of texts) {
    assert.match(text, /If you cannot, follow the same split yourself/);
    assert.doesNotMatch(text, /\b(Task|Agent) tool\b|spawn_agent|\{\{/);
  }
  assert.equal(new Set(texts).size, 1);
});
