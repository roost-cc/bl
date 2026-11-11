/**
 * Since F-104 the session lock is a kernel lock whose file stays after every
 * session (D3), in the backlog's `.bl/lock/` since S-1495, and a launch
 * refuses a lock another live process holds. No instruction an agent or the operator reads may say that
 * the file's existence means a session runs, or that a held lock only warns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
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
  assert.match(guide, /The lock file stays in the backlog's `\.bl\/lock\/` after every\s+session/);
});

/** A file's text with each line break, and the comment marks after it, made one space. */
const prose = (path) => readFileSync(path, 'utf8').replace(/\s*\n\s*(?:\*(?!\*)|\/\/)?\s*/g, ' ');

/** Tenet 12 in app.roost.cc, beside bl in the workstation and in a unit directory. */
const TENETS = join(ROOT, '../app.roost.cc/docs/public/tenets.md');

test('tenet_12_documents_legacy_lock_migration: the lock rule names the one-off migration that deletes retired lock files', (t) => {
  // Every text that states the rule: no blanket "no code deletes a lock file",
  // and the exception named.
  const rules = [
    ['src/AGENTS.md', /one-off migration below, which deletes retired lock files/],
    ['src/kernel-lock.js', /one-off S-1495 migration \(`migrate-lock-files\.js`\): it deletes retired lock files/],
  ].map(([file, exception]) => [join(ROOT, file), exception]);
  if (existsSync(TENETS)) rules.push([TENETS, /A one-off migration may delete a retired lock file/]);
  else t.diagnostic(`${TENETS} is not here; tenet 12 is not checked`);
  for (const [path, exception] of rules) {
    const text = prose(path);
    assert.ok(!/\bno code deletes (?:a |the )(?:lock )?file\b(?! that)/i.test(text), `${path}: a blanket rule`);
    assert.ok(exception.test(text), `${path}: the migration is not named`);
  }
  // The migration's own texts: it cannot see a PID-file lock of a `bl` from before F-104.
  for (const file of ['src/migrate-lock-files.js', 'scripts/migrate-lock-files.js', 'src/AGENTS.md']) {
    const text = prose(join(ROOT, file));
    assert.ok(!text.includes('a `bl` from before S-1495 that still runs'), `${file}: promises to skip an old bl`);
    assert.ok(/`bl` from before F-104 holds its locks as PID files/.test(text), `${file}: no PID-file caveat`);
  }
});
