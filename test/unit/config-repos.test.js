/**
 * config-repos.test.js — backlog.json `repos` (F-51 D4): the repo registry,
 * its required keys, a repo's `overrides` (`configForRepo`), the plugin
 * cascade's repo layer, `update_tests`, `deployable`, and the refusal of a
 * backlog.json that still has `projects`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  loadConfig,
  configForRepo,
  repoOf,
  resolvePlugins,
  parsePluginCascade,
  updateSettings,
} from '../../src/config.js';
import { findStoryDir } from '../../src/story.js';
import { resolveFeaturePluginsReport } from '../../src/feature.js';
import { deployableRepos } from '../../src/release.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

const SESSION_STACK = { workon: 'session up {{sessionNum}}', cleanup: 'session down {{sessionNum}}' };

/**
 * The shape the migration writes (F-51 D4's example): app.acme.com with the
 * old project's index layer and `backlog.json` override, bl with its update
 * tests. The repo directories live inside the backlog, so bl finds it from
 * either: the walk reaches the backlog's parent.
 */
function appBacklog(opts) {
  const t = mkTempBacklog(
    {
      repos: {
        'app.acme.com': {
          path: 'repos/app.acme.com',
          deployable: true,
          update_tests: ['app-tests'],
          'plugins-bootstrap': ['node-ws', 'acme-vendor'],
          'plugins-test': ['app-tests'],
          overrides: { plugins: { 'session-stack': SESSION_STACK } },
        },
        bl: { path: 'repos/bl', update_tests: ['bl-tests'] },
      },
      components: [
        { id: 'C00', title: 'App', dirSuffix: 'app', repo: 'app.acme.com', home: true },
        { id: 'C01', title: 'No vendor', dirSuffix: 'no-vendor', repo: 'app.acme.com' },
        { id: 'C32', title: 'bl', dirSuffix: 'bl', repo: 'bl', home: true },
      ],
      stories: [
        { id: 'S-1', component: 'C00', title: 'App work', dirSuffix: 'app-work', primary_repo: 'app.acme.com' },
        { id: 'S-2', component: 'C01', title: 'No vendor', dirSuffix: 'no-vendor', primary_repo: 'app.acme.com' },
        { id: 'S-3', component: 'C00', title: 'No tests', dirSuffix: 'no-tests', primary_repo: 'app.acme.com' },
        { id: 'S-4', component: 'C32', title: 'bl work', dirSuffix: 'bl-work', primary_repo: 'bl' },
      ],
    },
    opts,
  );
  const cfgPath = join(t.dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  raw.plugins = {
    'node-ws': { bootstrap: 'pnpm install' },
    'acme-vendor': { bootstrap: 'vendor' },
    'app-tests': { test: 'npm test' },
    'bl-tests': { test: 'npm test' },
    md: { format: 'prettier --write {{path}}' },
  };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
  for (const r of ['app.acme.com', 'bl']) mkdirSync(join(t.dir, 'repos', r), { recursive: true });
  // The component and story layers can still take a repo-layer plugin away.
  const edit = (rel, line) => {
    const p = join(t.dir, rel);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^---\n/, `---\n${line}\n`));
  };
  edit('components/C01-no-vendor/index.md', 'plugins-bootstrap: [-acme-vendor]');
  edit('stories/S3-no-tests/index.md', 'plugins-test: [-app-tests]');
  return t;
}

/** A story's resolved plugins for `stage`, as `bl` resolves them for a run of it. */
function storyPlugins(config, id, stage) {
  const found = findStoryDir({ dirPrefix: id.replace('S-', 'S') }, config);
  const cfg = configForRepo(config, found.unitRepo);
  return resolvePlugins(stage, cfg.plugins, {
    backlogRoot: cfg.backlogRoot,
    repo: repoOf(cfg),
    componentEntry: found.componentEntry,
    storyEntry: found.storyEntry,
  }).map((p) => p.name);
}

test('loadConfig registers every repos entry with its path, deployable and layers', () => {
  const { dir, cleanup } = appBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.deepEqual(Object.keys(cfg.repos), ['app.acme.com', 'bl']);
    assert.deepEqual(cfg.reposByName, {
      'app.acme.com': join(dir, 'repos', 'app.acme.com'),
      bl: join(dir, 'repos', 'bl'),
    });
    const app = cfg.repos['app.acme.com'];
    assert.equal(app.deployable, true);
    // update_tests is running-man's provisioning key: bl accepts it and keeps none of it.
    assert.deepEqual(Object.keys(app), ['name', 'path', 'deployable', 'plugins', 'overrides']);
    assert.deepEqual(app.plugins, { bootstrap: ['node-ws', 'acme-vendor'], test: ['app-tests'] });
    assert.deepEqual(app.overrides, { plugins: { 'session-stack': SESSION_STACK } });
    assert.deepEqual(cfg.repos.bl.plugins, {}, 'no plugins-<stage>: no layer');
    assert.equal(cfg.repos.bl.overrides, null, 'no overrides: no layer');
    // A plain loadConfig is the top level only: no repo's overrides.
    assert.equal(cfg.repoName, null);
    assert.equal(cfg.plugins['session-stack'], undefined);
  } finally {
    cleanup();
  }
});

test('a repos entry missing path or deployable fails naming the repo and the key', () => {
  const { dir, cleanup } = appBacklog();
  try {
    const cfgPath = join(dir, 'backlog.json');
    const good = readFileSync(cfgPath, 'utf8');
    for (const key of ['path', 'deployable']) {
      const raw = JSON.parse(good);
      delete raw.repos.bl[key];
      writeFileSync(cfgPath, JSON.stringify(raw));
      assert.throws(() => loadConfig({ backlogRoot: dir }), new RegExp(`repos\\["bl"\\] has no "${key}"`), key);
    }
    const bad = [
      [{ path: '' }, /repos\["bl"\] "path" must be a non-empty string/],
      [{ deployable: 'true' }, /repos\["bl"\] "deployable" must be true or false/],
      [{ update_tests: 'bl-tests' }, /repos\["bl"\] "update_tests" must be a list/],
      [{ 'plugins-test': 'bl-tests' }, /repos\["bl"\] "plugins-test" must be a list/],
      [{ overrides: [] }, /repos\["bl"\] "overrides" must be an object/],
      [{ plugins: ['x'] }, /repos\["bl"\] has an unknown key "plugins"/],
      [{ updates: {} }, /repos\["bl"\] has an unknown key "updates"/],
    ];
    for (const [patch, err] of bad) {
      const raw = JSON.parse(good);
      Object.assign(raw.repos.bl, patch);
      writeFileSync(cfgPath, JSON.stringify(raw));
      assert.throws(() => loadConfig({ backlogRoot: dir }), err, JSON.stringify(patch));
    }
    const raw = JSON.parse(good);
    raw.repos = ['bl'];
    writeFileSync(cfgPath, JSON.stringify(raw));
    assert.throws(() => loadConfig({ backlogRoot: dir }), /"repos" must be an object keyed by repo name/);
    // update_tests is running-man's provisioning key: bl accepts an empty
    // list, and an entry may leave it out.
    const empty = JSON.parse(good);
    empty.repos.bl.update_tests = [];
    writeFileSync(cfgPath, JSON.stringify(empty));
    assert.equal(loadConfig({ backlogRoot: dir }).repos.bl.name, 'bl');
    const without = JSON.parse(good);
    delete without.repos.bl.update_tests;
    writeFileSync(cfgPath, JSON.stringify(without));
    assert.equal(loadConfig({ backlogRoot: dir }).repos.bl.name, 'bl');
  } finally {
    cleanup();
  }
});

test('updateSettings reads only the heartbeat, with no defaults; loadConfig never requires it', () => {
  const { dir, cleanup } = appBacklog();
  try {
    const cfgPath = join(dir, 'backlog.json');
    const good = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const write = (updates) => {
      const raw = structuredClone(good);
      if (updates === undefined) delete raw.updates;
      else raw.updates = updates;
      writeFileSync(cfgPath, JSON.stringify(raw));
      return loadConfig({ backlogRoot: dir });
    };
    assert.equal(updateSettings(write(undefined)), null, 'no updates block: no update job');
    const heartbeat = { repo: 'running-man', branch: 'updates-heartbeat' };
    const wanted = { heartbeat };
    assert.deepEqual(updateSettings(write({ heartbeat })), wanted, 'heartbeat alone');
    // running-man's keys (namespace, push_attempts) and the old report beside
    // it: bl ignores them.
    const full = {
      namespace: 'acme',
      report: 'running-man/renovate/reports/renovate-report.json',
      push_attempts: 3,
      heartbeat,
    };
    assert.deepEqual(updateSettings(write(full)), wanted, 'the full block');
    const { namespace: _n, push_attempts: _p, ...noRunnerKeys } = full;
    assert.deepEqual(updateSettings(write(noRunnerKeys)), wanted, 'no namespace or push_attempts');
    // A backlog.json from before the cutover still loads; only the reader refuses it.
    const before = write({ namespace: 'acme', report: full.report });
    assert.throws(() => updateSettings(before), /"updates" has no "heartbeat"/);
    for (const [patch, err] of [
      [{ heartbeat: 'running-man' }, /needs an object \{ repo, branch \} for "heartbeat"/],
      [{ heartbeat: { repo: 'running-man' } }, /has no "heartbeat\.branch"/],
      [{ heartbeat: { branch: 'b' } }, /has no "heartbeat\.repo"/],
      [{ heartbeat: { branch: 'b', repo: '' } }, /needs a non-empty string for "heartbeat\.repo"/],
      [{ heartbeat: { repo: 'running-man', branch: ' ' } }, /needs a non-empty string for "heartbeat\.branch"/],
    ]) {
      const u = { ...full, ...patch };
      for (const k of Object.keys(u)) if (u[k] === undefined) delete u[k];
      assert.throws(() => updateSettings(write(u)), err, JSON.stringify(patch));
    }
    assert.throws(() => updateSettings(write([])), /"updates" must be an object/);
  } finally {
    cleanup();
  }
});

test('configForRepo(cfg, "app.acme.com") merges that entry\'s overrides by the mergeConfig rule', () => {
  const { dir, cleanup } = appBacklog();
  try {
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    raw.review_agent = [{ agent: 'claude' }];
    // A plugin the top level also defines is merged one level deep.
    raw.repos['app.acme.com'].overrides.plugins.md = { lint: 'markdownlint {{path}}' };
    raw.repos['app.acme.com'].overrides.review_agent = [{ agent: 'codex' }];
    writeFileSync(cfgPath, JSON.stringify(raw));

    const top = loadConfig({ backlogRoot: dir });
    const app = configForRepo(top, 'app.acme.com');
    assert.equal(app.repoName, 'app.acme.com');
    assert.deepEqual(app.plugins['session-stack'], SESSION_STACK);
    assert.deepEqual(app.plugins.md, { format: 'prettier --write {{path}}', lint: 'markdownlint {{path}}' });
    assert.deepEqual(app.raw.review_agent, [{ agent: 'codex' }]);
    assert.equal(app.reviewAgent, 'codex');
    assert.deepEqual(repoOf(app), top.repos['app.acme.com']);
    // The top level is untouched, and another repo has no overrides.
    assert.equal(top.plugins['session-stack'], undefined);
    assert.deepEqual(top.raw.review_agent, [{ agent: 'claude' }]);
    assert.equal(top.reviewAgent, 'claude');
    const bl = configForRepo(top, 'bl');
    assert.equal(bl.repoName, 'bl');
    assert.equal(bl.plugins['session-stack'], undefined);
    // Already for that repo: the same object. Unknown or no repo: the top level.
    assert.equal(configForRepo(app, 'app.acme.com'), app);
    assert.equal(configForRepo(top, 'nowhere'), top);
    assert.equal(configForRepo(top, null), top);
    assert.equal(configForRepo(app, null).repoName, null);
  } finally {
    cleanup();
  }
});

test('an app.acme.com story resolves bootstrap and test from the repo layer; a component or story -name removes one', () => {
  const { dir, cleanup } = appBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.deepEqual(storyPlugins(cfg, 'S-1', 'bootstrap'), ['node-ws', 'acme-vendor']);
    assert.deepEqual(storyPlugins(cfg, 'S-1', 'test'), ['app-tests']);
    assert.deepEqual(storyPlugins(cfg, 'S-2', 'bootstrap'), ['node-ws'], "the component's -acme-vendor");
    assert.deepEqual(storyPlugins(cfg, 'S-3', 'test'), [], "the story's -app-tests");
    assert.deepEqual(storyPlugins(cfg, 'S-4', 'bootstrap'), [], "bl's entry has no layer");
    // The test gate's resolution (a story run) reads the same layer.
    const found = findStoryDir({ dirPrefix: 'S1' }, cfg);
    const report = resolveFeaturePluginsReport('test', configForRepo(cfg, found.unitRepo), found.indexPath, {
      componentEntry: found.componentEntry,
    });
    assert.deepEqual(
      report.plugins.map((p) => p.name),
      ['app-tests'],
    );
    // The add/remove form the format and lint dispatchers read.
    assert.deepEqual(
      parsePluginCascade('bootstrap', {
        backlogRoot: dir,
        repo: cfg.repos['app.acme.com'],
        componentEntry: 'C01-no-vendor',
      }),
      { adds: ['node-ws'], removes: ['acme-vendor'] },
    );
  } finally {
    cleanup();
  }
});

test('the plugins resolve the same whether bl runs from the backlog, bl or app.acme.com', () => {
  // In a parent of its own: the walk stops below the suite's TMPDIR (S-1155).
  const { dir, cleanup } = appBacklog({ parent: mkTempDir('bl-parent-') });
  const prev = process.env.BL_BACKLOG_DIR;
  delete process.env.BL_BACKLOG_DIR;
  try {
    const results = [dir, join(dir, 'repos', 'bl'), join(dir, 'repos', 'app.acme.com')].map((cwd) => {
      const cfg = loadConfig({ cwd });
      assert.equal(cfg.backlogRoot, dir, cwd);
      assert.equal(cfg.repoName, null, `${cwd}: the cwd picks no repo`);
      return ['S-1', 'S-2', 'S-3', 'S-4'].map((id) => [
        storyPlugins(cfg, id, 'bootstrap'),
        storyPlugins(cfg, id, 'test'),
      ]);
    });
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  } finally {
    if (prev === undefined) delete process.env.BL_BACKLOG_DIR;
    else process.env.BL_BACKLOG_DIR = prev;
    cleanup();
  }
});

test("deployable picks the release manifest's repos", () => {
  const { dir, cleanup } = appBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.deepEqual(deployableRepos(cfg), ['app.acme.com']);
  } finally {
    cleanup();
  }
});

test('with projects in backlog.json, bl refuses and says where they went', () => {
  const { dir, cleanup } = appBacklog();
  try {
    const cfgPath = join(dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    // The pre-F-51 shape, with or without a repos block beside it. Without
    // one, the file is no backlog (S-1155), so only loadConfig given the root
    // refuses it.
    const projects = { demo: { title: 'Demo', repos: ['repos/bl'] } };
    for (const shape of [
      { ...raw, projects },
      { backlog: 'backlog', projects },
    ]) {
      writeFileSync(cfgPath, JSON.stringify(shape));
      assert.throws(() => loadConfig({ backlogRoot: dir }), /still has "projects".*now live in "repos"/s);
      if (!shape.repos) continue;
      for (const args of [
        ['list'],
        ['validate'],
        ['sync'],
        ['tree'],
        ['new', 'C32', '--title', 'X', '--points', '1', '--no-sync'],
      ]) {
        const r = runBl(args, { cwd: dir });
        assert.notEqual(r.status, 0, args.join(' '));
        assert.match(r.stderr, /still has "projects"/, args.join(' '));
      }
    }
  } finally {
    cleanup();
  }
});

test('bl new writes no project: line, and a story that still has one gets an unknown-key finding', () => {
  const { dir, cleanup } = appBacklog();
  try {
    const r = runBl(['new', 'C32', '--title', 'Fresh', '--points', '1', '--no-sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(readFileSync(join(dir, r.stdout.trim()), 'utf8'), /^project:/m);

    const p = join(dir, 'stories', 'S4-bl-work', 'index.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^---\n/, '---\nproject: infrastructure\n'));
    const v = runBl(['validate', '--json'], { cwd: dir });
    const { findings } = JSON.parse(v.stdout);
    assert.ok(
      findings.some(
        (f) => f.code === 'unknown-fm-key' && f.location === 'stories/S4-bl-work/index.md' && /project/.test(f.message),
      ),
      v.stdout,
    );
  } finally {
    cleanup();
  }
});
