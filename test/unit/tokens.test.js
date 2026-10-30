import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  applyTokensToFrontmatter,
  addUsageToFrontmatter,
  addStepUsageToFrontmatter,
  accumulateTokensOnFile,
  accumulateStepTokensOnFile,
  usageDelta,
  sessionTokens,
  mergeStepTokens,
  tokensStepKey,
} from '../../src/tokens.js';
import { stepTokens } from '../../src/report.js';
import { ClaudeProvider, pathToProjectSlug } from '../../src/agents/claude.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { mkTempDir } from '../helpers/tempdir.js';

test('transcriptDirs lists the unit directory, then each worktree, once each', async () => {
  const { transcriptDirs } = await import('../../src/tokens.js');
  assert.deepEqual(
    transcriptDirs([
      { worktreePath: '/w/f1/a', unitDir: '/w/f1' },
      { worktreePath: '/w/f1/b', unitDir: '/w/f1' },
    ]),
    ['/w/f1', '/w/f1/a', '/w/f1/b'],
  );
  assert.deepEqual(transcriptDirs([{ worktreePath: '/w/s1/a' }]), ['/w/s1/a'], 'no unit directory known');
  assert.deepEqual(transcriptDirs([]), []);
});

// Whether `p` is a unit directory, `<root>/<branch>` (F-60 D3), not a worktree.
async function unitDirTest(config) {
  const { worktreeRoot } = await import('../../src/config.js');
  return (p) => dirname(p) === worktreeRoot(config);
}

// ---------------------------------------------------------------------------
// pathToProjectSlug — replaces every non-alphanumeric byte with "-".
// Pre-PR-16 this only replaced path separators, which silently broke
// findSession() for any path containing dots or underscores.
// ---------------------------------------------------------------------------

test('pathToProjectSlug replaces path separators', () => {
  assert.equal(pathToProjectSlug('/home/u/work'), '-home-u-work');
});

test('pathToProjectSlug replaces dots — the regression this fixes', () => {
  assert.equal(pathToProjectSlug('/home/u/work/app.acme.com/x'), '-home-u-work-app-acme-com-x');
});

test('pathToProjectSlug does not collapse adjacent runs (/. → --)', () => {
  // Matches Claude Code's actual on-disk slug: ~/.config/kitty
  // → -home-u--config-kitty (the / and the . each produce a dash).
  assert.equal(pathToProjectSlug('/home/u/.config/kitty'), '-home-u--config-kitty');
});

test('pathToProjectSlug replaces underscores too', () => {
  assert.equal(pathToProjectSlug('/var/lib/some_dir'), '-var-lib-some-dir');
});

// ---------------------------------------------------------------------------
// applyTokensToFrontmatter — pure in-place merge.
// ---------------------------------------------------------------------------

test('applyTokensToFrontmatter writes flat keys and a date-only timestamp', () => {
  const fm = { story_id: 'S-1', status: 'in-progress' };
  applyTokensToFrontmatter(fm, {
    input: 100,
    output: 200,
    cache_creation: 300,
    cache_read: 400,
  });
  assert.equal(fm.tokens_input, '100');
  assert.equal(fm.tokens_output, '200');
  assert.equal(fm.tokens_cache_creation, '300');
  assert.equal(fm.tokens_cache_read, '400');
  // Date-only, matches `completed`/`added` convention.
  assert.match(fm.tokens_updated, /^\d{4}-\d{2}-\d{2}$/);
  // Existing fields untouched.
  assert.equal(fm.story_id, 'S-1');
  assert.equal(fm.status, 'in-progress');
});

test('applyTokensToFrontmatter is a no-op for null totals', () => {
  const fm = { story_id: 'S-1' };
  applyTokensToFrontmatter(fm, null);
  assert.deepEqual(Object.keys(fm), ['story_id']);
});

// ---------------------------------------------------------------------------
// applyTokensToFrontmatter + frontmatter parser round-trip — what the write
// path of recordStoryTokens does. Verifies tokens land on disk and that the
// existing line-based parser handles them on the next read.
// ---------------------------------------------------------------------------

test('frontmatter round-trip preserves tokens and existing fields/body', () => {
  const dir = mkTempDir('bl-tokens-rt-');
  const indexPath = join(dir, 'index.md');
  writeFileSync(indexPath, `---\nstory_id: S-500\ntitle: demo\nstatus: in-progress\n---\n\n# body\n\ntext\n`);

  const before = readFileSync(indexPath, 'utf8');
  const { fm, body } = parseFrontmatter(before);
  applyTokensToFrontmatter(fm, {
    input: 5,
    output: 7,
    cache_creation: 11,
    cache_read: 13,
  });
  writeFileSync(indexPath, serializeFrontmatter(fm) + body);

  const after = readFileSync(indexPath, 'utf8');
  assert.match(after, /^tokens_input: 5$/m);
  assert.match(after, /^tokens_output: 7$/m);
  assert.match(after, /^tokens_cache_creation: 11$/m);
  assert.match(after, /^tokens_cache_read: 13$/m);
  assert.match(after, /^tokens_updated: \d{4}-\d{2}-\d{2}$/m);
  assert.match(after, /^story_id: S-500$/m);
  assert.match(after, /^status: in-progress$/m);
  assert.match(after, /^# body$/m);
  assert.match(after, /^text$/m);

  // Re-parse: tokens are picked up as plain string fields, no parser confusion.
  const reread = parseFrontmatter(after);
  assert.equal(reread.fm.tokens_input, '5');
  assert.equal(reread.fm.story_id, 'S-500');
});

// ---------------------------------------------------------------------------
// ClaudeProvider.getTokens — read JSONL fixtures from a temp projects root.
// The third arg overrides the projects root so we don't have to monkey-patch
// $HOME or homedir().
// ---------------------------------------------------------------------------

function setupProjectsRoot() {
  return mkTempDir('bl-tokens-');
}

function writeSession(projectsRoot, worktreePath, sessionId, customTitle, records) {
  const slug = pathToProjectSlug(worktreePath);
  const dir = join(projectsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'custom-title', customTitle, sessionId }),
    ...records.map((r) => JSON.stringify(r)),
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  return dir;
}

function assistantTurn(usage) {
  return { type: 'assistant', message: { role: 'assistant', usage } };
}

test('ClaudeProvider.getTokens sums usage across every assistant turn', () => {
  const root = setupProjectsRoot();
  const wt = '/wt/s100-foo';
  writeSession(root, wt, 'sess-a', 'S-100: foo', [
    assistantTurn({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
    }),
    assistantTurn({
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    }),
    { type: 'user', message: { content: 'noise' } }, // ignored
  ]);

  const totals = new ClaudeProvider().getTokens(wt, 'S-100:', root);
  assert.deepEqual(totals, {
    input: 11,
    output: 22,
    cache_creation: 33,
    cache_read: 44,
  });
});

test("ClaudeProvider.getTokens skips sessions whose custom-title prefix doesn't match", () => {
  const root = setupProjectsRoot();
  const wt = '/wt/s100-foo';
  writeSession(root, wt, 'sess-other', 'S-200: bar', [assistantTurn({ input_tokens: 999, output_tokens: 999 })]);
  assert.equal(new ClaudeProvider().getTokens(wt, 'S-100:', root), null);
});

test('ClaudeProvider.getTokens aggregates across multiple session files in one worktree', () => {
  const root = setupProjectsRoot();
  const wt = '/wt/s100-foo';
  writeSession(root, wt, 'sess-workon', 'S-100: workon — title', [
    assistantTurn({ input_tokens: 10, output_tokens: 20 }),
  ]);
  writeSession(root, wt, 'sess-refine', 'S-100: refine — title', [
    assistantTurn({ input_tokens: 1, output_tokens: 2 }),
  ]);

  const totals = new ClaudeProvider().getTokens(wt, 'S-100:', root);
  assert.equal(totals.input, 11);
  assert.equal(totals.output, 22);
});

test('ClaudeProvider.getTokens tolerates malformed JSONL lines', () => {
  const root = setupProjectsRoot();
  const wt = '/wt/s100-foo';
  const dir = join(root, pathToProjectSlug(wt));
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'custom-title', customTitle: 'S-100: foo' }),
    'not-json',
    JSON.stringify(assistantTurn({ input_tokens: 7, output_tokens: 8 })),
    '{partial',
  ];
  writeFileSync(join(dir, 'sess.jsonl'), lines.join('\n'));

  const totals = new ClaudeProvider().getTokens(wt, 'S-100:', root);
  assert.equal(totals.input, 7);
  assert.equal(totals.output, 8);
});

test('ClaudeProvider.getTokens coerces non-numeric usage values to 0 (no string concat)', () => {
  const root = setupProjectsRoot();
  const wt = '/wt/s100-foo';
  writeSession(root, wt, 'sess', 'S-100: foo', [
    assistantTurn({
      input_tokens: 'bogus', // a corrupt JSONL must not stringify into FM
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: undefined,
    }),
  ]);
  const totals = new ClaudeProvider().getTokens(wt, 'S-100:', root);
  assert.equal(totals.input, 0);
  assert.equal(totals.output, 5);
  assert.equal(totals.cache_creation, 0);
  assert.equal(totals.cache_read, 0);
  for (const v of Object.values(totals)) assert.equal(typeof v, 'number');
});

test('ClaudeProvider.getTokens returns null when project dir is missing', () => {
  const root = setupProjectsRoot();
  assert.equal(new ClaudeProvider().getTokens('/wt/never-existed', 'S-100:', root), null);
});

// ---------------------------------------------------------------------------
// tokens_by_step (S-904): per-step usage beside the unit totals.
// ---------------------------------------------------------------------------

const use = (input, output = 0, cache_creation = 0, cache_read = 0) => ({ input, output, cache_creation, cache_read });

test('addUsageToFrontmatter with a step adds to its key, appends new keys, and keeps the totals', () => {
  const fm = {};
  addUsageToFrontmatter(fm, use(1, 2, 3, 4), 'review.1');
  addUsageToFrontmatter(fm, use(10, 20, 30, 40), 'review.2');
  addUsageToFrontmatter(fm, use(100, 200, 300, 400), 'review.2');
  assert.deepEqual(Object.keys(fm.tokens_by_step), ['review.1', 'review.2']);
  assert.deepEqual(fm.tokens_by_step['review.1'], { input: '1', output: '2', cache_creation: '3', cache_read: '4' });
  assert.deepEqual(fm.tokens_by_step['review.2'], {
    input: '110',
    output: '220',
    cache_creation: '330',
    cache_read: '440',
  });
  assert.equal(fm.tokens_input, '111');
  assert.equal(fm.tokens_output, '222');
  assert.equal(fm.tokens_cache_creation, '333');
  assert.equal(fm.tokens_cache_read, '444');
  assert.equal(fm.tokens_headless_input, '111');
  // An earlier key gaining usage keeps its place.
  addUsageToFrontmatter(fm, use(1), 'review.1');
  assert.deepEqual(Object.keys(fm.tokens_by_step), ['review.1', 'review.2']);
  assert.equal(fm.tokens_by_step['review.1'].input, '2');
});

test('a usage of nothing creates no tokens_by_step entry', () => {
  const fm = {};
  addUsageToFrontmatter(fm, null, 'implement');
  addUsageToFrontmatter(fm, use(0, 0, 0, 0), 'implement');
  assert.equal(fm.tokens_by_step, undefined);
  assert.equal(fm.tokens_input, '0', 'the totals are written as before');
  assert.equal(addStepUsageToFrontmatter(fm, 'implement', use(0)), false);
  assert.equal(addStepUsageToFrontmatter(fm, '', use(5)), false);
  assert.equal(fm.tokens_by_step, undefined);
  // Without a step, today's behaviour: totals only.
  addUsageToFrontmatter(fm, use(5));
  assert.equal(fm.tokens_by_step, undefined);
  assert.equal(fm.tokens_input, '5');
});

test('accumulateTokensOnFile reads a CRLF file, writes the map, and keeps the body', () => {
  const dir = mkTempDir('bl-tok-');
  const p = join(dir, 'index.md');
  writeFileSync(p, '---\r\nstory_id: S-1\r\ntitle: T\r\n---\r\n\r\n# T\r\n\r\nBody line.\r\n');
  assert.equal(accumulateTokensOnFile(dir, p, use(3, 4), 'implement'), true);
  const out = readFileSync(p, 'utf8');
  assert.ok(out.endsWith('---\r\n\r\n# T\r\n\r\nBody line.\r\n'), out);
  assert.equal((out.match(/^---/gm) ?? []).length, 2, 'one frontmatter block');
  const { fm } = parseFrontmatter(out.replace(/\r\n/g, '\n'));
  assert.equal(fm.story_id, 'S-1');
  assert.equal(fm.tokens_input, '3');
  assert.deepEqual(fm.tokens_by_step, { implement: { input: '3', output: '4', cache_creation: '0', cache_read: '0' } });
});

test('accumulateTokensOnFile and accumulateStepTokensOnFile leave a file with no frontmatter untouched', () => {
  const dir = mkTempDir('bl-tok-');
  const p = join(dir, 'index.md');
  const content = '# No frontmatter\n\nJust a body.\n';
  writeFileSync(p, content);
  assert.equal(accumulateTokensOnFile(dir, p, use(1), 'implement'), false);
  assert.equal(accumulateStepTokensOnFile(dir, p, 'implement', use(1)), false);
  assert.equal(readFileSync(p, 'utf8'), content);
});

test('accumulateStepTokensOnFile writes the map and the totals, and nothing for no usage', () => {
  const dir = mkTempDir('bl-tok-');
  const p = join(dir, 'index.md');
  const content = '---\nstory_id: S-1\ntokens_input: 7\n---\n\n# T\n';
  writeFileSync(p, content);
  assert.equal(accumulateStepTokensOnFile(dir, p, 'implement', null), false);
  assert.equal(accumulateStepTokensOnFile(dir, p, 'implement', use(0)), false);
  assert.equal(readFileSync(p, 'utf8'), content);
  assert.equal(accumulateStepTokensOnFile(dir, p, 'fix.1', use(2, 1)), true);
  const { fm } = parseFrontmatter(readFileSync(p, 'utf8'));
  assert.equal(fm.tokens_input, '9', 'the totals take the same difference');
  assert.equal(fm.tokens_output, '1');
  assert.equal(fm.tokens_headless_input, undefined);
  assert.deepEqual(fm.tokens_by_step, { 'fix.1': { input: '2', output: '1', cache_creation: '0', cache_read: '0' } });
});

test('tokens_by_step survives a serialize/parse round trip and stepTokens reads it per step', () => {
  const fm = { story_id: 'S-1' };
  addUsageToFrontmatter(fm, use(1, 2), 'implement');
  addUsageToFrontmatter(fm, use(10, 20), 'review.1');
  addUsageToFrontmatter(fm, use(100, 200, 5, 6), 'review.2');
  addUsageToFrontmatter(fm, use(1000), 'fix.1');
  const text = serializeFrontmatter(fm) + '\n# T\n';
  assert.match(text, /^tokens_by_step:\n {2}implement:\n {4}input: "?1"?\n/m);
  const back = parseFrontmatter(text).fm;
  assert.deepEqual(back.tokens_by_step, fm.tokens_by_step);
  assert.deepEqual(stepTokens(back), {
    implement: { input: 1, output: 2, cache_creation: 0, cache_read: 0 },
    review: { input: 110, output: 220, cache_creation: 5, cache_read: 6 },
    fix: { input: 1000, output: 0, cache_creation: 0, cache_read: 0 },
  });
});

test('usageDelta clamps each kind at 0 and is null for nothing or no after', () => {
  assert.deepEqual(usageDelta(use(5, 5, 5, 5), use(7, 3, 5, 9)), use(2n, 0n, 0n, 4n));
  assert.deepEqual(usageDelta(null, use(1, 2, 3, 4)), use(1n, 2n, 3n, 4n));
  assert.equal(usageDelta(use(5, 5, 5, 5), use(5, 5, 5, 5)), null);
  assert.equal(usageDelta(use(9, 9, 9, 9), use(1, 1, 1, 1)), null);
  assert.equal(usageDelta(use(1), null), null);
});

test('mergeStepTokens sums disjoint and overlapping keys', () => {
  const a = {
    implement: { input: '1', output: '2', cache_creation: '0', cache_read: '0' },
    'review.1': { input: '5', output: '0', cache_creation: '0', cache_read: '0' },
  };
  const b = {
    'review.1': { input: '1', output: '1', cache_creation: '1', cache_read: '1' },
    'fix.1': { input: '3', output: '0', cache_creation: '0', cache_read: '0' },
  };
  const out = mergeStepTokens(a, b);
  assert.deepEqual(Object.keys(out), ['implement', 'review.1', 'fix.1']);
  assert.deepEqual(out['review.1'], { input: '6', output: '1', cache_creation: '1', cache_read: '1' });
  assert.deepEqual(out['fix.1'], { input: '3', output: '0', cache_creation: '0', cache_read: '0' });
  assert.equal(a['review.1'].input, '5', 'the inputs are not changed');
  assert.deepEqual(mergeStepTokens(undefined, b), mergeStepTokens(b, ''));
  assert.deepEqual(mergeStepTokens(undefined, undefined), {});
});

test("sessionTokens reads the unit's transcript totals and is null when the provider has none", () => {
  const seen = [];
  const provider = { getTokens: (wt, prefix) => (seen.push([wt, prefix]), use(4)) };
  assert.deepEqual(sessionTokens(provider, '/wt', 'S-1'), use(4));
  assert.deepEqual(seen, [['/wt', 'S-1:']]);
  assert.equal(sessionTokens({ getTokens: () => null }, '/wt', 'S-1'), null);
  assert.equal(
    sessionTokens(
      {
        getTokens: () => {
          throw new Error('getTokens() not implemented');
        },
      },
      '/wt',
      'S-1',
    ),
    null,
  );
  assert.throws(
    () =>
      sessionTokens(
        {
          getTokens: () => {
            throw new Error('boom');
          },
        },
        '/wt',
        'S-1',
      ),
    /boom/,
  );
});

test('tokensStepKey: steps as they are, review passes and fixes by round', () => {
  assert.equal(tokensStepKey('implement', 2), 'implement');
  assert.equal(tokensStepKey('fix-tests', 1), 'fix-tests');
  assert.equal(tokensStepKey('self-review', undefined), 'self-review');
  assert.equal(tokensStepKey('merge-resolve', 3), 'merge-resolve');
  assert.equal(tokensStepKey('review:correctness', 2), 'review.2');
  assert.equal(tokensStepKey('review:verify', 2), 'review.2');
  assert.equal(tokensStepKey('fix', 1), 'fix.1');
  assert.equal(tokensStepKey('fix-self-review', 3), 'fix-self-review.3');
  // No round yet: the bare step, never `fix.undefined`.
  assert.equal(tokensStepKey('fix', undefined), 'fix');
  assert.equal(tokensStepKey('review:verify', 0), 'review');
});

test('step-usage-rejects-nonfinite-and-fractional-counts-consistently', async () => {
  const { tokensByStepProblems } = await import('../../src/validate.js');
  const dir = mkTempDir('bl-tokens-shapes-');
  // [count as the provider reports it, the count every writer stores]
  const cases = [
    [3, 3],
    ['3', 3],
    [0.6, 0],
    ['3.5', 0],
    [-1, 0],
    [Infinity, 0],
    [NaN, 0],
    [1e20, 0],
    ['1e3', 0],
    [null, 0],
    [true, 0],
  ];
  for (const [input, want] of cases) {
    const usage = { input, output: 0, cache_creation: 0, cache_read: 0 };
    const label = `input ${String(input)}`;
    const entry = (map) => (map?.implement ? Number(map.implement.input) : 0);
    // Headless: totals, headless totals and the map, in memory and on file.
    const fm = {};
    addUsageToFrontmatter(fm, usage, 'implement');
    assert.equal(fm.tokens_input, String(want), `${label}: totals`);
    assert.equal(fm.tokens_headless_input, String(want), `${label}: headless totals`);
    assert.equal(entry(fm.tokens_by_step), want, `${label}: map`);
    assert.deepEqual(tokensByStepProblems(fm.tokens_by_step ?? {}), [], `${label}: the map validates`);
    // Interactive: the map and the totals on file, from a transcript difference.
    const path = join(dir, 'index.md');
    writeFileSync(path, '---\ntokens_input: 0\n---\n\nBody\n');
    accumulateStepTokensOnFile(dir, path, 'implement', usageDelta(null, usage));
    const onFile = parseFrontmatter(readFileSync(path, 'utf8')).fm;
    assert.equal(Number(onFile.tokens_input), want, `${label}: interactive totals`);
    assert.equal(entry(onFile.tokens_by_step), want, `${label}: interactive map`);
    // The merge fold.
    const merged = mergeStepTokens({}, { implement: usage });
    assert.equal(entry(merged), want, `${label}: merge`);
    assert.deepEqual(tokensByStepProblems(merged), [], `${label}: the merged map validates`);
  }
});

test('overlapping_token_writers_preserve_committed_steps', async () => {
  const { spawn } = await import('child_process');
  const { existsSync, rmSync } = await import('fs');
  const { specLockPath } = await import('../../src/spec-file.js');
  const dir = mkTempDir('bl-tokens-race-');
  const path = join(dir, 'index.md');
  writeFileSync(path, '---\nstory_id: S-1\n---\n\nBody\n');
  const tokensUrl = new URL('../../src/tokens.js', import.meta.url).href;
  // Each writer adds one input token per call: headless under its own step
  // and a shared one, interactive under its own step.
  const writer = (n, calls) => `
    const { accumulateTokensOnFile, accumulateStepTokensOnFile } = await import(${JSON.stringify(tokensUrl)});
    const use = { input: 1, output: 0, cache_creation: 0, cache_read: 0 };
    for (let i = 0; i < ${calls}; i++) {
      if (!accumulateTokensOnFile(${JSON.stringify(dir)}, ${JSON.stringify(path)}, use, i % 2 ? "review.1" : "w${n}")) process.exit(2);
      if (!accumulateStepTokensOnFile(${JSON.stringify(dir)}, ${JSON.stringify(path)}, "i${n}", use)) process.exit(3);
    }`;
  const run = (n, calls) =>
    new Promise((done) =>
      spawn(process.execPath, ['--input-type=module', '-e', writer(n, calls)], { stdio: 'inherit' }).on('exit', done),
    );
  const WRITERS = 4;
  const CALLS = 20;
  // A live holder (this process) delays every writer until it lets go.
  const lock = specLockPath(path);
  writeFileSync(lock, `${process.pid}\n`);
  const exits = Promise.all(Array.from({ length: WRITERS }, (_, n) => run(n, CALLS)));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readFileSync(path, 'utf8'), '---\nstory_id: S-1\n---\n\nBody\n', 'nobody writes past a held lock');
  rmSync(lock);
  assert.deepEqual(await exits, Array(WRITERS).fill(0));
  const { fm } = parseFrontmatter(readFileSync(path, 'utf8'));
  const steps = fm.tokens_by_step;
  for (let n = 0; n < WRITERS; n++) {
    assert.equal(steps[`w${n}`].input, String(CALLS / 2), `w${n}`);
    assert.equal(steps[`i${n}`].input, String(CALLS), `i${n}`);
  }
  assert.equal(steps['review.1'].input, String((WRITERS * CALLS) / 2), 'the shared step');
  assert.equal(fm.tokens_input, String(WRITERS * CALLS * 2), 'the totals');
  assert.equal(fm.tokens_headless_input, String(WRITERS * CALLS));
  assert.equal(existsSync(lock), false, 'the lock is released');
});

test('valid_large_counts_survive_merge_and_repeated_accumulation', async () => {
  const { tokensByStepProblems } = await import('../../src/validate.js');
  const MAX = Number.MAX_SAFE_INTEGER;
  const big = String(2n ** 53n); // one past the largest safe number
  const kinds = (input) => ({ input: String(input), output: '0', cache_creation: '0', cache_read: '0' });
  assert.deepEqual(tokensByStepProblems({ implement: kinds(big) }), [], 'the validator accepts it');
  // Every writer that reads a stored count or a provider count, below, at
  // and across the safe-integer boundary: [name, run, expected input].
  const cases = [
    ['merge keeps a large entry', () => mergeStepTokens({}, { implement: kinds(big) }).implement.input, big],
    [
      'merge sums across the boundary',
      () => mergeStepTokens({ implement: kinds(MAX) }, { implement: kinds(MAX) }).implement.input,
      String(2n * BigInt(MAX)),
    ],
    [
      'merge keeps an ordinary entry',
      () => mergeStepTokens({ implement: kinds(3) }, { implement: kinds(4) }).implement.input,
      '7',
    ],
    [
      'headless usage accumulates three maximal counts, map and totals',
      () => {
        const fm = {};
        for (let i = 0; i < 3; i++) addUsageToFrontmatter(fm, use(MAX), 'implement');
        assert.equal(fm.tokens_input, fm.tokens_by_step.implement.input, 'map and totals agree');
        assert.equal(fm.tokens_headless_input, fm.tokens_input);
        return fm.tokens_input;
      },
      String(3n * BigInt(MAX)),
    ],
    [
      'step usage adds onto a large stored entry',
      () => {
        const fm = { tokens_by_step: { implement: kinds(big) } };
        addStepUsageToFrontmatter(fm, 'implement', use(1));
        return fm.tokens_by_step.implement.input;
      },
      String(2n ** 53n + 1n),
    ],
    [
      'interactive difference adds onto large stored totals and entry',
      () => {
        const path = join(mkTempDir('bl-tokens-big-'), 'index.md');
        writeFileSync(path, `---\nstory_id: S-1\ntokens_input: "${big}"\n---\n\nBody\n`);
        accumulateStepTokensOnFile(dirname(path), path, 'implement', use(MAX));
        accumulateStepTokensOnFile(dirname(path), path, 'implement', use(MAX));
        const { fm } = parseFrontmatter(readFileSync(path, 'utf8'));
        assert.equal(fm.tokens_by_step.implement.input, String(2n * BigInt(MAX)), 'map');
        return fm.tokens_input;
      },
      String(2n ** 53n + 2n * BigInt(MAX)),
    ],
    [
      'difference between large transcript totals',
      () => String(usageDelta(kinds(big), kinds(`${big}0`)).input),
      String(2n ** 53n * 9n),
    ],
  ];
  for (const [name, run, expected] of cases) assert.equal(run(), expected, name);
  // Provider numbers past the safe range are still rejected: they may already be rounded.
  assert.equal(usageDelta(null, use(2 ** 53)), null, 'an unsafe provider number');
});

test('token_lock_reclaim_cannot_remove_new_live_holder', async () => {
  const fs = (await import('fs')).default;
  const { syncBuiltinESMExports } = await import('module');
  const { spawnSync } = await import('child_process');
  const { specLockPath, withSpecLock, SpecLockError } = await import('../../src/spec-file.js');
  const deadPid = spawnSync('true', { stdio: ['ignore', 'pipe', 'pipe'] }).pid;
  const dir = mkTempDir('bl-tokens-reclaim-');
  const path = join(dir, 'index.md');
  writeFileSync(path, '---\nstory_id: S-1\n---\n\nBody\n');
  const lock = specLockPath(path);
  const live = `${process.pid}\nnew live holder\n`;
  // Each case: the lock's state before a writer tries it, whether the writer
  // runs, and what the lock holds afterwards (null: released).
  const cases = {
    free: { before: null, runs: true, after: null },
    'live-held': { before: live, runs: false, after: live },
    'dead-held': { before: `${deadPid}\nstale\n`, runs: true, after: null },
    // The old holder releases between the writer's create and its look at
    // the lock, and a new holder takes it while the writer finds it missing.
    'release/reacquire': { before: `${process.pid}\nold holder\n`, runs: false, after: live, race: true },
    // A dead reclaimer's mutex is cleared, and a new reclaimer's is not.
    'dead-held, live reclaim mutex': {
      before: `${deadPid}\nstale\n`,
      mutex: live,
      runs: false,
      after: `${deadPid}\nstale\n`,
    },
    'dead-held, dead reclaim mutex': {
      before: `${deadPid}\nstale\n`,
      mutex: `${deadPid}\nreclaim\n`,
      runs: true,
      after: null,
    },
  };
  const { readFileSync: read, linkSync: link } = fs;
  for (const [name, c] of Object.entries(cases)) {
    fs.rmSync(lock, { force: true });
    fs.rmSync(`${lock}.reclaim`, { force: true });
    if (c.before) writeFileSync(lock, c.before);
    if (c.mutex) writeFileSync(`${lock}.reclaim`, c.mutex);
    if (c.race) {
      let released = false;
      let retaken = false;
      fs.linkSync = (src, dest) => {
        if (dest === lock && !released) {
          released = true;
          fs.unlinkSync(lock);
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
        return link(src, dest);
      };
      fs.readFileSync = (p, ...args) => {
        try {
          return read(p, ...args);
        } catch (e) {
          // Inside the reclaim mutex, where the reclaimer decides what to remove.
          if (p === lock && released && !retaken && fs.existsSync(`${lock}.reclaim`)) {
            retaken = true;
            writeFileSync(lock, live);
          }
          throw e;
        }
      };
      syncBuiltinESMExports();
    }
    let ran = false;
    try {
      withSpecLock(path, () => (ran = true), { waitMs: 50 });
    } catch (e) {
      // A lock that never frees throws instead of running the writer.
      if (!(e instanceof SpecLockError)) throw e;
    } finally {
      fs.readFileSync = read;
      fs.linkSync = link;
      syncBuiltinESMExports();
    }
    assert.equal(ran, c.runs, `${name}: writer ran`);
    assert.equal(fs.existsSync(lock) ? read(lock, 'utf8') : null, c.after, `${name}: lock afterwards`);
    if (!c.mutex || c.runs) assert.equal(fs.existsSync(`${lock}.reclaim`), false, `${name}: reclaim mutex released`);
  }
  fs.rmSync(lock, { force: true });
  fs.rmSync(`${lock}.reclaim`, { force: true });
});

test('reconciliation_snapshot_and_commit_share_token_lock', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { readAllFeatures } = await import('../../src/feature.js');
  const { recordFeatureTokens } = await import('../../src/feature-cmd.js');
  const { recordStoryTokens } = await import('../../src/tokens.js');
  const { specLockPath } = await import('../../src/spec-file.js');
  const { liveLockHolder } = await import('../../src/pid-lock.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: './code' },
    components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
    stories: [{ id: 'S-1', component: 'C00', title: 'T', dirSuffix: 'a', feature: 'F-1' }],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', stories: ['S-1'], branch: 'f1-feat' }],
  });
  const getTokens = ClaudeProvider.prototype.getTokens;
  try {
    const config = loadConfig({ backlogRoot: dir });
    const [feature] = readAllFeatures(config);
    // Every transcript-total writer: the story's and the feature's re-read.
    const writers = {
      story: { path: join(dir, 'stories', 'S1-a', 'index.md'), record: () => recordStoryTokens('S-1', config) },
      feature: { path: feature.indexPath, record: () => recordFeatureTokens(feature, config) },
    };
    const isUnitDir = await unitDirTest(config);
    for (const [name, { path, record }] of Object.entries(writers)) {
      // A session difference committed before the re-read: the map holds 15.
      assert.equal(accumulateStepTokensOnFile(dir, path, 'implement', use(15)), true, name);
      const held = [];
      // The session started in the unit directory: its transcripts are there.
      ClaudeProvider.prototype.getTokens = (p) => {
        held.push(liveLockHolder(specLockPath(path)));
        return isUnitDir(p) ? use(15) : null;
      };
      record();
      assert.ok(
        held.length > 0 && held.every((pid) => pid === process.pid),
        `${name}: transcripts read under the token lock`,
      );
      const { fm } = parseFrontmatter(readFileSync(path, 'utf8'));
      assert.equal(fm.tokens_input, '15', `${name}: totals`);
      assert.equal(fm.tokens_by_step.implement.input, '15', `${name}: map`);
    }
  } finally {
    ClaudeProvider.prototype.getTokens = getTokens;
    cleanup();
  }
});

test('token writers stay best-effort when the lock cannot be created', () => {
  const dir = mkTempDir('bl-tokens-nolock-');
  const path = join(dir, 'index.md');
  const before = '---\nstory_id: S-1\n---\n\nBody\n';
  writeFileSync(path, before);
  const use = { input: 1, output: 0, cache_creation: 0, cache_read: 0 };
  // The lock lives in the temp dir: one that does not exist fails its creation.
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = join(dir, 'missing');
  try {
    assert.equal(accumulateTokensOnFile(dir, path, use, 'implement'), false, 'headless');
    assert.equal(accumulateStepTokensOnFile(dir, path, 'implement', use), false, 'interactive');
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  assert.equal(readFileSync(path, 'utf8'), before, 'nothing written without the lock');
});

test('interactive_crlf_reconciliation_preserves_frontmatter', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { recordStoryTokens } = await import('../../src/tokens.js');
  const { dir, cleanup } = mkTempBacklog({
    repos: { code: './code' },
    components: [{ id: 'C00', title: 'Core', repo: 'code', home: true }],
    stories: [{ id: 'S-1', component: 'C00', title: 'T', dirSuffix: 'a' }],
  });
  const getTokens = ClaudeProvider.prototype.getTokens;
  try {
    const config = loadConfig({ backlogRoot: dir });
    const path = join(dir, 'stories', 'S1-a', 'index.md');
    assert.equal(accumulateStepTokensOnFile(dir, path, 'implement', use(15)), true);
    // The same spec as a CRLF checkout (git autocrlf, a hand edit) leaves it.
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n/g, '\r\n'));
    const isUnitDir = await unitDirTest(config);
    ClaudeProvider.prototype.getTokens = (p) => (isUnitDir(p) ? use(20) : null);
    assert.equal(recordStoryTokens('S-1', config), true);
    const out = readFileSync(path, 'utf8');
    assert.equal(out.replace(/\r\n/g, '').includes('\n'), false, 'written back CRLF');
    assert.equal((out.match(/^---\r$/gm) ?? []).length, 2, 'one frontmatter block');
    const { fm } = parseFrontmatter(out.replace(/\r\n/g, '\n'));
    assert.equal(fm.story_id, 'S-1');
    assert.equal(fm.tokens_input, '20');
    assert.equal(fm.tokens_by_step.implement.input, '15');
  } finally {
    ClaudeProvider.prototype.getTokens = getTokens;
    cleanup();
  }
});

test('applyFeatureTokens sums headless totals past 2^53 and 1e21 exactly', async () => {
  const { applyFeatureTokens } = await import('../../src/tokens.js');
  const past53 = String(2n ** 53n + 1n);
  const past1e21 = '1000000000000000000001';
  const fm = {
    tokens_headless_input: past53,
    tokens_headless_output: past1e21,
    tokens_headless_cache_creation: '7',
  };
  applyFeatureTokens(fm, use(2, 3, 4, 5));
  assert.equal(fm.tokens_input, String(2n ** 53n + 3n));
  assert.equal(fm.tokens_output, '1000000000000000000004');
  assert.equal(fm.tokens_cache_creation, '11');
  assert.equal(fm.tokens_cache_read, '5');
  applyFeatureTokens(fm, null);
  assert.equal(fm.tokens_output, past1e21, 'no transcripts: the headless totals stand');
});

test('recordFeatureTokens_sums_safe_provider_counts_across_repos_past_2pow53_for_every_kind', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { readAllFeatures } = await import('../../src/feature.js');
  const { recordFeatureTokens } = await import('../../src/feature-cmd.js');
  const { recordStoryTokens } = await import('../../src/tokens.js');
  const half = 4503599627370497; // 2^52 + 1: safe, twice it is not
  const kinds = ['input', 'output', 'cache_creation', 'cache_read'];
  const all = (v) => ({ input: v, output: v, cache_creation: v, cache_read: v });
  // [name, each worktree's transcript totals, the feature's headless total, the feature's total per kind (undefined: none written)]
  const cases = [
    ['ordinary', all(7), null, '14'],
    ['past 2^53', all(half), null, '9007199254740994'],
    ['past 2^53 as BigInt', all(BigInt(half)), null, '9007199254740994'],
    ['past 2^53 with headless', all(half), '3', '9007199254740997'],
    ['no transcripts', null, null, undefined],
  ];
  const getTokens = ClaudeProvider.prototype.getTokens;
  for (const [name, u, headless, expected] of cases) {
    const { dir, cleanup } = mkTempBacklog({
      repos: { a: './a', b: './b' },
      components: [
        { id: 'C00', title: 'A', repo: 'a' },
        { id: 'C01', title: 'B', repo: 'b' },
      ],
      stories: [
        { id: 'S-1', title: 'A', component: 'C00', dirSuffix: 'a', feature: 'F-1' },
        { id: 'S-2', title: 'B', component: 'C01', dirSuffix: 'b', feature: 'F-1' },
      ],
      features: [{ id: 'F-1', title: 'F', status: 'running', stories: ['S-1', 'S-2'] }],
    });
    try {
      const config = loadConfig({ backlogRoot: dir });
      const [feature] = readAllFeatures(config);
      if (headless) {
        const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
        for (const k of kinds) fm[`tokens_headless_${k}`] = headless;
        writeFileSync(feature.indexPath, serializeFrontmatter(fm) + body);
      }
      // Transcripts of sessions that started in each worktree (before F-60
      // D3); the unit directory has none.
      const isUnitDir = await unitDirTest(config);
      ClaudeProvider.prototype.getTokens = (p) => (isUnitDir(p) ? null : u);
      recordFeatureTokens(feature, config);
      const { fm } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
      for (const k of kinds) assert.equal(fm[`tokens_${k}`], expected, `${name}: feature ${k}`);
      // A story's re-read: one worktree, whose count past 2^53 stays exact.
      const story = u && all(BigInt(u.input) * 2n);
      ClaudeProvider.prototype.getTokens = (p) => (isUnitDir(p) ? null : story);
      recordStoryTokens('S-1', config);
      const sfm = parseFrontmatter(readFileSync(join(dir, 'stories', 'S1-a', 'index.md'), 'utf8')).fm;
      for (const k of kinds)
        assert.equal(sfm[`tokens_${k}`], story ? String(story[k]) : undefined, `${name}: story ${k}`);
    } finally {
      ClaudeProvider.prototype.getTokens = getTokens;
      cleanup();
    }
  }
});

test('transcript_reconciliation_never_zeros_usage_when_provider_number_exceeds_safe_range', async () => {
  const { mkTempBacklog } = await import('../helpers/tempdir.js');
  const { loadConfig } = await import('../../src/config.js');
  const { readAllFeatures } = await import('../../src/feature.js');
  const { recordFeatureTokens } = await import('../../src/feature-cmd.js');
  const { recordStoryTokens, collectStoryTokens } = await import('../../src/tokens.js');
  const kinds = ['input', 'output', 'cache_creation', 'cache_read'];
  const all = (v) => ({ input: v, output: v, cache_creation: v, cache_read: v });
  const unsafe = 9007199254740992; // 2^53: not a safe integer
  // [name, the first worktree's totals, the second's, the inexact one]: the feature reads both
  // worktrees, the story the inexact one, so neither may be written.
  const cases = [
    ['unsafe in every kind, both worktrees', all(unsafe), all(unsafe), all(unsafe)],
    ['unsafe in the first, valid in the second', all(unsafe), all(5), all(unsafe)],
    ['valid in the first, unsafe in the second', all(5), all(unsafe), all(unsafe)],
    ['exact string in the first, unsafe in the second', all('9007199254740992'), all(unsafe), all(unsafe)],
    ['fractional in the first', all(1.5), all(5), all(1.5)],
    ['negative in the first', all(-1), all(5), all(-1)],
    ['non-digit string in the first', all('12k'), all(5), all('12k')],
    ...kinds.map((k) => [`unsafe in ${k} only`, { ...all(5), [k]: unsafe }, all(5), { ...all(5), [k]: unsafe }]),
  ];
  const getTokens = ClaudeProvider.prototype.getTokens;
  for (const [name, a, b, bad] of cases) {
    for (const headless of [null, '3']) {
      const { dir, cleanup } = mkTempBacklog({
        repos: { a: './a', b: './b' },
        components: [
          { id: 'C00', title: 'A', repo: 'a' },
          { id: 'C01', title: 'B', repo: 'b' },
        ],
        stories: [
          { id: 'S-1', title: 'A', component: 'C00', dirSuffix: 'a', feature: 'F-1' },
          { id: 'S-2', title: 'B', component: 'C01', dirSuffix: 'b', feature: 'F-1' },
        ],
        features: [{ id: 'F-1', title: 'F', status: 'running', stories: ['S-1', 'S-2'] }],
      });
      try {
        const config = loadConfig({ backlogRoot: dir });
        const [feature] = readAllFeatures(config);
        const storyPath = join(dir, 'stories', 'S1-a', 'index.md');
        // Persisted totals from an earlier reconciliation, and the feature's headless usage.
        for (const path of [feature.indexPath, storyPath]) {
          const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
          for (const k of kinds) {
            fm[`tokens_${k}`] = '7';
            if (headless && path === feature.indexPath) fm[`tokens_headless_${k}`] = headless;
          }
          writeFileSync(path, serializeFrontmatter(fm) + body);
        }
        const before = [feature.indexPath, storyPath].map((path) => readFileSync(path, 'utf8'));
        let calls = 0;
        ClaudeProvider.prototype.getTokens = () => (calls++ === 0 ? a : b);
        recordFeatureTokens(feature, config);
        ClaudeProvider.prototype.getTokens = () => bad;
        recordStoryTokens('S-1', config);
        // `bl done` reconciles with collectStoryTokens: null leaves its totals alone.
        assert.equal(collectStoryTokens('S-1', config), null, `${name}: bl done's totals`);
        assert.equal(
          readFileSync(feature.indexPath, 'utf8'),
          before[0],
          `${name}, headless ${headless}: feature unchanged`,
        );
        assert.equal(readFileSync(storyPath, 'utf8'), before[1], `${name}, headless ${headless}: story unchanged`);
      } finally {
        ClaudeProvider.prototype.getTokens = getTokens;
        cleanup();
      }
    }
  }
});
