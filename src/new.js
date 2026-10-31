/**
 * new.js — create a new backlog story, a component (`--component` with no
 * C-id), a feature (`--feature` with no F-id), a theme (`--theme <slug>` on
 * its own) or an epic (`--epic` with no E-id, under `--theme <slug>`).
 *
 * `bl new F-3 …` and `bl new C10 …` name the story's feature and component by
 * positional id, as `--feature F-3` and `--component C10` do. `bl new --feature
 * --title t S-1 S-2` creates a feature and moves S-1 and S-2 into it.
 * `bl new --component --repo r --title t` creates `components/C<n>-<slug>/`.
 * `bl new --theme s --title t` creates `themes/<s>/`, and `bl new --epic
 * --theme s --title t` creates `epics/E<n>-<slug>/` (F-51 D2).
 *
 * A story's component names its code boundary, and the story's repo is the
 * component's repo (F-49 D4); no repo is written on the story (F-52 D1). Prompts for the component (when none is named),
 * title and points. Assigns the next globally-unique story ID. Unless
 * --no-sync or --dry-run, syncs and commits the new stories (plus a new
 * component dir, an appended feature file and the rewritten indexes) inside
 * the lock hold that allocated the IDs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'fs';
import { join, dirname, relative, isAbsolute, resolve } from 'path';
import * as readline from 'readline';
import {
  loadConfig,
  parseFrontmatter,
  parseFrontmatterOf,
  slugify,
  parseArgs,
  resolvePlugins,
  configForRepo,
  repoOf,
  runPlugins,
  info,
  warn,
  normalizeComponentId,
  componentIdHint,
  COMPONENTS_DIR,
  STORIES_DIR,
  THEMES_DIR,
  EPICS_DIR,
} from './config.js';
import { THEME_ID_RE, findTheme, findNextEpicNum, normalizeEpicId, readAllThemes, splitBriefEntry } from './theme.js';
import {
  findMaxStoryNum,
  findNextComponentNum,
  findComponentDir,
  homeComponent,
  normalizeId,
  readAllStories,
  readComponents,
  pathEntryProblem,
} from './story.js';
import { renderTemplate, templatePath } from './template.js';
import {
  normalizeFeatureId,
  findFeature,
  appendStoriesToFeature,
  closedFeatureRefusal,
  storyMoveRefusal,
} from './feature.js';
import { acquireLock } from './lock.js';
import { syncAndCommit, reportBacklogCommit } from './sync.js';
import { prepareBody } from './body.js';
import { validateSpec, SpecError } from './spec.js';
import { resolveTargets } from './targets.js';
import { failPoint, settle, writeRecord } from './feature-links.js';
import { atomicWriteFile } from './atomic-write.js';
import { updateSpecFile } from './spec-file.js';
import { loadFlow } from './flow.js';

const FIBONACCI = new Set([1, 2, 3, 5, 8, 13]);

// `parseArgs` represents an unset flag as `undefined`/null and a flag passed
// without a value as `true`. This helper means "set to something" — used for
// disallowed-flag checks where any presence (boolean or value) is rejected.
const isFlagSet = (v) => v != null && v !== false;

// `relative()` returns `../../...` when cwd is unrelated to the target. Print
// the absolute path in that case — it's noisy but at least unambiguous.
function prettyRelPath(p) {
  const rel = relative(process.cwd(), p);
  if (!rel || rel.startsWith('..')) return p;
  return rel;
}

/**
 * Read and preprocess --body-file content.
 *
 * Returns null if --body-file is not set. Otherwise reads the file (or
 * stdin when path is "-"), validates required flags for stdin mode,
 * rejects frontmatter, strips HTML comments outside fenced code blocks,
 * and returns the cleaned body. Variable substitution is deferred until
 * later when storyId/title/etc are known.
 */
function readBodyFile(args, required = ['title', 'points']) {
  if (args['body-file'] == null) return null;
  if (args['body-file'] === true) {
    console.error('--body-file requires a path (use "-" for stdin)');
    process.exit(1);
  }
  const path = String(args['body-file']);

  if (path === '-') {
    for (const flag of required) {
      if (args[flag] == null || args[flag] === true) {
        console.error(`--body-file - requires --${flag} on the command line (no prompts in stdin mode).`);
        process.exit(1);
      }
    }
    const named = ['component', 'repo', 'plugins-from'].some((k) => isFlagSet(args[k]));
    if (required.includes('points') && !named) {
      console.error(
        '--body-file - requires a component (C-<n>), --repo or --plugins-from on the command line (no prompts in stdin mode).',
      );
      process.exit(1);
    }
  }

  let text;
  try {
    text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Failed to read --body-file ${path}: ${err.message}`);
    process.exit(1);
  }

  try {
    return prepareBody(text);
  } catch (err) {
    if (err.code === 'BODY_HAS_FRONTMATTER') {
      console.error(
        '--body-file contains frontmatter; remove it — bl manages frontmatter (component, story_id, title, etc.)',
      );
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Validate `--plugins-from <S-id>` and normalise the id (`s-870` → `S-870`)
 * with the shared `normalizeId`, which keeps the digit sequence as written
 * (`S-01` stays `S-01`, the `story_id` it must match). Returns null when the
 * flag is unset; exits 1 on a missing value or a malformed id. The lookup
 * itself is `lookupPluginsFrom` (S-870).
 */
function parsePluginsFromId(args) {
  const raw = args['plugins-from'];
  if (!isFlagSet(raw)) return null;
  if (raw === true) {
    console.error('--plugins-from requires a story id (e.g. S-870)');
    process.exit(1);
  }
  const parsed = normalizeId(String(raw).trim());
  if (!parsed) {
    console.error(`invalid --plugins-from story id: '${raw}' (expected S-<n>)`);
    process.exit(1);
  }
  return parsed.id;
}

/**
 * Find the `--plugins-from` source story and collect its `plugins` /
 * `plugins-<stage>` keys and their parsed values, in file order (the new
 * story's block is written by `serializeFrontmatter`, F-62 D3). Exits 1 when
 * the story does not exist or when
 * more than one story record carries the id: there is no rule for which
 * copy wins, so none does. Called once before the lock, so an unknown id
 * fails without touching the backlog, and again under the lock, so the
 * keys and component actually copied are the source's state at creation
 * time rather than what a creator saw while it waited for the lock.
 *
 * `repo` is the source story's repo, its component's (`unitRepo`, F-52 D1).
 *
 * @returns {{ id: string, repo: string, componentId: string, plugins: object }}
 */
function lookupPluginsFrom(id, cfg) {
  const matches = readAllStories(cfg).filter((s) => s.id === id);
  if (matches.length === 0) {
    console.error(`--plugins-from ${id}: story not found`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(
      `--plugins-from ${id}: ambiguous, ${matches.length} stories carry this id: ` +
        matches.map((s) => s.storyRelPath).join(', '),
    );
    process.exit(1);
  }
  const source = matches[0];
  const { fm } = parseFrontmatterOf(readFileSync(source.indexPath, 'utf8'), source.indexPath);
  const plugins = Object.fromEntries(Object.entries(fm).filter(([k]) => /^plugins(-.*)?$/.test(k)));
  return {
    id,
    repo: source.unitRepo,
    componentId: source.componentId,
    plugins,
  };
}

/**
 * The frontmatter keys to copy from a `--plugins-from` source into the new
 * story: its plugin keys and values when both stories share a repo (their
 * components'). Different repos (or a source with no repo) copy nothing and
 * say so on stderr; a source with no plugin keys is silent.
 *
 * @returns {object} zero or more `plugins` / `plugins-<stage>` keys
 */
function pluginsFrom(source, primaryRepo) {
  if (!source || Object.keys(source.plugins).length === 0) return {};
  if (!source.repo || source.repo !== primaryRepo) {
    console.error(
      `--plugins-from ${source.id}: repo ${source.repo || '(none)'} ` +
        `differs from ${primaryRepo || '(none)'}; plugins not copied`,
    );
    return {};
  }
  return source.plugins;
}

/**
 * Resolve a C-id to its component, or exit 1: an E-id gets the hint that
 * components are C-ids, an unknown id the components that exist.
 */
function resolveComponentRef(raw, config, { onError } = {}) {
  const fail = (msg) => {
    console.error(msg);
    if (onError) onError();
    process.exit(1);
  };
  const parsed = normalizeComponentId(String(raw).trim());
  if (!parsed) {
    fail(componentIdHint(raw) ?? `invalid component id: '${raw}' (expected C-<n>)`);
  }
  const hit = findComponentDir(parsed, config);
  if (!hit) {
    const known = readComponents(config).map((c) => c.id);
    fail(`Component ${parsed.id} not found under components/. Existing: ${known.join(', ') || '(none)'}`);
  }
  return hit;
}

/**
 * Resolve `--feature <id>` (or a spec's `feature`) to a live feature record.
 * Exits 1 on an unknown/closed feature — a story tagged with a dead feature
 * would fail `bl validate` immediately, so refuse up front.
 */
function resolveFeatureRef(raw, config, { onError } = {}) {
  const fail = (msg) => {
    console.error(msg);
    if (onError) onError();
    process.exit(1);
  };
  if (raw === true) fail('--feature requires a feature ID (e.g. F-3)');
  const parsed = normalizeFeatureId(String(raw));
  if (!parsed) fail(`invalid feature id: '${raw}' (expected F-<n>)`);
  const feature = findFeature(parsed, config);
  if (!feature) fail(`Feature ${parsed.id} not found under features/.`);
  const closed = closedFeatureRefusal(feature, loadFlow(config.backlogRoot));
  if (closed) fail(closed);
  return feature;
}

/**
 * Fold the positional ids into the flags they stand for (F-35 Design §6):
 * an F-id is `--feature F-n`, a C-id is `--component C-n`, and S-ids are
 * the stories the `--feature` switch moves into the feature it creates.
 * Exits 1 on an unknown id, a second F- or C-id, or a flag that names
 * another feature or component than the positional.
 *
 * @returns {object[]} the listed stories' `readAllStories` records
 */
function foldPositionals(args, config) {
  if (args.positional.length === 0) return [];
  const fail = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  const hints = args.positional.map(componentIdHint).filter(Boolean);
  if (hints.length > 0) fail(hints.join('\n'));
  const { targets, errors } = resolveTargets(args.positional, config, null);
  for (const e of errors) console.error(e);
  if (errors.length > 0) process.exit(1);
  const ofKind = (kind) => targets.filter((t) => t.kind === kind);
  const features = ofKind('feature');
  const components = ofKind('component');
  const stories = ofKind('story');
  const ids = (ts) => ts.map((t) => t.id).join(', ');

  if (features.length > 1) fail(`bl new takes one feature id; got ${ids(features)}.`);
  if (components.length > 1) fail(`bl new takes one component id; got ${ids(components)}.`);
  if (stories.length > 0 && args.feature !== true && features.length === 0) {
    fail(
      `bl new takes story ids only with --feature, which creates a feature holding them: ` +
        `bl new --feature --title … ${ids(stories)}`,
    );
  }
  if (stories.length > 0 && features.length > 0) {
    fail(`bl new ${features[0].id} creates a story in ${features[0].id}; it takes no story ids (${ids(stories)}).`);
  }
  if (args.feature === true && features.length === 0 && components.length > 0) {
    fail(
      `bl new --feature creates a feature from stories, not from a component: list the stories ` +
        `(bl new --feature --title … S-1 S-2).`,
    );
  }
  if (args.component === true && (features.length > 0 || components.length > 0 || stories.length > 0)) {
    fail(`bl new --component creates a component; it takes no ids (${ids(targets)}).`);
  }

  if (features.length === 1) {
    const { id } = features[0];
    if (typeof args.feature === 'string' && normalizeFeatureId(args.feature)?.id !== id) {
      fail(`${id} and --feature ${args.feature} disagree; name the feature once.`);
    }
    args.feature = id;
  }
  if (components.length === 1) {
    const { id } = components[0];
    if (typeof args.component === 'string' && normalizeComponentId(args.component)?.id !== id) {
      fail(`${id} and --component ${args.component} disagree; name the component once.`);
    }
    args.component = id;
  }
  return stories.map((t) => t.record);
}

/**
 * `bl new --feature --title t [S-1 S-2 …]`: scaffold a feature
 * (`cmdNew`) and move the listed stories into it: `feature:` on each, and
 * appended to its `stories:`. Every story is checked under the backlog lock,
 * before anything is written: it must be `backlog` or `refined` and in no
 * other feature. A repair record (feature-links.js) is written before the
 * first story, so a failure the rollback cannot undo is settled by the next
 * bl command.
 */
async function newFeature(args, stories) {
  if (args.json === true) {
    console.error('--json is not supported when --feature creates a feature.');
    process.exit(1);
  }

  const config = loadConfig();
  const { cmdNew } = await import('./feature-cmd.js');
  return cmdNew(args, config, {
    beforeCreate: () => {
      // Each story file is read again here: a record read before the lock
      // may already be in a feature another `bl new --feature` made.
      const flow = loadFlow(config.backlogRoot);
      const refusals = [];
      for (const s of stories) {
        const { fm } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
        const refusal = storyMoveRefusal(s.id, fm, null, flow);
        if (refusal) refusals.push(refusal);
      }
      for (const r of refusals) console.error(r);
      if (refusals.length > 0) process.exit(1);
    },
    afterCreate: (feature) => {
      if (stories.length === 0) return;
      // Each story's bytes before its rewrite go in the repair record first. A
      // failed write is settled at once: restore every story and rethrow so
      // cmdNew removes the feature. A story that cannot be restored still
      // names the feature, so the feature is kept and the record stays.
      const root = config.backlogRoot;
      const record = writeRecord(root, {
        feature: feature.id,
        dir: relative(root, dirname(feature.indexPath)),
        stories: stories.map((s) => ({
          id: s.id,
          path: relative(root, s.indexPath),
          before: readFileSync(s.indexPath, 'utf8'),
        })),
      });
      try {
        // One spec lock at a time, inside the backlog lock (F-67 D4).
        for (const s of stories) {
          updateSpecFile(root, s.indexPath, (fm) => {
            // An empty `feature:` key is filled in place; a missing one goes last.
            fm.feature = feature.id;
            failPoint(s.id);
          });
        }
        failPoint('list');
        appendStoriesToFeature(
          root,
          feature,
          stories.map((s) => s.id),
        );
      } catch (err) {
        let state, left;
        try {
          ({ state, left } = settle(root, record));
        } catch (settleErr) {
          // Unsettled: the feature and the record stay for the next command.
          err.keepFeature = true;
          err.message += `; could not settle ${relative(root, record)} (${settleErr.message}): the next bl command retries`;
          throw err;
        }
        if (state === 'rolled back') throw err;
        err.keepFeature = true;
        if (state === 'complete') err.message += `; ${feature.id} and its stories are linked both ways`;
        else if (state === 'listed') {
          err.message +=
            `; could not restore ${left.join(', ')}, so ${feature.id} is kept and lists it; ` +
            `the next bl command rolls it back`;
        } else {
          err.message +=
            `; could not restore ${left.join(', ')} or list it in ${feature.id}: ` +
            `the next bl command repairs it (${relative(root, record)})`;
        }
        throw err;
      }
      try {
        unlinkSync(record);
      } catch {
        // The links are complete: the next command finds them so and drops it.
      }
    },
  });
}

/** Flags `bl new --component` refuses: they describe a story, not a component. */
const COMPONENT_DISALLOWED_FLAGS = ['points', 'type', 'feature', 'depends-on', 'required-for', 'plugins-from', 'from'];

/**
 * The globs of a `--paths <glob,…>` argument: split at each comma outside a
 * `{…}` brace group (`{src,test}/**` is one glob), each trimmed. An empty
 * glob is kept, for `pathEntryProblem` to refuse; one trailing comma is no
 * glob. This reads a command-line argument, not frontmatter.
 * @returns {string[]}
 */
export function splitGlobs(arg) {
  const out = [''];
  let depth = 0;
  for (const ch of arg) {
    if (ch === ',' && depth === 0) {
      out.push('');
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    out[out.length - 1] += ch;
  }
  const globs = out.map((s) => s.trim());
  if (globs.length > 1 && globs.at(-1) === '') globs.pop();
  return globs.length === 1 && globs[0] === '' ? [] : globs;
}

/**
 * `bl new --component --repo r --title t [--paths <glob,…>] [--home] [--body-file p]`:
 * create `components/C<n>-<slug>/index.md` with the next component number. The
 * repo must be one backlog.json registers; `--home` makes it the repo's home
 * component (F-49 D4), refused when the repo already has one. `--paths` is
 * optional (F-61 D2): globs relative to the repo root, written inline, each
 * checked. Without it the component has no `paths:` key, never an implied `**`.
 */
async function newComponent(args, jsonMode) {
  for (const flag of COMPONENT_DISALLOWED_FLAGS) {
    if (isFlagSet(args[flag])) {
      console.error(`--${flag} is not allowed with --component, which creates a component.`);
      process.exit(1);
    }
  }
  const config = loadConfig();
  const known = Object.keys(config.reposByName);
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (!repo) {
    console.error(`bl new --component: pass --repo <name> (known repos: ${known.join(', ') || 'none'}).`);
    process.exit(1);
  }
  if (!config.reposByName[repo]) {
    console.error(`Unknown repo: ${repo}. Known repos: ${known.join(', ') || 'none'}`);
    process.exit(1);
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    console.error('bl new --component: --title is required.');
    process.exit(1);
  }
  const paths = isFlagSet(args.paths) ? (typeof args.paths === 'string' ? splitGlobs(args.paths) : []) : undefined;
  if (paths?.length === 0) {
    console.error(
      'bl new --component: --paths takes <glob,…>, the globs it covers relative to the repo root (e.g. --paths "src/**,test/**"); leave it out for a component with no map.',
    );
    process.exit(1);
  }
  for (const glob of paths ?? []) {
    const problem = pathEntryProblem(glob);
    if (problem) {
      console.error(
        `bl new --component: --paths entry "${glob}" ${problem}; an entry is a glob relative to the repo root.`,
      );
      process.exit(1);
    }
  }
  const home = args.home === true;
  const customBody = readBodyFile(args, ['title', 'repo']);

  await acquireLock(config.backlogRoot);
  if (home) {
    const existing = homeComponent(config, repo);
    if (existing) {
      console.error(`Repo ${repo} already has a home component, ${existing.id}; a repo has exactly one.`);
      process.exit(1);
    }
  }
  const componentId = `C${String(findNextComponentNum(config)).padStart(2, '0')}`;
  const dir = join(config.backlogRoot, COMPONENTS_DIR, `${componentId}-${slugify(title)}`);
  const indexPath = join(dir, 'index.md');
  const relPath = relative(config.backlogRoot, indexPath);
  if (existsSync(dir)) {
    console.error(`Component directory already exists: ${relative(config.backlogRoot, dir)}`);
    process.exit(1);
  }
  const content = renderTemplate('component', {
    values: { component_id: componentId, title, repo, home: home ? 'true' : undefined, paths },
    vars: { componentId, title, repo, paths: (paths ?? []).join(', ') },
    body: customBody,
  });
  mkdirSync(dir, { recursive: true });
  atomicWriteFile(config.backlogRoot, indexPath, content);
  info(`Created component: ${relPath}`);

  if (args['no-sync']) {
    info("Skipped sync. Run 'bl sync' to update indexes.");
  } else {
    info('\nSyncing backlog...');
    let res;
    try {
      res = await syncAndCommit(config, {
        message: `chore: add ${componentId}`,
        extraPaths: [relative(config.backlogRoot, dir)],
      });
    } catch (err) {
      console.error(
        `Component file created at ${relPath}. Sync failed: ${err.message}. Run 'bl sync' manually to update indexes.`,
      );
      process.exit(1);
    }
    reportBacklogCommit(res, 'bl new');
  }

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        schema: 'bl-new-component-json/v1',
        id: componentId,
        path: relPath,
        repo,
        home,
        paths: paths ?? null,
      }) + '\n',
    );
  } else {
    info(`\nDone. ${componentId} — ${title} (repo ${repo}${home ? ', home' : ''}).`);
    process.stdout.write(`${relPath}\n`);
  }
}

/** Flags `bl new --theme` and `bl new --epic` refuse: they describe a story or a component. */
const VALUE_UNIT_DISALLOWED_FLAGS = [...COMPONENT_DISALLOWED_FLAGS, 'component', 'repo', 'home', 'paths'];

/**
 * Refuse what a theme or an epic cannot take: story and component flags, and
 * any positional id. `what` names the unit for the message.
 */
function refuseNonValueFlags(args, what) {
  for (const flag of VALUE_UNIT_DISALLOWED_FLAGS) {
    if (isFlagSet(args[flag])) {
      console.error(`--${flag} is not allowed with ${what}.`);
      process.exit(1);
    }
  }
  if (args.positional.length > 0) {
    console.error(`bl new ${what.split(',')[0]} takes no ids (${args.positional.join(', ')}).`);
    process.exit(1);
  }
}

/**
 * Write a new theme or epic, then (unless --no-sync) sync and commit it.
 * Prints its path, or with --json one object of `schema`.
 */
async function writeValueUnit(config, args, jsonMode, { kind, id, title, dir, content, json }) {
  const indexPath = join(dir, 'index.md');
  const relPath = relative(config.backlogRoot, indexPath);
  mkdirSync(dir, { recursive: true });
  atomicWriteFile(config.backlogRoot, indexPath, content);
  info(`Created ${kind}: ${relPath}`);

  if (args['no-sync']) {
    info("Skipped sync. Run 'bl sync' to update indexes.");
  } else {
    info('\nSyncing backlog...');
    let res;
    try {
      res = await syncAndCommit(config, {
        message: `chore: add ${kind} ${id}`,
        extraPaths: [relative(config.backlogRoot, dir)],
      });
    } catch (err) {
      console.error(
        `${kind[0].toUpperCase()}${kind.slice(1)} file created at ${relPath}. Sync failed: ${err.message}. ` +
          `Run 'bl sync' manually to update indexes.`,
      );
      process.exit(1);
    }
    reportBacklogCommit(res, 'bl new');
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ...json, id, path: relPath }) + '\n');
  } else {
    info(`\nDone. ${id} — ${title}.`);
    process.stdout.write(`${relPath}\n`);
  }
}

/** `--title`, trimmed, or exit 1 naming `what`. */
function requireTitle(args, what) {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    console.error(`${what}: --title is required.`);
    process.exit(1);
  }
  return title;
}

/** The themes that exist, for an error message. */
function knownThemes(config) {
  return (
    readAllThemes(config)
      .map((t) => t.id)
      .join(', ') || '(none)'
  );
}

/**
 * `--brief <path,…>`, split on commas, or exit 1 naming the flag: a theme's
 * brief is required (F-53 D4). An entry whose file is not under the
 * backlog's parent directory warns here; `bl validate` reports it as `theme-brief`.
 */
function requireBrief(args, config) {
  const brief =
    typeof args.brief === 'string'
      ? args.brief
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  if (brief.length === 0) {
    console.error(
      'bl new --theme: --brief <path,…> is required: the documents an agent reads before working in the theme, ' +
        "relative to the backlog's parent directory, each with an optional #anchor (e.g. --brief app.acme.com/docs/public/tenets.md).",
    );
    process.exit(1);
  }
  for (const entry of brief) {
    const { file } = splitBriefEntry(entry);
    if (!existsSync(join(config.roostDir, file)))
      warn(`brief entry "${entry}": ${file} is not under ${config.roostDir}`);
  }
  return brief;
}

/**
 * `bl new --theme <slug> --title t --brief <path,…> [--body-file p]`:
 * create `themes/<slug>/index.md` (F-51 D1) with `repos: []`, a product
 * theme until someone lists the repos whose standalone stories belong to
 * it, and its brief (F-53 D4).
 */
async function newTheme(args, jsonMode) {
  refuseNonValueFlags(args, '--theme on its own, which creates a theme');
  const slug = String(args.theme).trim();
  if (!THEME_ID_RE.test(slug)) {
    console.error(
      `invalid theme id: '${slug}' (a slug: lowercase letters, digits and hyphens, starting with a letter)`,
    );
    process.exit(1);
  }
  const title = requireTitle(args, 'bl new --theme');
  const customBody = readBodyFile(args, ['title']);
  const config = loadConfig();
  const brief = requireBrief(args, config);

  await acquireLock(config.backlogRoot);
  const dir = join(config.backlogRoot, THEMES_DIR, slug);
  if (existsSync(dir)) {
    console.error(`Theme ${slug} already exists: ${relative(config.backlogRoot, dir)}`);
    process.exit(1);
  }
  const content = renderTemplate('theme', {
    values: { theme_id: slug, title, brief },
    vars: { themeId: slug, title },
    body: customBody,
  });
  await writeValueUnit(config, args, jsonMode, {
    kind: 'theme',
    id: slug,
    title,
    dir,
    content,
    json: { schema: 'bl-new-theme-json/v1' },
  });
}

/**
 * `bl new --epic --theme <slug> --title t [--body-file p]`: create
 * `epics/E<n>-<slug>/index.md` (F-51 D1) with the next epic number (E50
 * upward) under an existing theme. Its `features:` and `status:` are
 * derived by `bl sync`.
 */
async function newEpic(args, jsonMode) {
  refuseNonValueFlags(args, '--epic, which creates an epic');
  if (isFlagSet(args.brief)) {
    console.error('--brief belongs to a theme (bl new --theme <slug> --title <t> --brief <path,…>), not an epic.');
    process.exit(1);
  }
  if (!isFlagSet(args.theme)) {
    console.error('bl new --epic: pass --theme <slug>, the theme the epic serves.');
    process.exit(1);
  }
  const title = requireTitle(args, 'bl new --epic');
  const customBody = readBodyFile(args, ['title', 'theme']);
  const config = loadConfig();
  const slug = String(args.theme).trim();
  if (!findTheme(slug, config)) {
    console.error(`Theme ${slug} not found under themes/. Existing: ${knownThemes(config)}`);
    process.exit(1);
  }

  await acquireLock(config.backlogRoot);
  const epicId = `E${findNextEpicNum(config)}`;
  const dir = join(config.backlogRoot, EPICS_DIR, `${epicId}-${slugify(title)}`);
  if (existsSync(dir)) {
    console.error(`Epic directory already exists: ${relative(config.backlogRoot, dir)}`);
    process.exit(1);
  }
  const content = renderTemplate('epic', {
    values: { epic_id: epicId, title, theme: slug },
    vars: { epicId, title, theme: slug },
    body: customBody,
  });
  await writeValueUnit(config, args, jsonMode, {
    kind: 'epic',
    id: epicId,
    title,
    dir,
    content,
    json: { schema: 'bl-new-epic-json/v1', theme: slug },
  });
}

/**
 * A story template's frontmatter values (F-62 D3): `vars` under their keys,
 * `feature:` only when the story has one, never `found_by:` (`bl side` sets
 * it, F-48 D2), and a dependency list only when it is non-empty (the
 * template's empty key stays otherwise).
 */
function storyValues(vars, { feature = null, dependsOn = [], requiredFor = [] } = {}) {
  return {
    component: vars.componentId,
    story_id: vars.storyId,
    title: vars.title,
    type: vars.type,
    points: vars.points,
    added: vars.today,
    feature: feature?.id,
    found_by: undefined,
    ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
    ...(requiredFor.length > 0 ? { required_for: requiredFor } : {}),
  };
}

/**
 * Parse, validate, and de-duplicate raw --depends-on / --required-for values.
 *
 * Accepts either undefined, a single string, or an array of strings (any
 * value may itself be a comma- or whitespace-separated list). Tokens are
 * upper-cased, normalised to canonical `S-<n>` form, and validated against
 * `^S-?\d+$`. Throws on malformed tokens; the caller is expected to print
 * the error and exit.
 */
function normaliseDepIds(raw, fieldName) {
  if (raw == null || raw === true || raw === false) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const tokens = String(value)
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    for (const token of tokens) {
      const upper = token.toUpperCase();
      const m = upper.match(/^S-?(\d+)$/);
      if (!m) {
        const err = new Error(`invalid story id: '${token}' (expected S-<n>) for --${fieldName}`);
        err.code = 'BAD_DEP_ID';
        throw err;
      }
      const canonical = `S-${m[1]}`;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const jsonMode = args.json === true;

  if (args.help) {
    console.log(`Usage: bl new [F-id] [C-id] [options]
       bl new --feature --title <t> --theme <slug> [--epic <E-id>] [S-id…]
       bl new --component --repo <name> --title <t> [--paths <glob,…>] [--home]
       bl new --theme <slug> --title <t> --brief <path,…>
       bl new --epic --theme <slug> --title <t>

Arguments:
  F-id                 The story's feature, as --feature F-<n>
  C-id                 The story's component, as --component C<n>
  S-id…                With the --feature switch: stories (backlog or
                       refined, in no feature) to move into the new feature

Options:
  --component <id>     The story's component (C<n>): its code boundary. The
                       story's repo is the component's repo. Default:
                       the --plugins-from story's component, else the --repo
                       repo's home component; prompted on a terminal.
  --component          With no C-id: create a component instead of a story
                       (components/C<n>-<slug>/index.md, the next number).
                       Takes --repo (required, a repo backlog.json
                       registers), --title, --paths, --home
                       (the repo's home component, when it has none),
                       --body-file, --no-sync.
  --paths <glob,…>     With --component, optional: the globs the component
                       covers, relative to its repo root ("src/**,test/**").
                       A map for people and agents; nothing enforces it.
                       Without it the component has no paths: key.
  --title <t>          Story title
  --points <n>         Story points (1, 2, 3, 5, 8, 13)
  --type <t>           Story type (default: feature)
  -r, --repo <name>    The story's repo: picks that repo's home component
                       when no component is named; a repo other than the
                       component's is an error
  --feature <id>       Attach the story to a feature (F-<n>): sets
                       feature: in its frontmatter, appends it to the
                       feature's stories: list, and uses the shorter
                       story-feature template.
  --feature            With no F-id: create a feature instead of a story
                       (features/F<n>-<slug>/index.md), holding the S-ids
                       given. Takes --title, --theme (required, unless
                       --epic gives it), --epic, --repo (default: the
                       first story's repo), --rounds <n>, --body-file,
                       --no-sync.
  --theme <slug>       With --feature or --epic: the theme it belongs to.
                       On its own: create a theme (themes/<slug>/index.md,
                       repos: []). Takes --title, --brief (required),
                       --body-file, --no-sync.
  --brief <path,…>     With --theme on its own: the theme's brief, the
                       documents an agent reads before working in it,
                       relative to the backlog's parent directory, each with an
                       optional #anchor (MVP-Prototype/AI-SUMMARY.md#rooms).
  --epic <E-id>        With --feature: the feature's epic (E50 upward, in
                       the feature's theme).
  --epic               With no E-id: create an epic under --theme
                       (epics/E<n>-<slug>/index.md, the next number from
                       E50). Takes --title, --body-file, --no-sync.
  --plugins-from <id>  Copy the plugins / plugins-<stage> frontmatter keys
                       (e.g. plugins-test) of story S-<n> into the new
                       story when both have the same primary repo. Without
                       a component the new story takes that story's
                       component, so the keys are copied. A component in
                       another repo copies nothing and warns; an unknown id
                       fails before anything is written.
  --body-file <path>   Use file content as the body (or "-" for stdin).
                       Strips <!-- ... --> outside code fences. Errors
                       if the file contains frontmatter.
  --print-template <kind>
                       Print bl/templates/<kind>.md to stdout and exit.
                       kind ∈ {story, story-feature, component, feature,
                       change, theme, epic}.
                       No other flags required.
  --depends-on <ids>   Comma-separated story IDs this story depends on
                       (e.g. S-379,S-380). Repeatable. Unknown IDs warn.
  --required-for <ids> Comma-separated story IDs this story unblocks.
                       Repeatable. Unknown IDs warn.
  --json               Emit a JSON object describing the created story to
                       stdout (schema bl-new-json/v3). All other output
                       (sync chatter, plugin output) goes to stderr by
                       default — stdout stays JSON-only. Cannot be combined
                       with --print-template.
  --from <spec.json>   Batch mode: create N stories (and optionally a new
                       component) from a spec file. See bl agents (or
                       templates/spec.schema.md) for the schema. Mutually
                       exclusive with --title / --component / --body-file /
                       --depends-on / --type / --points / --repo /
                       --plugins-from.
  --dry-run            With --from: validate the spec, resolve placeholder
                       IDs, print the plan, and exit 0 without writing
                       any files.
  --no-sync            Skip the post-create 'bl sync' pass and its commit.
                       Use when you are about to create multiple stories in
                       a row and will run 'bl sync --commit' yourself at the
                       end.
  --help               Show this help

Stories are written to stories/S<n>-<slug>/index.md. After the sync, commits
the new stories (plus a new component dir, an appended feature file and every
index the sync rewrote) on the backlog's current branch, under the backlog
lock: "chore: add S-N" (or "chore: add S-N, S-M" for a batch, "chore: add
C<n>" for a component). Other uncommitted edits in the backlog stay out of the
commit. When the backlog is not a git repository, the commit is skipped.

Example:
  bl new C10 --title "My story" --points 1 \\
         --depends-on S-379,S-380 --required-for S-385
  bl new F-3 C10 --title "Mint codes" --points 3
  bl new --repo bl --title "Follow-up" --points 2 --plugins-from S-866
  bl new --component --repo bl --title "bl sync" --paths "src/sync.js,test/**/sync*"
  bl new --component --repo bl --title "bl tooling"
  bl new --feature --title "Invite codes" --theme residence S-12 S-13
  bl new --theme backlog --title Backlog --brief app.acme.com/docs/public/tenets.md
  bl new --epic --theme backlog --title "Backlog taxonomy"
  bl new --from plan.json
  bl new --from plan.json --dry-run --json`);
    process.exit(0);
  }

  if (isFlagSet(args['print-template'])) {
    if (jsonMode) {
      console.error('--print-template cannot be combined with --json (template body would corrupt JSON stdout)');
      process.exit(1);
    }
    if (args['print-template'] === true) {
      console.error('--print-template requires a value (story or component)');
      process.exit(1);
    }
    const kind = String(args['print-template']);
    const KINDS = ['story', 'story-feature', 'component', 'feature', 'change', 'theme', 'epic'];
    if (!KINDS.includes(kind)) {
      console.error(`unknown template '${kind}' (expected: ${KINDS.join(', ')})`);
      process.exit(1);
    }
    process.stdout.write(readFileSync(templatePath(kind), 'utf8'));
    process.exit(0);
  }

  if (isFlagSet(args['epic-title'])) {
    console.error(
      `--epic-title is gone: a story names its component (C-<n>), positionally or with --component; ` +
        `bl new --component --repo <r> --title <t> creates one.`,
    );
    process.exit(1);
  }

  // `--feature` and `--component` parse as value flags; a value that is not
  // an F-id (`bl new --feature S-1 S-2 --title t`) or a C-id is a
  // positional, and the flag is the switch that creates a feature or a
  // component.
  if (typeof args.feature === 'string' && !normalizeFeatureId(args.feature)) {
    args.positional.unshift(args.feature);
    args.feature = true;
  }
  if (typeof args.component === 'string' && !normalizeComponentId(args.component)) {
    // An old component's E-id gets the C-id hint; an epic's (E50 up) is
    // simply not a component id.
    const hint =
      componentIdHint(args.component) ??
      (normalizeEpicId(args.component) ? `invalid component id: '${args.component}' (expected C-<n>)` : null);
    if (hint) {
      console.error(hint);
      process.exit(1);
    }
    args.positional.unshift(args.component);
    args.component = true;
  }
  if (args.feature === true && args.component === true) {
    console.error('bl new creates a feature (--feature) or a component (--component), not both.');
    process.exit(1);
  }

  // The value axis (F-51 D2). `--epic` with an E-id names a new feature's
  // epic; a value that is not an epic id is a positional, and the flag is
  // the switch that creates an epic. `--theme` names the parent of a new
  // feature or epic, and on its own creates a theme.
  if (args.theme === true) {
    console.error('--theme requires a theme id (e.g. backlog)');
    process.exit(1);
  }
  if (typeof args.epic === 'string' && !normalizeEpicId(args.epic)) {
    if (/^[Ee]-?\d+$/.test(args.epic.trim())) {
      console.error(`invalid epic id: '${args.epic}' (epics are E50 upward; E00–E49 were components)`);
      process.exit(1);
    }
    args.positional.unshift(args.epic);
    args.epic = true;
  }
  if (args.epic === true) {
    if (isFlagSet(args.feature) || isFlagSet(args.from)) {
      console.error('bl new --epic creates an epic; it takes no --feature or --from.');
      process.exit(1);
    }
    return newEpic(args, jsonMode);
  }
  if (isFlagSet(args.epic) && args.feature !== true) {
    console.error(`--epic ${args.epic} names a new feature's epic: bl new --feature --title … --epic ${args.epic}`);
    process.exit(1);
  }
  if (isFlagSet(args.theme) && args.feature !== true) {
    if (isFlagSet(args.from) || typeof args.feature === 'string') {
      console.error(
        'A story has no theme: it reaches one through its feature. ' +
          'bl new --theme <slug> on its own creates a theme.',
      );
      process.exit(1);
    }
    return newTheme(args, jsonMode);
  }
  if (isFlagSet(args.brief)) {
    console.error('--brief belongs to a theme: bl new --theme <slug> --title <t> --brief <path,…>.');
    process.exit(1);
  }

  if (isFlagSet(args.from)) {
    return runBatchMode(args, jsonMode);
  }

  const listed = foldPositionals(args, args.positional.length > 0 ? loadConfig() : null);
  if (args.component === true) return newComponent(args, jsonMode);
  if (isFlagSet(args.paths)) {
    console.error(
      "--paths belongs to a component (bl new --component … --paths <glob,…>); a story's paths are its component's.",
    );
    process.exit(1);
  }
  if (args.feature === true) return newFeature(args, listed);

  const customBody = readBodyFile(args);
  const pluginsFromId = parsePluginsFromId(args);

  let dependsOn, requiredFor;
  try {
    dependsOn = normaliseDepIds(args['depends-on'], 'depends-on');
    requiredFor = normaliseDepIds(args['required-for'], 'required-for');
  } catch (err) {
    if (err.code === 'BAD_DEP_ID') {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (args.repo === true) {
    console.error('--repo requires a repo name');
    process.exit(1);
  }

  const config = loadConfig();
  if (Object.keys(config.reposByName).length === 0) {
    console.error('No repos registered in backlog/backlog.json.');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const prompt = async (label, hint) => {
    const suffix = hint != null ? ` [${hint}]` : '';
    const answer = (await ask(`${label}${suffix}: `)).trim();
    return answer || String(hint ?? '');
  };
  const isTTY = process.stdin.isTTY === true;
  const closeRl = () => rl.close();

  function requireOrPrompt(value, label, promptFn) {
    if (value) return Promise.resolve(value);
    if (isTTY) return promptFn();
    console.error(`Missing required argument: --${label}`);
    rl.close();
    process.exit(1);
  }

  // --- Plugins to inherit (optional) --- the source must exist before the
  // lock is taken so an unknown id fails without touching the backlog.
  const preSource = pluginsFromId ? lookupPluginsFrom(pluginsFromId, config) : null;

  // --- Component --- named, else the --plugins-from story's, else the
  // --repo repo's home, else prompted.
  const componentFromSource = !isFlagSet(args.component) && !isFlagSet(args.repo) && !!preSource?.componentId;
  const pickComponent = async (source) => {
    if (isFlagSet(args.component)) return resolveComponentRef(args.component, config, { onError: closeRl });
    if (isFlagSet(args.repo)) {
      if (!config.reposByName[String(args.repo)]) {
        const known = Object.keys(config.reposByName);
        console.error(`Unknown repo: ${args.repo}. Known repos: ${known.join(', ') || 'none'}`);
        rl.close();
        process.exit(1);
      }
      const home = homeComponent(config, String(args.repo));
      if (!home) {
        console.error(
          `Repo ${args.repo} has no home component; name the story's component (C-<n>) ` +
            `or create the home: bl new --component --repo ${args.repo} --title … --home`,
        );
        rl.close();
        process.exit(1);
      }
      return home;
    }
    if (source?.componentId) return resolveComponentRef(source.componentId, config, { onError: closeRl });
    const raw = await requireOrPrompt(null, 'component', async () => {
      const listedComponents = readComponents(config);
      console.log('Components:');
      if (listedComponents.length === 0) console.log('  (none)');
      for (const c of listedComponents) console.log(`  ${c.id}  ${c.title}  (${c.repo || 'no repo'})`);
      console.log('');
      return prompt('Component ID (e.g. C10)');
    });
    return resolveComponentRef(raw, config, { onError: closeRl });
  };
  let component = await pickComponent(preSource);
  if (!component.repo) {
    console.error(`${component.id} has no repo: in its index.md; a story takes its repo from its component.`);
    rl.close();
    process.exit(1);
  }
  if (isFlagSet(args.repo) && String(args.repo) !== component.repo) {
    console.error(
      `--repo ${args.repo} is not ${component.id}'s repo (${component.repo}): a story's repo is its component's. ` +
        `Name a component of ${args.repo}, or drop --repo.`,
    );
    rl.close();
    process.exit(1);
  }

  // --- Config --- the component's repo's overrides and plugin layer.
  if (component.repo && !config.reposByName[component.repo]) {
    console.error(`${component.id}'s repo ${component.repo} is not registered in backlog.json.`);
    closeRl();
    process.exit(1);
  }
  const cfg = configForRepo(config, component.repo);

  // --- Feature (optional) ---
  const feature = isFlagSet(args.feature) ? resolveFeatureRef(args.feature, cfg, { onError: closeRl }) : null;

  // --- Title ---
  const title = await requireOrPrompt(args.title ? String(args.title) : null, 'title', () => prompt('Story title'));
  if (!title) {
    console.error('Story title is required.');
    rl.close();
    process.exit(1);
  }

  // --- Type ---
  const storyType = args.type ? String(args.type) : 'feature';

  // --- Points ---
  let points = args.points ? parseInt(String(args.points), 10) : NaN;
  if (!FIBONACCI.has(points)) {
    if (!isTTY) {
      console.error('Missing or invalid --points. Must be a Fibonacci number: 1 2 3 5 8 13');
      rl.close();
      process.exit(1);
    }
    while (!FIBONACCI.has(points)) {
      if (!isNaN(points)) console.log('  Points must be a Fibonacci number: 1 2 3 5 8 13');
      const raw = await prompt('Points (1 2 3 5 8 13)');
      points = parseInt(raw, 10);
    }
  }

  rl.close();

  // --- Lock, assign ID, create files ---
  await acquireLock(cfg.backlogRoot);

  // Reread the source under the lock: another bl process may have moved or
  // rewritten it while this one waited, and the lock is what makes the
  // component we default to and the plugins we copy the source's current
  // state.
  const pluginsSource = pluginsFromId ? lookupPluginsFrom(pluginsFromId, cfg) : null;
  if (componentFromSource && pluginsSource.componentId !== component.id) {
    component = await pickComponent(pluginsSource);
    if (!component.repo) {
      console.error(`${component.id} has no repo: in its index.md; a story takes its repo from its component.`);
      process.exit(1);
    }
  }

  const primaryRepo = component.repo;
  const plugins = pluginsFrom(pluginsSource, primaryRepo);

  const nextNum = findMaxStoryNum(cfg) + 1;
  const storyId = `S-${nextNum}`;
  const storyDirName = `S${nextNum}-${slugify(title)}`;
  const today = new Date().toISOString().slice(0, 10);

  const storyDir = join(cfg.backlogRoot, STORIES_DIR, storyDirName);
  const storyIndex = join(storyDir, 'index.md');

  info(`\nNew story: ${storyId} — ${title}\n`);

  if (existsSync(storyDir)) {
    console.error(`Story directory already exists: ${relative(cfg.backlogRoot, storyDir)}`);
    process.exit(1);
  }

  mkdirSync(storyDir, { recursive: true });
  const storyVars = {
    componentId: component.id,
    storyId,
    title,
    type: storyType,
    points: String(points),
    today,
  };

  if (dependsOn.length > 0 || requiredFor.length > 0) {
    const existingIds = new Set(
      readAllStories(cfg)
        .map((s) => s.id)
        .filter(Boolean),
    );
    for (const id of dependsOn) {
      if (!existingIds.has(id)) {
        console.error(`warning: depends_on ${id} does not match any existing story`);
      }
    }
    for (const id of requiredFor) {
      if (!existingIds.has(id)) {
        console.error(`warning: required_for ${id} does not match any existing story`);
      }
    }
  }

  // The inherited plugins go after the feature, which the template holds.
  // No repo: a story's repo is its component's (F-52 D1).
  atomicWriteFile(
    cfg.backlogRoot,
    storyIndex,
    renderTemplate(feature ? 'story-feature' : 'story', {
      values: storyValues(storyVars, { feature, dependsOn, requiredFor }),
      vars: storyVars,
      body: customBody,
      after: ['feature', plugins],
    }),
  );

  info(`Created story: ${relative(cfg.backlogRoot, storyIndex)}`);

  if (feature) appendStoriesToFeature(cfg.backlogRoot, feature, [storyId]);

  if (args['no-sync']) {
    info("Skipped sync. Run 'bl sync' to update indexes.");
  } else {
    info('\nSyncing backlog...');
    let res;
    try {
      res = await syncAndCommit(cfg, {
        message: `chore: add ${storyId}`,
        storyIds: [storyId],
        extraPaths: feature ? [relative(cfg.backlogRoot, feature.indexPath)] : [],
      });
    } catch (err) {
      console.error(
        `Story file created at ${relative(cfg.backlogRoot, storyIndex)}. ` +
          `Sync failed: ${err.message}. ` +
          `Run 'bl sync' manually to update indexes.`,
      );
      process.exit(1);
    }
    reportBacklogCommit(res, 'bl new');
  }

  const newPlugins = resolvePlugins('new', cfg.plugins, {
    backlogRoot: cfg.backlogRoot,
    repo: repoOf(cfg),
    componentEntry: component.componentEntry,
    storyEntry: storyDirName,
  });
  if (newPlugins.length > 0) {
    info('\nRunning new plugins...');
    const pluginVars = {
      sessionId: `s${nextNum}`,
      storyId,
      componentId: component.id,
      roostDir: cfg.roostDir,
      backlogDir: cfg.backlogRoot,
      repoPath: cfg.reposByName[primaryRepo] ?? '',
    };
    runPlugins(newPlugins, pluginVars, cfg.backlogRoot);
  }

  const relPath = relative(cfg.backlogRoot, storyIndex);
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        schema: 'bl-new-json/v3',
        id: storyId,
        path: relPath,
        component: component.id,
        primary_repo: primaryRepo,
        feature: feature?.id ?? null,
      }) + '\n',
    );
  } else {
    info(
      `\nDone. ${storyId} — ${title} added to ${component.id} · ${component.title}${feature ? ` (feature ${feature.id})` : ''}.`,
    );
    process.stdout.write(`${relPath}\n`);
  }
}

// ---------------------------------------------------------------------------
// Batch mode: bl new --from <spec.json>
// ---------------------------------------------------------------------------

const BATCH_DISALLOWED_FLAGS = [
  'title',
  'component',
  'depends-on',
  'required-for',
  'body-file',
  'type',
  'points',
  'repo',
  'feature',
  'plugins-from',
  'theme',
  'epic',
];

async function runBatchMode(args, jsonMode) {
  if (args.from === true) {
    console.error('--from requires a path to a JSON spec file');
    process.exit(1);
  }
  const specPath = String(args.from);
  if (!specPath.endsWith('.json')) {
    console.error(`--from spec file must end in .json (got '${specPath}')`);
    process.exit(1);
  }

  for (const flag of BATCH_DISALLOWED_FLAGS) {
    if (isFlagSet(args[flag])) {
      console.error(`--${flag} is not allowed with --from; the spec file is the source of truth`);
      process.exit(1);
    }
  }

  const dryRun = args['dry-run'] === true;

  let specText;
  try {
    specText = readFileSync(specPath, 'utf8');
  } catch (err) {
    console.error(`Failed to read spec ${specPath}: ${err.message}`);
    process.exit(1);
  }
  let spec;
  try {
    spec = JSON.parse(specText);
  } catch (err) {
    console.error(`Spec is not valid JSON: ${err.message}`);
    process.exit(2);
  }

  const specDir = dirname(resolve(specPath));
  const config = loadConfig();

  let validation;
  try {
    validation = validateSpec(spec, specDir, config);
  } catch (err) {
    if (err instanceof SpecError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const { componentMode, featureId, storyComponents } = validation;
  for (const w of validation.warnings ?? []) console.error(w);
  const feature = featureId ? resolveFeatureRef(featureId, config) : null;

  // The spec's component's repo sets the batch's config; each story's `new`
  // plugins take its own component's repo layer.
  const cfg = configForRepo(config, validation.repo);

  // --- ID allocation. Hold the new-lock while assigning IDs and (for the
  // apply path) staging+moving files. Dry-run still allocates under lock so
  // the printed IDs match what the apply would assign at this instant.
  await acquireLock(cfg.backlogRoot);

  const startNum = findMaxStoryNum(cfg) + 1;
  const placeholderToId = new Map();
  const storyPlan = [];
  for (let i = 0; i < spec.stories.length; i++) {
    const s = spec.stories[i];
    const num = startNum + i;
    const id = `S-${num}`;
    placeholderToId.set(s.id, id);
    storyPlan.push({ spec: s, id, num });
  }

  // The spec's component: an existing one, or the one this batch creates.
  let component;
  const creatingNewComponent = componentMode === 'new';
  if (creatingNewComponent) {
    const id = `C${String(findNextComponentNum(cfg)).padStart(2, '0')}`;
    const repo = spec.component.repo;
    component = {
      id,
      title: spec.component.title,
      repo,
      componentEntry: `${id}-${slugify(spec.component.title)}`,
    };
  } else {
    component = validation.component;
  }

  // --- Warn about unknown bare IDs (consistent with --depends-on) ---
  // Only check refs that originated as bare `S-<n>` in the spec.
  // @placeholder refs are validated by validateSpec; checking their resolved
  // IDs here would emit false positives because siblings created in the same
  // batch are not yet on disk.
  const existingIds = new Set(
    readAllStories(cfg)
      .map((s) => s.id)
      .filter(Boolean),
  );
  const warnIfMissing = (ref, ctx) => {
    if (!existingIds.has(ref)) {
      console.error(`warning: ${ctx} ${ref} does not match any existing story`);
    }
  };

  // --- Build per-story rendered content ---
  const today = new Date().toISOString().slice(0, 10);
  const storiesDir = join(cfg.backlogRoot, STORIES_DIR);

  const renderedStories = [];
  for (const [i, item] of storyPlan.entries()) {
    const s = item.spec;
    const storyType = s.type ?? 'feature';
    const storyDirName = `S${item.num}-${slugify(s.title)}`;
    // Per-story component override (validated by validateSpec against disk).
    const storyComponent = storyComponents?.[i] ?? component;
    const inSpecComponent = !storyComponents?.[i];
    const dependsOn = (s.depends_on ?? []).map((r) => (r.startsWith('@') ? placeholderToId.get(r.slice(1)) : r));
    const requiredFor = (s.required_for ?? []).map((r) => (r.startsWith('@') ? placeholderToId.get(r.slice(1)) : r));
    for (const ref of s.depends_on ?? []) {
      if (!ref.startsWith('@')) warnIfMissing(ref, 'depends_on');
    }
    for (const ref of s.required_for ?? []) {
      if (!ref.startsWith('@')) warnIfMissing(ref, 'required_for');
    }

    const storyVars = {
      componentId: storyComponent.id,
      storyId: item.id,
      title: s.title,
      type: storyType,
      points: String(s.points),
      today,
    };
    const bodyPath = isAbsolute(s.body_file) ? s.body_file : resolve(specDir, s.body_file);
    let body;
    try {
      body = prepareBody(readFileSync(bodyPath, 'utf8'));
    } catch (err) {
      if (err.code === 'BODY_HAS_FRONTMATTER') {
        console.error(`body file ${s.body_file} contains frontmatter; remove it — bl manages frontmatter`);
        process.exit(2);
      }
      console.error(`Failed to read body file ${s.body_file}: ${err.message}`);
      process.exit(1);
    }
    const finalContent = renderTemplate(feature ? 'story-feature' : 'story', {
      values: storyValues(storyVars, { feature, dependsOn, requiredFor }),
      vars: storyVars,
      body,
    });

    renderedStories.push({
      ...item,
      placeholder: s.id,
      title: s.title,
      type: storyType,
      points: s.points,
      storyDirName,
      component: storyComponent,
      inSpecComponent,
      finalContent,
      relPath: relative(cfg.backlogRoot, join(storiesDir, storyDirName, 'index.md')),
      finalDir: join(storiesDir, storyDirName),
    });
  }

  let renderedComponentContent = null;
  if (creatingNewComponent) {
    const componentVars = {
      componentId: component.id,
      title: component.title,
      repo: component.repo,
      paths: (spec.component.paths ?? []).join(', '),
      today,
    };
    const bodyPath = isAbsolute(spec.component.body_file)
      ? spec.component.body_file
      : resolve(specDir, spec.component.body_file);
    try {
      const rawBody = prepareBody(readFileSync(bodyPath, 'utf8'));
      renderedComponentContent = renderTemplate('component', {
        values: {
          component_id: component.id,
          title: component.title,
          repo: component.repo,
          home: undefined,
          paths: spec.component.paths?.length ? spec.component.paths : undefined,
        },
        vars: componentVars,
        body: rawBody,
      });
    } catch (err) {
      if (err.code === 'BODY_HAS_FRONTMATTER') {
        console.error(
          `component body file ${spec.component.body_file} contains frontmatter; remove it — bl manages frontmatter`,
        );
        process.exit(2);
      }
      console.error(`Failed to read component body file ${spec.component.body_file}: ${err.message}`);
      process.exit(1);
    }
  }

  const componentAbsDir = join(cfg.backlogRoot, COMPONENTS_DIR, component.componentEntry);
  const componentRelDir = relative(cfg.backlogRoot, componentAbsDir);
  const componentRelIndex = `${componentRelDir}/index.md`;

  // --- Pre-flight: refuse to overwrite existing dirs ---
  if (!dryRun) {
    if (creatingNewComponent && existsSync(componentAbsDir)) {
      console.error(`Component directory already exists: ${componentRelDir} (refusing to overwrite)`);
      process.exit(1);
    }
    for (const r of renderedStories) {
      if (existsSync(r.finalDir)) {
        console.error(
          `Story directory already exists: ${relative(cfg.backlogRoot, r.finalDir)} (refusing to overwrite)`,
        );
        process.exit(1);
      }
    }
  }

  // --- Print human plan (always to stderr; the parseable answer is the
  // story path on stdout in non-JSON mode, or the JSON object in JSON mode).
  info(`\nBatch ${dryRun ? '(dry-run) ' : ''}from ${prettyRelPath(specPath)}:`);
  info(
    `  Component: ${component.id} ${creatingNewComponent ? '(new)' : '(existing)'} — ${component.title} (repo ${component.repo})`,
  );
  if (creatingNewComponent) info(`        ${componentRelIndex}`);
  info(`  Stories (${renderedStories.length}):`);
  if (feature) info(`  Feature: ${feature.id} — ${feature.title}`);
  for (const r of renderedStories) {
    const typeNote = r.type !== 'feature' ? ` [${r.type}]` : '';
    const componentNote = r.inSpecComponent ? '' : ` [${r.component.id}]`;
    info(`    @${r.placeholder} → ${r.id}  (${r.points}p)${typeNote}${componentNote}  ${r.relPath}`);
  }

  const jsonSummary = (created) =>
    JSON.stringify({
      schema: 'bl-new-batch-json/v2',
      dry_run: !created,
      component: {
        id: component.id,
        path: componentRelIndex,
        created: created && creatingNewComponent,
      },
      feature: feature?.id ?? null,
      stories: renderedStories.map((r) => ({
        placeholder: r.placeholder,
        id: r.id,
        path: r.relPath,
        component: r.component.id,
        created,
      })),
    }) + '\n';

  if (dryRun) {
    if (jsonMode) process.stdout.write(jsonSummary(false));
    return;
  }

  // --- Stage to tempdir ---
  // PID-suffixed name; collision means a stale dir from a prior crashed
  // batch with the same PID. Warn before reclaiming it so the user has a
  // breadcrumb if something else is using the path.
  const tempRoot = join(cfg.backlogRoot, `.bl-new-${process.pid}`);
  if (existsSync(tempRoot)) {
    console.error(
      `warning: removing stale tempdir ${relative(cfg.backlogRoot, tempRoot)} (likely from a previous crashed bl new)`,
    );
    rmSync(tempRoot, { recursive: true, force: true });
  }
  mkdirSync(tempRoot, { recursive: true });

  const tempComponentDir = join(tempRoot, COMPONENTS_DIR, component.componentEntry);
  const tempStoryDirOf = (r) => join(tempRoot, STORIES_DIR, r.storyDirName);
  try {
    if (creatingNewComponent) {
      mkdirSync(tempComponentDir, { recursive: true });
      writeFileSync(join(tempComponentDir, 'index.md'), renderedComponentContent);
    }
    for (const r of renderedStories) {
      const tempStoryDir = tempStoryDirOf(r);
      mkdirSync(tempStoryDir, { recursive: true });
      // Private test seam, only honoured for test/from.sh (atomicity
      // unwind path). Not part of the public CLI; renaming or removing
      // is fine — if test/from.sh stops setting it, the branch goes away.
      if (process.env.BL_INTERNAL_TEST_FAIL_ON_STORY != null && r.id === process.env.BL_INTERNAL_TEST_FAIL_ON_STORY) {
        rmSync(tempRoot, { recursive: true, force: true });
        console.error(`injected failure: refusing to write ${r.id} (BL_INTERNAL_TEST_FAIL_ON_STORY)`);
        process.exit(1);
      }
      writeFileSync(join(tempStoryDir, 'index.md'), r.finalContent);
    }
  } catch (err) {
    rmSync(tempRoot, { recursive: true, force: true });
    console.error(`Failed to stage batch tempdir: ${err.message}`);
    process.exit(1);
  }

  // --- Atomic move into place ---
  const moved = []; // [{from, to}]
  const unwind = () => {
    for (const m of [...moved].reverse()) {
      try {
        renameSync(m.to, m.from);
      } catch {
        // best-effort
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    if (creatingNewComponent) {
      mkdirSync(dirname(componentAbsDir), { recursive: true });
      renameSync(tempComponentDir, componentAbsDir);
      moved.push({ from: tempComponentDir, to: componentAbsDir });
    }
    mkdirSync(storiesDir, { recursive: true });
    for (const r of renderedStories) {
      const tempStoryDir = tempStoryDirOf(r);
      // Private test seam: simulate a mid-move failure so the unwind path
      // (which renames already-moved entries back to the tempdir) gets
      // exercised. Set BL_INTERNAL_TEST_FAIL_ON_MOVE=<S-N> to throw just
      // before that story is renamed into stories/.
      if (process.env.BL_INTERNAL_TEST_FAIL_ON_MOVE != null && r.id === process.env.BL_INTERNAL_TEST_FAIL_ON_MOVE) {
        throw new Error(`injected mid-move failure (BL_INTERNAL_TEST_FAIL_ON_MOVE=${r.id})`);
      }
      renameSync(tempStoryDir, r.finalDir);
      moved.push({ from: tempStoryDir, to: r.finalDir });
    }
  } catch (err) {
    console.error(`Move failed: ${err.message}; unwinding.`);
    unwind();
    process.exit(1);
  }

  rmSync(tempRoot, { recursive: true, force: true });

  if (feature) {
    appendStoriesToFeature(
      config.backlogRoot,
      feature,
      renderedStories.map((r) => r.id),
    );
  }

  // --- Sync ---
  if (args['no-sync']) {
    info("Skipped sync. Run 'bl sync' to update indexes.");
  } else {
    info('\nSyncing backlog...');
    const ids = renderedStories.map((r) => r.id);
    let res;
    try {
      res = await syncAndCommit(cfg, {
        message: `chore: add ${ids.join(', ')}`,
        storyIds: ids,
        extraPaths: [
          ...(creatingNewComponent ? [componentRelDir] : []),
          ...(feature ? [relative(cfg.backlogRoot, feature.indexPath)] : []),
        ],
      });
    } catch (err) {
      const created = renderedStories.map((r) => r.relPath).join(', ');
      console.error(
        `Story files created at ${created}. ` +
          `Sync failed: ${err.message}. ` +
          `Run 'bl sync' manually to update indexes.`,
      );
      process.exit(1);
    }
    reportBacklogCommit(res, 'bl new');
  }

  // --- Plugins (per story) ---
  for (const r of renderedStories) {
    const newPlugins = resolvePlugins('new', cfg.plugins, {
      backlogRoot: cfg.backlogRoot,
      repo: cfg.repos[r.component.repo] ?? null,
      componentEntry: r.component.componentEntry,
      storyEntry: r.storyDirName,
    });
    if (newPlugins.length > 0) {
      info(`\nRunning new plugins for ${r.id}...`);
      const pluginVars = {
        sessionId: `s${r.num}`,
        storyId: r.id,
        componentId: r.component.id,
        roostDir: cfg.roostDir,
        backlogDir: cfg.backlogRoot,
        repoPath: cfg.reposByName[r.component.repo] ?? '',
      };
      runPlugins(newPlugins, pluginVars, cfg.backlogRoot);
    }
  }

  // --- Output summary ---
  if (jsonMode) {
    process.stdout.write(jsonSummary(true));
  } else {
    info(
      `\nDone. Created ${renderedStories.length} ${
        renderedStories.length === 1 ? 'story' : 'stories'
      } in ${component.id}${creatingNewComponent ? ' (new)' : ''}.`,
    );
    // Stdout for batch mode: one path per line, in spec order.
    for (const r of renderedStories) {
      process.stdout.write(`${r.relPath}\n`);
    }
  }
}
