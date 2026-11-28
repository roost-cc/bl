/**
 * agent.js — the `agent` step, `runSession` and the start check of agent
 * boxes (F-141 D5; agents.md, "The agent step", "What a prompt sees").
 *
 * - The step picks the prompt and the schema file for the item's type
 *   (D-73), renders the prompt over the record with `{{#bl}}`, the partials
 *   and the configuration as `config` (D-494), and runs `bl.pre-agent` once
 *   for the item's repos. Then it runs a session with the first entry of
 *   `agents` that has capacity (`firstWithCapacity`). A session with no valid
 *   result moves on to the next entry with capacity while the worktree is
 *   unchanged, and is a crash when the worktree changed or no entry is left
 *   (D-120, F-141 D7). It stages one usage entry per session, so the entries
 *   go into the box's commit (history.md, "Usage log").
 * - Each new session's id goes into `state.json` through `ctx.session` as
 *   soon as the adapter knows it. A session that `state.json` keeps for the
 *   box, with a profile that is still in the list, is resumed before the
 *   list is tried (D-417, F-141 D8).
 * - The step is interactive in `mode: interactive`, so the runner does not
 *   start it without a terminal (D-29, F-141 D9).
 * - `runSession` runs one session through the profile's adapter, in a fresh
 *   directory under `<backlog>/.bl/tmp/` that it removes afterwards, and
 *   checks the result with the box's outcome schema. F-152's session at a
 *   `wait` box calls it too (Decision A2).
 * - `checkAgentBoxes` finds, at start, each name in an `agent` box that the
 *   configuration does not have.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { adapterOf } from '../adapters/index.js';
import { AGENT_OUTCOMES } from '../config/load.js';
import { renderAsync } from '../config/template.js';
import { STAGING_DIR } from '../lib/staging.js';
import { readState } from '../store/item-json.js';
import { itemDir } from '../store/items.js';
import { now } from '../store/write.js';
import { AGENT, firstWithCapacity, profileFaults, profileOf } from './capacity.js';
import { runStage } from './stage.js';
import { changed } from './worktrees.js';

/** @typedef {import('./index.js').Step} Step */
/** @typedef {import('./index.js').StepContext} StepContext */
/** @typedef {import('../adapters/index.js').Profile} Profile */
/** @typedef {import('../adapters/index.js').Usage} Usage */
/** @typedef {import('../config/files.js').Fault} Fault */
/** @typedef {import('../config/load.js').Configuration} Configuration */

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

/**
 * Run one agent session and check its result (F-141 D5): `start` a new
 * session, whose id the adapter gives to `ctx.session` (D8), or `resume` the
 * session `session` when it is given. The prompt
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
      onSession: async (/** @type {string|null} */ id) => {
        await ctx.session({ profile, id });
      },
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

/**
 * The agent session that `state.json` keeps for the step's box, when its
 * profile is in `agents`; else `null`, and the step starts as for a new box
 * (D-417, F-141 D8).
 * @param {StepContext} ctx
 * @param {readonly string[]} agents
 * @returns {{ profile: string, id: string }|null}
 */
function keptSession(ctx, agents) {
  const { session } = /** @type {{ session?: { box: string, profile: string, id: string } }} */ (
    readState(ctx, /** @type {import('../store/items.js').Item} */ (itemDir(ctx, ctx.id)))
  );
  return session?.box === ctx.box && agents.includes(session.profile) ? session : null;
}

/** @type {Step} */
export const agent = Object.freeze({
  // An outcome schema limits a result's outcome to these (config/load.js).
  outcomes: AGENT_OUTCOMES,
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
    // The rule of D-120 (F-141 D7): each entry tried adds `<profile>: <error>`
    // to `tried`, and is not tried again. The rule never reads an error.
    /** @type {string[]} */
    const tried = [];
    /** @type {Set<string>} */
    const skip = new Set();
    /**
     * Run a session of `profile`, a new one or the session `session`, and give
     * its outcome, or `null` when it gave no valid result.
     * @param {string} profile
     * @param {string|null} [session]
     */
    const attempt = async (profile, session = null) => {
      const ended = await runSession(ctx, { profile, prompt: text, schema: schemaFile, mode, session });
      ctx.stage((/** @type {import('../store/write.js').Writer} */ w) =>
        w.usage(ctx.id, { at: now(), step: ctx.box, agent: profile, ...ended.usage }),
      );
      // A `failure` is a result too: it ends the step and never moves on.
      if (ended.outcome !== null) return ended.outcome;
      tried.push(`${profile}: ${ended.error}`);
      skip.add(profile);
      // A second agent never starts on the partial work of the first: `bl resume` reruns the box.
      if (changed(ctx.snapshot, ctx.repos)) {
        throw new Error(`the worktree changed after ${profile} gave no valid result: ${tried.join('; ')}`);
      }
      return null;
    };
    // A session that the box kept continues first, while its profile is in the list (D-417, F-141 D8).
    const kept = keptSession(ctx, agents);
    if (kept !== null) {
      const outcome = await attempt(kept.profile, kept.id);
      if (outcome !== null) return outcome;
    }
    for (;;) {
      const { name: profile, passed } = await firstWithCapacity(ctx, agents, skip);
      for (const { name, reason } of passed) {
        tried.push(`${name}: ${reason}`);
        skip.add(name);
      }
      if (profile === null) throw new Error(`no entry of agents gave a valid result: ${tried.join('; ')}`);
      const outcome = await attempt(profile);
      if (outcome !== null) return outcome;
    }
  },
  interactive: (/** @type {AgentArgs} */ { mode }) => mode === 'interactive',
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
      for (const name of args.agents) for (const fault of profileFaults(config, name)) add(fault);
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
