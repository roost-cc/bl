// bl watch (S-1272): the adapters' followHandle()/followSession() over
// recorded Claude and Codex fixtures, the Codex spawn writing its event
// stream to the handle's file, and watchRun following a run state's session
// from step to step until the run ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import stringWidth from 'string-width';
import { getProvider } from '../../src/agents/index.js';
import { buildClaudeArgs, pathToProjectSlug } from '../../src/agents/claude.js';
import { FOLLOW_LAST } from '../../src/agents/follow.js';
import { RUN_DIR, runLockPath } from '../../src/run-lock.js';
import { tryLock, release } from '../../src/kernel-lock.js';
import { cutLine, watchRun } from '../../src/watch.js';
import { mkTempDir } from '../helpers/tempdir.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/watch/', import.meta.url));
const CLAUDE_FIXTURE = join(FIXTURES, 'claude-transcript.jsonl');
const CODEX_FIXTURE = join(FIXTURES, 'codex-events.jsonl');

/** Every event a follow of `path` yields from the start, read once (the signal is already aborted). */
async function readAll(agent, path, opts = {}) {
  const controller = new AbortController();
  controller.abort();
  const events = [];
  for await (const ev of getProvider(agent).followSession(
    { id: null, path },
    { fromStart: true, ...opts, signal: controller.signal },
  ))
    events.push(ev);
  return events;
}

const noAt = (events) => events.map(({ at: _at, ...rest }) => rest);

test('a recorded Claude transcript streams its messages and tool calls, never thinking or tool output', async () => {
  const events = await readAll('claude', CLAUDE_FIXTURE);
  assert.deepEqual(noAt(events), [
    { kind: 'text', text: "I'll read the story first." },
    { kind: 'tool', tool: 'Read', summary: '/w/backlog/stories/S1-first/index.md' },
    { kind: 'tool', tool: 'Grep', summary: 'followSession' },
    { kind: 'tool', tool: 'Bash', summary: 'Run the unit tests' },
    { kind: 'text', text: 'Done.\n\nAll unit tests pass.' },
  ]);
  assert.deepEqual(
    events.map((e) => e.at),
    [
      '2026-11-12T01:17:34.000Z',
      '2026-11-12T01:17:35.000Z',
      '2026-11-12T01:17:40.000Z',
      '2026-11-12T01:17:50.000Z',
      '2026-11-12T01:18:25.000Z',
    ],
    "each event's time is its record's",
  );
  assert.ok(!JSON.stringify(events).includes('MUST-NOT-SHOW'));
});

test('a recorded Codex event stream streams its messages and tool calls, never reasoning or command output', async () => {
  const events = await readAll('codex', CODEX_FIXTURE);
  assert.deepEqual(noAt(events), [
    { kind: 'tool', tool: 'exec_command', summary: "bash -lc 'rg -n followSession src'" },
    { kind: 'text', text: 'The adapter has no follow method yet.' },
    {
      kind: 'tool',
      tool: 'apply_patch',
      summary: '/w/f1-feat/bl/src/agents/provider.js /w/f1-feat/bl/src/watch.js',
    },
    { kind: 'tool', tool: 'docs.search', summary: '' },
    { kind: 'tool', tool: 'web_search', summary: 'codex exec json events' },
    { kind: 'text', text: 'Done:\n- the review found nothing.' },
  ]);
  assert.ok(
    events.every((e) => Number.isFinite(Date.parse(e.at))),
    'an event with no time of its own gets the read time',
  );
  assert.ok(!JSON.stringify(events).includes('MUST-NOT-SHOW'));
});

test('a follow starts with the last 30 events, or all of them from the start', async () => {
  const dir = mkTempDir('bl-watch-');
  const path = join(dir, 'many.jsonl');
  const lines = Array.from({ length: FOLLOW_LAST + 10 }, (_, i) =>
    JSON.stringify({ type: 'item.completed', item: { id: `i${i}`, type: 'agent_message', text: `m${i}` } }),
  );
  writeFileSync(path, `${lines.join('\n')}\n`);
  const tail = await readAll('codex', path, { fromStart: false });
  assert.equal(tail.length, FOLLOW_LAST);
  assert.equal(tail[0].text, 'm10');
  assert.equal((await readAll('codex', path)).length, FOLLOW_LAST + 10);
});

test('a follow waits for its file, yields lines as they are written and reads once more when stopped', async () => {
  const dir = mkTempDir('bl-watch-');
  const path = join(dir, 'live.jsonl');
  const controller = new AbortController();
  const seen = [];
  const msg = (text) =>
    `${JSON.stringify({ type: 'item.completed', item: { id: text, type: 'agent_message', text } })}\n`;
  const loop = (async () => {
    for await (const ev of getProvider('codex').followSession(
      { id: null, path },
      { signal: controller.signal, intervalMs: 10 },
    ))
      seen.push(ev.text);
  })();
  const until = async (n) => {
    for (let i = 0; i < 500 && seen.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };
  // The file appears after the follow started: all of it is new, even past 30 events.
  writeFileSync(path, msg('one'));
  await until(1);
  // Half a line waits for its end.
  const two = msg('two');
  appendFileSync(path, two.slice(0, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ['one']);
  appendFileSync(path, two.slice(10));
  await until(2);
  // A line written just before the stop is still read.
  appendFileSync(path, msg('three'));
  controller.abort();
  await loop;
  assert.deepEqual(seen, ['one', 'two', 'three']);
});

test('Claude: the follow handle names the transcript of a new session id, which spawn passes as --session-id', async () => {
  const cfg = mkTempDir('bl-claude-cfg-');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const claude = getProvider('claude');
    const handle = claude.followHandle({ cwd: '/w/f1-feat', eventsPath: '/unused' });
    assert.match(handle.id, /^[0-9a-f-]{36}$/);
    assert.equal(handle.path, join(cfg, 'projects', pathToProjectSlug('/w/f1-feat'), `${handle.id}.jsonl`));
    const resumed = claude.followHandle({ cwd: '/w/f1-feat', eventsPath: '/unused', sessionId: 'abc' });
    assert.equal(resumed.id, 'abc', 'a resume follows the session it continues');

    let seen = null;
    await claude.spawn({
      prompt: 'p',
      worktreePath: '/wt',
      headless: true,
      follow: handle,
      run: (cmd, args) => {
        seen = args;
        return { status: 0, stdout: '{}' };
      },
    });
    assert.equal(seen[seen.indexOf('--session-id') + 1], handle.id);
  } finally {
    if (prev == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
  const resume = buildClaudeArgs({ headless: true, sessionId: 'abc', newSessionId: 'new' });
  assert.ok(resume.includes('--resume') && !resume.includes('--session-id'), 'a resume keeps its own id');
  assert.ok(!buildClaudeArgs({ newSessionId: 'new' }).includes('--session-id'), 'interactive: no --session-id');
});

test('Codex: spawn writes the --json event stream to the follow handle file and still reads it', async () => {
  const dir = mkTempDir('bl-watch-');
  const codex = getProvider('codex');
  const handle = codex.followHandle({ cwd: dir, eventsPath: join(dir, 'F-1.0.implement.events.jsonl') });
  assert.deepEqual(handle, { id: null, path: join(dir, 'F-1.0.implement.events.jsonl') });
  let stdio = null;
  const r = await codex.spawn({
    prompt: 'p',
    worktreePath: dir,
    headless: true,
    follow: handle,
    ensureApprovedCommandPrefixes: () => ({ added: 0 }),
    run: (cmd, args, opts) => {
      stdio = opts.stdio;
      // The fake codex writes its stream to the descriptor it was given, as codex does.
      writeSync(opts.stdio[1], readFileSync(CODEX_FIXTURE, 'utf8'));
      return { status: 0, stdout: null, stderr: '' };
    },
  });
  assert.equal(typeof stdio[1], 'number', 'stdout is the file, not a pipe');
  assert.equal(readFileSync(handle.path, 'utf8'), readFileSync(CODEX_FIXTURE, 'utf8'));
  assert.equal(r.sessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.deepEqual(r.usage, { input: 1000, output: 300, cache_creation: 0, cache_read: 1000 });
  assert.equal(r.output, readFileSync(CODEX_FIXTURE, 'utf8').trim(), 'no last message: the stream is the output');
});

test('Gemini cannot follow a session', () => {
  const gemini = getProvider('gemini');
  assert.equal(gemini.followHandle({ cwd: '/w', eventsPath: '/e' }), null);
  assert.throws(() => gemini.followSession({ id: null, path: '/e' }), /gemini cannot follow a session/);
});

test('watch_text_fits_terminal_cells: cutLine keeps every line within the width in cells', () => {
  const cases = [
    // [line, width, cut]
    ['short', 80, 'short'],
    ['💬 abcdefghij', 8, '💬 abcd…'],
    ['界界', 3, '界…'],
    ['💬💬', 3, '💬…'],
    ['界界', 4, '界界'],
    ['x', 1, 'x'],
    ['xy', 1, '…'],
    ['界', 1, '…'],
    ['💬 a', 1, '…'],
    ['xy', 0, ''],
    // A header and a tool line, as watchRun builds them.
    ['── implement S-1 · claude · 界界界界 ──', 20, '── implement S-1 · …'],
    ['🔧 Read  /w/界/💬/x', 12, '🔧 Read  /w…'],
    // One grapheme of several code points is never split.
    ['👩‍👩‍👧 family', 3, '👩‍👩‍👧…'],
  ];
  for (const [line, width, cut] of cases) {
    const got = cutLine(line, width);
    assert.equal(got, cut, `${JSON.stringify(line)} at ${width}`);
    assert.ok(stringWidth(got) <= width, `${JSON.stringify(got)} fits ${width} cells`);
  }
});

/** A backlog with a run state for F-1 whose session is `session`, its run lock held by this process. */
function runFixture(session) {
  const dir = mkTempDir('bl-watch-');
  mkdirSync(join(dir, RUN_DIR), { recursive: true });
  const config = { backlogRoot: dir };
  const state = { feature: 'F-1', status: 'running', step: 'implement', history: [], session };
  const save = () => writeFileSync(join(dir, RUN_DIR, 'F-1.json'), JSON.stringify(state));
  save();
  const lock = tryLock(runLockPath(config, 'F-1'));
  return { dir, config, state, save, lock: lock.taken };
}

test('watchRun follows the step session, moves to the next one, and ends when the run does', async () => {
  const { dir, config, state, save, lock } = runFixture(null);
  const claude = join(dir, 'claude.jsonl');
  const codex = join(dir, 'codex.jsonl');
  copyFileSync(CLAUDE_FIXTURE, claude);
  try {
    const out = [];
    const err = [];
    const done = watchRun({
      config,
      id: 'F-1',
      json: true,
      out: (l) => out.push(JSON.parse(l)),
      err: (l) => err.push(l),
      pollMs: 20,
    });
    const until = async (pred) => {
      for (let i = 0; i < 500 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    state.session = {
      step: 'implement',
      story: 'S-1',
      agent: 'claude',
      model: 'opus',
      id: 'sid-1',
      path: claude,
      startedAt: 'a',
    };
    save();
    await until(() => out.filter((o) => o.kind === 'text').length === 2);
    // The next step: a Codex review pass; its stream is written after the switch.
    state.step = 'review:correctness';
    state.session = {
      step: 'review:correctness',
      story: null,
      agent: 'codex',
      model: null,
      id: null,
      path: codex,
      startedAt: 'b',
    };
    save();
    await until(() => out.filter((o) => o.kind === 'step').length === 2);
    copyFileSync(CODEX_FIXTURE, codex);
    await until(() => out.filter((o) => o.kind === 'text').length === 4);
    state.status = 'escalated';
    save();
    // The run's bl lets the run go after it saves its end.
    release(lock);
    assert.equal(await done, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(
      out.map((o) => (o.kind === 'step' ? `step ${o.step} ${o.story} ${o.agent} ${o.model} ${o.session}` : o.kind)),
      [
        'step implement S-1 claude opus sid-1',
        'text',
        'tool',
        'tool',
        'tool',
        'text',
        'step review:correctness null codex null null',
        'tool',
        'text',
        'tool',
        'tool',
        'tool',
        'text',
        'end',
      ],
    );
    assert.deepEqual(out.at(-1), { kind: 'end', status: 'escalated' });
    assert.deepEqual(Object.keys(out[1]), ['kind', 'at', 'text']);
    assert.deepEqual(Object.keys(out[2]), ['kind', 'at', 'tool', 'summary']);
  } finally {
    release(lock);
  }
});

test('watchRun text: a header, one line per event, the end line; a run no bl holds ends as stale', async () => {
  const { dir, config, state, save, lock } = runFixture(null);
  const claude = join(dir, 'claude.jsonl');
  copyFileSync(CLAUDE_FIXTURE, claude);
  state.session = {
    step: 'implement',
    story: 'S-1',
    agent: 'claude',
    model: null,
    id: 'sid-1',
    path: claude,
    startedAt: 'a',
  };
  save();
  // Nobody holds the run: a bl killed mid-run. watch prints what is there and ends.
  release(lock);
  const out = [];
  const code = await watchRun({
    config,
    id: 'F-1',
    out: (l) => out.push(l),
    err: () => {},
    width: () => 40,
    pollMs: 20,
  });
  assert.equal(code, 0);
  assert.deepEqual(out, [
    '── implement S-1 · claude · sid-1 ──',
    "💬 I'll read the story first.",
    '🔧 Read  /w/backlog/stories/S1-first/in…',
    '🔧 Grep  followSession',
    '🔧 Bash  Run the unit tests',
    '💬 Done. All unit tests pass.',
    '── F-1 · stale ──',
  ]);
});

test('watchRun: no run state is an error on stderr and exit 1; a session with no live feed says so', async () => {
  const dir = mkTempDir('bl-watch-');
  const err = [];
  const out = [];
  assert.equal(
    await watchRun({ config: { backlogRoot: dir }, id: 'F-2', out: (l) => out.push(l), err: (l) => err.push(l) }),
    1,
  );
  assert.deepEqual(out, []);
  assert.match(err[0], /^bl watch: no run state for F-2 \(/);

  const { config, state, save, lock } = runFixture({
    step: 'implement',
    story: 'S-1',
    agent: 'gemini',
    model: null,
    id: null,
    path: null,
    startedAt: 'a',
  });
  state.status = 'clean';
  save();
  release(lock);
  const err2 = [];
  const out2 = [];
  assert.equal(
    await watchRun({ config, id: 'F-1', out: (l) => out2.push(l), err: (l) => err2.push(l), pollMs: 20 }),
    0,
  );
  assert.deepEqual(out2, ['── implement S-1 · gemini · - ──', '── F-1 · clean ──']);
  assert.match(err2[0], /this gemini session has no live feed/);
});

test('watch_standalone_session_until_holder_exits: a review or merge session is followed until its bl lets the run go', async () => {
  // The saved status before a standalone bl review or bl merge, which leaves it as it is while it works.
  for (const status of ['reviewed', 'clean', 'escalated', 'stopped', 'running']) {
    const { dir, state, save, config, lock } = runFixture(null);
    const claude = join(dir, 'claude.jsonl');
    copyFileSync(CLAUDE_FIXTURE, claude);
    Object.assign(state, {
      status,
      session: {
        step: 'review:correctness',
        story: null,
        agent: 'claude',
        model: null,
        id: 's',
        path: claude,
        startedAt: 'a',
      },
    });
    save();
    try {
      const out = [];
      const done = watchRun({
        config,
        id: 'F-1',
        json: true,
        out: (l) => out.push(JSON.parse(l)),
        err: () => {},
        pollMs: 10,
      });
      for (let i = 0; i < 500 && out.filter((o) => o.kind === 'text').length < 2; i++) await delay(10);
      // Several polls with the holder alive: no end.
      await delay(100);
      assert.ok(!out.some((o) => o.kind === 'end'), `${status}: no end while a bl holds the run`);
      release(lock);
      assert.equal(await done, 0);
      assert.deepEqual(out.at(-1), { kind: 'end', status: status === 'running' ? 'stale' : status }, status);
    } finally {
      release(lock);
    }
  }
});
