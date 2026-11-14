/**
 * claude-capacity.js — read the Claude account's quota from Claude Code's
 * OAuth usage endpoint (S-1143).
 *
 * `ClaudeProvider.capacity()` awaits `readClaudeUsage` in the bl process. It
 * reads the OAuth token Claude Code stores in
 * `$CLAUDE_CONFIG_DIR/.credentials.json`, asks `GET /api/oauth/usage` with
 * the headers Claude Code's own usage display sends, and resolves to
 * `{ ok: true, body: <the answer> }`, or `{ ok: false, error: "..." }` with
 * the reason. `claudeCapacity()` in claude.js maps the body.
 *
 * The endpoint is undocumented. The token is never refreshed: Claude Code
 * owns it, and a refresh would rotate it under a running session. No error
 * message holds the token.
 */

import { readFile } from 'fs/promises';

/** Claude Code's OAuth usage endpoint. */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** How long the usage request may take before it is abandoned. */
export const CLAUDE_CAPACITY_TIMEOUT_MS = 10_000;

/**
 * The OAuth token in the credentials file's `text` (read from `path`):
 * `claudeAiOauth.accessToken`, unless `claudeAiOauth.expiresAt` (epoch
 * milliseconds) is at or before `now`. A missing `expiresAt` keeps the token.
 * @param {string} text
 * @param {string} path
 * @param {number} [now]
 * @returns {{ token: string } | { error: string }}
 */
export function readClaudeToken(text, path, now = Date.now()) {
  const missing = { error: `no Claude OAuth token in ${path}; run claude to log in` };
  let oauth;
  try {
    oauth = JSON.parse(text)?.claudeAiOauth;
  } catch {
    return missing;
  }
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || token === '') return missing;
  const expiresAt = oauth.expiresAt;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    const at = new Date(expiresAt);
    const when = Number.isFinite(at.getTime()) ? at.toISOString() : String(expiresAt);
    return { error: `the Claude OAuth token expired at ${when}; run claude to refresh it` };
  }
  return { token };
}

/**
 * GET the usage endpoint at `url` with the token from `credentials`, within
 * `timeoutMs`. Never rejects. A non-200 body is cancelled unread.
 * @param {{ credentials: string, url?: string, timeoutMs?: number, now?: number }} opts
 * @returns {Promise<{ ok: true, body: unknown } | { ok: false, error: string }>}
 */
export async function readClaudeUsage({
  credentials,
  url = CLAUDE_USAGE_URL,
  timeoutMs = CLAUDE_CAPACITY_TIMEOUT_MS,
  now = Date.now(),
}) {
  const fail = (error) => ({ ok: false, error });
  let text;
  try {
    text = await readFile(credentials, 'utf8');
  } catch (error) {
    return fail(
      error?.code === 'ENOENT' ? `no Claude credentials at ${credentials}; run claude to log in` : error.message,
    );
  }
  const { token, error } = readClaudeToken(text, credentials, now);
  if (error) return fail(error);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/1.0.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return fail(`the Claude usage endpoint answered HTTP ${res.status}`);
    }
    const body = await res.text();
    try {
      return { ok: true, body: JSON.parse(body) };
    } catch {
      return fail('the Claude usage endpoint answered with a body that is not JSON');
    }
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      return fail(`the Claude usage endpoint did not answer within ${timeoutMs / 1000}s`);
    }
    // fetch names a header value it refuses, and the token is one.
    const cause = String(error?.cause?.message ?? error?.message ?? error).replaceAll(token, '<token>');
    return fail(`the Claude usage endpoint could not be reached: ${cause}`);
  }
}
