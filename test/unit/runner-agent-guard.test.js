/**
 * S-1378: an integration test that builds a runner from `defaultRunner()`
 * runs session code in-process, so it must not reach the operator's real
 * agent account (`test/helpers/fake-agent.js` states the rule). It defines
 * `capacity` on its runner, puts `noAgentEnv()` / `withNoAgent()` into its
 * env, or is in ALLOWED with the reason it starts no real agent. A plain
 * text search per file; it does not check which runner a key belongs to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'test/integration');

const CALLS = /\bdefaultRunner\(/;
// A property `capacity: …` or a method `capacity(…) {` at the start of a line;
// a call such as `runner.capacity(` does not match.
const CAPACITY = /^\s*capacity\s*[:(]/m;
const NO_AGENT = /\b(noAgentEnv|withNoAgent)\(/;

const ALLOWED = new Map([
  ['secondary-worktrees.test.js', 'replaces `ClaudeProvider.prototype.spawn` and never asks for capacity'],
  ['repo-guard.test.js', 'uses the runner for git only and starts no session'],
]);

/** @param {string} text */
function unguarded(text) {
  return CALLS.test(text) && !CAPACITY.test(text) && !NO_AGENT.test(text);
}

test('every integration test that calls defaultRunner() has an agent guard', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.test.js'));
  const failing = files.filter((f) => !ALLOWED.has(f) && unguarded(readFileSync(join(DIR, f), 'utf8')));
  assert.deepEqual(
    failing,
    [],
    `${failing.join(', ')} call defaultRunner() with no agent guard: define \`capacity\` on the runner, ` +
      'put `noAgentEnv()` / `withNoAgent()` into the env, or add the file to ALLOWED with a reason',
  );
});

test('every ALLOWED entry names an integration test that calls defaultRunner()', () => {
  for (const f of ALLOWED.keys()) {
    const path = join(DIR, f);
    assert.ok(existsSync(path), `ALLOWED names ${f}, which is not in test/integration/`);
    assert.match(readFileSync(path, 'utf8'), CALLS, `ALLOWED names ${f}, which no longer calls defaultRunner()`);
  }
});

test('a runner without its capacity stub is reported', () => {
  const text = readFileSync(join(DIR, 'review.test.js'), 'utf8');
  assert.equal(unguarded(text), false);
  assert.equal(unguarded(text.replace(/^\s*capacity\s*:.*\n/gm, '')), true);
});
