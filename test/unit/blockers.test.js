import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadFlow } from '../../src/flow.js';
import {
  BLOCKERS_FILE,
  BlockersError,
  describeCycle,
  findBlockersFindings,
  findHoldCycles,
  formatBlockers,
  gateIds,
  gatesAt,
  heldBy,
  heldLines,
  holdGraph,
  isActive,
  isMet,
  mergeEdges,
  parseBlockers,
  readBlockers,
  unitIndex,
  unmetEdges,
  wouldCycle,
  writeBlockers,
} from '../../src/blockers.js';
import { FLOW_TEMPLATE, mkTempBacklog, mkTempDir } from '../helpers/tempdir.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';

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
function units({ deps = {}, status = {} } = {}) {
  const on = (id) => (deps[id] ? [deps[id]] : []);
  return unitIndex(
    [
      { id: 'S-a', status: 'backlog', feature: 'F-1', depends_on: on('S-a') },
      { id: 'S-d', status: 'backlog', feature: 'F-1', depends_on: on('S-d') },
      { id: 'S-b', status: 'backlog', feature: 'F-2', depends_on: on('S-b') },
      { id: 'S-c', status: 'backlog', feature: 'F-2', depends_on: on('S-c') },
      { id: 'S-x', status: status['S-x'] ?? 'backlog', depends_on: on('S-x') },
      { id: 'S-y', status: status['S-y'] ?? 'backlog', depends_on: on('S-y') },
      { id: 'S-z', status: 'done', depends_on: [] },
    ],
    [
      { id: 'F-1', status: status['F-1'] ?? 'approved', stories: ['S-a', 'S-d'] },
      { id: 'F-2', status: status['F-2'] ?? 'approved', stories: ['S-b', 'S-c'] },
    ],
  );
}

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
  "schema": "bl-blockers/v1",
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
  assert.equal(formatBlockers([]), `{\n  "schema": "bl-blockers/v1",\n  "edges": []\n}\n`);
});

test('readBlockers: a missing file is an empty graph; writeBlockers writes it sorted and a read-write is byte-identical', () => {
  const dir = mkTempDir('bl-blockers-');
  assert.deepEqual(readBlockers(dir), { edges: [], text: null, path: join(dir, BLOCKERS_FILE) });
  writeBlockers(dir, [edge('S-y', 'run', 'S-x'), edge('S-b', 'run', 'F-1')]);
  const first = readFileSync(join(dir, BLOCKERS_FILE), 'utf8');
  const read = readBlockers(dir);
  assert.deepEqual(
    read.edges.map((e) => e.unit),
    ['F-1', 'S-x'],
  );
  writeBlockers(dir, read.edges);
  assert.equal(readFileSync(join(dir, BLOCKERS_FILE), 'utf8'), first);
  // Staged under .bl/tmp, nothing left beside the file.
  assert.ok(!existsSync(join(dir, `${BLOCKERS_FILE}.tmp`)));
});

test('parseBlockers refuses JSON it cannot read, naming the file', () => {
  for (const [text, reason] of [
    ['{ nope', /not valid JSON/],
    [`{"schema":"bl-blockers/v2","edges":[]}`, /"schema" is "bl-blockers\/v2"/],
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
  const u = units({ deps: { 'S-a': 'S-b', 'S-c': 'S-d' } });
  const cycles = findHoldCycles(holdGraph([], u, flow));
  assert.equal(cycles.length, 1);
  assert.equal(describeCycle(cycles[0]), 'F-1 → F-2 (S-a depends_on S-b) → F-1 (S-c depends_on S-d)');
  // A depends_on inside one feature is plan order, not a hold.
  assert.deepEqual(findHoldCycles(holdGraph([], units({ deps: { 'S-a': 'S-d', 'S-d': 'S-a' } }), flow)), []);
  // A depends_on on a closed story holds nothing.
  assert.deepEqual(findHoldCycles(holdGraph([], units({ deps: { 'S-x': 'S-z' } }), flow)), []);
});

test('blockers-cycle: an edge and a depends_on close a cycle; a met or inactive edge does not', () => {
  const u = units({ deps: { 'S-x': 'S-a' } });
  const held = [edge('S-x', 'run', 'F-1')];
  assert.equal(
    describeCycle(findHoldCycles(holdGraph(held, u, flow))[0]),
    'F-1 → S-x (F-1 at run by S-x) → F-1 (S-x depends_on S-a)',
  );
  assert.deepEqual(findHoldCycles(holdGraph([edge('S-x', 'run', 'F-1', 'backlog')], u, flow)), []);
  const inactive = [edge('S-x', 'run', 'F-1', 'done', { unit: 'S-y', status: 'done' })];
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
  const u = units({ deps: { 'S-x': 'S-a' } });
  assert.equal(
    describeCycle(wouldCycle(edge('S-x', 'merge', 'F-1'), [], u, flow)),
    'F-1 → S-x (F-1 at merge by S-x) → F-1 (S-x depends_on S-a)',
  );
  assert.equal(wouldCycle(edge('S-x', 'run', 'S-a', 'done', { unit: 'S-y', status: 'done' }), [], u, flow), null);
  assert.ok(wouldCycle(edge('S-x', 'run', 'S-a', 'done', { unit: 'S-y', status: 'backlog' }), [], u, flow));
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
  const findings = findBlockersFindings(dir, u, flow);
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
  const broken = findBlockersFindings(dir, u, flow);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].code, 'blockers-json');
  assert.match(broken[0].message, /not valid JSON/);
});

test('findBlockersFindings: a missing file has no findings', () => {
  assert.deepEqual(findBlockersFindings(mkTempDir('bl-blockers-'), units(), flow), []);
});

test('findBlockersFindings leaves a depends_on cycle of standalone stories to cycle, and reports one across features', () => {
  const dir = mkTempDir('bl-blockers-');
  assert.deepEqual(findBlockersFindings(dir, units({ deps: { 'S-x': 'S-y', 'S-y': 'S-x' } }), flow), []);
  assert.deepEqual(
    findBlockersFindings(dir, units({ deps: { 'S-a': 'S-b', 'S-c': 'S-d' } }), flow).map((f) => f.code),
    ['blockers-cycle'],
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
  if (edges) writeBlockers(dir, edges);
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
  writeBlockers(config.backlogRoot, [edge('S-3', 'run', 'S-1')]);
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
    'F-1 is held at run by S-1 (backlog, needs done)',
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
      writeBlockers(dir, [edge('S-3', c.gate, unit)]);
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
    { kind: 'valid', make: (dir) => writeBlockers(dir, []), codes: [] },
    { kind: 'malformed', make: (_, path) => writeFileSync(path, '{bad'), codes: ['blockers-json'] },
    { kind: 'directory', make: (_, path) => mkdirSync(path), codes: ['blockers-json'] },
    { kind: 'dangling symlink', make: (dir, path) => symlinkSync(join(dir, 'absent'), path), codes: ['blockers-json'] },
    // root reads a mode-000 file anyway, so there it is a readable empty graph.
    ...(process.getuid?.() === 0
      ? []
      : [
          {
            kind: 'no permission',
            make: (dir, path) => (writeBlockers(dir, []), chmodSync(path, 0)),
            codes: ['blockers-json'],
          },
        ]),
  ];
  for (const c of cases) {
    const config = heldBacklog(null);
    const dir = config.backlogRoot;
    c.make(dir, join(dir, BLOCKERS_FILE));
    const findings = findBlockersFindings(dir, unitIndex([], []), flow);
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
