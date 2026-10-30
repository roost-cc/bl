import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { ClaudeProvider, buildClaudeArgs, parseClaudeJsonResult, parseLimit } from '../../src/agents/claude.js';
import {
  CodexProvider,
  buildCodexArgs,
  parseCodexJsonEvents,
  parseCodexCapacity,
  parseCodexLimit,
} from '../../src/agents/codex.js';
import { AgentProvider } from '../../src/agents/provider.js';
import { GeminiProvider } from '../../src/agents/gemini.js';
import { addUsageToFrontmatter, accumulateTokensOnFile, applyFeatureTokens } from '../../src/tokens.js';
import { runHeadlessSession, launchSession } from '../../src/session.js';
import { isSessionRunning } from '../../src/story.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { loadConfig, parseFrontmatter } from '../../src/config.js';

test('buildClaudeArgs headless uses print mode with JSON output and no session name', () => {
  const args = buildClaudeArgs({
    name: 'F-1: x',
    prompt: 'do it',
    permissions: ['Bash(git:*)'],
    disallowed: ['Bash(git push:*)'],
    scopes: { read: ['/roost'], write: ['/wt'] },
    headless: true,
  });
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
  // Headless sessions accept edits inside their write roots, so shell output
  // redirection into the worktree or the run's scratch dir is not denied.
  const pm = args.indexOf('--permission-mode');
  assert.ok(pm > 0 && args[pm + 1] === 'acceptEdits');
  assert.ok(!args.includes('--name'));
  assert.ok(!args.includes('--resume'));
  assert.ok(args.includes('--add-dir') && args.includes('/wt'));
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('--disallowedTools'));
  assert.equal(args[args.length - 1], 'do it');
  // interactive form is unchanged
  const inter = buildClaudeArgs({ name: 'F-1: x', prompt: 'p' });
  assert.deepEqual(inter.slice(0, 2), ['--name', 'F-1: x']);
  assert.ok(!inter.includes('--permission-mode'));
});

test('parseClaudeJsonResult handles the object, array, and noisy forms', () => {
  const obj = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'DONE S-1',
    session_id: 'abc',
    total_cost_usd: 0.42,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
  };
  const r = parseClaudeJsonResult(JSON.stringify(obj));
  assert.equal(r.output, 'DONE S-1');
  assert.equal(r.isError, false);
  assert.deepEqual(r.usage, { input: 10, output: 20, cache_creation: 30, cache_read: 40 });
  assert.equal(r.sessionId, 'abc');
  assert.equal(r.costUsd, 0.42);
  const arr = parseClaudeJsonResult(JSON.stringify([{ type: 'system' }, obj]));
  assert.equal(arr.output, 'DONE S-1');
  const noisy = parseClaudeJsonResult(
    `warning: something\n${JSON.stringify({ ...obj, is_error: true, subtype: 'error_max_turns' })}`,
  );
  assert.equal(noisy.isError, true);
  const plain = parseClaudeJsonResult('not json at all');
  assert.equal(plain.parsed, false);
  assert.equal(plain.output, 'not json at all');
  assert.equal(plain.usage, null);
});

test('ClaudeProvider.spawn headless captures stdout through the injected runner', () => {
  const p = new ClaudeProvider();
  let seen;
  const r = p.spawn({
    mode: 'workon',
    prompt: 'x',
    worktreePath: '/wt',
    headless: true,
    run: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return {
        status: 0,
        stdout: JSON.stringify({ type: 'result', result: 'hi', usage: { input_tokens: 1, output_tokens: 2 } }),
      };
    },
  });
  assert.equal(seen.cmd, 'claude');
  assert.equal(seen.args[0], '-p');
  assert.deepEqual(seen.opts.stdio, ['ignore', 'pipe', 'inherit']);
  assert.equal(r.output, 'hi');
  assert.equal(r.usage.output, 2);
  assert.equal(p.supportsHeadless(), true);
});

test('ClaudeProvider.spawn passes --model, which outranks ANTHROPIC_MODEL in the environment', () => {
  const prev = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = 'claude-fable-5-1';
  try {
    for (const headless of [true, false]) {
      let seen;
      new ClaudeProvider().spawn({
        mode: 'workon',
        prompt: 'x',
        worktreePath: '/wt',
        headless,
        model: 'opus',
        run: (cmd, args, opts) => {
          seen = { args, opts };
          return { status: 0, stdout: '{}' };
        },
      });
      const i = seen.args.indexOf('--model');
      assert.equal(seen.args[i + 1], 'opus', `headless: ${headless}`);
    }
  } finally {
    if (prev == null) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prev;
  }
});

test("a headless session runs on the model it is given only; an interactive one defaults to the first implementing configuration's for its agent", () => {
  const { dir, cleanup } = mkTempBacklog({
    config: { agent: [{ agent: 'claude', model: 'opus' }], review_agent: [{ agent: 'codex', model: 'gpt-6-sol' }] },
  });
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    const models = [];
    const provider = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      findSession() {
        return null;
      }
      spawn({ model }) {
        models.push(model);
        return { status: 0, output: '' };
      }
    })();
    const headless = (extra) =>
      runHeadlessSession({
        mode: 'workon',
        parsed: { id: 'F-1' },
        prompt: 'p',
        worktreePath: wt,
        config: cfg,
        roostDir: cfg.roostDir,
        backlogRoot: dir,
        provider,
        ...extra,
      });
    const launch = (extra) =>
      launchSession({
        mode: 'workon',
        parsed: { id: 'F-1' },
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
        sessionName: 'F-1: x',
        provider,
        ...extra,
      });
    for (const run of [headless, launch]) {
      run({});
      run({ model: 'sonnet' });
      run({ model: null });
      // Another agent never gets the implementing configuration's model.
      run({ agent: 'codex' });
      run({ agent: 'codex', model: 'gpt-6-sol' });
    }
    // The walk always names the configuration's model (F-64 D3), so a
    // headless session has no default of its own.
    assert.deepEqual(models, [null, 'sonnet', null, null, 'gpt-6-sol', 'opus', 'sonnet', null, null, 'gpt-6-sol']);
    // An explicit model that is not a non-empty string never reaches the provider.
    for (const bad of ['', '  ', 0, 1, true, {}, ['sonnet']]) {
      assert.throws(
        () => headless({ model: bad }),
        /^Error: model must be a non-empty string$/,
        `headless ${JSON.stringify(bad)}`,
      );
      assert.throws(
        () => launch({ model: bad }),
        /^Error: model must be a non-empty string$/,
        `launch ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(models.length, 10);
  } finally {
    if (tmux != null) process.env.TMUX = tmux;
    cleanup();
  }
});

test('buildCodexArgs headless uses exec with JSON events and a last-message file', () => {
  const args = buildCodexArgs({
    prompt: 'p',
    worktreePath: '/wt',
    backlogRoot: '/bl',
    headless: true,
    outputFile: '/tmp/out.md',
  });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.ok(args.includes('--output-last-message') && args.includes('/tmp/out.md'));
  assert.ok(args.includes('--sandbox') && args.includes('workspace-write'));
  assert.ok(!args.includes('--ask-for-approval'), 'exec has no approval flag');
  assert.equal(args[args.length - 1], 'p');
  const inter = buildCodexArgs({ prompt: 'p', worktreePath: '/wt', backlogRoot: '/bl' });
  assert.ok(inter.includes('--ask-for-approval'));
  assert.notEqual(inter[0], 'exec');
});

test('buildCodexArgs passes -m <model> to codex exec, the interactive launch and resume when the configuration names one, and none otherwise', () => {
  const exec = buildCodexArgs({
    prompt: 'p',
    worktreePath: '/wt',
    backlogRoot: '/bl',
    headless: true,
    model: 'gpt-6-sol',
  });
  assert.equal(exec[0], 'exec');
  assert.equal(exec[exec.indexOf('-m') + 1], 'gpt-6-sol');
  const inter = buildCodexArgs({ prompt: 'p', worktreePath: '/wt', backlogRoot: '/bl', model: 'gpt-6-astra' });
  assert.equal(inter[inter.indexOf('-m') + 1], 'gpt-6-astra');
  const resume = buildCodexArgs({ worktreePath: '/wt', backlogRoot: '/bl', sessionId: 'abc', model: 'gpt-6-sol' });
  assert.deepEqual(
    [resume[0], resume[resume.indexOf('-m') + 1], resume[resume.length - 1]],
    ['resume', 'gpt-6-sol', 'abc'],
  );
  for (const args of [
    buildCodexArgs({ prompt: 'p', worktreePath: '/wt', backlogRoot: '/bl', headless: true }),
    buildCodexArgs({ prompt: 'p', worktreePath: '/wt', backlogRoot: '/bl', model: null }),
  ]) {
    assert.ok(!args.includes('-m') && !args.includes('--model'), "no model: the account's");
  }
  assert.throws(() => buildCodexArgs({ headless: true, model: '' }), /^Error: model must be a non-empty string$/);
});

test("CodexProvider.spawn hands the configuration's model to codex exec", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '' };
  };
  new CodexProvider().spawn({
    prompt: 'p',
    worktreePath: '/wt',
    backlogRoot: '/bl',
    headless: true,
    model: 'gpt-6-sol',
    run,
    ensureApprovedCommandPrefixes: () => ({ added: 0 }),
  });
  new CodexProvider().spawn({
    prompt: 'p',
    worktreePath: '/wt',
    backlogRoot: '/bl',
    headless: true,
    run,
    ensureApprovedCommandPrefixes: () => ({ added: 0 }),
  });
  assert.equal(calls[0].cmd, 'codex');
  assert.equal(calls[0].args[calls[0].args.indexOf('-m') + 1], 'gpt-6-sol');
  assert.ok(!calls[1].args.includes('-m'));
});

test('parseCodexJsonEvents sums usage and flags error events', () => {
  const lines = [
    JSON.stringify({ type: 'thread.started' }),
    'not json',
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 7, cached_input_tokens: 3 } }),
    JSON.stringify({ type: 'item.completed', item: { usage: { input_tokens: 1, output_tokens: 1 } } }),
  ].join('\n');
  const r = parseCodexJsonEvents(lines);
  // 5 input of which 3 cached → 2 uncached; plus 1 uncached from the item.
  assert.deepEqual(r.usage, { input: 3, output: 8, cache_creation: 0, cache_read: 3 });
  assert.equal(r.isError, false);
  assert.equal(parseCodexJsonEvents(JSON.stringify({ type: 'error', message: 'x' })).isError, true);
  assert.equal(parseCodexJsonEvents('').usage, null);
});

test('parseCodexJsonEvents does not count cached tokens twice', () => {
  // input + cache_read must equal Codex's total input_tokens, whatever the
  // cached share: none, some, all, and the alternate field name.
  for (const u of [
    { input_tokens: 100, output_tokens: 1 },
    { input_tokens: 100, output_tokens: 1, cached_input_tokens: 40 },
    { input_tokens: 100, output_tokens: 1, cached_input_tokens: 100 },
    { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 25 },
  ]) {
    const r = parseCodexJsonEvents(JSON.stringify({ type: 'turn.completed', usage: u }));
    assert.equal(r.usage.input + r.usage.cache_read, 100, JSON.stringify(u));
    assert.equal(r.usage.cache_read, u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0, JSON.stringify(u));
  }
});

test("headless token totals survive bl merge's transcript re-read", () => {
  // Headless steps, then the re-read `recordFeatureTokens` does at merge
  // (titled interactive transcripts only; headless ones are untitled).
  const fm = {};
  addUsageToFrontmatter(fm, { input: 10, output: 20, cache_creation: 30, cache_read: 40 });
  addUsageToFrontmatter(fm, { input: 1, output: 2, cache_creation: 3, cache_read: 4 });
  const transcripts = { input: 100, output: 200, cache_creation: 300, cache_read: 400 };
  applyFeatureTokens(fm, transcripts);
  const totals = () => [fm.tokens_input, fm.tokens_output, fm.tokens_cache_creation, fm.tokens_cache_read];
  assert.deepEqual(totals(), ['111', '222', '333', '444'], 'headless usage kept');
  // A second re-read (run --interactive, then merge) does not count it again.
  applyFeatureTokens(fm, transcripts);
  assert.deepEqual(totals(), ['111', '222', '333', '444'], 'not double counted');
  // More headless work after a re-read, then another re-read.
  addUsageToFrontmatter(fm, { input: 5, output: 0, cache_creation: 0, cache_read: 0 });
  assert.equal(fm.tokens_input, '116');
  applyFeatureTokens(fm, transcripts);
  assert.equal(fm.tokens_input, '116');
  // No titled transcripts at all: the headless totals stand.
  const only = {};
  addUsageToFrontmatter(only, { input: 7, output: 8, cache_creation: 0, cache_read: 9 });
  applyFeatureTokens(only, null);
  assert.deepEqual([only.tokens_input, only.tokens_output, only.tokens_cache_read], ['7', '8', '9']);
});

test('CodexProvider.spawn headless reads the last-message file back as output', () => {
  const p = new CodexProvider();
  const r = p.spawn({
    prompt: 'p',
    worktreePath: '/wt',
    backlogRoot: '/bl',
    headless: true,
    ensureApprovedCommandPrefixes: () => ({ added: 0 }),
    run: (cmd, args) => {
      assert.equal(cmd, 'codex');
      assert.equal(args[0], 'exec');
      const file = args[args.indexOf('--output-last-message') + 1];
      writeFileSync(file, 'REVIEW pending round 1\n');
      return {
        status: 0,
        stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }),
      };
    },
  });
  assert.equal(r.output, 'REVIEW pending round 1');
  assert.equal(r.usage.output, 3);
  assert.equal(r.isError, false);
  assert.equal(p.supportsHeadless(), true);
});

test('CodexProvider.spawn headless removes the last-message file when the spawn errors', () => {
  let file = null;
  const r = new CodexProvider().spawn({
    prompt: 'p',
    worktreePath: '/wt',
    backlogRoot: '/bl',
    headless: true,
    ensureApprovedCommandPrefixes: () => ({ added: 0 }),
    run: (cmd, args) => {
      file = args[args.indexOf('--output-last-message') + 1];
      writeFileSync(file, 'partial\n');
      return { error: new Error('spawn codex ENOENT') };
    },
  });
  assert.match(r.error.message, /ENOENT/);
  assert.equal(existsSync(file), false);
});

test('base provider and gemini report no headless support; runHeadlessSession refuses cleanly', () => {
  assert.equal(new AgentProvider().supportsHeadless(), false);
  assert.equal(new GeminiProvider().supportsHeadless(), false);
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    const r = runHeadlessSession({
      mode: 'workon',
      parsed: { id: 'F-1', num: '1' },
      prompt: 'p',
      worktreePath: wt,
      agent: 'gemini',
      config: cfg,
      roostDir: cfg.roostDir,
      backlogRoot: dir,
    });
    assert.equal(r.isError, true);
    assert.match(r.error, /no headless mode/);
  } finally {
    cleanup();
  }
});

test('addUsageToFrontmatter accumulates across steps and accumulateTokensOnFile persists it', () => {
  const fm = { tokens_input: '5' };
  addUsageToFrontmatter(fm, { input: 1, output: 2, cache_creation: 3, cache_read: 4 });
  addUsageToFrontmatter(fm, { input: 1, output: 2, cache_creation: 3, cache_read: 4 });
  assert.equal(fm.tokens_input, '7');
  assert.equal(fm.tokens_output, '4');
  assert.equal(fm.tokens_cache_read, '8');
  assert.match(fm.tokens_updated, /^\d{4}-\d{2}-\d{2}$/);
  const dir = mkTempDir('bl-tok-');
  const p = join(dir, 'index.md');
  writeFileSync(p, '---\nfeature_id: F-1\ntitle: T\n---\n\n# T\n');
  assert.equal(accumulateTokensOnFile(dir, p, { input: 9, output: 1, cache_creation: 0, cache_read: 0 }), true);
  assert.match(readFileSync(p, 'utf8'), /tokens_input: 9/);
  assert.equal(accumulateTokensOnFile(dir, join(dir, 'missing.md'), { input: 1 }), false);
});

test('runHeadlessSession and launchSession start in the unit directory: cwd, write root and lock (F-60 D3)', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const unitDir = mkTempDir('bl-unit-');
    const wt = join(unitDir, 'repo');
    mkdirSync(wt);
    const seen = [];
    const fake = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      findSession(path) {
        seen.push({ findSession: path });
        return null;
      }
      spawn(opts) {
        seen.push({
          cwd: opts.cwd,
          worktreePath: opts.worktreePath,
          write: opts.scopes.write,
          unitLock: existsSync(join(unitDir, '.workon.lock')),
          worktreeLock: existsSync(join(wt, '.workon.lock')),
          running: isSessionRunning(unitDir),
        });
        return { status: 0, output: '', isError: false, usage: null };
      }
    })();
    const common = {
      mode: 'workon',
      parsed: { id: 'F-1', num: '1' },
      worktreePath: wt,
      unitDir,
      config: cfg,
      roostDir: cfg.roostDir,
      backlogRoot: dir,
      provider: fake,
    };
    assert.equal(runHeadlessSession({ ...common, prompt: 'p', label: 'F-1: S-1' }).status, 0);
    assert.equal(
      launchSession({
        ...common,
        title: 'T',
        sessionPrompt: 'p',
        isNewWorktree: false,
        returnOnExit: true,
        recordTokens: false,
      }),
      0,
    );
    const spawns = seen.filter((s) => 'cwd' in s);
    assert.equal(spawns.length, 2);
    for (const s of spawns) {
      assert.equal(s.cwd, unitDir, 'the agent starts in the unit directory');
      assert.equal(s.worktreePath, wt, 'the lead worktree rides along');
      assert.deepEqual(s.write, [unitDir, dir], 'the unit directory and the backlog are the write roots');
      assert.equal(s.unitLock, true, 'the lock is in the unit directory');
      assert.equal(s.worktreeLock, false, 'and not in the worktree');
      assert.equal(s.running, true);
    }
    assert.deepEqual(
      seen.filter((s) => 'findSession' in s),
      [{ findSession: unitDir }],
      'a resume looks in the unit directory',
    );
    assert.ok(!existsSync(join(unitDir, '.workon.lock')), 'released after each session');

    // A live session's lock in the unit directory refuses a headless one.
    writeFileSync(join(unitDir, '.workon.lock'), `${process.ppid}\n2026-10-28T00:00:00Z\nother\n`);
    const refused = runHeadlessSession({ ...common, prompt: 'p', label: 'F-1: S-2' });
    assert.equal(refused.isError, true);
    assert.match(refused.error, new RegExp(`a live session \\(pid ${process.ppid}\\) holds .*\\.workon\\.lock`));
    assert.equal(spawns.length, 2, 'nothing spawned');
  } finally {
    cleanup();
  }
});

test('runHeadlessSession holds the worktree lock during spawn, logs, passes headless, and accumulates usage', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    const featurePath = join(dir, 'feature.md');
    writeFileSync(featurePath, '---\nfeature_id: F-1\ntitle: T\ntokens_output: 10\n---\n\n# T\n');
    let seen = null;
    const fake = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      spawn(opts) {
        seen = { ...opts, lockDuringSpawn: readFileSync(join(opts.worktreePath, '.workon.lock'), 'utf8') };
        return {
          status: 0,
          output: 'DONE S-1',
          isError: false,
          usage: { input: 1, output: 5, cache_creation: 0, cache_read: 2 },
        };
      }
    })();
    const r = runHeadlessSession({
      mode: 'workon',
      parsed: { id: 'F-1', num: '1' },
      prompt: 'p',
      worktreePath: wt,
      config: cfg,
      roostDir: cfg.roostDir,
      backlogRoot: dir,
      label: 'F-1: S-1',
      usageIndexPath: featurePath,
      logCommand: 'implement',
      provider: fake,
    });
    assert.equal(r.status, 0);
    assert.equal(r.output, 'DONE S-1');
    assert.equal(seen.headless, true);
    assert.match(
      seen.prompt,
      /^p\n\n## This session is headless\n/,
      'the task comes first, the headless rules after it',
    );
    assert.match(seen.prompt, /Never start a command in the\s+background/);
    assert.match(seen.prompt, /Commit every change you make before you end/, 'workon sessions must commit');
    assert.equal(seen.sessionId, null);
    assert.match(seen.lockDuringSpawn, /F-1: S-1 \(headless\)/);
    assert.ok(seen.scopes.write.includes(wt), 'worktree is a write scope');
    assert.throws(() => readFileSync(join(wt, '.workon.lock')), /ENOENT/, 'lock removed after spawn');
    assert.match(readFileSync(join(wt, '.bl', 'activity.log'), 'utf8'), /bl implement F-1 --headless/);
    const fm = readFileSync(featurePath, 'utf8');
    assert.match(fm, /tokens_output: 15/);
    assert.match(fm, /tokens_cache_read: 2/);
  } finally {
    cleanup();
  }
});

test('headless session does not clobber a live worktree lock', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    const lockPath = join(wt, '.workon.lock');
    let spawned = 0;
    const provider = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      spawn() {
        spawned += 1;
        return { status: 0, output: 'ok' };
      }
    })();
    const common = {
      mode: 'workon',
      parsed: { id: 'F-1' },
      prompt: 'p',
      worktreePath: wt,
      config: cfg,
      roostDir: cfg.roostDir,
      backlogRoot: dir,
      provider,
    };

    // A live interactive session in another process.
    const live = `${process.ppid}\n2026-09-24T00:00:00Z\nF-1: interactive\n`;
    writeFileSync(lockPath, live);
    const r = runHeadlessSession(common);
    assert.equal(r.isError, true);
    assert.match(r.error, /a live session \(pid \d+\) holds/);
    assert.equal(spawned, 0, 'no agent ran in a worktree someone else holds');
    assert.equal(readFileSync(lockPath, 'utf8'), live, 'lock left exactly as it was');
    assert.equal(isSessionRunning(wt), true, 'bl merge still sees the live session');

    // A lock this process holds is neither rewritten nor removed.
    const own = `${process.pid}\n2026-09-24T00:00:00Z\nF-1: run\n`;
    writeFileSync(lockPath, own);
    assert.equal(runHeadlessSession(common).isError, false);
    assert.equal(readFileSync(lockPath, 'utf8'), own);

    // A stale lock (dead pid) is reclaimed, and released after the session.
    writeFileSync(lockPath, `${spawnSync('true').pid}\n`);
    assert.equal(runHeadlessSession(common).isError, false);
    assert.equal(existsSync(lockPath), false);
    assert.equal(spawned, 2);
  } finally {
    cleanup();
  }
});

test('runHeadlessSession maps a spawn error and a non-zero exit to isError', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    const mk = (ret) =>
      new (class extends AgentProvider {
        supportsHeadless() {
          return true;
        }
        spawn() {
          return ret;
        }
      })();
    const common = {
      mode: 'review',
      parsed: { id: 'F-1' },
      prompt: 'p',
      worktreePath: wt,
      config: cfg,
      roostDir: cfg.roostDir,
      backlogRoot: dir,
    };
    const a = runHeadlessSession({ ...common, provider: mk({ error: new Error('spawn claude ENOENT') }) });
    assert.equal(a.isError, true);
    assert.match(a.error, /ENOENT/);
    const b = runHeadlessSession({ ...common, provider: mk({ status: 3, output: 'boom' }) });
    assert.equal(b.isError, true);
    assert.equal(b.status, 3);
    assert.equal(b.output, 'boom');
  } finally {
    cleanup();
  }
});

test('parseClaudeJsonResult surfaces permission denials, and runHeadlessSession passes them through', () => {
  const r = parseClaudeJsonResult(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'touch /etc/x' } },
        { tool_name: 'Write', tool_use_id: 't2', tool_input: { file_path: '/outside/a.md' } },
        { tool_name: 'WebFetch' },
      ],
    }),
  );
  assert.equal(r.isError, false, 'a denial is not a session error');
  assert.deepEqual(r.denials, ['Bash(touch /etc/x)', 'Write(/outside/a.md)', 'WebFetch']);
  assert.deepEqual(parseClaudeJsonResult('not json').denials, []);
  // Array form: the last result wins.
  const arr = parseClaudeJsonResult(
    JSON.stringify([
      { type: 'result', result: 'first' },
      { type: 'result', result: 'last' },
    ]),
  );
  assert.equal(arr.output, 'last');

  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const worktreePath = mkTempDir('bl-wt-');
    const provider = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      spawn() {
        return {
          status: 0,
          output: 'ok',
          isError: false,
          usage: null,
          denials: ['Bash(rm -rf x)'],
          refusal: { kind: 'session', scope: 'model', message: 'm', resetsAt: null },
        };
      }
    })();
    const out = runHeadlessSession({
      mode: 'workon',
      parsed: { id: 'F-1' },
      prompt: 'p',
      worktreePath,
      config: cfg,
      roostDir: cfg.roostDir,
      backlogRoot: dir,
      provider,
    });
    assert.deepEqual(out.denials, ['Bash(rm -rf x)']);
    assert.equal(out.isError, false);
    assert.deepEqual(
      out.refusal,
      { kind: 'session', scope: 'model', message: 'm', resetsAt: null },
      'the refusal passes through untouched',
    );
    const noLimit = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      spawn() {
        return { status: 0, output: 'ok', isError: false, usage: null };
      }
    })();
    assert.equal(
      runHeadlessSession({
        mode: 'workon',
        parsed: { id: 'F-1' },
        prompt: 'p',
        worktreePath,
        config: cfg,
        roostDir: cfg.roostDir,
        backlogRoot: dir,
        provider: noLimit,
      }).refusal,
      null,
    );
  } finally {
    cleanup();
  }
});

test('launchSession leaves a lock this process holds, and takes and releases a free one', () => {
  const { dir, cleanup } = mkTempBacklog();
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    const lockPath = join(wt, '.workon.lock');
    const during = [];
    const provider = new (class extends AgentProvider {
      findSession() {
        return null;
      }
      spawn() {
        during.push(readFileSync(lockPath, 'utf8'));
        return { status: 0 };
      }
    })();
    const launch = () =>
      launchSession({
        mode: 'review',
        parsed: { id: 'F-1' },
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
        sessionName: 'F-1: review',
        provider,
      });

    // A review round's lock: an interactive pass inside it neither rewrites nor removes it.
    const round = `${process.pid}\n2026-09-24T00:00:00Z\nF-1 review round\n`;
    writeFileSync(lockPath, round);
    assert.equal(launch(), 0);
    assert.equal(during[0], round, "the round's lock held during the session");
    assert.equal(readFileSync(lockPath, 'utf8'), round, 'and still held after it');

    // No lock: the session takes one and releases it.
    rmSync(lockPath);
    assert.equal(launch(), 0);
    assert.match(during[1], /F-1: review/);
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (tmux != null) process.env.TMUX = tmux;
    cleanup();
  }
});

test('withHeadlessRules tells review sessions not to background or wait, without asking them to commit', async () => {
  const { withHeadlessRules } = await import('../../src/session.js');
  const review = withHeadlessRules('Review this.\n\n', 'review');
  assert.match(review, /^Review this\.\n\n## This session is headless\n/);
  assert.match(review, /never end a reply by saying you will wait/);
  assert.match(review, /run the tests that cover\s+what you changed instead/);
  assert.doesNotMatch(review, /Commit every change/, 'reviewers never commit');
  assert.match(withHeadlessRules('x', 'workon'), /Commit every change you make before you end/);
});

// The message F-41's run captured on 2026-10-13 (.bl/run/F-41.json).
const F41_LIMIT =
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 6:10pm (America/Los_Angeles)";
// 2026-10-13T23:59:36Z is Tuesday 13 October, 4:59pm in Los Angeles.
const NOW = new Date('2026-10-13T23:59:36Z');

function inZone(date, zone) {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(zone);
}

test('parseLimit reads the kind, the message and the absolute reset time out of a usage-limit refusal', () => {
  const spend = parseLimit(F41_LIMIT, NOW);
  assert.equal(spend.kind, 'spend');
  assert.equal(spend.scope, 'model', "Claude's caps are per model");
  assert.equal(spend.message, F41_LIMIT);
  assert.equal(spend.resetsAt.toISOString(), '2026-10-14T01:10:00.000Z');
  // The message is the line the refusal starts on, whatever surrounds it.
  assert.equal(parseLimit(`Some preamble\n${F41_LIMIT}\nmore text`, NOW).message, F41_LIMIT);

  // Documented forms. No zone: the process's local zone, next occurrence.
  const local = Temporal.Now.timeZoneId();
  const session = parseLimit("You've hit your session limit · resets 3:45pm", NOW);
  assert.equal(session.kind, 'session');
  assert.equal(session.message, "You've hit your session limit · resets 3:45pm");
  const s = inZone(session.resetsAt, local);
  assert.deepEqual([s.hour, s.minute, s.second], [15, 45, 0]);
  assert.ok(session.resetsAt > NOW && session.resetsAt - NOW <= 24 * 3_600_000, 'the next 3:45pm');

  const weekly = parseLimit("You've hit your weekly limit · resets Mon 12:00am", NOW);
  assert.equal(weekly.kind, 'weekly');
  const w = inZone(weekly.resetsAt, local);
  assert.deepEqual([w.dayOfWeek, w.hour, w.minute], [1, 0, 0]);
  assert.ok(weekly.resetsAt > NOW && weekly.resetsAt - NOW <= 7 * 24 * 3_600_000, 'the next Monday');

  const noReset = parseLimit("You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage", NOW);
  assert.deepEqual(noReset, {
    kind: 'spend',
    scope: 'model',
    message: "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage",
    resetsAt: null,
  });

  assert.equal(
    parseLimit("You've hit your session limit · resets at 3:45pm (UTC)", NOW).resetsAt.toISOString(),
    '2026-10-14T15:45:00.000Z',
  );
  assert.equal(
    parseLimit('You’ve hit your session limit · resets 6pm (America/Los_Angeles)', NOW).resetsAt.toISOString(),
    '2026-10-14T01:00:00.000Z',
    'curly apostrophe, no minutes, not yet past',
  );
  assert.equal(parseLimit("You've hit your organization limit · resets 3pm (UTC)", NOW).kind, 'other');
  // A time named before the limit sentence is not the reset.
  assert.equal(
    parseLimit(
      "Limits reset at 9:00am daily.\nYou've hit your session limit · resets 3:45pm (UTC)",
      NOW,
    ).resetsAt.toISOString(),
    '2026-10-14T15:45:00.000Z',
  );
  assert.equal(parseLimit("Limits reset at 9:00am daily.\nYou've hit your session limit", NOW).resetsAt, null);

  // Not a limit.
  assert.equal(parseLimit('Error: rate limited', NOW), null);
  assert.equal(parseLimit('', NOW), null);
  assert.equal(parseLimit(null, NOW), null);
});

test('parseLimit rolls a wall-clock time already past to the next day or the next named weekday', () => {
  const at = (text) => parseLimit(text, NOW).resetsAt.toISOString();
  // Next day: 11:30pm UTC was 29 minutes ago.
  assert.equal(at("You've hit your session limit · resets 11:30pm (UTC)"), '2026-10-14T23:30:00.000Z');
  // Exactly now counts as past.
  assert.equal(
    parseLimit(
      "You've hit your session limit · resets 11:59pm (UTC)",
      new Date('2026-10-13T23:59:00Z'),
    ).resetsAt.toISOString(),
    '2026-10-14T23:59:00.000Z',
  );
  // 12-hour wraparound.
  assert.equal(at("You've hit your session limit · resets 12:00am (UTC)"), '2026-10-14T00:00:00.000Z');
  assert.equal(at("You've hit your session limit · resets 12:30pm (UTC)"), '2026-10-14T12:30:00.000Z');
  // Weekdays: the same weekday earlier today means next week; later today means today.
  assert.equal(
    at("You've hit your weekly limit · resets Tue 4:00pm (America/Los_Angeles)"),
    '2026-10-20T23:00:00.000Z',
  );
  assert.equal(
    at("You've hit your weekly limit · resets Tue 5:30pm (America/Los_Angeles)"),
    '2026-10-14T00:30:00.000Z',
  );
  assert.equal(
    at("You've hit your weekly limit · resets Mon 12:00am (America/Los_Angeles)"),
    '2026-10-19T07:00:00.000Z',
  );
  assert.equal(at("You've hit your weekly limit · resets Wednesday 9:00am (UTC)"), '2026-10-14T09:00:00.000Z');
  // A reset the regex matches but the clock cannot hold is no reset time.
  assert.equal(parseLimit("You've hit your session limit · resets 13:00pm (UTC)", NOW).resetsAt, null);
});

// The message S-865's review round captured on 2026-10-14: the error of the
// `turn.failed` event `codex exec --json` ended on.
const S865_LIMIT =
  "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Oct 15th, 2026 1:40 AM.";
const S865_EVENT = JSON.stringify({ type: 'turn.failed', error: { message: S865_LIMIT } });

/** `fields` (year, month, day, hour, minute) as an instant in the process's zone. */
function localClock(fields) {
  return new Date(Temporal.ZonedDateTime.from({ timeZone: Temporal.Now.timeZoneId(), ...fields }).epochMilliseconds);
}

test('parseCodexLimit reads the kind, the message and the absolute reset time out of a Codex refusal', () => {
  const local = Temporal.Now.timeZoneId();
  const wall = (date) => {
    const z = inZone(date, local);
    return [z.year, z.month, z.day, z.hour, z.minute, z.second];
  };
  const r = parseCodexLimit(S865_LIMIT, NOW);
  assert.equal(r.kind, 'other', 'a usage limit is no spend, weekly or session limit');
  assert.equal(r.scope, 'account', 'Codex has one quota for every model');
  assert.equal(r.message, S865_LIMIT);
  assert.deepEqual(wall(r.resetsAt), [2026, 10, 15, 1, 40, 0], 'the named date and time, local zone');
  // The message is the line the refusal starts on, whatever surrounds it.
  assert.equal(parseCodexLimit(`preamble\n${S865_LIMIT}\nmore`, NOW).message, S865_LIMIT);
  // A full date is taken as is, even one already past (the hit-again rule bounds it).
  assert.deepEqual(
    wall(parseCodexLimit("You've hit your usage limit. Try again at Jan 2nd, 2020 11:05 PM.", NOW).resetsAt),
    [2020, 1, 2, 23, 5, 0],
  );
  assert.deepEqual(
    wall(parseCodexLimit("You've hit your usage limit. Try again at September 1, 2026 12:00 AM.", NOW).resetsAt),
    [2026, 9, 1, 0, 0, 0],
  );
  assert.deepEqual(
    wall(parseCodexLimit("You've hit your usage limit. Try again at Oct 15th, 2026 12:30PM.", NOW).resetsAt),
    [2026, 10, 15, 12, 30, 0],
  );

  // A time alone: today while still ahead, tomorrow once past.
  const bare = "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 1:40 AM.";
  const before = localClock({ year: 2026, month: 10, day: 14, hour: 1, minute: 0 });
  const after = localClock({ year: 2026, month: 10, day: 14, hour: 2, minute: 0 });
  assert.deepEqual(wall(parseCodexLimit(bare, before).resetsAt), [2026, 10, 14, 1, 40, 0]);
  assert.deepEqual(wall(parseCodexLimit(bare, after).resetsAt), [2026, 10, 15, 1, 40, 0]);
  // Exactly now counts as past.
  assert.deepEqual(
    wall(parseCodexLimit(bare, localClock({ year: 2026, month: 10, day: 14, hour: 1, minute: 40 })).resetsAt),
    [2026, 10, 15, 1, 40, 0],
  );

  // No reset time, or one the calendar cannot hold.
  const later = "You've hit your usage limit. Please try again later.";
  assert.deepEqual(parseCodexLimit(later, NOW), { kind: 'other', scope: 'account', message: later, resetsAt: null });
  assert.equal(
    parseCodexLimit("You've hit your usage limit. Try again at Oct 15th, 2026 13:99 PM.", NOW).resetsAt,
    null,
  );
  assert.equal(parseCodexLimit("You've hit your usage limit. Try again at 0:30 AM.", NOW).resetsAt, null);
  assert.equal(
    parseCodexLimit("You've hit your usage limit. Try again at Feb 30th, 2026 1:40 AM.", NOW).resetsAt,
    null,
  );
  // A time named before the limit sentence is not the reset.
  assert.equal(parseCodexLimit("Try again at 9:00 AM daily.\nYou've hit your usage limit.", NOW).resetsAt, null);
  // The kind follows Claude's classification.
  assert.equal(parseCodexLimit("You've hit your weekly limit. Try again at 1:40 AM.", NOW).kind, 'weekly');

  // Not a limit.
  assert.equal(parseCodexLimit('Error: rate limited', NOW), null);
  assert.equal(parseCodexLimit('', NOW), null);
  assert.equal(parseCodexLimit(null, NOW), null);
});

test('parseCodexJsonEvents carries the refusal an error event names, not one the agent merely quoted', () => {
  const refused = parseCodexJsonEvents(
    [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      S865_EVENT,
    ].join('\n'),
  );
  assert.equal(refused.isError, true);
  assert.equal(refused.refusal.kind, 'other');
  assert.equal(refused.refusal.message, S865_LIMIT);
  assert.ok(refused.refusal.resetsAt instanceof Date);
  assert.equal(refused.usage, null);
  // A `type: "error"` event names it in `message`.
  const err = parseCodexJsonEvents(JSON.stringify({ type: 'error', message: S865_LIMIT }));
  assert.equal(err.isError, true);
  assert.equal(err.refusal.message, S865_LIMIT);
  // A successful turn whose agent message quotes the sentence is not a refusal.
  const quoted = parseCodexJsonEvents(
    [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: `The provider says "${S865_LIMIT}" when it refuses.` },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'),
  );
  assert.equal(quoted.isError, false);
  assert.equal(quoted.refusal, null);
  // An error that is no limit: an error, no limit.
  const other = parseCodexJsonEvents(
    JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }),
  );
  assert.equal(other.isError, true);
  assert.equal(other.refusal, null);
  assert.equal(parseCodexJsonEvents('').refusal, null);
});

// The F-48 review round 1 verifier's refusal (F-64 Premise), verbatim.
const F48_CAPACITY_EVENT =
  '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}';

test("parseCodexJsonEvents reads Codex's capacity refusal as the model's, with no reset", () => {
  const capacity = {
    kind: 'capacity',
    scope: 'model',
    message: 'Selected model is at capacity. Please try a different model.',
    resetsAt: null,
  };
  const failed = parseCodexJsonEvents([JSON.stringify({ type: 'turn.started' }), F48_CAPACITY_EVENT].join('\n'));
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.refusal, capacity);
  // An `error` event that says "try a different model".
  const err = parseCodexJsonEvents(
    JSON.stringify({ type: 'error', message: 'Model overloaded; try a different model.' }),
  );
  assert.equal(err.isError, true);
  assert.deepEqual(err.refusal, { ...capacity, message: 'Model overloaded; try a different model.' });
  // A usage limit is still the account's, and wins over a capacity line.
  const both = parseCodexJsonEvents([F48_CAPACITY_EVENT, S865_EVENT].join('\n'));
  assert.equal(both.refusal.kind, 'capacity', 'the first refusal event is the one read');
  const usage = parseCodexJsonEvents(S865_EVENT);
  assert.equal(usage.refusal.kind, 'other');
  assert.equal(usage.refusal.scope, 'account');
  // A successful session that quotes the sentence ran.
  const quoted = parseCodexJsonEvents(
    [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Codex says it is at capacity sometimes.' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'),
  );
  assert.equal(quoted.refusal, null);
});

test("parseCodexCapacity takes the refusal's own line and nothing else", () => {
  assert.equal(
    parseCodexCapacity('preamble\nSelected model is at capacity.\nmore').message,
    'Selected model is at capacity.',
  );
  assert.equal(parseCodexCapacity('stream disconnected'), null);
  assert.equal(parseCodexCapacity(null), null);
});

test('parseCodexJsonEvents does not borrow a reset time from another error event', () => {
  const later = "You've hit your usage limit. Please try again later.";
  const transport = 'Transport unavailable; try again at 1:40 AM.';
  const errorEv = (message) => JSON.stringify({ type: 'error', message });
  const failedEv = (message) => JSON.stringify({ type: 'turn.failed', error: { message } });
  const stream = (...events) => parseCodexJsonEvents(events.join('\n'));
  // Each error event is read on its own: a limit with no reset stays without
  // one whatever other error event names a time, before or after it.
  for (const [name, r] of [
    ['limit then reset text', stream(errorEv(later), failedEv(transport))],
    ['reset text then limit', stream(failedEv(transport), errorEv(later))],
    ['limit between two reset texts', stream(errorEv(transport), failedEv(later), errorEv(transport))],
    ['limit then a second limit naming a reset', stream(failedEv(later), failedEv(S865_LIMIT))],
  ]) {
    assert.equal(r.isError, true, name);
    assert.equal(r.refusal.message, later, name);
    assert.equal(r.refusal.resetsAt, null, name);
  }
  // A limit event's own reset still counts, whatever error events precede it.
  const own = stream(failedEv(transport), errorEv('stream disconnected'), failedEv(S865_LIMIT));
  assert.equal(own.refusal.message, S865_LIMIT);
  assert.ok(own.refusal.resetsAt instanceof Date);
  // An error event with no message is skipped, not read as text.
  const bare = stream(JSON.stringify({ type: 'turn.failed', error: { code: 7 } }), failedEv(S865_LIMIT));
  assert.equal(bare.refusal.message, S865_LIMIT);
});

test('CodexProvider.spawn headless surfaces the refusal the event stream names', () => {
  const p = new CodexProvider();
  const spawnWith = (result) =>
    p.spawn({
      prompt: 'p',
      worktreePath: '/wt',
      backlogRoot: '/bl',
      headless: true,
      ensureApprovedCommandPrefixes: () => ({ added: 0 }),
      run: () => result,
    });
  // The output-last-message file is empty on a failed turn: the limit comes from the events.
  const refused = spawnWith({ status: 1, stdout: [JSON.stringify({ type: 'thread.started' }), S865_EVENT].join('\n') });
  assert.equal(refused.isError, true);
  assert.equal(refused.refusal.kind, 'other');
  assert.equal(refused.refusal.scope, 'account');
  assert.equal(refused.refusal.message, S865_LIMIT);
  assert.ok(refused.refusal.resetsAt instanceof Date);
  const ok = spawnWith({
    status: 0,
    stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }),
  });
  assert.equal(ok.isError, false);
  assert.equal(ok.refusal, null);
});

test('parseClaudeJsonResult carries the refusal the result text names', () => {
  const r = parseClaudeJsonResult(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: F41_LIMIT, session_id: 's' }),
  );
  assert.equal(r.isError, true);
  assert.equal(r.refusal.kind, 'spend');
  assert.equal(r.refusal.scope, 'model');
  assert.equal(r.refusal.message, F41_LIMIT);
  assert.ok(r.refusal.resetsAt instanceof Date);
  assert.equal(parseClaudeJsonResult(JSON.stringify({ type: 'result', result: 'done' })).refusal, null);
  assert.equal(parseClaudeJsonResult('not json').refusal, null);
  assert.equal(parseClaudeJsonResult(F41_LIMIT).refusal.kind, 'spend', 'a bare, unparsed refusal still counts');
});

test('runHeadlessSession with usageStep adds the usage to tokens_by_step; without it, the totals only', () => {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const wt = mkTempDir('bl-wt-');
    const featurePath = join(dir, 'feature.md');
    writeFileSync(featurePath, '---\nfeature_id: F-1\ntitle: T\n---\n\n# T\n');
    const fake = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      spawn() {
        return {
          status: 1,
          output: '',
          isError: true,
          usage: { input: 2, output: 3, cache_creation: 0, cache_read: 1 },
        };
      }
    })();
    const run = (extra) =>
      runHeadlessSession({
        mode: 'workon',
        parsed: { id: 'F-1' },
        prompt: 'p',
        worktreePath: wt,
        config: cfg,
        roostDir: cfg.roostDir,
        backlogRoot: dir,
        usageIndexPath: featurePath,
        provider: fake,
        ...extra,
      });
    run({});
    let { fm } = parseFrontmatter(readFileSync(featurePath, 'utf8'));
    assert.equal(fm.tokens_input, '2');
    assert.equal(fm.tokens_by_step, undefined);
    // A session that ended in error still records what it used.
    const r = run({ usageStep: 'review.1' });
    assert.equal(r.isError, true);
    ({ fm } = parseFrontmatter(readFileSync(featurePath, 'utf8')));
    assert.equal(fm.tokens_input, '4');
    assert.equal(fm.tokens_headless_input, '4');
    assert.deepEqual(fm.tokens_by_step, {
      'review.1': { input: '2', output: '3', cache_creation: '0', cache_read: '1' },
    });
  } finally {
    cleanup();
  }
});
