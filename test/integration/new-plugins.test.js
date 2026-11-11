import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { lockOwnerVisible, runBl, startBlBehindLock } from '../helpers/run-bl.js';
import { parseFrontmatter } from '../../src/config.js';
import { componentBacklog } from '../helpers/new-fixture.js';

// ---------------------------------------------------------------------------
// --plugins-from <S-id> (S-870): inherit plugins / plugins-<stage> keys
// ---------------------------------------------------------------------------

const PLUGIN_KEYS = 'plugins-test: [bl-tests]\nplugins-lint: [-foo]\n';
const SOURCE = 'stories/S1-parent/index.md';
const CHILD = 'stories/S2-child/index.md';

/**
 * componentBacklog() with S-1 in `component` (default C01, alpha): S-1's repo
 * is its component's. `extraFm` lines are spliced into S-1's frontmatter (the
 * fixture template has no slot for plugin keys).
 */
function pluginsBacklog({ extraFm = PLUGIN_KEYS, component = 'C01', features = [] } = {}) {
  const t = componentBacklog({
    features,
    stories: [
      {
        id: 'S-1',
        component,
        title: 'Parent',
        dirSuffix: 'parent',
      },
    ],
  });
  const sourceIndex = join(t.dir, SOURCE);
  const text = readFileSync(sourceIndex, 'utf8');
  writeFileSync(sourceIndex, text.replace(/\n---\n/, `\n${extraFm}---\n`));
  return t;
}

const NEW_CHILD = ['new', '--title', 'Child', '--points', '1'];
const childFrontmatter = (dir) => readFileSync(join(dir, CHILD), 'utf8').match(/^---\n[\s\S]*?\n---\n/)[0];

test('bl new --plugins-from copies plugins-* keys verbatim from a same-repo story', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    const r = runBl([...NEW_CHILD, 'C03', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), CHILD);
    const fmText = childFrontmatter(dir);
    assert.ok(fmText.includes(PLUGIN_KEYS), fmText);
    assert.doesNotMatch(fmText, /^primary_repo:/m);
    const { fm } = parseFrontmatter(fmText + '\n');
    assert.equal(fm.component, 'C03');
    assert.deepEqual(fm['plugins-test'], ['bl-tests']);
    assert.deepEqual(fm['plugins-lint'], ['-foo']);
    assert.doesNotMatch(r.stderr, /not copied/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from accepts a lowercase id and copies list values as sequences', () => {
  // A flow list and a block list both come through the parsed object, so the
  // new block writes each as a flow sequence (F-62 D3), at the block's end.
  const listFm = 'plugins: [a, b]\nplugins-test:\n  - bl-tests\n  - extra\nplugins-lint: [-foo]\n';
  const { dir, cleanup } = pluginsBacklog({ extraFm: listFm });
  try {
    const r = runBl([...NEW_CHILD, '--plugins-from', 's-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fmText = childFrontmatter(dir);
    const written = 'plugins: [a, b]\nplugins-test: [bl-tests, extra]\nplugins-lint: [-foo]\n';
    assert.ok(fmText.includes(`added: ${new Date().toISOString().slice(0, 10)}\n${written}`), fmText);
  } finally {
    cleanup();
  }
});

// S-878, F-49 D4: a --plugins-from child with no component takes its
// parent's component, so merge-triage follow-ups keep the component, its
// repo and the plugins.
test("bl new --plugins-from with no component takes the source's component and copies its plugins", () => {
  const { dir, cleanup } = pluginsBacklog({ component: 'C02' });
  try {
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fmText = childFrontmatter(dir);
    assert.match(fmText, /^component: C02$/m);
    assert.ok(fmText.includes(PLUGIN_KEYS), fmText);
    assert.doesNotMatch(r.stderr, /not copied/);
  } finally {
    cleanup();
  }
});

test("bl new --plugins-from: the source's component comes before the feature's repo", () => {
  const { dir, cleanup } = pluginsBacklog({
    component: 'C02',
    features: [{ id: 'F-1', title: 'Invites', dirSuffix: 'invites', primary_repo: 'alpha' }],
  });
  try {
    const r = runBl([...NEW_CHILD, '--feature', 'F-1', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const fmText = childFrontmatter(dir);
    assert.match(fmText, /^component: C02$/m);
    assert.ok(fmText.includes(`feature: F-1\n${PLUGIN_KEYS}`), fmText);
    assert.doesNotMatch(r.stderr, /not copied/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from with a component in another repo copies nothing and warns', () => {
  for (const args of [['C02'], ['--repo', 'beta']]) {
    const { dir, cleanup } = pluginsBacklog();
    try {
      const r = runBl([...NEW_CHILD, ...args, '--plugins-from', 'S-1'], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      const fmText = childFrontmatter(dir);
      assert.doesNotMatch(fmText, /^plugins/m, fmText);
      assert.match(fmText, /^component: C02$/m);
      assert.doesNotMatch(fmText, /^primary_repo:/m);
      const warning = r.stderr.split('\n').filter((l) => l.includes('not copied'));
      assert.equal(warning.length, 1, r.stderr);
      assert.match(warning[0], /--plugins-from S-1: repo alpha differs from beta; plugins not copied/);
    } finally {
      cleanup();
    }
  }
});

test('bl new --plugins-from treats a source whose component has no repo as a different repo, whatever primary_repo it names', () => {
  // S-1's component C77 does not exist, so S-1 has no repo; its leftover primary_repo is not read.
  const { dir, cleanup } = pluginsBacklog({ component: 'C77', extraFm: `primary_repo: alpha\n${PLUGIN_KEYS}` });
  try {
    const r = runBl([...NEW_CHILD, 'C01', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(childFrontmatter(dir), /^plugins/m);
    assert.match(r.stderr, /repo \(none\) differs from alpha; plugins not copied/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from finds a done source', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    const p = join(dir, SOURCE);
    writeFileSync(p, readFileSync(p, 'utf8').replace('status: draft\n', 'status: done\n'));
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(childFrontmatter(dir).includes(PLUGIN_KEYS), childFrontmatter(dir));
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from with a source that has no plugins keys is silent', () => {
  const { dir, cleanup } = pluginsBacklog({ extraFm: '' });
  try {
    const r = runBl([...NEW_CHILD, 'C02', '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(childFrontmatter(dir), /^plugins/m);
    assert.doesNotMatch(r.stderr, /plugins/);
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from with an unknown id fails before writing anything', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-999'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--plugins-from S-999: story not found/);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(join(dir, 'stories')), ['S1-parent']);
    assert.ok(!existsSync(join(dir, '.bl-new.lock')), 'lock file left behind');
  } finally {
    cleanup();
  }
});

test('bl new --plugins-from without a value or with a bad id is rejected', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    let r = runBl([...NEW_CHILD, '--plugins-from'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--plugins-from requires a story id/);
    r = runBl([...NEW_CHILD, '--plugins-from', 'C01'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /invalid --plugins-from story id: 'C01'/);
    assert.ok(!existsSync(join(dir, CHILD)));
  } finally {
    cleanup();
  }
});

test('bl new --from rejects --plugins-from like the other per-story flags', () => {
  const { dir, cleanup } = pluginsBacklog();
  try {
    for (const flag of ['--plugins-from', '--component']) {
      const r = runBl(['new', '--from', 'plan.json', flag, flag === '--component' ? 'C01' : 'S-1'], { cwd: dir });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`${flag} is not allowed with --from`));
    }
  } finally {
    cleanup();
  }
});

test("bl new --plugins-from preserves the accepted story ID's digit sequence", () => {
  // `normalizeId` keeps the digits as written, so the flag resolves the
  // `story_id` byte for byte: leading zeroes and long digit runs are not
  // collapsed through a number, and `S-01` never stands in for `S-1`.
  const cases = [
    { storyId: 'S-01', flag: 'S-01', copied: true },
    { storyId: 'S-01', flag: 's01', copied: true },
    { storyId: 'S-01', flag: 'S-1', copied: false },
    { storyId: 'S-1', flag: 'S-01', copied: false },
    { storyId: 'S-00000000000000000001', flag: 'S-00000000000000000001', copied: true },
    { storyId: 'S-00000000000000000001', flag: 'S-1', copied: false },
  ];
  for (const { storyId, flag, copied } of cases) {
    const { dir, cleanup } = pluginsBacklog();
    try {
      const sourceIndex = join(dir, SOURCE);
      writeFileSync(
        sourceIndex,
        readFileSync(sourceIndex, 'utf8').replace('story_id: S-1\n', `story_id: ${storyId}\n`),
      );
      const r = runBl([...NEW_CHILD, '--plugins-from', flag], { cwd: dir });
      const label = `story_id ${storyId}, --plugins-from ${flag}: ${r.stderr}`;
      if (copied) {
        assert.equal(r.status, 0, label);
        assert.ok(childFrontmatter(dir).includes(PLUGIN_KEYS), label);
      } else {
        assert.equal(r.status, 1, label);
        assert.match(r.stderr, /story not found/, label);
        assert.ok(!existsSync(join(dir, CHILD)), label);
      }
    } finally {
      cleanup();
    }
  }
});

/**
 * Hold the backlog lock from this process, start `bl <args>`, wait until
 * it reports being blocked on our lock (`Waiting for lock … held by pid
 * <ours>…`, which `acquireLock` says once and only after every pre-lock
 * step has run), run `mutate`, then release the lock and return the
 * finished run. Synchronising on that line rather than on a delay means
 * the mutation always lands after the pre-lock lookup, so the run can
 * only pass through the under-lock reread. What `bl new` copies must
 * reflect the mutated state: that is what reading under the lock buys.
 */
async function runBlBehindLock(dir, args, mutate) {
  const lock = join(dir, '.bl-new.lock');
  writeFileSync(lock, `${process.pid}\n${new Date().toISOString()}\n`);
  const { blocked, closed } = startBlBehindLock(args, { cwd: dir });
  try {
    await blocked;
    mutate();
  } finally {
    unlinkSync(lock);
  }
  return closed;
}

test('bl new --plugins-from rereads and compares its source under the creation lock', async (t) => {
  if (!lockOwnerVisible(t)) return;
  const rewrite = (dir, from, to) => {
    const p = join(dir, SOURCE);
    writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
  };
  const cases = [
    {
      // F-49 D4: the component default is taken from the source as read
      // under the lock, so the child follows the move and keeps the plugins.
      name: 'source moves to another component while waiting',
      mutate: (dir) => rewrite(dir, 'component: C01\n', 'component: C02\n'),
      status: 0,
      component: 'C02',
      copied: PLUGIN_KEYS,
    },
    {
      name: 'source plugin keys change while waiting',
      mutate: (dir) => rewrite(dir, 'plugins-test: [bl-tests]\n', 'plugins-test: [new-tests]\n'),
      status: 0,
      copied: 'plugins-test: [new-tests]\nplugins-lint: [-foo]\n',
    },
    {
      name: 'source is done while waiting',
      mutate: (dir) => rewrite(dir, 'status: draft\n', 'status: done\n'),
      status: 0,
      copied: PLUGIN_KEYS,
    },
    {
      name: 'source is deleted while waiting',
      mutate: (dir) => rmSync(join(dir, 'stories', 'S1-parent'), { recursive: true }),
      status: 1,
      copied: false,
      stderr: /--plugins-from S-1: story not found/,
    },
  ];
  for (const c of cases) {
    const { dir, cleanup } = pluginsBacklog();
    try {
      const r = await runBlBehindLock(dir, [...NEW_CHILD, '--plugins-from', 'S-1'], () => c.mutate(dir));
      const label = `${c.name}: ${r.stderr}`;
      assert.equal(r.status, c.status, label);
      if (c.stderr) assert.match(r.stderr, c.stderr, label);
      if (c.status !== 0) {
        assert.ok(!existsSync(join(dir, CHILD)), label);
      } else {
        const fmText = childFrontmatter(dir);
        assert.match(fmText, new RegExp(`^component: ${c.component ?? 'C01'}$`, 'm'), label);
        assert.ok(fmText.includes(c.copied), label);
        assert.doesNotMatch(fmText, /^primary_repo:/m, label);
      }
      assert.ok(!existsSync(join(dir, '.bl-new.lock')), `${c.name}: lock file left behind`);
    } finally {
      cleanup();
    }
  }
});

test('bl new --plugins-from rejects duplicate source IDs', () => {
  // Two story records with the same story_id: bl new names both and creates
  // nothing instead of copying whichever record the scan returns first.
  const { dir, cleanup } = pluginsBacklog();
  try {
    const text = readFileSync(join(dir, SOURCE), 'utf8');
    mkdirSync(join(dir, 'stories', 'S1-dup'), { recursive: true });
    writeFileSync(
      join(dir, 'stories', 'S1-dup', 'index.md'),
      text.replace('plugins-test: [bl-tests]', 'plugins-test: [dup-tests]'),
    );
    const r = runBl([...NEW_CHILD, '--plugins-from', 'S-1'], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--plugins-from S-1: ambiguous, 2 stories carry this id/);
    assert.ok(r.stderr.includes(SOURCE), r.stderr);
    assert.ok(r.stderr.includes('stories/S1-dup/index.md'), r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(join(dir, CHILD)));
    assert.ok(!existsSync(join(dir, '.bl-new.lock')), 'lock file left behind');
  } finally {
    cleanup();
  }
});
