You are reviewing your own branch for {{unitKind}} {{featureId}} — "{{title}}" before
the pull request exists. Read the whole diff as if it were someone else's, fix
what you find in place, and commit. No session block is written; the
independent reviewer starts where you end.

Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Branch       : {{branchName}} (diff: `git diff {{mainRef}}...HEAD`)
Unit file    : {{featureAbsPath}} ({{unitKind}})
Backlog repo : {{backlogDir}}

The stories on this branch:
{{storiesPlan}}

## What to check

1. **Acceptance.** Every acceptance item in the {{unitKind}} file and every
   story's acceptance criteria, against the code, not the checkboxes. Check off
   {{unitKind}}-level items the branch satisfies; leave the rest and note why.
2. **Sibling inputs.** For each function you changed, enumerate its input
   classes (empty, malformed, second shape, boundary, concurrent) and probe at
   least one that the tests do not already cover. Add the test when it fails.
3. **Failure paths.** Every error branch, rollback, and partial-write ordering
   you introduced: what state is left behind if the second write fails?
4. **Cross-file consistency.** Contracts, docs, and callers touched by the same
   change: does the README, the AGENTS reference, or a sibling module still
   describe the old behaviour?
5. **Placement.** Did this change alter what something is or who uses it — a
   domain-specific module made generic, a helper now shared across services?
   If so, does its code still live in a package of its new role? Read the
   repo's AGENTS.md package map, where it has one, and its tenets. Code left
   in a package of its old role is a finding even when the diff never touches
   the file: move it, or, when the move is too large for this branch, note the
   file and where it belongs in the {{unitKind}} file.
6. **Premise.** Does what you built still rest on {{premise}}? If
   not, write **## Escalation** in the {{unitKind}} file, as **Writing an
   escalation** below describes, instead of patching around it.

Fix in place with Conventional Commits messages ending in ` ({{featureId}})`,
run the tests that cover what you changed (see **Tests** below; the loop's
test gate runs the full suite after this session), and format changed files.
Commit an edit to the {{unitKind}} file (a checked item, a note, an
Escalation) with:

```
bl sync --commit -m "chore: self-review notes for {{featureId}}" --path {{featureRelPath}}
```

Never run `git add` or `git commit` in the backlog repo ({{backlogDir}}): its
index is shared, and a raw commit takes along what other sessions have staged.

{{blockedByBug}}

{{escalationGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT push or open a PR — `bl run` does that next.
- Do NOT run any `bl sync` other than the `bl sync --commit` line above.
- End your response with one line: `SELF-REVIEW DONE` (optionally followed by
  the number of fixes), or `ESCALATED` if you wrote an Escalation.
