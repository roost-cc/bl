/**
 * No prompt asks an agent to write a field that bl decides on (F-68 D3): the
 * refine outcome sets `status: refined` and `status: draft`, and the review
 * loop's outcomes set `review_status` and `review_round`. A prompt that names
 * one of them as `field: value` or `field:` is an instruction to write it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

const FORBIDDEN = [/status: refined/, /status: draft/, /review_status:/, /review_round:/];

function offending(name) {
  const text = readFileSync(join(PROMPTS, name), 'utf8');
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => FORBIDDEN.some((re) => re.test(line)))
    .map(({ line, n }) => `${name}:${n}: ${line.trim()}`);
}

const prompts = readdirSync(PROMPTS).filter((f) => f.endsWith('.md'));

test('no prompt instructs an agent to write status: refined, status: draft, review_status: or review_round:', () => {
  const found = prompts.flatMap(offending);
  assert.deepEqual(found, [], `prompts that ask for a field bl writes:\n${found.join('\n')}`);
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
