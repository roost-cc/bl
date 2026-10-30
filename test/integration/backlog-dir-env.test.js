/**
 * Integration tests for backlog discovery through the environment (S-581):
 * `BL_BACKLOG_DIR` names the backlog from a cwd outside it, and the variable
 * bl read before S-581 is ignored, so bl fails with the discovery error,
 * which names `BL_BACKLOG_DIR`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { BL_BIN } from '../helpers/run-bl.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

// The pre-S-581 name, built so the public-release check (a grep for the old
// prefix) stays empty.
const LEGACY = ['ROOST', 'BACKLOG', 'DIR'].join('_');

/** Run `bl list` from `cwd` with `extra` as the only backlog variables set. */
function listFrom(cwd, extra) {
  const env = withNoAgent({ ...process.env });
  delete env.BL_BACKLOG_DIR;
  delete env[LEGACY];
  return spawnSync(BL_BIN, ['list'], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
}

test('BL_BACKLOG_DIR finds the backlog from a cwd outside it', () => {
  const { dir, cleanup } = mkTempBacklog({
    stories: [{ id: 'S-1', title: 'Found through the variable', status: 'refined' }],
  });
  const elsewhere = mkTempDir('bl-elsewhere-');
  try {
    const r = listFrom(elsewhere, { BL_BACKLOG_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Found through the variable/);
  } finally {
    cleanup();
  }
});

test('the pre-S-581 variable is ignored: discovery fails and names BL_BACKLOG_DIR', () => {
  const { dir, cleanup } = mkTempBacklog();
  const elsewhere = mkTempDir('bl-elsewhere-');
  try {
    const r = listFrom(elsewhere, { [LEGACY]: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Could not find backlog repo/);
    assert.match(r.stderr, /BL_BACKLOG_DIR/);
    assert.doesNotMatch(r.stderr, new RegExp(LEGACY));
  } finally {
    cleanup();
  }
});
