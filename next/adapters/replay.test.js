/**
 * The `replay` adapter of `next/adapters/replay.js` (F-141 D4), against the
 * `replay` dev dependency (Decision A3), in a temporary git repo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { withEnv } from '../test/helpers/env.js';
import { git, initRepo } from '../test/helpers/git.js';
import { noReplayPath, replayEnv } from '../test/helpers/replay.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { ADAPTERS, adapterOf } from './index.js';
import { replay } from './replay.js';

const ZERO = { input: 0, output: 0, cache_creation: 0, cache_read: 0 };

const SCRIPT = `
entries:
  - match: 'implement (?<id>S-\\d+)'
    turns:
      - write: { path: a.txt, content: "a {{id}}\\n" }
      - run: [git, add, a.txt]
      - run: [git, commit, -q, -m, 'feat: a ({{id}})']
      - result: { outcome: success }
  - match: 'crash (?<id>S-\\d+)'
    turns:
      - write: { path: b.txt, content: "b\\n" }
      - exit: 3
      - write: { path: c.txt, content: "c\\n" }
      - result: { outcome: failure }
`;

const SCHEMA = {
  type: 'object',
  required: ['outcome'],
  properties: { outcome: { enum: ['success', 'failure'] } },
};

/** A script file with `text`, a git repo to work in, and an outcome schema. */
function setup(text = SCRIPT) {
  const dir = mkTempDir('bl-replay-');
  const script = join(dir, 'script.yaml');
  writeFileSync(script, text);
  const schemaPath = join(dir, 'outcome.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  const repo = mkTempDir('bl-replay-repo-');
  initRepo(repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return { dir, script, schemaPath, repo };
}

/** An AgentRun of `prompt` in `repo`; `ids` collects each id given to `onSession`. */
function agentRun({ dir, schemaPath, repo }, prompt, ids, extra = {}) {
  return {
    profile: { adapter: /** @type {const} */ ('replay') },
    prompt,
    mode: /** @type {const} */ ('headless'),
    schemaPath,
    resultPath: join(mkTempDir('bl-replay-result-', dir), 'result.json'),
    cwd: repo,
    session: null,
    unit: 'T-replay',
    onSession: async (id) => {
      ids.push({ id, before: existsSync(join(repo, 'a.txt')) || existsSync(join(repo, 'b.txt')) });
    },
    ...extra,
  };
}

test('ADAPTERS holds replay, and an adapter that is not built is a crash', () => {
  assert.equal(ADAPTERS.replay, replay);
  assert.ok(Object.isFrozen(ADAPTERS));
  assert.equal(adapterOf({ adapter: 'replay' }), replay);
  assert.throws(() => adapterOf({ adapter: 'claude' }), { message: 'the claude adapter is not built yet' });
});

test('faults gives one fault for a model, none without one', () => {
  assert.deepEqual(replay.faults({ adapter: 'replay' }), []);
  assert.deepEqual(replay.faults({ adapter: 'replay', model: 'gpt-x' }), [
    "the replay adapter takes no model, and this profile gives 'gpt-x'",
  ]);
});

test("capacity gives replay capacity's object for a valid script, and the script's capacity when it sets one", async () => {
  const { script } = setup();
  await withEnv(replayEnv(script), async () => {
    assert.deepEqual(await replay.capacity({ adapter: 'replay' }), { available: true, resets_at: null, message: null });
  });
  const limited = setup(`capacity: { available: false, resets_at: '2026-12-01T10:00:00Z' }\n${SCRIPT}`);
  await withEnv(replayEnv(limited.script), async () => {
    assert.deepEqual(await replay.capacity({ adapter: 'replay' }), {
      available: false,
      resets_at: '2026-12-01T10:00:00Z',
      message: null,
    });
  });
});

test("capacity runs with the profile's args: a --script there names the script", async () => {
  const { script } = setup();
  await withEnv({ ...replayEnv(script), REPLAY_SCRIPT: undefined }, async () => {
    assert.equal((await replay.capacity({ adapter: 'replay' })).available, false);
    const profile = { adapter: /** @type {const} */ ('replay'), args: ['--script', script] };
    assert.equal((await replay.capacity(profile)).available, true);
  });
});

test('with replay not on the PATH, capacity gives no capacity', async () => {
  const { script } = setup();
  await withEnv({ ...replayEnv(script), PATH: mkTempDir('bl-empty-path-') }, async () => {
    assert.deepEqual(await replay.capacity({ adapter: 'replay' }), {
      available: false,
      resets_at: null,
      message: 'replay is not on the PATH',
    });
  });
});

test('replay_capacity_rejects_malformed_record', async () => {
  // A fake replay on the PATH prints FAKE_OUT and exits FAKE_CODE.
  const bin = mkTempDir('bl-fake-replay-');
  writeFileSync(join(bin, 'replay'), '#!/bin/sh\nprintf "%s" "$FAKE_OUT"\nexit "$FAKE_CODE"\n', { mode: 0o755 });
  const capacityWith = (/** @type {string} */ out, code = '0') =>
    withEnv({ PATH: bin, FAKE_OUT: out, FAKE_CODE: code }, () => replay.capacity({ adapter: 'replay' }));
  const rows = [
    ['{"available":"yes","resets_at":null,"message":null}', /^replay capacity printed no capacity record: /],
    ['{"available":true}', /^replay capacity printed no capacity record: /],
    ['{"available":false,"resets_at":5,"message":null}', /^replay capacity printed no capacity record: /],
    ['{"available":false,"resets_at":null,"message":["quota"]}', /^replay capacity printed no capacity record: /],
    ['null', /^replay capacity printed no capacity record: null$/],
    ['[]', /^replay capacity printed no capacity record: \[\]$/],
    ['true', /^replay capacity printed no capacity record: true$/],
    ['"available"', /^replay capacity printed no capacity record: /],
    ['', /^replay capacity printed no JSON: /],
    ['not json', /^replay capacity printed no JSON: /],
  ];
  for (const [out, message] of rows) await assert.rejects(capacityWith(out), { message }, out);
  await assert.rejects(capacityWith('{}', '2'), { message: /^replay capacity failed: / }, 'a nonzero exit');
  // A well-formed record gives its three fields, and nothing else.
  assert.deepEqual(await capacityWith('{"available":false,"resets_at":null,"message":"quota","extra":1}'), {
    available: false,
    resets_at: null,
    message: 'quota',
  });
});

test('start runs a scripted headless session: onSession gets the id first, then the result and zero usage', async () => {
  const s = setup();
  await withEnv(replayEnv(s.script), async () => {
    const ids = [];
    const ended = await replay.start(agentRun(s, 'implement S-7', ids));
    assert.deepEqual(ended, { result: { outcome: 'success' }, error: null, usage: ZERO });
    assert.equal(ids.length, 1);
    assert.match(ids[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(ids[0].before, false, 'onSession runs before the session changes anything');
    assert.equal(readFileSync(join(s.repo, 'a.txt'), 'utf8'), 'a S-7\n');
    assert.equal(git(s.repo, 'log', '-1', '--format=%s'), 'feat: a (S-7)');
  });
});

test('failed_replay_launch_does_not_keep_a_resumable_session', async () => {
  const s = setup();
  const rows = [
    {
      name: 'replay not on the PATH',
      env: { ...replayEnv(s.script), PATH: mkTempDir('bl-empty-path-') },
      extra: {},
      error: 'replay could not start: replay is not on the PATH',
    },
    {
      name: 'a working directory that does not exist',
      env: replayEnv(s.script),
      extra: { cwd: join(s.repo, 'gone') },
      error: `replay could not start: the working directory ${join(s.repo, 'gone')} does not exist`,
    },
  ];
  for (const { name, env, extra, error } of rows) {
    const ids = [];
    const ended = await withEnv(env, () => replay.start(agentRun(s, 'implement S-7', ids, extra)));
    assert.deepEqual(ended, { result: null, error, usage: ZERO }, name);
    assert.deepEqual(ids, [], `${name}: no session id is given, so none is kept to resume`);
  }
  // A session that launched and then exited keeps its id: `resume` continues it (the test below).
  const ids = [];
  await withEnv(replayEnv(s.script), () => replay.start(agentRun(s, 'crash S-8', ids)));
  assert.equal(ids.length, 1);
});

test('replay_capacity_and_start_agree_on_path_entries', async () => {
  // A fake replay: `capacity` has capacity, and a session writes a success result.
  const FAKE =
    '#!/bin/sh\n' +
    'if [ "$1" = capacity ]; then printf \'{"available":true,"resets_at":null,"message":null}\'; exit 0; fi\n' +
    'while [ $# -gt 0 ]; do if [ "$1" = --result ]; then printf \'{"outcome":"success"}\' > "$2"; fi; shift; done\n';
  // bl runs in `root`, which holds `bin/replay` and `replay`, so a relative or an empty entry
  // would find one there; the session runs in `work`, which holds none.
  const root = mkTempDir('bl-replay-path-');
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(bin, 'replay'), FAKE, { mode: 0o755 });
  writeFileSync(join(root, 'replay'), FAKE, { mode: 0o755 });
  // The tools on the PATH (systemd-run for a process scope), and no replay.
  const tools = noReplayPath().PATH;
  const rows = [
    { entries: bin, launches: true },
    { entries: `${delimiter}${bin}`, launches: true },
    { entries: join(root, 'missing'), launches: false },
    { entries: 'bin', launches: false },
    { entries: '', launches: false },
    { entries: '.', launches: false },
    { entries: './bin', launches: false },
  ];
  const cwd = process.cwd();
  process.chdir(root);
  try {
    for (const { entries, launches } of rows) {
      const profile = { adapter: /** @type {const} */ ('replay'), env: { PATH: `${entries}${delimiter}${tools}` } };
      const run = {
        profile,
        prompt: 'p',
        mode: /** @type {const} */ ('headless'),
        schemaPath: join(root, 'schema.json'),
        resultPath: join(mkTempDir('bl-replay-result-', root), 'result.json'),
        cwd: work,
        session: null,
        unit: 'T-replay',
        onSession: async () => {},
      };
      const name = `PATH entries '${entries}'`;
      assert.equal((await replay.capacity(profile)).available, launches, `${name}: capacity`);
      const results = [await replay.start(run), await replay.resume({ ...run, session: 'kept' })];
      for (const [i, ended] of results.entries()) {
        const what = `${name}: ${i === 0 ? 'start' : 'resume'}`;
        if (launches) assert.deepEqual(ended, { result: { outcome: 'success' }, error: null, usage: ZERO }, what);
        else assert.equal(ended.error, 'replay could not start: replay is not on the PATH', what);
      }
    }
  } finally {
    process.chdir(cwd);
  }
});

test('resume after an exit turn gives the result of the rest of the session', async () => {
  const s = setup();
  await withEnv(replayEnv(s.script), async () => {
    const ids = [];
    const crashed = await replay.start(agentRun(s, 'crash S-8', ids));
    assert.deepEqual(crashed, { result: null, error: 'replay exited 3', usage: ZERO });
    assert.ok(existsSync(join(s.repo, 'b.txt')));
    assert.ok(!existsSync(join(s.repo, 'c.txt')));
    const resumed = await replay.resume(agentRun(s, 'crash S-8', [], { session: ids[0].id }));
    assert.deepEqual(resumed, { result: { outcome: 'failure' }, error: null, usage: ZERO });
    assert.ok(existsSync(join(s.repo, 'c.txt')), 'the turns after the exit ran');
  });
});

test("a session that fails gives the exit code and the last line of replay's stderr", async () => {
  const s = setup();
  await withEnv(replayEnv(s.script), async () => {
    const ended = await replay.start(agentRun(s, 'nothing matches this', []));
    assert.deepEqual(ended, {
      result: null,
      error: 'replay exited 1: replay: no entry matches the prompt: nothing matches this',
      usage: ZERO,
    });
  });
});

test("a session's profile env reaches replay: REPLAY_SCRIPT there names the script", async () => {
  const s = setup();
  await withEnv({ ...replayEnv(s.script), REPLAY_SCRIPT: undefined }, async () => {
    const profile = { adapter: /** @type {const} */ ('replay'), env: { REPLAY_SCRIPT: s.script } };
    const ended = await replay.start(agentRun(s, 'implement S-9', [], { profile }));
    assert.deepEqual(ended.result, { outcome: 'success' });
  });
});
