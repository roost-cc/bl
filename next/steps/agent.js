/**
 * agent.js — the `agent` step, `runSession` and the start check of agent
 * boxes (F-141 D5; agents.md, "The agent step", "What a prompt sees").
 *
 * - The step picks the prompt and the schema file for the item's type
 *   (D-73), renders the prompt over the record with `{{#bl}}`, the partials
 *   and the configuration as `config` (D-494), runs `bl.pre-agent` once for
 *   the item's repos, and runs one session with the first entry of `agents`.
 *   It stages one usage entry for the session, so the entry goes into the
 *   box's commit (history.md, "Usage log").
 * - `runSession` runs one session through the profile's adapter, in a fresh
 *   directory under `<backlog>/.bl/tmp/` that it removes afterwards, and
 *   checks the result with the box's outcome schema. F-152's session at a
 *   `wait` box calls it too (Decision A2).
 * - `checkAgentBoxes` finds, at start, each name in an `agent` box that the
 *   configuration does not have.
 *
 * In this story a session with no valid result is a crash. S-1643 adds the
 * next entry by capacity (D-120), and S-1644 records the session id and
 * resumes a kept session (D8).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ADAPTERS, adapterOf } from '../adapters/index.js';
import { renderAsync } from '../config/template.js';
import { STAGING_DIR } from '../lib/staging.js';
import { now } from '../store/write.js';
import { runStage } from './stage.js';

/** @typedef {import('./index.js').Step} Step */
/** @typedef {import('./index.js').StepContext} StepContext */
/** @typedef {import('../adapters/index.js').Profile} Profile */
/** @typedef {import('../adapters/index.js').Usage} Usage */
/** @typedef {import('../config/files.js').Fault} Fault */
/** @typedef {import('../config/load.js').Configuration} Configuration */

/** The name of the step, and of the configuration kind of its profiles. */
const AGENT = 'agent';
const AGENTS = 'agents';

/** A file name, or a map from an item type to a file name (D-73). */
const FILE = {
  anyOf: [
    { type: 'string', minLength: 1 },
    { type: 'object', minProperties: 1, additionalProperties: { type: 'string', minLength: 1 } },
  ],
};

/**
 * @typedef {object} AgentArgs  the `with:` of an `agent` box
 * @property {string[]} agents  profile names, in priority order
 * @property {string|Record<string, string>} prompt  a file of `config/prompts/`, or one per item type
 * @property {string|Record<string, string>} schema  a file of `config/schemas/`, or one per item type
 * @property {'headless'|'interactive'} mode
 * @property {string[]} [choices]  the choices the agent may give; the prompt sees them
 */

/**
 * The file that `value` names for the item type `type`.
 * @param {string|Record<string, string>} value
 * @param {string} type
 * @param {'prompt'|'schema'} what
 * @param {string} box
 * @throws {Error} when a map does not name the type (D-73)
 */
function fileFor(value, type, what, box) {
  if (typeof value === 'string') return value;
  if (!Object.hasOwn(value, type)) {
    throw new Error(`the ${what} map of ${box} names no file for the item type ${type}`);
  }
  return value[type];
}

/** The profile `name` of `config/agents.yaml`, or `undefined`. */
const profileOf = (/** @type {Configuration} */ config, /** @type {string} */ name) =>
  /** @type {Record<string, Profile>} */ (config.file(AGENTS) ?? {})[name];

/**
 * Run one agent session and check its result (F-141 D5): `start` a new
 * session, or `resume` the session `session` when it is given. The prompt
 * and the schema go into a fresh directory under `<backlog>/.bl/tmp/`, with
 * the result path, and the directory is removed afterwards. The session
 * runs in the first repo's worktree, or in the backlog root when the item
 * has no repo context (Decision A1).
 * @param {StepContext} ctx
 * @param {{ profile: string, prompt: string, schema: string, mode: 'headless'|'interactive', session?: string|null }} run
 *   `profile` names a profile of `config/agents.yaml`; `prompt` is the rendered text; `schema` names a file of
 *   `config/schemas/`
 * @returns {Promise<{ outcome: 'success'|'failure'|null, error: string|null, usage: Usage }>}
 *   `outcome` is `null` when there is no valid result, and `error` then says why
 */
export async function runSession(ctx, { profile, prompt, schema, mode, session = null }) {
  const entry = /** @type {Profile} */ (profileOf(ctx.config, profile));
  const outcomeSchema = /** @type {import('../config/load.js').OutcomeSchema} */ (ctx.config.schema(schema));
  const staging = join(ctx.backlogDir, STAGING_DIR);
  mkdirSync(staging, { recursive: true });
  const dir = mkdtempSync(join(staging, 'agent-'));
  try {
    const promptPath = join(dir, 'prompt.md');
    const schemaPath = join(dir, schema);
    writeFileSync(promptPath, prompt);
    writeFileSync(schemaPath, JSON.stringify(outcomeSchema.schema));
    const adapter = adapterOf(entry);
    const agentRun = {
      profile: entry,
      prompt,
      mode,
      schemaPath,
      resultPath: join(dir, 'result.json'),
      cwd: ctx.repos[0]?.worktree_path ?? ctx.backlogDir,
      session,
      unit: ctx.id,
      // S-1644 records the id in state.json through ctx.session (D8).
      onSession: async () => {},
    };
    const ended = await (session === null ? adapter.start(agentRun) : adapter.resume(agentRun));
    if (ended.result === null) return { outcome: null, error: ended.error, usage: ended.usage };
    const [fault] = outcomeSchema.validate(ended.result);
    if (fault !== undefined) {
      return {
        outcome: null,
        error: `the result fails ${schema}: ${fault.path || '/'}: ${fault.message}`,
        usage: ended.usage,
      };
    }
    const { outcome } = /** @type {{ outcome: 'success'|'failure' }} */ (ended.result);
    return { outcome, error: null, usage: ended.usage };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run `bl.pre-agent` once for the item's repos (steps.md, "The stages `bl`
 * calls").
 * @param {StepContext} ctx
 * @throws {Error} when the stage fails, naming the repo and the note
 */
async function preAgent(ctx) {
  const ran = await runStage(ctx, 'bl.pre-agent', 'pre-agent', ctx.repos);
  if (ran.outcome === 'failure') {
    throw new Error(`bl.pre-agent failed in ${ran.repo}${ran.note === undefined ? '' : `: ${ran.note}`}`);
  }
}

/** @type {Step} */
export const agent = Object.freeze({
  outcomes: Object.freeze(/** @type {const} */ (['success', 'failure'])),
  with: {
    type: 'object',
    properties: {
      agents: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      prompt: FILE,
      schema: FILE,
      mode: { enum: ['headless', 'interactive'] },
      choices: { type: 'array', items: { type: 'string' } },
    },
    required: ['agents', 'prompt', 'schema', 'mode'],
    additionalProperties: false,
  },
  run: async (ctx, /** @type {AgentArgs} */ { agents, prompt, schema, mode, choices }) => {
    const promptFile = fileFor(prompt, ctx.type, 'prompt', ctx.box);
    const schemaFile = fileFor(schema, ctx.type, 'schema', ctx.box);
    const text = await renderAsync(
      /** @type {string} */ (ctx.config.prompt(promptFile)),
      { ...ctx.record, ...(choices === undefined ? {} : { choices }) },
      { partial: ctx.config.partial, bl: ctx.bl, config: ctx.config.scope(null) },
    );
    await preAgent(ctx);
    const [profile] = agents;
    const ended = await runSession(ctx, { profile, prompt: text, schema: schemaFile, mode });
    ctx.stage((/** @type {import('../store/write.js').Writer} */ w) =>
      w.usage(ctx.id, { at: now(), step: ctx.box, agent: profile, ...ended.usage }),
    );
    if (ended.outcome === null) {
      throw new Error(`no entry of agents gave a valid result: ${profile}: ${ended.error}`);
    }
    return ended.outcome;
  },
});

/**
 * The files that `value` names: the one file, or each file of the map.
 * @param {string|Record<string, string>} value
 */
const filesOf = (value) => (typeof value === 'string' ? [value] : Object.values(value));

/**
 * The start faults of the `agent` boxes of `flowSet` (F-141 D5): one for each
 * profile that `config/agents.yaml` does not define, each prompt or schema
 * file that does not exist, and each fault that a profile's adapter gives
 * (`faults`). Each is at the box's file and path, once. A profile whose
 * adapter is not built yet is a crash when the step reaches it, not a fault
 * here (F-141 D3). `main.js` calls it right after `buildFlowSet`.
 * @param {Configuration} config
 * @param {import('../engine/flow-set.js').FlowSet} flowSet
 * @returns {Fault[]}
 */
export function checkAgentBoxes(config, flowSet) {
  /** @type {Map<string, Fault>} */
  const faults = new Map();
  for (const flow of Object.values(flowSet.flows)) {
    for (const node of Object.values(flow.nodes)) {
      if (node.step !== AGENT) continue;
      const { file, path } = node.source;
      const add = (/** @type {string} */ message) =>
        faults.set(`${file}\0${path}\0${message}`, { file, path, rule: AGENT, message });
      const args = /** @type {AgentArgs} */ (node.with);
      for (const name of args.agents) {
        const profile = profileOf(config, name);
        if (profile === undefined) add(`the profile '${name}' is not in config/agents.yaml`);
        else
          for (const fault of ADAPTERS[profile.adapter]?.faults(profile) ?? []) add(`the profile '${name}': ${fault}`);
      }
      for (const name of filesOf(args.prompt)) {
        if (config.prompt(name) === undefined) add(`the prompt file config/prompts/${name} does not exist`);
      }
      for (const name of filesOf(args.schema)) {
        if (config.schema(name) === undefined) add(`the schema file config/schemas/${name} does not exist`);
      }
    }
  }
  return [...faults.values()];
}
