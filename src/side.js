/**
 * side.js — `bl side`: a change to another repo, as a story with its worktree
 * (F-48 D1).
 *
 *   bl side <repo|C-id> --from <F-n|S-n> --title <t> --points <n>
 *           [--type chore|bug|feature] [--body-file <p>] [--json]
 *
 * The story is written by `bl new` itself, run as a child, so story creation
 * keeps one implementation; `bl side` then records `in_progress` and
 * `found_by: <from>` (D2), prepares the story's worktree and change document
 * entry, and commits the story, the feature file and the change document by
 * path under the backlog lock.
 *
 * Attach rule: the story joins a feature when `--from` is a feature that
 * `isFeatureWorkable` accepts, or a story of one, and its worktree is on the
 * feature's branch (`prepareFeatureRepo`). Otherwise it is a standalone story
 * on its own branch (`prepareStoryRepo`). Neither switches a main checkout.
 * A standalone side story gets no dependency edge to its `--from` story:
 * `found_by` is the link.
 *
 * Failures leave a coherent unit or nothing. Every refusal that can come
 * first does (arguments, the body, a new worktree's guards). The story, its
 * marks, the feature's list and the change document are written and
 * committed under one hold of the backlog lock (`bl new` works under it), so
 * no other bl commits a half-made story. A failure before that commit undoes
 * only what this run made: a worktree or branch it created that nobody took
 * up since, and backlog files nobody has committed. A standalone story's worktree comes after the
 * commit (its branch is the story's); when it fails, the committed story
 * stays and the message names the command that prepares the worktree.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { BL_PATH, describeExit, git, runBl } from './child.js';
import {
  loadConfig,
  configForRepo,
  parseArgs,
  parseFrontmatter,
  normalizeId,
  normalizeComponentId,
  componentIdHint,
  info,
  unitDirFor,
} from './config.js';
import {
  findComponentDir,
  findExistingWorktree,
  findStoryDir,
  homeComponent,
  readComponents,
  removeUnitDirIfEmpty,
} from './story.js';
import {
  featureBranchName,
  findFeature,
  isFeatureWorkable,
  normalizeFeatureId,
  resolveFeatureStories,
} from './feature.js';
import { featureRepoOrder } from './execution-plan.js';
import { loadFlow } from './flow.js';
import { applyTransition } from './transition.js';
import { prepareFeatureRepo } from './feature-cmd.js';
import { prepareStoryRepo } from './workon.js';
import { newWorktreeGuards } from './session.js';
import { hasFrontmatter } from './body.js';
import { removeBacklogPath, writeBacklogPathNow } from './atomic-write.js';
import { updateSpecFile } from './spec-file.js';
import { ensureChange, isChangeFile } from './change-doc.js';
import { unitFiles } from './backlog-graph.js';
import { insertAfter } from './template.js';
import { LOCK_FD_ENV, withLock } from './lock.js';
import { syncAndCommit, reportBacklogCommit } from './sync.js';

export const SIDE_JSON_SCHEMA = 'bl-side-json/v1';

const FIBONACCI = new Set(['1', '2', '3', '5', '8', '13']);
const TYPES = ['chore', 'bug', 'feature'];

const HELP = `Usage: bl side <repo|C-id> --from <F-n|S-n> --title <t> --points <n> [options]

A change to another repo, as a story with its worktree (F-48 D1). Creates the
story with bl new, records in_progress (by side) and found_by: <from>, prepares its
worktree and change document entry, and commits the backlog paths it wrote.

Arguments:
  repo                 A repo backlog.json registers: the story goes in its
                       home component
  C-id                 The story's component, used as given

Options:
  --from <F-n|S-n>     Required. The unit the session is working on; recorded
                       as found_by. A feature that is approved or later and
                       not closed, or a story of one, takes the side story in:
                       its worktree is on the feature's branch and the
                       feature's change.md gets the repo. Anything else (a
                       draft or refined feature, a standalone story) gives a
                       standalone story on its own branch with its own
                       change.md, and no dependency edge to --from.
  --title <t>          Required. Story title
  --points <n>         Required. Story points (1, 2, 3, 5, 8, 13)
  --type <t>           chore | bug | feature (default: chore)
  --body-file <path>   The story body, passed to bl new ("-" for stdin);
                       without it the template body stands
  --json               Print one JSON object (schema ${SIDE_JSON_SCHEMA}):
                       { schema, story, path, repo, branch, worktree, feature }
  --help               Show this help

stdout is one line, S-<n><TAB><worktree path>; progress goes to stderr.

Examples:
  bl side containers --from F-48 --title "Doc the session stack" --points 1
  bl side C32 --from S-1066 --type bug --title "Fix the lock" --points 2`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** A flag's string value, or null when unset; `true` (no value) fails. */
function flagValue(args, name, what) {
  const v = args[name];
  if (v == null || v === false) return null;
  if (v === true) fail(`bl side: --${name} requires ${what}`);
  return String(v);
}

/**
 * The story's component: a C-id as given, else the named repo's home
 * component. Exits naming an unknown repo or component, or one with no repo.
 */
function resolveComponent(raw, config) {
  const hint = componentIdHint(raw);
  if (hint) fail(`bl side: ${hint}`);
  const known = Object.keys(config.reposByName);
  const parsed = normalizeComponentId(raw);
  if (parsed) {
    const component = findComponentDir(parsed, config);
    if (!component) {
      const ids = readComponents(config).map((c) => c.id);
      fail(`bl side: component ${parsed.id} not found under components/. Existing: ${ids.join(', ') || '(none)'}`);
    }
    if (!component.repo) fail(`bl side: component ${component.id} has no repo: in its index.md.`);
    if (!config.reposByName[component.repo]) {
      fail(`bl side: ${component.id}'s repo ${component.repo} is not registered in backlog.json.`);
    }
    return component;
  }
  if (!config.reposByName[raw]) {
    fail(`bl side: unknown repo ${raw}. Known repos: ${known.join(', ') || 'none'}`);
  }
  const home = homeComponent(config, raw);
  if (!home) {
    fail(
      `bl side: repo ${raw} has no home component; name a component of it (C-<n>) ` +
        `or create the home: bl new --component --repo ${raw} --title … --home`,
    );
  }
  return home;
}

/**
 * The `--from` unit and the feature a side story joins: the feature itself,
 * or the story's feature, when it is workable; else none (standalone).
 *
 * @returns {{ fromId: string, feature: object | null }}
 */
function resolveFrom(raw, config) {
  const workable = (feature) => isFeatureWorkable(loadFlow(config.backlogRoot), feature.status);
  const featureId = normalizeFeatureId(raw);
  if (featureId) {
    const feature = findFeature(featureId, config);
    if (!feature) fail(`bl side: --from ${featureId.id}: no such feature under features/.`);
    return { fromId: feature.id, feature: workable(feature) ? feature : null };
  }
  const storyId = normalizeId(raw);
  if (!storyId) fail(`bl side: --from ${raw} is not a feature (F-<n>) or story (S-<n>) id.`);
  const found = findStoryDir(storyId, config);
  if (!found) fail(`bl side: --from ${storyId.id}: no such story under stories/.`);
  const { fm } = parseFrontmatter(readFileSync(found.indexPath, 'utf8'));
  const parent = normalizeFeatureId(String(fm.feature ?? '').trim());
  const feature = parent ? findFeature(parent, config) : null;
  return {
    fromId: storyId.id,
    feature: feature && workable(feature) ? feature : null,
  };
}

/**
 * The `--body-file` text (stdin for "-"), read and checked before anything
 * is written: a file that cannot be read (a directory, say) or that carries
 * frontmatter is refused here rather than by `bl new` after a worktree.
 */
function readSideBody(bodyFile) {
  if (bodyFile == null) return null;
  let text;
  try {
    text = readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8');
  } catch (e) {
    fail(`bl side: --body-file ${bodyFile} could not be read: ${e.message}`);
  }
  if (hasFrontmatter(text)) {
    fail(
      'bl side: --body-file contains frontmatter; remove it — bl manages frontmatter (component, story_id, title, etc.)',
    );
  }
  return text;
}

/**
 * Run `bl new … --no-sync --json` as a child, under this process's backlog
 * lock: `lock`'s locked descriptor is the child's fd 3, named in `BL_LOCK_FD`
 * (F-104 D5). The body goes on its stdin; return its JSON record.
 * The body and the JSON go through files: a Node child cannot use a socket
 * for its stdio inside Codex's sandbox (`runBl`, F-70 D1).
 */
function newStory({ feature, component, title, points, type, body, lock }) {
  const argv = [
    'new',
    ...(feature ? [feature.id] : []),
    component.id,
    `--title=${title}`,
    `--points=${points}`,
    `--type=${type}`,
    ...(body != null ? ['--body-file=-'] : []),
    '--no-sync',
    '--json',
  ];
  const res = runBl(BL_PATH, argv, {
    stdio: [body != null ? 'pipe' : 'ignore', 'pipe', 'inherit', lock.fd],
    ...(body != null ? { input: body } : {}),
    env: { ...process.env, [LOCK_FD_ENV]: '3' },
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) fail(`bl side: bl new failed: ${describeExit(res, 'bl new')}`);
  try {
    return JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    fail(`bl side: could not read bl new's JSON output: ${res.stdout.trim() || '(empty)'}`);
  }
}

/**
 * The new story's frontmatter: `in_progress` by `side` in its log (F-69 D3)
 * and `found_by` after `feature:` (after `added:` on a story with no
 * feature), written through `updateSpecFile` (F-67), inside the backlog lock
 * (the outer lock, D4).
 */
async function markSideStory(backlogRoot, indexPath, fromId) {
  const flow = loadFlow(backlogRoot);
  await updateSpecFile(backlogRoot, indexPath, (fm) => {
    applyTransition(flow, 'story', fm, 'in_progress', { by: 'side' });
    const out = insertAfter(fm, 'feature' in fm ? 'feature' : 'added', { found_by: fromId });
    // `updateSpecFile` serializes the object it passed in: refill it in `out`'s order.
    for (const key of Object.keys(fm)) delete fm[key];
    Object.assign(fm, out);
  });
}

/**
 * Steps that undo this run's work when the process exits with an error, run
 * newest first, then the recovery `hint`. A step returns nothing, or throws
 * with what it left behind; that is reported, never hidden.
 */
function undoOnFailure() {
  const steps = [];
  let hint = null;
  const run = (code) => {
    if (code === 0) return;
    for (const step of steps.reverse()) {
      try {
        step.fn();
      } catch (e) {
        console.error(`bl side: ${step.what} could not be undone (${e.message}). ${step.how}`);
      }
    }
    if (hint) console.error(hint);
  };
  // An `exit` listener runs (also after a signal: the signal-exit.js handler
  // calls process.exit) before the process ends and the kernel frees the
  // backlog lock (F-104). So the undo runs while the lock is still held and no
  // other bl sees (or commits) the half-made story.
  process.prependListener('exit', run);
  return {
    add: (what, how, fn) => steps.push({ what, how, fn }),
    clear: () => {
      steps.length = 0;
    },
    hint: (text) => {
      hint = text;
    },
  };
}

/**
 * Run `fn`, exiting 1 on a throw rather than rethrowing: the exit undoes
 * (`undoOnFailure`) while the caller's backlog lock is still held, where a
 * rethrow would let `withLock` release it first.
 */
async function exitOnThrow(fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(e.message ?? e);
    process.exit(1);
  }
}

/**
 * Undo for a worktree on `branch` in `repoPath`: removes the worktree, and the
 * branch, only when they did not exist before this call and nobody has taken
 * them up since. One that existed is someone's work and stays; so does one
 * `adopted()` claims (a committed story of the feature in the repo), one with
 * changes in it (`git worktree remove` without `--force` refuses) and a
 * branch with commits main does not have (`git branch -d` refuses). A removed
 * worktree's unit directory `unitDir` goes too, once no other worktree is in it.
 */
function worktreeUndo(repoPath, branch, unitDir, adopted = () => false) {
  const existed = findExistingWorktree(repoPath, branch) != null;
  const branchExisted = git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  return () => {
    if (existed || adopted()) return;
    const wt = findExistingWorktree(repoPath, branch);
    if (wt) {
      const r = git(repoPath, ['worktree', 'remove', wt.path]);
      if (r.status !== 0) throw new Error(r.stderr.trim());
      removeUnitDirIfEmpty(unitDir);
    }
    if (!branchExisted && git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) {
      const r = git(repoPath, ['branch', '-d', branch]);
      if (r.status !== 0) throw new Error(r.stderr.trim());
    }
  };
}

/**
 * The files `bl side` may write besides new story directories: the feature
 * directory's change documents (`isChangeFile`). It writes no index (F-79
 * D1), so the undo never restores the feature `index.md`: a restore could
 * only revert another session's write (F-126 Decision A1).
 */
function ownedFiles(featureDir) {
  if (!featureDir) return [];
  return readdirSync(featureDir)
    .filter((f) => isChangeFile(f) != null)
    .map((f) => join(featureDir, f));
}

/** The story directories' names (`unitFiles`), listed, never read. */
function storyEntries(root) {
  return unitFiles({ backlogRoot: root }, 'story').map((u) => u.entry);
}

/**
 * Undo for the backlog files `bl side` writes: new story directories go, and
 * every file in `ownedFiles` is put back as it was when the undo was made
 * (under the backlog lock), uncommitted edits made before then included; a
 * change document that was not there is removed. Nothing is touched once a
 * new story is tracked by git: someone committed it, and it is theirs to keep.
 *
 * The undo runs in a synchronous `exit` listener, so each change document is
 * put back inside its spec lock taken with one try (`writeBacklogPathNow`, F-126
 * Decision A1). A document whose lock another process holds is left as it
 * is, the others are still put back, and the thrown error names it.
 */
function backlogUndo(root, featureDir) {
  const storiesDir = join(root, 'stories');
  const storiesBefore = new Set(storyEntries(root));
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  const files = new Map(ownedFiles(featureDir).map((p) => [p, read(p)]));
  return () => {
    const added = storyEntries(root).filter((d) => !storiesBefore.has(d));
    const tracked = added.filter((d) => git(root, ['ls-files', '--', join('stories', d)]).stdout.trim() !== '');
    if (tracked.length > 0) {
      throw new Error(
        `${tracked.join(', ')} is committed, so it is left as it is; check it with bl validate and bl status`,
      );
    }
    const left = [];
    for (const p of new Set([...files.keys(), ...ownedFiles(featureDir)])) {
      const was = files.get(p) ?? null;
      if (read(p) === was) continue;
      try {
        writeBacklogPathNow(root, p, was);
      } catch (e) {
        left.push(`${relative(root, p)} is left as it is (${e.message})`);
      }
    }
    for (const d of added) removeBacklogPath(root, join(storiesDir, d));
    if (left.length > 0) throw new Error(left.join('; '));
  };
}

/**
 * Whether a committed story of `feature` is in `repo`: its worktree is then
 * the feature's, whoever prepared it. Read after the backlog undo, so this
 * run's own story no longer counts.
 */
function featureHasRepo(feature, repo, config) {
  const current = findFeature(normalizeFeatureId(feature.id), config);
  return current != null && featureRepoOrder(resolveFeatureStories(current, config).stories).includes(repo);
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Every refusal comes before anything is written.
  if (args.positional.length === 0) fail('bl side: name the repo or component (C-<n>) the change is in.');
  if (args.positional.length > 1) fail(`bl side takes one repo or component; got ${args.positional.join(', ')}.`);
  const target = String(args.positional[0]).trim();
  const fromRaw = flagValue(args, 'from', 'the unit being worked on (F-<n> or S-<n>)');
  if (fromRaw == null) fail('bl side: --from <F-n|S-n> is required: the unit the session is working on.');
  const title = flagValue(args, 'title', 'a title');
  if (title == null || title.trim() === '') fail('bl side: --title <t> is required.');
  const points = flagValue(args, 'points', 'a number');
  if (points == null) fail('bl side: --points <n> is required (1 2 3 5 8 13).');
  if (!FIBONACCI.has(points.trim())) fail(`bl side: --points ${points} is not one of 1 2 3 5 8 13.`);
  const type = flagValue(args, 'type', 'chore, bug or feature') ?? 'chore';
  if (!TYPES.includes(type)) fail(`bl side: --type ${type} is not one of ${TYPES.join(', ')}.`);
  const bodyFile = flagValue(args, 'body-file', 'a path (or "-" for stdin)');
  if (bodyFile != null && bodyFile !== '-' && !existsSync(bodyFile))
    fail(`bl side: --body-file ${bodyFile} not found.`);
  const jsonMode = args.json === true;
  const body = readSideBody(bodyFile);

  const config = loadConfig();
  const component = resolveComponent(target, config);
  const repo = component.repo;
  const { fromId, feature } = resolveFrom(fromRaw.trim(), config);
  const cfg = configForRepo(config, repo);
  const repoPath = config.reposByName[repo];
  const featureBranch = feature ? featureBranchName(feature.featureEntry) : null;

  // A new worktree's guards (uncommitted changes, local main ahead) run
  // before anything is written. A standalone story's branch is always new.
  if (!feature || !findExistingWorktree(repoPath, featureBranch)) await newWorktreeGuards(repoPath);

  const undo = undoOnFailure();
  let worktree = null;
  if (feature) {
    info(`Side story for ${feature.id} in ${repo} (${component.id}), found by ${fromId}`);
    undo.add(
      `the worktree on ${featureBranch} in ${repo}`,
      `Remove it with \`git -C ${repoPath} worktree remove --force <path>\` once nothing in it is wanted.`,
      worktreeUndo(repoPath, featureBranch, unitDirFor(config, featureBranch), () =>
        featureHasRepo(feature, repo, config),
      ),
    );
    worktree = (await prepareFeatureRepo(config, feature, repo, { strict: true })).worktreePath;
  } else {
    info(`Standalone side story in ${repo} (${component.id}), found by ${fromId}`);
  }

  let created;
  let storyId;
  let found;
  await withLock(cfg.backlogRoot, async (lock) =>
    exitOnThrow(async () => {
      // The worktree prepared before the lock may be gone: another bl side that
      // failed in the meantime removes one it made and nobody had committed to.
      if (feature && !findExistingWorktree(repoPath, featureBranch)) {
        fail(
          `bl side: the worktree on ${featureBranch} in ${repo} was removed while bl side waited for the backlog lock (another bl side failed); nothing was written. Run bl side again.`,
        );
      }
      // Re-read under the lock: the feature's files are the ones to keep.
      const featureDir = feature ? findFeature(normalizeFeatureId(feature.id), cfg).featureDir : null;
      undo.add(
        "the new story and the feature's files",
        'Compare them with `git -C <backlog> status`, and remove or restore what is left.',
        backlogUndo(cfg.backlogRoot, featureDir),
      );
      created = newStory({ feature, component, title: title.trim(), points: points.trim(), type, body, lock });
      storyId = created.id;
      const indexPath = join(cfg.backlogRoot, created.path);
      found = findStoryDir(normalizeId(storyId), cfg);
      if (!found) fail(`bl side: bl new reported ${storyId} at ${created.path}, but it is not there.`);
      const branch = feature ? featureBranch : found.storyEntry.toLowerCase();
      await markSideStory(cfg.backlogRoot, indexPath, fromId);
      let changePath;
      if (feature) {
        // The feature's repos are its stories' (F-52 D3), the side story now
        // among them; the change document's entries take that order.
        const current = findFeature(normalizeFeatureId(feature.id), cfg);
        const { stories } = resolveFeatureStories(current, cfg);
        const names = featureRepoOrder(stories);
        changePath = (
          await ensureChange(cfg.backlogRoot, current.featureDir, {
            changeOf: current.id,
            title: current.title,
            repos: names.map((r) => ({ repo: r, branch })),
          })
        ).path;
      } else {
        changePath = (
          await ensureChange(cfg.backlogRoot, found.storyDir, {
            changeOf: storyId,
            title: title.trim(),
            repos: [{ repo, branch }],
          })
        ).path;
      }
      const res = await syncAndCommit(cfg, {
        message: `chore: add ${storyId} (bl side, found by ${fromId})`,
        storyIds: [storyId],
        extraPaths: [relative(cfg.backlogRoot, changePath)],
      });
      // The story and the change document are whole now;
      // a failed commit is finished by hand, not undone.
      undo.clear();
      if (!feature)
        undo.hint(
          `bl side: ${storyId} is written; once it is committed, \`bl implement ${storyId}\` prepares its worktree. Running bl side again would add another story.`,
        );
      reportBacklogCommit(res, 'bl side');
    }),
  );

  const branch = feature ? featureBranch : found.storyEntry.toLowerCase();
  if (!feature) {
    // A standalone story's branch is named after it, so its worktree comes
    // after the commit. When it fails, the committed story stays.
    undo.hint(
      `bl side: ${storyId} is committed, but its worktree could not be prepared (above). Fix that, then \`bl implement ${storyId}\` prepares it. Running bl side again would add another story.`,
    );
    worktree = (await prepareStoryRepo(normalizeId(storyId), found, cfg, repo, { strict: true })).worktreePath;
  }
  undo.hint(null);

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        schema: SIDE_JSON_SCHEMA,
        story: storyId,
        path: created.path,
        repo,
        branch,
        worktree,
        feature: feature?.id ?? null,
      }) + '\n',
    );
  } else {
    process.stdout.write(`${storyId}\t${worktree}\n`);
  }
}
