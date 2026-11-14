import { test } from 'node:test';
import { basename } from 'path';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { resolveRefineTargets, refineBatchId, applyRefineStatus, applyBatchStatuses } from '../../src/refine.js';
import { loadPrompt } from '../../src/session.js';
import { outcomePath } from '../../src/outcome.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { statusOf, transition } from '../../src/transition.js';

test('two batch refines with different stories use different outcome files', () => {
  const a = outcomePath('/b', refineBatchId(['S-1', 'S-2']));
  const b = outcomePath('/b', refineBatchId(['S-3', 'S-4']));
  assert.match(a, /^\/b\/\.bl\/outcome\/refine-batch-[0-9a-f]{12}\.json$/);
  assert.notEqual(a, b);
  assert.notEqual(a, outcomePath('/b', refineBatchId(['S-1'])), 'a batch that holds one story more');
  assert.equal(a, outcomePath('/b', refineBatchId(['S-2', 'S-1'])), 'the same stories in another order');
});

test('a batch refine outcome file name stays under 255 bytes for every batch size', () => {
  for (const n of [1, 2, 35, 60, 200, 1000]) {
    const ids = Array.from({ length: n }, (_, i) => `S-${1000 + i}`);
    const name = basename(outcomePath('/b', refineBatchId(ids)));
    assert.ok(Buffer.byteLength(name) < 255, `${n} stories: ${name}`);
    assert.notEqual(refineBatchId(ids), refineBatchId(ids.slice(1)), `${n} stories and one fewer`);
  }
});

test('a status write that fails names its story', async () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const unit = { id: 'S-9', kind: 'story', indexPath: `${dir}/stories/S9-gone/index.md` };
    await assert.rejects(async () => applyRefineStatus(dir, unit, 'success'), /^Error: S-9: /);
  } finally {
    cleanup();
  }
});

test('a batch refine applies every story it can and names each one it could not', async () => {
  const stories = ['S-1', 'S-3', 'S-4'].map((id) => ({
    id,
    component: 'C01',
    title: id,
    status: 'backlog',
  }));
  const { dir, cleanup } = mkTempBacklog({ components: [{ id: 'C01', title: 'One' }], stories });
  try {
    const path = (id) => `${dir}/stories/S${id.slice(2)}/index.md`;
    // S-2 and S-5 have no file: their writes fail, before and after the others.
    const targets = ['S-1', 'S-2', 'S-3', 'S-4', 'S-5'].map((id) => ({ id, found: { indexPath: path(id) } }));
    // refineAndCommit records the refinement session's start first (F-119 R1).
    for (const id of ['S-1', 'S-3', 'S-4']) {
      await transition(dir, { kind: 'story', indexPath: path(id) }, 'in_refinement', { by: 'refine' });
    }
    const outcome = [
      { id: 'S-1', refined: true, reason: 'ready' },
      { id: 'S-2', refined: true, reason: 'ready' },
      { id: 'S-3', refined: false, reason: 'too large' },
      { id: 'S-4', refined: true, reason: 'ready' },
      { id: 'S-5', refined: true, reason: 'ready' },
    ];
    await assert.rejects(
      async () => applyBatchStatuses(dir, targets, outcome),
      (e) => {
        assert.match(e.message, /^status set for: S-1, S-4; not set for:\n/);
        assert.match(e.message, /\n {2}S-2: /);
        assert.match(e.message, /\n {2}S-5: /);
        return true;
      },
    );
    const status = (id) => statusOf('story', parseFrontmatter(readFileSync(path(id), 'utf8')).fm);
    assert.equal(status('S-1'), 'refined');
    assert.equal(status('S-3'), 'in_refinement', 'not refined: unchanged');
    assert.equal(status('S-4'), 'refined');
    const entry = parseFrontmatter(readFileSync(path('S-1'), 'utf8')).fm.transitions.at(-1);
    assert.deepEqual([entry.to, entry.by, entry.via], ['refined', 'refine', 'refine']);
  } finally {
    cleanup();
  }
});

test('a batch entry decides from refined alone, prints its reason for every verdict, and the first entry for a story wins (S-1408)', async (t) => {
  const stories = ['S-1', 'S-2', 'S-3'].map((id) => ({ id, component: 'C01', title: id, status: 'backlog' }));
  const { dir, cleanup } = mkTempBacklog({ components: [{ id: 'C01', title: 'One' }], stories });
  const lines = [];
  t.mock.method(process.stderr, 'write', (chunk) => lines.push(String(chunk).trimEnd()));
  try {
    const path = (id) => `${dir}/stories/S${id.slice(2)}/index.md`;
    const targets = ['S-1', 'S-2', 'S-3'].map((id) => ({ id, found: { indexPath: path(id) } }));
    // refineAndCommit records the refinement session's start first (F-119 R1).
    for (const { found } of targets) {
      await transition(dir, { kind: 'story', indexPath: found.indexPath }, 'in_refinement', { by: 'refine' });
    }
    lines.length = 0;
    await applyBatchStatuses(dir, targets, [
      { id: 'S-1', refined: true, reason: 'every criterion has a check' },
      { id: 'S-2', refined: false, reason: 'an open question blocks the plan' },
      { id: 'S-3', refined: false, reason: 'too large' },
      { id: 'S-3', refined: true, reason: 'ready' },
      { id: 'S-9', refined: true, reason: 'ready' },
    ]);
    const fm = (id) => parseFrontmatter(readFileSync(path(id), 'utf8')).fm;
    assert.deepEqual(
      ['S-1', 'S-2', 'S-3'].map((id) => statusOf('story', fm(id))),
      ['refined', 'in_refinement', 'in_refinement'],
    );
    assert.equal(
      fm('S-1').transitions.at(-1).outcome,
      'every criterion has a check',
      'the reason is the outcome of the log entry',
    );
    assert.deepEqual(lines, [
      'S-1: status refined: every criterion has a check',
      'S-2 is not refined; its status is unchanged: an open question blocks the plan',
      'S-3 is not refined; its status is unchanged: too large',
    ]);
  } finally {
    cleanup();
  }
});

function fixture() {
  return mkTempBacklog({
    components: [
      { id: 'C01', title: 'One', dirSuffix: 'one' },
      { id: 'C02', title: 'Two', dirSuffix: 'two' },
    ],
    stories: [
      // C01: two backlog, one already-refined, one done.
      {
        id: 'S-10',
        component: 'C01',
        title: 'Ten',
        dirSuffix: 'ten',
        status: 'backlog',
      },
      {
        id: 'S-11',
        component: 'C01',
        title: 'Eleven',
        dirSuffix: 'eleven',
        status: 'refined',
      },
      {
        id: 'S-12',
        component: 'C01',
        title: 'Twelve',
        dirSuffix: 'twelve',
        status: 'done',
        completed: '2026-01-01',
      },
      {
        id: 'S-13',
        component: 'C01',
        title: 'Thirteen',
        dirSuffix: 'thirteen',
        status: 'backlog',
      },
      // C02 has no backlog stories (only a done one).
      {
        id: 'S-20',
        component: 'C02',
        title: 'Twenty',
        dirSuffix: 'twenty',
        status: 'done',
        completed: '2026-01-01',
      },
    ],
  });
}

function ids(targets) {
  return targets.map((t) => t.id);
}

test('component expands to its backlog stories only', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets, errors, notices } = resolveRefineTargets(['C01'], cfg);
    assert.deepEqual(ids(targets), ['S-10', 'S-13']);
    assert.deepEqual(errors, []);
    assert.deepEqual(notices, []);
    assert.ok(targets.every((t) => t.source === 'component'));
  } finally {
    cleanup();
  }
});

test('named story is included even when already refined', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets } = resolveRefineTargets(['S-11'], cfg);
    assert.deepEqual(ids(targets), ['S-11']);
    assert.equal(targets[0].source, 'named');
  } finally {
    cleanup();
  }
});

test('named done/superseded story is skipped with a notice', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets, notices } = resolveRefineTargets(['S-12'], cfg);
    assert.deepEqual(ids(targets), []);
    assert.ok(notices.some((n) => n.includes('S-12') && n.includes('done')));
  } finally {
    cleanup();
  }
});

test('named story outranks the same story pulled in via its component', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    // S-11 is refined: the component filter excludes it, but naming it adds it back.
    const { targets } = resolveRefineTargets(['C01', 'S-11'], cfg);
    assert.deepEqual(ids(targets), ['S-10', 'S-11', 'S-13']);
    assert.equal(targets.find((t) => t.id === 'S-11').source, 'named');
  } finally {
    cleanup();
  }
});

test('a backlog story named alongside its component is deduped', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets } = resolveRefineTargets(['C01', 'S-10'], cfg);
    assert.deepEqual(ids(targets), ['S-10', 'S-13']);
    assert.equal(targets.find((t) => t.id === 'S-10').source, 'named');
  } finally {
    cleanup();
  }
});

test('a component with no backlog stories yields a notice, not an error', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets, errors, notices } = resolveRefineTargets(['C02'], cfg);
    assert.deepEqual(ids(targets), []);
    assert.deepEqual(errors, []);
    assert.ok(notices.some((n) => n.includes('C02')));
  } finally {
    cleanup();
  }
});

test('an E-id is refused with the hint that components are C-ids', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets, errors } = resolveRefineTargets(['E09'], cfg);
    assert.deepEqual(ids(targets), []);
    assert.deepEqual(errors, ['E09 is not a component id: components are C-ids (C09).']);
  } finally {
    cleanup();
  }
});

test('unknown component and invalid id produce errors', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets, errors } = resolveRefineTargets(['C09', 'nonsense'], cfg);
    assert.deepEqual(ids(targets), []);
    assert.equal(errors.length, 2);
    assert.ok(errors.some((e) => e.includes('C09')));
    assert.ok(errors.some((e) => e.includes('nonsense')));
  } finally {
    cleanup();
  }
});

test('targets are deduped and sorted by story number', () => {
  const { dir, cleanup } = fixture();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const { targets } = resolveRefineTargets(['S-13', 'S-10', 'S-13'], cfg);
    assert.deepEqual(ids(targets), ['S-10', 'S-13']);
  } finally {
    cleanup();
  }
});

for (const name of ['refine', 're-refine']) {
  test(`${name} prompt ends with validate/sync/commit closing step`, () => {
    const text = loadPrompt(name, { storyId: 'S-1', backlogDir: '/bl' });
    assert.match(text, /bl validate/);
    // S-578: the commit goes through the locked `bl sync --commit`, not git.
    assert.match(text, /bl sync --commit -m .* --story S-1/);
    assert.doesNotMatch(text, /git -C \/bl (add|commit)/);
    // The commit message uses the sibling-prompt convention and the story id.
    assert.match(text, /`chore: (re-)?refine S-1`/);
    // Child stories from `bl new` ride along as extra --story flags.
    assert.match(text, /one `--story` for each child story/);
  });

  test(`${name} prompt no longer forbids running bl sync`, () => {
    const text = loadPrompt(name, { storyId: 'S-1', backlogDir: '/bl' });
    assert.doesNotMatch(text, /Do NOT run `bl sync`/);
  });

  // F-68 D1: the session ends by writing the outcome file, which `launchSession` names.
  test(`${name} prompt ends with the Outcome section naming {{outcomePath}}`, () => {
    const text = loadPrompt(name, { storyId: 'S-1', backlogDir: '/bl' });
    const outcome = text.slice(text.lastIndexOf('## Outcome'));
    assert.match(outcome, /^## Outcome\n/);
    assert.match(outcome, /use the Write tool to write this JSON\s+object, and nothing else, to `\{\{outcomePath\}\}`/);
    assert.match(outcome, /"refined": true/);
  });

  test(`${name} prompt for a batch sub-agent replies with the outcome and names no outcome file`, () => {
    const refineOutcome = loadPrompt('_refine-outcome-subagent', {});
    const text = loadPrompt(name, { storyId: 'S-1', backlogDir: '/bl', refineOutcome });
    assert.doesNotMatch(text, /\{\{outcomePath\}\}/);
    assert.match(text, /## Outcome\n\nYou are one sub-agent of a batch refine\. Write no outcome file\./);
  });
}

for (const name of ['refine-batch', 'feature-refine']) {
  test(`${name} prompt ends with the Outcome section naming {{outcomePath}}`, () => {
    const text = loadPrompt(name, { storyId: 'S-1', featureId: 'F-1', backlogDir: '/bl' });
    const outcome = text.slice(text.lastIndexOf('## Outcome'));
    assert.match(outcome, /^## Outcome\n/);
    assert.match(outcome, /to `\{\{outcomePath\}\}`/);
  });
}
