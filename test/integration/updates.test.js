import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../src/config.js';
import { lookupPr, NO_REPORT_MESSAGE } from '../../src/updates.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { runBl } from '../helpers/run-bl.js';

function setup(extra = {}) {
  const { dir, cleanup } = mkTempBacklog({
    repos: ['repos/tools'],
    components: [{ id: 'C31', title: 'Tools', dirSuffix: 'tools', repo: 'tools', home: true }],
  });
  const cfgPath = join(dir, 'backlog.json');
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...raw, updates: { namespace: 'roost-cc' }, ...extra }, null, 2));
  mkdirSync(join(dir, 'repos', 'tools'), { recursive: true });
  return { dir, cleanup };
}

test('bl updates sync with no report file exits 0 and says so', () => {
  const { dir, cleanup } = setup();
  try {
    const r = runBl(['updates', 'sync', '--report', join(dir, 'none.json')], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(NO_REPORT_MESSAGE));
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('bl updates sync with no updates.report and no --report refuses naming the key', () => {
  const { dir, cleanup } = setup();
  try {
    const r = runBl(['updates', 'sync'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bl updates sync: backlog\.json has no "updates": \{ "report": "<path>" \}/);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('bl updates sync creates stories from a report and prints one line each', () => {
  const { dir, cleanup } = setup();
  try {
    const report = join(dir, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        repositories: {
          'roost-cc/tools': {
            branches: [
              {
                branchName: 'renovate/lock-file-maintenance',
                prNo: 36,
                prTitle: 'chore(deps): lock file maintenance',
                result: 'done',
                upgrades: [{ packageFile: 'package.json', updateType: 'lockFileMaintenance' }],
              },
            ],
          },
        },
      }),
    );
    const dry = runBl(['updates', 'sync', '--report', report, '--dry-run'], { cwd: dir });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(
      dry.stdout,
      /^created\s+S-1\s+roost-cc\/tools renovate\/lock-file-maintenance #36 {2}chore\(deps\): lock file maintenance\n$/,
    );
    assert.match(dry.stderr, /dry run: nothing written/);

    const r = runBl(['updates', 'sync', '--report', report], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^created\s+S-1\s+/);
    assert.match(r.stderr, /updates sync: 1 created, 0 updated, 0 closed, 0 unchanged/);
    // No git repo here: the sync ran, the commit was skipped.
    assert.match(r.stderr, /not a git repository; skipping commit/);
    const story = readFileSync(join(dir, 'stories', 'S1-chore-deps-lock-file-maintenance', 'index.md'), 'utf8');
    assert.match(story, /^update_pr: 36$/m);
    assert.match(story, /^status: refined$/m);

    const again = runBl(['updates', 'sync', '--report', report], { cwd: dir });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^unchanged\s+S-1\s+/);

    // The story is what `bl updates run` would take.
    const dryRun = runBl(['updates', 'run', '--dry-run'], { cwd: dir });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(
      dryRun.stdout,
      /^would run S-1 {4}roost-cc\/tools renovate\/lock-file-maintenance #36 {2}gate, merge when green\n$/,
    );
    assert.match(dryRun.stderr, /dry run: nothing written/);
  } finally {
    cleanup();
  }
});

test("bl updates: help, missing verb, unknown verb, the verbs' argument errors", () => {
  const { dir, cleanup } = setup();
  try {
    assert.equal(runBl(['updates', '--help'], { cwd: dir }).status, 0);
    assert.match(runBl(['updates', 'sync', '--help'], { cwd: dir }).stdout, /--report <path>/);
    assert.match(runBl(['updates', '--help'], { cwd: dir }).stdout, /--reason <text>/);
    assert.equal(runBl(['updates'], { cwd: dir }).status, 1);
    const unknown = runBl(['updates', 'frobnicate'], { cwd: dir });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown verb 'frobnicate'/);
    // status: nothing open, no report yet; --json says the same.
    const status = runBl(['updates', 'status'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, 'no open update stories\n\nno report yet\n');
    const json = runBl(['updates', 'status', '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { stories: [], last_report: null });
    // approve and drop: usage, then an id that is not an update story.
    const approveNoId = runBl(['updates', 'approve'], { cwd: dir });
    assert.equal(approveNoId.status, 1);
    assert.match(approveNoId.stderr, /Usage: bl updates approve S-<n>/);
    const approveMissing = runBl(['updates', 'approve', 'S-42'], { cwd: dir });
    assert.equal(approveMissing.status, 1);
    assert.match(approveMissing.stderr, /S-42 is not an update story/);
    const dropNoReason = runBl(['updates', 'drop', 'S-42'], { cwd: dir });
    assert.equal(dropNoReason.status, 1);
    assert.match(dropNoReason.stderr, /Usage: bl updates drop S-<n> --reason <text>/);
    const dropMissing = runBl(['updates', 'drop', 'S-42', '--reason', 'x'], { cwd: dir });
    assert.equal(dropMissing.status, 1);
    assert.match(dropMissing.stderr, /S-42 is not an update story/);
    // run: nothing open ends at once; a bad flag or id is an error.
    const run = runBl(['updates', 'run'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /no open update stories/);
    assert.equal(run.stdout, '');
    const bad = runBl(['updates', 'run', '--max-merges', 'x'], { cwd: dir });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--max-merges requires a positive integer/);
    const missing = runBl(['updates', 'run', 'S-42'], { cwd: dir });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /S-42 is not an update story/);
  } finally {
    cleanup();
  }
});

test('bl updates status and a drop request the run executes, over a synced story', () => {
  const { dir, cleanup } = setup({
    forge: 'fake',
    plugins: { fake: { 'change.close': 'echo closed {{number}}: {{comment}}' } },
  });
  try {
    const report = join(dir, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        repositories: {
          'roost-cc/tools': {
            branches: [
              {
                branchName: 'renovate/glob-11.x',
                prNo: 8,
                prTitle: 'chore(deps): update dependency glob to v11.0.3',
                result: 'done',
                upgrades: [
                  {
                    depName: 'glob',
                    datasource: 'npm',
                    currentValue: '11.0.2',
                    newValue: '11.0.3',
                    updateType: 'patch',
                    packageFile: 'package.json',
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    assert.equal(runBl(['updates', 'sync', '--report', report], { cwd: dir }).status, 0);
    const status = runBl(['updates', 'status'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      status.stdout,
      'tools (1)\n  S-1  new  patch  #8  chore(deps): update dependency glob to v11.0.3\n\nno report yet\n',
    );
    const json = JSON.parse(runBl(['updates', 'status', '--json'], { cwd: dir }).stdout);
    assert.equal(json.stories.length, 1);
    assert.deepEqual(
      [json.stories[0].id, json.stories[0].repo, json.stories[0].state, json.stories[0].types, json.stories[0].pr],
      ['S-1', 'tools', 'new', ['patch'], '8'],
    );
    assert.equal(json.last_report, null);

    // The drop is a request: nothing closed, the story pending.
    const drop = runBl(['updates', 'drop', 'S-1', '--reason', 'glob 11.0.3 is broken on node 24'], { cwd: dir });
    assert.equal(drop.status, 0, drop.stderr);
    assert.match(
      drop.stdout,
      /^requested S-1 {4}roost-cc\/tools renovate\/glob-11\.x #8 {2}drop: glob 11\.0\.3 is broken on node 24\n$/,
    );
    assert.match(
      drop.stderr,
      /updates drop: S-1 requested; the runner closes PR #8 and supersedes the story on its next bl updates run/,
    );
    const pending = runBl(['updates', 'status'], { cwd: dir });
    assert.match(
      pending.stdout,
      /^ {2}S-1 {2}drop pending {2}patch {2}#8 {2}.* · waiting on the runner's next bl updates run: glob 11\.0\.3 is broken on node 24$/m,
    );

    // The run executes it.
    const run = runBl(['updates', 'run'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      /^dropped {3}S-1 {4}roost-cc\/tools renovate\/glob-11\.x #8 {2}PR closed: glob 11\.0\.3 is broken on node 24\n$/,
    );
    assert.match(run.stderr, /updates run: 0 merged, 1 dropped, 0 held/);
    const story = readFileSync(
      join(dir, 'stories', 'S1-chore-deps-update-dependency-glob-to-v11-0-3', 'index.md'),
      'utf8',
    );
    assert.match(story, /^status: superseded$/m);
    assert.match(story, /dropped by the operator: glob 11\.0\.3 is broken on node 24\. PR #8 closed\./);
    const after = runBl(['updates', 'status'], { cwd: dir });
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /^no open update stories\n\nlast report: updates\/\d{4}-\d{2}-\d{2}\.md · Run /);
    // A dropped story is not dropped twice, and not approved.
    const again = runBl(['updates', 'drop', 'S-1', '--reason', 'x'], { cwd: dir });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /S-1 is superseded/);
    const approve = runBl(['updates', 'approve', 'S-1'], { cwd: dir });
    assert.equal(approve.status, 1);
    assert.match(approve.stderr, /S-1 is superseded/);
  } finally {
    cleanup();
  }
});

test("lookupPr reads the PR's url and security label through change.find", () => {
  const { dir, cleanup } = setup({
    forge: 'fake',
    plugins: {
      fake: {
        'change.find': 'echo \'[{"number":5,"url":"https://x/5","labels":[{"name":"renovate"},{"name":"security"}]}]\'',
      },
    },
  });
  try {
    const cfg = loadConfig({ backlogRoot: dir });
    const repoPath = join(dir, 'repos', 'tools');
    assert.deepEqual(lookupPr(cfg, repoPath, 'renovate/x'), { url: 'https://x/5', security: true });
  } finally {
    cleanup();
  }
});

test('lookupPr without a forge, or with a failing op, yields no url and no label', () => {
  const plain = setup();
  const failing = setup({
    forge: 'fake',
    plugins: { fake: { 'change.find': "echo '[]'; exit 1" } },
  });
  const garbage = setup({
    forge: 'fake',
    plugins: { fake: { 'change.find': "echo 'not json'" } },
  });
  try {
    for (const t of [plain, failing, garbage]) {
      const cfg = loadConfig({ backlogRoot: t.dir });
      assert.deepEqual(lookupPr(cfg, join(t.dir, 'repos', 'tools'), 'renovate/x'), { url: null, security: false });
    }
  } finally {
    plain.cleanup();
    failing.cleanup();
    garbage.cleanup();
  }
});
