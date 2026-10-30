/**
 * what-next.js — suggest the next story to work on.
 *
 * Walks the dependency graph deterministically:
 *   1. Pick a reference story (the optional <story-id> arg, or the most
 *      recently closed story by `completed` date, tiebreak by highest id).
 *   2. If it has no `required_for` parents, it's a root — nothing to chain to.
 *   3. For each parent (lowest id first), if every one of the parent's
 *      `depends_on` is done, the parent itself is next.
 *   4. Otherwise, pick the oldest (lowest id) peer that isn't done; if that
 *      peer has unfinished `depends_on` of its own, descend into it to find
 *      the oldest startable descendant.
 *
 * With a component id, or the `--theme`, `--epic`, `--feature` and
 * `--component` filters (filter.js, F-51 D2), it picks the next startable
 * story among the stories that match instead (`pickNextIn`).
 */

import { readFileSync } from 'fs';
import {
  loadConfig,
  parseFrontmatter,
  parseArgs,
  normalizeId,
  normalizeComponentId,
  componentIdHint,
  info,
} from './config.js';
import { readAllStories, parseIdList, readBacklogOrder, findComponentDir } from './story.js';
import { filterFromArgs, filterStories, hasFilter, filterLabel } from './filter.js';

function isDone(status) {
  return status === 'done' || status === 'superseded';
}

function idNum(id) {
  const m = String(id).match(/^S-(\d+)$/);
  return m ? parseInt(m[1], 10) : Infinity;
}

function idCompare(a, b) {
  return idNum(a) - idNum(b);
}

export function buildGraph(stories) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const children = new Map(); // parent -> Set(child)
  const parents = new Map(); // child -> Set(parent)
  const fmById = new Map();

  const addEdge = (parentId, childId) => {
    if (parentId === childId) return;
    if (!byId.has(parentId) || !byId.has(childId)) return;
    if (!children.has(parentId)) children.set(parentId, new Set());
    children.get(parentId).add(childId);
    if (!parents.has(childId)) parents.set(childId, new Set());
    parents.get(childId).add(parentId);
  };

  for (const s of stories) {
    const { fm } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
    fmById.set(s.id, fm);
    for (const c of parseIdList(fm.depends_on)) addEdge(s.id, c);
    for (const p of parseIdList(fm.required_for)) addEdge(p, s.id);
  }

  const sortedArr = (m) => {
    const out = new Map();
    for (const [k, set] of m) out.set(k, [...set].sort(idCompare));
    return out;
  };
  return {
    children: sortedArr(children),
    parents: sortedArr(parents),
    byId,
    fmById,
  };
}

/**
 * Find the oldest startable descendant of `rootId` (including rootId itself)
 * by walking children depth-first, oldest-id first. A node is "startable"
 * when it isn't done and all of its `depends_on` are done.
 * Returns null if every node in the subtree is done.
 */
export function findOldestStartable(rootId, graph, visited = new Set()) {
  if (visited.has(rootId)) return null;
  visited.add(rootId);
  const story = graph.byId.get(rootId);
  if (!story) return null;
  if (isDone(story.status)) return null;

  const deps = graph.children.get(rootId) ?? [];
  const unfinishedDeps = deps.filter((d) => !isDone(graph.byId.get(d)?.status));
  if (unfinishedDeps.length === 0) return rootId;

  for (const dep of unfinishedDeps) {
    const found = findOldestStartable(dep, graph, visited);
    if (found) return found;
  }
  return null;
}

/**
 * Pick the next startable story inside a single component
 * (`pickNextIn` over the component's stories).
 */
export function pickNextInComponent(componentId, stories, graph, priorityMap) {
  return pickNextIn(
    stories.filter((s) => s.componentId === componentId),
    graph,
    priorityMap,
  );
}

/**
 * Pick the next startable story inside a set of stories (one component's,
 * or those a filter matches). `graph` is built over every story, so a
 * dependency outside the set still blocks.
 *
 *   1. Priority rank — lowest `priorityMap` index among startable stories
 *      wins (tiebreak: lowest numeric ID).
 *   2. Oldest leaf — if no startable story is in the priority table, pick
 *      the lowest-id startable story.
 *
 * Return shapes:
 *   - `{ kind: "missing" }`   — the set is empty
 *   - `{ kind: "all-done" }`  — every story in the set is done/superseded
 *   - `{ kind: "next", story, method }` — `method` is `"priority"` or
 *     `"oldest-leaf"`
 *   - `{ kind: "blocked", open }` — open stories exist but every one of
 *     them has an unfinished `depends_on`
 */
export function pickNextIn(inSet, graph, priorityMap) {
  if (inSet.length === 0) return { kind: 'missing' };

  const open = inSet.filter((s) => !isDone(s.status));
  if (open.length === 0) return { kind: 'all-done' };

  const startable = open.filter((s) => {
    const deps = graph.children.get(s.id) ?? [];
    return deps.every((d) => isDone(graph.byId.get(d)?.status));
  });
  if (startable.length === 0) return { kind: 'blocked', open };

  const inPriority = startable.filter((s) => priorityMap.has(s.id));
  if (inPriority.length > 0) {
    inPriority.sort((a, b) => {
      const pa = priorityMap.get(a.id);
      const pb = priorityMap.get(b.id);
      if (pa !== pb) return pa - pb;
      return idNum(a.id) - idNum(b.id);
    });
    return { kind: 'next', story: inPriority[0], method: 'priority' };
  }

  const sorted = [...startable].sort((a, b) => idNum(a.id) - idNum(b.id));
  return { kind: 'next', story: sorted[0], method: 'oldest-leaf' };
}

function pickMostRecentlyClosed(stories) {
  const closed = stories.filter((s) => isDone(s.status));
  if (closed.length === 0) return null;
  // Read `completed` from frontmatter; fall back to "" (sorts oldest).
  const withDate = closed.map((s) => {
    const { fm } = parseFrontmatter(readFileSync(s.indexPath, 'utf8'));
    return { story: s, completed: fm.completed ?? '' };
  });
  withDate.sort((a, b) => {
    if (a.completed !== b.completed) return b.completed.localeCompare(a.completed);
    return idNum(b.story.id) - idNum(a.story.id);
  });
  return { story: withDate[0].story, completed: withDate[0].completed };
}

function describe(story) {
  const title = story.title ? ` ${story.title}` : '';
  return `${story.id}${title}`;
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: bl what-next [story-id|component-id] [--theme <slug>] [--epic <E-id>] [--feature <F-id>] [--component <C-id>]

Arguments:
  [story-id]   Optional story to use as the reference point. If omitted,
               the most recently closed story (by frontmatter \`completed\`
               date) is used.
  [component-id]    A component (\`C32\`, \`c-32\`) instead of a story. Suggests the
               next startable story inside that component by priority rank,
               falling back to the lowest-id startable story.

Suggests the next story to start by walking the dependency graph:
  - If the reference story has a \`required_for\` parent whose other
    \`depends_on\` are all done, that parent is next.
  - Otherwise the oldest (lowest-id) peer or peer descendant that has all
    its own dependencies satisfied is next.
  - If the reference story has no \`required_for\` parent, it was a root
    — there is nothing to chain to.
  - With a component ID, picks the lowest-priority-rank startable story inside
    the component; if none of the startable stories appear in the priority
    table, falls back to the lowest-id startable story.
  - The filters pick the same way among the stories they match:
      --theme <slug>       stories in a theme (their feature's theme, or, with
                           no feature, a theme whose repos list their
                           component's repo)
      --epic <E-id>        stories of an epic's features
      --feature <F-id>     stories of one feature
      --component <C-id>   stories in one component
    Every filter given must match.`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const { filter, ctx } = filterFromArgs(args, cfg, 'bl what-next');
  const stories = readAllStories(cfg);
  if (stories.length === 0) {
    info('No stories found.');
    return;
  }

  let reference;
  let referenceCompleted = null;
  let referenceFromArg = false;

  const raw = args.positional[0];
  const componentArg = raw && /^[Cc]-?\d+$/.test(raw);
  if (componentArg) {
    const parsedComponent = normalizeComponentId(raw);
    if (!findComponentDir(parsedComponent, cfg)) {
      console.error(`bl what-next: component not found: ${parsedComponent.id}`);
      process.exit(1);
    }
    if (filter.component && filter.component !== parsedComponent.id) {
      console.error(
        `bl what-next: ${parsedComponent.id} and --component ${filter.component} name different components.`,
      );
      process.exit(1);
    }
    // A component argument is the --component filter.
    filter.component = parsedComponent.id;
  } else if (raw && hasFilter(filter)) {
    console.error('bl what-next: give a story id or the --theme/--epic/--feature/--component filters, not both.');
    process.exit(1);
  }

  if (hasFilter(filter)) {
    const label = filterLabel(filter);
    const onlyComponent = label === filter.component;
    const graph = buildGraph(stories);
    const priorityIds = readBacklogOrder(cfg.backlogRoot);
    const priorityMap = new Map(priorityIds.map((id, i) => [id, i]));
    const result = pickNextIn(filterStories(stories, filter, ctx), graph, priorityMap);
    if (result.kind === 'missing') {
      if (onlyComponent) {
        console.error(`bl what-next: component not found: ${label}`);
        process.exit(1);
      }
      info(`No stories in ${label}.`);
      return;
    }
    if (result.kind === 'all-done') {
      info(`All stories in ${label} are done.`);
      return;
    }
    if (result.kind === 'blocked') {
      info(`No startable story in ${label}. Remaining stories blocked:`);
      const sortedOpen = [...result.open].sort((a, b) => idCompare(a.id, b.id));
      for (const s of sortedOpen) {
        const deps = graph.children.get(s.id) ?? [];
        const blockers = deps.filter((d) => !isDone(graph.byId.get(d)?.status));
        info(`  ${describe(s)} — blocked on: ${blockers.join(', ') || '(none)'}`);
      }
      return;
    }
    // kind === "next"
    const next = result.story;
    info(onlyComponent ? `Component: ${label}` : `Filter: ${label}`);
    info(`\nNext: ${describe(next)}`);
    if (result.method === 'priority') {
      info(`Why: top-priority startable story in ${label}.`);
    } else {
      info(`Why: oldest leaf in ${label} (no startable story is in the priority list).`);
    }
    process.stdout.write(`${next.id}\n`);
    return;
  }

  if (raw) {
    if (!/^[Ss]-?\d+$/.test(raw)) {
      console.error(`bl what-next: ${componentIdHint(raw) ?? `invalid id (expected S-<n> or C<nn>): ${raw}`}`);
      process.exit(1);
    }
    const parsed = normalizeId(raw);
    if (!parsed) {
      console.error(`bl what-next: invalid id (expected S-<n> or C<nn>): ${raw}`);
      process.exit(1);
    }
    reference = stories.find((s) => s.id === parsed.id);
    if (!reference) {
      console.error(`bl what-next: story not found: ${parsed.id}`);
      process.exit(1);
    }
    referenceFromArg = true;
  } else {
    const pick = pickMostRecentlyClosed(stories);
    if (!pick) {
      info('No closed stories yet — nothing to suggest from.');
      return;
    }
    reference = pick.story;
    referenceCompleted = pick.completed;
  }

  const graph = buildGraph(stories);

  const header = referenceFromArg
    ? `Reference: ${describe(reference)} [${reference.status}]`
    : `Most recently closed: ${describe(reference)}${referenceCompleted ? ` (${referenceCompleted})` : ''}`;
  info(header);

  const parents = graph.parents.get(reference.id) ?? [];
  if (parents.length === 0) {
    info(`\n${reference.id} has no \`required_for\` — it was a root. Nothing to chain to; pick a new line of work.`);
    return;
  }

  // Try each parent (oldest first). If all of the parent's depends_on are
  // done, that parent itself is the next story.
  for (const parentId of parents) {
    const parent = graph.byId.get(parentId);
    if (!parent || isDone(parent.status)) continue;
    const parentDeps = graph.children.get(parentId) ?? [];
    const allDone = parentDeps.every((d) => isDone(graph.byId.get(d)?.status));
    if (allDone) {
      info(`\nNext: ${describe(parent)}`);
      info(`Why: all dependencies of ${parent.id} (${parentDeps.join(', ')}) are done; ${parent.id} is unblocked.`);
      process.stdout.write(`${parent.id}\n`);
      return;
    }
  }

  // No parent is fully unblocked. Find the oldest peer (or peer descendant)
  // that is startable across all parents' subtrees.
  const peerCandidates = new Set();
  for (const parentId of parents) {
    for (const sib of graph.children.get(parentId) ?? []) {
      if (sib === reference.id) continue;
      peerCandidates.add(sib);
    }
  }

  const sortedPeers = [...peerCandidates].sort(idCompare);
  for (const peerId of sortedPeers) {
    const startable = findOldestStartable(peerId, graph);
    if (startable) {
      const next = graph.byId.get(startable);
      const note =
        startable === peerId
          ? `oldest peer of ${reference.id} that is unblocked.`
          : `oldest startable descendant of peer ${peerId}.`;
      info(`\nNext: ${describe(next)}`);
      info(`Why: ${note}`);
      process.stdout.write(`${next.id}\n`);
      return;
    }
  }

  // Nothing in peer subtrees is startable. Report the parent(s) and what's
  // still blocking them. Stdout stays empty so the caller can detect the
  // "no suggestion" case without parsing prose:
  //   id=$(bl what-next 2>/dev/null); [[ -z "$id" ]] && ...
  info(`\nNo startable peer or peer descendant found. Parents still blocked:`);
  for (const parentId of parents) {
    const parent = graph.byId.get(parentId);
    if (!parent) continue;
    if (isDone(parent.status)) {
      info(`  ${describe(parent)} [${parent.status}]`);
      continue;
    }
    const parentDeps = graph.children.get(parentId) ?? [];
    const blockers = parentDeps.filter((d) => !isDone(graph.byId.get(d)?.status));
    info(`  ${describe(parent)} — blocked on: ${blockers.join(', ') || '(none)'}`);
  }
}
