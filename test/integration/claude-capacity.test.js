import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { mkTempDir } from '../helpers/tempdir.js';
import { ClaudeProvider } from '../../src/agents/claude.js';
import { readClaudeUsage } from '../../src/agents/claude-capacity.js';

// S-1143: the Claude capacity reader against a local HTTP server, never the
// real endpoint.

const TOKEN = 'sk-ant-oat01-test-token';
const PROBE2 = readFileSync(new URL('../fixtures/claude-usage/2026-11-10.json', import.meta.url), 'utf8');

/** A credentials file in a temp dir, as Claude Code writes it. */
function credentialsFile(oauth = { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 }) {
  const path = join(mkTempDir('bl-claude-creds-'), '.credentials.json');
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }));
  return path;
}

/** A server on 127.0.0.1 that answers with `handler` and records each request's headers. */
async function usageServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push(req.headers);
    handler(req, res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/oauth/usage`;
  const close = () => {
    for (const s of sockets) s.destroy();
    return new Promise((resolve) => server.close(resolve));
  };
  return { url, requests, close };
}

const answer =
  (status, body, type = 'application/json') =>
  (req, res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

test('a 200 with the usage body is ok, asked with the token and the beta header', async () => {
  const s = await usageServer(answer(200, PROBE2));
  try {
    const out = await readClaudeUsage({ credentials: credentialsFile(), url: s.url });
    assert.deepEqual(out, { ok: true, body: JSON.parse(PROBE2) });
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(s.requests[0]['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(s.requests[0]['user-agent'], 'claude-code/1.0.0');
  } finally {
    await s.close();
  }
});

test('a non-200, a body that is not JSON, no answer in time and a closed port each give the reason', async () => {
  const cases = [
    [answer(401, '{"error":"unauthorized"}'), {}, 'the Claude usage endpoint answered HTTP 401'],
    [answer(200, '<html>', 'text/html'), {}, 'the Claude usage endpoint answered with a body that is not JSON'],
    [() => {}, { timeoutMs: 200 }, 'the Claude usage endpoint did not answer within 0.2s'],
  ];
  for (const [handler, opts, error] of cases) {
    const s = await usageServer(handler);
    try {
      const out = await readClaudeUsage({ credentials: credentialsFile(), url: s.url, ...opts });
      assert.deepEqual(out, { ok: false, error });
    } finally {
      await s.close();
    }
  }
  const s = await usageServer(answer(200, PROBE2));
  await s.close();
  const out = await readClaudeUsage({ credentials: credentialsFile(), url: s.url });
  assert.equal(out.ok, false);
  assert.match(out.error, /^the Claude usage endpoint could not be reached: /);
  assert.ok(!out.error.includes(TOKEN));
});

test('a token fetch refuses as a header value never shows in the error', async () => {
  const s = await usageServer(answer(200, PROBE2));
  try {
    const bad = `${TOKEN}\nx`;
    const out = await readClaudeUsage({ credentials: credentialsFile({ accessToken: bad }), url: s.url });
    assert.equal(out.ok, false);
    assert.match(out.error, /could not be reached/);
    assert.ok(!out.error.includes(TOKEN), out.error);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('no credentials file, or an expired token, gives the reason and sends no request', async () => {
  const s = await usageServer(answer(200, PROBE2));
  try {
    const missing = join(mkTempDir('bl-claude-none-'), '.credentials.json');
    assert.deepEqual(await readClaudeUsage({ credentials: missing, url: s.url }), {
      ok: false,
      error: `no Claude credentials at ${missing}; run claude to log in`,
    });
    const expired = await readClaudeUsage({
      credentials: credentialsFile({ accessToken: TOKEN, expiresAt: Date.now() - 1000 }),
      url: s.url,
    });
    assert.equal(expired.ok, false);
    assert.match(expired.error, /^the Claude OAuth token expired at .*; run claude to refresh it$/);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('ClaudeProvider.capacity reads in process: no credentials under CLAUDE_CONFIG_DIR is unknown with the reason', async () => {
  const dir = mkTempDir('bl-claude-config-');
  const r = await new ClaudeProvider().capacity({ model: 'opus', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  assert.deepEqual(r, {
    state: 'unknown',
    scope: 'model',
    until: null,
    windows: [],
    message: `no Claude credentials at ${dir}/.credentials.json; run claude to log in`,
  });
});
