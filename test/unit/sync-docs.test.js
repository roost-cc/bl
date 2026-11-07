/**
 * Since F-79 `bl sync` pulls, commits the named paths and pushes; it writes no
 * index or table (bl renders those when a page is read). No instruction an
 * agent or the operator reads may say otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The instructions: every command and prompt, the agent guide, and the help text in src/. */
const FILES = [
  ...readdirSync(join(ROOT, 'commands')).map((f) => `commands/${f}`),
  ...readdirSync(join(ROOT, 'prompts')).map((f) => `prompts/${f}`),
  'src/AGENTS.md',
  ...readdirSync(join(ROOT, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/${f}`),
].filter((f) => f.endsWith('.md') || f.endsWith('.js'));

/** Each stale claim that sync writes derived lists, by the words that made it. */
const STALE = [
  ['a post-create sync', /post-create[^\n]*sync/i],
  ['a sync pass', /\bsync pass\b/i],
  ['paths the sync wrote', /\bthe sync wrote\b/i],
  ["bl sync's tables", /`bl sync`'s [^.\n]*tables/],
  ['--no-sync keeps off the index files', /off the index files/i],
  [
    'bl sync writes an index or table',
    /bl sync`?[^.\n]*\b(?:writes|rewrites|regenerates|updates) (?:the |its |every )?(?:index|indexes|indices|tables?)\b/i,
  ],
];

test('sync_docs_name_only_pull_commit_and_push: no instruction says bl sync writes an index or table', () => {
  const found = [];
  for (const file of FILES) {
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const [claim, re] of STALE) if (re.test(line)) found.push(`${file}:${i + 1} (${claim}): ${line.trim()}`);
      });
  }
  assert.deepEqual(found, []);
});
