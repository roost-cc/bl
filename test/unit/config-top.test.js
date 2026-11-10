/**
 * config-top.test.js — backlog.json `top` (F-87 D8a): `topSettings()` reads
 * the phone push command of `bl top`'s view, with no default, and
 * `loadConfig` never reads the block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, topSettings } from '../../src/config.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

test('topSettings reads top.push with no default; loadConfig never reads the block', () => {
  const { dir, cleanup } = mkTempBacklog({});
  try {
    const cfgPath = join(dir, 'backlog.json');
    const good = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const write = (top) => {
      const raw = structuredClone(good);
      if (top === undefined) delete raw.top;
      else raw.top = top;
      writeFileSync(cfgPath, JSON.stringify(raw));
      return loadConfig({ backlogRoot: dir });
    };
    assert.equal(topSettings(write(undefined)), null, 'no top block: no phone push');
    const push = ['phone-push', '--topic', 'bl top'];
    assert.deepEqual(topSettings(write({ push })), push);
    for (const [top, err] of [
      [{}, /backlog\.json "top" has no "push"/],
      [{ push: [] }, /backlog\.json "top" needs a non-empty array of non-empty strings for "push"/],
      [{ push: ['phone-push', 3] }, /backlog\.json "top" needs a non-empty array of non-empty strings for "push"/],
      [{ push: ['phone-push', ''] }, /backlog\.json "top" needs a non-empty array of non-empty strings for "push"/],
      [{ push: 'phone-push' }, /backlog\.json "top" needs a non-empty array of non-empty strings for "push"/],
      [['phone-push'], /backlog\.json "top" must be an object/],
    ]) {
      // loadConfig loads a bad block; only the reader refuses it.
      const config = write(top);
      assert.throws(() => topSettings(config), err, JSON.stringify(top));
    }
  } finally {
    cleanup();
  }
});
