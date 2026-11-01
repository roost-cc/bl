import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { ancestorsOf, buildGraph, renderTree, rootsWithin } from '../../src/tree.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';
import { FLOW_TEMPLATE } from '../helpers/tempdir.js';
import { loadFlow } from '../../src/flow.js';
import { dirname } from 'path';

const flow = loadFlow(dirname(FLOW_TEMPLATE));

function loadGraph() {
  const { dir, cleanup } = buildSampleBacklog();
  const cfg = loadConfig({ backlogRoot: dir });
  const stories = readAllStories(cfg);
  const byId = new Map(stories.map((s) => [s.id, s]));
  const graph = buildGraph(stories);
  return { graph, byId, cleanup };
}

test('buildGraph produces children/parents for a known chain', () => {
  const { graph, cleanup } = loadGraph();
  try {
    // S-1 → S-2 → S-3 → S-4. children(S-x) = depends_on of x.
    assert.deepEqual(graph.children.get('S-2') ?? [], ['S-1']);
    assert.deepEqual(graph.children.get('S-3') ?? [], ['S-2']);
    assert.deepEqual(graph.children.get('S-4') ?? [], ['S-3']);
    // parents(S-x) = stories x is required_for / that depend on x
    assert.deepEqual(graph.parents.get('S-1') ?? [], ['S-2']);
    assert.deepEqual(graph.parents.get('S-3') ?? [], ['S-4']);
  } finally {
    cleanup();
  }
});

test('rootsWithin picks ids whose parents lie outside the candidate set', () => {
  const { graph, cleanup } = loadGraph();
  try {
    const all = new Set(['S-1', 'S-2', 'S-3', 'S-4']);
    // S-4 is the only id with no parent inside the set (nothing depends on it).
    assert.deepEqual(rootsWithin(all, graph), ['S-4']);
  } finally {
    cleanup();
  }
});

test('renderTree renders a chain root-down with status markers', () => {
  const { graph, byId, cleanup } = loadGraph();
  try {
    const { lines, stats } = renderTree('S-4', graph, byId, new Set(), flow);
    // Root line: S-4 (backlog)
    assert.match(lines[0], /^S-4 Fourth \(backlog\)$/);
    // Should include a "(done)" marker for S-1.
    assert.ok(
      lines.some((l) => /\bS-1\b First \(done\)/.test(l)),
      'expected a (done) S-1 line, got:\n' + lines.join('\n'),
    );
    assert.equal(stats.total, 4);
    assert.equal(stats.done, 1);
  } finally {
    cleanup();
  }
});

test('renderTree dims done nodes when color is on', () => {
  const { graph, byId, cleanup } = loadGraph();
  try {
    const { lines } = renderTree('S-4', graph, byId, new Set(), flow, true);
    // The done S-1 line is wrapped in faint (\x1b[2m … \x1b[0m).
    const doneLine = lines.find((l) => /S-1 First \(done\)/.test(l));
    assert.ok(doneLine, 'expected a (done) S-1 line, got:\n' + lines.join('\n'));
    assert.ok(doneLine.includes('\x1b[2m'), 'done line should contain a dim escape');
    assert.ok(doneLine.includes('\x1b[0m'), 'done line should contain a reset escape');
    // The backlog root line is untouched — no dim escapes.
    assert.match(lines[0], /^S-4 Fourth \(backlog\)$/);
    assert.ok(!lines[0].includes('\x1b[2m'), 'root line should not be dimmed');
  } finally {
    cleanup();
  }
});

test('renderTree emits no dim escapes when color is off', () => {
  const { graph, byId, cleanup } = loadGraph();
  try {
    // The NO_COLOR / piped path: color=false yields plain text everywhere.
    const { lines } = renderTree('S-4', graph, byId, new Set(), flow, false);
    assert.ok(
      lines.every((l) => !l.includes('\x1b[2m')),
      'no line should contain a dim escape, got:\n' + lines.join('\n'),
    );
  } finally {
    cleanup();
  }
});

test('ancestorsOf walks parents from a single seed up to the chain root', () => {
  const { graph, cleanup } = loadGraph();
  try {
    // Seed S-1 — every other story in the chain depends on it transitively,
    // so all four ids should appear.
    const all = ancestorsOf(['S-1'], graph);
    assert.deepEqual([...all].sort(), ['S-1', 'S-2', 'S-3', 'S-4']);

    // Seed S-3 — only S-3 and S-4 are above it in the chain.
    const upper = ancestorsOf(['S-3'], graph);
    assert.deepEqual([...upper].sort(), ['S-3', 'S-4']);
  } finally {
    cleanup();
  }
});

test('ancestorsOf seeded from multiple ids collapses to the same root set', () => {
  const { graph, cleanup } = loadGraph();
  try {
    // Two pending stories on the same chain — together their ancestor union
    // still yields a single root (S-4). This is the invariant that backs the
    // "no duplicate trees" acceptance criterion at the rootsWithin boundary.
    const seed = ancestorsOf(['S-2', 'S-3'], graph);
    const roots = rootsWithin(seed, graph);
    assert.deepEqual(roots, ['S-4']);
  } finally {
    cleanup();
  }
});

test('epic-scope candidate set excludes done seeds without --all', () => {
  const { dir, cleanup } = buildSampleBacklog();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const stories = readAllStories(cfg);
    const graph = buildGraph(stories);

    // C00 contains S-1 (done) and S-2 (backlog). Without --all, only S-2
    // seeds the walk; ancestors are S-2, S-3, S-4 (the out-of-epic chain).
    const pendingSeeds = stories
      .filter((s) => s.componentId === 'C00')
      .filter((s) => s.status !== 'done' && s.status !== 'superseded')
      .map((s) => s.id);
    assert.deepEqual(pendingSeeds.sort(), ['S-2']);

    const candidates = ancestorsOf(pendingSeeds, graph);
    // S-1 is done and not seeded; the ancestor walk goes upward (parents),
    // so S-1 (a child of S-2) is excluded. S-2, S-3, S-4 are included as
    // S-2's required_for chain reaches up to S-4.
    assert.deepEqual([...candidates].sort(), ['S-2', 'S-3', 'S-4']);

    // With --all the seed is the entire epic membership, which extends the
    // candidate set down to S-1 (the original chain leaf below S-2).
    const allSeeds = stories.filter((s) => s.componentId === 'C00').map((s) => s.id);
    const allCandidates = ancestorsOf(allSeeds, graph);
    assert.deepEqual([...allCandidates].sort(), ['S-1', 'S-2', 'S-3', 'S-4']);
  } finally {
    cleanup();
  }
});
