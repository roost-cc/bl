/**
 * surface.js - resolve the host surface wrapping an agent session.
 *
 * The agent axis controls tool names and agent-specific prose. The surface
 * axis controls IDE/host-specific behaviour such as Claude Code slash
 * commands. Keep the signal explicit and conservative so prompt fragments do
 * not leak into headless/raw API sessions.
 */

export function resolveSurface(config) {
  const configSurface = normalizeSurface(config?.raw?.surface);
  if (configSurface) return configSurface;

  if (typeof process.env.BL_SURFACE === 'string') {
    return normalizeSurface(process.env.BL_SURFACE);
  }

  if (process.env.CLAUDECODE === '1') return 'claude-code';
  return null;
}

export function normalizeSurface(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s || s === 'none' || s === 'null') return null;
  if (!/^[a-z0-9-]+$/.test(s)) return null;
  return s;
}
