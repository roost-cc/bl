/**
 * The suite runs without tmux's variables and bl's title variables (S-1388).
 * A test `bl` that inherited `TMUX` and `BL_TMUX_WINDOW_ID` renamed the
 * operator's real tmux window, and turned its `automatic-rename` back on when
 * it exited. `test/helpers/without-repo-env.sh` unsets them for every
 * `npm run test:*` script. Tests that need tmux set a stub of their own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the suite runs with none of the tmux or tab-title variables set', () => {
  const vars = ['TMUX', 'TMUX_PANE', 'BL_TMUX_WINDOW_ID', 'BL_TAB_TITLE'];
  assert.deepEqual(
    vars.filter((v) => process.env[v] !== undefined),
    [],
    'run `npm run test:unit`, which unsets these variables',
  );
});
