/**
 * Integration test for the inbox kind `change` (F-48 D4, S-1068): unmerged
 * commits on a unit's branch, read from real git repos, and the `bl inbox`
 * CLI's handling of change items. These spawn git and bl, so they live here
 * rather than in the unit suite (src/AGENTS.md: unit tests spawn nothing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { serializeChange } from '../../src/change-doc.js';
import { loadConfig } from '../../src/config.js';
import { collectInbox, doneRefusal, inboxCountLine } from '../../src/inbox.js';
import { git } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { mkTempBacklog } from '../helpers/tempdir.js';

const ids = (items) => items.map((e) => e.id);

// ---------------------------------------------------------------------------
// F-48 S-1068: the change kind, unmerged commits on a unit's branch
// ---------------------------------------------------------------------------

/** A git repo at `path` on `main` with one commit, and a branch per `branches` key with that many commits ahead. */
function gitRepo(path, branches = {}) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'base.txt'), 'base\n');
  git(path, 'add', 'base.txt');
  git(path, 'commit', '-q', '-m', 'base');
  for (const [name, n] of Object.entries(branches)) {
    git(path, 'checkout', '-q', '-b', name, 'main');
    for (let i = 0; i < n; i++) {
      writeFileSync(join(path, `${name}-${i}.txt`), `${i}\n`);
      git(path, 'add', '.');
      git(path, 'commit', '-q', '-m', `${name} ${i}`);
    }
    git(path, 'checkout', '-q', 'main');
  }
}

/** A `change.md` in a unit's directory, naming `repos` (`[{ repo, branch }]`). */
function writeChangeDoc(unitDir, id, repos, fm = {}) {
  writeFileSync(
    join(unitDir, 'change.md'),
    serializeChange({
      fm: { change_of: id, status: 'open', review_round: 0, review_status: '', ...fm },
      repos: repos.map((r) => ({ repo: r.repo, branch: r.branch, pr: '', url: '', merged: '' })),
      body: `\n# ${id}\n\n## Description\n`,
    }),
  );
}

/**
 * Two repos, tools and web. Listed: S-60 (a standalone story, one commit on
 * its branch) and F-70 (a feature with commits in both repos). Not listed:
 * S-61 (in F-70), S-62 (done), S-63 (change merged), S-64 (branch gone),
 * S-65 (branch level with main), S-66 (no branch). F-71 is an escalation.
 */
function setupChanges() {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['repos/tools', 'repos/web'],
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-60', component: 'C01', title: 'Side fix', status: 'in_progress' },
      { id: 'S-61', component: 'C01', title: 'In a feature', status: 'in_progress', feature: 'F-70' },
      { id: 'S-62', component: 'C01', title: 'Closed', status: 'done' },
      { id: 'S-63', component: 'C01', title: 'Merged', status: 'in_progress' },
      { id: 'S-64', component: 'C01', title: 'Branch gone', status: 'in_progress' },
      { id: 'S-65', component: 'C01', title: 'Level', status: 'in_progress' },
      { id: 'S-66', component: 'C01', title: 'Branchless', status: 'backlog' },
    ],
    features: [
      { id: 'F-70', title: 'Sweep', status: 'running', stories: ['S-61'] },
      { id: 'F-71', title: 'Stuck', status: 'escalated', escalation: 'A or B?' },
    ],
  });
  gitRepo(join(dir, 'repos', 'tools'), {
    's60-side': 1,
    's61-in': 1,
    's62-closed': 1,
    's63-merged': 1,
    's65-level': 0,
    'f70-sweep': 2,
  });
  gitRepo(join(dir, 'repos', 'web'), { 'f70-sweep': 1 });
  const story = (id) => join(dir, 'stories', id.replace('S-', 'S'));
  writeChangeDoc(story('S-60'), 'S-60', [{ repo: 'tools', branch: 's60-side' }]);
  writeChangeDoc(story('S-61'), 'S-61', [{ repo: 'tools', branch: 's61-in' }]);
  writeChangeDoc(story('S-62'), 'S-62', [{ repo: 'tools', branch: 's62-closed' }]);
  writeChangeDoc(story('S-63'), 'S-63', [{ repo: 'tools', branch: 's63-merged' }], { status: 'merged' });
  writeChangeDoc(story('S-64'), 'S-64', [{ repo: 'tools', branch: 's64-gone' }]);
  writeChangeDoc(story('S-65'), 'S-65', [{ repo: 'tools', branch: 's65-level' }]);
  writeChangeDoc(story('S-66'), 'S-66', [{ repo: 'tools', branch: '' }]);
  writeChangeDoc(join(dir, 'features', 'F70'), 'F-70', [
    { repo: 'tools', branch: 'f70-sweep' },
    { repo: 'web', branch: 'f70-sweep' },
  ]);
  return { dir, cleanup, story, config: () => loadConfig({ backlogRoot: dir }) };
}

const changes = (items) => items.filter((e) => e.kind === 'change');

test('collectInbox: change lists a standalone story and a feature with unmerged commits, after escalations and tasks, once per unit', () => {
  const t = setupChanges();
  try {
    const { items, warnings } = collectInbox(t.config());
    assert.deepEqual(
      warnings.filter((w) => /unmerged|change document/.test(w)),
      [],
    );
    assert.deepEqual(ids(items), ['F-71:esc', 'F-70:change', 'S-60:change']);
    assert.deepEqual(changes(items), [
      {
        kind: 'change',
        id: 'F-70:change',
        unit: 'F-70',
        line: 'tools, web: Sweep · tools 2 commit(s) on f70-sweep, web 1 commit(s) on f70-sweep, not merged',
        next: 'bl run F-70',
        path: 'features/F70/change.md',
      },
      {
        kind: 'change',
        id: 'S-60:change',
        unit: 'S-60',
        line: 'tools: Side fix · 1 commit(s) on s60-side, not merged',
        next: 'bl run S-60',
        path: 'stories/S60/change.md',
      },
    ]);
  } finally {
    t.cleanup();
  }
});

test('collectInbox: a change whose review is addressed is answered by bl merge', () => {
  const t = setupChanges();
  try {
    writeChangeDoc(t.story('S-60'), 'S-60', [{ repo: 'tools', branch: 's60-side' }], { review_status: 'addressed' });
    const item = changes(collectInbox(t.config()).items).find((e) => e.id === 'S-60:change');
    assert.equal(item.next, 'bl merge S-60');
  } finally {
    t.cleanup();
  }
});

test('collectInbox: a repo git cannot read is a warning; the other items are still listed', () => {
  const t = setupChanges();
  try {
    rmSync(join(t.dir, 'repos', 'web'), { recursive: true, force: true });
    const { items, warnings } = collectInbox(t.config());
    const repoWarnings = warnings.filter((w) => /unmerged/.test(w));
    assert.equal(repoWarnings.length, 1, warnings.join('\n'));
    assert.match(repoWarnings[0], /^repo web not read for unmerged changes: /);
    assert.deepEqual(ids(items), ['F-71:esc', 'F-70:change', 'S-60:change']);
    assert.equal(items.find((e) => e.id === 'F-70:change').line, 'tools: Sweep · 2 commit(s) on f70-sweep, not merged');
  } finally {
    t.cleanup();
  }
});

test('change items: bl inbox done refuses with the verb, --json and the human list carry them, inboxCountLine counts them', async () => {
  const t = setupChanges();
  try {
    assert.match(doneRefusal(t.config(), 's60:CHANGE').refused, /^S-60:change is unmerged work .*bl run S-60$/);
    const done = runBl(['inbox', 'done', 'S-60:change'], { cwd: t.dir });
    assert.equal(done.status, 1);
    assert.match(done.stderr, /bl run S-60/);
    const json = runBl(['inbox', '--json'], { cwd: t.dir });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(
      changes(JSON.parse(json.stdout)).map((e) => e.id),
      ['F-70:change', 'S-60:change'],
    );
    const human = runBl(['inbox'], { cwd: t.dir });
    assert.match(human.stdout, /^change \(2\)$/m);
    assert.match(human.stdout, /next: bl run S-60$/m);
    assert.equal(inboxCountLine(t.config()), 'inbox: 3 item(s) need you (bl inbox)');
  } finally {
    t.cleanup();
  }
});
