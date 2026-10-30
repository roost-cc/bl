import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissionScopes, loadLocalTools, localToolsPath } from '../../src/permissions.js';
import { writeFileSync } from 'fs';
import { mkTempDir } from '../helpers/tempdir.js';

test('resolvePermissionScopes seeds read=roost+/tmp, write=unit directory+backlog', () => {
  const scopes = resolvePermissionScopes(
    { roostDir: '/r', backlogRoot: '/r/backlog', raw: {} },
    { unitDir: '/r/worktrees/s1' },
  );
  assert.deepEqual(scopes.read, ['/r', '/tmp']);
  assert.deepEqual(scopes.write, ['/r/worktrees/s1', '/r/backlog']);
});

test('resolvePermissionScopes extends (never replaces) defaults from backlog.json, with interpolation', () => {
  const scopes = resolvePermissionScopes(
    {
      roostDir: '/r',
      backlogRoot: '/r/backlog',
      raw: {
        permissions: {
          read: ['/shared/cache', '{{roostDir}}/extra'],
          write: ['{{worktree}}/build'],
        },
      },
    },
    { unitDir: '/r/worktrees/s1' },
  );
  // Defaults are still present; config entries are appended + interpolated.
  assert.deepEqual(scopes.read, ['/r', '/tmp', '/shared/cache', '/r/extra']);
  assert.deepEqual(scopes.write, ['/r/worktrees/s1', '/r/backlog', '/r/worktrees/s1/build']);
});

test('resolvePermissionScopes dedupes and normalizes trailing slashes', () => {
  const scopes = resolvePermissionScopes(
    {
      roostDir: '/r',
      backlogRoot: '/r/backlog',
      raw: { permissions: { read: ['/r/', '/tmp'] } },
    },
    { unitDir: '/r/wt' },
  );
  assert.deepEqual(scopes.read, ['/r', '/tmp']);
});

test('resolvePermissionScopes tolerates a missing worktree', () => {
  const scopes = resolvePermissionScopes({ roostDir: '/r', backlogRoot: '/r/backlog', raw: {} }, {});
  assert.deepEqual(scopes.write, ['/r/backlog']);
});

test('loadLocalTools returns empty on missing/corrupt file, reads extra otherwise', () => {
  const dir = mkTempDir('bl-perm-');
  assert.deepEqual(loadLocalTools(dir), { extra: [] });

  writeFileSync(localToolsPath(dir), '{ not json');
  assert.deepEqual(loadLocalTools(dir), { extra: [] });

  writeFileSync(localToolsPath(dir), JSON.stringify({ extra: ['km:*'] }));
  assert.deepEqual(loadLocalTools(dir), { extra: ['km:*'] });
});
