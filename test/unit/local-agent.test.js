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
import {
  LocalProvider,
  checkLocalConfiguration,
  localCapacity,
  localEnv,
  localServer,
} from '../../src/agents/local.js';
import { healthUrl, probeLocalServer } from '../../src/agents/local-capacity.js';
import { capacityRows } from '../../src/capacity.js';
import { agentFlagOf, configForRepo, loadConfig } from '../../src/config.js';
import { launchSession, runHeadlessSession } from '../../src/session.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const LOCAL_KEY = { url: 'http://localhost:8090', token: 'local' };
const MODEL = 'qwen3.8-27b';

/**
 * A fixture backlog whose backlog.json has the top-level `local` key `local`,
 * and its `config`, loaded once with `-A local --model`, as a command loads it
 * before a spawn.
 */
function localBacklog(local = LOCAL_KEY) {
  const t = mkTempBacklog({ repos: ['../demo-repo'] });
  const path = join(t.dir, 'backlog.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), local }, null, 2) + '\n');
  return { ...t, config: loadConfig({ backlogRoot: t.dir, agent: 'local', model: MODEL }) };
}

/** `run` for spawn(): records each call's environment. */
function recordingRun(envs) {
  return (_cmd, _args, opts) => {
    envs.push(opts.env);
    return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 's' }) };
  };
}

/** `run` for capacity(): a helper that answers 200, recording the URL it was given. */
function healthyRun(urls = []) {
  return (_cmd, args) => {
    urls.push(args[args.indexOf('--url') + 1]);
    return { status: 0, stdout: '{"ok":true,"status":200}\n' };
  };
}

// The role list -A replaces, in every shape: a reload without -A refuses all
// but the valid one, so spawn() and capacity() must not reload.
const REPLACED_LISTS = [
  ['missing', undefined],
  ['empty', []],
  ['wrong type', {}],
  ['bad entry', [{ agent: 'missing-provider' }]],
  ['valid', [{ agent: 'claude' }]],
];

/** Each role × each REPLACED_LISTS shape: a backlog whose list of that role is the shape, loaded with -A local. */
function* replacedRoleBacklogs() {
  for (const [role, key] of [
    ['agent', 'agent'],
    ['review', 'review_agent'],
  ]) {
    for (const [shape, list] of REPLACED_LISTS) {
      const t = mkTempBacklog({ config: { agent: [{ agent: 'claude' }], review_agent: [{ agent: 'codex' }] } });
      const path = join(t.dir, 'backlog.json');
      const raw = { ...JSON.parse(readFileSync(path, 'utf8')), local: LOCAL_KEY };
      if (list === undefined) delete raw[key];
      else raw[key] = list;
      writeFileSync(path, JSON.stringify(raw));
      const config = loadConfig({ backlogRoot: t.dir, agent: 'local', model: MODEL, agentRole: role });
      try {
        yield { label: `${role} ${shape}`, dir: t.dir, config };
      } finally {
        t.cleanup();
      }
    }
  }
}

test('local_spawn_keeps_replaced_role_override: spawn() reaches the server for every role list -A replaced', () => {
  for (const { label, dir, config } of replacedRoleBacklogs()) {
    const envs = [];
    getProvider('local').spawn({
      prompt: 'p',
      worktreePath: dir,
      backlogRoot: dir,
      topLevel: config.topLevel,
      headless: true,
      model: MODEL,
      run: recordingRun(envs),
    });
    assert.equal(envs.length, 1, label);
    assert.equal(envs[0].ANTHROPIC_BASE_URL, LOCAL_KEY.url, label);
  }
});

test('local_capacity_keeps_replaced_role_override: capacity() asks the server for every role list -A replaced', () => {
  for (const { label, config } of replacedRoleBacklogs()) {
    const urls = [];
    const c = getProvider('local').capacity({ topLevel: config.topLevel, run: healthyRun(urls) });
    assert.equal(c.state, 'available', `${label}: ${c.message}`);
    assert.deepEqual(urls, [LOCAL_KEY.url], label);
  }
});

test('local_spawn_uses_validated_configuration_snapshot: spawn() and capacity() use the server of the loaded config', () => {
  const { dir, cleanup, config } = localBacklog();
  /** spawn() for `topLevel`, recording its environment in `envs`. */
  const spawnWith = (topLevel, envs) =>
    getProvider('local').spawn({
      prompt: 'p',
      worktreePath: dir,
      backlogRoot: dir,
      topLevel,
      headless: true,
      model: MODEL,
      run: recordingRun(envs),
    });
  try {
    // An edit after the load names another server: the loaded config does not.
    const path = join(dir, 'backlog.json');
    const edited = { url: 'http://localhost:8091', token: 'new' };
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), local: edited }));
    const urls = [];
    const envs = [];
    getProvider('local').capacity({ topLevel: config.topLevel, run: healthyRun(urls) });
    spawnWith(config.topLevel, envs);
    assert.deepEqual(urls, [LOCAL_KEY.url]);
    assert.deepEqual([envs[0].ANTHROPIC_BASE_URL, envs[0].ANTHROPIC_AUTH_TOKEN], [LOCAL_KEY.url, LOCAL_KEY.token]);
    // A reload (sync.js after a pull) checks the edit, and its config uses it.
    const reloaded = loadConfig({ backlogRoot: dir, agent: 'local', model: MODEL });
    getProvider('local').capacity({ topLevel: reloaded.topLevel, run: healthyRun(urls) });
    spawnWith(reloaded.topLevel, envs);
    assert.deepEqual(urls, [LOCAL_KEY.url, edited.url]);
    assert.deepEqual([envs[1].ANTHROPIC_BASE_URL, envs[1].ANTHROPIC_AUTH_TOKEN], [edited.url, edited.token]);
    // A top level that names no server (a backlog without the key, or a
    // caller with no config): spawn() throws, capacity() is unknown.
    for (const topLevel of [{}, null, undefined]) {
      const label = String(JSON.stringify(topLevel));
      const none = [];
      assert.throws(() => spawnWith(topLevel, none), /backlog\.json "local" is missing/, label);
      assert.equal(none.length, 0, label);
      const c = getProvider('local').capacity({ topLevel, run: healthyRun() });
      assert.equal(c.state, 'unknown', label);
      assert.match(c.message, /"local" is missing/, label);
    }
  } finally {
    cleanup();
  }
});

/** A local server at `port`, with a token of its own. */
const serverAt = (port) => ({ url: `http://127.0.0.1:${port}`, token: `t${port}` });

test('local_server_binding_survives_other_and_failed_loads: a loaded config keeps the server its load checked', async () => {
  const t = mkTempBacklog({
    repos: ['../demo-repo'],
    config: { local: serverAt(18090), agent: [{ agent: 'local', model: MODEL }], review_agent: [{ agent: 'claude' }] },
  });
  const path = join(t.dir, 'backlog.json');
  /** Write backlog.json with the server `local` and the keys `extra`. */
  const write = (local, extra = {}) =>
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), local, ...extra }));
  /** What spawn() and capacity() reach for `config`: [spawn URL, spawn token, capacity URL]. */
  const reached = (config) => {
    const envs = [];
    const urls = [];
    getProvider('local').spawn({
      prompt: 'p',
      worktreePath: t.dir,
      backlogRoot: t.dir,
      topLevel: config.topLevel,
      headless: true,
      model: MODEL,
      run: recordingRun(envs),
    });
    getProvider('local').capacity({ topLevel: config.topLevel, run: healthyRun(urls) });
    return [envs[0].ANTHROPIC_BASE_URL, envs[0].ANTHROPIC_AUTH_TOKEN, urls[0]];
  };
  try {
    const first = loadConfig({ backlogRoot: t.dir });
    // Each held config and the server it must keep.
    const held = [
      ['first load', first, serverAt(18090)],
      ['first load, configForRepo', configForRepo(first, 'demo-repo'), serverAt(18090)],
    ];
    // Each event that could move a held config's server, in order. A
    // successful load returns its own config, which is held from then on.
    const events = [
      [
        'a second successful load',
        () => {
          write(serverAt(18091));
          return ['second load', loadConfig({ backlogRoot: t.dir }), serverAt(18091)];
        },
      ],
      [
        'a rejected load',
        () => {
          write(serverAt(18092), { review_agent: [] });
          assert.throws(() => loadConfig({ backlogRoot: t.dir }), /review_agent/);
          write(serverAt(18092), { review_agent: [{ agent: 'claude' }] });
        },
      ],
      [
        'a rejected -A local load',
        () => {
          write(serverAt(18093));
          assert.throws(() => loadConfig({ backlogRoot: t.dir, agent: 'local' }), /"model"/);
        },
      ],
      [
        "a sync.js reload with the first load's -A handling",
        () => {
          write(serverAt(18094));
          const flag = agentFlagOf(first);
          const config = loadConfig({
            backlogRoot: t.dir,
            agent: flag.agent ?? undefined,
            model: flag.model ?? undefined,
            agentRole: flag.role,
            lenientAgents: flag.lenient,
          });
          return ['sync.js reload', config, serverAt(18094)];
        },
      ],
      [
        'checks outside a load: no model, a bad key, an overrides key, a usable one',
        () => {
          const top = { local: serverAt(18095) };
          assert.ok(checkLocalConfiguration({ model: null }, { topLevel: top, raw: top }));
          const bad = { local: { url: '' } };
          assert.ok(checkLocalConfiguration({ model: MODEL }, { topLevel: bad, raw: bad }));
          assert.ok(checkLocalConfiguration({ model: MODEL }, { topLevel: top, raw: { local: serverAt(18096) } }));
          assert.equal(checkLocalConfiguration({ model: MODEL }, { topLevel: top, raw: top }), null);
        },
      ],
      ['an edit with no load', () => write(serverAt(18097))],
    ];
    for (const [event, run] of events) {
      const added = run();
      if (added) held.push(added);
      for (const [label, config, local] of held) {
        assert.deepEqual(reached(config), [local.url, local.token, local.url], `${label}, after ${event}`);
      }
    }
    // The callers that take a config: a headless and an interactive session,
    // and capacityRows's default ask. The ask runs the real helper; whatever
    // it answers, its message names the URL it asked.
    const envs = [];
    const provider = new (class extends LocalProvider {
      spawn(opts) {
        envs.push(this.spawnEnv(opts));
        return { status: 0, output: '', isError: false, usage: null };
      }
    })();
    const common = {
      mode: 'workon',
      parsed: { id: 'F-1', num: '1' },
      worktreePath: t.dir,
      config: first,
      roostDir: first.roostDir,
      backlogRoot: t.dir,
      provider,
    };
    assert.equal((await runHeadlessSession({ ...common, prompt: 'p', label: 'F-1' })).status, 0);
    await launchSession({
      ...common,
      title: 'T',
      sessionPrompt: 'p',
      isNewWorktree: false,
      returnOnExit: true,
      recordTokens: false,
    });
    assert.deepEqual(
      envs.map((e) => e.ANTHROPIC_BASE_URL),
      [serverAt(18090).url, serverAt(18090).url],
    );
    const [row] = capacityRows(first);
    assert.equal(row.agent, 'local');
    assert.ok(row.message.includes(serverAt(18090).url), row.message);
  } finally {
    t.cleanup();
  }
});

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
  const { dir, cleanup, config } = localBacklog();
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
      topLevel: config.topLevel,
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

test('claude and local spawnEnv turn titles off for a headless and an interactive spawn (S-1388)', () => {
  const saved = process.env.BL_TAB_TITLE;
  process.env.BL_TAB_TITLE = '{{status}}'; // an operator's own format
  try {
    for (const [name, provider] of [
      ['claude', new ClaudeProvider()],
      ['local', getProvider('local')],
    ]) {
      for (const headless of [true, false]) {
        const env = provider.spawnEnv({ headless, backlogRoot: '/b', model: MODEL, topLevel: { local: LOCAL_KEY } });
        assert.equal(env.BL_TAB_TITLE, '', `${name} headless=${headless}`);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.BL_TAB_TITLE;
    else process.env.BL_TAB_TITLE = saved;
  }
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

test('local_capacity_rejects_incomplete_health_records: only ok false with ECONNREFUSED is unavailable', () => {
  const url = LOCAL_KEY.url;
  // Each record and the state it maps to: every branch (ok, status, code, error) with each wrong shape.
  const cases = [
    [{ code: 'ECONNREFUSED' }, 'unknown'],
    [{ ok: null, code: 'ECONNREFUSED' }, 'unknown'],
    [{ ok: 'false', code: 'ECONNREFUSED' }, 'unknown'],
    [{ ok: 0, code: 'ECONNREFUSED' }, 'unknown'],
    [{ ok: true, code: 'ECONNREFUSED' }, 'unknown'],
    [{ status: 200 }, 'unknown'],
    [{ ok: 'true', status: 200 }, 'unknown'],
    [{ ok: true }, 'unknown'],
    [{ ok: true, status: '200' }, 'unknown'],
    [{ ok: true, status: 200.5 }, 'unknown'],
    [{ ok: false }, 'unknown'],
    [{ ok: false, code: 'econnrefused' }, 'unknown'],
    [{ ok: false, code: null, error: { message: 'x' } }, 'unknown'],
    [{ ok: false, code: 'ECONNREFUSED' }, 'unavailable'],
    [{ ok: true, status: 200 }, 'available'],
    [{ ok: true, status: 503 }, 'unknown'],
  ];
  for (const [out, state] of cases) {
    const c = localCapacity(out, url);
    assert.equal(c.state, state, JSON.stringify(out));
    assert.ok(c.message.includes(url), `${JSON.stringify(out)}: the message names the URL`);
    assert.doesNotMatch(c.message, /undefined|\[object Object\]/, JSON.stringify(out));
  }
});

test('LocalProvider.capacity runs the helper with the backlog URL and maps its answer; never throws', () => {
  const { cleanup, config } = localBacklog();
  try {
    const p = getProvider('local');
    let seen;
    const fake =
      (stdout, extra = {}) =>
      (cmd, args, opts) => {
        seen = { cmd, args, opts };
        return { status: 0, stdout, ...extra };
      };
    const up = p.capacity({ topLevel: config.topLevel, run: fake('{"ok":true,"status":200}\n'), timeoutMs: 100 });
    assert.equal(up.state, 'available');
    assert.equal(seen.cmd, process.execPath);
    assert.match(seen.args[0], /local-capacity\.js$/);
    assert.deepEqual(seen.args.slice(1), ['--url', LOCAL_KEY.url, '--timeout', '100']);
    assert.equal(
      p.capacity({ topLevel: config.topLevel, run: fake('{"ok":false,"code":"ECONNREFUSED"}') }).state,
      'unavailable',
    );
    const crashed = p.capacity({ topLevel: config.topLevel, run: fake('', { status: 1 }) });
    assert.equal(crashed.state, 'unknown');
    assert.match(crashed.message, /exit 1/);
    const thrown = p.capacity({
      topLevel: config.topLevel,
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
    const { topLevel } = loadConfig({ backlogRoot: bare });
    assert.match(getProvider('local').capacity({ topLevel }).message, /"local" is missing/);
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
