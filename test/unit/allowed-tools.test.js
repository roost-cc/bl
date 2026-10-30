import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import {
  generateAllowedTools,
  ensureAllowedTools,
  allowlistInput,
  configHash,
  regenReason,
  resolveAllowedTokens,
  GENERATOR_VERSION,
} from '../../src/allowed-tools.js';
import { _hooks } from '../../src/atomic-write.js';
import { mkTempDir } from '../helpers/tempdir.js';

function fakeConfig(extra = {}) {
  return {
    raw: {
      plugins: extra.plugins ?? {},
      ...(extra.forge ? { forge: extra.forge } : {}),
    },
    plugins: extra.plugins ?? {},
  };
}

/**
 * Run `fn` with `process.stderr.write` stubbed; returns its result and the
 * captured lines. `info` writes through `process.stderr.write` at call time,
 * so the regen log line lands here.
 */
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { result: fn(), lines };
  } finally {
    process.stderr.write = orig;
  }
}

/** `ensureAllowedTools` with the regen line captured instead of printed. */
function ensure(dir, cfg) {
  return captureStderr(() => ensureAllowedTools(dir, cfg));
}

/** Like `ensure`, but returns the thrown error (`err`) instead of propagating it. */
function ensureFailing(dir, cfg) {
  let err = null;
  const { lines } = captureStderr(() => {
    try {
      ensureAllowedTools(dir, cfg);
    } catch (e) {
      err = e;
    }
  });
  return { err, lines };
}

const SESSION_PLUGIN = {
  'session-stack': {
    workon: '{{roostDir}}/containers/scripts/session up {{sessionId}}',
    cleanup: '{{roostDir}}/containers/scripts/session down {{sessionId}}',
  },
};
const TOP_LEVEL = {
  plugins: {
    prettier: { format: '{{roostDir}}/tools/bin/prettier --write {{path}}' },
    github: { 'pr.diff': 'gh pr diff {{number}}' },
  },
  forge: 'github',
};

/**
 * A `configForRepo`-shaped config for `repoName`: each `repos` entry's
 * `overrides.plugins` is the given plugin map (none for null), and `raw` is
 * the top level with `repoName`'s plugins merged in.
 */
function repoConfig(root, repos, repoName, topLevel = TOP_LEVEL) {
  const out = {};
  for (const [name, plugins] of Object.entries(repos)) {
    out[name] = {
      name,
      path: join(root, '..', name),
      deployable: false,
      updateTests: [],
      plugins: {},
      overrides: plugins === null ? null : { plugins },
    };
  }
  const raw = {
    ...topLevel,
    plugins: { ...topLevel.plugins, ...(repos[repoName] ?? {}) },
  };
  return {
    backlogRoot: root,
    roostDir: '/roost',
    topLevel,
    repos: out,
    repoName,
    raw,
    plugins: raw.plugins,
  };
}

test('generateAllowedTools includes baseline + plugin leaders, no ppp/pnpm hardcoded', () => {
  const cfg = fakeConfig({
    plugins: {
      md: { format: 'prettier --write {{path}}' },
      'node-ws': { bootstrap: 'pnpm install --no-frozen-lockfile' },
    },
  });
  const out = generateAllowedTools(cfg);
  assert.ok(out.base.includes('git:*'), 'baseline git missing');
  assert.ok(out.base.includes('bl:*'), 'baseline bl missing');
  assert.ok(out.base.includes('node:*'), 'baseline node missing');
  // From plugins
  assert.ok(out.base.includes('prettier:*'), 'prettier leader missing');
  assert.ok(out.base.includes('pnpm:*'), 'pnpm leader missing');
  // Should NOT contain ppp anymore
  assert.ok(!out.base.includes('ppp:*'), 'ppp must not be in baseline');
});

test('generateAllowedTools keeps a {{roostDir}} plugin leader templated', () => {
  // The file is committed and shared: the v7 generator resolved the leader
  // into this machine's absolute path, which every regeneration wrote back
  // after it was removed by hand. The leader stays templated (and is not
  // mangled to `roostDir}}/...` either); `resolveAllowedTokens` makes it
  // absolute at session build.
  const cfg = {
    roostDir: '/home/someone/work/acme',
    backlogRoot: '/home/someone/work/acme/backlog',
    raw: {
      plugins: {
        prettier: {
          format: '{{roostDir}}/tools/node_modules/.bin/prettier --write {{path}}',
        },
        'app-roost/session-stack': SESSION_PLUGIN['session-stack'],
      },
    },
  };
  const out = generateAllowedTools(cfg);
  assert.ok(out.base.includes('{{roostDir}}/tools/node_modules/.bin/prettier:*'), 'templated prettier rule missing');
  assert.ok(out.base.includes('{{roostDir}}/containers/scripts/session:*'), 'templated session rule missing');
  const text = JSON.stringify(out);
  assert.ok(!text.includes('/home/'), 'no machine-specific path');
  assert.ok(!/(?<!\{)roostDir\}\}/.test(text), 'no mangled roostDir}} token');
  assert.ok(!out.base.some((p) => p.startsWith('/')), 'no base token starts with /');
});

test('resolveAllowedTokens resolves, passes through and drops', () => {
  const input = [
    'git:*',
    '{{roostDir}}/tools/bin/prettier:*',
    '{{backlogRoot}}/bin/tool:*',
    'Bash(rm {{roostDir}}/tmp/*)',
  ];
  const snapshot = [...input];
  assert.deepEqual(resolveAllowedTokens(input, { roostDir: '/roost', backlogRoot: '/b' }), [
    'git:*',
    '/roost/tools/bin/prettier:*',
    '/b/bin/tool:*',
    'Bash(rm /roost/tmp/*)',
  ]);
  // Only what can be resolved is kept; a plain token passes through.
  assert.deepEqual(resolveAllowedTokens(input, { roostDir: '/roost' }), [
    'git:*',
    '/roost/tools/bin/prettier:*',
    'Bash(rm /roost/tmp/*)',
  ]);
  for (const vars of [undefined, {}, { roostDir: '' }, { roostDir: null }]) {
    assert.deepEqual(resolveAllowedTokens(input, vars), ['git:*']);
  }
  assert.deepEqual(input, snapshot, 'input array must not be mutated');
  // A `$` in a path is literal: `$&` must not re-insert the placeholder
  // (which would then drop the rule).
  assert.deepEqual(resolveAllowedTokens(['{{roostDir}}/x:*'], { roostDir: '/a$&b' }), ['/a$&b/x:*']);
  const plain = ['git:*'];
  assert.notEqual(resolveAllowedTokens(plain), plain, 'a new array is returned');
  assert.deepEqual(resolveAllowedTokens([]), []);
  assert.deepEqual(resolveAllowedTokens(undefined), []);
});

test('generateAllowedTools emits the review-mode deny list', () => {
  const out = generateAllowedTools(fakeConfig());
  assert.deepEqual(out.deny.review, ['bl block remove:*', 'bl task done:*', 'gh pr merge:*', 'git push:*']);
  // F-48 D5: no mode is granted the forge CLI; bl makes every forge call.
  // F-66 A7 (v14): every mode denies bl block remove; F-65 D3 (v15): and bl task done.
  assert.equal(GENERATOR_VERSION, 15);
  for (const [mode, tokens] of Object.entries({
    base: out.base,
    workon: out.workon,
    refine: out.refine,
    review: out.review,
    triage: out.triage,
  })) {
    assert.ok(!tokens.some((t) => /^gh[ :]/.test(t)), `${mode} has a gh rule`);
  }
  // Review has the forge and push denials; other modes must not gain them silently.
  assert.deepEqual(Object.keys(out.deny).sort(), ['refine', 'review', 'triage', 'workon']);
  for (const mode of ['refine', 'triage', 'workon']) {
    assert.deepEqual(out.deny[mode], ['bl block remove:*', 'bl task done:*'], mode);
  }
});

test('bl task and bl task list stay allowed through bl:*, bl task done is denied in every mode (F-65 D3)', () => {
  const out = generateAllowedTools(fakeConfig());
  assert.ok(out.base.includes('bl:*'));
  for (const mode of ['workon', 'refine', 'review', 'triage']) {
    assert.ok(out.deny[mode].includes('bl task done:*'), mode);
    // Prefix-matched: `bl task F-1 …` and `bl task list` match no deny token.
    for (const cmd of ['bl task F-1 --title x', 'bl task list --open']) {
      assert.ok(!out.deny[mode].some((t) => cmd.startsWith(t.replace(/:\*$/, ''))), `${mode}: ${cmd}`);
    }
  }
});

test('bl block add and list stay allowed through bl:*, remove is denied in every mode (F-66 A7)', () => {
  const out = generateAllowedTools(fakeConfig());
  assert.ok(out.base.includes('bl:*'));
  for (const mode of ['workon', 'refine', 'review', 'triage']) {
    assert.ok(out.deny[mode].includes('bl block remove:*'), mode);
    assert.ok(!out.deny[mode].some((t) => t.startsWith('bl block add') || t.startsWith('bl block list')), mode);
  }
});

test('generateAllowedTools header carries hash and version, no timestamp', () => {
  const cfg = fakeConfig();
  const out = generateAllowedTools(cfg);
  assert.equal(out._generated.generator_version, GENERATOR_VERSION);
  assert.match(out._generated.config_hash, /^[0-9a-f]{64}$/);
  // A timestamp was the one field that differed between two equal regens
  // and kept the committed file showing up as modified.
  assert.ok(!('generated_at' in out._generated), 'header must not carry generated_at');
  assert.deepEqual(Object.keys(out._generated), ['config_hash', 'generator_version']);
});

test("configHash is canonical: key order in plugins doesn't matter", () => {
  const a = fakeConfig({
    plugins: { x: { format: 'fa' }, y: { lint: 'fb' } },
  });
  const b = fakeConfig({
    plugins: { y: { lint: 'fb' }, x: { format: 'fa' } },
  });
  assert.equal(configHash(a), configHash(b));
});

test('configHash differs when plugin command changes', () => {
  const a = fakeConfig({ plugins: { x: { format: 'fa' } } });
  const b = fakeConfig({ plugins: { x: { format: 'fb' } } });
  assert.notEqual(configHash(a), configHash(b));
});

// ---------------------------------------------------------------------------
// Repo-independent input (S-829)
// ---------------------------------------------------------------------------

test('allowlistInput: same hash and bytes from any repo of one backlog', () => {
  const root = mkTempDir('bl-allow-');
  const repos = { 'app.acme.com': SESSION_PLUGIN, bl: null };
  const inApp = repoConfig(root, repos, 'app.acme.com');
  const inInfra = repoConfig(root, repos, 'bl');

  // The repo-scoped slice differs (that was the bug) …
  assert.notEqual(configHash(inApp), configHash(inInfra));
  // … the union does not.
  assert.equal(configHash(allowlistInput(inApp)), configHash(allowlistInput(inInfra)));

  const path = join(root, 'allowed-tools.json');
  ensure(root, inApp);
  const bytesA = readFileSync(path, 'utf8');
  const mtimeA = statSync(path).mtimeMs;
  const { lines } = ensure(root, inInfra);
  const bytesB = readFileSync(path, 'utf8');
  assert.equal(bytesB, bytesA, 'a repo switch must not rewrite the file');
  assert.equal(statSync(path).mtimeMs, mtimeA, 'mtime must not change');
  assert.deepEqual(lines, [], 'a current file logs nothing');
});

test('allowlistInput: no repos, no topLevel → the top-level slice alone', () => {
  const cfg = fakeConfig({ plugins: { x: { format: 'fa' } }, forge: 'x' });
  const input = allowlistInput(cfg);
  assert.deepEqual(input.raw, { plugins: { x: { format: 'fa' } }, forge: 'x' });
  assert.equal(configHash(input), configHash(cfg));
  // `repos` present but empty, and a repo without overrides, contribute
  // nothing either.
  const root = mkTempDir('bl-allow-');
  const bare = repoConfig(root, { docs: null }, 'docs');
  assert.deepEqual(allowlistInput(bare).raw, {
    plugins: TOP_LEVEL.plugins,
    forge: 'github',
  });
  assert.deepEqual(allowlistInput({ ...bare, repos: {} }).raw, {
    plugins: TOP_LEVEL.plugins,
    forge: 'github',
  });
});

test("allowlistInput: a repo's override plugins are keyed <repo>/<name>; forge stays top-level", () => {
  const root = mkTempDir('bl-allow-');
  // app.acme.com overrides prettier with a different command: both leaders must
  // be generated, and the bare-string forge must still resolve top-level.
  const override = { prettier: { format: 'npx prettier --write {{path}}' } };
  const cfg = repoConfig(root, { 'app.acme.com': { ...SESSION_PLUGIN, ...override } }, 'app.acme.com');
  const input = allowlistInput(cfg);
  assert.deepEqual(Object.keys(input.raw.plugins).sort(), [
    'app.acme.com/prettier',
    'app.acme.com/session-stack',
    'github',
    'prettier',
  ]);
  assert.equal(input.raw.forge, 'github');
  assert.equal(input.roostDir, '/roost');
  assert.equal(input.backlogRoot, root);
  const out = generateAllowedTools(input);
  assert.ok(out.base.includes('{{roostDir}}/tools/bin/prettier:*'));
  assert.ok(out.base.includes('npx:*'));
  assert.ok(out.base.includes('{{roostDir}}/containers/scripts/session:*'));
  assert.ok(!out.base.some((p) => p.startsWith('/roost')), "the input's roostDir must not reach the file");
  assert.deepEqual(out.review, [], 'the forge plugin grants review nothing (F-42 D4)');
});

test('allowlistInput rejects malformed top-level and repo override plugin maps and definitions', () => {
  // A map or definition of the wrong shape would be hashed (so the header
  // claims to cover it) while the generator silently emitted no leader for
  // it. Every source and every malformed shape must throw instead, naming
  // the file; an absent map still contributes nothing.
  const maps = [
    ['string map', 'not-a-map'],
    ['number map', 42],
    ['array map', ['unsafefoo run']],
    ['string definition', { tool: 'unsafefoo run' }],
    ['number definition', { tool: 7 }],
    ['array definition', { tool: ['unsafefoo run'] }],
    ['null definition', { tool: null }],
  ];
  for (const [label, malformed] of maps) {
    // Repo-level source.
    const root = mkTempDir('bl-allow-');
    const proj = repoConfig(root, { bad: malformed }, 'bad');
    assert.throws(
      () => allowlistInput(proj),
      /backlog\.json repos\["bad"\]\.overrides.*plugin/,
      `repo ${label} must throw`,
    );
    // Top-level source, via `topLevel` …
    const top = { backlogRoot: root, topLevel: { plugins: malformed } };
    assert.throws(() => allowlistInput(top), /backlog\.json.*plugin/, `topLevel ${label} must throw`);
    // … via the `raw.plugins` fallback …
    assert.throws(() => allowlistInput({ raw: { plugins: malformed } }), /plugin/, `raw ${label} must throw`);
    // … and via the bare `plugins` fallback.
    assert.throws(() => allowlistInput({ plugins: malformed }), /plugin/, `plugins ${label} must throw`);
  }
  // Absent or null maps are not malformed: they contribute nothing.
  for (const absent of [undefined, null]) {
    const root = mkTempDir('bl-allow-');
    const proj = repoConfig(root, { empty: null }, 'empty');
    proj.repos.empty.overrides = absent === undefined ? {} : { plugins: null };
    assert.deepEqual(allowlistInput(proj).raw.plugins, TOP_LEVEL.plugins);
    assert.deepEqual(allowlistInput({ topLevel: { plugins: absent } }).raw.plugins, {});
  }
  // A well-formed definition with non-string fields (e.g. `extensions`)
  // is still accepted: only the map and definition shapes are checked.
  const ok = allowlistInput({
    raw: { plugins: { md: { format: 'prettier', extensions: ['.md'] } } },
  });
  assert.deepEqual(Object.keys(ok.raw.plugins), ['md']);
});

test('ensureAllowedTools: a legacy absolute-path leader regenerates to the templated token', () => {
  // A checkout whose file was written by the v7–v9 generators holds this
  // machine's absolute prettier path in `base`. The version bump
  // regenerates it; the absolute form is config-derived (the TOP_LEVEL
  // fixture's leader resolved with the fixture's `roostDir`), so it must
  // not be rescued into `extra` — that would put the path straight back.
  const root = mkTempDir('bl-allow-');
  const path = join(root, 'allowed-tools.json');
  const cfg = repoConfig(root, { docs: null }, 'docs');
  const fresh = generateAllowedTools(allowlistInput(cfg));
  writeFileSync(
    path,
    JSON.stringify({
      _generated: {
        config_hash: fresh._generated.config_hash,
        generator_version: 9,
      },
      base: ['/roost/tools/bin/prettier:*', 'git:*'],
      extra: [],
    }) + '\n',
  );
  const { result: out, lines } = ensure(root, cfg);
  assert.deepEqual(lines, [`allowed-tools.json regenerated: generator version 9→${GENERATOR_VERSION}\n`]);
  assert.ok(out.base.includes('{{roostDir}}/tools/bin/prettier:*'));
  assert.ok(!out.base.includes('/roost/tools/bin/prettier:*'));
  assert.deepEqual(out.extra, []);
  const onDisk = readFileSync(path, 'utf8');
  assert.ok(!onDisk.includes('/roost'), 'no absolute path on disk');
  // The same absolute token declared in `extra` is dropped too.
  writeFileSync(
    path,
    JSON.stringify({
      _generated: { config_hash: 'stale', generator_version: 9 },
      base: ['git:*'],
      extra: ['/roost/tools/bin/prettier:*', 'my-tool:*'],
    }) + '\n',
  );
  assert.deepEqual(ensure(root, cfg).result.extra, ['my-tool:*']);
});

test("ensureAllowedTools: a repo override's leader lands in base, not extra", () => {
  const root = mkTempDir('bl-allow-');
  const path = join(root, 'allowed-tools.json');
  const leader = '{{roostDir}}/containers/scripts/session:*';
  // The committed roost file: the session leader misclassified as a user
  // addition by an infrastructure regen, plus a real user addition.
  writeFileSync(
    path,
    JSON.stringify({
      _generated: {
        config_hash: 'stale',
        generator_version: GENERATOR_VERSION,
      },
      base: [leader, 'my-tool:*', 'git:*'],
      extra: [leader, 'my-tool:*'],
    }) + '\n',
  );
  const cfg = repoConfig(root, { 'app.acme.com': SESSION_PLUGIN, bl: null }, 'bl');
  const { result: out } = ensure(root, cfg);
  assert.ok(out.base.includes(leader), 'generated leader must be in base');
  assert.ok(!out.extra.includes(leader), 'generated leader must leave extra');
  assert.ok(out.base.includes('my-tool:*'), 'user addition stays in base');
  assert.deepEqual(out.extra, ['my-tool:*'], 'user addition stays in extra');
});

test('ensureAllowedTools: two regenerations produce identical bytes', () => {
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  const dirs = [1, 2].map(() => mkTempDir('bl-allow-'));
  const [a, b] = dirs.map((dir) => {
    ensure(dir, cfg);
    return readFileSync(join(dir, 'allowed-tools.json'), 'utf8');
  });
  assert.equal(a, b);
});

test("ensureAllowedTools: concurrent regenerations do not consume each other's staging file", () => {
  const dir = mkTempDir('bl-allow-');
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  const staged = [];
  let second = null;
  // The first caller, between its write and its rename, runs the second
  // caller to completion; the second's own hook call only records its path.
  _hooks.beforeRename = (tmp) => {
    staged.push(tmp);
    _hooks.beforeRename = (t) => staged.push(t);
    second = ensure(dir, cfg);
  };
  try {
    const first = ensure(dir, cfg);
    assert.equal(staged.length, 2, 'both callers reached the rename');
    assert.notEqual(staged[0], staged[1], 'staging paths differ');
    for (const tmp of staged) {
      assert.equal(dirname(tmp), join(dir, '.bl', 'tmp'), 'staged in .bl/tmp');
      assert.match(basename(tmp), new RegExp(`^allowed-tools\\.json\\.${process.pid}\\.[a-z0-9]+\\.tmp$`));
    }
    const text = readFileSync(join(dir, 'allowed-tools.json'), 'utf8');
    assert.ok(JSON.parse(text));
    const texts = [first, second].map((r) => JSON.stringify(r.result, null, 2) + '\n');
    assert.ok(texts.includes(text), "final file is one caller's output");
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith('.tmp')),
      [],
    );
    assert.deepEqual(readdirSync(join(dir, '.bl', 'tmp')), []);
  } finally {
    _hooks.beforeRename = null;
  }
});

test('ensureAllowedTools: a failed rename leaves no staging file', () => {
  const dir = mkTempDir('bl-allow-');
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  _hooks.beforeRename = (tmp) => unlinkSync(tmp);
  try {
    const { err, lines } = ensureFailing(dir, cfg);
    assert.equal(err?.code, 'ENOENT');
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith('.tmp')),
      [],
    );
    assert.deepEqual(readdirSync(join(dir, '.bl', 'tmp')), []);
    assert.deepEqual(lines, [], 'nothing left behind, nothing reported');
    assert.ok(!existsSync(join(dir, 'allowed-tools.json')));
  } finally {
    _hooks.beforeRename = null;
  }
});

test('ensureAllowedTools: a failed write propagates and leaves no staging file', () => {
  const parent = mkTempDir('bl-allow-');
  const dir = join(parent, 'missing');
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  // The backlog root does not exist, so creating .bl/tmp in it throws and
  // nothing is created.
  const { err, lines } = ensureFailing(dir, cfg);
  assert.equal(err?.code, 'ENOENT');
  assert.deepEqual(readdirSync(parent), []);
  assert.deepEqual(lines, [], 'nothing left behind, nothing reported');
});

test('ensureAllowedTools: old-style file with generated_at is left alone', () => {
  const dir = mkTempDir('bl-allow-');
  const path = join(dir, 'allowed-tools.json');
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  ensure(dir, cfg);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  onDisk._generated.generated_at = '2020-01-01T00:00:00.000Z';
  const oldStyle = JSON.stringify(onDisk, null, 2) + '\n';
  writeFileSync(path, oldStyle);
  const { result, lines } = ensure(dir, cfg);
  assert.equal(readFileSync(path, 'utf8'), oldStyle, 'must not rewrite');
  assert.deepEqual(lines, []);
  assert.equal(result._generated.generated_at, '2020-01-01T00:00:00.000Z');
});

test('regenReason: null for a current file, the trigger string otherwise', () => {
  const hash = 'a'.repeat(64);
  const version = GENERATOR_VERSION;
  const current = {
    _generated: { config_hash: hash, generator_version: version },
  };
  assert.equal(regenReason(current, { hash, version }), null);
  assert.equal(
    regenReason({ _generated: { ...current._generated, generated_at: '2020-01-01' } }, { hash, version }),
    null,
    'generated_at alone is not a trigger',
  );
  assert.equal(regenReason(null, { hash, version }), 'missing');
  assert.equal(regenReason(new SyntaxError('bad'), { hash, version }), 'unparseable');
  assert.equal(regenReason([], { hash, version }), 'unparseable', 'a JSON array is not an allowlist object');
  assert.equal(
    regenReason(
      {
        _generated: { config_hash: 'deadbeefcafe', generator_version: version },
      },
      { hash, version },
    ),
    'config hash deadbeef→aaaaaaaa',
  );
  assert.equal(
    regenReason({ _generated: { config_hash: hash, generator_version: version - 1 } }, { hash, version }),
    `generator version ${version - 1}→${version}`,
  );
  assert.equal(
    regenReason({ base: [] }, { hash, version }),
    'config hash none→aaaaaaaa',
    'a file without a header reads as a hash mismatch',
  );
});

// ---------------------------------------------------------------------------
// Lazy regeneration
// ---------------------------------------------------------------------------

test('ensureAllowedTools regenerates on missing file', () => {
  const dir = mkTempDir('bl-allow-');
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  const { result: out, lines } = ensure(dir, cfg);
  const path = join(dir, 'allowed-tools.json');
  assert.ok(existsSync(path));
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk._generated.config_hash, out._generated.config_hash);
  assert.ok(onDisk.base.includes('prettier:*'));
  assert.deepEqual(lines, ['allowed-tools.json regenerated: missing\n']);
});

test('ensureAllowedTools regenerates on hash mismatch', () => {
  const dir = mkTempDir('bl-allow-');
  const path = join(dir, 'allowed-tools.json');
  // Seed with a stale-hash file.
  writeFileSync(
    path,
    JSON.stringify({
      _generated: {
        config_hash: 'deadbeef',
        generator_version: GENERATOR_VERSION,
      },
      base: ['stale:*'],
    }) + '\n',
  );
  const cfg = fakeConfig({ plugins: { x: { format: 'freshcmd' } } });
  const { result: out, lines } = ensure(dir, cfg);
  assert.notEqual(out._generated.config_hash, 'deadbeef');
  assert.ok(out.base.includes('freshcmd:*'));
  const fresh8 = out._generated.config_hash.slice(0, 8);
  assert.deepEqual(lines, [`allowed-tools.json regenerated: config hash deadbeef→${fresh8}\n`]);
});

test('ensureAllowedTools is a no-op when hash and version match', () => {
  const dir = mkTempDir('bl-allow-');
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  ensure(dir, cfg);
  const path = join(dir, 'allowed-tools.json');
  const before = readFileSync(path, 'utf8');
  const mtime = statSync(path).mtimeMs;
  const { lines } = ensure(dir, cfg);
  const after = readFileSync(path, 'utf8');
  assert.equal(before, after, 'second call must not rewrite the file');
  assert.equal(statSync(path).mtimeMs, mtime, 'second call must not write');
  assert.deepEqual(lines, []);
});

test('ensureAllowedTools regenerates on JSON parse failure', () => {
  const dir = mkTempDir('bl-allow-');
  const path = join(dir, 'allowed-tools.json');
  writeFileSync(path, 'not json{');
  const cfg = fakeConfig();
  const { result: out, lines } = ensure(dir, cfg);
  assert.ok(Array.isArray(out.base));
  assert.deepEqual(lines, ['allowed-tools.json regenerated: unparseable\n']);
});

test('ensureAllowedTools treats a non-object document as unparseable', () => {
  const dir = mkTempDir('bl-allow-');
  const path = join(dir, 'allowed-tools.json');
  // Valid JSON, but an array has no header and no allowlist to recover.
  writeFileSync(path, '[]\n');
  const { result: out, lines } = ensure(dir, fakeConfig());
  assert.ok(Array.isArray(out.base));
  assert.deepEqual(lines, ['allowed-tools.json regenerated: unparseable\n']);
  assert.ok(JSON.parse(readFileSync(path, 'utf8'))._generated);
});

test('ensureAllowedTools preserves user-added `extra` entries across regen', () => {
  const dir = mkTempDir('bl-allow-');
  const path = join(dir, 'allowed-tools.json');
  // Initial generation against config A.
  const cfgA = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  ensure(dir, cfgA);
  // Simulate a user pattern added to `extra`.
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  onDisk.extra = [...(onDisk.extra ?? []), 'my-custom-tool:*'];
  onDisk.base = [...(onDisk.base ?? []), 'my-custom-tool:*'].sort();
  writeFileSync(path, JSON.stringify(onDisk, null, 2) + '\n');
  // Bump config (changes hash → forces regen).
  const cfgB = fakeConfig({
    plugins: {
      md: { format: 'prettier {{path}}' },
      py: { format: 'ruff {{path}}' },
    },
  });
  const { result: out } = ensure(dir, cfgB);
  assert.ok(out.base.includes('my-custom-tool:*'), 'user pattern must survive in base');
  assert.ok(out.extra.includes('my-custom-tool:*'), 'user pattern must survive in extra');
  assert.ok(out.base.includes('ruff:*'), 'new plugin leader still added');
});

test('ensureAllowedTools recovers legacy user additions found only in base', () => {
  // A backlog from before the `extra` field existed: `bl allow` wrote
  // straight into `base`. The first regen after upgrading bl must rescue
  // those patterns rather than nuke them.
  const dir = mkTempDir('bl-allow-');
  const path = join(dir, 'allowed-tools.json');
  writeFileSync(
    path,
    JSON.stringify({
      _generated: {
        config_hash: 'stale',
        generator_version: GENERATOR_VERSION,
      },
      base: ['legacy-tool:*'],
    }) + '\n',
  );
  const cfg = fakeConfig({ plugins: { md: { format: 'prettier {{path}}' } } });
  const { result: out } = ensure(dir, cfg);
  assert.ok(out.base.includes('legacy-tool:*'));
  assert.ok(out.extra.includes('legacy-tool:*'));
});

test('ensureAllowedTools regenerates on generator version mismatch', () => {
  const dir = mkTempDir('bl-allow-');
  const path = join(dir, 'allowed-tools.json');
  const cfg = fakeConfig();
  const fresh = generateAllowedTools(cfg);
  // Seed with a file whose hash matches but version is older. The old-style
  // `generated_at` is tolerated and goes with the rewrite.
  writeFileSync(
    path,
    JSON.stringify({
      _generated: {
        config_hash: fresh._generated.config_hash,
        generator_version: GENERATOR_VERSION - 1,
        generated_at: '2020-01-01T00:00:00.000Z',
      },
      base: ['old:*'],
    }) + '\n',
  );
  const { result: out, lines } = ensure(dir, cfg);
  assert.equal(out._generated.generator_version, GENERATOR_VERSION);
  assert.ok(!('generated_at' in out._generated));
  assert.deepEqual(lines, [
    `allowed-tools.json regenerated: generator version ${GENERATOR_VERSION - 1}→${GENERATOR_VERSION}\n`,
  ]);
});

test('generateAllowedTools preserves templated leaders inside shell wrappers', () => {
  // `commandLeader`'s brace strip must stop at a `{{var}}` token in every
  // shape the generator reads: a parenthesized `({{roostDir}}/bin/tool)`
  // used to regenerate the forbidden `roostDir}}/bin/tool:*`, and the
  // whitespace-separated brace group / spaced subshell used to yield no
  // leader at all. Both vars, every shape: the leader lands in `base`. (The
  // forge plugin contributes no leader and no mode rule since F-42 D4.)
  const mangled = /(?<!\{)(roostDir|backlogRoot)\}\}/;
  for (const v of ['roostDir', 'backlogRoot']) {
    const leader = `{{${v}}}/bin/tool`;
    const shapes = {
      bare: `${leader} pr --flag`,
      'env-prefixed': `CI=true ${leader} pr --flag`,
      parenthesized: `(${leader} pr --flag)`,
      'brace-prefixed': `{${leader} pr --flag; }`,
      'brace group': `{ ${leader} pr --flag; }`,
      'spaced subshell': `( ${leader} pr --flag )`,
      'env inside brace group': `{ CI=true ${leader} pr --flag; }`,
      'one-arg subshell': `(${leader} pr)`,
    };
    for (const [shape, cmd] of Object.entries(shapes)) {
      const out = generateAllowedTools(fakeConfig({ plugins: { p: { run: cmd } } }));
      const where = `${v} ${shape}`;
      assert.ok(out.base.includes(`${leader}:*`), `${where}: leader`);
      assert.ok(!mangled.test(JSON.stringify(out)), `${where}: mangled`);
      assert.ok(!out.base.some((p) => p.startsWith('/')), `${where}: absolute path`);
    }
  }
});

test('generateAllowedTools emits a plain leader for brace groups and spaced subshells', () => {
  // A plugin written as `{ cmd; }` got no `cmd:*` rule (the bare `{`
  // stripped to nothing) and `{cmd;}` / `(cmd)` emitted `cmd;}:*` /
  // `cmd):*`, which never match, and `{ CI=true cmd; }` emitted
  // `CI=true:*`. Every shape: `cmd:*` is present and no base token is a
  // bare grouping character, an env assignment, or ends in shell
  // punctuation.
  const bad = /^[({]?:\*$|[;})]:\*$|^[A-Z_]+=/;
  const shapes = {
    'brace group': '{ cmd pr --flag; }',
    'spaced subshell': '( cmd pr --flag )',
    'env inside brace group': '{ CI=true cmd pr --flag; }',
    'one-token brace group': '{ cmd; }',
    'attached brace group': '{cmd;}',
    'attached subshell': '(cmd)',
    'trailing semicolon': 'cmd;',
  };
  for (const [shape, cmd] of Object.entries(shapes)) {
    const out = generateAllowedTools(fakeConfig({ plugins: { p: { run: cmd } } }));
    assert.ok(out.base.includes('cmd:*'), `${shape}: leader`);
    const offenders = out.base.filter((t) => bad.test(t));
    assert.deepEqual(offenders, [], `${shape}: punctuation tokens`);
  }
});

test('generateAllowedTools: the forge plugin grants no mode anything, whatever its shape (F-42 D4)', () => {
  // bl makes every forge call, so neither a bare-string forge's plugin nor
  // the retired object-form `forge: { plugins }` contributes a leader or a
  // two-word mode rule. A wrapped or env-prefixed command changes nothing.
  for (const two of ['gh pr', 'glab mr']) {
    const [leader] = two.split(' ');
    const shapes = {
      bare: `${two} create --title {{title}}`,
      'env-prefixed': `CI=true ${two} create --title {{title}}`,
      parenthesized: `(${two} view {{number}})`,
      'brace group': `{ ${two} view {{number}}; }`,
    };
    for (const [shape, cmd] of Object.entries(shapes)) {
      const loops = {
        'forge object': fakeConfig({ forge: { plugins: { workon: cmd, review: cmd } } }),
        'forge string': fakeConfig({ forge: 'f', plugins: { f: { 'change.open': cmd, 'change.find': cmd } } }),
      };
      for (const [loop, cfg] of Object.entries(loops)) {
        const out = generateAllowedTools(cfg);
        const where = `${two} ${shape} ${loop}`;
        assert.deepEqual(out.workon, [], `${where}: workon`);
        assert.deepEqual(out.review, [], `${where}: review`);
        assert.deepEqual(out.refine, ['bl new:*'], `${where}: refine`);
        if (leader !== 'gh') assert.ok(!out.base.includes(`${leader}:*`), `${where}: no forge leader in base`);
      }
    }
  }
});

test('ensureAllowedTools preserves same-suffix user grants outside the configured roots in base and extra', () => {
  // A declared token is dropped only when it is an exact generated token or
  // a generated templated leader resolved with the input's configured
  // `roostDir` / `backlogRoot` (the absolute form a pre-v10 generator wrote
  // on this checkout). A user grant whose shape merely resembles a leader —
  // the same suffix under another root, another machine's root, a multi-
  // placeholder leader with the wrong middle — is never inferred to be
  // generated, so it survives in `base` and in `extra` alike. The fixture's
  // roots are `roostDir: /roost` and `backlogRoot: <root>`.
  const topLevel = {
    ...TOP_LEVEL,
    plugins: {
      ...TOP_LEVEL.plugins,
      hook: { lint: '{{backlogRoot}}/bin/tool {{path}}' },
      pair: { run: '{{roostDir}}/x/{{backlogRoot}}/bin/pair' },
    },
  };
  const userGrants = [
    '/opt/company/tools/bin/prettier:*',
    '/home/alice/work/acme/tools/bin/prettier:*',
    '/old/roost/tools/bin/prettier:*',
    '/home/alice/work/acme/backlog/bin/tool:*',
    '/roost/x/elsewhere/bin/pair:*',
    'my-tool:*',
  ];
  for (const section of ['base', 'extra']) {
    const root = mkTempDir('bl-allow-');
    const path = join(root, 'allowed-tools.json');
    const cfg = repoConfig(root, { docs: null }, 'docs', topLevel);
    const input = allowlistInput(cfg);
    const fresh = generateAllowedTools(input);
    const generated = ['/roost/tools/bin/prettier:*', `${root}/bin/tool:*`, `/roost/x/${root}/bin/pair:*`];
    writeFileSync(
      path,
      JSON.stringify({
        _generated: {
          config_hash: fresh._generated.config_hash,
          generator_version: 9,
        },
        base: section === 'base' ? ['git:*', ...generated, ...userGrants] : ['git:*'],
        extra: section === 'extra' ? [...generated, ...userGrants] : [],
      }) + '\n',
    );
    const { result: out } = ensure(root, cfg);
    assert.deepEqual(out.extra, [...userGrants].sort(), `${section}: every user grant preserved, nothing else`);
    for (const tok of [
      '{{roostDir}}/tools/bin/prettier:*',
      '{{backlogRoot}}/bin/tool:*',
      '{{roostDir}}/x/{{backlogRoot}}/bin/pair:*',
      ...userGrants,
    ]) {
      assert.ok(out.base.includes(tok), `${section}: ${tok} in base`);
    }
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    for (const tok of generated) {
      assert.ok(!onDisk.base.includes(tok), `${section}: ${tok} in base`);
      assert.ok(!onDisk.extra.includes(tok), `${section}: ${tok} in extra`);
    }
  }
});
