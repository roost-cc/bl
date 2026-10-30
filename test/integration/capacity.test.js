import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { BL_BIN, runBl } from '../helpers/run-bl.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { capacityRows } from '../../src/capacity.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

// F-64 D6: `bl capacity` prints every configuration of both roles from its
// adapter's capacity(), asking each agent once, and exits 0 whatever the
// states.

const FAKE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bin');

const CONFIG = {
  agent: [
    { agent: 'claude', model: 'opus' },
    { agent: 'claude', model: 'sonnet' },
  ],
  review_agent: [
    { agent: 'codex', model: 'gpt-6-sol' },
    { agent: 'codex', model: 'gpt-6-astra' },
    { agent: 'claude', model: 'sonnet' },
  ],
};

/** `bl capacity <args>` with the fake `codex app-server` (test/fixtures/bin/codex) first on PATH. */
function blCapacity(dir, args, mode = 'open') {
  const env = withNoAgent({ ...process.env, BL_BACKLOG_DIR: dir, FAKE_CODEX_MODE: mode });
  env.PATH = `${FAKE_BIN}:${env.PATH}`;
  return spawnSyncFiles(BL_BIN, ['capacity', ...args], { cwd: dir, env, encoding: 'utf8' });
}

test("bl capacity prints a row per configuration of both roles, with Codex's windows and local reset times", () => {
  const { dir } = mkTempBacklog({ config: CONFIG });
  const r = blCapacity(dir, []);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^ROLE\s+AGENT\s+MODEL\s+STATE\s+DETAIL$/);
  assert.equal(lines.length, 6);
  assert.match(lines[1], /^agent\s+claude\s+opus\s+unknown\s+claude cannot report capacity$/);
  assert.match(
    lines[3],
    /^review\s+codex\s+gpt-6-sol\s+available\s+codex 5h 80% left \(resets \d{4}-\d\d-\d\d \d\d:\d\d \S+\); codex 7d 87% left/,
  );
  assert.match(lines[4], /^review\s+codex\s+gpt-6-astra\s+available\s+codex 5h 80% left/);
  assert.match(lines[5], /^review\s+claude\s+sonnet\s+unknown/);
});

test('bl capacity --json prints bl-capacity-json/v1', () => {
  const { dir } = mkTempBacklog({ config: CONFIG });
  const r = blCapacity(dir, ['--json'], 'exhausted');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schema, 'bl-capacity-json/v1');
  assert.deepEqual(
    out.configurations.map((c) => [c.role, c.agent, c.model, c.state]),
    [
      ['agent', 'claude', 'opus', 'unknown'],
      ['agent', 'claude', 'sonnet', 'unknown'],
      ['review', 'codex', 'gpt-6-sol', 'unavailable'],
      ['review', 'codex', 'gpt-6-astra', 'unavailable'],
      ['review', 'claude', 'sonnet', 'unknown'],
    ],
  );
  const codex = out.configurations[2];
  assert.equal(codex.scope, 'account');
  assert.equal(codex.until, '2026-10-29T07:52:54.000Z');
  assert.deepEqual(codex.windows[0], { name: 'codex 5h', remainingPercent: 0, resetsAt: '2026-10-29T07:52:54.000Z' });
});

test('bl capacity shows a failed app-server read as unknown with its reason, and exits 0', () => {
  // runBl's refusing stub is the only codex on PATH: it exits 1 at once.
  const { dir } = mkTempBacklog({ config: CONFIG });
  const r = runBl(['capacity', '--json'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const codex = JSON.parse(r.stdout).configurations[2];
  assert.equal(codex.state, 'unknown');
  assert.match(codex.message, /exited before returning usage \(exit 1\)/);
});

test('capacityRows asks an account-scoped agent once and a model-scoped one once per model', () => {
  const asked = [];
  const rows = capacityRows(
    {
      agents: [
        { agent: 'claude', model: 'opus' },
        { agent: 'claude', model: 'sonnet' },
      ],
      reviewAgents: [
        { agent: 'codex', model: 'a' },
        { agent: 'codex', model: 'b' },
        { agent: 'claude', model: 'opus' },
      ],
    },
    (agent, model) => {
      asked.push([agent, model]);
      return {
        state: 'unknown',
        scope: agent === 'codex' ? 'account' : 'model',
        until: null,
        windows: [],
        message: '',
      };
    },
  );
  assert.deepEqual(asked, [
    ['claude', 'opus'],
    ['claude', 'sonnet'],
    ['codex', 'a'],
  ]);
  assert.deepEqual(
    rows.map((r) => [r.role, r.agent, r.model]),
    [
      ['agent', 'claude', 'opus'],
      ['agent', 'claude', 'sonnet'],
      ['review', 'codex', 'a'],
      ['review', 'codex', 'b'],
      ['review', 'claude', 'opus'],
    ],
  );
});

test('bl capacity takes no arguments', () => {
  const { dir } = mkTempBacklog({ config: CONFIG });
  const r = runBl(['capacity', 'F-1'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /takes no arguments/);
});
