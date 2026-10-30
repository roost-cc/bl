/**
 * attach.js — `bl attach`: list an existing story in a feature (S-1095).
 *
 *   bl attach <S-n> <F-n> [--no-sync] [--json]
 *
 * Membership is the feature's `stories:` list (`bl run` orders from it,
 * `bl sync` sums its points, `bl merge` marks exactly its stories done); the
 * story's `feature:` key points back. `bl attach` writes both, the two writes
 * `bl new F-<n>` makes for a story it creates, and commits the story
 * directory and the feature's `index.md` by path. A story that already has
 * one half (it names the feature but is not listed, or is listed with no
 * `feature:`) gets the other; one with both is left alone.
 *
 * Every refusal comes under the backlog lock, from the files as they are
 * then, before anything is written. A story in another feature, or one that
 * is not `backlog` or `refined`, is refused as `bl new --feature … S-<n>`
 * refuses it; a closed feature as `bl new F-<n>` refuses it. A running or
 * escalated feature has branches and worktrees only in its stories' repos,
 * so a story in another repo is refused there: `bl side` brings a repo in.
 * Before the feature runs, a story in a new repo simply joins it.
 *
 * Attach creates nothing, so a failed feature write has one write to undo:
 * the story's bytes from before the attach are written back. No repair
 * record (feature-links.js) is involved. Both documents are written through
 * `updateSpecFile` (F-67) and the restore through `atomicWriteFile`, so a
 * write that fails part way leaves its file as it was, never truncated.
 */

import { readFileSync } from 'fs';
import { relative } from 'path';
import { loadConfig, parseArgs, parseFrontmatterOf, normalizeId, info } from './config.js';
import { findStoryDir, storyRepoOrExit } from './story.js';
import {
  appendStoriesToFeature,
  closedFeatureRefusal,
  findFeature,
  normalizeFeatureId,
  reposForFeature,
  storyMoveRefusal,
} from './feature.js';
import { failPoint } from './feature-links.js';
import { atomicWriteFile } from './atomic-write.js';
import { updateSpecFile } from './spec-file.js';
import { acquireLock } from './lock.js';
import { syncAndCommit, reportBacklogCommit } from './sync.js';

export const ATTACH_JSON_SCHEMA = 'bl-attach-json/v1';

/** Feature statuses with branches and worktrees, so a fixed set of repos. */
const BRANCHED = new Set(['running', 'escalated']);

const HELP = `Usage: bl attach <S-n> <F-n> [options]

List an existing story in a feature: set the story's feature: and append it
to the feature's stories:, then sync and commit both files by path. The ids
may come in either order. A story that names the feature but is not listed,
or is listed with no feature:, gets the missing half; one with both is left
alone (stderr says so).

Refused, with nothing written:
  - anything other than one story id and one feature id
  - a story or feature that does not exist
  - a feature file whose feature_id: is another feature
  - a story whose component has no repo
  - a feature that is done or superseded
  - a story whose feature: names another feature
  - a story that is not backlog or refined
  - for a running or escalated feature, a story whose component's repo the
    feature's branches do not span (bl side <repo> --from F-<n> brings a
    repo in)

Options:
  --no-sync   Write the two files under the backlog lock and leave them
              uncommitted, as bl new --no-sync does
  --json      Print one JSON object (schema ${ATTACH_JSON_SCHEMA}):
              { schema, story, feature, changed }
  --help      Show this help

stdout is empty without --json; progress goes to stderr.

Examples:
  bl attach S-1013 F-40
  bl attach F-40 S-1013 --no-sync`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * The positionals as one story id and one feature id, in either order;
 * exits 1 on anything else.
 */
function classify(positional) {
  const usage = 'bl attach takes one story id and one feature id: bl attach S-<n> F-<n>.';
  if (positional.length !== 2) fail(`${usage} Got ${positional.length ? positional.join(', ') : 'none'}.`);
  const stories = [];
  const features = [];
  for (const raw of positional.map((p) => String(p).trim())) {
    const s = normalizeId(raw);
    const f = normalizeFeatureId(raw);
    if (s) stories.push(s);
    else if (f) features.push(f);
    else fail(`bl attach: '${raw}' is not a story (S-<n>) or feature (F-<n>) id.`);
  }
  if (stories.length !== 1 || features.length !== 1) fail(`${usage} Got ${positional.join(', ')}.`);
  return { storyRef: stories[0], featureRef: features[0] };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const { storyRef, featureRef } = classify(args.positional);
  const noSync = args['no-sync'] === true;
  const jsonMode = args.json === true;

  const config = loadConfig();
  await acquireLock(config.backlogRoot);

  // Everything is read here, under the lock: what another bl wrote while
  // this one waited is what the refusals see.
  const found = findStoryDir(storyRef, config);
  if (!found) fail(`bl attach: story ${storyRef.id} not found under stories/.`);
  const feature = findFeature(featureRef, config);
  if (!feature) fail(`bl attach: feature ${featureRef.id} not found under features/.`);
  // The file's `feature_id:` must be the directory's feature, in any form
  // `normalizeFeatureId` accepts; from here on it is the canonical id.
  if (normalizeFeatureId(String(feature.id))?.id !== featureRef.id) {
    fail(
      `bl attach: ${feature.featureRelPath} names feature_id: ${feature.id}, not ${featureRef.id}; fix the file first.`,
    );
  }
  feature.id = featureRef.id;
  const before = readFileSync(found.indexPath, 'utf8');
  let parsed;
  try {
    parsed = parseFrontmatterOf(before, found.indexPath);
  } catch (e) {
    fail(`bl attach: ${e.message}`);
  }
  const { fm } = parsed;
  // The directory's id, canonical like the feature's `stories:` entries: a
  // hand-written `story_id: S2` would miss the dedupe and be listed twice.
  const storyId = storyRef.id;

  const closed = closedFeatureRefusal(feature);
  if (closed) fail(closed);
  const listed = feature.stories.includes(storyId);
  const named = String(fm.feature ?? '').trim();
  // Listed with no `feature:` is the feature's already (half-attached), so
  // the status rule, which keeps out someone else's work, does not apply.
  const refusal = listed && !named ? null : storyMoveRefusal(storyId, fm, feature.id);
  if (refusal) fail(refusal);
  // A story's repo is its component's, in every feature status.
  const repo = storyRepoOrExit(storyRef, found);
  if (BRANCHED.has(feature.status)) {
    const repos = reposForFeature(feature, config).map((r) => r.repoName);
    if (!repos.includes(repo)) {
      fail(
        `bl attach: ${feature.id} is ${feature.status}, and its branches do not span ` +
          `${repo} (${storyId}'s repo); they span ${repos.join(', ') || 'none'}. ` +
          `Bring the repo in with bl side ${repo} --from ${feature.id}.`,
      );
    }
  }

  const needStory = named !== feature.id;
  const changed = needStory || !listed;
  if (!changed) {
    info(`${storyId} is already in ${feature.id}; nothing to do.`);
  } else {
    if (needStory) {
      try {
        updateSpecFile(config.backlogRoot, found.indexPath, (specFm) => {
          // An empty `feature:` key is filled in place; a missing one goes last.
          specFm.feature = feature.id;
        });
      } catch (e) {
        fail(`bl attach: could not write ${storyId}: ${e.message}. Nothing was changed.`);
      }
    }
    if (!listed) {
      try {
        failPoint('list');
        appendStoriesToFeature(config.backlogRoot, feature, [storyId]);
      } catch (e) {
        let restored = '';
        if (needStory) {
          try {
            atomicWriteFile(config.backlogRoot, found.indexPath, before);
            restored = ` ${storyId} is restored.`;
          } catch (restoreErr) {
            restored = ` ${storyId} could not be restored (${restoreErr.message}); it names ${feature.id}, so remove that by hand.`;
          }
        }
        fail(`bl attach: could not list ${storyId} in ${feature.id}: ${e.message}.${restored}`);
      }
    }
    info(`Attached ${storyId} to ${feature.id}.`);

    if (noSync) {
      info("Skipped sync. Run 'bl sync' to update indexes.");
    } else {
      let res;
      try {
        res = await syncAndCommit(config, {
          message: `chore: attach ${storyId} to ${feature.id}`,
          storyIds: [storyId],
          extraPaths: [relative(config.backlogRoot, feature.indexPath)],
        });
      } catch (e) {
        fail(
          `bl attach: ${storyId} is attached to ${feature.id}, but the sync failed: ${e.message}. Run 'bl sync --commit' by hand.`,
        );
      }
      reportBacklogCommit(res, 'bl attach');
    }
  }

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ schema: ATTACH_JSON_SCHEMA, story: storyId, feature: feature.id, changed }) + '\n',
    );
  }
}
