// The merged bl on an unmigrated backlog (F-69 D4, acceptance 4): a
// `bl-flow/v1` flow.json, `status:` fields in the old words (story
// `backlog`, feature `running`, task `open`) and a change document with
// `review_round` and `review_status`. `bl list` and `bl status` read it, and
// `bl validate` reports warnings there, not errors. `bl run --resume` and
// `bl merge` on the old shape are the loop's and the merge's own tests,
// whose fixtures write `status:` and the review fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { HOME, REPOS } from '../helpers/feature-fixture.js';

const V1_FLOW = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'backlog-graph', 'flow.json'), 'utf8'),
);

function legacyBacklog() {
  const td = mkTempBacklog({
    repos: REPOS,
    flow: V1_FLOW,
    components: [HOME],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Loose', dirSuffix: 'loose', status: 'backlog', added: '2026-11-01' },
      {
        id: 'S-2',
        component: 'C00',
        title: 'In F-1',
        dirSuffix: 'in-f1',
        status: 'in_progress',
        feature: 'F-1',
        added: '2026-11-01',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        added: '2026-11-01',
        stories: ['S-2'],
        branch: 'f1-feat',
        review_round: '1',
        review_status: 'addressed',
        reviewLog: '### Session 2026-11-02 (PR #7)\n\n**Must fix**\nNone.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
    ],
  });
  mkdirSync(join(td.dir, 'tasks'), { recursive: true });
  writeFileSync(
    join(td.dir, 'tasks', 'T1-check.md'),
    '---\ntask_id: T-1\ntitle: Check\nunit: F-1\nowner: operator\nstatus: open\nadded: 2026-11-03\n---\n\n# T1-check.md\n',
  );
  return td;
}

test('bl list and bl status read an unmigrated backlog in the current words', () => {
  const { dir, cleanup } = legacyBacklog();
  try {
    const list = runBl(['list', '-a'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /S-1/);
    assert.match(list.stdout, /F-1/);

    const status = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr);
    // `running` with an `addressed` review reads as ready_for_merge, round 1.
    assert.match(status.stdout, /status: ready_for_merge/);
    assert.match(status.stdout, /round 1/);
  } finally {
    cleanup();
  }
});

test('bl validate on an unmigrated backlog reports warnings that name the migration, and no errors', () => {
  const { dir, cleanup } = legacyBacklog();
  try {
    const r = runBl(['validate', '--json'], { cwd: dir });
    const { findings } = JSON.parse(r.stdout);
    assert.deepEqual(
      findings.filter((f) => f.severity === 'error'),
      [],
    );
    const codes = new Set(findings.map((f) => f.code));
    for (const code of ['flow-json', 'legacy-status', 'legacy-review-fields']) assert.ok(codes.has(code), code);
    assert.ok(findings.some((f) => /migrate-transitions\.js/.test(f.message)));
  } finally {
    cleanup();
  }
});
