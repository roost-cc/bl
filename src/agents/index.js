/**
 * index.js — Agent provider registry.
 */

import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { GeminiProvider } from './gemini.js';
import { PROVIDER_NAMES } from './names.js';

export { hasProvider, PROVIDER_NAMES } from './names.js';

// Built on first use, not at load: config.js imports this registry and every
// adapter imports config.js, so a module that loads an adapter first reaches
// here before that adapter's class exists (the cycle names.js documents).
let PROVIDERS = null;

function providers() {
  if (PROVIDERS) return PROVIDERS;
  PROVIDERS = {
    claude: ClaudeProvider,
    codex: CodexProvider,
    gemini: GeminiProvider,
  };
  // names.js is the source of truth for which keys exist; keep the class map
  // in lockstep with it.
  for (const name of PROVIDER_NAMES) {
    if (!PROVIDERS[name]) throw new Error(`agents/index.js: no class for provider ${name}`);
  }
  return PROVIDERS;
}

/**
 * Get the provider instance for the configured agent.
 * @param {string} name
 * @returns {import("./provider.js").AgentProvider}
 */
export function getProvider(name = 'claude') {
  const ProviderClass = providers()[name.toLowerCase()];
  if (!ProviderClass) {
    throw new Error(`Unknown agent provider: ${name}`);
  }
  return new ProviderClass();
}
