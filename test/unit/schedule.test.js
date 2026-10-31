import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { resolveTargets } from '../../src/targets.js';
import { schedule, dependencyOrder, planFiles, branchFiles, unitFiles } from '../../src/schedule.js';
import { reposForFeature } from '../../src/feature.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

const plan = (...lines) => `## Summary\n\nx\n\n## Implementation Plan\n\n${lines.join('\n')}\n`;
const story = (id, extra = {}) => ({
  id,
  epic: 'E01',
  epicDirSuffix: 'one',
  title: `story ${id}`,
  dirSuffix: id.toLowerCase(),
  status: 'refined',
  ...extra,
});

function fixture() {
  return mkTempBacklog({
    // A story's repo is its component's (F-52 D1).
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories: [
      story('S-1', { body: plan('1. `src/a.js`: add it') }),
      story('S-2', { depends_on: ['S-1'], body: plan('1. `src/b.js`') }),
      story('S-3', { depends_on: ['S-9'] }),
      story('S-4', { depends_on: ['S-10'] }),
      story('S-5', { depends_on: ['S-8'] }),
      story('S-8', { status: 'done' }),
      story('S-9', { status: 'backlog' }),
      story('S-10', {
        feature: 'F-1',
        depends_on: ['S-11'],
        body: plan('- `src/x.js` and `test/unit/x.test.js` (~12)'),
      }),
      story('S-11', { feature: 'F-1', body: plan('- `./src/y.js`, `bl run`, `.bl/run/<id>.out`, src/not-seen.js') }),
      story('S-12', { feature: 'F-2', depends_on: ['S-1'] }),
    ],
    features: [
      { id: 'F-1', title: 'One', dirSuffix: 'one', status: 'approved', primary_repo: 'bl', stories: ['S-10', 'S-11'] },
      { id: 'F-2', title: 'Two', dirSuffix: 'two', status: 'approved', primary_repo: 'bl', stories: ['S-12'] },
    ],
  });
}

function withBacklog(fn) {
  const { dir, cleanup } = fixture();
  try {
    const config = loadConfig({ backlogRoot: dir });
    const all = readAllStories(config);
    const units = (...ids) => resolveTargets(ids, config, null).targets;
    fn({ config, all, units });
  } finally {
    cleanup();
  }
}

const noFiles = () => new Set();

test('a dependency that is done does not hold back its dependent, even when it is a target', () => {
  withBacklog(({ config, all, units }) => {
    const { start, deferred } = schedule(units('S-5', 'S-8'), all, { config, files: noFiles });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-5', 'S-8'],
    );
    assert.deepEqual(deferred, []);
  });
});

test('a target that depends on another target waits for it to merge', () => {
  withBacklog(({ config, all, units }) => {
    const { start, deferred } = schedule(units('S-2', 'S-1'), all, { config, files: noFiles });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-1'],
    );
    assert.deepEqual(deferred, [
      { id: 'S-2', kind: 'story', reason: 'S-2 depends on S-1; run it after S-1 merges', blockers: ['S-1'] },
    ]);
  });
});

test('a dependency outside the targets blocks until it is done', () => {
  withBacklog(({ config, all, units }) => {
    const { start, deferred } = schedule(units('S-3', 'S-5'), all, { config, files: noFiles });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-5'],
      "S-5's dependency S-8 is done",
    );
    assert.equal(deferred[0].reason, 'S-3 depends on S-9, which is backlog; merge S-9 first');
    assert.deepEqual(deferred[0].blockers, ['S-9']);
  });
});

test("a feature's stories carry its dependencies, both ways", () => {
  withBacklog(({ config, all, units }) => {
    // F-2's S-12 depends on target S-1; S-4 depends on S-10, inside target F-1.
    // S-10 → S-11 stays inside F-1 and blocks nothing.
    const { start, deferred } = schedule(units('F-2', 'S-1', 'S-4', 'F-1'), all, { config, files: noFiles });
    assert.deepEqual(start.map((u) => u.id).sort(), ['F-1', 'S-1']);
    assert.deepEqual(
      deferred.map((d) => d.reason),
      ['F-2: S-12 depends on S-1; run it after S-1 merges', 'S-4 depends on S-10 (in F-1); run it after F-1 merges'],
    );
  });
});

test('overlapping targets: the lowest id starts, the rest wait naming the shared files', () => {
  withBacklog(({ config, all, units }) => {
    const files = {
      'S-1': ['bl:src/x.js', 'bl:src/a.js'],
      'S-3': ['bl:src/other.js'],
      'S-5': ['bl:src/x.js', 'bl:src/z.js'],
      'F-1': ['bl:src/z.js'],
    };
    const outside = all.map((s) => (s.id === 'S-9' ? { ...s, status: 'done' } : s));
    const { start, deferred } = schedule(units('S-5', 'S-3', 'S-1', 'F-1'), outside, {
      config,
      files: (u) => new Set(files[u.id]),
    });
    // F-1 sorts before S-1: a feature first at the same number.
    assert.deepEqual(
      start.map((u) => u.id),
      ['F-1', 'S-1', 'S-3'],
    );
    assert.deepEqual(deferred, [
      {
        id: 'S-5',
        kind: 'story',
        reason: 'S-5 overlaps F-1 on src/z.js and S-1 on src/x.js; run it after F-1 and S-1 merge',
        blockers: ['F-1', 'S-1'],
      },
    ]);
  });
});

test('a target overlapping only a waiting target starts', () => {
  withBacklog(({ config, all, units }) => {
    // S-2 waits on its dependency S-1; S-5 shares a file with S-2 only.
    const files = { 'S-1': ['bl:src/a.js'], 'S-2': ['bl:src/b.js'], 'S-5': ['bl:src/b.js'] };
    const { start, deferred } = schedule(units('S-2', 'S-1', 'S-5'), all, {
      config,
      files: (u) => new Set(files[u.id]),
    });
    assert.deepEqual(
      start.map((u) => u.id),
      ['S-1', 'S-5'],
    );
    assert.deepEqual(
      deferred.map((d) => d.id),
      ['S-2'],
    );
  });
});

test('shared files in several repos keep their repo names', () => {
  withBacklog(({ config, all, units }) => {
    const files = { 'S-1': ['bl:a.js', 'tools:b.js'], 'S-5': ['bl:a.js', 'tools:b.js'] };
    const { deferred } = schedule(units('S-1', 'S-5'), all, { config, files: (u) => new Set(files[u.id]) });
    assert.equal(deferred[0].reason, 'S-5 overlaps S-1 on bl:a.js, tools:b.js; run it after S-1 merges');
  });
});

test('planFiles reads backticked paths from the Implementation Plan, keyed by repo', () => {
  withBacklog(({ all }) => {
    const byId = (id) => all.find((s) => s.id === id);
    assert.deepEqual([...planFiles([byId('S-11')])], ['bl:src/y.js'], 'not commands, templated paths or bare text');
    assert.deepEqual([...planFiles([byId('S-10')])].sort(), ['bl:src/x.js', 'bl:test/unit/x.test.js']);
    assert.deepEqual([...planFiles([byId('S-3')])], [], 'no plan section');
  });
});

test("unitFiles: with no branch commits, a feature's files are its stories' plan paths together", () => {
  withBacklog(({ config, all, units }) => {
    const [f1, s1] = units('F-1', 'S-1');
    assert.deepEqual([...unitFiles(f1, config, all)].sort(), ['bl:src/x.js', 'bl:src/y.js', 'bl:test/unit/x.test.js']);
    assert.deepEqual([...unitFiles(s1, config, all)], ['bl:src/a.js']);
  });
});

test("branchFiles lists what a worktree's branch changes against main", () => {
  const root = mkTempDir('bl-schedule-git-');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 's1-x', wt);
    assert.deepEqual(
      branchFiles([{ repoName: 'bl', worktreePath: wt }]),
      { files: new Set(), complete: true },
      'no commits yet',
    );
    mkdirSync(join(wt, 'src'));
    writeFileSync(join(wt, 'src', 'new.js'), 'x\n');
    git(wt, 'add', '.');
    git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add');
    assert.deepEqual(branchFiles([{ repoName: 'bl', worktreePath: wt }]), {
      files: new Set(['bl:src/new.js']),
      complete: true,
    });
    assert.deepEqual(
      branchFiles([
        { repoName: 'bl', worktreePath: wt },
        { repoName: 'gone', worktreePath: join(root, 'nope') },
      ]),
      { files: new Set(['bl:src/new.js']), complete: false },
      'a missing worktree makes the read partial',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unitFiles does not schedule from a partial multi-repository branch diff', () => {
  const root = mkTempDir('bl-schedule-partial-');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, msg) =>
    git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg);
  // Repo `a` holds the branch's commit; the story's plan names `b:shared.js`.
  const states = {
    changed: (wt) => {
      git(wt, 'init', '-q', '-b', 'main');
      commit(wt, 'init');
      git(wt, 'checkout', '-q', '-b', 'f1-x');
      writeFileSync(join(wt, 'a.js'), 'x\n');
      git(wt, 'add', '.');
      commit(wt, 'work');
    },
    empty: (wt) => {
      git(wt, 'init', '-q', '-b', 'main');
      commit(wt, 'init');
      git(wt, 'checkout', '-q', '-b', 'f1-x');
    },
    missing: null,
    'diff fails': () => {},
  };
  const rows = [
    { a: 'changed', b: 'empty', complete: true, want: ['a:a.js'] },
    { a: 'empty', b: 'empty', complete: true, want: ['b:shared.js'] },
    { a: 'changed', b: 'missing', complete: false, want: ['a:a.js', 'b:shared.js'] },
    { a: 'changed', b: 'diff fails', complete: false, want: ['a:a.js', 'b:shared.js'] },
    { a: 'missing', b: 'diff fails', complete: false, want: ['b:shared.js'] },
  ];
  try {
    rows.forEach((row, i) => {
      const base = join(root, String(i));
      for (const name of ['a', 'b']) {
        if (states[row[name]] === null) continue;
        const wt = join(base, 'f1-x', name);
        mkdirSync(wt, { recursive: true });
        states[row[name]](wt);
      }
      const indexPath = join(base, 'S1.md');
      writeFileSync(indexPath, `---\nstory_id: S-1\n---\n${plan('1. `shared.js`')}`);
      const indexA = join(base, 'S0.md');
      writeFileSync(indexA, '---\nstory_id: S-0\n---\n');
      const config = { backlogRoot: base, raw: { worktrees: base }, reposByName: { a: 'a', b: 'b' } };
      // F-1 touches a and b because its stories' components are there (F-52 D3), not through a field on the feature.
      const all = [
        { id: 'S-0', feature: 'F-1', status: 'refined', unitRepo: 'a', indexPath: indexA },
        { id: 'S-1', feature: 'F-1', status: 'refined', unitRepo: 'b', indexPath },
      ];
      const record = { id: 'F-1', featureEntry: 'F1-x', stories: ['S-0', 'S-1'] };
      const f1 = { kind: 'feature', id: 'F-1', record };
      const label = `a ${row.a}, b ${row.b}`;
      assert.equal(branchFiles(reposForFeature(record, config, all)).complete, row.complete, label);
      assert.deepEqual([...unitFiles(f1, config, all)].sort(), row.want, label);
      if (row.complete) return;
      // A target planning b:shared.js waits for F-1 even though F-1's readable diff never names it.
      const s2 = { kind: 'story', id: 'S-2', record: { id: 'S-2', status: 'refined' } };
      const { start, deferred } = schedule([f1, s2], [...all, s2.record], {
        files: (u) => (u === f1 ? unitFiles(f1, config, all) : new Set(['b:shared.js'])),
      });
      assert.deepEqual(
        start.map((u) => u.id),
        ['F-1'],
        label,
      );
      assert.deepEqual(
        deferred.map((d) => d.id),
        ['S-2'],
        label,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dependencyOrder puts a target after the targets it depends on', () => {
  withBacklog(({ config, all, units }) => {
    assert.deepEqual(
      dependencyOrder(units('S-2', 'S-5', 'S-1'), all, { config }).map((u) => u.id),
      ['S-1', 'S-2', 'S-5'],
    );
    // S-4 depends on S-10 in F-1; F-2 on S-1.
    assert.deepEqual(
      dependencyOrder(units('S-4', 'F-2', 'F-1', 'S-1'), all, { config }).map((u) => u.id),
      ['F-1', 'S-1', 'F-2', 'S-4'],
    );
  });
});

// Every class of span a plan may backtick: kept (as git prints it) or dropped.
const PATH_CASES = [
  ['src/plain.js', 'src/plain.js', 'plain'],
  ['src/with space.js', 'src/with space.js', 'whitespace in a name'],
  ["src/name+variant (copy), #2 & 'q'.js", "src/name+variant (copy), #2 & 'q'.js", 'punctuation'],
  ['src/file..js', 'src/file..js', '`..` inside a name is not traversal'],
  ['src/..hidden/a.js', 'src/..hidden/a.js', '`..` starting a name'],
  ['docs/café/naïve.md', 'docs/café/naïve.md', 'Unicode names'],
  ['README.été', 'README.été', 'Unicode extension, no slash'],
  ['  src/padded.js  ', 'src/padded.js', 'whitespace around the path inside backticks'],
  ['./src/dot.js', 'src/dot.js', 'leading ./'],
  ['src/dir/', 'src/dir', 'directory, trailing slash'],
  ['src/dir', 'src/dir', 'directory, no slash'],
  ['lib/', 'lib', 'top-level directory, trailing slash'],
  ['Makefile.am', 'Makefile.am', 'top-level file with an extension'],
  ['../outside.js', null, 'parent traversal'],
  ['src/../x.js', null, 'parent traversal mid-path'],
  ['src/./x.js', null, '`.` segment'],
  ['src//x.js', null, 'empty segment'],
  ['/etc/passwd', null, 'absolute'],
  ['bl run', null, 'a command'],
  ['Makefile', null, 'no slash and no extension'],
  ['.bl/run/<id>.out', null, 'template'],
  ['src/{a,b}.js', null, 'brace expansion'],
  ['src/*.js', null, 'glob'],
  ['$HOME/x.js', null, 'variable'],
  ['', null, 'empty'],
];

test('planFiles skips paths under ### Sources of truth and keeps those after it', () => {
  const sources = '### Sources of truth\n\n- Statuses: `src/flow.js`, read through `src/read-only.js`.\n';
  const bodies = {
    'S-1': plan('`src/before.js`', '', sources, '### Steps', '', '1. `src/after.js`'),
    'S-2': plan(sources),
    'S-3': plan(
      '`src/before.js`',
      '',
      sources.replace('\n\n', ' \r\n\r\n'),
      '#### Detail',
      '`src/deep.js`',
      '',
      '## Next',
    ),
  };
  const { dir, cleanup } = mkTempBacklog({
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories: Object.entries(bodies).map(([id, body]) => story(id, { body })),
  });
  try {
    const stories = readAllStories(loadConfig({ backlogRoot: dir }));
    const files = (id) => [...planFiles([stories.find((s) => s.id === id)])].sort();
    assert.deepEqual(files('S-1'), ['bl:src/after.js', 'bl:src/before.js']);
    assert.deepEqual(files('S-2'), []);
    assert.deepEqual(files('S-3'), ['bl:src/before.js']);
  } finally {
    cleanup();
  }
});

const READ = '- Read `src/read-only.js`.';
const AFTER = '1. Change `src/after.js`.';
const HEADING_FORMS = [
  ['plain', ['### Sources of truth', READ, '### Steps', AFTER]],
  ['closing hashes', ['### Sources of truth ###', READ, '### Steps ###', AFTER]],
  ['closing hashes of another length', ['### Sources of truth #', READ, '### Steps ##########', AFTER]],
  ['tab after the marker', ['###\tSources of truth', READ, '###\tSteps', AFTER]],
  ['several spaces', ['###   Sources of truth   ', READ, '###   Steps', AFTER]],
  ['up to three leading spaces', ['   ### Sources of truth', 'Read `src/read-only.js`.', '  ### Steps', AFTER]],
  ['next heading level one', ['### Sources of truth', READ, '# Steps', AFTER]],
  ['next heading setext', ['### Sources of truth', READ, 'Steps\n---', AFTER]],
  ['an empty next heading', ['### Sources of truth', READ, '###', AFTER]],
  ['a twin section', ['### Sources of truth', READ, '### Sources of truth', READ, '### Steps', AFTER]],
  ['a deeper heading stays inside', ['### Sources of truth', '#### Detail', READ, '### Steps', AFTER]],
  ['a fenced heading stays inside', ['### Sources of truth', '```\n### Steps\n```', READ, '### Steps', AFTER]],
];
const NOT_THE_HEADING = [
  ['seven hashes', '####### Sources of truth'],
  ['no space after the marker', '###Sources of truth'],
  ['another level', '#### Sources of truth'],
  ['longer text', '### Sources of truth and more'],
  ['an escaped marker', String.raw`\### Sources of truth`],
  ['another title in bold', '### **Sources of truth and more**'],
  ['another title after a comment', '### Sources <!-- of truth --> of lies'],
];

const FORMATTED_TITLES = [
  ['bold', '**Sources of truth**'],
  ['bold with underscores', '__Sources of truth__'],
  ['emphasis', '*Sources of truth*'],
  ['partial emphasis', 'Sources of *truth*'],
  ['partial bold', '**Sources** of truth'],
  ['nested emphasis', '***Sources*** of _truth_'],
  ['a link', '[Sources of truth](docs/guide.md)'],
  ['a partial link', 'Sources of [truth](docs/guide.md)'],
  ['a reference link', '[Sources of truth][guide]'],
  ['inline code', '`Sources of truth`'],
  ['partial inline code', 'Sources of `truth`'],
  ['an image', '![Sources of truth](truth.png)'],
  ['inline HTML', '<b>Sources of truth</b>'],
  ['a trailing HTML comment', 'Sources of truth <!-- note -->'],
  ['a leading HTML comment', '<!-- note --> Sources of truth'],
  ['an HTML comment inside', 'Sources <!-- note --> of truth'],
  ['a character reference', 'Sources&#32;of truth'],
  ['closing hashes', '**Sources of truth** ###'],
];

test('planFiles_skips_formatted_sources_of_truth_headings', () => {
  const REF = '[guide]: docs/guide.md';
  const twin = '### Other\n\n1. Change `src/twin-after.js`.\n\n### *Sources* of truth\n\n- Read `src/twin.js`.';
  const stories = FORMATTED_TITLES.flatMap(([, title], i) => [
    story(`S-${i + 1}`, { body: plan(`### ${title}`, '', READ, '', '### Steps', '', AFTER, '', REF) }),
    // The next heading ends the section whatever its own formatting.
    story(`S-${i + 101}`, { body: plan(`### ${title}`, '', READ, '', '# **Next**', '', AFTER, '', REF) }),
    story(`S-${i + 201}`, { body: plan(`### ${title}`, '', READ, '', '### [Steps](a.md)', '', AFTER, '', REF) }),
    story(`S-${i + 301}`, { body: plan(`### ${title}`, '', READ, '', twin, '', '### `Steps`', '', AFTER, '', REF) }),
  ]);
  const { dir, cleanup } = mkTempBacklog({
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories,
  });
  try {
    const all = readAllStories(loadConfig({ backlogRoot: dir }));
    const files = (id) => [...planFiles([all.find((s) => s.id === id)])].sort();
    FORMATTED_TITLES.forEach(([name], i) => {
      assert.deepEqual(files(`S-${i + 1}`), ['bl:src/after.js'], name);
      assert.deepEqual(files(`S-${i + 101}`), ['bl:src/after.js'], `${name}, level-one next heading`);
      assert.deepEqual(files(`S-${i + 201}`), ['bl:src/after.js'], `${name}, linked next heading`);
      assert.deepEqual(files(`S-${i + 301}`), ['bl:src/after.js', 'bl:src/twin-after.js'], `${name}, repeated`);
    });
  } finally {
    cleanup();
  }
});

test('planFiles_handles_valid_atx_heading_forms_and_next_sections', () => {
  const stories = [
    ...HEADING_FORMS.map(([, lines], i) => story(`S-${i + 1}`, { body: plan(...lines.join('\n\n').split('\n')) })),
    ...NOT_THE_HEADING.map(([, heading], i) => story(`S-${i + 101}`, { body: plan(heading, '', READ) })),
  ];
  const { dir, cleanup } = mkTempBacklog({
    epics: [{ id: 'E01', projectId: 'demo', title: 'One', dirSuffix: 'one', repo: 'bl' }],
    stories,
  });
  try {
    const all = readAllStories(loadConfig({ backlogRoot: dir }));
    const files = (id) => [...planFiles([all.find((s) => s.id === id)])];
    HEADING_FORMS.forEach(([name], i) => assert.deepEqual(files(`S-${i + 1}`), ['bl:src/after.js'], name));
    NOT_THE_HEADING.forEach(([name], i) => assert.deepEqual(files(`S-${i + 101}`), ['bl:src/read-only.js'], name));
  } finally {
    cleanup();
  }
});

test('planFiles preserves valid repository paths with spaces and punctuation and schedule defers their overlaps', () => {
  const root = mkTempDir('bl-schedule-paths-');
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    const make = (id, spans) => {
      const indexPath = join(root, `${id}.md`);
      writeFileSync(indexPath, `---\nstory_id: ${id}\n---\n\n${plan(...spans.map((s) => `- edit \`${s}\``))}`);
      return { id, indexPath, unitRepo: 'bl', status: 'refined', depends_on: '' };
    };
    for (const [span, want, why] of PATH_CASES) {
      assert.deepEqual(
        [...planFiles([make('S-1', [span])])],
        want === null ? [] : [`bl:${want}`],
        `${why}: \`${span}\``,
      );
    }

    // Each kept path, named by two targets, defers the later one; the union
    // over a feature's stories (`unitStories` → `planFiles`) keeps it too.
    const kept = PATH_CASES.filter(([, want]) => want !== null);
    for (const [span, want, why] of kept) {
      const a = make('S-1', ['src/unrelated.js', span]);
      const b = make('S-2', [span.trim()]);
      const units = [a, b].map((record) => ({ kind: 'story', id: record.id, record }));
      const { start, deferred } = schedule(units, [a, b], { files: (u) => planFiles([u.record]) });
      assert.deepEqual(
        start.map((u) => u.id),
        ['S-1'],
        why,
      );
      assert.equal(deferred[0]?.reason, `S-2 overlaps S-1 on ${want}; run it after S-1 merges`, why);
      assert.ok(planFiles([make('S-3', ['src/other.js']), a]).has(`bl:${want}`), `feature union: ${why}`);
    }

    // A directory in one plan overlaps a file under it in another.
    const dir = make('S-1', ['src/dir/']);
    const file = make('S-2', ['src/dir/inner.js']);
    const { deferred } = schedule(
      [dir, file].map((record) => ({ kind: 'story', id: record.id, record })),
      [dir, file],
      { files: (u) => planFiles([u.record]) },
    );
    assert.deepEqual(
      deferred.map((d) => d.id),
      ['S-2'],
      'directory holds the file',
    );

    // The kept file paths read the same as `git diff --name-only` prints them.
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'checkout', '-q', '-b', 's1');
    const files = kept.map(([, want]) => want).filter((p) => !p.startsWith('src/dir') && p !== 'lib');
    for (const p of files) {
      mkdirSync(join(repo, p, '..'), { recursive: true });
      writeFileSync(join(repo, p), 'x\n');
    }
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add');
    const fromPlan = planFiles([
      make(
        'S-1',
        kept.map(([span]) => span),
      ),
    ]);
    for (const key of branchFiles([{ repoName: 'bl', worktreePath: repo }]).files) {
      assert.ok(fromPlan.has(key), `git's ${key} is a plan path`);
    }
    assert.equal(branchFiles([{ repoName: 'bl', worktreePath: repo }]).files.size, new Set(files).size);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
