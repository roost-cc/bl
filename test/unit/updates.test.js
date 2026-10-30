import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { extractSection } from '../../src/feature.js';
import {
  GONE_NOTE,
  configuredReportPath,
  openBranches,
  renderTable,
  repoForSlug,
  syncUpdates,
  tableRows,
  testPluginsFor,
  upgradesTable,
  validateReport,
} from '../../src/updates.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { startTokenWriter } from '../helpers/token-writer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A backlog with three repos (tools, bl, app.acme.com), each repo's home
 * component (tools C31, bl C32, app.acme.com C00), and `update_tests` for bl.
 * The repo directories exist but are not git repos.
 */
function setup() {
  const { dir, cleanup } = mkTempBacklog({
    repos: {
      tools: 'repos/tools',
      bl: { path: 'repos/bl', update_tests: ['bl-tests'] },
      'app.acme.com': 'repos/app.acme.com',
    },
    components: [
      { id: 'C31', title: 'Tools', dirSuffix: 'tools', repo: 'tools', home: true },
      { id: 'C32', title: 'bl', dirSuffix: 'bl', repo: 'bl', home: true },
      { id: 'C00', title: 'App', dirSuffix: 'app', repo: 'app.acme.com', home: true },
    ],
  });
  const cfgPath = join(dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  raw.updates = { namespace: 'roost-cc' };
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
  for (const r of ['tools', 'bl', 'app.acme.com']) {
    mkdirSync(join(dir, 'repos', r), { recursive: true });
  }
  const reportPath = join(dir, 'report.json');
  const storiesDir = join(dir, 'stories');
  return {
    dir,
    cleanup,
    reportPath,
    storiesDir,
    config: () => loadConfig({ backlogRoot: dir }),
  };
}

const LFM = (prNo = 36) => ({
  branchName: 'renovate/lock-file-maintenance',
  prNo,
  prTitle: 'chore(deps): lock file maintenance',
  result: 'done',
  upgrades: [
    { displayPending: '', packageFile: 'package.json', updateType: 'lockFileMaintenance' },
    { displayPending: '', packageFile: 'mcp/package.json', updateType: 'lockFileMaintenance' },
  ],
});

const PRETTIER_PENDING = {
  branchName: 'renovate/prettier-3.x',
  prNo: null,
  prTitle: 'chore(deps): update dependency prettier to v3.9.10',
  result: 'pending',
  upgrades: [
    {
      depName: 'prettier',
      datasource: 'npm',
      currentValue: '3.9.9',
      newValue: '3.9.10',
      updateType: 'patch',
      packageFile: 'package.json',
    },
  ],
};

const koaUpgrade = (extra = {}) => ({
  depName: 'koa',
  packageName: 'koa',
  datasource: 'npm',
  currentVersion: '2.15.0',
  currentValue: '^2.15.0',
  newVersion: '3.0.0',
  newValue: '^3.0.0',
  updateType: 'major',
  packageFile: 'package.json',
  ...extra,
});

const KOA = (extra = {}) => ({
  branchName: 'renovate/koa-3.x',
  prNo: 320,
  prTitle: 'fix(deps): update dependency koa to v3',
  result: 'done',
  // The report repeats an upgrade per occurrence; the table lists it once.
  upgrades: [koaUpgrade(extra), koaUpgrade(extra)],
});

const VITEST = {
  branchName: 'renovate/vitest-4.x',
  prNo: 7,
  prTitle: 'chore(deps): update dependency vitest to v4.1.0',
  result: 'done',
  upgrades: [
    {
      depName: 'vitest',
      datasource: 'npm',
      currentValue: '4.0.2',
      newValue: '4.1.0',
      updateType: 'minor',
      packageFile: 'package.json',
    },
  ],
};

const UNKNOWN = {
  branchName: 'renovate/x',
  prNo: 1,
  prTitle: 'chore(deps): update x',
  result: 'done',
  upgrades: [],
};

/** `{ "roost-cc/<repo>": [branches] }` → a report object. */
function mkReport(byRepo) {
  const repositories = {};
  for (const [slug, branches] of Object.entries(byRepo)) {
    repositories[slug] = {
      problems: [],
      branches,
      packageFiles: {},
      libYearsWithStatus: {},
    };
  }
  return { problems: [], repositories };
}

const FULL = () =>
  mkReport({
    'roost-cc/tools': [LFM(), PRETTIER_PENDING],
    'roost-cc/app.acme.com': [KOA()],
    'roost-cc/bl': [VITEST],
    'roost-cc/unknown': [UNKNOWN],
  });

const HEADS = (over = {}) =>
  new Map(
    Object.entries({
      'renovate/lock-file-maintenance': 'aaa111',
      'renovate/koa-3.x': 'bbb222',
      'renovate/vitest-4.x': 'ccc333',
      ...over,
    }),
  );

/** Run a sync with git and the forge replaced; returns result and lines. */
async function run(t, report, extra = {}) {
  writeFileSync(t.reportPath, JSON.stringify(report));
  const lines = [];
  const res = await syncUpdates(t.config(), {
    reportPath: t.reportPath,
    today: '2026-10-14',
    listHeads: () => HEADS(),
    lookupPr: () => ({ url: 'https://forge/pr', security: false }),
    out: (l) => lines.push(l),
    ...extra,
  });
  return { res, lines };
}

/** The update stories of the backlog, keyed by id, with fm/body/text. */
function stories(t) {
  const out = new Map();
  for (const s of readAllStories(t.config())) {
    const text = readFileSync(s.indexPath, 'utf8');
    const { fm, body } = parseFrontmatter(text);
    if (!fm.update_repo) continue;
    out.set(fm.story_id, { ...s, fm, body, text });
  }
  return out;
}

function rewrite(story, mutate) {
  const { fm, body } = parseFrontmatter(readFileSync(story.indexPath, 'utf8'));
  const next = mutate(fm, body) ?? body;
  writeFileSync(story.indexPath, serializeFrontmatter(fm) + next);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('openBranches keeps branches with a PR number and dedupes upgrades', () => {
  const open = openBranches(FULL());
  assert.deepEqual(
    open.map((b) => [b.slug, b.branchName, b.prNo]),
    [
      ['roost-cc/tools', 'renovate/lock-file-maintenance', 36],
      ['roost-cc/app.acme.com', 'renovate/koa-3.x', 320],
      ['roost-cc/bl', 'renovate/vitest-4.x', 7],
      ['roost-cc/unknown', 'renovate/x', 1],
    ],
  );
  const koa = open[1];
  assert.equal(koa.upgrades.length, 1);
  assert.equal(koa.major, true);
  assert.equal(koa.security, false);
  assert.equal(open[0].major, false);
  assert.deepEqual(openBranches({}), []);
  assert.throws(() => openBranches(null), /malformed report: the report/);
});

test('upgradesTable renders a prettier-aligned table; tableRows reads it back', () => {
  const table = upgradesTable(KOA().upgrades.slice(0, 1).concat(LFM().upgrades));
  const lines = table.split('\n');
  assert.equal(lines.length, 5);
  assert.ok(
    lines.every((l) => l.length === lines[0].length),
    'aligned',
  );
  assert.match(lines[1], /^\| -+ \| -+ \| -+ \| -+ \| -+ \| -+ \|$/);
  assert.deepEqual(tableRows(table), [
    ['koa', 'npm', '^2.15.0', '^3.0.0', 'major', 'package.json'],
    ['(lock file)', '', '', '', 'lockFileMaintenance', 'package.json'],
    ['(lock file)', '', '', '', 'lockFileMaintenance', 'mcp/package.json'],
  ]);
  // Alignment does not matter when comparing.
  const loose = table.replace(/ {2,}/g, ' ');
  assert.deepEqual(tableRows(loose), tableRows(table));
  assert.deepEqual(tableRows(upgradesTable([])), [['(none listed)', '', '', '', '', '']]);
  assert.equal(renderTable(['a', 'b'], [['x', 'y']]).split('\n').length, 3);
});

test('repoForSlug maps a slug to the repo of that name in backlog.json repos', () => {
  const t = setup();
  try {
    const cfg = t.config();
    assert.deepEqual(repoForSlug('roost-cc/app.acme.com', cfg), {
      name: 'app.acme.com',
      repoPath: join(t.dir, 'repos', 'app.acme.com'),
    });
    assert.equal(repoForSlug('roost-cc/tools', cfg).name, 'tools');
    assert.equal(repoForSlug('roost-cc/unknown', cfg), null);
    assert.deepEqual(testPluginsFor('bl', cfg), ['bl-tests']);
    assert.equal(testPluginsFor('tools', cfg), null);
  } finally {
    t.cleanup();
  }
});

test('repoForSlug rejects an unconfigured forge namespace', async () => {
  const t = setup();
  try {
    const cfg = t.config();
    // Only `<namespace>/<registered repo>`, spelled exactly, maps to a checkout.
    const cases = [
      ['roost-cc/bl', 'bl'],
      ['attacker/bl', null],
      ['bl', null],
      ['', null],
      [null, null],
      ['roost-cc/', null],
      ['roost-cc', null],
      ['roost-cc/x/bl', null],
      ['roost-cc/bl/', null],
      ['Roost-CC/bl', null],
      ['roost-cc/BL', null],
      ['roost-cc/../bl', null],
      ['roost-cc/nope', null],
      ['roost-cc/repos', null],
    ];
    for (const [slug, name] of cases) {
      assert.equal(repoForSlug(slug, cfg)?.name ?? null, name, JSON.stringify(slug));
    }
    // A report naming the registered repo under another owner creates nothing
    // and touches no checkout: the slug is skipped like an unknown repo.
    const { res } = await run(t, mkReport({ 'attacker/bl': [VITEST] }));
    assert.deepEqual(res.created, []);
    assert.deepEqual(res.skippedRepos, ['attacker/bl']);
    assert.equal(stories(t).size, 0);
    // No namespace configured: nothing maps, and the sync says why.
    const cfgPath = join(t.dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    delete raw.updates.namespace;
    writeFileSync(cfgPath, JSON.stringify(raw));
    assert.throws(() => repoForSlug('roost-cc/bl', t.config()), /updates.*namespace/);
    await assert.rejects(run(t, FULL()), /updates.*namespace/);
    assert.equal(stories(t).size, 0);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

test('sync creates one refined chore story per open branch and skips unknown repos', async () => {
  const t = setup();
  try {
    const { res, lines } = await run(t, FULL());
    assert.deepEqual(res.created, ['S-1', 'S-2', 'S-3']);
    assert.deepEqual(res.skippedRepos, ['roost-cc/unknown']);
    assert.deepEqual(res.updated, []);
    assert.deepEqual(res.closed, []);
    assert.equal(lines.length, 3);
    assert.match(
      lines[0],
      /^created\s+S-1\s+roost-cc\/tools renovate\/lock-file-maintenance #36 {2}chore\(deps\): lock file maintenance$/,
    );
    assert.ok(res.commit && res.commit.notRepo, 'sync ran, no git repo to commit to');

    const all = stories(t);
    assert.equal(all.size, 3);
    const lfm = all.get('S-1');
    assert.equal(lfm.componentId, 'C31', "the tools repo's home component");
    assert.equal(lfm.fm.project, undefined, 'no project: line (F-51 D4)');
    assert.equal(lfm.fm.primary_repo, undefined, "no primary_repo: the story's repo is its component's (F-52 D1)");
    assert.equal(lfm.unitRepo, 'tools');
    assert.equal(lfm.fm.type, 'chore');
    assert.equal(lfm.fm.status, 'refined');
    assert.equal(lfm.fm.points, '1');
    assert.equal(lfm.fm.title, 'chore(deps): lock file maintenance');
    assert.equal(lfm.fm.component, 'C31');
    assert.equal(lfm.fm.update_repo, 'roost-cc/tools');
    assert.equal(lfm.fm.update_branch, 'renovate/lock-file-maintenance');
    assert.equal(lfm.fm.update_pr, '36');
    assert.equal(lfm.fm.update_head, 'aaa111');
    assert.equal(lfm.fm.update_security, undefined);
    assert.equal(lfm.fm.plugins, undefined);
    assert.equal(lfm.fm.added, '2026-10-14');
    assert.ok(lfm.indexPath.startsWith(t.storiesDir + '/S1-chore-deps-lock-file-maintenance/'));
    // Frontmatter order: the template's keys, then the update keys.
    assert.deepEqual(Object.keys(lfm.fm), [
      'component',
      'story_id',
      'title',
      'type',
      'points',
      'status',
      'added',
      'update_repo',
      'update_branch',
      'update_pr',
      'update_head',
    ]);
    // Body: summary, upgrades table, the D3 acceptance list, three empty sections.
    const summary = extractSection(lfm.body, 'Summary');
    assert.match(summary, /`roost-cc\/tools`/);
    assert.match(summary, /\[#36\]\(https:\/\/forge\/pr\)/);
    assert.match(summary, /`renovate\/lock-file-maintenance`/);
    assert.doesNotMatch(summary, /Security update/);
    assert.deepEqual(tableRows(extractSection(lfm.body, 'Upgrades')), [
      ['(lock file)', '', '', '', 'lockFileMaintenance', 'package.json'],
      ['(lock file)', '', '', '', 'lockFileMaintenance', 'mcp/package.json'],
    ]);
    const criteria = extractSection(lfm.body, 'Acceptance Criteria');
    assert.equal((criteria.match(/^- \[ \] /gm) ?? []).length, 3);
    assert.doesNotMatch(lfm.body, /Assessment/);
    assert.match(lfm.body, /\n## Gate result\n\n## Release notes\n\n## Decision needed\n$/);
    assert.doesNotMatch(lfm.text, /\{\{/);

    const koa = all.get('S-2');
    assert.equal(koa.componentId, 'C00', "the app.acme.com repo's home component");
    assert.equal(koa.unitRepo, 'app.acme.com');
    assert.equal(koa.fm.points, '3');
    assert.equal(koa.fm.update_pr, '320');
    assert.equal(koa.fm.update_head, 'bbb222');
    assert.deepEqual(tableRows(extractSection(koa.body, 'Upgrades')), [
      ['koa', 'npm', '^2.15.0', '^3.0.0', 'major', 'package.json'],
    ]);
    const koaCriteria = extractSection(koa.body, 'Acceptance Criteria');
    // A major gets no extra criterion: it takes the same gate (F-50 D5).
    assert.equal((koaCriteria.match(/^- \[ \] /gm) ?? []).length, 3);
    assert.doesNotMatch(koa.body, /Assessment/);

    const vitest = all.get('S-3');
    assert.equal(vitest.unitRepo, 'bl');
    assert.equal(vitest.fm.component, 'C32', "each repo's stories go to its own home component");
    assert.deepEqual(vitest.fm.plugins, ['bl-tests']);
    assert.equal(vitest.fm.points, '1');
    assert.equal(koa.fm.component, 'C00');
  } finally {
    t.cleanup();
  }
});

test('a second sync on the same report changes nothing', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const before = new Map([...stories(t)].map(([id, s]) => [id, s.text]));
    const { res, lines } = await run(t, FULL());
    assert.deepEqual(res.created, []);
    assert.deepEqual(res.updated, []);
    assert.deepEqual(res.closed, []);
    assert.deepEqual(res.unchanged, ['S-1', 'S-2', 'S-3']);
    assert.equal(res.commit, null);
    assert.ok(lines.every((l) => l.startsWith('unchanged')));
    for (const [id, s] of stories(t)) assert.equal(s.text, before.get(id), id);
  } finally {
    t.cleanup();
  }
});

test("a changed report updates the table and update_head and keeps the run's sections", async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const koa = stories(t).get('S-2');
    rewrite(koa, (fm, body) => {
      fm.status = 'in_progress';
      return body.replace('## Gate result\n', '## Gate result\n\n```\n30 lines of gate output\n```\n');
    });

    const changed = mkReport({
      'roost-cc/tools': [LFM(), PRETTIER_PENDING],
      'roost-cc/app.acme.com': [KOA({ newValue: '^3.1.0', newVersion: '3.1.0' })],
      'roost-cc/bl': [VITEST],
    });
    const { res } = await run(t, changed, {
      listHeads: () => HEADS({ 'renovate/koa-3.x': 'ddd444' }),
    });
    assert.deepEqual(res.updated, ['S-2']);
    assert.deepEqual(res.unchanged, ['S-1', 'S-3']);
    assert.deepEqual(res.created, []);

    const after = stories(t).get('S-2');
    assert.equal(after.fm.status, 'in_progress');
    assert.equal(after.fm.update_head, 'ddd444');
    assert.equal(after.fm.update_pr, '320');
    assert.deepEqual(tableRows(extractSection(after.body, 'Upgrades')), [
      ['koa', 'npm', '^2.15.0', '^3.1.0', 'major', 'package.json'],
    ]);
    assert.match(extractSection(after.body, 'Gate result'), /30 lines of gate output/);
    assert.match(after.body, /## Acceptance Criteria/);

    // A head that moved on its own (Renovate rebased) is an update too.
    const again = await run(t, changed, {
      listHeads: () => HEADS({ 'renovate/koa-3.x': 'eee555' }),
    });
    assert.deepEqual(again.res.updated, ['S-2']);
    assert.equal(stories(t).get('S-2').fm.update_head, 'eee555');

    // Unknown heads (offline) keep what the story has.
    const offline = await run(t, changed, { listHeads: () => null });
    assert.deepEqual(offline.res.updated, []);
    assert.equal(stories(t).get('S-2').fm.update_head, 'eee555');
  } finally {
    t.cleanup();
  }
});

test('a branch gone from the report, or without a PR, supersedes its open story', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const vitest = stories(t).get('S-3');
    rewrite(vitest, (fm) => {
      fm.status = 'done';
      fm.completed = '2026-10-13';
      fm.commit = 'abc1234';
    });

    // tools: the lock-file branch lost its PR (merged); bl: the branch is
    // gone; app: unchanged.
    const next = mkReport({
      'roost-cc/tools': [LFM(null), PRETTIER_PENDING],
      'roost-cc/app.acme.com': [KOA()],
      'roost-cc/bl': [],
    });
    const { res, lines } = await run(t, next);
    assert.deepEqual(res.closed, ['S-1']);
    assert.deepEqual(res.unchanged, ['S-2']);
    assert.deepEqual(res.created, []);
    assert.ok(lines.some((l) => /^closed\s+S-1\s+roost-cc\/tools renovate\/lock-file-maintenance #36 /.test(l)));

    const all = stories(t);
    const lfm = all.get('S-1');
    assert.equal(lfm.fm.status, 'superseded');
    assert.equal(lfm.fm.completed, '2026-10-14');
    assert.match(extractSection(lfm.body, 'Summary'), new RegExp(`2026-10-14: ${GONE_NOTE}\\.`));
    assert.ok(
      existsSync(join(t.storiesDir, 'S1-chore-deps-lock-file-maintenance', 'index.md')),
      'the superseded story stays where it is (F-49 D3)',
    );
    // The done story is left alone, whatever the report says.
    const done = all.get('S-3');
    assert.equal(done.fm.status, 'done');
    assert.equal(done.fm.completed, '2026-10-13');
    assert.ok(!lines.some((l) => /S-3/.test(l)));
  } finally {
    t.cleanup();
  }
});

test('sync rejects malformed repository branch collections without closing stories', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const before = new Map([...stories(t)].map(([id, s]) => [id, s.text]));
    const tools = (over) => ({
      repositories: {
        'roost-cc/tools': { problems: [], packageFiles: {}, ...over },
      },
    });
    const branch = (over) => tools({ branches: [{ ...LFM(), ...over }] });
    // Every shape that is not the report's, at every level: the report, the
    // repositories map, a repository, its branches list, a branch, its
    // upgrades. Each is refused by name, and no story is created or closed.
    const cases = [
      ['report is an array', [], /the report is not an object/],
      ['report is null', null, /the report is not an object/],
      [
        'repositories is a string',
        { repositories: 'x' },
        /^.*: malformed report: repositories is not an object; no story was changed$/,
      ],
      ['repositories is an array', { repositories: [] }, /repositories is not an object/],
      ['repositories is null', { repositories: null }, /repositories is not an object/],
      [
        'a repository is a string',
        { repositories: { 'roost-cc/tools': 'gone' } },
        /repositories\["roost-cc\/tools"\] is not an object/,
      ],
      [
        'a repository is null',
        { repositories: { 'roost-cc/tools': null } },
        /repositories\["roost-cc\/tools"\] is not an object/,
      ],
      ['a repository is an array', { repositories: { 'roost-cc/tools': [] } }, /is not an object/],
      ['branches missing', tools({}), /\.branches is missing \(an explicit \[\] closes the repo's stories\)/],
      ['branches null', tools({ branches: null }), /\.branches is not an array/],
      ['branches object', tools({ branches: {} }), /\.branches is not an array/],
      ['branches string', tools({ branches: 'none' }), /\.branches is not an array/],
      ['branches number', tools({ branches: 0 }), /\.branches is not an array/],
      ['a branch is a string', tools({ branches: ['renovate/x'] }), /\.branches\[0\] is not an object/],
      ['a branch is null', tools({ branches: [LFM(), null] }), /\.branches\[1\] is not an object/],
      ['a branch is an array', tools({ branches: [[]] }), /\.branches\[0\] is not an object/],
      ['branchName is a number', branch({ branchName: 7 }), /\.branches\[0\]\.branchName is not a string/],
      ['upgrades is an object', branch({ upgrades: {} }), /\.branches\[0\]\.upgrades is not an array/],
      ['upgrades is null', branch({ upgrades: null }), /\.branches\[0\]\.upgrades is not an array/],
      ['upgrades is a string', branch({ upgrades: 'none' }), /\.branches\[0\]\.upgrades is not an array/],
      ['an upgrade is null', branch({ upgrades: [null] }), /\.branches\[0\]\.upgrades\[0\] is not an object/],
      [
        'an upgrade is a string',
        branch({ upgrades: [{ depName: 'x' }, 'y'] }),
        /\.branches\[0\]\.upgrades\[1\] is not an object/,
      ],
    ];
    for (const [name, report, re] of cases) {
      await assert.rejects(run(t, report), re, name);
      assert.throws(() => validateReport(report), /^Error: malformed report: /, name);
      const now = stories(t);
      assert.equal(now.size, before.size, `${name}: nothing created`);
      for (const [id, s] of now) assert.equal(s.text, before.get(id), `${name}: ${id} untouched`);
    }
    // What the validator accepts: no repositories at all, a repository with
    // an explicit empty list, a branch without upgrades.
    for (const ok of [{}, mkReport({ 'roost-cc/tools': [] }), branch({ upgrades: undefined })]) {
      validateReport(ok);
    }
    // The explicit empty list is the authoritative "nothing open" for that
    // repo alone: tools' story closes, the others stay.
    const { res } = await run(t, mkReport({ 'roost-cc/tools': [] }));
    assert.deepEqual(res.closed, ['S-1']);
    assert.deepEqual(res.unchanged.sort(), ['S-2', 'S-3']);
  } finally {
    t.cleanup();
  }
});

test('sync rejects every malformed branch discriminator without creating or closing stories', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const before = new Map([...stories(t)].map(([id, s]) => [id, s.text]));
    // A valid new branch comes first in the report: were the malformed one
    // skipped instead of refused, its story would be created and tools'
    // story (the one the malformed branch belongs to) closed as gone.
    const fresh = {
      ...VITEST,
      branchName: 'renovate/glob-11.x',
      prNo: 99,
      prTitle: 'chore(deps): update dependency glob to v11',
    };
    const withBad = (over) =>
      mkReport({
        'roost-cc/bl': [VITEST, fresh],
        'roost-cc/tools': [{ ...LFM(), ...over }],
      });
    // Every value of `branchName` and `prNo` that is not the report's, and a
    // `prTitle` that would crash the story's directory name.
    const cases = [
      ['branchName missing', { branchName: undefined }, /\.branches\[0\]\.branchName is missing/],
      ['branchName null', { branchName: null }, /\.branches\[0\]\.branchName is not a string/],
      ['branchName empty', { branchName: '' }, /\.branches\[0\]\.branchName is empty/],
      ['branchName a number', { branchName: 7 }, /\.branches\[0\]\.branchName is not a string/],
      ['prNo a string', { prNo: '36' }, /\.branches\[0\]\.prNo is not a positive integer/],
      ['prNo zero', { prNo: 0 }, /\.prNo is not a positive integer/],
      ['prNo negative', { prNo: -1 }, /\.prNo is not a positive integer/],
      ['prNo fractional', { prNo: 36.5 }, /\.prNo is not a positive integer/],
      ['prNo boolean', { prNo: true }, /\.prNo is not a positive integer/],
      ['prNo an object', { prNo: {} }, /\.prNo is not a positive integer/],
      ['prNo an array', { prNo: [36] }, /\.prNo is not a positive integer/],
      ['prTitle a number', { prTitle: 7 }, /\.branches\[0\]\.prTitle is not a string/],
    ];
    for (const [name, over, re] of cases) {
      const report = withBad(over);
      await assert.rejects(run(t, report), re, name);
      assert.throws(() => validateReport(report), /^Error: malformed report: /, name);
      assert.throws(() => openBranches(report), /^Error: malformed report: /, name);
      const now = stories(t);
      assert.equal(now.size, before.size, `${name}: nothing created`);
      for (const [id, s] of now) assert.equal(s.text, before.get(id), `${name}: ${id} untouched`);
    }
    // What is accepted, and only an absent or null PR number reads as "not
    // open": the branch waits on Renovate (pending, needs-approval,
    // not-scheduled).
    const waiting = [
      { ...LFM(), prNo: undefined },
      { ...LFM(), prNo: null },
      { ...LFM(), prTitle: undefined },
      { ...LFM(), prTitle: null },
    ];
    for (const b of waiting) validateReport(mkReport({ 'roost-cc/tools': [b] }));
    assert.deepEqual(
      openBranches(mkReport({ 'roost-cc/tools': waiting })).map((b) => [b.prNo, b.prTitle]),
      [
        [36, 'renovate/lock-file-maintenance'],
        [36, 'renovate/lock-file-maintenance'],
      ],
    );
  } finally {
    t.cleanup();
  }
});

test('a repo absent from the report leaves its stories as they are', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const { res } = await run(t, mkReport({ 'roost-cc/app.acme.com': [KOA()] }));
    assert.deepEqual(res.closed, []);
    assert.deepEqual(res.unchanged.sort(), ['S-1', 'S-2', 'S-3']);
    assert.equal(stories(t).get('S-1').fm.status, 'refined');
  } finally {
    t.cleanup();
  }
});

test('a story whose repo left backlog.json is skipped, not closed, while its branch is open', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const cfgPath = join(t.dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    delete raw.repos.bl;
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');

    const { res, lines } = await run(t, FULL());
    assert.deepEqual(res.closed, []);
    assert.deepEqual(res.created, []);
    assert.ok(res.skippedRepos.includes('roost-cc/bl'));
    assert.equal(stories(t).get('S-3').fm.status, 'refined');
    assert.ok(!lines.some((l) => /S-3/.test(l)), "nothing printed for a skipped repo's story");

    // Once the branch leaves the report, the story closes as any other.
    const gone = mkReport({
      'roost-cc/tools': [LFM(), PRETTIER_PENDING],
      'roost-cc/app.acme.com': [KOA()],
      'roost-cc/bl': [],
    });
    const after = await run(t, gone);
    assert.deepEqual(after.res.closed, ['S-3']);
  } finally {
    t.cleanup();
  }
});

test('a closed story with the same PR is not recreated; a new PR for the branch gets a new story', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    rewrite(stories(t).get('S-1'), (fm) => {
      fm.status = 'superseded';
      fm.completed = '2026-10-14';
    });
    const same = await run(t, FULL());
    assert.deepEqual(same.res.created, []);
    assert.ok(same.res.unchanged.includes('S-1'));

    const reopened = mkReport({
      'roost-cc/tools': [LFM(99)],
      'roost-cc/app.acme.com': [KOA()],
      'roost-cc/bl': [VITEST],
    });
    const { res } = await run(t, reopened);
    assert.deepEqual(res.created, ['S-4']);
    const s4 = stories(t).get('S-4');
    assert.equal(s4.fm.update_pr, '99');
    assert.equal(s4.fm.update_branch, 'renovate/lock-file-maintenance');
  } finally {
    t.cleanup();
  }
});

test('a missing report exits early with nothing created', async () => {
  const t = setup();
  try {
    const lines = [];
    const res = await syncUpdates(t.config(), {
      reportPath: join(t.dir, 'missing.json'),
      out: (l) => lines.push(l),
    });
    assert.equal(res.noReport, true);
    assert.deepEqual(res.created, []);
    assert.deepEqual(lines, []);
    assert.equal(stories(t).size, 0);
    assert.ok(!existsSync(join(t.dir, '.bl-new.lock')));
  } finally {
    t.cleanup();
  }
});

/** Set (or, with undefined, remove) backlog.json `updates.report`. */
function setReportKey(t, value) {
  const cfgPath = join(t.dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  if (value === undefined) delete raw.updates.report;
  else raw.updates.report = value;
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
}

test("the report path is backlog.json updates.report, relative to the backlog's parent directory", async () => {
  const t = setup();
  try {
    // The fixture's roostDir is the backlog's parent, so this names t.reportPath.
    setReportKey(t, `${basename(t.dir)}/report.json`);
    const cfg = t.config();
    assert.equal(configuredReportPath(cfg), join(cfg.roostDir, basename(t.dir), 'report.json'));
    assert.equal(configuredReportPath(cfg), t.reportPath);

    // syncUpdates with no reportPath reads it.
    writeFileSync(t.reportPath, JSON.stringify(mkReport({ 'roost-cc/tools': [LFM()] })));
    const res = await syncUpdates(cfg, {
      today: '2026-10-14',
      listHeads: () => HEADS(),
      lookupPr: () => ({ url: 'https://forge/pr', security: false }),
      out: () => {},
    });
    assert.deepEqual(res.created, ['S-1']);
  } finally {
    t.cleanup();
  }
});

test('with updates.report unset or absolute, sync refuses naming the key; --report still overrides', async () => {
  const t = setup();
  try {
    for (const value of [undefined, '', '/abs/renovate-report.json']) {
      setReportKey(t, value);
      assert.throws(() => configuredReportPath(t.config()), /backlog\.json has no "updates": \{ "report": "<path>" \}/);
      await assert.rejects(syncUpdates(t.config(), { out: () => {} }), /"updates": \{ "report": "<path>" \}/);
    }
    assert.equal(stories(t).size, 0, 'a refused sync changes nothing');
    const { res } = await run(t, mkReport({ 'roost-cc/tools': [LFM()] }));
    assert.deepEqual(res.created, ['S-1']);
  } finally {
    t.cleanup();
  }
});

test("a vulnerability alert, or the PR's security label, sets update_security", async () => {
  const t = setup();
  try {
    const report = mkReport({
      'roost-cc/tools': [LFM()],
      'roost-cc/app.acme.com': [KOA({ isVulnerabilityAlert: true })],
      'roost-cc/bl': [VITEST],
    });
    const asked = [];
    const { res } = await run(t, report, {
      lookupPr: (_cfg, _repoPath, branch) => {
        asked.push(branch);
        return { url: null, security: branch === 'renovate/vitest-4.x' };
      },
    });
    assert.deepEqual(res.created, ['S-1', 'S-2', 'S-3']);
    // The forge is asked only when the report does not say so itself.
    assert.deepEqual(asked, ['renovate/lock-file-maintenance', 'renovate/vitest-4.x']);
    const all = stories(t);
    assert.equal(all.get('S-1').fm.update_security, undefined);
    assert.equal(all.get('S-2').fm.update_security, 'true');
    assert.match(extractSection(all.get('S-2').body, 'Summary'), /Security update/);
    assert.match(extractSection(all.get('S-2').body, 'Summary'), /PR #320,/);
    assert.equal(all.get('S-3').fm.update_security, 'true');

    // The flag stays on a later sync; the forge is not asked again.
    asked.length = 0;
    const again = await run(t, report, {
      lookupPr: (_c, _r, branch) => {
        asked.push(branch);
        return { url: null, security: false };
      },
    });
    assert.deepEqual(again.res.updated, []);
    assert.deepEqual(asked, []);
    assert.equal(stories(t).get('S-3').fm.update_security, 'true');
  } finally {
    t.cleanup();
  }
});

test('dry-run prints the plan and writes nothing', async () => {
  const t = setup();
  try {
    const { res, lines } = await run(t, FULL(), { dryRun: true });
    assert.deepEqual(res.created, ['S-1', 'S-2', 'S-3']);
    assert.equal(lines.length, 3);
    assert.equal(res.commit, null);
    assert.equal(stories(t).size, 0);
  } finally {
    t.cleanup();
  }
});

test('sync skips a repo with no home component and never reads updates.epic (F-49 D4)', async () => {
  const t = setup();
  try {
    const cfgPath = join(t.dir, 'backlog.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
    // A stale updates.epic naming nothing is ignored, not an error.
    raw.updates.epic = 'E45';
    writeFileSync(cfgPath, JSON.stringify(raw));
    const toolsHome = join(t.dir, 'components', 'C31-tools', 'index.md');
    writeFileSync(toolsHome, readFileSync(toolsHome, 'utf8').replace('home: true\n', ''));
    const { res } = await run(t, FULL());
    assert.deepEqual(res.skippedRepos, ['roost-cc/tools', 'roost-cc/unknown']);
    const all = stories(t);
    assert.ok(
      [...all.values()].every((s) => s.unitRepo !== 'tools'),
      'no tools story',
    );
    assert.ok(
      [...all.values()].some((s) => s.fm.component === 'C32'),
      "bl's stories still filed",
    );
  } finally {
    t.cleanup();
  }
});

test('a status write overlapping a token write in another process keeps both (F-67)', async () => {
  const t = setup();
  try {
    await run(t, FULL());
    const lfm = stories(t).get('S-1');
    // The token writer has read S-1, and holds its lock, as the next sync
    // closes it.
    const writer = startTokenWriter(t.dir, lfm.indexPath, 'implement');
    const next = mkReport({
      'roost-cc/tools': [LFM(null), PRETTIER_PENDING],
      'roost-cc/app.acme.com': [KOA()],
      'roost-cc/bl': [VITEST],
    });
    const { res } = await run(t, next);
    assert.deepEqual(res.closed, ['S-1']);
    assert.equal(await writer.done, 0);
    const after = stories(t).get('S-1');
    assert.equal(after.fm.status, 'superseded', 'the status write is kept');
    assert.match(extractSection(after.body, 'Summary'), new RegExp(GONE_NOTE));
    assert.equal(after.fm.tokens_by_step?.implement?.input, '7', 'the step entry is kept');
  } finally {
    t.cleanup();
  }
});
