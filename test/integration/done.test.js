import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { mkTempBacklog, STORY_INDEX_TEMPLATE } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { GIT_ENV, git, initGitBacklog, headFiles, dirtyBystanders, statusLines } from '../helpers/git-backlog.js';

const FOUNDATION = { id: 'C00', title: 'Foundation', dirSuffix: 'foundation' };

/** A backlog with one component and S-1 in it, written as `bl new` would. */
function backlogWithStory(title = 'First Story', fixture = {}) {
  const t = mkTempBacklog({
    components: [FOUNDATION],
    stories: [{ id: 'S-1', component: 'C00', title, dirSuffix: 'first-story', points: 1 }],
    ...fixture,
  });
  return { ...t, rel: 'stories/S1-first-story/index.md' };
}

/** The story's frontmatter, read where it was written: done moves nothing. */
function storyFm(dir, rel) {
  return parseFrontmatter(readFileSync(join(dir, rel), 'utf8')).fm;
}

/** No `.completed/` anywhere under the backlog's unit directories. */
function assertNothingArchived(dir) {
  for (const root of ['stories', 'components', 'features']) {
    assert.ok(!existsSync(join(dir, root, '.completed')), `${root}/.completed/ exists`);
  }
  assert.deepEqual(readdirSync(join(dir, 'stories')), ['S1-first-story']);
}

test('bl done <story-id> sets status, commit and completed, and moves nothing', () => {
  const { dir, rel, cleanup } = backlogWithStory();
  try {
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fm = storyFm(dir, rel);
    assert.equal(fm.status, 'done');
    assert.equal(fm.commit, 'deadbeef');
    assert.match(fm.completed, /^\d{4}-\d{2}-\d{2}$/);
    assertNothingArchived(dir);
    assert.doesNotMatch(r.stderr, /Archived/);
  } finally {
    cleanup();
  }
});

test('bl done --superseded marks story as superseded rather than done', () => {
  const { dir, rel, cleanup } = backlogWithStory('Doomed');
  try {
    const r = runBl(['done', '--superseded', 'S-1', 'abcdef0'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(storyFm(dir, rel).status, 'superseded');
    assertNothingArchived(dir);
  } finally {
    cleanup();
  }
});

test('bl done refuses a component: it has no status; an E-id is told components are C-ids', () => {
  const { dir, cleanup } = backlogWithStory('still going');
  try {
    const before = readFileSync(join(dir, 'components', 'C00-foundation', 'index.md'), 'utf8');
    const r = runBl(['done', 'C00'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /C00 is a component: a code boundary with no status, so it is never done\./);
    assert.equal(readFileSync(join(dir, 'components', 'C00-foundation', 'index.md'), 'utf8'), before);
    const e = runBl(['done', 'E00'], { cwd: dir });
    assert.equal(e.status, 1);
    assert.match(e.stderr, /E00 is not a component id: components are C-ids \(C00\)\./);
  } finally {
    cleanup();
  }
});

test('bl done refuses a story that is already done', () => {
  const { dir, rel, cleanup } = backlogWithStory();
  try {
    assert.equal(runBl(['done', 'S-1', 'deadbeef'], { cwd: dir }).status, 0);
    const before = readFileSync(join(dir, rel), 'utf8');
    const r = runBl(['done', 'S-1', 'cafef00d'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Story S-1 is already marked done\./);
    assert.equal(readFileSync(join(dir, rel), 'utf8'), before);
  } finally {
    cleanup();
  }
});

/** Write the story's change document with `reviewStatus` and a Review Log of `items`. */
function writeReview(dir, rel, reviewStatus, date, items) {
  const { fm } = parseFrontmatter(readFileSync(join(dir, rel), 'utf8'));
  const log =
    items == null
      ? ''
      : `\n## Review Log\n\n### Session ${date} (PR #1)\n\n**Must fix**\n\n${items}\n\n**Should fix**\nNone.\n\n**Nits**\nNone.\n`;
  writeFileSync(
    join(dirname(join(dir, rel)), 'change.md'),
    `---\nchange_of: S-1\nstatus: open\nreview_status: ${reviewStatus}\n---\n\n# ${fm.title}\n${log}`,
  );
}

test('bl done refuses while review_status: pending', () => {
  const { dir, rel, cleanup } = backlogWithStory('Pending Review Story');
  try {
    writeReview(dir, rel, 'pending', '2026-05-11', '- [ ] still open');
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /review_status: pending/);
    assert.match(r.stderr, /1 unchecked item/);
    assert.match(r.stderr, /2026-05-11/);
    assert.equal(storyFm(dir, rel).status, 'backlog', 'the story is left as it was');
  } finally {
    cleanup();
  }
});

test('bl done refuses while review_status: fixed (awaiting re-review)', () => {
  const { dir, rel, cleanup } = backlogWithStory('Fixed Awaiting Rereview');
  try {
    writeReview(dir, rel, 'fixed', '2026-07-01', '- [x] was broken → fixed in abc1234');
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.notEqual(r.status, 0, 'fixed must block done until re-reviewed');
    assert.match(r.stderr, /review_status: fixed/);
    assert.match(r.stderr, /bl review S-1/);
  } finally {
    cleanup();
  }
});

test('bl done refuses when addressed but the latest session has unchecked items', () => {
  const { dir, rel, cleanup } = backlogWithStory('Falsely Addressed Story');
  try {
    writeReview(dir, rel, 'addressed', '2026-07-01', '- [ ] never actually fixed');
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.notEqual(r.status, 0, 'unchecked items must block done even when frontmatter says addressed');
    assert.match(r.stderr, /1 unchecked item/);
  } finally {
    cleanup();
  }
});

test('bl done proceeds when review_status: addressed', () => {
  const { dir, rel, cleanup } = backlogWithStory('Addressed Review Story');
  try {
    writeReview(dir, rel, 'addressed', '', null);
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(storyFm(dir, rel).status, 'done');
  } finally {
    cleanup();
  }
});

test('bl done --commit <repo>=<sha> records a map in frontmatter', () => {
  // Two-repo project so both repo names are known to the config.
  const { dir, rel, cleanup } = backlogWithStory('First Story', {
    repos: ['../repos/bl', '../repos/containers'],
  });
  try {
    const r = runBl(['done', 'S-1', '--commit', 'bl=abc1234', '--commit', 'containers=def5678'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fm = storyFm(dir, rel);
    assert.deepEqual(fm.commit, { bl: 'abc1234', containers: 'def5678' });
    assert.equal(fm.status, 'done');
  } finally {
    cleanup();
  }
});

test('bl done rejects --commit referencing an unknown repo', () => {
  const { dir, cleanup } = backlogWithStory('First Story', {
    repos: ['../repos/bl'],
  });
  try {
    const r = runBl(['done', 'S-1', '--commit', 'mystery=abc1234'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown repo "mystery"/);
  } finally {
    cleanup();
  }
});

test('bl done refuses to mix the positional [commit-hash] with --commit', () => {
  const { dir, cleanup } = backlogWithStory('First Story', {
    repos: ['../repos/bl'],
  });
  try {
    const r = runBl(['done', 'S-1', 'deadbeef', '--commit', 'bl=abc1234'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cannot mix/i);
  } finally {
    cleanup();
  }
});

test('bl done rejects --commit values without a repo=sha shape', () => {
  const { dir, cleanup } = backlogWithStory('First Story', {
    repos: ['../repos/bl'],
  });
  try {
    const r = runBl(['done', 'S-1', '--commit', 'bareword'], { cwd: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expected <repo>=<sha>/);
  } finally {
    cleanup();
  }
});

test('legacy string commit frontmatter round-trips through bl sync without losing the value', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/bl'],
    components: [FOUNDATION],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Legacy',
        type: 'feature',
        points: 1,
        status: 'done',
        completed: '2026-05-01',
      },
    ],
  });
  try {
    // Inject a legacy bare-string commit into the seeded story file.
    const indexPath = join(dir, 'stories', 'S1', 'index.md');
    const original = readFileSync(indexPath, 'utf8');
    writeFileSync(indexPath, original.replace('---\n\n# Legacy', 'commit: abc1234\n---\n\n# Legacy'));
    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(indexPath, 'utf8'), /^commit: abc1234$/m);
  } finally {
    cleanup();
  }
});

test('map commit frontmatter survives a bl sync round-trip on disk', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/bl', '../repos/containers'],
    components: [FOUNDATION],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Multi',
        type: 'feature',
        points: 1,
        status: 'done',
        completed: '2026-05-01',
      },
    ],
  });
  try {
    const indexPath = join(dir, 'stories', 'S1', 'index.md');
    const original = readFileSync(indexPath, 'utf8');
    const mapFm = 'commit:\n  bl: abc1234\n  containers: def5678\n';
    writeFileSync(indexPath, original.replace('---\n\n# Multi', `${mapFm}---\n\n# Multi`));

    const r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(indexPath, 'utf8');
    assert.match(after, /^commit:$/m);
    assert.match(after, /^  bl: abc1234$/m);
    assert.match(after, /^  containers: def5678$/m);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S-704: `bl done` commits its own backlog change, and only that.
// ---------------------------------------------------------------------------

const S1 = 'stories/S1-target';
const S2 = 'stories/S2-bystander';

/** A git-backed backlog: C01 with S-1 (target) and S-2 (bystander), empty C02. */
function gitDoneBacklog() {
  const t = mkTempBacklog({
    components: [
      { id: 'C01', title: 'Core', dirSuffix: 'core' },
      { id: 'C02', title: 'Other', dirSuffix: 'other' },
    ],
    stories: [
      ['S-1', 'target'],
      ['S-2', 'bystander'],
    ].map(([id, dirSuffix]) => ({ id, component: 'C01', title: `Story ${dirSuffix}`, dirSuffix })),
  });
  initGitBacklog(t.dir);
  dirtyBystanders(t.dir, `${S2}/index.md`);
  return t;
}

/** The bystander edit and the pre-staged file are all that is left dirty. */
function assertOnlyBystandersDirty(dir) {
  assert.deepEqual(statusLines(dir), [` M ${S2}/index.md`, 'A  staged.txt']);
}

/** A path `bl sync` regenerates whole (backlog-commit.js isGeneratedPath). */
const isIndex = (p) => p === 'index.md' || /^(projects|components)\/[^/]+\/index\.md$/.test(p);

test("bl done commits the story's status change in place and the rewritten indexes, nothing else", () => {
  const { dir, cleanup } = gitDoneBacklog();
  try {
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Committed \d+ backlog path\(s\)\./);

    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: mark S-1 done');
    const files = headFiles(dir);
    assert.ok(files.includes(`M\t${S1}/index.md`), files.join('\n'));
    assert.deepEqual(
      files.filter((f) => f !== `M\t${S1}/index.md`).filter((f) => !(f.startsWith('M\t') && isIndex(f.slice(2)))),
      [],
      'only the story and generated indexes, and nothing added or removed',
    );
    const { fm } = parseFrontmatter(git(dir, 'show', `HEAD:${S1}/index.md`));
    assert.equal(fm.status, 'done');
    assert.equal(fm.commit, 'deadbeef');
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test("bl done --superseded commits under a 'mark S-N superseded' subject", () => {
  const { dir, cleanup } = gitDoneBacklog();
  try {
    const r = runBl(['done', '--superseded', 'S-1', 'abc1234'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: mark S-1 superseded');
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl done on a story that was never committed adds it, and removes nothing', () => {
  const { dir, cleanup } = gitDoneBacklog();
  try {
    mkdirSync(join(dir, 'stories', 'S3-fresh'));
    writeFileSync(
      join(dir, 'stories', 'S3-fresh', 'index.md'),
      STORY_INDEX_TEMPLATE({ id: 'S-3', component: 'C02', title: 'Fresh' }),
    );
    const r = runBl(['done', 'S-3', 'deadbeef'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);

    const files = headFiles(dir);
    assert.ok(files.includes('A\tstories/S3-fresh/index.md'), files.join('\n'));
    assert.ok(!files.some((f) => f.startsWith('D\t')), files.join('\n'));
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl done <component> commits nothing', () => {
  const { dir, cleanup } = gitDoneBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl(['done', 'C02'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 1);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assertOnlyBystandersDirty(dir);
  } finally {
    cleanup();
  }
});

test('bl done exits 1 and names the paths when the commit fails, leaving the edit on disk', () => {
  const { dir, cleanup } = gitDoneBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);

    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /backlog commit failed/);
    assert.match(r.stderr, /Commit these backlog paths by hand:/);
    assert.match(r.stderr, new RegExp(`${S1}/index\\.md`));
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(parseFrontmatter(readFileSync(join(dir, S1, 'index.md'), 'utf8')).fm.status, 'done');
  } finally {
    cleanup();
  }
});

test('bl done in a backlog that is not a git repo skips the commit with a notice', () => {
  const { dir, cleanup } = backlogWithStory();
  try {
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not a git repository; skipping commit/);
  } finally {
    cleanup();
  }
});

// F-67 S-1097: `bl done` writes the story through `updateSpecFile`.

const DONE_FAULTS = join(dirname(new URL(import.meta.url).pathname), '..', 'helpers', 'done-faults.js');

/** A backlog whose S-1 has a repo, so `bl done` reads its transcripts. */
function backlogWithRepo() {
  const t = mkTempBacklog({
    repos: { code: './code' },
    components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
    stories: [{ id: 'S-1', component: 'C00', title: 'T', dirSuffix: 'a' }],
  });
  return { ...t, path: join(t.dir, 'stories', 'S1-a', 'index.md') };
}

test('bl done: a failed write of the story leaves the previous spec and no staging file, fails, and a retry writes it', () => {
  const { dir, rel, cleanup } = backlogWithStory();
  try {
    const path = join(dir, rel);
    const before = readFileSync(path, 'utf8');
    const env = { NODE_OPTIONS: `--import=${DONE_FAULTS}`, BL_DONE_FAULT: 'partial', BL_DONE_FAULT_TARGET: path };
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir, env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /bl done: could not write stories\/S1-first-story\/index\.md: injected ENOSPC/);
    assert.equal(readFileSync(path, 'utf8'), before, 'the previous spec is whole');
    assert.deepEqual(
      existsSync(join(dir, '.bl', 'tmp')) ? readdirSync(join(dir, '.bl', 'tmp')) : [],
      [],
      'no staging file left',
    );

    const again = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(storyFm(dir, rel).status, 'done');
  } finally {
    cleanup();
  }
});

test('bl done: a token write racing the reconciliation keeps the session difference, and the totals stay at or above the map', async () => {
  const { dir, path, cleanup } = backlogWithRepo();
  try {
    const out = join(dir, 'race-out.json');
    const env = {
      NODE_OPTIONS: `--import=${DONE_FAULTS}`,
      BL_DONE_FAULT: 'race',
      BL_DONE_FAULT_TARGET: path,
      BL_DONE_FAULT_OUT: out,
    };
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir, env });
    assert.equal(r.status, 0, r.stderr);
    // The racing writer waited on the spec lock; it finishes after bl done.
    for (let i = 0; i < 200 && !existsSync(out); i++) await new Promise((res) => setTimeout(res, 25));
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { wrote: true });
    const fm = parseFrontmatter(readFileSync(path, 'utf8')).fm;
    assert.equal(fm.status, 'done');
    assert.equal(fm.commit, 'deadbeef');
    assert.equal(fm.tokens_by_step?.implement?.input, '5', 'the session difference is kept');
    assert.equal(fm.tokens_input, '20', 'the reconciled 15 plus the difference written after it');
    assert.ok(BigInt(fm.tokens_input) >= BigInt(fm.tokens_by_step.implement.input), 'totals at or above the map');
  } finally {
    cleanup();
  }
});

test('bl done: a CRLF story keeps one frontmatter block and its line end', () => {
  const { dir, rel, cleanup } = backlogWithStory();
  try {
    const path = join(dir, rel);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'));
    const r = runBl(['done', 'S-1', 'deadbeef'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(path, 'utf8');
    assert.equal(text.match(/^---\r$/gm).length, 2, 'one block');
    assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'every line ends CRLF');
    assert.equal(parseFrontmatter(text.replace(/\r\n/g, '\n')).fm.status, 'done');
  } finally {
    cleanup();
  }
});
