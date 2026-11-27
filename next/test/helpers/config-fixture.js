// Fixture backlogs for tests of the one configuration load (`config/load.js`):
// a home directory with the files a test names, the load on it, and the fault
// lines of a load that must fail.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ConfigurationFaults } from '../../config/check.js';
import { KINDS } from '../../config/kinds.js';
import { loadConfiguration } from '../../config/load.js';
import { withEnv } from './env.js';
import { mkTempDir } from './tempdir.js';

/**
 * The smallest alert routing, `config/alerts.yaml`: each kind's key is
 * required (alerts.md, D-97; F-140 D2), so every fixture backlog that loads
 * `KINDS` has one.
 */
export const ALERTS = 'gated: []\nended: []\nnotify: []\n';

/** The path of the shop's alert routing under a fixture home. */
export const ALERTS_PATH = 'backlog/config/alerts.yaml';

/**
 * A home directory with a backlog in `<home>/backlog` and the operator's
 * directory in `<home>/.config/bl`, and `files` written under the home. The
 * backlog has `ALERTS` unless `files` gives `ALERTS_PATH`.
 * @param {Record<string, string>} files  path under the home → text
 */
export function fixture(files) {
  const home = mkTempDir('bl-load-');
  for (const [path, text] of Object.entries({ [ALERTS_PATH]: ALERTS, ...files })) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  return { home, backlogDir: join(home, 'backlog'), operatorDir: join(home, '.config', 'bl') };
}

/**
 * `loadConfiguration` on the fixture, with `$HOME` its home.
 * @param {{ home: string, backlogDir: string, operatorDir: string }} dirs
 * @param {readonly import('../../config/kinds.js').Kind[]} [kinds]
 */
export function load({ home, backlogDir, operatorDir }, kinds = KINDS) {
  return withEnv({ HOME: home }, () => loadConfiguration({ backlogDir, operatorDir, kinds }));
}

/**
 * The fault lines of a load that must fail.
 * @param {{ home: string, backlogDir: string, operatorDir: string }} dirs
 * @param {readonly import('../../config/kinds.js').Kind[]} [kinds]
 */
export function faultLines(dirs, kinds) {
  try {
    load(dirs, kinds);
  } catch (error) {
    if (error instanceof ConfigurationFaults) return error.message.split('\n');
    throw error;
  }
  assert.fail('the load gave no fault');
}
