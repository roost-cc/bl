/**
 * Unit tests for F-78 D3 and F-113 D1: `bl rank`'s list edit
 * (`src/rank-cmd.js`), the BL_HEADLESS marker every headless agent spawn
 * carries (`agentEnv`, each adapter's `spawn`), and `commitPaths`' refusal of
 * `priority.yaml` under it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { applyRank, checkUnit, rankedIds, removeClosed, RankFileError } from '../../src/rank-cmd.js';
import { HEADLESS_ENV, agentEnv, isHeadless } from '../../src/agents/provider.js';
import { ClaudeProvider } from '../../src/agents/claude.js';
import { CodexProvider } from '../../src/agents/codex.js';
import { GeminiProvider } from '../../src/agents/gemini.js';
import { commandPullsBacklog, commitPaths, headlessPriorityRefusal } from '../../src/backlog-commit.js';
import { loadBacklog } from '../../src/backlog-graph.js';
import { STORY_INDEX_TEMPLATE, mkTempBacklog } from '../helpers/tempdir.js';
import { git, initGitBacklog } from '../helpers/git-backlog.js';

/** A priority.yaml written by hand: a comment, a lower-case id, a flow-free block list. */
const HAND = `# Ranked by hand.
- S-1
- f2 # the big one
- F-3
`;

/** The list `ids` as bl rank writes it. */
const list = (...ids) => ids.map((id) => `- ${id}\n`).join('');

/** Run `fn` with `process.env.BL_HEADLESS` set to `value` (undefined: unset), then put it back. */
async function withMarker(value, fn) {
  const saved = process.env[HEADLESS_ENV];
  if (value === undefined) delete process.env[HEADLESS_ENV];
  else process.env[HEADLESS_ENV] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[HEADLESS_ENV];
    else process.env[HEADLESS_ENV] = saved;
  }
}

test('applyRank moves an id and writes the whole list with stringify', () => {
  assert.equal(applyRank(HAND, { id: 'F-3', where: 'top' }), list('F-3', 'S-1', 'F-2'));
  assert.equal(applyRank(HAND, { id: 'S-1', where: { after: 'F-2' } }), list('F-2', 'S-1', 'F-3'));
  assert.equal(applyRank(HAND, { id: 'S-1', where: 'bottom' }), list('F-2', 'F-3', 'S-1'));
  assert.equal(applyRank(HAND, { id: 'F-3', where: { before: 'F-2' } }), list('S-1', 'F-3', 'F-2'));
  // Where it already is: nothing changes, not even the comment.
  assert.equal(applyRank(HAND, { id: 'S-1', where: 'top' }), HAND);
  assert.equal(applyRank(HAND, { id: 'F-2', where: { after: 'S-1' } }), HAND);
});

test('applyRank adds a new id; into an empty list too', () => {
  assert.equal(applyRank(HAND, { id: 'S-9', where: { before: 'F-2' } }), list('S-1', 'S-9', 'F-2', 'F-3'));
  assert.equal(applyRank(HAND, { id: 'F-4', where: 'bottom' }), list('S-1', 'F-2', 'F-3', 'F-4'));
  for (const empty of ['[]\n', '', '# nothing yet\n']) {
    assert.equal(applyRank(empty, { id: 'F-1', where: 'top' }), list('F-1'), JSON.stringify(empty));
  }
  assert.throws(() => applyRank(HAND, { id: 'F-4', where: { after: 'F-9' } }), /F-9 is not ranked/);
});

test('applyRank removes an id; the last one leaves []', () => {
  assert.equal(applyRank(HAND, { id: 'F-2', remove: true }), list('S-1', 'F-3'));
  assert.equal(applyRank(list('F-1'), { id: 'F-1', remove: true }), '[]\n');
  assert.throws(() => applyRank(HAND, { id: 'F-9', remove: true }), /F-9 is not ranked/);
});

test('removeClosed takes out every entry of the ids given; none listed leaves the text as it is', () => {
  assert.equal(removeClosed(HAND, ['F-2', 'S-1']), list('F-3'));
  assert.equal(removeClosed(`${HAND}- S-1\n`, ['S-1']), list('F-2', 'F-3'));
  assert.equal(removeClosed(HAND, ['S-1', 'F-2', 'F-3']), '[]\n');
  assert.equal(removeClosed(HAND, []), HAND);
  assert.equal(removeClosed(HAND, ['F-9']), HAND);
});

test('rankedIds reads the ids as written, canonical; a file bl rank cannot edit is a RankFileError', () => {
  assert.deepEqual(rankedIds(HAND), ['S-1', 'F-2', 'F-3']);
  assert.deepEqual(rankedIds('[f3, s1]\n'), ['F-3', 'S-1']);
  assert.deepEqual(rankedIds(''), []);
  for (const [bad, reason] of [
    ['- [\n', /priority\.yaml is not YAML/],
    ['ranked: x\n', /the file is not a YAML list of work unit ids/],
    ['- unit: F-1\n  why: x\n', /entry 1 is not a work unit id/],
    ['- F-1\n- 7\n', /entry 2 is not a work unit id/],
  ]) {
    assert.throws(
      () => rankedIds(bad),
      (e) => e instanceof RankFileError && reason.test(e.message),
      bad,
    );
    for (const op of [
      { id: 'F-1', where: 'top' },
      { id: 'F-1', remove: true },
    ]) {
      assert.throws(() => applyRank(bad, op), RankFileError, `${JSON.stringify(op)}: ${bad}`);
    }
  }
});

test('checkUnit takes an open feature or loose story and refuses everything else, naming why', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'Loose' },
      { id: 'S-2', component: 'C01', title: 'Closed', status: 'done' },
      { id: 'S-11', component: 'C01', title: 'Inside', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'One', status: 'approved' }],
  });
  // An update story, as `bl updates` writes one: no feature, an `update_repo:`.
  mkdirSync(join(dir, 'stories', 'S12-update'), { recursive: true });
  writeFileSync(
    join(dir, 'stories', 'S12-update', 'index.md'),
    STORY_INDEX_TEMPLATE({ id: 'S-12', component: 'C01', title: 'Update' }).replace(
      'status: draft\n',
      'status: draft\nupdate_repo: bl\n',
    ),
  );
  const graph = loadBacklog({ backlogRoot: dir });
  assert.match(checkUnit(graph, 'S-12').refused, /S-12 is an update story; update stories are never ranked/);
  assert.deepEqual(checkUnit(graph, 'F-1'), { id: 'F-1' });
  assert.deepEqual(checkUnit(graph, 's1'), { id: 'S-1' });
  assert.match(checkUnit(graph, 'S-11').refused, /S-11 is a story inside F-1; the feature is the unit: rank F-1/);
  assert.match(checkUnit(graph, 'S-2').refused, /S-2 is done; only open units are ranked/);
  assert.match(checkUnit(graph, 'T-4').refused, /T-4 is a task/);
  assert.match(checkUnit(graph, 'S-99').refused, /S-99 names no story/);
  assert.match(checkUnit(graph, 'F-9').refused, /F-9 names no feature/);
  assert.match(checkUnit(graph, 'C01').refused, /not a feature \(F-<n>\) or story \(S-<n>\) id/);
});

test('agentEnv turns titles off for every spawn and marks a headless one with BL_HEADLESS=1', () => {
  const base = { PATH: '/bin' };
  assert.deepEqual(agentEnv({ base }), { PATH: '/bin', BL_TAB_TITLE: '' });
  assert.deepEqual(agentEnv({ headless: true, base }), { PATH: '/bin', BL_TAB_TITLE: '', BL_HEADLESS: '1' });
  assert.deepEqual(agentEnv({ backlogRoot: '/b', base }), {
    PATH: '/bin',
    BL_TAB_TITLE: '',
    BL_BACKLOG_DIR: '/b',
  });
  // An operator's own format does not reach the agent session.
  assert.equal(agentEnv({ base: { BL_TAB_TITLE: '{{status}}' } }).BL_TAB_TITLE, '');
  assert.equal(isHeadless({ BL_HEADLESS: '1' }), true);
  assert.equal(isHeadless({ BL_HEADLESS: '' }), false);
  assert.equal(isHeadless({}), false);
});

test('every adapter gives a headless spawn BL_HEADLESS=1 and an interactive spawn none', async () => {
  await withMarker(undefined, () => {
    const launch = (provider, headless, extra = {}) => {
      let opts;
      provider.spawn({
        name: 'x',
        prompt: 'p',
        worktreePath: '/wt',
        cwd: '/wt',
        backlogRoot: '/bl',
        headless,
        run: (_cmd, _args, o) => ((opts = o), { status: 0, stdout: '' }),
        ...extra,
      });
      return opts.env ?? process.env;
    };
    const codexExtra = { ensureApprovedCommandPrefixes: () => ({ added: 0 }) };
    for (const [name, provider, extra] of [
      ['claude', new ClaudeProvider(), {}],
      ['codex', new CodexProvider(), codexExtra],
      ['gemini', new GeminiProvider(), { permissions: [] }],
    ]) {
      assert.equal(launch(provider, true, extra)[HEADLESS_ENV], '1', `${name} headless`);
      assert.equal(launch(provider, false, extra)[HEADLESS_ENV], undefined, `${name} interactive`);
      // S-1388: titles off in every agent session, headless or not.
      assert.equal(launch(provider, true, extra).BL_TAB_TITLE, '', `${name} headless title`);
      assert.equal(launch(provider, false, extra).BL_TAB_TITLE, '', `${name} interactive title`);
    }
  });
});

test('headlessPriorityRefusal names priority.yaml, by path or by a directory that holds it, only under BL_HEADLESS', () => {
  const on = { BL_HEADLESS: '1' };
  for (const paths of [['priority.yaml'], ['./priority.yaml'], ['.'], [''], ['/b/priority.yaml'], ['/b']]) {
    assert.match(headlessPriorityRefusal('/b', paths, on) ?? '', /refusing to commit priority\.yaml/, paths.join());
  }
  for (const paths of [['stories/S1-x'], ['priority.yaml.bak'], ['features'], ['/elsewhere']]) {
    assert.equal(headlessPriorityRefusal('/b', paths, on), null, paths.join());
  }
  assert.equal(headlessPriorityRefusal('/b', ['priority.yaml'], {}), null);
});

test('an interactive bl rank pulls the backlog first, listing or edit; help and a headless run do not', () => {
  assert.equal(commandPullsBacklog('rank', ['F-1', '--top'], {}), true);
  assert.equal(commandPullsBacklog('rank', [], {}), true);
  assert.equal(commandPullsBacklog('rank', ['--help'], {}), false);
  assert.equal(commandPullsBacklog('rank', ['F-1', '--top'], { BL_HEADLESS: '1' }), false);
  assert.equal(commandPullsBacklog('rank', [], { BL_HEADLESS: '1' }), false);
});

test('commitPaths refuses priority.yaml under BL_HEADLESS, commits it without', async () => {
  const { dir } = mkTempBacklog({ priority: ['F-1'] });
  initGitBacklog(dir);
  const path = join(dir, 'priority.yaml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}- F-2\n`);
  const head = git(dir, 'rev-parse', 'HEAD');
  const refused = await withMarker('1', () => commitPaths(dir, ['priority.yaml'], 'chore: rank'));
  assert.equal(refused.committed, false);
  assert.match(refused.error, /refusing to commit priority\.yaml .*BL_HEADLESS is set/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '', 'nothing staged');
  // Another path commits as before under the marker.
  writeFileSync(join(dir, 'note.txt'), 'n\n');
  assert.equal((await withMarker('1', () => commitPaths(dir, ['note.txt'], 'chore: note'))).committed, true);
  const ok = await withMarker(undefined, () => commitPaths(dir, ['priority.yaml'], 'chore: rank'));
  assert.equal(ok.committed, true, ok.error);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.yaml');
});

test('commitPaths_headless_refuses_every_pathspec_selecting_priority_yaml', async () => {
  const { dir } = mkTempBacklog({ priority: ['F-1'] });
  initGitBacklog(dir);
  const path = join(dir, 'priority.yaml');
  const head = git(dir, 'rev-parse', 'HEAD');
  // Modified, staged deletion, untracked: each state git's add and commit would take.
  const states = {
    modified: () => writeFileSync(path, `${readFileSync(path, 'utf8')}- F-2\n`),
    deleted: () => git(dir, 'rm', '-q', '--cached', 'priority.yaml'),
  };
  const specs = [
    'priority.yaml',
    './priority.yaml',
    '.',
    ':(top)priority.yaml',
    ':/priority.yaml',
    '*.yaml',
    'priority*',
    ':(glob)*.yaml',
    ':(icase)PRIORITY.YAML',
    ':(literal)priority.yaml',
  ];
  for (const [state, make] of Object.entries(states)) {
    make();
    for (const spec of specs) {
      const r = await withMarker('1', () => commitPaths(dir, [spec], 'chore: rank'));
      assert.equal(r.committed, false, `${state} ${spec}`);
      assert.match(r.error ?? '', /refusing to commit priority\.yaml/, `${state} ${spec}`);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, `${state} ${spec}: nothing committed`);
    }
    git(dir, 'reset', '-q', '--hard');
  }
  // A pathspec that does not select it is not refused.
  writeFileSync(path, `${readFileSync(path, 'utf8')}- F-2\n`);
  writeFileSync(join(dir, 'note.txt'), 'n\n');
  for (const spec of ['*.txt', ':(glob)note*', 'stories']) {
    assert.equal(headlessPriorityRefusal(dir, [spec], { BL_HEADLESS: '1' }), null, spec);
  }
});

test('commitPaths_headless_honors_excluded_priority_pathspec', async () => {
  const { dir } = mkTempBacklog({ priority: ['F-1'] });
  initGitBacklog(dir);
  const path = join(dir, 'priority.yaml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}- F-2\n`);
  writeFileSync(join(dir, 'note.yaml'), 'n\n');
  // Mixed sets: Git applies them whole, so an exclusion removes priority.yaml.
  const excluded = [
    ['*.yaml', ':!priority.yaml'],
    ['.', ':(exclude)priority.yaml'],
    [':!priority.yaml', 'note.yaml'],
    ['note.yaml', 'priority.yaml', ':^priority.yaml'],
    [':(glob)*.yaml', ':(top,exclude)priority.yaml'],
  ];
  const selecting = [['note.yaml', 'priority.yaml'], ['*.yaml', ':!note.yaml'], ['.', ':!stories'], [':!note.yaml']];
  for (const specs of selecting) {
    assert.match(
      headlessPriorityRefusal(dir, specs, { BL_HEADLESS: '1' }) ?? '',
      /refusing to commit priority\.yaml/,
      specs.join(),
    );
  }
  for (const specs of excluded) {
    assert.equal(headlessPriorityRefusal(dir, specs, { BL_HEADLESS: '1' }), null, specs.join());
  }
  // And through commitPaths: the note commits, priority.yaml stays modified.
  const r = await withMarker('1', () => commitPaths(dir, ['*.yaml', ':!priority.yaml'], 'chore: note'));
  assert.equal(r.committed, true, r.error);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'note.yaml');
  assert.equal(git(dir, 'status', '--porcelain'), 'M priority.yaml');
});
