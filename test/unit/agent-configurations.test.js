/**
 * agent-configurations.test.js — F-64 D2: the retired agent shape as a
 * `bl validate` finding, and scripts/migrate-agent-configurations.js, which
 * rewrites it into configuration lists. The cases that run `bl` or the
 * script as a process are in test/integration/agent-configurations.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readdirSync, readFileSync, writeFileSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { join } from 'path';
import { agentFlagOf, configForRepo, loadConfig, sameConfiguration, independentReviewers } from '../../src/config.js';
import { findAgentConfigFindings } from '../../src/validate.js';
import { migrateAgentConfigurations, main as migrate } from '../../scripts/migrate-agent-configurations.js';
import { ensureReposBlock, initConfigurationLists } from '../../src/init.js';
import { _hooks } from '../../src/atomic-write.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

test('D4 equality: the same agent and model, an absent model equal only to an absent model', () => {
  assert.equal(sameConfiguration({ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'opus' }), true);
  assert.equal(
    sameConfiguration({ agent: 'claude', model: null }, { agent: 'claude' }),
    true,
    'null and absent are both no model',
  );
  assert.equal(
    sameConfiguration({ agent: 'claude', model: null }, { agent: 'claude', model: 'opus' }),
    false,
    "no model is not the account's model",
  );
  assert.equal(sameConfiguration({ agent: 'claude', model: 'opus' }, { agent: 'codex', model: 'opus' }), false);
});

test('independentReviewers: the review entries no implementing entry equals; none means bl run refuses', () => {
  const opus = { agent: 'claude', model: 'opus' };
  const sonnet = { agent: 'claude', model: 'sonnet' };
  const sol = { agent: 'codex', model: 'gpt-6-sol' };
  assert.deepEqual(independentReviewers([opus, sonnet], [opus, sol]), [sol]);
  assert.deepEqual(independentReviewers([opus, sonnet], [sonnet, opus]), []);
  assert.deepEqual(
    independentReviewers([{ agent: 'claude', model: null }], [opus]),
    [opus],
    'Opus is not the model-less claude',
  );
  assert.deepEqual(independentReviewers([{ agent: 'claude', model: null }], [{ agent: 'claude', model: null }]), []);
});

test('init_partial_role_lists_generate_independent_configuration', () => {
  const c = (agent, model) => (model === undefined ? { agent } : { agent, model });
  // [backlog.json, -A, the lists init adds, whether an independent reviewer
  // results]. Claude and Codex run headless; Gemini does not.
  const cases = [
    // Neither role.
    [{}, null, { agent: [c('claude')], review_agent: [c('codex')] }, true],
    [{}, 'codex', { agent: [c('codex')], review_agent: [c('claude')] }, true],
    [{}, 'Gemini', { agent: [c('gemini')], review_agent: [c('claude')] }, true],
    // Both roles: nothing added, whatever -A says.
    [{ agent: [c('codex')], review_agent: [c('codex')] }, 'claude', {}, false],
    // Implementers only.
    [{ agent: [c('codex')] }, null, { review_agent: [c('claude')] }, true],
    [{ agent: [c('codex'), c('gemini')] }, null, { review_agent: [c('claude')] }, true],
    [{ agent: [c('Claude', 'opus'), c('claude', 'sonnet')] }, null, { review_agent: [c('codex')] }, true],
    // Every headless agent used: a model-less one no implementer equals.
    [{ agent: [c('claude', 'opus'), c('codex')] }, null, { review_agent: [c('claude')] }, true],
    // No independent headless choice: the first implementer, which bl run refuses, naming it.
    [{ agent: [c('claude'), c('codex')] }, null, { review_agent: [c('claude')] }, false],
    // -A counts as an implementer: [claude] with -A codex leaves no headless agent.
    [{ agent: [c('claude')] }, 'codex', { review_agent: [c('claude')] }, false],
    [{ agent: [c('claude', 'opus')] }, 'codex', { review_agent: [c('claude')] }, true],
    // Reviewers only.
    [{ review_agent: [c('claude')] }, null, { agent: [c('codex')] }, true],
    [{ review_agent: [c('codex'), c('claude', 'opus')] }, null, { agent: [c('claude')] }, true],
    [{ review_agent: [c('codex')] }, null, { agent: [c('claude')] }, true],
    [{ review_agent: [c('claude')] }, 'gemini', { agent: [c('gemini')] }, true],
  ];
  for (const [raw, flag, want, independent] of cases) {
    const at = JSON.stringify([raw, flag]);
    const added = initConfigurationLists(raw, flag);
    assert.deepEqual(added, want, at);
    // Whenever an independent headless choice exists, the run's check passes.
    const norm = (list) => list.map((x) => ({ agent: x.agent.toLowerCase(), model: x.model ?? null }));
    const agents = norm([...(added.agent ?? raw.agent), ...(flag ? [{ agent: flag }] : [])]);
    assert.equal(
      independentReviewers(agents, norm(added.review_agent ?? raw.review_agent)).length > 0,
      independent,
      at,
    );
  }
});

// Roost's backlog.json agent keys before F-64 (D7).
const LEGACY_KEYS = { agent: 'claude', review_agent: 'codex', agent_model: 'opus', fallback_model: 'sonnet' };

/** A fixture backlog whose backlog.json has `patch` over it (undefined removes a key). */
function backlog(patch, fixture = { repos: ['../demo-repo'] }) {
  const t = mkTempBacklog(fixture);
  const cfgPath = join(t.dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...raw, ...patch }, null, 2) + '\n');
  return { ...t, cfgPath };
}

test('bl validate has no agent-config finding for valid lists', () => {
  const { dir, cleanup } = backlog({ agent: [{ agent: 'claude', model: 'opus' }], review_agent: [{ agent: 'codex' }] });
  try {
    assert.deepEqual(findAgentConfigFindings(loadConfig({ backlogRoot: dir, lenientAgents: true })), []);
  } finally {
    cleanup();
  }
});

test("migrateAgentConfigurations: the old defaults become explicit lists, and a repo's overrides get the lists it resolved to where they differ", () => {
  // No keys at all: agent defaulted to claude, review_agent to agent.
  assert.deepEqual(migrateAgentConfigurations({ backlog: 'backlog' }).json, {
    agent: [{ agent: 'claude' }],
    review_agent: [{ agent: 'claude' }],
    backlog: 'backlog',
  });
  // A Claude reviewer ran on agent_model too; a fallback equal to it adds nothing.
  assert.deepEqual(
    migrateAgentConfigurations({ agent_model: 'opus', fallback_model: 'opus', review_agent: 'claude' }).json,
    {
      agent: [{ agent: 'claude', model: 'opus' }],
      review_agent: [{ agent: 'claude', model: 'opus' }],
    },
  );
  // A Codex implementer ignored both models.
  assert.deepEqual(
    migrateAgentConfigurations({ agent: 'codex', agent_model: 'opus', fallback_model: 'sonnet' }).json.agent,
    [{ agent: 'codex' }],
  );

  const { json, changes } = migrateAgentConfigurations({
    ...LEGACY_KEYS,
    repos: {
      a: { path: '../a', overrides: { agent_model: 'sonnet', plugins: { x: {} } } },
      b: { path: '../b', overrides: { review_agent: 'codex' } },
      c: { path: '../c' },
    },
  });
  // agent_model sonnet with the top level's fallback_model sonnet: one configuration.
  assert.deepEqual(json.repos.a.overrides, { agent: [{ agent: 'claude', model: 'sonnet' }], plugins: { x: {} } });
  assert.deepEqual(json.repos.b.overrides, {}, 'the same as the top level: the top-level lists apply');
  assert.deepEqual(json.repos.c, { path: '../c' });
  assert.equal(changes.length, 3);
  // Already in the list shape: nothing to do.
  assert.deepEqual(migrateAgentConfigurations(json).changes, []);
});

test('migration_preserves_models_for_case_insensitive_provider_names', () => {
  const claude = [
    { agent: 'claude', model: 'opus' },
    { agent: 'claude', model: 'sonnet' },
  ];
  const reviewer = [{ agent: 'claude', model: 'opus' }];
  for (const name of ['claude', 'Claude', 'CLAUDE', 'cLaUdE']) {
    // Every role, at the top level.
    const top = migrateAgentConfigurations({
      agent: name,
      review_agent: name,
      agent_model: 'opus',
      fallback_model: 'sonnet',
    }).json;
    assert.deepEqual(top.agent, claude, name);
    assert.deepEqual(top.review_agent, reviewer, name);
    // review_agent inheriting agent's spelling.
    assert.deepEqual(
      migrateAgentConfigurations({ agent: name, agent_model: 'opus' }).json.review_agent,
      reviewer,
      name,
    );
    // A repo override naming the provider, with the models inherited from the top level.
    const inherited = migrateAgentConfigurations({
      agent: 'codex',
      review_agent: 'codex',
      agent_model: 'opus',
      fallback_model: 'sonnet',
      repos: { r: { overrides: { agent: name, review_agent: name } } },
    }).json;
    assert.deepEqual(inherited.repos.r.overrides, { agent: claude, review_agent: reviewer }, name);
    // A repo override setting the models, the provider inherited from the top level.
    const overridden = migrateAgentConfigurations({
      agent: name,
      review_agent: name,
      agent_model: 'opus',
      repos: { r: { overrides: { agent_model: 'haiku', fallback_model: 'sonnet' } } },
    }).json;
    assert.deepEqual(
      overridden.repos.r.overrides,
      {
        agent: [
          { agent: 'claude', model: 'haiku' },
          { agent: 'claude', model: 'sonnet' },
        ],
        review_agent: [{ agent: 'claude', model: 'haiku' }],
      },
      name,
    );
    // Another spelling of the top level's own provider is no override.
    assert.deepEqual(
      migrateAgentConfigurations({ agent: 'claude', agent_model: 'opus', repos: { r: { overrides: { agent: name } } } })
        .json.repos.r.overrides,
      {},
      name,
    );
  }
  // Codex in any spelling still drops the model.
  assert.deepEqual(migrateAgentConfigurations({ agent: 'Codex', agent_model: 'opus' }).json.agent, [
    { agent: 'codex' },
  ]);
});

/** Run `fn` with fs.`name` replaced by `make(original)`, the ESM bindings included. */
function withFs(patches, fn) {
  const saved = Object.fromEntries(Object.keys(patches).map((k) => [k, fs[k]]));
  for (const [k, make] of Object.entries(patches)) fs[k] = make(saved[k]);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    Object.assign(fs, saved);
    syncBuiltinESMExports();
  }
}

test('migration_partial_write_preserves_original_and_retry_succeeds', () => {
  const enospc = () => Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
  const staged = (p) => String(p).includes(join('.bl', 'tmp'));
  // Every way the write can fail: the staged copy cut short, the rename refused,
  // and the rename refused with the staged copy's cleanup failing too.
  const failures = {
    'partial write': () =>
      withFs.bind(null, {
        writeFileSync:
          (write) =>
          (p, text, ...rest) => {
            if (!staged(p)) return write(p, text, ...rest);
            write(p, String(text).slice(0, 25), ...rest);
            throw enospc();
          },
      }),
    'rename fails': () => (fn) => {
      _hooks.beforeRename = () => {
        throw enospc();
      };
      try {
        return fn();
      } finally {
        _hooks.beforeRename = null;
      }
    },
    'rename and cleanup fail': () => (fn) =>
      failures['rename fails']()(() =>
        withFs(
          {
            unlinkSync: (unlink) => (p) =>
              staged(p)
                ? (() => {
                    throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
                  })()
                : unlink(p),
          },
          fn,
        ),
      ),
  };
  // Both writers of backlog.json on this branch: the migration and bl init.
  const writers = {
    migration: {
      text: JSON.stringify(LEGACY_KEYS),
      run: (dir) => migrate([join(dir, 'backlog.json')]),
      done: (j) => Array.isArray(j.agent) && !Object.hasOwn(j, 'agent_model'),
    },
    'bl init': {
      text: JSON.stringify({ backlog: 'backlog' }),
      run: (dir) => ensureReposBlock(dir),
      done: (j) => Object.hasOwn(j, 'repos'),
    },
  };
  for (const [writer, w] of Object.entries(writers)) {
    for (const [failure, inject] of Object.entries(failures)) {
      const at = `${writer}, ${failure}`;
      const dir = mkTempDir('bl-migrate-fail-');
      const path = join(dir, 'backlog.json');
      writeFileSync(path, w.text);
      let threw = false;
      let exit;
      try {
        exit = inject()(() => w.run(dir));
      } catch {
        threw = true;
      }
      assert.ok(threw || exit === 1, `${at}: the failure is reported`);
      assert.equal(readFileSync(path, 'utf8'), w.text, `${at}: the original is intact`);
      if (failure !== 'rename and cleanup fail')
        assert.deepEqual(readdirSync(join(dir, '.bl', 'tmp')), [], `${at}: no staged copy left`);
      // The retry runs on the intact original and succeeds.
      const again = w.run(dir);
      if (writer === 'migration') assert.equal(again, 0, at);
      assert.ok(w.done(JSON.parse(readFileSync(path, 'utf8'))), at);
    }
  }
});

/**
 * Replacing backlog.json through `w` (the migration or `bl init`) keeps the
 * destination what it was: a symlink stays a symlink and the file it names is
 * updated, the file keeps its mode, and every failure (rename refused, mode or
 * owner not given) leaves link, file and mode unchanged.
 */
function assertPreservesDestination(name, w) {
  const eperm = (m) => Object.assign(new Error(m), { code: 'EPERM' });
  const staged = (p) => String(p).includes(join('.bl', 'tmp'));
  const failures = {
    'rename fails': (fn) => {
      _hooks.beforeRename = () => {
        throw eperm('injected rename failure');
      };
      try {
        return fn();
      } finally {
        _hooks.beforeRename = null;
      }
    },
    'mode not given': (fn) =>
      withFs(
        {
          chmodSync: () => () => {
            throw eperm('injected chmod EPERM');
          },
        },
        fn,
      ),
    // The staged copy reads as someone else's, so the owner must be given, and chown is refused.
    'owner not given': (fn) =>
      withFs(
        {
          statSync:
            (stat) =>
            (p, ...rest) =>
              staged(p) ? { ...stat(p, ...rest), uid: stat(p, ...rest).uid + 1 } : stat(p, ...rest),
          chownSync: () => () => {
            throw eperm('injected chown EPERM');
          },
        },
        fn,
      ),
  };
  for (const link of [false, true]) {
    for (const mode of [0o600, 0o640, 0o644]) {
      const at = `${name}, ${link ? 'symlink' : 'file'}, ${mode.toString(8)}`;
      const dir = mkTempDir('bl-migrate-keep-');
      const path = join(dir, 'backlog.json');
      const source = link ? join(dir, 'source.json') : path;
      writeFileSync(source, w.text);
      fs.chmodSync(source, mode);
      if (link) fs.symlinkSync(source, path);
      for (const [failure, inject] of Object.entries(failures)) {
        let threw = false;
        let exit;
        try {
          exit = inject(() => w.run(dir));
        } catch {
          threw = true;
        }
        assert.ok(threw || exit === 1, `${at}, ${failure}: the failure is reported`);
        assert.equal(fs.lstatSync(path).isSymbolicLink(), link, `${at}, ${failure}: link unchanged`);
        assert.equal(readFileSync(source, 'utf8'), w.text, `${at}, ${failure}: the original is intact`);
        assert.equal(fs.statSync(source).mode & 0o777, mode, `${at}, ${failure}: mode unchanged`);
        assert.deepEqual(readdirSync(join(dir, '.bl', 'tmp')), [], `${at}, ${failure}: no staged copy left`);
      }
      const exit = w.run(dir);
      if (name === 'migration') assert.equal(exit, 0, at);
      assert.equal(fs.lstatSync(path).isSymbolicLink(), link, `${at}: a symlink exactly when it was one`);
      assert.ok(w.done(JSON.parse(readFileSync(source, 'utf8'))), `${at}: the file the link names is the one updated`);
      assert.equal(fs.statSync(source).mode & 0o777, mode, `${at}: mode kept`);
    }
  }
}

test('migration_preserves_destination_identity_and_mode', () => {
  assertPreservesDestination('migration', {
    text: JSON.stringify(LEGACY_KEYS),
    run: (dir) => migrate([join(dir, 'backlog.json')]),
    done: (j) => Array.isArray(j.agent) && !Object.hasOwn(j, 'agent_model'),
  });
});

test('init_preserves_destination_identity_and_mode', () => {
  assertPreservesDestination('bl init', {
    text: JSON.stringify({ backlog: 'backlog' }),
    run: (dir) => ensureReposBlock(dir),
    done: (j) => Object.hasOwn(j, 'repos'),
  });
});

// S-1371: the `local` provider and --model beside -A.
const LOCAL_KEY = { url: 'http://localhost:8090', token: 'local' };
const LOCAL_QWEN = { agent: 'local', model: 'qwen3.8-27b' };

/** loadConfig's error message for a backlog.json with `patch`, or null when it loads. */
function loadError(patch, opts = {}, fixture = undefined) {
  const { dir, cleanup } = backlog(patch, fixture);
  try {
    loadConfig({ backlogRoot: dir, ...opts });
    return null;
  } catch (e) {
    return e.message;
  } finally {
    cleanup();
  }
}

test('a local list entry loads with the top-level local key and is refused without it, naming the key', () => {
  const { dir, cleanup } = backlog({ local: LOCAL_KEY, agent: [LOCAL_QWEN, { agent: 'claude' }] });
  try {
    assert.deepEqual(loadConfig({ backlogRoot: dir }).agents, [LOCAL_QWEN, { agent: 'claude', model: null }]);
  } finally {
    cleanup();
  }
  const cases = [
    [{ agent: [{ agent: 'claude' }, LOCAL_QWEN] }, /^backlog\.json "agent"\[1\]: backlog\.json "local" is missing/],
    [{ local: 'http://localhost:8090' }, /"agent"\[0\]: backlog\.json "local" must be an object/],
    [{ local: { url: 'http://localhost:8090' } }, /backlog\.json "local" "token" must be a non-empty string/],
    [{ local: { url: '', token: 'local' } }, /backlog\.json "local" "url" must be a non-empty string/],
    [{ local: { ...LOCAL_KEY, port: 8090 } }, /backlog\.json "local" has an unknown key "port"/],
    [{ local: LOCAL_KEY, agent: [{ agent: 'local' }] }, /"agent"\[0\]: .*"model": the server's alias/],
  ];
  for (const [patch, want] of cases) {
    assert.match(loadError({ agent: [LOCAL_QWEN], ...patch }) ?? 'loaded', want, JSON.stringify(patch));
  }
});

test("a repo's overrides may not set local for a local configuration; a backlog with no local configuration loads either way", () => {
  const repos = (overrides) => ({ repos: { demo: { path: '../demo-repo', overrides } } });
  assert.match(
    loadError({ local: LOCAL_KEY, agent: [LOCAL_QWEN] }, {}, repos({ local: LOCAL_KEY })) ?? 'loaded',
    /repos\["demo"\] overrides "agent"\[0\]: .*"overrides" set "local"/,
  );
  // Overrides that set local but name no local configuration: nothing reads it.
  assert.equal(loadError({ local: LOCAL_KEY }, {}, repos({ local: { url: 'x', token: 'y' } })), null);
  // No local configuration: the key is not needed, and a wrong one is not read.
  assert.equal(loadError({}), null);
  assert.equal(loadError({ local: 'nonsense' }), null);
});

test('-A local --model picks the one-entry list; -A local alone, --model alone and --model on gemini are refused', () => {
  const { dir, cleanup } = backlog({ local: LOCAL_KEY });
  try {
    const cfg = loadConfig({ backlogRoot: dir, agent: 'local', model: 'qwen3.8-27b' });
    assert.deepEqual(cfg.agents, [LOCAL_QWEN]);
    assert.equal(cfg.agentModel, 'qwen3.8-27b');
    assert.deepEqual(cfg.reviewAgents, [{ agent: 'codex', model: null }], 'review_agent stays the list');
    assert.deepEqual(loadConfig({ backlogRoot: dir, agent: 'Claude', model: 'opus' }).agents, [
      { agent: 'claude', model: 'opus' },
    ]);
    // bl review: -A with --model replaces review_agent.
    assert.deepEqual(
      loadConfig({ backlogRoot: dir, agent: 'local', model: 'qwen3.8-27b', agentRole: 'review' }).reviewAgents,
      [LOCAL_QWEN],
    );
    assert.throws(() => loadConfig({ backlogRoot: dir, agent: 'local' }), /^Error: -A local: .*"model"/);
    assert.throws(() => loadConfig({ backlogRoot: dir, model: 'x' }), /--model requires -A <provider>/);
    assert.throws(
      () => loadConfig({ backlogRoot: dir, agent: 'gemini', model: 'x' }),
      /gemini cannot select a model: drop --model/,
    );
    // parseArgs makes a valueless --model `true`.
    assert.throws(
      () => loadConfig({ backlogRoot: dir, agent: 'claude', model: true }),
      /--model must be a non-empty string/,
    );
  } finally {
    cleanup();
  }
  // -A local in a backlog with no local key.
  assert.match(
    loadError({}, { agent: 'local', model: 'qwen3.8-27b' }) ?? 'loaded',
    /^-A local: backlog\.json "local" is missing/,
  );
});

test('a reload and configForRepo keep the --model of -A', () => {
  const { dir, cleanup } = backlog(
    { local: LOCAL_KEY },
    { repos: { demo: { path: '../demo-repo', overrides: { agent: [{ agent: 'codex' }] } } } },
  );
  try {
    const cfg = loadConfig({ backlogRoot: dir, agent: 'local', model: 'qwen3.8-27b' });
    assert.deepEqual(agentFlagOf(cfg), { agent: 'local', model: 'qwen3.8-27b', role: 'agent', lenient: false });
    const repo = configForRepo(cfg, 'demo');
    assert.deepEqual(repo.agents, [LOCAL_QWEN], '-A outranks the repo list, with its model');
    assert.equal(repo.agentFlagModel, 'qwen3.8-27b');
  } finally {
    cleanup();
  }
});

test('independentReviewers keeps every cloud reviewer against a local implementer', () => {
  const cloud = [
    { agent: 'claude', model: 'qwen3.8-27b' },
    { agent: 'codex', model: null },
    { agent: 'claude', model: null },
  ];
  assert.deepEqual(independentReviewers([LOCAL_QWEN], cloud), cloud);
});

test('bl init never adds a model-less local configuration', () => {
  const c = (agent) => ({ agent });
  // Every cloud agent reviews: the implementer is a model-less one of them, not local.
  const added = initConfigurationLists({ review_agent: [c('claude'), c('codex'), c('gemini')] });
  assert.notEqual(added.agent[0].agent, 'local');
});

test("bl init -A local --model writes -A's entry with its model", () => {
  assert.deepEqual(initConfigurationLists({}, 'Local', 'qwen3.8-27b'), {
    agent: [LOCAL_QWEN],
    review_agent: [{ agent: 'claude' }],
  });
  // A valueless --model (parseArgs: true) is refused before anything is written.
  assert.throws(() => initConfigurationLists({}, 'local', true), /--model must be a non-empty string/);
  const dir = mkTempDir('bl-init-local-');
  const path = join(dir, 'backlog.json');
  writeFileSync(path, JSON.stringify({ backlog: 'backlog' }));
  ensureReposBlock(dir, 'local', 'qwen3.8-27b');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).agent, [LOCAL_QWEN]);
});
