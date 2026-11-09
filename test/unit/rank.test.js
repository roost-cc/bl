/**
 * Unit tests for F-78 D3: `bl rank`'s text edit (`src/rank-cmd.js`), the
 * BL_HEADLESS marker every headless agent spawn carries (`agentEnv`, each
 * adapter's `spawn`), and `commitPaths`' refusal of `priority.md` under it.
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

/** A priority.md written by hand: comments, a wrapped reason, a blank line, a body. */
const HAND = `---
# Hand-written comment at the top.
ranked:
  # The deploy blocker comes first.
  - unit: S-1
    why: Blocks every deploy,
      wrapped by hand.
  - unit: F-2 # the big one
    why: "Users see it next"

  - unit: F-3
    why: Third
---

# Priority

Hand-written body, never touched.
`;

/** The entry lines of HAND, by unit, as written. */
const LINES = {
  'S-1': '  - unit: S-1\n    why: Blocks every deploy,\n      wrapped by hand.\n',
  'F-2': '  - unit: F-2 # the big one\n    why: "Users see it next"\n',
  'F-3': '  - unit: F-3\n    why: Third\n',
};
const HEAD = '---\n# Hand-written comment at the top.\nranked:\n  # The deploy blocker comes first.\n';
const TAIL = '---\n\n# Priority\n\nHand-written body, never touched.\n';

/** Run `fn` with `process.env.BL_HEADLESS` set to `value` (undefined: unset), then put it back. */
function withMarker(value, fn) {
  const saved = process.env[HEADLESS_ENV];
  if (value === undefined) delete process.env[HEADLESS_ENV];
  else process.env[HEADLESS_ENV] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[HEADLESS_ENV];
    else process.env[HEADLESS_ENV] = saved;
  }
}

test('applyRank moves an entry and keeps every other byte as written', () => {
  assert.equal(
    applyRank(HAND, { id: 'F-3', where: 'top' }),
    `${HEAD}${LINES['F-3']}${LINES['S-1']}${LINES['F-2']}\n${TAIL}`,
  );
  assert.equal(applyRank(HAND, { id: 'F-3', where: 'top' }).endsWith(TAIL), true);
  assert.equal(
    applyRank(HAND, { id: 'S-1', where: { after: 'F-2' } }),
    `${HEAD}${LINES['F-2']}${LINES['S-1']}\n${LINES['F-3']}${TAIL}`,
  );
  assert.equal(
    applyRank(HAND, { id: 'S-1', where: 'bottom' }),
    `${HEAD}${LINES['F-2']}\n${LINES['F-3']}${LINES['S-1']}${TAIL}`,
  );
  assert.equal(
    applyRank(HAND, { id: 'F-3', where: { before: 'F-2' } }),
    `${HEAD}${LINES['S-1']}${LINES['F-3']}${LINES['F-2']}\n${TAIL}`,
  );
  // Where it already is: nothing changes.
  assert.equal(applyRank(HAND, { id: 'S-1', where: 'top' }), HAND);
  assert.equal(applyRank(HAND, { id: 'F-2', where: { after: 'S-1' } }), HAND);
});

test('applyRank adds a new entry at the list indentation, quoting its reason only where YAML needs it', () => {
  assert.equal(
    applyRank(HAND, { id: 'S-9', where: { before: 'F-2' }, why: 'Needed: first' }),
    `${HEAD}${LINES['S-1']}  - unit: S-9\n    why: "Needed: first"\n${LINES['F-2']}\n${LINES['F-3']}${TAIL}`,
  );
  assert.equal(
    applyRank(HAND, { id: 'F-4', where: 'bottom', why: 'Plain words' }),
    `${HEAD}${LINES['S-1']}${LINES['F-2']}\n${LINES['F-3']}  - unit: F-4\n    why: Plain words\n${TAIL}`,
  );
  // Into an empty list, in flow style or bare.
  for (const ranked of ['ranked: []', 'ranked:']) {
    const one = applyRank(`---\n${ranked}\n---\n\nBody.\n`, { id: 'F-1', where: 'top', why: 'One' });
    assert.equal(one, '---\nranked:\n  - unit: F-1\n    why: One\n---\n\nBody.\n', ranked);
  }
  // With no ranked: key at all, it is added at the end of the block.
  assert.equal(
    applyRank('---\nnote: x\n---\nBody.\n', { id: 'S-2', where: 'top', why: 'Two' }),
    '---\nnote: x\nranked:\n  - unit: S-2\n    why: Two\n---\nBody.\n',
  );
});

test('applyRank rewrites only the reason with --why alone, and with a move moves the rewritten entry', () => {
  assert.equal(
    applyRank(HAND, { id: 'F-2', why: 'A new reason' }),
    `${HEAD}${LINES['S-1']}  - unit: F-2 # the big one\n    why: A new reason\n\n${LINES['F-3']}${TAIL}`,
  );
  assert.equal(
    applyRank(HAND, { id: 'S-1', why: 'Shorter', where: 'bottom' }),
    `${HEAD}${LINES['F-2']}\n${LINES['F-3']}  - unit: S-1\n    why: Shorter\n${TAIL}`,
  );
  // A block-scalar reason keeps the line break that ends it.
  const folded =
    '---\nranked:\n  - unit: F-1\n    why: >-\n      folded\n      text\n  - unit: F-2\n    why: Two\n---\n';
  assert.equal(
    applyRank(folded, { id: 'F-1', why: 'New' }),
    '---\nranked:\n  - unit: F-1\n    why: New\n  - unit: F-2\n    why: Two\n---\n',
  );
  const last = '---\nranked:\n  - unit: F-1\n    why: |\n      literal\n---\n';
  assert.equal(applyRank(last, { id: 'F-1', why: 'New' }), '---\nranked:\n  - unit: F-1\n    why: New\n---\n');
});

test('applyRank removes an entry; the last one leaves ranked: []', () => {
  assert.equal(applyRank(HAND, { id: 'F-2', remove: true }), `${HEAD}${LINES['S-1']}\n${LINES['F-3']}${TAIL}`);
  const one = '---\nranked:\n  - unit: F-1\n    why: One\n---\n\nBody.\n';
  assert.equal(applyRank(one, { id: 'F-1', remove: true }), '---\nranked: []\n---\n\nBody.\n');
});

test('removeClosed takes out every entry of the ids given and keeps every other byte', () => {
  assert.equal(removeClosed(HAND, ['F-2', 'S-1']), `${HEAD}\n${LINES['F-3']}${TAIL}`);
  const twice = HAND.replace(LINES['F-3'], `${LINES['F-3']}${LINES['S-1']}`);
  assert.equal(removeClosed(twice, ['S-1']), `${HEAD}${LINES['F-2']}\n${LINES['F-3']}${TAIL}`);
  assert.equal(
    removeClosed(HAND, ['S-1', 'F-2', 'F-3']),
    '---\n# Hand-written comment at the top.\nranked: []\n  # The deploy blocker comes first.\n\n' + TAIL,
  );
  assert.equal(removeClosed(HAND, []), HAND);
});

test('rank_insert_into_empty_list_preserves_inline_comment_and_body', () => {
  const fm = (block) => `---\n${block}---\n\nBody.\n`;
  const entry = '  - unit: F-1\n    why: One\n';
  for (const [name, before, op, after] of [
    [
      'insert, flow list + comment',
      'ranked: [] # operator note\n',
      { where: 'top', why: 'One' },
      `ranked: # operator note\n${entry}`,
    ],
    [
      'insert, bare + comment',
      'ranked: # operator note\n',
      { where: 'top', why: 'One' },
      `ranked: # operator note\n${entry}`,
    ],
    [
      'insert, empty string + comment',
      "ranked: '' # operator note\n",
      { where: 'top', why: 'One' },
      `ranked: # operator note\n${entry}`,
    ],
    ['insert, empty string', 'ranked: ""\n', { where: 'top', why: 'One' }, `ranked:\n${entry}`],
    [
      'insert, bare + comment line after',
      'ranked:\n# later note\nother: x\n',
      { where: 'bottom', why: 'One' },
      `ranked:\n${entry}# later note\nother: x\n`,
    ],
    [
      'remove last, comment on ranked:',
      `ranked: # operator note\n${entry}`,
      { remove: true },
      'ranked: [] # operator note\n',
    ],
    [
      'remove last, comment line after',
      `ranked:\n${entry}  # trailing note\nother: x\n`,
      { remove: true },
      'ranked: []\n  # trailing note\nother: x\n',
    ],
    [
      'remove last, comment line before',
      `ranked:\n  # head note\n${entry}`,
      { remove: true },
      'ranked: []\n  # head note\n',
    ],
    [
      'why, inline comment',
      'ranked:\n  - unit: F-1\n    why: One # note\n',
      { why: 'Two' },
      'ranked:\n  - unit: F-1\n    why: Two # note\n',
    ],
    [
      'why, block header comment',
      'ranked:\n  - unit: F-1\n    why: >- # note\n      long\n      text\n# after\n',
      { why: 'Two' },
      'ranked:\n  - unit: F-1\n    why: Two # note\n# after\n',
    ],
  ]) {
    const out = applyRank(fm(before), { id: 'F-1', ...op });
    assert.equal(out, fm(after), name);
    assert.deepEqual(rankedIds(out), op.remove ? [] : ['F-1'], `${name}: still YAML bl rank reads`);
  }
});

test('rank_rejects_invalid_existing_ranked_entries', () => {
  const good = '  - unit: F-1\n    why: One\n';
  const invalid = {
    'missing why': '  - unit: F-2\n',
    'empty why': '  - unit: F-2\n    why: ""\n',
    'null why': '  - unit: F-2\n    why:\n',
    'mapping why': '  - unit: F-2\n    why:\n      a: b\n',
    'list why': '  - unit: F-2\n    why:\n      - a\n',
    'missing unit': '  - why: Two\n',
    'empty unit': '  - unit: ""\n    why: Two\n',
    'mapping unit': '  - unit:\n      a: b\n    why: Two\n',
    'list unit': '  - unit: [F-2]\n    why: Two\n',
  };
  const ops = {
    insert: { id: 'S-3', where: 'top', why: 'Three' },
    move: { id: 'F-1', where: 'bottom' },
    why: { id: 'F-1', why: 'New' },
    remove: { id: 'F-1', remove: true },
  };
  for (const [name, bad] of Object.entries(invalid)) {
    const content = `---\nranked:\n${good}${bad}---\n`;
    assert.throws(() => rankedIds(content), RankFileError, `rankedIds: ${name}`);
    for (const [kind, op] of Object.entries(ops)) {
      assert.throws(() => applyRank(content, op), /"ranked:" entry 2 has no "(unit|why)"/, `${kind}: ${name}`);
    }
  }
});

test('rankedIds reads the ids as written, canonical; a file bl rank cannot edit is a RankFileError', () => {
  assert.deepEqual(rankedIds(HAND), ['S-1', 'F-2', 'F-3']);
  assert.deepEqual(rankedIds('---\nranked:\n  - unit: f3\n    why: x\n---\n'), ['F-3']);
  for (const bad of [
    'no block',
    '---\nranked: [\n---\n',
    '---\nranked: x\n---\n',
    '---\nranked: [{unit: F-1, why: x}]\n---\n',
  ]) {
    assert.throws(() => rankedIds(bad), RankFileError, bad);
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
      'status: backlog\n',
      'status: backlog\nupdate_repo: bl\n',
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
  assert.equal(isHeadless({ BL_HEADLESS: '1' }), true);
  assert.equal(isHeadless({ BL_HEADLESS: '' }), false);
  assert.equal(isHeadless({}), false);
});

test('every adapter gives a headless spawn BL_HEADLESS=1 and an interactive spawn none', () => {
  withMarker(undefined, () => {
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

test('headlessPriorityRefusal names priority.md, by path or by a directory that holds it, only under BL_HEADLESS', () => {
  const on = { BL_HEADLESS: '1' };
  for (const paths of [['priority.md'], ['./priority.md'], ['.'], [''], ['/b/priority.md'], ['/b']]) {
    assert.match(headlessPriorityRefusal('/b', paths, on) ?? '', /refusing to commit priority\.md/, paths.join());
  }
  for (const paths of [['stories/S1-x'], ['priority.md.bak'], ['features'], ['/elsewhere']]) {
    assert.equal(headlessPriorityRefusal('/b', paths, on), null, paths.join());
  }
  assert.equal(headlessPriorityRefusal('/b', ['priority.md'], {}), null);
});

test('an interactive bl rank pulls the backlog first, listing or edit; help and a headless run do not', () => {
  assert.equal(commandPullsBacklog('rank', ['F-1', '--top'], {}), true);
  assert.equal(commandPullsBacklog('rank', [], {}), true);
  assert.equal(commandPullsBacklog('rank', ['--help'], {}), false);
  assert.equal(commandPullsBacklog('rank', ['F-1', '--top'], { BL_HEADLESS: '1' }), false);
  assert.equal(commandPullsBacklog('rank', [], { BL_HEADLESS: '1' }), false);
});

test('commitPaths refuses priority.md under BL_HEADLESS, commits it without', () => {
  const { dir } = mkTempBacklog({ priority: [{ unit: 'F-1', why: 'x' }] });
  initGitBacklog(dir);
  const path = join(dir, 'priority.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('why: x', 'why: y'));
  const head = git(dir, 'rev-parse', 'HEAD');
  const refused = withMarker('1', () => commitPaths(dir, ['priority.md'], 'chore: rank'));
  assert.equal(refused.committed, false);
  assert.match(refused.error, /refusing to commit priority\.md .*BL_HEADLESS is set/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '', 'nothing staged');
  // Another path commits as before under the marker.
  writeFileSync(join(dir, 'note.txt'), 'n\n');
  assert.equal(withMarker('1', () => commitPaths(dir, ['note.txt'], 'chore: note')).committed, true);
  const ok = withMarker(undefined, () => commitPaths(dir, ['priority.md'], 'chore: rank'));
  assert.equal(ok.committed, true, ok.error);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'priority.md');
});

test('commitPaths_headless_refuses_every_pathspec_selecting_priority_md', () => {
  const { dir } = mkTempBacklog({ priority: [{ unit: 'F-1', why: 'x' }] });
  initGitBacklog(dir);
  const path = join(dir, 'priority.md');
  const head = git(dir, 'rev-parse', 'HEAD');
  // Modified, staged deletion, untracked: each state git's add and commit would take.
  const states = {
    modified: () => writeFileSync(path, readFileSync(path, 'utf8').replace('why: x', 'why: y')),
    deleted: () => git(dir, 'rm', '-q', '--cached', 'priority.md'),
  };
  const specs = [
    'priority.md',
    './priority.md',
    '.',
    ':(top)priority.md',
    ':/priority.md',
    '*.md',
    'priority*',
    ':(glob)*.md',
    ':(icase)PRIORITY.MD',
    ':(literal)priority.md',
  ];
  for (const [state, make] of Object.entries(states)) {
    make();
    for (const spec of specs) {
      const r = withMarker('1', () => commitPaths(dir, [spec], 'chore: rank'));
      assert.equal(r.committed, false, `${state} ${spec}`);
      assert.match(r.error ?? '', /refusing to commit priority\.md/, `${state} ${spec}`);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head, `${state} ${spec}: nothing committed`);
    }
    git(dir, 'reset', '-q', '--hard');
  }
  // A pathspec that does not select it is not refused.
  writeFileSync(path, readFileSync(path, 'utf8').replace('why: x', 'why: y'));
  writeFileSync(join(dir, 'note.txt'), 'n\n');
  for (const spec of ['*.txt', ':(glob)note*', 'stories']) {
    assert.equal(headlessPriorityRefusal(dir, [spec], { BL_HEADLESS: '1' }), null, spec);
  }
});

test('commitPaths_headless_honors_excluded_priority_pathspec', () => {
  const { dir } = mkTempBacklog({ priority: [{ unit: 'F-1', why: 'x' }] });
  initGitBacklog(dir);
  const path = join(dir, 'priority.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('why: x', 'why: y'));
  writeFileSync(join(dir, 'note.md'), 'n\n');
  // Mixed sets: Git applies them whole, so an exclusion removes priority.md.
  const excluded = [
    ['*.md', ':!priority.md'],
    ['.', ':(exclude)priority.md'],
    [':!priority.md', 'note.md'],
    ['note.md', 'priority.md', ':^priority.md'],
    [':(glob)*.md', ':(top,exclude)priority.md'],
  ];
  const selecting = [['note.md', 'priority.md'], ['*.md', ':!note.md'], ['.', ':!stories'], [':!note.md']];
  for (const specs of selecting) {
    assert.match(
      headlessPriorityRefusal(dir, specs, { BL_HEADLESS: '1' }) ?? '',
      /refusing to commit priority\.md/,
      specs.join(),
    );
  }
  for (const specs of excluded) {
    assert.equal(headlessPriorityRefusal(dir, specs, { BL_HEADLESS: '1' }), null, specs.join());
  }
  // And through commitPaths: the note commits, priority.md stays modified.
  const r = withMarker('1', () => commitPaths(dir, ['*.md', ':!priority.md'], 'chore: note'));
  assert.equal(r.committed, true, r.error);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'note.md');
  assert.equal(git(dir, 'status', '--porcelain'), 'M priority.md');
});
