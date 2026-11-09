import { test } from 'node:test';
import {
  PULL_RECOVERY_CASES,
  assertIndexStatesRestored,
  isUncommittedEditPhase,
} from '../helpers/backlog-commit-fixture.js';

// The conflict phases where Alice's commits conflict with the pull; the
// uncommitted-edit phases are in backlog-commit-index-state-uncommitted.
for (const c of PULL_RECOVERY_CASES.filter((k) => !isUncommittedEditPhase(k))) {
  test(`pullBacklog_recovery_rejects_changed_index_state: ${c.name}`, () => {
    assertIndexStatesRestored(c);
  });
}
