/**
 * attach.js — `bl attach`: list an existing story in a feature (S-1095).
 *
 *   bl attach <S-n> <F-n> [--no-sync] [--json]
 *
 * Membership is the story's `feature:` key, and nothing else (F-77 D3): a
 * feature's stories, points and components are derived from it (`bl run`
 * orders them, `bl merge` marks exactly them done). `bl attach` sets it, the
 * write `bl new F-<n>` makes for a story it creates, and commits the story
 * directory by path. A story that already names the feature keeps its file;
 * only its run edges are turned, as below.
 *
 * Every refusal comes under the backlog lock, from the files as they are
 * then, before anything is written. A story in another feature, or one that
 * has started (`Flow.isUnstarted`), is refused as `bl new --feature … S-<n>`
 * refuses it; a closed feature as `bl new F-<n>` refuses it. A started feature
 * (`isFeatureBranched`) has branches and worktrees only in its stories' repos,
 * so a story in another repo is refused there: `bl side` brings a repo in.
 * Before the feature runs, a story in a new repo simply joins it.
 *
 * Attach creates nothing and writes the story through `updateSpecFile`
 * (F-67), so a write that fails part way leaves it as it was, never
 * truncated. A run edge in `blockers.json` between the story and a story of
 * the feature becomes an order edge (`orderJoinedEdges`, F-111 D5), in the
 * same commit.
 */

import { readFileSync } from 'fs';
import { loadConfig, parseArgs, parseFrontmatterOf, normalizeId, info } from './config.js';
import { findStoryDir, storyRepoOrExit } from './story.js';
import {
  branchedStatusesOf,
  closedFeatureRefusal,
  findFeature,
  isFeatureBranched,
  normalizeFeatureId,
  reposForFeature,
  storyMoveRefusal,
} from './feature.js';
import { updateSpecFile } from './spec-file.js';
import { snapshot } from './atomic-write.js';
import { joinRefusal, orderJoinedEdges } from './block.js';
import { acquireLock } from './lock.js';
import { syncAndCommit, reportBacklogCommit } from './sync.js';
import { flowForHelp, loadFlow, statusWords } from './flow.js';

export const ATTACH_JSON_SCHEMA = 'bl-attach-json/v1';

const help = (flow) => `Usage: bl attach <S-n> <F-n> [options]

Put an existing story in a feature: set the story's feature:, turn each run
edge in blockers.json between it and a story of the feature into an order
edge, then commit the story directory (and blockers.json) by path. The ids
may come in either order. A story's feature: is the only statement of
membership. A story that already names the feature keeps its file, and
only its run edges are turned; with none, nothing is done (stderr says so).

Refused, with nothing written:
  - anything other than one story id and one feature id
  - a story or feature that does not exist
  - a feature file whose feature_id: is another feature
  - a story whose component has no repo
  - a feature that is ${statusWords(flow.closedStatusesOf('feature'))}
  - a story whose feature: names another feature
  - a story that is not ${statusWords(flow.unstartedStatusesOf('story'))}
  - a run edge with active_when between the story and a story of the
    feature: an order edge takes no active_when
  - for a ${statusWords(branchedStatusesOf(flow))} feature, a story whose
    component's repo the feature's branches do not span (bl side <repo> --from F-<n> brings a
    repo in)

Options:
  --no-sync   Write the story and blockers.json under the backlog lock and
              leave them uncommitted, as bl new --no-sync does
  --json      Print one JSON object (schema ${ATTACH_JSON_SCHEMA}):
              { schema, story, feature, changed }. changed is the
              feature: line alone, so it is false for a rerun that
              turned edges
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
    console.log(help(flowForHelp()));
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
  // The directory's id, canonical: a hand-written `story_id: S2` is S-2.
  const storyId = storyRef.id;

  const flow = loadFlow(config.backlogRoot);
  const closed = closedFeatureRefusal(feature, flow);
  if (closed) fail(closed);
  const named = String(fm.feature ?? '').trim();
  const refusal = storyMoveRefusal(storyId, fm, feature.id, flow);
  if (refusal) fail(refusal);
  // A story's repo is its component's, in every feature status.
  const repo = storyRepoOrExit(storyRef, found);
  if (isFeatureBranched(flow, feature.status)) {
    const repos = reposForFeature(feature, config).map((r) => r.repoName);
    if (!repos.includes(repo)) {
      fail(
        `bl attach: ${feature.id} is ${feature.status}, and its branches do not span ` +
          `${repo} (${storyId}'s repo); they span ${repos.join(', ') || 'none'}. ` +
          `Bring the repo in with bl side ${repo} --from ${feature.id}.`,
      );
    }
  }

  const held = joinRefusal(config, [storyId], feature.id);
  if (held) fail(`bl attach: ${held}.`);

  // `feature: F77` names F-77 already; it is not rewritten.
  const changed = (normalizeFeatureId(named)?.id ?? named) !== feature.id;
  const undoStory = snapshot(config.backlogRoot, [found.indexPath], ` of ${storyId}'s feature line`);
  if (changed) {
    try {
      await updateSpecFile(config.backlogRoot, found.indexPath, (specFm) => {
        // An empty `feature:` key is filled in place; a missing one goes last.
        specFm.feature = feature.id;
      });
    } catch (e) {
      fail(`bl attach: could not write ${storyId}: ${e.message}. Nothing was changed.`);
    }
  }
  let edgePaths;
  try {
    // A run edge between it and a story of the feature is now an order edge
    // (F-111 D5). A story already in the feature gets this too, so a rerun
    // after a failure between the two writes finishes the job.
    edgePaths = orderJoinedEdges(config, [storyId]);
  } catch (e) {
    // `e` names a file the edge write could not put back (`allOrNothing`), and `err` the story.
    const err = changed ? undoStory(e) : e;
    const state = e.left || err.unrecovered ? '' : ' Nothing was changed.';
    fail(`bl attach: could not turn ${storyId}'s run edges into order edges: ${err.message}.${state}`);
  }
  if (!changed && edgePaths === null) {
    info(`${storyId} is already in ${feature.id}; nothing to do.`);
  } else {
    info(changed ? `Attached ${storyId} to ${feature.id}.` : `${storyId} is already in ${feature.id}.`);

    if (noSync) {
      info("Skipped the commit. Commit it with 'bl sync --commit'.");
    } else {
      let res;
      try {
        res = await syncAndCommit(config, {
          message: `chore: attach ${storyId} to ${feature.id}`,
          storyIds: [storyId],
          extraPaths: edgePaths ?? [],
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
