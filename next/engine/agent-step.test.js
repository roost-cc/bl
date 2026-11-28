// The agent step (F-141 D5, D7, D8, D9), on a fixture task flow beside the uTop flow set,
// run by F-139's runner with the real step catalogue and the replay dev dependency (Decision A3).
// It is here, not in steps/, because only engine/ may import the runner (the layer rule, F-135 D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { delimiter, join } from 'path';
import pty from 'node-pty';
import { ConfigurationFaults } from '../config/check.js';
import { STEPS } from '../steps/index.js';
import { itemDir } from '../store/items.js';
import { fixtureText } from '../test/helpers/config-fixture.js';
import { createItems, engineBacklog } from '../test/helpers/engine-backlog.js';
import { withEnv } from '../test/helpers/env.js';
import { UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { git, tempRepo } from '../test/helpers/git.js';
import { noReplayPath, REPLAY_BIN, replayEnv } from '../test/helpers/replay.js';
import { stderrOfAsync } from '../test/helpers/streams.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { runFlow } from './runner.js';
import { waitForWake } from './wake.js';

const CATALOGUE = { ...UTOP_STEPS, ...STEPS };

/**
 * A task flow whose `run` entry starts at the agent box `first`, with the `with:` text `args`; text
 * after the `with:` map in `args`, such as `after: […]`, adds keys to the box.
 */
const taskFlow = (/** @type {string} */ args) =>
  [
    'flows:',
    '  task:',
    '    initial: draft',
    '    statuses: { draft: {}, done: {}, superseded: {} }',
    '    entries:',
    '      run: { from: [draft], start: first }',
    '    steps:',
    `      first: { use: agent, with: ${args}, success: { status: done, next: stop }, failure: { status: superseded, next: stop } }`,
    '',
  ].join('\n');

const HEADLESS = '{ agents: [replay], prompt: { task: work.md }, schema: implement.json, mode: headless }';

/** The prompt of the task: a name of the record, a partial, a {{#bl}} line and a {{config.…}} name. */
const PROMPT =
  'Work {{item_id}} ({{title}}): {{> tools}} {{#bl}}show {{item_id}}{{/bl}} language {{config.language}}\n';

/**
 * A replay script whose one entry matches `match` and gives `result`, after the turns `before`.
 * @param {string} match
 * @param {string} result  the result as YAML flow text
 * @param {string[]} [before]
 */
const script = (match, result, before = []) => scriptOf([[match, [...before, `result: ${result}`]]]);

/**
 * A replay script with one entry per `[match, turns]` of `entries`, each turn as YAML flow text,
 * and the top-level `head` lines before them (for example a `capacity`).
 * @param {Array<[string, string[]]>} entries
 * @param {string[]} [head]
 */
function scriptOf(entries, head = []) {
  const path = join(mkTempDir('bl-agent-script-'), 'script.yaml');
  const lines = entries.flatMap(([match, turns]) => [
    `  - match: '${match}'`,
    '    turns:',
    ...turns.map((turn) => `      - ${turn}`),
  ]);
  writeFileSync(path, [...head, 'entries:', ...lines, ''].join('\n'));
  return path;
}

/**
 * A backlog with the task flow of `args`, `files` beside it, and one task; its context has a
 * `{{#bl}}` runner that gives `[<line>]`.
 * @param {string} [args]
 * @param {{ backlogYaml?: string, files?: Record<string, string>, flows?: Record<string, string> }} [options]
 */
async function task(args = HEADLESS, { backlogYaml = 'repos: {}\n', files = {}, flows: more = {} } = {}) {
  const flows = { 'task.yaml': taskFlow(args), ...more };
  const base = engineBacklog(flows, backlogYaml, CATALOGUE, {
    'config/prompts/work.md': PROMPT,
    'config/partials/tools.mustache': 'tools of {{item_id}}',
    ...files,
  });
  const ctx = { ...base, bl: async (/** @type {string} */ line) => `[${line}]` };
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle' } }]);
  return { ctx, id };
}

/**
 * Run the task's `run` entry once with replay on `scriptPath`, the variables `env` over replay's,
 * and give its result or its crash.
 */
const run = (
  /** @type {any} */ ctx,
  /** @type {string} */ id,
  /** @type {string} */ scriptPath,
  extra = {},
  env = {},
) =>
  withEnv({ ...replayEnv(scriptPath), ...env }, () =>
    runFlow(ctx, { id, start: 'first', by: 'operator', entry: 'run', catalogue: CATALOGUE, ...extra }).catch((e) => e),
  );

/** The task's usage.jsonl entries in HEAD, or `[]` when HEAD holds none. */
function usageAtHead(/** @type {any} */ ctx, /** @type {string} */ id) {
  const path = `${itemDir(ctx, id).path}/usage.jsonl`;
  if (!git(ctx.backlogDir, 'ls-tree', '--name-only', 'HEAD', path)) return [];
  return git(ctx.backlogDir, 'show', `HEAD:${path}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('a headless agent box on replay gets the rendered prompt and takes the scripted outcome', async () => {
  // replay matches the whole rendered prompt, so a name that was not filled matches no entry.
  const rendered = '^Work T-1 \\(task 1\\): tools of T-1 \\[show T-1\\] language en\\n';
  for (const [outcome, status] of [
    ['success', 'done'],
    ['failure', 'superseded'],
  ]) {
    const { ctx, id } = await task();
    const result = await run(ctx, id, script(rendered, `{ outcome: ${outcome}, summary: done }`));
    assert.deepEqual(result, { ended: 'stop', status, outcome }, outcome);
  }
});

test("the box's commit holds one usage entry: the box path, the profile name and zero tokens", async () => {
  const { ctx, id } = await task();
  await run(ctx, id, script('Work', '{ outcome: success, summary: done }'));
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s'), `${id}: first success`);
  const [entry, ...rest] = usageAtHead(ctx, id);
  assert.deepEqual(rest, []);
  assert.match(entry.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(
    { ...entry, at: undefined },
    { at: undefined, step: 'first', agent: 'replay', input: 0, output: 0, cache_creation: 0, cache_read: 0 },
  );
  // runSession removes its directory under .bl/tmp/.
  assert.deepEqual(
    readdirSync(join(ctx.backlogDir, '.bl', 'tmp')).filter((name) => name.startsWith('agent-')),
    [],
  );
});

test("a result that fails the box's schema is a crash whose message holds ajv's error path", async () => {
  // replay checks the result against the schema bl gives it, and writes none that fails.
  const refused = await task();
  const crash = await run(refused.ctx, refused.id, script('Work', '{ outcome: success, summary: 5 }'));
  assert.equal(crash.name, 'FlowCrash');
  assert.match(crash.message, /^first: no entry of agents gave a valid result: replay: replay exited 1: .*\/summary/);
  assert.deepEqual(usageAtHead(refused.ctx, refused.id), [], 'a crash commits no usage entry');
  // A profile whose PATH starts replay through a shim that gives it an open schema lets the
  // result through, and bl's own check of the box's schema refuses it.
  const dir = mkTempDir('bl-agent-open-');
  const open = join(dir, 'open.json');
  writeFileSync(open, JSON.stringify({ type: 'object' }));
  const shim = [
    '#!/bin/sh',
    'prev=',
    'for a in "$@"; do',
    '  shift',
    `  [ "$prev" = --schema ] && a='${open}'`,
    '  set -- "$@" "$a"',
    '  prev=$a',
    'done',
    `exec '${join(REPLAY_BIN, 'replay')}' "$@"`,
    '',
  ];
  writeFileSync(join(dir, 'replay'), shim.join('\n'), { mode: 0o755 });
  const loose = await task(undefined, {
    files: {
      'config/agents.yaml': `replay: { adapter: replay, env: { PATH: '${dir}${delimiter}${process.env.PATH}' } }\n`,
    },
  });
  const checked = await run(loose.ctx, loose.id, script('Work', '{ outcome: success, summary: 5 }'));
  assert.equal(checked.name, 'FlowCrash');
  assert.equal(
    checked.message,
    'first: no entry of agents gave a valid result: replay: the result fails implement.json: /summary: must be string',
  );
});

test("an item type that the box's prompt map does not name is a crash that names the type", async () => {
  const { ctx, id } = await task(
    '{ agents: [replay], prompt: { story: work.md }, schema: implement.json, mode: headless }',
  );
  const crash = await run(ctx, id, script('Work', '{ outcome: success, summary: done }'));
  assert.equal(crash.name, 'FlowCrash');
  assert.equal(crash.message, 'first: the prompt map of first names no file for the item type task');
  const schema = await task('{ agents: [replay], prompt: work.md, schema: { story: implement.json }, mode: headless }');
  const schemaCrash = await run(schema.ctx, schema.id, script('Work', '{ outcome: success, summary: done }'));
  assert.equal(schemaCrash.message, 'first: the schema map of first names no file for the item type task');
});

test('choices given in the box reach the prompt', async () => {
  const { ctx, id } = await task(
    '{ agents: [replay], prompt: work.md, schema: implement.json, mode: headless, choices: [fix, defer] }',
    { files: { 'config/prompts/work.md': 'Choose {{#choices}}<{{.}}>{{/choices}}\n' } },
  );
  const result = await run(ctx, id, script('^Choose <fix><defer>\\n', '{ outcome: success, summary: done }'));
  assert.equal(result.outcome, 'success');
});

/**
 * Two repo contexts whose `bl.pre-agent` appends `pre <repo> <working directory>` to `log`, and
 * fails in a worktree that holds a file `fail`; a replay session appends `session <working
 * directory>` to the same log.
 */
async function preAgentTask() {
  const log = join(mkTempDir('bl-agent-log-'), 'log');
  const command = `echo pre {{repo}} "$PWD" >> ${log}; test ! -e fail || { echo "no tools in {{repo}}" >&2; exit 1; }`;
  const backlogYaml = `repos: { a: {}, b: {} }\nplugin_registry: { stages: { bl.pre-agent: '${command}' } }\n`;
  const { ctx, id } = await task(undefined, { backlogYaml });
  const repos = [tempRepo('a'), tempRepo('b')];
  const scriptPath = script('Work', '{ outcome: success, summary: done }', [
    `run: [sh, -c, 'echo session "$PWD" >> ${log}']`,
  ]);
  return { ctx, id, repos, log, scriptPath, repoContexts: () => repos };
}

test("with a test's repo contexts, bl.pre-agent runs once in each worktree before the session", async () => {
  const { ctx, id, repos, log, scriptPath, repoContexts } = await preAgentTask();
  const result = await run(ctx, id, scriptPath, { repoContexts });
  assert.equal(result.outcome, 'success');
  const [a, b] = repos.map((repo) => repo.worktree_path);
  // The session runs in the first repo's worktree.
  assert.deepEqual(readFileSync(log, 'utf8').split('\n'), [`pre a ${a}`, `pre b ${b}`, `session ${a}`, '']);
});

test('a failing bl.pre-agent is a crash that names the repo, and no session starts', async () => {
  const { ctx, id, repos, log, scriptPath, repoContexts } = await preAgentTask();
  writeFileSync(join(repos[1].worktree_path, 'fail'), '');
  const crash = await run(ctx, id, scriptPath, { repoContexts });
  assert.equal(crash.name, 'FlowCrash');
  assert.equal(crash.message, 'first: bl.pre-agent failed in b: no tools in b');
  assert.ok(!readFileSync(log, 'utf8').includes('session'));
});

test("worktree_clean() and worktree_unchanged() as post-conditions of an agent box read the test's repo contexts", async () => {
  const backlogYaml = "repos: { a: {} }\nplugin_registry: { stages: { bl.pre-agent: 'true' } }\n";
  const add = "run: [sh, -c, 'echo x > new']";
  const commit = 'run: [git, commit, -q, --allow-empty, -m, wip]';
  for (const [after, turns, outcome] of [
    ['worktree_clean()', [add], 'failure'],
    ['worktree_clean()', [commit], 'success'],
    ['worktree_unchanged()', [commit], 'failure'],
    ['worktree_unchanged()', [], 'success'],
  ]) {
    const { ctx, id } = await task(`${HEADLESS}, after: ['${after}']`, { backlogYaml });
    const repos = [tempRepo('a')];
    const scriptPath = script('Work', '{ outcome: success, summary: done }', /** @type {string[]} */ (turns));
    const result = await run(ctx, id, scriptPath, { repoContexts: () => repos });
    const status = outcome === 'success' ? 'done' : 'superseded';
    assert.deepEqual(result, { ended: 'stop', status, outcome }, `${after} after ${turns.join(', ') || 'no change'}`);
  }
});

// ---- capacity, has_capacity() and the next entry (F-141 D7, D-120) ----

/**
 * The uTop profiles, and `replay-b` and `replay-c`: replay profiles whose `env` puts
 * `node_modules/.bin` on their `PATH`, so they run when the test's `PATH` has no replay.
 */
const PROFILES = {
  'config/agents.yaml': [
    fixtureText('agents.yaml'),
    ...['replay-b', 'replay-c'].map(
      (name) => `${name}: { adapter: replay, env: { PATH: '${REPLAY_BIN}${delimiter}${process.env.PATH}' } }`,
    ),
    '',
  ].join('\n'),
};

/** The test's `PATH` without replay (D-479). */
const NO_REPLAY = noReplayPath();

/** A task whose first box runs the agents `list` headless, with `PROFILES`. */
const listTask = (/** @type {string} */ list, options = {}) =>
  task(`{ agents: [${list}], prompt: work.md, schema: implement.json, mode: headless }`, {
    files: PROFILES,
    ...options,
  });

/** The profile of each usage entry in HEAD. */
const agentsAtHead = (/** @type {any} */ ctx, /** @type {string} */ id) =>
  usageAtHead(ctx, id).map((entry) => `${entry.step}: ${entry.agent}`);

const SUCCESS = 'result: { outcome: success, summary: done }';

/** A turn that appends `<text>` to the file `log`, so a test sees which sessions ran. */
const logTurn = (/** @type {string} */ log, /** @type {string} */ text) => `run: [sh, -c, 'echo ${text} >> ${log}']`;

test('without replay on the PATH, has_capacity() is false for [replay], and a box with [replay, replay-b] runs replay-b', async () => {
  const alone = await listTask('replay');
  const gated = await run(alone.ctx, alone.id, script('Work', '{ outcome: success, summary: done }'), {}, NO_REPLAY);
  assert.deepEqual(gated, { ended: 'gated before: first', status: 'draft' });

  const { ctx, id } = await listTask('replay, replay-b');
  const result = await run(ctx, id, script('Work', '{ outcome: success, summary: done }'), {}, NO_REPLAY);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(agentsAtHead(ctx, id), ['first: replay-b']);
});

test("a step gate has_capacity() over a script whose capacity is available: false ends at 'gated before: <box>'", async () => {
  const { ctx, id } = await listTask('replay, replay-b');
  const none = scriptOf([['Work', [SUCCESS]]], ['capacity: { available: false, message: busy }']);
  assert.deepEqual(await run(ctx, id, none), { ended: 'gated before: first', status: 'draft' });
  assert.equal(git(ctx.backlogDir, 'log', '-1', '--format=%s'), `${id}: first gated before`);
  assert.deepEqual(usageAtHead(ctx, id), [], 'no session ran');
});

test("a process suspended at a failing has_capacity() step gate wakes at the box's earliest capacity reset (F-152 D3)", async () => {
  const { ctx, id } = await listTask('replay, replay-b');
  const resets = new Date(Date.now() + 400).toISOString();
  const none = scriptOf([['Work', [SUCCESS]]], [`capacity: { available: false, resets_at: '${resets}' }`]);
  /** @type {any[]} */
  const wakes = [];
  const wake = async (/** @type {any} */ c, /** @type {any} */ suspend) => {
    wakes.push({ agents: suspend.agents, source: await waitForWake(c, suspend) });
    throw new Error('one wake is enough');
  };
  const { value, chunks } = await stderrOfAsync(async () => run(ctx, id, none, { wake }));
  assert.equal(/** @type {Error} */ (value).message, 'one wake is enough');
  assert.deepEqual(wakes, [{ agents: ['replay', 'replay-b'], source: 'capacity' }]);
  assert.deepEqual(chunks, [`${id}: suspended at gated before: first: has_capacity()\n`]);
});

test('a session with no result and an unchanged worktree makes the step run the next entry, whose outcome the box takes', async () => {
  const { ctx, id } = await listTask('replay, replay-b');
  const result = await run(
    ctx,
    id,
    scriptOf([
      ['Work', ['exit: 3']],
      ['Work', [SUCCESS]],
    ]),
  );
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(agentsAtHead(ctx, id), ['first: replay', 'first: replay-b'], 'one usage entry per session');
});

test('a session with no result that commits in a repo context is a crash that names the profile and its error', async () => {
  const log = join(mkTempDir('bl-agent-log-'), 'log');
  const backlogYaml = "repos: { a: {} }\nplugin_registry: { stages: { bl.pre-agent: 'true' } }\n";
  const { ctx, id } = await listTask('replay, replay-b', { backlogYaml });
  const repos = [tempRepo('a')];
  const wip = 'run: [git, commit, -q, --allow-empty, -m, wip]';
  const scriptPath = scriptOf([
    ['Work', [wip, 'exit: 3']],
    ['Work', [logTurn(log, 'second'), SUCCESS]],
  ]);
  const crash = await run(ctx, id, scriptPath, { repoContexts: () => repos });
  assert.equal(crash.name, 'FlowCrash');
  assert.equal(crash.message, 'first: the worktree changed after replay gave no valid result: replay: replay exited 3');
  assert.ok(!existsSync(log), 'no second session ran');
});

test('with no entry left, the crash names each profile tried and its error, the entries with no capacity too', async () => {
  const { ctx, id } = await listTask('replay, replay-b, replay-c');
  const crash = await run(
    ctx,
    id,
    scriptOf([
      ['Work', ['exit: 3']],
      ['Work', ['exit: 4']],
    ]),
    {},
    NO_REPLAY,
  );
  assert.equal(crash.name, 'FlowCrash');
  assert.equal(
    crash.message,
    'first: no entry of agents gave a valid result: replay: no capacity: replay is not on the PATH; ' +
      'replay-b: replay exited 3; replay-c: replay exited 4',
  );
});

test('a failure result never runs the next entry', async () => {
  const log = join(mkTempDir('bl-agent-log-'), 'log');
  const { ctx, id } = await listTask('replay, replay-b');
  const scriptPath = scriptOf([
    ['Work', ['result: { outcome: failure, summary: blocked }']],
    ['Work', [logTurn(log, 'second'), SUCCESS]],
  ]);
  assert.deepEqual(await run(ctx, id, scriptPath), { ended: 'stop', status: 'superseded', outcome: 'failure' });
  assert.deepEqual(agentsAtHead(ctx, id), ['first: replay']);
  assert.ok(!existsSync(log), 'no second session ran');
});

test('override_rejects_adapter_profile_faults_before_flow_commit', async () => {
  const agentsYaml = `${PROFILES['config/agents.yaml']}replay-x: { adapter: replay, model: x }\n`;
  const { ctx, id } = await listTask('replay', { files: { 'config/agents.yaml': agentsYaml } });
  const head = git(ctx.backlogDir, 'rev-parse', 'HEAD');
  const scriptPath = script('Work', '{ outcome: success, summary: done }');
  const at = 'config/agents.yaml';
  /** Each row: the override's profiles, and the message of the configuration error. */
  const rows = [
    [['nobody'], `${at}: /nobody: agents: the agents override: the profile 'nobody' is not in config/agents.yaml`],
    [
      ['replay', 'replay-x'],
      `${at}: /replay-x: agents: the agents override: the profile 'replay-x': the replay adapter takes no model, and this profile gives 'x'`,
    ],
    [[], `${at}: : agents: the agents override: it names no profile`],
    [undefined, `${at}: : agents: the agents override: it names no profile`],
    ['replay', `${at}: : agents: the agents override: it names no profile`],
  ];
  for (const [profiles, message] of rows) {
    const error = await run(ctx, id, scriptPath, { agents: { profiles } });
    assert.ok(error instanceof ConfigurationFaults, JSON.stringify(profiles));
    assert.equal(error.message, message);
  }
  assert.equal(git(ctx.backlogDir, 'rev-parse', 'HEAD'), head, 'no commit');
  // A profile that the box check takes runs.
  assert.equal((await run(ctx, id, scriptPath, { agents: { profiles: ['replay'] } })).outcome, 'success');
});

/**
 * uTop's defined steps with no step gate and no post-conditions on `implement`, whose `Escalation`
 * and `Acceptance Criteria` sections a task does not have.
 */
function plainImplement() {
  const gate = `  implement: [{ condition: 'sections["Escalation"] == "None."', class: needs_operator_action }]\n`;
  const after = `    after: ['checkboxes["Acceptance Criteria"].all(c, c.checked)', 'worktree_clean()']\n`;
  const text = UTOP['defined-steps.yaml'];
  assert.ok(text.includes(gate) && text.includes(after), 'the uTop text the test edits');
  return text.replace(gate, '').replace(after, '');
}

/** A task flow whose `run` entry runs uTop's defined step `implement`, then the inline agent box `second`. */
const IMPLEMENT_THEN_SECOND = [
  'flows:',
  '  task:',
  '    initial: draft',
  '    statuses: { draft: {}, done: {}, superseded: {} }',
  '    entries:',
  '      run: { from: [draft], start: implement }',
  '    steps:',
  '      implement: { success: { next: second }, failure: stop }',
  `      second: { use: agent, with: ${HEADLESS}, success: { status: done, next: stop }, failure: stop }`,
  '',
].join('\n');

test("runFlow's agents override replaces the list of the boxes of the defined steps it names, or of every agent box", async () => {
  const flows = { 'task.yaml': IMPLEMENT_THEN_SECOND, 'defined-steps.yaml': plainImplement() };
  const both = () =>
    scriptOf([
      ['^Implement', [SUCCESS]],
      ['^Work', [SUCCESS]],
    ]);
  for (const [agents, want] of [
    [{ profiles: ['replay-b'], steps: ['implement'] }, ['implement: replay-b', 'second: replay']],
    [{ profiles: ['replay-b'] }, ['implement: replay-b', 'second: replay-b']],
  ]) {
    const { ctx, id } = await task(undefined, { files: PROFILES, flows });
    const result = await run(ctx, id, both(), { start: 'implement', agents });
    assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' }, JSON.stringify(agents));
    // Each box has its own commit; usage.jsonl at HEAD holds both entries.
    assert.deepEqual(agentsAtHead(ctx, id), want, JSON.stringify(agents));
  }
});

// ---- sessions and resume (F-141 D8, D-417) ----

/** The task's state.json at the commit `rev`. */
const stateAt = (/** @type {any} */ ctx, /** @type {string} */ id, rev = 'HEAD') =>
  JSON.parse(git(ctx.backlogDir, 'show', `${rev}:${itemDir(ctx, id).path}/state.json`));

/** The subject of the commit `rev`. */
const subjectAt = (/** @type {any} */ ctx, rev = 'HEAD') => git(ctx.backlogDir, 'log', '-1', '--format=%s', rev);

/** `run` of a resumed invocation: no entry and no start; the interrupted box `first` is where it goes on. */
const RESUME = { resume: true, entry: undefined, start: undefined };

/**
 * Run the task once with `scriptPath`, whose first session ends at an `exit:` turn, so that the box
 * crashes with no entry left; give the replay state that a later run must use too, and the session
 * that state.json then holds.
 */
async function crashInSession(/** @type {any} */ ctx, /** @type {string} */ id, /** @type {string} */ scriptPath) {
  const env = replayEnv(scriptPath);
  const crash = await run(ctx, id, scriptPath, {}, env);
  assert.equal(crash.name, 'FlowCrash');
  assert.match(crash.message, /^first: no entry of agents gave a valid result: .*replay exited 3/);
  const { session } = stateAt(ctx, id);
  return { env, session };
}

test('a session that ends at an exit: turn leaves its box, profile and id in state.json, in a commit of its own', async () => {
  const { ctx, id } = await listTask('replay');
  const { session } = await crashInSession(ctx, id, scriptOf([['Work', ['exit: 3', SUCCESS]]]));
  assert.deepEqual(stateAt(ctx, id), { status: 'draft', run: 'active: first', host: hostname(), session });
  assert.deepEqual({ ...session, id: '' }, { box: 'first', profile: 'replay', id: '' });
  assert.match(session.id, /^[0-9a-f-]{36}$/);
  assert.equal(subjectAt(ctx), `${id}: first session ${session.id}`);
  assert.deepEqual(git(ctx.backlogDir, 'log', '-1', '--format=%(trailers:only,unfold)').trim().split('\n'), [
    'Bl-Flow: task',
    'Bl-Step: first',
    `Bl-Item: ${id}`,
  ]);
});

test('a resumed invocation at the box keeps the session in its flow_start commit and continues it after the exit: turn', async () => {
  const log = join(mkTempDir('bl-agent-log-'), 'log');
  const { ctx, id } = await listTask('replay');
  const scriptPath = scriptOf([['Work', [logTurn(log, 'before'), 'exit: 3', logTurn(log, 'after'), SUCCESS]]]);
  const { env, session } = await crashInSession(ctx, id, scriptPath);
  const result = await run(ctx, id, scriptPath, RESUME, env);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.equal(subjectAt(ctx, 'HEAD~1'), `${id}: resumed at first`);
  assert.deepEqual(stateAt(ctx, id, 'HEAD~1'), { status: 'draft', run: 'active: first', host: hostname(), session });
  // The turn before the exit: ran once, in the first invocation.
  assert.deepEqual(readFileSync(log, 'utf8').split('\n'), ['before', 'after', '']);
  // The box's commit holds no session.
  assert.deepEqual(stateAt(ctx, id), { status: 'done', run: 'idle' });
  assert.deepEqual(agentsAtHead(ctx, id), ['first: replay']);
});

test('a session id dropped with ctx.session({ id: null }) is not in state.json after a crash, nor in a resumed flow_start', async () => {
  // An agent step whose adapter gave an id and then dropped it, as replay does for a failed launch.
  const ghost = {
    ...STEPS.agent,
    run: async (/** @type {any} */ ctx) => {
      await ctx.session({ profile: 'replay', id: 'ghost' });
      await ctx.session({ profile: 'replay', id: null });
      throw new Error('the launch failed');
    },
  };
  const { ctx, id } = await listTask('replay');
  const crash = await run(ctx, id, scriptOf([['Work', [SUCCESS]]]), { catalogue: { ...CATALOGUE, agent: ghost } });
  assert.equal(crash.name, 'FlowCrash');
  assert.equal(stateAt(ctx, id, 'HEAD~1').session.id, 'ghost');
  assert.equal(subjectAt(ctx), `${id}: first session of replay did not launch`);
  assert.deepEqual(stateAt(ctx, id), { status: 'draft', run: 'active: first', host: hostname() });
  const result = await run(ctx, id, scriptOf([['Work', [SUCCESS]]]), RESUME);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  // HEAD~1 is the new session's commit, HEAD~2 the resumed flow_start.
  assert.equal(subjectAt(ctx, 'HEAD~2'), `${id}: resumed at first`);
  assert.equal(stateAt(ctx, id, 'HEAD~2').session, undefined, 'the resumed flow_start keeps no session');
});

test('a kept session whose profile is no longer in the list is not resumed: the step starts a new session', async () => {
  const log = join(mkTempDir('bl-agent-log-'), 'log');
  const { ctx, id } = await listTask('replay');
  const scriptPath = scriptOf([
    ['Work', ['exit: 3', logTurn(log, 'resumed'), SUCCESS]],
    ['Work', [logTurn(log, 'new'), SUCCESS]],
  ]);
  const { env } = await crashInSession(ctx, id, scriptPath);
  const result = await run(ctx, id, scriptPath, { ...RESUME, agents: { profiles: ['replay-b'] } }, env);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(readFileSync(log, 'utf8').split('\n'), ['new', '']);
  assert.equal(stateAt(ctx, id, 'HEAD~1').session.profile, 'replay-b');
  assert.deepEqual(stateAt(ctx, id), { status: 'done', run: 'idle' });
  assert.deepEqual(agentsAtHead(ctx, id), ['first: replay-b']);
});

test('a resumed session with no valid result moves on to the other entries, the resumed profile skipped', async () => {
  const { ctx, id } = await listTask('replay, replay-b');
  const scriptPath = scriptOf([
    ['Work', ['exit: 3']],
    ['Work', ['exit: 3', 'exit: 4']],
    ['Work', [SUCCESS]],
  ]);
  // replay and then replay-b end at an exit: turn; state.json keeps replay-b's session.
  const { env, session } = await crashInSession(ctx, id, scriptPath);
  assert.equal(session.profile, 'replay-b');
  const result = await run(ctx, id, scriptPath, RESUME, env);
  assert.deepEqual(result, { ended: 'stop', status: 'done', outcome: 'success' });
  assert.deepEqual(agentsAtHead(ctx, id), ['first: replay-b', 'first: replay']);
});

// ---- an interactive step with no terminal (F-141 D9, D-29) ----

const INTERACTIVE = '{ agents: [replay], prompt: work.md, schema: implement.json, mode: interactive }';

test('an interactive agent box with no terminal ends the invocation idle with that box next, and prints how to resume', async () => {
  const { ctx, id } = await task(INTERACTIVE);
  const { value: result, chunks } = await stderrOfAsync(() =>
    run(ctx, id, script('Work', '{ outcome: success, summary: done }'), { tty: '/nonexistent/tty' }),
  );
  assert.deepEqual(result, { ended: 'stop', status: 'draft' });
  assert.deepEqual(stateAt(ctx, id), { status: 'draft', run: 'idle', next: 'first' });
  assert.equal(subjectAt(ctx), `${id}: first no terminal`);
  const log = git(ctx.backlogDir, 'show', `HEAD:${itemDir(ctx, id).path}/log.jsonl`)
    .split('\n')
    .filter(Boolean);
  const { at, ...end } = JSON.parse(/** @type {string} */ (log.at(-1)));
  assert.match(at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(end, {
    event: 'flow_end',
    ended: 'stop',
    status: 'draft',
    commits: [],
    note: 'no terminal for the interactive step first',
  });
  assert.deepEqual(chunks, [
    'first: no terminal for the interactive step first\n',
    `run \`bl resume ${id}\` to continue\n`,
  ]);
  assert.deepEqual(usageAtHead(ctx, id), [], 'no session ran');
});

// ---- an interactive session under a pseudo-terminal (F-141 D4, F-147 D7) ----

const FLOW_CHILD = join(import.meta.dirname, '..', 'test', 'helpers', 'flow-child.js');

test('under a pseudo-terminal, an interactive agent box on replay answers a scripted ask and takes the chosen branch', async () => {
  const { ctx, id } = await task(INTERACTIVE);
  const ask = [
    "ask: { question: 'Ship {{id}}?', choices: { yes: [{ result: { outcome: success, summary: shipped } }],",
    'no: [{ result: { outcome: failure, summary: held } }] } }',
  ].join(' ');
  const scriptPath = scriptOf([['Work (?<id>T-\\d+)', ["say: 'Looking at {{id}}.'", ask]]]);
  const resultFile = join(mkTempDir('bl-agent-pty-'), 'result.json');
  const term = pty.spawn(process.execPath, [FLOW_CHILD, ctx.backlogDir, id, 'first', resultFile], {
    env: { ...process.env, ...replayEnv(scriptPath) },
    cols: 200,
  });
  let output = '';
  /** @type {() => void} */
  let check = () => {};
  term.onData((data) => {
    output += data;
    check();
  });
  const exited = new Promise((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)));
  await new Promise((resolve) => {
    check = () => output.includes('Ship T-1? [yes/no]') && resolve(undefined);
    check();
  });
  assert.match(output, /Looking at T-1\./);
  term.write('no\r');
  assert.equal(await exited, 0, output);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
    ended: 'stop',
    status: 'superseded',
    outcome: 'failure',
  });
  assert.deepEqual(agentsAtHead(ctx, id), ['first: replay']);
});
