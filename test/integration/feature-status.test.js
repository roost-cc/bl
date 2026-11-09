import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { rendered } from '../helpers/rendered.js';
import { HOME, REPOS } from '../helpers/feature-fixture.js';

test('bl implement refuses unapproved features with a hint', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', primary_repo: 'demo-repo' }],
  });
  try {
    const r = runBl(['implement', 'F-1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl approve F-1/);
    const rv = runBl(['review', 'F-1'], { cwd: dir });
    assert.equal(rv.status, 1);
    assert.match(rv.stderr, /no branch yet/);
  } finally {
    cleanup();
  }
});

test('bl status prints stories in dependency order plus review and blocker state', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'First',
        dirSuffix: 'first',
        points: 3,
        effort: 'low',
        feature: 'F-1',
        depends_on: 'S-2',
      },
      { id: 'S-2', component: 'C00', title: 'Second', dirSuffix: 'second', points: 5, feature: 'F-1' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-1', 'S-2'],
        branch: 'f1-feat',
        review_status: 'pending',
        reviewLog:
          '### Session 2026-09-20 (PR #7)\n\n**Must fix**\n\n- [ ] invariant X — Repro: y. Test: z.\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
        escalation: 'Design problem: premise false.',
      },
    ],
  });
  try {
    const r = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /status: running/);
    assert.match(r.stdout, /branch: f1-feat/);
    assert.match(r.stdout, /review: round 0\/2 done: 1 open item \(1 Must fix\), latest session 2026-09-20\n/);
    // S-2 first (S-1 depends on it)
    const s2 = r.stdout.indexOf('S-2');
    const s1 = r.stdout.indexOf('S-1');
    assert.ok(s2 < s1, 'S-2 should be listed before S-1');
    // Each story's effort, an unset one at effort.default (F-85 D1).
    assert.match(r.stdout, /# +ID +Status +Pts +Effort +Component +Title/);
    assert.match(r.stdout, /S-2 +backlog +5 +high \(default\) +C00 +Second/);
    assert.match(r.stdout, /S-1 +backlog +3 +low +C00 +First/);
    assert.match(r.stdout, /escalation:\nDesign problem/);
  } finally {
    cleanup();
  }
});

test('bl merge refuses on pending review and on an open escalation', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    // The gates run once the feature's repos are known (F-36 D1).
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', feature: 'F-2' },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Pending',
        dirSuffix: 'pending',
        status: 'running',
        stories: ['S-1'],
        branch: 'f1-pending',
        review_status: 'pending',
        reviewLog:
          '### Session 2026-09-20 (PR #7)\n\n**Must fix**\n\n- [ ] open item\n\n**Should fix**\nNone.\n\n**Nits**\nNone.',
      },
      {
        id: 'F-2',
        title: 'Escalated',
        dirSuffix: 'escalated',
        status: 'escalated',
        stories: ['S-2'],
        branch: 'f2-escalated',
        review_status: 'addressed',
        escalation: 'Premise does not hold: see S-605.',
      },
      { id: 'F-3', title: 'Unstarted', dirSuffix: 'unstarted', status: 'approved', primary_repo: 'demo-repo' },
    ],
  });
  try {
    let r = runBl(['merge', 'F-1'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unresolved review state/);
    assert.match(r.stderr, /1 unchecked/);
    r = runBl(['merge', 'F-2'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /open Escalation section/);
    r = runBl(['merge', 'F-3'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /nothing has been implemented/);
  } finally {
    cleanup();
  }
});

test('bl validate reports feature link drift and verification-only titles', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'Dangling', dirSuffix: 'dangling', feature: 'F-9' },
      { id: 'S-2', component: 'C00', title: 'In F-1', dirSuffix: 'in', feature: 'F-1' },
      { id: 'S-3', component: 'C00', title: 'In F-1 too', dirSuffix: 'too', feature: 'F-1' },
      { id: 'S-4', component: 'C00', title: 'Verify the login flow still works', dirSuffix: 'verify' },
      {
        id: 'S-5',
        component: 'C00',
        title: 'Confirm CI is green',
        dirSuffix: 'confirm',
        status: 'done',
        completed: '2026-01-01',
      },
    ],
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', branch: 'f1-feat' },
      { id: 'F-2', title: 'Other', dirSuffix: 'other', status: 'approved', primary_repo: 'demo-repo' },
    ],
  });
  try {
    // A stored copy of a derived key is an error, whatever it says (F-77 D3).
    const f1 = join(dir, 'features', 'F1-feat', 'index.md');
    writeFileSync(f1, readFileSync(f1, 'utf8').replace(/^status: running$/m, 'status: running\nstories: [S-2, S-42]'));
    const r = runBl(['validate', '--json'], { cwd: dir });
    const { findings } = JSON.parse(r.stdout);
    const codes = findings.map((f) => `${f.code}:${f.location}`);
    assert.ok(codes.includes('dangling-feature:stories/S1-dangling/index.md'), codes.join('\n'));
    assert.ok(codes.includes('derived-key:features/F1-feat/index.md'), codes.join('\n'));
    assert.ok(!codes.some((c) => c.startsWith('feature-story-')), codes.join('\n'));
    assert.ok(codes.includes('feature-no-stories:features/F2-other/index.md'), codes.join('\n'));
    assert.ok(codes.includes('verification-only-title:stories/S4-verify/index.md'), codes.join('\n'));
    // Done stories are not relitigated.
    assert.ok(!codes.some((c) => c.startsWith('verification-only-title:') && c.includes('S5-confirm')));
    assert.equal(r.status, 1, 'link errors must fail validate');
    // --skip suppresses the title warning; feature errors stay.
    const s = runBl(['validate', '--json', '--skip', 'verification-only-title'], { cwd: dir });
    const skipped = JSON.parse(s.stdout).findings.map((f) => f.code);
    assert.ok(!skipped.includes('verification-only-title'));
    assert.ok(skipped.includes('dangling-feature'));
    // human mode mentions features in the scan line
    const h = runBl(['validate'], { cwd: dir });
    assert.match(h.stderr, /scanning 5 stories across 1 component… \(2 features\)/);
  } finally {
    cleanup();
  }
});

test('bl validate flags bad feature frontmatter (status, id/dir)', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'cooking', primary_repo: 'demo-repo' }],
  });
  try {
    const featurePath = join(dir, 'features', 'F1-feat', 'index.md');
    writeFileSync(featurePath, readFileSync(featurePath, 'utf8').replace('feature_id: F-1', 'feature_id: F-7'));
    const r = runBl(['validate', '--json'], { cwd: dir });
    const codes = JSON.parse(r.stdout)
      .findings.filter((f) => f.location === 'features/F1-feat/index.md')
      .map((f) => f.code);
    assert.ok(codes.includes('bad-status'), codes.join(','));
    assert.ok(codes.includes('id-dir-mismatch'), codes.join(','));
  } finally {
    cleanup();
  }
});

test('bl sync leaves a done feature where it is and writes nothing; the rendered root leaves it out', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'A',
        dirSuffix: 'a',
        points: 3,
        feature: 'F-1',
        status: 'done',
        completed: '2026-01-01',
      },
      { id: 'S-2', component: 'C00', title: 'B', dirSuffix: 'b', points: 2, feature: 'F-2' },
    ],
    features: [
      { id: 'F-1', title: 'Done one', dirSuffix: 'done-one', status: 'done', stories: ['S-1'] },
      { id: 'F-2', title: 'Live one', dirSuffix: 'live-one', status: 'approved', stories: ['S-2'] },
    ],
  });
  try {
    let r = runBl(['sync'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    // Status is frontmatter, never location (F-49 D3).
    assert.ok(existsSync(join(dir, 'features', 'F1-done-one', 'index.md')));
    assert.ok(!existsSync(join(dir, 'features', '.completed')));
    assert.match(r.stderr, /^(?!.*migrate)/s);
    assert.ok(!existsSync(join(dir, 'index.md')));
    const root = rendered(dir);
    assert.match(root, /\[F-2\]\(features\/F2-live-one\/index\.md\)/);
    assert.doesNotMatch(root, /F-1/);
  } finally {
    cleanup();
  }
});

test('bl list shows a Feature column only when a listed story belongs to one; bl which/feature list resolve F ids', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'Plain', dirSuffix: 'plain' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'refined', stories: [] }],
  });
  try {
    let r = runBl(['list'], { cwd: dir });
    assert.doesNotMatch(r.stdout, /Feature/);
    const storyPath = join(dir, 'stories', 'S1-plain', 'index.md');
    writeFileSync(
      storyPath,
      readFileSync(storyPath, 'utf8').replace('status: backlog\n', 'status: backlog\nfeature: F-1\n'),
    );
    r = runBl(['list'], { cwd: dir });
    assert.match(r.stdout, /Feature/);
    assert.match(r.stdout, /F-1/);
    const w = runBl(['which', 'f1'], { cwd: dir });
    assert.equal(w.stdout.trim(), join(dir, 'features', 'F1-feat', 'index.md'));
    const l = runBl(['list', '--features'], { cwd: dir });
    assert.equal(l.status, 0, l.stderr);
    assert.match(l.stdout, /F-1\s+refined/);
    const h = runBl(['approve', '--help'], { cwd: dir });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /Usage: bl approve <id\.\.\.>/);
  } finally {
    cleanup();
  }
});

test('bl run --plan prints the steps; run refuses unapproved features and unknown agents cleanly', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [{ id: 'C00', title: 'Core', dirSuffix: 'core' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'First', dirSuffix: 'first', points: 3, feature: 'F-1' },
      {
        id: 'S-2',
        component: 'C00',
        title: 'Second',
        dirSuffix: 'second',
        points: 5,
        feature: 'F-1',
        depends_on: 'S-1',
      },
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'approved',
        stories: ['S-2', 'S-1'],
        review_rounds_max: 3,
      },
      { id: 'F-2', title: 'Draft', dirSuffix: 'draft', status: 'refined', stories: ['S-1'] },
    ],
  });
  try {
    let r = runBl(['run', '--plan', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1\. setup/);
    assert.match(r.stdout, /2\. implement S-1\n 3\. implement S-2/, 'dependency order, not listed order');
    assert.match(r.stdout, /re-review \(round 3\)/);
    r = runBl(['run', 'F-1', '--plan', '--max-rounds', '1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /re-review/);
    r = runBl(['run', 'F-2'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl approve F-2/);
    r = runBl(['run', 'F-1', '-A', 'gemini'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /No configuration in backlog\.json "agent" has a headless mode \(gemini\); use --interactive\./,
    );
    // -A sets the implementing list only; the fixture reviews on codex, so
    // every reviewer would review its own work (F-64 D4).
    r = runBl(['run', 'F-1', '-A', 'codex'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /Every backlog\.json "review_agent" configuration \(codex\) is also an "agent" configuration, and the reviewer is never the implementer/,
    );
  } finally {
    cleanup();
  }
});

test('bl status prints the latest outcome of each step under the run line (F-68 D4)', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', branch: 'f1-feat' }],
  });
  try {
    mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
    writeFileSync(
      join(dir, '.bl', 'run', 'F-1.json'),
      JSON.stringify({
        feature: 'F-1',
        status: 'clean',
        step: 'review',
        updatedAt: '2026-11-09T12:00:00Z',
        history: [
          { step: 'implement', story: 'S-1', ok: true, outcome: 'first try', note: 'outcome: first try' },
          { step: 'implement', story: 'S-2', ok: true, outcome: 'built S-2', note: 'outcome: built S-2' },
          { step: 'implement', story: 'S-1', ok: true, outcome: 'finished S-1', note: 'outcome: finished S-1' },
          { step: 'test', ok: false, note: 'node exited 1' },
          { step: 'fix-tests', ok: true, outcome: 'fixed the race', note: 'outcome: fixed the race' },
          { step: 'review:correctness', ok: true, note: '' },
          { step: 'review:verify', ok: true, outcome: 'clean', note: 'outcome: clean' },
        ],
      }),
    );
    const r = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /\(updated 2026-11-09T12:00:00Z, 7 events, last: outcome: clean\)\n {2}implement S-2: outcome: built S-2\n {2}implement S-1: outcome: finished S-1\n {2}fix-tests: outcome: fixed the race\n {2}review:verify: outcome: clean\n/,
    );
    assert.doesNotMatch(r.stdout, /first try|review:correctness: outcome|said:/);
  } finally {
    cleanup();
  }
});

test("bl status reports the last run's state from .bl/run", () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'escalated', branch: 'f1-feat' }],
  });
  try {
    mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
    writeFileSync(
      join(dir, '.bl', 'run', 'F-1.json'),
      JSON.stringify({
        feature: 'F-1',
        status: 'escalated',
        step: 'test',
        lastError: 'test gate failed twice',
        updatedAt: '2026-09-24T12:00:00Z',
        history: [
          { step: 'implement', story: 'S-1', ok: false, note: 'denied: Bash(touch x)' },
          { step: 'test', ok: true },
          { step: 'test', ok: false, note: 'node exited 1' },
        ],
      }),
    );
    const r = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /run: escalated at step test — test gate failed twice \(updated 2026-09-24T12:00:00Z, 3 events, last: node exited 1\)/,
    );
    assert.match(r.stdout, /✗ implement S-1: denied: Bash\(touch x\)\n {2}✗ test: node exited 1/);

    // An open escalation refuses the run before the worktree is touched, so
    // the feature stays `escalated` instead of flipping to `running`.
    const fpath = join(dir, 'features', 'F1-feat', 'index.md');
    writeFileSync(
      fpath,
      readFileSync(fpath, 'utf8').replace(/## Escalation\n\nNone\./, '## Escalation\n\nStill open.'),
    );
    const run = runBl(['run', 'F-1'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /open ## Escalation/);
    assert.equal(parseFrontmatter(readFileSync(fpath, 'utf8')).fm.status, 'escalated');
  } finally {
    cleanup();
  }
});

test("bl status prints each repo's branch, PR, URL and merge state from the change documents, every one when there are several", () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', branch: 'f1-feat' }],
  });
  try {
    const fdir = join(dir, 'features', 'F1-feat');
    // The first change was merged; the second is open across two repos.
    writeFileSync(
      join(fdir, 'change.md'),
      readFileSync(join(fdir, 'change.md'), 'utf8')
        .replace('status: open', 'status: merged')
        .replace('    pr:\n    url:\n    merged:\n', '    pr: 7\n    url: https://x/pull/7\n    merged: abc1234\n'),
    );
    writeFileSync(
      join(fdir, 'change-2.md'),
      '---\nchange_of: F-1\nstatus: open\nreview_round: 1\nreview_status: pending\nrepos:\n  - repo: demo-repo\n    branch: f1-feat\n    pr: 9\n    url: https://x/pull/9\n    merged:\n  - repo: tools\n    branch: f1-feat\n    pr:\n    url:\n    merged:\n---\n\n## Review Log\n\n### Session 2026-10-18 (PR #9)\n\n**Must fix**\n\n- [ ] open\n',
    );
    const r = runBl(['status', 'F-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /branch: f1-feat {3}pr: #9 {3}points: 0\nreview: round 1\/2 done: 1 open item \(1 Must fix\), latest session 2026-10-18\n/,
      'the open change is current',
    );
    assert.match(
      r.stdout,
      /\nchange change\.md \(merged\):\n {2}demo-repo: branch f1-feat {3}pr: #7 https:\/\/x\/pull\/7 {3}merged: abc1234\n/,
    );
    assert.match(
      r.stdout,
      /\nchange change-2\.md \(open, current\):\n {2}demo-repo: branch f1-feat {3}pr: #9 https:\/\/x\/pull\/9 {3}merged: no\n {2}tools: branch f1-feat {3}pr: - {3}merged: no\n/,
    );
  } finally {
    cleanup();
  }
});

test('bl status words the review line by outcome, and shows any other review_status with its field name', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', branch: 'f1-feat' }],
  });
  try {
    const change = join(dir, 'features', 'F1-feat', 'change.md');
    const base = readFileSync(change, 'utf8');
    const log = '### Session 2026-11-09 (PR #9)\n\n**Must fix**\n\n- [x] done\n\n**Nits**\n\n- [ ] tidy\n';
    const statusWith = (status, round, reviewLog = log) => {
      writeFileSync(
        change,
        base
          .replace(/review_round:.*\n/, `review_round: ${round}\n`)
          .replace(/review_status:.*\n/, `review_status: ${status}\n`)
          .replace('No reviews yet.', reviewLog),
      );
      const r = runBl(['status', 'F-1'], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.match(/^review: .*$/m)[0];
    };
    assert.equal(statusWith('fixed', 1), 'review: round 1/2, review_status: fixed, latest session 2026-11-09');
    assert.equal(
      statusWith('addressed', 2),
      'review: round 2/2 done: nothing left to fix (1 open nit left), latest session 2026-11-09',
    );
    // An open Must fix box under addressed: never "nothing left to fix".
    assert.equal(
      statusWith('addressed', 1, log.replace('[x] done', '[ ] open')),
      'review: round 1/2 done: review_status: addressed, but the latest Review Log session has 1 open Must fix/Should fix item, latest session 2026-11-09',
    );
    assert.equal(statusWith('', 0, ''), 'review: none (round 0/2)');
    assert.equal(statusWith('', 0), 'review: none (round 0/2), latest session 2026-11-09');
  } finally {
    cleanup();
  }
});

test('bl validate warns escalation-not-none for a refined/approved/running feature, not for an escalated one', () => {
  const esc = 'Resolved 2026-10-04. The operator chose A1.';
  const { dir, cleanup } = mkTempBacklog({
    repos: REPOS,
    components: [HOME],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', feature: 'F-2' },
      { id: 'S-3', component: 'C00', title: 'Three', dirSuffix: 'three', feature: 'F-3' },
    ],
    features: [
      { id: 'F-1', title: 'Refined', dirSuffix: 'refined', status: 'refined', stories: ['S-1'], escalation: esc },
      { id: 'F-2', title: 'Escalated', dirSuffix: 'escalated', status: 'escalated', stories: ['S-2'], escalation: esc },
      { id: 'F-3', title: 'Clean', dirSuffix: 'clean', status: 'approved', stories: ['S-3'] },
    ],
  });
  try {
    const r = runBl(['validate', '--json'], { cwd: dir });
    const hits = JSON.parse(r.stdout).findings.filter((f) => f.code === 'escalation-not-none');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].severity, 'warning');
    assert.equal(hits[0].location, 'features/F1-refined/index.md');
    assert.match(hits[0].message, /feature F-1 is refined/);
    assert.match(
      hits[0].message,
      /record the decision in the Design \(or the Review Log\) and set ## Escalation to "None\."/,
    );
    assert.equal(r.status, 0, 'a warning alone does not fail validate');
  } finally {
    cleanup();
  }
});
