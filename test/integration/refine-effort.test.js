import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { AGENT_CONFIG, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { BL_BIN, personEnv } from '../helpers/run-bl.js';

// Every refine session runs at `effort.refine` (F-85 D5): `bl refine S-n`,
// the batch refine and `bl refine F-n` each start `claude --effort <level>`.
// A recording `claude` stub stands in for the agent; it writes its argv, one
// argument per line, and exits 0.

function recordingClaude() {
  const dir = mkTempDir('bl-claude-rec-');
  const log = join(dir, 'argv');
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
  chmodSync(bin, 0o755);
  return { dir, argv: () => readFileSync(log, 'utf8').split('\n') };
}

function refine(args, effort) {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'One', dirSuffix: 'one' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one', status: 'backlog', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two', status: 'backlog' },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'draft', stories: ['S-1'] }],
    config: effort ? { effort } : {},
  });
  const claude = recordingClaude();
  try {
    const r = spawnSyncFiles(BL_BIN, ['refine', ...args], {
      cwd: dir,
      env: { ...personEnv(), BL_BACKLOG_DIR: dir, PATH: `${claude.dir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const argv = claude.argv();
    return argv[argv.indexOf('--effort') + 1];
  } finally {
    cleanup();
  }
}

for (const [label, args] of [
  ['bl refine S-n', ['S-1']],
  ['the batch refine', ['S-1', 'S-2']],
  ['bl refine F-n', ['F-1']],
]) {
  test(`${label} runs at effort.refine, high with the default config`, () => {
    assert.equal(AGENT_CONFIG.effort.refine, 'high');
    assert.equal(refine(args), 'high');
    assert.equal(refine(args, { refine: 'low', review: 'high', default: 'medium' }), 'low');
  });
}
