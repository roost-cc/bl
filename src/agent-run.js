/**
 * agent-run.js — launch the configured agent with the backlog allowed-tools applied.
 *
 * No session name, no worktree. The session is seeded with `prompts/agent.md`,
 * which frames it as a questions/design space (not implementation). Passthrough
 * args go to the agent.
 */

import { spawnSync } from 'child_process';
import { loadConfig, parseArgs, worktreeRoot } from './config.js';
import { getAllowedTools, loadPrompt } from './session.js';
import { resolvePermissionScopes } from './permissions.js';
import { getProvider } from './agents/index.js';

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl agent [agent-args...]

Launches the configured agent with the base allowed-tools from
backlog/allowed-tools.json applied. The session is framed for questions
and design discussion (not implementation) via prompts/agent.md.

Any extra args are passed through to the agent.

Aliases: claude`);
    process.exit(0);
  }

  const config = loadConfig({ agent: args.agent });
  const { backlogRoot, roostDir, agent } = config;
  const provider = getProvider(agent);
  const allowedTools = getAllowedTools(agent, {
    backlogRoot,
    roostDir,
    config,
  });
  const translatedPermissions = provider.translatePermissions(allowedTools, {
    mode: agent,
    roostDir,
    backlogRoot,
    worktreePath: process.cwd(),
    worktreeRoot: worktreeRoot(config),
  });

  const prompt = loadPrompt('agent', {}, { agent, config });

  const result = provider.spawn({
    mode: agent,
    prompt,
    permissions: translatedPermissions,
    worktreePath: process.cwd(),
    args: args.positional,
    roostDir,
    backlogRoot,
    scopes: resolvePermissionScopes(config, { unitDir: process.cwd() }),
    model: config.agentModel,
  });

  process.exit(result.status ?? 0);
}
