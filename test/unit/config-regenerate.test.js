/**
 * config-regenerate.test.js — the `regenerate` plugin stage's config (F-36
 * D5): `loadConfig` refuses a plugin with `regenerate` but no `paths`, or
 * `paths` but no `regenerate`, naming it, with no defaults; a repo's
 * `plugins-regenerate` activates one through the cascade.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, configForRepo } from '../../src/config.js';
import { regeneratePlugins } from '../../src/regenerate.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const LOCK = { regenerate: 'pnpm install --lockfile-only', paths: ['pnpm-lock.yaml'] };

function withConfig(config, repos = { code: { path: './code' } }) {
  return mkTempBacklog({ repos, config });
}

/** loadConfig's error on `plugins`, or null when it loads. */
function loadError(plugins, repos) {
  const { dir, cleanup } = withConfig({ plugins }, repos);
  try {
    loadConfig({ backlogRoot: dir });
    return null;
  } catch (e) {
    return e.message;
  } finally {
    cleanup();
  }
}

test('a regenerate plugin with its paths loads', () => {
  assert.equal(loadError({ 'pnpm-lock': LOCK }), null);
});

test('regenerate without paths is refused, naming the plugin', () => {
  assert.equal(
    loadError({ 'pnpm-lock': { regenerate: LOCK.regenerate } }),
    'backlog.json plugin "pnpm-lock" defines "regenerate" but no "paths": list the files it regenerates',
  );
});

test('paths without regenerate is refused, naming the plugin', () => {
  assert.equal(
    loadError({ 'pnpm-lock': { paths: LOCK.paths } }),
    'backlog.json plugin "pnpm-lock" defines "paths" but no "regenerate": name the command that regenerates them',
  );
});

test('an empty paths list or a blank command is refused: there are no defaults', () => {
  assert.match(loadError({ x: { regenerate: 'make lock', paths: [] } }), /plugin "x" "paths" must be a non-empty list/);
  assert.match(
    loadError({ x: { regenerate: 'make lock', paths: 'lock' } }),
    /plugin "x" "paths" must be a non-empty list/,
  );
  assert.match(
    loadError({ x: { regenerate: 'make lock', paths: [''] } }),
    /plugin "x" "paths" must be a non-empty list/,
  );
  assert.match(
    loadError({ x: { regenerate: ' ', paths: ['lock'] } }),
    /plugin "x" "regenerate" must be a non-empty command/,
  );
});

test("a repo's overrides that leave a pair incomplete are refused, naming the repo and plugin", () => {
  const err = loadError(
    { 'pnpm-lock': LOCK },
    {
      code: { path: './code', overrides: { plugins: { 'pnpm-lock': { paths: ['a.lock'] }, extra: { paths: ['b'] } } } },
    },
  );
  assert.equal(
    err,
    'backlog.json repos["code"] overrides plugin "extra" defines "paths" but no "regenerate": name the command that regenerates them',
  );
});

test('plugins-regenerate on a repo activates the plugin with its paths', () => {
  const { dir, cleanup } = withConfig(
    { plugins: { 'pnpm-lock': LOCK, other: { regenerate: 'uv lock', paths: ['uv.lock'] } } },
    { code: { path: './code', 'plugins-regenerate': ['pnpm-lock'] }, docs: { path: './docs' } },
  );
  try {
    const config = loadConfig({ backlogRoot: dir });
    assert.deepEqual(regeneratePlugins(configForRepo(config, 'code'), null), [
      { name: 'pnpm-lock', command: LOCK.regenerate, paths: LOCK.paths },
    ]);
    assert.deepEqual(regeneratePlugins(configForRepo(config, 'docs'), null), []);
  } finally {
    cleanup();
  }
});
