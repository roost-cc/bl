import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { BL_BIN, runBl } from '../helpers/run-bl.js';
import { withNoAgent } from '../helpers/fake-agent.js';
import { createServer } from 'http';
import { capacityRows } from '../../src/capacity.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { loadConfig } from '../../src/config.js';

// F-64 D6: `bl capacity` prints every configuration of both roles from its
// adapter's capacity(), asking each agent once, and exits 0 whatever the
// states.

const FAKE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bin');

// An empty Claude config dir for every bl this file runs and every in-process
// ask, so a Claude row never reads the operator's token (S-1143), even when
// the file runs outside test/helpers/without-repo-env.sh.
process.env.CLAUDE_CONFIG_DIR = mkTempDir('bl-claude-config-');

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
  assert.match(
    lines[1],
    /^agent\s+claude\s+opus\s+unknown\s+no Claude credentials at \S+\/\.credentials\.json; run claude to log in$/,
  );
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
  assert.match(
    out.configurations[0].message,
    /^no Claude credentials at \S+\/\.credentials\.json; run claude to log in$/,
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

/** A URL on a local port nothing listens on: one the system gave out and took back. */
async function closedPortUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** A fixture backlog with a `local` configuration whose server is at `url`. */
function localBacklog(url) {
  return mkTempBacklog({
    config: {
      local: { url, token: 'local' },
      agent: [{ agent: 'local', model: 'qwen3.8-27b' }],
      review_agent: [{ agent: 'claude', model: 'opus' }],
    },
  });
}

test("capacityRows's default ask gives the adapter the config's top level: local reads its server there", async () => {
  // Another backlog (BL_BACKLOG_DIR, or the cwd's) names another server, so
  // the URL in the message says which backlog the adapter read.
  const url = await closedPortUrl();
  const { dir } = localBacklog(url);
  const [row] = capacityRows(loadConfig({ backlogRoot: dir }));
  assert.deepEqual(
    [row.agent, row.model, row.state, row.scope, row.until],
    ['local', 'qwen3.8-27b', 'unavailable', 'account', null],
  );
  assert.ok(row.message.includes(url), row.message);
});

test('bl capacity shows the local row', async () => {
  const url = await closedPortUrl();
  const { dir } = localBacklog(url);
  const r = runBl(['capacity'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout.split('\n')[1],
    /^agent\s+local\s+qwen3\.8-27b\s+unavailable\s+local server http:\/\/127\.0\.0\.1:\d+ refused/,
  );
});

test('bl capacity takes no arguments', () => {
  const { dir } = mkTempBacklog({ config: CONFIG });
  const r = runBl(['capacity', 'F-1'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /takes no arguments/);
});
