// The agent step with one session (F-141 D5), on a fixture task flow beside the uTop flow set,
// run by F-139's runner with the real step catalogue and the replay dev dependency (Decision A3).
// It is here, not in steps/, because only engine/ may import the runner (the layer rule, F-135 D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { ConfigurationFaults } from '../config/check.js';
import { STEPS } from '../steps/index.js';
import { itemDir } from '../store/items.js';
import { fixtureText } from '../test/helpers/config-fixture.js';
import { createItems, engineBacklog } from '../test/helpers/engine-backlog.js';
import { withEnv } from '../test/helpers/env.js';
import { UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { git, tempRepo } from '../test/helpers/git.js';
import { noReplayPath, REPLAY_BIN, replayEnv } from '../test/helpers/replay.js';
import { mkTempDir } from '../test/helpers/tempdir.js';
import { runFlow } from './runner.js';

const CATALOGUE = { ...UTOP_STEPS, ...STEPS };

/** A task flow whose `run` entry starts at the agent box `first`, with the `with:` text `args`. */
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

test("runFlow's agents override: an unknown profile is a configuration error before the first commit", async () => {
  const { ctx, id } = await listTask('replay');
  const head = git(ctx.backlogDir, 'rev-parse', 'HEAD');
  const scriptPath = script('Work', '{ outcome: success, summary: done }');
  const error = await run(ctx, id, scriptPath, { agents: { profiles: ['nobody'] } });
  assert.ok(error instanceof ConfigurationFaults);
  assert.equal(
    error.message,
    "config/agents.yaml: /nobody: agents: the agents override names the profile 'nobody', which config/agents.yaml does not define",
  );
  assert.equal(git(ctx.backlogDir, 'rev-parse', 'HEAD'), head, 'no commit');
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
