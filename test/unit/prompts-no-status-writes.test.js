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

/**
 * Prompts that still ask for a review field, each with the story that removes
 * the request. S-1125 empties this list; a prompt that no longer matches must
 * leave it.
 */
const PENDING = {
  'review-verify.md': 'S-1125: the loop writes review_round and review_status from the verdict',
  'workon-review.md': 'S-1125: the loop writes review_status from the fix outcome',
  'feature-workon-review.md': 'S-1125: the loop writes review_status from the fix outcome',
};

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
  const found = prompts.filter((f) => !(f in PENDING)).flatMap(offending);
  assert.deepEqual(found, [], `prompts that ask for a field bl writes:\n${found.join('\n')}`);
});

test('every pending prompt still asks for a review field, so the list shrinks as S-1125 lands', () => {
  for (const name of Object.keys(PENDING)) {
    assert.ok(prompts.includes(name), `${name} is not a prompt`);
    assert.notDeepEqual(offending(name), [], `${name} no longer asks for a review field: remove it from PENDING`);
  }
});

test('the guard catches a refine status instruction', () => {
  assert.ok(FORBIDDEN.some((re) => re.test('9. When you are finished, set `status: refined` in the frontmatter.')));
  assert.ok(!FORBIDDEN.some((re) => re.test('2. Set `status: in_progress` in the story frontmatter.')));
});
