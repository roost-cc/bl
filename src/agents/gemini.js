/**
 * gemini.js — Gemini implementation of AgentProvider.
 *
 * This implementation uses the real 'gemini' CLI.
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { AgentProvider } from './provider.js';

export class GeminiProvider extends AgentProvider {
  get name() {
    return 'gemini';
  }

  // spawn() takes no model, and the walk skips Gemini for headless steps
  // (F-64 D5); its policy file carries `denied` as deny rules.
  supportsModel() {
    return false;
  }

  supportsDeny() {
    return true;
  }

  /**
   * Translates generic backlog permissions into Gemini-specific tool definitions.
   */
  translatePermissions(permissions) {
    const mapping = {
      'fs:read': 'read_file',
      'fs:write': 'write_file',
      'fs:edit': 'replace',
      'fs:glob': 'glob',
      'fs:grep': 'grep_search',
      'agent:spawn': 'invoke_agent',
    };

    return permissions.map((p) => {
      const base = p.split('(')[0];
      const gen = mapping[base];
      if (gen) {
        return gen;
      }
      return p;
    });
  }

  suggestPermission(entry, _opts = {}) {
    const mapping = {
      read_file: 'fs:read',
      write_file: 'fs:write',
      replace: 'fs:edit',
      glob: 'fs:glob',
      grep_search: 'fs:grep',
      invoke_agent: 'agent:spawn',
    };

    const tool = entry.tool_name || entry.tool || 'Unknown';
    const gen = mapping[tool];
    const cmd = entry.tool_input?.command || entry.command || '*';

    if (gen) return `${gen}:${cmd}`;
    return `${tool}:${cmd}`;
  }

  getToolHints() {
    return {
      readTool: 'read_file',
      editTool: 'replace',
      writeTool: 'write_file',
      globTool: 'glob',
      grepTool: 'grep_search',
    };
  }

  async init() {
    // No-op: no permission grants are written to ~/.gemini. Directory access is
    // injected per-launch in `spawn` (read roots via `--include-directories`,
    // write roots via the per-run policy), and the worktree is trusted with the
    // ephemeral `--skip-trust` flag — so nothing is persisted user-wide.
  }

  findSession(worktreePath, name) {
    // Resuming sessions in Gemini CLI is typically done by project path or ID.
    // For now, we'll return null to start fresh, which is safer for automated workons.
    return null;
  }

  spawn({
    mode,
    name,
    prompt,
    permissions,
    denied = [],
    worktreePath,
    cwd = worktreePath,
    sessionId,
    args = [],
    scopes = {},
  }) {
    const geminiArgs = [...args];

    if (sessionId) {
      geminiArgs.push('--resume', sessionId);
    }

    // Gemini uses -i to run a prompt and stay interactive
    if (prompt) {
      geminiArgs.push('-i', prompt);
    }

    // Read scope: include every read root in the workspace so the agent can
    // read across the backlog's sibling repos without prompting.
    for (const dir of scopes.read ?? []) {
      geminiArgs.push('--include-directories', dir);
    }

    // Trust the worktree automatically to avoid prompts (ephemeral; nothing is
    // written to ~/.gemini/trustedFolders.json).
    geminiArgs.push('--skip-trust');

    // Generate a temporary policy file to allow tools without confirmation.
    // Write tools are confined to the write roots; reads/shell are global.
    const policyPath = join('/tmp', `bl-gemini-policy-${sessionId || name || 'session'}.toml`);
    const policy = this.generatePolicy(permissions, scopes.write ?? [], denied);
    writeFileSync(policyPath, policy);
    geminiArgs.push('--policy', policyPath);

    const result = spawnSync('gemini', geminiArgs, {
      stdio: 'inherit',
      cwd,
    });

    try {
      unlinkSync(policyPath);
    } catch {}

    return result;
  }

  generatePolicy(permissions, writeRoots = [], denied = []) {
    // Shell-prefix allowlist is fully derived from `permissions`. The
    // toolchain leaders (`prettier`, `pnpm`, `go`, ...) come from
    // `<backlogRoot>/allowed-tools.json` `_generated` from `backlog.json`'s
    // `plugins` (see src/allowed-tools.js); no per-machine binary names are
    // baked in here anymore.
    //
    // Built-in tools split into two buckets so write scope matches the other
    // providers: read-family tools are allowed globally, but the mutating
    // tools (`write_file`/`replace`) are allowed ONLY where their target path
    // falls inside a write root — never globally, even though base ships
    // `fs:write`/`fs:edit`.
    const WRITE_TOOLS = new Set(['write_file', 'replace']);
    const shellCommands = new Set();
    const readTools = new Set();
    const writeTools = new Set();

    const mapping = {
      'fs:read': 'read_file',
      'fs:write': 'write_file',
      'fs:edit': 'replace',
      'fs:glob': 'glob',
      'fs:grep': 'grep_search',
      'agent:spawn': 'invoke_agent',
      'plan:exit': 'exit_plan_mode',
      read_file: 'read_file',
      write_file: 'write_file',
      replace: 'replace',
      glob: 'glob',
      grep_search: 'grep_search',
      invoke_agent: 'invoke_agent',
    };

    for (const p of permissions) {
      if (mapping[p]) {
        const tool = mapping[p];
        if (WRITE_TOOLS.has(tool)) writeTools.add(tool);
        else readTools.add(tool);
      } else if (p.endsWith(':*')) {
        shellCommands.add(p.slice(0, -2));
      } else if (p.startsWith('Bash(') && p.endsWith(')')) {
        const inner = p.slice(5, -1);
        if (inner.endsWith(':*')) {
          shellCommands.add(inner.slice(0, -2));
        } else if (inner.endsWith('/*')) {
          shellCommands.add(inner.slice(0, -1));
        } else {
          shellCommands.add(inner);
        }
      }
    }

    let toml = '';

    if (readTools.size > 0) {
      toml += '[[rule]]\n';
      toml += `toolName = ${JSON.stringify([...readTools])}\n`;
      toml += 'decision = "allow"\n';
      toml += 'priority = 100\n\n';
    }

    if (shellCommands.size > 0) {
      toml += '[[rule]]\n';
      toml += 'toolName = "run_shell_command"\n';
      toml += `commandPrefix = ${JSON.stringify([...shellCommands])}\n`;
      toml += 'decision = "allow"\n';
      toml += 'priority = 100\n';
      toml += 'allowRedirection = true\n\n';
    }

    // Hard denials outrank every allow rule (higher priority number wins in
    // the Gemini policy engine). Generic ":*" tokens from the mode's `deny`
    // map become shell command-prefix refusals.
    const denyPrefixes = denied.filter((d) => typeof d === 'string' && d.endsWith(':*')).map((d) => d.slice(0, -2));
    if (denyPrefixes.length > 0) {
      toml += '[[rule]]\n';
      toml += 'toolName = "run_shell_command"\n';
      toml += `commandPrefix = ${JSON.stringify(denyPrefixes)}\n`;
      toml += 'decision = "deny"\n';
      toml += 'priority = 300\n\n';
    }

    // Write tools: allow ONLY when the target path is inside a write root.
    // Reads of those same roots are already covered by the global read rule
    // and `--include-directories`, so this rule is write-scope only.
    if (writeTools.size > 0) {
      for (const root of writeRoots) {
        const escapedRoot = String(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        toml += '[[rule]]\n';
        toml += `toolName = ${JSON.stringify([...writeTools])}\n`;
        toml += `argsPattern = '.*${escapedRoot}.*'\n`;
        toml += 'decision = "allow"\n';
        toml += 'priority = 200\n\n';
      }
    }

    return toml;
  }

  parseLogs(sessionId) {
    // Gemini CLI logs are in ~/.gemini/tmp/<slug>/logs.json
    // This requires mapping worktreePath to slug, which is complex.
    // For now, return empty.
    return [];
  }

  clearLogs() {
    // No-op for now.
  }
}
