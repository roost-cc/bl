/**
 * S-1378: an integration test that builds a runner from `defaultRunner()`
 * runs session code in-process, so it must not reach the operator's real
 * agent account (`test/helpers/fake-agent.js` states the rule). It defines
 * `capacity` on its runner, puts `noAgentEnv()` / `withNoAgent()` into its
 * env, or is in ALLOWED with the reason it starts no real agent. A plain
 * text search per file; it does not check which runner a key belongs to.
 * The helpers in `test/helpers/` are searched too: the fixtures of a split
 * integration test file (F-99 D2) hold runners its parts use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, join, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'test/integration');
const HELPERS = join(ROOT, 'test/helpers');

const CALLS = /\bdefaultRunner\(/;
// A property `capacity: …` or a method `capacity(…) {` at the start of a line;
// a call such as `runner.capacity(` does not match.
const CAPACITY = /^\s*capacity\s*[:(]/m;
const NO_AGENT = /\b(noAgentEnv|withNoAgent)\(/;

const ALLOWED = new Map([
  ['secondary-worktrees.test.js', 'replaces `ClaudeProvider.prototype.spawn` and never asks for capacity'],
  ['repo-guard.test.js', 'uses the runner for git only and starts no session'],
  ['process-scope.test.js', "uses the runner's testGate only and starts no session"],
]);

/** @param {string} text */
function unguarded(text) {
  return CALLS.test(text) && !CAPACITY.test(text) && !NO_AGENT.test(text);
}

test('every integration test that calls defaultRunner() has an agent guard', () => {
  const files = [
    ...readdirSync(DIR)
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => join(DIR, f)),
    ...readdirSync(HELPERS)
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(HELPERS, f)),
  ];
  const failing = files
    .filter((p) => !ALLOWED.has(basename(p)) && unguarded(readFileSync(p, 'utf8')))
    .map((p) => relative(ROOT, p));
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

test('an import is not a call, and a call to runner.capacity() is not a guard', () => {
  assert.equal(unguarded("import { defaultRunner } from '../../src/feature-run.js';\n"), false);
  assert.equal(unguarded('const r = defaultRunner({ interactive: true });\n'), true);
  assert.equal(unguarded('const r = defaultRunner();\nawait r.capacity({});\n'), true);
  assert.equal(unguarded('const r = { ...defaultRunner(),\n  capacity() { return {}; } };\n'), false);
});
