/**
 * move.js — `bl move`: move backlog stories to another component (F-61 D5).
 *
 *   bl move <S-n>… <C-n> [--no-sync] [--json]
 *
 * A story's component is its `component:` key, and its one repo is that
 * component's (F-52 D1), so re-homing a mis-filed story is one key. `bl move`
 * rewrites it for every story named and commits the story directories and
 * the regenerated component indexes by path, as `bl attach` commits its two
 * files.
 *
 * Every refusal comes under the backlog lock, from the files as they are
 * then, before anything is written, and the whole call is refused when any
 * story is: an unknown story or component, a target component with no repo,
 * a story that is not `backlog` or `refined` (an `in_progress` story has a
 * worktree in its current repo), and a story whose repo would change while
 * a feature it is in is `running` or `escalated` (that feature's branches
 * span a fixed set of repos, as `bl attach` refuses it). A story is in the
 * feature its `feature:` names and in every feature whose `stories:` lists
 * it, so a missing or broken backlink does not let it leave its repo. A
 * story already in the target is left alone, whatever its status, and
 * reported as unchanged.
 *
 * Each story is written through `updateSpecFile`, so a failed write leaves
 * its file whole; the stories written before it get their `component:` from
 * before the move back, through `updateSpecFile` too, so the file is the one
 * read under its spec lock and what another writer saved since stays.
 */

import { readFileSync } from 'fs';
import { loadConfig, parseArgs, parseFrontmatterOf, normalizeId, normalizeComponentId, info } from './config.js';
import { findComponentDir, findStoryDir } from './story.js';
import { readAllFeatures, normalizeFeatureId } from './feature.js';
import { failPoint } from './feature-links.js';
import { updateSpecFile } from './spec-file.js';
import { acquireLock } from './lock.js';
import { syncAndCommit, reportBacklogCommit } from './sync.js';

export const MOVE_JSON_SCHEMA = 'bl-move-json/v1';

/** Feature statuses with branches and worktrees, so a fixed set of repos. */
const BRANCHED = new Set(['running', 'escalated']);

/** The statuses a story moves in: nothing has a branch for it yet. */
const MOVABLE = new Set(['backlog', 'refined']);

const HELP = `Usage: bl move <S-n>… <C-n> [options]

Move backlog stories to another component: set each story's component:,
then sync and commit the story directories and the regenerated component
indexes by path. The ids may come in any order: one component id and one or
more story ids. A story's repo is its component's, so a move to a component
in another repo moves the story to that repo. A story already in the
component is left alone (stderr says so).

Refused, with nothing written, naming every offending story:
  - anything other than one component id and at least one story id
  - a story or component that does not exist
  - a component that names no repo
  - a story that is not backlog or refined
  - a story whose repo would change while a feature it is in (the one its
    feature: names, or any whose stories: lists it) is running or
    escalated (the feature's branches span a fixed set of repos)

Options:
  --no-sync   Write the stories under the backlog lock and leave them
              uncommitted, as bl new --no-sync does
  --json      Print one JSON object (schema ${MOVE_JSON_SCHEMA}):
              { schema, component, moved, unchanged }
  --help      Show this help

stdout is empty without --json; progress goes to stderr.

Examples:
  bl move S-373 S-374 C46
  bl move C20 S-593 --no-sync`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * The positionals as one component id and the story ids (each deduped, the
 * stories in the order given), the ids in any order and any form `normalizeId` and
 * `normalizeComponentId` accept. Throws an Error with the usage on anything
 * else.
 * @param {unknown[]} positional
 * @returns {{ componentRef: { id: string, dirPrefix: string }, storyRefs: Array<{ id: string, dirPrefix: string }> }}
 */
export function parseMoveIds(positional) {
  const usage = 'bl move takes one or more story ids and one component id: bl move S-<n>… C-<n>.';
  const components = [];
  const storyRefs = [];
  for (const raw of positional.map((p) => String(p).trim())) {
    const s = normalizeId(raw);
    const c = normalizeComponentId(raw);
    if (s) {
      if (!storyRefs.some((r) => r.id === s.id)) storyRefs.push(s);
    } else if (c) {
      if (!components.some((r) => r.id === c.id)) components.push(c);
    } else throw new Error(`bl move: '${raw}' is not a story (S-<n>) or component (C-<n>) id.`);
  }
  if (components.length !== 1 || storyRefs.length === 0) {
    throw new Error(`${usage} Got ${positional.length ? positional.join(', ') : 'none'}.`);
  }
  return { componentRef: components[0], storyRefs };
}

/**
 * Why story `id` cannot move to the component `to` (in repo `toRepo`), or
 * null when it can. `fm` is its frontmatter, `fromRepo` its repo now (empty
 * when its component is unknown or has none) and `features` every feature it
 * is in: the one its `feature:` names and each one whose `stories:` lists it
 * (`storyFeatures`). Pure; the caller has already set aside a story that is
 * in `to`.
 * @param {{ id: string, fm: object, fromRepo: string, to: string, toRepo: string,
 *   features: Array<{ id: string, status: string }> }} story
 * @returns {string | null}
 */
export function moveRefusal({ id, fm, fromRepo, to, toRepo, features }) {
  if (!MOVABLE.has(fm.status)) {
    return `${id} is ${fm.status ?? '(no status)'}; only a backlog or refined story moves to another component.`;
  }
  const feature = features.find((f) => BRANCHED.has(f.status));
  if (feature && fromRepo !== toRepo) {
    return (
      `${id} is in ${feature.id}, which is ${feature.status}: moving it to ${to} changes its repo ` +
      `from ${fromRepo || '(none)'} to ${toRepo}, and the feature's branches span a fixed set of repos.`
    );
  }
  return null;
}

/**
 * The features story `id` (frontmatter `fm`) is in, from `allFeatures`: the
 * one its `feature:` names and every one whose `stories:` lists it, each once.
 * A `feature:` that is empty, not a feature id or names no feature adds none.
 * @param {string} id
 * @param {object} fm
 * @param {Array<{ id: string, status: string, stories: string[] }>} allFeatures
 * @returns {Array<{ id: string, status: string }>}
 */
export function storyFeatures(id, fm, allFeatures) {
  const named = normalizeFeatureId(String(fm.feature ?? '').trim())?.id;
  return allFeatures
    .filter((f) => f.id === named || f.stories.includes(id))
    .map((f) => ({ id: f.id, status: f.status }));
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  let ids;
  try {
    ids = parseMoveIds(args.positional);
  } catch (e) {
    fail(e.message);
  }
  const { componentRef, storyRefs } = ids;
  const noSync = args['no-sync'] === true;
  const jsonMode = args.json === true;

  const config = loadConfig();
  await acquireLock(config.backlogRoot);

  // Everything is read here, under the lock: what another bl wrote while
  // this one waited is what the refusals see.
  const target = findComponentDir(componentRef, config);
  if (!target) fail(`bl move: component ${componentRef.id} not found under components/.`);
  const to = componentRef.id;
  if (!target.repo) {
    fail(`bl move: component ${to} names no repo, and a story's repo is its component's; set repo: on ${to} first.`);
  }

  let allFeatures;
  try {
    allFeatures = readAllFeatures(config);
  } catch (e) {
    fail(`bl move: nothing was moved: ${e.message}`);
  }
  const refusals = [];
  const moves = [];
  const unchanged = [];
  for (const ref of storyRefs) {
    // findStoryDir parses the frontmatter to place the story, and throws on
    // one that is not YAML: a refusal like any other, not the whole call's.
    let found;
    try {
      found = findStoryDir(ref, config);
    } catch (e) {
      refusals.push(e.message);
      continue;
    }
    if (!found) {
      refusals.push(`${ref.id} not found under stories/.`);
      continue;
    }
    const before = readFileSync(found.indexPath, 'utf8');
    let fm;
    try {
      ({ fm } = parseFrontmatterOf(before.replace(/\r\n/g, '\n'), found.indexPath));
    } catch (e) {
      refusals.push(e.message);
      continue;
    }
    if (found.componentId === to) {
      unchanged.push(ref.id);
      continue;
    }
    const refusal = moveRefusal({
      id: ref.id,
      fm,
      fromRepo: found.unitRepo,
      to,
      toRepo: target.repo,
      features: storyFeatures(ref.id, fm, allFeatures),
    });
    if (refusal) refusals.push(refusal);
    else
      moves.push({ id: ref.id, from: found.componentId || '(none)', indexPath: found.indexPath, prior: fm.component });
  }
  if (refusals.length > 0) {
    fail(`bl move: nothing was moved:\n${refusals.map((r) => `  ${r}`).join('\n')}`);
  }

  for (const id of unchanged) info(`${id} is already in ${to}; nothing to do.`);
  const written = [];
  for (const m of moves) {
    try {
      failPoint(m.id);
      updateSpecFile(config.backlogRoot, m.indexPath, (specFm) => {
        specFm.component = to;
      });
    } catch (e) {
      const notRestored = [];
      for (const w of written) {
        try {
          updateSpecFile(config.backlogRoot, w.indexPath, (specFm) => {
            if (w.prior === undefined) delete specFm.component;
            else specFm.component = w.prior;
          });
        } catch (restoreErr) {
          notRestored.push(`${w.id} (${restoreErr.message})`);
        }
      }
      const restored =
        written.length === 0
          ? ' Nothing was changed.'
          : notRestored.length === 0
            ? ` ${written.map((w) => w.id).join(', ')} ${written.length === 1 ? 'is' : 'are'} restored.`
            : ` Could not restore ${notRestored.join(', ')}: set component: back by hand.`;
      fail(`bl move: could not write ${m.id}: ${e.message}.${restored}`);
    }
    written.push(m);
    info(`Moved ${m.id} from ${m.from} to ${to}.`);
  }

  const moved = moves.map((m) => m.id);
  if (moved.length > 0) {
    if (noSync) {
      info("Skipped sync. Run 'bl sync' to update indexes.");
    } else {
      let res;
      try {
        res = await syncAndCommit(config, {
          message: `chore: move ${moved.join(', ')} to ${to}`,
          storyIds: moved,
        });
      } catch (e) {
        fail(
          `bl move: ${moved.join(', ')} moved to ${to}, but the sync failed: ${e.message}. Run 'bl sync --commit' by hand.`,
        );
      }
      reportBacklogCommit(res, 'bl move');
    }
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ schema: MOVE_JSON_SCHEMA, component: to, moved, unchanged }) + '\n');
  }
}
