import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  FrontmatterError,
  FrontmatterListError,
  loadConfig,
  parseFrontmatter,
  serializeFrontmatter,
} from '../../src/config.js';
import {
  findComponentDir,
  findMaxStoryNum,
  findNextComponentNum,
  findStoryDir,
  findUnitPRs,
  normalizeComponentId,
  parsePathList,
  pathEntryProblem,
  pathMatches,
  parseIdList,
  readAllStories,
  readComponents,
  removeUnitDirIfEmpty,
  reposForStory,
} from '../../src/story.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';

test('removeUnitDirIfEmpty removes a unit directory holding nothing but its lock, and nothing else (F-60 D2)', () => {
  const root = mkTempDir('bl-unit-dir-');
  const unit = (name, entries = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [entry, kind] of Object.entries(entries)) {
      if (kind === 'dir') mkdirSync(join(dir, entry), { recursive: true });
      else writeFileSync(join(dir, entry), kind);
    }
    return dir;
  };
  const empty = unit('f1-empty');
  assert.equal(removeUnitDirIfEmpty(empty), true);
  assert.equal(existsSync(empty), false);
  const locked = unit('f2-locked', { '.workon.lock': '999999999\n' });
  assert.equal(removeUnitDirIfEmpty(locked), true);
  assert.equal(existsSync(locked), false, 'the lock goes with it');
  const held = unit('f3-held', { '.workon.lock': '1\n', bl: 'dir' });
  assert.equal(removeUnitDirIfEmpty(held), false);
  assert.ok(
    existsSync(join(held, 'bl')) && existsSync(join(held, '.workon.lock')),
    'a unit directory with a worktree is left as it is',
  );
  const stray = unit('f4-stray', { 'notes.txt': 'x' });
  assert.equal(removeUnitDirIfEmpty(stray), false);
  assert.ok(existsSync(join(stray, 'notes.txt')));
  assert.equal(removeUnitDirIfEmpty(join(root, 'f5-missing')), false);
  const live = unit('f6-live', { '.workon.lock': `${process.ppid}\n` });
  assert.equal(removeUnitDirIfEmpty(live), false);
  assert.ok(existsSync(join(live, '.workon.lock')), "another live process's session lock is never removed");
  const mine = unit('f7-mine', { '.workon.lock': `${process.pid}\n` });
  assert.equal(removeUnitDirIfEmpty(mine), true, 'a lock this process holds goes with its directory');
});

test('parseIdList refuses a plain object (no phantom object/Object)', () => {
  assert.throws(() => parseIdList({}), FrontmatterListError);
  assert.throws(() => parseIdList({ bl: 'abc' }), FrontmatterListError);
});

test('parseIdList returns [] for null / undefined and refuses a number', () => {
  assert.deepEqual(parseIdList(null), []);
  assert.deepEqual(parseIdList(undefined), []);
  assert.throws(() => parseIdList(0), FrontmatterListError);
  assert.throws(() => parseIdList(123), FrontmatterListError);
});

test('parseIdList parses an array value (block-sequence path)', () => {
  assert.deepEqual(parseIdList(['S-1', 's2']), ['S-1', 'S-2']);
});

test('parseIdList takes a sequence of strings only: a string is not a list, whatever it looks like (F-62 D2)', () => {
  assert.throws(() => parseIdList('S-1, S-2'), FrontmatterListError);
  assert.throws(() => parseIdList('[S-1, S-2]'), FrontmatterListError);
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList([' S-1 ', '', 's2']), ['S-1', 'S-2']);
  assert.throws(() => parseIdList([' S-1 ', { x: 'y' }, 's2']), /holds \{"x":"y"\}, not a string/);
});

test('findMaxStoryNum returns 0 on an empty backlog', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.equal(findMaxStoryNum(cfg), 0);
  } finally {
    cleanup();
  }
});

test('findMaxStoryNum picks up the highest seeded story', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.equal(findMaxStoryNum(cfg), 4);
  } finally {
    cleanup();
  }
});

test('findNextComponentNum returns 0 when no components exist', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.equal(findNextComponentNum(cfg), 0n);
  } finally {
    cleanup();
  }
});

test('findNextComponentNum returns max+1 over components/', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    assert.equal(findNextComponentNum(cfg), 2n);
  } finally {
    cleanup();
  }
});

test('readAllStories reads frontmatter from every seeded story', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const stories = readAllStories(cfg).sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(stories.length, 4);
    assert.deepEqual(
      stories.map((s) => s.id),
      ['S-1', 'S-2', 'S-3', 'S-4'],
    );
    const s1 = stories.find((s) => s.id === 'S-1');
    assert.equal(s1.status, 'done');
    assert.equal(s1.componentId, 'C00');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// findUnitPRs (F-42 D4): change.md, then change.find by repo and branch
// ---------------------------------------------------------------------------

/**
 * A runOp answering `change.find` per repo path from `byRepo` (a list of
 * PRs, or a full runForgeOp result), recording each call.
 */
function findStub(byRepo) {
  const calls = [];
  const runOp = (op, vars, { repoPath }) => {
    calls.push({ op, vars, repoPath });
    const r = byRepo[repoPath];
    if (r == null) return { configured: true, status: 0, stdout: '[]' };
    return Array.isArray(r) ? { configured: true, status: 0, stdout: JSON.stringify(r) } : r;
  };
  return { calls, runOp };
}

const UNIT = { featureEntry: 'S9-thing', primaryRepo: 'a', repos: [], change: null };

test('findUnitPRs: no change document → change.find on the unit branch in the primary repo', () => {
  const cfg = { reposByName: { a: '/ra', b: '/rb' } };
  const { calls, runOp } = findStub({ '/ra': [{ number: 7, url: 'u7', state: 'OPEN' }] });
  const out = findUnitPRs(cfg, UNIT, { runOp });
  assert.deepEqual(calls, [{ op: 'change.find', vars: { branch: 's9-thing' }, repoPath: '/ra' }]);
  assert.deepEqual(out.prs, [{ repoName: 'a', repoPath: '/ra', prNumber: 7, prUrl: 'u7', isPrimary: true }]);
  assert.deepEqual(out.merged, []);
  assert.deepEqual(out.searched, [{ repoName: 'a', repoPath: '/ra', hasPR: true }]);
});

test('findUnitPRs: the change document names the repos and the recorded PR wins over the newest listed', () => {
  const cfg = { reposByName: { a: '/ra', b: '/rb', c: '/rc' } };
  const unit = {
    ...UNIT,
    branch: 's9-thing',
    repos: ['c'],
    change: {
      repos: [
        { repo: 'b', branch: 's9-thing', pr: '4', url: 'u4' },
        { repo: 'a', branch: 's9-thing', pr: '', url: '' },
      ],
    },
  };
  const { calls, runOp } = findStub({
    '/rb': [{ number: 4, url: 'u4', state: 'OPEN' }],
    '/ra': [{ number: 3, url: 'u3', state: 'OPEN' }],
  });
  const out = findUnitPRs(cfg, unit, { runOp });
  assert.deepEqual(
    calls.map((c) => c.repoPath),
    ['/rb', '/ra', '/rc'],
    'change document first, then the primary and the other repos',
  );
  assert.deepEqual(
    out.prs.map((p) => [p.repoName, p.prNumber, p.isPrimary]),
    [
      ['b', 4, false],
      ['a', 3, true],
    ],
  );
  assert.deepEqual(
    out.searched.map((s) => [s.repoName, s.hasPR]),
    [
      ['b', true],
      ['a', true],
      ['c', false],
    ],
  );
});

test('findUnitPRs: a recorded PR change.find does not list still counts as open', () => {
  const cfg = { reposByName: { a: '/ra' } };
  const unit = { ...UNIT, change: { repos: [{ repo: 'a', branch: 's9-thing', pr: '12', url: 'u12' }] } };
  const { runOp } = findStub({ '/ra': [{ number: 15, url: 'u15', state: 'OPEN' }] });
  const out = findUnitPRs(cfg, unit, { runOp });
  assert.deepEqual(out.prs, [{ repoName: 'a', repoPath: '/ra', prNumber: 12, prUrl: 'u12', isPrimary: true }]);
});

test('findUnitPRs: change.find state MERGED → merged, not open (S-788)', () => {
  const cfg = { reposByName: { a: '/ra' } };
  const { runOp } = findStub({ '/ra': [{ number: 7, url: 'https://x/pr/7', state: 'MERGED', headRefOid: 'abcdef1' }] });
  const out = findUnitPRs(cfg, UNIT, { runOp });
  assert.deepEqual(out.prs, []);
  assert.deepEqual(out.merged, [{ repoName: 'a', number: 7, url: 'https://x/pr/7', headRefOid: 'abcdef1' }]);
  assert.deepEqual(out.searched, [{ repoName: 'a', repoPath: '/ra', hasPR: false }]);
});

test('findUnitPRs: a recorded PR the forge lists as merged is merged', () => {
  const cfg = { reposByName: { a: '/ra' } };
  const unit = { ...UNIT, change: { repos: [{ repo: 'a', branch: 's9-thing', pr: '7', url: 'u7' }] } };
  const { runOp } = findStub({ '/ra': [{ number: 7, url: 'u7', state: 'merged', headRefOid: 'abc' }] });
  const out = findUnitPRs(cfg, unit, { runOp });
  assert.deepEqual(out.prs, []);
  assert.equal(out.merged[0].number, 7);
});

test('findUnitPRs: a closed PR is neither open nor merged', () => {
  const cfg = { reposByName: { a: '/ra' } };
  const { runOp } = findStub({ '/ra': [{ number: 7, url: 'u', state: 'CLOSED' }] });
  const out = findUnitPRs(cfg, UNIT, { runOp });
  assert.deepEqual([out.prs, out.merged], [[], []]);
  assert.deepEqual(out.searched, [{ repoName: 'a', repoPath: '/ra', hasPR: false }]);
});

test('findUnitPRs: opts.repo restricts the search to that repo', () => {
  const cfg = { reposByName: { a: '/ra', b: '/rb' } };
  const { calls, runOp } = findStub({});
  const out = findUnitPRs(cfg, { ...UNIT, repos: ['b'] }, { repo: 'b', runOp });
  assert.deepEqual(
    calls.map((c) => c.repoPath),
    ['/rb'],
  );
  assert.deepEqual(out.searched, [{ repoName: 'b', repoPath: '/rb', hasPR: false }]);
});

test('findUnitPRs: an unknown repo is skipped', () => {
  const cfg = { reposByName: { a: '/ra' } };
  const { calls, runOp } = findStub({});
  const out = findUnitPRs(cfg, { ...UNIT, repos: ['gone'] }, { runOp });
  assert.deepEqual(
    calls.map((c) => c.repoPath),
    ['/ra'],
  );
  assert.equal(out.searched.length, 1);
});

test('findUnitPRs: without a usable forge a recorded PR is open and an unrecorded repo carries the reason', () => {
  const cfg = { reposByName: { a: '/ra', b: '/rb' } };
  const unit = {
    ...UNIT,
    repos: ['b'],
    change: { repos: [{ repo: 'a', branch: 's9-thing', pr: '5', url: 'u5' }] },
  };
  for (const res of [
    { configured: false, reason: 'no-forge' },
    { configured: true, status: 1, stderr: 'boom' },
    { configured: true, status: 0, stdout: 'not json' },
  ]) {
    const { runOp } = findStub({ '/ra': res, '/rb': res });
    const out = findUnitPRs(cfg, unit, { runOp });
    assert.deepEqual(
      out.prs.map((p) => p.prNumber),
      [5],
      JSON.stringify(res),
    );
    assert.deepEqual(out.searched[0], { repoName: 'a', repoPath: '/ra', hasPR: true });
    assert.equal(out.searched[1].hasPR, false);
    assert.ok(out.searched[1].reason, JSON.stringify(res));
  }
});

test('findUnitPRs: runs the configured change.find, the branch passed quoted', () => {
  const repoA = mkTempDir('bl-findprs-a-');
  const ghPlugin = {
    'change.find': `test {{branch}} = s9-thing && printf '%s' '[{"number":3,"url":"u3","state":"OPEN"}]'`,
  };
  const cfg = {
    raw: { forge: 'github', plugins: { github: ghPlugin } },
    plugins: { github: ghPlugin },
    reposByName: { a: repoA },
  };
  const out = findUnitPRs(cfg, UNIT);
  assert.deepEqual(out.prs, [{ repoName: 'a', repoPath: repoA, prNumber: 3, prUrl: 'u3', isPrimary: true }]);
});

test('readAllStories reads a story whose index.md has CRLF line ends', () => {
  const { dir, cleanup } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [{ id: 'S-1', component: 'C01', title: 'Windows', status: 'refined' }],
  });
  try {
    const p = join(dir, 'stories', 'S1', 'index.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
    const [s] = readAllStories(loadConfig({ backlogRoot: dir }));
    assert.deepEqual([s?.id, s?.title, s?.status], ['S-1', 'Windows', 'refined']);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The F-49 D3 layout: stories/, components/, features/; status, not location
// ---------------------------------------------------------------------------

/** Three repos, two with a component; stories of every status. */
function flatBacklog() {
  return mkTempBacklog({
    repos: ['../app', '../bl', '../tools'],
    components: [
      { id: 'C00', title: 'App', dirSuffix: 'app', repo: 'app', home: true },
      { id: 'C32', title: 'bl Tool Enhancements', dirSuffix: 'bl-tool-enhancements', repo: 'bl', home: true },
    ],
    stories: [
      { id: 'S-1', component: 'C32', title: 'Open', dirSuffix: 'open', primary_repo: 'bl' },
      { id: 'S-2', component: 'C32', title: 'Done', dirSuffix: 'done', status: 'done' },
      { id: 'S-3', component: 'C00', title: 'Superseded', dirSuffix: 'gone', status: 'superseded' },
    ],
  });
}

test('readAllStories reads every story under stories/, whatever its status', () => {
  const { dir } = flatBacklog();
  const stories = readAllStories(loadConfig({ backlogRoot: dir }));
  assert.deepEqual(
    stories.map((s) => [s.id, s.status, s.storyRelPath]),
    [
      ['S-1', 'backlog', 'stories/S1-open/index.md'],
      ['S-2', 'done', 'stories/S2-done/index.md'],
      ['S-3', 'superseded', 'stories/S3-gone/index.md'],
    ],
  );
});

test("each story carries its component and the component's repo (F-51 D4)", () => {
  const { dir } = flatBacklog();
  const byId = new Map(readAllStories(loadConfig({ backlogRoot: dir })).map((s) => [s.id, s]));
  assert.deepEqual(
    ['S-1', 'S-2', 'S-3'].map((id) => [byId.get(id).componentId, byId.get(id).componentEntry, byId.get(id).unitRepo]),
    [
      ['C32', 'C32-bl-tool-enhancements', 'bl'],
      ['C32', 'C32-bl-tool-enhancements', 'bl'],
      ['C00', 'C00-app', 'app'],
    ],
  );
});

test('readAllStories and findStoryDir take no project filter (F-51 D5)', () => {
  const { dir } = flatBacklog();
  const cfg = loadConfig({ backlogRoot: dir });
  assert.deepEqual(
    readAllStories(cfg, 'demo').map((s) => s.id),
    ['S-1', 'S-2', 'S-3'],
  );
  assert.equal(findStoryDir({ dirPrefix: 'S1' }, cfg, 'demo')?.storyEntry.startsWith('S1'), true);
});

test('a story with an unknown component has no repo, whatever primary_repo it names (F-52 D1)', () => {
  const { dir } = mkTempBacklog({
    repos: ['../bl'],
    stories: [
      { id: 'S-1', component: 'C77', title: 'By repo', primary_repo: 'bl' },
      { id: 'S-2', component: 'C77', title: 'No repo' },
    ],
  });
  const cfg = loadConfig({ backlogRoot: dir });
  const stories = readAllStories(cfg);
  assert.deepEqual(
    stories.map((s) => [s.id, s.componentId, s.componentEntry, s.unitRepo]),
    [
      ['S-1', 'C77', '', ''],
      ['S-2', 'C77', '', ''],
    ],
  );
  assert.deepEqual(reposForStory('S-1', cfg), []);
});

test("a leftover primary_repo or secondary_repos naming another repo still resolves to the component's repo (F-52 D1)", () => {
  const { dir } = flatBacklog();
  const p = join(dir, 'stories', 'S1-open', 'index.md');
  writeFileSync(
    p,
    readFileSync(p, 'utf8').replace(/^primary_repo: bl$/m, 'primary_repo: app\nsecondary_repos: [tools]'),
  );
  const cfg = loadConfig({ backlogRoot: dir });
  const s1 = readAllStories(cfg).find((s) => s.id === 'S-1');
  assert.equal(s1.unitRepo, 'bl');
  assert.equal('primaryRepo' in s1 || 'secondaryRepos' in s1, false);
  assert.equal(findStoryDir({ dirPrefix: 'S1' }, cfg).unitRepo, 'bl');
  const repos = reposForStory('S-1', cfg);
  assert.deepEqual(
    repos.map((r) => [r.repoName, r.repoPath, r.worktreePath.endsWith('/s1-open/bl')]),
    [['bl', cfg.reposByName.bl, true]],
  );
});

test('findStoryDir finds a done story where it was written, with its component', () => {
  const { dir } = flatBacklog();
  const hit = findStoryDir({ dirPrefix: 'S2' }, loadConfig({ backlogRoot: dir }));
  assert.deepEqual(
    [hit.storyEntry, hit.componentId, hit.componentEntry, hit.unitRepo],
    ['S2-done', 'C32', 'C32-bl-tool-enhancements', 'bl'],
  );
  assert.equal(hit.indexPath, join(dir, 'stories', 'S2-done', 'index.md'));
});

test('nothing under a .completed/ directory is read', () => {
  const { dir } = flatBacklog();
  for (const [sub, fm] of [
    [['stories', '.completed', 'S9-old'], 'story_id: S-9\ntitle: Old\nstatus: done\ncomponent: C32\n'],
    [['components', '.completed', 'C40-old'], 'component_id: C40\ntitle: Old\nrepo: bl\n'],
    [['features', '.completed', 'F9-old'], 'feature_id: F-9\ntitle: Old\nstatus: done\n'],
  ]) {
    mkdirSync(join(dir, ...sub), { recursive: true });
    writeFileSync(join(dir, ...sub, 'index.md'), `---\n${fm}---\n`);
  }
  const cfg = loadConfig({ backlogRoot: dir });
  assert.deepEqual(
    readAllStories(cfg).map((s) => s.id),
    ['S-1', 'S-2', 'S-3'],
  );
  assert.equal(findStoryDir({ dirPrefix: 'S9' }, cfg), null);
  assert.deepEqual(
    readComponents(cfg).map((c) => c.id),
    ['C00', 'C32'],
  );
  assert.equal(findMaxStoryNum(cfg), 3);
  assert.equal(findNextComponentNum(cfg), 33n);
});

test('readComponents and findComponentDir read components/ with repo and home', () => {
  const { dir } = flatBacklog();
  const cfg = loadConfig({ backlogRoot: dir });
  const c = findComponentDir(normalizeComponentId('c-32'), cfg);
  assert.deepEqual(
    [c.id, c.title, c.repo, c.home, c.componentEntry],
    ['C32', 'bl Tool Enhancements', 'bl', true, 'C32-bl-tool-enhancements'],
  );
  assert.equal(c.indexPath, join(dir, 'components', 'C32-bl-tool-enhancements', 'index.md'));
  assert.equal(findComponentDir(normalizeComponentId('C32'), cfg, 'demo')?.id, 'C32');
  assert.equal(findComponentDir(normalizeComponentId('C5'), cfg), null);
});

test('normalizeComponentId takes C-ids only', () => {
  assert.deepEqual(normalizeComponentId('C5'), { num: '05', id: 'C05', dirPrefix: 'C05' });
  assert.deepEqual(normalizeComponentId('c-32')?.id, 'C32');
  assert.deepEqual(normalizeComponentId('C032'), { num: '32', id: 'C32', dirPrefix: 'C32' });
  assert.equal(normalizeComponentId('C000')?.id, 'C00');
  assert.equal(normalizeComponentId('E32'), null);
  assert.equal(normalizeComponentId('S32'), null);
});

test('findNextComponentNum counts past 2^53 without rounding onto an existing id', () => {
  for (const [entry, next] of [
    ['C9007199254740992-big', 9007199254740993n],
    ['C9007199254740993-big', 9007199254740994n],
    ['C999999999999999999999-big', 1000000000000000000000n],
  ]) {
    const { dir, cleanup } = mkTempBacklog();
    try {
      mkdirSync(join(dir, 'components', 'C01-small'), { recursive: true });
      mkdirSync(join(dir, 'components', entry), { recursive: true });
      const cfg = loadConfig({ backlogRoot: dir });
      assert.equal(findNextComponentNum(cfg), next, entry);
    } finally {
      cleanup();
    }
  }
});

test('parsePathList takes the parsed sequence; absent is null, empty is [], a scalar is not a list (F-62 D2)', () => {
  assert.deepEqual(parsePathList(['src/**', ' test/** ']), ['src/**', 'test/**']);
  assert.deepEqual(parsePathList(['{src,test}/**/*.js', 'a,b.md']), ['{src,test}/**/*.js', 'a,b.md']);
  assert.equal(parsePathList(undefined), null);
  assert.deepEqual(parsePathList(''), []);
  assert.deepEqual(parsePathList([]), []);
  for (const raw of ['src/**', '["src/**"]', { a: 'b' }]) {
    const [only, ...rest] = parsePathList(raw);
    assert.equal(rest.length, 0);
    assert.match(pathEntryProblem(only), /is not a list/, JSON.stringify(raw));
  }
  const { fm } = parseFrontmatter(serializeFrontmatter({ paths: ['src/**', '{a,b}/*'] }));
  assert.deepEqual(parsePathList(fm.paths), ['src/**', '{a,b}/*'], 'round-trips through the yaml package');
});

test('readComponents returns paths from an inline or a block-sequence list', () => {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['../repos/bl'],
    components: [
      { id: 'C01', title: 'Inline', dirSuffix: 'inline', repo: 'bl', paths: ['src/**', 'test/**'] },
      { id: 'C02', title: 'Block', dirSuffix: 'block', repo: 'bl' },
      { id: 'C03', title: 'None', dirSuffix: 'none', repo: 'bl', paths: null },
    ],
  });
  try {
    writeFileSync(
      join(dir, 'components/C02-block/index.md'),
      '---\ncomponent_id: C02\ntitle: Block\nrepo: bl\npaths:\n  - "docs/**"\n  - README.md\n---\n',
    );
    const byId = Object.fromEntries(readComponents(loadConfig({ backlogRoot: dir })).map((c) => [c.id, c.paths]));
    assert.deepEqual(byId, { C01: ['src/**', 'test/**'], C02: ['docs/**', 'README.md'], C03: null });
  } finally {
    cleanup();
  }
});

test('pathEntryProblem refuses an empty, absolute or .. entry', () => {
  assert.equal(pathEntryProblem('src/**'), null);
  assert.equal(pathEntryProblem('**'), null);
  assert.equal(pathEntryProblem('..foo/x'), null, 'a name starting with dots is not ..');
  assert.equal(pathEntryProblem(''), 'is empty');
  assert.equal(pathEntryProblem('/src/**'), 'is absolute');
  assert.equal(pathEntryProblem('C:\\src'), 'is absolute');
  assert.equal(pathEntryProblem('../x'), 'contains ".."');
  assert.equal(pathEntryProblem('src/../x'), 'contains ".."');
  assert.equal(pathEntryProblem('./src/**'), 'contains a "." segment', 'git diff never names ./src/a.js');
  assert.equal(pathEntryProblem('src/./x'), 'contains a "." segment');
  assert.equal(pathEntryProblem('.github/**'), null, 'a dotfile directory is fine');
});

test('pathMatches uses path.matchesGlob and covers dotfiles', () => {
  assert.ok(pathMatches('src/a/b.js', ['src/**']));
  assert.ok(!pathMatches('test/a.js', ['src/**']));
  assert.ok(pathMatches('.github/workflows/ci.yml', ['**']), '** covers a dot directory');
  assert.ok(pathMatches('.gitignore', ['*']));
  assert.ok(pathMatches('.github/x.yml', ['.github/**']));
  assert.ok(!pathMatches('src/a.js', ['.github/**']));
  assert.ok(pathMatches('test/x.test.js', ['{src,test}/**']));
  assert.ok(!pathMatches('src/a.js', null));
});

test('component_paths_reject_invalid_members_and_round_trip_escaped_globs', async () => {
  const { findComponentFindings } = await import('../../src/validate.js');
  const root = mkTempDir('bl-paths-');
  let n = 0;
  /** A component file with `fmPaths` as its paths frontmatter, read back. */
  const component = (fmPaths) => {
    const dir = join(root, 'components', `C${String(++n).padStart(2, '0')}-x`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.md'),
      `---\ncomponent_id: C${String(n).padStart(2, '0')}\ntitle: X\nrepo: bl\nhome: true\n${fmPaths}\n---\n`,
    );
    const c = readComponents({ backlogRoot: root }).find((r) => r.componentDir === dir);
    const errors = findComponentFindings([], [c], ['bl'], root).filter((f) => f.code === 'component-paths');
    return { c, errors };
  };
  // Every invalid member class, inline and block, is reported, not dropped or coerced.
  const invalid = [
    ['inline empty member', 'paths: ["src/**", ""]', /path "" is empty/],
    ['block empty member', 'paths:\n  - src/**\n  - ""', /path "" is empty/],
    ['block mapping', 'paths:\n  - src/**\n  - bad: src/**', /is not a string/],
    ['block nested list', 'paths:\n  - [src/**]', /is not a string/],
    ['inline mapping', 'paths: [{bad: x}]', /is not a string/],
    ['a scalar', 'paths: src/**', /is not a list/],
  ];
  for (const [name, text, re] of invalid) {
    const { errors } = component(text);
    assert.ok(
      errors.some((e) => re.test(e.message)),
      `${name}: ${JSON.stringify(errors)}`,
    );
  }
  // paths: is optional (F-61 D2): absent, empty or an empty list is no finding.
  for (const [name, text] of [
    ['absent', 'title2: x'],
    ['empty value', 'paths:'],
    ['empty inline list', 'paths: []'],
  ]) {
    assert.deepEqual(component(text).errors, [], name);
  }
  // A block that is not YAML is not read: readComponents names the file and line.
  for (const text of ['paths: [src/**, , test/**]', 'paths: ["a\\qb"]', 'paths: ["src/**]', 'paths: [**]']) {
    assert.throws(
      () => componentWithPaths(mkTempDir('bl-paths-'), 1, text, findComponentFindings),
      (e) => e instanceof FrontmatterError && e.line === 6 && /components\/C01-x\/index\.md: /.test(e.message),
      text,
    );
  }
  // A non-string value handed in directly is reported too.
  for (const raw of [[42], [{ bad: 'src/**' }], ['src/**', { bad: 'x' }]]) {
    assert.ok(
      parsePathList(raw).some((g) => pathEntryProblem(g) === 'is not a string'),
      JSON.stringify(raw),
    );
  }
  // Every list serializeFrontmatter writes (bl new, the spec, the migration) reads back exactly.
  const lists = [
    ['src/**'],
    ['a"b.js'],
    ['a\\b.js'],
    ['a"b.js', 'test/**'],
    ['a,b.js'],
    ['{src,test}/**'],
    ["it's/**"],
    ['é/**', 'tab\t.js'],
  ];
  for (const paths of lists) {
    const line = serializeFrontmatter({ paths }).slice('---\n'.length, -'\n---\n'.length);
    const { c, errors } = component(line);
    assert.deepEqual(c.paths, paths, `readComponents: ${line}`);
    assert.deepEqual(errors, [], line);
  }
  // A wrapped flow list's one trailing comma is no member; single quotes decode their doubled quote.
  assert.deepEqual(component('paths: [\n  "src/**",\n  test/**,\n]').c.paths, ['src/**', 'test/**']);
  assert.deepEqual(component("paths: ['it''s, here', src/a\"b.js]").c.paths, ["it's, here", 'src/a"b.js']);
  // An invalid member never matches a path.
  assert.equal(pathMatches('src/a.js', parsePathList([{ bad: 'src/**' }])), false);
});

/** A component file with `fmPaths` as its paths frontmatter, read back with its findings. */
function componentWithPaths(root, n, fmPaths, findComponentFindings) {
  const dir = join(root, 'components', `C${String(n).padStart(2, '0')}-x`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.md'),
    `---\ncomponent_id: C${String(n).padStart(2, '0')}\ntitle: X\nrepo: bl\nhome: true\n${fmPaths}\n---\n`,
  );
  const c = readComponents({ backlogRoot: root }).find((r) => r.componentDir === dir);
  const errors = findComponentFindings([], [c], ['bl'], root).filter((f) => f.code === 'component-paths');
  return { c, errors };
}

test('component_paths_reject_bare_empty_block_members_before_between_and_after_valid_globs', async () => {
  const { findComponentFindings } = await import('../../src/validate.js');
  const root = mkTempDir('bl-paths-');
  const cases = [
    ['before', 'paths:\n  -\n  - src/**', ['', 'src/**']],
    ['between', 'paths:\n  - src/**\n  -\n  - test/**', ['src/**', '', 'test/**']],
    ['after', 'paths:\n  - src/**\n  -', ['src/**', '']],
    ['only', 'paths:\n  -', ['']],
    ['crlf', 'paths:\r\n  - src/**\r\n  -\r\n  - test/**', ['src/**', '', 'test/**']],
  ];
  cases.forEach(([name, text, want], i) => {
    const { c, errors } = componentWithPaths(root, i + 1, text, findComponentFindings);
    assert.deepEqual(c.paths.map(String), want, name);
    assert.ok(
      errors.some((e) => /path "" is empty/.test(e.message)),
      `${name}: ${JSON.stringify(errors)}`,
    );
  });
  // Block members still decode as before: quoted, and no bare `-`, read back with no finding.
  const { c, errors } = componentWithPaths(root, 9, 'paths:\n  - "a\\"b.js"\n  - test/**', findComponentFindings);
  assert.deepEqual(c.paths, ['a"b.js', 'test/**']);
  assert.deepEqual(errors, []);
});

test('component_paths_read_as_yaml_reports_nested_members_and_refuses_what_is_not_yaml', async () => {
  const { findComponentFindings } = await import('../../src/validate.js');

  const root = mkTempDir('bl-paths-');
  // [frontmatter, valid globs kept alongside the members that are not strings]
  const cases = [
    ['paths: [[src/**, "**", test/**]]', []],
    ['paths: [src/**, ["**", test/**]]', ['src/**']],
    ['paths: [src/**, {a: "**", b: x}]', ['src/**']],
    ['paths:\n  - src/**\n  - ["**", test/**]', ['src/**']],
    ['paths:\n  - src/**\n  - {a: b}', ['src/**']],
  ];
  cases.forEach(([text, valid], i) => {
    const { c, errors } = componentWithPaths(root, i + 1, text, findComponentFindings);
    const invalid = c.paths.filter((g) => pathEntryProblem(g));
    assert.ok(
      invalid.length > 0 && invalid.every((g) => pathEntryProblem(g) === 'is not a string'),
      `${text}: ${c.paths}`,
    );
    assert.deepEqual(
      c.paths.filter((g) => !pathEntryProblem(g)),
      valid,
      text,
    );
    assert.equal(errors.length, invalid.length, `${text}: ${JSON.stringify(errors)}`);
    // No invalid member becomes a matching glob: a file outside the valid ones matches none.
    assert.equal(pathMatches('secrets/private.txt', c.paths), false, `${text}: match`);
  });
  // What YAML cannot read is not read at all: an unclosed list, a stray bracket, an unanchored alias.
  for (const text of [
    'paths: [src/**, test/**',
    'paths: [src/**, test/**]]',
    'paths: [src/**, {**, test/**]',
    'paths: [**, test/**]',
    'paths:\n  - **',
  ]) {
    assert.throws(
      () => componentWithPaths(mkTempDir('bl-paths-'), 1, text, findComponentFindings),
      FrontmatterError,
      text,
    );
  }
  // Under the failsafe schema every scalar is a string: `true`, `42` and `~` are globs like any other.
  const scalars = componentWithPaths(
    root,
    40,
    'paths: [src/**, "true", 42, ~, "src/[ab].js", "src/{a,b}/**"]',
    findComponentFindings,
  );
  assert.deepEqual(scalars.c.paths, ['src/**', 'true', '42', '~', 'src/[ab].js', 'src/{a,b}/**']);
  assert.deepEqual(scalars.errors, []);
  // Only the top-level `paths:` is the list.
  const nested = componentWithPaths(root, 50, 'meta:\n  paths:\n    -\npaths: [src/**]', findComponentFindings);
  assert.deepEqual(nested.c.paths, ['src/**']);
  assert.deepEqual(nested.errors, []);
  // A key written twice is not YAML.
  assert.throws(
    () => componentWithPaths(mkTempDir('bl-paths-'), 1, 'paths:\n  -\npaths: [src/**]', findComponentFindings),
    FrontmatterError,
  );
});
