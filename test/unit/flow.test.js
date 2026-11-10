import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  FLOW_FILE,
  FlowError,
  LEGACY_STATUSES,
  findFlowFindings,
  fromLegacy,
  loadFlow,
  migratedFlowText,
} from '../../src/flow.js';
import { GUARDS } from '../../src/guards.js';
import { CAPABILITIES } from '../../src/capabilities.js';
import { DISPATCH } from '../../src/verbs.js';
import { FLOW_TEMPLATE, mkTempDir } from '../helpers/tempdir.js';

/** A `bl-flow/v1` file: bl's template before F-69. */
const V1_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'flow');
const TEMPLATE_DIR = dirname(FLOW_TEMPLATE);
const template = () => JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
const v1 = () => JSON.parse(readFileSync(join(V1_DIR, FLOW_FILE), 'utf8'));
const WIRING = { guards: GUARDS, capabilities: CAPABILITIES, dispatch: DISPATCH };

/** A backlog dir holding `content` (an object, or raw text) as its flow.json. */
function backlogWith(content) {
  const dir = mkTempDir('bl-flow-');
  writeFileSync(join(dir, FLOW_FILE), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return dir;
}

const STORY = [
  'draft',
  'refined',
  'in_progress',
  'in_review',
  'fixing',
  'ready_for_merge',
  'escalated',
  'done',
  'superseded',
];
const FEATURE = [
  'draft',
  'refined',
  'approved',
  'in_progress',
  'in_review',
  'fixing',
  'ready_for_merge',
  'escalated',
  'done',
  'superseded',
];

test('the template is bl-flow/v2: the ten words in lifecycle order, terminal last, no implies', () => {
  const raw = template();
  assert.equal(raw.schema, 'bl-flow/v2');
  assert.deepEqual(raw.types.feature.statuses, FEATURE);
  assert.deepEqual(raw.types.story.statuses, STORY);
  assert.deepEqual(raw.types.task.statuses, ['draft', 'done']);
  assert.deepEqual(raw.types.feature.terminal, ['done', 'superseded']);
  assert.deepEqual(raw.types.task.terminal, ['done']);
  assert.doesNotMatch(readFileSync(FLOW_TEMPLATE, 'utf8'), /implies/);
  assert.deepEqual(Object.keys(raw.types.feature.verbs), [
    'new',
    'refine',
    'approve',
    'run',
    'implement',
    'review',
    'fix',
    'merge',
    'supersede',
  ]);
  assert.deepEqual(Object.keys(raw.types.story.verbs), [
    'new',
    'refine',
    'run',
    'review',
    'fix',
    'merge',
    'supersede',
    'implement',
    'side',
    'done',
  ]);
});

test('Flow.chainOf follows then: run chains review, and review chains fix', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  assert.deepEqual(flow.chainOf('feature', 'run'), ['run', 'review', 'fix']);
  assert.deepEqual(flow.chainOf('story', 'fix'), ['fix', 'review']);
  assert.deepEqual(flow.chainOf('feature', 'approve'), ['approve']);
});

test('loadFlow reads a v2 verb row with its optional keys filled', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  assert.equal(flow.legacy, false);
  assert.deepEqual(flow.verbOf('feature', 'review'), {
    from: ['in_progress', 'in_review', 'ready_for_merge'],
    when: [],
    during: 'in_review',
    via: ['review'],
    success: [{ when: [], to: 'ready_for_merge', then: null }],
    failure: [
      { when: ['round_within_cap'], to: 'fixing', then: 'fix' },
      { when: [], to: 'escalated', then: null },
    ],
  });
  assert.deepEqual(flow.verbOf('feature', 'approve'), {
    from: ['refined'],
    when: [],
    during: null,
    via: [],
    success: [{ when: [], to: 'approved', then: null }],
    failure: [],
  });
  assert.equal(flow.verbOf('story', 'approve'), null);
  assert.equal(flow.verbOf('feature', 'supersede').from, '*');
});

test('initial: the first status of each type', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  assert.equal(flow.initial('story'), 'draft');
  assert.equal(flow.initial('feature'), 'draft');
  assert.equal(flow.initial('task'), 'draft');
});

test('edges: during included, * expanded, a during equal to the start left out, new from null', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  const edges = flow.edges('feature');
  const has = (from, to, by) => edges.some((e) => e.from === from && e.to === to && e.by === by);
  assert.ok(has(null, 'draft', 'new'));
  assert.ok(has('approved', 'in_progress', 'run'));
  assert.ok(has('escalated', 'in_progress', 'run'));
  assert.ok(!has('in_progress', 'in_progress', 'run'), 'a during equal to the status records nothing');
  assert.ok(has('in_progress', 'in_review', 'run'));
  assert.ok(!has('approved', 'in_review', 'run'), 'a branch starts from the during status');
  assert.ok(has('in_review', 'fixing', 'review'));
  assert.ok(has('in_review', 'escalated', 'review'));
  assert.ok(has('fixing', 'in_review', 'fix'));
  assert.ok(has('ready_for_merge', 'done', 'merge'));
  for (const s of FEATURE.slice(0, -2)) assert.ok(has(s, 'superseded', 'supersede'), s);
  assert.ok(!has('done', 'superseded', 'supersede'), '* is every status that is not terminal');
  assert.equal(new Set(edges.map((e) => `${e.from} ${e.to} ${e.by}`)).size, edges.length, 'each edge once');

  const story = flow.edges('story');
  assert.ok(story.some((e) => e.from === 'draft' && e.to === 'in_progress' && e.by === 'implement'));
  assert.ok(story.some((e) => e.from === 'draft' && e.to === 'in_progress' && e.by === 'side'));
  assert.ok(story.some((e) => e.from === 'escalated' && e.to === 'done' && e.by === 'done'));
  assert.deepEqual(flow.edges('task'), [
    { from: null, to: 'draft', by: 'new' },
    { from: 'draft', to: 'done', by: 'done' },
  ]);
});

test('meets: by lifecycle order; superseded meets done (F-66 A4); escalated meets in_progress', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  assert.equal(flow.meets('story', 'done', 'done'), true);
  assert.equal(flow.meets('story', 'superseded', 'done'), true);
  assert.equal(flow.meets('story', 'in_progress', 'refined'), true);
  assert.equal(flow.meets('story', 'in_progress', 'done'), false);
  assert.equal(flow.meets('story', 'done', 'superseded'), false);
  assert.equal(flow.meets('feature', 'escalated', 'in_progress'), true);
  assert.equal(flow.meets('feature', 'escalated', 'done'), false);
  assert.equal(flow.meets('feature', 'in_progress', 'escalated'), false);
  assert.equal(flow.meets('feature', 'done', 'approved'), true);
  // refine's failure branch makes draft and refined a cycle; order, not reachability, decides.
  assert.equal(flow.meets('feature', 'draft', 'refined'), false);
  // An unknown status meets nothing, not even itself.
  assert.equal(flow.meets('story', 'wrong', 'wrong'), false);
  for (const status of [['superseded'], ['done'], 7, true, null, undefined, '__proto__', 'constructor']) {
    assert.equal(flow.meets('story', status, 'done'), false, JSON.stringify(status));
  }
});

test('LEGACY_STATUSES: the v1 words read as the current ones, per type', () => {
  assert.deepEqual(LEGACY_STATUSES, {
    story: { backlog: 'draft' },
    feature: { running: 'in_progress' },
    task: { open: 'draft' },
  });
  assert.equal(fromLegacy('story', 'backlog'), 'draft');
  assert.equal(fromLegacy('feature', 'running'), 'in_progress');
  assert.equal(fromLegacy('task', 'open'), 'draft');
  assert.equal(fromLegacy('feature', 'backlog'), 'backlog', 'a word maps only for its own type');
  assert.equal(fromLegacy('story', 'constructor'), 'constructor');
  assert.equal(fromLegacy('epic', 'open'), 'open');

  const flow = loadFlow(TEMPLATE_DIR);
  assert.equal(flow.meets('story', 'backlog', 'draft'), true);
  assert.equal(flow.meets('feature', 'running', 'approved'), true);
  assert.equal(flow.isRunnable('feature', 'running'), true);
  assert.equal(flow.isUnstarted('task', 'open'), true);
  assert.equal(flow.meets('feature', 'backlog', 'draft'), false);
});

test('openStatusesOf: what does not meet done, furthest along first', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  assert.deepEqual(flow.openStatusesOf('story'), STORY.slice(0, -2).reverse());
  assert.deepEqual(flow.openStatusesOf('task'), ['draft']);
  assert.deepEqual(flow.closedStatusesOf('feature'), ['done', 'superseded']);
});

test('listRankOf: started first, then the other open statuses with any unknown one, then closed in order', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  const rank = (s) => flow.listRankOf('feature', s);
  for (const s of ['in_progress', 'in_review', 'fixing', 'ready_for_merge', 'escalated']) assert.equal(rank(s), 0, s);
  for (const s of ['draft', 'refined', 'approved']) assert.equal(rank(s), 1, s);
  assert.ok(rank('done') < rank('superseded'));
  assert.ok(rank('approved') < rank('done'));
  for (const unknown of ['blocked', '__proto__', 'constructor', ['done'], ['superseded'], 7, true, null, undefined]) {
    assert.equal(flow.listRankOf('story', unknown), 1, JSON.stringify(unknown));
  }
  assert.throws(() => flow.listRankOf('nope', 'done'), FlowError);
});

test('isRunnable, isUnstarted: the shipped story sets; an unknown or non-string status is neither', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  assert.deepEqual(flow.runnableStatusesOf('story'), STORY.slice(1, -2));
  assert.deepEqual(flow.unstartedStatusesOf('story'), ['draft', 'refined']);
  assert.deepEqual(flow.unstartedStatusesOf('feature'), ['draft', 'refined', 'approved']);
  const unknown = ['blocked', '__proto__', 'constructor', ['refined'], ['draft'], 7, true, null, undefined];
  assert.deepEqual(
    unknown.filter((s) => flow.isRunnable('story', s) || flow.isUnstarted('story', s)),
    [],
  );
});

test('a custom status sorts by its place in statuses', () => {
  const raw = template();
  raw.types.story.statuses.splice(1, 0, 'blocked');
  raw.types.story.statuses.splice(raw.types.story.statuses.indexOf('superseded'), 0, 'wontfix');
  const flow = loadFlow(backlogWith(raw));
  assert.equal(flow.meets('story', 'blocked', 'draft'), true);
  assert.equal(flow.isUnstarted('story', 'blocked'), true);
  assert.equal(flow.meets('story', 'wontfix', 'done'), true);
  assert.ok(flow.listRankOf('story', 'wontfix') > flow.listRankOf('story', 'done'));
  assert.ok(flow.listRankOf('story', 'wontfix') < flow.listRankOf('story', 'superseded'));
});

test('gatesOf names each gate with the verbs that check it', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  const gates = { run: ['run', 'implement'], merge: ['merge'] };
  assert.deepEqual(flow.gatesOf('story'), gates);
  assert.deepEqual(flow.gatesOf('feature'), gates);
  assert.deepEqual(flow.gatesOf('task'), {});
});

test('a type the flow lacks throws naming the file', () => {
  const flow = loadFlow(TEMPLATE_DIR);
  for (const call of [() => flow.statusesOf('epic'), () => flow.verbOf('epic', 'run'), () => flow.edges('epic')]) {
    assert.throws(call, (err) => err instanceof FlowError && /flow\.json: no "epic" type/.test(err.message));
  }
});

test('a v1 file loads as the v2 template with its own gates, and flow.legacy is set', () => {
  const raw = v1();
  raw.types.story.gates = { hold: { verbs: ['run'] } };
  const flow = loadFlow(backlogWith(raw));
  assert.equal(flow.legacy, true);
  assert.deepEqual(flow.statusesOf('story'), STORY);
  assert.deepEqual(flow.verbOf('feature', 'run'), loadFlow(TEMPLATE_DIR).verbOf('feature', 'run'));
  assert.deepEqual(flow.gatesOf('story'), { hold: ['run'] });
  assert.deepEqual(flow.gatesOf('feature'), { run: ['run', 'implement'], merge: ['merge'] });
});

test("migratedFlowText: the template with a v1 file's own gates, the template's text when they match, null for v2", () => {
  const raw = v1();
  raw.types.story.gates = { hold: { verbs: ['run'] } };
  const text = migratedFlowText(backlogWith(raw));
  const expected = template();
  expected.types.story.gates = { hold: { verbs: ['run'] } };
  assert.deepEqual(JSON.parse(text), expected);
  assert.equal(migratedFlowText(backlogWith(v1())), readFileSync(FLOW_TEMPLATE, 'utf8'));
  assert.equal(migratedFlowText(TEMPLATE_DIR), null);
});

test('loadFlow throws naming the file when it is missing, unparsable, of a wrong schema or of a wrong shape', () => {
  const missing = mkTempDir('bl-flow-');
  assert.throws(
    () => loadFlow(missing),
    (err) =>
      err instanceof FlowError && err.message.startsWith(join(missing, FLOW_FILE)) && /missing/.test(err.message),
  );
  const withStory = (story) => ({ ...template(), types: { ...template().types, story } });
  const withVerb = (verb) => withStory({ ...template().types.story, verbs: { run: verb } });
  const cases = [
    ['{ not json', /not valid JSON/],
    [{ ...template(), schema: 'bl-flow/v0' }, /"schema" is "bl-flow\/v0", not "bl-flow\/v2"/],
    [{ schema: 'bl-flow/v2', types: { story: template().types.story } }, /no "feature" type/],
    [
      { schema: 'bl-flow/v2', types: { story: template().types.story, feature: template().types.feature } },
      /no "task" type/,
    ],
    [{ schema: 'bl-flow/v1', types: { story: v1().types.story, feature: v1().types.feature } }, /no "task" type/],
    [{ ...v1(), types: { ...v1().types, story: { statuses: {} } } }, /type "story" has no "gates" object/],
    [withStory({ ...template().types.story, statuses: {} }), /type "story" has no "statuses" list/],
    [withStory({ ...template().types.story, terminal: 'done' }), /type "story" has no "terminal" list/],
    [withStory({ ...template().types.story, verbs: [] }), /type "story" has no "verbs" object/],
    [withStory({ ...template().types.story, gates: undefined }), /type "story" has no "gates" object/],
    [withVerb({ from: 'refined' }), /verb "run" has no "from" list/],
    [withVerb({ from: [], via: 'implement' }), /verb "run" "via" is not a list/],
    [withVerb({ from: [], during: ['in_progress'] }), /verb "run" "during" is not a status/],
    [withVerb({ from: [], success: { to: 'done' } }), /verb "run" "success" is not a list of branches/],
    [withVerb({ from: [], failure: [{}] }), /verb "run" "failure" branch 1 has no "to" status/],
    [withVerb({ from: [], success: [{ to: 'done', then: 7 }] }), /branch 1 has a "then" that is not a verb/],
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
  const dir = backlogWith(template());
  assert.equal(loadFlow(dir).statusesOf('story').includes('blocked'), false);
  const changed = template();
  changed.types.story.statuses.splice(1, 0, 'blocked');
  writeFileSync(join(dir, FLOW_FILE), JSON.stringify(changed, null, 2));
  assert.equal(loadFlow(dir).statusesOf('story').includes('blocked'), true);
  rmSync(join(dir, FLOW_FILE));
  assert.throws(() => loadFlow(dir), /missing/);
});

// ---------------------------------------------------------------------------
// v1 and v2 agree (S-1127): every helper, over every v1 status after the map
// ---------------------------------------------------------------------------

/**
 * Where v1 and v2 disagree, over every v1 status of every type (mapped
 * through `fromLegacy` for v2): each helper's answer, as `helper type args`.
 */
function disagreements(old, now) {
  const out = [];
  const say = (what, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(what);
  };
  for (const type of ['story', 'feature', 'task']) {
    const words = old.statusesOf(type);
    const map = (s) => fromLegacy(type, s);
    // Only the v1 statuses, mapped, in the order v2 gives them.
    const known = (list) => list.filter((s) => words.map(map).includes(s));
    say(`openStatusesOf ${type}`, old.openStatusesOf(type).map(map), known(now.openStatusesOf(type)));
    say(`closedStatusesOf ${type}`, old.closedStatusesOf(type).map(map), known(now.closedStatusesOf(type)));
    say(`runnableStatusesOf ${type}`, old.runnableStatusesOf(type).map(map), known(now.runnableStatusesOf(type)));
    say(`unstartedStatusesOf ${type}`, old.unstartedStatusesOf(type).map(map), known(now.unstartedStatusesOf(type)));
    for (const s of words) {
      say(`isRunnable ${type} ${s}`, old.isRunnable(type, s), now.isRunnable(type, map(s)));
      say(`isUnstarted ${type} ${s}`, old.isUnstarted(type, s), now.isUnstarted(type, map(s)));
      for (const w of words) {
        say(`meets ${type} ${s} ${w}`, old.meets(type, s, w), now.meets(type, map(s), map(w)));
        // Ranks are numbers of each file's own; their order must agree.
        const cmp = (f, a, b) => Math.sign(f.listRankOf(type, a) - f.listRankOf(type, b));
        say(`listRankOf ${type} ${s} ${w}`, cmp(old, s, w), cmp(now, map(s), map(w)));
      }
    }
  }
  return out;
}

/**
 * The v1 helpers, from `implies`, as bl read a v1 file before F-69. The words
 * they test against are mapped back too: their `in_progress` is a v1
 * feature's `running`, which no story helper caller ever reached.
 */
function v1Helpers(raw) {
  const statuses = (type) => Object.keys(raw.types[type].statuses);
  const known = (type, s) => typeof s === 'string' && Object.hasOwn(raw.types[type].statuses, s);
  const meets = (type, s, w) => known(type, s) && (s === w || raw.types[type].statuses[s].implies.includes(w));
  const h = {
    statusesOf: statuses,
    meets,
    isRunnable: (type, s) => meets(type, s, 'refined') && !meets(type, s, 'done'),
    isUnstarted: (type, s) =>
      statuses(type).includes(s) && !meets(type, s, 'in_progress') && !meets(type, s, 'running'),
    openStatusesOf: (type) =>
      statuses(type)
        .filter((s) => !meets(type, s, 'done'))
        .sort((a, b) => raw.types[type].statuses[b].implies.length - raw.types[type].statuses[a].implies.length),
    closedStatusesOf: (type) => statuses(type).filter((s) => meets(type, s, 'done')),
    runnableStatusesOf: (type) => statuses(type).filter((s) => h.isRunnable(type, s)),
    unstartedStatusesOf: (type) => statuses(type).filter((s) => h.isUnstarted(type, s)),
    listRankOf: (type, s) => {
      if (meets(type, s, 'done')) return 2 + h.closedStatusesOf(type).indexOf(s);
      return meets(type, s, 'in_progress') || meets(type, s, 'running') ? 0 : 1;
    },
  };
  return h;
}

test('v1 and v2 agree on every helper over the v1 template statuses', () => {
  assert.deepEqual(disagreements(v1Helpers(v1()), loadFlow(TEMPLATE_DIR)), []);
});

test('v1 and v2 agree over the live v1 shape, except that escalated now meets in_progress', () => {
  // The live backlog's v1 file: escalated did not imply running.
  const live = v1();
  live.types.feature.statuses.escalated.implies = ['approved', 'refined', 'draft'];
  // Each difference is escalated's: it now sorts and counts with the started ones.
  assert.deepEqual(disagreements(v1Helpers(live), loadFlow(TEMPLATE_DIR)).sort(), [
    'isUnstarted feature escalated',
    'listRankOf feature approved escalated',
    'listRankOf feature draft escalated',
    'listRankOf feature escalated approved',
    'listRankOf feature escalated draft',
    'listRankOf feature escalated refined',
    'listRankOf feature escalated running',
    'listRankOf feature refined escalated',
    'listRankOf feature running escalated',
    'meets feature escalated running',
    'openStatusesOf feature',
    'unstartedStatusesOf feature',
  ]);
});

// ---------------------------------------------------------------------------
// flow-json findings (F-69 D1)
// ---------------------------------------------------------------------------

/** The flow-json messages for the template with `change` applied. */
function findingsAfter(change) {
  const raw = template();
  change(raw);
  return findFlowFindings(loadFlow(backlogWith(raw)), WIRING).map((f) => `${f.severity}: ${f.message}`);
}

test('flow-json: the shipped template has no findings', () => {
  assert.deepEqual(findFlowFindings(loadFlow(TEMPLATE_DIR), WIRING), []);
});

test('flow-json: a v1 file is one warning naming the migration script', () => {
  assert.deepEqual(findFlowFindings(loadFlow(V1_DIR), WIRING), [
    {
      severity: 'warning',
      code: 'flow-json',
      location: 'flow.json',
      message:
        "flow.json is bl-flow/v1; bl reads it as its bl-flow/v2 template with this file's gates. " +
        'Run node bl/scripts/migrate-transitions.js to rewrite the backlog.',
    },
  ]);
});

test('flow-json: a from, during, to or terminal status the type lacks', () => {
  assert.deepEqual(
    findingsAfter((raw) => {
      const { verbs } = raw.types.story;
      verbs.approve = { from: ['parked'], success: [{ to: 'refined' }] };
      verbs.run.during = 'working';
      verbs.side.success = [{ to: 'started' }, { to: 'in_progress' }];
      raw.types.task.terminal = ['closed', 'done'];
    }),
    [
      'error: story verb "run" records during "working", which is not a story status',
      'error: story verb "side" goes on success to "started", which is not a story status',
      'error: story verb "approve" starts from "parked", which is not a story status',
      'error: task terminal names "closed", which is not a task status',
    ],
  );
});

test('flow-json: a when or via name bl does not register', () => {
  assert.deepEqual(
    findingsAfter((raw) => {
      const { run, review } = raw.types.feature.verbs;
      run.when = ['gate_free:run', 'members_in:refined'];
      run.via = ['implement', 'deploy'];
      review.failure[0].when = ['round_below_cap'];
    }),
    [
      'error: feature verb "run" checks guard "members_in:refined", which bl does not register (bl/src/guards.js)',
      'error: feature verb "run" runs capability "deploy", which bl does not register (bl/src/capabilities.js)',
      'error: feature verb "review" checks guard "round_below_cap" on failure, which bl does not register (bl/src/guards.js)',
    ],
  );
});

test('flow-json: a then that is not a verb of the type, or one that does not start from the branch to', () => {
  assert.deepEqual(
    findingsAfter((raw) => {
      const { run, fix } = raw.types.feature.verbs;
      run.success[0].then = 'publish';
      fix.success[0].then = 'approve';
    }),
    [
      'error: feature verb "run" chains on success to "publish", which is not a feature verb',
      'error: feature verb "fix" chains on success to "approve", which does not start from "in_review"',
    ],
  );
});

test("flow-json: a status that is no branch's to", () => {
  assert.deepEqual(
    findingsAfter((raw) => {
      raw.types.story.statuses.splice(1, 0, 'blocked');
    }),
    ['error: story status "blocked" is no branch\'s "to"; no verb reaches it'],
  );
});

test('flow-json: a terminal status before an open one, or one a verb other than supersede starts from', () => {
  assert.deepEqual(
    findingsAfter((raw) => {
      const { feature } = raw.types;
      feature.statuses = [...feature.statuses.filter((s) => s !== 'escalated'), 'escalated'];
      feature.verbs.refine.from = ['draft', 'refined', 'done'];
      feature.verbs.supersede.from = ['draft', 'done'];
    }),
    [
      'error: feature status "escalated" comes after a terminal status; terminal statuses come last in "statuses"',
      'error: feature verb "refine" starts from terminal status "done"; only supersede may',
    ],
  );
});

test('flow-json: a verb bl dispatches for a type that its table lacks; status reads only', () => {
  assert.deepEqual(
    findingsAfter((raw) => {
      delete raw.types.feature.verbs.approve;
      raw.types.feature.verbs.refine.success.push({ to: 'approved' });
    }),
    ['error: bl dispatches "approve" for a feature, and the feature table has no "approve" verb'],
  );
  assert.equal(DISPATCH.status.feature != null, true, 'status dispatches, and no table has it');
});

test('flow-json: a gate verb bl does not check', () => {
  assert.deepEqual(
    findingsAfter((raw) => {
      raw.types.feature.gates.review = { verbs: ['review', 'merge'] };
    }),
    ['error: feature gate "review" names verb "review"; bl checks gates only at run, implement, merge'],
  );
});

test('every DISPATCH handler is a registered capability, and the guards D1 names are registered', () => {
  for (const kinds of Object.values(DISPATCH)) {
    for (const cell of Object.values(kinds).filter((c) => c != null)) {
      assert.equal(typeof CAPABILITIES.get(cell), 'function', cell);
    }
  }
  for (const name of ['gate_free', 'escalation_cleared', 'round_within_cap']) {
    assert.equal(typeof GUARDS.get(name), 'function', name);
  }
});

test('round_within_cap holds up to and at the cap; escalation_cleared reads ## Escalation', () => {
  const within = GUARDS.get('round_within_cap');
  assert.equal(within({ round: 1, maxRounds: 2 }), true);
  assert.equal(within({ round: 2, maxRounds: 2 }), true);
  assert.equal(within({ round: 3, maxRounds: 2 }), false);
  const dir = mkTempDir('bl-guard-');
  const file = join(dir, 'index.md');
  const cleared = GUARDS.get('escalation_cleared');
  writeFileSync(file, '---\nfeature_id: F-1\n---\n\n## Escalation\n\nNone.\n');
  assert.equal(cleared({ indexPath: file }), true);
  writeFileSync(file, '---\nfeature_id: F-1\n---\n\n## Escalation\n\n**The rule at stake:** x\n');
  assert.equal(cleared({ indexPath: file }), false);
});
