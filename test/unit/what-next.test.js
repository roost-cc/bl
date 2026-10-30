import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { readAllStories } from '../../src/story.js';
import { buildGraph, findOldestStartable, pickNextInComponent } from '../../src/what-next.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';

function withGraph(builder, fn) {
  const { dir, cleanup } = builder();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const stories = readAllStories(cfg);
    const graph = buildGraph(stories);
    return fn(graph);
  } finally {
    cleanup();
  }
}

function withBacklog(builder, fn) {
  const { dir, cleanup } = builder();
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const stories = readAllStories(cfg);
    const graph = buildGraph(stories);
    return fn({ cfg, stories, graph, dir });
  } finally {
    cleanup();
  }
}

test('findOldestStartable returns the next unblocked descendant in a chain', () => {
  withGraph(buildSampleBacklog, (graph) => {
    // S-4 ← S-3 ← S-2 ← S-1 (done). Only S-2 is unblocked.
    assert.equal(findOldestStartable('S-4', graph), 'S-2');
  });
});

test('findOldestStartable returns null when the entire subtree is done', () => {
  withGraph(
    () =>
      mkTempBacklog({
        components: [
          {
            id: 'C00',
            title: 'Foundation',
            dirSuffix: 'f',
          },
        ],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'first',
            dirSuffix: 'first',
            status: 'done',
            completed: '2026-01-01',
            required_for: ['S-2'],
          },
          {
            id: 'S-2',
            component: 'C00',
            title: 'second',
            dirSuffix: 'second',
            depends_on: ['S-1'],
            status: 'done',
            completed: '2026-01-02',
          },
        ],
      }),
    (graph) => {
      assert.equal(findOldestStartable('S-2', graph), null);
    },
  );
});

test('findOldestStartable terminates on a dependency cycle (does not infinite loop)', () => {
  // S-1 depends_on S-2; S-2 depends_on S-1. Neither is done.
  withGraph(
    () =>
      mkTempBacklog({
        components: [
          {
            id: 'C00',
            title: 'Cycle',
            dirSuffix: 'cycle',
          },
        ],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'one',
            dirSuffix: 'one',
            depends_on: ['S-2'],
          },
          {
            id: 'S-2',
            component: 'C00',
            title: 'two',
            dirSuffix: 'two',
            depends_on: ['S-1'],
          },
        ],
      }),
    (graph) => {
      // No node is startable (every node has an unfinished dep), so we should
      // bottom out at null rather than spin.
      assert.equal(findOldestStartable('S-1', graph), null);
      assert.equal(findOldestStartable('S-2', graph), null);
    },
  );
});

test('buildGraph self-loops are ignored', () => {
  withGraph(
    () =>
      mkTempBacklog({
        components: [
          {
            id: 'C00',
            title: 'Self',
            dirSuffix: 'self',
          },
        ],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'lonely',
            dirSuffix: 'lonely',
            depends_on: ['S-1'],
          },
        ],
      }),
    (graph) => {
      // Self-loop must not produce a children entry.
      assert.equal(graph.children.has('S-1'), false);
    },
  );
});

test('pickNextInComponent returns next startable story by priority', () => {
  withBacklog(
    () =>
      mkTempBacklog({
        components: [{ id: 'C00', title: 'Foo', dirSuffix: 'foo' }],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'first',
            dirSuffix: 'first',
            status: 'done',
            completed: '2026-01-01',
          },
          {
            id: 'S-2',
            component: 'C00',
            title: 'second',
            dirSuffix: 'second',
            depends_on: ['S-1'],
          },
          {
            id: 'S-3',
            component: 'C00',
            title: 'third',
            dirSuffix: 'third',
            depends_on: ['S-2'],
          },
        ],
      }),
    ({ stories, graph }) => {
      // No priority entries → falls back to oldest leaf, which is S-2
      // (S-3 has unfinished dep S-2).
      const r = pickNextInComponent('C00', stories, graph, new Map());
      assert.equal(r.kind, 'next');
      assert.equal(r.story.id, 'S-2');
      assert.equal(r.method, 'oldest-leaf');
    },
  );
});

test('pickNextInComponent priority rank beats lower numeric ID', () => {
  withBacklog(
    () =>
      mkTempBacklog({
        components: [{ id: 'C00', title: 'Foo', dirSuffix: 'foo' }],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'one',
            dirSuffix: 'one',
          },
          {
            id: 'S-2',
            component: 'C00',
            title: 'two',
            dirSuffix: 'two',
          },
        ],
      }),
    ({ stories, graph }) => {
      // Both startable. Priority puts S-2 ahead of S-1 — priority wins
      // over numeric-ID tiebreak.
      const priority = new Map([
        ['S-2', 0],
        ['S-1', 1],
      ]);
      const r = pickNextInComponent('C00', stories, graph, priority);
      assert.equal(r.kind, 'next');
      assert.equal(r.story.id, 'S-2');
      assert.equal(r.method, 'priority');
    },
  );
});

test('pickNextInComponent falls back to oldest leaf when none in priority table', () => {
  withBacklog(
    () =>
      mkTempBacklog({
        components: [{ id: 'C00', title: 'Foo', dirSuffix: 'foo' }],
        stories: [
          {
            id: 'S-2',
            component: 'C00',
            title: 'two',
            dirSuffix: 'two',
          },
          {
            id: 'S-3',
            component: 'C00',
            title: 'three',
            dirSuffix: 'three',
          },
        ],
      }),
    ({ stories, graph }) => {
      const r = pickNextInComponent('C00', stories, graph, new Map());
      assert.equal(r.kind, 'next');
      assert.equal(r.story.id, 'S-2');
      assert.equal(r.method, 'oldest-leaf');
    },
  );
});

test('pickNextInComponent returns all-done when every story is closed', () => {
  withBacklog(
    () =>
      mkTempBacklog({
        components: [{ id: 'C00', title: 'Foo', dirSuffix: 'foo' }],
        stories: [
          {
            id: 'S-1',
            component: 'C00',
            title: 'one',
            dirSuffix: 'one',
            status: 'done',
            completed: '2026-01-01',
          },
          {
            id: 'S-2',
            component: 'C00',
            title: 'two',
            dirSuffix: 'two',
            status: 'superseded',
          },
        ],
      }),
    ({ stories, graph }) => {
      const r = pickNextInComponent('C00', stories, graph, new Map());
      assert.equal(r.kind, 'all-done');
    },
  );
});

test('pickNextInComponent returns blocked when only open story has unfinished out-of-epic dep', () => {
  withBacklog(
    () =>
      mkTempBacklog({
        components: [
          { id: 'C00', title: 'Foo', dirSuffix: 'foo' },
          { id: 'C01', title: 'Bar', dirSuffix: 'bar' },
        ],
        stories: [
          {
            id: 'S-1',
            component: 'C01',
            title: 'out-of-epic blocker',
            dirSuffix: 'blocker',
          },
          {
            id: 'S-2',
            component: 'C00',
            title: 'in-epic but blocked',
            dirSuffix: 'blocked',
            depends_on: ['S-1'],
          },
        ],
      }),
    ({ stories, graph }) => {
      const r = pickNextInComponent('C00', stories, graph, new Map());
      assert.equal(r.kind, 'blocked');
      assert.equal(r.open.length, 1);
      assert.equal(r.open[0].id, 'S-2');
    },
  );
});
