/**
 * plugin-binaries.test.js — integration coverage for S-443.
 *
 * Spans `bl validate` (plugin-binary finding kind, --skip suppression, JSON
 * schema) and `bl init` (informational readout). PATH is constrained to a
 * tmpdir of fixture binaries so OK / MISSING outcomes are deterministic on
 * any contributor's machine.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CONFIG, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

function makeBinDir(names) {
  const dir = mkTempDir('bl-plugin-bins-');
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  return dir;
}

function writeBacklogJson(td, body) {
  writeFileSync(
    join(td.dir, 'backlog.json'),
    JSON.stringify({ worktrees: '../worktrees', ...AGENT_CONFIG, ...body }, null, 2),
  );
}

// `bin/bl` is a /bin/sh script that calls `dirname`, `readlink`, `node`, etc.
// Tests that constrain PATH must keep the system path available for the
// shebang to resolve. We prepend a tmpdir of test fixtures rather than
// clearing PATH outright. Unique fake names (e.g. `blfake_xyzzy`) keep the
// MISSING-path tests deterministic regardless of what's installed on a
// contributor's machine.
const SYSTEM_PATH = process.env.PATH ?? '/usr/bin:/bin';
const withTestBin = (dir) => `${dir}:${SYSTEM_PATH}`;

const baseRepos = {};

const MISSING = 'blfake_xyzzy_missing'; // guaranteed not on any real PATH
const INSTALLED = 'blfake_xyzzy_installed'; // present only in our test bin

test('bl validate emits no plugin-binary findings when every tool is installed', async () => {
  const td = mkTempBacklog({});
  const bin = makeBinDir([INSTALLED]);
  writeBacklogJson(td, {
    backlog: 'backlog',
    repos: baseRepos,
    plugins: { ok: { format: `${INSTALLED} --write {{path}}` } },
  });

  const { stdout, status } = await runBl(['validate', '--json'], {
    cwd: td.dir,
    env: { PATH: withTestBin(bin) },
  });
  assert.equal(status, 0);
  const data = JSON.parse(stdout);
  assert.equal(data.findings.filter((f) => f.code === 'plugin-binary').length, 0);

  rmSync(bin, { recursive: true, force: true });
  td.cleanup();
});

test('bl validate emits a plugin-binary warning for a missing tool', async () => {
  const td = mkTempBacklog({});
  writeBacklogJson(td, {
    backlog: 'backlog',
    repos: baseRepos,
    plugins: {
      gofmt: { format: `${MISSING} -w {{path}}` },
    },
  });

  const { stdout, status } = await runBl(['validate', '--json'], {
    cwd: td.dir,
  });
  // Warning only — exit 0 unless --strict.
  assert.equal(status, 0);
  const data = JSON.parse(stdout);
  const pb = data.findings.filter((f) => f.code === 'plugin-binary');
  assert.equal(pb.length, 1);
  assert.equal(pb[0].severity, 'warning');
  assert.equal(pb[0].plugin, 'gofmt');
  assert.deepEqual(pb[0].stages, ['format']);
  assert.equal(pb[0].command, MISSING);

  td.cleanup();
});

test('bl validate skips plugin entries with empty command (SKIP, no finding)', async () => {
  const td = mkTempBacklog({});
  writeBacklogJson(td, {
    backlog: 'backlog',
    repos: baseRepos,
    plugins: {
      doesnothing: { format: '' },
    },
  });

  const { stdout, status } = await runBl(['validate', '--json'], {
    cwd: td.dir,
  });
  assert.equal(status, 0);
  const data = JSON.parse(stdout);
  assert.equal(data.findings.filter((f) => f.code === 'plugin-binary').length, 0);

  td.cleanup();
});

test('bl validate --skip plugin-binary suppresses the category', async () => {
  const td = mkTempBacklog({});
  writeBacklogJson(td, {
    backlog: 'backlog',
    repos: baseRepos,
    plugins: { gofmt: { format: `${MISSING} -w {{path}}` } },
  });

  // Without --skip, the finding is present.
  const without = await runBl(['validate', '--json'], { cwd: td.dir });
  const withoutData = JSON.parse(without.stdout);
  assert.equal(withoutData.findings.filter((f) => f.code === 'plugin-binary').length, 1);

  // With --skip plugin-binary, no plugin-binary findings appear.
  const withSkip = await runBl(['validate', '--json', '--skip', 'plugin-binary'], { cwd: td.dir });
  const withSkipData = JSON.parse(withSkip.stdout);
  assert.equal(withSkipData.findings.filter((f) => f.code === 'plugin-binary').length, 0);

  td.cleanup();
});

test('bl validate plugin-binary finding includes plugin/stages/command sub-fields in JSON', async () => {
  const td = mkTempBacklog({});
  writeBacklogJson(td, {
    backlog: 'backlog',
    repos: baseRepos,
    plugins: {
      multistage: {
        format: `${MISSING} format {{path}}`,
        lint: `${MISSING} lint {{path}}`,
      },
    },
  });
  const { stdout } = await runBl(['validate', '--json'], { cwd: td.dir });
  const data = JSON.parse(stdout);
  const pb = data.findings.find((f) => f.code === 'plugin-binary');
  assert.ok(pb, 'expected at least one plugin-binary finding');
  assert.equal(pb.plugin, 'multistage');
  assert.equal(pb.command, MISSING);
  // Both stages collapsed into one finding because they share a first-token.
  assert.deepEqual([...pb.stages].sort(), ['format', 'lint']);
  td.cleanup();
});

test('bl init prints a Plugin tools block with status per binary', async () => {
  const td = mkTempBacklog({});
  const bin = makeBinDir([INSTALLED]);
  // HOME is redirected so the agent provider's settings.json write lands in
  // a tmpdir, not the developer's real ~/.claude/settings.json.
  const fakeHome = mkTempDir('bl-fake-home-');
  writeBacklogJson(td, {
    backlog: 'backlog',
    repos: baseRepos,
    plugins: {
      good: { format: `${INSTALLED} --write {{path}}` },
      gone: { lint: `${MISSING} {{path}}` },
    },
  });

  // `bl init` (no --project) prints the readout before returning.
  const { stderr } = await runBl(['init'], {
    cwd: td.dir,
    env: { PATH: withTestBin(bin), HOME: fakeHome },
  });
  assert.match(stderr, /Plugin tools:/);
  assert.match(stderr, new RegExp(`${INSTALLED}\\s+OK`));
  assert.match(stderr, new RegExp(`${MISSING}\\s+MISSING`));

  rmSync(bin, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  td.cleanup();
});
