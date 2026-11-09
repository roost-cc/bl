You are reviewing your own branch for {{unitKind}} {{featureId}} — "{{title}}" before the pull
request exists. Read the whole diff as if it were someone else's, fix what you find in place,
and commit. You write no session block; the independent reviewer starts where you end.

Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Branch       : {{branchName}} (diff: `git diff {{mainRef}}...HEAD`)
Unit file    : {{featureAbsPath}} ({{unitKind}})
Backlog repo : {{backlogDir}}

The stories on this branch:
{{storiesPlan}}

## What to check

1. **Acceptance.** Check every acceptance item in the {{unitKind}} file and every story's
   acceptance criteria against the code, not the checkboxes. Check off the {{unitKind}}-level
   items that the branch satisfies; leave the rest and note why.
2. **Sibling inputs.** For each function you changed, list its input classes (empty, malformed,
   second shape, boundary, concurrent). Probe at least one that the tests do not already cover.
   If it fails, add the test.
3. **Failure paths.** Look at every error branch, rollback and partial-write order you
   introduced. What state is left behind if the second write fails?
4. **Cross-file consistency.** Look at the contracts, docs and callers that the same change
   touched. Does the README, the AGENTS reference or a sibling module still describe the old
   behaviour?
5. **Placement.** Did this change alter what something is or who uses it? Examples: a
   domain-specific module made generic, or a helper now shared across services. If so, does its
   code still live in a package of its new role?
   Read the repo's AGENTS.md package map, where it has one, and its tenets. Code left in a
   package of its old role is a finding, even when the diff never touches the file. Move it. If
   the move is too large for this branch, note the file and where it belongs in the {{unitKind}}
   file.
6. **Premise.** Does what you built still rest on {{premise}}? If not, write **## Escalation**
   in the {{unitKind}} file, as **Writing an escalation** below describes, instead of patching
   around it.
7. **Sources of truth.** For every new literal, constant or map in the diff, search the repo,
   outside the diff too, for what already defines it. Read the plan's `### Sources of truth`
   part where it has one. A restatement is a finding, with `Class: restated source of truth` and
   a `Repro:` that shows the definition. Derive from the definition instead.
8. **Simplicity.** Look for code the criteria do not need: an unused option, a one-use
   abstraction, handling for a case that cannot happen, or a changed line that traces to neither
   a story nor a finding. Remove it. Look also for behaviour that now exists twice, and share it
   (see **Simple, surgical changes** below).

Fix in place, with Conventional Commits messages ending in ` ({{featureId}})`. Run the tests
that cover what you changed (see **Tests** below); the test gate runs the full suite after this
session. Format the changed files. Commit an edit to the {{unitKind}} file (a checked item, a
note, an Escalation) with:

```
bl sync --commit -m "chore: self-review notes for {{featureId}}" --path {{featureRelPath}}
```

Never run `git add` or `git commit` in the backlog repo ({{backlogDir}}). Its index is shared,
and a raw commit takes along what other sessions have staged.

## Outcome

{{outcomeDelivery}}

{{selfReviewOutcome}}

{{selfConsistencyGuide}}

{{simplicityGuide}}

{{blockedByBug}}

{{escalationGuide}}

{{writingGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT push or open a PR: `bl run` does that next.
- Do NOT run any `bl sync` other than the `bl sync --commit` line above.
- End with the outcome object that **Outcome** above describes.
