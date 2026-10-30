/**
 * Integration tests for `bl merge`'s one gate set (F-36 D1, D3): a loose
 * story S-1 and a feature F-1 (over S-2) in one real repo, `code`, each on
 * its own branch with a commit. Every gate refuses `bl merge S-1` and
 * `bl merge F-1` with the same message (the id and branch aside) and merges
 * nothing; an open nit passes both; `--no-review` merges a unit never
 * reviewed and records the choice in its change document's `## Merge`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { extractSection } from '../../src/feature.js';
import { mergeGates, unitBranch } from '../../src/merge-gates.js';
import { writeBlockers } from '../../src/blockers.js';

const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function g(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const SESSION = ({ must = 'None.', should = 'None.', nits = 'None.' } = {}) =>
  `### Session 2026-10-20 (PR #4)\n\n**Must fix**\n\n${must}\n\n**Should fix**\n\n${should}\n\n**Nits**\n\n${nits}`;

/** A repo with an origin, and a commit on each named branch (its own file). */
function initRepo(dir, name, branches = []) {
  const origin = join(dir, `${name}-origin.git`);
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(dir, name);
  g(dir, 'init', '-q', '-b', 'main', repo);
  g(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', 'origin', 'main');
  for (const b of branches) {
    g(repo, 'checkout', '-q', '-b', b);
    writeFileSync(join(repo, `${b}.txt`), `${b}\n`);
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', `work on ${b}`);
    g(repo, 'checkout', '-q', 'main');
  }
  return repo;
}

/**
 * The backlog: S-1 (loose) and F-1 (over S-2) with the same run state
 * (`review` is `{ review_status, reviewLog }`), the same `## Escalation` when
 * `escalation` is given, `extraRepos` registered beside `code`, `config`
 * merged into backlog.json, `stories` beside S-1 and S-2, and `edges` in
 * blockers.json.
 */
function fixture({ review = {}, escalation = null, extraRepos = [], config = {}, stories = [], edges = null } = {}) {
  const all = ['code', ...extraRepos];
  const { dir, cleanup } = mkTempBacklog({
    repos: Object.fromEntries(all.map((r) => [r, { path: `./${r}`, deployable: true }])),
    components: all.map((r, i) => ({ id: `C0${i}`, title: r, dirSuffix: r, repo: r, home: true })),
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'Loose',
        dirSuffix: 'loose',
        status: 'in_progress',
        branch: 's1-loose',
        primary_repo: 'code',
        ...review,
        body: escalation ? `## Escalation\n\n${escalation}\n` : '',
      },
      {
        id: 'S-2',
        component: 'C00',
        title: 'In feature',
        dirSuffix: 'in-feature',
        status: 'in_progress',
        feature: 'F-1',
      },
      ...stories,
    ],
    features: [
      {
        id: 'F-1',
        title: 'Feat',
        dirSuffix: 'feat',
        status: 'running',
        stories: ['S-2'],
        branch: 'f1-feat',
        ...review,
        ...(escalation ? { escalation } : {}),
      },
    ],
    config,
  });
  const repos = {};
  // Every repo has both branches, so a stray repo can hold a worktree on them.
  for (const r of all) repos[r] = initRepo(dir, r, ['s1-loose', 'f1-feat']);
  if (edges) writeBlockers(dir, edges);
  writeFileSync(join(dir, '.gitignore'), `${all.map((r) => `${r}/\n${r}-origin.git/\n`).join('')}.bl/\n`);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'backlog');
  return { dir, cleanup, repos };
}

/** stderr with the unit's id and branch made generic. */
function generic(stderr, id, branch) {
  return stderr.split(id).join('<id>').split(branch).join('<branch>');
}

/** Merge S-1 and F-1; both refused, with the same stderr, and nothing merged. */
function refusedAlike(fx, extraArgs = []) {
  const before = g(fx.repos.code, 'rev-parse', 'main');
  const s = runBl(['merge', ...extraArgs, 'S-1'], { cwd: fx.dir, env: ENV });
  const f = runBl(['merge', ...extraArgs, 'F-1'], { cwd: fx.dir, env: ENV });
  assert.equal(s.status, 1, s.stderr);
  assert.equal(f.status, 1, f.stderr);
  assert.equal(generic(s.stderr, 'S-1', 's1-loose'), generic(f.stderr, 'F-1', 'f1-feat'));
  assert.equal(g(fx.repos.code, 'rev-parse', 'main'), before, 'nothing merged');
  const story = parseFrontmatter(readFileSync(join(fx.dir, 'stories', 'S1-loose', 'index.md'), 'utf8')).fm;
  assert.equal(story.status, 'in_progress');
  return generic(s.stderr, 'S-1', 's1-loose');
}

const CASES = [
  {
    name: 'a pending review',
    review: { review_status: 'pending', reviewLog: SESSION({ must: '- [ ] broken' }) },
    want: /^<id> has unresolved review state \(review_status: pending, latest session 2026-10-20, 1 unchecked Must\/Should\)\.\nAddress the review feedback \(bl implement <id>\)/,
  },
  {
    name: 'a fixed review',
    review: { review_status: 'fixed', reviewLog: SESSION({ must: '- [x] broken → fixed' }) },
    want: /^<id> has unresolved review state \(review_status: fixed.*\nRe-review the fixes \(bl review <id>\)/,
  },
  {
    name: 'an open Should',
    review: { review_status: 'addressed', reviewLog: SESSION({ should: '- [ ] shaky' }) },
    want: /1 unchecked Must\/Should/,
  },
  {
    name: 'never reviewed',
    review: { review_status: '' },
    want: /^<id> has never been reviewed — run `bl review <id>` \(or `bl run <id>`\), or pass --no-review to merge without one\.$/m,
  },
  {
    name: 'an open escalation',
    review: { review_status: 'addressed', reviewLog: SESSION() },
    escalation: 'Which way?',
    want: /^<id> has an open Escalation section — resolve it and set it back to "None\." before merging:\nWhich way\?/,
  },
];

for (const c of CASES) {
  test(`bl merge S-n and F-n refuse ${c.name} with the same message`, () => {
    const fx = fixture(c);
    try {
      assert.match(refusedAlike(fx), c.want);
    } finally {
      fx.cleanup();
    }
  });
}

test('bl merge S-n and F-n refuse a worktree on the branch in a repo they do not own, alike', () => {
  const fx = fixture({ review: { review_status: 'addressed', reviewLog: SESSION() }, extraRepos: ['stray'] });
  try {
    g(fx.repos.stray, 'worktree', 'add', '-q', join(fx.dir, 'wt-s'), 's1-loose');
    g(fx.repos.stray, 'worktree', 'add', '-q', join(fx.dir, 'wt-f'), 'f1-feat');
    assert.match(
      refusedAlike(fx),
      /^<id> has a worktree on <branch> in stray, but its repo is code\. Work in another repo is another story/m,
    );
  } finally {
    fx.cleanup();
  }
});

test('bl merge S-n and F-n refuse a main checkout off main, alike', () => {
  const fx = fixture({ review: { review_status: 'addressed', reviewLog: SESSION() } });
  try {
    g(fx.repos.code, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(fx.repos.code, 'side.txt'), 'side\n');
    g(fx.repos.code, 'add', '.');
    g(fx.repos.code, 'commit', '-q', '-m', 'side work');
    const before = g(fx.repos.code, 'rev-parse', 'main');
    const err = refusedAlike(fx);
    assert.match(err, /code: main checkout \(.*\) is not on main\./);
    assert.match(err, /^<id>: the main checkout of code is not on main \(above\)\.$/m);
    assert.equal(g(fx.repos.code, 'rev-parse', 'main'), before);
  } finally {
    fx.cleanup();
  }
});

test('an open nit alone merges a story and a feature', () => {
  const fx = fixture({ review: { review_status: 'addressed', reviewLog: SESSION({ nits: '- [ ] rename x' }) } });
  try {
    for (const id of ['S-1', 'F-1']) {
      const r = runBl(['merge', id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 0, `${id}: ${r.stderr}`);
    }
    const story = parseFrontmatter(readFileSync(join(fx.dir, 'stories', 'S1-loose', 'index.md'), 'utf8')).fm;
    assert.equal(story.status, 'done');
    const feature = parseFrontmatter(readFileSync(join(fx.dir, 'features', 'F1-feat', 'index.md'), 'utf8')).fm;
    assert.equal(feature.status, 'done');
  } finally {
    fx.cleanup();
  }
});

/** A forge whose change.find lists `prs` for every branch. */
function forge(prs) {
  const shim = mkTempDir('bl-merge-gates-forge-');
  mkdirSync(shim, { recursive: true });
  const find = join(shim, 'find.mjs');
  writeFileSync(find, `process.stdout.write(${JSON.stringify(JSON.stringify(prs))});\n`);
  return { forge: 'github', plugins: { github: { 'change.find': `node ${find} {{branch}}` } } };
}

test('a PR merged on the forge before review is named in the refusal, for both kinds', () => {
  const prs = [{ number: 12, url: 'https://forge/pr/12', state: 'MERGED', headRefOid: 'deadbeef' }];
  const fx = fixture({ review: { review_status: '' }, config: forge(prs) });
  try {
    const err = refusedAlike(fx);
    assert.match(err, /^<id> has never been reviewed/m);
    assert.match(err, /^code: PR #12 \(https:\/\/forge\/pr\/12\) merged on the forge at deadbeef before any review$/m);
  } finally {
    fx.cleanup();
  }
});

test('--no-review merges a never-reviewed story and feature and records the choice in ## Merge', () => {
  const prs = [{ number: 12, url: 'https://forge/pr/12', state: 'MERGED', headRefOid: 'deadbeef' }];
  const fx = fixture({ review: { review_status: '' }, config: forge(prs) });
  const today = new Date().toISOString().slice(0, 10);
  try {
    for (const [id, changePath] of [
      ['S-1', join(fx.dir, 'stories', 'S1-loose', 'change.md')],
      ['F-1', join(fx.dir, 'features', 'F1-feat', 'change.md')],
    ]) {
      const r = runBl(['merge', '--no-review', id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 0, `${id}: ${r.stderr}`);
      const merge = extractSection(readFileSync(changePath, 'utf8'), 'Merge');
      assert.match(merge, new RegExp(`^- Merged without review \\(operator, ${today}\\)$`, 'm'), id);
      assert.match(merge, /^- code: PR #12 merged on the forge at deadbeef before any review$/m, id);
    }
  } finally {
    fx.cleanup();
  }
});

// `mergeGates` called directly on real repos: its stray-worktree check reads
// each registered repo's `git worktree list`. No forge, a passing preflight.

const UNITS = {
  story: {
    kind: 'story',
    id: 'S-7',
    storyEntry: 'S7-thing',
    reviewStatus: 'addressed',
    changeBody: `## Review Log\n\n${SESSION()}\n`,
    body: '',
  },
  feature: {
    kind: 'feature',
    id: 'F-7',
    featureEntry: 'F7-thing',
    branch: 'f7-thing',
    reviewStatus: 'addressed',
    changeBody: `## Review Log\n\n${SESSION()}\n`,
    body: '',
  },
};

function directGates(unit, config, repos = ['code']) {
  const find = () => ({ ok: false, configured: false, reason: 'no-forge' });
  const res = mergeGates(unit, {
    config,
    args: {},
    repos,
    find,
    preflight: () => ({ ok: true, findings: [] }),
    held: () => [],
  });
  return res.findings.map((f) => ({
    gate: f.gate,
    message: f.message.split(unit.id).join('<id>').split(unitBranch(unit)).join('<branch>'),
  }));
}

/** A repo with one empty commit on main, for worktrees. */
function bareRepo(dir, name) {
  const p = join(dir, name);
  mkdirSync(p);
  g(p, 'init', '-q', '-b', 'main');
  g(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  return p;
}

test("a worktree on the unit's branch in a repo it does not own is refused, naming the repo", () => {
  const dir = mkTempDir('bl-merge-gates-');
  const config = { reposByName: { code: bareRepo(dir, 'code'), stray: bareRepo(dir, 'stray') } };
  g(config.reposByName.stray, 'worktree', 'add', '-q', '-b', 's7-thing', join(dir, 'wt-s'));
  g(config.reposByName.stray, 'worktree', 'add', '-q', '-b', 'f7-thing', join(dir, 'wt-f'));
  const s = directGates(UNITS.story, config);
  assert.deepEqual(s, directGates(UNITS.feature, config), 'both kinds get the same finding');
  assert.deepEqual(s, [
    {
      gate: 'stray-worktree',
      message:
        '<id> has a worktree on <branch> in stray, but its repo is code. Work in another repo is another story: merge or remove that worktree by hand, then rerun.',
    },
  ]);
  // A worktree in the unit's own repo is not a stray.
  g(config.reposByName.code, 'worktree', 'add', '-q', join(dir, 'wt-own'), '-b', 'x');
  assert.deepEqual(directGates(UNITS.story, config, ['code', 'stray']), []);
});

test("a second repo name on the unit's own repo path is not a stray", () => {
  const dir = mkTempDir('bl-merge-gates-');
  const p = bareRepo(dir, 'code');
  g(p, 'worktree', 'add', '-q', '-b', 's7-thing', join(dir, 'wt-s'));
  g(p, 'worktree', 'add', '-q', '-b', 'f7-thing', join(dir, 'wt-f'));
  // `alias` comes before `code`, so the alias is met first.
  const config = { reposByName: { alias: p, code: p } };
  assert.deepEqual(directGates(UNITS.story, config), []);
  assert.deepEqual(directGates(UNITS.feature, config), []);
});

test("a merge edge on S-1 and on F-1's story refuses both before any repo is touched, then lets both merge once the blocker is superseded", () => {
  const fx = fixture({
    review: { review_status: 'addressed', reviewLog: SESSION() },
    stories: [{ id: 'S-3', component: 'C00', title: 'Blocker', dirSuffix: 'blocker', status: 'in_progress' }],
    edges: [
      { blocker: 'S-3', gate: 'merge', unit: 'S-1', until: 'done' },
      { blocker: 'S-3', gate: 'merge', unit: 'S-2', until: 'done' },
    ],
  });
  try {
    const before = g(fx.repos.code, 'rev-parse', 'main');
    const s = runBl(['merge', 'S-1'], { cwd: fx.dir, env: ENV });
    assert.equal(s.status, 1, s.stderr);
    assert.match(
      s.stderr,
      /^S-1 is held at merge by S-3 \(in_progress, needs done\): S-1 merges once S-3 meets "done" \(bl status S-3\)\.$/m,
    );
    const f = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(f.status, 1, f.stderr);
    assert.match(
      f.stderr,
      /^S-2 is held at merge by S-3 \(in_progress, needs done\): F-1 merges once S-3 meets "done" \(bl status S-3\)\.$/m,
    );
    assert.equal(g(fx.repos.code, 'rev-parse', 'main'), before, 'nothing merged');

    // bl status names the hold, on the story and on the feature through its story.
    assert.match(
      runBl(['status', 'S-1'], { cwd: fx.dir, env: ENV }).stdout,
      /^held: S-1 is held at merge by S-3 \(in_progress, needs done\)$/m,
    );
    assert.match(
      runBl(['status', 'F-1'], { cwd: fx.dir, env: ENV }).stdout,
      /^held: S-2 is held at merge by S-3 \(in_progress, needs done\)$/m,
    );

    const blockerPath = join(fx.dir, 'stories', 'S3-blocker', 'index.md');
    writeFileSync(blockerPath, readFileSync(blockerPath, 'utf8').replace('status: in_progress', 'status: superseded'));
    g(fx.dir, 'commit', '-q', '-am', 'supersede S-3');
    for (const id of ['S-1', 'F-1']) {
      const r = runBl(['merge', id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 0, `${id}: ${r.stderr}`);
    }
    assert.doesNotMatch(runBl(['status', 'S-1'], { cwd: fx.dir, env: ENV }).stdout, /^held:/m);
  } finally {
    fx.cleanup();
  }
});

test('a merge task (bl task --gate merge) holds bl merge of its story and its feature until bl task done, then both merge and the table shows it done', () => {
  const fx = fixture({ review: { review_status: 'addressed', reviewLog: SESSION() } });
  try {
    for (const [unit, id] of [
      ['S-1', 'T-1'],
      ['F-1', 'T-2'],
    ]) {
      const r = runBl(['task', unit, '--gate', 'merge', '--title', `Migrate ${unit}`], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${id}\n`);
    }
    const before = g(fx.repos.code, 'rev-parse', 'main');
    const s = runBl(['merge', 'S-1'], { cwd: fx.dir, env: ENV });
    assert.equal(s.status, 1, s.stderr);
    assert.match(
      s.stderr,
      /^S-1 is held at merge by T-1 \(open, needs done\): S-1 merges once T-1 meets "done" \(bl status T-1\)\.$/m,
    );
    const f = runBl(['merge', 'F-1'], { cwd: fx.dir, env: ENV });
    assert.equal(f.status, 1, f.stderr);
    assert.match(f.stderr, /^F-1 is held at merge by T-2 \(open, needs done\)/m);
    assert.equal(g(fx.repos.code, 'rev-parse', 'main'), before, 'nothing merged');
    const inbox = runBl(['inbox'], { cwd: fx.dir, env: ENV }).stdout;
    assert.match(inbox, /^  T-2 +F-1 +Migrate F-1\n +holds: bl merge F-1\n +next: bl task done T-2 \[note\]$/m);
    assert.match(inbox, /^  T-1 +S-1 +Migrate S-1\n +holds: bl merge S-1\n/m);

    for (const id of ['T-1', 'T-2']) {
      const r = runBl(['task', 'done', id, 'migrated'], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.doesNotMatch(runBl(['inbox'], { cwd: fx.dir, env: ENV }).stdout, /T-[12]/);
    for (const id of ['S-1', 'F-1']) {
      const r = runBl(['merge', id], { cwd: fx.dir, env: ENV });
      assert.equal(r.status, 0, `${id}: ${r.stderr}`);
    }
    const today = new Date().toISOString().slice(0, 10);
    const feature = readFileSync(join(fx.dir, 'features', 'F1-feat', 'index.md'), 'utf8');
    assert.match(
      feature,
      new RegExp(`\\| \\[T-2\\]\\([^)]*\\) \\| Migrate F-1 \\| bl merge F-1 \\| done +\\| ${today} \\|`),
    );
    assert.match(runBl(['status', 'F-1'], { cwd: fx.dir, env: ENV }).stdout, /^tasks: 0 open, 1 done$/m);
  } finally {
    fx.cleanup();
  }
});
