import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  appendSection,
  changeName,
  changePath,
  currentChange,
  ensureChange,
  listChanges,
  newChange,
  parseChange,
  readChange,
  recordMerge,
  serializeChange,
  setRepo,
  unitChange,
  unitIdOfDir,
  writeChange,
} from '../../src/change-doc.js';
import { extractSection, featureRepoOrder } from '../../src/feature.js';
import { deployableRepos, mainCommits, tagRepos } from '../../src/release.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));

/** A backlog root with one unit directory under it. */
function unitDir(name = 'F42-hub') {
  const root = mkTempDir('bl-change-');
  const dir = join(root, 'features', name);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

test('a new change document: change_of, status open, round 0, one entry per repo, the four sections in order', () => {
  const { root, dir } = unitDir();
  const res = ensureChange(root, dir, {
    changeOf: 'F-42',
    title: 'Hub',
    repos: [
      { repo: 'bl', branch: 'f42-hub' },
      { repo: 'tools', branch: 'f42-hub' },
      { repo: 'bl', branch: 'x' },
    ],
  });
  assert.equal(res.path, join(dir, 'change.md'));
  assert.equal(res.created, true);
  const text = readFileSync(res.path, 'utf8');
  assert.equal(
    text,
    [
      '---',
      'change_of: F-42',
      'status: open',
      'review_round: 0',
      'review_status:',
      'repos:',
      '  - repo: bl',
      '    branch: f42-hub',
      '    pr:',
      '    url:',
      '    merged:',
      '  - repo: tools',
      '    branch: f42-hub',
      '    pr:',
      '    url:',
      '    merged:',
      '---',
      '',
      '# F-42 · Hub',
      '',
      '## Description',
      '',
      '## Gate',
      '',
      '## Review Log',
      '',
      '## Merge',
      '',
    ].join('\n'),
  );
  const doc = readChange(res.path);
  assert.deepEqual(doc.fm, { change_of: 'F-42', status: 'open', review_round: '0', review_status: '' });
  assert.deepEqual(
    doc.repos.map((r) => r.repo),
    ['bl', 'tools'],
    'a repo named twice gets one entry',
  );
});

test('ensureChange reuses the open document, adds missing repos, fills an empty branch, and writes only on a change', () => {
  const { root, dir } = unitDir();
  const first = ensureChange(root, dir, { changeOf: 'F-42', repos: [{ repo: 'bl', branch: '' }] });
  const again = ensureChange(root, dir, { changeOf: 'F-42', repos: [{ repo: 'bl', branch: '' }] });
  assert.equal(again.changed, false);
  assert.equal(again.path, first.path);
  const more = ensureChange(root, dir, {
    changeOf: 'F-42',
    repos: [
      { repo: 'bl', branch: 'f42-hub' },
      { repo: 'ci-cd', branch: 'f42-hub' },
    ],
  });
  assert.equal(more.created, false);
  assert.equal(more.changed, true);
  assert.deepEqual(
    readChange(first.path).repos.map((r) => [r.repo, r.branch]),
    [
      ['bl', 'f42-hub'],
      ['ci-cd', 'f42-hub'],
    ],
  );
  // A branch already recorded is kept.
  ensureChange(root, dir, { changeOf: 'F-42', repos: [{ repo: 'bl', branch: 'other' }] });
  assert.equal(readChange(first.path).repos[0].branch, 'f42-hub');
});

test('a unit whose change is merged gets change-2.md, and bl reads the highest-numbered open one', () => {
  const { root, dir } = unitDir();
  ensureChange(root, dir, { changeOf: 'F-42', repos: [{ repo: 'bl', branch: 'f42-hub' }] });
  recordMerge(root, dir, { commits: { bl: 'abc1234' }, date: '2026-10-18' });
  const second = ensureChange(root, dir, { changeOf: 'F-42', repos: [{ repo: 'bl', branch: 'f42-hub' }] });
  assert.equal(second.path, join(dir, 'change-2.md'));
  assert.equal(second.created, true);
  assert.deepEqual(
    listChanges(dir).map((c) => c.n),
    [1, 2],
  );
  assert.equal(currentChange(dir).path, second.path);
  // A third, closed, does not displace the open second; with none open the highest wins.
  writeFileSync(changePath(dir, 3), '---\nchange_of: F-42\nstatus: closed\nrepos:\n---\n');
  assert.equal(currentChange(dir).n, 2);
  writeFileSync(second.path, readFileSync(second.path, 'utf8').replace('status: open', 'status: merged'));
  assert.equal(currentChange(dir).n, 3);
  // Names that are not change documents are ignored.
  writeFileSync(join(dir, 'change-1.md'), 'x');
  writeFileSync(join(dir, 'change-x.md'), 'x');
  assert.deepEqual(
    listChanges(dir).map((c) => c.n),
    [1, 2, 3],
  );
  assert.equal(changeName('F-42', 1), 'F-42');
  assert.equal(changeName('F-42', 2), 'F-42.2');
});

test("unitChange reads the primary repo's branch and PR, the review state and the body; empty without a document", () => {
  const { root, dir } = unitDir();
  assert.deepEqual(unitChange(dir, 'bl'), {
    changePath: null,
    changeNum: 0,
    change: null,
    branch: '',
    pr: '',
    prUrl: '',
    reviewStatus: '',
    reviewRoundRaw: '',
    changeBody: '',
  });
  const { path } = ensureChange(root, dir, {
    changeOf: 'F-42',
    repos: [
      { repo: 'tools', branch: 'f42-hub' },
      { repo: 'bl', branch: 'f42-hub' },
    ],
  });
  const doc = readChange(path);
  setRepo(doc, 'bl', { pr: 12, url: 'https://x/pull/12' });
  doc.fm.review_status = 'pending';
  doc.fm.review_round = '1';
  writeChange(root, path, doc);
  const u = unitChange(dir, 'bl');
  assert.equal(u.branch, 'f42-hub');
  assert.equal(u.pr, '12');
  assert.equal(u.prUrl, 'https://x/pull/12');
  assert.equal(u.reviewStatus, 'pending');
  assert.equal(u.reviewRoundRaw, '1');
  assert.match(u.changeBody, /## Review Log/);
  assert.equal(unitChange(dir, 'nope').branch, 'f42-hub', 'an unknown primary falls back to the first entry');
});

test('appendSection: Gate and Merge lines go last, a Review Log session goes first, a Description paragraph last', () => {
  let body = newChange({ changeOf: 'S-1', title: 'T' }).body;
  body = appendSection(body, 'Gate', '- g1');
  body = appendSection(body, 'Gate', '- g2\n');
  body = appendSection(body, 'Merge', '- m1');
  body = appendSection(body, 'Merge', '- m2');
  body = appendSection(body, 'Review Log', '### Session 2026-10-01 (PR #1)\n\n**Must fix**\nNone.');
  body = appendSection(body, 'Review Log', '### Session 2026-10-02 (PR #1)\n\n**Must fix**\nNone.');
  body = appendSection(body, 'Description', 'Story S-1: T (3 pts)');
  body = appendSection(body, 'Description', 'More.');
  assert.equal(extractSection(body, 'Gate'), '\n- g1\n- g2\n\n');
  assert.equal(extractSection(body, 'Merge'), '\n- m1\n- m2\n');
  assert.match(extractSection(body, 'Review Log'), /^\n### Session 2026-10-02[\s\S]*\n\n### Session 2026-10-01/);
  assert.equal(extractSection(body, 'Description'), '\nStory S-1: T (3 pts)\n\nMore.\n\n');
  assert.deepEqual(
    [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    ['Description', 'Gate', 'Review Log', 'Merge'],
  );
});

test('appendSection creates a missing section in its place among the four, or at the end', () => {
  assert.equal(
    appendSection('# X\n\n## Review Log\n\nold\n', 'Gate', '- g'),
    '# X\n\n## Gate\n\n- g\n\n## Review Log\n\nold\n',
  );
  assert.equal(appendSection('# X\n\n## Gate\n\n- g\n', 'Merge', '- m'), '# X\n\n## Gate\n\n- g\n\n## Merge\n\n- m\n');
  assert.equal(appendSection('', 'Description', 'D'), '## Description\n\nD\n');
});

test('a CRLF change document reads like an LF one and is written back as CRLF', () => {
  const { root, dir } = unitDir();
  const lf =
    '---\nchange_of: F-42\nstatus: open\nreview_round: 2\nreview_status: fixed\nrepos:\n  - repo: bl\n    branch: f42-hub\n    pr: 9\n    url:\n    merged:\n---\n\n# F-42\n\n## Gate\n\n- g1\n\n## Review Log\n\n### Session 2026-10-01 (PR #9)\n';
  const path = join(dir, 'change.md');
  writeFileSync(path, lf.replace(/\n/g, '\r\n'));
  const doc = readChange(path);
  assert.equal(doc.eol, '\r\n');
  assert.deepEqual(doc.fm, parseChange(lf).fm);
  assert.deepEqual(doc.repos, [{ repo: 'bl', branch: 'f42-hub', pr: '9', url: '', merged: '' }]);
  assert.equal(unitChange(dir, 'bl').reviewStatus, 'fixed');
  doc.body = appendSection(doc.body, 'Gate', '- g2');
  writeChange(root, path, doc);
  const raw = readFileSync(path, 'utf8');
  assert.ok(!/[^\r]\n/.test(raw), 'every line ends CRLF');
  assert.match(raw, /- g1\r\n- g2\r\n/);
});

test('parse and serialize round-trip several repos, quoted values and unknown keys', () => {
  const text =
    '---\nchange_of: S-7\nstatus: open\nreview_round: 0\nreview_status:\nrepos:\n  - repo: a\n    branch: \'s7-x\'\n    pr: 1\n    url: "https://x/1"\n    merged:\n    note: kept\n  -\n    repo: b\n    branch: s7-x\n---\nbody\n';
  const doc = parseChange(text);
  assert.deepEqual(doc.repos, [
    { repo: 'a', branch: 's7-x', pr: '1', url: 'https://x/1', merged: '', note: 'kept' },
    { repo: 'b', branch: 's7-x' },
  ]);
  const again = parseChange(serializeChange(doc));
  assert.deepEqual(again.repos, [
    { repo: 'a', branch: 's7-x', pr: '1', url: 'https://x/1', merged: '', note: 'kept' },
    { repo: 'b', branch: 's7-x', pr: '', url: '', merged: '' },
  ]);
  assert.equal(again.body, 'body\n');
  assert.deepEqual(parseChange('no frontmatter\n').repos, []);
});

test("recordMerge sets each repo's merged commit, appends ## Merge and marks the change merged", () => {
  const { root, dir } = unitDir('S890-x');
  assert.equal(
    recordMerge(root, dir, { commits: { bl: 'a' }, date: '2026-10-18' }),
    null,
    'no document, nothing written',
  );
  ensureChange(root, dir, {
    changeOf: 'S-890',
    repos: [
      { repo: 'bl', branch: 's890-x' },
      { repo: 'tools', branch: 's890-x' },
    ],
  });
  recordMerge(root, dir, { commits: { bl: 'abc1234', tools: 'def5678' }, date: '2026-10-18', extra: ['- Tag: `F-1`'] });
  const doc = readChange(changePath(dir));
  assert.equal(doc.fm.status, 'merged');
  assert.deepEqual(
    doc.repos.map((r) => [r.repo, r.merged]),
    [
      ['bl', 'abc1234'],
      ['tools', 'def5678'],
    ],
  );
  assert.equal(
    extractSection(doc.body, 'Merge'),
    '\n- 2026-10-18 · bl · merged abc1234\n- 2026-10-18 · tools · merged def5678\n- Tag: `F-1`\n',
  );
});

test('unitIdOfDir names the unit a directory holds', () => {
  assert.equal(unitIdOfDir('/b/features/F42-hub'), 'F-42');
  assert.equal(unitIdOfDir('/b/projects/p/E1-x/S890-the-change'), 'S-890');
  assert.equal(unitIdOfDir('/b/features/.completed/F7'), 'F-7');
  assert.equal(unitIdOfDir('/b/projects/p/E1-x'), null);
});

test('the change template, and the unit templates no longer carry run state', () => {
  const change = readFileSync(join(TEMPLATES, 'change.md'), 'utf8');
  const doc = parseChange(change);
  assert.deepEqual(Object.keys(doc.fm), ['change_of', 'status', 'review_round', 'review_status']);
  assert.deepEqual(
    [...doc.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    ['Description', 'Gate', 'Review Log', 'Merge'],
  );
  for (const name of ['feature', 'story', 'story-feature']) {
    const text = readFileSync(join(TEMPLATES, `${name}.md`), 'utf8');
    assert.doesNotMatch(text, /^(branch|pr|review_round|review_status):/m, name);
    assert.doesNotMatch(text, /^## Review Log/m, name);
  }
  const r = runBl(['new', '--print-template', 'change'], { cwd: mkTempDir('bl-tpl-') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, change);
});

test('deployableRepos: the repos entries with deployable: true, in repos order (F-51 D4)', () => {
  const entry = (name, deployable) => ({
    name,
    path: `/r/${name}`,
    deployable,
    updateTests: [],
    plugins: {},
    overrides: null,
  });
  const repos = { tools: entry('tools', true), bl: entry('bl', false), app: entry('app', true) };
  assert.deepEqual(deployableRepos({ repos }), ['tools', 'app']);
  assert.deepEqual(deployableRepos({ repos: { bl: entry('bl', false) } }), []);
  assert.deepEqual(deployableRepos({ repos: {} }), []);
});

test('tagRepos tags every repo before pushing any, keeps a tag on the same commit, and refuses one elsewhere', () => {
  const root = mkTempDir('bl-tag-');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repos = ['a', 'b'].map((name) => {
    const origin = join(root, `${name}.git`);
    const repoPath = join(root, name);
    g(root, 'init', '-q', '--bare', '-b', 'main', origin);
    g(root, 'init', '-q', '-b', 'main', repoPath);
    g(repoPath, 'remote', 'add', 'origin', origin);
    writeFileSync(join(repoPath, 'f'), name);
    g(repoPath, 'add', '.');
    g(repoPath, 'commit', '-q', '-m', 'one');
    return { repoName: name, repoPath, origin, commit: g(repoPath, 'rev-parse', '--short', 'HEAD') };
  });
  const calls = [];
  const run = (cwd, args) => {
    calls.push(args[0]);
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const res = tagRepos(repos, 'F-9', 'F-9: Title\n\nChange: features/F9-x/change.md', run);
  assert.deepEqual(res, { ok: true, tagged: ['a', 'b'] });
  assert.ok(calls.lastIndexOf('tag') < calls.indexOf('push'), 'every tag is made before the first push');
  for (const r of repos) {
    assert.equal(g(r.origin, 'rev-parse', 'F-9^{commit}'), g(r.repoPath, 'rev-parse', 'HEAD'));
    assert.equal(g(r.repoPath, 'cat-file', '-t', 'F-9'), 'tag');
    assert.equal(
      g(r.repoPath, 'tag', '-l', '--format=%(contents)', 'F-9'),
      'F-9: Title\n\nChange: features/F9-x/change.md',
    );
  }
  // A re-run on the same commits keeps the tags.
  assert.deepEqual(tagRepos(repos, 'F-9', 'F-9: Title', run), { ok: true, tagged: [] });
  // A tag that names another commit stops before anything is pushed.
  writeFileSync(join(repos[1].repoPath, 'f'), 'two');
  g(repos[1].repoPath, 'commit', '-qam', 'two');
  const moved = [repos[0], { ...repos[1], commit: g(repos[1].repoPath, 'rev-parse', 'HEAD') }];
  calls.length = 0;
  const bad = tagRepos(moved, 'F-9', 'F-9: Title', run);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^b: tag F-9 already names [0-9a-f]{12}, not [0-9a-f]{40}$/);
  assert.ok(!calls.includes('push'));
  assert.match(tagRepos([{ ...repos[0], commit: 'nope' }], 'F-10', 'm', run).error, /a: nope is not a commit/);
});

test('mainCommits remote failure never records local-only sha', () => {
  const sha = 'a'.repeat(40);
  const config = { reposByName: { a: '/a' } };
  for (const [what, remote, want] of [
    ['a full remote main', { status: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: '' }, null],
    ['a sha256 remote main', { status: 0, stdout: `${'b'.repeat(64)}\trefs/heads/main\n`, stderr: '' }, null],
    [
      'git ls-remote failing',
      { status: 128, stdout: '', stderr: 'injected origin outage' },
      /^a: origin main unreadable \(injected origin outage\)$/,
    ],
    [
      'git not starting',
      { status: 127, stdout: '', stderr: '' },
      /^a: origin main unreadable \(git ls-remote failed\)$/,
    ],
    [
      'no main on the remote',
      { status: 0, stdout: '', stderr: '' },
      /^a: origin has no single main commit \(got ""\)$/,
    ],
    ['a short sha', { status: 0, stdout: 'abcdef123456\trefs/heads/main\n', stderr: '' }, /no single main commit/],
    ['another ref', { status: 0, stdout: `${sha}\trefs/heads/mainline\n`, stderr: '' }, /no single main commit/],
    [
      'two lines',
      { status: 0, stdout: `${sha}\trefs/heads/main\n${sha}\trefs/heads/main\n`, stderr: '' },
      /no single main commit/,
    ],
    ['garbage', { status: 0, stdout: 'fatal: not a sha\n', stderr: '' }, /no single main commit/],
  ]) {
    const calls = [];
    const res = mainCommits(config, ['a'], (_cwd, args) => {
      calls.push(args[0]);
      return args[0] === 'ls-remote' ? remote : { status: 0, stdout: 'local-unpushed-deadbeef\n', stderr: '' };
    });
    assert.deepEqual(calls, ['ls-remote'], `${what}: only the remote is asked`);
    if (want === null) {
      assert.deepEqual(res, { commits: { a: remote.stdout.split('\t')[0] }, errors: [] }, what);
    } else {
      assert.deepEqual(res.commits, {}, what);
      assert.equal(res.errors.length, 1, what);
      assert.match(res.errors[0], want, what);
    }
  }
});

test('tagRepos later push failure leaves no partial remote release', () => {
  const root = mkTempDir('bl-tag-');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repos = ['a', 'b', 'c'].map((name) => {
    const origin = join(root, `${name}.git`);
    const repoPath = join(root, name);
    g(root, 'init', '-q', '--bare', '-b', 'main', origin);
    g(root, 'init', '-q', '-b', 'main', repoPath);
    g(repoPath, 'remote', 'add', 'origin', origin);
    writeFileSync(join(repoPath, 'f'), name);
    g(repoPath, 'add', '.');
    g(repoPath, 'commit', '-q', '-m', 'one');
    return { repoName: name, repoPath, origin, commit: g(repoPath, 'rev-parse', 'HEAD') };
  });
  const run = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const hook = join(repos[1].origin, 'hooks', 'pre-receive');
  const remoteTag = (r, tag) => run(r.origin, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0;
  const localTag = (r, tag) => run(r.repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0;
  // a's remote already has F-8 from an earlier complete publication; F-9 is new everywhere.
  g(repos[0].repoPath, 'tag', '-a', 'F-8', 'HEAD', '-m', 'F-8');
  g(repos[0].repoPath, 'push', '-q', 'origin', 'refs/tags/F-8');
  writeFileSync(hook, '#!/bin/sh\necho injected push failure >&2\nexit 1\n', { mode: 0o755 });
  for (const tag of ['F-8', 'F-9']) {
    const res = tagRepos(repos, tag, `${tag}: Title`, run);
    assert.equal(res.ok, false, tag);
    assert.match(res.error, new RegExp(`^b: git push of tag ${tag} failed: .*injected push failure`));
    assert.doesNotMatch(res.error, /rollback left/);
    for (const r of repos) {
      assert.equal(remoteTag(r, tag), tag === 'F-8' && r.repoName === 'a', `${tag} on ${r.repoName}'s remote`);
      assert.equal(localTag(r, tag), tag === 'F-8' && r.repoName === 'a', `${tag} local in ${r.repoName}`);
    }
  }
  // A failure before any push (c's remote unreachable) leaves no local tag either.
  g(repos[2].repoPath, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
  const early = tagRepos(repos, 'F-9', 'F-9: Title', run);
  assert.match(early.error, /^c: git ls-remote origin failed/);
  for (const r of repos) assert.equal(localTag(r, 'F-9') || remoteTag(r, 'F-9'), false, r.repoName);
  // Once the cause is fixed, the retry publishes the whole set.
  g(repos[2].repoPath, 'remote', 'set-url', 'origin', repos[2].origin);
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.deepEqual(tagRepos(repos, 'F-9', 'F-9: Title', run), { ok: true, tagged: ['a', 'b', 'c'] });
  for (const r of repos) assert.ok(remoteTag(r, 'F-9'), r.repoName);
});

test('tagRepos_rollback_does_not_delete_a_concurrent_publishers_tag', () => {
  const root = mkTempDir('bl-tag-');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repos = ['a', 'b'].map((name) => {
    const origin = join(root, `${name}.git`);
    const repoPath = join(root, name);
    g(root, 'init', '-q', '--bare', '-b', 'main', origin);
    g(root, 'init', '-q', '-b', 'main', repoPath);
    g(repoPath, 'remote', 'add', 'origin', origin);
    writeFileSync(join(repoPath, 'f'), name);
    g(repoPath, 'add', '.');
    g(repoPath, 'commit', '-q', '-m', 'one');
    g(repoPath, 'push', '-q', 'origin', 'main');
    return { repoName: name, repoPath, origin, commit: g(repoPath, 'rev-parse', 'HEAD') };
  });
  // Another caller, in its own clone of a, publishes its own F-9 tag object.
  const other = join(root, 'other');
  g(root, 'clone', '-q', repos[0].origin, other);
  writeFileSync(join(repos[1].origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho injected push failure >&2\nexit 1\n', {
    mode: 0o755,
  });
  // Between this run's push to a and its failing push to b, the other caller
  // replaces a's remote tag (a replacement), or a's remote tag is deleted
  // and the other caller publishes its own (a fresh publication).
  for (const how of ['replaces', 'republishes']) {
    const run = (cwd, args) => {
      if (cwd === repos[1].repoPath && args[0] === 'push' && args.at(-1) === 'refs/tags/F-9') {
        g(other, 'tag', '-f', '-a', 'F-9', 'HEAD', '-m', `the other caller (${how})`);
        if (how === 'republishes') g(repos[0].origin, 'tag', '-d', 'F-9');
        g(other, 'push', '-q', '-f', 'origin', 'refs/tags/F-9');
      }
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const res = tagRepos(repos, 'F-9', 'F-9: Title', run);
    assert.equal(res.ok, false, how);
    assert.match(
      res.error,
      /^b: git push of tag F-9 failed: .*injected push failure.*; rollback left tag F-9 on: a remote \(/s,
      how,
    );
    assert.equal(
      g(repos[0].origin, 'rev-parse', 'F-9'),
      g(other, 'rev-parse', 'F-9'),
      `${how}: the other caller's tag stays`,
    );
    assert.equal(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-9'], { cwd: repos[1].origin }).status,
      1,
      how,
    );
    for (const r of repos)
      assert.equal(
        spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-9'], { cwd: r.repoPath }).status,
        1,
        how,
      );
    g(repos[0].origin, 'tag', '-d', 'F-9');
  }
  // The paired local step: a's local tag, replaced in its own checkout
  // between this run's push to a and its failing push to b, stays.
  const run = (cwd, args) => {
    if (cwd === repos[1].repoPath && args[0] === 'push' && args.at(-1) === 'refs/tags/F-9') {
      g(repos[0].repoPath, 'tag', '-f', '-a', 'F-9', 'HEAD', '-m', "the operator's own");
    }
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const mine = (cwd) => spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/F-9'], { cwd, encoding: 'utf8' });
  const res = tagRepos(repos, 'F-9', 'F-9: Title', run);
  assert.equal(res.ok, false);
  assert.match(res.error, /; rollback left tag F-9 on: a local \(/);
  assert.match(g(repos[0].repoPath, 'cat-file', '-p', 'F-9'), /the operator's own/);
  assert.equal(mine(repos[0].origin).status, 1, "a's remote tag, this run's, is taken back");
  assert.equal(mine(repos[1].repoPath).status, 1);
});

test('feature_lead_is_used_when_existing_change_repos_have_another_order', () => {
  // F-52 D3: whatever order a document recorded, preparing it in the order
  // derived now puts the lead first, so unitChange reads the lead's PR.
  const cases = [
    {
      name: 'new document, bl present',
      recorded: null,
      stories: [
        { id: 'S-1', unitRepo: 'app' },
        { id: 'S-2', unitRepo: 'bl' },
      ],
    },
    {
      name: 'resumed, bl present',
      recorded: ['app', 'bl'],
      stories: [
        { id: 'S-1', unitRepo: 'app' },
        { id: 'S-2', unitRepo: 'bl' },
      ],
    },
    {
      name: 'resumed, bl absent, dependencies reorder',
      recorded: ['app', 'tools'],
      stories: [
        { id: 'S-1', unitRepo: 'app', depends_on: ['S-2'] },
        { id: 'S-2', unitRepo: 'tools' },
      ],
    },
    {
      name: 'story added after opening',
      recorded: ['app'],
      stories: [
        { id: 'S-1', unitRepo: 'app' },
        { id: 'S-2', unitRepo: 'bl' },
      ],
    },
    { name: 'story removed after opening', recorded: ['bl', 'app'], stories: [{ id: 'S-1', unitRepo: 'app' }] },
  ];
  for (const c of cases) {
    const { root, dir } = unitDir();
    if (c.recorded) {
      const first = ensureChange(root, dir, {
        changeOf: 'F-42',
        repos: c.recorded.map((repo) => ({ repo, branch: 'f42-hub' })),
      });
      const doc = readChange(first.path);
      for (const repo of c.recorded) setRepo(doc, repo, { pr: `pr-${repo}` });
      writeChange(root, first.path, doc);
    }
    const names = featureRepoOrder(c.stories);
    const res = ensureChange(root, dir, {
      changeOf: 'F-42',
      repos: names.map((repo) => ({ repo, branch: 'f42-hub' })),
    });
    const lead = names[0];
    assert.deepEqual(
      res.doc.repos.map((r) => r.repo),
      [...names, ...(c.recorded ?? []).filter((r) => !names.includes(r))],
      c.name,
    );
    assert.deepEqual(readChange(res.path).repos.map((r) => r.repo)[0], lead, `${c.name}: written order`);
    assert.equal(unitChange(dir).pr, c.recorded?.includes(lead) ? `pr-${lead}` : '', `${c.name}: lead PR`);
  }
});

test("a change document's repos: is its frontmatter's sequence of mappings, written by serializeFrontmatter (F-62 D2)", () => {
  const text = [
    '---',
    'change_of: F-42',
    'status: open',
    'review_round: 0',
    'review_status:',
    'repos:',
    '  # the lead repo first',
    '  - repo: bl',
    '    branch: "f42: hub"',
    '    pr: 9',
    '',
    '  - repo: tools',
    '    merged: 3300025',
    '---',
    'body',
    '',
  ].join('\n');
  const doc = parseChange(text);
  assert.deepEqual(
    doc.repos,
    [
      { repo: 'bl', branch: 'f42: hub', pr: '9' },
      { repo: 'tools', merged: '3300025' },
    ],
    'a comment and a blank line do not end the list',
  );
  assert.throws(
    () => parseChange(text.replace('  - repo: tools', '  - plain string member\n  - repo: tools')),
    /"repos:" holds "plain string member", not a mapping/,
    'a member that is not a mapping is refused, not dropped',
  );
  assert.throws(() => parseChange('---\nrepos: bl\n---\n'), /"repos:" is "bl", not a list/);
  assert.equal(doc.fm.repos, undefined);
  const out = serializeChange(doc);
  assert.equal(
    out,
    '---\nchange_of: F-42\nstatus: open\nreview_round: 0\nreview_status:\nrepos:\n  - repo: bl\n    branch: "f42: hub"\n    pr: 9\n    url:\n    merged:\n  - repo: tools\n    branch:\n    pr:\n    url:\n    merged: 3300025\n---\nbody\n',
  );
  assert.deepEqual(parseChange(out).repos[1], { repo: 'tools', branch: '', pr: '', url: '', merged: '3300025' });
  assert.deepEqual(serializeChange({ fm: { change_of: 'F-1' }, repos: [] }), '---\nchange_of: F-1\nrepos: []\n---\n');
});

test('readChange names the file of a change document that is not YAML', () => {
  const dir = mkTempDir('bl-change-bad-');
  const path = changePath(dir);
  writeFileSync(path, '---\nchange_of: F-1\nrepos:\n  - repo: bl\n   branch: x\n---\n');
  assert.throws(
    () => readChange(path),
    (e) => e.name === 'FrontmatterError' && e.file === path && e.line === 5,
  );
});
