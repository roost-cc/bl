import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { mkTempDir, mkTempBacklog } from '../helpers/tempdir.js';
import { initGitBacklog } from '../helpers/git-backlog.js';
import { pullBeforeCommand } from '../../src/sync.js';
import { loadConfig } from '../../src/config.js';
import {
  allowlistInput,
  configHash,
  ensureAllowedTools,
  GENERATOR_VERSION,
  regenReason,
} from '../../src/allowed-tools.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { g, REAL_GIT, TOOLS, PENDING } from '../helpers/backlog-commit-fixture.js';

// ---------------------------------------------------------------------------
// allowed-tools.json follows its inputs after every pull
// ---------------------------------------------------------------------------

const editJson = (root, rel, fn) => {
  const p = join(root, rel);
  const doc = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  fn(doc);
  writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
};

// What Bob pushes (a changed input, or an unrelated story when the case is
// about the shape of Alice's own allowed-tools.json) and what Alice commits
// to her allowed-tools.json beforehand.
const ALLOWED_TOOLS_PULL_CASES = [
  {
    name: 'top-level backlog.json plugin change',
    bob: (r) => editJson(r, 'backlog.json', (c) => (c.plugins.shellcheck = { lint: 'shellcheck {{path}}' })),
    expect: 'shellcheck',
  },
  {
    name: 'top-level backlog.json forge change',
    bob: (r) => editJson(r, 'backlog.json', (c) => (c.forge = 'github')),
  },
  {
    name: "a repo's override plugin change",
    bob: (r) =>
      editJson(r, 'backlog.json', (c) => {
        c.repos.extra = {
          path: '../extra',
          deployable: false,
          update_tests: [],
          overrides: { plugins: { yamllint: { lint: 'yamllint {{path}}' } } },
        };
      }),
    expect: 'yamllint',
  },
  { name: 'allowed-tools.json missing', alice: (r) => g(r, 'rm', '-q', TOOLS) },
  { name: 'stale config hash', alice: (r) => editJson(r, TOOLS, (t) => (t._generated.config_hash = 'stale')) },
  { name: 'stale generator version', alice: (r) => editJson(r, TOOLS, (t) => (t._generated.generator_version = 1)) },
  { name: 'malformed', alice: (r) => writeFileSync(join(r, TOOLS), '{ not json\n') },
  { name: 'clean and current', unchanged: true },
  {
    name: 'conflicted on both sides',
    alice: (r) => writeFileSync(join(r, TOOLS), '{"a":1}\n'),
    bob: (r) => writeFileSync(join(r, TOOLS), '{"b":1}\n'),
  },
];

const SYNC = new URL('../../src/sync.js', import.meta.url).href;

const CONFIG = new URL('../../src/config.js', import.meta.url).href;

/** `pullBeforeCommand` in a child process with `bin` first on PATH; [result, stderr]. */
function pullBeforeCommandIn(root, bin) {
  const src = `const s = await import(${JSON.stringify(SYNC)}); const c = await import(${JSON.stringify(CONFIG)});
console.log(JSON.stringify(await s.pullBeforeCommand(c.loadConfig({ backlogRoot: ${JSON.stringify(root)} }))));`;
  const r = spawnSyncFiles(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
    env: { ...process.env, ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}) },
  });
  assert.equal(r.status, 0, r.stderr);
  return [JSON.parse(r.stdout), r.stderr];
}

// Each way the regeneration after a pull can fail. `git` is a shell
// fragment run before the real git; `fixedBy` is what Bob pushes to make
// the retry go through (none: the retry is a pull that brings nothing).
const REGEN_FAILURES = [
  {
    name: 'the regeneration commit fails',
    git: `[ "$1 $2" = "commit -q" ] && { echo "injected: commit failed" >&2; exit 91; }`,
    message: /commit failed/,
  },
  {
    name: 'git status fails after the regeneration',
    git: `[ "$1" = "status" ] && [ -e ${PENDING} ] && { echo "injected: status failed" >&2; exit 91; }`,
    message: /git status failed/,
  },
  {
    name: 'the pulled configuration cannot be read (allowed-tools.json cannot be built)',
    bob: (r) =>
      editJson(r, 'backlog.json', (c) => {
        c.repos.extra = { path: '../extra', deployable: false, update_tests: [], overrides: { plugins: 'not-a-map' } };
      }),
    fixedBy: (r) =>
      editJson(r, 'backlog.json', (c) => {
        c.repos.extra = {
          path: '../extra',
          deployable: false,
          update_tests: [],
          overrides: { plugins: { yamllint: { lint: 'yamllint {{path}}' } } },
        };
      }),
    message: /./,
  },
];

test('pullBeforeCommand_retries_or_stops_after_regeneration_commit_failure', async () => {
  for (const c of REGEN_FAILURES) {
    const { dir: alice, cleanup } = mkTempBacklog({
      config: { plugins: { prettier: { format: 'prettier --write {{path}}' } } },
    });
    const tmp = mkTempDir('bl-bc-remote-');
    try {
      initGitBacklog(alice);
      await ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
      g(alice, 'add', TOOLS);
      g(alice, 'commit', '-q', '-m', 'allowed tools');
      const remote = join(tmp, 'remote.git');
      const bob = join(tmp, 'bob');
      g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
      g(alice, 'remote', 'add', 'origin', remote);
      g(alice, 'push', '-q', 'origin', 'main');
      g(tmp, 'clone', '-q', remote, bob);
      for (const [d, name] of [
        [alice, 'alice'],
        [bob, 'bob'],
      ]) {
        g(d, 'config', 'user.name', name);
        g(d, 'config', 'user.email', `${name}@t`);
      }
      const bobPushesFn = (fn) => {
        fn(bob);
        g(bob, 'add', '-A');
        g(bob, 'commit', '-q', '-m', 'bob');
        g(bob, 'push', '-q', 'origin', 'main');
      };
      // A pulled plugin change: allowed-tools.json has to be rebuilt.
      bobPushesFn(
        c.bob ??
          ((r) => editJson(r, 'backlog.json', (cfg) => (cfg.plugins.shellcheck = { lint: 'shellcheck {{path}}' }))),
      );

      const bin = join(tmp, 'fakebin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'git'), `#!/bin/sh\n${c.git ?? ''}\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
      const [res, err] = pullBeforeCommandIn(alice, bin);
      assert.equal(res.state, 'unsafe', `${c.name}: ${JSON.stringify(res)}`);
      assert.match(res.message, c.message, c.name);
      assert.match(
        err,
        /error: the backlog regeneration after the pull did not finish .*; not running the command/,
        c.name,
      );
      assert.ok(existsSync(join(alice, PENDING)), `${c.name}: the regeneration is left pending`);
      assert.notEqual(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull', c.name);

      // The next command finishes it before it runs, whether or not its pull brings anything.
      if (c.fixedBy) bobPushesFn(c.fixedBy);
      const [again] = pullBeforeCommandIn(alice, null);
      assert.equal(again.state, c.fixedBy ? 'pulled' : 'current', `${c.name}: ${JSON.stringify(again)}`);
      assert.equal(existsSync(join(alice, PENDING)), false, `${c.name}: nothing pending`);
      const cfg = loadConfig({ backlogRoot: alice });
      const tools = JSON.parse(readFileSync(join(alice, TOOLS), 'utf8'));
      assert.equal(
        regenReason(tools, { hash: configHash(allowlistInput(cfg)), version: GENERATOR_VERSION }),
        null,
        c.name,
      );
      assert.equal(g(alice, 'status', '--porcelain'), '', `${c.name}: the regeneration is committed`);
      assert.equal(g(alice, 'log', '-1', '--format=%s'), 'chore: regenerate allowed-tools.json after pull', c.name);
      assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), `${c.name}: and pushed`);
    } finally {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('pullBeforeCommand regenerates allowed-tools after a pulled configuration change without a file conflict', async () => {
  for (const c of ALLOWED_TOOLS_PULL_CASES) {
    const { dir: alice, cleanup } = mkTempBacklog({
      config: { plugins: { prettier: { format: 'prettier --write {{path}}' } } },
    });
    const tmp = mkTempDir('bl-bc-remote-');
    try {
      initGitBacklog(alice);
      await ensureAllowedTools(alice, loadConfig({ backlogRoot: alice }));
      g(alice, 'add', TOOLS);
      g(alice, 'commit', '-q', '-m', 'allowed tools');
      const remote = join(tmp, 'remote.git');
      const bob = join(tmp, 'bob');
      g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
      g(alice, 'remote', 'add', 'origin', remote);
      g(alice, 'push', '-q', 'origin', 'main');
      g(tmp, 'clone', '-q', remote, bob);
      for (const [d, name] of [
        [alice, 'alice'],
        [bob, 'bob'],
      ]) {
        g(d, 'config', 'user.name', name);
        g(d, 'config', 'user.email', `${name}@t`);
      }
      if (c.alice) {
        c.alice(alice);
        g(alice, 'add', '-A');
        g(alice, 'commit', '-q', '-m', 'alice');
      }
      (c.bob ?? ((r) => writeFileSync(join(r, 'notes.md'), 'bob\n')))(bob);
      g(bob, 'add', '-A');
      g(bob, 'commit', '-q', '-m', 'bob');
      g(bob, 'push', '-q', 'origin', 'main');
      const toolsBefore = existsSync(join(alice, TOOLS)) ? readFileSync(join(alice, TOOLS), 'utf8') : null;

      const [res] = await (async () => {
        const orig = process.stderr.write;
        process.stderr.write = () => true;
        try {
          return [await pullBeforeCommand(loadConfig({ backlogRoot: alice }))];
        } finally {
          process.stderr.write = orig;
        }
      })();
      assert.equal(res.state, 'pulled', `${c.name}: ${res.message}`);

      const cfg = loadConfig({ backlogRoot: alice });
      const text = readFileSync(join(alice, TOOLS), 'utf8');
      const reason = regenReason(JSON.parse(text), {
        hash: configHash(allowlistInput(cfg)),
        version: GENERATOR_VERSION,
      });
      assert.equal(reason, null, `${c.name}: allowed-tools.json is current`);
      if (c.expect) assert.ok(text.includes(c.expect), `${c.name}: ${c.expect} in allowed-tools.json`);
      if (c.unchanged) assert.equal(text, toolsBefore, c.name);
      assert.equal(g(alice, 'status', '--porcelain'), '', `${c.name}: the regeneration is committed`);
      assert.equal(g(remote, 'rev-parse', 'main'), g(alice, 'rev-parse', 'HEAD'), `${c.name}: and pushed`);
    } finally {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});
