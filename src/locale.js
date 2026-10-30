/**
 * locale.js — resolve a locale signal for prompt-fragment localization.
 *
 * Centralized so `loadPrompt` (`session.js`) and `readFragment`
 * (`tool-guide.js`) share the same precedence and normalization rules.
 *
 * Precedence (first non-empty wins):
 *   1. `config.raw.locale` — top-level `backlog.json` field
 *   2. `BL_LOCALE` env
 *   3. `LC_ALL` env
 *   4. `LANG` env
 *
 * Normalization: strip `.UTF-8`-style codeset and `@modifier` suffixes,
 * split on `_`/`-` into language + region, lowercase the language, keep
 * the region as written. `C` / `POSIX` resolve to `null` (no locale).
 *
 * Localization is opt-in; the project ships English-only by default and
 * a `null` return means "load the un-suffixed file".
 */

import { hasProvider } from './agents/names.js';

export function resolveLocale(config) {
  const sources = [config?.raw?.locale, process.env.BL_LOCALE, process.env.LC_ALL, process.env.LANG];
  for (const s of sources) {
    const norm = normalizeLocale(s);
    if (norm) return norm;
  }
  return null;
}

export function normalizeLocale(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  // Strip codeset (`fr_FR.UTF-8` → `fr_FR`) and modifier (`@euro`) suffixes.
  s = s.split('.')[0].split('@')[0];
  if (!s || s === 'C' || s === 'POSIX') return null;
  const parts = s.split(/[-_]/);
  const lang = parts[0]?.toLowerCase() ?? '';
  if (!lang) return null;
  const region = parts[1];
  if (!region) return lang;
  return `${lang}-${region}`;
}

/**
 * Build the ordered list of `<name>.<variant>.md` filenames to try for a
 * given fragment name, locale signal, and optional agent signal, ending
 * with the un-suffixed `<name>.md` as the always-present fallback.
 *
 * For a region-tagged locale like `fr-FR` the order is
 * `<name>.fr-FR.md` → `<name>.fr.md` → `<name>.md`; for a bare-language
 * locale `fr` it's `<name>.fr.md` → `<name>.md`; with no locale signal
 * the list is just `[<name>.md]`.
 *
 * Agent variants are the dominant axis. With `agent = "claude"` and
 * `locale = "fr-FR"`, the order is:
 * `<name>.claude.fr-FR.md` → `<name>.claude.fr.md` →
 * `<name>.claude.md` → `<name>.fr-FR.md` → `<name>.fr.md` →
 * `<name>.md`.
 */
export function fragmentCandidates(name, locale, agent = null) {
  const out = [];
  const agentId = normalizeAgentId(agent);
  const localeTags = [];
  if (typeof locale === 'string' && locale) {
    localeTags.push(locale);
    const dash = locale.indexOf('-');
    if (dash !== -1) {
      localeTags.push(locale.slice(0, dash));
    }
  }
  if (agentId) {
    for (const tag of localeTags) {
      out.push(`${name}.${agentId}.${tag}.md`);
    }
    out.push(`${name}.${agentId}.md`);
  }
  for (const tag of localeTags) {
    out.push(`${name}.${tag}.md`);
  }
  out.push(`${name}.md`);
  return out;
}

function normalizeAgentId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(s)) return null;
  if (!hasProvider(s)) return null;
  return s;
}
