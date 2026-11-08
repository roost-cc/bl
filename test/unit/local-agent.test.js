/**
 * local-agent.test.js — S-1371: the `local` adapter (Claude Code against a
 * local llama-server): its environment, its configuration rules, its spawn
 * and its capacity probe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getProvider } from '../../src/agents/index.js';
import { ClaudeProvider, parseClaudeJsonResult } from '../../src/agents/claude.js';
import { LocalProvider, localCapacity, localEnv, localServer } from '../../src/agents/local.js';
import { healthUrl, probeLocalServer } from '../../src/agents/local-capacity.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const LOCAL_KEY = { url: 'http://localhost:8090', token: 'local' };
const MODEL = 'qwen3.8-27b';

/** A fixture backlog whose backlog.json has the top-level `local` key `local`. */
function localBacklog(local = LOCAL_KEY) {
  const t = mkTempBacklog({ repos: ['../demo-repo'] });
  const path = join(t.dir, 'backlog.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), local }, null, 2) + '\n');
  return t;
}

test('LocalProvider is ClaudeProvider named local, overriding only spawnEnv, checkConfiguration and capacity', () => {
  const p = getProvider('local');
  assert.ok(p instanceof LocalProvider);
  assert.ok(p instanceof ClaudeProvider);
  assert.equal(p.name, 'local');
  const own = Object.getOwnPropertyNames(LocalProvider.prototype).filter((n) => n !== 'constructor');
  assert.deepEqual(own.sort(), ['capacity', 'checkConfiguration', 'name', 'spawnEnv']);
});

test('localEnv sets the four variables and keeps the rest of base', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-real', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
  const env = localEnv({ url: LOCAL_KEY.url, token: 'local', model: MODEL, base });
  assert.deepEqual(env, {
    PATH: '/bin',
    ANTHROPIC_BASE_URL: 'http://localhost:8090',
    ANTHROPIC_AUTH_TOKEN: 'local',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_SMALL_FAST_MODEL: MODEL,
  });
  assert.equal(base.ANTHROPIC_API_KEY, 'sk-real', 'base is not changed');
});

test('spawn runs claude with --model and the local environment', () => {
  const { dir, cleanup } = localBacklog();
  try {
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 's' }) };
    };
    const r = getProvider('local').spawn({
      prompt: 'hello',
      worktreePath: dir,
      backlogRoot: dir,
      headless: true,
      model: MODEL,
      scopes: {},
      run,
    });
    assert.equal(r.output, 'ok');
    assert.equal(calls.length, 1);
    const [{ cmd, args, opts }] = calls;
    assert.equal(cmd, 'claude');
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', MODEL]);
    assert.equal(opts.env.ANTHROPIC_BASE_URL, LOCAL_KEY.url);
    assert.equal(opts.env.ANTHROPIC_AUTH_TOKEN, LOCAL_KEY.token);
    assert.equal(opts.env.ANTHROPIC_API_KEY, '');
    assert.equal(opts.env.ANTHROPIC_SMALL_FAST_MODEL, MODEL);
    assert.equal(opts.env.BL_HEADLESS, '1');
    assert.equal(opts.env.BL_BACKLOG_DIR, dir);
  } finally {
    cleanup();
  }
});

test("claude's spawnEnv is agentEnv: no ANTHROPIC_BASE_URL of its own", () => {
  const env = new ClaudeProvider().spawnEnv({ headless: true, backlogRoot: '/b', model: 'opus' });
  assert.equal(env.BL_HEADLESS, '1');
  assert.equal(env.BL_BACKLOG_DIR, '/b');
  assert.equal(env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
});

test('checkConfiguration: a reason for no model, a bad local key and overrides that set it; else null', () => {
  const p = getProvider('local');
  const top = { local: LOCAL_KEY };
  assert.equal(p.checkConfiguration({ model: MODEL }, { topLevel: top, raw: top }), null);
  assert.match(p.checkConfiguration({ model: null }, { topLevel: top, raw: top }), /"model": the server's alias/);
  assert.match(p.checkConfiguration({ model: MODEL }, { topLevel: {}, raw: {} }), /backlog\.json "local" is missing/);
  assert.match(
    p.checkConfiguration({ model: MODEL }, { topLevel: top, raw: { local: { ...LOCAL_KEY } } }),
    /"overrides" set "local"/,
  );
  // The other adapters find no reason.
  for (const name of ['claude', 'codex', 'gemini']) {
    assert.equal(getProvider(name).checkConfiguration({ model: null }, { topLevel: {}, raw: {} }), null, name);
  }
});

test('localServer refuses a non-object, a missing or empty url or token, and an unknown key', () => {
  assert.deepEqual(localServer({ local: LOCAL_KEY }), LOCAL_KEY);
  const cases = [
    [{}, /"local" is missing/],
    [{ local: null }, /"local" must be an object/],
    [{ local: ['x'] }, /"local" must be an object/],
    [{ local: { token: 'local' } }, /"local" "url" must be a non-empty string/],
    [{ local: { url: 'http://x', token: ' ' } }, /"local" "token" must be a non-empty string/],
    [{ local: { url: 'http://x', token: 'local', model: 'q' } }, /unknown key "model"/],
  ];
  for (const [top, want] of cases) assert.throws(() => localServer(top), want, JSON.stringify(top));
});

test('localCapacity maps 200, ECONNREFUSED, TIMEOUT, a 503 and a bad answer', () => {
  const url = LOCAL_KEY.url;
  const at = (out) => localCapacity(out, url);
  const ok = at({ ok: true, status: 200 });
  assert.deepEqual(
    { ...ok, message: undefined },
    {
      state: 'available',
      scope: 'account',
      until: null,
      windows: [],
      message: undefined,
    },
  );
  const refused = at({ ok: false, code: 'ECONNREFUSED', error: 'connect ECONNREFUSED' });
  assert.equal(refused.state, 'unavailable');
  assert.equal(refused.until, null);
  assert.equal(at({ ok: false, code: 'TIMEOUT', error: 'no answer' }).state, 'unknown');
  assert.equal(at({ ok: true, status: 503 }).state, 'unknown');
  assert.equal(at({ ok: false, code: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND' }).state, 'unknown');
  assert.equal(at(null).state, 'unknown');
  assert.equal(at([]).state, 'unknown');
  for (const out of [{ ok: true, status: 200 }, { ok: false, code: 'ECONNREFUSED' }, { ok: true, status: 503 }, null]) {
    const c = at(out);
    assert.equal(c.scope, 'account');
    assert.ok(c.message.includes(url), `${JSON.stringify(out)}: the message names the URL`);
  }
});

test('LocalProvider.capacity runs the helper with the backlog URL and maps its answer; never throws', () => {
  const { dir, cleanup } = localBacklog();
  try {
    const p = getProvider('local');
    let seen;
    const fake =
      (stdout, extra = {}) =>
      (cmd, args, opts) => {
        seen = { cmd, args, opts };
        return { status: 0, stdout, ...extra };
      };
    const up = p.capacity({ backlogRoot: dir, run: fake('{"ok":true,"status":200}\n'), timeoutMs: 100 });
    assert.equal(up.state, 'available');
    assert.equal(seen.cmd, process.execPath);
    assert.match(seen.args[0], /local-capacity\.js$/);
    assert.deepEqual(seen.args.slice(1), ['--url', LOCAL_KEY.url, '--timeout', '100']);
    assert.equal(
      p.capacity({ backlogRoot: dir, run: fake('{"ok":false,"code":"ECONNREFUSED"}') }).state,
      'unavailable',
    );
    const crashed = p.capacity({ backlogRoot: dir, run: fake('', { status: 1 }) });
    assert.equal(crashed.state, 'unknown');
    assert.match(crashed.message, /exit 1/);
    const thrown = p.capacity({
      backlogRoot: dir,
      run: () => {
        throw new Error('spawn boom');
      },
    });
    assert.match(thrown.message, /spawn boom/);
  } finally {
    cleanup();
  }
  // No local key: unknown with the reason, not a throw.
  const { dir: bare, cleanup: done } = mkTempBacklog({ repos: ['../demo-repo'] });
  try {
    assert.match(getProvider('local').capacity({ backlogRoot: bare }).message, /"local" is missing/);
  } finally {
    done();
  }
});

/** An in-process server whose handler is `handle`; resolves with its URL and a close. */
async function serve(handle) {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test('probeLocalServer: a 200, a closed port and a server that never answers', async () => {
  // Tested directly: the helper runs under spawnSync, which blocks this
  // test's event loop, so an in-process server could not answer it.
  const paths = [];
  const up = await serve((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  try {
    assert.deepEqual(await probeLocalServer({ url: `${up.url}/`, timeoutMs: 2000 }), { ok: true, status: 200 });
    assert.deepEqual(paths, ['/health']);
  } finally {
    await up.close();
  }
  // The port the server had is closed now.
  const refused = await probeLocalServer({ url: up.url, timeoutMs: 2000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ECONNREFUSED');
  // `localhost`, as backlog.json names it, resolves to more than one address;
  // nothing listens on any of them, and the answer is still ECONNREFUSED.
  const port = new URL(up.url).port;
  assert.equal((await probeLocalServer({ url: `http://localhost:${port}`, timeoutMs: 2000 })).code, 'ECONNREFUSED');

  const silent = await serve(() => {});
  try {
    const r = await probeLocalServer({ url: silent.url, timeoutMs: 200 });
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'TIMEOUT' });
  } finally {
    await silent.close();
  }
  assert.equal(healthUrl('http://localhost:8090//'), 'http://localhost:8090/health');
});

test('a claude that cannot reach the server is a failed step, not a refusal', () => {
  const r = parseClaudeJsonResult(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection error.' }),
  );
  assert.equal(r.isError, true);
  assert.equal(r.refusal, null);
});
