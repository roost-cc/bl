import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runBl } from '../helpers/run-bl.js';
import { GIT_ENV, git, headFiles, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import {
  NEW_IN_C01,
  componentBacklog,
  fmOf,
  gitEdgeBacklog,
  gitNewBacklog,
  writeSpec,
} from '../helpers/new-fixture.js';
import { formatBlockers, parseBlockers } from '../../src/blockers.js';

// F-111 D5: a dependency is an edge in blockers.json, never a key. `bl new
// --depends-on` / `--required-for` and a spec's `depends_on` / `required_for`
// write an order edge between two stories of one feature, else a run edge, in
// the commit of the new stories; a story that joins a feature has its run
// edges with the feature's stories turned into order edges.

/** blockers.json's edges as `blocker gate unit until`, or null when there is no file. */
const edgesOf = (dir) => {
  const path = join(dir, 'blockers.json');
  if (!existsSync(path)) return null;
  return parseBlockers(readFileSync(path, 'utf8')).map((e) => `${e.blocker} ${e.gate} ${e.unit} ${e.until}`);
};

/** A spec in `dir`/plan; its path. */
function spec(dir, body) {
  mkdirSync(join(dir, 'plan'), { recursive: true });
  writeFileSync(join(dir, 'plan', 'a.md'), '## Summary\n\nA.\n');
  const path = join(dir, 'plan', 'spec.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

test('bl new --depends-on and --required-for write run edges outside a feature, in the commit, and no depends_on:', () => {
  const { dir, cleanup } = gitEdgeBacklog();
  try {
    const r = runBl([...NEW_IN_C01, '--title', 'First', '--depends-on', 'S-1', '--required-for', 'S-2,S-404'], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'stories/S3-first/index.md');
    assert.match(r.stderr, /^warning: required_for S-404 does not match any existing story; no edge written$/m);
    // S-3 is in no feature: both edges are run edges, though S-1 is in F-1.
    assert.deepEqual(edgesOf(dir), ['S-3 run S-2 done', 'S-1 run S-3 done']);
    const created = fmOf(dir, 'stories/S3-first/index.md');
    assert.equal(Object.hasOwn(created, 'depends_on'), false, 'no depends_on: on the new story');
    assert.equal(Object.hasOwn(created, 'required_for'), false, 'no required_for: on the new story');
    assert.equal(Object.hasOwn(fmOf(dir, 'stories/S1-later/index.md'), 'depends_on'), false);
    assert.equal(Object.hasOwn(fmOf(dir, 'stories/S2-also-later/index.md'), 'depends_on'), false);

    const files = headFiles(dir);
    assert.ok(files.includes('A\tstories/S3-first/index.md'), files.join('\n'));
    assert.ok(files.includes('A\tblockers.json'), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('S1-later') || f.includes('S2-also-later')), files.join('\n'));
    assert.deepEqual(statusLines(dir), []);

    const tree = runBl(['tree', 'S-2'], { cwd: dir });
    assert.equal(tree.status, 0, tree.stderr);
    assert.match(tree.stdout, /S-3 First/);
  } finally {
    cleanup();
  }
});

test('bl new F-1 --depends-on writes an order edge to a story of F-1 and a run edge to one outside it', () => {
  const { dir, cleanup } = gitEdgeBacklog();
  try {
    const r = runBl(['new', 'F-1', 'C01', '--points', '1', '--title', 'Second', '--depends-on', 'S-1,S-2'], {
      cwd: dir,
      env: GIT_ENV,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(edgesOf(dir), ['S-1 order S-3 implemented', 'S-2 run S-3 done']);
    assert.equal(Object.hasOwn(fmOf(dir, 'stories/S3-second/index.md'), 'depends_on'), false);
    assert.ok(headFiles(dir).includes('A\tblockers.json'), headFiles(dir).join('\n'));
  } finally {
    cleanup();
  }
});

test("a spec's depends_on and required_for write order edges inside its feature and run edges outside it", () => {
  const { dir, cleanup } = gitEdgeBacklog();
  try {
    const specPath = spec(dir, {
      component: 'C01',
      feature: 'F-1',
      stories: [
        { id: 'base', title: 'Base', points: 1, body_file: 'a.md', required_for: ['@top', 'S-1', 'S-404'] },
        { id: 'top', title: 'Top', points: 2, body_file: 'a.md', depends_on: ['S-2'] },
      ],
    });
    const r = runBl(['new', '--from', specPath], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^warning: required_for S-404 does not match any existing story; no edge written$/m);
    assert.match(r.stderr, /^ {4}S-4 at order by S-3 until implemented$/m, 'the plan names each edge');
    assert.deepEqual(edgesOf(dir), ['S-3 order S-1 implemented', 'S-2 run S-4 done', 'S-3 order S-4 implemented']);
    for (const p of ['stories/S3-base/index.md', 'stories/S4-top/index.md']) {
      assert.equal(Object.hasOwn(fmOf(dir, p), 'depends_on'), false, p);
      assert.equal(Object.hasOwn(fmOf(dir, p), 'required_for'), false, p);
    }

    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-3, S-4');
    const files = headFiles(dir);
    assert.ok(files.includes('A\tblockers.json'), files.join('\n'));
    assert.ok(!files.some((f) => f.includes('S1-later')), files.join('\n'));
    assert.deepEqual(
      statusLines(dir).filter((l) => !l.includes('plan/')),
      [],
    );
  } finally {
    cleanup();
  }
});

// new_edge_refused_is_retryable: an edge bl block add would refuse (here one
// that closes a deadlock) undoes the new stories and leaves blockers.json as
// it was, so the same command, the cause fixed, gets the same id.
for (const [name, bad, good] of [
  [
    '--depends-on and --required-for',
    () => [...NEW_IN_C01, '--title', 'First', '--depends-on', 'S-2', '--required-for', 'S-2'],
    () => [...NEW_IN_C01, '--title', 'First', '--depends-on', 'S-2'],
  ],
  [
    "a spec's depends_on and required_for",
    (dir) => [
      'new',
      '--from',
      spec(dir, {
        component: 'C01',
        stories: [
          { id: 'base', title: 'First', points: 1, body_file: 'a.md', depends_on: ['S-2'], required_for: ['S-2'] },
        ],
      }),
    ],
    (dir) => [
      'new',
      '--from',
      spec(dir, {
        component: 'C01',
        stories: [{ id: 'base', title: 'First', points: 1, body_file: 'a.md', depends_on: ['S-2'] }],
      }),
    ],
  ],
]) {
  test(`new_edge_refused_is_retryable: ${name}`, () => {
    const { dir, cleanup } = gitEdgeBacklog();
    try {
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = runBl(bad(dir), { cwd: dir, env: GIT_ENV });
      assert.equal(r.status, 1, r.stderr);
      assert.match(
        r.stderr,
        /could not write the edges to blockers\.json \(.*would close a deadlock.*\); nothing is written or committed: the new stories are removed, so bl new can run again/,
      );
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.equal(existsSync(join(dir, 'stories', 'S3-first')), false);
      assert.equal(edgesOf(dir), null, 'no blockers.json, as before');
      assert.deepEqual(
        statusLines(dir).filter((l) => !l.includes('plan/')),
        [],
      );

      const again = runBl(good(dir), { cwd: dir, env: GIT_ENV });
      assert.equal(again.status, 0, again.stderr);
      assert.ok(existsSync(join(dir, 'stories', 'S3-first')));
      assert.deepEqual(edgesOf(dir), ['S-2 run S-3 done']);
    } finally {
      cleanup();
    }
  });
}

/** A git-backed backlog: S-1 and S-2 in no feature, F-1 empty, and the run edge S-1 → S-2 in blockers.json. */
function gitJoinBacklog() {
  const t = componentBacklog({
    stories: [
      { id: 'S-1', component: 'C01', title: 'One', dirSuffix: 'one' },
      { id: 'S-2', component: 'C01', title: 'Two', dirSuffix: 'two' },
    ],
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites' }],
  });
  writeFileSync(
    join(t.dir, 'blockers.json'),
    formatBlockers([{ blocker: 'S-1', gate: 'run', unit: 'S-2', until: 'done' }]),
  );
  initGitBacklog(t.dir);
  return t;
}

// A story that joins a feature has each run edge between it and a story of
// that feature turned into an order edge, in the same commit (F-111 D5).
for (const [name, steps, subject] of [
  [
    'bl attach, one story after the other',
    [
      ['attach', 'S-1', 'F-1'],
      ['attach', 'S-2', 'F-1'],
    ],
    'chore: attach S-2 to F-1',
  ],
  [
    'bl new --feature with both stories',
    [['new', '--feature', '--theme', 'demo', '--title', 'Pair', 'S-1', 'S-2']],
    'chore: add F-2',
  ],
]) {
  test(`a story that joins a feature turns its run edges with the feature's stories into order edges: ${name}`, () => {
    const { dir, cleanup } = gitJoinBacklog();
    try {
      for (const [i, args] of steps.entries()) {
        const r = runBl(args, { cwd: dir, env: GIT_ENV });
        assert.equal(r.status, 0, r.stderr);
        // Until both stories are in the feature, the edge stays a run edge.
        if (i < steps.length - 1) assert.deepEqual(edgesOf(dir), ['S-1 run S-2 done']);
      }
      assert.deepEqual(edgesOf(dir), ['S-1 order S-2 implemented']);
      assert.equal(git(dir, 'log', '-1', '--format=%s'), subject);
      assert.ok(headFiles(dir).includes('M\tblockers.json'), headFiles(dir).join('\n'));
      assert.deepEqual(statusLines(dir), []);
      const v = runBl(['validate', '--json'], { cwd: dir });
      const codes = JSON.parse(v.stdout).findings.map((f) => f.code);
      assert.ok(!codes.includes('blockers-cycle'), codes.join(', '));
    } finally {
      cleanup();
    }
  });
}

test("bl new --from commits every story of the batch in one commit, each in its component's repo", () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const specPath = writeSpec(dir);
    const r = runBl(['new', '--from', specPath], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);

    assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add S-2, S-3');
    const files = headFiles(dir);
    assert.ok(files.includes('A\tstories/S2-alpha/index.md'), files.join('\n'));
    assert.ok(files.includes('A\tstories/S3-bravo/index.md'), files.join('\n'));
    // The spec files the operator wrote are theirs to commit or discard.
    assert.ok(!files.some((f) => f.includes('plan/')), files.join('\n'));
    const a = fmOf(dir, 'stories/S2-alpha/index.md');
    const b = fmOf(dir, 'stories/S3-bravo/index.md');
    assert.deepEqual([a.component, a.primary_repo], ['C01', undefined]);
    assert.deepEqual([b.component, b.primary_repo], ['C02', undefined]);
  } finally {
    cleanup();
  }
});

test('bl new --from --dry-run makes no commit', () => {
  const { dir, cleanup } = gitNewBacklog();
  try {
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runBl(['new', '--from', writeSpec(dir), '--dry-run'], { cwd: dir, env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  } finally {
    cleanup();
  }
});
