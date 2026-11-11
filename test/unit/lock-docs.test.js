/**
 * Since F-104 the session lock `.workon.lock` is a kernel lock whose file
 * stays after every session (D3), and a launch refuses a lock another live
 * process holds. No instruction an agent or the operator reads may say that
 * the file's existence means a session runs, or that a held lock only warns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The instructions: every command guide and prompt, and the agent guide. */
const FILES = [
  ...readdirSync(join(ROOT, 'commands')).map((f) => `commands/${f}`),
  ...readdirSync(join(ROOT, 'prompts')).map((f) => `prompts/${f}`),
  'src/AGENTS.md',
].filter((f) => f.endsWith('.md'));

/** Each stale claim about the session lock, by the words that made it. */
const STALE = [
  ['a lock file that exists means a session', /\ba lock file exists\b/i],
  ['the lock file is written only while a session runs', /lock file[^.\n]*while the session is running/i],
  ['a held session lock only warns', /\bwarns? (?:if|when)[^.\n]*\block\b/i],
];

test('bl_implement_guide_matches_session_guard: no guide describes the PID-file session lock', () => {
  const found = [];
  for (const file of FILES) {
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const [claim, re] of STALE) if (re.test(line)) found.push(`${file}:${i + 1} (${claim}): ${line.trim()}`);
      });
  }
  assert.deepEqual(found, []);
  const guide = readFileSync(join(ROOT, 'commands/bl-implement.md'), 'utf8');
  assert.match(guide, /\*\*Concurrent sessions\*\*: refuses the launch while another live process holds/);
  assert.match(guide, /`\.workon\.lock` stays after every session/);
});
