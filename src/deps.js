/**
 * deps.js — leaf-first ordered work plan for one story's blocking cone.
 *
 * Answers "what do I have to build before I can start this story, and in what
 * order?". Collects the target's transitive dependency closure (via
 * `buildGraph()`'s `children` map — the union of `depends_on` and the reverse
 * of every other story's `required_for`), drops everything already closed, and
 * emits the remainder leaf-first, target last.
 *
 * `bl tree` renders the same edges but buries the target inside a forest of
 * unrelated parents; `bl what-next` picks a single next story. This command
 * produces the full ordered runway for one target.
 */

import { loadConfig, parseArgs, normalizeId, info, componentIdHint } from './config.js';
import { readAllStories } from './story.js';
import { buildGraph } from './what-next.js';
import { flowForHelp, loadFlow, statusWords } from './flow.js';

function idNum(id) {
  const m = String(id).match(/^S-(\d+)$/);
  return m ? parseInt(m[1], 10) : Infinity;
}

function idCompare(a, b) {
  return idNum(a) - idNum(b);
}

/**
 * Transitive dependency closure of `targetId`, pruned at closed stories.
 *
 * A `done`/`superseded` story is neither included nor descended through — its
 * own dependencies are irrelevant to work that remains. The consequence worth
 * remembering downstream: every unfinished dependency of a cone node is itself
 * in the cone, so readiness can be decided purely against the cone.
 *
 * Returns a Set of story IDs (including the target, unless it is closed).
 */
export function collectCone(targetId, graph, flow) {
  const cone = new Set();
  const stack = [targetId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (cone.has(id)) continue;
    const story = graph.byId.get(id);
    if (!story || flow.meets('story', story.status, 'done')) continue;
    cone.add(id);
    for (const dep of graph.children.get(id) ?? []) stack.push(dep);
  }
  return cone;
}

/**
 * For each cone node, how many *other* cone nodes transitively depend on it.
 *
 * Counted within the cone only — this describes the plan being executed, so a
 * story's rank never shifts because of unrelated backlog work. The target is
 * always 0.
 *
 * A plain BFS per node over the reverse edges. Memoising across nodes would be
 * faster but goes subtly wrong on a cycle (a partial result computed while the
 * cycle is still on the stack gets cached as if complete), and cones are small
 * enough that the quadratic walk costs nothing.
 *
 * Returns a Map of id -> count.
 */
export function unblockCounts(cone, graph) {
  const counts = new Map();
  for (const id of cone) {
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const parent of graph.parents.get(cur) ?? []) {
        if (!cone.has(parent) || seen.has(parent)) continue;
        seen.add(parent);
        queue.push(parent);
      }
    }
    counts.set(id, seen.size - 1); // exclude the node itself
  }
  return counts;
}

/**
 * Order the cone leaf-first: no story appears before one of its own
 * dependencies. Within a layer, stories that unblock more of the listed
 * stories come first; ties break on lowest numeric ID for determinism.
 *
 * If a cycle leaves nodes that can never become ready, the orderable prefix is
 * emitted first, then the remainder sorted by ID, with `cycle: true` set.
 * `targetId` still goes last in that remainder: the plan's shape is "everything
 * you need, then the thing you wanted", and a cycle is no reason to hand back a
 * list whose final entry isn't what the user asked for.
 *
 * Returns `{ order: string[], cycle: boolean }`.
 */
export function orderCone(cone, graph, counts, targetId) {
  const remaining = new Set(cone);
  const emitted = new Set();
  const order = [];

  const rank = (a, b) => {
    const ua = counts.get(a) ?? 0;
    const ub = counts.get(b) ?? 0;
    if (ua !== ub) return ub - ua;
    return idCompare(a, b);
  };

  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) =>
      (graph.children.get(id) ?? []).filter((d) => cone.has(d)).every((d) => emitted.has(d)),
    );
    if (ready.length === 0) {
      // Cycle: nothing left can become ready. Emit the rest by ID so no story
      // is silently dropped from the plan, keeping the target last — sorting
      // it purely by ID would otherwise float a low-numbered target above its
      // own blockers.
      const rest = [...remaining].sort(idCompare).filter((id) => id !== targetId);
      if (remaining.has(targetId)) rest.push(targetId);
      return { order: [...order, ...rest], cycle: true };
    }
    ready.sort(rank);
    for (const id of ready) {
      order.push(id);
      emitted.add(id);
      remaining.delete(id);
    }
  }
  return { order, cycle: false };
}

/**
 * Render the annotated plan rows: `  <id>  <status>  unblocks N  <title>`.
 *
 * ID and status are padded to the widest value in the plan so both columns can
 * be scanned down the left edge. `done`/`superseded` never appear — `collectCone`
 * prunes closed stories — so in practice the status cell is at most 11 wide.
 *
 * Kept separate from `main()` so alignment is testable without spawning the CLI.
 * Returns an array of strings, one per story in `order`.
 */
export function formatPlanRows(order, graph, counts) {
  const field = (id, key) => graph.byId.get(id)?.[key] ?? '';
  const idWidth = Math.max(0, ...order.map((id) => id.length));
  const statusWidth = Math.max(0, ...order.map((id) => field(id, 'status').length));
  return order.map((id) => {
    const idCell = id.padEnd(idWidth);
    const statusCell = field(id, 'status').padEnd(statusWidth);
    const n = counts.get(id) ?? 0;
    return `  ${idCell}  ${statusCell}  unblocks ${n}  ${field(id, 'title')}`.trimEnd();
  });
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    const closedWords = statusWords(
      flowForHelp()
        .closedStatusesOf('story')
        .map((s) => `\`${s}\``),
      'and',
    );
    console.log(`Usage: bl deps <story-id>

Arguments:
  <story-id>   Required. The story you want to land.

Prints the ordered work plan for a story: every open story in its
transitive \`depends_on\` closure, leaf-first, ending with the story
itself. No story is listed before one of its own dependencies; within
that constraint, stories that unblock more of the plan come first.

${closedWords} stories are omitted, and the walk does not
descend through them.

stdout is one story ID per line and nothing else, so it composes:

  bl implement $(bl deps S-53)

The annotated plan — header, status column, titles, and "unblocks N"
counts — goes to stderr:

  S-598  refined      unblocks 2  Some title
  S-599  backlog      unblocks 1  Another title

The status column shows each story's current status, so you can see at a
glance which leaves are startable: \`bl implement\` requires \`refined\`, so a
leaf sitting at \`backlog\` needs \`bl refine\` first. ${closedWords.replace(' and ', ' and\n')} never appear, since closed stories are pruned from the plan.`);
    process.exit(0);
  }

  const raw = args.positional[0];
  if (!raw) {
    console.error('bl deps: missing argument (expected S-<n>)');
    process.exit(1);
  }
  if (componentIdHint(raw)) {
    console.error(`bl deps: ${componentIdHint(raw)}`);
    process.exit(1);
  }
  if (/^[Cc]-?\d+$/.test(raw)) {
    console.error(
      `bl deps: component ids are not supported: ${raw} — a dependency cone is rooted at a single story. Try \`bl what-next ${raw}\`.`,
    );
    process.exit(1);
  }
  if (!/^[Ss]-?\d+$/.test(raw)) {
    console.error(`bl deps: invalid id (expected S-<n>): ${raw}`);
    process.exit(1);
  }
  const parsed = normalizeId(raw);
  if (!parsed) {
    console.error(`bl deps: invalid id (expected S-<n>): ${raw}`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const flow = loadFlow(cfg.backlogRoot);
  const stories = readAllStories(cfg);
  const target = stories.find((s) => s.id === parsed.id);
  if (!target) {
    console.error(`bl deps: story not found: ${parsed.id}`);
    process.exit(1);
  }

  if (flow.meets('story', target.status, 'done')) {
    info(`${target.id} is ${target.status} — nothing to plan.`);
    return;
  }

  const graph = buildGraph(stories);
  const cone = collectCone(target.id, graph, flow);
  const counts = unblockCounts(cone, graph);
  const { order, cycle } = orderCone(cone, graph, counts, target.id);

  const title = (id) => graph.byId.get(id)?.title ?? '';
  info(`Plan for ${target.id} ${title(target.id)}`.trimEnd());
  info('');
  for (const row of formatPlanRows(order, graph, counts)) info(row);
  if (cycle) {
    info('');
    info(
      'Warning: a dependency cycle inside this cone left some stories unorderable; they are listed after the orderable prefix, by ID.',
    );
  }

  process.stdout.write(order.map((id) => `${id}\n`).join(''));
}
