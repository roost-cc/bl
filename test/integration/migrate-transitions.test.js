/**
 * Integration tests for `scripts/migrate-transitions.js` (F-69 D4): on a
 * backlog in the v1 shape it gives every story, feature and task the log
 * `legacyLog` synthesizes with git dates in place of `status:`, removes the
 * change documents' review fields, writes `flow.json` v2 and commits once;
 * `--dry-run` prints the same counts and writes nothing; a unit a live run
 * holds is skipped, with its feature's stories, until a rerun; and a rerun
 * with nothing left reports nothing to do. `bl validate` on the migrated
 * backlog reports no errors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../../src/config.js';
import { FLOW_TEMPLATE, mkTempBacklog } from '../helpers/tempdir.js';
import { GIT_ENV, git, statusLines } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { holdLockInChild } from '../helpers/hold-lock.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-transitions.js', import.meta.url));
const V1_FLOW = fileURLToPath(new URL('../fixtures/flow/flow.json', import.meta.url));

const session = (date, open = 0) =>
  `### Session ${date} (PR #1)\n\n**Must fix**\n\n${open ? '- [ ] an item' : '- [x] an item'}\n`;

/** Commit everything in `dir` as of `date` (UTC), as author and committer. */
function commitAt(dir, date, message) {
  const env = { ...process.env, ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  for (const args of [
    ['add', '-A'],
    ['commit', '-q', '-m', message],
  ]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
}

const rel = {
  s1: 'stories/S1/index.md',
  s2: 'stories/S2/index.md',
  s3: 'stories/S3/index.md',
  t1: 'tasks/T1-check.md',
  f: (n) => `features/F${n}/index.md`,
  change: (n) => `features/F${n}/change.md`,
};
const read = (dir, p) => readFileSync(join(dir, p), 'utf8');
const fm = (dir, p) => parseFrontmatter(read(dir, p)).fm;
/** A file's frontmatter with `status: <from>` turned into `status: <to>`. */
const setStatus = (dir, p, from, to) =>
  writeFileSync(join(dir, p), read(dir, p).replace(`\nstatus: ${from}\n`, `\nstatus: ${to}\n`));

/**
 * A backlog in git as bl wrote it before F-69, with history:
 *
 * - S-1 a draft story (`backlog`); S-2 superseded by S-1; T-1 a done task.
 * - F-1 refined on 11-02, back to draft on 11-03, refined again on 11-04,
 *   then edited on 11-06: its `refined` entry is dated 11-04.
 * - F-2 to F-5 running, one per review state of the change document: none,
 *   `pending` (round 1), `fixed` (round 1), `addressed` (round 2); F-6
 *   escalated with a `pending` review.
 * - F-7 running, with its story S-3 in progress, and a review the run holds.
 */
function oldBacklog() {
  const { dir } = mkTempBacklog({
    flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
    repos: ['core'],
    components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
    stories: [
      { id: 'S-1', title: 'One', component: 'C01', status: 'backlog', added: '2026-11-01' },
      {
        id: 'S-2',
        title: 'Two',
        component: 'C01',
        status: 'superseded',
        added: '2026-11-01',
        completed: '2026-11-02',
        body: '## Summary\n',
      },
      { id: 'S-3', title: 'Three', component: 'C01', status: 'in_progress', added: '2026-11-01', feature: 'F-7' },
    ],
    features: [
      { id: 'F-1', title: 'Refined', status: 'draft', added: '2026-11-01' },
      // A change document as bl wrote it before F-69: round 0, no status.
      {
        id: 'F-2',
        title: 'Run',
        status: 'running',
        added: '2026-11-01',
        branch: 'f2',
        review_round: 0,
        review_status: '',
      },
      {
        id: 'F-3',
        title: 'Pending',
        branch: 'f3',
        status: 'running',
        added: '2026-11-01',
        review_round: '1',
        review_status: 'pending',
        reviewLog: session('2026-11-05', 1),
      },
      {
        id: 'F-4',
        title: 'Fixed',
        branch: 'f4',
        status: 'running',
        added: '2026-11-01',
        review_round: '1',
        review_status: 'fixed',
        reviewLog: session('2026-11-05'),
      },
      {
        id: 'F-5',
        title: 'Addressed',
        branch: 'f5',
        status: 'running',
        added: '2026-11-01',
        review_round: '2',
        review_status: 'addressed',
        reviewLog: `${session('2026-11-07')}\n${session('2026-11-05')}`,
      },
      {
        id: 'F-6',
        title: 'Escalated',
        branch: 'f6',
        status: 'escalated',
        added: '2026-11-01',
        review_round: '1',
        review_status: 'pending',
        reviewLog: session('2026-11-05', 1),
      },
      {
        id: 'F-7',
        title: 'Live',
        branch: 'f7',
        status: 'running',
        added: '2026-11-01',
        review_round: '1',
        review_status: 'pending',
        reviewLog: session('2026-11-05', 1),
      },
    ],
  });
  // The `superseded_by:` of S-2, and T-1, which the fixture helper does not write.
  writeFileSync(
    join(dir, rel.s2),
    read(dir, rel.s2).replace('\ncompleted: 2026-11-02\n', '\ncompleted: 2026-11-02\nsuperseded_by: S-1\n'),
  );
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, rel.t1),
    '---\ntask_id: T-1\ntitle: Check\nunit: F-1\nowner: operator\nstatus: done\nadded: 2026-11-02\ndone: 2026-11-03\n---\n\n# Check\n',
  );
  writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  commitAt(dir, '2026-11-01T10:00:00Z', 'base');
  setStatus(dir, rel.f(1), 'draft', 'refined');
  commitAt(dir, '2026-11-02T10:00:00Z', 'refine F-1');
  setStatus(dir, rel.f(1), 'refined', 'draft');
  commitAt(dir, '2026-11-03T10:00:00Z', 'F-1 back to draft');
  setStatus(dir, rel.f(1), 'draft', 'refined');
  commitAt(dir, '2026-11-04T10:00:00Z', 'refine F-1 again');
  writeFileSync(join(dir, rel.f(1)), `${read(dir, rel.f(1))}\nAn edit.\n`);
  commitAt(dir, '2026-11-06T10:00:00Z', 'edit F-1');
  return dir;
}

/** Hold F-7's run lock (a kernel lock, F-104) from a child that is not the script's parent. */
function holdRunLock(dir) {
  mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
  return holdLockInChild(join(dir, '.bl', 'run', 'F-7.lock'));
}

const script = (dir, ...args) =>
  spawnSyncFiles(process.execPath, [SCRIPT, '--backlog', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const errors = (dir) => {
  const v = runBl(['validate', '--json'], { cwd: dir });
  return JSON.parse(v.stdout).findings.filter((f) => f.severity === 'error');
};
const legacyWarnings = (dir) => {
  const v = runBl(['validate', '--json'], { cwd: dir });
  return JSON.parse(v.stdout)
    .findings.filter((f) => f.code === 'legacy-status')
    .map((f) => f.location)
    .sort();
};

/** Entries as `to@at` (`by` when it is not `migrated`), for a short assertion. */
const entries = (dir, p) =>
  fm(dir, p).transitions.map((e) => {
    assert.equal(e.note.startsWith('migrated'), true, `${p}: ${JSON.stringify(e)}`);
    return `${e.to}@${e.at}${e.by === 'migrated' ? '' : ` by ${e.by}`}`;
  });

const COUNTS =
  'stories: 2 (entries: 3, placed by a change document: 0); features: 6 (entries: 24, placed by a change document: 4); ' +
  'tasks: 1 (entries: 2, placed by a change document: 0); change documents: 5; flow.json: v2';
const SKIPPED = [
  /^skipped S-3: its feature F-7: a bl run holds \.bl\/run\/F-7\.lock \(pid \d+\); a rerun converts it$/m,
  /^skipped F-7: a bl run holds \.bl\/run\/F-7\.lock \(pid \d+\); a rerun converts it$/m,
];

test('--dry-run prints the counts and the skipped units, and writes nothing', async (t) => {
  const dir = oldBacklog();
  const holder = await holdRunLock(dir);
  t.after(() => holder.kill());
  const before = head(dir);
  const r = script(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^would convert: ${COUNTS.replace(/[().]/g, '\\$&')}$`, 'm'));
  for (const re of SKIPPED) assert.match(r.stdout, re);
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a run writes each log with git dates in one commit, skips the live run, and a rerun converts it', async (t) => {
  const dir = oldBacklog();
  const holder = await holdRunLock(dir);
  t.after(() => holder.kill());
  const before = head(dir);
  const f7 = read(dir, rel.f(7));
  const f7Change = read(dir, rel.change(7));

  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^converted: ${COUNTS.replace(/[().]/g, '\\$&')}$`, 'm'));
  assert.match(r.stdout, /^committed 15 backlog path\(s\) in \w+ chore: F-69 transition-log migration: stories: 2 /m);
  for (const re of SKIPPED) assert.match(r.stdout, re);
  assert.equal(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(statusLines(dir), []);

  const day = (d) => `2026-11-${d}T00:00:00Z`;
  const base = '2026-11-01T10:00:00Z';
  assert.deepEqual(entries(dir, rel.s1), [`draft@${day('01')} by new`]);
  assert.deepEqual(entries(dir, rel.s2), [`draft@${day('01')} by new`, `superseded@${day('02')}`]);
  assert.equal(fm(dir, rel.s2).transitions[1].note, 'migrated; superseded_by: S-1');
  assert.deepEqual(entries(dir, rel.t1), [`draft@${day('02')} by new`, `done@${day('03')}`]);
  // The last commit that set `refined`, not the last that touched the file.
  assert.deepEqual(entries(dir, rel.f(1)), [`draft@${day('01')} by new`, 'refined@2026-11-04T10:00:00Z']);
  assert.deepEqual(entries(dir, rel.f(2)), [`draft@${day('01')} by new`, `in_progress@${base}`]);
  // `in_review` at the Review Log session, never before the entry above it.
  assert.deepEqual(entries(dir, rel.f(3)), [
    `draft@${day('01')} by new`,
    `in_progress@${base}`,
    `in_review@${day('05')}`,
    `fixing@${day('05')}`,
  ]);
  assert.deepEqual(entries(dir, rel.f(4)), [
    `draft@${day('01')} by new`,
    `in_progress@${base}`,
    `in_review@${base}`,
    `fixing@${base}`,
    `in_review@${day('05')}`,
  ]);
  assert.deepEqual(entries(dir, rel.f(5)), [
    `draft@${day('01')} by new`,
    `in_progress@${base}`,
    `in_review@${day('05')}`,
    `fixing@${day('05')}`,
    `in_review@${day('07')}`,
    `ready_for_merge@${day('07')}`,
  ]);
  // The git date is the `escalated` entry's, which stays after the review.
  assert.deepEqual(entries(dir, rel.f(6)), [
    `draft@${day('01')} by new`,
    `in_progress@${day('01')}`,
    `in_review@${day('05')}`,
    `fixing@${day('05')}`,
    `escalated@${day('05')}`,
  ]);

  // status: is gone and no other field changed; the log takes its place.
  const f3 = fm(dir, rel.f(3));
  assert.deepEqual(Object.keys(f3), ['feature_id', 'title', 'theme', 'transitions', 'added', 'review_rounds_max']);
  for (const n of [2, 3, 4, 5, 6]) {
    const c = fm(dir, rel.change(n));
    assert.equal(Object.hasOwn(c, 'review_round') || Object.hasOwn(c, 'review_status'), false, `F-${n}`);
    assert.equal(c.change_of, `F-${n}`);
  }
  assert.equal(read(dir, 'flow.json'), readFileSync(FLOW_TEMPLATE, 'utf8'));

  // The live run's feature, story and change document are as they were.
  assert.equal(read(dir, rel.f(7)), f7);
  assert.equal(read(dir, rel.change(7)), f7Change);
  assert.equal(fm(dir, rel.s3).status, 'in_progress');
  assert.deepEqual(errors(dir), []);
  assert.deepEqual(legacyWarnings(dir), [rel.f(7), rel.s3]);

  await holder.kill();
  const after = head(dir);
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(
    rerun.stdout,
    /^converted: stories: 1 \(entries: 2, placed by a change document: 0\); features: 1 \(entries: 4, placed by a change document: 1\); tasks: 0 .*; change documents: 1; flow\.json: unchanged$/m,
  );
  assert.equal(git(dir, 'rev-list', '--count', `${after}..HEAD`), '1');
  assert.deepEqual(entries(dir, rel.s3), [`draft@${day('01')} by new`, `in_progress@${base}`]);
  assert.deepEqual(entries(dir, rel.f(7)), [
    `draft@${day('01')} by new`,
    `in_progress@${base}`,
    `in_review@${day('05')}`,
    `fixing@${day('05')}`,
  ]);
  assert.deepEqual(errors(dir), []);
  assert.deepEqual(legacyWarnings(dir), []);

  const done = head(dir);
  const again = script(dir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'nothing to do\n');
  assert.equal(head(dir), done);
  assert.deepEqual(statusLines(dir), []);
});

test('a rerun after a failed commit, or after a unit that failed to convert, commits the paths of the first run', (t) => {
  /** A v1 backlog of three draft stories, in git; returns its root. */
  const small = () => {
    const { dir } = mkTempBacklog({
      flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
      repos: ['core'],
      components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
      stories: [1, 2, 3].map((n) => ({
        id: `S-${n}`,
        title: `S${n}`,
        component: 'C01',
        status: 'backlog',
        added: '2026-11-01',
      })),
    });
    writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
    git(dir, 'init', '-q', '-b', 'main');
    commitAt(dir, '2026-11-01T10:00:00Z', 'base');
    return dir;
  };
  const story = (n) => `stories/S${n}/index.md`;
  // [failure, how to make the first run fail, how to undo it]
  const failures = [
    [
      'a failed commit',
      (dir) => writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }),
      (dir) => writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
    ],
    [
      'a unit that failed to convert',
      (dir) => chmodSync(join(dir, 'stories/S2'), 0o555),
      (dir) => chmodSync(join(dir, 'stories/S2'), 0o755),
    ],
  ];
  for (const [name, fail, undo] of failures) {
    if (name.startsWith('a unit') && process.getuid?.() === 0) {
      t.diagnostic('root writes a read-only directory: the unit case is skipped');
      continue;
    }
    const dir = small();
    fail(dir);
    const first = script(dir);
    assert.equal(first.status, 1, `${name}: ${first.stdout}`);
    assert.notDeepEqual(statusLines(dir), [], `${name}: the first run wrote`);
    undo(dir);
    const rerun = script(dir);
    assert.equal(rerun.status, 0, `${name}: ${rerun.stderr}`);
    assert.deepEqual(statusLines(dir), [], `${name}: every path of both runs is committed`);
    assert.match(git(dir, 'log', '-1', '--format=%s'), /; carried from an earlier run: [1-9]\d* path\(s\)$/, name);
    for (const n of [1, 2, 3]) assert.equal(fm(dir, story(n)).transitions[0].to, 'draft', `${name}: S-${n}`);
    const again = script(dir);
    assert.equal(again.stdout, 'nothing to do\n', name);
  }
});

/** A v1 backlog of one draft story, in git, whose first migration run failed to commit; returns its root. */
function failedFirstRun() {
  const { dir } = mkTempBacklog({
    flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
    repos: ['core'],
    components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
    stories: [{ id: 'S-1', title: 'One', component: 'C01', status: 'backlog', added: '2026-11-01' }],
  });
  writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  commitAt(dir, '2026-11-01T10:00:00Z', 'base');
  const hook = join(dir, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(script(dir).status, 1, 'the first run fails to commit');
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}
const RECORD = '.bl/run/commit-failed/migrate-transitions.json';
const hasRecord = (dir) => existsSync(join(dir, RECORD));

test('a rerun after the operator committed the recorded paths by hand exits 0, commits nothing, and removes the record', () => {
  const dir = failedFirstRun();
  assert.equal(hasRecord(dir), true);
  commitAt(dir, '2026-11-02T10:00:00Z', 'by hand');
  const before = head(dir);
  for (const run of ['the rerun', 'a second rerun']) {
    const r = script(dir);
    assert.equal(r.status, 0, `${run}: ${r.stderr}`);
    assert.equal(head(dir), before, run);
    assert.equal(hasRecord(dir), false, run);
    // The rerun names each recorded path it leaves out; the second has no record left.
    const named = /^left out, committed or reverted since an earlier run wrote them: .*stories\/S1\/index\.md/m;
    if (run === 'the rerun') assert.match(r.stdout, named, run);
    else assert.doesNotMatch(r.stdout, named, run);
  }
});

test('a rerun names a recorded path that was edited since, and a dry run lists the carried paths', () => {
  const dir = failedFirstRun();
  const dry = script(dir, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^an earlier run wrote and did not commit: .*stories\/S1\/index\.md/m);
  assert.doesNotMatch(dry.stdout, /nothing to do/);
  assert.equal(hasRecord(dir), true, 'a dry run keeps the record');

  writeFileSync(join(dir, rel.s1), `${read(dir, rel.s1)}\nOperator note.\n`);
  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^left out, edited since an earlier run wrote them; commit them yourself: stories\/S1\/index\.md$/m,
  );
  // The failed commit staged it (`MM`); the path is what counts.
  assert.deepEqual(
    statusLines(dir).map((l) => l.slice(3)),
    [rel.s1],
    'only the edited path is uncommitted',
  );
  assert.equal(hasRecord(dir), false);
});

test('the migration sets added and completed from the log for a unit that has neither, so bl validate reports no error', () => {
  const { dir } = mkTempBacklog({
    flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
    repos: ['core'],
    components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
    stories: [
      { id: 'S-1', title: 'One', component: 'C01', status: 'refined' },
      { id: 'S-2', title: 'Two', component: 'C01', status: 'done' },
      { id: 'S-3', title: 'Three', component: 'C01', status: 'done', added: '2026-10-01', completed: '2026-10-05' },
    ],
  });
  writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  commitAt(dir, '2026-11-01T10:00:00Z', 'base');
  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  // [story, added, completed]: the commit that added the file, or the dates the unit had.
  for (const [id, added, completed] of [
    ['S-1', '2026-11-01', undefined],
    ['S-2', '2026-11-01', '2026-11-01'],
    ['S-3', '2026-10-01', '2026-10-05'],
  ]) {
    const after = fm(dir, `stories/${id.replace('-', '')}/index.md`);
    assert.equal(after.added, added, id);
    assert.equal(after.completed, completed, id);
  }
  assert.deepEqual(errors(dir), []);
});

test('the migration leaves an update story in the old shape, and a rerun prints the kept line and nothing to do', () => {
  const { dir } = mkTempBacklog({
    flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
    repos: ['core'],
    components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
    stories: [
      { id: 'S-1', title: 'One', component: 'C01', status: 'refined' },
      { id: 'S-2', title: 'Two', component: 'C01', status: 'done', added: '2026-10-01', completed: '2026-10-05' },
      { id: 'S-3', title: 'Three', component: 'C01', status: 'in_progress' },
    ],
  });
  // The `update_*` keys `bl updates` writes, which the fixture helper does not:
  // S-2 is a Renovate update story, S-3 a vulns story (no `update_branch`).
  for (const [p, status, update] of [
    [rel.s2, 'done', `update_repo: acme/core\nupdate_branch: renovate/dep-2\nupdate_pr: '2'\n`],
    [rel.s3, 'in_progress', 'update_repo: acme/core\nupdate_lockfile: pnpm-lock.yaml\n'],
  ]) {
    writeFileSync(join(dir, p), read(dir, p).replace(`\nstatus: ${status}\n`, `\nstatus: ${status}\n${update}`));
  }
  writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  commitAt(dir, '2026-11-01T10:00:00Z', 'base');
  const before = { [rel.s2]: read(dir, rel.s2), [rel.s3]: read(dir, rel.s3) };
  const kept = 'kept in the old shape (update stories, F-69 Out of Scope): 2';
  const keptRe = new RegExp(`^${kept.replace(/[().]/g, '\\$&')}$`, 'm');
  const dry = script(dir, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, keptRe);
  assert.match(dry.stdout, /^would convert: stories: 1 \(/m);
  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, keptRe);
  assert.match(r.stdout, /^converted: stories: 1 \(/m);
  for (const [p, status] of [
    [rel.s2, 'done'],
    [rel.s3, 'in_progress'],
  ]) {
    assert.equal(read(dir, p), before[p], p);
    assert.equal(fm(dir, p).status, status, p);
    assert.equal(Object.hasOwn(fm(dir, p), 'transitions'), false, p);
  }
  assert.equal(Object.hasOwn(fm(dir, rel.s1), 'status'), false);
  assert.equal(Array.isArray(fm(dir, rel.s1).transitions), true);
  assert.deepEqual(errors(dir), []);
  assert.deepEqual(legacyWarnings(dir), [rel.s2, rel.s3]);
  const after = head(dir);
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(rerun.stdout, `${kept}\nnothing to do\n`);
  assert.equal(head(dir), after);
});

test('the migration keeps an update story’s change document and counts a held update story as kept', async (t) => {
  const { dir } = mkTempBacklog({
    flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
    repos: ['core'],
    components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
    stories: [
      { id: 'S-1', title: 'One', component: 'C01', status: 'refined' },
      {
        id: 'S-2',
        title: 'Two',
        component: 'C01',
        status: 'in_review',
        branch: 'renovate/dep-2',
        review_round: '1',
        review_status: 'pending',
        reviewLog: session('2026-11-05', 1),
      },
      { id: 'S-3', title: 'Three', component: 'C01', status: 'in_progress' },
    ],
  });
  // S-2 has a change document with `review_round` and `review_status`; a live bl run holds S-3.
  for (const [p, status] of [
    [rel.s2, 'in_review'],
    [rel.s3, 'in_progress'],
  ]) {
    writeFileSync(
      join(dir, p),
      read(dir, p).replace(`\nstatus: ${status}\n`, `\nstatus: ${status}\nupdate_repo: acme/core\n`),
    );
  }
  writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  commitAt(dir, '2026-11-01T10:00:00Z', 'base');
  mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
  const holder = await holdLockInChild(join(dir, '.bl', 'run', 'S-3.lock'));
  t.after(() => holder.kill());
  const change2 = 'stories/S2/change.md';
  const files = [rel.s2, change2, rel.s3];
  const before = Object.fromEntries(files.map((p) => [p, read(dir, p)]));
  const kept = /^kept in the old shape \(update stories, F-69 Out of Scope\): 2$/m;

  for (const [args, verb] of [
    [['--dry-run'], 'would convert'],
    [[], 'converted'],
  ]) {
    const r = script(dir, ...args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, kept, verb);
    assert.doesNotMatch(r.stdout, /^skipped /m, verb);
    // counts.changes stays 0: the update story's change document is not counted.
    assert.match(r.stdout, new RegExp(`^${verb}: stories: 1 \\(.*; change documents: 0; `, 'm'), verb);
    for (const p of files) assert.equal(read(dir, p), before[p], `${verb}: ${p}`);
  }
  const c = fm(dir, change2);
  assert.equal(c.review_round, '1');
  assert.equal(c.review_status, 'pending');
});

test('migration leaves added and completed equal to the log’s first and terminal entries, also when the clamp moved an entry', () => {
  const { dir } = mkTempBacklog({
    flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
    repos: ['core'],
    components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
    stories: [
      // completed: before added:, which the log cannot hold.
      { id: 'S-1', title: 'One', component: 'C01', status: 'done', added: '2026-10-05', completed: '2026-10-01' },
      // The dates agree: they stay.
      { id: 'S-2', title: 'Two', component: 'C01', status: 'done', added: '2026-10-01', completed: '2026-10-05' },
    ],
    features: [
      // The latest Review Log session is after completed:.
      {
        id: 'F-1',
        title: 'Late review',
        status: 'done',
        added: '2026-10-01',
        completed: '2026-10-03',
        branch: 'f1',
        review_round: '1',
        review_status: 'addressed',
        reviewLog: session('2026-10-09'),
      },
      // An in_progress feature whose session is before added:: no terminal entry.
      {
        id: 'F-2',
        title: 'Early review',
        status: 'running',
        added: '2026-10-05',
        branch: 'f2',
        review_round: '1',
        review_status: 'pending',
        reviewLog: session('2026-10-01', 1),
      },
    ],
  });
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  // done: before added:, the task's terminal date.
  writeFileSync(
    join(dir, rel.t1),
    '---\ntask_id: T-1\ntitle: Check\nunit: F-1\nowner: operator\nstatus: done\nadded: 2026-10-05\ndone: 2026-10-01\n---\n\n# Check\n',
  );
  writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  commitAt(dir, '2026-11-01T10:00:00Z', 'base');
  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  // [unit file, the terminal date field, added, completed (null: none)]
  for (const [p, key, added, completed] of [
    [rel.s1, 'completed', '2026-10-05', '2026-10-05'],
    [rel.s2, 'completed', '2026-10-01', '2026-10-05'],
    [rel.f(1), 'completed', '2026-10-01', '2026-10-09'],
    [rel.f(2), 'completed', '2026-10-05', null],
    [rel.t1, 'done', '2026-10-05', '2026-10-05'],
  ]) {
    const after = fm(dir, p);
    const log = after.transitions;
    assert.equal(after.added, log[0].at.slice(0, 10), `${p}: added is the first entry's day`);
    assert.equal(after.added, added, p);
    assert.equal(after[key] ?? null, completed, p);
    if (completed) assert.equal(after[key], log.at(-1).at.slice(0, 10), `${p}: ${key} is the terminal entry's day`);
  }
  assert.deepEqual(errors(dir), []);
});

test('migration writes the synthesized log for a unit whose transitions: is empty or blank, and never removes status: without a log', () => {
  // [story, status:, the transitions: line, the log it gets (null: kept as it is)]
  const cases = [
    ['S-1', 'in_progress', 'transitions: []', ['draft', 'in_progress']],
    ['S-2', 'refined', 'transitions:', ['draft', 'refined']],
    ['S-3', 'refined', "transitions: ''", ['draft', 'refined']],
    ['S-4', 'in_progress', 'transitions: oops', null],
    ['S-5', 'refined', 'transitions:\n  to: refined', null],
    ['S-6', 'refined', 'transitions:\n  - by: new', null],
  ];
  const { dir } = mkTempBacklog({
    flow: JSON.parse(readFileSync(V1_FLOW, 'utf8')),
    repos: ['core'],
    components: [{ id: 'C01', title: 'core', dirSuffix: 'core', repo: 'core', home: true }],
    stories: cases.map(([id, status]) => ({ id, title: id, component: 'C01', status, added: '2026-11-01' })),
  });
  const path = (id) => `stories/${id.replace('-', '')}/index.md`;
  for (const [id, status, line] of cases) {
    writeFileSync(
      join(dir, path(id)),
      read(dir, path(id)).replace(`\nstatus: ${status}\n`, `\nstatus: ${status}\n${line}\n`),
    );
  }
  writeFileSync(join(dir, '.gitignore'), '.workon.lock\n.bl/\n');
  git(dir, 'init', '-q', '-b', 'main');
  commitAt(dir, '2026-11-01T10:00:00Z', 'base');
  const before = Object.fromEntries(cases.map(([id]) => [id, read(dir, path(id))]));

  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  for (const [id, status, line, log] of cases) {
    const name = `${id}: ${line}`;
    if (log == null) {
      assert.equal(read(dir, path(id)), before[id], `${name}: the file is as it was`);
      assert.match(
        r.stdout,
        new RegExp(`^skipped ${id}: transitions: is not a list of entries .*; fix it, then a rerun converts it$`, 'm'),
        name,
      );
      continue;
    }
    const after = fm(dir, path(id));
    assert.equal(Object.hasOwn(after, 'status'), false, name);
    assert.deepEqual(
      after.transitions.map((e) => e.to),
      log,
      name,
    );
    assert.equal(fm(dir, path(id)).transitions.at(-1).to, status, name);
  }
  assert.deepEqual(statusLines(dir), []);
});
