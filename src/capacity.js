/**
 * capacity.js — `bl capacity`: what each agent configuration can take now
 * (F-64 D6).
 *
 *   bl capacity [--json]
 *
 * One row per configuration of both roles (`agent`, then `review_agent`), in
 * list order, each from its adapter's `capacity()`: the call the walk makes,
 * so the operator sees what the loop will see. An `account`-scoped answer is
 * the agent's for every model, so each agent is asked once, and a
 * `model`-scoped one once per model. It reports and does not gate: it exits
 * 0 whatever the states.
 */

import { loadConfig, parseArgs } from './config.js';
import { getProvider } from './agents/index.js';
import { localTime } from './feature-run.js';

export const CAPACITY_SCHEMA = 'bl-capacity-json/v1';

const HELP = `Usage: bl capacity [--json]

Show whether each agent configuration in backlog.json (agent, then
review_agent) can take work now, asking each agent's adapter the way bl run
does before it spawns.

Each row: the role, the agent, the model (- for the account's own), the
state (available, unavailable or unknown), each quota window the adapter
read with its remaining percent and its reset in local time, and the
adapter's message. An agent whose quota is one for every model (Codex) is
asked once. An adapter that cannot report capacity (Claude, Gemini) shows
unknown, as does a read that failed, with the reason.

Options:
  --json   Print {schema: "${CAPACITY_SCHEMA}", configurations: [...]}, each
           {role, agent, model, state, scope, until, windows: [{name,
           remainingPercent, resetsAt}], message}; times are ISO 8601 or null

Exit codes:
  0   Reported, whatever the states.
  1   No backlog, or a backlog.json bl cannot load.`;

/**
 * Every configuration of both roles with its adapter's answer. `ask(agent,
 * model)` is the adapter call (a test passes its own).
 *
 * @param {{ agents: {agent: string, model: string|null}[],
 *           reviewAgents: {agent: string, model: string|null}[] }} config
 * @param {(agent: string, model: string|null) => object} [ask]
 * @returns {object[]}
 */
export function capacityRows(config, ask = (agent, model) => getProvider(agent).capacity({ model })) {
  const byAgent = new Map();
  const byConfiguration = new Map();
  const read = (agent, model) => {
    if (byAgent.has(agent)) return byAgent.get(agent);
    const key = JSON.stringify([agent, model]);
    if (!byConfiguration.has(key)) {
      const answer = ask(agent, model);
      byConfiguration.set(key, answer);
      if (answer.scope === 'account') byAgent.set(agent, answer);
    }
    return byConfiguration.get(key);
  };
  const rows = [];
  for (const [role, list] of [
    ['agent', config.agents ?? []],
    ['review', config.reviewAgents ?? []],
  ]) {
    for (const { agent, model } of list) {
      rows.push({ role, agent, model: model ?? null, ...read(agent, model ?? null) });
    }
  }
  return rows;
}

// A time that is not a date (an adapter's bad answer) prints as null: never throws.
const iso = (d) => (d == null || !Number.isFinite(new Date(d).getTime()) ? null : new Date(d).toISOString());

/** A row as `--json` prints it. */
export function capacityJson(row) {
  return {
    role: row.role,
    agent: row.agent,
    model: row.model,
    state: row.state,
    scope: row.scope,
    until: iso(row.until),
    windows: (row.windows ?? []).map((w) => ({
      name: w.name,
      remainingPercent: w.remainingPercent,
      resetsAt: iso(w.resetsAt),
    })),
    message: row.message ?? '',
  };
}

/** The detail column: the windows, the time an `unavailable` row lifts, the message. */
function detail(row) {
  const parts = (row.windows ?? []).map(
    (w) => `${w.name} ${w.remainingPercent}% left${w.resetsAt ? ` (resets ${localTime(w.resetsAt)})` : ''}`,
  );
  if (row.state === 'unavailable' && row.until) parts.push(`until ${localTime(row.until)}`);
  if (row.message) parts.push(row.message);
  return parts.join('; ');
}

/** The rows as an aligned table. */
export function capacityTable(rows) {
  const cells = [
    ['ROLE', 'AGENT', 'MODEL', 'STATE', 'DETAIL'],
    ...rows.map((r) => [r.role, r.agent, r.model ?? '-', r.state, detail(r)]),
  ];
  const widths = [0, 1, 2, 3].map((i) => Math.max(...cells.map((c) => c[i].length)));
  return cells
    .map((c) =>
      c
        .map((v, i) => (i < 4 ? v.padEnd(widths[i]) : v))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.positional.length > 0) {
    console.error(`bl capacity: takes no arguments (got ${args.positional.join(' ')})`);
    process.exit(1);
  }
  const rows = capacityRows(loadConfig());
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ schema: CAPACITY_SCHEMA, configurations: rows.map(capacityJson) }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${capacityTable(rows)}\n`);
}
