/**
 * validate.js — backlog integrity checks.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import {
  loadConfig,
  configForRepo,
  dictionariesOf,
  parseArgs,
  parseFrontmatter,
  normalizeComponentId,
  FORGE_OPS,
  BODY_READING_OP,
} from './config.js';
import { DERIVED_KEYS, changeDoc, loadBacklog } from './backlog-graph.js';
import { readAllStories, readComponents, parseIdList, pathEntryProblem } from './story.js';
import { readAllFeatures, extractSection, sectionHasContent } from './feature.js';
import { readAllThemes, readAllEpics, normalizeEpicId, splitBriefEntry, THEME_ID_RE } from './theme.js';
import { findRoadmapFindings } from './roadmap.js';
import { extractReviewLog, parseLatestSession } from './review-log.js';
import { probePluginBinaries } from './plugin-binaries.js';
import { scanDeferred, DEFERRED_HEADING, RETIRED_SECTION } from './deferred.js';
import { CHANGE_STATUSES, RUN_STATE_KEYS, listChanges, unitIdOfDir } from './change-doc.js';
import { FLOW_FILE, findFlowFindings, loadFlow } from './flow.js';
import { findBlockersFindings, unitIndex } from './blockers.js';
import { findTaskFindings, readAllTasks } from './task.js';
import { implementPluginProblem } from './scripted.js';
import { GENERATED_SECTIONS, UNIT_PAGE_KINDS, generatedColumns, isGeneratedBody } from './render.js';
import { checkEffort, storyEffort } from './effort.js';

// ---------------------------------------------------------------------------
// Constants (reused by sync.js)
// ---------------------------------------------------------------------------

export const VALID_STORY_KEYS = new Set([
  'component',
  'story_id',
  'title',
  'type',
  'points',
  // The effort level the refiner chose (F-85 D1); `bad-effort` checks it.
  'effort',
  'status',
  'added',
  'completed',
  'commit',
  'parent',
  'superseded_by',
  // No `primary_repo` or `secondary_repos`: a story's repo is its
  // component's (F-52 D1); either one still set is `repo-key`.
  'plugins',
  'depends_on',
  // No `required_for`: the inverse of `depends_on` is derived (F-77 D3);
  // one still set is `derived-key`.
  'feature',
  // The unit whose work found a side story (`bl side --from`, F-48 D2): a
  // record only; `found-by` checks that it names a feature or story.
  'found_by',
  // A story run (`bl run S-<n>`) writes this, as `bl new` does for features.
  // The branch, PR and review state live in the change document (change.md).
  'review_rounds_max',
  // A scripted story's opt-in to `bl review` (F-71 D3).
  'review',
  'tokens_input',
  'tokens_output',
  'tokens_cache_creation',
  'tokens_cache_read',
  'tokens_updated',
  'tokens_headless_input',
  'tokens_headless_output',
  'tokens_headless_cache_creation',
  'tokens_headless_cache_read',
  'tokens_by_step',
  // A Renovate update story, written by `bl updates sync` (F-32 Design D3).
  'update_repo',
  'update_branch',
  'update_pr',
  'update_head',
  'update_security',
  // The operator's request on an update story, executed by the runner's
  // next `bl updates run` (F-50 D8).
  'update_request',
  'update_request_reason',
  // A vulns story, written by `bl updates vulns`, keyed by `update_repo` and
  // `update_lockfile` with no `update_branch` (F-71 D4). `update_dropped` is the
  // date of the operator's drop.
  'update_lockfile',
  'update_advisory',
  'update_dropped',
]);

export const VALID_REVIEW_STATUSES = new Set(['pending', 'fixed', 'addressed']);

/** The requests the operator can leave on an update story (F-50 D8). */
export const UPDATE_REQUESTS = ['approve', 'drop'];

/**
 * What is wrong with an update story's request state, or null: an
 * `update_request` is absent or one of `UPDATE_REQUESTS`; a drop carries a
 * non-empty string `update_request_reason`; nothing else carries one.
 * `bl validate`, `bl updates run` and `bl updates status` all refuse what
 * this names, so none treats a malformed request as absent or invents a
 * reason.
 * @param {object} fm
 * @returns {string | null}
 */
export function updateRequestProblem(fm) {
  const request = fm?.update_request;
  const reason = fm?.update_request_reason;
  if (request == null) {
    return reason == null ? null : 'update_request_reason without update_request: drop';
  }
  if (typeof request !== 'string' || !UPDATE_REQUESTS.includes(request.trim())) {
    return `update_request ${JSON.stringify(request)} is not one of ${UPDATE_REQUESTS.join(', ')}`;
  }
  if (request.trim() === 'drop') {
    return typeof reason === 'string' && reason.trim()
      ? null
      : 'update_request: drop without a non-empty update_request_reason';
  }
  return reason == null ? null : `update_request_reason on update_request: ${request.trim()}`;
}

export const VALID_FEATURE_KEYS = new Set([
  'feature_id',
  'title',
  'status',
  // No `primary_repo` or `secondary_repos`: a feature's repos come from its
  // stories' components (F-52 D3); either one still set is `repo-key`. No
  // `stories`, `points` or `components`: derived (`DERIVED_KEYS`), so one
  // still set is `derived-key`.
  // The value axis (F-51 D1): set by hand, checked by findValueAxisFindings.
  'theme',
  'epic',
  'review_rounds_max',
  'added',
  'approved',
  'completed',
  'commit',
  'plugins',
  'tokens_input',
  'tokens_output',
  'tokens_cache_creation',
  'tokens_cache_read',
  'tokens_updated',
  'tokens_headless_input',
  'tokens_headless_output',
  'tokens_headless_cache_creation',
  'tokens_headless_cache_read',
  'tokens_by_step',
]);

// Titles that describe a verification step rather than a change. Verification
// is an acceptance criterion of the story that made the change, not a story.
export const VERIFICATION_TITLE_RE = /^(confirm|verify|re-?verify|re-?run|manually verify|double-?check)\b/i;

/**
 * A component's keys (F-49 D4): a code boundary in one repo, a label with no
 * status, points or completion.
 */
export const VALID_COMPONENT_KEYS = new Set(['component_id', 'title', 'repo', 'home', 'plugins', 'paths']);

/** The retired repo keys of a story or feature (F-52 D5): `repo-key`. */
export const REPO_KEYS = ['primary_repo', 'secondary_repos'];

/** Keys a component must not carry: it is never planned or finished. */
const COMPONENT_STATUS_KEYS = ['points', 'status'];

/**
 * A theme's keys (F-51 D1): a value area that never finishes. `repos` lists
 * the repos whose standalone stories belong to it (`[]` for a product theme);
 * `brief` the documents an agent reads before working in it (F-53 D4).
 */
export const VALID_THEME_KEYS = new Set(['theme_id', 'title', 'repos', 'brief']);

/**
 * A value epic's keys (F-51 D1): an outcome under one theme. Its features
 * and status are derived (`DERIVED_KEYS`), so either key still set is
 * `derived-key`.
 */
export const VALID_EPIC_KEYS = new Set(['epic_id', 'title', 'theme']);

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   severity: "error" | "warning",
 *   code: string,
 *   message: string,
 *   location: string,
 *   line?: number
 * }} Finding
 */

const TOKENS_STEP_KEY_RE = /^[a-z][a-z-]*(\.[1-9]\d*)?$/;
const TOKEN_KINDS = new Set(['input', 'output', 'cache_creation', 'cache_read']);

/**
 * What is wrong with a `tokens_by_step` value: not a mapping, a key that is
 * not `<step>[.<round>]`, or an entry that is not a mapping of the four token
 * kinds to non-negative integers. Empty when it is well-formed.
 */
export function tokensByStepProblems(map) {
  if (map == null || typeof map !== 'object' || Array.isArray(map))
    return ['is not a mapping of steps to token counts'];
  const problems = [];
  for (const [key, entry] of Object.entries(map)) {
    if (!TOKENS_STEP_KEY_RE.test(key)) problems.push(`key "${key}" is not <step>[.<round>]`);
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`"${key}" is not a mapping of token kinds to counts`);
      continue;
    }
    for (const [kind, value] of Object.entries(entry)) {
      if (!TOKEN_KINDS.has(kind)) problems.push(`"${key}" has unknown kind "${kind}"`);
      else if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        problems.push(`"${key}.${kind}" is not a non-negative integer`);
      }
    }
  }
  return problems;
}

/**
 * @param {any} fm
 * @param {"story" | "component" | "feature" | "theme" | "epic"} kind
 * @param {string} location
 * @param {{ dirName?: string, knownRepos?: Set<string>, componentId?: string, unitRepo?: string,
 *   flow?: import("./flow.js").Flow }} context
 *   `componentId` and `unitRepo`: a story's component and its repo
 *   (`placeStory`), which `repo-key` names. `flow`: the backlog's
 *   `flow.json` (`loadFlow`), where a story's and a feature's statuses come
 *   from (F-66 D1); without it their status is not checked.
 * @returns {Finding[]}
 */
export function validateFrontmatter(fm, kind, location, context = {}) {
  const findings = [];
  const KINDS = {
    // A story's `component:` is checked by findComponentFindings
    // (`component-unknown`), not as a required key.
    story: {
      required: ['story_id', 'title', 'status'],
      validKeys: VALID_STORY_KEYS,
      idKey: 'story_id',
      idRegex: /^S-\d+$/,
      statuses: context.flow ? new Set(context.flow.statusesOf('story')) : null,
    },
    // `points` and `status` are `component-has-status` (findComponentFindings).
    component: {
      required: ['component_id', 'title', 'repo'],
      validKeys: new Set([...VALID_COMPONENT_KEYS, ...COMPONENT_STATUS_KEYS]),
      idKey: 'component_id',
      idRegex: /^C\d+$/,
      statuses: null,
    },
    feature: {
      required: ['feature_id', 'title', 'status'],
      validKeys: VALID_FEATURE_KEYS,
      idKey: 'feature_id',
      idRegex: /^F-\d+$/,
      statuses: context.flow ? new Set(context.flow.statusesOf('feature')) : null,
    },
    // `repos` is `theme-repo` (findValueAxisFindings); `brief` is
    // `theme-brief` (findThemeBriefFindings).
    theme: {
      required: ['theme_id', 'title'],
      validKeys: VALID_THEME_KEYS,
      idKey: 'theme_id',
      idRegex: THEME_ID_RE,
      statuses: null,
    },
    // `theme` is `epic-theme` (findValueAxisFindings). Epics are E50 upward;
    // an epic's status is derived, so none is checked here.
    epic: {
      required: ['epic_id', 'title'],
      validKeys: VALID_EPIC_KEYS,
      idKey: 'epic_id',
      idRegex: /^E(?:[5-9]\d|[1-9]\d{2,})$/,
      statuses: null,
    },
  };
  const { required, validKeys, idKey, idRegex, statuses } = KINDS[kind];

  // missing-required-key
  for (const key of required) {
    if (!fm[key]) {
      findings.push({
        severity: 'error',
        code: 'missing-required-key',
        message: `${kind} missing required key "${key}"`,
        location,
      });
    }
  }

  // repo-key (F-52 D5): a story or feature that still names a repo. bl reads
  // neither key, so the file works; F-52's migration stripped them.
  if (kind === 'story' || kind === 'feature') {
    for (const key of REPO_KEYS.filter((k) => Object.hasOwn(fm, k))) {
      const why =
        kind === 'story'
          ? `a story's repo is its component's repo (${context.componentId || 'no component'}: ${context.unitRepo || 'no repo'})`
          : "a feature's repos come from its stories' components";
      findings.push({
        severity: 'error',
        code: 'repo-key',
        message: `${kind} sets "${key}", which bl does not read: ${why}; remove it`,
        location,
      });
    }
  }

  // derived-key (F-77 D3): a key the graph derives, stored in the file.
  const derived = DERIVED_KEYS[kind] ?? {};
  for (const key of Object.keys(fm)) {
    if (!Object.hasOwn(derived, key)) continue;
    findings.push({
      severity: 'error',
      code: 'derived-key',
      message: `${kind} stores "${key}:", which bl derives from ${derived[key]} and never reads; remove it (scripts/migrate-derived-keys.js removes every one)`,
      location,
    });
  }

  // unknown-fm-key. A run-state key (branch, pr, review_round,
  // review_status) is findRunStateInSpec's error instead, a retired
  // repo key is `repo-key` and a derived key `derived-key`.
  for (const key of Object.keys(fm)) {
    if ((kind === 'story' || kind === 'feature') && REPO_KEYS.includes(key)) continue;
    if (Object.hasOwn(derived, key)) continue;
    if (!validKeys.has(key) && !key.startsWith('plugins-') && !RUN_STATE_KEYS.includes(key)) {
      findings.push({
        severity: 'warning',
        code: 'unknown-fm-key',
        message: `unknown frontmatter key "${key}"`,
        location,
      });
    }
  }

  // bad-tokens-by-step (S-904): the per-step token map bl writes.
  if ((kind === 'story' || kind === 'feature') && Object.hasOwn(fm, 'tokens_by_step')) {
    for (const problem of tokensByStepProblems(fm.tokens_by_step)) {
      findings.push({ severity: 'error', code: 'bad-tokens-by-step', message: `tokens_by_step ${problem}`, location });
    }
  }

  // bad-status: a story's and a feature's statuses are flow.json's.
  if (statuses && fm.status && !statuses.has(fm.status)) {
    const known = kind === 'story' || kind === 'feature' ? ` (${FLOW_FILE} ${kind} statuses)` : '';
    findings.push({
      severity: 'error',
      code: 'bad-status',
      message: `status "${fm.status}" not in known set${known}`,
      location,
    });
  }

  // bad-update-request
  const requestProblem = kind === 'story' ? updateRequestProblem(fm) : null;
  if (requestProblem) {
    findings.push({
      severity: 'error',
      code: 'bad-update-request',
      message: requestProblem,
      location,
    });
  }

  // bad-review-status
  if ((kind === 'story' || kind === 'feature') && fm.review_status && !VALID_REVIEW_STATUSES.has(fm.review_status)) {
    findings.push({
      severity: 'error',
      code: 'bad-review-status',
      message: `review_status "${fm.review_status}" not in known set`,
      location,
    });
  }

  // bad-points: a story's must be a positive integer estimate. A feature's
  // are derived (`derived-key`).
  if (kind === 'story' && fm.points !== undefined && fm.points !== null && fm.points !== '') {
    const pts = Number(fm.points);
    if (!Number.isInteger(pts) || pts < 1) {
      findings.push({
        severity: 'error',
        code: 'bad-points',
        message: `points "${fm.points}" is not a positive integer`,
        location,
      });
    }
  }

  // bad-effort: a story's must be one of the effort levels (F-85 D1); an
  // empty one runs at `effort.default`.
  if (kind === 'story' && storyEffort(fm) !== null) {
    try {
      checkEffort(storyEffort(fm), 'effort');
    } catch (err) {
      findings.push({ severity: 'error', code: 'bad-effort', message: err.message, location });
    }
  }

  // bad-id-format
  if (fm[idKey] && !idRegex.test(fm[idKey])) {
    findings.push({
      severity: 'error',
      code: 'bad-id-format',
      message: `${idKey} "${fm[idKey]}" has invalid format`,
      location,
    });
  }

  // bad-commit: accept string or plain object {<repo-name>: <sha-string>}.
  // For map form, every key must be a known repo (when a knownRepos set was
  // threaded in by the caller) and every value must be a string. Unknown
  // values (arrays, numbers, nulls inside the map) all fold into bad-commit.
  if (kind === 'story' && fm.commit !== undefined && fm.commit !== null && fm.commit !== '') {
    const commit = fm.commit;
    if (typeof commit === 'string') {
      // scalar — always accepted
    } else if (
      typeof commit === 'object' &&
      !Array.isArray(commit) &&
      Object.getPrototypeOf(commit) === Object.prototype
    ) {
      for (const [repo, sha] of Object.entries(commit)) {
        if (typeof sha !== 'string') {
          findings.push({
            severity: 'error',
            code: 'bad-commit',
            message: `commit map entry "${repo}" has non-string value`,
            location,
          });
        }
        if (context.knownRepos && !context.knownRepos.has(repo)) {
          findings.push({
            severity: 'error',
            code: 'bad-commit',
            message: `commit map references unknown repo "${repo}"`,
            location,
          });
        }
      }
    } else {
      findings.push({
        severity: 'error',
        code: 'bad-commit',
        message: `commit must be a string or a map of <repo>: <sha>`,
        location,
      });
    }
  }

  // id-dir-mismatch. A theme's directory is its id; a slug may hold hyphens.
  if (fm[idKey] && context.dirName) {
    const expectedPrefix = String(fm[idKey]).replace('-', '');
    const matches =
      kind === 'theme'
        ? context.dirName === String(fm[idKey])
        : context.dirName === expectedPrefix || context.dirName.startsWith(expectedPrefix + '-');
    if (!matches) {
      findings.push({
        severity: 'error',
        code: 'id-dir-mismatch',
        message: `${idKey} "${fm[idKey]}" does not match directory name "${context.dirName}"`,
        location,
      });
    }
  }

  return findings;
}

/**
 * `run-state-in-spec` (error): an `index.md` carrying what the change
 * document holds since F-42 — a `branch:`, `pr:`, `review_round:` or
 * `review_status:` key, or a `## Review Log` section. The message names the
 * key; `location` is the file.
 *
 * @param {any} fm
 * @param {string} body
 * @param {string} location
 * @returns {Finding[]}
 */
export function findRunStateInSpec(fm, body, location) {
  const findings = [];
  for (const key of RUN_STATE_KEYS) {
    if (!Object.hasOwn(fm, key)) continue;
    findings.push({
      severity: 'error',
      code: 'run-state-in-spec',
      message: `"${key}:" belongs in the unit's change.md, not its index.md`,
      location,
    });
  }
  if (extractReviewLog(body ?? '') != null) {
    findings.push({
      severity: 'error',
      code: 'run-state-in-spec',
      message: `"## Review Log" belongs in the unit's change.md, not its index.md`,
      location,
    });
  }
  return findings;
}

/**
 * Every change document of the unit in `unitDir`, checked: its frontmatter
 * (`change-of-mismatch` when `change_of` does not name the unit the
 * directory holds, `change-repo-incomplete` for a `repos:` entry without
 * `repo` or `branch`, `bad-change-status`, `bad-review-status`), then its
 * Review Log against its `review_status` (validateReviewLog). Locations are
 * backlog-relative. A unit whose change document is not YAML is not in the
 * tolerant graph, so this is never called for it.
 *
 * @param {string} backlogRoot
 * @param {string} unitDir
 * @returns {Finding[]}
 */
export function validateChanges(backlogRoot, unitDir) {
  const findings = [];
  const unitId = unitIdOfDir(unitDir);
  for (const { path } of listChanges(unitDir)) {
    const location = relative(backlogRoot, path);
    // The text the tolerant graph read, unless the file changed since (`changeDoc`).
    const doc = changeDoc(backlogRoot, path);
    const fm = doc.fm;
    if (fm.change_of !== unitId) {
      findings.push({
        severity: 'error',
        code: 'change-of-mismatch',
        message: `"change_of:" is ${fm.change_of ? `"${fm.change_of}"` : 'missing'} but the directory holds ${unitId ?? 'no unit'}`,
        location,
      });
    }
    doc.repos.forEach((r, i) => {
      for (const key of ['repo', 'branch']) {
        if (r[key]) continue;
        findings.push({
          severity: 'error',
          code: 'change-repo-incomplete',
          message: `"repos:" entry ${i + 1}${r.repo ? ` (${r.repo})` : ''} has no "${key}:"`,
          location,
        });
      }
    });
    if (fm.status && !CHANGE_STATUSES.has(fm.status)) {
      findings.push({
        severity: 'error',
        code: 'bad-change-status',
        message: `"status:" "${fm.status}" not in known set (${[...CHANGE_STATUSES].join(', ')})`,
        location,
      });
    }
    if (fm.review_status && !VALID_REVIEW_STATUSES.has(fm.review_status)) {
      findings.push({
        severity: 'error',
        code: 'bad-review-status',
        message: `"review_status:" "${fm.review_status}" not in known set`,
        location,
      });
    }
    findings.push(...validateReviewLog(fm, doc.body, location));
  }
  return findings;
}

/**
 * Cross-check a change document's `review_status` frontmatter against its
 * `## Review Log` section. Two integrity errors fire here:
 *
 *   - `review_status: pending` or `fixed` but no `## Review Log` section,
 *     OR no `### Session` block inside it. The reviewer always writes a
 *     session when it flips to pending (and `fixed` only ever follows
 *     pending), so a missing log means the field was hand-edited or the
 *     session was deleted.
 *   - `review_status: fixed` or `addressed` but the latest session still
 *     has unchecked items. Means the agent set the frontmatter without
 *     actually checking the items off — or someone reverted the checks
 *     after committing.
 *
 * @param {any} fm
 * @param {string} body
 * @param {string} location
 * @returns {Finding[]}
 */
export function validateReviewLog(fm, body, location) {
  const findings = [];
  const status = fm.review_status;
  if (!status) return findings;

  const log = extractReviewLog(body);
  const latest = log ? parseLatestSession(log) : null;

  if (status === 'pending' || status === 'fixed') {
    if (!latest) {
      findings.push({
        severity: 'error',
        code: 'review-log-missing',
        message: `review_status: ${status} but no ## Review Log session is present`,
        location,
      });
    }
  }
  if (status === 'fixed' || status === 'addressed') {
    if (latest && latest.unchecked > 0) {
      findings.push({
        severity: 'error',
        code: 'review-log-unaddressed',
        message: `review_status: ${status} but latest session (${latest.date}) has ${latest.unchecked} unchecked item${latest.unchecked === 1 ? '' : 's'}`,
        location,
      });
    }
  }

  return findings;
}

/**
 * @param {Map<string, any>} storyMap
 * @returns {Finding[]}
 */
export function findCycles(storyMap) {
  const findings = [];
  const visited = new Set(); // black
  const recStack = new Set(); // grey
  const byId = storyMap;

  // A story's edges are its depends_on (the inverse is derived, F-77 D3).
  for (const startId of storyMap.keys()) {
    if (visited.has(startId)) continue;

    const stack = [[startId, 0]]; // [id, edgeIndex]
    const path = [];

    while (stack.length > 0) {
      const [id, edgeIndex] = stack[stack.length - 1];

      if (edgeIndex === 0) {
        if (recStack.has(id)) {
          const cyclePath = path.slice(path.indexOf(id));
          cyclePath.push(id);
          findings.push({
            severity: 'error',
            code: 'cycle',
            message: `cycle detected: ${cyclePath.join(' → ')}`,
            location: byId.get(id)?.storyRelPath || 'unknown',
          });
          stack.pop();
          continue;
        }
        if (visited.has(id)) {
          stack.pop();
          continue;
        }
        recStack.add(id);
        path.push(id);
      }

      const story = byId.get(id);
      const deps = story ? parseIdList(story.depends_on) : [];

      if (edgeIndex < deps.length) {
        stack[stack.length - 1][1]++;
        stack.push([deps[edgeIndex], 0]);
      } else {
        visited.add(id);
        recStack.delete(id);
        path.pop();
        stack.pop();
      }
    }
  }
  return findings;
}

/**
 * Story records sharing an id, for `bl sync`, which refuses to regenerate
 * over them (`bl validate` takes them from the graph, `findDuplicateFindings`).
 * @param {any[] | Map<string, any>} stories
 * @returns {Finding[]}
 */
export function findDuplicateIds(stories) {
  const list = stories instanceof Map ? [...stories.values()] : stories;
  const byId = new Map();
  for (const s of list) {
    const matches = byId.get(s.id) ?? [];
    matches.push(s);
    byId.set(s.id, matches);
  }
  const findings = [];
  for (const [id, matches] of byId) {
    if (matches.length > 1) {
      findings.push(
        storyDuplicateFinding(
          id,
          matches.map((m) => ({ relPath: m.storyRelPath || m.indexPath || 'unknown', title: m.title })),
        ),
      );
    }
  }
  return findings;
}

/**
 * The `duplicate-id` finding for story `id`, at its first copy, listing
 * every copy with its title.
 * @param {string} id
 * @param {Array<{ relPath: string, title: string }>} copies
 * @returns {Finding}
 */
function storyDuplicateFinding(id, copies) {
  return {
    severity: 'error',
    code: 'duplicate-id',
    message:
      `duplicate story ID ${id} across ${copies.length} files:\n` +
      copies.map((m, i) => `    ${i + 1}: ${m.relPath} — "${m.title}"`).join('\n'),
    location: copies[0].relPath,
  };
}

/** Feature statuses in which a non-empty `## Escalation` blocks the next step. */
const ESCALATION_GATED_STATUSES = new Set(['refined', 'approved', 'running']);

/**
 * `escalation-not-none` (warning): a refined, approved or running feature
 * whose `## Escalation` holds anything but `None.`. `bl approve` and
 * `bl run` both refuse such a feature, so a decision the operator
 * already made (left as a "resolved" note) would stall the loop. Escalated
 * features are exempt: their open escalation is expected.
 *
 * @param {{ id: string, status: string, body: string, featureRelPath: string }} f
 * @returns {Finding[]}
 */
export function findEscalationNotNone(f) {
  if (!ESCALATION_GATED_STATUSES.has(f.status)) return [];
  const escalation = extractSection(f.body ?? '', 'Escalation');
  if (!sectionHasContent(escalation)) return [];
  const first = escalation.trim().split('\n')[0];
  return [
    {
      severity: 'warning',
      code: 'escalation-not-none',
      message: `feature ${f.id} is ${f.status} but ## Escalation is not "None." ("${first}") — record the decision in the Design (or the Review Log) and set ## Escalation to "None."`,
      location: f.featureRelPath,
    },
  ];
}

/**
 * The rules of a unit's `## Deferred` (F-65 D4, F-82 D9), on a unit that is
 * not closed (a closed unit's section is history and keeps its notes,
 * operator items and old heading as written). One finding per line:
 *
 *   - `deferred-heading-retired` (error)  a story's `## To Do` heading:
 *     the section's old name in stories, renamed by
 *     `scripts/migrate-deferred-heading.js`.
 *   - `deferred-duplicate` (error)  a `## Deferred` heading after the
 *     first: readers take the first section only.
 *   - `operator-tasks-retired` (error)  a `### Operator tasks` sub-heading
 *     or an `operator:` bullet: the operator's work is a task (`bl task`).
 *   - `deferred-unsized` (error)  any other top-level item without a numeric
 *     `[points: N]`: the section holds sized follow-up code work only, and
 *     a record or hand-off goes under `## Notes`.
 *
 * @param {string} id  the unit's id
 * @param {string|undefined} status
 * @param {string} text  the whole file (its line numbers are the file's)
 * @param {string} location
 * @param {import("./flow.js").Flow} flow
 * @param {string} type  the flow type: `story` or `feature`
 * @returns {Finding[]}
 */
export function findDeferredErrors(id, status, text, location, flow, type) {
  // A closed unit's body is history: the Deferred rules do not run on it.
  if (flow.meets(type, status, 'done')) return [];
  const { items, retired, retiredSection, duplicates } = scanDeferred(text);
  const finding = (code, line, message, heading = DEFERRED_HEADING) => ({
    severity: 'error',
    code,
    message: `${id}: line ${line} (## ${heading}): ${message}`,
    location,
    line,
  });
  const retiredMessage = `operator tasks are retired: file each one with "bl task ${id} --title <t> --gate <merge|next|none>" and remove it here`;
  const out = retired.map((line) => finding('operator-tasks-retired', line, `### Operator tasks: ${retiredMessage}`));
  // `## To Do` was a story's heading only, and the migration renames it in stories only.
  for (const line of type === 'story' ? retiredSection : []) {
    out.push(
      finding(
        'deferred-heading-retired',
        line,
        `the heading is retired: follow-up code work goes under ## ${DEFERRED_HEADING}; run "node <bl>/scripts/migrate-deferred-heading.js" in the backlog to rename it in every story`,
        RETIRED_SECTION,
      ),
    );
  }
  // Readers take the first section only: a second one hides its items.
  for (const line of duplicates) {
    out.push(finding('deferred-duplicate', line, `a second ## ${DEFERRED_HEADING}: move its items into the first one`));
  }
  for (const item of items) {
    if (item.operator) {
      out.push(finding('operator-tasks-retired', item.line, `"${item.text}": ${retiredMessage}`));
    } else if (!item.sized) {
      out.push(
        finding(
          'deferred-unsized',
          item.line,
          `"${item.text}" has no [points: N]: size follow-up code work, move a record or hand-off under ## Notes, and file what the operator must do with bl task`,
        ),
      );
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * A feature's stories are the stories whose `feature:` names it (F-77 D3),
 * so there is nothing to cross-check; what is left:
 *
 *   - `feature-no-stories`     (warning) approved/running feature with no stories
 *
 * A feature that still names a repo is validateFrontmatter's `repo-key`, one
 * that stores `stories:` its `derived-key`; a story naming a feature that
 * does not exist is the graph's `dangling-feature` (`findDanglingFindings`).
 *
 * @param {Array} features — readAllFeatures records
 * @returns {Finding[]}
 */
export function findFeatureFindings(features) {
  const findings = [];
  for (const f of features) {
    if (f.stories.length === 0 && (f.status === 'approved' || f.status === 'running' || f.status === 'escalated')) {
      findings.push({
        severity: 'warning',
        code: 'feature-no-stories',
        message: `feature ${f.id} is ${f.status} but has no stories`,
        location: f.featureRelPath,
      });
    }
  }
  return findings;
}

/**
 * `found-by` (error, F-48 D2): a story's `found_by:` names no existing
 * feature or story. An unset or empty key is not a finding.
 *
 * @param {Array} features — readAllFeatures records
 * @param {Map<string, any>} storyMap
 * @returns {Finding[]}
 */
export function findFoundByFindings(features, storyMap) {
  const featureIds = new Set(features.map((f) => f.id));
  const findings = [];
  for (const s of storyMap.values()) {
    const raw = typeof s.found_by === 'string' ? s.found_by.trim() : s.found_by;
    if (raw === '' || raw == null) continue;
    const id = typeof raw === 'string' ? raw : '';
    const known = /^S-\d+$/.test(id) ? storyMap.has(id) : /^F-\d+$/.test(id) && featureIds.has(id);
    if (known) continue;
    findings.push({
      severity: 'error',
      code: 'found-by',
      message: `story ${s.id} has found_by: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}, which names no feature (F-<n>) or story (S-<n>)`,
      location: s.storyRelPath,
    });
  }
  return findings;
}

/**
 * A scripted story (F-71 D3) names exactly one plugin with an `implement`
 * command in its repo's plugin registry (`implementPluginProblem`), and
 * `review` is a boolean, so `review: "yes"` cannot read as absent.
 *
 * @param {Iterable<any>} stories story records
 * @param {any} config
 * @returns {Finding[]}
 */
export function findImplementPluginFindings(stories, config) {
  const findings = [];
  for (const s of stories) {
    const location = s.storyRelPath;
    const problem = implementPluginProblem(s, configForRepo(config, s.unitRepo).plugins);
    if (problem) {
      findings.push({ severity: 'error', code: 'implement-plugin', message: `story ${s.id}: ${problem}`, location });
    }
    if (s.review != null && !['true', 'false'].includes(String(s.review))) {
      findings.push({
        severity: 'error',
        code: 'implement-plugin',
        message: `story ${s.id}: review must be true or false, not ${JSON.stringify(s.review)}`,
        location,
      });
    }
  }
  return findings;
}

/**
 * Warn on active stories whose title reads like a verification step
 * ("Confirm …", "Verify …", "Re-run …"). Verification belongs in the
 * acceptance criteria of the story that made the change. Only backlog and
 * refined stories fire so history isn't relitigated; suppress with
 * `--skip verification-only-title`.
 *
 * @param {Iterable<any>} stories
 * @param {import("./flow.js").Flow} flow
 * @returns {Finding[]}
 */
export function findVerificationOnlyTitles(stories, flow) {
  const findings = [];
  for (const s of stories) {
    if (!flow.isUnstarted('story', s.status)) continue;
    if (!VERIFICATION_TITLE_RE.test(s.title ?? '')) continue;
    findings.push({
      severity: 'warning',
      code: 'verification-only-title',
      message: `story ${s.id} "${s.title}" reads like a verification step — make it an acceptance criterion of the story it verifies`,
      location: s.storyRelPath,
    });
  }
  return findings;
}

/**
 * Emit a `plugin-binary` warning finding for every plugin entry whose
 * first-token isn't on PATH. Entries with an empty command or unparseable
 * leader (`present === null`) are skipped — they're SKIP territory, not
 * MISSING, so they don't deserve a CI signal.
 *
 * Schema bump: findings of `code: "plugin-binary"` carry three extra
 * sub-fields on top of the standard `{severity, code, message, location}`:
 *   - `plugin`  : plugin key from `config.plugins`
 *   - `stages`  : array of stage / op names within that plugin that resolve
 *                 to the same first-token
 *   - `command` : the resolved first-token (e.g. `gofmt`, `shellcheck`)
 * Keep these in lockstep with `formatHuman` / `formatJson` below — the
 * JSON output is the documented schema consumers gate on.
 *
 * @param {any} config
 * @returns {Finding[]}
 */
export function findMissingPluginBinaries(config) {
  const findings = [];
  for (const e of probePluginBinaries(config)) {
    if (e.present !== false) continue;
    findings.push({
      severity: 'warning',
      code: 'plugin-binary',
      message: `plugin "${e.plugin}" command "${e.firstToken}" not found on PATH (stages: ${e.stages.join(', ')})`,
      location: 'backlog.json',
      plugin: e.plugin,
      stages: e.stages.slice(),
      command: e.firstToken,
    });
  }
  return findings;
}

/**
 * The `agent` and `review_agent` configuration lists (F-64 D2), at the top
 * level and under each repo's overrides: the error `loadConfig` would throw,
 * the retired shape (a string, `agent_model`, `fallback_model`) included,
 * as one `agent-config` finding each. Needs a config loaded with
 * `lenientAgents`, which records the error instead of throwing it.
 *
 * @param {any} config
 * @returns {Finding[]}
 */
export function findAgentConfigFindings(config) {
  const messages = new Set();
  if (config?.agentConfigError) messages.add(config.agentConfigError);
  for (const r of Object.values(config?.repos ?? {})) {
    if (!r.overrides) continue;
    // A repo that sets none of the keys inherits the top level's error.
    const own = ['agent', 'review_agent', 'agent_model', 'fallback_model'].some((k) => Object.hasOwn(r.overrides, k));
    if (config.agentConfigError && !own) continue;
    const error = configForRepo(config, r.name).agentConfigError;
    if (error) messages.add(error);
  }
  return [...messages].map((message) => ({
    severity: 'error',
    code: 'agent-config',
    message,
    location: 'backlog.json',
  }));
}

/** A forge command that reads a PR's body or comments. */
const READS_PR_BODY = [/--json[ =]\S*\b(body|comments)\b/, /\bcomments\b/, /\bgh\s+pr\s+view\b/];

/**
 * The forge plugin against F-42 D4: `forge` names a plugin of the top-level
 * `backlog.json`, the plugin holds exactly the ops of `FORGE_OPS`, each a
 * command string, and no op
 * but `update.notes` reads a PR body or comments (`--json body`,
 * `comments`, `gh pr view`): the PR is a projection of the change document,
 * and bl never reads review content back from the forge. No `forge` key
 * (`forge: none`) has nothing to check.
 *
 * @param {any} config
 * @returns {Finding[]}
 */
export function findForgeFindings(config) {
  const top = config?.topLevel ?? config?.raw ?? {};
  const forge = top.forge;
  if (forge == null) return [];
  const err = (code, message) => ({ severity: 'error', code, message, location: 'backlog.json' });
  if (typeof forge !== 'string' || !forge) {
    return [err('forge-plugin', `"forge" must name a plugin (e.g. "github"); got ${JSON.stringify(forge)}`)];
  }
  const plugin = top.plugins?.[forge];
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
    return [err('forge-plugin', `"forge": "${forge}" names no plugin in "plugins"`)];
  }
  const known = Object.keys(FORGE_OPS);
  const findings = [];
  for (const [op, cmd] of Object.entries(plugin)) {
    if (!Object.hasOwn(FORGE_OPS, op)) {
      findings.push(err('forge-op', `plugins.${forge}: "${op}" is not a forge op; the ops are ${known.join(', ')}`));
      continue;
    }
    if (typeof cmd !== 'string' || !cmd.trim()) {
      findings.push(err('forge-op', `plugins.${forge}: "${op}" must be a command string`));
      continue;
    }
    if (op !== BODY_READING_OP && READS_PR_BODY.some((re) => re.test(cmd))) {
      findings.push(
        err(
          'forge-op-reads-body',
          `plugins.${forge}: "${op}" reads a PR body or comments; only ${BODY_READING_OP} may`,
        ),
      );
    }
  }
  for (const op of known) {
    if (!Object.hasOwn(plugin, op))
      findings.push(err('forge-op', `plugins.${forge}: "${op}" is missing; the ops are ${known.join(', ')}`));
  }
  return findings;
}

/**
 * The component checks of F-49 D4:
 *
 *   - `component-unknown` (error): a story with no `component:`, or one that
 *     names a component with no directory under `components/`.
 *   - `home-component` (error): a registered repo with no component marked
 *     `home: true`, or with several; a component whose `repo` is not
 *     registered in backlog.json.
 *   - `component-has-status` (error): `points` or `status` on a component.
 *   - `component-paths` (error, F-52 D4, F-61 D2): a `paths:` entry that is
 *     not a non-empty relative glob (absolute, or with a `..` or `.` segment).
 *     `paths:` itself is optional: a map for people and agents, absent or
 *     empty when nobody has drawn it.
 *
 * Two component directories with one id are the graph's `duplicate-id`
 * (`findDuplicateFindings`).
 *
 * @param {Array<object>} stories  readAllStories records, each with its frontmatter as `fm`
 * @param {Array<object>} components  readComponents records
 * @param {Iterable<string>} registeredRepos  repo names from backlog.json
 * @param {string} backlogRoot
 * @returns {Finding[]}
 */
export function findComponentFindings(stories, components, registeredRepos, backlogRoot) {
  const findings = [];
  const err = (code, message, location) => findings.push({ severity: 'error', code, message, location });
  const registered = new Set(registeredRepos);
  const rel = (path) => relative(backlogRoot, path);
  // The first directory claiming an id wins, as in every reader (the graph's
  // `components`); the others are the graph's `duplicate-id`.
  const byId = new Map();
  for (const c of components) if (!byId.has(c.id)) byId.set(c.id, c);

  for (const s of stories) {
    const raw = s.fm.component;
    if (raw == null || raw === '') {
      err('component-unknown', `${s.id} has no "component:"`, s.storyRelPath);
      continue;
    }
    const component = byId.get(normalizeComponentId(raw)?.id);
    if (!component) {
      err(
        'component-unknown',
        `${s.id} names component "${raw}", which has no components/${normalizeComponentId(raw)?.id ?? raw}-*/index.md`,
        s.storyRelPath,
      );
    }
  }

  const homes = new Map([...registered].map((r) => [r, []]));
  for (const c of components) {
    const location = rel(c.indexPath);
    for (const key of COMPONENT_STATUS_KEYS) {
      if (Object.hasOwn(c.fm, key)) {
        err('component-has-status', `${c.id} has "${key}:"; a component has no status or points`, location);
      }
    }
    for (const glob of c.paths ?? []) {
      const problem = pathEntryProblem(glob);
      if (problem)
        err(
          'component-paths',
          `${c.id} path "${glob}" ${problem}; an entry is a glob relative to the repo root`,
          location,
        );
    }
    if (c.repo && !registered.has(c.repo)) {
      err('home-component', `${c.id} is in repo "${c.repo}", which backlog.json does not register`, location);
    }
    if (c.home && homes.has(c.repo)) homes.get(c.repo).push(c);
  }
  for (const [repo, list] of homes) {
    if (list.length === 0) {
      err('home-component', `repo "${repo}" has no home component (one with "home: true")`, 'components/');
    } else if (list.length > 1) {
      for (const c of list) {
        err(
          'home-component',
          `repo "${repo}" has ${list.length} home components (${list.map((h) => h.id).join(', ')})`,
          rel(c.indexPath),
        );
      }
    }
  }
  return findings;
}

/**
 * The value-axis rules (F-51 D1, D2):
 *   - `feature-theme` (error): a feature with no `theme:`, or one naming a
 *     theme with no `themes/<slug>/index.md`.
 *   - `feature-epic` (error): a feature's `epic:` with no
 *     `epics/E<nn>-*\/index.md`, or an epic in another theme than the
 *     feature's.
 *   - `epic-theme` (error): an epic with no `theme:`, or one naming a theme
 *     with no directory.
 *   - `theme-repo` (error): a theme with no `repos:` list, or one listing a
 *     repo backlog.json does not register.
 *
 * Two epic directories with one id are the graph's `duplicate-id`
 * (`findDuplicateFindings`).
 *
 * @param {Array<object>} features  readAllFeatures records
 * @param {Array<object>} themes  readAllThemes records
 * @param {Array<object>} epics  readAllEpics records
 * @param {Iterable<string>} registeredRepos  repo names from backlog.json
 * @returns {Finding[]}
 */
export function findValueAxisFindings(features, themes, epics, registeredRepos) {
  const findings = [];
  const err = (code, message, location) => findings.push({ severity: 'error', code, message, location });
  const registered = new Set(registeredRepos);
  const themeIds = new Set(themes.map((t) => t.id));
  // The first directory claiming an epic id wins, as in `findEpic`; the
  // others are the graph's `duplicate-id` (`findDuplicateFindings`).
  const epicsById = new Map();
  for (const e of epics) if (!epicsById.has(e.id)) epicsById.set(e.id, e);

  for (const f of features) {
    if (!f.theme) {
      err('feature-theme', `${f.id} has no "theme:"; every feature names its theme`, f.featureRelPath);
    } else if (!themeIds.has(f.theme)) {
      err(
        'feature-theme',
        `${f.id} names theme "${f.theme}", which has no themes/${f.theme}/index.md`,
        f.featureRelPath,
      );
    }
    if (!f.epic) continue;
    const epic = epicsById.get(normalizeEpicId(f.epic)?.id);
    if (!epic) {
      const id = normalizeEpicId(f.epic)?.id ?? f.epic;
      err('feature-epic', `${f.id} names epic "${f.epic}", which has no epics/${id}-*/index.md`, f.featureRelPath);
    } else if (f.theme && epic.theme !== f.theme) {
      err(
        'feature-epic',
        `${f.id}'s epic ${epic.id} is in theme "${epic.theme || '(none)'}", not the feature's theme "${f.theme}"`,
        f.featureRelPath,
      );
    }
  }

  for (const e of epics) {
    if (!e.theme) {
      err('epic-theme', `${e.id} has no "theme:"; every epic names its theme`, e.relPath);
    } else if (!themeIds.has(e.theme)) {
      err('epic-theme', `${e.id} names theme "${e.theme}", which has no themes/${e.theme}/index.md`, e.relPath);
    }
  }

  for (const t of themes) {
    if (t.repos == null) {
      err('theme-repo', `theme ${t.id} has no "repos:" list; use [] for a product theme`, t.relPath);
      continue;
    }
    for (const repo of t.repos) {
      if (!registered.has(repo)) {
        err('theme-repo', `theme ${t.id} lists repo "${repo}", which backlog.json does not register`, t.relPath);
      }
    }
  }
  return findings;
}

/**
 * The theme-brief findings (F-53 D4): `theme-brief` (error) for a theme with
 * no `brief:` or an empty one, or an entry whose file (the part before `#`)
 * is not a file on disk under the backlog's parent directory.
 * @param {Array<object>} themes  readAllThemes records
 * @param {string} roostDir
 * @returns {Finding[]}
 */
export function findThemeBriefFindings(themes, roostDir) {
  const findings = [];
  for (const t of themes) {
    const err = (message) => findings.push({ severity: 'error', code: 'theme-brief', message, location: t.relPath });
    if (!t.brief?.length) {
      err(
        `theme ${t.id} has no "brief:" list; name the documents to read before working in it, e.g. brief: [app.acme.com/docs/public/tenets.md]`,
      );
      continue;
    }
    for (const entry of t.brief) {
      const { file } = splitBriefEntry(entry);
      const path = resolve(roostDir, file);
      const rel = relative(roostDir, path);
      if (!file) {
        err(`theme ${t.id}'s brief entry "${entry}" names no file`);
      } else if (isAbsolute(file) || rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
        err(
          `theme ${t.id}'s brief entry "${entry}" is not a path relative to the backlog's parent directory (${roostDir})`,
        );
      } else if (!existsSync(path) || !statSync(path).isFile()) {
        err(`theme ${t.id}'s brief entry "${entry}": ${file} is not a file under ${roostDir}`);
      }
    }
  }
  return findings;
}

/**
 * The dictionary findings (F-82 D3): `dictionary-file` (error, at
 * `backlog.json`) for each path `backlog.json` `"dictionaries"` lists that is
 * not a file. bl never reads a dictionary's contents.
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {Finding[]}
 */
export function findDictionaryFindings(config) {
  return dictionariesOf(config)
    .filter((path) => !existsSync(path) || !statSync(path).isFile())
    .map((path) => ({
      severity: 'error',
      code: 'dictionary-file',
      message: `backlog.json "dictionaries" lists ${relative(config.backlogRoot, path)}, which is not a file (${path})`,
      location: 'backlog.json',
    }));
}

/**
 * Every file of the backlog that holds frontmatter, as the tolerant graph
 * lists it (`loadBacklog`, F-77 D2): the root `index.md`, each unit's
 * `index.md` and change documents under `stories/`, `components/`,
 * `features/`, `themes/` and `epics/`, and each task file under `tasks/`
 * (F-65 D1). `unitIndex` is the `index.md` of the unit a file belongs to; a
 * task file is its own.
 * @returns {ReadonlyArray<{ path: string, unitIndex: string | null }>}
 */
export function frontmatterFiles(backlogRoot) {
  return loadBacklog({ backlogRoot }, { tolerant: true }).files;
}

/** A graph problem as a finding at the file it names (`line` only when asked). */
function problemFinding(p, { line = false } = {}) {
  return {
    severity: 'error',
    code: p.code,
    message: p.message,
    location: p.file,
    ...(line ? { line: p.line } : {}),
  };
}

/**
 * The frontmatter findings (F-62 D4), the tolerant graph's
 * `frontmatter-yaml` and `frontmatter-list` problems over every file
 * `frontmatterFiles` names:
 *
 *   - `frontmatter-yaml` (error): the block is not YAML, at the parser's
 *     line and column. The file is not read any further: `invalid` holds it,
 *     and the `index.md` of its unit when it is a change document, and the
 *     graph leaves that unit out, so no reader sees it.
 *   - `frontmatter-list` (error): a list key (`isListKey`, D2) holds a
 *     non-empty scalar or a mapping, or a member that is not a string (not
 *     a mapping, for a change document's `repos:`), at the key's line. The
 *     file goes in `invalid` too: a reader throws `FrontmatterListError`
 *     on such a list rather than drop the member.
 *
 * @param {string} backlogRoot
 * @param {import("./backlog-graph.js").BacklogGraph} [graph]  the tolerant graph, when the caller has it
 * @returns {{ findings: Finding[], invalid: Set<string> }}
 */
export function findFrontmatterFindings(backlogRoot, graph = loadBacklog({ backlogRoot }, { tolerant: true })) {
  const findings = [];
  const invalid = new Set();
  const unitOf = new Map(graph.files.map((f) => [f.path, f.unitIndex]));
  for (const p of graph.problems) {
    if (p.code !== 'frontmatter-yaml' && p.code !== 'frontmatter-list') continue;
    findings.push(problemFinding(p, { line: true }));
    const path = join(graph.root, p.file);
    invalid.add(path);
    const unitIndex = unitOf.get(path);
    if (unitIndex) invalid.add(unitIndex);
  }
  return { findings, invalid };
}

/**
 * The `duplicate-id` findings, from the graph's problems (F-77 D2), each in
 * the words `bl validate` has always used for its kind:
 *
 *   - stories: one per id, at the first file, listing every copy with its title;
 *   - components: one per id, at the second directory, listing every one;
 *   - epics and features: one per later copy, at it, naming the first.
 *
 * A task's duplicate id is `findTaskFindings`'s `task-field`.
 * @param {import("./backlog-graph.js").BacklogGraph} graph
 * @returns {{ stories: Finding[], components: Finding[], epics: Finding[], features: Finding[] }}
 */
export function findDuplicateFindings(graph) {
  const out = { stories: [], components: [], epics: [], features: [] };
  const grouped = new Set();
  for (const p of graph.problems) {
    if (p.code !== 'duplicate-id') continue;
    // The problem's kind, never `graph.get(p.ref)`: a malformed id (`S-bad`)
    // resolves to no unit, though its copies are in `list()`.
    const { kind } = p;
    const copies = graph.list(kind).filter((u) => u.id === p.ref);
    if (kind === 'epic' || kind === 'feature') {
      const first = copies[0].relPath;
      out[`${kind}s`].push({
        severity: 'error',
        code: 'duplicate-id',
        message: `duplicate ${kind} ID ${p.ref} across directories: ${first}, ${p.file}`,
        location: p.file,
      });
      continue;
    }
    if (grouped.has(`${kind}\0${p.ref}`)) continue;
    grouped.add(`${kind}\0${p.ref}`);
    if (kind === 'story') {
      out.stories.push(storyDuplicateFinding(p.ref, copies));
    } else if (kind === 'component') {
      out.components.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `duplicate component ID ${p.ref} across ${copies.length} directories: ${copies.map((c) => c.relPath).join(', ')}`,
        location: copies[1].relPath,
      });
    }
  }
  return out;
}

/**
 * The dangling-reference findings, from the graph's problems (F-77 D2):
 * `dangling-dep` (a `depends_on:` naming no story) and
 * `dangling-feature` (a `feature:` naming no feature), each at the story's
 * file.
 * @param {import("./backlog-graph.js").BacklogGraph} graph
 * @returns {{ deps: Finding[], features: Finding[] }}
 */
export function findDanglingFindings(graph) {
  const pick = (code) => graph.problems.filter((p) => p.code === code).map((p) => problemFinding(p));
  return { deps: pick('dangling-dep'), features: pick('dangling-feature') };
}

/**
 * The priority findings, from the graph's problems (F-78 D1), each an error
 * at `priority.md`:
 *
 *   - `priority-file`: the file is missing, its frontmatter is not YAML, or
 *     `ranked:` is not a list of mappings each with `unit` and `why`;
 *   - `priority-unit`: an entry that names no feature or story, names one
 *     twice, or names a story inside a feature, an update story or a task.
 *
 * A closed unit left in `ranked:` is no finding: the order skips it.
 * @param {import("./backlog-graph.js").BacklogGraph} graph
 * @returns {Finding[]}
 */
export function findPriorityFindings(graph) {
  return graph.problems
    .filter((p) => p.code === 'priority-file' || p.code === 'priority-unit')
    .map((p) => problemFinding(p));
}

/**
 * The `generated-section` findings (F-79 D3), each an error at the page: a
 * committed page that holds one of the sections `GENERATED_SECTIONS` names
 * for its kind, as one complete GFM table with the generated header row
 * (`isGeneratedBody`).
 * `bl report` and `bl view` render those when the page is read; a committed
 * copy goes stale and conflicts. A hand-written section under the same
 * heading is no finding: `renderPage` keeps it above the generated table.
 * @param {import("./backlog-graph.js").BacklogGraph} graph
 * @returns {Finding[]}
 */
export function findGeneratedSectionFindings(graph) {
  const pages = [];
  const rootPath = join(graph.root, 'index.md');
  // A root whose frontmatter is not YAML is `frontmatter-yaml`'s, and not read further.
  if (existsSync(rootPath) && !graph.problems.some((p) => p.code === 'frontmatter-yaml' && p.file === 'index.md')) {
    const { body } = parseFrontmatter(readFileSync(rootPath, 'utf8').replace(/\r\n/g, '\n'));
    pages.push({ kind: 'root', relPath: 'index.md', section: (h) => extractSection(body, h) });
  }
  for (const kind of UNIT_PAGE_KINDS) pages.push(...graph.list(kind));
  return pages.flatMap((page) =>
    GENERATED_SECTIONS[page.kind]
      .filter((h) => isGeneratedBody(page.section(h), generatedColumns(page.kind, h)))
      .map((h) => ({
        severity: 'error',
        code: 'generated-section',
        message: `"## ${h}" is a generated table: bl report and bl view render it when the page is read; remove the section (node scripts/migrate-generated-sections.js removes them all)`,
        location: page.relPath,
      })),
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * @param {any} config
 * @param {{ json?: boolean,
 *           skip?: Iterable<string> | string[] }} opts
 *   `skip` suppresses finding categories by their `code`. CLI-side this is
 *   populated by `--skip <code>` (repeatable); currently only
 *   `plugin-binary` is documented but the mechanism is generic so new
 *   warning-style categories can opt in without re-plumbing the flag.
 */
export function runAll(config, opts = {}) {
  const { json } = opts;
  const skip = new Set(opts.skip ?? []);

  // 0. The backlog, read once and tolerantly (F-77 D2): frontmatter that is
  // not YAML is a problem and its unit is left out (F-62 D4). Every reader
  // below projects this one graph (`graphOf`).
  const graph = loadBacklog(config, { tolerant: true });
  const frontmatter = findFrontmatterFindings(config.backlogRoot, graph);
  config = { ...config, backlogGraph: graph };

  // The statuses and gates per type (F-66 D1). A missing or unreadable
  // flow.json throws, naming the file: nothing below can check a status.
  const flow = loadFlow(config.backlogRoot);

  // Each story's and component's frontmatter, body and text, as the graph
  // read them, once; a feature record carries its own.
  const unitAt = new Map([...graph.list('story'), ...graph.list('component')].map((u) => [u.file, u]));
  const allStories = readAllStories(config).map((s) => ({ ...s, fm: unitAt.get(s.indexPath).fm }));
  const allComponents = readComponents(config);
  const componentCount = allComponents.length;
  const allFeatures = readAllFeatures(config);
  const allTasks = readAllTasks(config);
  const units = unitIndex(allStories, allFeatures, allTasks);
  const featureNote =
    allFeatures.length > 0 ? ` (${allFeatures.length} feature${allFeatures.length === 1 ? '' : 's'})` : '';

  // Per AGENTS.md § Stream policy, progress goes to stderr — but for the
  // documented `--json | jq` pattern stderr must be empty, so suppress
  // chatter when stdout is a pipe and we're emitting JSON.
  if (process.stdout.isTTY || !json) {
    process.stderr.write(
      `scanning ${allStories.length} stor${allStories.length === 1 ? 'y' : 'ies'} across ${componentCount} component${componentCount === 1 ? '' : 's'}…${featureNote}\n`,
    );
  }

  const findings = [...frontmatter.findings, ...findFlowFindings(flow)];

  const knownRepos = new Set(Object.keys(config.reposByName ?? {}));

  // 1. Frontmatter checks for stories.
  for (const s of allStories) {
    const unit = unitAt.get(s.indexPath);
    const { fm } = s;
    const parts = s.storyRelPath.split('/');
    const dirName = parts[parts.length - 2];
    findings.push(
      ...validateFrontmatter(fm, 'story', s.storyRelPath, {
        dirName,
        knownRepos,
        componentId: s.componentId,
        unitRepo: s.unitRepo,
        flow,
      }),
    );
    findings.push(...findRunStateInSpec(fm, unit.body(), s.storyRelPath));
    findings.push(...validateChanges(config.backlogRoot, unit.dir));
    findings.push(...findDeferredErrors(s.id, fm.status, unit.text(), s.storyRelPath, flow, 'story'));
  }

  // 2. Frontmatter checks for components.
  for (const c of allComponents) {
    const relPath = relative(config.backlogRoot, c.indexPath);
    findings.push(...validateFrontmatter(c.fm, 'component', relPath, { dirName: c.componentEntry }));
    findings.push(...findRunStateInSpec(c.fm, unitAt.get(c.indexPath).body(), relPath));
  }

  // 2a. The component rules (F-49 D4), backlog-wide like the graph checks.
  const componentFindings = findComponentFindings(
    allStories,
    allComponents,
    Object.keys(config.reposByName ?? {}),
    config.backlogRoot,
  );

  // 2b. Frontmatter + review-log checks for features.
  for (const f of allFeatures) {
    findings.push(
      ...validateFrontmatter(f.fm, 'feature', f.featureRelPath, {
        dirName: f.featureEntry,
        knownRepos,
        flow,
      }),
    );
    findings.push(...findRunStateInSpec(f.fm, f.body, f.featureRelPath));
    findings.push(...validateChanges(config.backlogRoot, f.featureDir));
    findings.push(...findEscalationNotNone(f));
    findings.push(...findDeferredErrors(f.id, f.fm.status, f.content, f.featureRelPath, flow, 'feature'));
  }

  // 2c. Themes and epics (F-51 D1): their frontmatter, then the value-axis
  //     rules, which also check each feature's `theme:` and `epic:`.
  const allThemes = readAllThemes(config);
  const allEpics = readAllEpics(config);
  for (const t of allThemes) {
    findings.push(...validateFrontmatter(t.fm, 'theme', t.relPath, { dirName: t.themeEntry }));
  }
  for (const e of allEpics) {
    findings.push(...validateFrontmatter(e.fm, 'epic', e.relPath, { dirName: e.epicEntry }));
  }
  const valueAxisFindings = findValueAxisFindings(
    allFeatures,
    allThemes,
    allEpics,
    Object.keys(config.reposByName ?? {}),
  );

  // 3. Duplicate IDs and dangling references: the graph's problems (F-77 D2).
  const dupes = findDuplicateFindings(graph);
  const dangling = findDanglingFindings(graph);

  // 4. Graph checks over every story.
  const fullMap = new Map();
  for (const s of allStories) fullMap.set(s.id, s);
  const cycles = findCycles(fullMap);

  const featureLinks = findFeatureFindings(allFeatures);
  const foundBy = findFoundByFindings(allFeatures, fullMap);
  const implementPlugins = findImplementPluginFindings(fullMap.values(), config);
  const verificationTitles = skip.has('verification-only-title') ? [] : findVerificationOnlyTitles(allStories, flow);
  findings.push(
    ...dupes.stories,
    ...dupes.features,
    ...dangling.deps,
    ...cycles,
    ...featureLinks,
    ...dangling.features,
    ...foundBy,
    ...implementPlugins,
    ...verificationTitles,
    ...dupes.components,
    ...componentFindings,
    ...dupes.epics,
    ...valueAxisFindings,
  );

  // 4a. The priority (F-78 D1): `priority.md`'s `ranked:`, the graph's
  //     problems. The roadmap's shape (F-53 D2) and the themes' briefs (D4).
  // The edges in blockers.json (F-66 D5), against the flow and every unit,
  // with the deadlock graph that also reads cross-feature depends_on.
  findings.push(...findBlockersFindings(config.backlogRoot, units, flow));
  // The task files (F-65 D1): `task-unit`, `task-field`.
  findings.push(...findTaskFindings(allTasks, units, flow));

  findings.push(...findPriorityFindings(graph));
  findings.push(...findGeneratedSectionFindings(graph));
  findings.push(...findRoadmapFindings(config));
  findings.push(...findThemeBriefFindings(allThemes, config.roostDir));
  findings.push(...findDictionaryFindings(config));

  // 4b. The forge plugin against the D4 op set (backlog-wide, like 5).
  findings.push(...findForgeFindings(config));
  findings.push(...findAgentConfigFindings(config));

  // 5. Plugin binary preflight (backlog-wide: the plugin map lives at the
  //    top-level backlog). `--skip plugin-binary` suppresses the whole
  //    category.
  if (!skip.has('plugin-binary')) {
    findings.push(...findMissingPluginBinaries(config));
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  return {
    findings,
    summary: { errors, warnings, total: findings.length },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatHuman(findings, summary) {
  if (findings.length === 0) return '';

  const out = [];
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  if (errors.length > 0) {
    out.push('errors (' + errors.length + '):');
    const byFile = groupBy(errors, 'location');
    for (const file of Object.keys(byFile).sort()) {
      out.push(`  ${file}`);
      for (const f of byFile[file]) {
        out.push(`    ${f.code}: ${f.message}`);
      }
    }
  }

  if (warnings.length > 0) {
    out.push('warnings (' + warnings.length + '):');
    const byFile = groupBy(warnings, 'location');
    for (const file of Object.keys(byFile).sort()) {
      out.push(`  ${file}`);
      for (const f of byFile[file]) {
        out.push(`    ${f.code}: ${f.message}`);
      }
    }
  }

  out.push(`${summary.total} findings (${summary.errors} errors, ${summary.warnings} warnings)`);
  return out.join('\n');
}

export function formatJson(findings, summary) {
  return JSON.stringify({ findings, summary });
}

function groupBy(list, key) {
  return list.reduce((acc, item) => {
    const val = item[key];
    acc[val] = acc[val] || [];
    acc[val].push(item);
    return acc;
  }, {});
}

// ---------------------------------------------------------------------------
// CLI Entry
// ---------------------------------------------------------------------------

export function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(`Usage: bl validate [--json] [--strict] [--skip <code>]

Run backlog-wide integrity checks (frontmatter, duplicate IDs,
acyclic dep graph) and report every finding.

Options:
  --json             Emit one JSON object: {findings, summary}.
  --strict           Treat warnings as errors for exit code.
  --skip <code>      Suppress a finding category by its code
                     (repeatable). E.g. --skip plugin-binary if
                     this machine intentionally lacks some
                     plugin tools.

Output:
  stdout   Findings (human report, or one JSON object with --json).
  stderr   Progress lines, e.g. "scanning N stories…".

Exit codes:
  0   No errors (warnings allowed unless --strict).
  1   At least one error finding.
  2   --strict and at least one warning (no errors).

Findings codes:
  missing-required-key, unknown-fm-key, bad-status, bad-points,
  bad-effort, bad-review-status, id-dir-mismatch, bad-id-format, duplicate-id,
  cycle, dangling-dep, review-log-missing,
  review-log-unaddressed, plugin-binary, derived-key, dangling-feature,
  found-by, feature-no-stories, verification-only-title, run-state-in-spec,
  change-of-mismatch, change-repo-incomplete, bad-change-status,
  forge-plugin, forge-op, forge-op-reads-body, component-unknown,
  home-component, component-has-status, component-paths,
  feature-theme, feature-epic, epic-theme, theme-repo, repo-key,
  priority-file, priority-unit, generated-section, roadmap-file,
  roadmap-section, theme-brief, dictionary-file, flow-json, blockers-json, agent-config,
  blockers-unit, blockers-gate, blockers-status, blockers-duplicate,
  blockers-cycle, blockers-unmeetable, blockers-order

Reads flow.json at the backlog root for story and feature statuses;
a missing or unreadable one stops validate with its name. Checks every
edge in blockers.json (a missing one has none), and reports a deadlock
among edges and cross-feature depends_on as blockers-cycle.`);
    process.exit(0);
  }

  // Leniently, so a wrong `agent` or `review_agent` is a finding
  // (`agent-config`) instead of stopping validate before it reports.
  const config = loadConfig({ lenientAgents: true });
  // `--skip` is parsed as a list flag (see `LIST_FLAGS` in config.js), so a
  // single occurrence arrives as a string and repeats accumulate into an
  // array. Normalise to an array for `runAll`.
  const rawSkip = options.skip;
  const skip = Array.isArray(rawSkip) ? rawSkip : rawSkip ? [rawSkip] : [];
  const { findings, summary } = runAll(config, {
    json: options.json,
    skip,
  });

  if (options.json) {
    process.stdout.write(formatJson(findings, summary) + '\n');
  } else {
    const report = formatHuman(findings, summary);
    if (report) console.log(report);
  }

  // The exit code, not `process.exit`: stdout to a pipe is written
  // asynchronously, and exiting at once cuts a report past the pipe's
  // buffer (64 KiB to 128 KiB) short.
  process.exitCode = summary.errors > 0 ? 1 : options.strict && summary.warnings > 0 ? 2 : 0;
}
