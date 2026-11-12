import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  applyAdditionalPrompt,
  loadPrompt,
  getAllowedTools,
  getDeniedTools,
  launchSession,
  runHeadlessSession,
} from '../../src/session.js';
import { AgentProvider } from '../../src/agents/provider.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { holderOf } from '../../src/kernel-lock.js';
import { sessionLockPath } from '../../src/story.js';
import { takeUnitLocks, unitLockPath } from '../../src/unit-lock.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { holdLock } from '../helpers/hold-lock.js';

const BASE_PROMPT = 'BODY: original task instructions\n';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'prompts');

function withEnv(overrides, fn) {
  const keys = ['BL_LOCALE', 'LC_ALL', 'LANG', 'BL_INTERNAL_TEST_PROMPTS_DIR'];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('applyAdditionalPrompt returns prompt untouched when additionalPrompt is undefined', () => {
  const out = applyAdditionalPrompt(BASE_PROMPT, undefined, {
    mode: 'workon',
    storyId: 'S-1',
  });
  assert.equal(out, BASE_PROMPT);
});

test('applyAdditionalPrompt returns prompt untouched when additionalPrompt is empty string', () => {
  const out = applyAdditionalPrompt(BASE_PROMPT, '', {
    mode: 'workon',
    storyId: 'S-1',
  });
  assert.equal(out, BASE_PROMPT);
});

test('applyAdditionalPrompt prepends the preamble when additionalPrompt is set', () => {
  const out = applyAdditionalPrompt(BASE_PROMPT, 'consider the auth refactor', {
    mode: 'workon',
    storyId: 'S-42',
  });
  assert.notEqual(out, BASE_PROMPT);
  assert.ok(out.endsWith(BASE_PROMPT), 'original prompt must remain intact at end');
  assert.ok(out.startsWith('## Pre-task discussion'), 'preamble heading must be at the top');
  assert.ok(out.includes('> consider the auth refactor'), "user's text must appear verbatim under the blockquote");
  assert.ok(out.includes('`bl implement` task for'), 'preamble must mention the resolved mode');
  assert.ok(out.includes('S-42'), 'preamble must mention the story id');
});

test('applyAdditionalPrompt resolves {{mode}} for each launcher', () => {
  // The `workon` permission mode is named by its verb, `bl implement`.
  for (const [mode, verb] of [
    ['refine', 'refine'],
    ['workon', 'implement'],
    ['review', 'review'],
  ]) {
    const out = applyAdditionalPrompt(BASE_PROMPT, 'x', {
      mode,
      storyId: 'S-1',
    });
    assert.ok(out.includes('`bl ' + verb + '` task for'), `preamble must mention bl ${verb}`);
  }
});

// ---------------------------------------------------------------------------
// loadPrompt locale selection (S-457)
// ---------------------------------------------------------------------------

test('loadPrompt with no locale loads the un-suffixed file', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadPrompt(
      '_pre-task-discussion',
      { mode: 'workon', storyId: 'S-1', additionalPrompt: 'hi' },
      'claude',
    );
    assert.ok(out.startsWith('## Pre-task discussion'));
    assert.match(out, /> hi/);
  });
});

test('loadPrompt reads the localized file when config.raw.locale matches a fixture', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadPrompt(
      '_pre-task-discussion',
      { mode: 'workon', storyId: 'S-1', additionalPrompt: 'hi' },
      { agent: 'claude', config: { raw: { locale: 'fr' } } },
    );
    assert.ok(out.startsWith('## Discussion preliminaire'), 'localized French heading must appear');
    assert.match(out, /> hi/);
  });
});

test('loadPrompt falls back silently when localized file is absent', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadPrompt(
      '_pre-task-discussion',
      { mode: 'workon', storyId: 'S-1', additionalPrompt: 'hi' },
      { agent: 'claude', config: { raw: { locale: 'de' } } },
    );
    assert.ok(out.startsWith('## Pre-task discussion'), 'missing localized file must fall back to English');
  });
});

test('loadPrompt region-then-language fallback: fr-FR → fr → un-suffixed', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    // Only fr.md exists for _pre-task-discussion (no fr-FR variant), so
    // BL_LOCALE=fr-FR should still resolve to the bare-language file.
    const out = loadPrompt(
      '_pre-task-discussion',
      { mode: 'workon', storyId: 'S-1', additionalPrompt: 'hi' },
      { agent: 'claude', config: { raw: { locale: 'fr-FR' } } },
    );
    assert.ok(out.startsWith('## Discussion preliminaire'));
  });
});

// ---------------------------------------------------------------------------
// loadPrompt per-agent selection (S-455)
// ---------------------------------------------------------------------------

test('loadPrompt reads the agent-specific file when present', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadPrompt('prompt-agent', {}, { agent: 'gemini' });
    assert.ok(out.startsWith('prompt gemini '), 'Gemini-specific prompt must win over shared prompt');
  });
});

test('loadPrompt falls back to shared file when agent-specific file is absent', () => {
  withEnv({ BL_INTERNAL_TEST_PROMPTS_DIR: FIXTURES_DIR }, () => {
    const out = loadPrompt('prompt-no-agent-variant', {}, { agent: 'gemini' });
    assert.ok(out.startsWith('prompt no agent shared '), 'missing agent prompt must fall back to shared prompt');
  });
});

// ---------------------------------------------------------------------------
// getDeniedTools — per-mode hard denials from the generated deny map
// ---------------------------------------------------------------------------

test("getDeniedTools returns the mode's deny list from allowed-tools.json", async () => {
  const dir = mkTempDir('bl-denied-tools-');
  writeFileSync(
    join(dir, 'allowed-tools.json'),
    JSON.stringify({
      base: ['git:*'],
      review: ['gh pr:*'],
      deny: { review: ['gh pr merge:*', 'git push:*'] },
    }),
  );
  assert.deepEqual(await getDeniedTools('review', { backlogRoot: dir }), ['gh pr merge:*', 'git push:*']);
  assert.deepEqual(await getDeniedTools('workon', { backlogRoot: dir }), []);
});

test('getDeniedTools tolerates a legacy file with no deny map', async () => {
  const dir = mkTempDir('bl-denied-tools-legacy-');
  writeFileSync(join(dir, 'allowed-tools.json'), JSON.stringify({ base: ['git:*'], review: ['gh pr:*'] }));
  assert.deepEqual(await getDeniedTools('review', { backlogRoot: dir }), []);
});

// ---------------------------------------------------------------------------
// getAllowedTools — templated plugin leaders are resolved at session build
// ---------------------------------------------------------------------------

function allowedToolsFixture(base) {
  const dir = mkTempDir('bl-allowed-tools-');
  writeFileSync(join(dir, 'allowed-tools.json'), JSON.stringify({ base, review: ['gh pr:*', '{{backlogRoot}}/x:*'] }));
  return dir;
}

test('getAllowedTools resolves {{roostDir}} leaders and grants no session-stack rule of its own', async () => {
  const dir = allowedToolsFixture(['git:*', '{{roostDir}}/tools/bin/prettier:*']);
  // Local extras (`bl allow`'s gitignored file) are resolved the same way.
  writeFileSync(
    join(dir, 'allowed-tools.local.json'),
    JSON.stringify({ extra: ['my-tool:*', '{{roostDir}}/bin/hand:*'] }),
  );
  const out = await getAllowedTools('review', { backlogRoot: dir, roostDir: '/roost' });
  assert.deepEqual(out, [
    'git:*',
    '/roost/tools/bin/prettier:*',
    'gh pr:*',
    `${dir}/x:*`,
    'my-tool:*',
    '/roost/bin/hand:*',
  ]);
  assert.ok(!out.some((t) => t.includes('{{')), 'no placeholder reaches the agent');
});

test('getAllowedTools drops a templated leader when no roostDir is available', async () => {
  const dir = allowedToolsFixture(['git:*', '{{roostDir}}/tools/bin/prettier:*']);
  // `""` is not nullish, so `config` cannot supply it.
  const out = await getAllowedTools('workon', { backlogRoot: dir, roostDir: '' });
  assert.deepEqual(out, ['git:*']);
});

test('getAllowedTools takes roostDir from config when the argument is absent', async () => {
  const dir = allowedToolsFixture(['{{roostDir}}/tools/bin/prettier:*']);
  const config = {
    roostDir: '/from-config',
    backlogRoot: dir,
    topLevel: {
      plugins: { prettier: { format: '{{roostDir}}/tools/bin/prettier {{path}}' } },
    },
    projects: {},
  };
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  let out;
  try {
    out = await getAllowedTools('workon', { backlogRoot: dir, config });
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(out.includes('/from-config/tools/bin/prettier:*'));
  assert.ok(!out.some((t) => t.includes('containers')), 'no session-stack rule unless backlog.json names one');
  assert.ok(!out.some((t) => t.includes('{{')));
});

test('getAllowedTools adds backlog.json session_stack.allow, resolved, before the worktree rule', async () => {
  const dir = allowedToolsFixture(['git:*']);
  const config = {
    roostDir: '/ws',
    backlogRoot: dir,
    topLevel: { plugins: {}, session_stack: { allow: ['Bash({{roostDir}}/stack/*)', '{{backlogRoot}}/bin/up:*'] } },
    projects: {},
  };
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  let out;
  try {
    out = await getAllowedTools('workon', { backlogRoot: dir, config, worktreePath: '/wt' });
  } finally {
    process.stderr.write = orig;
  }
  assert.deepEqual(out.slice(-3), ['Bash(/ws/stack/*)', `${dir}/bin/up:*`, 'Bash(rm /wt/*)']);
});

// ---------------------------------------------------------------------------
// launchSession records the session's transcript difference per step (S-904)
// ---------------------------------------------------------------------------

/** launchSession with a provider stub; returns the unit file's frontmatter after. */
async function launchWithTokens(getTokens, extra = {}, spawnResult = () => ({ status: 0 })) {
  const { dir, cleanup } = mkTempBacklog();
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    // A story's spec: the token writer holds its spec lock, its covering lock (F-126).
    const indexPath = join(dir, 'stories', 'S1-t', 'index.md');
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, '---\nstory_id: S-1\ntitle: T\ntokens_input: 100\n---\n\n# T\n');
    const calls = [];
    const provider = new (class extends AgentProvider {
      findSession() {
        return null;
      }
      spawn() {
        calls.push('spawn');
        return spawnResult();
      }
      getTokens(worktreePath, prefix) {
        calls.push(`getTokens ${worktreePath === wt ? 'wt' : worktreePath} ${prefix}`);
        return getTokens(calls.filter((c) => c === 'spawn').length);
      }
    })();
    let status;
    try {
      status = await launchSession({
        mode: 'workon',
        parsed: { id: 'S-1' },
        title: 'T',
        worktreePath: wt,
        branchName: 'b',
        sessionPrompt: 'p',
        roostDir: cfg.roostDir,
        backlogRoot: dir,
        isNewWorktree: false,
        config: cfg,
        forceNew: true,
        returnOnExit: true,
        recordTokens: false,
        tokensStep: 'implement',
        tokensIndexPath: indexPath,
        provider,
        ...extra,
      });
    } catch (err) {
      status = err.message;
    }
    return { status, calls, fm: parseFrontmatter(readFileSync(indexPath, 'utf8')).fm };
  } finally {
    if (tmux != null) process.env.TMUX = tmux;
    cleanup();
  }
}

test('launchSession records the transcript difference across the session under tokensStep', async () => {
  const before = { input: 10, output: 5, cache_creation: 2, cache_read: 50 };
  const after = { input: 25, output: 9, cache_creation: 2, cache_read: 40 };
  const { status, calls, fm } = await launchWithTokens((spawned) => (spawned ? after : before));
  assert.equal(status, 0);
  assert.deepEqual(calls, ['getTokens wt S-1:', 'spawn', 'getTokens wt S-1:']);
  assert.deepEqual(fm.tokens_by_step, {
    implement: { input: '15', output: '4', cache_creation: '0', cache_read: '0' },
  });
  assert.equal(fm.tokens_input, '115', 'the totals take the same difference, in the same write');
  assert.equal(fm.tokens_headless_input, undefined, 'the transcript holds an interactive session');
});

test('interactive_usage_and_totals_remain_consistent_on_every_exit', async () => {
  const before = { input: 10, output: 0, cache_creation: 0, cache_read: 0 };
  const after = { input: 25, output: 0, cache_creation: 0, cache_read: 0 };
  const exits = [
    ['success', () => ({ status: 0 }), 0],
    ['nonzero status', () => ({ status: 3 }), 3],
    ['error result', () => ({ error: new Error('spawn error'), status: 1 }), 1],
    [
      'spawn throws after the session ran',
      () => {
        throw new Error('spawn failed');
      },
      'spawn failed',
    ],
  ];
  for (const [name, spawnResult, expected] of exits) {
    const { status, fm } = await launchWithTokens((spawned) => (spawned ? after : before), {}, spawnResult);
    assert.equal(status, expected, name);
    assert.equal(fm.tokens_by_step?.implement?.input, '15', `${name}: step`);
    assert.equal(fm.tokens_input, '115', `${name}: totals`);
  }
});

test('launchSession records nothing per step for a provider without tokens, no change, or no tokensStep', async () => {
  const notImplemented = () => {
    throw new Error('getTokens() not implemented');
  };
  assert.equal((await launchWithTokens(notImplemented)).fm.tokens_by_step, undefined);
  const same = { input: 3, output: 3, cache_creation: 3, cache_read: 3 };
  assert.equal((await launchWithTokens(() => same)).fm.tokens_by_step, undefined);
  assert.equal((await launchWithTokens(() => null)).fm.tokens_by_step, undefined);
  const r = await launchWithTokens(() => same, { tokensStep: null });
  assert.deepEqual(r.calls, ['spawn'], 'no transcript read without a step');
  // A first session in a fresh worktree: no transcript before, some after.
  const fresh = (await launchWithTokens((spawned) => (spawned ? same : null))).fm;
  assert.deepEqual(fresh.tokens_by_step, {
    implement: { input: '3', output: '3', cache_creation: '3', cache_read: '3' },
  });
});

// ---------------------------------------------------------------------------
// A session in the backlog root runs under its work unit locks (F-122 D7)
// ---------------------------------------------------------------------------

test('session_in_backlog_root_needs_its_work_unit_locks: no session lock; units missing or not held throw', async () => {
  const { dir, cleanup } = mkTempBacklog();
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const unit = { id: 'S-1', kind: 'story', indexPath: join(dir, 'stories', 'S1-one', 'index.md') };
    const unitDir = mkTempDir('bl-unit-');
    /** Per spawn: whether a session lock of the backlog root, or of the unit directory, is held. */
    const spawns = [];
    const provider = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      findSession() {
        return null;
      }
      spawn(opts) {
        spawns.push({
          rootSessionLock: holderOf(sessionLockPath(dir, dir)),
          unitSessionLock: holderOf(sessionLockPath(dir, unitDir)) === process.pid,
          cwd: opts.cwd,
        });
        return { status: 0, output: '', isError: false, usage: null };
      }
    })();
    const common = {
      mode: 'refine',
      parsed: { id: 'S-1' },
      worktreePath: dir,
      config: cfg,
      roostDir: cfg.roostDir,
      backlogRoot: dir,
      provider,
    };
    const headless = (extra) => runHeadlessSession({ ...common, prompt: 'p', label: 'S-1', ...extra });
    const interactive = (extra) =>
      launchSession({
        ...common,
        title: 'T',
        branchName: 'main',
        sessionPrompt: 'p',
        isNewWorktree: false,
        returnOnExit: true,
        recordTokens: false,
        ...extra,
      });

    for (const launch of [headless, interactive]) {
      await assert.rejects(launch({}), /needs its work units' locks \(units\)/, 'no units');
      await assert.rejects(launch({ units: [] }), /needs its work units' locks \(units\)/, 'empty units');
      await assert.rejects(
        launch({ units: [unit] }),
        /does not hold S-1's work unit lock .*\/\.bl\/lock\/unit-S1-one-/,
      );
      // Another process's lock is not this process's.
      const other = holdLock(unitLockPath(dir, dirname(unit.indexPath)), 'other');
      try {
        await assert.rejects(launch({ units: [unit] }), /does not hold S-1's work unit lock/);
      } finally {
        other.release();
      }
    }
    assert.equal(spawns.length, 0, 'nothing spawned');

    const lock = takeUnitLocks(cfg, [unit], 'refine S-1');
    assert.equal(lock.refused, null);
    try {
      assert.equal((await headless({ units: [unit] })).status, 0);
      assert.equal(await interactive({ units: [unit] }), 0);
    } finally {
      lock.release();
    }
    // In a unit directory, the session lock is taken as before, and needs no units.
    assert.equal((await headless({ unitDir })).status, 0);
    assert.deepEqual(spawns, [
      { rootSessionLock: null, unitSessionLock: false, cwd: dir },
      { rootSessionLock: null, unitSessionLock: false, cwd: dir },
      { rootSessionLock: null, unitSessionLock: true, cwd: unitDir },
    ]);
  } finally {
    if (tmux != null) process.env.TMUX = tmux;
    cleanup();
  }
});
