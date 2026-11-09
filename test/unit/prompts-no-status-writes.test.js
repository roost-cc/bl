/**
 * No prompt asks an agent to write a field that bl decides on (F-68 D3): the
 * refine outcome sets `status: refined` and `status: draft`, and the review
 * loop's outcomes set `review_status` and `review_round`. A prompt that names
 * one of them as `field: value` or `field:` is an instruction to write it.
 *
 * Nor does a prompt ask for a verdict line (F-68 D4): the implement,
 * fix-tests and merge-resolve sessions return outcome objects, so `DONE S-n`,
 * `ESCALATED`, `RESOLVED`, `FIXED`, `UNRELATED: …` and `RERUN: …` are gone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

const FORBIDDEN = [
  /status: refined/,
  /status: draft/,
  /review_status:/,
  /review_round:/,
  /\bUNRELATED\b/,
  /\bRERUN\b/,
  /`FIXED`/,
  /`(DONE|ESCALATED|RESOLVED)\b/,
];

function offending(name) {
  const text = readFileSync(join(PROMPTS, name), 'utf8');
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => FORBIDDEN.some((re) => re.test(line)))
    .map(({ line, n }) => `${name}:${n}: ${line.trim()}`);
}

const prompts = readdirSync(PROMPTS).filter((f) => f.endsWith('.md'));

test('no prompt instructs an agent to write a field bl writes or to end with a verdict line', () => {
  const found = prompts.flatMap(offending);
  assert.deepEqual(found, [], `prompts that ask for a field bl writes or a verdict line:\n${found.join('\n')}`);
});

test('the guard catches a refine status instruction', () => {
  assert.ok(FORBIDDEN.some((re) => re.test('9. When you are finished, set `status: refined` in the frontmatter.')));
  assert.ok(!FORBIDDEN.some((re) => re.test('2. Set `status: in_progress` in the story frontmatter.')));
});

test('the guard catches a review field instruction', () => {
  for (const line of [
    '5. When every item is checked off, set `review_status: fixed` in the YAML frontmatter.',
    '   - `review_round: {{nextRound}}`',
  ]) {
    assert.ok(
      FORBIDDEN.some((re) => re.test(line)),
      line,
    );
  }
});

test('the guard catches a verdict-line closing instruction, and not the outcome values', () => {
  for (const line of [
    '  - `FIXED`: you committed a fix. `bl run` reruns the gate.',
    '  - `RERUN: <what you tried>`: the failure would not reproduce after a real attempt.',
    '  - `UNRELATED: <reason>`: use it only when nothing in the repos can make the gate pass.',
    '   attempt, end with `RERUN: <what you tried>`. Never end with `UNRELATED` for it.',
    '- End your response with one line: `DONE {{storyId}}` when every criterion is checked, or',
    '  `ESCALATED {{storyId}}` if you wrote an Escalation.',
    '- End your response with one line: `RESOLVED` when every merge is committed and the tree is',
  ]) {
    assert.ok(
      FORBIDDEN.some((re) => re.test(line)),
      line,
    );
  }
  for (const line of [
    '- `fixed`: you committed a fix. `bl run` reruns the gate.',
    '  `unrelated` stops the run and escalates with your reason, without rerunning the gate.',
    '- End with the outcome object that **Outcome** above describes.',
    '- End your response with one line: `FINDINGS WRITTEN {{findingsPath}}`.',
  ]) {
    assert.ok(!FORBIDDEN.some((re) => re.test(line)), line);
  }
});
