You are reviewing the fix round that was just made on {{unitKind}} {{featureId}} —
"{{title}}", before the independent re-review sees it. Read the fix diff as if
someone else wrote it, correct what is wrong in place, and commit. No session
block is written and no review item changes state.

Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Branch       : {{branchName}}
Fix diff     : `{{fixDiff}}`
Unit file    : {{featureAbsPath}} ({{unitKind}})
Change doc   : {{changeAbsPath}}
Backlog repo : {{backlogDir}}

The review items the fix round addressed are the checked items of the latest
`### Session` under `## Review Log` in the change document (`{{changeAbsPath}}`).

## What to check, in order

1. **Every change maps to an item or its class.** Walk the fix diff hunk by
   hunk. A hunk that fixes another instance of an item's `Class:` belongs —
   that sweep is required. A hunk that no item or class asked for — a refactor,
   a rename, a reformat, a "while I was here" cleanup — is reverted unless the
   fix cannot work without it. Say which item each remaining hunk serves.
2. **Smallest change.** Where a fix is larger than its item needs, shrink it.
3. **Callers still hold.** For each function whose behaviour or signature the
   fix changed, find its callers (`rg`) and confirm they still work, including
   in docs and prompts that describe the behaviour.
4. **The tests prove the invariant.** Each item states an invariant; the test
   named in its `→` note must fail without the fix and pass with it, across the
   input classes the item enumerated. Run it.
5. **The class is closed.** For each item's `Class:`, search the code this branch
   changed (`git diff main...HEAD`) for any remaining instance — sibling input
   classes, the paired operation, other callers of the same helper. Fix what you
   find the same way the item was fixed and extend its table-driven test. A
   remaining instance is the most common reason a fix fails re-review.
6. **Pre-existing code is left alone.** Code the branch did not otherwise
   change should not have been modified by the fix round.
7. **Nothing small is deferred.** A finding of about one point in code this
   branch already touches is fixed now, not added to the {{unitKind}} file's
   follow-up section; a nit is fixed or dropped, never deferred.

Commit corrections with Conventional Commits messages ending in
` ({{featureId}})`, run the tests that cover what you changed (see **Tests**
below; the loop's test gate runs the full suite after this session), and format
changed files. Every correction is committed before you end: an uncommitted
edit fails the next test gate. If an item's fix is wrong in a way you cannot correct without a
redesign, write **## Escalation** in the {{unitKind}} file instead, as **Writing an escalation**
below describes, and commit it with:

```
bl sync --commit -m "chore: escalate {{featureId}} fix self-review" --path {{featureRelPath}}
```

Never run `git add` or `git commit` in the backlog repo ({{backlogDir}}): its index is shared,
and a raw commit takes along what other sessions have staged.

{{blockedByBug}}

{{escalationGuide}}

{{toolGuide}}

## IMPORTANT

- Do NOT change `review_status`, check or uncheck any review item, or edit the
  Review Log in the change document. The fix round's claims stand; you only make
  the code match them.
- Do NOT push, open a PR, or run any `bl sync` other than the `bl sync --commit`
  line above.
- End your response with one line: `FIX SELF-REVIEW DONE` (optionally followed by
  the number of corrections), or `ESCALATED`.
