/**
 * capacity-helper.test.js — S-1371: runCapacityHelper trusts a helper's
 * JSON answer only when the helper exits 0, for both of its callers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runCapacityHelper } from '../../src/agents/capacity-helper.js';
import { getProvider } from '../../src/agents/index.js';
import { loadConfig } from '../../src/config.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

// Answers a caller would map to `available` (or a known reading), printed by
// a helper that then failed, and the reason runCapacityHelper gives.
const FAILED_AFTER_ANSWER = [
  ['exit 1', { status: 1, signal: null }, /exit 1/],
  ['exit 2', { status: 2, signal: null }, /exit 2/],
  ['signal', { status: null, signal: 'SIGTERM' }, /signal SIGTERM/],
  ['signal with a status', { status: 0, signal: 'SIGKILL' }, /signal SIGKILL/],
];

const LOCAL_UP = '{"ok":true,"status":200}\n';
// An answer codexCapacity maps to `available`: 90% of a 5h window left.
const CODEX_UP = `${JSON.stringify({
  ok: true,
  result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000_000_000 } } },
})}\n`;

test('capacity_helper_rejects_json_after_failed_exit: runCapacityHelper gives a reason, never the answer', () => {
  for (const [label, exit, want] of FAILED_AFTER_ANSWER) {
    const r = runCapacityHelper('/x/helper.js', [], { timeoutMs: 100, run: () => ({ ...exit, stdout: LOCAL_UP }) });
    assert.equal(r.out, undefined, label);
    assert.match(r.reason, want, label);
  }
  // Exit 0 with a JSON object is the one answer it returns.
  assert.deepEqual(
    runCapacityHelper('/x/helper.js', [], { timeoutMs: 100, run: () => ({ status: 0, stdout: LOCAL_UP }) }),
    {
      out: { ok: true, status: 200 },
    },
  );
});

test('capacity_helper_rejects_json_after_failed_exit: local and codex read unknown from a failed helper', () => {
  const t = mkTempBacklog({ repos: ['../demo-repo'] });
  try {
    // Exit 0: both callers map the answer, so a failed exit is what makes them unknown.
    assert.equal(getProvider('codex').capacity({ run: () => ({ status: 0, stdout: CODEX_UP }) }).state, 'available');
    const path = join(t.dir, 'backlog.json');
    const local = { url: 'http://localhost:8090', token: 'local' };
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), local }));
    const { topLevel } = loadConfig({ backlogRoot: t.dir, agent: 'local', model: 'qwen3.8-27b' });
    for (const [label, exit, want] of FAILED_AFTER_ANSWER) {
      const l = getProvider('local').capacity({ topLevel, run: () => ({ ...exit, stdout: LOCAL_UP }) });
      assert.equal(l.state, 'unknown', `local ${label}`);
      assert.match(l.message, want, `local ${label}`);
      const c = getProvider('codex').capacity({ run: () => ({ ...exit, stdout: CODEX_UP }) });
      assert.equal(c.state, 'unknown', `codex ${label}`);
      assert.match(c.message, want, `codex ${label}`);
    }
  } finally {
    t.cleanup();
  }
});
