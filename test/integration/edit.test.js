/**
 * Integration tests for `bl edit`'s exit status (S-1110, F-70 D3): an editor that cannot be
 * started or that a signal kills makes bl exit nonzero, with an error on stderr.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { GIT_ENV } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';

function backlog() {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'One', body: '## Summary\n\nWork.\n\n## Dependencies\n\nNone.' }],
  });
  return dir;
}

const edit = (VISUAL) => runBl(['edit', 'S-1'], { cwd: backlog(), env: { ...GIT_ENV, VISUAL } });

test('edit_spawn_failure_and_signal_exit_nonzero', async (t) => {
  const tools = mkTempDir('bl-edit-tools-');
  const killed = join(tools, 'killed');
  writeFileSync(killed, '#!/bin/sh\nkill -TERM $$\n');
  chmodSync(killed, 0o755);

  await t.test('an editor missing from PATH', () => {
    const r = edit('no-such-editor-bl-test');
    assert.equal(r.status, 127, r.stderr);
    assert.match(r.stderr, /no-such-editor-bl-test/);
  });

  await t.test('an editor killed by a signal, through the shell', () => {
    const r = edit(killed);
    assert.equal(r.signal, null);
    assert.equal(r.status, 143, r.stderr);
    assert.match(r.stderr, /Terminated/);
  });

  await t.test('an editor killed by a signal, with no shell in between', () => {
    // `exec` replaces the shell, so the signal reaches bl as the child's own.
    const r = edit(`exec ${killed}`);
    assert.equal(r.status, 143, r.stderr);
    assert.match(r.stderr, /^bl: exec \S+killed was killed by SIGTERM$/m);
  });

  await t.test("an editor's own exit status is passed on", () => {
    assert.equal(edit('false').status, 1);
    assert.equal(edit('true').status, 0);
  });
});
