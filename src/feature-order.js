/**
 * feature-order.js — the operator's preferred feature order (F-53 D1, B2).
 *
 * `backlog/feature-order.md` holds the order in its YAML frontmatter:
 *
 *   ranked:
 *     - feature: F-48
 *       why: Split from F-42; needs F-42's components.
 *
 * Its body is a hand-written intro, then `## Next up` and `## Not yet ranked`,
 * which `bl sync` writes from `ranked:` and the features' own frontmatter, and
 * `## History`, hand-written and appended to by `bl merge`. The order is a
 * preference: `depends_on` overrides it, and nothing here reads the roadmap.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from './atomic-write.js';
import { listValue, parseFrontmatterOf, serializeFrontmatter, warn } from './config.js';
import { appendSectionLine, normalizeFeatureId } from './feature.js';
import { featureEpicId } from './filter.js';
import { PriorityError, parseRanked as parsePriorityRanked } from './priority.js';

/** The file's name, at the backlog root. */
export const FEATURE_ORDER_FILE = 'feature-order.md';

export function featureOrderPath(config) {
  return join(config.backlogRoot, FEATURE_ORDER_FILE);
}

/**
 * A `ranked:` value that is not a list of mappings each with a non-empty
 * `feature` and `why`. `bl validate` no longer reads this file (F-78 D1
 * validates `priority.md`); `bl next` and `bl sync` stop on it until F-78
 * S-1264 removes the file.
 */
export class FeatureOrderError extends Error {
  constructor(reason) {
    super(`${FEATURE_ORDER_FILE}: ${reason}; run bl validate`);
    this.name = 'FeatureOrderError';
    this.reason = reason;
  }
}

/**
 * `ranked:` as entries `{ feature, why, position }`: `priority.md`'s shape
 * (`parseRanked` there) keyed `feature`, as written (`normalizeFeatureId`
 * makes it an id), `position` from 1. An absent or empty `ranked:` is an
 * empty order. Throws `FeatureOrderError` on any other shape.
 * @returns {Array<{ feature: string, why: string, position: number }>}
 */
export function parseRanked(raw) {
  try {
    return /** @type {any} */ (parsePriorityRanked(raw, 'feature', FEATURE_ORDER_FILE));
  } catch (e) {
    throw e instanceof PriorityError ? new FeatureOrderError(e.reason) : e;
  }
}

/**
 * Read `feature-order.md`, or null when it is missing. `fmText` is the
 * frontmatter block exactly as written, so a rewrite of the body keeps the
 * operator's comments and layout in `ranked:`. Throws `FrontmatterError`
 * when the block is not YAML and `FeatureOrderError` when `ranked:` has the
 * wrong shape.
 * @returns {{ ranked: Array<{ feature: string, why: string, position: number }>,
 *   fm: object, fmText: string, body: string, content: string, indexPath: string } | null}
 */
export function readFeatureOrder(config) {
  const indexPath = featureOrderPath(config);
  if (!existsSync(indexPath)) return null;
  const content = readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
  const { fm, body } = parseFrontmatterOf(content, indexPath);
  const fmText = content.slice(0, content.length - body.length);
  return { ranked: parseRanked(fm.ranked), fm, fmText, body, content, indexPath };
}

/** True when feature `f` passes the `theme` and `epic` filters that are set. */
function matches(f, filter) {
  if (filter.theme && f.theme !== filter.theme) return false;
  if (filter.epic && featureEpicId(f) !== filter.epic) return false;
  return true;
}

function featureNumber(f) {
  return parseInt(String(f.id).replace(/^F-/, ''), 10);
}

/**
 * The ranked features that exist, are not closed, and pass
 * `filter` (`theme`, `epic`), in rank order: `{ id, why, position, feature }`
 * with `feature` the feature record and `position` its place in `ranked:`.
 * A ranked id with no feature, a closed one or a repeat is skipped.
 * @param {{ ranked: object[] } | null} order  `readFeatureOrder` result
 * @param {object[]} features  feature records (`id`, `title`, `theme`, `epic`, `status`)
 * @param {{ theme?: string | null, epic?: string | null }} [filter]
 */
export function rankedFeatures(order, features, flow, filter = {}) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const seen = new Set();
  const out = [];
  for (const entry of order?.ranked ?? []) {
    const id = normalizeFeatureId(entry.feature)?.id;
    const f = id && byId.get(id);
    if (!f || flow.meets('feature', f.status, 'done') || seen.has(id)) continue;
    seen.add(id);
    if (matches(f, filter)) out.push({ id, why: entry.why, position: entry.position, feature: f });
  }
  return out;
}

/**
 * The features that are not closed and not in `ranked:`, and
 * pass `filter`, in id order.
 */
export function unrankedFeatures(order, features, flow, filter = {}) {
  const ranked = new Set((order?.ranked ?? []).map((e) => normalizeFeatureId(e.feature)?.id).filter(Boolean));
  return features
    .filter((f) => !flow.meets('feature', f.status, 'done') && !ranked.has(f.id) && matches(f, filter))
    .sort((a, b) => featureNumber(a) - featureNumber(b));
}

/**
 * `body` with `line` appended to the end of `## History`, which is created at
 * the end of the file when absent. A line already there is not added again.
 */
export function appendHistory(body, line) {
  return appendSectionLine(body, 'History', line);
}

/**
 * `bl merge F-<n>` (F-53 D1): drop the feature's entries from `ranked:` and
 * append `- <date>: F-<n> done (<title>).` to `## History`, replacing the
 * file atomically, so a failed write leaves it as it was. The caller holds the merge's mark-done backlog lock. A missing or
 * unreadable `feature-order.md` is a warning, never a failed merge: the repos
 * are merged by then.
 * @param {object} config
 * @param {{ id: string, title: string }} feature
 * @param {string} stamp  the merge date, `YYYY-MM-DD`
 * @returns {boolean} whether the file was written
 */
export function recordFeatureOrderMerge(config, feature, stamp) {
  let order;
  try {
    order = readFeatureOrder(config);
  } catch (e) {
    warn(`${FEATURE_ORDER_FILE} not updated for ${feature.id}: ${e.message}`);
    return false;
  }
  if (!order) {
    warn(`${FEATURE_ORDER_FILE} is missing, so ${feature.id} is not recorded in the feature order`);
    return false;
  }
  // `ranked` holds the reader's ids, one per raw entry: drop raw entries by
  // position, so every spelling the reader accepts is removed.
  const drop = new Set(
    order.ranked.filter((e) => normalizeFeatureId(e.feature)?.id === feature.id).map((e) => e.position - 1),
  );
  const fmText = drop.size
    ? serializeFrontmatter({ ...order.fm, ranked: listValue(order.fm.ranked).filter((_, i) => !drop.has(i)) })
    : order.fmText;
  const content = fmText + appendHistory(order.body, `- ${stamp}: ${feature.id} done (${feature.title}).`);
  if (content === order.content) return false;
  try {
    atomicWriteFile(config.backlogRoot, order.indexPath, content);
  } catch (e) {
    warn(`${FEATURE_ORDER_FILE} not updated for ${feature.id}: ${e.message}`);
    return false;
  }
  return true;
}
