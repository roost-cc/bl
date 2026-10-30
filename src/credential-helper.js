import { spawnSync } from 'child_process';

const HELPER_KEY_RE = /^credential(?:\..*)?\.helper$/;
const GH_HELPER_RE = /(?:^|\/)gh\s+auth\s+git-credential(?:\s|$)/;

export function parseGhCredentialHelpers(configLines = []) {
  const lines = Array.isArray(configLines)
    ? configLines.flatMap((line) => String(line ?? '').split(/\r?\n/))
    : String(configLines ?? '').split(/\r?\n/);
  const matches = [];

  for (const rawLine of lines) {
    const parsed = parseConfigLine(rawLine);
    if (!parsed) continue;
    if (isGhCredentialHelper(parsed.value)) matches.push(parsed);
  }

  return { configured: matches.length > 0, matches };
}

export function detectGhCredentialHelper({ run = defaultRun } = {}) {
  const result = run();
  if (!result || result.status !== 0 || (result.error && !result.stdout)) {
    return { configured: false, matches: [] };
  }
  return parseGhCredentialHelpers(result.stdout ?? '');
}

export function formatGhCredentialHelperAdvisory(detection) {
  if (!detection?.configured) return '';
  const keys = detection.matches.map(({ key, value }) => `  - ${key}: ${value}`).join('\n');

  return (
    'GitHub CLI credential helper detected:\n' +
    `${keys}\n\n` +
    'Removing `gh` will break `git push` and other authenticated git operations until this helper is replaced.\n' +
    'See `bl/src/AGENTS.md` > "Caveat: `gh auth git-credential`" > "Migration recipe".'
  );
}

function defaultRun() {
  return spawnSync('git', ['config', '--get-regexp', '^credential(\\..*)?\\.helper$'], { encoding: 'utf8' });
}

function parseConfigLine(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (!line) return null;

  const whitespaceIndex = line.search(/\s/);
  const equalsIndex = line.indexOf('=');
  const separators = [whitespaceIndex, equalsIndex].filter((idx) => idx >= 0);
  if (separators.length === 0) return null;

  const separatorIndex = Math.min(...separators);
  const key = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();
  if (!HELPER_KEY_RE.test(key) || !value) return null;
  return { key, value };
}

function isGhCredentialHelper(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/^!\s*/, '');
  return GH_HELPER_RE.test(normalized);
}
