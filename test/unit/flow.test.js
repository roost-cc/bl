import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { FLOW_FILE, FlowError, findFlowFindings, loadFlow } from '../../src/flow.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'flow');
const fixture = () => JSON.parse(readFileSync(join(FIXTURE_DIR, FLOW_FILE), 'utf8'));

/** A backlog dir holding `content` (an object, or raw text) as its flow.json. */
function backlogWith(content) {
  const dir = mkTempDir('bl-flow-');
  writeFileSync(join(dir, FLOW_FILE), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return dir;
}

test("statusesOf names every story and feature status in the file's order", () => {
  const flow = loadFlow(FIXTURE_DIR);
  assert.deepEqual(flow.statusesOf('story'), ['backlog', 'refined', 'in_progress', 'done', 'superseded']);
  assert.deepEqual(flow.statusesOf('feature'), [
    'draft',
    'refined',
    'approved',
    'running',
    'escalated',
    'done',
    'superseded',
  ]);
});

test('meets: a status meets itself and what it implies, on both types (F-66 A4)', () => {
  const flow = loadFlow(FIXTURE_DIR);
  assert.equal(flow.meets('story', 'done', 'done'), true);
  assert.equal(flow.meets('story', 'superseded', 'done'), true);
  assert.equal(flow.meets('story', 'in_progress', 'refined'), true);
  assert.equal(flow.meets('story', 'in_progress', 'done'), false);
  assert.equal(flow.meets('story', 'done', 'superseded'), false);

  assert.equal(flow.meets('feature', 'superseded', 'done'), true);
  assert.equal(flow.meets('feature', 'escalated', 'done'), false);
  assert.equal(flow.meets('feature', 'escalated', 'running'), true);
  assert.equal(flow.meets('feature', 'running', 'escalated'), false);
  assert.equal(flow.meets('feature', 'done', 'approved'), true);

  // An unknown status meets nothing, not even itself.
  assert.equal(flow.meets('story', 'wrong', 'wrong'), false);
});

test('gatesOf names each gate with the verbs that check it', () => {
  const flow = loadFlow(FIXTURE_DIR);
  const gates = { run: ['run', 'implement'], merge: ['merge'] };
  assert.deepEqual(flow.gatesOf('story'), gates);
  assert.deepEqual(flow.gatesOf('feature'), gates);
});

test('a type the flow lacks throws naming the file', () => {
  const flow = loadFlow(FIXTURE_DIR);
  assert.throws(
    () => flow.statusesOf('epic'),
    (err) => err instanceof FlowError && /flow\.json: no "epic" type/.test(err.message),
  );
});

test('loadFlow throws naming the file when it is missing, unparsable, of a wrong schema or lacks a type', () => {
  const missing = mkTempDir('bl-flow-');
  assert.throws(
    () => loadFlow(missing),
    (err) =>
      err instanceof FlowError && err.message.startsWith(join(missing, FLOW_FILE)) && /missing/.test(err.message),
  );

  const cases = [
    ['{ not json', /not valid JSON/],
    [{ ...fixture(), schema: 'bl-flow/v0' }, /"schema" is "bl-flow\/v0", not "bl-flow\/v1"/],
    [{ schema: 'bl-flow/v1', types: { story: fixture().types.story } }, /no "feature" type/],
    [{ schema: 'bl-flow/v1', types: { feature: fixture().types.feature } }, /no "story" type/],
    [
      { schema: 'bl-flow/v1', types: { story: fixture().types.story, feature: fixture().types.feature } },
      /no "task" type/,
    ],
    [
      { ...fixture(), types: { ...fixture().types, story: { statuses: { done: {} }, gates: {} } } },
      /status "done" has no "implies" list/,
    ],
    [
      { ...fixture(), types: { ...fixture().types, story: { statuses: { done: { implies: [] } } } } },
      /type "story" has no "gates" object/,
    ],
  ];
  for (const [content, reason] of cases) {
    const dir = backlogWith(content);
    assert.throws(
      () => loadFlow(dir),
      (err) => err instanceof FlowError && err.message.startsWith(join(dir, FLOW_FILE)) && reason.test(err.message),
      String(reason),
    );
  }
});

test('loadFlow rereads a file that changed', () => {
  const dir = backlogWith(fixture());
  assert.equal(loadFlow(dir).statusesOf('story').includes('blocked'), false);
  const changed = fixture();
  changed.types.story.statuses.blocked = { implies: ['backlog'] };
  writeFileSync(join(dir, FLOW_FILE), JSON.stringify(changed, null, 2));
  assert.equal(loadFlow(dir).statusesOf('story').includes('blocked'), true);
  rmSync(join(dir, FLOW_FILE));
  assert.throws(() => loadFlow(dir), /missing/);
});

test('flow-json: the shipped template and the fixture have no findings', () => {
  assert.deepEqual(findFlowFindings(loadFlow(dirname(FLOW_TEMPLATE))), []);
  assert.deepEqual(findFlowFindings(loadFlow(FIXTURE_DIR)), []);
});

test('flow-json: an implies that is not closed, names an unknown status, or a gate verb bl does not check', () => {
  const flow = fixture();
  flow.types.story.statuses.done.implies = ['in_progress', 'backlog'];
  flow.types.feature.statuses.refined.implies = ['draft', 'parked'];
  flow.types.feature.gates.review = { verbs: ['review', 'merge'] };
  const findings = findFlowFindings(loadFlow(backlogWith(flow)));
  assert.deepEqual(
    findings.map((f) => [f.severity, f.code, f.location, f.message]),
    [
      [
        'error',
        'flow-json',
        'flow.json',
        'story status "done" implies "in_progress", which implies "refined"; list "refined" too',
      ],
      ['error', 'flow-json', 'flow.json', 'feature status "refined" implies "parked", which is not a feature status'],
      [
        'error',
        'flow-json',
        'flow.json',
        'feature gate "review" names verb "review"; bl checks gates only at run, implement, merge',
      ],
    ],
  );
});
