// The session carriers of the outcome contract (F-68 D1): the outcome file an
// interactive session writes, and the schema a headless one passes through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { AgentProvider } from '../../src/agents/provider.js';
import { launchSession, runHeadlessSession } from '../../src/session.js';
import { outcomePath } from '../../src/outcome.js';
import { loadConfig } from '../../src/config.js';
import { mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, refined: { type: 'boolean' } },
  required: ['summary', 'refined'],
  additionalProperties: false,
};

/**
 * launchSession on F-3 with a provider stub whose `spawn(opts, file)` plays
 * the agent; returns what launchSession returned and the prompt it sent.
 * `before(file)` runs before the launch.
 */
async function launch(spawn, extra = {}, before = null) {
  const { dir, cleanup } = mkTempBacklog();
  const tmux = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const file = outcomePath(dir, 'F-3');
    before?.(file);
    let prompt = null;
    const provider = new (class extends AgentProvider {
      findSession() {
        return null;
      }
      spawn(opts) {
        prompt = opts.prompt;
        return spawn(opts, file);
      }
    })();
    const ret = await launchSession({
      mode: 'refine',
      parsed: { id: 'F-3' },
      title: 'T',
      worktreePath: mkTempDir('bl-wt-'),
      branchName: 'b',
      sessionPrompt: 'Refine. Write your outcome to {{outcomePath}} as your last act.',
      roostDir: cfg.roostDir,
      backlogRoot: dir,
      isNewWorktree: false,
      config: cfg,
      forceNew: true,
      returnOnExit: true,
      recordTokens: false,
      provider,
      ...extra,
    });
    return { ret, prompt, file, left: existsSync(file) };
  } finally {
    if (tmux != null) process.env.TMUX = tmux;
    cleanup();
  }
}

test('launchSession names the outcome file in the prompt, then reads, validates and deletes it', async () => {
  const { ret, prompt, file, left } = await launch(
    (_opts, f) => {
      writeFileSync(f, JSON.stringify({ summary: 'refined F-3', refined: true }));
      return { status: 0 };
    },
    { schema: SCHEMA },
  );
  assert.equal(prompt, `Refine. Write your outcome to ${file} as your last act.`);
  assert.match(file, /\/\.bl\/outcome\/F-3\.json$/);
  assert.deepEqual(ret, { status: 0, structured: { summary: 'refined F-3', refined: true }, structuredError: null });
  assert.equal(left, false, 'the file is deleted');
});

test('launchSession removes a stale outcome file before the session starts', async () => {
  let stale = null;
  const { ret } = await launch(
    (_opts, f) => {
      stale = existsSync(f);
      return { status: 0 };
    },
    { schema: SCHEMA },
    // An earlier session's valid file: never this session's outcome.
    (f) => {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({ summary: 'old', refined: true }));
    },
  );
  assert.equal(stale, false, 'gone before the spawn');
  assert.equal(ret.structured, null);
  assert.match(ret.structuredError, /^no outcome file at /);
});

test('launchSession: no file, an invalid file, or a failed launch is a fault, never an outcome', async () => {
  const none = await launch(() => ({ status: 0 }), { schema: SCHEMA });
  assert.equal(none.ret.status, 0);
  assert.equal(none.ret.structured, null);
  assert.equal(none.ret.structuredError, `no outcome file at ${none.file}`);

  const bad = await launch(
    (_opts, f) => {
      writeFileSync(f, JSON.stringify({ summary: 's', refined: true, status: 'refined' }));
      return { status: 0 };
    },
    { schema: SCHEMA },
  );
  assert.equal(bad.ret.structuredError, 'schema violation at $/status: must NOT have additional properties');
  assert.equal(bad.left, true, 'the invalid file is kept for the operator');

  const failed = await launch(() => ({ error: new Error('ENOENT'), status: null }), { schema: SCHEMA });
  assert.equal(failed.ret.status, 1);
  assert.equal(failed.ret.structured, null);
  assert.match(failed.ret.structuredError, /^no outcome file at /);
});

test('launchSession without a schema returns the bare status and leaves {{outcomePath}} alone', async () => {
  const { ret, prompt } = await launch(() => ({ status: 3 }));
  assert.equal(ret, 3);
  assert.match(prompt, /\{\{outcomePath\}\}/);
});

test('launchSession refuses a schema without returnOnExit, before any session starts', async () => {
  let spawned = false;
  await assert.rejects(
    async () =>
      launch(
        () => {
          spawned = true;
          return { status: 0 };
        },
        { schema: SCHEMA, returnOnExit: false },
      ),
    /launchSession: a schema needs returnOnExit/,
  );
  assert.equal(spawned, false);
});

/** runHeadlessSession with a headless provider stub; `spawn(opts)` is the adapter. */
async function headless(spawn, extra = {}) {
  const { dir, cleanup } = mkTempBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const seen = [];
    const provider = new (class extends AgentProvider {
      supportsHeadless() {
        return true;
      }
      spawn(opts) {
        seen.push(opts);
        return spawn(opts);
      }
    })();
    const r = await runHeadlessSession({
      mode: 'workon',
      parsed: { id: 'F-3' },
      prompt: 'p',
      worktreePath: mkTempDir('bl-wt-'),
      roostDir: cfg.roostDir,
      backlogRoot: dir,
      config: cfg,
      provider,
      ...extra,
    });
    return { r, seen };
  } finally {
    cleanup();
  }
}

test('runHeadlessSession passes the schema and returns the outcome; a resume sends the note as it is', async () => {
  const outcome = { structured: { summary: 's', refined: true }, structuredError: null };
  const { r, seen } = await headless(() => ({ status: 0, output: '', ...outcome }), { schema: SCHEMA });
  assert.equal(seen[0].schema, SCHEMA);
  assert.equal(seen[0].sessionId, null);
  assert.match(seen[0].prompt, /## This session is headless/);
  assert.deepEqual({ structured: r.structured, structuredError: r.structuredError }, outcome);

  const resumed = await headless(() => ({ status: 0, output: '' }), {
    schema: SCHEMA,
    sessionId: 'abc',
    prompt: 'note',
  });
  assert.equal(resumed.seen[0].sessionId, 'abc');
  assert.equal(resumed.seen[0].prompt, 'note', 'the resumed session already has the headless rules');
});

test('runHeadlessSession: a session that did not run carries its reason as the fault', async () => {
  const { r } = await headless(() => ({ error: new Error('spawn claude ENOENT') }), { schema: SCHEMA });
  assert.equal(r.structured, null);
  assert.equal(r.structuredError, 'spawn claude ENOENT');
  const plain = await headless(() => ({ error: new Error('spawn claude ENOENT') }));
  assert.equal(plain.r.structuredError, null, 'no schema, no fault');
});
