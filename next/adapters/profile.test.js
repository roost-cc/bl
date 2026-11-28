/**
 * The profile rule of `next/adapters/profile.js` (F-141 D3, D-498).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from '../test/helpers/env.js';
import { profileCommand } from './profile.js';

test("a profile's args come after bl's own, and its env goes over process.env", () => {
  withEnv({ A: '0', BL_PROFILE_TEST_KEPT: 'kept' }, () => {
    const { args, env } = profileCommand(['--x'], { args: ['--y'], env: { A: '1' } });
    assert.deepEqual(args, ['--x', '--y']);
    assert.equal(env.A, '1');
    assert.equal(env.BL_PROFILE_TEST_KEPT, 'kept');
    assert.equal(process.env.A, '0', 'process.env itself is unchanged');
  });
});

test('a profile with no args and no env gives the base arguments and process.env', () => {
  const { args, env } = profileCommand(['capacity'], {});
  assert.deepEqual(args, ['capacity']);
  assert.deepEqual(env, { ...process.env });
});
