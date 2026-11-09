import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'fs';
import {
  pullWithFailingGit,
  PULL_RECOVERY_CASES,
  setUpPull,
  INDEX_CLASSES,
  assertIndexStatesRestored,
  isUncommittedEditPhase,
} from '../helpers/backlog-commit-fixture.js';

// The conflict phases where an uncommitted edit conflicts with the pull, and
// staged edits that the recovery cannot write back.
for (const c of PULL_RECOVERY_CASES.filter(isUncommittedEditPhase)) {
  test(`pullBacklog_recovery_rejects_changed_index_state: ${c.name}`, () => {
    assertIndexStatesRestored(c);
  });
}

test('pullBacklog_recovery_rejects_changed_index_state: index not written back', () => {
  // When the index cannot be written back, the changed staging is caught.
  const c = PULL_RECOVERY_CASES.find((k) => k.name === 'hand-written conflict, dirty tree');
  for (const ix of INDEX_CLASSES.filter((k) => k.lost)) {
    const { tmp, alice } = setUpPull(c);
    try {
      ix.set(alice);
      const res = pullWithFailingGit(alice, ['rev-parse --path-format=absolute']);
      assert.equal(res.state, 'unsafe', `${ix.name}: ${JSON.stringify(res)}`);
      assert.match(res.message, /^the (staged|uncommitted) edits are not as they were before the pull/, ix.name);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});
