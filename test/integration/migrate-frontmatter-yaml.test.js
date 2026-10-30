import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadConfig, parseFrontmatter, serializeFrontmatter } from '../../src/config.js';
import { migrate } from '../../src/migrate-frontmatter-yaml.js';
import { mkTempDir } from '../helpers/tempdir.js';
import { addOrigin, git, statusLines } from '../helpers/git-backlog.js';
import { runBl } from '../helpers/run-bl.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate-frontmatter-yaml.js', import.meta.url));

const body = (id, title) => `
# ${id} · ${title}

## Summary

Why.

## Acceptance Criteria

- [ ] It works.
`;

// Each block is written as the retired line writer wrote it, not through
// serializeFrontmatter.
const story = (id, title, extra = '') => `---
component: C32
story_id: ${id}
title: ${title}
type: chore
points: 1
status: backlog
added: 2026-10-01
feature: F-1
${extra}---
${body(id, title)}`;

const VALID = `${serializeFrontmatter({
  component: 'C32',
  story_id: 'S-4',
  title: 'Already: valid',
  type: 'chore',
  points: '1',
  status: 'backlog',
  added: '2026-10-01',
  feature: 'F-1',
  depends_on: ['S-1'],
})}${body('S-4', 'Already: valid')}`;

/**
 * A backlog in git as the line reader left it: a story whose title holds
 * `: ` (not YAML) with a comma `depends_on`, one whose title holds ` #` (YAML
 * reads a comment) with a bare-id `required_for`, one with a `plugins-test`
 * string, one already valid, a feature with a flow `stories:` list, and its
 * change document with a ` #` in a `repos:` entry.
 */
function oldBacklog() {
  const dir = mkTempDir('bl-migrate-fm-yaml-');
  const files = {
    '.gitignore': '.workon.lock\n.bl/\n',
    'backlog.json': `${JSON.stringify({ agent: [{ agent: 'claude' }], review_agent: [{ agent: 'claude' }], worktrees: '../worktrees', repos: { bl: { path: '../bl', deployable: false, update_tests: [] } } }, null, 2)}\n`,
    'index.md': '# Backlog\n',
    'components/C32-bl/index.md': `---
component_id: C32
title: bl
repo: bl
home: true
paths: ["**"]
---

# C32 · bl
`,
    'stories/S1-one/index.md': story('S-1', 'Migrate: the frontmatter', 'depends_on: S-2, S-3\nrequired_for:\n'),
    'stories/S2-two/index.md': story('S-2', 'Smoke (AC #4) once S-1 lands', 'required_for: S-1\n'),
    'stories/S3-three/index.md': story('S-3', 'Three', 'plugins-test: bl-tests\nrequired_for: [S-1]\n'),
    'stories/S4-four/index.md': VALID,
    'features/F1-feat/index.md': `---
feature_id: F-1
title: Feat
status: running
stories: [S-1, S-2, S-3, S-4]
points: 4
added: 2026-10-01
components: [C32]
---

# F-1 · Feat

## Premise

Why.

## Escalation

None.
`,
    'features/F1-feat/change.md': `---
change_of: F-1
status: open
review_round: 0
review_status:
repos:
  - repo: bl
    branch: f1-feat #2
    pr: 12
    url: https://example.com/pull/12
    merged:
---

# F-1 · Feat

## Description

## Gate

## Review Log

## Merge
`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  addOrigin(dir);
  return dir;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const fm = (dir, rel) => parseFrontmatter(read(dir, rel)).fm;
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const script = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--backlog', dir, ...args], { encoding: 'utf8' });
const COUNTS =
  'blocks rewritten: 4; titles quoted: 2; list strings turned into sequences: 3; ' +
  'blocks read by the legacy reader: 3; list keys left for a hand fix: 0';

test('--dry-run prints each file it would rewrite and the per-kind counts, and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const r = script(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^would rewrite stories\/S1-one\/index\.md \(legacy reader; title quoted; depends_on made sequences\)$/m,
  );
  assert.match(
    r.stdout,
    /^would rewrite stories\/S2-two\/index\.md \(legacy reader; title quoted; required_for made sequences\)$/m,
  );
  assert.match(r.stdout, /^would rewrite stories\/S3-three\/index\.md \(plugins-test made sequences\)$/m);
  assert.match(r.stdout, /^would rewrite features\/F1-feat\/change\.md \(legacy reader\)$/m);
  assert.doesNotMatch(r.stdout, /S4-four|F1-feat\/index|C32-bl/);
  assert.match(r.stdout, new RegExp(`^${COUNTS}$`, 'm'));
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a run rewrites every block as YAML in one commit, keeps the meaning, and a second run plans nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  const valid = read(dir, 'stories/S4-four/index.md');
  const r = script(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^committed \d+ backlog path\(s\) in \w+ chore: F-62 frontmatter-yaml migration: 4 blocks rewritten/m,
  );
  assert.equal(git(dir, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(statusLines(dir), []);

  const s1 = fm(dir, 'stories/S1-one/index.md');
  assert.equal(s1.title, 'Migrate: the frontmatter');
  assert.deepEqual(s1.depends_on, ['S-2', 'S-3']);
  assert.equal(s1.required_for, '');
  assert.equal(fm(dir, 'stories/S2-two/index.md').title, 'Smoke (AC #4) once S-1 lands');
  assert.deepEqual(fm(dir, 'stories/S2-two/index.md').required_for, ['S-1']);
  assert.deepEqual(fm(dir, 'stories/S3-three/index.md')['plugins-test'], ['bl-tests']);
  assert.deepEqual(fm(dir, 'features/F1-feat/change.md').repos, [
    { repo: 'bl', branch: 'f1-feat #2', pr: '12', url: 'https://example.com/pull/12', merged: '' },
  ]);
  assert.equal(read(dir, 'stories/S4-four/index.md'), valid);
  assert.match(read(dir, 'stories/S1-one/index.md'), /\n## Summary\n\nWhy\.\n/);
  assert.match(read(dir, 'MIGRATION.md'), /^## F-62 frontmatter-yaml migration \(\d{4}-\d\d-\d\d\)$/m);

  const v = runBl(['validate'], { cwd: dir });
  assert.doesNotMatch(v.stdout + v.stderr, /frontmatter-(yaml|list)/);

  const after = head(dir);
  const again = script(dir, '--dry-run');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^blocks rewritten: 0; /m);
  assert.doesNotMatch(again.stdout, /would rewrite/);
  const rerun = script(dir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(head(dir), after);
});

test('it refuses a dirty backlog and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  writeFileSync(join(dir, 'stray.txt'), 'untracked\n');
  const r = script(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /migration refused: the backlog's work tree is not clean \(\?\? stray\.txt\)/);
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), ['?? stray.txt']);
});

test('it refuses a backlog whose HEAD is not origin/main and writes nothing', () => {
  const dir = oldBacklog();
  writeFileSync(join(dir, 'extra.md'), '# Extra\n');
  git(dir, 'add', 'extra.md');
  git(dir, 'commit', '-q', '-m', 'unpushed');
  const before = head(dir);
  const r = script(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /migration refused: the backlog's HEAD \(\w+\) is not origin\/main/);
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
  assert.match(read(dir, 'stories/S1-one/index.md'), /^title: Migrate: the frontmatter$/m);
});

test('it refuses while a bl run is active and writes nothing', () => {
  const dir = oldBacklog();
  const before = head(dir);
  mkdirSync(join(dir, '.bl', 'run'), { recursive: true });
  writeFileSync(join(dir, '.bl', 'run', 'F-1.json'), JSON.stringify({ status: 'running' }));
  writeFileSync(join(dir, '.bl', 'run', 'F-1.lock'), `${process.pid}\n`);
  const r = script(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /migration refused: a bl run is active \(\.bl\/run\/F-1\.json, pid \d+\)/);
  assert.equal(head(dir), before);
  assert.deepEqual(statusLines(dir), []);
});

test('a commit that fails leaves the backlog as it was: no rewritten block, no MIGRATION.md', async () => {
  const dir = oldBacklog();
  const before = head(dir);
  const s1 = read(dir, 'stories/S1-one/index.md');
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
  assert.equal(read(dir, 'stories/S1-one/index.md'), s1);
});
