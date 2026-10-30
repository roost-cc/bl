You are resuming {{unitKind}} {{featureId}} — "{{title}}" after a review.

Repos        : {{storyRepos}}
Unit dir     : {{unitDir}} (your working directory)
Lead worktree: {{worktreePath}} ({{targetRepo}})
Branch       : {{branchName}}
Unit file    : {{featureAbsPath}} ({{unitKind}})
Change doc   : {{changeAbsPath}}
Backlog repo : {{backlogDir}}

## Two-repo model

- The **{{unitKind}} file** and its **change document** live in the backlog repo. The
  review feedback is in the change document's `## Review Log` section, not in the worktree.
- **Code changes** go in each repo's worktree, `{{unitDir}}/<repo>`, and get committed to
  `{{branchName}}`.
- The repos above are the {{unitKind}}'s, in the order bl reviews and merges them. A fix
  a review item asks for in a repo no story names is a missing story, not a new worktree:
  write it under **## Escalation**, naming the repo, and stop.

## Steps

1. {{readTool}} the {{unitKind}} file and the change document. The review feedback
   is the **latest** session — the first `### Session` block under `## Review Log`
   in the change document. Earlier sessions are history; do not re-address checked
   items there.

2. Address each unchecked **Must fix** and **Should fix** item with the
   **smallest change that satisfies it**: one commit per item, Conventional
   Commits, subject ending in ` ({{featureId}})`. No refactoring, renaming,
   reformatting, or cleanup beyond what the item needs, and no edits to code
   the item does not concern unless the fix cannot work without them. Every
   line a fix round adds is code the next review must read — on F-2, fix rounds
   wrote more code than the feature itself and generated most of the later findings.
   If an item genuinely needs a larger change (a new abstraction, a redesign of
   a contract), do not make it: write **## Escalation** in the {{unitKind}} file, as
   **Writing an escalation** below describes (which item, what it would need,
   and why a fix round cannot do it), commit the backlog, and stop.

3. **Sweep the class, not just the instance.** Each item names a `Class:` and
   lists the instances the reviewer found; that list is where you start, not
   where you stop. Before fixing, search the code this branch changed
   (`git diff main...HEAD`) for every instance of that class: the function's
   other input classes, the paired operation (before/after, read/write,
   create/rollback, acquire/release), and the other callers of the same helper.
   Fix them together — usually one shared check or helper instead of several
   patches — with a table-driven test over every instance and input class.
   Instances in code the branch did not change go to **## {{deferredHeading}}** as
   `[points: N] (pre-existing, same class as <item>) …`, not into this fix,
   except an instance of about one point in code this branch already touches,
   which is fixed here, not deferred.
   "Smallest change" means no unrelated edits; it never means leaving a known
   instance of the same class behind. On F-3, fixing one instance per round cost
   three review rounds for one class.

4. Items are written as invariants, not instances. When an item states a
   property ("the read/write invariant holds for every field", "no partial
   write can leave X inconsistent"), add or extend a test that proves the
   invariant across the input classes the reviewer enumerated, not only the
   example they quoted. The re-review runs that test; a fix without one is
   sent back.

5. Do not touch **Nits** unless the item is tagged `[safe]`. Fixing cosmetic
   items in the same round as Must-fix items is where regressions come from.
   Leave untagged nits unchecked with a `→ dropped (nit)` note: a nit is fixed
   or dropped, never deferred.

6. As each item is resolved, edit the change document: flip `- [ ]` to `- [x]` and
   append `→ <resolution>` — the short SHA, `class <name>: fixed <every instance>`,
   and the test name that proves it.
   Keep the Must/Should/Nits grouping and prior sessions untouched.

7. Run the full test suite for this repo and format the changed files (see
   **Tests** and **Format and lint** below).

8. Set `review_status: fixed` in the change document's frontmatter. Never write
   `addressed`: that is the reviewer's sign-off. Commit the backlog once:

   ```
   bl sync --commit -m "chore: address review feedback ({{featureId}}, session <YYYY-MM-DD>)" --path {{changeRelPath}} --path {{featureRelPath}}
   ```

9. Push: `git push origin {{branchName}}`.

{{sessionStack}}

## Scratch files

Write diagnostics (probe scripts, redirected test output, scratch configs) under
`{{scratchDir}}`, never in the worktree. The test gate refuses a dirty worktree, and a
headless session cannot remove files.

{{blockedByBug}}

{{escalationGuide}}

{{toolGuide}}

## IMPORTANT

- NEVER `git add` files that are in `.gitignore`.
- Do NOT edit backlog index files or run any `bl sync` other than the
  `bl sync --commit` line in step 8.
- Commit the change document and the {{unitKind}} file only with that `bl sync --commit`
  line. It takes the backlog lock and commits only those files and the regenerated indexes; never run
  `git add` or `git commit` in the backlog repo ({{backlogDir}}), whose index other
  sessions share.
- Format the {{unitKind}} file and the change document with
  `bl format --no-story {{featureRelPath}} {{changeRelPath}}`.
- At the very end, output the PR URL as the final line of your response.
