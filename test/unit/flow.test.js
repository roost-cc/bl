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

test('openStatusesOf: what does not meet done, most implies first', () => {
  const flow = loadFlow(FIXTURE_DIR);
  assert.deepEqual(flow.openStatusesOf('story'), ['in_progress', 'refined', 'backlog']);
  assert.deepEqual(flow.openStatusesOf('feature'), ['escalated', 'running', 'approved', 'refined', 'draft']);
  assert.deepEqual(flow.openStatusesOf('task'), ['open']);
});

test("openStatusesOf: order is implies, not the file's; a tie keeps the file's order", () => {
  const flow = fixture();
  flow.types.story.statuses = {
    done: { implies: ['in_progress', 'blocked', 'backlog'] },
    backlog: { implies: [] },
    in_progress: { implies: ['backlog'] },
    blocked: { implies: ['backlog'] },
    wontfix: { implies: ['done', 'in_progress', 'blocked', 'backlog'] },
  };
  const dir = backlogWith(flow);
  assert.deepEqual(loadFlow(dir).openStatusesOf('story'), ['in_progress', 'blocked', 'backlog']);
});

test('listRankOf: the shipped order, with an unknown status among the open ones', () => {
  const flow = loadFlow(FIXTURE_DIR);
  const ranks = (statuses) => statuses.map((s) => flow.listRankOf('story', s));
  const [inProgress, backlog, refined, done, superseded] = ranks([
    'in_progress',
    'backlog',
    'refined',
    'done',
    'superseded',
  ]);
  assert.ok(inProgress < backlog);
  assert.equal(backlog, refined);
  assert.ok(refined < done);
  assert.ok(done < superseded);
  for (const unknown of ['blocked', '__proto__', 'constructor', ['done'], ['superseded'], 7, true, null, undefined]) {
    assert.equal(flow.listRankOf('story', unknown), backlog, JSON.stringify(unknown));
  }
});

test('listRankOf: a custom open status that implies in_progress sorts with it; a closed one by file order', () => {
  const flow = fixture();
  const { statuses } = flow.types.story;
  statuses.in_review = { implies: ['in_progress', 'refined', 'backlog'] };
  statuses.wontfix = { implies: ['done', 'in_progress', 'refined', 'backlog'] };
  const loaded = loadFlow(backlogWith(flow));
  assert.equal(loaded.listRankOf('story', 'in_review'), loaded.listRankOf('story', 'in_progress'));
  assert.ok(loaded.listRankOf('story', 'in_review') < loaded.listRankOf('story', 'refined'));
  assert.ok(loaded.listRankOf('story', 'wontfix') > loaded.listRankOf('story', 'superseded'));
});

test('listRankOf: a type the flow lacks throws', () => {
  assert.throws(() => loadFlow(FIXTURE_DIR).listRankOf('nope', 'done'), FlowError);
});

const UNKNOWN = ['blocked', '__proto__', 'constructor', ['refined'], ['backlog'], 7, true, null, undefined];

test('isRunnable: refined and in_progress in the shipped flow; an unknown or non-string status is not', () => {
  const flow = loadFlow(FIXTURE_DIR);
  const runnable = (statuses) => statuses.filter((s) => flow.isRunnable('story', s));
  assert.deepEqual(runnable(flow.statusesOf('story')), ['refined', 'in_progress']);
  assert.deepEqual(runnable(UNKNOWN), []);
});

test('isUnstarted: backlog and refined in the shipped flow; an unknown or non-string status is not', () => {
  const flow = loadFlow(FIXTURE_DIR);
  const unstarted = (statuses) => statuses.filter((s) => flow.isUnstarted('story', s));
  assert.deepEqual(unstarted(flow.statusesOf('story')), ['backlog', 'refined']);
  assert.deepEqual(unstarted(UNKNOWN), []);
});

test('isRunnable, isUnstarted: a custom open status implying in_progress is runnable and started', () => {
  const flow = fixture();
  flow.types.story.statuses.in_review = { implies: ['in_progress', 'refined', 'backlog'] };
  const loaded = loadFlow(backlogWith(flow));
  assert.equal(loaded.isRunnable('story', 'in_review'), true);
  assert.equal(loaded.isUnstarted('story', 'in_review'), false);
});

test('meets: a status that is not a string meets nothing, though its text names one', () => {
  const flow = loadFlow(FIXTURE_DIR);
  for (const status of [['superseded'], ['done'], 7, true, null, undefined]) {
    assert.equal(flow.meets('story', status, 'done'), false, JSON.stringify(status));
  }
});

test('openStatusesOf: a type the flow lacks throws', () => {
  assert.throws(() => loadFlow(FIXTURE_DIR).openStatusesOf('nope'), FlowError);
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
