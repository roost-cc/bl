/**
 * format-lint.js — shared implementation behind `bl format` and `bl lint`.
 *
 * Both subcommands take the same shape:
 *
 *   bl <stage> --story <id> [path...]
 *   bl <stage> --no-story <path...>
 *
 * Story ID is required by default — without it, the dispatcher errors out
 * with a clear "specify --story <id>" message. `--no-story` plus explicit
 * paths is the escape hatch for ad-hoc invocations outside any story scope.
 *
 * For `--story <id>`, the story's backlog markdown file is processed in the
 * backlog repo. Format/lint are direct tool invocations; implementation repo
 * worktrees and agents are intentionally not involved.
 *
 * These stages do NOT route through the `ci-cd` runner, and that is deliberate
 * (assessed in S-473). `bl` owns the story markdown, so it owns
 * formatting/linting it; the shared unit here is a single `prettier --write`
 * command, and `bl`'s real value-add — story-scope resolution and the
 * per-story/per-component plugin cascade below — has no `ci-cd` equivalent and
 * cannot move into the runner (its contract forbids backlog/story knowledge).
 * `ci-cd run <action>` is reserved for any future `bl` command that acts on the
 * code repos a story spans (test/build/package/deploy) — that is the code
 * lifecycle `ci-cd` owns. Do not wire markdown format/lint into `ci-cd`.
 *
 * Files are dispatched to plugins via `language_dispatch[stage][ext]`,
 * batched by plugin to amortise spawn cost (one prettier invocation for all
 * .md files, not one per file).
 */

import { resolve, relative, isAbsolute, basename } from 'path';
import { loadConfig, parseArgs, parsePluginCascade, runPluginBatch, info, warn } from './config.js';
import { findStoryDir, normalizeId } from './story.js';
import { normalizeFeatureId, findFeature } from './feature.js';

/**
 * Build the effective ext → Set<pluginName> map for a stage.
 *
 * Defaults come from `language_dispatch[stage]` (each ext maps to one or
 * more plugin names). The cascade (`plugins-<stage>: ...`) is applied
 * *additively*: cascade adds bring in extra plugins for the extensions they
 * declare via `plugins[name].extensions`; cascade removes drop a plugin
 * from every extension that referenced it.
 *
 * The previous filter-only model (`if (cascade.length) keep only cascade
 * names`) silently emptied the dispatch table when a story declared a
 * plugin that wasn't already in the defaults — `plugins-format: extra-md`
 * would wipe out the default `md` plugin too. The additive model is what
 * the AC's "multi-plugin same-extension cascade" scenario expects.
 */
function buildEffectiveDispatch(stage, config, ctx) {
  const dispatch = config.languageDispatch?.[stage] ?? {};
  const { adds, removes } = parsePluginCascade(stage, {
    backlogRoot: config.backlogRoot,
    repo: ctx.repo,
    componentEntry: ctx.componentEntry,
    storyEntry: ctx.storyEntry,
  });
  const removeSet = new Set(removes);

  const effective = new Map(); // ext → Set<pluginName>
  for (const [ext, val] of Object.entries(dispatch)) {
    const names = Array.isArray(val) ? val : [val];
    for (const name of names) {
      if (removeSet.has(name)) continue;
      if (!config.plugins?.[name]?.[stage]) continue;
      if (!effective.has(ext)) effective.set(ext, new Set());
      effective.get(ext).add(name);
    }
  }

  for (const name of adds) {
    // `parsePluginCascade` already mutually-excludes adds and removes per
    // name (`adds.delete(name); removes.add(name)`), so a name can never
    // appear in both sets here — no remove-check needed in this loop.
    if (!config.plugins?.[name]?.[stage]) continue;
    const exts = config.plugins[name].extensions ?? [];
    // A cascade-add that contributes zero extensions is a silent no-op:
    // either the plugin has no `extensions` field declared and isn't
    // referenced by `language_dispatch[stage]` at all, or every declared
    // extension is already covered (the union dedupe makes this a no-op).
    // Warn loudly so users notice their `plugins-<stage>: foo` entry
    // didn't actually wire `foo` to anything.
    const dispatchExtsForName = [];
    for (const [ext, val] of Object.entries(dispatch)) {
      const names = Array.isArray(val) ? val : [val];
      if (names.includes(name)) dispatchExtsForName.push(ext);
    }
    if (exts.length === 0 && dispatchExtsForName.length === 0) {
      warn(
        `cascade plugin '${name}' for stage '${stage}' contributed no extensions — set 'plugins.${name}.extensions: [".ext", …]' or add it to language_dispatch.${stage} in backlog.json`,
      );
      continue;
    }
    for (const ext of exts) {
      if (!effective.has(ext)) effective.set(ext, new Set());
      effective.get(ext).add(name);
    }
  }

  return effective;
}

function bucketByEffectiveDispatch(paths, effective) {
  const buckets = new Map(); // pluginName → paths[]
  for (const p of paths) {
    const base = basename(p);
    if (base.startsWith('.')) continue;
    const dot = base.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = base.slice(dot);
    const names = effective.get(ext);
    if (!names) continue;
    for (const name of names) {
      const list = buckets.get(name);
      if (list) list.push(p);
      else buckets.set(name, [p]);
    }
  }
  return buckets;
}

function extensionSummary(paths) {
  const exts = new Set();
  for (const p of paths) {
    const base = basename(p);
    if (base.startsWith('.')) continue;
    const dot = base.lastIndexOf('.');
    if (dot <= 0) continue;
    exts.add(base.slice(dot));
  }
  return [...exts].sort();
}

function applyStageInDirectory(stage, rootPath, paths, config, ctx) {
  const effective = buildEffectiveDispatch(stage, config, ctx);
  const buckets = bucketByEffectiveDispatch(paths, effective);

  if (buckets.size === 0) {
    const exts = extensionSummary(paths);
    if (exts.length > 0) {
      info(`  ${ctx.repoName ?? rootPath}: no configured ${stage} plugin for ${exts.join(', ')}`);
    } else {
      info(`  ${ctx.repoName ?? rootPath}: no files matched`);
    }
    return { status: 0, files: 0 };
  }

  let worstStatus = 0;
  let totalFiles = 0;
  for (const [name, bucketPaths] of buckets) {
    totalFiles += bucketPaths.length;
    const command = config.plugins[name][stage];
    const result = runPluginBatch(name, command, bucketPaths, ctx.vars ?? {}, rootPath);
    // Missing-binary (`status: 127, missing: true`) is a non-zero outcome in
    // the explicit-invocation context: CI must not green-light an unformatted
    // / unlinted tree because the configured tool isn't installed.
    if (!result.ok && result.status > worstStatus) worstStatus = result.status;
  }
  info(`  ${ctx.repoName ?? rootPath}: ${totalFiles} files via ${buckets.size} plugin(s) — exit ${worstStatus}`);
  return { status: worstStatus, files: totalFiles };
}

/** Keep the explicit paths that lie inside the backlog repo, relative to it. */
function backlogRelative(explicit, config) {
  const paths = [];
  for (const p of explicit) {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    const rel = relative(config.backlogRoot, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    paths.push(rel);
  }
  return paths;
}

/**
 * `--story F-<n>`: a feature session's scope is the feature file plus every
 * story it lists, each run under its own cascade (a story's repo, component and
 * story layers; the feature file, which has none, under the backlog root's).
 * Explicit paths narrow it to those files, under the root cascade. Exits.
 */
function runFeatureStage(stage, featureParsed, explicit, config) {
  const feature = findFeature(featureParsed, config);
  if (!feature) {
    console.error(`Feature ${featureParsed.id} not found`);
    process.exit(2);
  }
  const vars = {
    stage,
    storyId: feature.id,
    roostDir: config.roostDir,
    backlogRoot: config.backlogRoot,
  };
  const groups = [];
  if (explicit.length > 0) {
    const paths = backlogRelative(explicit, config);
    if (paths.length === 0) {
      warn(`no files processed for feature ${feature.id} — explicit paths must be inside the backlog repo`);
      process.exit(1);
    }
    groups.push({ paths, ctx: { vars, repoName: 'backlog' } });
  } else {
    groups.push({
      paths: [relative(config.backlogRoot, feature.indexPath)],
      ctx: { vars, repoName: 'backlog' },
    });
    for (const id of feature.stories) {
      const parsed = normalizeId(id);
      const found = parsed ? findStoryDir(parsed, config) : null;
      if (!found) {
        warn(`${feature.id} lists ${id}, which was not found — skipped`);
        continue;
      }
      groups.push({
        paths: [relative(config.backlogRoot, found.indexPath)],
        ctx: {
          repo: config.repos[found.unitRepo] ?? null,
          componentEntry: found.componentEntry,
          storyEntry: found.storyEntry,
          vars: { ...vars, storyId: parsed.id },
          repoName: `backlog (${parsed.id})`,
        },
      });
    }
  }
  let worst = 0;
  for (const { paths, ctx } of groups) {
    const { status } = applyStageInDirectory(stage, config.backlogRoot, paths, config, ctx);
    if (status > worst) worst = status;
  }
  process.exit(worst);
}

export async function runStage(stage, argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl ${stage} --story <id> [path...]
       bl ${stage} --no-story <path...>

Run the configured ${stage} plugin over backlog markdown files.

Options:
  --story <id>     Story ID (required by default). Resolves the story's
                   backlog index.md and runs ${stage} on that markdown file.
                   A feature ID (F-<n>) covers the feature file and the
                   index.md of every story it lists.
  --no-story       Skip story resolution (ad-hoc use). Requires explicit
                   paths and operates relative to cwd.
  -A, --agent <id> Agent provider (passed through for config resolution).
  --help           Show this help

The dispatch table is config-driven: backlog.json's language_dispatch.${stage}
maps file extensions to plugin names; the matching plugin's command is run
with {{path}} interpolated to the matched files.`);
    process.exit(0);
  }

  const noStory = args['no-story'] === true;
  const storyId = args.story;
  const explicit = args.positional;

  if (!storyId && !noStory) {
    console.error(`bl ${stage}: --story <id> is required (or pass --no-story with explicit paths for ad-hoc use)`);
    process.exit(2);
  }

  const config = loadConfig({ agent: args.agent });

  if (noStory) {
    if (explicit.length === 0) {
      console.error(`bl ${stage} --no-story requires at least one path`);
      process.exit(2);
    }
    const cwd = process.cwd();
    const ctx = {
      vars: { stage, roostDir: config.roostDir },
      repoName: relative(config.roostDir, cwd) || cwd,
    };
    const { status } = applyStageInDirectory(stage, cwd, explicit, config, ctx);
    process.exit(status);
  }

  const featureParsed = normalizeFeatureId(storyId);
  if (featureParsed) runFeatureStage(stage, featureParsed, explicit, config);

  const parsed = normalizeId(storyId);
  if (!parsed) {
    console.error(`Invalid story id: ${storyId}`);
    process.exit(2);
  }
  const found = findStoryDir(parsed, config);
  if (!found) {
    console.error(`Story ${parsed.id} not found`);
    process.exit(2);
  }

  let paths = [relative(config.backlogRoot, found.indexPath)];
  if (explicit.length > 0) {
    paths = backlogRelative(explicit, config);
    if (paths.length === 0) {
      warn(`no files processed for story ${parsed.id} — explicit paths must be inside the backlog repo`);
      process.exit(1);
    }
  }
  const ctx = {
    repo: config.repos[found.unitRepo] ?? null,
    componentEntry: found.componentEntry,
    storyEntry: found.storyEntry,
    vars: {
      stage,
      storyId: parsed.id,
      roostDir: config.roostDir,
      backlogRoot: config.backlogRoot,
    },
    repoName: 'backlog',
  };
  const { status } = applyStageInDirectory(stage, config.backlogRoot, paths, config, ctx);
  process.exit(status);
}
