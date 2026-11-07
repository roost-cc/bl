import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deferredForTriage } from '../../src/cleanup.js';

// The merge's triage agent turns `## Deferred` items into stories and removes
// them. Since F-65 D4 the section holds `[points: N]` follow-up work only, so
// the agent gets it whole: nothing is filtered out.

test('a Deferred section is triaged whole, up to the next section', () => {
  const story =
    '# S-1 · A story\n\n## Deferred\n\n- [points: 2] split the parser\n- [points: 1] name the flag\n\n' +
    '## Notes\n\n- 2026-10-26 (S-1): kept\n';
  const todo = deferredForTriage(story);
  assert.match(todo, /split the parser/);
  assert.match(todo, /name the flag/);
  assert.doesNotMatch(todo, /kept/);
});

test('a CRLF Deferred section reads like an LF one; a story with none has nothing', () => {
  assert.equal(deferredForTriage('## Deferred\r\n\r\n- [points: 1] a thing\r\n').trim(), '- [points: 1] a thing');
  assert.equal(deferredForTriage('# S-1\n\n## Summary\n\nx\n'), '');
});
