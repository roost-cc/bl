/**
 * Integration tests for `scripts/migrate-priority.js` (F-78 D5): the old
 * feature-order.md becomes priority.md in one commit, the open ranked
 * features kept in order as `{ unit, why }`, the generated tables dropped,
 * the hand-written intro and History kept; `--dry-run` writes nothing and a
 * second run changes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, parseFrontmatter } from '../../src/config.js';
import { loadBacklog } from '../../src/backlog-graph.js';
import { keptIntro, migrate } from '../../src/migrate-priority.js';
import { mkTempBacklog } from '../helpers/tempdir.js';
import { addOrigin, git, initGitBacklog, statusLines } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';
import { spawnSyncFiles } from '../../src/child-stdio.js';
import { HEADLESS_ENV } from '../../src/agents/provider.js';

// The migration commits priority.md, which an agent's `BL_HEADLESS` refuses
// (F-78 D3): this file's process, and the script it spawns, run as a person.
delete process.env[HEADLESS_ENV];

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-priority.js', import.meta.url));
const OLD = 'feature-order.md';

/** The old file as bl wrote it before F-78: ranked, an intro, the generated tables, History. */
const ORDER = `---
ranked:
  - feature: F-3
    why: First, after the graph.
  - feature: F-2
    why: Already done.
  - feature: F-9
    why: Never existed.
  - feature: F-1
    why: "Then the accounts work. Operator, 2026-11-05: after F-3."
  - feature: F-3
    why: A repeat.
---

# Feature Order

The order the operator prefers features to run in (F-53 D1). The order is the
\`ranked:\` list in this file's frontmatter.

\`bl sync\` writes **Next up** and **Not yet ranked**, so edit neither by hand.

_Last agreed: 2026-10-06._

The \`bl\` work first (operator, 2026-10-23).

## Next up

| # | Feature | Why |
| --- | --- | --- |
| 1 | [F-3](features/F3-three/index.md) | First. |

## Not yet ranked

| Feature |
| --- |
| [F-4](features/F4-four/index.md) |

## History

- 2026-09-27: F-21 → F-22 done.
- 2026-10-05: F-11 done.
`;

const DATE = '2026-11-07';

function oldBacklog() {
  const { dir } = mkTempBacklog({
    features: [
      { id: 'F-1', title: 'One', dirSuffix: 'one', status: 'refined' },
      { id: 'F-2', title: 'Two', dirSuffix: 'two', status: 'done' },
      { id: 'F-3', title: 'Three', dirSuffix: 'three', status: 'approved' },
      { id: 'F-4', title: 'Four', dirSuffix: 'four', status: 'draft' },
    ],
    priority: null,
  });
  writeFileSync(join(dir, OLD), ORDER);
  initGitBacklog(dir);
  addOrigin(dir);
  return dir;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const script = (dir, ...args) =>
  spawnSyncFiles(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });

test('keptIntro keeps the hand-written paragraphs and drops the title and the old mechanism', () => {
  const { body } = parseFrontmatter(ORDER);
  assert.deepEqual(keptIntro(body), ['_Last agreed: 2026-10-06._', 'The `bl` work first (operator, 2026-10-23).']);
});

test('--dry-run prints the entries kept and dropped, and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const r = script(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      'would keep F-3',
      'would keep F-1',
      'would drop F-2 (done)',
      'would drop F-9 (no such feature)',
      'would drop F-3 (ranked twice)',
      `would move ${OLD} to priority.md`,
      '',
    ].join('\n'),
  );
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(read(dir, OLD), ORDER);
  assert.ok(!existsSync(join(dir, 'priority.md')));
});

test('a run writes priority.md and removes the old file in one commit, and a second run changes nothing', async () => {
  const dir = oldBacklog();
  const before = head(dir);
  // Before: bl reads no priority.md, and every open unit is in the dated tail.
  const codes = (d) => JSON.parse(runBl(['validate', '--json'], { cwd: d }).stdout).findings.map((f) => f.code);
  assert.ok(codes(dir).includes('priority-file'));

  const r = await migrate(loadConfig({ backlogRoot: dir }), { log: () => {}, date: DATE });
  assert.equal(r.commit?.committed, true, JSON.stringify(r.commit));
  assert.equal(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(statusLines(dir), []);
  const changed = git(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort();
  assert.ok(
    changed.some((l) => /^R\d+\tfeature-order\.md\tpriority\.md$/.test(l)) ||
      (changed.includes(`D\t${OLD}`) && changed.includes('A\tpriority.md')),
    changed.join('\n'),
  );
  assert.ok(!existsSync(join(dir, OLD)));

  const text = read(dir, 'priority.md');
  const { fm, body } = parseFrontmatter(text);
  assert.deepEqual(fm, {
    ranked: [
      { unit: 'F-3', why: 'First, after the graph.' },
      { unit: 'F-1', why: 'Then the accounts work. Operator, 2026-11-05: after F-3.' },
    ],
  });
  // The template's intro, then the old hand-written paragraphs, then History.
  const template = parseFrontmatter(
    readFileSync(fileURLToPath(new URL('../../templates/priority.md', import.meta.url)), 'utf8'),
  ).body.trim();
  assert.ok(body.trim().startsWith(template), body);
  assert.match(body, /\n_Last agreed: 2026-10-06\._\n\nThe `bl` work first \(operator, 2026-10-23\)\.\n\n## History\n/);
  assert.ok(
    body.endsWith(
      `## History\n\n- 2026-09-27: F-21 → F-22 done.\n- 2026-10-05: F-11 done.\n- ${DATE}: ${OLD} became priority.md (F-78): one list of features and loose stories, ranked with \`bl rank\`; the open ranked features kept their order.\n`,
    ),
    body,
  );
  assert.doesNotMatch(body, /Next up|Not yet ranked|`bl sync`|# Feature Order/);

  // After: bl reads it, with no finding, and follows it.
  assert.deepEqual(
    codes(dir).filter((c) => c.startsWith('priority')),
    [],
  );
  const g = loadBacklog(loadConfig({ backlogRoot: dir }), { reload: true });
  assert.deepEqual(
    g.priority.map((u) => u.id),
    ['F-3', 'F-1', 'F-4'],
  );

  const after = head(dir);
  const again = script(dir, '--dry-run');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, `no ${OLD}: nothing to migrate\n`);
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(head(dir), after);
  assert.equal(read(dir, 'priority.md'), text);
  assert.deepEqual(statusLines(dir), []);
});

test('the script commits through the same path, with the counts in the message', () => {
  const dir = oldBacklog();
  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^committed \d+ backlog path\(s\) in \w+ chore: F-78 priority migration: feature-order\.md becomes priority\.md \(2 kept, 3 dropped\)$/m,
  );
});

test('it refuses a backlog that already has priority.md, and writes nothing', () => {
  const dir = oldBacklog();
  writeFileSync(join(dir, 'priority.md'), '---\nranked: []\n---\n');
  git(dir, 'add', 'priority.md');
  git(dir, 'commit', '-q', '-m', 'both');
  git(dir, 'push', '-q', 'origin', 'main');
  const before = head(dir);
  const r = script(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /priority\.md already exists beside feature-order\.md/);
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a commit that fails leaves the backlog as it was', async () => {
  const dir = oldBacklog();
  const before = head(dir);
  await assert.rejects(
    migrate(loadConfig({ backlogRoot: dir }), {
      log: () => {},
      commit: async () => {
        throw new Error('push rejected');
      },
    }),
    /^Error: migration failed: push rejected; backlog restored; fix the cause and rerun$/,
  );
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
  assert.equal(read(dir, OLD), ORDER);
  assert.ok(!existsSync(join(dir, 'priority.md')));
});
