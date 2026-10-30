import assert from 'node:assert/strict';
import { test } from 'node:test';

import { todoForTriage } from '../../src/cleanup.js';

// The merge's triage agent turns `## To Do` items into stories and removes
// them. Since F-65 D4 the section holds `[points: N]` follow-up work only, so
// the agent gets it whole: nothing is filtered out.

test('a To Do is triaged whole, up to the next section', () => {
  const story =
    '# S-1 · A story\n\n## To Do\n\n- [points: 2] split the parser\n- [points: 1] name the flag\n\n' +
    '## Notes\n\n- 2026-10-26 (S-1): kept\n';
  const todo = todoForTriage(story);
  assert.match(todo, /split the parser/);
  assert.match(todo, /name the flag/);
  assert.doesNotMatch(todo, /kept/);
});

test('a CRLF To Do reads like an LF one; a story with none has nothing', () => {
  assert.equal(todoForTriage('## To Do\r\n\r\n- [points: 1] a thing\r\n').trim(), '- [points: 1] a thing');
  assert.equal(todoForTriage('# S-1\n\n## Summary\n\nx\n'), '');
});
