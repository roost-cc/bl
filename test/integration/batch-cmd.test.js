/**
 * batch-cmd.test.js — `bl batch S-a S-b … --title <t>` (F-125 D1) against a
 * stub agent: the refusals, made before anything is written, and a build
 * whose cross-story pass corrects a plan and adds an order edge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureAllowedTools } from '../../src/allowed-tools.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { readEdges } from '../../src/blockers.js';
import { statusOf as logStatusOf } from '../../src/transition.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { BL_BIN, personEnv } from '../helpers/run-bl.js';
import { GIT_ENV, addOrigin, git, initGitBacklog } from '../helpers/git-backlog.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';

const PLAN = '## Implementation Plan\n\n1. Change src/two.js.\n';

/** S-1 and S-2 refined and loose; S-3 a draft; S-4 in F-1; S-5 refined, held at run by S-6. */
async function backlog() {
  const s = (id, slug, extra = {}) => ({
    id,
    component: 'C01',
    title: slug,
    dirSuffix: slug,
    points: 2,
    status: 'refined',
    body: `## Summary\n\n${slug}.\n\n## Acceptance Criteria\n\n- [ ] works\n\n${PLAN}`,
    ...extra,
  });
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work', dirSuffix: 'work', repo: 'bl' }],
    stories: [
      s('S-1', 'one'),
      s('S-2', 'two'),
      s('S-3', 'three', { status: 'draft' }),
      s('S-4', 'four', { feature: 'F-1' }),
      s('S-5', 'five'),
      s('S-6', 'six'),
      s('S-7', 'seven', { batch: 'B-1' }),
      s('S-8', 'eight', { batch: 'B-1' }),
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'approved', stories: ['S-4'] }],
    batches: [{ id: 'B-1', title: 'Old', dirSuffix: 'old' }],
  });
  writeBlockersLocked(dir, [{ blocker: 'S-6', gate: 'run', unit: 'S-5', until: 'merged' }]);
  await ensureAllowedTools(dir, loadConfig({ backlogRoot: dir }));
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

/**
 * A `claude` stub, the cross-story pass: it adds the order edge S-1 → S-2
 * with this checkout's `bl`, backticks S-2's plan path, and answers as the
 * Claude CLI does. `STUB_ARGV` gets its arguments.
 */
function stubAgent() {
  const bin = mkTempDir('bl-batch-agent-');
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\nprintf '%s' "$*" > "$STUB_ARGV"\n` +
      `"$STUB_BL" block add S-1 --gate order --unit S-2 --until implemented >/dev/null 2>&1 || exit 3\n` +
      `sed -i 's|Change src/two.js.|Change \`src/two.js\`.|' stories/S2-two/index.md\n` +
      `echo '{"type":"result","is_error":false,"result":"S-2 waits for S-1."}'\n`,
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

function batch(dir, args, argvLog = join(mkTempDir('bl-batch-argv-'), 'argv')) {
  const r = spawnSyncFiles(BL_BIN, ['batch', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...personEnv(),
      ...GIT_ENV,
      BL_BACKLOG_DIR: dir,
      PATH: `${stubAgent()}:${process.env.PATH}`,
      STUB_BL: BL_BIN,
      STUB_ARGV: argvLog,
    },
  });
  return { ...r, argvLog };
}

const fm = (dir, rel) => parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).fm;

test('bl batch refuses, before it writes anything, each story that may not join, naming it and the reason', async () => {
  const dir = await backlog();
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = batch(dir, ['S-3', 'S-4', 'S-5', 'S-7', 'S-1', '--title', 'Mixed']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bl batch: refused; nothing written\./);
  assert.match(r.stderr, /S-3: it is draft; a batch takes refined stories \(bl refine S-3\)\./);
  assert.match(r.stderr, /S-4: it is in F-1\./);
  assert.match(r.stderr, /S-5: it is held at its run gate: .*S-6/);
  assert.match(r.stderr, /S-7: it is in B-1\./);
  assert.doesNotMatch(r.stderr, /S-1:/);
  assert.ok(!existsSync(join(dir, 'batches', 'B2-mixed')), 'no batch written');
  assert.equal(fm(dir, 'stories/S1-one/index.md').batch, undefined);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.ok(!existsSync(r.argvLog), 'no agent session');

  const one = batch(dir, ['S-1', '--title', 'One']);
  assert.equal(one.status, 1);
  assert.match(one.stderr, /bl batch: give two or more stories; one story runs on its own \(bl run S-n\)\./);
  const untitled = batch(dir, ['S-1', 'S-2']);
  assert.equal(untitled.status, 1);
  assert.match(untitled.stderr, /bl batch: --title is required\./);
});

test('bl batch builds an approved batch, writes batch: on each story, runs the cross-story pass and commits', async () => {
  const dir = await backlog();
  const r = batch(dir, ['S-1', 'S-2', '--title', 'Run loop fixes']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'batches/B2-run-loop-fixes/index.md');

  // The batch, from templates/batch.md, at approved by new (F-125 D1).
  const b = fm(dir, 'batches/B2-run-loop-fixes/index.md');
  assert.equal(b.batch_id, 'B-2');
  assert.equal(b.title, 'Run loop fixes');
  assert.deepEqual(
    b.transitions.map((e) => [e.to, e.by]),
    [['approved', 'new']],
  );
  assert.equal(logStatusOf('batch', b), 'approved');
  assert.match(
    readFileSync(join(dir, 'batches/B2-run-loop-fixes/index.md'), 'utf8'),
    /## Escalation\n[\s\S]*\nNone\.\n$/,
  );
  for (const s of ['S1-one', 'S2-two']) assert.equal(fm(dir, `stories/${s}/index.md`).batch, 'B-2', s);

  // The cross-story pass: one session on batch-build.md, which carries the planning rules.
  const prompt = readFileSync(r.argvLog, 'utf8');
  assert.match(prompt, /cross-story pass of story batch B-2/);
  assert.match(prompt, /## Execution plan inputs/);
  assert.match(prompt, /1\. S-1 — one \(2 pts\)/);
  // What it did: the order edge and the corrected plan, both committed.
  assert.ok(
    readEdges(loadConfig({ backlogRoot: dir })).some(
      (e) => e.blocker === 'S-1' && e.unit === 'S-2' && e.gate === 'order',
    ),
  );
  assert.match(readFileSync(join(dir, 'stories/S2-two/index.md'), 'utf8'), /Change `src\/two\.js`\./);
  assert.equal(git(dir, 'status', '--porcelain', '--', 'batches', 'stories', 'blockers.json'), '', 'all committed');
  const log = git(dir, 'log', '--format=%s', '-3');
  assert.match(log, /chore: add B-2/);
  assert.match(log, /chore: B-2 cross-story pass/);
});
