import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  readSessionStackFragment,
  renderSessionStack,
  sessionStackFragmentIn,
  sessionStackOf,
} from '../../src/session-stack.js';
import { mkTempDir } from '../helpers/tempdir.js';

test('sessionStackOf: none configured is no guide and no grants', () => {
  assert.deepEqual(sessionStackOf({}, '/b'), { guideDir: null, allow: [] });
  assert.deepEqual(sessionStackOf({ session_stack: { guide: 'agents/stack', allow: [' x:* '] } }, '/b'), {
    guideDir: '/b/agents/stack',
    allow: ['x:*'],
  });
});

test('sessionStackOf: a malformed session_stack throws naming the key', () => {
  for (const [value, says] of [
    ['agents', /must be an object/],
    [{ guide: '/abs' }, /"guide" must be a directory relative to the backlog/],
    [{ guide: '' }, /"guide" must be a directory/],
    [{ allow: 'x:*' }, /"allow" must be a list of tool tokens/],
    [{ allow: [''] }, /"allow" must be a list/],
    [{ prompts: 'x' }, /unknown key "prompts"/],
  ]) {
    assert.throws(() => sessionStackOf({ session_stack: value }, '/b'), says, JSON.stringify(value));
  }
});

test("the guide's fragments: the first name that exists, rendered with the vars; missing is empty", () => {
  const dir = mkTempDir('bl-session-stack-');
  mkdirSync(join(dir, 'stack'));
  writeFileSync(join(dir, 'stack', 'default.md'), 'Session {{sessionNum}} for {{storyId}}.\n\n');
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ session_stack: { guide: 'stack' } }));
  const config = { backlogRoot: dir, topLevel: { session_stack: { guide: 'stack' } } };
  assert.equal(
    renderSessionStack(config, ['workon', 'default'], { sessionNum: 7, storyId: 'S-1' }),
    'Session 7 for S-1.',
  );
  // A '$' pattern in a value is text, not a replacement pattern.
  assert.equal(renderSessionStack(config, ['default'], { sessionNum: '$&', storyId: "$'" }), "Session $& for $'.");
  assert.equal(readSessionStackFragment(config, ['tool-guide']), '');
  assert.equal(readSessionStackFragment({ backlogRoot: dir, topLevel: {} }, ['default']), '');
  assert.equal(renderSessionStack(null, ['default'], {}), '');
  assert.equal(sessionStackFragmentIn(dir, 'default'), 'Session {{sessionNum}} for {{storyId}}.\n\n');
  // The hook's reader never throws: no backlog.json, or a broken one, is no guide.
  assert.equal(sessionStackFragmentIn(join(dir, 'nowhere'), 'default'), '');
  writeFileSync(join(dir, 'backlog.json'), '{');
  assert.equal(sessionStackFragmentIn(dir, 'default'), '');
});
