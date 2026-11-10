import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, parseFrontmatter, serializeFrontmatter, FrontmatterError } from '../../src/config.js';
import { extractSection, replaceSection } from '../../src/feature.js';
import { runFeature, tokensStepKey, restoreKeepingTokens } from '../../src/feature-run.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { tokensLines } from '../../src/feature-cmd.js';
import { accumulateTokensOnFile } from '../../src/tokens.js';
import { _hooks as atomicHooks } from '../../src/atomic-write.js';
import { installPartialWrites } from '../helpers/partial-write.js';
import { startTokenWriter } from '../helpers/token-writer.js';
import { setup, CH, editFile, verifySession, fakeRunner, spendLimit } from '../helpers/feature-run-fixture.js';
import { reviewOutcome } from '../helpers/outcomes.js';
import { statusOf as logStatusOf } from '../../src/transition.js';

// ---------------------------------------------------------------------------
// Tokens per step (S-904)
// ---------------------------------------------------------------------------

/**
 * Wrap `runner.session` like runHeadlessSession(): every spawn, refused or
 * not, reports one input token and adds it to the unit file under the key the
 * loop passed. `throwAt` (1-based) makes that spawn throw instead, as a
 * killed `bl` would leave it: nothing recorded for it.
 */
function recordingStepTokens(runner, { throwAt = 0 } = {}) {
  const session = runner.session;
  const keys = [];
  runner.session = (o) => {
    keys.push(o.tokensStep);
    if (keys.length === throwAt) throw new Error('killed');
    const usage = { input: 1, output: 0, cache_creation: 0, cache_read: 0 };
    accumulateTokensOnFile(o.config.backlogRoot, o.usageIndexPath, usage, o.tokensStep);
    return { ...session(o), usage };
  };
  return keys;
}

const stepInputs = (feature) => {
  const { fm } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
  return { fm, steps: Object.fromEntries(Object.entries(fm.tokens_by_step ?? {}).map(([k, v]) => [k, v.input])) };
};

test('tokens_by_step: a run records each session under its step and review round', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    const keys = recordingStepTokens(runner);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    assert.deepEqual(keys, [
      'implement',
      'implement',
      'self-review',
      'review.1',
      'review.1',
      'review.1',
      'fix.1',
      'fix-self-review.1',
      'review.2',
      'review.2',
      'review.2',
    ]);
    const { fm, steps } = stepInputs(feature);
    assert.deepEqual(steps, {
      implement: '2',
      'self-review': '1',
      'review.1': '3',
      'fix.1': '1',
      'fix-self-review.1': '1',
      'review.2': '3',
    });
    assert.equal(fm.tokens_input, '11', 'the totals count every session, as before');
    assert.equal(fm.tokens_headless_input, '11');
  } finally {
    cleanup();
  }
});

test('tokens_by_step: a session refused for a usage limit and its rerun add up under one key', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let hits = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        limit: (o) =>
          o.promptName === 'feature-story' && o.vars.storyId === 'S-1' && hits++ === 0 ? spendLimit(runner) : null,
      },
    });
    recordingStepTokens(runner);
    const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.equal(state.status, 'clean');
    const { fm, steps } = stepInputs(feature);
    assert.equal(steps.implement, '3', "S-1's refusal and rerun, and S-2");
    assert.equal(fm.tokens_input, '12');
  } finally {
    cleanup();
  }
});

test("tokens_by_step: a run killed mid-session keeps the earlier sessions' entries", async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    const runner = fakeRunner({ dir, feature });
    // The fifth spawn is review round 1's second pass.
    recordingStepTokens(runner, { throwAt: 5 });
    await assert.rejects(runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } }), /killed/);
    const { fm, steps } = stepInputs(feature);
    assert.deepEqual(steps, { implement: '2', 'self-review': '1', 'review.1': '1' });
    assert.equal(fm.tokens_input, '4');
  } finally {
    cleanup();
  }
});

test("tokensStepKey: the run loop's keys for each session", () => {
  assert.equal(tokensStepKey('implement', undefined), 'implement');
  assert.equal(tokensStepKey('fix-tests', 1), 'fix-tests');
  assert.equal(tokensStepKey('self-review', undefined), 'self-review');
  assert.equal(tokensStepKey('review:correctness', 2), 'review.2');
  assert.equal(tokensStepKey('review:verify', 2), 'review.2');
  assert.equal(tokensStepKey('fix', 1), 'fix.1');
  assert.equal(tokensStepKey('merge-resolve', 2), 'merge-resolve');
});

test('bl status tokens lines: totals and one line per step, totals alone, or nothing', () => {
  const totals = {
    tokens_input: '1234',
    tokens_output: '56',
    tokens_cache_creation: '0',
    tokens_cache_read: '1000000',
  };
  assert.deepEqual(tokensLines({}), []);
  assert.deepEqual(tokensLines({ tokens_by_step: { implement: { input: '1' } } }), [], 'no totals, nothing');
  assert.deepEqual(tokensLines(totals), ['tokens: input 1,234 · output 56 · cache_creation 0 · cache_read 1,000,000']);
  assert.deepEqual(
    tokensLines({
      ...totals,
      tokens_by_step: {
        'review.1': { input: '10', output: '2', cache_creation: '0', cache_read: '3000' },
        implement: { input: '1200', output: '50', cache_creation: '0', cache_read: '0' },
      },
    }),
    [
      'tokens: input 1,234 · output 56 · cache_creation 0 · cache_read 1,000,000',
      '  review.1: input 10 · output 2 · cache_creation 0 · cache_read 3,000',
      '  implement: input 1,200 · output 50 · cache_creation 0 · cache_read 0',
    ],
    'keys in file order',
  );
});

test('interactive-run-refreshes-totals-for-story-and-feature-after-each-session', async () => {
  const { defaultRunner } = await import('../../src/feature-run.js');
  const { ClaudeProvider } = await import('../../src/agents/claude.js');
  const { spawn, getTokens } = ClaudeProvider.prototype;
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  const { dir, cleanup } = mkTempBacklog();
  // Each spawn adds 5 input tokens to the worktree's transcript.
  let transcript = 10;
  ClaudeProvider.prototype.spawn = () => {
    transcript += 5;
    return { status: 0 };
  };
  ClaudeProvider.prototype.getTokens = () => ({ input: transcript, output: 0, cache_creation: 0, cache_read: 0 });
  try {
    const config = loadConfig({ backlogRoot: dir });
    const units = [
      ['story', '---\nstory_id: S-1\ntitle: T\ntokens_input: 10\n---\n\n# T\n', { id: 'S-1' }],
      [
        'feature',
        '---\nfeature_id: F-1\ntitle: T\ntokens_input: 10\ntokens_headless_input: 0\n---\n\n# T\n',
        { id: 'F-1' },
      ],
    ];
    for (const [kind, content, parsed] of units) {
      const indexPath = join(dir, `${kind}.md`);
      writeFileSync(indexPath, content);
      for (const [n, step] of [
        [1, 'self-review'],
        [2, 'review.1'],
      ]) {
        defaultRunner({ interactive: true }).session({
          mode: 'workon',
          agent: 'claude',
          promptName: 'feature-self-review',
          vars: {},
          worktreePath: mkTempDir('bl-wt-'),
          config,
          parsed,
          label: `${parsed.id}: T`,
          usageIndexPath: indexPath,
          tokensStep: step,
        });
        const { fm } = parseFrontmatter(readFileSync(indexPath, 'utf8'));
        assert.equal(fm.tokens_by_step[step].input, '5', `${kind} session ${n}: step`);
        assert.equal(fm.tokens_input, String(10 + 5 * n), `${kind} session ${n}: totals`);
      }
    }
  } finally {
    Object.assign(ClaudeProvider.prototype, { spawn, getTokens });
    if (tmux != null) process.env.TMUX = tmux;
    cleanup();
  }
});

// F-67 S-1098: the loop's spec writes go through updateSpecFile.

test('an escalation write overlapping a token write in another process keeps both', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let gates = 0;
    let writer = null;
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        // The token writer has read the feature, and holds its lock, when
        // the second failed gate escalates.
        shell: (cmd) => {
          if (cmd === 'npm test' && ++gates === 2) writer = startTokenWriter(dir, feature.indexPath, 'overlap');
          return null;
        },
      },
    });
    const state = await runFeature({ feature, config, prep, runner });
    assert.equal(state.status, 'escalated');
    assert.ok(writer, 'the gate ran twice');
    assert.equal(await writer.done, 0);
    const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.equal(logStatusOf('feature', fm), 'escalated');
    assert.match(extractSection(body, 'Escalation'), /test gate failed twice/);
    assert.equal(fm.tokens_by_step?.overlap?.input, '7', "the token writer's step entry is kept");
  } finally {
    cleanup();
  }
});

test('a failed escalation write leaves the previous feature file and no staging file', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let gates = 0;
    let before = null;
    let restore = null;
    const runner = fakeRunner({
      dir,
      feature,
      testResults: [1, 1],
      behaviour: {
        shell: (cmd) => {
          if (cmd === 'npm test' && ++gates === 2) {
            before = readFileSync(feature.indexPath, 'utf8');
            restore = installPartialWrites(feature.indexPath);
          }
          return null;
        },
      },
    });
    try {
      await assert.rejects(runFeature({ feature, config, prep, runner }), /ENOSPC/);
    } finally {
      restore?.();
    }
    assert.ok(before, 'the gate ran twice');
    assert.equal(readFileSync(feature.indexPath, 'utf8'), before, 'the previous file, whole');
    const staging = join(dir, '.bl', 'tmp');
    assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], [], 'no staging file left');
  } finally {
    cleanup();
  }
});

test("restoreKeepingTokens writes the snapshot back with the current file's token keys", () => {
  const { dir, cleanup, feature } = setup();
  try {
    const snapshot = readFileSync(feature.indexPath, 'utf8');
    const snap = parseFrontmatter(snapshot);
    editFile(feature.indexPath, (fm, body) => {
      fm.status = 'verifier-edit';
      fm.tokens_input = '9';
      fm.tokens_headless_input = '9';
      fm.tokens_updated = '2026-10-27';
      fm.tokens_by_step = { 'review.1': { input: '9', output: '0', cache_creation: '0', cache_read: '0' } };
      return `${body}\nverifier text\n`;
    });
    const current = parseFrontmatter(readFileSync(feature.indexPath, 'utf8')).fm;
    assert.equal(restoreKeepingTokens(dir, feature.indexPath, snapshot), true);
    const after = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    const tokens = (fm) => Object.fromEntries(Object.entries(fm).filter(([k]) => k.startsWith('tokens_')));
    const rest = (fm) => Object.fromEntries(Object.entries(fm).filter(([k]) => !k.startsWith('tokens_')));
    assert.deepEqual(tokens(after.fm), tokens(current), "the session's usage is kept");
    assert.deepEqual(rest(after.fm), rest(snap.fm), "the rest of the frontmatter is the snapshot's");
    assert.equal(after.body, snap.body, "the body is the snapshot's");
    // With the token keys taken out, the file is the snapshot byte for byte.
    const strip = (text) => {
      const { fm, body } = parseFrontmatter(text);
      return serializeFrontmatter(rest(fm)) + body;
    };
    assert.equal(strip(readFileSync(feature.indexPath, 'utf8')), strip(snapshot));
  } finally {
    cleanup();
  }
});

test('a failed review-verify session keeps the usage it recorded on the feature, and drops its edits', async () => {
  const { dir, cleanup, config, feature, prep } = setup();
  try {
    let failed = false;
    let round = 0;
    const runner = fakeRunner({
      dir,
      feature,
      behaviour: {
        verify: () => {
          if (!failed) {
            editFile(feature.indexPath, (fm, body) => {
              fm.verifier_edit = 'x';
              return `${body}\nverifier text\n`;
            });
            // A session that failed with an outcome: the failure, not the outcome, decides.
            return reviewOutcome();
          }
          round += 1;
          return verifySession(CH(feature), { pending: round === 1, round });
        },
      },
    });
    const session = runner.session;
    runner.session = (o) => {
      const r = session(o);
      if (o.promptName !== 'review-verify' || failed) return r;
      failed = true;
      return { ...r, ok: false, isError: true, error: 'provider crashed' };
    };
    const keys = recordingStepTokens(runner);
    await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
    assert.ok(failed, 'the verifier ran');
    const { fm, body } = parseFrontmatter(readFileSync(feature.indexPath, 'utf8'));
    assert.equal(fm.verifier_edit, undefined, "the failed verifier's edit is gone");
    assert.doesNotMatch(body, /verifier text/);
    assert.equal(fm.tokens_input, String(keys.length), "every session's usage, the failed verifier's included");
    const stepSum = Object.values(fm.tokens_by_step).reduce((n, e) => n + Number(e.input), 0);
    assert.equal(stepSum, keys.length, 'and its tokens_by_step entry');
  } finally {
    cleanup();
  }
});

test('failed_verify_restores_missing_or_malformed_spec_and_change_document', async () => {
  const dir = mkTempDir('bl-restore-');
  const path = join(dir, 'index.md');
  const snapshot = '---\nfeature_id: F-1\nstatus: running\ntokens_input: 1\n---\n\nOriginal\n';
  const crlf = (t) => t.replace(/\n/g, '\r\n');
  try {
    // The live file the failed session left: its readable token keys are kept, its line end too; an unreadable one gets the snapshot whole.
    const live = {
      valid: [
        '---\nfeature_id: F-1\nstatus: edited\ntokens_input: 9\n---\n\nEdit\n',
        '---\nfeature_id: F-1\nstatus: running\ntokens_input: 9\n---\n\nOriginal\n',
      ],
      crlf: [
        crlf('---\nfeature_id: F-1\nstatus: edited\ntokens_input: 9\n---\n\nEdit\n'),
        crlf('---\nfeature_id: F-1\nstatus: running\ntokens_input: 9\n---\n\nOriginal\n'),
      ],
      missing: [null, snapshot],
      empty: ['', snapshot],
      unfenced: ['Edited without fences\n', snapshot],
      malformed: ['---\nfeature_id: [\n---\nEdit\n', snapshot],
    };
    for (const [name, [current, expected]] of Object.entries(live)) {
      if (current === null) rmSync(path, { force: true });
      else writeFileSync(path, current);
      assert.equal(restoreKeepingTokens(dir, path, snapshot), true, name);
      assert.equal(readFileSync(path, 'utf8'), expected, name);
    }
    // A CRLF snapshot over a missing file goes back as it was.
    rmSync(path);
    restoreKeepingTokens(dir, path, crlf(snapshot));
    assert.equal(readFileSync(path, 'utf8'), crlf(snapshot), 'CRLF snapshot');
    // A snapshot that is not a spec is refused and the live file left alone.
    for (const [name, bad] of Object.entries({
      empty: '',
      unfenced: 'Snapshot without fences\n',
      malformed: '---\nfeature_id: [\n---\nBad\n',
    })) {
      writeFileSync(path, live.valid[0]);
      assert.throws(() => restoreKeepingTokens(dir, path, bad), FrontmatterError, `snapshot ${name}`);
      assert.equal(readFileSync(path, 'utf8'), live.valid[0], `snapshot ${name}: live file untouched`);
    }
    // A failed rename leaves the live file whole; the retry restores it.
    for (const current of [live.valid[0], live.unfenced[0]]) {
      writeFileSync(path, current);
      atomicHooks.beforeRename = () => {
        throw new Error('injected rename failure');
      };
      try {
        assert.throws(() => restoreKeepingTokens(dir, path, snapshot), /injected rename failure/);
      } finally {
        atomicHooks.beforeRename = null;
      }
      assert.equal(readFileSync(path, 'utf8'), current, 'the failed restore left the file whole');
      assert.equal(restoreKeepingTokens(dir, path, snapshot), true, 'retry');
      assert.match(readFileSync(path, 'utf8'), /Original/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // In the loop: a verifier that damaged the feature file and the change
  // document, then failed, has both put back, and the round aborts.
  const damage = {
    missing: (p) => rmSync(p),
    empty: (p) => writeFileSync(p, ''),
    unfenced: (p) => writeFileSync(p, '# damaged by the verifier\n'),
    malformed: (p) => writeFileSync(p, '---\nfeature_id: [\n---\n'),
    'restore fails': null,
  };
  for (const [name, hurt] of Object.entries(damage)) {
    const { dir: root, cleanup, config, feature, prep } = setup();
    try {
      let failed = false;
      let before = null;
      let seen = null;
      let round = 0;
      const runner = fakeRunner({
        dir: root,
        feature,
        behaviour: {
          // The files as the round found them: the last pass runs before bl
          // writes the round's number for the verifier.
          review: () => {
            if (!failed) {
              before = { feature: readFileSync(feature.indexPath, 'utf8'), change: readFileSync(CH(feature), 'utf8') };
            }
          },
          verify: () => {
            if (!failed) {
              writeFileSync(CH(feature), 'verifier garbage\n');
              if (hurt) hurt(feature.indexPath);
              else editFile(feature.indexPath, (fm) => void (fm.verifier_edit = 'x'));
              return reviewOutcome();
            }
            round += 1;
            return verifySession(CH(feature), { pending: round === 1, round });
          },
        },
      });
      const session = runner.session;
      runner.session = (o) => {
        if (failed && !seen) {
          seen = {
            feature: existsSync(feature.indexPath) ? readFileSync(feature.indexPath, 'utf8') : null,
            change: readFileSync(CH(feature), 'utf8'),
          };
        }
        const r = session(o);
        if (o.promptName !== 'review-verify' || failed) return r;
        failed = true;
        // The feature's restore (the write that drops the verifier's edit,
        // not a token write that keeps it) fails once: the change document
        // is still restored.
        if (!hurt) {
          atomicHooks.beforeRename = (tmp) => {
            if (!tmp.includes('index.md.') || readFileSync(tmp, 'utf8').includes('verifier_edit')) return;
            atomicHooks.beforeRename = null;
            throw new Error('injected rename failure');
          };
        }
        return { ...r, ok: false, isError: true, error: 'provider crashed' };
      };
      const state = await runFeature({ feature, config, prep, runner, opts: { maxRounds: 2 } });
      atomicHooks.beforeRename = null;
      assert.ok(failed, `${name}: the verifier ran`);
      // The aborted round escalates; it writes only the Escalation section.
      assert.equal(state.status, 'escalated', name);
      seen ??= {
        feature: existsSync(feature.indexPath) ? readFileSync(feature.indexPath, 'utf8') : null,
        change: readFileSync(CH(feature), 'utf8'),
      };
      assert.equal(seen.change, before.change, `${name}: the change document is restored`);
      const abort = state.history.find((h) => h.step === 'review:abort');
      assert.match(abort?.note ?? '', /the verifier failed: provider crashed/, `${name}: the round aborted`);
      if (hurt) {
        const after = parseFrontmatter(seen.feature ?? '');
        const rest = (body) => replaceSection(body, 'Escalation', '');
        assert.equal(
          rest(after.body),
          rest(parseFrontmatter(before.feature).body),
          `${name}: the feature file is restored`,
        );
        assert.equal(after.fm.feature_id, feature.id, `${name}: with its frontmatter`);
      } else {
        assert.match(
          abort.note,
          /could not restore the verifier's edits: injected rename failure/,
          `${name}: the failure is named`,
        );
      }
    } finally {
      atomicHooks.beforeRename = null;
      cleanup();
    }
  }
});
