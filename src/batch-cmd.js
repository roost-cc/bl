/**
 * batch-cmd.js — `bl batch S-a S-b … --title <t>` (F-125 D1): build a story
 * batch, approved, from refined stories, and run the cross-story pass.
 *
 * 1. Check the stories before anything is written. Each must be refined and
 *    not started, in no feature and in no batch, and not held at its `run`
 *    gate by work outside the batch (`heldBy`). A refusal names each story
 *    and its reason. A run edge between two of the stories becomes an order
 *    edge when they join (F-111 D5), so it holds nothing.
 * 2. Under the backlog lock: write `batches/B<n>-<slug>/index.md` from
 *    `templates/batch.md` with its `approved` transition by `new` (the flow's
 *    initial `batch` status), write `batch: B-<n>` on each story, turn the run
 *    edges between them into order edges, and commit.
 * 3. The cross-story pass: one headless session on `prompts/batch-build.md`
 *    in the backlog root, under the work unit locks of the batch and its
 *    stories. It may correct the stories' Implementation Plans and add order
 *    edges between them (`bl block add`, which commits `blockers.json`).
 * 4. Commit what the session changed in the batch's and its stories'
 *    directories (`commitChangedSince`, as a refine does).
 *
 * A batch needs no `bl approve`: it is approved when it is built.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { info, loadConfig, normalizeId, parseArgs, slugify } from './config.js';
import { readAllStories } from './story.js';
import { loadFlow } from './flow.js';
import { applyNew } from './transition.js';
import { renderTemplate } from './template.js';
import { atomicWriteFile, removeBacklogPath } from './atomic-write.js';
import { updateSpecFile } from './spec-file.js';
import { withLock } from './lock.js';
import { heldBy, readUnits } from './blockers.js';
import { joinRefusal, orderJoinedEdges } from './block.js';
import { BATCHES_DIR, findBatch, normalizeBatchId } from './batch.js';
import { graphOf } from './backlog-graph.js';
import { DEFAULT_REVIEW_ROUNDS_MAX } from './feature.js';
import { batchUnit } from './unit.js';
import { takeUnitLocksOrExit } from './unit-lock.js';
import { loadPrompt, runHeadlessSession } from './session.js';
import { sessionEffort } from './effort.js';
import { commitChangedSince, dirtySnapshot } from './backlog-commit.js';
import { reportBacklogCommit, syncAndCommit } from './sync.js';

export const HELP = `Usage: bl batch <S-id> <S-id>... --title <t> [options]

Build a story batch (B-<n>): a work unit of refined stories bundled by theme
or component, each refined on its own. It is approved when it is built, and
bl run, implement, review, merge and status take B-<n> as they take a feature.

Arguments:
  <S-id>...            Two or more stories. Each must be refined, in no
                       feature and in no batch, and not held at its run gate
                       by work outside the batch.

Options:
  --title <t>          The batch's title (required)
  -A, --agent <id>     Agent provider for the cross-story pass
  --model <m>          Model of the -A configuration (needs -A)
  --help               Show this help

Writes batches/B<n>-<slug>/index.md and batch: B-<n> on each story, and
commits them. Then one headless agent session, the cross-story pass, makes
sure each story lists its files and adds an order edge (bl block add) for
each logical dependency between two of them; bl commits what it changed.`;

const today = () => new Date().toISOString().slice(0, 10);

/** The next batch id: one past the highest batch number in the backlog. */
function nextBatchId(config) {
  return `B-${Number(graphOf(config).maxNum('batch') ?? 0) + 1}`;
}

/**
 * Why `bl batch` refuses each of `ids` (`readAllStories` records `all`), as
 * one line per story and reason, with `batchId` the batch they would join.
 * Empty when every story may join (F-125 D1).
 * @param {object} config
 * @param {string[]} ids
 * @param {object[]} all
 * @param {string} batchId
 * @returns {string[]}
 */
export function batchRefusals(config, ids, all, batchId) {
  const flow = loadFlow(config.backlogRoot);
  const units = readUnits(config);
  const out = [];
  for (const id of ids) {
    const s = all.find((r) => r.id === id);
    if (!s) {
      out.push(`${id}: not found in the backlog.`);
      continue;
    }
    if (!(flow.meets('story', s.status, 'refined') && flow.isUnstarted('story', s.status))) {
      out.push(`${id}: it is ${s.status || 'without a status'}; a batch takes refined stories (bl refine ${id}).`);
    }
    if (s.feature) out.push(`${id}: it is in ${s.feature}.`);
    if (s.batch) out.push(`${id}: it is in ${s.batch}.`);
    // A run edge between two of them becomes an order edge (F-111 D5).
    for (const h of heldBy(config, id, 'run', { units })) {
      if (!ids.includes(h.edge.blocker)) out.push(`${id}: it is held at its run gate: ${h.line}`);
    }
  }
  const join = joinRefusal(config, ids, batchId);
  if (join) out.push(join);
  return out;
}

/** The stories as the prompt lists them: number, id, title, points and file. */
function storiesPlan(stories) {
  return stories.map((s, i) => `${i + 1}. ${s.id} — ${s.title} (${s.points} pts)\n   file: ${s.indexPath}`).join('\n');
}

/**
 * Write the batch and each story's `batch:` key, under the backlog lock the
 * caller holds, and turn the run edges between the stories into order edges.
 * A failed write restores every story written and removes the batch
 * directory, then throws. Returns the batch record and the paths to commit.
 */
async function writeBatch(config, { id, title, stories }) {
  const root = config.backlogRoot;
  const dir = join(root, BATCHES_DIR, `${normalizeBatchId(id).dirPrefix}-${slugify(title)}`);
  if (existsSync(dir)) throw new Error(`${relative(root, dir)} already exists`);
  const values = { batch_id: id, title, review_rounds_max: DEFAULT_REVIEW_ROUNDS_MAX, added: today() };
  // The flow's initial batch status, `approved`, by `new`; a FlowError names a flow without the type.
  applyNew(loadFlow(root), 'batch', values);
  const content = renderTemplate('batch', { values, vars: { batchId: id, title } });
  const before = new Map(stories.map((s) => [s.indexPath, readFileSync(s.indexPath, 'utf8')]));
  const written = [];
  try {
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(root, join(dir, 'index.md'), content);
    for (const s of stories) {
      await updateSpecFile(root, s.indexPath, (fm) => {
        fm.batch = id;
      });
      written.push(s.indexPath);
    }
    const edgePaths =
      orderJoinedEdges(
        config,
        stories.map((s) => s.id),
      ) ?? [];
    return { dir, edgePaths };
  } catch (err) {
    for (const p of written) atomicWriteFile(root, p, before.get(p));
    removeBacklogPath(root, dir);
    throw err;
  }
}

/**
 * The cross-story pass (F-125 D1): one headless session on `batch-build.md`
 * over the batch's stories, in the backlog root, under the work unit locks of
 * the batch and its stories. Commits what it changed in their directories.
 * Returns the session's result and whether the commit failed.
 */
async function crossStoryPass(config, batch, stories) {
  const root = config.backlogRoot;
  const owner = `batch ${batch.id}`;
  const lock = takeUnitLocksOrExit(config, [batch], owner);
  try {
    const before = dirtySnapshot(root);
    const prompt = loadPrompt(
      'batch-build',
      {
        batchId: batch.id,
        title: batch.title,
        batchAbsPath: batch.indexPath,
        storiesPlan: storiesPlan(stories),
        // The shared commit flow names each story by itself.
        storyId: '<its story>',
        backlogDir: root,
        roostDir: config.roostDir,
      },
      { agent: config.agent, config },
    );
    info(`\nCross-story pass on ${batch.id} (${config.agent})...`);
    const result = await runHeadlessSession({
      mode: 'refine',
      parsed: { id: batch.id, num: normalizeBatchId(batch.id).num },
      prompt,
      worktreePath: root,
      agent: config.agent,
      config,
      roostDir: config.roostDir,
      backlogRoot: root,
      label: `${batch.id}: cross-story pass`,
      model: config.agentModel ?? null,
      effort: sessionEffort(config, { mode: 'refine' }),
      units: [batch],
    });
    const failed = await commitChangedSince(root, before, `chore: ${batch.id} cross-story pass`, {
      session: true,
      owner,
      scope: lock.scope,
    });
    return { result, failed };
  } finally {
    lock.release();
  }
}

/** `bl batch S-a S-b … --title <t>`. */
export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  const fail = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) fail('bl batch: --title is required.');
  const ids = [];
  for (const raw of args.positional) {
    const parsed = normalizeId(raw);
    if (!parsed) fail(`bl batch: ${raw} is not a story id (expected S-34).`);
    if (!ids.includes(parsed.id)) ids.push(parsed.id);
  }
  if (ids.length < 2) fail('bl batch: give two or more stories; one story runs on its own (bl run S-n).');

  const config = loadConfig({ agent: args.agent, model: args.model });
  const root = config.backlogRoot;
  // Checked once before the lock, for a quick answer, and again under it,
  // where nothing else writes.
  const check = () => {
    const refusals = batchRefusals(config, ids, readAllStories(config), nextBatchId(config));
    if (refusals.length > 0) fail(`bl batch: refused; nothing written.\n${refusals.map((r) => `  ${r}`).join('\n')}`);
  };
  check();

  let built;
  try {
    built = await withLock(root, async () => {
      check();
      const id = nextBatchId(config);
      const stories = ids.map((sid) => readAllStories(config).find((s) => s.id === sid));
      const { dir, edgePaths } = await writeBatch(config, { id, title, stories });
      return { id, dir, edgePaths };
    });
  } catch (err) {
    fail(`bl batch: ${err.message}. Nothing written.`);
  }
  const batch = batchUnit(findBatch(normalizeBatchId(built.id), config));
  const rel = relative(root, batch.indexPath);
  info(`New story batch: ${batch.id} — ${batch.title}`);
  info(`Created: ${rel}`);
  info(`Joined : ${ids.join(', ')}`);
  reportBacklogCommit(
    await syncAndCommit(config, {
      message: `chore: add ${batch.id}`,
      storyIds: ids,
      extraPaths: [relative(root, built.dir), ...built.edgePaths],
    }),
    'bl batch',
  );

  const stories = ids.map((sid) => readAllStories(config).find((s) => s.id === sid));
  const { result, failed } = await crossStoryPass(config, batch, stories);
  if (result.isError) {
    console.error(
      `bl batch: the cross-story pass did not finish (${result.error ?? `exit ${result.status}`}). ${batch.id} is built; check its stories' plans and order edges by hand (bl block list ${ids[0]}).`,
    );
    process.exit(1);
  }
  if (result.output.trim()) info(`\n${result.output.trim()}`);
  if (failed) process.exit(1);
  info(`\nNext: bl run ${batch.id}`);
  process.stdout.write(`${rel}\n`);
}
