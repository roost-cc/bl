import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAllowedPatterns, existingPatternSet } from '../../src/allow.js';

test('collectAllowedPatterns merges allowed-tools sections without duplicates', () => {
  assert.deepEqual(
    collectAllowedPatterns({
      base: ['git:*', 'npm:*'],
      workon: ['gh pr:*', 'git:*'],
      review: ['gh pr:*'],
      extra: ['bl:*'],
    }),
    ['git:*', 'npm:*', 'gh pr:*', 'bl:*'],
  );
});

test('existingPatternSet treats a resolved templated leader as already granted', () => {
  const toolDefs = {
    base: ['git:*', '{{roostDir}}/tools/bin/prettier:*'],
    workon: ['gh pr:*'],
    extra: [],
  };
  const withRoost = existingPatternSet(toolDefs, ['my-tool:*', '{{roostDir}}/bin/hand:*'], {
    roostDir: '/home/x/roost',
  });
  // The suggestion `bl allow` derives from the permission log is the
  // absolute path the agent ran; it must not be re-suggested.
  assert.ok(withRoost.has('/home/x/roost/tools/bin/prettier:*'));
  // The committed (templated) pattern stays recognised as well.
  assert.ok(withRoost.has('{{roostDir}}/tools/bin/prettier:*'));
  assert.ok(withRoost.has('git:*'));
  assert.ok(withRoost.has('gh pr:*'));
  assert.ok(withRoost.has('my-tool:*'));
  // A templated local extra is granted resolved too (`getAllowedTools`
  // resolves local extras), so its absolute form is already granted.
  assert.ok(withRoost.has('{{roostDir}}/bin/hand:*'));
  assert.ok(withRoost.has('/home/x/roost/bin/hand:*'));
  assert.ok(!withRoost.has('/other/tools/bin/prettier:*'));

  const without = existingPatternSet(toolDefs, []);
  assert.ok(without.has('{{roostDir}}/tools/bin/prettier:*'));
  assert.ok(!without.has('/home/x/roost/tools/bin/prettier:*'));
  assert.ok(![...without].some((p) => p.startsWith('/')));
});
