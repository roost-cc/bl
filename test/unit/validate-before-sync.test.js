import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadPrompt } from '../../src/session.js';
import { mkTempDir } from '../helpers/tempdir.js';

// S-578: every story-editing prompt ends with the shared validate → locked
// `bl sync --commit` flow, and none of them forbids `bl sync` any more.
const VARS = { storyId: 'S-7', backlogDir: '/bl', storyAbsPath: '/bl/s.md' };
const MARKER = '## Backlog commits: validate, then a locked sync-and-commit';
const EDITING_PROMPTS = ['refine', 're-refine', 'cleanup-triage', 'workon', 'workon-review'];
const BATCH_PROMPTS = ['refine-batch'];
// The vars refine.js renders a batch orchestrator with.
const BATCH_VARS = {
  storyCount: '2',
  storyTasks: '-',
  storyId: '<its story>',
  backlogDir: '/bl',
};

test("the partial renders into {{validateBeforeSync}} with the session's vars", () => {
  const text = loadPrompt('refine', VARS);
  assert.ok(text.includes(MARKER));
  assert.doesNotMatch(text, /\{\{validateBeforeSync\}\}/);
  assert.match(text, /bl validate/);
  assert.match(text, /bl sync --commit -m "<type>: <subject> \(S-7\)" --story S-7/);
  // Surface, do not fix, findings on stories this session did not touch.
  assert.match(text, /Surface, do not fix/);
  // One-sided dependency edges are repaired with `bl fix --story`, scoped to
  // the stories this session touched, not by hand and never unscoped (S-858).
  assert.match(text, /Run `bl fix --story <id>` first/);
  assert.match(text, /Never run `bl fix` without `--story`/);
  assert.match(text, /`bl new` never adds the reverse edge for you/);
  // The reverse edge lands on another story's file, so that story is named
  // in the locked commit too.
  assert.match(text, /one `--story` for every other story the `bl fix` report listed/);
  // Why/how goes in the commit message, never in new frontmatter keys.
  assert.match(text, /commit message/);
  assert.match(text, /Never run `git add` or `git commit` in the backlog repo \(`\/bl`\)/);
});

for (const name of [...EDITING_PROMPTS, ...BATCH_PROMPTS]) {
  test(`${name} prompt carries the validate-before-sync partial`, () => {
    const vars = BATCH_PROMPTS.includes(name) ? BATCH_VARS : VARS;
    const text = loadPrompt(name, vars);
    assert.ok(text.includes(MARKER), `${name} lacks the partial`);
    assert.match(text, /Backlog commits/);
    assert.doesNotMatch(text, /Do NOT run `bl sync`/);
    // No raw backlog commit survives next to the locked one.
    assert.doesNotMatch(text, /git -C \/bl (add|commit)/);
  });
}

for (const name of BATCH_PROMPTS) {
  test(`${name} prompt sends sub-agents through the locked commit`, () => {
    const text = loadPrompt(name, BATCH_VARS);
    assert.match(text, /bl sync --commit … --story <its story>/);
    assert.match(text, /--story <its story> \[--story/);
    assert.doesNotMatch(text, /\{\{\w+\}\}/);
    assert.doesNotMatch(text, /Do NOT run `bl sync`/);
    assert.doesNotMatch(text, /must NOT run `bl sync`/);
    assert.doesNotMatch(text, /UNCOMMITTED/);
    assert.doesNotMatch(text, /must NOT run any `git` command/);
    assert.doesNotMatch(text, /leave that to the user/);
  });
}

test('refine-batch keeps each sub-agent to its own story file', () => {
  const text = loadPrompt('refine-batch', BATCH_VARS);
  assert.match(text, /Each sub-agent touches only its own story file/);
});

test('feature-loop prompts allow no bl sync but their bl sync --commit lines', () => {
  for (const name of ['feature-workon', 'feature-workon-review']) {
    const text = loadPrompt(name, VARS);
    assert.match(text, /any `bl sync` other than the\s+`bl sync --commit` line/, name);
    assert.ok(!text.includes(MARKER), `${name} should not carry the partial`);
  }
});

test('a missing partial leaves an empty slot', () => {
  const dir = mkTempDir('bl-prompts-');
  const prev = process.env.BL_INTERNAL_TEST_PROMPTS_DIR;
  try {
    writeFileSync(join(dir, 'p.md'), 'before\n{{validateBeforeSync}}\nafter\n');
    process.env.BL_INTERNAL_TEST_PROMPTS_DIR = dir;
    assert.equal(loadPrompt('p', VARS), 'before\n\nafter\n');
  } finally {
    if (prev == null) delete process.env.BL_INTERNAL_TEST_PROMPTS_DIR;
    else process.env.BL_INTERNAL_TEST_PROMPTS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup-triage tells the agent to pass --plugins-from on every bl new (S-870)', () => {
  const text = loadPrompt('cleanup-triage', VARS);
  assert.match(text, /Pass `--plugins-from S-7` to every `bl new`/);
  assert.match(text, /plugins-test/);
});

test('cleanup-triage names another component only for an item that belongs elsewhere (S-878, F-49)', () => {
  const text = loadPrompt('cleanup-triage', { ...VARS, componentId: 'C07' });
  assert.match(text, /defaults to S-7's component \(`C07`\) and\s+primary repo/);
  assert.match(
    text,
    /Name another component \(`bl new C<nn> …`\), or `--repo <name>` for\s+that repo's home component, only when the item belongs in a different\s+code boundary/,
  );
});

test('cleanup-triage orders dependent items with --depends-on and groups overlapping ones as a feature (S-1101)', () => {
  const text = loadPrompt('cleanup-triage', VARS);
  assert.match(text, /--depends-on/);
  assert.match(text, /bl fix --story/);
  assert.match(text, /bl new --feature/);
  assert.match(text, /--theme/);
  assert.match(text, /--path/);
  assert.doesNotMatch(text, /mentions a dependency on an existing story/);
  // The printed path already starts with features/; the commit names its directory.
  assert.match(text, /without its trailing `\/index\.md` \(for example `features\/F68-<slug>`\)/);
  assert.doesNotMatch(text, /--path features\/<its directory>/);
  // No theme to file under: stay standalone rather than guess or create one.
  assert.match(text, /If no theme's `repos:`\s+lists the repo, or more than one does, do not guess/);
});

test('cleanup-triage preserves existing-story dependencies for singleton and multi-item input', () => {
  const cases = [
    ['one unrelated item', '- [points: 1] Improve logging.'],
    ['one item depending on an existing story', '- [points: 1] Improve logging after S-42 lands.'],
    ['several unrelated items', '- [points: 1] Improve logging.\n- [points: 1] Update help.'],
    [
      'several items, one on an existing story',
      '- [points: 1] Improve logging after S-42 lands.\n- [points: 1] Update help.',
    ],
    [
      'sibling dependencies',
      '- [points: 1] Rewrite src/tokens.js.\n- [points: 1] Extend the same function after item 1.',
    ],
  ];
  for (const [name, todoSection] of cases) {
    const text = loadPrompt('cleanup-triage', { ...VARS, todoSection });
    const order = text.match(/ {3}- Order\.[\s\S]*?(?=\n\n3\.)/)?.[0] ?? '';
    // Only sibling ordering is moot for one item; nothing in the bullet is skipped.
    assert.doesNotMatch(order, /skip this bullet/, name);
    assert.match(
      order,
      /When an item depends on an\s+existing backlog story, pass that story's ID the same way, at any item\s+count, including one\./,
      name,
    );
    assert.match(order, /Items with no such relation get no\s+`--depends-on`/, name);
    assert.match(order, /`bl fix --story` adds the\s+reverse `required_for` edge/, name);
    assert.match(text, /one story alone never becomes a feature/, name);
  }
});
