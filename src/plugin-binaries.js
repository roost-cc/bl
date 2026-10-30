/**
 * plugin-binaries.js — PATH probe for configured plugin tools.
 *
 * S-443 surfaces missing plugin binaries at `bl init` time (informational
 * readout) and as a `plugin-binary` finding in `bl validate`. Both call
 * `probePluginBinaries` so they agree on what counts as present vs missing.
 *
 * PATH probing matches the runtime contract used by `runPluginBatch` /
 * `runPlugins`: those spawn through `shell: true`, so a binary "exists" iff
 * the shell can find it. We use the same `command -v` probe POSIX shells use
 * for `which`, so aliases / PATH quirks resolve consistently with what would
 * actually run.
 */

import { spawnSync } from 'child_process';
import { enumeratePlugins } from './config.js';

const probeCache = new Map();

/**
 * Test-only: drop the per-process cache. The cache is intentionally
 * lifetime-of-process for real CLI use; tests that mutate `process.env.PATH`
 * across cases need a way to reset it.
 */
export function resetProbeCache() {
  probeCache.clear();
}

/**
 * Resolve a binary name against the current PATH. Returns `true` iff the
 * shell would find it. Cached across the lifetime of one process.
 */
export function probeBinary(firstToken) {
  if (!firstToken) return false;
  if (probeCache.has(firstToken)) return probeCache.get(firstToken);
  // `command -v` is POSIX, recognises shell builtins, aliases, and PATH
  // entries — same surface the shell uses to dispatch a plugin command.
  const result = spawnSync('command', ['-v', firstToken], {
    shell: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  const present = result.status === 0 && (result.stdout ?? '').trim() !== '';
  probeCache.set(firstToken, present);
  return present;
}

/**
 * Probe every plugin entry's first-token against PATH. Returns one record
 * per `(plugin, firstToken)` pair (see `enumeratePlugins`); entries with no
 * resolvable first-token (empty command string, unparseable leader) are
 * marked `present: null` so callers can render them as SKIP without
 * triggering a missing-binary warning.
 *
 * @returns {Array<{
 *   plugin: string,
 *   stages: string[],
 *   command: string,
 *   firstToken: string | null,
 *   present: boolean | null
 * }>}
 */
export function probePluginBinaries(config) {
  const entries = enumeratePlugins(config);
  return entries.map((e) => ({
    plugin: e.key,
    stages: e.stages.slice(),
    command: e.command,
    firstToken: e.firstToken,
    present: e.firstToken ? probeBinary(e.firstToken) : null,
  }));
}

/**
 * Render the human-readable "Plugin tools:" block for `bl init`. Always
 * informational — no exit-code semantics. Returns a multi-line string with
 * a trailing newline; empty if no plugins are configured.
 */
export function formatPluginStatus(probeResult) {
  if (probeResult.length === 0) return '';
  const labelWidth = Math.max(...probeResult.map((e) => (e.firstToken ?? e.plugin).length));
  const out = ['Plugin tools:'];
  // Sort by status (MISSING first so it's eye-catching), then by label.
  const order = { MISSING: 0, OK: 1, SKIP: 2 };
  const labelled = probeResult.map((e) => {
    const label = e.firstToken ?? e.plugin;
    const status = e.present === null ? 'SKIP' : e.present ? 'OK' : 'MISSING';
    return { ...e, label, status };
  });
  labelled.sort((a, b) => order[a.status] - order[b.status] || a.label.localeCompare(b.label));
  for (const e of labelled) {
    const stagesStr = e.stages.length ? ` (${e.plugin}: ${e.stages.join(', ')})` : ` (${e.plugin})`;
    out.push(`  ${e.label.padEnd(labelWidth)}  ${e.status.padEnd(7)}${stagesStr}`);
  }
  return out.join('\n') + '\n';
}
