/**
 * tree.js — render dependency trees built from depends_on/required_for frontmatter.
 *
 * Each story may declare:
 *   depends_on: [S-56, S-78]     # stories that must be done before this can start
 *   required_for: [S-12, S-34]   # stories that cannot start until this is done
 *
 * A "tree" is rooted at a story nothing else depends on (empty `required_for`),
 * and a node's children are its `depends_on` entries. Trees are collected as
 * connected components in the undirected graph — a story with multiple
 * parents shows up under the first one it's encountered; subsequent
 * appearances are marked "(↑ see above)" to keep output finite and readable.
 *
 * Usage:
 *   bl tree                 Show every non-trivial tree
 *   bl tree <story-id>      Show the tree(s) containing <story-id>
 *   bl tree <component-id>       Show trees containing pending stories in the component
 *   bl tree -a | --all      Include trees where every story is done/superseded
 *   bl tree --theme <slug>  Trees containing pending stories in a theme;
 *                           likewise --epic, --feature, --component
 *                           (filter.js, F-51 D2)
 */

import { readFileSync } from 'fs';
import { spawnSyncFiles } from './child-stdio.js';
import {
  loadConfig,
  parseFrontmatter,
  parseArgs,
  runPager,
  info,
  highlightMatches,
  colorEnabled,
  componentIdHint,
} from './config.js';
import { readAllStories, normalizeId, normalizeComponentId, findComponentDir, parseIdList } from './story.js';
import { filterFromArgs, filterStories, hasFilter, filterLabel } from './filter.js';

function isDone(status) {
  return status === 'done' || status === 'superseded';
}

function formatNode(story, extra = '', color = false) {
  const status = story.status ?? 'backlog';
  const marker = isDone(status) ? ' (done)' : ` (${status})`;
  const title = story.title ? ` ${story.title}` : '';
  const text = `${story.id}${title}${marker}${extra}`;
  // Dim done/superseded nodes so completed work recedes. Only the node text is
  // wrapped — tree connectors are added by walk() outside this function and
  // stay at normal brightness. Faint (\x1b[2m) reads as darker against both
  // light and dark terminal themes.
  return color && isDone(status) ? `\x1b[2m${text}\x1b[0m` : text;
}

/**
 * Build the dependency graph.
 * @returns {{
 *   children: Map<string, string[]>,  // parent → children (depends_on)
 *   parents: Map<string, string[]>,   // child → parents (required_for)
 * }}
 */
export function buildGraph(stories) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const childSet = new Map();
  const parentSet = new Map();
  const addEdge = (parentId, childId) => {
    if (parentId === childId) return;
    if (!byId.has(parentId) || !byId.has(childId)) return;
    if (!childSet.has(parentId)) childSet.set(parentId, new Set());
    childSet.get(parentId).add(childId);
    if (!parentSet.has(childId)) parentSet.set(childId, new Set());
    parentSet.get(childId).add(parentId);
  };

  for (const s of stories) {
    const { fm } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
    for (const c of parseIdList(fm.depends_on)) addEdge(s.id, c);
    for (const p of parseIdList(fm.required_for)) addEdge(p, s.id);
  }

  const toSortedArray = (m) => {
    const out = new Map();
    for (const [k, set] of m) out.set(k, [...set].sort(idCompare));
    return out;
  };
  return {
    children: toSortedArray(childSet),
    parents: toSortedArray(parentSet),
  };
}

function idCompare(a, b) {
  const na = parseInt(a.slice(2), 10);
  const nb = parseInt(b.slice(2), 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Walk descendants (via children) from a root, collecting all reachable ids. */
function descendantsOf(rootId, graph) {
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    for (const n of graph.children.get(id) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

/**
 * Render a single rooted subtree as ASCII lines.
 * Tracks globally-seen nodes so DAG repeats are collapsed into a back-reference.
 */
export function renderTree(rootId, graph, byId, globallySeen, color = colorEnabled()) {
  const lines = [];
  const stats = { total: 0, done: 0 };

  function walk(id, prefix, isLast, inPath) {
    const story = byId.get(id);
    if (!story) return;

    let connector = '';
    if (prefix !== null) connector = isLast ? '└── ' : '├── ';

    const isRepeat = globallySeen.has(id);
    const isCycle = inPath.has(id);
    globallySeen.add(id);

    let extra = '';
    if (isCycle) extra = ' (↻ cycle)';
    else if (isRepeat) extra = ' (↑ see above)';

    lines.push((prefix ?? '') + connector + formatNode(story, extra, color));

    if (isCycle || isRepeat) return;

    stats.total += 1;
    if (isDone(story.status)) stats.done += 1;

    const kids = graph.children.get(id) ?? [];
    const childPrefix = prefix === null ? '' : prefix + (isLast ? '    ' : '│   ');
    const nextInPath = new Set(inPath);
    nextInPath.add(id);
    kids.forEach((cid, i) => {
      walk(cid, childPrefix, i === kids.length - 1, nextInPath);
    });
  }

  walk(rootId, null, true, new Set());
  return { lines, stats };
}

/**
 * Identify root ids within a candidate set.
 * A root has no parent that is also in the candidate set.
 */
export function rootsWithin(candidates, graph) {
  const roots = [];
  for (const id of candidates) {
    const parents = graph.parents.get(id);
    const hasParentInSet = parents && parents.some((p) => candidates.has(p));
    if (!hasParentInSet) roots.push(id);
  }
  return roots.sort(idCompare);
}

/**
 * Given a set of seed story ids, return the union of those ids and every
 * ancestor reachable via `graph.parents` (i.e. via `required_for` edges).
 * Used to build the candidate set for both the story-scope and component-scope
 * forms of `bl tree`.
 */
export function ancestorsOf(seedIds, graph) {
  const out = new Set(seedIds);
  const stack = [...seedIds];
  while (stack.length) {
    const id = stack.pop();
    for (const p of graph.parents.get(id) ?? []) {
      if (!out.has(p)) {
        out.add(p);
        stack.push(p);
      }
    }
  }
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl tree [story-id|component-id] [options]

Arguments:
  [story-id]           Show only the tree(s) containing this story
  [component-id]            Show trees containing pending stories in this component

Options:
  -a, --all            Include trees where every story is done/superseded
  --theme <slug>       Trees containing pending stories in a theme
  --epic <E-id>        Trees containing pending stories of an epic's features
  --feature <F-id>     Trees containing pending stories of a feature
  --component <C-id>   Trees containing pending stories in a component
  --help               Show this help

Notes:
  - Trees are built from the \`depends_on\` and \`required_for\` frontmatter fields.
  - A root is a story nothing depends on; its children are its \`depends_on\` list.
  - Orphan stories (no dependencies) are not shown.
  - With a component id, only trees containing pending stories in the component are
    shown; use -a/--all to include done-only trees. The filters work the same way,
    and every one given must match.`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const { filter, ctx } = filterFromArgs(args, cfg, 'bl tree');
  const showAll = args.all;
  const stories = readAllStories(cfg);
  const byId = new Map(stories.map((s) => [s.id, s]));

  const graph = buildGraph(stories);

  // Determine which ids to consider as potential roots.
  let candidateIds;
  // The queried story id to spotlight in the rendered tree. Only set for the
  // story-scope form: a component scope would light up nearly every node (the tree
  // is mostly that component's stories), which is noise rather than signal.
  let highlightIds = [];
  if (args.positional[0]) {
    const raw = args.positional[0];
    if (/^[Cc]-?\d+$/.test(raw)) {
      const parsed = normalizeComponentId(raw);
      if (!findComponentDir(parsed, cfg)) {
        console.error(`bl tree: component not found: ${parsed.id}`);
        process.exit(1);
      }
      if (filter.component && filter.component !== parsed.id) {
        console.error(`bl tree: ${parsed.id} and --component ${filter.component} name different components.`);
        process.exit(1);
      }
      // A component argument is the --component filter.
      filter.component = parsed.id;
    } else if (/^[Ss]-?\d+$/.test(raw)) {
      if (hasFilter(filter)) {
        console.error('bl tree: give a story id or the --theme/--epic/--feature/--component filters, not both.');
        process.exit(1);
      }
      const parsed = normalizeId(raw);
      if (!parsed || !byId.has(parsed.id)) {
        console.error(`bl tree: story not found: ${raw}`);
        process.exit(1);
      }
      // Ancestors of the target (including itself), walking via required_for.
      // Limiting candidates to ancestors ensures we only render trees whose
      // subtree actually contains the target — not sibling trees that merely
      // share a descendant with it.
      highlightIds = [parsed.id];
      candidateIds = ancestorsOf([parsed.id], graph);
    } else {
      console.error(`bl tree: ${componentIdHint(raw) ?? `invalid id (expected S-<n> or C<nn>): ${raw}`}`);
      process.exit(1);
    }
  }
  if (hasFilter(filter)) {
    const label = filterLabel(filter);
    const matched = filterStories(stories, filter, ctx);
    if (matched.length === 0) {
      info(label === filter.component ? `Component ${label} has no stories.` : `No stories in ${label}.`);
      return;
    }
    const seedStories = showAll ? matched : matched.filter((s) => !isDone(s.status));
    const seedIds = seedStories.map((s) => s.id);
    if (seedIds.length === 0) {
      // Every matched story is done/superseded (only reachable when --all is
      // off, since showAll seeds every match).
      info(`All stories in ${label} are done. Use -a/--all to include them.`);
      return;
    }
    const hasAnyEdge = seedIds.some((id) => graph.children.has(id) || graph.parents.has(id));
    if (!hasAnyEdge) {
      info(`No dependency trees for pending stories in ${label}. Add depends_on or required_for to story frontmatter.`);
      return;
    }
    candidateIds = ancestorsOf(seedIds, graph);
  } else if (!args.positional[0]) {
    // All stories that participate in any edge.
    candidateIds = new Set();
    for (const id of graph.children.keys()) candidateIds.add(id);
    for (const id of graph.parents.keys()) candidateIds.add(id);
  }

  const roots = rootsWithin(candidateIds, graph);

  if (roots.length === 0) {
    // Filter scope hits the `hasAnyEdge` short-circuit before reaching here,
    // and any non-empty seed with edges produces at least one root via
    // `rootsWithin`. So this branch fires only for the no-arg / story-arg
    // forms.
    info(
      args.positional[0]
        ? `No dependencies recorded for ${normalizeId(args.positional[0]).id}.`
        : 'No dependency trees found. Add `depends_on:` or `required_for:` to story frontmatter.',
    );
    return;
  }

  const globallySeen = new Set();
  const treeBlocks = [];
  let shownTrees = 0;
  let totalStoriesShown = 0;
  let totalDoneShown = 0;

  for (const rootId of roots) {
    const descendants = descendantsOf(rootId, graph);
    const allDone = [...descendants].every((id) => isDone(byId.get(id).status));
    if (allDone && !showAll) continue;

    const { lines, stats } = renderTree(rootId, graph, byId, globallySeen);
    treeBlocks.push(lines.join('\n'));
    shownTrees += 1;
    totalStoriesShown += stats.total;
    totalDoneShown += stats.done;
  }

  if (treeBlocks.length === 0) {
    info('All dependency trees are complete. Use -a/--all to include them.');
    return;
  }

  const summary = `${shownTrees} tree${shownTrees === 1 ? '' : 's'}, ${totalStoriesShown} stor${
    totalStoriesShown === 1 ? 'y' : 'ies'
  } (${totalDoneShown} done)`;

  let output = treeBlocks.join('\n\n') + '\n\n' + summary + '\n';

  // Highlight the queried story id(s) wherever they appear as whole-word tokens.
  if (highlightIds.length) {
    const alt = highlightIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    output = highlightMatches(output, new RegExp(`\\b(?:${alt})\\b`, 'g'));
  }

  const termRows = process.stdout.rows || 24;
  const lineCount = output.split('\n').length;
  if (process.stdout.isTTY && lineCount > termRows) {
    const result = runPager(output);
    if (result.error && !process.env.PAGER) {
      spawnSyncFiles('more', {
        input: output,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
    }
  } else {
    process.stdout.write(output);
  }
}
