/**
 * tokens.js — record agent token usage on a story's frontmatter.
 *
 * The provider owns the transcript format (Claude reads ~/.claude/projects
 * JSONLs; Gemini currently has none and returns null). We aggregate usage
 * across every worktree the story touches and overwrite the frontmatter
 * `tokens_*` fields each call — idempotent, since the provider re-reads the
 * full transcript every time.
 *
 * `tokens_by_step` (S-904) records the same four kinds per step of a run
 * (`<step>[.<round>]`: `implement`, `review.2`, `fix.1`, …) as the sessions
 * happen. It only ever accumulates, and the overwrite above never touches it.
 *
 * Every writer here goes through `updateSpecFile` (`spec-file.js`): under
 * the spec lock, fence-checked, replaced atomically. Token bookkeeping is
 * best-effort (F-67 D3): each writer catches its errors and returns false.
 */

import { existsSync } from 'fs';
import { updateSpecFile } from './spec-file.js';
import { reposForStory } from './story.js';
import { getProvider } from './agents/index.js';

/**
 * The directories a unit's agent transcripts are kept for, once each: its
 * unit directory, where every session starts (F-60 D3), then each repo's
 * worktree, where sessions started before it.
 * @param {{ worktreePath: string, unitDir?: string }[]} repos
 * @returns {string[]}
 */
export function transcriptDirs(repos) {
  return [...new Set(repos.flatMap((r) => [r.unitDir, r.worktreePath]).filter(Boolean))];
}

/**
 * Sum token usage for a story across its unit directory's and every
 * worktree's agent transcripts (`transcriptDirs`).
 * Returns null if the provider doesn't implement getTokens or nothing matched.
 */
export function collectStoryTokens(storyId, config) {
  const provider = getProvider(config.agent);
  const repos = reposForStory(storyId, config);
  if (repos.length === 0) return null;

  const titlePrefix = `${storyId}:`;
  const totals = { input: 0n, output: 0n, cache_creation: 0n, cache_read: 0n };
  let any = false;

  for (const dir of transcriptDirs(repos)) {
    let u;
    try {
      u = provider.getTokens(dir, titlePrefix);
    } catch (err) {
      // The base AgentProvider throws "getTokens() not implemented" when a
      // provider opts out of token tracking — bail out for the whole story
      // since re-trying per repo would just throw again. Anything else is a
      // real bug and should propagate so it surfaces instead of silently
      // disabling tracking forever.
      if (/not implemented/.test(err?.message ?? '')) return null;
      throw err;
    }
    if (!u) continue;
    // A count that is not exact (an unsafe number) leaves the stored totals alone.
    if (!addUsageTotals(totals, u)) return null;
    any = true;
  }

  return any ? totals : null;
}

/**
 * Add one worktree's transcript totals `u` into `totals`, per kind as a
 * BigInt count (`tokenCount`), so a sum across repos past 2^53 is exact.
 * A kind that is present but not a count (an unsafe or fractional number,
 * say) cannot be summed exactly: `totals` is left as it was and the result
 * is false, so the caller writes nothing rather than a total that is wrong.
 * @param {Record<string, bigint>} totals the four kinds, starting at 0n
 * @param {object} u a provider's `getTokens` result
 * @returns {boolean} whether `u` was added
 */
export function addUsageTotals(totals, u) {
  if (!TOKEN_KEYS.every((k) => u[k] == null || isTokenCount(u[k]))) return false;
  for (const k of TOKEN_KEYS) totals[k] = (totals[k] ?? 0n) + tokenCount(u[k]);
  return true;
}

/**
 * Merge token totals into a frontmatter object in-place. Pure — caller
 * decides when to serialize. Used by `bl done` so the same write captures
 * status, commit, and tokens.
 */
export function applyTokensToFrontmatter(fm, totals) {
  if (!totals) return;
  fm.tokens_input = String(totals.input);
  fm.tokens_output = String(totals.output);
  fm.tokens_cache_creation = String(totals.cache_creation);
  fm.tokens_cache_read = String(totals.cache_read);
  // Date-only to match `completed`/`added` in the same frontmatter.
  fm.tokens_updated = new Date().toISOString().slice(0, 10);
}

const TOKEN_KEYS = ['input', 'output', 'cache_creation', 'cache_read'];

/**
 * The `tokens_by_step` key a session of run step `step` records under: every
 * review session of a round (`review:<dim>`, `review:verify`) under
 * `review.<round>`, a fix or fix self-review under `<step>.<round>`, anything
 * else under its step. Without a round, the bare step.
 */
export function tokensStepKey(step, round) {
  const r = Number(round);
  const hasRound = Number.isInteger(r) && r > 0;
  if (step.startsWith('review:')) return hasRound ? `review.${r}` : 'review';
  if ((step === 'fix' || step === 'fix-self-review') && hasRound) return `${step}.${r}`;
  return step;
}

const isMapping = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * A token count, as a BigInt: a string of digits of any length (what the
 * frontmatter stores, and what `bl validate` accepts), a non-negative safe
 * integer number (a provider's count) or a non-negative BigInt. Anything else
 * (fractional, negative, not finite, an unsafe number, not a number) is
 * rejected as 0, so every writer stores the same value for it, in the map
 * and in the totals alike. BigInt sums never round or overflow, so a valid
 * stored count is never lost when more is added to it.
 */
function tokenCount(v) {
  return isTokenCount(v) ? BigInt(typeof v === 'string' ? v.trim() : v) : 0n;
}

/** Whether `tokenCount` takes `v` as a count rather than rejecting it as 0. */
function isTokenCount(v) {
  if (typeof v === 'string') return /^\s*\d+\s*$/.test(v);
  if (typeof v === 'bigint') return v >= 0n;
  return Number.isSafeInteger(v) && v >= 0;
}

/** `usage`'s four kinds as counts (`tokenCount`), or null when `usage` is not a mapping. */
function countKinds(usage) {
  if (!isMapping(usage)) return null;
  return Object.fromEntries(TOKEN_KEYS.map((k) => [k, tokenCount(usage[k])]));
}

/** `usage`'s four kinds as counts, or null when none is above 0. */
function usageKinds(usage) {
  const out = countKinds(usage);
  return out && TOKEN_KEYS.some((k) => out[k] > 0n) ? out : null;
}

/** Add `kinds` into `map[step]`; an existing key keeps its place, a new one is appended. */
function addToStepMap(map, step, kinds) {
  const cur = isMapping(map[step]) ? map[step] : {};
  map[step] = Object.fromEntries(TOKEN_KEYS.map((k) => [k, String(tokenCount(cur[k]) + kinds[k])]));
}

/**
 * Add `usage` to `fm.tokens_by_step[step]`, creating the map and the entry as
 * needed. A usage with no kind above 0 writes nothing, so no key ever holds
 * four zeros. Returns whether it wrote.
 */
export function addStepUsageToFrontmatter(fm, step, usage) {
  const kinds = usageKinds(usage);
  if (!step || !kinds) return false;
  if (!isMapping(fm.tokens_by_step)) fm.tokens_by_step = {};
  addToStepMap(fm.tokens_by_step, step, kinds);
  return true;
}

/**
 * Two `tokens_by_step` maps summed key by key (the feature merge folds each
 * story's into the feature's): `into`'s keys first, in order, then `from`'s
 * new ones. Entries that are not mappings or hold nothing are dropped.
 */
export function mergeStepTokens(into, from) {
  const out = {};
  for (const map of [into, from]) {
    if (!isMapping(map)) continue;
    for (const [step, entry] of Object.entries(map)) {
      const kinds = usageKinds(entry);
      if (kinds) addToStepMap(out, step, kinds);
    }
  }
  return out;
}

/**
 * What a session added to a transcript total: per kind `after - before`
 * (a BigInt count), clamped at 0. Null when `after` is null or every kind
 * is 0.
 */
export function usageDelta(before, after) {
  const a = countKinds(after);
  if (!a) return null;
  const b = countKinds(before);
  const d = {};
  for (const k of TOKEN_KEYS) d[k] = a[k] > (b?.[k] ?? 0n) ? a[k] - (b?.[k] ?? 0n) : 0n;
  return TOKEN_KEYS.some((k) => d[k] > 0n) ? d : null;
}

/**
 * The provider's transcript totals for `unitId`'s sessions in one directory
 * (the unit directory a session started in, F-60 D3),
 * or null when the provider has none or does not track tokens (the same rule
 * as `collectStoryTokens`; any other error propagates).
 */
export function sessionTokens(provider, dir, unitId) {
  try {
    return provider.getTokens(dir, `${unitId}:`) ?? null;
  } catch (err) {
    if (/not implemented/.test(err?.message ?? '')) return null;
    throw err;
  }
}

/**
 * Add a headless session's usage to whatever totals a frontmatter already
 * carries. Unlike `applyTokensToFrontmatter` (which overwrites from a full
 * transcript re-read), headless results arrive one step at a time, so they
 * accumulate. They also accumulate into `tokens_headless_*`: headless
 * sessions leave no titled transcript, so a later re-read cannot see them
 * and `applyFeatureTokens` adds them back from there. With `step`, the same
 * usage goes into `tokens_by_step[step]` too, in the same write.
 */
export function addUsageToFrontmatter(fm, usage, step = null) {
  const kinds = countKinds(usage);
  if (!kinds) return;
  for (const k of TOKEN_KEYS) {
    fm[`tokens_${k}`] = String(tokenCount(fm[`tokens_${k}`]) + kinds[k]);
    fm[`tokens_headless_${k}`] = String(tokenCount(fm[`tokens_headless_${k}`]) + kinds[k]);
  }
  fm.tokens_updated = new Date().toISOString().slice(0, 10);
  if (step) addStepUsageToFrontmatter(fm, step, kinds);
}

/**
 * Feature totals after a transcript re-read: the titled (interactive)
 * sessions the re-read found plus the headless usage recorded as it
 * happened. Re-applying with the same transcripts gives the same totals.
 */
export function applyFeatureTokens(fm, transcriptTotals) {
  const totals = {};
  for (const k of TOKEN_KEYS)
    totals[k] = tokenCount(transcriptTotals?.[k] ?? 0) + tokenCount(fm[`tokens_headless_${k}`] ?? '0');
  applyTokensToFrontmatter(fm, totals);
}

/**
 * Add `fm`'s four `tokens_*` totals into `totals` as BigInt counts
 * (`tokenCount`): the `bl merge` fold of stories into their feature, so a sum
 * past 2^53 or 1e21 is exact. A total that is absent or not a count adds
 * nothing. Returns whether `fm` holds any total.
 * @param {Record<string, bigint>} totals the four kinds
 * @param {object} fm
 */
export function addTokenTotals(totals, fm) {
  let any = false;
  for (const k of TOKEN_KEYS) {
    const v = fm[`tokens_${k}`];
    if (typeof v !== 'string' || !/^\s*\d+\s*$/.test(v)) continue;
    totals[k] = (totals[k] ?? 0n) + tokenCount(v);
    any = true;
  }
  return any;
}

/**
 * `updateSpecFile` of `indexPath` with `update(fm)`, best-effort: false when
 * there is no file, nothing to write, or any failure (the lock, a file with
 * no `---` block, the write), which leaves the previous file whole.
 */
function updateTokensOnFile(backlogRoot, indexPath, update) {
  if (!indexPath || !existsSync(indexPath)) return false;
  try {
    return updateSpecFile(backlogRoot, indexPath, (fm) => (update(fm) === false ? false : undefined));
  } catch {
    return false;
  }
}

/**
 * Accumulate `usage` onto the frontmatter of `indexPath`, and with `step`
 * into `tokens_by_step[step]` in the same write. Best-effort.
 */
export function accumulateTokensOnFile(backlogRoot, indexPath, usage, step = null) {
  if (!usage) return false;
  return updateTokensOnFile(backlogRoot, indexPath, (fm) => addUsageToFrontmatter(fm, usage, step));
}

/**
 * Add an interactive session's transcript difference to `indexPath` in one
 * write: into `tokens_by_step[step]` and into the four `tokens_*` totals, so
 * the two agree however the session ended. A later transcript re-read
 * overwrites the totals with the same sum; `tokens_headless_*` is left alone,
 * since the transcript holds this session. Best-effort; false when there is
 * nothing to write.
 */
export function accumulateStepTokensOnFile(backlogRoot, indexPath, step, usage) {
  const kinds = usageKinds(usage);
  if (!step || !kinds) return false;
  return updateTokensOnFile(backlogRoot, indexPath, (fm) => {
    addStepUsageToFrontmatter(fm, step, kinds);
    for (const k of TOKEN_KEYS) fm[`tokens_${k}`] = String(tokenCount(fm[`tokens_${k}`]) + kinds[k]);
    fm.tokens_updated = new Date().toISOString().slice(0, 10);
  });
}

/**
 * Recompute totals and write them to the story's index.md frontmatter.
 * Best-effort: false on any failure (the transcripts, the lock, the file),
 * so an agent session never fails to exit cleanly because of bookkeeping.
 */
export function recordStoryTokens(storyId, config) {
  let indexPath;
  try {
    indexPath = reposForStory(storyId, config)[0]?.indexPath;
  } catch {
    return false;
  }
  // Under the spec lock, so a step entry another session adds meanwhile is
  // not overwritten with this read's copy. The transcripts are read under it
  // too: totals read before it could predate a session difference written
  // meanwhile, and would put the totals below the map.
  return updateTokensOnFile(config.backlogRoot, indexPath, (fm) => {
    const totals = collectStoryTokens(storyId, config);
    if (!totals) return false;
    applyTokensToFrontmatter(fm, totals);
  });
}
