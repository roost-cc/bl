import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_TEMPLATE, mkTempBacklog } from '../helpers/tempdir.js';
import { buildSampleBacklog } from '../helpers/sample-backlog.js';
import { spawnSync } from 'node:child_process';
import { BL_BIN, runBl } from '../helpers/run-bl.js';
import { writeBlockersLocked } from '../helpers/covering-lock.js';

/**
 * A fixture that passes the component rules (F-49 D4): every registered repo
 * has one home component. `fixture.repos`, `fixture.components` and
 * `fixture.stories` add to demo-repo and its C00.
 */
/**
 * A unit in the shape after the migration (F-69 D2): a `draft` transition
 * log and its `added:`, no `status:`, so it has no `legacy-status` warning. A
 * fixture unit that sets a status or a log keeps it.
 */
const migrated = (u) => {
  if (u.status != null || u.transitions != null) return u;
  const added = u.added ?? '2026-01-01';
  return { ...u, added, transitions: [{ at: `${added}T00:00:00Z`, to: 'draft', by: 'new' }] };
};

function cleanBacklog(fixture = {}) {
  return mkTempBacklog({
    ...fixture,
    stories: fixture.stories?.map(migrated),
    features: fixture.features?.map(migrated),
    repos: ['../demo-repo', ...(fixture.repos ?? [])],
    components: [
      { id: 'C00', title: 'Foundation', dirSuffix: 'foundation', repo: 'demo-repo', home: true },
      ...(fixture.components ?? []),
    ],
  });
}

test('bl validate finds frontmatter errors', async () => {
  const td = buildSampleBacklog();

  // Add a story with a bad status
  const badStoryDir = join(td.dir, 'stories/S999-bad-story');
  mkdirSync(badStoryDir, { recursive: true });
  writeFileSync(
    join(badStoryDir, 'index.md'),
    `---
component: C00
story_id: S-999
title: Bad Story
type: feature
status: wrong_status
points: 5
---
# Bad Story
`,
  );

  const { stdout, stderr, status } = await runBl(['validate'], { cwd: td.dir });

  assert.equal(status, 1);
  assert.ok(stdout.includes('bad-status: status "wrong_status" not in known set'));
  assert.match(stderr, /scanning \d+ stor(y|ies) across \d+ components?…/);

  td.cleanup();
});

test('bl validate finds duplicate IDs across repos', async () => {
  const td = cleanBacklog({
    repos: ['../app', '../infra'],
    components: [
      { id: 'C01', title: 'E1', repo: 'app', home: true },
      { id: 'C02', title: 'E2', repo: 'infra', home: true },
    ],
    stories: [
      // One directory each: in the flat stories/ only the slug tells them apart.
      { id: 'S-1', component: 'C01', title: 'S1', dirSuffix: 'one' },
      { id: 'S-1', component: 'C02', title: 'S2', dirSuffix: 'two' },
    ],
  });

  const { stdout, stderr, status } = await runBl(['validate'], { cwd: td.dir });

  if (status !== 1) {
    console.error('stdout:', stdout);
    console.error('stderr:', stderr);
  }
  assert.equal(status, 1);
  assert.ok(stdout.includes('duplicate-id: duplicate story ID S-1 across 2 files'));

  td.cleanup();
});

test('bl validate --json output', async () => {
  const td = cleanBacklog({
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'S1',
        depends_on: 'S-2',
      },
      {
        id: 'S-2',
        component: 'C00',
        title: 'S2',
        depends_on: 'S-1',
      },
    ],
  });

  const { stdout, status } = await runBl(['validate', '--json'], {
    cwd: td.dir,
  });

  assert.equal(status, 1);
  const data = JSON.parse(stdout);
  // A cycle of depends_on: keys is a deadlock among the run edges they stand for (F-111 D4).
  assert.deepEqual(
    data.findings.filter((f) => f.severity === 'error').map((f) => [f.code, f.location]),
    [['blockers-cycle', 'blockers.json']],
  );
  assert.equal(data.summary.errors, 1);

  td.cleanup();
});

test('bl validate refuses --project and checks every story (F-51 D5)', async () => {
  const td = cleanBacklog({
    repos: ['../app', '../infra'],
    components: [
      { id: 'C01', title: 'E1', repo: 'app', home: true },
      { id: 'C02', title: 'E2', repo: 'infra', home: true },
    ],
    stories: [{ id: 'S-1', component: 'C01', title: 'S1' }],
  });

  // Add an error in 'infra' project manually
  const badInfraDir = join(td.dir, 'stories/S999-bad-infra');
  mkdirSync(badInfraDir, { recursive: true });
  writeFileSync(
    join(badInfraDir, 'index.md'),
    `---
component: C02
story_id: S-999
title: Bad Infra
status: wrong_status
---
`,
  );

  const refused = await runBl(['validate', '--project', 'app'], {
    cwd: td.dir,
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unknown option "--project"/);

  // Validate all
  const { status: statusAll } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(statusAll, 1);

  td.cleanup();
});

test('bl validate resolves deps across repos', async () => {
  const td = cleanBacklog({
    repos: ['../app', '../infra'],
    components: [
      { id: 'C01', title: 'E1', repo: 'app', home: true },
      { id: 'C02', title: 'E2', repo: 'infra', home: true },
    ],
    stories: [
      {
        id: 'S-1',
        component: 'C01',
        title: 'S1',
        depends_on: 'S-2',
      },
      { id: 'S-2', component: 'C02', title: 'S2' },
    ],
  });

  const result = await runBl(['validate', '--json'], { cwd: td.dir });
  const data = JSON.parse(result.stdout);
  assert.equal(data.summary.errors, 0);
  assert.ok(!data.findings.some((f) => f.code === 'dangling-dep'));

  // Counter-test: remove S-2 entirely, so S-1's depends_on is truly dangling.
  rmSync(join(td.dir, 'stories/S2'), { recursive: true, force: true });
  const danglingResult = await runBl(['validate', '--json'], { cwd: td.dir });
  const danglingData = JSON.parse(danglingResult.stdout);
  assert.ok(danglingData.findings.some((f) => f.code === 'dangling-dep'));

  td.cleanup();
});

// ---------------------------------------------------------------------------
// Per-finding-code coverage. Each test seeds a tempdir with one offending
// story or component and asserts the corresponding code shows up in the report.
// ---------------------------------------------------------------------------

function writeStory(td, storyDir, body) {
  const dir = join(td.dir, 'stories', storyDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.md'), body);
}

function writeComponent(td, componentEntry, body) {
  const dir = join(td.dir, 'components', componentEntry);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.md'), body);
}

test('bl validate fires missing-required-key when title is absent', async () => {
  const td = cleanBacklog();
  writeStory(
    td,
    'S100-x',
    `---
component: C00
story_id: S-100
status: backlog
---
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /missing-required-key:.*"title"/);
  td.cleanup();
});

test('bl validate fires unknown-fm-key on a stray frontmatter key', async () => {
  const td = cleanBacklog();
  writeStory(
    td,
    'S100-x',
    `---
component: C00
story_id: S-100
title: t
status: backlog
owner: rp
---
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 0);
  assert.match(stdout, /unknown-fm-key:.*"owner"/);
  td.cleanup();
});

test('bl validate fires bad-points on a zero points value', async () => {
  const td = cleanBacklog();
  writeStory(
    td,
    'S100-x',
    `---
component: C00
story_id: S-100
title: t
status: backlog
points: 0
---
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /bad-points/);
  td.cleanup();
});

test('bl validate fires bad-id-format on a malformed story_id', async () => {
  const td = cleanBacklog();
  writeStory(
    td,
    'S100-x',
    `---
component: C00
story_id: SX
title: t
status: backlog
---
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /bad-id-format/);
  td.cleanup();
});

test('bl validate fires id-dir-mismatch when story_id does not match dir', async () => {
  const td = cleanBacklog();
  writeStory(
    td,
    'S101-wrong',
    `---
component: C00
story_id: S-100
title: t
status: backlog
---
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /id-dir-mismatch/);
  td.cleanup();
});

test('bl validate fires self-loop cycle', async () => {
  const td = cleanBacklog({
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'loop',
        depends_on: 'S-1',
      },
    ],
  });
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /cycle:.*self-loop|cycle:.*S-1/);
  td.cleanup();
});

test("bl validate fires dangling-dep when target story doesn't exist", async () => {
  const td = cleanBacklog({
    stories: [
      {
        id: 'S-1',
        component: 'C00',
        title: 'x',
        depends_on: 'S-9999',
      },
    ],
  });
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /dangling-dep.*S-9999/);
  td.cleanup();
});

test('bl validate: block-list depends_on parses to a real edge, no phantom dangling-dep', async () => {
  // Regression for S-582: block-sequence depends_on used to parse to `{}`,
  // yielding phantom `object`/`Object` dangling-deps while dropping the real
  // edge. It should now parse to a real ID and produce no dangling-dep.
  const td = cleanBacklog();
  writeStory(
    td,
    'S100-x',
    `---
component: C00
story_id: S-100
title: depends via block list
status: backlog
depends_on:
  - S-101
---
`,
  );
  writeStory(
    td,
    'S101-y',
    `---
component: C00
story_id: S-101
title: target
status: backlog
---
`,
  );
  const { stdout, status } = await runBl(['validate', '--json'], {
    cwd: td.dir,
  });
  const data = JSON.parse(stdout);
  // No phantom dangling-dep of any kind (no "object"/"Object", no S-101).
  assert.ok(!data.findings.some((f) => f.code === 'dangling-dep'));
  assert.equal(status, 0);
  // The real edge S-100 → S-101 is seen: S-101's derived dependents hold S-100.
  const tree = await runBl(['tree', 'S-101'], { cwd: td.dir });
  assert.equal(tree.status, 0, tree.stderr);
  assert.match(tree.stdout, /^S-100 .*\n└── S-101 /m);
  td.cleanup();
});

test('bl validate: an edge stated on one side only is no finding (F-77 D3)', async () => {
  const td = cleanBacklog({
    stories: [
      { id: 'S-1', component: 'C00', title: 'a', depends_on: 'S-2' },
      { id: 'S-2', component: 'C00', title: 'b' },
    ],
  });
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 0, stdout);
  // Only the key itself is reported (F-111 D5), as a warning.
  assert.deepEqual(
    JSON.parse(stdout)
      .findings.filter((f) => f.code !== 'plugin-binary')
      .map((f) => [f.severity, f.code, f.location]),
    [['warning', 'depends-on-key', 'stories/S1/index.md']],
  );
  td.cleanup();
});

test('bl validate: a stored required_for is derived-key (F-77 D3)', async () => {
  const td = cleanBacklog({
    stories: [
      { id: 'S-1', component: 'C00', title: 'a', depends_on: 'S-2' },
      { id: 'S-2', component: 'C00', title: 'b', required_for: 'S-1' },
    ],
  });
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.deepEqual(
    JSON.parse(stdout)
      .findings.filter((f) => f.code !== 'plugin-binary')
      .map((f) => [f.severity, f.code, f.location]),
    [
      ['warning', 'depends-on-key', 'stories/S1/index.md'],
      ['error', 'derived-key', 'stories/S2/index.md'],
    ],
  );
  td.cleanup();
});

test('bl validate --strict promotes warnings to non-zero exit', async () => {
  const td = cleanBacklog();
  // An unknown frontmatter key is a warning.
  writeStory(td, 'S1-a', '---\ncomponent: C00\nstory_id: S-1\ntitle: a\nstatus: backlog\nbogus_key: x\n---\n');

  const plain = await runBl(['validate'], { cwd: td.dir });
  assert.equal(plain.status, 0);

  const strict = await runBl(['validate', '--strict'], { cwd: td.dir });
  assert.equal(strict.status, 2);

  td.cleanup();
});

test('bl validate --json to a pipe writes the whole report, past the pipe buffer', () => {
  // 700 findings make a report of ~200 KB, past a pipe's 64 to 128 KiB. An
  // exit straight after the write used to cut it there.
  const stories = Array.from({ length: 700 }, (_, i) => ({
    id: `S-${i + 1}`,
    component: 'C00',
    title: `story ${i + 1}`,
    required_for: 'S-1',
  }));
  const td = cleanBacklog({ stories });
  try {
    const out = join(td.dir, '.bl', 'validate.json');
    mkdirSync(join(td.dir, '.bl'), { recursive: true });
    const r = spawnSync('/bin/sh', ['-c', '"$1" validate --json | cat >"$2"', 'sh', BL_BIN, out], {
      cwd: td.dir,
      env: { ...process.env, BL_BACKLOG_DIR: td.dir },
      stdio: 'ignore',
    });
    assert.equal(r.status, 0);
    const text = readFileSync(out, 'utf8');
    assert.ok(text.length > 150_000, `report is ${text.length} bytes`);
    const report = JSON.parse(text);
    assert.equal(report.findings.filter((f) => f.code === 'derived-key').length, 700);
  } finally {
    td.cleanup();
  }
});

test('bl validate --help prints documented options on stdout', async () => {
  const td = cleanBacklog();
  const { stdout, stderr, status } = await runBl(['validate', '--help'], {
    cwd: td.dir,
  });
  assert.equal(status, 0);
  assert.match(stdout, /Usage: bl validate/);
  assert.doesNotMatch(stdout, /--project/);
  assert.match(stdout, /--strict/);
  assert.match(stdout, /Output:/);
  assert.match(stdout, /Exit codes:/);
  assert.match(stdout, /missing-required-key/);
  assert.equal(stderr, '');
  td.cleanup();
});

test('bl validate --json with no findings emits an empty findings list', async () => {
  const td = cleanBacklog({
    stories: [{ id: 'S-1', component: 'C00', title: 'ok' }],
  });
  const { stdout, stderr, status } = await runBl(['validate', '--json'], {
    cwd: td.dir,
  });
  assert.equal(status, 0);
  assert.equal(stderr, '');
  const data = JSON.parse(stdout);
  assert.equal(data.summary.errors, 0);
  assert.equal(data.findings.length, 0);
  td.cleanup();
});

test('bl validate component frontmatter: missing-required-key', async () => {
  const td = cleanBacklog();
  writeComponent(
    td,
    'C49-bad',
    `---
title: missing component_id
repo: demo-repo
---
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /missing-required-key/);
  td.cleanup();
});

// ---------------------------------------------------------------------------
// review_status / Review Log integrity (S-458), in the change document (F-42)
// ---------------------------------------------------------------------------

const STORY_FM = `---
component: C00
story_id: S-100
title: t
status: in_progress
points: 1
type: feature
---
# t
`;

/** A story S-100 with a change document whose frontmatter adds `fm` and whose body is `body`. */
function writeStoryWithChange(td, fm, body = '') {
  writeStory(td, 'S100-x', STORY_FM);
  writeChange(
    td,
    'S100-x',
    `---\nchange_of: S-100\nstatus: open\nreview_round: 1\n${fm}repos:\n  - repo: demo\n    branch: s100-x\n---\n\n# S-100\n${body}`,
  );
}

function writeChange(td, storyDir, text, name = 'change.md') {
  const dir = join(td.dir, 'stories', storyDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

const CHANGE_REL = 'stories/S100-x/change.md';

test('bl validate fires review-log-missing on pending without log', async () => {
  const td = cleanBacklog();
  writeStoryWithChange(td, 'review_status: pending\n', '\n## Summary\nnothing here\n');
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const hit = JSON.parse(stdout).findings.find((f) => f.code === 'review-log-missing');
  assert.equal(hit?.location, CHANGE_REL, 'the change document is the file named');
  td.cleanup();
});

test('bl validate fires review-log-unaddressed on addressed with open items', async () => {
  const td = cleanBacklog();
  writeStoryWithChange(
    td,
    'review_status: addressed\n',
    `
## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [ ] still open
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /review-log-unaddressed/);
  td.cleanup();
});

test('bl validate warns on the old review fields, whatever their value, and errors on an unknown change status (F-69 D5)', async () => {
  const td = cleanBacklog();
  writeStoryWithChange(td, 'review_status: garbage\n');
  writeFileSync(
    join(td.dir, CHANGE_REL),
    readFileSync(join(td.dir, CHANGE_REL), 'utf8').replace('status: open', 'status: shipped'),
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(
    stdout,
    /legacy-review-fields: "review_round:" "1", "review_status:" "garbage": the unit's transition log holds the review state; node bl\/scripts\/migrate-transitions\.js removes them/,
  );
  assert.doesNotMatch(stdout, /bad-review-status/);
  assert.match(stdout, /bad-change-status: "status:" "shipped" not in known set/);
  td.cleanup();
});

test('bl validate warns on a change document whose status is the old closed (F-69 D6)', async () => {
  const td = cleanBacklog();
  writeStoryWithChange(td, '');
  writeFileSync(
    join(td.dir, CHANGE_REL),
    readFileSync(join(td.dir, CHANGE_REL), 'utf8').replace('status: open', 'status: closed'),
  );
  const { stdout } = await runBl(['validate', '--json'], { cwd: td.dir });
  const found = JSON.parse(stdout).findings.filter((f) => f.code === 'bad-change-status');
  assert.deepEqual(
    found.map((f) => [f.severity, f.message]),
    [['warning', '"status:" "closed" is the old word for "dropped"; write "dropped"']],
  );
  td.cleanup();
});

test('bl validate passes when pending matches a real session', async () => {
  const td = cleanBacklog();
  writeStoryWithChange(
    td,
    'review_status: pending\n',
    `
## Review Log

### Session 2026-05-11 (PR #1)

**Must fix**

- [ ] open
`,
  );
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 0, stdout);
  assert.doesNotMatch(stdout, /review-log-|change-/);
  td.cleanup();
});

test('bl validate checks the log against the latest Review Log session: fixing with none, in_review after a fix with open items (F-69 D5)', async () => {
  const log = (...tos) =>
    tos
      .map((to, i) => `  - at: 2026-11-0${i + 1}T00:00:00Z\n    to: ${to.split(':')[0]}\n    by: ${to.split(':')[1]}\n`)
      .join('');
  const cases = [
    {
      log: log('draft:new', 'in_progress:implement', 'in_review:run', 'fixing:review'),
      body: '',
      code: 'review-log-missing',
    },
    {
      log: log('draft:new', 'in_progress:implement', 'in_review:run', 'fixing:review', 'in_review:fix'),
      body: '\n## Review Log\n\n### Session 2026-11-04 (PR #1)\n\n**Must fix**\n\n- [ ] still open\n',
      code: 'review-log-unaddressed',
    },
  ];
  for (const c of cases) {
    const td = cleanBacklog();
    writeStory(td, 'S100-x', STORY_FM.replace('status: in_progress\n', `transitions:\n${c.log}added: 2026-11-01\n`));
    writeChange(
      td,
      'S100-x',
      `---\nchange_of: S-100\nstatus: open\nrepos:\n  - repo: demo\n    branch: s100-x\n---\n\n# S-100\n${c.body}`,
    );
    const { stdout } = await runBl(['validate', '--json'], { cwd: td.dir });
    const hits = JSON.parse(stdout).findings.filter((f) => /^review-log-|legacy-review/.test(f.code));
    assert.deepEqual(
      hits.map((f) => [f.code, f.location]),
      [[c.code, CHANGE_REL]],
      stdout,
    );
    td.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F-42: run state belongs to the change document
// ---------------------------------------------------------------------------

test('bl validate fails each run-state key and a Review Log in an index.md, naming the file and the key', async () => {
  const td = cleanBacklog({
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'draft' }],
  });
  writeStory(
    td,
    'S100-x',
    STORY_FM.replace(
      'type: feature\n',
      'type: feature\nbranch: s100-x\npr: 7\nreview_round: 1\nreview_status: pending\n',
    ) + '\n## Review Log\n\nNo reviews yet.\n',
  );
  const featurePath = join(td.dir, 'features', 'F1-feat', 'index.md');
  writeFileSync(
    featurePath,
    readFileSync(featurePath, 'utf8')
      .replace('status: draft\n', 'status: draft\npr: 3\n')
      .concat('\n## Review Log\n\nNo reviews yet.\n'),
  );
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const hits = JSON.parse(stdout).findings.filter((f) => f.code === 'run-state-in-spec');
  const by = (loc) => hits.filter((f) => f.location === loc).map((f) => f.message);
  assert.deepEqual(by('stories/S100-x/index.md'), [
    '"branch:" belongs in the unit\'s change.md, not its index.md',
    '"pr:" belongs in the unit\'s change.md, not its index.md',
    '"review_round:" belongs in the unit\'s change.md, not its index.md',
    '"review_status:" belongs in the unit\'s change.md, not its index.md',
    '"## Review Log" belongs in the unit\'s change.md, not its index.md',
  ]);
  assert.deepEqual(by('features/F1-feat/index.md'), [
    '"pr:" belongs in the unit\'s change.md, not its index.md',
    '"## Review Log" belongs in the unit\'s change.md, not its index.md',
  ]);
  assert.ok(hits.every((f) => f.severity === 'error'));
  td.cleanup();
});

test('bl validate fails a change document whose change_of does not match its directory', async () => {
  const td = cleanBacklog({
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', primary_repo: 'demo', branch: 'f1-feat' },
    ],
  });
  const fchange = join(td.dir, 'features', 'F1-feat', 'change.md');
  writeFileSync(fchange, readFileSync(fchange, 'utf8').replace('change_of: F-1', 'change_of: F-2'));
  writeStory(td, 'S100-x', STORY_FM);
  // A second change of the story, with no change_of at all.
  writeChange(td, 'S100-x', '---\nstatus: open\nrepos:\n  - repo: demo\n    branch: s100-x\n---\n', 'change-2.md');
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const hits = JSON.parse(stdout).findings.filter((f) => f.code === 'change-of-mismatch');
  assert.deepEqual(
    hits.map((f) => [f.location, f.message]),
    [
      ['stories/S100-x/change-2.md', '"change_of:" is missing but the directory holds S-100'],
      ['features/F1-feat/change.md', '"change_of:" is "F-2" but the directory holds F-1'],
    ],
  );
  td.cleanup();
});

test('bl validate fails a repos: entry without repo or branch', async () => {
  const td = cleanBacklog();
  writeStory(td, 'S100-x', STORY_FM);
  writeChange(
    td,
    'S100-x',
    '---\nchange_of: S-100\nstatus: open\nrepos:\n  - repo: demo\n    branch: s100-x\n  - repo: other\n    pr: 4\n  - branch: s100-x\n---\n',
  );
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const hits = JSON.parse(stdout).findings.filter((f) => f.code === 'change-repo-incomplete');
  assert.deepEqual(
    hits.map((f) => [f.location, f.message]),
    [
      [CHANGE_REL, '"repos:" entry 2 (other) has no "branch:"'],
      [CHANGE_REL, '"repos:" entry 3 has no "repo:"'],
    ],
  );
  td.cleanup();
});

// ---------------------------------------------------------------------------
// The component rules (F-49 D4), end to end
// ---------------------------------------------------------------------------

test('bl validate reports the component checks, each at the file it names', async () => {
  const td = cleanBacklog({
    repos: ['../bl', '../tools'],
    components: [
      { id: 'C32', title: 'bl', dirSuffix: 'bl', repo: 'bl', home: true },
      { id: 'C45', title: 'Updates', dirSuffix: 'updates', repo: 'bl', home: true },
      { id: 'C60', title: 'Stray', dirSuffix: 'stray', repo: 'nowhere' },
    ],
    stories: [
      { id: 'S-1', component: 'C32', title: 'ok', dirSuffix: 'ok' },
      { id: 'S-3', component: 'C77', title: 'unknown', dirSuffix: 'unknown' },
    ],
  });
  const c32 = join(td.dir, 'components', 'C32-bl', 'index.md');
  writeFileSync(c32, readFileSync(c32, 'utf8').replace('home: true\n', 'home: true\nstatus: done\npoints: 3\n'));
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const got = JSON.parse(stdout)
    .findings.filter((f) => f.code.startsWith('component-') || f.code === 'home-component')
    .map((f) => [f.code, f.location]);
  assert.deepEqual(got, [
    ['component-unknown', 'stories/S3-unknown/index.md'],
    ['component-has-status', 'components/C32-bl/index.md'],
    ['component-has-status', 'components/C32-bl/index.md'],
    ['home-component', 'components/C60-stray/index.md'],
    ['home-component', 'components/C32-bl/index.md'],
    ['home-component', 'components/C45-updates/index.md'],
    ['home-component', 'components/'],
  ]);
  td.cleanup();
});

test('bl validate reports nothing on a backlog whose themes, epics and features keep the value axis', async () => {
  const td = cleanBacklog({
    themes: [{ id: 'backlog', title: 'Backlog', repos: ['demo-repo'] }],
    valueEpics: [{ id: 'E50', title: 'Taxonomy', dirSuffix: 'taxonomy', theme: 'backlog' }],
    stories: [{ id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', feature: 'F-1' }],
    features: [
      { id: 'F-1', title: 'Taxonomy', dirSuffix: 'taxonomy', stories: ['S-1'], theme: 'backlog', epic: 'E50' },
    ],
  });
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.deepEqual(JSON.parse(stdout).findings, []);
  assert.equal(status, 0);
  td.cleanup();
});

test("bl validate reports repo-key on a story or feature that names a repo, naming the story's component and repo", async () => {
  const td = cleanBacklog({
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', dirSuffix: 'one', primary_repo: 'demo-repo', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', dirSuffix: 'two', secondary_repos: ['other'] },
    ],
    features: [{ id: 'F-1', title: 'Feat', dirSuffix: 'feat', primary_repo: 'demo-repo', stories: ['S-1'] }],
  });
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const findings = JSON.parse(stdout).findings;
  const hits = findings.filter((f) => f.code === 'repo-key');
  assert.deepEqual(
    hits.map((f) => [f.severity, f.location, f.message]),
    [
      [
        'error',
        'stories/S1-one/index.md',
        'story sets "primary_repo", which bl does not read: a story\'s repo is its component\'s repo (C00: demo-repo); remove it',
      ],
      [
        'error',
        'stories/S2-two/index.md',
        'story sets "secondary_repos", which bl does not read: a story\'s repo is its component\'s repo (C00: demo-repo); remove it',
      ],
      [
        'error',
        'features/F1-feat/index.md',
        'feature sets "primary_repo", which bl does not read: a feature\'s repos come from its stories\' components; remove it',
      ],
    ],
  );
  assert.ok(!findings.some((f) => f.code === 'unknown-fm-key'), 'a repo key is not also unknown-fm-key');
  td.cleanup();
});

test('bl validate reports feature-theme, feature-epic, epic-theme and theme-repo, each once at the file it names', async () => {
  const td = cleanBacklog({
    themes: [{ id: 'ops', title: 'Ops', repos: ['nowhere'] }],
    valueEpics: [
      { id: 'E50', title: 'Fine', dirSuffix: 'fine' },
      { id: 'E51', title: 'Orphan', dirSuffix: 'orphan', theme: 'ghost' },
    ],
    features: [
      { id: 'F-1', title: 'No theme', dirSuffix: 'no-theme', theme: null },
      { id: 'F-2', title: 'Lost epic', dirSuffix: 'lost-epic', epic: 'E70' },
      { id: 'F-3', title: 'Fine', dirSuffix: 'fine', epic: 'E50' },
    ],
  });
  // An epic's and a theme's own keys are checked like any unit's.
  const e50 = join(td.dir, 'epics', 'E50-fine', 'index.md');
  writeFileSync(e50, readFileSync(e50, 'utf8').replace('theme: demo\n', 'theme: demo\nowner: me\n'));
  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const findings = JSON.parse(stdout).findings;
  const got = findings
    .filter((f) => ['feature-theme', 'feature-epic', 'epic-theme', 'theme-repo'].includes(f.code))
    .map((f) => [f.code, f.location]);
  assert.deepEqual(got, [
    ['feature-theme', 'features/F1-no-theme/index.md'],
    ['feature-epic', 'features/F2-lost-epic/index.md'],
    ['epic-theme', 'epics/E51-orphan/index.md'],
    ['theme-repo', 'themes/ops/index.md'],
  ]);
  assert.ok(
    findings.some((f) => f.code === 'unknown-fm-key' && f.location === 'epics/E50-fine/index.md'),
    stdout,
  );
  td.cleanup();
});

test("bl validate reports frontmatter-yaml at the parser's line and frontmatter-list at the key's; a bad file is not read (F-62 D4)", async () => {
  const td = cleanBacklog({
    stories: [
      { id: 'S-1', component: 'C00', title: 'Fine', dirSuffix: 'fine', status: 'refined' },
      { id: 'S-2', component: 'C00', title: 'Lists', dirSuffix: 'lists', status: 'refined' },
    ],
    features: [
      { id: 'F-1', title: 'Feat', dirSuffix: 'feat', status: 'running', primary_repo: 'demo-repo', branch: 'f1-feat' },
    ],
  });
  // S-3: an unquoted title holding ": " (line 4), and a status that would be bad-status if read.
  mkdirSync(join(td.dir, 'stories', 'S3-colon'), { recursive: true });
  writeFileSync(
    join(td.dir, 'stories', 'S3-colon', 'index.md'),
    '---\ncomponent: C00\nstory_id: S-3\ntitle: S-3: an unquoted colon\ntype: feature\npoints: 1\nstatus: wrong_status\n---\n\n# S-3\n',
  );
  // S-2's list keys as a scalar (line 8) and a mapping (line 9).
  const s2 = join(td.dir, 'stories', 'S2-lists', 'index.md');
  writeFileSync(
    s2,
    readFileSync(s2, 'utf8').replace('status: refined\n', 'status: refined\ndepends_on: S-1\nrequired_for:\n  a: b\n'),
  );
  // F-1's change document is not YAML (a bad indent at line 6): the feature is not read either.
  const change = join(td.dir, 'features', 'F1-feat', 'change.md');
  writeFileSync(change, readFileSync(change, 'utf8').replace('    branch: f1-feat', '   branch: f1-feat'));

  const { stdout, status } = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(status, 1);
  const findings = JSON.parse(stdout).findings;
  const of = (code) => findings.filter((f) => f.code === code).map((f) => [f.location, f.line]);
  assert.deepEqual(of('frontmatter-yaml'), [
    ['stories/S3-colon/index.md', 4],
    ['features/F1-feat/change.md', 6],
  ]);
  assert.match(
    findings.find((f) => f.location === 'stories/S3-colon/index.md').message,
    /^line 4, column \d+: the frontmatter is not YAML \(.+\); the file is not read$/,
  );
  assert.deepEqual(of('frontmatter-list'), [
    ['stories/S2-lists/index.md', 8],
    ['stories/S2-lists/index.md', 9],
  ]);
  assert.match(
    findings.find((f) => f.code === 'frontmatter-list').message,
    /^line 8: "depends_on:" is "S-1", not a list; write a YAML sequence, e.g\. depends_on: \[S-1\]$/,
  );
  const unread = ['stories/S3-colon/index.md', 'features/F1-feat/index.md', 'features/F1-feat/change.md'];
  assert.deepEqual(
    findings.filter((f) => unread.includes(f.location) && f.code !== 'frontmatter-yaml').map((f) => f.code),
    [],
    'nothing else is reported from a file that is not read',
  );

  // Every other command stops at the first such file it reads, naming it and
  // the line or key: its one read of the backlog (`loadBacklog`, F-77 D1)
  // meets S-2's list before S-3.
  const list = await runBl(['list'], { cwd: td.dir });
  assert.equal(list.status, 1);
  assert.match(
    list.stderr,
    /(stories\/S3-colon\/index\.md|features\/F1-feat\/change\.md): frontmatter is not YAML at line [48], column \d+: |stories\/S2-lists\/index\.md: "depends_on:" is "S-1", not a list/,
  );
  td.cleanup();
});

// F-66 D1: story and feature statuses come from flow.json.
test('bl validate takes story and feature statuses from flow.json and reports flow-json (F-66 D1)', async () => {
  const flow = JSON.parse(readFileSync(FLOW_TEMPLATE, 'utf8'));
  const td = cleanBacklog({
    stories: [{ id: 'S-1', component: 'C00', title: 'One', status: 'refined' }],
    features: [{ id: 'F-1', title: 'Feat', status: 'approved', stories: ['S-1'] }],
  });
  const flowPath = join(td.dir, 'flow.json');
  const codes = async () => {
    const { stdout } = await runBl(['validate', '--json'], { cwd: td.dir });
    return JSON.parse(stdout).findings.filter((f) => ['bad-status', 'flow-json'].includes(f.code));
  };

  // Every status flow.json names is accepted.
  assert.deepEqual(await codes(), []);

  // A status the flow file does not name is bad-status, even one bl's code knows.
  const narrowed = structuredClone(flow);
  narrowed.types.story.statuses = narrowed.types.story.statuses.filter((s) => s !== 'refined');
  narrowed.types.feature.statuses = narrowed.types.feature.statuses.filter((s) => s !== 'approved');
  writeFileSync(flowPath, JSON.stringify(narrowed, null, 2));
  assert.deepEqual(
    (await codes()).filter((f) => f.code === 'bad-status').map((f) => [f.code, f.location, f.message]),
    [
      [
        'bad-status',
        'stories/S1/index.md',
        'status "refined" not in known set (flow.json story statuses: draft, in_refinement, in_progress, in_review, fixing, ready_for_merge, escalated, done, superseded)',
      ],
      [
        'bad-status',
        'features/F1/index.md',
        'status "approved" not in known set (flow.json feature statuses: draft, in_refinement, refined, in_progress, in_review, fixing, ready_for_merge, escalated, done, superseded)',
      ],
    ],
  );

  // A status bl's code does not know is accepted once flow.json names it and a verb reaches it.
  const widened = structuredClone(flow);
  widened.types.story.statuses.splice(2, 0, 'parked');
  widened.types.story.verbs.park = { from: ['refined'], success: [{ to: 'parked' }] };
  writeFileSync(flowPath, JSON.stringify(widened, null, 2));
  assert.deepEqual(await codes(), []);

  // flow-json: a then that names no verb of the type.
  const broken = structuredClone(flow);
  broken.types.story.verbs.fix.success[0].then = 'publish';
  writeFileSync(flowPath, JSON.stringify(broken, null, 2));
  const { stdout, status } = await runBl(['validate'], { cwd: td.dir });
  assert.equal(status, 1);
  assert.match(stdout, /flow-json: story verb "fix" chains on success to "publish", which is not a story verb/);

  td.cleanup();
});

test("bl validate stops with the file's name when flow.json is missing or unreadable (F-66 D1)", async () => {
  const td = cleanBacklog({ flow: null });
  const flowPath = join(td.dir, 'flow.json');

  let result = await runBl(['validate'], { cwd: td.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /flow\.json: missing; every backlog needs one \(bl init writes it\)/);
  assert.doesNotMatch(result.stderr, /scanning/);

  writeFileSync(flowPath, '{ nope');
  result = await runBl(['validate'], { cwd: td.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /flow\.json: not valid JSON/);

  writeFileSync(flowPath, JSON.stringify({ schema: 'bl-flow/v1', types: {} }));
  result = await runBl(['validate'], { cwd: td.dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /flow\.json: no "story" type in "types"/);

  td.cleanup();
});

test('bl validate reports each blockers-* finding on a hand-edited blockers.json (F-66 D5)', async () => {
  const td = cleanBacklog({
    stories: [
      { id: 'S-1', component: 'C00', title: 'One' },
      { id: 'S-2', component: 'C00', title: 'Two' },
      { id: 'S-3', component: 'C00', title: 'Three', status: 'done' },
    ],
  });
  const lines = [
    `{"blocker":"S-2","gate":"run","unit":"S-1","until":"done"}`,
    `{"blocker":"S-1","gate":"run","unit":"S-2","until":"done"}`,
    `{"blocker":"S-99","gate":"run","unit":"S-1","until":"done"}`,
    `{"blocker":"S-2","gate":"deploy","unit":"S-1","until":"done"}`,
    `{"blocker":"S-2","gate":"merge","unit":"S-1","until":"shipped"}`,
    `{"blocker":"S-2","gate":"run","unit":"S-1","until":"done"}`,
    `{"blocker":"S-3","gate":"merge","unit":"S-1","until":"superseded"}`,
  ];
  const path = join(td.dir, 'blockers.json');
  writeFileSync(path, `{"schema":"bl-blockers/v1","edges":[\n${lines.join(',\n')}\n]}\n`);
  let result = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(result.status, 1);
  const codes = JSON.parse(result.stdout)
    .findings.filter((f) => f.location === 'blockers.json')
    .map((f) => `${f.severity} ${f.code}`)
    .sort();
  assert.deepEqual(codes, [
    'error blockers-cycle',
    'error blockers-duplicate',
    'error blockers-gate',
    'error blockers-status',
    'error blockers-unit',
    'error blockers-unmeetable',
    'warning blockers-order',
  ]);

  writeFileSync(path, `{"schema":"bl-blockers/v0","edges":[]}`);
  result = await runBl(['validate', '--json'], { cwd: td.dir });
  const json = JSON.parse(result.stdout).findings.filter((f) => f.location === 'blockers.json');
  assert.deepEqual(
    json.map((f) => [f.code, f.message]),
    [['blockers-json', `"schema" is "bl-blockers/v0", not "bl-blockers/v1" or "bl-blockers/v2"`]],
  );
  td.cleanup();
});

test('bl validate reports a bad merge edge and a cycle of merge edges with the existing codes (F-111 D1)', async () => {
  // F-1 over S-1 (demo-repo) and S-2 (ci-cd), F-2 over S-3 (demo-repo).
  const td = cleanBacklog({
    repos: ['../ci-cd'],
    components: [{ id: 'C01', title: 'Ci', dirSuffix: 'ci', repo: 'ci-cd' }],
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', feature: 'F-1' },
      { id: 'S-2', component: 'C01', title: 'Two', feature: 'F-1' },
      { id: 'S-3', component: 'C00', title: 'Three', feature: 'F-2' },
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', stories: ['S-1', 'S-2'] },
      { id: 'F-2', title: 'Two', status: 'approved', stories: ['S-3'] },
    ],
  });
  const m = (blocker, unit, gate = 'merge', until = 'merged') => ({ blocker, gate, unit, until });
  writeBlockersLocked(td.dir, [
    m('F-1:ci-cd', 'F-1:demo-repo'),
    m('F-1:demo-repo', 'F-1:ci-cd'),
    m('F-2:demo-repo', 'F-1:ci-cd'),
    m('F-1:app', 'F-1:demo-repo'),
    m('F-2:demo-repo', 'F-2:demo-repo', 'run'),
    m('F-1:ci-cd', '*', 'merge', 'done'),
  ]);
  const result = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(result.status, 1);
  const findings = JSON.parse(result.stdout)
    .findings.filter((f) => f.location === 'blockers.json')
    .map((f) => `${f.code}: ${f.message}`)
    .sort();
  assert.deepEqual(findings, [
    `blockers-cycle: merge order cycle: F-1:ci-cd → F-1:demo-repo (merge edge F-1:demo-repo → F-1:ci-cd) → F-1:ci-cd (merge edge F-1:ci-cd → F-1:demo-repo)`,
    `blockers-cycle: merge order cycle: F-2:demo-repo → F-2:demo-repo (merge edge F-2:demo-repo → F-2:demo-repo)`,
    `blockers-gate: F-2:demo-repo at run by F-2:demo-repo: a merge edge's gate is "merge", not "run"`,
    `blockers-status: * at merge by F-1:ci-cd: a merge edge's until is "merged", not "done"`,
    `blockers-unit: * at merge by F-1:ci-cd: a merge edge's unit is never "*"`,
    `blockers-unit: F-1:ci-cd at merge by F-2:demo-repo: a merge edge joins two repos of one feature, not of F-2 and F-1`,
    `blockers-unit: F-1:demo-repo at merge by F-1:app: blocker F-1:app: no story of F-1 names repo app`,
  ]);
  td.cleanup();
});

test('bl validate reports a bad order edge and a cycle of order edges with the existing codes (F-111 D1, D4)', async () => {
  // F-1 over S-1, S-2 and S-4, F-2 over S-3; S-5 is in no feature. S-4 depends_on S-1 by its key.
  const td = cleanBacklog({
    stories: [
      { id: 'S-1', component: 'C00', title: 'One', feature: 'F-1' },
      { id: 'S-2', component: 'C00', title: 'Two', feature: 'F-1' },
      { id: 'S-3', component: 'C00', title: 'Three', feature: 'F-2' },
      { id: 'S-4', component: 'C00', title: 'Four', feature: 'F-1', depends_on: ['S-1'] },
      { id: 'S-5', component: 'C00', title: 'Five' },
    ],
    features: [
      { id: 'F-1', title: 'One', status: 'approved', stories: ['S-1', 'S-2', 'S-4'] },
      { id: 'F-2', title: 'Two', status: 'approved', stories: ['S-3'] },
    ],
  });
  const o = (blocker, unit, until = 'implemented') => ({ blocker, gate: 'order', unit, until });
  writeBlockersLocked(td.dir, [
    o('S-1', 'S-2'),
    o('S-3', 'S-2'),
    o('S-5', 'S-1'),
    o('S-4', 'S-2', 'done'),
    // With S-4's key (S-1 → S-4), a cycle S-1 → S-4 → S-1.
    o('S-4', 'S-1'),
  ]);
  const result = await runBl(['validate', '--json'], { cwd: td.dir });
  assert.equal(result.status, 1);
  const findings = JSON.parse(result.stdout).findings;
  assert.deepEqual(
    findings
      .filter((f) => f.location === 'blockers.json')
      .map((f) => `${f.code}: ${f.message}`)
      .sort(),
    [
      'blockers-cycle: story order cycle: S-1 → S-4 (order edge S-4 → S-1) → S-1 (order edge S-1 → S-4)',
      `blockers-status: S-2 at order by S-4: an order edge's until is "implemented", not "done"`,
      'blockers-unit: S-1 at order by S-5: blocker S-5 is in no feature or batch',
      'blockers-unit: S-2 at order by S-3: an order edge joins two stories of one feature or batch, not of F-2 and F-1',
    ],
  );
  assert.deepEqual(
    findings.filter((f) => f.code === 'depends-on-key').map((f) => [f.severity, f.location]),
    [['warning', 'stories/S4/index.md']],
  );
  td.cleanup();
});
