import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { formatTask } from '../../src/task.js';
import { runBl } from '../helpers/run-bl.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

// F-65 D4 through the CLI: bl validate's Deferred rules and bl status's
// deferred and tasks lines. The rules themselves are unit-tested in
// test/unit/deferred.test.js and test/unit/inbox.test.js.

test('bl validate: the Deferred rules run on open units only', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['repos/tools'],
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      {
        id: 'S-10',
        component: 'C01',
        title: 'Open',
        status: 'in_progress',
        body: '## To Do\n\n- [points: -] a note\n',
      },
      { id: 'S-11', component: 'C01', title: 'Closed', status: 'done', body: '## To Do\n\n- [points: -] a note\n' },
    ],
    features: [
      {
        id: 'F-35',
        title: 'Open',
        status: 'draft',
        deferred: '- [points: 1] work\n\n### Operator tasks\n\n1. [points: -] two',
      },
      {
        id: 'F-36',
        title: 'Closed',
        status: 'done',
        deferred: '- [points: -] operator: one\n\n### Operator tasks\n\n1. [points: -] two',
      },
    ],
  });
  try {
    const r = runBl(['validate', '--json'], { cwd: dir });
    const found = JSON.parse(r.stdout).findings.filter((f) =>
      ['deferred-unsized', 'operator-tasks-retired'].includes(f.code),
    );
    assert.deepEqual(
      found.map((f) => [f.code, f.message.split(':')[0]]).sort(),
      [
        ['deferred-unsized', 'S-10'],
        ['operator-tasks-retired', 'F-35'],
      ],
      r.stdout,
    );
    assert.equal(r.status, 1, r.stderr);
    const story = found.find((f) => f.code === 'deferred-unsized');
    assert.equal(readFileSync(join(dir, story.location), 'utf8').split('\n')[story.line - 1], '- [points: -] a note');
    assert.ok(!JSON.parse(r.stdout).findings.some((f) => f.code === 'operator-tasks'), 'the S-970 rule is gone');
  } finally {
    cleanup();
  }
});

/** Write `tasks/T<n>-x.md`. */
function writeTask(dir, num, unit, title, extra = {}) {
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  const fm = { task_id: `T-${num}`, title, unit, owner: 'operator', status: 'open', added: '2026-10-27', ...extra };
  writeFileSync(join(dir, 'tasks', `T${num}-x.md`), formatTask(fm, `\n# T-${num} · ${title}\n`));
}

test("bl status: the deferred line counts items only; the tasks line counts the unit's tasks", () => {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      {
        id: 'S-10',
        component: 'C01',
        title: 'Active',
        status: 'in_progress',
        body: '## Summary\n\nA story.\n\n## To Do\n\n- [points: -] operator: restart the shared api after merge\n- [points: 1] follow-up work\n',
      },
    ],
    features: [
      {
        id: 'F-35',
        title: 'Completed',
        status: 'done',
        deferred:
          '- [points: 2] a follow-up story\n- [points: -] operator: merge tools#37\n  → Done 2026-10-14: merged\n- [points: -] Note: not an operator task',
      },
      { id: 'F-40', title: 'Quiet', status: 'running' },
    ],
  });
  try {
    writeTask(dir, 2, 'S-10', 'Restart the shared api');
    writeTask(dir, 3, 'F-35', 'Rebuild the site', { status: 'done', done: '2026-10-27' });
    writeTask(dir, 4, 'F-35', 'Reinstall the browsers');
    const f35 = runBl(['status', 'F-35'], { cwd: dir });
    assert.equal(f35.status, 0, f35.stderr);
    assert.match(f35.stdout, /^deferred: 2 items\ntasks: 1 open, 1 done$/m);
    assert.doesNotMatch(f35.stdout, /operator task/);
    const s10 = runBl(['status', 'S-10'], { cwd: dir });
    assert.equal(s10.status, 0, s10.stderr);
    assert.match(s10.stdout, /^to do: 1 item\ntasks: 1 open, 0 done$/m);
    const f40 = runBl(['status', 'F-40'], { cwd: dir });
    assert.doesNotMatch(f40.stdout, /^tasks:/m, 'a unit with no task has no tasks line');
  } finally {
    cleanup();
  }
});
