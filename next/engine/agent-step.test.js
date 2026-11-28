// The agent step with one session (F-141 D5), on a fixture task flow beside the uTop flow set,
// run by F-139's runner with the real step catalogue and the replay dev dependency (Decision A3).
// It is here, not in steps/, because only engine/ may import the runner (the layer rule, F-135 D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { STEPS } from '../steps/index.js';
import { itemDir } from '../store/items.js';
import { createItems, engineBacklog } from '../test/helpers/engine-backlog.js';
import { withEnv } from '../test/helpers/env.js';
import { UTOP, UTOP_STEPS } from '../test/helpers/flow-fixture.js';
import { git, tempRepo } from '../test/helpers/git.js';
import { replayEnv } from '../test/helpers/replay.js';
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

/**
 * uTop's defined steps without the step gate `has_capacity()` of every agent box, which this
 * story does not bind: S-1643 binds it and drops this edit.
 */
const NO_CAPACITY_GATE = UTOP['defined-steps.yaml'].replace(/^ {2}agent: \[\{ condition: 'has_capacity\(\)'.*\n/m, '');

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
function script(match, result, before = []) {
  const path = join(mkTempDir('bl-agent-script-'), 'script.yaml');
  const turns = [...before, `result: ${result}`].map((turn) => `      - ${turn}`);
  writeFileSync(path, ['entries:', `  - match: '${match}'`, '    turns:', ...turns, ''].join('\n'));
  return path;
}

/**
 * A backlog with the task flow of `args`, `files` beside it, and one task; its context has a
 * `{{#bl}}` runner that gives `[<line>]`.
 * @param {string} [args]
 * @param {{ backlogYaml?: string, files?: Record<string, string> }} [options]
 */
async function task(args = HEADLESS, { backlogYaml = 'repos: {}\n', files = {} } = {}) {
  const flows = { 'task.yaml': taskFlow(args), 'defined-steps.yaml': NO_CAPACITY_GATE };
  const base = engineBacklog(flows, backlogYaml, CATALOGUE, {
    'config/prompts/work.md': PROMPT,
    'config/partials/tools.mustache': 'tools of {{item_id}}',
    ...files,
  });
  const ctx = { ...base, bl: async (/** @type {string} */ line) => `[${line}]` };
  const [id] = await createItems(ctx, [{ type: 'task', state: { status: 'draft', run: 'idle' } }]);
  return { ctx, id };
}

/** Run the task's `run` entry once with replay on `scriptPath`, and give its result or its crash. */
const run = (/** @type {any} */ ctx, /** @type {string} */ id, /** @type {string} */ scriptPath, extra = {}) =>
  withEnv(replayEnv(scriptPath), () =>
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
  // A profile whose args replace replay's --schema lets the result through, and bl's own check
  // of the box's schema refuses it.
  const open = join(mkTempDir('bl-agent-open-'), 'open.json');
  writeFileSync(open, JSON.stringify({ type: 'object' }));
  const loose = await task(undefined, {
    files: { 'config/agents.yaml': `replay: { adapter: replay, args: ['--schema', '${open}'] }\n` },
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
