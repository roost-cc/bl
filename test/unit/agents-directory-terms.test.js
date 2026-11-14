/**
 * The reference keeps two directories apart (F-86). "The work unit's
 * directory" is `<root>/<branch>`, which holds the work unit's worktrees. The
 * backlog directory that holds a work unit's `index.md` (and its change
 * document and `plan.yaml`) is named by that role. F-86 rewrote the reference
 * from its start to the end of `## Features`; that part may not mix the two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const AGENTS = readFileSync(new URL('../../src/AGENTS.md', import.meta.url), 'utf8');
const REWRITTEN = AGENTS.slice(0, AGENTS.indexOf('\n## Tooling\n'));
/** The rewritten part with each run of white space as one space, so a line wrap does not matter. */
const FLAT = REWRITTEN.replace(/\s+/g, ' ');

/** Each wording that calls a backlog directory of `index.md` files a work unit's directory, found in `FLAT`. */
const MISLABELS = ["work units' directories", 'directories of `units`', "merged story's directory"];

/** Each backlog directory of the rewritten part, by the wording that names it by its `index.md`. */
const BACKLOG_DIRECTORIES = [
  [
    'feature `bl merge` commit scope',
    "the owner is `merge F-n`. The scope is the directories of its work units' `index.md` files",
  ],
  ["`bl batch`'s cross-story commit scope", "the scope is the directories of its work units' `index.md` files."],
  ["story `bl merge`'s triage commit scope", "the scope is the directory of the merged story's `index.md`."],
  ['`bl refine` commit scope', "`bl refine`: the scope is the directories of its work units' `index.md` files."],
  ['`refineAndCommit` commit', 'holds only the directories of the `index.md` files of `units`'],
  ['`plan.yaml` location', "beside the change document in the directory of the work unit's `index.md`"],
];

test('agents_work_unit_and_backlog_directories_are_distinct: the work unit directory is <root>/<branch>', () => {
  assert.match(FLAT, /A work unit's directory is `<root>\/<branch>`/);
});

test('agents_work_unit_and_backlog_directories_are_distinct: no backlog directory is a work unit directory', () => {
  assert.deepEqual(
    MISLABELS.filter((wording) => FLAT.includes(wording)),
    [],
  );
});

for (const [place, wording] of BACKLOG_DIRECTORIES) {
  test(`agents_work_unit_and_backlog_directories_are_distinct: ${place} names the index.md directory`, () => {
    assert.ok(FLAT.includes(wording), `src/AGENTS.md does not say: ${wording}`);
  });
}
