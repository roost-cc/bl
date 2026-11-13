import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadFlow } from '../../src/flow.js';
import {
  BLOCKERS_FILE,
  BlockersError,
  dependencyEdge,
  dependsOnEdges,
  describeCycle,
  findBlockersFindings,
  findHoldCycles,
  formatBlockers,
  gateIds,
  gatesAt,
  heldAt,
  heldBy,
  heldLines,
  holdGraph,
  inFeature,
  isActive,
  isMet,
  edgeProblems,
  mergeEdges,
  parseBlockers,
  readBlockers,
  readEdges,
  readUnits,
  repoEnd,
  storyUnitOf,
  unitIndex,
  unmetEdges,
  wouldCycle,
} from '../../src/blockers.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';
import { FLOW_TEMPLATE, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { GUARDS } from '../../src/guards.js';

// templates/ holds bl init's flow.json, so it reads as a backlog root.
const flow = loadFlow(dirname(FLOW_TEMPLATE));

const edge = (blocker, gate, unit, until = 'done', active_when) => ({
  blocker,
  gate,
  unit,
  until,
  ...(active_when ? { active_when } : {}),
});

/** F-1 (S-a, S-d), F-2 (S-b, S-c), standalone S-x, S-y, and a done S-z. */
const FEATURE_OF = { 'S-a': 'F-1', 'S-d': 'F-1', 'S-b': 'F-2', 'S-c': 'F-2', 'S-x': '', 'S-y': '', 'S-z': '' };

function units({ status = {} } = {}) {
  return unitIndex(
    [
      { id: 'S-a', status: 'backlog', feature: 'F-1' },
      { id: 'S-d', status: 'backlog', feature: 'F-1' },
      { id: 'S-b', status: 'backlog', feature: 'F-2' },
      { id: 'S-c', status: 'backlog', feature: 'F-2' },
      { id: 'S-x', status: status['S-x'] ?? 'backlog' },
      { id: 'S-y', status: status['S-y'] ?? 'backlog' },
      { id: 'S-z', status: 'done' },
    ],
    [
      { id: 'F-1', status: status['F-1'] ?? 'approved', stories: ['S-a', 'S-d'] },
      { id: 'F-2', status: status['F-2'] ?? 'approved', stories: ['S-b', 'S-c'] },
    ],
  );
}

/** The edges `depends_on:` keys over `units()`' stories stand for: `{ 'S-a': 'S-b' }` is S-a depends_on S-b. */
const deps = (map) =>
  dependsOnEdges(Object.entries(FEATURE_OF).map(([id, unit]) => ({ id, unit, depends_on: map[id] ? [map[id]] : [] })));

test('formatBlockers sorts by unit, blocker, gate, one edge per line, and round-trips byte for byte', () => {
  const edges = [
    edge('S-y', 'run', 'S-x'),
    edge('S-x', 'merge', 'F-1', 'done', { unit: 'F-2', status: 'done' }),
    edge('S-b', 'run', 'F-1'),
    edge('S-b', 'merge', 'F-1'),
    edge('S-z', 'run', '*'),
  ];
  const text = formatBlockers(edges);
  assert.equal(
    text,
    `{
  "schema": "bl-blockers/v2",
  "edges": [
    {"blocker":"S-z","gate":"run","unit":"*","until":"done"},
    {"blocker":"S-b","gate":"merge","unit":"F-1","until":"done"},
    {"blocker":"S-b","gate":"run","unit":"F-1","until":"done"},
    {"blocker":"S-x","gate":"merge","unit":"F-1","until":"done","active_when":{"unit":"F-2","status":"done"}},
    {"blocker":"S-y","gate":"run","unit":"S-x","until":"done"}
  ]
}
`,
  );
  assert.equal(formatBlockers(parseBlockers(text)), text);
  assert.equal(formatBlockers([]), `{\n  "schema": "bl-blockers/v2",\n  "edges": []\n}\n`);
});

test('readBlockers: a missing file is an empty graph; writeBlockers writes it sorted and a read-write is byte-identical', () => {
  const dir = mkTempDir('bl-blockers-');
  assert.deepEqual(readBlockers(dir), { edges: [], text: null, path: join(dir, BLOCKERS_FILE), schema: null });
  writeBlockersLocked(dir, [edge('S-y', 'run', 'S-x'), edge('S-b', 'run', 'F-1')]);
  const first = readFileSync(join(dir, BLOCKERS_FILE), 'utf8');
  const read = readBlockers(dir);
  assert.deepEqual(
    read.edges.map((e) => e.unit),
    ['F-1', 'S-x'],
  );
  writeBlockersLocked(dir, read.edges);
  assert.equal(readFileSync(join(dir, BLOCKERS_FILE), 'utf8'), first);
  // Staged under .bl/tmp, nothing left beside the file.
  assert.ok(!existsSync(join(dir, `${BLOCKERS_FILE}.tmp`)));
});

test('parseBlockers refuses JSON it cannot read, naming the file', () => {
  for (const [text, reason] of [
    ['{ nope', /not valid JSON/],
    [
      `{"schema":"bl-blockers/v0","edges":[]}`,
      /"schema" is "bl-blockers\/v0", not "bl-blockers\/v1" or "bl-blockers\/v2"/,
    ],
    [`{"schema":"bl-blockers/v1"}`, /"edges" is not a list/],
    [`{"schema":"bl-blockers/v1","edges":[],"x":1}`, /unknown key "x"/],
    [`{"schema":"bl-blockers/v1","edges":[{"blocker":"S-1","gate":"run","unit":"S-2"}]}`, /edge 1 has no "until"/],
    [
      `{"schema":"bl-blockers/v1","edges":[{"blocker":"S-1","gate":"run","unit":"S-2","until":"done","why":"x"}]}`,
      /edge 1 has unknown key "why"/,
    ],
    [
      `{"schema":"bl-blockers/v1","edges":[{"blocker":"S-1","gate":"run","unit":"S-2","until":"done","active_when":{"unit":"F-1"}}]}`,
      /"active_when" is not/,
    ],
  ]) {
    assert.throws(
      () => parseBlockers(text, '/b/blockers.json'),
      (err) => err instanceof BlockersError && err.message.startsWith('/b/blockers.json: ') && reason.test(err.reason),
      text,
    );
  }
});

test("isMet uses flow.json's meets: superseded meets done; isActive waits for active_when", () => {
  const u = units({ status: { 'S-x': 'superseded', 'F-2': 'running' } });
  assert.equal(isMet(edge('S-x', 'run', 'S-y'), u, flow), true);
  assert.equal(isMet(edge('S-y', 'run', 'S-x'), u, flow), false);
  assert.equal(isMet(edge('S-nope', 'run', 'S-x'), u, flow), false);
  assert.equal(isActive(edge('S-y', 'run', '*', 'done', { unit: 'F-2', status: 'done' }), u, flow), false);
  assert.equal(isActive(edge('S-y', 'run', '*', 'done', { unit: 'F-2', status: 'approved' }), u, flow), true);
});

test('unmetEdges: the active, unmet edges at the gate on the units or on *', () => {
  const u = units({ status: { 'F-2': 'done' } });
  const edges = [
    edge('S-y', 'run', 'S-x'),
    edge('S-y', 'merge', 'S-x'),
    edge('S-z', 'run', 'S-x'),
    edge('S-y', 'run', '*', 'done', { unit: 'F-2', status: 'done' }),
    edge('S-x', 'run', '*', 'done', { unit: 'F-1', status: 'done' }),
    edge('S-y', 'run', 'S-a'),
  ];
  assert.deepEqual(unmetEdges(edges, ['S-x'], 'run', u, flow), [edges[0], edges[3]]);
});

test('blockers-cycle: two features whose stories depend across them deadlock with no story cycle', () => {
  const u = units();
  const cycles = findHoldCycles(holdGraph(deps({ 'S-a': 'S-b', 'S-c': 'S-d' }), u, flow));
  assert.equal(cycles.length, 1);
  assert.equal(describeCycle(cycles[0]), 'F-1 → F-2 (S-a at run by S-b) → F-1 (S-c at run by S-d)');
  // A depends_on inside one feature is an order edge, not a hold.
  assert.deepEqual(findHoldCycles(holdGraph(deps({ 'S-a': 'S-d', 'S-d': 'S-a' }), u, flow)), []);
  // A depends_on on a closed story holds nothing.
  assert.deepEqual(findHoldCycles(holdGraph(deps({ 'S-x': 'S-z' }), u, flow)), []);
});

test('blockers-cycle: an edge and a depends_on close a cycle; a met or inactive edge does not', () => {
  const u = units();
  const held = [edge('S-x', 'run', 'F-1'), ...deps({ 'S-x': 'S-a' })];
  assert.equal(
    describeCycle(findHoldCycles(holdGraph(held, u, flow))[0]),
    'F-1 → S-x (F-1 at run by S-x) → F-1 (S-x at run by S-a)',
  );
  assert.deepEqual(
    findHoldCycles(holdGraph([edge('S-x', 'run', 'F-1', 'backlog'), ...deps({ 'S-x': 'S-a' })], u, flow)),
    [],
  );
  const inactive = [edge('S-x', 'run', 'F-1', 'done', { unit: 'S-y', status: 'done' }), ...deps({ 'S-x': 'S-a' })];
  assert.deepEqual(findHoldCycles(holdGraph(inactive, u, flow)), []);
});

test('blockers-cycle: a wildcard edge whose blocker has the gate holds itself', () => {
  const u = units();
  const cycles = findHoldCycles(holdGraph([edge('S-x', 'run', '*')], u, flow));
  assert.deepEqual(cycles.map(describeCycle), ['S-x → S-x (* at run by S-x)']);
  // A story of a feature stands as its feature.
  assert.deepEqual(findHoldCycles(holdGraph([edge('S-a', 'run', '*')], u, flow)).map(describeCycle), [
    'F-1 → F-1 (* at run by S-a)',
  ]);
});

test('wouldCycle: refuses the edge that closes a cycle; an inactive or met new edge adds none', () => {
  const u = units();
  const dep = deps({ 'S-x': 'S-a' });
  assert.equal(
    describeCycle(wouldCycle(edge('S-x', 'merge', 'F-1'), dep, u, flow)),
    'F-1 → S-x (F-1 at merge by S-x) → F-1 (S-x at run by S-a)',
  );
  assert.equal(wouldCycle(edge('S-x', 'run', 'S-a', 'done', { unit: 'S-y', status: 'done' }), dep, u, flow), null);
  assert.ok(wouldCycle(edge('S-x', 'run', 'S-a', 'done', { unit: 'S-y', status: 'backlog' }), dep, u, flow));
  assert.ok(wouldCycle(edge('S-y', 'run', '*'), [], u, flow));
  assert.ok(wouldCycle(edge('S-y', 'run', 'S-x'), [edge('S-x', 'run', 'S-y')], u, flow));
  assert.equal(wouldCycle(edge('S-y', 'run', 'S-x'), [], u, flow), null);
  assert.equal(wouldCycle(edge('S-z', 'run', '*'), [], u, flow), null, 'a done blocker holds nothing');
});

test('findBlockersFindings reports each D5 fault in a hand-edited file', () => {
  const dir = mkTempDir('bl-blockers-');
  const u = units({ status: { 'F-2': 'done' } });
  const lines = [
    `{"blocker":"S-y","gate":"run","unit":"S-x","until":"done"}`,
    `{"blocker":"S-x","gate":"run","unit":"S-y","until":"done"}`,
    `{"blocker":"S-nope","gate":"run","unit":"S-x","until":"done"}`,
    `{"blocker":"S-y","gate":"deploy","unit":"S-x","until":"done"}`,
    `{"blocker":"S-y","gate":"merge","unit":"S-x","until":"shipped"}`,
    `{"blocker":"S-y","gate":"run","unit":"S-x","until":"done"}`,
    `{"blocker":"F-2","gate":"merge","unit":"S-x","until":"superseded"}`,
    `{"blocker":"*","gate":"merge","unit":"F-1","until":"done"}`,
    `{"blocker":"S-y","gate":"merge","unit":"F-1","until":"done","active_when":{"unit":"F-9","status":"done"}}`,
    `{"blocker":"S-y","gate":"merge","unit":"S-a","until":"done","active_when":{"unit":"F-2","status":"merged"}}`,
  ];
  writeFileSync(join(dir, BLOCKERS_FILE), `{"schema":"bl-blockers/v1","edges":[\n${lines.join(',\n')}\n]}\n`);
  const findings = findBlockersFindings({ backlogRoot: dir }, u, flow);
  const by = (code) => findings.filter((f) => f.code === code).map((f) => f.message);
  assert.ok(findings.every((f) => f.location === BLOCKERS_FILE));
  assert.deepEqual(by('blockers-order'), [
    'not sorted by unit, blocker and gate one edge per line as bl writes it; bl block list --fix rewrites it',
  ]);
  assert.equal(findings.find((f) => f.code === 'blockers-order').severity, 'warning');
  assert.deepEqual(by('blockers-unit'), [
    'S-x at run by S-nope: blocker S-nope is not a unit in the backlog',
    `F-1 at merge by *: the blocker is never "*"`,
    'F-1 at merge by S-y: active_when unit F-9 is not a unit in the backlog',
  ]);
  assert.deepEqual(by('blockers-gate'), [`S-x at deploy by S-y: a story has no gate "deploy" in flow.json`]);
  assert.deepEqual(by('blockers-status'), [
    `S-x at merge by S-y: until "shipped" is not a story status in flow.json`,
    `S-a at merge by S-y: active_when status "merged" is not a feature status in flow.json`,
  ]);
  assert.deepEqual(by('blockers-duplicate'), ['S-x at run by S-y is listed more than once']);
  assert.deepEqual(by('blockers-unmeetable'), [
    `S-x at merge by F-2: F-2 is done, closed, and never meets "superseded"`,
  ]);
  assert.deepEqual(by('blockers-cycle'), ['deadlock: S-x → S-y (S-x at run by S-y) → S-x (S-y at run by S-x)']);
  for (const f of findings.filter((x) => x.code !== 'blockers-order')) assert.equal(f.severity, 'error', f.code);

  writeFileSync(join(dir, BLOCKERS_FILE), '{ nope');
  const broken = findBlockersFindings({ backlogRoot: dir }, u, flow);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].code, 'blockers-json');
  assert.match(broken[0].message, /not valid JSON/);
});

test('findBlockersFindings: a missing file has no findings', () => {
  assert.deepEqual(findBlockersFindings({ backlogRoot: mkTempDir('bl-blockers-') }, units(), flow), []);
});

test('findBlockersFindings: a cycle of depends_on: keys is blockers-cycle, a deadlock or a story order cycle (F-111 D4)', () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', depends_on: ['S-2'] },
      { id: 'S-2', component: 'C01', title: 'Two', depends_on: ['S-1'] },
      { id: 'S-3', component: 'C01', title: 'Three', feature: 'F-1', depends_on: ['S-4'] },
      { id: 'S-4', component: 'C01', title: 'Four', feature: 'F-1', depends_on: ['S-3'] },
      { id: 'S-5', component: 'C01', title: 'Five', feature: 'F-1', depends_on: ['S-1'] },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: 'approved', stories: ['S-3', 'S-4', 'S-5'] }],
  });
  const config = { backlogRoot: dir };
  assert.deepEqual(
    findBlockersFindings(config, readUnits(config), flow).map((f) => [f.code, f.location, f.message]),
    [
      ['blockers-cycle', BLOCKERS_FILE, 'deadlock: S-1 → S-2 (S-1 at run by S-2) → S-1 (S-2 at run by S-1)'],
      [
        'blockers-cycle',
        BLOCKERS_FILE,
        'story order cycle: S-3 → S-4 (order edge S-4 → S-3) → S-3 (order edge S-3 → S-4)',
      ],
    ],
  );
});

test('unmetEdges: a dormant active_when holds nothing, a live one holds; a superseded blocker meets done', () => {
  const wild = edge('S-y', 'run', '*', 'done', { unit: 'S-x', status: 'done' });
  assert.deepEqual(unmetEdges([wild], ['F-1'], 'run', units(), flow), []);
  assert.deepEqual(unmetEdges([wild], ['F-1'], 'run', units({ status: { 'S-x': 'done' } }), flow), [wild]);
  const onX = edge('S-y', 'merge', 'S-x');
  assert.deepEqual(unmetEdges([onX], ['S-x'], 'merge', units({ status: { 'S-y': 'in_progress' } }), flow), [onX]);
  assert.deepEqual(unmetEdges([onX], ['S-x'], 'merge', units({ status: { 'S-y': 'superseded' } }), flow), []);
});

test("gateIds: a feature's gate checks its stories, a story's only itself", () => {
  const u = units();
  assert.deepEqual(gateIds(u, 'F-1'), ['F-1', 'S-a', 'S-d']);
  assert.deepEqual(gateIds(u, 'S-a'), ['S-a']);
  assert.deepEqual(gateIds(u, 'S-x'), ['S-x']);
});

test('gatesAt: the gates of a type that a verb checks, from flow.json', () => {
  assert.deepEqual(gatesAt(flow, 'story', 'run'), ['run']);
  assert.deepEqual(gatesAt(flow, 'story', 'implement'), ['run']);
  assert.deepEqual(gatesAt(flow, 'feature', 'merge'), ['merge']);
  assert.deepEqual(gatesAt(flow, 'feature', 'review'), []);
});

/** A fixture backlog: F-1 over S-2, standalone S-1 and S-3 (the blocker). */
function heldBacklog(edges, { s3 = 'in_progress' } = {}) {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One' },
      { id: 'S-2', component: 'C01', title: 'Two', feature: 'F-1' },
      { id: 'S-3', component: 'C01', title: 'Three', status: s3 },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: 'running', stories: ['S-2'] }],
  });
  if (edges) writeBlockersLocked(dir, edges);
  return { backlogRoot: dir };
}

test("heldBy: an edge on a feature's story holds the feature at the verb's gate, named on the story", () => {
  const config = heldBacklog([edge('S-3', 'merge', 'S-2')]);
  const held = heldBy(config, 'F-1', 'merge');
  assert.equal(held.length, 1);
  assert.equal(held[0].line, 'S-2 is held at merge by S-3 (in_progress, needs done)');
  assert.deepEqual(heldBy(config, 'F-1', 'run'), []);
  assert.deepEqual(heldBy(config, 'S-1', 'merge'), []);
});

test('heldAt and the gate_free guard: the holds at one gate, a feature through its stories (F-69 D1)', () => {
  const config = heldBacklog([edge('S-3', 'merge', 'S-2')]);
  assert.deepEqual(
    heldAt(config, 'F-1', 'merge').map((h) => h.line),
    ['S-2 is held at merge by S-3 (in_progress, needs done)'],
  );
  assert.deepEqual(heldAt(config, 'F-1', 'run'), []);
  const free = GUARDS.get('gate_free');
  assert.equal(free({ config, id: 'F-1' }, 'merge'), false);
  assert.equal(free({ config, id: 'F-1' }, 'run'), true);
  assert.equal(free({ config, id: 'S-1' }, 'merge'), true);
});

test('heldBy: a wildcard is named on the unit asked about; a superseded blocker holds nothing', () => {
  const edges = [edge('S-3', 'run', '*')];
  assert.deepEqual(
    heldBy(heldBacklog(edges), 'S-1', 'implement').map((h) => h.line),
    ['S-1 is held at run by S-3 (in_progress, needs done)'],
  );
  assert.deepEqual(heldBy(heldBacklog(edges, { s3: 'superseded' }), 'S-1', 'run'), []);
});

test('heldBy: no blockers.json holds nothing and needs no flow.json; with edges a missing flow.json throws', () => {
  const config = heldBacklog(null);
  rmSync(join(config.backlogRoot, 'flow.json'));
  assert.deepEqual(heldBy(config, 'S-1', 'run'), []);
  writeBlockersLocked(config.backlogRoot, [edge('S-3', 'run', 'S-1')]);
  assert.throws(() => heldBy(config, 'S-1', 'run'), /flow\.json: missing/);
});

test('heldLines: every unmet edge on the unit and its stories at any gate', () => {
  const config = heldBacklog([
    edge('S-3', 'merge', 'S-2'),
    edge('S-3', 'run', 'F-1', 'done', { unit: 'S-1', status: 'done' }),
    edge('S-1', 'run', 'F-1'),
  ]);
  // In the file's order: by unit, so F-1's own edge first.
  assert.deepEqual(heldLines(config, 'F-1'), [
    'F-1 is held at run by S-1 (draft, needs done)',
    'S-2 is held at merge by S-3 (in_progress, needs done)',
  ]);
  assert.deepEqual(heldLines(config, 'S-1'), []);
});

test("heldBy, heldLines: a feature honours each story's gates with the story type's verbs, on the story or on *", () => {
  const template = () => JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
  const VERBS = ['run', 'implement', 'merge'];
  const cases = [
    // The template: story and feature define run and merge alike.
    { name: 'matching definitions, run', gates: null, gate: 'run', held: ['run', 'implement'] },
    { name: 'matching definitions, merge', gates: null, gate: 'merge', held: ['merge'] },
    // A shared gate the story maps differently: the story's mapping wins.
    {
      name: 'differing mapping',
      gates: { run: { verbs: ['merge'] }, merge: { verbs: ['merge'] } },
      gate: 'run',
      held: ['merge'],
      // On *, the feature's own run gate holds it too.
      heldStar: VERBS,
    },
    // A gate only stories have.
    ...VERBS.map((v) => ({
      name: `story-only gate at ${v}`,
      gates: { child: { verbs: [v] } },
      gate: 'child',
      held: [v],
    })),
  ];
  for (const c of cases) {
    for (const unit of ['S-2', '*']) {
      const raw = template();
      if (c.gates) raw.types.story.gates = c.gates;
      const { dir } = mkTempBacklog({
        flow: raw,
        components: [{ id: 'C01', title: 'Work' }],
        stories: [
          { id: 'S-2', component: 'C01', title: 'Two', feature: 'F-1' },
          { id: 'S-3', component: 'C01', title: 'Three', status: 'in_progress' },
        ],
        features: [{ id: 'F-1', title: 'Feat', status: 'running', stories: ['S-2'] }],
      });
      writeBlockersLocked(dir, [edge('S-3', c.gate, unit)]);
      const config = { backlogRoot: dir };
      const at = `${c.name}, unit ${unit}`;
      assert.deepEqual(
        VERBS.filter((v) => heldBy(config, 'F-1', v).length > 0),
        unit === '*' && c.heldStar ? c.heldStar : c.held,
        `${at}: heldBy`,
      );
      for (const v of VERBS) assert.ok(heldBy(config, 'F-1', v).length <= 1, `${at}: one hold per edge at ${v}`);
      assert.equal(heldLines(config, 'F-1').length, 1, `${at}: heldLines`);
    }
  }
});

test('blockers.json that is there but unreadable is a BlockersError and a blockers-json finding, never an empty graph', () => {
  const cases = [
    { kind: 'missing', make: () => {}, codes: [] },
    { kind: 'valid', make: (dir) => writeBlockersLocked(dir, []), codes: [] },
    { kind: 'malformed', make: (_, path) => writeFileSync(path, '{bad'), codes: ['blockers-json'] },
    { kind: 'directory', make: (_, path) => mkdirSync(path), codes: ['blockers-json'] },
    { kind: 'dangling symlink', make: (dir, path) => symlinkSync(join(dir, 'absent'), path), codes: ['blockers-json'] },
    // root reads a mode-000 file anyway, so there it is a readable empty graph.
    ...(process.getuid?.() === 0
      ? []
      : [
          {
            kind: 'no permission',
            make: (dir, path) => (writeBlockersLocked(dir, []), chmodSync(path, 0)),
            codes: ['blockers-json'],
          },
        ]),
  ];
  for (const c of cases) {
    const config = heldBacklog(null);
    const dir = config.backlogRoot;
    c.make(dir, join(dir, BLOCKERS_FILE));
    const findings = findBlockersFindings({ backlogRoot: dir }, unitIndex([], []), flow);
    assert.deepEqual(
      findings.map((f) => f.code),
      c.codes,
      `${c.kind}: findings`,
    );
    if (c.codes.length === 0) {
      assert.deepEqual(readBlockers(dir).edges, [], `${c.kind}: an empty graph`);
      continue;
    }
    for (const read of [() => readBlockers(dir), () => heldBy(config, 'S-1', 'run'), () => heldLines(config, 'S-1')]) {
      assert.throws(read, BlockersError, `${c.kind}: ${read}`);
    }
  }
});

test('mergeEdges: a three-way merge by edge identity; one edge both sides made differ is a conflict', () => {
  const a = edge('S-1', 'merge', 'F-1');
  const b = edge('S-1', 'merge', 'F-2');
  const c = edge('S-1', 'merge', 'F-3');
  const aLater = edge('S-1', 'merge', 'F-1', 'in_progress');
  const aOther = edge('S-1', 'merge', 'F-1', 'refined');
  const units = (edges) => (edges === null ? null : edges.map((e) => `${e.unit}:${e.until}`).sort());
  const cases = [
    { name: 'adds on both sides', base: [a], ours: [a, b], theirs: [a, c], want: ['F-1:done', 'F-2:done', 'F-3:done'] },
    { name: 'adds on an empty graph', base: [], ours: [b], theirs: [c], want: ['F-2:done', 'F-3:done'] },
    { name: 'one edge added on both alike', base: [], ours: [b], theirs: [b], want: ['F-2:done'] },
    { name: 'remove beside an add', base: [a, b], ours: [b], theirs: [a, b, c], want: ['F-2:done', 'F-3:done'] },
    { name: 'both remove one edge', base: [a, b], ours: [b], theirs: [b], want: ['F-2:done'] },
    { name: 'two removes', base: [a, b, c], ours: [b, c], theirs: [a, b], want: ['F-2:done'] },
    { name: 'a change on one side', base: [a], ours: [a], theirs: [aLater], want: ['F-1:in_progress'] },
    { name: 'a change on ours', base: [a], ours: [aLater], theirs: [a], want: ['F-1:in_progress'] },
    { name: 'one edge added on both differently', base: [], ours: [a], theirs: [aLater], want: null },
    { name: 'one edge changed on both differently', base: [a], ours: [aLater], theirs: [aOther], want: null },
    { name: 'changed on one side, removed on the other', base: [a], ours: [aLater], theirs: [], want: null },
  ];
  for (const c of cases) {
    assert.deepEqual(units(mergeEdges(c.base, c.ours, c.theirs)), c.want, c.name);
    assert.deepEqual(units(mergeEdges(c.base, c.theirs, c.ours)), c.want, `${c.name}, sides swapped`);
  }
});

test('mergeEdges_rejects_ambiguous_duplicate_keys_on_every_side: a side that lists one identity twice is a conflict', () => {
  const a = edge('S-1', 'merge', 'F-1');
  const b = edge('S-1', 'merge', 'F-2');
  const dups = {
    'differing until': [a, edge('S-1', 'merge', 'F-1', 'refined')],
    'differing active_when': [a, edge('S-1', 'merge', 'F-1', 'done', { unit: 'F-2', status: 'done' })],
    identical: [a, a],
  };
  for (const [name, dup] of Object.entries(dups)) {
    assert.equal(mergeEdges(dup, [a], [a, b]), null, `${name} in base`);
    assert.equal(mergeEdges([a], dup, [a, b]), null, `${name} in ours`);
    assert.equal(mergeEdges([a], [a, b], dup), null, `${name} in theirs`);
  }
});

test('merge_driver_rejects_blank_existing_sides_without_dropping_holds: only a zero-byte base is an empty graph', () => {
  const driver = fileURLToPath(new URL('../../src/blockers-merge.js', import.meta.url));
  const a = formatBlockers([edge('S-1', 'merge', 'F-1')]);
  const ab = formatBlockers([edge('S-1', 'merge', 'F-1'), edge('S-1', 'merge', 'F-2')]);
  const dir = mkTempDir('bl-blockers-driver-');
  try {
    const cases = [
      { name: 'zero-byte ours', base: a, ours: '', theirs: ab, exit: 1 },
      { name: 'whitespace ours', base: a, ours: '  \n', theirs: ab, exit: 1 },
      { name: 'zero-byte theirs', base: a, ours: ab, theirs: '', exit: 1 },
      { name: 'whitespace theirs', base: a, ours: ab, theirs: '  \n', exit: 1 },
      {
        name: 'whitespace base',
        base: '  \n',
        ours: a,
        theirs: formatBlockers([edge('S-1', 'merge', 'F-2')]),
        exit: 1,
      },
      {
        name: 'duplicate in ours',
        base: a,
        ours: formatBlockers([edge('S-1', 'merge', 'F-1'), edge('S-1', 'merge', 'F-1', 'refined')]),
        theirs: ab,
        exit: 1,
      },
      {
        name: 'zero-byte base, adds on both',
        base: '',
        ours: a,
        theirs: formatBlockers([edge('S-1', 'merge', 'F-2')]),
        exit: 0,
        want: ab,
      },
    ];
    for (const c of cases) {
      const paths = ['base', 'ours', 'theirs'].map((p) => join(dir, p));
      [c.base, c.ours, c.theirs].forEach((text, i) => writeFileSync(paths[i], text));
      const r = spawnSyncFiles(process.execPath, [driver, ...paths], { encoding: 'utf8' });
      assert.equal(r.status, c.exit, `${c.name}: ${r.stderr}`);
      const out = readFileSync(paths[1], 'utf8');
      if (c.want) {
        assert.equal(out, c.want, c.name);
        continue;
      }
      // A conflict keeps every side's holds in the markers for the operator.
      assert.match(out, /<<<<<<< ours/, c.name);
      for (const side of [c.ours, c.theirs]) {
        for (const line of side.split('\n').filter((l) => l.includes('"blocker"'))) {
          assert.ok(out.includes(line.replace(/,$/, '')), `${c.name}: keeps ${line.trim()}`);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Merge edges (F-111 D1)
// ---------------------------------------------------------------------------

/** F-1 over S-a (bl) and S-d (ci-cd), F-2 over S-b (bl) and S-c (app), standalone S-x. */
function repoUnits() {
  return unitIndex(
    [
      { id: 'S-a', status: 'backlog', feature: 'F-1', unitRepo: 'bl' },
      { id: 'S-d', status: 'backlog', feature: 'F-1', unitRepo: 'ci-cd' },
      { id: 'S-b', status: 'backlog', feature: 'F-2', unitRepo: 'bl' },
      { id: 'S-c', status: 'backlog', feature: 'F-2', unitRepo: 'app' },
      { id: 'S-x', status: 'backlog', unitRepo: 'bl' },
    ],
    [
      { id: 'F-1', status: 'approved', stories: ['S-a', 'S-d'] },
      { id: 'F-2', status: 'approved', stories: ['S-b', 'S-c'] },
    ],
  );
}

const mergeEdge = (blocker, unit) => edge(blocker, 'merge', unit, 'merged');

test('parseBlockers reads bl-blockers/v1 and v2; formatBlockers writes v2; a sorted v1 file is no blockers-order', () => {
  const edges = [edge('S-y', 'run', 'S-x')];
  const v1 = formatBlockers(edges, 'bl-blockers/v1');
  assert.match(v1, /"schema": "bl-blockers\/v1"/);
  assert.deepEqual(parseBlockers(v1), edges);
  assert.deepEqual(parseBlockers(formatBlockers(edges)), edges);
  assert.match(formatBlockers(parseBlockers(v1)), /"schema": "bl-blockers\/v2"/);
  const dir = mkTempDir('bl-blockers-');
  writeFileSync(join(dir, BLOCKERS_FILE), v1);
  assert.equal(readBlockers(dir).schema, 'bl-blockers/v1');
  assert.deepEqual(findBlockersFindings({ backlogRoot: dir }, units(), flow), []);
});

test('the merge driver merges a v1 side with a v2 side and writes v2', () => {
  const driver = fileURLToPath(new URL('../../src/blockers-merge.js', import.meta.url));
  const a = edge('S-1', 'merge', 'F-1');
  const m = mergeEdge('F-1:ci-cd', 'F-1:bl');
  const dir = mkTempDir('bl-blockers-driver-');
  const paths = ['base', 'ours', 'theirs'].map((p) => join(dir, p));
  [formatBlockers([], 'bl-blockers/v1'), formatBlockers([a], 'bl-blockers/v1'), formatBlockers([m])].forEach(
    (text, i) => writeFileSync(paths[i], text),
  );
  const r = spawnSyncFiles(process.execPath, [driver, ...paths], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(paths[1], 'utf8'), formatBlockers([a, m]));
});

test('repoEnd: <feature>:<repo> splits at the first colon; a unit id or * is no repo end', () => {
  assert.deepEqual(repoEnd('F-96:bl'), { unit: 'F-96', repo: 'bl' });
  assert.deepEqual(repoEnd('F-13:app.roost.cc'), { unit: 'F-13', repo: 'app.roost.cc' });
  for (const id of ['F-96', 'S-1', '*', ':bl', 'F-96:']) assert.equal(repoEnd(id), null, id);
});

test('edgeProblems: a merge edge joins two repos of one feature, at merge, until merged', () => {
  const u = repoUnits();
  const codes = (e) => edgeProblems(e, u, flow).map((p) => `${p.code}: ${p.message}`);
  assert.deepEqual(codes(mergeEdge('F-1:ci-cd', 'F-1:bl')), []);
  assert.deepEqual(codes(mergeEdge('F-2:app', 'F-1:bl')), [
    'blockers-unit: a merge edge joins two repos of one feature, not of F-2 and F-1',
  ]);
  assert.deepEqual(codes(mergeEdge('F-1:app', 'F-1:bl')), [
    'blockers-unit: blocker F-1:app: no story of F-1 names repo app',
  ]);
  assert.deepEqual(codes(mergeEdge('F-1:ci-cd', 'S-x:bl')), [
    'blockers-unit: unit S-x:bl: S-x is not a feature or batch in the backlog',
  ]);
  assert.deepEqual(codes(mergeEdge('F-1:ci-cd', 'F-9:bl')), [
    'blockers-unit: unit F-9:bl: F-9 is not a feature or batch in the backlog',
  ]);
  assert.deepEqual(codes(mergeEdge('F-1:ci-cd', '*')), [`blockers-unit: a merge edge's unit is never "*"`]);
  assert.deepEqual(codes(mergeEdge('F-1:ci-cd', 'F-1')), [
    "blockers-unit: a merge edge's unit is <feature>:<repo>, not F-1",
  ]);
  assert.deepEqual(codes(edge('F-1:ci-cd', 'merge', 'F-1:bl', 'done')), [
    `blockers-status: a merge edge's until is "merged", not "done"`,
  ]);
  assert.deepEqual(codes(edge('F-1:ci-cd', 'run', 'F-1:bl', 'merged')), [
    `blockers-gate: a merge edge's gate is "merge", not "run"`,
  ]);
});

test('a merge edge is inside its feature: no holdGraph arc, never a hold', () => {
  const u = repoUnits();
  const e = mergeEdge('F-1:ci-cd', 'F-1:bl');
  assert.equal(inFeature(e, u), true);
  assert.equal(inFeature(mergeEdge('F-2:app', 'F-1:bl'), u), false);
  assert.equal(inFeature(edge('S-x', 'merge', 'F-1'), u), false);
  assert.deepEqual([...holdGraph([e], u, flow).keys()], []);

  const { dir } = mkTempBacklog({
    components: [
      { id: 'C01', title: 'Bl', repo: 'bl' },
      { id: 'C02', title: 'Ci', repo: 'ci-cd' },
    ],
    stories: [
      { id: 'S-2', component: 'C01', title: 'Two', feature: 'F-1' },
      { id: 'S-4', component: 'C02', title: 'Four', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: 'running', stories: ['S-2', 'S-4'] }],
  });
  writeBlockersLocked(dir, [e]);
  const config = { backlogRoot: dir };
  for (const verb of ['run', 'implement', 'merge']) assert.deepEqual(heldBy(config, 'F-1', verb), [], verb);
  assert.deepEqual(heldAt(config, 'F-1', 'merge'), []);
  assert.deepEqual(heldLines(config, 'F-1'), []);
});

test("wouldCycle and blockers-cycle: a cycle among one feature's merge edges", () => {
  const u = repoUnits();
  const forward = mergeEdge('F-1:ci-cd', 'F-1:bl');
  assert.equal(wouldCycle(forward, [], u, flow), null);
  assert.equal(
    describeCycle(wouldCycle(mergeEdge('F-1:bl', 'F-1:ci-cd'), [forward], u, flow)),
    'F-1:ci-cd → F-1:bl (merge edge F-1:bl → F-1:ci-cd) → F-1:ci-cd (merge edge F-1:ci-cd → F-1:bl)',
  );
  assert.equal(
    describeCycle(wouldCycle(mergeEdge('F-1:bl', 'F-1:bl'), [], u, flow)),
    'F-1:bl → F-1:bl (merge edge F-1:bl → F-1:bl)',
  );

  const dir = mkTempDir('bl-blockers-');
  writeBlockersLocked(dir, [forward]);
  assert.deepEqual(findBlockersFindings({ backlogRoot: dir }, u, flow), []);
  writeBlockersLocked(dir, [forward, mergeEdge('F-1:bl', 'F-1:ci-cd')]);
  assert.deepEqual(
    findBlockersFindings({ backlogRoot: dir }, u, flow).map((f) => [f.code, f.message]),
    [
      [
        'blockers-cycle',
        'merge order cycle: F-1:bl → F-1:ci-cd (merge edge F-1:ci-cd → F-1:bl) → F-1:bl (merge edge F-1:bl → F-1:ci-cd)',
      ],
    ],
  );
});

// ---------------------------------------------------------------------------
// Order edges and the depends_on: read adapter (F-111 D1, D4, D5)
// ---------------------------------------------------------------------------

const orderEdge = (blocker, unit) => edge(blocker, 'order', unit, 'implemented');

test('edgeProblems: an order edge joins two stories of one feature, until implemented', () => {
  const u = units();
  const codes = (e) => edgeProblems(e, u, flow).map((p) => `${p.code}: ${p.message}`);
  assert.deepEqual(codes(orderEdge('S-a', 'S-d')), []);
  assert.deepEqual(codes(orderEdge('S-a', 'S-b')), [
    'blockers-unit: an order edge joins two stories of one feature or batch, not of F-1 and F-2',
  ]);
  assert.deepEqual(codes(orderEdge('S-x', 'S-a')), ['blockers-unit: blocker S-x is in no feature or batch']);
  assert.deepEqual(codes(orderEdge('F-1', 'S-a')), ['blockers-unit: blocker F-1 is not a story in the backlog']);
  assert.deepEqual(codes(orderEdge('S-a', 'S-nope')), ['blockers-unit: unit S-nope is not a story in the backlog']);
  assert.deepEqual(codes(orderEdge('S-a', '*')), [`blockers-unit: an order edge's unit is never "*"`]);
  assert.deepEqual(codes(edge('S-a', 'order', 'S-d', 'done')), [
    `blockers-status: an order edge's until is "implemented", not "done"`,
  ]);
});

test('edgeProblems: a merge edge and an order edge take no active_when, whatever it names', () => {
  // [kind, its units, the edge]
  for (const [kind, u, e] of [
    ['a merge', repoUnits(), mergeEdge('F-1:ci-cd', 'F-1:bl')],
    ['an order', units(), orderEdge('S-a', 'S-d')],
  ]) {
    // An active_when naming no unit and no status, and one naming a real unit and status.
    for (const when of [
      { unit: 'F-99', status: 'nope' },
      { unit: 'F-1', status: 'done' },
    ]) {
      assert.deepEqual(
        edgeProblems({ ...e, active_when: when }, u, flow).map((p) => `${p.code}: ${p.message}`),
        [`blockers-gate: ${kind} edge holds nothing, so it takes no active_when`],
        `${kind} ${when.unit}`,
      );
    }
  }
});

test('an order edge is inside its feature: no holdGraph arc, never a hold; wouldCycle refuses the one that closes a cycle', () => {
  const u = units();
  const forward = orderEdge('S-a', 'S-d');
  assert.equal(inFeature(forward, u), true);
  assert.equal(inFeature(orderEdge('S-a', 'S-b'), u), false);
  assert.equal(inFeature(edge('S-a', 'run', 'S-d'), u), false);
  assert.deepEqual([...holdGraph([forward], u, flow).keys()], []);
  assert.equal(wouldCycle(forward, [], u, flow), null);
  assert.equal(
    describeCycle(wouldCycle(orderEdge('S-d', 'S-a'), [forward], u, flow)),
    'S-a → S-d (order edge S-d → S-a) → S-a (order edge S-a → S-d)',
  );
  // A depends_on: inside the feature is an order edge too.
  assert.ok(wouldCycle(orderEdge('S-d', 'S-a'), deps({ 'S-d': 'S-a' }), u, flow));
});

/** F-1 (S-a), the story batch B-1 (S-p, S-q), and a loose S-x held at run by it (F-125 D1). */
function batchUnits({ status = {} } = {}) {
  return unitIndex(
    [
      { id: 'S-a', status: 'refined', feature: 'F-1' },
      { id: 'S-p', status: 'refined', batch: 'B-1' },
      { id: 'S-q', status: 'refined', batch: 'b1' },
      { id: 'S-x', status: status['S-x'] ?? 'refined' },
      { id: 'S-n', status: 'refined', batch: 'B-9' },
    ],
    [{ id: 'F-1', status: 'approved', stories: ['S-a'] }],
    [],
    [{ id: 'B-1', status: status['B-1'] ?? 'approved', stories: ['S-p', 'S-q'] }],
  );
}

test('storyUnitOf: a story of a feature is its feature, of a batch its batch; a loose story, a missing batch and a non-story none', () => {
  const u = batchUnits();
  assert.deepEqual(
    ['S-a', 'S-p', 'S-q', 'S-x', 'S-n', 'F-1', 'B-1', 'S-404'].map((id) => storyUnitOf(u, id)),
    ['F-1', 'B-1', 'B-1', '', '', '', '', ''],
  );
});

test('an order edge inside one batch is valid and inside it; one across a batch and a feature is refused (F-125 D1)', () => {
  const u = batchUnits();
  const codes = (e) => edgeProblems(e, u, flow).map((p) => `${p.code}: ${p.message}`);
  const inside = orderEdge('S-p', 'S-q');
  assert.deepEqual(codes(inside), []);
  assert.equal(inFeature(inside, u), true);
  assert.deepEqual([...holdGraph([inside], u, flow).keys()], []);
  assert.deepEqual(codes(orderEdge('S-a', 'S-p')), [
    'blockers-unit: an order edge joins two stories of one feature or batch, not of F-1 and B-1',
  ]);
  assert.equal(inFeature(orderEdge('S-a', 'S-p'), u), false);
  // `bl new` and `bl block add` write an order edge between two stories of one batch.
  const unitOf = (id) => storyUnitOf(u, id);
  assert.deepEqual(dependencyEdge('S-p', 'S-q', unitOf), inside);
  assert.deepEqual(dependencyEdge('S-a', 'S-q', unitOf), edge('S-a', 'run', 'S-q'));
  // A depends_on: inside a batch is an order edge too.
  assert.deepEqual(
    dependsOnEdges([
      { id: 'S-q', unit: 'B-1', depends_on: ['S-p'] },
      { id: 'S-p', unit: 'B-1' },
    ]),
    [inside],
  );
});

test("a batch's gate checks its stories' edges: a run edge on its story holds it until met (F-125 D1)", () => {
  const u = batchUnits();
  assert.deepEqual(gateIds(u, 'B-1'), ['B-1', 'S-p', 'S-q']);
  // S-1 and S-2 in B-1; the loose S-3 holds S-2 at run.
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work', repo: 'bl' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'P', status: 'refined', batch: 'B-1' },
      { id: 'S-2', component: 'C01', title: 'Q', status: 'refined', batch: 'B-1' },
      { id: 'S-3', component: 'C01', title: 'X', status: 'refined' },
    ],
    batches: [{ id: 'B-1', title: 'Fixes' }],
  });
  writeBlockersLocked(dir, [edge('S-3', 'run', 'S-2')]);
  const config = { backlogRoot: dir };
  assert.deepEqual(gateIds(readUnits(config), 'B-1'), ['B-1', 'S-1', 'S-2']);
  assert.deepEqual(
    heldBy(config, 'B-1', 'run').map((h) => h.line),
    ['S-2 is held at run by S-3 (refined, needs done)'],
  );
  assert.deepEqual(heldBy(config, 'B-1', 'merge'), []);
  // A merge edge's end may be a batch's repo: `bl` is one, `nope` is not.
  assert.deepEqual(
    edgeProblems(mergeEdge('B-1:nope', 'B-1:bl'), readUnits(config), flow).map((p) => `${p.code}: ${p.message}`),
    ['blockers-unit: blocker B-1:nope: no story of B-1 names repo nope'],
  );
});

test('dependsOnEdges: an order edge between two stories of one feature, else a run edge; each entry once', () => {
  assert.deepEqual(
    dependsOnEdges([
      { id: 'S-1', unit: 'F-1', depends_on: ['S-2', 'S-3', 'S-2', 'S-9'] },
      { id: 'S-2', unit: 'F-1', depends_on: '' },
      { id: 'S-3', unit: '', depends_on: ['S-1', 'S-4'] },
      { id: 'S-4', unit: '', depends_on: [] },
    ]),
    [
      orderEdge('S-2', 'S-1'),
      edge('S-3', 'run', 'S-1'),
      edge('S-9', 'run', 'S-1'),
      edge('S-1', 'run', 'S-3'),
      edge('S-4', 'run', 'S-3'),
    ],
  );
});

test("readEdges: the file's edges and the depends_on: keys'; an edge in the file wins; heldBy and heldLines read both", () => {
  const { dir } = mkTempBacklog({
    components: [{ id: 'C01', title: 'Work' }],
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', depends_on: ['S-3'] },
      { id: 'S-2', component: 'C01', title: 'Two', feature: 'F-1', depends_on: ['S-3', 'S-4'] },
      { id: 'S-3', component: 'C01', title: 'Three', status: 'in_progress' },
      { id: 'S-4', component: 'C01', title: 'Four', feature: 'F-1' },
    ],
    features: [{ id: 'F-1', title: 'Feat', status: 'approved', stories: ['S-2', 'S-4'] }],
  });
  const config = { backlogRoot: dir };
  // S-1's key and this edge share an identity: the file's until wins.
  writeBlockersLocked(dir, [edge('S-3', 'run', 'S-1', 'in_progress')]);
  assert.deepEqual(readEdges(config), [
    edge('S-3', 'run', 'S-1', 'in_progress'),
    edge('S-3', 'run', 'S-2'),
    orderEdge('S-4', 'S-2'),
  ]);
  assert.deepEqual(heldBy(config, 'S-1', 'run'), [], 'S-3 is in_progress: the file edge is met');
  assert.deepEqual(
    heldBy(config, 'F-1', 'run').map((h) => h.line),
    ['S-2 is held at run by S-3 (in_progress, needs done)'],
  );
  assert.deepEqual(heldLines(config, 'F-1'), ['S-2 is held at run by S-3 (in_progress, needs done)']);
  // With no blockers.json the keys alone hold.
  rmSync(join(dir, BLOCKERS_FILE));
  assert.deepEqual(
    heldBy(config, 'S-1', 'run').map((h) => h.line),
    ['S-1 is held at run by S-3 (in_progress, needs done)'],
  );
});
